'use strict';
/*
 * On-device AI background removal for the Flyer Maker (free, offline).
 *
 * Primary path: MediaPipe ImageSegmenter with the bundled selfie models
 * (served over mwasset:// like the face tracker) — proper person cut-outs
 * with soft hair-edge feathering, Canva-style.
 *
 * Fallback path: border flood-fill (great for logos / studio / solid
 * backgrounds, and the guaranteed path when the model can't run, e.g. in
 * a test harness that never registered the mwasset:// scheme).
 */
(function () {
  let segmenter = null, initPromise = null, initFailed = false;
  // the desktop's privileged scheme, or — in the Cloud Studio's browser — the server's /ai/ route (as facetrack.js)
  const base = () => (typeof window !== 'undefined' && window.MW_AI_BASE) || 'mwasset://';

  async function init() {
    if (segmenter) return segmenter;
    if (initFailed) throw new Error('segmenter unavailable');
    if (!initPromise) initPromise = (async () => {
      const mp = await import(base() + 'vision_bundle.mjs');
      const vision = await mp.FilesetResolver.forVisionTasks(base() + 'wasm');
      // Multiclass model has much better hair/body edges; plain selfie model
      // is the lightweight fallback if the big model file is missing.
      for (const model of ['selfie_multiclass_256x256.tflite', 'selfie_segmenter.tflite']) {
        try {
          segmenter = await mp.ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: base() + model },
            runningMode: 'IMAGE',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          segmenter.__model = model;
          return segmenter;
        } catch (e) { /* try next model */ }
      }
      throw new Error('no segmentation model could be loaded');
    })().catch((e) => { initFailed = true; initPromise = null; throw e; });
    return initPromise;
  }

  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('image load failed')); i.src = src; });
  }

  function drawToCanvas(img, maxDim) {
    let w = img.naturalWidth, h = img.naturalHeight;
    const sc = Math.min(1, (maxDim || 2000) / Math.max(w, h));
    w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0, w, h);
    return { cv, cx, w, h };
  }

  /**
   * Person-probability mask (Float32Array of w*h, 0..1) for an image drawn on
   * a canvas. For the multiclass model, person = 1 - background confidence
   * (so hair/skin/clothes/accessories all count). The plain selfie model's
   * single mask IS the person confidence.
   */
  function personMask(result, w, h) {
    const masks = result.confidenceMasks || [];
    if (!masks.length) return null;
    try {
      if (masks.length > 1) {
        const bg = masks[0].getAsFloat32Array(); // class 0 = background
        const out = new Float32Array(bg.length);
        for (let i = 0; i < bg.length; i++) out[i] = 1 - bg[i];
        return { data: out, mw: masks[0].width || w, mh: masks[0].height || h };
      }
      const m = masks[0].getAsFloat32Array();
      return { data: m, mw: masks[0].width || w, mh: masks[0].height || h };
    } finally {
      for (const m of masks) { try { m.close(); } catch (e) {} }
    }
  }

  /** Box blur an alpha channel in place (cheap feathering). */
  function blurAlpha(a, w, h, r) {
    if (r <= 0) return a;
    const tmp = new Float32Array(a.length);
    // horizontal
    for (let y = 0; y < h; y++) {
      let acc = 0, cnt = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) { const xi = Math.min(w - 1, Math.max(0, x)); acc += a[row + xi]; cnt++; }
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / cnt;
        const xo = x - r, xn = x + r + 1;
        acc += a[row + Math.min(w - 1, xn)] - a[row + Math.max(0, xo)];
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let acc = 0, cnt = 0;
      for (let y = -r; y <= r; y++) { const yi = Math.min(h - 1, Math.max(0, y)); acc += tmp[yi * w + x]; cnt++; }
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / cnt;
        const yo = y - r, yn = y + r + 1;
        acc += tmp[Math.min(h - 1, yn) * w + x] - tmp[Math.max(0, yo) * w + x];
      }
    }
    return a;
  }


  /*
   * ►► A FINE MASK, NOT A BLOWN-UP ONE. ◄◄ The person model sees every picture
   * squashed to 256 × 256. A preacher on a wide stage photo is then a figure
   * eighty pixels tall, and stretching that mask back over a 12-megapixel
   * photo gave stair-stepped, wobbly edges ("shocking"). Three things make it
   * clean, all here on the phone, in a second or two:
   *
   *   1. A SECOND LOOK, CLOSE UP. The first pass only finds where the person
   *      is; the picture is then cropped round them and looked at again, in
   *      overlapping square tiles down a tall figure — several times the
   *      detail on the person themselves.
   *   2. SMOOTH, not nearest-pixel, scaling of that mask.
   *   3. A GUIDED FILTER (He, Sun & Tang): the edge is pulled onto the real
   *      edge in the photo — the line of a shoulder, a sleeve, the hair —
   *      instead of where the small mask happened to put it. It may only move
   *      the edge so far, so a white jacket against a pale wall cannot leak.
   */
  function sampleBilinear(data, mw, mh, fx, fy) {
    const x = Math.max(0, Math.min(mw - 1, fx * mw - 0.5)), y = Math.max(0, Math.min(mh - 1, fy * mh - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(mw - 1, x0 + 1), y1 = Math.min(mh - 1, y0 + 1), ax = x - x0, ay = y - y0;
    const a = data[y0 * mw + x0], b = data[y0 * mw + x1], c = data[y1 * mw + x0], d = data[y1 * mw + x1];
    return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
  }
  function segmentRegion(seg, src, sx, sy, sw, sh) {
    const S = 512, k = Math.min(1, S / Math.max(sw, sh));
    const c = document.createElement('canvas'); c.width = Math.max(8, Math.round(sw * k)); c.height = Math.max(8, Math.round(sh * k));
    c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return personMask(seg.segment(c), c.width, c.height);
  }
  function boxMean(a, w, h, r) { const o = Float32Array.from(a); return blurAlpha(o, w, h, r); }
  function guided(I, p, w, h, r, eps) {
    const n = w * h, Ip = new Float32Array(n), II = new Float32Array(n);
    for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
    const mI = boxMean(I, w, h, r), mp = boxMean(p, w, h, r), mIp = boxMean(Ip, w, h, r), mII = boxMean(II, w, h, r);
    const A = new Float32Array(n), B = new Float32Array(n);
    for (let i = 0; i < n; i++) { const v = mII[i] - mI[i] * mI[i], cv = mIp[i] - mI[i] * mp[i]; A[i] = cv / (v + eps); B[i] = mp[i] - A[i] * mI[i]; }
    const mA = boxMean(A, w, h, r), mB = boxMean(B, w, h, r);
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = mA[i] * I[i] + mB[i];
    return q;
  }
  /** Person confidence 0..1 for every pixel of a w × h canvas. */
  async function fineMask(cv, cx, w, h) {
    const seg = await init();
    const m1 = personMask(seg.segment(cv), w, h);
    if (!m1) throw new Error('no mask');
    const coarse = new Float32Array(w * h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, covered = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = sampleBilinear(m1.data, m1.mw, m1.mh, (x + 0.5) / w, (y + 0.5) / h);
      coarse[y * w + x] = v;
      if (v > 0.5) { covered++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const coverage = covered / (w * h);
    if (coverage < 0.015) { const e = new Error('no person found'); e.noPerson = true; throw e; }
    // the close look: the person's box, a margin round it, in square tiles along its long side
    const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.08;
    const bx = Math.max(0, Math.floor(x0 - mx)), by = Math.max(0, Math.floor(y0 - my));
    const bw = Math.min(w, Math.ceil(x1 + mx)) - bx, bh = Math.min(h, Math.ceil(y1 + my)) - by;
    const fine = coarse.slice(), wsum = new Float32Array(w * h), acc = new Float32Array(w * h);
    const tall = bh >= bw, long = tall ? bh : bw, short = tall ? bw : bh;
    const n = Math.max(1, Math.ceil(long / short * 1.15 - 0.15));
    const tile = n === 1 ? long : Math.min(long, Math.ceil(long / n * 1.3));
    for (let t = 0; t < n; t++) {
      const off = n === 1 ? 0 : Math.round(t * (long - tile) / (n - 1));
      const sx = tall ? bx : bx + off, sy = tall ? by + off : by, sw = tall ? bw : tile, sh = tall ? tile : bh;
      const m = segmentRegion(seg, cv, sx, sy, sw, sh);
      if (!m) continue;
      for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
        // feathered weight: tiles blend into each other, not seam
        const ex = Math.min(x, sw - 1 - x) / (sw * 0.15), ey = Math.min(y, sh - 1 - y) / (sh * 0.15);
        const wt = Math.max(0.02, Math.min(1, tall ? ey : ex)) * Math.max(0.02, Math.min(1, tall ? ex : ey) + 0.5);
        const i = (sy + y) * w + sx + x;
        acc[i] += wt * sampleBilinear(m.data, m.mw, m.mh, (x + 0.5) / sw, (y + 0.5) / sh); wsum[i] += wt;
      }
    }
    for (let i = 0; i < fine.length; i++) if (wsum[i] > 0) fine[i] = acc[i] / wsum[i];
    // the edge onto the photo's own edges
    const px = cx.getImageData(0, 0, w, h).data, I = new Float32Array(w * h);
    for (let i = 0, p = 0; i < I.length; i++, p += 4) I[i] = (0.299 * px[p] + 0.587 * px[p + 1] + 0.114 * px[p + 2]) / 255;
    const r = Math.max(3, Math.round(Math.max(w, h) / 320));
    const q = guided(I, fine, w, h, r, 2e-3);
    for (let i = 0; i < q.length; i++) { const lo = fine[i] - 0.3, hi = fine[i] + 0.3; q[i] = q[i] < lo ? lo : q[i] > hi ? hi : q[i]; q[i] = q[i] < 0 ? 0 : q[i] > 1 ? 1 : q[i]; }
    return { alpha: q, coverage };
  }

  /** AI person cut-out. Returns { src, coverage } or throws. */
  /*
   * ►► THE SERVER CUTS THEM OUT, WHEN THERE IS ONE. ◄◄ In the Cloud Studio the server runs BiRefNet (cutoutai.js): the
   * whole person at 1024×1024 — this phone's selfie model, at 256×256, took arms and feet off full-length stage
   * photos and left bits of the lectern, the chair and the smoke. The phone sends the photo (as a JPEG up to 2000
   * across) and gets the PNG back; the same photo is never sent twice. No server (the desktop app), or it cannot:
   * this phone's model, as before.
   */
  const serverCuts = new Map();
  const serverCan = () => typeof window !== 'undefined' && window.api && window.api.flyer && typeof window.api.flyer.cutout === 'function';
  async function serverCut(src) {
    if (!serverCan()) return null;
    const key = String(src).length > 200 ? String(src).slice(0, 120) + ':' + String(src).length + ':' + String(src).slice(-80) : String(src);
    if (!serverCuts.has(key)) {
      serverCuts.set(key, (async () => {
        const img = await loadImage(src);
        const { cv } = drawToCanvas(img, 2000);
        // (where their body is — this phone's pose model — so the server keeps only them: no lectern, no chair)
        let pose = null;
        try { const lm = await poseOf(cv); pose = lm ? lm.map((p) => ({ x: +p.x.toFixed(4), y: +p.y.toFixed(4), v: +(p.visibility || 0).toFixed(2) })) : null; } catch (e) { pose = null; }
        const r = await window.api.flyer.cutout(cv.toDataURL('image/jpeg', 0.93), pose);
        return r && r.dataUrl ? r : null;
      })().catch((e) => { serverCuts.delete(key); throw e; }));
    }
    return serverCuts.get(key);
  }

  async function removePerson(src) {
    try { const r = await serverCut(src); if (r) return { src: r.dataUrl, coverage: r.coverage, by: 'server' }; } catch (e) { /* this phone's model, then */ }
    const img = await loadImage(src);
    const { cv, cx, w, h } = drawToCanvas(img, 1600);
    const { alpha, coverage } = await fineMask(cv, cx, w, h);
    // a firm edge: the confident middle solid, the last pixel or two soft
    for (let i = 0; i < alpha.length; i++) {
      const v = (alpha[i] - 0.3) / (0.7 - 0.3);
      alpha[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    }

    const id = cx.getImageData(0, 0, w, h), d = id.data;
    for (let i = 0, p = 0; i < alpha.length; i++, p += 4) d[p + 3] = Math.round(d[p + 3] * alpha[i]);
    cx.putImageData(id, 0, 0);
    return { src: cv.toDataURL('image/png'), coverage };
  }

  /**
   * Border flood-fill remover (moved from editor.js). Erases pixels whose
   * colour matches the border-sampled background within `tol`, feathering the
   * boundary. Best on plain / solid / studio backgrounds (logos, graphics).
   */
  async function removeByEdges(src, tol = 34) {
    const img = await loadImage(src);
    const { cv, cx, w, h } = drawToCanvas(img, 1800);
    const id = cx.getImageData(0, 0, w, h), d = id.data;

    let br = 0, bgc = 0, bb = 0, n = 0;
    const sample = (x, y) => { const i = (y * w + x) * 4; br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; n++; };
    for (let x = 0; x < w; x += 2) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += 2) { sample(0, y); sample(w - 1, y); }
    br /= n; bgc /= n; bb /= n;
    const dist = (i) => Math.sqrt((d[i] - br) ** 2 + (d[i + 1] - bgc) ** 2 + (d[i + 2] - bb) ** 2);

    const visited = new Uint8Array(w * h);
    const stack = [];
    const soft = tol * 1.7;
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x; if (visited[p]) return; visited[p] = 1;
      const i = p * 4, dd = dist(i);
      if (dd <= tol) { d[i + 3] = 0; stack.push(p); }
      else if (dd <= soft) { d[i + 3] = Math.round(255 * (dd - tol) / (soft - tol)); stack.push(p); }
    };
    for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1); }
    for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y); }
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p - x) / w;
      if (d[p * 4 + 3] > 200) continue;
      consider(x + 1, y); consider(x - 1, y); consider(x, y + 1); consider(x, y - 1);
    }
    cx.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
  }


  /* ===================== masks, for an EDITOR to work on =====================
   *
   * removePerson/removeByEdges each answer "here is the finished picture" and
   * throw the mask away. That is fine for a one-press button and useless for an
   * editor: to change how much is removed, or to paint some of it back, the
   * caller needs the ALPHA ITSELF — recomputable at a different strength while
   * the brush strokes on top of it survive.
   *
   * So the same two algorithms are exposed here as mask producers. The picture
   * is returned alongside, at the working size, so the caller never has to
   * re-decode the file to recomposite.
   */

  /** Person alpha (0..255) from the segmenter. `strength` 0..1 biases how much
   *  of the uncertain edge counts as background — higher removes more. */
  async function personAlpha(cx, w, h, cv, strength) {
    const { alpha, coverage } = await fineMask(cv, cx, w, h);
    // The ramp is what "how much is removed" moves. Sliding it up demands more
    // confidence before a pixel is kept, so more of the fringe goes; sliding it
    // down keeps more of the halo. Same smoothstep as the one-press path at 0.5.
    const st = Math.max(0, Math.min(1, strength == null ? 0.5 : strength));
    const lo = 0.12 + st * 0.46;
    const hi = lo + 0.40;
    for (let i = 0; i < alpha.length; i++) {
      const v = (alpha[i] - lo) / (hi - lo);
      alpha[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    }
    const out = new Uint8ClampedArray(w * h);
    for (let i = 0; i < alpha.length; i++) out[i] = Math.round(alpha[i] * 255);
    return { alpha: out, coverage };
  }

  /** Border flood-fill alpha (0..255). `tol` is the colour distance that still
   *  counts as background — the "how much" dial for plain backdrops. */
  function edgeAlpha(cx, w, h, tol) {
    const id = cx.getImageData(0, 0, w, h), d = id.data;
    let br = 0, bgc = 0, bb = 0, n = 0;
    const sample = (x, y) => { const i = (y * w + x) * 4; br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; n++; };
    for (let x = 0; x < w; x += 2) { sample(x, 0); sample(x, h - 1); }
    for (let y = 0; y < h; y += 2) { sample(0, y); sample(w - 1, y); }
    br /= n; bgc /= n; bb /= n;
    const dist = (i) => Math.sqrt((d[i] - br) ** 2 + (d[i + 1] - bgc) ** 2 + (d[i + 2] - bb) ** 2);
    const alpha = new Uint8ClampedArray(w * h);
    alpha.fill(255);
    const visited = new Uint8Array(w * h);
    const stack = [];
    const soft = tol * 1.7;
    const consider = (x, y) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const p = y * w + x; if (visited[p]) return; visited[p] = 1;
      const dd = dist(p * 4);
      if (dd <= tol) { alpha[p] = 0; stack.push(p); }
      else if (dd <= soft) { alpha[p] = Math.round(255 * (dd - tol) / (soft - tol)); stack.push(p); }
    };
    for (let x = 0; x < w; x++) { consider(x, 0); consider(x, h - 1); }
    for (let y = 0; y < h; y++) { consider(0, y); consider(w - 1, y); }
    while (stack.length) {
      const p = stack.pop(); const x = p % w, y = (p - x) / w;
      if (alpha[p] > 200) continue;
      consider(x + 1, y); consider(x - 1, y); consider(x, y + 1); consider(x, y - 1);
    }
    return { alpha };
  }

  /**
   * The picture and its background mask, ready to be edited.
   * mode: "auto" (person segmenter, falling back to colour) | "ai" | "colour".
   * strength: 0..1 — how much background is taken.
   * Returns { w, h, rgba, alpha, method }.
   */
  async function maskFor(src, { mode = 'auto', strength = 0.5, maxDim = 1400 } = {}) {
    const img = await loadImage(src);
    const { cv, cx, w, h } = drawToCanvas(img, maxDim);
    const rgba = cx.getImageData(0, 0, w, h).data.slice();
    // the server's cut-out (see serverCut), at this size; the strength dial firms it up or lets more of the edge in
    if (mode !== 'colour') {
      try {
        const r = await serverCut(src);
        if (r) {
          const cut = drawToCanvas(await loadImage(r.dataUrl), maxDim);
          const sc = document.createElement('canvas'); sc.width = w; sc.height = h;
          const scx = sc.getContext('2d', { willReadFrequently: true });
          scx.drawImage(cut.cv, 0, 0, w, h);
          const d = scx.getImageData(0, 0, w, h).data, alpha = new Uint8ClampedArray(w * h);
          const k = Math.pow(2, (Math.max(0, Math.min(1, strength)) - 0.5) * 2.4);   // (0.5: as cut; higher: firmer)
          let on = 0;
          for (let i = 0; i < alpha.length; i++) { const a = d[i * 4 + 3] / 255; alpha[i] = Math.round(255 * Math.pow(a, k)); if (alpha[i] > 127) on++; }
          return { w, h, rgba, alpha, method: 'ai', coverage: on / alpha.length };
        }
      } catch (e) { /* this phone's model, then */ }
    }
    if (mode !== 'colour') {
      try {
        const r = await personAlpha(cx, w, h, cv, strength);
        return { w, h, rgba, alpha: r.alpha, method: 'ai', coverage: r.coverage };
      } catch (e) { if (mode === 'ai') throw e; /* else fall through */ }
    }
    // The colour dial runs the other way round to the AI one: a bigger
    // tolerance eats more of the backdrop, so strength maps straight onto it.
    const tol = Math.round(8 + Math.max(0, Math.min(1, strength)) * 72);
    const r = edgeAlpha(cx, w, h, tol);
    return { w, h, rgba, alpha: r.alpha, method: 'colour', tol };
  }

  /** Picture + edited alpha back into a PNG data URL. */
  function composite(w, h, rgba, alpha) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    const id = cx.createImageData(w, h), d = id.data;
    for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
      d[p] = rgba[p]; d[p + 1] = rgba[p + 1]; d[p + 2] = rgba[p + 2];
      d[p + 3] = Math.round((rgba[p + 3] / 255) * alpha[i]);
    }
    cx.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
  }
  /**
   * Smart remove: try the AI person segmenter first; if there is no person in
   * the image (logo, graphic) or the model can't run, fall back to flood-fill.
   * Returns { src, method: 'ai' | 'edges' }.
   */
  async function removeBackground(src, opts = {}) {
    if (opts.mode !== 'edges') {
      try {
        const r = await removePerson(src);
        return { src: r.src, method: 'ai', coverage: r.coverage };
      } catch (e) { /* fall through to edges */ }
    }
    return { src: await removeByEdges(src, opts.tol == null ? 34 : opts.tol), method: 'edges' };
  }

  async function aiAvailable() {
    try { await init(); return true; } catch (e) { return false; }
  }

  /*
   * WHERE THE BODY IS. MediaPipe's pose model (on this phone, like the cut-out)
   * gives the head, shoulders, elbows, hands, hips and knees: the flyer studio
   * uses them to throw away whatever the cut-out kept that is not the person
   * (a podium, a chair, a microphone stand) and to frame every photo the same
   * way, the face the same size.
   */
  let poser = null, poserP = null, poseFailed = false;
  async function initPose() {
    if (poser) return poser;
    if (poseFailed) throw new Error('pose unavailable');
    if (!poserP) poserP = (async () => {
      const mp = await import(base() + 'vision_bundle.mjs');
      const vision = await mp.FilesetResolver.forVisionTasks(base() + 'wasm');
      poser = await mp.PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: base() + 'pose_landmarker_lite.task' },
        runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3,
      });
      return poser;
    })().catch((e) => { poseFailed = true; poserP = null; throw e; });
    return poserP;
  }
  /** The 33 body landmarks (0..1, with visibility) of the main person in a picture, or null. */
  async function poseOf(src) {
    const p = await initPose();
    const r = p.detect(src);
    return r && r.landmarks && r.landmarks[0] ? r.landmarks[0] : null;
  }

  window.FlyerAI = { removeBackground, removePerson, removeByEdges, aiAvailable, maskFor, composite, poseOf };
})();
