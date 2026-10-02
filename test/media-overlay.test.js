'use strict';
/*
 * ADDED MEDIA ON THE VIDEO — a second video, or a picture, composited on top.
 *
 * The renderer can place a block wherever it likes; what decides whether the
 * church sees the logo is video.exportOverlayComposite. So this drives that
 * directly and then READS THE PIXELS BACK out of the finished file:
 *
 *   1. a PICTURE is visible for its whole window and gone after it. This is the
 *      one that used to be impossible — a photo is a single frame, so without
 *      -loop it flashes for 1/30s and the operator sees nothing.
 *   2. a SECOND VIDEO (a different file from the base) lands in its box.
 *   3. the second video's SOUND comes with it, mixed under the base rather than
 *      replacing it, and `mute:true` leaves it out.
 *   4. the base's own audio is not quietened by the mix (amix normalize=0 —
 *      the default would halve the sermon the moment an overlay appeared).
 *
 * Everything is generated with ffmpeg, so it runs anywhere with no fixtures.
 * Usage: node test/media-overlay.test.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

function run(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-1500)))));
  });
}
/** Raw RGB bytes of one small region of one frame. */
function pixels(file, t, crop) {
  return new Promise((resolve, reject) => {
    const args = ['-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', `crop=${crop},scale=8:8,format=rgb24`, '-f', 'rawvideo', '-'];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', () => resolve(Buffer.concat(out)));
  });
}
/** Mean R, G, B of that region — colour is what tells the layers apart. */
async function meanRGB(file, t, crop) {
  const b = await pixels(file, t, crop);
  if (!b.length) return null;
  let r = 0, g = 0, bl = 0, n = b.length / 3;
  for (let i = 0; i < b.length; i += 3) { r += b[i]; g += b[i + 1]; bl += b[i + 2]; }
  return { r: r / n, g: g / n, b: bl / n };
}
/** Mean volume of a file (or of one stretch of it), in dBFS. */
function meanVolume(file, ss, t) {
  return new Promise((resolve) => {
    const args = ['-ss', String(ss), '-t', String(t), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'];
    const p = spawn(ffmpeg, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', () => {
      const m = /mean_volume:\s*(-?[\d.]+) dB/.exec(err);
      resolve(m ? parseFloat(m[1]) : null);
    });
  });
}
/** Loudness of ONE tone's frequency band — how the two sounds are told apart. */
async function bandVolume(file, ss, t, lo, hi) {
  const tmp = path.join(dir, `band-${lo}-${Date.now()}.wav`);
  await run(['-ss', String(ss), '-t', String(t), '-i', file,
    '-af', `bandpass=f=${(lo + hi) / 2}:width_type=h:w=${(hi - lo) / 2}`, '-y', tmp]);
  const v = await meanVolume(tmp, 0, t);
  fs.rmSync(tmp, { force: true });
  return v;
}

const dir = path.join(os.tmpdir(), 'mw-media-overlay');

(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  /* ---- fixtures ---------------------------------------------------------
   * base : 12s of DARK BLUE 640x360 with a 300 Hz tone
   * cam2 : 6s of BRIGHT GREEN 320x240 with a 1200 Hz tone (the "second video")
   * logo : a solid RED 200x200 PNG (the "picture")
   * Distinct colours and distinct tones, so what ends up in the file can only
   * have come from one of them.
   */
  const base = path.join(dir, 'base.mp4');
  const cam2 = path.join(dir, 'cam2.mp4');
  const logo = path.join(dir, 'logo.png');
  await run(['-f', 'lavfi', '-i', 'color=c=0x101c5a:s=640x360:r=30:d=12',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=12:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', base]);
  await run(['-f', 'lavfi', '-i', 'color=c=0x18d24a:s=320x240:r=30:d=6',
    '-f', 'lavfi', '-i', 'sine=frequency=1200:duration=6:sample_rate=48000',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', cam2]);
  await run(['-f', 'lavfi', '-i', 'color=c=0xd42020:s=200x200', '-frames:v', '1', '-y', logo]);

  // The overlay box: top-right quarter-ish. Read back a patch well inside it.
  const BOX = { x: 0.60, y: 0.06, w: 0.34 };
  const inBox = 'iw*0.16:ih*0.16:iw*0.66:ih*0.12';   // inside the overlay
  const outBox = 'iw*0.20:ih*0.20:iw*0.04:ih*0.60';  // bottom-left: always the base

  /* ================= 1. A PICTURE on top of the video ================= */
  console.log('\n1. a picture, held for its whole window');
  const withPic = path.join(dir, 'with-picture.mp4');
  await video.exportOverlayComposite(ctx, {
    base, output: withPic,
    overlays: [{ src: logo, still: true, srcStart: 0, srcEnd: 4, tlStart: 3, ...BOX }],
  });
  const picInfo = await video.getInfo(ctx, withPic);
  check('the picture export is the base video\'s length', Math.abs(picInfo.durationSec - 12) < 0.7, picInfo.durationSec.toFixed(2) + 's');
  check('and its size', picInfo.width === 640 && picInfo.height === 360, `${picInfo.width}x${picInfo.height}`);

  // A single frame would only show at t=3. Sample the FAR END of the window too:
  // that is the assertion that the still is really looped, not flashed.
  const picAtStart = await meanRGB(withPic, 3.3, inBox);
  const picAtEnd = await meanRGB(withPic, 6.7, inBox);
  const picBefore = await meanRGB(withPic, 1.5, inBox);
  const picAfter = await meanRGB(withPic, 9.0, inBox);
  const red = (c) => c && c.r > 120 && c.r > c.g * 2 && c.r > c.b * 2;
  const blue = (c) => c && c.b > c.r && c.r < 90;
  check('the picture is there at the START of its window', red(picAtStart), JSON.stringify(picAtStart));
  check('…and STILL there 3.4s later (it is looped, not one frame)', red(picAtEnd), JSON.stringify(picAtEnd));
  check('…not before it', blue(picBefore), JSON.stringify(picBefore));
  check('…and not after it', blue(picAfter), JSON.stringify(picAfter));
  const picElsewhere = await meanRGB(withPic, 5, outBox);
  check('the rest of the frame is untouched base video', blue(picElsewhere), JSON.stringify(picElsewhere));

  /* ============ 2. A SECOND VIDEO on top, with its own sound ============ */
  console.log('\n2. a second video, with its own sound');
  const withCam = path.join(dir, 'with-cam2.mp4');
  await video.exportOverlayComposite(ctx, {
    base, output: withCam,
    overlays: [{ src: cam2, srcStart: 0, srcEnd: 5, tlStart: 2, ...BOX }],
  });
  const camDuring = await meanRGB(withCam, 4, inBox);
  const camAfter = await meanRGB(withCam, 9, inBox);
  const green = (c) => c && c.g > 100 && c.g > c.r * 2;
  check('the second video plays inside its box', green(camDuring), JSON.stringify(camDuring));
  check('…and is gone when its clip ends', blue(camAfter), JSON.stringify(camAfter));

  // Sound: the 1200 Hz tone belongs ONLY to the second video, the 300 Hz tone
  // only to the base. Both must be present while the overlay is on screen.
  const hiDuring = await bandVolume(withCam, 3, 1.5, 900, 1500);
  const hiAfter = await bandVolume(withCam, 9, 1.5, 900, 1500);
  const loDuring = await bandVolume(withCam, 3, 1.5, 200, 400);
  check('the second video BRINGS ITS SOUND while it is on screen', hiDuring > hiAfter + 10,
    `during ${hiDuring && hiDuring.toFixed(1)}dB vs after ${hiAfter && hiAfter.toFixed(1)}dB`);
  check('…mixed UNDER the video, which is still audible', loDuring > -35, loDuring && loDuring.toFixed(1) + 'dB');

  // …and the base is not quietened by the act of mixing (amix normalize=0).
  const basePlain = await bandVolume(base, 3, 1.5, 200, 400);
  check('the base sermon is NOT halved by the mix', Math.abs(loDuring - basePlain) < 1.5,
    `${loDuring && loDuring.toFixed(1)}dB vs ${basePlain && basePlain.toFixed(1)}dB on its own`);

  /* =================== 3. mute:true drops that sound =================== */
  console.log('\n3. a silenced second video');
  const muted = path.join(dir, 'with-cam2-muted.mp4');
  await video.exportOverlayComposite(ctx, {
    base, output: muted,
    overlays: [{ src: cam2, mute: true, srcStart: 0, srcEnd: 5, tlStart: 2, ...BOX }],
  });
  const mutedHi = await bandVolume(muted, 3, 1.5, 900, 1500);
  const mutedLo = await bandVolume(muted, 3, 1.5, 200, 400);
  const mutedPic = await meanRGB(muted, 4, inBox);
  check('a silenced overlay still SHOWS', green(mutedPic), JSON.stringify(mutedPic));
  check('…but brings no sound', mutedHi < hiDuring - 10, `${mutedHi && mutedHi.toFixed(1)}dB vs ${hiDuring && hiDuring.toFixed(1)}dB unmuted`);
  check('…and the sermon audio is untouched', Math.abs(mutedLo - basePlain) < 1.5,
    `${mutedLo && mutedLo.toFixed(1)}dB vs ${basePlain && basePlain.toFixed(1)}dB`);

  /* ======== 4. a picture AND a second video, over a RANGE (a short) ======== */
  console.log('\n4. both at once, over a short\'s range');
  const both = path.join(dir, 'both.mp4');
  await video.exportOverlayComposite(ctx, {
    base, baseStart: 4, baseEnd: 10, output: both,
    // clip-relative times: the short starts at 0
    overlays: [
      { src: cam2, srcStart: 1, srcEnd: 4, tlStart: 0.5, x: 0.60, y: 0.06, wFrac: 0.34 },
      { src: logo, still: true, srcStart: 0, srcEnd: 2, tlStart: 3.5, x: 0.06, y: 0.60, wFrac: 0.25 },
    ],
  });
  const bothInfo = await video.getInfo(ctx, both);
  check('the range composite is only the short (~6s)', Math.abs(bothInfo.durationSec - 6) < 0.7, bothInfo.durationSec.toFixed(2) + 's');
  const topRight = 'iw*0.16:ih*0.16:iw*0.66:ih*0.12';
  const btmLeft = 'iw*0.12:ih*0.12:iw*0.10:ih*0.64';
  check('the second video is in the TOP-RIGHT at 2s', green(await meanRGB(both, 2, topRight)), '');
  check('the picture is in the BOTTOM-LEFT at 4s', red(await meanRGB(both, 4, btmLeft)), '');
  check('…and the top-right is back to the base by then', blue(await meanRGB(both, 4.5, topRight)), '');

  /* =============== 5. a picture over a video with NO sound =============== */
  console.log('\n5. a silent base keeps working');
  const silentBase = path.join(dir, 'silent.mp4');
  await run(['-f', 'lavfi', '-i', 'color=c=0x101c5a:s=640x360:r=30:d=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', silentBase]);
  const silentOut = path.join(dir, 'silent-out.mp4');
  await video.exportOverlayComposite(ctx, {
    base: silentBase, output: silentOut,
    overlays: [{ src: cam2, srcStart: 0, srcEnd: 3, tlStart: 1, ...BOX }],
  });
  const so = await video.getInfo(ctx, silentOut);
  check('a silent base + a talking overlay produces sound', so.hasAudio === true, 'hasAudio=' + so.hasAudio);
  check('…and the picture is still the base\'s full length', Math.abs(so.durationSec - 6) < 0.7, so.durationSec.toFixed(2) + 's');
  const silHi = await bandVolume(silentOut, 1.5, 1.2, 900, 1500);
  const silHiAfter = await bandVolume(silentOut, 5, 0.8, 900, 1500);
  check('…the overlay\'s sound sits at ITS time, not at 0', silHi > silHiAfter + 10,
    `${silHi && silHi.toFixed(1)}dB during vs ${silHiAfter && silHiAfter.toFixed(1)}dB after`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (!fail) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\nHARNESS ERROR:', e.message); process.exit(1); });
