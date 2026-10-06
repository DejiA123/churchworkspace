'use strict';
/*
 * THE CAPTION TRACK, SENT AHEAD IN BATCHES.
 *
 * A phone used to hold every caption picture of an export and send them in one
 * request — on a ten-minute video that white-screened the iPhone. Now the
 * distinct pictures go to the studio a batch at a time (captions:trackPut) and
 * the burn names them by index. This proves the studio side of that contract:
 *
 *   [1] batches land on disk, under a folder named for the track
 *   [2] a burn made of references (plus inline frames and gaps) works, and the
 *       captions really are in the picture
 *   [3] the track's folder is gone afterwards
 *   [4] a track id that is not a plain token never becomes a path
 *
 *   node test/caption-track-stream.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require(path.join(__dirname, '..', 'src', 'main', 'video'));

const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null ? '  -> ' + d : ''}`); };

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-trkstream-'));
  const input = path.join(work, 'in.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=360x640:r=30:d=3',
    '-f', 'lavfi', '-i', 'sine=f=440:d=3', '-shortest', '-pix_fmt', 'yuv420p', '-y', input]);
  // a 200x60 opaque white picture, made by ffmpeg so no image library is needed
  const pic = (c) => {
    const p = path.join(work, c + '.png');
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${c}:s=200x60`, '-frames:v', '1', '-y', p]);
    return new Uint8Array(fs.readFileSync(p));
  };
  const white = pic('white'), red = pic('red');

  console.log('\n[1] batches land on disk');
  const trackId = 'ttest' + Date.now().toString(36);
  video.putTrackFrames({ trackId, pngs: [{ i: 0, png: white }] });
  video.putTrackFrames({ trackId, pngs: [{ i: 1, png: red }] });
  const dir = path.join(os.tmpdir(), 'mw-captrack-' + trackId);
  ok(fs.existsSync(path.join(dir, 'u0.png')) && fs.existsSync(path.join(dir, 'u1.png')), 'both batches are in the track folder');

  console.log('\n[2] a burn made of references');
  const track = {
    trackId, fps: 30, authorW: 360, authorH: 640, band: { x: 80, y: 500, w: 200, h: 60 },
    frames: [{ ref: 0, dur: 1 }, { png: null, dur: 0.5 }, { ref: 1, dur: 0.5 }, { ref: 0, dur: 1 }],
  };
  const output = path.join(work, 'out.mp4');
  await video.burnCaptionTrack(ctx, { input, track, output });
  ok(fs.existsSync(output) && fs.statSync(output).size > 1000, 'the burn finished');
  const at = (t) => execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', output, '-frames:v', '1',
    '-vf', 'crop=200:60:80:500,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const px = (b) => Array.from(b).join(',');
  const w = at(0.5), gap = at(1.2), r = at(1.75);
  ok(w[0] > 200 && w[1] > 200, 'a referenced picture is in the frame', px(w));
  ok(gap[0] < 40, 'the gap between lines is clear', px(gap));
  ok(r[0] > 150 && r[1] < 90, 'the second referenced picture is in at its time', px(r));

  console.log('\n[3] tidied afterwards');
  ok(!fs.existsSync(dir), 'the track folder is removed after the burn');

  console.log('\n[4] a bad id never becomes a path');
  let threw = false;
  try { video.putTrackFrames({ trackId: '../../etc', pngs: [{ i: 0, png: white }] }); } catch (e) { threw = true; }
  ok(threw, 'a track id with a path in it is refused');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
