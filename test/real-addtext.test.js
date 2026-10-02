'use strict';
/*
 * Reproduces the user's EXACT flow: load a REAL video through the real loadVideo
 * path (Browse dialog), then click "Add text" and type with REAL keystrokes.
 * Tests both paused and playing, and clicking-to-edit.
 * Run:  npx electron test/real-addtext.test.js
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const video = require('../src/main/video');
const captioner = require('../src/main/captioner');

const CLIP = 'C:/Users/dejia/AppData/Local/Temp/mw-clip8.mp4';
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const ctx = () => ({ ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path });

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('dialog:openFile', () => ok(CLIP));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx(), input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(os.tmpdir(), 'mw-t-' + Date.now() + '.png'); await video.thumbnail(ctx(), { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(os.tmpdir(), 'mw-s-' + Date.now() + '.png'); await video.filmstrip(ctx(), { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(os.tmpdir(), 'mw-w-' + Date.now() + '.png'); await video.waveform(ctx(), { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => { const b = fs.readFileSync(p); return 'data:image/png;base64,' + b.toString('base64'); }));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

async function typeWord(win, word) {
  for (const ch of word) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(14);
  }
  await sleep(150);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 850,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1400);
  win.focus(); win.webContents.focus();

  // Show Video Studio, then click Browse -> loads the REAL clip via loadVideo().
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    document.getElementById('veOpen2').click();
    return true;
  })()`);

  // Wait for the real load to finish (name updates + a video ref set).
  let loaded = false;
  for (let i = 0; i < 30 && !loaded; i++) {
    await sleep(500);
    loaded = await win.webContents.executeJavaScript(`(document.getElementById('veName').textContent||'').indexOf('mw-clip8') >= 0`);
  }
  log(loaded, 'real video loaded through the Browse/loadVideo path', 'name=' + await win.webContents.executeJavaScript(`document.getElementById('veName').textContent`));
  await sleep(400);

  // ---- Scenario 1: PAUSED (fresh upload) -> Add text -> type ----
  console.log('\n[1] Fresh upload (paused): Add text -> type');
  await win.webContents.executeJavaScript(`document.getElementById('veAddText').click()`);
  await sleep(250);
  const s1 = await win.webContents.executeJavaScript(`(() => { const ae=document.activeElement; const c=document.querySelector('#veTextLayer .ve-text-content'); const ph=document.getElementById('veDrop').clientHeight||400; return { boxes: document.querySelectorAll('#veTextLayer .ve-text-box').length, focused: !!ae && ae.classList && ae.classList.contains('ve-text-content'), txt: (c||{}).innerText, fontPx: c ? parseFloat(getComputedStyle(c).fontSize) : null, expectedPx: Math.max(8, Math.round(0.11 * ph)) }; })()`);
  log(s1.boxes >= 1, 'Add text creates a box on the real video', s1.boxes + ' box; shows "' + s1.txt + '"');
  log(s1.focused, 'the box is auto-focused for typing');
  log(s1.fontPx != null && Math.abs(s1.fontPx - s1.expectedPx) <= 1 && s1.fontPx > 10, 'the text renders VISIBLY at sizePct×previewHeight (not a 1px "_")', s1.fontPx + 'px (expected ' + s1.expectedPx + 'px)');
  await typeWord(win, 'HELLO');
  const t1 = await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('#veTextLayer .ve-text-content');return c?c.innerText:null;})()`);
  log(t1 && t1.replace(/\s+/g, ' ').trim() === 'HELLO', 'typing replaces "Your text" on the real video', JSON.stringify(t1));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(200);

  // ---- Scenario 2: PLAYING -> Add text -> type ----
  console.log('\n[2] While PLAYING: Add text -> type');
  await win.webContents.executeJavaScript(`(() => { const p=document.getElementById('vePlayer'); p.currentTime=1; const pr=p.play(); if(pr&&pr.catch)pr.catch(()=>{}); return true; })()`);
  await sleep(500);
  await win.webContents.executeJavaScript(`document.getElementById('veAddText').click()`);
  await sleep(250);
  const s2 = await win.webContents.executeJavaScript(`(() => { const ae=document.activeElement; return { focused: !!ae && ae.classList && ae.classList.contains('ve-text-content') }; })()`);
  log(s2.focused, 'the box is auto-focused even while the video is playing');
  await typeWord(win, 'WORLD');
  const t2 = await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('#veTextLayer .ve-text-content[contenteditable="true"]')||document.querySelector('#veTextLayer .ve-text-content');return c?c.innerText:null;})()`);
  log(t2 && /WORLD/.test(t2), 'typing works while the video is playing', JSON.stringify(t2));

  // ---- Scenario 3: the user's REAL flow — add text, click AWAY, then single-CLICK
  //      the box to edit and type (people don't know to double-click). ----
  console.log('\n[3] Add text, click away, then single-click the box to edit');
  // clean slate: remove the boxes from scenarios 1&2 so there is exactly ONE box
  await win.webContents.executeJavaScript(`(() => { const p=document.getElementById('vePlayer'); p.pause(); p.currentTime=2; window.VideoEditor.__test.clearText(); return true; })()`);
  await sleep(150);
  await win.webContents.executeJavaScript(`document.getElementById('veAddText').click()`);
  await sleep(250);
  // simulate clicking AWAY (commit + leave edit mode), like a user looking at the video
  await win.webContents.executeJavaScript(`(() => { const c=document.querySelector('#veTextLayer .ve-text-content'); if(c)c.blur(); return true; })()`);
  await sleep(200);
  const away = await win.webContents.executeJavaScript(`(() => { const ae=document.activeElement; return { editingNow: !!ae && ae.classList && ae.classList.contains('ve-text-content'), boxes: document.querySelectorAll('#veTextLayer .ve-text-box').length, txt: (document.querySelector('#veTextLayer .ve-text-content')||{}).innerText }; })()`);
  log(!away.editingNow && away.boxes === 1, 'after clicking away, the single box is NOT in edit mode (shows "' + away.txt + '")');

  // now SINGLE-CLICK the box at its center with a real mouse event
  const rect = await win.webContents.executeJavaScript(`(() => { const b=document.querySelector('#veTextLayer .ve-text-box'); if(!b)return null; const r=b.getBoundingClientRect(); return { x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2) }; })()`);
  log(!!rect, 'found the text box to click', rect ? rect.x + ',' + rect.y : 'none');
  if (rect) {
    win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sleep(300);
    const editing = await win.webContents.executeJavaScript(`(() => { const ae=document.activeElement; return !!ae && ae.classList && ae.classList.contains('ve-text-content'); })()`);
    log(editing, 'a SINGLE click on the text box enters edit mode (ready to type)');
    await typeWord(win, 'AMEN');
    const t3 = await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('#veTextLayer .ve-text-content');return c?c.innerText:null;})()`);
    log(t3 && /AMEN/.test(t3), 'single-click then type actually edits the text', JSON.stringify(t3));
  }

  console.log('\n==================  real add-text test ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
