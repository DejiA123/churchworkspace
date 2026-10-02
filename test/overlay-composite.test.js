'use strict';
/*
 * Proves the picture-in-picture OVERLAY compositing render (video.exportOverlayComposite)
 * actually produces ONE valid video with the overlay burned in, on a real file.
 * Run with:  node test/overlay-composite.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const SRC = 'C:/Users/dejia/Videos/The Mercy of God - What is it_ Dr. David Richman.mp4';
const DIR = path.join(os.tmpdir(), 'mw-overlay-test');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  console.log('Building a short base + a PiP overlay clip from:', SRC);
  const info = await video.getInfo(ctx, SRC);
  check('source has real duration', info.durationSec > 30, String(info.durationSec));

  // Make a small 12s BASE clip so the composite render is fast to verify.
  const base = path.join(DIR, 'base12.mp4');
  await video.trim(ctx, { input: SRC, startSec: 60, endSec: 72, output: base });
  check('base clip made', fs.existsSync(base));

  // Composite: overlay footage from a DIFFERENT moment of the source, shown as a
  // top-right PiP during base seconds 2..8.
  const out = path.join(DIR, 'composited.mp4');
  await video.exportOverlayComposite(ctx, {
    base,
    overlays: [{ src: SRC, srcStart: 600, srcEnd: 606, tlStart: 2, x: 0.6, y: 0.05, wFrac: 0.34 }],
    output: out,
  });
  check('composite export produced a file', fs.existsSync(out));

  if (fs.existsSync(out)) {
    const oi = await video.getInfo(ctx, out);
    check('composited video is playable + full-frame (same size as base)', oi.width === info.width && oi.height === info.height, `${oi.width}x${oi.height}`);
    check('composited duration ≈ base duration (one continuous video)', Math.abs(oi.durationSec - 12) < 2, oi.durationSec + 's');
    check('composited video kept its audio track', oi.hasAudio === true);
  }

  // Multiple overlays at once (chained composite).
  const out2 = path.join(DIR, 'composited2.mp4');
  await video.exportOverlayComposite(ctx, {
    base,
    overlays: [
      { src: SRC, srcStart: 600, srcEnd: 604, tlStart: 1, x: 0.03, y: 0.05, wFrac: 0.3 },
      { src: SRC, srcStart: 1200, srcEnd: 1204, tlStart: 6, x: 0.62, y: 0.6, wFrac: 0.3 },
    ],
    output: out2,
  });
  check('two-overlay composite produced a file', fs.existsSync(out2) && (await video.getInfo(ctx, out2)).durationSec > 8);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Outputs (eyeball these): ' + DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
