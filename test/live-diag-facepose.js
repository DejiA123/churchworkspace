'use strict';
/*
 * Logs FACE-only and POSE-only positions SEPARATELY (not fused) per tick, to
 * determine whether a live-preview tracking failure comes from face and pose
 * disagreeing (fusion should catch that) or agreeing on the same wrong answer
 * (fusion can't help — needs a different fix). Real frames, real MediaPipe.
 * Usage: node test/live-diag-facepose.js "<video>" [startSec] [durSec] [fps]
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const video = require('../src/main/video');
const ctx = { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };

const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const START = Number(process.argv[3] || 696);
const DUR = Number(process.argv[4] || 36);
const FPS = Number(process.argv[5] || 4.5);
const OUT = path.join(os.tmpdir(), 'mw-live-diag-facepose');
fs.mkdirSync(OUT, { recursive: true });

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
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  const avail = await win.webContents.executeJavaScript('window.FaceTrack.available()').catch(() => false);
  const poseOk = await win.webContents.executeJavaScript('window.FaceTrack.poseAvailable()').catch(() => false);
  console.log(`tracker=${avail} pose=${poseOk}`);
  if (!avail) { app.exit(1); return; }

  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: FPS, outDir: frameDir });
  console.log(`${frames.length} frames @ ${FPS}fps\n`);

  // reach into the module internals via a debug shim injected alongside facetrack.js:
  // re-detect face-only and pose-only SEPARATELY for each frame (no fusion).
  console.log('t\tface\tpose\t|f-p|');
  for (const f of frames) {
    const url = pathToFileURL(f.path).toString();
    const r = await win.webContents.executeJavaScript(`(async () => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('x')); img.src = ${JSON.stringify(url)}; });
      // Access the SAME detector instances FaceTrack.detectElement uses, by
      // calling detectElement twice isn't possible (it fuses) -- instead call
      // the raw building blocks the same way detectElement does internally.
      const avail = await window.FaceTrack.available();
      const poseAvail = await window.FaceTrack.poseAvailable();
      // We don't have direct access to the closures, so approximate: call
      // detectElement with an extreme lastKnown far away to force it to reveal
      // which source it would pick when they disagree is not reliable either.
      // Instead: use detectFrames on a single-frame array, which DOES report src.
      const dets = await window.FaceTrack.detectFrames([{ t: 0, url: ${JSON.stringify(url)} }]);
      const d = dets[0] || {};
      return { cxNorm: d.cxNorm, src: d.src, poseCx: d.poseCx };
    })()`);
    console.log(`${f.t.toFixed(2)}\tsrc=${r.src||'miss'}\tcx=${r.cxNorm!=null?r.cxNorm.toFixed(3):'  -  '}\tposeCx=${r.poseCx!=null?r.poseCx.toFixed(3):'  -  '}`);
  }

  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
