'use strict';
/*
 * CUT-POINT QUALITY on a real sermon — the objective "does it cut at the right
 * start and end?" measurement. A clip boundary that lands while the preacher is
 * mid-word has speech-level energy AT the cut instant; a clean cut sits inside a
 * real pause. For every clip both modes produce, we measure the loudness at the
 * exact start/end cut and the distance to the nearest speech, then score:
 *   - % of cuts that land in silence (the number that must be ~100%),
 *   - deep mode: % of clips that are sentence-clean with a capitalised opening
 *     and a punctuated landing.
 * Usage: node test/cut-quality-real.test.js "<video>" [--json out.json] [--cache dir]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');
const { TransCache } = require('../src/main/transcache');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2] || 'C:/Users/dejia/Videos/The Mercy of God 2 Dr. David Richman.mp4';
const jsonOut = (() => { const i = process.argv.indexOf('--json'); return i > 0 ? process.argv[i + 1] : null; })();
const cacheDir = (() => { const i = process.argv.indexOf('--cache'); return i > 0 ? process.argv[i + 1] : fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cutq-')); })();

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const fmt = (t) => { const m = Math.floor(t / 60), s = (t % 60).toFixed(1); return m + ':' + String(s).padStart(4, '0'); };

const { extractPcm, buildEnvelope, HOP } = highlights._internals;
function smooth(arr, radius) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = i - radius; j <= i + radius; j++) { if (j >= 0 && j < arr.length) { s += arr[j]; c++; } }
    out[i] = s / c;
  }
  return out;
}
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[i];
}

/** Grade one cut instant against the envelope. dir: 'start' | 'end'. */
function gradeCut(t, dbS, threshold) {
  const hops = dbS.length;
  const hAt = Math.min(hops - 1, Math.max(0, Math.round(t / HOP)));
  // max energy in a ±60ms window around the cut — speech here means we chopped a word
  let peak = -999;
  for (let h = Math.max(0, hAt - 1); h <= Math.min(hops - 1, hAt + 1); h++) peak = Math.max(peak, dbS[h]);
  const inSilence = peak <= threshold;
  // distance to the nearest speech hop (how much breathing room the cut has)
  let dist = 99;
  for (let d = 0; d < Math.round(2 / HOP); d++) {
    const a = hAt - d, b = hAt + d;
    if ((a >= 0 && dbS[a] > threshold) || (b < hops && dbS[b] > threshold)) { dist = d * HOP; break; }
  }
  return { inSilence, peakDb: Math.round(peak * 10) / 10, distToSpeech: Math.round(dist * 100) / 100 };
}

function summarize(name, clips, dbS, threshold) {
  console.log(`\n──── ${name}: ${clips.length} clips ────`);
  let cleanStarts = 0, cleanEnds = 0;
  const rows = [];
  for (const c of clips) {
    const gs = gradeCut(c.start, dbS, threshold);
    const ge = gradeCut(c.end, dbS, threshold);
    if (gs.inSilence) cleanStarts++;
    if (ge.inSilence) cleanEnds++;
    rows.push({ rank: c.rank, start: c.start, end: c.end, dur: c.durationSec, startOk: gs.inSilence, endOk: ge.inSilence, startDb: gs.peakDb, endDb: ge.peakDb, label: c.label, quote: c.quote, cleanCut: !!c.cleanCut });
    console.log(`  #${String(c.rank).padStart(2)} [${fmt(c.start)}–${fmt(c.end)} ${String(c.durationSec).padStart(5)}s] start:${gs.inSilence ? ' ok ' : 'CUT!'} (${gs.peakDb}dB) end:${ge.inSilence ? ' ok ' : 'CUT!'} (${ge.peakDb}dB)  "${(c.label || '').slice(0, 60)}"`);
  }
  const n = clips.length || 1;
  const sPct = Math.round((cleanStarts / n) * 100), ePct = Math.round((cleanEnds / n) * 100);
  console.log(`  → starts in silence: ${cleanStarts}/${clips.length} (${sPct}%)   ends in silence: ${cleanEnds}/${clips.length} (${ePct}%)`);
  return { name, clips: rows, cleanStartPct: sPct, cleanEndPct: ePct };
}

(async () => {
  console.log('Video:', input);
  console.log('Building loudness envelope for grading…');
  const buf = await extractPcm(ffmpeg, input);
  const { db } = buildEnvelope(buf);
  const dbS = smooth(db, 2);
  const sorted = Array.from(dbS).sort((a, b) => a - b);
  const floor = percentile(sorted, 15), top = percentile(sorted, 95);
  const threshold = floor + Math.max(6, (top - floor) * 0.28);
  console.log(`  threshold=${threshold.toFixed(1)}dB floor=${floor.toFixed(1)}dB top=${top.toFixed(1)}dB`);

  // renderer's "auto" length + ~16-clip target (the default the user actually runs)
  const p = { minLen: 20, idealLen: 50, maxLen: 90, autoLen: true };
  const durSec = db.length * HOP;
  const maxClips = Math.max(3, Math.min(16, Math.floor(durSec / (p.idealLen + 8))));

  console.log('\nRUN non-deep (audio-only)…');
  const t0 = Date.now();
  const resA = await highlights.analyzeSermon(ctx, { input, ...p, maxClips, contentAware: false, onProgress: () => {} });
  console.log(`  done in ${Math.round((Date.now() - t0) / 1000)}s`);
  const sumA = summarize('NON-DEEP', resA.clips, dbS, threshold);

  console.log('\nRUN deep (transcript-aware)…');
  const cpus = os.cpus().length;
  const concurrency = Math.max(1, Math.min(3, Math.floor(cpus / 4)));
  const threads = Math.max(2, Math.min(8, Math.floor(cpus / concurrency)));
  const cache = new TransCache(cacheDir, input, 'base|segment|fast');
  let whisperCalls = 0;
  const transcribeRange = async (s, en) => {
    const hit = cache.get(s, en);
    if (hit) return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true };
    whisperCalls++;
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: en, model: 'base', granularity: 'segment', fast: true, threads });
    const segs = r.words || [];
    cache.add(s, en, segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
    return { segs };
  };
  const t1 = Date.now();
  const resD = await highlights.analyzeSermon(ctx, { input, ...p, maxClips, contentAware: true, transcribeRange, concurrency, onProgress: () => {} });
  console.log(`  done in ${Math.round((Date.now() - t1) / 1000)}s (${whisperCalls} whisper calls)`);
  const sumD = summarize('DEEP', resD.clips, dbS, threshold);

  // deep text quality: opens on a real sentence start, lands on real punctuation
  const capOpen = resD.clips.filter((c) => c.quote && /^[A-Z"'“]/.test(c.quote.trim())).length;
  const cleanCuts = resD.clips.filter((c) => c.cleanCut).length;
  console.log(`  → capitalised openings: ${capOpen}/${resD.clips.length}   sentence-clean: ${cleanCuts}/${resD.clips.length}`);
  resD.clips.forEach((c) => c.quote && console.log(`   #${c.rank} “${c.quote}”`));

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ video: input, nondeep: sumA, deep: { ...sumD, capOpenPct: Math.round((capOpen / (resD.clips.length || 1)) * 100), cleanCutPct: Math.round((cleanCuts / (resD.clips.length || 1)) * 100) } }, null, 2));
    console.log('\nWrote ' + jsonOut);
  }

  // The bar the user asked for: every cut lands in silence, never mid-word.
  check('NON-DEEP: every clip STARTS in silence', sumA.cleanStartPct === 100, sumA.cleanStartPct + '%');
  check('NON-DEEP: every clip ENDS in silence', sumA.cleanEndPct === 100, sumA.cleanEndPct + '%');
  check('DEEP: every clip STARTS in silence', sumD.cleanStartPct === 100, sumD.cleanStartPct + '%');
  check('DEEP: every clip ENDS in silence', sumD.cleanEndPct === 100, sumD.cleanEndPct + '%');
  check('DEEP: every clip is sentence-clean', cleanCuts === resD.clips.length, `${cleanCuts}/${resD.clips.length}`);
  check('DEEP: every quote opens on a sentence start', capOpen === resD.clips.length, `${capOpen}/${resD.clips.length}`);

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
