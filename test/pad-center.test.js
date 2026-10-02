'use strict';
/*
 * BLUR-PAD REFRAME: a subject standing AT THE EDGE of the recording must still be
 * CENTRED in the 9:16 short. A plain crop physically cannot do this (the crop
 * window pins at the source boundary) — the blur-padded canvas can. Deterministic:
 * synthesizes a video with a bright bar at x=8% of the width, tracks it, exports,
 * and measures where the bar lands in the output. Run: node test/pad-center.test.js
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

/** 54x96 gray frame of `file` at t → column means (54 values). */
function colMeans(file, t) {
  return new Promise((resolve, reject) => {
    const args = ['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=54:96,format=gray', '-f', 'rawvideo', '-'];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = []; proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const W = 54, H = 96, cols = new Array(W).fill(0);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) cols[x] += buf[y * W + x] || 0;
      resolve(cols.map((v) => v / H));
    });
  });
}

(async () => {
  const dir = path.join(os.tmpdir(), 'mw-pad-center');
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'edge-subject.mp4');

  // 1280x720, 10s: dark scene with a bright bar whose CENTre is at x=102px (8% -> hard left)
  await ff.runFfmpeg(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=0x283848:s=1280x720:d=10:r=30',
    '-vf', 'drawbox=x=87:y=180:w=30:h=360:color=white:t=fill', '-c:v', 'libx264', '-preset', 'veryfast', '-y', src], {});

  // the "face" sits at x=102 the whole time — the crop wants x = 102-202 = -100 (outside the source!)
  const keyframes = []; for (let t = 0; t <= 10; t += 0.5) keyframes.push({ t, x: 102 });
  const out = path.join(dir, 'short.mp4');
  await video.exportShortReframed(ctx, { input: src, startSec: 0, endSec: 10, preset: 'reel-9x16', keyframes, output: out });

  const info = await video.getInfo(ctx, out);
  check('padded reframe exports 1080x1920', info.width === 1080 && info.height === 1920, `${info.width}x${info.height}`);

  const cols = await colMeans(out, 5);
  // find the bright bar: centre of the columns above 80% of the peak
  const peak = Math.max(...cols);
  const hot = cols.map((v, i) => (v > peak * 0.8 ? i : -1)).filter((i) => i >= 0);
  const barCx = hot.reduce((a, b) => a + b, 0) / Math.max(1, hot.length) / 53; // 0..1
  // a plain clamped crop would land the bar at (102-0)/404 ≈ 0.25 — far off centre
  check('edge subject is CENTRED in the output (|cx-0.5| < 0.08)', Math.abs(barCx - 0.5) < 0.08, `cx=${barCx.toFixed(3)} (clamped crop would be ~0.25)`);
  check('bar is clearly visible (bright peak found)', peak > 120, `peak ${Math.round(peak)}`);
  // the void left of the source edge is BLUR-FILLED, not black
  const leftFill = (cols[0] + cols[1] + cols[2] + cols[3]) / 4;
  check('the off-frame region is blur-filled (not black bars)', leftFill > 15, `left cols mean ${leftFill.toFixed(1)}`);

  // CONTROL: keyframes that never overshoot still take the plain (clamped) path and centre fine
  const out2 = path.join(dir, 'short-center.mp4');
  const kf2 = []; for (let t = 0; t <= 10; t += 0.5) kf2.push({ t, x: 640 });
  await video.exportShortReframed(ctx, { input: src, startSec: 0, endSec: 10, preset: 'reel-9x16', keyframes: kf2, output: out2 });
  const i2 = await video.getInfo(ctx, out2);
  check('non-edge keyframes still use the plain path (1080x1920)', i2.width === 1080 && i2.height === 1920, `${i2.width}x${i2.height}`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
