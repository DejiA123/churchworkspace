'use strict';
// Screenshot the Video Studio (robust: retries capturePage until non-empty).
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const video = require('../src/main/video');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));

app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'video'));
    if (window.VideoEditor) window.VideoEditor.onShow();
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    document.querySelector('#veNoVid').innerHTML = '<div style="font-size:64px">🎬</div><p style="color:#9aa">sermon.mp4 · 2:25 loaded</p>';
    document.querySelector('#veName').textContent = 'sermon.mp4';
    document.querySelector('#veStats').textContent = '  1920×1080 · 2:25 · 30fps';
    document.querySelector('#veFindHighlights').disabled = false;
    T.applyClips([
      { start: 20, end: 42, label: 'Grace changes everything', virality: 91, reasons: ['Opens with a hook', 'Congregation reacted'] },
      { start: 62, end: 84, label: 'Faith over fear', virality: 78, reasons: ['Spirit-filled declarations', 'High-energy delivery'] },
      { start: 104, end: 126, label: 'You are not alone', virality: 64, reasons: ['Clean sentence start & finish'] },
    ]);
    // make the 3rd clip an OVERLAY (picture-in-picture) at a new time
    const segs = T.segments();
    T.toggleOverlay(segs[2].id);
    T.setOverlayTl(segs[2].id, 30);
    T.setCapEvents([{ start: 0, end: 999, text: 'GRACE CHANGES EVERYTHING' }], 0);
    T.overlayAt(30);
    T.addTextAt({ text: 'Sunday 10AM', start: 0, end: 999, x: 0.5, y: 0.16, color: '#ffe600', sizePct: 0.06 });
    document.getElementById('veAutoReframe').checked = false;
    T.seekAndRefresh(30);
    window.VideoEditor.onShow();
    return true;
  })()`);

  // retry capture until we get a non-empty PNG (repaint can lag on first frames)
  const file = path.join(OUT, 'video-studio.png');
  let wrote = false;
  for (let i = 0; i < 8 && !wrote; i++) {
    await sleep(700);
    win.webContents.invalidate();
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    if (buf && buf.length > 8000) { fs.writeFileSync(file, buf); wrote = true; console.log('wrote ' + file + ' (' + buf.length + ' bytes, try ' + (i + 1) + ')'); }
  }
  if (!wrote) console.log('FAILED to capture a non-empty frame');

  // second shot: the "Video quality" side panel open over the studio
  await win.webContents.executeJavaScript(`document.getElementById('fxModal').classList.remove('hidden'); true`);
  const file2 = path.join(OUT, 'video-quality-panel.png');
  let wrote2 = false;
  for (let i = 0; i < 8 && !wrote2; i++) {
    await sleep(700);
    win.webContents.invalidate();
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
    if (buf && buf.length > 8000) { fs.writeFileSync(file2, buf); wrote2 = true; console.log('wrote ' + file2 + ' (' + buf.length + ' bytes, try ' + (i + 1) + ')'); }
  }
  win.destroy();
  app.exit(wrote ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
