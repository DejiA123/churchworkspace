'use strict';
/*
 * The Cloud Studio's service worker.
 *
 * It exists for two reasons and no others:
 *
 *   1. a PWA is not installable without one, and installing is the whole point
 *      — "Add to Home Screen" is what turns a URL into the church's editor;
 *   2. the shell is 700 KB of editor, and on a phone in a car park it should
 *      not be fetched again every time the app is opened.
 *
 * WHAT IT MUST NEVER CACHE, and why this file is deliberately blunt about it:
 *
 *   • /api/…   — every one of these is an instruction to a machine ("cut this",
 *                "how far along is the export"). A cached answer is a lie, and
 *                a REPLAYED one would run a job twice.
 *   • /api/media, /api/file — a two-hour service recording is gigabytes and the
 *                browser streams it by Range. Putting that through a cache is
 *                how a phone fills its disk and then cannot scrub.
 *
 * So the rule is: the SHELL is cached, the STUDIO's work never is. The fetch
 * handler simply does not answer anything under /api/ — with ONE exception,
 * asked for by name: a video the operator chose "Keep on this phone" for
 * (cloud-boot.js MWOffline). That file was downloaded on purpose, whole, into
 * its own cache; its /api/media requests are answered from there, a byte range
 * at a time, so it plays and scrubs with no signal. Any other media request —
 * and any hiccup reading the kept one — goes to the network exactly as before.
 *
 * The version rides in the registration URL (`/sw.js?v=2.66.0`). A new build
 * means a new script URL, a new worker, a new cache name, and the old cache
 * deleted — which is what stops a phone opening last month's editor against
 * this month's server.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const SHELL_CACHE = 'mw-shell-' + VERSION;
const AI_CACHE = 'mw-ai-' + VERSION;
// Not per version: the bundled fonts do not change between updates, and a phone
// that is updated most days should not fetch 3.2 MB of them each time. Bump the
// number if a bundled font file ever does change.
const FONT_CACHE = 'mw-fonts-1';
// Videos kept on this phone (cloud-boot.js MWOffline). Never per version: an
// update must not throw away a sermon someone downloaded to edit on the train.
const OFFLINE_MEDIA = 'mw-offline-media';
const offlineKey = (p) => '/offline-media?p=' + encodeURIComponent(p);
let kept = null;   // the studio paths kept on this phone
function loadKept() {
  return caches.open(OFFLINE_MEDIA).then((c) => c.keys()).then((keys) => {
    kept = new Set(keys.map((k) => { try { return new URL(k.url).searchParams.get('p'); } catch (e) { return null; } }).filter(Boolean));
    return kept;
  }).catch(() => (kept = kept || new Set()));
}
loadKept();
self.addEventListener('message', (e) => { if (e.data && e.data.mwKept) e.waitUntil ? e.waitUntil(loadKept()) : loadKept(); });
/* A kept video, answered as a server answers one: the part the player asks for. */
async function rangedFrom(req, hit) {
  const blob = await hit.blob();
  const size = blob.size, type = hit.headers.get('content-type') || 'video/mp4';
  const h = req.headers.get('range');
  const m = h && /bytes=(\d*)-(\d*)/.exec(h);
  if (!m) return new Response(blob, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
  let a, b;
  if (m[1] === '') { a = Math.max(0, size - Number(m[2] || 0)); b = size - 1; }
  else { a = Number(m[1]); b = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (!(a < size) || b < a) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
  return new Response(blob.slice(a, b + 1), { status: 206, headers: {
    'Content-Type': type, 'Content-Length': String(b - a + 1), 'Content-Range': `bytes ${a}-${b}/${size}`, 'Accept-Ranges': 'bytes',
  } });
}

/* The page, and everything it needs to draw the desk. */
const SHELL = [
  '/',
  '/cloud.css?v=' + VERSION,
  '/cloud-boot.js?v=' + VERSION,
  '/cloud-social.js?v=' + VERSION,
  '/cloud-flyer.js?v=' + VERSION,
  '/r/styles.css?v=' + VERSION,
  '/r/facetrack.js?v=' + VERSION,
  '/r/caplayout.js?v=' + VERSION,
  '/r/wordbook-english.js?v=' + VERSION,
  '/r/wordbook.js?v=' + VERSION,
  '/r/cutout.js?v=' + VERSION,
  '/r/flyerai.js?v=' + VERSION,
  '/r/rasterize.js?v=' + VERSION,
  '/r/veditor.js?v=' + VERSION,
  '/r/guide.js?v=' + VERSION,
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/flyer-c.jpg',
  '/icons/flyer-a.jpg',
  '/icons/flyer-b.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // One bad URL must not fail the whole install — an editor that will not
    // install because an icon 404'd is worse than an editor with no icon.
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, AI_CACHE, FONT_CACHE, OFFLINE_MEDIA]);
    for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isShell = (p) => p === '/' || p === '/cloud.css' || p === '/cloud-boot.js' || p === '/cloud-social.js' || p === '/cloud-flyer.js'
  || p === '/manifest.webmanifest' || p.startsWith('/r/') || p.startsWith('/icons/');

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (er) { return; }
  if (url.origin !== self.location.origin) return;

  const p = url.pathname;

  // A video kept on this phone: from the phone (see the note at the top).
  if (p === '/api/media') {
    const mp = url.searchParams.get('p');
    if (!mp || (kept && !kept.has(mp))) return;   // not kept: untouched, as always
    e.respondWith((async () => {
      try {
        const k = kept || await loadKept();
        if (k.has(mp)) {
          const hit = await (await caches.open(OFFLINE_MEDIA)).match(offlineKey(mp));
          if (hit) return await rangedFrom(req, hit);
        }
      } catch (er) { /* fall through to the network */ }
      return fetch(req);
    })());
    return;
  }

  // The studio's own work: never cached, never replayed, never touched.
  if (p.startsWith('/api/')) return;

  /*
   * MediaPipe's wasm and models: ~10 MB, identical for every install and for
   * every version of this app, and needed before auto-reframe can run at all.
   * Cache-first, because re-downloading them on a phone's data is the
   * difference between reframing a clip and giving up on it.
   */
  // The caption fonts: the same, cache-first — kept across updates (FONT_CACHE).
  if (p.startsWith('/fonts/')) {
    e.respondWith((async () => {
      const cache = await caches.open(FONT_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  if (p.startsWith('/ai/')) {
    e.respondWith((async () => {
      const cache = await caches.open(AI_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  if (!isShell(p)) return;

  /*
   * The page itself is network-FIRST: the studio machine may have been updated
   * since this phone last opened, and serving a cached editor against a newer
   * server is exactly the drift this whole project refuses to have. The cache
   * is the fallback for when there is no signal, not the source of truth.
   */
  if (p === '/') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(SHELL_CACHE);
        cache.put('/', fresh.clone()).catch(() => {});
        return fresh;
      } catch (er) {
        const hit = await caches.match('/');
        return hit || new Response(
          '<!doctype html><meta charset="utf-8"><title>Church Space</title>'
          + '<body style="font:16px system-ui;background:#0b0d12;color:#eef1f7;display:grid;place-items:center;height:100vh;margin:0">'
          + '<div style="text-align:center;padding:24px"><div style="font-size:40px">✝&#xFE0E;</div>'
          + '<h1 style="font-size:18px">The studio is not reachable</h1>'
          + '<p style="color:#8a93a8">This phone has no connection, or the studio machine is switched off.</p></div>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
        );
      }
    })());
    return;
  }

  // Everything else in the shell: answer from the cache at once, and quietly
  // refresh it for next time. The match is EXACT, `?v=` included: the page asks
  // for the build it was made with, and ignoring the query handed a freshly
  // deployed page last build's cloud-boot.js — the fix on the server, the bug
  // on the phone.
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return hit || (await network) || new Response('', { status: 504 });
  })());
});
