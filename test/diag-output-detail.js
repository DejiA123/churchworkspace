'use strict';
/*
 * ONE-OFF: re-detect faces in the cached OUTPUT frames from a reframe-inframe
 * test run and print per-sample timestamp + cxNorm + off, so we can see WHICH
 * moments are near-edge (instead of just the aggregate worst/avg).
 * Usage: node test/diag-output-detail.js <dir-with-o_*.jpg>
 */
const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { pathToFileURL } = require('url');

const dir = process.argv[2];
const AI_DIR = path.join(__dirname, '..', 'bin', 'ai');
protocol.registerSchemesAsPrivileged([{ scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent(u.hostname + u.pathname).replace(/^\/+/, '');
      const full = path.normalize(path.join(AI_DIR, rel));
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript' : 'application/octet-stream';
      return new Response(await fs.promises.readFile(full), { headers: { 'content-type': mime } });
    } catch (e) { return new Response('err: ' + e.message, { status: 404 }); }
  });
  const rendererDir = path.join(__dirname, '..', 'src', 'renderer');
  const csp = "default-src 'self'; img-src 'self' data: file: blob:; script-src 'self' 'wasm-unsafe-eval' mwasset:; connect-src 'self' mwasset: file: data: blob:; worker-src 'self' blob:;";
  const OUT = path.join(os.tmpdir(), 'mw-diag-output-detail');
  fs.mkdirSync(OUT, { recursive: true });
  const tmpHtml = path.join(OUT, 'harness.html');
  fs.writeFileSync(tmpHtml, `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script src="${pathToFileURL(path.join(rendererDir, 'facetrack.js')).toString()}"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { contextIsolation: false, sandbox: false } });
  await win.loadFile(tmpHtml);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript('window.FaceTrack.available()');

  const files = fs.readdirSync(dir).filter((f) => /^o_[\d.]+\.jpg$/.test(f))
    .map((f) => ({ f, t: Number(f.slice(2, -4)) })).sort((a, b) => a.t - b.t);
  console.log('t\tcxNorm\toff(|cx-0.5|)\tflag');
  for (const { f, t } of files) {
    const url = pathToFileURL(path.join(dir, f)).toString();
    const r = await win.webContents.executeJavaScript(`window.FaceTrack.detectFrames([{t:0,url:${JSON.stringify(url)}}])`);
    const cx = r[0] && r[0].cxNorm != null ? r[0].cxNorm : null;
    const off = cx != null ? Math.abs(cx - 0.5) : null;
    console.log(`${t}\t${cx != null ? cx.toFixed(3) : 'MISS'}\t${off != null ? off.toFixed(3) : ''}\t${off != null && off > 0.42 ? 'NEAR-EDGE' : ''}`);
  }
  if (!win.isDestroyed()) win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
