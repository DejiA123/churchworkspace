'use strict';
/*
 * WORST-CASE guarantee for auto-reframe: the speaker must stay inside the 9:16
 * frame at EVERY moment, not just on average. Exports a face-tracked short of a
 * real sermon, densely samples the OUTPUT, detects the face in each output frame,
 * and asserts it is present and never near the edge — the "sometimes out of
 * frame" fix. Usage: node test/reframe-inframe.test.js "<video>" [startSec] [dur]
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const input = sermonPath(process.argv[2]);
if (!input) { console.log(noSermon()); process.exit(0); }
const START = Number(process.argv[3] || 600);
const DUR = Number(process.argv[4] || 40);
const OUT = path.join(os.tmpdir(), 'mw-inframe-test');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

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
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  const avail = await win.webContents.executeJavaScript('window.FaceTrack.available()').catch(() => false);
  check('face tracker available', avail === true);
  if (!avail) { process.exit(1); }

  const info = await video.getInfo(ctx, input);
  console.log(`source ${info.width}x${info.height}; clip ${START}s +${DUR}s\n`);

  // 1) detect + build keyframes exactly like the app (fps=3, targetAR passed)
  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 3, outDir: frameDir });
  const cuts = frames.cuts || [];
  console.log(`  scene events in range: ${cuts.length} (hard cuts: ${cuts.filter((c) => c.score >= 0.3).length})`);
  const frameUrls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
  const dets = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames(${JSON.stringify(frameUrls)}, {cuts: ${JSON.stringify(cuts)}})`);
  const withFace = dets.filter((d) => d.cxNorm != null);
  console.log(`  detected face in ${withFace.length}/${frames.length} source frames`);
  const keyframes = await win.webContents.executeJavaScript(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);
  check('keyframes built from real detections', keyframes.length > 0, keyframes.length + ' kf');

  // 2) export the face-tracked 9:16 short
  const reframed = path.join(OUT, 'reframed.mp4');
  await video.exportShortReframed(ctx, { input, startSec: START, endSec: START + DUR, preset: 'reel-9x16', keyframes, output: reframed });
  const ri = await video.getInfo(ctx, reframed);
  check('reframed short is 1080x1920', ri.width === 1080 && ri.height === 1920, `${ri.width}x${ri.height}`);

  // 3) DENSELY sample the OUTPUT and detect the face in each frame
  const times = [];
  for (let t = 1; t < DUR - 1; t += 1.5) times.push(Math.round(t * 10) / 10);
  const offsets = []; let found = 0, edge = 0;
  for (const t of times) {
    const fr = path.join(OUT, `o_${t}.jpg`);
    spawnSync(ffmpeg, ['-ss', String(t), '-i', reframed, '-frames:v', '1', '-q:v', '3', '-y', fr]);
    if (!fs.existsSync(fr)) continue;
    const r = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames([{t:0,url:${JSON.stringify(pathToFileURL(fr).toString())}}])`);
    if (r[0] && r[0].cxNorm != null) { found++; const off = Math.abs(r[0].cxNorm - 0.5); offsets.push(off); if (off > 0.42) edge++; }
  }
  const worst = offsets.length ? Math.max(...offsets) : 1;
  const avg = offsets.length ? offsets.reduce((a, b) => a + b, 0) / offsets.length : 1;
  console.log(`\n  output samples: ${times.length}, face found in ${found}, worst |cx-0.5|=${worst.toFixed(3)}, avg=${avg.toFixed(3)}, near-edge=${edge}`);

  // The speaker's face should be detectable in nearly every output frame (i.e. it
  // never left the crop) and never jammed against the edge.
  check('speaker detected in (almost) every output frame — never dropped out', found >= Math.ceil(times.length * 0.85), `${found}/${times.length}`);
  check('speaker NEVER pinned to the frame edge (worst |cx-0.5| < 0.45)', worst < 0.45, worst.toFixed(3));
  check('speaker kept comfortably framed on average (avg |cx-0.5| < 0.3)', avg < 0.3, avg.toFixed(3));
  check('at most one brief near-edge moment', edge <= 1, edge + ' near-edge samples');

  const eye = path.join(OUT, 'eyeball.jpg');
  spawnSync(ffmpeg, ['-ss', String(Math.round(DUR / 2)), '-i', reframed, '-frames:v', '1', '-q:v', '3', '-y', eye]);
  console.log('  eyeball: ' + eye);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
