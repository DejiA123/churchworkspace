'use strict';
/*
 * Real-data verification of the LIVE preview face tracker (veditor.js
 * applyLiveFaceSample, driven through window.VideoEditor.__test.liveTick) using
 * REAL MediaPipe detections (window.FaceTrack.detectElement) on REAL extracted
 * frames from a real sermon — not synthetic cx/cy values. Loads the actual
 * index.html so the real app code runs end-to-end (same detector call the live
 * preview uses, same tracking/leash logic), just fed pre-extracted frame images
 * at a controlled cadence instead of a live-playing <video>.
 * Usage: node test/live-preview-real.js "<video>" [startSec] [durSec] [fps]
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const START = Number(process.argv[3] || 696);
const DUR = Number(process.argv[4] || 36);
const FPS = Number(process.argv[5] || 4.5); // matches the live preview's real ~220ms tick cadence
const OUT = path.join(os.tmpdir(), 'mw-live-preview-real');
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
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();

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
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  const indexPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  await win.loadFile(indexPath);
  await new Promise((r) => setTimeout(r, 1200));

  const veReady = await win.webContents.executeJavaScript('!!(window.VideoEditor && window.VideoEditor.__test)');
  check('video editor test hooks loaded', veReady === true);
  let avail = false;
  try {
    avail = await Promise.race([
      win.webContents.executeJavaScript('window.FaceTrack.available()'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 20s')), 20000)),
    ]);
  } catch (e) { console.log('  error: ' + e.message); }
  check('real face tracker available (mwasset:// + WASM)', avail === true);
  if (!veReady || !avail) { app.exit(1); return; }

  const info = await video.getInfo(ctx, input);
  console.log(`source ${info.width}x${info.height}; window ${START}s +${DUR}s @ ${FPS}fps (${Math.round(DUR * FPS)} ticks)`);

  const frameDir = path.join(OUT, `w_${START}`);
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: FPS, outDir: frameDir });
  check('frames extracted', frames.length >= 10, frames.length + ' frames');

  // set up the video-studio state (aspect ratio + source dims) exactly like the real UI
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: ${info.durationSec}, width: ${info.width}, height: ${info.height} });
    document.getElementById('veAutoReframe').checked = true;
    T.setAspect('reel-9x16');
    T.resetLiveTrack();
  })()`);

  // half the true crop half-width; SAFE=0.30 leash (tightened from 0.50 now that the 60fps
  // render glide handles visual smoothing independently — see applyLiveFaceSample)
  const cropHalfX = 0.5 * ((9 / 16) / (info.width / info.height));
  const leashX = 0.3 * cropHalfX;

  const trace = [];
  let noFace = 0, ticked = 0, maxFreezeRun = 0, freezeRun = 0, maxGap = 0, overLeash = 0;
  let overLeashRun = 0, maxOverLeashRun = 0; // CONSECUTIVE over-leash ticks (a real stuck/bad stretch)
  for (const f of frames) {
    const url = pathToFileURL(f.path).toString();
    const r = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load fail')); img.src = ${JSON.stringify(url)}; });
      const prior = window.VideoEditor.__test.liveFaceState();
      const face = await window.FaceTrack.detectElement(img, { nearX: prior.cx, nearY: prior.cy });
      if (!face) return { face: null };
      const moved = window.VideoEditor.__test.liveTick(face.cxNorm, face.cyNorm, face.poseCx, face.poseCy);
      const st = window.VideoEditor.__test.liveFaceState();
      return { face, moved, state: st };
    })()`);
    if (!r.face) { noFace++; freezeRun++; maxFreezeRun = Math.max(maxFreezeRun, freezeRun); overLeashRun = 0; trace.push({ t: f.t, face: null }); continue; }
    if (r.moved) { ticked++; freezeRun = 0; } else { freezeRun++; maxFreezeRun = Math.max(maxFreezeRun, freezeRun); }
    if (r.state && r.state.cx != null) {
      const gap = Math.abs(r.state.cx - r.face.cxNorm);
      maxGap = Math.max(maxGap, gap);
      // A single tick over the leash is EXPECTED BY DESIGN now: the first tick
      // of any new big-delta sighting deliberately holds still (to filter a
      // lone phantom) rather than leash-dragging toward it, which shows up as
      // exactly one over-leash tick before it either resolves (confirmed snap
      // or subsequent leash-drag) or the reading was truly a one-off (next tick
      // returns to normal and the "gap" stops being measured against a moving
      // target). What matters is that it never STAYS over-leash for long.
      if (gap > leashX + 0.01) { overLeash++; overLeashRun++; maxOverLeashRun = Math.max(maxOverLeashRun, overLeashRun); } else overLeashRun = 0;
      trace.push({ t: f.t, face: r.face.cxNorm, cam: r.state.cx, gap: Number(gap.toFixed(3)) });
    }
  }

  fs.writeFileSync(path.join(OUT, 'trace.json'), JSON.stringify({ leashX, cropHalfX, trace }, null, 2));
  console.log(`  face detected in ${frames.length - noFace}/${frames.length} ticks; camera moved on ${ticked} ticks`);
  console.log(`  longest run with NO camera movement (missed face OR dead-band-held): ${maxFreezeRun} ticks (~${Math.round(maxFreezeRun * 1000 / FPS)}ms)`);
  console.log(`  max |camera - raw face| gap: ${maxGap.toFixed(3)} (leash bound: ${leashX.toFixed(3)})`);
  console.log(`  ticks over the leash: ${overLeash} total, longest CONSECUTIVE run: ${maxOverLeashRun} ticks (~${Math.round(maxOverLeashRun * 1000 / FPS)}ms)`);

  check('face detected on most ticks (real footage, real detector)', (frames.length - noFace) >= frames.length * 0.5, `${frames.length - noFace}/${frames.length}`);
  // a genuinely still/centered speaker legitimately holds still for a while via the
  // dead-band — only flag PROLONGED stalls that would read as "frozen" on screen.
  check('no excessively long freeze (>4s of zero camera movement while a face IS visible)', maxFreezeRun * (1 / FPS) < 4, `${(maxFreezeRun / FPS).toFixed(1)}s`);
  // A 3-tick smoothing filter (added to fix reported "wild"/glitchy jitter)
  // means this "gap vs the RAW instantaneous reading" metric now legitimately
  // runs wide and multi-tick during ANY sustained real movement — that's lag,
  // not being stuck, and is by design (the leash's actual guarantee is against
  // the SMOOTHED target, verified with proper internal consistency in
  // smoke.js's [S] section). The freeze-run check above (zero movement) is
  // what actually catches a truly stuck camera; this one only guards against
  // an absurd multi-second runaway that would indicate something else is wrong.
  check('camera does not run away from the speaker for many seconds straight', maxOverLeashRun * (1 / FPS) <= 3, `longest bad run ${(maxOverLeashRun / FPS).toFixed(2)}s`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('trace: ' + path.join(OUT, 'trace.json'));
  if (!win.isDestroyed()) win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
