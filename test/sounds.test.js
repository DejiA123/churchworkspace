'use strict';
/*
 * 🎙 Voiceover and 🔊 sound effects, in the engine: every effect is made and is
 * audible without clipping, a sound is mixed in at exactly its moment (and
 * nowhere else), `from` starts a sound part-way through, and a recording in a
 * browser's format becomes an ordinary .m4a.
 *
 *   node test/sounds.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-sounds-test');
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};
const peak = (f, ss, t) => {
  const r = spawnSync(ffmpeg, ['-v', 'info', ...(ss != null ? ['-ss', String(ss)] : []), ...(t ? ['-t', String(t)] : []), '-i', f, '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /max_volume: ([-0-9.]+)/.exec(r.stderr.toString());
  return m ? +m[1] : -99;
};

(async () => {
  for (const kind of Object.keys(video.SFX)) {
    const out = path.join(WORK, `sfx-${kind}.m4a`);
    try {
      await video.makeSfx(ctx, { kind, output: out });
      const pk = peak(out);
      log(pk > -20 && pk <= 0, `${video.SFX[kind].name} is made, audible and not clipped`, `peak ${pk} dB`);
    } catch (e) { log(false, kind, e.message.split('\n').slice(-2).join(' ')); }
  }

  // a silent 6 s video, and the impact mixed in at 3 s
  const base = path.join(WORK, 'silent.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=25:d=6', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', base]);
  const mixed = path.join(WORK, 'mixed.mp4');
  await video.mixSounds(ctx, { input: base, output: mixed, sounds: [{ path: path.join(WORK, 'sfx-impact.m4a'), at: 3, volume: 1 }] });
  const info = await video.getInfo(ctx, mixed);
  log(Math.abs(info.durationSec - 6) < 0.15, 'the picture is untouched (same length)', info.durationSec.toFixed(2) + ' s');
  log(peak(mixed, 0.2, 2.5) < -60, 'silent before the sound\'s moment', `${peak(mixed, 0.2, 2.5)} dB over 0.2–2.7 s`);
  log(peak(mixed, 3.0, 0.5) > -12, 'the impact lands at 3 s', `${peak(mixed, 3.0, 0.5)} dB over 3.0–3.5 s`);
  log(peak(mixed) <= -0.9, 'the limiter keeps the mix out of clipping', `${peak(mixed)} dB peak`);

  // `from`: the drum roll started before this export — only its last 0.8 s plays, at 0
  const part = path.join(WORK, 'from.mp4');
  await video.mixSounds(ctx, { input: base, output: part, sounds: [{ path: path.join(WORK, 'sfx-drumroll.m4a'), at: 0, from: 1.6, dur: 0.8, volume: 1 }] });
  log(peak(part, 0, 0.6) > -40 && peak(part, 1.2, 4) < -60, 'a sound joined part-way through plays its tail, then stops', `${peak(part, 0, 0.6)} dB then ${peak(part, 1.2, 4)} dB`);

  // a "browser recording" (WebM/Opus) becomes an ordinary .m4a
  const webm = path.join(WORK, 'rec.webm');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=2', '-c:a', 'libopus', webm]);
  const m4a = path.join(WORK, 'rec.m4a');
  await video.saveRecording(ctx, { inputPath: webm, output: m4a });
  const ri = await video.getInfo(ctx, m4a);
  log(ri.hasAudio && Math.abs(ri.durationSec - 2) < 0.15, 'a WebM/Opus recording becomes a 2 s .m4a', `${ri.durationSec.toFixed(2)} s`);

  console.log(failed ? '\n❌ sounds test failed' : '\n✅ sounds test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
