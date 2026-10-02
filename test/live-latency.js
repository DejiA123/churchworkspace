'use strict';
/*
 * Measures REAL per-call latency of window.FaceTrack.detectElement() in the
 * actual app environment (GPU accel disabled, same as production main.js) —
 * checking whether MediaPipe inference is slow enough to make the live preview
 * track a stale position while the video keeps playing underneath it.
 * Usage: node test/live-latency.js "<video>" [startSec] [durSec]
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
const DUR = Number(process.argv[4] || 20);
const OUT = path.join(os.tmpdir(), 'mw-live-latency');
fs.mkdirSync(OUT, { recursive: true });

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
// mirror production EXACTLY -- main.js calls this, and it's the prime suspect
// for slow (WASM-only, no WebGL) MediaPipe inference.
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
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const avail = await win.webContents.executeJavaScript('window.FaceTrack.available()').catch(() => false);
  console.log('tracker available:', avail);
  if (!avail) { app.exit(1); return; }

  const info = await video.getInfo(ctx, input);
  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 2, outDir: frameDir });
  console.log(`extracted ${frames.length} real frames (1280x720-class source)`);

  // time each detectElement() call on a real decoded image, exactly what the
  // live preview calls per tick -- first pass includes model warm-up variance,
  // so report both the full distribution and the steady-state (post-warm-up).
  const times = [];
  for (const f of frames) {
    const url = pathToFileURL(f.path).toString();
    const ms = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('load fail')); img.src = ${JSON.stringify(url)}; });
      const t0 = performance.now();
      await window.FaceTrack.detectElement(img);
      return performance.now() - t0;
    })()`);
    times.push(ms);
  }
  const warm = times.slice(3); // drop the first few (model/JIT warm-up)
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const sorted = [...warm].sort((a, b) => a - b);
  console.log(`\nall ${times.length} calls (ms): ` + times.map((t) => Math.round(t)).join(', '));
  console.log(`\nsteady-state (n=${warm.length}): avg=${avg(warm).toFixed(0)}ms  median=${sorted[Math.floor(sorted.length / 2)].toFixed(0)}ms  p90=${sorted[Math.floor(sorted.length * 0.9)].toFixed(0)}ms  max=${Math.max(...warm).toFixed(0)}ms`);
  console.log(`\nlive preview polls every 220ms -- if avg/median latency approaches or exceeds that, the effective`);
  console.log(`tick rate is throttled AND every applied detection is that many ms stale relative to live playback.`);

  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
