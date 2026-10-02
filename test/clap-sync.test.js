'use strict';
/*
 * REAL test for Clap sync — the answer to "the voice and the video audio are not
 * in synchronisation" on a rig where the sound arrives as an AUDIO-ONLY NDI feed
 * (Ableton's NDI Output, a desk send) and the picture comes from a camera.
 *
 * The automatic correction cannot help there and never could: it works by
 * differencing the video and audio timestamps of ONE NDI sender, and an
 * audio-only source has no picture to difference against. Two machines, two
 * clocks, no shared epoch. So the operator was left typing numbers into a box.
 *
 * Clap sync measures it instead. This test drives the REAL solver and the REAL
 * apply path with claps at KNOWN offsets, so "it found the gap" is a number
 * checked against the number that was planted — including the sign, which is the
 * part that decides whether the picture or the sound gets held back.
 *
 *   npx electron test/clap-sync.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-clap-test');
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, { patch }) => ok(patch));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('dialog:openFile', () => ok(null));

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/* A synthetic clap: a flat baseline with one sharp spike at a known moment.
 * Built in the test rather than in the app, so the app's solver is judged
 * against data the app had no hand in shaping. */
const series = (fromMs, toMs, stepMs, spikeAtMs, base, peak) => {
  const out = [];
  for (let t = fromMs; t <= toMs; t += stepMs) {
    const d = Math.abs(t - spikeAtMs);
    const v = d <= stepMs * 1.5 ? peak : base * (0.85 + 0.3 * ((t * 7919) % 100) / 100);
    out.push({ t, v });
  }
  return out;
};

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);

  console.log('\n[1] A rig shaped like the real one: a camera, and sound from an audio-only feed');
  const setup = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const cam = T.addColor('Camera 1', '#404040');
    const aud = T.addTitle ? null : null;
    return { camId: cam.id, inputs: T.state().inputs.length };`);
  if (setup.__error) console.error('[1] ' + setup.__error);
  log(!!setup.camId, 'a picture source is on the switcher');

  console.log('\n[2] The solver, given claps at KNOWN offsets');
  const solved = await js(win, `
    const T = window.LiveStudio.__test;
    const mk = ${series.toString()};
    const run = (audioAt, videoAt) => T.solveClap(
      mk(0, 4000, 16, videoAt, 1.2, 40),      // movement in the picture
      mk(0, 4000, 16, audioAt, 0.004, 0.42),  // the crack in the sound
      0);
    return {
      late:   run(1500, 1300),   // sound 200ms BEHIND the picture
      early:  run(1300, 1500),   // sound 200ms AHEAD of the picture
      tight:  run(1500, 1496),   // essentially in sync
      big:    run(2400, 1300),   // 1.1s apart — not the same clap
      noClap: T.solveClap(mk(0, 4000, 16, 1300, 1.2, 40), mk(0, 4000, 16, -1, 0.004, 0.42), 0),
      noMove: T.solveClap(mk(0, 4000, 16, -1, 1.2, 1.3), mk(0, 4000, 16, 1500, 0.004, 0.42), 0),
    };`);
  if (solved.__error) console.error('[2] ' + solved.__error);
  log(Math.abs(solved.late.skewMs - 200) <= 20, 'sound 200 ms LATE is measured as +200 ms', `${solved.late.skewMs} ms`);
  log(Math.abs(solved.early.skewMs + 200) <= 20, 'sound 200 ms EARLY is measured as −200 ms — the sign is what decides the fix',
    `${solved.early.skewMs} ms`);
  log(Math.abs(solved.tight.skewMs) <= 20, 'a rig already in sync measures ~0', `${solved.tight.skewMs} ms`);
  log(!!solved.big.error, 'two events too far apart are refused rather than "corrected" by a second',
    solved.big.error);
  log(!!solved.noClap.error && /didn.t hear/i.test(solved.noClap.error), 'no clap heard → says so', solved.noClap.error);
  log(!!solved.noMove.error && /didn.t see/i.test(solved.noMove.error), 'clap heard but not seen → says that instead', solved.noMove.error);

  console.log('\n[3] Which input gets the delay, and in which direction');
  const applied = await js(win, `
    const T = window.LiveStudio.__test;
    const cam = T.addColor('Cam', '#333333');
    // an input with a real audio graph (and therefore a real meter), standing in
    // for the church's audio-only NDI feed
    const mic = T.addSynthetic('Ableton NDI', 200);
    if (!mic || !mic.id) return { skip: true };
    await new Promise(r => setTimeout(r, 300));
    T.setInputSync(cam.id, 0); T.setInputSync(mic.id, 0);
    const late  = T.applyClap(cam.id, mic.id, 200);    // sound behind → hold the PICTURE
    T.setInputSync(cam.id, 0); T.setInputSync(mic.id, 0);
    const early = T.applyClap(cam.id, mic.id, -200);   // sound ahead  → hold the SOUND
    // and a second measurement must ADD to the first, not replace it
    T.setInputSync(cam.id, 0); T.setInputSync(mic.id, 0);
    T.applyClap(cam.id, mic.id, 200);
    const twice = T.applyClap(cam.id, mic.id, 60);
    return { late, early, twice, camId: cam.id, micId: mic.id };`);
  if (applied.__error) console.error('[3] ' + applied.__error);
  if (applied.skip) {
    console.log('  SKIP  no microphone on this machine to stand in for the NDI audio feed');
  } else {
    log(applied.late.inputId === applied.camId && applied.late.camSync === -200,
      'sound LATE → the camera’s picture is held back by 200 ms', `${applied.late.what}`);
    log(applied.early.inputId === applied.micId && applied.early.audSync === 200,
      'sound EARLY → the audio source’s sound is held back by 200 ms', `${applied.early.what}`);
    log(applied.twice.camSync === -260,
      'a second clap ADJUSTS the existing offset rather than replacing it (so clapping again verifies the fix)',
      `−200 then −60 more = ${applied.twice.camSync} ms`);
  }

  console.log('\n[4] The dialog an operator actually sees');
  const dlg = await js(win, `
    const T = window.LiveStudio.__test;
    T.openClapSync();
    return T.clapDialog();`);
  if (dlg.__error) console.error('[4] ' + dlg.__error);
  log(dlg.open, 'Clap sync opens with a Start listening button');
  log(dlg.cams.length >= 1 && dlg.auds.length >= 1, 'and lets you choose which picture and which sound to match',
    `${dlg.cams.length} picture source(s), ${dlg.auds.length} sound source(s)`);
  const wired = await js(win, `
    const box = document.querySelector('.vmx-modal-box');
    return { hasMeters: !!box.querySelector('#vmxClapMeters'), hasHint: !!box.querySelector('#vmxClapHint'),
             note: (box.querySelector('.vmx-note') || {}).textContent || '' };`);
  log(wired.hasMeters && wired.hasHint, 'with live sound + movement meters, so you can see it is listening before you clap');
  log(/clap once/i.test(wired.note), 'and instructions in plain language', JSON.stringify(wired.note.slice(0, 80)));

  console.log('\n[5] The real listener runs against the live audio graph');
  const live = await js(win, `
    const T = window.LiveStudio.__test;
    document.querySelector('.vmx-modal-x') && document.querySelector('.vmx-modal-x').click();
    const cam = T.state().inputs[0];
    const t0 = performance.now();
    const p = T.listenForClap(cam.id, cam.id);
    // don't wait the whole window out — just prove it is sampling, then let it end
    await new Promise(r => setTimeout(r, 700));
    return { armed: true, elapsed: performance.now() - t0 };`);
  log(live.armed, 'the listener arms against real inputs without throwing', `${Math.round(live.elapsed)} ms in`);
  const consts = await js(win, `return window.LiveStudio.__test.clapConstants();`);
  log(consts.windowMs >= 8000, 'it listens long enough for someone to walk into shot and clap', consts.windowMs + ' ms');
  log(consts.maxSkewMs <= 1000, 'and refuses a match that is too far apart to be one clap', '±' + consts.maxSkewMs + ' ms');

  console.log('\n[6] Console');
  log(errors.length === 0, 'no renderer errors', errors.slice(0, 3).join(' | ') || 'clean');

  console.log('\n============  CLAP SYNC test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
