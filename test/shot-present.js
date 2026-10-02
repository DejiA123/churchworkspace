'use strict';
/*
 * Screenshot the Presentation Studio, so the layout can be LOOKED AT rather
 * than reasoned about. Writes present-show.png (Show tab, the one that had
 * fourteen sections open at once) and present-media.png (the picture panel).
 *
 *   MW_SAMPLE_DIR=<dir> npx electron test/shot-present.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const WORK = path.join(os.tmpdir(), 'mw-shot-present');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVQI12P4//8/w38GIAXDIBKE0DHxgljNBAAO9TXL0Y4OHwAAAABJRU5ErkJggg==',
  'base64');
const IMG = path.join(WORK, "Sunday's notices.png");
fs.writeFileSync(IMG, PNG);

const ok = (data) => ({ ok: true, data });
ipcMain.handle('dialog:openFile', () => ok(IMG));
ipcMain.handle('settings:get', () => ok({ present: {}, brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', () => ok(true));
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:saveTheme', (e, { theme }) => ok(theme));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A screenshot harness that can hang is worse than no screenshot harness: it
// looks exactly like a broken app until someone checks the CPU.
setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 90000).unref();
const race = (p, ms, what) => Promise.race([p, sleep(ms).then(() => `(timed out: ${what})`)]);

/** capturePage returns blank frames until the compositor has really painted. */
async function shot(win, file) {
  for (let i = 0; i < 12; i++) {
    const img = await win.webContents.capturePage();
    const buf = img.toPNG();
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
    document.querySelector('[data-view="present"]').click();
    await new Promise(r => setTimeout(r, 600));
    const T = window.Presenter.__test;
    T.newDoc('Amazing Grace', 'song');
    T.setSlideText(0, 'Amazing grace, how sweet the sound\\nThat saved a wretch like me');
    T.addSlide(); T.setSlideText(1, 'I once was lost, but now am found\\nWas blind, but now I see');
    T.selectSlide(0);
    await T.addMediaViaButton();
    T.setTab('show');
    return 1;
  })()`);
  await sleep(900);
  console.log('present-show.png', await shot(win, path.join(OUT, 'present-show.png')));

  await race(win.webContents.executeJavaScript(`window.Presenter.__test.setTab('media');`), 8000, 'setTab(media)');
  await sleep(700);
  console.log('present-media.png', await race(shot(win, path.join(OUT, 'present-media.png')), 20000, 'capture'));

  win.destroy();
  app.exit(0);
});
