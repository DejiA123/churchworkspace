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
{
  // "Keep their exact words": a fix is a sound-alike swap — however the two are SPELLED
  // (review: the first-letter gate refused hole/whole, our/hour, ate/eight, sent/cent)
  const ok = (a, b) => v(a, b, { mode: 'exact' }).ok;
  for (const [a, b] of [['THE WHOLE IN', 'the hole in'], ['AN OUR LATER', 'an hour later'], ['ATE OF THEM', 'eight of them'],
    ['NOT A SENT', 'not a cent'], ['THE AIR OF', 'the heir of'], ['DOWN THE ISLE', 'down the aisle'], ['THE KNIGHT WAS', 'the night was']]) {
    check(`exact mode accepts the homophone "${a}" -> "${b}"`, ok(a, b));
  }
  for (const [a, b] of [['MIGHT NOR BY', 'might nor power'], ['LIE THOUGH IT', 'lie'], ['CHAPTER 4 VERSE', 'Philippines chapter 4 verse'],
    ['BECOME NEW ZACCHAEUS', 'become new'], ['HIS ROD', 'his staff'], ['ON THE ROCK', 'on the house']]) {
    check(`exact mode refuses "${a}" -> "${b}" (a word dropped, added or swapped for one that sounds nothing like it)`, !ok(a, b));
  }
}

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

  /*
   * THE LAST SENTENCE, DROPPED — and heard again. Measured live: Groq returned
   * a 117 s sermon without its final nine words, every time. Here the fake
   * provider does the same (stops at 20 s of a 30 s clip that is loud all the
   * way through), and the stretch after the last word must be asked about on
   * its own and its words put back — once, in order, on the file's clock.
   */
  const loudWav = path.join(os.tmpdir(), 'mw-cloudgap-' + process.pid + '.wav');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=r=16000:a=0.2:c=pink', '-t', '30', '-y', loudWav]);
  let cutAt = Infinity, onlyFiller = false;
  const sayWords = (ha, hb) => {
    const words = [];
    for (let k = Math.ceil(ha / 0.5); k * 0.5 + 0.3 <= hb && k * 0.5 < cutAt; k++) words.push({ word: 'w' + k, start: +(k * 0.5 - ha).toFixed(3), end: +(k * 0.5 + 0.3 - ha).toFixed(3) });
    return words;
  };
  global.fetch = async (url, init) => {
    calls.push({ gran: init.body.getAll('timestamp_granularities[]') });
    const [ha, hb] = plan[served++] || [0, 0];
    if (served === 1) return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words: sayWords(ha, hb), segments: [] }) };
    // the second chance: the dropped words, or (over music) nothing but a filler
    cutAt = Infinity;
    const words = onlyFiller ? [{ word: 'Thank', start: 1.5, end: 1.8 }, { word: 'you.', start: 1.8, end: 2.1 }] : sayWords(ha, hb);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words, segments: [] }) };
  };
  calls.length = 0; served = 0; cutAt = 20; plan = [[0, 30], [18.8, 30]];
  const gap = await cs.transcribeWords({ input: loudWav, startSec: 0, endSec: 30 });
  const gt = gap.words.map((w) => w.text);
  const want = []; for (let k = 0; k * 0.5 + 0.3 <= 30; k++) want.push('w' + k);
  check('a dropped ending is asked about again, on its own (one extra request)', calls.length === 2, calls.length);
  check('…and its words are put back: all of them, once, in order', gt.length === want.length && gt.every((t, i) => t === want[i]),
    `${gt.length} of ${want.length}: …${gt.slice(-4).join(' ')}`);
  check('…on the file\'s clock', gap.words.every((w) => Math.abs(w.start - (+w.text.slice(1)) * 0.5) < 0.002), JSON.stringify(gap.words.slice(-2)));
  check('…and the answer says how many were recovered', gap.reheard === want.length - 40, gap.reheard);
  // The same, but the second chance only "hears" Whisper's stock filler: nothing is added.
  calls.length = 0; served = 0; cutAt = 20; onlyFiller = true; plan = [[0, 30], [18.8, 30]];
  const filler = await cs.transcribeWords({ input: loudWav, startSec: 0, endSec: 30 });
  onlyFiller = false;
  check('a second chance that only hears "Thank you." adds nothing', filler.words.length === 40 && filler.reheard === 0,
    `${filler.words.length} words, +${filler.reheard}`);
  /*
   * …and not what Whisper invents over a SONG. Measured live on the operator's
   * birthday clip: the second chance at 15 s of music "heard" a line of "no, no,
   * no…" and it went onto the captions. Real word timings from that answer and
   * from the sentence the second chance exists to recover.
   */
  {
    const m = (a) => a.map(([text, start, end]) => ({ text, start, end }));
    const TAIL = m([['The', 113.74, 114.1], ['Lord', 114.1, 114.28], ['is', 114.28, 114.5], ['my', 114.5, 114.64], ['shepherd,', 114.64, 115.22],
      ['I', 115.22, 115.32], ['shall', 115.32, 115.46], ['not', 115.46, 115.76], ['want.', 115.76, 116.16]]);
    const SONG = m([["You're", 28.4, 30.28], ['No,', 30.12, 30.12], ['please,', 30.12, 31.1], ['no,', 31.1, 31.44], ['no,', 31.44, 32.84], ['no,', 32.84, 33.72],
      ['no,', 33.72, 34.26], ['no,', 34.26, 39.6], ['no,', 39.6, 42.78], ['no,', 42.78, 43.04], ['no,', 43.04, 43.9], ['no', 43.9, 43.92]]);
    check('second chance: the recovered last sentence reads as speech', cs.looksSpoken(TAIL) === true);
    check('second chance: "no, no, no…" over a song does not', cs.looksSpoken(SONG) === false);
    check('second chance: a sung phrase held for seconds does not either',
      cs.looksSpoken(m([['Happy', 1, 3.5], ['birthday', 3.5, 6.2], ['to', 6.2, 7.9], ['you', 7.9, 11]])) === false);
    check('second chance: a short real phrase does', cs.looksSpoken(m([['Amen.', 3, 3.4]])) === true);
  }
  calls.length = 0; served = 0; cutAt = 20; plan = [[0, 30], [18.8, 30], [15.8, 30]];
  {
    // the provider "hears" a repeating word in the gap, both tries: nothing is added
    const real = global.fetch;
    global.fetch = async (url, init) => {
      if (served === 0) return real(url, init);
      calls.push({}); served++;
      const words = []; for (let k = 0; k < 9; k++) words.push({ word: 'no,', start: 1.5 + k * 1.1, end: 2.4 + k * 1.1 });
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words, segments: [] }) };
    };
    const song = await cs.transcribeWords({ input: loudWav, startSec: 0, endSec: 30 });
    global.fetch = real;
    check('a second chance that "hears" one word over and over adds nothing', song.words.length === 40 && song.reheard === 0,
      `${song.words.length} words, +${song.reheard}`);
  }
  /*
   * The second listen is a chance to do better, never a wait (review): a key
   * that is out of allowance answers 429 — the first one ends the second
   * listen at once, with no waiting it out and no further tries.
   */
  {
    const real = global.fetch;
    let n = 0;
    global.fetch = async (url, init) => {
      n++;
      if (n === 1) { const words = []; for (let k = 0; k * 0.5 < 20; k++) words.push({ word: 'w' + k, start: k * 0.5, end: k * 0.5 + 0.3 }); return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words, segments: [] }) }; }
      return { ok: false, status: 429, headers: { get: (k) => (k === 'retry-after' ? '1' : null) }, json: async () => ({}) };
    };
    const t0 = Date.now();
    const lim = await cs.transcribeWords({ input: loudWav, startSec: 0, endSec: 30 });
    global.fetch = real;
    check('a rate-limited second listen stops at once: one extra request, no waiting', n === 2 && Date.now() - t0 < 5000 && lim.words.length === 40,
      `${n} requests, ${Date.now() - t0} ms, ${lim.words.length} words`);
  }
  /*
   * A gap longer than one window: the request never reaches the word after the
   * gap, so a re-heard word that merely shares its text ("the") is real and kept.
   */
  {
    const longWav = path.join(os.tmpdir(), 'mw-cloudgap60-' + process.pid + '.wav');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=r=16000:a=0.2:c=pink', '-t', '60', '-y', longWav]);
    const real = global.fetch;
    let n = 0;
    global.fetch = async () => {
      n++;
      const words = [];
      if (n === 1) {
        for (let k = 0; k * 0.5 + 0.3 <= 5.3; k++) words.push({ word: 'a' + k, start: k * 0.5, end: k * 0.5 + 0.3 });
        words.push({ word: 'the', start: 40, end: 40.3 });
        for (let k = 1; 40 + k * 0.5 + 0.3 <= 60; k++) words.push({ word: 'b' + k, start: 40 + k * 0.5, end: 40 + k * 0.5 + 0.3 });
      } else {
        // the second listen hears [4.3, 34.3]: speech all the way, its last word "the" at 34.0
        for (let t = 5.5; t < 33.9; t += 0.5) words.push({ word: 'c' + Math.round(t * 2), start: t - 4.3, end: t - 4.3 + 0.3 });
        words.push({ word: 'the', start: 34.0 - 4.3, end: 34.25 - 4.3 });
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ words, segments: [] }) };
    };
    const lg = await cs.transcribeWords({ input: longWav, startSec: 0, endSec: 60 });
    global.fetch = real;
    try { fs.unlinkSync(longWav); } catch (e) {}
    const the34 = lg.words.find((w) => w.text === 'the' && Math.abs(w.start - 34.0) < 0.05);
    check('a long gap: a re-heard word that only shares its text with the word after the gap is kept', !!the34,
      lg.words.filter((w) => w.start > 33 && w.start < 41).map((w) => `${w.text}@${w.start}`).join(' '));
  }
  // Words to the end: no second chance is asked for.
  calls.length = 0; served = 0; cutAt = Infinity; plan = [[0, 30]];
  await cs.transcribeWords({ input: loudWav, startSec: 0, endSec: 30 });
  check('a clip heard to its last word costs exactly one request', calls.length === 1, calls.length);
  // The finder itself: a pause at the room's level is not a gap; speech-loud stretches are, the ending first.
  {
    const ws = [{ text: 'a', start: 0, end: 4 }, { text: 'b', start: 8, end: 12 }, { text: 'c', start: 20, end: 24 }];
    const lv = new Array(30 * 4).fill(-20);                 // speech level everywhere…
    for (let i = 4 * 4; i < 8 * 4; i++) lv[i] = -60;        // …but 4–8 s is a quiet pause
    const g = cs.gapsToHear(ws, 30, lv);
    check('gaps: the ending first, then the longest loud gap; the quiet pause is left alone',
      g.length === 2 && g[0].tail && g[0].a === 24 && g[1].a === 12 && g[1].b === 20, JSON.stringify(g));
    check('gaps: none to hear when nothing was heard at all (music, silence)', cs.gapsToHear([], 30, lv).length === 0);
    const silent = new Array(30 * 4).fill(-90);
    check('gaps: a silent recording has no gap worth a request', cs.gapsToHear(ws, 30, silent).length === 0);
  }
  try { fs.unlinkSync(loudWav); } catch (e) {}

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
