/*
 * ►► THE GRADE: ONE PIECE OF ARITHMETIC FOR THE PREVIEW AND THE EXPORT. ◄◄
 *
 * CapCut's Adjust tools — Brilliance, Highlights, Shadows, Whites, Blacks,
 * Temp, Hue, Fade, HSL, Curves, the Colour wheels — are all a function of a
 * pixel's own colour. Written once here, that function is
 *
 *   • baked into a 3-D colour table (a "LUT", 33 × 33 × 33) that ffmpeg's
 *     lut3d puts on every frame of the export (video.js fxVideo), and
 *   • baked into the very same table as a picture that the preview's WebGL
 *     layer looks every pixel up in (veditor.js gradeGl), the same way
 *     (trilinear), so what is on the phone is what is in the file.
 *
 * The tools that look at a pixel's NEIGHBOURS (Clarity, Sharpen, Reduce
 * noise, Vignette, Grain) are described here too (their numbers), and drawn
 * by each side with matching formulas.
 *
 * Loaded by the page (window.Grade) and by the main process (require).
 */
(function (root, factory) {
  const G = factory();
  if (typeof module === 'object' && module.exports) module.exports = G;
  else root.Grade = G;
}(typeof self !== 'undefined' ? self : this, () => {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const num = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? clamp(x, lo, hi) : 0; };

  /* the sliders, all -1…1 (0 = untouched) unless said otherwise */
  const SLIDERS = {
    bril: [-1, 1], hi: [-1, 1], sh: [-1, 1], wh: [-1, 1], bl: [-1, 1],
    temp: [-1, 1], hue: [-1, 1], fade: [0, 1],
    clar: [-1, 1], vig: [0, 1], grain: [0, 1], dn: [0, 1],
  };
  /* HSL: the eight colours it works on, and where each sits on the colour circle (degrees) */
  const HSL_BANDS = [['red', 0], ['orange', 30], ['yellow', 60], ['green', 120], ['cyan', 180], ['blue', 225], ['purple', 270], ['magenta', 315]];
  const CURVE_CH = ['m', 'r', 'g', 'b'];
  const WHEELS = ['lift', 'gamma', 'gain'];

  /** A curve's points, tidied: inside the square, sorted, the ends kept, at most 12. Null when it is the straight line. */
  function cleanCurve(pts) {
    if (!Array.isArray(pts)) return null;
    let p = pts.map((q) => Array.isArray(q) ? [num(q[0], 0, 1), num(q[1], 0, 1)] : null).filter(Boolean)
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const q of p) if (!out.length || q[0] - out[out.length - 1][0] > 0.01) out.push([+q[0].toFixed(3), +q[1].toFixed(3)]);
    p = out.slice(0, 12);
    if (p.length < 2 || p[0][0] > 0.001) p.unshift([0, p.length ? Math.min(p[0][1], 0) : 0]);
    if (p[p.length - 1][0] < 0.999) p.push([1, 1]);
    const straight = p.every((q) => Math.abs(q[0] - q[1]) < 0.004);
    return straight ? null : p;
  }

  /**
   * The new tools' part of a clip's look, tidied: only what differs from
   * "untouched", in range. {} when none of them is used.
   */
  function clean(fx) {
    const o = {};
    if (!fx || typeof fx !== 'object') return o;
    for (const [k, [lo, hi]] of Object.entries(SLIDERS)) {
      const v = num(fx[k], lo, hi);
      if (Math.abs(v) > 0.004) o[k] = +v.toFixed(3);
    }
    if (fx.enh) o.enh = 1;
    if (fx.flick) o.flick = 1;
    if (fx.hsl && typeof fx.hsl === 'object') {
      const h = {};
      for (const [band] of HSL_BANDS) {
        const v = fx.hsl[band];
        if (!Array.isArray(v)) continue;
        const t = [num(v[0], -1, 1), num(v[1], -1, 1), num(v[2], -1, 1)].map((x) => +x.toFixed(3));
        if (t.some((x) => Math.abs(x) > 0.004)) h[band] = t;
      }
      if (Object.keys(h).length) o.hsl = h;
    }
    if (fx.curves && typeof fx.curves === 'object') {
      const c = {};
      for (const ch of CURVE_CH) { const v = cleanCurve(fx.curves[ch]); if (v) c[ch] = v; }
      if (Object.keys(c).length) o.curves = c;
    }
    if (fx.wheels && typeof fx.wheels === 'object') {
      const w = {};
      for (const k of WHEELS) {
        const v = fx.wheels[k];
        if (!Array.isArray(v)) continue;
        let x = num(v[0], -1, 1), y = num(v[1], -1, 1), l = num(v[2], -1, 1);
        const r = Math.hypot(x, y); if (r > 1) { x /= r; y /= r; }
        if (Math.hypot(x, y) > 0.01 || Math.abs(l) > 0.004) w[k] = [+x.toFixed(3), +y.toFixed(3), +l.toFixed(3)];
      }
      if (Object.keys(w).length) o.wheels = w;
    }
    return o;
  }

  /** Does this look need the colour table at all? */
  function needsLut(g) {
    return !!(g && (g.bril || g.hi || g.sh || g.wh || g.bl || g.temp || g.hue || g.fade || g.hsl || g.curves || g.wheels));
  }

  /* ---- monotone cubic through points (Fritsch–Carlson): never overshoots, so a curve cannot fold back ---- */
  function spline(pts) {
    const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    if (n < 2) return (x) => x;
    const d = [], m = new Array(n).fill(0);
    for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (Math.abs(d[i]) < 1e-9) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return (x) => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  /* the colour a wheel points at, as an offset that adds up to nothing (it shifts the colour, not the brightness) */
  function wheelTint(x, y) {
    const r = Math.hypot(x, y); if (r < 1e-6) return [0, 0, 0];
    const a = Math.atan2(y, x);   // 0 = red at the right, counter-clockwise
    const c = [Math.cos(a), Math.cos(a - 2.0944), Math.cos(a + 2.0944)];   // red, green, blue: zero-mean
    return c.map((v) => v * r);
  }

  const rgb2hsl = (r, g, b) => {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    if (mx - mn < 1e-6) return [0, 0, l];
    const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  };
  const hsl2rgb = (h, s, l) => {
    if (s <= 1e-6) return [l, l, l];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, hk = (((h % 360) + 360) % 360) / 360;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(hk + 1 / 3), f(hk), f(hk - 1 / 3)];
  };
  const hueDist = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d; };

  /**
   * The grade as a function of one colour (0…1 red, green, blue → the same).
   * Order: colour wheels, white balance, hue, HSL, the tone curve (blacks,
   * shadows, brilliance, highlights, whites, fade), then the Curves.
   */
  function makeFn(g) {
    g = g || {};
    const W = g.wheels || {};
    const lift = W.lift ? wheelTint(W.lift[0], W.lift[1]).map((v) => v * 0.12 + W.lift[2] * 0.1) : null;
    const gamma = W.gamma ? wheelTint(W.gamma[0], W.gamma[1]).map((v) => 1 + v * 0.35 + W.gamma[2] * 0.3) : null;
    const gain = W.gain ? wheelTint(W.gain[0], W.gain[1]).map((v) => 1 + v * 0.25 + W.gain[2] * 0.25) : null;
    const temp = g.temp || 0, hueDeg = (g.hue || 0) * 60;
    const bands = g.hsl ? HSL_BANDS.filter(([b]) => g.hsl[b]).map(([b, deg]) => [deg, g.hsl[b]]) : [];
    // the tone curve, from the sliders: a few points moved, joined smoothly
    const bl = g.bl || 0, sh = g.sh || 0, br = g.bril || 0, hi = g.hi || 0, wh = g.wh || 0, fade = g.fade || 0;
    const tone = (bl || sh || br || hi || wh || fade) ? spline([
      [0, clamp(Math.max(0, bl) * 0.06 + fade * 0.16, 0, 0.4)],
      [0.1, clamp(0.1 + bl * 0.07 + sh * 0.03 + br * 0.03 + fade * 0.1, 0.01, 0.5)],
      [0.25, clamp(0.25 + sh * 0.11 + bl * 0.02 + br * 0.08 + fade * 0.05, 0.02, 0.6)],
      [0.5, clamp(0.5 + (sh + hi) * 0.025 + br * 0.04, 0.2, 0.8)],
      [0.75, clamp(0.75 + hi * 0.11 + wh * 0.02 - br * 0.04 - fade * 0.02, 0.4, 0.98)],
      [0.9, clamp(0.9 + wh * 0.07 + hi * 0.03 - br * 0.03 - fade * 0.04, 0.5, 0.995)],
      [1, clamp(1 + Math.min(0, wh) * 0.06 - fade * 0.06, 0.6, 1)],
    ].map((p, i, a) => (i && p[1] < a[i - 1][1] ? [p[0], a[i - 1][1]] : p))) : null;
    const C = g.curves || {};
    const cm = C.m ? spline(C.m) : null, cr = C.r ? spline(C.r) : null, cg = C.g ? spline(C.g) : null, cb = C.b ? spline(C.b) : null;
    return (r, gr, b) => {
      let c = [r, gr, b];
      if (gain || lift || gamma) {
        c = c.map((v, i) => {
          let x = v;
          if (gain) x *= gain[i];
          if (lift) x = x + lift[i] * (1 - x);
          x = clamp(x, 0, 1);
          if (gamma) x = Math.pow(x, 1 / Math.max(0.2, gamma[i]));
          return x;
        });
      }
      if (temp) { c[0] *= 1 + temp * 0.16; c[1] *= 1 + temp * 0.03; c[2] *= 1 - temp * 0.16; }
      if (hueDeg || bands.length) {
        let [h, s, l] = rgb2hsl(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1));
        h += hueDeg;
        if (bands.length && s > 0.02) {
          let dh = 0, ds = 0, dl = 0;
          for (const [deg, [bh, bs, bl2]] of bands) {
            const w = Math.max(0, 1 - hueDist(h, deg) / 45);   // a colour 45° away is untouched
            if (!w) continue;
            dh += w * bh * 30; ds += w * bs; dl += w * bl2;
          }
          h += dh;
          s = clamp(s * (1 + ds), 0, 1);
          l = clamp(l + dl * 0.25 * Math.min(1, s * 2), 0, 1);
        }
        c = hsl2rgb(h, s, l);
      }
      if (tone) {
        const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        const d = tone(clamp(y, 0, 1)) - y;
        c = c.map((v) => v + d);
      }
      if (cm) c = c.map((v) => cm(clamp(v, 0, 1)));
      if (cr) c[0] = cr(clamp(c[0], 0, 1));
      if (cg) c[1] = cg(clamp(c[1], 0, 1));
      if (cb) c[2] = cb(clamp(c[2], 0, 1));
      return c.map((v) => clamp(v, 0, 1));
    };
  }

  const LUT_N = 33;
  /** The colour table: N³ entries, red fastest (the .cube order). Float32Array of r,g,b. */
  function lut(g, n = LUT_N) {
    const f = makeFn(g), out = new Float32Array(n * n * n * 3);
    let k = 0;
    for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
      const c = f(ri / (n - 1), gi / (n - 1), bi / (n - 1));
      out[k++] = c[0]; out[k++] = c[1]; out[k++] = c[2];
    }
    return out;
  }
  /** The table as a .cube file, for ffmpeg's lut3d. */
  function cube(g, n = LUT_N) {
    const t = lut(g, n), lines = ['TITLE "Church Space grade"', `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1'];
    for (let i = 0; i < t.length; i += 3) lines.push(`${t[i].toFixed(6)} ${t[i + 1].toFixed(6)} ${t[i + 2].toFixed(6)}`);
    return lines.join('\n') + '\n';
  }
  /** The table as an RGBA picture N² wide and N tall (blue slices side by side), for the preview's WebGL. */
  function lutImage(g, n = LUT_N) {
    const t = lut(g, n), px = new Uint8Array(n * n * n * 4);
    for (let bi = 0; bi < n; bi++) for (let gi = 0; gi < n; gi++) for (let ri = 0; ri < n; ri++) {
      const src = ((bi * n + gi) * n + ri) * 3, dst = (gi * n * n + bi * n + ri) * 4;
      px[dst] = Math.round(t[src] * 255); px[dst + 1] = Math.round(t[src + 1] * 255); px[dst + 2] = Math.round(t[src + 2] * 255); px[dst + 3] = 255;
    }
    return { data: px, width: n * n, height: n, n };
  }

  /* The neighbour tools, in numbers both sides use. */
  const SPATIAL = {
    // Clarity: local contrast — the picture minus a wide blur of itself (a Gaussian blur, sigma 6 pixels of the original, on brightness only)
    clarSigma: 6, clarAmount: (v) => +(v * 1.2).toFixed(3),
    // Enhance quality: a little noise taken out, a little detail put back
    enh: { dn: 0.3, sharp: 0.6, clar: 0.15 },
    // Reduce image noise (hqdn3d strengths at full)
    dn: { ls: 6, cs: 4.5, lt: 9, ct: 7 },
    // Vignette (ffmpeg vignette: cos⁴ of the angle at each pixel)
    vigAngle: (v) => +(v * 1.05).toFixed(4),
    // Grain (± this many levels of 255 on brightness)
    grain: (v) => Math.round(v * 28),
  };
  /** What a clip's look asks of the neighbour tools, with Enhance folded in. */
  function spatial(g, sharp0) {
    g = g || {};
    const e = g.enh ? SPATIAL.enh : { dn: 0, sharp: 0, clar: 0 };
    return {
      dn: clamp((g.dn || 0) + e.dn, 0, 1),
      clar: clamp((g.clar || 0) + e.clar, -1, 1),
      sharp: clamp((sharp0 || 0) + e.sharp, 0, 2),
      vig: g.vig || 0, grain: g.grain || 0, flick: !!g.flick,
    };
  }

  return { SLIDERS, HSL_BANDS, CURVE_CH, WHEELS, clean, cleanCurve, needsLut, makeFn, spline, lut, cube, lutImage, LUT_N, SPATIAL, spatial, wheelTint };
}));
