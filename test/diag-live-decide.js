'use strict';
/*
 * WHY DID THE LIVE PREVIEW LOOK THERE?
 *
 * Runs detectElement over a window of real frames exactly the way the preview
 * does — sticky, one tick at a time, feeding the previous answer back in as the
 * track — and prints the decision behind each tick: who was in the picture, who
 * was chosen, and how much they looked like the person being followed. The
 * smoothness harness reports what the preview DID; this says why.
 *
 *   node_modules/electron/dist/electron.exe test/diag-live-decide.js "<video>" <startSec> <durSec>
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
const args = argv.filter((a) => !a.startsWith('--') && !/electron|diag-live-decide/i.test(path.basename(a)));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '30');
const OUT = path.join(os.tmpdir(), 'mw-live-decide');
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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-decide-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 4.5, outDir: dir });
  const urls = frames.map((f) => ({ t: f.t, url: pathToFileURL(f.path).toString() }));
  console.log(path.basename(input) + ' ' + startSec + '+' + durSec + 's — ' + urls.length + ' ticks\n');

  const rows = await win.webContents.executeJavaScript('(async () => {'
    + 'const fs = ' + JSON.stringify(urls) + ', out = [];'
    + 'const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.onerror = () => r(null); i.src = u; });'
    + 'window.FaceTrack.resetLive();'
    + 'let nx = null, ny = null;'
    + 'for (const f of fs) { const img = await load(f.url); if (!img) { out.push(null); continue; }'
    + '  const face = await window.FaceTrack.detectElement(img, { nearX: nx, nearY: ny, debug: true });'
    + '  if (face && face.cxNorm != null) { nx = face.cxNorm; ny = face.cyNorm; }'
    + '  out.push({ t: f.t, chose: face && face.cxNorm != null ? face.cxNorm : null, anchored: face && face.dbg ? face.dbg.anchored : false,'
    + '    ppl: (face && face.dbg ? face.dbg.pool : []).map((p) => ({ cx: +p.cx.toFixed(3), b: !!p.body, w: +p.w.toFixed(3), s: +p.sim.toFixed(2) })) }); }'
    + 'return out; })()');

  console.log('   t   chose  | candidates: position(B = body) /width  sim = how much it looks like the followed person');
  for (const r of rows) {
    if (!r) { console.log('   -- frame failed'); continue; }
    console.log(r.t.toFixed(2).padStart(6) + '  ' + (r.chose == null ? ' --- ' : r.chose.toFixed(3)) + (r.anchored ? ' ' : '?') + ' | '
      + r.ppl.map((p) => p.cx.toFixed(2) + (p.b ? 'B' : 'f') + '/w' + p.w.toFixed(2) + ' sim' + p.s.toFixed(2)).join('   '));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
