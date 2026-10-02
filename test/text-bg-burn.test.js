'use strict';
/*
 * Proves the ⬛ black-backing text option survives EXPORT: writes the .ass with a
 * bg overlay, burns it onto a real clip, and extracts a frame to eyeball.
 * Run:  node test/text-bg-burn.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const cap = require('../src/main/captioner');
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const CLIP = 'C:/Users/dejia/AppData/Local/Temp/mw-clip8.mp4';
const DIR = path.join(os.tmpdir(), 'mw-textbg-test');
fs.mkdirSync(DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  check('real clip exists', fs.existsSync(CLIP));
  const info = await video.getInfo(ctx, CLIP);

  // 1) .ass generation: bg overlay must use the opaque-box style.
  const ass = path.join(DIR, 'ovl.ass');
  cap.writeOverlayAss([
    { text: 'STAND OUT', x: 0.5, y: 0.25, start: 0, end: 8, sizePct: 0.12, color: '#ffffff', bold: true, bg: true },
    { text: 'no backing', x: 0.5, y: 0.75, start: 0, end: 8, sizePct: 0.08, color: '#ffe600', bold: true },
  ], { width: info.width, height: info.height, output: ass });
  const assTxt = fs.readFileSync(ass, 'utf-8');
  check('.ass defines the opaque-box style (BorderStyle 3)', /Style: OvlBox,[^\n]*,3,2,1,5,/.test(assTxt));
  check('bg overlay uses the OvlBox style', /Dialogue: 0,[^,]*,[^,]*,OvlBox,/.test(assTxt));
  check('plain overlay still uses the normal style', /Dialogue: 0,[^,]*,[^,]*,Ovl,/.test(assTxt));

  // 2) burn onto the real clip and extract a frame during the overlay window.
  const out = path.join(DIR, 'burned.mp4');
  await cap.burnCaptions(ctx, { input: CLIP, assPath: ass, output: out });
  check('burned video produced', fs.existsSync(out) && fs.statSync(out).size > 10000);
  const frame = path.join(DIR, 'frame4s.png');
  spawnSync(ffmpeg, ['-ss', '4', '-i', out, '-frames:v', '1', '-y', frame], { encoding: 'utf-8' });
  check('frame extracted for eyeballing', fs.existsSync(frame) && fs.statSync(frame).size > 1000, frame);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Eyeball: ' + frame);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); process.exit(1); });
