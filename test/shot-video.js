'use strict';
// Screenshot the Video Studio with fake AI highlights loaded, for eyeballing.
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
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1400));

  const diag = await win.webContents.executeJavaScript(`(() => {
    // Force the Video Studio view active.
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'video'));
    if (window.VideoEditor) window.VideoEditor.onShow();
    window.VideoEditor.__test.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    const nov = document.querySelector('#veNoVid');
    nov.innerHTML = '<div style="font-size:64px">🎬</div><p style="color:#9aa">sermon-2026-07-05.mp4 &nbsp;·&nbsp; 2:25 loaded</p>';
    document.querySelector('#veName').textContent = 'sermon-2026-07-05.mp4';
    document.querySelector('#veStats').textContent = '  1920×1080 · 2:25 · 30fps';
    document.querySelector('#veFindHighlights').disabled = false;
    window.VideoEditor.__test.applyClips([
      { start: 33, end: 49, label: 'Grace changes everything' },
      { start: 77, end: 93, label: 'Faith over fear' },
      { start: 121, end: 137, label: 'You are not alone' },
    ]);
    // show a live caption on the preview for the screenshot
    window.VideoEditor.__test.setCapEvents([{ start: 0, end: 999, text: 'GRACE CHANGES EVERYTHING' }], 0);
    window.VideoEditor.__test.overlayAt(35);
    // text-on-video overlay + manual crop framing, for the screenshot
    window.VideoEditor.__test.addTextAt({ text: 'Sunday 10AM', start: 0, end: 999, x: 0.5, y: 0.18, color: '#ffe600', sizePct: 0.06 });
    document.getElementById('veAutoReframe').checked = false;
    window.VideoEditor.__test.setFraming(1.6, 0.35, 0.4);
    window.VideoEditor.__test.seekAndRefresh(35);
    return { active: document.getElementById('view-video').classList.contains('active') };
  })()`);
  console.log('view-video active:', diag.active);
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 900));

  const img = await win.webContents.capturePage();
  const file = path.join(OUT, 'video-studio.png');
  fs.writeFileSync(file, img.toPNG());
  console.log('wrote ' + file);
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
