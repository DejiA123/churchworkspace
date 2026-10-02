'use strict';
/*
 * WHO THE AUTO-REFRAME FOLLOWS — the identity layer, on made-up people.
 *
 * Every case here is a stage full of people whose looks and movements we choose
 * ourselves, so the answers are known exactly: no models, no video, no
 * eyeballing, and it runs in a second. (test/subject-real.test.js proves the
 * same thing end-to-end on a real recording, where the answers are only
 * knowable by looking.)
 *
 * The trick that makes this possible is `opts.signals`: detectFrames' expensive
 * half — two neural nets over every frame — is handed back on the result so
 * changing who to follow doesn't re-watch the clip, and handing it back IN
 * means the whole identity layer can be driven from a hand-written cast list.
 *
 *   node test/subject-lock.test.js
 */
global.window = {};
require('../src/renderer/facetrack.js');
const FT = global.window.FaceTrack;

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };

/* ---------------------------------------------------------------- casting -- */
const COL_N = 22;   // hue bins + lightness bins, per facetrack's descriptor
/** A person's look: mass on a few bins, so two "people" overlap as much as we say. */
function look(bins) {
  const h = new Float32Array(COL_N);
  let t = 0;
  for (const [i, w] of bins) { h[i % COL_N] += w; t += w; }
  for (let i = 0; i < COL_N; i++) h[i] /= t;
  return { head: h, up: h, lo: h };
}
/** Same person, slightly different light/angle — `drift` of their mass moves. */
function vary(sig, drift, at) {
  const h = Float32Array.from(sig.up);
  let moved = 0;
  for (let i = 0; i < COL_N && moved < drift; i++) {
    const take = Math.min(h[i], drift - moved);
    h[i] -= take; moved += take;
  }
  h[at % COL_N] += moved;
  return { head: h, up: h, lo: h };
}

const PURPLE = look([[2, 0.7], [3, 0.3]]);       // the bishop
const CREAM = look([[14, 0.75], [15, 0.25]]);    // the man holding the crozier
const GREY = look([[19, 0.9], [18, 0.1]]);       // somebody in the back row

/** Build a clip: `cast` is [{sig, cx, from, to, talk, size}] in seconds. */
function clip(cast, secs, fps = 6) {
  const frames = [], signals = [];
  for (let i = 0; i < secs * fps; i++) {
    const t = (i + 0.5) / fps;
    const people = [];
    for (const c of cast) {
      if (t < (c.from == null ? -1 : c.from) || t > (c.to == null ? 1e9 : c.to)) continue;
      const cx = typeof c.cx === 'function' ? c.cx(t) : c.cx;
      const bw = c.size || 0.10;
      people.push({
        cx, cy: 0.35, bw, bh: bw * 1.25, area: bw * bw * 1.25, score: 0.9,
        src: 'face', face: {}, pose: null,
        sig: c.drift ? vary(c.sig, c.drift * Math.abs(Math.sin(t)), 7) : c.sig,
        talk: c.talk,
      });
    }
    frames.push({ t, url: 'x' });
    signals.push({ t, cands: [], pose: null, people });
  }
  return { frames, signals };
}

const W = 1280, H = 720;
const run = async (c, opts) => FT.detectFrames(c.frames, Object.assign({ signals: c.signals }, opts || {}));
/** Where the crop actually sat, sampled at each detection time. */
const camPath = (kf, dets) => dets.map((d) => {
  const t = d.t;
  if (t <= kf[0].t) return kf[0].x / W;
  for (let i = 0; i < kf.length - 1; i++) {
    if (t < kf[i + 1].t) { const p = (t - kf[i].t) / (kf[i + 1].t - kf[i].t); return (kf[i].x + (kf[i + 1].x - kf[i].x) * p) / W; }
  }
  return kf[kf.length - 1].x / W;
});
const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  /* ---- 1. the signature itself ------------------------------------------ */
  console.log('\n[1] Appearance signatures');
  check('a look matches itself exactly', FT.sigSim(PURPLE, PURPLE) > 0.999);
  check('two different looks do not match', FT.sigSim(PURPLE, CREAM) < 0.05, FT.sigSim(PURPLE, CREAM).toFixed(3));
  check('a look survives being saved and re-loaded',
    FT.sigSim(PURPLE, FT.unpackSig(FT.packSig(PURPLE))) > 0.999);
  check('a half-lit version of the same person still matches well',
    FT.sigSim(PURPLE, vary(PURPLE, 0.25, 7)) > 0.7, FT.sigSim(PURPLE, vary(PURPLE, 0.25, 7)).toFixed(3));
  check('rubbish unpacks to nothing rather than throwing',
    FT.unpackSig(null) === null && FT.unpackSig({ head: [1, 2] }) === null);

  /* ---- 2. one speaker, nobody else -------------------------------------- */
  console.log('\n[2] One person on stage');
  {
    const c = clip([{ sig: PURPLE, cx: 0.62, talk: 0.4 }], 20);
    const dets = await run(c);
    check('somebody is identified', !!dets.subject);
    check('they are followed in every frame', dets.subject.frames === c.frames.length,
      dets.subject.frames + '/' + c.frames.length);
    const found = dets.filter((d) => d.cxNorm != null);
    check('every emitted position is theirs', found.every((d) => near(d.cxNorm, 0.62, 0.001)));
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    check('the crop settles on them', near(camPath(kf, dets).slice(-5)[0], 0.62, 0.02));
  }

  /* ---- 3. the case that broke the shipped exports ------------------------ */
  console.log('\n[3] A speaker beside a still, better-lit bystander');
  // The bystander is BIGGER, nearer the camera and detected in every frame; the
  // speaker is smaller and drops out of two frames in three. Size and coverage
  // both point the wrong way — only the mouth does not.
  const stage = [
    { sig: CREAM, cx: 0.24, size: 0.16, talk: 0.05 },
    { sig: PURPLE, cx: 0.62, size: 0.10, talk: 0.42, from: 0, to: 1e9 },
  ];
  {
    const c = clip(stage, 20);
    // thin the speaker out to a third of the frames, as real footage does
    c.signals.forEach((f, i) => { if (i % 3) f.people = f.people.filter((p) => p.sig !== PURPLE); });
    const dets = await run(c);
    check('two people are told apart', dets.subject.people.length >= 2, dets.subject.people.length + ' identities');
    const chosen = dets.subject.people.find((p) => p.id === dets.subject.id);
    check('the one whose mouth is moving is chosen', near(chosen.cx, 0.62, 0.02),
      'chose cx ' + chosen.cx.toFixed(2) + ' (speaker 0.62, bystander 0.24)');
    const found = dets.filter((d) => d.cxNorm != null);
    check('the bystander is never emitted', found.every((d) => !near(d.cxNorm, 0.24, 0.05)),
      found.filter((d) => near(d.cxNorm, 0.24, 0.05)).length + ' frames on the wrong man');
    check('frames without the speaker are gaps, not the other man',
      dets.filter((d) => d.noSubject).length > 0);
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    const cam = camPath(kf, dets);
    const half = 0.5 * (H * (9 / 16)) / W;
    check('the speaker stays inside the crop the whole time',
      cam.every((x) => Math.abs(x - 0.62) < half), 'worst ' + Math.max(...cam.map((x) => Math.abs(x - 0.62))).toFixed(3));
  }

  /* ---- 4. the user overrules it ----------------------------------------- */
  console.log('\n[4] The operator picks somebody');
  {
    const c = clip(stage, 20);
    const onCream = await run(c, { lock: CREAM });
    const onPurple = await run(c, { lock: PURPLE });
    const cxOf = (d) => d.filter((x) => x.cxNorm != null).map((x) => x.cxNorm);
    const a = cxOf(onCream), b = cxOf(onPurple);
    check('locking the bystander follows the bystander', a.length > 20 && a.every((x) => near(x, 0.24, 0.001)),
      a.length + ' frames, first ' + (a[0] || 0).toFixed(2));
    check('locking the speaker follows the speaker', b.length > 20 && b.every((x) => near(x, 0.62, 0.001)),
      b.length + ' frames, first ' + (b[0] || 0).toFixed(2));
    check('the two picks really are different crops',
      Math.abs((a[0] || 0) - (b[0] || 0)) > 0.3);
    check('a locked run says so', /locked/.test(onPurple.subject.why), onPurple.subject.why);
  }

  /* ---- 5. a lock for somebody who is not in this clip -------------------- */
  console.log('\n[5] Locked on somebody who is not in this clip');
  {
    const c = clip([{ sig: CREAM, cx: 0.30, talk: 0.3 }], 15);
    const dets = await run(c, { lock: GREY });
    check('it does not follow the nearest stranger instead',
      dets.subject && /auto/.test(dets.subject.why), dets.subject ? dets.subject.why : 'no subject');
    const found = dets.filter((d) => d.cxNorm != null);
    check('the clip is still tracked (falls back to the automatic pick)', found.length > 50, found.length + ' frames');
  }

  /* ---- 6. following somebody who walks ----------------------------------- */
  console.log('\n[6] The speaker walks across the stage');
  {
    const walk = (t) => 0.30 + 0.40 * Math.min(1, Math.max(0, (t - 4) / 8));
    const c = clip([
      { sig: PURPLE, cx: walk, talk: 0.4 },
      { sig: CREAM, cx: 0.85, size: 0.14, talk: 0.04 },
    ], 20);
    const dets = await run(c, { lock: PURPLE });
    const found = dets.filter((d) => d.cxNorm != null);
    check('the walk is followed, not the person standing still',
      found.every((d) => near(d.cxNorm, walk(d.t), 0.02)), found.length + ' frames');
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    const cam = camPath(kf, dets);
    const off = dets.map((d, i) => Math.abs(cam[i] - walk(d.t)));
    const half = 0.5 * (H * (9 / 16)) / W;
    check('they never leave the crop while walking', Math.max(...off) < half,
      'worst ' + Math.max(...off).toFixed(3) + ' of ' + half.toFixed(3));
    // smoothness: the crop must not jitter frame to frame
    let worstStep = 0;
    for (let i = 1; i < cam.length; i++) worstStep = Math.max(worstStep, Math.abs(cam[i] - cam[i - 1]));
    check('the crop moves smoothly (no jumps between samples)', worstStep < 0.06,
      'worst step ' + worstStep.toFixed(4) + ' of frame width');
  }

  /* ---- 7. two people who look alike ------------------------------------- */
  console.log('\n[7] Two people dressed the same');
  {
    // Same vestments, different places. Appearance cannot separate them, so the
    // tracker must fall back on continuity and NOT flip between them.
    const c = clip([
      { sig: PURPLE, cx: 0.30, talk: 0.4 },
      { sig: PURPLE, cx: 0.75, talk: 0.4 },
    ], 20);
    const dets = await run(c, { lock: PURPLE });
    const found = dets.filter((d) => d.cxNorm != null);
    const flips = found.filter((d, i) => i && Math.abs(d.cxNorm - found[i - 1].cxNorm) > 0.3).length;
    check('it settles on one of them instead of ping-ponging', flips <= 1, flips + ' switches');
  }

  /* ---- 8. re-using the expensive half ------------------------------------ */
  console.log('\n[8] Changing who to follow is cheap');
  {
    const c = clip(stage, 20);
    const first = await run(c);
    check('the signals come back for re-use', Array.isArray(first.signals) && first.signals.length === c.frames.length);
    const again = await FT.detectFrames(c.frames, { signals: first.signals, lock: PURPLE });
    const cx = again.filter((d) => d.cxNorm != null).map((d) => d.cxNorm);
    check('a second pick off the same signals follows the new person',
      cx.length > 20 && cx.every((x) => near(x, 0.62, 0.001)));
    check('re-using signals does not leave the first answer behind',
      first.signals.every((f) => !f.subject || f.subject.sig === PURPLE));
  }

  /* ---- 8b. a recording the camera operator already framed ----------------- */
  console.log('');
  console.log('[8b] A recording that is already well framed');
  {
    // one speaker, dead centre, barely moving — the lectern shot
    const c = clip([{ sig: PURPLE, cx: (t) => 0.5 + 0.012 * Math.sin(t * 1.7), talk: 0.4 }], 20);
    const dets = await run(c);
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    check('it notices there was nothing to do', kf.alreadyCentred === true);
    const cam = camPath(kf, dets);
    check('and the crop is a fixed centre crop in all but name',
      Math.max(...cam.map((x) => Math.abs(x - 0.5))) < 0.02,
      'worst ' + Math.max(...cam.map((x) => Math.abs(x - 0.5))).toFixed(4) + ' from centre');
  }
  {
    // the same speaker standing to one side: there IS something to do
    const c = clip([{ sig: PURPLE, cx: 0.72, talk: 0.4 }], 20);
    const dets = await run(c);
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    check('a speaker standing off to one side is not called centred', !kf.alreadyCentred);
  }

  /* ---- 9. nobody at all -------------------------------------------------- */
  console.log('\n[9] Nothing to follow');
  {
    const c = clip([], 10);
    const dets = await run(c);
    check('an empty stage does not crash', Array.isArray(dets) && dets.length === c.frames.length);
    check('...and reports no subject', !dets.subject);
    const kf = FT.buildKeyframes(dets, W, H, { targetAR: 9 / 16 });
    check('...and still produces a (centred) crop', kf.length >= 1 && near(kf[0].x / W, 0.5, 0.01));
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})();
