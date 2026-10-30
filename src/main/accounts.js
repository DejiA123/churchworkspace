'use strict';
/**
 * Social account linking — the real "Connect Facebook" experience.
 *
 * Opens Facebook's OAuth dialog in an app window, captures the user token,
 * exchanges it for a long-lived one, then lists every Page the user manages
 * (and any Instagram Business account linked to each Page). The user picks
 * which ones to connect; each becomes a stored account the scheduler can
 * auto-publish to. Page tokens derived from a long-lived user token do not
 * expire, so this is a connect-once flow.
 *
 * Every base URL is injectable (settings.accounts.fbOauthBase / fbApiBase)
 * so the whole flow — including the OAuth window — runs against a local mock
 * server in tests.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const publisher = require('./publisher');

// Electron modules — absent when unit tests run this file under plain Node.
let electron = {};
try { electron = require('electron'); } catch (e) { /* plain node */ }
const BrowserWindow = (electron && typeof electron === 'object' && electron.BrowserWindow) || null;
const shell = (electron && typeof electron === 'object' && electron.shell) || null;

const DEFAULT_OAUTH = 'https://www.facebook.com';
const DEFAULT_GRAPH = 'https://graph.facebook.com/v19.0';
const OAUTH_SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
  'instagram_basic', 'instagram_content_publish', 'business_management',
].join(',');

const DEFAULT_YT_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const YT_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

const DEFAULT_TK_AUTH = 'https://www.tiktok.com';
// TikTok desktop apps must register a loopback redirect WITH a port (http is
// allowed for loopback). The URI never has to resolve — the OAuth window
// intercepts the redirect before it is followed.
const DEFAULT_TK_REDIRECT = 'http://127.0.0.1:33445/callback/';
const TK_SCOPES = 'user.info.basic,video.publish';

// Zernio (formerly getlate.dev): the "Easy connect — free & unlimited" TikTok
// route. Their TikTok app is already audited, so public posting works with no
// developer portal AND the free plan has no monthly post cap. Linking happens on
// Zernio's own hosted page; the church only ever pastes a free API key.
const DEFAULT_ZO_REDIRECT = 'https://zernio.com/connected';

function libFor(urlStr) { return urlStr.startsWith('https:') ? https : http; }

/** GET a URL; resolve with parsed JSON (Graph/Google error surfaced). */
function getJson(urlStr, { timeoutMs = 20000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = libFor(urlStr).request(new URL(urlStr), { method: 'GET', headers }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { /* non-JSON body */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
        const msg = (json && json.error && json.error.message) ? json.error.message
          : (json && typeof json.error === 'string') ? (json.error_description || json.error)
          : `HTTP ${res.statusCode}: ${out.slice(0, 300)}`;
        const err = new Error(msg); err.status = res.statusCode;
        reject(err);
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

/** GET binary (avatar images), following redirects; resolve with { buf, mime }. */
function getBinary(urlStr, { maxBytes = 300 * 1024, redirects = 3, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = libFor(urlStr).request(new URL(urlStr), { method: 'GET' }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getBinary(new URL(res.headers.location, urlStr).toString(),
          { maxBytes, redirects: redirects - 1, timeoutMs }));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      const chunks = []; let size = 0;
      res.on('data', (d) => {
        size += d.length;
        if (size > maxBytes) { req.destroy(new Error('Image too large.')); return; }
        chunks.push(d);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), mime: res.headers['content-type'] || 'image/jpeg' }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

async function fetchAvatarDataUri(url) {
  if (!url) return '';
  try {
    const { buf, mime } = await getBinary(url);
    return `data:${(mime.split(';')[0] || 'image/jpeg')};base64,${buf.toString('base64')}`;
  } catch (e) { return ''; }
}

/* ------------------------------ config helpers ------------------------------ */

function cfg(store) {
  const acc = ((store.get('settings') || {}).accounts) || {};
  return {
    appId: (acc.fbAppId || '').trim(),
    appSecret: (acc.fbAppSecret || '').trim(),
    oauthBase: (acc.fbOauthBase || DEFAULT_OAUTH).replace(/\/+$/, ''),
    graphBase: (acc.fbApiBase || DEFAULT_GRAPH).replace(/\/+$/, ''),
  };
}

function ytCfg(store) {
  const acc = ((store.get('settings') || {}).accounts) || {};
  return {
    clientId: (acc.ytClientId || '').trim(),
    clientSecret: (acc.ytClientSecret || '').trim(),
    authBase: acc.ytAuthBase || DEFAULT_YT_AUTH,
    tokenBase: acc.ytTokenBase || publisher.DEFAULT_YT_TOKEN,
    apiBase: (acc.ytApiBase || publisher.DEFAULT_YT_API).replace(/\/+$/, ''),
  };
}

function tkCfg(store) {
  const acc = ((store.get('settings') || {}).accounts) || {};
  return {
    clientKey: (acc.tkClientKey || '').trim(),
    clientSecret: (acc.tkClientSecret || '').trim(),
    redirectUri: (acc.tkRedirectUri || DEFAULT_TK_REDIRECT).trim(),
    authBase: (acc.tkAuthBase || DEFAULT_TK_AUTH).replace(/\/+$/, ''),
    apiBase: (acc.tkApiBase || publisher.DEFAULT_TK_API).replace(/\/+$/, ''),
    // Path A (own it): a serverless proxy holds the client secret and does the
    // token exchange, so churches never carry the secret. When set, the secret
    // is not required app-side. tkProxyToken is an optional shared guard.
    tokenProxy: (acc.tkTokenProxy || '').trim(),
    proxyToken: (acc.tkProxyToken || '').trim(),
  };
}

function upCfg(store) {
  const acc = ((store.get('settings') || {}).accounts) || {};
  return {
    apiKey: (acc.upApiKey || '').trim(),
    apiBase: (acc.upApiBase || publisher.DEFAULT_UP_API).replace(/\/+$/, ''),
  };
}

/*
 * A Zernio key given to the SERVER (its environment) rather than pasted on a
 * phone: whoever runs the studio sets it once and nobody is ever asked for it.
 * A key saved in the app wins, as with the Groq key (main.js envGroqKey).
 * LATE_API_KEY is Zernio's name from before it was renamed.
 */
const envZoKey = () => String(process.env.ZERNIO_API_KEY || process.env.MW_ZERNIO_KEY || process.env.LATE_API_KEY || '').trim();
const envZoKeyFb = () => String(process.env.ZERNIO_API_KEY_FB || process.env.MW_ZERNIO_KEY_FB || '').trim();

function zoCfg(store, platform) {
  const acc = ((store.get('settings') || {}).accounts) || {};
  const mainKey = (acc.zoApiKey || '').trim() || envZoKey();
  const fbKey = (acc.zoApiKeyFb || '').trim() || envZoKeyFb();
  // Facebook + Instagram use their OWN free Zernio account (its own 2 free slots)
  // so all four platforms stay under Zernio's 2-account free cap — TikTok/YouTube
  // on the primary key, FB/IG on the secondary. Falls back to the primary key
  // when no secondary is set (a church that only posts to FB/IG needs just one).
  const isMeta = platform === 'facebook' || platform === 'instagram';
  return {
    apiKey: (isMeta && fbKey) ? fbKey : mainKey,
    apiBase: (acc.zoApiBase || process.env.ZERNIO_API_BASE || publisher.DEFAULT_ZO_API).replace(/\/+$/, ''),
    redirectUrl: (acc.zoRedirectUrl || DEFAULT_ZO_REDIRECT).trim(),
  };
}

/** Zernio's account list is an array (or wrapped in {accounts|data}); pull the
 *  first linked account for a given platform out of whatever shape comes back. */
function zoAccountList(listed) {
  const arr = (listed && (listed.accounts || listed.data || listed.profiles)) || (Array.isArray(listed) ? listed : []);
  return Array.isArray(arr) ? arr : [];
}
function zoAccountId(a) { return a && (a._id || a.id || a.accountId); }
function zoAccountOf(listed, platform) {
  return zoAccountList(listed).find((a) =>
    String((a && (a.platform || a.provider)) || '').toLowerCase() === platform && zoAccountId(a)) || null;
}
/* a song by this artist (every word of the name in its artist line: "Travis Greene" — not "Greene Day") */
function byArtist(song, name) {
  const words = String(name || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const who = String((song && song.artist) || '').toLowerCase();
  return words.length > 0 && words.every((w) => who.includes(w));
}
/* Instagram songs out of whatever shape Zernio's reply has ({ audio: [...] }, { data: [...] }, …) */
function igSongsOf(got) {
  const listIn = (o, depth = 0) => {
    if (Array.isArray(o)) return o;
    if (!o || typeof o !== 'object' || depth > 2) return [];
    for (const k of ['audio', 'audios', 'tracks', 'results', 'items', 'data', 'songs', 'music']) { const v = listIn(o[k], depth + 1); if (v.length) return v; }
    return [];
  };
  return listIn(got).map((x) => {
    const a = (x && (x.audio || x.track || x)) || {};
    const id = a.audioId || a.audio_id || a.audioAssetId || a.audio_asset_id || a.id || a._id;
    if (!id) return null;
    const ms = a.durationInMs || a.duration_in_ms || a.durationMs || a.duration_ms;
    const secs = +(a.durationSec || a.duration_sec || a.durationInSeconds || (ms ? ms / 1000 : a.duration)) || 0;
    const media = /\.(mp3|m4a|mp4|aac|wav|ogg)(\?|$)/i;
    const pre = a.downloadUrl || a.download_url || a.previewUrl || a.preview_url || a.audioUrl || a.audio_url || a.progressiveDownloadUrl || a.fastStartProgressiveDownloadUrl
      || (media.test(String(a.url || '')) ? a.url : '');
    return {
      id: String(id),
      title: String(a.title || a.name || a.songTitle || a.song_title || 'Song').slice(0, 120),
      artist: String(a.displayArtist || a.display_artist || a.artist || a.artistName || a.artist_name || a.igUsername || a.ig_username
        || (a.artists && a.artists[0] && (a.artists[0].name || a.artists[0])) || '').slice(0, 120),
      cover: String(a.coverArtworkThumbnailUrl || a.coverArtworkUri || a.cover_artwork_uri || a.coverArtworkUrl || a.coverUrl || a.cover_url || a.thumbnailUrl || a.imageUrl || a.artworkUrl || '') || null,
      preview: String(pre || '') || null,
      seconds: Math.round(secs > 10000 ? secs / 1000 : secs),
    };
  }).filter(Boolean).slice(0, 40);
}
/** Stable per-platform id prefix for Zernio "easy connect" accounts. */
const ZO_ID_PREFIX = { tiktok: 'zotk_', youtube: 'zoyt_', facebook: 'zofb_', instagram: 'zoig_' };
function zoIdPrefix(platform) { return ZO_ID_PREFIX[platform] || 'zo_'; }
const ZO_LABEL = { tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram' };
const ZO_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook'];
const ZO_FREE = 2;   // linked accounts a free Zernio account holds
const ZO_MAX_KEYS = 3;   // free Zernio accounts the studio pools (6 places: TikTok, YouTube, Instagram, Facebook ×2 …)

/** An Upload-Post platform entry is an object, a bare handle string, or absent. */
function upAccountOf(profile, platform = 'tiktok') {
  const a = profile && profile.social_accounts && profile.social_accounts[platform];
  if (!a) return null;
  if (typeof a === 'string') return { handle: a };
  return (a.username || a.handle || a.display_name) ? a : null;
}
function upTikTokOf(profile) { return upAccountOf(profile, 'tiktok'); }
const UP_LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' };
const UP_ID_PREFIX = { tiktok: 'uptk_', instagram: 'upig_', youtube: 'upyt_', facebook: 'upfb_' };

/* --------------------------- Google sign-in (YouTube) --------------------------- */

/**
 * Google's OAuth for desktop apps: open the sign-in page in the SYSTEM
 * browser (Google blocks embedded windows), catch the redirect on a local
 * loopback server, and hand back the authorization code (PKCE-protected).
 * opts.openUrl is injectable so tests can play the part of the browser.
 */
/**
 * What Google's refusals actually mean, and what to do about them.
 *
 * "access_denied" on an unverified app almost never means the user pressed
 * Cancel — it means Google blocked the sign-in because that Google account is
 * not on the app's TEST USERS list. The block page says "has not completed the
 * Google verification process", which reads like something is wrong with the
 * app, and sends people looking in the wrong place entirely.
 *
 * The client id is quoted in the message on purpose: an OAuth client belongs to
 * ONE Cloud project, and the commonest version of this is a second project being
 * set up while the app still holds a client from the first. Seeing the id makes
 * that mismatch obvious instead of invisible.
 */
function googleAuthError(kind, clientId, email) {
  const who = email ? `the Google account ${email}` : 'that Google account';
  const idNote = clientId
    ? `\n\nThe app is using client id:\n  ${clientId}\nMake sure you are looking at the SAME Google Cloud project that owns that id — a client from a different project will always be refused.`
    : '';
  if (kind === 'access_denied') {
    return 'Google would not let that account in. While a Google app is unverified it only works for '
      + `accounts on its TEST USERS list, and ${who} is not on it yet.\n\n`
      + 'To fix it, in console.cloud.google.com:\n'
      + '  1. Google Auth Platform → Audience\n'
      + `  2. under "Test users", press + Add users and add ${email || 'that Gmail address'}\n`
      + '  3. save, wait a minute, then press Connect again.\n\n'
      + '(Publishing the app instead also works, but Google then asks for verification — adding yourself as a test user is the quick way and is fine for one church.)'
      + idNote;
  }
  if (kind === 'timeout') {
    return 'Google never sent the sign-in back.\n\n'
      + 'If the browser showed "Access blocked … has not completed the Google verification process", that is Google refusing the account rather than a fault here: '
      + `add ${email || 'your Gmail address'} under Google Auth Platform → Audience → Test users in console.cloud.google.com, then press Connect again.`
      + idNote;
  }
  return 'Google sign-in failed (' + kind + ').' + idNote;
}

function captureGoogleCode({ authBase, clientId, openUrl, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = 'mw_' + crypto.randomBytes(8).toString('hex');
    let redirectUri = '';
    let timer = null;
    let settled = false;

    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.statusCode = 404; return res.end(); }
      res.setHeader('content-type', 'text/html');
      res.end('<html><body style="font-family:sans-serif;background:#12151d;color:#eee;display:grid;place-items:center;height:96vh">' +
        '<div style="text-align:center"><h2>✅ Connected</h2><p>You can close this tab and go back to the Church Space.</p></div></body></html>');
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const st = u.searchParams.get('state');
      finish(err ? new Error(googleAuthError(err, clientId))
        : (!code || st !== state) ? new Error('Google returned no sign-in code — try again.')
        : null, code);
    });

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch (e) {}
      err ? reject(err) : resolve({ code, redirectUri, verifier });
    };

    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${server.address().port}`;
      const authUrl = authBase + '?' + new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
        scope: YT_SCOPES, access_type: 'offline', prompt: 'consent',
        code_challenge: challenge, code_challenge_method: 'S256', state,
      }).toString();
      const open = openUrl || ((url) => {
        if (!shell) throw new Error('No browser available to open Google sign-in.');
        return shell.openExternal(url);
      });
      Promise.resolve().then(() => open(authUrl))
        .catch((e) => finish(new Error('Could not open the browser for Google sign-in: ' + e.message)));
      timer = setTimeout(() => finish(new Error(googleAuthError('timeout', clientId))), timeoutMs);
      timer.unref?.();
    });
    server.on('error', (e) => finish(new Error('Could not start the sign-in listener: ' + e.message)));
  });
}

/* ------------------------------- OAuth window ------------------------------- */

/**
 * Open the Facebook login dialog in a child window and capture the user
 * access token from the redirect fragment. Resolves { token } or rejects
 * (user closed the window / Facebook returned an error).
 */
function captureUserToken({ oauthBase, appId, parent }) {
  return new Promise((resolve, reject) => {
    if (!BrowserWindow) return reject(new Error('Account linking needs the app window (Electron).'));
    const redirectUri = `${oauthBase}/connect/login_success.html`;
    const state = 'mw_' + Math.random().toString(36).slice(2);
    const authUrl = `${oauthBase}/v19.0/dialog/oauth?` + new URLSearchParams({
      client_id: appId, redirect_uri: redirectUri, response_type: 'token',
      scope: OAUTH_SCOPES, state, display: 'popup',
    }).toString();

    const win = new BrowserWindow({
      width: 700, height: 780, parent: parent || undefined, autoHideMenuBar: true,
      title: 'Connect Facebook', backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    let settled = false;
    const finish = (err, token) => {
      if (settled) return;
      settled = true;
      try { win.destroy(); } catch (e) {}
      err ? reject(err) : resolve({ token });
    };

    const checkUrl = (url) => {
      if (!url || !url.startsWith(redirectUri)) return;
      let u;
      try { u = new URL(url); } catch (e) { return; }
      const frag = new URLSearchParams((u.hash || '').replace(/^#/, ''));
      const query = u.searchParams;
      const token = frag.get('access_token') || query.get('access_token');
      const rState = frag.get('state') || query.get('state');
      const errMsg = frag.get('error_description') || query.get('error_description') ||
                     frag.get('error') || query.get('error');
      if (token && (!rState || rState === state)) return finish(null, token);
      if (errMsg) return finish(new Error('Facebook: ' + errMsg.replace(/\+/g, ' ')));
      finish(new Error('Facebook returned no access token — try connecting again.'));
    };

    win.webContents.on('will-redirect', (e, url) => checkUrl(url));
    win.webContents.on('did-navigate', (e, url) => checkUrl(url));
    win.webContents.on('did-redirect-navigation', (e, url) => checkUrl(url));
    win.on('closed', () => finish(new Error('The Facebook window was closed before finishing.')));
    win.loadURL(authUrl).catch((e) => finish(new Error('Could not open Facebook login: ' + e.message)));
  });
}

/**
 * Open TikTok's login/consent page in a child window and capture the
 * authorization code from the redirect (code flow + PKCE — TikTok's variant
 * hex-encodes the SHA256 challenge instead of base64url). The registered
 * redirect URI never has to actually resolve: the window intercepts the
 * navigation before it is followed. Resolves { code, verifier, redirectUri }.
 */
function captureTikTokCode({ authBase, clientKey, redirectUri, parent }) {
  return new Promise((resolve, reject) => {
    if (!BrowserWindow) return reject(new Error('Account linking needs the app window (Electron).'));
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
    const state = 'mw_' + crypto.randomBytes(8).toString('hex');
    const authUrl = `${authBase}/v2/auth/authorize/?` + new URLSearchParams({
      client_key: clientKey, redirect_uri: redirectUri, response_type: 'code',
      scope: TK_SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();

    const win = new BrowserWindow({
      width: 700, height: 820, parent: parent || undefined, autoHideMenuBar: true,
      title: 'Connect TikTok', backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });

    let settled = false;
    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      try { win.destroy(); } catch (e) {}
      err ? reject(err) : resolve({ code, verifier, redirectUri });
    };

    const checkUrl = (url) => {
      if (!url || !url.startsWith(redirectUri)) return;
      let u;
      try { u = new URL(url); } catch (e) { return; }
      const q = u.searchParams;
      const code = q.get('code');
      const rState = q.get('state');
      const errMsg = q.get('error_description') || q.get('error');
      if (code && (!rState || rState === state)) return finish(null, code);
      if (errMsg) return finish(new Error('TikTok: ' + String(errMsg).replace(/\+/g, ' ')));
      finish(new Error('TikTok returned no sign-in code — try connecting again.'));
    };

    win.webContents.on('will-redirect', (e, url) => checkUrl(url));
    win.webContents.on('will-navigate', (e, url) => checkUrl(url));
    win.webContents.on('did-navigate', (e, url) => checkUrl(url));
    win.webContents.on('did-redirect-navigation', (e, url) => checkUrl(url));
    win.on('closed', () => finish(new Error('The TikTok window was closed before finishing.')));
    win.loadURL(authUrl).catch((e) => finish(new Error('Could not open TikTok login: ' + e.message)));
  });
}

/* ------------------------------ Graph API steps ----------------------------- */

/** Swap a short-lived user token for a long-lived one (needs the app secret). */
async function exchangeLongLived({ graphBase, appId, appSecret, token }) {
  if (!appSecret) return token; // dev-mode fallback: short token still works for ~2h
  const q = new URLSearchParams({
    grant_type: 'fb_exchange_token', client_id: appId,
    client_secret: appSecret, fb_exchange_token: token,
  }).toString();
  const res = await getJson(`${graphBase}/oauth/access_token?${q}`);
  if (!res || !res.access_token) throw new Error('Facebook did not return a long-lived token.');
  return res.access_token;
}

/** List every Page the user manages (follows paging), with linked IG accounts. */
async function listPages({ graphBase, userToken }) {
  const fields = 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}';
  let url = `${graphBase}/me/accounts?` + new URLSearchParams({ fields, limit: '100', access_token: userToken });
  const pages = [];
  for (let hop = 0; url && hop < 10; hop++) {
    const res = await getJson(url);
    for (const p of (res.data || [])) {
      if (!p.id || !p.access_token) continue;
      const ig = p.instagram_business_account || null;
      pages.push({
        pageId: p.id, name: p.name || 'Untitled Page', token: p.access_token,
        pictureUrl: (p.picture && p.picture.data && p.picture.data.url) || '',
        ig: ig && ig.id ? { igUserId: ig.id, username: ig.username || '', pictureUrl: ig.profile_picture_url || '' } : null,
      });
    }
    url = res.paging && res.paging.next ? res.paging.next : null;
  }
  return pages;
}

/* ------------------------------ account records ----------------------------- */

class Accounts {
  constructor(store) {
    this.store = store;
    if (!Array.isArray(this.store.get('socialAccounts'))) this.store.set('socialAccounts', []);
    this._pending = new Map(); // connectId -> pages (with tokens) awaiting the user's pick
  }

  /** All stored accounts WITH tokens — for the scheduler/publisher (main only). */
  all() { return this.store.get('socialAccounts') || []; }

  /** Renderer-safe list: everything except the raw tokens and app secrets. */
  list() {
    return this.all().map(({ token, clientSecret, proxyToken, ...rest }) => ({ ...rest, connected: !!token }));
  }

  byId(id) { return this.all().find((a) => a.id === id) || null; }

  remove(id) {
    const gone = this.byId(id);
    if (gone && gone.via === 'zernio' && gone.zoAccountId) {
      this.store.set('zoRemoved', Array.from(new Set([...(this.store.get('zoRemoved') || []), String(gone.zoAccountId)])).slice(-50));
    }
    this.store.set('socialAccounts', this.all().filter((a) => a.id !== id));
    return true;
  }

  _upsert(record) {
    const all = this.all();
    const idx = all.findIndex((a) => a.id === record.id);
    if (idx === -1) all.push(record);
    else all[idx] = { ...all[idx], ...record };
    this.store.set('socialAccounts', all);
    return record;
  }

  /**
   * Full connect flow. Returns { connectId, pages } where pages are
   * renderer-safe (no tokens; avatars inlined as data URIs).
   * opts.capture — injectable token capture for tests.
   */
  async connectFacebook(parentWindow, opts = {}) {
    const { appId, appSecret, oauthBase, graphBase } = cfg(this.store);
    if (!appId) {
      throw new Error('Add your Meta App ID first (Connect window → “App setup”, or Settings → Social accounts).');
    }
    const capture = opts.capture || captureUserToken;
    const { token: shortToken } = await capture({ oauthBase, appId, parent: parentWindow });
    const userToken = await exchangeLongLived({ graphBase, appId, appSecret, token: shortToken });
    const pages = await listPages({ graphBase, userToken });
    if (!pages.length) {
      throw new Error('No Facebook Pages found on this account. You must be an admin of the Page you want to post to.');
    }
    for (const p of pages) {
      p.picture = await fetchAvatarDataUri(p.pictureUrl);
      if (p.ig) p.ig.picture = await fetchAvatarDataUri(p.ig.pictureUrl);
    }
    const connectId = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    this._pending.set(connectId, pages);
    // Pending picks expire after 10 minutes.
    setTimeout(() => this._pending.delete(connectId), 10 * 60 * 1000).unref?.();
    return {
      connectId,
      pages: pages.map((p) => ({
        pageId: p.pageId, name: p.name, picture: p.picture,
        ig: p.ig ? { igUserId: p.ig.igUserId, username: p.ig.username, picture: p.ig.picture } : null,
      })),
    };
  }

  /**
   * Save the accounts the user picked from a connect flow.
   * selections: [{ type: 'facebook'|'instagram', pageId }]
   */
  addFromConnect(connectId, selections) {
    const pages = this._pending.get(connectId);
    if (!pages) throw new Error('This connect session expired — hit “Connect account” again.');
    const now = new Date().toISOString();
    const added = [];
    for (const sel of (selections || [])) {
      const page = pages.find((p) => p.pageId === sel.pageId);
      if (!page) continue;
      if (sel.type === 'facebook') {
        added.push(this._upsert({
          id: 'fb_' + page.pageId, platform: 'facebook', name: page.name,
          pageId: page.pageId, token: page.token, picture: page.picture || '', connectedAt: now,
        }));
      } else if (sel.type === 'instagram' && page.ig) {
        added.push(this._upsert({
          id: 'ig_' + page.ig.igUserId, platform: 'instagram',
          name: page.ig.username ? '@' + page.ig.username : page.name,
          igUserId: page.ig.igUserId, pageId: page.pageId, token: page.token,
          picture: page.ig.picture || page.picture || '', connectedAt: now,
        }));
      }
    }
    if (!added.length) throw new Error('Nothing selected to connect.');
    return added.map(({ token, ...rest }) => rest);
  }

  /**
   * Connect a YouTube channel: Google sign-in in the system browser (PKCE +
   * loopback), code → refresh token, channel looked up and stored. Returns
   * the renderer-safe account record. opts.openUrl injectable for tests.
   */
  async connectYouTube(parentWindow, opts = {}) {
    const { clientId, clientSecret, authBase, tokenBase, apiBase } = ytCfg(this.store);
    if (!clientId || !clientSecret) {
      throw new Error('Add your Google OAuth client first (Connect window → “App setup”, or Settings → Social accounts).');
    }
    const { code, redirectUri, verifier } = await captureGoogleCode({
      authBase, clientId, openUrl: opts.openUrl, timeoutMs: opts.timeoutMs,
    });
    const tok = await publisher.postForm(tokenBase, {
      code, client_id: clientId, client_secret: clientSecret,
      redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    });
    if (!tok || !tok.refresh_token) {
      throw new Error('Google did not return a long-term key. Remove the app at myaccount.google.com/permissions, then connect again.');
    }
    const ch = await getJson(`${apiBase}/youtube/v3/channels?part=snippet&mine=true`,
      { headers: { authorization: 'Bearer ' + tok.access_token } });
    const item = ch && ch.items && ch.items[0];
    if (!item || !item.id) throw new Error('No YouTube channel found on this Google account.');
    const thumbs = (item.snippet && item.snippet.thumbnails) || {};
    const picture = await fetchAvatarDataUri((thumbs.default && thumbs.default.url) || '');
    const rec = this._upsert({
      id: 'yt_' + item.id, platform: 'youtube',
      name: (item.snippet && item.snippet.title) || 'YouTube channel',
      channelId: item.id, token: tok.refresh_token,
      clientId, clientSecret, picture, connectedAt: new Date().toISOString(),
    });
    const { token, clientSecret: cs, ...safe } = rec;
    return { ...safe, connected: true };
  }

  /**
   * Connect a TikTok account: TikTok login in a child window (code flow +
   * TikTok's hex PKCE), code → refresh token, profile looked up and stored.
   * Returns the renderer-safe account record. opts.capture injectable.
   */
  async connectTikTok(parentWindow, opts = {}) {
    const { clientKey, clientSecret, redirectUri, authBase, apiBase, tokenProxy, proxyToken } = tkCfg(this.store);
    if (!clientKey) {
      throw new Error('Add your TikTok Client Key first (Connect window → “App setup”, or Settings → Social accounts).');
    }
    if (!tokenProxy && !clientSecret) {
      throw new Error('Add your TikTok Client Secret, or a token-proxy URL for distribution (Settings → Social accounts).');
    }
    const capture = opts.capture || captureTikTokCode;
    const { code, verifier, redirectUri: usedRedirect } =
      await capture({ authBase, clientKey, redirectUri, parent: parentWindow });
    // Path A: swap the code for tokens through the proxy (secret stays on the
    // Worker). Otherwise do the direct exchange with the local secret.
    let tok;
    if (tokenProxy) {
      const hdrs = proxyToken ? { 'x-app-token': proxyToken } : {};
      tok = (await publisher.postJson(tokenProxy, {
        grant_type: 'authorization_code', code,
        redirect_uri: usedRedirect || redirectUri, code_verifier: verifier,
      }, hdrs)).json;
    } else {
      tok = await publisher.postForm(`${apiBase}/v2/oauth/token/`, {
        client_key: clientKey, client_secret: clientSecret, code,
        grant_type: 'authorization_code', redirect_uri: usedRedirect || redirectUri, code_verifier: verifier,
      });
    }
    if (!tok || !tok.access_token) {
      throw new Error('TikTok: ' + ((tok && (tok.error_description || tok.error)) || 'no access token returned — try connecting again.'));
    }
    if (!tok.refresh_token || !tok.open_id) {
      throw new Error('TikTok did not return a long-term key — remove the app under TikTok Settings → Security → Apps, then connect again.');
    }
    const info = await getJson(`${apiBase}/v2/user/info/?fields=open_id,union_id,avatar_url,display_name`,
      { headers: { authorization: 'Bearer ' + tok.access_token } });
    const user = (info && info.data && info.data.user) || {};
    // The @username comes from the Content Posting API — used for post links.
    let username = '';
    try {
      const ci = await publisher.postJson(`${apiBase}/v2/post/publish/creator_info/query/`, {},
        { authorization: 'Bearer ' + tok.access_token });
      username = (ci.json && ci.json.data && ci.json.data.creator_username) || '';
    } catch (e) { /* cosmetic — post links fall back to the profile URL */ }
    const picture = await fetchAvatarDataUri(user.avatar_url || '');
    const rec = this._upsert({
      id: 'tk_' + tok.open_id, platform: 'tiktok',
      name: user.display_name || (username ? '@' + username : 'TikTok account'),
      openId: tok.open_id, username, token: tok.refresh_token,
      // Proxy mode: the secret lives on the Worker, so never store it here.
      clientKey, clientSecret: tokenProxy ? '' : clientSecret,
      tokenProxy: tokenProxy || '', proxyToken: tokenProxy ? proxyToken : '',
      picture, connectedAt: new Date().toISOString(),
    });
    const { token, clientSecret: cs, proxyToken: pt, ...safe } = rec;
    return { ...safe, connected: true };
  }

  /**
   * "Easy connect" TikTok via Upload-Post: their developer app is already
   * audited by TikTok, so one pasted API key replaces the whole TikTok portal
   * setup AND public posting works immediately. Flow: verify the key → reuse
   * (or create) a profile → if TikTok isn't linked yet, open Upload-Post's
   * secure linking page in the browser and poll until the user finishes.
   * Returns the renderer-safe account record. opts.openUrl / pollMs / timeoutMs
   * injectable for tests.
   */
  async connectUploadPost(parentWindow, opts = {}) {
    const platform = opts.platform || 'tiktok';
    const label = UP_LABEL[platform] || platform;
    const { apiKey, apiBase } = upCfg(this.store);
    if (!apiKey) {
      throw new Error('Paste your Upload-Post API key first (free at upload-post.com → Dashboard → API Keys).');
    }
    const auth = { authorization: 'Apikey ' + apiKey };

    let listed;
    try {
      listed = await getJson(`${apiBase}/uploadposts/users`, { headers: auth });
    } catch (e) {
      throw new Error('Upload-Post did not accept the API key (' + e.message + ') — copy it again from upload-post.com → Dashboard → API Keys.');
    }
    const profiles = (listed && listed.profiles) || [];

    // Reuse a profile that already has this platform linked; otherwise take the
    // first profile (or create one) and send the user to the linking page.
    let profile = profiles.find((p) => upAccountOf(p, platform)) || profiles[0] || null;
    if (!profile) {
      const made = await publisher.postJson(`${apiBase}/uploadposts/users`, { username: 'church-media' }, auth);
      profile = (made.json && made.json.profile) || { username: 'church-media' };
    }

    if (!upAccountOf(profile, platform)) {
      const jwt = await publisher.postJson(`${apiBase}/uploadposts/users/generate-jwt`,
        { username: profile.username, platforms: [platform] }, auth);
      const linkUrl = jwt.json && jwt.json.access_url;
      if (!linkUrl) throw new Error('Upload-Post did not return a linking page — try again.');
      const open = opts.openUrl || ((url) => {
        if (!shell) throw new Error('No browser available to open the ' + label + ' linking page.');
        return shell.openExternal(url);
      });
      await Promise.resolve().then(() => open(linkUrl));

      // Wait for the user to finish linking on the Upload-Post page.
      const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
      const deadline = Date.now() + (opts.timeoutMs != null ? opts.timeoutMs : 5 * 60 * 1000);
      while (!upAccountOf(profile, platform)) {
        if (Date.now() > deadline) {
          throw new Error(label + ' was never linked on the Upload-Post page — hit Connect and try again.');
        }
        await new Promise((r) => setTimeout(r, pollMs));
        const got = await getJson(`${apiBase}/uploadposts/users/${encodeURIComponent(profile.username)}`, { headers: auth });
        if (got && got.profile) profile = got.profile;
      }
    }

    const acct = upAccountOf(profile, platform);
    const handle = (acct.handle || acct.username || '').replace(/^@/, '');
    const picture = await fetchAvatarDataUri(acct.social_images || '');
    const rec = this._upsert({
      id: (UP_ID_PREFIX[platform] || 'up_') + profile.username, platform, via: 'uploadpost',
      name: acct.display_name || (handle ? '@' + handle : label + ' account'),
      upUser: profile.username, username: handle,
      token: apiKey, picture, connectedAt: new Date().toISOString(),
    });
    const { token, ...safe } = rec;
    return { ...safe, connected: true };
  }

  /** The original TikTok-only entry point, kept so nothing that calls it breaks. */
  async connectTikTokEasy(parentWindow, opts = {}) {
    return this.connectUploadPost(parentWindow, { ...opts, platform: 'tiktok' });
  }

  /**
   * "Easy connect — free & unlimited" via Zernio, for TikTok (default) or
   * YouTube (`opts.platform:'youtube'`). Zernio's developer apps are already
   * audited/verified, so one pasted (free) API key replaces the whole TikTok
   * portal / Google Cloud Console setup, public posting works immediately, AND
   * the free plan has no monthly post cap (2 connected accounts free — a church
   * uses one for TikTok + one for YouTube). Flow: verify the key by listing
   * accounts → if the platform isn't linked yet, open Zernio's hosted connect
   * page and poll until the user finishes → store the linked account.
   * opts.openUrl / pollMs / timeoutMs injectable for tests. Returns the
   * renderer-safe account record.
   */
  /**
   * What went wrong opening the connect page, in words the operator can act on.
   *
   * The one that matters is the free tier running out: Zernio gives two linked
   * accounts free, and the third is refused with a payment demand. That is not a
   * fault to debug — it is a decision to make — so the message says which two
   * are already using the slots and points at the way that costs nothing: a
   * second free Zernio account (Zernio is the only way in — no direct route).
   */
  _connectErrorText(raw, label, listed) {
    const msg = String(raw || '');
    if (/payment|free_tier_exceeded|402|more than 2 accounts/i.test(msg)) {
      const names = (Array.isArray(listed) ? listed : (listed && (listed.accounts || listed.data)) || [])
        .map((a) => (a.platform || a.provider || '?')).filter(Boolean);
      const using = names.length ? ` They are being used by ${names.join(' and ')}.` : '';
      return `Zernio's free plan covers 2 linked accounts and both are taken.${using} `
        + `To put ${label} on too, make another free Zernio account (another email) and paste its key as your second Zernio key — `
        + 'or unlink one of the two on zernio.com.';
    }
    return 'Zernio could not start the ' + label + ' connect flow (' + msg + ').';
  }

  async connectZernio(parentWindow, opts = {}) {
    const platform = ['youtube', 'facebook', 'instagram'].includes(opts.platform) ? opts.platform : 'tiktok';
    const label = ZO_LABEL[platform] || 'TikTok';
    const { apiKey, apiBase, redirectUrl } = zoCfg(this.store, platform);
    if (!apiKey) {
      throw new Error('Paste your Zernio API key first (free at zernio.com → API keys).');
    }
    const auth = { authorization: 'Bearer ' + apiKey };

    const listAccounts = async () => {
      try {
        return await getJson(`${apiBase}/accounts`, { headers: auth });
      } catch (e) {
        throw new Error('Zernio did not accept the API key (' + e.message + ') — copy it again from zernio.com → API keys.');
      }
    };

    let listed = await listAccounts();
    let acct = zoAccountOf(listed, platform);

    if (!acct) {
      /*
       * Every linked account belongs to a PROFILE, and the connect endpoint will
       * not open without being told which one — leaving it out fails the request
       * before it starts ("expected string, received undefined", param profileId),
       * for every platform alike. There is one profile on a normal free account,
       * so the default is the right answer; the first is a fallback for the day
       * a church makes a second.
       */
      let profileId = '';
      try {
        const profs = await getJson(`${apiBase}/profiles`, { headers: auth });
        const list = Array.isArray(profs) ? profs : (profs && (profs.profiles || profs.data)) || [];
        const chosen = list.find((p) => p.isDefault || p.is_default) || list[0];
        profileId = chosen ? String(chosen._id || chosen.id || chosen.profileId || '') : '';
      } catch (e) { /* older API with no profiles — fall through without one */ }

      let linkUrl = '';
      try {
        const q = { redirect_url: redirectUrl };
        if (profileId) q.profileId = profileId;
        const gen = await getJson(`${apiBase}/connect/${platform}?` +
          new URLSearchParams(q), { headers: auth });
        linkUrl = gen && (gen.url || gen.authUrl || gen.connectUrl || gen.access_url);
      } catch (e) {
        throw new Error(this._connectErrorText(e.message, label, listed));
      }
      if (!linkUrl) throw new Error('Zernio did not return a ' + label + ' connect link — try again.');
      const open = opts.openUrl || ((url) => {
        if (!shell) throw new Error('No browser available to open the ' + label + ' connect page.');
        return shell.openExternal(url);
      });
      await Promise.resolve().then(() => open(linkUrl));

      const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
      const deadline = Date.now() + (opts.timeoutMs != null ? opts.timeoutMs : 5 * 60 * 1000);
      while (!acct) {
        if (Date.now() > deadline) {
          throw new Error(label + ' was never linked on the Zernio page — hit Connect and try again.');
        }
        await new Promise((r) => setTimeout(r, pollMs));
        listed = await listAccounts();
        acct = zoAccountOf(listed, platform);
      }
    }

    const accountId = zoAccountId(acct);
    // kept on purpose (Connect, a sign-in): no longer one that was removed
    const removed = this.store.get('zoRemoved') || [];
    if (removed.includes(String(accountId))) this.store.set('zoRemoved', removed.filter((x) => x !== String(accountId)));
    const handle = String(acct.username || acct.handle || acct.name || '').replace(/^@/, '');
    const picture = await fetchAvatarDataUri(acct.picture || acct.profileImage || acct.avatar || acct.social_images || '');
    const rec = this._upsert({
      id: zoIdPrefix(platform) + accountId, platform, via: 'zernio',
      name: acct.displayName || acct.display_name || (handle ? '@' + handle : label + ' account'),
      zoAccountId: accountId, username: handle,
      token: apiKey, picture, connectedAt: new Date().toISOString(),
    });
    const { token, ...safe } = rec;
    return { ...safe, connected: true };
  }

  /*
   * EASY CONNECT FROM A PHONE, IN TWO HALVES.
   *
   * connectZernio() above opens Zernio's page on THIS machine and then waits
   * here for up to five minutes. From the Cloud Studio neither half works: the
   * page has to open on the phone (a server has no browser to open it in), and
   * a phone app sent to the background to sign in to TikTok may never hear a
   * five-minute answer come back. So it is split. linkStart hands back the link
   * to open (or the account, when it is linked already); linkClaim looks once,
   * and keeps the account if it is there. The phone opens the link, and claims
   * when it comes back to the front.
   */
  /*
   * ►► EVERY ZERNIO KEY IS ONE POOL. ◄◄ Zernio's free plan holds 2 linked
   * accounts per Zernio account, so a church with TikTok, Instagram and two
   * Facebook pages uses two free Zernio accounts — and should not have to
   * work out which account goes on which. Each Connect goes on whichever key
   * still has a free place (and, for a second Facebook page, one that does not
   * hold a Facebook page already, or a new profile in it — Zernio keeps one
   * account per platform in each profile). Each linked account keeps the key
   * it was found under, which is the one it posts with.
   */
  async _zoPool() {
    const acc = ((this.store.get('settings') || {}).accounts) || {};
    const keys = Array.from(new Set([(acc.zoApiKey || '').trim() || envZoKey(), (acc.zoApiKeyFb || '').trim() || envZoKeyFb(), (acc.zoApiKey3 || '').trim()].filter(Boolean)));
    const { apiBase } = zoCfg(this.store, 'tiktok');
    if (!keys.length) throw new Error('Add your Zernio key first (free at zernio.com → API keys).');
    const pool = [];
    for (const key of keys) {
      try { pool.push({ key, apiBase, accounts: zoAccountList(await getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + key } })) }); }
      catch (e) { if (keys.length === 1) throw new Error('Zernio did not accept the key (' + e.message + ') — copy it again from zernio.com → API keys.'); }
    }
    if (!pool.length) throw new Error('Zernio did not accept your keys — copy them again from zernio.com → API keys.');
    return pool;
  }
  /* The accounts of one platform across the pool, each with the key it is under. */
  _zoFind(pool, plat) {
    const out = [];
    for (const k of pool) for (const a of k.accounts) {
      if (String((a && (a.platform || a.provider)) || '').toLowerCase() === plat && zoAccountId(a)) out.push({ acct: a, key: k.key });
    }
    return out;
  }
  _zoStored() { return new Set(this.all().filter((a) => a.via === 'zernio').map((a) => String(a.zoAccountId))); }

  async zernioLinkStart(platform, opts = {}) {
    const plat = ['youtube', 'facebook', 'instagram'].includes(platform) ? platform : 'tiktok';
    const label = ZO_LABEL[plat] || 'TikTok';
    if (opts.relink) return this._zoRelinkInstagram(opts.relink, opts);
    const another = !!opts.another;
    // "Set up everything" sends each sign-in back to the studio's own page, which opens the next one
    const redirectUrl = opts.redirectUrl || zoCfg(this.store, plat).redirectUrl;
    const pool = await this._zoPool();
    const stored = this._zoStored();
    const removed = new Set(this.store.get('zoRemoved') || []);
    const found = this._zoFind(pool, plat);
    const idOf = (f) => String(zoAccountId(f.acct));
    // already on Zernio: kept, no sign-in (for "another", one not kept here yet). One
    // removed here is never brought back this way — a sign-in lets the person choose.
    const ready = another ? found.find((f) => !stored.has(idOf(f)) && !removed.has(idOf(f)))
      : (found.find((f) => stored.has(idOf(f))) || found.find((f) => !removed.has(idOf(f))));
    if (ready) return { account: await this._zoKeep(plat, ready.acct, ready.key) };
    // the key with room: a free place first, then one without this platform, then the emptiest
    const has = (k) => k.accounts.some((a) => String(a.platform || a.provider || '').toLowerCase() === plat);
    const pick = pool.map((k, i) => ({ k, i })).sort((x, y) =>
      ((x.k.accounts.length >= ZO_FREE ? 1 : 0) - (y.k.accounts.length >= ZO_FREE ? 1 : 0))
      || ((has(x.k) ? 1 : 0) - (has(y.k) ? 1 : 0))
      || (x.k.accounts.length - y.k.accounts.length) || (x.i - y.i))[0].k;
    const auth = { authorization: 'Bearer ' + pick.key };
    const full = (e) => e && (e.status === 402 || /payment|free_tier_exceeded|402|more than 2 accounts/i.test(e.message || ''));
    const fullError = () => {
      const more = pool.length < ZO_MAX_KEYS;
      const err = new Error(more
        ? `Your free Zernio account${pool.length > 1 ? 's are' : ' is'} full (2 accounts each). Make another free Zernio account (another email) and paste its key — ${label} goes there, free.`
        : `All ${pool.length} of your free Zernio accounts are full (2 each). Remove one, or turn on billing at zernio.com for more.`);
      err.full = true; err.needSecondKey = more;
      return err;
    };
    const profOf = (a) => { const p = a && a.profileId; return String((p && (p._id || p.id)) || p || ''); };
    let profileId = '';
    if (has(pick)) {
      /*
       * A second page of the same platform needs a profile of its own (Zernio
       * keeps one account per platform in each). One left empty by an earlier,
       * cancelled try is used again; a new one is made only when there is none.
       * Never the default profile: that would replace the first page.
       */
      try {
        const profs = await getJson(`${pick.apiBase}/profiles`, { headers: auth });
        const list = Array.isArray(profs) ? profs : (profs && (profs.profiles || profs.data)) || [];
        const taken = new Set(pick.accounts.filter((a) => String(a.platform || a.provider || '').toLowerCase() === plat).map(profOf));
        const free = list.find((p) => !taken.has(String(p._id || p.id || p.profileId || '')) && !(p.isDefault || p.is_default));
        if (free) profileId = String(free._id || free.id || free.profileId || '');
        if (!profileId) {
          const made = await publisher.postJson(`${pick.apiBase}/profiles`, { name: `${label} ${found.length + 1}` }, auth);
          const p = made && made.json && (made.json.profile || made.json.data || made.json);
          profileId = p ? String(p._id || p.id || p.profileId || '') : '';
        }
      } catch (e) {
        if (full(e)) throw fullError();
        throw new Error(`Zernio could not make room for another ${label} (${e.message}) — try again in a moment.`);
      }
      if (!profileId) throw new Error(`Zernio could not make room for another ${label} — try again in a moment.`);
    } else {
      try {
        const profs = await getJson(`${pick.apiBase}/profiles`, { headers: auth });
        const list = Array.isArray(profs) ? profs : (profs && (profs.profiles || profs.data)) || [];
        const chosen = list.find((p) => p.isDefault || p.is_default) || list[0];
        profileId = chosen ? String(chosen._id || chosen.id || chosen.profileId || '') : '';
      } catch (e) { /* older API with no profiles */ }
    }
    let url = '';
    try {
      const q = { redirect_url: redirectUrl };
      if (profileId) q.profileId = profileId;
      const gen = await getJson(`${pick.apiBase}/connect/${plat}?` + new URLSearchParams(q), { headers: auth });
      url = gen && (gen.url || gen.authUrl || gen.connectUrl || gen.access_url);
    } catch (e) {
      if (full(e)) throw fullError();
      throw new Error(this._connectErrorText(e.message, label, pick.accounts));
    }
    if (!url || !/^https:\/\//i.test(String(url))) throw new Error('Zernio did not return a ' + label + ' connect link — try again.');
    return { url: String(url), platform: plat, label };
  }

  /*
   * ►► INSTAGRAM'S OWN SONGS. ◄◄ Instagram's song library — trending songs,
   * gospel, Travis Greene, whatever Meta has licensed — can be searched and a
   * song put under a Reel through Zernio. Licensed by Meta, so the post is
   * never muted or flagged for it. An empty search gives what is trending.
   * Gives back { songs: [{ id, title, artist, cover, preview, seconds }] }, or
   * { needsFacebookLogin: true } when the account was linked the other way
   * (Instagram's library is reached only through a Facebook sign-in), or
   * { unavailable: '…' } when Zernio offers no library to this account.
   */
  async zernioIgAudio(accountId, q, { covers = true } = {}) {
    const acc = this.byId(accountId);
    if (!acc || acc.platform !== 'instagram' || acc.via !== 'zernio' || !acc.zoAccountId) return { unavailable: 'Pick an Instagram account linked through Zernio.' };
    const want = String(q || '').trim().slice(0, 80);
    try {
      // "🙏 Gospel": songs BY gospel artists — a search for the word "gospel" brings back whatever is trending
      const cv = (r) => (covers ? this._igCovers(r) : r);   // (the pictures only for a phone to show)
      if (/^(__gospel|gospel)$/i.test(want)) return await cv(await this._igGospelMix(acc));
      const r = await this._igSearch(acc, want);
      if (!want) return await cv({ songs: r.songs, trending: true });
      if (r.ignored) return { songs: [], unmatched: true };
      // an artist's name: that artist's songs only (a search brings near-matches too); else a title, as found
      const theirs = r.songs.filter((s) => byArtist(s, want));
      return await cv({ songs: theirs.length ? theirs : r.songs, trending: false });
    } catch (e) {
      if (e.needsFacebookLogin) return { needsFacebookLogin: true };
      if (e.unavailable) return { unavailable: e.message };
      throw e;
    }
  }

  /*
   * One search of Instagram's library through Zernio — GET
   * /accounts/{id}/instagram/audio?audioType=music&q=… (Zernio's own SDK:
   * audioType "music" is licensed songs, q the words; no q is what Instagram
   * calls trending, ~30 songs). A search Instagram could not match comes back
   * as that very trending list: that is "nothing found", never songs to show
   * as if they matched. Each answer is kept a quarter of an hour.
   */
  async _igSearch(acc, query) {
    const { apiBase } = zoCfg(this.store, 'instagram');
    const ask = async (q) => {
      const qs = { audioType: 'music' };
      if (q) qs.q = q;
      try {
        return igSongsOf(await getJson(`${apiBase}/accounts/${encodeURIComponent(acc.zoAccountId)}/instagram/audio?` + new URLSearchParams(qs),
          { headers: { authorization: 'Bearer ' + acc.token } }));
      } catch (e) {
        if (/facebook_login|facebook login|FACEBOOK_LOGIN/i.test(e.message || '')) { const er = new Error('needs Facebook login'); er.needsFacebookLogin = true; throw er; }
        if (e.status === 404 || e.status === 405) { const er = new Error('Zernio does not offer Instagram’s song library yet.'); er.unavailable = true; throw er; }
        throw new Error('Instagram’s songs could not be loaded (' + (e.message || 'no answer') + ').');
      }
    };
    const now = Date.now(), KEEP = 15 * 60e3;
    this._igCache = this._igCache || new Map();
    const kept = async (q) => {
      const k = acc.id + '\n' + q.toLowerCase();
      const hit = this._igCache.get(k);
      if (hit && now - hit.at < KEEP) return hit.songs;
      const songs = await ask(q);
      if (this._igCache.size > 300) this._igCache.clear();
      this._igCache.set(k, { at: Date.now(), songs });
      return songs;
    };
    const trend = await kept('');
    if (!query) return { songs: trend };
    const list = await kept(query);
    const sameAsTrend = list.length && trend.length && list.slice(0, 6).map((x) => x.id).join() === trend.slice(0, 6).map((x) => x.id).join();
    return sameAsTrend || !list.length ? { songs: [], ignored: true } : { songs: list };
  }

  /*
   * Gospel artists whose songs are in the library Instagram opens to apps —
   * five searched at a time, only THEIR songs kept, one from each in turn.
   * Five that bring nothing: the next five (all twenty at most), so a library
   * holding only some of them still shows those. The next load starts after
   * the five that answered: other artists each time.
   */
  async _igGospelMix(acc) {
    const ARTISTS = ['Travis Greene', 'Maverick City Music', 'CeCe Winans', 'Dunsin Oyekan', 'Sinach', 'Nathaniel Bassey', 'Mercy Chinwo',
      'Elevation Worship', 'Tasha Cobbs Leonard', 'Moses Bliss', 'Kirk Franklin', 'Brandon Lake', 'Forrest Frank', 'Tim Godfrey', 'Ada Ehi',
      'Hillsong Worship', 'Jonathan McReynolds', 'Tye Tribbett', 'Limoblaze', 'Victoria Orenze'];
    const N = ARTISTS.length, start = (this._igMixAt || 0) % N;
    await this._igSearch(acc, '');   // the trending list first, once — so the searches do not each fetch it
    for (let round = 0; round * 5 < N; round++) {
      const at = (start + round * 5) % N;
      const pick = [0, 1, 2, 3, 4].map((i) => ARTISTS[(at + i) % N]);
      const lists = await Promise.all(pick.map(async (name) => {
        try {
          const r = await this._igSearch(acc, name);
          return r.songs.filter((s) => byArtist(s, name)).slice(0, 4);
        } catch (e) { if (e.needsFacebookLogin || e.unavailable) throw e; return []; }
      }));
      if (!lists.some((l) => l.length)) continue;
      this._igMixAt = (at + 5) % N;
      const out = [], seen = new Set();
      for (let i = 0; i < 4; i++) for (const l of lists) { const s = l[i]; if (s && !seen.has(s.id)) { seen.add(s.id); out.push(s); } }
      return { songs: out, gospel: true };
    }
    return { songs: [], unmatched: true };
  }

  /*
   * The covers, as pictures the phone may show: the studio's page loads no
   * picture from elsewhere (its Content-Security-Policy), so the first ones
   * are fetched here and handed over inline (small, kept an hour).
   */
  async _igCovers(r) {
    // copies: the songs themselves are kept for the next search, with Instagram's own links
    const list = ((r && r.songs) || []).map((x) => Object.assign({}, x));
    this._igCoverCache = this._igCoverCache || new Map();
    const cache = this._igCoverCache, HOUR = 3600e3;
    const meta = /^https:\/\/([\w-]+\.)*(fbcdn\.net|cdninstagram\.com|facebook\.com|instagram\.com|fbsbx\.com)(:443)?\//i;
    await Promise.all(list.map(async (s, i) => {
      const url = s.cover;
      if (!url || i >= 15 || !meta.test(url)) { s.cover = null; return; }
      const hit = cache.get(url);
      if (hit && Date.now() - hit.at < HOUR) { s.cover = hit.data; return; }
      try {
        const { buf, mime } = await getBinary(url, { maxBytes: 120 * 1024, redirects: 3, timeoutMs: 6000 });
        const type = /^image\/(jpeg|png|webp|gif)$/i.test(mime || '') ? mime.toLowerCase() : 'image/jpeg';
        s.cover = buf && buf.length > 100 ? `data:${type};base64,${buf.toString('base64')}` : null;
      } catch (e) { s.cover = null; }
      if (cache.size > 200) cache.clear();
      cache.set(url, { at: Date.now(), data: s.cover });
    }));
    return Object.assign({}, r, { songs: list });
  }

  /* A song's preview, fresh from Zernio (its link expires after a day or so): { buf, mime } */
  async zernioIgPreview(accountId, audioId, hint) {
    const acc = this.byId(accountId);
    if (!acc || acc.platform !== 'instagram' || acc.via !== 'zernio') throw new Error('Pick the Instagram account.');
    const { apiBase } = zoCfg(this.store, 'instagram');
    let url = '';
    try {
      const got = await getJson(`${apiBase}/accounts/${encodeURIComponent(acc.zoAccountId)}/instagram/audio/${encodeURIComponent(audioId)}`, { headers: { authorization: 'Bearer ' + acc.token } });
      const one = igSongsOf(got)[0] || igSongsOf({ audio: [got && (got.audio || got.data || got)] })[0];
      url = (one && one.preview) || '';
    } catch (e) { /* the link from the list, then */ }
    // the phone's copy of the link only if it is Meta's own (the studio fetches nothing else for a phone)
    const meta = /^https:\/\/([\w-]+\.)*(fbcdn\.net|cdninstagram\.com|facebook\.com|instagram\.com|fbsbx\.com)(:443)?\//i;
    if (!url && meta.test(String(hint || ''))) url = String(hint);
    if (!/^https?:\/\//i.test(url)) throw new Error('Instagram has no preview of this song.');
    const r = await getBinary(url, { maxBytes: 25 * 1024 * 1024, redirects: 5, timeoutMs: 30000 });
    if (!r.buf || r.buf.length < 2000) throw new Error('Instagram’s preview of this song came back empty.');
    return r;
  }

  /*
   * Instagram linked again, through Facebook — the way that opens its song
   * library. The same Instagram account, under the same key and profile; only
   * the sign-in differs (loginMethod=facebook_login).
   */
  /*
   * ►► INSTAGRAM, LINKED THROUGH FACEBOOK — FREE. ◄◄ Instagram's song
   * library opens only to an account linked through a Facebook sign-in. Zernio
   * counts a second link of the same Instagram as another account, so on the
   * free plan (2 accounts each) it says "add a payment method". Zernio's own
   * rule for switching the sign-in: disconnect the account first. So, only
   * when Zernio says it is full — and only once the church has said yes
   * (opts.unlink) — this Instagram is let go on Zernio (2 → 1) and linked again
   * through Facebook (1 → 2): nothing to pay. What is remembered here
   * (igRelink) lets the new link take the old one's place: the scheduled
   * Instagram posts move over (main.js finishIgRelink).
   */
  async _zoRelinkInstagram(accountId, opts = {}) {
    const acc = this.byId(accountId);
    if (!acc || acc.platform !== 'instagram' || acc.via !== 'zernio') throw new Error('Pick the Instagram account to link through Facebook.');
    const { apiBase, redirectUrl } = zoCfg(this.store, 'instagram');
    const auth = { authorization: 'Bearer ' + acc.token };
    let profileId = '', me = null;
    try {
      const listed = zoAccountList(await getJson(`${apiBase}/accounts`, { headers: auth }));
      me = listed.find((a) => String(zoAccountId(a)) === String(acc.zoAccountId)) || null;
      const p = me && me.profileId;
      profileId = String((p && (p._id || p.id)) || p || '');
    } catch (e) { /* the default profile, then */ }
    if (!profileId) profileId = String((this.store.get('igRelink') || {}).profileId || '');
    const q = { redirect_url: opts.redirectUrl || redirectUrl, loginMethod: 'facebook_login' };
    if (profileId) q.profileId = profileId;
    const gen = async () => {
      const r = await getJson(`${apiBase}/connect/instagram?` + new URLSearchParams(q), { headers: auth });
      return r && (r.url || r.authUrl || r.connectUrl || r.access_url);
    };
    const full = (e) => e && (e.status === 402 || /payment|free_tier|more than 2 accounts|plan limit|upgrade/i.test(e.message || ''));
    // remembered BEFORE anything is let go, so the new link always finds the old one's posts
    this.store.set('igRelink', { oldId: acc.id, oldZoId: String(acc.zoAccountId), profileId, at: Date.now() });
    let url = '';
    try { url = await gen(); }
    catch (e) {
      if (!full(e)) throw new Error('Zernio could not start the Facebook sign-in (' + e.message + ') — try again in a moment.');
      if (me && !opts.unlink) {
        // the church is asked first: Instagram is unlinked for the minute the sign-in takes
        const err = new Error('Zernio’s free plan holds 2 accounts, and it counts this as a third. The free way: Instagram is unlinked for a moment and linked again through Facebook — your scheduled Instagram posts are moved over.');
        err.needsUnlink = true;
        throw err;
      }
      if (me) {
        try { await publisher.del(`${apiBase}/accounts/${encodeURIComponent(acc.zoAccountId)}`, { headers: auth }); }
        catch (e2) { if (!(e2.status === 404 || /not found/i.test(e2.message || ''))) throw new Error('Zernio could not unlink Instagram to make room (' + e2.message + ') — try again in a moment.'); }
      }
      try { url = await gen(); }
      catch (e3) { throw new Error('Zernio could not start the Facebook sign-in (' + e3.message + '). Instagram is unlinked on Zernio — tap the button again to finish linking it through Facebook.'); }
    }
    if (!url || !/^https:\/\//i.test(String(url))) throw new Error('Zernio did not return a sign-in link — try again.');
    return { url: String(url), platform: 'instagram', label: 'Instagram', unlinked: !!(opts.unlink && me) };
  }

  /** Is it linked yet? Keeps the account when it is; `{ pending: true }` when not. */
  async zernioLinkClaim(platform, opts = {}) {
    const plat = ['youtube', 'facebook', 'instagram'].includes(platform) ? platform : 'tiktok';
    const pool = await this._zoPool();
    const stored = this._zoStored();
    const removed = new Set(this.store.get('zoRemoved') || []);
    const found = this._zoFind(pool, plat);
    const fresh = (f) => !stored.has(String(zoAccountId(f.acct))) && !removed.has(String(zoAccountId(f.acct)));
    const hit = opts.another ? found.find(fresh) : (found.find(fresh) || found.find((f) => stored.has(String(zoAccountId(f.acct)))));
    if (!hit) return { pending: true };
    return { account: await this._zoKeep(plat, hit.acct, hit.key) };
  }

  /*
   * Everything already linked on Zernio, kept here in one go — an account
   * linked on zernio.com (or before this studio was set up) needs no Connect.
   * Each key is asked once. Gives back the platforms now linked through Zernio.
   */
  async zernioImportAll(platforms) {
    const linked = [];
    const removed = new Set(this.store.get('zoRemoved') || []);
    let pool;
    try { pool = await this._zoPool(); } catch (e) { return linked; }
    for (const plat of ZO_PLATFORMS) {
      if (Array.isArray(platforms) && !platforms.includes(plat)) continue;
      const here = this.all().filter((a) => a.platform === plat);
      for (const f of this._zoFind(pool, plat)) {
        const id = String(zoAccountId(f.acct));
        // one Removed here stays removed until it is connected again on purpose
        if (removed.has(id)) continue;
        // a platform already linked (its own app, Upload-Post, another account) is left as
        // it is — a second link would post everything twice. The same account is refreshed.
        const same = here.some((a) => a.via === 'zernio' && String(a.zoAccountId) === id);
        if (here.length && !same) continue;
        await this._zoKeep(plat, f.acct, f.key);
        if (!same) linked.push(plat);   // newly linked (a refresh is not news)
        break;
      }
    }
    return linked;
  }

  /** Is this a Zernio key Zernio accepts? Throws in words the person can act on. */
  async zernioCheckKey(apiKey) {
    const { apiBase } = zoCfg(this.store, 'tiktok');
    try { return zoAccountList(await getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + apiKey } })); }
    catch (e) {
      if (e.status === 401 || e.status === 403 || /\b(401|403)\b|unauthor|invalid/i.test(e.message)) throw new Error('Zernio did not accept that key — copy it again from zernio.com → API keys.');
      throw new Error('Zernio could not be reached to check the key (' + e.message + ') — try again in a moment.');
    }
  }

  /*
   * A key replaced in the app: the accounts linked with the old one carry it
   * (each record keeps the key it posts with), so they move to the new one —
   * otherwise they would keep posting with a key that may have been revoked.
   */
  zernioRekey(oldKey, newKey, visible) {
    if (!oldKey || !newKey || oldKey === newKey) return 0;
    // only the accounts the new key can see: a key from a DIFFERENT Zernio account
    // (a second free one) must not take over the first account's links
    const seen = new Set((visible || []).map((a) => String(zoAccountId(a))));
    let n = 0;
    const all = this.all().map((a) => (a.via === 'zernio' && a.token === oldKey && seen.has(String(a.zoAccountId)) ? (n++, { ...a, token: newKey }) : a));
    if (n) this.store.set('socialAccounts', all);
    return n;
  }

  /** Store a Zernio-linked account; hand back the record without its key. */
  async _zoKeep(platform, acct, apiKey) {
    const label = ZO_LABEL[platform] || 'TikTok';
    const accountId = zoAccountId(acct);
    const handle = String(acct.username || acct.handle || acct.name || '').replace(/^@/, '');
    const picture = await fetchAvatarDataUri(acct.picture || acct.profileImage || acct.avatar || acct.social_images || '');
    const rec = this._upsert({
      id: zoIdPrefix(platform) + accountId, platform, via: 'zernio',
      name: acct.displayName || acct.display_name || (handle ? '@' + handle : label + ' account'),
      zoAccountId: accountId, username: handle,
      token: apiKey, picture, connectedAt: new Date().toISOString(),
    });
    const { token, ...safe } = rec;
    return { ...safe, connected: true };
  }

  /** Live health check: asks the platform if the stored credentials still work. */
  async check(id) {
    const acc = this.byId(id);
    if (!acc) throw new Error('Account not found.');
    // Zernio "easy connect" (TikTok or YouTube) — checked first so a Zernio
    // YouTube account never falls through to the Google-OAuth branch below.
    if (acc.via === 'zernio') {
      const label = ZO_LABEL[acc.platform] || 'This';
      const { apiBase } = zoCfg(this.store, acc.platform);
      const res = await getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + acc.token } });
      const found = zoAccountList(res).find((a) => String(zoAccountId(a)) === String(acc.zoAccountId));
      if (!found) throw new Error(label + ' is no longer linked on Zernio — hit Connect account to relink it.');
      if (found.reauth_required || found.needsReauth) throw new Error(label + ' wants a fresh sign-in — open zernio.com and reconnect the ' + label + ' account.');
      const h = String(found.username || found.handle || '').replace(/^@/, '');
      return { ok: true, name: found.displayName || found.display_name || (h ? '@' + h : acc.name) };
    }
    if (acc.platform === 'youtube') {
      const { tokenBase, apiBase } = ytCfg(this.store);
      const access = await publisher.ytAccessToken({
        clientId: acc.clientId, clientSecret: acc.clientSecret, refreshToken: acc.token, tokenBase,
      });
      const res = await getJson(`${apiBase}/youtube/v3/channels?part=snippet&mine=true`,
        { headers: { authorization: 'Bearer ' + access } });
      const item = res && res.items && res.items[0];
      if (!item) throw new Error('Google did not recognize this channel.');
      return { ok: true, name: (item.snippet && item.snippet.title) || acc.name };
    }
    // Upload-Post "easy connect" — checked before the platform-specific
    // branches below, so an Upload-Post Instagram never falls through to the
    // Meta Graph branch and gets told its (nonexistent) IG token is bad.
    if (acc.via === 'uploadpost') {
      const label = UP_LABEL[acc.platform] || 'This';
      const { apiBase } = upCfg(this.store);
      const res = await getJson(`${apiBase}/uploadposts/users/${encodeURIComponent(acc.upUser)}`,
        { headers: { authorization: 'Apikey ' + acc.token } });
      const got = upAccountOf(res && res.profile, acc.platform);
      if (!got) throw new Error(label + ' is no longer linked on Upload-Post — hit Connect account to relink it.');
      if (got.reauth_required) throw new Error(label + ' wants a fresh sign-in — open upload-post.com and reconnect the ' + label + ' account.');
      return { ok: true, name: got.display_name || (got.handle || got.username ? '@' + String(got.handle || got.username).replace(/^@/, '') : acc.name) };
    }
    if (acc.platform === 'tiktok') {
      const { apiBase } = tkCfg(this.store);
      const access = await publisher.tkAccessToken({
        clientKey: acc.clientKey, clientSecret: acc.clientSecret, refreshToken: acc.token, apiBase,
      });
      const res = await getJson(`${apiBase}/v2/user/info/?fields=open_id,display_name`,
        { headers: { authorization: 'Bearer ' + access } });
      const user = res && res.data && res.data.user;
      if (!user || !user.open_id) throw new Error('TikTok did not recognize this account.');
      return { ok: true, name: user.display_name || acc.name };
    }
    const { graphBase } = cfg(this.store);
    const node = acc.platform === 'instagram' ? acc.igUserId : acc.pageId;
    const fields = acc.platform === 'instagram' ? 'id,username' : 'id,name';
    const res = await getJson(`${graphBase}/${encodeURIComponent(node)}?` +
      new URLSearchParams({ fields, access_token: acc.token }));
    if (!res || !res.id) throw new Error('Facebook did not recognize this account.');
    return { ok: true, name: res.name || (res.username ? '@' + res.username : acc.name) };
  }
}

module.exports = {
  googleAuthError,
  Accounts, captureUserToken, captureGoogleCode, captureTikTokCode, exchangeLongLived, listPages, fetchAvatarDataUri,
  cfg, ytCfg, tkCfg, upCfg, zoCfg, getJson, OAUTH_SCOPES, DEFAULT_OAUTH, DEFAULT_GRAPH, DEFAULT_YT_AUTH, YT_SCOPES,
  DEFAULT_TK_AUTH, DEFAULT_TK_REDIRECT, TK_SCOPES, DEFAULT_ZO_REDIRECT, ZO_PLATFORMS, envZoKey,
};
