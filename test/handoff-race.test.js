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
publisher.canSchedule = () => ({ can: true, via: 'zernio' });
publisher.scheduleTo = async (acc, post, whenMs) => {
  await sleep(SLOW[acc.id] || 50);
  const id = 'b' + (++n);
  live.set(id, { acc: acc.id, when: whenMs, caption: post.caption });
  return { id, url: 'u', via: 'zernio', zoPostId: id, publishAt: new Date(whenMs).toISOString() };
};
publisher.cancelScheduled = async (acc, h) => { live.delete(h.zoPostId || h.id); return { cancelled: true }; };
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
