'use strict';
// Generates real sample flyers from the EDITOR (presets + an embedded image)
// so they can be eyeballed.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const video = require('../src/main/video');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#6d28d9', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));

  async function save(name, script) {
    const b64 = await win.webContents.executeJavaScript(script);
    const file = path.join(OUT, name);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    console.log('wrote ' + file);
  }

  // 1) Event preset as-is
  await save('editor-event.png', `(async()=>{ window.Editor.__test.loadPreset('event',1080,1350); return await window.Editor.__test.exportBase64(); })()`);

  // 2) Bold preset
  await save('editor-bold.png', `(async()=>{ window.Editor.__test.loadPreset('bold',1080,1350); return await window.Editor.__test.exportBase64(); })()`);

  // 3) Event preset + a foreground image (generated logo data URL) to prove images embed in export
  await save('editor-with-image.png', `(async()=>{
    window.Editor.__test.loadPreset('event',1080,1350);
    const c=document.createElement('canvas'); c.width=300; c.height=300; const x=c.getContext('2d');
    const g=x.createRadialGradient(150,150,10,150,150,150); g.addColorStop(0,'#fff'); g.addColorStop(1,'#f5a623');
    x.fillStyle=g; x.beginPath(); x.arc(150,150,150,0,7); x.fill();
    x.fillStyle='#6d28d9'; x.font='bold 120px Segoe UI'; x.textAlign='center'; x.textBaseline='middle'; x.fillText('✝',150,160);
    window.Editor.__test.addImageSrc(c.toDataURL('image/png'), 760, 90, 240, 240);
    return await window.Editor.__test.exportBase64();
  })()`);

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
