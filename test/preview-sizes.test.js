'use strict';
/*
 * "The bigger preview and full screen do not match the small default preview —
 *  look at the added text, it looks different."
 *
 * They didn't. The text box carried a FIXED 2px/6px padding and a 1.5px border,
 * and the drop shadow was a fixed 2px/8px. Fixed pixels are 15% of a 97-pixel
 * text box in the small preview and 3% of a 521-pixel one in full screen, so the
 * same words wrapped differently and read at a different weight in each.
 *
 * All three previews are showing the SAME exported picture at three sizes, so
 * everything about the text, measured IN FRACTIONS OF THE EXPORT FRAME, has to
 * be identical in all of them. This drives the app's own ⤢ and ⛶ buttons and
 * measures the real rendered words:
 *
 *   1. the same text, at the same settings, at three preview sizes,
 *   2. its position, width, size and LINE COUNT compared as frame fractions,
 *   3. the export payload asked for at each size — which must also be identical,
 *      because a preview you happen to be looking at must not change the file,
 *   4. a control: a genuinely different size must show up in these numbers.
 *
 * Run: npx electron test/preview-sizes.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpegBin = require('ffmpeg-static');
const ffprobeBin = require('ffprobe-static').path;
const video = require('../src/main/video');
const captioner = require('../src/main/captioner');

const ctx = { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
const DIR = path.join(os.tmpdir(), 'mw-preview-sizes');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const SRC = path.join(DIR, 'src.mp4');
spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'gradients=s=1920x1080:c0=0x203040:c1=0x8090a0:d=6:r=25',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', SRC]);

const ok = (d) => ({ ok: true, data: d });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: DIR, userData: DIR, fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(captioner.FONT_LIST.map((f) => f.name)));
ipcMain.handle('captions:fontList', () => ok(captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('dialog:openFile', () => ok(SRC));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx, input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => {
  const o = path.join(DIR, 'th-' + Math.random().toString(36).slice(2) + '.png');
  await video.thumbnail(ctx, { input, timeSec, output: o }); return o;
}));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => {
  const o = path.join(DIR, 'fs-' + Math.random().toString(36).slice(2) + '.png');
  await video.filmstrip(ctx, { input, count: count || 16, output: o }); return o;
}));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => {
  const o = path.join(DIR, 'wf-' + Math.random().toString(36).slice(2) + '.png');
  await video.waveform(ctx, { input, output: o }); return o;
}));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));
ipcMain.handle('fonts:data', () => ok([]));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
let win = null;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => ({ __error: String(e && e.message || e) }));

/* Words long enough that where they break is a real decision. */
const TEXT = 'PASTOR JOHN AHERN';

app.whenReady().then(async () => {
  win = new BrowserWindow({ show: true, width: 1500, height: 1000,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  win.focus(); win.webContents.focus();
  await js(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    document.getElementById('veOpen2').click();
    return 1;
  })()`);
  for (let i = 0; i < 40; i++) { await sleep(400); if (await js('!!(window.VideoEditor.__test.info && window.VideoEditor.__test.info())') === true) break; }
  check(await js('!!(window.VideoEditor.__test.info())') === true, 'a real clip is loaded');
  await sleep(700);

  /* ---- one text, placed once ---- */
  await js(`document.getElementById('veAddText').click()`);
  await sleep(400);
  const placed = await js(`(() => {
    const T = window.VideoEditor.__test;
    const c = document.querySelector('#veTextLayer .ve-text-content');
    if (c) { c.innerText = ${JSON.stringify(TEXT)}; c.blur(); }
    const id = T.textOverlays()[0].id;
    T.selectText(id);
    const set = (i, v) => { const el = document.getElementById(i); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('vtFont', 'Anton');
    T.setTextPos(id, 0.5, 0.12);
    T.deselectText();
    return { id, style: T.textStyleOf(id) };
  })()`);
  check(!!placed.id, 'one text overlay placed', JSON.stringify(placed.style));

  /* ---- read it at each preview size the studio offers ---- */
  const at = async (label, prep) => {
    if (prep) await js(prep);
    await sleep(700);
    const r = await js(`(() => {
      const T = window.VideoEditor.__test;
      return { look: T.textLookInFrame(${JSON.stringify(placed.id)}),
               payload: T.overlayLayout(${JSON.stringify(placed.id)}, 'frame', 1080, 1920) };
    })()`);
    console.log(`  ${label.padEnd(14)} frame ${r.look.frame.w}x${r.look.frame.h}  ` +
      `x ${r.look.x0}–${r.look.x1}  y ${r.look.y0}  font ${r.look.fontFrac}  ${r.look.lines} line(s)`);
    return r;
  };

  const small = await at('small preview');
  const bigger = await at('bigger (⤢)', `(() => { const b = document.getElementById('veBigger'); if (!b.classList.contains('on')) b.click(); window.VideoEditor.fit && window.VideoEditor.fit(); return 1; })()`);
  // Full screen goes through the real Fullscreen API; if the window refuses it,
  // fall back to simply making the preview panel much taller — the point is a
  // THIRD, very different frame size, not which button produced it.
  const wentFull = await js(`(async () => {
    const b = document.getElementById('veFull'); b.click();
    await new Promise(r => setTimeout(r, 600));
    return !!document.fullscreenElement;
  })()`);
  if (!wentFull) {
    await js(`(() => {
      const d = document.getElementById('veDrop');
      d.style.position = 'fixed'; d.style.left = '0'; d.style.top = '0';
      d.style.width = '1400px'; d.style.height = '940px'; d.style.zIndex = '999';
      window.VideoEditor.fit && window.VideoEditor.fit();
      return 1;
    })()`);
  }
  const full = await at(wentFull ? 'full screen (⛶)' : 'full-size panel');

  const sizes = [small, bigger, full];
  const frames = sizes.map((r) => r.look.frame.h);
  check(Math.max(...frames) / Math.min(...frames) > 1.8,
    'the three previews really are very different sizes', frames.map((h) => h + 'px').join(' → '));

  /* ---- THE CLAIM: identical, as fractions of the frame ---- */
  const spread = (k) => Math.max(...sizes.map((r) => r.look[k])) - Math.min(...sizes.map((r) => r.look[k]));
  check(sizes.every((r) => r.look.lines === small.look.lines),
    'THE SAME NUMBER OF LINES in every preview', sizes.map((r) => r.look.lines).join(' / '));
  check(spread('fontFrac') < 0.004, 'the same size relative to the frame',
    sizes.map((r) => r.look.fontFrac).join(' / '));
  check(spread('x0') < 0.012 && spread('x1') < 0.012, 'the words run from and to the same place across the frame',
    sizes.map((r) => `${r.look.x0}–${r.look.x1}`).join(' / '));
  check(spread('y0') < 0.012, 'and sit at the same height down it', sizes.map((r) => r.look.y0).join(' / '));
  check(spread('boxFrac') < 0.004, 'the text box itself is the same share of the frame',
    sizes.map((r) => r.look.boxFrac).join(' / '));

  /* ---- and the EXPORT must not depend on which preview you happened to use ---- */
  const pl = sizes.map((r) => r.payload);
  const pspread = (k) => Math.max(...pl.map((p) => p[k])) - Math.min(...pl.map((p) => p[k]));
  console.log('  export payload: ' + pl.map((p) => `${p.left.toFixed(1)},${p.top.toFixed(1)} w${p.width.toFixed(1)} f${p.fontPx.toFixed(2)}`).join('  |  '));
  check(pspread('left') < 1 && pspread('top') < 1 && pspread('width') < 1 && pspread('fontPx') < 0.5,
    'THE EXPORTED PICTURE IS THE SAME whichever preview you were looking at',
    `left ±${pspread('left').toFixed(2)}px, font ±${pspread('fontPx').toFixed(2)}px at 1080x1920`);

  /* ---- the control: these numbers CAN move ---- */
  const bigger2 = await js(`(async () => {
    const T = window.VideoEditor.__test;
    const o = T.textOverlays()[0];
    T.setTextSizePct(o.id, o.sizePct * 1.5);
    await new Promise(r => setTimeout(r, 200));
    const look = T.textLookInFrame(o.id);
    T.setTextSizePct(o.id, o.sizePct);
    return look;
  })()`);
  check(bigger2 && Math.abs(bigger2.fontFrac - full.look.fontFrac) > 0.02,
    'the measurement CAN fail: a 1.5x size shows up plainly',
    `${full.look.fontFrac} → ${bigger2 && bigger2.fontFrac}`);

  /* ---- and the size field really goes below 8 now ---- */
  const tiny = await js(`(() => {
    const T = window.VideoEditor.__test;
    const o = T.textOverlays()[0];
    T.selectText(o.id);
    const el = document.getElementById('vtSize');
    const min = el.min;
    el.value = '3'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const look = T.textLookInFrame(o.id);
    return { min, value: el.value, shownPx: look ? look.fontFrac * T.textLookInFrame(o.id).frame.h : null, look };
  })()`);
  check(tiny.min === '1', 'the Size field accepts anything down to 1', 'min=' + tiny.min);
  check(tiny.shownPx != null && tiny.shownPx < 6,
    'and 3 really draws 3-pixel text instead of being floored at 8',
    tiny.shownPx != null ? tiny.shownPx.toFixed(2) + 'px on screen' : 'not measurable');

  console.log(`\n==== preview sizes agree: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
