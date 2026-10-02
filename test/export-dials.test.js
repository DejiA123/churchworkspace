'use strict';
/*
 * CapCut's export dials, measured on real exports: the frame rate the file
 * actually has, the 480p size, and that Lower / Recommended / Higher bitrate
 * really make smaller and larger files of the same short.
 *
 *   node test/export-dials.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-export-dials');
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};
const probe = (f) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', f]).toString()).streams[0];
const rate = (s) => { const [a, b] = s.r_frame_rate.split('/').map(Number); return a / (b || 1); };

(async () => {
  const src = path.join(WORK, 'src.mp4');
  if (!fs.existsSync(src)) {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8',
      '-f', 'lavfi', '-i', 'sine=f=220:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', src]);
  }
  const out = (name) => path.join(WORK, name + '.mp4');
  const short = (name, quality = '720p') => video.exportShort(ctx, { input: src, startSec: 1, endSec: 6, preset: 'reel-9x16', quality, output: out(name), onProgress: () => {} });

  video.setExportPrefs({});
  await short('default');
  log(Math.round(rate(probe(out('default')))) === 30, 'no choice keeps the recording\'s own 30 fps', String(rate(probe(out('default')))));

  for (const fps of [24, 60]) {
    video.setExportPrefs({ fps });
    await short('fps' + fps);
    const r = rate(probe(out('fps' + fps)));
    log(Math.round(r) === fps, `${fps} fps chosen → the file is ${fps} fps`, String(r));
  }

  video.setExportPrefs({ fps: 0 });
  await short('p480', '480p');
  const s480 = probe(out('p480'));
  log(s480.width === 480 && s480.height === 854, '480p makes a 480×854 short', `${s480.width}x${s480.height}`);

  const size = {};
  for (const r of ['lower', 'recommended', 'higher']) {
    video.setExportPrefs({ rate: r });
    await short('rate-' + r);
    size[r] = fs.statSync(out('rate-' + r)).size;
  }
  log(size.lower < size.recommended && size.recommended < size.higher,
    'Lower < Recommended < Higher bitrate, same short', `${(size.lower / 1024).toFixed(0)} KB < ${(size.recommended / 1024).toFixed(0)} KB < ${(size.higher / 1024).toFixed(0)} KB`);

  video.setExportPrefs({ fps: 17, rate: 'loud' });
  const p = video.getExportPrefs();
  log(p.fps === 0 && p.rate === 'recommended', 'nonsense is refused, not passed to ffmpeg', JSON.stringify(p));
  video.setExportPrefs({});

  console.log(failed ? '\n❌ export dials test failed' : '\n✅ export dials test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
