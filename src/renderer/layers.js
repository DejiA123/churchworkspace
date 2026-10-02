'use strict';
/*
 * The layer engine behind every output screen.
 *
 * A church output is not one picture — it's seven independent pictures stacked
 * on top of each other, and the whole point is that they DON'T move together:
 *
 *   background    the motion loop / colour / live camera feed
 *   media         a foreground video or image over that background
 *   slide         the lyrics or verse
 *   announcement  a notice that stays up across slide changes
 *   props         the persistent logo / lower third / bug
 *   messages      a timed pop-up ("Parent of child #42 to the nursery")
 *   mask          a top-most overlay (vignette, LED-wall mask, safe frame)
 *
 * Each layer owns its own render pass, its own transition and its own clear
 * state. That is what makes "clear the lyrics but leave the background video
 * playing" a one-click operation instead of a re-cue — the single most-used
 * control on a Sunday and the thing a single-picture renderer cannot do.
 *
 * Every layer double-buffers: the incoming picture is painted into the hidden
 * buffer, allowed to decode, and only then swapped in. Painting into the
 * visible buffer flashes the background for a frame while a 4K JPEG decodes.
 */
(function () {
  const ORDER = ['background', 'media', 'slide', 'announcement', 'props', 'messages', 'mask'];
  const Z = { background: 10, media: 20, slide: 30, announcement: 40, props: 50, messages: 60, mask: 70 };

  /* ---------------- transitions ----------------
   * Expressed as (from → to) CSS state pairs so the same table drives the real
   * output, the operator's preview and the picker's little animated swatches. */
  const TRANSITIONS = {
    cut: { ms: 0, enter: {}, exit: {} },
    dissolve: { ms: 500, enter: { opacity: 0 }, exit: { opacity: 0 } },
    push_left: { ms: 600, enter: { transform: 'translateX(100%)' }, exit: { transform: 'translateX(-100%)' } },
    push_right: { ms: 600, enter: { transform: 'translateX(-100%)' }, exit: { transform: 'translateX(100%)' } },
    push_up: { ms: 600, enter: { transform: 'translateY(100%)' }, exit: { transform: 'translateY(-100%)' } },
    push_down: { ms: 600, enter: { transform: 'translateY(-100%)' }, exit: { transform: 'translateY(100%)' } },
    wipe: { ms: 700, enter: { clipPath: 'inset(0 100% 0 0)' }, exit: { opacity: 1 } },
    wipe_up: { ms: 700, enter: { clipPath: 'inset(100% 0 0 0)' }, exit: { opacity: 1 } },
    zoom: { ms: 600, enter: { opacity: 0, transform: 'scale(1.18)' }, exit: { opacity: 0, transform: 'scale(0.88)' } },
    ripple: { ms: 800, enter: { opacity: 0, filter: 'blur(22px)', transform: 'scale(1.06)' }, exit: { opacity: 0, filter: 'blur(22px)' } },
    spin: { ms: 750, enter: { opacity: 0, transform: 'rotate(-9deg) scale(1.22)' }, exit: { opacity: 0, transform: 'rotate(9deg) scale(0.8)' } },
    soft_blur: { ms: 700, enter: { opacity: 0, filter: 'blur(30px)' }, exit: { opacity: 0, filter: 'blur(30px)' } },
  };
  const TRANSITION_LIST = [
    { id: 'cut', name: 'Cut' }, { id: 'dissolve', name: 'Dissolve' },
    { id: 'push_left', name: 'Push left' }, { id: 'push_right', name: 'Push right' },
    { id: 'push_up', name: 'Push up' }, { id: 'push_down', name: 'Push down' },
    { id: 'wipe', name: 'Wipe' }, { id: 'wipe_up', name: 'Wipe up' },
    { id: 'zoom', name: 'Zoom' }, { id: 'ripple', name: 'Ripple' },
    { id: 'spin', name: 'Spin' }, { id: 'soft_blur', name: 'Soft blur' },
  ];
  const trans = (id) => TRANSITIONS[id] || TRANSITIONS.dissolve;

  const CSS = `
    .lyr { position:absolute; inset:0; pointer-events:none; }
    .lyr-buf { position:absolute; inset:0; opacity:1; will-change:opacity,transform,filter; }
    .lyr-buf.hide { opacity:0; }
    .lyr-cleared { display:none !important; }
    .lyr-prop { position:absolute; }
    .lyr-msg { position:absolute; left:0; right:0; display:flex; justify-content:center; }
    .lyr-msg-inner { background:rgba(0,0,0,.78); color:#fff; padding:0.55em 1.3em; border-radius:0.35em;
      font-weight:700; text-align:center; max-width:86%; }
    .lyr-timer { position:absolute; font-variant-numeric:tabular-nums; font-weight:800; }
    .lyr-video, .lyr-img { position:absolute; inset:0; width:100%; height:100%; }
    /* Easy View: a high-contrast reader over everything, for checking words
       without squinting at a thumbnail (ProPresenter binds this to ~). */
    .lyr-easy { position:absolute; inset:0; background:#000; color:#fff; display:flex;
      align-items:center; justify-content:center; text-align:center; padding:6%;
      font-size:76px; font-weight:800; line-height:1.25; z-index:200; white-space:pre-wrap; }
  `;

  function injectCss(doc) {
    const d = doc || document;
    if (d.getElementById('lyr-css')) return;
    const st = d.createElement('style');
    st.id = 'lyr-css'; st.textContent = CSS;
    d.head.appendChild(st);
  }

  /**
   * A stack of seven layers inside `host`.
   * `opts.onNeedsPaint(layer, buf, content, look)` does the actual drawing for a
   * layer — the caller owns what a slide looks like; this owns WHEN and HOW it
   * appears.
   */
  function createStack(host, opts = {}) {
    injectCss(host.ownerDocument);
    const layers = {};
    for (const name of ORDER) {
      const el = host.ownerDocument.createElement('div');
      el.className = 'lyr lyr-' + name;
      el.style.zIndex = String(Z[name]);
      host.appendChild(el);
      const bufs = [mkBuf(el), mkBuf(el)];
      bufs[1].classList.add('hide');
      layers[name] = { el, bufs, front: 0, sig: null, cleared: false };
    }
    function mkBuf(parent) {
      const b = parent.ownerDocument.createElement('div');
      b.className = 'lyr-buf';
      parent.appendChild(b);
      return b;
    }

    /**
     * Show `content` on `name`, transitioning from whatever is there.
     * `sig` is a cheap identity for the content — when it is unchanged the layer
     * is left completely alone, which is how a background video keeps playing
     * (and keeps its position!) while the lyrics above it change.
     */
    function set(name, content, look, { transition, sig, force } = {}) {
      const L = layers[name];
      if (!L) return;
      const nextSig = sig != null ? sig : JSON.stringify(content || null);
      if (!force && nextSig === L.sig) return false;
      L.sig = nextSig;

      const back = L.bufs[1 - L.front];
      const frontBuf = L.bufs[L.front];
      // Paint the hidden buffer first so images/videos have decoded before the
      // audience ever sees the buffer. Release any live camera/screen stream it
      // was holding, or the capture keeps running (and the camera light stays on).
      if (back._stopStream) { try { back._stopStream(); } catch (e) {} back._stopStream = null; }
      back.innerHTML = '';
      if (content != null && opts.onNeedsPaint) opts.onNeedsPaint(name, back, content, look);

      const t = trans(transition || 'dissolve');
      const ms = t.ms;
      if (!ms) {
        applyStyle(back, {}); back.classList.remove('hide');
        applyStyle(frontBuf, {}); frontBuf.classList.add('hide');
        L.front = 1 - L.front;
        return true;
      }
      // start the incoming buffer at its "enter" pose, then release it
      back.style.transition = 'none';
      applyStyle(back, t.enter);
      back.classList.remove('hide');
      void back.offsetWidth; // flush, so the transition really animates
      back.style.transition = `opacity ${ms}ms ease, transform ${ms}ms ease, filter ${ms}ms ease, clip-path ${ms}ms ease`;
      applyStyle(back, { opacity: 1, transform: 'none', filter: 'none', clipPath: 'inset(0 0 0 0)' });
      frontBuf.style.transition = back.style.transition;
      applyStyle(frontBuf, t.exit);
      const dying = frontBuf;
      setTimeout(() => { if (dying !== L.bufs[L.front]) { dying.innerHTML = ''; dying.classList.add('hide'); } }, ms + 40);
      L.front = 1 - L.front;
      return true;
    }
    function applyStyle(el, s) {
      el.style.opacity = s.opacity != null ? String(s.opacity) : '1';
      el.style.transform = s.transform || 'none';
      el.style.filter = s.filter || 'none';
      el.style.clipPath = s.clipPath || 'inset(0 0 0 0)';
    }

    /** Hide/show a whole layer without destroying it — this is Clear. */
    function clear(name, on) {
      const L = layers[name]; if (!L) return;
      L.cleared = !!on;
      L.el.classList.toggle('lyr-cleared', !!on);
    }
    function isCleared(name) { return !!(layers[name] && layers[name].cleared); }
    /** Drop a layer's content entirely (so the next set() repaints from scratch). */
    function wipe(name) {
      const L = layers[name]; if (!L) return;
      L.sig = null;
      L.bufs.forEach((b) => { b.innerHTML = ''; b.classList.add('hide'); });
    }
    function destroy() { for (const n of ORDER) { const L = layers[n]; if (L && L.el.parentNode) L.el.parentNode.removeChild(L.el); } }
    return { layers, set, clear, isCleared, wipe, destroy, ORDER };
  }

  window.Layers = { ORDER, Z, TRANSITIONS, TRANSITION_LIST, trans, createStack, injectCss, CSS };
})();
