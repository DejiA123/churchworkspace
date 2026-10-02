'use strict';
/*
 * SCORE A FINISHED SHORT — how well did auto-reframe actually keep the speaker
 * in the picture, and how calm was the camera getting there?
 *
 * Everything here is measured on the EXPORTED FILE, not on the tracker's own
 * numbers: the tracker believing it followed the speaker is exactly the belief
 * that shipped the bad clips. So we export, decode the output, and ask the pose
 * model where the person is IN THE 9:16 FRAME.
 *
 * Two numbers matter and they pull against each other:
 *   FRAMING  — is the speaker in shot, and near the middle? (off-centre
 *              distribution, how often nobody is found at all, how often the
 *              person found is clipped by the frame edge)
 *   CALM     — does the camera move like an operator or like a nervous dog?
 *              (speed, direction reversals, jerk — read off the crop path that
 *              was actually rendered)
 *
 *   node_modules/electron/dist/electron.exe test/diag-reframe-measure.js "<video>" <startSec> <durSec> [--out=DIR] [--tag=NAME] [--keep]
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--') && !/electron|diag-reframe-measure/i.test(path.basename(a)));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '40');
const TAG = flags.tag || String(Math.round(startSec));
const OUT = flags.out || path.join(os.tmpdir(), 'mw-reframe-measure');
fs.mkdirSync(OUT, { recursive: true });

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + ((e && e.stack) || e)); process.exit(1); });

const pct = (n, d) => (d ? (100 * n / d).toFixed(1) + '%' : '—');
const quant = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

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
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; media-src 'self' file: blob: data:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="' + csp + '"></head>'
    // --facetrack=<file> swaps the tracker under test, and --nobridge turns off
    // the recovery layer: together they reproduce the ORIGINAL algorithm, so
    // before/after can be read off the same yardstick instead of from memory.
    + '<body><script src="' + pathToFileURL(flags.facetrack || path.join(rendererDir, 'facetrack.js')).toString() + '"></script></body></html>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  if (!(await win.webContents.executeJavaScript('window.FaceTrack.available()'))) { console.log('tracker unavailable'); process.exit(1); }

  const info = await video.getInfo(ctx, input);
  const t0 = Date.now();

  // ---- 1. track + build the crop path, exactly as the studio does ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-meas-src-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({
    t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null,
  }));
  const track = await win.webContents.executeJavaScript('(async () => {'
    + 'const frames = ' + JSON.stringify(payload) + ', cuts = ' + JSON.stringify(frames.cuts || []) + ';'
    + 'const d = await window.FaceTrack.detectFrames(frames, { cuts, bridge: ' + ('nobridge' in flags ? 'false' : 'true') + ' });'
    + 'return { why: d.subject ? d.subject.why : "nobody", found: d.subject ? d.subject.frames : 0, n: d.length,'
    + '  dets: d.map((x) => ({ t: x.t, cx: x.cxNorm == null ? null : x.cxNorm, pose: x.poseCx == null ? null : x.poseCx })),'
    + '  kf: window.FaceTrack.buildKeyframes(d, ' + info.width + ', ' + info.height + ', { targetAR: 9/16, cuts }) };'
    + '})()');
  const trackMs = Date.now() - t0;

  // ---- 2. render it -------------------------------------------------------
  const out = path.join(OUT, 'meas-' + TAG + '.mp4');
  await video.exportShortReframed(ctx, {
    input, startSec, endSec: startSec + durSec, preset: 'reel-9x16', keyframes: track.kf, output: out,
  });

  // ---- 3. decode the OUTPUT and find the person in each frame -------------
  const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-meas-out-'));
  execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-vf', 'fps=6,scale=540:960', '-q:v', '3', '-y', path.join(odir, 'o%05d.jpg')]);
  const outFiles = fs.readdirSync(odir).filter((f) => f.endsWith('.jpg')).sort();
  const outUrls = outFiles.map((f) => pathToFileURL(path.join(odir, f)).toString());

  const seen = await win.webContents.executeJavaScript('(async () => {'
    + 'const urls = ' + JSON.stringify(outUrls) + '; const out = [];'
    + 'const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; });'
    + 'for (const u of urls) { const img = await load(u); if (!img) { out.push(null); continue; }'
    + '  let ppl = []; try { ppl = await window.FaceTrack.detectPeople(img, { thumbs: false }); } catch (e) {}'
    // A BODY, OR NOBODY. The backdrop wordmark on this church's stream detects
    // as three or four confident "faces" a fifth of the frame wide in every
    // sample, so a measurement that accepts a face box reports a person in an
    // empty picture — it scored 0% "nobody in shot" on frames that are visibly
    // an empty chair. Only somebody the pose model found a body for counts.
    + '  const bodied = ppl.filter((p) => p.body);'
    + '  const pick = bodied.sort((a, b) => (b.bw * b.bh) - (a.bw * a.bh))[0];'
    + '  out.push(pick ? { cx: pick.cx, cy: pick.cy, bw: pick.bw, bh: pick.bh, src: pick.src } : null); }'
    + 'return out; })()');

  // ---- 4. the numbers ----------------------------------------------------
  const N = seen.length;
  const offs = [], cut = [];
  let none = 0, run = 0, longestNone = 0;
  const missAt = [];
  seen.forEach((p, i) => {
    if (!p) { none++; run++; longestNone = Math.max(longestNone, run); missAt.push(i); return; }
    run = 0;
    offs.push(Math.abs(p.cx - 0.5));
    // The HEAD against the frame edges. (An earlier version measured head plus
    // shoulders, at 2.3 head widths — on a tight 9:16 crop that box is wider
    // than the frame whatever the camera does, so it reported 87% "clipped" on
    // footage where nothing was clipped at all. Half a head outside the frame
    // is unambiguous, and is what a viewer notices.)
    const x0 = p.cx - p.bw * 0.5, x1 = p.cx + p.bw * 0.5;
    if (x0 < 0 || x1 > 1) cut.push(i);
  });

  // camera calm, off the crop path that was actually rendered
  const kf = track.kf.filter((k) => k && k.x != null);
  const spd = [], rev = [];
  for (let i = 1; i < kf.length; i++) {
    const dt = kf[i].t - kf[i - 1].t;
    if (dt <= 1e-3) continue;
    spd.push(Math.abs(kf[i].x - kf[i - 1].x) / info.width / dt);
  }
  for (let i = 2; i < kf.length; i++) {
    const a = kf[i - 1].x - kf[i - 2].x, b = kf[i].x - kf[i - 1].x;
    if (a * b < 0 && Math.abs(a) > info.width * 0.002 && Math.abs(b) > info.width * 0.002) rev.push(kf[i].t);
  }

  console.log('\n' + path.basename(input) + '  ' + startSec + 's +' + durSec + 's   [' + TAG + ']');
  console.log('  following      : ' + track.why + '  (' + track.found + '/' + track.n + ' samples,  tracked in ' + (trackMs / 1000).toFixed(1) + 's)');
  console.log('  gaps in track  : ' + pct(track.dets.filter((d) => d.cx == null).length, track.dets.length));
  console.log('  OUTPUT frames  : ' + N);
  console.log('  nobody in shot : ' + pct(none, N) + '   longest blind run ' + (longestNone / 6).toFixed(2) + 's');
  console.log('  head clipped   : ' + pct(cut.length, N));
  console.log('  off-centre     : avg ' + mean(offs).toFixed(3) + '  p50 ' + quant(offs, 0.5).toFixed(3)
    + '  p90 ' + quant(offs, 0.9).toFixed(3) + '  p99 ' + quant(offs, 0.99).toFixed(3) + '  max ' + (offs.length ? Math.max(...offs).toFixed(3) : '—'));
  console.log('  beyond 0.25    : ' + pct(offs.filter((o) => o > 0.25).length, offs.length)
    + '   beyond 0.35: ' + pct(offs.filter((o) => o > 0.35).length, offs.length));
  console.log('  camera         : mean ' + mean(spd).toFixed(4) + '/s  p95 ' + quant(spd, 0.95).toFixed(4)
    + '/s  max ' + (spd.length ? Math.max(...spd).toFixed(4) : '—') + '/s   reversals ' + rev.length + ' (' + (rev.length / durSec).toFixed(2) + '/s)');

  // ---- 5. show the worst frames, because a statistic can lie -------------
  const worst = seen.map((p, i) => ({ i, bad: p ? Math.abs(p.cx - 0.5) : 9 }))
    .sort((a, b) => b.bad - a.bad).slice(0, 8).sort((a, b) => a.i - b.i);
  if (worst.length) {
    const list = worst.map((w) => path.join(odir, outFiles[w.i]));
    const strip = path.join(OUT, 'worst-' + TAG + '.jpg');
    execFileSync(ffmpeg, ['-v', 'error'].concat(list.flatMap((f) => ['-i', f]),
      ['-filter_complex', list.map((_, i) => '[' + i + ':v]scale=180:320[v' + i + ']').join(';') + ';'
        + list.map((_, i) => '[v' + i + ']').join('') + 'hstack=' + list.length, '-frames:v', '1', '-y', strip]));
    console.log('  worst frames   : ' + strip + '   at ' + worst.map((w) => (w.i / 6).toFixed(1) + 's').join(' '));
  }
  const sheet = path.join(OUT, 'sheet-' + TAG + '.jpg');
  execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-vf', 'fps=1/' + Math.max(1, Math.round(durSec / 24)) + ',scale=150:-1,tile=8x3', '-frames:v', '1', '-y', sheet]);
  console.log('  short / sheet  : ' + out + '\n                   ' + sheet + '\n');

  fs.writeFileSync(path.join(OUT, 'data-' + TAG + '.json'), JSON.stringify({
    input, startSec, durSec, why: track.why, dets: track.dets, kf: track.kf, seen,
    srcW: info.width, srcH: info.height,
  }));
  if (!flags.keep) { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(odir, { recursive: true, force: true }); }
  else console.log('  frames kept    : ' + dir + '  ' + odir);
  process.exit(0);
}).catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
