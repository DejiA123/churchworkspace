'use strict';
/*
 * PiP-in-short-export (range composite): proves video.exportOverlayComposite with
 * baseStart/baseEnd renders ONLY the short's range, shows the PiP at its
 * clip-relative time (and not after), and that the composite feeds cleanly into
 * the normal 9:16 short export. Usage: node test/pip-range.test.js ["<video>"]
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const input = sermonPath(process.argv[2]);
if (!input) { console.log(noSermon()); process.exit(0); }
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

/** Mean gray value buffer of a small region (top-right, where the PiP sits). */
function grayRegion(file, t) {
  return new Promise((resolve, reject) => {
    const args = ['-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', 'crop=iw*0.35:ih*0.32:iw*0.60:ih*0.03,scale=32:18,format=gray', '-f', 'rawvideo', '-'];
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    const chunks = []; proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', () => resolve(Buffer.concat(chunks)));
  });
}
function meanAbsDiff(a, b) {
  const n = Math.min(a.length, b.length); if (!n) return 999;
  let s = 0; for (let i = 0; i < n; i++) s += Math.abs(a[i] - b[i]);
  return s / n;
}

(async () => {
  const dir = path.join(os.tmpdir(), 'mw-pip-range');
  fs.mkdirSync(dir, { recursive: true });
  const composite = path.join(dir, 'composite.mp4');

  // short = source range [20s..32s]; PiP shows footage 100..105 at clip time 2..7
  await video.exportOverlayComposite(ctx, {
    base: input, baseStart: 20, baseEnd: 32,
    overlays: [{ src: input, srcStart: 100, srcEnd: 105, tlStart: 2, x: 0.62, y: 0.06, wFrac: 0.34 }],
    output: composite,
  });
  const srcInfo = await video.getInfo(ctx, input);
  const info = await video.getInfo(ctx, composite);
  check('composite covers ONLY the short range (~12s)', Math.abs(info.durationSec - 12) < 0.6, info.durationSec + 's');
  check('composite keeps the source resolution', info.width === srcInfo.width && info.height === srcInfo.height, `${info.width}x${info.height}`);

  // While the PiP is ACTIVE (t=4) the top-right corner differs from the plain source frame (20+4=24)…
  const durIn = meanAbsDiff(await grayRegion(composite, 4), await grayRegion(input, 24));
  // …and AFTER it ends (t=10 vs source 30) the same corner matches the source again.
  const durOut = meanAbsDiff(await grayRegion(composite, 10), await grayRegion(input, 30));
  check('PiP box is VISIBLE during its window', durIn > 8, 'diff ' + durIn.toFixed(1));
  check('PiP box is GONE after its window (corner matches the source)', durOut < 5, 'diff ' + durOut.toFixed(1));

  // The composite feeds the normal 9:16 short export
  const short = path.join(dir, 'short.mp4');
  await video.exportShort(ctx, { input: composite, startSec: 0, endSec: 12, preset: 'reel-9x16', output: short });
  const sInfo = await video.getInfo(ctx, short);
  check('9:16 short from the composite is 1080x1920', sInfo.width === 1080 && sInfo.height === 1920, `${sInfo.width}x${sInfo.height}`);
  check('short duration preserved', Math.abs(sInfo.durationSec - 12) < 0.7, sInfo.durationSec + 's');

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
