'use strict';
/*
 * "GIVE, AND IT SHALL BE GIVEN UNTO YOU" -> Luke 6:38.
 *
 * The speaker QUOTES scripture without naming it, and the verse goes up. No
 * book, no chapter, no verse number — just the words, half-remembered, in
 * whatever translation they learned them in, through a speech recogniser that
 * mishears one word in ten.
 *
 * This is a different problem from voiceref.js. That one reads an instruction
 * ("John chapter three verse sixteen") and the hard part is refusing to act on
 * ordinary speech. Here the hard part is the same — a sermon is forty minutes
 * of continuous talking and almost none of it is a quotation — but the signal
 * is much weaker: there is no keyword to key on, only the shape of the words.
 *
 * ============================ HOW IT DECIDES =============================
 *
 * Everything below exists to serve one rule: a WRONG verse on the wall
 * mid-sermon is far worse than a missed one. The congregation is reading that
 * screen. So the question is never "which verse is closest to what they said"
 * — there is always a closest verse — it is "did they QUOTE, and if so what".
 *
 * Three ideas do the work:
 *
 * 1. RARITY, NOT OVERLAP. Every ordinary sentence shares words with scripture:
 *    "and it shall be", "I say to you", "the Lord our God". Matching on shared
 *    words alone fires on everything. So each word carries its inverse document
 *    frequency across the whole Bible — `the` is worth nothing, `shepherd` a
 *    great deal — and a match is judged on the WEIGHT it carries, not its
 *    length.
 *
 * 2. THE RUN, NOT THE BAG. Quoting means saying the words in order. A verse
 *    that happens to contain your six words scattered through it is a
 *    coincidence; one that contains them consecutively is the thing you were
 *    quoting. The deciding number is the heaviest CONTIGUOUS run shared with a
 *    verse, in rarity, and it is what separates "give and it shall be given
 *    unto you" from a sentence that merely mentions giving.
 *
 * 3. IT MAY SAY NOTHING. Every threshold below was set by running two corpora
 *    — real quotations that must be found, and real preaching that must not
 *    fire — and moving the bar until the preaching corpus was silent. See
 *    test/verse-find.test.js; the numbers there are the specification.
 *
 * ======================== ACROSS TRANSLATIONS ============================
 *
 * People quote the Bible they memorised, which is usually the King James, and
 * put it on the screen in the one the church reads, which usually is not. So
 * the words are normalised toward a common form before anything is compared:
 * thee/thou/ye -> you, shall -> will, unto -> to, -eth and -est endings
 * stripped. "Give, and it shall be given unto you" and "Give, and it will be
 * given to you" then differ by nothing that matters.
 *
 * The index can also be built over SEVERAL installed translations at once and
 * the answer given as a reference, which is translation-free: match on the
 * King James wording, display in the New International. That is the setup this
 * was designed for and it is what `indexes()` returns.
 */

const STOPWORD_DF = 0.06;   // a word in more than 6% of verses carries no weight
const STOPPAIR_DF = 0.01;   // …and a PAIR of words in more than 1%

/* ================== WHY THERE IS A SECOND, PAIRED INDEX =================
 *
 * "Give, and it shall be given unto you" contains exactly one word that is not
 * grammar, and it is `give`. Look it up and 1820 verses come back, all tied,
 * all equally plausible on a word count — and the right one is not in the top
 * forty by any measure a bag of words can compute. Luke 6:38 was missed for
 * precisely that reason, and it is not an unusual verse: a great many of the
 * lines people quote from memory are made almost entirely of common words.
 * "Be still and know that I am God." "Let not your heart be troubled."
 *
 * What makes those lines findable is not their vocabulary, it is their ORDER.
 * `give` is in a tenth of the Bible; `be give` — "be given" — is in a handful
 * of verses, and `give to you` in fewer still. So consecutive PAIRS are
 * indexed alongside single words, with their own rarity, and a verse is
 * shortlisted on both. Order stops being something checked at the end and
 * becomes something searched on.
 */

/* Irregulars that a suffix stripper cannot reach, and which are exactly the
 * words that differ between an old translation and a modern one. */
const ARCHAIC = {
  thee: 'you', thou: 'you', thy: 'your', thine: 'your', ye: 'you', yourselves: 'you',
  thyself: 'yourself', ourself: 'ourselves',
  hath: 'have', hast: 'have', has: 'have', had: 'have', having: 'have',
  doth: 'do', dost: 'do', does: 'do', did: 'do', doeth: 'do',
  saith: 'say', said: 'say', says: 'say', sayeth: 'say', spake: 'speak', spoke: 'speak',
  spoken: 'speak', speaketh: 'speak',
  shall: 'will', shalt: 'will', wilt: 'will', would: 'will', should: 'will',
  unto: 'to', upon: 'on', into: 'in',
  art: 'be', am: 'be', is: 'be', are: 'be', was: 'be', were: 'be', wast: 'be', wert: 'be',
  been: 'be', being: 'be',
  cometh: 'come', came: 'come', comes: 'come', coming: 'come',
  goeth: 'go', went: 'go', goes: 'go', going: 'go', gone: 'go',
  giveth: 'give', gave: 'give', given: 'give', gives: 'give', giving: 'give',
  maketh: 'make', made: 'make', makes: 'make', making: 'make',
  taketh: 'take', took: 'take', taken: 'take', takes: 'take',
  knoweth: 'know', knew: 'know', known: 'know', knows: 'know', knowing: 'know',
  seeth: 'see', saw: 'see', seen: 'see', sees: 'see', seeing: 'see',
  heareth: 'hear', heard: 'hear', hears: 'hear', hearing: 'hear',
  believeth: 'believe', believed: 'believe', believes: 'believe',
  loveth: 'love', loved: 'love', loves: 'love', loving: 'love',
  bringeth: 'bring', brought: 'bring', brings: 'bring',
  shew: 'show', shewed: 'show', sheweth: 'show', showed: 'show', shown: 'show',
  begotten: 'beget', begat: 'beget',
  lord: 'lord', god: 'god',
  children: 'child', men: 'man', women: 'woman', brethren: 'brother', brothers: 'brother',
  feet: 'foot', teeth: 'tooth',
};

/**
 * One spoken or written word, reduced to the form both an old translation and
 * a modern one would land on. Deliberately blunt: what matters is that BOTH
 * sides of every comparison go through this identically.
 */
function stem(w) {
  let s = w;
  if (ARCHAIC[s]) return ARCHAIC[s];
  // -eth / -est are the King James verb endings and never anything else here
  if (s.length > 4 && (s.endsWith('eth') || s.endsWith('est'))) s = s.slice(0, -3);
  else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2);
  else if (s.length > 4 && (s.endsWith('ies'))) s = s.slice(0, -3) + 'y';
  else if (s.length > 4 && (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('hes'))) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
  return ARCHAIC[s] || s;
}

/** One number per verse, the same in every translation that numbers it alike. */
const verseKey = (b, c, v) => b * 1e6 + c * 1e3 + v;

/** Text -> the token stream everything else works on. */
function tokenise(text) {
  const out = [];
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/'/g, '');
  for (const w of raw.split(/\s+/)) {
    if (!w) continue;
    out.push(stem(w));
  }
  return out;
}

/* ======================================================================== */

/**
 * An index over one translation. Built once, kept in memory for the service.
 *
 * Verses are held as arrays of integer token ids rather than strings: the
 * inner loop of the run-finder compares tokens tens of thousands of times a
 * phrase, and integer equality is the difference between this being free and
 * being felt.
 */
/*
 * BUILT WITHOUT STOPPING THE APP.
 *
 * A translation takes about a second to index and there are up to five of
 * them, and this runs in the main process — the one that answers every IPC
 * call the studio makes. Five seconds of solid work there is five seconds in
 * which the Presentation studio cannot put a slide on the wall, and it would
 * land exactly when the operator switches Listen on before a service.
 *
 * So every loop breathes: `await tick()` every few thousand verses hands the
 * event loop back, and the longest uninterrupted stretch is a few
 * milliseconds. The whole build still costs its second — it is the same work —
 * but nothing else waits for it.
 */
const tick = () => new Promise((r) => setImmediate(r));
const YIELD_EVERY = 3000;

async function buildIndex(translation, data) {
  const t0 = Date.now();
  const dict = new Map();                 // stem -> id
  const idOf = (s) => {
    let i = dict.get(s);
    if (i === undefined) { i = dict.size; dict.set(s, i); }
    return i;
  };
  /*
   * ►► A FEW LARGE ARRAYS, NEVER MANY SMALL ONES. ◄◄
   *
   * Every verse's words live in ONE array (`tok`), each verse holding where its
   * own start and end; the postings are one array plus offsets, like the pairs
   * below. It used to be a typed array per verse and per word — about 40,000 a
   * translation, half a million across twelve — and that is a number Electron
   * cannot let go of: tearing down a worker thread that holds N small typed
   * arrays costs time that grows far faster than N (measured: 50,000 took 18.7
   * seconds, 100,000 over 100; plain Node, a tenth of a second). So quitting
   * the app after 🎤 Listen had found a quotation left an invisible process
   * burning a core for the best part of half an hour, and the test suites
   * never exited. Now a translation is a dozen arrays and goes in milliseconds.
   */
  const verses = [];                      // { b, c, v, from, to } — its words are tok[from..to)
  const bookNames = new Map();
  let tokList = [];

  let sinceTick = 0;
  for (const b of (data.books || [])) {
    // The 66 books only. A King James "with Apocrypha" carries fourteen more,
    // and a match in Tobit would name a book the church's own Bible — the one
    // on the wall — does not have.
    if (b.nr > 66) continue;
    bookNames.set(b.nr, b.name);
    for (const c of (b.chapters || [])) {
      for (const v of (c.verses || [])) {
        const toks = tokenise(v.text);
        if (!toks.length) continue;
        const from = tokList.length;
        for (let i = 0; i < toks.length; i++) tokList.push(idOf(toks[i]));
        verses.push({ b: b.nr, c: c.chapter, v: v.verse, from, to: tokList.length });
        if (++sinceTick >= YIELD_EVERY) { sinceTick = 0; await tick(); }
      }
    }
  }
  // Verses are stored in order, so a verse and the one after it are one run of
  // `tok` — which is how judge() reads a quotation across a verse boundary.
  const tok = Int32Array.from(tokList);
  tokList = null;

  const N = verses.length;
  const df = new Int32Array(dict.size);
  const seen = new Int32Array(dict.size).fill(-1);
  for (let vi = 0; vi < N; vi++) {
    const { from, to } = verses[vi];
    for (let i = from; i < to; i++) {
      const id = tok[i];
      if (seen[id] === vi) continue;
      seen[id] = vi;
      df[id]++;
    }
    if (vi % YIELD_EVERY === YIELD_EVERY - 1) await tick();
  }
  // idf, and the postings list for every token worth looking up. A token in
  // more than STOPWORD_DF of the Bible is not a clue, it is grammar, so it
  // gets no postings list at all — which is also what keeps a lookup fast.
  const idf = new Float32Array(dict.size);
  for (let i = 0; i < dict.size; i++) idf[i] = Math.log(N / Math.max(1, df[i]));
  /*
   * WHAT A WORD THAT IS NOT IN THE BIBLE AT ALL IS WORTH.
   *
   * It used to be worth nothing, and that was a hole straight through the
   * middle of the whole idea. SHARE asks "how much of what they just said is
   * this verse", and a word with no weight is not part of what they said — so
   * on a real sermon "Primarily the emergency product of the Holy Ghost and
   * the…" measured as 95% one run out of Acts 6:3 and went on the wall.
   * `primarily` and `emergency` appear nowhere in scripture, which is the
   * plainest possible evidence that this is not a quotation of it, and the
   * matcher could not see them.
   *
   * So an unknown word weighs the MEDIAN of the vocabulary. Not the maximum:
   * whisper mishears about one word in ten, and a misheard word is unknown
   * too, so pricing them at the maximum would let a single slip silence a real
   * quotation. The median makes an unfamiliar word count exactly as much as an
   * ordinary one — present in the denominator, impossible in any run.
   */
  const sorted = Array.from(idf).sort((a, b) => a - b);
  const oovIdf = sorted.length ? sorted[sorted.length >> 1] : 1;
  const cap = Math.max(50, Math.floor(N * STOPWORD_DF));
  const counts = new Int32Array(dict.size);
  for (let vi = 0; vi < N; vi++) {
    const { from, to } = verses[vi];
    for (let i = from; i < to; i++) {
      const id = tok[i];
      if (seen[id] === -2 - vi) continue;
      seen[id] = -2 - vi;
      if (df[id] <= cap) counts[id]++;
    }
    if (vi % YIELD_EVERY === YIELD_EVERY - 1) await tick();
  }
  // Word postings, flat: the verses holding word `id` are pdata[poff[id]..poff[id+1]).
  // An empty range is a word too common to be a clue.
  const poff = new Int32Array(dict.size + 1);
  for (let i = 0; i < dict.size; i++) poff[i + 1] = poff[i] + counts[i];
  const pdata = new Int32Array(poff[dict.size]);
  const fill = new Int32Array(dict.size);
  seen.fill(-1);
  for (let vi = 0; vi < N; vi++) {
    const { from, to } = verses[vi];
    for (let i = from; i < to; i++) {
      const id = tok[i];
      if (seen[id] === vi) continue;
      seen[id] = vi;
      if (counts[id]) pdata[poff[id] + fill[id]++] = vi;
    }
    if (vi % YIELD_EVERY === YIELD_EVERY - 1) await tick();
  }

  /* ---- the paired index: the same idea, over consecutive tokens ---- */
  const D = dict.size;
  const key = (a, b) => a * D + b;
  /*
   * DOCUMENT frequency: how many VERSES a pair appears in, not how many times.
   *
   * Counting occurrences instead (a pair that appears twice in one verse
   * counted twice) over-sizes the postings array, and the slots left unfilled
   * stay ZERO — which is a perfectly valid verse index. Every such array then
   * silently votes for verse 0, and Genesis 1:1 wins nearly every lookup with
   * an enormous score and no matching words at all. It looks exactly like a
   * ranking bug and it is an off-by-a-duplicate in the index.
   */
  const bdf = new Map();
  for (let vi = 0; vi < N; vi++) {
    const { from, to } = verses[vi];
    const here = new Set();
    for (let i = from + 1; i < to; i++) {
      const k = key(tok[i - 1], tok[i]);
      if (here.has(k)) continue;
      here.add(k);
      bdf.set(k, (bdf.get(k) || 0) + 1);
    }
    if (vi % YIELD_EVERY === YIELD_EVERY - 1) await tick();
  }
  /*
   * THE PAIR POSTINGS ARE THE BULK OF THIS INDEX, so they are held flat.
   *
   * A Map of 130,000 keys to 130,000 small typed arrays costs about 25 MB in
   * object headers alone, before a single verse number is stored — and there
   * has to be room for several translations at once, because which one gets
   * indexed is the single biggest thing deciding whether a quotation is found
   * at all. Sorted keys plus one offsets array plus one data array holds the
   * same information in three allocations, and a binary search reaches it in
   * a dozen comparisons.
   */
  const bcap = Math.max(20, Math.floor(N * STOPPAIR_DF));
  const keep = [];
  for (const [k, d] of bdf) if (d <= bcap) keep.push(k);   // "and the" is grammar
  keep.sort((a, b) => a - b);
  const bkeys = new Float64Array(keep.length);             // keys exceed 2^31
  const boff = new Int32Array(keep.length + 1);
  const bidfArr = new Float32Array(keep.length);
  const slot = new Map();
  for (let i = 0; i < keep.length; i++) {
    const k = keep[i];
    bkeys[i] = k;
    slot.set(k, i);
    const d = bdf.get(k);
    boff[i + 1] = boff[i] + d;
    bidfArr[i] = Math.log(N / d);
  }
  const bdata = new Int32Array(boff[keep.length]);
  const bfill = new Int32Array(keep.length);
  for (let vi = 0; vi < N; vi++) {
    const { from, to } = verses[vi];
    const seenPairs = new Set();
    for (let i = from + 1; i < to; i++) {
      const k = key(tok[i - 1], tok[i]);
      if (seenPairs.has(k)) continue;
      seenPairs.add(k);
      const si = slot.get(k);
      if (si === undefined) continue;
      // A postings run that overflows its slot would spill into the NEXT
      // pair's, which is silent and wrong — see the document-frequency note
      // above, where the mirror of this bug elected Genesis 1:1 every time.
      if (bfill[si] < boff[si + 1] - boff[si]) bdata[boff[si] + bfill[si]++] = vi;
    }
    if (vi % YIELD_EVERY === YIELD_EVERY - 1) await tick();
  }
  slot.clear();
  /** Where a pair's verse list lives, or -1. Binary search over sorted keys. */
  const bfind = (k) => {
    let lo = 0, hi = bkeys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = bkeys[mid];
      if (v === k) return mid;
      if (v < k) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };

  return {
    translation, dict, verses, tok, df, idf, oovIdf, poff, pdata, N, cap,
    bkeys, boff, bdata, bidf: bidfArr, bfill, bfind, bcap, pairKey: key,
    pairCount: bkeys.length,
    bookNames,
    buildMs: Date.now() - t0,
    idFor: (s) => dict.get(s),
  };
}

/* ------------------------------------------------------------------ */

/**
 * The heaviest CONTIGUOUS run of query tokens that also appears, in order, in
 * this verse — measured in rarity, not in words.
 *
 * This is the number the whole feature turns on, so it is worth being precise
 * about what it means. A run of "and it shall be" is four words and weighs
 * almost nothing, because all four appear in thousands of verses. A run of
 * "give and it shall be given" is six words and weighs a great deal, because
 * two of them are `give`. Judging by LENGTH fires on grammar; judging by
 * WEIGHT fires on quotation.
 *
 * ONE MISHEARD WORD IS FORGIVEN inside a run (`skips`), because whisper
 * reliably drops or mangles about one word in ten and an unforgiving run
 * breaks a genuine seven-word quotation into two threes. A skip carries no
 * weight of its own, so forgiveness cannot manufacture a match.
 */
/*
 * The dp rows are reused across calls rather than allocated for each one: a
 * window is judged against sixty candidates in each of a dozen translations,
 * and eight fresh typed arrays per candidate was most of the cost.
 */
let RB = null;
function runBuffers(m) {
  if (!RB || RB.size < m + 1) {
    const size = Math.max(m + 1, 256);
    RB = { size,
      prev: new Float64Array(size), cur: new Float64Array(size),
      prevLen: new Int32Array(size), curLen: new Int32Array(size),
      prevSkip: new Int32Array(size), curSkip: new Int32Array(size),
      prevStartQ: new Int32Array(size), startQ: new Int32Array(size) };
  }
  return RB;
}
function bestRun(q, verseToks, idf) {
  const n = q.length, m = verseToks.length;
  if (!n || !m) return { weight: 0, len: 0, at: -1, startQ: -1, endQ: -1 };
  const B = runBuffers(m);
  let prev = B.prev, cur = B.cur, prevLen = B.prevLen, curLen = B.curLen;
  let prevSkip = B.prevSkip, curSkip = B.curSkip, prevStartQ = B.prevStartQ, startQ = B.startQ;
  prev.fill(0, 0, m + 1); prevLen.fill(0, 0, m + 1); prevSkip.fill(0, 0, m + 1); prevStartQ.fill(-1, 0, m + 1);
  let bw = 0, bl = 0, bat = -1, bestStartQ = -1, bestEndQ = -1;
  for (let i = 0; i < n; i++) {
    cur.fill(0, 0, m + 1); curLen.fill(0, 0, m + 1); curSkip.fill(0, 0, m + 1); startQ.fill(-1, 0, m + 1);
    const qi = q[i];
    for (let j = 0; j < m; j++) {
      if (qi === verseToks[j]) {
        const w = idf[qi] || 0;
        const pw = j > 0 ? prev[j - 1] : 0;
        const pl = j > 0 ? prevLen[j - 1] : 0;
        const ps = j > 0 ? prevSkip[j - 1] : 0;
        const psq = j > 0 ? prevStartQ[j - 1] : -1;
        cur[j] = pw + w;
        curLen[j] = pl + 1;
        curSkip[j] = ps;
        startQ[j] = pl > 0 && psq >= 0 ? psq : i;
        if (cur[j] > bw) { bw = cur[j]; bl = curLen[j]; bat = j; bestStartQ = startQ[j]; bestEndQ = i; }
      } else if (j > 0 && prevLen[j - 1] > 0 && prevSkip[j - 1] < 1) {
        // one word misheard or reworded: carry the run, take no credit for it
        cur[j] = prev[j - 1];
        curLen[j] = prevLen[j - 1] + 1;
        curSkip[j] = prevSkip[j - 1] + 1;
        startQ[j] = prevStartQ[j - 1];
      }
    }
    let t;
    t = prev; prev = cur; cur = t;
    t = prevLen; prevLen = curLen; curLen = t;
    t = prevSkip; prevSkip = curSkip; curSkip = t;
    t = prevStartQ; prevStartQ = startQ; startQ = t;
  }
  return { weight: bw, len: bl, at: bat, startQ: bestStartQ, endQ: bestEndQ };
}

/** The total rarity of everything the speaker said — the denominator for
 *  "how much of that sentence WAS the verse". */
function totalWeight(qIdf) {
  let t = 0;
  for (let i = 0; i < qIdf.length; i++) if (qIdf[i] > 0) t += qIdf[i];
  return t;
}

/** How much of the query's WEIGHT this verse carries at all, in any order. */
function coverage(qIds, qIdf, verseSet) {
  let have = 0, total = 0;
  for (let i = 0; i < qIds.length; i++) {
    const w = qIdf[i];
    if (w <= 0) continue;
    total += w;
    if (verseSet.has(qIds[i])) have += w;
  }
  return total > 0 ? have / total : 0;
}

/* ======================================================================== */

/* ===================== WHAT COUNTS AS QUOTING ============================
 *
 * The number that decides it is SHARE: of everything the speaker just said,
 * weighted by rarity, how much of it is one uninterrupted run out of a single
 * verse. It is the closest thing to asking "were they reading?".
 *
 * It is a better question than the two obvious ones, and the corpus shows why:
 *
 *  - "how many words matched" fires on grammar. Every sentence in English
 *    shares four consecutive words with some verse somewhere.
 *  - "what fraction of the SENTENCE was the run" punishes the commonest
 *    preaching pattern there is — "you have got to understand that faith
 *    without works is dead" is a real quotation with six words of throat-
 *    clearing in front of it, and the run is only half the sentence. But
 *    those six words are all grammar and carry almost no rarity, so by SHARE
 *    the quotation is nearly all of it.
 *
 * Meanwhile an allusion — "I am telling you today that your latter days will
 * be greater" — spreads its rare words (telling, today, latter, days, greater)
 * across the sentence, and only some of them fall inside the run. Its share is
 * low, and it stays off the wall. That distinction is the whole rule.
 *
 * Every number below was set by moving it until the preaching corpus in
 * test/verse-find.test.js went quiet and the quotation corpus stayed found.
 * They are a specification, not a preference: change one and run the test.
 */
const DEFAULTS = {
  minTokens: 5,          // shorter than this is a phrase, not a quotation
  /*
   * SEVEN WORDS IN A ROW, NOT FIVE — measured, not chosen. Replayed through
   * thirteen hours of this church's own services, the verses that went up
   * WRONGLY were almost all five or six words long (121 of 128): "What's the
   * matter with you?" as Judges 18:23, "I will take care of you" as Genesis
   * 45:11, "Lift your hands to heaven" as Exodus 10:21. The real quotations
   * were almost all seven or more. Seven took the wrong ones from 122 to 6
   * and cost almost none of the right ones.
   */
  minRunLen: 7,          // …said consecutively
  /*
   * …EXCEPT A SHORT QUOTATION THAT IS MOST OF ITS VERSE. "The Lord is my
   * shepherd" is five words and more than half of Psalm 23:1; "What's the
   * matter with you" is five words and a quarter of Judges 18:23. A short
   * run is a quotation when it IS the verse, and a coincidence when it is a
   * scrap of a long one.
   */
  shortRun: 5, shortVerseShare: 0.5,
  minRunWeight: 10,      // …carrying real rarity, not grammar
  /*
   * How much of what they said must be the verse. 0.62 was set on made-up
   * sentences; on real preaching a quotation arrives wrapped in the preacher's
   * own words ("See, the Bible says… and that is why…") and 0.4 found more
   * of them with no more wrong ones.
   */
  minShare: 0.4,         // …and being most of the rarity of what they said
  /*
   * A STOCK PHRASE IS NOT A QUOTATION. When three or more different verses
   * say the words equally well — "in the name of the Lord Jesus", "and Jesus
   * answered and said unto him", "through the grace of our Lord Jesus Christ"
   * — it is the way the Bible talks and so the way a church talks. Only a long
   * run (a genuine passage, "whosoever shall call upon the name of the Lord
   * shall be saved", said in three places) is let through.
   */
  stockSame: 3, stockRun: 10,
  /*
   * …OR A SHORT QUOTATION THE TRANSLATIONS AGREE ON. "With God all things are
   * possible" is six words and a third of Matthew 19:26, so neither rule above
   * lets it through, and it is one of the most quoted lines there is. What
   * separates it from "Let me tell you the truth" (six words, Daniel 11:2 in
   * the Message and nowhere else) is that ten of the twelve Bibles find
   * Matthew 19:26 in it, independently, while an everyday sentence lands on a
   * different verse in each Bible, or in only one of them. A famous verse is
   * famous in every translation; a coincidence is a coincidence in one.
   *
   * EACH BIBLE GETS ONE VOTE: the verse it judged best (and that verse's word-
   * for-word twin — Joel 2:28 is Acts 2:17). Counting every verse a Bible
   * merely SHORTLISTED instead was tried first and let "in the middle of the
   * night" up as 1 Kings 3:20: eight Bibles had it somewhere in their sixty
   * candidates, and only three thought it was the answer. And a Bible that
   * names a DIFFERENT verse, or calls the words a stock phrase, is a vote
   * against — "according to the will of God" had seven for Romans 8:27 and
   * four for other places, which is what a stock phrase looks like.
   *
   * Measured on 13.8 hours of this church's services, every verse it would
   * put up read and judged by hand: 18 genuine short quotations ("I will build
   * my church", "in the valley of decision", "have mercy on me, O God", "they
   * turn the world upside down"), and one everyday sentence — "so what else
   * can I do?", which really is Jeremiah 9:7 word for word in most modern
   * Bibles. Counting shortlists instead: 22 genuine and six wrong.
   */
  agreeMin: 7, agreeDissent: 1, agreeWeight: 12,
  minCoverage: 0.5,      // …with the rest of it at least present in the verse
  /*
   * A quotation with NO rare word in it at all has to be perfect.
   *
   * "Give, and it shall be given unto you" contains not one uncommon word, and
   * neither does "the disciples did not understand what he was saying to
   * them". The first is a quotation; the second is a preacher narrating, and
   * it lands on Luke 2:50 with nine words in a row. Nothing in the vocabulary
   * separates them — but the first is the verse ENTIRELY, share and coverage
   * both 1.00, while the second leaves "the disciples" outside at 0.78. So
   * with nothing rare to hang it on, everything they said must be in the
   * verse and in order.
   */
  perfect: 0.90,
  /*
   * …and the middle of that scale. With two or three uncommon words the run
   * has something real to stand on, but not enough to forgive a chunk of the
   * sentence being absent — "the disciples did not understand what he was
   * saying to them" has two, matches nine words of John 10:6 in order, and is
   * a preacher narrating rather than quoting. What gives it away is the
   * "disciples" left outside the verse: coverage 0.78.
   */
  midCoverage: 0.8,
  /*
   * …and the other way round: a quotation that a dropped word has broken into
   * two short runs, but where nearly every uncommon word of the sentence is in
   * that one verse. "For God so loved the world he gave his only son" drops
   * two words and the run halves, yet coverage is 1.00 with five rare words.
   * Density is its own kind of proof.
   */
  denseWeight: 15, denseCoverage: 0.85, denseRare: 4,
  perfectRun: 6,         // a run this long that IS the whole sentence needs no rarity at all
  oov: 1,                // what a word that is in no Bible weighs, as a multiple of the median
  topK: 60,              // candidates reranked in full
};

/*
 * MEASURED (v2.77), on 120 quotations and 104 lines of ordinary preaching,
 * prayer, testimony, announcements and song lyrics (test/verse-find.test.js),
 * against every installed translation:
 *
 *     120/120 quotations found · 0 wrong · 0 false positives
 *
 * …and, the measurement that actually set these numbers, 13.8 hours of this
 * church's own services replayed the way the ear hears them, every verse the
 * finder would put up checked against what was really said. The made-up
 * corpus above had been tuned until it went quiet and it said 0.62; real
 * preaching wraps every quotation in the preacher's own words, and at 0.62
 * fifteen genuine quotations in those services were missed. A missed verse
 * costs the operator one click; a wrong verse goes up in front of the
 * congregation — so every loosening here was paid for, and measured, in
 * wrong verses as well as found ones.
 */

/*
 * THREE STEPS, SO THE EXPENSIVE ONE CAN BE SHARED.
 *
 * A lookup is: turn the words into this index's ids and weights (prepare),
 * shortlist the verses worth a closer look (candidates), and judge that
 * shortlist on order and share (judge). findAcross asks the same window about
 * several SENTENCES of it and across every installed translation, so the parts
 * are kept separate — and the shortlist is gathered in a typed array owned by
 * the index rather than a Map built afresh for every question, which is what
 * makes asking a dozen questions of a window affordable.
 */
function prepare(index, text, o) {
  const toks = Array.isArray(text) ? text : tokenise(text);
  const { dict, idf } = index;
  const qIds = new Int32Array(toks.length);
  const qIdf = new Float64Array(toks.length);
  let known = 0;
  for (let i = 0; i < toks.length; i++) {
    const id = dict.get(toks[i]);
    qIds[i] = id === undefined ? -1 : id;
    // An unrecognised word is not weightless — see oovIdf. It can never be
    // part of a run (it is in no verse), so all it can do is make the sentence
    // heavier, which is exactly what a word the Bible does not contain should do.
    qIdf[i] = id === undefined ? (index.oovIdf || 0) * (o.oov == null ? 1 : o.oov) : idf[id];
    if (id !== undefined) known++;
  }
  return { toks, qIds, qIdf, known };
}

/** Verses sharing a word, or a PAIR of words, worth sharing — best first. */
function candidates(index, q, topK) {
  const { idf, poff, pdata, N } = index;
  if (!index._acc || index._acc.length !== N) { index._acc = new Float64Array(N); index._touched = new Int32Array(N); }
  const acc = index._acc, touched = index._touched;
  let nt = 0;
  const qIds = q.qIds;
  const uniq = new Set();
  for (let i = 0; i < qIds.length; i++) {
    const id = qIds[i];
    if (id < 0 || uniq.has(id)) continue;
    uniq.add(id);
    const pFrom = poff[id], pTo = poff[id + 1];
    if (pFrom === pTo) continue;             // grammar: carries no signal
    const w = idf[id];
    for (let k = pFrom; k < pTo; k++) {
      const vi = pdata[k];
      if (acc[vi] === 0) touched[nt++] = vi;
      acc[vi] += w;
    }
  }
  // …and the pairs, which is what finds a verse made entirely of common words.
  const seenPair = new Set();
  for (let i = 1; i < qIds.length; i++) {
    const a = qIds[i - 1], b = qIds[i];
    if (a < 0 || b < 0) continue;
    const k = index.pairKey(a, b);
    if (seenPair.has(k)) continue;
    seenPair.add(k);
    const si = index.bfind(k);
    if (si < 0) continue;
    const w = index.bidf[si];
    const from = index.boff[si], to = from + index.bfill[si];
    for (let j = from; j < to; j++) {
      const vi = index.bdata[j];
      if (acc[vi] === 0) touched[nt++] = vi;
      acc[vi] += w;
    }
  }
  const out = new Array(nt);
  for (let i = 0; i < nt; i++) { const vi = touched[i]; out[i] = [vi, acc[vi]]; acc[vi] = 0; }
  out.sort((x, y) => y[1] - x[1]);
  return out.length > topK ? out.slice(0, topK) : out;
}

/** The shortlist, judged on order and on how much of what was said it is. */
function judge(index, q, cands, o) {
  const { toks, qIds, qIdf } = q;
  const { idf, verses, df } = index;
  const cand = cands;

  // ---- rerank the shortlist on order, not just overlap ----
  const qTotal = totalWeight(qIdf);
  let best = null, runnerUp = null;
  const allHits = [];
  for (const [vi, bag] of cand) {
    const v = verses[vi];
    /*
     * A VERSE BOUNDARY IS NOT A SENTENCE BOUNDARY, and nobody quoting from
     * memory knows where one is. "The Lord is my shepherd, I shall not want;
     * he maketh me to lie down in green pastures" is two verses, and judged
     * against verse 1 alone it looks like a half-match — coverage 0.44, which
     * is indistinguishable from a coincidence. So each candidate is also
     * measured against ITSELF PLUS THE VERSE AFTER IT, and the better reading
     * wins. The reference given is still the first verse, which is where the
     * passage starts and where the studio should open the chapter.
     */
    const nxt = verses[vi + 1];
    const joined = nxt && nxt.b === v.b && nxt.c === v.c && nxt.v === v.v + 1;
    // Views, not copies: the next verse's words follow this one's in `tok`.
    const one = index.tok.subarray(v.from, v.to);
    const toks = joined ? index.tok.subarray(v.from, nxt.to) : one;
    const runOne = bestRun(qIds, one, idf);
    const runTwo = joined ? bestRun(qIds, toks, idf) : runOne;
    const spans = joined && runTwo.weight > runOne.weight + 0.001;
    const run = spans ? runTwo : runOne;
    const set = new Set(spans ? toks : one);
    const cov = coverage(qIds, qIdf, set);
    // How many genuinely uncommon words of the query this verse has.
    let rare = 0;
    const counted = new Set();
    for (let i = 0; i < qIds.length; i++) {
      const id = qIds[i];
      if (id < 0 || counted.has(id)) continue;
      if (df[id] > index.cap) continue;
      counted.add(id);
      if (set.has(id)) rare++;
    }
    const cardinal = run.weight + bag * 0.15 + cov * 6;
    const hit = { vi, bookNr: v.b, chapter: v.c, verse: v.v,
      run: run.len, runWeight: run.weight, coverage: cov, rare, bag, cardinal,
      spans, share: qTotal > 0 ? run.weight / qTotal : 0,
      // how much of the VERSE the run is — see shortRun in DEFAULTS
      verseShare: run.len / Math.max(1, spans ? toks.length : one.length) };
    if (o._hits) o._hits.push({ vi, bag, run: run.len, startQ: run.startQ, endQ: run.endQ });
    if (!best || cardinal > best.cardinal) { runnerUp = best; best = hit; }
    else if (!runnerUp || cardinal > runnerUp.cardinal) runnerUp = hit;
    allHits.push(hit);
  }
  if (!best) return null;
  /*
   * HOW MANY DIFFERENT VERSES SAY EXACTLY THIS. A quotation is of ONE verse
   * (two, if it is repeated word for word elsewhere — Romans 10:13 and Joel
   * 2:32). A run that three or more different places say equally well is not
   * a quotation of any of them: it is the way the Bible talks, and so the way
   * a church talks — "in the name of the Lord Jesus", "and Jesus answered and
   * said unto him". Those are exactly the seven-word phrases that went up as
   * verses in thirteen hours of this church's services.
   */
  let same = 0;
  const sameAt = [];
  // Within a word of it: "the name of the Lord Jesus. And" runs one word longer
  // into Acts 19:5 than into the four other verses that say the same thing.
  for (const h of allHits) {
    if (h.run < best.run - 1 || h.runWeight < best.runWeight * 0.85) continue;
    same++;
    if (sameAt.length < 4) sameAt.push(verseKey(h.bookNr, h.chapter, h.verse));
  }
  best.sameRun = same;

  /*
   * Two ways to be believed, and a floor under both.
   *
   * The floor is length and weight: fewer than five words in a row, or a run
   * that is all grammar, is never a quotation however well it matches. That
   * alone is what keeps "in the name of Jesus", "the word of God" and "my
   * brothers and sisters" off the wall — each of which matches some verse
   * perfectly, and each of which is said forty times a service.
   */
  /*
   * ...WITH ONE WAY PAST THE WEIGHT FLOOR: THE SENTENCE **IS** THE VERSE.
   *
   * The floor is a rule about rarity, and rarity is the wrong question when
   * somebody has quoted a verse that contains no uncommon word at all. Reported
   * from a real service: "And it shall be given to you." — seven words in a
   * row, every one of them in Matthew 7:7, in order, and NOTHING ELSE SAID. It
   * scored share 1.00 and coverage 1.00 and was refused because those seven
   * common words weigh 9.4 against a floor of 10. To the operator that is the
   * feature saying "I know exactly what this is" and then declining to do it.
   *
   * So a run may buy its way past the weight floor with LENGTH instead, but
   * only when everything the speaker said is in one verse, in order. Length is
   * what separates it from the phrases the floor exists to stop: measured
   * across the whole preaching corpus, exactly one line reaches share and
   * coverage of 1.00 — "in the name of Jesus" — and its run is FIVE. Six is
   * clear of it, and clear of "the word of God", "my brothers and sisters" and
   * every other stock phrase in there, none of which reaches six words that are
   * all one verse and nothing else.
   */
  const isTheVerse = best.run >= o.perfectRun
    && best.share >= o.perfect && best.coverage >= o.perfect;
  const shortOk = o.shortRun != null && best.run >= o.shortRun && best.run < o.minRunLen
    && (best.verseShare || 0) >= o.shortVerseShare && best.runWeight >= o.minRunWeight;
  const enough = (best.run >= o.minRunLen || shortOk) && (best.runWeight >= o.minRunWeight || isTheVerse);
  const stock = o.stockSame != null && (best.sameRun || 1) >= o.stockSame && best.run < o.stockRun;
  /*
   * THE BAR RISES AS THE EVIDENCE THINS.
   *
   * How much of the sentence has to be accounted for depends on how much there
   * was to go on in the first place. Four or more uncommon words is a strong
   * anchor and the ordinary thresholds are enough. Two or three is enough to
   * find a verse but not to be sure of it, so most of the sentence must be in
   * there. With nothing uncommon at all, only a complete match will do.
   *
   * This graduation is what lets several translations be indexed at once. Each
   * one is another chance to be right and another chance to be wrong, and with
   * five of them a flat threshold that was silent on two starts speaking.
   */
  const anchored = best.rare >= o.denseRare ? true
    : best.rare >= 2 ? best.coverage >= o.midCoverage
      : (best.share >= o.perfect && best.coverage >= o.perfect);
  const strong = anchored && best.share >= o.minShare && best.coverage >= o.minCoverage;
  const dense = best.runWeight >= o.denseWeight && best.coverage >= o.denseCoverage
    && best.rare >= o.denseRare;
  const passed = enough && !stock && (strong || dense);
  // Everything but the length: five or six words of a verse that is not most of
  // it. findAcross may still take it, if the other translations agree — see
  // agreeMin in DEFAULTS.
  const needsAgreement = !passed && o.shortRun != null && o.agreeMin != null
    && best.run >= o.shortRun && best.run < o.minRunLen
    && (best.runWeight >= o.minRunWeight || isTheVerse) && !stock && (strong || dense);

  const result = {
    ok: passed,
    bookNr: best.bookNr,
    book: index.bookNames.get(best.bookNr) || '',
    chapter: best.chapter,
    verse: best.verse,
    ref: `${index.bookNames.get(best.bookNr) || ''} ${best.chapter}:${best.verse}`,
    // No text: the index does not keep any. The words to put on the wall are
    // the ones from the translation the CHURCH reads, which is a different
    // book from the one this match may have been made against, and the caller
    // is the only thing that knows which that is.
    translation: index.translation,
    // Everything the decision was made on, so a refusal can be understood
    // rather than guessed at — the log in the studio shows it.
    run: best.run, runWeight: Math.round(best.runWeight * 10) / 10,
    sameRun: best.sameRun || 1,
    verseShare: Math.round((best.verseShare || 0) * 100) / 100,
    share: Math.round(best.share * 100) / 100,
    coverage: Math.round(best.coverage * 100) / 100, rare: best.rare,
    score: Math.round(best.cardinal * 10) / 10,
    // The passage runs past the end of this verse — the studio opens the
    // chapter here, and the words they quoted carry on into the next one.
    spans: !!best.spans,
    /*
     * SAID IN MORE THAN ONE PLACE. "Whosoever shall call upon the name of the
     * Lord shall be saved" is Romans 10:13 AND Acts 2:21 AND Joel 2:32, word
     * for word, and no amount of cleverness can tell which one the preacher
     * had in mind — there is nothing in the sentence to tell it BY. A margin
     * of nothing is not a failure to decide, it is the honest answer that both
     * are right, so the other one is named rather than hidden.
     */
    margin: runnerUp ? Math.round((best.cardinal - runnerUp.cardinal) * 10) / 10 : null,
    alsoAt: runnerUp && Math.abs(best.cardinal - runnerUp.cardinal) < 0.25
      ? `${index.bookNames.get(runnerUp.bookNr) || ''} ${runnerUp.chapter}:${runnerUp.verse}` : null,
    runnerUp: runnerUp ? `${index.bookNames.get(runnerUp.bookNr) || ''} ${runnerUp.chapter}:${runnerUp.verse}` : null,
    tokens: toks.length,
    needsAgreement,
    // The verses that say it equally well (this one included) — the ones this
    // translation votes for when the others are asked. See findAcross.
    sameAt,
  };
  return passed ? result : Object.assign(result, { ok: false });
}

/**
 * Did this line quote scripture, and if so what?
 *
 * Returns null far more often than not, and that is the point.
 */
function findIn(index, text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const q = prepare(index, text, o);
  if (q.toks.length < o.minTokens || q.known < o.minTokens) return null;
  const cands = candidates(index, q, o.topK);
  if (!cands.length) return null;
  return judge(index, q, cands, o);
}

/* ==================== MORE THAN ONE TRANSLATION ==========================
 *
 * People quote the Bible they learned and read the Bible the church bought,
 * and those are rarely the same book. "Cast all your anxiety on him because he
 * cares for you" cannot be found in a King James index at all — the King James
 * says "casting all your care upon him; for he careth for you", and no amount
 * of stemming turns anxiety into care. Ten of the twenty-six modern-wording
 * quotations in the corpus were missed for exactly that reason, and none of
 * them is an unusual thing to say.
 *
 * The answer is a REFERENCE, and a reference belongs to no translation. So the
 * search runs over several indexes and the best match anywhere wins; the verse
 * is then displayed in whatever the church actually reads. Match on the King
 * James, show the New International.
 */
/*
 * ...AND MORE THAN ONE LENGTH OF SENTENCE.
 *
 * SHARE — how much of what was just said is one run out of one verse — is the
 * number that decides, and it is therefore sensitive to how much "what was just
 * said" covers. Measured on a real sermon quoting Proverbs 13:23, a six-second
 * look-back found it and a four-second one could not (the quotation is longer
 * than four seconds) and neither could an eight-second one (four seconds of
 * other words diluted it below the bar). There is no window length that is
 * right for every quotation, because the thing being measured is a fraction and
 * the denominator is an accident of when somebody drew breath.
 *
 * So the sentence is offered at several lengths — all of it, and its last few
 * clauses — and the best answer wins. A quotation is a run of words at the END
 * of what has just been said (the speaker is saying it now), so trimming from
 * the front is the trim that matters. This costs a few milliseconds per length
 * and removes the dependence on the window entirely.
 *
 * THE UNIT IS THE SENTENCE, NOT THE LAST N WORDS, and that distinction is the
 * whole safety of it. Trimming to a word count was tried and put four lines of
 * ordinary preaching on the wall, because ANY long sentence contains a shorter
 * one that happens to be scripture: "the disciples did not understand what he
 * was saying to them" is a preacher narrating, and Luke 2:50 word for word if
 * you are allowed to drop "the disciples" from the front. Dropping words from
 * inside a sentence is not reading it differently, it is misquoting it.
 *
 * Between sentences there is no such objection: two sentences are two things
 * somebody said, and asking whether the last one was a quotation is exactly the
 * question. So the splits are the speaker's own — full stops, questions, colons
 * — and a sentence is never cut into. Text with no sentence boundary in it is
 * therefore judged whole, as it always was.
 */
/*
 * …AND NOT ONLY AT THE END OF THE WINDOW.
 *
 * Offering only the last few sentences assumed a quotation is always the
 * newest thing said. Replayed through thirteen hours of this church's own
 * services, it usually is not: the preacher quotes and then keeps talking —
 * "This is the day the Lord has made, we will rejoice and be glad in it. See,
 * that is why…" — and by the time the next twelve-second look-back arrives
 * the quotation sits in the MIDDLE of the window, judged as a third of it, and
 * refused. Isaiah 11:2 went by that way with twenty-five words in a row of it
 * said aloud.
 *
 * So every group of one to three consecutive sentences in the window is its
 * own question. The unit is still the speaker's sentence — nothing is ever cut
 * inside one — so the rule that made tails safe is the rule here too: a piece
 * of the window has to carry a run half again as long as the whole would
 * (TAIL_MIN_RUN), because every extra question is another chance for a short
 * clause to land on scripture by accident.
 *
 * `mode`: 'all' (the default), 'tails' (only groups that end the window — how
 * this worked before), or 'none' (the window whole).
 */
function piecesOf(text, mode) {
  const whole = String(text || '').trim();
  const out = [{ text: whole, whole: true }];
  if (mode === 'none') return out;
  // The speaker's own boundaries. Keeping the punctuation on the piece matters:
  // the tokeniser drops it, but splitting on it is what makes the piece a
  // sentence rather than an arbitrary run of words.
  const parts = whole.split(/(?<=[.!?;:])\s+/).filter((x) => x.trim());
  if (parts.length < 2) return out;
  const seen = new Set([whole]);
  for (let i = 0; i < parts.length; i++) {
    for (let len = 1; len <= 3 && i + len <= parts.length; len++) {
      const end = i + len === parts.length;
      if (mode === 'tails' && !end) continue;
      const t = parts.slice(i, i + len).join(' ').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push({ text: t, whole: false });
    }
  }
  return out;
}
/** Kept for anything that still asks for the old tails. */
function tailsOf(text) { return piecesOf(text, 'tails').map((x) => x.text); }

/*
 * A TAIL HAS TO BE LONGER THAN A WHOLE SENTENCE WOULD.
 *
 * What the speaker actually said is evidence; a tail of it is a hypothesis, and
 * hypotheses are cheap — a preacher talks for forty minutes and every few
 * seconds ends a sentence, so the matcher gets hundreds of chances to find a
 * short one that happens to be scripture verbatim. Two arrived immediately:
 * "They were afraid to ask him" IS Luke 9:45 and "Blessed be his glorious name"
 * IS Psalm 72:19, and both are a preacher telling the story or a congregation
 * singing. Share and coverage cannot separate those, because a six-word
 * sentence that is a verse fragment scores a perfect 1.00 on both.
 *
 * Length can. Somebody who has stopped talking to QUOTE something quotes more
 * than six words of it; a clause that lands on scripture by accident is short,
 * because the longer it runs the less likely the accident. So a tail must carry
 * a run half again as long as a whole sentence needs. The whole text is judged
 * on the ordinary bar throughout — this only ever makes the extra chances
 * harder to take, never the original one easier.
 */
const TAIL_MIN_RUN = 8;

function findAcross(indexes, text, opts = {}) {
  let best = null, bestNear = null;
  const mode = opts && opts.tails === false ? 'none' : ((opts && opts.pieces) || 'all');
  const whole = String(text || '').trim();
  const parts = mode === 'none' ? [whole] : whole.split(/(?<=[.!?;:])\s+/).filter((x) => x.trim());
  const partToks = parts.map((x) => tokenise(x));
  const allToks = [].concat(...partToks);
  // token index at which each sentence starts, and one past the end
  const starts = [];
  let at = 0;
  for (const t of partToks) { starts.push(at); at += t.length; }
  starts.push(at);
  const o = { ...DEFAULTS, ...opts };
  const pieceOpts = Object.assign({}, o, { minRunLen: Math.max(TAIL_MIN_RUN, o.minRunLen || 0), shortRun: null });
  const keep = (r, isWhole) => {
    if (!r) return;
    if (r.ok) { if (!best || r.score > best.score) best = r; }
    // A near miss is only worth reporting for what they actually said; a piece
    // that nearly matched is noise in a diagnostic, not information.
    else if (isWhole && (!bestNear || r.score > bestNear.score)) bestNear = r;
  };
  const pending = [];     // short runs waiting on the other translations
  const votes = [];       // per translation: the verses it judged best, or null for "a stock phrase"
  for (const ix of indexes) {
    if (!ix) continue;
    const q = prepare(ix, allToks, o);
    if (q.toks.length < o.minTokens || q.known < o.minTokens) continue;
    const cands = candidates(ix, q, o.topK);
    if (!cands.length) continue;
    const hits = [];
    const r = judge(ix, q, cands, Object.assign({}, o, { _hits: hits }));
    keep(r, true);
    // A Bible votes only if it heard a run long enough to be asked about at all.
    if (o.agreeMin != null && o.shortRun != null && r && r.run >= o.shortRun) {
      votes.push((r.sameRun || 1) >= o.stockSame ? null : new Set(r.sameAt || []));
      if (r.needsAgreement) pending.push(r);
    }
    if (parts.length < 2) continue;
    /*
     * The sentences each candidate's run actually sits in — the smallest group
     * of whole sentences that holds it — judged on their own. Only a group
     * holding a run as long as a piece needs is asked about at all, so this is
     * one or two fresh searches a window, not one per sentence.
     *
     * JUDGED EXACTLY AS IF IT HAD BEEN SAID ON ITS OWN — against its own
     * shortlist, not only the verse that suggested it. It used to be judged
     * against that one verse, and then no other verse could say the words
     * equally well, so the stock-phrase rule could never fire: in a real
     * service "So through the grace of our Lord Jesus Christ, you will succeed"
     * went up as Acts 15:11, when those words are in eleven verses of the King
     * James and every translation calls them a stock phrase.
     */
    const asked = new Set();
    for (const h of hits) {
      if (h.run < pieceOpts.minRunLen || h.startQ < 0 || h.endQ < 0) continue;
      let si = 0; while (si + 1 < parts.length && starts[si + 1] <= h.startQ) si++;
      let ei = si; while (ei + 1 < parts.length && starts[ei + 1] <= h.endQ) ei++;
      if (si === 0 && ei === parts.length - 1) continue;           // that is the whole window
      if (ei - si > 2) continue;                                    // more than three sentences
      if (mode === 'tails' && ei !== parts.length - 1) continue;
      const key = si + ':' + ei;
      if (asked.has(key)) continue;
      asked.add(key);
      const pq = prepare(ix, allToks.slice(starts[si], starts[ei + 1]), o);
      if (pq.toks.length < o.minTokens || pq.known < o.minTokens) continue;
      const pc = candidates(ix, pq, o.topK);
      if (pc.length) keep(judge(ix, pq, pc, pieceOpts), false);
    }
  }
  /*
   * A SHORT QUOTATION THE TRANSLATIONS AGREE ON. See agreeMin in DEFAULTS.
   * Only asked when nothing longer was found: it is the weakest evidence
   * there is, and never the reason to prefer one verse over a better one.
   */
  if (!best && pending.length && votes.length >= o.agreeMin) {
    pending.sort((a, b) => b.runWeight - a.runWeight);
    for (const r of pending) {
      if (r.runWeight < (o.agreeWeight || 0)) continue;
      const key = verseKey(r.bookNr, r.chapter, r.verse);
      let agree = 0;
      for (const v of votes) if (v && v.has(key)) agree++;
      r.agree = agree;
      r.dissent = votes.length - agree;
      if (agree >= o.agreeMin && r.dissent <= o.agreeDissent) { r.ok = true; r.byAgreement = true; best = r; break; }
    }
  }
  return best || bestNear || null;
}

/* ---- built once, kept for the service ---- */
const cache = new Map();
const building = new Map();

/**
 * The index for one translation, built on first use.
 *
 * `load(abbr)` is injected rather than required, so this module can be tested
 * against a handful of made-up verses without a Bible on disk.
 */
async function indexFor(abbr, load) {
  if (cache.has(abbr)) return cache.get(abbr);
  // Two callers asking at once must not both build it — the second waits on
  // the first's promise rather than spending another second and another 13 MB.
  if (building.has(abbr)) return building.get(abbr);
  const p = (async () => {
    const data = await load(abbr);
    if (!data || !data.books || !data.books.length) return null;
    const ix = await buildIndex(abbr, data);
    cache.set(abbr, ix);
    return ix;
  })().finally(() => building.delete(abbr));
  building.set(abbr, p);
  return p;
}
function clearCache() { cache.clear(); }
function cached() { return [...cache.keys()]; }

/**
 * Which translations to listen with, given what is installed.
 *
 * Three at most, and each earns its place:
 *  - the one on the screen, because that is the wording the church hears week
 *    to week and therefore the wording it half-remembers;
 *  - the King James, because it is what most people memorised, and the older
 *    the speaker the more certain that is;
 *  - one modern translation, because "anxiety", "burdened" and "set you free"
 *    simply do not occur in the other two.
 *
 * More than three buys very little and costs a second of build and a chunk of
 * memory each. Order matters only for tie-breaks.
 */
/*
 * WHICH TRANSLATION IS INDEXED IS THE SINGLE BIGGEST THING DECIDING WHETHER A
 * QUOTATION IS FOUND. Measured, on 10-word windows sampled from every book:
 *
 *     the quoted translation IS indexed      100% answered, 99.4% correct
 *     a close cousin is (NKJV vs KJV)         65% answered,  96% correct
 *     only a distant one is (ESV vs KJV+NIV)  48% answered,  94% correct
 *     only a paraphrase is (MSG)               8% answered
 *
 * Nothing else in this file moves the number that much. So the answer to
 * "how many" is "as many as are installed and worth having", and the reason
 * that is affordable is that the indexes live on a worker thread where a
 * second of building and thirteen megabytes cost nobody anything.
 *
 * Five, in this order, and only ones actually downloaded:
 *  - the translation ON THE SCREEN, because that is the wording this church
 *    hears every week and therefore half-remembers;
 *  - the King James, because it is what most people memorised;
 *  - the New King James, which catches the modernised-but-still-formal quoting
 *    that neither of the above does;
 *  - a mainstream modern one, for "anxiety", "burdened", "set you free";
 *  - the New Living, which is loose enough to catch loose quoting.
 */
/*
 * ►► "IT MUST KNOW THE WHOLE BIBLE." ◄◄
 *
 * It used to index four translations at most — one per "tier" — on the
 * reasoning that more bought little. Replayed through thirteen hours of this
 * church's own services, it bought a great deal: the preachers quote the
 * NKJV, the ESV, the Amplified, the Christian Standard, a half-remembered
 * American Standard, and a quotation in a wording that is not indexed is
 * simply not found (the measurements are in the note above).
 *
 * So now EVERY installed translation is indexed, in this order — the church's
 * own first, then the ones people most often memorised — because the first
 * few become usable while the rest are still building. Memory is about 12 MB
 * a translation on the worker thread (147 MB for all twelve installed here),
 * and asking all of them about a window costs ~45 ms, because the expensive
 * part is shared (see findAcross).
 *
 * Only the 66 books are ever indexed (see buildIndex), and a second edition of
 * the King James — modernised spelling, or the same text with the Apocrypha —
 * is skipped when the King James itself is there: after stemming it is the
 * same words, and it would only double every King James match.
 */
const ORDER = ['kjv', 'bolls:NKJV', 'bolls:NIV', 'bolls:ESV', 'bolls:NLT', 'bolls:NASB',
  'bolls:CSB17', 'bolls:BSB', 'bolls:NET', 'bolls:AMP', 'asv', 'bolls:MSG', 'akjv', 'kjva'];
const KJV_EDITIONS = ['akjv', 'kjva'];
const MAX_INDEXES = 16;
function chooseTranslations(display, installedAbbrs) {
  const have = new Set(installedAbbrs || []);
  const out = [];
  const isKjv = (a) => a === 'kjv' || KJV_EDITIONS.includes(a);
  const add = (a, always) => {
    if (!a || !have.has(a) || out.includes(a) || out.length >= MAX_INDEXES) return;
    if (!always && isKjv(a) && out.some(isKjv)) return;
    out.push(a);
  };
  add(display, true);                 // the church's own, whatever it is
  for (const a of ORDER) add(a);
  // …and anything else installed that the list above does not know by name
  // (an imported translation), after the ones it does.
  for (const a of installedAbbrs || []) add(a);
  return out;
}

module.exports = {
  buildIndex, findIn, findAcross, indexFor, clearCache, cached,
  chooseTranslations, tokenise, stem, DEFAULTS, ARCHAIC, piecesOf, prepare, candidates, judge,
};
