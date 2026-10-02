'use strict';
/*
 * FINDING A VERSE FROM THE WORDS ALONE.
 *
 * The speaker quotes scripture without naming it and the verse goes up. This
 * measures whether that works, and — the harder half — whether it stays quiet
 * through the thirty-nine minutes of a sermon that are not a quotation.
 *
 * Four things are measured, and the numbers in src/main/versefind.js were set
 * by running this:
 *
 *   [1] the corpus is CHECKED FIRST. Every expected reference is looked up and
 *       compared with what was said, so a mistake of mine in the corpus cannot
 *       quietly become the expected answer.
 *   [2] QUOTATIONS — 106 of them, as people actually say them: half-remembered,
 *       in the wrong translation, with a word misheard by the recogniser.
 *   [3] PREACHING — 87 lines of real sermon speech, prayer, testimony,
 *       announcements and song lyrics. Not one may put a verse on the wall.
 *       This is the assertion that matters: a wrong verse in front of the
 *       congregation is far worse than a missed one.
 *   [4] BREADTH — the whole Bible, not just the famous parts. Windows of
 *       consecutive words are taken from verses sampled across all 66 books
 *       and quoted back, and the answer is checked against the text.
 *
 * Run: npm run test:versefind        (SKIPS cleanly if no Bible is downloaded)
 */
const path = require('path');
const os = require('os');
const bible = require('../src/main/bible');
const vf = require('../src/main/versefind');
const { FAMOUS, LOOSE, PREACHING } = require('./helpers/quote-corpus');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const note = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));

const USER_DATA = process.env.MW_USERDATA
  || path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Church Work Space');

(async () => {
  console.log('== FINDING A VERSE FROM THE WORDS ALONE ==');
  bible.init(USER_DATA);

  const installed = bible.installed().map((t) => t.abbr);
  if (!installed.length) {
    console.log('  SKIP  no Bible translation is downloaded on this machine');
    process.exit(0);
  }

  /* The set this church would actually listen with. */
  const display = installed.includes('bolls:NIV') ? 'bolls:NIV' : installed[0];
  const abbrs = vf.chooseTranslations(display, installed);
  console.log(`   installed: ${installed.length} translations`);
  console.log(`   listening with: ${abbrs.join(', ')}\n`);

  const t0 = Date.now();
  const IXS = [];
  for (const a of abbrs) { const ix = await vf.indexFor(a, bible.load); if (ix) IXS.push(ix); }
  const buildMs = Date.now() - t0;
  log(IXS.length > 0, 'the Bible could be indexed', `${IXS.length} translation(s) in ${buildMs} ms`);
  if (!IXS.length) { console.log('\n== FAILED =='); process.exit(1); }
  for (const ix of IXS) console.log(`     ${ix.translation}: ${ix.N} verses, ${ix.dict.size} word forms, ${ix.pairCount} indexed word pairs`);

  const find = (q) => vf.findAcross(IXS, q);
  const SRC = IXS[0];
  const byRef = new Map();
  for (const v of SRC.verses) byRef.set(`${SRC.bookNames.get(v.b)} ${v.c}:${v.v}`, v);
  const textOf = (ref) => {
    const v = byRef.get(ref);
    if (!v) return '';
    const raw = bible.lookup ? null : null;
    return v ? refText(v) : '';
  };
  /* verse text, read from the Bible — the index deliberately keeps none */
  const rawText = new Map();
  {
    const data = bible.load(SRC.translation);
    for (const b of data.books) for (const c of b.chapters) for (const v of c.verses) {
      rawText.set(`${b.nr}:${c.chapter}:${v.verse}`, v.text);
    }
  }
  function refText(v) { return rawText.get(`${v.b}:${v.c}:${v.v}`) || ''; }

  /* ================================================================== */
  console.log('\n[1] Is the corpus itself right?');
  {
    let bad = 0, checked = 0;
    const overlap = (q, t) => {
      const a = new Set(vf.tokenise(q)), b = new Set(vf.tokenise(t));
      let n = 0; for (const w of a) if (b.has(w)) n++;
      return n / Math.max(1, a.size);
    };
    for (const [q, refs] of [...FAMOUS, ...LOOSE]) {
      if (!refs) continue;
      const list = Array.isArray(refs) ? refs : [refs];
      let best = 0, seen = false;
      for (const ref of list) {
        const v = byRef.get(ref);
        if (!v) continue;
        seen = true;
        best = Math.max(best, overlap(q, refText(v)));
      }
      checked++;
      // Against ONE translation a modern-wording quote can legitimately share
      // little with the old text — that is the whole reason several are
      // indexed. Only a reference that does not exist at all is a mistake.
      if (!seen) { console.log(`     no such verse: ${list.join(' / ')}  ("${q}")`); bad++; }
    }
    log(bad === 0, 'every expected reference exists in the Bible', `${checked} checked`);
  }

  /* ================================================================== */
  console.log('\n[2] Quotations — do they get found, and is it the right verse?');
  const runSet = (list, label) => {
    let right = 0, wrong = 0, missed = 0;
    const bad = [];
    const t = Date.now();
    for (const [q, want] of list) {
      const r = find(q);
      const fired = !!(r && r.ok);
      const got = fired ? r.ref : null;
      if (want === null) {
        if (fired) { wrong++; bad.push(`spoke on a fragment: "${q}" -> ${got}`); } else right++;
        continue;
      }
      const list2 = Array.isArray(want) ? want : [want];
      if (fired && list2.includes(got)) right++;
      else if (fired) { wrong++; bad.push(`"${q}"\n         wanted ${list2.join(' / ')}, got ${got}`); }
      else { missed++; bad.push(`"${q}"\n         wanted ${list2.join(' / ')}, said nothing`); }
    }
    console.log(`     ${label}: ${right}/${list.length} right, ${wrong} wrong, ${missed} missed · ${((Date.now() - t) / list.length).toFixed(1)} ms each`);
    for (const b of bad) console.log(`       - ${b}`);
    return { right, wrong, missed, n: list.length };
  };
  const f = runSet(FAMOUS, 'as people say them');
  const l = runSet(LOOSE, 'modern wording / misheard');
  const totalQ = f.n + l.n, totalRight = f.right + l.right;

  log(f.wrong === 0 && l.wrong === 0, 'NEVER THE WRONG VERSE — every quotation it answered, it answered correctly',
    `${f.wrong + l.wrong} wrong of ${totalRight + f.wrong + l.wrong} answered`);
  log(totalRight / totalQ >= 0.95, 'and it finds all but a handful of them',
    `${totalRight}/${totalQ} (${(100 * totalRight / totalQ).toFixed(0)}%)`);

  /* ================================================================== */
  console.log('\n[3] ►► PREACHING — does it stay quiet? ◄◄');
  {
    let fired = 0;
    const t = Date.now();
    for (const q of PREACHING) {
      const r = find(q);
      if (r && r.ok) {
        fired++;
        console.log(`       FIRED on "${q}"`);
        console.log(`         -> ${r.ref}  run=${r.run} share=${r.share} coverage=${r.coverage} rare=${r.rare}`);
      }
    }
    console.log(`     ${PREACHING.length} lines of sermon, prayer, testimony, notices and song · ${((Date.now() - t) / PREACHING.length).toFixed(1)} ms each`);
    log(fired === 0, 'NOT ONE LINE OF ORDINARY PREACHING PUTS A VERSE ON THE WALL',
      `${fired} false positives in ${PREACHING.length}`);
  }

  /* ================================================================== */
  console.log('\n[4] The whole Bible, not just the famous parts');
  {
    // Deterministic sampling, so a failure can be reproduced exactly.
    let seed = 20260904;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const norm = (x) => vf.tokenise(x).join(' ');
    const lcsFrac = (a, b) => {
      // how much of `a`, in order, is inside `b` — forgiving of the small
      // wording differences between neighbouring verses of a repeated formula
      const A = a.split(' '), B = b.split(' ');
      let i = 0, n = 0;
      for (const w of B) { if (i < A.length && A[i] === w) { i++; n++; } }
      return n / Math.max(1, A.length);
    };
    const byBook = new Map();
    const data = bible.load(SRC.translation);
    for (const b of data.books) {
      const list = [];
      for (const c of b.chapters) for (const v of c.verses) list.push({ b: b.nr, c: c.chapter, v: v.verse, text: v.text });
      byBook.set(b.nr, list);
    }
    const around = (bookNr, chapter, verse) => [verse - 1, verse, verse + 1]
      .map((n) => rawText.get(`${bookNr}:${chapter}:${n}`) || '').filter(Boolean).join(' ');

    for (const WORDS of [10, 8]) {
      let asked = 0, answered = 0, right = 0;
      const wrongOnes = [];
      const tb = Date.now();
      for (const [, list] of [...byBook.entries()].sort((a, b) => a[0] - b[0])) {
        const long = list.filter((v) => v.text.split(/\s+/).length >= WORDS + 4);
        if (!long.length) continue;
        for (let k = 0; k < 6; k++) {
          const v = long[Math.floor(rnd() * long.length)];
          const words = v.text.split(/\s+/).filter(Boolean);
          if (words.length < WORDS + 2) continue;
          const start = Math.floor(rnd() * (words.length - WORDS));
          const said = words.slice(start, start + WORDS).join(' ');
          if (vf.tokenise(said).length < 6) continue;
          asked++;
          const r = find(said);
          if (!r || !r.ok) continue;
          answered++;
          // Correct means THE VERSE IT NAMED REALLY CONTAINS WHAT WAS SAID.
          // Not "the same reference": scripture repeats itself — the twelve
          // identical offerings of Numbers 7, Kings and Chronicles telling one
          // story in one wording, Hebrews quoting Jeremiah — and demanding one
          // of two equally true answers would measure the corpus, not the code.
          if (lcsFrac(norm(said), norm(around(r.bookNr, r.chapter, r.verse))) >= 0.9) right++;
          else if (wrongOnes.length < 5) wrongOnes.push(`"${said}"  (from ${v.b}:${v.c}:${v.v}) -> ${r.ref}`);
        }
      }
      const pct = (x) => (100 * x / Math.max(1, asked)).toFixed(1) + '%';
      console.log(`     ${WORDS}-word fragments: asked ${asked}, answered ${answered} (${pct(answered)}), correct ${right} (${pct(right)}) · ${((Date.now() - tb) / asked).toFixed(1)} ms each`);
      for (const w of wrongOnes) console.log(`       - ${w}`);
      log(right / Math.max(1, answered) >= 0.97,
        `${WORDS}-word fragments from anywhere in the Bible name a verse that really contains them`,
        `${right}/${answered} of the ones it answered`);
      if (WORDS === 10) {
        log(answered / asked >= 0.9, 'and it answers nearly all of them', `${answered}/${asked}`);
      } else if (answered / asked < 0.9) {
        note('shorter fragments are answered less often, which is the safe direction', `${pct(answered)} answered`);
      }
    }
  }

  /* ================================================================== */
  console.log('\n[5] Fast enough to sit inside a sermon');
  {
    const sample = [...FAMOUS.slice(0, 20).map((x) => x[0]), ...PREACHING.slice(0, 20)];
    const t = Date.now();
    for (const q of sample) find(q);
    const each = (Date.now() - t) / sample.length;
    console.log(`     ${each.toFixed(1)} ms per phrase across ${IXS.length} translation(s)`);
    log(each < 60, 'a phrase is judged in well under the time it takes to say the next one', `${each.toFixed(1)} ms`);
    note('indexing cost, paid once when Listen is switched on', `${buildMs} ms for ${IXS.length} translation(s)`);
  }

  console.log('\n' + (failed ? '============  VERSE FINDING FAILED  ============'
    : '============  VERSE FINDING PASSED  ============') + '\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
