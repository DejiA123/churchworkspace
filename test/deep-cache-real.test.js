'use strict';
/*
 * DEEP MODE + TRANSCRIPT CACHE on a real sermon — mirrors main.js's sermon:analyze
 * wiring exactly (TransCache + base.en fast/segment whisper + merged regions).
 * Proves:
 *   1. run 1 produces sentence-clean, content-scored clips with virality + reasons,
 *   2. run 2 makes ZERO whisper calls (every span served from the disk cache) and
 *      is dramatically faster,
 *   3. a DIFFERENT length mode after that still reuses cached spans where possible.
 * Usage: node test/deep-cache-real.test.js "<video>"
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');
const { TransCache } = require('../src/main/transcache');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
if (!input || !fs.existsSync(input)) { console.error('Usage: node test/deep-cache-real.test.js "<video>"'); process.exit(1); }
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const fmt = (t) => { const m = Math.floor(t / 60), s = Math.round(t % 60); return m + ':' + String(s).padStart(2, '0'); };

(async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-tcache-'));
  let whisperCalls = 0;

  // EXACTLY the main.js wiring (sermon:analyze)
  const cpus = os.cpus().length;
  const concurrency = Math.max(1, Math.min(3, Math.floor(cpus / 4)));
  const threads = Math.max(2, Math.min(8, Math.floor(cpus / concurrency)));
  const makeTranscribeRange = () => {
    const cache = new TransCache(cacheDir, input, 'base|segment|fast');
    return async (s, en) => {
      const hit = cache.get(s, en);
      if (hit) return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true };
      whisperCalls++;
      const r = await cap.transcribe(ctx, { input, startSec: s, endSec: en, model: 'base', granularity: 'segment', fast: true, threads });
      const segs = r.words || [];
      cache.add(s, en, segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
      return { segs };
    };
  };
  const opts = { input, minLen: 20, idealLen: 50, maxLen: 90, maxClips: 16, autoLen: true, contentAware: true, concurrency };

  console.log('RUN 1 (cold — transcribes merged regions once)…');
  const t0 = Date.now();
  const res1 = await highlights.analyzeSermon(ctx, { ...opts, transcribeRange: makeTranscribeRange(), onProgress: () => {} });
  const run1s = (Date.now() - t0) / 1000;
  const calls1 = whisperCalls;
  const D = res1.meta.durationSec;
  console.log(`  ${res1.clips.length} clips in ${Math.round(run1s)}s, ${calls1} whisper calls (video ${fmt(D)})`);
  res1.clips.forEach((c) => console.log(`   #${c.rank} [${fmt(c.start)}–${fmt(c.end)} ${c.durationSec}s] ${c.virality}/100 "${c.label}" (${(c.reasons || []).join(' · ')})`));

  check('run 1 found a generous set of clips', res1.clips.length >= 10, res1.clips.length + ' clips');
  check('content-aware path ran', res1.meta.contentAware === true);
  check('most clips are sentence-clean cuts', res1.clips.filter((c) => c.cleanCut).length >= res1.clips.length - 2,
    `${res1.clips.filter((c) => c.cleanCut).length}/${res1.clips.length}`);
  check('every clip has a viral-potential score 35..99', res1.clips.every((c) => c.virality >= 35 && c.virality <= 99));
  check('scores differentiate (not all identical)', new Set(res1.clips.map((c) => c.virality)).size >= 4,
    [...new Set(res1.clips.map((c) => c.virality))].join(','));
  check('every clip explains WHY it was picked', res1.clips.every((c) => c.reasons && c.reasons.length >= 1));
  check('titles come from the words (no generic labels)', res1.clips.every((c) => !/^Key moment/.test(c.label)));
  const starts = res1.clips.map((c) => c.start).sort((a, b) => a - b);
  check('coverage spans the sermon', starts[0] < D / 3 && starts[starts.length - 1] > (2 * D) / 3,
    `${fmt(starts[0])} .. ${fmt(starts[starts.length - 1])}`);
  check('deep run is faster than 12.5% of the sermon duration', run1s < D * 0.125, `${Math.round(run1s)}s vs cap ${Math.round(D * 0.125)}s`);

  console.log('\nRUN 2 (warm — same options, must be all-cache)…');
  const t1 = Date.now();
  const res2 = await highlights.analyzeSermon(ctx, { ...opts, transcribeRange: makeTranscribeRange(), onProgress: () => {} });
  const run2s = (Date.now() - t1) / 1000;
  const calls2 = whisperCalls - calls1;
  console.log(`  ${res2.clips.length} clips in ${Math.round(run2s)}s, ${calls2} whisper calls`);
  check('run 2 made ZERO whisper calls (100% cache)', calls2 === 0, calls2 + ' calls');
  check('run 2 is >8x faster than run 1', run2s * 8 < run1s, `${Math.round(run2s)}s vs ${Math.round(run1s)}s`);
  check('run 2 returns the same clips', JSON.stringify(res2.clips.map((c) => [c.start, c.end])) === JSON.stringify(res1.clips.map((c) => [c.start, c.end])));

  console.log('\nRUN 3 (different length mode ~30s — cached spans reused where they cover)…');
  const t2 = Date.now();
  await highlights.analyzeSermon(ctx, { ...opts, minLen: 15, idealLen: 30, maxLen: 45, autoLen: false, transcribeRange: makeTranscribeRange(), onProgress: () => {} });
  const run3s = (Date.now() - t2) / 1000;
  const calls3 = whisperCalls - calls1 - calls2;
  console.log(`  done in ${Math.round(run3s)}s, ${calls3} new whisper calls`);
  check('run 3 (new length) needs fewer whisper calls than a cold run', calls3 < calls1, `${calls3} < ${calls1}`);

  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
