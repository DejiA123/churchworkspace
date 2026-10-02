'use strict';
/*
 * NDI® output — the Presentation Studio publishes its screens onto the network.
 *
 * This is the piece that lets a church send lyrics to the stream box, the
 * overflow room and the foyer TVs over one network cable instead of running
 * HDMI everywhere. A vMix/OBS/ATEM operator sees "GRACE-PC (Lyrics Key)" appear
 * in their NDI source list and picks it up like any camera.
 *
 * How a frame gets from a slide to the wire:
 *
 *   an OFFSCREEN BrowserWindow renders output.html at exactly the resolution
 *   the operator asked for (not whatever monitor happens to be attached), and
 *   Electron hands us each painted frame as BGRA
 *        -> we copy that frame once and TRANSFER it (zero copy) to the worker
 *        -> the worker holds it, compresses and sends it on a steady clock,
 *           off the main process
 *
 * Offscreen rendering is what makes an NDI feed a first-class output rather
 * than a screen-scrape: no window on the desktop, an exact 1920×1080 regardless
 * of the laptop's screen, and — because the window can be transparent — a real
 * alpha channel, which is what "keyable lower third over NDI" actually means.
 *
 * ===================== TWO THINGS THAT REALLY BROKE ======================
 *
 * 1. THE FEED WAS NOT THE SIZE IT SAID IT WAS. An offscreen window paints at
 *    contentSize × the display's scale factor, and a window CREATED at a given
 *    size is first clamped to the desktop work area. Measured on a 1536×864
 *    desktop at 125%: asking for 1920×1080 produced a 1920×1020 feed (clamped
 *    to the work area, then scaled), and asking for 1280×720 produced 1600×900.
 *    A switcher fed 1920×1020 letterboxes or crops the lyrics, which is exactly
 *    the "it doesn't work properly in vMix" complaint. `setContentSize` AFTER
 *    creation is not clamped, so the window is created small and then sized to
 *    (want ÷ scaleFactor) — and because no machine should have to be trusted
 *    about its own scale factor, the FIRST PAINT is measured and the content
 *    size corrected from what actually came out. See sizeToExact().
 *
 * 2. A STILL SLIDE COST 235 MB/s. A slide that isn't moving paints ONCE, and
 *    NDI receivers still need a frame every interval, so the last frame has to
 *    be re-sent. That used to mean the MAIN process copying the whole 1080p
 *    BGRA bitmap (7.8 MB) thirty times a second and posting it to the worker —
 *    while the operator was trying to advance slides. The frame the worker
 *    already holds is now the one it re-sends, so main copies a frame only when
 *    a NEW one is painted, and a static slide costs it nothing at all.
 *    (It must copy on paint: nativeImage.getBitmap() is only valid inside the
 *    current tick, so keeping that buffer for a later send is a use-after-free
 *    dressed up as an optimisation.)
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { BrowserWindow, screen } = require('electron');
const ndi = require('./ndi');

let worker = null;
let workerError = null;
const feeds = new Map();   // id -> feed record
let onChange = null;
let stateSource = null;    // () => the live show state, so a feed is never blank

const OUTPUT_HTML = () => path.join(__dirname, '..', 'renderer', 'output.html');
const PRELOAD = () => path.join(__dirname, 'preload.js');

function setNotifier(fn) { onChange = fn; }
function setStateSource(fn) { stateSource = fn; }
function notify() { if (onChange) { try { onChange(state()); } catch (e) {} } }

function status() {
  const s = ndi.getStatus();
  return { available: !!s.available, error: s.available ? null : s.error, machine: s.machine, dll: s.dll };
}

function ensureWorker() {
  if (worker) return worker;
  const s = ndi.getStatus();
  if (!s.available) throw new Error(s.error || 'NDI is not available on this machine.');
  worker = new Worker(path.join(__dirname, 'ndi-send-worker.js'), { workerData: { dllPath: s.dll } });
  worker.on('message', (m) => {
    if (!m) return;
    const f = m.id ? feeds.get(m.id) : null;
    if (m.kind === 'open' && f) { f.ok = !!m.ok; f.error = m.error || null; notify(); }
    else if (m.kind === 'status' && f) {
      f.connections = m.connections; f.sentW = m.w; f.sentH = m.h; f.sent = m.sent; f.sendMs = m.sendMs;
    }
    else if (m.kind === 'error') { workerError = m.message; }
  });
  worker.on('error', (e) => { workerError = String((e && e.message) || e); });
  worker.on('exit', () => { worker = null; });
  return worker;
}

/**
 * Make the offscreen window paint at EXACTLY `want` device pixels.
 *
 * Painted size = contentSize × the display's scale factor, and a size given at
 * creation is clamped to the work area first. setContentSize is not clamped, so
 * dividing by the scale factor here lands on the requested size on a normal
 * machine — and `correctFromPaint` fixes the rest from the size that actually
 * came out, which covers every arrangement of monitors and scaling this can't
 * know about in advance.
 */
function sizeToExact(win, want) {
  let scale = 1;
  try { scale = screen.getPrimaryDisplay().scaleFactor || 1; } catch (e) {}
  const cw = Math.max(1, Math.round(want.w / scale));
  const chh = Math.max(1, Math.round(want.h / scale));
  try { win.setContentSize(cw, chh); } catch (e) {}
}

/** One correction step, driven by the size the last paint really was. */
function correctFromPaint(feed, actual) {
  if (feed.sizeFixes >= 4 || !feed.win || feed.win.isDestroyed()) return;
  if (actual.width === feed.width && actual.height === feed.height) return;
  feed.sizeFixes++;
  let cs;
  try { cs = feed.win.getContentSize(); } catch (e) { return; }
  const sx = actual.width / cs[0], sy = actual.height / cs[1];
  if (!isFinite(sx) || !isFinite(sy) || sx <= 0 || sy <= 0) return;
  try { feed.win.setContentSize(Math.max(1, Math.round(feed.width / sx)), Math.max(1, Math.round(feed.height / sy))); }
  catch (e) {}
}

/**
 * Start publishing one output over NDI.
 *
 * `look`/`id` travel to the page exactly like a real projector window, so an
 * NDI feed can carry a completely different Look from the room screen — plain
 * keyable text for the stream while the room gets the decorative treatment.
 * `group` is the NDI group name (or comma-separated names) a switcher can
 * filter its source list by; blank means the default group, which is what
 * nearly every church wants.
 */
function start({ id, name, width, height, fps, alpha, sourceId, group } = {}) {
  const feedId = id || 'ndi';
  stop(feedId);
  const w = Math.max(160, Math.min(3840, Math.round(width || 1920)));
  const h = Math.max(90, Math.min(2160, Math.round(height || 1080)));
  const rate = Math.max(5, Math.min(60, Math.round(fps || 30)));
  const label = name || 'Presentation';
  const groups = String(group || '').trim();

  ensureWorker().postMessage({ cmd: 'open', id: feedId, name: label, fps: rate, groups: groups || null, alpha: !!alpha });

  const win = new BrowserWindow({
    // Deliberately small at creation: a window created at 1920×1080 is clamped
    // to the desktop work area and never recovers. sizeToExact() below sets the
    // real size, which is not clamped.
    width: 640, height: 360,
    show: false,
    frame: false,
    transparent: !!alpha,
    backgroundColor: alpha ? '#00000000' : '#000000',
    webPreferences: {
      preload: PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      offscreen: true,               // renders without ever being on a screen
      backgroundThrottling: false,
    },
  });
  sizeToExact(win, { w, h });
  win.webContents.setFrameRate(rate);
  win.loadFile(OUTPUT_HTML(), { query: { role: 'audience', id: sourceId || feedId, ndi: '1', alpha: alpha ? '1' : '0' } });

  const feed = {
    id: feedId, name: label, width: w, height: h, fps: rate, alpha: !!alpha, group: groups,
    sourceId: sourceId || feedId, win, connections: 0, ok: null, error: null,
    frames: 0, sizeFixes: 0, sentW: 0, sentH: 0, live: false,
  };
  feeds.set(feedId, feed);

  // Whatever is live right now, the moment the page is ready — an NDI feed
  // started mid-service must never go out blank.
  win.webContents.on('did-finish-load', () => {
    if (!stateSource) return;
    try { win.webContents.send('present:state', stateSource()); } catch (e) {}
  });

  win.webContents.on('paint', (_e, _dirty, image) => {
    const f = feeds.get(feedId);
    if (!f || !worker) return;
    try {
      const size = image.getSize();
      if (!size.width || !size.height) return;
      if (size.width !== f.width || size.height !== f.height) { correctFromPaint(f, size); return; }
      // getBitmap() is only valid inside THIS tick, so the copy is mandatory —
      // and it is the only copy: the worker keeps this buffer and re-sends it
      // for as long as the slide is unchanged.
      const bmp = image.getBitmap();
      if (!bmp || !bmp.length) return;
      const stride = Math.floor(bmp.length / size.height);
      const copy = new Uint8Array(bmp.length);
      copy.set(bmp);
      worker.postMessage({ cmd: 'frame', id: feedId, buf: copy.buffer, w: size.width, h: size.height, stride },
        [copy.buffer]);
      f.frames++;
      f.live = true;
    } catch (e) {}
  });

  notify();
  return publicFeed(feed);
}

function stop(id) {
  const f = feeds.get(id);
  if (!f) return false;
  feeds.delete(id);
  if (worker) { try { worker.postMessage({ cmd: 'close', id }); } catch (e) {} }
  if (f.win && !f.win.isDestroyed()) { try { f.win.destroy(); } catch (e) {} }
  notify();
  return true;
}

function stopAll() {
  for (const id of Array.from(feeds.keys())) stop(id);
  if (worker) { try { worker.postMessage({ cmd: 'stop' }); } catch (e) {} worker = null; }
  return true;
}

const publicFeed = (f) => ({
  id: f.id, name: f.name, width: f.width, height: f.height, fps: f.fps, alpha: f.alpha, group: f.group || '',
  sourceId: f.sourceId, connections: f.connections || 0, frames: f.frames || 0, sent: f.sent || 0,
  ok: f.ok, error: f.error, live: !!f.live,
  // What the wire is really carrying — an operator with a squashed picture in
  // vMix needs to see the number, not be told everything is fine. `sendMs` is
  // how long this machine takes to compress and send one frame, which is the
  // honest answer to "why is my 1080p feed not running at 60".
  sentW: f.sentW || 0, sentH: f.sentH || 0, sendMs: f.sendMs || 0,
});

function state() {
  return {
    ...status(),
    error: status().error || workerError,
    feeds: Array.from(feeds.values()).map(publicFeed),
  };
}

/** Push the live show state into every NDI window, like a real output. */
function push(st) {
  for (const [, f] of feeds) {
    const wc = f.win && !f.win.isDestroyed() ? f.win.webContents : null;
    if (wc && !wc.isDestroyed()) { try { wc.send('present:state', st); } catch (e) {} }
  }
}

const list = () => Array.from(feeds.values()).map(publicFeed);

module.exports = { start, stop, stopAll, state, status, push, list, setNotifier, setStateSource };
