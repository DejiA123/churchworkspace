'use strict';
/*
 * FOLLOWING THE READING — the verse turns itself over.
 *
 * The ask: "when a Bible verse is on the screen and the speaker begins to read
 * it out, and the speaker says the LAST WORD in the verse, the next verse
 * should open automatically."
 *
 * That is a different question from the two this app already answers, and the
 * difference is what makes it tractable:
 *
 *   - voiceref.js asks "was that an INSTRUCTION?" — a question about intent,
 *     answered against forty minutes of speech that must all come back null.
 *   - versefind.js asks "which of 31,000 verses was that?" — a search.
 *   - this asks "has the speaker reached the END of THIS ONE VERSE?" — and the
 *     verse is already known. There is exactly one candidate, its text is in
 *     hand, and the only question is how far through it the voice has got.
 *
 * Matching against one known string is an enormously easier problem than
 * searching 31,000, and that is why this can be confident where a search has to
 * be cautious.
 *
 * ============================ HOW IT DECIDES ============================
 *
 * 1. IT MUST BE READING, NOT TALKING ABOUT. The heard words have to line up
 *    with the verse IN ORDER, as a run. A preacher discussing a verse quotes
 *    fragments of it out of order, interleaved with their own words; a person
 *    reading it produces the words consecutively. The run tells them apart,
 *    exactly as it does in versefind.
 *
 * 2. THE RUN MUST REACH THE END. Landing anywhere in the verse is not the
 *    signal — "the Lord is my shepherd" is the START of Psalm 23:1, and the
 *    screen must not move for it. `tailGap` is how many of the verse's own
 *    words are left unaccounted for after the run stops, and it has to be
 *    small. Without this clause the page would turn the moment the reader
 *    began, whipping the words away exactly as the congregation started to
 *    read them — the worst thing this feature could possibly do.
 *
 * 3. IT MUST SURVIVE AN IMPERFECT RECOGNISER, IN BOTH DIRECTIONS. A model over
 *    a PA gets roughly a word in ten wrong, and the errors are not all of one
 *    kind: it SUBSTITUTES ("want" for "what") and it DROPS ("to them who are
 *    called" for "to them who are the called"). The first version of this
 *    handled substitutions only, because the run advanced through both strings
 *    together — and a single dropped word then ended the run six words short
 *    of the end, which is a page that never turns. The dp below carries both.
 *
 * 4. THE ALLOWANCE GROWS WITH THE VERSE. Two errors in a nine-word verse is a
 *    different thing from two in a forty-word one. A fixed budget is therefore
 *    either too tight for long verses or too loose for short ones; it scales.
 *
 * 5. SHORT VERSES ARE REFUSED, NOT GUESSED. "Jesus wept." is two words; there
 *    is no amount of evidence two words can carry. A verse shorter than
 *    `minVerseTokens` never auto-advances and the operator keeps the arrow key
 *    they already had. Being silent on a case it cannot judge is the whole
 *    difference between a feature a church leaves switched on and one they
 *    turn off after it jumps the reading once.
 *
 * 6. ENOUGH OF THE VERSE, NOT JUST ITS TAIL. Somebody who says only the last
 *    six words of a forty-word verse has not read it — they have quoted its
 *    ending, which is what a preacher does when they land on "…and that is the
 *    promise". `minVerseShare` separates reading from landing on the end.
 *
 * Pure — no audio, no Electron, no Bible — so test/read-along.test.js runs
 * thousands of cases in milliseconds. Loaded as a plain script by the
 * Presentation page and require()d directly by the test, like audio-resampler.
 */
(function (root) {
  /*
   * Archaic and cross-translation forms, for the reason the whole app indexes
   * several translations: people read the Bible they memorised off a screen
   * showing the one the church bought. Somebody reading the King James aloud
   * while the slide shows the NIV is still reading this verse, and the page
   * should still turn.
   *
   * Deliberately small, and only forms that are the SAME WORD in older dress —
   * not synonyms. "everlasting" and "eternal" are two different words that two
   * committees chose; mapping those would be inventing agreement that is not
   * there, and the skip budget in (3) is the honest way to absorb them.
   */
  const ARCHAIC = {
    thee: 'you', thou: 'you', thy: 'your', thine: 'your', ye: 'you',
    unto: 'to', shall: 'will', shalt: 'will', hath: 'has', hast: 'has',
    doth: 'does', dost: 'does', art: 'are', wert: 'were', saith: 'say',
    whosoever: 'whoever', whatsoever: 'whatever', wheresoever: 'wherever',
    yea: 'yes', nay: 'no',
  };

  /*
   * One word, reduced to a form both an old translation and a modern one land
   * on. The final trailing-'e' strip is what makes `believeth` and `believes`
   * the same token: -eth leaves "believ" while -s leaves "believe", and
   * without that last step the commonest verb difference between the King
   * James and everything since would break every run. It is applied to BOTH
   * sides of every comparison, so it can only ever make agreement easier —
   * never invent it.
   */
  function stem(w) {
    let s = ARCHAIC[w] || w;
    if (s.length > 4 && (s.endsWith('eth') || s.endsWith('est'))) s = s.slice(0, -3);
    else if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
    else if (s.length > 4 && s.endsWith('ed') && !s.endsWith('eed')) s = s.slice(0, -2);
    else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us')) s = s.slice(0, -1);
    if (s.length > 3 && s.endsWith('e')) s = s.slice(0, -1);
    return ARCHAIC[s] || s;
  }

  /**
   * Text -> plain words: lower case, no punctuation, nothing else done to them.
   * Digits survive, because "five thousand" matters here.
   *
   * This is deliberately SEPARATE from stemming. What the studio keeps in its
   * tape is these — real words, because that tape is also what the operator
   * reads in the log, and "…believ in him will not perish but hav eternal lif"
   * is not a transcript anybody can check the studio against. Stemming happens
   * at the moment of comparison and nowhere else.
   */
  function words(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/'/g, '')
      .split(/\s+/)
      .filter(Boolean);
  }
  /** …and the comparable form of them. */
  function tokens(text) {
    return (Array.isArray(text) ? text : words(text)).map(stem);
  }

  const DEFAULTS = {
    minVerseTokens: 6,    // shorter than this is never judged — see (5)
    minRun: 6,            // six words in a row of a KNOWN verse is a strong signal
    minVerseShare: 0.34,  // …and it must be a real part of the verse — see (6)
    maxTailGap: 1,        // how much of the verse may be left after the run — see (2)
    /*
     * ARMING — "somebody is reading THIS verse, right now."
     *
     * A weaker signal than turning the page, and it does not move anything: all
     * it does is tell the studio to start listening MORE OFTEN, because the
     * moment it is waiting for is a few seconds away (see the close-follow note
     * in present.js). Four words of the verse in order, with the end not yet
     * reached, is enough to be worth paying attention for, and wrong about it
     * costs a few seconds of local recognition and nothing else.
     */
    armRun: 4,
    /*
     * The error budget, as a base plus one more per this many verse words —
     * see (4). A nine-word verse allows three and a twenty-five-word one
     * allows five, and five is what a King James reading of an NIV slide
     * actually costs: "one and only"/"only begotten" is two, "shall"/"should"
     * is one, "eternal"/"everlasting" is one, and the run has to survive all
     * of them to reach the final word.
     *
     * THE CEILING IS NOT A ROUND NUMBER, it is where the safety corpus starts
     * to move. [2] and [3] of test/read-along.test.js — reading half a verse,
     * and preaching around one — are what this was raised against, and they
     * stay completely silent at five. That is the measurement; the budget does
     * not go up again without re-running it.
     */
    baseSkips: 2,
    skipPerTokens: 8,
    maxSkipsCap: 5,
  };

  const skipBudget = (verseLen, o) =>
    Math.min(o.maxSkipsCap, o.baseSkips + Math.floor(verseLen / o.skipPerTokens));

  /**
   * The longest in-order run of `heard` inside `verse`, tolerating a few
   * recogniser errors, and WHERE IN THE VERSE it ends.
   *
   * `len` counts only tokens that genuinely matched — a carried error earns
   * nothing — so a run can never be inflated by the mistakes it survived.
   *
   * Two kinds of error are carried, and both are needed (see (3)):
   *   SUBSTITUTION — the model wrote a different word. Both strings advance.
   *   DELETION     — the model dropped a word the verse has. Only the verse
   *                  advances, which is the case that used to end the run.
   */
  function bestRun(heard, verse, maxSkips) {
    const n = heard.length, m = verse.length;
    if (!n || !m) return { len: 0, endVerse: -1, endHeard: -1 };
    let best = { len: 0, endVerse: -1, endHeard: -1 };
    let prevLen = new Int32Array(m + 1);
    let prevSkip = new Int32Array(m + 1);
    let curLen = new Int32Array(m + 1);
    let curSkip = new Int32Array(m + 1);
    for (let i = 0; i < n; i++) {
      curLen.fill(0); curSkip.fill(0);
      for (let j = 0; j < m; j++) {
        if (heard[i] === verse[j]) {
          curLen[j] = (j > 0 ? prevLen[j - 1] : 0) + 1;
          curSkip[j] = j > 0 ? prevSkip[j - 1] : 0;
        } else if (j > 0 && prevLen[j - 1] > 0 && prevSkip[j - 1] < maxSkips) {
          curLen[j] = prevLen[j - 1];                 // substitution
          curSkip[j] = prevSkip[j - 1] + 1;
        }
        /*
         * A word of the VERSE that never arrived. This reads cur[j-1] — the
         * same heard token against the previous verse token — so the verse
         * advances alone. Considered only when it beats what the cell already
         * holds, so it can never displace a genuine match.
         */
        if (j > 0 && curLen[j - 1] > curLen[j] && curSkip[j - 1] < maxSkips) {
          curLen[j] = curLen[j - 1];
          curSkip[j] = curSkip[j - 1] + 1;
        }
        if (curLen[j] > best.len) best = { len: curLen[j], endVerse: j, endHeard: i };
      }
      const tl = prevLen; prevLen = curLen; curLen = tl;
      const ts = prevSkip; prevSkip = curSkip; curSkip = ts;
    }
    return best;
  }

  /**
   * Has the speaker just finished reading `verseText` out loud?
   *
   * `heardText` is whatever the recogniser last produced — a finished phrase or
   * a rolling look-back; either is fine, because the only question is whether
   * the END of the verse is in it.
   *
   * `done` is the one field the studio acts on. The rest is WHY, so a refusal
   * can be read in the log instead of guessed at.
   */
  function finishedReading(verseText, heardText, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const verse = tokens(verseText);
    // Whatever it is given — a string, or the studio's tape of real words — is
    // stemmed here, so the tape never has to hold a form nobody can read.
    const heard = tokens(heardText);
    const out = { done: false, reading: false, run: 0, tailGap: null, share: 0,
                  verseTokens: verse.length, heardTokens: heard.length,
                  endHeard: -1, endVerse: -1, why: '' };

    if (verse.length < o.minVerseTokens) { out.why = 'verse too short to judge'; return out; }
    if (heard.length < o.armRun) { out.why = 'not enough heard yet'; return out; }

    const skips = o.maxSkips == null ? skipBudget(verse.length, o) : o.maxSkips;
    const r = bestRun(heard, verse, skips);
    out.run = r.len;
    out.skips = skips;
    out.endHeard = r.endHeard;
    out.endVerse = r.endVerse;
    if (r.endVerse < 0) { out.why = 'no run'; return out; }

    out.tailGap = verse.length - 1 - r.endVerse;   // verse words still ahead
    out.share = r.len / verse.length;
    /*
     * ARMED, not finished: enough of THIS verse has gone by in order that the
     * reader is plainly working through it, but the end is still ahead. The
     * studio uses this to start listening more often; it never moves anything.
     */
    out.reading = r.len >= o.armRun && out.tailGap > o.maxTailGap;

    if (heard.length < o.minRun) { out.why = 'not enough heard yet'; return out; }
    if (r.len < o.minRun) { out.why = 'run of ' + r.len + ' is under ' + o.minRun; return out; }
    if (out.share < o.minVerseShare) { out.why = 'only ' + ((out.share * 100) | 0) + '% of the verse'; return out; }
    if (out.tailGap > o.maxTailGap) { out.why = 'stopped ' + out.tailGap + ' words before the end'; return out; }

    out.done = true;
    out.reading = false;
    out.why = 'read to the end';
    return out;
  }

  /**
   * Stitch overlapping look-backs into one continuous transcript.
   *
   * ►► THIS IS THE DIFFERENCE BETWEEN THE TEST PASSING AND THE FEATURE WORKING.
   *
   * finishedReading() was only ever handed ONE look-back, and a look-back is
   * the last six seconds — about fourteen words. `minVerseShare` asks for a
   * third of the verse, so a verse longer than about forty words could not
   * clear the bar in any single window no matter how perfectly it was read.
   * Measured over real verses read at 135 wpm, Ephesians 1:3 (44 words) and
   * Matthew 5:44-45 (52) never turned the page at all.
   *
   * Simply concatenating the windows does not work either: consecutive
   * look-backs overlap by most of their length, so the joined text repeats
   * itself and the run breaks at every seam. So the new words are welded on at
   * the longest overlap — the standard way to stitch a rolling transcript —
   * and what comes out reads as one continuous reading however short the
   * windows were.
   *
   * Returns the number of tokens actually appended, which is how the studio
   * can tell a genuinely new window from the same seconds offered again.
   */
  function stitch(tape, heardText, opts) {
    const o = Object.assign({ maxTokens: 160, maxOverlap: 60 }, opts || {});
    const add = Array.isArray(heardText) ? heardText.slice() : words(heardText);
    if (!add.length) return 0;
    const have = tape.words || (tape.words = []);
    const stems = tape.stems || (tape.stems = have.map(stem));
    const addStems = add.map(stem);
    if (!have.length) { tape.words = add; tape.stems = addStems; return add.length; }
    /*
     * The longest suffix of what we have that is also a prefix of what just
     * arrived. Longest first, so a window that repeats nearly all of the last
     * one contributes only its genuinely new tail.
     *
     * Matched on STEMS, not on the words themselves. Two look-backs covering
     * the same seconds are not guaranteed to produce the same transcript —
     * whisper sees a different amount of context each time — and an overlap
     * missed because one window said "believes" and the next "believeth" would
     * paste the reading into the tape twice and break the run at the seam.
     */
    const max = Math.min(o.maxOverlap, have.length, add.length);
    let k = 0;
    for (let n = max; n > 0; n--) {
      let same = true;
      for (let i = 0; i < n; i++) {
        if (stems[stems.length - n + i] !== addStems[i]) { same = false; break; }
      }
      if (same) { k = n; break; }
    }
    const fresh = add.slice(k);
    if (!fresh.length) return 0;
    for (let i = k; i < add.length; i++) { have.push(add[i]); stems.push(addStems[i]); }
    // Keep the tape bounded, and move the "already acted on" mark with it so a
    // trim can never resurrect words that have already turned a page.
    if (have.length > o.maxTokens) {
      const drop = have.length - o.maxTokens;
      have.splice(0, drop); stems.splice(0, drop);
      tape.used = Math.max(0, (tape.used || 0) - drop);
    }
    return fresh.length;
  }

  /* ======================= FOLLOWING A WHOLE CHAPTER =======================
   *
   * ►► "FOLLOW THE READING IS CONFUSED." ◄◄
   *
   * finishedReading() answers one question — has THIS verse just been read to
   * its end? — and on its own it was right. What was confused was everything
   * around it, measured by replaying real readings from this church's own
   * services through the real studio (test/diag-reading-replay.js):
   *
   *   - THE QUOTE MATCHER DRAGGED THE SCREEN BACKWARDS. The follower turned
   *     Joshua 14 on to verse 4; the next twelve-second look-back still held
   *     the end of verse 3; the quotation matcher, asked "which verse is this",
   *     correctly said 3 — and the screen went back to 3. Then forward, then
   *     back. The same in 1 Timothy 1, and in 2 Corinthians 6 when the pastor
   *     repeated the verse he had just heard.
   *   - IDENTICAL VERSES SWAPPED. Psalm 24:7 and 24:9 are the same words, and a
   *     search has nothing to choose by, so reading 7 put up 9.
   *   - A VERSE WHOSE END WHISPER GARBLED WAS NEVER LEFT. "and with a loud voice
   *     glorified God" came back "loud voice, loud voice, glorify God", the end
   *     never matched, and the screen sat on Luke 17:15 while the reader went on
   *     to 16 and 17.
   *
   * All three have the same cure: while a passage is on the screen, the thing
   * that decides where the reader is must know WHERE IN THE CHAPTER they have
   * got to — the verse on the screen and the few after it — and it must only
   * ever move FORWARD. That is what track() is.
   *
   * It looks at the verse on the screen and the next LOOKAHEAD verses, finds
   * which of them the most recent words belong to, and:
   *   - that verse is the one on the screen and has been read to its end
   *     → turn to the next one (the old behaviour, unchanged);
   *   - it is a LATER verse → the reader is ahead of the screen; catch up to
   *     it (and one further if that one is finished too);
   *   - it is an EARLIER verse → somebody is repeating what was just read.
   *     Nothing moves. The screen never goes backwards by itself.
   *
   * Where two candidates fit the words equally (Psalm 24:7 and 24:9), the one
   * NEAREST the screen wins: a reader is far more likely to be on the next
   * verse than two past it.
   */
  const TRACK = {
    lookahead: 3,          // how far ahead of the screen a reader may be found
    catchRun: 6,           // words in order of a LATER verse before catching up to it
    catchShare: 0.3,       // …and at least this much of that verse (or 9+ words)
    recent: 3,             // a run ending within this many words of the end of the tape is "now"
  };

  /**
   * Where in `verses` the reader is, and what the screen should do about it.
   *
   * @param verses  [{ verse, text }] — the chunk on the screen and the verses
   *                after it (the caller passes as many as it has).
   * @param target  verse number whose END turns the page (last on the screen)
   * @param heard   the unspent tape: real words, or a string
   * @returns { action: 'none'|'advance'|'catchup', toVerse, located, done,
   *            reading, run, endHeard, why }
   */
  function track(verses, target, heard, opts) {
    const o = Object.assign({}, DEFAULTS, TRACK, opts || {});
    const h = tokens(heard);
    const out = { action: 'none', toVerse: null, located: null, done: false, reading: false,
      run: 0, endHeard: -1, why: '', tailGap: null, share: 0 };
    if (h.length < o.armRun) { out.why = 'not enough heard yet'; return out; }
    const list = (verses || []).filter((v) => v && v.text && v.verse >= 0);
    const tIdx = list.findIndex((v) => v.verse === target);
    if (tIdx < 0) { out.why = 'target not in view'; return out; }
    const cands = [];
    for (let i = 0; i < list.length && i <= tIdx + o.lookahead; i++) {
      const v = list[i];
      const vt = tokens(v.text);
      if (vt.length < 3) continue;
      const skips = skipBudget(vt.length, o);
      const r = bestRun(h, vt, skips);
      if (r.endVerse < 0) continue;
      cands.push({ verse: v.verse, idx: i, len: vt.length, run: r.len, endHeard: r.endHeard,
        endVerse: r.endVerse, tailGap: vt.length - 1 - r.endVerse, share: r.len / vt.length });
    }
    // What is being read NOW: a real run, ending at (or very near) the newest
    // words. A strong run far back in the tape is history, not position.
    const strong = cands.filter((c) => c.run >= o.armRun && (c.run >= o.minRun || c.share >= 0.6));
    if (!strong.length) { out.why = 'no verse here is being read'; return out; }
    const newest = Math.max(...strong.map((c) => c.endHeard));
    const now = strong.filter((c) => c.endHeard >= newest - o.recent);
    // Nearest the screen wins a tie; among those at or after it, the lowest.
    now.sort((a, b) => {
      const da = a.idx >= tIdx ? a.idx - tIdx : 100 + (tIdx - a.idx);
      const db = b.idx >= tIdx ? b.idx - tIdx : 100 + (tIdx - b.idx);
      return da - db || b.run - a.run;
    });
    // …but a clearly longer run elsewhere is a better account of the words —
    // clearly longer by more if taking it would SKIP a verse nobody has read.
    // Psalm 24:7 and 24:9 differ by "be ye lift up" / "even lift them up";
    // a pastor repeating verse 7 in the words of verse 9 is not the reader
    // having skipped verse 8.
    let at = now[0];
    for (const c of now) {
      const skipsAhead = c.idx - Math.max(tIdx, at.idx) > 1;
      if (c.run >= at.run + (skipsAhead ? 7 : 4)) at = c;
    }
    out.located = at.verse; out.run = at.run; out.endHeard = at.endHeard;
    out.tailGap = at.tailGap; out.share = at.share;
    const finished = at.len >= o.minVerseTokens && at.run >= o.minRun
      && at.share >= o.minVerseShare && at.tailGap <= o.maxTailGap;

    if (at.idx < tIdx) {
      // Behind the screen: the pastor repeating what was just read, or the
      // look-back still carrying it. Never a reason to go back.
      out.why = `words of verse ${at.verse}, already past — staying`;
      return out;
    }
    if (at.idx === tIdx) {
      if (finished) {
        const next = list[tIdx + 1];
        out.done = true;
        out.why = 'read to the end';
        if (next) { out.action = 'advance'; out.toVerse = next.verse; }
        else out.why = 'read to the end of what is loaded';
        return out;
      }
      out.reading = at.run >= o.armRun && at.tailGap > o.maxTailGap;
      out.why = `reading verse ${at.verse}, ${at.tailGap} words to go`;
      return out;
    }
    // AHEAD of the screen. Only on real evidence of reading: enough of that
    // verse, in order — a stray phrase that happens to occur two verses on is
    // not the reader having got there.
    if (!(at.run >= o.catchRun && (at.share >= o.catchShare || at.run >= 9))) {
      out.why = `a few words of verse ${at.verse} — not enough to jump ahead`;
      return out;
    }
    // Past the NEXT verse means skipping one that was never heard read: only
    // on overwhelming evidence.
    // Measured: Psalm 24, a pastor repeating verse 7 in verse 9's words, ran
    // twelve words into verse 9 (half of it) — so half is not enough; most of
    // the far verse has to have been heard.
    if (at.idx > tIdx + 1 && !(at.run >= 10 && at.share >= 0.75)) {
      out.why = `verse ${at.verse} would skip one nobody read — waiting`;
      return out;
    }
    out.action = 'catchup';
    out.done = finished;
    const after = list[at.idx + 1];
    out.toVerse = finished && after ? after.verse : at.verse;
    out.why = finished ? `verse ${at.verse} read while the screen lagged — on past it` : `the reader is on verse ${at.verse} — catching up`;
    out.reading = !finished;
    return out;
  }

  /*
   * STITCHING THAT SURVIVES A REAL RECOGNISER.
   *
   * stitch() below joins a new look-back to the tape at the longest EXACT
   * overlap. Two recognitions of the same seconds are not exact: the first word
   * of a window is usually a word cut in half ("…ited" for "visited"), and the
   * last word of the one before was cut too. An exact join then finds no
   * overlap at all and pastes the whole window in a second time — the reading
   * appears twice on the tape and the run breaks at the seam.
   *
   * So the overlap is looked for allowing the new window to start up to three
   * words in, the tape's last word to be a fragment the new window completes,
   * and one word in eight to differ inside the overlap.
   */
  function stitchFuzzy(tape, heardText, opts) {
    const o = Object.assign({ maxTokens: 160, maxOverlap: 60, maxLead: 3, maxTail: 1 }, opts || {});
    const add = Array.isArray(heardText) ? heardText.slice() : words(heardText);
    if (!add.length) return 0;
    const have = tape.words || (tape.words = []);
    const stems = tape.stems || (tape.stems = have.map(stem));
    const addStems = add.map(stem);
    if (!have.length) { tape.words = add; tape.stems = addStems; return add.length; }
    let best = null;
    for (let tail = 0; tail <= o.maxTail && tail < stems.length; tail++) {
      const S = stems.length - tail;
      for (let lead = 0; lead <= o.maxLead && lead < addStems.length; lead++) {
        const max = Math.min(o.maxOverlap, S, addStems.length - lead);
        for (let n = max; n >= 3; n--) {
          let miss = 0;
          const allow = Math.floor(n / 8);
          for (let i = 0; i < n && miss <= allow; i++) if (stems[S - n + i] !== addStems[lead + i]) miss++;
          if (miss > allow) continue;
          // the edges must agree: an overlap that begins or ends on a mismatch
          // is a coincidence, not a seam
          if (stems[S - 1] !== addStems[lead + n - 1] || stems[S - n] !== addStems[lead]) continue;
          const score = n - miss * 2 - lead * 0.5 - tail * 0.5;
          if (!best || score > best.score) best = { lead, tail, n, score };
          break;                                  // longest for this lead/tail found
        }
      }
    }
    let fromAdd = 0;
    if (best) {
      if (best.tail) {
        have.splice(have.length - best.tail, best.tail);
        stems.splice(stems.length - best.tail, best.tail);
        tape.used = Math.min(tape.used || 0, have.length);
      }
      fromAdd = best.lead + best.n;
    }
    const fresh = add.slice(fromAdd);
    if (!fresh.length) return 0;
    for (let i = fromAdd; i < add.length; i++) { have.push(add[i]); stems.push(addStems[i]); }
    if (have.length > o.maxTokens) {
      const drop = have.length - o.maxTokens;
      have.splice(0, drop); stems.splice(0, drop);
      tape.used = Math.max(0, (tape.used || 0) - drop);
    }
    return fresh.length;
  }

  const api = { finishedReading, track, stitch, stitchFuzzy, tokens, words, stem, bestRun, skipBudget, DEFAULTS, TRACK };
  root.ReadAlong = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
