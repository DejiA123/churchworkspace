'use strict';
/*
 * Runs the REAL video engine against the user's actual sermon file, proving the
 * pieces loadVideo()/split/export depend on all work on this specific video:
 *   - getInfo (duration/codec used to seed the timeline clip)
 *   - filmstrip (now painted INTO each clip block)
 *   - thumbnail (clip-list preview)
 *   - exportShort (what "Export" produces for a split clip range)
 * Run with:  node test/real-user-video.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const { sermonPath, noSermon } = require('./sermon');

const ctx = { ffmpeg, ffprobe };
const SRC = sermonPath(process.argv[2]);
const DIR = path.join(os.tmpdir(), 'mw-real-user-video');
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  -> ' + detail : '')); fail++; }
}
function pngSize(file) { const b = fs.readFileSync(file); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length }; }

(async () => {
  console.log('\nReal user video:', SRC);
  if (!SRC) { console.log(noSermon()); app && app.exit ? app.exit(0) : process.exit(0); return; }
  check('a real recording to measure against', !!SRC, SRC);

  // 1) getInfo — this is what seeds the "Full video" clip [0..durationSec].
  const info = await video.getInfo(ctx, SRC);
  console.log(`  info: ${info.width}x${info.height} ${info.durationLabel} ${info.fps}fps codec=${info.vcodec}`);
  check('getInfo returns a real duration', info.durationSec > 1, String(info.durationSec));
  check('getInfo returns dimensions', info.width > 0 && info.height > 0, `${info.width}x${info.height}`);

  // 2) filmstrip — painted inside each clip block on the timeline.
  const stripPath = path.join(DIR, 'strip.png');
  await video.filmstrip(ctx, { input: SRC, count: 24, output: stripPath });
  check('filmstrip renders a PNG', fs.existsSync(stripPath) && pngSize(stripPath).bytes > 1000, stripPath);

  // 3) thumbnail — used by the Shorts clip list.
  const thumb = await video.thumbnail(ctx, { input: SRC, timeSec: Math.min(5, info.durationSec / 2), output: path.join(DIR, 'thumb.png') });
  check('thumbnail renders a PNG', fs.existsSync(thumb) && pngSize(thumb).bytes > 1000, thumb);

  // 4) exportShort — exporting a SPLIT clip's range to a 9:16 short (core workflow).
  //    Use a short 4s range so the test is fast even on a ~1GB file.
  const a = Math.min(10, Math.max(0, info.durationSec - 6));
  const b = Math.min(info.durationSec, a + 4);
  const out = path.join(DIR, 'short.mp4');
  await video.exportShort(ctx, { input: SRC, startSec: a, endSec: b, preset: 'reel-9x16', output: out });
  check('exportShort produced a vertical clip', fs.existsSync(out), out);
  if (fs.existsSync(out)) {
    const oi = await video.getInfo(ctx, out);
    check('exported short is 9:16 (portrait)', oi.height > oi.width, `${oi.width}x${oi.height}`);
    check('exported short has real duration', oi.durationSec > 1, String(oi.durationSec));
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Outputs in: ' + DIR);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
