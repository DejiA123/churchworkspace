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
 *   [3] TikTok: "TikTok picks a trending song", or "I'll pick the song in
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
  gospel: [{ audioId: 'ig_gospel_1', title: 'Gospel Joy', artist: 'Choir Live', durationMs: 180000, coverUrl: '', downloadUrl: `http://127.0.0.1:${ZPORT}/preview/1.mp3` }],
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
        if (ac && ac.audioId === 'ig_gone') { Z.posts.push({ rejected: true, body: j }); return send(400, { error: 'The audio is no longer available' }); }
        Z.posts.push({ body: j });
        const draft = j.tiktokSettings && j.tiktokSettings.draft;
        return send(200, { post: { _id: 'zp' + Z.posts.length, platforms: [{ platform: plat.platform, status: j.publishNow ? (draft ? 'sent_to_inbox' : 'published') : 'scheduled' }] } });
      }
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
    check(/Trending songs/.test(mode), 'a flyer gets a Music section, on Trending songs by itself', mode);
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
    check(/Instagram · a Reel with “Made a Way” — Travis Greene/.test(igNote.replace(/\s+/g, ' ')), 'tapping it chooses it: Instagram gets a Reel with that song', igNote);
    // [3]
    let note = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
    check(/TikTok · a photo post with a trending song TikTok adds/.test(note), 'TikTok: a photo post with a trending song TikTok adds, to start with', note);
    await page.tap('#csCompose [data-c="fm-tk"][data-v="draft"]');
    await sleep(200);
    note = (await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerNote') || {}).innerText || '')).replace(/\s+/g, ' ');
    const hint = await page.evaluate(() => (document.querySelector('#csCompose #csbFlyerMusic') || {}).innerText || '');
    check(/TikTok · sent to your TikTok inbox/.test(note) && /Add sound/.test(hint) && /Travis Greene/.test(hint), '"I’ll pick the song in TikTok": its inbox, and how to add the song there', note);
    // [4]
    check(/Facebook · a 15-second video with a free song/.test(note) && /YouTube · a 15-second Short with a free song/.test(note), 'Facebook and YouTube get a free-to-post song', note);
    if (SHOTS) {
      await page.evaluate(() => { const n = document.querySelector('#csCompose #csbFlyerMusic'); if (n) n.scrollIntoView({ block: 'start' }); }); await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, 'flyer-music-1.png') });
      await page.evaluate(() => { const n = document.querySelector('#csCompose #csbIgPick'); if (n) n.scrollIntoView({ block: 'start' }); }); await sleep(300);
      await page.screenshot({ path: path.join(SHOTS, 'flyer-music-2-instagram.png') });
    }
    // [5]
    await page.fill('#csCompose .csb-cap', 'Night of Worship this Friday 🙌').catch(() => {});
    await page.tap('#csCompose [data-c="go"]');
    await page.waitForFunction(() => !document.querySelector('#csCompose.on'), null, { timeout: 60000 }).catch(() => {});
    for (let k = 0; k < 240 && Z.posts.length < 5; k++) await sleep(500);
    const posts = await page.evaluate(async () => window.api.scheduler.list());
    const made = posts.find((p) => /Night of Worship this Friday/.test(p.caption || ''));
    check(!!made && made.music && made.music.tiktok === 'draft' && made.music.igAudio && made.music.igAudio.id === 'ig_made_a_way' && made.music.song && fs.existsSync(made.music.song.path),
      'the post carries its music: TikTok inbox, the Instagram song, and a free song fetched on the server', made && made.music);
    const by = (pl) => Z.posts.filter((p) => !p.rejected && p.body.platforms[0].platform === pl);
    const tk = by('tiktok')[0], ig = by('instagram')[0], fbs = by('facebook'), yt = by('youtube')[0];
    check(!!made && !/Kevin MacLeod/.test(made.caption) && fbs.length && fbs.every((p) => /Kevin MacLeod/.test(p.body.content)) && yt && /Kevin MacLeod/.test(yt.body.content)
      && tk && !/Kevin MacLeod/.test(tk.body.content) && ig && !/Kevin MacLeod/.test(ig.body.content),
      'the free song’s credit is on the posts that carry it (Facebook, YouTube) — not on TikTok’s or Instagram’s', { fb: fbs.map((p) => p.body.content), tk: tk && tk.body.content, ig: ig && ig.body.content });
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
    check(fbs.length === 2 && fbs.every((p) => p.body.mediaItems[0].type === 'video') && yt && yt.body.mediaItems[0].type === 'video',
      'both Facebook pages and YouTube get a video of the flyer', { fb: fbs.length, yt: !!yt });
    const fbUp = fbs[0] && uploadOf(fbs[0]);
    if (fbUp) {
      const f = path.join(WORK, 'fb-sent.mp4'); fs.writeFileSync(f, fbUp.bytes);
      const pr = probe(f);
      check(/Duration: 00:00:1[45]\./.test(pr) && /Audio: aac/.test(pr) && /1080x1920/.test(pr), '…15 seconds, 1080x1920, with the song under it', pr.slice(-500));
    } else check(false, 'the Facebook video was uploaded', Z.uploads);
    const igUp = ig && uploadOf(ig);
    if (igUp) {
      const f = path.join(WORK, 'ig-sent.mp4'); fs.writeFileSync(f, igUp.bytes);
      const vol = spawnSync(ffmpeg, ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
      check(/mean_volume: -9\d\.|mean_volume: -inf/.test(vol), '…and the Instagram Reel carries no other sound (Instagram’s song is the music)', vol.match(/mean_volume.*$/m));
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
    check(!edited.before && edited.after && edited.after.song && /\.mp3$/.test(edited.after.song.path || ''), 'an edit that adds Facebook to a TikTok-only flyer gives it the free song', edited);
    // the song a post carries is its own copy: taken out of the library, the post keeps it
    check(!!made && made.music && made.music.song && /flyer-songs/.test(made.music.song.path), 'a booked flyer keeps its own copy of the song', made && made.music && made.music.song);

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
    check(tries.length === 2 && tries[0].rejected && !tries[1].body.platforms[0].platformSpecificData.audioConfiguration && tries[1].body.mediaItems[0].type === 'video' && /free song instead/.test(out.note || '') && /^Friday!\n\nc$/.test(tries[1].body.content),
      'an Instagram song that can’t be used at posting time: the flyer still goes, with the free song (and its credit)', { out, n: tries.length, c: tries[1] && tries[1].body.content });
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
