'use strict';
/*
 * REAL-SERMON proof of the auto-length highlight quality: runs the exact deep
 * pipeline the app uses (base.en whisper, sentence-granularity, autoLen) and
 * asserts the clips are sentence-clean, naturally varied in length, in-bounds,
 * and spread across the whole sermon.
 * Usage: node test/autolen-real.test.js "<video>"   (takes several minutes)
 */
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
if (!input) { console.error('usage: node test/autolen-real.test.js "<video>"'); process.exit(1); }
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const fmt = (t) => { const m = Math.floor(t / 60), s = Math.round(t % 60); return m + ':' + String(s).padStart(2, '0'); };

(async () => {
  const info = await video.getInfo(ctx, input);
  const durMin = info.durationSec / 60;
  const maxClips = Math.min(20, Math.max(6, Math.round(durMin / 3.5))); // same as the app
  console.log(`Sermon: ${Math.round(durMin)} min -> targeting ${maxClips} clips (AUTO length, deep/base.en)\n`);

  // EXACTLY what main.js sermon:analyze wires up.
  const transcribeRange = async (s, e) => {
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: e, model: 'base', granularity: 'segment' });
    return { segs: r.words || [] };
  };
  const t0 = Date.now();
  let lastP = -1, regressed = false;
  const res = await highlights.analyzeSermon(ctx, {
    input, minLen: 20, idealLen: 50, maxLen: 90, maxClips, autoLen: true,
    contentAware: true, transcribeRange,
    onProgress: (p) => { if (p < lastP) regressed = true; if (p !== lastP) { lastP = p; process.stdout.write(`\r  progress ${p}%   `); } },
  });
  console.log(`\n  done in ${Math.round((Date.now() - t0) / 1000)}s\n`);

  res.clips.forEach((c) => console.log(
    `   #${c.rank} [${fmt(c.start)}-${fmt(c.end)}] ${String(c.durationSec).padStart(5)}s ${c.cleanCut ? '✂sentence-clean' : '~audio-bounds '} "${c.label}"\n` +
    `        ${c.quote || ''}`));
  console.log('');

  const D = res.meta.durationSec;
  const durs = res.clips.map((c) => c.durationSec);
  check('deep (content-aware) path ran', res.meta.contentAware === true);
  check(`found a full slate of clips (>= ${Math.min(6, maxClips)})`, res.clips.length >= Math.min(6, maxClips), res.clips.length + ' clips');
  check('every clip within the AUTO bounds [20s, 91s]', durs.every((d) => d >= 19.5 && d <= 91), durs.join(', '));
  const spread = Math.max(...durs) - Math.min(...durs);
  check('lengths are NATURAL (varied, not one fixed size)', spread >= 10, `${Math.min(...durs)}s .. ${Math.max(...durs)}s (spread ${Math.round(spread)}s)`);
  const clean = res.clips.filter((c) => c.cleanCut).length;
  check('most clips snap to complete-sentence boundaries', clean >= Math.ceil(res.clips.length * 0.6), `${clean}/${res.clips.length} sentence-clean`);
  check('every clip has real words (transcript quote)', res.clips.every((c) => c.quote && c.quote.length > 5));
  const starts = res.clips.map((c) => c.start).sort((a, b) => a - b);
  check('coverage: a clip early in the sermon', starts[0] < D * 0.25, fmt(starts[0]));
  check('coverage: a clip late in the sermon', starts[starts.length - 1] > D * 0.7, fmt(starts[starts.length - 1]));
  check('clips do not overlap', res.clips.every((c, i) => i === 0 || c.start >= res.clips[i - 1].end));
  check('progress reached 100 and never regressed', lastP === 100 && !regressed, regressed ? 'REGRESSED' : String(lastP));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
