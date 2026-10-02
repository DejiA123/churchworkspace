'use strict';
/*
 * Check the Swift analyser's LOGIC without a Mac.
 *
 * ios/MediaWorkstation/Engine/HighlightEngine.swift is a hand port of
 * src/main/highlights.js. Swift cannot be compiled on the Windows box this was
 * written on, so the port's correctness would otherwise be unverified until
 * someone opened Xcode — and the likely failure of a hand port is not a syntax
 * error (the compiler catches those in seconds) but a transcription slip: a
 * constant typed wrong, a loop bound off by one, a comparison flipped.
 *
 * So this file transliterates the SWIFT source back into JavaScript —
 * mechanically, following the Swift and not the original — and runs it against
 * the same fixture the XCTest uses. If the Swift logic drifted from the
 * JavaScript it was ported from, the clips come out different here.
 *
 * What this does NOT check: that the Swift compiles, that AVFoundation produces
 * the same envelope as ffmpeg, or anything in the UI. Those need the Mac. This
 * checks the arithmetic, which is the part a person gets wrong.
 *
 *   node ios/Tools/verify-swift-port.js
 */
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', 'Tests', 'MWEngineTests', 'Fixtures', 'highlight-parity.json');

let failed = false;
function check(ok, name, detail) {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ─────────── transliteration of HighlightEngine.swift ─────────── */

// static func percentile(_ sortedAsc: [Double], _ p: Double) -> Double
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.round((p / 100) * (sortedAsc.length - 1))));
  return sortedAsc[i];
}

// static func smooth(_ arr: [Double], radius: Int) -> [Double]
function smooth(arr, radius) {
  const out = new Array(arr.length).fill(0);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, c = 0;
    for (let j = i - radius; j <= i + radius; j++) {
      if (j >= 0 && j < arr.length) { s += arr[j]; c++; }
    }
    out[i] = s / c;
  }
  return out;
}

// struct Snapper
function makeSnapper(dbS, hop, threshold, totalDur) {
  // static func pauseWindows(dbS:hop:threshold:minDur:)
  const minHops = Math.max(2, Math.round(0.2 / hop));
  const pauses = [];
  let h = 0;
  while (h < dbS.length) {
    if (dbS[h] <= threshold) {
      let j = h;
      while (j < dbS.length && dbS[j] <= threshold) j++;
      if (j - h >= minHops) pauses.push({ s: h * hop, e: j * hop });
      h = j;
    } else h++;
  }
  const edge = 0.1;

  const nearest = (t, lo, hi, anchor) => {
    let best = null, bestD = Infinity;
    for (const p of pauses) {
      if (p.e < lo) continue;
      if (p.s > hi) break;
      const contains = p.s <= t && p.e >= t;
      const a = anchor(p);
      if (!contains && (a < lo || a > hi)) continue;
      const d = contains ? 0 : Math.abs(a - t);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  };

  return {
    snapStart(t, back, fwd, lead) {
      if (t <= 0.1) return 0;
      const p = nearest(t, t - back, t + fwd, (x) => x.e);
      if (!p) return Math.max(0, t - 0.15);
      if (p.e - t > 1.2) return clamp(t, p.s + edge, p.e - edge);
      return clamp(clamp(p.e - lead, p.s + edge, p.e - edge), 0, totalDur);
    },
    snapEnd(t, back, fwd, tail, hardMax = Infinity) {
      if (t >= totalDur - 0.1) return totalDur;
      let p = nearest(t, t - back, t + fwd, (x) => x.s);
      if (!p) p = nearest(t, t - 0.7, Math.min(t + 3.0, hardMax), (x) => x.s);
      if (!p) return Math.min(totalDur, Math.min(t + 0.3, hardMax));
      return clamp(clamp(p.s + tail, p.s + edge, p.e - edge), 0, Math.min(totalDur, hardMax));
    },
  };
}

// static func selectWithCoverage(_:maxClips:minGap:totalDur:)
function selectWithCoverage(cands, maxClips, minGap, totalDur) {
  const sorted = cands.slice().sort((a, b) => b.score - a.score);
  const picked = [];
  const nonClash = (c) => picked.every((p) => (c.end + minGap <= p.start) || (c.start - minGap >= p.end));
  const alreadyPicked = (c) => picked.some((p) => p.start === c.start && p.end === c.end);

  const buckets = Math.max(1, maxClips);
  for (let b = 0; b < buckets; b++) {
    if (picked.length >= maxClips) break;
    const lo = b * totalDur / buckets, hi = (b + 1) * totalDur / buckets;
    const cand = sorted.find((c) => !alreadyPicked(c) && ((c.start + c.end) / 2 >= lo) && ((c.start + c.end) / 2 < hi) && nonClash(c));
    if (cand) picked.push(cand);
  }
  for (const c of sorted) {
    if (picked.length >= maxClips) break;
    if (!alreadyPicked(c) && nonClash(c)) picked.push(c);
  }
  picked.sort((a, b) => a.start - b.start);
  return picked;
}

// static func viralityAndReasons(_:aTop:)
function viralityAndReasons(c, aTop) {
  const audio = clamp(c.score / aTop, 0, 1);
  const reasons = [];
  const v = 40 + 44 * audio + 8 * clamp(c.expr, 0, 1) + 6 * clamp(c.hookZ, 0, 1);
  if (c.hookZ > 0.5) reasons.push('Strong opening');
  if (c.expr > 0.5) reasons.push('Animated, expressive delivery');
  if (audio > 0.75) reasons.push('High-energy delivery');
  if (c.pauseBonus > 0.7) reasons.push('Cuts cleanly at natural pauses');
  if (!reasons.length) reasons.push('Elevated delivery vs the rest of the sermon');
  return { virality: Math.max(35, Math.min(99, Math.round(v))), reasons: reasons.slice(0, 3) };
}

// static func analyze(envelope:options:)
function analyze(db, hop, o) {
  const hops = db.length;
  const offset = Math.max(0, o.startSec || 0);
  const dbS = smooth(db, 2);

  const sortedAll = dbS.slice().sort((a, b) => a - b);
  const floorDb = percentile(sortedAll, 15);
  const topDb = percentile(sortedAll, 95);
  const threshold = floorDb + Math.max(6, (topDb - floorDb) * 0.28);

  const isSpeech = new Array(hops).fill(false);
  for (let i = 0; i < hops; i++) isSpeech[i] = dbS[i] > threshold;

  const bridgeHops = Math.round(0.25 / hop);
  let h = 0;
  while (h < hops) {
    if (!isSpeech[h]) {
      let j = h;
      while (j < hops && !isSpeech[j]) j++;
      if (j - h <= bridgeHops && h > 0 && j < hops) for (let k = h; k < j; k++) isSpeech[k] = true;
      h = j;
    } else h++;
  }

  const minSegHops = Math.round(0.3 / hop);
  const segs = [];
  h = 0;
  while (h < hops) {
    if (isSpeech[h]) {
      let j = h;
      while (j < hops && isSpeech[j]) j++;
      if (j - h >= minSegHops) {
        let sum = 0, sum2 = 0, mx = -999;
        for (let k = h; k < j; k++) { sum += db[k]; sum2 += db[k] * db[k]; if (db[k] > mx) mx = db[k]; }
        const headEnd = Math.min(j, h + Math.round(5 / hop));
        let headSum = 0;
        for (let k = h; k < headEnd; k++) headSum += db[k];
        segs.push({
          s: h * hop, e: j * hop, meanDb: sum / (j - h), maxDb: mx,
          sumDb: sum, sumDb2: sum2, hopCount: j - h,
          headDb: headSum / Math.max(1, headEnd - h),
        });
      }
      h = j;
    } else h++;
  }
  if (!segs.length) throw new Error('no speech');

  const speechDb = [];
  for (let i = 0; i < hops; i++) if (isSpeech[i]) speechDb.push(db[i]);
  speechDb.sort((a, b) => a - b);
  const med = percentile(speechDb, 50);
  const spread = Math.max(2, percentile(speechDb, 85) - percentile(speechDb, 50));
  const totalDur = hops * hop;
  const snapper = makeSnapper(dbS, hop, threshold, totalDur);

  const keep = (o.ranges || []).map((r) => ({ start: r.start - offset, end: r.end - offset }));
  const inKeep = (a, b) => !keep.length || keep.some((k) => a >= k.start - 0.05 && b <= k.end + 0.05);

  const beforePause = (k) => (k > 0 ? segs[k].s - segs[k - 1].e : Math.min(1, segs[k].s));
  const afterPause = (k) => (k < segs.length - 1 ? segs[k + 1].s - segs[k].e : Math.min(1, totalDur - segs[k].e));

  const generate = (minBound) => {
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      if (beforePause(i) < minBound) continue;
      let best = null;
      for (let j = i; j < segs.length; j++) {
        const start = segs[i].s, end = segs[j].e;
        const dur = end - start;
        if (dur > o.maxLen) break;
        if (dur < o.minLen) continue;
        if (!inKeep(start, end)) continue;
        const bp = beforePause(i), ap = afterPause(j);
        if (ap < minBound) continue;

        let wSum = 0, wDur = 0, peak = -999, hSum = 0, hSum2 = 0, hCount = 0;
        for (let k = i; k <= j; k++) {
          const d = segs[k].e - segs[k].s;
          wSum += segs[k].meanDb * d; wDur += d;
          if (segs[k].maxDb > peak) peak = segs[k].maxDb;
          hSum += segs[k].sumDb; hSum2 += segs[k].sumDb2; hCount += segs[k].hopCount;
        }
        const meanDb = wSum / wDur;
        const speechRatio = wDur / dur;
        const energyZ = (meanDb - med) / spread;
        const peakZ = (peak - med) / spread;
        const fitBand = o.autoLen ? o.idealLen : Math.max(6, o.maxLen - o.idealLen);
        const durFit = clamp(1 - Math.abs(dur - o.idealLen) / fitBand, -1, 1);
        const pauseBonus = clamp((bp + ap) / 2, 0, 1);
        const hMean = hSum / hCount;
        const exprStd = Math.sqrt(Math.max(0, hSum2 / hCount - hMean * hMean));
        const expr = clamp((exprStd - 3) / 5, 0, 1);
        const hookZ = clamp((segs[i].headDb - med) / spread, -1, 1.5);
        const posAdj = (offset < 1 && start < totalDur * 0.04) ? -0.3 : 0;
        const durW = o.autoLen ? 0.25 : 0.9;
        const score = 1.0 * energyZ + 0.5 * peakZ + durW * durFit + 0.5 * speechRatio
          + 0.3 * pauseBonus + 0.35 * expr + 0.3 * hookZ + posAdj;
        if (!best || score > best.score) best = { start, end, score, expr, hookZ, pauseBonus };
      }
      if (best) out.push(best);
    }
    return out;
  };

  let candidates = [];
  for (const bound of [0.7, 0.5, 0.35, 0.2, 0.0]) {
    candidates = generate(bound);
    if (candidates.length >= o.maxClips * 2) break;
  }

  const picked = selectWithCoverage(candidates, o.maxClips, 8, totalDur);
  for (const c of picked) {
    c.start = snapper.snapStart(c.start, 0.4, 0.3, 0.2);
    c.end = snapper.snapEnd(c.end, 0.3, 0.4, 0.28);
    c.start = clamp(c.start, 0, totalDur);
    c.end = clamp(c.end, c.start + 0.5, totalDur);
  }

  const aTop = Math.max(0.001, ...picked.map((c) => c.score));
  return picked.map((c, idx) => {
    const vr = viralityAndReasons(c, aTop);
    return {
      start: Math.round((c.start + offset) * 10) / 10,
      end: Math.round((c.end + offset) * 10) / 10,
      rank: idx + 1,
      virality: vr.virality,
      reasons: vr.reasons,
    };
  });
}

/* ─────────────────────────── the run ─────────────────────────── */

console.log('\nVerifying the Swift port against the JavaScript engine\'s own output');
console.log('(the fixture the XCTest uses — ios/Tests/MWEngineTests/Fixtures)\n');

if (!fs.existsSync(FIXTURE)) {
  console.error('Fixture missing. Run: node ios/Tools/make-parity-fixture.js');
  process.exit(1);
}
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
check(fixture.db.length > 1000, 'fixture loaded', `${fixture.db.length} hops @ ${fixture.hopSeconds}s`);

for (const c of fixture.cases) {
  console.log(`\n[${c.name}]  min ${c.options.minLen}s / ideal ${c.options.idealLen}s / max ${c.options.maxLen}s` +
    (c.options.autoLen ? '  (auto length)' : ''));
  let mine;
  try {
    mine = analyze(fixture.db, fixture.hopSeconds, {
      minLen: c.options.minLen, maxLen: c.options.maxLen, idealLen: c.options.idealLen,
      maxClips: c.options.maxClips, autoLen: c.options.autoLen, startSec: 0, ranges: [],
    });
  } catch (e) {
    check(false, 'the Swift logic ran', e.message);
    continue;
  }
  check(mine.length === c.clips.length, 'same number of clips', `${mine.length} vs ${c.clips.length}`);
  if (mine.length !== c.clips.length) continue;
  for (let i = 0; i < mine.length; i++) {
    const a = mine[i], b = c.clips[i];
    check(Math.abs(a.start - b.start) <= 0.11 && Math.abs(a.end - b.end) <= 0.11,
      `clip ${i + 1} cuts at the same place`, `${a.start}-${a.end} vs ${b.start}-${b.end}`);
    check(Math.abs(a.virality - b.virality) <= 1, `clip ${i + 1} viral score`, `${a.virality} vs ${b.virality}`);
    check(JSON.stringify(a.reasons) === JSON.stringify(b.reasons),
      `clip ${i + 1} reasons`, a.reasons.join(' / '));
  }
}

// Every planted loud moment must be covered — the check that stops both engines
// being wrong in the same direction.
const mine = analyze(fixture.db, fixture.hopSeconds,
  { minLen: 18, maxLen: 48, idealLen: 30, maxClips: 5, autoLen: false, startSec: 0, ranges: [] });
const covered = fixture.loudRegions.filter(([a, b]) => mine.some((c) => c.start < b && c.end > a));
console.log('');
check(covered.length === fixture.loudRegions.length,
  'every planted key moment is covered by a clip', `${covered.length}/${fixture.loudRegions.length}`);

console.log(`\n${failed ? '❌ the Swift port DIFFERS from the JavaScript engine' : '✅ the Swift port agrees with the JavaScript engine'}\n`);
process.exit(failed ? 1 : 0);
