'use strict';
/*
 * Freeze one range of real footage into a JSON corpus so camera work can be
 * designed WITHOUT paying 60s of model time per idea.
 *
 * For every 6fps sample it records: everybody the models can see (face box,
 * body, which of the two found them), what the identity layer decided, and the
 * scene cuts. That is enough to re-run detectFrames' geometry and every camera
 * candidate offline, in milliseconds, against footage that actually broke.
 *
 * `people` is the honest ground truth here — it is what is IN the picture,
 * before anyone decided who the clip is about — so a camera that loses the
 * speaker can be caught without re-exporting the video.
 *
 *   node_modules/electron/dist/electron.exe test/diag-reframe-corpus.js "<video>" <startSec> <durSec> --tag=NAME [--out=DIR]
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
const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--') && !/electron|diag-reframe-corpus/i.test(path.basename(a)));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '40');
const TAG = flags.tag || String(Math.round(startSec));
const OUT = flags.out || path.join(os.tmpdir(), 'mw-reframe-corpus');
fs.mkdirSync(OUT, { recursive: true });

const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();
process.on('unhandledRejection', (e) => { console.log('UNHANDLED: ' + ((e && e.stack) || e)); process.exit(1); });

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
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  if (!(await win.webContents.executeJavaScript('window.FaceTrack.available()'))) { console.log('tracker unavailable'); process.exit(1); }

  const info = await video.getInfo(ctx, input);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-corpus-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({
    t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null,
  }));
  console.log(path.basename(input) + ' ' + startSec + '+' + durSec + 's — ' + payload.length + ' samples, tracking…');

  const res = await win.webContents.executeJavaScript('(async () => {'
    + 'const frames = ' + JSON.stringify(payload) + ', cuts = ' + JSON.stringify(frames.cuts || []) + ';'
    + 'const d = await window.FaceTrack.detectFrames(frames, { cuts });'
    // everybody in every frame, straight from the models — the ground truth the
    // identity layer's answer has to be judged against
    + 'const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });'
    + 'const people = [];'
    + 'for (const f of frames) { const img = await load(f.url); if (!img) { people.push([]); continue; }'
    + '  let pp = []; try { pp = await window.FaceTrack.detectPeople(img, { thumbs: false }); } catch (e) {}'
    + '  people.push(pp.map((p) => ({ cx: +p.cx.toFixed(4), cy: +p.cy.toFixed(4), bw: +p.bw.toFixed(4), bh: +p.bh.toFixed(4), src: p.src, body: !!p.body }))); }'
    + 'return { why: d.subject ? d.subject.why : "nobody", drives: d.subject ? d.subject.drives : false,'
    + '  dets: d.map((x) => ({ t: +x.t.toFixed(3), cx: x.cxNorm == null ? null : +x.cxNorm.toFixed(4), cy: x.cyNorm == null ? null : +x.cyNorm.toFixed(4),'
    + '     src: x.src || null, sub: !!x.subject, br: !!x.bridged, pose: x.poseCx == null ? null : +x.poseCx.toFixed(4) })), people };'
    + '})()');

  const file = path.join(OUT, 'corpus-' + TAG + '.json');
  fs.writeFileSync(file, JSON.stringify({
    tag: TAG, input, startSec, durSec, srcW: info.width, srcH: info.height,
    cuts: frames.cuts || [], why: res.why, drives: res.drives, dets: res.dets, people: res.people,
  }));
  const gaps = res.dets.filter((d) => d.cx == null).length;
  console.log('  ' + res.why + '  gaps ' + gaps + '/' + res.dets.length
    + '  frames with a body: ' + res.people.filter((p) => p.some((q) => q.body)).length + ' (real bodies)');
  console.log('  → ' + file);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
