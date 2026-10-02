'use strict';
/*
 * ONE-OFF: dump the per-sample detection + camera-x timeline for a single
 * cached diag-mercy2 window, to see WHY it was flagged WILD (real pacing vs
 * detector noise). Reuses cached frames if present.
 * Usage: node test/diag-window-detail.js <frameDir> <startSec>
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const video = require('../src/main/video');
const ffmpeg = require('ffmpeg-static');

const ctx = { ffmpeg, ffprobe: require('ffprobe-static').path };
const frameDir = process.argv[2];
const start = Number(process.argv[3]);
const WDUR = 36, FPS = 2;
const input = process.argv[4] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';

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
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const OUT = path.join(os.tmpdir(), 'mw-diag-window-detail');
  fs.mkdirSync(OUT, { recursive: true });
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript('window.FaceTrack.available()');

  const info = await video.getInfo(ctx, input);
  const existing = fs.readdirSync(frameDir).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
  const frames = existing.map((f, i) => ({ t: (i + 0.5) / FPS, path: path.join(frameDir, f) }));
  frames.cuts = await video.detectSceneCuts(ctx, { input, startSec: start, dur: WDUR });
  console.log('scene cuts in window:', JSON.stringify(frames.cuts));
  const frameUrls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
  const dets = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames(${JSON.stringify(frameUrls)}, {cuts: ${JSON.stringify(frames.cuts)}})`);
  const kf = await win.webContents.executeJavaScript(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16, cuts: ${JSON.stringify(frames.cuts)}})`);
  const camAt = (t) => {
    if (!kf.length) return info.width / 2;
    if (t <= kf[0].t) return kf[0].x;
    for (let i = 1; i < kf.length; i++) if (t <= kf[i].t) { const a = kf[i - 1], b = kf[i]; return a.x + (b.x - a.x) * ((t - a.t) / Math.max(1e-3, b.t - a.t)); }
    return kf[kf.length - 1].x;
  };
  console.log('\nt\tcxNorm\tsrc\tguarded\tcamX_norm');
  for (const d of dets) {
    console.log(`${d.t.toFixed(2)}\t${d.cxNorm != null ? d.cxNorm.toFixed(3) : 'MISS'}\t${d.src || ''}\t${d.guarded ? 'G' : ''}\t${(camAt(d.t) / info.width).toFixed(3)}`);
  }
  console.log(`\n${kf.length} keyframes`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
