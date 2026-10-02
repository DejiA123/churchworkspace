'use strict';
/*
 * The two things that put the speaker outside the 9:16 frame, held down.
 *
 * 1. RECOGNITION FAILING IS NOT THE SPEAKER LEAVING. On the shorts the user
 *    complained about, the identity layer declined 31% and 58% of samples —
 *    while the models found a body in every single frame — and the camera sat
 *    perfectly still for up to 14.5 seconds while the preacher walked out of
 *    the crop. recoverBlind is what fills those frames, and it must fill them
 *    ONLY when the answer is not in doubt.
 *
 * 2. THE CAMERA MUST NOT NEED TO BE RESCUED. The framing bound is now a
 *    constraint the path solver never violates rather than a clamp applied
 *    after the fact, and holds are real holds — exactly zero movement, not a
 *    slow creep.
 *
 * Runs in plain node with no models: the "people" are invented, which is the
 * point — every rule here is about geometry and continuity, and inventing the
 * cast is the only way to test the ambiguous cases deliberately.
 *
 *   node test/reframe-recovery.test.js
 */
const fs = require('fs');
const path = require('path');
global.window = global.window || {};
eval(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'facetrack.js'), 'utf8'));
const FT = global.window.FaceTrack;
const R = FT._recovery;

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/** N samples at 6fps; `at(i)` returns the people visible in sample i. */
const clip = (n, at) => Array.from({ length: n }, (_, i) => ({ t: i / 6, people: at(i) }));
const body = (cx, w) => ({ cx, cy: 0.4, bw: w || 0.06, bh: (w || 0.06) * 1.25, src: 'face', pose: { cx, cy: 0.4, headW: w || 0.06 } });
const wall = (cx, w) => ({ cx, cy: 0.45, bw: w || 0.2, bh: (w || 0.2) * 1.25, src: 'face', pose: null });

console.log('\n[1] A stretch nobody is recognised in, with one person plainly in it');
{
  // He walks 0.30 -> 0.70 across 20s. Identity sees him only in the first and
  // last second — the tight side angle in between defeats it, as it did on the
  // real clip.
  const n = 120;
  const pos = (i) => 0.30 + 0.40 * (i / (n - 1));
  const frames = clip(n, (i) => [body(pos(i))]);
  const track = frames.map((f, i) => (i < 6 || i >= n - 6 ? body(pos(i)) : null));
  const out = R.recoverBlind(frames, track);
  const filled = out.filter(Boolean).length;
  check('the blind stretch is filled from the body that is plainly there', filled >= n - 2, filled + '/' + n);
  const worst = out.reduce((m, p, i) => (p ? Math.max(m, Math.abs(p.cx - pos(i))) : m), 0);
  check('...and filled with where he actually was', worst < 0.01, 'worst ' + worst.toFixed(4));
}

console.log('\n[2] The same stretch with TWO people in it stays honest');
{
  const n = 120;
  const pos = (i) => 0.30 + 0.40 * (i / (n - 1));
  const frames = clip(n, (i) => [body(pos(i)), body(0.85 - 0.1 * Math.sin(i / 9))]);
  const track = frames.map((f, i) => (i < 6 || i >= n - 6 ? body(pos(i)) : null));
  const out = R.recoverBlind(frames, track);
  const mid = out.slice(30, 90).filter(Boolean);
  // The tracklet through the middle is only followed where it is DEMONSTRABLY
  // the man identity vouched for; a second persistent body must never be
  // guessed at.
  const wrong = mid.filter((p, k) => Math.abs(p.cx - pos(30 + k)) > 0.05).length;
  check('it never follows the OTHER person through the gap', wrong === 0, wrong + ' frames on the wrong man');
}

console.log('\n[3] A "sighting" with no body under it loses to a body');
{
  const n = 60;
  const frames = clip(n, () => [body(0.35), wall(0.75)]);
  // identity spends 4s convinced the wallpaper is the speaker
  const track = frames.map((f, i) => (i >= 12 && i < 36 ? wall(0.75) : body(0.35)));
  const out = R.recoverBlind(frames, track);
  const onWall = out.filter((p) => p && Math.abs(p.cx - 0.75) < 0.1).length;
  const onMan = out.filter((p) => p && Math.abs(p.cx - 0.35) < 0.1).length;
  check('the wallpaper sightings are thrown out', onWall === 0, onWall + ' left');
  check('...and replaced with the man', onMan >= n - 2, onMan + '/' + n);
}

console.log('\n[4] One bad sample is not evidence of anything');
{
  const n = 40;
  const frames = clip(n, () => [body(0.40)]);
  const track = frames.map(() => body(0.40));
  track[20] = body(0.05);           // a single-sample teleport to the frame edge
  const out = R.recoverBlind(frames, track);
  check('the teleport is dropped, not believed', out[20] == null || near(out[20].cx, 0.40, 0.05),
    out[20] ? out[20].cx.toFixed(3) : 'dropped');
  check('...and it does not cost the frames around it', out.filter(Boolean).length >= n - 1);
}

console.log('\n[5] Nobody there at all');
{
  const n = 40;
  const frames = clip(n, () => []);
  const out = R.recoverBlind(frames, frames.map(() => null));
  check('an empty stage stays empty (nothing is invented)', out.every((p) => !p));
}

/* ---- the camera ---------------------------------------------------------- */
const W = 1280, H = 720;
const HALF = 0.5 * (9 / 16) / (W / H);           // crop half-width as a fraction of the source
const buildCam = (pos) => {
  const dets = pos.map((cx, i) => ({ t: i / 6, cxNorm: cx, cyNorm: 0.5 }));
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const camAt = (t) => {
    if (t <= kf[0].t) return kf[0].x / W;
    for (let i = 1; i < kf.length; i++) {
      if (t <= kf[i].t) { const a = kf[i - 1], b = kf[i]; return (a.x + (b.x - a.x) * ((t - a.t) / Math.max(1e-6, b.t - a.t))) / W; }
    }
    return kf[kf.length - 1].x / W;
  };
  return { kf, cam: pos.map((_, i) => camAt(i / 6)) };
};

console.log('\n[6] Hold, glide, hold');
{
  // 8s still at 0.35, a 4s walk to 0.65, 8s still there
  const pos = [];
  for (let i = 0; i < 48; i++) pos.push(0.35);
  for (let i = 0; i < 24; i++) pos.push(0.35 + 0.30 * (i / 23));
  for (let i = 0; i < 48; i++) pos.push(0.65);
  const { cam } = buildCam(pos);
  const off = pos.map((p, i) => Math.abs(p - cam[i]) / HALF);
  check('the subject never leaves the safe area the solver was given',
    Math.max(...off) <= FT.CAM.HARD + 0.02, 'worst ' + Math.max(...off).toFixed(3) + ' vs ' + FT.CAM.HARD);
  const stillEarly = cam.slice(4, 40).every((c) => Math.abs(c - cam[20]) < 0.002);
  const stillLate = cam.slice(84, 116).every((c) => Math.abs(c - cam[100]) < 0.002);
  check('it is EXACTLY still while he is still (both holds)', stillEarly && stillLate,
    'early ' + (stillEarly ? 'ok' : 'creeps') + ', late ' + (stillLate ? 'ok' : 'creeps'));
  check('and it arrives where he went', near(cam[110], 0.65, 0.05), cam[110].toFixed(3));
  let turns = 0;
  for (let i = 2; i < cam.length; i++) {
    const a = cam[i - 1] - cam[i - 2], b = cam[i] - cam[i - 1];
    if (a * b < 0 && Math.abs(a) > 1e-4 && Math.abs(b) > 1e-4) turns++;
  }
  check('one move, not a series of corrections', turns <= 2, turns + ' direction changes');
}

console.log('\n[7] A speaker who only sways is not chased');
{
  const pos = Array.from({ length: 120 }, (_, i) => 0.45 + 0.05 * Math.sin(i / 6));  // ±5% at a 6s rhythm
  const { cam } = buildCam(pos);
  const travel = cam.reduce((a, c, i) => (i ? a + Math.abs(c - cam[i - 1]) : 0), 0);
  check('the camera barely moves at all through 20s of rocking', travel / HALF < 0.5,
    'travelled ' + (travel / HALF).toFixed(3) + ' half-frames');
  check('...while keeping him well inside the frame',
    Math.max(...pos.map((p, i) => Math.abs(p - cam[i]) / HALF)) < FT.CAM.HARD,
    'worst ' + Math.max(...pos.map((p, i) => Math.abs(p - cam[i]) / HALF)).toFixed(3));
}

console.log('\n[8] A blind stretch mid-clip does not strand the camera');
{
  // He walks right through a stretch with NO detections at all: the camera has
  // no information, so it must not wander — and must catch him when he reappears.
  const pos = [];
  for (let i = 0; i < 30; i++) pos.push(0.5);
  for (let i = 0; i < 30; i++) pos.push(null);
  for (let i = 0; i < 30; i++) pos.push(0.78);
  const dets = pos.map((cx, i) => ({ t: i / 6, cxNorm: cx, cyNorm: cx == null ? null : 0.5 }));
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const at = (i) => { const t = i / 6; let v = kf[0].x; for (const k of kf) { if (k.t <= t) v = k.x; } return v / W; };
  check('it holds through the blind stretch instead of drifting', near(at(45), at(20), 0.03),
    at(20).toFixed(3) + ' -> ' + at(45).toFixed(3));
  check('and it is back on him by the end', Math.abs(0.78 - at(85)) / HALF <= FT.CAM.HARD + 0.02,
    'off by ' + (Math.abs(0.78 - at(85)) / HALF).toFixed(3) + ' half-frames');
}

console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail ? 1 : 0);
