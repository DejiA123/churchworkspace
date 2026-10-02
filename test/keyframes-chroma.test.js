'use strict';
/*
 * Keyframes and chroma key, measured on real exports.
 *
 *  1. Keyframes: a clip pushed in from 100% to 200% over two seconds. The
 *     exported frames are measured — how big a marker is, where it sits — at
 *     moments along the move, against the curve the preview draws. The
 *     preview's copy of that curve is checked against the export's.
 *  2. Chroma key: a green-screen overlay keyed onto a background. The green is
 *     gone, the subject stays, and the preview's own keying rule gives the same
 *     transparency ffmpeg's chromakey does, colour for colour.
 *
 *   node test/keyframes-chroma.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-kf-chroma');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};
const raw = (args) => execFileSync(ffmpeg, ['-v', 'error', ...args], { maxBuffer: 1 << 28 });
const probe = (f) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height:format=duration', '-of', 'json', f]).toString());
// Seeking to t decodes the first frame at or after it — the frame sampled.
const frameT = (t, fps = 30) => Math.ceil(t * fps - 1e-6) / fps;

/* ---------------------------------------------- the renderer's copies */
function rendererFns() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'veditor.js'), 'utf8');
  const grab = (re) => { const m = src.match(re); if (!m) throw new Error('missing ' + re); return m[0]; };
  const code = [
    'const clamp = (v, a, b) => Math.min(b, Math.max(a, v));',
    grab(/const kfList = [^\n]+/),
    grab(/const kfSorted = [^\n]+/),
    grab(/function kfAt\(s, t\) \{[\s\S]*?\n {2}\}/),
    grab(/const keyUVFull = \(r, g, b\) => \[[\s\S]*?\];/),
    grab(/const keyUV = \(r, g, b\) => \[[\s\S]*?\];/),
    grab(/const hexRgb = [^\n]+/),
    grab(/function keyAlpha\(r, g, b, kuv, sim, blend\) \{[\s\S]*?\n {2}\}/),
    'module.exports = { kfAt, keyUV, keyUVFull, hexRgb, keyAlpha };',
  ].join('\n');
  const m = { exports: {} };
  new Function('module', code)(m);
  return m.exports;
}

async function keyframes(R) {
  console.log('KEYFRAMES');
  // the preview's curve and the export's are the same curve
  const kf = [{ t: 10, z: 1, x: 0.5, y: 0.5 }, { t: 12, z: 2, x: 0.2, y: 0.7 }, { t: 15, z: 1.3, x: 0.9, y: 0.1 }];
  const motion = [{ start: 0, end: 10, pts: kf.map((k) => Object.assign({}, k, { t: k.t - 10 })) }];
  let worst = 0;
  for (let t = 9.5; t <= 15.5; t += 0.1) {
    const a = R.kfAt({ kf }, t), b = video.motionAt(motion, t - 10);
    worst = Math.max(worst, Math.abs(a.z - b.z), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  log(worst < 1e-9, 'preview and export follow the same curve, eased in and out', 'worst ' + worst);
  log(video.motionChain([{ start: 0, end: 5, pts: [{ t: 0, z: 1 }, { t: 5, z: 1 }] }], 540, 960) === '', 'keyframes that never zoom add nothing to the export');
  log(video.cleanMotion([{ start: 0, end: 5, pts: [{ t: 1, z: 9 }] }])[0].pts[0].z === video.MOTION_MAX_Z, 'zoom is capped', String(video.MOTION_MAX_Z));

  // A real export: a white frame with a red square in the middle and a blue
  // one at the left edge, pushed in 1x -> 2x between 1 s and 3 s.
  const W = 540, H = 960;
  const src = path.join(WORK, 'kf-src.mp4');
  raw(['-y', '-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:d=5:r=30,drawbox=x=${W / 2 - 20}:y=${H / 2 - 20}:w=40:h=40:c=red:t=fill,drawbox=x=0:y=${H / 2 - 20}:w=30:h=40:c=blue:t=fill`,
    '-f', 'lavfi', '-i', 'sine=d=5', '-shortest', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const run = async (name, pts) => {
    const out = path.join(WORK, name + '.mp4');
    await video.exportShort(ctx, { input: src, startSec: 0, endSec: 5, preset: 'source', quality: 'source', motion: [{ start: 0, end: 5, pts }], output: out, onProgress: () => {} });
    return out;
  };
  const centre = await run('kf-centre', [{ t: 1, z: 1, x: 0.5, y: 0.5 }, { t: 3, z: 2, x: 0.5, y: 0.5 }]);
  const info = probe(centre);
  log(info.streams[0].width === W && info.streams[0].height === H && Math.abs(Number(info.format.duration) - 5) < 0.1,
    'the export keeps its size and length', `${info.streams[0].width}x${info.streams[0].height}, ${Number(info.format.duration).toFixed(2)} s`);
  // width of the red run on the middle row
  const redRun = (file, t, row = H / 2) => {
    const d = raw(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=${W}:2:0:${row},format=rgb24`, '-f', 'rawvideo', '-']);
    let a = -1, b = -1;
    for (let x = 0; x < W; x++) { const i = x * 3; if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) { if (a < 0) a = x; b = x; } }
    return a < 0 ? null : { a, b, w: b - a + 1, mid: (a + b) / 2 };
  };
  const blueAt = (file, t, x) => {
    const d = raw(['-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=1:2:${x}:${H / 2},format=rgb24`, '-f', 'rawvideo', '-']);
    return d[2] > 150 && d[0] < 100;
  };
  const before = redRun(centre, 0.5), after = redRun(centre, 4);
  log(before && Math.abs(before.w - 40) <= 2, 'before the first keyframe the picture is untouched', before && `${before.w}px`);
  log(after && Math.abs(after.w - 80) <= 3 && Math.abs(after.mid - W / 2) <= 2, 'after the last it holds at 200%, centred', after && `${after.w}px at ${after.mid}`);
  let worstMid = 0;
  for (const t of [1.5, 2, 2.5]) {
    const z = video.motionAt([{ start: 0, end: 5, pts: [{ t: 1, z: 1, x: 0.5, y: 0.5 }, { t: 3, z: 2, x: 0.5, y: 0.5 }] }], frameT(t)).z;
    const r = redRun(centre, t);
    worstMid = Math.max(worstMid, Math.abs(r.w - 40 * z));
  }
  log(worstMid <= 3, 'along the move the size is exactly what the preview draws', `worst ${worstMid.toFixed(1)} px`);

  // x = 0 holds the left edge still: the blue marker never leaves it
  const left = await run('kf-left', [{ t: 1, z: 1, x: 0, y: 0.5 }, { t: 3, z: 2, x: 0, y: 0.5 }]);
  const l4 = redRun(left, 4);
  // the left half doubled: the blue marker (0-30) now covers 0-60, the square
  // (250-290) lands at 500 and runs off the right edge
  log(blueAt(left, 4, 2) && blueAt(left, 4, 50) && l4 && Math.abs(l4.a - 500) <= 3 && l4.b >= W - 2,
    'a push toward the left edge keeps that edge in place', l4 && `square now from x=${l4.a}`);

  // the face-tracked and framed routes carry it too
  const framed = path.join(WORK, 'kf-framed.mp4');
  await video.exportShortFramed(ctx, { input: src, startSec: 0, endSec: 5, preset: 'reel-9x16', quality: '720p', zoom: 1, offsetX: 0.5, offsetY: 0.5,
    motion: [{ start: 0, end: 5, pts: [{ t: 0, z: 1.5, x: 0.5, y: 0.5 }] }], output: framed, onProgress: () => {} });
  const fi = probe(framed).streams[0];
  const fd = raw(['-ss', '2', '-i', framed, '-frames:v', '1', '-vf', `crop=${fi.width}:2:0:${Math.round(fi.height / 2)},format=rgb24`, '-f', 'rawvideo', '-']);
  let fr = 0; for (let x = 0; x < fi.width; x++) if (fd[x * 3] > 180 && fd[x * 3 + 1] < 90) fr++;
  const expect = 40 * (fi.height / H) * 1.5;
  log(Math.abs(fr - expect) <= 4, 'the framed (manual crop) export pushes in as well', `${fr}px vs ${expect.toFixed(0)}px`);
}

async function chroma(R) {
  console.log('\nCHROMA KEY');
  // the preview's keying rule against ffmpeg's chromakey, colour by colour
  const colors = ['#00b140', '#00ff00', '#20c050', '#3a9a5a', '#0047bb', '#ffffff', '#ff0000', '#808080', '#f0c8a0', '#10a030', '#55dd55', '#006622'];
  const P = 32;
  const W = P * colors.length, H = P;
  const png = path.join(WORK, 'patches.png');
  const boxes = colors.map((c, i) => `drawbox=x=${i * P}:y=0:w=${P}:h=${P}:c=0x${c.slice(1)}:t=fill`).join(',');
  raw(['-y', '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1,${boxes}`, '-frames:v', '1', png]);
  const rgb = raw(['-i', png, '-vf', 'format=rgb24', '-f', 'rawvideo', '-']);
  let worst = 0, worstC = '';
  for (const [key, sim, blend] of [['#00b140', 0.12, 0.08], ['#00b140', 0.18, 0.08], ['#0047bb', 0.25, 0.1], ['#00ff00', 0.1, 0.02]]) {
    const a = raw(['-i', png, '-vf', `format=yuva420p,chromakey=color=0x${key.slice(1)}:similarity=${sim}:blend=${blend},format=rgba`, '-f', 'rawvideo', '-']);
    colors.forEach((c, i) => {
      const x = i * P + P / 2, y = P / 2;
      const ff = a[(y * W + x) * 4 + 3] / 255;
      const s = rgb.slice((y * W + x) * 3, (y * W + x) * 3 + 3);
      const js = R.keyAlpha(s[0], s[1], s[2], R.keyUVFull(...R.hexRgb(key)), sim, blend);
      const err = Math.abs(ff - js);
      if (blend === 0 && Math.abs(js - 0.5) === 0.5 && err > 0.5) { /* a hard key on the very edge may round either way */ }
      if (err > worst) { worst = err; worstC = `${c} keyed on ${key}: ffmpeg ${ff.toFixed(2)} vs preview ${js.toFixed(2)}`; }
    });
  }
  log(worst <= 0.08, 'the preview keys every colour the way ffmpeg does', `worst ${worst.toFixed(3)} (${worstC})`);

  // a real composite: blue background, green-screen overlay with a white subject
  const base = path.join(WORK, 'base.mp4');
  raw(['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:d=3:r=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', base]);
  const gs = path.join(WORK, 'greenscreen.mp4');
  raw(['-y', '-f', 'lavfi', '-i', 'color=c=0x00b140:s=320x320:d=3:r=30,drawbox=x=110:y=110:w=100:h=100:c=white:t=fill', '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'yuv420p', gs]);
  const make = async (name, key) => {
    const out = path.join(WORK, name + '.mp4');
    await video.exportOverlayComposite(ctx, { base, output: out, overlays: [{ src: gs, srcStart: 0, srcEnd: 3, tlStart: 0, x: 0.1, y: 0.1, wFrac: 0.5, key }], onProgress: () => {} });
    return out;
  };
  const px = (file, x, y) => [...raw(['-ss', '1', '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'])];
  const plain = await make('no-key');
  // the studio's own starting point for a green screen
  const keyed = await make('keyed', { color: '#00b140', sim: 0.12, blend: 0.08 });
  // overlay box: x 54..324, y 96..366 (270 px wide). Screen area near its corner; subject in the middle.
  const g0 = px(plain, 70, 112), g1 = px(keyed, 70, 112), s1 = px(keyed, 189, 231);
  log(g0[1] > 120 && g0[2] < 120, 'without a key the green screen covers the video', g0.join(','));
  log(g1[2] > 200 && g1[1] < 60, 'keyed: the green is gone and the video shows through', g1.join(','));
  log(s1[0] > 220 && s1[1] > 220 && s1[2] > 220, 'keyed: the subject stays', s1.join(','));
  log(video.keyOf({ color: 'nope' }) === null && video.keyOf({ color: '#00ff00', sim: 9 }).sim === 0.6, 'a bad key is refused, not passed to ffmpeg');
}

(async () => {
  const R = rendererFns();
  await keyframes(R);
  await chroma(R);
  console.log(failed ? '\n❌ keyframes & chroma key test failed' : '\n✅ keyframes & chroma key test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
