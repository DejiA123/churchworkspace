'use strict';
/**
 * Social auto-publisher — talks to the Meta Graph API directly so scheduled
 * posts go out AUTOMATICALLY at their time, no human needed.
 *
 *  - Facebook Pages: photos, videos, and text posts.
 *  - Instagram Business: Reels/videos via Meta's resumable upload protocol
 *    (local file → rupload endpoint → processing poll → publish), and feed
 *    photos. Meta's API refuses local image bytes for photos — it only takes
 *    a public image_url — so the photo is first staged on the linked Facebook
 *    Page as an UNPUBLISHED temporary upload (never visible on the Page) and
 *    Instagram is handed the CDN URL Facebook serves it from.
 *
 * Dependency-free: streams multipart/binary uploads over Node's http/https,
 * so even a big sermon video never has to fit in memory.
 *
 * The API base is injectable (settings.accounts.fbApiBase) so tests can point
 * it at a local mock Graph server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

// Electron modules — absent when unit tests run this file under plain Node.
let electron = {};
try { electron = require('electron'); } catch (e) { /* plain node */ }

const DEFAULT_API = 'https://graph.facebook.com/v19.0';
const DEFAULT_YT_TOKEN = 'https://oauth2.googleapis.com/token';
const DEFAULT_YT_API = 'https://www.googleapis.com';
const DEFAULT_TK_API = 'https://open.tiktokapis.com';
const DEFAULT_UP_API = 'https://api.upload-post.com/api';
const DEFAULT_ZO_API = 'https://zernio.com/api/v1';

const VIDEO_RX = /\.(mp4|mov|m4v|avi|mkv|webm|mpg|mpeg|wmv)$/i;
function isVideoFile(p) { return VIDEO_RX.test(p || ''); }

function libFor(urlStr) { return urlStr.startsWith('https:') ? https : http; }

/** POST a form-urlencoded body; resolve with parsed JSON. */
function postForm(urlStr, fields, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(fields).toString();
    const u = new URL(urlStr);
    const req = libFor(urlStr).request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) },
    }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end(body);
  });
}

/** GET a URL; resolve with parsed JSON. */
function getJson(urlStr, { timeoutMs = 120000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = libFor(urlStr).request(new URL(urlStr), { method: 'GET', headers }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

/** Pull a human error out of a Meta ({error:{message}}) or Google
 *  ({error:'…'} / {error:{message}} / {error_description}) response body. */
function apiErrMsg(json) {
  if (!json) return null;
  if (json.error && typeof json.error === 'object' && json.error.message) return json.error.message;
  if (typeof json.error === 'string') return json.error_description || json.error;
  if (json.error_description) return json.error_description;
  if (typeof json.message === 'string') return json.message; // Upload-Post error shape
  return null;
}

/* 413 arrives as a bare HTML page with no error object in it, so the raw
   status is all the operator ever saw. Say what it actually means. */
const TOO_BIG = 'the file was too big for the address it was sent to '
  + '(HTTP 413). Videos have to go to the video host as an upload session — '
  + 'if you are seeing this, that upload took the wrong route.';

function collectJson(res, resolve, reject) {
  let out = '';
  res.on('data', (d) => { out += d; });
  res.on('end', () => {
    let json = null;
    try { json = JSON.parse(out); } catch (e) { /* non-JSON body */ }
    if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json || {});
    if (res.statusCode === 413) return reject(new Error(apiErrMsg(json) || TOO_BIG));
    reject(new Error(apiErrMsg(json) || `HTTP ${res.statusCode}: ${out.slice(0, 300)}`));
  });
}

/** DELETE an object: tidying up staging uploads, and calling off a post that
 *  was handed to a platform to publish later (see cancelScheduled). */
function del(urlStr, { timeoutMs = 20000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = libFor(urlStr).request(new URL(urlStr), { method: 'DELETE', headers }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

/** POST a JSON body; resolve with { json, headers } (YouTube's resumable-init
 *  handshake returns the upload session in the `location` response header). */
function postJson(urlStr, obj, headers = {}, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj));
    const u = new URL(urlStr);
    const req = libFor(urlStr).request(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=UTF-8', 'content-length': body.length, ...headers },
    }, (res) => {
      let out = '';
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(out); } catch (e) { /* empty/non-JSON body is fine */ }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ json: json || {}, headers: res.headers });
        reject(new Error(apiErrMsg(json) || `HTTP ${res.statusCode}: ${out.slice(0, 300)}`));
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Request timed out.')); });
    req.on('error', reject);
    req.end(body);
  });
}

/**
 * POST multipart/form-data with one streamed file part.
 * Content-Length is computed exactly (Graph API dislikes chunked uploads).
 *
 * `range` ({ start, end } — half-open, as Meta counts offsets) sends only that
 * slice of the file, which is what an upload session's transfer phase needs.
 */
function postMultipart(urlStr, fields, filePath, fileField, { timeoutMs = 60 * 60 * 1000, headers = {}, range = null } = {}) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const partLen = range ? Math.max(0, range.end - range.start) : stat.size;
    const boundary = '----MWBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf-8'));
    }
    const fname = path.basename(filePath).replace(/"/g, '');
    const mime = isVideoFile(filePath) ? 'video/mp4'
      : /\.png$/i.test(filePath) ? 'image/png' : 'image/jpeg';
    const fileHead = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="${fileField}"; filename="${fname}"\r\n` +
      `content-type: ${mime}\r\n\r\n`, 'utf-8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const preamble = Buffer.concat(parts);
    const total = preamble.length + fileHead.length + partLen + tail.length;

    const u = new URL(urlStr);
    const req = libFor(urlStr).request(u, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': total, ...headers },
    }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Upload timed out.')); });
    req.on('error', reject);

    req.write(preamble);
    req.write(fileHead);
    const stream = fs.createReadStream(filePath,
      range ? { start: range.start, end: range.end - 1 } : {});
    stream.on('error', (err) => req.destroy(err));
    stream.on('end', () => req.end(tail));
    stream.pipe(req, { end: false });
  });
}

/**
 * POST one raw binary file body with custom headers (Meta's resumable upload
 * protocol: rupload.facebook.com wants the bare bytes, not multipart).
 */
function postBinary(urlStr, filePath, headers, { method = 'POST', timeoutMs = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const stat = fs.statSync(filePath);
    const u = new URL(urlStr);
    const req = libFor(urlStr).request(u, {
      method,
      headers: { 'content-type': 'application/octet-stream', 'content-length': stat.size, ...headers },
    }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Upload timed out.')); });
    req.on('error', reject);
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => req.destroy(err));
    stream.pipe(req);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Repeat a GET that failed for a NETWORK reason (dropped socket, timeout) —
 * never for an answer the server actually gave. A church uplink drops packets;
 * a status poll losing its socket should not lose the whole post.
 *
 * Deliberately reads only. The publish call is not idempotent, and a retry
 * there would put the same reel on the account twice.
 */
const TRANSIENT_RX = /timed out|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|socket hang up|ENOTFOUND|EAI_AGAIN|network/i;
async function getJsonRetry(urlStr, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await getJson(urlStr, opts); }
    catch (e) {
      last = e;
      if (!TRANSIENT_RX.test(e.message || '')) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

/* ==================== Facebook video: the RIGHT door ====================
 *
 * Facebook serves video uploads from its own host. Push video bytes at
 * graph.facebook.com and a short clip slips through while anything longer
 * comes back HTTP 413 (Request Entity Too Large) — which is exactly why the
 * 40-130MB shorts posted every time and a full-length service never did.
 *
 * So videos go to graph-video.facebook.com, and they go up as an UPLOAD
 * SESSION rather than one enormous POST: Facebook names a byte range, we send
 * that slice, Facebook names the next. No single request is ever big enough to
 * be refused, and a chunk lost on a church uplink is simply re-sent at the
 * offset Facebook still expects instead of restarting a 350MB upload.
 */

/** The video host, for the real Graph API only — an injected base (a test
 *  mock, a proxy) is handed back exactly as it was given. */
function videoApiBase(base) {
  const s = String(base || '');
  const i = s.toLowerCase().indexOf('//graph.facebook.com');
  return i < 0 ? s : s.slice(0, i) + '//graph-video.facebook.com' + s.slice(i + 20);
}

/* Facebook picks the chunk size; this is only a ceiling so that a surprising
   answer can never re-create the 413 this whole path exists to avoid. */
const FB_MAX_CHUNK = 24 * 1024 * 1024;

/**
 * Upload one video to a Page with Meta's chunked upload session.
 *   upload_phase=start    → session id, video id, and the first byte range
 *   upload_phase=transfer → that slice; the reply names the next range
 *   upload_phase=finish   → description/published, and the video goes live
 *
 * Returns null when the edge does not run upload sessions at all (it answers
 * the start phase with a plain post id), so the caller can fall back.
 */
async function fbChunkedVideo(vbase, pageId, token, media, finishFields, opts = {}) {
  const size = fs.statSync(media).size;
  const edge = `${vbase}/${encodeURIComponent(pageId)}/videos`;
  const start = await postForm(edge,
    { upload_phase: 'start', file_size: String(size), access_token: token });
  const sessionId = start && (start.upload_session_id || start.upload_sessionid);
  if (!sessionId) return null;

  const tries = opts.chunkTries != null ? opts.chunkTries : 4;
  let from = Number(start.start_offset) || 0;
  let to = Number(start.end_offset);
  if (!Number.isFinite(to) || to <= from) to = size;

  while (from < size && to > from) {
    const end = Math.min(to, from + FB_MAX_CHUNK, size);
    let res = null, lastErr = null;
    for (let t = 0; t < tries; t++) {
      try {
        res = await postMultipart(edge, {
          upload_phase: 'transfer',
          upload_session_id: sessionId,
          start_offset: String(from),
          access_token: token,
        }, media, 'video_file_chunk', { range: { start: from, end } });
        break;
      } catch (e) {
        lastErr = e;
        // Only a NETWORK failure is worth re-sending; an answer Facebook gave
        // on purpose would just be refused again.
        if (!TRANSIENT_RX.test(e.message || '')) throw e;
        await sleep(1500 * (t + 1));
      }
    }
    if (!res) throw lastErr || new Error('Facebook stopped accepting the video part-way through.');

    // Facebook drives the offsets; never let its answer walk backwards.
    const next = Number(res.start_offset);
    from = Number.isFinite(next) && next > from ? next : end;
    const nextEnd = Number(res.end_offset);
    to = Number.isFinite(nextEnd) && nextEnd > from ? nextEnd : size;
    if (opts.onProgress) { try { opts.onProgress(from, size); } catch (e) {} }
  }

  const done = await postForm(edge, {
    ...finishFields,
    upload_phase: 'finish',
    upload_session_id: sessionId,
    access_token: token,
  });
  const id = (done && (done.post_id || done.id)) || start.video_id;
  if (!id) throw new Error('Facebook finished the upload but returned no video id.');
  return { id, video_id: start.video_id || id };
}

/**
 * Send a video to a Page: an upload session first, and a single POST — still
 * on the video host, never the plain one — only for an edge that has no
 * sessions to offer.
 */
async function fbUploadVideo(base, pageId, token, media, finishFields, opts = {}) {
  const vbase = videoApiBase(base);
  const session = await fbChunkedVideo(vbase, pageId, token, media, finishFields, opts);
  if (session) return session;
  return postMultipart(`${vbase}/${encodeURIComponent(pageId)}/videos`,
    { ...finishFields, access_token: token }, media, 'source');
}

/**
 * Publish one post to a Facebook Page. Chooses the right Graph endpoint:
 *  - video file  → /{page-id}/videos   on graph-video, as an upload session
 *  - image file  → /{page-id}/photos   (multipart "source" + caption)
 *  - text only   → /{page-id}/feed     (message)
 * Returns { id, url } — the Graph post/video id and a link to it.
 */
async function publishToFacebook({ pageId, token, apiBase }, post, opts = {}) {
  if (!pageId || !token) throw new Error('Facebook Page ID and access token are not set (Settings → Social accounts).');
  const base = (apiBase || DEFAULT_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;
  const caption = post.caption || post.title || '';

  if (media && !fs.existsSync(media)) {
    throw new Error('Media file not found: ' + media);
  }

  /*
   * HAND IT TO FACEBOOK INSTEAD OF PUBLISHING IT.
   *
   * With `published=false` and a `scheduled_publish_time`, the whole post —
   * including the video bytes — goes to Facebook NOW and Facebook publishes it
   * at the appointed second. Nothing on this machine has to be alive for that
   * to happen: the PC can be switched off, unplugged, or in another building.
   * This is the only way a desktop app can honestly promise a post will go out.
   */
  const when = scheduleSeconds(opts.scheduleAt);
  const sched = when ? { published: 'false', scheduled_publish_time: String(when) } : {};

  let res;
  if (media && isVideoFile(media)) {
    res = await fbUploadVideo(base, pageId, token, media, { description: caption, ...sched }, opts);
  } else if (media) {
    res = await postMultipart(`${base}/${encodeURIComponent(pageId)}/photos`,
      { caption, ...sched, access_token: token }, media, 'source');
  } else {
    if (!caption) throw new Error('Post has no caption and no media — nothing to publish.');
    res = await postForm(`${base}/${encodeURIComponent(pageId)}/feed`,
      { message: caption, ...sched, access_token: token });
  }
  const id = res && (res.post_id || res.id);
  if (!id) throw new Error('Facebook accepted the request but returned no post id.');
  return { id, url: `https://www.facebook.com/${id}`, scheduled: !!when };
}

/**
 * Instagram's photo API only accepts JPEG. Re-encode PNG/WebP/GIF via
 * Electron's nativeImage (this file runs in the main process); under plain
 * Node (tests), or if decoding fails, the original file is sent unchanged.
 * Returns { path, cleanup } — call cleanup() once the upload is done.
 */
function asInstagramJpeg(filePath) {
  const passthrough = { path: filePath, cleanup: () => {} };
  if (/\.jpe?g$/i.test(filePath)) return passthrough;
  try {
    const ni = electron && electron.nativeImage;
    if (!ni) return passthrough;
    const img = ni.createFromPath(filePath);
    if (!img || img.isEmpty()) return passthrough;
    const buf = img.toJPEG(92);
    if (!buf || !buf.length) return passthrough;
    const out = path.join(os.tmpdir(),
      'mw-ig-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + '.jpg');
    fs.writeFileSync(out, buf);
    return { path: out, cleanup: () => { try { fs.unlinkSync(out); } catch (e) {} } };
  } catch (e) { return passthrough; }
}

/**
 * Publish one post to an Instagram Business account — a Reel for videos, a
 * feed photo for images.
 *
 * Videos (Meta's resumable flow): create a media container → POST the raw
 * bytes to the upload endpoint → poll until processing finishes → publish.
 *
 * Photos: Meta's API only accepts a PUBLIC image_url (never local bytes), so
 * the image is staged on the linked Facebook Page as an unpublished temporary
 * photo (it never appears on the Page), and its CDN URL becomes the
 * container's image_url → poll → publish.
 *
 * Returns { id, url }.
 * opts.pollMs / opts.maxPolls are injectable for tests (defaults: 3s / 200).
 */
/* ==================== Instagram video: TWO ROUTES ====================
 *
 * Meta gives two ways to get a local video into a Reels container, and they
 * fail independently — so the app tries both rather than betting on one:
 *
 *   1. RESUMABLE UPLOAD — the documented local-file route. Create the container
 *      with `upload_type=resumable`, then POST the raw bytes to
 *      rupload.facebook.com. No trace is left anywhere if it fails.
 *
 *   2. STAGED URL — the route Meta's own docs lead with. Instagram will fetch a
 *      video from a public URL, so the file is staged on the linked Facebook
 *      Page as an UNPUBLISHED upload (it never appears on the Page, and it is
 *      deleted again afterwards) and Instagram is handed the CDN URL. This is
 *      the same trick the photo path already uses.
 *
 * Route 1 is tried first because it leaves nothing behind. Route 2 is the
 * fallback — and it is worth having: when Meta's upload endpoint is failing,
 * route 1 dies with an opaque HTTP 500 while route 2 still reaches Instagram's
 * processor and reports a real error code.
 */

/** Poll a container until Instagram finishes (or gives up) on it. */
async function igPollContainer(base, containerId, token, opts = {}) {
  const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
  const maxPolls = opts.maxPolls != null ? opts.maxPolls : 200; // ~10 min at 3s
  for (let i = 0; i < maxPolls; i++) {
    const st = await getJsonRetry(`${base}/${encodeURIComponent(containerId)}?` +
      new URLSearchParams({ fields: 'status_code,status', access_token: token }));
    const code = (st && st.status_code) || 'IN_PROGRESS';
    if (code === 'FINISHED') return { code };
    if (code === 'ERROR' || code === 'EXPIRED') return { code, detail: (st && st.status) || '' };
    await sleep(pollMs);
  }
  return { code: 'TIMEOUT' };
}

/** Route 1 — container + raw bytes to Meta's resumable upload endpoint. */
async function igVideoViaResumable(base, igUserId, token, media, caption) {
  const container = await postForm(`${base}/${encodeURIComponent(igUserId)}/media`, {
    media_type: 'REELS', upload_type: 'resumable', caption, access_token: token,
  });
  if (!container || !container.id) throw new Error('Instagram did not return an upload container.');
  // Meta names the upload endpoint (and its API version) in the response; the
  // hard-coded URL is only a fallback for older/mocked responses.
  const uploadUrl = container.uri
    || `https://rupload.facebook.com/ig-api-upload/v19.0/${encodeURIComponent(container.id)}`;
  const size = fs.statSync(media).size;
  await postBinary(uploadUrl, media, {
    authorization: 'OAuth ' + token, offset: '0', file_size: String(size),
  });
  return { id: container.id, cleanup: null };
}

/** Route 2 — stage the video on the linked Page, then hand Instagram its URL. */
async function igVideoViaStagedUrl(base, igUserId, pageId, token, media, caption, opts = {}) {
  const staged = await fbUploadVideo(base, pageId || 'me', token, media, { published: 'false' }, opts);
  if (!staged || !staged.id) throw new Error('Could not stage the video on the linked Facebook Page.');
  // Deleting the staging upload is best-effort and must never mask a real error.
  const cleanup = async () => {
    try { await del(`${base}/${encodeURIComponent(staged.id)}?` + new URLSearchParams({ access_token: token })); }
    catch (e) { /* Facebook expires it on its own */ }
  };

  try {
    // Facebook has to finish its own processing before it will serve a URL.
    const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
    const maxPolls = opts.maxPolls != null ? opts.maxPolls : 100;
    let src = null;
    for (let i = 0; i < maxPolls; i++) {
      const info = await getJsonRetry(`${base}/${encodeURIComponent(staged.id)}?` +
        new URLSearchParams({ fields: 'status,source', access_token: token }));
      const vs = info && info.status && info.status.video_status;
      if (info && info.source && vs === 'ready') { src = info.source; break; }
      if (vs === 'error') break;
      await sleep(pollMs);
    }
    if (!src) throw new Error('Facebook never produced a link for the staged video.');

    const container = await postForm(`${base}/${encodeURIComponent(igUserId)}/media`, {
      media_type: 'REELS', video_url: src, caption, access_token: token,
    });
    if (!container || !container.id) throw new Error('Instagram did not return a media container.');
    return { id: container.id, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

/**
 * Meta's media-publishing error codes, in the words an operator can act on.
 * Anything not listed falls through to Meta's own text.
 */
const IG_MEDIA_ERRORS = {
  2207009: 'the picture’s shape — Instagram wants between 4:5 (tall) and 1.91:1 (wide)',
  2207010: 'the caption — Instagram allows at most 2,200 characters',
  2207020: 'the upload expired before Instagram finished with it',
  2207026: 'the video format — Reels need MP4 or MOV, H.264 video and AAC audio',
  2207052: 'Instagram could not fetch the video',
  2207053: 'an upload error Instagram did not explain',
};
const igErrCode = (s) => { const m = /error code (\d{4,})/i.exec(String(s || '')); return m ? Number(m[1]) : null; };

/**
 * One sentence an operator can act on, from what the two routes actually said.
 *
 * The important case is the one that is NOT the church's fault: when Instagram
 * takes photos happily but refuses every video — including files that meet its
 * published spec — the fault is on Meta's side, and saying so plainly is worth
 * more than another spec checklist the operator has already satisfied.
 */
/** Seconds of video, or null when the file cannot be probed. */
function igVideoSeconds(media) {
  const info = probeMedia(media);
  if (!info) return null;
  const v = (info.streams || []).find((x) => x.codec_type === 'video');
  const d = parseFloat((info.format && info.format.duration) || (v && v.duration) || 0) || 0;
  return d || null;
}
/*
 * Meta documents Reels at up to 15 minutes, but a great many accounts are
 * refused anything past 90 seconds. The app will not act on a rule it cannot
 * confirm — it still tries the post — but when a LONG video is the one that
 * came back rejected, the length is the first thing worth checking.
 */
const REELS_SOFT_LIMIT_SEC = 90;
function igLengthNote(seconds) {
  if (!seconds || seconds <= REELS_SOFT_LIMIT_SEC) return '';
  return ` Worth knowing: this video is ${Math.round(seconds)}s. Meta documents Reels up to 15 minutes, `
    + `but many accounts are refused past ${REELS_SOFT_LIMIT_SEC}s — if it keeps failing, try a shorter cut.`;
}
function igVideoFailure(attempts, seconds) {
  const codes = attempts.map((a) => igErrCode(a.detail || a.error)).filter(Boolean);
  const known = codes.find((c) => IG_MEDIA_ERRORS[c]);
  if (known) return `Instagram rejected the video — ${IG_MEDIA_ERRORS[known]}.` + igLengthNote(seconds);

  const meta = codes.find((c) => !IG_MEDIA_ERRORS[c]);
  const processingFailed = attempts.some((a) => /ProcessingFailedError|unknown error/i.test(a.error || ''));
  if (meta || processingFailed) {
    return 'Instagram accepted the post but its own video service failed on it'
      + (meta ? ` (Meta error ${meta})` : '')
      + '. This is a fault on Meta’s side, not with your video — the same thing happens to a file that meets every one of Instagram’s published specs. '
      + 'Photos still post normally. Press Retry later: the app tries both of Meta’s upload routes each time, so it will go out as soon as their service recovers.'
      + igLengthNote(seconds);
  }
  // Nothing recognisable: say what EACH route ran into rather than picking one.
  // Two different failures are the useful signal — one route timing out while
  // the other is refused tells a very different story from both being refused.
  const said = attempts.map((a) => `${a.route} → ${a.error || a.detail}`).join('; ');
  return 'Instagram could not publish the video. ' + said + igLengthNote(seconds);
}

/**
 * Problems worth catching BEFORE spending an upload on them. Only things
 * Instagram genuinely refuses — this must never block a video that would have
 * worked, so anything unprobeable simply passes.
 */
function igVideoProblems(media) {
  const info = probeMedia(media);
  if (!info) return [];
  const out = [];
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  // No readable video stream means ffprobe could not make sense of the file —
  // NOT proof that Instagram cannot. This check exists to save a doomed upload,
  // never to stand between the operator and a post that would have worked, so
  // an inconclusive probe says nothing and lets Instagram be the judge.
  if (!v) return [];
  const a = (info.streams || []).find((s) => s.codec_type === 'audio');
  const dur = parseFloat((info.format && info.format.duration) || v.duration || 0) || 0;
  const size = parseInt((info.format && info.format.size) || 0, 10) || 0;
  if (v.codec_name && !/^(h264|hevc|h265|av1)$/i.test(v.codec_name)) {
    out.push(`its video is ${v.codec_name || 'an unknown codec'} — Reels need H.264 (or HEVC)`);
  }
  if (a && a.codec_name && !/^(aac|mp3|opus)$/i.test(a.codec_name)) {
    out.push(`its audio is ${a.codec_name} — Reels need AAC`);
  }
  if (dur && dur < 3) out.push(`it is only ${dur.toFixed(1)}s long — Reels must be at least 3 seconds`);
  if (dur && dur > 15 * 60) out.push(`it is ${Math.round(dur / 60)} minutes long — Reels top out at 15 minutes`);
  if (size && size > 1024 * 1024 * 1024) out.push(`it is ${(size / 1e9).toFixed(1)}GB — Reels top out at 1GB`);
  if (v.width && v.height) {
    const ar = v.width / v.height;
    if (ar > 10 || ar < 0.01) out.push(`its shape (${v.width}×${v.height}) is outside what Reels accept`);
  }
  return out;
}

/** ffprobe the file, or null when it cannot be read (tests, odd containers). */
function probeMedia(file) {
  try {
    const { execFileSync } = require('child_process');
    const ffprobe = require('./ffmpeg').resolveFfprobe();
    const out = execFileSync(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { maxBuffer: 1 << 24, windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.toString());
  } catch (e) { return null; }
}

/** Try every route to a FINISHED Reels container; report what each one said. */
async function igVideoContainer({ base, igUserId, pageId, token, media, caption }, opts = {}) {
  const attempts = [];
  const routes = [
    ["resumable upload", () => igVideoViaResumable(base, igUserId, token, media, caption)],
    ["staged link", () => igVideoViaStagedUrl(base, igUserId, pageId, token, media, caption, opts)],
  ];
  for (const [name, run] of routes) {
    let got = null;
    try {
      got = await run();
      const st = await igPollContainer(base, got.id, token, opts);
      if (st.code === "FINISHED") return got;
      attempts.push({ route: name, detail: st.detail || st.code });
    } catch (e) {
      attempts.push({ route: name, error: e.message });
    }
    if (got && got.cleanup) await got.cleanup();
  }
  throw new Error(igVideoFailure(attempts, igVideoSeconds(media)));
}

async function publishToInstagram({ igUserId, pageId, token, apiBase }, post, opts = {}) {
  if (!igUserId || !token) throw new Error('Instagram account is not connected.');
  const base = (apiBase || DEFAULT_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;
  const caption = post.caption || post.title || '';

  if (!media) throw new Error('Instagram needs a photo or video — add one to this post (text-only posts are Facebook-only).');
  if (!fs.existsSync(media)) throw new Error('Media file not found: ' + media);
  const isVideo = isVideoFile(media);

  let containerId;
  let cleanup = null;
  if (isVideo) {
    // Catch the things Instagram flatly refuses before spending an upload on
    // them — a wrong codec is worth knowing about in a second, not after a
    // 50MB upload and two minutes of processing.
    const problems = igVideoProblems(media);
    if (problems.length) {
      throw new Error('Instagram will not take this video because ' + problems.join(', and ') + '.');
    }
    const got = await igVideoContainer({ base, igUserId, pageId, token, media, caption }, opts);
    containerId = got.id;
    cleanup = got.cleanup;
  } else {
    // 1. Stage the photo on the linked Facebook Page: unpublished (never shows
    //    on the Page) + temporary (Facebook cleans it up by itself). The IG
    //    token IS the Page token, so 'me' resolves to the Page if the stored
    //    account predates pageId.
    const jpeg = asInstagramJpeg(media);
    let staged;
    try {
      staged = await postMultipart(`${base}/${encodeURIComponent(pageId || 'me')}/photos`,
        { published: 'false', temporary: 'true', access_token: token }, jpeg.path, 'source');
    } finally { jpeg.cleanup(); }
    if (!staged || !staged.id) throw new Error('Could not stage the photo on the linked Facebook Page.');

    // 2. Ask Facebook for the staged photo's CDN URL (largest rendition first).
    const info = await getJson(`${base}/${encodeURIComponent(staged.id)}?` +
      new URLSearchParams({ fields: 'images', access_token: token }));
    const rendition = info && Array.isArray(info.images) && info.images[0];
    if (!rendition || !rendition.source) throw new Error('Facebook did not return a link for the staged photo.');

    // 3. Create the feed-photo container from that URL.
    const container = await postForm(`${base}/${encodeURIComponent(igUserId)}/media`, {
      image_url: rendition.source, caption, access_token: token,
    });
    if (!container || !container.id) throw new Error('Instagram did not return a media container.');
    containerId = container.id;

    // 4. Wait for Instagram to finish with it (photos are near-instant).
    const st = await igPollContainer(base, containerId, token, opts);
    if (st.code === 'ERROR' || st.code === 'EXPIRED') {
      const code = igErrCode(st.detail);
      throw new Error(code && IG_MEDIA_ERRORS[code]
        ? `Instagram rejected the photo — ${IG_MEDIA_ERRORS[code]}.`
        : 'Instagram could not process the photo (' + st.code + '). Feed photos want JPEG up to 8MB, aspect ratio between 4:5 and 1.91:1.');
    }
    if (st.code !== 'FINISHED') throw new Error('Instagram is still processing the photo — it never finished in time.');
  }

  try {
    // Publish the processed container.
    const pub = await postForm(`${base}/${encodeURIComponent(igUserId)}/media_publish`, {
      creation_id: containerId, access_token: token,
    });
    if (!pub || !pub.id) throw new Error('Instagram accepted the ' + (isVideo ? 'video' : 'photo') + ' but returned no media id.');

    // Best-effort permalink for the "View post" button.
    let url = 'https://www.instagram.com/';
    try {
      const perm = await getJson(`${base}/${encodeURIComponent(pub.id)}?` +
        new URLSearchParams({ fields: 'permalink', access_token: token }));
      if (perm && perm.permalink) url = perm.permalink;
    } catch (e) { /* permalink is cosmetic */ }
    return { id: pub.id, url };
  } finally {
    // Instagram has its own copy by now, so the staging upload can go.
    if (cleanup) await cleanup();
  }
}

/**
 * Swap a stored Google refresh token for a fresh (1-hour) access token.
 * Done before every upload — stateless, so nothing ever goes stale.
 */
async function ytAccessToken({ clientId, clientSecret, refreshToken, tokenBase }) {
  if (!clientId || !clientSecret || !refreshToken) throw new Error('YouTube account is not connected.');
  const res = await postForm(tokenBase || DEFAULT_YT_TOKEN, {
    client_id: clientId, client_secret: clientSecret,
    refresh_token: refreshToken, grant_type: 'refresh_token',
  });
  if (!res || !res.access_token) throw new Error('Google did not return an access token — reconnect the YouTube account.');
  return res.access_token;
}

/**
 * Publish one post to a YouTube channel via the Data API's resumable upload:
 * refresh the token → open an upload session → PUT the raw video bytes.
 * post.title becomes the video title, post.caption the description.
 * Returns { id, url }.
 */
async function publishToYouTube({ token, clientId, clientSecret }, post, opts = {}) {
  const tokenBase = opts.ytTokenBase || DEFAULT_YT_TOKEN;
  const apiBase = (opts.ytApiBase || DEFAULT_YT_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;

  if (!media) throw new Error('YouTube needs a video — add one to this post.');
  if (!fs.existsSync(media)) throw new Error('Media file not found: ' + media);
  if (!isVideoFile(media)) {
    throw new Error('YouTube auto-posts need a video file (MP4/MOV…) — this post has an image. Untick the YouTube account, or attach a video.');
  }

  const access = await ytAccessToken({ clientId, clientSecret, refreshToken: token, tokenBase });
  const size = fs.statSync(media).size;
  const snippet = {
    title: (post.title || (post.caption || '').split('\n')[0] || 'Untitled video').slice(0, 95),
    description: post.caption || '',
  };

  /*
   * YouTube schedules for us: upload the video now as PRIVATE with a publishAt,
   * and YouTube itself flips it public at that moment. `privacyStatus` MUST be
   * private for publishAt to be accepted, and the video must never have been
   * published — both true here, because the upload is what creates it.
   */
  const status = { privacyStatus: opts.privacy || 'public', selfDeclaredMadeForKids: false };
  if (opts.scheduleAt) {
    status.privacyStatus = 'private';
    status.publishAt = new Date(opts.scheduleAt).toISOString();
  }

  // 1. Open the resumable upload session.
  const init = await postJson(
    `${apiBase}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`,
    { snippet, status },
    {
      authorization: 'Bearer ' + access,
      'x-upload-content-length': String(size),
      'x-upload-content-type': 'video/*',
    });
  const uploadUrl = init.headers && init.headers.location;
  if (!uploadUrl) throw new Error('YouTube did not return an upload session.');

  // 2. Stream the raw video bytes into the session.
  const res = await postBinary(uploadUrl, media,
    { authorization: 'Bearer ' + access, 'content-type': 'video/*' }, { method: 'PUT' });
  if (!res || !res.id) throw new Error('YouTube accepted the upload but returned no video id.');
  return { id: res.id, url: 'https://www.youtube.com/watch?v=' + res.id, scheduled: !!opts.scheduleAt };
}

/** TikTok's v2 API wraps errors as { error: { code, message } } — code "ok" means success. */
function tkOk(json, what) {
  const err = json && json.error;
  if (err && err.code && err.code !== 'ok') {
    throw new Error('TikTok ' + what + ': ' + (err.message || err.code));
  }
  return json || {};
}

/**
 * Swap a stored TikTok refresh token for a fresh (24-hour) access token.
 * TikTok sometimes rotates the refresh token — the new one is handed to
 * onRefresh so the caller can persist it.
 */
async function tkAccessToken({ clientKey, clientSecret, refreshToken, apiBase, tokenProxy, proxyToken, onRefresh }) {
  if (!refreshToken) throw new Error('TikTok account is not connected.');
  let res;
  if (tokenProxy) {
    // Path A: the Worker holds the secret and does the refresh.
    const hdrs = proxyToken ? { 'x-app-token': proxyToken } : {};
    res = (await postJson(tokenProxy, { grant_type: 'refresh_token', refresh_token: refreshToken }, hdrs)).json;
  } else {
    if (!clientKey || !clientSecret) throw new Error('TikTok account is not connected.');
    const base = (apiBase || DEFAULT_TK_API).replace(/\/+$/, '');
    res = await postForm(`${base}/v2/oauth/token/`, {
      client_key: clientKey, client_secret: clientSecret,
      grant_type: 'refresh_token', refresh_token: refreshToken,
    });
  }
  if (!res || !res.access_token) throw new Error('TikTok did not return an access token — reconnect the TikTok account.');
  if (res.refresh_token && res.refresh_token !== refreshToken && onRefresh) {
    try { onRefresh(res.refresh_token); } catch (e) {}
  }
  return res.access_token;
}

/** PUT one byte range of a file (TikTok's chunked upload protocol). */
function putChunk(urlStr, filePath, start, end, total, headers, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = libFor(urlStr).request(u, {
      method: 'PUT',
      headers: {
        'content-type': 'video/mp4',
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${total}`,
        ...headers,
      },
    }, (res) => collectJson(res, resolve, reject));
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Upload timed out.')); });
    req.on('error', reject);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => req.destroy(err));
    stream.pipe(req);
  });
}

/**
 * Publish one post to TikTok via the Content Posting API's Direct Post flow:
 * refresh the token → query creator info (TikTok requires this before every
 * post; it also lists the visibility levels the app may use) → init a
 * FILE_UPLOAD → PUT the bytes (chunked above 64MB) → poll until published.
 *
 * Until TikTok audits the developer app, it only permits SELF_ONLY (private)
 * posts — the flow picks the most public level on the allowed list, so it
 * upgrades to public automatically once the audit passes.
 * Returns { id, url, privacy }.
 */
async function publishToTikTok({ token, clientKey, clientSecret, tokenProxy, proxyToken, username }, post, opts = {}) {
  const base = (opts.tkApiBase || DEFAULT_TK_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;

  if (!media) throw new Error('TikTok needs a video — add one to this post.');
  if (!fs.existsSync(media)) throw new Error('Media file not found: ' + media);
  if (!isVideoFile(media)) {
    throw new Error('TikTok auto-posts need a video file (MP4/MOV…) — this post has an image. Untick the TikTok account, or attach a video.');
  }

  const access = await tkAccessToken({
    clientKey, clientSecret, refreshToken: token, apiBase: base,
    tokenProxy: tokenProxy || opts.tkTokenProxy, proxyToken: proxyToken || opts.tkProxyToken,
    onRefresh: opts.onTkRefresh,
  });
  const bearer = { authorization: 'Bearer ' + access };

  // 1. Creator info — also tells us the best visibility this app is allowed.
  const ci = tkOk((await postJson(`${base}/v2/post/publish/creator_info/query/`, {}, bearer)).json, 'creator check');
  const levels = (ci.data && ci.data.privacy_level_options) || [];
  const privacy = levels.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : (levels[0] || 'SELF_ONLY');

  // 2. Open the upload. Whole file in one chunk when it fits; otherwise TikTok
  //    wants 5–64MB chunks with the final chunk absorbing the remainder.
  const size = fs.statSync(media).size;
  const MB = 1024 * 1024;
  let chunkSize, chunkCount;
  if (size <= (opts.tkMaxSingle || 64 * MB)) {
    chunkSize = size; chunkCount = 1;
  } else {
    chunkSize = opts.tkChunkSize || 10 * MB;
    chunkCount = Math.floor(size / chunkSize);
  }
  const title = (post.caption || post.title || '').slice(0, 2200);
  const init = tkOk((await postJson(`${base}/v2/post/publish/video/init/`, {
    post_info: {
      title, privacy_level: privacy,
      disable_duet: false, disable_comment: false, disable_stitch: false,
    },
    source_info: {
      source: 'FILE_UPLOAD', video_size: size,
      chunk_size: chunkSize, total_chunk_count: chunkCount,
    },
  }, bearer)).json, 'upload init');
  const publishId = init.data && init.data.publish_id;
  const uploadUrl = init.data && init.data.upload_url;
  if (!publishId || !uploadUrl) throw new Error('TikTok did not return an upload session.');

  // 3. Send the bytes.
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize;
    const end = i === chunkCount - 1 ? size - 1 : start + chunkSize - 1;
    await putChunk(uploadUrl, media, start, end, size, bearer);
  }

  // 4. Wait for TikTok to finish publishing.
  const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
  const maxPolls = opts.maxPolls != null ? opts.maxPolls : 200; // ~10 min at 3s
  let status = '', postId = '';
  for (let i = 0; i < maxPolls; i++) {
    const st = tkOk((await postJson(`${base}/v2/post/publish/status/fetch/`,
      { publish_id: publishId }, bearer)).json, 'status check');
    status = (st.data && st.data.status) || '';
    const ids = (st.data && st.data.publicaly_available_post_id) || []; // (sic — TikTok's field name)
    if (ids.length) postId = String(ids[0]);
    if (status === 'PUBLISH_COMPLETE') break;
    if (status === 'FAILED') {
      throw new Error('TikTok could not publish the video (' +
        ((st.data && st.data.fail_reason) || 'unknown reason') +
        '). TikTok wants MP4 (H.264/AAC), 3s–10min, 9:16 works best.');
    }
    await sleep(pollMs);
  }
  if (status !== 'PUBLISH_COMPLETE') throw new Error('TikTok is still processing the video — it never finished in time.');

  const url = username
    ? `https://www.tiktok.com/@${username}` + (postId ? `/video/${postId}` : '')
    : 'https://www.tiktok.com/';
  return { id: postId || publishId, url, privacy };
}

/**
 * Turn an Upload-Post failure into a message the media team can act on. A
 * plan/quota rejection (inevitable on the free plan's 10-posts/month cap) gets
 * a clear "upgrade or switch to your own TikTok app" hint instead of a raw
 * HTTP dump; everything else keeps the platform's own words plus a spec tip.
 */
function upFriendlyError(rawMsg) {
  const msg = String(rawMsg || 'the upload failed.').replace(/^HTTP \d+:\s*/, '').trim();
  if (/\b(limit|quota|exceed|upgrade|plan|subscription|payment required|402|403|429)\b/i.test(msg)) {
    return 'Upload-Post rejected the post: "' + msg + '". The free plan allows only 10 posts/month — ' +
      'upgrade your Upload-Post plan (unlimited from ~$16/mo), or connect your own TikTok app ' +
      '(Advanced setup) for unlimited free posting.';
  }
  return 'TikTok (via Upload-Post): ' + msg + ' TikTok wants MP4 (H.264/AAC), 3s–10min, 9:16 works best.';
}

/**
 * Publish one TikTok post through Upload-Post ("Easy connect"). Upload-Post's
 * own TikTok developer app is already audited, so public posting works with no
 * TikTok portal setup — the trade-off is the video travels via their servers.
 * One multipart POST does everything; if the upload flips to async (>59s),
 * poll the status endpoint until every platform reports in.
 * Returns { id, url, privacy }.
 */
/** Where a linked Upload-Post account lives on the web, for the "view it" link. */
const UP_PROFILE = {
  tiktok: (u) => (u ? `https://www.tiktok.com/@${u}` : 'https://www.tiktok.com/'),
  instagram: (u) => (u ? `https://www.instagram.com/${u}/` : 'https://www.instagram.com/'),
  youtube: (u) => (u ? `https://www.youtube.com/@${u}` : 'https://www.youtube.com/'),
  facebook: () => 'https://www.facebook.com/',
};
const UP_LABEL = { tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' };

async function publishViaUploadPost({ apiKey, upUser, username, platform = 'tiktok' }, post, opts = {}) {
  const label = UP_LABEL[platform] || platform;
  if (!apiKey || !upUser) throw new Error(label + ' (easy connect) account is not connected.');
  const base = (opts.upApiBase || DEFAULT_UP_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;

  // TikTok is video-only; Instagram takes a photo as well as a Reel.
  const videoOnly = platform === 'tiktok' || platform === 'youtube';
  if (!media) throw new Error(label + ' needs a ' + (videoOnly ? 'video' : 'photo or video') + ' — add one to this post.');
  if (!fs.existsSync(media)) throw new Error('Media file not found: ' + media);
  const isVid = isVideoFile(media);
  if (videoOnly && !isVid) {
    throw new Error(label + ' auto-posts need a video file (MP4/MOV…) — this post has an image. Untick the ' + label + ' account, or attach a video.');
  }

  const auth = { authorization: 'Apikey ' + apiKey };
  const title = (post.caption || post.title || '').slice(0, 2200);

  /*
   * SCHEDULING. Upload-Post is a cloud service, so `scheduled_date` moves the
   * waiting off this PC entirely — which for Instagram is the ONLY way it can
   * happen at all, Meta offering no scheduling of its own. Accepted up to a
   * year ahead; the reply is a 202 with a job_id, and that id is what cancels
   * it later (see cancelScheduled).
   */
  const sched = opts.scheduleAt ? { scheduled_date: new Date(opts.scheduleAt).toISOString(), timezone: 'UTC' } : {};

  // A photo goes to a different endpoint, under a different field name.
  const endpoint = isVid ? `${base}/upload` : `${base}/upload_photos`;
  const fileField = isVid ? 'video' : 'photos[]';
  const tkFields = platform === 'tiktok' ? { privacy_level: 'PUBLIC_TO_EVERYONE', post_mode: 'DIRECT_POST' } : {};

  let res;
  try {
    res = await postMultipart(endpoint, {
      user: upUser, 'platform[]': platform, title, ...tkFields, ...sched,
    }, media, fileField, { headers: auth });
  } catch (e) {
    // Non-2xx (plan/quota/auth) — surface an actionable message.
    throw new Error(upFriendlyError(e.message));
  }

  // Some plan/limit rejections come back HTTP 200 with success:false.
  if (res && res.success === false) throw new Error(upFriendlyError(res.message || res.error));

  const profileUrl = (UP_PROFILE[platform] || UP_PROFILE.tiktok)(username);

  // Booked, not posted: there is no result to wait for, only a job id to keep.
  if (opts.scheduleAt) {
    const jobId = res && (res.job_id || res.jobId);
    if (!jobId) throw new Error('Upload-Post accepted the post but did not say which booking it is — try again.');
    return { id: jobId, jobId, url: profileUrl, scheduled: true };
  }

  // Big uploads flip to async — poll until the aggregated status completes.
  if (res && res.request_id && !res.results) {
    const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
    const maxPolls = opts.maxPolls != null ? opts.maxPolls : 200; // ~10 min at 3s
    let st = null;
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      st = await getJson(`${base}/uploadposts/status?` +
        new URLSearchParams({ request_id: res.request_id }), { headers: auth });
      if (st && st.status === 'completed') break;
    }
    if (!st || st.status !== 'completed') throw new Error('Upload-Post is still processing the video — it never finished in time.');
    const done = (Array.isArray(st.results) ? st.results : []).find((r) => r.platform === platform);
    if (!done || done.success !== true) throw new Error(upFriendlyError(done && done.message));
    return { id: res.request_id, url: profileUrl, privacy: platform === 'tiktok' ? 'PUBLIC_TO_EVERYONE' : 'public' };
  }

  const got = res && res.results && res.results[platform];
  if (!got || got.success !== true) throw new Error(upFriendlyError(got && got.error));
  return {
    id: got.post_id || got.publish_id || 'uploadpost',
    url: got.url || profileUrl,
    privacy: platform === 'tiktok' ? 'PUBLIC_TO_EVERYONE' : 'public',
  };
}

/**
 * Turn a Zernio failure into a message the media team can act on. A plan/limit
 * rejection points at the free backup route (Upload-Post) instead of a raw HTTP
 * dump; everything else keeps Zernio's own words plus a spec tip.
 */
const ZO_LABELS = { tiktok: 'TikTok', youtube: 'YouTube', facebook: 'Facebook', instagram: 'Instagram' };
const ZO_PROFILE = {
  tiktok: (u) => u ? `https://www.tiktok.com/@${u}` : 'https://www.tiktok.com/',
  youtube: (u) => u ? `https://www.youtube.com/@${u}` : 'https://www.youtube.com/',
  facebook: () => 'https://www.facebook.com/',
  instagram: (u) => u ? `https://www.instagram.com/${u}/` : 'https://www.instagram.com/',
};

/** Classify a media file for Zernio: video vs image, with the right content-type. */
function zoMediaKind(filePath) {
  if (isVideoFile(filePath)) return { type: 'video', contentType: 'video/mp4', ext: '.mp4' };
  if (/\.png$/i.test(filePath)) return { type: 'image', contentType: 'image/png', ext: '.png' };
  return { type: 'image', contentType: 'image/jpeg', ext: '.jpg' };
}

/** A key that has stopped working, told plainly enough to act on. */
function zoDeadKey(msg) {
  return /unauthorized|invalid api key|401/i.test(String(msg || ''));
}
/*
 * Instagram Reels through this route are documented at 3–90 seconds, 300MB,
 * MP4/MOV H.264. The length is what a church trips over again and again: a good
 * sermon clip runs a minute and a half and then some. Not a block — the app was
 * asked to warn rather than stop — but when the post comes back rejected, the
 * length is named, with the file's real duration, so the next move is obvious.
 */
const ZO_IG_MAX_SEC = 90;
const ZO_IG_MAX_BYTES = 300 * 1024 * 1024;
function zoIgVideoNote(media) {
  if (!media) return '';
  const bits = [];
  const secs = igVideoSeconds(media);
  if (secs && secs > ZO_IG_MAX_SEC) {
    bits.push(`this video is ${Math.round(secs)}s and Instagram Reels are capped at ${ZO_IG_MAX_SEC}s`);
  }
  try {
    const size = fs.statSync(media).size;
    if (size > ZO_IG_MAX_BYTES) bits.push(`it is ${(size / 1e6).toFixed(0)}MB and the limit is 300MB`);
  } catch (e) { /* unreadable — say nothing rather than guess */ }
  if (!bits.length) return '';
  return ' Most likely cause: ' + bits.join(', and ') + '. Trim it in Video Studio and send the shorter cut to Instagram.';
}
function zoFriendlyError(rawMsg, platform) {
  if (zoDeadKey(rawMsg)) {
    return 'Your Zernio key is no longer valid — Zernio rejects it on every request, so nothing routed through them '
      + '(TikTok, YouTube, Instagram) can post. Sign in at zernio.com, copy a fresh API key, and paste it into '
      + 'Settings → Social accounts.';
  }
  const label = ZO_LABELS[platform] || 'The platform';
  const msg = String(rawMsg || 'the upload failed.').replace(/^HTTP \d+:\s*/, '').trim();
  if (/payment|free_tier_exceeded|more than 2 accounts/i.test(msg)) {
    return 'Zernio will not take this post: its free plan covers 2 linked accounts and they are already in use. '
      + 'Unlink one on zernio.com, or connect this platform its own direct way (YouTube has a free unlimited Google route).';
  }
  if (/\b(limit|quota|exceed|upgrade|plan|subscription|payment required|402|403|429|too many)\b/i.test(msg)) {
    return 'Zernio rejected the post: "' + msg + '". Zernio\'s free plan is unlimited for posts but covers 2 accounts — ' +
      'if you hit a wall, free up a Zernio slot, or connect the free backup route (Connect → Upload-Post).';
  }
  const tip = (platform === 'tiktok') ? ' TikTok wants MP4 (H.264/AAC), 3s–10min, 9:16 works best.'
    : (platform === 'youtube') ? ' YouTube wants MP4 (H.264/AAC).'
    : (platform === 'instagram') ? ' Instagram wants JPEG/PNG photos or an MP4 Reel.'
    : '';
  return label + ' (via Zernio): ' + msg + '.' + tip;
}

/**
 * Publish one post through Zernio ("Easy connect — free & unlimited") to TikTok,
 * YouTube, Facebook, or Instagram. Zernio's own developer apps are already
 * audited/verified, so public posting works with no TikTok portal / no Google
 * Cloud Console / no Meta app AND no monthly post cap on the free plan. The
 * platform ingests media from a public URL, so the flow is: (if there's media)
 * ask Zernio for a one-time upload URL → PUT the raw bytes → create the post
 * referencing the hosted URL, PUBLIC, with the platform's own settings block.
 * Photos and text-only posts (Facebook) are supported, not just video. Large/
 * slow posts process async, so the post is polled until the platform reports.
 * Returns { id, url, privacy }.
 */
async function publishViaZernio({ apiKey, accountId, username, platform }, post, opts = {}) {
  platform = platform || 'tiktok';
  const label = ZO_LABELS[platform] || platform;
  if (!apiKey || !accountId) throw new Error(label + ' (easy connect) account is not connected.');
  const base = (opts.zoApiBase || DEFAULT_ZO_API).replace(/\/+$/, '');
  const media = (post.mediaPaths && post.mediaPaths[0]) || null;
  const content = (post.caption || post.title || '').slice(0, 2200);

  const needsVideo = platform === 'tiktok' || platform === 'youtube';
  const needsMedia = needsVideo || platform === 'instagram'; // Facebook allows text-only

  if (media && !fs.existsSync(media)) throw new Error('Media file not found: ' + media);
  const kind = media ? zoMediaKind(media) : null;
  if (needsVideo && (!media || kind.type !== 'video')) {
    throw new Error(label + ' auto-posts need a video file (MP4/MOV…)' + (media ? ' — this post has an image.' : '.') +
      ' Untick the ' + label + ' account, or attach a video.');
  }
  if (platform === 'instagram' && !media) {
    throw new Error('Instagram needs a photo or video — add one to this post (text-only posts are Facebook-only).');
  }
  if (!media && !content) throw new Error('Post has no caption and no media — nothing to publish.');

  const bearer = { authorization: 'Bearer ' + apiKey };

  // 1+2. If there's media, upload it (presign → PUT) to get a public hosted URL.
  //      (Zernio's CDN hosts the bytes so the platform can ingest from a URL.)
  let publicUrl = null;
  if (media) {
    let filename = path.basename(media).replace(/[^\w.\-]+/g, '_') || ('media' + kind.ext);
    if (!/\.\w+$/.test(filename)) filename += kind.ext;
    let presign;
    try {
      presign = (await postJson(`${base}/media/presign`, { filename, contentType: kind.contentType }, bearer)).json;
    } catch (e) {
      throw new Error(zoFriendlyError(e.message, platform));
    }
    const uploadUrl = presign && (presign.uploadUrl || presign.upload_url);
    publicUrl = presign && (presign.publicUrl || presign.public_url || presign.url);
    if (!uploadUrl || !publicUrl) throw new Error('Zernio did not return an upload URL — try again.');
    await postBinary(uploadUrl, media, { 'content-type': kind.contentType }, { method: 'PUT' });
  }

  // 3. Create the post: PUBLIC, with the platform's own settings block.
  const platformEntry = { platform, accountId };
  if (platform === 'instagram') {
    // Instagram's options ride on the PLATFORM ENTRY as platformSpecificData,
    // not as a top-level block the way tiktokSettings does. A single video
    // publishes as a Reel by itself; shareToFeed puts it on the grid as well,
    // which is what a church wants for a sermon clip.
    platformEntry.platformSpecificData = { shareToFeed: true };
  }
  /*
   * Instagram and TikTok have NO scheduling of their own — Meta's content
   * containers expire in 24 hours and TikTok's Content Posting API publishes
   * now or not at all. Zernio is a cloud service, so handing it the post with
   * a `scheduledFor` moves the waiting off this PC and onto theirs. That is
   * the only route by which an Instagram Reel goes out with this machine off.
   */
  const body = opts.scheduleAt
    ? { content, platforms: [platformEntry], scheduledFor: new Date(opts.scheduleAt).toISOString(), timezone: 'UTC' }
    : { content, platforms: [platformEntry], publishNow: true };
  if (publicUrl) body.mediaItems = [{ type: kind.type, url: publicUrl }];
  if (platform === 'youtube') {
    body.youtubeSettings = {
      title: (post.title || content.split('\n')[0] || 'Untitled video').slice(0, 100),
      visibility: 'public', madeForKids: false, categoryId: '22',
    };
  } else if (platform === 'tiktok') {
    body.tiktokSettings = {
      privacy_level: 'PUBLIC_TO_EVERYONE',
      content_preview_confirmed: true, express_consent_given: true,
      disable_duet: false, disable_comment: false, disable_stitch: false,
    };
  } else if (platform === 'facebook') {
    body.facebookSettings = { draft: false };
  } // instagram: platformSpecificData is optional for a plain feed post — omit.

  let res;
  try {
    res = (await postJson(`${base}/posts`, body, bearer)).json;
  } catch (e) {
    throw new Error(zoFriendlyError(e.message, platform) + (platform === 'instagram' ? zoIgVideoNote(media) : ''));
  }

  const profileUrl = (ZO_PROFILE[platform] || (() => ''))(username);
  const postId = res && (res.id || res._id || (res.post && (res.post.id || res.post._id)));
  const platOf = (r) => {
    const arr = (r && (r.platforms || r.results || (r.post && r.post.platforms))) || [];
    return Array.isArray(arr) ? arr.find((x) => x && x.platform === platform) : null;
  };
  // A scheduled post's terminal state is "scheduled" — it is SUPPOSED to sit
  // there until its time. Waiting for "published" would poll for ten minutes
  // and then declare a perfectly good post a failure.
  const doneStates = opts.scheduleAt
    ? /^(scheduled|queued|pending|published|posted|success|completed|complete|live|done)$/i
    : /^(published|posted|success|completed|complete|live|done)$/i;
  const failStates = /^(failed|error|errored|rejected)$/i;
  const stateOf = (x, r) => String((x && x.status) || (r && r.status) || '').trim();

  let tk = platOf(res);
  let st = stateOf(tk, res);

  // Async plans return "processing" — poll the post until the platform reports
  // back. (A 2xx create with an id but no terminal status is treated as queued/ok.)
  // Nothing to wait for when the post is meant to sit in Zernio's queue.
  if (!opts.scheduleAt && !failStates.test(st) && !doneStates.test(st) && postId) {
    const pollMs = opts.pollMs != null ? opts.pollMs : 3000;
    const maxPolls = opts.maxPolls != null ? opts.maxPolls : 200; // ~10 min at 3s
    for (let i = 0; i < maxPolls; i++) {
      await sleep(pollMs);
      let got;
      try { got = await getJson(`${base}/posts/${encodeURIComponent(postId)}`, { headers: bearer }); }
      catch (e) { continue; }
      tk = platOf(got) || tk;
      st = stateOf(tk, got);
      if (doneStates.test(st) || failStates.test(st)) break;
    }
  }
  if (failStates.test(st)) {
    throw new Error(zoFriendlyError((tk && (tk.error || tk.message)) || (label + ' rejected the post.'), platform)
      + (platform === 'instagram' ? zoIgVideoNote(media) : ''));
  }

  const url = (tk && (tk.postUrl || tk.url || tk.permalink)) || profileUrl;
  return {
    id: (tk && (tk.postId || tk.post_id)) || postId || 'zernio', url,
    // Cancelling later needs Zernio's OWN post id, not the platform's.
    zoPostId: postId || null,
    scheduled: !!opts.scheduleAt,
    privacy: platform === 'tiktok' ? 'PUBLIC_TO_EVERYONE' : 'public',
  };
}

/**
 * Publish one post to one connected account (the scheduler's entry point).
 * account: a record from accounts.js — { platform, pageId | igUserId | channelId, token }.
 */
/* ===================================================================== *
 *  POSTING WITH THE PC OFF — handing the post to the platform itself.
 *
 *  A desktop app cannot run on a switched-off computer. The only honest way
 *  to make "it will go out at 9am on Sunday" true is to stop this PC being
 *  the thing that posts: upload the video NOW, with the time attached, and
 *  let the platform's own servers publish it.
 *
 *  Who can be handed a post, and who cannot:
 *
 *    Facebook Page   YES, natively. published=false + scheduled_publish_time,
 *                    10 minutes to 6 months ahead.
 *    YouTube         YES, natively. Uploaded private with status.publishAt;
 *                    YouTube flips it public itself.
 *    Instagram       NOT by Meta. The content container it would need expires
 *                    after 24 hours and there is no scheduled_publish_time on
 *                    the Content Publishing API at all.
 *    TikTok          NOT by TikTok. The Content Posting API publishes now or
 *                    saves a draft; a future time is a thing TikTok keeps for
 *                    its own app.
 *
 *  For those last two there is exactly one route left, and this app already
 *  has it: the accounts connected "via Zernio", which IS a cloud service and
 *  does take a scheduledFor. Anything that cannot be handed over at all falls
 *  back to the background poster (autopost.js) and needs this PC switched on.
 * ===================================================================== */

// Facebook's own window for a scheduled post. Ten minutes is Meta's floor;
// six months is its ceiling for a Page video.
const FB_SCHEDULE_MIN_MS = 10 * 60 * 1000;
const FB_SCHEDULE_MAX_MS = 180 * 24 * 60 * 60 * 1000;

function scheduleSeconds(at) {
  return at ? Math.floor(at / 1000) : null;
}

/**
 * Can this account be handed a post to publish later by itself?
 * Returns { can, via, why } — `why` is written to be shown to the operator,
 * because "your Instagram needs the PC on" is something they have to be told
 * rather than discover on a Sunday.
 */
function canSchedule(account, whenMs, now = Date.now()) {
  if (!account || !account.token) return { can: false, why: 'That account is not connected.' };
  const lead = whenMs ? whenMs - now : null;

  if (account.via === 'zernio') {
    return { can: true, via: 'zernio', why: 'Zernio holds it and posts it for you.' };
  }
  if (account.via === 'uploadpost') {
    return { can: true, via: 'uploadpost', why: 'Upload-Post holds it and posts it for you.' };
  }
  if (account.platform === 'facebook') {
    if (lead != null && lead < FB_SCHEDULE_MIN_MS) {
      return { can: false, why: 'Facebook only takes posts booked at least 10 minutes ahead.' };
    }
    if (lead != null && lead > FB_SCHEDULE_MAX_MS) {
      return { can: false, why: 'Facebook only holds a booked post for 6 months ahead.' };
    }
    return { can: true, via: 'facebook', why: 'Facebook holds it and posts it for you.' };
  }
  if (account.platform === 'youtube') {
    return { can: true, via: 'youtube', why: 'YouTube holds it private and makes it public at the time.' };
  }
  if (account.platform === 'instagram') {
    return { can: false, why: 'Instagram itself has no way to book a post in advance — Meta’s API does not offer one, at any price. Reconnect this account the “easy” way and it can be booked like the rest.' };
  }
  if (account.platform === 'tiktok') {
    return { can: false, why: 'TikTok itself has no way to book a post in advance through its API. Reconnect this account the “easy” way and it can be booked like the rest.' };
  }
  return { can: false, why: `Booking ${account.platform} posts in advance is not supported.` };
}

/**
 * Hand ONE post to ONE account's platform, to be published at `whenMs`.
 * Deliberately routed through the very same publish functions: the upload,
 * the chunking, the error messages and the retries are the code that is
 * already proven, and only the "when" differs.
 */
async function scheduleTo(account, post, whenMs, opts = {}) {
  const cap = canSchedule(account, whenMs, opts.now || Date.now());
  if (!cap.can) { const e = new Error(cap.why); e.cannotSchedule = true; throw e; }
  const res = await publishTo(account, post, { ...opts, scheduleAt: whenMs });
  return { ...res, via: cap.via, publishAt: new Date(whenMs).toISOString() };
}

/**
 * Call off a post that was handed over — because the operator deleted it or
 * moved it. A booked post that cannot be cancelled WILL still go out, so the
 * failure is thrown rather than swallowed; the Scheduler turns it into
 * something the operator can read and act on.
 */
async function cancelScheduled(account, handoff, opts = {}) {
  if (!handoff || !handoff.id) return { cancelled: false, why: 'nothing booked' };
  const via = handoff.via || (account && account.platform);

  if (via === 'zernio') {
    const base = (opts.zoApiBase || DEFAULT_ZO_API).replace(/\/+$/, '');
    const id = handoff.zoPostId || handoff.id;
    await del(`${base}/posts/${encodeURIComponent(id)}`, { headers: { authorization: 'Bearer ' + account.token } });
    return { cancelled: true };
  }
  if (via === 'uploadpost') {
    const base = (opts.upApiBase || DEFAULT_UP_API).replace(/\/+$/, '');
    const jobId = handoff.jobId || handoff.id;
    await del(`${base}/uploadposts/schedule/${encodeURIComponent(jobId)}`,
      { headers: { authorization: 'Apikey ' + account.token } });
    return { cancelled: true };
  }
  if (via === 'facebook') {
    const base = (opts.apiBase || DEFAULT_API).replace(/\/+$/, '');
    await del(`${base}/${encodeURIComponent(handoff.id)}?access_token=${encodeURIComponent(account.token)}`);
    return { cancelled: true };
  }
  if (via === 'youtube') {
    const apiBase = (opts.ytApiBase || DEFAULT_YT_API).replace(/\/+$/, '');
    const access = await ytAccessToken({
      clientId: account.clientId, clientSecret: account.clientSecret,
      refreshToken: account.token, tokenBase: opts.ytTokenBase || DEFAULT_YT_TOKEN,
    });
    await del(`${apiBase}/youtube/v3/videos?id=${encodeURIComponent(handoff.id)}`,
      { headers: { authorization: 'Bearer ' + access } });
    return { cancelled: true };
  }
  return { cancelled: false, why: 'Nothing here knows how to cancel a ' + via + ' booking.' };
}

async function publishTo(account, post, opts = {}) {
  if (!account || !account.token) throw new Error('Account is not connected.');
  const apiBase = opts.apiBase;
  if (account.platform === 'facebook') {
    if (account.via === 'zernio') {
      return publishViaZernio({
        apiKey: account.token, accountId: account.zoAccountId, username: account.username, platform: 'facebook',
      }, post, opts);
    }
    return publishToFacebook({ pageId: account.pageId, token: account.token, apiBase }, post, opts);
  }
  if (account.platform === 'instagram') {
    if (account.via === 'zernio') {
      return publishViaZernio({
        apiKey: account.token, accountId: account.zoAccountId, username: account.username, platform: 'instagram',
      }, post, opts);
    }
    if (account.via === 'uploadpost') {
      return publishViaUploadPost({
        apiKey: account.token, upUser: account.upUser, username: account.username, platform: 'instagram',
      }, post, opts);
    }
    return publishToInstagram({
      igUserId: account.igUserId, pageId: account.pageId, token: account.token, apiBase,
    }, post, opts);
  }
  if (account.platform === 'youtube') {
    if (account.via === 'zernio') {
      return publishViaZernio({
        apiKey: account.token, accountId: account.zoAccountId, username: account.username, platform: 'youtube',
      }, post, opts);
    }
    return publishToYouTube({ token: account.token, clientId: account.clientId, clientSecret: account.clientSecret }, post, opts);
  }
  if (account.platform === 'tiktok') {
    if (account.via === 'zernio') {
      return publishViaZernio({
        apiKey: account.token, accountId: account.zoAccountId, username: account.username, platform: 'tiktok',
      }, post, opts);
    }
    if (account.via === 'uploadpost') {
      return publishViaUploadPost({
        apiKey: account.token, upUser: account.upUser, username: account.username,
      }, post, opts);
    }
    return publishToTikTok({
      token: account.token, clientKey: account.clientKey,
      clientSecret: account.clientSecret, tokenProxy: account.tokenProxy,
      proxyToken: account.proxyToken, username: account.username,
    }, post, opts);
  }
  throw new Error(`Auto-posting to ${account.platform} is not supported yet.`);
}

/** Verify a Page ID + token pair: returns { id, name } of the Page. */
async function testFacebook({ pageId, token, apiBase }) {
  if (!pageId || !token) throw new Error('Enter both the Page ID and the access token first.');
  const base = (apiBase || DEFAULT_API).replace(/\/+$/, '');
  const q = new URLSearchParams({ fields: 'id,name', access_token: token }).toString();
  const res = await getJson(`${base}/${encodeURIComponent(pageId)}?${q}`);
  if (!res || !res.id) throw new Error('Facebook did not return the Page. Check the Page ID and token.');
  return { id: res.id, name: res.name || '' };
}

module.exports = {
  publishToFacebook, publishToInstagram, publishToYouTube, publishToTikTok,
  publishViaUploadPost, publishViaZernio, publishTo, testFacebook,
  canSchedule, scheduleTo, cancelScheduled, FB_SCHEDULE_MIN_MS, FB_SCHEDULE_MAX_MS,
  ytAccessToken, tkAccessToken, isVideoFile, getJson, postForm, postJson, postMultipart,
  videoApiBase, fbUploadVideo, fbChunkedVideo, FB_MAX_CHUNK,
  igVideoProblems, igVideoFailure, igPollContainer, IG_MEDIA_ERRORS, igErrCode,
  igVideoSeconds, igLengthNote, REELS_SOFT_LIMIT_SEC, zoDeadKey, zoIgVideoNote, ZO_IG_MAX_SEC,
  DEFAULT_API, DEFAULT_YT_TOKEN, DEFAULT_YT_API, DEFAULT_TK_API, DEFAULT_UP_API, DEFAULT_ZO_API,
};
