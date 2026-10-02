'use strict';
/*
 * The Shorts-panel ▶ button is a real play/pause TOGGLE: click plays the clip and
 * the button becomes ⏸; clicking ⏸ pauses; clicking ▶ again RESUMES (not restart).
 * Uses a REAL clip through the real Browse/loadVideo path so <video> actually plays.
 * Run: npx electron test/clip-play-toggle.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const video = require('../src/main/video');
const captioner = require('../src/main/captioner');

const CLIP = 'C:/Users/dejia/AppData/Local/Temp/mw-clip8.mp4';
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const ctx = () => ({ ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path });

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'T', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('dialog:openFile', () => ok(CLIP));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx(), input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(os.tmpdir(), 'mw-t-' + Date.now() + '.png'); await video.thumbnail(ctx(), { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(os.tmpdir(), 'mw-s-' + Date.now() + '.png'); await video.filmstrip(ctx(), { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(os.tmpdir(), 'mw-w-' + Date.now() + '.png'); await video.waveform(ctx(), { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 850,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1400);

  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    document.getElementById('veOpen2').click();
    return true;
  })()`);
  let loaded = false;
  for (let i = 0; i < 30 && !loaded; i++) { await sleep(500); loaded = await win.webContents.executeJavaScript(`!!(window.VideoEditor && (document.getElementById('veName').textContent||'').indexOf('mw-clip8') >= 0)`); }
  log(loaded, 'real clip loaded');
  await sleep(600);

  // make a clip covering [1s..6s] and click its card ▶
  const st = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    const s = T.addManual(1, 6);
    const btn = document.querySelector('#veClipList [data-play="' + s.id + '"]');
    btn.click();
    return { id: s.id };
  })()`);
  await sleep(900);
  const playing = await win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('vePlayer');
    const b = document.querySelector('#veClipList [data-play="${st.id}"]');
    return { paused: p.paused, glyph: b.textContent, t: p.currentTime };
  })()`);
  log(playing.paused === false && playing.glyph === '⏸', 'clicking ▶ plays the clip and the button becomes ⏸', `glyph="${playing.glyph}" paused=${playing.paused}`);

  // click again -> PAUSE
  await win.webContents.executeJavaScript(`document.querySelector('#veClipList [data-play="${st.id}"]').click()`);
  await sleep(400);
  const paused = await win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('vePlayer');
    const b = document.querySelector('#veClipList [data-play="${st.id}"]');
    return { paused: p.paused, glyph: b.textContent, t: p.currentTime };
  })()`);
  log(paused.paused === true && paused.glyph === '▶', 'clicking ⏸ pauses and the button returns to ▶', `glyph="${paused.glyph}" paused=${paused.paused}`);

  // click a third time -> RESUME from the paused position (not restart at 1s)
  await win.webContents.executeJavaScript(`document.querySelector('#veClipList [data-play="${st.id}"]').click()`);
  await sleep(600);
  const resumed = await win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('vePlayer');
    const b = document.querySelector('#veClipList [data-play="${st.id}"]');
    return { paused: p.paused, glyph: b.textContent, t: p.currentTime };
  })()`);
  log(resumed.paused === false && resumed.glyph === '⏸', 'clicking ▶ again resumes playback (⏸ shown)', `glyph="${resumed.glyph}"`);
  log(resumed.t >= paused.t - 0.2, 'resume continues from the paused position (no restart)', `paused at ${paused.t.toFixed(2)}s, resumed at ${resumed.t.toFixed(2)}s`);

  console.log(`\n==================  clip play/pause toggle ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
