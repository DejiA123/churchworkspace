'use strict';
/*
 * "720p, 1080p or 4K — and it must ACTUALLY be it."
 *
 * A quality dropdown is worth nothing unless the file that comes out is exactly
 * the size it promised, so every case here PROBES THE FINISHED MP4 and compares
 * the real width and height against the tier. It also checks the two things that
 * silently ruin quality even when the resolution is right:
 *
 *   • the frame rate — every export used to be forced to 30fps, which halves a
 *     60fps recording, and no setting anywhere said so;
 *   • the encoder — 'veryfast' softens fine detail at the same CRF, so the test
 *     measures real sharpness against the source rather than trusting settings.
 *
 *   node test/export-quality.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const ctx = { ffmpeg, ffprobe };

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const W = path.join(os.tmpdir(), 'mw-quality');
fs.rmSync(W, { recursive: true, force: true });
fs.mkdirSync(W, { recursive: true });

/** A detailed 4K 60fps source — detail and motion are what quality settings act on. */
const SRC4K = path.join(W, 'src4k.mp4');
execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-t', '3', '-i', 'testsrc2=s=3840x2160:r=60',
  '-f', 'lavfi', '-t', '3', '-i', 'sine=frequency=300', '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-crf', '16', '-c:a', 'aac', '-shortest', SRC4K]);

const probe = (f) => {
  const out = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name,pix_fmt', '-of', 'json', f], { maxBuffer: 1 << 22 });
  const st = JSON.parse(out).streams[0];
  const [n, d] = String(st.r_frame_rate || '30/1').split('/').map(Number);
  return { w: st.width, h: st.height, fps: d ? Math.round((n / d) * 100) / 100 : 30, codec: st.codec_name, pix: st.pix_fmt };
};
/**
 * How faithful an export is to the source, as SSIM (1.0 = identical).
 *
 * This replaced a Laplacian "sharpness" measure that could not answer the
 * question: it downscaled every file to 640x360 first, which throws away exactly
 * the detail the tiers differ by, and it compared a 9:16 CROP against the full
 * 16:9 source — two different pictures. SSIM against the source, at the source's
 * own size and framing, is the honest measure of "is it really that good".
 */
function ssimVsSource(file, src, w, h) {
  const r = spawnSync(ffmpeg, ['-v', 'info', '-i', file, '-i', src, '-lavfi',
    `[0:v]scale=${w}:${h}:flags=lanczos,format=yuv420p[a];[1:v]format=yuv420p[b];[a][b]ssim`,
    '-frames:v', '40', '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' });
  const m = /SSIM .*All:([\d.]+)/.exec(r.stderr || '');
  return m ? Number(m[1]) : null;
}

console.log('\n== EXPORT QUALITY: is the file really the size it says? ==\n');

const src = probe(SRC4K);
check('the source is a detailed 4K 60fps clip', src.w === 3840 && src.h === 2160 && src.fps >= 59,
  `${src.w}x${src.h} @${src.fps}fps`);

/* ---- the size maths, before spending an encode on it ---- */
const EXPECT = {
  '720p':  { 'reel-9x16': [720, 1280],  'wide-16x9': [1280, 720],   'square-1x1': [720, 720] },
  '1080p': { 'reel-9x16': [1080, 1920], 'wide-16x9': [1920, 1080],  'square-1x1': [1080, 1080] },
  '4k':    { 'reel-9x16': [2160, 3840], 'wide-16x9': [3840, 2160],  'square-1x1': [2160, 2160] },
};
for (const [q, shapes] of Object.entries(EXPECT)) {
  for (const [preset, [w, h]] of Object.entries(shapes)) {
    const got = video.presetSize(preset, q);
    check(`${q} ${preset} is ${w}x${h}`, got.w === w && got.h === h, `${got.w}x${got.h}`);
  }
}
check('every frame size is even (H.264 cannot encode an odd one)',
  Object.keys(EXPECT).every((q) => Object.keys(EXPECT[q]).every((p) => {
    const s2 = video.presetSize(p, q); return s2.w % 2 === 0 && s2.h % 2 === 0;
  })));
check('an unknown tier falls back to 1080p rather than failing',
  video.presetSize('reel-9x16', 'banana').h === 1920, JSON.stringify(video.presetSize('reel-9x16', 'banana')));

/* ---- and now the files themselves ---- */
(async () => {
  console.log('\n-- real exports, probed --');
  const made = {};
  for (const q of ['720p', '1080p', '4k']) {
    const out = path.join(W, `reel-${q}.mp4`);
    await video.exportShort(ctx, { input: SRC4K, startSec: 0, endSec: 2, preset: 'reel-9x16', quality: q, output: out });
    const p = probe(out);
    made[q] = { file: out, ...p };
    const want = EXPECT[q]['reel-9x16'];
    check(`a 9:16 export at ${q} really is ${want[0]}x${want[1]}`, p.w === want[0] && p.h === want[1], `${p.w}x${p.h}`);
    check(`…and is H.264 in yuv420p (playable everywhere)`, p.codec === 'h264' && p.pix === 'yuv420p', `${p.codec}/${p.pix}`);
  }

  const wide = path.join(W, 'wide-4k.mp4');
  await video.exportShort(ctx, { input: SRC4K, startSec: 0, endSec: 2, preset: 'wide-16x9', quality: '4k', output: wide });
  const wp = probe(wide);
  check('a 16:9 export at 4K really is 3840x2160', wp.w === 3840 && wp.h === 2160, `${wp.w}x${wp.h}`);

  /* ---- the frame rate must survive ---- */
  console.log('\n-- the frame rate ----');
  check('THE FIX: a 60fps recording stays 60fps (it used to be halved to 30)',
    made['1080p'].fps >= 59, made['1080p'].fps + 'fps');
  const s30 = path.join(W, 'src30.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-t', '2', '-i', 'testsrc2=s=1920x1080:r=30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', s30]);
  const out30 = path.join(W, 'out30.mp4');
  await video.exportShort(ctx, { input: s30, startSec: 0, endSec: 1.5, preset: 'wide-16x9', quality: '1080p', output: out30 });
  check('…and a 30fps recording is not pushed up to 60 either', probe(out30).fps === 30, probe(out30).fps + 'fps');
  check('a silly source rate is clamped to something every platform takes',
    video.outputFps({ fps: 240 }) === 60 && video.outputFps({ fps: 1 }) === 24,
    video.outputFps({ fps: 240 }) + ' / ' + video.outputFps({ fps: 1 }));

  /* ---- and it must LOOK like it, not merely measure it ----
   * Same SHAPE as the source (16:9), so the only difference being measured is
   * how much of the picture survived the encode. */
  console.log('\n-- is it actually faithful to the source? --');
  const fid = {};
  for (const q of ['720p', '1080p', '4k']) {
    const f = path.join(W, `wide-${q}.mp4`);
    await video.exportShort(ctx, { input: SRC4K, startSec: 0, endSec: 2, preset: 'wide-16x9', quality: q, output: f });
    fid[q] = ssimVsSource(f, SRC4K, 3840, 2160);
  }
  console.log(`      SSIM vs source: 720p ${fid['720p']} · 1080p ${fid['1080p']} · 4K ${fid['4k']}`);
  check('the 4K export is near-identical to the source', fid['4k'] != null && fid['4k'] > 0.95, String(fid['4k']));
  check('MORE PIXELS REALLY IS MORE PICTURE (4K > 1080p > 720p)',
    fid['4k'] > fid['1080p'] && fid['1080p'] > fid['720p'],
    `${fid['720p']} → ${fid['1080p']} → ${fid['4k']}`);
  check('even 720p is a clean encode, not a smeared one', fid['720p'] > 0.80, String(fid['720p']));

  const sizeOf = (f) => fs.statSync(f).size;
  check('the bigger tiers carry more data, as they must',
    sizeOf(made['4k'].file) > sizeOf(made['1080p'].file) && sizeOf(made['1080p'].file) > sizeOf(made['720p'].file),
    ['720p', '1080p', '4k'].map((q) => q + ' ' + (sizeOf(made[q].file) / 1e6).toFixed(1) + 'MB').join(' · '));

  /* ---- "Export video" keeps the shape but takes the size ---- */
  console.log('\n-- the whole-video export --');
  const asIs = path.join(W, 'src-asis.mp4');
  await video.exportShort(ctx, { input: SRC4K, startSec: 0, endSec: 1.5, preset: 'source', quality: 'source', output: asIs });
  const ai = probe(asIs);
  check('"same as the recording" leaves the frame exactly alone', ai.w === 3840 && ai.h === 2160, `${ai.w}x${ai.h}`);
  const down = path.join(W, 'src-1080.mp4');
  await video.exportShort(ctx, { input: SRC4K, startSec: 0, endSec: 1.5, preset: 'source', quality: '1080p', output: down });
  const dn = probe(down);
  check('…and asking for 1080p scales it, keeping its own shape', dn.w === 1920 && dn.h === 1080, `${dn.w}x${dn.h}`);

  /* ---- upscaling is real, and must be reported honestly ---- */
  console.log('\n-- upscaling --');
  const up = path.join(W, 'up-4k.mp4');
  await video.exportShort(ctx, { input: s30, startSec: 0, endSec: 1.5, preset: 'wide-16x9', quality: '4k', output: up });
  const upp = probe(up);
  check('a 1080p recording exported at 4K really is a 4K file', upp.w === 3840 && upp.h === 2160, `${upp.w}x${upp.h}`);
  check('…and the app knows it was stretched, so it can say so',
    video.upscaleFactor({ width: 1920, height: 1080 }, { w: 3840, h: 2160 }) === 2
    && video.upscaleFactor({ width: 3840, height: 2160 }, { w: 1920, h: 1080 }) === 1,
    'x' + video.upscaleFactor({ width: 1920, height: 1080 }, { w: 3840, h: 2160 }));

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  if (!fail) fs.rmSync(W, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
