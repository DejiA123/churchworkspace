'use strict';
/*
 * Proves the sermon-highlight engine finds the right moments.
 * We synthesize a 145s "sermon" audio with a KNOWN structure:
 *   - quiet intro/outro
 *   - three long CALM passages (normal speaking level)
 *   - three shorter LOUD "key points" at 33-49s, 77-93s, 121-137s,
 *     each framed by real pauses (like a preacher landing a point).
 * The engine must pick out those three loud regions.
 *
 * Run:  npm run test:highlights
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const { analyzeSermon } = require('../src/main/highlights');

const DIR = path.join(os.tmpdir(), 'mw-highlights-test');
fs.mkdirSync(DIR, { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  ✓ ' + name); pass++; }
  else { console.log('  ✗ ' + name + (detail ? '  -> ' + detail : '')); fail++; }
}

// ----- ground-truth structure -----
const SR = 16000;
const A_CALM = 3200, A_LOUD = 13000, A_SIL = 30;
// [start, end, level]  level: 0 silence, 1 calm, 2 loud
const REGIONS = [
  [0, 8, 0],
  [8, 30, 1],
  [30, 33, 0],
  [33, 49, 2],   // KEY 1
  [49, 52, 0],
  [52, 74, 1],
  [74, 77, 0],
  [77, 93, 2],   // KEY 2
  [93, 96, 0],
  [96, 118, 1],
  [118, 121, 0],
  [121, 137, 2], // KEY 3
  [137, 145, 0],
];
const KEYS = [[33, 49], [77, 93], [121, 137]];
const TOTAL = 145;

function synthWav(file) {
  const nSamples = SR * TOTAL;
  const data = Buffer.alloc(nSamples * 2);
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const levelAmp = [A_SIL, A_CALM, A_LOUD];
  let ri = 0;
  for (let i = 0; i < nSamples; i++) {
    const t = i / SR;
    while (ri < REGIONS.length - 1 && t >= REGIONS[ri][1]) ri++;
    const lvl = REGIONS[ri][2];
    let amp = A_SIL;
    if (lvl > 0) {
      const local = (t - REGIONS[ri][0]) % 0.47; // "words": 0.35s on, 0.12s gap
      amp = local < 0.35 ? levelAmp[lvl] : A_SIL;
    }
    let s = Math.round(amp * rand());
    s = Math.max(-32767, Math.min(32767, s));
    data.writeInt16LE(s, i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

function overlap(a, b) { return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])); }

(async () => {
  console.log('Synthesizing sermon audio + video...');
  const wav = path.join(DIR, 'sermon.wav');
  const mp4 = path.join(DIR, 'sermon.mp4');
  synthWav(wav);
  const r = spawnSync(ffmpeg, [
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=15:duration=${TOTAL}`,
    '-i', wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
    '-c:a', 'aac', '-shortest', '-y', mp4,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) { console.error(r.stderr); process.exit(1); }

  console.log('Analyzing...\n');
  const res = await analyzeSermon({ ffmpeg, ffprobe }, { input: mp4, minLen: 12, maxLen: 60, idealLen: 25, maxClips: 6 });
  const clips = res.clips;
  console.log('  detected clips:', JSON.stringify(clips.map((c) => [c.start, c.end, c.score])));
  console.log('  meta:', JSON.stringify(res.meta), '\n');

  check('found at least 3 clips', clips.length >= 3, clips.length + ' clips');

  // Each known KEY region must be covered by some clip (>= 12s overlap of its 16s).
  for (let k = 0; k < KEYS.length; k++) {
    const best = Math.max(0, ...clips.map((c) => overlap([c.start, c.end], KEYS[k])));
    check(`key point ${k + 1} (${KEYS[k][0]}-${KEYS[k][1]}s) captured`, best >= 12, best.toFixed(1) + 's overlap');
  }

  // The three highest-scoring clips should be the three key points.
  const top3 = clips.slice().sort((a, b) => b.score - a.score).slice(0, 3);
  const top3CoverAllKeys = KEYS.every((reg) => top3.some((c) => overlap([c.start, c.end], reg) >= 12));
  check('top-3 scored clips ARE the 3 key points', top3CoverAllKeys);

  // Clips must not overlap each other.
  const sorted = clips.slice().sort((a, b) => a.start - b.start);
  let nonOverlap = true;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].start < sorted[i - 1].end) nonOverlap = false;
  check('clips do not overlap', nonOverlap);

  // Durations within range; boundaries snap near the real pauses (clean cuts).
  check('all durations within [12,60]s', clips.every((c) => c.durationSec >= 11.5 && c.durationSec <= 60.5));
  const keyClips = KEYS.map((reg) => clips.find((c) => overlap([c.start, c.end], reg) >= 12)).filter(Boolean);
  const cleanCuts = keyClips.every((c) => {
    const nearStart = KEYS.some((reg) => Math.abs(c.start - reg[0]) < 2.0);
    const nearEnd = KEYS.some((reg) => Math.abs(c.end - reg[1]) < 2.0);
    return nearStart && nearEnd;
  });
  check('key clips cut cleanly at pause boundaries (±2s)', cleanCuts);

  // Export each highlight as a real 9:16 short and verify the output.
  console.log('\nExporting shorts (trim + reframe to 9:16)...');
  const video = require('../src/main/video');
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const out = path.join(DIR, `short-${i + 1}.mp4`);
    await video.exportShort({ ffmpeg, ffprobe }, { input: mp4, startSec: c.start, endSec: c.end, preset: 'reel-9x16', output: out });
    const info = await video.getInfo({ ffmpeg, ffprobe }, out);
    check(`short ${i + 1} is 1080x1920 vertical`, info.width === 1080 && info.height === 1920, `${info.width}x${info.height}`);
    check(`short ${i + 1} duration ≈ ${c.durationSec}s`, Math.abs(info.durationSec - c.durationSec) < 1.6, info.durationSec + 's');
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  console.log('Sample shorts in: ' + DIR);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
