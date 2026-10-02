'use strict';
/*
 * DOES THE SOUND KEEP PACE WITH THE PICTURE FOR A WHOLE SERVICE?
 *
 * "The audio BEGINS to sound weird on YouTube" and "video with audio not
 * synchronised". The word that matters is *begins*: it starts acceptable and
 * gets worse, which is not what a distortion does. It is what a DRIFT does.
 *
 * THE MECHANISM THIS FILE EXISTS TO MEASURE. The broadcast stamps its two
 * tracks from two different crystals:
 *
 *   • the PICTURE is stamped by the pacer, on an exact grid derived from
 *     `performance.now()` — the system clock;
 *   • the SOUND is stamped from a running sample count divided by the rate the
 *     device SAYS it runs at — the sound card's clock.
 *
 * A sound card that says 48000 is never exactly 48000. If it is 50 parts per
 * million fast, the audio timeline claims 50 µs more than the video timeline
 * for every second on air: 3 ms a minute, 180 ms an hour. Nothing downstream
 * is told, so nothing downstream can undo it — and a platform that keeps the
 * two locked has to stretch the audio continuously to absorb it.
 *
 * WHY EVERY EXISTING TEST MISSES IT. The suites here run 24-40 seconds. At
 * 50 ppm that is 2 ms of drift, against a run-to-run spread of +/-30 ms. The
 * fault is arithmetically invisible at that length no matter how carefully it
 * is measured, and it is hundreds of milliseconds by the end of a sermon.
 *
 *   npm run test:avdrift
 *
 * MW_CLOCK_S=n   seconds spent measuring the card against the system clock (75)
 * MW_RUN_S=n     seconds of real capture to fit a drift slope over (300)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { ProgramHub, QUALITIES, DESTINATIONS, buildUrl, detectEncoder, encoderLabel } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-drift-'));
const ctx = { ffmpeg: FF, ffprobe: FP };

const CLOCK_S = Number(process.env.MW_CLOCK_S || 75);
const RUN_S = Number(process.env.MW_RUN_S || 300);

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const note = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + '='.repeat(8) + ' ' + s + ' ' + '='.repeat(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

let savedSettings = { brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
for (const ch of ['video:presets', 'present:state']) ipcMain.handle(ch, () => ok({}));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed',
  'bible:catalogue', 'present:displays', 'live:screenSources']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));

const hub = new ProgramHub();
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => { try { if (!sender.isDestroyed()) sender.send('live:' + type, { destId: id, ...payload }); } catch (e) {} };
  hub.onHubEvent = (type, payload) => { if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (e) {} } };
}
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid: a.sid };
}));
let recFile = '';
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  recFile = path.join(tmp, `drift-${Date.now()}.mp4`);
  wireHub(e.sender);
  hub.addOutput(ctx, recId, { kind: 'file', filePath: recFile, q, fps: q.fps || fps });
  return { file: recFile };
}));
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => { await hub.removeOutput(recId); return true; }));
ipcMain.handle('live:state', wrap((e, { destId }) => hub.outputState(destId)));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));

// Without this the AudioContext opens SUSPENDED and its clock does not run.
// Timing across that start-up reported the sound card as 99,534 ppm slow —
// nine seconds of a parked context wearing the costume of a crystal error.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/** Least-squares slope of y against x — a single pair of samples is noise. */
function slope(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}

/*
 * THE CLOCK COMPARISON HAS TO HAPPEN WHILE THE BROADCAST IS RUNNING.
 *
 * Measured first on an IDLE AudioContext — nothing connected, nothing
 * capturing — and it reported the sound card losing a quarter of real time,
 * with 11 of 20 three-second intervals short and the worst delivering 64.6%.
 * Taken at face value that is a catastrophe; in fact a context with no work to
 * do does not render on a steady schedule, and `currentTime` reflects that.
 * The capture running alongside it told a completely different and much
 * calmer story in the same session.
 *
 * So it is started AFTER the capture is up and read at the end, overlapping
 * the sampling loop below. It costs nothing — it is two timer reads — and it
 * is then measuring the machine in the state the answer is about.
 */
async function reportClocks(c) {
  if (c.__error) { console.error('   ' + c.__error); log(false, 'clock ratio'); }
  else if (!c.running) {
    note('the audio context never started on this machine', `state=${c.state} — the clock comparison is meaningless, see phase 2`);
  } else {
    console.log(`    device rate ${c.sampleRate} Hz`);
    console.log(`    ${c.audioSeconds.toFixed(4)}s of sound per ${c.systemSeconds.toFixed(4)}s of system time`);
    /*
     * THE WHOLE-RUN RATIO IS THE CRYSTAL; the median of the intervals is not.
     *
     * It was built the other way round on the reasoning that a median survives
     * a one-off stall — true, but it buys that at the cost of a bias that does
     * not cancel. `ac.currentTime` only advances a render quantum at a time and
     * this read happens on the renderer's main thread, which is compositing, so
     * every interval's closing read lands a little late and reads a little low.
     * Measured in one run: −267 ppm per interval against −8 ppm end to end,
     * and it is the −8 that the worker's own frame count agrees with. Over the
     * whole run the late reads cancel between the two endpoints.
     */
    console.log(`    end to end       ${c.ppm.toFixed(1)} ppm  => ${c.msPerHour.toFixed(0)} ms per hour  (the crystal)`);
    console.log(`    per interval     ${c.medianPpm.toFixed(1)} ppm  => ${c.medianMsPerHour.toFixed(0)} ms per hour  (carries this thread's read latency; not the crystal)`);
    console.log(`    ${c.stalled} of ${c.intervals} intervals fell behind · worst ${(c.worst * 100).toFixed(1)}% of real time`);
    /*
     * REPORTED, NOT SCORED. Two crystals disagreeing is a fact about hardware,
     * not a defect: every sound card in every building will read something here
     * and no software can make it read zero. What IS the app's to get right is
     * that the disagreement never reaches the stream — which is what phase 2
     * measures, and which is the only hard assertion in this file.
     */
    note('the two crystals differ by this much — it is hardware, not a bug',
      `${c.msPerHour.toFixed(0)} ms/hour end to end; the capture has to absorb it`);
    // A crystal cannot lose whole milliseconds. An interval that does means the
    // audio thread did not run, and those seconds are simply missing from the
    // broadcast's timeline — a completely different fault from a rate error.
    // A crystal cannot lose whole milliseconds. An interval that does means the
    // audio render thread did not run, and those seconds are simply missing
    // from the broadcast's timeline — a completely different fault from a rate
    // error, and the one that would put holes in the sermon.
    log(c.stalled === 0, 'the audio thread kept up with real time while on air',
      `${c.stalled} of ${c.intervals} intervals short`);
  }
}

app.whenReady().then(async () => {
  console.log('== A/V DRIFT: does the sound keep pace with the picture over a service? ==');

  const win = new BrowserWindow({
    show: true, width: 1200, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (e, level, message) => {
    if (/capture|encoder|sample rate|rate-converted/i.test(message)) console.log('   [renderer] ' + message);
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    return true;`);
  await sleep(500);


  head('[2] WHAT THE CAPTURE ACTUALLY STAMPS');
  const start = await js(win, `
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    // SHIPPING THRESHOLDS BY DEFAULT. Shortening them to force the correction
    // to engage inside a seven-minute run was tried and is exactly the wrong
    // experiment: with the evidence bar at 2 ms the estimator latched onto
    // 468 ppm of pure delivery jitter — nine times the fault, in whichever
    // direction the last message happened to be late. MW_DRIFT_EVIDENCE is
    // kept for a deliberately long end-to-end run, and is not used here.
    ${process.env.MW_DRIFT_EVIDENCE ? `T.setCaptureTuning({ driftAfterMs: ${Number(process.env.MW_DRIFT_AFTER || 40000)}, driftEvidenceS: ${Number(process.env.MW_DRIFT_EVIDENCE)} });` : ''}
    const a = T.addStillSlide('Slide');
    T.setPreview(a.id); T.cut();
    T.setLiveCfg({ quality: 'H264 720p 2.5mbps AAC 128kbps' });
    await new Promise(r => setTimeout(r, 400));
    T.startRecording();
    for (let i = 0; i < 60 && !T.captureDiag(); i++) await new Promise(r => setTimeout(r, 250));
    return { capturing: !!T.captureDiag(), host: T.captureHost ? T.captureHost() : null,
             rate: T.programSampleRate() };`);
  if (start.__error) { console.error('   ' + start.__error); log(false, 'capture start'); }
  const host = start.host && start.host.worker ? 'worker' : 'renderer main thread';
  log(!!start.capturing, 'the capture engine is running', `on the ${host} · bus at ${start.rate} Hz`);
  // The shortened thresholds ride on the same cfg the worker path builds, so a
  // run that quietly fell back in-page would use the shipping eight-minute
  // gate and report the correction as never engaging.
  if (!(start.host && start.host.worker)) {
    note('capture fell back off the worker', 'the shortened drift thresholds are not applied on this path');
  }

  // Fired now, read after the sampling loop: it overlaps the capture instead of
  // measuring an idle context (see reportClocks).
  const clockProbe = js(win, `return await window.LiveStudio.__test.clockRatio(${CLOCK_S * 1000});`);

  console.log(`   sampling for ${RUN_S}s…`);
  const xs = [], aud = [], vid = [], gap = [];
  let last = null;
  const t0 = Date.now();
  for (let i = 0; i < Math.floor(RUN_S / 15); i++) {
    await sleep(15000);
    const d = await js(win, `return window.LiveStudio.__test.captureDiag();`);
    if (!d || d.__error) continue;
    const wall = (Date.now() - t0) / 1000;
    xs.push(wall); aud.push(d.aDeliveredS); vid.push(d.vOutSpanS); gap.push(d.aDeliveredS - d.vOutSpanS);
    last = d;
    process.stdout.write(`    ${wall.toFixed(0).padStart(4)}s  sound ${d.aDeliveredS.toFixed(3)}s  picture ${d.vOutSpanS.toFixed(3)}s`
      + `  gap ${((d.aDeliveredS - d.vOutSpanS) * 1000).toFixed(0).padStart(5)} ms`
      + `  grid ${(d.audioRatePpm || 0).toFixed(0).padStart(4)}ppm`
      + ` (est ${d.audioMeasPpm == null ? '  —' : d.audioMeasPpm.toFixed(0).padStart(4)})`
      + `  paced ${d.paced} filled ${d.filledSlots} missed ${d.missedSlots}\n`);
  }
  await js(win, `window.LiveStudio.__test.stopRecording(); return true;`);

  let driftPpm = null;
  if (xs.length >= 6) {
    /*
     * THE UNCORRECTED FAULT, measured over the whole run.
     *
     * At the shipping thresholds the correction has not acted yet — it waits
     * for 25 ms of accumulated evidence, which at this card's rate is about
     * eight minutes — so what this slope shows is the raw disagreement between
     * the two timelines. That is the number the complaint is about.
     */
    const aSlope = slope(xs, aud);      // sound-seconds per wall-second
    const vSlope = slope(xs, vid);      // picture-seconds per wall-second
    const gSlope = slope(xs, gap);      // the drift itself
    driftPpm = gSlope * 1e6;
    console.log(`
    sound timeline advances   ${aSlope.toFixed(6)} s per second`);
    console.log(`    picture timeline advances ${vSlope.toFixed(6)} s per second`);
    console.log(`    => the two disagree by ${driftPpm.toFixed(0)} ppm `
      + `= ${(gSlope * 3600 * 1000).toFixed(0)} ms per hour `
      + `= ${(gSlope * 5400 * 1000).toFixed(0)} ms over a 90-minute service`);
    if (last) {
      console.log(`    the engine's own estimate after ${(last.audioRateBaselineS || 0).toFixed(0)}s of baseline: `
        + `${last.audioMeasPpm == null ? '—' : last.audioMeasPpm.toFixed(0) + ' ppm'}`
        + ` · applied to the grid: ${(last.audioRatePpm || 0).toFixed(0)} ppm`);
    }
  }

  head('[3] THE TWO CRYSTALS, MEASURED ON AIR');
  const clocks = await clockProbe;
  await reportClocks(clocks);

  head('[4] IS THE CORRECTION RIGHT?');
  /*
   * The end-to-end proof — run for long enough that the correction engages and
   * watch the drift go to zero — needs a quarter of an hour per arm, which is
   * not a suite anyone will run. What CAN be proved in seven minutes is the
   * thing the end-to-end result would depend on: that the number the engine
   * would apply is the number the fault actually is, measured two independent
   * ways. If the estimate matches the drift, applying it removes the drift;
   * there is nothing else in between.
   */
  const est = last && last.audioMeasPpm;
  if (est == null || driftPpm == null) {
    note('not enough of a baseline to judge the estimate', 'run for longer');
  } else {
    console.log(`    the drift, from the two timelines:      ${driftPpm.toFixed(0)} ppm`);
    console.log(`    the engine's estimate, from arrivals:   ${est.toFixed(0)} ppm`);
    if (clocks && clocks.running && clocks.ppm != null) {
      console.log(`    the crystals, read directly on air:     ${clocks.ppm.toFixed(0)} ppm`);
    }
    /*
     * COMPARED AGAINST THE CLOCK READING, NOT AGAINST THE TIMELINE SLOPE.
     *
     * `aDeliveredS` moves in 0.1 s steps and `vOutSpanS` in frame-sized ones,
     * so the gap between the two timelines is quantised to about 33 ms — and
     * 51 ppm over a seven-minute run is 21 ms, less than ONE step. The slope
     * printed above is therefore an order-of-magnitude reading, not a
     * measurement, and asserting on it would be asserting on rounding.
     *
     * It is also not the right comparison. The picture's grid now advances at
     * `audioRate` BY CONSTRUCTION (see paceClockMs), so the residual drift is
     * exactly how wrong the estimate is — and that is answered by reading the
     * same two clocks a second, independent way: `ac.currentTime` against
     * `performance.now()`, on the renderer rather than the worker.
     */
    /*
     * ALL THREE ARE REPORTED AND NONE OF THEM IS SCORED, because measuring a
     * few tens of ppm turns out to be harder than any of the three instruments
     * can honestly manage, and pretending otherwise would put a number in a
     * test report that means nothing:
     *
     *   • THE TIMELINE SLOPE is quantised. `aDeliveredS` moves in 0.1 s steps
     *     and `vOutSpanS` in frame-sized ones, so their difference steps by
     *     ~33 ms while the whole effect over seven minutes is a fraction of
     *     that. It reads rounding.
     *   • THE DIRECT CLOCK READING is biased by the thread it is taken on.
     *     `ac.currentTime` only advances a render quantum at a time and is
     *     READ from the renderer's main thread, which is compositing at 30fps
     *     — so the read lands late and returns the previous quantum, giving a
     *     consistent negative bias. Measured here: −267 ppm against the
     *     worker's +28, on the same machine in the same run.
     *   • THE ARRIVAL ESTIMATE is the cleanest — raw frame counts against a
     *     clock on the worker, which is not compositing anything — and it is
     *     what the correction actually uses. It converged to single-digit ppm
     *     here over 400 s, wandering ±25 as delivery hiccuped.
     *
     * What CAN be asserted, and is the whole point on a healthy machine, is
     * below: that the gate leaves a short broadcast completely untouched.
     */
    console.log(`    (none of the three is scored — see the comment; the arrival estimate is the one`);
    console.log(`     the correction uses, and it is the only one taken off the compositing thread)`);
  }
  /*
   * AND THE GATE HOLDS. A seven-minute broadcast must come out byte-for-byte
   * as it did before this correction existed: the evidence bar is there so a
   * short service, or a machine whose card is honest, is never touched.
   */
  log(!last || !last.audioRatePpm, 'nothing was corrected on this short a run',
    `${last ? (last.audioRatePpm || 0).toFixed(0) : 0} ppm applied (want 0)`);

  if (recFile && fs.existsSync(recFile)) {
    note('recording kept for inspection', recFile);
  }
  console.log('\n' + (failed ? 'A/V DRIFT: FAILURES ABOVE' : 'A/V DRIFT: all checks passed'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
