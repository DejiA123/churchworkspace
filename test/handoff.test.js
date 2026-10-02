'use strict';
/**
 * "THEY SHOULD STILL POST EVEN WHEN THE PC IS OFF!!"
 *
 * A desktop app cannot run on a switched-off computer, so the only way to make
 * that true is to stop this PC being the thing that posts: upload the video the
 * moment it is scheduled, with the time attached, and let the platform's own
 * servers publish it. This file checks that the app really does that, and — far
 * more important — that having done it, it never posts the same thing again.
 *
 * What is checked, per platform, on the wire:
 *   Facebook   published=false + scheduled_publish_time, for video, photo and
 *              text alike, and the video bytes still arrive intact.
 *   YouTube    uploaded privacyStatus=private with status.publishAt (YouTube
 *              refuses publishAt on anything else).
 *   Zernio     scheduledFor instead of publishNow — the ONLY route by which an
 *              Instagram Reel or a TikTok can go out with the PC off, because
 *              neither Meta nor TikTok will book one.
 *
 * And the things that would hurt a church:
 *   - a booked post is NOT published a second time when its time comes;
 *   - deleting it gives the booking back, so it does not go out anyway;
 *   - moving it gives back the old booking and takes a new one;
 *   - an account that cannot be booked is not silently treated as if it were.
 *
 *   npm run test:handoff
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const publisher = require('../src/main/publisher');
const { Scheduler } = require('../src/main/scheduler');
const { Store } = require('../src/main/store');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const head = (s) => console.log('\n' + s);

/* ---------------- one mock server standing in for everybody -------------- */

const seen = [];      // every request that arrived
const deleted = [];   // every DELETE, i.e. every booking given back

function parseMultipart(body, boundary) {
  const fields = {}; let fileBytes = null;
  const sep = Buffer.from('--' + boundary);
  let idx = 0; const parts = [];
  for (;;) {
    const next = body.indexOf(sep, idx);
    if (next === -1) break;
    if (idx > 0) parts.push(body.slice(idx, next - 2));
    idx = next + sep.length + 2;
  }
  for (const part of parts) {
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = part.slice(0, headEnd).toString();
    const data = part.slice(headEnd + 4);
    const name = (head.match(/name="([^"]+)"/) || [])[1];
    if (/filename="/.test(head)) fileBytes = data;
    else if (name) fields[name] = data.toString();
  }
  return { fields, fileBytes };
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const entry = { url: u.pathname, method: req.method, fields: {}, json: null, fileBytes: null };
        const ct = req.headers['content-type'] || '';

        if (req.method === 'DELETE') {
          deleted.push({ url: u.pathname, query: Object.fromEntries(u.searchParams.entries()) });
          seen.push(entry);
          return res.end(JSON.stringify({ success: true }));
        }
        if (ct.startsWith('multipart/form-data')) {
          Object.assign(entry, parseMultipart(body, (ct.match(/boundary=(.+)$/) || [])[1]));
        } else if (ct.includes('application/json')) {
          try { entry.json = JSON.parse(body.toString()); } catch (e) {}
        } else if (req.method === 'GET') {
          entry.fields = Object.fromEntries(u.searchParams.entries());
        } else {
          entry.fields = Object.fromEntries(new URLSearchParams(body.toString()).entries());
        }
        seen.push(entry);

        // ---- YouTube: resumable upload session, then the bytes ----
        if (u.pathname === '/upload/youtube/v3/videos') {
          res.setHeader('location', `http://127.0.0.1:${server.address().port}/ytput`);
          return res.end(JSON.stringify({}));
        }
        if (u.pathname === '/ytput') return res.end(JSON.stringify({ id: 'ytvid1' }));
        if (u.pathname === '/token') return res.end(JSON.stringify({ access_token: 'ya29.mock' }));

        // ---- Zernio ----
        if (u.pathname === '/zo/v1/media/presign') {
          return res.end(JSON.stringify({
            uploadUrl: `http://127.0.0.1:${server.address().port}/zoput`,
            publicUrl: 'https://cdn.zernio.test/v.mp4',
          }));
        }
        if (u.pathname === '/zoput') return res.end(JSON.stringify({ ok: true }));
        if (u.pathname === '/zo/v1/posts') {
          return res.end(JSON.stringify({ id: 'zo_1', status: 'scheduled', platforms: [{ platform: 'instagram', status: 'scheduled' }] }));
        }

        // ---- Upload-Post ----
        if (u.pathname === '/up/upload' || u.pathname === '/up/upload_photos') {
          res.statusCode = 202;
          const n = seen.filter((x) => x.url === '/up/upload' || x.url === '/up/upload_photos').length;
          return res.end(JSON.stringify({ success: true, job_id: 'scheduler_job_' + n, scheduled_date: entry.fields.scheduled_date }));
        }

        // ---- Facebook Graph ----
        if (u.pathname.endsWith('/videos')) return res.end(JSON.stringify({ id: 'fbvid_' + seen.length }));
        if (u.pathname.endsWith('/photos')) return res.end(JSON.stringify({ id: 'fbph_' + seen.length, post_id: 'page_ph_' + seen.length }));
        return res.end(JSON.stringify({ id: 'fbfeed_' + seen.length }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const p = server.address().port;
      resolve({
        server,
        fb: `http://127.0.0.1:${p}/v19.0`,
        ytApi: `http://127.0.0.1:${p}`,
        ytToken: `http://127.0.0.1:${p}/token`,
        zo: `http://127.0.0.1:${p}/zo/v1`,
        up: `http://127.0.0.1:${p}/up`,
      });
    });
  });
}

/* -------------------------------- fixtures ------------------------------- */

const IN_TWO_HOURS = () => new Date(Date.now() + 2 * 3600e3);

function library(dir, bases, accounts, posts) {
  const file = path.join(dir, 'workstation.json');
  fs.writeFileSync(file, JSON.stringify({
    settings: { accounts: { fbApiBase: bases.fb, ytApiBase: bases.ytApi, ytTokenBase: bases.ytToken, zoApiBase: bases.zo, upApiBase: bases.up } },
    socialAccounts: accounts, posts,
  }, null, 2));
  return file;
}

const FB_ACC = { id: 'fb_1', platform: 'facebook', name: 'Grace Chapel', pageId: 'mypage', token: 'goodtoken' };
const YT_ACC = { id: 'yt_1', platform: 'youtube', name: 'Grace TV', token: 'refresh', clientId: 'cid', clientSecret: 'sec' };
const IG_ZO  = { id: 'ig_z', platform: 'instagram', name: '@grace', via: 'zernio', token: 'zokey', zoAccountId: 'zoacc1', username: 'grace' };
const IG_UP  = { id: 'ig_u', platform: 'instagram', name: '@grace', via: 'uploadpost', token: 'upkey', upUser: 'church-media', username: 'grace' };
const IG_DIR = { id: 'ig_d', platform: 'instagram', name: '@gracedirect', igUserId: 'ig777', pageId: 'mypage', token: 'goodtoken' };

function post(id, opts = {}) {
  return {
    id, title: opts.title || 'Sunday sermon', caption: opts.caption || 'Watch now!',
    platforms: opts.platforms || [], accountIds: opts.accountIds || ['fb_1'],
    mediaPaths: opts.mediaPaths || [], scheduledAt: (opts.when || IN_TWO_HOURS()).toISOString(),
    status: 'scheduled', notified: false, attempts: 0, error: null, results: {}, handoffs: {}, handoffErrors: {},
  };
}

const sched = (file) => {
  const store = new Store(file, {});
  return { store, s: new Scheduler(store, () => null, {}) };
};

/* ---------------------------------- run ---------------------------------- */

(async () => {
  console.log('== HANDING THE POST TO THE PLATFORM (the PC can be off) ==');
  const bases = await startMock();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-handoff-'));
  const videoF = path.join(root, 'sermon.mp4');
  fs.writeFileSync(videoF, Buffer.alloc(64 * 1024, 9));
  const photoF = path.join(root, 'flyer.png');
  fs.writeFileSync(photoF, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));

  /* ================== 1. Facebook takes the booking ================== */
  head('[1] Facebook is handed the video, and holds it');
  {
    const dir = path.join(root, 'fb'); fs.mkdirSync(dir);
    const when = IN_TWO_HOURS();
    const file = library(dir, bases, [FB_ACC], [post('p1', { mediaPaths: [videoF], when })]);
    const { s } = sched(file);

    const r = await s.handOff('p1');
    check('one account was booked', r.booked === 1, JSON.stringify(r.errors));

    const vid = seen.find((x) => x.url === '/v19.0/mypage/videos' && x.fileBytes);
    check('the video really was uploaded now, not at posting time', !!vid);
    check('the exact bytes arrived', vid && vid.fileBytes.equals(fs.readFileSync(videoF)));
    check('marked NOT published, so Facebook holds it', vid && vid.fields.published === 'false', vid && vid.fields.published);
    check('with the time the church chose', vid && Number(vid.fields.scheduled_publish_time) === Math.floor(when.getTime() / 1000),
      vid && vid.fields.scheduled_publish_time);
    check('and the caption', vid && vid.fields.description === 'Watch now!');

    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const h = saved.posts[0].handoffs.fb_1;
    check('the booking is written down on the post', !!h && h.ok && h.via === 'facebook', JSON.stringify(h));
    check('with the id needed to call it off later', !!h.id);

    // THE ONE THAT MATTERS: its time comes, and it must NOT be posted again.
    const before = seen.length;
    s.opts.now = () => when.getTime() + 60000;
    await s.tickNow();
    check('when its time comes NOTHING is sent again', seen.length === before, (seen.length - before) + ' extra requests');
    const after = JSON.parse(fs.readFileSync(file, 'utf8')).posts[0];
    check('the post is marked posted', after.status === 'posted', after.status);
    check('and credited to the platform, not to this PC', after.results.fb_1.byPlatform === true);
    delete s.opts.now;
  }

  /* ============ 2. photos and text posts book the same way =========== */
  head('[2] A photo and a text post are booked too');
  {
    const dir = path.join(root, 'fb2'); fs.mkdirSync(dir);
    const when = IN_TWO_HOURS();
    const file = library(dir, bases, [FB_ACC], [
      post('ph', { mediaPaths: [photoF], when }),
      post('tx', { mediaPaths: [], when }),
    ]);
    const { s } = sched(file);
    await s.handOff('ph');
    await s.handOff('tx');
    const ph = seen.find((x) => x.url === '/v19.0/mypage/photos');
    const tx = seen.find((x) => x.url === '/v19.0/mypage/feed');
    check('the photo is held by Facebook', ph && ph.fields.published === 'false' && !!ph.fields.scheduled_publish_time);
    check('the text post is held by Facebook', tx && tx.fields.published === 'false' && !!tx.fields.scheduled_publish_time);
  }

  /* ==================== 3. YouTube schedules itself ================== */
  head('[3] YouTube holds the video private and makes it public itself');
  {
    const dir = path.join(root, 'yt'); fs.mkdirSync(dir);
    const when = IN_TWO_HOURS();
    const file = library(dir, bases, [YT_ACC], [post('y1', { accountIds: ['yt_1'], mediaPaths: [videoF], when })]);
    const { s } = sched(file);
    const r = await s.handOff('y1');
    check('YouTube took the booking', r.booked === 1, JSON.stringify(r.errors));

    const init = seen.find((x) => x.url === '/upload/youtube/v3/videos' && x.json);
    check('uploaded as PRIVATE (YouTube refuses publishAt otherwise)', init && init.json.status.privacyStatus === 'private',
      init && init.json.status.privacyStatus);
    check('with publishAt set to the time chosen', init && init.json.status.publishAt === when.toISOString(),
      init && init.json.status.publishAt);
    const put = seen.find((x) => x.url === '/ytput');
    check('and the video bytes went up now', !!put);
  }

  /* ======== 4. Instagram/TikTok: only the cloud route can do it ======= */
  head('[4] Instagram — Meta will not book one, so Zernio does');
  {
    const dir = path.join(root, 'ig'); fs.mkdirSync(dir);
    const when = IN_TWO_HOURS();
    const file = library(dir, bases, [IG_ZO], [post('i1', { accountIds: ['ig_z'], mediaPaths: [videoF], when })]);
    const { s } = sched(file);
    const r = await s.handOff('i1');
    check('the Zernio-linked Instagram took the booking', r.booked === 1, JSON.stringify(r.errors));

    const zo = seen.find((x) => x.url === '/zo/v1/posts' && x.json);
    check('sent with scheduledFor, not publishNow', zo && zo.json.scheduledFor === when.toISOString() && !zo.json.publishNow,
      zo && JSON.stringify({ scheduledFor: zo.json.scheduledFor, publishNow: zo.json.publishNow }));
    check('the Reel bytes were uploaded to their CDN now', seen.some((x) => x.url === '/zoput'));

    // A DIRECT Meta Instagram cannot be booked at all — and must say so
    // rather than quietly looking the same as one that can.
    const dir2 = path.join(root, 'ig2'); fs.mkdirSync(dir2);
    const file2 = library(dir2, bases, [IG_DIR], [post('i2', { accountIds: ['ig_d'], mediaPaths: [videoF], when })]);
    const { s: s2 } = sched(file2);
    const before = seen.length;
    const r2 = await s2.handOff('i2');
    check('a direct Instagram books nothing', r2.booked === 0);
    check('and nothing was uploaded on a promise it cannot keep', seen.length === before);
    check('the reason names Meta, and points at the fix',
      /no way to book|Zernio/i.test((r2.errors.ig_d || {}).why || ''), JSON.stringify(r2.errors));
    const plan = s2.handoffPlan(JSON.parse(fs.readFileSync(file2, 'utf8')).posts[0]);
    check('the page will show it as needing this PC on', plan.local.length === 1 && plan.safeWithPcOff === false);
  }

  /* ====== 4b. Instagram through Upload-Post, the second free route ====== */
  head('[4b] Instagram via Upload-Post — the route for when Zernio is full');
  {
    const dir = path.join(root, 'igup'); fs.mkdirSync(dir);
    const when = IN_TWO_HOURS();
    const file = library(dir, bases, [IG_UP], [post('u1', { accountIds: ['ig_u'], mediaPaths: [videoF], when })]);
    const { s } = sched(file);
    const r = await s.handOff('u1');
    check('Upload-Post took the Instagram booking', r.booked === 1, JSON.stringify(r.errors));

    const up = seen.find((x) => x.url === '/up/upload' && x.fields && x.fields.scheduled_date);
    check('the Reel went up now, to the video endpoint', !!up && !!up.fileBytes, JSON.stringify(up && up.fields));
    check('booked for the time chosen', up && up.fields.scheduled_date === when.toISOString());
    check('against the Instagram account', up && up.fields['platform[]'] === 'instagram');

    const h = JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs.ig_u;
    check('the job id is kept, so it can be called off', h && h.ok && h.id === 'scheduler_job_1', JSON.stringify(h));

    // A photo has to go to the OTHER endpoint, under the other field name.
    const dir2 = path.join(root, 'igup2'); fs.mkdirSync(dir2);
    const file2 = library(dir2, bases, [IG_UP],
      [post('u2', { accountIds: ['ig_u'], mediaPaths: [photoF], when })]);
    const { s: s2 } = sched(file2);
    await s2.handOff('u2');
    const ph = seen.find((x) => x.url === '/up/upload_photos');
    check('a photo goes to the photo endpoint instead', !!ph && !!ph.fileBytes, JSON.stringify(ph && ph.fields));
    check('still booked, not posted now', ph && !!ph.fields.scheduled_date);

    // And cancelling gives the job back.
    deleted.length = 0;
    await s.remove('u1');
    check('deleting it cancels the Upload-Post job', deleted.length === 1 && /scheduler_job_1/.test(deleted[0].url),
      JSON.stringify(deleted));
  }

  /* ============ 5. deleting it takes the booking back ============ */
  head('[5] Delete it and Facebook must not post it anyway');
  {
    const dir = path.join(root, 'del'); fs.mkdirSync(dir);
    const file = library(dir, bases, [FB_ACC], [post('d1', { mediaPaths: [photoF] })]);
    const { s } = sched(file);
    await s.handOff('d1');
    const booked = JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs.fb_1;
    check('it is booked to start with', !!booked && booked.ok);

    deleted.length = 0;
    await s.remove('d1');
    check('the booking was given back to Facebook', deleted.length === 1, JSON.stringify(deleted));
    check('by the id Facebook gave us', deleted[0] && deleted[0].url.includes(encodeURIComponent(booked.id).replace(/%2F/g, '/')),
      deleted[0] && deleted[0].url);
    check('and the post is gone from the schedule', JSON.parse(fs.readFileSync(file, 'utf8')).posts.length === 0);
  }

  /* ===== 5b. deleted WHILE the upload is still going up ===== */
  head('[5b] Deleted mid-upload — the booking must not survive the post');
  {
    const dir = path.join(root, 'racedel'); fs.mkdirSync(dir);
    const file = library(dir, bases, [FB_ACC], [post('r1', { mediaPaths: [videoF] })]);
    const { s } = sched(file);

    // Start the booking, then delete the post out from under it — a sermon
    // upload takes minutes, so this is an ordinary Sunday, not a freak race.
    deleted.length = 0;
    const booking = s.handOff('r1');
    const posts = s.store.get('posts').filter((p) => p.id !== 'r1');
    s.store.set('posts', posts); s.store.flushSync();
    const r = await booking;

    check('the booking is reported as not standing', r.booked === 0, JSON.stringify(r));
    check('and it was handed straight back to Facebook', deleted.length === 1, JSON.stringify(deleted));
  }

  /* ============ 6. moving it re-books at the new time ============ */
  head('[6] Move it, and the old booking is given back');
  {
    const dir = path.join(root, 'move'); fs.mkdirSync(dir);
    const file = library(dir, bases, [FB_ACC], [post('m1', { mediaPaths: [photoF] })]);
    const { s } = sched(file);
    await s.handOff('m1');
    const first = JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs.fb_1.id;

    deleted.length = 0;
    const newWhen = new Date(Date.now() + 5 * 3600e3);
    await s.reschedule('m1', { scheduledAt: newWhen.toISOString() });
    // reschedule books again in the background; wait for it to land.
    for (let i = 0; i < 40 && !((JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs || {}).fb_1); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const second = (JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs || {}).fb_1;
    check('the old booking was cancelled', deleted.length === 1, JSON.stringify(deleted));
    check('a new one was taken', !!second && second.id !== first, JSON.stringify(second));
    const last = seen.filter((x) => x.url === '/v19.0/mypage/photos').pop();
    check('at the new time', last && Number(last.fields.scheduled_publish_time) === Math.floor(newWhen.getTime() / 1000));
  }

  /* ============ 7. too soon for Facebook to take it ============ */
  head('[7] Booked for five minutes from now — Facebook will not hold that');
  {
    const dir = path.join(root, 'soon'); fs.mkdirSync(dir);
    const file = library(dir, bases, [FB_ACC], [post('s1', { mediaPaths: [photoF], when: new Date(Date.now() + 5 * 60000) })]);
    const { s } = sched(file);
    const before = seen.length;
    const r = await s.handOff('s1');
    check('nothing is booked', r.booked === 0);
    check('and nothing was uploaded', seen.length === before);
    check('the reason says ten minutes', /10 minutes/.test((r.errors.fb_1 || {}).why || ''), JSON.stringify(r.errors));
    check('so this one falls to the background poster, and the page says so',
      s.handoffPlan(JSON.parse(fs.readFileSync(file, 'utf8')).posts[0]).safeWithPcOff === false);
  }

  /* ====== 8. a post made before this feature existed gets booked ====== */
  head('[8] A post already sitting in the schedule is booked on the next tick');
  {
    const dir = path.join(root, 'old'); fs.mkdirSync(dir);
    const legacy = post('o1', { mediaPaths: [photoF] });
    delete legacy.handoffs; delete legacy.handoffErrors;   // as an older version wrote it
    const file = library(dir, bases, [FB_ACC], [legacy]);
    const { s } = sched(file);
    await s.tickNow();
    const h = (JSON.parse(fs.readFileSync(file, 'utf8')).posts[0].handoffs || {}).fb_1;
    check('the tick booked it without being asked', !!h && h.ok, JSON.stringify(h));
    check('and it is now safe with the PC off',
      s.handoffPlan(JSON.parse(fs.readFileSync(file, 'utf8')).posts[0]).safeWithPcOff === true);
  }

  bases.server.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
