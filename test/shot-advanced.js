'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const video = require('../src/main/video');
const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#ffb02e' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'none' }));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1440, height: 900, webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));

  // 1) flyer with new shapes + emoji -> PNG
  const b64 = await win.webContents.executeJavaScript(`(async () => {
    const T = window.Editor.__test;
    T.loadPreset('event', 1080, 1350);
    T.addShape('star'); T.addShape('triangle'); T.addShape('line'); T.addEmoji('🔥');
    return await T.exportBase64();
  })()`);
  fs.writeFileSync(path.join(OUT, 'flyer-shapes.png'), Buffer.from(b64, 'base64'));
  console.log('wrote flyer-shapes.png');

  // 2) screenshot the modern flyer editor UI
  await win.webContents.executeJavaScript(`
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-flyer').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'flyer'));
    if (window.Editor) window.Editor.onShow(); true;`);
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'ui-flyer.png'), img.toPNG());
  console.log('wrote ui-flyer.png');

  win.destroy(); app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
