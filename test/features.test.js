'use strict';
/*
 * Tests the new features (effects + caption customization) on a real clip.
 * Usage: node test/features.test.js "C:\\path\\to\\sermon.mp4"
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
const src = process.argv[2];
const OUT = process.env.MW_OUT || path.join(os.tmpdir(), 'mw-feat-test');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  console.log('Making a 12s H.264 test clip from the sermon...');
  const clip = path.join(OUT, 'clip.mp4');
  let r = spawnSync(ffmpeg, ['-ss', '60', '-i', src, '-t', '12', '-vf', 'scale=-2:720', '-r', '30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-y', clip], { encoding: 'utf-8' });
  if (r.status !== 0) { console.error((r.stderr || '').slice(-800)); process.exit(1); }
  const ci = await video.getInfo(ctx, clip);
  console.log('  clip:', ci.width + 'x' + ci.height, ci.durationLabel, '\n');

  // ---------- EFFECTS ----------
  console.log('[A] Effects (applyEdits)');
  const spd = path.join(OUT, 'fx-speed.mp4');
  await video.applyEdits(ctx, { input: clip, output: spd, edits: { speed: 2 } });
  const spdI = await video.getInfo(ctx, spd);
  check('speed 2x halves duration', Math.abs(spdI.durationSec - ci.durationSec / 2) < 1.2, spdI.durationSec.toFixed(1) + 's');

  const rot = path.join(OUT, 'fx-rot.mp4');
  await video.applyEdits(ctx, { input: clip, output: rot, edits: { rotate: 90 } });
  const rotI = await video.getInfo(ctx, rot);
  check('rotate 90 swaps dimensions', rotI.width === ci.height && rotI.height === ci.width, `${rotI.width}x${rotI.height}`);

  const music = path.join(OUT, 'music.m4a');
  spawnSync(ffmpeg, ['-f', 'lavfi', '-i', 'sine=frequency=330:duration=8', '-c:a', 'aac', '-y', music], { encoding: 'utf-8' });
  const fx = path.join(OUT, 'fx-look-music.mp4');
  await video.applyEdits(ctx, { input: clip, output: fx, edits: { look: 'bw', saturation: 1.2, brightness: 0.05, contrast: 1.1, volume: 0.8, musicPath: music, musicVolume: 0.25, fadeIn: 0.5, fadeOut: 0.5 } });
  const fxI = await video.getInfo(ctx, fx);
  check('look+music+grade+fade renders with audio', fs.existsSync(fx) && fxI.hasAudio && fxI.width === ci.width, `${fxI.width}x${fxI.height} audio:${fxI.hasAudio}`);

  // ---------- CAPTIONS customization ----------
  console.log('\n[B] Caption customization');
  if (!cap.isAvailable()) { check('speech engine available', false); }
  else {
    const t = await cap.transcribe(ctx, { input: clip, onProgress: () => {} });
    check('word-level transcription', t.words.length > 0, t.words.length + ' words');

    const e1 = cap.buildCaptionEvents(t.words, { wordsPerLine: 1 });
    const e3 = cap.buildCaptionEvents(t.words, { wordsPerLine: 3, textCase: 'upper' });
    check('words-per-line grouping works', e1.length > e3.length, `1/line=${e1.length}  3/line=${e3.length}`);
    check('ALL CAPS case applied', e3.every((s) => s.text === s.text.toUpperCase()), e3[0] && e3[0].text);
    check('2-word grouping ~ half of 1-word', Math.abs(cap.buildCaptionEvents(t.words, { wordsPerLine: 2 }).length - Math.ceil(e1.length / 2)) <= 1);

    // burn with a bundled font (Anton), yellow, large, ALL CAPS
    const ass = path.join(OUT, 'caps.ass');
    cap.writeAss(e3, { width: ci.width, height: ci.height, opts: { font: 'Anton', sizeKey: 'l', color: '#ffe600', position: 'bottom' }, output: ass });
    check('.ass uses selected font', fs.readFileSync(ass, 'utf-8').includes('Anton'));
    const capped = path.join(OUT, 'captioned-styled.mp4');
    await cap.burnCaptions(ctx, { input: clip, assPath: ass, output: capped, onProgress: () => {} });
    check('styled captions burned', fs.existsSync(capped) && fs.statSync(capped).size > 10000);

    const frameT = e3[0] ? (e3[0].start + e3[0].end) / 2 : 1;
    const frame = path.join(OUT, 'styled-frame.png');
    spawnSync(ffmpeg, ['-ss', String(frameT), '-i', capped, '-frames:v', '1', '-y', frame], { encoding: 'utf-8' });
    check('styled caption frame extracted', fs.existsSync(frame), frame);
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Outputs: ' + OUT);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
