'use strict';
/*
 * WHY IS A FACE-TRACKED SHORT 3.7x DEARER PER SECOND THAN A PLAIN ONE?
 *
 * diag-main-encode.js: a plain 30 s 1080p short costs 16.8 s (0.56x real time).
 * diag-shorts-export.js: a face-tracked 90 s one costs 185.6 s (2.06x). Same
 * encoder, same machine, same footage. Something in the reframed path is not
 * getting the GPU — this prints every ffmpeg run it makes, with the encoder it
 * asked for and whether that run succeeded.
 *
 * Run: electron test/diag-reframe-encode.js   (needs the tracker for real keyframes)
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const ff = require('../src/main/ffmpeg');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const input = sermonPath(process.argv[2]);
if (!input) { console.log(noSermon()); process.exit(0); }
const START = Number(process.argv[3] || 600);
const DUR = Number(process.argv[4] || 90);
const OUT = path.join(os.tmpdir(), 'mw-reframe-enc');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/* Every ffmpeg run, what encoder it asked for, and whether it worked. */
let runs = [];
const realRun = ff.runFfmpeg, realCollect = ff.runFfmpegCollect;
const note = (args, ms, ok) => {
  const enc = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : '(no video)';
  const fc = args.includes('-filter_complex');
  runs.push({ enc, ms, ok, fc, verify: args.includes('-f') && args[args.length - 1] === '-' });
};
ff.runFfmpeg = async (bin, args, opts) => {
  const t0 = Date.now();
  try { const r = await realRun(bin, args, opts); note(args, Date.now() - t0, true); return r; }
  catch (e) { note(args, Date.now() - t0, false); throw e; }
};
ff.runFfmpegCollect = async (bin, args, opts) => {
  const t0 = Date.now();
  try { const r = await realCollect(bin, args, opts); note(args, Date.now() - t0, true); return r; }
  catch (e) { note(args, Date.now() - t0, false); throw e; }
};

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

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
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  const js = (s) => win.webContents.executeJavaScript(s);

  const info = await video.getInfo(ctx, input);
  console.log(`\n  source ${info.width}x${info.height} ${info.fps}fps   clip ${START}s +${DUR}s\n`);

  /* real keyframes, exactly as the studio makes them */
  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 6, outDir: frameDir, pairs: true });
  const urls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString(), pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : undefined }));
  const cuts = frames.cuts || [];
  const dets = await js(`window.FaceTrack.detectFrames(${JSON.stringify(urls)}, {cuts: ${JSON.stringify(cuts)}})`);
  const keyframes = await js(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);
  console.log(`  ${keyframes.length} keyframes from ${frames.length} samples\n`);

  /* ---- how far does the camera want to go past the edge of the picture? ---- */
  const p = { w: 1080, h: 1920 };
  const targetAR = p.w / p.h;
  const cropW = Math.round(info.height * targetAR / 2) * 2;
  const maxX = info.width - cropW;
  const want = keyframes.map((k) => Math.round(k.x - cropW / 2));
  const overshoot = Math.max(0, ...want.map((x) => Math.max(-x, x - maxX)));
  console.log(`  crop window ${cropW}x${info.height}, can sit at x=0..${maxX}`);
  console.log(`  the camera wants x=${Math.min(...want)}..${Math.max(...want)}  -> overshoot ${overshoot}px`);
  console.log(overshoot > 2
    ? `  >> OVERSHOOT PATH: the blurred-pad graph, which is libx264 ON PURPOSE (no GPU) <<\n`
    : `  >> plain clamped crop, the normal encodeWithFallback path <<\n`);

  /* ---- now actually run it and show every ffmpeg the export starts ---- */
  const out = path.join(OUT, 'short.mp4');
  runs = [];
  const t0 = Date.now();
  await video.exportShortReframed(ctx, { input, startSec: START, endSec: START + DUR,
    preset: 'reel-9x16', quality: '1080p', keyframes, output: out });
  const total = Date.now() - t0;
  console.log('  EVERY FFMPEG THE EXPORT RAN:');
  for (const r of runs) {
    console.log(`    ${r.enc.padEnd(14)} ${secs(r.ms).padStart(8)}  ${r.ok ? 'ok    ' : 'FAILED'}`
      + `${r.fc ? '  filter_complex' : ''}${r.verify ? '  (the decode-verify)' : ''}`);
  }
  console.log(`    ${'TOTAL'.padEnd(14)} ${secs(total).padStart(8)}   ${(total / (DUR * 1000)).toFixed(2)}x real time`
    + `   ${(fs.statSync(out).size / 1048576).toFixed(1)} MB\n`);
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
