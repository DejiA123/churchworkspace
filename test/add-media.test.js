'use strict';
/*
 * "I should be able to upload a SECOND VIDEO, or a PICTURE, and put it on top of
 *  the clip I already uploaded — anywhere on the video timeline."
 *
 * This drives the real Video Studio in a real Electron window: it adds the files
 * the way ➕ Add media does, drags the blocks with real mouse events, and then
 * presses the app's own 💾 Export video — and reads the PIXELS back out of the
 * finished MP4.
 *
 * Colour-coded so nothing has to be taken on trust:
 *
 *    base  640x360 DARK BLUE, 14s          the service recording
 *    cam2  320x240 GREEN, 6s, 1200Hz tone  the second video
 *    logo  200x200 RED png                 the picture
 *
 * The claims under test, in order:
 *   [1] both land on the OVERLAY lane, where the playhead is or where dropped
 *   [2] a picture is given a length (it has none of its own); a video keeps its
 *   [3] anywhere on the timeline: move, duplicate, split — all by real dragging
 *   [4] the PREVIEW shows the actual picture/footage, in its own shape (WYSIWYG)
 *   [5] trimming an overlay moves ITS in/out point, not the recording's
 *   [6] added media cannot be turned into main-lane footage
 *   [7] the export payload carries the right file, still-flag and clip-relative time
 *   [8] a REAL export puts red and green pixels in the frame, at the right times
 *
 *   npx electron test/add-media.test.js
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

const WORK = path.join(os.tmpdir(), 'mw-addmedia-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const BASE = path.join(WORK, 'service.mp4');
const CAM2 = path.join(WORK, 'testimony.mp4');
const LOGO = path.join(WORK, 'church-logo.png');
const BASE_SEC = 14, CAM2_SEC = 6;

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

/** Average colour of one patch of one frame, straight out of the file. */
function patchRGB(file, t, crop) {
  const buf = execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file,
    '-frames:v', '1', '-vf', `crop=${crop},scale=8:8,format=rgb24`, '-f', 'rawvideo', '-'],
    { maxBuffer: 1 << 22 });
  if (!buf.length) return null;
  let r = 0, g = 0, b = 0; const n = buf.length / 3;
  for (let i = 0; i < buf.length; i += 3) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}
const isRed = (c) => !!c && c.r > 110 && c.r > c.g * 2 && c.r > c.b * 2;
const isGreen = (c) => !!c && c.g > 100 && c.g > c.r * 2;
const isBase = (c) => !!c && c.b > c.r && c.r < 90;
const show = (c) => (c ? `rgb(${c.r},${c.g},${c.b})` : 'none');

/* --- the same main-process handlers the app ships ----------------------- */
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
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
  const output = path.join(WORK, `thumb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
  await video.thumbnail(ctx, { input, timeSec: timeSec || 0, output, width: 240 });
  return ok(output);
});
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

// The two handlers the feature rides on. compositeCalls is checked so a silent
// no-op export can never pass as "the overlay was included".
let compositeCalls = 0;
ipcMain.handle('video:overlayComposite', async (_e, { base, overlays, baseStart, baseEnd }) => {
  compositeCalls++;
  const output = path.join(WORK, `pip-${Date.now()}.mp4`);
  await video.exportOverlayComposite(ctx, { base, overlays: overlays || [], baseStart, baseEnd, output });
  return ok(output);
});
ipcMain.handle('sermon:exportShort', async (_e, { input, startSec, endSec, preset, pieces, label }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = path.join(WORK, `out-${safe}-${Date.now()}.mp4`);
  await video.exportShort(ctx, { input, startSec, endSec, preset: preset || 'source', pieces, output });
  return ok(output);
});
ipcMain.handle('fs:rmdir', async (_e, { dir }) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {} return ok(true); });

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

app.whenReady().then(async () => {
  /* ---------- [0] three colour-coded files ---------- */
  console.log('\n[0] A service recording, a second video and a picture');
  execFileSync(ffmpeg, ['-y', '-v', 'error',
    '-f', 'lavfi', '-t', String(BASE_SEC), '-i', 'color=c=0x101c5a:s=640x360:r=30',
    '-f', 'lavfi', '-t', String(BASE_SEC), '-i', 'sine=frequency=300:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', BASE]);
  execFileSync(ffmpeg, ['-y', '-v', 'error',
    '-f', 'lavfi', '-t', String(CAM2_SEC), '-i', 'color=c=0x18d24a:s=320x240:r=30',
    '-f', 'lavfi', '-t', String(CAM2_SEC), '-i', 'sine=frequency=1200:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CAM2]);
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xd42020:s=200x200', '-frames:v', '1', LOGO]);
  const bi = await video.getInfo(ctx, BASE);
  log(near(bi.durationSec, BASE_SEC, 0.4) && bi.width === 640, 'built a 14s 640x360 service recording', `${bi.width}x${bi.height} ${bi.durationSec.toFixed(1)}s`);

  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  win.webContents.on('dom-ready', () => { win.webContents.executeJavaScript("window.__rej=window.__rej||[];window.addEventListener('unhandledrejection',(e)=>window.__rej.push('REJECT: '+String((e.reason&&e.reason.stack)||e.reason)));window.addEventListener('error',(e)=>window.__rej.push('ERROR: '+String((e.error&&e.error.stack)||e.message)));true;").catch(()=>{}); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);
  await win.webContents.executeJavaScript(`window.__rej=[]; window.addEventListener('unhandledrejection', (e) => window.__rej.push(String((e.reason && e.reason.stack) || e.reason))); true;`);

  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const rf = document.getElementById('veAutoReframe'); if (rf) rf.checked = false;
    return true;`);
  const errorsAtBoot = errors.slice();
  // Every placement below assumes the fresh-install CROP fill: a fill left on
  // Blur by another suite (they share one profile) fits the whole picture into
  // the frame, which maps overlays differently and fails [7] and [8].
  await js(win, 'window.VideoEditor.__test.forgetExportPrefs(); return true;');
  const loaded = await js(win, `await window.VideoEditor.__test.loadReal(${J(BASE)}); return window.VideoEditor.__test.videoDuration();`);
  log(near(loaded, BASE_SEC, 0.4), 'the recording is open in the Video Studio', (loaded || 0).toFixed(1) + 's');
  log(await js(win, 'return window.VideoEditor.__test.clickAddMediaExists();'), 'the ➕ Add media button is on the timeline bar');

  /* ---------- [1][2] adding the files ---------- */
  console.log('\n[1] Add a picture and a second video on top');
  const added = await js(win, `
    const T = window.VideoEditor.__test;
    T.mediaSeek(2);
    const picId = await T.addMedia([${J(LOGO)}]);          // lands at the playhead
    const vidId = await T.addMedia([${J(CAM2)}], 8);       // lands where it was dropped
    return { picId, vidId, ids: T.mediaIds(), pic: T.mediaOf(picId), vid: T.mediaOf(vidId), segCount: T.segCount() };`);
  if (added.__error) { console.error(added.__error); app.exit(1); return; }
  log(added.ids.length === 2, 'two pieces of media are on the timeline', J(added.ids));
  log(added.pic.kind === 'image' && added.pic.src === LOGO, 'the picture knows it is a picture, and which file it is', `${added.pic.kind} ${path.basename(added.pic.src || '')}`);
  log(added.vid.kind === 'video' && added.vid.src === CAM2, 'the second video knows it is a video, and which file it is', `${added.vid.kind} ${path.basename(added.vid.src || '')}`);
  log(added.pic.lane >= 1 && added.vid.lane >= 1, 'both sit on an OVERLAY row, on top of the recording',
    `rows ${added.pic.lane} + ${added.vid.lane}`);
  log(near(added.pic.tlStart, 2, 0.05), 'the picture landed at the PLAYHEAD (2s)', added.pic.tlStart + 's');
  log(near(added.vid.tlStart, 8, 0.05), 'the second video landed where it was dropped (8s)', added.vid.tlStart + 's');
  log(added.segCount === 3, 'the recording itself is still one clip on the main lane', added.segCount + ' blocks');

  console.log('\n[2] A picture has no length of its own, so it is given one');
  log(near(added.pic.end - added.pic.start, 5, 0.01), 'the picture shows for 5s by default', (added.pic.end - added.pic.start) + 's');
  log(near(added.vid.end - added.vid.start, CAM2_SEC, 0.3), 'the second video keeps its own 6s', (added.vid.end - added.vid.start).toFixed(2) + 's');
  log(added.vid.srcInfo && added.vid.srcInfo.width === 320 && added.vid.srcInfo.height === 240,
    'and its own size is remembered (so its box is drawn in ITS shape)', J(added.vid.srcInfo && [added.vid.srcInfo.width, added.vid.srcInfo.height]));
  log(added.vid.mute === false && added.pic.mute === true, 'the video brings its sound; the picture has none');
  /*
   * The default position is measured against the EXPORT frame, not the whole
   * source picture. The studio opens on 9:16, which keeps only the middle third
   * of this 16:9 recording — a "top-right corner" default in source coordinates
   * would land outside the short, so the operator would add a picture and see
   * nothing. Both boxes must sit inside the window that actually gets exported.
   */
  const cw = await js(win, 'return window.VideoEditor.__test.cropWindowNow();');
  log(cw && cw.cw < 0.9, 'the 9:16 export keeps only part of this 16:9 frame', `x ${cw.left.toFixed(3)}–${(cw.left + cw.cw).toFixed(3)}`);
  /*
   * x / y / w are fractions of the EXPORT FRAME (not of the recording), which is
   * what keeps an overlay still while auto-reframe walks the crop across the
   * picture. So "inside the part that gets exported" is now simply "inside the
   * frame" — and that is the whole point: there is no longer a way to place
   * something the short cannot show.
   */
  const inside = (m) => m.x >= -0.001 && (m.x + m.w) <= 1.001 && m.y >= -0.001;
  log(inside(added.pic) && inside(added.vid), 'BOTH land inside the part that actually gets exported',
    `picture ${added.pic.x.toFixed(3)}+${added.pic.w.toFixed(3)} · video ${added.vid.x.toFixed(3)}+${added.vid.w.toFixed(3)}`);
  log(added.vid.w > 0.02 && added.vid.w < 0.9, 'as a corner box you can drag and resize, not the whole frame', `w=${added.vid.w.toFixed(3)}`);

  /* ---------- [3] anywhere on the timeline ---------- */
  console.log('\n[3] Put it ANYWHERE — by dragging the block itself');
  const dragged = await js(win, `
    const T = window.VideoEditor.__test;
    T.selectClip(${J(added.picId)});
    const m = T.dragSeg(${J(added.picId)}, null, 11.5);   // grab the block, drop it at 11.5s
    return { m, rect: T.mediaBlockRect(${J(added.picId)}) };`);
  log(near(dragged.m && dragged.m.tlStart, 11.5, 0.15), 'dragging the picture moved it to 11.5s', dragged.m && dragged.m.tlStart + 's');
  log(near(dragged.m && (dragged.m.end - dragged.m.start), 5, 0.05), '…without changing how long it shows', dragged.m && (dragged.m.end - dragged.m.start) + 's');
  log(dragged.rect && dragged.rect.top < 50, 'and its block stays on the upper (overlay) lane', 'top=' + (dragged.rect && dragged.rect.top) + 'px');
  log(dragged.rect && /ve-seg-img/.test(dragged.rect.cls), 'the block is marked as a picture', dragged.rect && dragged.rect.cls);

  const dup = await js(win, `
    const T = window.VideoEditor.__test;
    const copyId = T.duplicateClip(${J(added.vidId)});
    const copy = T.mediaOf(copyId);
    T.deleteClip(copyId);
    return { copy, left: T.mediaIds().length };`);
  log(dup.copy && dup.copy.src === CAM2 && dup.copy.lane === 1, 'duplicating an added video copies the SAME file, still as an overlay', dup.copy && path.basename(dup.copy.src));
  log(dup.left === 2, '…and deleting the copy leaves the originals', dup.left + ' on the timeline');

  const splitRes = await js(win, `
    const T = window.VideoEditor.__test;
    T.selectClip(${J(added.vidId)});
    T.mediaSeek(10);                      // 2s into the overlay, which sits at 8s
    T.split(10);
    const parts = T.mediaIds().map(i => T.mediaOf(i)).filter(m => m.src === ${J(CAM2)}).sort((a,b) => a.tlStart - b.tlStart);
    return parts;`);
  log(splitRes.length === 2, 'splitting an overlay gives two blocks', splitRes.length + '');
  if (splitRes.length === 2) {
    log(near(splitRes[0].tlStart, 8, 0.05) && near(splitRes[1].tlStart, 10, 0.05), 'cut where the playhead was', `${splitRes[0].tlStart}s + ${splitRes[1].tlStart}s`);
    log(near(splitRes[0].end, 2, 0.05) && near(splitRes[1].start, 2, 0.05),
      'and cut in ITS OWN footage 2s in — not at 10s of the recording',
      `left ends at ${splitRes[0].end}s of its file, right starts at ${splitRes[1].start}s`);
  }
  // back to one 6s block at 8s for the rest of the test
  const vidId = await js(win, `
    const T = window.VideoEditor.__test;
    T.mediaIds().forEach(i => { if (T.mediaOf(i).src === ${J(CAM2)}) T.deleteClip(i); });
    return await T.addMedia([${J(CAM2)}], 8);`);

  /* ---------- [4] the preview shows it ---------- */
  console.log('\n[4] The preview shows the real picture, in its own shape, at its own time');
  const seen = await js(win, `
    const T = window.VideoEditor.__test;
    T.setMediaBox(${J(added.picId)}, 0.05, 0.60, 0.25);
    T.mediaSeek(12);  const during = T.mediaOnScreen(${J(added.picId)});
    T.mediaSeek(1);   const before = T.mediaOnScreen(${J(added.picId)});
    T.mediaSeek(9);   const cam = T.mediaOnScreen(${J(vidId)});
    return { during, before, cam };`);
  log(seen.during && seen.during.tag === 'IMG' && seen.during.shown, 'the picture itself is on the preview during its window');
  log(seen.before && !seen.before.shown, '…and not before it starts');
  log(seen.during && seen.during.width > 10 && near(seen.during.height, seen.during.width, 2),
    'a square picture is drawn square — its OWN shape, not the video\'s', `${Math.round((seen.during || {}).width)}x${Math.round((seen.during || {}).height)}px`);
  log(seen.cam && seen.cam.tag === 'VIDEO' && seen.cam.shown, 'the second video plays on the preview during its window');
  log(seen.cam && near(seen.cam.width / seen.cam.height, 320 / 240, 0.1), '…in ITS 4:3 shape',
    `${Math.round((seen.cam || {}).width)}x${Math.round((seen.cam || {}).height)}px`);

  const snd = await js(win, `
    const T = window.VideoEditor.__test;
    T.selectClip(${J(vidId)});
    const shown = T.soundBtn();
    const muted = T.toggleMediaSound(${J(vidId)});
    const off = T.soundBtn();
    const unmuted = T.toggleMediaSound(${J(vidId)});
    return { shown, muted, off, unmuted };`);
  log(snd.shown && !snd.shown.hidden, 'selecting an added video shows the 🔊 sound button', snd.shown && snd.shown.text);
  log(snd.muted === true && snd.unmuted === false, '…which switches its sound off and back on', `${snd.muted} → ${snd.unmuted}`);
  log(snd.off && /Sound off/.test(snd.off.text), '…and says which way round it is', snd.off && snd.off.text);

  /* ---------- [5] trimming an overlay ---------- */
  console.log('\n[5] Trimming an overlay moves ITS in/out point');
  const trim = await js(win, `
    const T = window.VideoEditor.__test;
    T.selectClip(${J(vidId)});
    const r = T.dragSeg(${J(vidId)}, 'r', 12);      // block sits 8–14; pull the end back to 12
    const l = T.dragSeg(${J(vidId)}, 'l', 9);       // …and the start forward to 9
    return { r, l };`);
  log(near(trim.r && (trim.r.end - trim.r.start), 4, 0.15), 'dragging the right edge makes it show for 4s', trim.r && (trim.r.end - trim.r.start).toFixed(2) + 's');
  log(near(trim.r && trim.r.start, 0, 0.05), '…still starting from the beginning of its own footage', trim.r && trim.r.start + 's');
  log(near(trim.l && trim.l.tlStart, 9, 0.15), 'dragging the left edge moves it to 9s on the timeline', trim.l && trim.l.tlStart + 's');
  log(near(trim.l && trim.l.start, 1, 0.15), '…AND skips the first second of its own footage', trim.l && trim.l.start.toFixed(2) + 's into its file');

  /* ---------- [6] it stays on the overlay lane ---------- */
  console.log('\n[6] Added media cannot become main-lane footage');
  const laneBtn = await js(win, `
    const T = window.VideoEditor.__test;
    T.toggleOverlay(${J(vidId)});                 // the 📺 Overlay button
    return T.mediaOf(${J(vidId)}).lane;`);
  log(laneBtn >= 1, 'the 📺 Overlay button refuses to move it down to the main lane', 'lane ' + laneBtn);
  const laneDrag = await js(win, `
    const T = window.VideoEditor.__test;
    const m = T.dragSeg(${J(vidId)}, null, 8, 90);  // drag it right down onto the main lane
    return { lane: m.lane, tl: m.tlStart, start: m.start };`);
  log(laneDrag.lane >= 1, 'and dragging it down onto the main lane leaves it up top', 'lane ' + laneDrag.lane);

  /* ---------- [6b] TWO overlays at the same time, on their own rows ---------- */
  console.log('\n[6b] Two overlays showing at once');
  const rows = await js(win, `
    const T = window.VideoEditor.__test;
    T.mediaIds().forEach(i => T.deleteClip(i));
    // Both dropped at the SAME second: they must stack on separate rows rather
    // than queue up one after the other, or they could never show together.
    const a = await T.addMedia([${J(LOGO)}], 5);
    const b = await T.addMedia([${J(CAM2)}], 5);
    const A = T.mediaOf(a), B = T.mediaOf(b);
    T.mediaSeek(6);
    return {
      A, B,
      onA: T.mediaOnScreen(a), onB: T.mediaOnScreen(b),
      rectA: T.mediaBlockRect(a), rectB: T.mediaBlockRect(b),
      payload: T.editedOverlayPayload(),
    };`);
  if (rows.__error) console.error(rows.__error);
  log(rows.A.lane !== rows.B.lane, 'two overlays dropped at the same moment take DIFFERENT rows',
    `rows ${rows.A.lane} and ${rows.B.lane}`);
  log(Math.abs(rows.A.tlStart - rows.B.tlStart) < 0.05, '…at the same time, not queued one after the other',
    `${rows.A.tlStart}s and ${rows.B.tlStart}s`);
  log(rows.rectA && rows.rectB && rows.rectA.top !== rows.rectB.top,
    'their blocks are drawn on separate rows of the timeline',
    `top ${rows.rectA && rows.rectA.top}px vs ${rows.rectB && rows.rectB.top}px`);
  log(rows.onA && rows.onA.shown && rows.onB && rows.onB.shown,
    'BOTH are on the preview at the same moment');
  log((rows.payload || []).length === 2, 'and both are handed to the export', (rows.payload || []).length + '');
  // The row a clip sits on decides what covers what, in the file as on screen.
  const ordered = (rows.payload || []).map((o) => path.basename(o.src));
  const upper = rows.A.lane > rows.B.lane ? path.basename(LOGO) : path.basename(CAM2);
  log(ordered[ordered.length - 1] === upper, 'the upper row composites LAST, so it covers the lower one',
    ordered.join(' then '));

  /* ---------- [7] the export payload ---------- */
  console.log('\n[7] What the export is told to composite');
  const payload = await js(win, `
    const T = window.VideoEditor.__test;
    // Start from a clean timeline: earlier groups have been adding and deleting.
    T.mediaIds().forEach(i => T.deleteClip(i));
    const v = await T.addMedia([${J(CAM2)}], 8);
    T.setMediaBox(v, 0.60, 0.06, 0.34);
    const p = await T.addMedia([${J(LOGO)}], 11.5);
    T.setMediaBox(p, 0.05, 0.60, 0.25);
    return { v, p, whole: T.editedOverlayPayload(), short: T.mediaPayloadFor(6, 12) };`);
  const whole = (payload.whole || []).slice().sort((a, b) => a.tlStart - b.tlStart);
  log(whole.length === 2, 'both overlays are handed to the export', whole.length + '');
  log(whole.every((o) => o.src === CAM2 || o.src === LOGO), 'each carries its OWN file', J(whole.map((o) => path.basename(o.src))));
  log(whole.some((o) => o.src === LOGO && o.still === true), 'the picture is flagged `still`, so ffmpeg loops it instead of flashing one frame');
  log(whole.some((o) => o.src === CAM2 && o.mute === false), 'the second video is not muted');
  const inShort = (payload.short || []).find((o) => o.src === CAM2);
  log(!!inShort, 'a short cut from 6s–12s includes the second video');
  if (inShort) {
    log(near(inShort.tlStart, 2, 0.05), '…at the right moment INSIDE that short (clip-relative, not source time)', inShort.tlStart + 's');
    log(near(inShort.srcStart, 0, 0.05) && near(inShort.srcEnd, 4, 0.05), '…showing the part of its own footage that fits', `${inShort.srcStart}–${inShort.srcEnd}s of its file`);
  }
  const picShort = (payload.short || []).find((o) => o.src === LOGO);
  log(picShort && near(picShort.tlStart, 5.5, 0.05), '…and the picture, clipped to the short\'s end', picShort && picShort.tlStart + 's');

  /* ---------- [8] a real export ---------- */
  console.log('\n[8] Press 💾 Export video for real, then look at the pixels');
  compositeCalls = 0;
  /*
   * IN FRONT OF THE OPERATOR, which is what this section is about: it waits for
   * finishedFile, and a BACKGROUND export deliberately does not call it (it puts
   * the file on a chip in the corner instead of opening Explorer over whatever
   * you moved on to). The setting is REMEMBERED and every suite shares one
   * Electron profile, so a run of bg-export.test.js would otherwise leave this
   * one waiting four minutes for a call that is never coming.
   */
  await js(win, `window.VideoEditor.__test.setBgExport(false); return true;`);
  const outFile = await js(win, `
    return await new Promise((resolve) => {
      const orig = window.finishedFile;
      window.finishedFile = (p) => { window.finishedFile = orig; resolve(p); };
      window.VideoEditor.__test.exportEditedVideo();
      setTimeout(() => resolve(null), 240000);
    });`);
  log(!!outFile, 'the export produced a file', outFile ? path.basename(outFile) : 'NONE');
  log(compositeCalls === 1, 'the overlays were composited exactly once', compositeCalls + ' call(s)');
  if (outFile && fs.existsSync(outFile)) {
    const oi = await video.getInfo(ctx, outFile);
    log(near(oi.durationSec, BASE_SEC, 0.8), 'the saved video is the whole recording', oi.durationSec.toFixed(2) + 's');
    log(oi.width === 640 && oi.height === 360, 'at its original size', `${oi.width}x${oi.height}`);
    /*
     * WHERE TO LOOK.
     *
     * The boxes were placed on the 9:16 frame the preview draws; this export
     * keeps the WHOLE 16:9 picture, so the placement is taken back through the
     * frame onto the recording — exactly as added text does for this path. The
     * patches are therefore derived from what the compositor was actually told,
     * and checked INDEPENDENTLY against that conversion done by hand, so neither
     * a wrong instruction nor a wrong render can slip through.
     */
    const srcOf = (frameX, frameW) => ({ x: cw.left + frameX * cw.cw, w: frameW * cw.cw });
    const wantCam = srcOf(0.60, 0.34), wantPic = srcOf(0.05, 0.25);
    const gotCam = whole.find((o) => o.src === CAM2), gotPic = whole.find((o) => o.src === LOGO);
    log(gotCam && Math.abs(gotCam.x - wantCam.x) < 0.02 && Math.abs(gotCam.wFrac - wantCam.w) < 0.02,
      'the frame placement was converted onto the recording correctly',
      gotCam && `told ${gotCam.x.toFixed(3)}+${gotCam.wFrac.toFixed(3)}, expected ${wantCam.x.toFixed(3)}+${wantCam.w.toFixed(3)}`);
    // a patch well inside whatever box the compositor was given
    const patchIn = (o, yTop) => {
      const h = o.wFrac * (640 / 360) / (320 / 240);   // the media keeps its own shape
      return `iw*${(o.wFrac * 0.5).toFixed(3)}:ih*${Math.max(0.06, h * 0.4).toFixed(3)}:iw*${(o.x + o.wFrac * 0.25).toFixed(3)}:ih*${(yTop + h * 0.3).toFixed(3)}`;
    };
    const topRight = gotCam ? patchIn(gotCam, gotCam.y) : 'iw*0.1:ih*0.1:iw*0.5:ih*0.1';
    const btmLeft = gotPic ? patchIn(gotPic, gotPic.y) : 'iw*0.1:ih*0.1:iw*0.1:ih*0.6';
    const middle = 'iw*0.2:ih*0.2:iw*0.05:ih*0.4';   // clear of both boxes
    const camOn = patchRGB(outFile, 9.5, topRight), camOff = patchRGB(outFile, 2.0, topRight);
    const picOn = patchRGB(outFile, 12.5, btmLeft), picOff = patchRGB(outFile, 2.0, btmLeft);
    log(isGreen(camOn), 'THE SECOND VIDEO IS IN THE EXPORTED FILE, where it was placed', show(camOn));
    log(isBase(camOff), '…and only while its block covers the timeline', show(camOff));
    log(isRed(picOn), 'THE PICTURE IS IN THE EXPORTED FILE, where it was placed', show(picOn));
    log(isBase(picOff), '…and only while its block covers the timeline', show(picOff));
    log(isBase(patchRGB(outFile, 9.5, middle)), 'the rest of the frame is the untouched recording', show(patchRGB(outFile, 9.5, middle)));
    log(oi.hasAudio, 'the sound survived the composite');
  }

  /*
   * Console errors, measured as a DELTA. This harness registers only the handlers
   * the Video Studio needs, so the other studios (Presentation, Go Live) fail
   * their own boot-time IPC calls and log about it — noise that has nothing to do
   * with adding media. What matters is that nothing NEW appeared once the files
   * went on the timeline, so the boot snapshot is subtracted.
   */
  console.log('\n[8b] A clip added AFTER the video plays on, past its end');
  const tail = await js(win, `
    const T = window.VideoEditor.__test;
    T.seekTo(T.videoDuration());                       // the playhead parked at the very end
    await T.addAfter([${J(CAM2)}]);
    const st = T.tailState();
    const label = document.getElementById('veTime').textContent;
    T.seekTo(st.dur + 1.5);                            // tap the timeline inside the added clip
    const inTail = T.tailState();
    T.seekTo(1);                                       // and back inside the recording
    const back = T.tailState();
    return { st, label, inTail, back, ct: document.querySelector('#veDrop video').currentTime };`);
  const lastTail = tail.st.tail[tail.st.tail.length - 1];
  log(lastTail && Math.abs(lastTail.at - tail.st.mainEnd) < 0.05 || (lastTail && lastTail.at >= tail.st.mainEnd - 0.05), 'it starts where the video ends (not on top of a moment already over)', lastTail && `${lastTail.at.toFixed(2)} of ${tail.st.mainEnd.toFixed(2)}`);
  log(tail.st.playEnd > tail.st.dur + 1, 'the timeline now runs on to the end of it', `${tail.st.playEnd.toFixed(1)}s for a ${tail.st.dur.toFixed(1)}s video — ${tail.label}`);
  log(lastTail && lastTail.pipW > 0.99 || (lastTail && lastTail.pipY === 0), 'it fills the frame like a main clip', lastTail && `${lastTail.pipX},${lastTail.pipY} w${lastTail.pipW}`);
  log(tail.inTail.tailT != null && Math.abs(tail.inTail.tailT - (tail.st.dur + 1.5)) < 0.05, 'the playhead can go into it', String(tail.inTail.tailT));
  log(tail.back.tailT == null && Math.abs(tail.ct - 1) < 0.2, 'and back into the recording, which plays again', String(tail.ct));

  console.log('\n[9] Nothing broke along the way');
  const noise = /Autofill|DevTools|Electron Security|source-map|Failed to load resource|No handler registered/i;
  const boot = new Set(errorsAtBoot);
  const newErrors = errors.filter((m) => !boot.has(m) && !noise.test(m));
  log(newErrors.length === 0, 'no new console errors from adding, moving or exporting media', newErrors.slice(0, 3).join(' | '));
  const rejections = (await js(win, 'return window.__rej || [];')) || [];
  const newRejections = rejections.filter((r) => !noise.test(r));
  log(newRejections.length === 0, 'and no unhandled promise rejections', newRejections.slice(0, 2).join(' | '));
  if (errorsAtBoot.length) console.log('  (ignored, present before the test began: ' + JSON.stringify(errorsAtBoot) + ')');

  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('HARNESS ERROR', e); app.exit(1); });
