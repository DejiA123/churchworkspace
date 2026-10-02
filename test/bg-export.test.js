'use strict';
/*
 * ⇥ EXPORT IN THE BACKGROUND, in the real Video Studio.
 *
 * The complaint was one sentence: "let it be possible for the export to be done
 * in the background so I can still do other things on the software". The work
 * was never the obstacle — ffmpeg has always run in the main process, so the
 * renderer spends a forty-minute export awaiting IPC and nothing else. The
 * obstacle was the full-screen overlay in front of it.
 *
 * So this test is not about speed. It asks three questions, and the third is the
 * one that decides whether the feature is any good:
 *
 *   1. Can the operator get out from behind the modal — both by pressing ⇥ on a
 *      running export, and by ticking the header box so it never appears?
 *   2. While it runs, is the app really usable: can they leave the Video Studio,
 *      is the corner telling them what is happening, can they stop it?
 *   3. ►► DOES WHAT IT SAVES STAY WHAT THEY ASKED FOR? ◄◄ An export is a chain
 *      (encode, then text, then captions, then music, then the outro) and every
 *      link after the first used to read the timeline LIVE. A background export
 *      is worthless — worse than worthless — if typing a caption or loading a
 *      music bed while it runs silently rewrites the file it is in the middle
 *      of producing.
 *
 * The exports are faked (a slow no-op that writes a stub file), because what is
 * under test is the renderer's job plumbing, not ffmpeg. The fakes record
 * exactly what they were asked to render, which is how (3) is checked.
 *
 *   npx electron test/bg-export.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-bgexport-test');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'service-20s.mp4');
const MUSIC = path.join(WORK, 'bed.m4a');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildSrc() {
  if (!fs.existsSync(SRC) || fs.statSync(SRC).size < 20000) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '20', '-i', 'color=c=0x2060A0:s=640x360:r=30',
      '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=220:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
  }
  if (!fs.existsSync(MUSIC)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '20', '-i', 'sine=frequency=440:sample_rate=44100',
      '-c:a', 'aac', MUSIC], { stdio: 'ignore' });
  }
}

/* ------------------------------ fake renderers ---------------------------
 * Each one takes a beat (so the test can look at the studio while it is
 * "running") and writes down what it was handed. `HOLD` is released by the test
 * when it wants a step to finish. */
const calls = { exportShort: [], burnImages: [], burnCaps: [], mixMusic: [], appendClips: [], overlayComposite: [] };
let holdExport = null;              // resolve() lets the current encode finish
const stub = (name) => { const p = path.join(WORK, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.mp4`); fs.writeFileSync(p, 'x'); return p; };

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [{ id: 'm1', name: 'Bed', file: MUSIC, durationSec: 20 }], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'not needed' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: 1200, height: 90, output });
  return ok(output);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 12, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) =>
  ok(`data:image/png;base64,${fs.readFileSync(p).toString('base64')}`));
ipcMain.handle('fs:rmdir', () => ok(true));

/*
 * The encode. It reports progress the way the real one does (that is how the
 * chip's bar is fed) and then waits to be released, so the test can inspect a
 * genuinely mid-flight export rather than racing it.
 */
ipcMain.handle('sermon:exportShort', async (e, a) => {
  calls.exportShort.push({ startSec: a.startSec, endSec: a.endSec, preset: a.preset, label: a.label, jobId: a.jobId });
  for (const pct of [20, 55, 80]) {
    if (!e.sender.isDestroyed()) e.sender.send('job:progress', { jobId: a.jobId, percent: pct });
    await sleep(60);
  }
  if (holdExport) await holdExport;
  return ok(stub('edited'));
});
ipcMain.handle('overlays:burnImages', async (_e, a) => {
  calls.burnImages.push({ input: a.input, images: (a.images || []).length });
  await sleep(50);
  return ok(stub('text'));
});
ipcMain.handle('overlays:burn', async (_e, a) => {
  calls.burnImages.push({ input: a.input, images: (a.overlays || []).length, ass: true });
  await sleep(50);
  return ok(stub('text'));
});
ipcMain.handle('captions:burnTrack', async (_e, a) => { calls.burnCaps.push({ frames: (a.track && a.track.frames || []).length }); await sleep(50); return ok(stub('caps')); });
ipcMain.handle('captions:burn', async (_e, a) => { calls.burnCaps.push({ events: (a.events || []).length, ass: true }); await sleep(50); return ok(stub('caps')); });
ipcMain.handle('video:mixMusic', async (_e, a) => { calls.mixMusic.push({ musicPath: a.musicPath, musicVolume: a.musicVolume }); await sleep(50); return ok(stub('music')); });
ipcMain.handle('video:appendClips', async (_e, a) => { calls.appendClips.push({ clips: (a.clips || []).length }); await sleep(50); return ok(stub('outro')); });
ipcMain.handle('video:overlayComposite', async (_e, a) => { calls.overlayComposite.push({ overlays: (a.overlays || []).length }); await sleep(50); return ok(stub('ovl')); });
ipcMain.handle('job:cancel', () => ok({ cancelled: true, killed: 1 }));

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  console.log('\n[0] A 20-second recording and a music bed');
  buildSrc();
  const info = await video.getInfo(ctx, SRC);
  log(info.durationSec > 15, 'built the source', `${info.width}x${info.height} ${info.durationSec.toFixed(1)}s`);

  const errors = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);

  const open = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)});
    const T = window.VideoEditor.__test;
    T.setBgExport(false);
    // The studio REMEMBERS a music bed and an outro between sittings (that is
    // the point of the library), and this profile is reused between runs — so
    // start from a clean desk or [3] measures the last run's leftovers.
    T.clearMusic(); T.clearOutro();
    return { segs: T.segments().length, span: T.editedSpan(), box: !!document.getElementById('veBgExport'),
             dock: T.bgDock(), music: T.musicState(), outro: T.outroState() };`);
  if (open.__error) console.error('[0] ' + open.__error);
  log(open.segs === 1 && !!open.span, 'the recording is on the timeline');
  log(!open.music && !open.outro, 'starting from a clean desk: no music bed, no outro',
    JSON.stringify({ music: open.music, outro: open.outro }));
  log(open.box === true, 'the studio offers "⇥ Export in the background" in its header');
  log(open.dock && !open.dock.shown, 'and the corner is empty before anything runs');

  /* =================================================================== */
  console.log('\n[1] Press ⇥ on a running export and the studio comes back');
  let release;
  holdExport = new Promise((r) => { release = r; });
  const mid = await js(win, `
    const T = window.VideoEditor.__test;
    const p = T.exportEditedVideo();      // deliberately NOT awaited: it is still running
    window.__bgTestExport = p;
    await new Promise(r => setTimeout(r, 260));
    const before = { overlay: T.overlayUp(), btn: T.backgroundButton() };
    const clicked = T.clickRunInBackground();
    await new Promise(r => setTimeout(r, 120));
    return { before, clicked, after: { overlay: T.overlayUp(), dock: T.bgDock() } };`);
  if (mid.__error) console.error('[1] ' + mid.__error);
  log(mid.before.overlay === true, 'it starts in front of you, as it always has');
  log(!!(mid.before.btn && mid.before.btn.shown), 'the progress screen offers a way out', mid.before.btn && mid.before.btn.text);
  log(mid.clicked === true && mid.after.overlay === false, '►► pressing it takes the progress screen away while the export carries on');
  log(!!(mid.after.dock && mid.after.dock.shown && mid.after.dock.jobs.length === 1),
    'and the corner picks it up instead', mid.after.dock && mid.after.dock.head);
  const chip = (mid.after.dock && mid.after.dock.jobs[0]) || {};
  log(/edited video/i.test(chip.title), 'the chip says WHICH export it is', chip.title);
  log(chip.pct > 2, 'with the live percentage the overlay was showing', chip.pct + '%');
  log(chip.canStop === true, 'and a way to stop it');

  console.log('\n[2] The whole app is usable while it runs');
  const usable = await js(win, `
    const T = window.VideoEditor.__test;
    document.querySelectorAll('.nav-item').forEach(b => { if (b.dataset.view === 'present') b.click(); });
    await new Promise(r => setTimeout(r, 200));
    const away = { view: (document.querySelector('.view.active') || {}).id, overlay: T.overlayUp(),
                   dock: T.bgDock() };
    document.querySelectorAll('.nav-item').forEach(b => { if (b.dataset.view === 'video') b.click(); });
    await new Promise(r => setTimeout(r, 150));
    return away;`);
  if (usable.__error) console.error('[2] ' + usable.__error);
  log(usable.view === 'view-present', 'you can walk to another studio mid-export', usable.view);
  log(usable.overlay === false, 'nothing is blocking it');
  log(!!(usable.dock && usable.dock.shown), 'and the export is still reported from there too');

  /* ======================= the one that matters ====================== */
  console.log('\n[3] ►► Editing while it runs cannot change the file it is writing ◄◄');
  const edited = await js(win, `
    const T = window.VideoEditor.__test;
    // Exactly the things the later links of the chain used to read live:
    T.addText();                                   // text over the picture
    T.useMusic('m1');                              // a music bed
    return { texts: T.textCount ? T.textCount() : null, music: T.musicState() };`);
  if (edited.__error) console.error('[3] ' + edited.__error);
  log(!!(edited.music && edited.music.file), 'a music bed was loaded AFTER the export started', edited.music && edited.music.id);

  release();                                       // let the encode finish
  holdExport = null;
  await js(win, 'await window.__bgTestExport; await new Promise(r => setTimeout(r, 400)); return true;');

  log(calls.exportShort.length === 1, 'exactly one encode ran', calls.exportShort.length + '');
  log(calls.burnImages.length === 0,
    'the text typed mid-export was NOT burned into it — it is not part of what was asked for',
    calls.burnImages.length + ' text burns');
  log(calls.mixMusic.length === 0,
    'nor was the music bed loaded mid-export mixed underneath it',
    calls.mixMusic.length + ' music mixes');
  const doneDock = await js(win, 'return window.VideoEditor.__test.bgDock();');
  const fin = (doneDock.jobs || [])[0] || {};
  log(fin.state === 'done', 'the chip reports it finished', fin.state);
  log(fin.canShow === true, 'and holds a button to show the file rather than yanking a window open over you');

  /* =================================================================== */
  console.log('\n[4] The same export, WITH those things, still carries them');
  calls.exportShort.length = 0; calls.burnImages.length = 0; calls.mixMusic.length = 0;
  const withExtras = await js(win, `
    const T = window.VideoEditor.__test;
    T.setBgExport(true);                 // straight to the corner, no modal at all
    const overlayEver = [];
    const t0 = Date.now();
    const p = T.exportEditedVideo();
    const tick = setInterval(() => overlayEver.push(T.overlayUp()), 40);
    await p;
    clearInterval(tick);
    return { overlayEver: overlayEver.some(Boolean), dock: T.bgDock(), ms: Date.now() - t0 };`);
  if (withExtras.__error) console.error('[4] ' + withExtras.__error);
  log(withExtras.overlayEver === false,
    'with the header box ticked the progress screen never appears at all');
  log(calls.exportShort.length === 1, 'the encode still ran', calls.exportShort.length + '');
  log(calls.burnImages.length === 1, 'and THIS time the text is burned in — it was there when export was pressed',
    calls.burnImages.length + ' text burns');
  log(calls.mixMusic.length === 1, 'and the music bed is mixed under it', calls.mixMusic.length + ' music mixes');
  log(calls.mixMusic[0] && calls.mixMusic[0].musicPath === MUSIC, 'the right track', calls.mixMusic[0] && path.basename(calls.mixMusic[0].musicPath || ''));

  /* =================================================================== */
  console.log('\n[5] Stopping one from the corner');
  calls.exportShort.length = 0;
  let release2;
  holdExport = new Promise((r) => { release2 = r; });
  const stoppedRun = await js(win, `
    const T = window.VideoEditor.__test;
    const p = T.exportEditedVideo();
    p.catch(() => {});
    await new Promise(r => setTimeout(r, 280));
    // Finished chips from earlier sections are still sitting in the dock, which
    // is the point of them — so pick the one that is actually RUNNING.
    const running = (T.bgDock().jobs || []).filter(j => j.canStop);
    const btn = document.querySelector('#bgDock [data-stop]');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 200));
    return { running, stopping: (T.bgDock().jobs || []).filter(j => j.canStop || /stopp/i.test(j.step || '')) };`);
  if (stoppedRun.__error) console.error('[5] ' + stoppedRun.__error);
  log(stoppedRun.running.length === 1, 'exactly one export is listed as running, beside the finished ones',
    stoppedRun.running.length + ' running');
  log(/Stopping/i.test((stoppedRun.stopping[0] || {}).step || ''),
    'the ✕ in the corner stops it', (stoppedRun.stopping[0] || {}).step);
  release2(); holdExport = null;
  await sleep(500);

  /* =================================================================== */
  console.log('\n[6] Nothing in the console');
  const real = errors.filter((m) => !/Autofill|devtools|Electron Security|preload/i.test(m));
  log(real.length === 0, 'no renderer errors while all of that happened', real.slice(0, 3).join(' | '));

  console.log(failed ? '\n❌ FAILED\n' : '\n✅ ALL PASSED\n');
  /*
   * Put the studio back the way it was found. "Export in the background" is a
   * REMEMBERED preference and every suite shares one Electron profile, so
   * leaving it on made add-media.test.js sit waiting for a finishedFile call
   * that a background export deliberately never makes.
   */
  await js(win, `window.VideoEditor.__test.setBgExport(false); return true;`);

  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
