'use strict';
/*
 * ►► A PROOFREADER THAT LISTENS AGAIN. ◄◄
 *
 * After Gemini's words and Whisper's timing are put together (captionfuse.js)
 * a few mistakes are left that EVERY ear made — measured on a real sermon:
 * "have read that" for "have real dad", "If thou shall keep" for "shalt",
 * "your feel of love" for "fill". No vote between ears can fix those: nobody
 * heard it right. What finds them is what found them in that measurement — a
 * reader going through the finished captions for words that make no sense
 * where they are. What settles them is the audio:
 *
 *   1. Gemini reads the captions five minutes at a time (with what the second
 *      Whisper ear heard beside each line) and lists the phrases that are very
 *      probably not what was said, each with its best guess — never the
 *      preacher's own grammar, his idioms, fillers or repeats.
 *   2. For each, the few seconds of audio are cut out and Gemini LISTENS to
 *      them, given the caption's version and the guess in no telling order:
 *      which is exactly what is said? Only a clear answer for the guess
 *      changes the caption; "neither / cannot tell" leaves it, listed for a look.
 *
 * Free (the same Gemini key); about a minute for a sermon.
 */
const gem = require('./geminiear');
const { norm, display } = require('./captionfuse');

const mid = (w) => ((+w.start) + (+w.end)) / 2;
const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
const toks = (t) => String(t || '').split(/\s+/).map(norm).filter(Boolean);

/** The caption words as numbered lines (a sentence, or 16 words at most). */
function linesOf(words, alt) {
  const lines = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const n = i - i0 + 1;
    if ((/[.?!]$/.test(words[i].text) && n >= 4) || n >= 16 || i === words.length - 1) {
      const ws = words.slice(i0, i + 1);
      const a = +ws[0].start, b = +ws[ws.length - 1].end;
      const heard = (alt || []).filter((w) => mid(w) >= a - 0.1 && mid(w) <= b + 0.1).map((w) => w.text).join(' ');
      const same = toks(heard).join(' ') === ws.map((w) => norm(w.text)).filter(Boolean).join(' ');
      lines.push({ n: lines.length + 1, i0, i1: i, start: a, text: ws.map((w) => w.text).join(' '), alt: heard && !same ? heard : '' });
      i0 = i + 1;
    }
  }
  return lines;
}

function proofreadPrompt(lines) {
  const body = lines.map((l) => `#${l.n} [${fmt(l.start)}] ${l.text}` + (l.alt ? `\n      (another recogniser heard: ${l.alt})` : '')).join('\n');
  return 'You are proofreading the automatic captions of a Christian sermon (a live church service; the preacher may speak Nigerian, '
    + 'African or other non-standard English). Each numbered line is a caption; where another speech recogniser heard it differently, '
    + 'that is shown beneath it (its line boundaries are approximate).\n\n'
    + 'Find every place where the caption is very probably NOT what the preacher actually said: a misheard word or phrase that makes no sense '
    + 'where it is, a dropped "not", a wrong name, wrong scripture wording (quotes are often the King James Version), a word that was obviously '
    + 'never said. Use the sentence, the lines around it, Bible and church knowledge, and the other recogniser.\n\n'
    + 'Do NOT report: punctuation or capital letters; the preacher\'s own grammar or idioms ("he say", "what usually happen"); filler '
    + 'words; repeated words; spelling variants; numbers written as words or digits. Do not invent problems: most lines are right.\n\n'
    + 'For each problem give the line number, the exact words from that caption line that are wrong (1 to 6 words, copied exactly), '
    + 'and what was most likely said instead (plain words, no brackets or notes).\n\n'
    + body + '\n\nReply with JSON only: {"fixes":[{"line":12,"heard":"exact caption words","likely":"what was said"}]}';
}
function parseJson(text) {
  const s = String(text || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

/*
 * Only his grammar, not a mishearing: "send" / "sent", "answers" / "answer",
 * "approach" / "approached", "an evil spirit" / "the evil spirits", "have" /
 * "had". Measured: the proofreader suggested these despite being told not to,
 * and a clip cannot tell such near-identical sounds apart — the re-listen
 * then picked the tidier grammar. A caption keeps how he speaks, so these are
 * never asked. (A word added or taken away — "do not learn", "that SHALL not
 * be you" — is not grammar, and is asked.)
 */
const CLASSES = [['a', 'an', 'the', 'this', 'that'], ['is', 'are', 'was', 'were', 'be', 'being', 'been', 'am'], ['have', 'has', 'had', 'having'],
  ['do', 'does', 'did'], ['will', 'would', 'shall', 'should', 'can', 'could'], ['he', 'she', 'they', 'it'], ['him', 'her', 'them'], ['his', 'their', 'its']];
function inflection(a, b) {
  if (a === b) return true;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 3 && t.startsWith(s) && ['s', 'es', 'ed', 'd', 'ing', "'s", 'n'].includes(t.slice(s.length))) return true;
  if (a.length === b.length && a.length >= 3 && a.slice(0, -1) === b.slice(0, -1) && /[dt]/.test(a.slice(-1)) && /[dt]/.test(b.slice(-1))) return true;
  return CLASSES.some((c) => c.includes(a) && c.includes(b));
}
function grammarOnly(h, l) {
  // the words that differ, in order, on each side
  const n = h.length, m = l.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = h[i] === l[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const dh = [], dl = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (h[i] === l[j]) { i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) dh.push(h[i++]); else dl.push(l[j++]);
  }
  while (i < n) dh.push(h[i++]);
  while (j < m) dl.push(l[j++]);
  return dh.length > 0 && dh.length === dl.length && dh.every((x, k) => inflection(x, dl[k]));
}

/** A proofreader's note → the caption words it means ([a, b] indices), or null. */
function locate(fix, lines, words) {
  const line = lines.find((l) => l.n === Math.round(+fix.line));
  if (!line) return null;
  const h = toks(fix.heard), likely = toks(fix.likely);
  if (!h.length || h.length > 8 || !likely.length || likely.length > h.length * 3 + 3) return null;
  if (/[()[\]?]|unclear|inaudible|nothing/i.test(String(fix.likely))) return null;
  if (h.join(' ') === likely.join(' ') || grammarOnly(h, likely)) return null;
  // within the line (a phrase may run on into the next one)
  const lo = line.i0, hi = Math.min(words.length - 1, line.i1 + h.length);
  for (let a = lo; a <= hi - h.length + 1; a++) {
    let k = 0, b = a;
    for (; b <= hi && k < h.length; b++) {
      const t = norm(words[b].text);
      if (!t) continue;
      if (t !== h[k]) break;
      k++;
    }
    if (k === h.length) return { a, b: b - 1 };
  }
  return null;
}

/** The re-listen question for a batch of clips. */
function relistenPrompt(items) {
  const lines = items.map((it, k) => {
    const one = it.flip ? it.proposed : it.current, two = it.flip ? it.current : it.proposed;
    return `Clip ${k + 1}: (1) "${one}"  (2) "${two}"`;
  });
  return 'Each clip above is a few seconds of a sermon (it may start or end in the middle of a word). For each clip, two transcriptions '
    + 'are given; they differ only in a few words. Listen carefully and choose the one that is EXACTLY what the speaker says in the clip — '
    + 'the sounds, not which reads better. If neither is right, or you cannot tell, answer 0.\n\n'
    + lines.join('\n') + '\n\nReply with JSON only: {"answers":[{"clip":1,"choice":1}]}';
}

const pool = async (items, n, fn) => {
  let next = 0;
  const run = async () => { while (next < items.length) { const k = next++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, run));
};

/**
 * words: the finished caption words (span clock); alt: the second ear's;
 * input/from: the recording and where the span starts in it.
 * Returns { words, unsure: [word objects], report }.
 */
async function proofread({ words, alt, input, from = 0, windowSec = 300, batch = 12, fetchImpl, encode = gem.encodeFlac, onProgress = null } = {}) {
  const report = { windows: 0, suspects: 0, located: 0, asked: 0, changed: 0, kept: 0, unsure: 0, why: '', readMs: 0, listenMs: 0 };
  let tick = Date.now();
  const W = Array.isArray(words) ? words : [];
  if (!gem.ready() || W.length < 4) return { words: W, unsure: [], report };
  const opt = fetchImpl ? { fetchImpl } : {};
  const lines = linesOf(W, alt);
  // 1. read: five minutes at a time, three at once
  const windows = [];
  for (const l of lines) {
    const k = Math.floor(l.start / windowSec);
    (windows[k] = windows[k] || []).push(l);
  }
  const groups = windows.filter(Boolean);
  report.windows = groups.length;
  const fixes = [];
  let done = 0;
  await pool(groups, 3, async (g) => {
    try {
      const r = await gem.ask([{ text: proofreadPrompt(g) }], Object.assign({ json: true, think: 'low', maxTokens: 8192 }, opt));
      const j = parseJson(r.text);
      for (const f of (j && Array.isArray(j.fixes) ? j.fixes : [])) if (f && f.heard && f.likely) fixes.push(f);
    } catch (e) {
      if (e && e.cancelled) throw e;
      report.why = (e && e.message) || 'the proofreader did not answer';
    }
    done++;
    if (onProgress) { try { onProgress(done / (groups.length * 2)); } catch (e) {} }
  });
  report.suspects = fixes.length;
  report.readMs = Date.now() - tick; tick = Date.now();
  // where they are, one per place
  const items = [];
  const taken = new Set();
  for (const f of fixes) {
    const at = locate(f, lines, W);
    if (!at) continue;
    let clash = false;
    for (let i = at.a; i <= at.b; i++) if (taken.has(i)) clash = true;
    if (clash) continue;
    for (let i = at.a; i <= at.b; i++) taken.add(i);
    const ctxB = W.slice(Math.max(0, at.a - 4), at.a).map((w) => w.text).join(' ');
    const ctxA = W.slice(at.b + 1, at.b + 5).map((w) => w.text).join(' ');
    const heard = W.slice(at.a, at.b + 1).map((w) => w.text).join(' ');
    const likely = String(f.likely).split(/\s+/).map(display).filter((t) => norm(t)).join(' ');
    const t0 = Math.max(0, +W[Math.max(0, at.a - 2)].start - 0.4), t1 = +W[Math.min(W.length - 1, at.b + 2)].end + 0.4;
    items.push({ a: at.a, b: at.b, heard, likely, t0, t1,
      current: [ctxB, heard, ctxA].filter(Boolean).join(' '), proposed: [ctxB, likely, ctxA].filter(Boolean).join(' '), flip: items.length % 2 === 1 });
  }
  report.located = items.length;
  // 2. listen again: a few clips per question
  const batches = [];
  for (let k = 0; k < items.length; k += batch) batches.push(items.slice(k, k + batch));
  let heardDone = 0;
  await pool(batches, 2, async (bt) => {
    try {
      const parts = [];
      for (let k = 0; k < bt.length; k++) {
        const it = bt[k];
        const flac = await encode(input, from + it.t0, it.t1 - it.t0);
        parts.push({ text: `Clip ${k + 1}:` }, gem.audioPart(flac));
      }
      parts.push({ text: relistenPrompt(bt) });
      const r = await gem.ask(parts, Object.assign({ json: true, think: 'low', maxTokens: 4096 }, opt));
      const j = parseJson(r.text);
      for (const ans of (j && Array.isArray(j.answers) ? j.answers : [])) {
        const it = bt[Math.round(+ans.clip) - 1];
        if (!it) continue;
        const c = Math.round(+ans.choice);
        it.verdict = c === 0 ? 'unsure' : ((c === 2) !== it.flip ? 'proposed' : 'current');
      }
      report.asked += bt.length;
    } catch (e) {
      if (e && e.cancelled) throw e;
      report.why = (e && e.message) || 'the re-listen did not answer';
    }
    heardDone++;
    if (onProgress) { try { onProgress(0.5 + heardDone / (batches.length * 2)); } catch (e) {} }
  });
  report.listenMs = Date.now() - tick;
  // 3. what the audio confirmed goes in, in the old words' time
  const out = W.slice();
  const unsure = [];
  const changes = [];
  for (const it of items.slice().sort((x, y) => y.a - x.a)) {
    if (it.verdict === 'unsure' || !it.verdict) { if (it.verdict === 'unsure') { report.unsure++; for (let i = it.a; i <= it.b; i++) unsure.push(W[i]); } continue; }
    if (it.verdict === 'current') { report.kept++; continue; }
    const tk = it.likely.split(' ');
    const first = W[it.a], last = W[it.b];
    const s0 = +first.start, s1 = +last.end;
    const lens = tk.map((t) => Math.max(1, norm(t).length) + 1), total = lens.reduce((x, y) => x + y, 0);
    let t = s0;
    const repl = tk.map((tok, k) => {
      const d = Math.max(0.05 * tk.length, s1 - s0) * (lens[k] / total);
      const w = { text: tok, start: +t.toFixed(3), end: +(t + d).toFixed(3), src: 'relisten' };
      t += d;
      return w;
    });
    // the caption's own capital and closing punctuation stay
    if (/^[A-Z]/.test(first.text) && /^[a-z]/.test(repl[0].text)) repl[0].text = repl[0].text[0].toUpperCase() + repl[0].text.slice(1);
    const p = /[.?!,;:]$/.exec(last.text);
    if (p && !/[.?!,;:]$/.test(repl[repl.length - 1].text)) repl[repl.length - 1].text += p[0];
    out.splice(it.a, it.b - it.a + 1, ...repl);
    report.changed++;
    changes.push({ at: fmt(s0), was: it.heard, now: repl.map((w) => w.text).join(' ') });
  }
  report.changes = changes.reverse();
  return { words: out, unsure, report };
}

module.exports = { proofread, linesOf, locate, grammarOnly, proofreadPrompt, relistenPrompt, parseJson };
