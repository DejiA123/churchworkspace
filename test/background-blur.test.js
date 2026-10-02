'use strict';
/*
 * BACKGROUND BLUR (frame fill) — measured, not asserted by eye.
 *
 * The ask: "if a user uploads a picture on the Video Studio page, and the
 * picture is 16:9 and the video is 9:16, the background blur will blur the top
 * part and bottom part … the blur should be FROM THE ACTUAL IMAGE so it blends
 * well, the main picture is well visible, and there is background blur."
 *
 * Every clause of that is a number here. A 16:9 source is built with a red left
 * half, a blue right half and a white marker pinned to each far edge, then
 * exported 9:16 three ways. The finished pixels are decoded back and measured:
 *
 *   nothing is lost      both edge markers survive inside the fitted picture
 *                        (a crop physically cannot keep them — the control case
 *                        below proves it throws them away)
 *   it is not bars       the top/bottom bands are far from black
 *   it is THIS picture   the top band is red on the left and blue on the right,
 *                        matching the source it came from
 *   it IS blurred        the red→blue edge is a cliff in the fitted picture and
 *                        a ramp in the background — measured as the width of the
 *                        transition, in pixels
 *   the picture is clear the fitted strip keeps its own sharp edge
 *
 *   node test/background-blur.test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const ff = require('../src/main/ffmpeg');

const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const W = 1080, H = 1920;                 // the 9:16 export
const SRC_W = 1280, SRC_H = 720;          // the 16:9 source
const FIT_H = Math.round(W * SRC_H / SRC_W); // how tall the fitted picture is: 608px

/** One frame of `file` at `t`, as {w,h,px:Uint8Array} RGB24 at the given width. */
function frame(file, t, w, h) {
  return new Promise((resolve, reject) => {
    const args = ['-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `scale=${w}:${h}:flags=neighbor`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = []; proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      if (buf.length < w * h * 3) return reject(new Error(`short frame: ${buf.length} bytes`));
      resolve({ w, h, px: buf });
    });
  });
}
const at = (f, x, y) => { const i = (y * f.w + x) * 3; return { r: f.px[i], g: f.px[i + 1], b: f.px[i + 2] }; };
/** Mean colour of a rectangle. */
function meanRect(f, x0, y0, x1, y1) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const c = at(f, x, y); r += c.r; g += c.g; b += c.b; n++; }
  return { r: r / n, g: g / n, b: b / n, luma: (0.299 * r + 0.587 * g + 0.114 * b) / n };
}
/**
 * How many pixels the red→blue transition takes on row `y`, i.e. how blurred it
 * is. A hard edge switches over in a pixel or two; a blurred one ramps.
 */
function edgeWidth(f, y) {
  const d = [];
  for (let x = 0; x < f.w; x++) { const c = at(f, x, y); d.push(c.r - c.b); }
  const lo = Math.min(...d), hi = Math.max(...d);
  if (hi - lo < 30) return f.w; // no discernible edge at all
  const a = lo + (hi - lo) * 0.15, b = lo + (hi - lo) * 0.85;
  // walk from the left: last x still "red-ish" (above b) to first x fully "blue-ish" (below a)
  let last = -1, first = -1;
  for (let x = 0; x < f.w; x++) { if (d[x] > b) last = x; }
  for (let x = f.w - 1; x >= 0; x--) { if (d[x] < a) first = x; }
  return Math.max(1, first - last);
}

(async () => {
  const dir = path.join(os.tmpdir(), 'mw-bgblur-test');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'wide.mp4');

  /* ---- a 16:9 source with a hard red|blue seam and a marker at each far edge ---- */
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `color=c=red:s=${SRC_W}x${SRC_H}:d=4:r=15`,
    '-vf', [
      `drawbox=x=${SRC_W / 2}:y=0:w=${SRC_W / 2}:h=${SRC_H}:color=blue:t=fill`,
      'drawbox=x=0:y=300:w=24:h=120:color=white:t=fill',            // far LEFT marker
      `drawbox=x=${SRC_W - 24}:y=300:w=24:h=120:color=white:t=fill`, // far RIGHT marker
    ].join(','),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', '-y', src], {});

  const info = await video.getInfo(ctx, src);
  check('source is 16:9', info.width === SRC_W && info.height === SRC_H, `${info.width}x${info.height}`);

  /* ================= 1. blur fill ================= */
  const outBlur = path.join(dir, 'blur.mp4');
  await video.exportShort(ctx, { input: src, startSec: 0, endSec: 4, preset: 'reel-9x16',
    fill: { mode: 'blur', strength: 0.6, dim: 0.18 }, output: outBlur });
  const iB = await video.getInfo(ctx, outBlur);
  check('blur fill exports 1080x1920', iB.width === W && iB.height === H, `${iB.width}x${iB.height}`);

  const fB = await frame(outBlur, 2, W, H);
  const fitTop = Math.round((H - FIT_H) / 2), fitBot = fitTop + FIT_H;

  // …nothing is cropped: both far-edge markers are inside the fitted picture
  const midY = fitTop + Math.round(FIT_H * (360 / SRC_H));
  const leftMark = meanRect(fB, 2, midY - 20, 22, midY + 20);
  const rightMark = meanRect(fB, W - 22, midY - 20, W - 2, midY + 20);
  check('the WHOLE picture is kept — far-left edge marker survives', leftMark.luma > 170, `luma ${leftMark.luma.toFixed(0)}`);
  check('the WHOLE picture is kept — far-right edge marker survives', rightMark.luma > 170, `luma ${rightMark.luma.toFixed(0)}`);

  // …the top/bottom bands are filled, not black
  const top = meanRect(fB, 0, 20, W, fitTop - 20);
  const bot = meanRect(fB, 0, fitBot + 20, W, H - 20);
  check('the top band is FILLED, not black bars', top.luma > 40, `luma ${top.luma.toFixed(0)}`);
  check('the bottom band is FILLED, not black bars', bot.luma > 40, `luma ${bot.luma.toFixed(0)}`);

  // …and it is THIS picture's colours: red on the left, blue on the right
  const topL = meanRect(fB, 40, 30, W / 2 - 120, fitTop - 30);
  const topR = meanRect(fB, W / 2 + 120, 30, W - 40, fitTop - 30);
  check('the background is made FROM THE IMAGE (left of the band is red)', topL.r > topL.b + 40, `r${topL.r.toFixed(0)} b${topL.b.toFixed(0)}`);
  check('the background is made FROM THE IMAGE (right of the band is blue)', topR.b > topR.r + 40, `r${topR.r.toFixed(0)} b${topR.b.toFixed(0)}`);

  // …it is dimmer than the real picture, so the subject reads as the subject
  const fitMean = meanRect(fB, 40, fitTop + 40, W - 40, fitBot - 40);
  check('the background is darker than the picture it frames', top.luma < fitMean.luma, `bg ${top.luma.toFixed(0)} vs picture ${fitMean.luma.toFixed(0)}`);

  // …the background is BLURRED and the picture is NOT
  const bgEdge = edgeWidth(fB, Math.round(fitTop / 2));
  const picEdge = edgeWidth(fB, fitTop + Math.round(FIT_H / 2));
  check('the background IS blurred (soft red→blue transition)', bgEdge >= 24, `${bgEdge}px transition`);
  check('the main picture stays SHARP (hard red→blue transition)', picEdge <= 8, `${picEdge}px transition`);
  check('background is at least 4x softer than the picture', bgEdge >= picEdge * 4, `${bgEdge}px vs ${picEdge}px`);

  /* ---- blur STRENGTH actually changes the blur ---- */
  const outSoft = path.join(dir, 'blur-light.mp4');
  await video.exportShort(ctx, { input: src, startSec: 0, endSec: 4, preset: 'reel-9x16',
    fill: { mode: 'blur', strength: 0.05, dim: 0 }, output: outSoft });
  const fS = await frame(outSoft, 2, W, H);
  const softEdge = edgeWidth(fS, Math.round(fitTop / 2));
  check('a LIGHT blur strength is measurably less blurred than a heavy one', softEdge < bgEdge, `light ${softEdge}px vs 60% ${bgEdge}px`);
  const softTop = meanRect(fS, 0, 20, W, fitTop - 20);
  check('darken=0 leaves the background brighter than darken=18%', softTop.luma > top.luma, `${softTop.luma.toFixed(0)} vs ${top.luma.toFixed(0)}`);

  /* ---- a DARK picture must still get a VISIBLE background ----
   * The first version of this dimmed with ffmpeg's eq=brightness, which is an
   * ADDITIVE offset: on a dark sermon frame it subtracted more luma than the
   * frame had and produced pure black — a "blurred background" indistinguishable
   * from the black bars it was meant to replace. So: dim a dark source and check
   * the result is proportional, not crushed. */
  const darkSrc = path.join(dir, 'dark.mp4');
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `color=c=0x201828:s=${SRC_W}x${SRC_H}:d=3:r=15`,
    '-vf', `drawbox=x=${SRC_W / 2}:y=0:w=${SRC_W / 2}:h=${SRC_H}:color=0x281820:t=fill`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', '-y', darkSrc], {});
  const outDark = path.join(dir, 'dark-blur.mp4');
  await video.exportShort(ctx, { input: darkSrc, startSec: 0, endSec: 3, preset: 'reel-9x16',
    fill: { mode: 'blur', strength: 0.6, dim: 0.18 }, output: outDark });
  const fD = await frame(outDark, 1.5, W, H);
  const dTop = meanRect(fD, 0, 20, W, fitTop - 20);
  const dPic = meanRect(fD, 40, fitTop + 40, W - 40, fitBot - 40);
  check('a DARK picture still gets a visible background, not crushed to black',
    dTop.luma > dPic.luma * 0.65, `background ${dTop.luma.toFixed(1)} vs picture ${dPic.luma.toFixed(1)}`);
  check('…and it is dimmed proportionally, roughly the 18% asked for',
    dTop.luma < dPic.luma * 0.95, `${(100 * dTop.luma / dPic.luma).toFixed(0)}% of the picture's brightness`);
  check('the dim is a multiply, not a subtraction', video.fillChain(1280, 720, 1080, 1920, { mode: 'blur', dim: 0.2 }).includes('lutyuv'));

  /* ================= 2. black bars ================= */
  const outBars = path.join(dir, 'bars.mp4');
  await video.exportShort(ctx, { input: src, startSec: 0, endSec: 4, preset: 'reel-9x16', fill: 'bars', output: outBars });
  const fBar = await frame(outBars, 2, W, H);
  const barTop = meanRect(fBar, 0, 20, W, fitTop - 20);
  check('bars mode really is black above the picture', barTop.luma < 12, `luma ${barTop.luma.toFixed(1)}`);
  const barMark = meanRect(fBar, 2, midY - 20, 22, midY + 20);
  check('bars mode also keeps the whole picture', barMark.luma > 170, `luma ${barMark.luma.toFixed(0)}`);

  /* ================= 3. CONTROL: crop (the old default) ================= */
  const outCrop = path.join(dir, 'crop.mp4');
  await video.exportShort(ctx, { input: src, startSec: 0, endSec: 4, preset: 'reel-9x16', output: outCrop });
  const fC = await frame(outCrop, 2, W, H);
  const cropL = meanRect(fC, 2, H / 2 - 20, 22, H / 2 + 20);
  check('CONTROL: cropping throws the far edges away (that is the problem being solved)',
    cropL.luma < 170, `luma ${cropL.luma.toFixed(0)}`);
  const iC = await video.getInfo(ctx, outCrop);
  check('CONTROL: crop still exports 1080x1920 exactly as before', iC.width === W && iC.height === H, `${iC.width}x${iC.height}`);

  /* ================= 4. the graph itself (pure) ================= */
  const same = video.fillChain(1080, 1920, 1080, 1920, { mode: 'blur' });
  check('a source already at the target ratio costs nothing (no blur branch)',
    !same.includes('boxblur') && !same.includes('split'), same.slice(0, 40) + '…');
  /*
   * ►► THIS USED TO PIN THE CHAIN STRING, AND THAT WAS THE WRONG THING TO PIN. ◄◄
   *
   * The chain was `scale(increase),crop` — which, taking a 9:16 short out of a
   * 16:9 recording, scales 1280x720 UP TO 3413x1920 with lanczos and then throws
   * 68% of those pixels away. Measured on a real sermon: 21.3 s of a 30-second
   * export. It now takes the crop out of the SOURCE first and scales only that
   * (12.3 s), which is what exportShortReframed has always done.
   *
   * So what is checked is what actually matters: the RIGHT REGION, centred, in
   * the target's shape, inside the picture. test/export-speed.test.js measures
   * that it is no softer.
   */
  const cropChain = video.fillChain(1280, 720, 1080, 1920, 'crop');
  const cm = cropChain.match(/^crop=(\d+):(\d+):(\d+):(\d+),scale=1080:1920/);
  check('crop mode takes the crop out of the source before scaling it', !!cm, cropChain);
  if (cm) {
    const [, cw, ch, cx, cy] = cm.map(Number);
    check('…keeping the full height of a too-wide source', ch === 720, `${cw}x${ch}`);
    check("…in the target shape, to within a rounding", Math.abs(cw / ch - 1080 / 1920) < 0.005,
      (cw / ch).toFixed(4) + ' vs ' + (1080 / 1920).toFixed(4));
    check('…centred', Math.abs((1280 - cw) / 2 - cx) <= 1 && cy === 0, `x=${cx} y=${cy}`);
    check('…and inside the picture', cx + cw <= 1280 && cy + ch <= 720);
  }
  check('a source ALREADY at the target shape is not cropped at all',
    video.fillChain(1080, 1920, 1080, 1920, 'crop').indexOf('crop=') !== 0,
    video.fillChain(1080, 1920, 1080, 1920, 'crop').slice(0, 46) + '…');
  const a = video.fillChain(1280, 720, 1080, 1920, 'blur', 'a');
  const b = video.fillChain(1280, 720, 1080, 1920, 'blur', 'b');
  check('two fills in one graph get distinct labels (no collision)',
    a.includes('[abg]') && b.includes('[bbg]') && !a.includes('[bbg]'), 'labels a/b');
  check('an unknown mode falls back to crop rather than breaking the export',
    video.fillChain(1280, 720, 1080, 1920, { mode: 'nonsense' }) === cropChain);

  /* ============ 4b. blur fill on top of a gap-closing JOIN ============
   * The hairiest graph the app can build: the pauses are cut out and the pieces
   * concatenated INSIDE the same pass that does the blur fill and the noise
   * removal. Three multi-branch filtergraphs stitched into one -filter_complex,
   * with the audio mapped by hand because filter_complex turns off automatic
   * stream selection. If any of that is wrong, ffmpeg fails outright. */
  const joinSrc = path.join(dir, 'wide-audio.mp4');
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `color=c=red:s=${SRC_W}x${SRC_H}:d=12:r=15`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-vf', `drawbox=x=${SRC_W / 2}:y=0:w=${SRC_W / 2}:h=${SRC_H}:color=blue:t=fill`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', '-y', joinSrc], {});
  const outJoin = path.join(dir, 'join-blur.mp4');
  await video.exportShort(ctx, {
    input: joinSrc, startSec: 0, endSec: 12, preset: 'reel-9x16',
    pieces: [{ start: 0, end: 3 }, { start: 6, end: 9 }],   // a pause cut out of the middle
    fill: { mode: 'blur', strength: 0.6, dim: 0.18 }, denoise: 'medium',
    output: outJoin,
  });
  const iJ = await video.getInfo(ctx, outJoin);
  check('blur fill + closed gaps + noise removal render in ONE pass',
    iJ.width === W && iJ.height === H && Math.abs(iJ.durationSec - 6) < 0.4, `${iJ.width}x${iJ.height}, ${iJ.durationSec.toFixed(2)}s of 6s`);
  check('…and the joined export still has its audio', iJ.hasAudio, String(iJ.hasAudio));
  const fJ = await frame(outJoin, 3, W, H);
  const jTop = meanRect(fJ, 0, 20, W, fitTop - 20);
  check('…with the blurred background intact', jTop.luma > 30, `luma ${jTop.luma.toFixed(0)}`);

  /* ================= 5. a still PICTURE, appended ================= */
  // the literal case in the request: a 16:9 photo added to a 9:16 short
  const photo = path.join(dir, 'photo.jpg');
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', `color=c=red:s=${SRC_W}x${SRC_H}`,
    '-vf', `drawbox=x=${SRC_W / 2}:y=0:w=${SRC_W / 2}:h=${SRC_H}:color=blue:t=fill`,
    '-frames:v', '1', '-y', photo], {});
  check('a photo is recognised as a still, not a video', video.isStillImage(photo) && !video.isStillImage(src));
  const withPhoto = path.join(dir, 'short-plus-photo.mp4');
  await video.appendClips(ctx, { input: outBlur, output: withPhoto,
    clips: [{ path: photo, durationSec: 3 }], fill: { mode: 'blur', strength: 0.6, dim: 0.18 } });
  const iP = await video.getInfo(ctx, withPhoto);
  check('the photo really was appended (video got ~3s longer)', iP.durationSec > iB.durationSec + 2.4, `${iB.durationSec.toFixed(1)}s -> ${iP.durationSec.toFixed(1)}s`);
  const fP = await frame(withPhoto, iB.durationSec + 1.5, W, H);
  const pTop = meanRect(fP, 0, 20, W, fitTop - 20);
  const pTopL = meanRect(fP, 40, 30, W / 2 - 120, fitTop - 30);
  check('the 16:9 PHOTO gets a blurred background too, not black bars', pTop.luma > 40, `luma ${pTop.luma.toFixed(0)}`);
  check("the photo's background is the photo's own colour (red on the left)", pTopL.r > pTopL.b + 40, `r${pTopL.r.toFixed(0)} b${pTopL.b.toFixed(0)}`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
