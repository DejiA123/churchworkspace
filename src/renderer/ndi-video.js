'use strict';
/**
 * window.NdiVideo — the drawing surface for a live NDI input.
 *
 * The receiver process sends frames in the sender's own wire format. For an
 * opaque source that is UYVY (4:2:2 — 2 bytes per pixel), which is half the
 * bytes of BGRA and therefore half the cost of crossing into this process; a
 * source with real alpha arrives as BGRA instead. Neither is something a canvas
 * can draw directly, so the conversion happens here — as a texture upload and a
 * one-triangle shader pass, i.e. on the GPU, where it is effectively free.
 *
 * The surface IS a canvas, so the compositor keeps drawing NDI inputs with the
 * same drawImage() it uses for a camera or a video file, and a GPU→GPU blit of
 * the result costs ~0.05 ms at 1080p.
 *
 * If WebGL is unavailable the surface silently falls back to a 2D canvas and
 * converts on the CPU — correct, much slower, and never used in practice.
 */
window.NdiVideo = (() => {
  const VERT = `
    attribute vec2 p;
    varying vec2 uv;
    void main() { uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }`;

  // UYVY: each RGBA texel carries TWO pixels as (U, Y0, V, Y1), so the texture
  // is half as wide as the picture. Which of the two luma samples this fragment
  // wants depends on whether its pixel column is even or odd.
  const FRAG_UYVY = `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform float srcW;      // picture width in pixels
    uniform float texW;      // texture width in texels (= ceil(srcW / 2))
    uniform vec3 cr;         // YUV->RGB coefficients: (Kr_v, Kb_u, -)
    uniform vec2 cg;         // (Kg_u, Kg_v)
    void main() {
      float x = floor(uv.x * srcW);
      float t = floor(x * 0.5);
      vec4 s = texture2D(tex, vec2((t + 0.5) / texW, uv.y));
      float y = mod(x, 2.0) < 1.0 ? s.g : s.a;
      y = (y - 0.0625) * 1.164383;
      float u = s.r - 0.5, v = s.b - 0.5;
      gl_FragColor = vec4(
        clamp(y + cr.x * v,               0.0, 1.0),
        clamp(y + cg.x * u + cg.y * v,    0.0, 1.0),
        clamp(y + cr.y * u,               0.0, 1.0), 1.0);
    }`;

  // BGRA / RGBA straight through — only the channel order differs.
  const FRAG_RGB = `
    precision mediump float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform float swap;      // 1.0 = source is BGRA
    void main() {
      vec4 s = texture2D(tex, uv);
      gl_FragColor = vec4(swap > 0.5 ? s.bgr : s.rgb, 1.0);
    }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
    return sh;
  }

  function link(gl, fragSrc) {
    const pr = gl.createProgram();
    gl.attachShader(pr, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(pr, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'link');
    return pr;
  }

  function createSurface() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 720;
    let gl = null;
    try {
      gl = canvas.getContext('webgl', {
        alpha: false, antialias: false, depth: false, stencil: false,
        // The compositor drawImage()s this canvas in a LATER task than the one
        // that drew into it, so the backbuffer has to survive the frame.
        preserveDrawingBuffer: true,
        powerPreference: 'high-performance',
      });
    } catch (e) { gl = null; }

    if (!gl) return cpuSurface(canvas);

    let pUyvy, pRgb;
    try { pUyvy = link(gl, FRAG_UYVY); pRgb = link(gl, FRAG_RGB); }
    catch (e) { return cpuSurface(canvas); }

    // Attribute/uniform locations are looked up ONCE. They never change, and
    // asking the driver for them on every frame is a per-frame cost for nothing.
    const U = {
      uyvy: { p: gl.getAttribLocation(pUyvy, 'p'), tex: gl.getUniformLocation(pUyvy, 'tex'),
        srcW: gl.getUniformLocation(pUyvy, 'srcW'), texW: gl.getUniformLocation(pUyvy, 'texW'),
        cr: gl.getUniformLocation(pUyvy, 'cr'), cg: gl.getUniformLocation(pUyvy, 'cg') },
      rgb: { p: gl.getAttribLocation(pRgb, 'p'), tex: gl.getUniformLocation(pRgb, 'tex'),
        swap: gl.getUniformLocation(pRgb, 'swap') },
    };

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    // One oversized triangle covers the viewport with no seam down the middle.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // NEAREST: the UYVY shader indexes exact texels, and filtering across them
    // would blend one pixel pair's luma into its neighbour's.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    let texW = 0, texH = 0, lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });

    function ensureTex(w, h) {
      if (w === texW && h === texH) return;
      texW = w; texH = h;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }

    return {
      canvas,
      accelerated: true,
      /** Draw one received frame. `buf` is a Uint8Array/Buffer of the raw bytes. */
      upload(frame) {
        if (lost) return false;
        const { w, h, fmt } = frame;
        if (!w || !h) return false;
        const bytes = frame.buf instanceof Uint8Array ? frame.buf : new Uint8Array(frame.buf);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        gl.bindTexture(gl.TEXTURE_2D, tex);

        const uyvy = fmt === 'uyvy';
        // FLOOR, not ceil: a UYVY texel is a pixel PAIR, so an odd width has no
        // texel for its final column. Rounding up would demand more bytes than
        // the frame contains and the short-frame guard below would then reject
        // every single frame; dropping that one column is invisible.
        const tw = uyvy ? (w >> 1) : w;
        const need = tw * h * 4;
        if (!tw || bytes.length < need) return false;   // a short/torn frame: skip it
        ensureTex(tw, h);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, h, gl.RGBA, gl.UNSIGNED_BYTE,
          bytes.length === need ? bytes : bytes.subarray(0, need));

        const pr = uyvy ? pUyvy : pRgb;
        const u = uyvy ? U.uyvy : U.rgb;
        gl.useProgram(pr);
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(u.p);
        gl.vertexAttribPointer(u.p, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1i(u.tex, 0);
        if (uyvy) {
          gl.uniform1f(u.srcW, tw * 2);
          gl.uniform1f(u.texW, tw);
          // HD is BT.709, SD is BT.601 — using the wrong matrix tints the whole
          // picture (greens go yellow), which is exactly what a "colour looks
          // off over NDI" report turns out to be.
          if (h >= 720) { gl.uniform3f(u.cr, 1.792741, 2.112402, 0); gl.uniform2f(u.cg, -0.213249, -0.532909); }
          else { gl.uniform3f(u.cr, 1.596027, 2.017232, 0); gl.uniform2f(u.cg, -0.391762, -0.812968); }
        } else {
          gl.uniform1f(u.swap, fmt === 'bgra' ? 1 : 0);
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        return true;
      },
      destroy() {
        try { gl.deleteTexture(tex); gl.deleteBuffer(quad); gl.deleteProgram(pUyvy); gl.deleteProgram(pRgb); } catch (e) {}
        try { const x = gl.getExtension('WEBGL_lose_context'); if (x) x.loseContext(); } catch (e) {}
      },
    };
  }

  /** Last-resort CPU path: correct, but converts every pixel in JavaScript. */
  function cpuSurface(canvas) {
    const ctx = canvas.getContext('2d', { alpha: false });
    let img = null;
    return {
      canvas,
      accelerated: false,
      upload(frame) {
        const { w, h, fmt } = frame;
        if (!w || !h) return false;
        const b = frame.buf instanceof Uint8Array ? frame.buf : new Uint8Array(frame.buf);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; img = null; }
        if (!img || img.width !== w || img.height !== h) img = ctx.createImageData(w, h);
        const o = img.data;
        if (fmt === 'uyvy') {
          const kr = h >= 720 ? 1.792741 : 1.596027, kb = h >= 720 ? 2.112402 : 2.017232;
          const gu = h >= 720 ? -0.213249 : -0.391762, gv = h >= 720 ? -0.532909 : -0.812968;
          let s = 0, d = 0;
          for (let i = 0, n = (w * h) >> 1; i < n; i++) {
            const u = b[s] - 128, y0 = (b[s + 1] - 16) * 1.164383, v = b[s + 2] - 128, y1 = (b[s + 3] - 16) * 1.164383;
            s += 4;
            o[d] = y0 + kr * v; o[d + 1] = y0 + gu * u + gv * v; o[d + 2] = y0 + kb * u; o[d + 3] = 255;
            o[d + 4] = y1 + kr * v; o[d + 5] = y1 + gu * u + gv * v; o[d + 6] = y1 + kb * u; o[d + 7] = 255;
            d += 8;
          }
        } else if (fmt === 'bgra') {
          for (let i = 0, n = w * h * 4; i < n; i += 4) { o[i] = b[i + 2]; o[i + 1] = b[i + 1]; o[i + 2] = b[i]; o[i + 3] = 255; }
        } else {
          o.set(b.subarray(0, w * h * 4));
          for (let i = 3, n = w * h * 4; i < n; i += 4) o[i] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return true;
      },
      destroy() {},
    };
  }

  return { createSurface };
})();
