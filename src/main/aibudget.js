'use strict';
/*
 * ►► ONE FREE ALLOWANCE, A WHOLE CHURCH. ◄◄
 *
 * Cloudflare gives the studio 10,000 "neurons" of AI painting a day, free,
 * reset at midnight UTC. One flyer board used to spend half of it, and with a
 * hundred people making flyers at once every one of them passed the "is there
 * any left?" check before anybody's spend was written down — the day was gone
 * in a minute and the rest got errors. This is the keeper of that allowance:
 *
 *   • A RESERVATION before every call, not a look before and a note after:
 *     the estimate is set aside first (synchronously — one Node process,
 *     nothing slips in between), settled when the picture arrives, given back
 *     when the call was refused before any work. A call that timed out is
 *     counted as spent: Cloudflare may have done the work, and the real daily
 *     cap must never be reached (past it EVERY AI picture fails till midnight).
 *   • WRITTEN AHEAD: open reservations are on disk too, so a restart in the
 *     middle of a rush counts them as spent rather than forgetting them; a
 *     ledger that cannot be read is answered from its backup, else closed.
 *   • PACED through the day: 15% at midnight, all of it by 20:00 UTC (9pm
 *     in Ireland in summer). What the morning leaves carries on to the evening,
 *     so the Saturday-night rush before Sunday always finds some.
 *   • A FAIR SHARE each: a person paints fresh up to their share a day (three
 *     shares while they are the only one at it). The church library's pictures
 *     are free and unlimited (flyerbank.js).
 *   • A QUEUE: a few calls at once, at most two of them anyone's, the next turn
 *     to whoever has had least today; nobody waits more than a minute (past
 *     that the library answers).
 *   • A MARGIN that is never spent: the estimates are Cloudflare's published
 *     prices, and this absorbs the rounding.
 *
 * The ledger lives in its own folder (it used to sit in the flyer kit's folder,
 * whose tidy-up deleted it on every save — the allowance "reset" all day long).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let DIR = path.join(os.tmpdir(), 'mw-flyer-ai');
let clock = () => Date.now();

const num = (v, d) => { const n = Number(v); return v != null && String(v).trim() !== '' && Number.isFinite(n) ? n : d; };
const DAY = () => Math.max(1000, num(process.env.CLOUDFLARE_DAILY_NEURONS, 10000));
const MARGIN = () => Math.max(0, num(process.env.CLOUDFLARE_MARGIN, 500));
const PER_PERSON = () => Math.max(200, num(process.env.CLOUDFLARE_PER_PERSON, 3000));
const MAX_AT_ONCE = () => Math.max(1, Math.min(16, num(process.env.CLOUDFLARE_CONCURRENCY, 4)));
const PER_WHO_AT_ONCE = 2;     // nobody holds more than two of the painting places at once
const MAX_WAIT_MS = 60000;     // past this in the queue, the library answers instead
const QUEUE_PER_WHO = 8;       // a person's waiting calls (a board is five)
const QUEUE_MAX = 250;
const PLENTY = 3000;           // "plenty": a premium picture and an AI-lettered title can still be afforded
const CHEAP = 160;             // one cheap picture
const ACTIVE_MS = 60 * 60e3;   // someone who asked within the hour is "at it"
const paid = () => /^(1|true|yes)$/i.test(String(process.env.CLOUDFLARE_PAID || ''));
const LIBRARY = 'library';     // the night filler paints for the church library: no person's share

const file = () => path.join(DIR, 'cf-allowance.json');
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

/*
 * The day: { day, spent, byWho:{who:n}, open:{id:{n,who,day}}, exhausted }.
 * Memory is the truth (one process); the file follows every change, written
 * ahead (open reservations included) and atomically (tmp, fsync, rename; the
 * previous one kept as .bak).
 */
let mem = null, memAt = 0;
const held = new Map();   // id → { id, n, who, day, at }
let seq = 0;

function readFileJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }
/** Read the ledger from disk: what a restart (or a hand edit) left. Open reservations from before are counted as spent. */
function fromDisk(day) {
  let l = null, broken = false;
  try { l = readFileJson(file()); } catch (e) { if (e.code !== 'ENOENT') broken = true; }
  if (broken) { try { l = readFileJson(file() + '.bak'); broken = false; } catch (e) { l = null; } }
  if (broken) {
    // neither the ledger nor its backup can be read: closed, not open — as if what pacing has released so far was spent
    return { day, spent: Math.ceil((DAY() - MARGIN()) * pace()), byWho: {}, exhausted: false, failedClosed: true };
  }
  if (!l || l.day !== day) return { day, spent: 0, byWho: {}, exhausted: false };
  let spent = Math.max(0, +l.spent || 0);
  const byWho = l.byWho && typeof l.byWho === 'object' ? l.byWho : {};
  // reservations still open when the server stopped: the calls may have been painted (and billed) — counted
  for (const o of Object.values(l.open && typeof l.open === 'object' ? l.open : {})) {
    if (!o || held.has(o.id)) continue;
    spent += Math.max(0, +o.n || 0);
    if (o.who) byWho[o.who] = (+byWho[o.who] || 0) + (+o.n || 0);
  }
  return { day, spent: Math.round(spent), byWho, exhausted: !!l.exhausted };
}
function load() {
  const day = dayOf(clock());
  let st = null;
  try { st = fs.statSync(file()); } catch (e) { st = null; }
  if (!mem || (st && st.mtimeMs > memAt + 1)) { mem = fromDisk(day); memAt = st ? st.mtimeMs : 0; }
  if (mem.day !== day) mem = { day, spent: 0, byWho: {}, exhausted: false };   // midnight UTC: a new allowance
  return mem;
}
function save() {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const open = {};
    for (const h of held.values()) open[h.id] = { id: h.id, n: h.n, who: h.who, day: h.day };
    const body = JSON.stringify({ day: mem.day, spent: mem.spent, byWho: mem.byWho, open, exhausted: !!mem.exhausted });
    const tmp = file() + '.' + process.pid + '.' + (++seq) + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, body); try { fs.fsyncSync(fd); } catch (e) { /* not every disk */ } } finally { fs.closeSync(fd); }
    try { fs.copyFileSync(file(), file() + '.bak'); } catch (e) { /* the first one */ }
    fs.renameSync(tmp, file());
    memAt = fs.statSync(file()).mtimeMs;
  } catch (e) { /* memory still knows */ }
}

/**
 * Point the ledger at its folder; `legacyFile` is where it used to be (the
 * kit's folder): today's spend there is carried over now, before anything can
 * tidy it away.
 */
function init(dir, legacyFile) {
  DIR = dir; mem = null; memAt = 0;
  const l = load();
  if (legacyFile) {
    try {
      const o = readFileJson(legacyFile);
      if (o && o.day === l.day && +o.spent > l.spent) { l.spent = Math.round(+o.spent); save(); }
      fs.unlinkSync(legacyFile);
    } catch (e) { /* none */ }
  }
  save();
}

const heldTotal = () => { let n = 0; for (const h of held.values()) n += h.n; return n; };
const heldBy = (who) => { let n = 0; for (const h of held.values()) if (h.who === who) n += h.n; return n; };

/* who has asked lately (a share is bigger while someone is the only one at it) */
const lastSeen = new Map();
function touch(who) { if (who && who !== LIBRARY) { lastSeen.set(who, clock()); if (lastSeen.size > 500) lastSeen.delete(lastSeen.keys().next().value); } }
function activeCount() { const t = clock(); let n = 0; for (const v of lastSeen.values()) if (t - v < ACTIVE_MS) n++; return n; }

/**
 * How much of the day is released by now: 15% at midnight UTC, all of it by
 * 20:00 UTC — slowly in the morning, faster towards the evening, when the
 * flyers for tomorrow's service are made (a third by 10:00, two thirds by 16:00).
 */
function pace(t = clock()) {
  const d = new Date(t), mins = d.getUTCHours() * 60 + d.getUTCMinutes(), x = Math.min(1, mins / (20 * 60));
  return Math.min(1, 0.15 + 0.85 * x * x);
}
/** What is left of the day at all (never the margin). */
function hardLeft() { const l = load(); return l.exhausted ? 0 : Math.max(0, DAY() - MARGIN() - l.spent - heldTotal()); }
/** What may be spent now, as the day is paced. */
function available() { return Math.max(0, Math.min(hardLeft(), (DAY() - MARGIN()) * pace() - load().spent - heldTotal())); }
/** What this person may still paint fresh today. */
function shareOf(who) {
  if (who === LIBRARY) return Infinity;
  const others = activeCount() - (lastSeen.has(who) && clock() - lastSeen.get(who) < ACTIVE_MS ? 1 : 0);
  return PER_PERSON() * (others <= 0 ? 3 : 1);
}
function personLeft(who) {
  if (who === LIBRARY) return Infinity;
  return Math.max(0, shareOf(who) - (+load().byWho[who] || 0) - heldBy(who));
}

/**
 * Set `n` neurons aside for `who` — synchronously. → a ticket, or null when
 * the day (as paced now), the hard limit or their share cannot afford it.
 */
function reserve(n, who = 'owner', opts = {}) {
  n = Math.max(1, Math.ceil(+n || 0));
  touch(who);
  if (!paid()) {
    if (n > hardLeft()) return null;
    if (opts.paced !== false && n > available()) return null;
    if (opts.person !== false && n > personLeft(who)) return null;
  }
  const t = { id: ++seq, n, who, day: load().day, at: clock() };
  held.set(t.id, t);
  save();
  return t;
}
/** The call was made: its cost goes on the day (and on the person). Once only. */
function settle(t, actual) {
  if (!t || !held.has(t.id)) return;
  held.delete(t.id);
  const n = Math.max(0, Math.ceil(actual == null ? t.n : +actual || 0));
  const l = load();   // a call that crossed midnight is counted on the new day: the safe side
  l.spent = Math.round(l.spent + n);
  if (t.who) l.byWho[t.who] = Math.round((+l.byWho[t.who] || 0) + n);
  const names = Object.keys(l.byWho); if (names.length > 400) for (const k of names.slice(0, names.length - 400)) delete l.byWho[k];
  save();
}
/** The call never happened (refused before any work): nothing is spent. Once only. */
function release(t) { if (t && held.delete(t.id)) save(); }
/**
 * Cloudflare says the day's free allocation is used: it is — unless the call
 * that heard it was booked on yesterday (a reply that arrives just after
 * midnight must not empty the new day).
 */
function exhaust(t) {
  const l = load();
  if (t && t.day && t.day !== l.day) return;
  l.exhausted = true; l.spent = Math.max(l.spent, DAY());
  save();
}

/*
 * THE QUEUE: a few calls at once (Cloudflare paints each in seconds; a hundred
 * at once only earns "capacity exceeded"), at most two of anyone's, the next
 * turn to whoever has had least today (what they have waiting counts too) —
 * one person tapping again and again waits behind everyone else. Each turn has
 * a hard lease: a call that hangs is let go and its place given on.
 */
let running = 0;
const runningBy = new Map();
const waiting = [];
const LEASE_MS = 170000;
function score(w) { const l = load(); return (+l.byWho[w.who] || 0) + heldBy(w.who) + (w.who === LIBRARY ? 1e9 : 0); }
function nextTurn() {
  // the ones who waited too long: the library answers them
  const t = clock();
  for (let i = waiting.length - 1; i >= 0; i--) if (t - waiting[i].at > waiting[i].maxWait) { const w = waiting.splice(i, 1)[0]; w.fail(Object.assign(new Error('the queue for AI pictures is long right now'), { queued: true })); }
  while (running < MAX_AT_ONCE() && waiting.length) {
    let best = -1;
    for (let i = 0; i < waiting.length; i++) {
      const a = waiting[i];
      if ((runningBy.get(a.who) || 0) >= PER_WHO_AT_ONCE) continue;
      if (best < 0) { best = i; continue; }
      const b = waiting[best], sa = score(a), sb = score(b);
      // anyone who has waited half a minute goes in order of arrival
      const oldA = t - a.at > 30000, oldB = t - b.at > 30000;
      if (oldA !== oldB) { if (oldA) best = i; continue; }
      if (oldA ? a.at < b.at : (sa < sb || (sa === sb && a.at < b.at))) best = i;
    }
    if (best < 0) break;
    const w = waiting.splice(best, 1)[0];
    running++; runningBy.set(w.who, (runningBy.get(w.who) || 0) + 1);
    w.go();
  }
}
let sweeper = null;
function sweep() { if (!sweeper && waiting.length) { sweeper = setTimeout(() => { sweeper = null; nextTurn(); sweep(); }, 2000); if (sweeper.unref) sweeper.unref(); } }
/** Run `fn` when it is `who`'s turn (rejects with {queued:true} if the wait is too long or the queue is full). */
function turn(who, fn, opts = {}) {
  return new Promise((resolve, reject) => {
    const mine = waiting.filter((w) => w.who === who).length;
    if (waiting.length >= QUEUE_MAX || (who !== LIBRARY && mine >= QUEUE_PER_WHO)) { reject(Object.assign(new Error('the queue for AI pictures is full right now'), { queued: true })); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; running--; const r = (runningBy.get(who) || 1) - 1; if (r > 0) runningBy.set(who, r); else runningBy.delete(who); nextTurn(); };
    const go = () => {
      // the lease: a call that has not finished in time gives its place back (its own timeout settles its cost)
      const lease = setTimeout(() => { finish(); }, opts.leaseMs || LEASE_MS);
      if (lease.unref) lease.unref();
      let p;
      try { p = Promise.resolve(fn()); } catch (e) { p = Promise.reject(e); }
      p.then(resolve, reject).finally(() => { clearTimeout(lease); finish(); });
    };
    waiting.push({ who, at: clock(), maxWait: opts.maxWait || MAX_WAIT_MS, go, fail: reject });
    nextTurn();
    sweep();
  });
}

/** In words, for the phone: plenty / limited / resting — for the church, and for this person. */
function level(who = 'owner') {
  if (paid()) return 'plenty';
  const a = available(), p = personLeft(who);
  if (a >= PLENTY && p >= PLENTY * 0.5) return 'plenty';
  if (Math.min(a, p) >= CHEAP) return 'limited';
  return 'resting';
}
function resetsAt(t = clock()) { const d = new Date(t); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString(); }
function report(who = 'owner') {
  const l = load();
  return {
    day: l.day, spent: l.spent, reserved: heldTotal(), left: paid() ? null : hardLeft(), available: paid() ? null : Math.floor(available()),
    personLeft: paid() ? null : (who === LIBRARY ? null : personLeft(who)), share: who === LIBRARY ? null : shareOf(who), level: level(who), resetsAt: resetsAt(),
    queue: waiting.length, queueUsers: waiting.filter((w) => w.who !== LIBRARY).length, running, active: activeCount(), exhausted: !!l.exhausted, failedClosed: !!l.failedClosed,
  };
}

/* tests: a clock that can be moved, and a clean slate */
function _clock(fn) { clock = fn || (() => Date.now()); }
function _reset() { held.clear(); waiting.length = 0; running = 0; runningBy.clear(); lastSeen.clear(); mem = null; memAt = 0; }

module.exports = { init, reserve, settle, release, exhaust, turn, touch, level, report, pace, available, hardLeft, personLeft, shareOf, LIBRARY, PLENTY, CHEAP, DAY, MARGIN, _clock, _reset, file };
