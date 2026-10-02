'use strict';
/*
 * The camera bench: run buildKeyframes over frozen real footage and score the
 * path, in milliseconds, with no models and no encoding.
 *
 * Two families of number, because auto-reframe is a trade between them and a
 * change that only reports one of them is hiding the cost:
 *
 *   FRAMING  off — how far the subject sits from the middle of the 9:16 frame,
 *            in HALF-FRAMES (1.0 = at the edge, 0.5 = a quarter of the width
 *            off centre). Measured only where the subject was really seen, so a
 *            guessed position cannot flatter the score.
 *   CALM     travel (half-frames of camera movement per second), moves (how
 *            many times it starts, stops or changes direction), and the worst
 *            single-second speed. A camera that chases body language scores
 *            well on framing and badly here.
 *
 *   node test/reframe-lab.js <corpusDir> [tag ...]
 */
const fs = require('fs');
const path = require('path');

// --alt=<file> loads a different facetrack.js — that is how a change is shown
// to be an improvement rather than merely a difference.
const ALT = (process.argv.find((a) => a.startsWith('--alt=')) || '').slice(6);
global.window = global.window || {};
eval(fs.readFileSync(ALT || path.join(__dirname, '..', 'src', 'renderer', 'facetrack.js'), 'utf8'));
const FT = global.window.FaceTrack;
if (ALT) console.log('camera under test: ' + ALT);

const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function score(corpus) {
  const dets = corpus.dets.map((d) => ({ t: d.t, cxNorm: d.cx, cyNorm: d.cy, poseCx: d.pose, src: d.src, subject: d.sub }));
  const t0 = Date.now();
  const kf = FT.buildKeyframes(dets, corpus.srcW, corpus.srcH, { targetAR: 9 / 16, cuts: corpus.cuts });
  const ms = Date.now() - t0;
  const srcAR = corpus.srcW / corpus.srcH, tAR = 9 / 16;
  const half = srcAR > tAR ? 0.5 * (tAR / srcAR) : 0.5;
  const camAt = (t) => {
    if (t <= kf[0].t) return kf[0].x / corpus.srcW;
    for (let i = 1; i < kf.length; i++) {
      if (t <= kf[i].t) {
        const a = kf[i - 1], b = kf[i], r = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return (a.x + (b.x - a.x) * r) / corpus.srcW;
      }
    }
    return kf[kf.length - 1].x / corpus.srcW;
  };
  // GROUND TRUTH IS MEDIAN-FILTERED. The detector puts out occasional
  // single-sample teleports (measured: 6 in a 56s clip, all of them the track
  // flicking to the far edge of the frame for one 1/6s sample and back). The
  // camera is right to ignore them; scoring against them would report a
  // correct camera as a 3-half-frame miss and make every comparison useless. A
  // 3-wide median removes exactly that and nothing longer.
  const truth = dets.map((d, i) => {
    if (d.cxNorm == null) return null;
    let prev = null, next = null;
    for (let j = i - 1; j >= 0 && d.t - dets[j].t <= 1.5; j--) if (dets[j].cxNorm != null) { prev = dets[j].cxNorm; break; }
    for (let j = i + 1; j < dets.length && dets[j].t - d.t <= 1.5; j++) if (dets[j].cxNorm != null) { next = dets[j].cxNorm; break; }
    if (prev == null || next == null) return d.cxNorm;
    // The classic false positive: one sample at the far edge of the frame while
    // the sightings either side of it agree with each other. It is not where the
    // speaker was, so it is neither truth nor a camera failure — drop it.
    if (Math.abs(prev - next) < 0.16 && Math.abs(d.cxNorm - prev) > 0.16 && Math.abs(d.cxNorm - next) > 0.16) return null;
    const w = [prev, d.cxNorm, next].sort((a, b) => a - b);
    return w[1];
  });
  const off = [];
  for (let i = 0; i < dets.length; i++) if (truth[i] != null) off.push(Math.abs(truth[i] - camAt(dets[i].t)) / half);
  // Camera motion, read at the sample rate. Intervals containing a shot cut are
  // skipped: the crop is MEANT to snap there (the picture is discontinuous
  // anyway), and counting that as a pan would drown out the movement a viewer
  // can actually see.
  const snapAt = [];
  for (let i = 1; i < kf.length; i++) if (kf[i].t - kf[i - 1].t <= 0.05 && kf[i].x !== kf[i - 1].x) snapAt.push(kf[i].t);
  const spans = (a, b) => snapAt.some((s) => s > a - 1e-6 && s <= b + 1e-6);
  const spd = [];
  for (let i = 1; i < dets.length; i++) {
    const dt = dets[i].t - dets[i - 1].t;
    if (dt <= 1e-3 || spans(dets[i - 1].t, dets[i].t)) continue;
    spd.push((camAt(dets[i].t) - camAt(dets[i - 1].t)) / half / dt);
  }
  const dur = dets[dets.length - 1].t - dets[0].t || 1;
  const travel = spd.reduce((a, v) => a + Math.abs(v) / 6, 0);
  let moves = 0;
  const DEAD = 0.02;   // half-frames/s below which the camera counts as parked
  let state = 0;
  for (const v of spd) {
    const s = v > DEAD ? 1 : v < -DEAD ? -1 : 0;
    if (s !== state) { if (s !== 0 || state !== 0) moves++; state = s; }
  }
  const still = spd.filter((v) => Math.abs(v) <= DEAD).length / (spd.length || 1);
  return {
    ms, kf: kf.length, n: dets.length, seen: off.length,
    avg: mean(off), p50: q(off, 0.5), p90: q(off, 0.9), p99: q(off, 0.99), max: off.length ? Math.max(...off) : 0,
    over46: off.filter((o) => o > 0.46).length / (off.length || 1),
    travel: travel / dur, moves: moves / dur, maxSpd: spd.length ? Math.max(...spd.map(Math.abs)) : 0, still,
  };
}

const dir = process.argv[2] || path.join(require('os').tmpdir(), 'mw-reframe-corpus');
const tags = process.argv.slice(3).filter((a) => !a.startsWith('--'));
const files = fs.readdirSync(dir).filter((f) => /^corpus-.*\.json$/.test(f))
  .filter((f) => !tags.length || tags.includes(f.replace(/^corpus-|\.json$/g, '')));
console.log('tag        n   seen  gaps |  off: avg  p50   p90   p99   max  >0.46 | travel moves maxSpd still | kf   ms');
const acc = [];
for (const f of files) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const s = score(c);
  acc.push(s);
  console.log(c.tag.padEnd(10) + String(s.n).padStart(4) + String(s.seen).padStart(6)
    + String(s.n - s.seen).padStart(6) + '  |       '
    + s.avg.toFixed(3) + ' ' + s.p50.toFixed(3) + ' ' + s.p90.toFixed(3) + ' ' + s.p99.toFixed(3) + ' ' + s.max.toFixed(3)
    + ' ' + (100 * s.over46).toFixed(1) + '% |  ' + s.travel.toFixed(3) + ' ' + s.moves.toFixed(3) + '  '
    + s.maxSpd.toFixed(2) + '  ' + (100 * s.still).toFixed(0) + '% | ' + String(s.kf).padStart(4) + ' ' + String(s.ms).padStart(4));
}
if (acc.length > 1) {
  console.log('MEAN'.padEnd(22) + '        |       ' + mean(acc.map((a) => a.avg)).toFixed(3) + ' '
    + mean(acc.map((a) => a.p50)).toFixed(3) + ' ' + mean(acc.map((a) => a.p90)).toFixed(3) + ' '
    + mean(acc.map((a) => a.p99)).toFixed(3) + ' ' + mean(acc.map((a) => a.max)).toFixed(3) + ' '
    + (100 * mean(acc.map((a) => a.over46))).toFixed(1) + '% |  ' + mean(acc.map((a) => a.travel)).toFixed(3)
    + ' ' + mean(acc.map((a) => a.moves)).toFixed(3) + '  ' + mean(acc.map((a) => a.maxSpd)).toFixed(2)
    + '  ' + (100 * mean(acc.map((a) => a.still))).toFixed(0) + '%');
}
