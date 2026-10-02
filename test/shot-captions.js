'use strict';
/*
 * Screenshot the captions window — closed and with the Accuracy panel open —
 * so the layout is LOOKED AT, not inferred from element heights.
 *
 *   MW_SAMPLE_DIR=<dir> npx electron test/shot-captions.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const WORK = path.join(os.tmpdir(), 'mw-shot-captions');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Anton', 'Bebas Neue', 'Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:models', () => ok([
  { id: 'tiny.en', name: 'Tiny (fastest, roughest)', sizeMB: 78, bundled: true, installed: true, inUse: false },
  { id: 'base.en', name: 'Base (ships with the app)', sizeMB: 148, bundled: true, installed: true, inUse: true },
  { id: 'small.en', name: 'Small — much more accurate', sizeMB: 466, bundled: false, installed: false, downloadable: true, inUse: false },
  { id: 'medium.en', name: 'Medium — the most accurate', sizeMB: 1536, bundled: false, installed: false, downloadable: true, inUse: false },
]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'not needed' }));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 90000).unref();

async function shot(win, file) {
  for (let i = 0; i < 12; i++) {
    const buf = (await win.webContents.capturePage()).toPNG();
    if (buf.length > 20000) { fs.writeFileSync(file, buf); return buf.length; }
    await sleep(400);
  }
  return 0;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, sandbox: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1800);
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view="video"]').click();
    await new Promise(r => setTimeout(r, 500));
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: 600, width: 1920, height: 1080 });
    T.applyClips([{ start: 60, end: 130, label: 'Rain we know' }]);
    const words = 'RAIN WE KNOW|IS COMING|BUT THE HARVEST|IS ALREADY PROMISED|LIFT UP YOUR HEAD|THE SEASON HAS TURNED'.split('|');
    T.setCapEvents(Array.from({length: 109}, (_, i) => ({
      start: 61 + i * 0.6, end: 61.5 + i * 0.6, text: words[i % words.length]
    })), 0);
    T.clickClipCaption(T.segments()[0].id);
    return 1;
  })()`);
  await sleep(900);
  console.log('captions-closed.png', await shot(win, path.join(OUT, 'captions-closed.png')));

  await win.webContents.executeJavaScript(`window.VideoEditor.__test.openCapFold(1); return 1;`);
  await sleep(700);
  console.log('captions-accuracy.png', await shot(win, path.join(OUT, 'captions-accuracy.png')));

  win.destroy();
  app.exit(0);
});
