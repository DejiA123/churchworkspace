'use strict';
/*
 * Verifies the LIVE preview's on-screen render position (tickLiveRender in
 * veditor.js) actually GLIDES continuously toward the tracked target instead
 * of snapping — the bug behind "face tracking is glitchy": every ~220ms tick
 * used to hand a new target straight to a CSS transition, which restarts
 * (decelerating to a dead stop) before the previous one finishes, reading as
 * a repeating lurch/brake rather than one smooth pan.
 *
 * Drives the glide with EXACT, controlled dt values via the liveRenderTick(dt)
 * test hook rather than waiting on real requestAnimationFrame ticks: Chromium
 * throttles rAF to ~1fps for windows that are never actually shown (which is
 * what every Electron test harness in this repo uses, show:false), regardless
 * of the backgroundThrottling webPreference — confirmed by direct probe (a
 * fresh rAF loop opened in one of these hidden test windows got only 3 frames
 * in 3 real seconds). The real, visible app window has no such throttling —
 * this test exercises the exact same physics function the live rAF loop
 * calls every frame, just with deterministic timing instead of real one.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const video = require('../src/main/video');
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  await win.loadFile(indexPath);
  await new Promise((r) => setTimeout(r, 1200));

  const ready = await win.webContents.executeJavaScript('!!(window.VideoEditor && window.VideoEditor.__test && window.VideoEditor.__test.liveRenderTick)');
  check('render-loop test hooks loaded', ready === true);
  if (!ready) { app.exit(1); return; }

  const r = await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.liveRenderLoopStop(); // this test drives the glide frame-by-frame itself
    T.loadFake({ durationSec: 60, width: 1280, height: 720 });
    document.getElementById('veAutoReframe').checked = true;
    T.setAspect('reel-9x16');
    T.resetLiveTrack();
    T.liveTick(0.30, 0.5); T.liveTick(0.30, 0.5); // cold-start the track at 0.30

    // seed the render loop at a ~60fps cadence until it settles on the initial target
    for (let i = 0; i < 20; i++) T.liveRenderTick(1 / 60);
    const seeded = T.liveRenderState();

    // now move the target with 5 agreeing raw ticks (well past the smoothing
    // history + jump-confirm sequence — see applyLiveFaceSample) and sample the
    // RENDER position after each simulated ~1/60s frame as it chases it.
    for (let i = 0; i < 5; i++) T.liveTick(0.70, 0.5);
    const target = T.liveFaceState();

    const samples = [];
    for (let i = 0; i < 60; i++) { T.liveRenderTick(1 / 60); samples.push(T.liveRenderState().cx); }
    return { seeded, target, samples };
  })()`);

  console.log('  seeded render position: cx=' + r.seeded.cx);
  console.log('  target after 5 agreeing ticks: cx=' + r.target.cx.toFixed(3));
  console.log('  render samples (every simulated 1/60s frame, first 15 of 60): ' + r.samples.slice(0, 15).map((v) => v.toFixed(3)).join(', ') + ' ...');

  check('render position settles on the initial target before any move', r.seeded.cx != null && Math.abs(r.seeded.cx - 0.30) < 0.01, `cx=${r.seeded.cx}`);
  check('target lands on the new position (5 agreeing ticks confirm)', Math.abs(r.target.cx - 0.70) < 0.02, `target.cx=${r.target.cx.toFixed(3)}`);

  const samples = r.samples;
  check('render position did NOT snap straight to the target on the very first ~16ms frame (it glides)',
    Math.abs(samples[0] - 0.70) > 0.03, `first frame=${samples[0].toFixed(3)} (target 0.700)`);

  // monotonic-ish convergence: each sample should be about as close to the target as the
  // previous one. A little overshoot right at settling is normal/expected for a velocity-
  // eased glide (real camera operators do this too — it reads as natural, not robotic); this
  // guards against a REAL bug (oscillating back and forth, or overshooting by a lot).
  let worstRegression = 0;
  for (let i = 1; i < samples.length; i++) {
    worstRegression = Math.max(worstRegression, Math.abs(samples[i] - 0.70) - Math.abs(samples[i - 1] - 0.70));
  }
  check('render position converges toward the target without a large oscillation/overshoot', worstRegression < 0.01, `worst regression=${worstRegression.toFixed(4)}`);

  // bounded per-frame step: at 60fps with the 0.9/s speed cap, no single frame should move
  // by more than ~0.9/60 ≈ 0.015 (generous margin for the eased ramp-up) — proves this is a
  // continuous glide (many small steps), not the old behaviour of jumping in one shot.
  let maxStep = 0;
  const all = [0.30, ...samples];
  for (let i = 1; i < all.length; i++) maxStep = Math.max(maxStep, Math.abs(all[i] - all[i - 1]));
  check('no single ~16ms frame hops more than the speed cap allows (continuous glide, not a jump)', maxStep < 0.03, `max step=${maxStep.toFixed(4)}`);

  check('render position eventually converges close to the target within 1s (60 frames)', Math.abs(samples[samples.length - 1] - 0.70) < 0.01, `final=${samples[samples.length - 1].toFixed(3)}`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
