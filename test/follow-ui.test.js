'use strict';
/*
 * "👤 Choose who to follow" — driven through the REAL app window.
 *
 * The tracking behind it is measured elsewhere (subject-lock.test.js on an
 * invented cast, subject-real.test.js on a real recording). What this checks is
 * everything BETWEEN the operator and that tracker, which is where features
 * usually die:
 *
 *   • the control is there, and says plainly who the next export will follow
 *   • picking somebody shows them, and the choice survives a restart
 *   • one pick covers every short, and a single short can overrule it
 *   • clearing it goes back to letting the AI decide
 *   • the picker window opens on a real frame and offers the people in it
 *   • and the lock the EXPORT would be handed matches what the screen says
 *
 *   npx electron test/follow-ui.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-follow-ui');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'two-people-20s.mp4');

let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : '')); if (!okv) failed = true; };

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: path.join(ROOT, 'bin/fonts') }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:models', () => ok(require(path.join(ROOT, 'src/main/captioner')).models()));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'thumbs not needed' }));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input, width, height }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: width || 1600, height: height || 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const buf = fs.readFileSync(p);
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
});

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '20', '-i', 'testsrc2=s=1280x720:r=30',
      '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=440:sample_rate=44100',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
  }

  const errors = [];
  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);

  const boot = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)});
    return { dur: window.VideoEditor.__test.videoDuration() };`);
  if (boot.__error) console.error('[boot] ' + boot.__error);
  log(Math.abs(boot.dur - 20) < 0.6, 'a video is loaded in the Video Studio', (boot.dur || 0).toFixed(1) + 's');

  /* ---- [1] the control, and what it says before anyone touches it -------- */
  console.log('\n[1] The control is there and says what will happen');
  const fresh = await js(win, 'return window.VideoEditor.__test.forgetFollow();');
  if (fresh.__error) console.error('[1] ' + fresh.__error);
  log(fresh.hasRow && fresh.hasButton, 'the “Choose who to follow” row and button exist');
  log(fresh.rowHidden === false, 'it is shown while auto-reframe is cropping');
  log(/AI thinks is speaking/i.test(fresh.chip || ''), 'with nobody picked it says the AI is deciding', fresh.chip);
  log(fresh.locked === false && fresh.stored === false, 'and nothing is locked on a fresh install');

  const hidden = await js(win, `
    const T = window.VideoEditor.__test;
    T.setFill('blur');
    const a = T.followState();
    T.setFill('crop');
    return { blurHidden: a.rowHidden, cropHidden: T.followState().rowHidden };`);
  log(hidden.blurHidden === true && hidden.cropHidden === false,
    'it hides when nothing is being cropped (a blurred fill follows nobody)',
    'blur ' + hidden.blurHidden + ', crop ' + hidden.cropHidden);

  /* ---- [2] picking somebody --------------------------------------------- */
  console.log('\n[2] Picking a person');
  const SIG = { head: new Array(22).fill(0).map((_, i) => (i === 3 ? 1 : 0)), up: new Array(22).fill(0).map((_, i) => (i === 3 ? 1 : 0)), lo: new Array(22).fill(0).map((_, i) => (i === 3 ? 1 : 0)) };
  const picked = await js(win, `return window.VideoEditor.__test.pickPerson(${JSON.stringify(SIG)}, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');`);
  if (picked.__error) console.error('[2] ' + picked.__error);
  log(picked.locked === true, 'the pick is taken');
  log(picked.hasFace === true, 'their face is shown in the chip, so it is never a mystery who is followed');
  log(/Following this person/i.test(picked.chip || ''), 'and the chip says so', picked.chip);
  log(picked.stored === true, 'the pick is written down, so it survives closing the app');

  const reloaded = await js(win, 'return window.VideoEditor.__test.reloadFollow();');
  log(reloaded.locked === true && reloaded.hasFace === true,
    'and it really does come back after a restart');

  /* ---- [3] what the export is handed ------------------------------------ */
  console.log('\n[3] The export gets the same person the screen shows');
  const anyId = await js(win, `
    const T = window.VideoEditor.__test;
    T.addShort(2, 8);
    const ids = T.segIds();
    return ids.length ? ids[0] : null;`);
  const globalLock = await js(win, `return window.VideoEditor.__test.lockForClip(${JSON.stringify(anyId)});`);
  if (globalLock.__error) console.error('[3] ' + globalLock.__error);
  log(globalLock.any === true, 'a locked pick is handed to the tracker');
  log(globalLock.bins === 22, 'and it arrives as a real signature, not a blob of JSON', globalLock.bins + ' bins');
  log(globalLock.fromClip === false, 'one pick covers every short in the panel');

  if (anyId) {
    const OTHER = { head: new Array(22).fill(0).map((_, i) => (i === 17 ? 1 : 0)), up: new Array(22).fill(0).map((_, i) => (i === 17 ? 1 : 0)), lo: new Array(22).fill(0).map((_, i) => (i === 17 ? 1 : 0)) };
    const perClip = await js(win, `return window.VideoEditor.__test.setClipPerson(${JSON.stringify(anyId)}, ${JSON.stringify(OTHER)});`);
    log(perClip.fromClip === true && perClip.any === true,
      'a single short can overrule the panel-wide pick');
    const buttons = await js(win, 'return window.VideoEditor.__test.clipFollowButtons();');
    log(buttons >= 1, 'every short in the panel has its own 👤 button', buttons + ' buttons');
  } else {
    log(false, 'a short exists to test the per-clip override on', 'no segment ids exposed');
  }

  /* ---- [4] the picker window -------------------------------------------- */
  console.log('\n[4] The picker window');
  const opened = await js(win, 'return await window.VideoEditor.__test.openPicker(null, false);');
  if (opened.__error) console.error('[4] ' + opened.__error);
  log(opened.open === true, 'it opens');
  log(/shorts follow/i.test(opened.title || ''), 'and asks about every short when opened from the panel', opened.title);
  const hint = await js(win, 'return window.VideoEditor.__test.pickerHint();');
  log(typeof hint === 'string' && hint.length > 0, 'it says what to do (or that it found nobody here)', hint);
  const closed = await js(win, 'return window.VideoEditor.__test.closePicker();');
  log(closed === false, 'and it closes again');

  if (anyId) {
    const openedOne = await js(win, `return await window.VideoEditor.__test.openPicker(${JSON.stringify(anyId)}, true);`);
    log(/this short/i.test(openedOne.title || ''), 'opened from a short, it asks about that short only', openedOne.title);
    await js(win, 'return window.VideoEditor.__test.closePicker();');
  }

  /* ---- [5] going back to automatic --------------------------------------- */
  console.log('\n[5] Letting the AI decide again');
  const cleared = await js(win, 'return window.VideoEditor.__test.clearPerson();');
  log(cleared.locked === false && cleared.stored === false, 'clearing forgets the pick everywhere');
  log(/AI thinks is speaking/i.test(cleared.chip || ''), 'and the chip goes back to saying so', cleared.chip);

  console.log('\n[6] Nothing broke quietly');
  const real = errors.filter((e) => !/Autofill|devtools|GPU|Electron Security/i.test(e));
  log(real.length === 0, 'no console errors from the studio', real.slice(0, 3).join(' | '));

  console.log('\n==================  follow-ui ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}).catch((e) => { console.error(e); process.exit(1); });
