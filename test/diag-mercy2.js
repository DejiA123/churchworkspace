'use strict';
/*
 * DIAGNOSTIC: scan windows across a whole sermon with the REAL tracking pipeline
 * (extractFrames -> FaceTrack.detectFrames -> buildKeyframes {targetAR:9/16}),
 * then check — for every detected sample — whether the speaker would be inside
 * the 9:16 crop the export would produce. Reports the worst windows + keeps
 * their frames on disk for eyeballing. Usage:
 *   npx electron test/diag-mercy2.js "<video>" [numWindows] [winDur]
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
const NWIN = Number(process.argv[3] || 20);
const WDUR = Number(process.argv[4] || 36);
const FPS = 2;
const OUT = path.join(os.tmpdir(), 'mw-diag-mercy2');
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
  const poseOk = await win.webContents.executeJavaScript('window.FaceTrack.poseAvailable()').catch(() => false);
  console.log(`tracker available=${avail} pose=${poseOk}`);
  if (!avail) { app.exit(1); return; }

  const info = await video.getInfo(ctx, input);
  const W = info.width, H = info.height, DUR = info.durationSec;
  const targetAR = 9 / 16;
  const cropW = Math.round(H * targetAR / 2) * 2; // same math as exportShortReframed
  console.log(`source ${W}x${H} dur=${Math.round(DUR)}s cropW=${cropW}px (${(cropW / W * 100).toFixed(1)}% of width)\n`);

  // evenly spread windows, skipping the first/last minute
  const usable = DUR - 120 - WDUR;
  const report = [];
  for (let wi = 0; wi < NWIN; wi++) {
    const start = Math.round(60 + (wi * usable) / (NWIN - 1));
    const frameDir = path.join(OUT, `w${String(wi).padStart(2, '0')}_${start}`);
    let frames;
    try {
      const existing = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /^f_\d+\.jpg$/.test(f)).sort() : [];
      if (existing.length >= WDUR * FPS - 2) { // reuse a previous extraction
        frames = existing.map((f, i) => ({ t: (i + 0.5) / FPS, path: path.join(frameDir, f) }));
        frames.cuts = await video.detectSceneCuts(ctx, { input, startSec: start, dur: WDUR });
      } else {
        frames = await video.extractFrames(ctx, { input, startSec: start, endSec: start + WDUR, fps: FPS, outDir: frameDir });
      }
    } catch (e) { console.log(`w${wi} @${start}s EXTRACT FAIL ${e.message}`); continue; }
    const cuts = frames.cuts || [];
    const frameUrls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
    const dets = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames(${JSON.stringify(frameUrls)}, {cuts: ${JSON.stringify(cuts)}})`);
    const kf = await win.webContents.executeJavaScript(`window.FaceTrack.buildKeyframes(${JSON.stringify(dets)}, ${W}, ${H}, {targetAR: 9/16, cuts: ${JSON.stringify(cuts)}})`);

    // camera x at time t (lerp over kf, matching buildLerpExpr)
    const camAt = (t) => {
      if (!kf.length) return W / 2;
      if (t <= kf[0].t) return kf[0].x;
      for (let i = 1; i < kf.length; i++) {
        if (t <= kf[i].t) {
          const a = kf[i - 1], b = kf[i];
          return a.x + (b.x - a.x) * ((t - a.t) / Math.max(1e-3, b.t - a.t));
        }
      }
      return kf[kf.length - 1].x;
    };

    // per-sample framing check against the tracker's own accepted detections.
    // Samples within 0.6s of a scene event are transition frames (motion blur,
    // mid-cut) — framing is undefined there, skip grading them. A detection that
    // disagrees with its own ±1.5s neighbourhood median is a one-frame phantom
    // (e.g. a face "found" in the wallpaper) — the pipeline prunes those, so
    // grading the camera against them would be measuring a ghost.
    const nearCut = (t) => cuts.some((c) => c.score >= 0.14 && Math.abs(c.t - t) < 0.6);
    const valid = dets.filter((x) => x.cxNorm != null);
    const isPhantom = (d) => { // one-frame blip: BOTH immediate neighbours disagree with it
      const i = valid.indexOf(d);
      const p = valid[i - 1], n = valid[i + 1];
      if (!p || !n) return false;
      return Math.abs(d.cxNorm - p.cxNorm) > 0.12 && Math.abs(d.cxNorm - n.cxNorm) > 0.12;
    };
    let faceN = 0, poseN = 0, guardedN = 0, missN = 0, out05 = 0, out042 = 0, skippedN = 0;
    let worstOff = 0, worstT = -1, jumps = 0, missStreak = 0, worstMissStreak = 0;
    let prevCx = null;
    const offenders = [];
    for (const d of dets) {
      if (nearCut(d.t)) { skippedN++; continue; }
      if (d.cxNorm != null && isPhantom(d)) { skippedN++; continue; }
      if (d.guarded) guardedN++;
      if (d.cxNorm == null) { missN++; missStreak++; worstMissStreak = Math.max(worstMissStreak, missStreak); continue; }
      missStreak = 0;
      if (d.src === 'face') faceN++; else if (d.src === 'pose') poseN++;
      if (prevCx != null && Math.abs(d.cxNorm - prevCx) > 0.25) jumps++;
      prevCx = d.cxNorm;
      const off = Math.abs(d.cxNorm * W - camAt(d.t)) / cropW; // 0.5 = at crop edge
      if (off > worstOff) { worstOff = off; worstT = d.t; }
      if (off > 0.5) { out05++; offenders.push({ t: d.t, cx: d.cxNorm, src: d.src, off: Number(off.toFixed(3)) }); }
      else if (off > 0.42) out042++;
    }
    // CAMERA WILDNESS: a camera that swings left-right (following flip-flopping
    // detections) can grade fine on "offset vs detections" while looking insane.
    // Measure the camera PATH itself: total travel, direction reversals (turn-
    // arounds of ≥3.5% of the frame), max sustained speed — and how often the
    // detections themselves flip A→B→A by >0.15 (tracker jumping between two
    // subjects/phantoms). Boundary snaps are EXPECTED jumps; count them apart.
    let travel = 0, reversals = 0, maxSpd = 0, snapN = 0;
    {
      let dir = 0, legStart = kf.length ? kf[0].x : 0;
      for (let i = 1; i < kf.length; i++) {
        const dx = kf[i].x - kf[i - 1].x, dt = kf[i].t - kf[i - 1].t;
        travel += Math.abs(dx) / W;
        if (dt < 0.05) { snapN++; legStart = kf[i].x; dir = 0; continue; } // boundary snap
        if (dt > 0) maxSpd = Math.max(maxSpd, Math.abs(dx) / W / dt);
        const d = Math.sign(dx);
        if (d !== 0 && dir !== 0 && d !== dir && Math.abs(kf[i - 1].x - legStart) > 0.035 * W) { reversals++; legStart = kf[i - 1].x; }
        if (d !== 0) dir = d;
      }
    }
    let flipflops = 0;
    {
      const v = dets.filter((d) => d.cxNorm != null);
      for (let i = 2; i < v.length; i++) {
        const a = v[i - 2].cxNorm, b = v[i - 1].cxNorm, c = v[i].cxNorm;
        if (Math.abs(b - a) > 0.15 && Math.abs(c - b) > 0.15 && Math.abs(c - a) < 0.08) flipflops++;
      }
    }
    const rec = {
      wi, start, frames: frames.length, faceN, poseN, guardedN, missN, worstMissStreak,
      jumps, out05, out042, worstOff: Number(worstOff.toFixed(3)), worstT: Number((worstT).toFixed(1)),
      travel: Number(travel.toFixed(3)), reversals, maxSpd: Number(maxSpd.toFixed(3)), snaps: snapN, flipflops,
      offenders: offenders.slice(0, 6), frameDir,
    };
    report.push(rec);
    console.log(`w${String(wi).padStart(2, '0')} @${String(start).padStart(4)}s  face=${faceN} pose=${poseN} miss=${missN} jumps=${jumps}  OUT:${out05} worst=${worstOff.toFixed(3)}  | travel=${travel.toFixed(2)} rev=${reversals} spd=${maxSpd.toFixed(2)} snaps=${snapN} flip=${flipflops}`);
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ W, H, cropW, windows: report }, null, 2));
  const bad = report.filter((r) => r.out05 > 0 || r.worstOff > 0.45 || r.missN > r.frames * 0.35);
  // True CHASE signals only — an energetic preacher legitimately paces (sustained
  // moves the camera MUST follow), so raw travel/reversal counts alone don't
  // condemn: detection flip-flops, whip-speed pans outside snaps, or extreme travel do.
  const wild = report.filter((r) => r.flipflops > 0 || r.maxSpd > 0.45 || r.travel > 2.2);
  console.log(`\n${bad.length}/${report.length} windows have out-of-frame or heavy-miss problems`);
  for (const b of bad) console.log(`  BAD w${b.wi} @${b.start}s out05=${b.out05} worst=${b.worstOff} miss=${b.missN} dir=${b.frameDir}`);
  console.log(`${wild.length}/${report.length} windows look WILD (reversals>=3 or travel>0.9 or flipflops)`);
  for (const b of wild) console.log(`  WILD w${b.wi} @${b.start}s travel=${b.travel} rev=${b.reversals} spd=${b.maxSpd} snaps=${b.snaps} flip=${b.flipflops} dir=${b.frameDir}`);
  console.log('report: ' + path.join(OUT, 'report.json'));
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
