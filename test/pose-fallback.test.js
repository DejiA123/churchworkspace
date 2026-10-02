'use strict';
/*
 * POSE + FACE fusion tracking on a real sermon: proves (a) the pose model loads
 * offline via mwasset://, (b) pose runs alongside the face detector and tracks
 * the SAME person (head positions agree), (c) fused coverage is never worse than
 * face-only — pose fills the frames the face misses (turned away / bowed head).
 * Usage: npx electron test/pose-fallback.test.js "<video>" [startSec] [dur]
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
const input = process.argv[2] || 'C:/Users/dejia/Videos/Sacrificial Giving _ Dr. David Richman.mp4';
const START = Number(process.argv[3] || 900);
const DUR = Number(process.argv[4] || 50);
const OUT = path.join(os.tmpdir(), 'mw-pose-test');
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

  check('face tracker available', (await win.webContents.executeJavaScript('window.FaceTrack.available()').catch(() => false)) === true);
  const poseOk = await win.webContents.executeJavaScript('window.FaceTrack.poseAvailable()').catch(() => false);
  check('POSE tracker loaded offline (mwasset://pose_landmarker_lite.task)', poseOk === true);
  if (!poseOk) { app.exit(1); return; }

  const info = await video.getInfo(ctx, input);
  console.log(`source ${info.width}x${info.height}; clip ${START}s +${DUR}s\n`);
  const frameDir = path.join(OUT, 'frames');
  const frames = await video.extractFrames(ctx, { input, startSec: START, endSec: START + DUR, fps: 3, outDir: frameDir });
  const frameUrls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
  const t0 = Date.now();
  const dets = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames(${JSON.stringify(frameUrls)})`);
  const secs = (Date.now() - t0) / 1000;

  const faceN = dets.filter((d) => d.src === 'face').length;
  const rescued = dets.filter((d) => d.src === 'pose' && d.cxNorm != null);
  const guarded = dets.filter((d) => d.guarded).length;
  const covered = dets.filter((d) => d.cxNorm != null).length;
  const poseSeen = dets.filter((d) => d.poseCx != null).length;
  const both = dets.filter((d) => d.src === 'face' && d.poseCx != null);
  const mad = both.length ? both.reduce((a, d) => a + Math.abs(d.cxNorm - d.poseCx), 0) / both.length : 1;
  console.log(`  frames ${frames.length}: face-led ${faceN}, pose-rescued ${rescued.length} (guard rejected ${guarded}), covered ${covered}, pose found on ${poseSeen}; face-vs-pose mean Δcx=${mad.toFixed(3)} (${secs.toFixed(1)}s)\n`);

  check('fused coverage >= face-only coverage (pose can only ADD)', covered >= faceN, `${covered} >= ${faceN}`);
  check('pose detects a person in most frames (runs simultaneously)', poseSeen >= Math.floor(frames.length * 0.7), `${poseSeen}/${frames.length}`);

  // THE GUARD INVARIANT — pose that latched onto someone else in a wide church
  // shot must not feed the camera.
  //
  // This used to be checked as "every accepted pose position agrees with the
  // nearest face anchor", which assumed the face anchor is trustworthy. On stage
  // backdrops it is not: printed art detects as confident faces, and measured on
  // THIS clip at t=6.38 the speaker is plainly at cx~0.95 (pose said 0.953 —
  // right) while the nearest face anchor sat at 0.523 on empty purple backdrop —
  // wrong. The old assertion therefore FAILED the correct behaviour, and the
  // assumption behind it is exactly what put the exported crop on wallpaper for
  // 18 seconds. detectFrames now vets pose against a corroborated rolling median
  // instead (`poseSure`), so the invariant is split:
  //   - frames that went through the LEGACY fusion path must still agree with a face;
  //   - body-vetted frames must instead be temporally CONTINUOUS — a latch onto a
  //     different person shows up as a teleport, which is what we actually fear.
  const facesOnly = dets.filter((d) => d.src === 'face');
  const nearestFace = (t) => facesOnly.reduce((m, f) => (Math.abs(f.t - t) < Math.abs(m.t - t) ? f : m), facesOnly[0] || { t: -1e9, cxNorm: 0.5 });
  const legacy = rescued.filter((d) => !d.poseSure);
  const allGuarded = legacy.every((d) => { const f = nearestFace(d.t); return Math.abs(f.t - d.t) > 4.5 || Math.abs(d.cxNorm - f.cxNorm) <= 0.22; });
  check('legacy-fusion pose positions still agree with the face track (guard holds)', allGuarded, `${legacy.length} legacy of ${rescued.length} accepted, ${guarded} rejected`);
  const vetted = rescued.filter((d) => d.poseSure).sort((a, b) => a.t - b.t);
  let teleports = 0;
  for (let i = 1; i < vetted.length; i++) {
    if (vetted[i].t - vetted[i - 1].t <= 0.5 && Math.abs(vetted[i].cxNorm - vetted[i - 1].cxNorm) > 0.25) teleports++;
  }
  check('body-vetted pose track is continuous (never teleports onto another person)', teleports === 0, `${teleports} teleports across ${vetted.length} vetted frames`);
  const plausible = rescued.every((d) => d.cxNorm > 0.03 && d.cxNorm < 0.97);
  check('accepted pose positions are plausible in-frame positions', plausible, rescued.length + ' accepted');

  // keyframes still build cleanly from the fused stream
  const kf = await win.webContents.executeJavaScript(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${info.width}, ${info.height}, {targetAR: 9/16})`);
  check('virtual camera builds from the fused face+pose stream', Array.isArray(kf) && kf.length > 0, kf.length + ' kf');

  try { fs.rmSync(frameDir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
