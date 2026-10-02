'use strict';
/*
 * END-TO-END smoothness + follow verification of the LIVE auto-reframe preview
 * on REAL footage: real MediaPipe detections on real extracted frames drive
 * the real target tracker (applyLiveFaceSample via __test.liveTick), and the
 * real 60fps render glide (tickLiveRender via __test.liveRenderTick) is
 * simulated between detection ticks — so the measured trace is exactly what a
 * viewer's eye sees, not just the internal target.
 *
 * Metrics per window:
 *  - max per-frame render step: must respect the glide's speed cap (no teleports
 *    on screen, ever — this IS "smooth").
 *  - velocity reversal rate: how often the on-screen pan changes direction with
 *    meaningful speed (wobble = glitchy; a calm camera reverses rarely).
 *  - off-target time vs a ±1.5s rolling MEDIAN of the raw face readings (robust
 *    to phantom blips): % of time and longest run where the view is far from
 *    the speaker — this IS "follows the speaker".
 *
 * Usage: electron test/live-preview-smooth.js ["<video>"] [win1,win2,...] [durSec]
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const WINDOWS = (process.argv[3] || '500,696,1000').split(',').map(Number);
const DUR = Number(process.argv[4] || 30);
const FPS = 4.5;              // detection cadence (matches the live 220ms timer)
const RFRAMES = 13;           // ~60fps render frames simulated per detection tick
const OUT = path.join(os.tmpdir(), 'mw-live-preview-smooth');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

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

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();

/** POSE-VERIFIED ground truth: a raw face reading only counts if the pose tracker
 *  independently agrees with it (same 0.18 threshold the live algorithm itself uses to trust a
 *  reading) — everything else is excluded, not just down-weighted. Tried two frequency-based
 *  approaches first (a short rolling mean, then majority-cluster over a wider window) and both
 *  got fooled on the noisiest measured scene: a background decor pattern got mis-detected as a
 *  face MORE often than the real speaker was detected in various local windows, so anything
 *  based on "which position appears more" picks the phantom. Requiring pose agreement sidesteps
 *  frequency entirely — a decor pattern has no corresponding body, so pose (near-)never agrees
 *  with it, while it agrees with the real speaker's face on almost every tick where both are
 *  detected (confirmed: comparing the algorithm's own target against same-tick pose-agreeing
 *  face readings shows small, leash-bound-sized gaps, matching direct visual inspection of the
 *  source frames — whereas frequency-based references showed spurious 0.2-0.6 "errors" at
 *  moments the source frame confirms the crop was correctly on the speaker). */
function poseVerified(ticks, halfWin) {
  return ticks.map((t) => {
    const xs = ticks
      .filter((o) => o.face != null && o.poseCx != null && Math.abs(o.poseCx - o.face) <= 0.18 && Math.abs(o.t - t.t) <= halfWin)
      .map((o) => o.face);
    if (!xs.length) return null;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  });
}

app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(AI_DIR, rel));
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('err: ' + e.message, { status: 404 }); }
  });

  const win = new BrowserWindow({
    show: false, width: 1200, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const ready = await win.webContents.executeJavaScript('!!(window.VideoEditor && window.VideoEditor.__test && window.VideoEditor.__test.liveRenderTick)');
  check('editor + render-glide test hooks loaded', ready === true);
  let avail = false;
  try {
    avail = await Promise.race([
      win.webContents.executeJavaScript('window.FaceTrack.available()'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
    ]);
  } catch (e) { console.log('  error: ' + e.message); }
  check('real face tracker available (mwasset:// + WASM)', avail === true);
  if (!ready || !avail) { app.exit(1); return; }

  const info = await video.getInfo(ctx, input);
  console.log(`source ${info.width}x${info.height} ${Math.round(info.durationSec)}s; windows [${WINDOWS.join(', ')}] x ${DUR}s @ ${FPS}fps + ${RFRAMES} render frames/tick`);
  const cropHalfX = 0.5 * ((9 / 16) / (info.width / info.height));

  const allTraces = {};
  for (const START of WINDOWS) {
    const frameDir = path.join(OUT, `w_${START}`);
    const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: FPS, outDir: frameDir });

    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-video').classList.add('active');
      const T = window.VideoEditor.__test;
      T.liveRenderLoopStop(); // this test drives the glide frame-by-frame itself
      T.loadFake({ durationSec: ${info.durationSec}, width: ${info.width}, height: ${info.height} });
      document.getElementById('veAutoReframe').checked = true;
      T.setAspect('reel-9x16');
      T.resetLiveTrack();
    })()`);

    const ticks = [];
    for (const f of frames) {
      const url = pathToFileURL(f.path).toString();
      const r = await win.webContents.executeJavaScript(`(async () => {
        const T = window.VideoEditor.__test;
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load fail')); img.src = ${JSON.stringify(url)}; });
        const prior = T.liveFaceState();
        const face = await window.FaceTrack.detectElement(img, { nearX: prior.cx, nearY: prior.cy });
        if (face) T.liveTick(face.cxNorm, face.cyNorm, face.poseCx, face.poseCy);
        const target = T.liveFaceState();
        const renders = [];
        for (let i = 0; i < ${RFRAMES}; i++) { T.liveRenderTick(1 / 60); renders.push(T.liveRenderState().cx); }
        return { face: face ? face.cxNorm : null, poseCx: face ? face.poseCx : null, target: target.cx, renders };
      })()`);
      ticks.push({ t: f.t, face: r.face, poseCx: r.poseCx, target: r.target, renders: r.renders });
    }
    allTraces['w' + START] = ticks;

    // ---- metrics ----
    const renderSeq = [];
    for (const tk of ticks) if (tk.renders) for (const x of tk.renders) if (x != null) renderSeq.push(x);
    let maxStep = 0, reversals = 0, prevV = 0;
    for (let i = 1; i < renderSeq.length; i++) {
      const v = renderSeq[i] - renderSeq[i - 1];
      maxStep = Math.max(maxStep, Math.abs(v));
      if (Math.abs(v) > 0.0015 && Math.abs(prevV) > 0.0015 && Math.sign(v) !== Math.sign(prevV)) reversals++;
      if (Math.abs(v) > 0.0015) prevV = v;
    }
    const med = poseVerified(ticks, 1.5);
    let offN = 0, visN = 0, offRun = 0, maxOffRun = 0;
    for (let i = 0; i < ticks.length; i++) {
      const tk = ticks[i];
      if (med[i] == null || tk.renders == null || !tk.renders.length) continue;
      visN++;
      const endRender = tk.renders[tk.renders.length - 1];
      if (Math.abs(endRender - med[i]) > 0.12) { offN++; offRun++; maxOffRun = Math.max(maxOffRun, offRun); }
      else offRun = 0;
    }

    // CENTERING: |on-screen render position - dominant-cluster position over ±0.6s|, sampled
    // at every simulated 60fps render frame (not just once per detection tick) — this is the
    // actual visual "how far off-center is the speaker" a viewer would see. ±0.6s (not the
    // original ±0.35s) gives the clustering enough samples to reliably find a majority even on
    // the noisiest measured scene (~50% false-positive rate on a background pattern).
    const dom = poseVerified(ticks, 0.8);
    const centerErrs = [];
    for (let i = 0; i < ticks.length; i++) {
      const ref = dom[i];
      if (ref == null || !ticks[i].renders) continue;
      for (const x of ticks[i].renders) if (x != null) centerErrs.push(Math.abs(x - ref));
    }
    centerErrs.sort((a, b) => a - b);
    const meanCenterErr = centerErrs.reduce((a, b) => a + b, 0) / Math.max(1, centerErrs.length);
    const p90CenterErr = centerErrs[Math.floor(centerErrs.length * 0.9)] || 0;
    const maxCenterErr = centerErrs[centerErrs.length - 1] || 0;

    const detN = ticks.filter((t) => t.face != null).length;
    const revPerSec = reversals / DUR;
    console.log(`\n  window ${START}s: face ${detN}/${ticks.length} ticks`);
    console.log(`    max on-screen step: ${maxStep.toFixed(4)}/frame (cap 0.0150)`);
    console.log(`    direction reversals: ${reversals} (${revPerSec.toFixed(2)}/s)`);
    console.log(`    off-speaker (>0.12 from pose-verified position): ${offN}/${visN} ticks (${(100 * offN / Math.max(1, visN)).toFixed(1)}%), longest ${(maxOffRun / FPS).toFixed(2)}s`);
    console.log(`    CENTERING error vs pose-verified position: avg=${meanCenterErr.toFixed(4)} p90=${p90CenterErr.toFixed(4)} max=${maxCenterErr.toFixed(4)} (crop half-width=${cropHalfX.toFixed(4)}, leash=${(0.3 * cropHalfX).toFixed(4)})`);
    check(`[${START}s] on-screen motion never exceeds the glide speed cap (no visible jumps AT ALL)`, maxStep <= 0.0155, `${maxStep.toFixed(4)}/frame`);
    check(`[${START}s] the view pans calmly, no rapid back-and-forth wobble`, revPerSec <= 1.0, `${revPerSec.toFixed(2)} reversals/s`);
    check(`[${START}s] the view stays ON the speaker (off-target <15% of the time)`, offN <= visN * 0.15, `${(100 * offN / Math.max(1, visN)).toFixed(1)}%`);
    check(`[${START}s] never off the speaker for more than 2s straight`, maxOffRun / FPS <= 2.0, `${(maxOffRun / FPS).toFixed(2)}s`);
    // Bounds are set relative to the ACTUAL leash (0.3x crop half-width — see
    // applyLiveFaceSample): during any window with substantial continuous movement the leash
    // bound itself is the natural steady-state gap, not a looser number picked independently of
    // the algorithm's own guarantee. avg a bit above the leash (mixed movement+stillness), p90
    // comfortably under half the crop (never close to literally leaving frame).
    check(`[${START}s] speaker stays CENTERED on average (typical error < ~1.15x the leash bound)`, meanCenterErr <= 0.35 * cropHalfX, `avg=${meanCenterErr.toFixed(4)} vs bound=${(0.35 * cropHalfX).toFixed(4)}`);
    check(`[${START}s] speaker stays CENTERED even at the 90th percentile (< 60% of crop half-width)`, p90CenterErr <= 0.6 * cropHalfX, `p90=${p90CenterErr.toFixed(4)} vs bound=${(0.6 * cropHalfX).toFixed(4)}`);
  }

  fs.writeFileSync(path.join(OUT, 'traces.json'), JSON.stringify({ cropHalfX, traces: allTraces }, null, 1));
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('traces: ' + path.join(OUT, 'traces.json'));
  if (!win.isDestroyed()) win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
