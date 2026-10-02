'use strict';
/*
 * WOULD MOVING THE TRACKER TO THE GPU MOVE THE CAMERA?
 *
 * The raw face boxes disagree between the CPU and GPU delegates — mean 0.11 of
 * the frame width apart, worst 0.87. That sounds fatal. But raw boxes are not
 * what reaches the video: the tracker runs an identity layer, a pose arbiter, a
 * recovery layer and a virtual camera over them, and what the export actually
 * uses is ONE number per keyframe — where the crop window sits.
 *
 * So this compares the thing that reaches the video. Same stills, both
 * delegates, all the way through detectFrames + buildKeyframes, and the answer
 * in PIXELS of the source. Anything under a few pixels is invisible; a
 * disagreement of a hundred is a different short.
 *
 * Run: electron test/diag-delegate-path.js ["<video>"] [start] [dur]
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const input = sermonPath(process.argv[2]);
if (!input) { console.log(noSermon()); process.exit(0); }
const START = Number(process.argv[3] || 600);
const DUR = Number(process.argv[4] || 60);
const OUT = path.join(os.tmpdir(), 'mw-delegate-path');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// Destroying the first harness window would otherwise make Electron quit before
// the second delegate is ever measured.
app.on('window-all-closed', () => {});

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
  // 'unsafe-inline' is for the one inline <script> that sets the delegate below.
  // This is a measurement harness, not the app; the product page keeps its own CSP.
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";

  const info = await video.getInfo(ctx, input);
  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 6, outDir: frameDir, pairs: true });
  const urls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : undefined }));
  const cuts = frames.cuts || [];
  console.log(`\n  ${info.width}x${info.height}   ${urls.length} samples over ${DUR}s\n`);

  /* A FRESH window per delegate: the models are a module-level singleton, so the
   * second run must not inherit the first one's detector. */
  const runWith = async (delegate) => {
    const html = path.join(OUT, `h-${delegate || 'cpu'}.html`);
    fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8">`
      + `<meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>`
      + `<script>window.MW_AI_DELEGATE=${delegate ? JSON.stringify(delegate) : 'null'};</script>`
      + `<script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
    const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
    await win.loadFile(html);
    await new Promise((r) => setTimeout(r, 300));
    const js = (s) => win.webContents.executeJavaScript(s);
    const t0 = Date.now();
    const dets = await js(`window.FaceTrack.detectFrames(${JSON.stringify(urls)}, {cuts: ${JSON.stringify(cuts)}})`);
    const ms = Date.now() - t0;
    const kf = await js(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);
    const used = await js('window.FaceTrack.delegateInUse ? window.FaceTrack.delegateInUse() : "?"').catch(() => '?');
    win.destroy();
    return { dets, kf, ms, used };
  };

  const cpu = await runWith(null);
  const gpu = await runWith('GPU');
  const s = (v) => (v / 1000).toFixed(1) + 's';
  console.log(`   CPU  ${s(cpu.ms).padStart(7)}   delegate in use: ${cpu.used}   ${cpu.kf.length} keyframes`);
  console.log(`   GPU  ${s(gpu.ms).padStart(7)}   delegate in use: ${gpu.used}   ${gpu.kf.length} keyframes`
    + `   ${(cpu.ms / Math.max(1, gpu.ms)).toFixed(2)}x faster`);

  /* ---- the number that reaches the video: where the crop window sits ---- */
  const at = (kf, t) => {
    if (!kf.length) return null;
    let lo = kf[0];
    for (const k of kf) { if (k.t <= t) lo = k; else break; }
    return lo.x;
  };
  let sum = 0, worst = 0, worstT = 0, n = 0;
  for (let t = 0; t <= DUR; t += 0.25) {
    const a = at(cpu.kf, t), b = at(gpu.kf, t);
    if (a == null || b == null) continue;
    const d = Math.abs(a - b);
    sum += d; n++;
    if (d > worst) { worst = d; worstT = t; }
  }
  const cropW = Math.round(info.height * 9 / 16 / 2) * 2;
  console.log(`\n  WHERE THE CAMERA POINTS (source pixels; the crop window is ${cropW}px wide):`);
  console.log(`   mean apart ${(sum / Math.max(1, n)).toFixed(1)} px   worst ${worst.toFixed(0)} px at ${worstT.toFixed(1)}s`);
  console.log(`   as a fraction of the window: mean ${(sum / Math.max(1, n) / cropW).toFixed(3)}  worst ${(worst / cropW).toFixed(3)}`);

  const found = (d) => d.filter((x) => x.cxNorm != null).length;
  console.log(`\n  SPEAKER FOUND IN: CPU ${found(cpu.dets)}/${cpu.dets.length}   GPU ${found(gpu.dets)}/${gpu.dets.length}`);
  console.log('\n  Ship it only if the camera agrees. Finding the speaker in FEWER frames,');
  console.log('  or a worst-case that is a large part of the window, rules it out.\n');
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
