'use strict';
/*
 * NEVER TWICE, NEVER AT THE OLD TIME — booking while an upload is still going.
 *
 * A post's first booking can take minutes (a sermon's upload, a flyer's
 * video). Everything a church does in those minutes must still come out right:
 *   [1] two booking runs for one post (added, then the next tick): each account
 *       booked once
 *   [2] moved and reworded while the first booking uploads: nothing is left
 *       booked at the old time or with the old words, and every account ends
 *       up booked once, at the new time
 *   [3] it comes due while its booking uploads: it is not ALSO published
 *       directly (that would post it twice)
 *   [4] deleted while its booking uploads: what was booked is given back
 * A stand-in publisher with slow bookings stands in for Zernio.
 *   node test/handoff-race.test.js
 */
const publisher = require('../src/main/publisher');
const { Scheduler } = require('../src/main/scheduler');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (!ok && d !== undefined ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the platform holds: id -> { acc, when, caption, live }
let live = new Map(), direct = [], n = 0;
const SLOW = { a1: 60, a2: 400 };
const M = { cancelMs: 0, cancelFail: 0, maybeMade: 0 };
publisher.canSchedule = () => ({ can: true, via: 'zernio' });
publisher.scheduleTo = async (acc, post, whenMs, opts = {}) => {
  // asked to look first: the post it may have made is found, not made again
  if (opts.zoLookFirst) {
    for (const [id, b] of live) if (b.acc === acc.id && b.caption === post.caption && b.when === whenMs) return { id, url: 'u', via: 'zernio', zoPostId: id, publishAt: new Date(whenMs).toISOString(), found: true };
  }
  await sleep(SLOW[acc.id] || 50);
  const id = 'b' + (++n);
  live.set(id, { acc: acc.id, when: whenMs, caption: post.caption });
  if (M.maybeMade > 0) { M.maybeMade--; const e = new Error('Gateway timeout'); e.zoMaybeMade = true; throw e; }
  return { id, url: 'u', via: 'zernio', zoPostId: id, publishAt: new Date(whenMs).toISOString() };
};
publisher.cancelScheduled = async (acc, h) => {
  if (M.cancelMs) await sleep(M.cancelMs);
  if (M.cancelFail > 0) { M.cancelFail--; throw new Error('network down'); }
  const id = h.zoPostId || h.id;
  if (!live.has(id)) { const e = new Error('Post not found'); e.status = 404; throw e; }
  live.delete(id); return { cancelled: true };
};
publisher.publishTo = async (acc, post) => { direct.push({ acc: acc.id, caption: post.caption }); return { id: 'd' + direct.length, url: 'u' }; };

function mk() {
  const mem = { posts: [], socialAccounts: [{ id: 'a1', platform: 'facebook', via: 'zernio', name: 'Page 1', token: 'k', zoAccountId: '1' }, { id: 'a2', platform: 'youtube', via: 'zernio', name: 'Channel', token: 'k', zoAccountId: '2' }] };
  const store = { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } };
  const { Accounts } = require('../src/main/accounts');
  return new Scheduler(store, () => null, { notify: () => {}, intervalMs: 100000, accounts: new Accounts(store), lockDir: null });
}
const liveFor = (acc) => Array.from(live.values()).filter((b) => b.acc === acc);

(async () => {
  // [1]
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    const second = s.handOff(p.id);          // the next tick, while the first still uploads
    await second; await sleep(50);
    check(liveFor('a1').length === 1 && liveFor('a2').length === 1, '[1] two runs for one post: each account booked once', Array.from(live.values()));
  }
  // [2]
  live = new Map(); direct = [];
  {
    const s = mk();
    const t1 = Date.now() + 3600e3, t2 = Date.now() + 7200e3;
    const p = s.add({ title: 'T', caption: 'old words', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(t1).toISOString() });
    await sleep(120);                         // a1 booked, a2 still uploading
    await s.reschedule(p.id, { scheduledAt: new Date(t2).toISOString(), caption: 'new words' });
    for (let k = 0; k < 40 && !(liveFor('a1').length && liveFor('a2').length && Array.from(live.values()).every((b) => b.when === t2)); k++) await sleep(50);
    await sleep(200);
    const all = Array.from(live.values());
    check(all.length === 2 && all.every((b) => b.when === t2 && b.caption === 'new words'), '[2] moved while uploading: nothing left at the old time or with the old words; each account once, at the new time', all);
    const rec = s.list().find((x) => x.id === p.id);
    check(Object.keys(rec.handoffs || {}).length === 2 && Object.values(rec.handoffs).every((h) => live.has(h.zoPostId)), '[2] …and the post records exactly the bookings that stand', rec.handoffs);
  }
  // [3]
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 150).toISOString() });
    await sleep(200);                         // due now; the booking is still uploading (400ms)
    await s.autoPublish(p.id).catch(() => {});
    await sleep(300);
    check(liveFor('a2').length + direct.filter((d) => d.acc === 'a2').length === 1, '[3] came due while its booking uploaded: out once, not twice', { booked: liveFor('a2'), direct });
  }
  // [4]
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(120);
    await s.remove(p.id);
    await sleep(600);
    check(live.size === 0, '[4] deleted while uploading: everything it booked is given back', Array.from(live.values()));
  }
  // [5] two quick edits in a row
  live = new Map(); direct = [];
  {
    const s = mk();
    const t2 = Date.now() + 7200e3, t3 = Date.now() + 9000e3;
    const p = s.add({ title: 'T', caption: 'one', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    M.cancelMs = 100;
    await Promise.all([s.reschedule(p.id, { caption: 'two' }), sleep(20).then(() => s.reschedule(p.id, { scheduledAt: new Date(t3).toISOString() }))]);
    M.cancelMs = 0;
    for (let k = 0; k < 40 && !liveFor('a1').some((b) => b.when === t3); k++) await sleep(50);
    await sleep(200);
    const rec = s.list().find((x) => x.id === p.id);
    const all = Array.from(live.values());
    check(all.length === 1 && all[0].when === t3 && all[0].caption === 'two' && rec.handoffs.a1 && live.has(rec.handoffs.a1.zoPostId),
      '[5] two quick edits: booked once, with both edits — and the post knows the booking that stands', { all, h: rec.handoffs });
    void t2;
  }
  // [6] the next tick books while a move is taking the old booking back
  live = new Map(); direct = [];
  {
    const s = mk();
    const t2 = Date.now() + 7200e3;
    const p = s.add({ title: 'T', caption: 'old', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(500);
    M.cancelMs = 300;
    const mv = s.reschedule(p.id, { scheduledAt: new Date(t2).toISOString(), caption: 'new' });
    await sleep(50);
    s.handOff(p.id);                          // a tick, right in the middle
    await mv; M.cancelMs = 0;
    for (let k = 0; k < 60 && !(liveFor('a1').length && liveFor('a2').length && Array.from(live.values()).every((b) => b.when === t2)); k++) await sleep(50);
    await sleep(300);
    const all = Array.from(live.values());
    check(all.length === 2 && all.every((b) => b.when === t2 && b.caption === 'new'), '[6] a tick in the middle of a move: no booking left at the old time, none twice', all);
  }
  // [7] a cancel that fails is kept and tried again on the next tick
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    M.cancelFail = 1;
    const r = await s.remove(p.id);
    check(live.size === 1 && (s.store.get('cancelQueue') || []).length === 1 && r && r.warning, '[7] a cancel that fails: said so, and kept to try again', { live: live.size, q: s.store.get('cancelQueue'), r });
    await s._tick();
    check(live.size === 0 && !(s.store.get('cancelQueue') || []).length, '[7] …the next tick takes it back', { live: Array.from(live.values()), q: s.store.get('cancelQueue') });
  }
  // [8] a booking already gone there counts as taken back
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    live.clear();                              // removed on the platform already
    const r = await s.remove(p.id);
    check(r === true && !(s.store.get('cancelQueue') || []).length, '[8] a booking already gone there: taken as given back', { r, q: s.store.get('cancelQueue') });
  }
  // [9] no clear answer (it was made all the same): looked for, never made twice
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(200);
    s.update(p.id, { nextHandoffAt: null });   // its retry time
    await s.handOff(p.id);
    const rec = s.list().find((x) => x.id === p.id);
    check(liveFor('a1').length === 1 && rec.handoffs.a1 && live.has(rec.handoffs.a1.zoPostId), '[9] no clear answer, made all the same: found on the retry, not booked twice', { live: Array.from(live.values()), h: rec.handoffs });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
