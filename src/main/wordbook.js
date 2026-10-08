'use strict';
/*
 * THE WORD BOOK, as it lives on disk — <userData>/word-book.json.
 *
 * The matching itself is in src/renderer/wordbook.js, which is a pure module
 * shared by both processes on purpose: the studio has to be able to fix a line
 * the instant it is typed (no round trip), and every transcription has to come
 * out of the main process already fixed. Two copies of that logic would sooner
 * or later disagree about the same sentence, so there is one.
 *
 * What this file adds is everything the pure module must not know about: the
 * file, the debounced write, and the POLICY for what gets remembered.
 *
 * THE POLICY, in one paragraph
 *
 * A correction of a word that is not English ("a fee shins" → "Ephesians") is
 * trusted the first time: whisper inventing a non-word is not a matter of
 * opinion, and re-typing it next Sunday is precisely the waste this feature
 * exists to end. A correction of one EVERYDAY word into another is a judgement
 * about one sentence and is never stored bare — the engine widens it with the
 * words around it first, or drops it (see learnFromEdit). Nothing may contradict
 * a rule already in the book. And a book written under the older rule, which
 * counted sightings instead, is tidied when it is loaded. Everything can be
 * switched on, off, re-spelled or deleted by hand in the Word Book panel,
 * because the operator's ear beats every rule in here.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const engine = require('../renderer/wordbook.js');
const space = require('./space');

/** Enough for years of Sundays; the oldest unused entries go first if it fills. */
const MAX_FIXES = 4000;
const MAX_TERMS = 2000;
const WRITE_DELAY_MS = 400;

/*
 * ONE BOOK FOR THE WHOLE CHURCH. It used to be one per person (each space its
 * own, see space.js), so a name one of the team taught — the pastor's, the
 * church's — was still misspelt in everyone else's captions. A church's names
 * are the same for all of them, so there is now one book, <userData>/
 * word-book.json, that everybody reads and teaches. The books people had of
 * their own are folded into it once (foldSpaces), so nothing taught is lost.
 */
let baseDir = null;
const states = new Map();     // space id ('' = owner) -> { file, book, compiled, writeTimer, lastTidy }
function fileFor(id) {
  if (!id) return path.join(baseDir, 'word-book.json');
  return path.join(space.pathFor(path.join(baseDir, 'wordbook'), id), 'word-book.json');
}
function S() {
  const id = '';      // the church's one book, whoever is asking
  let st = states.get(id);
  if (!st) { st = loadState(id); states.set(id, st); }
  return st;
}

const newId = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const nowIso = () => new Date().toISOString();

function blank() {
  return { version: engine.VERSION, enabled: true, soundAlike: true, fixes: [], terms: [], fixedTotal: 0 };
}

/** Never trust the file: it is JSON a person could have edited. */
function sanitise(raw) {
  const b = blank();
  if (!raw || typeof raw !== 'object') return b;
  b.enabled = raw.enabled !== false;
  b.soundAlike = raw.soundAlike !== false;
  b.fixedTotal = Number(raw.fixedTotal) || 0;
  b.version = Number(raw.version) || 1;
  if (raw.folded) b.folded = true;
  const seenFrom = new Set();
  for (const f of (Array.isArray(raw.fixes) ? raw.fixes : [])) {
    if (!f || typeof f !== 'object') continue;
    const from = engine.normPhrase(f.from);
    const to = String(f.to == null ? '' : f.to).trim();
    if (!from || !to || seenFrom.has(from)) continue;
    if (engine.normPhrase(to) === from) continue;
    if (from.split(' ').length > engine.MAX_N) continue;
    seenFrom.add(from);
    b.fixes.push({
      id: String(f.id || newId()),
      widened: !!f.widened,
      from,
      to,
      on: f.on !== false,
      risky: !!f.risky,
      src: f.src === 'user' ? 'user' : 'learned',
      count: Math.max(1, Number(f.count) || 1),
      hits: Math.max(0, Number(f.hits) || 0),
      createdAt: f.createdAt || nowIso(),
      lastAt: f.lastAt || f.createdAt || nowIso(),
    });
  }
  const seenTerm = new Set();
  for (const t of (Array.isArray(raw.terms) ? raw.terms : [])) {
    const text = String((t && t.text) != null ? t.text : t || '').trim();
    const n = engine.normPhrase(text);
    if (!n || seenTerm.has(n)) continue;
    seenTerm.add(n);
    b.terms.push({
      id: String((t && t.id) || newId()),
      text,
      src: (t && t.src) === 'learned' ? 'learned' : 'user',
      createdAt: (t && t.createdAt) || nowIso(),
    });
  }
  return b;
}

function loadState(id) {
  const st = { file: baseDir ? fileFor(id) : null, book: null, compiled: null, writeTimer: null, lastTidy: null };
  try { st.book = sanitise(JSON.parse(fs.readFileSync(st.file, 'utf-8'))); }
  catch (e) { st.book = blank(); }
  /*
   * A BOOK WRITTEN UNDER THE OLD RULE IS TIDIED BEFORE IT IS EVER USED.
   *
   * Not offered as a choice: the entries it removes are actively wrong on every
   * video from now on, and one of them was cancelling another out. What it takes
   * out is reported so the studio can say so rather than quietly editing
   * somebody's settings behind their back.
   */
  if (!id && !st.book.folded) foldSpaces(st);
  if ((st.book.version || 1) < engine.VERSION) {
    states.set(id, st);       // tidy() works on the current space's book
    const r = tidy();
    st.book.version = engine.VERSION;
    if (r.removed) st.lastTidy = r;
    writeNow(st);
  }
  return st;
}
/*
 * Each person's own book, folded into the church's once: what they taught is
 * kept (a correction the church book already has keeps the church's), and
 * their files are left where they are.
 */
function foldSpaces(st) {
  st.book.folded = true;
  let dir = null;
  try { const r = space.rootOf('aaaaaa'); dir = r ? path.dirname(r) : null; } catch (e) {}
  let n = 0;
  if (dir) {
    let ids = [];
    try { ids = fs.readdirSync(dir).filter(space.validId); } catch (e) {}
    const fixFrom = new Set(st.book.fixes.map((f) => f.from));
    const termN = new Set(st.book.terms.map((t) => engine.normPhrase(t.text)));
    for (const id of ids) {
      let b;
      try { b = sanitise(JSON.parse(fs.readFileSync(path.join(dir, id, 'wordbook', 'word-book.json'), 'utf-8'))); } catch (e) { continue; }
      for (const f of b.fixes) if (!fixFrom.has(f.from)) { fixFrom.add(f.from); st.book.fixes.push(f); n++; }
      for (const t of b.terms) { const k = engine.normPhrase(t.text); if (!termN.has(k)) { termN.add(k); st.book.terms.push(t); n++; } }
    }
  }
  if (n) console.log(`[wordbook] ${n} words from the team's own books are now in the church's Word Book`);
  writeNow(st);
}

function init(userDataDir) {
  baseDir = userDataDir;
  states.clear();
  return S().file;
}

/** What the last load had to clean up, for the studio to report once. */
const tidyReport = () => S().lastTidy;

/* Debounced like every other store in the app: this thread also drives five
 * studios, and learning eight corrections out of one edited line must not be
 * eight synchronous disk writes. flushSync() on the way out. */
function queueWrite() {
  const st = S();
  if (st.writeTimer) return;
  st.writeTimer = setTimeout(() => { st.writeTimer = null; writeNow(st); }, WRITE_DELAY_MS);
}
function writeNow(st) {
  st = st || S();
  if (!st.file || !st.book) return;
  try {
    fs.mkdirSync(path.dirname(st.file), { recursive: true });
    const tmp = st.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(st.book, null, 2), 'utf-8');
    fs.renameSync(tmp, st.file);
  } catch (e) {
    try { fs.writeFileSync(st.file, JSON.stringify(st.book, null, 2), 'utf-8'); }
    catch (e2) { console.warn('[wordbook] could not save: ' + e2.message); }
  }
}
/** Every space's pending write, now (on the way out). */
function flushSync() {
  for (const st of states.values()) {
    if (st.writeTimer) { clearTimeout(st.writeTimer); st.writeTimer = null; writeNow(st); }
  }
}
function changed() { S().compiled = null; queueWrite(); }

function get() {
  const st = S();
  if (!st.book) st.book = blank();
  return st.book;
}

/** The compiled lookup tables — built once per change, not once per word. */
function matcher() {
  const st = S();
  if (!st.compiled) st.compiled = engine.compile(get());
  return st.compiled;
}

/** What the Word Book panel shows. Newest first: the thing you just taught it
 *  is the thing you want to see, and to be able to undo. */
function view() {
  const b = get();
  return {
    enabled: b.enabled,
    soundAlike: b.soundAlike,
    fixedTotal: b.fixedTotal || 0,
    seedTerms: engine.SEED_TERMS.length,
    fixes: b.fixes.slice().sort((x, y) => String(y.lastAt).localeCompare(String(x.lastAt))),
    terms: b.terms.slice().sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))),
  };
}

function setOptions(opts) {
  const b = get();
  if (opts && typeof opts.enabled === 'boolean') b.enabled = opts.enabled;
  if (opts && typeof opts.soundAlike === 'boolean') b.soundAlike = opts.soundAlike;
  changed();
  return view();
}

/** Oldest-unused entries go when the book is full, so it can run for years. */
function trim() {
  const b = get();
  if (b.fixes.length > MAX_FIXES) {
    b.fixes.sort((x, y) => String(y.lastAt).localeCompare(String(x.lastAt)));
    b.fixes.length = MAX_FIXES;
  }
  if (b.terms.length > MAX_TERMS) {
    b.terms.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    b.terms.length = MAX_TERMS;
  }
}

/**
 * Put one correction in the book.
 *
 * `src:'user'` — typed into the panel by hand — is always on, because the
 * operator asking for it IS the evidence. A learned one follows the policy at
 * the top of this file.
 */
function addFix({ from, to, src = 'user', on }) {
  const b = get();
  const f = engine.normPhrase(from);
  const t = String(to == null ? '' : to).trim();
  if (!f) return { ok: false, reason: 'Type the word as the captions get it wrong.' };
  if (!t) return { ok: false, reason: 'Type the word as it should be written.' };
  if (engine.normPhrase(t) === f) return { ok: false, reason: 'Those two are the same word.' };
  if (f.split(' ').length > engine.MAX_N) return { ok: false, reason: `A correction can span at most ${engine.MAX_N} words.` };

  const risky = f.split(' ').length === 1 && engine.isCommonWord(f);
  /*
   * A CORRECTION MAY NOT CONTRADICT ONE ALREADY IN THE BOOK.
   *
   * Seen in a real church's book, both switched on: `he's → it's` AND
   * `it's → he's`. Every "he's" in a sermon became "it's" and every "it's"
   * became "he's", in the same pass, for ever. Neither entry is wrong on the
   * line it was learned from; together they are nonsense, and nothing in the
   * app noticed. So the reverse of a rule that already exists is refused, and
   * the existing one is switched off too — because a pair like that means the
   * word is context-dependent, which is exactly the kind of rule this book
   * should not be holding at all.
   */
  const nt = engine.normPhrase(t);
  const opposite = b.fixes.find((x) => x.from === nt && engine.normPhrase(x.to) === f);
  if (opposite) {
    opposite.on = false;
    changed();
    return { ok: false, conflict: true, reason:
      `The book already turns “${opposite.from}” into “${opposite.to}”, so this would undo it — `
      + `that word depends on the sentence it is in. Both have been left switched off; `
      + `the line you just typed is corrected, and only that line.` };
  }
  const existing = b.fixes.find((x) => x.from === f);
  let promoted = false, added = false;
  if (existing) {
    const sameTo = engine.normPhrase(existing.to) === engine.normPhrase(t);
    existing.to = t;
    existing.count = sameTo ? existing.count + 1 : 1;
    existing.lastAt = nowIso();
    existing.risky = risky;
    if (src === 'user' || on === true) existing.on = true;
    else if (!existing.on && (!risky || existing.count >= 2)) { existing.on = true; promoted = true; }
    if (src === 'user') existing.src = 'user';
  } else {
    b.fixes.push({
      id: newId(), from: f, to: t,
      on: on != null ? !!on : (src === 'user' ? true : !risky),
      risky, src: src === 'user' ? 'user' : 'learned',
      count: 1, hits: 0, createdAt: nowIso(), lastAt: nowIso(),
    });
    added = true;
  }
  // The right-hand side is also a spelling to SOUND LIKE from now on, so the
  // next variant of the same name is caught without being taught.
  autoTerm(t);
  trim();
  changed();
  const fix = b.fixes.find((x) => x.from === f);
  return { ok: true, added, promoted, waiting: !fix.on, fix };
}

/** A single distinctive word on the right of a correction becomes a term. */
function autoTerm(text) {
  const b = get();
  const n = engine.normPhrase(text);
  if (!n || n.indexOf(' ') >= 0) return false;
  if (!engine.isSoundTerm(n)) return false;
  if (b.terms.some((x) => engine.normPhrase(x.text) === n)) return false;
  b.terms.push({ id: newId(), text: String(text).trim(), src: 'learned', createdAt: nowIso() });
  return true;
}

function updateFix(id, patch) {
  const b = get();
  const f = b.fixes.find((x) => x.id === id);
  if (!f) return { ok: false, reason: 'That correction is no longer in the book.' };
  if (patch && patch.to != null) {
    const t = String(patch.to).trim();
    if (!t) return { ok: false, reason: 'Type the word as it should be written.' };
    if (engine.normPhrase(t) === f.from) return { ok: false, reason: 'Those two are the same word.' };
    f.to = t;
    autoTerm(t);
  }
  if (patch && patch.from != null) {
    const nf = engine.normPhrase(patch.from);
    if (!nf) return { ok: false, reason: 'Type the word as the captions get it wrong.' };
    if (nf !== f.from && b.fixes.some((x) => x.from === nf && x.id !== id)) return { ok: false, reason: 'That word is already in the book.' };
    f.from = nf;
    f.risky = nf.split(' ').length === 1 && engine.isCommonWord(nf);
  }
  if (patch && typeof patch.on === 'boolean') f.on = patch.on;
  f.lastAt = nowIso();
  changed();
  return { ok: true, fix: f };
}

function removeFix(id) {
  const b = get();
  const i = b.fixes.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false };
  b.fixes.splice(i, 1);
  changed();
  return { ok: true };
}

function addTerm(text) {
  const b = get();
  const t = String(text == null ? '' : text).trim();
  const n = engine.normPhrase(t);
  if (!n) return { ok: false, reason: 'Type the name or word as it should be spelled.' };
  if (b.terms.some((x) => engine.normPhrase(x.text) === n)) return { ok: false, reason: 'That is already in the book.' };
  if (!engine.isSoundTerm(n)) {
    return {
      ok: false,
      reason: engine.lettersOf(n).length < engine.SOUND_MIN_TERM_LEN
        ? 'That word is too short to match on sound alone — add it as a correction instead (the wrong word on the left, the right one on the right).'
        : 'That is an everyday English word, so matching it by sound would change ordinary sentences. Add it as a correction instead.',
    };
  }
  b.terms.push({ id: newId(), text: t, src: 'user', createdAt: nowIso() });
  trim();
  changed();
  return { ok: true, term: b.terms[b.terms.length - 1] };
}

function removeTerm(id) {
  const b = get();
  const i = b.terms.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false };
  b.terms.splice(i, 1);
  changed();
  return { ok: true };
}

/**
 * Learn from lines that were retyped in the captions window.
 *
 * `edits` is [{ before, after }] — what the line said and what it says now.
 * Returns a plain-English summary the studio can put in a toast, because a
 * feature that quietly changes future behaviour without saying so is a feature
 * nobody trusts.
 */
function learnFromEdits(edits) {
  const learned = [], waiting = [], conflicts = [];
  for (const e of (edits || [])) {
    for (const cand of engine.learnFromEdit(e && e.before, e && e.after, e && e.ctx)) {
      const r = addFix({ from: cand.from, to: cand.to, src: 'learned' });
      if (!r.ok) { if (r.conflict) conflicts.push({ from: cand.from, to: cand.to, reason: r.reason }); continue; }
      (r.waiting ? waiting : learned).push({
        from: cand.from, to: cand.to, promoted: !!r.promoted, added: !!r.added, widened: !!cand.widened,
      });
    }
  }
  return { learned, waiting, conflicts, count: learned.length + waiting.length };
}

/**
 * TIDY UP A BOOK LEARNED UNDER THE OLD RULE.
 *
 * Before context-widening, a single everyday word swapped for another was
 * written down and switched on once it had been seen twice — so a book filled
 * up with rules like `there → that`, `his → A`, `was → must` and `they → the`,
 * every one of them true of one sentence and wrong in the next. A real church's
 * book had 142 of them, including a pair that cancelled each other out.
 *
 * They are removed, not merely switched off: they are not facts about words, and
 * leaving 142 dead rows in the panel makes the ones that MATTER impossible to
 * find. Names, phrases and anything the operator typed in by hand are kept.
 */
function tidy() {
  const b = get();
  const before = b.fixes.length;
  const kept = [], dropped = [];
  const isBare = (f) => {
    if (f.src === 'user') return false;                    // typed in by hand: their call, not ours
    const from = String(f.from || '');
    const to = engine.normPhrase(f.to);
    return from.split(' ').length === 1 && to.split(' ').length === 1 && engine.isCommonWord(from);
  };
  for (const f of b.fixes) (isBare(f) ? dropped : kept).push(f);
  // …and any pair that undoes itself, whichever way round it was learned.
  const byFrom = new Map(kept.map((f) => [f.from, f]));
  const cyc = [];
  for (const f of kept) {
    const other = byFrom.get(engine.normPhrase(f.to));
    if (other && other !== f && engine.normPhrase(other.to) === f.from) { cyc.push(f); cyc.push(other); }
  }
  const final = kept.filter((f) => !cyc.includes(f));
  for (const f of cyc) dropped.push(f);
  b.fixes = final;
  changed();
  return { before, after: b.fixes.length, removed: dropped.length,
           examples: dropped.slice(0, 6).map((f) => `${f.from} → ${f.to}`) };
}

/**
 * Fix a transcription. Handed either whisper's WORD entries (one word each) or
 * its SEGMENT entries (a phrase each) — told apart by whether the text has a
 * space in it, so callers never have to say which they have.
 */
function apply(entries) {
  const src = entries || [];
  const m = matcher();
  if (m.empty || !src.length) return { entries: src, changes: [], count: 0 };
  const lineMode = src.some((e) => e && typeof e.text === 'string' && /\s/.test(e.text.trim()));
  const r = lineMode ? engine.applyToLines(src, m) : engine.applyToWords(src, m);
  const out = lineMode ? r.lines : r.words;
  if (r.count) {
    const b = get();
    b.fixedTotal = (b.fixedTotal || 0) + r.count;
    const stamp = nowIso();
    for (const c of r.changes) {
      if (!c.id) continue;
      const f = b.fixes.find((x) => x.id === c.id);
      if (f) { f.hits = (f.hits || 0) + 1; f.lastAt = stamp; }
    }
    changed();
  }
  return { entries: out, changes: r.changes, count: r.count };
}

/** A short "what it fixed" line for a toast: the words, not the numbers. */
function summarise(changes, limit = 3) {
  const byTo = new Map();
  for (const c of (changes || [])) byTo.set(c.to, (byTo.get(c.to) || 0) + 1);
  const parts = [...byTo.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([to, n]) => (n > 1 ? `${to} ×${n}` : to));
  const more = byTo.size - parts.length;
  return parts.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

module.exports = {
  init, get, view, matcher, setOptions, tidy, tidyReport,
  addFix, updateFix, removeFix, addTerm, removeTerm,
  learnFromEdits, apply, summarise, flushSync,
  MAX_FIXES, MAX_TERMS,
  engine,
};
