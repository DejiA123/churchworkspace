'use strict';
/*
 * THE PICTURE PEOPLE SEE BEFORE THEY PRESS PLAY.
 *
 * Left alone, every platform picks its own thumbnail and almost always lands on
 * the first frame. This checks the two halves of letting the operator choose it
 * instead: the engine (does a JPEG of the RIGHT MOMENT appear beside the short,
 * is it carried inside the file, is the video itself left alone) and the studio
 * (is there a button on every short, does scrubbing pick a moment, does the
 * choice survive being saved into a session).
 *
 *   node test/thumbnail.test.js            — the engine
 *   npx electron test/thumbnail.test.js    — the engine AND the studio
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const OUT = path.join(os.tmpdir(), 'mw-thumbnail-test');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const SRC = path.join(OUT, 'short.mp4');
const PIC = path.join(OUT, 'my-cover.png');

/** The mean colour of a still, so "which second is this frame from" is answerable. */
function meanColour(png) {
  const out = execFileSync(ffmpeg, ['-v', 'error', '-i', png, '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf-8' });
  const g = (k) => { const m = new RegExp('lavfi\\.signalstats\\.' + k + '=([\\d.]+)').exec(out); return m ? +m[1] : null; };
  return { y: g('YAVG'), u: g('UAVG'), v: g('VAVG') };
}
function streams(mp4) {
  // -show_streams, not -show_entries: asking for `disposition=attached_pic`
  // returns the field name but not the disposition object, so the flag reads as
  // undefined and a check on it passes or fails for the wrong reason.
  const out = execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', mp4], { encoding: 'utf-8' });
  return JSON.parse(out).streams || [];
}

(async () => {
  console.log('\n[1] A short whose colour changes second by second');
  // three flat colours in a row, so the frame at 1s, 3s and 5s are unmistakably
  // different pictures and "did it take the right one" has an exact answer
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '2', '-i', 'color=c=red:s=540x960:r=25',
    '-f', 'lavfi', '-t', '2', '-i', 'color=c=green:s=540x960:r=25',
    '-f', 'lavfi', '-t', '2', '-i', 'color=c=blue:s=540x960:r=25',
    '-f', 'lavfi', '-t', '6', '-i', 'sine=frequency=440:sample_rate=44100',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
  const info = await video.getInfo(ctx, SRC);
  check('the test short exists', fs.existsSync(SRC) && info.width === 540, info.width + 'x' + info.height + ' ' + info.durationSec.toFixed(1) + 's');
  const before = fs.statSync(SRC).size;

  console.log('\n[2] A frame chosen from the middle of it');
  const work = path.join(OUT, 'a.mp4');
  fs.copyFileSync(SRC, work);
  const r = await video.attachThumbnail(ctx, { input: work, atSec: 3 });
  check('a JPEG appears beside the short', !!r.image && fs.existsSync(r.image), path.basename(String(r.image)));
  check('and it is named after it', path.basename(r.image) === 'a.jpg', path.basename(r.image));
  const green = meanColour(r.image);
  // green in this colour space: low U, low V. red is high V; blue is high U.
  check('it is the frame at the second that was asked for, not the first',
    green.v < 128 && green.u < 128, `Y ${green.y} U ${green.u} V ${green.v}`);

  console.log('\n[3] The same picture is carried inside the file');
  const st = streams(work);
  const cover = st.filter((x) => x.disposition && x.disposition.attached_pic === 1);
  check('the MP4 now has cover art', cover.length === 1, JSON.stringify(st.map((x) => x.codec_type + ':' + x.codec_name)));
  check('the video and audio are still there', st.some((x) => x.codec_type === 'video' && x.codec_name === 'h264')
    && st.some((x) => x.codec_type === 'audio'), st.length + ' streams');
  const after = await video.getInfo(ctx, work);
  check('the short is the same length as before (give or take the 0.1 s picture)', Math.abs(after.durationSec - info.durationSec) < 0.2,
    info.durationSec.toFixed(2) + 's -> ' + after.durationSec.toFixed(2) + 's');
  /*
   * THE PICTURE IS THE FIRST FRAME. The iPhone's Photos app ignores cover art and
   * shows the first frame, so "I set the thumbnail and the export shows a
   * different one" — the chosen picture is now also the first 0.1 s of the video
   * (which is why it is re-encoded once, and 0.1 s longer).
   */
  const first = path.join(OUT, 'first-frame.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', work, '-map', '0:v:0', '-frames:v', '1', first]);
  const f0 = meanColour(first);
  check('the first frame of the video IS the chosen picture (green, not the red the short starts on)',
    f0.v < 128 && f0.u < 128, `Y ${f0.y} U ${f0.u} V ${f0.v}`);
  const at1 = path.join(OUT, 'at-0.5.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', '0.5', '-i', work, '-map', '0:v:0', '-frames:v', '1', at1]);
  const f1 = meanColour(at1);
  check('…for a blink only: half a second in, the short is itself again (red)', f1.v > 160, `Y ${f1.y} U ${f1.u} V ${f1.v}`);
  check('the sound moves with the picture: 0.1 s longer, no more', after.durationSec - info.durationSec > 0.05 && after.durationSec - info.durationSec < 0.2,
    (after.durationSec - info.durationSec).toFixed(3) + ' s');

  console.log('\n[4] A picture the operator made themselves');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=yellow:s=800x800', '-frames:v', '1', PIC]);
  const work2 = path.join(OUT, 'b.mp4');
  fs.copyFileSync(SRC, work2);
  const r2 = await video.attachThumbnail(ctx, { input: work2, imagePath: PIC });
  const yellow = meanColour(r2.image);
  check('their picture is what got used', yellow.v > 120 && yellow.u < 60, `Y ${yellow.y} U ${yellow.u} V ${yellow.v}`);
  const dims = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', r2.image], { encoding: 'utf-8' }).trim();
  check('and it was fitted to the short’s shape, not left square', dims === '540,960', dims);

  console.log('\n[5] It never costs you the export');
  const work3 = path.join(OUT, 'c.mp4');
  fs.copyFileSync(SRC, work3);
  let threw = null;
  try { await video.attachThumbnail(ctx, { input: work3, imagePath: path.join(OUT, 'does-not-exist.png'), atSec: 1 }); } catch (e) { threw = e.message; }
  check('a missing picture falls back to a frame rather than failing', threw === null, threw || 'no error');
  check('and a JPEG still came out', fs.existsSync(path.join(OUT, 'c.jpg')));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
