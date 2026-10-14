'use strict';
/*
 * The AI's thumbnail pick (src/main/autothumb.js), without the AI: a short
 * whose first part is blurred, then black, then sharp, must get its thumbnail
 * from the sharp part — never the first frame, never the blur or the black —
 * and attachThumbnail must say what it picked.
 *   node test/autothumb.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');
const at = require('../src/main/autothumb');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); c ? pass++ : fail++; };

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-autothumb-'));
  const ctx = { ffmpeg, ffprobe };
  const src = path.join(dir, 'short.mp4');
  // 0-4 s blurred, 4-8 s black, 8-12 s sharp
  execFileSync(ffmpeg, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=4',
    '-f', 'lavfi', '-i', 'color=c=black:s=540x960:r=30:d=4',
    '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=4',
    '-filter_complex', '[0:v]boxblur=20[a];[a][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
  const r = await at.pickMoment(ctx, { input: src, searchEnd: 12 });
  check('the pick is in the sharp part, not the blur, the black or the first frame', r.atSec >= 8 && r.atSec <= 12, r);
  const r2 = await at.pickMoment(ctx, { input: src, searchEnd: 6 });
  check('…and it never looks past the end it is given (the ending card comes after it)', r2.atSec <= 6, r2);
  const res = await video.attachThumbnail(ctx, { input: src, auto: true, searchEnd: 12 });
  check('attachThumbnail with auto writes the picture and says what it picked', fs.existsSync(res.image) && res.picked && res.picked.atSec >= 8, res.picked);
  try { require('../src/main/persondetect').stop(); } catch (e) {}
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
