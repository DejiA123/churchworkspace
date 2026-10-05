'use strict';
/*
 * 🎛️ VIDEO QUALITY ON ONE CLIP, OR ON ALL OF THEM — real ffmpeg, no window.
 *
 * "I should be able to edit the video quality of just one clip in the
 * timeline, or all of them." A clip's look (filter, brightness, contrast,
 * saturation, sharpness, volume) rides on the clip, and every export route
 * carries it:
 *
 *   1. the recipe: anything left at "no change" is dropped;
 *   2. two halves of a split clip with different looks stay two pieces;
 *   3. an export of two clips: the black-and-white one comes out grey, the
 *      other keeps its colour — and the join is where the clips meet;
 *   4. one clip with a look still gets it (no cut needed);
 *   5. a clip added after the video (trim + append) carries its look and volume;
 *   6. frames pulled to track the speaker are never graded.
 *
 *   node test/clip-quality.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const video = require('../src/main/video');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipq-'));

/** Mean saturation (0..~180) and loudness of a stretch of a file. */
function sat(file, t) {
  try {
    const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.SATAVG', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /SATAVG=([\d.]+)/.exec(r.stderr || '');
    return m ? +m[1] : NaN;
  } catch (e) { return NaN; }
}
function loud(file, ss, t) {
  const r = require('child_process').spawnSync(ffmpeg, ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr || '');
  return m ? (m[1] === '-inf' ? -200 : +m[1]) : NaN;
}
const dur = (f) => +execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim();

(async () => {
  // a colourful source with a tone, 8 s
  const SRC = path.join(dir, 'src.mp4');
  execFileSync(ffmpeg, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });

  head('[1] The recipe drops what is left alone');
  check('all defaults = no look', video.clipFx({ look: '', bri: 0, con: 1, sat: 1, sharp: 0, vol: 1 }) === null);
  check('a changed value is kept, the rest dropped', JSON.stringify(video.clipFx({ look: 'warm', bri: 0, con: 1.2, sat: 1, vol: 1 })) === '{"look":"warm","con":1.2}');
  check('out-of-range numbers are held in range', video.clipFx({ bri: 5, vol: 9 }).bri === 0.3 && video.clipFx({ vol: 9 }).vol === 2);
  check('an unknown filter is ignored', video.clipFx({ look: 'rm -rf' }) === null);
  check('the picture recipe', video.fxVideo({ look: 'bw', sat: 1.3, sharp: 1 }) === 'hue=s=0,eq=saturation=1.3,unsharp=5:5:1.00:5:5:0', video.fxVideo({ look: 'bw', sat: 1.3, sharp: 1 }));
  check('the sound recipe', video.fxAudio({ vol: 0.5 }) === 'volume=0.5' && video.fxAudio({ look: 'bw' }) === '');

  head('[2] Two halves of a split clip with different looks stay two pieces');
  const two = video.normalizePieces([{ start: 0, end: 4, fx: { look: 'bw' } }, { start: 4, end: 8 }], 8);
  check('two pieces, not merged into one', two.length === 2 && two[0].fx && two[0].fx.look === 'bw' && !two[1].fx, JSON.stringify(two));
  const same = video.normalizePieces([{ start: 0, end: 4, fx: { look: 'bw' } }, { start: 4, end: 8, fx: { look: 'bw' } }], 8);
  check('…but the same look on both still joins up', same.length === 1 && same[0].fx.look === 'bw');
  const plain = video.normalizePieces([{ start: 0, end: 4 }, { start: 4, end: 8 }], 8);
  check('…and pieces with no look behave as they always did', plain.length === 1 && !plain[0].fx);

  head('[3] Export two clips: only the black-and-white one loses its colour');
  const OUT = path.join(dir, 'two.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: 0, endSec: 8, preset: 'source', pieces: [{ start: 0, end: 4, fx: { look: 'bw', vol: 0.25 } }, { start: 4, end: 8 }], output: OUT });
  const s1 = sat(OUT, 2), s2 = sat(OUT, 6);
  check('clip 1 is grey', s1 < 2, `saturation ${s1}`);
  check('clip 2 keeps its colour', s2 > 20, `saturation ${s2}`);
  check('the whole video is there', Math.abs(dur(OUT) - 8) < 0.2, dur(OUT).toFixed(2) + ' s');
  const l1 = loud(OUT, 0.5, 3), l2 = loud(OUT, 4.5, 3);
  check('clip 1 is quieter (25% volume ≈ -12 dB)', l2 - l1 > 9 && l2 - l1 < 15, `${l1} dB vs ${l2} dB`);

  head('[4] One clip, no cut, with a look');
  const plan = video.cutPlan([{ start: 1, end: 5, fx: { sat: 0 } }], { durationSec: 8, hasAudio: true });
  check('a single graded piece still gets a filter chain', plan && plan.chain && /eq=saturation=0/.test(plan.chain), plan && plan.chain);
  const OUT1 = path.join(dir, 'one.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: 1, endSec: 5, preset: 'source', pieces: [{ start: 1, end: 5, fx: { sat: 0 } }], output: OUT1 });
  check('…and the export is grey', sat(OUT1, 2) < 2, `saturation ${sat(OUT1, 2)}`);
  check('…and 4 s long', Math.abs(dur(OUT1) - 4) < 0.2, dur(OUT1).toFixed(2));
  const none = video.cutPlan([{ start: 1, end: 5 }], { durationSec: 8, hasAudio: true });
  check('with no look it is the plain trim it always was', none && none.chain === null);

  head('[5] A clip added after the video carries its look');
  const T = path.join(dir, 't.mp4');
  await video.trim(ctx, { input: SRC, startSec: 2, endSec: 4, fx: { look: 'bw', vol: 0 }, output: T });
  check('trim: grey', sat(T, 1) < 2, `saturation ${sat(T, 1)}`);
  check('trim: silent at volume 0', loud(T, 0, 2) < -80, loud(T, 0, 2) + ' dB');
  const BASE = path.join(dir, 'base.mp4');
  await video.trim(ctx, { input: SRC, startSec: 0, endSec: 3, output: BASE });
  const APP = path.join(dir, 'app.mp4');
  await video.appendClips(ctx, { input: BASE, clips: [{ path: SRC, fx: { look: 'bw' } }], position: 'end', fill: { mode: 'bars' }, output: APP });
  check('append: the video before keeps its colour', sat(APP, 1.5) > 20, `saturation ${sat(APP, 1.5)}`);
  check('append: the added clip is grey', sat(APP, 7) < 2, `saturation ${sat(APP, 7)}`);

  head('[6] Tracking frames are never graded');
  const tp = video.cutPlan([{ start: 0, end: 4, fx: { look: 'bw' } }, { start: 5, end: 8 }], { hasAudio: false, noFx: true });
  check('no grade in the tracking cut', tp && !/hue=s=0/.test(tp.chain || ''), tp && tp.chain);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
