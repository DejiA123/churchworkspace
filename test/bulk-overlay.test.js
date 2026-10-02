'use strict';
/*
 * "I should be able to put an image over bulk uploaded videos in the Video Studio."
 *
 * The studio edits one video at a time, and dropping several used to open the
 * first and silently discard the rest. This proves the batch really works, by
 * running the real thing and then MEASURING THE FINISHED FILES:
 *
 *   1. four videos of DIFFERENT sizes and shapes (4K landscape, 1080p landscape,
 *      a 9:16 phone clip, a square) go into the batch through the real code path,
 *   2. one transparent PNG logo is placed once, with the real preview box,
 *   3. the box is dragged and resized with real mouse events — and the numbers
 *      the compositor will use must follow the box on screen,
 *   4. every video is exported through the REAL ffmpeg compositor,
 *   5. each finished file is decoded and checked: the logo is THERE, it is in
 *      the SAME RELATIVE PLACE on every one of them whatever their shape, the
 *      picture is otherwise untouched, the size/duration/sound survive,
 *   6. controls: the region where the logo ISN'T must be unchanged, and a
 *      deliberately different placement must land somewhere measurably else —
 *      or a pass would mean nothing.
 *
 * Run: npx electron test/bulk-overlay.test.js
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
const DIR = path.join(os.tmpdir(), 'mw-bulk-overlay');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

/* Four shapes on purpose: a placement given as a fraction has to mean the same
 * thing on all of them, and that is the only reason one gesture may apply to a
 * whole batch. Each is a flat mid-blue so any change to the picture stands out. */
const SHAPES = [
  { name: 'service-4k', w: 3840, h: 2160, dur: 3 },
  { name: 'service-1080', w: 1920, h: 1080, dur: 3 },
  { name: 'phone-vertical', w: 1080, h: 1920, dur: 3 },
  { name: 'square-post', w: 1080, h: 1080, dur: 3 },
];
function makeVideos() {
  return SHAPES.map((s) => {
    const p = path.join(DIR, s.name + '.mp4');
    const r = spawnSync(ffmpegBin, ['-y',
      '-f', 'lavfi', '-i', `color=c=0x1e3a5f:s=${s.w}x${s.h}:d=${s.dur}:r=25`,
      '-f', 'lavfi', '-i', `sine=frequency=200:duration=${s.dur}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-c:a', 'aac', '-shortest', p]);
    if (!fs.existsSync(p)) throw new Error('could not build ' + s.name + '\n' + r.stderr.toString().slice(-600));
    return Object.assign({ path: p }, s);
  });
}
/* A logo with real transparency: a solid magenta disc on a transparent square.
 * Magenta because nothing in the videos is remotely near it, so "is the logo
 * there" is answered by counting pixels rather than by eyeballing. */
function makeLogo() {
  const p = path.join(DIR, 'logo.png');
  spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=400x400,format=rgba',
    '-vf', "geq=r='if(lt(hypot(X-200,Y-200),170),255,0)':g='0':b='if(lt(hypot(X-200,Y-200),170),200,0)':a='if(lt(hypot(X-200,Y-200),170),255,0)'",
    '-frames:v', '1', p]);
  if (!fs.existsSync(p)) throw new Error('could not build the logo');
  return p;
}
const VIDEOS = makeVideos();
const LOGO = makeLogo();

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

const OUT = path.join(DIR, 'out');
fs.mkdirSync(OUT, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').replace(/\..*$/, '');

ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: DIR, ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(captioner.FONT_LIST.map((f) => f.name)));
ipcMain.handle('captions:fontList', () => ok(captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
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

/* The REAL bulk export route, mirroring main.js's video:overlayComposite —
 * including the outName that keeps each output tied to its source. */
const written = [];
ipcMain.handle('video:overlayComposite', wrap(async (e, { base, overlays, baseStart, baseEnd, toTemp, outName }) => {
  const output = toTemp
    ? path.join(DIR, `mw-pip-${Date.now()}.mp4`)
    : path.join(OUT, `${(outName || 'overlay').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}-${written.length}.mp4`);
  await video.exportOverlayComposite(ctx, { base, overlays: overlays || [], baseStart, baseEnd, output });
  written.push({ base, output, overlays });
  return output;
}));
ipcMain.handle('shell:showItem', () => ok(true));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
const js = (win, code) => win.webContents.executeJavaScript(code).catch((e) => ({ __error: String(e && e.message || e) }));

/* ------------------------- measuring a finished file ------------------------- */
/** One frame as RGB at a fixed grid, so every shape is compared in FRACTIONS. */
const GW = 120, GH = 120;
/** The magenta disc fills 340 of the logo PNG's 400 pixels, so it measures this
 *  fraction of whatever box the compositor draws the picture into. */
const DISC = 340 / 400;
function frameRGB(file, t) {
  const r = spawnSync(ffmpegBin, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `scale=${GW}:${GH}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  return b && b.length >= GW * GH * 3 ? b : null;
}
/** Where the magenta logo is, as fractions of the frame (x0..x1, y0..y1). */
function logoBox(buf) {
  if (!buf) return null;
  let x0 = GW, x1 = -1, y0 = GH, y1 = -1, n = 0;
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const p = (y * GW + x) * 3;
      const R = buf[p], G = buf[p + 1], B = buf[p + 2];
      // the disc is (255, 0, 200); the videos are (30, 58, 95)
      if (R > 150 && G < 110 && B > 110 && (R - G) > 90) {
        n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return {
    x0: +(x0 / GW).toFixed(3), x1: +((x1 + 1) / GW).toFixed(3),
    y0: +(y0 / GH).toFixed(3), y1: +((y1 + 1) / GH).toFixed(3),
    cx: +(((x0 + x1 + 1) / 2) / GW).toFixed(3), cy: +(((y0 + y1 + 1) / 2) / GH).toFixed(3),
    n,
  };
}
/** How much of the picture the burn changed, outside a given box. */
function changedOutside(a, b, box, thr = 24) {
  let n = 0;
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const fx = x / GW, fy = y / GH;
      if (box && fx >= box.x0 - 0.04 && fx <= box.x1 + 0.04 && fy >= box.y0 - 0.04 && fy <= box.y1 + 0.04) continue;
      const p = (y * GW + x) * 3;
      if (Math.abs(a[p] - b[p]) > thr || Math.abs(a[p + 1] - b[p + 1]) > thr || Math.abs(a[p + 2] - b[p + 2]) > thr) n++;
    }
  }
  return n;
}

app.whenReady().then(async () => {
  console.log(`batch: ${VIDEOS.map((v) => `${v.name} ${v.w}x${v.h}`).join(', ')}`);

  const win = new BrowserWindow({
    show: true, width: 1400, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1400);
  win.focus(); win.webContents.focus();
  await js(win, `(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    return true;
  })()`);
  await sleep(400);

  /* ---------------- 1) the batch ---------------- */
  console.log('\n[1] Four videos of four different shapes go in as a batch');
  const before = await js(win, `window.VideoEditor.__test.bulkPanel()`);
  check(before && before.shown === false, 'the batch panel stays out of the way until there is a batch');

  const added = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    await T.bulkAdd(${JSON.stringify(VIDEOS.map((v) => v.path))});
    return { files: T.bulkFiles(), panel: T.bulkPanel(), sel: T.bulkSel(),
             loaded: (document.getElementById('veName').textContent || '') };
  })()`);
  if (added.__error) console.error('[1] ' + added.__error);
  check(added.files && added.files.length === 4, 'all four are in the batch — not just the first',
    (added.files || []).map((f) => `${f.name} ${f.w}x${f.h}`).join(', '));
  check(added.panel.shown && added.panel.rows === 4, 'the panel lists every one of them', added.panel.rows + ' rows');
  check(/service-4k/.test(added.loaded), 'and the first one is loaded so there is something to place the picture on', added.loaded.trim());
  check(!added.panel.exportEnabled, 'Export All stays off until there is a picture to put on them');

  // adding the same files again must not double the batch
  const dupes = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    await T.bulkAdd(${JSON.stringify([VIDEOS[0].path, VIDEOS[1].path])});
    return T.bulkFiles().length;
  })()`);
  check(dupes === 4, 'adding the same files again does not duplicate them', dupes + ' files');

  /* ---------------- 2) one picture, placed once ---------------- */
  console.log('\n[2] One picture, placed once, on the real preview');
  const placed = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const o = await T.bulkSetImage(${JSON.stringify(LOGO)});
    return { o, panel: T.bulkPanel(), guide: T.bulkGuideBox(), payload: T.bulkPayload(0) };
  })()`);
  if (placed.__error) console.error('[2] ' + placed.__error);
  check(!!placed.o, 'the picture is on the batch', placed.o && placed.o.name);
  check(placed.panel.overlayRows === 1 && placed.panel.exportEnabled, 'the panel shows it and Export All comes alive', placed.panel.exportLabel);
  check(!!placed.guide, 'and a real, draggable box is drawn on the preview', JSON.stringify(placed.guide));
  // A watermark's home is the top-right of the WHOLE picture — not inside the
  // 9:16 window a short would be cropped to, which is where the picture-in-
  // picture default would have put it (mid-frame on a 16:9 service).
  check(placed.guide && placed.guide.x + placed.guide.w > 0.7 && placed.guide.y < 0.15,
    'it starts in the top-right corner of the full frame, where a logo goes',
    placed.guide && `x ${placed.guide.x.toFixed(3)}–${(placed.guide.x + placed.guide.w).toFixed(3)}, y ${placed.guide.y.toFixed(3)}`);
  // The box on screen and the numbers the compositor gets must be the same thing.
  if (placed.guide && placed.payload) {
    const p = placed.payload[0];
    check(Math.abs(p.x - placed.guide.x) < 0.01 && Math.abs(p.y - placed.guide.y) < 0.01 && Math.abs(p.wFrac - placed.guide.w) < 0.01,
      'the box on the preview IS what the compositor is told',
      `box ${placed.guide.x.toFixed(3)},${placed.guide.y.toFixed(3)} w${placed.guide.w.toFixed(3)} vs payload ${p.x.toFixed(3)},${p.y.toFixed(3)} w${p.wFrac.toFixed(3)}`);
  }

  /* ---------------- 3) dragging it ---------------- */
  console.log('\n[3] Dragging and resizing moves what gets exported');
  const dragged = await js(win, `(() => {
    const T = window.VideoEditor.__test;
    const a = T.bulkGuideBox();
    T.bulkDragImage(-38, 26, false);           // pull it left and down
    const b = T.bulkGuideBox();
    T.bulkDragImage(14, 0, true);              // and make it wider
    const c = T.bulkGuideBox();
    return { a, b, c, payload: T.bulkPayload(0), overlays: T.bulkOverlays() };
  })()`);
  if (dragged.__error) console.error('[3] ' + dragged.__error);
  check(dragged.b && dragged.b.x < dragged.a.x - 0.02 && dragged.b.y > dragged.a.y + 0.02,
    'dragging really moves it', `${dragged.a.x.toFixed(3)},${dragged.a.y.toFixed(3)} → ${dragged.b.x.toFixed(3)},${dragged.b.y.toFixed(3)}`);
  check(dragged.c && dragged.c.w > dragged.b.w + 0.01, 'the corner really resizes it',
    `w ${dragged.b.w.toFixed(3)} → ${dragged.c.w.toFixed(3)}`);
  check(dragged.payload && Math.abs(dragged.payload[0].x - dragged.c.x) < 0.01
    && Math.abs(dragged.payload[0].wFrac - dragged.c.w) < 0.01,
    'and the batch follows the box, not the other way round',
    `payload ${dragged.payload[0].x.toFixed(3)} w${dragged.payload[0].wFrac.toFixed(3)}`);

  /* the placement survives switching to another video in the batch */
  const switched = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const wanted = T.bulkOverlays()[0];
    await T.bulkOpen(2);                        // the 9:16 phone clip
    return { name: (document.getElementById('veName').textContent || '').trim(),
             sel: T.bulkSel(), guide: T.bulkGuideBox(), wanted,
             now: T.bulkOverlays()[0] };
  })()`);
  check(/phone-vertical/.test(switched.name || ''), 'clicking another video in the batch opens it', switched.name);
  check(switched.guide && Math.abs(switched.guide.x - switched.wanted.pipX) < 0.01
    && Math.abs(switched.guide.w - switched.wanted.pipW) < 0.01,
    'THE PLACEMENT SURVIVES: the same spot on a 9:16 clip as on the 4K one',
    `${switched.wanted.pipX.toFixed(3)},${switched.wanted.pipY.toFixed(3)} w${switched.wanted.pipW.toFixed(3)}`);

  /* ---------------- 4) export the whole batch ---------------- */
  console.log('\n[4] Exporting all four through the real compositor');
  const wantX = switched.wanted.pipX, wantY = switched.wanted.pipY, wantW = switched.wanted.pipW;
  await js(win, `window.VideoEditor.__test.bulkExport()`);
  for (let i = 0; i < 240 && written.length < 4; i++) await sleep(1000);
  check(written.length === 4, 'every video in the batch was written', written.length + ' files');
  check(new Set(written.map((w) => w.base)).size === written.length, 'one output per input — none exported twice');
  check(written.every((w) => /service-4k|service-1080|phone-vertical|square-post/.test(path.basename(w.output))),
    'each output is named after the video it came from',
    written.map((w) => path.basename(w.output)).join(', '));

  /* ---------------- 5) the finished files really carry it ---------------- */
  console.log('\n[5] What is actually in the finished files');
  for (const w of written) {
    const src = VIDEOS.find((v) => v.path === w.base);
    const info = await video.getInfo(ctx, w.output);
    check(info.width === src.w && info.height === src.h,
      `${src.name}: exported at its OWN size, not squeezed into a preset`, `${info.width}x${info.height}`);
    check(info.durationSec > src.dur - 0.6 && info.hasAudio, `${src.name}: full length, sound intact`,
      `${info.durationLabel}${info.hasAudio ? ' + audio' : ' NO AUDIO'}`);

    const plain = frameRGB(w.base, 1.5), done = frameRGB(w.output, 1.5);
    const box = logoBox(done);
    check(!logoBox(plain), `${src.name}: the source had no logo to begin with (the test can tell)`);
    check(!!box && box.n > 25, `${src.name}: THE LOGO IS IN THE FINISHED FILE`, box ? box.n + ' logo pixels' : 'NONE');
    if (box) {
      /*
       * The placement is the box's TOP-LEFT and its WIDTH, both as fractions of
       * the frame — so those are what to measure. (The logo drawn inside that box
       * is a disc touching its edges: 340px across a 400px picture, so the
       * magenta is DISC of the box's width and sits DISC/2 in from its left.)
       */
      const wantCx = wantX + wantW / 2;
      check(Math.abs(box.cx - wantCx) < 0.03,
        `${src.name}: …at the same fraction across the frame`, `centre x ${box.cx} vs ${wantCx.toFixed(3)}`);
      check(Math.abs((box.x1 - box.x0) - wantW * DISC) < 0.035,
        `${src.name}: …and at the size it was given`,
        `width ${(box.x1 - box.x0).toFixed(3)} vs ${(wantW * DISC).toFixed(3)}`);
      // The top edge is the number that was set, and it must be the same on every
      // shape — unlike the centre, which moves with the logo's own height.
      check(Math.abs(box.y0 - wantY) < 0.05, `${src.name}: …and at the same height down the frame`,
        `top ${box.y0} vs ${wantY.toFixed(3)}`);
      const outside = changedOutside(plain, done, box);
      check(outside < 40, `${src.name}: the rest of the picture is untouched`, outside + ' changed pixels outside the logo');
    }
  }

  /* Every file has to agree with every other on WHERE the logo is — that is the
   * whole promise of placing it once. */
  const centres = written.map((w) => {
    const b = logoBox(frameRGB(w.output, 1.5));
    return b ? { name: path.basename(w.base), cx: b.cx, cy: b.cy, x0: b.x0, y0: b.y0, w: +(b.x1 - b.x0).toFixed(3) } : null;
  }).filter(Boolean);
  /*
   * What "the same spot on every one of them" actually means: the same fraction
   * ACROSS the frame, the same fraction DOWN it, and the same fraction OF ITS
   * WIDTH. The logo's height as a share of the frame is necessarily different on
   * a 9:16 clip than on a 16:9 one — a fixed fraction of the width is a bigger
   * fraction of a shorter frame — so the centre's Y is not the invariant here;
   * the top edge is.
   */
  const spread = (k) => Math.max(...centres.map((c) => c[k])) - Math.min(...centres.map((c) => c[k]));
  check(centres.length === 4 && spread('cx') < 0.04 && spread('y0') < 0.04 && spread('w') < 0.03,
    'ALL FOUR SHAPES agree on where the logo sits and how big it is',
    centres.map((c) => `${c.name} x${c.cx} top${c.y0} w${c.w}`).join(' · '));

  /* ---------------- 6) the control: a different placement must land elsewhere ---- */
  console.log('\n[6] The measurement can fail');
  written.length = 0;
  const moved = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    await T.bulkOpen(0);
    T.bulkDragImage(-70, -40, false);   // shove it well away
    const g = T.bulkGuideBox();
    // export ONE file to compare against
    const p = T.bulkPayload(0);
    return { g, p };
  })()`);
  const controlOut = path.join(OUT, 'control.mp4');
  await video.exportOverlayComposite(ctx, { base: VIDEOS[0].path, overlays: moved.p, output: controlOut });
  const cBox = logoBox(frameRGB(controlOut, 1.5));
  check(!!cBox, 'the control render has the logo too');
  if (cBox && centres.length) {
    const moveDist = Math.abs(cBox.cx - centres[0].cx) + Math.abs(cBox.cy - centres[0].cy);
    check(moveDist > 0.12, 'moving the box moves the logo in the FILE — so a match above meant something',
      `centre ${centres[0].cx},${centres[0].cy} → ${cBox.cx},${cBox.cy}`);
  }

  /* ---------------- 6b) how solid it is, on screen AND in the file -------- */
  console.log('\n[6b] Dialling the watermark down');
  const faint = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    await T.bulkOpen(3);                              // the small square clip
    const id = T.bulkOverlays()[0].id;
    const solidOnScreen = T.bulkPreviewOpacity();
    T.bulkSetOpacity(id, 0.4);
    return { solidOnScreen, faintOnScreen: T.bulkPreviewOpacity(), payload: T.bulkPayload(3) };
  })()`);
  check(faint.solidOnScreen === 1 && Math.abs(faint.faintOnScreen - 0.4) < 0.01,
    'the PREVIEW goes faint with it (it used to stay solid until the file came out)',
    `${faint.solidOnScreen} → ${faint.faintOnScreen}`);
  check(faint.payload && Math.abs(faint.payload[0].opacity - 0.4) < 0.01,
    '…and the compositor is told the same number', 'opacity ' + faint.payload[0].opacity);
  const faintOut = path.join(OUT, 'faint.mp4');
  await video.exportOverlayComposite(ctx, { base: VIDEOS[3].path, overlays: faint.payload, output: faintOut });
  const faintFrame = frameRGB(faintOut, 1.5);
  const faintBox = logoBox(faintFrame);
  // At 40% the magenta is blended most of the way back to the blue behind it, so
  // the strict colour test should no longer find much of it at all.
  check(!faintBox || faintBox.n < 40, 'and the finished file really is faint',
    faintBox ? faintBox.n + ' full-strength pixels left (was ~198)' : 'none at full strength');
  // …but something IS still drawn there — faint is not gone.
  const plainSq = frameRGB(VIDEOS[3].path, 1.5);
  let touched = 0;
  for (let i = 0; i < GW * GH; i++) {
    const p = i * 3;
    if (Math.abs(plainSq[p] - faintFrame[p]) > 20) touched++;
  }
  check(touched > 60, '…not gone', touched + ' pixels still changed by the watermark');

  /* ---------------- 7) emptying the batch ---------------- */
  const cleared = await js(win, `(() => {
    const T = window.VideoEditor.__test; T.bulkClear();
    return { files: T.bulkFiles().length, panel: T.bulkPanel() };
  })()`);
  check(cleared.files === 0 && !cleared.panel.shown, 'clearing the batch puts the panel away again');
  check(VIDEOS.every((v) => fs.existsSync(v.path)), 'and every source video is still on disk, untouched');

  console.log(`\n  artefacts for eyeballing: ${OUT}`);
  console.log(`\n==== bulk overlay: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
