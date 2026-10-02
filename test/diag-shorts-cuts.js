'use strict';
/*
 * Long-to-shorts CUT INSPECTOR. Runs the real analysis over a real recording and
 * prints, for every clip it produces, the transcript BEFORE the start and AFTER
 * the end — so "it cut out the important part" is visible as words rather than
 * as a number. Also grades every clip's edges: does it open on a self-contained
 * sentence, does the thought land, does it straddle a break in the service.
 *
 * Usage:
 *   node test/diag-shorts-cuts.js <video> [options]
 *     --from S --to S      search range in seconds (default: whole file)
 *     --clips N            how many clips to ask for (default 20)
 *     --len auto|30|60|90|120
 *     --transcript FILE    a flat {segs:[…]} built by diag-full-transcript.js;
 *                          makes the run instant and offline
 *     --cache DIR          whisper span cache to use when there is no --transcript
 *     --grade "a-b,c-d"    skip the analysis and just grade these clips (seconds),
 *                          so an earlier run's cuts can be scored by the same
 *                          yardstick as a new one
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
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
// Point the captioner at the app's real userData so downloaded models (Small,
// Medium) are visible — otherwise the scan silently falls back to bundled Base
// and this tool would not be measuring what the app actually does.
cap.init(arg('userdata', path.join(os.homedir(), 'AppData', 'Roaming', 'Church Work Space')));
const MODEL = arg('model', null);
const input = process.argv[2];
const FROM = +arg('from', 0), TO = +arg('to', 0);
const CLIPS = +arg('clips', 20);
const LEN = arg('len', 'auto');
const TRANSCRIPT = arg('transcript', null);
const CACHE = arg('cache', path.join(os.tmpdir(), 'mw-cutdiag'));

// the renderer's own length bands (veditor.js shortLenParams)
const LENS = {
  auto: { minLen: 60, idealLen: 90, maxLen: 150, autoLen: true },
  30: { minLen: 15, idealLen: 30, maxLen: 45 },
  60: { minLen: 40, idealLen: 60, maxLen: 80 },
  90: { minLen: 70, idealLen: 90, maxLen: 115 },
  120: { minLen: 95, idealLen: 120, maxLen: 150 },
};
const fmt = (t) => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

(async () => {
  let flat = null;
  if (TRANSCRIPT) flat = JSON.parse(fs.readFileSync(TRANSCRIPT, 'utf8')).segs;
  const cache = flat ? null : new TransCache(CACHE, input, `${MODEL || 'base'}|segment|fast|v2`);
  let whisperCalls = 0, audioRead = 0;
  const transcribeRange = async (s, en) => {
    audioRead += en - s;
    if (flat) return { segs: flat.filter((g) => g.end > s && g.start < en).map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })) };
    const hit = cache.get(s, en);
    if (hit) return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true };
    whisperCalls++;
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: en, model: MODEL || 'base', granularity: 'segment', fast: true, threads: 4 });
    const segs = r.words || [];
    cache.add(s, en, segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
    return { segs };
  };

  const p = LENS[LEN] || LENS.auto;
  const GRADE = arg('grade', null);
  let res;
  if (GRADE) {
    res = { clips: GRADE.split(',').map((r, i) => {
      const [a, b] = r.split('-').map(Number);
      return { rank: i + 1, start: a, end: b, durationSec: Math.round((b - a) * 10) / 10, label: '(earlier run)', reasons: [], virality: 0 };
    }) };
    console.log(`\ngrading ${res.clips.length} clips from an earlier run\n`);
  } else {
    const t0 = Date.now();
    res = await highlights.analyzeSermon(ctx, {
      input, ...p, maxClips: CLIPS, contentAware: true, transcribeRange, concurrency: 1,
      startSec: FROM, endSec: TO || 0, ranges: TO ? [[FROM, TO]] : null,
      onProgress: () => {},
    });
    console.log(`\n${res.clips.length} clips in ${Math.round((Date.now() - t0) / 1000)}s`
      + `  (${Math.round(audioRead / 60)} min of audio read${flat ? ' from transcript' : `, ${whisperCalls} whisper calls`})\n`);
  }

  // Words to quote the clips back with: the flat transcript when there is one,
  // otherwise everything whisper wrote into the span cache during this run.
  // Cached spans OVERLAP (the "read further" retry re-reads past a region's end),
  // and two whisper calls segment the same audio differently — concatenating them
  // produces a jumbled double transcript that makes good cuts look broken. Walk
  // the spans in time order and take each one only from where the last stopped.
  let all;
  if (flat) all = flat.slice();
  else {
    all = [];
    let covered = -Infinity;
    for (const sp of (cache ? cache.spans.slice().sort((a, b) => a.from - b.from) : [])) {
      for (const g of sp.segs) if (g.start >= covered - 0.01) all.push(g);
      covered = Math.max(covered, sp.to);
    }
  }
  all.sort((a, b) => a.start - b.start);
  const near = (a, b) => all.filter((g) => g.end > a && g.start < b).map((g) => g.text.trim()).join(' ');

  // Edge grades, from the words themselves.
  let openOk = 0, closeOk = 0, straddles = 0;
  for (const c of res.clips) {
    const inside = near(c.start, c.end);
    // Build sentences over a WIDER span and then keep the ones whose middle lies
    // inside the clip. Filtering raw chunks by overlap instead would drag in the
    // half-chunks either side — with a model that emits 8-second chunks that is a
    // fragment at each end, and every clip grades as broken when it is not.
    const around = highlights.buildSentences(all.filter((g) => g.end > c.start - 20 && g.start < c.end + 20));
    const mid = (s) => (s.start + s.end) / 2;
    const sents = around.filter((s) => mid(s) >= c.start - 0.3 && mid(s) <= c.end + 0.3);
    const nextS = around.find((s) => mid(s) > c.end + 0.3);
    const op = sents.length ? highlights.openerPenalty([sents[0]], sents[0].text) : 1;
    const cl = sents.length ? highlights.closerPenalty(sents, nextS) : 1;
    const gap = highlights.transitionGap(sents);
    if (op < 0.5) openOk++;
    if (cl < 0.55) closeOk++;
    if (gap > 6) straddles++;
    console.log(`──── #${c.rank}  ${fmt(c.start)}–${fmt(c.end)}  ${c.durationSec}s  viral ${c.virality}`
      + `   open ${op.toFixed(2)}${op < 0.5 ? ' ok' : ' BAD'}  close ${cl.toFixed(2)}${cl < 0.55 ? ' ok' : ' BAD'}`
      + `  hole ${gap.toFixed(1)}s`);
    console.log(`     "${c.label}"   [${(c.reasons || []).join(' · ')}]`);
    console.log('  BEFORE: …' + (near(c.start - 14, c.start) || '(nothing)').slice(-110));
    console.log('  CLIP  : ' + sents.map((s) => s.text.trim()).join(' '));
    console.log('  AFTER : ' + (near(c.end, c.end + 16) || '(nothing)').slice(0, 110) + '…');
    console.log('');
  }
  const n = res.clips.length || 1;
  console.log(`SUMMARY  self-contained openings ${openOk}/${res.clips.length} (${Math.round(openOk / n * 100)}%)`
    + `   thoughts that land ${closeOk}/${res.clips.length} (${Math.round(closeOk / n * 100)}%)`
    + `   straddling a break ${straddles}`);
  const durs = res.clips.map((c) => c.durationSec).sort((a, b) => a - b);
  console.log(`         lengths ${durs[0]}s – ${durs[durs.length - 1]}s, median ${durs[Math.floor(durs.length / 2)]}s`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
