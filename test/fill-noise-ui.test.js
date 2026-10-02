'use strict';
/*
 * The two new Video Studio controls, driven through the REAL app window:
 *
 *   🖼️ Frame fill      crop / blur background / black bars
 *   🔇 Remove background noise, at a strength you pick
 *
 * The engines behind them are measured elsewhere (background-blur.test.js and
 * audio-clean.test.js render actual pixels and actual samples). What this checks
 * is everything BETWEEN the operator and those engines, which is where features
 * usually die:
 *
 *   • the controls exist, start at the old behaviour, and reveal their settings
 *   • picking "blur background" really does switch the PREVIEW from cropping to
 *     fitting — the whole picture, with the blurred backdrop actually on screen
 *   • auto-reframe is disabled while nothing is being cropped, so a ticked box
 *     can't quietly mean nothing
 *   • both choices survive a restart
 *   • and what the export is handed matches what the screen says
 *
 *   npx electron test/fill-noise-ui.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-fill-noise-ui');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'wide-20s.mp4');

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
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
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
const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
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
    return window.VideoEditor.__test.loadReal(${JSON.stringify(SRC)}).then(() => ({ dur: window.VideoEditor.__test.videoDuration() }));`);
  if (boot.__error) console.error('[boot] ' + boot.__error);
  log(Math.abs(boot.dur - 20) < 0.6, 'a 16:9 video is loaded in the Video Studio', (boot.dur || 0).toFixed(1) + 's');

  /* ---------- [1] the controls, and the old behaviour as the default ------ */
  console.log('\n[1] The controls exist and start where the app has always been');
  const fresh = await js(win, `
    const T = window.VideoEditor.__test;
    T.setAspect('reel-9x16');
    const r = T.forgetExportPrefs();
    const sel = document.getElementById('veFill');
    r.options = Array.from(sel.options).map(o => o.value);
    r.hasDenoiseBox = !!document.getElementById('veDenoise');
    r.hasTestBtn = !!document.getElementById('veDenoiseTest');
    // v2.79 Pro layout: these settings live in the Inspector's tabs, never in the Shorts bin.
    r.folded = !!document.querySelector('.ve-side #veFill') && !document.querySelector('.ve-bin #veFill') && !document.querySelector('.ve-bin #veDenoise');
    r.summary = document.getElementById('veExportSummary').textContent;
    return r;`);
  if (fresh.__error) console.error('[1] ' + fresh.__error);
  log(String(fresh.options) === 'crop,blur,bars', 'Frame fill offers crop / blur / bars', String(fresh.options));
  log(fresh.fill.mode === 'crop' && fresh.fill.cfg === null,
    'a fresh install still CROPS — nothing about existing exports changed', fresh.fill.mode);
  log(fresh.fill.optsVisible === false, 'the blur settings stay out of the way until blur is picked');
  log(fresh.denoise.on === false && fresh.denoise.cfg === null, 'background-noise removal is OFF by default');
  log(fresh.hasDenoiseBox && fresh.hasTestBtn, 'the noise option and its “hear the difference” button are both there');
  log(fresh.fill.reframeOn === true && fresh.fill.reframeDisabled === false, 'auto-reframe is live while cropping');
  log(fresh.folded === true, 'they live in the Inspector, so the Shorts list is never pushed down');
  log(fresh.summary === 'Crop to fill · noise off',
    'and the folded row still says what they are set to', fresh.summary);
  const summaryAfter = await js(win, `
    const T = window.VideoEditor.__test;
    T.setFill('blur'); T.setDenoise(true, 'strong');
    const s = document.getElementById('veExportSummary').textContent;
    T.forgetExportPrefs();
    return s;`);
  log(summaryAfter === 'Blurred background · noise strong', 'the row updates as the settings change', summaryAfter);

  /* ---------- [2] the PREVIEW switches from cropping to fitting ----------- */
  console.log('\n[2] Picking blur makes the preview show the WHOLE picture');
  // setFill (rather than just reading the state) so the preview is definitely
  // laid out before it is measured — reading it straight after boot can race the
  // video's first metadata event.
  const cropped = await js(win, 'return window.VideoEditor.__test.setFill("crop");');
  const blurred = await js(win, 'return window.VideoEditor.__test.setFill("blur");');
  if (blurred.__error) console.error('[2] ' + blurred.__error);
  log(blurred.mode === 'blur' && blurred.optsVisible === true, 'the blur settings appear');
  log(cropped.cropWindow && cropped.cropWindow.cw < 0.5,
    'while cropping, the preview shows only a slice of the 16:9 frame', `cw=${cropped.cropWindow && cropped.cropWindow.cw.toFixed(3)}`);
  log(blurred.cropWindow && blurred.cropWindow.cw === 1,
    'with blur, the preview shows the FULL width of the picture', `cw=${blurred.cropWindow && blurred.cropWindow.cw}`);
  log(blurred.canvasScale < cropped.canvasScale,
    'the picture is scaled DOWN to fit rather than up to fill', `${blurred.canvasScale.toFixed(3)} vs ${cropped.canvasScale.toFixed(3)}`);
  log(blurred.blurBg === true, 'the blurred backdrop is actually on screen behind it');
  log(/blur\(\d/.test(blurred.blurFilter), 'and it is really a blur', blurred.blurFilter);
  // the player is a full-bleed element with a BLACK background; if it keeps
  // painting that, the backdrop is behind a black wall and invisible
  log(/rgba\(0, 0, 0, 0\)|transparent/.test(blurred.playerBg),
    'the video stops painting its own black background, so the backdrop shows', blurred.playerBg);
  log(blurred.bgBehindPlayer === true, 'and the backdrop is BEHIND the picture, not over it');
  log(blurred.bgRect && blurred.bgRect.w > 0 && blurred.bgRect.h > blurred.bgRect.w,
    'the backdrop covers the 9:16 export frame', JSON.stringify(blurred.bgRect));

  /* ---------- [3] auto-reframe cannot silently do nothing ---------------- */
  console.log('\n[3] Auto-reframe steps aside when there is no crop to follow');
  log(blurred.reframeDisabled === true, 'the auto-reframe tick box is disabled');
  log(blurred.reframeOn === false, 'and the exporter is told reframing is OFF, whatever the box says');
  const backToCrop = await js(win, 'return window.VideoEditor.__test.setFill("crop");');
  log(backToCrop.reframeDisabled === false && backToCrop.reframeOn === true,
    'switching back to crop hands auto-reframe straight back');
  log(backToCrop.blurBg === false, 'and the blurred backdrop goes away again');

  /* ---------- [4] strength ------------------------------------------------ */
  console.log('\n[4] Blur strength really moves');
  const heavy = await js(win, `
    const T = window.VideoEditor.__test;
    T.setFill('blur');
    return T.setFillStrength(100);`);
  const light = await js(win, 'return window.VideoEditor.__test.setFillStrength(10);');
  const px = (s) => parseFloat((/blur\((\d+(?:\.\d+)?)px\)/.exec(s) || [0, 0])[1]);
  log(heavy.strength === 1 && light.strength === 0.1, 'the slider sets the strength', `${heavy.strength} / ${light.strength}`);
  log(px(heavy.blurFilter) > px(light.blurFilter),
    'and the preview blur follows it', `${px(heavy.blurFilter)}px vs ${px(light.blurFilter)}px`);
  log(heavy.cfg && heavy.cfg.mode === 'blur' && heavy.cfg.strength === 1,
    'the export is handed the mode AND the strength', JSON.stringify(heavy.cfg));

  /* ---------- [5] noise removal ------------------------------------------ */
  console.log('\n[5] Background noise: off, on, and how strong');
  const dOn = await js(win, 'return window.VideoEditor.__test.setDenoise(true, "strong");');
  if (dOn.__error) console.error('[5] ' + dOn.__error);
  log(dOn.on === true && dOn.optsVisible === true, 'ticking it reveals the strength');
  log(dOn.cfg === 'strong', 'and the export is handed that strength', String(dOn.cfg));
  const dOff = await js(win, 'return window.VideoEditor.__test.setDenoise(false);');
  log(dOff.cfg === null, 'unticking it leaves the audio completely alone again');
  const levels = await js(win, `
    const T = window.VideoEditor.__test;
    const out = [];
    T.setDenoise(true, 'light'); out.push(T.denoiseState().cfg);
    T.setDenoise(true, 'medium'); out.push(T.denoiseState().cfg);
    T.setDenoise(true, 'max'); out.push(T.denoiseState().cfg);
    return out;`);
  log(String(levels) === 'light,medium,max', 'every strength reaches the exporter', String(levels));

  /* ---------- [6] both choices survive a restart ------------------------- */
  console.log('\n[6] Set it once for your room — it is still there next Sunday');
  const stored = await js(win, `
    const T = window.VideoEditor.__test;
    T.setFill('blur'); T.setFillStrength(80); T.setDenoise(true, 'strong');
    const keys = T.exportPrefKeys();
    return { fill: localStorage.getItem(keys.fill), denoise: localStorage.getItem(keys.denoise) };`);
  log(!!stored.fill && stored.fill.includes('blur'), 'the frame fill is written to storage', stored.fill);
  log(!!stored.denoise && stored.denoise.includes('strong'), 'so is the noise setting', stored.denoise);
  const reloaded = await js(win, `
    const T = window.VideoEditor.__test;
    // wipe the in-memory state the way a fresh window would start, then re-read
    return T.reloadExportPrefs();`);
  log(reloaded.fill.mode === 'blur' && Math.abs(reloaded.fill.strength - 0.8) < 0.001,
    'and they come back on the next run', `${reloaded.fill.mode} @ ${reloaded.fill.strength}`);
  log(reloaded.denoise.on === true && reloaded.denoise.level === 'strong', 'noise removal too', reloaded.denoise.level);
  log(reloaded.fill.select === 'blur' && reloaded.denoise.checked === true,
    'the controls on screen show the remembered choice, not the default');

  /* ---------- [7] a 9:16 source needs no fill at all --------------------- */
  console.log('\n[7] A source already the right shape costs nothing');
  const chain = video.fillChain(1080, 1920, 1080, 1920, { mode: 'blur' });
  log(!chain.includes('boxblur'), 'no blur branch is built when there is no gap to fill');

  /* ---------- put the settings back ---------------------------------------
   * Every Electron test in this repo shares one localStorage (same file://
   * origin), so a test that leaves "blur background" and "remove noise" switched
   * on hands them to whatever runs next. Reset before finishing. */
  const reset = await js(win, 'return window.VideoEditor.__test.forgetExportPrefs();');
  log(reset.fill.mode === 'crop' && reset.denoise.on === false,
    'the test leaves the settings back at their defaults for the next test', `${reset.fill.mode} / denoise ${reset.denoise.on}`);

  /* ---------- errors ----------------------------------------------------- */
  console.log('\n[8] No console errors along the way');
  const real = errors.filter((m) => !/Autofill|devtools|Request Autofill/i.test(m));
  log(real.length === 0, 'the renderer logged no errors', real.slice(0, 2).join(' | ') || 'clean');

  console.log(failed ? '\n  === FAILURES ABOVE ===' : '\n  === all good ===');
  win.destroy();
  app.quit();
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); process.exit(1); });
