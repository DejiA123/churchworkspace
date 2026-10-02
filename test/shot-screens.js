'use strict';
// Screenshot the Presentation toolbar with the Screens picker open.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path'); const fs = require('fs'); const os = require('os');
const presenter = require('../src/main/presenter');
const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const ok = (d) => ({ ok: true, data: d });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT }));
for (const ch of ['video:presets','scheduler:list','accounts:list','fonts:data','photos:list','live:screenSources','bible:installed','bible:catalogue','bible:books']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:savePresentation', wrap((e,{presentation}) => presentation));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
// Pretend this booth has three screens, which is what a real church looks like.
const FAKE = [
  { id: '1', label: 'Main screen — 1920×1080', width:1920, height:1080, x:0, y:0, scaleFactor:1, primary:true, internal:true },
  { id: '2', label: 'Screen 2 — 1920×1080', width:1920, height:1080, x:1920, y:0, scaleFactor:1, primary:false, internal:false },
  { id: '3', label: 'Screen 3 — 1280×720', width:1280, height:720, x:3840, y:0, scaleFactor:1, primary:false, internal:false },
];
ipcMain.handle('present:displays', () => ok(FAKE));
ipcMain.handle('present:state', () => ok({ audience: true, stage: false, audienceDisplay: '2', stageDisplay: null,
  outputs: [{ role:'audience', id:'main', name:'Screen 2', displayId:'2', windowed:false, render:'normal' }],
  blackout:false, cleared:{}, displays: FAKE, suggested:'2' }));
ipcMain.handle('present:open', () => ok({ ok:true }));
ipcMain.handle('present:close', () => ok({ ok:true }));
ipcMain.handle('present:set', () => ok(true));
app.disableHardwareAcceleration();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show:true, width:1500, height:940, webPreferences:{ preload: path.join(__dirname,'..','src','main','preload.js'), contextIsolation:true } });
  await win.loadFile(path.join(__dirname,'..','src','renderer','index.html'));
  await sleep(1500);
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r=>setTimeout(r,500));
    const T = window.Presenter.__test;
    T.newDoc('Sunday'); T.setSlideText(0, 'HOLY IS THE LORD');
    await T.refreshOutputs();
    await T.openScreenMenu();
    return true;
  })()`);
  for (let i=0;i<8;i++){ await sleep(500); win.webContents.invalidate();
    const b=(await win.webContents.capturePage()).toPNG();
    if (b && b.length>8000){ fs.writeFileSync(path.join(OUT,'present-screens.png'), b); console.log('wrote present-screens.png ('+b.length+')'); break; } }
  win.destroy(); app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
