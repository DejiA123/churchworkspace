'use strict';
/*
 * INSTAGRAM'S SONGS NEED A FACEBOOK SIGN-IN — AND IT MUST BE FREE.
 *
 * Zernio opens Instagram's song library only to an Instagram account linked
 * through Facebook. Linking it again that way, on a free Zernio account that
 * already holds 2, Zernio answered "Add a payment method to connect more than
 * 2 accounts." Zernio's own rule for switching the sign-in is to disconnect
 * the account first — which frees the place, so it costs nothing. This drives
 * the real Cloud Studio like an iPhone against a stand-in Zernio that behaves
 * exactly that way, and checks:
 *   [1] the song search says a Facebook sign-in is needed; the button is there
 *   [2] tapping it: Zernio says "payment" — the phone asks first, saying it is
 *       free and what will happen; nothing is unlinked without a yes
 *   [3] yes: Instagram is unlinked on Zernio, then the Facebook sign-in opens
 *   [4] once signed in, the page carries on by itself: the new link takes the
 *       old one's place, a scheduled Instagram post moves over and is booked
 *       again, and Instagram's songs load
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-ig-relink.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7421, ZPORT = 7422, CODE = 'ig-relink-test-5531';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-igrelink-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

/* a stand-in Zernio: one free account holding Facebook + Instagram (Instagram linked the Instagram way) */
const Z = { accounts: [{ _id: '2', platform: 'facebook', displayName: 'The Power House International', profileId: 'prof1' }, { _id: '3', platform: 'instagram', username: 'thepowerhouseintl', profileId: 'prof1', loginMethod: 'instagram_login' }],
  deleted: [], connects: [], posts: [] };
function zernio() {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => {
      const body = Buffer.concat(parts);
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (u.pathname === '/api/v1/accounts' && req.method === 'GET') return send(200, { accounts: Z.accounts });
      let m = u.pathname.match(/^\/api\/v1\/accounts\/([^/]+)$/);
      if (m && req.method === 'DELETE') { Z.deleted.push(m[1]); Z.accounts = Z.accounts.filter((a) => a._id !== m[1]); return send(200, { ok: true }); }
      m = u.pathname.match(/^\/api\/v1\/accounts\/([^/]+)\/instagram\/audio$/);
      if (m) {
        if (u.searchParams.get('audioType') !== 'music') return send(400, { error: 'Invalid option: expected one of "music"|"original_sound"' });
        const a = Z.accounts.find((x) => x._id === m[1]);
        if (!a || a.loginMethod !== 'facebook_login') return send(400, { error: 'instagram_audio_requires_facebook_login' });
        // (searched by name, the gospel artist; nothing searched, what is trending)
        if (!u.searchParams.get('q')) return send(200, { audio: [{ audioId: 'ig_trend', title: 'Trending', displayArtist: 'Someone', durationInMs: 150000 }] });
        return send(200, { audio: [{ audioId: 'ig_dunsin', title: 'Do to Me What You Want', displayArtist: 'Dunsin Oyekan', durationInMs: 300000 }] });
      }
      if (u.pathname === '/api/v1/connect/instagram') {
        Z.connects.push(Object.fromEntries(u.searchParams.entries()));
        // the free plan: 2 accounts — a second link of the same Instagram counts as a third
        if (Z.accounts.length >= 2) return send(400, { error: 'Add a payment method to connect more than 2 accounts.' });
        // the person signs in with Facebook a moment later: the Instagram comes back, linked the Facebook way
        setTimeout(() => { Z.accounts.push({ _id: '33', platform: 'instagram', username: 'thepowerhouseintl', profileId: 'prof1', loginMethod: 'facebook_login' }); }, 1500);
        return send(200, { authUrl: 'https://zernio.example/connect/instagram/facebook' });
      }
      if (u.pathname === '/fb-login') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<p>Facebook sign-in (stand-in)</p>'); }
      if (u.pathname === '/api/v1/media/presign') return send(200, { uploadUrl: `http://127.0.0.1:${ZPORT}/upload/1`, publicUrl: `http://127.0.0.1:${ZPORT}/cdn/1/f.jpg` });
      if (u.pathname.startsWith('/upload/')) return send(200, {});
      if (u.pathname === '/api/v1/posts' && req.method === 'POST') {
        const j = JSON.parse(body.toString() || '{}'); Z.posts.push(j);
        return send(200, { post: { _id: 'zp' + Z.posts.length, platforms: [{ platform: j.platforms[0].platform, status: 'scheduled' }] } });
      }
      m = u.pathname.match(/^\/api\/v1\/posts\/([^/]+)$/);
      if (m && req.method === 'DELETE') return send(200, { ok: true });
      send(404, { error: 'not here: ' + u.pathname });
    });
  }).listen(ZPORT, '127.0.0.1');
}

(async () => {
  const FLY = path.join(MEDIA, 'Operation Jehoshaphat.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'gradients=s=720x900:c0=0x10205a:c1=0x3a7bff:d=1', '-frames:v', '1', FLY]);
  const accts = [
    { id: 'zofb_2', platform: 'facebook', via: 'zernio', name: 'The Power House International', token: 'k', zoAccountId: '2' },
    { id: 'zoig_3', platform: 'instagram', via: 'zernio', name: '@thepowerhouseintl', username: 'thepowerhouseintl', token: 'k', zoAccountId: '3' },
  ];
  const later = new Date(Date.now() + 2 * 86400e3).toISOString();
  fs.writeFileSync(path.join(DATA, 'workstation.json'), JSON.stringify({
    socialAccounts: accts,
    posts: [{ id: 'p_ig', title: 'Sunday flyer', caption: 'Join us', mediaPaths: [FLY], accountIds: ['zoig_3'], platforms: ['instagram'], scheduledAt: later, status: 'scheduled', attempts: 0, createdAt: later, updatedAt: later, owner: null,
      handoffs: { zoig_3: { ok: true, id: 'old1', zoPostId: 'old1', via: 'zernio', name: '@thepowerhouseintl', platform: 'instagram', publishAt: later } } }],
    settings: { brand: { churchName: 'The Power House' } },
  }));
  const zs = zernio();
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA],
    { stdio: 'ignore', env: Object.assign({}, process.env, { GROQ_API_KEY: '', MW_GROQ_KEY: '', ZERNIO_API_KEY: 'k', ZERNIO_API_BASE: `http://127.0.0.1:${ZPORT}/api/v1` }) });
  const browser = await chromium.launch();
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
    await page.waitForSelector('#csCompose [data-c="fm-ig-fb"]', { timeout: 20000 }).catch(() => {});
    check(!!(await page.$('#csCompose [data-c="fm-ig-fb"]')), '[1] Instagram’s songs need a Facebook sign-in: the button is there');
    // [2]
    let popups = 0; ctx.on('page', () => { popups++; });
    await page.tap('#csCompose [data-c="fm-ig-fb"]');
    await page.waitForSelector('#csCompose [data-c="fm-ig-fb2"]', { timeout: 15000 }).catch(() => {});
    const ask = await page.evaluate(() => (document.querySelector('#csCompose #csbIgList') || {}).innerText || '');
    check(/Nothing to pay/.test(ask) && /unlink/i.test(ask) && !!(await page.$('#csCompose [data-c="fm-ig-fb2"]')) && !Z.deleted.length,
      '[2] Zernio says "payment": the phone asks first — free, and what will happen; nothing unlinked yet', { ask: ask.slice(0, 300), deleted: Z.deleted });
    // [3]
    await page.tap('#csCompose [data-c="fm-ig-fb2"]');
    await sleep(800);
    const last = Z.connects[Z.connects.length - 1] || {};
    check(Z.deleted.includes('3') && last.loginMethod === 'facebook_login' && last.profileId === 'prof1' && popups >= 1,
      '[3] yes: Instagram is unlinked on Zernio, and the Facebook sign-in opens (same profile)', { deleted: Z.deleted, last, popups });
    // [4]
    await page.waitForSelector('#csCompose #csbIgList .csb-igsong', { timeout: 30000 }).catch(() => {});
    const songs = await page.evaluate(() => (document.querySelector('#csCompose #csbIgList') || {}).innerText || '');
    check(/Do to Me What You Want/.test(songs) && /Dunsin Oyekan/.test(songs), '[4] signed in: the page carries on by itself — Instagram’s songs load', songs.slice(0, 200));
    const state = await page.evaluate(async () => ({ accts: (((r) => (Array.isArray(r) ? r : (r && (r.accounts || r.list)) || []))(await window.api.social.accounts())).map((a) => a.id), posts: await window.api.scheduler.list() }));
    const moved = (state.posts || []).find((p) => p.id === 'p_ig');
    check(state.accts.includes('zoig_33') && !state.accts.includes('zoig_3'), '[4] the new link takes the old one’s place', state.accts);
    for (let k = 0; k < 40 && !Z.posts.some((p) => p.platforms[0].accountId === '33'); k++) await sleep(250);
    const moved2 = (await page.evaluate(async () => window.api.scheduler.list())).find((p) => p.id === 'p_ig');
    check(!!moved2 && moved2.accountIds.join() === 'zoig_33' && Z.posts.some((p) => p.platforms[0].accountId === '33') && (!moved2.handoffs.zoig_3),
      '[4] the scheduled Instagram post moved over and is booked again on the new link', { ids: moved2 && moved2.accountIds, h: moved2 && Object.keys(moved2.handoffs || {}), sent: Z.posts.map((p) => p.platforms[0].accountId) });
    void moved;
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    await browser.close();
    srv.kill(); zs.close();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
