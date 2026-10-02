'use strict';
/*
 * WHERE A SHORTS EXPORT'S TIME GOES.
 *
 * "Export all" is, per short: sample stills -> run two neural nets over every
 * still -> build the camera path -> encode -> text/captions -> music/outro.
 * diag-main-encode.js covered the encode; this covers the half that happens
 * BEFORE it, in the renderer, which no Node-only diagnostic can see.
 *
 * Run: electron test/diag-shorts-export.js ["<video>"] [startSec] [durSec]
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
const DUR = Number(process.argv[4] || 90);          // a typical auto-length short
const OUT = path.join(os.tmpdir(), 'mw-shorts-diag');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

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
  if (!(await js('window.FaceTrack.available()').catch(() => false))) { console.log('  no face tracker'); app.quit(); return; }

  const info = await video.getInfo(ctx, input);
  console.log(`\n  source ${info.width}x${info.height} ${info.fps}fps   clip ${START}s +${DUR}s\n`);

  /* ---------------- 1) sample the stills, exactly as the app does ------------- */
  /*
   * extractFrames runs TWO ffmpeg passes at once (the stills, and the scene-cut
   * scan) and returns when the slower finishes, so the wall time alone does not
   * say which one to attack. Time each on its own first.
   */
  const frameDir = path.join(OUT, 'frames');
  let t0 = Date.now();
  const frames = await video.extractFrames(ctx, {
    input, startSec: START, endSec: START + DUR, fps: 6, outDir: frameDir, pairs: true });
  const tExtract = Date.now() - t0;
  const jpgs = fs.readdirSync(frameDir).length;
  console.log(`  [1] sample the stills        ${secs(tExtract).padStart(8)}   ${frames.length} samples, ${jpgs} jpegs on disk`);
  {
    // The scene scan is exported, so it can be timed on its own. If it accounts
    // for nearly all of stage 1, it IS stage 1 and the stills are free.
    const a = Date.now();
    const sc = await video.detectSceneCuts(ctx, { input, startSec: START, dur: DUR });
    const tCuts = Date.now() - a;
    console.log(`  [1a]   ...the scene scan alone ${secs(tCuts).padStart(6)}   ${sc.length} events`
      + `   = ${(tCuts / tExtract * 100).toFixed(0)}% of stage 1`
      + (tCuts > tExtract * 0.8 ? '  <-- stage 1 IS the scene scan' : ''));
  }

  const urls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : undefined }));
  const cuts = frames.cuts || [];

  /* ---------------- 2) the neural nets over every still ---------------------- */
  t0 = Date.now();
  const dets = await js(`window.FaceTrack.detectFrames(${JSON.stringify(urls)}, {cuts: ${JSON.stringify(cuts)}})`);
  const tDetect = Date.now() - t0;
  const found = dets.filter((d) => d.cxNorm != null).length;
  console.log(`  [2] watch them (2 neural nets) ${secs(tDetect).padStart(6)}   speaker found in ${found}/${frames.length}`
    + `   = ${(tDetect / frames.length).toFixed(0)} ms/sample`);

  /* ---- 2a) how much of that is just GETTING THE PICTURES OFF THE DISK? ---- */
  const loadJs = (list, ahead) => `(async () => {
    const load = (u) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
    const urls = ${JSON.stringify(list)};
    const t = performance.now();
    if (${ahead} <= 1) { for (const u of urls) { const im = await load(u); if (im) im.src = ''; } }
    else {
      const q = []; let i = 0;
      while (i < Math.min(${ahead}, urls.length)) q.push(load(urls[i++]));
      while (q.length) { const im = await q.shift(); if (im) im.src = ''; if (i < urls.length) q.push(load(urls[i++])); }
    }
    return performance.now() - t;
  })()`;
  const all = urls.flatMap((u) => [u.url, ...(u.pairUrl ? [u.pairUrl] : [])]);
  // PARALLEL FIRST, ON PURPOSE. Run serial first and it warms the OS page cache
  // for the parallel run, which then "wins" 60x by reading from memory. Giving
  // the cache advantage to the one being argued AGAINST is the only honest order.
  const tAhead = await js(loadJs(all, 4));
  const tSerial = await js(loadJs(all, 1));
  console.log(`  [2a]   ...decoding the jpegs  ${secs(tSerial).padStart(8)}   one at a time (what it does now)`);
  console.log(`  [2b]   ...with 4 in flight    ${secs(tAhead).padStart(8)}   ${(tSerial / Math.max(1, tAhead)).toFixed(1)}x faster`
    + `   -> ${((tSerial - tAhead) / tDetect * 100).toFixed(0)}% of tracking is waiting on disk`);

  /* ---- 2c) and how much is reading pixels back off the canvas? ---- */
  const tPix = await js(`(async () => {
    const load = (u) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = u; });
    const c = document.createElement('canvas'); const x = c.getContext('2d', { willReadFrequently: true });
    const urls = ${JSON.stringify(all.slice(0, Math.min(120, all.length)))};
    const imgs = []; for (const u of urls) imgs.push(await load(u));
    const t = performance.now();
    for (const im of imgs) { if (!im) continue;
      const w = Math.min(320, im.naturalWidth), h = Math.round(im.naturalHeight * (w / im.naturalWidth));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      x.drawImage(im, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data;
      const g = new Uint8Array(w * h);
      for (let i = 0, p = 0; p < g.length; p++, i += 4) g[p] = (d[i] * 77 + d[i+1] * 150 + d[i+2] * 29) >> 8;
    }
    return (performance.now() - t) / imgs.length;
  })()`);
  console.log(`  [2c]   ...pixel readback      ${(tPix).toFixed(1)} ms/jpeg  = ${secs(tPix * all.length).trim()} over the clip`);

  t0 = Date.now();
  const keyframes = await js(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);
  const tKf = Date.now() - t0;
  console.log(`  [3] build the camera path    ${secs(tKf).padStart(8)}   ${keyframes.length} keyframes`);

  /* ---------------- 4) the encode ------------------------------------------- */
  const outFile = path.join(OUT, 'short.mp4');
  t0 = Date.now();
  await video.exportShortReframed(ctx, { input, startSec: START, endSec: START + DUR,
    preset: 'reel-9x16', quality: '1080p', keyframes, output: outFile });
  const tEnc = Date.now() - t0;
  console.log(`  [4] encode the short         ${secs(tEnc).padStart(8)}   ${(fs.statSync(outFile).size / 1048576).toFixed(1)} MB`);

  const total = tExtract + tDetect + tKf + tEnc;
  console.log(`\n  ONE SHORT: ${secs(total)}  (${(total / (DUR * 1000)).toFixed(2)}x real time)`);
  console.log(`     before the encode: ${secs(tExtract + tDetect + tKf)}  (${((tExtract + tDetect + tKf) / total * 100).toFixed(0)}%)`);
  console.log(`     the encode itself: ${secs(tEnc)}  (${(tEnc / total * 100).toFixed(0)}%)`);
  console.log(`\n  A BATCH OF 10 runs these strictly one after another: ${secs(total * 10)}.`);
  console.log(`  Tracking is the processor + the models; the encode is the GPU's video engine.`);
  console.log(`  Overlapping them would hide the smaller of the two: ~${secs(Math.min(tExtract + tDetect + tKf, tEnc) * 9)} of the batch.\n`);
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
