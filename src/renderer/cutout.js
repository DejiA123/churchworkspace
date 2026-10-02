'use strict';
/*
 * CUT-OUT EDITOR — "take the background out", with the two things that make it
 * usable rather than a lottery.
 *
 * A one-press remover is right about half the time. The other half it takes an
 * arm off, or leaves a grey halo, and there is nothing to do but undo. Every
 * tool people actually use (Canva, remove.bg, Photoshop) answers that with the
 * same two controls, and this has both:
 *
 *   1. HOW MUCH — a strength dial that re-runs the removal harder or gentler.
 *   2. BRUSHES  — erase what it missed, restore what it took by mistake.
 *
 * The important design decision is that these are SEPARATE LAYERS:
 *
 *     auto[]    the algorithm's alpha, recomputed whenever strength moves
 *     erase[]   what the operator painted OUT   (0..255, accumulating)
 *     keep[]    what the operator painted BACK  (0..255, accumulating)
 *
 *     final = max(auto * (1 - erase/255), keep)
 *
 * Because the brush strokes live in their own layers, moving the strength dial
 * re-runs the algorithm WITHOUT throwing the hand-work away — which is the whole
 * reason to have both controls rather than either one alone. Restore is applied
 * last so painting something back always wins, whatever the algorithm thinks.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const ED = {
    open: false,
    src: null,            // the file being cut out
    w: 0, h: 0,
    rgba: null,           // original pixels at working size
    auto: null,           // algorithm alpha
    erase: null, keep: null,
    method: '', strength: 0.5, mode: 'auto',
    tool: 'erase', brush: 60, soft: true,
    history: [],          // {erase, keep} snapshots for undo
    onDone: null,
    busy: false,
    view: { scale: 1, ox: 0, oy: 0 },
    painting: false,
  };

  /* ---------------------------------------------------------------- drawing */

  /** The alpha the operator is actually looking at. */
  function finalAlpha() {
    const n = ED.w * ED.h;
    const out = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      const a = ED.auto[i] * (1 - ED.erase[i] / 255);
      out[i] = Math.max(a, ED.keep[i]);
    }
    return out;
  }

  /** Repaint the canvas: checkerboard, then the picture at its current alpha. */
  function redraw() {
    const cv = $('cutCanvas'); if (!cv || !ED.rgba) return;
    const cx = cv.getContext('2d');
    const alpha = finalAlpha();
    // The picture, cut out, onto an offscreen buffer at working size.
    const off = document.createElement('canvas');
    off.width = ED.w; off.height = ED.h;
    const ocx = off.getContext('2d');
    const id = ocx.createImageData(ED.w, ED.h), d = id.data;
    for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
      d[p] = ED.rgba[p]; d[p + 1] = ED.rgba[p + 1]; d[p + 2] = ED.rgba[p + 2];
      d[p + 3] = Math.round((ED.rgba[p + 3] / 255) * alpha[i]);
    }
    ocx.putImageData(id, 0, 0);

    // Fit it into the visible canvas, and remember the mapping so a brush stroke
    // in screen pixels can be turned back into image pixels.
    const box = cv.parentElement.getBoundingClientRect();
    const cw = Math.max(80, Math.floor(box.width - 8));
    const ch = Math.max(80, Math.floor(box.height - 8));
    const sc = Math.min(cw / ED.w, ch / ED.h);
    const dw = Math.round(ED.w * sc), dh = Math.round(ED.h * sc);
    cv.width = dw; cv.height = dh;
    ED.view = { scale: sc, ox: 0, oy: 0 };

    // Checkerboard = "this is see-through", the universal way of showing it.
    const S = 10;
    cx.fillStyle = '#2a2f3a'; cx.fillRect(0, 0, dw, dh);
    cx.fillStyle = '#353b47';
    for (let y = 0; y < dh; y += S) {
      for (let x = ((y / S) % 2) * S; x < dw; x += S * 2) cx.fillRect(x, y, S, S);
    }
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(off, 0, 0, dw, dh);
  }

  /* ---------------------------------------------------------------- brushes */

  function snapshot() {
    ED.history.push({ erase: ED.erase.slice(), keep: ED.keep.slice() });
    if (ED.history.length > 20) ED.history.shift();
    const u = $('cutUndo'); if (u) u.disabled = false;
  }
  function undo() {
    const prev = ED.history.pop();
    if (!prev) return;
    ED.erase = prev.erase; ED.keep = prev.keep;
    const u = $('cutUndo'); if (u) u.disabled = !ED.history.length;
    redraw();
  }

  /**
   * Paint one dab. `r` is in IMAGE pixels; the falloff is quadratic so a soft
   * brush feathers instead of leaving a hard disc — which is what makes a
   * restored hair edge look like hair rather than a sticker.
   */
  function dab(cxi, cyi, r, layer) {
    const target = layer === 'erase' ? ED.erase : ED.keep;
    const other = layer === 'erase' ? ED.keep : ED.erase;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cxi - r)), x1 = Math.min(ED.w - 1, Math.ceil(cxi + r));
    const y0 = Math.max(0, Math.floor(cyi - r)), y1 = Math.min(ED.h - 1, Math.ceil(cyi + r));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cyi;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cxi;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const t = Math.sqrt(d2) / r;
        const fall = ED.soft ? (1 - t) * (1 - t) : 1;
        const add = Math.round(255 * fall);
        const i = y * ED.w + x;
        if (add > target[i]) target[i] = add;
        // Painting one way must undo the other, or the two layers fight and the
        // operator cannot correct an overshoot without starting again.
        if (add > 0) other[i] = Math.max(0, other[i] - add);
      }
    }
  }

  function pointToImage(ev) {
    const cv = $('cutCanvas');
    const r = cv.getBoundingClientRect();
    const p = (ev.touches && ev.touches[0]) || ev;
    return {
      x: (p.clientX - r.left) / ED.view.scale,
      y: (p.clientY - r.top) / ED.view.scale,
    };
  }

  function startPaint(ev) {
    if (!ED.rgba || ED.busy) return;
    ev.preventDefault();
    snapshot();
    ED.painting = true;
    let last = pointToImage(ev);
    const r = Math.max(2, ED.brush / 2 / ED.view.scale);
    dab(last.x, last.y, r, ED.tool);
    redraw();
    const move = (e) => {
      if (!ED.painting) return;
      const p = pointToImage(e);
      // Interpolate along the drag, or a fast stroke lands as dots.
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const steps = Math.max(1, Math.ceil(dist / (r * 0.4)));
      for (let i = 1; i <= steps; i++) {
        dab(last.x + (p.x - last.x) * (i / steps), last.y + (p.y - last.y) * (i / steps), r, ED.tool);
      }
      last = p;
      redraw();
    };
    const up = () => {
      ED.painting = false;
      document.removeEventListener('mousemove', move);
      document.removeEventListener('touchmove', move);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('touchmove', move, { passive: false });
    document.addEventListener('mouseup', up, { once: true });
    document.addEventListener('touchend', up, { once: true });
  }

  /* ------------------------------------------------------------- the dialog */

  function setBusy(on, msg) {
    ED.busy = on;
    const n = $('cutBusy');
    if (n) { n.classList.toggle('hidden', !on); if (msg) n.textContent = msg; }
    ['cutApply', 'cutStrength', 'cutMode'].forEach((id) => { const e = $(id); if (e) e.disabled = on; });
  }

  /** Re-run the algorithm at the current strength, keeping the brush work. */
  async function recompute(firstRun) {
    setBusy(true, firstRun ? '🪄 Taking the background out…' : 'Re-doing it at that strength…');
    try {
      const r = await window.FlyerAI.maskFor(ED.src, { mode: ED.mode, strength: ED.strength });
      const sizeChanged = r.w !== ED.w || r.h !== ED.h;
      ED.w = r.w; ED.h = r.h; ED.rgba = r.rgba; ED.auto = r.alpha; ED.method = r.method;
      if (sizeChanged || !ED.erase) {
        ED.erase = new Uint8ClampedArray(r.w * r.h);
        ED.keep = new Uint8ClampedArray(r.w * r.h);
        ED.history = [];
      }
      const m = $('cutMethod');
      if (m) {
        m.textContent = r.method === 'ai'
          ? '🧠 Found a person — cutting around them'
          : '🎨 No person found, so it is matching the backdrop colour';
      }
      redraw();
    } catch (e) {
      const m = $('cutMethod');
      if (m) m.textContent = '⚠️ ' + (e.message || 'could not read that picture');
    } finally { setBusy(false); }
  }

  function close() {
    ED.open = false;
    const box = $('cutModal'); if (box) box.classList.add('hidden');
    ED.rgba = ED.auto = ED.erase = ED.keep = null;
    ED.history = [];
  }

  /**
   * Open the editor on one image file.
   * `onDone(dataUrl)` is called with the finished PNG when Apply is pressed.
   */
  async function open(src, onDone, opts = {}) {
    if (!window.FlyerAI || !window.FlyerAI.maskFor) {
      window.__toast && window.__toast('The cut-out tool is not available.', 'error');
      return;
    }
    ED.src = src; ED.onDone = onDone; ED.open = true;
    // "Put the background back" only means something when there IS a cut-out to
    // undo, so the host says whether to offer it rather than it always sitting
    // there doing nothing.
    ED.onRestore = opts.onRestore || null;
    const rb = $('cutRestore');
    if (rb) {
      rb.classList.toggle('hidden', !ED.onRestore);
      rb.onclick = () => { const f = ED.onRestore; close(); if (f) f(); };
    }
    ED.strength = 0.5; ED.mode = 'auto'; ED.tool = 'erase'; ED.brush = 60; ED.soft = true;
    ED.w = ED.h = 0; ED.rgba = null; ED.erase = null; ED.keep = null; ED.history = [];
    $('cutModal').classList.remove('hidden');
    const st = $('cutStrength'); if (st) st.value = String(Math.round(ED.strength * 100));
    const md = $('cutMode'); if (md) md.value = ED.mode;
    const bs = $('cutBrush'); if (bs) bs.value = String(ED.brush);
    const u = $('cutUndo'); if (u) u.disabled = true;
    setTool('erase');
    await recompute(true);
  }

  function setTool(t) {
    ED.tool = t;
    ['erase', 'keep'].forEach((k) => {
      const b = $(k === 'erase' ? 'cutErase' : 'cutKeep');
      if (b) b.classList.toggle('on', ED.tool === k);
    });
    const cv = $('cutCanvas');
    if (cv) cv.style.cursor = 'crosshair';
  }

  function wire() {
    if (!$('cutModal')) return;
    $('cutClose').onclick = close;
    $('cutCancel').onclick = close;
    $('cutApply').onclick = () => {
      if (!ED.rgba) return close();
      const png = window.FlyerAI.composite(ED.w, ED.h, ED.rgba, finalAlpha());
      const cb = ED.onDone;
      close();
      if (cb) cb(png);
    };
    const st = $('cutStrength');
    if (st) {
      // Recompute on release, not on every pixel of the drag — the segmenter is
      // far too slow to run per input event and the slider would feel broken.
      const run = () => { ED.strength = Number(st.value) / 100; recompute(false); };
      st.addEventListener('change', run);
      st.addEventListener('input', () => {
        const l = $('cutStrengthVal');
        if (l) l.textContent = st.value + '%';
      });
    }
    const md = $('cutMode');
    if (md) md.addEventListener('change', () => { ED.mode = md.value; recompute(false); });
    $('cutErase').onclick = () => setTool('erase');
    $('cutKeep').onclick = () => setTool('keep');
    $('cutUndo').onclick = undo;
    $('cutReset').onclick = () => {
      if (!ED.erase) return;
      snapshot();
      ED.erase.fill(0); ED.keep.fill(0);
      redraw();
    };
    const bs = $('cutBrush');
    if (bs) bs.addEventListener('input', () => { ED.brush = Number(bs.value); const l = $('cutBrushVal'); if (l) l.textContent = bs.value + 'px'; });
    const soft = $('cutSoft');
    if (soft) soft.addEventListener('change', () => { ED.soft = soft.checked; });
    const cv = $('cutCanvas');
    if (cv) {
      cv.addEventListener('mousedown', startPaint);
      cv.addEventListener('touchstart', startPaint, { passive: false });
    }
    window.addEventListener('resize', () => { if (ED.open) redraw(); });
  }

  window.CutOut = {
    open, close, wire,
    // test hooks — the editor's state is the only way to check a brush landed
    __test: {
      state: () => ({
        open: ED.open, w: ED.w, h: ED.h, method: ED.method,
        strength: ED.strength, tool: ED.tool, brush: ED.brush,
        undoDepth: ED.history.length,
      }),
      /** Transparent-pixel count, as a fraction — "how much was removed". */
      removedFraction() {
        if (!ED.auto) return null;
        const a = finalAlpha();
        let clear = 0;
        for (let i = 0; i < a.length; i++) if (a[i] < 24) clear++;
        return clear / a.length;
      },
      alphaAt(fx, fy) {
        if (!ED.auto) return null;
        const x = Math.min(ED.w - 1, Math.max(0, Math.round(fx * ED.w)));
        const y = Math.min(ED.h - 1, Math.max(0, Math.round(fy * ED.h)));
        return finalAlpha()[y * ED.w + x];
      },
      async setStrength(v) { ED.strength = v; await recompute(false); },
      async setMode(m) { ED.mode = m; await recompute(false); },
      /** Paint a stroke in FRACTIONS of the image, so tests are size-agnostic. */
      paint(tool, fx, fy, fr) {
        setTool(tool);
        snapshot();
        dab(fx * ED.w, fy * ED.h, Math.max(2, fr * ED.w), tool);
        redraw();
      },
      undo,
      apply() {
        const png = window.FlyerAI.composite(ED.w, ED.h, ED.rgba, finalAlpha());
        return png;
      },
    },
  };
})();
