'use strict';
/*
 * "The text I add in the preview must be EXACTLY what comes out of the export."
 *
 * This proves it by pixels, not by trusting the code:
 *   1. loads a REAL clip through the real Browse -> loadVideo path,
 *   2. adds a real text overlay (multi-word, so line breaking matters) and
 *      styles it with the real toolbar,
 *   3. SCREENSHOTS the preview's export frame with the video hidden (black),
 *   4. asks the app for the REAL export payload — the transparent PNG that is
 *      actually burned in — and composites it on black,
 *   5. compares the two images (mean abs difference + ink IoU),
 *   6. runs the REAL ffmpeg burn and re-measures the text on a decoded frame of
 *      the finished MP4,
 *   7. runs a deliberately WRONG render (bigger font) through the same
 *      comparison as a control, so a passing score means something.
 *
 * Run: npx electron test/text-wysiwyg.test.js ["<clip>"]
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
const SRC = process.argv[2] || 'C:/Users/dejia/AppData/Local/Temp/mw-clip8.mp4';
const DIR = path.join(os.tmpdir(), 'mw-text-wysiwyg');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: DIR, userData: DIR, ffmpeg: '', ffprobe: '', fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('dialog:openFile', () => ok(SRC));
ipcMain.handle('video:info', wrap((e, { input }) => video.getInfo(ctx, input)));
ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => { const o = path.join(DIR, 'th-' + Date.now() + '.png'); await video.thumbnail(ctx, { input, timeSec, output: o }); return o; }));
ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => { const o = path.join(DIR, 'fs-' + Date.now() + '.png'); await video.filmstrip(ctx, { input, count: count || 16, output: o }); return o; }));
ipcMain.handle('video:waveform', wrap(async (e, { input }) => { const o = path.join(DIR, 'wf-' + Date.now() + '.png'); await video.waveform(ctx, { input, output: o }); return o; }));
ipcMain.handle('fs:readImageDataUrl', wrap((e, { path: p }) => 'data:image/png;base64,' + fs.readFileSync(p).toString('base64')));
// REAL font bytes — the export rasteriser needs them inlined as data: URIs
ipcMain.handle('fonts:data', wrap(async () => {
  const dir = captioner.fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
}));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
const js = (code) => win.webContents.executeJavaScript(code).catch((e) => ({ __error: String(e && e.message || e) }));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

/* --------------------------- image comparison ---------------------------- */
const CW = 216, CH = 384; // compare at a fixed small size (9:16)

/** Decode any image/video frame to a CW×CH grayscale buffer. */
function gray(file, extraFilters) {
  const vf = [`scale=${CW}:${CH}:flags=bilinear`, 'format=gray'];
  const r = spawnSync(ffmpegBin, ['-y', '-i', file, '-frames:v', '1', '-vf', (extraFilters ? extraFilters + ',' : '') + vf.join(','), '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  return b && b.length >= CW * CH ? b.slice(0, CW * CH) : null;
}
/** Transparent PNG -> the same grayscale, composited on black (what the video shows). */
function grayOnBlack(png) {
  const out = path.join(DIR, 'onblack-' + path.basename(png));
  spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', `color=black:s=${CW}x${CH}`, '-i', png,
    '-filter_complex', `[1:v]scale=${CW}:${CH}:flags=bilinear[o];[0:v][o]overlay=0:0`, '-frames:v', '1', out], { maxBuffer: 1 << 26 });
  return fs.existsSync(out) ? gray(out) : null;
}
const meanAbsDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
/** Ink = pixels clearly brighter than black; IoU of the two ink masks. */
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
/** Decode to CW×CH RGB. */
function rgb(file) {
  const r = spawnSync(ffmpegBin, ['-y', '-i', file, '-frames:v', '1', '-vf', `scale=${CW}:${CH}:flags=bilinear,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  return b && b.length >= CW * CH * 3 ? b : null;
}
/** Mask of the overlay's strong yellow (#ffe600) glyphs; `minus` removes pixels
 *  the underlying picture already had, so only burned-in text survives. */
function yellowMask(file, minus) {
  const b = rgb(file);
  const m = new Uint8Array(CW * CH);
  if (!b) return m;
  for (let i = 0, p = 0; i < CW * CH; i++, p += 3) {
    const R = b[p], G = b[p + 1], B = b[p + 2];
    const yellow = R > 165 && G > 130 && B < 100 && (R - B) > 80 && (G - B) > 60;
    m[i] = yellow && !(minus && minus[i]) ? 1 : 0;
  }
  return m;
}
function maskBox(m) {
  let x0 = CW, x1 = -1, y0 = CH, y1 = -1, n = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) if (m[y * CW + x]) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : { x0: x0 / CW, x1: (x1 + 1) / CW, y0: y0 / CH, y1: (y1 + 1) / CH, n };
}
function dilate(m, r = 2) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    if (!m[y * CW + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && nx < CW && ny >= 0 && ny < CH) o[ny * CW + nx] = 1;
    }
  }
  return o;
}
const containment = (a, b) => { let n = 0, i = 0; for (let k = 0; k < a.length; k++) if (a[k]) { n++; if (b[k]) i++; } return n ? i / n : 0; };
/** Where two frames differ — i.e. exactly what the burn put on the picture. */
function changedMask(a, b, thr = 22) {
  const A = rgb(a), B = rgb(b);
  const m = new Uint8Array(CW * CH);
  if (!A || !B) return m;
  for (let i = 0, p = 0; i < CW * CH; i++, p += 3) {
    const d = Math.max(Math.abs(A[p] - B[p]), Math.abs(A[p + 1] - B[p + 1]), Math.abs(A[p + 2] - B[p + 2]));
    m[i] = d > thr ? 1 : 0;
  }
  return m;
}
/** The transparent overlay's own footprint (alpha), at the comparison size. */
function alphaMask(png, thr = 24) {
  const out = path.join(DIR, 'alpha-' + path.basename(png));
  spawnSync(ffmpegBin, ['-y', '-i', png, '-vf', `alphaextract,scale=${CW}:${CH}:flags=bilinear,format=gray`, '-frames:v', '1', out], { maxBuffer: 1 << 26 });
  const g = fs.existsSync(out) ? gray(out) : null;
  const m = new Uint8Array(CW * CH);
  if (g) for (let i = 0; i < m.length; i++) m[i] = g[i] > thr ? 1 : 0;
  return m;
}
function centroid(m) {
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) if (m[y * CW + x]) { sx += x; sy += y; n++; }
  return n ? { x: sx / n / CW, y: sy / n / CH, n } : { x: 0, y: 0, n: 0 };
}
function maskIoU(a, b) {
  let i = 0, u = 0;
  for (let k = 0; k < a.length; k++) { if (a[k] && b[k]) i++; if (a[k] || b[k]) u++; }
  return u ? i / u : 0;
}
/** Bounding box of the ink, in fractions of the frame. */
function inkBox(buf, thr = 60) {
  let x0 = CW, x1 = -1, y0 = CH, y1 = -1, n = 0;
  for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
    if (buf[y * CW + x] > thr) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return { x0: x0 / CW, x1: (x1 + 1) / CW, y0: y0 / CH, y1: (y1 + 1) / CH, n };
}

app.whenReady().then(async () => {
  const info = await video.getInfo(ctx, SRC);
  console.log(`source: ${path.basename(SRC)} ${info.width}x${info.height} ${info.durationLabel}`);

  win = new BrowserWindow({ show: true, width: 1360, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  win.focus(); win.webContents.focus();

  // ---- load the real clip through the real path ----
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    // The fresh-install CROP fill. Suites share one profile, and a fill left on
    // Blur paints the blurred picture behind the frame — which the black-out
    // probe below does not hide, so the "text" it measured was the sermon.
    window.VideoEditor.__test.forgetExportPrefs();
    document.getElementById('veOpen2').click();
    return true;
  })()`);
  let loaded = false;
  for (let i = 0; i < 40 && !loaded; i++) { await sleep(400); loaded = await win.webContents.executeJavaScript(`!!(window.VideoEditor.__test.info && window.VideoEditor.__test.info())`).catch(() => false); }
  if (!loaded) { // fall back to the name check used by the other real-video tests
    loaded = await win.webContents.executeJavaScript(`(document.getElementById('veName').textContent||'').length > 3`);
  }
  check(loaded, 'real clip loaded through the Browse → loadVideo path');
  await sleep(600);

  // ---- add a text overlay and style it like a user would ----
  // Work with the BIG preview (the ⤢ button) — that is how an operator places
  // text before exporting, and it gives the comparison real pixels to judge.
  await win.webContents.executeJavaScript(`(() => { const b = document.getElementById('veBigger'); if (b && !b.classList.contains('on')) b.click(); return true; })()`);
  await sleep(700);
  await win.webContents.executeJavaScript(`(() => {
    const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 1;
    window.VideoEditor.__test.clearText();
    return true;
  })()`);
  await sleep(200);
  await win.webContents.executeJavaScript(`document.getElementById('veAddText').click()`);
  await sleep(350);
  // real typing would be slower; set the words + style through the same code paths the UI uses
  const styled = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    const c = document.querySelector('#veTextLayer .ve-text-content');
    if (c) { c.innerText = 'GRACE AND MERCY FOREVER'; c.blur(); }
    const id = T.textOverlays()[0].id;
    T.selectText && T.selectText(id);
    // toolbar: font + size + colour + bold + black backing
    const set = (sel, val, ev) => { const el = document.querySelector(sel); if (!el) return false; el.value = val; el.dispatchEvent(new Event(ev || 'change', { bubbles: true })); return true; };
    set('#vtFont', 'Anton');
    set('#vtSize', '34');
    set('#vtColor', '#ffe600');
    const bold = document.getElementById('vtBold'); if (bold && !bold.classList.contains('on')) bold.click();
    const bg = document.getElementById('vtBg'); if (bg && !bg.classList.contains('on')) bg.click();
    return { overlays: T.textOverlays().length, style: T.textStyleOf ? T.textStyleOf(id) : null, id };
  })()`);
  check(styled.overlays === 1, 'one text overlay on the preview', JSON.stringify(styled.style));

  // deselect so the pink drag border / handles are not part of the screenshot
  await win.webContents.executeJavaScript(`(() => { window.VideoEditor.__test.deselectText && window.VideoEditor.__test.deselectText(); return true; })()`);
  await sleep(250);

  // ---- 1) screenshot the preview's export frame with the picture blacked out ----
  await win.webContents.executeJavaScript(`(() => {
    const s = document.createElement('style'); s.id = 'wysiwygProbe';
    s.textContent = '#veDrop{background:#000 !important} #vePlayer{visibility:hidden !important}' +
      '#veCropFrame{border:0 !important} #veCropFrame::before,#veCropFrame::after{display:none !important}' +
      '#veCropMask{background:transparent !important} #veGapMask{display:none !important}' +
      '#veTextTools{display:none !important} .ve-text-box{border-color:transparent !important}' +
      '#veCropReset{display:none !important}';
    document.head.appendChild(s);
    return true;
  })()`);
  await sleep(400);
  const diag = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    const g = T.textExportGeom();
    const o = T.textOverlays()[0];
    return { geom: g, box: T.textBoxRect(o.id), overlay: o, dpr: window.devicePixelRatio };
  })()`);
  console.log('  preview geometry: ' + JSON.stringify(diag.geom));
  console.log('  preview text box: ' + JSON.stringify(diag.box) + '  dpr=' + diag.dpr);
  console.log('  overlay: ' + JSON.stringify(diag.overlay));

  const frameRect = await win.webContents.executeJavaScript(`(() => { const f = document.getElementById('veCropFrame'); const r = f.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }; })()`);
  const shot = await win.webContents.capturePage(frameRect);
  const previewPng = path.join(DIR, 'preview-frame.png');
  fs.writeFileSync(previewPng, shot.toPNG());
  check(frameRect.width > 100 && frameRect.height > 100, 'captured the preview export frame', `${frameRect.width}x${frameRect.height}`);

  // ---- 2) the REAL export payload (the PNG that gets burned in) ----
  const preset = video.PRESETS['reel-9x16'];
  const payload = await win.webContents.executeJavaScript(`window.VideoEditor.__test.textPngsForShort(0, 6, ${preset.w}, ${preset.h})`);
  check(!!payload && payload.length === 1, 'export payload is a rasterised PNG (not a subtitle re-implementation)', payload ? payload.length + ' image(s)' : 'null');
  const exportPng = path.join(DIR, 'export-overlay.png');
  fs.writeFileSync(exportPng, Buffer.from(payload[0].png));
  const pngInfo = spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height,pix_fmt', '-of', 'csv=p=0', exportPng]).stdout.toString().trim();
  check(pngInfo.startsWith(`${preset.w},${preset.h}`) && /rgba|argb/.test(pngInfo), 'the overlay PNG is export-sized and transparent', pngInfo);

  // ---- 3) compare preview vs export ----
  const gPrev = gray(previewPng);
  const gExp = grayOnBlack(exportPng);
  check(!!gPrev && !!gExp, 'both images decoded for comparison');
  const mad = meanAbsDiff(gPrev, gExp);
  const { iou, na, nb } = inkIoU(gPrev, gExp);
  const bp = inkBox(gPrev), be = inkBox(gExp);
  console.log(`  preview ink box: ${bp ? JSON.stringify(bp) : 'none'}`);
  console.log(`  export  ink box: ${be ? JSON.stringify(be) : 'none'}`);
  check(!!bp && !!be, 'text is visible in BOTH the preview and the export image', `${na} vs ${nb} lit pixels`);
  check(iou >= 0.75, 'preview and export text overlap (ink IoU ≥ 0.75)', 'IoU=' + iou.toFixed(3));
  check(mad <= 12, 'preview and export are pixel-close (mean abs diff ≤ 12/255)', 'MAD=' + mad.toFixed(2));
  if (bp && be) {
    check(Math.abs(bp.y0 - be.y0) < 0.02 && Math.abs(bp.y1 - be.y1) < 0.02, 'same vertical position/height', `y ${bp.y0.toFixed(3)}-${bp.y1.toFixed(3)} vs ${be.y0.toFixed(3)}-${be.y1.toFixed(3)}`);
    check(Math.abs(bp.x0 - be.x0) < 0.02 && Math.abs(bp.x1 - be.x1) < 0.02, 'same horizontal position/width (same line breaking)', `x ${bp.x0.toFixed(3)}-${bp.x1.toFixed(3)} vs ${be.x0.toFixed(3)}-${be.x1.toFixed(3)}`);
  }

  // ---- 4) CONTROL: a deliberately wrong render must score much worse ----
  const wrongPayload = await win.webContents.executeJavaScript(`(async () => {
    const T = window.VideoEditor.__test;
    const o = T.textOverlays()[0];
    const before = o.sizePct;
    T.setTextSizePct(o.id, before * 1.6);
    const r = await T.textPngsForShort(0, 6, ${preset.w}, ${preset.h});
    T.setTextSizePct(o.id, before);
    return r;
  })()`);
  const wrongPng = path.join(DIR, 'export-wrong.png');
  fs.writeFileSync(wrongPng, Buffer.from(wrongPayload[0].png));
  const gWrong = grayOnBlack(wrongPng);
  const madWrong = meanAbsDiff(gPrev, gWrong);
  const iouWrong = inkIoU(gPrev, gWrong).iou;
  check(madWrong > mad * 1.8 && iouWrong < iou - 0.15, 'the comparison CAN fail: a 1.6× font renders clearly different', `MAD ${mad.toFixed(2)}→${madWrong.toFixed(2)}, IoU ${iou.toFixed(3)}→${iouWrong.toFixed(3)}`);

  // ---- 5) the real ffmpeg burn: the finished MP4 must show the same text ----
  const short = path.join(DIR, 'short.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: 0, endSec: 6, preset: 'reel-9x16', output: short });
  const si = await video.getInfo(ctx, short);
  check(si.width === preset.w && si.height === preset.h, 'exported a 9:16 short to burn onto', `${si.width}x${si.height}`);
  const burned = path.join(DIR, 'short-text.mp4');
  await video.burnImageOverlays(ctx, { input: short, images: [{ path: exportPng, start: payload[0].start, end: payload[0].end }], output: burned });
  const bi = await video.getInfo(ctx, burned);
  check(bi.width === preset.w && bi.height === preset.h && bi.durationSec > 4, 'burn produced a same-size playable MP4', `${bi.width}x${bi.height} ${bi.durationLabel}`);
  const clean = await video.isCleanEncode(ctx, burned);
  check(clean, 'the burned MP4 decodes without errors');

  // Measure the SAME thing in all three pictures: the yellow glyphs. (Diffing
  // whole frames would also catch the backing box and the drop shadow, which is
  // not what "where is the text" means.)
  const frameA = path.join(DIR, 'f-plain.png'), frameB = path.join(DIR, 'f-text.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '3', '-i', short, '-frames:v', '1', frameA]);
  spawnSync(ffmpegBin, ['-y', '-ss', '3', '-i', burned, '-frames:v', '1', frameB]);
  // What the burn CHANGED in the picture, vs. what the overlay covers (its
  // alpha). Both include the backing box and the shadow, so this compares like
  // with like — and it does not depend on a colour test surviving H.264 through
  // a translucent box over whatever the video happens to be showing.
  const mBurn = changedMask(frameA, frameB);
  const mAlpha = alphaMask(exportPng);
  const bd = maskBox(mBurn), bx = maskBox(mAlpha), bv = maskBox(yellowMask(previewPng));
  console.log(`  overlay footprint — export  ${JSON.stringify(bx)}`);
  console.log(`  overlay footprint — burned  ${JSON.stringify(bd)}`);
  check(!!bd && bd.n > 400, 'the finished MP4 really has the text burned in', bd ? bd.n + ' changed pixels' : 'none');
  if (bd && bx) {
    const cb = centroid(mBurn), cx2 = centroid(mAlpha);
    check(Math.abs(cb.x - cx2.x) < 0.02 && Math.abs(cb.y - cx2.y) < 0.02,
      'the burned-in text sits exactly where the export placed it',
      `centre (${cb.x.toFixed(3)}, ${cb.y.toFixed(3)}) vs (${cx2.x.toFixed(3)}, ${cx2.y.toFixed(3)})`);
    const inside = containment(mBurn, dilate(mAlpha, 3));
    check(inside >= 0.95, 'every pixel the burn changed is inside the overlay it was given', (inside * 100).toFixed(1) + '% inside');
    const iou = maskIoU(mBurn, mAlpha);
    check(iou >= 0.6, 'and it covers the same area (IoU ≥ 0.6)', 'IoU=' + iou.toFixed(3));
  }

  /* ---- 5b) THE BLACK OUTLINE ----
   * "There should be an option to add a black outline around the text so it
   * stands out on the video." So: is it really there, in the file, ringing the
   * letters — and does turning it off really take it away? The yellow glyphs are
   * counted, and so are the DARK pixels immediately around them; an outline is
   * dark ink hugging bright ink, which is a thing you can measure. */
  console.log('\n  the black outline');
  // The black backing box is on from step 2; take it off for this, or the whole
  // background is dark and "is there a dark edge round the letters" means nothing.
  const outlineOn = await js(`(() => {
    const T = window.VideoEditor.__test;
    const id = T.textOverlays()[0].id;
    T.selectText(id);
    const bg = document.getElementById('vtBg'); if (bg && bg.classList.contains('on')) bg.click();
    return { style: T.textStyleOf(id), css: T.textOutlineCss() };
  })()`);
  check(outlineOn.style && outlineOn.style.outline === true,
    'new text is outlined out of the box (white words over a white shirt need it)',
    JSON.stringify(outlineOn.style && { outline: outlineOn.style.outline, colour: outlineOn.style.outlineColor }));
  if (outlineOn.css) {
    const strokePx = parseFloat(outlineOn.css.width), fontPx = parseFloat(outlineOn.css.fontSize);
    check(strokePx > 0 && /paint|stroke/.test(outlineOn.css.paintOrder || ''),
      'the PREVIEW paints a real stroke, drawn under the fill so it reads as an outward edge',
      `${outlineOn.css.width} ${outlineOn.css.color}, paint-order "${outlineOn.css.paintOrder}"`);
    // 2x the outward weight, because a CSS stroke is centred on the glyph edge
    check(Math.abs(strokePx / fontPx - 0.16) < 0.02, '…at the intended weight for the font size',
      `${strokePx.toFixed(1)}px on a ${fontPx.toFixed(0)}px font = ${(strokePx / fontPx).toFixed(3)} em`);
  } else check(false, 'the preview element was measurable');

  /** Bright yellow glyph pixels, and the dark pixels touching them. */
  const inkAndEdge = (file) => {
    const b = rgb(file);
    const glyph = new Uint8Array(CW * CH), dark = new Uint8Array(CW * CH);
    if (!b) return { glyph: 0, edge: 0 };
    for (let i = 0, p = 0; i < CW * CH; i++, p += 3) {
      const R = b[p], G = b[p + 1], B = b[p + 2];
      if (R > 165 && G > 130 && B < 100 && (R - B) > 80) glyph[i] = 1;
      else if (R < 70 && G < 70 && B < 70) dark[i] = 1;
    }
    // dark pixels within 1px of a glyph pixel = the edge around the letters
    let edge = 0, n = 0;
    for (let y = 1; y < CH - 1; y++) {
      for (let x = 1; x < CW - 1; x++) {
        const i = y * CW + x;
        if (glyph[i]) n++;
        if (!dark[i]) continue;
        if (glyph[i - 1] || glyph[i + 1] || glyph[i - CW] || glyph[i + CW]) edge++;
      }
    }
    return { glyph: n, edge };
  };

  // Re-rasterise WITH the outline (the payload from step 2 still had the box on)
  const onPayload = await js(`(async () => {
    const r = await window.VideoEditor.__test.textPngsForShort(0, 6, ${preset.w}, ${preset.h});
    return r && r[0] ? Array.from(r[0].png) : null;
  })()`);
  const withOutline = path.join(DIR, 'ol-on.png');
  fs.writeFileSync(withOutline, Buffer.from(onPayload));
  const offPayload = await js(`(async () => {
    const T = window.VideoEditor.__test;
    const before = T.clickTextOutline();            // the REAL toolbar button
    const r = await T.textPngsForShort(0, 6, ${preset.w}, ${preset.h});
    T.clickTextOutline();                            // put it back
    return { off: before, png: r && r[0] ? Array.from(r[0].png) : null };
  })()`);
  check(offPayload.off && offPayload.off.outline === false,
    'the toolbar button really turns it off', 'outline=' + (offPayload.off || {}).outline);
  const withoutOutline = path.join(DIR, 'ol-off.png');
  fs.writeFileSync(withoutOutline, Buffer.from(offPayload.png));
  const onBlackOn = path.join(DIR, 'ol-on-black.png'), onBlackOff = path.join(DIR, 'ol-off-black.png');
  for (const [src, dst] of [[withOutline, onBlackOn], [withoutOutline, onBlackOff]]) {
    spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', `color=white:s=${CW}x${CH}`, '-i', src,
      '-filter_complex', `[1:v]scale=${CW}:${CH}:flags=bilinear[o];[0:v][o]overlay=0:0`, '-frames:v', '1', dst], { maxBuffer: 1 << 26 });
  }
  // Composited on WHITE on purpose: that is the case the outline exists for, and
  // on white there is nothing dark in the picture except the outline itself.
  const on = inkAndEdge(onBlackOn), off = inkAndEdge(onBlackOff);
  console.log(`  outline on:  ${on.glyph} glyph px, ${on.edge} dark edge px`);
  console.log(`  outline off: ${off.glyph} glyph px, ${off.edge} dark edge px`);
  check(on.edge > 150, 'THE EXPORT really has a black edge around the letters', on.edge + ' dark pixels hugging the glyphs');
  check(on.edge > off.edge * 4, '…and it is the outline, not the drop shadow — turning it off takes it away',
    `${off.edge} → ${on.edge} dark edge pixels`);
  check(on.glyph > 200 && off.glyph > 200, 'the words themselves are there either way',
    `${off.glyph} vs ${on.glyph} glyph pixels`);

  // ---- 6) the WHOLE-VIDEO export must carry the same text ----
  // (Saving the full video with captions used to drop added text on the floor.)
  console.log('\n  whole-video export');
  const layouts = await win.webContents.executeJavaScript(`(() => {
    const T = window.VideoEditor.__test;
    const id = T.textOverlays()[0].id;
    return { frame: T.overlayLayout(id, 'frame', ${preset.w}, ${preset.h}),
             source: T.overlayLayout(id, 'source', ${info.width}, ${info.height}),
             geom: T.textExportGeom(), canvas: T.canvasTransform ? T.canvasTransform() : null };
  })()`);
  console.log('  layout(frame):  ' + JSON.stringify(layouts.frame));
  console.log('  layout(source): ' + JSON.stringify(layouts.source));
  const wholePayload = await win.webContents.executeJavaScript(
    `window.VideoEditor.__test.textPngsForShort(0, 6, ${info.width}, ${info.height}, 'source')`);
  check(!!wholePayload && wholePayload.length === 1, 'the whole-video export also gets the text', wholePayload ? wholePayload.length + ' image(s)' : 'null');
  const wholePng = path.join(DIR, 'export-whole.png');
  fs.writeFileSync(wholePng, Buffer.from(wholePayload[0].png));
  const wInfo = spawnSync(ffprobeBin, ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', wholePng]).stdout.toString().trim();
  check(wInfo === `${info.width},${info.height}`, 'sized to the SOURCE picture, not the short crop', wInfo);

  const trimmed = path.join(DIR, 'whole.mp4');
  await video.trim(ctx, { input: SRC, startSec: 0, endSec: 6, output: trimmed });
  const wholeOut = path.join(DIR, 'whole-text.mp4');
  await video.burnImageOverlays(ctx, { input: trimmed, images: [{ path: wholePng, start: 0, end: 6 }], output: wholeOut });
  const wf = path.join(DIR, 'w-text.png'), wp = path.join(DIR, 'w-plain.png');
  spawnSync(ffmpegBin, ['-y', '-ss', '3', '-i', trimmed, '-frames:v', '1', wp]);
  spawnSync(ffmpegBin, ['-y', '-ss', '3', '-i', wholeOut, '-frames:v', '1', wf]);
  const wBurn = yellowMask(wf, yellowMask(wp));
  check(maskBox(wBurn) && maskBox(wBurn).n > 200, 'the text is really burned into the whole-video export',
    maskBox(wBurn) ? maskBox(wBurn).n + ' yellow pixels' : 'none');
  // Placement is judged on the overlay itself (lossless) — the re-encoded frame
  // is only asked whether the text is there.
  const onBlack = path.join(DIR, 'whole-on-black.png');
  spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', `color=black:s=${info.width}x${info.height}`, '-i', wholePng,
    '-filter_complex', '[0:v][1:v]overlay=0:0', '-frames:v', '1', onBlack]);
  const wBox = maskBox(yellowMask(onBlack));
  console.log(`  yellow text box — whole video ${JSON.stringify(wBox)}`);
  // The preview had it centred on the canvas, and the canvas sits centred on the
  // source with default framing — so it must land centred on the full picture.
  const cx = wBox ? (wBox.x0 + wBox.x1) / 2 : 0;
  check(Math.abs(cx - 0.5) < 0.04, 'and it lands where the preview put it (centred on the picture)', 'centre x=' + cx.toFixed(3));
  check(!!wBox && wBox.x0 > 0.01 && wBox.x1 < 0.99, 'nothing is cut off at the edges of the wider frame', wBox ? `${wBox.x0.toFixed(3)}–${wBox.x1.toFixed(3)}` : '');

  console.log(`\n  artefacts for eyeballing: ${DIR}`);
  console.log(`\n==== text WYSIWYG: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
