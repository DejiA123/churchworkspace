'use strict';
/*
 * FAITHFUL "Add text -> type" test. Boots the real renderer, clicks the real
 * "Add text" button, then sends REAL keystrokes via webContents.sendInputEvent
 * (exactly what a user's keyboard does) and verifies the overlay text changes.
 * Run:  npx electron test/text-typing.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const video = require('../src/main/video');

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: os.tmpdir(), userData: os.tmpdir(), ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(true));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : '')); if (!okv) failed = true; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1280, height: 820,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1400);
  win.focus(); win.webContents.focus();

  // Activate the Video Studio, load a fake video, pause on a frame.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    window.VideoEditor.__test.loadFake({ durationSec: 145, width: 1920, height: 1080 });
    document.getElementById('vePlayer').style.display = 'block';
    window.VideoEditor.__test.seekAndRefresh(10);
    return true;
  })()`);
  await sleep(300);

  // Click the REAL "Add text" button, exactly like the user.
  await win.webContents.executeJavaScript(`document.getElementById('veAddText').click()`);
  await sleep(200); // let the setTimeout(startEditingText) run

  // Is the contenteditable focused & ready?
  const state = await win.webContents.executeJavaScript(`(() => {
    const ae = document.activeElement;
    return {
      boxes: document.querySelectorAll('#veTextLayer .ve-text-box').length,
      activeIsContent: !!ae && ae.classList && ae.classList.contains('ve-text-content'),
      editable: !!ae && ae.getAttribute && ae.getAttribute('contenteditable') === 'true',
    };
  })()`);
  log(state.boxes >= 1, 'Add text creates a text box', state.boxes + ' box(es)');
  log(state.activeIsContent, 'the text box is auto-FOCUSED for typing (activeElement is the editable content)');
  log(state.editable, 'the focused element is contenteditable');

  // Type REAL keystrokes (this is the actual user keyboard path).
  const word = 'SUNDAY 10AM';
  for (const ch of word) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(12);
  }
  await sleep(150);

  const liveText = await win.webContents.executeJavaScript(`(() => {
    const c = document.querySelector('#veTextLayer .ve-text-content');
    return c ? c.innerText : null;
  })()`);
  log(liveText && liveText.replace(/\s+/g, ' ').trim() === word, 'typing on the keyboard actually enters text into the box', JSON.stringify(liveText));

  // Commit with Enter, then confirm it stuck on the overlay.
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(200);
  const committed = await win.webContents.executeJavaScript(`(() => window.VideoEditor.__test.textOverlayCount() > 0
    ? (function(){ const layer=document.getElementById('veTextLayer'); const c=layer.querySelector('.ve-text-content'); return c?c.innerText:null; })() : null)()`);
  log(committed && committed.replace(/\s+/g, ' ').trim() === word, 'text stays after pressing Enter (committed to the overlay)', JSON.stringify(committed));

  /* ----- Scenario B: the REAL condition — a re-render (as a playing video's
     timeupdate fires) happens in the gap before editing starts. This is what
     actually breaks it for the user. ----- */
  console.log('\n[B] Add text while the timeline re-renders (playing video race)');
  await win.webContents.executeJavaScript(`(() => {
    window.VideoEditor.__test.loadFake({ durationSec: 145, width: 1920, height: 1080 }); // resets overlays
    window.VideoEditor.__test.seekAndRefresh(20);
    // Click Add text, then IMMEDIATELY force a re-render (simulating a timeupdate
    // firing during playback) BEFORE the edit-start timer runs.
    document.getElementById('veAddText').click();
    window.VideoEditor.__test.seekAndRefresh(20.1); // <-- clobbers the freshly-made box if unguarded
    return true;
  })()`);
  await sleep(200);
  win.webContents.focus();
  const focusB = await win.webContents.executeJavaScript(`(() => {
    const ae = document.activeElement;
    return { activeIsContent: !!ae && ae.classList && ae.classList.contains('ve-text-content') };
  })()`);
  const wordB = 'GRACE';
  for (const ch of wordB) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: ch });
    await sleep(12);
  }
  await sleep(150);
  const liveB = await win.webContents.executeJavaScript(`(() => { const c = document.querySelector('#veTextLayer .ve-text-content'); return c ? c.innerText : null; })()`);
  log(focusB.activeIsContent, '[race] box still focused after an interim re-render', 'focused=' + focusB.activeIsContent);
  log(liveB && liveB.replace(/\\s+/g, ' ').trim() === wordB, '[race] typing works even if the timeline re-rendered first', JSON.stringify(liveB));

  console.log('\n==================  text typing test ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
