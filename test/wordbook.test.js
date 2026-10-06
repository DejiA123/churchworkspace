'use strict';
/*
 * THE WORD BOOK — "eliminate the need for me to keep making corrections,
 * and don't make anything slower."
 *
 * Three claims are made by this feature, and all three are checked here:
 *
 *   1. IT FIXES WHAT IT IS TOLD TO FIX. A correction typed once is applied to
 *      every other line, to the word timings underneath them, and to every
 *      transcription afterwards.
 *   2. IT DOES NOT FIX WHAT IT WAS NOT TOLD TO. This is the dangerous half: a
 *      layer that re-spells words by SOUND could quietly turn ordinary speech
 *      into somebody's name. So it is run over a body of ordinary sermon
 *      English — 1,400+ words of it — and it must not change a single one.
 *   3. IT COSTS NOTHING. A three-hour sermon's worth of words goes through it
 *      in milliseconds, measured, against the hour whisper took to produce them.
 *
 *   node test/wordbook.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../src/renderer/wordbook.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* ------------------------------------------------------------------ *
 * A church's own book: two names it types in, one correction it made.
 * ------------------------------------------------------------------ */
const BOOK = {
  enabled: true,
  soundAlike: true,
  fixes: [
    { from: 'a fee shins', to: 'Ephesians', on: true, id: 'f1' },
    { from: 'winners chapel', to: 'Winners Chapel', on: true, id: 'f2' },
  ],
  terms: [{ text: 'Adeboye' }, { text: 'Oyedepo' }, { text: 'Kumuyi' }, { text: 'Emmanuel' }],
};
const M = W.compile(BOOK);

/* ------------------------------------------------------------------ *
 * ORDINARY SERMON ENGLISH. Not one word of this may change. It is the
 * language the feature is deployed into: everyday speech, contractions,
 * numbers, and Bible words that are ALREADY spelled correctly.
 * ------------------------------------------------------------------ */
const CORPUS = [
  'GOOD MORNING CHURCH AND WELCOME TO THE HOUSE OF GOD THIS MORNING',
  'I WANT YOU TO TURN WITH ME TO THE BOOK OF ROMANS CHAPTER EIGHT',
  'THE BIBLE SAYS THERE IS THEREFORE NOW NO CONDEMNATION',
  'GRACE IS FREE BUT IT IS NOT CHEAP AND IT COST HEAVEN EVERYTHING',
  'THE PASTOR PREACHED ON RIGHTEOUSNESS AND ON REPENTANCE LAST SUNDAY',
  'WE GATHER IN THE SANCTUARY TO WORSHIP AND TO GIVE THANKS',
  'THE SUN CAME UP AND THE SON OF GOD WAS ALREADY AWAKE',
  'MY BROTHER MY SISTER THE LORD IS GOOD AND HIS MERCY ENDURES FOREVER',
  'THERE IS A BASIS OF GRACE BECAUSE WITHOUT GRACE WE CAN DO NOTHING',
  'PUT YOUR HAND ON YOUR HEART AND SAY IT IS WELL WITH MY SOUL',
  'THE CHOIR WILL LEAD US IN ONE MORE SONG BEFORE THE OFFERING',
  'EVERY ONE OF US HAS SINNED AND FALLEN SHORT OF THE GLORY',
  'HE WAS WOUNDED FOR OUR TRANSGRESSIONS AND BRUISED FOR OUR INIQUITIES',
  'THE PRIEST WENT INTO THE TEMPLE AND STOOD BEFORE THE ALTAR',
  'A PROPHET IS NOT WITHOUT HONOUR EXCEPT IN HIS OWN COUNTRY',
  'THE DISCIPLES WERE AFRAID BUT JESUS SAID PEACE BE STILL',
  'FAITH COMES BY HEARING AND HEARING BY THE WORD OF GOD',
  'I AM NOT ASHAMED OF THE GOSPEL FOR IT IS THE POWER OF GOD',
  'THE APOSTLE PAUL WROTE THIS LETTER FROM A PRISON CELL',
  'MANY OF YOU HAVE BEEN PRAYING AND FASTING FOR THREE WEEKS',
  'GOD IS NOT A MAN THAT HE SHOULD LIE NEITHER THE SON OF MAN',
  'WHEN I WAS A CHILD I SPOKE AS A CHILD AND I THOUGHT AS A CHILD',
  'THE KINGDOM OF HEAVEN IS LIKE A MUSTARD SEED A MAN PLANTED',
  'LET US PRAY FOR THE SICK AND FOR THOSE WHO ARE TRAVELLING',
  'THE COMMANDMENT IS THIS THAT YOU LOVE ONE ANOTHER AS I HAVE LOVED YOU',
  'I HAVE FOUGHT A GOOD FIGHT I HAVE FINISHED MY COURSE',
  'THERE WERE FIVE THOUSAND MEN BESIDE WOMEN AND CHILDREN THAT DAY',
  'THE SERVICE WILL END AT ELEVEN AND THE BUSES LEAVE AT HALF PAST',
  'DO NOT LET THE SUN GO DOWN UPON YOUR WRATH MY FRIENDS',
  'A SOFT ANSWER TURNS AWAY WRATH BUT GRIEVOUS WORDS STIR UP ANGER',
  'THE SPIRIT OF THE LORD IS UPON ME BECAUSE HE HAS ANOINTED ME',
  'BLESSED ARE THE POOR IN SPIRIT FOR THEIRS IS THE KINGDOM',
  'WE ARE MORE THAN CONQUERORS THROUGH HIM THAT LOVED US',
  'THE BAPTISM CLASS MEETS ON WEDNESDAY EVENING AT SEVEN',
  'GIVE AND IT SHALL BE GIVEN UNTO YOU PRESSED DOWN AND SHAKEN TOGETHER',
  'MY GRANDMOTHER USED TO SAY THAT PRAYER CHANGES THINGS',
  'THE YOUNG MAN CAME BACK HOME AND HIS FATHER RAN TO MEET HIM',
  'THERE IS A TIME TO BE BORN AND A TIME TO DIE SAYS THE PREACHER',
  'THE WOMAN TOUCHED THE HEM OF HIS GARMENT AND SHE WAS MADE WHOLE',
  'STAND UP ON YOUR FEET AND GIVE THE LORD A BIG HAND OF PRAISE',
  'OUR CHURCH HAS BEEN IN THIS CITY FOR THIRTY FIVE YEARS NOW',
  'THE ELDERS WILL BE AT THE DOOR IF YOU NEED SOMEONE TO PRAY WITH',
  'HE THAT DWELLS IN THE SECRET PLACE OF THE MOST HIGH SHALL ABIDE',
  'THE WAGES OF SIN IS DEATH BUT THE GIFT OF GOD IS ETERNAL LIFE',
  'YOU CANNOT SERVE BOTH GOD AND MONEY YOU WILL LOVE ONE AND HATE THE OTHER',
  'THE HARVEST TRULY IS PLENTIFUL BUT THE LABOURERS ARE FEW',
  'I WAS GLAD WHEN THEY SAID UNTO ME LET US GO INTO THE HOUSE',
  'WE THANK GOD FOR EVERY MEMBER WHO GAVE TOWARDS THE BUILDING',
  'THE FRUIT OF THE SPIRIT IS LOVE JOY PEACE PATIENCE AND KINDNESS',
  'HE HAS NOT DEALT WITH US ACCORDING TO OUR SINS SOMEBODY SAY AMEN',
  'AND NOW ABIDES FAITH HOPE AND LOVE BUT THE GREATEST IS LOVE',
  'THE MAN WAS SITTING BY THE ROAD SIDE BEGGING FOR BREAD',
  'BEHOLD I STAND AT THE DOOR AND KNOCK IF ANY MAN HEAR MY VOICE',
  'IT IS A FEARFUL THING TO FALL INTO THE HANDS OF THE LIVING GOD',
  'MY HELP COMES FROM THE LORD WHICH MADE HEAVEN AND EARTH',
  'THE SEED FELL ON STONY GROUND WHERE IT HAD NOT MUCH EARTH',
  'WE WILL TAKE THE OFFERING NOW AND THEN THE CHOIR WILL SING',
  'SOME OF US HAVE BEEN CARRYING A BURDEN WE WERE NEVER MEANT TO CARRY',
  'THE ANSWER CAME ON THE TWENTY FIRST DAY AFTER HE STARTED PRAYING',
  'FATHER FORGIVE THEM FOR THEY KNOW NOT WHAT THEY DO',
  'HE IS ABLE TO DO EXCEEDING ABUNDANTLY ABOVE ALL THAT WE ASK OR THINK',
  'THE STONE WHICH THE BUILDERS REFUSED HAS BECOME THE HEAD CORNER',
  'BE CAREFUL FOR NOTHING BUT IN EVERYTHING BY PRAYER AND SUPPLICATION',
  'THE CHILDREN OF ISRAEL WALKED THROUGH THE SEA ON DRY GROUND',
  'THIS IS THE DAY THAT THE LORD HAS MADE WE WILL REJOICE IN IT',
  'IF MY PEOPLE WHICH ARE CALLED BY MY NAME SHALL HUMBLE THEMSELVES',
  'THE ANGEL OF THE LORD ENCAMPS AROUND THOSE WHO FEAR HIM',
  'HOW BEAUTIFUL ARE THE FEET OF THEM THAT PREACH THE GOSPEL OF PEACE',
  'THERE IS NOTHING TOO HARD FOR GOD AND NOTHING TOO SMALL FOR HIM',
  'THE LETTER TO THE HEBREWS TELLS US THAT FAITH IS THE SUBSTANCE',
  'WE READ FROM ISAIAH FIFTY THREE AND FROM PSALM TWENTY THREE',
  'IN THE BEGINNING GOD CREATED THE HEAVEN AND THE EARTH',
  'THE BOOK OF GENESIS TELLS US HOW IT ALL STARTED',
  'JEREMIAH WAS CALLED BEFORE HE WAS FORMED IN THE WOMB',
  'EZEKIEL SAW THE VALLEY FULL OF DRY BONES AND HE PROPHESIED',
  'DANIEL WAS THROWN INTO THE DEN AND THE LIONS DID NOT TOUCH HIM',
  'HABAKKUK SAID THOUGH THE FIG TREE SHALL NOT BLOSSOM YET WILL I REJOICE',
  'PAUL AND SILAS SANG AT MIDNIGHT AND THE PRISON DOORS OPENED',
  'ZACCHAEUS CLIMBED THE TREE BECAUSE HE WAS SHORT OF STATURE',
  'MELCHIZEDEK MET ABRAHAM COMING BACK FROM THE SLAUGHTER OF THE KINGS',
  'NEBUCHADNEZZAR SET UP AN IMAGE OF GOLD IN THE PLAIN OF DURA',
  'THE THREE HEBREW BOYS WOULD NOT BOW AND THE FIRE DID NOT BURN THEM',
  'THANK YOU FOR COMING AND GOD BLESS YOU RICHLY THIS WEEK',
  'PLEASE GREET THE PERSON NEXT TO YOU AND TELL THEM YOU ARE LOVED',
  'THE MID WEEK SERVICE IS ON THURSDAY AND THE VIGIL IS ON FRIDAY',
  'I KNOW SOMEBODY HERE IS TIRED AND READY TO GIVE UP TODAY',
  'BUT I WANT TO TELL YOU THAT YOUR STORY IS NOT FINISHED',
  'THE SAME GOD WHO STARTED THE WORK IS ABLE TO COMPLETE IT',
  'HE MAKES ALL THINGS BEAUTIFUL IN HIS OWN TIME NOT IN OUR TIME',
  'WHEN YOU PASS THROUGH THE WATERS I WILL BE WITH YOU',
  'YOU HAVE NOT BECAUSE YOU ASK NOT SAYS THE BOOK OF JAMES',
  'THE ACTS OF THE APOSTLES SHOWS US WHAT THE EARLY CHURCH DID',
  'THE NUMBER OF THE DISCIPLES MULTIPLIED IN JERUSALEM GREATLY',
  'JOB LOST EVERYTHING AND STILL HE DID NOT CHARGE GOD FOOLISHLY',
  'MARK TELLS THE STORY QUICKLY AND LUKE TELLS IT LIKE A DOCTOR',
  'RUTH SAID WHERE YOU GO I WILL GO AND YOUR PEOPLE SHALL BE MY PEOPLE',
  'THE KINGS OF THE EARTH SET THEMSELVES AGAINST THE LORD',
  'THE JUDGES RULED BEFORE THERE WAS A KING IN ISRAEL',
  'SING A NEW SONG UNTO THE LORD FOR HE HAS DONE MARVELLOUS THINGS',
  'THE FEAR OF THE LORD IS THE BEGINNING OF WISDOM SAYS PROVERBS',
  'I HEARD A VOICE SAYING WHOM SHALL I SEND AND WHO WILL GO FOR US',
  'THE MEETING IS AT THE CHURCH HALL AND EVERYBODY IS INVITED',
  'WE HAVE A COACH LEAVING AT SIX AND ANOTHER ONE AT HALF SEVEN',
  'BRING YOUR FAMILY BRING YOUR NEIGHBOUR AND BRING SOMEBODY WITH YOU',
  'THE LORD BLESS YOU AND KEEP YOU AND MAKE HIS FACE SHINE UPON YOU',
];

/* ---------------------------------------------------------------- */
head('The sound of a word — the key two spellings share');
const keyPairs = [
  ['Ezekiel', 'Ezekial'], ['Habakkuk', 'Habakuk'], ['Thessalonians', 'Thesalonians'],
  ['Deuteronomy', 'Deuteronemy'],
];
for (const [a, b] of keyPairs) {
  check(`"${b}" sounds like "${a}"`, W.keyBody(W.soundKey(a)) === W.keyBody(W.soundKey(b)),
    `${W.soundKey(a)} vs ${W.soundKey(b)}`);
}
check('a leading vowel heard differently does not hide the match (Ephesians / a fee shins)',
  W.keyBody(W.soundKey('Ephesians')) === W.keyBody(W.soundKey('a fee shins')),
  `${W.soundKey('Ephesians')} vs ${W.soundKey('a fee shins')}`);
check('two words that merely start alike do NOT share a key',
  W.keyBody(W.soundKey('grace')) !== W.keyBody(W.soundKey('gracious')));
/* Nebuchadnezzar is the case the key alone cannot carry: the CH in it is a K
 * sound, and no phonetic key can know that from the spelling. It is caught by
 * the second gate instead — a long word may be ONE sound out if the spelling is
 * nearly right — which is exactly what that gate is for. */
check('a long name the key alone cannot match is still caught (Nebucadnezar)',
  W.levenshtein(W.keyBody(W.soundKey('Nebuchadnezzar')), W.keyBody(W.soundKey('Nebucadnezar'))) === 1
  && W.similarity('Nebuchadnezzar', 'Nebucadnezar') >= W.SOUND_NEAR_SIM,
  `${W.soundKey('Nebuchadnezzar')} vs ${W.soundKey('Nebucadnezar')}, spelling ${W.similarity('Nebuchadnezzar', 'Nebucadnezar').toFixed(2)}`);

head('It fixes what it was told to fix');
const fixCases = [
  ['THE BOOK OF A FEE SHINS THREE', 'THE BOOK OF EPHESIANS THREE', 'the correction that was typed in'],
  ['WE READ FROM HABAKUK TWO FOUR', 'WE READ FROM HABAKKUK TWO FOUR', 'a spelling nobody ever typed, caught by sound'],
  ['THE BOOK OF EZEKIAL SAYS', 'THE BOOK OF EZEKIEL SAYS', 'and another variant of it'],
  ['PASTOR ADABOYE IS HERE', 'PASTOR ADEBOYE IS HERE', "the church's own name for its own preacher"],
  ['WELCOME TO WINNERS CHAPEL', 'WELCOME TO WINNERS CHAPEL', 'a two-word correction (spelling stays, case follows the line)'],
  ['NEBUCADNEZAR THE KING OF BABYLON', 'NEBUCHADNEZZAR THE KING OF BABYLON', 'a long name mangled in the middle'],
];
for (const [input, want, why] of fixCases) {
  const got = W.applyToText(input, M).text;
  check(why, got === want, got === want ? got : `got "${got}"  want "${want}"`);
}

head('It does not fix what it was NOT told to fix');
{
  let changed = [];
  let words = 0;
  for (const line of CORPUS) {
    words += line.split(/\s+/).length;
    const r = W.applyToText(line, M);
    if (r.count) changed.push(`${line}  ->  ${r.text}`);
  }
  check(`${words} words of ordinary sermon English go through UNCHANGED`, changed.length === 0,
    changed.length ? changed.slice(0, 3).join('   ||   ') : `${CORPUS.length} lines, nothing touched`);
}
{
  // The specific traps: everyday words that sound like something in the book.
  const traps = [
    ['THE GRACE OF GOD IS ENOUGH', 'grace is / gracious'],
    ['HE IS A PASTOR AND A FATHER', 'pastor / pastoral'],
    ['DRINK THE JUICES OF THE VINE', 'juices / Jesus'],
    ['THE ACTS OF THE APOSTLES', 'acts / Acts'],
    ['GIVE HIM A MARK OF RESPECT', 'mark / Mark'],
    ['HE DID A GOOD JOB THIS WEEK', 'job / Job'],
    ['THE NUMBERS DID NOT ADD UP', 'numbers / Numbers'],
    ['I WILL EMAIL YOU THE ROTA', 'nothing at all'],
    ['DRINK THE FRUIT OF THE VINE', 'the vine / Theophany — two words joined on too little sound'],
    ['WE READ PROVERBS I AM SURE YOU KNOW IT', 'PROVERBS I — the right word plus a word it must not swallow'],
  ];
  for (const [line, why] of traps) {
    const r = W.applyToText(line, M);
    check(`left alone: ${why}`, r.count === 0, r.count ? r.text : '');
  }
}

head('A word already spelled right is never "corrected" to itself');
for (const t of ['EPHESIANS', 'EZEKIEL', 'HABAKKUK', 'ADEBOYE', 'NEBUCHADNEZZAR']) {
  const r = W.applyToText(`AND THEN ${t} SPOKE`, M);
  check(`${t} untouched`, r.count === 0, r.text);
}

head('Learning: what one retyped line teaches');
{
  const c1 = W.learnFromEdit('THE BOOK OF A FEE SHINS THREE', 'THE BOOK OF EPHESIANS THREE');
  check('three heard words -> one written word', c1.length === 1 && c1[0].from === 'a fee shins' && c1[0].to === 'Ephesians',
    JSON.stringify(c1));
  check('…and it is stored in the case it should be WRITTEN, not the shouted case it was typed in',
    c1[0].to === 'Ephesians', c1[0] && c1[0].to);
  check('…and it is not treated as a judgement call', c1[0].risky === false);

  /*
   * THE RULE THAT REPLACED "risky, remembered after twice".
   *
   * One everyday word swapped for another is true of the sentence it was typed
   * in and false of the next, and repetition does not change that — a real
   * church's book grew 142 of them and contained `he's → it's` and `it's → he's`
   * both switched on. So such a change is WIDENED with the words around it, and
   * with no context anywhere it is not remembered at all.
   */
  const c2 = W.learnFromEdit('IT IS THERE BOOK', 'IT IS THEIR BOOK');
  check('an everyday word is widened with the words around it, not stored bare',
    c2.length === 1 && c2[0].from === 'is there book' && c2[0].widened === true, JSON.stringify(c2));
  check('…and is not a judgement call any more, because it is specific', c2[0].risky === false);
  check('…and the words it should say are kept in the case they belong in',
    /their/.test(c2[0].to) && c2[0].to === 'is their book', c2[0] && c2[0].to);

  const bare = W.learnFromEdit("HE'S", "IT'S");
  check('with no context anywhere — one word per line, no neighbours — nothing is remembered',
    bare.length === 0, JSON.stringify(bare));
  const withNeighbours = W.learnFromEdit("HE'S", "IT'S", { prev: 'AND', next: 'NOT' });
  check('…but the caption lines either side ARE context, and make it specific',
    withNeighbours.length === 1 && withNeighbours[0].from === "and he's not"
      && withNeighbours[0].to === "and it's not", JSON.stringify(withNeighbours));

  const c3 = W.learnFromEdit('GRACE IS FREE', 'GRACE IS FREE INDEED');
  check('a word ADDED teaches nothing (that is an edit, not a mishearing)', c3.length === 0, JSON.stringify(c3));

  const c4 = W.learnFromEdit('GRACE IS FREE INDEED', 'GRACE IS FREE');
  check('a word DELETED teaches nothing either', c4.length === 0, JSON.stringify(c4));

  const c5 = W.learnFromEdit('HE SAID HELLO', 'he said hello');
  check('changing only the case teaches nothing', c5.length === 0, JSON.stringify(c5));

  const c6 = W.learnFromEdit('ONE TWO THREE FOUR FIVE SIX', 'A COMPLETELY DIFFERENT SENTENCE ALTOGETHER NOW');
  check('a whole-line rewrite is not learned as a correction', c6.length === 0, JSON.stringify(c6));

  const c7 = W.learnFromEdit('WE SERVE AT WINERS CHAPEL TODAY', 'WE SERVE AT WINNERS CHAPEL TODAY');
  check('one word inside a line, with the rest untouched', c7.length === 1 && c7[0].from === 'winers' && c7[0].to === 'Winners',
    JSON.stringify(c7));

  const c8 = W.learnFromEdit('AND PASTOR ADABOYE PRAYED FOR THE SICK', 'AND PASTOR ADEBOYE PRAYED FOR THE SICK');
  check('two corrections in one line are both learned',
    W.learnFromEdit('A FEE SHINS AND EZEKIAL', 'EPHESIANS AND EZEKIEL').length === 2,
    JSON.stringify(W.learnFromEdit('A FEE SHINS AND EZEKIAL', 'EPHESIANS AND EZEKIEL')));
  check('…and a name is title-cased, not shouted', c8[0] && c8[0].to === 'Adeboye', JSON.stringify(c8));
}

head('Applying to the TIMED words: the timings survive');
{
  const words = [
    { start: 0.0, end: 0.4, text: 'THE' },
    { start: 0.4, end: 0.8, text: 'BOOK' },
    { start: 0.8, end: 1.0, text: 'OF' },
    { start: 1.0, end: 1.3, text: 'A' },
    { start: 1.3, end: 1.7, text: 'FEE' },
    { start: 1.7, end: 2.4, text: 'SHINS' },
    { start: 2.4, end: 2.9, text: 'THREE' },
  ];
  const r = W.applyToWords(words, M);
  check('three words became one', r.words.length === 5 && r.words[3].text === 'EPHESIANS',
    r.words.map((w) => w.text).join(' '));
  check('the new word starts when the first one did and ends when the last one did',
    r.words[3].start === 1.0 && r.words[3].end === 2.4, `${r.words[3].start} -> ${r.words[3].end}`);
  let mono = true;
  for (let i = 1; i < r.words.length; i++) if (r.words[i].start < r.words[i - 1].start) mono = false;
  check('the word list is still in time order', mono);
  check('the words either side are untouched objects',
    r.words[0] === words[0] && r.words[4] === words[6]);

  // …and the other way round: one heard word standing in for two written ones.
  const m2 = W.matcherFor([{ from: 'forgive', to: 'for give' }]);
  const r2 = W.applyToWords([{ start: 1, end: 2, text: 'FORGIVE' }], m2);
  check('one word can become two, splitting the time between them',
    r2.words.length === 2 && r2.words[0].start === 1 && r2.words[1].end === 2,
    JSON.stringify(r2.words));
}

head('A mishearing that is spread over several caption LINES');
{
  /* This is the normal shape of a shorts caption: Words/line is often 1, so
   * "A FEE SHINS" is not a line with a wrong word in it — it is three lines. */
  const lines = [
    { start: 1.0, end: 1.4, text: 'TO' },
    { start: 1.4, end: 1.7, text: 'A' },
    { start: 1.7, end: 2.1, text: 'FEE' },
    { start: 2.1, end: 2.8, text: 'SHINS' },
    { start: 2.8, end: 3.2, text: 'THREE' },
  ];
  const r = W.applyAcrossLines(lines, M);
  check('the phrase is found across the line breaks', r.count === 1, JSON.stringify(r.lines.map((l) => l.text)));
  check('the replacement lands on the line the phrase STARTED on',
    r.lines.map((l) => l.text).join('|') === 'TO|EPHESIANS|THREE', r.lines.map((l) => l.text).join('|'));
  check('the lines it swallowed are gone, not left blank', r.dropped === 2 && r.lines.length === 3, JSON.stringify(r.lines));
  check('and it holds the screen for as long as the spoken words did',
    r.lines[1].start === 1.4 && r.lines[1].end === 2.8, `${r.lines[1].start} -> ${r.lines[1].end}`);
  check('lines it did not touch are the very same objects', r.lines[0] === lines[0] && r.lines[2] === lines[4]);
  const none = W.applyAcrossLines([{ start: 0, end: 1, text: 'GRACE' }, { start: 1, end: 2, text: 'IS' }], M);
  check('and a stream with nothing to fix comes back untouched', none.count === 0 && none.lines === none.lines);
}

head('Spreading one correction through a long video is instant too');
{
  // What the studio does on every corrected line: the exact words just typed,
  // no sound-alike layer, over the whole sermon.
  const m = W.matcherFor([{ from: 'a fee shins', to: 'Ephesians' }, { from: 'habakuk', to: 'Habakkuk' }]);
  const pool = CORPUS.join(' ').split(/\s+/);
  const words = [];
  for (let i = 0; words.length < 30000; i++) words.push({ start: i * 0.4, end: i * 0.4 + 0.35, text: pool[i % pool.length] });
  W.applyToWords(words.slice(0, 2000), m);
  const t0 = Date.now();
  W.applyToWords(words, m);
  const ms = Date.now() - t0;
  check(`a correction sweeps 30,000 words in ${ms}ms (budget 80ms — this runs as you type)`, ms < 80, `${ms}ms`);
}

head('Punctuation and case are kept exactly as they were');
{
  const m3 = W.matcherFor([{ from: 'a fee shins', to: 'Ephesians' }]);
  check('a trailing comma stays on the replacement',
    W.applyToText('READ A FEE SHINS, AND THEN PRAY', m3).text === 'READ EPHESIANS, AND THEN PRAY',
    W.applyToText('READ A FEE SHINS, AND THEN PRAY', m3).text);
  check('an ALL CAPS line gets an ALL CAPS replacement',
    W.applyToText('READ A FEE SHINS TODAY', m3).text === 'READ EPHESIANS TODAY');
  check('a normal-case line gets the spelling as it is stored',
    W.applyToText('Read a fee shins today', m3).text === 'Read Ephesians today',
    W.applyToText('Read a fee shins today', m3).text);
  const m4 = W.matcherFor([{ from: 'there', to: 'their' }]);
  check('a lower-case stored word still gets its capital at the start of a line',
    W.applyToText('There book was open', m4).text === 'Their book was open',
    W.applyToText('There book was open', m4).text);
  check("an apostrophe inside a word is part of it",
    W.normWord("DON'T") === "don't" && W.normWord('“WORD”') === 'word');
}

head('It cannot make anything slower');
{
  // A three-hour service: ~30,000 words. Built from the corpus so the matcher
  // has to do its real work (n-gram lookups, sound keys) on every one of them.
  const pool = CORPUS.join(' ').split(/\s+/);
  const words = [];
  for (let i = 0; words.length < 30000; i++) {
    const t = pool[i % pool.length];
    words.push({ start: i * 0.4, end: i * 0.4 + 0.35, text: t });
  }
  W.applyToWords(words.slice(0, 2000), M);            // warm the JIT, as a real run is
  const t0 = Date.now();
  const r = W.applyToWords(words, M);
  const ms = Date.now() - t0;
  check(`30,000 words in ${ms}ms (budget 250ms — whisper takes over an hour to produce them)`, ms < 250, `${ms}ms`);
  check('…and it still changed nothing in them', r.count === 0, String(r.count));
  const t1 = Date.now();
  W.compile(BOOK);
  check(`compiling the book (with its ${W.SEED_TERMS.length} built-in words) takes ${Date.now() - t1}ms`,
    Date.now() - t1 < 120, `${Date.now() - t1}ms`);
}

head('The built-in vocabulary knows what it should, and only that');
{
  const bad = W.SEED_TERMS.filter((t) => W.isCommonWord(t));
  check('no everyday English word is a sound-alike target', bad.length === 0, bad.slice(0, 8).join(', '));
  const short = W.SEED_TERMS.filter((t) => W.lettersOf(t).length < W.SOUND_MIN_TERM_LEN);
  check('nothing too short to be distinctive is one either', short.length === 0, short.slice(0, 8).join(', '));
  for (const b of ['Ephesians', 'Ezekiel', 'Habakkuk', 'Deuteronomy', 'Thessalonians', 'Nebuchadnezzar', 'Melchizedek']) {
    check(`it ships knowing "${b}"`, W.SEED_TERMS.some((t) => W.normPhrase(t) === W.normPhrase(b)));
  }
}

head('The built-in names never pull ordinary speech (found live, by review)');
{
  /*
   * The first list of extra Bible names shipped to the live studio and turned
   * "the false prophets" into "Theophilus prophets", "raised us up" into
   * "Erastus up" and "jars of clay" into "Jairus of clay" — the names had been
   * checked against a dictionary of headwords (no "jars", no word pairs). The
   * list now in the book was run over 2.1M words of real English and all 25M
   * pairs of the 5,000 commonest words; these are the sentences that caught it.
   */
  const m = W.compile({ enabled: true, soundAlike: true, fixes: [], terms: [] });
  const say = (t) => W.applyToWords(t.split(' ').map((x, i) => ({ text: x, start: i, end: i + 0.9 })), m).words.map((w) => w.text).join(' ');
  for (const t of ['Beware of the false prophets', 'God raised us up together with Christ', 'we have this treasure in jars of clay',
    'six stone water jars', 'nails through his wrists', 'it would have been easier', 'She named him Moses',
    'They came to arrest this man', 'the fowls of the air', 'through the valleys', 'true famous men', 'seek league']) {
    check(`"${t}" comes through untouched`, say(t) === t, say(t));
  }
  // …and the names it was added for still land
  check('"Methabosheth" -> "Mephibosheth"', say('think about Methabosheth who') === 'think about Mephibosheth who', say('think about Methabosheth who'));
  check('"Jehovah-Jire" -> "Jehovah Jireh"', say('but Jehovah-Jire is') === 'but Jehovah Jireh is', say('but Jehovah-Jire is'));
  check('"Zarababel" -> "Zerubbabel"', say('Zarababel heard') === 'Zerubbabel heard', say('Zarababel heard'));
  check('no built-in correction that a revert could turn into "the Lord" -> "Allah"', say('praise the Lord') === 'praise the Lord');
  // a name keeps its 's and its plural (second review: "Goliath's sword" -> "Goliath sword", and
  // "Ezekiel's wheel" -> "Ezekiel wheel" with the book's original names too)
  for (const t of ["David took Goliath's sword", 'face the Goliaths in your life', "Delilah's lap", "Ezekiel's wheel", "Mephibosheth's feet", 'to Ramath and back']) {
    check(`"${t}" keeps its ending (and its place names)`, say(t) === t, say(t));
  }
  check('a misspelt name with an ending gets the name back WITH it ("Ezekial\'s" -> "Ezekiel\'s")', say("Ezekial's wheel") === "Ezekiel's wheel", say("Ezekial's wheel"));
  // …and the stem of an ordinary plural never starts a name of its own (the 25-million-pair
  // sweep caught "plates" -> "Pilates", "clubs" -> "Calebs", "herds" -> "Herods")
  const plurals = 'plates clubs herds herbs summons debris ribbons pilots shrubs cannons colts divides rebukes denials counters ' +
    "minors amenities manuals gilds grips potter's simon's colt's pilot's Phillips Stevens Simmons Robbins Watson's Mitchell's";
  const pulled = plurals.split(' ').filter((w) => say('the ' + w + ' were') !== 'the ' + w + ' were');
  check('ordinary plurals and possessives stay as they are (plates, clubs, herds, … 30 of them)', !pulled.length,
    pulled.map((w) => w + ' -> ' + say('the ' + w + ' were')).join(', '));

  // The built-in names never replace real English, a real place or a real person's name. Before the
  // known-word list, 583 of the 100,000 commonest English words were re-spelled ("plate" -> Pilate,
  // "divide" -> David, "Ibadan" -> Abaddon, "Simon" -> Simeon); a sample of them stays here.
  check('the known-word list is loaded (plate is a word, Methabosheth is not)',
    W.isKnownWord('plate') && W.isKnownWord("Watson's") && W.isKnownWord("nothin'") && !W.isKnownWord('Methabosheth') && !W.isKnownWord('Ezekial'));
  for (const t of ['the plate was full', 'divide it in two', 'sales were up', 'a phrase from the song', 'salmon and rice',
    'read the manual', 'a minor key', 'the masses came', 'apples and pools', 'full assurance of faith', 'the ceiling fell',
    'he flew to Ibadan', 'a Ghanaian pastor', 'the Syrian army', 'Simon Peter answered', 'Brother Steven prayed',
    'Jeremy and Mitchell', 'Pastor Watson preached', 'Paul sailed to Crete', 'Plato wrote', 'Bilal sang', 'nothin like it',
    'carefully curated', 'the romance novel', 'it applies to you', 'a herd of pigs', 'he hired them', 'André came',
    // the King James Bible's own names and words, read aloud (the sweep found "Shallum" -> Shalom, "Pharez" -> Pharisee)
    'Shallum the son of Jabesh', 'Pharez and Zerah', 'Dathan and Abiram', 'they served Molech', 'whom he hath predestinated',
    // a name spelled right is never swallowed into a longer one, and place names in pairs stay put
    'by the rivers of Babylon in tears', 'from Canaan to Egypt', 'less Russia more Ukraine', 'from Toronto run']) {
    check(`"${t}" comes through untouched`, say(t) === t, say(t));
  }
  // …while the operator's OWN names keep the older rule: they chose them, and "Wally Oak" is why
  const mine = W.compile({ enabled: true, soundAlike: true, fixes: [], terms: [{ text: 'Siloam' }] });
  const sayMine = (t) => W.applyToWords(t.split(' ').map((x, i) => ({ text: x, start: i, end: i + 0.9 })), mine).words.map((w) => w.text).join(' ');
  check('a name the operator added still catches a real-word mishearing ("salam" -> their "Siloam")',
    sayMine('the pool of salam') === 'the pool of Siloam', sayMine('the pool of salam'));
  check('…and the same word with only the built-in book is left alone', say('the pool of salam') === 'the pool of salam', say('the pool of salam'));
}

/* ------------------------------------------------------------------ *
 * The book on disk, and the policy that decides what goes in it.
 * ------------------------------------------------------------------ */
head('The book on disk');
const WORK = path.join(os.tmpdir(), 'mw-wordbook-test-' + Date.now().toString(36));
fs.mkdirSync(WORK, { recursive: true });
const store = require('../src/main/wordbook.js');
store.init(WORK);
{
  const r = store.learnFromEdits([{ before: 'THE BOOK OF A FEE SHINS', after: 'THE BOOK OF EPHESIANS' }]);
  check('a mishearing of a non-word is trusted the first time', r.learned.length === 1 && !r.waiting.length,
    JSON.stringify(r));
  const applied = store.apply([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'fee' }, { start: 2, end: 3, text: 'shins' }]);
  check('…and the very next transcription comes out right', applied.count === 1 && applied.entries[0].text === 'Ephesians',
    JSON.stringify(applied.entries));

  const r2 = store.learnFromEdits([{ before: 'IT IS THERE BOOK', after: 'IT IS THEIR BOOK' }]);
  check('an everyday word is remembered only as a phrase', r2.learned.length === 1
    && r2.learned[0].from === 'is there book', JSON.stringify(r2));
  const notYet = store.apply([{ start: 0, end: 1, text: 'there' }]);
  check('…so a bare "there" in another sentence is left completely alone', notYet.count === 0,
    JSON.stringify(notYet.entries));
  const inPhrase = store.apply(['it', 'is', 'there', 'book', 'again'].map((t, i) => ({ start: i, end: i + 1, text: t })));
  check('…while the phrase it was learned from is fixed wherever it appears',
    inPhrase.count === 1 && inPhrase.entries.map((e) => e.text).join(' ') === 'it is their book again',
    inPhrase.entries.map((e) => e.text).join(' '));

  /* The pair that cancelled itself out in a real church's book. */
  const one = store.addFix({ from: "and he's not", to: "and it's not", src: 'learned' });
  const other = store.learnFromEdits([{ before: "AND IT'S NOT", after: "AND HE'S NOT" }]);
  check('a correction that would UNDO one already in the book is refused',
    one.ok && (other.conflicts || []).length === 1, JSON.stringify(other));
  check('…and the one it contradicts is switched off too, because the word depends on the sentence',
    store.view().fixes.filter((f) => f.from === "and he's not").every((f) => f.on === false),
    JSON.stringify(store.view().fixes.filter((f) => /he's|it's/.test(f.from))));

  const off = store.setOptions({ enabled: false });
  check('the whole book can be switched off', off.enabled === false
    && store.apply([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'fee' }, { start: 2, end: 3, text: 'shins' }]).count === 0);
  store.setOptions({ enabled: true });

  const dup = store.addFix({ from: 'A FEE SHINS', to: 'Ephesians', src: 'user' });
  check('adding a correction that is already there does not duplicate it',
    dup.ok && store.view().fixes.filter((f) => f.from === 'a fee shins').length === 1);
  const same = store.addFix({ from: 'grace', to: 'grace' });
  check('a "correction" to the same word is refused', !same.ok, same.reason);
  const nameBad = store.addTerm('the');
  check('an everyday word cannot be added as a sound-alike name', !nameBad.ok, nameBad.reason);
  const nameOk = store.addTerm('Oyakhilome');
  check('a real name can', nameOk.ok, nameOk.ok ? nameOk.term.text : nameOk.reason);
  check('…and it works straight away', store.apply([{ start: 0, end: 1, text: 'Oyakhilomay' }]).count === 1);

  store.flushSync();
  const raw = JSON.parse(fs.readFileSync(path.join(WORK, 'word-book.json'), 'utf-8'));
  check('it is on the disk',
    Array.isArray(raw.fixes) && raw.fixes.some((f) => f.from === 'a fee shins')
      && raw.fixes.some((f) => f.from === 'is there book'),
    `${(raw.fixes || []).length} corrections`);
  store.init(WORK);
  check('and it is still there after a restart',
    store.apply([{ start: 0, end: 1, text: 'a' }, { start: 1, end: 2, text: 'fee' }, { start: 2, end: 3, text: 'shins' }]).count === 1);
  check('a hand-mangled file cannot crash it', (() => {
    fs.writeFileSync(path.join(WORK, 'word-book.json'), '{ this is not json', 'utf-8');
    store.init(WORK);
    return store.view().fixes.length === 0 && store.apply([{ start: 0, end: 1, text: 'hello' }]).count === 0;
  })());
}

head('A book learned under the OLD rule is tidied before it is ever used');
{
  /*
   * Shaped exactly like the one from the church that reported this: 142
   * corrections, most of them one everyday word swapped for another, including
   * a pair switched on in BOTH directions. Every one of those is wrong on some
   * future sentence, and the pair is wrong on every sentence.
   */
  const DIR = path.join(WORK, 'old-book');
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'word-book.json'), JSON.stringify({
    version: 1, enabled: true, soundAlike: true, terms: [{ text: 'Adeboye' }],
    fixes: [
      { from: "he's", to: "it's", on: true, src: 'learned' },
      { from: "it's", to: "he's", on: true, src: 'learned' },
      { from: 'there', to: 'that', on: true, src: 'learned' },
      { from: 'they', to: 'the', on: true, src: 'learned' },
      { from: 'his', to: 'A', on: true, src: 'learned' },
      { from: 'was', to: 'must', on: false, src: 'learned' },
      { from: 'a fee shins', to: 'Ephesians', on: true, src: 'learned' },
      { from: 'habakuk', to: 'Habakkuk', on: true, src: 'learned' },
      { from: 'bob', to: 'God', on: true, src: 'user' },
    ],
  }));
  store.init(DIR);
  const rep = store.tidyReport();
  check('the load reports what it had to remove', !!rep && rep.removed === 6, JSON.stringify(rep));
  const kept = store.view().fixes.map((f) => f.from);
  check('the contradictory pair is gone — BOTH halves of it',
    !kept.includes("he's") && !kept.includes("it's"), JSON.stringify(kept));
  check('so are the everyday-word rules that depended on their sentence',
    !kept.includes('there') && !kept.includes('they') && !kept.includes('his') && !kept.includes('was'),
    JSON.stringify(kept));
  check('the real vocabulary is untouched', kept.includes('a fee shins') && kept.includes('habakuk'),
    JSON.stringify(kept));
  check('and anything typed in BY HAND is kept, whatever shape it is — it was asked for',
    kept.includes('bob'), JSON.stringify(kept));
  check('a sermon full of those two words now goes through untouched',
    store.apply(["he's", 'not', 'here', 'but', "it's", 'coming'].map((t, i) => ({ start: i, end: i + 1, text: t }))).count === 0);
  store.init(DIR);
  check('and the tidy happens ONCE — a second load has nothing to report', !store.tidyReport());
}

head('Segment-mode transcriptions (whole phrases) go through it too');
{
  store.init(WORK);
  store.addFix({ from: 'a fee shins', to: 'Ephesians', src: 'user' });
  const segs = store.apply([{ start: 0, end: 4, text: 'Turn with me to a fee shins chapter three.' }]);
  check('a phrase entry is fixed inside the sentence',
    segs.count === 1 && segs.entries[0].text === 'Turn with me to Ephesians chapter three.',
    segs.entries[0].text);
}

head('The transcription pipeline actually runs it');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'captioner.js'), 'utf-8');
  check('captioner.transcribe hands its words through the book before returning',
    /const book = wordbook\.apply\(words\);/.test(src) && /words: book\.entries, segments: book\.entries/.test(src));
  check('…and tells the studio how many it fixed', /fixed: book\.count/.test(src));
  const rend = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'veditor.js'), 'utf-8');
  check('a retyped line in the captions window is learned from, WITH its neighbours',
    /learnCaptionEdit\(before, capGroupCfg\(\)\.tc === 'upper' \? inp\.value : typed, \+inp\.dataset\.i\);/.test(rend));
  check('a retyped line on the TIMELINE is learned from as well',
    /learnCaptionEdit\(orig, capGroupCfg\(\)\.tc === 'upper' \? txt : typedTxt, i\);/.test(rend));
  check('…and the lines either side are what is handed to the learner',
    /prev: \(evs\[i - 1\] \|\| \{\}\)\.text/.test(rend) && /next: \(evs\[i \+ 1\] \|\| \{\}\)\.text/.test(rend));
  check('the studio and the main process share ONE matcher module',
    /require\('\.\.\/renderer\/wordbook\.js'\)/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'wordbook.js'), 'utf-8'))
    && /<script src="wordbook\.js">/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf-8')));
}

try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail === 0 ? 0 : 1);
