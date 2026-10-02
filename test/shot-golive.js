'use strict';
/*
 * Screenshot the Go Live switcher with a few synthetic inputs loaded, so the
 * layout can actually be EYEBALLED (a blank switcher hides every spacing bug).
 *
 * Run: MW_SAMPLE_DIR=<dir> npx electron test/shot-golive.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const video = require('../src/main/video');
const { DESTINATIONS, QUALITIES } = require('../src/main/livestream');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({
  brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' },
  accounts: {}, apiKeys: {}, live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' },
}));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('live:engine', () => ok({ encoder: 'h264_qsv', label: 'Hardware (Intel QSV)', hardware: true, preference: 'auto', running: false, outputs: 0, gpu: true }));
ipcMain.handle('live:state', () => ok({ running: false }));
ipcMain.handle('live:metrics', () => ok({ cpu: 12.4 }));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, file, tries = 6) {
  console.log("  shooting " + path.basename(file) + "…");
  let wrote = false;
  for (let i = 0; i < tries && !wrote; i++) {
    await sleep(400);
    win.webContents.invalidate();
    const buf = (await win.webContents.capturePage()).toPNG();
    if (buf && buf.length > 8000) { fs.writeFileSync(file, buf); wrote = true; console.log('wrote ' + file + ' (' + buf.length + ' bytes, try ' + (i + 1) + ')'); }
  }
  if (!wrote) console.log('FAILED to capture ' + file);
  return wrote;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: Number(process.env.MW_W) || 1600, height: Number(process.env.MW_H) || 980,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  const r = await win.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === 'live'));
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    const a = T.addSynthetic('Camera 1', 205);
    const b = T.addSynthetic('Camera 2', 25);
    T.addColor('Lower Third', '#1b2b4a');
    T.addTitle({ text: 'Welcome to Grace Chapel', style: 'lower', color: '#ffffff' });
    T.setPreview(b); T.cut(); T.setPreview(a);
    await new Promise(r => setTimeout(r, 900));
    return { inputs: T.state().inputs.length };
  })()`);
  console.log('seeded', JSON.stringify(r));
  await shoot(win, path.join(OUT, 'golive.png'));

  // on-air dress rehearsal: the lamp, the chips and the program bezel all have
  // to change together, so they are checked together
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('vmxLamp').className = 'vmx-lamp on';
    document.getElementById('vmxLampTxt').textContent = 'ON AIR';
    document.getElementById('vmx').classList.add('on-air');
    document.getElementById('vmxStStream').classList.remove('hidden');
    document.getElementById('vmxStBitrate').textContent = '4500 kbps';
    document.getElementById('vmxStStreamTime').textContent = '00:41:12';
    document.getElementById('vmxStRec').classList.remove('hidden');
    document.getElementById('vmxStRecTime').textContent = '00:41:08';
    document.getElementById('vmxStream').classList.add('on', 'blink');
    document.getElementById('vmxRecord').classList.add('on', 'blink');
    document.getElementById('vmxStMsg').textContent = 'Streaming to Facebook + YouTube';
    return true;
  })()`);
  await shoot(win, path.join(OUT, 'golive-onair.png'));

  // an empty board with the set-up drawer open
  const empt = await win.webContents.executeJavaScript(`(() => { try {
    window.LiveStudio.__test.closeAllInputs();
    document.getElementById('vmxLamp').className = 'vmx-lamp';
    document.getElementById('vmxLampTxt').textContent = 'OFF AIR';
    document.getElementById('vmx').classList.remove('on-air');
    document.getElementById('vmxStStream').classList.add('hidden');
    document.getElementById('vmxStRec').classList.add('hidden');
    document.getElementById('vmxStream').classList.remove('on', 'blink');
    document.getElementById('vmxRecord').classList.remove('on', 'blink');
    document.getElementById('vmxStMsg').textContent = '';
    document.getElementById('vmxMore').click();
    return { inputs: window.LiveStudio.__test.state().inputs.length,
             drawerOpen: !document.getElementById('vmxDrawer').classList.contains('hidden'),
             emptyHint: !!document.querySelector('#vmxInputs .vmx-rail-empty') };
  } catch (e) { return { err: e.message + '\\n' + e.stack }; } })()`);
  console.log('emptied', JSON.stringify(empt));
  await sleep(500);
  await shoot(win, path.join(OUT, 'golive-empty.png'));

  win.destroy();
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
