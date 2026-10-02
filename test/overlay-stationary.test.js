'use strict';
/*
 * "When I put an overlay image on the timeline and auto-reframe is on, the
 *  overlay MOVES instead of staying on one spot in the frame."
 *
 * It did, and the reason was the order of operations: the overlay was composited
 * into the SOURCE picture and the short was then cropped out of that, so the
 * crop window — which walks across the frame following the speaker — dragged the
 * overlay along with it.
 *
 * This proves the fix on real files, by measuring WHERE THE OVERLAY IS IN EVERY
 * FRAME of a finished, face-tracked short:
 *
 *   1. a source whose "speaker" is a bright block that MOVES right across the
 *      picture, so a face-tracked crop really has to travel,
 *   2. a magenta logo placed in the top-right of the export frame,
 *   3. the short exported through the REAL reframing path with real keyframes,
 *   4. the logo located in frames spread across the whole short,
 *   5. it must be in the SAME PLACE in all of them — and the control is the same
 *      export with the overlay composited the OLD way (before the crop), which
 *      must visibly drift, or this test proves nothing.
 *
 * Run: npx electron test/overlay-stationary.test.js
 */
const { app } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const ffmpegBin = require('ffmpeg-static');
const ffprobeBin = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg: ffmpegBin, ffprobe: ffprobeBin };
const DIR = path.join(os.tmpdir(), 'mw-overlay-stationary');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

const W = 1920, H = 1080, DUR = 6;
const PRESET = 'reel-9x16';                     // 1080x1920 out of a 16:9 in

/* A 16:9 source with a bright block sliding from the left of the picture to the
 * right. That is what makes the crop window travel — and a travelling crop is
 * the whole point of the bug. */
function makeSource() {
  const p = path.join(DIR, 'src.mp4');
  const r = spawnSync(ffmpegBin, ['-y',
    '-f', 'lavfi', '-i', `color=c=0x101820:s=${W}x${H}:d=${DUR}:r=25`,
    '-f', 'lavfi', '-i', `color=c=0xe8e0d0:s=420x420:d=${DUR}:r=25`,
    '-filter_complex', `[0:v][1:v]overlay=x='(W-w)*t/${DUR}':y=(H-h)/2[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', p]);
  if (!fs.existsSync(p)) throw new Error('could not build the source\n' + r.stderr.toString().slice(-700));
  return p;
}
/** A magenta disc on transparency — nothing else in the picture is near it. */
function makeLogo() {
  const p = path.join(DIR, 'logo.png');
  spawnSync(ffmpegBin, ['-y', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=300x300,format=rgba',
    '-vf', "geq=r='if(lt(hypot(X-150,Y-150),130),255,0)':g='0':b='if(lt(hypot(X-150,Y-150),130),200,0)':a='if(lt(hypot(X-150,Y-150),130),255,0)'",
    '-frames:v', '1', p]);
  if (!fs.existsSync(p)) throw new Error('could not build the logo');
  return p;
}
const SRC = makeSource();
const LOGO = makeLogo();

/* -------------------------- finding the logo -------------------------- */
const GW = 108, GH = 192;   // 9:16, so every measurement is a frame fraction
function logoCentre(file, t) {
  const r = spawnSync(ffmpegBin, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `scale=${GW}:${GH}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  const b = r.stdout;
  if (!b || b.length < GW * GH * 3) return null;
  let sx = 0, sy = 0, n = 0;
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      const p = (y * GW + x) * 3;
      const R = b[p], G = b[p + 1], B = b[p + 2];
      if (R > 150 && G < 110 && B > 110 && (R - G) > 90) { sx += x; sy += y; n++; }
    }
  }
  return n > 4 ? { x: +(sx / n / GW).toFixed(4), y: +(sy / n / GH).toFixed(4), n } : null;
}
/** How far the overlay wanders across a whole finished short. */
function wander(file, times) {
  const pts = times.map((t) => logoCentre(file, t)).filter(Boolean);
  if (pts.length < times.length) return { pts, missing: times.length - pts.length, dx: null, dy: null };
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    pts, missing: 0,
    dx: +(Math.max(...xs) - Math.min(...xs)).toFixed(4),
    dy: +(Math.max(...ys) - Math.min(...ys)).toFixed(4),
  };
}

/* Keyframes that really travel: the tracker's own output for this source would
 * be a crop following the bright block from one side to the other, so that is
 * what is handed to the reframing export. */
function travellingKeyframes() {
  const out = [];
  const half = 210;                                  // the block is 420 wide
  for (let t = 0; t <= DUR; t += 0.25) {
    // exportShortReframed wants the speaker's x in SOURCE PIXELS, not a fraction
    out.push({ t, x: Math.round(half + (W - 2 * half) * (t / DUR)) });
  }
  return out;
}

app.whenReady().then(async () => {
  const info = await video.getInfo(ctx, SRC);
  console.log(`source: ${info.width}x${info.height} ${info.durationLabel}, speaker slides left→right`);
  const times = [0.6, 1.8, 3.0, 4.2, 5.4];
  const keyframes = travellingKeyframes();
  const p = video.presetSize(PRESET, '1080p');

  /* ---- the crop really does travel (or nothing below means anything) ---- */
  const plain = path.join(DIR, 'plain.mp4');
  await video.exportShortReframed(ctx, { input: SRC, startSec: 0, endSec: DUR, preset: PRESET, quality: '1080p', keyframes, output: plain });
  const pi = await video.getInfo(ctx, plain);
  check(pi.width === p.w && pi.height === p.h, 'the face-tracked short exported', `${pi.width}x${pi.height}`);
  // the bright block should sit near the middle of every frame if the crop followed it
  const blockAt = (t) => {
    const r = spawnSync(ffmpegBin, ['-v', 'error', '-ss', String(t), '-i', plain, '-frames:v', '1',
      '-vf', `scale=${GW}:${GH}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
    const b = r.stdout; if (!b) return null;
    let sx = 0, n = 0;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) if (b[y * GW + x] > 150) { sx += x; n++; }
    return n > 10 ? sx / n / GW : null;
  };
  const centres = times.map(blockAt).filter((v) => v != null);
  check(centres.length === times.length && Math.max(...centres) - Math.min(...centres) < 0.2,
    'the crop really followed the speaker (they stay put in the output)',
    centres.map((c) => c.toFixed(3)).join(', '));

  /* ---- THE FIX: overlay composited onto the FINISHED short ---- */
  console.log('\n  the overlay, laid on after the crop (what the app does now)');
  const after = path.join(DIR, 'after.mp4');
  const place = { x: 0.62, y: 0.06, wFrac: 0.3 };
  await video.exportOverlayComposite(ctx, {
    base: plain, output: after,
    overlays: [{ src: LOGO, still: true, mute: true, srcStart: 0, srcEnd: DUR, tlStart: 0, ...place }],
  });
  const fixed = wander(after, times);
  console.log('  ' + fixed.pts.map((q, i) => `${times[i]}s ${q.x},${q.y}`).join('  ·  '));
  check(fixed.missing === 0, 'the overlay is in EVERY frame of the short', `${fixed.pts.length}/${times.length} frames`);
  check(fixed.dx != null && fixed.dx < 0.01 && fixed.dy < 0.01,
    'IT STAYS ON ONE SPOT while the crop travels across the picture',
    `moved ${((fixed.dx || 0) * 100).toFixed(1)}% across, ${((fixed.dy || 0) * 100).toFixed(1)}% down`);
  const want = { x: place.x + place.wFrac / 2, y: place.y + (place.wFrac * (p.w / p.h)) / 2 };
  check(fixed.pts.length && Math.abs(fixed.pts[0].x - want.x) < 0.04,
    '…and it is the spot it was given', `centre x ${fixed.pts[0].x} vs ${want.x.toFixed(3)}`);

  /* ---- THE CONTROL: the old order must visibly drift ---- */
  console.log('\n  the old order, for comparison (overlay into the source, then crop)');
  const preComposited = path.join(DIR, 'pre.mp4');
  await video.exportOverlayComposite(ctx, {
    base: SRC, baseStart: 0, baseEnd: DUR, output: preComposited,
    // the same corner, but of the SOURCE frame — which is what the old payload meant
    // Deliberately inside the crop window at the START, so that if it leaves the
    // picture later that is the CROP TRAVELLING, not a placement that was never
    // on screen. (The 9:16 window over a 16:9 frame is ~31% of its width.)
    overlays: [{ src: LOGO, still: true, mute: true, srcStart: 0, srcEnd: DUR, tlStart: 0, x: 0.10, y: 0.06, wFrac: 0.09 }],
  });
  const before = path.join(DIR, 'before.mp4');
  await video.exportShortReframed(ctx, { input: preComposited, startSec: 0, endSec: DUR, preset: PRESET, quality: '1080p', keyframes, output: before });
  const drifted = wander(before, times);
  console.log('  ' + drifted.pts.map((q, i) => `${times[i]}s ${q.x},${q.y}`).join('  ·  '));
  const drift = drifted.dx == null ? 1 : drifted.dx;
  check(drifted.missing > 0 || drift > 0.08,
    'THE OLD ORDER really did drag the overlay around (so the test can tell the difference)',
    drifted.missing ? `it left the picture entirely in ${drifted.missing} of ${times.length} frames`
      : `moved ${(drift * 100).toFixed(1)}% across the frame`);
  check(fixed.dx != null && (drifted.missing > 0 || drift > (fixed.dx + 0.05)),
    '…and the new order is the one that holds still',
    `old ${drifted.missing ? 'off-frame' : (drift * 100).toFixed(1) + '%'} vs new ${((fixed.dx || 0) * 100).toFixed(1)}%`);

  console.log(`\n  artefacts for eyeballing: ${DIR}`);
  console.log(`\n==== overlay stays put: ${pass} PASS / ${fail} FAIL ====`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
