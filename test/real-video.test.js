'use strict';
/*
 * Runs the FULL sermon->shorts pipeline on a real user video.
 * Usage: node test/real-video.test.js "C:\\path\\to\\video.mp4"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const highlights = require('../src/main/highlights');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
if (!input || !fs.existsSync(input)) { console.error('File not found: ' + input); process.exit(1); }
const OUT = process.env.MW_OUT || path.join(os.tmpdir(), 'mw-real-test');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  console.log('\n[1] Probe');
  const info = await video.getInfo(ctx, input);
  console.log('  ', JSON.stringify({ dur: info.durationLabel, res: info.width + 'x' + info.height, fps: info.fps, audio: info.hasAudio, codec: info.vcodec + '/' + info.acodec, sizeMB: Math.round(info.sizeBytes / 1e6) }));
  check('has video dimensions', info.width > 0 && info.height > 0);
  check('has an audio track (needed for AI highlights)', info.hasAudio, info.hasAudio ? 'yes' : 'NO AUDIO');

  console.log('\n[2] Filmstrip (timeline thumbnails)');
  const strip = path.join(OUT, 'strip.png');
  const t0 = Date.now();
  await video.filmstrip(ctx, { input, count: 24, output: strip });
  check('filmstrip generated', fs.existsSync(strip) && fs.statSync(strip).size > 1000, Math.round((Date.now() - t0) / 1000) + 's, ' + Math.round(fs.statSync(strip).size / 1024) + 'KB');

  console.log('\n[3] AI highlight analysis');
  const ta = Date.now();
  let res;
  try {
    res = await highlights.analyzeSermon(ctx, { input, minLen: 15, maxLen: 60, idealLen: 30, maxClips: 8, onProgress: () => {} });
  } catch (e) {
    check('analysis ran', false, e.message);
    console.log(`\n  (No audio / speech means the AI highlight finder can't run — that's expected for silent clips.)`);
    finish(); return;
  }
  console.log('  meta:', JSON.stringify(res.meta), ` (${Math.round((Date.now() - ta) / 1000)}s)`);
  console.log('  clips:');
  res.clips.forEach((c) => console.log(`     #${c.rank}  ${video.hms(c.start)} → ${video.hms(c.end)}  (${c.durationSec}s)  score ${c.score}`));
  check('analysis produced clips', res.clips.length > 0, res.clips.length + ' clips');
  check('clips are within [15,60]s', res.clips.every((c) => c.durationSec >= 14 && c.durationSec <= 61));
  const sorted = res.clips.slice().sort((a, b) => a.start - b.start);
  let nonOverlap = true;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) nonOverlap = false;
  check('clips do not overlap', nonOverlap);
  check('clips are inside the video duration', res.clips.every((c) => c.end <= info.durationSec + 0.5));

  if (res.clips.length) {
    console.log('\n[4] Export first highlight as a 9:16 short');
    const te = Date.now();
    const c = res.clips[0];
    const out = path.join(OUT, 'short-1.mp4');
    await video.exportShort(ctx, { input, startSec: c.start, endSec: c.end, preset: 'reel-9x16', output: out });
    const oi = await video.getInfo(ctx, out);
    check('short is 1080x1920 vertical', oi.width === 1080 && oi.height === 1920, `${oi.width}x${oi.height}`);
    check('short duration matches clip', Math.abs(oi.durationSec - c.durationSec) < 1.6, oi.durationSec + 's vs ' + c.durationSec + 's');
    check('short has audio', oi.hasAudio, '');
    console.log(`  exported in ${Math.round((Date.now() - te) / 1000)}s -> ${out}`);
  }
  finish();

  function finish() {
    console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
    console.log('Outputs: ' + OUT);
    process.exit(fail === 0 ? 0 : 1);
  }
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
