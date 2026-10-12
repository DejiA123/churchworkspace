'use strict';
/*
 * THE TRACKER'S CLOCK IS THE EXPORT'S CLOCK.
 *
 * Auto-reframe times its crop on the frames extractFrames samples and the cuts
 * detectSceneCuts finds. With pauses closed, the export joins the kept pieces
 * WITH their sound; the tracking passes used to join them without it, which
 * packs the pictures differently — up to a frame off at every closed pause. On
 * a real sermon short that was the camera snapping a frame early at a join: the
 * old picture for one frame with the new picture's framing, the preacher
 * thrown against the edge of the short.
 *
 * Here the source changes colour every second, so every join is a hard cut,
 * and the pieces have the ragged lengths real pauses leave. A following short
 * is exported whose camera snaps, as the tracker's does, at each cut the
 * tracker was told about — left for one colour, right for the next. The green
 * channel is a left-to-right ramp, so every output frame says both which
 * piece it shows (red) and where the crop was (green): on EVERY frame the two
 * must agree.
 *
 *   node test/track-clock.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-track-clock-'));
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  const src = path.join(DIR, 'src.mp4');
  // red: which second (alternating), green: a ramp across the width = crop position
  spawnSync(ffmpeg, ['-f', 'lavfi', '-i', 'nullsrc=s=1280x720:r=30000/1001:d=12,format=rgb24,geq=r=200*mod(floor(T)\\,2)+30:g=X*255/W:b=128',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', '-c:a', 'aac', '-shortest', '-y', src]);
  check('test source made', fs.existsSync(src));

  // one piece inside each second, each a little over a whole number of frames
  // — the ragged length a closed pause leaves, and the worst case: packed
  // without its sound, every join loses most of a frame and the loss adds up.
  const pieces = [];
  for (let k = 0; k < 10; k++) { const a = k + 0.2 + 0.013 * k; pieces.push({ start: +a.toFixed(3), end: +(a + 15 / 29.97 + 0.027).toFixed(3) }); }

  const frames = await video.extractFrames(ctx, { input: src, startSec: pieces[0].start, endSec: pieces[9].end, fps: 6, pieces, outDir: path.join(DIR, 'f') });
  const told = frames.cuts.filter((c) => c.score >= 0.3).map((c) => c.t).sort((a, b) => a - b);
  check('the tracker is told about every join', told.length === 9, told.length + ' cuts');

  // the camera the tracker would build: left on even pieces, right on odd ones,
  // snapping exactly as facetrack.js does at a timed cut (2ms before, held 4ms before that)
  const LEFT = 300, RIGHT = 980, side = (k) => (k % 2 ? RIGHT : LEFT);
  const keyframes = [{ t: 0, x: side(0), y: 360 }];
  told.forEach((t, i) => { keyframes.push({ t: t - 0.006, x: side(i), y: 360 }, { t: t - 0.002, x: side(i + 1), y: 360 }); });
  const out = path.join(DIR, 'short.mp4');
  await video.exportShortReframed(ctx, { input: src, startSec: pieces[0].start, endSec: pieces[9].end, preset: 'reel-9x16', keyframes, pieces, output: out, onProgress: () => {} });

  // every output frame: mean red (which piece) and mean green (where the crop is)
  const raw = spawnSync(ffmpeg, ['-i', out, '-vf', 'scale=8:8,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 }).stdout;
  let n = 0, bad = 0, firstBad = null;
  for (let o = 0; o + 192 <= raw.length; o += 192, n++) {
    let r = 0, g = 0;
    for (let p = 0; p < 64; p++) { r += raw[o + p * 3]; g += raw[o + p * 3 + 1]; }
    const odd = r / 64 > 130, right = g / 64 > 128;
    if (odd !== right) { bad++; if (firstBad == null) firstBad = (n / 29.97).toFixed(3) + 's'; }
  }
  check('the short was rendered', n > 100, n + ' frames');
  check('on every frame the crop matches the picture (no frame of old framing on a new shot)', bad === 0,
    bad + ' wrong frame(s)' + (firstBad ? ', first at ' + firstBad : ''));

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL ' + e.stack); process.exit(1); });
