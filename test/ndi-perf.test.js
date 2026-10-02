'use strict';
/*
 * GO LIVE — NDI AT BROADCAST RESOLUTIONS, WHILE STREAMING.
 *
 * The functional NDI suites broadcast a 320x180 pattern, which is small enough
 * that the receive path's cost never shows up. This one runs REAL production
 * sizes — 1080p60 and 4K30 — with the program encoder running, and measures the
 * three things the operator actually feels:
 *
 *   1. MAIN-PROCESS RESPONSIVENESS. This is the process that pushes encoded
 *      chunks into ffmpeg. If it stalls, the broadcast stalls. It used to encode
 *      every NDI frame to JPEG (measured: 16.6 ms at 1080p, 51 ms at 4K), so one
 *      1080p30 input consumed ~64% of it and a 4K one asked for 205% — which is
 *      why the stream stuttered and the picture slid behind the sound. A 10 ms
 *      heartbeat here measures exactly that stall.
 *
 *   2. FRAME DELIVERY. The compositor must actually run near the production
 *      rate, and NDI frames must keep arriving at the sender's rate rather than
 *      being decimated to 30.
 *
 *   3. A/V SYNC STABILITY. The measured sound-vs-picture gap must stay small AND
 *      STOP MOVING. A gap that grows over 20 s is the "audio comes before the
 *      video" fault: the picture falls further behind for as long as it runs.
 *
 * SKIPS (exit 0) when the NDI runtime is not installed.
 * Run: npx electron test/ndi-perf.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const ndi = require('../src/main/ndi');
const { ProgramHub, QUALITIES, DESTINATIONS, detectEncoder, encoderLabel } = require('../src/main/livestream');
const FF = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const FP = require('ffprobe-static').path.replace('app.asar', 'app.asar.unpacked');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ndiperf-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { quality: '1080p', fpsMode: 'auto' } };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ndi.registerIpc(ipcMain, wrap);

/* ---- the REAL broadcast hub, so main is doing its live job while we measure ---- */
const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}

ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid: a.sid };
}));
ipcMain.on('live:chunk', (e, payload) => {
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(payload && payload.sid, Buffer.from(raw)); } catch (er) {}
});
ipcMain.handle('live:state', wrap(async () => ({})));
ipcMain.handle('live:engine', wrap(async () => {
  const enc = hub.running ? (hub.activeEncoder || hub.encoder) : await detectEncoder(FF, 'auto');
  return { encoder: enc, label: encoderLabel(enc), hardware: enc !== 'libx264', preference: 'auto', running: hub.running, outputs: hub.outputCount, gpu: true };
}));
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['1080p'];
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`);
  wireHub(e.sender);
  hubRecFiles.set(recId, file);
  try { hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps }); }
  catch (err) { hubRecFiles.delete(recId); throw err; }
  return { file };
}));
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  await hub.removeOutput(recId); hubRecFiles.delete(recId);
  if (!hub.outputCount) await hub.stop();
  return true;
}));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

/** Watch how badly the MAIN process is blocked over `ms`. */
function watchMain(ms) {
  return new Promise((resolve) => {
    let last = process.hrtime.bigint(), lateTotal = 0, worst = 0, n = 0;
    const iv = setInterval(() => {
      const now = process.hrtime.bigint();
      const late = Number(now - last) / 1e6 - 10;
      last = now; n++;
      if (late > 0) { lateTotal += late; if (late > worst) worst = late; }
    }, 10);
    setTimeout(() => { clearInterval(iv); resolve({ stallPct: (lateTotal / ms) * 100, worstMs: worst, ticks: n }); }, ms);
  });
}

app.whenReady().then(async () => {
  console.log('== GO LIVE — NDI AT BROADCAST RESOLUTIONS ==');
  const status = ndi.getStatus();
  if (!status.available) { console.log('  SKIP  NDI runtime not installed -> ' + (status.error || '')); app.exit(0); return; }
  console.log('  runtime: ' + status.dll);

  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r)=>setTimeout(r,300)); return true;`);

  async function scenario(label, W, H, FPS, srcName, budget, fmt) {
    console.log(`\n[${label}] NDI ${W}x${H}@${FPS} ${fmt || 'uyvy'}`);
    const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, srcName], {
      silent: true,
      env: { ...process.env, MW_NDI_W: String(W), MW_NDI_H: String(H), MW_NDI_FPS: String(FPS), MW_NDI_FMT: fmt || 'uyvy' },
    });
    await sleep(1800);
    let found = null;
    for (let i = 0; i < 24 && !found; i++) {
      found = ndi.getSources().find((s) => s.name.includes(srcName));
      if (!found) await sleep(500);
    }
    if (!found) { check(false, 'sender discovered', srcName); source.kill(); return; }

    const id = await js(win, `const inp = ${T}.addNdiInput(${JSON.stringify(found)}, {}); return inp.id;`);
    // let the receiver connect and the first frames land
    for (let i = 0; i < 40; i++) { if (await js(win, `return ${T}.ndiGotVideo(${id});`)) break; await sleep(250); }
    check(await js(win, `return ${T}.ndiGotVideo(${id});`), 'receiver delivered video', `${W}x${H}`);

    // Start the real broadcast encoder (recording to a file IS the same hub path
    // a stream takes) so main is doing its live job while we measure.
    const rec = await js(win, `await ${T}.startRecording(); await new Promise(r=>setTimeout(r,500)); return ${T}.state().recording;`);
    check(rec === true, 'program encoder running (recording via the hub)');

    await sleep(2500);            // settle
    await js(win, `${T}.resetPerf(${id}); return true;`);
    const mainStall = await watchMain(8000);
    const perf = await js(win, `return ${T}.perf(${id});`);
    // Sample the sync gap repeatedly instead of twice. The measurement is
    // derived from arrival timestamps on two independent paths and is itself
    // noisy — under the heaviest case (software 1080p60 encode) two point
    // samples 6 s apart were landing 76 ms apart in one run and 12 ms in the
    // next, in BOTH directions, while the gap was not actually going anywhere.
    // Comparing the mean of the first second and a half against the mean of the
    // last measures the TREND, which is what "the picture keeps falling further
    // behind" actually means, and it does not fire on noise.
    const samples = [];
    for (let i = 0; i < 18; i++) {
      samples.push(await js(win, `return ${T}.syncState(${id});`));
      await sleep(500);
    }
    const meanAuto = (a) => a.reduce((s, x) => s + ((x && x.autoMs) || 0), 0) / (a.length || 1);
    const early = meanAuto(samples.slice(0, 3));
    const late = meanAuto(samples.slice(-3));
    const sync2 = samples[samples.length - 1];

    console.log(`  main stall ${mainStall.stallPct.toFixed(1)}% (worst ${mainStall.worstMs.toFixed(0)}ms) | ` +
      `ndi ${perf.ndiFps.toFixed(1)}fps drawn / ${perf.ndiDeliveredFps.toFixed(1)}fps arrived (src says ${perf.ndiSrcFps}, fmt ${perf.fmt}, gpu ${perf.accelerated}) | ` +
      `compositor ${perf.drawFps.toFixed(1)}fps target ${perf.targetFps} | render ${perf.renderMs.toFixed(1)}ms/frame | ` +
      `capture ${perf.captureMode}`);

    // 1. main must stay free for ffmpeg. The old JPEG path pinned it.
    check(mainStall.stallPct < 15, 'the main process stays free to feed the encoder',
      mainStall.stallPct.toFixed(1) + '% blocked (was ~64% at 1080p / >100% at 4K on the JPEG path)');
    check(mainStall.worstMs < 120, 'no single main-process stall long enough to starve the stream',
      'worst ' + mainStall.worstMs.toFixed(0) + 'ms');

    // 2. frames really arrive, and the compositor really draws them.
    //    ARRIVED is the receive path's own score — how much of what the sender
    //    put on the wire reached this renderer. It caught two separate faults:
    //    a delivery cap that discarded early-arriving frames (60 -> 53.7), and
    //    the MediaRecorder fallback loading the renderer so hard that the port
    //    could not be drained (60 -> 54.2).
    check(perf.ndiDeliveredFps >= budget.minArrived, 'frames reach the renderer at the sender\'s rate',
      `${perf.ndiDeliveredFps.toFixed(1)}fps arrived (sender ${FPS}, need >=${budget.minArrived})`);
    //    DRAWN is what the operator and the stream actually see: a frame that
    //    arrives but misses its draw slot shows the previous picture again.
    check(perf.ndiFps >= budget.minNdiFps, 'and the compositor draws them rather than repeating frames',
      `${perf.ndiFps.toFixed(1)}fps drawn (sender ${FPS}, need >=${budget.minNdiFps})`);
    check(perf.drawFps >= budget.minDrawFps, 'the compositor keeps up at the production rate',
      `${perf.drawFps.toFixed(1)}fps (need >=${budget.minDrawFps})`);

    // 3. sync must be small AND stable — a gap that grows is the reported fault
    const drift = Math.abs(late - early);
    check(Math.abs(sync2.autoMs || 0) < 250, 'sound and picture are measured close together',
      `${Math.round(sync2.autoMs || 0)} ms apart`);
    check(drift < 60, 'and that gap is NOT drifting — the picture does not fall further behind',
      `trend moved ${Math.round(drift)} ms over 9 s (${Math.round(early)} -> ${Math.round(late)})`);
    check((sync2.underrunEvents || 0) <= 3, 'the sound runs continuously at this resolution',
      (sync2.underrunEvents || 0) + ' dropouts');

    await js(win, `await ${T}.stopRecording(); ${T}.closeInput(${id}); return true;`);
    await sleep(1200);
    try { source.kill(); } catch (e) {}
    await sleep(600);
  }

  // UYVY is what real senders put on the wire, so these are the headline cases.
  // The budgets sit ~10% under what the fixed pipeline measures, which is tight
  // enough that any of the faults above reappearing fails the run: each of them
  // cost 10-20% of the sender's rate on its own.
  await scenario('1080p60', 1920, 1080, 60, 'MW Perf HD', { minArrived: 54, minNdiFps: 52, minDrawFps: 52 }, 'uyvy');
  await scenario('4K30', 3840, 2160, 30, 'MW Perf 4K', { minArrived: 26, minNdiFps: 25, minDrawFps: 27 }, 'uyvy');
  // BGRA is the worst case (twice the bytes) — a source with a real alpha
  // channel. It must still hold up at 1080p.
  await scenario('1080p30 BGRA', 1920, 1080, 30, 'MW Perf BGRA', { minArrived: 27, minNdiFps: 27, minDrawFps: 27 }, 'bgra');

  console.log(`\n==== NDI performance: ${pass} PASS / ${fail} FAIL ====`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
