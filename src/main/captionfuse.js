'use strict';
/*
 * ►► GEMINI'S WORDS, WHISPER'S TIMING. ◄◄
 *
 * Measured on a real 45-minute sermon (a Nigerian preacher in Ireland): two
 * reviewers found 129 places where the Whisper captions were not what was said
 * — "attract God on the same" (scene), "have read daddies" (real), "body-some"
 * (burdensome), "Bigate" (Bill Gates), "He of thou shall keep" (If thou shalt
 * keep), "the old gospel" (the whole gospel). Gemini, hearing the same audio,
 * had the right words in 71 of them and the same mistake in only 7. Both
 * Whisper ears made most of those mistakes TOGETHER, so two Whispers agreeing
 * is weak evidence against a third, better ear.
 *
 * So the words come from Gemini, and the timing of every word from Whisper
 * (Gemini gives none). Gemini's text is lined up word by word against the
 * Whisper words of the same stretch:
 *
 *   • the same word in both: Whisper's timing, Gemini's spelling/punctuation;
 *   • a different word or phrase between two matches: Gemini's, timed across
 *     the Whisper words it replaces;
 *   • words Gemini left out: they stay — unless the second Whisper ear did not
 *     hear them either (two of three: never said);
 *   • words only Gemini heard: put in where Whisper left room for them, or
 *     where the second Whisper ear heard them too;
 *   • a long stretch the two do not line up on at all (Gemini skipped a
 *     passage, or wrote one that was not said): Whisper's words stay.
 *
 * Every word comes back marked with where it came from (`src`): 'both' (the
 * two agree), 'gemini' (Gemini's word, Whisper's timing), 'whisper' (kept).
 * A long phrase where Gemini overruled BOTH Whisper ears is marked `long`, so
 * it can be listed for a look with what Whisper heard as the alternative.
 *
 * Pure: words in, words out, tested without any network.
 */
const norm = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, '');
const mid = (w) => ((+w.start) + (+w.end)) / 2;

// sounds, not words: a verbatim ear writes them, captions leave them out
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm', 'eh']);
const isWord = (t) => { const n = norm(t); return !!n && !FILLER.has(n); };
/** A Gemini word as a caption shows it: no quotation marks or brackets. */
const display = (t) => String(t || '').replace(/["“”„«»()[\]{}]/g, '').replace(/^[-–—…]+/, '').replace(/[–—…]+$/, '');
function tokensOf(text) {
  return String(text || '').split(/\s+/).map((t) => display(t.trim())).filter(isWord);
}

/*
 * The same words written another way are not a mishearing: "gonna" / "going
 * to", "I'm" / "I am", "every day" / "everyday", "okay" / "OK". Compared in a
 * spelled-out, spaceless form; where that is all the difference is, the
 * caption keeps the Whisper spelling and timing.
 */
const SPELL = [
  [/\bgonna\b/g, 'going to'], [/\bwanna\b/g, 'want to'], [/\bgotta\b/g, 'got to'], [/\bkinda\b/g, 'kind of'],
  [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\bain't\b/g, 'is not'],
  [/\blet's\b/g, 'let us'], [/\bi'm\b/g, 'i am'], [/n't\b/g, ' not'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'],
  [/'ll\b/g, ' will'], [/'d\b/g, ' would'], [/'s\b/g, ' is'], [/\bokay\b/g, 'ok'], [/\balright\b/g, 'all right'],
];
function sameWords(a, b) {
  const f = (s) => { let t = String(s || ''); for (const [rx, to] of SPELL) t = t.replace(rx, to); return t.replace(/[^a-z0-9]/g, ''); };
  return f(a) === f(b);
}

/** LCS alignment of two token lists (normalised): pairs of [i, j] that match, in order. */
function align(x, y) {
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    L[i][j] = x[i] && x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const pairs = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] && x[i] === y[j]) { pairs.push([i, j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const ABBREV = /^(mr|mrs|ms|dr|st|rev|prof|vs|etc|e\.g|i\.e|a\.m|p\.m|[a-z]\.[a-z])\.$/i;
const keyOf = (ws) => ws.map((w) => norm(w.text)).filter((t) => t && !FILLER.has(t)).join(' ');

/*
 * A match the alignment can lean on. Two hearings of different passages still
 * share "the", "and", "of" here and there, and lining up on those stitches the
 * two into nonsense ("the brothers and sisters of the word for today"). So a
 * match only counts as solid ground when it is part of a run (two or more
 * words in a row in both), or a word distinctive enough to be the same moment
 * on its own; the matches between are part of the block around them.
 */
const SMALL = new Set(('the a an and or of to in on at for from is it its i you he she we they that this these those be been was were are am '
  + 'so but all my your his her our their me him us them do did does not no yes oh as by with what if then there here have has had will '
  + 'would can could shall should may might must just now one who which when where why how say said says go').split(' '));
/** Is `a` what is left of `b` with some words taken out (in order)? */
function subseq(a, b) {
  let j = 0;
  for (let i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++;
  return j === a.length;
}
function anchorsOf(pairs, x) {
  return pairs.filter(([pi, gj], k) => {
    const prev = pairs[k - 1], next = pairs[k + 1];
    const run = (prev && prev[0] === pi - 1 && prev[1] === gj - 1) || (next && next[0] === pi + 1 && next[1] === gj + 1);
    return run || (x[pi].length >= 4 && !SMALL.has(x[pi]));
  });
}

/**
 * words: the caption words [{text,start,end}] on the span's clock; alt: the
 * second Whisper ear's words (or null); chunks: Gemini's stretches
 * [{ from, to, text, own0?, own1?, atStart?, atEnd? }] — [from, to) is what
 * Gemini heard, [own0, own1) the part this stretch decides (stretches overlap
 * a little so no word falls between two), atStart/atEnd: the span's own ends.
 * Returns { words, stats }.
 */
function fuseGemini(words, alt, chunks, { edge = 1.0, maxBlock = 12, secPerWord = 0.09 } = {}) {
  const W = Array.isArray(words) ? words : [];
  const A = Array.isArray(alt) ? alt : [];
  const stats = { stretches: 0, skipped: 0, same: 0, replaced: 0, inserted: 0, removed: 0, kept: 0, overruled: 0, long: 0 };
  const retext = new Map();     // i -> Gemini's spelling of the same word
  const ops = [];               // { i0, i1, tokens, start, end, long, trimBefore, trim }
  const keep = new Set();       // i: Whisper's word kept where Gemini had nothing (or nothing sure)
  const both = new Set();       // i: heard the same by Gemini
  for (const c of chunks || []) {
    if (!c || !c.text) continue;
    const lo = c.atStart ? -Infinity : c.from + edge, hi = c.atEnd ? Infinity : c.to - edge;
    const o0 = c.atStart ? -Infinity : (c.own0 != null ? c.own0 : c.from);
    const o1 = c.atEnd ? Infinity : (c.own1 != null ? c.own1 : c.to);
    const owns = (t) => t >= o0 && t < o1;
    const idx = [];
    for (let i = 0; i < W.length; i++) { const m = mid(W[i]); if (m >= lo && m < hi) idx.push(i); }
    const g = tokensOf(c.text);
    if (idx.length < 4 || g.length < 4) continue;
    const x = idx.map((i) => norm(W[i].text)), y = g.map(norm);
    const pairs = align(x, y);
    // not the same stretch at all (Gemini answered something else): leave it to Whisper
    if (pairs.length < Math.min(x.length, y.length) * 0.5) { stats.skipped++; continue; }
    stats.stretches++;
    const solid = anchorsOf(pairs, x);
    for (const [pi, gj] of solid) {
      const i = idx[pi];
      if (!owns(mid(W[i]))) continue;
      both.add(i); stats.same++;
      if (display(g[gj]) !== W[i].text) retext.set(i, display(g[gj]));
    }
    // the blocks between matches; at the span's own ends, the stretch before the first / after the last too
    const bounds = solid.slice();
    if (c.atStart) bounds.unshift([-1, -1]);
    if (c.atEnd) bounds.push([x.length, y.length]);
    for (let k = 0; k + 1 < bounds.length; k++) {
      const [pi, gj] = bounds[k], [pi2, gj2] = bounds[k + 1];
      const pa = idx.slice(pi + 1, pi2), gb = g.slice(gj + 1, gj2);
      if (!pa.length && !gb.length) continue;
      const before = pi >= 0 ? W[idx[pi]] : null, after = pi2 < idx.length ? W[idx[pi2]] : null;
      const t0 = pa.length ? +W[pa[0]].start : (before ? +before.end : null);
      const t1 = pa.length ? +W[pa[pa.length - 1]].end : (after ? +after.start : null);
      if (t0 == null || t1 == null) continue;
      if (!owns(pa.length ? mid(W[pa[0]]) : t0)) continue;
      const room0 = before ? +before.end : t0, room1 = after ? +after.start : t1;
      // what the second ear heard here: its words between the middles of the two neighbours
      const a0 = before ? mid(before) : t0 - 0.05, a1 = after ? mid(after) : t1 + 0.05;
      const altKey = keyOf(A.filter((w) => mid(w) > a0 && mid(w) < a1));
      const pKey = keyOf(pa.map((i) => W[i])), gKey = gb.map(norm).filter((t) => !FILLER.has(t)).join(' ');
      if (pKey === gKey || sameWords(pKey, gKey)) { for (const i of pa) both.add(i); stats.same += pa.length; continue; }
      // Gemini only LEFT OUT words here (a repeat, a stumble): the same rule as leaving out all of them
      const pT = pKey ? pKey.split(' ') : [], gT = gKey ? gKey.split(' ') : [];
      if (gb.length && pT.length > gT.length && subseq(gT, pT)) {
        if (altKey === gKey && A.length && pa.length <= maxBlock) {
          ops.push({ i0: pa[0], i1: pa[pa.length - 1], tokens: gb.map(display), start: t0, end: t1 }); stats.removed += pT.length - gT.length;
        } else { for (const i of pa) keep.add(i); stats.kept += pa.length; }
        continue;
      }
      if (!gb.length) {
        // Gemini left them out: gone only if the second Whisper ear did not hear them either
        if (!altKey && A.length && pa.length <= maxBlock) { ops.push({ i0: pa[0], i1: pa[pa.length - 1], tokens: [], start: t0, end: t1 }); stats.removed += pa.length; }
        else { for (const i of pa) keep.add(i); stats.kept += pa.length; }
        continue;
      }
      const twoOfThree = !!altKey && altKey === gKey;
      if (!pa.length) {
        // only Gemini heard these: where Whisper left room for them, or the second ear heard them too
        if (!before || !after) continue;
        const gap = room1 - room0;
        if (!(twoOfThree || gap >= gb.length * 0.18) || gb.length > maxBlock * 2) continue;
        // a dropped word under a stretched neighbour: borrow time from the word before
        const need = gb.length * 0.18 - gap;
        const trim = need > 0 ? Math.min(need, (+before.end - +before.start) * 0.5) : 0;
        ops.push({ i0: idx[pi2], i1: idx[pi2] - 1, tokens: gb.map(display), start: room0 - trim, end: room1, trimBefore: trim > 0 ? idx[pi] : -1, trim });
        stats.inserted += gb.length;
        continue;
      }
      // a different word or phrase
      const fits = gb.length * secPerWord <= (room1 - room0) + 0.05;
      // Gemini summing up a stretch in far fewer words (laughter, tongues, a run of repeats)
      // is not a better hearing of it: measured, "ha ha ha ha. It's a mighty God. ha ha ha ha"
      // came back "Hey. Is that my tig?"
      const shrunk = pT.length >= 4 && gT.length * 2 < pT.length;
      if ((!twoOfThree && (pa.length > maxBlock || gb.length > maxBlock || shrunk)) || !fits) { for (const i of pa) keep.add(i); stats.kept += pa.length; continue; }
      const overrule = !!altKey && altKey === pKey;          // both Whisper ears heard the caption's words
      const long = overrule && (gb.length >= 4 || pa.length >= 4);
      ops.push({ i0: pa[0], i1: pa[pa.length - 1], tokens: gb.map(display), start: t0, end: t1, long });
      stats.replaced += gb.length;
      if (overrule) stats.overruled++;
      if (long) stats.long++;
    }
  }
  // build: every word marked with where it came from
  const out = W.map((w, i) => {
    const o = Object.assign({}, w);
    if (both.has(i)) { o.src = 'both'; if (retext.has(i)) o.text = retext.get(i); delete o.unsure; }
    else if (keep.has(i)) o.src = 'whisper';
    return o;
  });
  for (const op of ops.slice().sort((a, b) => b.i0 - a.i0)) {
    if (op.trimBefore >= 0 && out[op.trimBefore]) out[op.trimBefore].end = +(+out[op.trimBefore].end - op.trim).toFixed(3);
    const n = op.tokens.length;
    const lens = op.tokens.map((t) => Math.max(1, norm(t).length) + 1);
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const span = Math.max(0.05 * n, op.end - op.start);
    let t = op.start;
    const repl = op.tokens.map((tok, k) => {
      const d = span * (lens[k] / total);
      const w = { text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3), src: 'gemini' };
      if (op.long) w.long = true;
      t += d;
      return w;
    });
    const count = op.i1 >= op.i0 ? op.i1 - op.i0 + 1 : 0;
    // a removed word that ended a sentence hands its full stop to the word before
    if (!n && count) {
      const last = out[op.i1], prev = out[op.i0 - 1];
      const p = /[.?!]$/.exec(last.text || '');
      if (p && prev && !/[.?!,;:]$/.test(prev.text)) prev.text += p[0];
    }
    out.splice(op.i0, count, ...repl);
  }
  // where a sentence ends, the next word starts with a capital (the two sources may disagree on where)
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].text;
    if (/[.?!]$/.test(prev) && !ABBREV.test(prev) && /^[a-z]/.test(out[i].text)) out[i].text = out[i].text[0].toUpperCase() + out[i].text.slice(1);
  }
  return { words: out, stats };
}

module.exports = { fuseGemini, align, tokensOf, sameWords, display, norm };
