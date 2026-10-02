'use strict';
/* Print the REAL pauses (from the loudness envelope) around a time window, so a
 * proposed cut point can be judged against where the speaker actually breathes.
 * Usage: node test/diag-pauses.js <video> <fromSec> <toSec> [analysisFrom] [analysisTo] */
const ffmpeg = require('ffmpeg-static');
const H = require('../src/main/highlights');
const { extractPcm, buildEnvelope, pauseWindows, HOP } = H._internals;

const input = process.argv[2];
const from = +process.argv[3], to = +process.argv[4];
const aFrom = +(process.argv[5] || 3938), aTo = +(process.argv[6] || 14518);
const fmt = (t) => Math.floor(t / 60) + ':' + (t % 60).toFixed(2).padStart(5, '0');
const pct = (a, p) => a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
function smooth(arr, r) {
  const o = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) { let s = 0, c = 0; for (let j = i - r; j <= i + r; j++) if (j >= 0 && j < arr.length) { s += arr[j]; c++; } o[i] = s / c; }
  return o;
}

(async () => {
  const buf = await extractPcm(ffmpeg, input, aFrom, aTo);
  const { db } = buildEnvelope(buf);
  const dbS = smooth(db, 2);
  const sorted = Array.from(dbS).sort((a, b) => a - b);
  const floor = pct(sorted, 15), top = pct(sorted, 95);
  const threshold = floor + Math.max(6, (top - floor) * 0.28);
  console.log(`threshold=${threshold.toFixed(1)}dB  (analysis span ${fmt(aFrom)}–${fmt(aTo)})`);
  const ps = pauseWindows(dbS, threshold, 0.2);
  console.log(`\nreal pauses in ${fmt(from)}–${fmt(to)} (absolute video time, length in seconds):`);
  for (const p of ps) {
    const s = p.s + aFrom, e = p.e + aFrom;
    if (e < from || s > to) continue;
    console.log(`  ${fmt(s)} – ${fmt(e)}   ${(e - s).toFixed(2)}s`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
