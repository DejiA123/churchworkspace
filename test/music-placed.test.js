'use strict';
/*
 * A SONG PLACED ON THE TIMELINE COMES IN AND GOES OUT WHERE IT WAS PUT.
 * "I should be able to drag the purple audio track … shorten it and align it."
 * Once the song is trimmed or moved, the export has to honour it: the real
 * mixMusic, decoded back out and measured, second by second.
 *   [1] musicDelaySec 2 + musicDurSec 3 on a 10 s clip: silent 0-2 s, the song
 *       2-5 s, silent again 5-10 s — and the clip keeps its full length
 *   [2] nothing given: the song under the whole clip, as it always was
 *   [3] a clip with no sound of its own: still its full length (no cut-short video)
 *   node test/music-placed.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-placed-'));
const run = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args]);
// loudness of each second of the file's sound, in dB
function perSecond(file, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = spawnSync(ffmpeg, ['-v', 'info', '-ss', String(i + 0.15), '-t', '0.7', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr || '');
    out.push(m ? (m[1] === '-inf' ? -99 : +m[1]) : -99);
  }
  return out;
}
const durOf = (f) => +execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();
(async () => {
  try {
    const CLIP = path.join(W, 'clip.mp4'), MUTE = path.join(W, 'mute.mp4'), SONG = path.join(W, 'song.m4a');
    // a clip whose own sound is SILENT, so all that is heard is the song
    run(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=10', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CLIP]);
    run(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=25:d=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', MUTE]);
    run(['-f', 'lavfi', '-i', 'sine=f=440:d=30', '-c:a', 'aac', SONG]);

    const A = path.join(W, 'placed.mp4');
    await video.mixMusic(ctx, { input: CLIP, output: A, musicPath: SONG, musicVolume: 1, musicStartSec: 4, musicDelaySec: 2, musicDurSec: 3, fadeIn: 0, fadeOut: 0, duck: false });
    const a = perSecond(A, 10);
    const loud = (v) => v > -40, quiet = (v) => v < -60;
    check(quiet(a[0]) && quiet(a[1]) && loud(a[2]) && loud(a[3]) && loud(a[4]) && a.slice(5).every(quiet) && Math.abs(durOf(A) - 10) < 0.15,
      '[1] in at 2 s, out at 5 s — silent before and after, and the clip keeps all 10 s', { a, d: durOf(A) });

    const B = path.join(W, 'bed.mp4');
    await video.mixMusic(ctx, { input: CLIP, output: B, musicPath: SONG, musicVolume: 1, fadeIn: 0, fadeOut: 0, duck: false });
    const b = perSecond(B, 10);
    check(b.every(loud) && Math.abs(durOf(B) - 10) < 0.15, '[2] nothing placed: the song under the whole clip, as before', b);

    const C = path.join(W, 'mute-placed.mp4');
    await video.mixMusic(ctx, { input: MUTE, output: C, musicPath: SONG, musicVolume: 1, musicDelaySec: 6, musicDurSec: 2, fadeIn: 0, fadeOut: 0, duck: false });
    const c = perSecond(C, 10);
    check(Math.abs(durOf(C) - 10) < 0.15 && quiet(c[2]) && loud(c[6]) && loud(c[7]) && quiet(c[9]), '[3] a clip with no sound of its own keeps its full length too', { c, d: durOf(C) });
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally { try { fs.rmSync(W, { recursive: true, force: true }); } catch (e) {} }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
