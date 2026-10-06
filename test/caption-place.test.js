'use strict';
/*
 * WHERE THE CAPTION SITS — on the preview, and in the file.
 *
 * Two complaints, one cause: the caption layer was the whole preview window
 * rather than the export frame, so the words hung outside the 9:16 guide AND
 * were sized against the wrong rectangle. And dragging them panned the video
 * instead, because the preview's own drag got the event first.
 *
 * This drives the real Video Studio: it checks the caption is inside the export
 * frame, drags the words with real mouse events, and then BURNS a video and
 * reads the pixels to prove the words really moved in the output too.
 *
 *   npx electron test/caption-place.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-capplace');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'clip.mp4');

let failed = false;
const log = (ok, n, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!ok) failed = true; };
const near = (a, b, t) => a != null && Math.abs(a - b) <= t;

/** Mean brightness of a band of the frame — where the white words are. */
function bandInk(file, t, y0, y1) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=iw:ih*${(y1 - y0).toFixed(3)}:0:ih*${y0.toFixed(3)},scale=60:20,format=gray`,
    '-f', 'rawvideo', '-'], { maxBuffer: 1 << 22 });
  if (!buf.length) return 0;
  let s = 0; for (const v of buf) s += v;
  return s / buf.length;
}

const ok = (d) => ({ ok: true, data: d });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
// REAL font bytes — the WYSIWYG caption rasteriser inlines them as data: URIs,
// and without them it would draw the words in a fallback face.
ipcMain.handle('fonts:data', () => {
  const dir = captioner.fontsDir();
  if (!fs.existsSync(dir)) return ok([]);
  return ok(fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') })));
});
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:fonts', () => ok(Object.keys(captioner.FONTS)));
ipcMain.handle('captions:fontList', () => ok(captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));
ipcMain.handle('captions:models', () => ok([{ id: 'base.en', name: 'Base', installed: true, bundled: true }]));
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
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b.toString('base64')}`);
});
// "Save with captions" for the whole video IS Export video now (the edit, not the
// raw recording), so the edited export has to exist here too — the real one.
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const output = path.join(WORK, `edited-${(label || 'video').replace(/[^\w.-]+/g, '_').slice(0, 30)}-${Date.now()}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'source', pieces, output });
  return ok(output);
});
// The real burner, so the pixels below are the real thing.
let lastOpts = null, lastBurn = null, lastBurnErr = null;
// Mirrors main.js's captions:burn exactly — write the .ass, then burn it. The
// burner takes an assPath, not events, so anything else silently produces nothing.
ipcMain.handle('captions:burn', async (_e, { input, events, opts, outName }) => {
  lastOpts = opts;
  try {
    const info = await video.getInfo(ctx, input);
    const dir = fs.mkdtempSync(path.join(WORK, 'cap-'));
    const assPath = path.join(dir, 'caps.ass');
    captioner.writeAss(events, { width: info.width, height: info.height, opts: opts || {}, output: assPath });
    const out = path.join(WORK, `${(outName || 'burn')}-${Date.now()}.mp4`);
    await captioner.burnCaptions(ctx, { input, assPath, output: out });
    lastBurn = out;
    return ok(out);
  } catch (e) { lastBurnErr = e.message; throw e; }
});

/* …and the route captions actually take now: the renderer draws the words with
 * the same layout the preview shows and hands over a transparent track, which
 * this composites exactly the way main.js does. */
let lastTrack = null;
// the pictures arrive AHEAD of the burn, a batch at a time, exactly as main.js takes them
let trackPuts = 0;
ipcMain.handle('captions:trackPut', async (_e, a) => { trackPuts++; return ok(video.putTrackFrames(a || {})); });
ipcMain.handle('captions:burnTrack', async (_e, { input, track, outName }) => {
  lastTrack = track;
  try {
    const out = path.join(WORK, `${(outName || 'burn')}-${Date.now()}.mp4`);
    await video.burnCaptionTrack(ctx, { input, track, output: out });
    lastBurn = out;
    return ok(out);
  } catch (e) { lastBurnErr = e.message; throw e; }
});

app.disableHardwareAcceleration();
const js = (w, src) => w.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

app.whenReady().then(async () => {
  // A 16:9 recording, like a real service — so a 9:16 export frame is genuinely
  // drawn inside the preview and anything outside it is visibly wrong.
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-t', '6', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=30',
    '-f', 'lavfi', '-t', '6', '-i', 'sine=frequency=220', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);

  const errs = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  /*
   * Start from a CLEAN INSTALL. Where the caption was dragged to is remembered
   * between sessions (it is a dragged setting, so it has nowhere else to live) —
   * which means this test's own drag would be waiting for it on the next run,
   * the caption would already be at the top, and "it moved up" would fail
   * because there was nowhere left to move. Same localStorage trap the audio
   * mixer tests hit.
   */
  await win.webContents.executeJavaScript(
    `try { localStorage.removeItem('mw-cap-look-v1'); } catch (e) {} location.reload(); true`);
  await sleep(1400);
  const boot = errs.slice();

  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    await window.VideoEditor.__test.loadReal(${J(SRC)});
    return true;`);
  await sleep(700);

  /* ---------- [1] inside the frame ---------- */
  console.log('\n[1] The caption stays inside the export frame');
  const geo = await js(win, `
    const T = window.VideoEditor.__test;
    T.setCaps([{ start: 0.2, end: 5.5, text: 'THIS IS A LONG CAPTION LINE' }]);
    const show = document.getElementById('veCapShow'); if (show) show.checked = true;
    T.mediaSeek ? T.mediaSeek(1.5) : null;
    T.seekAndRefresh ? T.seekAndRefresh(1.5) : null;
    await new Promise(r => setTimeout(r, 400));
    const ov = document.getElementById('veCapOverlay');
    const span = ov && ov.firstElementChild;
    const prev = document.getElementById('veDrop').getBoundingClientRect();
    const f2 = T.exportFrameRect ? T.exportFrameRect() : null;
    const fr = f2 ? { left: prev.left + f2.left, top: prev.top + f2.top,
                      right: prev.left + f2.left + f2.w, bottom: prev.top + f2.top + f2.h,
                      width: f2.w, height: f2.h } : null;
    const sr = span ? span.getBoundingClientRect() : null;
    return { hasSpan: !!span, hidden: ov ? ov.classList.contains('hidden') : true,
             fr: fr && { l: fr.left, t: fr.top, r: fr.right, b: fr.bottom, w: fr.width, h: fr.height },
             sr: sr && { l: sr.left, t: sr.top, r: sr.right, b: sr.bottom, w: sr.width },
             text: span && span.textContent };`);
  if (geo.__error) console.error(geo.__error);
  log(geo.hasSpan && !geo.hidden, 'the caption is on the preview', J(geo.text));
  if (geo.fr && geo.sr) {
    log(geo.sr.l >= geo.fr.l - 1 && geo.sr.r <= geo.fr.r + 1,
      'THE FIX: it no longer spills out sideways past the 9:16 frame',
      `caption ${Math.round(geo.sr.l)}–${Math.round(geo.sr.r)} vs frame ${Math.round(geo.fr.l)}–${Math.round(geo.fr.r)}`);
    log(geo.sr.t >= geo.fr.t - 1 && geo.sr.b <= geo.fr.b + 1, '…nor above or below it',
      `caption ${Math.round(geo.sr.t)}–${Math.round(geo.sr.b)} vs frame ${Math.round(geo.fr.t)}–${Math.round(geo.fr.b)}`);
    log(geo.sr.w <= geo.fr.w, 'and it is never wider than the frame', `${Math.round(geo.sr.w)}px in ${Math.round(geo.fr.w)}px`);
  } else log(false, 'the export frame and caption were both measurable');

  /* ---------- [2] dragging the words ---------- */
  console.log('\n[2] Dragging the caption moves the CAPTION, not the video');
  const dragged = await js(win, `
    const T = window.VideoEditor.__test;
    const ov = document.getElementById('veCapOverlay');
    const span = ov.firstElementChild;   // the caption block
    const before = span.getBoundingClientRect();
    const frameBefore = T.framing ? JSON.stringify(T.framing()) : null;
    const r = span.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    span.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy - 260 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: cx, clientY: cy - 260 }));
    await new Promise(r2 => setTimeout(r2, 300));
    // Re-query: the overlay is rebuilt when the caption changes, so the node
    // captured above is detached by now and would report a rect of all zeros —
    // which would let "it moved up" pass without the caption moving at all.
    const nowSpan = document.getElementById('veCapOverlay').firstElementChild;
    const after = nowSpan.getBoundingClientRect();
    return { beforeTop: before.top, afterTop: after.top,
             capPos: T.capPosNow ? T.capPosNow() : null,
             frameBefore, frameAfter: T.framing ? JSON.stringify(T.framing()) : null };`);
  if (dragged.__error) console.error(dragged.__error);
  log(dragged.afterTop < dragged.beforeTop - 100, 'THE FIX: the caption itself moved up',
    `${Math.round(dragged.beforeTop)}px → ${Math.round(dragged.afterTop)}px`);
  log(dragged.frameBefore === dragged.frameAfter, '…and the VIDEO did not move (the old behaviour)',
    dragged.frameAfter);
  log(dragged.capPos && dragged.capPos.y < 0.6, 'the new position is remembered as a frame fraction',
    J(dragged.capPos));

  /* ---------- [3] it reaches the exported file ---------- */
  console.log('\n[3] The burned video has the words where they were put');
  await js(win, 'window.VideoEditor.__test.burnCaps(); return true;');
  for (let i = 0; i < 120 && !lastBurn; i++) await sleep(1000);
  const burnt = lastBurn;
  log(!!burnt, 'a captioned file was produced', burnt ? path.basename(burnt) : ('NONE ' + (lastBurnErr || '')));
  /* The dragged point reaches the file either way: through the caption track's
   * band (the WYSIWYG route, which is what runs) or through the .ass options
   * (the fallback). Both come out of the one layout, so either proves it. */
  const bandTop = lastTrack && lastTrack.band ? lastTrack.band.y / lastTrack.authorH : null;
  log((bandTop != null && bandTop < 0.35)
      || (lastOpts && Number.isFinite(lastOpts.posX) && Number.isFinite(lastOpts.posY) && lastOpts.posY < 0.35),
    'the dragged point was handed to the burner',
    lastTrack ? `caption band starts at ${(bandTop * 100).toFixed(1)}% down the frame`
              : J(lastOpts && { posX: lastOpts.posX, posY: lastOpts.posY }));
  if (burnt && fs.existsSync(burnt)) {
    // posY 0.06 puts the words right at the top, so that is where to look —
    // and the band they USED to occupy (the bottom preset) must now be empty.
    const top = bandInk(burnt, 2, 0.0, 0.22);
    const bottom = bandInk(burnt, 2, 0.78, 1.0);
    log(top > bottom * 2 && top > 1, 'the words are AT THE TOP of the video, where they were dragged',
      );
  }

  log(trackPuts > 0 && lastTrack && lastTrack.trackId && lastTrack.frames.every((f) => f.png === undefined || f.png === null),
    'the caption pictures went to the studio in batches, none inside the burn itself', `${trackPuts} batch(es)`);

  const newErrs = errs.filter((m) => !boot.includes(m) && !/Autofill|DevTools|source-map|No handler registered/i.test(m));
  log(newErrs.length === 0, 'no new console errors', newErrs.slice(0, 2).join(' | '));

  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
