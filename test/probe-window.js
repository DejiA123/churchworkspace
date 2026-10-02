'use strict';
/*
 * Print the full detection + camera time series for ONE cached diag window —
 * to SEE what the virtual camera is chasing. Usage:
 *   npx electron test/probe-window.js "<video>" <startSec> [dur]
 * (Reuses frames cached by diag-mercy2.js when present.)
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const START = Number(process.argv[3] || 3526);
const DUR = Number(process.argv[4] || 36);
const FPS = 2;
const OUT = path.join(os.tmpdir(), 'mw-diag-mercy2');

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(AI_DIR, rel));
      if (!full.startsWith(AI_DIR)) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('err: ' + e.message, { status: 404 }); }
  });
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const tmpHtml = path.join(OUT, 'probe.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));

  const info = await video.getInfo(ctx, input);
  const W = info.width, H = info.height;

  // frames: reuse the diag cache if present
  let frameDir = null;
  for (const d of fs.existsSync(OUT) ? fs.readdirSync(OUT) : []) {
    if (d.endsWith('_' + START)) { frameDir = path.join(OUT, d); break; }
  }
  let frames;
  if (frameDir) {
    const files = fs.readdirSync(frameDir).filter((f) => /^f_\d+\.jpg$/.test(f)).sort();
    frames = files.map((f, i) => ({ t: (i + 0.5) / FPS, path: path.join(frameDir, f) }));
    frames.cuts = await video.detectSceneCuts(ctx, { input, startSec: START, dur: DUR });
  } else {
    frameDir = path.join(OUT, 'probe_' + START);
    frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: FPS, outDir: frameDir });
  }
  const cuts = frames.cuts || [];
  const frameUrls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
  const dets = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames(${JSON.stringify(frameUrls)}, {cuts: ${JSON.stringify(cuts)}})`);
  const kf = await win.webContents.executeJavaScript(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${W}, ${H}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);

  const camAt = (t) => {
    if (!kf.length) return W / 2;
    if (t <= kf[0].t) return kf[0].x;
    for (let i = 1; i < kf.length; i++) if (t <= kf[i].t) {
      const a = kf[i - 1], b = kf[i];
      return a.x + (b.x - a.x) * ((t - a.t) / Math.max(1e-3, b.t - a.t));
    }
    return kf[kf.length - 1].x;
  };
  console.log(`window @${START}s cuts>=0.14: ${cuts.filter((c) => c.score >= 0.14).map((c) => c.t.toFixed(1) + '(' + c.score.toFixed(2) + ')').join(' ')}`);
  console.log('   t    cx     src   pose    cam   Δ(px)');
  for (const d of dets) {
    const cam = camAt(d.t) / W;
    const cx = d.cxNorm == null ? '  -  ' : d.cxNorm.toFixed(3);
    const pc = d.poseCx == null ? '  -  ' : d.poseCx.toFixed(3);
    const off = d.cxNorm == null ? '' : String(Math.round(Math.abs(d.cxNorm - cam) * W));
    console.log(`${String(d.t.toFixed(2)).padStart(6)} ${cx}  ${String(d.src || (d.guarded ? 'GUARD' : 'miss')).padStart(5)}  ${pc}  ${cam.toFixed(3)}  ${off}`);
  }
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
