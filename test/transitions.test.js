'use strict';
/*
 * Transitions between clips, on real exports: every one of them renders, with
 * sound, and the joined video is shorter by exactly the overlap — which is the
 * figure the studio uses to re-time text and captions (transitionOverlaps,
 * srcToOut in veditor.js). Without a transition the join is the old concat.
 *
 *   node test/transitions.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-transitions');
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};

(async () => {
  const src = path.join(WORK, 'src.mp4');
  if (!fs.existsSync(src)) {
    execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=20',
      '-f', 'lavfi', '-i', 'sine=f=220:d=20', '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', src]);
  }
  const run = (name, pieces) => {
    const out = path.join(WORK, name + '.mp4');
    return video.exportShort(ctx, { input: src, startSec: 0, endSec: 20, preset: 'source', quality: '480p', output: out, onProgress: () => {}, pieces })
      .then(() => video.getInfo(ctx, out));
  };

  for (const type of Object.keys(video.TRANSITIONS)) {
    try {
      const i = await run('t-' + type, [{ start: 2, end: 6 }, { start: 10, end: 14, trans: { type, dur: 0.8 } }, { start: 14, end: 16 }]);
      log(Math.abs(i.durationSec - 9.2) < 0.15 && i.hasAudio, `${type}: 4 s + 4 s + 2 s − 0.8 s overlap`, `${i.durationSec.toFixed(2)} s, sound ${i.hasAudio}`);
    } catch (e) { log(false, type, e.message.split('\n').slice(-2).join(' ')); }
  }
  const plain = await run('none', [{ start: 2, end: 6 }, { start: 10, end: 14 }]);
  log(Math.abs(plain.durationSec - 8) < 0.15, 'no transition: the old join, nothing overlapped', plain.durationSec.toFixed(2) + ' s');

  // a split with nothing deleted: touching pieces keep their join when it has a transition
  const touch = await run('touch', [{ start: 2, end: 8 }, { start: 8, end: 12, trans: { type: 'fade', dur: 1 } }]);
  log(Math.abs(touch.durationSec - 9) < 0.15, 'a split (touching clips) still gets its transition', touch.durationSec.toFixed(2) + ' s');
  const merged = await run('merged', [{ start: 2, end: 8 }, { start: 8, end: 12 }]);
  log(Math.abs(merged.durationSec - 10) < 0.15, '…and without one they join seamlessly', merged.durationSec.toFixed(2) + ' s');

  // a transition longer than a clip is clamped to half of it, as the studio assumes
  const short = await run('clamp', [{ start: 2, end: 6 }, { start: 10, end: 11, trans: { type: 'fade', dur: 3 } }]);
  log(Math.abs(short.durationSec - 4.5) < 0.15, 'a 3 s transition into a 1 s clip is held to 0.5 s', short.durationSec.toFixed(2) + ' s');

  // nonsense types are ignored, not handed to ffmpeg
  const bad = await run('bad', [{ start: 2, end: 6 }, { start: 10, end: 14, trans: { type: 'explode', dur: 1 } }]);
  log(Math.abs(bad.durationSec - 8) < 0.15, 'an unknown transition is a plain join', bad.durationSec.toFixed(2) + ' s');

  console.log(failed ? '\n❌ transitions test failed' : '\n✅ transitions test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
