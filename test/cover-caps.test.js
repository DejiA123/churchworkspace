'use strict';
/*
 * HIDING CAPTIONS THAT ARE ALREADY IN THE PICTURE.
 *
 * A recording that arrives with subtitles burned in cannot have them removed —
 * the picture under the words was never filmed. What it CAN have is the strip
 * they sit in covered, the way a broadcaster covers a wrong name-plate, with
 * the app's own captions going on top.
 *
 * So this test burns real words into a real video, covers them, and then LOOKS:
 * the strip must actually change, the rest of the picture must not, and the
 * result must survive being cropped into a 9:16 short.
 *
 *   node test/cover-caps.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const OUT = path.join(os.tmpdir(), 'mw-cover-caps');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const SRC = path.join(OUT, 'burned-in.mp4');
const W = 1280, H = 720;
// where the fake burned-in subtitle sits, as fractions of the frame
const BAND_Y = 0.80, BAND_H = 0.16;

/** Mean luma + how much detail (stdev) there is inside a band of a frame. */
function bandStats(png, y0, y1) {
  const out = execFileSync(ffmpeg, ['-v', 'error', '-i', png,
    '-vf', `crop=iw:${Math.round((y1 - y0) * H)}:0:${Math.round(y0 * H)},signalstats,metadata=print:file=-`,
    '-f', 'null', '-'], { encoding: 'utf-8' });
  const avg = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(out);
  const dev = /lavfi\.signalstats\.YDIF=([\d.]+)/.exec(out);
  const hi = /lavfi\.signalstats\.YHIGH=([\d.]+)/.exec(out);
  const lo = /lavfi\.signalstats\.YLOW=([\d.]+)/.exec(out);
  return {
    avg: avg ? +avg[1] : null, dif: dev ? +dev[1] : null,
    spread: hi && lo ? +hi[1] - +lo[1] : null,
  };
}
/** How much fine DETAIL a band holds — a sobel edge image's mean level. Words
 *  are edges; blurring them away shows up here and nowhere else. */
function bandEdge(png, y0, y1) {
  const out = execFileSync(ffmpeg, ['-v', 'error', '-i', png,
    '-vf', 'crop=iw:' + Math.round((y1 - y0) * H) + ':0:' + Math.round(y0 * H) + ',sobel,signalstats,metadata=print:file=-',
    '-f', 'null', '-'], { encoding: 'utf-8' });
  const avg = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(out);
  return avg ? +avg[1] : null;
}
/** How different two stills are, in dB. Low = the picture really changed. */
function difference(a, b) {
  // ffmpeg reports psnr on STDERR, not stdout — reading only stdout gives null,
  // and `null < 25` is true, which is how a check like this passes while
  // measuring nothing at all.
  const r = spawnSync(ffmpeg, ['-v', 'info', '-i', a, '-i', b, '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf-8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /average:([\d.]+|inf)/.exec(out);
  if (!m) throw new Error('could not measure the difference between the two frames');
  return m[1] === 'inf' ? 999 : +m[1];
}
function frameOf(mp4, at, dest) {
  execFileSync(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', mp4, '-frames:v', '1', '-y', dest]);
  return dest;
}

(async () => {
  console.log('\n[1] A video that arrives with words burned into it');
  // a moving picture with big white text in a bottom band — a burned-in subtitle
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '6', '-i', `testsrc2=s=${W}x${H}:r=30`,
    '-f', 'lavfi', '-t', '6', '-i', 'sine=frequency=440:sample_rate=44100',
    '-filter_complex',
    `[0:v]drawtext=text='THIS TEXT IS BURNED IN':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.85:boxborderw=18`
    + `:x=(w-text_w)/2:y=${Math.round(BAND_Y * H) + 20}[v]`,
    '-map', '[v]', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
  const info = await video.getInfo(ctx, SRC);
  check('the test recording exists', fs.existsSync(SRC) && info.width === W, info.width + 'x' + info.height);

  const before = bandStats(frameOf(SRC, 2, path.join(OUT, 'before.png')), BAND_Y, BAND_Y + BAND_H);
  check('there really are words in the band', before.spread > 120,
    'contrast across the band = ' + before.spread);

  console.log('\n[2] The filter itself');
  const cov = { on: true, mode: 'solid', x: 0, w: 1, y: BAND_Y, h: BAND_H };
  check('off means nothing at all is added', video.coverChain(W, H, { on: false }) === null);
  check('a band at the very left edge starts at 0, not at 2',
    /x=0:/.test(video.coverChain(W, H, cov)), video.coverChain(W, H, cov));
  check('blur builds a crop-blur-overlay of the band, not the whole frame',
    /crop=\d+:\d+:\d+:\d+,boxblur/.test(video.coverChain(W, H, Object.assign({}, cov, { mode: 'blur' }))));
  check('smear uses delogo, kept off the frame edges',
    /^delogo=x=[1-9]/.test(video.coverChain(W, H, Object.assign({}, cov, { mode: 'smear' }))));
  check('it goes in FRONT of the crop, so the numbers still mean the source frame',
    video.withCover('crop=100:100:0:0', W, H, cov).indexOf('drawbox') === 0);
  check('and with nothing to cover the chain is untouched',
    video.withCover('crop=100:100:0:0', W, H, null) === 'crop=100:100:0:0');

  console.log('');
  console.log('[3] Covering it for real');
  const beforeShot = path.join(OUT, 'before.png');
  const beforeEdge = bandEdge(beforeShot, BAND_Y, BAND_Y + BAND_H);
  const wasAbove = bandStats(beforeShot, 0.2, 0.5);
  console.log('    detail in the band before covering: ' + beforeEdge);
  const shots = {};
  for (const mode of ['solid', 'blur', 'smear']) {
    const dest = path.join(OUT, 'covered-' + mode + '.mp4');
    await video.exportShort(ctx, {
      input: SRC, startSec: 0, endSec: 6, preset: 'source', quality: 'source',
      cover: Object.assign({}, cov, { mode }), output: dest,
    });
    shots[mode] = frameOf(dest, 2, path.join(OUT, 'covered-' + mode + '.png'));
    const above = bandStats(shots[mode], 0.2, 0.5);
    check(mode + ': everything OUTSIDE the band is untouched',
      Math.abs(above.avg - wasAbove.avg) < 2, 'luma above the band ' + wasAbove.avg + ' -> ' + above.avg);
  }
  // Each mode promises something different, so each is judged on its own promise.
  const solidBand = bandStats(shots.solid, BAND_Y, BAND_Y + BAND_H);
  check('solid: nothing whatsoever is left in the band', solidBand.spread < 5,
    'contrast across the band = ' + solidBand.spread);
  const blurEdge = bandEdge(shots.blur, BAND_Y, BAND_Y + BAND_H);
  check('blur: the detail the words were made of is gone', blurEdge < beforeEdge * 0.5,
    'detail ' + beforeEdge + ' -> ' + blurEdge);
  // delogo rebuilds the area from its edges: over a plain wall that is invisible,
  // over a test pattern it blotches. What it must NOT do is leave the words as they were.
  const smearEdge = bandEdge(shots.smear, BAND_Y, BAND_Y + BAND_H);
  const smearDiff = difference(beforeShot, shots.smear);
  check('smear: the band really was rebuilt, not left alone', smearDiff < 25,
    'detail ' + beforeEdge + ' -> ' + smearEdge + ', difference ' + smearDiff + 'dB')

  console.log('\n[4] It survives being made into a short');
  const shortOut = path.join(OUT, 'short.mp4');
  await video.exportShortFramed(ctx, {
    input: SRC, startSec: 0, endSec: 5, preset: 'reel-9x16', quality: '1080p',
    zoom: 1, offsetX: 0.5, offsetY: 0.5, cover: Object.assign({}, cov, { mode: 'solid' }),
    output: shortOut,
  });
  const si = await video.getInfo(ctx, shortOut);
  check('the short is 9:16', si.width === 1080 && si.height === 1920, si.width + 'x' + si.height);
  // the band is at the same FRACTION of the frame after the crop, because the
  // cover was applied before it
  const sShot = frameOf(shortOut, 2, path.join(OUT, 'short.png'));
  const sOut = execFileSync(ffmpeg, ['-v', 'error', '-i', sShot,
    '-vf', `crop=iw:${Math.round(BAND_H * 1920)}:0:${Math.round(BAND_Y * 1920)},signalstats,metadata=print:file=-`,
    '-f', 'null', '-'], { encoding: 'utf-8' });
  const hi = /lavfi\.signalstats\.YHIGH=([\d.]+)/.exec(sOut);
  const lo = /lavfi\.signalstats\.YLOW=([\d.]+)/.exec(sOut);
  const sSpread = hi && lo ? +hi[1] - +lo[1] : 999;
  check('and the band in the finished short has no words left in it', sSpread < 60,
    'contrast in the band = ' + sSpread);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
