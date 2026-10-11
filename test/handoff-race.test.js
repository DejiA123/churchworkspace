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
const realZernioFind = publisher.zernioFind;
const http = require('http'), os = require('os'), path = require('path'), fs = require('fs');
const { Scheduler } = require('../src/main/scheduler');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (!ok && d !== undefined ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the platform holds: id -> { acc, when, caption, live }
let live = new Map(), direct = [], n = 0;
const SLOW = { a1: 60, a2: 400, a3: 400 };
const M = { cancelMs: 0, cancelFail: 0, maybeMade: 0, uploads: [] };
// what Zernio would find for "the post it may have made": same words, same account, same time
publisher.zernioFind = async (acc, look) => {
  const skip = new Set((look.exclude || []).map(String));
  for (const [id, b] of live) if (!skip.has(id) && b.acc === acc.id && b.caption === look.content && b.when === look.at) return id;
  return null;
};
publisher.canSchedule = () => ({ can: true, via: 'zernio' });
publisher.scheduleTo = async (acc, post, whenMs, opts = {}) => {
  // asked to look first: the post it may have made is found, not made again
  if (opts.zoLookFirst) {
    const skip = new Set(opts.zoExclude || []);
    for (const [id, b] of live) if (!skip.has(id) && b.acc === acc.id && b.caption === post.caption && b.when === whenMs) return { id, url: 'u', via: 'zernio', zoPostId: id, publishAt: new Date(whenMs).toISOString(), found: true };
  }
  M.uploads.push(acc.id);
  await sleep(SLOW[acc.id] || 50);
  const id = 'b' + (++n);
  live.set(id, { acc: acc.id, when: whenMs, caption: post.caption, title: post.title });
  if (M.maybeMade > 0) { M.maybeMade--; const e = new Error('Gateway timeout'); e.zoMaybeMade = true; e.zoContent = post.caption; throw e; }
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
  const mem = { posts: [], socialAccounts: [{ id: 'a1', platform: 'facebook', via: 'zernio', name: 'Page 1', token: 'k', zoAccountId: '1' }, { id: 'a2', platform: 'youtube', via: 'zernio', name: 'Channel', token: 'k', zoAccountId: '2' }, { id: 'a3', platform: 'tiktok', via: 'zernio', name: 'TikTok', token: 'k', zoAccountId: '3' }] };
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
    check(live.size === 1, '[7] …not hammered: the next try waits a little (then longer each time)', live.size);
    s.store.set('cancelQueue', (s.store.get('cancelQueue') || []).map((x) => ({ ...x, nextTry: new Date(Date.now() - 1000).toISOString() })));   // its time comes
    await s._tick();
    check(live.size === 0 && !(s.store.get('cancelQueue') || []).length, '[7] …and when its time comes, a tick takes it back', { live: Array.from(live.values()), q: s.store.get('cancelQueue') });
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
  // [10] an account taken off while its booking uploads: that booking is taken back, the others stay
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);                          // a1 booked; a2 uploading
    await s.reschedule(p.id, { accountIds: ['a1'] });
    await sleep(700);
    const rec = s.list().find((x) => x.id === p.id);
    check(liveFor('a2').length === 0 && liveFor('a1').length === 1 && !rec.handoffs.a2 && rec.handoffs.a1, '[10] an account taken off while uploading: not left booked; the rest stay', { live: Array.from(live.values()), h: Object.keys(rec.handoffs) });
  }
  // [11] deleted while uploading: nothing more is uploaded for it
  live = new Map(); direct = []; M.uploads = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a2', 'a3', 'a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(100);                          // a2 uploading
    const r = await s.remove(p.id);
    await sleep(1200);
    check(M.uploads.join() === 'a2' && live.size === 0 && r && r.pending && !r.warning, '[11] deleted while uploading: nothing more uploaded for it, all given back, and said calmly (no "delete it by hand")', { uploads: M.uploads, live: Array.from(live.values()), r });
  }
  // [12] the title changed while uploading: the old title is not left booked
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'Old title', caption: '', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    await s.reschedule(p.id, { title: 'New title' });
    for (let k = 0; k < 40 && !(liveFor('a1').length && liveFor('a2').length && Array.from(live.values()).every((b) => b.title === 'New title')); k++) await sleep(50);
    await sleep(200);
    const all = Array.from(live.values());
    check(all.length === 2 && all.every((b) => b.title === 'New title'), '[12] a new title while uploading: nothing left with the old title', all);
  }
  // [13] no clear answer, then reworded: the one it may have made is found and taken back — not posted twice
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const p = s.add({ title: 'T', caption: 'first words', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(200);
    await s.reschedule(p.id, { caption: 'second words' });
    for (let k = 0; k < 40 && !(liveFor('a1').length === 1 && liveFor('a1')[0].caption === 'second words'); k++) await sleep(50);
    await sleep(200);
    check(liveFor('a1').length === 1 && liveFor('a1')[0].caption === 'second words', '[13] no clear answer, then reworded: the old one found and taken back — once, with the new words', Array.from(live.values()));
  }
  // [14] …and deleted instead: the one it may have made is found and taken back
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const p = s.add({ title: 'T', caption: 'words', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(200);
    await s.remove(p.id);
    check(live.size === 0, '[14] no clear answer, then deleted: the one it may have made is taken back', Array.from(live.values()));
  }
  // [15] a booking waiting to be taken back is never taken for a new one
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'A', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    M.cancelFail = 99;                         // offline: the old one stays on the platform for now
    await s.reschedule(p.id, { caption: 'B' });
    await sleep(200);
    M.maybeMade = 0;
    await s.reschedule(p.id, { caption: 'A' }); // back to the first words
    await sleep(300);
    M.cancelFail = 0;
    s.store.set('cancelQueue', (s.store.get('cancelQueue') || []).map((x) => ({ ...x, nextTry: null })));
    await s._tick();
    await sleep(200);
    const rec = s.list().find((x) => x.id === p.id);
    check(rec.handoffs.a1 && live.has(rec.handoffs.a1.zoPostId) && liveFor('a1').length === 1 && liveFor('a1')[0].caption === 'A',
      '[15] a booking waiting to be taken back is never taken for a new one: the post stays truly booked', { live: Array.from(live.values()), h: rec.handoffs, q: s.store.get('cancelQueue') });
  }
  // [16] a booking on an account no longer linked: said once and let go, not tried for ever
  live = new Map(); direct = [];
  {
    const told = [];
    const s = mk(); s.opts.notify = (t, b) => told.push(t + ' | ' + b);
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    s.store.set('socialAccounts', s.store.get('socialAccounts').filter((a) => a.id !== 'a1'));
    await s.remove(p.id);
    check(!(s.store.get('cancelQueue') || []).length && told.some((t) => /may still have it booked/.test(t)), '[16] an account no longer linked: told to delete it by hand, once — not tried for ever', { q: s.store.get('cancelQueue'), told });
  }
  // [17] a post that is due is published by the very next tick, even straight after it is added
  live = new Map(); direct = [];
  {
    const s = mk();
    s.add({ title: 'T', caption: 'now', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await s._tick();
    check(direct.length === 1, '[17] a due post is published by the next tick, not a tick later', direct);
  }
  // [18] removing a post that has gone out, from the list, never touches the live post
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 400).toISOString() });
    await sleep(200);                          // booked
    await sleep(400);                          // its time comes
    await s.autoPublish(p.id).catch(() => {});
    const out = s.list().find((x) => x.id === p.id);
    await s.remove(p.id);
    await s._tick();
    check(out.status === 'posted' && liveFor('a1').length === 1 && !(s.store.get('cancelQueue') || []).length, '[18] a posted post removed from the list: the live post is left alone', { status: out.status, live: Array.from(live.values()), q: s.store.get('cancelQueue') });
  }
  // [19] no clear answer while it is being deleted: what it may have made is still taken back
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const p = s.add({ title: 'T', caption: 'gone', accountIds: ['a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(100);                          // a2 uploading (400ms)
    await s.remove(p.id);
    await sleep(800);
    check(live.size === 0, '[19] deleted during an upload that got no clear answer: what it made is found and taken back', { live: Array.from(live.values()), q: s.store.get('cancelQueue') });
  }
  // [20] reworded during an upload that got no clear answer: never out twice
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const t2 = Date.now() + 7200e3;
    const p = s.add({ title: 'T', caption: 'old', accountIds: ['a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(100);
    await s.reschedule(p.id, { caption: 'new', scheduledAt: new Date(t2).toISOString() });
    for (let k = 0; k < 40 && !(liveFor('a2').length === 1 && liveFor('a2')[0].caption === 'new'); k++) await sleep(50);
    await sleep(300);
    check(liveFor('a2').length === 1 && liveFor('a2')[0].caption === 'new' && liveFor('a2')[0].when === t2, '[20] reworded during an upload with no clear answer: only the new version stands', Array.from(live.values()));
  }
  // [21] looking for "the one it may have made" never takes down the post's own good booking
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const p = s.add({ title: 'T', caption: 'same', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(200);
    live.clear();                              // it was NOT made after all
    const realFind = publisher.zernioFind;
    publisher.zernioFind = async () => { throw new Error('Zernio busy'); };   // the first look fails: stays on the list
    await s.reschedule(p.id, { title: 'New title' });   // same words and time, new title
    publisher.zernioFind = realFind;
    for (let k = 0; k < 40 && !liveFor('a1').length; k++) await sleep(50);
    await sleep(200);
    s.store.set('cancelQueue', (s.store.get('cancelQueue') || []).map((x) => ({ ...x, nextTry: null })));
    await s._tick();
    const rec = s.list().find((x) => x.id === p.id);
    check(liveFor('a1').length === 1 && rec.handoffs.a1 && live.has(rec.handoffs.a1.zoPostId), '[21] the look for a maybe-made post never takes down the post’s own good booking', { live: Array.from(live.values()), h: rec.handoffs, q: s.store.get('cancelQueue') });
  }
  // [22] no clear answer on one account, then the post is moved while another uploads: never out twice
  live = new Map(); direct = [];
  {
    const s = mk();
    M.maybeMade = 1;
    const t2 = Date.now() + 7200e3;
    const p = s.add({ title: 'T', caption: 'old', accountIds: ['a1', 'a2'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);                          // a1: no clear answer (made); a2 uploading
    await s.reschedule(p.id, { caption: 'new', scheduledAt: new Date(t2).toISOString() });
    for (let k = 0; k < 60 && !(liveFor('a1').length === 1 && liveFor('a2').length === 1 && Array.from(live.values()).every((b) => b.when === t2)); k++) await sleep(50);
    await sleep(300);
    const all = Array.from(live.values());
    check(all.length === 2 && all.every((b) => b.when === t2 && b.caption === 'new'), '[22] no clear answer, then moved during the run: only the new version stands', all);
  }
  // [23] "post now" on a booked post, then deleted: the booking is taken back
  live = new Map(); direct = [];
  {
    const s = mk();
    const p = s.add({ title: 'T', caption: 'c', accountIds: ['a1'], mediaPaths: [], scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
    await sleep(150);
    await s.autoPublish(p.id).catch(() => {});   // the desktop's "post now" on a booked post
    await s.remove(p.id);
    check(live.size === 0, '[23] booked, "post now", then deleted: the booking is still taken back', Array.from(live.values()));
  }
  // [24] the look for a maybe-made post never matches a post that is already out
  {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ posts: [{ _id: 'LIVE', content: 'Join us Sunday!', status: 'published', platforms: [{ accountId: '1' }], createdAt: new Date(Date.now() - 90 * 86400e3).toISOString() }] })); }).listen(0);
    await new Promise((r) => srv.once('listening', r));
    const base = 'http://127.0.0.1:' + srv.address().port;
    const hit = await realZernioFind({ token: 'k', zoAccountId: '1' }, { content: 'Join us Sunday!', at: Date.now() + 86400e3 }, { zoApiBase: base });
    srv.close();
    check(hit === null, '[24] a live post with the same words is never taken for "the one it may have made"', hit);
  }
  // [25] the studio and the background poster share the take-back list: neither wipes the other's
  live = new Map(); direct = [];
  {
    const { Store } = require('../src/main/store');
    const { Accounts } = require('../src/main/accounts');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cq-')); const file = path.join(dir, 'workstation.json');
    const seed = { posts: [], socialAccounts: [{ id: 'a1', platform: 'facebook', via: 'zernio', name: 'Page 1', token: 'k', zoAccountId: '1' }] };
    fs.writeFileSync(file, JSON.stringify(seed));
    const stA = new Store(file, seed), stB = new Store(file, seed);
    const A = new Scheduler(stA, () => null, { notify: () => {}, intervalMs: 100000, accounts: new Accounts(stA), lockDir: dir, owner: 'A' });
    const B = new Scheduler(stB, () => null, { notify: () => {}, intervalMs: 100000, accounts: new Accounts(stB), lockDir: dir, owner: 'B' });
    B._cancelLater('px', 'a1', { ok: true, id: 'zz', zoPostId: 'zz', name: 'Page 1', platform: 'facebook', publishAt: new Date(Date.now() + 3600e3).toISOString() }, 'T');
    const seen = A._cq();
    A._cqSet(seen);
    const disk = JSON.parse(fs.readFileSync(file, 'utf8')).cancelQueue || [];
    check(seen.length === 1 && disk.length === 1, '[25] the background poster’s take-back list is seen, never written over', { seen: seen.length, disk: disk.length });
  }
  // [26] still failing when its time came: the church is told it may have gone out
  live = new Map(); direct = [];
  {
    const told = [];
    const s = mk(); s.opts.notify = (t, b) => told.push(t);
    s._cancelLater('py', 'a1', { ok: true, id: 'q1', zoPostId: 'q1', name: 'Page 1', platform: 'facebook', publishAt: new Date(Date.now() + 60e3).toISOString() }, 'Old one');
    s.store.set('cancelQueue', (s.store.get('cancelQueue') || []).map((x) => ({ ...x, tries: 2, why: 'network down', publishAt: undefined, booking: { ...x.booking, publishAt: new Date(Date.now() - 1000).toISOString() } })));
    await s._drainCancels('py');
    check(told.some((t) => /may have gone out/.test(t)) && !(s.store.get('cancelQueue') || []).length, '[26] could not be taken back before its time: the church is told it may have gone out', told);
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
