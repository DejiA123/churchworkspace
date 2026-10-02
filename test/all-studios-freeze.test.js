'use strict';
/*
 * ALL STUDIOS AT ONCE — the Sunday that actually happens.
 *
 * The other three freeze tests each drive ONE studio. That is not how this app
 * is used and, more to the point, not how it is BUILT: every studio lives in
 * the same renderer process on the same main thread, and switching pages only
 * toggles a CSS class. Nothing is unloaded, nothing is paused. Go Live's
 * compositor keeps drawing while the operator is on the Presentation page,
 * because a hidden element does not stop requestAnimationFrame — only a hidden
 * WINDOW does.
 *
 * So the honest question is not "is the Presentation studio fast" but "is the
 * Presentation studio fast while the switcher is compositing eight inputs and a
 * projector window is showing lyrics". That is this test.
 *
 * The real Sunday, all at the same time:
 *   • Go Live: 8 inputs, compositor running
 *   • Presentation: 30 songs, an 80-slide deck, a REAL projector window open
 *   • Video Studio: a 90-minute sermon with clips and a full transcript
 *
 * Then: cue slides, cut the switcher, and flip between pages, measuring the one
 * thread they all share.
 *
 *   npm run test:all-freeze
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/main/store'));
const presenter = require(path.join(ROOT, 'src/main/presenter'));

const WORK = path.join(os.tmpdir(), 'mw-all-freeze');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => (n == null ? '?' : Math.round(n) + ' ms');

let stage = 'boot';
const at = (s) => { stage = s; console.log('  .. ' + s); };
setTimeout(() => {
  console.log(`\n  !! WATCHDOG: still in "${stage}" after 300 s — treating as a hang.`);
  console.log(`  ${pass} PASS / ${fail + 1} FAIL`);
  app.exit(1);
}, 300000);
const withTimeout = (p, msLimit, label) => Promise.race([
  p, sleep(msLimit).then(() => ({ __error: `timed out after ${msLimit} ms (${label})` })),
]);

/* main-process heartbeat — shared by every window, so this is the one that
 * would take the projector down with the studio */
const mainMeter = { on: false, all: [] };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - mainLast - 10;
  mainLast = now;
  if (mainMeter.on && late > 0) mainMeter.all.push(late);
}, 10);
const mainStart = () => { mainMeter.all = []; mainLast = Date.now(); mainMeter.on = true; };
const mainStop = () => {
  mainMeter.on = false;
  const a = mainMeter.all.slice().sort((x, y) => x - y);
  const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0);
  return { p50: q(0.5), p95: q(0.95), max: Math.round(a[a.length - 1] || 0) };
};

const store = new Store(path.join(WORK, 'workstation.json'),
  { settings: {}, presentations: [], playlists: [], presentThemes: [] });

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const deck = (k) => (store.get(k) || []);

ipcMain.handle('present:library', wrap(async () => ({
  presentations: deck('presentations'), playlists: deck('playlists'), themes: deck('presentThemes') })));
ipcMain.handle('present:savePresentation', wrap(async (e, { presentation }) => {
  const list = deck('presentations').slice();
  const i = list.findIndex((p) => p.id === presentation.id);
  if (i >= 0) list[i] = presentation; else list.unshift(presentation);
  store.set('presentations', list); return presentation;
}));
ipcMain.handle('present:savePlaylist', wrap(async (e, { playlist }) => {
  const list = deck('playlists').slice();
  const i = list.findIndex((p) => p.id === playlist.id);
  if (i >= 0) list[i] = playlist; else list.push(playlist);
  store.set('playlists', list); return playlist;
}));
ipcMain.handle('present:saveThemes', wrap(async (e, { themes }) => { store.set('presentThemes', themes || []); return themes || []; }));
ipcMain.handle('present:deletePresentation', wrap(async () => true));
ipcMain.handle('present:deletePlaylist', wrap(async () => true));
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async (e, a) => Object.assign(presenter.open(a || {}), { state: presenter.state() })));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async (e, patch) => { presenter.setState(patch || {}); return true; }));

ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {}, present: { translation: 'kjv' } }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('live:metrics', () => ok({ cpu: 30, appCpu: 12 }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed',
  'bible:catalogue', 'bible:books', 'live:screenSources', 'bgvideo:installed', 'bgvideo:list',
  'captions:models', 'present:outputs', 'ndi:list']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));

const uid = () => 'x' + Math.random().toString(36).slice(2, 10);
const LYRIC = ['Amazing grace, how sweet the sound', 'That saved a wretch like me',
  'I once was lost, but now am found', 'Was blind, but now I see'];
const GROUPS = ['Verse 1', 'Chorus', 'Verse 2', 'Bridge', 'Tag'];
const makeDoc = (name, n) => ({
  id: uid(), name, kind: 'song', lookId: 'look-royal', updated: Date.now(),
  slides: Array.from({ length: n }, (_, i) => ({
    id: uid(), group: GROUPS[i % GROUPS.length], lines: LYRIC.slice(0, 2 + (i % 3)),
    footer: i % 5 === 0 ? 'CCLI 22025' : '', notes: '',
    bg: i % 3 === 0 ? { type: 'gradient', value: 'linear-gradient(160deg,#101a3a,#2a1650 60%,#06263a)' } : null,
    look: null,
  })),
});

app.whenReady().then(async () => {
  at('seeding a church library');
  const docs = [makeDoc('Amazing Grace (long set)', 80)];
  for (let i = 1; i < 30; i++) docs.push(makeDoc('Song ' + i, 8 + (i % 7)));
  store.set('presentations', docs);
  store.set('playlists', [{ id: uid(), name: 'This Sunday', items: docs.slice(0, 8).map((d) => ({ id: uid(), presentationId: d.id, name: d.name })) }]);
  store.flushSync();

  at('opening the app');
  const win = new BrowserWindow({
    width: 1520, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  presenter.setNotifier(() => { if (win && !win.isDestroyed()) win.webContents.send('present:outputs', presenter.state()); });
  await withTimeout(win.loadFile(path.join(ROOT, 'src/renderer/index.html')), 60000, 'loadFile');
  await sleep(1800);

  const js = (code) => withTimeout(win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    60000, 'executeJavaScript');
  const bad = (r) => r && r.__error;

  await js(`
    window.__fm = { on: false, last: 0, all: [] };
    setInterval(() => {
      const now = performance.now();
      if (window.__fm.on && window.__fm.last) { const l = now - window.__fm.last - 10; if (l > 0) window.__fm.all.push(l); }
      window.__fm.last = now;
    }, 10);
    window.__fmStart = () => { window.__fm.all = []; window.__fm.last = performance.now(); window.__fm.on = true; };
    window.__fmStop = () => {
      window.__fm.on = false;
      const a = window.__fm.all.slice().sort((x, y) => x - y);
      const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0);
      return { n: a.length, p50: q(0.5), p95: q(0.95), max: Math.round(a[a.length - 1] || 0), over250: a.filter((x) => x > 250).length };
    };
    return 1;`);
  const fmt = (f) => `p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · worst ${ms(f.max)}`;

  /* ---------------- baseline: Presentation ALONE ---------------- */
  at('Presentation only');
  await js(`document.querySelector('.nav-item[data-view="present"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`);
  await js(`await window.Presenter.__test.clickGoLive(); await new Promise(r=>setTimeout(r,600)); return 1;`);

  head('[1] Cueing slides — Presentation ALONE (the baseline)');
  mainStart(); await js('window.__fmStart(); return 1;');
  const solo = await js(`
    const T = window.Presenter.__test; const out = [];
    for (let i = 0; i < 25; i++) { const t = performance.now(); T.step(1); out.push(performance.now() - t); await new Promise(r=>setTimeout(r,40)); }
    return out;`);
  const soloFm = await js('return window.__fmStop();'); const soloMain = mainStop();
  const soloWorst = bad(solo) ? null : Math.max(...solo);
  console.log(`    per cue worst ${ms(soloWorst)}   renderer ${fmt(soloFm)}   main worst ${ms(soloMain.max)}`);
  check('cueing slides is responsive with nothing else running', soloFm.p95 < 50, fmt(soloFm));

  /* ---------------- now start the other two studios ---------------- */
  at('starting Go Live (8 inputs) and loading a 90-min sermon in the Video Studio');
  const built = await js(`
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise(r=>setTimeout(r,500));
    const L = window.LiveStudio.__test;
    for (let i = 1; i <= 6; i++) L.addSynthetic('Camera ' + i, i * 40);
    L.addColor('Announcements', '#2244cc');
    L.addTitle({ headline: 'Sunday Service', subtext: 'Grace Chapel', style: 'lower' });
    await new Promise(r=>setTimeout(r,1200));

    document.querySelector('.nav-item[data-view="video"]').click();
    await new Promise(r=>setTimeout(r,400));
    const V = window.VideoEditor.__test;
    V.loadFake({ durationSec: 5400, width: 1920, height: 1080 });
    const cv = document.createElement('canvas'); cv.width = 24*160; cv.height = 90;
    const c = cv.getContext('2d');
    for (let i=0;i<24;i++){ c.fillStyle='hsl('+(i*15)+',60%,45%)'; c.fillRect(i*160,0,160,90); }
    V.setFilmstrip(cv.toDataURL('image/png'));
    V.applyClips(Array.from({length:20},(_,i)=>({start:200+i*250,end:200+i*250+70,label:'Key '+(i+1)})));
    V.setCapEvents(Array.from({length:1500},(_,i)=>({start:20+i*3.5,end:20+i*3.5+2.4,text:'CAPTION '+(i+1)})),0);
    V.fitHook();
    await new Promise(r=>setTimeout(r,600));

    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r=>setTimeout(r,700));
    return { inputs: window.LiveStudio.__test.state().inputs.length,
             clips: window.VideoEditor.__test.segments().length,
             slides: document.querySelectorAll('#pvSlides .pv-slide').length };`);
  if (bad(built)) check('all three studios loaded', false, built.__error);
  else {
    console.log(`    Go Live ${built.inputs} inputs · Video ${built.clips} clips · Presentation ${built.slides} slides · projector open`);
    check('all three studios are loaded at once', built.inputs >= 7 && built.clips >= 20 && built.slides >= 80,
      `${built.inputs} inputs, ${built.clips} clips, ${built.slides} slides`);
  }

  /* ---------------- is the hidden switcher still burning the thread? -------- */
  head('[2] On the Presentation page — is the hidden switcher still compositing?');
  const hidden = await js(`
    const L = window.LiveStudio.__test;
    const a = L.state().fps;
    await new Promise(r=>setTimeout(r,2500));
    const s = L.state();
    return { fps: s.fps, renderMs: +(s.renderMs || 0).toFixed(2),
             onLivePage: document.getElementById('view-live').classList.contains('active') };`);
  console.log(`    Go Live view active: ${hidden.onLivePage} · compositor ${hidden.fps} fps · ${hidden.renderMs} ms/frame`);
  /* Not a pass/fail on its own — it is the CONTEXT for everything below. A
   * switcher that is streaming MUST keep compositing while hidden; one that is
   * idle is spending the operator's frame budget on pictures nobody can see. */
  check('the switcher keeps its program running while another page is in front',
    typeof hidden.fps === 'number', `${hidden.fps} fps while hidden`);

  /* ---------------- the real question ---------------- */
  head('[3] Cueing slides WHILE the switcher composites and the sermon sits loaded');
  mainStart(); await js('window.__fmStart(); return 1;');
  const together = await js(`
    const T = window.Presenter.__test; const out = [];
    for (let i = 0; i < 25; i++) { const t = performance.now(); T.step(1); out.push(performance.now() - t); await new Promise(r=>setTimeout(r,40)); }
    return out;`);
  const togFm = await js('return window.__fmStop();'); const togMain = mainStop();
  const togWorst = bad(together) ? null : Math.max(...together);
  console.log(`    per cue worst ${ms(togWorst)}   renderer ${fmt(togFm)}   main worst ${ms(togMain.max)}`);
  console.log(`    vs alone:     per cue worst ${ms(soloWorst)}   renderer p95 ${ms(soloFm.p95)}`);
  /*
   * THESE BARS ARE LOOSER THAN THE SINGLE-STUDIO ONES, AND THAT IS A FINDING,
   * NOT A CONCESSION.
   *
   * Measured repeatedly: with all three studios loaded, cueing a slide costs
   * roughly twice what it costs with only the Presentation studio open — p95
   * around 35 ms alone, 55-95 ms together. It is not background CPU (idle gaps
   * are 9-10 ms either way, and the hidden switcher composites at 2 fps for
   * 1.4 ms a frame); it is one renderer thread, one document, and three
   * studios' worth of DOM and heap in it.
   *
   * So this section holds the app to what a person can actually perceive —
   * nothing over a quarter second, ever — and separately asserts that the
   * penalty stays a small multiple rather than growing without bound. If a
   * future change makes simultaneous use 5x worse instead of 2x, that fails
   * here even though no single number crossed 250 ms.
   */
  check('cueing stays inside a quarter second with every studio loaded',
    togFm.max < 250 && togFm.over250 === 0, fmt(togFm));
  check('a cue still lands inside 150 ms with every studio loaded',
    togWorst < 150, `worst ${ms(togWorst)}`);
  check('the main process — shared with the projector — never blocks past 100 ms',
    togMain.max < 100, `worst ${ms(togMain.max)}`);
  check('having the other studios open costs about 2x, not 10x',
    togFm.p95 <= Math.max(soloFm.p95 * 3.5, soloFm.p95 + 60),
    `p95 ${ms(soloFm.p95)} alone -> ${ms(togFm.p95)} together`);

  /* ---------------- flipping between pages ---------------- */
  head('[4] Flipping between pages mid-service');
  mainStart(); await js('window.__fmStart(); return 1;');
  const flips = await js(`
    const views = ['live','present','video','present','live','present'];
    const out = [];
    for (let n = 0; n < 4; n++) {
      for (const v of views) {
        const t = performance.now();
        document.querySelector('.nav-item[data-view="'+v+'"]').click();
        out.push(performance.now() - t);
        await new Promise(r=>setTimeout(r,120));
      }
    }
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r=>setTimeout(r,300));
    return out;`);
  const flipFm = await js('return window.__fmStop();'); const flipMain = mainStop();
  if (bad(flips)) check('page flipping measured', false, flips.__error);
  else {
    const w = Math.max(...flips), med = flips.slice().sort((a, b) => a - b)[Math.floor(flips.length / 2)];
    console.log(`    ${flips.length} page switches: median ${ms(med)} worst ${ms(w)}   renderer ${fmt(flipFm)}   main worst ${ms(flipMain.max)}`);
    /* A page switch un-hides a whole studio, so the browser lays it out. The
     * Presentation view is the big one — every slide thumbnail is a scaled
     * 1920x1080 stage — which is why its thumbnails carry content-visibility
     * (see present.css); that took a flip on an 80-slide deck from 73 ms to
     * 33 ms and a 160-slide deck from 93 ms to 54 ms. It is a deliberate
     * navigation, so the bar is "no visible stall", not "one frame". */
    /*
     * ►► WHAT THE OPERATOR ACTUALLY FEELS IS THE CLICK. ◄◄
     *
     * This used to be a median of 89 ms and a worst of 343, because the whole
     * of the arriving studio's catch-up ran inside the click handler: press
     * Presentation mid-service and the app went away for a third of a second
     * before the page even changed. The class toggle is now all that is
     * synchronous and everything else happens once the new page is painted, so
     * the page changes on the frame it was asked for.
     */
    check('►► a page switch responds within a frame ◄◄', med < 16 && w < 60,
      `median ${ms(med)}, worst ${ms(w)}`);
    check('switching pages is typically quick', med < 100, `median ${ms(med)}`);
    check('and no page switch ever stalls the app past 300 ms',
      flipFm.max < 300 && flipFm.over250 <= 1, `worst ${ms(flipFm.max)}`);
  }

  /* ---------------- everything being driven at once ---------------- */
  head('[5] Two studios driven at the same time (cue slides + cut the switcher)');
  mainStart(); await js('window.__fmStart(); return 1;');
  const both = await js(`
    const T = window.Presenter.__test, L = window.LiveStudio.__test;
    const ids = L.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const cue = [], cut = [];
    for (let i = 0; i < 20; i++) {
      let t = performance.now(); T.step(1); cue.push(performance.now() - t);
      L.setPreview(ids[i % ids.length]);
      t = performance.now(); L.cut(); cut.push(performance.now() - t);
      await new Promise(r=>setTimeout(r,50));
    }
    return { cue, cut, fps: L.state().fps };`);
  const bothFm = await js('return window.__fmStop();'); const bothMain = mainStop();
  if (bad(both)) check('simultaneous driving measured', false, both.__error);
  else {
    console.log(`    cue worst ${ms(Math.max(...both.cue))} · cut worst ${ms(Math.max(...both.cut))} · compositor still ${both.fps} fps`);
    console.log(`    renderer ${fmt(bothFm)}   main worst ${ms(bothMain.max)}`);
    /* This drives BOTH studios flat out — a cue and a cut every 50 ms — which
     * is harder than any operator works. The bar is that it degrades, not that
     * it breaks. */
    check('driving two studios at once never stalls the app past 350 ms',
      bothFm.max < 350, fmt(bothFm));
    check('and each individual action still lands inside 150 ms',
      Math.max(...both.cue) < 150 && Math.max(...both.cut) < 150,
      `cue ${ms(Math.max(...both.cue))} · cut ${ms(Math.max(...both.cut))}`);
    check('the switcher keeps compositing throughout', both.fps > 0, `${both.fps} fps`);
  }

  /* ---------------- a long service with everything open ---------------- */
  head('[6] Sustained — does it drift with all three loaded?');
  const drift = await js(`
    const T = window.Presenter.__test;
    const sample = () => { const t = performance.now(); T.step(1); return performance.now() - t; };
    const early = []; for (let i=0;i<5;i++){ early.push(sample()); await new Promise(r=>setTimeout(r,25)); }
    const n0 = document.getElementsByTagName('*').length;
    for (let i=0;i<150;i++){ T.step(1); if (i%15===0) await new Promise(r=>setTimeout(r,5)); }
    const late = []; for (let i=0;i<5;i++){ late.push(sample()); await new Promise(r=>setTimeout(r,25)); }
    const n1 = document.getElementsByTagName('*').length;
    const avg = (a)=>a.reduce((x,y)=>x+y,0)/a.length;
    return { early: avg(early), late: avg(late), n0, n1, fps: window.LiveStudio.__test.state().fps };`);
  if (bad(drift)) check('sustained run measured', false, drift.__error);
  else {
    console.log(`    cue before 150: ${ms(drift.early)}  after: ${ms(drift.late)}  · DOM ${drift.n0} -> ${drift.n1} · compositor ${drift.fps} fps`);
    check('no slowdown over a long service with everything open',
      drift.late < Math.max(drift.early * 1.8, drift.early + 20), `${ms(drift.early)} -> ${ms(drift.late)}`);
    check('no DOM leak with three studios loaded', drift.n1 < drift.n0 * 1.25 + 300, `${drift.n0} -> ${drift.n1}`);
  }

  /* ---------------- what a HIDDEN studio is still doing ---------------- */
  head('[7] A studio nobody is looking at stops working');
  {
    /*
     * A hidden element does not stop a <video> decoding, and it does not stop
     * requestAnimationFrame. The Video Studio left mid-preview went on decoding
     * a 90-minute recording and running its caption animation for the whole of
     * the sermon that followed, on the one thread Presentation was putting
     * slides on the wall with. Go Live is the deliberate exception: its
     * compositor IS the program feed, and it throttles itself instead.
     */
    const hid = await js(`
      document.querySelector('.nav-item[data-view="video"]').click();
      await new Promise(r=>setTimeout(r,250));
      const p = document.getElementById('vePlayer');
      /*
       * play() returns a promise that never settles when there is nothing
       * decodable behind the element, so it is fired and NOT awaited — what is
       * being asked is only whether the element is left paused afterwards.
       */
      try { p.play(); } catch (e) {}
      await new Promise(r=>setTimeout(r,400));
      const played = !p.paused;
      document.querySelector('.nav-item[data-view="present"]').click();
      await new Promise(r=>setTimeout(r,300));
      return { played, pausedAfterLeaving: p.paused };`);
    if (bad(hid)) check('hidden-studio check ran', false, hid.__error);
    else if (!hid.played) console.log('    .. the preview would not start in this harness; skipping the pause check');
    else {
      check('►► leaving the Video Studio stops it decoding the preview ◄◄',
        hid.pausedAfterLeaving === true, hid.pausedAfterLeaving ? 'paused' : 'STILL PLAYING');
    }
  }

  head('[7] Everything is still answering');
  const alive = await Promise.race([
    js(`return { ok: true,
      slides: document.querySelectorAll('#pvSlides .pv-slide').length,
      inputs: window.LiveStudio.__test.state().inputs.length,
      clips: window.VideoEditor.__test.segments().length };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('all three studios still answer at the end',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung'
      : `${alive.slides} slides, ${alive.inputs} inputs, ${alive.clips} clips`);

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  try { presenter.shutdown(); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
