'use strict';
/*
 * SOCIAL SCHEDULER — FULL UI E2E (real Electron app, Zernio the only way in).
 *
 * Boots the REAL app UI (index.html + preload + the real Store, Accounts and
 * Scheduler engines wired to IPC exactly like main.js) against a local mock
 * of Zernio, then drives the whole flow with clicks:
 *   [A] fresh state: banner off, no linked accounts
 *   [B] “＋ Connect account” offers Facebook, Instagram, YouTube and TikTok —
 *       every one through Zernio, and nothing else (no Meta app, no Google
 *       app, no Upload-Post, no pasted token; those wizards and their IPC are
 *       gone). Facebook asks for the key once; Instagram, YouTube and TikTok
 *       reuse it → 4 account chips, auto-post banner ON
 *   [C] a VIDEO post to all 4, due now → auto-published: “⚡ Auto-posted” +
 *       4 green ✓ badges; Zernio got the exact video bytes and one post per
 *       platform (TikTok public with consent, YouTube titled + public)
 *   [D] guard: YouTube/TikTok with nothing attached → a clear toast
 *   [E] a PHOTO post to Facebook + Instagram only
 *   [F] chip health check + disconnect
 *   [G] Settings: Zernio keys only; saving keeps a third key set on a phone
 *   [H] “make it post with the PC off” offers Zernio alone
 *
 * Run: npx electron test/social-ui.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const { Store } = require('../src/main/store');
const { Accounts } = require('../src/main/accounts');
const { Scheduler } = require('../src/main/scheduler');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-social-ui-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ---------------- mock Zernio: accounts, hosted connect page, media, posts ---------------- */

const received = [];
const AVATAR = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000037', 'hex');
let zoAccounts = []; // accounts linked on "Zernio"

function startMockZernio() {
  return new Promise((resolve) => {
    let origin = '';
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        const entry = { url: p, method: req.method, fields: {}, fileBytes: null, headers: req.headers };
        const send = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
        const bearer = req.headers.authorization || '';

        if (p === '/avatar.png') { res.setHeader('content-type', 'image/png'); return res.end(AVATAR); }

        if (req.method === 'GET') {
          received.push(entry);
          if (p === '/zo/v1/accounts') {
            if (bearer !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
            return send(200, { accounts: zoAccounts });
          }
          if (p.startsWith('/zo/v1/connect/')) {
            if (bearer !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
            return send(200, { url: origin + '/zo/link?platform=' + p.slice('/zo/v1/connect/'.length) });
          }
          if (p === '/zo/link') {
            // Zernio's hosted page: visiting it = the user signing in to the platform there.
            const plat = u.searchParams.get('platform') || 'tiktok';
            const seed = {
              tiktok: { _id: 'zoacc_1', platform: 'tiktok', username: 'gracetok', displayName: 'Grace TikTok Z' },
              youtube: { _id: 'zoacc_yt', platform: 'youtube', username: 'gracechannel', displayName: 'Grace Church TV' },
              facebook: { _id: 'zoacc_fb', platform: 'facebook', username: 'gracechapel', displayName: 'Grace Chapel FB' },
              instagram: { _id: 'zoacc_ig', platform: 'instagram', username: 'gracechapel', displayName: 'Grace Chapel IG' },
            }[plat];
            if (seed && !zoAccounts.some((a) => a.platform === plat)) { seed.picture = origin + '/avatar.png'; zoAccounts.push(seed); }
            res.setHeader('content-type', 'text/html');
            return res.end('<html><body>linked</body></html>');
          }
          return send(404, { error: 'Unknown GET ' + p });
        }

        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/json')) {
          try { entry.fields = JSON.parse(body.toString()); } catch (e2) {}
        } else {
          entry.fileBytes = body;
        }
        received.push(entry);

        // presign upload URL → PUT bytes → create post
        if (p === '/zo/v1/media/presign') {
          if (bearer !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
          return send(200, { uploadUrl: origin + '/zo/upload/u1', publicUrl: origin + '/zo/cdn/u1' });
        }
        if (p === '/zo/upload/u1') {
          if (req.method !== 'PUT') return send(400, { error: 'PUT required' });
          return send(200, {});
        }
        if (p === '/zo/v1/posts' && req.method === 'POST') {
          if (bearer !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
          const f = entry.fields;
          const plat = Array.isArray(f.platforms) ? f.platforms[0] : null;
          const item = Array.isArray(f.mediaItems) ? f.mediaItems[0] : null;
          if (!plat || !plat.accountId) return send(400, { error: 'platforms[].accountId is required' });
          if (item && !/\/zo\/cdn\//.test(item.url || '')) return send(400, { error: 'mediaItems[].url must be an uploaded media URL' });
          if (plat.platform === 'youtube') {
            const ys = f.youtubeSettings || {};
            if (!item || ys.visibility !== 'public' || !ys.title) return send(400, { error: 'YouTube requires a video + title + public visibility' });
            return send(200, { id: 'zopost_yt', status: 'published',
              platforms: [{ platform: 'youtube', status: 'published', postUrl: 'https://www.youtube.com/watch?v=YT99', postId: 'YT99' }] });
          }
          if (plat.platform === 'facebook') {
            return send(200, { id: 'zopost_fb', status: 'published',
              platforms: [{ platform: 'facebook', status: 'published', postUrl: 'https://www.facebook.com/gracechapel/posts/fb123', postId: 'fb123' }] });
          }
          if (plat.platform === 'instagram') {
            if (!item) return send(400, { error: 'Instagram requires a photo or video' });
            return send(200, { id: 'zopost_ig', status: 'published',
              platforms: [{ platform: 'instagram', status: 'published', postUrl: 'https://www.instagram.com/p/IG123/', postId: 'IG123' }] });
          }
          if (plat.platform !== 'tiktok') return send(400, { error: 'unsupported platform' });
          if (!item) return send(400, { error: 'TikTok requires a video' });
          const ts = f.tiktokSettings || {};
          if (ts.privacy_level !== 'PUBLIC_TO_EVERYONE' || ts.express_consent_given !== true) return send(400, { error: 'TikTok requires public privacy + consent' });
          return send(200, { id: 'zopost_tk', status: 'published',
            platforms: [{ platform: 'tiktok', status: 'published', postUrl: 'https://www.tiktok.com/@gracetok/video/99001', postId: '99001' }] });
        }
        return send(404, { error: 'Unknown ' + req.method + ' ' + p });
      });
    });
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, origin });
    });
  });
}

/* --------------------------- app plumbing (like main.js) --------------------------- */

app.disableHardwareAcceleration();

let win = null;
let nextOpenFile = null;

/** executeJavaScript with error passthrough so failures are visible. */
async function js(code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}

/** Poll a JS expression in the page until it returns truthy (or times out). */
async function until(code, timeoutMs = 12000, everyMs = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await js(code);
    if (r && !r.__error && r !== false && r !== null && r !== undefined && r !== '') return r;
    await sleep(everyMs);
  }
  return null;
}

/** Zernio posts made for one platform since `from`. */
const zoPostsFor = (plat, from = 0) => received.slice(from).filter((x) => x.url === '/zo/v1/posts' && x.fields
  && Array.isArray(x.fields.platforms) && x.fields.platforms[0].platform === plat);

app.whenReady().then(async () => {
  console.log('== SOCIAL SCHEDULER UI E2E (real app, Zernio the only way in) ==');
  const { server, origin } = await startMockZernio();

  // sample media
  const videoF = path.join(tmp, 'sermon.mp4');
  fs.writeFileSync(videoF, Buffer.alloc(48 * 1024, 7));
  // a JPEG goes up as it is (a PNG would be turned into one first — publisher.js flyerAsJpeg)
  const photoF = path.join(tmp, 'flyer.jpg');
  fs.writeFileSync(photoF, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 11, 22, 33, 44, 0xff, 0xd9]));

  // REAL store + engines, Zernio pointed at the mock
  const store = new Store(path.join(tmp, 'workstation.json'), {
    settings: {
      brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' },
      apiKeys: {},
      accounts: {
        instagram: '', facebook: '', tiktok: '',
        zoApiBase: origin + '/zo/v1', // zoApiKey deliberately empty — [B] types it through the UI
        zoApiKey3: 'ZOKEY_three',     // set from a phone: a desk Settings save must keep it ([G])
      },
      live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' },
    },
    posts: [], socialAccounts: [],
  });
  const accounts = new Accounts(store);
  const notifications = [];
  const scheduler = new Scheduler(store, () => win, {
    accounts, intervalMs: 400,
    notify: (title, body, id) => notifications.push({ title, body, id }),
  });

  /* real IPC (mirrors main.js) — the system browser is played by an HTTP client */
  const httpFollow = (urlStr, hops = 3) => new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpFollow(new URL(res.headers.location, urlStr).toString(), hops - 1));
      }
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
  const zoOpts = { openUrl: (u2) => httpFollow(u2), pollMs: 50 };
  ipcMain.handle('settings:get', () => ok(store.get('settings')));
  ipcMain.handle('settings:update', wrap(async (e, { patch }) => store.set('settings', { ...(store.get('settings') || {}), ...patch })));
  ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
  ipcMain.handle('accounts:list', wrap(async () => accounts.list()));
  ipcMain.handle('accounts:connectZo', wrap(async () => accounts.connectZernio(win, zoOpts)));
  ipcMain.handle('accounts:connectZoYt', wrap(async () => accounts.connectZernio(win, { ...zoOpts, platform: 'youtube' })));
  ipcMain.handle('accounts:connectZoFb', wrap(async () => accounts.connectZernio(win, { ...zoOpts, platform: 'facebook' })));
  ipcMain.handle('accounts:connectZoIg', wrap(async () => accounts.connectZernio(win, { ...zoOpts, platform: 'instagram' })));
  ipcMain.handle('accounts:remove', wrap(async (e, { id }) => accounts.remove(id)));
  ipcMain.handle('accounts:check', wrap(async (e, { id }) => accounts.check(id)));
  ipcMain.handle('scheduler:list', wrap(async () => scheduler.list()));
  ipcMain.handle('scheduler:add', wrap(async (e, { post }) => scheduler.add(post)));
  ipcMain.handle('scheduler:update', wrap(async (e, { id, patch }) => scheduler.update(id, patch)));
  ipcMain.handle('scheduler:remove', wrap(async (e, { id }) => scheduler.remove(id)));
  ipcMain.handle('scheduler:publish', wrap(async (e, { id }) => scheduler.publishNow(id)));
  ipcMain.handle('scheduler:publishAuto', wrap(async (e, { id }) => scheduler.autoPublish(id)));
  ipcMain.handle('scheduler:retry', wrap(async (e, { id }) => scheduler.retry(id)));
  ipcMain.handle('scheduler:plans', () => ok({}));
  ipcMain.handle('scheduler:handOff', () => ok({ booked: 0 }));

  /* stubs for the rest of the app */
  ipcMain.handle('video:presets', () => ok({}));
  ipcMain.handle('captions:fonts', () => ok(['Arial']));
  ipcMain.handle('captions:available', () => ok(true));
  ipcMain.handle('fonts:data', () => ok([]));
  ipcMain.handle('photos:list', () => ok([]));
  ipcMain.handle('dialog:openFile', () => ok(nextOpenFile));
  ipcMain.handle('dialog:saveFile', () => ok(null));
  ipcMain.handle('dialog:openDir', () => ok(null));
  ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));
  ipcMain.handle('live:state', () => ok({ running: false }));
  ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
  ipcMain.handle('live:screenSources', () => ok([]));
  ipcMain.handle('ndi:status', () => ok({ available: false }));
  ipcMain.handle('ndi:sources', () => ok([]));
  ipcMain.handle('ppt:check', () => ok({ available: false }));
  ipcMain.handle('shell:openExternal', () => ok(true));
  ipcMain.handle('shell:showItem', () => ok(true));
  ipcMain.handle('shell:openPath', () => ok(true));
  ipcMain.handle('fs:readImageDataUrl', () => ok(''));

  scheduler.start();

  win = new BrowserWindow({
    show: true, width: 1380, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1000);

  /* =================== [A] fresh state =================== */
  console.log('\n[A] fresh state');
  let r = await js(`
    document.querySelector('.nav-item[data-view="scheduler"]').click();
    await new Promise((r2) => setTimeout(r2, 400));
    return {
      banner: document.getElementById('schedAutoBanner').className,
      strip: document.getElementById('acctStrip').textContent,
      btn: !!document.getElementById('connectAccount'),
      targets: document.getElementById('postToAccounts').textContent,
    };`);
  if (r.__error) console.error(r.__error);
  log(r.btn, 'Connect account button present');
  log(/off/.test(r.banner), 'auto-post banner starts OFF', r.banner);
  log(/Nothing linked yet/.test(r.strip) && /Zernio/.test(r.strip), 'accounts strip explains how to link (through Zernio)');
  log(/No linked accounts yet/.test(r.targets), 'post form has no targets yet');

  /* =================== [B] connect — Zernio is the only way in =================== */
  console.log('\n[B] connect accounts — Zernio is the only way in');
  r = await js(`
    const gone = ['showAppSetup', 'startFbConnect', 'showPagePicker', 'showYtChoice', 'showYtSetup', 'startYtConnect',
      'showUpSetup', 'startUpConnect', 'zoAdvanced'].filter((f) => typeof window[f] !== 'undefined');
    const ipc = Object.keys(window.api.accounts).filter((k) => /^connect/.test(k)).sort();
    document.getElementById('connectAccount').click();
    await new Promise((r2) => setTimeout(r2, 150));
    const box = document.getElementById('acctModalBox');
    const rows = Array.from(box.querySelectorAll('.acct-choose'));
    return {
      gone, ipc,
      ids: rows.map((b) => b.id),
      allZernio: rows.length > 0 && rows.every((b) => /through Zernio/.test(b.textContent)),
      other: /Meta App|Google app|Client ID|Upload-Post|access token|developers\\.facebook|console\\.cloud|second route/i.test(box.textContent),
    };`);
  if (r.__error) console.error(r.__error);
  log(JSON.stringify(r.ids) === JSON.stringify(['chooseFb', 'chooseIg', 'chooseYt', 'chooseTk']), 'chooser lists Facebook, Instagram, YouTube and TikTok', JSON.stringify(r.ids));
  log(r.allZernio && !r.other, 'every choice is through Zernio — no Meta app, Google app, Upload-Post or token');
  log(!(r.gone || []).length, 'the old direct-connect wizards are gone', JSON.stringify(r.gone));
  log(JSON.stringify(r.ipc) === JSON.stringify(['connectZo', 'connectZoFb', 'connectZoIg', 'connectZoYt']), 'the app can only ask the main process for Zernio connects', JSON.stringify(r.ipc));

  r = await js(`
    document.getElementById('chooseFb').click();  // no Zernio key yet → the Zernio setup opens
    await new Promise((r2) => setTimeout(r2, 100));
    const box = document.getElementById('acctModalBox').textContent;
    const wiz = !!document.getElementById('wizZoKey');
    const okSteps = /Zernio/.test(box) && /no monthly post limit/i.test(box) && /2 accounts/.test(box);
    const advanced = !!document.getElementById('zoGoAdvanced') || /advanced setup|fully direct/i.test(box);
    if (wiz) { document.getElementById('wizZoKey').value = 'ZOKEY_ui'; document.getElementById('wizZoContinue').click(); }
    return { wiz, okSteps, advanced };`);
  if (r.__error) console.error(r.__error);
  log(r.wiz && r.okSteps, 'Facebook opens the Zernio setup (free, no post limit, 2 accounts each)');
  log(!r.advanced, 'no "advanced" or direct route offered beside it');
  r = await until(`
    const chips = document.querySelectorAll('#acctStrip .acct-chip');
    if (chips.length !== 1) return false;
    return { names: document.getElementById('acctStrip').textContent, toast: document.getElementById('toast').textContent,
      saved: document.getElementById('setZoApiKey').value };`);
  log(!!r, 'pasted Zernio key → hosted page → Facebook chip appeared');
  if (r) {
    log(/Grace Chapel FB/.test(r.names), 'Facebook connected by name', r.names.trim().slice(0, 80));
    log(/Facebook auto-posting is ON/.test(r.toast), 'success toast confirms Facebook', r.toast);
    log(r.saved === 'ZOKEY_ui', 'Zernio key mirrored into Settings');
  }

  // the rest reuse the key: no setup, straight to Zernio
  const more = [['chooseIg', 2, 'Grace Chapel IG', 'Instagram'], ['chooseYt', 3, 'Grace Church TV', 'YouTube'], ['chooseTk', 4, 'Grace TikTok Z', 'TikTok']];
  for (const [btn, n, name, label] of more) {
    await js(`
      document.getElementById('connectAccount').click();
      await new Promise((r2) => setTimeout(r2, 150));
      document.getElementById('${btn}').click();
      return true;`);
    r = await until(`
      const chips = document.querySelectorAll('#acctStrip .acct-chip');
      if (chips.length !== ${n}) return false;
      return { names: document.getElementById('acctStrip').textContent, toast: document.getElementById('toast').textContent };`);
    log(!!r && new RegExp(name).test(r.names) && new RegExp(label + ' auto-posting is ON').test(r.toast),
      `${label} linked through Zernio with the same key (no setup asked again)`, r && r.toast);
  }
  r = await js(`return {
    banner: document.getElementById('schedAutoBanner').textContent,
    bannerOn: /on/.test(document.getElementById('schedAutoBanner').className),
    targets: document.querySelectorAll('#postToAccounts input:checked').length };`);
  log(r.bannerOn && /4 linked/.test(r.banner), 'banner: Auto-posting ON with 4 accounts', r.banner);
  log(r.targets === 4, 'new-post form targets all 4 accounts by default');
  const ids = ['zofb_zoacc_fb', 'zoig_zoacc_ig', 'zoyt_zoacc_yt', 'zotk_zoacc_1'];
  log(accounts.all().length === 4 && ids.every((id) => { const a = accounts.byId(id); return a && a.via === 'zernio' && a.token === 'ZOKEY_ui'; }),
    'all 4 stored as Zernio accounts (the key as the token)', accounts.all().map((a) => a.id + ':' + a.via).join(' '));

  /* =================== [C] schedule a video post → auto-publishes everywhere =================== */
  console.log('\n[C] scheduled video post auto-publishes to all 4 accounts');
  nextOpenFile = videoF;
  const beforeC = received.length;
  r = await js(`
    document.getElementById('sTitle').value = 'Sunday sermon';
    document.getElementById('sCaption').value = 'Watch now! ✨';
    document.getElementById('pickPostMedia').click();
    await new Promise((r2) => setTimeout(r2, 250));
    // The attached file must show a live preview right away (video → a playable,
    // pausable <video> that autoplays muted).
    const pb = document.getElementById('postMediaPreview');
    const vid = pb.querySelector('video');
    const preview = { shown: !pb.classList.contains('hidden'), tag: (pb.firstElementChild || {}).tagName,
      src: (vid || {}).src || '', controls: !!(vid && vid.controls), autoplay: !!(vid && vid.autoplay), muted: !!(vid && vid.muted) };
    const d = new Date(Date.now() - 60000);
    const p2 = (n) => String(n).padStart(2, '0');
    document.getElementById('sDate').value = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    document.getElementById('sTime').value = p2(d.getHours()) + ':' + p2(d.getMinutes());
    // The post is due in the past, so the scheduler can auto-post (and replace the
    // toast) within milliseconds — record every toast instead of one snapshot.
    const tEl = document.getElementById('toast');
    const toasts = [];
    const mo = new MutationObserver(() => toasts.push(tEl.textContent));
    mo.observe(tEl, { childList: true, characterData: true, subtree: true });
    document.getElementById('addPost').click();
    await new Promise((r2) => setTimeout(r2, 250));
    mo.disconnect();
    return { toasts, preview, clearedAfterPost: document.getElementById('postMediaPreview').classList.contains('hidden') };`);
  if (r.__error) console.error(r.__error);
  log(r.preview && r.preview.shown && r.preview.tag === 'VIDEO' && /sermon\.mp4/.test(r.preview.src), 'attached video shows an inline preview', JSON.stringify(r.preview));
  log(r.preview && r.preview.controls && r.preview.autoplay && r.preview.muted, 'video preview autoplays muted and is pausable (controls)');
  log(r.clearedAfterPost, 'preview clears after the post is scheduled');
  log((r.toasts || []).some((t) => /scheduled/i.test(t)), 'post scheduled from the form', (r.toasts || []).join(' | '));

  r = await until(`
    const card = Array.from(document.querySelectorAll('#postList .post')).find((c) => /Sunday sermon/.test(c.textContent));
    if (!card || !/Auto-posted/.test(card.textContent)) return false;
    return { text: card.textContent, greens: card.querySelectorAll('.badge.posted.acct-result').length };`, 20000);
  log(!!r, 'card flipped to “⚡ Auto-posted” by itself');
  if (r) {
    log(r.greens === 4, 'per-account ✓ badges for all 4 accounts', String(r.greens));
    log(['Grace Chapel FB', 'Grace Chapel IG', 'Grace Church TV', 'Grace TikTok'].every((n) => r.text.includes(n)), 'badges name each account');
  }
  const puts = received.slice(beforeC).filter((x) => x.url === '/zo/upload/u1');
  log(puts.length === 4 && puts.every((x) => x.fileBytes && x.fileBytes.equals(fs.readFileSync(videoF))), 'Zernio got the EXACT video bytes for each of the 4', String(puts.length));
  const [fbP, igP, ytP, tkP] = ['facebook', 'instagram', 'youtube', 'tiktok'].map((pl) => zoPostsFor(pl, beforeC)[0]);
  log(!!fbP && fbP.fields.content === 'Watch now! ✨', 'Facebook (via Zernio) caption delivered');
  log(!!igP && igP.fields.mediaItems[0].type === 'video', 'Instagram (via Zernio) got the video as a Reel');
  log(!!ytP && ytP.fields.youtubeSettings.title === 'Sunday sermon' && ytP.fields.youtubeSettings.visibility === 'public', 'YouTube (via Zernio) titled + public',
    ytP && JSON.stringify(ytP.fields.youtubeSettings));
  log(!!tkP && tkP.fields.tiktokSettings && tkP.fields.tiktokSettings.privacy_level === 'PUBLIC_TO_EVERYONE'
    && tkP.fields.tiktokSettings.express_consent_given === true, 'TikTok (via Zernio) posted PUBLIC with consent');
  log(notifications.some((n) => n.title.includes('✅')), 'desktop notification fired');

  /* =================== [D] YouTube + TikTok need something to post =================== */
  console.log('\n[D] guard: YouTube + TikTok with nothing attached');
  r = await js(`
    document.getElementById('sTitle').value = 'Words only';
    document.getElementById('addPost').click();
    await new Promise((r2) => setTimeout(r2, 250));
    return { toast: document.getElementById('toast').textContent, made: Array.from(document.querySelectorAll('#postList .post')).some((c) => /Words only/.test(c.textContent)) };`);
  log(/YouTube/.test(r.toast || '') && /TikTok/.test(r.toast || '') && /video or a flyer/i.test(r.toast || '') && !r.made,
    'blocked with a clear “needs a video or a flyer” toast', r.toast);

  /* =================== [E] photo post to Facebook + Instagram =================== */
  console.log('\n[E] photo post to Facebook + Instagram');
  nextOpenFile = photoF;
  const beforeE = received.length;
  r = await js(`
    document.getElementById('sTitle').value = 'Photo for the Page';
    document.getElementById('pickPostMedia').click();
    await new Promise((r2) => setTimeout(r2, 250));
    const pb = document.getElementById('postMediaPreview');
    const preview = { shown: !pb.classList.contains('hidden'), tag: (pb.firstElementChild || {}).tagName, src: (pb.querySelector('img') || {}).src || '' };
    document.querySelectorAll('#postToAccounts input').forEach((c) => { if (/^zo(yt|tk)_/.test(c.value)) c.checked = false; });
    const d = new Date(Date.now() - 60000);
    const p2 = (n) => String(n).padStart(2, '0');
    document.getElementById('sDate').value = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    document.getElementById('sTime').value = p2(d.getHours()) + ':' + p2(d.getMinutes());
    document.getElementById('addPost').click();
    await new Promise((r2) => setTimeout(r2, 200));
    return { preview };`);
  log(r.preview && r.preview.shown && r.preview.tag === 'IMG' && /flyer\.jpg/.test(r.preview.src), 'attached photo shows an inline preview', JSON.stringify(r.preview));
  r = await until(`
    const card = Array.from(document.querySelectorAll('#postList .post')).find((c) => /Photo for the Page/.test(c.textContent));
    if (!card || !/Auto-posted/.test(card.textContent)) return false;
    return { greens: card.querySelectorAll('.badge.posted.acct-result').length };`, 20000);
  log(!!r && r.greens === 2, 'photo post auto-posted to Facebook AND Instagram', r && String(r.greens));
  const photoPuts = received.slice(beforeE).filter((x) => x.url === '/zo/upload/u1');
  log(photoPuts.length === 2 && photoPuts.every((x) => x.fileBytes && x.fileBytes.equals(fs.readFileSync(photoF))), 'Zernio got the EXACT photo bytes for both');
  log(zoPostsFor('facebook', beforeE).length === 1 && zoPostsFor('instagram', beforeE).length === 1
    && !zoPostsFor('youtube', beforeE).length && !zoPostsFor('tiktok', beforeE).length, 'only Facebook and Instagram were posted to');

  /* =================== [F] health check + disconnect =================== */
  console.log('\n[F] account chip health check + disconnect');
  r = await js(`
    document.querySelector('#acctStrip .acct-chip[data-acct="zofb_zoacc_fb"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return document.getElementById('toast').textContent;`);
  log(/connected/i.test(r || ''), 'Facebook chip health check hits Zernio live', r);
  r = await js(`
    document.querySelector('#acctStrip .acct-chip[data-acct="zotk_zoacc_1"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return document.getElementById('toast').textContent;`);
  log(/connected/i.test(r || ''), 'TikTok chip health check hits Zernio live', r);
  r = await js(`
    document.querySelector('#acctStrip [data-unlink="zoig_zoacc_ig"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return { chips: document.querySelectorAll('#acctStrip .acct-chip').length, targets: document.querySelectorAll('#postToAccounts input').length };`);
  log(r.chips === 3 && r.targets === 3, 'disconnect removes the chip + post target', JSON.stringify(r));
  log(accounts.all().length === 3, 'account really removed from the store');

  /* =================== [G] Settings: Zernio keys only =================== */
  console.log('\n[G] Settings — Zernio keys only');
  r = await js(`
    document.querySelector('.nav-item[data-view="settings"]').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const view = document.getElementById('view-settings') || document.body;
    const t = view.textContent;
    const ids = ['setFbPageId', 'setFbToken', 'testFb', 'setFbAppId', 'setFbAppSecret', 'setYtClientId', 'setYtClientSecret'].filter((id) => document.getElementById(id));
    document.getElementById('setZoApiKeyFb').value = 'ZOKEY_fb';
    document.getElementById('saveSettings').click();
    await new Promise((r2) => setTimeout(r2, 300));
    return { ids, zo: !!document.getElementById('setZoApiKey') && !!document.getElementById('setZoApiKeyFb'),
      other: /Meta App|Google Client|Upload-Post|Page access token|developers\\.facebook|console\\.cloud/i.test(t) };`);
  if (r.__error) console.error(r.__error);
  log(r.zo && !(r.ids || []).length && !r.other, 'Settings holds the Zernio keys and nothing for any other way in', JSON.stringify(r.ids));
  const saved = (store.get('settings') || {}).accounts || {};
  log(saved.zoApiKey === 'ZOKEY_ui' && saved.zoApiKeyFb === 'ZOKEY_fb' && saved.zoApiKey3 === 'ZOKEY_three',
    'saving keeps every Zernio key (the second, and a third set from a phone)');

  /* =================== [H] the PC-off fix offers Zernio alone =================== */
  console.log('\n[H] "post with the PC off" — Zernio alone');
  r = await js(`
    showEasyFix('instagram');
    const t = document.getElementById('acctModalBox').textContent;
    const out = { zo: !!document.getElementById('fixZo'), up: !!document.getElementById('fixUp'), other: /Upload-Post/i.test(t), names: /Zernio/.test(t) };
    document.getElementById('acctCancel').click();
    return out;`);
  log(r.zo && !r.up && !r.other && r.names, 'the only fix offered is re-linking through Zernio', JSON.stringify(r));

  /* ---------------- done ---------------- */
  scheduler.stop();
  server.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('TEST CRASH:', e); app.exit(1); });
