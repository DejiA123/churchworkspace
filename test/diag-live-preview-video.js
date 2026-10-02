'use strict';
/*
 * TURN THE LIVE PREVIEW INTO A FILE YOU CAN WATCH.
 *
 * test/live-preview-smooth.js already drives the real live tracker and the real
 * 60fps glide over real footage and writes the on-screen crop position for every
 * rendered frame into traces.json. This renders that trace back onto the source
 * as a 9:16 video — so "is the preview smooth, and is it on the speaker?" can be
 * answered by watching it, which on this footage has repeatedly been the only
 * trustworthy answer (the pose-verified reference the metrics use is itself
 * derived from the signals under test).
 *
 *   node test/diag-live-preview-video.js "<video>" <windowStartSec> [--traces=FILE] [--out=DIR]
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const argv = process.argv.slice(2);
const args = argv.filter((a) => !a.startsWith('--'));
const flags = Object.fromEntries(argv.filter((a) => a.startsWith('--')).map((a) => a.replace(/^--/, '').split('=')));
const input = args[0];
const winStart = Number(args[1]);
const TRACES = flags.traces || path.join(os.tmpdir(), 'mw-live-preview-smooth', 'traces.json');
const OUT = flags.out || path.join(os.tmpdir(), 'mw-live-preview-video');
fs.mkdirSync(OUT, { recursive: true });

const j = JSON.parse(fs.readFileSync(TRACES, 'utf8'));
const trace = j.traces['w' + winStart];
if (!trace) { console.log('no trace for window ' + winStart + ' in ' + TRACES); process.exit(1); }

(async () => {
  const info = await video.getInfo({ ffmpeg, ffprobe }, input);
  const half = j.cropHalfX;
  // The glide renders 13 frames between detection ticks; spread them evenly over
  // the tick interval so the keyframe times match what the eye saw.
  const kf = [];
  for (let i = 0; i < trace.length; i++) {
    const t0 = trace[i].t, t1 = i + 1 < trace.length ? trace[i + 1].t : t0 + (trace[1].t - trace[0].t);
    const rs = trace[i].renders || [trace[i].target];
    for (let k = 0; k < rs.length; k++) {
      kf.push({ t: t0 + (t1 - t0) * (k / rs.length), x: Math.round(rs[k] * info.width), y: Math.round(info.height / 2) });
    }
  }
  const dur = kf[kf.length - 1].t + 0.2;
  const out = path.join(OUT, 'live-' + winStart + '.mp4');
  await video.exportShortReframed({ ffmpeg, ffprobe }, {
    input, startSec: winStart, endSec: winStart + dur, preset: 'reel-9x16', keyframes: kf, output: out,
  });
  const sheet = path.join(OUT, 'live-' + winStart + '-sheet.jpg');
  execFileSync(ffmpeg, ['-v', 'error', '-i', out, '-vf', 'fps=1,scale=150:-1,tile=10x3', '-frames:v', '1', '-y', sheet]);
  console.log('  crop half-width ' + half.toFixed(4) + ', ' + kf.length + ' render positions over ' + dur.toFixed(1) + 's');
  console.log('  video: ' + out);
  console.log('  sheet: ' + sheet);
})().catch((e) => { console.log('FAILED: ' + ((e && e.stack) || e)); process.exit(1); });
