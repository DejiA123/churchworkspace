'use strict';
/*
 * REAL-SERMON proof for every shorts-length mode (auto / 30 / 60 / 90 / 120):
 * runs the EXACT deep pipeline the app uses (base.en, fast greedy decode,
 * concurrency sized like main.js) and asserts clips respect the selected length,
 * cut on sentence edges, cover the sermon, and the run is FAST.
 * Usage: node test/shortlen-real.test.js "<video>" <auto|30|60|90|120>
 */
const os = require('os');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
const mode = process.argv[3] || 'auto';
if (!input) { console.error('usage: node test/shortlen-real.test.js "<video>" <auto|30|60|90|120>'); process.exit(1); }
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const fmt = (t) => { const m = Math.floor(t / 60), s = Math.round(t % 60); return m + ':' + String(s).padStart(2, '0'); };

// EXACTLY the renderer's shortLenParams()
function lenParams(raw) {
  if (raw === 'auto') return { minLen: 60, idealLen: 90, maxLen: 150, autoLen: true };
  const v = parseInt(raw, 10) || 60;
  if (v === 30) return { minLen: 15, idealLen: 30, maxLen: 45 };
  if (v === 90) return { minLen: 70, idealLen: 90, maxLen: 115 };
  if (v === 120) return { minLen: 95, idealLen: 120, maxLen: 150 };
  return { minLen: 40, idealLen: 60, maxLen: 80 };
}

(async () => {
  const p = lenParams(mode);
  const info = await video.getInfo(ctx, input);
  const durMin = info.durationSec / 60;
  // same as the app: clip spacing grows with the target length (fewer 2-min shorts)
  const perClip = 3.5 * Math.max(1, (p.idealLen || 50) / 60);
  const maxClips = Math.min(20, Math.max(4, Math.round(durMin / perClip)));
  // EXACTLY main.js sermon:analyze wiring (fast decode + sized concurrency)
  const cpus = os.cpus().length;
  const concurrency = Math.max(1, Math.min(3, Math.floor(cpus / 4)));
  const threads = Math.max(2, Math.min(8, Math.floor(cpus / concurrency)));
  console.log(`Sermon: ${Math.round(durMin)} min | mode=${mode} [${p.minLen}-${p.maxLen}s, ideal ${p.idealLen}] | ${maxClips} clips | conc=${concurrency} thr=${threads}\n`);

  const transcribeRange = async (s, e) => {
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: e, model: 'base', granularity: 'segment', fast: true, threads });
    return { segs: r.words || [] };
  };
  const t0 = Date.now();
  let lastP = -1, regressed = false;
  const res = await highlights.analyzeSermon(ctx, {
    input, minLen: p.minLen, maxLen: p.maxLen, idealLen: p.idealLen, maxClips, autoLen: !!p.autoLen,
    contentAware: true, transcribeRange, concurrency,
    onProgress: (pr) => { if (pr < lastP) regressed = true; if (pr !== lastP) { lastP = pr; process.stdout.write(`\r  progress ${pr}%   `); } },
  });
  const wall = Math.round((Date.now() - t0) / 1000);
  console.log(`\n  done in ${wall}s (${(wall / 60).toFixed(1)} min for a ${Math.round(durMin)}-min sermon)\n`);

  res.clips.forEach((c) => console.log(
    `   #${c.rank} [${fmt(c.start)}-${fmt(c.end)}] ${String(c.durationSec).padStart(6)}s ${c.cleanCut ? '✂clean' : '~audio'} "${c.label}"\n        ${c.quote || ''}`));
  console.log('');

  const D = res.meta.durationSec;
  const durs = res.clips.map((c) => c.durationSec);
  const avg = durs.reduce((a, b) => a + b, 0) / durs.length;
  check('deep (content-aware) path ran', res.meta.contentAware === true);
  check(`found a full slate of clips (>= ${Math.min(6, maxClips)})`, res.clips.length >= Math.min(6, maxClips), res.clips.length + ' clips');
  check(`every clip within the selected band [${p.minLen}s, ${p.maxLen + 1}s]`, durs.every((d) => d >= p.minLen - 1 && d <= p.maxLen + 1.5), durs.join(', '));
  if (p.autoLen) {
    const spread = Math.max(...durs) - Math.min(...durs);
    check('AUTO: lengths are natural (varied)', spread >= 10, `${Math.min(...durs)}..${Math.max(...durs)}s (spread ${Math.round(spread)}s)`);
  } else {
    check(`FIXED ${mode}s: average length lands near the target (±25%)`, Math.abs(avg - p.idealLen) <= p.idealLen * 0.25, `avg ${avg.toFixed(1)}s vs target ${p.idealLen}s`);
  }
  const clean = res.clips.filter((c) => c.cleanCut).length;
  check('most clips snap to complete-sentence boundaries', clean >= Math.ceil(res.clips.length * 0.6), `${clean}/${res.clips.length} sentence-clean`);
  check('every clip has real words (transcript quote)', res.clips.every((c) => c.quote && c.quote.length > 5));
  const starts = res.clips.map((c) => c.start).sort((a, b) => a - b);
  check('coverage: a clip early in the sermon', starts[0] < D * 0.25, fmt(starts[0]));
  check('coverage: a clip late in the sermon', starts[starts.length - 1] > D * 0.7, fmt(starts[starts.length - 1]));
  check('clips do not overlap', res.clips.every((c, i) => i === 0 || c.start >= res.clips[i - 1].end));
  check('progress monotone to 100', lastP === 100 && !regressed, regressed ? 'REGRESSED' : String(lastP));
  // SPEED: the whole deep analysis must stay well under the old sequential
  // beam-search pipeline, which ran at roughly 1/6..1/5 of the sermon length.
  //
  // The bar is 1/7 (14.3%), not a tighter round number, because this is measured
  // wall-clock on whatever machine happens to run it. On the dev laptop (2
  // physical cores, i5-7300U) `node test/whisper-threads.bench.js` shows ~12%
  // run-to-run spread on an idle-ish machine and more with a browser open, so a
  // 12.5% bar fails on background load alone and says nothing about the engine.
  // Measured there: 435s for a 56-min sermon = 13.0%, i.e. 1/7.7.
  // (Thread count is not the lever — the same bench shows the app's threads=4
  // choice is already the fastest on that box.)
  check('FAST: analysis under 1/7 of sermon duration', wall < info.durationSec / 7, `${wall}s for ${Math.round(info.durationSec)}s sermon (${(wall / info.durationSec * 100).toFixed(1)}%, 1/${(info.durationSec / wall).toFixed(1)})`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
