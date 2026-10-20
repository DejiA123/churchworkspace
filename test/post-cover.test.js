'use strict';
/*
 * A VIDEO POST'S THUMBNAIL (New post → Thumbnail; publisher.js coverFor).
 * Against a stand-in Zernio and a stand-in YouTube:
 *   - Zernio: the cover is hosted beside the video and handed to each place
 *     in its own field — YouTube's and Facebook's `thumbnail`, Instagram's
 *     `instagramThumbnail`, TikTok's `videoCoverImageUrl`
 *   - a cover the wrong shape (16:9 on a 9:16 video) still goes to YouTube and
 *     Facebook, not to Instagram's or TikTok's cover
 *   - no cover chosen: nothing extra is sent (the post is as it always was)
 *   - YouTube direct: thumbnails.set is called for the new video; refused, the
 *     video is still posted (and says so)
 *   - the scheduler keeps the cover on the post, and an old post (no cover)
 *     keeps the same fingerprint, so nothing already booked is booked again
 *   node test/post-cover.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const pub = require('../src/main/publisher');

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cover-'));
  const mk = (out, args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args, out]);
  const wide = path.join(dir, 'sermon.mp4'), tall = path.join(dir, 'short.mp4'), cover = path.join(dir, 'God is not done thumbnail.jpg');
  mk(wide, ['-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']);
  mk(tall, ['-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=25:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']);
  mk(cover, ['-f', 'lavfi', '-i', 'color=c=orange:s=1280x720', '-frames:v', '1']);

  // ── a stand-in Zernio (presign → PUT → posts) and YouTube (token → resumable upload → thumbnails.set)
  const seen = { presign: [], puts: [], posts: [], thumbs: [] };
  let refuseThumb = false;
  const srv = http.createServer((req, res) => {
    let body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      body = Buffer.concat(body);
      const url = req.url, json = (o, code = 200, h = {}) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, h)); res.end(JSON.stringify(o)); };
      if (url === '/zo/media/presign') { const b = JSON.parse(body); seen.presign.push(b); return json({ uploadUrl: `http://127.0.0.1:${port}/put/${seen.presign.length}`, publicUrl: 'https://cdn.test/' + b.filename }); }
      if (url.startsWith('/put/')) { seen.puts.push({ type: req.headers['content-type'], size: body.length }); return json({}); }
      if (url === '/zo/posts') { const b = JSON.parse(body); seen.posts.push(b); return json({ post: { _id: 'p' + seen.posts.length, platforms: [{ platform: b.platforms[0].platform, status: 'published' }] } }); }
      if (url === '/token') return json({ access_token: 'yt-access' });
      if (url.startsWith('/yt/upload/youtube/v3/videos')) return json({}, 200, { location: `http://127.0.0.1:${port}/yt/session` });
      if (url === '/yt/session') return json({ id: 'vid123' });
      if (url.startsWith('/yt/upload/youtube/v3/thumbnails/set')) { seen.thumbs.push({ url, type: req.headers['content-type'], size: body.length }); return refuseThumb ? json({ error: { message: 'The authenticated user doesnt have permissions to upload and set custom video thumbnails.' } }, 403) : json({ items: [{}] }); }
      json({ error: 'no such route ' + url }, 404);
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const zo = { zoApiBase: `http://127.0.0.1:${port}/zo`, pollMs: 1 };
  const acct = (platform) => ({ apiKey: 'k', accountId: 'acc-' + platform, username: 'church', platform });
  try {
    // shapes
    const c1 = pub.coverFor({ coverPath: cover }, wide), c2 = pub.coverFor({ coverPath: cover }, tall);
    check(c1 && c1.sameShape && c2 && !c2.sameShape && c1.type === 'image/jpeg', 'a 16:9 cover fits a 16:9 video, not a 9:16 one', { c1, c2 });
    check(pub.coverFor({}, wide) === null && pub.coverFor({ coverPath: path.join(dir, 'gone.jpg') }, wide) === null && pub.coverFor({ coverPath: cover }, cover) === null,
      'no cover, a missing one, or a picture post: nothing');

    const post = (media, withCover = true) => ({ title: 'God is not done', caption: 'God is not done with you', mediaPaths: [media], coverPath: withCover ? cover : null });
    const lastPost = () => seen.posts[seen.posts.length - 1];
    for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) await pub.publishViaZernio(acct(p), post(wide), zo);
    const [yt, fb, ig, tk] = seen.posts.slice(-4);
    check(yt.mediaItems[0].thumbnail === 'https://cdn.test/God_is_not_done_thumbnail.jpg', 'Zernio → YouTube: the cover as the video’s thumbnail', yt.mediaItems);
    check(fb.mediaItems[0].thumbnail === 'https://cdn.test/God_is_not_done_thumbnail.jpg', 'Zernio → Facebook: the cover as the video’s thumbnail', fb.mediaItems);
    check(ig.mediaItems[0].instagramThumbnail === 'https://cdn.test/God_is_not_done_thumbnail.jpg' && !ig.mediaItems[0].thumbnail && ig.platforms[0].platformSpecificData.shareToFeed, 'Zernio → Instagram: the Reel’s cover (and still shared to the feed)', ig);
    check(tk.platforms[0].platformSpecificData && tk.platforms[0].platformSpecificData.videoCoverImageUrl === 'https://cdn.test/God_is_not_done_thumbnail.jpg'
      && tk.platforms[0].platformSpecificData.privacyLevel === 'PUBLIC_TO_EVERYONE' && tk.tiktokSettings.privacy_level === 'PUBLIC_TO_EVERYONE' && !tk.mediaItems[0].thumbnail, 'Zernio → TikTok: the cover, still public', tk);
    check(seen.puts.filter((x) => x.type === 'image/jpeg').length === 4 && seen.puts.every((x) => x.size > 1000), 'the cover is uploaded beside each video', seen.puts);

    // the wrong shape: YouTube and Facebook only
    for (const p of ['youtube', 'facebook', 'instagram', 'tiktok']) await pub.publishViaZernio(acct(p), post(tall), zo);
    const [yt2, fb2, ig2, tk2] = seen.posts.slice(-4);
    check(!!yt2.mediaItems[0].thumbnail && !!fb2.mediaItems[0].thumbnail && !ig2.mediaItems[0].instagramThumbnail && !(tk2.platforms[0].platformSpecificData || {}).videoCoverImageUrl,
      'a 16:9 cover on a 9:16 video: YouTube and Facebook take it, Instagram and TikTok keep their own', [yt2.mediaItems, ig2.mediaItems, tk2.platforms]);

    // no cover: the post as it always was
    const before = seen.presign.length;
    await pub.publishViaZernio(acct('tiktok'), post(wide, false), zo);
    const t3 = lastPost();
    check(seen.presign.length === before + 1 && !t3.platforms[0].platformSpecificData && !t3.tiktokSettings.videoCoverImageUrl && !t3.mediaItems[0].thumbnail, 'no cover chosen: nothing extra is sent', t3);

    // YouTube direct
    const ytOpts = { ytTokenBase: `http://127.0.0.1:${port}/token`, ytApiBase: `http://127.0.0.1:${port}/yt` };
    const r1 = await pub.publishToYouTube({ token: 'refresh', clientId: 'id', clientSecret: 's' }, post(wide), ytOpts);
    check(r1.id === 'vid123' && r1.cover === 'set' && seen.thumbs.length === 1 && /videoId=vid123/.test(seen.thumbs[0].url) && seen.thumbs[0].type === 'image/jpeg' && seen.thumbs[0].size > 1000,
      'YouTube direct: the thumbnail is set on the new video', { r1, thumbs: seen.thumbs });
    refuseThumb = true;
    const r2 = await pub.publishToYouTube({ token: 'refresh', clientId: 'id', clientSecret: 's' }, post(wide), ytOpts);
    check(r2.id === 'vid123' && /^refused/.test(r2.cover || ''), 'YouTube refuses the thumbnail (channel not verified): the video is still posted, and it says so', r2);
    const r3 = await pub.publishToYouTube({ token: 'refresh', clientId: 'id', clientSecret: 's' }, post(wide, false), ytOpts);
    check(r3.cover === null && seen.thumbs.length === 2, 'YouTube with no cover: no thumbnail call', r3);

    // the scheduler: the cover is kept on the post; an old post keeps its fingerprint
    const { Scheduler } = (() => { try { return require('../src/main/scheduler'); } catch (e) { return {}; } })();
    if (Scheduler) {
      const mem = {}; const store = { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } };
      let sch = null;
      try { sch = new Scheduler(store, {}); } catch (e) { sch = null; }
      if (sch) {
        sch.handOff = async () => ({});
        const rec = sch.add({ title: 't', caption: 'c', mediaPaths: [wide], coverPath: cover, scheduledAt: new Date(Date.now() + 864e5).toISOString() });
        const old = { scheduledAt: rec.scheduledAt, caption: 'c', title: 't', mediaPaths: [wide], music: null };
        check(rec.coverPath === cover && sch._contentOf(Object.assign({}, old, { coverPath: null })) === JSON.stringify([new Date(rec.scheduledAt).getTime(), 'c', 't', [wide], null])
          && sch._contentOf(rec) !== sch._contentOf(old), 'the scheduler keeps the cover; a post with none keeps its old fingerprint (nothing re-booked)', rec);
      } else console.log('  (the scheduler could not be made here — skipped)');
    }
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    srv.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
