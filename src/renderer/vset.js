/*
 * VIRTUAL SET — a camera keyed into a studio scene, the way vMix does it.
 *
 * A set is three layers: a BACKGROUND (the studio), the CAMERA with its green
 * screen removed, and an optional FOREGROUND (a desk, a plant, a pillar) that
 * the presenter stands behind. The camera sits in the scene at one of four
 * POSITIONS the operator sets up in advance — wide, mid, close, and one of
 * their own — and switching between them glides rather than jumps, so it looks
 * like a camera move instead of a cut.
 *
 * All of it runs on the GPU, and that is not a preference. Keying is per-pixel
 * work: at 1080p30 a JavaScript loop would be sixty million pixel tests a
 * second, on a machine that this app has already measured running out of CPU
 * with three streams open. A fragment shader does it for free. If WebGL is
 * unavailable the set degrades to a plain composite (no key) rather than
 * taking the switcher down with it — see `cpuFallback`.
 *
 * The key itself works in CHROMA, not RGB. Distance from the key colour is
 * measured on the Cb/Cr plane, so a shadow falling across the green screen
 * still reads as green and disappears, where an RGB distance would keep it as
 * a dark halo around the presenter. That one choice is most of the difference
 * between a key that looks broadcast and a key that looks like a cut-out.
 */
window.VirtualSet = (() => {
  'use strict';

  const VERT = `
    attribute vec2 p;              // unit quad, 0..1
    uniform vec4 rect;             // destination x0,y0,x1,y1 in clip space
    uniform vec4 uvxf;             // uv scale.xy, offset.zw (for cover-fit)
    varying vec2 uv;
    void main() {
      vec2 pos = mix(rect.xy, rect.zw, p);
      uv = vec2(p.x, 1.0 - p.y) * uvxf.xy + uvxf.zw;
      gl_Position = vec4(pos, 0.0, 1.0);
    }`;

  const FRAG = `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform float keyOn;           // 0 = draw as-is, 1 = chroma key it
    uniform vec3  keyRGB;
    uniform float tol;             // how close to the key colour still counts as background
    uniform float soft;            // width of the soft edge beyond that
    uniform float spill;           // how hard to pull the key's colour out of what is left
    uniform float fade;            // whole-layer opacity

    // Cb/Cr only — deliberately ignoring brightness, so a shadow on the green
    // screen keys out instead of surviving as a dark fringe.
    vec2 cbcr(vec3 c) {
      return vec2(-0.169 * c.r - 0.331 * c.g + 0.5   * c.b,
                   0.5   * c.r - 0.419 * c.g - 0.081 * c.b);
    }

    void main() {
      vec4 s = texture2D(tex, uv);
      if (keyOn < 0.5) { gl_FragColor = vec4(s.rgb, s.a * fade); return; }

      vec2 kc = cbcr(keyRGB);
      vec2 pc = cbcr(s.rgb);
      float d = distance(pc, kc);
      float a = smoothstep(tol, tol + max(soft, 0.001), d);

      // Spill: whatever chroma still points AT the key colour is pulled back
      // toward grey. Without this a keyed presenter wears a green rim under
      // any stage light, which is the giveaway that it is not a real set.
      vec3 rgb = s.rgb;
      float klen = max(length(kc), 0.0001);
      float lean = clamp(dot(pc, kc / klen) / klen, 0.0, 1.0);
      float lum = dot(s.rgb, vec3(0.2126, 0.7152, 0.0722));
      rgb = mix(rgb, vec3(lum), clamp(spill * lean, 0.0, 1.0));

      gl_FragColor = vec4(rgb, a * s.a * fade);
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    return sh;
  }

  function link(gl) {
    const pr = gl.createProgram();
    gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'link');
    return pr;
  }

  /** The four camera positions a set ships with, as fractions of the set. */
  const DEFAULT_PRESETS = [
    { name: 'Wide',   x: 0.5,  y: 0.56, scale: 0.72 },
    { name: 'Mid',    x: 0.5,  y: 0.60, scale: 0.92 },
    { name: 'Close',  x: 0.5,  y: 0.64, scale: 1.20 },
    { name: 'Left',   x: 0.34, y: 0.60, scale: 0.95 },
  ];

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#00b140'));
    const n = m ? parseInt(m[1], 16) : 0x00b140;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function srcSize(el) {
    if (!el) return [0, 0];
    if (el.videoWidth) return [el.videoWidth, el.videoHeight];
    return [el.width || 0, el.height || 0];
  }

  /**
   * @param {number} width  output size — the set renders at broadcast size and
   *                        the switcher scales it like any other input
   */
  function createSet(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width || 1280;
    canvas.height = height || 720;

    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false, antialias: false, depth: false, stencil: false,
        // The switcher drawImage()s this canvas in a LATER task than the one
        // that rendered it, so the backbuffer has to survive the frame.
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch (e) { gl = null; }
    if (!gl) return cpuFallback(canvas);

    let prog;
    try { prog = link(gl); } catch (e) { return cpuFallback(canvas); }

    const A = { p: gl.getAttribLocation(prog, 'p') };
    const U = {
      rect: gl.getUniformLocation(prog, 'rect'), uvxf: gl.getUniformLocation(prog, 'uvxf'),
      tex: gl.getUniformLocation(prog, 'tex'), keyOn: gl.getUniformLocation(prog, 'keyOn'),
      keyRGB: gl.getUniformLocation(prog, 'keyRGB'), tol: gl.getUniformLocation(prog, 'tol'),
      soft: gl.getUniformLocation(prog, 'soft'), spill: gl.getUniformLocation(prog, 'spill'),
      fade: gl.getUniformLocation(prog, 'fade'),
    };

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);

    function makeTex() {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    const texSrc = makeTex(), texBg = makeTex(), texFg = makeTex();
    let bgReady = false, fgReady = false, bgSize = [0, 0], fgSize = [0, 0];
    let lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    /** Cover-fit: fill the frame, crop the overflow, never letterbox the set. */
    function coverUv(sw, sh, dw, dh) {
      if (!sw || !sh) return [1, 1, 0, 0];
      const sa = sw / sh, da = dw / dh;
      if (sa > da) { const k = da / sa; return [k, 1, (1 - k) / 2, 0]; }
      const k = sa / da; return [1, k, 0, (1 - k) / 2];
    }

    function drawLayer(tex, rect, uvxf, keyCfg, fade) {
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(A.p);
      gl.vertexAttribPointer(A.p, 2, gl.FLOAT, false, 0, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(U.tex, 0);
      gl.uniform4f(U.rect, rect[0], rect[1], rect[2], rect[3]);
      gl.uniform4f(U.uvxf, uvxf[0], uvxf[1], uvxf[2], uvxf[3]);
      gl.uniform1f(U.fade, fade == null ? 1 : fade);
      if (keyCfg) {
        gl.uniform1f(U.keyOn, 1);
        gl.uniform3f(U.keyRGB, keyCfg.rgb[0], keyCfg.rgb[1], keyCfg.rgb[2]);
        gl.uniform1f(U.tol, keyCfg.tol);
        gl.uniform1f(U.soft, keyCfg.soft);
        gl.uniform1f(U.spill, keyCfg.spill);
      } else {
        gl.uniform1f(U.keyOn, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    const api = {
      canvas,
      accelerated: true,
      get lost() { return lost; },

      setSize(w, h) {
        if (!w || !h || (canvas.width === w && canvas.height === h)) return;
        canvas.width = w; canvas.height = h;
      },

      /** `img` is a loaded HTMLImageElement, or null to clear the layer. */
      setBackground(img) {
        if (!img) { bgReady = false; return; }
        gl.bindTexture(gl.TEXTURE_2D, texBg);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          bgSize = [img.naturalWidth || img.width, img.naturalHeight || img.height];
          bgReady = true;
        } catch (e) { bgReady = false; }
      },
      setForeground(img) {
        if (!img) { fgReady = false; return; }
        gl.bindTexture(gl.TEXTURE_2D, texFg);
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
          fgSize = [img.naturalWidth || img.width, img.naturalHeight || img.height];
          fgReady = true;
        } catch (e) { fgReady = false; }
      },

      /**
       * One frame.
       * @param {Object} o
       *   source  the camera element (video or canvas)
       *   pos     {x, y, scale} — where the camera sits in the set, 0..1
       *   key     {on, color, tolerance, softness, spill}
       */
      render(o) {
        if (lost) return false;
        const W = canvas.width, H = canvas.height;
        gl.viewport(0, 0, W, H);
        gl.disable(gl.BLEND);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (bgReady) {
          drawLayer(texBg, [-1, -1, 1, 1], coverUv(bgSize[0], bgSize[1], W, H), null, 1);
        }

        const src = o && o.source;
        const [sw, sh] = srcSize(src);
        if (src && sw && sh) {
          gl.bindTexture(gl.TEXTURE_2D, texSrc);
          try {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
          } catch (e) { /* frame not ready — keep the previous one */ }

          const pos = o.pos || DEFAULT_PRESETS[0];
          // The camera keeps its own shape: `scale` is how much of the set's
          // HEIGHT it fills, and the width follows from the source aspect.
          const dh = clamp(pos.scale, 0.05, 4) * H;
          const dw = dh * (sw / sh);
          const cx = clamp(pos.x, -1, 2) * W, cy = clamp(pos.y, -1, 2) * H;
          const x0 = (cx - dw / 2) / W * 2 - 1, x1 = (cx + dw / 2) / W * 2 - 1;
          // clip space is y-up, the placement is y-down
          const y1 = 1 - (cy - dh / 2) / H * 2, y0 = 1 - (cy + dh / 2) / H * 2;

          const k = o.key || {};
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          drawLayer(texSrc, [x0, y0, x1, y1], [1, 1, 0, 0],
            k.on === false ? null : {
              rgb: hexToRgb(k.color || '#00b140'),
              tol: k.tolerance == null ? 0.16 : k.tolerance,
              soft: k.softness == null ? 0.08 : k.softness,
              spill: k.spill == null ? 0.5 : k.spill,
            }, 1);
        }

        if (fgReady) {
          gl.enable(gl.BLEND);
          gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          drawLayer(texFg, [-1, -1, 1, 1], coverUv(fgSize[0], fgSize[1], W, H), null, 1);
        }
        gl.disable(gl.BLEND);
        return true;
      },

      destroy() {
        try {
          [texSrc, texBg, texFg].forEach((t) => gl.deleteTexture(t));
          gl.deleteBuffer(quad);
          gl.deleteProgram(prog);
          const ext = gl.getExtension('WEBGL_lose_context');
          if (ext) ext.loseContext();
        } catch (e) {}
      },
    };
    return api;
  }

  /**
   * No WebGL: still place the camera in the set, just without the key. Losing
   * the green-screen cut-out is bad; losing the switcher is worse, and a
   * machine this old would not have survived keying in JavaScript anyway.
   */
  function cpuFallback(canvas) {
    const ctx = canvas.getContext('2d');
    let bg = null, fg = null;
    return {
      canvas,
      accelerated: false,
      lost: false,
      setSize(w, h) { if (w && h) { canvas.width = w; canvas.height = h; } },
      setBackground(img) { bg = img || null; },
      setForeground(img) { fg = img || null; },
      render(o) {
        const W = canvas.width, H = canvas.height;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        const cover = (img) => {
          const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
          if (!iw || !ih) return;
          const s = Math.max(W / iw, H / ih);
          ctx.drawImage(img, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
        };
        if (bg) { try { cover(bg); } catch (e) {} }
        const src = o && o.source;
        const [sw, sh] = srcSize(src);
        if (src && sw && sh) {
          const pos = o.pos || DEFAULT_PRESETS[0];
          const dh = clamp(pos.scale, 0.05, 4) * H, dw = dh * (sw / sh);
          try { ctx.drawImage(src, clamp(pos.x, -1, 2) * W - dw / 2, clamp(pos.y, -1, 2) * H - dh / 2, dw, dh); } catch (e) {}
        }
        if (fg) { try { cover(fg); } catch (e) {} }
        return true;
      },
      destroy() {},
    };
  }

  /**
   * Glide between positions instead of cutting. A virtual camera that jumps
   * reads as a mistake; the same move over half a second reads as a camera
   * operator. Ease-in-out, because a constant-speed move is the other way to
   * look mechanical.
   */
  function makeMover(presets) {
    let from = null, to = 0, t0 = 0, dur = 0;
    const list = presets;
    return {
      get index() { return to; },
      goTo(i, ms) {
        if (i === to && !dur) return;
        from = this.current();
        to = clamp(i | 0, 0, list.length - 1);
        t0 = performance.now();
        dur = Math.max(0, ms == null ? 500 : ms);
        if (!dur) from = null;
      },
      /** Where the camera is right now. */
      current() {
        const dst = list[clamp(to, 0, list.length - 1)] || DEFAULT_PRESETS[0];
        if (!from || !dur) return { x: dst.x, y: dst.y, scale: dst.scale };
        const k = clamp((performance.now() - t0) / dur, 0, 1);
        const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // ease-in-out
        if (k >= 1) { from = null; dur = 0; return { x: dst.x, y: dst.y, scale: dst.scale }; }
        return {
          x: from.x + (dst.x - from.x) * e,
          y: from.y + (dst.y - from.y) * e,
          scale: from.scale + (dst.scale - from.scale) * e,
        };
      },
      get moving() { return !!(from && dur); },
    };
  }

  /**
   * Read the key colour straight off the picture. Asking an operator to type a
   * hex value for their green screen is asking them to guess; the top-left
   * corner of a keyed shot is background essentially every time, and the median
   * of a patch there is robust to a stray highlight in a way an average is not.
   */
  function sampleKeyColour(el, fx, fy) {
    const [sw, sh] = srcSize(el);
    if (!sw || !sh) return null;
    const cv = document.createElement('canvas');
    const N = 24;
    cv.width = N; cv.height = N;
    const c = cv.getContext('2d', { willReadFrequently: true });
    const px = clamp(fx == null ? 0.08 : fx, 0, 1) * sw;
    const py = clamp(fy == null ? 0.08 : fy, 0, 1) * sh;
    const half = Math.max(4, Math.round(Math.min(sw, sh) * 0.04));
    try {
      c.drawImage(el, clamp(px - half, 0, sw - 1), clamp(py - half, 0, sh - 1),
        Math.min(half * 2, sw), Math.min(half * 2, sh), 0, 0, N, N);
    } catch (e) { return null; }
    let data;
    try { data = c.getImageData(0, 0, N, N).data; } catch (e) { return null; }
    const rs = [], gs = [], bs = [];
    for (let i = 0; i < data.length; i += 4) { rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]); }
    const mid = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1] | 0; };
    const hex = (n) => n.toString(16).padStart(2, '0');
    return '#' + hex(mid(rs)) + hex(mid(gs)) + hex(mid(bs));
  }

  return { createSet, makeMover, sampleKeyColour, DEFAULT_PRESETS };
})();
