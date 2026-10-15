'use strict';
/*
 * ►► THE CHURCH'S PICTURE LIBRARY. ◄◄
 *
 * The free allowance paints about thirty pictures a day; a church of a hundred
 * people making flyers wants hundreds. So nothing Cloudflare paints is thrown
 * away: every picture goes on the shelf, labelled with what it is for — the
 * kind of event (a prayer night, a Bible study, Easter…), the theme it was
 * painted as key art for ("Operation Samson": the chains), the light it is in
 * (royal blue, crimson, gold…) and its shape (post, story, square) — and the
 * next person making that kind of flyer gets one THEY HAVE NOT SEEN, free.
 * Painted for one, kept for all: by the second week the library answers most
 * boards and the day's allowance goes on what it does not have yet.
 *
 * The AI-lettered titles too: "PRAYER MEETING" in gold, read back and spelt
 * right, serves every prayer-meeting flyer after it (each person a lettering
 * they have not had). Only lettering that was read back correct is kept — a
 * misspelling must never be handed round.
 *
 * And it remembers what people asked for and it could not give (the "demand"),
 * with the recipe, so the allowance left at the end of the day paints exactly
 * that for tomorrow (flyerart's night filler).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let DIR = path.join(os.tmpdir(), 'mw-flyer-bank');
const MAX_PICS = () => Math.max(50, Number(process.env.FLYER_LIBRARY_MAX) || 2000);
const MAX_LETTERS = 300;
const MAX_SEEN = 400;
let idx = null;
let clock = () => Date.now();

function init(dir) { flush(); DIR = dir; idx = null; }
const indexFile = () => path.join(DIR, 'library.json');

function load() {
  if (idx) return idx;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(indexFile(), 'utf8')); } catch (e) { j = null; }
  idx = { pics: [], letters: [], demand: {}, letterDemand: {}, people: {}, nextPerson: 1, recent: {} };
  if (j && typeof j === 'object') {
    idx.recent = j.recent && typeof j.recent === 'object' ? j.recent : {};
    idx.people = j.people && typeof j.people === 'object' ? j.people : {};
    idx.nextPerson = Math.max(1, +j.nextPerson || 1);
    idx.pics = Array.isArray(j.pics) ? j.pics.filter((e) => e && e.id && e.file) : [];
    idx.letters = Array.isArray(j.letters) ? j.letters.filter((e) => e && e.id && e.file) : [];
    idx.demand = j.demand && typeof j.demand === 'object' ? j.demand : {};
    idx.letterDemand = j.letterDemand && typeof j.letterDemand === 'object' ? j.letterDemand : {};
  }
  return idx;
}
/* written a moment after a change (a rush of a hundred people is one write, not five hundred) */
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(flush, 1500);
  if (saveTimer.unref) saveTimer.unref();
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!idx) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = indexFile() + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, indexFile());
  } catch (e) { /* the next change tries again */ }
}
process.once('exit', flush);

/** post / story / square / wide, from a size */
function shapeOf(w, h) {
  const ar = (+w || 4) / (+h || 5);
  if (ar < 0.66) return 'story';
  if (ar < 0.9) return 'post';
  if (ar < 1.15) return 'square';
  return 'wide';
}
/** words of a theme or title, for matching: "Operation Samson!" → "operation samson" */
const keyOf = (s) => String(s || '').toLowerCase().replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 8).join(' ');
const newId = () => clock().toString(36) + crypto.randomBytes(4).toString('hex');
const extOf = (mime) => (/png/i.test(mime) ? '.png' : /webp/i.test(mime) ? '.webp' : '.jpg');

function write(buf, mime) {
  fs.mkdirSync(DIR, { recursive: true });
  const id = newId(), name = id + extOf(mime);
  fs.writeFileSync(path.join(DIR, name), buf);
  return { id, file: name };
}
function readOut(e) {
  try {
    const buf = fs.readFileSync(path.join(DIR, e.file));
    return `data:${e.mime || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch (er) { return null; }
}
const FILE_RX = /^[a-z0-9]{8,40}\.(png|jpg|webp)$/;
/** The file of a library picture, for the server to send (a name only — nothing outside the library). */
function filePath(name) {
  if (!FILE_RX.test(String(name || ''))) return '';
  const full = path.join(DIR, name);
  return fs.existsSync(full) ? full : '';
}
const exists = (e) => { try { return fs.statSync(path.join(DIR, e.file)).size > 0; } catch (er) { return false; } };
/* what a person was handed lately (the last sixty): never again soon, even once everything has been seen */
function recentOf(who) { const L = load(), c = codeOf(who, true); return L.recent[c] || (L.recent[c] = []); }
function remember(who, id) { const r = recentOf(who); r.push(id); if (r.length > 60) r.splice(0, r.length - 60); }
/* what goes back to the phone: the file's name (loaded as a picture, kept by the phone) — or the picture itself when asked */
function handOut(e, opts) {
  const o = { file: e.file, by: e.by, bank: true, id: e.id, tier: e.tier, tone: e.tone, themeArt: !!e.theme };
  if (opts && opts.inline) { o.dataUrl = readOut(e); if (!o.dataUrl) return null; }
  return o;
}
function drop(list, e) {
  const i = list.indexOf(e); if (i >= 0) list.splice(i, 1);
  try { fs.unlinkSync(path.join(DIR, e.file)); } catch (er) { /* gone already */ }
}
/* the least used, oldest go first when the shelf is full */
function prune(list, max) {
  if (list.length <= max) return;
  const order = list.slice().sort((a, b) => (a.uses || 0) - (b.uses || 0) || (a.at || 0) - (b.at || 0));
  for (const e of order.slice(0, list.length - max)) drop(list, e);
}
/* who has seen a picture: each person a small number (the index stays small with a hundred people) */
function codeOf(who, make) {
  const L = load();
  if (L.people[who]) return L.people[who];
  if (!make) return 0;
  L.people[who] = L.nextPerson++;
  return L.people[who];
}
const seenBy = (e, who) => { const c = codeOf(who, false); return !!c && Array.isArray(e.seen) && e.seen.includes(c); };
function markSeen(e, who) {
  if (!who) return;
  const c = codeOf(who, true);
  e.seen = Array.isArray(e.seen) ? e.seen : [];
  if (!e.seen.includes(c)) e.seen.push(c);
  if (e.seen.length > MAX_SEEN) e.seen.splice(0, e.seen.length - MAX_SEEN);
}

/* ------------------------------------------------------------- pictures */

/**
 * Put a painted picture on the shelf. meta: { kind, theme, tone, shape, tier, by, prompt }.
 * `who` has seen it (it was painted for them). → the entry
 */
function add(buf, mime, meta = {}, who) {
  if (!buf || buf.length < 4000) return null;
  const L = load();
  const { id, file } = write(buf, mime);
  const e = {
    id, file, mime: mime || 'image/jpeg', at: clock(), uses: who ? 1 : 0, seen: [],
    kind: keyOf(meta.kind) || 'general', theme: keyOf(meta.theme), tone: String(meta.tone || 'own').slice(0, 20),
    shape: meta.shape || 'post', tier: meta.tier === 'premium' ? 'premium' : 'normal', by: String(meta.by || '').slice(0, 80),
    people: meta.people !== false, prompt: String(meta.prompt || '').slice(0, 300),
  };
  markSeen(e, who);
  L.pics.push(e);
  prune(L.pics, MAX_PICS());
  save();
  return e;
}

/*
 * WHAT FITS A REQUEST, best first — never one this person has seen. A theme's
 * own key art (the chains of "Operation Samson") only ever goes to that theme;
 * an Easter sunrise only to Easter: the kind must match (or the picture is a
 * general one: light, haze, a stage), and the shape always.
 */
function candidates(q, who, again) {
  const L = load();
  const theme = keyOf(q.theme), kind = keyOf(q.kind) || 'general';
  const recent = again ? new Set(recentOf(who)) : null;
  const out = [];
  for (const e of L.pics) {
    if (e.shape !== q.shape) continue;
    if (again ? recent.has(e.id) : seenBy(e, who)) continue;
    // a board with the minister's photo needs the middle of the picture clear (painted for one: people=true)
    if (q.people && e.people === false) continue;
    let s = 0;
    if (theme && e.theme === theme) s += 10;
    else if (e.theme) continue;                       // someone else's theme art
    if (e.kind === kind) s += 5;
    else if (e.kind === 'general') s += 1;
    else continue;                                    // another kind of event entirely
    if (q.tone && e.tone === q.tone) s += 3;
    if (q.premium && e.tier === 'premium') s += 2;
    s -= Math.min(4, (e.uses || 0) * 0.35);
    if (clock() - (e.at || 0) < 7 * 864e5) s += 0.5;
    out.push({ e, s });
  }
  out.sort((a, b) => b.s - a.s);
  return out;
}
/** How many pictures this person could still be given for this request. */
function stock(q, who) { return candidates(q, who).length; }
/**
 * The best picture for this request this person has not had, handed out
 * (marked seen) — the same light first, then any; with `again`, one they saw
 * long ago (not among the last sixty) rather than nothing. → { file, by, bank:true, id, tone, themeArt } or null
 */
function take(q, who, opts = {}) {
  const L = load();
  const list = candidates(q, who, !!opts.again);
  const order = q.tone ? list.filter((c) => c.e.tone === q.tone).concat(list.filter((c) => c.e.tone !== q.tone)) : list;
  for (const { e } of order) {
    if (!exists(e)) { drop(L.pics, e); continue; }   // its file went: off the shelf
    const o = handOut(e, opts); if (!o) continue;
    markSeen(e, who); remember(who, e.id);
    e.uses = (e.uses || 0) + 1;
    e.last = clock();
    save();
    return o;
  }
  return null;
}
/** One particular picture (shared from a painting someone else was waiting on), if this person has not seen it. */
function takeId(id, who, opts = {}) {
  const L = load();
  const e = L.pics.find((x) => x.id === id);
  if (!e || seenBy(e, who) || !exists(e)) return null;
  const o = handOut(e, opts); if (!o) return null;
  markSeen(e, who); remember(who, e.id); e.uses = (e.uses || 0) + 1; e.last = clock(); save();
  return o;
}
/** The library entry for a picture just added (its file, for the phone). */
function handOutNew(e) { return e ? handOut(e) : null; }

/* ------------------------------------------------------------ lettering */

/** Keep an AI-lettered title — only when it was read back spelt right and readable. */
function addLetter(buf, mime, meta = {}, who) {
  if (!buf || buf.length < 4000 || !meta.checked || !meta.spelt || meta.legible === false) return null;
  const L = load();
  const { id, file } = write(buf, mime);
  const e = { id, file, mime: mime || 'image/png', at: clock(), uses: who ? 1 : 0, seen: [], title: keyOf(meta.title), style: String(meta.style || '').slice(0, 120), by: String(meta.by || '').slice(0, 80), w: meta.w, h: meta.h };
  markSeen(e, who);
  L.letters.push(e);
  prune(L.letters, MAX_LETTERS);
  delete L.letterDemand[e.title];
  save();
  return e;
}
function letterStock(title, who) { const t = keyOf(title); return load().letters.filter((e) => e.title === t && !seenBy(e, who)).length; }
/** A lettering of this title this person has not had. → { dataUrl, by, bank:true, checked:true, spelt:true } or null */
function takeLetter(title, who, opts = {}) {
  const L = load(), t = keyOf(title);
  const list = L.letters.filter((e) => e.title === t && !seenBy(e, who)).sort((a, b) => (a.uses || 0) - (b.uses || 0) || (b.at || 0) - (a.at || 0));
  for (const e of list) {
    if (!exists(e)) { drop(L.letters, e); continue; }
    const o = { file: e.file, by: e.by, bank: true, checked: true, spelt: true, legible: true, id: e.id };
    if (opts.inline) { o.dataUrl = readOut(e); if (!o.dataUrl) continue; }
    markSeen(e, who); e.uses = (e.uses || 0) + 1; e.last = clock(); save();
    return o;
  }
  return null;
}

/* --------------------------------------------------------------- demand */

/** A request, remembered with what it would take to paint it (for the night filler). */
function note(slot, recipe, answered) {
  const L = load();
  const d = L.demand[slot] || (L.demand[slot] = { n: 0, missed: 0 });
  d.n++; if (!answered) d.missed++;
  d.last = clock();
  if (recipe) d.recipe = recipe;
  const keys = Object.keys(L.demand);
  if (keys.length > 300) keys.sort((a, b) => (L.demand[a].last || 0) - (L.demand[b].last || 0)).slice(0, keys.length - 300).forEach((k) => delete L.demand[k]);
  save();
}
function noteLetter(title, scene) {
  const L = load(), t = keyOf(title); if (!t) return;
  const d = L.letterDemand[t] || (L.letterDemand[t] = { n: 0, title: String(title).slice(0, 40) });
  d.n++; d.last = clock(); if (scene) d.scene = String(scene).slice(0, 400);
  const keys = Object.keys(L.letterDemand);
  if (keys.length > 100) keys.sort((a, b) => (L.letterDemand[a].last || 0) - (L.letterDemand[b].last || 0)).slice(0, keys.length - 100).forEach((k) => delete L.letterDemand[k]);
  save();
}
/** What the night filler should paint: the most-asked slots with the fewest pictures, the most-asked titles not lettered yet. */
function wanted(days = 14) {
  const L = load(), since = clock() - days * 864e5;
  const slots = Object.entries(L.demand).filter(([, d]) => d.recipe && (d.last || 0) > since).map(([slot, d]) => {
    const r = d.recipe;
    const have = L.pics.filter((e) => e.shape === r.shape && (r.theme ? e.theme === keyOf(r.theme) : (!e.theme && e.kind === (keyOf(r.kind) || 'general'))) && (!r.tone || e.tone === r.tone)).length;
    return { slot, recipe: r, n: d.n, missed: d.missed || 0, have, score: (d.missed || 0) * 2 + d.n - have * 3 };
  }).sort((a, b) => b.score - a.score);
  const titles = Object.entries(L.letterDemand).filter(([t, d]) => (d.last || 0) > since && !L.letters.some((e) => e.title === t))
    .map(([t, d]) => ({ title: d.title, scene: d.scene, n: d.n })).sort((a, b) => b.n - a.n);
  return { slots, titles };
}

/** Everything on the shelf, newest first (for the owner's library page). */
function list() {
  const L = load();
  const pic = (e) => ({ id: e.id, file: e.file, kind: e.kind, theme: e.theme, tone: e.tone, shape: e.shape, tier: e.tier, by: e.by, at: e.at, uses: e.uses || 0 });
  return {
    pictures: L.pics.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map(pic),
    letterings: L.letters.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).map((e) => ({ id: e.id, file: e.file, title: e.title, by: e.by, at: e.at, uses: e.uses || 0 })),
  };
}
/** Take a picture or a lettering off the shelf for good. */
function remove(id) {
  const L = load();
  const e = L.pics.find((x) => x.id === id) || L.letters.find((x) => x.id === id);
  if (!e) return false;
  drop(L.pics.includes(e) ? L.pics : L.letters, e);
  save();
  return true;
}
function report() {
  const L = load();
  return { pictures: L.pics.length, letterings: L.letters.length, premium: L.pics.filter((e) => e.tier === 'premium').length };
}

function _clock(fn) { clock = fn || (() => Date.now()); }
function _reset() { idx = null; if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } }

module.exports = { list, remove, init, shapeOf, keyOf, add, take, takeId, handOutNew, filePath, readOut, stock, addLetter, takeLetter, letterStock, note, noteLetter, wanted, report, flush, _clock, _reset };
