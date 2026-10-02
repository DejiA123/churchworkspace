'use strict';
/*
 * 🎤 LISTEN — does it hear an instruction, and does it keep still otherwise?
 *
 * Two halves, and the second is the one that matters more.
 *
 *   1. THE ONES THAT MUST FIRE. Every way a preacher announces a passage or
 *      asks for the next verse, including what whisper actually writes when it
 *      mishears the book name.
 *
 *   2. THE ONES THAT MUST NOT. Forty minutes of sermon go through this parser
 *      and the screen must not twitch once. So there is a corpus of ordinary
 *      preaching here — "we'll come back to that later", "he was one of the
 *      twelve", "the next thing Paul says" — and every line of it has to come
 *      back null. A rule that catches one more phrasing is worthless if it also
 *      catches a sentence like these.
 *
 *   node test/voice-intent.test.js
 */
const { parseVoice, spokenNumbers } = require('../src/main/voiceref');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

/* Psalms 1 has 6 verses, John 3 has 36 — enough for the disambiguation tests. */
const VERSES = { '19:1': 6, '19:119': 176, '19:23': 6, '43:3': 36, '50:4': 23, '46:13': 13, '40:5': 48 };
const verseCount = (bookNr, ch) => {
  const k = `${bookNr}:${ch}`;
  if (VERSES[k] != null) return VERSES[k];
  return ch <= 50 ? 30 : null;         // a plausible stand-in for everything else
};

console.log('\n== 🎤 LISTEN: what the screen should do about what it just heard ==\n');

/* ------------------------------ numbers ------------------------------ */
console.log('[1] Spoken numbers become digits');
[
  ['chapter twenty three', 'chapter 23'],
  ['chapter three verse sixteen', 'chapter 3 verse 16'],
  ['one hundred and nineteen', '119'],
  ['one hundred nineteen', '119'],
  ['verse forty two', 'verse 42'],
  ['psalm twenty three verse one', 'psalm 23 verse 1'],
  ['three sixteen', '3 16'],
  ['the twelve disciples', 'the 12 disciples'],
].forEach(([say, want]) => check(`"${say}"`, spokenNumbers(say) === want, spokenNumbers(say)));

/* ------------------------- references that must fire ------------------------- */
console.log('\n[2] A passage announced out loud');
const refCases = [
  ['turn with me to John chapter three verse sixteen', 'John', 3, [16]],
  ['john three sixteen', 'John', 3, [16]],
  ['lets read John 3:16', 'John', 3, [16]],
  ['open your bibles to Philippians chapter four verse six', 'Philippians', 4, [6]],
  ['were in Philippians four six today', 'Philippians', 4, [6]],
  ['turn to the book of Romans chapter eight', 'Romans', 8, null],
  ['first Corinthians chapter thirteen verse four', '1 Corinthians', 13, [4]],
  ['second Timothy chapter one verse seven', '2 Timothy', 1, [7]],
  ['third john verse four', '3 John', 1, [4]],       // a one-chapter letter
  ['jude verse three', 'Jude', 1, [3]],
  ['psalm twenty three', 'Psalms', 23, null],
  ['psalm twenty three verse one', 'Psalms', 23, [1]],
  ['matthew chapter five verses three to five', 'Matthew', 5, [3, 4, 5]],
  ['ephesians two eight through nine', 'Ephesians', 2, [8, 9]],
  ['revelation chapter twenty one verse four', 'Revelation', 21, [4]],
  ['go to Isaiah forty verse thirty one', 'Isaiah', 40, [31]],
  ['the gospel of Luke chapter fifteen', 'Luke', 15, null],
];
refCases.forEach(([say, book, ch, verses]) => {
  const r = parseVoice(say, { verseCount });
  const ok = r && r.kind === 'ref' && r.book === book && r.chapter === ch &&
    JSON.stringify(r.verses) === JSON.stringify(verses);
  check(`"${say}"`, ok, r ? `${r.book} ${r.chapter}${r.verses ? ':' + r.verses.join(',') : ''}` : 'nothing');
});

console.log('\n[3] …even when whisper mishears the book');
[
  ['turn to Jon chapter three verse sixteen', 'John', 3, [16]],
  ['filipians four thirteen', 'Philippians', 4, [13]],
  ['first corinthian thirteen four', '1 Corinthians', 13, [4]],
  ['isiah forty verse thirty one', 'Isaiah', 40, [31]],
  ['mathew five three', 'Matthew', 5, [3]],
].forEach(([say, book, ch, verses]) => {
  const r = parseVoice(say, { verseCount });
  const ok = r && r.kind === 'ref' && r.book === book && r.chapter === ch &&
    JSON.stringify(r.verses) === JSON.stringify(verses);
  check(`"${say}"`, ok, r ? `${r.book} ${r.chapter}:${(r.verses || []).join(',')}` : 'nothing');
});

console.log('\n[4] "Psalm one nineteen" is Psalm 119, not Psalm 1 verse 19');
{
  const r = parseVoice('psalm one nineteen', { verseCount });
  check('the chapter that exists wins', r && r.chapter === 119 && !r.verses,
    r ? `Psalms ${r.chapter}${r.verses ? ':' + r.verses : ''}` : 'nothing');
  const j = parseVoice('john three sixteen', { verseCount });
  check('…and John 3:16 is still a verse', j && j.chapter === 3 && j.verses && j.verses[0] === 16,
    j ? `${j.book} ${j.chapter}:${(j.verses || []).join()}` : 'nothing');
}

/* ------------------------- moving about ------------------------- */
console.log('\n[5] Moving the passage that is already up');
const live = { bookNr: 43, chapter: 3, verse: 16 };
[
  ['next verse', 'next'],
  ['lets go to the next verse', 'next'],
  ['and the next verse says', 'next'],
  ['next slide', 'next'],
  ['move on one', 'next'],
  ['previous verse', 'prev'],
  ['go back one', 'prev'],
  ['go back to the previous verse', 'prev'],
  ['back one', 'prev'],
  ['the verse before that', 'prev'],
  ['clear the screen', 'clear'],
  ['take it down', 'clear'],
].forEach(([say, kind]) => {
  const r = parseVoice(say, { live, verseCount });
  check(`"${say}" -> ${kind}`, r && r.kind === kind, r ? r.kind : 'nothing');
});

console.log('\n[6] Jumping to a verse inside what is live');
[
  ['go to verse twelve', 12],
  ['look at verse five', 5],
  ['down to verse twenty one', 21],
  // ►► said on its own, which is how an operator actually asks. This was
  //    refused until now: reported from a real service, "verse five" appeared
  //    in the log and the screen did not move.
  ['verse five', 5],
  ['verse 5', 5],
  ['verse twelve please', 12],
  ['ok verse five', 5],
  // ►► …and through whisper's stutter, which is how it usually arrives
  ['verse 5 verse 5 verse', 5],
  ['verse five verse five', 5],
].forEach(([say, n]) => {
  const r = parseVoice(say, { live, verseCount });
  check(`"${say}" -> verse ${n}`, r && r.kind === 'verse' && r.verse === n, r ? `${r.kind} ${r.verse || ''}` : 'nothing');
});
check('…but not when nothing is on the screen yet',
  parseVoice('go to verse twelve', { verseCount }) === null,
  String(parseVoice('go to verse twelve', { verseCount })));
check('…and a bare one needs a passage up too',
  parseVoice('verse five', { verseCount }) === null,
  String(parseVoice('verse five', { verseCount })));

/*
 * [6b] WHAT AN OPERATOR ACTUALLY SAYS.
 *
 * "Carry on." "Go on." "Next one." "Go back." None of these can be told from
 * preaching by their words alone — each is also an ordinary thing to say from a
 * pulpit. Two things make them safe and both are tested here: they must be the
 * WHOLE utterance, and there must be a passage on the screen for them to mean.
 * The sermon corpus below carries the sentences that contain the same words.
 */
console.log('\n[6b] Plain English, said on its own, with a passage up');
[
  ['carry on', 'next'], ['go on', 'next'], ['next one', 'next'], ['moving on', 'next'],
  ['continue', 'next'], ['go ahead', 'next'], ['keep going', 'next'], ['ok carry on', 'next'],
  ['alright go on then', 'next'], ['move on please', 'next'],
  ['go back', 'prev'], ['previous one', 'prev'], ['the one before', 'prev'],
  ['ok go back', 'prev'],
].forEach(([say, kind]) => {
  const r = parseVoice(say, { live, verseCount });
  check(`"${say}" -> ${kind}`, r && r.kind === kind, r ? r.kind : 'nothing');
});
check('…and none of them mean anything with nothing on the screen',
  ['carry on', 'go on', 'next one', 'go back'].every((s) => parseVoice(s, { verseCount }) === null),
  ['carry on', 'go on', 'next one', 'go back'].map((s) => (parseVoice(s, { verseCount }) || {}).kind || '-').join(' '));

console.log('\n[6c] A whole chapter at a time');
[
  ['next chapter', 1], ['previous chapter', -1], ['go to the next chapter', 1],
  ['back to the previous chapter', -1], ['the chapter before', -1], ['the chapter before that', -1],
  ['the chapter after this', 1], ['back a chapter', -1], ['go on a chapter', 1],
  ['last chapter', -1],
].forEach(([say, d]) => {
  const r = parseVoice(say, { live, verseCount });
  check(`"${say}" -> chapter ${d > 0 ? '+1' : '-1'}`, r && r.kind === 'chapter' && r.delta === d,
    r ? `${r.kind} ${r.delta || ''}` : 'nothing');
});
check('…and not with an empty screen',
  parseVoice('next chapter', { verseCount }) === null,
  String(parseVoice('next chapter', { verseCount })));

/* =========================================================================
 * THE HALF THAT MATTERS: forty minutes of preaching, and the screen holds still
 * ========================================================================= */
console.log('\n[7] ORDINARY PREACHING — every one of these must do NOTHING');
const sermon = [
  /*
   * ►► THE SENTENCES THE PLAIN-ENGLISH COMMANDS ARE MADE OF ◄◄
   *
   * "Carry on", "go on", "go back", "next chapter" and "verse five" are now
   * commands when they are the whole utterance. Every one of them is also
   * ordinary preaching in the middle of a sentence, and these are those
   * sentences. This block is the price of that vocabulary and the only thing
   * that makes it safe to have.
   */
  'we must carry on in faith no matter what it costs',
  'go on somebody give him praise this morning',
  'come on church lift your hands',
  'come on somebody',
  'i want you to keep going even when it is hard',
  'let us go back to what paul said in the beginning',
  'i want you to go back to your seat quietly',
  'and we continue to pray for the nation this week',
  'move on from that hurt today it is not yours to carry',
  'the next chapter of your life is about to open',
  'the previous chapter of my life was a hard one',
  'in the previous chapter paul told us something important',
  'we will read the next chapter of the story together',
  'verse twelve says that god is faithful to forgive',
  'verse five is where the whole argument turns',
  'and so we go on to the next thing he teaches',
  'god is not finished he will carry on the work he began',
  'you cannot go back to who you were before',
  'good morning church and welcome to the house of god',
  'i want to talk this morning about the peace of god',
  'we will come back to that in a moment',
  'the next thing i want you to see is how paul responds',
  'he was one of the twelve who followed him',
  'that happened three or four times in his ministry',
  'next week we are starting a new series',
  'i was reading this the other day and it struck me',
  'there were about five thousand people on that hillside',
  'god is not finished with you yet',
  'the last time we met i said something similar',
  'jesus said i am the way the truth and the life',
  'somebody shout amen',
  'he is the same yesterday today and forever',
  'that is the previous point i was making',
  'so go back to what you know is true',
  'lets pray',
  'you can take your seats',
  'turn to the person next to you and say god is good',
  'and the next generation will rise up',
  'in the second half of his life everything changed',
  'the first thing we notice is his obedience',
  'twenty three years ago i walked into this building',
  'i have three points this morning',
  'anxiety is loud but prayer is louder',
  'paul is writing from a prison cell',
  'that word in the greek means something closer to endurance',
  'my mother used to say that all the time',
  'we sang about this earlier in the service',
  'the verse we just read is one of my favourites',
  'this is the last of the seven letters',
  'he moved on to the next town',
  'and then he went back to galilee',
  'one of you here today needs to hear this',
  'ill be back one day and you will see',
  'we moved on one step at a time',
  'he came back a changed man',
  'the last verse of that song says it best',
  'i want to go back to something i said earlier',
];
let noisy = 0;
sermon.forEach((line) => {
  const r = parseVoice(line, { live, verseCount });
  if (r) { noisy++; console.log(`  FAIL "${line}"  -> ${r.kind} ${r.ref || r.verse || ''}`); }
});
check(`${sermon.length} sentences of preaching moved nothing`, noisy === 0,
  noisy ? `${noisy} false trigger(s)` : 'the screen held still');

/*
 * "go back" and "the next one" USED to be in this list. They were refused
 * because a bare phrase is ordinary English — and they still are in the middle
 * of a sentence, which is what the preaching corpus above tests. As a WHOLE
 * utterance with a passage on the screen they are what an operator actually
 * says, and refusing them read from the desk as the studio ignoring you. What
 * is left here is the set with no object at all: those can never be an
 * instruction, however they arrive.
 */
console.log('\n[8] Bare words that must never be commands on their own');
['next', 'back', 'previous', 'verse', 'one', 'go', 'chapter'].forEach((w) => {
  const r = parseVoice(w, { live, verseCount });
  check(`"${w}"`, r === null, r ? r.kind : 'nothing');
});

console.log('\n[9] A book name with no numbers is not a cue to change the screen');
['i love the book of romans', 'as john says', 'in philippians paul writes'].forEach((s) => {
  const r = parseVoice(s, { live, verseCount });
  check(`"${s}"`, r === null, r ? `${r.kind} ${r.ref || ''}` : 'nothing');
});

console.log('\n[10] Ambiguous numbered books are refused rather than guessed');
[['corinthians thirteen four'], ['kings chapter two'], ['timothy one seven']].forEach(([s]) => {
  const r = parseVoice(s, { verseCount });
  check(`"${s}" is left alone`, r === null, r ? `${r.book} ${r.chapter}` : 'nothing');
});

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
