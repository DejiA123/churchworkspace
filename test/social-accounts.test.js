'use strict';
/**
 * SOCIAL ACCOUNT LINKING + MULTI-ACCOUNT AUTO-POSTING E2E (plain Node).
 *
 * Boots a full mock of Meta's servers (OAuth token exchange, /me/accounts,
 * Page publishing, Instagram resumable Reels upload) and proves the whole
 * pipeline REALLY works:
 *   [A] account linking: token exchange → page listing (with IG accounts,
 *       avatars as data URIs) → picked accounts stored, tokens hidden from UI
 *   [B] Instagram Reels: container → raw byte upload → processing poll →
 *       media_publish → permalink; feed photos: staged unpublished on the
 *       linked Page → image_url container → published; text-only rejected
 *   [C] scheduler: one post fans out to MULTIPLE accounts (2 FB Pages + IG),
 *       per-account results, partial failure retries ONLY the failed account
 *       (never double-posts the ones that succeeded)
 *   [D] platform-matched + legacy token posts still auto-publish
 *   [E] YouTube: Google sign-in (PKCE + loopback) → resumable upload
 *   [F] TikTok: login (hex PKCE) → chunked Direct Post → 5-account fan-out
 *
 * Run: node test/social-accounts.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const publisher = require('../src/main/publisher');
const { Scheduler, MAX_ATTEMPTS } = require('../src/main/scheduler');
const { Accounts, exchangeLongLived, listPages, fetchAvatarDataUri } = require('../src/main/accounts');
const { Store } = require('../src/main/store');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------- mock Meta (OAuth + Graph + rupload) --------------------- */

const PAGE_TOKENS = { pagea: 'PAGETOK_A', pageb: 'PAGETOK_B' };
const received = [];          // every request: { url, method, fields, fileBytes, headers }
let igStatusCallsUntilDone = 1; // Nth status poll returns FINISHED
let igStatusCalls = 0;
/* When Meta's resumable upload endpoint is broken it answers HTTP 500 with a
   ProcessingFailedError body — exactly what a real church account gets today.
   Flipping this on lets a test prove the app falls back to the staged-link
   route instead of giving up. */
let igRuploadBroken = false;
/* …and the same for Instagram's processor, which fails a video container with
   an undocumented error code no matter how the bytes got there. */
let igVideoProcessingBroken = false;

/* ---- Facebook video-upload mock state ----
   Meta's Graph edge refuses a POST body past a certain size with a bare HTML
   413 — no error object in it at all — which is what the church's long sermons
   came back as while the 40-130MB shorts sailed through. The cap here is small
   so the same wall can be hit in a test in milliseconds. */
let fbMaxBody = 2 * 1024 * 1024; // graph.facebook.com's "that's too big" line
let fbSessionsOn = true;         // does this edge run upload sessions at all?
let fbChunkBytes = 1024 * 1024;  // the range the mock asks for per transfer
let fbDropReplyAt = -1;          // swallow the reply once at this byte offset
const fbSessions = {};           // id -> { size, got, sha, page, description, published }
let fbSesN = 0;

// TikTok mock state
let tkPrivacyOptions = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];
let tkStatusCallsUntilDone = 1; // Nth status poll returns PUBLISH_COMPLETE
let tkStatusCalls = 0;
let tkParts = [];               // uploaded chunks: { start, buf }
let tkInitCount = 0;
const tkAssembled = () => Buffer.concat(tkParts.slice().sort((a, b) => a.start - b.start).map((p) => p.buf));

// Upload-Post ("easy" TikTok) mock state
const UP_KEY = 'UPKEY_abc123';
let upProfiles = [];            // [{ username, created_at, social_accounts }]
let upAsync = false;            // /api/upload answers with a request_id instead
let upFail = false;             // /api/upload reports a TikTok failure
let upLimit = false;            // /api/upload rejects: free-plan monthly cap hit
let upStatusCallsUntilDone = 1; // Nth status poll returns "completed"
let upStatusCalls = 0;

// Zernio ("easy connect — free & unlimited" TikTok) mock state
const ZO_KEY = 'ZOKEY_xyz789';
const ZO_KEY_FB = 'ZOKEY_fb_456';  // a SECOND free Zernio account (workspace) for Facebook + Instagram
let zoAccounts = [];            // workspace 1 (ZO_KEY): [{ _id, platform, username, displayName, picture }]
let zoAccountsFb = [];          // workspace 2 (ZO_KEY_FB): keeps FB/IG under the 2-account free cap
let zoFail = false;            // /zo/v1/posts reports a TikTok failure
// Map a Bearer key to its workspace (two separate free Zernio accounts).
const zoWsOf = (bearer) => {
  const k = String(bearer || '').replace(/^Bearer\s+/, '');
  if (k === ZO_KEY) return { id: 'main', accounts: zoAccounts };
  if (k === ZO_KEY_FB) return { id: 'fb', accounts: zoAccountsFb };
  return null;
};
let zoLimit = false;           // presign/posts reject with a plan/limit error
let zoAsync = false;           // /posts returns "processing"; GET /posts/:id completes
let zoStatusCallsUntilDone = 1; // Nth post-status poll returns "published"
let zoStatusCalls = 0;
const zoUploads = {};          // upload-slot id -> bytes PUT to the signed URL

const AVATAR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

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
    const flags = { ytChallenge: '', pkceOk: false, tkChallenge: '', tkPkceOk: false };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const u = new URL(req.url, 'http://x');
        const p = u.pathname;
        const entry = { url: p, method: req.method, fields: {}, fileBytes: null, headers: req.headers };
        const send = (code, obj) => { res.statusCode = code; res.end(JSON.stringify(obj)); };
        const gerr = (msg) => send(400, { error: { message: msg } });

        // ---- avatars ----
        if (p === '/avatar.png') {
          res.setHeader('content-type', 'image/png');
          return res.end(AVATAR);
        }

        if (req.method === 'GET') {
          entry.fields = Object.fromEntries(u.searchParams.entries());
          received.push(entry);
          const tok = u.searchParams.get('access_token');
          const bearer = req.headers.authorization || '';

          // "Google" OAuth consent screen — records PKCE + bounces to loopback
          if (p === '/o/oauth2/v2/auth') {
            if (u.searchParams.get('client_id') !== 'ytclient') { res.statusCode = 400; return res.end('bad client'); }
            flags.ytChallenge = u.searchParams.get('code_challenge') || '';
            res.statusCode = 302;
            res.setHeader('location', `${u.searchParams.get('redirect_uri')}?code=GOODCODE&state=${encodeURIComponent(u.searchParams.get('state') || '')}`);
            return res.end();
          }
          // YouTube channel lookup
          if (p === '/youtube/v3/channels') {
            if (bearer !== 'Bearer YT_ACCESS' && bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
            return send(200, { items: [{ id: 'UCabc123', snippet: { title: 'Grace Chapel Media', thumbnails: { default: { url: origin + '/avatar.png' } } } }] });
          }

          // "TikTok" login/consent page — records the (hex) PKCE challenge and
          // bounces to the registered redirect URI with a code.
          if (p === '/v2/auth/authorize/') {
            if (u.searchParams.get('client_key') !== 'tkkey') { res.statusCode = 400; return res.end('bad client_key'); }
            flags.tkChallenge = u.searchParams.get('code_challenge') || '';
            res.statusCode = 302;
            res.setHeader('location', `${u.searchParams.get('redirect_uri')}?code=TKCODE&state=${encodeURIComponent(u.searchParams.get('state') || '')}`);
            return res.end();
          }
          if (p === '/tk/callback') { res.setHeader('content-type', 'text/html'); return res.end('<html><body>ok</body></html>'); }
          // TikTok profile lookup
          if (p === '/v2/user/info/') {
            if (bearer !== 'Bearer TK_ACCESS' && bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
            return send(200, { data: { user: { open_id: 'tkuser1', union_id: 'un1', display_name: 'Grace TikTok', avatar_url: origin + '/avatar.png' } }, error: { code: 'ok', message: '' } });
          }

          // "Upload-Post" — profile listing / lookup / linking page / status
          if (p === '/api/uploadposts/users') {
            if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
            return send(200, { success: true, limit: 10, plan: 'free', profiles: upProfiles });
          }
          if (p.startsWith('/api/uploadposts/users/')) {
            if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
            const uname = decodeURIComponent(p.slice('/api/uploadposts/users/'.length));
            const prof = upProfiles.find((x) => x.username === uname);
            return prof ? send(200, { success: true, profile: prof }) : send(404, { success: false, message: 'Profile not found' });
          }
          if (p === '/up/connect') {
            // Upload-Post's linking page: visiting it plays the part of the
            // user signing in to TikTok there and approving.
            const prof = upProfiles.find((x) => x.username === u.searchParams.get('u'));
            if (prof) prof.social_accounts.tiktok = { username: 'gracetok', display_name: 'Grace TikTok Easy', social_images: origin + '/avatar.png' };
            res.setHeader('content-type', 'text/html');
            return res.end('<html><body>linked</body></html>');
          }
          // "Zernio" — list connected accounts / hosted TikTok connect page / post status
          if (p === '/zo/v1/accounts') {
            const ws = zoWsOf(bearer); if (!ws) return send(401, { error: 'Invalid API key' });
            return send(200, { accounts: ws.accounts });
          }
          if (p.startsWith('/zo/v1/connect/')) {
            const ws = zoWsOf(bearer); if (!ws) return send(401, { error: 'Invalid API key' });
            return send(200, { url: origin + '/zo/link?platform=' + p.slice('/zo/v1/connect/'.length) + '&ws=' + ws.id });
          }
          if (p === '/zo/link') {
            // Visiting Zernio's hosted page plays the part of the user signing in
            // to the platform there and approving. `ws` picks which free account.
            const plat = u.searchParams.get('platform') || 'tiktok';
            const ws = (u.searchParams.get('ws') === 'fb') ? { id: 'fb', accounts: zoAccountsFb } : { id: 'main', accounts: zoAccounts };
            const seed = {
              tiktok: { _id: 'zoacc_1', platform: 'tiktok', username: 'gracetok', displayName: 'Grace TikTok Z' },
              youtube: { _id: 'zoacc_yt', platform: 'youtube', username: 'gracechannel', displayName: 'Grace Church TV' },
              facebook: { _id: 'zoacc_fb', platform: 'facebook', username: 'gracechapel', displayName: 'Grace Chapel FB' },
              instagram: { _id: 'zoacc_ig', platform: 'instagram', username: 'gracechapel', displayName: 'Grace Chapel IG' },
            }[plat];
            if (seed && !ws.accounts.some((a) => a.platform === plat)) {
              // Give workspace-2 accounts distinct ids so a second-account test is unambiguous.
              const rec = { ...seed, _id: ws.id === 'fb' ? seed._id + '_w2' : seed._id, picture: origin + '/avatar.png' };
              ws.accounts.push(rec);
            }
            res.setHeader('content-type', 'text/html');
            return res.end('<html><body>linked</body></html>');
          }
          if (p.startsWith('/zo/v1/posts/')) {
            if (!zoWsOf(bearer)) return send(401, { error: 'Invalid API key' });
            zoStatusCalls++;
            const done = zoStatusCalls >= zoStatusCallsUntilDone;
            return send(200, { id: 'zopost_1', status: done ? 'published' : 'processing',
              platforms: [{ platform: 'tiktok', status: done ? 'published' : 'processing',
                postUrl: done ? 'https://www.tiktok.com/@gracetok/video/99001' : undefined,
                postId: done ? '99001' : undefined }] });
          }
          if (p === '/api/uploadposts/status') {
            if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
            if (u.searchParams.get('request_id') !== 'upreq_1') return send(400, { error: 'request_id or job_id is required' });
            upStatusCalls++;
            if (upStatusCalls >= upStatusCallsUntilDone) {
              return send(200, { request_id: 'upreq_1', status: 'completed', completed: 1, total: 1,
                results: [{ platform: 'tiktok', success: !upFail, message: upFail ? 'TikTok rejected the video.' : 'ok' }] });
            }
            return send(200, { request_id: 'upreq_1', status: 'in_progress', completed: 0, total: 1, results: [] });
          }

          // long-lived token exchange
          if (p === '/v19.0/oauth/access_token') {
            if (u.searchParams.get('grant_type') !== 'fb_exchange_token') return gerr('bad grant');
            if (u.searchParams.get('client_secret') !== 'appsecret') return gerr('Invalid app secret.');
            if (u.searchParams.get('fb_exchange_token') !== 'SHORT_USER_TOKEN') return gerr('Invalid OAuth access token.');
            return send(200, { access_token: 'LONG_USER_TOKEN', token_type: 'bearer', expires_in: 5183944 });
          }
          // the user's pages
          if (p === '/v19.0/me/accounts') {
            if (tok !== 'LONG_USER_TOKEN') return gerr('Invalid OAuth access token.');
            return send(200, {
              data: [
                { id: 'pagea', name: 'Grace Chapel', access_token: PAGE_TOKENS.pagea,
                  picture: { data: { url: origin + '/avatar.png' } },
                  instagram_business_account: { id: 'ig777', username: 'gracechapel', profile_picture_url: origin + '/avatar.png' } },
                { id: 'pageb', name: 'Grace Youth', access_token: PAGE_TOKENS.pageb,
                  picture: { data: { url: origin + '/avatar.png' } } },
              ],
              paging: {},
            });
          }
          // IG processing status
          if (p === '/v19.0/igc_1' && /^status_code/.test(u.searchParams.get('fields') || '')) {
            igStatusCalls++;
            return send(200, { status_code: igStatusCalls >= igStatusCallsUntilDone ? 'FINISHED' : 'IN_PROGRESS' });
          }
          if (p === '/v19.0/igc_img' && /^status_code/.test(u.searchParams.get('fields') || '')) {
            return send(200, { status_code: 'FINISHED' }); // photos process near-instantly
          }
          // a staged (unpublished) Page VIDEO → the CDN link Instagram fetches
          if (/^\/v19\.0\/vid_[a-z]+_\d+$/.test(p) && /status|source/.test(u.searchParams.get('fields') || '')) {
            if (tok !== PAGE_TOKENS.pagea && tok !== PAGE_TOKENS.pageb) return gerr('Invalid OAuth access token.');
            return send(200, { status: { video_status: 'ready' }, source: origin + '/cdn/' + p.slice('/v19.0/'.length) + '.mp4' });
          }
          // the container made from that link
          if (p === '/v19.0/igc_url' && /^status_code/.test(u.searchParams.get('fields') || '')) {
            return igVideoProcessingBroken
              ? send(200, { status_code: 'ERROR', status: 'Error: Media upload has failed with error code 2207076' })
              : send(200, { status_code: 'FINISHED' });
          }
          // IG permalink
          if (p === '/v19.0/igmedia_9' && u.searchParams.get('fields') === 'permalink') {
            return send(200, { permalink: 'https://www.instagram.com/reel/ABC123/' });
          }
          if (p === '/v19.0/igmedia_url' && u.searchParams.get('fields') === 'permalink') {
            return send(200, { permalink: 'https://www.instagram.com/reel/VIAURL/' });
          }
          if (p === '/v19.0/igmedia_77' && u.searchParams.get('fields') === 'permalink') {
            return send(200, { permalink: 'https://www.instagram.com/p/PHOTO123/' });
          }
          // staged (unpublished) Page photo → its CDN renditions, largest first
          if (/^\/v19\.0\/ph_\d+$/.test(p) && u.searchParams.get('fields') === 'images') {
            if (tok !== PAGE_TOKENS.pagea && tok !== PAGE_TOKENS.pageb) return gerr('Invalid OAuth access token.');
            const phId = p.slice('/v19.0/'.length);
            return send(200, { images: [
              { source: origin + '/cdn/' + phId + '_1080.jpg', width: 1080, height: 1350 },
              { source: origin + '/cdn/' + phId + '_320.jpg', width: 320, height: 400 },
            ] });
          }
          // node lookups (health checks / testFacebook)
          if (p === '/v19.0/pagea') return tok === PAGE_TOKENS.pagea ? send(200, { id: 'pagea', name: 'Grace Chapel' }) : gerr('Invalid OAuth access token.');
          if (p === '/v19.0/pageb') return tok === PAGE_TOKENS.pageb ? send(200, { id: 'pageb', name: 'Grace Youth' }) : gerr('Invalid OAuth access token.');
          if (p === '/v19.0/ig777') return tok === PAGE_TOKENS.pagea ? send(200, { id: 'ig777', username: 'gracechapel' }) : gerr('Invalid OAuth access token.');
          return gerr('Unknown GET ' + p);
        }

        if (req.method === 'DELETE') {
          // tidying a staging upload away again
          entry.fields = Object.fromEntries(u.searchParams.entries());
          received.push(entry);
          if (/^\/v19\.0\/vid_[a-z]+_\d+$/.test(p)) return send(200, { success: true });
          return gerr('Unknown DELETE ' + p);
        }

        // ---- POST / PUT ----
        const ct = req.headers['content-type'] || '';
        if (ct.startsWith('multipart/form-data')) {
          const boundary = (ct.match(/boundary=(.+)$/) || [])[1];
          Object.assign(entry, parseMultipart(body, boundary));
        } else if (ct.startsWith('application/x-www-form-urlencoded')) {
          entry.fields = Object.fromEntries(new URLSearchParams(body.toString()).entries());
        } else if (ct.includes('application/json')) {
          try { entry.fields = JSON.parse(body.toString()); } catch (e) {}
        } else {
          entry.fileBytes = body; // raw binary (rupload / YT session)
        }
        received.push(entry);
        // Meta's edge, and only Meta's edge: too big is too big.
        if (p.startsWith('/v19.0/') && body.length > fbMaxBody) {
          res.statusCode = 413;
          res.setHeader('content-type', 'text/html');
          return res.end('<html><head><title>Request Entity Too Large</title></head><body></body></html>');
        }
        const tok = entry.fields.access_token;
        const bearer = req.headers.authorization || '';

        // "Google" token endpoint (auth-code + PKCE, and refresh)
        if (p === '/token') {
          const f = entry.fields;
          if (f.grant_type === 'authorization_code') {
            const hash = crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url');
            flags.pkceOk = !!flags.ytChallenge && hash === flags.ytChallenge;
            if (f.code !== 'GOODCODE' || f.client_id !== 'ytclient' || f.client_secret !== 'ytsecret') return send(400, { error: 'invalid_grant', error_description: 'Bad authorization code.' });
            if (!flags.pkceOk) return send(400, { error: 'invalid_grant', error_description: 'PKCE verification failed.' });
            return send(200, { access_token: 'YT_ACCESS', refresh_token: 'YT_REFRESH', expires_in: 3599 });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'YT_REFRESH') return send(400, { error: 'invalid_grant', error_description: 'Token has been revoked.' });
            return send(200, { access_token: 'YT_ACCESS_R', expires_in: 3599 });
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        // "TikTok" token endpoint (auth-code with HEX PKCE, and refresh)
        if (p === '/v2/oauth/token/') {
          const f = entry.fields;
          if (f.grant_type === 'authorization_code') {
            const hexHash = crypto.createHash('sha256').update(f.code_verifier || '').digest('hex');
            flags.tkPkceOk = !!flags.tkChallenge && hexHash === flags.tkChallenge;
            if (f.code !== 'TKCODE' || f.client_key !== 'tkkey' || f.client_secret !== 'tksecret') return send(400, { error: 'invalid_grant', error_description: 'Authorization code is invalid.' });
            if (!flags.tkPkceOk) return send(400, { error: 'invalid_request', error_description: 'PKCE verification failed.' });
            return send(200, { access_token: 'TK_ACCESS', refresh_token: 'TK_REFRESH', open_id: 'tkuser1', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish', token_type: 'Bearer' });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'TK_REFRESH' || f.client_key !== 'tkkey') return send(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid.' });
            return send(200, { access_token: 'TK_ACCESS_R', refresh_token: 'TK_REFRESH', open_id: 'tkuser1', expires_in: 86400 });
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        // Path A: the serverless token proxy (Cloudflare Worker). It injects the
        // client secret ITSELF — so the caller must NOT send one — and returns
        // TikTok's token JSON. Mirrors worker/tiktok-token-proxy/src/index.js.
        if (p === '/tkproxy/token') {
          const f = entry.fields; // JSON body
          flags.tkProxySawSecret = !!(f.client_secret || f.client_key); // must stay false
          flags.tkProxyAppToken = req.headers['x-app-token'] || '';
          if (f.grant_type === 'authorization_code') {
            const hexHash = crypto.createHash('sha256').update(f.code_verifier || '').digest('hex');
            flags.tkProxyPkceOk = !!flags.tkChallenge && hexHash === flags.tkChallenge;
            if (f.code !== 'TKCODE') return send(400, { error: 'invalid_grant', error_description: 'Authorization code is invalid.' });
            if (!flags.tkProxyPkceOk) return send(400, { error: 'invalid_request', error_description: 'PKCE verification failed.' });
            return send(200, { access_token: 'TK_ACCESS', refresh_token: 'TK_REFRESH', open_id: 'tkuser1', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish', token_type: 'Bearer' });
          }
          if (f.grant_type === 'refresh_token') {
            if (f.refresh_token !== 'TK_REFRESH') return send(400, { error: 'invalid_grant', error_description: 'The refresh token is invalid.' });
            return send(200, { access_token: 'TK_ACCESS_R', refresh_token: 'TK_REFRESH', open_id: 'tkuser1', expires_in: 86400 });
          }
          return send(400, { error: 'unsupported_grant_type' });
        }
        // "Upload-Post" — create profile / generate linking JWT / one-shot upload
        if (p === '/api/uploadposts/users' && req.method === 'POST') {
          if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
          const uname = entry.fields.username;
          if (!uname) return send(400, { success: false, message: 'username is required' });
          if (upProfiles.some((x) => x.username === uname)) return send(409, { success: false, message: 'Profile already exists' });
          const prof = { username: uname, created_at: new Date().toISOString(), social_accounts: {} };
          upProfiles.push(prof);
          return send(201, { success: true, profile: prof });
        }
        if (p === '/api/uploadposts/users/generate-jwt') {
          if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
          if (!upProfiles.some((x) => x.username === entry.fields.username)) return send(404, { success: false, message: 'Profile not found' });
          return send(200, { success: true, access_url: origin + '/up/connect?u=' + encodeURIComponent(entry.fields.username), duration: '48h' });
        }
        if (p === '/api/upload') {
          if (bearer !== 'Apikey ' + UP_KEY) return send(401, { success: false, message: 'Invalid API key' });
          if (upLimit) return send(402, { success: false, message: 'Monthly upload limit reached (10/10). Upgrade your plan to continue.' });
          const f = entry.fields;
          if (!f.user || f['platform[]'] !== 'tiktok' || !entry.fileBytes) return send(400, { success: false, message: 'user, platform[] and video are required' });
          if (!upProfiles.some((x) => x.username === f.user && x.social_accounts.tiktok)) {
            return send(400, { success: false, message: 'No tiktok account linked for this profile' });
          }
          if (upAsync) return send(200, { success: true, message: 'Upload initiated successfully in background.', request_id: 'upreq_1', total_platforms: 1 });
          if (upFail) return send(200, { success: true, results: { tiktok: { success: false, error: 'TikTok rejected the video.' } } });
          return send(200, { success: true,
            results: { tiktok: { success: true, url: 'https://www.tiktok.com/@gracetok/video/74001', post_id: '74001', video_was_transcoded: false } },
            usage: { uploads_this_month: 1, plan: 'free' } });
        }

        // "Zernio" — presign an upload URL, receive the bytes (PUT), create the post
        if (p === '/zo/v1/media/presign') {
          if (!zoWsOf(bearer)) return send(401, { error: 'Invalid API key' });
          if (zoLimit) return send(402, { error: 'Plan limit reached. Upgrade to add more accounts.' });
          return send(200, { uploadUrl: origin + '/zo/upload/u1', publicUrl: origin + '/zo/cdn/u1.mp4' });
        }
        if (p === '/zo/upload/u1') {
          if (req.method !== 'PUT') return send(400, { error: 'PUT required' });
          zoUploads.u1 = entry.fileBytes || Buffer.alloc(0);
          return send(200, {});
        }
        if (p === '/zo/v1/posts' && req.method === 'POST') {
          if (!zoWsOf(bearer)) return send(401, { error: 'Invalid API key' });
          if (zoLimit) return send(402, { error: 'Monthly plan limit reached. Upgrade to continue.' });
          const f = entry.fields;
          const plat = Array.isArray(f.platforms) ? f.platforms[0] : null;
          const item = Array.isArray(f.mediaItems) ? f.mediaItems[0] : null;
          if (!plat || !plat.accountId) return send(400, { error: 'platforms[].accountId is required' });
          // Media is OPTIONAL (Facebook text-only) but, when present, must be an uploaded Zernio URL.
          if (item && !/\/zo\/cdn\//.test(item.url || '')) return send(400, { error: 'mediaItems[].url must be an uploaded media URL' });
          if (plat.platform === 'youtube') {
            const ys = f.youtubeSettings || {};
            if (!item || ys.visibility !== 'public' || !ys.title) return send(400, { error: 'YouTube requires a video + title + public visibility' });
            return send(200, { id: 'zopost_2', status: 'published',
              platforms: [{ platform: 'youtube', status: 'published', postUrl: 'https://www.youtube.com/watch?v=YT99', postId: 'YT99' }] });
          }
          if (plat.platform === 'facebook') {
            // Facebook accepts text-only, photo, or video.
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
          if (ts.privacy_level !== 'PUBLIC_TO_EVERYONE' || ts.content_preview_confirmed !== true || ts.express_consent_given !== true) {
            return send(400, { error: 'TikTok requires public privacy + consent flags' });
          }
          if (zoFail) return send(200, { id: 'zopost_1', status: 'failed', platforms: [{ platform: 'tiktok', status: 'failed', error: 'TikTok rejected the video.' }] });
          if (zoAsync) return send(200, { id: 'zopost_1', status: 'processing', platforms: [{ platform: 'tiktok', status: 'processing' }] });
          return send(200, { id: 'zopost_1', status: 'published',
            platforms: [{ platform: 'tiktok', status: 'published', postUrl: 'https://www.tiktok.com/@gracetok/video/99001', postId: '99001' }] });
        }

        // TikTok creator info (must be queried before every direct post)
        if (p === '/v2/post/publish/creator_info/query/') {
          if (bearer !== 'Bearer TK_ACCESS' && bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          return send(200, { data: { creator_username: 'gracechapeltok', creator_nickname: 'Grace TikTok', privacy_level_options: tkPrivacyOptions, comment_disabled: false, duet_disabled: false, stitch_disabled: false, max_video_post_duration_sec: 600 }, error: { code: 'ok', message: '' } });
        }
        // TikTok direct post: init → PUT chunks → status poll
        if (p === '/v2/post/publish/video/init/') {
          if (bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          const si = entry.fields.source_info || {};
          if (si.source !== 'FILE_UPLOAD' || !si.video_size || !si.chunk_size || !si.total_chunk_count) {
            return send(400, { error: { code: 'invalid_params', message: 'Bad source_info.' } });
          }
          tkParts = [];
          tkInitCount++;
          return send(200, { data: { publish_id: 'tkpub_' + tkInitCount, upload_url: origin + '/tk/upload' }, error: { code: 'ok', message: '' } });
        }
        if (p === '/tk/upload') {
          const cr = (entry.headers['content-range'] || '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
          if (req.method !== 'PUT' || !cr) return send(400, { error: { code: 'invalid_params', message: 'Bad Content-Range.' } });
          tkParts.push({ start: +cr[1], buf: entry.fileBytes || Buffer.alloc(0) });
          return send(+cr[2] === +cr[3] - 1 ? 201 : 206, {});
        }
        if (p === '/v2/post/publish/status/fetch/') {
          if (bearer !== 'Bearer TK_ACCESS_R') return send(401, { error: { code: 'access_token_invalid', message: 'The access token is invalid.' } });
          if (!/^tkpub_/.test(entry.fields.publish_id || '')) return send(400, { error: { code: 'invalid_params', message: 'Unknown publish_id.' } });
          tkStatusCalls++;
          if (tkStatusCalls >= tkStatusCallsUntilDone) {
            return send(200, { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['73001'] }, error: { code: 'ok', message: '' } });
          }
          return send(200, { data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok', message: '' } });
        }
        // YouTube resumable upload: init session → PUT bytes
        if (p === '/upload/youtube/v3/videos') {
          if (bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
          res.setHeader('location', origin + '/upload/yt1');
          return send(200, {});
        }
        if (p === '/upload/yt1') {
          if (bearer !== 'Bearer YT_ACCESS_R') return send(401, { error: { message: 'Invalid Credentials' } });
          return send(200, { id: 'ytvid123', status: { uploadStatus: 'uploaded' } });
        }

        // IG resumable upload target
        if (p === '/rupload/igc_1') {
          if (entry.headers.authorization !== 'OAuth ' + PAGE_TOKENS.pagea) return gerr('Bad upload auth.');
          if (igRuploadBroken) {
            return send(500, { debug_info: { retriable: false, type: 'ProcessingFailedError', message: '{"success":false,"error":{"message":"unknown error"}}' } });
          }
          return send(200, { success: true });
        }
        // IG media container (resumable REELS, or a feed photo via image_url)
        if (p === '/v19.0/ig777/media') {
          if (tok !== PAGE_TOKENS.pagea) return gerr('Invalid OAuth access token.');
          if (entry.fields.image_url) {
            // Like the real API: the URL must be publicly fetchable (our staged CDN link).
            if (!entry.fields.image_url.includes('/cdn/ph_')) return gerr('Media download from URI failed.');
            return send(200, { id: 'igc_img' });
          }
          if (entry.fields.video_url) {
            // the staged-link route: the URL has to be one Instagram could fetch
            if (!entry.fields.video_url.includes('/cdn/vid_')) return gerr('Media download from URI failed.');
            if (entry.fields.media_type !== 'REELS') return gerr('Bad container request.');
            return send(200, { id: 'igc_url' });
          }
          if (entry.fields.media_type !== 'REELS' || entry.fields.upload_type !== 'resumable') return gerr('Bad container request.');
          return send(200, { id: 'igc_1', uri: origin + '/rupload/igc_1' });
        }
        if (p === '/v19.0/ig777/media_publish') {
          if (tok !== PAGE_TOKENS.pagea) return gerr('Invalid OAuth access token.');
          if (entry.fields.creation_id === 'igc_img') return send(200, { id: 'igmedia_77' });
          if (entry.fields.creation_id === 'igc_url') return send(200, { id: 'igmedia_url' });
          if (entry.fields.creation_id !== 'igc_1') return gerr('Unknown creation id.');
          return send(200, { id: 'igmedia_9' });
        }
        // FB page publishing
        const m = p.match(/^\/v19\.0\/(page[ab])\/(photos|videos|feed)$/);
        if (m) {
          if (tok !== PAGE_TOKENS[m[1]]) return gerr('Invalid OAuth access token.');
          if (m[2] === 'videos') {
            const phase = entry.fields.upload_phase;
            if (phase === 'start' && fbSessionsOn) {
              const size = Number(entry.fields.file_size) || 0;
              const sid = 'ses_' + (++fbSesN);
              fbSessions[sid] = {
                size, got: 0, page: m[1], sha: crypto.createHash('sha256'),
                videoId: `vid_${m[1]}_${fbSesN}`,
              };
              return send(200, {
                video_id: fbSessions[sid].videoId, upload_session_id: sid,
                start_offset: '0', end_offset: String(Math.min(fbChunkBytes, size)),
              });
            }
            if (phase === 'transfer') {
              const ses = fbSessions[entry.fields.upload_session_id];
              if (!ses) return gerr('Unknown upload session.');
              const off = Number(entry.fields.start_offset);
              const chunk = entry.fileBytes || Buffer.alloc(0);
              entry.chunkLen = chunk.length;
              entry.fileBytes = null; // a 350MB sermon must not sit in RAM twice
              if (off > ses.got) return gerr('Offset ' + off + ' skips ahead of ' + ses.got + '.');
              if (off === ses.got) { ses.sha.update(chunk); ses.got += chunk.length; }
              // off < ses.got: those bytes are already banked, so answer with
              // where we are — exactly as Facebook does when a reply is lost.
              if (fbDropReplyAt >= 0 && ses.got >= fbDropReplyAt) {
                fbDropReplyAt = -1;    // once only
                res.socket.destroy(); // the church uplink eats the answer
                return;
              }
              return send(200, {
                start_offset: String(ses.got),
                end_offset: String(Math.min(ses.got + fbChunkBytes, ses.size)),
              });
            }
            if (phase === 'finish') {
              const ses = fbSessions[entry.fields.upload_session_id];
              if (!ses) return gerr('Unknown upload session.');
              if (ses.got !== ses.size) return gerr('Session finished at ' + ses.got + ' of ' + ses.size + '.');
              ses.digest = ses.sha.digest('hex');
              ses.description = entry.fields.description;
              ses.published = entry.fields.published;
              ses.finished = true;
              return send(200, { success: true });
            }
            return send(200, { id: `vid_${m[1]}_${received.length}` });
          }
          if (m[2] === 'photos') return send(200, { id: `ph_${received.length}`, post_id: `${m[1]}_post_${received.length}` });
          return send(200, { id: `feed_${m[1]}_${received.length}` });
        }
        return gerr('Unknown POST ' + p);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      origin = `http://127.0.0.1:${server.address().port}`;
      const fb = {
        sessions: fbSessions,
        get maxBody() { return fbMaxBody; }, set maxBody(v) { fbMaxBody = v; },
        get sessionsOn() { return fbSessionsOn; }, set sessionsOn(v) { fbSessionsOn = v; },
        get chunkBytes() { return fbChunkBytes; }, set chunkBytes(v) { fbChunkBytes = v; },
        set dropReplyAt(v) { fbDropReplyAt = v; },
        last() { const k = Object.keys(fbSessions); return fbSessions[k[k.length - 1]]; },
      };
      resolve({ server, origin, graph: origin + '/v19.0', flags, fb });
    });
  });
}

const PHASE_PARTS = { start: 1, transfer: 1 };
const countUploads = (pathname) => received.filter((r) => r.url === pathname && r.method === 'POST'
  && !(r.fields && PHASE_PARTS[r.fields.upload_phase])).length;

/** Plays the part of the user's browser: GET a URL and follow redirects. */
function httpFollow(urlStr, hops = 3) {
  return new Promise((resolve, reject) => {
    http.get(urlStr, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(httpFollow(new URL(res.headers.location, urlStr).toString(), hops - 1));
      }
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

/* ----------------------------------- tests ----------------------------------- */

(async () => {
  console.log('== SOCIAL ACCOUNTS / MULTI-ACCOUNT AUTO-POST TEST ==');
  const { server, origin, graph, flags, fb } = await startMockMeta();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-social-'));

  const photo = path.join(tmp, 'flyer.png');
  // a real (small) PNG flyer: Zernio routes turn it into a JPEG / a Short with ffmpeg
  { const ff = require('../src/main/ffmpeg');
    require('child_process').execFileSync(ff.resolveFfmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'color=0x6a2bd9:s=320x400', '-frames:v', '1', '-y', photo]); }
  const videoF = path.join(tmp, 'sermon.mp4');
  fs.writeFileSync(videoF, Buffer.alloc(64 * 1024, 5)); // 64KB "video"

  function makeStore(extraSettings = {}) {
    return new Store(path.join(tmp, 'store-' + Date.now() + Math.random().toString(36).slice(2) + '.json'), {
      settings: { accounts: {
        fbAppId: 'app123', fbAppSecret: 'appsecret', fbApiBase: graph, fbOauthBase: origin,
        ytClientId: 'ytclient', ytClientSecret: 'ytsecret',
        ytAuthBase: origin + '/o/oauth2/v2/auth', ytTokenBase: origin + '/token', ytApiBase: origin,
        tkClientKey: 'tkkey', tkClientSecret: 'tksecret',
        tkAuthBase: origin, tkApiBase: origin, tkRedirectUri: origin + '/tk/callback',
        upApiKey: UP_KEY, upApiBase: origin + '/api',
        zoApiKey: ZO_KEY, zoApiBase: origin + '/zo/v1', zoRedirectUrl: origin + '/zo/connected',
        ...extraSettings } },
      posts: [], socialAccounts: [],
    });
  }

  /* === [A] account linking === */
  const long = await exchangeLongLived({ graphBase: graph, appId: 'app123', appSecret: 'appsecret', token: 'SHORT_USER_TOKEN' });
  check('[A] short user token exchanged for long-lived token', long === 'LONG_USER_TOKEN', long);

  const pages = await listPages({ graphBase: graph, userToken: long });
  check('[A] both Pages listed with tokens', pages.length === 2 && pages[0].token === 'PAGETOK_A' && pages[1].token === 'PAGETOK_B', JSON.stringify(pages.map((p) => p.pageId)));
  check('[A] Instagram Business account found on its Page', pages[0].ig && pages[0].ig.igUserId === 'ig777' && pages[0].ig.username === 'gracechapel');

  const ava = await fetchAvatarDataUri(origin + '/avatar.png');
  check('[A] avatar downloads as a data URI', ava.startsWith('data:image/png;base64,') && Buffer.from(ava.split(',')[1], 'base64').equals(AVATAR));

  const store = makeStore();
  const accounts = new Accounts(store);
  // Inject the token capture (the real OAuth window is exercised by the UI test).
  const conn = await accounts.connectFacebook(null, { capture: async () => ({ token: 'SHORT_USER_TOKEN' }) });
  check('[A] connect flow returns pages for the picker', conn.connectId && conn.pages.length === 2);
  check('[A] picker payload has NO tokens (renderer-safe)', !JSON.stringify(conn.pages).includes('PAGETOK'));
  check('[A] picker payload has inline avatars', conn.pages[0].picture.startsWith('data:image/'));

  const added = accounts.addFromConnect(conn.connectId, [
    { type: 'facebook', pageId: 'pagea' },
    { type: 'instagram', pageId: 'pagea' },
    { type: 'facebook', pageId: 'pageb' },
  ]);
  check('[A] 3 accounts connected (2 FB Pages + 1 IG)', added.length === 3 && accounts.all().length === 3);
  check('[A] stored records carry the right tokens', accounts.byId('fb_pagea').token === 'PAGETOK_A'
    && accounts.byId('fb_pageb').token === 'PAGETOK_B' && accounts.byId('ig_ig777').token === 'PAGETOK_A');
  check('[A] IG account remembers its user id + name', accounts.byId('ig_ig777').igUserId === 'ig777' && accounts.byId('ig_ig777').name === '@gracechapel');
  check('[A] list() for the UI hides tokens', !JSON.stringify(accounts.list()).includes('PAGETOK'));

  const health = await accounts.check('fb_pagea');
  check('[A] health check confirms the Page by name', health.ok && health.name === 'Grace Chapel');

  // reconnect must NOT duplicate
  const conn2 = await accounts.connectFacebook(null, { capture: async () => ({ token: 'SHORT_USER_TOKEN' }) });
  accounts.addFromConnect(conn2.connectId, [{ type: 'facebook', pageId: 'pagea' }]);
  check('[A] reconnecting the same Page updates instead of duplicating', accounts.all().length === 3);

  /* === [B] Instagram Reels publisher === */
  igStatusCallsUntilDone = 3; igStatusCalls = 0; // exercise the IN_PROGRESS → FINISHED poll
  const igRes = await publisher.publishToInstagram(
    { igUserId: 'ig777', token: 'PAGETOK_A', apiBase: graph },
    { caption: 'Sunday highlights! 🙌', mediaPaths: [videoF] },
    { pollMs: 40 });
  check('[B] Reel published after processing finished', igRes.id === 'igmedia_9' && igStatusCalls >= 3, JSON.stringify(igRes));
  check('[B] permalink returned for View post', igRes.url === 'https://www.instagram.com/reel/ABC123/');
  const igContainer = received.find((r) => r.url === '/v19.0/ig777/media');
  check('[B] container asked for a resumable REELS upload with the caption',
    igContainer && igContainer.fields.caption === 'Sunday highlights! 🙌');
  const igUp = received.find((r) => r.url === '/rupload/igc_1');
  check('[B] raw video bytes round-trip EXACTLY (64KB streamed)', igUp && igUp.fileBytes && igUp.fileBytes.equals(fs.readFileSync(videoF)));
  check('[B] upload sent OAuth header + exact file_size', igUp && igUp.headers.authorization === 'OAuth PAGETOK_A'
    && igUp.headers.file_size === String(fs.statSync(videoF).size) && igUp.headers.offset === '0');

  /* === [B] Instagram feed photo: staged on the Page → image_url container → published === */
  const beforeIgPhoto = received.length;
  const igPhoto = await publisher.publishToInstagram(
    { igUserId: 'ig777', pageId: 'pagea', token: 'PAGETOK_A', apiBase: graph },
    { caption: 'New flyer! 🎉', mediaPaths: [photo] }, { pollMs: 10 });
  check('[B] IG photo published with a permalink',
    igPhoto.id === 'igmedia_77' && igPhoto.url === 'https://www.instagram.com/p/PHOTO123/', JSON.stringify(igPhoto));
  const staged = received.slice(beforeIgPhoto).find((r) => r.url === '/v19.0/pagea/photos');
  check('[B] photo staged on the Page UNPUBLISHED + temporary (never shows on the Page)',
    !!staged && staged.fields.published === 'false' && staged.fields.temporary === 'true', staged && JSON.stringify(staged.fields));
  check('[B] staged photo bytes round-trip EXACTLY',
    staged && staged.fileBytes && staged.fileBytes.equals(fs.readFileSync(photo)));
  const igImgContainer = received.slice(beforeIgPhoto).find((r) => r.url === '/v19.0/ig777/media' && r.fields.image_url);
  check('[B] container got the staged CDN image_url + the caption',
    igImgContainer && /\/cdn\/ph_\d+_1080\.jpg$/.test(igImgContainer.fields.image_url)
    && igImgContainer.fields.caption === 'New flyer! 🎉', igImgContainer && igImgContainer.fields.image_url);

  let igNoMediaErr = null;
  try {
    await publisher.publishToInstagram({ igUserId: 'ig777', pageId: 'pagea', token: 'PAGETOK_A', apiBase: graph },
      { caption: 'x', mediaPaths: [] }, { pollMs: 10 });
  } catch (e) { igNoMediaErr = e.message; }
  check('[B] IG text-only still gives a clear "needs a photo or video" error', /photo or video/i.test(igNoMediaErr || ''), igNoMediaErr);

  /* === [C] scheduler fans one post out to all 3 accounts === */
  igStatusCallsUntilDone = 1; igStatusCalls = 0;
  const notifications = [];
  const notify = (title, bodyTxt, id) => notifications.push({ title, body: bodyTxt, id });
  const s1 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const fan = s1.add({
    title: 'Sunday sermon', caption: 'Watch now! ✨', platforms: ['tiktok'],
    accountIds: ['fb_pagea', 'fb_pageb', 'ig_ig777'],
    mediaPaths: [videoF], scheduledAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });
  s1.start();
  await sleep(1200);
  s1.stop();
  let f = s1.list().find((p) => p.id === fan.id);
  check('[C] post AUTO-POSTED to all 3 accounts', f.status === 'posted' && f.autoPosted === true, f.status + ' ' + (f.error || ''));
  check('[C] per-account results recorded (FB A)', f.results.fb_pagea && f.results.fb_pagea.ok && /vid_pagea/.test(f.results.fb_pagea.id), JSON.stringify(f.results.fb_pagea));
  check('[C] per-account results recorded (FB B)', f.results.fb_pageb && f.results.fb_pageb.ok && /vid_pageb/.test(f.results.fb_pageb.id));
  check('[C] per-account results recorded (IG Reel)', f.results.ig_ig777 && f.results.ig_ig777.ok && f.results.ig_ig777.id === 'igmedia_9');
  check('[C] each FB Page uploaded exactly once', countUploads('/v19.0/pagea/videos') === 1 && countUploads('/v19.0/pageb/videos') === 1);
  const note = notifications.find((n) => n.title.includes('✅'));
  check('[C] success notification names the accounts + leftover platform',
    !!note && /Grace Chapel/.test(note.body) && /tiktok/.test(note.body), note && note.body);

  /* === [C] partial failure: only the broken account retries === */
  igStatusCalls = 0;
  const beforeA = countUploads('/v19.0/pagea/photos');
  // Break Page B's stored token (as if Facebook revoked it).
  store.set('socialAccounts', accounts.all().map((a) => a.id === 'fb_pageb' ? { ...a, token: 'REVOKED' } : a));
  let fakeNow = Date.now();
  const s2 = new Scheduler(store, () => null, { notify, intervalMs: 120, now: () => fakeNow, accounts });
  const part = s2.add({
    title: 'Youth night flyer', caption: 'Friday 7pm 🎉', platforms: [],
    accountIds: ['fb_pagea', 'fb_pageb'],
    mediaPaths: [photo], scheduledAt: new Date(fakeNow - 1000).toISOString(),
  });
  s2.start();
  await sleep(600);
  let pp = s2.list().find((p) => p.id === part.id);
  check('[C] partial failure: still scheduled with backoff after attempt 1', pp.status === 'scheduled' && pp.attempts === 1 && !!pp.nextAttemptAt, JSON.stringify({ s: pp.status, a: pp.attempts }));
  check('[C] the good account SUCCEEDED and is recorded', pp.results.fb_pagea && pp.results.fb_pagea.ok === true);
  check('[C] the broken account failed with Facebook\'s reason', pp.results.fb_pageb && pp.results.fb_pageb.ok === false && /Invalid OAuth/.test(pp.results.fb_pageb.error));
  check('[C] post-level error names the failing account', /Grace Youth/.test(pp.error || ''), pp.error);

  // Fix the token → jump past backoff → ONLY Page B posts (A never re-posts).
  store.set('socialAccounts', accounts.all().map((a) => a.id === 'fb_pageb' ? { ...a, token: 'PAGETOK_B' } : a));
  fakeNow += 2 * 60 * 1000;
  await sleep(600);
  s2.stop();
  pp = s2.list().find((p) => p.id === part.id);
  check('[C] after fixing the token the post completes', pp.status === 'posted' && pp.results.fb_pageb.ok === true, pp.status + ' ' + (pp.error || ''));
  check('[C] the already-posted account was NOT posted twice', countUploads('/v19.0/pagea/photos') === beforeA + 1, String(countUploads('/v19.0/pagea/photos')));

  /* === [C] scheduler posts a PHOTO to Instagram (pageId flows through publishTo) === */
  const sIg = new Scheduler(store, () => null, { notify, intervalMs: 120, accounts });
  const igPhotoPost = sIg.add({
    title: 'IG flyer', caption: 'Sunday 10am 🙏', platforms: [],
    accountIds: ['ig_ig777'],
    mediaPaths: [photo], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  sIg.start();
  await sleep(700);
  sIg.stop();
  const igp = sIg.list().find((p) => p.id === igPhotoPost.id);
  check('[C] scheduled IG photo post AUTO-PUBLISHED', igp.status === 'posted' && igp.results.ig_ig777 && igp.results.ig_ig777.ok === true,
    igp.status + ' ' + (igp.error || ''));
  check('[C] IG photo result carries the media id + permalink',
    igp.results.ig_ig777.id === 'igmedia_77' && igp.results.ig_ig777.url === 'https://www.instagram.com/p/PHOTO123/',
    JSON.stringify(igp.results.ig_ig777));

  /* === [D] platform matching + reminders + legacy === */
  // No accountIds picked, but platforms include facebook → all linked FB accounts match.
  const s3 = new Scheduler(store, () => null, { notify, intervalMs: 120, accounts });
  const matched = s3.add({
    title: 'Announcement', caption: 'Service moved to 11am.', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s3.start(); await sleep(600); s3.stop();
  const mp = s3.list().find((p) => p.id === matched.id);
  check('[D] platform-matched post hit BOTH linked FB Pages (text → /feed)',
    mp.status === 'posted' && mp.results.fb_pagea.ok && mp.results.fb_pageb.ok, JSON.stringify(mp.results));

  // Unlinked platform → reminder flow.
  const s4 = new Scheduler(store, () => null, { notify, intervalMs: 120, accounts });
  const rem = s4.add({
    title: 'TikTok clip', caption: 'x', platforms: ['tiktok'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s4.start(); await sleep(400); s4.stop();
  const rp = s4.list().find((p) => p.id === rem.id);
  check('[D] unlinked platform still gets the reminder flow', rp.status === 'scheduled' && rp.notified === true && !rp.autoPosted);

  // Legacy manual Page ID + token (no linked accounts at all).
  const legacyStore = makeStore({ fbPageId: 'pagea', fbToken: 'PAGETOK_A' });
  const s5 = new Scheduler(legacyStore, () => null, { notify, intervalMs: 120 });
  const leg = s5.add({
    title: 'Legacy post', caption: 'old faithful', platforms: ['facebook'],
    mediaPaths: [], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s5.start(); await sleep(600); s5.stop();
  const lp = s5.list().find((p) => p.id === leg.id);
  check('[D] legacy Settings token still auto-publishes', lp.status === 'posted' && /feed_pagea/.test(lp.fbPostId || ''), lp.status + ' ' + (lp.error || ''));

  /* === [E] YouTube: Google sign-in → channel connect → resumable upload === */
  const yt = await accounts.connectYouTube(null, { openUrl: (u) => httpFollow(u) });
  check('[E] Google sign-in (loopback) → channel connected', yt.id === 'yt_UCabc123' && yt.platform === 'youtube' && yt.name === 'Grace Chapel Media', JSON.stringify(yt));
  check('[E] PKCE code challenge REALLY verified by "Google"', flags.pkceOk === true);
  check('[E] renderer-safe: no refresh token / client secret returned', !JSON.stringify(yt).includes('YT_REFRESH') && !JSON.stringify(yt).includes('ytsecret'));
  check('[E] stored record holds the refresh token', accounts.byId('yt_UCabc123').token === 'YT_REFRESH');
  check('[E] channel avatar inlined as data URI', (yt.picture || '').startsWith('data:image/'));

  const ytRes = await publisher.publishToYouTube(
    { token: 'YT_REFRESH', clientId: 'ytclient', clientSecret: 'ytsecret' },
    { title: 'Sunday sermon', caption: 'Full service replay', mediaPaths: [videoF] },
    { ytApiBase: origin, ytTokenBase: origin + '/token' });
  check('[E] video uploaded → id + watch URL', ytRes.id === 'ytvid123' && ytRes.url === 'https://www.youtube.com/watch?v=ytvid123', JSON.stringify(ytRes));
  const ytInit = received.find((r) => r.url === '/upload/youtube/v3/videos');
  check('[E] resumable init carried title + description + exact size',
    ytInit && ytInit.fields.snippet && ytInit.fields.snippet.title === 'Sunday sermon'
    && ytInit.fields.snippet.description === 'Full service replay'
    && ytInit.headers['x-upload-content-length'] === String(fs.statSync(videoF).size));
  check('[E] video set public + not made-for-kids', ytInit && ytInit.fields.status && ytInit.fields.status.privacyStatus === 'public' && ytInit.fields.status.selfDeclaredMadeForKids === false);
  const ytUp = received.find((r) => r.url === '/upload/yt1');
  check('[E] raw video bytes round-trip EXACTLY (64KB streamed)', ytUp && ytUp.fileBytes && ytUp.fileBytes.equals(fs.readFileSync(videoF)));
  check('[E] upload used a FRESH access token (refreshed just-in-time)', ytUp && ytUp.headers.authorization === 'Bearer YT_ACCESS_R');

  let ytNoVidErr = null;
  try {
    await publisher.publishToYouTube({ token: 'YT_REFRESH', clientId: 'ytclient', clientSecret: 'ytsecret' },
      { caption: 'text only', mediaPaths: [] }, { ytApiBase: origin, ytTokenBase: origin + '/token' });
  } catch (e) { ytNoVidErr = e.message; }
  check('[E] post without video → clear "needs a video" error', /video/i.test(ytNoVidErr || ''), ytNoVidErr);

  // The grand fan-out: ONE post → 2 FB Pages + Instagram + YouTube.
  igStatusCalls = 99; // IG processing finishes instantly
  const before = { a: countUploads('/v19.0/pagea/videos'), b: countUploads('/v19.0/pageb/videos'), yt: countUploads('/upload/youtube/v3/videos') };
  const s6 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const all4 = s6.add({
    title: 'Grand fan-out', caption: 'Everywhere at once! 🚀', platforms: [],
    accountIds: ['fb_pagea', 'fb_pageb', 'ig_ig777', 'yt_UCabc123'],
    mediaPaths: [videoF], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s6.start();
  await sleep(1500);
  s6.stop();
  const g = s6.list().find((p) => p.id === all4.id);
  check('[E] ONE post fanned out to ALL FOUR accounts', g.status === 'posted'
    && g.results.fb_pagea.ok && g.results.fb_pageb.ok && g.results.ig_ig777.ok && g.results.yt_UCabc123.ok,
    g.status + ' ' + JSON.stringify(Object.entries(g.results || {}).map(([k, v]) => k + ':' + (v.ok || v.error))));
  check('[E] YouTube result carries the watch link', g.results.yt_UCabc123 && g.results.yt_UCabc123.url === 'https://www.youtube.com/watch?v=ytvid123');
  check('[E] fan-out posted each destination exactly once',
    countUploads('/v19.0/pagea/videos') === before.a + 1 && countUploads('/v19.0/pageb/videos') === before.b + 1
    && countUploads('/upload/youtube/v3/videos') === before.yt + 1);

  const ytHealth = await accounts.check('yt_UCabc123');
  check('[E] YouTube health check via refreshed token', ytHealth.ok && ytHealth.name === 'Grace Chapel Media');

  /* === [F] TikTok: login (hex PKCE) → connect → chunked Direct Post === */
  // Plays the part of the TikTok login window: visits the consent page (which
  // records the challenge) and hands back the code — exactly what the real
  // captureTikTokCode window does. The REAL window is driven by the UI test.
  const tkCapture = async ({ authBase, clientKey, redirectUri }) => {
    const verifier = crypto.randomBytes(24).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
    await httpFollow(`${authBase}/v2/auth/authorize/?` + new URLSearchParams({
      client_key: clientKey, redirect_uri: redirectUri, response_type: 'code',
      code_challenge: challenge, code_challenge_method: 'S256',
    }));
    return { code: 'TKCODE', verifier, redirectUri };
  };
  const tk = await accounts.connectTikTok(null, { capture: tkCapture });
  check('[F] TikTok login (code flow) → account connected', tk.id === 'tk_tkuser1' && tk.platform === 'tiktok' && tk.name === 'Grace TikTok', JSON.stringify(tk));
  check('[F] TikTok hex-PKCE challenge REALLY verified by "TikTok"', flags.tkPkceOk === true);
  check('[F] renderer-safe: no refresh token / client secret returned', !JSON.stringify(tk).includes('TK_REFRESH') && !JSON.stringify(tk).includes('tksecret'));
  check('[F] stored record holds the refresh token', accounts.byId('tk_tkuser1').token === 'TK_REFRESH');
  check('[F] @username captured for post links', tk.username === 'gracechapeltok');
  check('[F] avatar inlined as data URI', (tk.picture || '').startsWith('data:image/'));

  // Direct post with the chunk thresholds shrunk so the 64KB file MUST split in two.
  tkStatusCallsUntilDone = 3; tkStatusCalls = 0;
  const tkRes = await publisher.publishToTikTok(
    { token: 'TK_REFRESH', clientKey: 'tkkey', clientSecret: 'tksecret', username: 'gracechapeltok' },
    { title: 'Sunday sermon', caption: 'Watch now! ✨', mediaPaths: [videoF] },
    { tkApiBase: origin, tkMaxSingle: 16 * 1024, tkChunkSize: 24 * 1024, pollMs: 30 });
  check('[F] direct post published after processing', tkRes.id === '73001' && tkStatusCalls >= 3, JSON.stringify(tkRes));
  check('[F] post link points at the @username', tkRes.url === 'https://www.tiktok.com/@gracechapeltok/video/73001');
  const tkInit = received.filter((r) => r.url === '/v2/post/publish/video/init/').pop();
  check('[F] init carried caption as title + exact size + 2 chunks',
    tkInit && tkInit.fields.post_info && tkInit.fields.post_info.title === 'Watch now! ✨'
    && tkInit.fields.source_info.video_size === 64 * 1024 && tkInit.fields.source_info.total_chunk_count === 2,
    tkInit && JSON.stringify(tkInit.fields.source_info));
  check('[F] most public visibility picked (audited app)', tkInit && tkInit.fields.post_info.privacy_level === 'PUBLIC_TO_EVERYONE');
  check('[F] init used a FRESH access token (refreshed just-in-time)', tkInit && tkInit.headers.authorization === 'Bearer TK_ACCESS_R');
  const tkRanges = received.filter((r) => r.url === '/tk/upload').map((r) => r.headers['content-range']);
  check('[F] chunk ranges follow TikTok\'s protocol',
    JSON.stringify(tkRanges) === JSON.stringify(['bytes 0-24575/65536', 'bytes 24576-65535/65536']), JSON.stringify(tkRanges));
  check('[F] chunked bytes reassemble EXACTLY (64KB in 2 chunks)', tkAssembled().equals(fs.readFileSync(videoF)));

  // Unaudited app: TikTok only offers SELF_ONLY → the post must fall back to private.
  tkPrivacyOptions = ['SELF_ONLY'];
  tkStatusCallsUntilDone = 1; tkStatusCalls = 0;
  const tkPriv = await publisher.publishToTikTok(
    { token: 'TK_REFRESH', clientKey: 'tkkey', clientSecret: 'tksecret', username: 'gracechapeltok' },
    { caption: 'private until audit', mediaPaths: [videoF] }, { tkApiBase: origin, pollMs: 10 });
  const tkInit2 = received.filter((r) => r.url === '/v2/post/publish/video/init/').pop();
  check('[F] unaudited app falls back to private (SELF_ONLY)', tkInit2.fields.post_info.privacy_level === 'SELF_ONLY' && tkPriv.privacy === 'SELF_ONLY');
  tkPrivacyOptions = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];

  let tkImgErr = null;
  try {
    await publisher.publishToTikTok({ token: 'TK_REFRESH', clientKey: 'tkkey', clientSecret: 'tksecret' },
      { caption: 'x', mediaPaths: [photo] }, { tkApiBase: origin });
  } catch (e) { tkImgErr = e.message; }
  check('[F] a flyer goes to TikTok (made into a 10-second video)', !tkImgErr, tkImgErr);

  /* === [H] TikTok Path A: own app + serverless token proxy (secret never shipped) === */
  const proxyUrl = origin + '/tkproxy/token';
  const proxyStore = makeStore({ tkTokenProxy: proxyUrl, tkProxyToken: 'appguard', tkClientSecret: '' });
  const proxyAccounts = new Accounts(proxyStore);
  flags.tkProxySawSecret = null; flags.tkProxyPkceOk = null; flags.tkProxyAppToken = null;
  const tkA = await proxyAccounts.connectTikTok(null, { capture: tkCapture });
  check('[H] connect via proxy → account created', tkA.id === 'tk_tkuser1' && tkA.platform === 'tiktok', JSON.stringify(tkA));
  check('[H] client secret NEVER sent to the proxy', flags.tkProxySawSecret === false);
  check('[H] proxy really verified the hex PKCE challenge', flags.tkProxyPkceOk === true);
  check('[H] shared app-token guard forwarded to the proxy', flags.tkProxyAppToken === 'appguard');
  const storedA = proxyAccounts.byId('tk_tkuser1');
  check('[H] NO client secret stored on the church machine', !storedA.clientSecret && storedA.tokenProxy === proxyUrl, JSON.stringify({ cs: storedA.clientSecret, tp: storedA.tokenProxy }));
  check('[H] refresh token stored locally', storedA.token === 'TK_REFRESH');
  const safeList = proxyAccounts.list().find((a) => a.id === 'tk_tkuser1');
  check('[H] renderer-safe: token + secret + proxy-token stripped from list()',
    safeList && !('token' in safeList) && !('clientSecret' in safeList) && !('proxyToken' in safeList) && safeList.connected === true);

  // Direct post through the stored proxy — no secret anywhere on the machine.
  tkPrivacyOptions = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];
  tkStatusCallsUntilDone = 1; tkStatusCalls = 0;
  const beforeProxy = received.length;
  const tkARes = await publisher.publishTo(storedA,
    { title: 'Path A sermon', caption: 'via proxy', mediaPaths: [videoF] },
    { tkApiBase: origin, pollMs: 10 });
  check('[H] direct post via proxy published', tkARes.id === '73001', JSON.stringify(tkARes));
  const proxyRefreshHit = received.slice(beforeProxy).some((r) => r.url === '/tkproxy/token' && r.fields.grant_type === 'refresh_token' && !r.fields.client_secret);
  check('[H] refresh routed through the proxy (no secret) at post time', proxyRefreshHit);
  const proxyInit = received.filter((r) => r.url === '/v2/post/publish/video/init/').pop();
  check('[H] post used the proxy-refreshed access token', proxyInit && proxyInit.headers.authorization === 'Bearer TK_ACCESS_R');

  // Guard: proxy set but Client Key missing → a clear setup error (not a crash).
  let noKeyErr = null;
  try {
    await new Accounts(makeStore({ tkTokenProxy: proxyUrl, tkClientKey: '', tkClientSecret: '' }))
      .connectTikTok(null, { capture: tkCapture });
  } catch (e) { noKeyErr = e.message; }
  check('[H] missing Client Key gives a clear error', /Client Key/i.test(noKeyErr || ''), noKeyErr);

  // The grander fan-out: ONE post → 2 FB Pages + Instagram + YouTube + TikTok.
  igStatusCalls = 99;
  tkStatusCallsUntilDone = 1; tkStatusCalls = 0;
  const before5 = {
    a: countUploads('/v19.0/pagea/videos'), b: countUploads('/v19.0/pageb/videos'),
    yt: countUploads('/upload/youtube/v3/videos'), tk: countUploads('/v2/post/publish/video/init/'),
  };
  const s7 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const all5 = s7.add({
    title: 'Everywhere', caption: 'All five at once! 🚀', platforms: [],
    accountIds: ['fb_pagea', 'fb_pageb', 'ig_ig777', 'yt_UCabc123', 'tk_tkuser1'],
    mediaPaths: [videoF], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s7.start();
  await sleep(1800);
  s7.stop();
  const g5 = s7.list().find((p) => p.id === all5.id);
  check('[F] ONE post fanned out to ALL FIVE accounts', g5.status === 'posted'
    && g5.results.fb_pagea.ok && g5.results.fb_pageb.ok && g5.results.ig_ig777.ok && g5.results.yt_UCabc123.ok && g5.results.tk_tkuser1.ok,
    g5.status + ' ' + JSON.stringify(Object.entries(g5.results || {}).map(([k, v]) => k + ':' + (v.ok || v.error))));
  check('[F] TikTok result carries the post link', g5.results.tk_tkuser1 && /@gracechapeltok/.test(g5.results.tk_tkuser1.url || ''));
  check('[F] fan-out posted each destination exactly once',
    countUploads('/v19.0/pagea/videos') === before5.a + 1 && countUploads('/v19.0/pageb/videos') === before5.b + 1
    && countUploads('/upload/youtube/v3/videos') === before5.yt + 1 && countUploads('/v2/post/publish/video/init/') === before5.tk + 1);

  const tkHealth = await accounts.check('tk_tkuser1');
  check('[F] TikTok health check via refreshed token', tkHealth.ok && tkHealth.name === 'Grace TikTok');

  /* === [G] TikTok "easy connect" via Upload-Post (no TikTok developer app) === */
  // Nothing exists on the Upload-Post side yet: the flow must create a profile,
  // open the linking page (openUrl plays the part of the browser), and poll
  // until the user has signed in to TikTok there.
  const easy = await accounts.connectTikTokEasy(null, { openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[G] easy connect: profile created + TikTok linked via the browser page',
    easy.id === 'uptk_church-media' && easy.platform === 'tiktok' && easy.via === 'uploadpost', JSON.stringify(easy));
  check('[G] easy account carries the @handle + display name', easy.username === 'gracetok' && easy.name === 'Grace TikTok Easy');
  check('[G] avatar inlined as data URI', (easy.picture || '').startsWith('data:image/'));
  check('[G] renderer-safe: API key never reaches the UI', !JSON.stringify(easy).includes(UP_KEY) && !JSON.stringify(accounts.list()).includes(UP_KEY));
  check('[G] stored record holds the API key as its token', accounts.byId('uptk_church-media').token === UP_KEY);

  // Reconnecting must reuse the already-linked profile WITHOUT opening a browser.
  const easy2 = await accounts.connectTikTokEasy(null, { openUrl: () => { throw new Error('browser must not open'); } });
  check('[G] reconnect reuses the linked profile (no browser, no duplicate)',
    easy2.id === 'uptk_church-media' && accounts.all().filter((a) => a.id === 'uptk_church-media').length === 1);

  // Direct publish: one multipart POST does the whole job.
  const upBefore = received.length;
  const upRes = await publisher.publishViaUploadPost(
    { apiKey: UP_KEY, upUser: 'church-media', username: 'gracetok' },
    { title: 'Sunday sermon', caption: 'Watch now! ✨', mediaPaths: [videoF] },
    { upApiBase: origin + '/api' });
  check('[G] video published → TikTok post id + link', upRes.id === '74001' && upRes.url === 'https://www.tiktok.com/@gracetok/video/74001', JSON.stringify(upRes));
  const upReq = received.slice(upBefore).find((r) => r.url === '/api/upload');
  check('[G] upload authenticated with the Apikey header', upReq && upReq.headers.authorization === 'Apikey ' + UP_KEY);
  check('[G] upload asked for a PUBLIC direct post with the caption',
    upReq && upReq.fields.user === 'church-media' && upReq.fields['platform[]'] === 'tiktok'
    && upReq.fields.title === 'Watch now! ✨' && upReq.fields.privacy_level === 'PUBLIC_TO_EVERYONE'
    && upReq.fields.post_mode === 'DIRECT_POST', upReq && JSON.stringify(upReq.fields));
  check('[G] video bytes round-trip EXACTLY (64KB streamed)', upReq && upReq.fileBytes && upReq.fileBytes.equals(fs.readFileSync(videoF)));

  // Big upload flips to async → the publisher must poll the status endpoint.
  upAsync = true; upStatusCallsUntilDone = 3; upStatusCalls = 0;
  const upAsyncRes = await publisher.publishViaUploadPost(
    { apiKey: UP_KEY, upUser: 'church-media', username: 'gracetok' },
    { caption: 'big one', mediaPaths: [videoF] }, { upApiBase: origin + '/api', pollMs: 30 });
  check('[G] async upload polls status until completed', upAsyncRes.id === 'upreq_1' && upStatusCalls >= 3, JSON.stringify(upAsyncRes));
  upAsync = false;

  // Upload-Post reporting a TikTok failure must surface as a clear error.
  upFail = true;
  let upFailErr = null;
  try {
    await publisher.publishViaUploadPost({ apiKey: UP_KEY, upUser: 'church-media', username: 'gracetok' },
      { caption: 'x', mediaPaths: [videoF] }, { upApiBase: origin + '/api' });
  } catch (e) { upFailErr = e.message; }
  check('[G] TikTok failure surfaces Upload-Post\'s reason', /TikTok rejected/.test(upFailErr || ''), upFailErr);
  upFail = false;

  // The failure the church WILL hit at ~50/month on the free plan: the monthly
  // cap. It must fail with actionable guidance, not a raw HTTP dump.
  upLimit = true;
  let upLimitErr = null;
  try {
    await publisher.publishViaUploadPost({ apiKey: UP_KEY, upUser: 'church-media', username: 'gracetok' },
      { caption: 'post 11 of the month', mediaPaths: [videoF] }, { upApiBase: origin + '/api' });
  } catch (e) { upLimitErr = e.message; }
  check('[G] free-plan monthly cap → clear upgrade + Advanced guidance (no raw HTTP)',
    /upgrade/i.test(upLimitErr || '') && /Advanced/i.test(upLimitErr || '')
    && /10 posts\/month/.test(upLimitErr || '') && !/HTTP \d/.test(upLimitErr || ''), upLimitErr);
  check('[G] cap message keeps Upload-Post\'s own words', /Monthly upload limit reached/.test(upLimitErr || ''), upLimitErr);
  upLimit = false;

  let upImgErr = null;
  try {
    await publisher.publishViaUploadPost({ apiKey: UP_KEY, upUser: 'church-media', username: 'gracetok' },
      { caption: 'x', mediaPaths: [photo] }, { upApiBase: origin + '/api' });
  } catch (e) { upImgErr = e.message; }
  check('[G] a flyer goes to TikTok (made into a 10-second video)', !upImgErr, upImgErr);

  // A wrong key must fail loudly at connect time with a helpful message.
  const badStore = makeStore({ upApiKey: 'WRONG' });
  let badKeyErr = null;
  try { await new Accounts(badStore).connectTikTokEasy(null, {}); } catch (e) { badKeyErr = e.message; }
  check('[G] wrong API key → clear "copy it again" error', /API key/i.test(badKeyErr || ''), badKeyErr);

  // The grandest fan-out: ONE post → 2 FB Pages + IG + YouTube + TikTok direct + TikTok easy.
  igStatusCalls = 99;
  tkStatusCallsUntilDone = 1; tkStatusCalls = 0;
  const before6 = { tk: countUploads('/v2/post/publish/video/init/'), up: countUploads('/api/upload') };
  const s8 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const all6 = s8.add({
    title: 'Everywhere+', caption: 'All six at once! 🚀', platforms: [],
    accountIds: ['fb_pagea', 'fb_pageb', 'ig_ig777', 'yt_UCabc123', 'tk_tkuser1', 'uptk_church-media'],
    mediaPaths: [videoF], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s8.start();
  await sleep(1800);
  s8.stop();
  const g6 = s8.list().find((p) => p.id === all6.id);
  check('[G] ONE post fanned out to ALL SIX accounts (both TikTok routes)', g6.status === 'posted'
    && g6.results.fb_pagea.ok && g6.results.fb_pageb.ok && g6.results.ig_ig777.ok
    && g6.results.yt_UCabc123.ok && g6.results.tk_tkuser1.ok && g6.results['uptk_church-media'].ok,
    g6.status + ' ' + JSON.stringify(Object.entries(g6.results || {}).map(([k, v]) => k + ':' + (v.ok || v.error))));
  check('[G] easy-TikTok result carries the post link', /@gracetok/.test(g6.results['uptk_church-media'].url || ''), JSON.stringify(g6.results['uptk_church-media']));
  check('[G] each TikTok route posted exactly once',
    countUploads('/v2/post/publish/video/init/') === before6.tk + 1 && countUploads('/api/upload') === before6.up + 1);

  const upHealth = await accounts.check('uptk_church-media');
  check('[G] health check confirms TikTok still linked on Upload-Post', upHealth.ok && upHealth.name === 'Grace TikTok Easy', JSON.stringify(upHealth));

  // TikTok token expired on Upload-Post's side → health check says re-auth.
  upProfiles[0].social_accounts.tiktok.reauth_required = true;
  let reauthErr = null;
  try { await accounts.check('uptk_church-media'); } catch (e) { reauthErr = e.message; }
  check('[G] re-auth needed surfaces a clear "sign in again" message', /fresh sign-in|reconnect/i.test(reauthErr || ''), reauthErr);
  upProfiles[0].social_accounts.tiktok.reauth_required = false;

  /* === [I] TikTok "easy connect — free & unlimited" via Zernio === */
  // Nothing linked yet on Zernio: the flow must open the hosted connect page
  // (openUrl plays the browser), then poll /accounts until TikTok shows up.
  const zo = await accounts.connectZernio(null, { openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[I] Zernio connect: TikTok linked via the hosted page',
    zo.id === 'zotk_zoacc_1' && zo.platform === 'tiktok' && zo.via === 'zernio', JSON.stringify(zo));
  check('[I] Zernio account carries the @handle + display name', zo.username === 'gracetok' && /Grace TikTok Z/.test(zo.name));
  check('[I] Zernio avatar inlined as data URI', (zo.picture || '').startsWith('data:image/'));
  check('[I] renderer-safe: Zernio API key never reaches the UI', !JSON.stringify(zo).includes(ZO_KEY) && !JSON.stringify(accounts.list()).includes(ZO_KEY));
  check('[I] stored record holds the API key as its token', accounts.byId('zotk_zoacc_1').token === ZO_KEY);

  // Reconnect must reuse the linked account with NO browser and no duplicate.
  const zo2 = await accounts.connectZernio(null, { openUrl: () => { throw new Error('browser must not open'); } });
  check('[I] reconnect reuses the linked account (no browser, no duplicate)',
    zo2.id === 'zotk_zoacc_1' && accounts.all().filter((a) => a.id === 'zotk_zoacc_1').length === 1);

  // Publish: presign → PUT bytes to the signed URL → create a PUBLIC post.
  const zoBefore = received.length;
  const zoRes = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_1', username: 'gracetok' },
    { title: 'Sunday sermon', caption: 'Watch now! ✨', mediaPaths: [videoF] },
    { zoApiBase: origin + '/zo/v1' });
  check('[I] video published → TikTok post id + link', zoRes.id === '99001' && /@gracetok\/video\/99001/.test(zoRes.url), JSON.stringify(zoRes));
  const zoPut = received.slice(zoBefore).find((r) => r.url === '/zo/upload/u1');
  check('[I] video bytes round-trip EXACTLY (64KB streamed to the signed URL)', zoPut && zoPut.fileBytes && zoPut.fileBytes.equals(fs.readFileSync(videoF)));
  const zoPost = received.slice(zoBefore).find((r) => r.url === '/zo/v1/posts');
  check('[I] post asked for PUBLIC + consent flags, with the caption + account',
    zoPost && zoPost.fields.content === 'Watch now! ✨'
    && zoPost.fields.platforms[0].platform === 'tiktok' && zoPost.fields.platforms[0].accountId === 'zoacc_1'
    && /\/zo\/cdn\//.test(zoPost.fields.mediaItems[0].url || '')
    && zoPost.fields.tiktokSettings.privacy_level === 'PUBLIC_TO_EVERYONE'
    && zoPost.fields.tiktokSettings.content_preview_confirmed === true
    && zoPost.fields.tiktokSettings.express_consent_given === true, zoPost && JSON.stringify(zoPost.fields));
  check('[I] post authenticated with the Bearer key', zoPost && zoPost.headers.authorization === 'Bearer ' + ZO_KEY);

  // Big/slow upload flips to async → the publisher polls the post until published.
  zoAsync = true; zoStatusCallsUntilDone = 3; zoStatusCalls = 0;
  const zoAsyncRes = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_1', username: 'gracetok' },
    { caption: 'big one', mediaPaths: [videoF] }, { zoApiBase: origin + '/zo/v1', pollMs: 30 });
  check('[I] async publish polls the post until published', /99001/.test(zoAsyncRes.url) && zoStatusCalls >= 3, JSON.stringify(zoAsyncRes) + ' calls=' + zoStatusCalls);
  zoAsync = false;

  // Zernio reporting a TikTok failure must surface its reason.
  zoFail = true;
  let zoFailErr = null;
  try {
    await publisher.publishViaZernio({ apiKey: ZO_KEY, accountId: 'zoacc_1', username: 'gracetok' },
      { caption: 'x', mediaPaths: [videoF] }, { zoApiBase: origin + '/zo/v1' });
  } catch (e) { zoFailErr = e.message; }
  check('[I] TikTok failure surfaces Zernio\'s reason', /TikTok rejected/.test(zoFailErr || ''), zoFailErr);
  zoFail = false;

  // A plan/limit rejection → actionable message pointing at the free backup route.
  zoLimit = true;
  let zoLimitErr = null;
  try {
    await publisher.publishViaZernio({ apiKey: ZO_KEY, accountId: 'zoacc_1', username: 'gracetok' },
      { caption: 'x', mediaPaths: [videoF] }, { zoApiBase: origin + '/zo/v1' });
  } catch (e) { zoLimitErr = e.message; }
  check('[I] plan/limit → actionable guidance (backup route, no raw HTTP)',
    /Upload-Post|backup|roll/i.test(zoLimitErr || '') && !/HTTP \d/.test(zoLimitErr || ''), zoLimitErr);
  zoLimit = false;

  // A flyer goes to TikTok as a PHOTO post — as a JPEG (TikTok refuses PNG), with TikTok's music.
  const zoImgBefore = received.length;
  let zoImgErr = null;
  try {
    await publisher.publishViaZernio({ apiKey: ZO_KEY, accountId: 'zoacc_1', username: 'gracetok' },
      { caption: 'x', mediaPaths: [photo] }, { zoApiBase: origin + '/zo/v1' });
  } catch (e) { zoImgErr = e.message; }
  const zoImgPre = received.slice(zoImgBefore).find((r) => r.url === '/zo/v1/media/presign');
  const zoImgPut = received.slice(zoImgBefore).find((r) => r.url === '/zo/upload/u1');
  const zoImgPost = received.slice(zoImgBefore).find((r) => r.url === '/zo/v1/posts');
  check('[I] a flyer posts to TikTok', !zoImgErr, zoImgErr);
  check('[I] ...sent as a JPEG, not the PNG', zoImgPre && zoImgPre.fields.contentType === 'image/jpeg' && /\.jpe?g$/i.test(zoImgPre.fields.filename)
    && zoImgPut && zoImgPut.fileBytes && zoImgPut.fileBytes[0] === 0xff && zoImgPut.fileBytes[1] === 0xd8, zoImgPre && JSON.stringify(zoImgPre.fields));
  check('[I] ...as a TikTok PHOTO post with music added', zoImgPost && zoImgPost.fields.tiktokSettings.media_type === 'PHOTO'
    && zoImgPost.fields.tiktokSettings.auto_add_music === true && zoImgPost.fields.mediaItems[0].type === 'image', zoImgPost && JSON.stringify(zoImgPost.fields));

  // A wrong key must fail loudly at connect time with a helpful message.
  const zoBadStore = makeStore({ zoApiKey: 'WRONG' });
  let zoBadErr = null;
  try { await new Accounts(zoBadStore).connectZernio(null, {}); } catch (e) { zoBadErr = e.message; }
  check('[I] wrong API key → clear "copy it again" error', /API key/i.test(zoBadErr || ''), zoBadErr);

  // Health check confirms the account is still linked.
  const zoHealth = await accounts.check('zotk_zoacc_1');
  check('[I] health check confirms TikTok still linked on Zernio', zoHealth.ok && /gracetok|Grace TikTok Z/.test(zoHealth.name), JSON.stringify(zoHealth));

  // The scheduler must auto-post through the Zernio route, exactly once.
  const zoUploadsBefore = countUploads('/zo/v1/posts');
  const s9 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const zoSched = s9.add({
    title: 'Zernio path', caption: 'Free + unlimited! 🚀', platforms: [],
    accountIds: ['zotk_zoacc_1'], mediaPaths: [videoF], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s9.start();
  await sleep(1200);
  s9.stop();
  const zg = s9.list().find((p) => p.id === zoSched.id);
  check('[I] scheduler auto-posts through Zernio', zg.status === 'posted' && zg.results['zotk_zoacc_1'] && zg.results['zotk_zoacc_1'].ok,
    zg.status + ' ' + JSON.stringify(zg.results));
  check('[I] scheduler posted through Zernio exactly once', countUploads('/zo/v1/posts') === zoUploadsBefore + 1);

  /* === [J] YouTube "easy connect" via the SAME Zernio key (no Google Cloud Console) === */
  // The same free Zernio key that linked TikTok also links YouTube (2 free
  // accounts), so a church never touches the Google Cloud Console.
  const zoyt = await accounts.connectZernio(null, { platform: 'youtube', openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[J] Zernio connect (YouTube): channel linked via the hosted page',
    zoyt.id === 'zoyt_zoacc_yt' && zoyt.platform === 'youtube' && zoyt.via === 'zernio', JSON.stringify(zoyt));
  check('[J] YouTube account carries the handle + channel name', zoyt.username === 'gracechannel' && /Grace Church TV/.test(zoyt.name));
  check('[J] YouTube reuses the SAME Zernio API key as TikTok', accounts.byId('zoyt_zoacc_yt').token === ZO_KEY);
  check('[J] both TikTok + YouTube now connected via one key',
    !!accounts.byId('zotk_zoacc_1') && !!accounts.byId('zoyt_zoacc_yt'));

  // Publish a video to YouTube via Zernio: presign → PUT → post with title + public.
  const zoytBefore = received.length;
  const zoytRes = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_yt', username: 'gracechannel', platform: 'youtube' },
    { title: 'Sunday Service — Full', caption: 'The whole service ✝', mediaPaths: [videoF] },
    { zoApiBase: origin + '/zo/v1' });
  check('[J] YouTube video published → id + watch link', zoytRes.id === 'YT99' && /watch\?v=YT99/.test(zoytRes.url), JSON.stringify(zoytRes));
  const zoytPut = received.slice(zoytBefore).find((r) => r.url === '/zo/upload/u1');
  check('[J] YouTube video bytes round-trip EXACTLY (streamed to the signed URL)', zoytPut && zoytPut.fileBytes && zoytPut.fileBytes.equals(fs.readFileSync(videoF)));
  const zoytPost = received.slice(zoytBefore).find((r) => r.url === '/zo/v1/posts');
  check('[J] post targets YouTube with a title + PUBLIC visibility',
    zoytPost && zoytPost.fields.platforms[0].platform === 'youtube' && zoytPost.fields.platforms[0].accountId === 'zoacc_yt'
    && zoytPost.fields.youtubeSettings.title === 'Sunday Service — Full'
    && zoytPost.fields.youtubeSettings.visibility === 'public'
    && zoytPost.fields.youtubeSettings.madeForKids === false, zoytPost && JSON.stringify(zoytPost.fields.youtubeSettings));

  // A flyer goes to YouTube as a 10-second vertical Short.
  const zoytImgBefore = received.length;
  let zoytImgErr = null;
  try {
    await publisher.publishViaZernio({ apiKey: ZO_KEY, accountId: 'zoacc_yt', username: 'gracechannel', platform: 'youtube' },
      { caption: 'x', mediaPaths: [photo] }, { zoApiBase: origin + '/zo/v1' });
  } catch (e) { zoytImgErr = e.message; }
  const zoytImgPre = received.slice(zoytImgBefore).find((r) => r.url === '/zo/v1/media/presign');
  const zoytImgPut = received.slice(zoytImgBefore).find((r) => r.url === '/zo/upload/u1');
  const zoytImgPost = received.slice(zoytImgBefore).find((r) => r.url === '/zo/v1/posts');
  check('[J] a flyer posts to YouTube', !zoytImgErr, zoytImgErr);
  check('[J] ...as a video (an MP4 Short)', zoytImgPre && zoytImgPre.fields.contentType === 'video/mp4'
    && zoytImgPost && zoytImgPost.fields.mediaItems[0].type === 'video', zoytImgPre && JSON.stringify(zoytImgPre.fields));
  if (zoytImgPut && zoytImgPut.fileBytes) {
    const shortF = path.join(tmp, 'short-sent.mp4'); fs.writeFileSync(shortF, zoytImgPut.fileBytes);
    const probe = require('child_process').spawnSync(require('../src/main/ffmpeg').resolveFfmpeg(), ['-i', shortF], { encoding: 'utf8' }).stderr;
    check('[J] ...1080x1920, about 10 seconds', /1080x1920/.test(probe) && /Duration: 00:00:(09|10)\./.test(probe), probe.slice(-400));
  } else check('[J] ...1080x1920, about 10 seconds', false, 'no upload');

  // Health check confirms the YouTube account still linked.
  const zoytHealth = await accounts.check('zoyt_zoacc_yt');
  check('[J] YouTube (Zernio) health check confirms still linked', zoytHealth.ok && /gracechannel|Grace Church TV/.test(zoytHealth.name), JSON.stringify(zoytHealth));

  // Scheduler: ONE post fanned out to BOTH TikTok + YouTube via the one key.
  const zoBothBefore = countUploads('/zo/v1/posts');
  const s10 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const bothRec = s10.add({
    title: 'Service everywhere', caption: 'Live now! 🙌', platforms: [],
    accountIds: ['zotk_zoacc_1', 'zoyt_zoacc_yt'], mediaPaths: [videoF],
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s10.start();
  await sleep(1400);
  s10.stop();
  const bg = s10.list().find((p) => p.id === bothRec.id);
  check('[J] ONE post auto-posted to BOTH TikTok + YouTube via one Zernio key',
    bg.status === 'posted' && bg.results['zotk_zoacc_1'].ok && bg.results['zoyt_zoacc_yt'].ok,
    bg.status + ' ' + JSON.stringify(bg.results));
  check('[J] fan-out hit Zernio /posts exactly twice (one per platform)', countUploads('/zo/v1/posts') === zoBothBefore + 2);

  /* === [K] Facebook + Instagram "easy connect" via the SAME Zernio key (no Meta app) === */
  // Facebook (photo / video / TEXT-only) and Instagram (photo / video) through
  // the one free key — no Meta developer app, and photos/flyers are supported.
  const zofb = await accounts.connectZernio(null, { platform: 'facebook', openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[K] Zernio connect (Facebook): Page linked via the hosted page',
    zofb.id === 'zofb_zoacc_fb' && zofb.platform === 'facebook' && zofb.via === 'zernio', JSON.stringify(zofb));
  const zoig = await accounts.connectZernio(null, { platform: 'instagram', openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[K] Zernio connect (Instagram): account linked via the hosted page',
    zoig.id === 'zoig_zoacc_ig' && zoig.platform === 'instagram' && zoig.via === 'zernio', JSON.stringify(zoig));
  check('[K] FB + IG reuse the SAME Zernio key',
    accounts.byId('zofb_zoacc_fb').token === ZO_KEY && accounts.byId('zoig_zoacc_ig').token === ZO_KEY);

  // Facebook PHOTO post (a flyer) → presign as an IMAGE → post.
  const zofbBefore = received.length;
  const zofbRes = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_fb', username: 'gracechapel', platform: 'facebook' },
    { caption: 'This Sunday! 🙌', mediaPaths: [photo] }, { zoApiBase: origin + '/zo/v1' });
  check('[K] Facebook photo published → post id + link', zofbRes.id === 'fb123' && /facebook\.com/.test(zofbRes.url), JSON.stringify(zofbRes));
  const zofbPresign = received.slice(zofbBefore).find((r) => r.url === '/zo/v1/media/presign');
  check('[K] flyer presigned as an IMAGE content-type (not video)', zofbPresign && /^image\//.test(zofbPresign.fields.contentType || ''), zofbPresign && JSON.stringify(zofbPresign.fields));
  const zofbPost = received.slice(zofbBefore).find((r) => r.url === '/zo/v1/posts');
  check('[K] FB post carries the image mediaItem + caption',
    zofbPost && zofbPost.fields.platforms[0].platform === 'facebook'
    && zofbPost.fields.mediaItems[0].type === 'image' && zofbPost.fields.content === 'This Sunday! 🙌',
    zofbPost && JSON.stringify(zofbPost.fields));

  // Facebook TEXT-ONLY post (no media) → no presign, just content.
  const zofbTxtBefore = received.length;
  const zofbTxt = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_fb', username: 'gracechapel', platform: 'facebook' },
    { caption: 'Prayer meeting tonight at 7pm.' }, { zoApiBase: origin + '/zo/v1' });
  check('[K] Facebook TEXT-ONLY post published (no media needed)', zofbTxt.id === 'fb123', JSON.stringify(zofbTxt));
  check('[K] text-only FB post did NOT presign/upload any media', !received.slice(zofbTxtBefore).some((r) => r.url === '/zo/v1/media/presign'));
  const zofbTxtPost = received.slice(zofbTxtBefore).find((r) => r.url === '/zo/v1/posts');
  check('[K] text-only FB post sent content + NO mediaItems',
    zofbTxtPost && zofbTxtPost.fields.content === 'Prayer meeting tonight at 7pm.' && !zofbTxtPost.fields.mediaItems);

  // Instagram PHOTO post.
  const zoigRes = await publisher.publishViaZernio(
    { apiKey: ZO_KEY, accountId: 'zoacc_ig', username: 'gracechapel', platform: 'instagram' },
    { caption: 'Flyer 📸', mediaPaths: [photo] }, { zoApiBase: origin + '/zo/v1' });
  check('[K] Instagram photo published → post id + link', zoigRes.id === 'IG123' && /instagram\.com/.test(zoigRes.url), JSON.stringify(zoigRes));

  // Instagram TEXT-ONLY must be rejected (media required).
  let zoigTxtErr = null;
  try {
    await publisher.publishViaZernio({ apiKey: ZO_KEY, accountId: 'zoacc_ig', username: 'gracechapel', platform: 'instagram' },
      { caption: 'no media here' }, { zoApiBase: origin + '/zo/v1' });
  } catch (e) { zoigTxtErr = e.message; }
  check('[K] Instagram text-only rejected with a clear "needs a photo or video"', /photo or video/i.test(zoigTxtErr || ''), zoigTxtErr);

  // Health checks for both.
  const zofbHealth = await accounts.check('zofb_zoacc_fb');
  check('[K] Facebook (Zernio) health check confirms still linked', zofbHealth.ok, JSON.stringify(zofbHealth));
  const zoigHealth = await accounts.check('zoig_zoacc_ig');
  check('[K] Instagram (Zernio) health check confirms still linked', zoigHealth.ok, JSON.stringify(zoigHealth));

  // Scheduler: ONE flyer photo fanned out to BOTH Facebook + Instagram via one key.
  const fbigBefore = countUploads('/zo/v1/posts');
  const s11 = new Scheduler(store, () => null, { notify, intervalMs: 150, accounts });
  const flyerRec = s11.add({
    title: 'Flyer', caption: 'Big Sunday! 🎉', platforms: [],
    accountIds: ['zofb_zoacc_fb', 'zoig_zoacc_ig'], mediaPaths: [photo],
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  s11.start();
  await sleep(1400);
  s11.stop();
  const fg = s11.list().find((p) => p.id === flyerRec.id);
  check('[K] ONE flyer photo auto-posted to BOTH Facebook + Instagram via one key',
    fg.status === 'posted' && fg.results['zofb_zoacc_fb'].ok && fg.results['zoig_zoacc_ig'].ok,
    fg.status + ' ' + JSON.stringify(fg.results));

  /* === [L] Facebook + Instagram on a SECOND free Zernio account (all 4 platforms free) === */
  // Zernio's free plan = 2 accounts. FB + IG (exactly 2 accounts) go on their OWN
  // free Zernio key (zoApiKeyFb), leaving the TikTok/YouTube key's 2 free slots
  // untouched — two free Zernio accounts cover all four platforms at $0.
  const store2 = makeStore({ zoApiKeyFb: ZO_KEY_FB });
  const acc2 = new Accounts(store2);

  const lFbBefore = received.length;
  const lFb = await acc2.connectZernio(null, { platform: 'facebook', openUrl: (u) => httpFollow(u), pollMs: 30 });
  const lFbReqs = received.slice(lFbBefore).filter((r) => r.url === '/zo/v1/accounts' || r.url === '/zo/v1/connect/facebook');
  check('[L] Facebook linked on the SECOND free Zernio account', lFb.id === 'zofb_zoacc_fb_w2' && lFb.via === 'zernio', JSON.stringify(lFb));
  check('[L] FB connect used the 2nd account key (never the TikTok/YouTube key)',
    lFbReqs.length > 0 && lFbReqs.every((r) => r.headers.authorization === 'Bearer ' + ZO_KEY_FB));
  check('[L] FB account stored under the 2nd key', acc2.byId('zofb_zoacc_fb_w2').token === ZO_KEY_FB);

  const lIg = await acc2.connectZernio(null, { platform: 'instagram', openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[L] Instagram linked on the SAME second free Zernio account',
    lIg.id === 'zoig_zoacc_ig_w2' && acc2.byId('zoig_zoacc_ig_w2').token === ZO_KEY_FB, JSON.stringify(lIg));

  // TikTok on the PRIMARY key — proves the two free accounts stay separate.
  const lTkBefore = received.length;
  await acc2.connectZernio(null, { platform: 'tiktok', openUrl: (u) => httpFollow(u), pollMs: 30 });
  const lTkAcctReq = received.slice(lTkBefore).find((r) => r.url === '/zo/v1/accounts');
  check('[L] TikTok stays on the PRIMARY Zernio key (its own free account)',
    acc2.byId('zotk_zoacc_1').token === ZO_KEY && lTkAcctReq && lTkAcctReq.headers.authorization === 'Bearer ' + ZO_KEY);
  check('[L] all FOUR platforms connected across TWO free Zernio accounts ($0)',
    acc2.byId('zotk_zoacc_1').token === ZO_KEY
    && acc2.byId('zofb_zoacc_fb_w2').token === ZO_KEY_FB
    && acc2.byId('zoig_zoacc_ig_w2').token === ZO_KEY_FB);

  // A flyer to Facebook publishes through the SECOND account's key.
  const lPubBefore = received.length;
  const lPub = await publisher.publishViaZernio(
    { apiKey: ZO_KEY_FB, accountId: 'zoacc_fb_w2', username: 'gracechapel', platform: 'facebook' },
    { caption: 'Second-account flyer 🙌', mediaPaths: [photo] }, { zoApiBase: origin + '/zo/v1' });
  const lPost = received.slice(lPubBefore).find((r) => r.url === '/zo/v1/posts');
  check('[L] Facebook flyer published via the 2nd account → post id + link', lPub.id === 'fb123' && /facebook\.com/.test(lPub.url), JSON.stringify(lPub));
  check('[L] FB publish authenticated with the 2nd account key', lPost && lPost.headers.authorization === 'Bearer ' + ZO_KEY_FB);

  // Back-compat: with no 2nd key set, Facebook falls back to the primary Zernio key.
  const acc3 = new Accounts(makeStore());
  const lFallback = await acc3.connectZernio(null, { platform: 'facebook', openUrl: (u) => httpFollow(u), pollMs: 30 });
  check('[L] no 2nd key set → Facebook falls back to the primary key (still works)', acc3.byId(lFallback.id).token === ZO_KEY);

  /* ============================================================================
   * [M] Instagram video: when ONE of Meta's two upload routes is broken
   *
   * Meta gives two ways to get a local video into a Reels container, and they
   * fail independently — in August 2026 the resumable endpoint answered every
   * upload with HTTP 500 ProcessingFailedError while the staged-link route
   * still worked. Betting the church's post on a single route is what turned
   * that into "Instagram just doesn't work"; these checks pin the fallback.
   * ========================================================================== */
  console.log('\n[M] Instagram video — falling back when Meta breaks one route');

  const igArgs = { igUserId: 'ig777', pageId: 'pagea', token: PAGE_TOKENS.pagea, apiBase: graph };
  const igPost = { caption: 'Sunday highlight 🙌', mediaPaths: [videoF] };
  const igOpts = { pollMs: 5, maxPolls: 30 };

  // 1. Normal service: the resumable route is used and NOTHING is staged on the Page.
  igStatusCallsUntilDone = 1; igStatusCalls = 0;
  igRuploadBroken = false; igVideoProcessingBroken = false;
  const mBefore = received.length;
  const mOk = await publisher.publishToInstagram(igArgs, igPost, igOpts);
  const mCalls = received.slice(mBefore);
  check('[M] happy path still uses the resumable upload', mOk.id === 'igmedia_9' && mCalls.some((r) => r.url === '/rupload/igc_1'), JSON.stringify(mOk));
  check('[M] …and stages nothing on the Facebook Page', !mCalls.some((r) => r.url === '/v19.0/pagea/videos'));

  // 2. Meta's resumable endpoint is down → the app must reach Instagram anyway.
  igStatusCallsUntilDone = 1; igStatusCalls = 0;
  igRuploadBroken = true; igVideoProcessingBroken = false;
  const m2Before = received.length;
  const m2 = await publisher.publishToInstagram(igArgs, igPost, igOpts);
  const m2Calls = received.slice(m2Before);
  check('[M] THE FIX: a broken resumable endpoint no longer loses the post', m2.id === 'igmedia_url', JSON.stringify(m2));
  check('[M] it tried the resumable route first', m2Calls.some((r) => r.url === '/rupload/igc_1'));
  check('[M] then staged the video on the linked Page, unpublished', (() => {
    const st = m2Calls.find((r) => r.url === '/v19.0/pagea/videos' && r.fields.published !== undefined);
    return st && st.fields.published === 'false';
  })());
  check('[M] and handed Instagram the link Facebook served it from', (() => {
    const c = m2Calls.filter((r) => r.url === '/v19.0/ig777/media').pop();
    return c && /\/cdn\/vid_/.test(c.fields.video_url || '') && c.fields.media_type === 'REELS';
  })());
  check('[M] the staging upload is deleted again — nothing is left on the Page',
    m2Calls.some((r) => r.method === 'DELETE' && /^\/v19\.0\/vid_/.test(r.url)));
  check('[M] the caption survives the detour', (() => {
    const c = m2Calls.filter((r) => r.url === '/v19.0/ig777/media').pop();
    return c && c.fields.caption === 'Sunday highlight 🙌';
  })());
  check('[M] and the operator gets a real permalink', /instagram\.com\/reel\/VIAURL/.test(m2.url), m2.url);

  // 3. BOTH routes fail (Meta's video service itself) → one plain sentence that
  //    says whose fault it is, not a raw HTTP 500 JSON dump.
  igRuploadBroken = true; igVideoProcessingBroken = true;
  let mErr = null;
  try { await publisher.publishToInstagram(igArgs, igPost, igOpts); }
  catch (e) { mErr = e.message; }
  check('[M] both routes down → it fails rather than pretending', !!mErr);
  check('[M] the message names Meta as the cause, not the church\'s video',
    /Meta|Instagram/.test(mErr || '') && /2207076/.test(mErr || '') && !/debug_info/.test(mErr || ''), mErr);
  check('[M] …and tells them what to do about it', /Retry|recover/i.test(mErr || ''), mErr);
  check('[M] the staged video is cleaned up even when publishing fails',
    received.slice(-12).some((r) => r.method === 'DELETE' && /^\/v19\.0\/vid_/.test(r.url)));
  igRuploadBroken = false; igVideoProcessingBroken = false;

  // 4. The pre-flight must never be the thing that blocks a post.
  check('[M] pre-flight passes a real Reels-spec video', publisher.igVideoProblems(videoF).length === 0);
  check('[M] pre-flight stays silent when ffprobe cannot read the file',
    publisher.igVideoProblems(path.join(tmp, 'does-not-exist.mp4')).length === 0);

  // 5. Meta's documented codes become English.
  check('[M] a known Meta code is translated', /shape/.test(publisher.igVideoFailure([{ route: 'r', detail: 'Error: ... error code 2207009' }])));
  check('[M] an undocumented code is reported as Meta\'s fault',
    /Meta’s side/.test(publisher.igVideoFailure([{ route: 'r', detail: 'Error: ... error code 2207076' }])));

  /* ============================================================================
   * [N] A key that has stopped working, and a Reel that may be too long
   *
   * Both are things the operator can act on the moment they are told — and both
   * used to surface as something that read like a bug in the app.
   * ========================================================================== */
  console.log('\n[N] Dead keys and long Reels');

  check('[N] a 401 from Zernio is recognised as a dead key',
    publisher.zoDeadKey('{"error":"Unauthorized"}') && publisher.zoDeadKey('HTTP 401: Invalid API key'));
  check('[N] …and an ordinary rejection is not mistaken for one',
    !publisher.zoDeadKey('quota exceeded') && !publisher.zoDeadKey('TikTok rejected the post.'));

  // The whole point: the message says the key is the problem and where to fix it.
  const nDead = await publisher.publishViaZernio(
    { apiKey: 'sk_revoked', accountId: 'zoacc_1', username: 'gracetok', platform: 'tiktok' },
    { caption: 'x', mediaPaths: [videoF] }, { zoApiBase: origin + '/zo/v1' }).catch((e) => e.message);
  check('[N] a revoked key produces a plain "renew your key" message, not an HTTP dump',
    /no longer valid/i.test(nDead) && /zernio\.com/i.test(nDead) && !/HTTP \d/.test(nDead), nDead);
  check('[N] …and it names what stops working', /TikTok/.test(nDead) && /Instagram/.test(nDead), nDead);

  // Reels length: a note, never a refusal.
  check('[N] a long video is NOT blocked by the pre-flight', publisher.igVideoProblems(videoF).length === 0);
  check('[N] over 90s adds a note about the length', /99s/.test(publisher.igLengthNote(99.3)) && /90s/.test(publisher.igLengthNote(99.3)));
  check('[N] under 90s says nothing about it', publisher.igLengthNote(45) === '' && publisher.igLengthNote(null) === '');
  check('[N] the note rides along on a real failure',
    /Meta’s side/.test(publisher.igVideoFailure([{ route: 'r', detail: 'error code 2207076' }], 99.3))
    && /99s/.test(publisher.igVideoFailure([{ route: 'r', detail: 'error code 2207076' }], 99.3)));
  check('[N] …and stays away when the video is short',
    !/90s/.test(publisher.igVideoFailure([{ route: 'r', detail: 'error code 2207076' }], 30)));


  /* ==========================================================================
   * [P] THE LONG VIDEO THAT WOULD NOT POST
   *
   * Short clips (40-130MB) reached all three Pages every time; a full-length
   * service came back HTTP 413 from every one of them, while YouTube — which
   * has always uploaded in a resumable session — posted the same file fine.
   *
   * 413 is Meta's edge saying the REQUEST was too big, so the size of any one
   * request is the whole story: the file used to go up as a single POST, and
   * past a certain length that POST is refused before Facebook ever looks at
   * the video. The mock draws the same line, just closer in.
   * ======================================================================== */
  console.log('\n-- [P] long videos --');

  const bigF = path.join(tmp, 'service.mp4');
  const bigBytes = 7 * 1024 * 1024 + 12345;   // comfortably past the wall
  fs.writeFileSync(bigF, crypto.randomBytes(bigBytes));
  const bigSha = crypto.createHash('sha256').update(fs.readFileSync(bigF)).digest('hex');
  const shortF = videoF;                      // the 64KB clip that always worked

  /* --- P1: the bug is real, and the mock reproduces it exactly ----------- */
  const oneShotBig = await publisher.postMultipart(graph + '/pagea/videos',
    { description: 'one big POST', access_token: PAGE_TOKENS.pagea }, bigF, 'source')
    .then(() => null).catch((e) => e.message);
  check('[P] the old way — the whole file in one POST — is refused by Meta',
    !!oneShotBig && /413|too big/i.test(oneShotBig), String(oneShotBig));
  const oneShotSmall = await publisher.postMultipart(graph + '/pagea/videos',
    { description: 'one small POST', access_token: PAGE_TOKENS.pagea }, shortF, 'source')
    .then((r) => r.id).catch((e) => e.message);
  check('[P] …while a SHORT clip sails through it (exactly the reported symptom)',
    /^vid_pagea/.test(String(oneShotSmall)), String(oneShotSmall));

  /* --- P2: the fix — that same long video, posted for real -------------- */
  fb.chunkBytes = 1024 * 1024;
  const beforeBig = received.length;
  const bigPost = await publisher.publishToFacebook(
    { pageId: 'pagea', token: PAGE_TOKENS.pagea, apiBase: graph },
    { caption: 'Historic Moment at the All Ireland Outpouring', mediaPaths: [bigF] });
  const ses = fb.last();
  check('[P] THE FIX: the long video POSTS', !!(bigPost && bigPost.id), JSON.stringify(bigPost));
  check('[P] …every byte arrived, in order and unaltered',
    !!ses && ses.finished && ses.got === bigBytes && ses.digest === bigSha,
    ses ? ses.got + '/' + bigBytes + ' sha ' + String(ses.digest).slice(0, 12) + ' vs ' + bigSha.slice(0, 12) : 'no session');
  check('[P] …and the caption rode along on the finish',
    !!ses && /All Ireland Outpouring/.test(ses.description || ''), ses && ses.description);

  const transfers = received.slice(beforeBig)
    .filter((r) => r.url === '/v19.0/pagea/videos' && r.fields.upload_phase === 'transfer');
  check('[P] it went up in parts, not one lump', transfers.length === 8, String(transfers.length));
  check('[P] no single request came anywhere near the wall',
    Math.max.apply(null, transfers.map((r) => r.chunkLen || 0)) <= fb.chunkBytes,
    Math.max.apply(null, transfers.map((r) => r.chunkLen || 0)) + ' bytes');
  check('[P] nothing was sent twice',
    transfers.reduce((n, r) => n + (r.chunkLen || 0), 0) === bigBytes,
    String(transfers.reduce((n, r) => n + (r.chunkLen || 0), 0)));

  /* --- P3: a reply lost mid-upload must not lose the post --------------- */
  const beforeDrop = received.length;
  fb.dropReplyAt = 3 * 1024 * 1024;   // the uplink eats one answer, once
  const survived = await publisher.publishToFacebook(
    { pageId: 'pageb', token: PAGE_TOKENS.pageb, apiBase: graph },
    { caption: 'flaky uplink', mediaPaths: [bigF] }, { chunkTries: 4 });
  const sesB = fb.last();
  const dropTransfers = received.slice(beforeDrop)
    .filter((r) => r.fields && r.fields.upload_phase === 'transfer');
  check('[P] a chunk whose reply is lost is resumed where Facebook actually is',
    !!(survived && survived.id) && !!sesB && sesB.finished && sesB.got === bigBytes && sesB.digest === bigSha,
    sesB ? sesB.got + '/' + bigBytes : 'no session');
  check('[P] …it really did have to re-send one part', dropTransfers.length === 9, String(dropTransfers.length));
  check('[P] …and the re-send did NOT duplicate those bytes', sesB.got === bigBytes, String(sesB.got));

  /* --- P4: the HOST. graph.facebook.com never takes video bytes --------- */
  check('[P] video uploads are addressed to graph-video.facebook.com',
    publisher.videoApiBase('https://graph.facebook.com/v19.0') === 'https://graph-video.facebook.com/v19.0',
    publisher.videoApiBase('https://graph.facebook.com/v19.0'));
  check('[P] …only the real host is rewritten — an injected base is untouched',
    publisher.videoApiBase(graph) === graph && publisher.videoApiBase('') === '');

  /* --- P5: an edge with no upload sessions still gets its video --------- */
  fb.sessionsOn = false;
  const noSession = await publisher.publishToFacebook(
    { pageId: 'pagea', token: PAGE_TOKENS.pagea, apiBase: graph },
    { caption: 'old edge', mediaPaths: [shortF] }).catch((e) => ({ err: e.message }));
  check('[P] an edge with no sessions to offer falls back to a single POST',
    !!(noSession && noSession.id), JSON.stringify(noSession));
  fb.sessionsOn = true;

  /* --- P6: the real thing — one long video to every account at once ----- */
  igStatusCalls = 99;
  const beforeP = { a: countUploads('/v19.0/pagea/videos'), b: countUploads('/v19.0/pageb/videos'),
    yt: countUploads('/upload/youtube/v3/videos') };
  const sP = new Scheduler(store, () => null, { notify, intervalMs: 120, accounts });
  const bigFan = sP.add({
    title: 'Historic Moment at the All Ireland Outpouring',
    caption: 'August 15, 2026 marked a historic day in Ireland and Europe.',
    platforms: [], accountIds: ['fb_pagea', 'fb_pageb', 'yt_UCabc123'],
    mediaPaths: [bigF], scheduledAt: new Date(Date.now() - 1000).toISOString(),
  });
  sP.start();
  for (let i = 0; i < 1200; i++) {
    const cur = sP.list().find((x) => x.id === bigFan.id);
    if (cur && cur.status !== 'scheduled' && cur.status !== 'posting') break;
    await sleep(50);
  }
  sP.stop();
  const bp = sP.list().find((x) => x.id === bigFan.id);
  check('[P] a long service video auto-posts to BOTH Pages and YouTube',
    bp.status === 'posted' && ['fb_pagea', 'fb_pageb', 'yt_UCabc123'].every((k) => bp.results[k] && bp.results[k].ok),
    bp.status + ' — ' + JSON.stringify(bp.results));
  check('[P] …counted once per account, not once per chunk',
    countUploads('/v19.0/pagea/videos') === beforeP.a + 1
    && countUploads('/v19.0/pageb/videos') === beforeP.b + 1
    && countUploads('/upload/youtube/v3/videos') === beforeP.yt + 1);
  check('[P] …and not one account came back 413',
    !JSON.stringify(bp.results).includes('413'), JSON.stringify(bp.results));

  /* --- P7: the operator's own file, at its true size -------------------- */
  const REAL = process.env.MW_REAL_VIDEO
    || 'C:/Users/dejia/Videos/Church Work Space/short-Hallelujah-captioned-20260822-103247.mp4';
  if (fs.existsSync(REAL)) {
    const realSize = fs.statSync(REAL).size;
    const realSha = await new Promise((done) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(REAL).on('data', (d) => h.update(d)).on('end', () => done(h.digest('hex')));
    });
    fb.chunkBytes = 1024 * 1024;
    const t0 = Date.now();
    const realPost = await publisher.publishToFacebook(
      { pageId: 'pagea', token: PAGE_TOKENS.pagea, apiBase: graph },
      { caption: 'A Historic Day at the All Ireland Outpouring', mediaPaths: [REAL] })
      .catch((e) => ({ err: e.message }));
    const rs = fb.last();
    const mb = (realSize / 1048576).toFixed(0);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    check('[P] the operator\u2019s own ' + mb + 'MB video posts (' + secs + 's over loopback)',
      !!(realPost && realPost.id) && !!rs && rs.finished && rs.got === realSize && rs.digest === realSha,
      JSON.stringify(realPost) + ' ' + (rs ? rs.got + '/' + realSize : 'no session'));
  } else {
    console.log('  SKIP  [P] real-file run — ' + REAL + ' not present');
  }
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
