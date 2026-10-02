'use strict';
/*
 * THE SONGS BANK.
 *
 * The Library is what is in THIS service. The bank is what the church sings —
 * the list you draw a service out of, week after week, without retyping a word.
 *
 * Two layers, merged on read:
 *
 *   the CATALOGUE  ships with the app (song-catalogue.js): titles, authors,
 *                  years, themes and the shape each song is sung in. No lyrics,
 *                  because worship lyrics are what a church's CCLI licence
 *                  covers and an app has no business shipping its own copy.
 *   the CHURCH'S   lives in <userData>/song-bank.json: songs the church added,
 *                  and — the important half — the WORDS put against catalogue
 *                  entries. Type "Way Maker" once and it is in the bank with
 *                  your arrangement for good.
 *
 * A catalogue entry is never edited in place; the church's file holds an
 * override keyed by the same id, so a future release can correct a credit or
 * add a song without touching anything the operator typed.
 *
 * `merge()` is what makes the bank useful on the first day rather than the
 * fiftieth: it pours the Library the church already has into the bank, matching
 * by title so "Goodness Of God" fills the catalogue entry instead of sitting
 * beside it as a near-duplicate.
 */
const fs = require('fs');
const path = require('path');
const { CATALOGUE, THEMES } = require('./song-catalogue');

let file = null;
let mine = { songs: [], hidden: [] };   // the church's own layer
let writeTimer = null;

function init(userDataDir) {
  file = path.join(userDataDir, 'song-bank.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    mine = {
      songs: Array.isArray(raw.songs) ? raw.songs : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    };
  } catch (e) { mine = { songs: [], hidden: [] }; }
  return list();
}

/* Saves are debounced for the same reason store.js debounces: this is the one
 * thread that also drives five studios, and banking twenty songs in a loop
 * must not be twenty synchronous disk writes. flushSync() on the way out. */
function queueWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => { writeTimer = null; writeNow(); }, 400);
}
function writeNow() {
  if (!file) return;
  try { fs.writeFileSync(file, JSON.stringify(mine, null, 2)); }
  catch (e) { console.warn('[songbank] could not save: ' + e.message); }
}
function flushSync() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; writeNow(); }
}

/* ------------------------------- matching -------------------------------- */
/*
 * Two titles are the same song when they LOOK the same to a person. Case,
 * punctuation, accents and "The " all vary between whoever typed it and
 * whoever printed it, and none of them mean anything.
 *
 * `base` additionally drops a parenthetical, so the church's "10,000 Reasons"
 * finds the catalogue's "10,000 Reasons (Bless The Lord)" — the commonest shape
 * of the same-song-different-title problem in a worship list.
 */
function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents, not letters
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/^\s*the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}
const baseOf = (s) => norm(String(s || '').replace(/\([^)]*\)/g, ''));
const keysOf = (title) => ({ key: norm(title), base: baseOf(title) || norm(title) });

/** Does this bank entry have words the operator could put on a screen? */
const hasWords = (s) => !!(s && String(s.words || '').trim());

/* -------------------------------- reading -------------------------------- */
/**
 * The whole bank, catalogue and church merged, newest-useful-first.
 *
 * Ordering is deliberate: songs with words come before songs without, because
 * the ones with words are the ones that can go straight into Sunday. Within
 * each half it is alphabetical, which is how anybody looks for a title.
 */
function list() {
  const overrides = new Map();
  const own = [];
  for (const s of mine.songs) {
    if (String(s.source) === 'builtin' || CATALOGUE.some((c) => c.id === s.id)) overrides.set(s.id, s);
    else own.push(s);
  }
  const hidden = new Set(mine.hidden || []);
  const out = [];
  for (const c of CATALOGUE) {
    if (hidden.has(c.id)) continue;
    const o = overrides.get(c.id);
    out.push(Object.assign({}, c, o || {}, { source: 'builtin', mine: !!o, ready: hasWords(o || c) }));
  }
  for (const s of own) {
    if (hidden.has(s.id)) continue;
    out.push(Object.assign({ themes: [], sections: [], words: '', ccli: '', key: '' }, s,
      { source: 'mine', mine: true, ready: hasWords(s) }));
  }
  out.sort((a, b) => (b.ready ? 1 : 0) - (a.ready ? 1 : 0) || String(a.title).localeCompare(String(b.title)));
  return out;
}

/* -------------------------------- writing -------------------------------- */
/**
 * Add a song, or put words against one that is already there.
 *
 * The id decides which: a catalogue id becomes an override (so the credit and
 * the themes keep coming from the catalogue, and only what the church typed is
 * stored), anything else is the church's own song.
 */
function save(song) {
  if (!song || !String(song.title || '').trim()) throw new Error('A song needs a title.');
  const known = CATALOGUE.find((c) => c.id === song.id);
  const id = song.id || ('mine-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7));
  const clean = {
    id,
    title: String(song.title).trim(),
    author: String(song.author || '').trim(),
    year: Number(song.year) || 0,
    themes: Array.isArray(song.themes) ? song.themes.slice(0, 6) : [],
    sections: Array.isArray(song.sections) ? song.sections : [],
    words: String(song.words || ''),
    ccli: String(song.ccli || '').trim(),
    key: String(song.key || '').trim(),
    source: known ? 'builtin' : 'mine',
    updated: Date.now(),
  };
  const at = mine.songs.findIndex((s) => s.id === id);
  if (at >= 0) mine.songs[at] = clean; else mine.songs.push(clean);
  // Adding back something that was removed should un-remove it.
  mine.hidden = (mine.hidden || []).filter((h) => h !== id);
  queueWrite();
  return clean;
}

/**
 * Take it out of the bank.
 *
 * A catalogue entry cannot be deleted from disk, so it is remembered as hidden
 * — and any words the church had typed against it go with it, because leaving
 * them behind would resurrect them the moment anyone unhid it.
 */
function remove(id) {
  mine.songs = mine.songs.filter((s) => s.id !== id);
  if (CATALOGUE.some((c) => c.id === id)) {
    mine.hidden = Array.from(new Set((mine.hidden || []).concat([id])));
  }
  queueWrite();
  return list();
}

/**
 * Pour a Library into the bank.
 *
 * This is the button that makes a bank worth having on day one: a church that
 * has been using the studio all term already has its own arrangements typed,
 * and they belong in the bank rather than being retyped into it. Matching by
 * title means those words land IN the catalogue entry — one "Goodness Of God",
 * with the church's words, credited to Bethel.
 *
 * Songs with no words are skipped: the bank already knows every title in the
 * catalogue, so importing empty shells would only add noise. Words never
 * overwrite words — if the bank already has an arrangement, the operator's
 * existing one wins and nothing is silently replaced.
 */
function merge(songs) {
  const current = list();
  const byKey = new Map();
  for (const s of current) {
    const k = keysOf(s.title);
    if (!byKey.has(k.key)) byKey.set(k.key, s);
    if (!byKey.has('~' + k.base)) byKey.set('~' + k.base, s);
  }
  let added = 0, filled = 0, skipped = 0;
  for (const in_ of (songs || [])) {
    const title = String(in_.title || '').trim();
    const words = String(in_.words || '').trim();
    if (!title || !words) { skipped++; continue; }
    const k = keysOf(title);
    const hit = byKey.get(k.key) || byKey.get('~' + k.base);
    if (hit) {
      if (hasWords(hit)) { skipped++; continue; }     // never clobber an arrangement
      save(Object.assign({}, hit, { words, sections: in_.sections || hit.sections, key: in_.key || hit.key }));
      filled++;
    } else {
      const made = save({ title, author: in_.author || '', year: in_.year || 0,
        themes: in_.themes || [], sections: in_.sections || [], words, key: in_.key || '' });
      byKey.set(k.key, made); byKey.set('~' + k.base, made);
      added++;
    }
  }
  return { added, filled, skipped, total: list().length };
}

module.exports = { init, list, save, remove, merge, flushSync, THEMES, hasWords, keysOf };
