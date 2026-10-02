'use strict';
/*
 * Render a real 9:16 short through the WHOLE export path — sample frames, work
 * out who the clip is about, build the crop, encode it — and lay the finished
 * short out as a contact sheet.
 *
 * This is the only check that answers the question the user actually asks
 * ("does the short follow the right person?"), because it looks at the file
 * they would post rather than at numbers about it.
 *
 *   node_modules/electron/dist/electron.exe test/diag-export-short.js "<video>" <startSec> <durSec> [--out=DIR]
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
const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !/electron|diag-export-short/i.test(path.basename(a)));
const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const startSec = parseFloat(args[1] || '0');
const durSec = parseFloat(args[2] || '40');
const OUT = flags.out || path.join(os.tmpdir(), 'mw-export-short');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-exp-frames-'));
  const frames = await video.extractFrames(ctx, { input, startSec, endSec: startSec + durSec, fps: 6, pairs: true, outDir: dir });
  const payload = frames.map((f) => ({
    t: f.t, url: pathToFileURL(f.path).toString(),
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null,
  }));
  console.log('\n' + path.basename(input) + '  ' + startSec + 's +' + durSec + 's  — ' + payload.length + ' samples');

  const res = await win.webContents.executeJavaScript('(async () => {'
    + 'const frames = ' + JSON.stringify(payload) + ', cuts = ' + JSON.stringify(frames.cuts || []) + ';'
    + 'const d = await window.FaceTrack.detectFrames(frames, { cuts });'
    + 'return { why: d.subject ? d.subject.why : "nobody", found: d.subject ? d.subject.frames : 0,'
    + '  kf: window.FaceTrack.buildKeyframes(d, ' + info.width + ', ' + info.height + ', { targetAR: 9/16, cuts }) };'
    + '})()');
  console.log('  following: ' + res.why + '  (' + res.found + '/' + payload.length + ' frames)');

  const out = path.join(OUT, 'short-' + Math.round(startSec) + '.mp4');
  await video.exportShortReframed(ctx, {
    input, startSec, endSec: startSec + durSec, preset: 'reel-9x16', keyframes: res.kf, output: out,
  });
  const sheet = path.join(OUT, 'short-' + Math.round(startSec) + '-sheet.jpg');
  execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-vf', 'fps=1/' + Math.max(1, Math.round(durSec / 24)) + ',scale=150:-1,tile=8x3', '-frames:v', '1', '-y', sheet]);
  console.log('  short: ' + out);
  console.log('  sheet: ' + sheet + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}).catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
