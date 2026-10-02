'use strict';
/*
 * FOLLOWING THE READING — measured, not asserted.
 *
 * The ask: a verse is on the screen, the speaker reads it out, and when they
 * say its LAST WORD the next verse opens by itself.
 *
 * Two failures are possible and they are not equally bad:
 *
 *   - IT DOES NOT TURN. The operator presses the arrow key, as they always
 *     did. Mildly disappointing.
 *   - IT TURNS TOO EARLY. The words come off the screen while the congregation
 *     is still reading them, in front of everybody. This is the one that gets
 *     the feature switched off for good, and most of the corpus below exists to
 *     make sure it cannot happen.
 *
 * So the important half of this file is [2] and [3]: every way of saying
 * something ABOUT a verse, or reading only PART of one, must leave the screen
 * alone.
 *
 *   node test/read-along.test.js
 */
const path = require('path');
const RA = require(path.join(__dirname, '..', 'src', 'renderer', 'readalong.js'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* Real verses, in the wording people actually read them in. */
const PS23_1 = 'The LORD is my shepherd; I shall not want.';
const PS23_2 = 'He maketh me to lie down in green pastures: he leadeth me beside the still waters.';
const JN3_16 = 'For God so loved the world, that he gave his only begotten Son, '
  + 'that whosoever believeth in him should not perish, but have everlasting life.';
const JN3_16_NIV = 'For God so loved the world that he gave his one and only Son, '
  + 'that whoever believes in him shall not perish but have eternal life.';
const ROM8_28 = 'And we know that all things work together for good to them that love God, '
  + 'to them who are the called according to his purpose.';
const PHIL4_13 = 'I can do all things through Christ which strengtheneth me.';
const JN11_35 = 'Jesus wept.';

const done = (verse, heard, opts) => RA.finishedReading(verse, heard, opts);

/* ===================================================================== */
head('[1] READ TO THE END — the page should turn');
{
  const cases = [
    ['Psalm 23:1 read straight through', PS23_1, 'the lord is my shepherd i shall not want'],
    ['…with the reader trailing off naturally', PS23_1, 'the lord is my shepherd i shall not want'],
    ['John 3:16, the whole verse', JN3_16,
      'for god so loved the world that he gave his only begotten son that whosoever '
      + 'believeth in him should not perish but have everlasting life'],
    ['Romans 8:28, the whole verse', ROM8_28,
      'and we know that all things work together for good to them that love god to them '
      + 'who are the called according to his purpose'],
    ['Philippians 4:13', PHIL4_13, 'i can do all things through christ which strengtheneth me'],
    ['a reader who began mid-sentence but finished the verse', ROM8_28,
      'all things work together for good to them that love god to them who are the called according to his purpose'],
  ];
  for (const [name, verse, heard] of cases) {
    const r = done(verse, heard);
    check(name, r.done, `run ${r.run}, tail gap ${r.tailGap}, ${(r.share * 100) | 0}% of the verse`);
  }
}

/* ===================================================================== */
head('[2] ►► READ ONLY PART OF IT — the screen MUST NOT move ◄◄');
{
  const cases = [
    ['the opening line only (the worst possible early turn)', PS23_1, 'the lord is my shepherd'],
    ['the first half of John 3:16', JN3_16, 'for god so loved the world that he gave his only begotten son'],
    ['the first half of Romans 8:28', ROM8_28, 'and we know that all things work together for good'],
    ['stopped one clause short', JN3_16,
      'for god so loved the world that he gave his only begotten son that whosoever believeth in him'],
    ['the first half of Psalm 23:2', PS23_2, 'he maketh me to lie down in green pastures'],
  ];
  for (const [name, verse, heard] of cases) {
    const r = done(verse, heard);
    check(name, !r.done, r.why);
  }
}

/* ===================================================================== */
head('[3] ►► TALKING ABOUT THE VERSE — the screen MUST NOT move ◄◄');
{
  const cases = [
    ['preaching around it', JN3_16,
      'now this is the verse everybody knows god loved the world and i want you to see what that cost him this morning'],
    ['quoting a fragment mid-sentence', PS23_1,
      'because if the lord is my shepherd then i have everything i need and that changes how you walk into monday'],
    ['naming the reference', JN3_16, 'turn with me to john chapter three verse sixteen'],
    ['landing on the ENDING of a long verse only', JN3_16,
      'but have everlasting life amen somebody shout amen'],
    ['an unrelated sentence', ROM8_28, 'we are going to take the offering now and then the choir will sing'],
    ['the words in the wrong order', PS23_1, 'i shall not want the lord is my shepherd'],
    ['a prayer using biblical language', PS23_2,
      'lord lead us beside still waters today and make us lie down in your peace'],
  ];
  for (const [name, verse, heard] of cases) {
    const r = done(verse, heard);
    check(name, !r.done, r.why);
  }
}

/* ===================================================================== */
head('[4] A MISHEARD WORD MUST NOT STOP IT — the recogniser is not perfect');
{
  const cases = [
    ['one word wrong in the middle', PS23_1, 'the lord is my shepherd i shall not what'],
    ['one word wrong near the end', PHIL4_13, 'i can do all things through christ which strengthens me'],
    ['a dropped word', ROM8_28,
      'and we know that all things work together for good to them that love god to them who are called according to his purpose'],
    ['two words wrong across a long verse', JN3_16,
      'for god so loved the world that he gave his only begotten son that whoever believeth in him should not perish but have everlasting life'],
  ];
  for (const [name, verse, heard] of cases) {
    const r = done(verse, heard);
    check(name, r.done, `run ${r.run}, tail gap ${r.tailGap}`);
  }
}

/* ===================================================================== */
head('[5] READING A DIFFERENT TRANSLATION FROM THE ONE ON SCREEN');
{
  // The screen shows the NIV; the preacher reads the King James from memory.
  const r = done(JN3_16_NIV,
    'for god so loved the world that he gave his only begotten son that whosoever '
    + 'believeth in him should not perish but have everlasting life');
  check('KJV read aloud against an NIV slide still finishes the verse', r.done,
    `run ${r.run}, tail gap ${r.tailGap}, ${(r.share * 100) | 0}%`);
}

/* ===================================================================== */
head('[6] THE CASES IT MUST REFUSE TO JUDGE AT ALL');
{
  const a = done(JN11_35, 'jesus wept');
  check('a two-word verse is never auto-advanced', !a.done, a.why);
  const b = done(PS23_1, '');
  check('silence does nothing', !b.done, b.why);
  const c = done(PS23_1, 'the lord is');
  check('a couple of words does nothing', !c.done, c.why);
  const d = done('', 'the lord is my shepherd i shall not want');
  check('no verse on screen, nothing to finish', !d.done, d.why);
}

/* ===================================================================== */
head('[7] THE SAME READING ARRIVING TWICE (rolling look-backs overlap)');
{
  /*
   * The studio offers the last few seconds over and over while somebody is
   * speaking, so the SAME completed reading arrives several times. This module
   * answers the same way every time on purpose — it is a pure question about
   * the words. Not turning the page twice is the studio's job (it remembers
   * which chunk it has already advanced past), and read-along-ui covers that.
   */
  const heard = 'the lord is my shepherd i shall not want';
  const a = done(PS23_1, heard), b = done(PS23_1, heard);
  check('it is a pure function of the words — same answer every time',
    a.done === b.done && a.run === b.run, `${a.done}/${b.done}`);
}

/* ===================================================================== */
head('[8] Fast enough to run on every look-back');
{
  const t0 = Date.now();
  const N = 2000;
  for (let i = 0; i < N; i++) {
    done(JN3_16, 'for god so loved the world that he gave his only begotten son that whosoever believeth in him should not perish but have everlasting life');
  }
  const per = (Date.now() - t0) / N;
  check('a judgement costs well under a millisecond', per < 1, per.toFixed(3) + ' ms each');
}

console.log(`\n==== Following the reading: ${pass} PASS / ${fail} FAIL ====`);
process.exit(fail ? 1 : 0);
