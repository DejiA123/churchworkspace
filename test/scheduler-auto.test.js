'use strict';
/**
 * AUTO-SCHEDULE end-to-end test (plain Node, no Electron window needed).
 *
 * Boots a mock Facebook Graph API server, then proves the scheduler REALLY
 * auto-publishes:
 *   - photo / video / text posts hit the right Graph endpoints with the right
 *     fields and the exact file bytes
 *   - a post scheduled in the past ("app was closed") publishes on start()
 *   - failures retry with backoff and finally mark the post failed
 *   - retry() after fixing the token publishes for real
 *   - non-Facebook posts still get the reminder flow
 *   - a bad token surfaces Facebook's error message
 *
 * Run: node test/scheduler-auto.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const publisher = require('../src/main/publisher');
const { Scheduler, MAX_ATTEMPTS } = require('../src/main/scheduler');
const { Store } = require('../src/main/store');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- mock Graph API server ------------------------ */

const received = []; // { url, method, fields, fileBytes, fileName }

function parseMultipart(body, boundary) {
  const fields = {}; let fileBytes = null; let fileName = null;
  const sep = Buffer.from('--' + boundary);
  let idx = 0; const parts = [];
  while (true) {
    const next = body.indexOf(sep, idx);
    if (next === -1) break;
    if (idx > 0) parts.push(body.slice(idx, next - 2)); // strip trailing \r\n
    idx = next + sep.length + 2; // skip boundary + \r\n (or --)
  }
  for (const part of parts) {
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = part.slice(0, headEnd).toString();
    const data = part.slice(headEnd + 4);
    const name = (head.match(/name="([^"]+)"/) || [])[1];
    const fname = (head.match(/filename="([^"]+)"/) || [])[1];
    if (fname) { fileBytes = data; fileName = fname; }
    else if (name) fields[name] = data.toString();
  }
  return { fields, fileBytes, fileName };
}

function startMockGraph() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const entry = { url: u.pathname, method: req.method, fields: {}, fileBytes: null, fileName: null };

        if (req.method === 'GET') {
          const token = u.searchParams.get('access_token');
          entry.fields = Object.fromEntries(u.searchParams.entries());
          received.push(entry);
          if (token === 'goodtoken') {
            res.end(JSON.stringify({ id: '111222333', name: 'Grace Chapel' }));
          } else {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } }));
          }
          return;
        }

        const ct = req.headers['content-type'] || '';
        if (ct.startsWith('multipart/form-data')) {
          const boundary = (ct.match(/boundary=(.+)$/) || [])[1];
          Object.assign(entry, parseMultipart(body, boundary));
        } else {
          entry.fields = Object.fromEntries(new URLSearchParams(body.toString()).entries());
        }
        received.push(entry);

        if (entry.fields.access_token !== 'goodtoken') {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.' } }));
          return;
        }
        if (u.pathname.endsWith('/videos')) res.end(JSON.stringify({ id: 'vid_' + received.length }));
        else if (u.pathname.endsWith('/photos')) res.end(JSON.stringify({ id: 'ph_' + received.length, post_id: 'page_ph_' + received.length }));
        else res.end(JSON.stringify({ id: 'feed_' + received.length }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}/v19.0` }));
  });
}

/* --------------------------------- tests -------------------------------- */

(async () => {
  console.log('== AUTO-SCHEDULE / FACEBOOK PUBLISHER TEST ==');
  const { server, base } = await startMockGraph();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sched-'));

  // Sample media files (bytes just need to round-trip exactly)
  const photo = path.join(tmp, 'flyer.png');
  fs.writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 250, 251, 252]));
  const videoF = path.join(tmp, 'sermon.mp4');
  fs.writeFileSync(videoF, Buffer.alloc(96 * 1024, 7)); // 96KB "video"

  /* --- publisher unit checks --- */
  const t = await publisher.testFacebook({ pageId: 'mypage', token: 'goodtoken', apiBase: base });
  check('testFacebook returns the Page name', t.name === 'Grace Chapel' && t.id === '111222333', JSON.stringify(t));

  const rPhoto = await publisher.publishToFacebook({ pageId: 'mypage', token: 'goodtoken', apiBase: base },
    { caption: 'Youth Night this Friday! 🎉', mediaPaths: [photo] });
  const gotPhoto = received.find((r) => r.url === '/v19.0/mypage/photos');
  check('photo post hits /photos', !!gotPhoto);
  check('photo caption + token sent', gotPhoto && gotPhoto.fields.caption === 'Youth Night this Friday! 🎉' && gotPhoto.fields.access_token === 'goodtoken');
  check('photo file bytes round-trip EXACTLY', gotPhoto && gotPhoto.fileBytes && gotPhoto.fileBytes.equals(fs.readFileSync(photo)),
    gotPhoto && gotPhoto.fileBytes ? `${gotPhoto.fileBytes.length} vs ${fs.statSync(photo).size}` : 'no file');
  check('photo publish returns post id + url', rPhoto.id === gotPhoto.fields ? false : /^page_ph_/.test(rPhoto.id) && rPhoto.url.includes(rPhoto.id));

  const rVid = await publisher.publishToFacebook({ pageId: 'mypage', token: 'goodtoken', apiBase: base },
    { caption: 'Full sermon', mediaPaths: [videoF] });
  // Since v2.44.1 the publisher OFFERS an upload session first, so the first
  // thing to arrive at /videos is that offer, not the video. This mock has no
  // session to give (that path is proved in test/social-accounts.test.js), so
  // it falls back to one POST — and it is that POST, the one carrying the
  // file, this is about.
  const gotVid = received.find((r) => r.url === '/v19.0/mypage/videos' && r.fileBytes);
  check('video post hits /videos with description', !!gotVid && gotVid.fields.description === 'Full sermon');
  check('video file bytes round-trip EXACTLY (96KB streamed)', gotVid && gotVid.fileBytes && gotVid.fileBytes.equals(fs.readFileSync(videoF)));
  check('video publish returns id', /^vid_/.test(rVid.id));

  const rTxt = await publisher.publishToFacebook({ pageId: 'mypage', token: 'goodtoken', apiBase: base },
    { caption: 'Service moved to 11am this Sunday.', mediaPaths: [] });
  const gotTxt = received.find((r) => r.url === '/v19.0/mypage/feed');
  check('text-only post hits /feed with message', !!gotTxt && gotTxt.fields.message === 'Service moved to 11am this Sunday.');
  check('text publish returns id', /^feed_/.test(rTxt.id));

  let badErr = null;
  try { await publisher.publishToFacebook({ pageId: 'mypage', token: 'WRONG', apiBase: base }, { caption: 'x', mediaPaths: [] }); }
  catch (e) { badErr = e.message; }
  check('bad token surfaces Facebook error message', badErr === 'Invalid OAuth access token.', badErr);

  /* --- scheduler: auto-publish a post that was due while "the app was closed" --- */
  const notifications = [];
  const notify = (title, body, id) => notifications.push({ title, body, id });

  function makeStore(token) {
    const store = new Store(path.join(tmp, 'store-' + Date.now() + Math.random().toString(36).slice(2) + '.json'), {
      settings: { accounts: { fbPageId: 'mypage', fbToken: token, fbApiBase: base } },
      posts: [],
    });
    return store;
  }

  const store1 = makeStore('goodtoken');
  const s1 = new Scheduler(store1, () => null, { notify, intervalMs: 200 });
  const due = s1.add({
    title: 'Sunday flyer', caption: 'Join us! 🙏', platforms: ['facebook', 'instagram'],
    mediaPaths: [photo], scheduledAt: new Date(Date.now() - 60 * 1000).toISOString(), // due 1 min ago
  });
  s1.add({
    title: 'Future post', caption: 'later', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(Date.now() + 3600 * 1000).toISOString(), // NOT due
  });
  s1.start();
  await sleep(900);
  s1.stop();

  const after1 = s1.list();
  const posted = after1.find((p) => p.id === due.id);
  check('due post AUTO-PUBLISHED on start (app-was-closed catch-up)', posted.status === 'posted' && posted.autoPosted === true, posted.status + ' ' + (posted.error || ''));
  check('posted record carries the Facebook post id', /ph_/.test(posted.fbPostId || ''), posted.fbPostId);
  check('future post left untouched', after1.find((p) => p.title === 'Future post').status === 'scheduled');
  const okNote = notifications.find((n) => n.title.includes('✅'));
  check('success notification fired (mentions remaining platforms)', !!okNote && /instagram/.test(okNote.body), okNote && okNote.body);

  /* --- scheduler: failure → retries with backoff → failed → retry() succeeds --- */
  let fakeNow = Date.now();
  const store2 = makeStore('WRONGTOKEN');
  const s2 = new Scheduler(store2, () => null, { notify, intervalMs: 100, now: () => fakeNow });
  const doomed = s2.add({
    title: 'Doomed post', caption: 'will fail', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(fakeNow - 1000).toISOString(),
  });
  s2.start();
  await sleep(400);
  let d = s2.list().find((p) => p.id === doomed.id);
  check('failed attempt 1 recorded, still scheduled with backoff', d.attempts === 1 && d.status === 'scheduled' && !!d.nextAttemptAt, JSON.stringify({ a: d.attempts, s: d.status }));
  check('error message stored on the post', /Invalid OAuth/.test(d.error || ''), d.error);

  fakeNow += 2 * 60 * 1000; // jump past backoff → attempt 2
  await sleep(400);
  fakeNow += 2 * 60 * 1000; // → attempt 3 (final)
  await sleep(400);
  s2.stop();
  d = s2.list().find((p) => p.id === doomed.id);
  check(`post marked FAILED after ${MAX_ATTEMPTS} attempts`, d.status === 'failed' && d.attempts === MAX_ATTEMPTS, JSON.stringify({ a: d.attempts, s: d.status }));
  check('failure notification fired', notifications.some((n) => n.title.includes('⚠️')));

  // User fixes the token in Settings, hits Retry → must publish for real.
  store2.set('settings', { accounts: { fbPageId: 'mypage', fbToken: 'goodtoken', fbApiBase: base } });
  s2.retry(doomed.id);
  await sleep(500);
  d = s2.list().find((p) => p.id === doomed.id);
  check('Retry after fixing token → actually posted', d.status === 'posted' && /feed_/.test(d.fbPostId || ''), d.status + ' ' + (d.error || ''));

  /* --- scheduler: non-Facebook post stays reminder-only --- */
  const store3 = makeStore('goodtoken');
  const s3 = new Scheduler(store3, () => null, { notify, intervalMs: 100 });
  const ig = s3.add({
    title: 'IG reel', caption: 'reel', platforms: ['instagram'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s3.start(); await sleep(300); s3.stop();
  const igPost = s3.list().find((p) => p.id === ig.id);
  check('instagram-only post: reminder fired, NOT auto-posted', igPost.status === 'scheduled' && igPost.notified === true && !igPost.autoPosted);
  check('reminder notification fired for it', notifications.some((n) => n.title.includes('⏰') && n.id === ig.id));

  /* --- scheduler: facebook post WITHOUT token falls back to reminder --- */
  const store4 = makeStore(''); // no token
  const s4 = new Scheduler(store4, () => null, { notify, intervalMs: 100 });
  const fbNoTok = s4.add({
    title: 'FB no token', caption: 'x', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s4.start(); await sleep(300); s4.stop();
  const nt = s4.list().find((p) => p.id === fbNoTok.id);
  check('facebook post with no token → reminder flow (no crash)', nt.status === 'scheduled' && nt.notified === true);

  /* --- crash recovery: a post stuck on "posting" resets on start --- */
  const store5 = makeStore('goodtoken');
  const s5 = new Scheduler(store5, () => null, { notify, intervalMs: 60 * 1000 });
  const stuck = s5.add({
    title: 'Stuck post', caption: 'recover me', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s5.update(stuck.id, { status: 'posting' }); // simulate crash mid-upload
  s5.start(); await sleep(500); s5.stop();
  const rec = s5.list().find((p) => p.id === stuck.id);
  check('post stuck on "posting" recovers and publishes on next launch', rec.status === 'posted', rec.status);

  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
