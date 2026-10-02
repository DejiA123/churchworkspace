'use strict';
/*
 * "The software freezes from time to time, especially in the presentation page."
 *
 * This puts a number on the freeze, and then guards it.
 *
 * A freeze is not a crash and not a bug in any one function — it is the main
 * thread being busy for longer than a person is willing to wait. So this test
 * does not assert that functions return the right value; it MEASURES how long
 * the two threads that can freeze are unavailable:
 *
 *   • the RENDERER thread — measured with a 10 ms heartbeat inside the page.
 *     Every gap longer than its interval is time the window could not repaint,
 *     could not scroll, could not accept a click. The biggest gap during an
 *     action IS the freeze that action causes.
 *   • the MAIN process — measured with its own 10 ms heartbeat here. Main is
 *     shared by every window, so a block in main freezes the studio AND the
 *     projector AND the stage monitor at once. This is the one an in-memory
 *     test stub can never see, so the store below is the REAL Store writing to
 *     a REAL file.
 *
 * The workload is a Sunday, not a toy: a library of 30 songs, an open deck of
 * 80 slides with backgrounds, and a projector window actually open — because
 * every cue is pushed to it and that push is part of the cost.
 *
 * Thresholds are in human terms, not machine terms:
 *   16.7 ms  one frame at 60 Hz
 *   100 ms   the limit of "instant" — below this a keystroke feels direct
 *   250 ms   a visible stall
 *   1000 ms  Windows starts drawing the "not responding" ghost
 *
 *   npx electron test/present-freeze.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/main/store'));

const WORK = path.join(os.tmpdir(), 'mw-present-freeze');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));
app.disableHardwareAcceleration();

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => (n == null ? '?' : Math.round(n) + ' ms');

/* A test that measures freezes must never itself hang silently: a hung run and
 * a slow run look identical from outside. Every await is raced against a clock
 * and the whole run against a hard stop. */
let stage = 'boot';
const at = (s) => { stage = s; console.log('  .. ' + s); };
setTimeout(() => {
  console.log(`\n  !! WATCHDOG: still in "${stage}" after 240 s — treating as a hang.`);
  console.log(`  ${pass} PASS / ${fail + 1} FAIL`);
  app.exit(1);
}, 240000).unref && null;
const withTimeout = (p, msLimit, label) => Promise.race([
  p, sleep(msLimit).then(() => ({ __error: `timed out after ${msLimit} ms (${label})` })),
]);

/* ===================== main-process freeze meter =====================
 * A 10 ms timer that records how late it actually fired. setTimeout cannot run
 * while main is inside a synchronous call, so its lateness IS main's block. */
const mainMeter = { max: 0, samples: 0, on: false, over100: 0 };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - mainLast - 10;
  mainLast = now;
  if (mainMeter.on && late > 0) {
    mainMeter.samples++;
    if (late > mainMeter.max) mainMeter.max = late;
    if (late > 100) mainMeter.over100++;
  }
}, 10);
const mainMeterStart = () => { mainMeter.max = 0; mainMeter.samples = 0; mainMeter.over100 = 0; mainLast = Date.now(); mainMeter.on = true; };
const mainMeterStop = () => { mainMeter.on = false; return { max: mainMeter.max, over100: mainMeter.over100 }; };

/* ===================== the real store, on a real disk ===================== */
const store = new Store(path.join(WORK, 'workstation.json'), {
  settings: {}, presentations: [], playlists: [], presentThemes: [],
});
/* Count what actually reaches the disk, not what asked to. A save that is
 * coalesced away costs nothing; a save that blocks the main process costs
 * everything, so both are measured. */
let storeWrites = 0, storeWriteMs = 0;
for (const fn of ['_writeNow', 'flushSync']) {
  if (typeof Store.prototype[fn] !== 'function') continue;
  const orig = Store.prototype[fn];
  Store.prototype[fn] = function (...a) {
    const t = Date.now();
    const r = orig.apply(this, a);
    if (r && typeof r.then === 'function') return r.then((v) => { storeWrites++; storeWriteMs += Date.now() - t; return v; });
    storeWrites++; storeWriteMs += Date.now() - t;
    return r;
  };
}

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const deck = (k) => (store.get(k) || []);

/* The presentation CRUD, copied from main.js verbatim so the cost is the real
 * cost — this is the handler the shipped app runs. */
ipcMain.handle('present:library', wrap(async () => ({
  presentations: deck('presentations'), playlists: deck('playlists'), themes: deck('presentThemes'),
})));
ipcMain.handle('present:savePresentation', wrap(async (e, { presentation }) => {
  const list = deck('presentations').slice();
  const i = list.findIndex((p) => p.id === presentation.id);
  if (i >= 0) list[i] = presentation; else list.unshift(presentation);
  store.set('presentations', list);
  return presentation;
}));
ipcMain.handle('present:savePlaylist', wrap(async (e, { playlist }) => {
  const list = deck('playlists').slice();
  const i = list.findIndex((p) => p.id === playlist.id);
  if (i >= 0) list[i] = playlist; else list.push(playlist);
  store.set('playlists', list);
  return playlist;
}));
ipcMain.handle('present:deletePresentation', wrap(async (e, { id }) => {
  store.set('presentations', deck('presentations').filter((p) => p.id !== id)); return true;
}));
ipcMain.handle('present:deletePlaylist', wrap(async (e, { id }) => {
  store.set('playlists', deck('playlists').filter((p) => p.id !== id)); return true;
}));
ipcMain.handle('present:saveThemes', wrap(async (e, { themes }) => { store.set('presentThemes', themes || []); return themes || []; }));

/* ---- everything else the studio asks for on boot ---- */
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {}, present: { translation: 'kjv' } }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('bible:languages', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('bgvideo:list', () => ok([]));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('bible:books', () => ok([]));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));

/* ---- the projector: the REAL presenter module and a REAL output window ----
 * A cue that goes nowhere costs nothing; the cost being measured includes
 * pushing the state to a window that is actually showing it. */
const presenter = require(path.join(ROOT, 'src/main/presenter'));
let livePushes = 0;
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async (e, a) => Object.assign(presenter.open(a || {}), { state: presenter.state() })));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async (e, patch) => { livePushes++; presenter.setState(patch || {}); return true; }));

/* ===================== the Sunday-sized workload ===================== */
const uid = () => 'x' + Math.random().toString(36).slice(2, 10);
const LYRIC = [
  'Amazing grace, how sweet the sound',
  'That saved a wretch like me',
  'I once was lost, but now am found',
  'Was blind, but now I see',
];
const GROUPS = ['Verse 1', 'Chorus', 'Verse 2', 'Bridge', 'Tag'];
function makeDoc(name, nSlides) {
  return {
    id: uid(), name, kind: 'song', lookId: 'look-royal', updated: Date.now(),
    slides: Array.from({ length: nSlides }, (_, i) => ({
      id: uid(),
      group: GROUPS[i % GROUPS.length],
      lines: LYRIC.slice(0, 2 + (i % 3)),
      footer: i % 5 === 0 ? 'CCLI 22025' : '',
      notes: '',
      bg: i % 3 === 0 ? { type: 'gradient', value: 'linear-gradient(160deg,#101a3a,#2a1650 60%,#06263a)' } : null,
      look: null,
    })),
  };
}
const BIG_SLIDES = 80;            // a long song set / sermon deck, in one document
const LIBRARY_DOCS = 30;          // what a church actually accumulates

app.whenReady().then(async () => {
  at('seeding the store');
  /* Seed the store BEFORE the studio boots, so it loads a real library. */
  const docs = [makeDoc('Amazing Grace (long set)', BIG_SLIDES)];
  for (let i = 1; i < LIBRARY_DOCS; i++) docs.push(makeDoc('Song ' + i, 8 + (i % 7)));
  store.set('presentations', docs);
  store.set('playlists', [{ id: uid(), name: 'This Sunday', items: docs.slice(0, 8).map((d) => ({ id: uid(), presentationId: d.id, name: d.name })) }]);
  store.flushSync();
  const bytes = fs.statSync(path.join(WORK, 'workstation.json')).size;
  storeWrites = 0; storeWriteMs = 0;      // the seed is not part of the measurement

  at('opening the studio window');
  const win = new BrowserWindow({
    width: 1500, height: 950, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false,
      /*
       * The shipped studio sets this, and so must the test.
       *
       * Chromium throttles timers in a window it thinks is occluded — hard
       * enough that a heartbeat set for every 10 ms can go thirty seconds
       * between ticks. Without this line the meter reads those thirty seconds
       * as a thirty-second freeze, which is how a run of this test on a busy
       * desktop produced numbers that had nothing to do with the app. Matching
       * production means what is measured here is the app's own behaviour.
       */
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  // Keep the studio's own outputs list honest, exactly as main.js does.
  presenter.setNotifier(() => {
    if (win && !win.isDestroyed()) win.webContents.send('present:outputs', presenter.state());
  });
  await withTimeout(win.loadFile(path.join(ROOT, 'src/renderer/index.html')), 60000, 'loadFile');
  at('index.html loaded — waiting for the studio to settle');
  await sleep(1800);

  const js = (code) => withTimeout(win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    60000, 'executeJavaScript');
  const bad = (r) => r && r.__error;
  const fmt = (f) => `p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · worst ${ms(f.max)}`;

  /* The renderer's own freeze meter, installed once and reused by every step. */
  await js(`
    window.__fm = { on: false, last: 0, all: [] };
    setInterval(() => {
      const now = performance.now();
      if (window.__fm.on && window.__fm.last) {
        const late = now - window.__fm.last - 10;
        if (late > 0) window.__fm.all.push(late);
      }
      window.__fm.last = now;
    }, 10);
    window.__fmStart = () => { window.__fm.all = []; window.__fm.last = performance.now(); window.__fm.on = true; };
    window.__fmStop = () => {
      window.__fm.on = false;
      const a = window.__fm.all.slice().sort((x, y) => x - y);
      const at = (q) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0);
      return { n: a.length, p50: at(0.5), p95: at(0.95), max: Math.round(a[a.length - 1] || 0),
               over250: a.filter((x) => x > 250).length };
    };
    return 1;`);

  at('switching to the Presentation view');
  await js(`document.querySelector('.nav-item[data-view="present"]').click(); await new Promise(r => setTimeout(r, 600)); return 1;`);
  at('presentation view open');

  head(`[0] The workload  (store ${(bytes / 1024).toFixed(0)} KB, ${LIBRARY_DOCS} songs, open deck ${BIG_SLIDES} slides)`);
  const loaded = await js(`
    const T = window.Presenter.__test;
    const d = window.Presenter.__test.openDoc ? null : null;
    return { docs: (T.playlists() ? 1 : 1), slideCount: document.querySelectorAll('#pvSlides .pv-slide').length,
             stages: document.querySelectorAll('#pvSlides .sr-stage').length };`);
  if (bad(loaded)) { check('studio loaded the seeded library', false, loaded.__error); }
  else check('studio loaded the seeded library', loaded.slideCount >= BIG_SLIDES,
    `${loaded.slideCount} slide cards, ${loaded.stages} painted stages`);

  /* ---------------- [1] one full re-render of the slide grid ---------------- */
  head('[1] One renderSlides() of an 80-slide deck  (this runs on every edit, twice)');
  const r1 = await js(`
    const T = window.Presenter.__test;
    // warm
    T.reflow ? T.reflow() : T.selectSlide(0);
    const t0 = performance.now();
    T.selectSlide(1);
    const t1 = performance.now();
    T.selectSlide(2);
    const t2 = performance.now();
    return { first: t1 - t0, second: t2 - t1,
             stages: document.querySelectorAll('#pvSlides .sr-stage').length };`);
  if (bad(r1)) check('renderSlides measured', false, r1.__error);
  else {
    console.log(`    render #1 ${ms(r1.first)}   render #2 ${ms(r1.second)}   (${r1.stages} stages painted)`);
    check('a slide-grid re-render stays under one 60 Hz frame budget x3 (50 ms)',
      r1.second < 50, ms(r1.second));
  }

  /* ---------------- [2] typing a lyric — the reported freeze ---------------- */
  head('[2] Typing in the slide editor  (real key events, projector open)');
  await js(`await window.Presenter.__test.clickGoLive(); await new Promise(r => setTimeout(r, 500)); return 1;`);
  const opened = await js(`
    const T = window.Presenter.__test;
    T.selectSlide(3);
    const r = T.openSlideEditorViaButton(3);
    await new Promise(r2 => setTimeout(r2, 200));
    return r;`);
  check('slide editor opened', !bad(opened) && opened.opened, bad(opened) ? opened.__error : 'controls: ' + (opened.controls || []).length);

  await js(`const ta = document.querySelector('.pv-sled-text'); if (ta) ta.focus(); return !!ta;`);

  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const beforeWrites = storeWrites;
  const beforePushes = livePushes;

  const WORD = 'Amazing grace how sweet the sound';
  const tType0 = Date.now();
  for (const ch of WORD) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await sleep(30);                       // ~33 wpm-ish burst, a real typist
  }
  const typeWall = Date.now() - tType0;
  const rFm = await js('return window.__fmStop();');
  const mFm = mainMeterStop();

  console.log(`    ${WORD.length} keystrokes in ${typeWall} ms wall (30 ms apart)`);
  console.log(`    renderer gaps: ${fmt(rFm)}  (n=${rFm.n})`);
  console.log(`    main process blocked:  ${ms(mFm.max)}   stalls>100ms: ${mFm.over100}`);
  console.log(`    disk writes: ${storeWrites - beforeWrites} (${storeWriteMs} ms total)   projector pushes: ${livePushes - beforePushes}`);

  check('a keystroke never freezes the window past "instant" (100 ms)',
    rFm.p95 < 50, fmt(rFm));
  check('no keystroke stalls the window for a quarter second',
    rFm.max < 250 && rFm.over250 === 0, `worst ${ms(rFm.max)}`);
  check('the main process never blocks past 100 ms while typing',
    mFm.max < 100, `worst main block ${ms(mFm.max)}`);
  check('typing does not write the whole library to disk on every key',
    (storeWrites - beforeWrites) <= 3, `${storeWrites - beforeWrites} disk writes for ${WORD.length} keys`);

  /* ---------------- [2b] where a keystroke's time actually goes -------------
   * Guessing which call is slow is how the last round of this went wrong. The
   * three seams a keystroke crosses are all patchable from outside, so they are
   * measured rather than reasoned about. */
  head('[2b] Breakdown of the same typing burst');
  await js(`
    window.__prof = { paint: [0, 0], comp: [0, 0], save: [0, 0] };
    const wrapFn = (obj, name, slot) => {
      const f = obj[name];
      obj[name] = function (...a) {
        const t = performance.now();
        const r = f.apply(this, a);
        if (r && typeof r.then === 'function') return r.finally(() => { const d = performance.now() - t; window.__prof[slot][0]++; window.__prof[slot][1] += d; });
        const d = performance.now() - t; window.__prof[slot][0]++; window.__prof[slot][1] += d;
        return r;
      };
    };
    wrapFn(window.SlideRender, 'paint', 'paint');
    wrapFn(window.SlideRender, 'paintComposite', 'comp');
    wrapFn(window.api.present, 'savePresentation', 'save');
    return 1;`);
  await js(`
    const T = window.Presenter.__test;
    T.selectSlide(5);
    T.openSlideEditorViaButton(5);
    await new Promise(r => setTimeout(r, 150));
    return !!document.querySelector('.pv-sled');`);
  await js(`
    window.__prof = { paint: [0,0], comp: [0,0], save: [0,0] };
    window.SlideRender.repaints.slides = 0; window.SlideRender.repaints.composites = 0;
    return 1;`);
  for (const ch of WORD) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await sleep(30); }
  await sleep(700);                                  // let the debounced save land
  const prof = await js('return Object.assign({}, window.__prof, { rebuilt: window.SlideRender.repaints.slides, rebuiltComp: window.SlideRender.repaints.composites });');
  if (bad(prof)) console.log('    (breakdown unavailable: ' + prof.__error + ')');
  else {
    const row = (k, label) => console.log(`    ${label.padEnd(30)} ${String(prof[k][0]).padStart(4)} calls   ${ms(prof[k][1])} total`);
    row('paint', 'SlideRender.paint (asked)');
    row('comp', 'paintComposite (monitors)');
    row('save', 'savePresentation (IPC)');
    console.log(`    stages actually rebuilt        ${String(prof.rebuilt).padStart(4)} slides, ${prof.rebuiltComp} composites`);
    /* The whole point: a letter typed into slide 6 must rebuild slide 6, not the
     * eighty slides around it. Two rebuilds per key is the floor — the slide's
     * thumbnail in the grid, and the editor's own large preview of it. */
    check('typing rebuilds only the slide being typed into',
      prof.rebuilt <= WORD.length * 2 + 5,
      `${prof.rebuilt} stage rebuilds for ${WORD.length} keys (deck is ${BIG_SLIDES}; floor is 2/key)`);
    check('the whole typing burst costs less than one video frame per key',
      (prof.paint[1] + prof.comp[1] + prof.save[1]) < WORD.length * 16.7,
      `${ms(prof.paint[1] + prof.comp[1] + prof.save[1])} for ${WORD.length} keys`);
  }
  await js(`
    const c = document.querySelector('.pv-sled-x') || document.querySelector('.pv-sled-cancel');
    if (c) c.click(); await new Promise(r => setTimeout(r, 150)); return 1;`);

  /* ---------------- [3] the arrow keys — the Sunday-morning control ---------- */
  head('[3] Stepping slides with the arrow keys  (the most-used control in a service)');
  await js(`
    const c = document.querySelector('.pv-sled-x') || document.querySelector('.pv-sled-cancel');
    if (c) c.click();
    await new Promise(r => setTimeout(r, 200));
    return !document.querySelector('.pv-sled');`);
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const stepTimes = await js(`
    const T = window.Presenter.__test;
    const out = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      T.step(1);
      out.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 40));
    }
    return out;`);
  const sFm = await js('return window.__fmStop();');
  const sMain = mainMeterStop();
  if (bad(stepTimes)) check('arrow-key stepping measured', false, stepTimes.__error);
  else {
    const worstStep = Math.max(...stepTimes);
    const medStep = stepTimes.slice().sort((a, b) => a - b)[Math.floor(stepTimes.length / 2)];
    console.log(`    per-cue: median ${ms(medStep)}  worst ${ms(worstStep)}`);
    console.log(`    renderer gaps: ${fmt(sFm)}   main blocked worst: ${ms(sMain.max)}`);
    check('advancing a slide lands inside 100 ms', worstStep < 100, `worst ${ms(worstStep)}`);
    check('advancing a slide keeps the studio responsive', sFm.p95 < 50, fmt(sFm));
    check('and advancing a slide never stalls it visibly', sFm.max < 250 && sFm.over250 === 0, `worst ${ms(sFm.max)}`);
  }

  /* ---------------- [3b] moving between songs mid-service ------------------
   * Opening another song is the one action that legitimately rebuilds the whole
   * grid, so it is the worst case that remains. An operator does it between
   * every item in the running order, often with the congregation waiting. */
  head('[3b] Opening another song from the Library');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const swap = await js(`
    const T = window.Presenter.__test;
    const out = [];
    // Walk the library the way an operator walks a running order — by clicking
    // the rail, so the ids come from the rail rather than from a test-only hook.
    const all = Array.from(document.querySelectorAll('#pvLibList [data-doc]')).map((b) => b.dataset.doc);
    if (!all.length) return { __error: 'no songs in the library rail' };
    for (let n = 0; n < 8; n++) {
      const id = all[n % all.length];
      const t = performance.now();
      T.openDoc(id);
      out.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 60));
    }
    return out;`);
  const wFm = await js('return window.__fmStop();');
  const wMain = mainMeterStop();
  if (bad(swap)) check('song switching measured', false, swap.__error);
  else {
    const worst = Math.max(...swap), med = swap.slice().sort((a, b) => a - b)[Math.floor(swap.length / 2)];
    console.log(`    per song: median ${ms(med)}  worst ${ms(worst)}   (includes an 80-slide deck)`);
    console.log(`    renderer frozen worst: ${ms(wFm.max)}   main blocked worst: ${ms(wMain.max)}`);
    check('opening another song never freezes the window past 250 ms',
      wFm.max < 250, ms(wFm.max));
  }

  /* ---------------- [4] dragging a Look slider ---------------- */
  head('[4] Dragging a text-size slider in the Look editor  (fires ~60 events/s)');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const beforeW2 = storeWrites;
  const slider = await js(`
    const el = document.querySelector('#lkSize');
    if (!el) return { skipped: true };
    const t0 = performance.now();
    for (let v = 60; v <= 110; v += 2) {
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 16));
    }
    return { total: performance.now() - t0, ticks: 26 };`);
  const lFm = await js('return window.__fmStop();');
  const lMain = mainMeterStop();
  if (bad(slider)) check('slider drag measured', false, slider.__error);
  else if (slider.skipped) console.log('    SKIP — #lkSize not present in this build');
  else {
    console.log(`    26 slider ticks in ${ms(slider.total)}`);
    console.log(`    renderer gaps: ${fmt(lFm)}   main blocked worst: ${ms(lMain.max)}`);
    console.log(`    disk writes: ${storeWrites - beforeW2}`);
    check('dragging a slider keeps the studio responsive', lFm.p95 < 50, fmt(lFm));
    check('and dragging a slider never stalls it visibly', lFm.max < 250 && lFm.over250 === 0, `worst ${ms(lFm.max)}`);
    check('dragging a slider does not write the library per tick', (storeWrites - beforeW2) <= 3,
      `${storeWrites - beforeW2} writes for 26 ticks`);
  }

  /* ---------------- [5] does it get worse the longer it runs? ---------------- */
  head('[5] Long run — a service is two hours, not two minutes');
  const drift = await js(`
    const T = window.Presenter.__test;
    const sample = () => { const t = performance.now(); T.selectSlide(4); return performance.now() - t; };
    const early = [];
    for (let i = 0; i < 5; i++) { early.push(sample()); await new Promise(r => setTimeout(r, 20)); }
    const nodes0 = document.getElementsByTagName('*').length;
    for (let i = 0; i < 150; i++) { T.step(1); if (i % 10 === 0) await new Promise(r => setTimeout(r, 5)); }
    const late = [];
    for (let i = 0; i < 5; i++) { late.push(sample()); await new Promise(r => setTimeout(r, 20)); }
    const nodes1 = document.getElementsByTagName('*').length;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return { early: avg(early), late: avg(late), nodes0, nodes1 };`);
  if (bad(drift)) check('long-run drift measured', false, drift.__error);
  else {
    console.log(`    render before 150 cues: ${ms(drift.early)}   after: ${ms(drift.late)}`);
    console.log(`    DOM nodes before: ${drift.nodes0}   after: ${drift.nodes1}`);
    check('the studio does not get slower the longer the service runs',
      drift.late < Math.max(drift.early * 1.8, drift.early + 20), `${ms(drift.early)} -> ${ms(drift.late)}`);
    check('the DOM does not grow without bound (no leaked slide nodes)',
      drift.nodes1 < drift.nodes0 * 1.25 + 200, `${drift.nodes0} -> ${drift.nodes1}`);
  }

  /* ---------------- [6] the Bible panel, which runs in MAIN ----------------
   *
   * Everything above freezes one window. This freezes all of them: looking up a
   * verse and searching for a phrase happen in the main process, which the
   * studio, the projector and the stage monitor all share. A whole translation
   * is about 31,000 verses, and the first lookup parses the entire file.
   *
   * The translation here is built rather than downloaded — real size, real
   * shape, no network, and the same every run. */
  head('[6] Looking up scripture — this work happens in the main process');
  const bible = require(path.join(ROOT, 'src/main/bible'));
  bible.init(WORK);
  const BOOKS31 = bible.BOOKS || [];
  const words = ('the LORD is my shepherd I shall not want he maketh me to lie down in green pastures '
    + 'and leadeth beside still waters restoreth soul for his name sake though walk through valley of '
    + 'shadow death will fear no evil art with rod staff they comfort').split(/\s+/);
  const verseText = (n) => {
    let s = [];
    for (let i = 0; i < 22; i++) s.push(words[(n * 7 + i * 3) % words.length]);
    return s.join(' ') + '.';
  };
  let vCount = 0;
  const bigBooks = (BOOKS31.length ? BOOKS31 : Array.from({ length: 66 }, (_, i) => ({ nr: i + 1, name: 'Book ' + (i + 1), chapters: 20 })))
    .map((b) => {
      const nCh = Math.max(1, b.chapters || 20);
      return {
        nr: b.nr, name: b.name,
        chapters: Array.from({ length: nCh }, (_, ci) => ({
          chapter: ci + 1,
          verses: Array.from({ length: 25 }, (_, vi) => { vCount++; return { verse: vi + 1, text: verseText(vCount) }; }),
        })),
      };
    });
  const bigPath = path.join(WORK, 'bibles', 'perf.json');
  fs.mkdirSync(path.dirname(bigPath), { recursive: true });
  fs.writeFileSync(bigPath, JSON.stringify({ translation: 'Perf Test Edition', abbreviation: 'perf', books: bigBooks }), 'utf-8');
  const mb = fs.statSync(bigPath).size / 1048576;
  console.log(`    built a whole Bible: ${vCount.toLocaleString()} verses, ${mb.toFixed(1)} MB on disk`);

  const lookup = async (ref) => { try { return await bible.lookup({ translation: 'perf', ref }); } catch (e) { return { error: e.message }; } };

  mainMeterStart();
  const tLoad = Date.now();
  const first = await lookup('John 3:15-17');
  const loadMs = Date.now() - tLoad;
  const mLoad = mainMeterStop();
  console.log(`    first lookup (parses the whole file): ${ms(loadMs)}   main blocked ${ms(mLoad.max)}`);
  check('the first verse lookup does not lock every window for a quarter second',
    loadMs < 250, ms(loadMs) + (first && first.verses ? ` — ${first.verses.length} verses back` : ` — ${first && first.error}`));

  mainMeterStart();
  const tWarm = Date.now();
  const warm = await lookup('Psalms 19:1');
  const warmMs = Date.now() - tWarm;
  mainMeterStop();

  /* The query deliberately matches NOTHING. A search that finds plenty stops
   * early once it has four times the limit; the slowest search an operator can
   * ask for is the one that has to look at every verse and come back with none,
   * which is exactly what a typo produces. */
  mainMeterStart();
  const tSearch = Date.now();
  const hits = bible.search({ translation: 'perf', query: 'zzqx nothing matches this', limit: 60 });
  const searchMs = Date.now() - tSearch;
  const mSearch = mainMeterStop();
  console.log(`    a warm lookup: ${ms(warmMs)}    a full scan of all ${vCount.toLocaleString()} verses: ${ms(searchMs)} (${(hits || []).length} hits)`);
  check('a warm verse lookup is instant', warmMs < 50, ms(warmMs) + (warm && warm.error ? ' — ' + warm.error : ''));
  check('searching the whole Bible does not freeze the app past "instant"',
    searchMs < 100, ms(searchMs) + `, main blocked ${ms(mSearch.max)}`);

  /* ---------------- [7] still alive? ---------------- */
  head('[7] The window is still answering');
  const alive = await Promise.race([
    js(`return { ok: true, slides: document.querySelectorAll('#pvSlides .pv-slide').length };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('the studio still answers after everything above',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung' : 'responsive');

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  try { presenter.shutdown(); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
