'use strict';
/*
 * The renderer half of the replica run.
 *
 * Everything here is the studio's own code doing the studio's own job — the
 * MediaPipe tracker, the CapLayout caption layout, and the SVG-foreignObject
 * rasteriser. The only thing this file adds is the plumbing that the Video
 * Studio's UI would otherwise supply.
 */
(function () {
  const pathToUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').replace(/^\/+/, '').replace(/#/g, '%23').replace(/\?/g, '%3F');

  /* ---- the rasteriser, verbatim from src/renderer/renderer.js ---- */
  async function rasterizeToCanvas(css, body, w, h, opts) {
    const transparent = !!(opts && opts.transparent);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
      + '<foreignObject x="0" y="0" width="' + w + '" height="' + h + '">'
      + '<div xmlns="http://www.w3.org/1999/xhtml" style="width:' + w + 'px;height:' + h + 'px;margin:0;overflow:hidden;">'
      + '<style>' + css + '</style>' + body + '</div></foreignObject></svg>';
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not rasterise')); img.src = url; });
    const canvas = (opts && opts.canvas) || document.createElement('canvas');
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const cx = canvas.getContext('2d');
    cx.clearRect(0, 0, w, h);
    if (!transparent) { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h); }
    cx.drawImage(img, 0, 0, w, h);
    return canvas;
  }
  const canvasToDataUrl = (c) => c.toDataURL('image/png').split(',')[1];

  /* ---- the bundled caption faces, as @font-face the rasteriser can use ---- */
  let _fontCss = null, _faces = null;
  async function fontCss() {
    if (_fontCss != null) return _fontCss;
    const fonts = await window.api.fonts.data();
    let css = '';
    _faces = [];
    for (const f of fonts || []) {
      const src = 'url(data:font/ttf;base64,' + f.base64 + ') format("truetype")';
      for (const name of [f.family, f.name].filter((v, i, a) => v && a.indexOf(v) === i)) {
        css += '@font-face{font-family:"' + name + '";src:' + src + ';font-weight:100 900;font-style:normal;font-display:block;}';
        _faces.push([name, src]);
      }
    }
    _fontCss = css;
    return css;
  }
  /** The same faces loaded into THIS document, so measureText is measuring the
   *  real typeface. Without it every line is wrapped against Arial. */
  async function loadFaces() {
    await fontCss();
    for (const [name, src] of _faces) {
      try { const ff = new FontFace(name, src.replace(/^url\(/, 'url(')); await ff.load(); document.fonts.add(ff); } catch (e) {}
    }
    try { await document.fonts.ready; } catch (e) {}
    window.CapLayout.forgetMeasurements();
  }

  window.MW = {
    /* ---------------- follow the speaker ---------------- */
    async track({ input, startSec, endSec, targetAR, srcW, srcH }) {
      if (!(await window.FaceTrack.available())) throw new Error('face tracking is unavailable');
      const res = await window.api.sermon.extractFrames({ input, startSec, endSec, fps: 6, pairs: true });
      const frames = (res || []).map((f) => ({ t: f.t, url: pathToUrl(f.path), path: f.path, pairUrl: f.pairPath ? pathToUrl(f.pairPath) : null }));
      if (!frames.length) throw new Error('no frames were extracted');
      const cuts = res.cuts || [];
      const dets = await window.FaceTrack.detectFrames(frames, { cuts });
      if (!dets.length) throw new Error('the tracker saw nobody');
      const kf = window.FaceTrack.buildKeyframes(dets, srcW, srcH, { targetAR, cuts });
      return kf.map((k) => ({ t: k.t, x: k.x, y: k.y }));
    },

    /* ---------------- the name banner ---------------- */
    /* Drawn by the studio's own text-overlay look (textLookCss): a backing panel
     * in the chosen colour, bold words on top, rasterised to a transparent PNG
     * exactly as "Add text" is. */
    async banner({ text, w, h }) {
      const css = '*{box-sizing:border-box;margin:0;padding:0;}' + await fontCss();
      /*
       * Every number here is a fraction of the FRAME HEIGHT, read off the
       * reference at 576x1024 and divided through, so the banner is the same
       * banner at any export size.
       *
       *   white panel  361 x 39 px, top-left (119, 34)   black words, cap 20px
       *   yellow rule   36 x 69 px, top-left (106, 19)   5px stroke, r~8
       *
       * Poppins' capital is 0.7 of its em, so a 20px capital is a 28.6px font —
       * setting the font size to the cap height (which is what this drew first)
       * makes the whole banner a third too small.
       */
      const fontPx = Math.round(h * 0.0195 / 0.7);
      /* Fitted against the reference a second time, after the first pass came
       * out 16px wide, 2px short and 13px left of it at 576x1024:
       *   panel 361x40 at (119,33)   ink 335 wide, cap 20   yellow 36x69 at (106,19)
       * The words carry the same tightening as the captions do — the same
       * typeface difference makes them the same few per cent too wide — and the
       * group's centre is the reference's own 0.5078 of the frame, not 0.5. */
      const barH = Math.round(fontPx * 1.44);
      const padX = Math.round(fontPx * 0.395);
      const brW = Math.round(fontPx * 1.26), brH = Math.round(fontPx * 2.42);
      const stroke = Math.max(2, Math.round(fontPx * 0.175));
      const body = '<div style="position:relative;width:' + w + 'px;height:' + h + 'px;overflow:hidden;">'
        + '<div style="position:absolute;left:50.78%;top:' + Math.round(h * 0.01758) + 'px;transform:translateX(-50%);'
        + 'display:flex;align-items:center;">'
        + '<div style="flex:none;width:' + brW + 'px;height:' + brH + 'px;border:' + stroke + 'px solid #ffc400;'
        + 'border-radius:' + Math.round(fontPx * 0.28) + 'px;margin-right:' + (-Math.round(fontPx * 0.8)) + 'px;"></div>'
        + '<div style="background:#ffffff;color:#111111;font-family:\'Poppins\',sans-serif;font-weight:800;'
        + 'font-size:' + fontPx + 'px;line-height:' + barH + 'px;height:' + barH + 'px;padding:0 ' + padX + 'px;'
        + 'letter-spacing:' + (-0.034 * fontPx).toFixed(2) + 'px;'
        + 'white-space:pre;position:relative;">' + esc(text) + '</div>'
        + '</div></div>';
      return canvasToDataUrl(await rasterizeToCanvas(css, body, w, h, { transparent: true }));
    },

    /* ---------------- one line, measured ----------------
     * Renders a single caption at the export size and reports where its ink
     * landed, so the size and word spacing can be matched to a reference by
     * MEASUREMENT rather than by eye. */
    async measure({ text, cfg, outW, outH }) {
      await loadFaces();
      const CL = window.CapLayout;
      const L = CL.layout(text, cfg, outW, outH);
      const css = '*{box-sizing:border-box;margin:0;padding:0;}' + await fontCss();
      // Transparent, so the saved shot can be laid over the reference's own
      // frame and the two outlines measured by the same rule. On a black page
      // the outline is invisible against the page and cannot be measured at all.
      const body = '<div style="position:relative;width:' + outW + 'px;height:' + outH + 'px;overflow:hidden;">'
        + CL.html(text, cfg, outW, outH, { layout: L, state: { hl: -1 } }) + '</div>';
      const canvas = await rasterizeToCanvas(css, body, outW, outH, { transparent: true });
      const shot = canvasToDataUrl(canvas);
      const d = canvas.getContext('2d').getImageData(0, 0, outW, outH).data;
      let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
      const cols = [];
      for (let x = 0; x < outW; x++) {
        let hit = 0;
        for (let y = 0; y < outH; y++) {
          const i = (y * outW + x) * 4;
          if (d[i] >= 200 && d[i + 1] >= 200 && d[i + 2] >= 200) {
            hit++;
            if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
        cols.push(hit >= 2 ? 1 : 0);
      }
      const runs = []; let s = -1;
      for (let x = 0; x < outW; x++) { if (cols[x] && s < 0) s = x; else if (!cols[x] && s >= 0) { runs.push([s, x - 1]); s = -1; } }
      const gaps = runs.slice(1).map((r, i) => r[0] - runs[i][1] - 1);
      return {
        lines: L.lines, cap: y1 - y0 + 1, capFrac: (y1 - y0 + 1) / outH,
        width: x1 - x0 + 1, widthFrac: (x1 - x0 + 1) / outW,
        midYFrac: ((y0 + y1) / 2) / outH, gaps, shot,
      };
    },

    /* ---------------- the caption track ----------------
     * The same three steps capTrackForExport takes in veditor.js: lay every line
     * out at the export size, find the one band they can touch, then draw only
     * the frames that DIFFER — which, with the highlight on, means one per word.
     */
    async capTrack({ events, cfg, outW, outH, durationSec, outDir }) {
      await loadFaces();
      const CL = window.CapLayout;
      const list = events.filter((e) => e && e.text && String(e.text).trim());
      const layouts = list.map((e) => CL.layout(e.text, cfg, outW, outH));
      const band = bandFor(list, cfg, outW, outH, layouts);
      const fps = 30;
      const segs = segments(list, cfg, durationSec, fps);
      const css = '*{box-sizing:border-box;margin:0;padding:0;}' + await fontCss();
      const page = (inner) => '<div style="position:relative;width:' + band.w + 'px;height:' + band.h + 'px;overflow:hidden;">' + inner + '</div>';
      const canvas = document.createElement('canvas');
      canvas.width = band.w; canvas.height = band.h;
      const frames = [];
      let done = 0;
      for (const s of segs) {
        const dur = s.frames / fps;
        if (s.ev < 0) { frames.push({ file: null, dur }); continue; }
        const e = list[s.ev], L = layouts[s.ev];
        await rasterizeToCanvas(css,
          page(CL.html(e.text, cfg, outW, outH, { layout: L, state: { hl: s.hl }, originX: band.x, originY: band.y })),
          band.w, band.h, { transparent: true, canvas });
        /* Straight to disk, one frame at a time. Handing three and a half
         * thousand PNGs back as one JSON reply is tens of megabytes of base64
         * through the bridge for no reason — and the burner wants files. */
        frames.push({ file: await window.api.frames.write({ dir: outDir, i: frames.length, b64: canvasToDataUrl(canvas) }), dur });
        if ((++done % 250) === 0) console.log('caption frames', done, '/', segs.length);
      }
      return { band, fps, authorW: outW, authorH: outH, frames };
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function bandFor(events, cfg, outW, outH, layouts) {
    const k = window.CapLayout.maxScale(cfg.transition);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    events.forEach((e, i) => {
      const L = layouts[i];
      if (!L || !L.lines.length) return;
      const pad = L.m.fontPx * 0.6 + L.m.outlinePx * 2;
      x0 = Math.min(x0, L.cx - (L.blockW * k) / 2 - pad);
      x1 = Math.max(x1, L.cx + (L.blockW * k) / 2 + pad);
      y0 = Math.min(y0, L.cy - (L.blockH * k) / 2 - pad);
      y1 = Math.max(y1, L.cy + (L.blockH * k) / 2 + pad);
    });
    const bx = Math.max(0, Math.floor(x0 / 2) * 2), by = Math.max(0, Math.floor(y0 / 2) * 2);
    return {
      x: bx, y: by,
      w: Math.min(Math.max(2, Math.ceil((Math.ceil(x1) - bx) / 2) * 2), outW - bx),
      h: Math.min(Math.max(2, Math.ceil((Math.ceil(y1) - by) / 2) * 2), outH - by),
    };
  }
  function segments(events, cfg, durationSec, fps) {
    const total = Math.max(1, Math.ceil(durationSec * fps));
    const active = new Int32Array(total).fill(-1);
    events.forEach((e, j) => {
      const a = Math.max(0, Math.round(e.start * fps));
      const b = Math.min(total, Math.round(e.end * fps));
      for (let i = a; i < b; i++) active[i] = j;
    });
    const words = events.map((e) => window.CapLayout.wordTimes(e));
    const out = [];
    for (let i = 0; i < total; i++) {
      const j = active[i];
      const hl = j >= 0 ? window.CapLayout.activeWord(words[j], i / fps) : -1;
      const key = j + '|' + hl;
      const last = out[out.length - 1];
      if (last && last.key === key) { last.frames++; continue; }
      out.push({ key, ev: j, hl, frames: 1 });
    }
    return out;
  }

  window.__ready = true;
})();
