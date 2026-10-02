'use strict';
/*
 * IS A CAMERA SMOOTH ONCE IT IS INSIDE GO LIVE?
 *
 * "The video from a camera device to the Go Live page is not smooth, still
 * choppy" — reported repeatedly, on fast internet, and never reproduced by any
 * test in this project. This file exists because of WHY it was never
 * reproduced.
 *
 * Every synthetic source the other suites use (`addSynthetic`, `addStillSlide`,
 * `addAvPulse`) hands the compositor a CANVAS. A canvas always holds the newest
 * thing drawn on it: reading it can never be early and can never be late, so a
 * canvas source cannot judder no matter what the draw loop does. A real camera
 * is the opposite. getUserMedia gives a MediaStream, the app puts it in a
 * <video> element, and that element presents frames on the CAMERA's crystal,
 * which free-runs against the compositor's draw budget.
 *
 * Two clocks at the same nominal rate is the classic beat: where they nearly
 * coincide, a frame lands just after a draw and is replaced by its successor
 * before it is ever drawn, so the compositor shows the previous picture twice
 * and never shows that one at all. Nothing reports an error. Nothing is
 * "dropped". The fps counter still reads 30. The picture stutters.
 *
 * live.js already knows this — `ensureLoop` carries a phase-alignment step with
 * a comment describing exactly this mechanism. It is gated on
 * `ndiAwaitingFrame()`, so it only ever helped NDI sources. A camera is not an
 * NDI source.
 *
 * WHAT IS MEASURED. For every compositor draw, how many new camera frames the
 * <video> element had presented since the previous draw:
 *
 *      1  — the picture moved on by one frame. This is what smooth means.
 *      0  — a repeat: the compositor drew a picture it had already drawn.
 *     >1  — a skip: camera frames existed and were never drawn at all.
 *
 * A perfect run is every delta 1. Repeats and skips come in PAIRS in a beat
 * (nothing is being lost, the sampling is just landing badly), which is why
 * "frames delivered per second" looks fine while the picture does not.
 *
 *   npm run test:camsmooth
 *
 * MW_SECS=n   how long each scenario runs (default 12)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const ffmod = require('../src/main/ffmpeg');
const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-camsmooth-'));

const SECS = Number(process.env.MW_SECS || 12);

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const note = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + '='.repeat(8) + ' ' + s + ' ' + '='.repeat(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

let savedSettings = { brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/*
 * WHICH TEST SOURCE, AND A WRONG TURN WORTH RECORDING.
 *
 * The source has to arrive the way a camera arrives. A canvas handed to
 * captureStream(fps) does: the browser samples it on a timer of its own, so the
 * frames reach the <video> element on a clock that free-runs against the
 * compositor, which is the whole phenomenon under test.
 *
 * A LOOPING FILE IN A <video> ELEMENT DOES NOT, and it looks like it should.
 * It was tried here precisely because it is cheap and hardware-decoded, and it
 * reported everything perfect — 720 of 720 frames drawn, 0.0% beat — WITH THE
 * FIX SWITCHED OFF. Chromium detects that 30fps content is being shown on a
 * 60Hz display and locks playback to an exact 2:1 cadence, which removes the
 * two free-running clocks the fault is made of. A live MediaStream has no
 * seekable timeline and cannot be cadence-matched that way, so a camera never
 * gets that help. The file source does not measure a camera; it measures
 * Chromium's cadence matcher, and it would have passed this suite for ever.
 *
 * So captureStream it is (`MW_SRC=file` keeps the file path available for
 * comparison). Its one real drawback — it shares this renderer's GPU with the
 * compositor, so a struggling machine slows the SOURCE as well and every
 * number moves at once — is handled by refusing to draw a conclusion from a
 * run whose source never delivered its own rate. See `starved` below.
 */
const CLIPS = {};
function clip(w, h, fps) {
  const key = `${w}x${h}@${fps}`;
  if (CLIPS[key]) return CLIPS[key];
  const out = path.join(tmp, `src-${w}x${h}-${fps}.mp4`);
  execFileSync(FF, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
    '-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(fps), out]);
  CLIPS[key] = pathToFileURL(out).href;
  return CLIPS[key];
}

/*
 * THE ARMS ARE INTERLEAVED, NOT RUN ONE AFTER THE OTHER.
 *
 * This laptop gets slower as a suite goes on — measured across two sequential
 * runs of this very file, drawFrame went from 4.8 ms to 10.6 ms and the test
 * SOURCE fell from 57 fps to 21 fps, which is a larger move than the effect
 * being measured. A "before" run and an "after" run taken ten minutes apart
 * therefore compare two different machines, and a conclusion drawn from the
 * pair is really a conclusion about the thermals.
 *
 * So each scenario alternates short blocks with the alignment on and off. Both
 * arms see the same thermal state, the same background load and the same
 * source, and the comparison is paired rather than historical.
 */
async function runOne(win, label, camFps, prodFps, w, h, real) {
  head(label);
  const useFile = process.env.MW_SRC === 'file';
  const mk = real
    ? `await T.addRealCamera(${camFps || 'null'})`
    : (useFile
      ? `T.addFileCamera('Cam', ${JSON.stringify(useFile && !real ? clip(w, h, camFps) : '')}, ${camFps})`
      : `T.addStreamCamera('Cam', ${camFps}, ${w}, ${h})`);
  if (real) {
    const probe = await js(win, `
      const T = window.LiveStudio.__test;
      T.closeAllInputs();
      T.setFpsMode(${prodFps});
      const r = ${mk};
      if (!r.ok) return r;
      T.setPreview(r.id); T.cut();
      await new Promise(res => setTimeout(res, 3000));
      return Object.assign(r, { targetFps: T.perf().targetFps });`);
    if (probe.__error || !probe.ok) {
      note(`${label}: SKIPPED — no usable real camera`, (probe && (probe.why || probe.__error)) || 'unknown');
      if (probe && probe.all) note('  video inputs seen', probe.all.join(' | '));
      return null;
    }
    console.log(`   REAL camera "${probe.label}" · ${probe.width}x${probe.height} @ ${probe.frameRate} fps`
      + ` · compositor target ${probe.targetFps}fps`);
    // A real camera's rate is whatever it settled on, not what was asked for.
    return measure(win, label, probe.id, prodFps, probe.frameRate || camFps);
  }
  const setup = await js(win, `
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    T.setFpsMode(${prodFps});
    const cam = ${mk};
    T.setPreview(cam.id); T.cut();
    await new Promise(r => setTimeout(r, 2500));
    return { id: cam.id, targetFps: T.perf().targetFps };`);
  if (setup.__error) { console.error('   ' + setup.__error); log(false, label + ': set-up'); return null; }

  console.log(`   camera ${camFps}fps ${w}x${h} · compositor target ${setup.targetFps}fps`);
  return measure(win, label, setup.id, prodFps, camFps);
}

/** The paired A/B itself, for whatever source was just set up. */
async function measure(win, label, camId, prodFps, srcFps) {
  const BLOCK_S = 6;
  const blocks = Math.max(2, Math.round(SECS / BLOCK_S / 2));
  console.log(`   ${blocks} x ${BLOCK_S}s per arm, interleaved…`);
  const setup = { id: camId };
  const arms = { off: [], on: [] };
  for (let i = 0; i < blocks; i++) {
    for (const arm of ['off', 'on']) {
      const started = await js(win, `
        const T = window.LiveStudio.__test;
        T.setPhaseAlign(${arm === 'on'});
        return T.camSmoothStart(${setup.id});`);
      if (!started || !started.ok) { log(false, label + ': the probe could not attach to a <video> element'); return null; }
      await sleep(BLOCK_S * 1000);
      const r = await js(win, `const T = window.LiveStudio.__test;
        const s = T.camSmoothStop(); const p = T.perf();
        return Object.assign(s || {}, { deskFps: p.drawFps, deskMoving: p.movingFps });`);
      if (r && !r.__error) arms[arm].push(r);
    }
  }
  await js(win, `window.LiveStudio.__test.setPhaseAlign(true); return true;`);

  /** Pool an arm's blocks — one long measurement, not an average of ratios. */
  const pool = (list) => {
    const t = { draws: 0, presented: 0, repeats: 0, skipped: 0, secs: 0, worstRun: 0, stalls: 0, stallFrames: 0, deferrals: 0, blocked: 0, renderMs: 0 };
    for (const r of list) {
      t.draws += r.draws; t.presented += r.presented; t.repeats += r.repeats; t.skipped += r.skipped;
      t.secs += r.seconds; t.stalls += r.stalls; t.stallFrames += r.stallFrames; t.deferrals += r.deferrals; t.blocked += (r.deferBlocked || 0);
      t.rafDt = Math.max(t.rafDt || 0, r.rafDt || 0); t.rafMin = r.rafMin || t.rafMin; t.slack = r.slack;
      t.deskFps = r.deskFps; t.deskMoving = r.deskMoving;
      t.renderMs = Math.max(t.renderMs, r.renderMs || 0);
      t.worstRun = Math.max(t.worstRun, r.worstRun);
    }
    t.drawFps = t.secs ? t.draws / t.secs : 0;
    t.presentedFps = t.secs ? t.presented / t.secs : 0;
    // Repeats forced by a draw rate above the source rate, and skips forced by
    // a source rate above the draw rate, are arithmetic — not the app's to fix.
    t.excess = Math.max(0, t.repeats - Math.max(0, t.draws - t.presented));
    t.excessPct = t.draws ? (t.excess * 100) / t.draws : 0;
    t.excessSkips = Math.max(0, t.skipped - Math.max(0, t.presented - t.draws) - t.stallFrames);
    // 0.97, not 0.95. A run whose source delivered 57.2 of 60 squeaked past the
    // looser bar and then reported 17.8% "beat" that was really the test source
    // starving on a contended GPU — a phantom fault, argued about for an hour.
    // Three per cent short is already too short to judge a two per cent effect.
    // AGAINST THE SOURCE'S OWN RATE, not against the production rate.
    // `Math.min(srcFps, prodFps)` let a 60fps source delivering 41/s through as
    // healthy — because 41 clears 30 — and it then reported 14.9% "beat" that
    // was a starved test source, as a hard FAIL. A source is starved when it
    // is not producing what IT was asked for, whatever the show is running at.
    t.starved = t.presentedFps < (srcFps || prodFps) * 0.97;
    return t;
  };
  const off = pool(arms.off), on = pool(arms.on);
  const row = (n, t) => console.log(`    ${n.padEnd(16)} source ${t.presentedFps.toFixed(1)}/s · drew ${t.drawFps.toFixed(1)}/s · `
    + `BEAT ${t.excess} repeats (${t.excessPct.toFixed(1)}%) + ${t.excessSkips} needless skips · `
    + `frozen run ${t.worstRun} · deferrals ${t.deferrals} · blocked ${t.blocked}`
    + ` · rAF mean ${(t.rafDt||0).toFixed(1)}/min ${(t.rafMin||0).toFixed(1)}ms · spare refresh ${t.slack ? 'yes' : 'NO'}`
    + ` · desk reads ${t.deskFps} fps / ${t.deskMoving} new`);
  row('alignment OFF', off);
  row('alignment ON', on);
  return { label, prodFps, off, on };
}

app.whenReady().then(async () => {
  console.log('== CAMERA SMOOTHNESS: what the compositor does with a <video> source ==');
  if (process.env.MW_NO_ALIGN) console.log('   (MW_NO_ALIGN: phase alignment for <video> sources is OFF — this is the BEFORE arm)');

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (/camera|phase|judder/i.test(message)) console.log('   [renderer] ' + message);
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    return true;`);
  await sleep(600);

  // MW_ONLY=real runs the real-camera scenario alone. The synthetic sources
  // each drive a captureStream on the same GPU as the compositor, so running
  // five of them back to back is itself a load — on a machine with little to
  // spare that is the difference between a scored run and a discarded one.
  const only = process.env.MW_ONLY || '';
  const want = (k) => !only || only === k;
  const results = {};
  // The ordinary church case: a 30fps camera on a 30fps production. Same
  // nominal rate, two crystals — the case that beats.
  results.match30 = want('match30') && await runOne(win, '[1] 30fps camera, 30fps production, 720p', 30, 30, 1280, 720);
  // 1080p: the size the user streams, and the one that judders worst.
  results.match30hd = want('match30hd') && await runOne(win, '[2] 30fps camera, 30fps production, 1080p', 30, 30, 1920, 1080);
  // A 60fps camera into a 30fps production has frames to spare — the compositor
  // should always find a new one, so this separates "beat" from "too slow".
  results.cam60 = want('cam60') && await runOne(win, '[3] 60fps camera, 30fps production, 720p', 60, 30, 1280, 720);
  /*
   * THE REAL CAMERA, LAST — the only scenario that exercises the code an
   * operator's click actually runs (getUserMedia, the rate negotiation,
   * attachStream). Everything above is a source this project built, and a
   * source this project built is exactly what hid this fault for five rounds.
   * Skipped with a NOTE where there is no camera, so CI stays green.
   */
  results.realCam = (want('real') || want('realCam'))
    && await runOne(win, '[4] THE REAL CAMERA, 30fps production', 0, 30, 0, 0, true);
  /*
   * 60fps INTO A 60fps PRODUCTION — the case where there is genuinely no spare
   * refresh to yield on a 60Hz panel, so the alignment correctly stands down.
   * Included because a church camera set to 60 is an ordinary configuration and
   * "the fix quietly does nothing here" is something to know, not to discover.
   */
  results.p60 = want('p60') && await runOne(win, '[5] 60fps camera, 60fps production, 720p', 60, 60, 1280, 720);

  head('VERDICT');
  for (const r of Object.values(results)) {
    if (!r) continue;
    const { label, prodFps, off, on } = r;
    if (off.starved || on.starved) {
      note(`${label}: SKIPPED — the source only managed ${Math.min(off.presentedFps, on.presentedFps).toFixed(1)} fps here`,
        'a compositor cannot draw frames that do not exist; this run says nothing about the app');
      continue;
    }
    // Holding the rate is necessary but not sufficient — it is precisely what
    // makes this fault invisible on the fps readout the operator can see.
    log(on.drawFps > prodFps * 0.95, `${label}: the compositor still holds its rate`,
      `${on.drawFps.toFixed(1)} of ${prodFps} fps drawn`);
    // A machine with no headroom is a machine, not a bug. When one drawFrame
    // eats a third of the frame period the compositor cannot choose its moment
    // — and on this two-core laptop 1080p costs ~10 ms of a 33 ms frame. That
    // is reported, not scored, per this project's rule that only what would be
    // the app's fault on ANY machine is a hard failure.
    const roomy = on.renderMs < (1000 / prodFps) / 3;
    if (roomy) {
      log(on.excessPct < 2, `${label}: the picture moves on whenever it can`,
        `${on.excessPct.toFixed(1)}% of draws repeated a frame while a newer one was waiting (want <2%)`);
    } else {
      note(`${label}: beat ${on.excessPct.toFixed(1)}% — not scored`,
        `one draw costs ${on.renderMs.toFixed(1)} ms of a ${(1000 / prodFps).toFixed(1)} ms frame on this machine`);
    }
    log(on.excess <= off.excess, `${label}: the alignment is an improvement, not a wash`,
      `beat ${off.excessPct.toFixed(1)}% without it -> ${on.excessPct.toFixed(1)}% with it`);
    log(on.stalls === 0, `${label}: the draw loop never stopped`, `${on.stalls} hitch(es)`);
  }

  /*
   * A RUN THAT SCORED NOTHING IS NOT A RUN THAT PASSED. Every scenario can be
   * skipped — a contended machine starves the test source and the guard throws
   * the lot away, which is the right call — but printing "all checks passed"
   * after that is how a green tick comes to mean nothing at all. It happened
   * here: four scenarios skipped, summary said everything passed.
   */
  const scored = Object.values(results).filter((r) => r && !r.off.starved && !r.on.starved).length;
  if (!scored) failed = true;
  console.log('\n' + (failed
    ? (scored ? 'CAMERA SMOOTHNESS: FAILURES ABOVE'
              : 'CAMERA SMOOTHNESS: NOTHING WAS SCORED — this machine was too busy to measure on. Re-run when it is idle.')
    : `CAMERA SMOOTHNESS: all checks passed (${scored} scenario(s) scored)`));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
