'use strict';
/*
 * Tests auto-caption transcription + burn-in on a real video.
 * Usage: node test/captions.test.js "C:\\path\\to\\video.mp4"
 * Set MW_OUT to control the output dir (used to view the captioned frame).
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
const input = process.argv[2];
const OUT = process.env.MW_OUT || path.join(os.tmpdir(), 'mw-cap-test');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  check('speech engine + model available', cap.isAvailable());
  if (!cap.isAvailable()) { console.log('  (whisper.cpp binary or model missing)'); process.exit(1); }

  console.log('\n[1] Transcribe FULL video (accuracy eyeball)');
  const t0 = Date.now();
  const full = await cap.transcribe(ctx, { input, onProgress: () => {} });
  const secs = Math.round((Date.now() - t0) / 1000);
  const vinfo = await video.getInfo(ctx, input);
  console.log(`  ${full.segments.length} segments in ${secs}s (video is ${Math.round(vinfo.durationSec)}s => ${(vinfo.durationSec / secs).toFixed(1)}x realtime)\n`);
  full.segments.forEach((s) => console.log(`     [${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text}`));
  check('produced transcript segments', full.segments.length > 0, full.segments.length + ' segments');
  check('segments have text + valid timing', full.segments.every((s) => s.text.length > 0 && s.end > s.start));

  // Pick a short window with speech for the burn test.
  const seg = full.segments.find((s) => s.end - s.start >= 1.2) || full.segments[0];
  const winStart = Math.max(0, seg.start - 1);
  const winDur = Math.min(14, vinfo.durationSec - winStart);

  console.log(`\n[2] Make a short H.264 test clip (${winStart.toFixed(1)}s +${winDur.toFixed(1)}s) & re-transcribe`);
  const clip = path.join(OUT, 'clip.mp4');
  let r = spawnSync(ffmpeg, ['-ss', String(winStart), '-i', input, '-t', String(winDur),
    '-vf', 'scale=-2:1280', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-y', clip], { encoding: 'utf-8' });
  if (r.status !== 0) { console.error(r.stderr.slice(-800)); process.exit(1); }
  const cinfo = await video.getInfo(ctx, clip);
  const clipT = await cap.transcribe(ctx, { input: clip, onProgress: () => {} });
  check('clip transcribed', clipT.segments.length > 0, clipT.segments.map((s) => s.text).join(' | '));

  console.log('\n[3] Build styled .ass + burn captions into the clip');
  const ass = path.join(OUT, 'caps.ass');
  cap.writeAss(clipT.segments, { width: cinfo.width, height: cinfo.height, styleName: 'bold', output: ass });
  check('.ass written', fs.existsSync(ass) && fs.statSync(ass).size > 200);
  const capped = path.join(OUT, 'captioned.mp4');
  await cap.burnCaptions(ctx, { input: clip, assPath: ass, output: capped, onProgress: () => {} });
  const capInfo = await video.getInfo(ctx, capped);
  check('captioned video written & valid', fs.existsSync(capped) && capInfo.width === cinfo.width, `${capInfo.width}x${capInfo.height}`);

  // Extract a frame where a caption should be visible, so we can SEE the overlay.
  const capSeg = clipT.segments[0];
  const frameT = (capSeg.start + capSeg.end) / 2;
  const frame = path.join(OUT, 'captioned-frame.png');
  spawnSync(ffmpeg, ['-ss', String(frameT), '-i', capped, '-frames:v', '1', '-y', frame], { encoding: 'utf-8' });
  check('captioned frame extracted for review', fs.existsSync(frame), frame);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Review frame: ' + frame);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
