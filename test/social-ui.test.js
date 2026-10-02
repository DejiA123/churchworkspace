'use strict';
/*
 * SOCIAL SCHEDULER — FULL UI E2E (real Electron app, real OAuth window).
 *
 * Boots the REAL app UI (index.html + preload + the real Store, Accounts and
 * Scheduler engines wired to IPC exactly like main.js) against a local mock
 * of Meta's servers, then drives the WHOLE Publer-style flow with clicks:
 *   [A] fresh state: banner off, no linked accounts
 *   [B] “＋ Connect account” → REAL OAuth popup window → login redirect
 *       captured → page picker lists 2 Pages + 1 Instagram → Connect selected
 *       → 3 account chips appear, auto-post banner turns ON
 *   [C] schedule a VIDEO post to all 3 accounts, due now → the scheduler
 *       auto-publishes: UI shows “⚡ Auto-posted” + 3 green per-account ✓
 *       badges; the mock server received the exact video bytes for both FB
 *       Pages AND the full Instagram Reel upload (container → bytes → publish)
 *   [B2] YouTube connect via the Google loopback flow
 *   [B3] TikTok connect via a REAL embedded OAuth window (hex PKCE verified)
 *   [D] guard: video-only targets + photo attached blocked with a clear toast
 *   [E] a PHOTO post to the FB Pages only auto-publishes to /photos
 *   [F] account chip health check + disconnect update the UI
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
const publisher = require('../src/main/publisher');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-social-ui-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ---------------- mock Meta: OAuth dialog + Graph + rupload ---------------- */

const PAGE_TOKENS = { pagea: 'PAGETOK_A', pageb: 'PAGETOK_B' };
const received = [];
const AVATAR = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000037', 'hex');
const crypto = require('crypto');
let tkChallenge = ''; // hex PKCE challenge the REAL TikTok window sent
let tkParts = [];
let upProfiles = []; // "Upload-Post" profiles for the easy TikTok route
let zoAccounts = []; // "Zernio" linked accounts for the free & unlimited route
const openedUrls = []; // URLs the renderer asked to open in the system browser

function parseMultipart(body, boundary) {
  const fields = {}; let fileBytes = null;
  const sep = Buffer.from('--' + boundary);
  let idx = 0; const parts = [];
  while (true) {
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
    const fname = (head.match(/filename="([^"]+)"/) || [])[1];
    if (fname) fileBytes = data;
    else if (name) fields[name] = data.toString();
  }
  return { fields, fileBytes };
}

function startMockMeta() {
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
        const gerr = (msg) => send(400, { error: { message: msg } });

        if (p === '/avatar.png') { res.setHeader('content-type', 'image/png'); return res.end(AVATAR); }

        // "Google" OAuth consent screen — bounces straight back to the app's loopback.
        if (p === '/o/oauth2/v2/auth') {
          if (u.searchParams.get('client_id') !== 'ytclient') { res.statusCode = 400; return res.end('bad client'); }
          res.statusCode = 302;
          res.setHeader('location', `${u.searchParams.get('redirect_uri')}?code=GOODCODE&state=${encodeURIComponent(u.searchParams.get('state') || '')}`);
          return res.end();
        }

        // THE REAL OAUTH DIALOG — the app's popup window lands here.
        if (p === '/v19.0/dialog/oauth') {
          const redirect = u.searchParams.get('redirect_uri');
          const state = u.searchParams.get('state') || '';
          if (u.searchParams.get('client_id') !== 'app123') { res.statusCode = 400; return res.end('bad client_id'); }
          res.statusCode = 302;
          res.setHeader('location', `${redirect}#access_token=SHORT_USER_TOKEN&state=${encodeURIComponent(state)}&expires_in=5000`);
          return res.end();
        }
        if (p === '/connect/login_success.html') { res.setHeader('content-type', 'text/html'); return res.end('<html><body>Success</body></html>'); }

        // THE REAL TIKTOK LOGIN — the app's popup window lands here too.
        if (p === '/v2/auth/authorize/') {
          if (u.searchParams.get('client_key') !== 'tkkey') { res.statusCode = 400; return res.end('bad client_key'); }
          tkChallenge = u.searchParams.get('code_challenge') || '';
          res.statusCode = 302;
          res.setHeader('location', `${u.searchParams.get('redirect_uri')}?code=TKCODE&state=${encodeURIComponent(u.searchParams.get('state') || '')}`);
          return res.end();
        }
        if (p === '/tk/callback') { res.setHeader('content-type', 'text/html'); return res.end('<html><body>ok</body></html>'); }

        if (req.method === 'GET') {
          entry.fields = Object.fromEntries(u.searchParams.entries());
          received.push(entry);
          const tok = u.searchParams.get('access_token');
          if (p === '/v19.0/oauth/access_token') {
            if (u.searchParams.get('fb_exchange_token') !== 'SHORT_USER_TOKEN' || u.searchParams.get('client_secret') !== 'appsecret') return gerr('Invalid exchange.');
            return send(200, { access_token: 'LONG_USER_TOKEN' });
          }
          if (p === '/v19.0/me/accounts') {
            if (tok !== 'LONG_USER_TOKEN') return gerr('Invalid OAuth access token.');
            return send(200, {
              data: [
                { id: 'pagea', name: 'Grace Chapel', access_token: PAGE_TOKENS.pagea,
                  picture: { data: { url: origin + '/avatar.png' } },
                  instagram_business_account: { id: 'ig777', username: 'gracechapel', profile_picture_url: origin + '/avatar.png' } },
                { id: 'pageb', name: 'Grace Youth', access_token: PAGE_TOKENS.pageb,
                  picture: { data: { url: origin + '/avatar.png' } } },
              ], paging: {},
            });
          }
          if (p === '/youtube/v3/channels') {
            const bearer = req.headers.authorization || '';
            if (bearer !== 'Bearer YT_ACCESS' && bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
            return send(200, { items: [{ id: 'UCabc123', snippet: { title: 'Grace Chapel Media', thumbnails: { default: { url: origin + '/avatar.png' } } } }] });
          }
          if (p === '/v2/user/info/') {
            const bearer = req.headers.authorization || '';
            if (bearer !== 'Bearer TK_ACCESS' && bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
            return send(200, { data: { user: { open_id: 'tkuser1', display_name: 'Grace TikTok', avatar_url: origin + '/avatar.png' } }, error: { code: 'ok', message: '' } });
          }
          if (p === '/v19.0/igc_1' && /^status_code/.test(u.searchParams.get('fields') || '')) return send(200, { status_code: 'FINISHED' });
          if (p === '/v19.0/igc_img' && /^status_code/.test(u.searchParams.get('fields') || '')) return send(200, { status_code: 'FINISHED' });
          if (p === '/v19.0/igmedia_9' && u.searchParams.get('fields') === 'permalink') return send(200, { permalink: 'https://www.instagram.com/reel/ABC123/' });
          if (p === '/v19.0/igmedia_77' && u.searchParams.get('fields') === 'permalink') return send(200, { permalink: 'https://www.instagram.com/p/PHOTO123/' });
          // staged (unpublished) Page photo → its CDN renditions
          if (/^\/v19\.0\/ph_\d+$/.test(p) && u.searchParams.get('fields') === 'images') {
            if (tok !== PAGE_TOKENS.pagea && tok !== PAGE_TOKENS.pageb) return gerr('Invalid OAuth access token.');
            return send(200, { images: [{ source: origin + '/cdn/' + p.slice('/v19.0/'.length) + '_1080.jpg', width: 1080, height: 1350 }] });
          }
          if (p === '/v19.0/pagea') return tok === PAGE_TOKENS.pagea ? send(200, { id: 'pagea', name: 'Grace Chapel' }) : gerr('Invalid OAuth access token.');
          if (p === '/v19.0/pageb') return tok === PAGE_TOKENS.pageb ? send(200, { id: 'pageb', name: 'Grace Youth' }) : gerr('Invalid OAuth access token.');
          if (p === '/v19.0/ig777') return tok === PAGE_TOKENS.pagea ? send(200, { id: 'ig777', username: 'gracechapel' }) : gerr('Invalid OAuth access token.');

          // "Upload-Post" (easy TikTok): profiles, linking page
          if (p === '/api/uploadposts/users') {
            if ((req.headers.authorization || '') !== 'Apikey UPKEY_ui') return send(401, { success: false, message: 'Invalid API key' });
            return send(200, { success: true, limit: 10, plan: 'free', profiles: upProfiles });
          }
          if (p.startsWith('/api/uploadposts/users/')) {
            if ((req.headers.authorization || '') !== 'Apikey UPKEY_ui') return send(401, { success: false, message: 'Invalid API key' });
            const uname = decodeURIComponent(p.slice('/api/uploadposts/users/'.length));
            const prof = upProfiles.find((x) => x.username === uname);
            return prof ? send(200, { success: true, profile: prof }) : send(404, { success: false, message: 'Profile not found' });
          }
          if (p === '/up/connect') {
            // Upload-Post's linking page: visiting it = the user signing in to TikTok there.
            const prof = upProfiles.find((x) => x.username === u.searchParams.get('u'));
            if (prof) prof.social_accounts.tiktok = { username: 'gracetok', display_name: 'Grace TikTok Easy', social_images: origin + '/avatar.png' };
            res.setHeader('content-type', 'text/html');
            return res.end('<html><body>linked</body></html>');
          }

          // "Zernio" (free & unlimited easy TikTok): accounts, hosted connect page
          if (p === '/zo/v1/accounts') {
            if ((req.headers.authorization || '') !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
            return send(200, { accounts: zoAccounts });
          }
          if (p.startsWith('/zo/v1/connect/')) {
            if ((req.headers.authorization || '') !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
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
          return gerr('Unknown GET ' + p);
        }

        const ct = req.headers['content-type'] || '';
        if (ct.startsWith('multipart/form-data')) {
          const boundary = (ct.match(/boundary=(.+)$/) || [])[1];
          Object.assign(entry, parseMultipart(body, boundary));
        } else if (ct.startsWith('application/x-www-form-urlencoded')) {
          entry.fields = Object.fromEntries(new URLSearchParams(body.toString()).entries());
        } else if (ct.includes('application/json')) {
          try { entry.fields = JSON.parse(body.toString()); } catch (e2) {}
        } else {
          entry.fileBytes = body;
        }
        received.push(entry);
        const tok = entry.fields.access_token;
        const bearer = req.headers.authorization || '';

        // "Google" token endpoint + YouTube resumable upload
        if (p === '/token') {
          const f = entry.fields;
          if (f.grant_type === 'authorization_code') {
            if (f.code !== 'GOODCODE' || f.client_id !== 'ytclient' || f.client_secret !== 'ytsecret' || !f.code_verifier) return send(400, { error: 'invalid_grant', error_description: 'Bad authorization code.' });
            return send(200, { access_token: 'YT_ACCESS', refresh_token: 'YT_REFRESH', expires_in: 3599 });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'YT_REFRESH') return send(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
            return send(200, { access_token: 'YT_ACCESS_R', expires_in: 3599 });
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        if (p === '/upload/youtube/v3/videos') {
          if (bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
          res.setHeader('location', origin + '/upload/yt1');
          return send(200, {});
        }

        // "TikTok" token endpoint — REALLY verifies the hex PKCE from the popup window.
        if (p === '/v2/oauth/token/') {
          const f = entry.fields;
          if (f.grant_type === 'authorization_code') {
            const hexHash = crypto.createHash('sha256').update(f.code_verifier || '').digest('hex');
            if (f.code !== 'TKCODE' || f.client_key !== 'tkkey' || f.client_secret !== 'tksecret') return send(400, { error: 'invalid_grant', error_description: 'Authorization code is invalid.' });
            if (!tkChallenge || hexHash !== tkChallenge) return send(400, { error: 'invalid_request', error_description: 'PKCE verification failed.' });
            return send(200, { access_token: 'TK_ACCESS', refresh_token: 'TK_REFRESH', open_id: 'tkuser1', expires_in: 86400 });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'TK_REFRESH') return send(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid.' });
            return send(200, { access_token: 'TK_ACCESS_R', refresh_token: 'TK_REFRESH', expires_in: 86400 });
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        // "Upload-Post" (easy TikTok): create profile / linking JWT / one-shot upload
        if (p === '/api/uploadposts/users') {
          if (bearer !== 'Apikey UPKEY_ui') return send(401, { success: false, message: 'Invalid API key' });
          const prof = { username: entry.fields.username, created_at: new Date().toISOString(), social_accounts: {} };
          upProfiles.push(prof);
          return send(201, { success: true, profile: prof });
        }
        if (p === '/api/uploadposts/users/generate-jwt') {
          if (bearer !== 'Apikey UPKEY_ui') return send(401, { success: false, message: 'Invalid API key' });
          if (!upProfiles.some((x) => x.username === entry.fields.username)) return send(404, { success: false, message: 'Profile not found' });
          return send(200, { success: true, access_url: origin + '/up/connect?u=' + encodeURIComponent(entry.fields.username), duration: '48h' });
        }
        if (p === '/api/upload') {
          if (bearer !== 'Apikey UPKEY_ui') return send(401, { success: false, message: 'Invalid API key' });
          const f = entry.fields;
          if (!f.user || f['platform[]'] !== 'tiktok' || !entry.fileBytes) return send(400, { success: false, message: 'user, platform[] and video are required' });
          return send(200, { success: true,
            results: { tiktok: { success: true, url: 'https://www.tiktok.com/@gracetok/video/74001', post_id: '74001' } },
            usage: { uploads_this_month: 1, plan: 'free' } });
        }
        // "Zernio" (free & unlimited): presign upload URL → PUT bytes → create post
        if (p === '/zo/v1/media/presign') {
          if (bearer !== 'Bearer ZOKEY_ui') return send(401, { error: 'Invalid API key' });
          return send(200, { uploadUrl: origin + '/zo/upload/u1', publicUrl: origin + '/zo/cdn/u1.mp4' });
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
            return send(200, { id: 'zopost_2', status: 'published',
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
          return send(200, { id: 'zopost_1', status: 'published',
            platforms: [{ platform: 'tiktok', status: 'published', postUrl: 'https://www.tiktok.com/@gracetok/video/99001', postId: '99001' }] });
        }

        if (p === '/v2/post/publish/creator_info/query/') {
          if (bearer !== 'Bearer TK_ACCESS' && bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          return send(200, { data: { creator_username: 'gracechapeltok', creator_nickname: 'Grace TikTok', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] }, error: { code: 'ok', message: '' } });
        }
        if (p === '/v2/post/publish/video/init/') {
          if (bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          tkParts = [];
          return send(200, { data: { publish_id: 'tkpub_1', upload_url: origin + '/tk/upload' }, error: { code: 'ok', message: '' } });
        }
        if (p === '/tk/upload') {
          const cr = (entry.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (req.method !== 'PUT' || !cr) return send(400, { error: { code: 'invalid_params', message: 'Bad Content-Range.' } });
          tkParts.push({ start: +cr[1], buf: entry.fileBytes || Buffer.alloc(0) });
          return send(+cr[2] === +cr[3] - 1 ? 201 : 206, {});
        }
        if (p === '/v2/post/publish/status/fetch/') {
          if (bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          return send(200, { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['73001'] }, error: { code: 'ok', message: '' } });
        }
        if (p === '/upload/yt1') {
          if (bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
          return send(200, { id: 'ytvid123' });
        }

        if (p === '/rupload/igc_1') {
          if (entry.headers.authorization !== 'OAuth ' + PAGE_TOKENS.pagea) return gerr('Bad upload auth.');
          return send(200, { success: true });
        }
        if (p === '/v19.0/ig777/media') {
          if (tok !== PAGE_TOKENS.pagea) return gerr('Invalid OAuth access token.');
          if (entry.fields.image_url) {
            // Like the real API: the URL must be publicly fetchable (our staged CDN link).
            if (!entry.fields.image_url.includes('/cdn/ph_')) return gerr('Media download from URI failed.');
            return send(200, { id: 'igc_img' });
          }
          return send(200, { id: 'igc_1', uri: origin + '/rupload/igc_1' });
        }
        if (p === '/v19.0/ig777/media_publish') return send(200, { id: entry.fields.creation_id === 'igc_img' ? 'igmedia_77' : 'igmedia_9' });
        const m = p.match(/^\/v19\.0\/(page[ab])\/(photos|videos|feed)$/);
        if (m) {
          if (tok !== PAGE_TOKENS[m[1]]) return gerr('Invalid OAuth access token.');
          if (m[2] === 'videos') return send(200, { id: `vid_${m[1]}_${received.length}` });
          if (m[2] === 'photos') return send(200, { id: `ph_${received.length}`, post_id: `${m[1]}_post_${received.length}` });
          return send(200, { id: `feed_${m[1]}_${received.length}` });
        }
        return gerr('Unknown POST ' + p);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, origin, graph: origin + '/v19.0' });
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

app.whenReady().then(async () => {
  console.log('== SOCIAL SCHEDULER UI E2E (real app, real OAuth window) ==');
  const { server, origin, graph } = await startMockMeta();

  // sample media
  const videoF = path.join(tmp, 'sermon.mp4');
  fs.writeFileSync(videoF, Buffer.alloc(48 * 1024, 7));
  const photoF = path.join(tmp, 'flyer.png');
  fs.writeFileSync(photoF, Buffer.from([0x89, 0x50, 0x4e, 0x47, 11, 22, 33, 44]));

  // REAL store + engines, bases pointed at the mock
  const store = new Store(path.join(tmp, 'workstation.json'), {
    settings: {
      brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' },
      apiKeys: {},
      accounts: {
        instagram: '', facebook: '', tiktok: '', fbPageId: '', fbToken: '',
        fbAppId: 'app123', fbAppSecret: 'appsecret', fbApiBase: graph, fbOauthBase: origin,
        ytClientId: 'ytclient', ytClientSecret: 'ytsecret',
        ytAuthBase: origin + '/o/oauth2/v2/auth', ytTokenBase: origin + '/token', ytApiBase: origin,
        tkClientKey: 'tkkey', tkClientSecret: 'tksecret',
        tkAuthBase: origin, tkApiBase: origin, tkRedirectUri: origin + '/tk/callback',
        upApiBase: origin + '/api', // upApiKey deliberately empty — [G] types it through the UI
        zoApiBase: origin + '/zo/v1', // zoApiKey deliberately empty — [H] types it through the UI
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

  /* real IPC (mirrors main.js) */
  ipcMain.handle('settings:get', () => ok(store.get('settings')));
  ipcMain.handle('settings:update', wrap(async (e, { patch }) => store.set('settings', { ...(store.get('settings') || {}), ...patch })));
  ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
  ipcMain.handle('accounts:list', wrap(async () => accounts.list()));
  ipcMain.handle('accounts:connectFb', wrap(async () => accounts.connectFacebook(win)));
  // Same real engine — only the system browser is played by an HTTP client
  // (Google blocks embedded windows, so production opens the real browser).
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
  ipcMain.handle('accounts:connectYt', wrap(async () => accounts.connectYouTube(win, { openUrl: (u) => httpFollow(u) })));
  // TikTok uses the REAL embedded OAuth window against the mock server.
  ipcMain.handle('accounts:connectTk', wrap(async () => accounts.connectTikTok(win)));
  // Easy connect: Upload-Post's linking page is played by the same HTTP client.
  ipcMain.handle('accounts:connectTkEasy', wrap(async () => accounts.connectTikTokEasy(win, { openUrl: (u2) => httpFollow(u2), pollMs: 50 })));
  // Zernio (free & unlimited): its hosted connect page is played the same way.
  ipcMain.handle('accounts:connectZo', wrap(async () => accounts.connectZernio(win, { openUrl: (u2) => httpFollow(u2), pollMs: 50 })));
  ipcMain.handle('accounts:connectZoYt', wrap(async () => accounts.connectZernio(win, { platform: 'youtube', openUrl: (u2) => httpFollow(u2), pollMs: 50 })));
  ipcMain.handle('accounts:connectZoFb', wrap(async () => accounts.connectZernio(win, { platform: 'facebook', openUrl: (u2) => httpFollow(u2), pollMs: 50 })));
  ipcMain.handle('accounts:connectZoIg', wrap(async () => accounts.connectZernio(win, { platform: 'instagram', openUrl: (u2) => httpFollow(u2), pollMs: 50 })));
  ipcMain.handle('accounts:add', wrap(async (e, { connectId, selections }) => accounts.addFromConnect(connectId, selections)));
  ipcMain.handle('accounts:remove', wrap(async (e, { id }) => accounts.remove(id)));
  ipcMain.handle('accounts:check', wrap(async (e, { id }) => accounts.check(id)));
  ipcMain.handle('scheduler:list', wrap(async () => scheduler.list()));
  ipcMain.handle('scheduler:add', wrap(async (e, { post }) => scheduler.add(post)));
  ipcMain.handle('scheduler:update', wrap(async (e, { id, patch }) => scheduler.update(id, patch)));
  ipcMain.handle('scheduler:remove', wrap(async (e, { id }) => scheduler.remove(id)));
  ipcMain.handle('scheduler:publish', wrap(async (e, { id }) => scheduler.publishNow(id)));
  ipcMain.handle('scheduler:publishAuto', wrap(async (e, { id }) => scheduler.autoPublish(id)));
  ipcMain.handle('scheduler:retry', wrap(async (e, { id }) => scheduler.retry(id)));
  ipcMain.handle('scheduler:testFb', wrap(async () => publisher.testFacebook({ pageId: 'pagea', token: 'PAGETOK_A', apiBase: graph })));

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
  ipcMain.handle('shell:openExternal', (e, { url }) => { openedUrls.push(url); return ok(true); });
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
  log(/Nothing linked yet/.test(r.strip), 'accounts strip explains how to link');
  log(/No linked accounts yet/.test(r.targets), 'post form has no targets yet');

  /* =================== [B] connect through the REAL OAuth window =================== */
  console.log('\n[B] connect account (platform chooser → real OAuth popup → page picker)');
  // The FB setup screen must carry the FULL working walkthrough (the login-product
  // toggles + the redirect-URI trap are what real users get stuck on).
  r = await js(`
    showAppSetup();
    const t = document.getElementById('acctModalBox').textContent;
    const okSteps = /developers\\.facebook\\.com\\/apps/.test(t) && /Embedded browser OAuth login/.test(t)
      && /Client OAuth login/.test(t) && /Redirect URIs empty/i.test(t)
      && /Can't load URL/.test(t) && /Development mode/.test(t);
    const fields = !!document.getElementById('wizAppId') && !!document.getElementById('wizAppSecret');
    document.getElementById('acctClose').click();
    return { okSteps, fields };`);
  if (r.__error) console.error(r.__error);
  log(r.okSteps && r.fields, 'FB setup screen shows the full walkthrough (toggles + redirect-URI trap + dev-mode note)');
  r = await js(`
    document.getElementById('connectAccount').click();
    await new Promise((r2) => setTimeout(r2, 150));
    const has = { fb: !!document.getElementById('chooseFb'), yt: !!document.getElementById('chooseYt'), tk: !!document.getElementById('chooseTk') };
    document.getElementById('chooseFb').click();  // Facebook + Instagram → Meta connect directly (no chooser)
    return { ...has };`);
  log(r.fb && r.yt && r.tk, 'chooser offers Facebook+Instagram, YouTube AND TikTok', JSON.stringify(r));
  r = await until(`
    const box = document.getElementById('acctModalBox');
    if (!box || !/Pick what to connect/.test(box.textContent)) return false;
    return {
      rows: box.querySelectorAll('.acct-pagerow').length,
      names: box.textContent,
      avatars: box.querySelectorAll('img.acct-ava[src^="data:image"]').length,
      checked: box.querySelectorAll('[data-sel]:checked').length,
    };`);
  log(!!r, 'OAuth window auto-completed → page picker opened');
  if (r) {
    log(r.rows === 3, 'picker lists 2 Pages + 1 Instagram account', String(r.rows));
    log(/Grace Chapel/.test(r.names) && /Grace Youth/.test(r.names) && /@gracechapel/.test(r.names), 'names all correct');
    log(r.avatars === 3, 'real avatars shown (downloaded → data URIs)', String(r.avatars));
    log(r.checked === 3, 'everything pre-checked for one-click connect');
  }
  await js(`document.getElementById('wizFinish').click(); return true;`);
  r = await until(`
    const chips = document.querySelectorAll('#acctStrip .acct-chip');
    if (chips.length !== 3) return false;
    return {
      banner: document.getElementById('schedAutoBanner').textContent,
      bannerOn: /on/.test(document.getElementById('schedAutoBanner').className),
      targets: document.querySelectorAll('#postToAccounts input:checked').length,
      names: document.getElementById('acctStrip').textContent,
    };`);
  log(!!r, '3 account chips appeared after Connect');
  if (r) {
    log(r.bannerOn && /Auto-posting is ON/.test(r.banner) && /3 linked/.test(r.banner), 'banner: Auto-posting ON with 3 accounts', r.banner);
    log(r.targets === 3, 'new-post form targets all 3 accounts by default');
  }
  log(accounts.all().length === 3 && accounts.byId('fb_pagea').token === 'PAGETOK_A', 'tokens stored on the machine (main process)');

  /* =================== [B2] connect YouTube (Google sign-in via loopback) =================== */
  console.log('\n[B2] connect YouTube channel');
  await js(`
    document.getElementById('connectAccount').click();
    await new Promise((r2) => setTimeout(r2, 150));
    document.getElementById('chooseYt').click();
    return true;`);
  r = await until(`
    const chips = document.querySelectorAll('#acctStrip .acct-chip');
    if (chips.length !== 4) return false;
    return {
      banner: document.getElementById('schedAutoBanner').textContent,
      names: document.getElementById('acctStrip').textContent,
      toast: document.getElementById('toast').textContent,
      targets: document.querySelectorAll('#postToAccounts input:checked').length,
    };`);
  log(!!r, 'Google sign-in auto-completed → YouTube chip appeared');
  if (r) {
    log(/Grace Chapel Media/.test(r.names), 'channel connected by name', r.names.trim().slice(0, 80));
    log(/4 linked/.test(r.banner), 'banner counts 4 linked accounts', r.banner);
    log(/YouTube auto-posting is ON/.test(r.toast), 'success toast confirms YouTube', r.toast);
    log(r.targets === 4, 'new-post form now targets all 4 accounts');
  }
  log(accounts.byId('yt_UCabc123') && accounts.byId('yt_UCabc123').token === 'YT_REFRESH', 'refresh token stored for the channel');

  /* =================== [B3] connect TikTok (Zernio easy-connect — the only TikTok route) =================== */
  console.log('\n[B3] connect TikTok account (Zernio easy-connect)');
  r = await js(`
    document.getElementById('connectAccount').click();
    await new Promise((r2) => setTimeout(r2, 150));
    document.getElementById('chooseTk').click();  // no Zernio key yet → the Zernio setup wizard opens
    await new Promise((r2) => setTimeout(r2, 100));
    const box = document.getElementById('acctModalBox').textContent;
    const wiz = !!document.getElementById('wizZoKey');
    const okSteps = /zernio\\.com|Zernio/.test(box) && /unlimited/i.test(box);
    if (wiz) { document.getElementById('wizZoKey').value = 'ZOKEY_ui'; document.getElementById('wizZoContinue').click(); }
    return { wiz, okSteps };`);
  if (r.__error) console.error(r.__error);
  log(r.wiz && r.okSteps, 'TikTok connect opens the Zernio easy-connect wizard (free & unlimited)');
  r = await until(`
    const chips = document.querySelectorAll('#acctStrip .acct-chip');
    if (chips.length !== 5) return false;
    return {
      banner: document.getElementById('schedAutoBanner').textContent,
      names: document.getElementById('acctStrip').textContent,
      toast: document.getElementById('toast').textContent,
      saved: document.getElementById('setZoApiKey').value,
      targets: document.querySelectorAll('#postToAccounts input:checked').length,
    };`);
  log(!!r, 'pasted Zernio key → hosted page → TikTok chip appeared (no dev app, no OAuth window)');
  if (r) {
    log(/Grace TikTok/.test(r.names), 'account connected by name', r.names.trim().slice(0, 80));
    log(/5 linked/.test(r.banner), 'banner counts 5 linked accounts', r.banner);
    log(/TikTok auto-posting is ON/.test(r.toast), 'success toast confirms TikTok', r.toast);
    log(r.saved === 'ZOKEY_ui', 'Zernio key mirrored into Settings');
    log(r.targets === 5, 'new-post form now targets all 5 accounts');
  }
  const tkRec = accounts.byId('zotk_zoacc_1');
  log(!!tkRec && tkRec.token === 'ZOKEY_ui' && tkRec.via === 'zernio' && tkRec.platform === 'tiktok', 'TikTok stored via Zernio (API key as the token)');

  /* =================== [C] schedule a video post → auto-publishes everywhere =================== */
  console.log('\n[C] scheduled video post auto-publishes to all 5 accounts');
  nextOpenFile = videoF;
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
    return { media: document.getElementById('postMediaName').textContent, toasts, preview, clearedAfterPost: document.getElementById('postMediaPreview').classList.contains('hidden') };`);
  if (r.__error) console.error(r.__error);
  log(r.preview && r.preview.shown && r.preview.tag === 'VIDEO' && /sermon\.mp4/.test(r.preview.src), 'attached video shows an inline preview', JSON.stringify(r.preview));
  log(r.preview && r.preview.controls && r.preview.autoplay && r.preview.muted, 'video preview autoplays muted and is pausable (controls)', JSON.stringify(r.preview));
  log(r.clearedAfterPost, 'preview clears after the post is scheduled');
  log((r.toasts || []).some((t) => /scheduled/i.test(t)), 'post scheduled from the form', (r.toasts || []).join(' | '));

  r = await until(`
    const card = Array.from(document.querySelectorAll('#postList .post')).find((c) => /Sunday sermon/.test(c.textContent));
    if (!card || !/Auto-posted/.test(card.textContent)) return false;
    return {
      text: card.textContent,
      greens: card.querySelectorAll('.badge.posted.acct-result').length,
    };`, 20000);
  log(!!r, 'card flipped to “⚡ Auto-posted” by itself');
  if (r) {
    log(r.greens === 5, 'per-account ✓ badges for all 5 accounts', String(r && r.greens));
    log(/Grace Chapel/.test(r.text) && /Grace Youth/.test(r.text) && /@gracechapel/.test(r.text) && /Grace Chapel Media/.test(r.text) && /Grace TikTok/.test(r.text), 'badges name each account');
  }
  // The publisher offers an upload session before sending a video (v2.44.1),
  // so the FIRST thing to reach /videos is that offer. The request that
  // carries the file is the one these checks are about.
  const vidA = received.find((x) => x.url === '/v19.0/pagea/videos' && x.fileBytes);
  const vidB = received.find((x) => x.url === '/v19.0/pageb/videos' && x.fileBytes);
  const igUp = received.find((x) => x.url === '/rupload/igc_1');
  const igPub = received.find((x) => x.url === '/v19.0/ig777/media_publish');
  const ytInit = received.find((x) => x.url === '/upload/youtube/v3/videos');
  const ytUp = received.find((x) => x.url === '/upload/yt1');
  const tkZoPut = received.find((x) => x.url === '/zo/upload/u1');
  const tkZoPost = received.find((x) => x.url === '/zo/v1/posts' && x.fields && Array.isArray(x.fields.platforms) && x.fields.platforms[0].platform === 'tiktok');
  log(!!vidA && vidA.fileBytes && vidA.fileBytes.equals(fs.readFileSync(videoF)), 'Page A got the EXACT video bytes');
  log(!!vidB && vidB.fileBytes && vidB.fileBytes.equals(fs.readFileSync(videoF)), 'Page B got the EXACT video bytes');
  log(!!igUp && igUp.fileBytes && igUp.fileBytes.equals(fs.readFileSync(videoF)), 'Instagram got the EXACT Reel bytes');
  log(!!igPub, 'Instagram Reel was published (media_publish hit)');
  log(!!ytUp && ytUp.fileBytes && ytUp.fileBytes.equals(fs.readFileSync(videoF)), 'YouTube got the EXACT video bytes');
  log(!!ytInit && ytInit.fields.snippet && ytInit.fields.snippet.title === 'Sunday sermon' && ytInit.fields.snippet.description === 'Watch now! ✨', 'YouTube title + description delivered');
  log(!!tkZoPut && tkZoPut.fileBytes && tkZoPut.fileBytes.equals(fs.readFileSync(videoF)), 'TikTok (via Zernio) got the EXACT video bytes on the signed URL');
  log(!!tkZoPost && tkZoPost.fields.content === 'Watch now! ✨', 'TikTok (via Zernio) caption delivered');
  log(!!tkZoPost && tkZoPost.fields.tiktokSettings && tkZoPost.fields.tiktokSettings.privacy_level === 'PUBLIC_TO_EVERYONE'
    && tkZoPost.fields.tiktokSettings.express_consent_given === true, 'TikTok (via Zernio) posted PUBLIC with consent');
  log(vidA && vidA.fields.description === 'Watch now! ✨', 'caption delivered to Facebook');
  log(notifications.some((n) => n.title.includes('✅')), 'desktop notification fired');

  /* =================== [D] video-only guard (YouTube + TikTok) =================== */
  console.log('\n[D] video-only guard (YouTube + TikTok)');
  nextOpenFile = photoF;
  r = await js(`
    document.getElementById('sTitle').value = 'Photo everywhere';
    document.getElementById('pickPostMedia').click();
    await new Promise((r2) => setTimeout(r2, 250));
    // An image attachment previews as an <img>.
    const pb = document.getElementById('postMediaPreview');
    const preview = { shown: !pb.classList.contains('hidden'), tag: (pb.firstElementChild || {}).tagName, src: (pb.querySelector('img') || {}).src || '' };
    document.getElementById('addPost').click();
    await new Promise((r2) => setTimeout(r2, 250));
    return { toast: document.getElementById('toast').textContent, posts: document.querySelectorAll('#postList .post').length, preview };`);
  log(r.preview && r.preview.shown && r.preview.tag === 'IMG' && /flyer\.png/.test(r.preview.src), 'attached photo shows an inline preview', JSON.stringify(r.preview));
  log(/video/i.test(r.toast || ''), 'blocked with a clear “needs a video” toast', r.toast);

  /* =================== [E] photo post to FB Pages + Instagram =================== */
  console.log('\n[E] photo post to the two FB Pages + Instagram');
  r = await js(`
    // untick the video-only targets (YouTube + TikTok); Instagram takes photos now
    document.querySelectorAll('#postToAccounts input').forEach((c) => { if (c.value.startsWith('yt_') || /tk_/.test(c.value)) c.checked = false; });
    const d = new Date(Date.now() - 60000);
    const p2 = (n) => String(n).padStart(2, '0');
    document.getElementById('sDate').value = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    document.getElementById('sTime').value = p2(d.getHours()) + ':' + p2(d.getMinutes());
    document.getElementById('addPost').click();
    await new Promise((r2) => setTimeout(r2, 200));
    return document.getElementById('toast').textContent;`);
  r = await until(`
    const card = Array.from(document.querySelectorAll('#postList .post')).find((c) => /Photo everywhere/.test(c.textContent));
    if (!card || !/Auto-posted/.test(card.textContent)) return false;
    return { greens: card.querySelectorAll('.badge.posted.acct-result').length, text: card.textContent };`, 20000);
  log(!!r, 'photo post auto-posted');
  if (r) log(r.greens === 3, 'the 2 Pages AND Instagram got it', String(r.greens));
  const phA = received.find((x) => x.url === '/v19.0/pagea/photos');
  const phB = received.find((x) => x.url === '/v19.0/pageb/photos');
  log(!!phA && phA.fileBytes && phA.fileBytes.equals(fs.readFileSync(photoF)), 'Page A photo bytes EXACT');
  log(!!phB && phB.fileBytes && phB.fileBytes.equals(fs.readFileSync(photoF)), 'Page B photo bytes EXACT');
  const igStage = received.find((x) => x.url === '/v19.0/pagea/photos' && x.fields && x.fields.published === 'false');
  log(!!igStage && igStage.fields.temporary === 'true', 'photo staged UNPUBLISHED + temporary on the linked Page for Instagram');
  log(!!igStage && igStage.fileBytes && igStage.fileBytes.equals(fs.readFileSync(photoF)), 'staged photo bytes EXACT');
  const igImgC = received.find((x) => x.url === '/v19.0/ig777/media' && x.fields && x.fields.image_url);
  log(!!igImgC && /\/cdn\/ph_\d+_1080\.jpg$/.test(igImgC.fields.image_url) && /Photo everywhere/.test(igImgC.fields.caption || ''),
    'Instagram container got the staged CDN image_url + caption', igImgC && igImgC.fields.image_url);
  log(received.some((x) => x.url === '/v19.0/ig777/media_publish' && x.fields && x.fields.creation_id === 'igc_img'), 'Instagram photo was published (media_publish hit)');
  log(received.filter((x) => x.url === '/upload/youtube/v3/videos').length === 1, 'YouTube untouched by the photo post (still just the 1 video upload)');
  log(received.filter((x) => x.url === '/zo/v1/posts' && x.fields && Array.isArray(x.fields.platforms) && x.fields.platforms[0].platform === 'tiktok').length === 1,
    'TikTok (via Zernio) untouched by the photo post (still just the 1 video post)');

  /* =================== [F] health check + disconnect =================== */
  console.log('\n[F] account chip health check + disconnect');
  r = await js(`
    document.querySelector('#acctStrip .acct-chip[data-acct="fb_pagea"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return document.getElementById('toast').textContent;`);
  log(/Grace Chapel/.test(r || '') && /connected/i.test(r || ''), 'chip click → live health check toast', r);

  r = await js(`
    document.querySelector('#acctStrip .acct-chip[data-acct="yt_UCabc123"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return document.getElementById('toast').textContent;`);
  log(/Grace Chapel Media/.test(r || '') && /connected/i.test(r || ''), 'YouTube chip health check hits Google live', r);

  r = await js(`
    document.querySelector('#acctStrip .acct-chip[data-acct="zotk_zoacc_1"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return document.getElementById('toast').textContent;`);
  log((/Grace TikTok/.test(r || '') || /gracetok/i.test(r || '')) && /connected/i.test(r || ''), 'TikTok chip health check hits Zernio live', r);

  r = await js(`
    document.querySelector('#acctStrip [data-unlink="fb_pageb"]').click();
    await new Promise((r2) => setTimeout(r2, 500));
    return {
      chips: document.querySelectorAll('#acctStrip .acct-chip').length,
      targets: document.querySelectorAll('#postToAccounts input').length,
    };`);
  log(r.chips === 4 && r.targets === 4, 'disconnect removes the chip + post target', JSON.stringify(r));
  log(accounts.all().length === 4, 'account really removed from the store');

  /* =================== [I] YouTube easy connect via the SAME Zernio key (no Google Console) =================== */
  console.log('\n[I] YouTube easy connect — Zernio (no Google Cloud Console)');
  r = await js(`
    showYtChoice();
    const two = !!document.getElementById('ytEasy') && !!document.getElementById('ytAdvanced');
    const t = document.getElementById('acctModalBox').textContent;
    const mentionsFree = /no Google|zernio/i.test(t);
    document.getElementById('ytEasy').click();
    return { two, mentionsFree };`);
  if (r.__error) console.error(r.__error);
  log(r.two, 'YouTube chooser offers BOTH: easy (Zernio) + advanced (Google app)');
  log(r.mentionsFree, 'YouTube easy option advertises "no Google setup" / Zernio');
  r = await until(`
    const chips = document.querySelectorAll('#acctStrip .acct-chip');
    if (chips.length !== 5) return false;
    return { names: document.getElementById('acctStrip').textContent, toast: document.getElementById('toast').textContent };`);
  log(!!r, 'ytEasy → YouTube linked with NO key prompt + NO Google window (reused the saved Zernio key)');
  if (r) {
    log(/Grace Church TV/.test(r.names), 'YouTube (Zernio) account connected by name', r.names.trim().slice(0, 80));
    log(/YouTube auto-posting is ON/i.test(r.toast), 'success toast confirms YouTube auto-posting', r.toast);
  }
  const zoytRec = accounts.byId('zoyt_zoacc_yt');
  log(!!zoytRec && zoytRec.token === 'ZOKEY_ui' && zoytRec.via === 'zernio' && zoytRec.platform === 'youtube',
    'YouTube account stored via Zernio, reusing the SAME key as TikTok');

  // Auto-publish a video to YouTube via Zernio: presign → PUT → post with a title.
  const zoytBefore = received.length;
  const zoytPost = scheduler.add({
    title: 'Sunday Service', caption: 'Full service ✝', platforms: [],
    accountIds: ['zoyt_zoacc_yt'], mediaPaths: [videoF],
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  try { await scheduler.autoPublish(zoytPost.id); } catch (e2) { /* recorded on the post */ }
  const zoytDone = scheduler.list().find((x) => x.id === zoytPost.id);
  log(!!zoytDone && zoytDone.status === 'posted' && zoytDone.results['zoyt_zoacc_yt'].ok,
    'video AUTO-POSTED to YouTube through Zernio', zoytDone && (zoytDone.error || zoytDone.status));
  const zoytReq = received.slice(zoytBefore).find((x) => x.url === '/zo/v1/posts');
  log(!!zoytReq && zoytReq.fields.platforms[0].platform === 'youtube'
    && zoytReq.fields.youtubeSettings.title === 'Sunday Service' && zoytReq.fields.youtubeSettings.visibility === 'public',
    'YouTube post sent title + public visibility', zoytReq && JSON.stringify(zoytReq.fields.youtubeSettings));
  log(!!zoytDone && /watch\?v=YT99/.test((zoytDone.results['zoyt_zoacc_yt'] || {}).url || ''), 'result carries the YouTube watch link');

  /* ---------------- done ---------------- */
  scheduler.stop();
  server.close();
  console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('TEST CRASH:', e); app.exit(1); });
