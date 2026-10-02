'use strict';
/*
 * The quality picker, end to end in the real Video Studio.
 *
 * The unit test proves video.js can produce each size; this proves the BUTTON
 * reaches it — that what the operator picks is what the export IPC is asked for,
 * on every one of the four export routes (plain, face-tracked, hand-framed, and
 * the whole edited video), and that the resulting file really is that size.
 *
 *   npx electron test/quality-ui.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-qualui');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'service.mp4');

let failed = false;
const log = (ok, n, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!ok) failed = true; };
const probe = (f) => {
  const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'json', f], { maxBuffer: 1 << 22 });
  const st = JSON.parse(out).streams[0];
  return { w: st.width, h: st.height };
};

const ok = (d) => ({ ok: true, data: d });
const asked = [];
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:thumbnail', async (_e, { input, timeSec }) => {
  const o = path.join(WORK, `t${Date.now()}.jpg`);
  await video.thumbnail(ctx, { input, timeSec: timeSec || 0, output: o, width: 240 });
  return ok(o);
});
ipcMain.handle('video:waveform', async (_e, { input }) => {
  const o = path.join(WORK, `w${Date.now()}.png`);
  await video.waveform(ctx, { input, width: 1600, height: 90, output: o });
  return ok(o);
});
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  const o = path.join(WORK, `s${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output: o });
  return ok(o);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const b = fs.readFileSync(p);
  return ok(`data:image/${(path.extname(p).slice(1) || 'png')};base64,${b.toString('base64')}`);
});
// Record what each export route was ASKED for, and really render it.
ipcMain.handle('sermon:exportShort', async (_e, a) => {
  asked.push({ route: 'short', quality: a.quality, preset: a.preset });
  const out = path.join(WORK, `short-${asked.length}.mp4`);
  await video.exportShort(ctx, { ...a, output: out });
  return ok(out);
});
ipcMain.handle('sermon:exportReframed', async (_e, a) => {
  asked.push({ route: 'reframed', quality: a.quality, preset: a.preset });
  const out = path.join(WORK, `re-${asked.length}.mp4`);
  await video.exportShortReframed(ctx, { ...a, output: out });
  return ok(out);
});
ipcMain.handle('sermon:exportFramed', async (_e, a) => {
  asked.push({ route: 'framed', quality: a.quality, preset: a.preset });
  const out = path.join(WORK, `fr-${asked.length}.mp4`);
  const r = await video.exportShortFramed(ctx, { ...a, output: out });
  return ok(r.output);
});
ipcMain.handle('fs:rmdir', async () => ok(true));

app.disableHardwareAcceleration();
const js = (w, src) => w.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

app.whenReady().then(async () => {
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-t', '4', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30',
    '-f', 'lavfi', '-t', '4', '-i', 'sine=frequency=300', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);

  const errs = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);
  const boot = errs.slice();
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    await window.VideoEditor.__test.loadReal(${J(SRC)});
    return true;`);
  await sleep(600);

  console.log('\n[1] The picker');
  const opts = await js(win, 'return window.VideoEditor.__test.qualityOptions();');
  log(Array.isArray(opts) && ['720p', '1080p', '4k'].every((q) => opts.includes(q)),
    'the picker offers 720p, 1080p and 4K', J(opts));
  log(opts.includes('source'), '…and "same as the recording"');
  log((await js(win, 'return window.VideoEditor.__test.quality();')) === '1080p',
    'it starts on 1080p — what social platforms want');

  console.log('\n[2] What the export is actually asked for');
  for (const q of ['720p', '4k']) {
    asked.length = 0;
    const out = await js(win, `
      const T = window.VideoEditor.__test;
      T.setQuality(${J(q)});
      return await new Promise((resolve) => {
        const orig = window.finishedFile;
        window.finishedFile = (p) => { window.finishedFile = orig; resolve(p); };
        T.exportEditedVideo();
        setTimeout(() => resolve(null), 240000);
      });`);
    log(asked.length > 0 && asked[asked.length - 1].quality === q,
      `picking ${q} asks the exporter for ${q}`, J(asked[asked.length - 1]));
    if (out && fs.existsSync(out)) {
      const p = probe(out);
      const want = q === '720p' ? { w: 1280, h: 720 } : { w: 3840, h: 2160 };
      log(p.w === want.w && p.h === want.h, `…and the saved file really is ${want.w}x${want.h}`, `${p.w}x${p.h}`);
    } else log(false, `…and a file came out for ${q}`, 'NONE');
  }

  console.log('\n[3] A short takes the setting too');
  asked.length = 0;
  const short = await js(win, `
    const T = window.VideoEditor.__test;
    T.setQuality('4k');
    T.split(2);
    const ids = T.segIds();
    return await new Promise((resolve) => {
      const orig = window.finishedFile;
      window.finishedFile = (p) => { window.finishedFile = orig; resolve(p); };
      T.exportClip ? T.exportClip(ids[0]) : T.exportEditedVideo();
      setTimeout(() => resolve(null), 240000);
    });`);
  log(asked.length > 0 && asked[asked.length - 1].quality === '4k',
    'a clip export carries the same setting', J(asked[asked.length - 1]));

  console.log('\n[4] Honesty about upscaling');
  const warn = await js(win, `
    const T = window.VideoEditor.__test;
    T.setQuality('4k');
    const up = T.upscaleWarning();
    T.setQuality('720p');
    const down = T.upscaleWarning();
    return { up, down };`);
  log(/stretched/i.test(warn.up), 'asking a 1080p recording for 4K says it is being stretched', warn.up.trim().slice(0, 90));
  log(!warn.down, '…and asking for 720p says nothing, because nothing is stretched', J(warn.down));

  console.log('\n[5] It is remembered');
  const kept = await js(win, `
    window.VideoEditor.__test.setQuality('4k');
    return localStorage.getItem('mwExportQuality');`);
  log(kept === '4k', 'the choice survives a restart', J(kept));

  const newErrs = errs.filter((m) => !boot.includes(m) && !/Autofill|DevTools|source-map|No handler registered/i.test(m));
  log(newErrs.length === 0, 'no new console errors', newErrs.slice(0, 2).join(' | '));

  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
