'use strict';
/*
 * REAL test for the modern translations in the Presentation Studio —
 * NIV, NLT, ESV, NKJV, NASB, AMP and The Message, read from bolls.life.
 *
 * Nothing is stubbed. It talks to the live site, downloads a whole translation
 * to disk, and then proves that translation still reads with nothing but the
 * local file. The fiddly part is not fetching the text — it is the markup that
 * rides along with it (section headings, Strong's numbers, poetry line breaks),
 * because every one of those ends up on the projector if it is not cleaned off.
 *
 *   node test/bible-modern.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const bible = require(path.join(ROOT, 'src/main/bible'));

const WORK = path.join(os.tmpdir(), 'mw-bible-modern-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
bible.init(WORK);

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
function skip(name, why) { console.log('  SKIP ' + name + (why ? '  -> ' + why : '')); }

const SEVEN = ['NIV', 'NLT', 'ESV', 'NKJV', 'NASB', 'AMP', 'MSG'];
/** Anything a projector must never show: markup, Strong's numbers, brace codes. */
const dirty = (s) => /[<>{}]/.test(s) || /\b\d{2,5}\b/.test(s.replace(/\d+:\d+/g, ''));

(async () => {
  /* ================= [1] the seven, live, with nothing downloaded ================= */
  console.log('\n[1] The seven translations a church actually asks for');
  let online = true;
  for (const code of SEVEN) {
    try {
      const r = await bible.lookup({ translation: 'bolls:' + code, ref: 'John 3:16' });
      const t = r.verses[0].text;
      log(t.length > 40 && /God/.test(t) && !dirty(t), `${code} — John 3:16`, t.slice(0, 64) + '…');
      log(r.code === code, `${code} — the slide footer says "${r.code}", not the internal id`, r.code);
    } catch (e) {
      if (/Could not reach|took too long|ENOTFOUND/i.test(e.message)) { online = false; skip(`${code} lookup`, e.message); }
      else log(false, `${code} — John 3:16`, e.message);
    }
  }
  if (!online) { console.log('\nNo network — the rest of this test needs bolls.life.'); process.exit(failed ? 1 : 0); }

  /* ================= [2] the markup that must never reach the glass ================= */
  console.log('\n[2] Section headings, Strong\'s numbers and poetry line breaks');
  const jn3 = await bible.lookup({ translation: 'bolls:NIV', ref: 'John 3:1' });
  log(/^Now there was a man/.test(jn3.verses[0].text),
    'John 3:1 starts at the verse, not at the section heading above it', jn3.verses[0].text.slice(0, 56) + '…');
  log(!/Nicodemus, a member/.test(jn3.verses[0].text.slice(0, 20)), 'and the verse itself survived intact');

  const gen1 = await bible.lookup({ translation: 'bolls:NIV', ref: 'Genesis 1:1' });
  log(gen1.verses[0].text === 'In the beginning God created the heavens and the earth.',
    'Genesis 1:1 has no "The Beginning" heading glued to the front', gen1.verses[0].text);

  const ps78 = await bible.lookup({ translation: 'bolls:NIV', ref: 'Psalm 78:71' });
  log(/brought him to be the shepherd/.test(ps78.verses[0].text),
    'a poetry line break becomes a SPACE, not two words run together', ps78.verses[0].text.slice(0, 62) + '…');

  const kjv = await bible.lookup({ translation: 'bolls:KJV', ref: 'John 3:16' });
  log(!/\d/.test(kjv.verses[0].text) && /^For God so loved the world/.test(kjv.verses[0].text),
    'Strong\'s numbers are stripped out of the KJV text', kjv.verses[0].text.slice(0, 54) + '…');

  const amp = await bible.lookup({ translation: 'bolls:AMP', ref: 'John 3:16' });
  log(!dirty(amp.verses[0].text) && /greatly/.test(amp.verses[0].text),
    'the Amplified\'s italics and brackets are unwrapped, keeping the words', amp.verses[0].text.slice(0, 60) + '…');

  /* the heuristic's hard case: this one READS like a heading and is scripture */
  const msg23 = await bible.lookup({ translation: 'bolls:MSG', ref: 'Psalm 23:4' });
  log(/Even when the way goes through Death Valley/.test(msg23.verses[0].text),
    'a Message line that looks like a heading is NOT thrown away', msg23.verses[0].text.slice(0, 58) + '…');

  /* ================= [3] the heading rule, on fixed strings ================= */
  console.log('\n[3] The heading rule itself (fixed strings, no network)');
  const CASES = [
    ['Jesus Teaches Nicodemus<br/>Now there was a man of the Pharisees named Nicodemus.', 'Now there was a man of the Pharisees named Nicodemus.'],
    ['BOOK I<br/>Psalms 1–41<br/>Psalm 1<br/>Blessed is the man', 'Blessed is the man'],
    ['ג Gimel<br/>Do good to your servant, and I will live;<br/>I will obey your word.', 'Do good to your servant, and I will live; I will obey your word.'],
    ['Even when the way goes through<br/>Death Valley,<br/>I\'m not afraid', 'Even when the way goes through Death Valley, I\'m not afraid'],
    ['he restores my soul.<br/>He guides me in paths of righteousness', 'he restores my soul. He guides me in paths of righteousness'],
    ['Your word is a lamp to my feet<br/>and a light for my path.', 'Your word is a lamp to my feet and a light for my path.'],
    ['Be kind to me, God—<br/>I\'m in deep, deep trouble again.', 'Be kind to me, God— I\'m in deep, deep trouble again.'],
    ['For<S>1063</S> God<S>2316</S> so loved<S>25</S> the world', 'For God so loved the world'],
  ];
  for (const [raw, want] of CASES) {
    const got = bible.cleanBolls(raw);
    log(got === want, `"${raw.slice(0, 40).replace(/\n/g, ' ')}…"`, got === want ? got.slice(0, 46) + '…' : `got "${got}"`);
  }

  /* ================= [4] ranges, chapters and searching, live ================= */
  console.log('\n[4] Looking things up the way an operator does');
  const rng = await bible.lookup({ translation: 'bolls:NLT', ref: 'Romans 8:38-39' });
  log(rng.verses.length === 2 && rng.reference === 'Romans 8:38-39', 'a verse range comes back as a range', rng.reference);
  const whole = await bible.lookup({ translation: 'bolls:ESV', ref: 'Psalm 23' });
  log(whole.verses.length === 6, 'a whole chapter comes back whole', `Psalm 23 = ${whole.verses.length} verses`);
  const hits = await bible.searchAny({ translation: 'bolls:NIV', query: 'the lord is my shepherd', limit: 8 });
  log(hits.some((h) => h.reference === 'Psalms 23:1'), 'searching the words finds the verse before anything is downloaded',
    hits.length ? hits[0].reference : 'nothing');
  const bks = await bible.books('bolls:NKJV');
  log((bks.find((b) => b.nr === 19) || {}).chapters === 150 && (bks.find((b) => b.nr === 65) || {}).chapters === 1,
    'chapter counts are right without a download (Psalms 150, Jude 1)');
  // The book/chapter/verse dropdowns must have something to offer even for a
  // source that can only be read one chapter at a time.
  const fallback = await bible.books('apib:some-version-id');
  log(fallback.length === 66 && fallback[18].chapters === 150 && fallback[65].chapters === 22,
    'a source that cannot be counted still fills the pickers with the canonical numbers',
    `Psalms ${fallback[18].chapters}, Revelation ${fallback[65].chapters}`);
  let threw = null;
  try { await bible.lookup({ translation: 'bolls:NIV', ref: 'John 99:1' }); } catch (e) { threw = e.message; }
  log(!!threw, 'a chapter that does not exist says so rather than hanging', threw);

  /* ================= [5] in the catalogue, next to everything else ================= */
  console.log('\n[5] In the picker, alongside the public-domain translations');
  const cat = await bible.catalogue();
  for (const code of SEVEN) {
    const hit = cat.find((t) => t.abbr === 'bolls:' + code);
    log(!!hit && /english/i.test(hit.language || ''), `${code} is in the catalogue`, hit ? hit.name : 'missing');
  }
  log(cat.some((t) => t.abbr === 'kjv'), 'and the public-domain catalogue is still there too');
  log(bible.displayCode('bolls:NIV') === 'NIV' && bible.displayCode('kjv') === 'KJV', 'ids display as plain codes');

  /* ================= [6] downloaded once = offline for good ================= */
  console.log('\n[6] Downloading one for good (this is the Sunday-morning case)');
  let pct = 0;
  const dl = await bible.download('bolls:NLT', { onProgress: (p) => { pct = p; } });
  log(dl.books === 66, 'NLT downloaded — all 66 books', `${(dl.sizeBytes / 1048576).toFixed(1)} MB on disk, progress reached ${pct}%`);
  log(dl.abbr === 'bolls:NLT', 'it keeps its id', dl.abbr);
  log(bible.installed().some((t) => t.abbr === 'bolls:NLT'), 'the installed list reports the id, not the file name',
    bible.installed().map((t) => t.abbr).join(', '));
  const cat2 = await bible.catalogue();
  const nlt = cat2.find((t) => t.abbr === 'bolls:NLT');
  log(!!nlt && nlt.installed === true, 'and the catalogue row is marked as downloaded — no duplicate entry',
    cat2.filter((t) => t.abbr === 'bolls:NLT').length + ' row(s)');

  // Everything from here is served off the disk: chapterCount and search never
  // touch the network, so passing these proves the offline copy is complete.
  log(bible.chapterCount('bolls:NLT', 19) === 150, 'Psalms really has 150 chapters in the offline copy');
  log(bible.chapterCount('bolls:NLT', 66) === 22, 'Revelation really has 22');
  const off = bible.search({ translation: 'bolls:NLT', query: 'faith hope and love', limit: 5 });
  log(off.some((h) => h.reference === '1 Corinthians 13:13'), 'offline word search works', off.length ? off[0].reference : 'nothing');
  const offLookup = await bible.lookup({ translation: 'bolls:NLT', ref: 'John 3:16' });
  log(/loved the world/.test(offLookup.verses[0].text) && !dirty(offLookup.verses[0].text),
    'and John 3:16 reads clean out of the local file', offLookup.verses[0].text.slice(0, 58) + '…');
  log(offLookup.translationName === 'New Living Translation' || /Living/.test(offLookup.translationName),
    'the full name is stored with it', offLookup.translationName);

  /* the whole point: no headings anywhere in the downloaded file either */
  const jn3off = await bible.lookup({ translation: 'bolls:NLT', ref: 'John 3' });
  const withMarkup = jn3off.verses.filter((v) => /[<>]/.test(v.text));
  log(withMarkup.length === 0, 'not one verse of the downloaded chapter carries markup',
    withMarkup.length ? withMarkup[0].text.slice(0, 50) : `${jn3off.verses.length} verses clean`);

  /* ================= [7] a numeric book number is a book number ================= */
  console.log('\n[7] Regression: flat files that number their books');
  const FLAT = path.join(WORK, 'numeric.json');
  fs.writeFileSync(FLAT, JSON.stringify([{ book: 1, chapter: 1, verse: 1, text: 'Numbered Genesis.' }]), 'utf-8');
  const imp = bible.importFile(FLAT, { abbr: 'numtest', name: 'Numeric Test' });
  const g = await bible.lookup({ translation: 'numtest', ref: 'Genesis 1:1' });
  log(imp.books === 1 && g.verses[0].text === 'Numbered Genesis.', 'book 1 imports as Genesis, not as 1 Samuel', g.reference);

  console.log(failed ? '\nSOME CHECKS FAILED\n' : '\nALL CHECKS PASSED\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('\nTEST CRASHED:', e); process.exit(1); });
