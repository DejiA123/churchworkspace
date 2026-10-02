'use strict';
/*
 * Quality read-out for Long-to-shorts on a REAL sermon, over the exact range the
 * operator left on the timeline. Prints each chosen clip with the editor pass's
 * own breakdown, so the picks can be judged as an editor would judge them
 * (rather than as a pass/fail number).
 *
 *   node test/real-sermon-quality.js "<video>" [startSec] [endSec] [auto|30|60|90|120]
 */
const os = require('os');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');
const video = require('../src/main/video');
const { TransCache } = require('../src/main/transcache');
const path = require('path');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
const START = Number(process.argv[3] || 0);
const END = Number(process.argv[4] || 0);
const mode = process.argv[5] || 'auto';
if (!input) { console.error('usage: node test/real-sermon-quality.js "<video>" [startSec] [endSec] [mode]'); process.exit(1); }

// EXACTLY the renderer's shortLenParams()
function lenParams(raw) {
  if (raw === 'auto') return { minLen: 60, idealLen: 90, maxLen: 150, autoLen: true };
  const v = parseInt(raw, 10) || 60;
  if (v === 30) return { minLen: 15, idealLen: 30, maxLen: 45 };
  if (v === 90) return { minLen: 70, idealLen: 90, maxLen: 115 };
  if (v === 120) return { minLen: 95, idealLen: 120, maxLen: 150 };
  return { minLen: 40, idealLen: 60, maxLen: 80 };
}
const fmt = (t) => { const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.round(t % 60); return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0'); };

(async () => {
  const info = await video.getInfo(ctx, input);
  const p = lenParams(mode);
  const from = START, to = END > START ? END : info.durationSec;
  const keptSec = to - from;
  // exactly the renderer's clip-count target
  const fit = Math.floor(keptSec / ((p.idealLen || 50) + 8));
  const maxClips = Math.max(3, Math.min(16, fit));

  const cpus = os.cpus().length;
  const concurrency = Math.max(1, Math.min(3, Math.floor(cpus / 4)));
  const threads = Math.max(2, Math.min(8, Math.floor(cpus / concurrency)));
  console.log(`${info.durationLabel} recording | searching ${fmt(from)}–${fmt(to)} (${Math.round(keptSec / 60)} min)`);
  console.log(`mode=${mode} [${p.minLen}-${p.maxLen}s ideal ${p.idealLen}] | target ${maxClips} clips | conc=${concurrency} thr=${threads}\n`);

  // the app's on-disk transcript cache, so re-runs are cheap
  const cache = new TransCache(path.join(os.tmpdir(), 'mw-quality-cache'), input, 'base|segment|fast');
  const transcribeRange = async (s, e) => {
    const hit = cache.get(s, e);
    if (hit) return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true };
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: e, model: 'base', granularity: 'segment', fast: true, threads });
    const segs = r.words || [];
    cache.add(s, e, segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
    return { segs };
  };

  const t0 = Date.now();
  const res = await highlights.analyzeSermon(ctx, {
    input, minLen: p.minLen, maxLen: p.maxLen, idealLen: p.idealLen, maxClips, autoLen: !!p.autoLen,
    contentAware: true, transcribeRange, concurrency,
    startSec: from, endSec: to,
    onProgress: (pr) => process.stdout.write(`\r  analysing ${pr}%   `),
  });
  const wall = Math.round((Date.now() - t0) / 1000);
  console.log(`\r  done in ${wall}s (${(wall / 60).toFixed(1)} min)                \n`);

  res.clips.forEach((c) => {
    console.log(`  #${String(c.rank).padStart(2)} ${fmt(c.start)}–${fmt(c.end)}  ${String(c.durationSec).padStart(6)}s  viral ${c.virality}  ${c.cleanCut ? '✂clean' : '~audio'}`);
    console.log(`      TITLE : ${c.label}`);
    console.log(`      WHY   : ${(c.reasons || []).join(' · ')}`);
    console.log(`      SAID  : ${(c.quote || '').slice(0, 150)}`);
    console.log('');
  });
  const durs = res.clips.map((c) => c.durationSec);
  console.log(`  ${res.clips.length} clips, avg ${(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(0)}s, ${fmt(res.clips[0].start)}..${fmt(res.clips[res.clips.length - 1].start)}`);
  console.log(`  editor pass ran: ${res.meta.editorPass}   content-aware: ${res.meta.contentAware}`);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
