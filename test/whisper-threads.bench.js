'use strict';
/*
 * How many threads should whisper get on THIS machine?
 *
 * main.js sizes threads from os.cpus().length, which reports LOGICAL processors
 * — 4 on a 2-physical-core laptop. whisper.cpp is compute-bound SIMD work, so
 * asking for more threads than physical cores can cost time rather than save it.
 * This measures it instead of guessing. Interleaved and repeated so a background
 * app spiking mid-run shows up as disagreement between repeats, not as a result.
 *
 *   node test/whisper-threads.bench.js "<video>" [startSec] [lenSec]
 */
const os = require('os');
const cap = require('../src/main/captioner');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
const START = Number(process.argv[3] || 600);
const LEN = Number(process.argv[4] || 120);
if (!input) { console.error('usage: node test/whisper-threads.bench.js "<video>" [startSec] [lenSec]'); process.exit(1); }

(async () => {
  console.log(`os.cpus().length = ${os.cpus().length} (logical)`);
  console.log(`Transcribing ${LEN}s of audio from ${START}s, twice per setting.\n`);
  const runs = [];
  for (const pass of [1, 2]) {
    for (const threads of [2, 3, 4]) {
      const t0 = Date.now();
      const r = await cap.transcribe(ctx, { input, startSec: START, endSec: START + LEN, model: 'base', granularity: 'segment', fast: true, threads });
      const wall = (Date.now() - t0) / 1000;
      runs.push({ threads, wall, segs: (r.words || []).length });
      console.log(`  pass ${pass}  threads=${threads}  ${wall.toFixed(1)}s  (${(LEN / wall).toFixed(2)}x realtime, ${(r.words || []).length} segments)`);
    }
  }
  console.log('');
  const best = {};
  for (const t of [2, 3, 4]) {
    const times = runs.filter((r) => r.threads === t).map((r) => r.wall);
    best[t] = Math.min(...times);
    const spread = Math.max(...times) - Math.min(...times);
    console.log(`  threads=${t}: best ${best[t].toFixed(1)}s, run-to-run spread ${spread.toFixed(1)}s`);
  }
  const winner = [2, 3, 4].reduce((a, b) => (best[b] < best[a] ? b : a));
  const gain = ((best[4] - best[winner]) / best[4] * 100);
  console.log(`\n  FASTEST: threads=${winner}` + (winner !== 4 ? `  (${gain.toFixed(1)}% faster than the current threads=4 choice)` : '  (the current choice is already best)'));
})().catch((e) => { console.error('FATAL: ' + e.message); process.exit(1); });
