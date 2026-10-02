'use strict';
/*
 * WHO THE AUTO-REFRAME FOLLOWS — on real footage, through the real pipeline.
 *
 * test/subject-lock.test.js proves the identity layer's logic on a cast we
 * invent. This proves the thing that actually matters and cannot be invented:
 * that on a real church platform, with a real face detector and real colour
 * signatures, picking a person makes the crop follow THAT person — and that
 * picking a different one moves the crop to them instead.
 *
 * Ground truth without hand-labelling: the two identities the tracker itself
 * separates are checked against each other. They stand in different places, so
 * "did locking A keep the crop on A and off B" is answerable from geometry.
 *
 *   node_modules/electron/dist/electron.exe test/subject-real.test.js "<video>" [startSec] [durSec]
 *
 * Defaults to the convention recording this was developed against; skips
 * cleanly (exit 0) when no such file is present, so it is safe in CI.
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
const argv = process.argv.slice(2).filter((a) => !/electron|subject-real/i.test(path.basename(a)));
const DEFAULT_VID = 'C:/Users/dejia/Downloads/The Outpouring Convention Day 2.mp4';
const input = argv[0] || DEFAULT_VID;
const startSec = parseFloat(argv[1] || '8392');
const durSec = parseFloat(argv[2] || '30');
const OUT = path.join(os.tmpdir(), 'mw-subject-real');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

if (!fs.existsSync(input)) {
  console.log('\nSKIP subject-real: no test recording at ' + input);
  console.log('     (pass one as the first argument to run it)');
  process.exit(0);
}

fs.mkdirSync(OUT, { recursive: true });
const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + ((e && e.stack) || e)); process.exit(1); });

const med = (a) => { const x = a.slice().sort((p, q) => p - q); return x.length ? x[x.length >> 1] : 0; };

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
    + '<body><script src="' + pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString() + '"></script></body></html>');

  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  const errs = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2 && !/OpenGL|XNNPACK|feedback|NORM_RECT|GPU stall/i.test(message)) errs.push(message); });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n[1] The tracker loads and the models are there');
  const avail = await win.webContents.executeJavaScript('window.FaceTrack.available()');
  check('FaceTrack.available() over mwasset://', avail === true, errs.slice(0, 3).join(' | '));
  if (!avail) process.exit(1);
  check('the pose model loaded too (bodies, not just faces)',
    await win.webContents.executeJavaScript('window.FaceTrack.poseAvailable()') === true);

  console.log('\n[2] Sampling the real recording');
  const info = await video.getInfo(ctx, input);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-subject-real-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({
    t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null,
  }));
  check('frames came out', payload.length > 100, payload.length + ' frames of ' + durSec + 's');
  check('every frame got its companion one frame later', payload.every((f) => f.pairUrl),
    payload.filter((f) => f.pairUrl).length + '/' + payload.length);
  // the companion must be a DIFFERENT picture, or the mouth measure reads zero
  const sameBytes = payload.slice(0, 20).filter((f, i) =>
    fs.readFileSync(frames[i].path).equals(fs.readFileSync(frames[i].pairPath))).length;
  check('the companion is a later frame, not a copy', sameBytes === 0, sameBytes + '/20 identical');

  await win.webContents.executeJavaScript('window.__frames = ' + JSON.stringify(payload)
    + '; window.__cuts = ' + JSON.stringify(frames.cuts || []) + '; 1');

  console.log('\n[3] Working out who is on this platform');
  const t0 = Date.now();
  const auto = await win.webContents.executeJavaScript('(async () => {'
    + 'const d = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts });'
    + 'window.__signals = d.signals;'
    + 'return { subject: d.subject, cx: d.map((x) => x.cxNorm) };'
    + '})()');
  const trackSec = (Date.now() - t0) / 1000;
  check('somebody was identified', !!auto.subject, auto.subject ? auto.subject.why : 'none');
  check('more than one person was told apart', auto.subject && auto.subject.people.length >= 2,
    auto.subject ? auto.subject.people.length + ' identities' : '');
  check('tracking a ' + durSec + 's clip took under 2x realtime', trackSec < durSec * 2,
    trackSec.toFixed(1) + 's for ' + durSec + 's');
  check('the expensive half came back for re-use',
    await win.webContents.executeJavaScript('Array.isArray(window.__signals) && window.__signals.length') === payload.length);

  console.log('\n[4] Locking onto each of them in turn');
  // Two identities that stand far enough apart for geometry to tell them apart.
  const people = (auto.subject ? auto.subject.people : []).filter((p) => p.sig && p.n >= 10);
  people.sort((a, b) => b.n - a.n);
  let A = people[0], B = null;
  for (const p of people.slice(1)) if (Math.abs(p.cx - A.cx) > 0.15) { B = p; break; }
  check('found two identities standing well apart to test with', !!A && !!B,
    A && B ? 'cx ' + A.cx.toFixed(2) + ' and ' + B.cx.toFixed(2) : 'only ' + people.length + ' usable');

  if (A && B) {
    const lockRun = async (who) => win.webContents.executeJavaScript('(async () => {'
      + 'const lock = window.FaceTrack.unpackSig(' + JSON.stringify(who.sig) + ');'
      + 'const t = performance.now();'
      + 'const d = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts, signals: window.__signals, lock });'
      + 'return { ms: performance.now() - t, subject: d.subject, cx: d.map((x) => x.cxNorm) };'
      + '})()');
    const ra = await lockRun(A), rb = await lockRun(B);
    const seen = (r) => r.cx.filter((x) => x != null);
    const sa = seen(ra), sb = seen(rb);

    check('re-picking without re-watching the clip is near-instant', ra.ms < 3000, ra.ms.toFixed(0) + 'ms');
    check('locking A finds A in a useful share of the clip', sa.length >= payload.length * 0.15,
      sa.length + '/' + payload.length);
    check('locking B finds B in a useful share of the clip', sb.length >= payload.length * 0.15,
      sb.length + '/' + payload.length);
    check('locking A puts the track on A, not B',
      Math.abs(med(sa) - A.cx) < Math.abs(med(sa) - B.cx),
      'track ' + med(sa).toFixed(2) + ' vs A ' + A.cx.toFixed(2) + ' / B ' + B.cx.toFixed(2));
    check('locking B puts the track on B, not A',
      Math.abs(med(sb) - B.cx) < Math.abs(med(sb) - A.cx),
      'track ' + med(sb).toFixed(2) + ' vs B ' + B.cx.toFixed(2) + ' / A ' + A.cx.toFixed(2));
    check('the two locks really do produce different crops',
      Math.abs(med(sa) - med(sb)) > 0.10, 'apart by ' + Math.abs(med(sa) - med(sb)).toFixed(2));

    console.log('\n[5] What the export would actually crop');
    const kfOf = async (r, who) => win.webContents.executeJavaScript('(async () => {'
      + 'const lock = window.FaceTrack.unpackSig(' + JSON.stringify(who.sig) + ');'
      + 'const d = await window.FaceTrack.detectFrames(window.__frames, { cuts: window.__cuts, signals: window.__signals, lock });'
      + 'return window.FaceTrack.buildKeyframes(d, ' + info.width + ', ' + info.height + ', { targetAR: 9/16, cuts: window.__cuts });'
      + '})()');
    const kfa = await kfOf(ra, A);
    const camAt = (kf, t) => {
      if (t <= kf[0].t) return kf[0].x;
      for (let i = 0; i < kf.length - 1; i++) {
        if (t < kf[i + 1].t) { const p = (t - kf[i].t) / (kf[i + 1].t - kf[i].t); return kf[i].x + (kf[i + 1].x - kf[i].x) * p; }
      }
      return kf[kf.length - 1].x;
    };
    const halfCrop = 0.5 * (info.height * (9 / 16)) / info.width;
    // A camera cut is a place the crop is SUPPOSED to jump — the picture is
    // already discontinuous there, so snapping is invisible and gliding across
    // it is the bug. Smoothness is only meaningful within a shot.
    const cutTs = (frames.cuts || []).filter((c) => c.score == null || c.score >= 0.14).map((c) => c.t);
    const cutBetween = (a, b) => cutTs.some((c) => c > Math.min(a, b) && c <= Math.max(a, b));
    let inFrame = 0, seenN = 0, worstStep = 0, prev = null, prevT = null;
    for (let i = 0; i < payload.length; i++) {
      const cam = camAt(kfa, payload[i].t) / info.width;
      if (prev != null && !cutBetween(prevT, payload[i].t)) worstStep = Math.max(worstStep, Math.abs(cam - prev));
      prev = cam; prevT = payload[i].t;
      const x = ra.cx[i];
      if (x == null) continue;
      seenN++;
      if (Math.abs(cam - x) < halfCrop) inFrame++;
    }
    check('the locked person is inside the 9:16 crop in every frame they are visible',
      seenN > 0 && inFrame === seenN, inFrame + '/' + seenN);
    check('the crop never jumps within a shot', worstStep < 0.06,
      'worst step ' + worstStep.toFixed(4) + ' of frame width, over ' + cutTs.length + ' cuts');
    // buildKeyframes emits a dense path on purpose; the exporter is what has to
    // fit inside the ffmpeg expression, and it thins the path down first.
    const simplified = video.simplifyKeyframes(kfa);
    check('the crop path fits the export filter once thinned', simplified.length <= 160,
      kfa.length + ' dense -> ' + simplified.length + ' keyframes');
  }

  console.log('\n[6] Nothing went wrong quietly');
  check('no errors were logged by the tracker', errs.length === 0, errs.slice(0, 3).join(' | '));

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
