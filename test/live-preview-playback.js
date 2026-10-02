'use strict';
/*
 * The most faithful possible reproduction of what the user sees: loads the REAL
 * video through the REAL production loadVideo() path, starts REAL playback at
 * the known aggressive-pacing timestamp, lets the REAL setInterval-driven
 * updateLiveReframe loop run under REAL wall-clock timing (not synthetic ticks),
 * and captures periodic screenshots + tracked state so the actual on-screen
 * result can be eyeballed, not just inferred from numbers.
 * Usage: node test/live-preview-playback.js "<video>" [startSec] [seconds]
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const video = require('../src/main/video');

const ctx = { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const START = Number(process.argv[3] || 696);
const WATCH_SEC = Number(process.argv[4] || 20);
const OUT = path.join(os.tmpdir(), 'mw-live-playback');
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
ipcMain.handle('video:info', async (_e, { input }) => { try { return ok(await video.getInfo(ctx, input)); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('video:filmstrip', async () => ({ ok: false, error: 'not needed' }));
ipcMain.handle('video:waveform', async () => ({ ok: false, error: 'not needed' }));
ipcMain.handle('fs:readImageDataUrl', async () => ({ ok: false, error: 'not needed' }));

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

  // show:true -- capturePage on a hidden/offscreen window returns STALE frames
  // (documented gotcha in this codebase), and this test needs REAL screenshots.
  const win = new BrowserWindow({
    show: true, width: 1200, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const avail = await win.webContents.executeJavaScript('window.FaceTrack.available()').catch(() => false);
  console.log('tracker available:', avail);
  if (!avail) { app.exit(1); return; }

  console.log('loading REAL video through the real production path…');
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
  })()`);
  await win.webContents.executeJavaScript(`window.VideoEditor.__test.loadReal(${JSON.stringify(input)})`);
  // wait for real decode readiness
  await win.webContents.executeJavaScript(`(() => new Promise((res) => {
    const p = document.getElementById('vePlayer');
    if (p.readyState >= 2) return res(true);
    p.addEventListener('canplay', () => res(true), { once: true });
    setTimeout(() => res(false), 15000);
  }))()`);
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('veAutoReframe').checked = true;
    window.VideoEditor.__test.setAspect('reel-9x16');
    document.getElementById('vePlayer').currentTime = ${START};
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript(`document.getElementById('vePlayer').play()`);
  console.log(`playing from ${START}s -- watching REAL live-preview tracking for ${WATCH_SEC}s of real time…`);

  const samples = [];
  const t0 = Date.now();
  let i = 0;
  while ((Date.now() - t0) / 1000 < WATCH_SEC) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = await win.webContents.executeJavaScript(`(() => {
      const T = window.VideoEditor.__test;
      const s = T.liveFaceState();
      const p = document.getElementById('vePlayer');
      const frame = document.getElementById('veCropFrame');
      const fr = frame ? frame.getBoundingClientRect() : null;
      return { t: p.currentTime, playing: !p.paused, liveCx: s.cx, liveCy: s.cy, canvasT: window.VideoEditor.__test.canvasTransform ? window.VideoEditor.__test.canvasTransform() : null };
    })()`);
    samples.push(st);
    const shot = path.join(OUT, `t_${String(i).padStart(2, '0')}.png`);
    const img = await win.capturePage();
    fs.writeFileSync(shot, img.toPNG());
    console.log(`  @video-t=${st.t ? st.t.toFixed(1) : '?'}s  liveCx=${st.liveCx != null ? st.liveCx.toFixed(3) : 'null'}  shot=${shot}`);
    i++;
  }

  fs.writeFileSync(path.join(OUT, 'samples.json'), JSON.stringify(samples, null, 2));
  console.log('\nsamples: ' + path.join(OUT, 'samples.json'));
  console.log('screenshots: ' + OUT);
  console.log('done — leaving window open 3s for any final repaint, then closing.');
  await new Promise((r) => setTimeout(r, 3000));
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
