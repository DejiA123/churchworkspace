'use strict';
/*
 * On-device face tracking for auto-reframe. Loads MediaPipe (bundled, offline
 * via the mwasset:// scheme), detects the speaker in sampled frames, and builds
 * a smoothed pan path so the person stays centered in vertical shorts.
 */
(function () {
  let detector = null, poser = null, initPromise = null;
  let lite = false;   // faces only — the pose model is the heavy one (see setLite)

  /*
   * Where the MediaPipe bundle, wasm and models live.
   *
   * In the desktop window that is the privileged `mwasset://` scheme main.js
   * registers. Phone Studio serves this exact file to a phone over HTTP, where
   * no custom scheme exists — so it sets `window.MW_AI_BASE` to the PC's `/ai/`
   * route and the same tracker runs unmodified in mobile Safari. One tracker,
   * two transports: a phone export follows the same crop path as a desktop one.
   */
  const assetBase = () => (typeof window !== 'undefined' && window.MW_AI_BASE) || 'mwasset://';
  const asset = (rel) => assetBase() + rel;

  /*
   * ►► WHICH PROCESSOR WATCHES THE FOOTAGE — AND WHY IT IS STILL THE CPU. ◄◄
   *
   * MediaPipe defaults to the CPU on the web, which is what this gets by saying
   * nothing. Tracking is the larger half of a shorts export, so the GPU delegate
   * is the obvious thing to reach for, and in ISOLATION it looks like a rout:
   * timing the two models on their own over 180 stills, GPU was 2.47x faster
   * (the pose model 24.8s -> 8.6s).
   *
   * MEASURED THROUGH THE REAL TRACKER IT IS WORTH 1.07x. 40.6s -> 37.8s over 360
   * samples of a real sermon. The models are not the bulk of detectSignals: the
   * zoomed re-detect, the pixel readback, the colour signature and the mouth
   * pair are, and none of them care which delegate ran the nets. What little the
   * GPU wins back it spends uploading each still as a texture.
   *
   * And it is not free. A different delegate is a different numerical path, and
   * the two disagree about where to point the camera by a mean of 21px and a
   * worst of 93px — 23% of a 406px crop window. This tracker's framing has been
   * fought for twice (reframe-who-to-follow, reframe-rebuild); moving the
   * speaker by a quarter of the frame to save 7% is not a trade worth making.
   *
   * So the default is unchanged, exactly: with MW_AI_DELEGATE unset the options
   * object handed to MediaPipe has no `delegate` key at all, as it always did.
   * The switch stays so the comparison can be RE-RUN (test/diag-delegate-path.js)
   * rather than re-argued — if a future machine or model changes the arithmetic,
   * measure it there first. A delegate that will not build falls back to the
   * CPU rather than leaving the studio with no tracker.
   */
  let delegateUsed = null;
  const wantDelegate = () => {
    if (typeof window === 'undefined') return null;
    return window.MW_AI_DELEGATE === undefined ? null : window.MW_AI_DELEGATE;
  };
  async function init() {
    if (detector) return detector;
    if (!initPromise) initPromise = (async () => {
      const mp = await import(asset('vision_bundle.mjs'));
      const vision = await mp.FilesetResolver.forVisionTasks(asset('wasm'));
      const want = wantDelegate();
      const baseOpts = (file, d) => {
        const o = { modelAssetPath: asset(file) };
        if (d) o.delegate = d;
        return o;
      };
      const makeFace = (d) => mp.FaceDetector.createFromOptions(vision, {
        baseOptions: baseOpts('blaze_face_short_range.tflite', d),
        runningMode: 'IMAGE', minDetectionConfidence: 0.2, // lower = fewer missed frames (spikes are pruned later)
      });
      try {
        detector = await makeFace(want);
        delegateUsed = want || 'CPU';
      } catch (e) {
        if (!want) throw e;
        console.warn('face detector: ' + want + ' delegate unavailable, using the processor:', e && e.message);
        detector = await makeFace(null);
        delegateUsed = 'CPU';
      }
      // POSE tracker runs ALONGSIDE the face detector (also free + on-device):
      // when the speaker turns their back or bows their head the face vanishes,
      // but the body doesn't — the pose model keeps the camera locked on. It's
      // optional: if the model is missing/fails, face-only tracking still works.
      const makePose = (d) => mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: baseOpts('pose_landmarker_lite.task', d),
        // Several bodies, not one: a platform holds the preacher, whoever is
        // being prayed for and two or three clergy, and the identity layer
        // needs to see all of them to know which is which. (numPoses:1 hands
        // back whichever the model liked best that frame, which on a busy
        // stage silently changes person mid-clip.)
        runningMode: 'IMAGE', numPoses: 4, minPoseDetectionConfidence: 0.3,
      });
      if (lite) { poser = null; return detector; }
      try {
        // Follows the face detector: if that one had to come back to the CPU,
        // this must too, or the clip is watched by two different processors.
        poser = await makePose(delegateUsed === 'CPU' ? null : want);
      } catch (e) {
        try { poser = await makePose(null); }
        catch (e2) { poser = null; console.warn('Pose tracker unavailable (face-only tracking):', e2 && e2.message); }
      }
      return detector;
    })();
    return initPromise;
  }

  /** Head position from a pose result (normalized 0..1), or null. Prefers the
   *  nose landmark; falls back to the shoulder midpoint nudged up to head height.
   *  headW = plausible head width derived from the shoulder span (null when the
   *  shoulders aren't visible) — used to spot face boxes far too big to be this
   *  person's head (faces printed on the stage backdrop detect HUGE). */
  function poseHead(r) {
    const heads = poseHeads(r);
    return heads.length ? heads[0] : null;
  }
  /** Every body in the frame, not just the most prominent one — the identity
   *  layer needs them all, because the person the camera is FOLLOWING is often
   *  not the one the pose model would rank first. */
  function poseHeads(r) {
    const sets = (r && r.landmarks) || [];
    const out = [];
    for (const lm of sets) {
      if (!lm || !lm.length) continue;
      const vis = (p) => !!p && (p.visibility == null || p.visibility > 0.3);
      const nose = lm[0], ls = lm[11], rs = lm[12];
      const headW = vis(ls) && vis(rs) ? Math.max(0.015, 0.65 * Math.abs(ls.x - rs.x)) : null;
      if (vis(nose)) out.push({ cx: nose.x, cy: nose.y, headW });
      else if (vis(ls) && vis(rs)) out.push({ cx: (ls.x + rs.x) / 2, cy: (ls.y + rs.y) / 2 - 0.10, headW });
    }
    // biggest body first: with numPoses > 1 the legacy single-pose paths below
    // should still see the most prominent person, as they always did.
    out.sort((a, b) => (b.headW || 0) - (a.headW || 0));
    return out;
  }

  /* ======================= WHO ARE WE FOLLOWING? =========================
   *
   * Everything above answers "where is a face". On a church platform that is
   * NOT the same question as "where is the speaker". A bishop preaching with a
   * crozier-bearer beside him, two ministers sharing a mic, a row of clergy on
   * the platform — the face detector sees them all, and "biggest box, stick to
   * it" reliably picks the wrong one: measured on a real convention export, the
   * crop sat on the attendant (nearer the camera, perfectly still, brightly lit
   * in a cream suit) for a whole 2m50s short while the man actually speaking
   * stood at the frame edge, half out of shot.
   *
   * So the tracker now carries an IDENTITY layer underneath the geometry:
   *
   *  1. Every frame yields PEOPLE, not just faces — each face candidate plus
   *     any body the pose model found that no face belongs to (a speaker who
   *     turns away or bows over a microphone loses their face, never their
   *     body).
   *  2. Each person gets an APPEARANCE SIGNATURE: a coarse colour histogram of
   *     the head patch and of the torso below it. Clothing is what separates
   *     people on a platform — purple vestments, a cream suit, a grey jacket —
   *     and unlike position it survives a camera cut, which is what lets the
   *     SAME person be recognised in a wide shot and a close-up.
   *  3. Signatures are clustered over the whole clip into person IDs.
   *  4. One cluster is chosen as the subject — by the user's own pick when they
   *     have made one (`opts.lock`), otherwise by a score built from how much
   *     of the clip the person is in, how many different camera angles they
   *     appear in, how big they are, how central the camera operator keeps
   *     them, and how much their MOUTH moves relative to the rest of their head
   *     (a preaching mouth moves; a bearer standing to attention does not).
   *  5. Their position in each frame is handed to the tracker directly.
   *
   * When only one person is on screen — most footage — there is one cluster,
   * it wins, and everything downstream behaves exactly as it did before.
   */

  let _wc = null, _wx = null;
  /** A scratch 2D canvas (created once) for reading frame pixels. */
  function work2d(w, h) {
    if (typeof document === 'undefined') return null;
    if (!_wc) { _wc = document.createElement('canvas'); _wx = _wc.getContext('2d', { willReadFrequently: true }); }
    if (!_wx) return null;
    if (_wc.width !== w || _wc.height !== h) { _wc.width = w; _wc.height = h; }
    return _wx;
  }

  /**
   * One frame's pixels: RGBA for colour signatures and a grayscale plane for
   * the mouth-motion measure. Sampled at a fixed small width so the cost per
   * frame doesn't scale with the source (and so the motion measure means the
   * same thing whatever the recording's resolution).
   */
  const PX_W = 320;
  function framePixels(img) {
    const nw = img.naturalWidth || img.videoWidth || img.width || 0;
    const nh = img.naturalHeight || img.videoHeight || img.height || 0;
    if (!nw || !nh) return null;
    const w = Math.min(PX_W, nw), h = Math.max(1, Math.round(nh * (w / nw)));
    const cx2 = work2d(w, h);
    if (!cx2) return null;
    let data;
    try { cx2.drawImage(img, 0, 0, w, h); data = cx2.getImageData(0, 0, w, h).data; }
    catch (e) { return null; }
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; p < gray.length; p++, i += 4) gray[p] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    return { data, gray, w, h };
  }

  /**
   * The colour of one rectangle, as a histogram built to survive a camera cut.
   *
   * HUE, not RGB. The same person in a wide shot and in a close-up two angles
   * away is lit differently, sits against a different piece of backdrop and
   * comes out of the encoder at a different exposure — an RGB histogram of that
   * is two different people. Hue barely moves (purple stays purple), so the 16
   * hue bins carry the identity, weighted by saturation x value so that washed
   * -out pixels and near-black shadow don't vote for a hue they don't really
   * have. The 6 lightness bins take whatever chroma is left over: the grey
   * suit, the white surplice, the black jacket — clothing with no hue at all,
   * which would otherwise all look identical.
   */
  const HUE_B = 16, LIT_B = 6, COL_N = HUE_B + LIT_B;
  // A pixel is COLOURED or it is GREY — never a bit of both. Splitting each
  // pixel's vote between the two by how saturated it is sounds gentler and is
  // measurably useless: mid-tone cloth sits around a quarter saturated, so
  // three quarters of every pixel in the picture piles into the same handful of
  // lightness bins and two people in completely different robes come out
  // looking 95% alike (measured: same-person 0.66 against different-person
  // 0.62 — no separation at all). With a hard split, purple vestments score in
  // the hue bins and a grey suit in the lightness bins, and they stop matching.
  const COLOURED_S = 0.28, COLOURED_V = 46;
  function regionCol(px, x0, y0, x1, y1) {
    const X0 = Math.max(0, Math.round(x0 * px.w)), X1 = Math.min(px.w, Math.round(x1 * px.w));
    const Y0 = Math.max(0, Math.round(y0 * px.h)), Y1 = Math.min(px.h, Math.round(y1 * px.h));
    if (X1 - X0 < 3 || Y1 - Y0 < 3) return null;
    const sx = Math.max(1, Math.floor((X1 - X0) / 26)), sy = Math.max(1, Math.floor((Y1 - Y0) / 26));
    const h = new Float32Array(COL_N);
    const d = px.data;
    let n = 0;
    for (let y = Y0; y < Y1; y += sy) {
      for (let x = X0; x < X1; x += sx) {
        const i = (y * px.w + x) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        const c = mx - mn;
        let hue = 0;
        if (c) {
          hue = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
          hue /= 6;
        }
        const sat = mx ? c / mx : 0;
        if (sat >= COLOURED_S && mx >= COLOURED_V) h[Math.min(HUE_B - 1, Math.floor(hue * HUE_B))]++;
        else h[HUE_B + Math.min(LIT_B - 1, (mx * LIT_B) >> 8)]++;
        n++;
      }
    }
    if (n < 12) return null;
    for (let i = 0; i < COL_N; i++) h[i] /= n;
    return h;
  }

  /**
   * What a person LOOKS like: their head, and the clothing above and below the
   * chest, kept as three separate bands rather than one bucket. A bishop is
   * gold-and-white at the shoulders and deep red lower down; pooled into one
   * histogram that is the same muddy answer as anybody else in vestments, split
   * apart it is unmistakable. The bands are narrow on purpose (±0.75 of a head
   * width) — a wide box is mostly backdrop, and then everyone standing in front
   * of the same wall matches everyone else.
   */
  function personSig(px, cx, cy, bw, bh) {
    if (!px) return null;
    const head = regionCol(px, cx - bw * 0.42, cy - bh * 0.42, cx + bw * 0.42, cy + bh * 0.42);
    const up = regionCol(px, cx - bw * 0.75, cy + bh * 0.80, cx + bw * 0.75, cy + bh * 1.75);
    const lo = regionCol(px, cx - bw * 0.75, cy + bh * 1.75, cx + bw * 0.75, cy + bh * 2.80);
    if (!head && !up && !lo) return null;
    return { head, up, lo };
  }
  function inter(a, b) { let s = 0; for (let i = 0; i < COL_N; i++) s += Math.min(a[i], b[i]); return s; }
  /** 0..1 — how much two people look alike. Clothing decides; the head is a
   *  weaker second opinion (two men in identical vestments still differ in skin
   *  tone, beard and mitre). Bands only one of them has are simply not counted. */
  const SIG_W = { head: 0.24, up: 0.44, lo: 0.32 };
  function sigSim(a, b) {
    if (!a || !b) return 0;
    let s = 0, w = 0;
    for (const k of ['head', 'up', 'lo']) {
      if (!a[k] || !b[k]) continue;
      s += SIG_W[k] * inter(a[k], b[k]); w += SIG_W[k];
    }
    return w ? s / w : 0;
  }

  /** Signatures cross into settings/localStorage as plain arrays and come back
   *  as typed arrays — the user's choice of who to follow outlives the app. */
  function packSig(sig) {
    if (!sig) return null;
    const a = (v) => (v ? Array.from(v) : null);
    return { head: a(sig.head), up: a(sig.up), lo: a(sig.lo) };
  }
  function unpackSig(o) {
    if (!o) return null;
    const f = (a) => (a && a.length === COL_N ? Float32Array.from(a) : null);
    const head = f(o.head), up = f(o.up), lo = f(o.lo);
    return head || up || lo ? { head, up, lo } : null;
  }

  /**
   * MOUTH MOTION — the one cue that speaks to who is TALKING rather than who is
   * merely standing there.
   *
   * The naive version of this (subtract the pixels under the mouth from the
   * last frame's) measures the CAMERA, not the mouth: on multi-camera church
   * footage sampled six times a second, consecutive samples are often a
   * different angle, a different zoom and a different exposure, and it reported
   * 37 grey levels of "motion" for a man standing perfectly still. So:
   *
   *   - both patches are resampled onto the same small grid from each frame's
   *     OWN head box, which cancels the zoom and the walk,
   *   - each is normalised to zero mean and unit contrast, which cancels the
   *     exposure and the stage lighting,
   *   - the mouth reading is divided by the FOREHEAD reading off the same head,
   *     so a nod, a lean or a camera wobble — which move both — cancel too,
   *   - and the whole thing is skipped across a scene cut or a big change of
   *     size, where nothing can be compared meaningfully.
   *
   * What survives is a number that rises when the bottom of a face changes
   * shape while the top of it does not. It is still a WEAK cue at six samples a
   * second (speech is faster than that, so it is aliased), which is why it is
   * weighted as one opinion among several rather than trusted on its own.
   */
  const MG_W = 14, MG_H = 8;
  function patchNorm(gray, W, H, x0, y0, x1, y1) {
    const X0 = x0 * W, Y0 = y0 * H, dx = ((x1 - x0) * W) / MG_W, dy = ((y1 - y0) * H) / MG_H;
    if (dx < 0.6 || dy < 0.6) return null;
    const out = new Float32Array(MG_W * MG_H);
    let sum = 0;
    for (let j = 0; j < MG_H; j++) {
      const sy = Math.round(Y0 + (j + 0.5) * dy);
      if (sy < 0 || sy >= H) return null;
      for (let i = 0; i < MG_W; i++) {
        const sx = Math.round(X0 + (i + 0.5) * dx);
        if (sx < 0 || sx >= W) return null;
        const v = gray[sy * W + sx];
        out[j * MG_W + i] = v; sum += v;
      }
    }
    const mean = sum / out.length;
    let ss = 0;
    for (let i = 0; i < out.length; i++) { out[i] -= mean; ss += out[i] * out[i]; }
    const sd = Math.sqrt(ss / out.length);
    if (sd < 3) return null;                       // a flat patch has no shape to compare
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  }
  function patchDiff(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
    return s / a.length;
  }
  /** {up, lo} — how much this person's forehead and mouth changed since the
   *  previous sample, on a scale where the two are comparable. Null when they
   *  can't be compared at all. */
  function mouthMotion(px, prevGray, cur, prv) {
    if (!px || !prevGray || prevGray.length !== px.gray.length) return null;
    const band = (p, yA, yB, gray) => patchNorm(gray, px.w, px.h,
      p.cx - p.bw * 0.40, p.cy + yA * p.bh, p.cx + p.bw * 0.40, p.cy + yB * p.bh);
    const cUp = band(cur, -0.45, 0.02, px.gray), pUp = band(prv, -0.45, 0.02, prevGray);
    const cLo = band(cur, 0.06, 0.52, px.gray), pLo = band(prv, 0.06, 0.52, prevGray);
    if (!cUp || !pUp || !cLo || !pLo) return null;
    return { up: patchDiff(cUp, pUp), lo: patchDiff(cLo, pLo) };
  }

  /*
   * Two thresholds, both measured on real convention footage rather than
   * guessed (test/diag-subject.js --sep prints them for any clip):
   *
   *   the same person, one frame apart   p10 0.83   median 0.90
   *   two people in the same frame       median 0.55   p90 0.70
   *
   * So 0.78 splits them with room on both sides, and is used to build FRAGMENTS
   * that are almost never contaminated. Fragments are then merged into whole
   * identities at a much lower bar — but ONLY between fragments that were never
   * once on screen together, because two people in the same frame cannot be the
   * same person no matter how alike a colour histogram says they look. That
   * constraint is what makes a loose merge safe, and it is what lets one person
   * be recognised across camera angles, where lighting drops the similarity of
   * their own two looks below the level at which strangers start matching.
   */
  const JOIN = 0.78;
  const MERGE = 0.70;
  const MAX_EX = 10;

  /** The average of a set of histograms (a cluster's look, all its angles pooled). */
  function meanSig(sigs) {
    const acc = { head: null, up: null, lo: null };
    for (const k of ['head', 'up', 'lo']) {
      const list = sigs.map((s) => s && s[k]).filter(Boolean);
      if (!list.length) continue;
      const m = new Float32Array(COL_N);
      for (const h of list) for (let i = 0; i < COL_N; i++) m[i] += h[i];
      for (let i = 0; i < COL_N; i++) m[i] /= list.length;
      acc[k] = m;
    }
    return acc.head || acc.up || acc.lo ? acc : null;
  }
  /** How alike two identities look: the best any of their looks match. A
   *  cluster keeps EXEMPLARS rather than one average because a person really
   *  does look different lit from the side in a wide shot than head-on in a
   *  close-up, and the average of the two matches neither. */
  function clusterSim(a, b) {
    let m = 0;
    for (const x of a.ex) for (const y of b.ex) { const v = sigSim(x, y); if (v > m) m = v; }
    return m;
  }

  /** Group everybody seen in the clip into identities (see the note above). */
  function clusterPeople(frames) {
    const clusters = [];
    const simTo = (c, sig) => c.ex.reduce((m, e) => Math.max(m, sigSim(e, sig)), 0);
    for (let fi = 0; fi < frames.length; fi++) {
      const f = frames[fi];
      const taken = new Set();
      // strongest people first, so the clearest look claims its identity
      const order = f.people.map((p, i) => i).sort((a, b) => f.people[b].area - f.people[a].area);
      for (const i of order) {
        const p = f.people[i];
        if (!p.sig) { p.cid = -1; continue; }
        let best = -1, bestS = 0;
        for (let c = 0; c < clusters.length; c++) {
          if (taken.has(c)) continue;
          const v = simTo(clusters[c], p.sig);
          if (v > bestS) { bestS = v; best = c; }
        }
        if (best >= 0 && bestS >= JOIN) {
          const c = clusters[best];
          p.cid = best; taken.add(best); c.n++; c.frames.add(fi);
          if (c.ex.length < MAX_EX) c.ex.push(p.sig);
          else if (bestS < 0.88) c.ex[c.n % MAX_EX] = p.sig;   // keep a spread of looks, not ten copies of one
        } else {
          p.cid = clusters.length; taken.add(clusters.length);
          clusters.push({ ex: [p.sig], n: 1, frames: new Set([fi]) });
        }
      }
    }
    mergeFragments(clusters);
    const remap = new Array(clusters.length);
    let next = 0;
    for (let i = 0; i < clusters.length; i++) remap[i] = clusters[i].dead ? null : next++;
    for (let i = 0; i < clusters.length; i++) if (clusters[i].dead) remap[i] = remap[rootOf(clusters, i)];
    for (const f of frames) for (const p of f.people) if (p.cid >= 0) p.cid = remap[p.cid];
    const kept = clusters.filter((c) => !c.dead);
    for (const c of kept) c.sig = meanSig(c.ex);
    return kept;
  }
  function rootOf(cl, i) { while (cl[i].dead) i = cl[i].into; return i; }

  /**
   * Join the fragments one person got split into. Greedy agglomerative: take
   * the most similar pair left, and merge it if the two were NEVER on screen at
   * the same time. Co-occurrence is a hard fact about the world, so it can veto
   * a merge that appearance alone would happily make.
   */
  function mergeFragments(clusters) {
    for (;;) {
      let bi = -1, bj = -1, bs = MERGE;
      for (let i = 0; i < clusters.length; i++) {
        if (clusters[i].dead) continue;
        for (let j = i + 1; j < clusters.length; j++) {
          if (clusters[j].dead) continue;
          if (overlaps(clusters[i].frames, clusters[j].frames)) continue;
          const v = clusterSim(clusters[i], clusters[j]);
          if (v > bs) { bs = v; bi = i; bj = j; }
        }
      }
      if (bi < 0) return;
      const a = clusters[bi], b = clusters[bj];
      a.ex = a.ex.concat(b.ex).slice(0, MAX_EX * 2);
      a.n += b.n;
      for (const k of b.frames) a.frames.add(k);
      b.dead = true; b.into = bi;
    }
  }
  function overlaps(a, b) {
    const [s, l] = a.size < b.size ? [a, b] : [b, a];
    for (const v of s) if (l.has(v)) return true;
    return false;
  }

  const med = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
  const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

  /**
   * The people in one frame: every detected face, with the body that belongs to
   * it attached, PLUS any body no face was found for — that last group is the
   * speaker who has turned to the screen behind them, or bowed over a
   * microphone, and dropping them is how a tracker loses its subject mid-sentence.
   */
  function buildPeople(cands, poses) {
    const people = [];
    const used = new Array(poses.length).fill(false);
    for (const c of cands) {
      let pi = -1, pd = 0.12;
      for (let i = 0; i < poses.length; i++) {
        if (used[i]) continue;
        const d = Math.hypot(poses[i].cx - c.cx, poses[i].cy - c.cy);
        if (d < pd) { pd = d; pi = i; }
      }
      if (pi >= 0) used[pi] = true;
      const bw = c.wNorm, bh = c.hNorm || c.wNorm * 1.25;
      people.push({ cx: c.cx, cy: c.cy, bw, bh, area: bw * bh, score: c.score, face: c, pose: pi >= 0 ? poses[pi] : null, src: 'face' });
    }
    for (let i = 0; i < poses.length; i++) {
      if (used[i]) continue;
      const q = poses[i], bw = q.headW || 0.06, bh = bw * 1.25;
      people.push({ cx: q.cx, cy: q.cy, bw, bh, area: bw * bh, score: 0, face: null, pose: q, src: 'pose' });
    }
    return people;
  }

  /*
   * A SECOND LOOK AT THE BODIES WE FOUND NO FACE FOR.
   *
   * The face detector is run once over the whole 640-wide frame, and at that
   * size a preacher's head — small, side-lit, under a mitre, half behind a
   * microphone — is routinely missed while the man standing nearer the camera
   * is found every time. That is not a tie the tracker should be asked to
   * break: it decides who the clip is "mostly about" before anyone has looked
   * properly at the person doing the talking.
   *
   * So wherever the pose model found a BODY that no face belongs to, the head
   * end of that body is cut out, blown up, and shown to the detector again.
   * On a crop the head fills the picture and is usually found. It costs one
   * extra call on a tiny image per unfound body (~7% of tracking time) and buys
   * back the frames that decide the whole question — and a real face box, which
   * places the clothing bands of the signature far better than a shoulder-width
   * guess does.
   */
  const ZOOM_PX = 224;
  function refinePoseOnly(img, people, det) {
    if (typeof document === 'undefined' || !det) return;
    const W = img.naturalWidth || img.width || 0, H = img.naturalHeight || img.height || 0;
    if (!W || !H) return;
    for (const p of people) {
      if (p.src !== 'pose' || !p.pose) continue;
      const q = p.pose;
      const half = Math.max(0.04, (q.headW || 0.06) * 2.0);      // a generous box around the head
      const x0 = Math.max(0, (q.cx - half) * W), x1 = Math.min(W, (q.cx + half) * W);
      const y0 = Math.max(0, (q.cy - half * (W / H) * 1.1) * H), y1 = Math.min(H, (q.cy + half * (W / H) * 1.1) * H);
      const sw = x1 - x0, sh = y1 - y0;
      if (sw < 8 || sh < 8) continue;
      const c = zoomCanvas(sw, sh);
      if (!c) continue;
      try { c.ctx.drawImage(img, x0, y0, sw, sh, 0, 0, c.el.width, c.el.height); } catch (e) { continue; }
      let r; try { r = det.detect(c.el); } catch (e) { continue; }
      const ds = (r && r.detections) || [];
      if (!ds.length) continue;
      // the head we were looking for is the one nearest the middle of the crop
      let best = null, bd = 1e9;
      for (const d of ds) {
        const b = d.boundingBox;
        const cx = (b.originX + b.width / 2) / c.el.width, cy = (b.originY + b.height / 2) / c.el.height;
        const dd = Math.hypot(cx - 0.5, cy - 0.5);
        if (dd < bd) { bd = dd; best = { b, cx, cy }; }
      }
      if (!best || bd > 0.42) continue;
      const bw = (best.b.width / c.el.width) * (sw / W);
      const bh = (best.b.height / c.el.height) * (sh / H);
      p.cx = x0 / W + best.cx * (sw / W);
      p.cy = y0 / H + best.cy * (sh / H);
      p.bw = bw; p.bh = bh; p.area = bw * bh; p.src = 'face'; p.zoomed = true;
      p.score = best.b && ds[0].categories && ds[0].categories[0] ? ds[0].categories[0].score : 0.5;
    }
  }
  let _zc = null, _zx = null;
  function zoomCanvas(sw, sh) {
    if (typeof document === 'undefined') return null;
    if (!_zc) { _zc = document.createElement('canvas'); _zx = _zc.getContext('2d', { willReadFrequently: false }); }
    if (!_zx) return null;
    const scale = ZOOM_PX / Math.max(sw, sh);
    const w = Math.max(16, Math.round(sw * scale)), h = Math.max(16, Math.round(sh * scale));
    if (_zc.width !== w || _zc.height !== h) { _zc.width = w; _zc.height = h; }
    return { el: _zc, ctx: _zx };
  }

  /**
   * Attach a mouth-motion reading to each person, comparing against where that
   * same person was in the previous sample (matched on position and size — a
   * cheap frame-to-frame link that only has to be right for the two frames it
   * measures across, not for the whole clip).
   */
  function measureMouths(px, pairGray, people) {
    if (!pairGray) return;
    for (const p of people) {
      // Same instant, same box, one frame apart: nothing has moved except the
      // person themselves, so no matching or motion compensation is needed.
      const mm = mouthMotion(px, pairGray, p, p);
      // +0.15 of floor on a contrast-normalised scale: on a tiny, dim face both
      // halves read near zero and the bare ratio explodes on sensor noise alone.
      if (mm) { p.talk = mm.lo / (mm.up + 0.15); p.mUp = mm.up; p.mLo = mm.lo; }
    }
  }

  /*
   * FOLLOWING one identity through the clip.
   *
   * Clustering alone cannot do this. It answers "how many people are in this
   * clip and which is which", but its idea of a person is fixed and a person's
   * look is not: this church's stream burns a translucent scripture graphic
   * across the middle of the picture, and every time the verse changes the
   * colour under everybody's chin changes with it — enough to split one bishop
   * into ten fragments of 7% each, at which point "who is in most of the clip"
   * is answering about nobody.
   *
   * So the subject is followed the way a person would follow them: start from
   * what they looked like when we last knew for certain, walk forward a frame
   * at a time, and keep that memory up to date as they turn, move and get
   * relit. The ANCHOR (the identity we chose, or the person the user pointed
   * at) is never forgotten and always votes; the adaptive memory beside it is
   * what carries the walk across a graphic change or a new camera angle.
   * Adaptation only happens on frames where the match was strong AND
   * continuous, so a stranger who scores well for one frame cannot teach the
   * tracker to follow them instead.
   *
   * Run in both directions and combined, because a clip that opens mid-crowd
   * has nothing to start from at its own beginning but plenty by its end.
   */
  const ACCEPT = 0.78;        // appearance alone is enough (two people in one frame reach 0.70 at p90)
  const ACCEPT_NEAR = 0.68;   // ... less is enough when they are where we left them a moment ago
  const MARGIN = 0.05;        // ... and never when somebody else in the frame matches nearly as well
  const ADAPT_MIN = 0.80;     // ... and only a clearly-right match may teach the model
  const ADAPT_SLOTS = 12;
  const LOCK_MIN = 0.15;      // tracked coverage below which the user's pick is simply not in this clip
  const NEAR_D = 0.25;        // how far "where we left them" reaches, as a fraction of the frame

  function simMax(list, sig) {
    let m = 0;
    for (const e of list) { const v = sigSim(e, sig); if (v > m) m = v; }
    return m;
  }

  /** One directional walk. Returns the person accepted in each frame, or null. */
  function trackPass(frames, anchor, dir, useVouch = true) {
    const acc = new Array(frames.length).fill(null);
    const adapt = [];
    let last = null;
    const from = dir > 0 ? 0 : frames.length - 1;
    for (let n = 0; n < frames.length; n++) {
      const i = from + dir * n;
      const f = frames[i];
      if (!f.people || !f.people.length) continue;
      // The referee looked at this frame (see THE REFEREE below): its answer is
      // not weighed against the colours, it IS the answer — and a look it vouched
      // for is the best teacher the adaptive model will ever get.
      if (useVouch && f.vouch) {
        acc[i] = f.vouch;
        last = { cx: f.vouch.cx, cy: f.vouch.cy, shot: f.shot, t: f.t };
        if (f.vouch.sig) { adapt.push(f.vouch.sig); if (adapt.length > ADAPT_SLOTS) adapt.shift(); }
        continue;
      }
      if (useVouch && f.vouchNone) continue;
      let best = null, bestKey = -1, runnerUp = 0;
      for (const p of f.people) {
        if (!p.sig) continue;
        const a = Math.max(simMax(anchor, p.sig), simMax(adapt, p.sig));
        const near = last && last.shot === f.shot && Math.abs(f.t - last.t) <= 1.2
          ? 1 - Math.min(1, Math.hypot(p.cx - last.cx, p.cy - last.cy) / NEAR_D) : 0;
        const key = a + 0.20 * near;
        if (key > bestKey) { if (best) runnerUp = Math.max(runnerUp, best.a); bestKey = key; best = { p, a, near }; }
        else runnerUp = Math.max(runnerUp, a);
      }
      if (!best) continue;
      // An absolute score is not enough on its own. Colour histograms of two men
      // on the same platform under the same lights sit surprisingly close (two
      // people in one frame reach 0.70 at p90, measured), so a bar low enough to
      // keep the real subject through a bad angle is also low enough to let the
      // man beside him through — and once he is accepted the track never comes
      // back. Requiring a MARGIN over everyone else in the frame is what makes
      // the difference: the subject only has to be the best explanation here,
      // not merely a good one.
      const clear = best.a - runnerUp >= MARGIN || best.near >= 0.7;
      if (!clear) continue;
      if (!(best.a >= ACCEPT || (best.a >= ACCEPT_NEAR && best.near >= 0.5))) continue;
      acc[i] = best.p;
      last = { cx: best.p.cx, cy: best.p.cy, shot: f.shot, t: f.t };
      if (best.a >= ADAPT_MIN && best.near >= 0.3) {
        adapt.push(best.p.sig);
        if (adapt.length > ADAPT_SLOTS) adapt.shift();
      }
    }
    return acc;
  }

  /**
   * Follow one identity through the whole clip, forwards and backwards. The two
   * passes only disagree where one of them had nothing to go on yet — which is
   * exactly the half the other one covers.
   */
  function trackSubjectWith(frames, anchor, useVouch = true) {
    const fwd = trackPass(frames, anchor, +1, useVouch);
    const bwd = trackPass(frames, anchor, -1, useVouch);
    const out = new Array(frames.length).fill(null);
    for (let i = 0; i < frames.length; i++) out[i] = fwd[i] || bwd[i];
    return out;
  }

  /*
   * BRIDGING — "I can't prove it's him, but somebody is plainly standing there."
   *
   * Recognising a face by its colours is a question the footage often refuses to
   * answer: this church burns a translucent scripture graphic across the middle
   * of the picture, so every verse change repaints the colour under the
   * speaker's chin, and stage lighting does the rest. Measured on the two shorts
   * the user complained about, the identity layer declined 31% and 58% of the
   * samples — while the models found a body in every single frame. The camera
   * then sat perfectly still for FOURTEEN AND A HALF SECONDS while the preacher
   * walked out of the crop. That is the "speaker is out of the frame" bug.
   *
   * Loosening the identity thresholds is the wrong cure: they are what stops the
   * crop latching onto the man standing NEXT to the preacher, which is a worse
   * and much less recoverable failure. So identity keeps its strictness and a
   * second question is asked of the frames it rejected — not "who is this?" but
   * "did anybody WALK here from where he was?".
   *
   * A person is a continuous object: between two samples 1/6s apart they move a
   * few percent of the frame, never half of it, and their head does not change
   * size. So each gap is walked from the confirmed sighting before it and again
   * backwards from the confirmed sighting after it, each walk following the
   * nearest plausible candidate, and a frame is only filled where THE TWO WALKS
   * ARRIVE AT THE SAME PERSON. Drifting onto a bystander is a one-directional
   * mistake — the walk from the other end lands somewhere else and the
   * disagreement leaves the frame honestly empty, which the camera already
   * knows how to sit through.
   *
   * Bridging never crosses a shot cut (positions teleport there, so continuity
   * says nothing) and never invents a position where no candidate is within
   * reach — a cutaway to the congregation still reads as "he is not in shot".
   */
  /*
   * The gates below are MEASURED, not chosen. Ground truth is free here: where
   * exactly one body is found in each of two consecutive samples, it is
   * certainly the same person. Over 694 such pairs on the two clips the user
   * complained about:
   *      sideways move   p50 0.010   p90 0.033   p99 0.076
   *      vertical move   p50 0.013   p90 0.092   p99 0.141
   *      head-size ratio p50 1.05    p90 2.85    p99 3.63
   * The size figure is the surprise and it is why the gate is so loose: "head
   * width" flips between a measured face box and a shoulder-derived estimate
   * depending on which model found the person, so a factor of three is routine
   * BETWEEN CONSECUTIVE SAMPLES OF THE SAME MAN. It is kept only to reject the
   * absurd. Sideways position is the reliable one, and the one the crop rides on.
   */
  const BR_STEP = 0.10;       // furthest a head may travel sideways between 6fps samples (p99 + margin)
  const BR_STEPY = 0.30;      // ... and vertically, where the same instability makes a tight gate meaningless
  const BR_COAST = 0.6;       // s a walk may carry on through frames with nothing acceptable in them
  const BR_AGREE = 0.06;      // how closely the two walks must land on the same spot to be believed
  const BR_SIZE = 4.0;        // head-size ratio beyond which a candidate is a different thing entirely

  /*
   * WHAT COUNTS AS "THE SAME PERSON, ONE SAMPLE LATER".
   *
   * Two things about the signals make the obvious gates wrong, and both were
   * measured on the footage that shipped badly:
   *
   * A BODY BEATS A FACE, ALWAYS. The purple wordmark on this church's backdrop
   * detects as three or four confident "faces" a fifth of the frame wide, in
   * every single sample. Nothing about position or size separates them reliably
   * — but none of them has a body under it. So when the frame contains anybody
   * body-backed, the walk only ever considers those, and the wallpaper stops
   * existing. The face-only pool is the fallback for frames the pose model
   * missed entirely.
   *
   * THE HEAD BOX IS NOT STABLE ACROSS A HANDOVER. When the face detector loses
   * the head and only the pose model has it, "head width" stops being a
   * measured box and becomes a shoulder-derived estimate: over the 2.8s blind
   * stretch in the user's clip it jumped 0.062 → 0.147 and the centre dropped
   * 0.24 → 0.34 — the same man, standing still. A tight size or vertical gate
   * throws exactly those frames away, which is why the camera froze through
   * them. Both gates are therefore generous, and the horizontal position — the
   * one the 9:16 crop actually rides on — does the discriminating.
   */
  function nextInWalk(f, ex, ey, bw, gate) {
    const all = f.people || [];
    const bodied = all.filter((p) => p.pose);
    const pool = bodied.length ? bodied : all;
    let best = null, bd = Infinity;
    for (const p of pool) {
      const w = p.bw || 0.06;
      if (w > BR_SIZE * bw || w * BR_SIZE < bw) continue;
      const dx = Math.abs(p.cx - ex), dy = Math.abs(p.cy - ey);
      if (dx > BR_STEP * gate || dy > BR_STEPY * gate) continue;
      const d = dx + 0.4 * dy;                 // sideways is what the crop rides on
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }

  /** One directional walk through a gap, from a known sighting. */
  function walkFrom(frames, startIdx, dir, seed, cutBetween, stopIdx) {
    const out = new Map();
    let px = seed.cx, py = seed.cy, vx = 0, vy = 0, pw = seed.bw || 0.06;
    let lastT = frames[startIdx].t, blindT = 0;
    for (let i = startIdx + dir; dir > 0 ? i <= stopIdx : i >= stopIdx; i += dir) {
      const f = frames[i];
      // A CUT DOES NOT STOP THE WALK — IT TIGHTENS IT. Banning the crossing
      // outright was right in spirit (positions teleport at a cut, so continuity
      // proves nothing) and wrong in practice, because most "cuts" on this
      // footage are the scripture graphic flashing. So the walk may cross, but
      // only onto somebody standing almost exactly where the subject was a
      // sixth of a second ago — which cannot be a coincidence of a real cut —
      // and it may not coast blindly across one.
      const cut = cutBetween(frames[i - dir].t, f.t);
      const dt = Math.abs(f.t - lastT) || 1 / 6;
      const ex = px + vx * dt * dir, ey = py + vy * dt * dir;  // where a walking person would be
      const best = nextInWalk(f, ex, ey, pw, cut ? 0.45 : Math.max(1, dt * 6));
      if (!best) {
        if (cut) break;
        blindT += dt;
        if (blindT > BR_COAST) break;
        px = ex; py = ey; vx *= 0.5; vy *= 0.5; lastT = f.t;   // coast, losing speed
        continue;
      }
      blindT = 0;
      vx = (best.cx - px) / (dt * dir); vy = (best.cy - py) / (dt * dir);
      px = best.cx; py = best.cy; pw = 0.7 * pw + 0.3 * (best.bw || pw); lastT = f.t;
      out.set(i, best);
    }
    return out;
  }

  /*
   * A WHOLE SHOT WHERE NOBODY IS RECOGNISED.
   *
   * Bridging stops at a cut, and rightly — positions teleport there, so
   * continuity has nothing to say. But a cut is exactly where recognition
   * fails: the tight side angle of this sermon lights the preacher completely
   * differently from the wide stage camera, and the identity layer declined
   * every one of the 87 samples in it. The camera sat on the framing it had
   * from the previous angle for fourteen and a half seconds — which is what
   * "the speaker is out of the frame" looks like in the finished short.
   *
   * So each shot is asked one more question: is there ONE person here, plainly,
   * for most of the shot? The models answer that without any recognition at all
   * — a body cannot be a pattern on the wall, so only body-backed people are
   * eligible, and they are chained frame-to-frame into tracklets by continuity.
   * A single dominant tracklet in a shot the subject is absent from is the
   * speaker, and following it is what any operator would do.
   *
   * The safety is in the word SINGLE. The failure this whole layer exists to
   * prevent — the crop sitting on the man standing next to the preacher — needs
   * two people in the shot, and two persistent tracklets make the shot
   * ambiguous, so it is left alone and the camera holds as before. Shots where
   * identity DID recognise the subject are never touched.
   */
  const RC_DOM = 0.45;       // a tracklet must fill this much of a blind stretch to be "the person there"
  const RC_RIVAL = 0.55;     // ... and no rival may reach this share of the winner's coverage
  const RC_AGREE = 0.10;     // how close a tracklet must sit to the recognised subject to BE him
  const RC_NEAR = 2.5;       // s within which that agreement has to have been shown

  /*
   * TRACKLETS — everybody's path through the clip, drawn by continuity alone.
   *
   * Deliberately NOT segmented by camera cuts. The scene-cut list cannot be
   * trusted here in either direction: on the clip the user complained about the
   * scripture graphic flashing scored 0.26 while THE BIGGEST ANGLE CHANGE IN
   * THE CLIP — a wide stage camera cutting to a tight side angle of the same
   * man against the same wall — scored 0.10 and was filtered out as noise.
   * Building shots on top of that list put the recovery below in the wrong
   * places both ways round.
   *
   * It does not need the list. A cut IS a discontinuity, so it breaks the chain
   * on its own: across that missed cut the preacher's head jumped a quarter of
   * the frame sideways and went from 6% to 16% of the frame wide, and no link
   * in a tracklet may do either. What the chain asserts is exactly what is
   * wanted — this is the same object, moving the way objects move — and nothing
   * about camera departments.
   */
  function tracklets(frames) {
    const open = [], done = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const cands = (f.people || []).filter((p) => p.pose);   // a body, not a pattern on the wall
      const used = new Set();
      for (const tr of open) {
        const dt = Math.max(1 / 12, f.t - tr.lastT);
        const ex = tr.cx + tr.vx * dt, ey = tr.cy + tr.vy * dt;
        const best = nextInWalk({ people: cands.filter((p) => !used.has(p)) }, ex, ey, tr.bw, Math.max(1, dt * 6));
        if (best) {
          used.add(best);
          tr.vx = (best.cx - tr.cx) / dt; tr.vy = (best.cy - tr.cy) / dt;
          tr.cx = best.cx; tr.cy = best.cy; tr.bw = 0.7 * tr.bw + 0.3 * (best.bw || tr.bw);
          tr.lastT = f.t; tr.at.set(i, best);
        }
      }
      for (let k = open.length - 1; k >= 0; k--) if (f.t - open[k].lastT > BR_COAST) done.push(open.splice(k, 1)[0]);
      for (const p of cands) {
        if (used.has(p)) continue;
        open.push({ cx: p.cx, cy: p.cy, vx: 0, vy: 0, bw: p.bw || 0.06, lastT: f.t, at: new Map([[i, p]]) });
      }
    }
    return joinFragments(done.concat(open), frames);
  }

  /*
   * A tracklet ends whenever the pose model blinks for more than 0.6s, so one
   * person walking across one shot can arrive as three fragments. That matters
   * because the recovery below refuses to act where two tracklets compete: on
   * the user's clip, one preacher arriving as a 19-sample fragment and an
   * 18-sample fragment read as TWO PEOPLE, the stretch was called ambiguous,
   * and 3.8s of the short stayed pointed at an empty chair.
   *
   * Two fragments are the same object if they were never on screen at the same
   * moment AND their union is still a continuous path — every consecutive pair
   * of samples in it passes the same "a person moves like this" gate that built
   * them. Both halves matter: co-occurrence is proof of two people, continuity
   * is proof of one.
   */
  function joinFragments(trs, frames) {
    const list = trs.slice();
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          const A = list[a].at, B = list[b].at;
          let clash = false;
          for (const i of B.keys()) if (A.has(i)) { clash = true; break; }
          if (clash) continue;
          const keys = [...A.keys(), ...B.keys()].sort((x, y) => x - y);
          let ok = true;
          for (let k = 1; k < keys.length && ok; k++) {
            const i = keys[k - 1], j = keys[k];
            const p = A.get(i) || B.get(i), q = A.get(j) || B.get(j);
            const dt = Math.max(1 / 12, frames[j].t - frames[i].t);
            if (dt > BR_COAST) { ok = false; break; }
            const w = q.bw || 0.06, pw = p.bw || 0.06;
            const gate = Math.max(1, dt * 6);
            ok = Math.abs(q.cx - p.cx) <= BR_STEP * gate && Math.abs(q.cy - p.cy) <= BR_STEPY * gate
              && w <= BR_SIZE * pw && w * BR_SIZE >= pw;
          }
          if (!ok) continue;
          const at = new Map(); for (const i of keys) at.set(i, A.get(i) || B.get(i));
          list[a] = { at };
          list.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
    return list;
  }

  /**
   * Extend the track through the frames identity declined.
   *
   * A tracklet earns the camera in one of two ways, and the first is much the
   * stronger:
   *
   *   1. IT IS DEMONSTRABLY HIM. Somewhere within a couple of seconds of the
   *      blind frame, this same tracklet passes through a frame where identity
   *      DID recognise the subject, and agrees with it about where he was. Then
   *      the frames in between are his too — the tracklet is the evidence that
   *      it is one continuous person, and the recognised frame is the evidence
   *      of which person. Agreement is checked LOCALLY, so a long tracklet
   *      cannot earn the whole clip from one lucky match at its far end, and a
   *      nearby DISAGREEMENT vetoes it outright: that is somebody else.
   *
   *   2. HE IS THE ONLY PERSON THERE. Over a stretch where identity recognised
   *      nobody at all, one body-backed tracklet fills most of it and no other
   *      comes close. Then it is the speaker, because there is nobody else it
   *      could be — which is exactly the reasoning an operator applies to a
   *      tight single of a preacher.
   *
   * The safety is in the word ONLY. The failure this layer exists to prevent —
   * the crop sitting on the man standing NEXT to the preacher — needs two
   * people, and two persistent tracklets leave the stretch ambiguous, so it is
   * left blind and the camera holds its framing as before.
   */
  function recoverBlind(frames, track) {
    const out = track.slice();
    const n = frames.length;
    /*
     * FIRST, THROW AWAY WHAT RECOGNITION GOT WRONG.
     *
     * The identity layer emits the occasional single-sample teleport — the
     * track flicking to the far edge of the frame for one 1/6s and back
     * (measured: six of them in a 56s clip). The camera prunes those later, but
     * here they do real damage: a bogus sighting is EVIDENCE, and three of them
     * were enough to convict the correct tracklet of being somebody else and
     * leave 14.5s of the clip blind. A sighting that contradicts the sightings
     * either side of it, which agree with each other, is not a sighting.
     */
    for (let i = 0; i < n; i++) {
      if (!out[i]) continue;
      let p = null, q = null;
      for (let j = i - 1; j >= 0 && frames[i].t - frames[j].t <= 1.5; j--) if (track[j]) { p = track[j]; break; }
      for (let j = i + 1; j < n && frames[j].t - frames[i].t <= 1.5; j++) if (track[j]) { q = track[j]; break; }
      if (p && q && Math.abs(p.cx - q.cx) < 0.16
        && Math.abs(out[i].cx - p.cx) > 0.16 && Math.abs(out[i].cx - q.cx) > 0.16) out[i] = null;
    }
    const trs = tracklets(frames);
    const solid = (i, cx) => (frames[i].people || []).some((p) => p.pose && Math.abs(p.cx - cx) <= RC_AGREE);
    /*
     * ...AND WHAT RECOGNITION GOT WRONG FOR LONGER THAN A SAMPLE.
     *
     * De-spiking catches the one-frame teleport. It does not catch the other
     * failure, which is worse because it looks like success: the backdrop
     * wordmark reads as a big confident face in EVERY sample, and on the clip
     * the user complained about the identity layer sat on one for four straight
     * seconds at cx 0.75 — while the only body in the picture, the preacher,
     * stood at 0.47. The camera dutifully followed it to the wallpaper.
     *
     * The test is the one PASS A2 already uses and this file trusts everywhere:
     * flat art cannot be a body. A "sighting" with no body under it, in a frame
     * where a body-backed person IS being followed by a lasting tracklet, is
     * not a person — so it is dropped, and the recovery below fills the frame
     * from the body instead. Where the pose model simply missed a real person,
     * there is no rival body and nothing is dropped.
     */
    const lasting = trs.filter((tr) => tr.at.size >= 3);
    // The rival body is looked for in the NEIGHBOURHOOD, not only in this exact
    // frame: the pose model drops a sample here and there, and one missing body
    // was enough to let a wallpaper sighting survive and split the recovery in
    // two around it.
    const rivalNear = (i, cx) => lasting.some((tr) => {
      let best = null, bd = Infinity;
      for (const [j, p] of tr.at) {
        const d = Math.abs(frames[j].t - frames[i].t);
        if (d <= 0.5 && d < bd) { bd = d; best = p; }
      }
      return best && Math.abs(best.cx - cx) > RC_AGREE;
    });
    for (let i = 0; i < n; i++) {
      if (!out[i] || solid(i, out[i].cx)) continue;
      if (rivalNear(i, out[i].cx)) out[i] = null;
    }
    // What identity has to say about each tracklet, now that the sightings that
    // were not of anybody have been taken out of the record.
    for (const tr of trs) {
      tr.anchors = [];
      for (const [i, p] of tr.at) if (out[i]) tr.anchors.push({ i, ok: Math.abs(p.cx - out[i].cx) <= RC_AGREE });
      tr.anchors.sort((a, b) => a.i - b.i);
    }
    /*
     * Nearby sightings VOTE; the nearest one does not decide alone. Where two
     * camera angles meet, one frame holds the speaker twice — small in the wide
     * shot and large in the tight one — and identity and the tracklet can
     * legitimately pick different copies of him. That is one ambiguous frame,
     * not evidence of two people, and letting it speak for its neighbours cost
     * 3.5s of the user's clip.
     */
    const vote = (tr, i) => {
      let yes = 0, no = 0;
      for (const a of tr.anchors) {
        if (Math.abs(frames[a.i].t - frames[i].t) > RC_NEAR) continue;
        if (a.ok) yes++; else no++;
      }
      return { yes, no };
    };
    // 1. locally-corroborated tracklets fill their own blind frames
    for (const tr of trs) {
      if (!tr.anchors.length) continue;
      for (const [i, p] of tr.at) {
        if (out[i]) continue;
        const v = vote(tr, i);
        if (v.yes && v.yes > v.no) out[i] = Object.assign({}, p, { bridged: true });
      }
    }
    /*
     * 2. ...and over what is STILL blind, the one person there.
     *
     * Judged FRAME BY FRAME over a short window either side, not once per blind
     * stretch. A stretch can be half a minute long and have a different person
     * plainly in it at each end — asking "who dominates all of it" then picks
     * one of them and abandons the other, which on the user's clip left the
     * first 5.3 seconds blind while filling the remaining 27. What matters at
     * each frame is whether, around THAT moment, one lasting body is there and
     * nobody else is.
     */
    const WIN = 9;             // ±1.5s: long enough to mean "lasting", short enough to be local
    const blind = out.map((v) => !v);
    for (let i = 0; i < n; i++) {
      if (!blind[i]) continue;
      const lo = Math.max(0, i - WIN), hi = Math.min(n, i + WIN + 1), span = hi - lo;
      const here = [];
      for (const tr of lasting) {
        if (!tr.at.has(i)) continue;
        let k = 0; for (let j = lo; j < hi; j++) if (tr.at.has(j)) k++;
        here.push({ tr, k });
      }
      here.sort((a, b) => b.k - a.k);
      const win = here[0];
      if (!win || win.k < RC_DOM * span) continue;                   // nobody lasting here
      if (here[1] && here[1].k >= RC_RIVAL * win.k) continue;        // two of them: ambiguous
      if (vote(win.tr, i).no >= 2) continue;                         // identity says otherwise, twice
      out[i] = Object.assign({}, win.tr.at.get(i), { bridged: true });
    }
    return out;
  }

  /**
   * Fill the frames identity declined, wherever a walk from each side of the gap
   * agrees on the same person. Mutates nothing; returns a new track array.
   */
  function bridgeTrack(frames, track, cutBetween) {
    const out = track.slice();
    const n = frames.length;
    let i = 0;
    while (i < n) {
      if (out[i]) { i++; continue; }
      let j = i; while (j < n && !out[j]) j++;              // gap is [i, j)
      const before = i > 0 ? out[i - 1] : null;
      const after = j < n ? out[j] : null;
      const fwd = before ? walkFrom(frames, i - 1, +1, before, cutBetween, j - 1) : null;
      const bwd = after ? walkFrom(frames, j, -1, after, cutBetween, i) : null;
      for (let k = i; k < j; k++) {
        const a = fwd && fwd.get(k), b = bwd && bwd.get(k);
        let use = null;
        if (a && b) use = Math.hypot(a.cx - b.cx, a.cy - b.cy) <= BR_AGREE ? a : null;
        // Only one side exists at the very start or end of the clip — there is
        // no second opinion to be had, so one careful walk is the best there is.
        else if (a && !after) use = a;
        else if (b && !before) use = b;
        if (use) out[k] = Object.assign({}, use, { bridged: true });
      }
      i = j;
    }
    return out;
  }

  /** What following this identity actually got us — the numbers that decide
   *  whether they are the person this clip is about. */
  function trackStats(frames, track, nShots) {
    const cx = [], bw = [], talk = [];
    const shots = new Set();
    let n = 0, faced = 0;
    for (let i = 0; i < frames.length; i++) {
      const p = track[i];
      if (!p) continue;
      n++; cx.push(p.cx); bw.push(p.bw); shots.add(frames[i].shot);
      if (p.src === 'face') faced++;
      if (p.talk != null) talk.push(p.talk);
    }
    const total = Math.max(1, frames.length);
    return {
      n, cover: n / total, shots: shots.size / Math.max(1, nShots),
      size: med(bw), cx: med(cx), cxLo: pct(cx, 0.1), cxHi: pct(cx, 0.9),
      centre: 1 - Math.min(1, 2 * Math.abs(med(cx) - 0.5)),
      // How often we could actually see this person's FACE, as opposed to only
      // finding a body. At a laying-on-of-hands the nearest, largest, most
      // consistently-found "person" in shot is a man with his back to the
      // camera blocking half the picture — big, central, and never once facing
      // us. A short is a talking head; the subject of one is somebody you can
      // see the face of, and this is the term that says so.
      facing: n ? faced / n : 0,
      talk: talk.length >= 6 ? med(talk) : null, talkN: talk.length,
    };
  }

  /*
   * Weights for the automatic pick. Deliberately spread across several weak
   * cues rather than trusting one, because each of them is wrong somewhere. The
   * mouth measure is the only one that speaks to who is TALKING, so it leads —
   * but six samples a second aliases speech badly, so it must not be able to
   * outvote everything else on its own. The person the camera keeps in frame,
   * across every angle, for the whole clip is nearly always the one being
   * recorded, and that is what the coverage and shot terms carry.
   */
  const W_TALK = 0.26, W_COVER = 0.22, W_SHOT = 0.12, W_SIZE = 0.08, W_CENTRE = 0.12, W_FACE = 0.20;

  function scoreTracks(list) {
    const maxSize = Math.max(1e-6, ...list.map((s) => s.size));
    const talks = list.map((s) => s.talk).filter((t) => t != null);
    const maxTalk = talks.length ? Math.max(1e-6, ...talks) : 0;
    for (const s of list) {
      const talk = s.talk == null ? 0.4 : Math.min(1, s.talk / maxTalk);   // unmeasured = neutral
      s.parts = {
        talk, cover: Math.min(1, s.cover), shots: Math.min(1, s.shots),
        size: s.size / maxSize, centre: s.centre, facing: s.facing,
      };
      s.score = W_TALK * talk + W_COVER * s.parts.cover + W_SHOT * s.parts.shots
        + W_SIZE * s.parts.size + W_CENTRE * s.centre + W_FACE * s.facing;
    }
    return list;
  }

  /*
   * How many identities to actually follow before choosing between them.
   *
   * Taking the biggest few clusters is not enough, and the reason is the whole
   * problem in miniature: the person who is EASIEST to detect is usually not
   * the one speaking. A crozier-bearer standing still, face square to the
   * camera, is found in every frame and fragments into a dozen large clusters;
   * the bishop beside him, half turned into a microphone under a mitre, is
   * found in a handful. Seeded from any of the bearer's fragments the tracker
   * produces the same track, so "the top six clusters" can be six copies of one
   * wrong answer, and the right answer never gets tried at all.
   *
   * So clusters are tried in size order but a track is only KEPT if it is
   * materially different from the ones already tried — different people, not
   * different seeds for the same person — until enough distinct answers exist
   * to choose between.
   */
  const MIN_COVER = 0.15;       // share of the clip a candidate must be in to be considered at all
  const CANDIDATES = 5;         // distinct people to weigh up
  const CAND_TRIES = 24;        // clusters to try before giving up on finding that many
  const SAME_TRACK = 0.6;       // agreeing on this share of frames means it is the same answer

  /** Do two tracks pick the same person? (Agreement over the frames both filled.) */
  function sameTrack(a, b) {
    let both = 0, agree = 0;
    for (let i = 0; i < a.length; i++) {
      if (!a[i] || !b[i]) continue;
      both++;
      if (Math.abs(a[i].cx - b[i].cx) < 0.04) agree++;
    }
    return both >= 8 && agree / both >= SAME_TRACK;
  }

  /* ===================== ☁️ THE REFEREE — WHO IS PREACHING? =====================
   *
   * Everything above decides who a clip is about from what a computer can
   * measure: colour signatures, mouth movement, screen time. On a church
   * platform each of those is fooled somewhere — the attendant who stands still
   * in every frame, congregation heads in front of a wide shot, a man walking
   * past the lens — and when the pick is wrong the whole short follows the wrong
   * person, however smoothly. The operator called the result "shocking".
   *
   * So when a referee is offered (the studio passes one that asks a cloud vision
   * model — see src/main/cloudsee.js), a few frames are SHOWN to it: one per
   * camera shot, another every few seconds of a long one, tiled into one
   * picture, each ruled into eight numbered columns. It answers with a column
   * per frame — where the speaker's head is — or 0: the speaker is not in it.
   *
   * ►► WHY COLUMNS, AND NOT "WHICH OF THESE BOXES". ◄◄ The first version drew a
   * numbered box round every person the detectors found and asked which box.
   * On the church's own footage it failed exactly where it was needed: with the
   * preacher hidden behind people walking past, it chose a "face" the detector
   * had found on the giant S of the backdrop; with the preacher too small to be
   * detected, it chose the box nearest him. A model asked to pick from a list
   * picks from the list. Asked for a column, over twelve real frames it was
   * never once on the wrong person — exact in ten, one column out on a
   * boundary, and "cannot see him" once when it could have. Its own guesses at
   * coordinates were 0.1 of the frame out; a labelled column is a question it
   * reads, not one it estimates.
   *
   * The PC then supplies the precision: the person it detected in that column
   * becomes the speaker in that frame — a FACT for the tracker, whose look is
   * then followed through every other frame, from every angle the referee
   * vouched in (which colour matching alone could not bridge). Where the
   * detectors found nobody in that column, the column itself marks where the
   * speaker is at that moment. A frame it says has no speaker is followed in by
   * nobody. Every frame in between is still the local tracker's work.
   *
   * When there is no referee, or it cannot be reached, nothing below changes.
   */
  const REF_MAX = 12;       // frames shown per clip (two pictures)
  const REF_PER_GRID = 6;   // frames tiled into one picture (the request costs about the same)
  const REF_EVERY = 8;      // s: a long shot gets another look this often
  const REF_COLS = 8;       // columns each frame is ruled into
  const REF_TILE = 448;     // px, the long side of one frame in the grid
  const REF_LETTERS = 'ABCDEFGHIJKL';
  const REF_WALLPAPER = 0.12;  // a "head" this wide with no body under it is the backdrop
  const HINT_AGREE = 0.19;     // a position within 1.5 columns agrees with the referee's column

  /** Which frames to show: the shots with people in them, longest and busiest first. */
  function refereePlan(raw) {
    const shots = new Map();
    raw.forEach((f, i) => {
      if (!f.people || !f.people.length) return;
      if (!shots.has(f.shot)) shots.set(f.shot, []);
      shots.get(f.shot).push(i);
    });
    const picks = [];
    for (const idx of shots.values()) {
      const t0 = raw[idx[0]].t, span = raw[idx[idx.length - 1]].t - t0;
      const n = Math.max(1, Math.min(3, Math.round(span / REF_EVERY)));
      for (let k = 0; k < n; k++) {
        const want = t0 + span * (k + 0.5) / n;
        // nearest the moment wanted, nudged towards frames where bodies were found
        let best = idx[0], bd = Infinity;
        for (const i of idx) {
          const d = Math.abs(raw[i].t - want) - 0.15 * raw[i].people.filter((p) => p.pose).length;
          if (d < bd) { bd = d; best = i; }
        }
        // two or more people is where the local pick goes wrong: ask about those first
        picks.push({ i: best, w: span / n + (raw[best].people.length > 1 ? 6 : 0) });
      }
    }
    const seen = new Set();
    return picks.sort((a, b) => b.w - a.w).filter((p) => !seen.has(p.i) && seen.add(p.i))
      .slice(0, REF_MAX).map((p) => p.i).sort((a, b) => a - b);
  }

  /**
   * The person the PC found where the referee says the speaker is: in that
   * column, or within half a column of it (it is a column out on a boundary
   * now and then). Bodies before bare faces; a huge bodiless "face" is the
   * backdrop and never counts. null when the detectors found nobody there.
   */
  function personInColumn(people, col) {
    const c = (col - 0.5) / REF_COLS, reach = 1 / REF_COLS;
    const bodied = (p) => !!(p.pose || p.body);
    const near = (people || []).filter((p) => Math.abs(p.cx - c) <= reach && (bodied(p) || (p.bw || 0) <= REF_WALLPAPER));
    if (!near.length) return null;
    near.sort((a, b) => ((bodied(b) ? 1 : 0) - (bodied(a) ? 1 : 0)) || (Math.abs(a.cx - c) - Math.abs(b.cx - c)));
    // two bodies in the same column (one in front of the other) is a question
    // a column cannot answer — leave that frame to the tracker
    if (near.length > 1 && bodied(near[0]) && bodied(near[1]) && Math.abs(near[0].cx - near[1].cx) < reach) return 'ambiguous';
    return near[0];
  }

  /** One picture of several frames, each ruled into numbered columns and lettered. */
  async function refereeGrid(tiles, frames) {
    if (typeof document === 'undefined') return null;
    const imgs = await Promise.all(tiles.map((t) => loadImage(frames[t.i].url)));
    return drawColumnGrid(imgs, tiles.map((t) => t.label));
  }
  /** imgs: anything drawImage takes (an <img>, a canvas, a playing <video>). */
  function drawColumnGrid(imgs, labels) {
    if (typeof document === 'undefined') return null;
    const first = imgs.find(Boolean);
    if (!first) return null;
    const ar = (first.naturalWidth || first.videoWidth || first.width || 16) / (first.naturalHeight || first.videoHeight || first.height || 9);
    const tiles = labels.map((label) => ({ label }));
    const cw = ar >= 1 ? REF_TILE : Math.round(REF_TILE * ar), ch = ar >= 1 ? Math.round(REF_TILE / ar) : REF_TILE;
    const cols = ar >= 1 ? 2 : 3, rows = Math.ceil(tiles.length / cols);
    const cv = document.createElement('canvas');
    cv.width = cw * Math.min(cols, tiles.length); cv.height = ch * rows;
    const g = cv.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    const colW = cw / REF_COLS;
    tiles.forEach((t, k) => {
      const ox = (k % cols) * cw, oy = Math.floor(k / cols) * ch;
      if (imgs[k]) g.drawImage(imgs[k], ox, oy, cw, ch);
      // full-height rulings: measured, short ticks top and bottom made it guess
      // wrong three frames in six; lines this faint still let it see who is there
      g.fillStyle = 'rgba(255, 230, 0, 0.55)';
      for (let c = 1; c < REF_COLS; c++) g.fillRect(ox + Math.round(c * colW) - 1, oy, 2, ch);
      g.font = 'bold 15px Arial, sans-serif'; g.textBaseline = 'top';
      for (let c = 0; c < REF_COLS; c++) {
        const x = ox + Math.round(c * colW + colW / 2 - 10);
        g.fillStyle = '#ffe600'; g.fillRect(x, oy + ch - 24, 20, 22);
        g.fillStyle = '#000'; g.fillText(String(c + 1), x + 6, oy + ch - 20);
      }
      g.fillStyle = '#000'; g.fillRect(ox + cw - 34, oy, 34, 30);
      g.fillStyle = '#fff'; g.font = 'bold 24px Arial, sans-serif';
      g.fillText(t.label, ox + cw - 27, oy + 3);
      g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(ox, oy, cw, ch);
    });
    try { return cv.toDataURL('image/jpeg', 0.82); } catch (e) { return null; }
  }

  /**
   * Show the chosen frames to the referee and keep its answers on them:
   * `f.refVouch` = the person the PC found where it says the speaker is,
   * `f.refHint`  = just the column centre, where the PC found nobody there,
   * `f.refNone`  = it says the speaker is not in this frame.
   * Kept on the signals, so choosing again (or a re-render) never asks twice.
   */
  async function refereeVouch(raw, frames, referee) {
    const plan = refereePlan(raw);
    const rep = { asked: 0, answered: 0, vouched: 0, hinted: 0, none: 0, unsure: 0, ok: false, why: '', model: '', ms: 0 };
    raw.referee = rep;
    if (!plan.length) { rep.why = 'nobody to ask about'; return rep; }
    const t0 = Date.now();
    for (let at = 0; at < plan.length; at += REF_PER_GRID) {
      const tiles = plan.slice(at, at + REF_PER_GRID).map((i, k) => ({ i, label: REF_LETTERS[k], people: raw[i].people }));
      rep.asked += tiles.length;
      let image = null;
      try { image = await refereeGrid(tiles, frames); } catch (e) { image = null; }
      let ans = null;
      try {
        ans = await referee({ image, columns: REF_COLS, frames: tiles.map((t) => ({ label: t.label })), tiles, t: tiles.map((t) => raw[t.i].t) });
      } catch (e) { ans = { ok: false, why: (e && e.message) || 'the referee failed' }; }
      if (!ans || !ans.ok || !ans.answers) { rep.why = (ans && ans.why) || 'no answer'; continue; }
      rep.ok = true; rep.model = ans.model || rep.model;
      for (const t of tiles) {
        const a = ans.answers[t.label];
        if (!a) continue;
        rep.answered++;
        const f = raw[t.i];
        const col = Math.round(Number(a.column));
        if (col >= 1 && col <= REF_COLS) {
          const p = personInColumn(f.people, col);
          if (p === 'ambiguous') { rep.unsure++; continue; }
          if (p) { f.refVouch = p; f.refSure = a.sure !== false; rep.vouched++; }
          else { f.refHint = (col - 0.5) / REF_COLS; rep.hinted++; }
          f.refNone = false;
        } else if (col === 0) { f.refVouch = null; f.refNone = true; rep.none++; }
      }
    }
    rep.ms = Date.now() - t0;
    if (rep.ok) rep.why = '';
    raw.refereeDone = rep.ok;   // a failed ask is asked again next time — the internet may be back
    return rep;
  }

  /**
   * Decide who the clip is about and follow them. Returns null when there is
   * nobody to follow, in which case the geometric tracker below runs exactly as
   * it did before this layer existed.
   */
  function pickSubject(frames, nShots, lock, noReferee) {
    const clusters = clusterPeople(frames);
    if (!clusters.length) return null;

    // The user's pick short-circuits everything: follow that look, and only
    // fall back to guessing if they turn out not to be in this clip at all.
    if (lock) {
      const anchor = [lock];
      const track = trackSubjectWith(frames, anchor);
      const st = trackStats(frames, track, nShots);
      if (st.cover >= LOCK_MIN) {
        st.id = -1; st.locked = true; st.sig = lock;
        st.parts = { talk: 0, cover: st.cover, shots: st.shots, size: 0, centre: st.centre, facing: st.facing };
        st.score = st.cover;
        return { track, chosen: st, stats: [st], anchor, sig: lock, why: 'locked, in ' + Math.round(st.cover * 100) + '% of frames' };
      }
    }

    // Take the identities with enough sightings to be worth trying, actually
    // FOLLOW each one through the clip, and judge them on what that produced
    // rather than on the raw clustering (which the graphics overlay fragments —
    // see the note above). Followed WITHOUT the referee's answers, so that each
    // can be judged against them below rather than forced to agree.
    const vouched = [];
    for (let i = 0; i < frames.length; i++) if (frames[i].vouch) vouched.push(i);
    const order = clusters.map((c, i) => i).sort((a, b) => clusters[b].n - clusters[a].n).slice(0, CAND_TRIES);
    const tried = [];
    for (const i of order) {
      if (tried.length >= CANDIDATES) break;
      const track = trackSubjectWith(frames, clusters[i].ex, false);
      if (tried.some((t) => sameTrack(t.track, track))) continue;   // another seed, same answer
      const st = trackStats(frames, track, nShots);
      if (!st.n) continue;
      st.id = i; st.track = track; st.sig = clusters[i].sig; st.ex = clusters[i].ex;
      tried.push(st);
    }

    /*
     * THE REFEREE CHOOSES; IT DOES NOT START OVER. Its answers name a person in
     * a handful of frames. The first version built a fresh identity from just
     * those frames — and a look learned from one frame recognises the man in
     * few others, so on the church's own footage the AI's pick covered too
     * little of the clip to take charge, and the old "follow the biggest face"
     * fallback walked the crop onto a woman crossing the stage while this PC's
     * own pick (the same preacher, recognised in far more frames) had simply
     * held still and waited for him. So: if one of the people this PC already
     * tracked IS the person the referee named, that is the pick — with its full
     * coverage, plus the referee's frames as facts and its angles as extra
     * anchors. Only if none of them is him does the referee's own anchor drive.
     */
    if (vouched.length && !noReferee && tried.length) scoreTracks(tried);   // the PC's own ranking breaks ties below
    if (vouched.length && !noReferee) {
      const sure = vouched.filter((i) => frames[i].vouchSure);
      const refSigs = (sure.length ? sure : vouched).map((i) => frames[i].vouch.sig).filter(Boolean);
      const isHim = (p, i) => p === frames[i].vouch || Math.abs(p.cx - frames[i].vouch.cx) < 0.03;
      let best = null, bestNet = 0;
      for (const st of tried) {
        let yes = 0, no = 0;
        for (const i of vouched) {
          const p = st.track[i];
          // not tracked in that very frame, but LOOKS like the man it named: this
          // PC often splits one preacher into several looks under different light
          if (!p) { const v = frames[i].vouch; if (v.sig && st.ex && simMax(st.ex, v.sig) >= ACCEPT_NEAR) yes++; continue; }
          if (isHim(p, i)) yes++; else no++;
        }
        st.aiYes = yes; st.aiNo = no;
        // most agreement wins; on a tie (one AI frame, several of this PC's
        // candidates all on him there) the one this PC itself rated best
        if (yes > no && (yes - no > bestNet || (yes - no === bestNet && best && (st.cover >= MIN_COVER) >= (best.cover >= MIN_COVER) && st.score > best.score))) { bestNet = yes - no; best = st; }
      }
      const ref = frames.referee || {};
      const asked = ref.asked || vouched.length;
      const anchor = (best ? best.ex || [] : []).concat(refSigs);
      const track = trackSubjectWith(frames, anchor.length ? anchor : refSigs);
      const st = trackStats(frames, track, nShots);
      st.id = best ? best.id : -2; st.ai = true; st.sig = best ? best.sig : (refSigs[0] || null);
      st.parts = { talk: 0, cover: st.cover, shots: st.shots, size: 0, centre: st.centre, facing: st.facing };
      st.score = st.cover;
      return { track, chosen: st, stats: [st].concat(tried.filter((t) => t !== best)), anchor, sig: st.sig,
        why: best
          ? 'AI confirmed the speaker in ' + vouched.length + ' of ' + asked + ' frames it was shown (this PC had found him too)'
          : 'AI picked the speaker in ' + vouched.length + ' of ' + asked + ' frames it was shown' };
    }

    if (!tried.length) return null;
    scoreTracks(tried);
    /*
     * A candidate who is barely in the clip cannot be what the clip is about,
     * however well they score on everything else. Measured: on a 48s window a
     * face seen in SIX frames out of 288 won the vote outright — the mouth and
     * face-visibility terms both max out for somebody glimpsed once at a good
     * moment, and coverage alone is not weighted enough to stop them. Anybody
     * present for a reasonable share of the clip is preferred outright; the
     * floor only lifts when nobody at all clears it (a clip that really is one
     * long crowd shot with the speaker in three frames of it).
     */
    const enough = tried.filter((t) => t.cover >= MIN_COVER);
    const pool = enough.length ? enough : tried;
    const chosen = pool.reduce((a, b) => (b.score > a.score ? b : a), pool[0]);
    return {
      track: chosen.track, chosen, stats: tried, anchor: chosen.ex, sig: chosen.sig,
      why: 'auto ' + chosen.score.toFixed(2),
    };
  }

  /*
   * A BLIP IS NOT A WALK.
   *
   * Measured on "Time of Prayers" (t=8460): the preacher sat perfectly still at
   * the right edge for a whole minute, and the finished crop left him out of
   * shot for 11.5 of the 60 seconds. Each time, somebody walked past in front
   * of the camera and was taken for him for two to four samples — "recognised"
   * at 0.49-0.64 while he sat at 0.93 — and the camera followed. Worse, a body
   * that close to the lens repaints most of the picture, so the cut detector
   * reports a CUT there too, and at a cut the camera is allowed to snap.
   *
   * A person cannot cross a third of the frame and come back within a second.
   * So a short run of sightings far from where the subject was, after which the
   * track RETURNS to that same place, is a mistaken identity, whatever the
   * colours said — and those samples are dropped, so the camera simply holds.
   * A real move (a walk across the stage, a real cut to another angle) does not
   * come back to the same spot within the window, and is untouched.
   */
  const BLIP_FAR = 0.15;     // away from where they were: about half a 9:16 crop
  const BLIP_BACK = 0.08;    // ...and back to within this of it
  const BLIP_LEN = 1.0;      // s: a run this short that comes back is a blip, however it moved
  const BLIP_SPAN = 1.6;     // s: ...if it is back within this of the last good sighting
  // A longer excursion (up to BLIP_MAX) is a blip only if it left or came back
  // faster than anybody moves on a stage: ≥ BLIP_JUMP of the frame at ≥
  // BLIP_SPEED frame-widths a second. A preacher who paces out and back passes
  // through the positions in between and is never caught by it. Measured on
  // t=8460: the mistaken sightings left the preacher at 0.56 widths/s and came
  // back at up to 2.1; a brisk walk across this stage is ~0.3.
  const BLIP_MAX = 3.0;
  const BLIP_JUMP = 0.25, BLIP_SPEED = 0.5;
  const BLIP_RECENT = 4.0;   // s: the "where they were" sighting must be this recent
  function dropBlips(frames, track) {
    const seen = [];
    for (let i = 0; i < track.length; i++) if (track[i]) seen.push(i);
    const out = track.slice();
    let dropped = 0;
    const fast = (i, j) => {
      const dx = Math.abs(track[j].cx - track[i].cx), dt = Math.max(1 / 6, Math.abs(frames[j].t - frames[i].t));
      return dx >= BLIP_JUMP && dx / dt >= BLIP_SPEED;
    };
    for (let a = 0; a < seen.length - 1; a++) {
      const i0 = seen[a], x0 = track[i0].cx;
      let b = a + 1;
      if (Math.abs(track[seen[b]].cx - x0) <= BLIP_FAR) continue;
      if (frames[seen[b]].t - frames[i0].t > BLIP_RECENT) continue;  // "where he was" is too old to compare
      while (b < seen.length && Math.abs(track[seen[b]].cx - x0) > BLIP_FAR) b++;
      if (b >= seen.length) break;                                   // never came back
      const first = seen[a + 1], last = seen[b - 1], back = seen[b];
      if (Math.abs(track[back].cx - x0) > BLIP_BACK) continue;       // came back somewhere else
      const len = frames[last].t - frames[first].t;
      const short = len <= BLIP_LEN && frames[back].t - frames[i0].t <= BLIP_SPAN;
      const jumped = len <= BLIP_MAX && (fast(i0, first) || fast(last, back));
      if (!short && !jumped) continue;
      for (let k = a + 1; k < b; k++) { out[seen[k]] = null; dropped++; }
      a = b - 1;
    }
    // …and the same mistake seen from the other end. The track can drift away
    // from the speaker a little at a time (a passer-by taken for him, sighting
    // by sparse sighting) and only the RETURN gives it away: an impossible jump
    // back to where he was a few seconds ago. Everything far from that spot
    // since he was last seen there was somebody else. (t=8460: 0.86 → 0.72 →
    // 0.59 → 0.60 over three seconds, then 0.95 one sample later.)
    const left = [];
    for (let i = 0; i < out.length; i++) if (out[i]) left.push(i);
    // positions read from a snapshot: this pass drops samples as it goes, and a
    // later step must still be able to read where a dropped one was
    const px = left.map((i) => out[i].cx);
    for (let n = 1; n < left.length; n++) {
      const j = left[n - 1], k = left[n];
      if (!fast(j, k)) continue;
      // where he came BACK to: the median of the next few sightings, not the
      // first alone (t=8460: the first read 0.95 where he sits at 0.86)
      const nextXs = [];
      for (let q = n; q < left.length && nextXs.length < 5 && frames[left[q]].t - frames[k].t <= 1.0; q++) if (out[left[q]]) nextXs.push(px[q]);
      const xk = med(nextXs);
      let m = n - 2;
      while (m >= 0 && frames[k].t - frames[left[m]].t <= BLIP_RECENT && (!out[left[m]] || Math.abs(px[m] - xk) > BLIP_BACK)) m--;
      if (m < 0 || frames[k].t - frames[left[m]].t > BLIP_RECENT) continue;   // he was not there recently
      for (let q = m + 1; q < n; q++) if (out[left[q]] && Math.abs(px[q] - xk) > BLIP_FAR) { out[left[q]] = null; dropped++; }
    }
    out.blips = dropped;
    return out;
  }

  /** Hang the chosen person's position on each frame, for the tracker below. */
  function subjectPositions(frames, pick) {
    for (let i = 0; i < frames.length; i++) if (pick.track[i]) frames[i].subject = pick.track[i];
  }

  /**
   * PASS A, lifted out so its result can be REUSED. This is the whole cost of
   * tracking — two neural nets over every sampled frame, minutes on a long clip
   * — and none of it depends on who we end up following. detectFrames hands the
   * result back on `out.signals`; give it back as `opts.signals` and changing
   * who to follow costs milliseconds instead of re-watching the clip, which is
   * what makes the studio's picker usable on a three-minute short.
   */
  /** An <img> for a frame, or null if it would not load. */
  function loadImage(url) {
    return new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  async function detectSignals(frames, det, onProg, stopped) {
    const raw = [];
    for (let i = 0; i < frames.length; i++) {
      // ✕ Cancel: stop between pictures, not after the whole short
      if (stopped && stopped()) { const e = new Error('Cancelled'); e.cancelled = true; throw e; }
      if (i % 25 === 0 && window.__crumb) window.__crumb(`tracking: picture ${i + 1} of ${frames.length}${poser ? '' : ' (faces only)'}`);
      const f = frames[i];
      const img = await loadImage(f.url);
      const ok = !!img;
      let cands = [], pose = null, people = [];
      if (ok) {
        let r; try { r = det.detect(img); } catch (e) { r = { detections: [] }; }
        const w = img.naturalWidth || 1, h = img.naturalHeight || 1;
        cands = (r.detections || []).map((d) => {
          const b = d.boundingBox;
          return {
            area: b.width * b.height,
            wNorm: b.width / w,
            hNorm: b.height / h,
            cx: (b.originX + b.width / 2) / w,
            cy: (b.originY + b.height / 2) / h,
            score: d.categories && d.categories[0] ? d.categories[0].score : 0,
          };
        });
        let poses = [];
        if (poser) {
          let pr; try { pr = poser.detect(img); } catch (e) { pr = null; }
          poses = poseHeads(pr);
        }
        pose = poses.length ? poses[0] : null;
        people = buildPeople(cands, poses);
        refinePoseOnly(img, people, det);
        const px = framePixels(img);
        if (px) {
          for (const pp of people) pp.sig = personSig(px, pp.cx, pp.cy, pp.bw, pp.bh);
          if (f.pairUrl) {
            const pair = await loadImage(f.pairUrl);
            const ppx = pair ? framePixels(pair) : null;
            if (ppx && ppx.gray.length === px.gray.length) measureMouths(px, ppx.gray, people);
            if (pair) { try { pair.removeAttribute('src'); } catch (e) {} }
          }
        }
        // let the decoded picture go now — a phone tracking a whole batch of
        // shorts otherwise holds hundreds of them until the browser gets round to it
        try { img.removeAttribute('src'); } catch (e) {}
      }
      // `pose0` is the untouched reading. `pose` gets swapped for the subject's
      // own body once we know who that is, and these signals are re-used across
      // picks — without the original to restore, the second pick would inherit
      // the first one's idea of whose body matters.
      raw.push({ t: f.t, cands, pose, pose0: pose, people });
      if (onProg) onProg((i + 1) / frames.length);
    }
    return raw;
  }

  /**
   * detectFrames(frames, opts) — opts.cuts = scene-cut events [{t, score}] from
   * the ffmpeg scene pass (multi-camera hard cuts + operator whip pans), opts.onProg
   * = progress callback. Back-compat: a function as the 2nd arg is treated as onProg.
   */
  async function detectFrames(frames, opts) {
    if (typeof opts === 'function') opts = { onProg: opts };
    opts = opts || {};
    const onProg = opts.onProg;
    const CUT_SCORE = 0.14;
    const cutTimes = (opts.cuts || [])
      .filter((c) => c && c.t != null && (c.score == null || c.score >= CUT_SCORE))
      .map((c) => c.t).sort((a, b) => a - b);
    const cutBetween = (t0, t1) => cutTimes.some((c) => c > Math.min(t0, t1) && c <= Math.max(t0, t1));

    // Re-using signals means the models are not needed at all — nothing below
    // this point looks at a picture. That keeps a second pick instant, and lets
    // the identity layer be tested on made-up signals with no models present.
    const det = opts.signals && opts.signals.length === frames.length ? null : await init();

    // PASS A — every face candidate, every body, what each person LOOKS like
    // and how much their mouth is moving (see detectSignals: this is the
    // expensive, reusable half of tracking).
    const raw = opts.signals && opts.signals.length === frames.length
      ? opts.signals : await detectSignals(frames, det, onProg, opts.stopped);
    // A reused signal set still carries last run's verdicts — clear them, or a
    // second pick would be judged against the first one's answers.
    for (const f of raw) {
      f.subject = null; f.poseSure = false; f.poseRef = undefined; f.candsF = null;
      if (f.pose0 !== undefined) f.pose = f.pose0;
      if (f.people) for (const pp of f.people) pp.cid = undefined;
    }

    // Shot numbers up front — identity spans camera angles, but "seen in the
    // same frame as" and "seen in N different angles" both need to know which
    // shot a sample belongs to.
    for (let i = 0; i < raw.length; i++) raw[i].shot = i === 0 ? 0 : raw[i - 1].shot + (cutBetween(raw[i - 1].t, raw[i].t) ? 1 : 0);
    const nShots = raw.length ? raw[raw.length - 1].shot + 1 : 1;

    // PASS A0 — ASK THE REFEREE (see THE REFEREE above). Only when the operator
    // has not pointed at somebody themselves: their pick is an instruction, the
    // referee's is advice. Asked once per set of signals, so changing who to
    // follow, or rendering again, costs nothing.
    if (!opts.lock && typeof opts.referee === 'function' && !raw.refereeDone && raw.some((f) => f.people && f.people.length)) {
      try { await refereeVouch(raw, frames, opts.referee); } catch (e) { raw.referee = { ok: false, why: (e && e.message) || 'referee failed' }; }
    }
    // Its answers count only on a run that asked for them: the same signals
    // reused with the AI switched off (or with the operator's own pick) must
    // behave exactly as if it had never been asked.
    const useRef = !opts.lock && typeof opts.referee === 'function';
    for (const f of raw) {
      f.vouch = useRef ? (f.refVouch || null) : null;
      f.vouchSure = useRef && !!f.refSure;
      f.vouchNone = useRef && !!f.refNone;
      f.vouchHint = useRef && !f.refVouch && f.refHint != null ? f.refHint : null;
    }

    // PASS A1 — WHO IS THIS CLIP ABOUT? (see the identity layer above). The
    // answer is a position per frame that the geometry below simply follows.
    let pick = null;
    let overruled = false;   // the referee's columns said this PC's pick was somebody else
    if (raw.some((f) => f.people && f.people.length && f.people.some((p) => p.sig))) {
      try {
        // Identity says WHO; recoverBlind and bridgeTrack say "and he is still
        // standing there" for the frames identity could not vouch for — within
        // a shot by walking continuity, and across a whole unrecognised shot by
        // there being only one person in it. Without them the camera holds its
        // ground through gaps that ran to 14.5s on real footage.
        const finish = (pk) => {
          if (!pk) return { pk: null, recognised: null };
          const recognised = pk.track.slice();   // before any bridging
          if (opts.bridge !== false) {
            pk.track = recoverBlind(raw, pk.track);
            pk.track = bridgeTrack(raw, pk.track, cutBetween);
          }
          return { pk, recognised };
        };
        let recognised = null;
        const vouchedAt = opts.lock ? [] : raw.map((f, i) => (f.vouch ? i : -1)).filter((i) => i >= 0);
        if (vouchedAt.length) {
          /*
           * THIS PC'S OWN ANSWER FIRST, FINISHED, THEN CHECKED. On the church's
           * footage this PC's pick was usually already the preacher — reaching
           * the frames the referee confirmed through its gap-filling rather than
           * by recognising him there. Replacing it with a pick built around the
           * referee's few frames gave a weaker track whose own gap-filling walked
           * the crop onto a woman crossing the stage for two seconds while he was
           * out of shot. So the referee CONFIRMS or OVERRULES; it does not redo
           * work that was right. Confirmed: the PC's track stands exactly, with
           * the referee's frames written in as facts. Contradicted: its pick.
           */
          const own = finish(pickSubject(raw, nShots, null, true));
          let yes = 0, no = 0;
          if (own.pk) for (const i of vouchedAt) {
            const p = own.pk.track[i], v = raw[i].vouch;
            if (!p) continue;
            if (p === v || Math.abs(p.cx - v.cx) < 0.03) yes++; else no++;
          }
          if (own.pk && yes > no) {
            for (const i of vouchedAt) own.pk.track[i] = raw[i].vouch;
            own.pk.chosen.ai = true;
            const ref = raw.referee || {};
            own.pk.why = 'AI confirmed this PC\'s pick in ' + yes + ' of ' + (ref.asked || vouchedAt.length) + ' frames it was shown';
            ({ pk: pick, recognised } = own);
          } else {
            ({ pk: pick, recognised } = finish(pickSubject(raw, nShots, null)));
          }
        } else {
          pick = pickSubject(raw, nShots, opts.lock);
          /*
           * Where the referee saw the speaker but the detectors found nobody in
           * that column, its column still says where he is NOT. A pick made by
           * this PC alone that sits somewhere else in most of those frames is
           * following the wrong person — drop it, and let the referee's columns
           * and the plain tracker below carry the clip instead.
           */
          if (pick && !opts.lock) {
            let agree = 0, against = 0;
            for (let i = 0; i < raw.length; i++) {
              if (raw[i].vouchHint == null || !pick.track[i]) continue;
              if (Math.abs(pick.track[i].cx - raw[i].vouchHint) <= HINT_AGREE) agree++; else against++;
            }
            if (against > agree) { pick = null; overruled = true; }
          }
          ({ pk: pick, recognised } = finish(pick));
        }
        // …and the bridges above may not walk anybody INTO a frame the referee
        // looked at and said the speaker is not in — nor into the rest of a
        // CUTAWAY: a shot where that is all it said AND nobody in it was
        // recognised as the speaker, so "the only person there" is a congregant.
        // ►► Both conditions, measured: the model's "cannot see him" is its
        // commonest mistake (a small preacher on a wide stage, missed in two
        // pictures out of three), and on its own it would have cleared a whole
        // shot of him. Somebody actually RECOGNISED there is evidence and stays.
        if (pick && !opts.lock && raw.some((f) => f.vouchNone)) {
          const noneShot = new Set(), yesShot = new Set(), seenShot = new Set();
          for (let i = 0; i < raw.length; i++) {
            const f = raw[i];
            if (f.vouchNone) noneShot.add(f.shot);
            if (f.vouch || f.vouchHint != null) yesShot.add(f.shot);
            if (recognised[i]) seenShot.add(f.shot);
          }
          for (let i = 0; i < raw.length; i++) {
            const sh = raw[i].shot;
            if (raw[i].vouchNone) pick.track[i] = null;
            else if (noneShot.has(sh) && !yesShot.has(sh) && !seenShot.has(sh)) pick.track[i] = null;
          }
        }
        if (pick && opts.blips !== false) pick.track = dropBlips(raw, pick.track);
        if (pick) subjectPositions(raw, pick);
      } catch (e) { pick = null; console.warn('subject layer skipped:', e && e.message); }
    }
    /*
     * ONCE WE KNOW WHO, A FRAME WITHOUT THEM IS A GAP — NOT SOMEBODY ELSE.
     *
     * A speaker under a mitre, half turned into a microphone, is only findable
     * in about a third of the samples on this footage; the man standing beside
     * him is findable in all of them. If the frames where the speaker cannot be
     * seen fall through to "track whatever face is here", the crop spends most
     * of the clip on the wrong person and jumps back and forth besides — which
     * is exactly what the shipped exports did.
     *
     * Reporting those frames as MISSES instead is both more honest and better
     * looking: the virtual camera already knows how to interpolate through a
     * short gap and sit still through a long one, so the crop simply stays where
     * the speaker was until he can be seen again. The old face-first tracker is
     * still there for clips where nobody could be identified at all.
     */
    // (once the referee has named the speaker, frames without him are held,
    // however rarely he is recognised: the fallback below would follow whoever
    // else is biggest, and the referee has just said that is not him)
    const subjectDrives = !!pick && (pick.chosen.cover >= 0.18 || !!pick.chosen.ai);
    // …and when the referee overruled this PC's pick, its columns are the only
    // thing that knows where the speaker is: between them the camera holds,
    // it does not fall back to following whoever the detectors can find.
    const refereeDrives = !pick && overruled;
    // The legacy paths below take ONE body per frame as "the" body. Now that we
    // know who the clip is about, hand them the subject's body rather than
    // whichever the pose model happened to rank first.
    for (const f of raw) if (f.subject && f.subject.pose) f.pose = f.subject.pose;

    // PASS A2 — WHO DO WE TRUST? Church stage backdrops love scripture art,
    // murals and portraits — patterns that detect as big, confident faces frame
    // after frame, while the real speaker's face (small, dark stage lighting)
    // flickers in and out. On such footage a face-first tracker locks onto
    // WALLPAPER and the export crops scenery — measured on a real sermon: the
    // crop sat on a backdrop flourish at cx 0.13 for 18 straight seconds while
    // the preacher stood at 0.45. Flat art cannot fool the whole-body pose
    // model, so when the pose signal is PRESENT and CONTINUOUS across the clip
    // it becomes the arbiter: face candidates that contradict the body position
    // — or are far too big to be this person's head — are discarded before
    // tracking, and the survivors only ever refine the pose. When pose is
    // spotty or jumpy (crowd shots, several people trading the detector), the
    // face-first logic below stays in charge exactly as before.
    {
      const shotId = new Array(raw.length).fill(0);
      for (let i = 1; i < raw.length; i++) shotId[i] = shotId[i - 1] + (cutBetween(raw[i - 1].t, raw[i].t) ? 1 : 0);
      let pairs = 0, jumps = 0, prevP = null, prevShot = -1;
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i].pose) continue;
        if (prevP && shotId[i] === prevShot && (raw[i].t - prevP.t) <= 1.0) {
          pairs++;
          if (Math.abs(raw[i].pose.cx - prevP.pose.cx) > 0.22) jumps++;
        }
        prevP = raw[i]; prevShot = shotId[i];
      }
      const withPose = raw.reduce((n, f) => n + (f.pose ? 1 : 0), 0);
      const poseReliable = raw.length >= 8 && withPose >= 0.6 * raw.length
        && pairs >= 6 && jumps <= Math.min(3, Math.max(1, Math.round(0.06 * pairs)));
      if (poseReliable) {
        const AGREE = 0.15;     // candidates farther than this from the body are wallpaper/others
        const SIZE = 2.2;       // ... as are boxes over 2.2x the plausible head width
        const HOLD = 2.0;       // s to trust the last pose position through a pose dropout
        let held = null, heldW = null, heldT = -1e9, heldShot = -1;
        for (let i = 0; i < raw.length; i++) {
          const f = raw[i];
          // robust reference: median pose position over ±0.75s in the same shot
          // (a single bad pose reading must not throw away good candidates)
          const xs = [], ws = [];
          for (let j = i; j >= 0 && f.t - raw[j].t <= 0.75 && shotId[j] === shotId[i]; j--) if (raw[j].pose) { xs.push(raw[j].pose.cx); if (raw[j].pose.headW) ws.push(raw[j].pose.headW); }
          for (let j = i + 1; j < raw.length && raw[j].t - f.t <= 0.75 && shotId[j] === shotId[i]; j++) if (raw[j].pose) { xs.push(raw[j].pose.cx); if (raw[j].pose.headW) ws.push(raw[j].pose.headW); }
          let ref = null, refW = null;
          if (xs.length) {
            xs.sort((a, b) => a - b); ref = xs[xs.length >> 1];
            if (ws.length) { ws.sort((a, b) => a - b); refW = ws[ws.length >> 1]; }
            held = ref; heldW = refW; heldT = f.t; heldShot = shotId[i];
          } else if (heldShot === shotId[i] && f.t - heldT <= HOLD) { ref = held; refW = heldW; }
          if (ref != null) {
            // The survivors go in `candsF`, never over the top of `cands`: the
            // raw signals are reused when the user changes who to follow, and a
            // filtered-in-place list would hand the next run this run's answers.
            f.poseSure = true; f.poseRef = ref;
            if (f.cands.length) f.candsF = f.cands.filter((c) => Math.abs(c.cx - ref) <= AGREE && (refW == null || c.wNorm == null || c.wNorm <= SIZE * refW));
          }
        }
      }
    }

    // PASS B — track association. The leash keeps the track from hopping onto a
    // congregation face, BUT the subject's position legitimately TELEPORTS at a
    // camera cut or whip pan; there the track resets instantly (cut-aware) or a
    // jump is accepted when the NEXT frame confirms a face at the same new spot.
    // (The old code rejected the jumped speaker for up to 1.2s after every cut —
    // that was the "speaker out of frame" bug on multi-camera recordings.)
    const out = [];
    let lastCx = null, lastSeenT = -1e9;
    // a column-only sighting has no height: use where heads usually are in this clip
    const hintCy = med(raw.filter((f) => f.subject).map((f) => f.subject.cy)) || 0.35;
    const LEASH_DIST = 0.22, RESET_GAP = 1.2, CONFIRM = 0.10;
    const biggest = (arr) => arr.reduce((a, b) => (b.area > a.area ? b : a), arr[0]);
    for (let i = 0; i < raw.length; i++) {
      const f = raw[i];
      const cands = f.candsF || f.cands;
      if (i > 0 && cutBetween(raw[i - 1].t, f.t)) lastCx = null; // new shot: old track is meaningless
      // THE REFEREE'S COLUMN. It saw the speaker here and the detectors did not
      // (or found him somewhere else): its column is where he is, give or take
      // half a column — well inside a 9:16 crop.
      if (f.vouchHint != null && (!f.subject || Math.abs(f.subject.cx - f.vouchHint) > HINT_AGREE)) {
        lastCx = f.vouchHint; lastSeenT = f.t;
        out.push({ t: f.t, cxNorm: f.vouchHint, cyNorm: hintCy, score: 0, src: 'pose', subject: true, refereed: true,
          poseSure: true, poseCx: f.vouchHint, poseCy: hintCy });
        if (opts.debugRaw) { out[out.length - 1].cands = f.cands; out[out.length - 1].people = f.people; }
        continue;
      }
      // IDENTITY WINS. When PASS A1 knows which person this clip is about and
      // can see them in this frame, there is nothing left to arbitrate: no
      // biggest-box guess, no leash (the subject is allowed to be wherever they
      // are, including on the far side of a cut), no fusion guard (which exists
      // to catch the pose model following a stranger — this pose IS the
      // subject's). Everything below is the fallback for frames they are not in.
      if (f.subject) {
        const sj = f.subject;
        lastCx = sj.cx; lastSeenT = f.t;
        // `src` still says HOW they were found (a face, or only a body) — the
        // downstream guards and the pose-coverage tests both read it. `subject`
        // is the separate fact that this was the person we chose to follow.
        out.push({
          t: f.t, cxNorm: sj.cx, cyNorm: sj.cy, score: sj.score || 0,
          src: sj.src === 'face' ? 'face' : 'pose', subject: true, bridged: !!sj.bridged,
          poseSure: true, poseCx: sj.cx, poseCy: sj.cy,
        });
        if (opts.debugRaw) { out[out.length - 1].cands = f.cands; out[out.length - 1].people = f.people; }
        continue;
      }
      if (subjectDrives || refereeDrives) {   // we know who we are following and they are not here
        out.push({ t: f.t, cxNorm: null, noSubject: true });
        if (opts.debugRaw) { out[out.length - 1].cands = f.cands; out[out.length - 1].people = f.people; }
        continue;
      }
      const fresh = lastCx === null || (f.t - lastSeenT) > RESET_GAP;
      const blind = lastCx !== null && (f.t - lastSeenT) > 4; // long blind stretch: wide re-acquire
      const nearestTo = (arr, x) => arr.reduce((p, c) => (Math.abs(c.cx - x) < Math.abs(p.cx - x) ? c : p), arr[0]);
      let best = null;
      if (cands.length) {
        if (lastCx === null) best = biggest(cands); // true fresh start / just after a cut
        else {
          const near = cands.filter((c) => Math.abs(c.cx - lastCx) <= LEASH_DIST);
          if (near.length) {
            // STICKY: continue the track; only switch to a different nearby face
            // when it's decisively bigger — box sizes jitter frame to frame, and
            // flip-flopping between two nearby candidates whips the camera.
            const cont = nearestTo(near, lastCx);
            const big = biggest(near);
            best = big !== cont && big.area >= 1.6 * cont.area ? big : cont;
          } else if (fresh) {
            // detector was blind >1.2s in the SAME shot: the subject probably did
            // NOT teleport — prefer the face nearest the old track; fall back to
            // the biggest only after a LONG blind stretch (someone re-entered).
            const cand = nearestTo(cands, lastCx);
            best = Math.abs(cand.cx - lastCx) <= 0.30 ? cand : blind ? biggest(cands) : null;
          } else {
            // Possible jump (whip pan / missed cut): trust it only when the NEXT
            // TWO frames confirm a face at the same new spot AND nothing
            // reappears on the old track meanwhile — a phantom that shows for a
            // frame or two while the real face blinks must NOT steal the camera.
            const cand = biggest(cands);
            const n1 = raw[i + 1], n2 = raw[i + 2];
            const confirms = (n) => n && !cutBetween(f.t, n.t) && (n.candsF || n.cands).some((c) => Math.abs(c.cx - cand.cx) <= CONFIRM);
            const backNear = (n) => n && (n.candsF || n.cands).some((c) => Math.abs(c.cx - lastCx) <= LEASH_DIST);
            if (confirms(n1) && confirms(n2) && !backNear(n1) && !backNear(n2)) best = cand;
          }
        }
      }
      let use = null;
      if (best && f.pose) {
        const dv = Math.abs(best.cx - f.pose.cx);
        if (dv <= 0.18) {
          // face + body AGREE: body-stabilised head position. The face box
          // jitters with every head turn/lean (±10% swings while the feet never
          // move) — weighting the body keeps the camera calm during energetic
          // delivery instead of leash-yanking after each gesture.
          use = { cx: 0.6 * f.pose.cx + 0.4 * best.cx, cy: best.cy, score: best.score, src: 'face' };
        } else if (lastCx !== null) {
          // face + body DISAGREE: one of them switched subjects (a face-like
          // pattern in the set, a bystander). Bodies don't teleport — trust
          // whichever source CONTINUES the track. (Measured: the face detector
          // sat on a phantom at 0.27 for 3s while the preacher stood at 0.60 —
          // the pose was the one telling the truth.)
          use = Math.abs(f.pose.cx - lastCx) + 0.02 < Math.abs(best.cx - lastCx)
            ? { cx: f.pose.cx, cy: f.pose.cy, score: 0, src: 'pose' }
            : { cx: best.cx, cy: best.cy, score: best.score, src: 'face' };
        } else {
          use = { cx: best.cx, cy: best.cy, score: best.score, src: 'face' };
        }
      } else if (best) use = { cx: best.cx, cy: best.cy, score: best.score, src: 'face' };
      else if (f.pose) {
        // pose fallback with the same discipline: leashed to the track; after a
        // reset it must be NEAR the old position (numPoses:1 can latch onto a
        // different person — accepting it far away makes the camera ping-pong);
        // anywhere only when the track is brand new or long blind. A poseSure
        // frame (PASS A2 vetted this pose against its neighbours) is ALWAYS
        // accepted — even against the leash: if the track disagrees with a
        // corroborated body, the track is the one sitting on wallpaper.
        const okPose = f.poseSure ? true : lastCx === null ? true
          : Math.abs(f.pose.cx - lastCx) <= LEASH_DIST ? true
            : (fresh && Math.abs(f.pose.cx - lastCx) <= 0.30) || blind;
        if (okPose) use = { cx: f.pose.cx, cy: f.pose.cy, score: 0, src: 'pose' };
      }
      if (use) {
        lastCx = use.cx; lastSeenT = f.t;
        out.push({ t: f.t, cxNorm: use.cx, cyNorm: use.cy, score: use.score, src: use.src, poseSure: !!f.poseSure, poseCx: f.pose ? f.pose.cx : null, poseCy: f.pose ? f.pose.cy : null });
      } else {
        out.push({ t: f.t, cxNorm: null, poseCx: f.pose ? f.pose.cx : null, poseCy: f.pose ? f.pose.cy : null });
      }
      if (opts.debugRaw) { out[out.length - 1].cands = f.cands; out[out.length - 1].people = f.people; out[out.length - 1].poseRef = f.poseRef; }
    }

    // FUSION GUARD: with several people in a wide church shot, numPoses:1 can
    // latch onto someone who isn't the preacher. A pose-rescued position is only
    // trusted when it agrees with the nearest face detection IN THE SAME SHOT
    // (comparing across a camera cut is meaningless — positions teleport there);
    // if no face exists nearby, pose is the only signal left and is accepted.
    // Rejected entries become plain misses — buildKeyframes gap-fills them calmly.
    const GUARD = 0.22, NEAR = 4.5; // s
    const faces = out.filter((d) => d.src === 'face');
    for (let i = 0; i < out.length; i++) {
      const d = out[i];
      if (d.src !== 'pose' || d.poseSure) continue; // poseSure = already vetted by PASS A2 (nearby faces may be wallpaper — don't let them veto the body)
      let ref = null, refDt = 1e9;
      for (const fD of faces) {
        if (cutBetween(fD.t, d.t)) continue;
        const dt = Math.abs(fD.t - d.t);
        if (dt < refDt) { refDt = dt; ref = fD; }
      }
      if (ref && refDt <= NEAR && Math.abs(d.cxNorm - ref.cxNorm) > GUARD) out[i] = { t: d.t, cxNorm: null, guarded: true };
    }
    // Who we followed, so the studio can say so (and so a diagnostic can show
    // the runners-up and why they lost).
    out.signals = raw;
    out.referee = !opts.lock && typeof opts.referee === 'function' ? (raw.referee || null) : null;
    out.subject = pick ? {
      id: pick.chosen.id, why: pick.why, sig: packSig(pick.chosen.sig), drives: subjectDrives, blips: pick.track.blips || 0,
      frames: raw.reduce((n, f) => n + (f.subject ? 1 : 0), 0),
      people: pick.stats.map((st) => ({
        id: st.id, n: st.n, cover: st.cover, shots: st.shots, size: st.size,
        cx: st.cx, cxLo: st.cxLo, cxHi: st.cxHi, talk: st.talk, talkN: st.talkN,
        facing: st.facing, score: st.score, parts: st.parts, sig: packSig(st.sig), aiYes: st.aiYes, aiNo: st.aiNo,
      })),
    } : null;
    return out;
  }

  /**
   * Smooth + gap-fill detections into pan keyframes [{t, x, y}] in SOURCE px.
   *
   * CapCut-style "virtual camera operator":
   *   1. reject single-sample outliers (a face in the congregation, a false hit),
   *   2. gap-fill (hold the last known position through missed detections),
   *   3. zero-lag smoothing (forward+backward pass — no trailing behind the speaker),
   *   4. simulate a camera with a DEAD-ZONE and speed-limited eased glides: it sits
   *      perfectly still while the speaker only sways, and pans smoothly (ease-in /
   *      ease-out, capped speed) when they actually walk. That "locked, then glide"
   *      behaviour is what makes professional auto-reframe look calm instead of jittery.
   *   5. HARD SAFE-ZONE LEASH: knowing the real crop width for the target aspect
   *      ratio, the camera is never allowed to lag so far that the face leaves the
   *      central safe area of the crop — so the speaker CANNOT walk out of the 9:16
   *      frame even during a fast move or a brief detection gap. Smoothness is a
   *      preference; keeping the subject in frame is a guarantee.
   * Emits dense keyframes — the export side simplifies flat runs away (RDP).
   *
   * opts.targetAR = output width/height (e.g. 9/16) so the leash matches the export crop.
   */
  /**
   * Shot boundaries for the virtual camera: moments where the SOURCE picture
   * itself is discontinuous (multi-camera hard cut, operator whip pan) so the
   * crop must SNAP there instead of gliding — a glide across a cut is exactly
   * the "speaker drifts out of the 9:16 frame for seconds" bug.
   *
   * A scene event (from the cheap ffmpeg scene pass) only becomes a boundary if
   * the tracked subject actually DISPLACED across it (median position before vs
   * after) — gestures/lighting flickers score 0.1-0.2 too, and snapping the
   * camera mid-speech for no reason looks broken. A hard cut (score ≥ 0.3) into
   * a shot where nobody is detectable splits unconditionally so the new shot
   * gets a fresh (centred) camera. Finally, a per-sample teleport (> 0.28 of the
   * frame in one step, CONFIRMED by the neighbourhood medians) catches any cut
   * the scene pass missed — the median confirmation keeps single-frame false
   * detections from splitting (those are outliers, not cuts).
   */
  function shotBoundaries(dets, cuts, minJump) {
    const CUT_SCORE = 0.14, HARD = 0.30;
    const evs = (cuts || [])
      .filter((c) => c && c.t != null && (c.score == null || c.score >= CUT_SCORE))
      .map((c) => ({ t: c.t, score: c.score == null ? 1 : c.score })).sort((a, b) => a.t - b.t);
    // a whip pan emits a burst of events over ~0.5s — merge, keep the burst's END
    // (the camera has settled on the new framing there)
    const groups = [];
    for (const e of evs) {
      const g = groups[groups.length - 1];
      if (g && e.t - g.end <= 0.7) { g.end = e.t; g.score = Math.max(g.score, e.score); }
      else groups.push({ end: e.t, score: e.score });
    }
    const medNear = (t, dir) => {
      const xs = dets.filter((d) => d.cxNorm != null && (dir < 0 ? (d.t < t && d.t >= t - 1.8) : (d.t > t && d.t <= t + 1.8)))
        .map((d) => d.cxNorm).sort((a, b) => a - b);
      return xs.length ? xs[Math.floor(xs.length / 2)] : null;
    };
    const out = [];
    for (const g of groups) {
      const before = medNear(g.end, -1), after = medNear(g.end, +1);
      if (before != null && after != null
        ? Math.abs(after - before) > Math.max(0.5 * minJump, 0.04)
        : g.score >= HARD) out.push(g.end + 0.001);
    }
    let pv = null;
    for (const d of dets) {
      if (d.cxNorm == null) continue;
      if (pv && (d.t - pv.t) <= 1.2 && Math.abs(d.cxNorm - pv.cxNorm) > 0.28) {
        const mid = (d.t + pv.t) / 2;
        const b4 = medNear(mid, -1), af = medNear(mid, +1);
        if (b4 != null && af != null && Math.abs(af - b4) > 0.22 && !out.some((b) => Math.abs(b - mid) < 0.7)) out.push(mid);
      }
      pv = d;
    }
    return out.sort((a, b) => a - b);
  }

  /*
   * WHAT THE CAMERA IS ASKED TO WANT.
   *
   * Every one of these is in units of the OUTPUT frame, so they mean the same
   * thing on any source, any aspect ratio and any resolution. Exposed on the
   * public object so the bench can sweep them (test/reframe-lab.js) — they were
   * chosen by measuring, not by taste, and re-measuring is how they should be
   * changed.
   */
  const CAM = {
    KV: 0.20,     // cost of moving at all, per half-frame travelled
    KA: 0.45,     // cost of each change of speed, per half-frame/s of change
    MAXV: 0.9,    // fastest pan, half-frames per second
    GRID: 161,    // camera positions considered across the pannable range
    AMAX: 4,      // velocity steps the solver may change by in one sample
    HARD: 0.40,   // the subject is never further off centre than this (half-frames)
    EASE: 0.20,   // s of rounding that turns solved corners into eased starts and stops
  };

  function buildKeyframes(dets, srcW, srcH, opts) {
    if (!dets.length) return [{ t: 0, x: Math.round(srcW / 2), y: Math.round(srcH / 2) }];
    const targetAR = (opts && opts.targetAR) || (9 / 16);
    const srcAR = srcW / srcH;
    // Half of the crop window, as a fraction of the source frame, for each axis.
    // (When an axis isn't cropped, its half-extent is 0.5 = no constraint.)
    const cropHalfX = srcAR > targetAR ? 0.5 * (targetAR / srcAR) : 0.5;
    const cropHalfY = srcAR < targetAR ? 0.5 * (srcAR / targetAR) : 0.5;
    // The face must stay within the central SAFE fraction of the crop — this is
    // the hard worst-case bound on how far off-centre the speaker can ever be.
    // Swept against real sermon footage: 0.50 left visible off-centre stretches
    // during walks; 0.44 cut them out AND made the camera calmer (fewer
    // direction changes — a looser leash yanks less often). Below ~0.36 the
    // leash starts binding on natural ±5% rocking and the camera chases body
    // language, which is the failure mode this whole pipeline exists to avoid.
    const SAFE = 0.44;
    const leashX = SAFE * cropHalfX, leashY = SAFE * cropHalfY;

    /*
     * WAS THE CAMERA OPERATOR ALREADY DOING THIS JOB?
     *
     * On a locked-off shot of a preacher at a lectern — or any recording where
     * somebody behind the camera is keeping the speaker in the middle — a plain
     * centre crop is already right, and tracking has nothing to add. That is
     * worth SAYING, because an operator who has noticed it should be told they
     * can leave auto-reframe off rather than left wondering whether it is doing
     * anything.
     *
     * Deliberately only a note. Overriding the camera here was tried and is
     * wrong: the tracker parks a hold on the subject's own median position, so
     * on this footage it already sits within a couple of percent of centre —
     * and where it differs it is the tracker that is right, because it corrects
     * a small persistent offset that a fixed centre crop would keep forever.
     */
    let alreadyCentred = false;
    {
      const seen = dets.filter((d) => d.cxNorm != null);
      if (seen.length >= 12 && seen.length >= 0.6 * dets.length) {
        const off = seen.map((d) => Math.abs(d.cxNorm - 0.5)).sort((x, y) => x - y);
        const p95 = off[Math.min(off.length - 1, Math.floor(off.length * 0.95))];
        alreadyCentred = p95 <= leashX;
      }
    }

    // 0. Split the clip into SHOTS at camera cuts / whip pans, run the virtual
    //    camera independently per shot, and SNAP between them (a jump at a cut
    //    is invisible — the picture is already discontinuous there). Smoothing
    //    or gliding ACROSS a cut is what used to leave the speaker off-frame.
    const boundaries = shotBoundaries(dets, opts && opts.cuts, leashX);
    if (boundaries.length) {
      const camPath = [];
      let prevEnd = null;
      let lo = 0;
      const bounds = boundaries.concat([Infinity]);
      for (const b of bounds) {
        let hi = lo;
        while (hi < dets.length && dets[hi].t < b) hi++;
        const slice = dets.slice(lo, hi);
        lo = hi;
        if (!slice.length) continue;
        const hasDet = slice.some((d) => d.cxNorm != null);
        let segPath;
        if (!hasDet) {
          // nobody detectable in this shot (crowd cutaway / wide b-roll): hold
          // briefly through a blip, otherwise frame the CENTRE of the new shot
          const segDur = slice[slice.length - 1].t - slice[0].t;
          const cx = prevEnd && segDur < 2.5 ? prevEnd.cx : 0.5;
          const cy = prevEnd && segDur < 2.5 ? prevEnd.cy : 0.5;
          segPath = slice.map((d) => ({ t: d.t, cx, cy }));
        } else {
          segPath = camForSlice(slice, leashX, leashY, cropHalfX, cropHalfY);
        }
        if (prevEnd && segPath.length) {
          // snap: hold the old framing until just before the boundary, then be
          // AT the new shot's framing right away (ffmpeg lerps over ~20ms)
          const bt = segPath[0].t;
          camPath.push({ t: Math.max(0, bt - 0.02), cx: prevEnd.cx, cy: prevEnd.cy });
        }
        camPath.push(...segPath);
        if (segPath.length) prevEnd = { cx: segPath[segPath.length - 1].cx, cy: segPath[segPath.length - 1].cy };
      }
      const kf = camPath.map((p) => ({ t: Math.max(0, p.t), x: Math.round(Math.min(1, Math.max(0, p.cx)) * srcW), y: Math.round(Math.min(1, Math.max(0, p.cy)) * srcH) }));
      if (!kf.length || kf[0].t > 0.05) kf.unshift({ t: 0, x: kf.length ? kf[0].x : Math.round(srcW / 2), y: kf.length ? kf[0].y : Math.round(srcH / 2) });
      kf.alreadyCentred = alreadyCentred;
      return kf;
    }
    const kf1 = singleShotKeyframes(dets, srcW, srcH, leashX, leashY, cropHalfX, cropHalfY);
    kf1.alreadyCentred = alreadyCentred;
    return kf1;
  }

  function singleShotKeyframes(dets, srcW, srcH, leashX, leashY, halfX, halfY) {
    const camPath = camForSlice(dets, leashX, leashY, halfX, halfY);
    const kf = camPath.map((p) => ({ t: Math.max(0, p.t), x: Math.round(Math.min(1, Math.max(0, p.cx)) * srcW), y: Math.round(Math.min(1, Math.max(0, p.cy)) * srcH) }));
    if (!kf.length || kf[0].t > 0.05) kf.unshift({ t: 0, x: kf.length ? kf[0].x : Math.round(srcW / 2), y: kf.length ? kf[0].y : Math.round(srcH / 2) });
    return kf;
  }

  /** The per-shot virtual camera (steps 1-4) over one contiguous run of samples. */
  function camForSlice(dets, leashX, leashY, halfX, halfY) {
    // 1. Outlier rejection — ONLY isolated spikes, never a real fast move. A point
    //    is a false positive only if it jumps away from BOTH its nearest valid
    //    neighbours AND those neighbours agree with each other (an up-then-down
    //    blip). A genuine pan is a ramp (neighbours differ) or a step (next agrees
    //    with the point), so it survives — otherwise a quick walk gets eaten and
    //    the speaker drifts out of frame.
    const nearest = (from, dir) => {
      for (let j = from + dir; j >= 0 && j < dets.length; j += dir) if (dets[j].cxNorm != null) return dets[j];
      return null;
    };
    const TH = 0.16;
    const pruned = dets.map((d, i) => {
      if (d.cxNorm == null) return d;
      const prev = nearest(i, -1), next = nearest(i, +1);
      if (prev && next && prev.cxNorm != null && next.cxNorm != null) {
        const spike = Math.abs(d.cxNorm - prev.cxNorm) > TH && Math.abs(d.cxNorm - next.cxNorm) > TH && Math.abs(prev.cxNorm - next.cxNorm) < TH * 0.6;
        if (spike) return { t: d.t, cxNorm: null };
      }
      return d;
    });

    // 1b. SHORT EXCURSIONS, POSE-VERIFIED: a face-like pattern (wallpaper,
    //     someone in the crowd) can win the track for 2-3 consecutive frames
    //     before the real face returns — an A→B→A blip that yanks the camera
    //     sideways and back ("camera goes wild"). But a REAL quick move by the
    //     speaker looks identical geometrically and MUST be followed (ignoring
    //     one left him out of frame — measured). The body is the tie-breaker:
    //     bodies don't teleport. Null a short excursion ONLY when every sample
    //     in it has a pose (body) position that CONTRADICTS the jumped face —
    //     the body stayed home, so the "face" was a phantom. No pose data / body
    //     agrees → keep the run (the leash will catch the camera to it).
    {
      const v = [];
      for (let i = 0; i < pruned.length; i++) if (pruned[i].cxNorm != null) v.push(i);
      for (let k = 0; k + 2 < v.length; k++) {
        const base = pruned[v[k]].cxNorm;
        for (let L = 1; L <= 3 && k + L + 1 < v.length; L++) {
          const back = pruned[v[k + L + 1]];
          if (back.t - pruned[v[k]].t > 2.2) break;
          let away = true, phantom = true;
          for (let j = 1; j <= L; j++) {
            const s = pruned[v[k + j]];
            if (Math.abs(s.cxNorm - base) <= 0.14) { away = false; break; }
            if (!(s.poseCx != null && Math.abs(s.poseCx - s.cxNorm) > 0.18)) phantom = false;
          }
          if (!away) break;
          if (phantom && Math.abs(back.cxNorm - base) <= 0.09) {
            for (let j = 1; j <= L; j++) pruned[v[k + j]] = { t: pruned[v[k + j]].t, cxNorm: null };
            k += L;
            break;
          }
        }
      }
    }

    // 2. Gap-fill: INTERPOLATE across short detection dropouts (the speaker was
    //    probably still moving), and only HOLD the last position through long gaps
    //    or the head/tail. This is what stops the "walked out while the detector
    //    blinked" case — a frozen camera during a gap is exactly when the subject
    //    slips out of frame.
    const firstKnown = pruned.find((d) => d.cxNorm != null);
    const fkx = firstKnown ? firstKnown.cxNorm : 0.5;
    const fky = firstKnown && firstKnown.cyNorm != null ? firstKnown.cyNorm : 0.5;
    const cyOf = (d) => (d.cyNorm != null ? d.cyNorm : 0.5);
    // nearest known index on each side
    const prevK = new Array(pruned.length).fill(-1);
    const nextK = new Array(pruned.length).fill(-1);
    for (let i = 0, last = -1; i < pruned.length; i++) { prevK[i] = last; if (pruned[i].cxNorm != null) last = i; }
    for (let i = pruned.length - 1, next = -1; i >= 0; i--) { nextK[i] = next; if (pruned[i].cxNorm != null) next = i; }
    const MAX_INTERP_GAP = 1.5; // s — interpolate through gaps shorter than this
    const filled = pruned.map((d, i) => {
      if (d.cxNorm != null) return { t: d.t, cx: d.cxNorm, cy: cyOf(d) };
      const p = prevK[i], n = nextK[i];
      if (p >= 0 && n >= 0 && (pruned[n].t - pruned[p].t) <= MAX_INTERP_GAP) {
        const r = (d.t - pruned[p].t) / Math.max(1e-3, pruned[n].t - pruned[p].t);
        return { t: d.t, cx: pruned[p].cxNorm + (pruned[n].cxNorm - pruned[p].cxNorm) * r, cy: cyOf(pruned[p]) + (cyOf(pruned[n]) - cyOf(pruned[p])) * r };
      }
      if (p >= 0) return { t: d.t, cx: pruned[p].cxNorm, cy: cyOf(pruned[p]) };
      if (n >= 0) return { t: d.t, cx: pruned[n].cxNorm, cy: cyOf(pruned[n]) };
      return { t: d.t, cx: fkx, cy: fky };
    });

    // 3. How much each sample is worth having the camera obey. A real sighting
    //    is the truth; a position interpolated across a short dropout is very
    //    nearly it; a position HELD through a long blind stretch is a guess, and
    //    a guess must not be allowed to aim the camera — that is how the crop
    //    ends up parked on an empty backdrop while the speaker walks away. It
    //    gets no vote at all, and the stillness term below holds the framing.
    const weight = pruned.map((d, i) => {
      if (d.cxNorm != null) return 1;
      const p = prevK[i], n = nextK[i];
      if (p >= 0 && n >= 0 && (pruned[n].t - pruned[p].t) <= MAX_INTERP_GAP) return 0.6;
      // A long blind stretch is not a licence to wander either. The held
      // position gets a weak vote — enough that "stay where he was last seen"
      // beats drifting off through a stretch where nothing is known, and far
      // too little to aim the camera against a real sighting. The hard framing
      // bound is NOT applied here (that is the part that used to park the crop
      // on an empty stage while the speaker walked away).
      return 0.15;
    });

    /*
     * 4. THE CAMERA OPERATOR, SOLVED RATHER THAN SIMULATED.
     *
     * What used to be here was a controller: a dead-band, a proportional
     * pursuit with feed-forward, asymmetric damping, and a hard leash that
     * CLAMPED the camera whenever the speaker got too far away. Every one of
     * those parts is a guess about the future made without looking at it, and
     * the guesses fought each other — the dead-band is what lets the camera
     * settle somewhere the speaker is not, and the clamp (a jump to the bound,
     * not a nudge) is what makes correcting that look violent. Tightening one
     * loosened the other, which is why the shipped tuning left the speaker up
     * to a third of the frame off centre with his arm cut off.
     *
     * This is an offline export. The whole clip is already known, so the camera
     * path does not have to be guessed at all — it can be SOLVED. Over the
     * whole shot, find the path that minimises
     *
     *     ∫ w(t)·offCentre(t)²      how badly framed the subject is
     *   + KV·∫ |speed(t)|           how much the camera moves at all
     *   + KA·Σ |change of speed|    how often it starts, stops or turns
     *
     * with the subject's distance from the middle bounded outright. All three
     * are in units of the OUTPUT half-frame, so the same constants hold for any
     * source and any aspect ratio.
     *
     * The two motion terms are absolute values, not squares, and that is the
     * whole trick. An L1 penalty on speed makes ZERO speed genuinely optimal
     * rather than merely cheap, so the answer contains real locked-off holds
     * instead of perpetual creeping; an L1 penalty on the CHANGE of speed makes
     * constant-velocity pans optimal, so a move is one clean glide rather than
     * a series of corrections. Hold, glide, hold — which is what a good
     * operator's hands do — falls out of the maths instead of being simulated
     * by a state machine that has to decide which mode it is in.
     *
     * Solved exactly by dynamic programming over (position, velocity): both are
     * on a grid, so the next position is fully determined by the velocity, and
     * a shot's optimum is found in one forward sweep. No local minima, no
     * tuning race between competing rules — and the framing bound is a
     * constraint the solver simply never violates rather than a correction
     * applied after the fact.
     */
    const { KV, KA, MAXV, GRID, AMAX, HARD, EASE } = CAM;

    /**
     * The best camera path for one axis, in source fractions.
     * `pos[i]` is where the subject is, `w[i]` how much that is to be believed.
     */
    const solveAxis = (pos, w, half) => {
      const n = pos.length;
      if (half >= 0.4999) return pos.map(() => 0.5);     // this axis isn't cropped at all
      const lo = half, hi = 1 - half;
      const step = (hi - lo) / (GRID - 1);
      if (!(step > 0)) return pos.map(() => 0.5);
      let dt = 1 / 6;
      if (n > 1) { const ds = []; for (let i = 1; i < n; i++) ds.push(dets[i].t - dets[i - 1].t); ds.sort((a, b) => a - b); dt = Math.max(1e-3, ds[ds.length >> 1]); }
      // velocity in grid steps per sample
      const vMax = Math.max(1, Math.min(60, Math.round(MAXV * half * dt / step)));
      const vN = 2 * vMax + 1;
      const S = GRID * vN;
      const perStep = step / (half * dt);                // one grid step per sample, in half-frames/s
      const BIG = 1e7;
      let cur = new Float64Array(S).fill(Infinity);
      const back = new Uint8Array(n * S);
      // opening state: any position, standing still (a shot starts with the
      // camera already placed — it did not glide in from the last one)
      for (let p = 0; p < GRID; p++) cur[p * vN + vMax] = 0;
      // A whisper of a preference for the middle of the picture. It is far too
      // small to pull the camera off the subject, and it decides the one case
      // that would otherwise be a coin toss: a shot with nobody in it at all,
      // where every camera position costs the same and the solver would
      // otherwise return whichever the loop happened to visit first (the far
      // left edge). Nobody in shot means centre the frame.
      const NUDGE = 1e-4;
      const costAt = (i, p) => {
        const c = lo + p * step;
        const mid = NUDGE * (c - 0.5) * (c - 0.5);
        if (!w[i]) return mid;
        const u = (pos[i] - c) / half;
        // The framing GUARANTEE only binds where the position is a sighting, not
        // a guess. Enforcing it against a stale held position is precisely how
        // the old camera came to sit on an empty backdrop: it was obeying, to
        // the pixel, a position the speaker had left seconds earlier.
        const over = w[i] >= 0.6 ? Math.abs(u) - HARD : -1;
        return mid + w[i] * u * u * dt + (over > 0 ? BIG * over * over : 0);
      };
      for (let p = 0; p < GRID; p++) { const c = cur[p * vN + vMax]; if (c < Infinity) cur[p * vN + vMax] = c + costAt(0, p); }
      for (let i = 1; i < n; i++) {
        const nxt = new Float64Array(S).fill(Infinity);
        const bo = i * S;
        for (let p = 0; p < GRID; p++) {
          for (let vi = 0; vi < vN; vi++) {
            const c = cur[p * vN + vi];
            if (c === Infinity) continue;
            const v = vi - vMax;
            for (let a = -AMAX; a <= AMAX; a++) {
              const v2 = v + a;
              if (v2 < -vMax || v2 > vMax) continue;
              const p2 = p + v2;
              if (p2 < 0 || p2 >= GRID) continue;
              const move = KV * Math.abs(v2) * step / half        // travelled distance, half-frames
                + KA * Math.abs(a) * perStep;                     // change of speed, half-frames/s
              const cost = c + move;
              const k = p2 * vN + (v2 + vMax);
              if (cost < nxt[k]) { nxt[k] = cost; back[bo + k] = a + AMAX; }
            }
          }
        }
        for (let p = 0; p < GRID; p++) { const d = costAt(i, p); if (d) { const base = p * vN; for (let vi = 0; vi < vN; vi++) if (nxt[base + vi] < Infinity) nxt[base + vi] += d; } }
        cur = nxt;
      }
      let bk = 0, bc = Infinity;
      for (let k = 0; k < S; k++) if (cur[k] < bc) { bc = cur[k]; bk = k; }
      const out = new Array(n);
      let k = bk;
      for (let i = n - 1; i >= 0; i--) {
        const p = (k / vN) | 0, vi = k % vN;
        out[i] = lo + p * step;
        if (i > 0) { const a = back[i * S + k] - AMAX; const v2 = vi - vMax; k = (p - v2) * vN + (v2 - a + vMax); }
      }
      return out;
    };

    /*
     * The solved path starts and stops instantly, because a straight line is
     * the cheapest way to get anywhere under an L1 penalty. Real operators lead
     * into a move and settle out of it, so the corners are rounded with a short
     * Gaussian — which also erases the one-grid-step staircase a very slow drift
     * would otherwise be quantised into. The framing bound is re-applied
     * afterwards, so the rounding can never push the subject out of the safe
     * area it was solved to stay inside.
     */
    const easePath = (path, pos, w, half) => {
      const n = path.length;
      if (n < 3 || half >= 0.4999) return path;
      let dt = 1 / 6;
      if (n > 1) { const ds = []; for (let i = 1; i < n; i++) ds.push(dets[i].t - dets[i - 1].t); ds.sort((a, b) => a - b); dt = Math.max(1e-3, ds[ds.length >> 1]); }
      const sig = Math.max(1, EASE / dt);
      const r = Math.max(1, Math.round(2 * sig));
      const ker = [];
      for (let d = -r; d <= r; d++) ker.push(Math.exp(-(d * d) / (2 * sig * sig)));
      const sum = ker.reduce((a, b) => a + b, 0);
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let d = -r; d <= r; d++) s += ker[d + r] * path[Math.min(n - 1, Math.max(0, i + d))];
        out[i] = s / sum;
        if (w[i] >= 0.6) {   // never let the rounding cost us the framing the solver won
          const bound = HARD * half;
          if (out[i] < pos[i] - bound) out[i] = pos[i] - bound;
          else if (out[i] > pos[i] + bound) out[i] = pos[i] + bound;
        }
      }
      return out;
    };

    const posX = filled.map((f) => f.cx), posY = filled.map((f) => f.cy);
    const camXs = easePath(solveAxis(posX, weight, halfX), posX, weight, halfX);
    const camYs = easePath(solveAxis(posY, weight, halfY), posY, weight, halfY);
    const camPath = filled.map((f, i) => ({ t: f.t, cx: camXs[i], cy: camYs[i] }));
    // dense path — the exporter's RDP pass collapses the still sections
    return camPath;
  }

  // Detect the speaker in a LIVE element (the <video> or a canvas frame) — used
  // for the real-time reframe preview. FACE IS ALWAYS PREFERRED WHEN PRESENT —
  // pose only refines it when they closely agree (body-stabilised head
  // position), and only takes over outright when face is totally absent.
  //
  // An earlier version of this let pose OVERRIDE a disagreeing face reading
  // whenever pose was "closer to the current tracked position" (mirroring the
  // offline export's fusion). That was wrong for a live, single-pass tracker:
  // measured on this exact video, the pose landmarker has its own ~2s stretch
  // where it drifts smoothly off-target (0.68 -> -0.02, a coherent but WRONG
  // trajectory) while face recovers on its own within a few hundred ms. Because
  // "closer to the tracked position" is judged against the tracker's OWN prior
  // output, once pose won one tie-break the track drifted toward pose, making
  // pose look even MORE like "the continuing track" next tick — a feedback
  // loop with no correction, riding the drift the whole way to off-frame
  // instead of the few-hundred-ms blip a lone bad face reading would have
  // caused on its own. The offline pipeline avoids this via multi-frame
  // look-ahead + a persistence-gated rolling baseline that a live, one-frame-
  // at-a-time tracker structurally cannot do. Preferring face (the more direct
  // signal for "where is the face") whenever it exists sidesteps the loop
  // entirely, at the cost of occasionally not catching a brief lone face
  // phantom — a strictly smaller failure than the pose spiral it replaces.
  // opts.nearX/nearY = the position the live preview is CURRENTLY tracking
  // (ve.liveFaceCx/Cy). With >1 face in frame (a second person, an
  // interpreter, a screen), picking "the biggest box" independently every
  // tick makes the raw reading flip-flop between them frame to frame — on
  // real church footage this produced a hard alternation between two
  // clusters ~0.5 apart, which no amount of downstream smoothing can turn
  // into a calm pan (the offline exporter's detectFrames PASS B hits the
  // same ambiguity and solves it the same way: stick to whichever candidate
  // continues the existing track, only ceding to a different one when it's
  // DECISIVELY bigger, so near-tie box-size jitter can't whip the camera).
  // Live-preview arbitration state: recent body positions (for the stability
  // test below) and how many consecutive ticks the face has contradicted a
  // STEADY body.
  let poseHist = [], disagreeTicks = 0;
  // What the live preview has learned the followed person looks like (see
  // detectElement). Cleared by resetLive() with everything else.
  const liveMem = { anchor: null, adapt: [] };
  const POSE_WIN_MS = 1500;   // how far back the stability test looks
  // Body movement across that window that still counts as "not drifting". Sized
  // off the failure it must exclude, not off stillness: the pose landmarker's
  // drift runs ~0.35 of the frame per second (~0.5 over this window), while a
  // preacher walking the stage moves the BODY CENTRE only ~0.05 in the same
  // window. 0.12 sits an order of magnitude clear of the drift and still lets
  // the rule protect a speaker who is pacing — which is when phantom face
  // readings were doing the most damage.
  const POSE_STEADY = 0.12;
  const DISAGREE = 0.15;      // face-vs-body gap that counts as a contradiction
  /** Forget the live arbitration state (new video / new test window). */
  function resetLive() { poseHist = []; disagreeTicks = 0; liveMem.anchor = null; liveMem.adapt.length = 0; }
  /**
   * THE PREVIEW TOLD WHO TO FOLLOW. The live tracker starts on whoever is
   * biggest and then remembers their look — so when the biggest person in the
   * opening frame is a congregant walking past the lens, the preview follows
   * them and refuses to let go. When the referee has said who is preaching (the
   * studio asks it as a short starts playing), that person's look replaces the
   * memory, and the arbitration in detectElement — "somebody who plainly IS him
   * outranks proximity" — moves the preview to him on the next tick, gliding.
   */
  function seedLive(sig) {
    const s0 = sig && (sig.head instanceof Float32Array || sig.up instanceof Float32Array) ? sig : unpackSig(sig);
    if (!s0) return false;
    liveMem.anchor = s0; liveMem.adapt.length = 0;
    return true;
  }

  async function detectElement(el, opts) {
    opts = opts || {};
    const nearX = opts.nearX, nearY = opts.nearY;
    let det; try { det = await init(); } catch (e) { return null; }
    const w = el.videoWidth || el.naturalWidth || el.width || 1;
    const h = el.videoHeight || el.naturalHeight || el.height || 1;
    let r; try { r = det.detect(el); } catch (e) { r = { detections: [] }; }
    const cands = ((r && r.detections) || []).map((d) => {
      const b = d.boundingBox;
      return {
        area: b.width * b.height, wNorm: b.width / w, hNorm: b.height / h,
        cx: (b.originX + b.width / 2) / w, cy: (b.originY + b.height / 2) / h,
      };
    });
    // The body signal is needed BEFORE choosing a candidate (see the sustained-
    // disagreement arbitration below), so detect pose first.
    let pose = null, poses = [];
    if (poser) {
      let pr; try { pr = poser.detect(el); } catch (e) { pr = null; }
      poses = poseHeads(pr);
      pose = poses.length ? poses[0] : null;
    }
    // THE USER'S PICK OUTRANKS EVERY HEURISTIC BELOW. When they have pointed at
    // somebody, the only question each tick is "which of these people is them",
    // answered on appearance — so the preview shows the same person the export
    // will follow, instead of the two disagreeing about who the speaker is.
    if (opts.lock) {
      const lock = (opts.lock.head instanceof Float32Array || opts.lock.up instanceof Float32Array) ? opts.lock : unpackSig(opts.lock);
      const px = lock ? framePixels(el) : null;
      if (px) {
        const people = buildPeople(cands, poses);
        let hit = null, hitSim = LOCK_MIN;
        for (const pp of people) {
          const sim = sigSim(personSig(px, pp.cx, pp.cy, pp.bw, pp.bh), lock);
          if (sim > hitSim) { hitSim = sim; hit = pp; }
        }
        if (hit) {
          const hp = hit.pose;
          // their own body, when we can see it, still steadies the reading —
          // the head swings ±10% on every gesture and the feet never move
          if (hp && Math.abs(hit.cx - hp.cx) <= 0.18) return { cxNorm: 0.6 * hp.cx + 0.4 * hit.cx, cyNorm: hit.cy, poseCx: hp.cx, poseCy: hp.cy, locked: true };
          return { cxNorm: hit.cx, cyNorm: hit.cy, poseCx: hp ? hp.cx : null, poseCy: hp ? hp.cy : null, locked: true };
        }
      }
    }

    /*
     * WHO IS EVEN A CANDIDATE: A BODY BEATS A FACE BOX.
     *
     * The face detector reports the backdrop wordmark on this church's stream as
     * three or four confident "faces" a fifth of the frame wide, in every single
     * tick — so a chooser that ranks bare face boxes is choosing between the
     * speaker and the wall on their merits, and the wall often wins on size.
     * The offline exporter was fixed the same way and for the same reason: a
     * pattern on a wall has no body, so where the pose model has found ANY body,
     * only people it found are eligible. Where it has found none (it does blink)
     * the old face-only list is used exactly as before.
     *
     * This runs BEFORE the sticky/biggest arbitration below rather than as
     * another override after it, which is what makes it calm: a candidate that
     * was never eligible cannot pull the track and then be corrected.
     */
    const people = buildPeople(cands, poses);
    const bodied = people.filter((p) => p.pose);
    const pool = (bodied.length ? bodied : people).map((p) => ({
      cx: p.cx, cy: p.cy, area: p.area, wNorm: p.bw, bh: p.bh, pose: p.pose,
    }));

    /*
     * THE PREVIEW REMEMBERS WHO IT IS FOLLOWING.
     *
     * Position alone cannot hold a track across a platform with two people on
     * it. Each tick the nearest candidate is a small step away, so a chain of
     * perfectly reasonable small steps walks the crop from one man to the other
     * — measured on Bible Study at t=9332, the preview left the preacher at
     * 0.79 and arrived at his neighbour at 0.41 over three ticks, and stayed
     * there for five seconds, while the export (which HAS an identity layer)
     * stayed on the preacher throughout. That is the preview showing one thing
     * and the export producing another, which makes the preview worthless
     * however smooth it is.
     *
     * So the preview keeps the same appearance memory the exporter's tracker
     * does, in miniature: an anchor look from when the track was established,
     * plus a few recent ones so it survives a turn or a change of light. It is
     * only ever used to REFUSE a change of person — a candidate further from
     * the track than a head's width has to look MORE like the followed person
     * than the near one does, by a clear margin, before it can take the crop.
     * Nothing about the memory can move the camera on its own, so it cannot
     * introduce drift of its own; the worst it can do is decline to follow,
     * which the caller already handles by holding still.
     */
    // Read the pixels whenever there is anybody at all — a frame with one
    // candidate is exactly when the memory should be LEARNING, and skipping it
    // as "unambiguous" left the memory permanently empty. One 320px readback
    // per tick, four or five times a second.
    const px = pool.length ? framePixels(el) : null;
    if (px) for (const c of pool) c.sig = personSig(px, c.cx, c.cy, c.wNorm, c.bh || c.wNorm * 1.25);
    const known = (c) => (c.sig ? Math.max(liveMem.anchor ? sigSim(liveMem.anchor, c.sig) : 0, simMax(liveMem.adapt, c.sig)) : 0);

    let best = null, refused = false;
    if (pool.length) {
      const biggest = (arr) => arr.reduce((a, c) => (c.area > a.area ? c : a), arr[0]);
      if (nearX == null) best = biggest(pool); // no track yet: nothing to be sticky against
      else {
        const LEASH_DIST = 0.22; // matches detectFrames' PASS B sticky radius
        const dist = (c) => Math.hypot(c.cx - nearX, c.cy - (nearY == null ? c.cy : nearY));
        const near = pool.filter((c) => dist(c) <= LEASH_DIST);
        if (near.length) {
          const cont = near.reduce((a, c) => (dist(c) < dist(a) ? c : a), near[0]);
          const big = biggest(near);
          best = (big !== cont && big.area >= 1.6 * cont.area) ? big : cont;
          // ...unless somebody else in reach is recognisably the person we have
          // been following and this one is not.
          if (liveMem.anchor) {
            const rival = near.reduce((a, c) => (known(c) > known(a) ? c : a), near[0]);
            if (rival !== best && known(rival) - known(best) >= MARGIN && dist(best) > 0.06) best = rival;
          }
        } else best = biggest(pool); // nothing near the track: a real relocation/re-acquire
        // AND THE PERSON WE ARE ACTUALLY FOLLOWING, WHEREVER THEY ARE. Once the
        // track has slipped onto a phantom, the real speaker is by definition
        // "far" and stops being considered at all — which is how a slip becomes
        // permanent. Somebody who plainly IS him outranks proximity.
        if (liveMem.anchor) {
          const him = pool.reduce((a, c) => (known(c) > known(a) ? c : a), pool[0]);
          if (him !== best && known(him) >= ACCEPT && known(him) - known(best) >= MARGIN) best = him;
        }
        // A stranger far from the track does not get the crop at all. With no
        // memory this is the old behaviour (the caller's own jump filter waits
        // for confirmation); with one, an unrecognisable candidate is refused
        // outright and the preview holds the framing it had.
        if (best && liveMem.anchor && best.sig && dist(best) > LEASH_DIST && known(best) < ACCEPT_NEAR) { best = null; refused = true; }
      }
      // Follow the body we chose, not whichever body the model ranked first —
      // on a platform with several people those are different men.
      if (best && best.pose) pose = best.pose;
      // Learn only from a confident, continuing sighting, so a stranger who
      // wins one tick can never teach the preview to prefer them.
      if (best && best.sig) {
        if (!liveMem.anchor) liveMem.anchor = best.sig;
        else if (known(best) >= ADAPT_MIN && nearX != null && Math.abs(best.cx - nearX) <= 0.12) {
          liveMem.adapt.push(best.sig);
          if (liveMem.adapt.length > 8) liveMem.adapt.shift();
        }
      }
    }

    // A STEADY BODY OVERRULES A CONTRADICTING FACE.
    //
    // Preferring face unconditionally (above) is right for a *transient* conflict,
    // but it has no answer for a stage backdrop: printed scripture art and Bible
    // photos detect as faces on EVERY tick, so where the speaker's own face is
    // small and dim the only "faces" in the picture are wallpaper and the preview
    // parks on them — measured on a real sermon, the live crop sat off the speaker
    // for 9.1s straight (47% of a 30s window) with a face "found" in all 135 ticks,
    // and separately got dragged onto a mural by a reading that sat just inside
    // the caller's 0.2 relocation threshold, so its pose veto never applied.
    //
    // Telling that apart from the pose landmarker's own known failure — a ~2s
    // COHERENT DRIFT off the subject — is what makes this safe, and the giveaway
    // is which signal is MOVING. A drifting body sweeps across the frame; a body
    // standing at a pulpit while the "face" sits on scenery does not. So the body
    // only overrules the face while the body itself has held still, which a drift
    // by definition cannot do. Note this never asks "which signal is closer to
    // where I'm already looking" — that track-relative question is precisely what
    // fed the old drift spiral. This test reads only the two signals' own recent
    // behaviour, so it cannot compound, and it releases the instant a face agrees
    // with the body again.
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (pose) poseHist.push({ t: now, cx: pose.cx });
    while (poseHist.length && now - poseHist[0].t > POSE_WIN_MS) poseHist.shift();
    const steadyBody = !!pose && poseHist.length >= 3
      && (Math.max(...poseHist.map((p) => p.cx)) - Math.min(...poseHist.map((p) => p.cx))) <= POSE_STEADY;
    if (steadyBody && best && Math.abs(best.cx - pose.cx) > DISAGREE) disagreeTicks++;
    else disagreeTicks = 0;
    if (steadyBody && disagreeTicks >= 2) { // 2 ticks (~0.4s) so one bad pose frame can't flip it
      // Keep only candidates the body corroborates, and reject any box far too
      // big to be this person's head (backdrop art is printed at wall scale, so
      // the ratio to shoulder span catches it and stays scale-invariant).
      const okCands = pool.filter((c) => Math.abs(c.cx - pose.cx) <= DISAGREE
        && (pose.headW == null || c.wNorm == null || c.wNorm <= 2.6 * pose.headW));
      best = okCands.length
        ? okCands.reduce((a, c) => (Math.abs(c.cx - pose.cx) < Math.abs(a.cx - pose.cx) ? c : a), okCands[0])
        : null; // only wallpaper is visible — follow the body alone
    }
    // poseCx/poseCy ride along on every return (null when the pose tracker has
    // nothing): the live tracker uses them as a RELOCATION VETO — "bodies don't
    // teleport" (same insight as detectFrames' fusion guard). When a far-away
    // face candidate appears while the pose still sees a body at the tracked
    // position, the speaker cannot actually have moved, so the candidate is a
    // phantom/second person and must not steal the crop. Pose is never used to
    // OVERRIDE a present face reading here (see the drift-spiral note above) —
    // it only vetoes relocations, which is immune to that feedback loop.
    const poseCx = pose ? pose.cx : null, poseCy = pose ? pose.cy : null;
    // opts.debug: what the tick was choosing between, and how much each
    // candidate looked like the person being followed (test/diag-live-decide.js).
    const dbg = opts.debug ? { pool: pool.map((c) => ({ cx: c.cx, w: c.wNorm, body: !!c.pose, sim: known(c) })), anchored: !!liveMem.anchor } : undefined;
    if (best) {
      if (pose && Math.abs(best.cx - pose.cx) <= 0.18) return { cxNorm: 0.6 * pose.cx + 0.4 * best.cx, cyNorm: best.cy, poseCx, poseCy, dbg };
      return { cxNorm: best.cx, cyNorm: best.cy, poseCx, poseCy, dbg };
    }
    // We looked at who was there and decided none of them was him: hold. The
    // pose fallback below must not quietly hand back the very candidate that
    // was just refused — `pose` is whichever body the model ranked first, which
    // on this footage is regularly the one printed on the wall.
    if (refused) return opts.debug ? { cxNorm: null, cyNorm: null, poseCx, poseCy, dbg, none: true } : null;
    if (pose && (nearX == null || Math.abs(pose.cx - nearX) <= 0.22)) return { cxNorm: pose.cx, cyNorm: pose.cy, poseCx, poseCy, dbg };
    return opts.debug ? { cxNorm: null, cyNorm: null, poseCx, poseCy, dbg, none: true } : null;
  }

  /**
   * Everybody visible in one picture, with a cut-out of each so the studio can
   * show them and let the user point at the one to follow. `el` is anything
   * drawable — the preview <video>, a canvas, an <img> of an extracted frame.
   *
   * The signature travelling back with each person IS the lock: pass it as
   * `opts.lock` to detectFrames/detectElement and the tracker follows that
   * person and nobody else.
   */
  async function detectPeople(el, opts) {
    opts = opts || {};
    let det; try { det = await init(); } catch (e) { return []; }
    const w = el.videoWidth || el.naturalWidth || el.width || 1;
    const h = el.videoHeight || el.naturalHeight || el.height || 1;
    let r; try { r = det.detect(el); } catch (e) { r = { detections: [] }; }
    const cands = ((r && r.detections) || []).map((d) => {
      const b = d.boundingBox;
      return {
        area: b.width * b.height, wNorm: b.width / w, hNorm: b.height / h,
        cx: (b.originX + b.width / 2) / w, cy: (b.originY + b.height / 2) / h,
        score: d.categories && d.categories[0] ? d.categories[0].score : 0,
      };
    });
    let poses = [];
    if (poser) { let pr; try { pr = poser.detect(el); } catch (e) { pr = null; } poses = poseHeads(pr); }
    const people = buildPeople(cands, poses);
    // Same second look the export gets: the speaker under a mitre is exactly the
    // person the picker must offer, and at whole-frame scale he is the one most
    // likely to be missed.
    refinePoseOnly(el, people, det);
    const px = framePixels(el);
    const out = [];
    for (const p of people) {
      const sig = px ? personSig(px, p.cx, p.cy, p.bw, p.bh) : null;
      out.push({
        cx: p.cx, cy: p.cy, bw: p.bw, bh: p.bh, src: p.src,
        // whether a BODY was found under this head — a pattern on the backdrop
        // detects as a face but never as a body, so this is the field that
        // separates a person from the wallpaper
        body: !!p.pose,
        // the box a person occupies on screen: head plus the torso the
        // signature was taken from, which is what makes them recognisable in
        // a thumbnail the size of a postage stamp
        box: {
          x: Math.max(0, p.cx - p.bw * 1.15), y: Math.max(0, p.cy - p.bh * 0.9),
          w: Math.min(1, p.bw * 2.3), h: Math.min(1, p.bh * 3.6),
        },
        sig: packSig(sig),
        thumb: opts.thumbs === false ? null : cutOut(el, w, h, p),
      });
    }
    // left to right, so the row of faces the user sees matches the picture
    return out.sort((a, b) => a.cx - b.cx);
  }

  /** A small JPEG of one person, for the "who should I follow?" picker. */
  function cutOut(el, w, h, p) {
    if (typeof document === 'undefined') return null;
    try {
      const sx = Math.max(0, (p.cx - p.bw * 1.1) * w), sy = Math.max(0, (p.cy - p.bh * 0.9) * h);
      const sw = Math.min(w - sx, p.bw * 2.2 * w), sh = Math.min(h - sy, p.bh * 3.4 * h);
      if (sw < 4 || sh < 4) return null;
      const c = document.createElement('canvas');
      const scale = Math.min(1, 128 / Math.max(sw, sh));
      c.width = Math.max(8, Math.round(sw * scale)); c.height = Math.max(8, Math.round(sh * scale));
      c.getContext('2d').drawImage(el, sx, sy, sw, sh, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }

  /*
   * Let the models go. Each holds its own WebAssembly memory, which only ever
   * grows: a phone tracking fourteen shorts in a row kept all of it and was
   * closed by iOS part-way through (the crash log ended right before a
   * short's tracking). Released between shorts, the next one starts fresh —
   * loading them again takes a second or two, from the phone's cache.
   */
  function release() {
    const d = detector, p = poser;
    detector = null; poser = null; initPromise = null;
    try { if (d && d.close) d.close(); } catch (e) {}
    try { if (p && p.close) p.close(); } catch (e) {}
  }
  window.FaceTrack = {
    release,
    /** Faces only, no body model — for a clip that closed the phone's app while tracking. */
    setLite(on) { if (!!on !== lite) { release(); lite = !!on; } },
    async available() { try { await init(); return true; } catch (e) { console.warn('FaceTrack unavailable', e && e.message); return false; } },
    async poseAvailable() { try { await init(); return !!poser; } catch (e) { return false; } },
    detectFrames, buildKeyframes, detectElement, resetLive, detectPeople, CAM,
    seedLive, personInColumn, REF_COLS,
    _dropBlips: dropBlips,
    /** One live frame ruled into the referee's columns, as a JPEG data URL. */
    columnGrid: (el) => drawColumnGrid([el], ['A']),
    /** Which processor actually watched the footage (null until the models load). */
    delegateInUse: () => delegateUsed,
    // The recovery layer, reachable on its own so it can be run against frozen
    // real footage (test/reframe-lab.js) without the models.
    _recovery: { recoverBlind, bridgeTrack, tracklets },
    packSig, unpackSig, sigSim, LOCK_MIN,
  };
})();
