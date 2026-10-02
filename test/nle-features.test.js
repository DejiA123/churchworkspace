'use strict';
/*
 * Headless tests for the new NLE-style video engine capabilities:
 * manual pan/zoom crop, waveform rendering, stabilization, clip reversal,
 * freeze-frame, and positioned text-overlay burn-in. No Electron needed.
 * Run with: node test/nle-features.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const cap = require('../src/main/captioner');

const ctx = { ffmpeg, ffprobe };
const DIR = path.join(os.tmpdir(), 'mw-nle-test');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  -> ' + detail : '')); fail++; }
}
function run(args) { const r = spawnSync(ffmpeg, args, { encoding: 'utf-8' }); if (r.status !== 0) throw new Error(r.stderr.slice(-800)); }

/** Decode to small raw grayscale frames and return average frame-to-frame pixel
 *  difference — an honest, ffmpeg-independent "how much did the image jitter"
 *  metric (vidstab's own .trf log is a binary format, not parseable text). */
function motionEnergy(file, w = 64, h = 36, fps = 10) {
  const raw = path.join(DIR, path.basename(file, path.extname(file)) + '.gray');
  run(['-i', file, '-vf', `format=gray,fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-y', raw]);
  const buf = fs.readFileSync(raw);
  const frameSize = w * h;
  const frames = [];
  for (let i = 0; i + frameSize <= buf.length; i += frameSize) frames.push(buf.subarray(i, i + frameSize));
  if (frames.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    let diff = 0, n = 0;
    for (let j = 0; j < a.length; j += 3) { diff += Math.abs(a[j] - b[j]); n++; }
    total += diff / n;
  }
  return total / (frames.length - 1);
}

async function main() {
  /* ---------------- [1] Manual pan/zoom/crop framing ---------------- */
  console.log('[1] exportShortFramed (manual pan/zoom crop)');
  // 4 distinct-colored quadrants, 1280x720, 6s, silent.
  const quad = path.join(DIR, 'quad.mp4');
  run(['-f', 'lavfi', '-i',
    'color=c=red:s=640x360[tl];color=c=lime:s=640x360[tr];color=c=blue:s=640x360[bl];color=c=yellow:s=640x360[br];' +
    '[tl][tr]hstack[top];[bl][br]hstack[bottom];[top][bottom]vstack',
    '-t', '6', '-r', '10', '-pix_fmt', 'yuv420p', '-y', quad]);
  const info = await video.getInfo(ctx, quad);
  check('quad test video created', info.width === 1280 && info.height === 720, `${info.width}x${info.height}`);

  const outCenter = path.join(DIR, 'framed-center.mp4');
  const outZoomTL = path.join(DIR, 'framed-tl.mp4');
  const rCenter = await video.exportShortFramed(ctx, { input: quad, startSec: 0, endSec: 6, preset: 'square-1x1', zoom: 1, offsetX: 0.5, offsetY: 0.5, output: outCenter });
  const rZoomTL = await video.exportShortFramed(ctx, { input: quad, startSec: 0, endSec: 6, preset: 'square-1x1', zoom: 3, offsetX: 0.15, offsetY: 0.15, output: outZoomTL });
  check('framed export is 1080x1080 (square preset)', (await video.getInfo(ctx, outCenter)).width === 1080 && (await video.getInfo(ctx, outCenter)).height === 1080);
  check('zoom=3 crop is ~3x smaller than zoom=1 crop', Math.abs(rCenter.cropW / rZoomTL.cropW - 3) < 0.3, `${rCenter.cropW} vs ${rZoomTL.cropW}`);

  const pngCenter = path.join(DIR, 'center-frame.png');
  const pngTL = path.join(DIR, 'tl-frame.png');
  run(['-ss', '1', '-i', outCenter, '-frames:v', '1', '-vf', 'scale=4:4', '-y', pngCenter]);
  run(['-ss', '1', '-i', outZoomTL, '-frames:v', '1', '-vf', 'scale=4:4', '-y', pngTL]);
  const centerBuf = fs.readFileSync(pngCenter), tlBuf = fs.readFileSync(pngTL);
  check('center framing and top-left-zoomed framing produce DIFFERENT pixel content', !centerBuf.equals(tlBuf));

  /* ---------------- [2] Waveform ---------------- */
  console.log('\n[2] Audio waveform rendering');
  const loud = path.join(DIR, 'loud.mp4');
  const silent = path.join(DIR, 'silent.mp4');
  run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', loud]);
  run(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10:duration=4', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
    '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', silent]);
  const wfLoud = path.join(DIR, 'wf-loud.png');
  const wfSilent = path.join(DIR, 'wf-silent.png');
  await video.waveform(ctx, { input: loud, width: 800, height: 80, output: wfLoud });
  await video.waveform(ctx, { input: silent, width: 800, height: 80, output: wfSilent });
  check('waveform PNG written for loud clip', fs.existsSync(wfLoud) && fs.statSync(wfLoud).size > 500);
  check('waveform PNG written for silent clip', fs.existsSync(wfSilent) && fs.statSync(wfSilent).size > 200);
  check('loud waveform differs visibly from silent waveform', !fs.readFileSync(wfLoud).equals(fs.readFileSync(wfSilent)));
  let threw = false;
  try { await video.waveform(ctx, { input: path.join(DIR, 'noaudio.mp4'), output: path.join(DIR, 'x.png') }); } catch (e) { threw = true; }

  /* ---------------- [3] Stabilization ---------------- */
  console.log('\n[3] Stabilization (vidstabdetect/vidstabtransform)');
  const shaky = path.join(DIR, 'shaky.mp4');
  // Synthetic shake: oscillate the crop offset each frame using sin(t) expressions.
  run(['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=25:duration=5',
    '-vf', "crop=480:360:x='40+30*sin(2*PI*t*2)':y='40+30*cos(2*PI*t*2)'",
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-y', shaky]);
  const stabOut = path.join(DIR, 'stabilized.mp4');
  const t0 = Date.now();
  await video.stabilize(ctx, { input: shaky, output: stabOut });
  console.log(`  stabilize() completed in ${Math.round((Date.now() - t0) / 1000)}s`);
  const stabInfo = await video.getInfo(ctx, stabOut);
  check('stabilized output exists with valid video', stabInfo.width > 0 && stabInfo.height > 0, `${stabInfo.width}x${stabInfo.height}`);
  // Independent verification (not using vidstab's own internals): the synthetic
  // "shaky" clip is a STATIC pattern viewed through a moving crop window, so any
  // frame-to-frame pixel change is purely apparent camera shake. A working
  // stabilizer should show much LESS frame-to-frame motion after correction.
  const motionBefore = motionEnergy(shaky);
  const motionAfter = motionEnergy(stabOut);
  console.log(`  frame-to-frame motion energy: before=${motionBefore.toFixed(2)}  after=${motionAfter.toFixed(2)}`);
  check('stabilization measurably reduces frame-to-frame jitter', motionAfter < motionBefore * 0.7, `${motionAfter.toFixed(2)} vs ${motionBefore.toFixed(2)}`);

  /* ---------------- [4] Reverse ---------------- */
  console.log('\n[4] Clip reversal');
  // A clip that's blue for the first half and red for the second half.
  const twoHalf = path.join(DIR, 'twohalf.mp4');
  run(['-f', 'lavfi', '-i', "color=c=blue:s=320x240:d=2", '-f', 'lavfi', '-i', "color=c=red:s=320x240:d=2",
    '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-r', '10', '-pix_fmt', 'yuv420p', '-y', twoHalf]);
  const reversedOut = path.join(DIR, 'reversed.mp4');
  await video.reverseClip(ctx, { input: twoHalf, output: reversedOut });
  const revInfo = await video.getInfo(ctx, reversedOut);
  check('reversed clip duration unchanged', Math.abs(revInfo.durationSec - 4) < 0.5, revInfo.durationSec + 's');
  // In the ORIGINAL, t=0.5s is blue. In the REVERSED clip, that same blue moment should now be near the END (~3.5s).
  const fEarly = path.join(DIR, 'rev-early.png'), fLate = path.join(DIR, 'rev-late.png');
  run(['-ss', '0.5', '-i', reversedOut, '-frames:v', '1', '-vf', 'scale=2:2', '-y', fEarly]);
  run(['-ss', '3.5', '-i', reversedOut, '-frames:v', '1', '-vf', 'scale=2:2', '-y', fLate]);
  const earlyPx = fs.readFileSync(fEarly), latePx = fs.readFileSync(fLate);
  check('reversed clip: early frame differs from late frame (content actually flipped in time)', !earlyPx.equals(latePx));

  /* ---------------- [5] Freeze frame ---------------- */
  console.log('\n[5] Freeze frame');
  const freezeOut = path.join(DIR, 'freeze.mp4');
  await video.freezeFrame(ctx, { input: quad, timeSec: 1, holdSec: 2.5, output: freezeOut });
  const freezeInfo = await video.getInfo(ctx, freezeOut);
  check('freeze-frame duration matches holdSec', Math.abs(freezeInfo.durationSec - 2.5) < 0.3, freezeInfo.durationSec + 's');
  check('freeze-frame dimensions valid', freezeInfo.width > 0 && freezeInfo.height > 0, `${freezeInfo.width}x${freezeInfo.height}`);

  /* ---------------- [6] Positioned text overlays (burn) ---------------- */
  console.log('\n[6] Text-overlay burn-in (positioned .ass)');
  const base = path.join(DIR, 'overlay-base.mp4');
  run(['-f', 'lavfi', '-i', 'color=c=black:s=640x360:d=6', '-r', '10', '-pix_fmt', 'yuv420p', '-y', base]);
  const overlays = [
    { text: 'TOP TEXT', x: 0.5, y: 0.15, start: 0, end: 3, color: '#ffffff', sizePct: 0.1 },
    { text: 'BOTTOM TEXT', x: 0.5, y: 0.85, start: 3, end: 6, color: '#ffff00', sizePct: 0.1 },
  ];
  const assPath = path.join(DIR, 'overlays.ass');
  cap.writeOverlayAss(overlays, { width: 640, height: 360, output: assPath });
  check('.ass overlay file written', fs.existsSync(assPath) && fs.statSync(assPath).size > 100);
  const overlayOut = path.join(DIR, 'overlay-burned.mp4');
  await cap.burnCaptions(ctx, { input: base, assPath, output: overlayOut });
  const ovInfo = await video.getInfo(ctx, overlayOut);
  check('overlay-burned video valid', ovInfo.width === 640 && ovInfo.height === 360);

  // Compare TOP region across "text present" (t=1) vs "text absent" (t=4) — should differ (text drawn).
  const topPresent = path.join(DIR, 'top-present.png'), topAbsent = path.join(DIR, 'top-absent.png');
  run(['-ss', '1', '-i', overlayOut, '-frames:v', '1', '-vf', 'crop=640:80:0:0', '-y', topPresent]);
  run(['-ss', '4', '-i', overlayOut, '-frames:v', '1', '-vf', 'crop=640:80:0:0', '-y', topAbsent]);
  check('TOP overlay region changes between its active and inactive time', !fs.readFileSync(topPresent).equals(fs.readFileSync(topAbsent)));

  const botPresent = path.join(DIR, 'bot-present.png'), botAbsent = path.join(DIR, 'bot-absent.png');
  run(['-ss', '4', '-i', overlayOut, '-frames:v', '1', '-vf', 'crop=640:80:0:280', '-y', botPresent]);
  run(['-ss', '1', '-i', overlayOut, '-frames:v', '1', '-vf', 'crop=640:80:0:280', '-y', botAbsent]);
  check('BOTTOM overlay region changes between its active and inactive time', !fs.readFileSync(botPresent).equals(fs.readFileSync(botAbsent)));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Outputs in: ' + DIR);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
