'use strict';
/*
 * ►► THREE HEARINGS, ONE CAPTION. ◄◄
 *
 * The words the captions are built from (Whisper Large v3, heard with its
 * context), the second Whisper ear (Turbo, heard plain) and a third ear that is
 * not Whisper at all (geminiear.js) are lined up, a three-minute stretch at a
 * time, and every place they differ is one decision:
 *
 *   • Gemini and the second Whisper ear heard the same thing, the main ear
 *     something else — two of three: theirs is taken.
 *   • Both Whisper ears agree and Gemini heard something else — the Whisper
 *     blind spot ("on the same" / "on the scene"). Not decided here: handed to
 *     a reader (main.js) with the sentence around it, which says which of the
 *     two was more likely said; unsure means the Whisper words stay.
 *   • Gemini left words out, or tidied the grammar into something the Whisper
 *     ears did not hear: the Whisper words stay — a caption is what was said.
 *
 * Pure: words in, decisions out, so it is tested without any network.
 */
const norm = (t) => String(t || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9']/g, '');
const mid = (w) => ((+w.start) + (+w.end)) / 2;
const joinN = (ws) => ws.map((w) => norm(w.text)).filter(Boolean).join(' ');

// sounds, not words: a verbatim ear writes them, captions leave them out
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);
function tokensOf(text) {
  return String(text || '').split(/\s+/).map((t) => t.trim()).filter((t) => t && norm(t) && !FILLER.has(norm(t)));
}

/*
 * The same words written another way are not a mishearing: "gonna" / "going
 * to", "I'm" / "I am", "every day" / "everyday", "okay" / "OK". Compared in a
 * spelled-out, spaceless form so a style difference never changes a caption.
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
// A Gemini word as it goes into a caption: the caption's own punctuation stays
// (the sentence's ending is kept by apply()), so Gemini's commas are not brought
// in; a capital Gemini gave only because ITS sentence started there is dropped,
// unless the word is a name it writes with a capital anyway.
const bare = (t) => String(t || '').replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '').replace(/^'+|'+$/g, '');
const NAMES = /^(I|I'm|I've|I'll|I'd|God|God's|Jesus|Christ|Lord|Holy|Spirit|Ghost|Father|Bible|Amen|Hallelujah)$/;
function asCaption(tok, g, j, replacedFirst, k) {
  let t = bare(tok);
  const startsSentence = j === 0 || /[.?!]["')\]]*$/.test(g[j - 1] || '');
  if (startsSentence && /^[A-Z][a-z']*$/.test(t) && !NAMES.test(t)) {
    // capitalised elsewhere mid-sentence by Gemini: a name, kept
    const mid = g.some((x, i) => i > 0 && bare(x) === t && !/[.?!]["')\]]*$/.test(g[i - 1] || ''));
    if (!mid) t = t.toLowerCase();
  }
  // where the caption's word started with a capital (its own sentence start), so does the new one
  if (k === 0 && /^[A-Z]/.test(replacedFirst || '') && /^[a-z]/.test(t)) t = t[0].toUpperCase() + t.slice(1);
  return t;
}
const NUMBERISH = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|percent)\b/;

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

/**
 * words: the caption words [{text,start,end}] (span clock); alt: the second
 * Whisper ear's words; chunks: [{from,to,text}] from the third ear.
 * Returns { auto: [op], ask: [op] } — an op replaces words[i0..i1] (or inserts
 * before i0 when i1 < i0) with `tokens`, timed across [start, end].
 */
function plan(words, alt, chunks, { edge = 1.0, maxBlock = 6 } = {}) {
  const auto = [], ask = [];
  const A = Array.isArray(alt) ? alt : [];
  for (const c of chunks || []) {
    if (!c || !c.text) continue;
    const idx = [];
    for (let i = 0; i < words.length; i++) { const m = mid(words[i]); if (m >= c.from + edge && m < c.to - edge) idx.push(i); }
    if (idx.length < 4) continue;
    const g = tokensOf(c.text);
    const x = idx.map((i) => norm(words[i].text)), y = g.map(norm);
    const pairs = align(x, y);
    if (pairs.length < Math.min(x.length, y.length) * 0.5) continue;      // not the same stretch at all: leave it
    // the blocks BETWEEN matches (the edges of a stretch are where the two cut differently: left alone)
    for (let k = 0; k + 1 < pairs.length; k++) {
      const [pi, gj] = pairs[k], [pi2, gj2] = pairs[k + 1];
      const pa = idx.slice(pi + 1, pi2), gb = g.slice(gj + 1, gj2);
      if (!pa.length && !gb.length) continue;
      if (pa.length > maxBlock || gb.length > maxBlock) continue;
      const before = words[idx[pi]], after = words[idx[pi2]];
      const t0 = pa.length ? +words[pa[0]].start : +before.end;
      const t1 = pa.length ? +words[pa[pa.length - 1]].end : +after.start;
      const altBlock = A.filter((w) => mid(w) > +before.end - 0.05 && mid(w) < +after.start + 0.05);
      const pN = pa.map((i) => norm(words[i].text)).filter((t) => t && !FILLER.has(t)).join(' '), gN = gb.map(norm).join(' ');
      const aN = altBlock.map((w) => norm(w.text)).filter((t) => t && !FILLER.has(t)).join(' ');
      if (pN === gN || sameWords(pN, gN)) continue;
      // numbers ("3" / "three", "3:16" / "three sixteen") are a style both ears write their own way
      if (NUMBERISH.test(pN) || NUMBERISH.test(gN) || /\d/.test(aN)) continue;
      const op = {
        i0: pa.length ? pa[0] : idx[pi2], i1: pa.length ? pa[pa.length - 1] : idx[pi2] - 1,
        tokens: gb.map((t, k) => asCaption(t, g, gj + 1 + k, pa.length ? words[pa[0]].text : '', k)), start: t0, end: t1,
        whisper: pa.map((i) => words[i].text).join(' '), gemini: gb.map((t) => bare(t)).join(' '),
        before: idx.slice(Math.max(0, pi - 7), pi + 1).map((i) => words[i].text).join(' '),
        after: idx.slice(pi2, pi2 + 8).map((i) => words[i].text).join(' '),
      };
      if (!gb.length) continue;                                  // the third ear left words out: they stay
      if (aN === gN) { auto.push(op); continue; }                // two of three
      if (!pa.length) continue;                                  // words only Gemini heard: not on one ear's say-so
      if (aN === pN || !aN) ask.push(op);                        // the Whisper blind spot (or no second ear here): ask
    }
  }
  return { auto, ask };
}

/** Apply ops (non-overlapping) to a copy of the words. Each changed word is marked `third`. */
function apply(words, ops, how = 'gemini') {
  const out = words.slice();
  const sorted = ops.slice().sort((a, b) => b.i0 - a.i0);
  for (const op of sorted) {
    const n = op.tokens.length;
    const lens = op.tokens.map((t) => Math.max(1, norm(t).length));
    const total = lens.reduce((a, b) => a + b, 0);
    const span = Math.max(0.05 * n, op.end - op.start);
    let t = op.start;
    const last = op.i1 >= op.i0 ? out[op.i1] : null;
    const repl = op.tokens.map((tok, k) => {
      const d = span * (lens[k] / total);
      const w = { text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3), third: op.how || how };
      t += d;
      return w;
    });
    // the sentence's own ending punctuation is kept when the replacement has none
    if (last && repl.length && /[.?!,]$/.test(last.text) && !/[.?!,]$/.test(repl[repl.length - 1].text)) {
      repl[repl.length - 1].text += last.text.slice(-1);
    }
    const count = op.i1 >= op.i0 ? op.i1 - op.i0 + 1 : 0;
    out.splice(op.i0, count, ...repl);
  }
  return out;
}

/** The reader's question: which of two hearings was said. */
function refereePrompt(items) {
  const lines = items.map((it) => `${it.id}. …${it.before} [A: ${it.whisper || '(nothing)'} | B: ${it.gemini}] ${it.after}…`);
  const system = 'You check automatic captions of Christian sermons. Two different speech recognisers heard the same moment differently. You decide which is more likely what the preacher actually said. You reply with JSON only.';
  const prompt = `For each numbered moment, the words in brackets were heard two ways: A and B. The words around them are what was said before and after.

${lines.join('\n')}

Choose "A" or "B" — whichever is more likely what was actually said, given the sentence and that this is a sermon (scripture, prayer, church life). Speech recognisers mishear words that SOUND alike ("on the same" for "on the scene", "who at a never" for "who art in heaven", "salt hallelujah" for "shout hallelujah"). The preacher's own grammar can be imperfect — do not choose B just because it is more grammatical. If both are equally plausible, or you are not sure, answer "?".

Reply with only: {"picks":[{"id":1,"pick":"A"}]}`;
  return { system, prompt };
}
function parsePicks(text) {
  const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    const m = new Map();
    for (const p of (j && Array.isArray(j.picks) ? j.picks : [])) {
      const id = Math.round(+p.id), pick = String(p.pick || '').trim().toUpperCase();
      if (Number.isFinite(id) && (pick === 'A' || pick === 'B' || pick === '?')) m.set(id, pick);
    }
    return m;
  } catch (e) { return null; }
}

module.exports = { plan, apply, align, tokensOf, sameWords, refereePrompt, parsePicks, norm };
