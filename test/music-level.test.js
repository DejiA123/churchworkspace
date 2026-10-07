'use strict';
/*
 * 100% MEANS LOUD, FOR EVERY SONG — and the preview plays what the export mixes.
 *
 * The owner's words: "The background music is too low even when set to 100!
 * Ensure the video preview is actually playing how the exporting clip with the
 * background music on it will be!"
 *
 *   [1] a quiet song and a loud song come out of an export at the same loudness
 *   [2] 100% is as loud as a voice (−16 LUFS), 25% is a bed ~12 dB under it
 *   [3] the library's preview copy is levelled the same way as the export
 *   [4] songs added before this get a levelled preview copy (relevel)
 *
 *   xvfb-run -a npx electron --no-sandbox test/music-level.test.js   (or node)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const library = require(path.join(ROOT, 'src/main/library'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-music-level-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
library.init(WORK);

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + d : '')); ok ? pass++ : fail++; };
const ff = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });
function lufsOf(file) {
  let out = '';
  try { execFileSync(ffmpeg, ['-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { out = String(e.stderr || ''); }
  if (!out) {
    const r = require('child_process').spawnSync(ffmpeg, ['-nostats', '-i', file, '-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
    out = String(r.stderr || '');
  }
  return parseFloat((/I:\s*(-?[\d.]+) LUFS/.exec(out.slice(out.lastIndexOf('Summary:'))) || [])[1]);
}

(async () => {
  try {
    // a silent picture, and two "songs": pink noise mastered quiet (−30) and loud (−10)
    const CLIP = path.join(WORK, 'clip.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=25:d=12', '-c:v', 'libx264', '-preset', 'veryfast', CLIP]);
    const QUIET = path.join(WORK, 'quiet.m4a'), LOUD = path.join(WORK, 'loud.mp3');
    ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:d=20:a=0.5', '-af', 'loudnorm=I=-30:TP=-2:LRA=7,aresample=48000', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', QUIET]);
    ff(['-f', 'lavfi', '-i', 'anoisesrc=c=pink:r=48000:d=20:a=0.5', '-af', 'loudnorm=I=-10:TP=-1:LRA=7,aresample=48000', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '192k', LOUD]);
    console.log('  songs as mastered:', lufsOf(QUIET).toFixed(1), 'and', lufsOf(LOUD).toFixed(1), 'LUFS');

    console.log('\n[1] every song comes out at the same loudness');
    const mix = async (song, vol, name) => {
      const out = path.join(WORK, name);
      await video.mixMusic(ctx, { input: CLIP, output: out, musicPath: song, musicVolume: vol, fadeIn: 0, fadeOut: 0, duck: false });
      return lufsOf(out);
    };
    const q100 = await mix(QUIET, 1, 'q100.mp4'), l100 = await mix(LOUD, 1, 'l100.mp4');
    check(Math.abs(q100 - l100) < 1.5, 'a quiet song and a loud one at 100% sound the same', `${q100.toFixed(1)} vs ${l100.toFixed(1)} LUFS`);

    console.log('\n[2] 100% is as loud as the voice; 25% is a bed under it');
    check(Math.abs(q100 - video.MUSIC_LUFS) < 1.5, '100% lands at −16 LUFS (a cleaned-up sermon\'s level)', q100.toFixed(1));
    const q25 = await mix(QUIET, 0.25, 'q25.mp4');
    check(Math.abs((q100 - q25) - 12) < 1.5, '25% is ~12 dB under 100%', (q100 - q25).toFixed(1) + ' dB');

    console.log('\n[3] the preview copy is levelled like the export');
    const e = await library.add(ctx, video, { kind: 'music', path: QUIET, name: 'Quiet song' });
    const p = lufsOf(e.preview);
    check(Math.abs(p - q100) < 1.5, 'the phone\'s preview copy plays at the export\'s loudness', `${p.toFixed(1)} vs ${q100.toFixed(1)} LUFS`);
    check(e.levelled === 1, 'and is marked levelled');

    console.log('\n[4] a song from before this is levelled once, in the background');
    const dbFile = fs.readdirSync(library.root()).find((f) => /\.json$/.test(f));
    const dbp = path.join(library.root(), dbFile);
    const raw = JSON.parse(fs.readFileSync(dbp, 'utf8'));
    raw.music.forEach((m) => { delete m.levelled; });
    fs.writeFileSync(dbp, JSON.stringify(raw));
    ff(['-i', LOUD, '-c:a', 'libmp3lame', '-b:a', '128k', e.preview]);   // stand-in for an old, unlevelled copy
    const old = lufsOf(e.preview);
    await library.relevel(ctx, video);
    const now = library.list().music[0];
    check(old > lufsOf(now.preview) + 1.5 && Math.abs(lufsOf(now.preview) - q100) < 1.5 && now.levelled === 1, 'its preview copy is made again at the export\'s loudness', `${old.toFixed(1)} → ${lufsOf(now.preview).toFixed(1)}`);
    check(library.relevel(ctx, video) === null, 'and nothing runs again once all are levelled');
  } catch (e) { check(false, 'the test ran to the end', e.stack); }
  finally { fs.rmSync(WORK, { recursive: true, force: true }); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
