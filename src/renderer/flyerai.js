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

  async function init() {
    if (segmenter) return segmenter;
    if (initFailed) throw new Error('segmenter unavailable');
    if (!initPromise) initPromise = (async () => {
      const mp = await import('mwasset://vision_bundle.mjs');
      const vision = await mp.FilesetResolver.forVisionTasks('mwasset://wasm');
      // Multiclass model has much better hair/body edges; plain selfie model
      // is the lightweight fallback if the big model file is missing.
      for (const model of ['selfie_multiclass_256x256.tflite', 'selfie_segmenter.tflite']) {
        try {
          segmenter = await mp.ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: 'mwasset://' + model },
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

  /** AI person cut-out. Returns { src, coverage } or throws. */
  async function removePerson(src) {
    const seg = await init();
    const img = await loadImage(src);
    const { cv, cx, w, h } = drawToCanvas(img, 1600);
    const result = seg.segment(cv);
    const mask = personMask(result, w, h);
    if (!mask) throw new Error('no mask');

    // Resample mask to image size if the model returned its own resolution.
    const { data, mw, mh } = mask;
    const alpha = new Float32Array(w * h);
    let covered = 0;
    for (let y = 0; y < h; y++) {
      const sy = mh === h ? y : Math.min(mh - 1, Math.round((y / h) * mh));
      for (let x = 0; x < w; x++) {
        const sx = mw === w ? x : Math.min(mw - 1, Math.round((x / w) * mw));
        const v = data[sy * mw + sx];
        alpha[y * w + x] = v;
        if (v > 0.5) covered++;
      }
    }
    const coverage = covered / (w * h);
    if (coverage < 0.015) { const e = new Error('no person found'); e.noPerson = true; throw e; }

    // Feather: soften the confidence step, then a light blur for hair edges.
    for (let i = 0; i < alpha.length; i++) {
      const v = (alpha[i] - 0.35) / (0.75 - 0.35); // smooth ramp between lo..hi
      alpha[i] = v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v);
    }
    blurAlpha(alpha, w, h, Math.max(1, Math.round(Math.max(w, h) / 500)));

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
    const seg = await init();
    const result = seg.segment(cv);
    const mask = personMask(result, w, h);
    if (!mask) throw new Error('no mask');
    const { data, mw, mh } = mask;
    const alpha = new Float32Array(w * h);
    let covered = 0;
    for (let y = 0; y < h; y++) {
      const sy = mh === h ? y : Math.min(mh - 1, Math.round((y / h) * mh));
      for (let x = 0; x < w; x++) {
        const sx = mw === w ? x : Math.min(mw - 1, Math.round((x / w) * mw));
        const v = data[sy * mw + sx];
        alpha[y * w + x] = v;
        if (v > 0.5) covered++;
      }
    }
    const coverage = covered / (w * h);
    if (coverage < 0.015) { const e = new Error('no person found'); e.noPerson = true; throw e; }
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
    blurAlpha(alpha, w, h, Math.max(1, Math.round(Math.max(w, h) / 500)));
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

  window.FlyerAI = { removeBackground, removePerson, removeByEdges, aiAvailable, maskFor, composite };
})();
