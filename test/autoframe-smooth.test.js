'use strict';
/*
 * Deterministic tests for the CapCut-style auto-reframe virtual camera
 * (facetrack.js buildKeyframes): outlier rejection, dead-zone stillness,
 * smooth speed-limited glides with no overshoot, and convergence accuracy.
 * Pure math — no Electron/MediaPipe needed.  Run: node test/autoframe-smooth.test.js
 */
global.window = {};
require('../src/renderer/facetrack.js');
const FT = global.window.FaceTrack;
const video = require('../src/main/video.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

const W = 1920, H = 1080;
const FPS = 3; // matches the app's sampling rate
const mk = (cxAt, secs) => {
  const dets = [];
  for (let i = 0; i < secs * FPS; i++) { const t = (i + 0.5) / FPS; dets.push({ t, cxNorm: cxAt(t), cyNorm: 0.5 }); }
  return dets;
};
const camAt = (kf, t) => { // piecewise-linear sample of the keyframe path (what ffmpeg renders)
  if (t <= kf[0].t) return kf[0].x;
  for (let i = 0; i < kf.length - 1; i++) {
    if (t < kf[i + 1].t) { const p = (t - kf[i].t) / (kf[i + 1].t - kf[i].t); return kf[i].x + (kf[i + 1].x - kf[i].x) * p; }
  }
  return kf[kf.length - 1].x;
};

// ---------- 1. STILLNESS: natural sway must NOT move the camera ----------
{
  // speaker at centre, swaying ±1.5% like anyone talking at a pulpit
  const dets = mk((t) => 0.5 + 0.015 * Math.sin(t * 2.1) + 0.008 * Math.sin(t * 5.7), 30);
  const kf = FT.buildKeyframes(dets, W, H);
  const xs = kf.map((k) => k.x);
  const range = Math.max(...xs) - Math.min(...xs);
  check('camera holds still through natural sway (range < 0.8% of width)', range < 0.008 * W, `moved ${range}px of ${W}`);
}

// ---------- 2. OUTLIER: one false face detection must not yank the crop ----------
{
  const dets = mk((t) => 0.5, 20);
  dets[30].cxNorm = 0.92; // a single frame "found" a face in the congregation
  const kf = FT.buildKeyframes(dets, W, H);
  const worst = Math.max(...kf.map((k) => Math.abs(k.x - 0.5 * W)));
  check('single-frame false detection is rejected (deviation < 1.5%)', worst < 0.015 * W, `worst ${worst}px`);
}

// ---------- 3. GLIDE: speaker walks across the stage -> smooth, accurate pursuit ----------
{
  // stands at 0.30 for 12s, walks to 0.70 over 3s, stands there
  const dets = mk((t) => (t < 12 ? 0.30 : t < 15 ? 0.30 + 0.40 * ((t - 12) / 3) : 0.70), 40);
  const kf = FT.buildKeyframes(dets, W, H);
  const endX = camAt(kf, 39.5);
  check('camera ARRIVES on the speaker after the walk (within 2%)', Math.abs(endX - 0.70 * W) < 0.02 * W, `ended ${(endX / W).toFixed(3)} vs 0.700`);
  const settleT = (() => { for (let t = 12; t < 40; t += 0.1) { if (Math.abs(camAt(kf, t) - 0.70 * W) < 0.02 * W) return t; } return 99; })();
  check('camera settles within ~6s of the walk starting', settleT < 18, `settled at t=${settleT.toFixed(1)}s`);
  // no overshoot past the destination
  const over = Math.max(...kf.map((k) => k.x)) - 0.70 * W;
  check('no overshoot past the speaker', over < 0.015 * W, `overshoot ${Math.round(over)}px`);
  // speed limit: no whip pans (max slope between keyframes)
  let maxV = 0;
  for (let i = 1; i < kf.length; i++) { const dt = kf[i].t - kf[i - 1].t; if (dt > 0.01) maxV = Math.max(maxV, Math.abs(kf[i].x - kf[i - 1].x) / dt); }
  check('pan speed stays under the glide limit (no whips)', maxV <= 0.32 * W, `max ${Math.round(maxV)}px/s (limit ${Math.round(0.30 * W)})`);
}

// ---------- 4. ACCURACY: off-centre speaker -> camera converges onto them ----------
{
  const dets = mk(() => 0.64, 25);
  const kf = FT.buildKeyframes(dets, W, H);
  const endX = camAt(kf, 24.5);
  check('camera converges exactly onto an off-centre speaker (within 1%)', Math.abs(endX - 0.64 * W) < 0.01 * W, `ended ${(endX / W).toFixed(3)} vs 0.640`);
}

// ---------- 3b. FAST WALK: speaker must STAY in the 9:16 frame even when quick --
{
  // walks 0.30 -> 0.85 in 0.8s (0.69/s, well over the glide speed limit)
  const dets = mk((t) => (t < 8 ? 0.30 : t < 8.8 ? 0.30 + 0.55 * ((t - 8) / 0.8) : 0.85), 20);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const cropHalfX = 0.5 * ((9 / 16) / (W / H)) * W; // half the 9:16 crop width, in px
  const face = (t) => (t < 8 ? 0.30 : t < 8.8 ? 0.30 + 0.55 * ((t - 8) / 0.8) : 0.85) * W;
  let worst = 0;
  for (let t = 0; t < 20; t += 0.05) worst = Math.max(worst, Math.abs(camAt(kf, t) - face(t)));
  check('speaker STAYS inside the 9:16 crop during a fast walk (leash holds)', worst < cropHalfX, `worst offset ${Math.round(worst)}px of crop-half ${Math.round(cropHalfX)}px`);
  check('face kept well inside the safe area (< 85% of crop half-width)', worst < 0.85 * cropHalfX, `${Math.round(worst)}px < ${Math.round(0.85 * cropHalfX)}px`);
}

// ---------- 3c. INVARIANT: across a wandering walk, the face is ALWAYS framed ----
{
  const f = (t) => 0.5 + 0.42 * Math.sin(t / 2.5); // roams the full stage repeatedly
  const dets = mk(f, 60);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const cropHalfX = 0.5 * ((9 / 16) / (W / H)) * W;
  let inFrame = true, worst = 0;
  for (let t = 0; t < 60; t += 0.05) { const off = Math.abs(camAt(kf, t) - f(t) * W); worst = Math.max(worst, off); if (off >= cropHalfX) inFrame = false; }
  check('face NEVER leaves the 9:16 frame across a full-stage roam', inFrame, `worst ${Math.round(worst)}px vs crop-half ${Math.round(cropHalfX)}px`);
}

// ---------- 4b. RE-CENTRE: a small but PERSISTENT shift is corrected ----------
{
  // speaker edges 2.5% sideways at t=10 and stays there (inside the dead-zone)
  const dets = mk((t) => (t < 10 ? 0.50 : 0.525), 30);
  const kf = FT.buildKeyframes(dets, W, H);
  const endX = camAt(kf, 29.5);
  check('persistent small offset gets re-centred (within 0.5%)', Math.abs(endX - 0.525 * W) < 0.005 * W, `ended ${(endX / W).toFixed(3)} vs 0.525`);
}

// ---------- 5. GAPS: detections lost for a while -> camera stays put ----------
{
  const dets = mk(() => 0.45, 20);
  for (let i = 24; i < 42; i++) dets[i].cxNorm = null; // 6s of missed detections
  const kf = FT.buildKeyframes(dets, W, H);
  const during = camAt(kf, 10);
  check('camera holds position through a LONG detection gap', Math.abs(during - 0.45 * W) < 0.02 * W, `at ${(during / W).toFixed(3)}`);
}

// ---------- 5b. SHORT GAP DURING A WALK: interpolate, don't freeze ----------
{
  // speaker walks 0.35 -> 0.65 over 4s, but the detector BLINKS out mid-walk
  const dets = mk((t) => (t < 6 ? 0.35 : t < 10 ? 0.35 + 0.30 * ((t - 6) / 4) : 0.65), 16);
  for (const d of dets) if (d.t > 7 && d.t < 8.2) d.cxNorm = null; // ~1s blink mid-walk
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const face = (t) => (t < 6 ? 0.35 : t < 10 ? 0.35 + 0.30 * ((t - 6) / 4) : 0.65) * W;
  let worst = 0; for (let t = 6; t < 11; t += 0.05) worst = Math.max(worst, Math.abs(camAt(kf, t) - face(t)));
  const cropHalfX = 0.5 * ((9 / 16) / (W / H)) * W;
  check('camera tracks THROUGH a short detection blink mid-walk (no freeze-then-jump)', worst < cropHalfX, `worst ${Math.round(worst)}px of crop-half ${Math.round(cropHalfX)}px`);
}

// ---------- 8. CALM CAMERA: an energetic preacher must not shake the crop ----------
const travelStats = (kf) => {
  let travel = 0, reversals = 0, dir = 0, legStart = kf.length ? kf[0].x : 0;
  for (let i = 1; i < kf.length; i++) {
    const dx = kf[i].x - kf[i - 1].x, dt = kf[i].t - kf[i - 1].t;
    travel += Math.abs(dx);
    if (dt < 0.05) { legStart = kf[i].x; dir = 0; continue; } // boundary snap
    const d = Math.sign(dx);
    if (d !== 0 && dir !== 0 && d !== dir && Math.abs(kf[i - 1].x - legStart) > 0.035 * W) { reversals++; legStart = kf[i - 1].x; }
    if (d !== 0) dir = d;
  }
  return { travel, reversals };
};
{
  // ROCKING: sways ±5% of the frame with a ~5s rhythm while preaching — the
  // 9:16 crop has slack to spare, so the camera must NOT chase the rocking.
  const dets = mk((t) => 0.5 + 0.05 * Math.sin((t * 2 * Math.PI) / 5) + 0.008 * Math.sin(t * 7.3), 40);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const xs = kf.map((k) => k.x);
  const range = Math.max(...xs) - Math.min(...xs);
  check('camera ignores energetic ±5% rocking (range < 2% of width)', range < 0.02 * W, `moved ${range}px of ${W}`);
}
{
  // slower ±4% swaying (8s rhythm) — still just body language, still no chase
  const dets = mk((t) => 0.5 + 0.04 * Math.sin((t * 2 * Math.PI) / 8), 40);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const { travel, reversals } = travelStats(kf);
  check('slow ±4% swaying: camera travel stays tiny', travel < 0.06 * W, `travel ${Math.round(travel)}px`);
  check('slow ±4% swaying: no left-right turnarounds', reversals === 0, `${reversals} reversals`);
}
{
  // PHANTOM EXCURSIONS: the track jumps to a face-like pattern (wallpaper) for
  // 2 frames and comes straight back — while the POSE (body) tracker stays on
  // the real speaker. Body contradicts the jump = phantom: camera must not twitch.
  const dets = mk(() => 0.45, 30).map((d) => ({ ...d, poseCx: 0.45 }));
  for (const at of [24, 45, 66]) { dets[at].cxNorm = 0.68; dets[at + 1].cxNorm = 0.68; }
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const xs = kf.map((k) => k.x);
  const range = Math.max(...xs) - Math.min(...xs);
  check('body-contradicted A→B→A phantom excursions do not move the camera', range < 0.015 * W, `moved ${range}px`);
}
{
  // REAL QUICK MOVE: the speaker genuinely darts sideways for ~1s and returns —
  // the body moves WITH the face, so the run must be KEPT and the leash must
  // keep him inside the 9:16 crop while he's out there (ignoring a real move
  // left the speaker out of frame — measured on the real sermon).
  const f = (t) => (t >= 10 && t < 11.2 ? 0.72 : 0.45);
  const dets = mk(f, 24).map((d) => ({ ...d, poseCx: f(d.t), poseCy: 0.5 }));
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const cropHalfX = 0.5 * ((9 / 16) / (W / H)) * W;
  let worst = 0;
  for (const d of dets) worst = Math.max(worst, Math.abs(camAt(kf, d.t) - d.cxNorm * W));
  check('a REAL body-confirmed dart is followed enough to stay in frame', worst < cropHalfX, `worst ${Math.round(worst)}px vs crop-half ${Math.round(cropHalfX)}px`);
}
{
  // TRAVEL BUDGET: rocking ±4% + one real relocation (0.35 → 0.60 at t=15).
  // The camera should spend its motion on the relocation, not the rocking.
  const f = (t) => (t < 15 ? 0.35 : 0.60) + 0.04 * Math.sin((t * 2 * Math.PI) / 3.5);
  const dets = mk(f, 40);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
  const { travel, reversals } = travelStats(kf);
  const reloc = 0.25 * W;
  check('camera total travel ≈ the real relocation (≤1.6x)', travel <= 1.6 * reloc, `travel ${Math.round(travel)}px vs relocation ${Math.round(reloc)}px`);
  check('at most one turnaround across rock + relocation', reversals <= 1, `${reversals} reversals`);
  const endX = camAt(kf, 39.5);
  check('camera still ARRIVES on the relocated speaker (within 2.5%)', Math.abs(endX - 0.60 * W) < 0.025 * W, `${(endX / W).toFixed(3)} vs 0.600`);
}

// ---------- 7. CAMERA CUTS (multi-camera church recordings) ----------
{
  // HARD CUT: the speaker TELEPORTS 0.30 -> 0.70 at t=15 (different camera angle).
  // The crop must SNAP there — a glide across a cut leaves the speaker off-frame.
  const dets = mk((t) => (t < 15 ? 0.30 : 0.70), 30);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16, cuts: [{ t: 15, score: 0.5 }] });
  check('camera is ON the speaker right before a hard cut', Math.abs(camAt(kf, 14.6) - 0.30 * W) < 0.03 * W, `${(camAt(kf, 14.6) / W).toFixed(3)} vs 0.300`);
  check('camera SNAPS to the new angle within 0.5s of the cut', Math.abs(camAt(kf, 15.5) - 0.70 * W) < 0.03 * W, `${(camAt(kf, 15.5) / W).toFixed(3)} vs 0.700`);
  const cropHalfX = 0.5 * ((9 / 16) / (W / H)) * W;
  let worst = 0;
  for (let t = 0.5; t < 30; t += 0.05) { const face = (t < 15 ? 0.30 : 0.70) * W; if (Math.abs(t - 15) < 0.25) continue; worst = Math.max(worst, Math.abs(camAt(kf, t) - face)); }
  check('speaker inside the 9:16 crop at every moment around the cut', worst < cropHalfX, `worst ${Math.round(worst)}px vs crop-half ${Math.round(cropHalfX)}px`);
}
{
  // FALSE scene event (a gesture/lighting flicker scores 0.2 too): the speaker
  // never moved, so the camera must NOT snap or twitch.
  const dets = mk((t) => 0.5 + 0.012 * Math.sin(t * 2.3), 30);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16, cuts: [{ t: 15, score: 0.2 }] });
  const xs = kf.map((k) => k.x);
  const range = Math.max(...xs) - Math.min(...xs);
  check('a scene event with NO subject displacement does not move the camera', range < 0.01 * W, `moved ${range}px`);
}
{
  // WHIP PAN: the operator re-frames — a burst of scene events over ~0.4s while
  // the subject slides 0.55 -> 0.25 in under a second, with detections blurred out
  // mid-pan. The camera must land on the new framing quickly after the burst.
  const dets = mk((t) => (t < 12 ? 0.55 : t < 12.9 ? null : 0.25), 26).map((d) => (d.cxNorm === null ? { t: d.t, cxNorm: null } : d));
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16, cuts: [{ t: 12.1, score: 0.18 }, { t: 12.45, score: 0.21 }, { t: 12.8, score: 0.16 }] });
  check('camera lands on the post-whip-pan framing within ~0.7s', Math.abs(camAt(kf, 13.5) - 0.25 * W) < 0.04 * W, `${(camAt(kf, 13.5) / W).toFixed(3)} vs 0.250`);
  check('camera was still on the old framing before the pan', Math.abs(camAt(kf, 11.5) - 0.55 * W) < 0.03 * W, `${(camAt(kf, 11.5) / W).toFixed(3)} vs 0.550`);
}
{
  // CUT INTO A CROWD SHOT (nobody detectable): the new shot gets a CENTRED crop,
  // not a stale position left over from the previous angle.
  const dets = mk((t) => (t < 10 ? 0.72 : null), 20).map((d) => (d.cxNorm === null ? { t: d.t, cxNorm: null } : d));
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16, cuts: [{ t: 10, score: 0.6 }] });
  check('cut into a no-face crowd shot centres the crop', Math.abs(camAt(kf, 15) - 0.5 * W) < 0.02 * W, `${(camAt(kf, 15) / W).toFixed(3)} vs 0.500`);
}
{
  // A hard cut the scene pass MISSED entirely: the per-sample teleport fallback
  // (confirmed by the surrounding medians) must still split and snap.
  const dets = mk((t) => (t < 15 ? 0.30 : 0.70), 30);
  const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 }); // no cuts passed
  check('a missed cut is still caught by the teleport fallback', Math.abs(camAt(kf, 16) - 0.70 * W) < 0.04 * W, `${(camAt(kf, 16) / W).toFixed(3)} vs 0.700`);
}

// ---------- 9. CENTRING QUALITY: how far off-centre does the speaker actually sit? ----------
// The user-visible promise is "the speaker stays in the middle of the short", so
// measure exactly that: the gap between the camera and the speaker, expressed as
// a fraction of the OUTPUT frame width (0 = dead centre, 0.5 = at the edge).
{
  const SRC_W = 1280, SRC_H = 720;              // the real sermon's resolution
  const cropFrac = (9 / 16) / (SRC_W / SRC_H);  // crop width as a fraction of the source
  const offsets = (dets, kf) => dets.filter((d) => d.cxNorm != null)
    .map((d) => Math.abs(camAt(kf, d.t) / SRC_W - d.cxNorm) / cropFrac);
  const mk4 = (cxAt, secs) => { // the app samples the source at 4fps
    const out = [];
    for (let i = 0; i < secs * 4; i++) { const t = (i + 0.5) / 4; out.push({ t, cxNorm: cxAt(t), cyNorm: 0.5 }); }
    return out;
  };
  {
    // PACING: a preacher walking a 10s round trip across ±18% of the stage.
    // Averaging windows attenuate a real walk and a proportional-only pursuit
    // trails it — both used to leave the speaker a fifth of the frame off centre
    // at the turns, which reads as "the camera isn't following him".
    const dets = mk4((t) => 0.5 + 0.18 * Math.sin((t * 2 * Math.PI) / 10), 45);
    const offs = offsets(dets, FT.buildKeyframes(dets, SRC_W, SRC_H, { targetAR: 9 / 16 })).sort((a, b) => a - b);
    const avg = offs.reduce((a, b) => a + b, 0) / offs.length;
    const p90 = offs[Math.floor(offs.length * 0.9)];
    check('a pacing speaker stays near centre (avg < 8% of frame width)', avg < 0.08, `avg ${avg.toFixed(3)}`);
    check('a pacing speaker is rarely off-centre (p90 < 12%)', p90 < 0.12, `p90 ${p90.toFixed(3)}`);
  }
  {
    // HARD BOUND: whatever the speaker does — sprint, stop, reverse — the leash
    // must keep them inside the central 44% of the output (|offset| <= 0.22).
    const f = (t) => 0.5 + 0.30 * Math.sin(t / 1.7) * Math.cos(t / 5.3); // erratic, fast, unpredictable
    const dets = mk4(f, 60);
    const offs = offsets(dets, FT.buildKeyframes(dets, SRC_W, SRC_H, { targetAR: 9 / 16 }));
    const worst = Math.max(...offs);
    check('speaker NEVER leaves the central 44% of the short, even when erratic', worst <= 0.225, `worst ${worst.toFixed(3)} of frame width`);
  }
}

// ---------- 6. EXPORT SAFETY: dense path simplifies under the ffmpeg expression cap ----------
{
  // 120s clip with constant wandering — worst case for keyframe count
  const dets = mk((t) => 0.5 + 0.25 * Math.sin(t / 6), 120);
  const kf = FT.buildKeyframes(dets, W, H);
  const cropW = Math.round(H * (9 / 16) / 2) * 2, maxX = W - cropW;
  const pts = video.simplifyKeyframes(kf.map((k) => [k.t, Math.min(maxX, Math.max(0, Math.round(k.x - cropW / 2)))]));
  // The budget is about expression LENGTH now, not parser survival: buildLerpExpr
  // emits a flat sum of gated ramps, which reframe-export.test.js exercises end to
  // end at this density (and measures the rendered crop to the pixel).
  check('120s wandering path fits the ffmpeg expression budget (<=160 kf)', pts.length <= 160, `${kf.length} dense -> ${pts.length} keyframes`);
  const still = mk(() => 0.5, 120);
  const kf2 = FT.buildKeyframes(still, W, H);
  const pts2 = video.simplifyKeyframes(kf2.map((k) => [k.t, Math.min(maxX, Math.max(0, Math.round(k.x - cropW / 2)))]));
  check('a still speaker collapses to a handful of keyframes', pts2.length <= 6, `${pts2.length} keyframes`);
}

console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
process.exit(fail ? 1 : 0);
