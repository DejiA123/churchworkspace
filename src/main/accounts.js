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
/** Stable per-platform id prefix for Zernio "easy connect" accounts. */
const ZO_ID_PREFIX = { tiktok: 'zotk_', youtube: 'zoyt_', facebook: 'zofb_', instagram: 'zoig_' };
function zoIdPrefix(platform) { return ZO_ID_PREFIX[platform] || 'zo_'; }
const ZO_LABEL = { tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram' };
const ZO_PLATFORMS = ['tiktok', 'youtube', 'instagram', 'facebook'];

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
        '<div style="text-align:center"><h2>✅ Connected</h2><p>You can close this tab and go back to the Church Work Space.</p></div></body></html>');
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
   * are already using the slots and points at the route that costs nothing.
   */
  _connectErrorText(raw, label, listed) {
    const msg = String(raw || '');
    if (/payment|free_tier_exceeded|402|more than 2 accounts/i.test(msg)) {
      const names = (Array.isArray(listed) ? listed : (listed && (listed.accounts || listed.data)) || [])
        .map((a) => (a.platform || a.provider || '?')).filter(Boolean);
      const using = names.length ? ` They are being used by ${names.join(' and ')}.` : '';
      return `Zernio's free plan covers 2 linked accounts and both are taken.${using} `
        + `To put ${label} on Zernio you would have to unlink one of them (or add a payment method). `
        + (/youtube/i.test(label)
          ? 'YouTube does not need Zernio at all — connect it with your own Google app instead: it is free, unlimited, and costs no Zernio slot.'
          : 'Free up a slot, or use that platform\'s own direct connection instead.');
    }
    return 'Zernio could not start the ' + label + ' connect flow (' + msg + ').';
  }

  async connectZernio(parentWindow, opts = {}) {
    const platform = ['youtube', 'facebook', 'instagram'].includes(opts.platform) ? opts.platform : 'tiktok';
    const label = ZO_LABEL[platform] || 'TikTok';
    const { apiKey, apiBase, redirectUrl } = zoCfg(this.store, platform);
    if (!apiKey) {
      throw new Error('Paste your Zernio API key first (free at zernio.com → Settings → API keys).');
    }
    const auth = { authorization: 'Bearer ' + apiKey };

    const listAccounts = async () => {
      try {
        return await getJson(`${apiBase}/accounts`, { headers: auth });
      } catch (e) {
        throw new Error('Zernio did not accept the API key (' + e.message + ') — copy it again from zernio.com → Settings → API keys.');
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
  async zernioLinkStart(platform, opts = {}) {
    const plat = ['youtube', 'facebook', 'instagram'].includes(platform) ? platform : 'tiktok';
    const label = ZO_LABEL[plat] || 'TikTok';
    const cfg = zoCfg(this.store, plat);
    const { apiKey, apiBase } = cfg;
    // "Set up everything" sends each sign-in back to the studio's own page, which opens the next one
    const redirectUrl = opts.redirectUrl || cfg.redirectUrl;
    if (!apiKey) throw new Error('Add your Zernio key first (free at zernio.com → Settings → API keys).');
    const auth = { authorization: 'Bearer ' + apiKey };
    let listed;
    try { listed = await getJson(`${apiBase}/accounts`, { headers: auth }); }
    catch (e) { throw new Error('Zernio did not accept the key (' + e.message + ') — copy it again from zernio.com → Settings → API keys.'); }
    const acct = zoAccountOf(listed, plat);
    if (acct) return { account: await this._zoKeep(plat, acct, apiKey) };
    let profileId = '';
    try {
      const profs = await getJson(`${apiBase}/profiles`, { headers: auth });
      const list = Array.isArray(profs) ? profs : (profs && (profs.profiles || profs.data)) || [];
      const chosen = list.find((p) => p.isDefault || p.is_default) || list[0];
      profileId = chosen ? String(chosen._id || chosen.id || chosen.profileId || '') : '';
    } catch (e) { /* older API with no profiles */ }
    let url = '';
    try {
      const q = { redirect_url: redirectUrl };
      if (profileId) q.profileId = profileId;
      const gen = await getJson(`${apiBase}/connect/${plat}?` + new URLSearchParams(q), { headers: auth });
      url = gen && (gen.url || gen.authUrl || gen.connectUrl || gen.access_url);
    } catch (e) {
      throw new Error(this._connectErrorText(e.message, label, listed));
    }
    if (!url || !/^https:\/\//i.test(String(url))) throw new Error('Zernio did not return a ' + label + ' connect link — try again.');
    return { url: String(url), platform: plat, label };
  }

  /** Is it linked yet? Keeps the account when it is; `{ pending: true }` when not. */
  async zernioLinkClaim(platform) {
    const plat = ['youtube', 'facebook', 'instagram'].includes(platform) ? platform : 'tiktok';
    const { apiKey, apiBase } = zoCfg(this.store, plat);
    if (!apiKey) throw new Error('Add your Zernio key first (free at zernio.com → Settings → API keys).');
    const listed = await getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + apiKey } });
    const acct = zoAccountOf(listed, plat);
    if (!acct) return { pending: true };
    return { account: await this._zoKeep(plat, acct, apiKey) };
  }

  /*
   * Everything already linked on Zernio, kept here in one go — an account
   * linked on zernio.com (or before this studio was set up) needs no Connect.
   * Each key is asked once. Gives back the platforms now linked through Zernio.
   */
  async zernioImportAll(platforms) {
    const byKey = new Map();
    const linked = [];
    const removed = new Set(this.store.get('zoRemoved') || []);
    for (const plat of ZO_PLATFORMS) {
      if (Array.isArray(platforms) && !platforms.includes(plat)) continue;
      const { apiKey, apiBase } = zoCfg(this.store, plat);
      if (!apiKey) continue;
      const k = apiBase + '|' + apiKey;
      if (!byKey.has(k)) byKey.set(k, getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + apiKey } }).catch(() => null));
      const listed = await byKey.get(k);
      const acct = listed && zoAccountOf(listed, plat);
      if (!acct) continue;
      const id = String(zoAccountId(acct));
      // one Removed here stays removed until it is connected again on purpose
      if (removed.has(id)) continue;
      // a platform already linked (its own app, Upload-Post, another Zernio account) is left
      // as it is: a second link would post everything twice. The same account is refreshed.
      const here = this.all().filter((a) => a.platform === plat);
      if (here.length && !here.some((a) => a.via === 'zernio' && String(a.zoAccountId) === id)) continue;
      await this._zoKeep(plat, acct, apiKey);
      if (!here.length) linked.push(plat);   // newly linked (a refresh is not news)
    }
    return linked;
  }

  /** Is this a Zernio key Zernio accepts? Throws in words the person can act on. */
  async zernioCheckKey(apiKey) {
    const { apiBase } = zoCfg(this.store, 'tiktok');
    try { return zoAccountList(await getJson(`${apiBase}/accounts`, { headers: { authorization: 'Bearer ' + apiKey } })); }
    catch (e) {
      if (e.status === 401 || e.status === 403 || /\b(401|403)\b|unauthor|invalid/i.test(e.message)) throw new Error('Zernio did not accept that key — copy it again from zernio.com → Settings → API keys.');
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
