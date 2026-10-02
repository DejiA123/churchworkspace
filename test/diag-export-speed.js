'use strict';
/*
 * WHERE THE TIME IN AN EXPORT ACTUALLY GOES.
 *
 * A short is not one render. It is: encode the clip, burn the text on, burn the
 * captions on, mix the music under, put the outro on the end — and every one of
 * those is a separate ffmpeg pass that decodes and RE-ENCODES the whole thing.
 * This times each of them on a real 1080p clip so the accelerations can be
 * aimed at the ones that cost something.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = 'C:/Users/dejia/Desktop/App Development/MediaWorkstation';
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-export-speed');
fs.mkdirSync(WORK, { recursive: true });
const SRC = path.join(WORK, 'sermon-60s-1080p.mp4');
const SECS = 60;

function build() {
  if (fs.existsSync(SRC) && fs.statSync(SRC).size > 400000) return;
  console.log('  building a 60s 1080p source (once)…');
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    // moving detail, so the encoder has real work to do rather than a flat colour
    '-f', 'lavfi', '-t', String(SECS), '-i', `testsrc2=size=1920x1080:rate=30`,
    '-f', 'lavfi', '-t', String(SECS), '-i', 'sine=frequency=220:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', SRC], { stdio: 'ignore' });
}

/** A transparent PNG the size of the export frame, as the renderer makes them. */
function pngFile(w, h, label) {
  const f = path.join(WORK, `ov-${label}.png`);
  if (!fs.existsSync(f)) {
    // A translucent band near the bottom — the shape a burned caption really is.
    // (drawtext needs a font file on Windows, which is not what is being timed.)
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h},format=rgba`,
      '-f', 'lavfi', '-i', `color=c=white@0.85:s=${Math.round(w * 0.8)}x160,format=rgba`,
      '-filter_complex', `[0][1]overlay=(W-w)/2:H-320:format=auto[o]`,
      '-map', '[o]', '-frames:v', '1', f], { stdio: 'ignore' });
  }
  return f;
}

const ms = (n) => (n / 1000).toFixed(1) + 's';
async function time(name, fn) {
  const t0 = Date.now();
  let out = null, err = null;
  try { out = await fn(); } catch (e) { err = e; }
  const took = Date.now() - t0;
  const size = out && fs.existsSync(out) ? (fs.statSync(out).size / 1048576).toFixed(1) + ' MB' : '';
  console.log('   ' + name.padEnd(42) + ms(took).padStart(7) + '   ' + size + (err ? '  ERR ' + err.message.slice(0, 70) : ''));
  return { out, took, err };
}

(async () => {
  build();
  const info = await video.getInfo(ctx, SRC);
  console.log(`\n  source: ${info.width}x${info.height} ${info.durationSec.toFixed(0)}s ${info.fps}fps\n`);

  console.log('  ONE SHORT, THE WAY THE STUDIO BUILDS IT (30s clip -> 9:16 1080p)');
  const a = await time('1. encode the clip (exportShort)', () => video.exportShort(ctx, {
    input: SRC, startSec: 5, endSec: 35, preset: 'reel-9x16', quality: '1080p',
    output: path.join(WORK, 'step1.mp4'),
  }));
  if (!a.out) return;
  const outInfo = await video.getInfo(ctx, a.out);
  console.log(`      -> ${outInfo.width}x${outInfo.height} ${outInfo.fps}fps ${outInfo.durationSec.toFixed(1)}s`);

  const textPng = pngFile(outInfo.width, outInfo.height, 'TEXT');
  // The studio no longer runs this as a pass of its own when captions are also
  // wanted - it hands the pictures to the caption pass. Timed separately here
  // only to show what that pass used to cost.
  const b = await time('2. burn the added text on (old: own pass)', () => video.burnImageOverlays(ctx, {
    input: a.out, images: [{ path: textPng, start: 0, end: 30 }],
    output: path.join(WORK, 'step2.mp4'),
  }));

  // The caption track is the same shape of work: transparent frames composited.
  const capPng = new Uint8Array(fs.readFileSync(pngFile(outInfo.width, outInfo.height, 'CAPTION')));
  const frames = [];
  for (let t = 0; t < 30; t += 1.5) frames.push({ png: capPng, dur: 1.5 });
  const track = { band: { x: 0, y: outInfo.height - 400, w: outInfo.width, h: 400 }, fps: 30,
                  authorW: outInfo.width, authorH: outInfo.height, frames };
  const c = await time('3. burn the captions on', () => video.burnCaptionTrack(ctx, {
    input: b.out || a.out, track, output: path.join(WORK, 'step3.mp4'),
  }));
  // …and what the studio ACTUALLY does now: both in one pass, off the raw short.
  const merged = await time('2+3 TOGETHER (what it does now)', () => video.burnCaptionTrack(ctx, {
    input: a.out, track, images: [{ path: textPng, start: 0, end: 30 }],
    output: path.join(WORK, 'step23.mp4'),
  }));

  const music = path.join(WORK, 'bed.m4a');
  if (!fs.existsSync(music)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', '40',
      '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac', music], { stdio: 'ignore' });
  }
  const d = await time('4. mix the music under', () => video.mixMusic(ctx, {
    input: c.out || b.out || a.out, musicPath: music, musicVolume: 0.25,
    output: path.join(WORK, 'step4.mp4'),
  }));

  const outro = path.join(WORK, 'outro.mp4');
  if (!fs.existsSync(outro)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '5', '-i', 'color=c=0x101820:s=1080x1920:r=30',
      '-f', 'lavfi', '-t', '5', '-i', 'sine=frequency=330:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', outro], { stdio: 'ignore' });
  }
  const e = await time('5. put the outro on the end', () => video.appendClips(ctx, {
    input: d.out || c.out, clips: [{ path: outro }], position: 'end',
    output: path.join(WORK, 'step5.mp4'),
  }));

  const total = [a, merged, d, e].reduce((n, x) => n + (x ? x.took : 0), 0);
  const old = [a, b, c, d, e].reduce((n, x) => n + (x ? x.took : 0), 0);
  console.log();
  console.log('\n   ' + 'TOTAL for one short'.padEnd(42) + ms(total).padStart(7));
  console.log('   ' + `(the clip itself is 30s of video)`.padEnd(42)
    + ' = ' + (total / 30000).toFixed(2) + 'x real time');

  console.log('\n  WHAT THE ENCODER IS DOING IN EACH PASS');
  for (const [name, f] of [['step1 (main export)', a.out], ['step2 (text)', b.out], ['step3 (captions)', c.out], ['step5 (outro)', e.out]]) {
    if (!f || !fs.existsSync(f)) continue;
    const i = await video.getInfo(ctx, f);
    console.log('   ' + name.padEnd(24) + `${i.width}x${i.height} ${i.fps}fps ${(fs.statSync(f).size / 1048576).toFixed(1)}MB`);
  }
})().catch((e) => console.error(e));
