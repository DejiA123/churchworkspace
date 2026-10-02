'use strict';
/*
 * TRACKING IS 90 s OF A 292 s SHORT, AND 94% OF IT IS TWO NEURAL NETS.
 *
 * MediaPipe is being created with no `delegate`, which on the web means CPU.
 * The machine has a GPU and the app already uses it for everything else. But a
 * different delegate is a different numerical path, and this tracker's framing
 * has been fought for — so the question is not "is GPU faster", it is:
 *
 *    is it faster AND does it see the same thing?
 *
 * This runs both delegates over the SAME stills and prints the time and the
 * disagreement. Run: electron test/diag-track-delegate.js ["<video>"] [start] [dur]
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
const DUR = Number(process.argv[4] || 30);
const OUT = path.join(os.tmpdir(), 'mw-track-delegate');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

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

  const csp = "default-src 'self'; img-src 'self' data: file: blob:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  const js = (s) => win.webContents.executeJavaScript(s);

  console.log(`\n  gpu backend: ${JSON.stringify((await js('({v: (document.createElement("canvas").getContext("webgl2") ? "webgl2 ok" : "NO webgl2")})')).v)}`);

  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 6, outDir: frameDir });
  const urls = frames.map((f) => pathToFileURL(f.path).toString());
  console.log(`  ${urls.length} stills from ${DUR}s of ${path.basename(input)}\n`);

  const script = (delegate) => `(async () => {
    const mp = await import('mwasset://vision_bundle.mjs');
    const vision = await mp.FilesetResolver.forVisionTasks('mwasset://wasm');
    const base = (f) => ({ modelAssetPath: 'mwasset://' + f${delegate ? ", delegate: '" + delegate + "'" : ''} });
    let det, pose, initErr = null;
    try {
      det = await mp.FaceDetector.createFromOptions(vision, { baseOptions: base('blaze_face_short_range.tflite'), runningMode: 'IMAGE', minDetectionConfidence: 0.2 });
      pose = await mp.PoseLandmarker.createFromOptions(vision, { baseOptions: base('pose_landmarker_lite.task'), runningMode: 'IMAGE', numPoses: 4, minPoseDetectionConfidence: 0.3 });
    } catch (e) { return { error: String(e && e.message || e) }; }
    const load = (u) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = u; });
    const urls = ${JSON.stringify(urls)};
    const imgs = []; for (const u of urls) imgs.push(await load(u));
    // one warm-up so the first frame's shader compile is not counted as detection
    if (imgs[0]) { try { det.detect(imgs[0]); pose.detect(imgs[0]); } catch (e) {} }
    const out = []; let tFace = 0, tPose = 0;
    for (const im of imgs) {
      if (!im) { out.push(null); continue; }
      let a = performance.now();
      let r = null; try { r = det.detect(im); } catch (e) {}
      tFace += performance.now() - a;
      a = performance.now();
      let p = null; try { p = pose.detect(im); } catch (e) {}
      tPose += performance.now() - a;
      const w = im.naturalWidth || 1, h = im.naturalHeight || 1;
      const faces = ((r && r.detections) || []).map((d) => ({
        cx: +(((d.boundingBox.originX + d.boundingBox.width / 2) / w).toFixed(5)),
        cy: +(((d.boundingBox.originY + d.boundingBox.height / 2) / h).toFixed(5)),
        bw: +((d.boundingBox.width / w).toFixed(5)),
        s: +(((d.categories && d.categories[0] ? d.categories[0].score : 0)).toFixed(4)),
      }));
      const noses = ((p && p.landmarks) || []).map((lm) => lm && lm[0] ? { x: +lm[0].x.toFixed(5), y: +lm[0].y.toFixed(5) } : null);
      out.push({ faces, noses });
    }
    try { det.close(); pose.close(); } catch (e) {}
    return { out, tFace, tPose };
  })()`;

  console.log('  running the two models over every still, once per delegate…\n');
  const cpu = await js(script(null));
  if (cpu.error) { console.log('  CPU delegate failed: ' + cpu.error); app.quit(); return; }
  const gpu = await js(script('GPU'));

  const ms = (v) => (v / 1000).toFixed(1) + 's';
  console.log(`   ${'delegate'.padEnd(10)} ${'face net'.padStart(9)} ${'pose net'.padStart(9)} ${'both'.padStart(9)}   per still`);
  console.log(`   ${'CPU (now)'.padEnd(10)} ${ms(cpu.tFace).padStart(9)} ${ms(cpu.tPose).padStart(9)} ${ms(cpu.tFace + cpu.tPose).padStart(9)}   ${((cpu.tFace + cpu.tPose) / urls.length).toFixed(0)} ms`);
  if (gpu.error) { console.log(`   ${'GPU'.padEnd(10)}   FAILED: ${gpu.error}`); app.quit(); return; }
  console.log(`   ${'GPU'.padEnd(10)} ${ms(gpu.tFace).padStart(9)} ${ms(gpu.tPose).padStart(9)} ${ms(gpu.tFace + gpu.tPose).padStart(9)}   ${((gpu.tFace + gpu.tPose) / urls.length).toFixed(0)} ms`
    + `   ${((cpu.tFace + cpu.tPose) / (gpu.tFace + gpu.tPose)).toFixed(2)}x`);

  /* ---- and do they SEE the same thing? ---- */
  let nBoth = 0, nOnlyCpu = 0, nOnlyGpu = 0, dSum = 0, dMax = 0, nCmp = 0;
  let poseBoth = 0, poseOnlyCpu = 0, poseOnlyGpu = 0, pdSum = 0, pdMax = 0, nP = 0;
  for (let i = 0; i < cpu.out.length; i++) {
    const a = cpu.out[i], b = gpu.out[i];
    if (!a || !b) continue;
    const af = a.faces.length, bf = b.faces.length;
    if (af && bf) { nBoth++;
      // biggest face each side — that is the one the tracker cares about
      const pick = (l) => l.slice().sort((p, q) => q.bw - p.bw)[0];
      const p = pick(a.faces), q = pick(b.faces);
      const d = Math.hypot(p.cx - q.cx, p.cy - q.cy);
      dSum += d; dMax = Math.max(dMax, d); nCmp++;
    } else if (af) nOnlyCpu++; else if (bf) nOnlyGpu++;
    const an = a.noses.filter(Boolean), bn = b.noses.filter(Boolean);
    if (an.length && bn.length) { poseBoth++;
      const d = Math.hypot(an[0].x - bn[0].x, an[0].y - bn[0].y);
      pdSum += d; pdMax = Math.max(pdMax, d); nP++;
    } else if (an.length) poseOnlyCpu++; else if (bn.length) poseOnlyGpu++;
  }
  console.log('\n  DO THEY SEE THE SAME THING?  (positions are fractions of the frame width)');
  console.log(`   face:  both found ${nBoth}   CPU only ${nOnlyCpu}   GPU only ${nOnlyGpu}`
    + (nCmp ? `   mean apart ${(dSum / nCmp).toFixed(4)}  worst ${dMax.toFixed(4)}` : ''));
  console.log(`   pose:  both found ${poseBoth}   CPU only ${poseOnlyCpu}   GPU only ${poseOnlyGpu}`
    + (nP ? `   mean apart ${(pdSum / nP).toFixed(4)}  worst ${pdMax.toFixed(4)}` : ''));
  console.log('\n  A crop window is ~0.32 of the frame wide on this footage, so a disagreement');
  console.log('  of 0.01 is 3% of the window — invisible. One of 0.10 is a third of it.');
  console.log('  What would rule GPU out is FINDING FEWER FRAMES, not tiny position noise.\n');
  app.quit();
}).catch((e) => { console.error(e); app.quit(); });
