'use strict';
/*
 * MUSIC ON A FLYER — on a phone.
 *
 * "I don't want to be posting a flyer that does not have music. Christian
 * music! Trending ones! Gospel ones! Travis Greene! And it must not be
 * flagged." A popular song baked into a file is what gets a post muted or
 * flagged, so the trending songs come from each app's OWN licensed library.
 * This drives the real Cloud Studio like an iPhone, with a stand-in Zernio and
 * a stand-in free-music site on this machine, and checks:
 *   [1] a flyer chosen: a Music section, on 🔥 Trending songs by itself, saying
 *       what each account gets
 *   [2] Instagram's own songs load by themselves (gospel first); a search for
 *       Travis Greene finds him; ▶ plays a preview; tapping one chooses it
 *   [3] TikTok: "I'll pick a gospel song in TikTok" (by itself), or "TikTok picks a trending song" — or "I'll pick the song in
 *       TikTok" (its inbox — any song, Travis Greene and all)
 *   [4] Facebook and YouTube (no library an app may use) get a free song
 *   [5] scheduled: TikTok to the inbox as a photo post; Instagram a Reel with
 *       the chosen song from Instagram's library; both Facebook pages and
 *       YouTube a 15-second video with the free song, its credit on the caption
 *   [6] an Instagram linked the other way: one button to link it through
 *       Facebook (the sign-in Zernio asks for)
 *   [7] No music: a photo post with nothing added, pictures elsewhere
 *   [8] an Instagram song that can't be used at posting time: the flyer still
 *       goes, with the free song
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-flyer-music.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync, spawnSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7411, ZPORT = 7412, CODE = 'flyer-music-test-7741';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-flymus-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
const probe = (file) => spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' }).stderr;

/* a stand-in Zernio (and a stand-in incompetech under /music/) */
const Z = { posts: [], uploads: {}, audioQs: [], connects: [], n: 0 };
const SONG = path.join(WORK, 'song.mp3');
const IG_SONGS = {
  gospel: [{ audioId: 'ig_gospel_1', title: 'Gospel Joy', artist: 'Choir Live', durationMs: 180000, coverUrl: '', downloadUrl: `http://127.0.0.1:${ZPORT}/preview/1.mp3` },
    { audioId: 'ig_gospel_2', title: 'Way Maker', artist: 'Sinach', durationMs: 240000 }],
  'travis greene': [{ audioId: 'ig_made_a_way', title: 'Made a Way', artist: 'Travis Greene', durationMs: 245000, downloadUrl: `http://127.0.0.1:${ZPORT}/preview/2.mp3` },
    { audioId: 'ig_intentional', title: 'Intentional', artist: 'Travis Greene', durationMs: 290000 }],
  '': [{ audioId: 'ig_trend_1', title: 'Trending One', artist: 'Someone', durationMs: 150000 }],
};
function zernio() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => {
      const body = Buffer.concat(parts);
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname.startsWith('/music/') || u.pathname.startsWith('/preview/')) {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        if (req.method === 'HEAD') return res.end();
        return res.end(fs.readFileSync(SONG));
      }
      let m = u.pathname.match(/^\/api\/v1\/accounts\/([^/]+)\/instagram\/audio$/);
      if (m) {
        Z.audioQs.push({ id: m[1], q: u.searchParams.get('q') || '' });
        if (m[1] === 'fbneeded') return send(400, { error: 'instagram_audio_requires_facebook_login' });
        return send(200, { audio: IG_SONGS[(u.searchParams.get('q') || '').toLowerCase()] || [] });
      }
      if (u.pathname === '/api/v1/accounts') return send(200, { accounts: [{ _id: '3', platform: 'instagram', profileId: 'prof1' }, { _id: 'fbneeded', platform: 'instagram', profileId: 'prof2' }] });
      if (u.pathname === '/api/v1/connect/instagram') { Z.connects.push(Object.fromEntries(u.searchParams.entries())); return send(200, { authUrl: 'https://example.com/fb-login' }); }
      if (u.pathname === '/api/v1/media/presign') {
        const j = JSON.parse(body.toString() || '{}'); const k = ++Z.n;
        return send(200, { uploadUrl: `http://127.0.0.1:${ZPORT}/upload/${k}`, publicUrl: `http://127.0.0.1:${ZPORT}/cdn/${k}/${j.filename}`, _ct: j.contentType });
      }
      m = u.pathname.match(/^\/upload\/(\d+)$/);
      if (m) { Z.uploads[m[1]] = { bytes: body, type: req.headers['content-type'] }; return send(200, {}); }
      if (u.pathname === '/api/v1/posts' && req.method === 'POST') {
        const j = JSON.parse(body.toString() || '{}');
        const plat = j.platforms && j.platforms[0];
        const ac = plat && plat.platformSpecificData && plat.platformSpecificData.audioConfiguration;
        if (Z.fail500) { Z.posts.push({ rejected: true, body: j }); return send(500, { error: 'Internal error' }); }
        // made it, then no clear answer (a 504 after saving)
        if (Z.failAfterMake) { Z.made = (Z.made || []).concat({ _id: 'zm' + (Z.made || []).length, content: j.content }); Z.posts.push({ rejected: true, body: j }); return send(504, { error: 'Gateway timeout' }); }
        if (ac && ac.audioId === 'ig_gone') { Z.posts.push({ rejected: true, body: j }); return send(400, { error: 'The audio is no longer available' }); }
        Z.posts.push({ body: j });
        const draft = j.tiktokSettings && j.tiktokSettings.draft;
        return send(200, { post: { _id: 'zp' + Z.posts.length, platforms: [{ platform: plat.platform, status: j.publishNow ? (draft ? 'sent_to_inbox' : 'published') : 'scheduled' }] } });
      }
      if (u.pathname === '/api/v1/posts' && req.method === 'GET') return send(200, { posts: Z.made || [] });
      m = u.pathname.match(/^\/api\/v1\/posts\/([^/]+)$/);
      if (m && req.method === 'DELETE') { Z.deleted = (Z.deleted || []).concat(m[1]); Z.made = (Z.made || []).filter((x) => x._id !== m[1]); return send(200, { ok: true }); }
      send(404, { error: 'not here: ' + u.pathname });
    });
  }).listen(ZPORT, '127.0.0.1');
}
const uploadOf = (p) => { const k = (String(p.body.mediaItems && p.body.mediaItems[0] && p.body.mediaItems[0].url).match(/\/cdn\/(\d+)\//) || [])[1]; return k ? Z.uploads[k] : null; };

(async () => {
  const FLY = path.join(MEDIA, 'Night of Worship flyer.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=720x900:c0=0x2a0f3d:c1=0xff5c8a:d=1', '-frames:v', '1', FLY]);
  // a "song": quiet, then its loud chorus from 20s to 35s
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=330:d=50', '-af', "volume='if(between(t,20,35),1,0.05)':eval=frame", SONG]);
  const accts = [
    { id: 'zotk_1', platform: 'tiktok', via: 'zernio', name: 'The Power House', username: 'thepowerhouse', token: 'k', zoAccountId: '1' },
    { id: 'zofb_2', platform: 'facebook', via: 'zernio', name: 'The Power House Church', token: 'k', zoAccountId: '2' },
    { id: 'zoig_3', platform: 'instagram', via: 'zernio', name: '@thepowerhouse.church', token: 'k', zoAccountId: '3' },
    { id: 'zofb_4', platform: 'facebook', via: 'zernio', name: 'Bishop David Richman', token: 'k', zoAccountId: '4' },
    { id: 'zoyt_5', platform: 'youtube', via: 'zernio', name: 'The Power House TV', token: 'k', zoAccountId: '5' },
  ];
  fs.writeFileSync(path.join(DATA, 'workstation.json'), JSON.stringify({
    socialAccounts: accts, posts: [],
    settings: { brand: { churchName: 'The Power House' } },
  }));
  const zs = zernio();
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA],
    { stdio: 'ignore', env: Object.assign({}, process.env, { GROQ_API_KEY: '', MW_GROQ_KEY: '', ZERNIO_API_KEY: 'k', ZERNIO_API_BASE: `http://127.0.0.1:${ZPORT}/api/v1`, MW_FREE_MUSIC_BASE: `http://127.0.0.1:${ZPORT}/music/` }) });
  const browser = await chromium.launch();
  const SHOTS = process.env.MW_SHOTS || '';
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#scheduler`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWSocial && window.api, null, { timeout: 30000 });
    await sleep(800);

    // [1]
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
    await page.waitForSelector('#csCompose #csbFlyerMusic', { timeout: 15000 }).catch(() => {});
    const mode = await page.evaluate(() => { const on = document.querySelector('#csCompose .csb-fm-mode .cs-chip.on'); return on ? on.textContent : ''; });
    check(/Real gospel songs/.test(mode), 'a flyer gets a Music section, on Real gospel songs by itself', mode);
    const sheetText = await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerMusic') || {}).innerText || '');
    check(!/instrumental \(free\)|A free song|Free song|free songs are/i.test(sheetText) && !/Instrumental/.test(sheetText.replace(/no instrumentals, ever/i, '')), 'no free instrumental is offered anywhere', sheetText.slice(0, 400));
    // [2]
    await page.waitForSelector('#csCompose #csbIgList .csb-igsong', { timeout: 15000 }).catch(() => {});
    const first = await page.evaluate(() => Array.from(document.querySelectorAll('#csCompose #csbIgList .csb-igsong b')).map((n) => n.textContent));
    check(first.includes('Gospel Joy') && Z.audioQs.some((q) => q.id === '3' && q.q === 'gospel'), 'Instagram’s own songs load by themselves — gospel first', { first, qs: Z.audioQs });
    await page.fill('#csCompose .csb-igsearch', 'Travis Greene');
    await page.waitForFunction(() => /Made a Way/.test((document.querySelector('#csCompose #csbIgList') || {}).innerText || ''), null, { timeout: 8000 }).catch(() => {});
    const found = await page.evaluate(() => (document.querySelector('#csCompose #csbIgList') || {}).innerText || '');
    check(/Made a Way/.test(found) && /Travis Greene/.test(found), 'a search for Travis Greene finds him in Instagram’s library', found.slice(0, 200));
    await page.tap('#csCompose #csbIgList .csb-igsong[data-i="0"] [data-c="fm-ig-play"]');
    await sleep(300);
    check(await page.evaluate(() => !!document.querySelector('#csCompose .csb-igplay.on')), '▶ plays a preview of the song');
    await page.tap('#csCompose #csbIgList .csb-igsong[data-i="0"]');
    await sleep(300);
    const igNote = await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '');
    check(/Instagram · your flyer as it is \(like a photo post\) with “Made a Way” — Travis Greene/.test(igNote.replace(/\s+/g, ' ')), 'tapping it chooses it: Instagram gets a Reel with that song', igNote);
    // [3]
    let note = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
    check(/TikTok · sent to your TikTok inbox/.test(note), 'TikTok: to start with, its inbox — so the church picks a GOSPEL song (TikTok’s own pick can be any genre)', note);
    await page.tap('#csCompose [data-c="fm-tk"][data-v="trending"]');
    await sleep(200);
    const tkTrend = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerMusic') || {}).innerText || '')).replace(/\s+/g, ' ');
    check(/TikTok · a photo post with a trending song TikTok adds/.test(tkTrend) && /may not be gospel/.test(tkTrend), '…or TikTok picks a trending song — said plainly that it may not be gospel', tkTrend.slice(0, 300));
    const quick = await page.evaluate(() => Array.from(document.querySelectorAll('#csCompose .csb-igquick .cs-chip')).map((c) => c.textContent));
    check(/Gospel/.test(quick[0]) && quick.includes('Travis Greene') && quick.includes('Maverick City') && quick.includes('CeCe Winans'), 'Instagram’s song buttons: gospel first, then gospel artists trending now', quick);
    await page.tap('#csCompose [data-c="fm-tk"][data-v="draft"]');
    await sleep(200);
    note = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
    const hint = await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerMusic') || {}).innerText || '');
    check(/TikTok · sent to your TikTok inbox/.test(note) && /Add sound/.test(hint) && /Travis Greene/.test(hint), '"I’ll pick the song in TikTok": its inbox, and how to add the song there', note);
    // [4]
    check(/Facebook · a picture post, no music/.test(note) && /YouTube · a 10-second Short, no music/.test(note), 'Facebook and YouTube: no instrumental — the flyer, no music (unless the church picks its own recording)', note);
    const ownChips = await page.evaluate(() => Array.from(document.querySelectorAll('#csCompose [data-c="fm-fbyt"]')).map((b) => b.textContent));
    check(ownChips.join('|') === '🎵 Our own gospel recording|No music', 'Facebook and YouTube choices: our own gospel recording, or no music', ownChips);
    if (SHOTS) {
      await page.evaluate(() => { const n = document.querySelector('#csCompose #csbFlyerMusic'); if (n) n.scrollIntoView({ block: 'start' }); }); await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, 'flyer-music-1.png') });
      await page.evaluate(() => { const n = document.querySelector('#csCompose #csbIgPick'); if (n) n.scrollIntoView({ block: 'start' }); }); await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, 'flyer-music-2-instagram.png') });
    }
    // [5]
    await page.fill('#csCompose .csb-cap', 'Night of Worship this Friday 🙌\n\n#worship #sermon #jesus #faith #god').catch(() => {});
    await sleep(200);
    const appTags = await page.evaluate(() => Array.from(document.querySelectorAll('#csCompose #csbAppTags .csb-apptag')).map((n) => n.dataset.p + ': ' + n.innerText.trim()));
    check(appTags.some((t) => /^tiktok: #fyp #foryou #foryoupage #worship #sermon$/.test(t)) && appTags.some((t) => /^instagram: #instagood #explorepage #reels/.test(t))
      && appTags.some((t) => /^youtube: #shorts #youtubeshorts/.test(t)) && appTags.some((t) => /^facebook: #reels #viral #fbreels/.test(t)),
      'New post shows the trending hashtags each app gets (TikTok #fyp #foryou #foryoupage, Instagram #instagood…)', appTags);
    await page.tap('#csCompose [data-c="go"]');
    await page.waitForFunction(() => !document.querySelector('#csCompose.on'), null, { timeout: 60000 }).catch(() => {});
    for (let k = 0; k < 240 && Z.posts.length < 5; k++) await sleep(500);
    const posts = await page.evaluate(async () => window.api.scheduler.list());
    const made = posts.find((p) => /Night of Worship this Friday/.test(p.caption || ''));
    check(!!made && made.music && made.music.tiktok === 'draft' && made.music.igAudio && made.music.igAudio.id === 'ig_made_a_way' && made.music.song === null,
      'the post carries its music: TikTok inbox, the Instagram song — and no instrumental', made && made.music);
    const by = (pl) => Z.posts.filter((p) => !p.rejected && p.body.platforms[0].platform === pl);
    const tk = by('tiktok')[0], ig = by('instagram')[0], fbs = by('facebook'), yt = by('youtube')[0];
    const tagsOf = (p) => ((p && p.body.content) || '').split('\n').find((l) => /^#/.test(l)) || '';
    check(tagsOf(tk) === '#fyp #foryou #foryoupage #worship #sermon' && /^#instagood #explorepage #reels #worship #sermon$/.test(tagsOf(ig))
      && fbs.every((p) => /^#reels #viral #fbreels #worship #sermon$/.test(tagsOf(p))) && /^#shorts #youtubeshorts #worship #sermon #jesus$/.test(tagsOf(yt)),
      'each app is posted with its own trending hashtags — five at most', { tk: tagsOf(tk), ig: tagsOf(ig), fb: fbs.map(tagsOf), yt: tagsOf(yt) });
    check([tk, ig, yt].concat(fbs).every((p) => p && !/Kevin MacLeod|Music:/.test(p.body.content)), 'no instrumental credit on any post — none was put on', { fb: fbs.map((p) => p.body.content) });
    const inboxNote = await page.evaluate(async () => { const l = await window.api.scheduler.list(); return l; });
    const mine = inboxNote.find((p) => p.id === (made && made.id));
    check(!!mine && mine.handoffs && mine.handoffs.zotk_1 && mine.handoffs.zotk_1.inbox === true && /TikTok inbox/.test(mine.handoffs.zotk_1.note || ''),
      'the TikTok booking is kept as "in your inbox", not as posted', mine && mine.handoffs && mine.handoffs.zotk_1);
    check(!!tk && tk.body.tiktokSettings.media_type === 'PHOTO' && tk.body.tiktokSettings.draft === true && tk.body.tiktokSettings.auto_add_music === false
      && tk.body.platforms[0].platformSpecificData.draft === true && tk.body.mediaItems[0].type === 'image',
      'TikTok: the flyer goes to its inbox as a photo post (the song is added there)', tk && { s: tk.body.tiktokSettings, p: tk.body.platforms[0].platformSpecificData });
    const igAc = ig && ig.body.platforms[0].platformSpecificData && ig.body.platforms[0].platformSpecificData.audioConfiguration;
    check(!!ig && igAc && igAc.audioId === 'ig_made_a_way' && igAc.videoVolume === 0 && ig.body.mediaItems[0].type === 'video',
      'Instagram: a Reel with “Made a Way” from Instagram’s own library', ig && ig.body.platforms[0]);
    check(fbs.length === 2 && fbs.every((p) => p.body.mediaItems[0].type === 'image') && yt && yt.body.mediaItems[0].type === 'video',
      'both Facebook pages get the flyer picture, YouTube a Short — no instrumental', { fb: fbs.map((p) => p.body.mediaItems[0].type), yt: !!yt });
    const ytUp = yt && uploadOf(yt);
    if (ytUp) {
      const f = path.join(WORK, 'yt-sent.mp4'); fs.writeFileSync(f, ytUp.bytes);
      const vol = spawnSync(ffmpeg, ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      check(/1080x1920/.test(probe(f)) && /mean_volume: -9\d\.|mean_volume: -inf/.test(vol), '…the YouTube Short is silent: no instrumental under it', vol.match(/mean_volume.*$/m));
    } else check(false, 'the YouTube Short was uploaded', Z.uploads);
    const igUp = ig && uploadOf(ig);
    if (igUp) {
      const f = path.join(WORK, 'ig-sent.mp4'); fs.writeFileSync(f, igUp.bytes);
      const vol = spawnSync(ffmpeg, ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      check(/mean_volume: -9\d\.|mean_volume: -inf/.test(vol), '…and the Instagram Reel carries no other sound (Instagram’s song is the music)', vol.match(/mean_volume.*$/m));
      const pr = probe(f);
      // the test flyer is 720x900 (4:5): Instagram gets it at that shape — no blurred bands, like a photo post
      check(/1080x1350/.test(pr) && /Duration: 00:00:30\./.test(pr), '…the flyer at its own shape (4:5, no blur) — 30 seconds with its song, like a photo post', pr.match(/Video:.*$/m) && pr.match(/Video:.*$/m)[0]);
    }

    // the song search, through the phone's own API
    const viaApi = await page.evaluate(async () => {
      try { const a = await window.api.social.igAudio('zoig_3', 'gospel'); return !!(a && a.songs && a.songs.length); } catch (e) { return e.message; }
    });
    check(viaApi === true, 'the Instagram song search answers through the phone API', viaApi);

    // an edit that adds a Facebook page to a TikTok-only flyer: it gets the free song then
    const edited = await page.evaluate(async (f) => {
      const r = await window.api.scheduler.add({ title: 'TikTok only', caption: 'x', mediaPaths: [f], accountIds: ['zotk_1'], platforms: ['tiktok'],
        scheduledAt: new Date(Date.now() + 2 * 86400e3).toISOString(), music: { tiktok: 'trending', igAudio: null, song: null } });
      const before = r.music && r.music.song;
      await window.api.scheduler.update(r.id, { accountIds: ['zotk_1', 'zofb_2'], platforms: ['tiktok', 'facebook'], caption: 'x' });
      const after = (await window.api.scheduler.list()).find((p) => p.id === r.id);
      return { before, after: after && after.music };
    }, FLY);
    check(!edited.before && edited.after && !edited.after.song, 'an edit that adds Facebook never puts an instrumental on', edited);
    // even an old phone page asking for a free song: the server never puts one on
    const forced = await page.evaluate(async (f) => {
      const r = await window.api.scheduler.add({ title: 'Old page', caption: 'x', mediaPaths: [f], accountIds: ['zofb_2'], platforms: ['facebook'],
        scheduledAt: new Date(Date.now() + 3 * 86400e3).toISOString(), music: { tiktok: 'trending', igAudio: null, song: { free: 'auto' } } });
      let vid = null; try { await window.api.social.withMusic({ mediaPath: f, free: 'inspired' }); vid = 'made'; } catch (e) { vid = e.message; }
      return { song: r.music && r.music.song, vid };
    }, FLY);
    check(!forced.song && /not put on posts/.test(forced.vid || ''), 'the server refuses free instrumentals outright (flyers and videos)', forced);

    // the phone shows the TikTok-inbox booking for what it is
    if (made) {
      await page.evaluate(async () => { await window.MWSocial.go('scheduler'); }).catch(() => {});
      await sleep(800);
      await page.evaluate((id) => window.MWSocial.openPost(id), made.id).catch(() => {});
      await sleep(600);
      const rowTk = await page.evaluate(() => Array.from(document.querySelectorAll('.cs-d-accts li')).map((li) => li.innerText.replace(/\s+/g, ' ')).find((t) => /The Power House$|The Power House /.test(t) && /TikTok inbox/.test(t)) || '');
      check(/Goes to your TikTok inbox at its time/.test(rowTk), 'the post shows TikTok as "goes to your TikTok inbox", not "will post it"', rowTk);
      await page.evaluate(() => { const x = document.querySelector('.cp-x'); if (x) x.click(); });
      await sleep(400);
    }

    // 🧪 Test music on my accounts — the whole chain, nothing left booked
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
    await page.waitForSelector('#csCompose [data-c="fm-check"]', { timeout: 15000 }).catch(() => {});
    const posts0 = Z.posts.length, del0 = (Z.deleted || []).length;
    await page.tap('#csCompose [data-c="fm-check"]');
    await page.waitForSelector('#csCompose .csb-mres', { timeout: 240000 }).catch(() => {});
    const res = await page.evaluate(() => Array.from(document.querySelectorAll('#csCompose .csb-mres li')).map((li) => li.className + ' | ' + li.innerText.replace(/\s+/g, ' ')));
    const testPosts = Z.posts.slice(posts0).filter((p) => /^Music test/.test(p.body.content || ''));
    const others = Z.posts.slice(posts0).filter((p) => !/^Music test/.test(p.body.content || '')).map((p) => (p.body.content || '').slice(0, 30) + ' @' + p.body.platforms[0].platform);
    const booked = testPosts.filter((p) => !p.rejected).length, taken = (Z.deleted || []).length - del0;
    check(res.length >= 6 && res.every((r) => /^ok/.test(r)), 'Test music on my accounts: every account checks out', res);
    check(booked >= 6 && taken === booked, '…each test booking is taken straight back (nothing left to post)', { booked, taken });
    check(res.some((r) => /Instagram’s song library answers/.test(r)) && res.some((r) => /TikTok inbox/.test(r)) && !res.some((r) => /free song/i.test(r)), '…and it says what was checked (no free songs anywhere)', res);
    if (SHOTS) { await page.evaluate(() => { const n = document.querySelector('#csCompose .csb-check-sec'); if (n) n.scrollIntoView({ block: 'start' }); }); await sleep(300); await page.screenshot({ path: path.join(SHOTS, 'flyer-music-3-test.png') }); }
    // no clear answer from Zernio (it saved the test post, then timed out): found by its mark and taken back
    Z.failAfterMake = true;
    const amb = await page.evaluate(async () => window.api.social.musicCheck());
    Z.failAfterMake = false;
    const ambLines = ((amb && amb.checks) || []).filter((c) => /no clear answer/.test(c.what));
    check(ambLines.length >= 5 && ambLines.every((c) => !c.ok && /taken back/.test(c.what)) && !(Z.made || []).length,
      'Test music with no clear answer from Zernio: said so, and any test post it made is taken back', { left: Z.made, lines: ambLines.map((c) => c.what) });
    await page.evaluate(() => { const x = document.querySelector('#csCompose .cp-x'); if (x) x.click(); });
    await sleep(500);

    // never booked twice: each account got the Night of Worship post exactly once
    const nw = Z.posts.filter((p) => !p.rejected && /^Night of Worship this Friday/.test(p.body.content || '')).map((p) => p.body.platforms[0].accountId);
    check(nw.length === 5 && new Set(nw).size === 5, 'no account is booked twice for the same post (a slow first booking and the next tick never overlap)', nw);

    // [G] no Instagram song chosen: a REAL gospel song from Instagram's library, a different one each time;
    //     a Facebook Page that gets the Instagram Reel through Instagram's sharing is not posted to again;
    //     Facebook and YouTube with "No music": the picture and a silent Short, no credit
    const gBefore = Z.posts.length;
    for (const [k, cap] of [[0, 'Gospel auto one'], [1, 'Gospel auto two']]) {
      await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
      await page.waitForSelector('#csCompose #csbFlyerMusic', { timeout: 15000 }).catch(() => {});
      await sleep(600);
      if (k === 0) {
        const igLine = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
        check(/Instagram · your flyer as it is \(like a photo post\) with a real gospel song from Instagram’s library/.test(igLine), '[G] no song chosen: the note says Instagram gets a REAL gospel song from its library', igLine);
        await page.tap('#csCompose [data-c="fm-fromig"][data-id="zofb_2"]');
        await page.tap('#csCompose [data-c="fm-fbyt"][data-v="none"]');
        await sleep(200);
        const n2 = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
        check(/Facebook · gets your Instagram Reel with its gospel song/.test(n2) && /Facebook · a picture post/.test(n2) && /YouTube · a 10-second Short, no music/.test(n2),
          '[G] one Page gets the Instagram Reel (shared by Instagram); the other Facebook and YouTube: no music, as asked', n2);
      }
      await page.fill('#csCompose .csb-cap', cap + '\n\n#worship #jesus').catch(() => {});
      await page.tap('#csCompose [data-c="go"]');
      await page.waitForFunction(() => !document.querySelector('#csCompose.on'), null, { timeout: 60000 }).catch(() => {});
      for (let t = 0; t < 120 && Z.posts.filter((p) => (p.body.content || '').startsWith(cap)).length < 4; t++) await sleep(500);
    }
    const gp = Z.posts.slice(gBefore);
    const igs = gp.filter((p) => p.body.platforms[0].platform === 'instagram').map((p) => (p.body.platforms[0].platformSpecificData.audioConfiguration || {}).audioId);
    check(igs.length === 2 && igs.every((x) => /^ig_gospel_/.test(x)) && igs[0] !== igs[1], '[G] Instagram got a real gospel song each time — a different one', igs);
    const fbG = gp.filter((p) => p.body.platforms[0].platform === 'facebook');
    check(fbG.length === 2 && fbG.every((p) => p.body.platforms[0].accountId === '4' && p.body.mediaItems[0].type === 'image' && !/MacLeod/.test(p.body.content)),
      '[G] the Page that gets the Instagram Reel is not posted to; the other gets the picture, no instrumental', fbG.map((p) => [p.body.platforms[0].accountId, p.body.mediaItems[0].type]));
    const ytG = gp.filter((p) => p.body.platforms[0].platform === 'youtube');
    check(ytG.length === 2 && ytG.every((p) => p.body.mediaItems[0].type === 'video' && !/MacLeod/.test(p.body.content)), '[G] YouTube: a Short with no instrumental and no credit', ytG.length);
    await page.evaluate(() => { try { localStorage.removeItem('mw.flyer.music'); } catch (e) {} });

    // [7] No music
    const before7 = Z.posts.length;
    await page.evaluate((f) => window.MWSocial.compose({ files: [f] }), FLY);
    await page.waitForSelector('#csCompose #csbFlyerMusic', { timeout: 15000 }).catch(() => {});
    await page.tap('#csCompose [data-c="fm-mode"][data-v="none"]');
    await sleep(200);
    note = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
    check(/TikTok · a photo post, no music/.test(note) && /Facebook · a picture post/.test(note), 'No music: said plainly', note);
    await page.fill('#csCompose .csb-cap', 'Quiet flyer').catch(() => {});
    await page.tap('#csCompose [data-c="go"]');
    for (let k = 0; k < 120 && Z.posts.length < before7 + 5; k++) await sleep(500);
    const quiet = Z.posts.slice(before7);
    const qtk = quiet.find((p) => p.body.platforms[0].platform === 'tiktok');
    const qfb = quiet.find((p) => p.body.platforms[0].platform === 'facebook');
    check(!!qtk && qtk.body.tiktokSettings.auto_add_music === false && !qtk.body.tiktokSettings.draft && !!qfb && qfb.body.mediaItems[0].type === 'image',
      '…and posted that way: a photo post with nothing added, a picture on Facebook', { tk: qtk && qtk.body.tiktokSettings, fb: qfb && qfb.body.mediaItems });
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    await browser.close();
    srv.kill();
  }

  // [6] an Instagram linked without Facebook, and [8] a song gone by posting time — the server pieces, directly
  try {
    process.env.ZERNIO_API_BASE = `http://127.0.0.1:${ZPORT}/api/v1`;
    const Accounts = require(ROOT + '/src/main/accounts.js').Accounts || require(ROOT + '/src/main/accounts.js');
    const mem = { socialAccounts: [{ id: 'zoig_x', platform: 'instagram', via: 'zernio', name: '@x', token: 'k', zoAccountId: 'fbneeded' }], settings: { accounts: { zoApiKey: 'k' } } };
    const store = { get: (k) => mem[k], set: (k, v) => { mem[k] = v; } };
    const accounts = new Accounts(store);
    const r = await accounts.zernioIgAudio('zoig_x', 'gospel');
    check(r && r.needsFacebookLogin === true, 'an Instagram linked without Facebook: the studio knows to ask for the Facebook sign-in', r);
    const link = await accounts.zernioLinkStart('instagram', { relink: 'zoig_x' });
    const asked = Z.connects[Z.connects.length - 1] || {};
    check(link && /^https:/.test(link.url) && asked.loginMethod === 'facebook_login' && asked.profileId === 'prof2',
      '…and one sign-in links it through Facebook (same account, same profile)', asked);

    const publisher = require(ROOT + '/src/main/publisher.js');
    const hook = await publisher.songHookSec(SONG, 15);
    check(hook >= 17 && hook <= 21, 'the flyer’s 15 seconds start at the song’s best part (its loud chorus at 20s), not its quiet start', hook);
    const n0 = Z.posts.length;
    const out = await publisher.publishViaZernio({ apiKey: 'k', accountId: '3', username: 'x', platform: 'instagram' },
      { caption: 'Friday!', mediaPaths: [FLY], music: { tiktok: 'trending', igAudio: { id: 'ig_gone', title: 'Gone', artist: 'X' }, song: { path: SONG, title: 'Free', credit: 'c' } } },
      { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1`, scheduleAt: Date.now() + 3600e3 });
    const tries = Z.posts.slice(n0);
    check(tries.length === 2 && tries[0].rejected && !tries[1].body.platforms[0].platformSpecificData.audioConfiguration && tries[1].body.mediaItems[0].type === 'video' && /own recording instead/.test(out.note || '') && /^Friday!\n\nc$/.test(tries[1].body.content),
      'an Instagram song that can’t be used at posting time: the flyer still goes, with the church’s own recording (and its credit)', { out, n: tries.length, c: tries[1] && tries[1].body.content });
    // a song from one Instagram account's library is not sent to another Instagram account
    const n2 = Z.posts.length;
    await publisher.publishViaZernio({ apiKey: 'k', accountId: '9', username: 'youth', platform: 'instagram' },
      { caption: 'Friday!', mediaPaths: [FLY], music: { tiktok: 'trending', igAudio: { id: 'ig_made_a_way', title: 'Made a Way', artist: 'Travis Greene', acc: '3' }, song: { path: SONG, title: 'Free', credit: 'c' } } },
      { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1`, scheduleAt: Date.now() + 3600e3 });
    const other = Z.posts[n2];
    check(!!other && !other.body.platforms[0].platformSpecificData.audioConfiguration && other.body.mediaItems[0].type === 'video',
      'a song from one Instagram account’s library is not sent to another — that one gets the free song', other && other.body.platforms[0]);
    // a long caption never loses the song's credit
    const n3 = Z.posts.length;
    await publisher.publishViaZernio({ apiKey: 'k', accountId: '2', username: 'p', platform: 'facebook' },
      { caption: 'x'.repeat(2190), mediaPaths: [FLY], music: { tiktok: 'trending', igAudio: null, song: { path: SONG, title: 'Free', credit: 'Music: “Inspired” by Kevin MacLeod' } } },
      { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1`, scheduleAt: Date.now() + 3600e3 });
    const longC = Z.posts[n3] && Z.posts[n3].body.content;
    check(!!longC && longC.length <= 2200 && /Kevin MacLeod$/.test(longC), 'a long caption never loses the song’s credit', longC && longC.length);
    // a song whose file has gone: a picture post, no credit for music that does not play
    const n4 = Z.posts.length;
    await publisher.publishViaZernio({ apiKey: 'k', accountId: '2', username: 'p', platform: 'facebook' },
      { caption: 'Hi', mediaPaths: [FLY], music: { tiktok: 'trending', igAudio: null, song: { path: '/nowhere/gone.mp3', title: 'Free', credit: 'CREDIT' } } },
      { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1`, scheduleAt: Date.now() + 3600e3 });
    const goneP = Z.posts[n4];
    check(!!goneP && goneP.body.mediaItems[0].type === 'image' && !/CREDIT/.test(goneP.body.content), 'a song whose file has gone: the picture, and no credit for music that does not play', goneP && goneP.body);
    // a failure that is NOT about the song (Zernio down, a timeout): never posted a second time
    Z.fail500 = true;
    const n1 = Z.posts.length;
    let err500 = null;
    try {
      await publisher.publishViaZernio({ apiKey: 'k', accountId: '3', username: 'x', platform: 'instagram' },
        { caption: 'Friday!', mediaPaths: [FLY], music: { tiktok: 'trending', igAudio: { id: 'ig_made_a_way', title: 'Made a Way', artist: 'Travis Greene' }, song: { path: SONG, title: 'Free', credit: 'c' } } },
        { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1`, scheduleAt: Date.now() + 3600e3 });
    } catch (e) { err500 = e.message; }
    Z.fail500 = false;
    check(!!err500 && Z.posts.length === n1 + 1, 'a failure that is not about the song is not posted a second time', { err500, sent: Z.posts.length - n1 });
    // the inbox told plainly: a TikTok flyer in the inbox is "waiting for you in TikTok", not "posted"
    const { Scheduler } = require(ROOT + '/src/main/scheduler.js');
    const told = [];
    const mem2 = { posts: [], socialAccounts: [{ id: 'zotk_1', platform: 'tiktok', via: 'zernio', name: 'The Power House', token: 'k', zoAccountId: '1' }], settings: { accounts: { zoApiBase: `http://127.0.0.1:${ZPORT}/api/v1` } } };
    const store2 = { get: (k) => mem2[k], set: (k, v) => { mem2[k] = v; } };
    const acc2 = new Accounts(store2);
    const sch = new Scheduler(store2, () => null, { notify: (t, b) => told.push(t + ' | ' + b), intervalMs: 100000, accounts: acc2 });
    const rec = sch.add({ title: 'Inbox flyer', caption: 'x', accountIds: ['zotk_1'], mediaPaths: [FLY], music: { tiktok: 'draft', igAudio: null, song: null }, scheduledAt: new Date(Date.now() - 1000).toISOString() });
    await sleep(300);
    await sch.autoPublish(rec.id).catch((e) => told.push('ERR ' + e.message));
    for (let k = 0; k < 40 && !told.length; k++) await sleep(250);
    check(told.some((t) => /In your TikTok inbox: Inbox flyer/.test(t) && /add your song and post/.test(t)), 'the notice says it is waiting in the TikTok inbox, with what to do', told);
  } catch (e) { check(false, 'the server checks ran', e.stack || e.message); }
  zs.close();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
