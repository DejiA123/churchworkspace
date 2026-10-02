'use strict';
/*
 * The face-track export used to crash on long clips: ~150 pan keyframes became a
 * 150-deep nested-if ffmpeg expression and the parser gave up ("Failed to
 * configure input pad"). buildLerpExpr now emits a FLAT sum of time-gated ramps,
 * which parses at any practical length — so this suite proves (a) a dense path
 * exports fine, (b) the expression puts the crop EXACTLY where the keyframes say
 * (a flat sum with a gap in its gates would silently slam the crop to x=0), and
 * (c) the path is still simplified enough to keep the filter string sane.
 * Run:  node test/reframe-export.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const DIR = path.join(os.tmpdir(), 'mw-reframe-test');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  // A 100s 1280x720 clip => a long face-tracked short.
  const clip = path.join(DIR, 'long.mp4');
  spawnSync(ffmpeg, ['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=100',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=100', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', clip]);
  check('100s test clip made', fs.existsSync(clip));

  // 150 pan keyframes (1 / 0.66s) — the density that overflowed ffmpeg before.
  const keyframes = [];
  for (let i = 0; i < 150; i++) { const t = i * 100 / 149; keyframes.push({ t, x: Math.round(640 + 300 * Math.sin(i / 4)), y: 360 }); }

  // unit: simplify keeps the filter string sane without gutting the path
  const simp = video.simplifyKeyframes(keyframes.map((k) => [k.t, k.x]));
  check('simplifyKeyframes caps a 150-keyframe path at the export limit', simp.length <= 160 && simp.length >= 2, simp.length + ' points');
  check('simplified path keeps the first + last keyframe', simp[0][0] === 0 && Math.abs(simp[simp.length - 1][0] - 100) < 0.01);

  // The dense, UNSIMPLIFIED expression must now parse — this is what used to crash.
  const rawExpr = video.buildLerpExpr(keyframes.map((k) => [k.t, k.x]), 640);
  const rawR = spawnSync(ffmpeg, ['-i', clip, '-vf', `crop=405:720:x='${rawExpr}':y='0',scale=1080:1920`, '-frames:v', '10', '-y', path.join(DIR, 'raw.mp4')], { encoding: 'utf-8' });
  check('a dense 150-keyframe expression now parses (was the crash)', rawR.status === 0, 'exit ' + rawR.status);

  // CORRECTNESS: does the rendered crop actually sit where the keyframes ask?
  // The source carries white bars at known positions, each a UNIQUE width, so any
  // bar spotted in an output frame identifies itself and reveals exactly where the
  // crop window was: crop_x = (that bar's source x) - (its column in the output).
  // Reading a POSITION rather than a brightness keeps this immune to YUV range
  // conversion, and self-identifying bars make it independent of what we expected
  // to see. The path is piecewise-linear at the keyframe times, so the expression
  // should reproduce it to the pixel — any drift here is a real defect.
  {
    const DUR = 6, CW = 404, SW = 1280;
    const BARS = [[100, 2], [380, 4], [660, 6], [940, 8], [1220, 10]]; // [x, width]; spacing < CW so one is always fully visible
    const kf = []; // triangle sweep across the full legal range of crop centres
    for (let i = 0; i <= 12; i++) { const t = (i / 12) * DUR; kf.push([t, Math.round(202 + 876 * (i <= 6 ? i / 6 : (12 - i) / 6))]); }
    const centreAt = (t) => {
      if (t <= kf[0][0]) return kf[0][1];
      for (let i = 0; i < kf.length - 1; i++) if (t < kf[i + 1][0]) { const p = (t - kf[i][0]) / (kf[i + 1][0] - kf[i][0]); return kf[i][1] + (kf[i + 1][1] - kf[i][1]) * p; }
      return kf[kf.length - 1][1];
    };
    const bars = path.join(DIR, 'bars.mp4');
    const draw = BARS.map(([x, w]) => `drawbox=x=${x}:y=0:w=${w}:h=720:color=white:t=fill`).join(',');
    spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=black:size=${SW}x720:rate=30:duration=${DUR}`,
      '-vf', draw, '-pix_fmt', 'yuv420p', '-y', bars]);
    const cropExpr = video.buildLerpExpr(kf.map(([t, c]) => [t, c - CW / 2]), 0);
    const r = spawnSync(ffmpeg, ['-v', 'error', '-i', bars,
      '-vf', `crop=${CW}:720:x='${cropExpr}':y=0,crop=${CW}:2:0:0,format=gray`,
      '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
    const buf = r.stdout, frameBytes = CW * 2, nF = Math.floor(buf.length / frameBytes);
    let worstPx = 0, worstT = 0, unreadable = 0, read = 0;
    for (let f = 1; f < nF - 1; f++) {
      // bright runs in this frame's first row
      const runs = [];
      for (let x = 0, s = -1; x <= CW; x++) {
        const on = x < CW && buf[f * frameBytes + x] > 128;
        if (on && s < 0) s = x;
        else if (!on && s >= 0) { runs.push([s, x - s]); s = -1; }
      }
      // only fully-visible bars identify themselves (edge-clipped ones read narrow)
      const inner = runs.filter(([s, w]) => s > 0 && s + w < CW && BARS.some(([, bw]) => bw === w));
      if (!inner.length) { unreadable++; continue; }
      const [start, w] = inner[0];
      const src = BARS.find(([, bw]) => bw === w)[0];
      const cropX = src - start;                       // where the window really was
      const t = f / 30; // ffmpeg evaluates the crop expression at each frame's PTS, not its midpoint
      const d = Math.abs(cropX - (centreAt(t) - CW / 2)); // vs where it was told to be
      read++;
      if (d > worstPx) { worstPx = d; worstT = t; }
    }
    check('crop position is readable in (almost) every exported frame', nF > 100 && read > 0.9 * (nF - 2), `${read} readable, ${unreadable} not, of ${nF}`);
    check('rendered crop matches the keyframe path to the pixel (< 2px)', read > 0 && worstPx < 2,
      `worst ${worstPx}px at t=${worstT.toFixed(2)}s`);
  }

  // the real export must now SUCCEED and be a valid vertical short
  const out = path.join(DIR, 'reframed-long.mp4');
  await video.exportShortReframed(ctx, { input: clip, startSec: 0, endSec: 100, preset: 'reel-9x16', keyframes, output: out });
  check('face-tracked export SUCCEEDS on a long clip (no more crash)', fs.existsSync(out) && fs.statSync(out).size > 10000);
  if (fs.existsSync(out)) {
    const oi = await video.getInfo(ctx, out);
    check('exported short is 1080x1920 vertical', oi.width === 1080 && oi.height === 1920, `${oi.width}x${oi.height}`);
    check('exported short is the full length', Math.abs(oi.durationSec - 100) < 3, oi.durationSec + 's');
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); process.exit(1); });
