'use strict';
/*
 * The projector / confidence-monitor window.
 *
 * It holds no presentation and no opinions: it receives a state object and
 * draws it through the seven-layer engine. That means an output can be closed
 * and re-opened mid-service and instantly shows whatever is live (main
 * re-pushes on load), and every output can render the SAME cue with a different
 * Look — a full-screen decorative treatment in the room, a keyable lower third
 * over NDI, plain text on stage — because the Look travels per output, not per
 * slide.
 *
 * state = {
 *   layers: { background, media, slide, announcement, props, messages, mask },
 *   cleared: { <layer>: bool },
 *   transitions: { <layer>: 'dissolve' | … },
 *   look, next, timers, message, easyView, drawing
 * }
 */
(function () {
  const params = new URLSearchParams(location.search);
  const role = params.get('role') === 'stage' ? 'stage' : 'audience';
  const outputId = params.get('id') || 'main';
  // 'fill' = picture on transparency, 'key' = its alpha as a white matte,
  // 'normal' = what the room sees. Set by whoever opened the window.
  const render = params.get('render') === 'fill' || params.get('alpha') === '1' ? 'fill'
    : params.get('render') === 'key' ? 'key' : 'normal';
  if (role === 'stage') document.body.classList.add('stage');
  // BOTH elements: a background on <html> is what paints the page canvas, so a
  // fill feed whose <body> alone was made transparent still went out solid.
  if (render !== 'normal') {
    document.body.classList.add('render-' + render);
    document.documentElement.classList.add('render-' + render);
  }
  document.title = role === 'stage' ? 'Stage Display' : ('Audience Output' + (outputId !== 'main' ? ' — ' + outputId : ''));

  const $ = (s) => document.querySelector(s);
  let state = { layers: {}, cleared: {}, transitions: {}, look: null };
  let stack = null;

  /* ---------------- audience ---------------- */
  function ensureStack() {
    if (stack) return stack;
    stack = window.Layers.createStack($('#stage'), {
      onNeedsPaint: (name, buf, content, look) => window.SlideRender.paintLayer(name, buf, content, look),
    });
    fitStage();
    return stack;
  }
  /**
   * Scale the 1920×1080 stage to the physical screen, letterboxing if needed —
   * then apply this output's display map on top.
   *
   * The map is what lets one cue survive real church rigs: a projector hung
   * sideways for a tall banner screen (rotate), an LED wall that is only part
   * of the output (target width/height + offset), and two projectors
   * overlapping to make one wide picture (edge blend).
   */
  function fitStage() {
    const box = $('#screen'), st = $('#stage');
    if (!box || !st) return;
    const m = activeMap();
    const rot = ((m.rotate || 0) % 360 + 360) % 360;
    const turned = rot === 90 || rot === 270;
    // The area the picture is allowed to land in, in screen pixels.
    const boxW = box.clientWidth || 1, boxH = box.clientHeight || 1;
    const areaW = (m.w > 0 ? m.w : boxW), areaH = (m.h > 0 ? m.h : boxH);
    // When the picture is turned, it has to fit the area's OTHER dimension.
    const fitW = turned ? areaH : areaW, fitH = turned ? areaW : areaH;
    const scale = Math.min(fitW / 1920, fitH / 1080) * (m.scale || 1);
    const drawW = 1920 * scale, drawH = 1080 * scale;
    const offX = (m.x || 0) + (areaW - (turned ? drawH : drawW)) / 2;
    const offY = (m.y || 0) + (areaH - (turned ? drawW : drawH)) / 2;
    // Rotate about the picture's own centre so the maths above stays readable.
    const cx = (turned ? drawH : drawW) / 2, cy = (turned ? drawW : drawH) / 2;
    st.style.transform = `translate(${Math.round(offX)}px,${Math.round(offY)}px)`
      + (rot ? ` translate(${cx}px,${cy}px) rotate(${rot}deg) translate(${-drawW / 2}px,${-drawH / 2}px)` : '')
      + ` scale(${scale})`;
    st.style.transformOrigin = '0 0';
    drawEdgeBlend(m);
  }

  /** This output's display map, whatever the studio last sent for it. */
  function activeMap() {
    const maps = state.outputMaps || {};
    return Object.assign({ rotate: 0, scale: 1, x: 0, y: 0, w: 0, h: 0, blend: null }, maps[outputId] || null);
  }

  /**
   * Multi-projector edge blending. Two projectors overlapping by N pixels each
   * fade to black across the overlap, so the seam disappears instead of being a
   * double-bright stripe. Gamma is exposed because the "right" ramp depends on
   * the projector, and the operator will nudge it until the join vanishes.
   */
  function drawEdgeBlend(m) {
    const b = m.blend || {};
    const sides = [['left', b.left], ['right', b.right], ['top', b.top], ['bottom', b.bottom]];
    let host = $('#blend');
    if (!sides.some(([, v]) => v > 0)) { if (host) host.remove(); return; }
    if (!host) {
      host = document.createElement('div');
      host.id = 'blend';
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:280;';
      document.getElementById('screen').appendChild(host);
    }
    const g = Math.max(0.2, Math.min(4, b.gamma || 1));
    // A gamma-shaped ramp, expressed as a handful of gradient stops.
    const stops = (from) => {
      const n = 12, out = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;                       // 0 at the screen edge
        const a = Math.pow(1 - t, g);          // 1 = fully black at the edge
        out.push(`rgba(0,0,0,${a.toFixed(3)}) ${(t * 100).toFixed(1)}%`);
      }
      return `linear-gradient(to ${from}, ${out.join(',')})`;
    };
    host.innerHTML = '';
    for (const [side, px] of sides) {
      if (!(px > 0)) continue;
      const el = document.createElement('div');
      const dir = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }[side];
      const size = side === 'left' || side === 'right' ? `width:${px}px;top:0;bottom:0;${side}:0;` : `height:${px}px;left:0;right:0;${side}:0;`;
      el.style.cssText = `position:absolute;${size}background:${stops(dir)};`;
      host.appendChild(el);
    }
  }

  /** This output's own Look, falling back to whatever the studio sent. */
  function activeLook() {
    return Object.assign({}, state.look, state.outputLook || null);
  }

  function drawAudience() {
    const s = ensureStack();
    const L = state.layers || {};
    const cleared = state.cleared || {};
    const tr = state.transitions || {};
    const look = activeLook();

    // Background and media are keyed on their VALUE, not on the whole state —
    // that is what keeps a motion loop playing (and in position) while the
    // lyrics above it change every few seconds.
    // A keyable feed carries the graphics ONLY. Sending the background too
    // would hand the switcher an opaque picture and there would be nothing to
    // key — so fill/key outputs drop the background layer at the source.
    const keyable = render !== 'normal';
    s.set('background', keyable ? null : (L.background || null), look, {
      transition: tr.background || 'dissolve',
      sig: keyable ? 'keyed' : (L.background ? [L.background.type, L.background.value, L.background.dim, L.background.speed].join('|') : 'none'),
    });
    s.set('media', L.media || null, look, {
      transition: tr.media || 'dissolve',
      sig: L.media ? [L.media.type, L.media.value, L.media.dim].join('|') : 'none',
    });
    s.set('slide', L.slide || null, look, { transition: tr.slide || 'dissolve' });
    s.set('announcement', L.announcement || null, look, { transition: tr.announcement || 'dissolve' });
    s.set('props', L.props || null, look, { transition: tr.props || 'dissolve' });
    s.set('mask', L.mask || null, look, { transition: tr.mask || 'dissolve' });
    // messages + timers share a layer; timers redraw every second below
    s.set('messages', { message: state.message || null, timers: liveTimers() }, look, {
      transition: tr.messages || 'dissolve',
      sig: JSON.stringify([state.message, (state.timers || []).map((t) => [t.id, t.mode, t.running, t.endsAt, t.startedAt, t.x, t.y, t.size, t.hidden])]),
    });

    for (const name of window.Layers.ORDER) s.clear(name, !!cleared[name]);
    syncVideoPlayback(L.background, L.media);
    // Blackout is deliberately NOT a clear: it's a hard curtain over everything,
    // and it must not lose the layers underneath (the video keeps playing, the
    // cue stays where it was) so bringing it back is instant. On a keyable feed
    // "black" means nothing to key, not a black rectangle, so it goes empty.
    $('#blackout').classList.toggle('on', !!state.blackout && !keyable);
    if (keyable) $('#screen').style.opacity = state.blackout ? '0' : '1';
    fitStage();
    drawEasyView();
  }
  const liveTimers = () => (state.timers || []).filter((t) => t && t.onOutput !== false);

  /**
   * Pause / play / loop, applied to the video ALREADY ON THE SCREEN.
   *
   * Playback deliberately sits outside the layer signature: repainting the
   * layer would rebuild the <video> element and send the picture back to frame
   * one, which is precisely what an operator pressing Pause does not want. So
   * the element that is already playing is reconciled in place.
   */
  function syncVideoPlayback(background, media) {
    for (const [name, m] of [['background', background], ['media', media]]) {
      if (!m || m.type !== 'video') continue;
      const host = document.querySelector('.lyr-' + name);
      const v = host && host.querySelector('video.lyr-video');
      if (!v) continue;
      const wantLoop = m.loop !== false && !m.pingpong;
      if (v.loop !== wantLoop) v.loop = wantLoop;
      if (m.paused && !v.paused) { try { v.pause(); } catch (e) {} }
      else if (!m.paused && v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
    }
  }

  /** Timers are the one thing that must repaint without a new cue. */
  function tickTimers() {
    const now = Date.now();
    document.querySelectorAll('.lyr-timer[data-timer]').forEach((el) => {
      const t = (state.timers || []).find((x) => x.id === el.dataset.timer);
      if (t) el.textContent = window.SlideRender.timerText(t, now);
    });
    const c = $('#svClock');
    if (c) c.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const st = $('#svTimer');
    if (st) {
      const t = (state.timers || []).find((x) => x && x.onStage !== false && x.mode !== 'clock');
      st.textContent = t ? window.SlideRender.timerText(t, now) : '';
      st.style.color = (t && t.mode === 'countdown' && (t.endsAt - now) < 30000) ? '#ff6b6b' : '#7f8ca6';
    }
  }

  /** Easy View — a high-contrast reader over everything (bound to ~ in the studio). */
  function drawEasyView() {
    let el = $('#easyview');
    const want = !!state.easyView && role === 'audience';
    if (!want) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'easyview'; el.className = 'lyr-easy';
      document.getElementById('screen').appendChild(el);
    }
    const sl = (state.layers || {}).slide;
    el.textContent = sl ? (sl.lines || []).join('\n') : '';
  }

  /* ---------------- stage display ---------------- */
  /**
   * The stage layout is data, not markup: a list of blocks the operator arranged
   * (current slide, next slide, clock, timer, notes, messages, multiviewer), so
   * a musician's monitor and the director's monitor can be laid out completely
   * differently from the same engine.
   */
  function drawStage() {
    const layout = state.stageLayout || DEFAULT_STAGE;
    const host = $('#stageview');
    host.innerHTML = '';
    host.style.display = 'grid';
    host.style.gridTemplateColumns = layout.cols || '1.7fr 1fr';
    host.style.gridTemplateRows = layout.rows || 'auto 1fr auto';
    for (const b of (layout.blocks || [])) {
      const el = document.createElement('div');
      el.className = 'sv-block sv-' + b.type;
      el.style.gridArea = b.area || 'auto';
      el.innerHTML = stageBlockHtml(b);
      host.appendChild(el);
    }
    drawMultiview();
    tickTimers();
  }

  /**
   * The director's multiviewer: a live picture of every audience output.
   *
   * Each cell re-renders the SAME state through the SAME painter with that
   * output's own Look, which is not an approximation of the screen — it is the
   * screen, drawn again at thumbnail size. That matters because the whole point
   * of Looks is that two outputs showing one cue can look completely different,
   * and a multiviewer that showed one generic preview would hide exactly the
   * mistake the director is watching for. It also costs nothing on the network.
   */
  function drawMultiview() {
    document.querySelectorAll('.sv-mv-cell[data-mvout]').forEach((cell) => {
      const id = cell.dataset.mvout;
      const pic = cell.querySelector('.sv-mv-pic');
      if (!pic) return;
      const look = Object.assign({}, state.look, (state.outputLooks || {})[id] || null);
      window.SlideRender.paintComposite(pic, state, look);
    });
  }
  const DEFAULT_STAGE = {
    cols: '1.7fr 1fr', rows: 'auto 1fr auto',
    blocks: [
      { type: 'header', area: '1 / 1 / 2 / 3' },
      { type: 'current', area: '2 / 1 / 3 / 2' },
      { type: 'next', area: '2 / 2 / 3 / 3' },
      { type: 'notes', area: '3 / 1 / 4 / 3' },
    ],
  };
  function stageBlockHtml(b) {
    const L = state.layers || {};
    const s = L.slide;
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    if (b.type === 'header') {
      return `<div class="sv-head"><span class="sv-label">${esc((s && s.group) || 'Stage Display')}</span>`
        + `<span><span class="sv-clock" id="svClock">--:--</span><span class="sv-timer" id="svTimer"></span></span></div>`;
    }
    if (b.type === 'current') {
      if ((state.cleared || {}).slide || !s || !(s.lines || []).join('').trim()) {
        return `<div class="sv-current"><div class="sv-blank">${(state.cleared || {}).slide ? 'Cleared' : 'Ready'}</div></div>`;
      }
      const text = (s.lines || []).join('\n');
      const cls = text.length > 260 ? 'tiny' : text.length > 130 ? 'small' : '';
      const chords = (b.chords !== false && s.chords) ? chordHtml(s) : '';
      return `<div class="sv-current"><div>${chords || `<div class="sv-text ${cls}">${esc(text)}</div>`}`
        + (s.footer ? `<div class="sv-footer">${esc(s.footer)}</div>` : '') + '</div></div>';
    }
    if (b.type === 'next') {
      const n = state.next;
      return `<div class="sv-next"><div class="sv-next-label">Next</div><div class="sv-next-body">`
        + (n && (n.lines || []).join(' ').trim() ? `${n.group ? esc(n.group) + ' — ' : ''}${esc((n.lines || []).join(' '))}` : '—')
        + '</div></div>';
    }
    if (b.type === 'notes') {
      const note = (s && s.notes) || '';
      const msg = state.stageMessage || '';
      return (msg ? `<div class="sv-msg">${esc(msg)}</div>` : '')
        + (note ? `<div class="sv-notes">${esc(note)}</div>` : '');
    }
    if (b.type === 'clock') return `<div class="sv-bigclock" id="svClock">--:--</div>`;
    if (b.type === 'timer') {
      const t = (state.timers || [])[0];
      return `<div class="sv-bigtimer lyr-timer" data-timer="${t ? esc(t.id) : ''}">${t ? window.SlideRender.timerText(t, Date.now()) : '--:--'}</div>`;
    }
    if (b.type === 'multiview') {
      // Filled in after the block is in the DOM — the cells hold real pictures,
      // not labels (see drawMultiview).
      const outs = (state.outputs || []).filter((o) => o.role !== 'stage');
      return '<div class="sv-mv" data-mv="1">' + (outs.length
        ? outs.map((o) => `<div class="sv-mv-cell" data-mvout="${esc(o.id)}"><div class="sv-mv-pic"></div><span class="sv-mv-name">${esc(o.name)}</span></div>`).join('')
        : '<div class="sv-blank">No outputs</div>') + '</div>';
    }
    return '';
  }
  /** Chords above the words, for a musician's monitor. */
  function chordHtml(s) {
    if (!s.chords || !s.chords.some((r) => r && r.length)) return '';
    const esc = (x) => String(x == null ? '' : x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return '<div class="sv-chordlines">' + (s.lines || []).map((l, i) => {
      const row = (s.chords[i] || []);
      const spans = row.map((c) => `<span style="position:absolute;left:${(c.at * 0.55).toFixed(2)}em">${esc(c.chord)}</span>`).join('');
      return `<div class="sv-chordline"><div class="sv-chordrow">${spans}</div><div class="sv-lyricrow">${esc(l) || '&nbsp;'}</div></div>`;
    }).join('') + '</div>';
  }

  function draw() {
    if (role === 'stage') drawStage();
    else drawAudience();
  }

  /* ---------------- wiring ---------------- */
  window.SlideRender.injectCss(document);
  window.Layers.injectCss(document);
  if (window.api && window.api.present && window.api.present.onState) {
    window.api.present.onState((s) => {
      if (!s) return;
      // an output-specific Look overrides the global one for THIS screen only
      if (s.outputLooks && s.outputLooks[outputId] !== undefined) s.outputLook = s.outputLooks[outputId];
      state = Object.assign({}, state, s);
      draw();
    });
  }
  setInterval(tickTimers, 250);
  window.addEventListener('resize', draw);
  draw();
})();
