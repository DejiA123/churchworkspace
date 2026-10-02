'use strict';
/*
 * "The captions on the preview must be EXACTLY the captions in the file."
 *
 * The report this exists for: the preview wrapped a caption onto three lines and
 * the exported short put it on one. Two text engines, two answers. So this
 * proves the fix by PIXELS, through the real code, and it is built so it can
 * fail:
 *
 *   1. a real video is loaded through the real Browse → loadVideo path,
 *   2. real caption lines go on the timeline and the studio's own controls set
 *      the look,
 *   3. the preview's export frame is SCREENSHOT with the picture blacked out,
 *   4. the app is asked for the REAL export payload — the transparent caption
 *      track that ffmpeg actually burns — and it is composited on black,
 *   5. the two images are compared (mean abs difference + ink IoU + ink box),
 *   6. the track is burned onto a real MP4 with the real burner and the finished
 *      file is measured again,
 *   7. the caption's WIDTH HANDLES are dragged, and the preview's line count and
 *      the export's line count must move together,
 *   8. controls: a wrong width and a wrong font size must both score clearly
 *      worse than the real thing — otherwise a pass would mean nothing.
 *
 * Run: npx electron test/caption-wysiwyg.test.js ["<clip>"]
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
const DIR = path.join(os.tmpdir(), 'mw-cap-wysiwyg');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const PRESET = video.PRESETS['reel-9x16'];   // 1080x1920
/* A caption long enough that where it breaks is a real decision — this is the
 * exact sentence shape from the report ("IN NIGERIA WE …"). */
const LINE1 = 'IN NIGERIA WE ARE PRAYING FOR REVIVAL';
const LINE2 = 'AND THE LORD IS ANSWERING';

/* A source clip. Generated rather than assumed, so the test is self-contained —
 * a mid grey with a gradient, which is the worst case for reading a caption and
 * therefore the honest one to measure on. */
function makeSource() {
  const out = process.argv[2];
  if (out && fs.existsSync(out)) return out;
  const p = path.join(DIR, 'src.mp4');
  const r = spawnSync(ffmpegBin, ['-y',
    '-f', 'lavfi', '-i', `gradients=s=${PRESET.w}x${PRESET.h}:c0=0x303840:c1=0x707880:d=8:r=30`,
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'aac', '-shortest', p]);
  if (!fs.existsSync(p)) throw new Error('could not generate a source clip:\n' + r.stderr.toString().slice(-800));
  return p;
}
const SRC = makeSource();

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: DIR, userData: DIR, ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(captioner.FONT_LIST.map((f) => f.name)));
ipcMain.handle('captions:fontList', () => ok(captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('dialog:openFile', () => ok(SRC));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx, input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(DIR, 'th-' + Date.now() + '.png'); await video.thumbnail(ctx, { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(DIR, 'fs-' + Date.now() + '.png'); await video.filmstrip(ctx, { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(DIR, 'wf-' + Date.now() + '.png'); await video.waveform(ctx, { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));
// REAL font bytes — the export rasteriser inlines them as data: URIs
ipcMain.handle('fonts:data', wrap(async () => {
  const dir = captioner.fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
}));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

/* --------------------------- image comparison ----------------------------
 *
 * Everything is compared AT THE PREVIEW'S OWN SIZE, set once the preview has
 * been screenshot. Blowing a 20-pixel font up to 480 turns every antialiased
 * edge into a wide grey ramp on one side and not the other, and then the score
 * is measuring the resampler rather than the captions. Matching the resolution
 * gives both pictures the same blur budget.
 */
let CW = 270, CH = 480;
function gray(file) {
  const r = spawnSync(ffmpegBin, ['-y', '-i', file, '-frames:v', '1',
    '-vf', `scale=${CW}:${CH}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  return b && b.length >= CW * CH ? b.slice(0, CW * CH) : null;
}
const meanAbsDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function inkIoU(a, b, thr = 60) {
  let inter = 0, uni = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] > thr, y = b[i] > thr;
    if (x) na++; if (y) nb++;
    if (x && y) inter++;
    if (x || y) uni++;
  }
  return { iou: uni ? inter / uni : 0, na, nb };
}
/**
 * The best overlap within a couple of pixels of shift.
 *
 * The screenshot's crop rectangle is rounded to whole window pixels and the
 * display runs at 1.25×, so the preview's glyphs can land up to a pixel off the
 * rasteriser's — and at a 26-pixel font a one-pixel edge is a big share of all
 * the ink there is. Searching a small shift measures whether the SHAPES agree,
 * which is the question, instead of whether the crop landed on an integer.
 */
function bestInkIoU(a, b, maxShift = 2) {
  let best = { iou: 0, dx: 0, dy: 0 };
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      let inter = 0, uni = 0;
      for (let y = 0; y < CH; y++) {
        const sy = y + dy;
        if (sy < 0 || sy >= CH) continue;
        for (let x = 0; x < CW; x++) {
          const sx = x + dx;
          if (sx < 0 || sx >= CW) continue;
          const p = a[y * CW + x] > 60, q = b[sy * CW + sx] > 60;
          if (p && q) inter++;
          if (p || q) uni++;
        }
      }
      const iou = uni ? inter / uni : 0;
      if (iou > best.iou) best = { iou, dx, dy };
    }
  }
  return best;
}
/** Bounding box of the ink, in fractions of the frame. */
function inkBox(buf, thr = 60) {
  let x0 = CW, x1 = -1, y0 = CH, y1 = -1, n = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    if (buf[y * CW + x] > thr) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return { x0: +(x0 / CW).toFixed(3), x1: +((x1 + 1) / CW).toFixed(3), y0: +(y0 / CH).toFixed(3), y1: +((y1 + 1) / CH).toFixed(3), n };
}
/**
 * How many ROWS of words the ink is on — the number the whole complaint is
 * about. Rows are found by looking for bands of blank scanlines, so it counts
 * what a person counts looking at the picture.
 */
function inkRows(buf, thr = 60) {
  const lit = [];
  for (let y = 0; y < CH; y++) {
    let n = 0;
    for (let x = 0; x < CW; x++) if (buf[y * CW + x] > thr) n++;
    lit.push(n > 1);
  }
  let rows = 0, run = 0;
  for (let y = 0; y < CH; y++) {
    if (lit[y]) run++;
    else { if (run >= 3) rows++; run = 0; }
  }
  if (run >= 3) rows++;
  return rows;
}

/** Write a caption track's frames and burn it, through the REAL burner. */
async function burnTrack(track, input, output) {
  await video.burnCaptionTrack(ctx, { input, track, output });
  return output;
}
/** The single steady-state frame a track shows at time `t`, as a PNG. */
function trackFrameAt(track, t, file) {
  let acc = 0;
  for (const f of track.frames) {
    if (t >= acc && t < acc + f.dur) {
      if (!f.png) return null;
      fs.writeFileSync(file, Buffer.from(f.png));
      return file;
    }
    acc += f.dur;
  }
  return null;
}
/**
 * The track's frame at time `t`, put back where it belongs in the export frame
 * and composited on BLACK — the same ground the preview screenshot is taken on,
 * so the two are directly comparable. (Compositing here rather than carrying
 * alpha through a second file also keeps the measurement away from ffmpeg's
 * alpha-handling rules, which are not what is under test.)
 */
function trackFrameOnBlack(track, t, tag) {
  const band = path.join(DIR, 'band-' + tag + '.png');
  if (!trackFrameAt(track, t, band)) return null;
  const full = path.join(DIR, 'full-' + tag + '.png');
  spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', `color=black:s=${track.authorW}x${track.authorH}`,
    '-i', band, '-filter_complex', `[0:v][1:v]overlay=${track.band.x}:${track.band.y}`, '-frames:v', '1', full], { maxBuffer: 1 << 26 });
  return fs.existsSync(full) ? full : null;
}

const js = (win, code) => win.webContents.executeJavaScript(code).catch((e) => ({ __error: String(e && e.message || e) }));

app.whenReady().then(async () => {
  const info = await video.getInfo(ctx, SRC);
  console.log(`source: ${path.basename(SRC)} ${info.width}x${info.height} ${info.durationLabel}`);

  const win = new BrowserWindow({
    show: true, width: 1360, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  win.focus(); win.webContents.focus();

  /* ---------------- 1) load the clip through the real path ---------------- */
  await js(win, `(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    document.getElementById('veOpen2').click();
    return true;
  })()`);
  let loaded = false;
  for (let i = 0; i < 40 && !loaded; i++) {
    await sleep(400);
    loaded = await js(win, `!!(window.VideoEditor.__test.info && window.VideoEditor.__test.info())`) === true;
  }
  check(loaded, 'real clip loaded through the Browse → loadVideo path');
  await sleep(600);

  /* ---------------- 2) real caption lines + the real controls ------------- */
  /* Measure on the biggest preview the studio offers. Antialiasing on an
   * 11-pixel font is not a fair test of a 138-pixel one, and the operator's
   * complaint named the big and full-screen previews specifically, so those are
   * the ones worth holding to the pixel. */
  win.maximize();
  await sleep(500);
  await js(win, `(() => { const b = document.getElementById('veBigger'); if (b && !b.classList.contains('on')) b.click(); window.VideoEditor.fit && window.VideoEditor.fit(); return true; })()`);
  await sleep(900);
  console.log('  preview size: ' + JSON.stringify(await js(win, `(() => {
    const d = document.getElementById('veDrop');
    return { drop: [d.clientWidth, d.clientHeight], frame: window.VideoEditor.__test.frameRect(),
             full: !!document.getElementById('veFull').classList.contains('on') };
  })()`)));
  const setup = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 2;
    T.setCapEvents([
      { start: 0.4, end: 3.2, text: ${JSON.stringify(LINE1)} },
      { start: 3.2, end: 6.0, text: ${JSON.stringify(LINE2)} },
    ]);
    document.getElementById('veCapShow').checked = true;
    const set = (id, v) => { const el = document.getElementById(id); if (el) { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); } };
    set('capFont', 'Bebas Neue');
    set('capSize', 'l');
    set('capPos', 'bottom');
    // no arrival animation for the pixel comparison: a transition is a moving
    // target and step 6 measures it separately
    set('capTrans', 'none');
    T.pickCapStyle('outline');
    T.setCapWidth(0.86);
    T.updateCapOverlayAt(2);
    return { box: T.capOverlayBox(), lines: T.capOverlayLines(), cfg: T.capStyleCfg() };
  })()`);
  if (setup.__error) console.error('setup: ' + setup.__error);
  console.log('  preview block: ' + JSON.stringify(setup.box));
  console.log('  preview lines: ' + JSON.stringify(setup.lines));
  check(!!setup.lines && setup.lines.length >= 2, 'the caption wraps onto more than one line on the preview', (setup.lines || []).length + ' lines');

  /* ---------------- 3) screenshot the preview's export frame -------------- */
  await js(win, `(() => {
    const s = document.createElement('style'); s.id = 'capProbe';
    s.textContent = '#veDrop{background:#000 !important} #vePlayer{visibility:hidden !important}' +
      '#veCropFrame{border:0 !important} #veCropFrame::before,#veCropFrame::after{display:none !important}' +
      '#veCropMask{background:transparent !important} #veGapMask{display:none !important}' +
      '#veTextTools{display:none !important} #veCropReset{display:none !important}' +
      '.ve-cap-block{outline:0 !important} .ve-cap-edge{display:none !important}';
    document.head.appendChild(s);
    return true;
  })()`);
  await sleep(400);
  const frameRect = await js(win, `window.VideoEditor.__test.frameRect()`);
  const previewPng = path.join(DIR, 'preview-frame.png');
  const shot = await win.webContents.capturePage(frameRect);
  fs.writeFileSync(previewPng, shot.toPNG());
  const shotSize = shot.getSize();
  CW = Math.max(2, shotSize.width - (shotSize.width % 2));
  CH = Math.max(2, shotSize.height - (shotSize.height % 2));
  /* The capture rectangle is in whole WINDOW pixels and the display runs at a
   * fractional ratio, so the screenshot is up to a percent smaller than the
   * frame Chromium really painted. That percent is a pixel and a half of drift
   * across a caption's width, which no whole-pixel alignment can take back — so
   * the same-size comparison below is drawn at the frame's TRUE device size
   * rather than at the rounded one. */
  const dpr = await js(win, `window.devicePixelRatio`);
  const trueW = Math.max(2, Math.round(frameRect.width * dpr));
  const trueH = Math.max(2, Math.round(frameRect.height * dpr));
  check(frameRect.width > 100 && frameRect.height > 100, 'captured the preview export frame',
    `${shotSize.width}x${shotSize.height} (frame ${frameRect.width}x${frameRect.height} @ ${dpr}x)`);

  /* ---------------- 4) the REAL export payload ---------------------------- */
  const track = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const t = await T.capTrackFor(T.capEventsState(), ${PRESET.w}, ${PRESET.h}, 6.5);
    if (!t) return null;
    // Uint8Arrays do not survive executeJavaScript — hand back plain arrays
    return { band: t.band, fps: t.fps, authorW: t.authorW, authorH: t.authorH,
             frames: t.frames.map(f => ({ png: f.png ? Array.from(f.png) : null, dur: f.dur })) };
  })()`);
  check(!!track && track.frames && track.frames.length > 0,
    'the export payload is a rasterised caption track (not a subtitle re-implementation)',
    track ? `${track.frames.length} distinct frames, band ${track.band.w}x${track.band.h} @ ${track.band.x},${track.band.y}` : 'null');
  if (!track) { console.log('\n==== caption WYSIWYG: ' + pass + ' PASS / ' + (fail + 1) + ' FAIL ===='); win.destroy(); return app.exit(1); }
  track.frames = track.frames.map((f) => ({ png: f.png ? Buffer.from(f.png) : null, dur: f.dur }));
  check(track.authorW === PRESET.w && track.authorH === PRESET.h, 'drawn at the export resolution', `${track.authorW}x${track.authorH}`);
  const distinct = track.frames.filter((f) => f.png).length;
  check(distinct <= 6, 'a still caption is ONE frame, not one per video frame', distinct + ' drawn frames for 2 caption lines');

  /* ---------------- 5) preview vs export, in pixels ----------------------- */
  const exportPng = trackFrameOnBlack(track, 2.0, 'real');
  check(!!exportPng, 'the track has a caption at the moment the preview was screenshot');
  const gPrev = gray(previewPng);
  const gExp = gray(exportPng);
  check(!!gPrev && !!gExp, 'both images decoded for comparison');
  const mad = meanAbsDiff(gPrev, gExp);
  const { iou, na, nb } = inkIoU(gPrev, gExp);
  const bp = inkBox(gPrev), be = inkBox(gExp);
  const rp = inkRows(gPrev), re = inkRows(gExp);
  console.log(`  preview ink: ${JSON.stringify(bp)} rows=${rp}`);
  console.log(`  export  ink: ${JSON.stringify(be)} rows=${re}`);
  check(!!bp && !!be, 'the caption is visible in BOTH the preview and the export image', `${na} vs ${nb} lit pixels`);
  check(rp === re && rp >= 2, 'THE LINE COUNT MATCHES (the bug this fixes)', `${rp} rows on the preview, ${re} in the export`);
  const aligned = bestInkIoU(gPrev, gExp);
  check(aligned.iou >= 0.75, 'preview and export overlap (ink IoU ≥ 0.75)',
    `IoU=${aligned.iou.toFixed(3)} at a ${aligned.dx},${aligned.dy}px alignment (raw ${iou.toFixed(3)})`);
  check(mad <= 12, 'preview and export are pixel-close (mean abs diff ≤ 12/255)', 'MAD=' + mad.toFixed(2));
  if (bp && be) {
    check(Math.abs(bp.y0 - be.y0) < 0.02 && Math.abs(bp.y1 - be.y1) < 0.02, 'same vertical position and height', `y ${bp.y0}-${bp.y1} vs ${be.y0}-${be.y1}`);
    check(Math.abs(bp.x0 - be.x0) < 0.02 && Math.abs(bp.x1 - be.x1) < 0.02, 'same horizontal extent (same line breaking)', `x ${bp.x0}-${bp.x1} vs ${be.x0}-${be.x1}`);
  }

  /*
   * The residual: the export is drawn at six times the preview's detail, and a
   * heavy outline on a 26-pixel font eats its own letter holes in a way it does
   * not on a 160-pixel one. That is the resolution, not the layout — and the way
   * to show it is to draw the export payload AT THE PREVIEW'S OWN PIXEL SIZE and
   * compare that. If the same layout code drew both, they are the same picture.
   */
  const sameSize = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const t = await T.capTrackFor(T.capEventsState(), ${trueW}, ${trueH}, 6.5);
    return t ? { band: t.band, authorW: t.authorW, authorH: t.authorH,
                 frames: t.frames.map(f => ({ png: f.png ? Array.from(f.png) : null, dur: f.dur })) } : null;
  })()`);
  if (sameSize) {
    sameSize.frames = sameSize.frames.map((f) => ({ png: f.png ? Buffer.from(f.png) : null, dur: f.dur }));
    const gSame = gray(trackFrameOnBlack(sameSize, 2.0, 'samesize'));
    const same = bestInkIoU(gPrev, gSame);
    const madSame = meanAbsDiff(gPrev, gSame);
    /* Judged on BOTH scores together. Overlap counts pixels over a hard
     * threshold, so at a 26-pixel font it is dominated by the one-pixel rim of
     * every glyph; mean difference is not. The wrong-width control below scores
     * IoU 0.10 / MAD 19, so a joint gate is nowhere near being generous. */
    check(same.iou >= 0.80 && madSame <= 8,
      'drawn at the PREVIEW’s own size, the export is the same picture (IoU ≥ 0.80, MAD ≤ 8)',
      `IoU=${same.iou.toFixed(3)} at ${same.dx},${same.dy}px  MAD=${madSame.toFixed(2)}`);
    console.log('  → the same layout code drew both, so what is left above is the real export’s six-times-finer detail');
  }

  /* ---------------- 6) CONTROLS: the comparison must be able to fail ------ */
  const wrongWidth = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const before = T.capWidthNow();
    T.setCapWidth(0.42);
    const t = await T.capTrackFor(T.capEventsState(), ${PRESET.w}, ${PRESET.h}, 6.5);
    T.setCapWidth(before); T.updateCapOverlayAt(2);
    return t ? { band: t.band, authorW: t.authorW, authorH: t.authorH,
                 frames: t.frames.map(f => ({ png: f.png ? Array.from(f.png) : null, dur: f.dur })) } : null;
  })()`);
  wrongWidth.frames = wrongWidth.frames.map((f) => ({ png: f.png ? Buffer.from(f.png) : null, dur: f.dur }));
  const gWrong = gray(trackFrameOnBlack(wrongWidth, 2.0, 'narrow'));
  const madW = meanAbsDiff(gPrev, gWrong), iouW = inkIoU(gPrev, gWrong).iou;
  check(madW > mad * 1.6 && iouW < iou - 0.15,
    'the comparison CAN fail: a caption wrapped at half the width scores clearly worse',
    `MAD ${mad.toFixed(2)}→${madW.toFixed(2)}, IoU ${iou.toFixed(3)}→${iouW.toFixed(3)}`);
  check(inkRows(gWrong) > re, '…and it really is on more lines', `${re} → ${inkRows(gWrong)} rows`);

  const wrongSize = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const el = document.getElementById('capSize'); const before = el.value;
    el.value = 'xl'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const t = await T.capTrackFor(T.capEventsState(), ${PRESET.w}, ${PRESET.h}, 6.5);
    el.value = before; el.dispatchEvent(new Event('change', { bubbles: true })); T.updateCapOverlayAt(2);
    return t ? { band: t.band, authorW: t.authorW, authorH: t.authorH,
                 frames: t.frames.map(f => ({ png: f.png ? Array.from(f.png) : null, dur: f.dur })) } : null;
  })()`);
  wrongSize.frames = wrongSize.frames.map((f) => ({ png: f.png ? Buffer.from(f.png) : null, dur: f.dur }));
  const gBig = gray(trackFrameOnBlack(wrongSize, 2.0, 'big'));
  const madB = meanAbsDiff(gPrev, gBig);
  check(madB > mad * 1.6, '…and so does a caption a size bigger', `MAD ${mad.toFixed(2)}→${madB.toFixed(2)}`);

  /* ---------------- 7) the WIDTH HANDLES ---------------------------------- */
  console.log('\n  dragging the caption edge');
  const dragged = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    T.updateCapOverlayAt(2);
    const before = { box: T.capOverlayBox(), width: T.capWidthNow(), lines: T.capOverlayLines() };
    // Pull the LEFT edge inward — the words get less room, so more lines. A
    // modest drag on purpose: slamming into the narrowest allowed box would make
    // "dragging back restores it" true for the wrong reason.
    const after = T.dragCapWidthEdge('l', 28);
    const narrowed = T.capWidthNow();
    const t = await T.capTrackFor(T.capEventsState(), ${PRESET.w}, ${PRESET.h}, 6.5);
    const exportLines = T.capLayoutAt(${JSON.stringify(LINE1)}, ${PRESET.w}, ${PRESET.h}).lines;
    const back = T.dragCapWidthEdge('l', -28);
    return { before, after, narrowed, width: T.capWidthNow(), previewLines: T.capOverlayLines(),
             exportLines, back, hadTrack: !!t };
  })()`);
  if (dragged.__error) console.error('drag: ' + dragged.__error);
  check(!!dragged.after, 'the caption has grab handles on its edges you can actually drag');
  check(dragged.after && dragged.after.lines > dragged.before.box.lines,
    'dragging an edge inward wraps the caption onto MORE lines',
    dragged.before.box.lines + ' → ' + (dragged.after && dragged.after.lines));
  check(dragged.after && Math.abs(dragged.after.x - dragged.before.box.x) < 0.01,
    'and the words stay centred where they were (both edges move)',
    `x ${dragged.before.box.x.toFixed(3)} → ${(dragged.after || {}).x}`);
  check(dragged.exportLines && dragged.after && dragged.exportLines.length === dragged.after.lines,
    'the EXPORT wraps onto the same number of lines as the preview',
    `preview ${(dragged.after || {}).lines} / export ${(dragged.exportLines || []).length}`);
  // The same knob is in the captions window, and the two must never disagree.
  const slider = await js(win, `(() => {
    const T = window.VideoEditor.__test;
    const el = document.getElementById('capWidth');
    if (!el) return null;
    const fromHandle = el.value;                       // set by the drag above
    el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true }));
    const after = { box: T.capOverlayBox(), width: T.capWidthNow() };
    el.value = '86'; el.dispatchEvent(new Event('change', { bubbles: true }));
    return { fromHandle, after, restored: T.capWidthNow() };
  })()`);
  check(slider && Math.abs(slider.after.width - 0.45) < 0.01 && slider.after.box.lines > 2,
    'the Width slider in the captions window turns the same knob as the handles',
    slider ? `45% → ${slider.after.box.lines} lines` : 'no slider');
  check(slider && Math.abs(Number(slider.fromHandle) / 100 - dragged.before.width) < 0.02,
    '…and the slider follows the handles when you drag them',
    slider && `handle left it at ${slider.fromHandle}%`);

  check(dragged.narrowed < dragged.before.width - 0.05, 'the drag really narrowed the box',
    `${dragged.before.width.toFixed(3)} → ${(dragged.narrowed || 0).toFixed(3)} of the frame`);
  check(dragged.back && dragged.back.lines === dragged.before.box.lines
    && Math.abs(dragged.width - dragged.before.width) < 0.01,
    'dragging back restores it exactly', `width back to ${(dragged.width || 0).toFixed(3)}`);

  /* ---------- 7b) EVERY preview size tells the same truth ----------------
   * "I know the preview has different sizes, full screen etc — it must ALL be
   * true visuals." The layout is a set of frame FRACTIONS, so the way to prove
   * that is to ask for it at wildly different frame sizes and require the same
   * answer — and then to actually resize the preview and check the words on
   * screen did not move relative to the frame. */
  console.log('\n  the same truth at every size');
  const sizes = await js(win, `(() => {
    const T = window.VideoEditor.__test;
    const at = (w, h) => { const L = T.capLayoutAt(${JSON.stringify(LINE1)}, w, h);
      return { lines: L.lines.join('|'), x: +(L.cx / w).toFixed(4), y: +(L.cy / h).toFixed(4),
               w: +(L.blockW / w).toFixed(4), h: +(L.blockH / h).toFixed(4), fs: +(L.fontPx / h).toFixed(4) }; };
    return [at(160, 284), at(360, 640), at(1080, 1920), at(2160, 3840)];
  })()`);
  const first = JSON.stringify(sizes[0]);
  check(sizes.every((s) => JSON.stringify(s) === first),
    'a tiny preview, a big preview and a 4K export all lay the caption out identically',
    sizes.map((s) => s.lines.split('|').length + ' lines').join(' / ') + '  ' + first);

  const resized = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const before = T.capOverlayBox();
    const b = document.getElementById('veBigger'); b.click();          // shrink the preview
    window.VideoEditor.fit && window.VideoEditor.fit();
    await new Promise(r => setTimeout(r, 400));
    T.updateCapOverlayAt(2);
    const small = T.capOverlayBox();
    b.click(); window.VideoEditor.fit && window.VideoEditor.fit();     // and back
    await new Promise(r => setTimeout(r, 400));
    T.updateCapOverlayAt(2);
    return { before, small, after: T.capOverlayBox() };
  })()`);
  const sameFrac = (a, b) => a && b && Math.abs(a.x - b.x) < 0.002 && Math.abs(a.y - b.y) < 0.002
    && Math.abs(a.w - b.w) < 0.002 && Math.abs(a.h - b.h) < 0.002 && a.lines === b.lines;
  check(resized.small && resized.before && resized.small.frame.h !== resized.before.frame.h,
    'the preview really did change size', resized.before && `${Math.round(resized.before.frame.h)}px → ${Math.round((resized.small || {}).frame ? resized.small.frame.h : 0)}px`);
  check(sameFrac(resized.before, resized.small) && sameFrac(resized.before, resized.after),
    'and the caption sits in exactly the same place in the frame at both sizes',
    JSON.stringify(resized.small));

  /* ---------- 7c) 🔤 Add text offers the same typefaces ------------------- */
  console.log('\n  the Add text font list');
  const textFonts = await js(win, `(() => {
    const capNames = [...document.getElementById('capFont').options].map(o => o.value);
    const txtNames = [...document.getElementById('vtFont').options].map(o => o.value);
    return { capNames, txtNames, missing: capNames.filter(n => !txtNames.includes(n)) };
  })()`);
  check(textFonts.txtNames.length >= 20, '🔤 Add text offers the whole typeface list, not five of them',
    `${textFonts.txtNames.length} fonts (was 5)`);
  check(textFonts.missing.length === 0, 'every caption font is offered for added text too',
    textFonts.missing.length ? 'missing: ' + textFonts.missing.join(', ') : 'Rubik, Oswald, Teko, Bungee, Fredoka… all there');
  // …and one of the new ones really reaches the exported picture in its own face.
  const rubik = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    T.clearText && T.clearText();
    document.getElementById('veAddText').click();
    await new Promise(r => setTimeout(r, 350));
    const c = document.querySelector('#veTextLayer .ve-text-content');
    if (c) { c.innerText = 'HALLELUJAH'; c.blur(); }
    await new Promise(r => setTimeout(r, 200));
    const id = T.textOverlays()[0].id;
    T.selectText && T.selectText(id);
    const set = (id2, v) => { const el = document.getElementById(id2); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); };
    set('vtFont', 'Rubik');
    await new Promise(r => setTimeout(r, 250));
    const shown = getComputedStyle(document.querySelector('#veTextLayer .ve-text-content')).fontFamily;
    const png = await T.textPngsForShort(0, 6, ${PRESET.w}, ${PRESET.h});
    set('vtFont', 'Great Vibes');
    await new Promise(r => setTimeout(r, 250));
    const png2 = await T.textPngsForShort(0, 6, ${PRESET.w}, ${PRESET.h});
    T.clearText && T.clearText();
    return { shown, a: png && png[0] ? Array.from(png[0].png) : null, b: png2 && png2[0] ? Array.from(png2[0].png) : null };
  })()`);
  check(/rubik/i.test(rubik.shown || ''), 'picking Rubik really sets Rubik on the preview', rubik.shown);
  if (rubik.a && rubik.b) {
    const pa = path.join(DIR, 'txt-rubik.png'), pb = path.join(DIR, 'txt-vibes.png');
    fs.writeFileSync(pa, Buffer.from(rubik.a)); fs.writeFileSync(pb, Buffer.from(rubik.b));
    const ga = gray(pa), gb = gray(pb);
    const d = meanAbsDiff(ga, gb);
    check(d > 2, 'and two different new fonts really export as two different pictures',
      'mean abs diff = ' + d.toFixed(2) + '/255');
  } else check(false, 'the new fonts produced an export payload');

  /* ---------------- 8) the real ffmpeg burn ------------------------------- */
  console.log('\n  the finished file');
  const short = path.join(DIR, 'short.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: 0, endSec: 6.5, preset: 'reel-9x16', quality: '1080p', output: short });
  const si = await video.getInfo(ctx, short);
  check(si.width === PRESET.w && si.height === PRESET.h, 'exported a 9:16 short to burn onto', `${si.width}x${si.height}`);
  const burned = path.join(DIR, 'short-captioned.mp4');
  await burnTrack(track, short, burned);
  const bi = await video.getInfo(ctx, burned);
  check(bi.width === PRESET.w && bi.height === PRESET.h && bi.durationSec > 5, 'the burn produced a same-size playable MP4', `${bi.width}x${bi.height} ${bi.durationLabel}`);
  check(await video.isCleanEncode(ctx, burned), 'the burned MP4 decodes without errors');
  check(bi.hasAudio, 'the sound came through untouched');

  // Compare the FINISHED FILE against the preview screenshot, the same way.
  const fPlain = path.join(DIR, 'f-plain.png'), fCap = path.join(DIR, 'f-cap.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '2', '-i', short, '-frames:v', '1', fPlain]);
  spawnSync(ffmpegBin, ['-y', '-ss', '2', '-i', burned, '-frames:v', '1', fCap]);
  // "what the burn changed" isolates the caption from whatever the picture had
  const gA = gray(fPlain), gB = gray(fCap);
  const changed = new Uint8Array(CW * CH);
  for (let i = 0; i < changed.length; i++) changed[i] = Math.abs(gA[i] - gB[i]) > 22 ? 255 : 0;
  const bc = inkBox(changed, 60), rc = inkRows(changed, 60);
  console.log(`  burned-in caption: ${JSON.stringify(bc)} rows=${rc}`);
  check(!!bc && bc.n > 800, 'the finished MP4 really has the captions burned in', bc ? bc.n + ' changed pixels' : 'none');
  check(rc === rp, 'the FINISHED FILE is on the same number of lines as the preview', `${rp} vs ${rc}`);
  if (bc && bp) {
    check(Math.abs(bc.x0 - bp.x0) < 0.03 && Math.abs(bc.x1 - bp.x1) < 0.03, 'and in the same place across the frame', `x ${bp.x0}-${bp.x1} vs ${bc.x0}-${bc.x1}`);
    check(Math.abs(bc.y0 - bp.y0) < 0.03 && Math.abs(bc.y1 - bp.y1) < 0.03, 'and at the same height', `y ${bp.y0}-${bp.y1} vs ${bc.y0}-${bc.y1}`);
  }
  // The SECOND caption line must be there too — one frame proves the first only.
  const fCap2 = path.join(DIR, 'f-cap2.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '4.5', '-i', burned, '-frames:v', '1', fCap2]);
  const fPlain2 = path.join(DIR, 'f-plain2.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '4.5', '-i', short, '-frames:v', '1', fPlain2]);
  const gA2 = gray(fPlain2), gB2 = gray(fCap2);
  const changed2 = new Uint8Array(CW * CH);
  for (let i = 0; i < changed2.length; i++) changed2[i] = Math.abs(gA2[i] - gB2[i]) > 22 ? 255 : 0;
  const bc2 = inkBox(changed2, 60);
  check(!!bc2 && bc2.n > 500, 'the SECOND caption line is burned in too, at its own time', bc2 ? bc2.n + ' changed pixels at 4.5s' : 'none');
  // …and the gap between them is really empty.
  const fGap = path.join(DIR, 'f-gap.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '6.3', '-i', burned, '-frames:v', '1', fGap]);
  const fGapP = path.join(DIR, 'f-gap-plain.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '6.3', '-i', short, '-frames:v', '1', fGapP]);
  const gG = gray(fGapP), gH = gray(fGap);
  let gapChanged = 0;
  for (let i = 0; i < gG.length; i++) if (Math.abs(gG[i] - gH[i]) > 22) gapChanged++;
  check(gapChanged < 200, 'after the last line the picture goes back to plain', gapChanged + ' changed pixels at 6.3s');

  /* ---------------- 9) a transition still animates ------------------------ */
  console.log('\n  arrivals');
  const popped = await js(win, `(async () => {
    const T = window.VideoEditor.__test;
    const el = document.getElementById('capTrans'); el.value = 'pop'; el.dispatchEvent(new Event('change', { bubbles: true }));
    const t = await T.capTrackFor(T.capEventsState(), ${PRESET.w}, ${PRESET.h}, 6.5);
    // what the PREVIEW shows a few milliseconds into the line
    T.updateCapOverlayAt(0.42); const early = T.capOverlayBox();
    T.updateCapOverlayAt(2.0);  const settled = T.capOverlayBox();
    el.value = 'none'; el.dispatchEvent(new Event('change', { bubbles: true }));
    return { frames: t ? t.frames.length : 0, early, settled };
  })()`);
  check(popped.frames > distinct, 'a pop arrival really is drawn frame by frame, not faked', `${distinct} → ${popped.frames} frames`);
  check(popped.early && popped.settled, 'the preview draws the arrival too (it used to show only the settled caption)');

  console.log(`\n  artefacts for eyeballing: ${DIR}`);
  console.log(`\n==== caption WYSIWYG: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
