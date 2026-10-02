'use strict';
/*
 * Capture what the REAL JavaScript analyser does, so the Swift port can be held
 * to it.
 *
 * The iPhone app re-implements src/main/highlights.js in Swift. A port like that
 * decays the moment either side is touched and nobody notices — the clips just
 * quietly stop matching. So this writes a fixture containing:
 *
 *   • the exact loudness envelope the JS engine computed from a synthetic
 *     sermon (via its own extractPcm + buildEnvelope, through real ffmpeg), and
 *   • the clips it chose from that envelope, under several option sets.
 *
 * ios/Tests/MWEngineTests/HighlightParityTests.swift feeds the same envelope to
 * the Swift engine and asserts the same clips come back. Because the envelope
 * is captured rather than recomputed, the test isolates the ANALYSIS — a Swift
 * decoder difference cannot mask or cause a failure.
 *
 *   node ios/Tools/make-parity-fixture.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const highlights = require(path.join(ROOT, 'src/main/highlights'));
const ffmpeg = require(path.join(ROOT, 'node_modules/ffmpeg-static'));
const ffprobe = require(path.join(ROOT, 'node_modules/ffprobe-static')).path;
const ctx = { ffmpeg, ffprobe };

const OUT = path.join(__dirname, '..', 'Tests', 'MWEngineTests', 'Fixtures', 'highlight-parity.json');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-parity-'));

/* ── a synthetic sermon with known structure ───────────────────────────────
 *
 * Deterministic on purpose: no randomness anywhere, so the fixture is
 * reproducible and a diff means a real behaviour change rather than noise.
 * Loud stretches are the "key points"; a beat of near-silence every seventh
 * second gives the analyser the pause boundaries it cuts on.
 */
const SR = 16000;
const TOTAL = 240;
const LOUD = [[26, 44], [68, 86], [112, 130], [156, 174], [198, 216]];

function buildWav(file) {
  const n = SR * TOTAL;
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const pause = (Math.floor(t) % 7) === 6;
    const loud = LOUD.some(([a, b]) => t >= a && t < b);
    const amp = pause ? 35 : (loud ? 12500 : 3100);
    // A slow tremolo makes the envelope vary the way a voice does, so the
    // expressiveness term is exercised rather than sitting at zero.
    const v = Math.sin(2 * Math.PI * 180 * t) * (0.7 + 0.3 * Math.sin(2 * Math.PI * 1.7 * t))
      + 0.25 * Math.sin(2 * Math.PI * 320 * t);
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((v / 1.25) * amp))), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

const CASES = [
  { name: 'fixed-30s', minLen: 18, idealLen: 30, maxLen: 48, maxClips: 5, autoLen: false },
  { name: 'auto', minLen: 20, idealLen: 40, maxLen: 70, maxClips: 6, autoLen: true },
  { name: 'long-fixed', minLen: 36, idealLen: 60, maxLen: 96, maxClips: 4, autoLen: false },
];

(async () => {
  const wav = path.join(WORK, 'sermon.wav');
  buildWav(wav);
  console.log('built ' + TOTAL + 's synthetic sermon');

  // The engine's own decode + envelope, so the fixture holds the exact numbers
  // the analysis ran on.
  const pcm = await highlights._internals.extractPcm(ffmpeg, wav, 0, null);
  const { db } = highlights._internals.buildEnvelope(pcm);
  console.log('envelope: ' + db.length + ' hops @ ' + highlights._internals.HOP + 's');

  const cases = [];
  for (const c of CASES) {
    const res = await highlights.analyzeSermon(ctx, {
      input: wav,
      minLen: c.minLen, maxLen: c.maxLen, idealLen: c.idealLen,
      maxClips: c.maxClips, autoLen: c.autoLen,
      contentAware: false,          // audio-only path — the one Swift ports
    });
    cases.push({
      name: c.name,
      options: { minLen: c.minLen, maxLen: c.maxLen, idealLen: c.idealLen, maxClips: c.maxClips, autoLen: c.autoLen },
      clips: res.clips.map((x) => ({
        start: x.start, end: x.end, durationSec: x.durationSec,
        rank: x.rank, virality: x.virality, reasons: x.reasons,
      })),
      meta: res.meta,
    });
    console.log(`  ${c.name}: ${res.clips.length} clips -> ` +
      res.clips.map((x) => `${x.start}-${x.end}`).join(', '));
  }

  const fixture = {
    generatedBy: 'ios/Tools/make-parity-fixture.js',
    source: 'src/main/highlights.js (audio-only path)',
    sampleRate: highlights._internals.SR,
    hopSeconds: highlights._internals.HOP,
    // Rounded to 6 decimals: far finer than any decision the engine makes, and
    // it keeps the fixture a readable ~500 KB instead of 1.5 MB.
    db: Array.from(db, (v) => Math.round(v * 1e6) / 1e6),
    loudRegions: LOUD,
    cases,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(fixture));
  console.log('wrote ' + OUT + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB)');
  fs.rmSync(WORK, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
