'use strict';
/*
 * THE BLURRED-PAD GRAPH IS THE SHORTS EXPORT.
 *
 * A face-tracked short of a real sermon takes the overshoot branch of
 * exportShortReframed — the one that widens the picture with a blurred copy of
 * itself so the crop can follow the speaker past the edge of the frame. On the
 * measured clip that branch is ONE ffmpeg run of 173 s for 90 s of footage, and
 * it is 94% of the export. It is also software-only on purpose.
 *
 * Two questions, both measured here rather than assumed:
 *   1. Does the background have to be blurred at full resolution? It is blurred
 *      until it is unrecognisable by DESIGN — so blurring a small copy and
 *      scaling that up should be indistinguishable and far cheaper.
 *   2. Is "QSV is flaky behind a multi-branch graph" still true on this machine?
 *
 * Run: node test/diag-pad-graph.js ["<video>"] [startSec] [durSec]
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const { sermonPath, noSermon } = require('./sermon');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const REAL = sermonPath(process.argv[2]);
const START = Number(process.argv[3] || 600);
const DUR = Number(process.argv[4] || 20);       // shorter than a real short; the RATIOS are the point
const WORK = path.join(os.tmpdir(), 'mw-pad-graph');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const secs = (ms) => (ms / 1000).toFixed(1) + 's';
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

(async () => {
  if (!REAL) { console.log(noSermon()); return; }
  const info = await video.getInfo(ctx, REAL);
  const W = 1080, H = 1920, targetAR = W / H;
  const cropW = Math.round(info.height * targetAR / 2) * 2, cropH = info.height;
  const maxX = info.width - cropW;

  /*
   * A camera path shaped like a real one: the speaker walks, so the crop wants
   * to sit outside [0, maxX] for part of the clip. Built through the SAME
   * simplify + expression builder the export uses, so the per-frame expression
   * cost is whatever the real thing pays.
   */
  const OVER = 145;                                   // the measured overshoot on this sermon
  const kfs = [];
  for (let t = 0; t <= DUR; t += 1 / 6) {
    const u = t / Math.max(0.001, DUR);
    kfs.push([t, Math.round(maxX / 2 + (maxX / 2 + OVER) * Math.sin(u * Math.PI * 2.5))]);
  }
  const P = Math.min(Math.ceil(OVER / 2) * 2 + 2, cropW);
  const padW = info.width + 2 * P;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pts = video.simplifyKeyframes(kfs.map(([t, x]) => [t, clamp(x + P, 0, padW - cropW)]));
  const xe = video.buildLerpExpr(pts, Math.round((padW - cropW) / 2));
  console.log(`\n  source ${info.width}x${info.height}   crop ${cropW}x${cropH} -> ${W}x${H}`);
  console.log(`  pad ${P}px each side -> ${padW} wide;  ${pts.length} keyframes, ${(xe.length / 1024).toFixed(1)} KB of expression`);
  console.log(`  clip ${START}s +${DUR}s\n`);

  /* ---- the background branch, three ways ---- */
  const bgNow = `scale=${padW}:-2,crop=${padW}:${info.height},`
    + `boxblur=luma_radius=24:luma_power=2:chroma_radius=12:chroma_power=2,eq=brightness=-0.06`;
  // Blur a SMALL copy and scale it back up. A 24-radius blur has already thrown
  // away everything finer than 24px, so doing it at a quarter scale with a
  // proportionally smaller radius lands in the same place for a sixteenth of
  // the pixels. The upscale is bilinear on purpose: lanczos on a blur is money
  // spent sharpening something that has no edges left.
  const SH = 4;
  const smallW = even(padW / SH);
  const bgSmall = `scale=${smallW}:-2,`
    + `boxblur=luma_radius=${Math.max(1, Math.round(24 / SH))}:luma_power=2:chroma_radius=${Math.max(1, Math.round(12 / SH))}:chroma_power=2,`
    + `scale=${padW}:-2:flags=bilinear,crop=${padW}:${info.height},eq=brightness=-0.06`;

  const graph = (bg) => `[0:v]split=2[bgs][fgs];[bgs]${bg}[bg];`
    + `[bg][fgs]overlay=${P}:0,crop=${cropW}:${cropH}:x='${xe}':y=0,scale=${W}:${H}:flags=lanczos,setsar=1`;

  const run = (name, bg, codec) => {
    const out = path.join(WORK, name.replace(/[^a-z0-9]+/gi, '-') + '.mp4');
    const fmt = codec[1] === 'h264_qsv' ? 'nv12' : 'yuv420p';
    const t0 = Date.now();
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(START), '-t', String(DUR), '-i', REAL,
      '-filter_complex', graph(bg) + `,format=${fmt}[vout]`, '-map', '[vout]', '-an',
      '-r', '30', ...codec, out], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const ms = Date.now() - t0;
    const ok = r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 10000;
    return { name, out, ms, ok, err: String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || '' };
  };

  const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19'];
  const QSV = ['-c:v', 'h264_qsv', '-global_quality', '19'];
  const variants = [
    ['what it does now', bgNow, X264],
    ['blur a small copy', bgSmall, X264],
    ['now + Quick Sync', bgNow, QSV],
    ['small blur + Quick Sync', bgSmall, QSV],
  ];
  const made = [];
  for (const [name, bg, codec] of variants) {
    const r = run(name, bg, codec);
    console.log(`   ${name.padEnd(26)} ${r.ok ? secs(r.ms).padStart(8) : '   FAILED'}`
      + `   ${r.ok ? (fs.statSync(r.out).size / 1048576).toFixed(1) + ' MB' : r.err.slice(0, 70)}`);
    if (r.ok) made.push(r);
  }

  /* ---- does it still decode cleanly? (the QSV question) ---- */
  console.log('\n  DOES THE FILE SURVIVE A DECODE? (this is what "QSV is flaky here" meant)');
  for (const m of made) {
    const clean = await video.isCleanEncode(ctx, m.out);
    console.log(`   ${m.name.padEnd(26)} ${clean ? 'clean' : '>> DECODES WITH ERRORS <<'}`);
  }

  /* ---- and is it the same picture? ---- */
  if (made.length > 1) {
    console.log('\n  AGAINST WHAT IT SHIPS TODAY (the first row is the reference):');
    const ref = made[0].out;
    for (const m of made.slice(1)) {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-i', m.out, '-i', ref,
        '-lavfi', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
      const e = r.stderr || '';
      const ssim = (e.match(/SSIM[^\n]*All:([\d.]+)/) || [])[1];
      const psnr = (e.match(/PSNR[^\n]*average:([\d.inf]+)/) || [])[1];
      console.log(`   ${m.name.padEnd(26)} SSIM ${ssim || '?'}   PSNR ${psnr || '?'} dB`);
    }
    console.log('\n  (The speaker\'s own pixels are overlaid UNTOUCHED on top of the blur, so any');
    console.log('   difference here lives ONLY in the padding either side — which is blurred');
    console.log('   past recognition by design. The number that would matter is a SHARP');
    console.log('   region changing, and there is none in the pad.)');
  }
})().catch((e) => console.error(e));
