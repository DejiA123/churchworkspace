'use strict';
/*
 * End-to-end: sermon -> AI highlight -> exported 9:16 short -> per-range
 * transcription -> captions burned onto the SHORT (not the whole sermon).
 * Verifies caption timing aligns with the exported clip.
 * Usage: node test/short-captions.test.js "C:\\path\\to\\sermon.mp4"
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const cap = require('../src/main/captioner');
const highlights = require('../src/main/highlights');

const ctx = { ffmpeg, ffprobe };
const src = process.argv[2];
const OUT = process.env.MW_OUT || path.join(os.tmpdir(), 'mw-shortcap-test');
fs.mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  console.log('[1] AI picks highlights (AUTO length, viral scoring)');
  const t0 = Date.now();
  const res = await highlights.analyzeSermon(ctx, { input: src, minLen: 20, idealLen: 50, maxLen: 90, maxClips: 6, autoLen: true, onProgress: () => {} });
  console.log(`  ${res.clips.length} clips in ${Math.round((Date.now() - t0) / 1000)}s`);
  check('found clips', res.clips.length >= 3, res.clips.length + ' clips');
  const top = res.clips.slice().sort((a, b) => b.score - a.score)[0];
  console.log(`  top pick: ${Math.round(top.start)}s -> ${Math.round(top.end)}s (${top.durationSec}s, score ${top.score})`);

  console.log('\n[2] Export the top pick as a 9:16 short');
  const shortPath = path.join(OUT, 'short.mp4');
  const t1 = Date.now();
  await video.exportShort(ctx, { input: src, startSec: top.start, endSec: top.end, preset: 'reel-9x16', output: shortPath });
  const si = await video.getInfo(ctx, shortPath);
  check('short is 1080x1920', si.width === 1080 && si.height === 1920, `${si.width}x${si.height} in ${Math.round((Date.now() - t1) / 1000)}s`);

  console.log('\n[3] Transcribe ONLY the short\'s range (not the 72-min sermon)');
  const t2 = Date.now();
  const tr = await cap.transcribe(ctx, { input: src, startSec: top.start, endSec: top.end, onProgress: () => {} });
  const secs = Math.round((Date.now() - t2) / 1000);
  check('range transcription is FAST', secs < 180, secs + 's for a ' + Math.round(top.durationSec) + 's clip');
  check('got words', tr.words.length > 5, tr.words.length + ' words');
  const lastEnd = tr.words.length ? tr.words[tr.words.length - 1].end : 0;
  check('word times are clip-relative (within short duration)', lastEnd <= top.durationSec + 2, 'last word ends ' + lastEnd.toFixed(1) + 's vs clip ' + top.durationSec + 's');
  console.log('  first words: ' + tr.words.slice(0, 12).map((w) => w.text).join(' '));

  console.log('\n[4] Burn 2-words-per-line ALL-CAPS captions onto the short');
  const events = cap.buildCaptionEvents(tr.words, { wordsPerLine: 2, textCase: 'upper' });
  const ass = path.join(OUT, 'short.ass');
  cap.writeAss(events, { width: si.width, height: si.height, opts: { font: 'Anton', sizeKey: 'l', color: '#ffffff', position: 'bottom' }, output: ass });
  const capped = path.join(OUT, 'short-captioned.mp4');
  await cap.burnCaptions(ctx, { input: shortPath, assPath: ass, output: capped, onProgress: () => {} });
  const capI = await video.getInfo(ctx, capped);
  check('captioned short valid + same size', capI.width === 1080 && capI.height === 1920 && capI.hasAudio, `${capI.width}x${capI.height}`);

  // frame in the middle of an early caption to eyeball
  const ev = events.find((e) => e.end - e.start > 0.4) || events[0];
  const frame = path.join(OUT, 'short-cap-frame.png');
  spawnSync(ffmpeg, ['-ss', String((ev.start + ev.end) / 2), '-i', capped, '-frames:v', '1', '-y', frame], { encoding: 'utf-8' });
  check('caption frame extracted', fs.existsSync(frame), 'expect on screen: "' + ev.text + '"');

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Frame: ' + frame);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
