'use strict';
/*
 * Headless test of the video engine. Generates a synthetic clip with a known
 * silent gap, then exercises every ffmpeg operation and verifies the outputs.
 * Run with:  npm run test:engine
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const DIR = path.join(os.tmpdir(), 'mw-engine-test');
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  -> ' + detail : '')); fail++; }
}

function gen(file, color, dur, withGap) {
  const args = [
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${dur}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
  ];
  if (withGap) args.push('-af', "volume=enable='between(t,2,4)':volume=0");
  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest', '-y', file);
  const r = spawnSync(ffmpeg, args, { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('gen failed: ' + (r.stderr || '').slice(-500));
}

(async () => {
  console.log('Resolving binaries…');
  console.log('  ffmpeg:  ' + ffmpeg);
  console.log('  ffprobe: ' + ffprobe);
  check('ffmpeg binary exists', fs.existsSync(ffmpeg));
  check('ffprobe binary exists', fs.existsSync(ffprobe));

  const inA = path.join(DIR, 'in_a.mp4');
  const inB = path.join(DIR, 'in_b.mp4');
  console.log('\nGenerating test clips…');
  gen(inA, 'blue', 6, true);   // 6s with a silent gap from 2s–4s
  gen(inB, 'red', 3, false);   // 3s continuous tone

  console.log('\n[1] getInfo');
  const info = await video.getInfo(ctx, inA);
  check('duration ~6s', Math.abs(info.durationSec - 6) < 0.6, info.durationSec);
  check('has audio', info.hasAudio === true);
  check('width 640', info.width === 640, info.width);

  console.log('\n[2] trim (1s–3s)');
  const trimmed = path.join(DIR, 'trim.mp4');
  await video.trim(ctx, { input: inA, startSec: 1, endSec: 3, output: trimmed });
  const tInfo = await video.getInfo(ctx, trimmed);
  check('trim output exists', fs.existsSync(trimmed));
  check('trim duration ~2s', Math.abs(tInfo.durationSec - 2) < 0.4, tInfo.durationSec);

  console.log('\n[3] exportForPlatform (reel 9:16)');
  const reel = path.join(DIR, 'reel.mp4');
  await video.exportForPlatform(ctx, { input: inA, preset: 'reel-9x16', output: reel });
  const rInfo = await video.getInfo(ctx, reel);
  check('export is 1080x1920', rInfo.width === 1080 && rInfo.height === 1920, `${rInfo.width}x${rInfo.height}`);

  console.log('\n[4] autoTrimSilence');
  const cut = path.join(DIR, 'cut.mp4');
  const res = await video.autoTrimSilence(ctx, { input: inA, output: cut, noiseDb: -30, minSilenceSec: 0.5 });
  const cInfo = await video.getInfo(ctx, cut);
  check('auto-cut output exists', fs.existsSync(cut));
  check('removed ~2s of silence', res.removedSeconds >= 1.0, res.removedSeconds + 's');
  check('result shorter than original', cInfo.durationSec < info.durationSec - 1, cInfo.durationSec);

  console.log('\n[5] extractAudio');
  const mp3 = path.join(DIR, 'audio.mp3');
  await video.extractAudio(ctx, { input: inA, output: mp3 });
  check('mp3 exists & non-empty', fs.existsSync(mp3) && fs.statSync(mp3).size > 1000);

  console.log('\n[6] merge (6s + 3s)');
  const merged = path.join(DIR, 'merged.mp4');
  await video.merge(ctx, { inputs: [inA, inB], output: merged });
  const mInfo = await video.getInfo(ctx, merged);
  check('merged exists', fs.existsSync(merged));
  check('merged duration ~9s', Math.abs(mInfo.durationSec - 9) < 1.0, mInfo.durationSec);

  console.log('\n[7] addCaptions (.srt mux)');
  const srt = path.join(DIR, 'caps.srt');
  fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:02,000\nHello church!\n\n2\n00:00:02,500 --> 00:00:05,000\nWelcome.\n');
  const capped = path.join(DIR, 'capped.mp4');
  await video.addCaptions(ctx, { input: inA, srt, output: capped });
  check('captioned output exists', fs.existsSync(capped));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Outputs in: ' + DIR);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message); process.exit(1); });
