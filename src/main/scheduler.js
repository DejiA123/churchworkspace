'use strict';
const path = require('path');
const publisher = require('./publisher');
const { Accounts } = require('./accounts');
const autopost = require('./autopost');

// Electron modules — absent when unit tests run this file under plain Node.
let electron = {};
try { electron = require('electron'); } catch (e) { /* plain node */ }
const shell = (electron && typeof electron === 'object' && electron.shell) || null;
const Notification = (electron && typeof electron === 'object' && electron.Notification) || null;
const clipboard = (electron && typeof electron === 'object' && electron.clipboard) || null;

function makeId() {
  return 'p_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// Where each platform's "create a post / upload" surface lives on the web.
const COMPOSERS = {
  instagram: 'https://www.instagram.com/',
  facebook:  'https://www.facebook.com/',
  tiktok:    'https://www.tiktok.com/upload?lang=en',
  youtube:   'https://studio.youtube.com/',
};

const MAX_ATTEMPTS = 3;              // auto-publish retries before a post is marked failed
const RETRY_BACKOFF_MS = 90 * 1000;  // wait between attempts (network blips, FB hiccups)
// A booking that failed is usually a failed UPLOAD — a sermon video, minutes of
// it. Retrying that every tick would saturate the line, so back off properly.
const HANDOFF_BACKOFF_MS = 5 * 60 * 1000;

/**
 * The scheduler runs in the main process and fires posts at their time:
 *  - Posts targeted at LINKED ACCOUNTS (Facebook Pages, Instagram Business)
 *    AUTO-PUBLISH through the Graph API — photos, videos, Reels, or text.
 *    Each account gets its own result; a failure on one account never blocks
 *    or re-posts the others.
 *  - Platforms without a linked account get the reminder + one-tap flow.
 *  - Posts come due whether or not this app is running: the same tick is run
 *    by the background poster the operating system starts every few minutes
 *    (src/main/autopost.js). Anything still missed is caught up on launch.
 *  - Failures retry with backoff, then mark the post "failed" (with the reason)
 *    so the user can fix and hit Retry — only the failed accounts are retried.
 *  - Legacy setups (a Page ID + token pasted in Settings, no linked account)
 *    keep auto-publishing exactly as before.
 *
 * opts (for tests): { intervalMs, notify(title, body, postId), now(), accounts }
 */
class Scheduler {
  constructor(store, getWindow, opts = {}) {
    this.store = store;
    this.getWindow = getWindow; // () => BrowserWindow | null
    this.opts = opts || {};
    this.accounts = this.opts.accounts || new Accounts(store);
    if (!Array.isArray(this.store.get('posts'))) this.store.set('posts', []);
    this._timer = null;
    this._busy = new Set(); // post ids currently uploading (never double-publish)
    // Where the two processes that can publish (this studio and the background
    // poster) leave their lock for each other. Tests point it at a temp folder.
    this.lockDir = this.opts.lockDir
      || (this.store.path ? path.dirname(this.store.path) : null);
    // Who we are to the lock. The pid alone would be enough in production (one
    // Scheduler per process) but it is also what the test runs two of, side by
    // side, to prove the same post cannot go out twice.
    this._owner = this.opts.owner
      || (process.pid + '#' + Math.random().toString(36).slice(2, 8));
  }

  /**
   * Adopt any change the OTHER process made to the schedule. `_busy` only
   * guards this process; the lock below guards the pair; this keeps the list
   * we are about to judge from being a stale snapshot.
   */
  _syncPosts(force) {
    if (this.lockDir && typeof this.store.reloadKey === 'function') {
      try { this.store.reloadKey('posts', force); } catch (e) {}
    }
  }

  /** Write the schedule out NOW, so the other process reads what we just did. */
  _flush() {
    try { if (typeof this.store.flushSync === 'function') this.store.flushSync(); } catch (e) {}
  }

  /** Take the cross-process publish lock (a no-op when there is nowhere to put it). */
  _lock(who) {
    if (!this.lockDir) return () => {};
    return autopost.acquireLock(this.lockDir, who || 'studio', this._now(), this._owner);
  }

  _now() { return this.opts.now ? this.opts.now() : Date.now(); }

  list() {
    return (this.store.get('posts') || []).slice().sort((a, b) =>
      new Date(a.scheduledAt) - new Date(b.scheduledAt));
  }

  add(post) {
    const posts = this.store.get('posts') || [];
    const now = new Date().toISOString();
    const record = {
      id: makeId(),
      title: post.title || 'Untitled post',
      caption: post.caption || '',
      platforms: Array.isArray(post.platforms) ? post.platforms : [],
      accountIds: Array.isArray(post.accountIds) ? post.accountIds : [], // linked accounts to auto-post to
      mediaPaths: Array.isArray(post.mediaPaths) ? post.mediaPaths : [],
      // a flyer's music, per platform (main.js withFlyerMusic / publisher.js flyerPlan)
      music: post.music || null,
      scheduledAt: post.scheduledAt || now,
      status: post.status || 'scheduled', // scheduled | posting | posted | failed | draft
      notified: false,
      attempts: 0,
      error: null,
      results: {}, // accountId -> { ok, id?, url?, error?, name, platform, postedAt? }
      // accountId -> the booking a platform is holding for this post, so it
      // goes out with this PC switched off (see handOff / publisher.scheduleTo).
      handoffs: {},
      handoffErrors: {},
      createdAt: now,
      updatedAt: now,
      // whose space made it, on a shared Cloud Studio (null = the owner; see space.js)
      owner: post.owner || null,
    };
    posts.push(record);
    this.store.set('posts', posts);
    this._flush();
    // Get it onto Facebook/YouTube/Zernio's own queue straight away rather than
    // waiting for a tick: the operator may be about to shut the PC down.
    this.handOff(record.id).catch(() => { /* recorded on the post */ });
    return record;
  }

  update(id, patch) {
    const posts = this.store.get('posts') || [];
    const idx = posts.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Post not found.');
    posts[idx] = { ...posts[idx], ...patch, updatedAt: new Date().toISOString() };
    this.store.set('posts', posts);
    return posts[idx];
  }

  /**
   * Delete a post — and give back any booking a platform is holding for it
   * FIRST. Deleting the row here while Facebook still has the post booked is
   * how a church deletes something and watches it appear anyway on Sunday,
   * with nothing left in the app that even knows about it.
   */
  /*
   * ►► ONE THING AT A TIME FOR EACH POST. ◄◄ Booking it, moving it, taking a
   * booking back: for any one post these run one after another, never at
   * once (a post's first booking can upload for minutes). A step starts at
   * once when nothing else is running for that post.
   */
  _q(id, fn) {
    this._handoffRuns = this._handoffRuns || new Map();
    const prev = this._handoffRuns.get(id);
    const run = prev ? prev.catch(() => {}).then(fn) : fn();
    this._handoffRuns.set(id, run);
    const done = () => { if (this._handoffRuns.get(id) === run) this._handoffRuns.delete(id); };
    run.then(done, done);
    return run;
  }
  // a booking for this post is uploading to a platform RIGHT NOW (not merely queued)
  _busyWith(id) { return !!(this._uploading && this._uploading.has(id)); }
  // whatever is running for this post, finished — or at once
  _afterRuns(id) {
    const run = this._handoffRuns && this._handoffRuns.get(id);
    return run ? run.catch(() => {}) : Promise.resolve();
  }
  // what a booking is made from: a change to any of it makes a booking out of date
  _contentOf(p) {
    return JSON.stringify([new Date(p.scheduledAt).getTime(), p.caption || '', p.title || '', p.mediaPaths || [], p.music || null]);
  }

  /*
   * ►► BOOKINGS TO TAKE BACK, KEPT ON DISK. ◄◄ A booking that is no longer
   * right (the post was moved, reworded or deleted, or an account taken off
   * it) goes on this list the moment that happens, and comes off only when
   * the platform has let it go (or says it is gone already). It is tried
   * again on later ticks, less often each time; after a few failures the
   * church is told where to delete it by hand. A booking Zernio may have made
   * without saying so (no clear answer) is on the list too, as what to look
   * for. The list is shared with the background poster, so it is read fresh
   * from disk before every change and written straight away.
   */
  _cq() {
    if (this.lockDir && typeof this.store.reloadKey === 'function') { this._flush(); try { this.store.reloadKey('cancelQueue', true); } catch (e) {} }
    return (this.store.get('cancelQueue') || []).slice();
  }
  _cqSet(list) { this.store.set('cancelQueue', list); this._flush(); }
  _cqKey(x) { const b = x.booking || {}; return x.accId + '|' + (b.lookup ? 'look:' + b.lookup.at + ':' + b.lookup.content : String(b.zoPostId || b.id || '')); }
  _cancelLater(postId, accId, h, title) {
    if (!h || !h.ok) return;
    // its time has come and gone: it is OUT — taking it back would delete the church's live post
    const due = h.lookup ? h.lookup.at : h.publishAt;
    if (due && new Date(due).getTime() <= this._now()) return;
    const entry = { postId, accId, booking: h, title: title || '', name: h.name || accId, platform: h.platform || '', tries: 0, at: new Date().toISOString() };
    const list = this._cq();
    if (list.some((x) => this._cqKey(x) === this._cqKey(entry))) return;
    list.push(entry);
    this._cqSet(list);
  }
  // a booking Zernio may have made without answering: what to look for, to take it back
  _maybeMadeToCancel(post, accId) {
    if (post.status === 'posted' || ((post.results || {})[accId] && post.results[accId].ok)) return;   // out already
    const e = (post.handoffErrors || {})[accId];
    if (!e || !e.maybeMade || !e.maybeMade.content) return;
    const acc = this.accounts.byId(accId);
    this._cancelLater(post.id, accId, { ok: true, name: e.name || accId, platform: e.platform, lookup: { content: e.maybeMade.content, at: e.maybeMade.at, accountId: acc && acc.zoAccountId } }, post.title);
  }
  // take back what is on the list for this post as soon as what is running for it has finished
  _drainSoon(id) { this._q(id, () => this._drainCancels(id)).catch(() => {}); }
  _accFor(accId) {
    if (accId === 'legacy_fb') { const c = this.fbConfig(); return c ? { id: 'legacy_fb', platform: 'facebook', pageId: c.pageId, token: c.token } : null; }
    return this.accounts.byId(accId);
  }
  async _drainCancels(postId, { due = false } = {}) {
    const failed = [];
    for (const x of this._cq()) {
      if (postId && x.postId !== postId) continue;
      if (due && x.nextTry && new Date(x.nextTry).getTime() > this._now()) continue;   // not yet: tried again less often each time
      const acc = this._accFor(x.accId);
      let gone = false, why = '', drop = false;
      const dueAt = x.booking.lookup ? x.booking.lookup.at : x.booking.publishAt;
      if (dueAt && new Date(dueAt).getTime() <= this._now()) {
        gone = true;   // its time has passed: it is out (or never was) — a DELETE now would take down a live post
      } else if (!acc || !acc.token) {
        // the account is no longer linked here: nothing can be asked of it any more — said once, then let go
        why = 'that account is no longer linked here'; drop = true;
      } else {
        try {
          let booking = x.booking;
          if (booking.lookup) {
            // never one this account is booked with now (the same words and time can be the post's good booking)
            const keep = [];
            for (const p of (this.store.get('posts') || [])) { const h = (p.handoffs || {})[x.accId]; if (h && h.ok) keep.push(String(h.zoPostId || h.id || '')); }
            const found = await publisher.zernioFind(acc, { ...booking.lookup, exclude: keep }, this._pubOpts());
            if (!found) gone = true;     // looked, and Zernio has no such post: nothing to take back
            else booking = { ...booking, id: found, zoPostId: found, via: 'zernio' };
          }
          if (!gone) { await publisher.cancelScheduled(acc, booking, this._pubOpts()); gone = true; }
        } catch (e) {
          why = (e && e.message) || String(e);
          // already gone there (taken back before, or published and removed): nothing left to cancel
          if ((e && (e.status === 404 || e.status === 410)) || /not found|does not exist|no longer exists/i.test(why)) gone = true;
        }
      }
      const now = this._cq();
      const i = now.findIndex((y) => this._cqKey(y) === this._cqKey(x));
      if (gone) { if (i >= 0) now.splice(i, 1); }
      else {
        failed.push({ name: x.name, platform: x.platform, why, url: x.booking.url });
        if (i >= 0) {
          const tries = (now[i].tries || 0) + 1;
          now[i] = { ...now[i], tries, why, nextTry: new Date(this._now() + Math.min(60, 2 ** tries) * 60e3).toISOString() };
          if (drop || tries === 5) this._notify('⚠️ Could not take back a booking: ' + (x.title || 'a post'),
            `${x.name} may still have it booked (${why}). Delete it there by hand, or it goes out at its old time.`, x.postId);
          if (drop) now.splice(i, 1);
        }
      }
      this._cqSet(now);
    }
    return { failed };
  }

  /**
   * Delete a post — and give back any booking a platform is holding for it.
   * The row goes at once, on disk (so it cannot come back if the app is shut
   * now); its bookings go on the list above and are taken back — straight
   * away, or once a booking still uploading for it has finished (that run
   * gives back what it booked itself, and books nothing more).
   */
  async remove(id) {
    const post = (this.store.get('posts') || []).find((p) => p.id === id);
    if (!post) return true;
    // what has gone out stays out: removing a posted one from this list never touches the platform
    const out = (accId) => post.status === 'posted' || ((post.results || {})[accId] && post.results[accId].ok);
    for (const [accId, h] of Object.entries(post.handoffs || {})) if (!out(accId)) this._cancelLater(id, accId, h, post.title);
    for (const accId of Object.keys(post.handoffErrors || {})) this._maybeMadeToCancel(post, accId);
    this.store.set('posts', (this.store.get('posts') || []).filter((p) => p.id !== id));
    this._flush();
    const uploading = this._busyWith(id);
    const work = this._q(id, () => this._drainCancels(id));
    if (uploading) { work.catch(() => {}); return { ok: true, pending: true, note: 'Deleted. It was still uploading — what it booked is taken back as soon as that finishes.' }; }
    const res = await work.catch((e) => ({ failed: [{ name: 'A platform', why: (e && e.message) || String(e) }] }));
    // Told, not swallowed: the operator has to know, and that it is being tried again.
    return res.failed.length ? { ok: true, warning: res.failed.map((f) => `${f.name} still has it booked (${f.why})`).join(' · '), retrying: true } : true;
  }

  /**
   * Move or reword a post. Bookings made for the OLD time or words (and for
   * accounts taken off it) come off the post at once and are taken back; then
   * it is booked again — in that order, after any booking still uploading
   * (which gives back what it books for the old version).
   */
  async reschedule(id, patch) {
    const before = (this.store.get('posts') || []).find((p) => p.id === id);
    if (!before) return this.update(id, patch);   // throws "Post not found."
    const changed = this._contentOf({ ...before, ...patch }) !== this._contentOf(before);
    const kept = Array.isArray(patch.accountIds) ? new Set(patch.accountIds) : null;
    const handoffs = { ...(before.handoffs || {}) };
    const handoffErrors = { ...(before.handoffErrors || {}) };
    let toCancel = 0;
    for (const [accId, h] of Object.entries(handoffs)) {
      if (!h || !h.ok) continue;
      if (changed || (kept && !kept.has(accId))) { this._cancelLater(id, accId, h, before.title); delete handoffs[accId]; toCancel++; }
    }
    for (const accId of Object.keys(handoffErrors)) {
      if (handoffErrors[accId] && handoffErrors[accId].maybeMade && (changed || (kept && !kept.has(accId)))) {
        this._maybeMadeToCancel(before, accId); delete handoffErrors[accId]; toCancel++;
      }
    }
    const rec = this.update(id, { ...patch, handoffs, handoffErrors, nextHandoffAt: null });
    this._flush();
    const uploading = this._busyWith(id);
    const work = toCancel ? this._q(id, () => this._drainCancels(id)) : null;
    if (rec.status === 'scheduled') this.handOff(id).catch(() => {});
    if (work && !uploading) {
      const res = await work.catch(() => ({ failed: [] }));
      if (res.failed.length) return { ...rec, warning: res.failed.map((f) => `${f.name} still has the old one booked (${f.why})`).join(' · '), retrying: true };
    } else if (work) work.catch(() => {});
    return rec;
  }

  /** Legacy Facebook config (Page ID + token pasted in Settings), or null. */
  fbConfig() {
    const s = this.store.get('settings') || {};
    const acc = s.accounts || {};
    const pageId = (acc.fbPageId || '').trim();
    const token = (acc.fbToken || '').trim();
    if (!pageId || !token) return null;
    return { pageId, token, apiBase: acc.fbApiBase || undefined };
  }

  _apiBase() {
    return (((this.store.get('settings') || {}).accounts) || {}).fbApiBase || undefined;
  }

  /** Base-URL overrides handed to the publisher (tests point them at a mock). */
  _pubOpts() {
    const acc = (((this.store.get('settings') || {}).accounts) || {});
    return {
      apiBase: acc.fbApiBase || undefined,
      ytApiBase: acc.ytApiBase || undefined,
      ytTokenBase: acc.ytTokenBase || undefined,
      tkApiBase: acc.tkApiBase || undefined,
      tkTokenProxy: acc.tkTokenProxy || undefined,
      tkProxyToken: acc.tkProxyToken || undefined,
      upApiBase: acc.upApiBase || undefined,
      zoApiBase: acc.zoApiBase || process.env.ZERNIO_API_BASE || undefined,
    };
  }

  /**
   * The linked accounts a post should auto-publish to:
   *  - post.accountIds when the post targets specific accounts (new UI);
   *  - otherwise every linked account matching the post's platforms
   *    (upgrades posts scheduled before accounts existed);
   *  - otherwise the legacy Settings Page ID + token, as a synthetic account.
   */
  targetsFor(post) {
    const all = this.accounts.all().filter((a) => a.token);
    if (Array.isArray(post.accountIds) && post.accountIds.length) {
      return post.accountIds.map((id) => all.find((a) => a.id === id)).filter(Boolean);
    }
    const plats = new Set(post.platforms || []);
    const matched = all.filter((a) => plats.has(a.platform));
    if (matched.length) return matched;
    if (plats.has('facebook')) {
      const fb = this.fbConfig();
      if (fb) {
        return [{ id: 'legacy_fb', platform: 'facebook', name: 'Facebook Page', pageId: fb.pageId, token: fb.token }];
      }
    }
    return [];
  }

  /* ------------------ POSTING WITH THE PC SWITCHED OFF ------------------ *
   *
   * The background poster (autopost.js) got the app out of the way; this gets
   * the PC out of the way. Every account that CAN be handed the post in
   * advance is handed it as soon as the post is scheduled — the video is
   * uploaded there and then, with its time attached, and the platform's own
   * servers publish it. After that the machine can be off, and it changes
   * nothing.
   *
   * What each platform can and cannot do is publisher.canSchedule(); the split
   * is real and not negotiable, so the UI shows it per account rather than
   * letting the operator assume.
   * --------------------------------------------------------------------- */

  /** Split a post's targets into "the platform will hold this" and "this PC must be on". */
  handoffPlan(post) {
    const when = new Date(post.scheduledAt).getTime();
    const bookable = [], local = [];
    for (const acc of this.targetsFor(post)) {
      const booked = (post.handoffs || {})[acc.id];
      const cap = publisher.canSchedule(acc, when, this._now());
      const row = { id: acc.id, name: acc.name, platform: acc.platform, why: cap.why, via: cap.via };
      if (booked && booked.ok) bookable.push({ ...row, booked: true });
      else if (cap.can) bookable.push({ ...row, booked: false });
      else local.push(row);
    }
    return { bookable, local, safeWithPcOff: !!bookable.length && !local.length };
  }

  /**
   * Book this post with every platform that will hold it. Safe to call as
   * often as you like: an account already booked is skipped, and the booking
   * is written to disk the moment each one succeeds, so a crash half-way
   * through never books the same account twice.
   */
  /*
   * ONE BOOKING RUN PER POST AT A TIME, in this process too. The lock below
   * keeps other processes out, but not a second run here — and a post's first
   * run (when it is added) can take minutes (a sermon's upload, a flyer's
   * video), long enough for the next tick to start another that books the same
   * accounts again. So runs for a post queue: the second finds them booked.
   */
  handOff(id) {
    return this._q(id, () => this._handOffNow(id));
  }

  async _handOffNow(id) {
    const release = this._lock('handoff');
    if (!release) return { booked: 0, pending: true };
    try {
      this._syncPosts(true);
      const post = (this.store.get('posts') || []).find((p) => p.id === id);
      if (!post || post.status !== 'scheduled') return { booked: 0 };
      const when = new Date(post.scheduledAt).getTime();
      // Already due: it is the publisher's job now, not the booker's.
      if (!Number.isFinite(when) || when <= this._now()) return { booked: 0, why: 'due' };

      const handoffs = { ...(post.handoffs || {}) };
      const errors = {};
      let booked = 0, retryable = false;

      const content = this._contentOf(post);
      for (const acc of this.targetsFor(post)) {
        // the post as it is NOW, before an upload is spent on it: deleted, moved, reworded or
        // posted meanwhile — this run stops; the account taken off it — skipped
        this._syncPosts(true);
        const cur = (this.store.get('posts') || []).find((p) => p.id === id);
        if (!cur || cur.status !== 'scheduled' || this._contentOf(cur) !== content) break;
        if (!this.targetsFor(cur).some((a) => a.id === acc.id)) continue;
        if ((cur.handoffs || {})[acc.id] && cur.handoffs[acc.id].ok) continue;  // already booked
        if ((cur.results || {})[acc.id] && cur.results[acc.id].ok) continue;    // already posted
        const cap = publisher.canSchedule(acc, when, this._now());
        if (!cap.can) { errors[acc.id] = { why: cap.why, cannotSchedule: true, name: acc.name, platform: acc.platform }; continue; }
        const mm = (cur.handoffErrors || {})[acc.id] && cur.handoffErrors[acc.id].maybeMade;
        // bookings waiting to be taken back are never taken for this one
        const exclude = this._cq().filter((x) => x.accId === acc.id && !x.booking.lookup).map((x) => String(x.booking.zoPostId || x.booking.id || ''));
        this._uploading = this._uploading || new Set();
        this._uploading.add(id);
        try {
          let res;
          try {
            res = await publisher.scheduleTo(acc, post, when, {
              ...this._pubOpts(),
              // the last try got no clear answer: look on the platform for it before making another
              zoLookFirst: !!mm, zoExclude: exclude,
              onTkRefresh: (t) => { try { this.accounts._upsert({ id: acc.id, token: t }); } catch (e) {} },
            });
          } finally { this._uploading.delete(id); }
          handoffs[acc.id] = {
            ok: true, id: res.id, url: res.url, via: res.via, zoPostId: res.zoPostId || null,
            name: acc.name, platform: acc.platform,
            publishAt: res.publishAt, at: new Date().toISOString(),
            // a flyer for the TikTok inbox, or a song Instagram would not take — told, not dropped
            ...(res.inbox ? { inbox: true } : {}), ...(res.note ? { note: res.note } : {}),
          };
          booked++;
          // the post as it stands NOW: moved, reworded, posted, deleted or the account taken
          // off while this was uploading — then this booking is for something that no longer is
          this._syncPosts(true);
          const fresh = (this.store.get('posts') || []).find((p) => p.id === id);
          const outdated = !fresh || fresh.status !== 'scheduled' || this._contentOf(fresh) !== content
            || ((fresh.results || {})[acc.id] && fresh.results[acc.id].ok);
          const dropped = !outdated && !this.targetsFor(fresh).some((a) => a.id === acc.id);
          if (outdated || dropped) {
            try { await publisher.cancelScheduled(acc, handoffs[acc.id], this._pubOpts()); } catch (e2) { this._cancelLater(id, acc.id, handoffs[acc.id], post.title); this._drainSoon(id); }
            delete handoffs[acc.id];
            booked--;
            if (outdated) break;    // the whole post changed (or went): nothing more for this version
            continue;               // only this account was taken off: the others still get booked
          }
          // On disk at once, merged into what is there now (a booking taken back
          // meanwhile is not brought back): a booking this app forgets is a post
          // that goes out anyway, with nothing here knowing it exists.
          this.update(id, { handoffs: { ...(fresh.handoffs || {}), [acc.id]: handoffs[acc.id] } });
          this._flush();
        } catch (e) {
          const why = (e && e.message) || String(e);
          if (e && e.zoMaybeMade) {
            // no clear answer — and the post changed or went while this was uploading: what it may
            // have made is for something that no longer is, so it goes straight on the take-back list
            this._syncPosts(true);
            const fresh = (this.store.get('posts') || []).find((p) => p.id === id);
            const outdated = !fresh || fresh.status !== 'scheduled' || this._contentOf(fresh) !== content;
            if (outdated || !this.targetsFor(fresh).some((a) => a.id === acc.id)) {
              this._cancelLater(id, acc.id, { ok: true, name: acc.name, platform: acc.platform,
                lookup: { content: e.zoContent || (mm && mm.content) || '', at: when, accountId: acc.zoAccountId } }, post.title);
              this._drainSoon(id);
              if (outdated) break;
              continue;
            }
          }
          errors[acc.id] = { why, cannotSchedule: !!(e && e.cannotSchedule), name: acc.name, platform: acc.platform,
            // no clear answer: what was sent, so it can be looked for (and taken back if the post changes)
            ...(e && e.zoMaybeMade ? { maybeMade: { content: e.zoContent || (mm && mm.content) || '', at: when } } : {}) };
          if (!(e && e.cannotSchedule)) retryable = true;
        }
      }

      try {
        // each booking was written the moment it was made; this writes only how the run went —
        // never the bookings again (one taken off meanwhile, by a move, must stay off)
        this._syncPosts(true);
        const now = (this.store.get('posts') || []).find((p) => p.id === id);
        if (!now) throw new Error('gone');
        const tried = new Set(Object.keys(errors).concat(Object.keys(handoffs).filter((k) => handoffs[k] && handoffs[k].ok)));
        const kept = {};
        for (const [k, v] of Object.entries(now.handoffErrors || {})) if (!tried.has(k)) kept[k] = v;
        this.update(id, {
          handoffErrors: { ...kept, ...errors },
          nextHandoffAt: retryable ? new Date(this._now() + HANDOFF_BACKOFF_MS).toISOString() : null,
        });
        this._flush();
      } catch (gone) { /* deleted mid-run: what it booked (or may have) was put to be taken back above */ }
      if (booked) this._pushUpdate(id);
      return { booked, errors };
    } finally {
      try { release(); } catch (e) {}
    }
  }

  /**
   * Give back every booking held for this post. Called when it is deleted or
   * moved — a booked post that is not called off WILL go out on its own, which
   * is the one way this feature could embarrass a church.
   */
  async cancelHandoffs(id) {
    const post = (this.store.get('posts') || []).find((p) => p.id === id);
    if (!post) return { cancelled: 0, failed: [] };
    const handoffs = { ...(post.handoffs || {}) };
    let n = 0;
    for (const [accId, h] of Object.entries(handoffs)) {
      if (h && h.ok) { this._cancelLater(id, accId, h, post.title); delete handoffs[accId]; n++; }
    }
    try { this.update(id, { handoffs }); this._flush(); } catch (e) { /* post may be gone */ }
    const res = await this._q(id, () => this._drainCancels(id));
    return { cancelled: n - res.failed.length, failed: res.failed };
  }

  _notify(title, body, postId) {
    if (this.opts.notify) { try { this.opts.notify(title, body, postId); } catch (e) {} return; }
    try {
      if (Notification && Notification.isSupported()) {
        const n = new Notification({ title, body });
        n.on('click', () => {
          const win = this.getWindow && this.getWindow();
          if (win) { win.show(); win.focus(); win.webContents.send('scheduler:focus-post', postId); }
        });
        n.show();
      }
    } catch (e) {}
  }

  _pushUpdate(postId) {
    try {
      const win = this.getWindow && this.getWindow();
      if (win && !win.isDestroyed()) win.webContents.send('scheduler:due', postId);
    } catch (e) {}
  }

  /**
   * "One-tap publish": opens each platform's composer, copies the caption to the
   * clipboard, and reveals the media file so the user can drop it straight in.
   */
  async publishNow(id) {
    const post = (this.store.get('posts') || []).find((p) => p.id === id);
    if (!post) throw new Error('Post not found.');

    if (post.caption && clipboard) { try { clipboard.writeText(post.caption); } catch (e) {} }
    if (post.mediaPaths && post.mediaPaths[0] && shell) {
      try { shell.showItemInFolder(post.mediaPaths[0]); } catch (e) {}
    }
    const platforms = post.platforms.length ? post.platforms : ['instagram'];
    if (shell) {
      for (const plat of platforms) {
        const url = COMPOSERS[plat] || COMPOSERS.instagram;
        try { await shell.openExternal(url); } catch (e) {}
      }
    }
    this.update(id, { status: 'posted', notified: true });
    return { ok: true, opened: platforms };
  }

  /**
   * Auto-publish one post to every linked account it targets (used by the
   * tick when a post comes due, and by the ⚡/Retry buttons). Each account
   * records its own result; accounts that already posted are never repeated.
   * Handles retry counting + statuses.
   */
  async autoPublish(id) {
    // came due while its booking was still uploading: that run finishes first, and what it
    // booked counts as booked — publishing it here as well would post it twice
    if (this._busyWith(id)) { await this._afterRuns(id); this._syncPosts(true); }
    let post = (this.store.get('posts') || []).find((p) => p.id === id);
    if (!post) throw new Error('Post not found.');
    const targets = this.targetsFor(post);
    if (!targets.length) {
      throw new Error('No linked account for this post — hit “Connect account” in the Scheduler, or add a Page ID and token in Settings.');
    }
    if (this._busy.has(id)) return { pending: true };

    // The studio and the background poster can both be alive for a moment
    // (the studio was just opened while a background run was in flight). One
    // of them publishes; the other is told to leave it alone.
    const release = this._lock('publish');
    if (!release) return { pending: true, reason: 'Another copy of Church Work Space is publishing right now.' };

    this._busy.add(id);
    try {
      // Now that nobody else can be mid-publish, take the schedule as it
      // stands ON DISK — the other process may have posted this already. This
      // is the one read that must not be skipped on a stat that looks
      // unchanged, so it is forced (see Store.reloadKey).
      this._syncPosts(true);
      post = (this.store.get('posts') || []).find((p) => p.id === id) || post;
      if (post.status === 'posted') return { posted: true, results: post.results || {}, already: true };

      this.update(id, { status: 'posting', error: null });
      this._flush();
      this._pushUpdate(id);
      const results = { ...(post.results || {}) };
      const booked = post.handoffs || {};
      const errors = [];
      for (const acc of targets) {
        if (results[acc.id] && results[acc.id].ok) continue; // posted there already
        /*
         * The platform is already holding this one and publishing it at the
         * appointed second (handOff, above). Sending it again here is not a
         * retry — it is the same sermon on the Page twice. Record the booking
         * as the result and move on without touching the network.
         */
        if (booked[acc.id] && booked[acc.id].ok) {
          results[acc.id] = {
            ok: true, id: booked[acc.id].id, url: booked[acc.id].url,
            name: acc.name, platform: acc.platform,
            postedAt: booked[acc.id].publishAt, byPlatform: true,
            ...(booked[acc.id].inbox ? { inbox: true } : {}), ...(booked[acc.id].note ? { note: booked[acc.id].note } : {}),
          };
          continue;
        }
        try {
          const res = await publisher.publishTo(acc, post, {
            ...this._pubOpts(),
            zoLookFirst: !!(((post.results || {})[acc.id] && post.results[acc.id].maybeMade) || ((post.handoffErrors || {})[acc.id] && post.handoffErrors[acc.id].maybeMade)),
            zoExclude: this._cq().filter((x) => x.accId === acc.id && !x.booking.lookup).map((x) => String(x.booking.zoPostId || x.booking.id || '')),
            // TikTok rotates refresh tokens sometimes — persist the new one.
            onTkRefresh: (t) => { try { this.accounts._upsert({ id: acc.id, token: t }); } catch (e) {} },
          });
          results[acc.id] = {
            ok: true, id: res.id, url: res.url,
            name: acc.name, platform: acc.platform, postedAt: new Date().toISOString(),
            ...(res.inbox ? { inbox: true } : {}), ...(res.note ? { note: res.note } : {}),
          };
        } catch (err) {
          const msg = (err && err.message) || String(err);
          results[acc.id] = { ok: false, error: msg, name: acc.name, platform: acc.platform, ...(err && err.zoMaybeMade ? { maybeMade: true } : {}) };
          errors.push((targets.length > 1 ? acc.name + ': ' : '') + msg);
        }
        // Persist progress after every account, so a crash never re-posts.
        // "Persist" has to mean ON DISK: the store batches writes 50ms later,
        // and a post that is only in this process's memory is exactly the one
        // the other process would publish a second time.
        this.update(id, { results });
        this._flush();
      }

      const fbRes = targets.map((t) => results[t.id]).find((r) => r && r.ok && r.platform === 'facebook');
      const legacyFields = fbRes ? { fbPostId: fbRes.id, fbUrl: fbRes.url } : {};

      if (!errors.length) {
        const autoPlats = new Set(targets.map((t) => t.platform));
        const others = (post.platforms || []).filter((p) => !autoPlats.has(p));
        this.update(id, {
          status: 'posted', notified: true, autoPosted: true, results,
          ...legacyFields, postedAt: new Date().toISOString(), error: null, nextAttemptAt: null,
        });
        // a flyer in the TikTok inbox is not posted yet: someone adds the song there
        const inbox = targets.filter((t) => results[t.id] && results[t.id].inbox);
        const live = targets.filter((t) => !(results[t.id] && results[t.id].inbox));
        const where = live.map((t) => t.name).join(', ');
        const notes = targets.map((t) => results[t.id] && results[t.id].note && !results[t.id].inbox ? `${t.name}: ${results[t.id].note}` : '').filter(Boolean);
        const inboxLine = inbox.length ? ` In ${inbox.map((t) => t.name).join(', ')}’s TikTok inbox — open TikTok, tap the notification, add your song and post.` : '';
        // Say which it was. "Posted" when the app did it and "the platform is
        // publishing it now" are different facts, and the operator deserves
        // the one that is true — especially if they never had the app open.
        const allByPlatform = live.every((t) => results[t.id] && results[t.id].byPlatform);
        const how = (!live.length ? 'Waiting for you in TikTok.'
          : allByPlatform
            ? `${where} booked this in advance and ${live.length > 1 ? 'are' : 'is'} publishing it now.`
            : `Auto-published to ${where}.`) + inboxLine + (notes.length ? ' ' + notes.join(' ') : '');
        this._notify((live.length ? '✅ Posted: ' : '📥 In your TikTok inbox: ') + post.title,
          others.length
            ? `${how} ${others.join(', ')} still need a one-tap publish.`
            : how,
          id);
        this._pushUpdate(id);
        return { posted: true, results, id: fbRes && fbRes.id, url: fbRes && fbRes.url };
      }

      const attempts = (post.attempts || 0) + 1;
      const msg = errors.join(' · ');
      if (attempts >= MAX_ATTEMPTS) {
        this.update(id, { status: 'failed', attempts, error: msg, results, notified: true, ...legacyFields });
        this._notify('⚠️ Post failed: ' + post.title, msg.slice(0, 180) + ' — open the Scheduler to retry.', id);
      } else {
        this.update(id, {
          status: 'scheduled', attempts, error: msg, results, ...legacyFields,
          nextAttemptAt: new Date(this._now() + RETRY_BACKOFF_MS).toISOString(),
        });
      }
      this._pushUpdate(id);
      throw new Error(msg);
    } finally {
      this._busy.delete(id);
      // On disk before the lock goes, always — otherwise whoever takes the lock
      // next reads a schedule that does not yet know this post went out.
      this._flush();
      try { release(); } catch (e) {}
    }
  }

  /** Reset a failed post so the tick picks it up again immediately. */
  retry(id) {
    const rec = this.update(id, { status: 'scheduled', attempts: 0, error: null, notified: false, nextAttemptAt: null });
    // Fire straight away rather than waiting for the next tick.
    this._tick();
    return rec;
  }

  /**
   * Run one round of "is anything due?" and wait for it. This is the whole of
   * what the background poster does, which is why it is a method and not a
   * private tick: exactly the same code publishes whether the studio is open
   * or the operating system woke us up for ninety seconds.
   */
  async tickNow() { return this._tick(); }

  /** Called on an interval: publish/notify posts that are now due. */
  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      this._syncPosts();
      const now = this._now();

      /*
       * Book anything that is not booked yet, BEFORE publishing anything.
       * A post scheduled while the wifi was down, or added by a version of
       * this app that had never heard of booking, gets picked up here — which
       * is what makes "switch the PC off and it still goes out" true for
       * posts that were made before the feature existed.
       */
      for (const p of (this.store.get('posts') || [])) {
        if (p.status !== 'scheduled') continue;
        if (new Date(p.scheduledAt).getTime() <= now) continue;         // due — publish, don't book
        if (p.nextHandoffAt && new Date(p.nextHandoffAt).getTime() > now) continue;
        if (this._busyWith(p.id)) continue;   // already being booked: never waited on here (other posts are due)
        const plan = this.handoffPlan(p);
        if (!plan.bookable.some((b) => !b.booked)) continue;
        try { await this.handOff(p.id); } catch (e) { /* recorded on the post */ }
      }

      const due = (this.store.get('posts') || []).filter((p) =>
        p.status === 'scheduled' &&
        new Date(p.scheduledAt).getTime() <= now &&
        (!p.nextAttemptAt || new Date(p.nextAttemptAt).getTime() <= now));

      for (const p of due) {
        if (this._busyWith(p.id)) continue;   // its booking is still uploading: next tick, never twice
        if (this.targetsFor(p).length) {
          try { await this.autoPublish(p.id); } catch (e) { /* recorded on the post */ }
          continue;
        }
        // Reminder flow (no linked account can auto-publish this post)
        if (p.notified) continue;
        this.update(p.id, { notified: true });
        this._notify('⏰ Time to post: ' + p.title,
          ((p.platforms || []).join(', ') || 'social') + ' — click to open the publisher.', p.id);
        this._pushUpdate(p.id);
      }
      // bookings still to be taken back (a cancel that failed, the app closed mid-way): tried
      // again — after the due posts are out, and each one less often as it keeps failing
      for (const pid of new Set(this._cq().map((x) => x.postId))) {
        if (this._busyWith(pid)) continue;   // its own queue takes care of it
        try { await this._q(pid, () => this._drainCancels(pid, { due: true })); } catch (e) {}
      }
    } finally {
      this._ticking = false;
    }
  }

  start() {
    this._syncPosts();
    // A crash mid-upload can leave a post stuck on "posting" — recover it.
    // But "posting" can also mean the background poster is uploading it RIGHT
    // NOW, and resetting that one is how the same video goes out twice; the
    // lock tells the two apart, so only recover when nobody holds it.
    const release = this._lock('recover');
    if (release) {
      const posts = this.store.get('posts') || [];
      let dirty = false;
      for (const p of posts) {
        if (p.status === 'posting') { p.status = 'scheduled'; dirty = true; }
      }
      if (dirty) this.store.set('posts', posts);
      try { release(); } catch (e) {}
    }

    this._tick(); // catch up anything that came due while the app was closed
    this._timer = setInterval(() => this._tick(), this.opts.intervalMs || 20 * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Scheduler, COMPOSERS, MAX_ATTEMPTS, RETRY_BACKOFF_MS };
