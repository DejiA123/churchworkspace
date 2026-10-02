'use strict';
/*
 * 🧠 THE AI REFEREE ON REAL FOOTAGE — this PC alone vs. this PC + the AI.
 *
 * Runs the real tracker (the real face + body models) over a window of a real
 * recording ONCE, then decides who to follow twice from the same signals:
 * once as the PC always has, once with the cloud referee asked (real
 * cloudsee.js, the operator's own key from %APPDATA%). Writes, to
 * %TEMP%/mw-reframe-ai/:
 *
 *   grid_N.jpg     exactly what the AI was shown
 *   compare.jpg    a contact sheet: each sampled moment with BOTH crops drawn
 *                  on it — red = this PC alone, green = with the AI
 *   result.json    per-frame positions, who was followed, the AI's report
 *
 * The contact sheet is the evidence. On this footage a statistic is a
 * hypothesis (see the reframe memory) — look at the pictures.
 *
 *   npx electron test/diag-reframe-ai.js "<video>" <startSec> <durSec>
 */
const { app, BrowserWindow, protocol, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const cloudwrite = require('../src/main/cloudwrite');
const cloudsee = require('../src/main/cloudsee');

const ctx = { ffmpeg, ffprobe };
const argv = process.argv.slice(2).filter((a) => !/electron|diag-reframe-ai/i.test(path.basename(a)));
const input = argv[0] || 'C:/Users/dejia/Downloads/Time of Prayers _ Bishop David Richman.mp4';
const startSec = parseFloat(argv[1] || '6570');
const durSec = parseFloat(argv[2] || '60');
const OUT = path.join(os.tmpdir(), 'mw-reframe-ai', String(Math.round(startSec)));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');

// the operator's own key, exactly as the app would find it
try {
  const s = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'Church Work Space', 'workstation.json'), 'utf8')).settings || {};
  const lc = (s.listen && s.listen.cloud) || {};
  cloudwrite.shareKey(lc.provider || 'groq', lc.key || '');
  cloudwrite.configure(Object.assign({ on: true, provider: 'groq' }, (s.social && s.social.cloud) || {}));
} catch (e) { console.log('no settings: ' + e.message); }

protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + ((e && e.stack) || e)); process.exit(1); });

let grids = 0;
ipcMain.handle('referee', async (_e, a) => {
  const n = ++grids;
  try { fs.writeFileSync(path.join(OUT, `grid_${n}.jpg`), Buffer.from(a.image.split(',')[1], 'base64')); } catch (e) {}
  const t = Date.now();
  const r = await cloudsee.whoIsSpeaking({ image: a.image, frames: a.frames, columns: a.columns });
  console.log(`  grid ${n}: ${a.frames.length} frames (t=${a.t.map((x) => x.toFixed(1)).join(', ')}) -> ${r.ok ? JSON.stringify(r.answers) + ' ' + r.model : 'FAILED ' + r.why} in ${Date.now() - t} ms`);
  return r;
});

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
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; media-src 'self' file: blob: data:; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const html = path.join(OUT, 'harness.html');
  fs.writeFileSync(html, '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"></head>'
    + '<body><script src="' + pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString() + '"></script></body></html>');
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2 && !/OpenGL|XNNPACK|feedback|NORM_RECT|GPU stall|Autofill/i.test(msg)) console.log('  [renderer] ' + msg); });
  await win.loadFile(html);
  await new Promise((r) => setTimeout(r, 400));
  const js = (code) => win.webContents.executeJavaScript(code);
  if (!(await js('window.FaceTrack.available()'))) { console.log('models did not load'); process.exit(1); }

  const info = await video.getInfo(ctx, input);
  const dir = path.join(OUT, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString(), pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null }));
  await js('window.__frames = ' + JSON.stringify(payload) + '; window.__cuts = ' + JSON.stringify(frames.cuts || []) + '; 1');
  console.log(`${path.basename(input)}  ${startSec}s +${durSec}s: ${payload.length} frames, ${(frames.cuts || []).length} scene events`);

  const t0 = Date.now();
  const res = await js(`(async () => {
    const W = ${info.width}, H = ${info.height};
    // BEFORE = the tracker as shipped in v2.79: no referee, and blips followed
    const pcOnly = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts, blips: false });
    const tPc = performance.now();
    const ref = async (a) => require('electron').ipcRenderer.invoke('referee', { image: a.image, frames: a.frames, columns: a.columns, t: a.t });
    const withAi = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts, signals: pcOnly.signals, referee: ref });
    const aiMs = performance.now() - tPc;
    const kf = (d) => window.FaceTrack.buildKeyframes(d, W, H, { targetAR: 9 / 16, cuts: window.__cuts });
    const camAt = (k, t) => { if (!k.length) return W / 2; if (t <= k[0].t) return k[0].x; for (let i = 0; i < k.length - 1; i++) if (t < k[i + 1].t) { const p = (t - k[i].t) / (k[i + 1].t - k[i].t); return k[i].x + (k[i + 1].x - k[i].x) * p; } return k[k.length - 1].x; };
    const kPc = kf(pcOnly), kAi = kf(withAi);
    // How the crop MOVES, sampled at 30 fps, in crop widths (a 9:16 crop of a
    // 16:9 frame is 0.316 of it): direction changes, speed, and the hardest
    // change of speed — the three things a viewer reads as "jerky".
    const cropW = (9 / 16) / (W / H);
    const smooth = (k) => {
      const t0 = window.__frames[0].t, t1 = window.__frames[window.__frames.length - 1].t;
      const xs = [];
      for (let t = t0; t <= t1; t += 1 / 30) xs.push(camAt(k, t) / W / cropW);
      const v = xs.slice(1).map((x, i) => (x - xs[i]) * 30);
      let rev = 0, dir = 0;
      for (const s of v) { if (Math.abs(s) < 0.02) continue; const d = Math.sign(s); if (dir && d !== dir) rev++; dir = d; }
      const sp = v.map(Math.abs).sort((a, b) => a - b);
      const acc = v.slice(1).map((s, i) => Math.abs(s - v[i]) * 30).sort((a, b) => a - b);
      const still = v.filter((s) => Math.abs(s) < 0.02).length / Math.max(1, v.length);
      return { reversals: rev, still: +still.toFixed(2), p95speed: +(sp[Math.floor(0.95 * sp.length)] || 0).toFixed(3),
        maxSpeed: +(sp[sp.length - 1] || 0).toFixed(3), p99accel: +(acc[Math.floor(0.99 * acc.length)] || 0).toFixed(2), keyframes: k.length };
    };
    return {
      smooth: { pc: smooth(kPc), ai: smooth(kAi) }, kPc, kAi,
      candPc: pcOnly.subject && pcOnly.subject.people.map((p) => ({ id: p.id, n: p.n, cover: +p.cover.toFixed(2), score: +(p.score||0).toFixed(2), cx: +(p.cx||0).toFixed(2) })),
      candAi: withAi.subject && withAi.subject.people.map((p) => ({ id: p.id, n: p.n, cover: +p.cover.toFixed(2), score: +(p.score||0).toFixed(2), cx: +(p.cx||0).toFixed(2), yes: p.aiYes, no: p.aiNo })),
      aiMs, referee: withAi.referee, whyPc: pcOnly.subject && pcOnly.subject.why, whyAi: withAi.subject && withAi.subject.why,
      rows: window.__frames.map((f, i) => ({ t: f.t, url: f.url, pc: pcOnly[i].cxNorm, ai: withAi[i].cxNorm, bwAi: withAi.signals[i].subject ? +(withAi.signals[i].subject.bw || 0).toFixed(3) : null, srcAi: withAi.signals[i].subject ? withAi.signals[i].subject.src : null, howPc: pcOnly[i].bridged ? "bridged" : pcOnly[i].subject ? "recognised" : pcOnly[i].noSubject ? "held" : (pcOnly[i].src || "-"), whoPc: pcOnly.subject && pcOnly.subject.id, whoAi: withAi.subject && withAi.subject.id, how: [withAi[i].bridged ? "bridged" : withAi[i].refereed ? "column" : withAi[i].subject ? "recognised" : withAi[i].noSubject ? "held" : (withAi[i].src || "-"), withAi.signals[i].vouch ? "VOUCH" : withAi.signals[i].vouchNone ? "NONE" : ""].join(" "),
        camPc: camAt(kPc, f.t) / W, camAi: camAt(kAi, f.t) / W })),
    };
  })()`);
  console.log(`tracking + both decisions: ${((Date.now() - t0) / 1000).toFixed(1)} s (AI part ${(res.aiMs / 1000).toFixed(1)} s)`);
  console.log('before (v2.79):', res.whyPc);
  console.log('now           :', res.whyAi, JSON.stringify(res.referee));
  const differ = res.rows.filter((r) => Math.abs(r.camPc - r.camAi) > 0.08).length;
  console.log(`crop differs by more than 8% of the frame in ${differ} of ${res.rows.length} frames`);
  console.log('smoothness (crop widths; reversals = direction changes, still = share of time held):');
  console.log('  before (v2.79):', JSON.stringify(res.smooth.pc));
  console.log('  now           :', JSON.stringify(res.smooth.ai));
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(Object.assign({}, res, { kPc: undefined, kAi: undefined }), null, 1));

  // the contact sheet: 12 moments, most-different first among an even spread
  const sheet = await js(`(async () => {
    const rows = ${JSON.stringify(res.rows)};
    const ar = ${info.width / info.height}, cw = 9 / 16 / ar;      // crop width as a fraction of the frame
    const pick = [];
    const step = Math.max(1, Math.floor(rows.length / 12));
    for (let i = Math.floor(step / 2); i < rows.length && pick.length < 12; i += step) pick.push(rows[i]);
    const TW = 400, TH = Math.round(TW / ar);
    const c = document.createElement('canvas'); c.width = TW * 3; c.height = TH * 4;
    const g = c.getContext('2d');
    const load = (u) => new Promise((r) => { const im = new Image(); im.onload = () => r(im); im.onerror = () => r(null); im.src = u; });
    for (let k = 0; k < pick.length; k++) {
      const r = pick[k], im = await load(r.url);
      const ox = (k % 3) * TW, oy = Math.floor(k / 3) * TH;
      if (im) g.drawImage(im, ox, oy, TW, TH);
      const box = (cx, col, inset) => { const x0 = Math.max(0, Math.min(1 - cw, cx - cw / 2)); g.strokeStyle = col; g.lineWidth = 4; g.strokeRect(ox + x0 * TW + inset, oy + inset, cw * TW - 2 * inset, TH - 2 * inset); };
      box(r.camPc, '#ff3b30', 3); box(r.camAi, '#34c759', 9);
      g.fillStyle = 'rgba(0,0,0,.7)'; g.fillRect(ox, oy + TH - 22, 150, 22);
      g.fillStyle = '#fff'; g.font = 'bold 14px Arial'; g.fillText('t=' + r.t.toFixed(1) + 's', ox + 6, oy + TH - 6);
    }
    return c.toDataURL('image/jpeg', 0.85);
  })()`);
  fs.writeFileSync(path.join(OUT, 'compare.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
  // THE FILES THEMSELVES — through the app's own exporter, both ways, and the
  // two side by side so the difference is seen rather than described.
  if (!process.env.NO_EXPORT) {
    const { execFileSync } = require('child_process');
    const end = startSec + durSec;
    const t1 = Date.now();
    const pcOut = path.join(OUT, 'before.mp4'), aiOut = path.join(OUT, 'now.mp4');
    await video.exportShortReframed(ctx, { input, startSec, endSec: end, preset: 'reel-9x16', keyframes: res.kPc, output: pcOut });
    await video.exportShortReframed(ctx, { input, startSec, endSec: end, preset: 'reel-9x16', keyframes: res.kAi, output: aiOut });
    const label = (txt, col) => `drawbox=x=0:y=0:w=iw:h=64:color=black@0.72:t=fill,drawtext=fontfile='bin/fonts/Anton-Regular.ttf':text='${txt}':x=(w-text_w)/2:y=12:fontsize=38:fontcolor=${col}`;
    const side = path.join(OUT, 'side-by-side.mp4');
    execFileSync(ffmpeg, ['-v', 'error', '-i', pcOut, '-i', aiOut, '-filter_complex',
      `[0:v]scale=540:960,${label('BEFORE', '0xff6b6b')}[a];[1:v]scale=540:960,${label('NOW', '0x5ee38a')}[b];[a][b]hstack=inputs=2[v]`,
      '-map', '[v]', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-y', side],
      { cwd: path.join(__dirname, '..') });
    console.log(`exported both + side-by-side in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    if (process.env.DELIVER) {
      fs.mkdirSync(process.env.DELIVER, { recursive: true });
      const tag = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60); return `${h}h${String(m).padStart(2, '0')}m${String(x).padStart(2, '0')}s`; };
      const base = (process.env.NAME ? process.env.NAME + ' - ' : '') + tag(startSec);
      for (const [f, n] of [[side, 'BEFORE vs NOW'], [pcOut, 'before'], [aiOut, 'now']]) fs.copyFileSync(f, path.join(process.env.DELIVER, `${base} - ${n}.mp4`));
      fs.copyFileSync(path.join(OUT, 'compare.jpg'), path.join(process.env.DELIVER, `${base} - crops (red before, green now).jpg`));
    }
  }
  console.log('wrote ' + OUT);
  app.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
