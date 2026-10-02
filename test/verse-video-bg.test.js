'use strict';
/*
 * SCRIPTURE OVER A MOVING BACKGROUND — the most-used thing this studio does.
 *
 * "If I pick a Bible verse and a moving background, will it freeze?"
 *
 * That combination goes down a path none of the other freeze tests walk. They
 * used gradient backgrounds and slides from the Library; this uses the Bible
 * panel's verse cue and a REAL video file behind it, which is different in two
 * ways that matter:
 *
 *   1. a <video> is decoding continuously behind the words, in the studio's Live
 *      and Next monitors AND in the projector window — three decoders of the
 *      same file on one machine;
 *   2. advancing to the next verse changes the SLIDE but not the BACKGROUND,
 *      and the studio's monitors paint the whole composite in one go. If that
 *      repaint rebuilds the background too, every verse destroys and re-creates
 *      the <video> element — which costs a decode restart and makes the motion
 *      visibly jump back to the beginning.
 *
 * So this measures the freeze AND checks the video is left alone: same element,
 * still playing, and its clock still moving forward across a verse change.
 *
 *   npm run test:verse-video
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/main/store'));
const presenter = require(path.join(ROOT, 'src/main/presenter'));
const ff = require(path.join(ROOT, 'src/main/ffmpeg'));

const WORK = path.join(os.tmpdir(), 'mw-verse-video');
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
  console.log(`\n  !! WATCHDOG: still in "${stage}" after 240 s — treating as a hang.`);
  console.log(`  ${pass} PASS / ${fail + 1} FAIL`);
  app.exit(1);
}, 240000);

const mainMeter = { on: false, all: [] };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now(); const late = now - mainLast - 10; mainLast = now;
  if (mainMeter.on && late > 0) mainMeter.all.push(late);
}, 10);
const mainStart = () => { mainMeter.all = []; mainLast = Date.now(); mainMeter.on = true; };
const mainStop = () => {
  mainMeter.on = false;
  const a = mainMeter.all.slice().sort((x, y) => x - y);
  return { max: Math.round(a[a.length - 1] || 0) };
};

const store = new Store(path.join(WORK, 'workstation.json'),
  { settings: {}, presentations: [], playlists: [], presentThemes: [] });
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const deck = (k) => (store.get(k) || []);
ipcMain.handle('present:library', wrap(async () => ({ presentations: deck('presentations'), playlists: deck('playlists'), themes: deck('presentThemes') })));
ipcMain.handle('present:savePresentation', wrap(async (e, { presentation }) => {
  const l = deck('presentations').slice(); const i = l.findIndex((p) => p.id === presentation.id);
  if (i >= 0) l[i] = presentation; else l.unshift(presentation);
  store.set('presentations', l); return presentation;
}));
ipcMain.handle('present:savePlaylist', wrap(async (e, { playlist }) => playlist));
ipcMain.handle('present:saveThemes', wrap(async (e, { themes }) => themes || []));
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
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('live:metrics', () => ok({ cpu: 20, appCpu: 8 }));
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
for (const ch of ['webout:state', 'ndiout:state', 'ndi:status', 'dmx:state', 'phone:state'])
  ipcMain.handle(ch, () => ok({ running: false, available: false, feeds: [] }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));

const uid = () => 'x' + Math.random().toString(36).slice(2, 10);
const makeDoc = (name, n) => ({
  id: uid(), name, kind: 'song', updated: Date.now(),
  slides: Array.from({ length: n }, () => ({ id: uid(), group: 'Verse 1',
    lines: ['Amazing grace, how sweet the sound', 'That saved a wretch like me'],
    footer: '', notes: '', bg: null, look: null })),
});

/* A real looping motion background, built here rather than downloaded: 12 s of
 * moving 1080p H.264, which is what the built-in collection ships. */
async function makeLoop(file) {
  const ffmpeg = ff.resolveFfmpeg();
  await new Promise((res, rej) => execFile(ffmpeg, ['-y', '-f', 'lavfi',
    '-i', 'testsrc2=size=1920x1080:rate=30:duration=12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file],
    { maxBuffer: 8e6 }, (e) => e ? rej(e) : res()));
  return file;
}

app.whenReady().then(async () => {
  at('building a real 1080p motion background');
  const loop = path.join(WORK, 'motion.mp4');
  try { await makeLoop(loop); } catch (e) { console.log('  SKIP — could not build a test loop: ' + e.message); app.exit(0); return; }
  console.log(`  background: ${(fs.statSync(loop).size / 1e6).toFixed(1)} MB of 1920x1080 30fps H.264`);

  store.set('presentations', [makeDoc('Opening song', 20)]);
  store.flushSync();

  at('opening the studio');
  const win = new BrowserWindow({ width: 1520, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  presenter.setNotifier(() => { if (win && !win.isDestroyed()) win.webContents.send('present:outputs', presenter.state()); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1800);

  const js = (code) => Promise.race([
    win.webContents.executeJavaScript(`(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    sleep(60000).then(() => ({ __error: 'executeJavaScript timed out' })),
  ]);
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

  at('opening the Presentation studio and the projector');
  await js(`document.querySelector('.nav-item[data-view="present"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`);

  /*
   * OPENING THE PROJECTOR IS MEASURED ON ITS OWN, because it is a different
   * kind of cost from everything below it.
   *
   * Pressing Go Live creates a real BrowserWindow and loads a page into it, and
   * that is main-process work — measured here at up to about a second. It
   * happens once, at the moment the operator is deliberately opening the
   * screen. Lumping it in with the verse-advancing below made the steady state
   * look like it had a one-second freeze in it, which it does not: isolated,
   * the same measurement afterwards is an order of magnitude smaller.
   */
  head('[0] Opening the projector (a one-off — it creates a real window)');
  mainStart();
  await js(`await window.Presenter.__test.clickGoLive(); await new Promise(r=>setTimeout(r,600)); return 1;`);
  const openMain = mainStop();
  console.log(`    main blocked while the projector window opened: worst ${ms(openMain.max)}`);
  check('opening the projector does not wedge the app for multiple seconds',
    openMain.max < 2500, `worst ${ms(openMain.max)}`);
  await sleep(1500);        // let the new window settle before measuring anything else

  /* ---------- put the moving background up and a passage over it ---------- */
  at('applying the moving background and cueing a passage');
  const setup = await js(`
    const T = window.Presenter.__test;
    const url = ${JSON.stringify('file:///' + loop.replace(/\\/g, '/'))};
    T.setBackgroundLayer({ type: 'video', value: url, fit: 'cover' });
    await new Promise(r=>setTimeout(r,400));
    // a real passage cue, then a background chosen FOR the verses
    T.fakeVerseCue();
    await new Promise(r=>setTimeout(r,1500));
    const vids = [...document.querySelectorAll('#pvLiveScreen video, #pvNextScreen video')];
    return {
      cue: T.verseCue(),
      liveVideos: document.querySelectorAll('#pvLiveScreen video').length,
      anyVideos: vids.length,
      playing: vids.map(v => ({ paused: v.paused, t: +(v.currentTime||0).toFixed(2), ready: v.readyState })),
      liveText: T.liveScreenText && T.liveScreenText(),
    };`);
  if (bad(setup)) { check('scripture over a moving background set up', false, setup.__error); }
  else {
    console.log(`    live monitor videos: ${setup.liveVideos} · all monitors: ${setup.anyVideos}`);
    console.log(`    verse: ${JSON.stringify(setup.cue && setup.cue.lines)} · video state: ${JSON.stringify(setup.playing)}`);
    check('a verse is live over a real moving background',
      !!(setup.cue && setup.anyVideos > 0), `${setup.anyVideos} video elements, cue ${setup.cue && setup.cue.reference}`);
  }

  /* ---------- THE QUESTION: advancing verses over that background ----------
   * Steady state only: the projector is already open and the first frame of the
   * loop is already decoded, which is the condition an operator is actually in
   * while reading a passage. */
  head('[1] Advancing through the passage while the background plays');
  await sleep(1200);
  mainStart(); await js('window.__fmStart(); return 1;');
  const adv = await js(`
    const T = window.Presenter.__test;
    const vidOf = () => document.querySelector('#pvLiveScreen video');
    const first = vidOf();
    const out = [], sameEl = [], clock = [];
    /*
     * Backwards and forwards WITHIN the passage, using the real arrow-key path.
     * Stepping off the end of a passage moves into the Library's slides, which
     * carry their own background — so the video is rebuilt there and SHOULD be.
     * That is a different question from the one being asked here, which is
     * whether moving between verses disturbs the loop behind them.
     */
    for (let i = 0; i < 20; i++) {
      const before = vidOf();
      const tBefore = before ? before.currentTime : -1;
      const t0 = performance.now();
      T.step(i % 2 === 0 ? 1 : -1);
      out.push(performance.now() - t0);
      await new Promise(r=>setTimeout(r,220));
      const after = vidOf();
      sameEl.push(after === before);
      clock.push(after ? +(after.currentTime - tBefore).toFixed(3) : null);
    }
    const v = vidOf();
    return { times: out, sameEl, clock,
             stillSameAsFirst: v === first,
             paused: v ? v.paused : null,
             finalT: v ? +(v.currentTime||0).toFixed(2) : null,
             videoCount: document.querySelectorAll('#pvLiveScreen video').length };`);
  const advFm = await js('return window.__fmStop();'); const advMain = mainStop();
  if (bad(adv)) check('advancing verses measured', false, adv.__error);
  else {
    const worst = Math.max(...adv.times);
    const kept = adv.sameEl.filter(Boolean).length;
    const wentBackwards = adv.clock.filter((c) => c != null && c < -0.05).length;
    console.log(`    per verse: worst ${ms(worst)}   renderer ${fmt(advFm)}   main worst ${ms(advMain.max)}`);
    console.log(`    background <video>: kept across ${kept}/${adv.sameEl.length} verse changes · clock went backwards ${wentBackwards}x · paused=${adv.paused} · at ${adv.finalT}s`);
    check('advancing a verse over a moving background lands inside 100 ms',
      worst < 100, `worst ${ms(worst)}`);
    check('and never freezes the studio past a quarter second',
      advFm.max < 250 && advFm.over250 === 0, fmt(advFm));
    check('the main process never blocks past 100 ms', advMain.max < 100, `worst ${ms(advMain.max)}`);
    /*
     * The one that says the motion is actually usable: if the <video> is
     * rebuilt per verse, the loop restarts from zero every time you advance —
     * which reads on the wall as the background stuttering back to the start.
     */
    check('the background video is NOT rebuilt on every verse',
      kept === adv.sameEl.length, `kept ${kept}/${adv.sameEl.length}`);
    check('and it keeps playing forwards throughout',
      adv.paused === false && wentBackwards === 0,
      `paused=${adv.paused}, ${wentBackwards} restarts, ended at ${adv.finalT}s`);
    check('exactly one background video element exists, not a pile of them',
      adv.videoCount === 1, `${adv.videoCount} <video> in the Live monitor`);
  }

  /* ---------- and with the whole passage running for a while ---------- */
  head('[2] Sitting on scripture for a while, as a reading actually does');
  await js('window.__fmStart(); return 1;'); mainStart();
  await sleep(6000);
  const idle = await js('return window.__fmStop();'); const idleMain = mainStop();
  const after = await js(`
    const v = document.querySelector('#pvLiveScreen video');
    return { paused: v ? v.paused : null, t: v ? +(v.currentTime||0).toFixed(2) : null,
             videos: document.querySelectorAll('video').length };`);
  console.log(`    renderer ${fmt(idle)}   main worst ${ms(idleMain.max)}   video at ${after.t}s (paused=${after.paused}), ${after.videos} <video> in the studio`);
  check('the studio stays responsive while scripture sits on a moving background',
    idle.p95 < 50 && idle.max < 250, fmt(idle));
  check('the loop is still running after six seconds', after.paused === false, `paused=${after.paused}, t=${after.t}s`);

  /* ---------- switching passages / backgrounds ---------- */
  head('[3] Changing the background while a verse is live');
  mainStart(); await js('window.__fmStart(); return 1;');
  const swap = await js(`
    const T = window.Presenter.__test;
    const url = ${JSON.stringify('file:///' + loop.replace(/\\/g, '/'))};
    const out = [];
    for (let i = 0; i < 6; i++) {
      let t0 = performance.now();
      T.setBackgroundLayer({ type: 'color', value: '#101a3a' });
      out.push(performance.now() - t0);
      await new Promise(r=>setTimeout(r,250));
      t0 = performance.now();
      T.setBackgroundLayer({ type: 'video', value: url, fit: 'cover' });
      out.push(performance.now() - t0);
      await new Promise(r=>setTimeout(r,250));
    }
    return { times: out, videos: document.querySelectorAll('video').length };`);
  const swapFm = await js('return window.__fmStop();'); const swapMain = mainStop();
  if (bad(swap)) check('background swapping measured', false, swap.__error);
  else {
    console.log(`    per swap worst ${ms(Math.max(...swap.times))}   renderer ${fmt(swapFm)}   main worst ${ms(swapMain.max)}`);
    console.log(`    <video> elements in the studio afterwards: ${swap.videos}`);
    check('swapping the background never freezes the studio past 250 ms',
      swapFm.max < 250 && swapFm.over250 === 0, fmt(swapFm));
    // 12 swaps must not leave 12 decoders behind
    check('swapping backgrounds does not leak video elements',
      swap.videos <= 4, `${swap.videos} <video> after 12 swaps`);
  }

  head('[4] Still answering');
  const alive = await Promise.race([
    js(`return { ok: true, cue: !!window.Presenter.__test.verseCue() };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('the studio still answers with scripture on a moving background',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung' : 'responsive');

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  try { presenter.shutdown(); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
