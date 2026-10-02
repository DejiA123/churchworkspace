'use strict';
// Standalone: prove MediaPipe face detection works on real sermon frames.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const SC = process.env.MW_SC;
const ROOT = path.join(__dirname, '..');
const fileUrl = (p) => 'file:///' + encodeURI(p.replace(/\\/g, '/'));
const WASM = fileUrl(path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'));
const MODEL = fileUrl(path.join(ROOT, 'bin', 'ai', 'blaze_face_short_range.tflite'));

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { webSecurity: false, contextIsolation: false } });
  await win.loadFile(path.join(SC, 'facetest.html'));
  // wait for the module script to finish importing
  for (let i = 0; i < 100; i++) { if (await win.webContents.executeJavaScript('!!window.__ready')) break; await new Promise((r) => setTimeout(r, 100)); }

  for (const f of ['frame_460.jpg', 'frame_1810.jpg', 'frame_3230.jpg']) {
    const img = fileUrl(path.join(SC, f));
    try {
      const r = await win.webContents.executeJavaScript(`window.__detect(${JSON.stringify(WASM)}, ${JSON.stringify(MODEL)}, ${JSON.stringify(img)})`);
      const best = r.faces.sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
      console.log(`${f}: ${r.w}x${r.h} — ${r.faces.length} face(s)` + (best ? `  biggest@ cx=${Math.round(best.x + best.w / 2)} cy=${Math.round(best.y + best.h / 2)} (${best.w}x${best.h}, score ${best.score})` : ''));
    } catch (e) { console.log(`${f}: ERROR ${e.message}`); }
  }
  app.exit(0);
}).catch((e) => { console.error('FATAL', e); app.exit(1); });
