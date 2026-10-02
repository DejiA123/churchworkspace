'use strict';
/*
 * ☁️ THE REFEREE — "which of these people is preaching?" — on made-up people.
 *
 * The tracker can be told, for a few frames, which COLUMN of the picture the
 * speaker's head is in (the studio asks a cloud vision model, frames ruled into
 * eight numbered columns: src/main/cloudsee.js). This proves what it does with
 * those answers, on a cast whose truth we choose, so every answer is known
 * exactly and it runs in a second:
 *
 *   [1] the case the PC gets wrong: somebody beside the preacher is moving
 *       their mouth more (an interpreter, a singer) — the referee settles it
 *   [2] two camera angles in which the preacher LOOKS different: colour
 *       matching cannot bridge them, the referee's answer in each shot does
 *   [3] a cutaway to the congregation: "nobody here is speaking" means the
 *       crop follows nobody there — not the only person in shot
 *   [4] what it is shown, and how a column becomes a person: snapped to the
 *       one detected there; two bodies in one column left to the tracker; a
 *       backdrop "face" never counts; and where the detectors MISSED him, the
 *       column itself is where the crop goes — and a PC pick it contradicts
 *       is dropped
 *   [5] what must NOT change: no referee, a referee that fails, the
 *       operator's own 👤 pick (which the referee never overrides), and a
 *       second pick on the same signals (which never asks twice)
 *
 *   node test/reframe-referee.test.js
 */
global.window = {};
require('../src/renderer/facetrack.js');
const FT = global.window.FaceTrack;

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };

const COL_N = 22;
function look(bins) {
  const h = new Float32Array(COL_N);
  let t = 0;
  for (const [i, w] of bins) { h[i % COL_N] += w; t += w; }
  for (let i = 0; i < COL_N; i++) h[i] /= t;
  return { head: h, up: h, lo: h };
}
const PREACHER = look([[2, 0.7], [3, 0.3]]);       // denim jacket, wide shot
const PREACHER_CLOSE = look([[9, 0.6], [10, 0.4]]); // the same man under the close-up camera's light
const HELPER = look([[14, 0.75], [15, 0.25]]);     // beside him, talking more (an interpreter)
const PEW = look([[19, 0.9], [18, 0.1]]);          // a congregant

/**
 * shots: [{ from, to, cast: [{ who, sig, cx, talk, size, body }] }] — seconds.
 * Every person is body-backed unless body === false; `missed: true` is a
 * person the detectors never find (too small, too dark) — still there for the
 * referee, who sees the real picture.
 */
function clip(shots, fps = 6) {
  const end = Math.max(...shots.map((s) => s.to));
  const frames = [], signals = [], truth = [];
  for (let i = 0; i < end * fps; i++) {
    const t = (i + 0.5) / fps;
    const shot = shots.find((s) => t >= s.from && t < s.to);
    const people = (shot ? shot.cast : []).filter((c) => !c.missed).map((c) => {
      const bw = c.size || 0.08;
      return { who: c.who, cx: c.cx, cy: 0.35, bw, bh: bw * 1.25, area: bw * bw * 1.25, score: 0.9,
        src: 'face', face: {}, pose: c.body === false ? null : { cx: c.cx, cy: 0.35, headW: bw }, sig: c.sig, talk: c.talk };
    });
    frames.push({ t, url: 'x' });
    truth.push(shot ? shot.cast.map((c) => ({ who: c.who, cx: c.cx })) : []);
    signals.push({ t, cands: [], pose: null, people });
  }
  const cuts = shots.slice(1).map((s) => ({ t: s.from, score: 0.5 }));
  return { frames, signals, cuts, truth };
}
/** The column (1..8) a position falls in. */
const colOf = (cx) => Math.min(8, Math.floor(cx * 8) + 1);
/** A referee that sees the real picture: the speaker's column, or 0. `c` is the clip (its truth). */
function honest(speakerWho, c, log) {
  return async ({ frames, tiles, columns }) => {
    if (log) log.push(tiles.map((t) => ({ i: t.i, columns })));
    const answers = {};
    for (const t of tiles) {
      const sp = c.truth[t.i].find((p) => speakerWho.includes(p.who));
      answers[t.label] = { column: sp ? colOf(sp.cx) : 0, sure: true };
    }
    return { ok: true, answers, model: 'fake/honest', frames };
  };
}
const cxAt = (dets, i) => dets[i].cxNorm;
const run = (c, opts) => FT.detectFrames(c.frames, Object.assign({ signals: c.signals, cuts: c.cuts }, opts || {}));
const whoAt = (c, dets) => dets.map((d, i) => {
  if (d.cxNorm == null) return null;
  const p = c.signals[i].people.find((q) => Math.abs(q.cx - d.cxNorm) < 0.005);
  return p ? p.who : '?';
});
const share = (arr, who) => arr.filter((w) => w === who).length / Math.max(1, arr.filter((w) => w != null).length);

(async () => {
  /* ---- [1] the helper who talks more ----------------------------------- */
  console.log('\n[1] The person beside the preacher is moving their mouth more');
  const makeBusy = () => clip([{ from: 0, to: 20, cast: [
    { who: 'helper', sig: HELPER, cx: 0.30, talk: 0.50, size: 0.10 },
    { who: 'preacher', sig: PREACHER, cx: 0.66, talk: 0.18, size: 0.08 },
  ] }]);
  const busy = makeBusy();
  {
    const local = await run(busy);
    const w = whoAt(busy, local);
    check('without the referee the PC picks the helper (the failure this exists for)', share(w, 'helper') > 0.9,
      Math.round(share(w, 'helper') * 100) + '% helper');
  }
  {
    const asked = [];
    const dets = await run(busy, { referee: honest(['preacher'], busy, asked) });
    const w = whoAt(busy, dets);
    check('with it, the preacher is followed', share(w, 'preacher') === 1, Math.round(share(w, 'preacher') * 100) + '% preacher');
    check('…in every frame', w.filter((x) => x === 'preacher').length === busy.frames.length, w.filter((x) => x === 'preacher').length + '/' + busy.frames.length);
    check('the report says what the AI did', dets.referee && dets.referee.ok && dets.referee.vouched >= 1 && dets.referee.model === 'fake/honest', JSON.stringify(dets.referee));
    check('…and who was followed says it was the AI', /AI (picked|confirmed) the speaker/.test(dets.subject.why), dets.subject.why);
  }

  /* ---- [2] two angles, two looks --------------------------------------- */
  console.log('\n[2] Two camera angles in which the preacher looks different');
  const makeAngles = () => clip([
    { from: 0, to: 12, cast: [
      { who: 'helper', sig: HELPER, cx: 0.28, talk: 0.45, size: 0.10 },
      { who: 'preacher', sig: PREACHER, cx: 0.62, talk: 0.2 }] },
    { from: 12, to: 24, cast: [
      { who: 'preacher', sig: PREACHER_CLOSE, cx: 0.45, talk: 0.2, size: 0.18 },
      { who: 'pew', sig: PEW, cx: 0.85, talk: 0.05, size: 0.06 }] },
  ]);
  const angles = makeAngles();
  {
    const dets = await run(angles, { referee: honest(['preacher'], angles) });
    const w = whoAt(angles, dets);
    const s1 = w.slice(0, 72), s2 = w.slice(72);
    check('the wide shot follows the preacher', share(s1, 'preacher') === 1 && s1.filter(Boolean).length > 60, s1.filter((x) => x === 'preacher').length + '/72');
    check('the close-up follows him too, though he looks nothing alike there', share(s2, 'preacher') === 1 && s2.filter(Boolean).length > 60, s2.filter((x) => x === 'preacher').length + '/72');
    check('the congregant is never followed', !w.includes('pew') && !w.includes('helper'));
  }

  /* ---- [3] a cutaway to the congregation -------------------------------- */
  console.log('\n[3] A cutaway to the congregation');
  const cutaway = clip([
    { from: 0, to: 10, cast: [{ who: 'preacher', sig: PREACHER, cx: 0.5, talk: 0.3 }] },
    { from: 10, to: 16, cast: [{ who: 'pew', sig: PEW, cx: 0.7, talk: 0.02 }] },
    { from: 16, to: 26, cast: [{ who: 'preacher', sig: PREACHER, cx: 0.55, talk: 0.3 }] },
  ]);
  {
    const local = await run(cutaway);
    const lw = whoAt(cutaway, local).slice(60, 96);
    const dets = await run(cutaway, { referee: honest(['preacher'], cutaway) });
    const w = whoAt(cutaway, dets);
    check('the referee is asked about the cutaway and says nobody there is speaking', dets.referee.none >= 1, JSON.stringify(dets.referee));
    check('so the crop follows nobody in it (not the only person in shot)', w.slice(60, 96).every((x) => x == null),
      w.slice(60, 96).filter((x) => x === 'pew').length + ' frames on the congregant (this PC alone: ' + lw.filter((x) => x === 'pew').length + ')');
    check('…and the preacher on either side of it', share(w.slice(0, 60), 'preacher') === 1 && share(w.slice(96), 'preacher') === 1);
  }
  {
    // The model's commonest real mistake: "cannot see him" about a small
    // preacher on a wide stage who IS there (two pictures in three, measured).
    // In a shot where the PC recognises him, that must cost one frame, not the shot.
    const wide = clip([
      { from: 0, to: 10, cast: [{ who: 'helper', sig: HELPER, cx: 0.25, talk: 0.5, size: 0.1 }, { who: 'preacher', sig: PREACHER, cx: 0.6, talk: 0.2 }] },
      { from: 10, to: 20, cast: [{ who: 'helper', sig: HELPER, cx: 0.3, talk: 0.5, size: 0.1 }, { who: 'preacher', sig: PREACHER, cx: 0.7, talk: 0.2 }] },
    ]);
    const blindInShot2 = async ({ tiles }) => ({ ok: true, model: 'fake', answers: Object.fromEntries(tiles.map((t) => {
      const sp = wide.truth[t.i].find((p) => p.who === 'preacher');
      return [t.label, { column: wide.frames[t.i].t >= 10 ? 0 : colOf(sp.cx), sure: true }];
    })) });
    const dets = await run(wide, { referee: blindInShot2 });
    const w2 = whoAt(wide, dets).slice(60);
    check('a wrong "cannot see him" costs that frame, not the shot he is recognised in',
      w2.filter((x) => x === 'preacher').length >= 58 && !w2.includes('helper'), w2.filter((x) => x === 'preacher').length + '/60 frames on him');
  }

  /* ---- [4] what the referee is shown, and how a column becomes a person - */
  console.log('\n[4] What the referee is shown, and how a column becomes a person');
  {
    const asked = [];
    const fresh = makeAngles();   // signals remember they were asked about — that is [5]'s point
    await run(fresh, { referee: honest(['preacher'], fresh, asked) });
    const shown = asked.flat();
    const shotsShown = new Set(shown.map((x) => (fresh.frames[x.i].t < 12 ? 1 : 2)));
    check('at least one frame from every shot', shotsShown.size === 2, JSON.stringify([...shotsShown]));
    check('no more than twelve frames in all, in at most two pictures', shown.length <= 12 && asked.length <= 2, shown.length + ' frames, ' + asked.length + ' asks');
    check('each ruled into eight columns', shown.every((x) => x.columns === 8));

    // the column snaps to the person DETECTED there — their exact position, not the column's middle
    const off = clip([{ from: 0, to: 10, cast: [
      { who: 'helper', sig: HELPER, cx: 0.22, talk: 0.5, size: 0.1 },
      { who: 'preacher', sig: PREACHER, cx: 0.655, talk: 0.1 }] }]);   // column 6 runs 0.625-0.75
    const snapped = await run(off, { referee: honest(['preacher'], off) });
    check('a column answer follows the person detected in it, at their own position', snapped.every((d) => d.cxNorm === 0.655),
      'cx ' + snapped[0].cxNorm + ' (column centre would be 0.6875)');

    // one column out on a boundary still finds him (it happens: measured once in twelve)
    const edge = clip([{ from: 0, to: 10, cast: [
      { who: 'helper', sig: HELPER, cx: 0.2, talk: 0.5, size: 0.1 },
      { who: 'preacher', sig: PREACHER, cx: 0.61, talk: 0.1 }] }]);   // column 5, right at the edge of 6
    const oneOut = await run(edge, { referee: async ({ tiles }) => ({ ok: true, model: 'fake', answers: Object.fromEntries(tiles.map((t) => [t.label, { column: 6, sure: true }])) }) });
    check('…and one column out, on a boundary, still finds him', share(whoAt(edge, oneOut), 'preacher') === 1);

    // two bodies in the column the answer names: a column cannot say which
    const pair = clip([{ from: 0, to: 10, cast: [
      { who: 'helper', sig: HELPER, cx: 0.66, talk: 0.5, size: 0.1 },
      { who: 'preacher', sig: PREACHER, cx: 0.70, talk: 0.1 }] }]);
    const both = await run(pair, { referee: honest(['preacher'], pair) });
    check('two bodies in the same column are left to the tracker, not guessed', both.referee.unsure >= 1 && both.referee.vouched === 0, JSON.stringify(both.referee));

    // a bodiless "face" a fifth of the frame wide in the named column is the backdrop
    const wall = clip([{ from: 0, to: 10, cast: [
      { who: 'S', sig: PEW, cx: 0.72, talk: 0.0, size: 0.2, body: false },
      { who: 'preacher', sig: PREACHER, cx: 0.66, talk: 0.1, missed: true },
      { who: 'helper', sig: HELPER, cx: 0.25, talk: 0.5, size: 0.1 }] }]);
    const w2 = await run(wall, { referee: honest(['preacher'], wall) });
    check('a backdrop "face" in that column is never taken for him', !whoAt(wall, w2).includes('S'), JSON.stringify(w2.referee));

    // the detectors never found him at all: the column is where the crop goes
    const small = clip([
      { from: 0, to: 12, cast: [
        { who: 'pew', sig: PEW, cx: 0.15, talk: 0.3, size: 0.14 },          // big, near the camera, mouth moving
        { who: 'preacher', sig: PREACHER, cx: 0.74, talk: 0.2, missed: true }] }]);
    const localSmall = await run(small);
    const aiSmall = await run(small, { referee: honest(['preacher'], small) });
    const hinted = aiSmall.filter((d) => d.refereed);
    check('without the AI the PC follows the only person it can find — the congregant', share(whoAt(small, localSmall), 'pew') === 1);
    check('with it, the frames it was shown put the crop in his column', hinted.length >= 1 && hinted.every((d) => Math.abs(d.cxNorm - 0.6875) < 1e-9),
      hinted.length + ' frames at ' + (hinted[0] && hinted[0].cxNorm));
    check('…and the PC\'s pick, which those columns contradict, is dropped — the congregant is never followed',
      !whoAt(small, aiSmall).includes('pew'), whoAt(small, aiSmall).filter((x) => x === 'pew').length + ' frames on the congregant');
    const kf = FT.buildKeyframes(aiSmall, 1280, 720, { targetAR: 9 / 16 });
    const camX = kf.reduce((m, k) => m + k.x, 0) / kf.length / 1280;
    check('…so the 9:16 crop sits over him for the whole clip', kf.every((k) => Math.abs(k.x / 1280 - 0.74) < 0.158), 'crop centre ~' + camX.toFixed(3) + ', him at 0.74');
  }

  /* ---- [5] what must not change ----------------------------------------- */
  console.log('\n[5] What must not change');
  {
    // every case on a clip nobody has asked about: signals remember answers
    const plain = await run(makeBusy());
    const failed = await run(makeBusy(), { referee: async () => ({ ok: false, why: 'could not reach the AI (no internet?)' }) });
    check('a referee that cannot be reached changes nothing', plain.every((d, i) => d.cxNorm === failed[i].cxNorm));
    check('…and its reason is reported, not swallowed', failed.referee && failed.referee.ok === false && /no internet/.test(failed.referee.why), JSON.stringify(failed.referee));
    const threw = await run(makeBusy(), { referee: async () => { throw new Error('boom'); } });
    check('a referee that throws changes nothing either', plain.every((d, i) => d.cxNorm === threw[i].cxNorm));

    let calls = 0;
    const counting = (clipObj) => async (a) => { calls++; return honest(['preacher'], clipObj)(a); };
    const lockedClip = makeBusy();
    const locked = await run(lockedClip, { lock: HELPER, referee: counting(lockedClip) });
    check('the operator\'s own 👤 pick wins: the referee is not even asked', calls === 0 && share(whoAt(lockedClip, locked), 'helper') === 1, calls + ' calls');

    calls = 0;
    const c = makeBusy();
    const first = await run(c, { referee: counting(c) });
    const again = await FT.detectFrames(c.frames, { signals: first.signals, cuts: c.cuts, referee: counting(c) });
    check('a second pass over the same signals does not ask again', calls === 1, calls + ' calls');
    check('…and still follows the preacher from the first answer', share(whoAt(c, again), 'preacher') === 1);
    const off = await FT.detectFrames(c.frames, { signals: first.signals, cuts: c.cuts });
    check('the same signals with the AI switched off behave as if it had never been asked',
      plain.every((d, i) => d.cxNorm === off[i].cxNorm) && !off.referee);
    // …while a pass whose referee FAILED asks again next time (the internet may be back)
    calls = 0;
    const d = makeBusy();
    const down = await run(d, { referee: async () => ({ ok: false, why: 'offline' }) });
    await FT.detectFrames(d.frames, { signals: down.signals, cuts: d.cuts, referee: counting(d) });
    check('a failed ask is tried again on the next pass', calls === 1, calls + ' calls');
  }

  /* ---- [6] a blip is not a walk (no referee needed) -------------------- */
  // "Time of Prayers" t=8460: the preacher sat still at the right edge for a
  // minute and the crop left him out of shot for 11.5 s, each time because
  // somebody walking past in front was taken for him for a few samples.
  console.log('\n[6] A blip is not a walk');
  {
    const fps = 6, secs = 20;
    const frames = [], signals = [];
    const passBy = (t) => (t > 5 && t < 5.6) || (t > 12 && t < 14.4 && Math.floor(t * 6) % 3 === 0);   // short, and long-but-sparse
    for (let i = 0; i < secs * fps; i++) {
      const t = (i + 0.5) / fps;
      const people = [];
      // the preacher, seated: found most of the time — but not while somebody walks in front
      if (!passBy(t) && !(t > 12 && t < 14.4)) people.push({ who: 'preacher', cx: 0.93, cy: 0.4, bw: 0.05, bh: 0.06, area: 0.003, score: 0.9, src: 'face', face: {}, pose: { cx: 0.93, cy: 0.4, headW: 0.05 }, sig: PREACHER, talk: 0.3 });
      // the passer-by, close to the lens, coloured enough like him to be "recognised"
      if (passBy(t)) people.push({ who: 'passer', cx: t < 8 ? 0.55 : 0.55 + (t - 12) * 0.05, cy: 0.5, bw: 0.12, bh: 0.15, area: 0.018, score: 0.9, src: 'face', face: {}, pose: { cx: 0.55, cy: 0.5, headW: 0.12 }, sig: PREACHER, talk: 0.1 });
      frames.push({ t, url: 'x' }); signals.push({ t, cands: [], pose: null, people });
    }
    const passerCuts = [{ t: 5.05, score: 0.4 }, { t: 5.55, score: 0.4 }];   // a body that close to the lens reads as a cut too
    const before = await FT.detectFrames(frames, { signals, cuts: passerCuts, blips: false });
    const after = await FT.detectFrames(frames, { signals: before.signals, cuts: passerCuts });
    const onPasser = (d) => d.filter((x) => x.cxNorm != null && x.cxNorm < 0.8).length;
    check('as shipped, the passer-by was followed', onPasser(before) >= 4, onPasser(before) + ' samples');
    check('now nobody but the preacher is followed', onPasser(after) === 0, onPasser(after) + ' samples on the passer-by; ' + after.subject.blips + ' blips dropped');
    const kfB = FT.buildKeyframes(before, 1280, 720, { targetAR: 9 / 16, cuts: passerCuts });
    const kfA = FT.buildKeyframes(after, 1280, 720, { targetAR: 9 / 16, cuts: passerCuts });
    const outOfShot = (kf) => kf.filter((k) => 0.93 - k.x / 1280 > 0.158).length;
    check('…so the crop never leaves him', outOfShot(kfA) === 0, 'keyframes with him out of shot: before ' + outOfShot(kfB) + ', now ' + outOfShot(kfA));

    // and a preacher who really paces out and back is never "a blip"
    const walk = [], wsig = [];
    for (let i = 0; i < secs * fps; i++) {
      const t = (i + 0.5) / fps;
      const cx = t < 4 ? 0.85 : t < 7 ? 0.85 - (t - 4) * 0.13 : t < 10 ? 0.46 + (t - 7) * 0.13 : 0.85;   // 0.39 out and back in 6 s
      const seenNow = i % 2 === 0 || t < 4 || t > 10;   // recognised in every other sample while moving
      walk.push({ t, url: 'x' });
      wsig.push({ t, cands: [], pose: null, people: seenNow ? [{ cx, cy: 0.4, bw: 0.06, bh: 0.075, area: 0.0045, score: 0.9, src: 'face', face: {}, pose: { cx, cy: 0.4, headW: 0.06 }, sig: PREACHER, talk: 0.3 }] : [] });
    }
    const paced = await FT.detectFrames(walk, { signals: wsig });
    const far = paced.filter((d) => d.cxNorm != null && d.cxNorm < 0.6).length;
    const there = wsig.filter((f) => f.people.length && f.people[0].cx < 0.6).length;
    check('a preacher who walks out and back is followed all the way', paced.subject.blips === 0 && far === there && there >= 5, far + ' of ' + there + ' sightings at the far end kept, ' + paced.subject.blips + ' dropped');

    // Shipped once and caught on real footage ("Thanksgiving Sunday"): the
    // second pass read the position of a sample it had just dropped, threw,
    // and the safety net quietly skipped the whole identity layer for the clip.
    // Thousands of jumbled tracks: it must never throw, and a smooth walk —
    // however sparse its sightings — must never lose a sample.
    let threw = 0, walksTrimmed = 0;
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let n = 0; n < 3000; n++) {
      const len = 30 + Math.floor(rnd() * 150), fr = [], tr = [], walk = [];
      let x = rnd(), v = (rnd() - 0.5) * 0.08;
      for (let i = 0; i < len; i++) {
        fr.push({ t: i / 6 });
        x = Math.min(1, Math.max(0, x + v / 6)); if (rnd() < 0.05) v = (rnd() - 0.5) * 0.08;   // ≤ 0.04 widths/s: a walk
        const seenIt = rnd() < 0.6;
        walk.push(seenIt ? { cx: x } : null);
        tr.push(!seenIt ? null : rnd() < 0.15 ? { cx: rnd() } : { cx: x });                      // with passers-by mixed in
      }
      try { FT._dropBlips(fr, tr); } catch (e) { threw++; }
      try { if (FT._dropBlips(fr, walk).blips) walksTrimmed++; } catch (e) { threw++; }
    }
    check('3,000 jumbled tracks: it never throws', threw === 0, threw + ' threw');
    check('…and never trims a smooth walk', walksTrimmed === 0, walksTrimmed + ' walks trimmed');
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
