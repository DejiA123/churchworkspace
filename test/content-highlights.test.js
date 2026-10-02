'use strict';
/*
 * Content-aware highlights on a real long sermon: proves it (a) reads the words,
 * (b) spreads clips across the WHOLE video (no section missed), (c) prefers
 * content-rich moments. Usage: node test/content-highlights.test.js "<video>"
 */
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const highlights = require('../src/main/highlights');
const cap = require('../src/main/captioner');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

(async () => {
  // sanity: contentScore ranks a teaching/hook excerpt above filler
  const rich = contentSample('Listen to me, this is important. God has a purpose for your life. Faith! Faith moves mountains. Do you believe? Do you believe?');
  const filler = contentSample('um yeah you know so like we were just uh talking about the weather and stuff');
  check('contentScore ranks teaching > filler', rich > filler, `${rich.toFixed(2)} vs ${filler.toFixed(2)}`);
  function contentSample(t) { return highlights.contentScore(t); }

  console.log('\nRunning content-aware analysis on the real sermon (tiny.en for scanning)…');
  const t0 = Date.now();
  const transcribeRange = async (s, e) => { const r = await cap.transcribe(ctx, { input, startSec: s, endSec: e, model: 'tiny', granularity: 'segment' }); return { segs: r.words || [] }; };
  const res = await highlights.analyzeSermon(ctx, { input, minLen: 20, idealLen: 50, maxLen: 90, maxClips: 6, autoLen: true, contentAware: true, transcribeRange, onProgress: () => {} });
  console.log(`  done in ${Math.round((Date.now() - t0) / 1000)}s · contentAware=${res.meta.contentAware} · video ${Math.round(res.meta.durationSec / 60)}min\n`);
  res.clips.forEach((c) => console.log(`   #${c.rank} [${fmt(c.start)}–${fmt(c.end)} ${c.durationSec}s] "${c.label}"\n        ${c.quote}`));
  function fmt(t) { const m = Math.floor(t / 60), s = Math.round(t % 60); return m + ':' + String(s).padStart(2, '0'); }

  check('content-aware path ran', res.meta.contentAware === true);
  check('found clips', res.clips.length >= 4, res.clips.length + ' clips');
  check('every clip has a transcript quote', res.clips.every((c) => c.quote && c.quote.length > 5));
  check('labels come from the actual words', res.clips.every((c) => !/^Key moment/.test(c.label)));

  // coverage: clips should span the video (first in early third, last in late third)
  const D = res.meta.durationSec;
  const starts = res.clips.map((c) => c.start).sort((a, b) => a - b);
  check('coverage: a clip in the FIRST third of the sermon', starts[0] < D / 3, `${fmt(starts[0])}`);
  check('coverage: a clip in the LAST third of the sermon', starts[starts.length - 1] > D * 2 / 3, `${fmt(starts[starts.length - 1])}`);
  // spread: no giant gap where all clips cluster in one place
  const span = starts[starts.length - 1] - starts[0];
  check('clips are spread across the sermon (not clustered)', span > D * 0.5, `span ${fmt(span)} of ${fmt(D)}`);
  check('clips do not overlap', res.clips.every((c, i) => i === 0 || c.start >= res.clips[i - 1].end));

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
