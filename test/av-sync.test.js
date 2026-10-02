'use strict';
/*
 * GO LIVE — SOUND AND PICTURE MUST LINE UP.
 *
 * [A] The NDI jitter buffer (src/renderer/ndi-audio-worklet.js), driven directly
 *     in Node so its behaviour is deterministic and measurable:
 *       - it settles at a small, known latency instead of wherever a burst left it,
 *       - a burst does NOT become permanent lag,
 *       - a sender whose clock runs fast does not push the latency up and up
 *         (this is the "the sound slid further behind as the service went on" bug),
 *       - the correction it uses is small enough that nobody can hear it,
 *       - an underrun recovers instead of accumulating a debt.
 *     Each case is also run against the OLD drop-on-high-water design so the
 *     numbers show what actually changed.
 *
 * [B] The A/V sync controller in the real Go Live UI: synthetic arrival
 *     timestamps in, hold-back decisions out (both directions, clamped, and the
 *     manual per-input offset on top).
 *
 * [C] The picture hold-back for real: a delayed input must genuinely show OLD
 *     frames on the program canvas, checked by reading pixels.
 *
 * Run: npx electron test/av-sync.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================= [A] the jitter buffer ========================= */
const SR = 48000, BLOCK = 128;

/** Load the real worklet file with the AudioWorklet globals it expects. */
function loadWorklet() {
  let Ctor = null;
  global.sampleRate = SR;
  global.currentTime = 0;
  global.AudioWorkletProcessor = class {
    constructor() { this.port = { onmessage: null, postMessage: (m) => { this._last = m; } }; }
  };
  global.registerProcessor = (name, cls) => { Ctor = cls; };
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ndi-audio-worklet.js'), 'utf-8');
  // eslint-disable-next-line no-new-func
  new Function(src).call(global);
  return Ctor;
}

/** The OLD design, for comparison: ring + drop-oldest above a 400 ms cap. */
class LegacyBuffer {
  constructor() {
    this.size = SR * 2; this.L = new Float32Array(this.size); this.rd = 0; this.filled = 0;
    this.high = Math.floor(SR * 0.4);
  }
  push(l) {
    let wr = (this.rd + this.filled) % this.size;
    for (let i = 0; i < l.length; i++) {
      this.L[wr] = l[i]; wr = (wr + 1) % this.size;
      if (this.filled < this.size) this.filled++; else this.rd = (this.rd + 1) % this.size;
    }
    if (this.filled > this.high) { const drop = this.filled - this.high; this.rd = (this.rd + drop) % this.size; this.filled -= drop; }
  }
  pull(n) { const k = Math.min(n, this.filled); this.rd = (this.rd + k) % this.size; this.filled -= k; }
  get queueMs() { return (this.filled / SR) * 1000; }
}

/**
 * Drive a processor for `seconds` of simulated time. The sender produces audio
 * at `senderRate` Hz; the sound card consumes exactly one 128-sample block per
 * block of real time — the real relationship between the two clocks.
 *
 * `stallFrom`/`stallMs` models the delivery hiccup that actually happens here:
 * nothing arrives for a while (the receiver is busy with a video frame, or IPC
 * backs up), then the whole backlog lands in ONE burst. That is the event that
 * used to leave permanent latency behind.
 */
function runBuffer(proc, { seconds, senderRate = SR, stallFrom = -1, stallMs = 0, starveFrom = -1, starveTo = -1 }) {
  const out = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const outputs = [out];
  let produced = 0;
  const samples = [];
  const blocks = Math.round((seconds * SR) / BLOCK);
  const depth = () => (proc.queueMs != null ? proc.queueMs : ((proc.wr - proc.rd) / SR) * 1000);
  const feed = (n) => {
    if (n <= 0) return;
    const l = new Float32Array(n), r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = Math.sin((produced + i) * 0.01); r[i] = l[i]; }
    produced += n;
    if (proc.push) proc.push(l, r); else proc.port.onmessage({ data: { l, r } });
  };
  for (let b = 0; b < blocks; b++) {
    const t = (b * BLOCK) / SR;
    const stalled = stallFrom >= 0 && t >= stallFrom && t < stallFrom + stallMs / 1000;
    const starving = starveFrom >= 0 && t >= starveFrom && t < starveTo;   // source really stopped
    if (!stalled && !starving) {
      // everything the sender has made that we have not handed over yet — after
      // a stall this is the whole backlog, delivered in one go
      feed(Math.round(((b + 1) * BLOCK * senderRate) / SR) - produced);
    }
    if (starving) produced = Math.round(((b + 1) * BLOCK * senderRate) / SR); // that audio is gone for good
    if (proc.process) proc.process([], outputs);
    else proc.pull(BLOCK);
    if (b % 40 === 0) samples.push({ t, queueMs: depth() });
  }
  return { queueMs: depth(), samples, maxQueueMs: Math.max(...samples.map((s) => s.queueMs)) };
}

function sectionA() {
  console.log('\n[A] NDI audio jitter buffer');
  const Proc = loadWorklet();
  check(!!Proc, 'the worklet file loads and registers its processor');
  const make = () => new Proc({ processorOptions: { targetMs: 60 } });

  // 1) steady state settles at the target, not wherever it happened to start
  const steady = runBuffer(make(), { seconds: 8 });
  check(Math.abs(steady.queueMs - 60) < 15, 'settles at the ~60 ms target latency', steady.queueMs.toFixed(1) + ' ms');

  // 2) a delivery stall + burst does not become permanent lag
  const afterBurst = runBuffer(make(), { seconds: 20, stallFrom: 2, stallMs: 350 });
  const legacyBurst = runBuffer(new LegacyBuffer(), { seconds: 20, stallFrom: 2, stallMs: 350 });
  check(afterBurst.queueMs < 90, 'a 350 ms delivery stall drains back to the target', afterBurst.queueMs.toFixed(1) + ' ms');
  check(afterBurst.queueMs < legacyBurst.queueMs - 100, 'the old design KEPT that backlog as latency, for good',
    `old ${legacyBurst.queueMs.toFixed(0)} ms vs new ${afterBurst.queueMs.toFixed(0)} ms`);

  // 3) a sender clock 0.1% fast — the drift that grew through a whole service
  const drift2 = runBuffer(make(), { seconds: 120, senderRate: SR * 1.001 });
  const drift8 = runBuffer(make(), { seconds: 480, senderRate: SR * 1.001 });
  const legacy2 = runBuffer(new LegacyBuffer(), { seconds: 120, senderRate: SR * 1.001 });
  const legacy8 = runBuffer(new LegacyBuffer(), { seconds: 480, senderRate: SR * 1.001 });
  check(drift8.queueMs < 100, 'a fast sender clock does not push the latency up over a service', drift8.queueMs.toFixed(1) + ' ms after 8 min');
  check(Math.abs(drift8.queueMs - drift2.queueMs) < 20, 'the latency is FLAT over time, not creeping',
    `${drift2.queueMs.toFixed(0)} ms at 2 min → ${drift8.queueMs.toFixed(0)} ms at 8 min`);
  check(legacy8.queueMs > legacy2.queueMs + 100 && legacy8.queueMs > 350,
    'the old design crept up with the clock until it sat on its 400 ms ceiling',
    `old: ${legacy2.queueMs.toFixed(0)} ms at 2 min → ${legacy8.queueMs.toFixed(0)} ms at 8 min`);

  // 4) the correction is inaudible: the read rate never moves more than ±2%
  const p = make();
  runBuffer(p, { seconds: 8, stallFrom: 1, stallMs: 300 });
  const trim = p.maxTrim;
  check(trim <= 0.02, 'the playback-rate correction is capped at ±2% (well under a noticeable pitch change)', '±' + (trim * 100) + '%');

  // 5) an underrun recovers instead of accumulating a debt
  const starve = make();
  const st = runBuffer(starve, { seconds: 10, starveFrom: 2, starveTo: 3 });
  check(starve.underruns > 0, 'a gap in the incoming audio is detected as an underrun', starve.underruns + ' underrun samples');
  check(st.queueMs > 20 && st.queueMs < 120, 'and it recovers to a normal latency afterwards', st.queueMs.toFixed(1) + ' ms');

  // 6) it reports its depth (the A/V sync controller needs the real number)
  const rep = make();
  const repRun = runBuffer(rep, { seconds: 2 });
  const last = rep._last;   // the stub port records the last postMessage
  check(last && typeof last.queueMs === 'number' && Math.abs(last.queueMs - repRun.queueMs) < 5,
    'it reports its live buffer depth back to the app (what A/V sync needs)',
    last ? `reported ${last.queueMs.toFixed(1)} ms, actual ${repRun.queueMs.toFixed(1)} ms` : 'no report');
}

/* ===================== [B]+[C] the controller, in the app ================ */
const ok = (data) => ({ ok: true, data });
const tmp = os.tmpdir();
let saved = { brand: {}, accounts: {}, apiKeys: {}, live: { quality: '720p30', fpsMode: '30' } };
ipcMain.handle('settings:get', () => ok(saved));
ipcMain.handle('settings:update', (e, { patch }) => { saved = { ...saved, ...patch }; return ok(saved); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  sectionA();

  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  const js = (c) => win.webContents.executeJavaScript(c);
  await js(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    return true;
  })()`);
  await sleep(400);

  console.log('\n[B] A/V sync controller');
  const id = await js(`window.LiveStudio.__test.addSynthetic('SyncCam', 200).id`);
  await sleep(300);
  // Wait for Chromium's output latency to SETTLE before measuring anything: a
  // fresh context reports ~10 ms and then ~52 ms once its stream is running,
  // and a controller and a check that read it on opposite sides of that step
  // disagree by 42 ms — which made this suite fail on alternate runs with
  // nothing wrong in the app.
  let env = await js(`window.LiveStudio.__test.syncEnv()`);
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    const again = await js(`window.LiveStudio.__test.syncEnv()`);
    const steady = Math.abs(again.outputLatencyMs - env.outputLatencyMs) < 1;
    env = again;
    if (steady && i >= 3) break;
  }
  console.log(`  output latency ${env.outputLatencyMs.toFixed(1)} ms, compositor ${(1000 / env.targetFps).toFixed(1)} ms/frame`);

  const zero = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(zero && zero.audioMs === 0 && zero.videoMs === 0 && zero.delayNodeSec === 0,
    'an input starts perfectly neutral — nothing is delayed until it needs to be', JSON.stringify({ a: zero.audioMs, v: zero.videoMs }));

  // --- sound arriving LATE (the reported symptom: picture ahead of sound) ---
  // audio stamped 20 ms ago, video stamped 20 ms ago: both paths equal, but the
  // audio still has a 200 ms buffer + output latency ahead of it.
  const feed = async (aAgeMs, vAgeMs, queueMs) => {
    await js(`(() => {
      const T = window.LiveStudio.__test;
      T.resetSyncSamples(${id});
      T.setSyncQueueMs(${id}, ${queueMs});
      const now = performance.now();
      for (let i = 0; i < 15; i++) {
        T.feedSyncSample(${id}, 'audio', (now - ${aAgeMs}) * 10000);
        T.feedSyncSample(${id}, 'video', (now - ${vAgeMs}) * 10000);
      }
      T.syncTick();
      return true;
    })()`);
    await sleep(120);
    return js(`window.LiveStudio.__test.syncState(${id})`);
  };
  const late = await feed(20, 20, 200);
  // The output latency is read AGAIN, at the moment of comparison: Chromium
  // reports ~10 ms for a fresh context and then settles (~52 ms here) once its
  // stream is running, and the controller uses whatever is current. Comparing
  // against the reading taken at start-up made this check fail on alternate
  // runs with the measurement itself unchanged (219-220 ms every time).
  const envNow = await js(`window.LiveStudio.__test.syncEnv()`);
  const expectLate = 200 + envNow.outputLatencyMs - 1000 / envNow.targetFps;
  check(late.autoMs != null && Math.abs(late.autoMs - expectLate) < 12,
    'it measures how far the sound is behind the picture', `${late.autoMs} ms (expected ≈ ${expectLate.toFixed(0)})`);
  check(late.videoMs > 100 && late.audioMs === 0,
    'and holds the PICTURE back to meet it (never speeds the sound up)', `video +${Math.round(late.videoMs)} ms, audio +${Math.round(late.audioMs)} ms`);

  // --- sound arriving EARLY (picture path is the slow one) ---
  const early = await feed(20, 260, 20);
  check(early.autoMs < -100 && early.audioMs > 100 && early.videoMs === 0,
    'a slow picture path is corrected the other way — the SOUND waits', `measured ${early.autoMs} ms → audio +${Math.round(early.audioMs)} ms`);
  await sleep(900);
  const ramped = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(ramped.delayNodeSec > 0, 'the audio delay line is really moving (ramped, so it cannot be heard)', (ramped.delayNodeSec * 1000).toFixed(0) + ' ms');

  // --- absurd measurements are clamped, not obeyed ---
  const wild = await feed(20, 20, 5000);
  check(wild.videoMs <= 500, 'a nonsense measurement is clamped instead of freezing the picture', Math.round(wild.videoMs) + ' ms');

  // --- the manual offset, both directions, on top of the automatic one ---
  await js(`window.LiveStudio.__test.setAutoSync(false)`);
  await js(`window.LiveStudio.__test.setInputSync(${id}, 150)`);
  await sleep(80);
  const man1 = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(man1.audioMs === 150 && man1.videoMs === 0, 'a POSITIVE manual offset delays the sound', JSON.stringify({ a: man1.audioMs, v: man1.videoMs }));
  await js(`window.LiveStudio.__test.setInputSync(${id}, -180)`);
  await sleep(80);
  const man2 = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(man2.videoMs === 180 && man2.audioMs === 0, 'a NEGATIVE manual offset delays the picture', JSON.stringify({ a: man2.audioMs, v: man2.videoMs }));
  const clamped = await js(`window.LiveStudio.__test.setInputSync(${id}, 9999)`);
  check(clamped === 500, 'the manual offset is bounded to ±500 ms', clamped + ' ms');

  console.log('\n[C] the picture hold-back is real (pixels, not numbers)');
  await js(`window.LiveStudio.__test.setInputSync(${id}, -300)`); // hold the picture 300 ms
  await js(`(() => { const T = window.LiveStudio.__test; T.paintInput(${id}, '#0000ff'); T.setPreview(${id}); T.cut(); return true; })()`);
  // Let the app's OWN render loop fill the delayed pipeline — poking it over IPC
  // would set the sampling grid from the test harness instead of the compositor.
  await sleep(1500);
  const blue = await js(`window.LiveStudio.__test.pgmPixel(320, 180)`);
  const held = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(blue[2] > 180 && blue[0] < 70, 'the delayed input reaches the program canvas', 'rgb ' + blue.slice(0, 3).join(','));
  check(held.drawingDelayed && held.videoQueued > 2,
    'the compositor is drawing the held-back picture, not the live source', `${held.videoQueued} frames queued, delayed=${held.drawingDelayed}`);

  const compFps = (await js(`window.LiveStudio.__test.state()`)).fps || 30;
  const frameMs = 1000 / Math.max(5, compFps);
  console.log(`  compositor is running at ${compFps} fps (${frameMs.toFixed(0)} ms per frame) in this harness`);
  check(held.displayedAgeMs != null && Math.abs(held.displayedAgeMs - 300) < Math.max(40, frameMs),
    'each frame is put on screen exactly the requested 300 ms late', held.displayedAgeMs + ' ms old when drawn');

  // Flip the source to RED and let the app's own loop run: the time until the
  // program shows red IS the hold-back, measured end to end. (Timed inside the
  // page so the measurement is not padded by IPC round trips.)
  const appearedMs = await js(`(async () => {
    const T = window.LiveStudio.__test;
    const t0 = performance.now();
    T.paintInput(${id}, '#ff0000');
    for (let i = 0; i < 120; i++) {
      const p = T.pgmPixel(320, 180);
      if (p[0] > 180 && p[2] < 70) return Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  })()`);
  check(appearedMs != null && appearedMs > 230, 'a change at the source does NOT appear immediately — the picture is being held back', appearedMs + ' ms');
  check(appearedMs != null && appearedMs < 300 + 3 * frameMs,
    'and it appears right when the hold-back time has passed (not frozen, not late)', `${appearedMs} ms (300 + up to ${(3 * frameMs).toFixed(0)} ms of frame timing)`);

  // switching the delay off returns to a live picture immediately
  await js(`window.LiveStudio.__test.setInputSync(${id}, 0)`);
  await js(`window.LiveStudio.__test.paintInput(${id}, '#00ff00')`);
  for (let i = 0; i < 3; i++) { await js(`window.LiveStudio.__test.drawNow()`); await sleep(20); }
  const green = await js(`window.LiveStudio.__test.pgmPixel(320, 180)`);
  check(green[1] > 180, 'with no offset set, the picture is live again (zero cost when unused)', 'rgb ' + green.slice(0, 3).join(','));
  const st2 = await js(`window.LiveStudio.__test.syncState(${id})`);
  check(!st2.drawingDelayed, 'and the compositor is back to drawing the source directly');

  console.log(`\n==== A/V sync: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
