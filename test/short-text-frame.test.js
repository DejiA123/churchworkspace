'use strict';
/*
 * REAL end-to-end: text overlays burned INTO a face-track-style reframed 9:16
 * short must land inside the output frame (not lost off-crop). Exports a moving
 * dynamic-crop short from a real sermon, burns two texts (one centred with the
 * black backing, one placed at the safe-area edge, exactly like the renderer's
 * frame-mapped payload), then pixel-verifies both render inside the 1080x1920
 * picture. Run: node test/short-text-frame.test.js "<video>"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const cap = require('../src/main/captioner');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const input = sermonPath(process.argv[2]);
if (!input) { console.log(noSermon()); process.exit(0); }
const DIR = path.join(os.tmpdir(), 'mw-short-text-test');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

// mean |a-b| between two same-time gray frames over a rect (fractions of the frame)
function rectDiff(fileA, fileB, t, x0, x1, y0, y1) {
  const W = 540, H = 960;
  const grab = (f) => spawnSync(ffmpeg, ['-ss', String(t), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-'], { maxBuffer: 1 << 24 }).stdout;
  const a = grab(fileA), b = grab(fileB);
  if (!a || !b || a.length < W * H || b.length < W * H) return -1;
  let sum = 0, n = 0;
  for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y++) {
    for (let x = Math.floor(x0 * W); x < Math.max(Math.floor(x0 * W) + 1, Math.floor(x1 * W)); x++) { sum += Math.abs(a[y * W + x] - b[y * W + x]); n++; }
  }
  return sum / n;
}
const bandDiff = (a, b, t, y0, y1) => rectDiff(a, b, t, 0, 1, y0, y1);

(async () => {
  const info = await video.getInfo(ctx, input);
  console.log(`source: ${info.width}x${info.height} ${info.durationLabel || ''}`);

  // 1) a MOVING dynamic-crop 9:16 short (like a face-tracked export panning across)
  const start = 120, end = 140;
  const cx = info.width / 2;
  const keyframes = [
    { t: 0, x: cx - 120, y: info.height / 2 }, { t: 8, x: cx + 120, y: info.height / 2 },
    { t: 14, x: cx - 60, y: info.height / 2 }, { t: 20, x: cx + 60, y: info.height / 2 },
  ];
  const short = path.join(DIR, 'short.mp4');
  await video.exportShortReframed(ctx, { input, startSec: start, endSec: end, preset: 'reel-9x16', keyframes, output: short });
  const si = await video.getInfo(ctx, short);
  check('reframed 9:16 short exported', si.width === 1080 && si.height === 1920, `${si.width}x${si.height}`);

  // 2) burn text the way the renderer's frame-mapped payload does (fractions of the SHORT)
  const overlays = [
    { text: 'JESUS IS LORD', x: 0.5, y: 0.12, start: 1, end: 19, sizePct: 0.045, bold: true, color: '#ffffff', bg: true, font: 'Arial' },
    { text: 'SUNDAY 10AM', x: 0.02, y: 0.88, start: 1, end: 19, sizePct: 0.035, bold: true, color: '#ffe600', font: 'Arial' }, // deliberately PAST the edge — must not clip
  ];
  const ass = path.join(DIR, 'ovl.ass');
  cap.writeOverlayAss(overlays, { width: si.width, height: si.height, output: ass });
  const texted = path.join(DIR, 'short-text.mp4');
  await cap.burnCaptions(ctx, { input: short, assPath: ass, output: texted });
  const ti = await video.getInfo(ctx, texted);
  check('text burned onto the short (still 1080x1920)', ti.width === 1080 && ti.height === 1920, `${ti.width}x${ti.height}`);
  check('duration preserved', Math.abs(ti.durationSec - si.durationSec) < 0.5, `${ti.durationSec}s vs ${si.durationSec}s`);

  // 3) pixel-verify: the text bands CHANGED, an untouched band did not
  const top = bandDiff(short, texted, 10, 0.06, 0.18);   // "JESUS IS LORD" band
  const bottom = bandDiff(short, texted, 10, 0.82, 0.94); // "SUNDAY 10AM" band
  const middle = bandDiff(short, texted, 10, 0.40, 0.55); // no text here
  check('top text visibly rendered INSIDE the 9:16 frame', top > 2, `band diff ${top.toFixed(2)}`);
  check('edge-placed text visibly rendered INSIDE the frame too', bottom > 1, `band diff ${bottom.toFixed(2)}`);
  check('untouched picture area is unchanged (text only where placed)', middle >= 0 && middle < 1.5, `band diff ${middle.toFixed(2)}`);
  // the anti-clipping guarantee: nothing renders in the extreme left sliver, i.e.
  // the whole text was nudged INTO the frame instead of hanging off the edge
  const sliver = rectDiff(short, texted, 10, 0, 0.008, 0.80, 0.96);
  check('edge text is NOT clipped at the frame border (left sliver untouched)', sliver >= 0 && sliver < 1.5, `sliver diff ${sliver.toFixed(2)}`);

  // 4) drop an eyeball frame
  const eye = path.join(DIR, 'eyeball.jpg');
  spawnSync(ffmpeg, ['-ss', '10', '-i', texted, '-frames:v', '1', '-q:v', '3', '-y', eye]);
  console.log('  eyeball frame: ' + eye);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
