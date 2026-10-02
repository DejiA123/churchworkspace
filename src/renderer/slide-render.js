'use strict';
/*
 * ONE slide renderer, used by three places: the slide thumbnails in the studio,
 * the operator's live/preview monitors, and the actual projector window.
 *
 * Everything is laid out on a fixed 1920×1080 "stage" and then scaled with a CSS
 * transform to whatever box it has to live in. That is the whole trick: a
 * 160 px thumbnail, the 400 px preview and a 4K projector are then the SAME
 * layout at different scales, so what the operator sees really is what the
 * congregation gets — line breaks and all. Sizing with vw/vh instead would let
 * a long line wrap differently on the projector than in the preview, which is
 * exactly the surprise you cannot afford mid-service.
 */
(function () {
  const STAGE_W = 1920, STAGE_H = 1080;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  /*
   * A path from the operator's disk, turned into a URL that survives being
   * written into CSS and into an HTML attribute.
   *
   * encodeURI leaves both quote characters alone, and church files are called
   * things like "Sunday's welcome slide.png". Dropped into
   * `background-image:url('…')` that apostrophe closes the string, the whole
   * declaration is discarded, and the picture silently does not appear — which
   * is a large part of "I cannot add images, it doesn't work". # and ? have to
   * go for the ordinary reason (fragment and query), and both quotes go with
   * them.
   */
  /*
   * A path from the operator's disk becomes a file: URL; a path that belongs to
   * the APP is left exactly as it is.
   *
   * That second case is not a nicety: `assets/bgvideos/139046.jpg` run through
   * the file: branch comes out as `file:///assets/bgvideos/139046.jpg` — the
   * root of the drive — and the poster silently fails to load. Anything with a
   * drive letter (C:\…), a leading slash or a scheme is a real location;
   * everything else is relative to the page and already correct.
   */
  const isAppAsset = (p) => !/^([a-z]:[\\/]|[\\/]|[a-z][a-z0-9+.-]*:)/i.test(String(p));
  const fileUrl = (p) => (/^(file|https?|data|blob):/i.test(p) || isAppAsset(p)) ? p
    : 'file:///' + encodeURI(String(p).replace(/\\/g, '/'))
      .replace(/#/g, '%23').replace(/\?/g, '%3F')
      .replace(/'/g, '%27').replace(/"/g, '%22');

  const DEFAULT_THEME = {
    id: 'default', name: 'Default',
    font: 'Poppins', sizePx: 96, color: '#ffffff', bold: true, italic: false,
    align: 'center', valign: 'center',
    shadow: 0.55, outline: 0, outlineColor: '#000000',
    allCaps: false, lineHeight: 1.2, letterSpacing: 0,
    bg: { type: 'color', value: '#000000', fit: 'cover' },
    padX: 140, padY: 100,
    showFooter: true, footerSize: 42, footerColor: '#ffd479',
    fadeMs: 320,
  };
  const theme = (t) => Object.assign({}, DEFAULT_THEME, t || {}, { bg: Object.assign({}, DEFAULT_THEME.bg, (t && t.bg) || {}) });

  /* ---------------- background ---------------- */
  /** CSS for the background layer. Video is handled separately (needs an element). */
  function bgStyle(bg) {
    const b = bg || DEFAULT_THEME.bg;
    if (b.type === 'image' && b.value) {
      return `background-image:url("${fileUrl(b.value)}");background-size:${b.fit === 'contain' ? 'contain' : 'cover'};`
        + 'background-position:center;background-repeat:no-repeat;background-color:#000;';
    }
    if (b.type === 'gradient' && b.value) return `background:${b.value};`;
    if (b.type === 'video') return 'background:#000;';
    return `background:${b.value || '#000000'};`;
  }

  /* ---------------- text ---------------- */
  function textStyle(t) {
    const shadow = t.shadow > 0
      ? `text-shadow:0 ${Math.round(t.sizePx * 0.045)}px ${Math.round(t.sizePx * 0.09)}px rgba(0,0,0,${t.shadow.toFixed(2)}), 0 0 ${Math.round(t.sizePx * 0.05)}px rgba(0,0,0,${(t.shadow * 0.7).toFixed(2)});`
      : '';
    const outline = t.outline > 0
      ? `-webkit-text-stroke:${(t.sizePx * 0.012 * t.outline).toFixed(2)}px ${t.outlineColor};paint-order:stroke fill;`
      : '';
    return `font-family:${cssFont(t.font)};font-size:${t.sizePx}px;color:${t.color};`
      + `font-weight:${t.bold ? 800 : 400};font-style:${t.italic ? 'italic' : 'normal'};`
      + `line-height:${t.lineHeight};letter-spacing:${t.letterSpacing}px;`
      + `text-transform:${t.allCaps ? 'uppercase' : 'none'};text-align:${t.align};`
      + shadow + outline;
  }
  function cssFont(f) {
    if (!f || f === 'Arial') return 'Arial, Helvetica, sans-serif';
    return `'${f}', 'Segoe UI', Arial, sans-serif`;
  }
  const JUSTIFY = { top: 'flex-start', center: 'center', bottom: 'flex-end' };
  const ALIGNI = { left: 'flex-start', center: 'center', right: 'flex-end' };

  /**
   * Build the stage markup for one slide.
   * slide: { lines:[], footer, bg?, theme? }  — per-slide bg/theme win over the look.
   */
  function stageHtml(slide, look, opts = {}) {
    const s = slide || {};
    const t = theme(Object.assign({}, look, s.theme));
    let bg = s.bg && s.bg.type ? Object.assign({}, t.bg, s.bg) : t.bg;
    /*
     * A THUMBNAIL NEVER DECODES VIDEO.
     *
     * Twenty slides sharing one motion background used to mean twenty <video>
     * elements playing the same file in a 200px grid — on a two-core laptop
     * that is the whole machine, spent on pictures nobody is watching. When a
     * video background carries a poster (every one from the built-in collection
     * does) the grid paints the poster instead; the projector, which is the
     * only screen that matters, still plays the real thing.
     */
    if (opts.still && bg.type === 'video') {
      bg = bg.poster
        ? Object.assign({}, bg, { type: 'image', value: bg.poster })
        : Object.assign({}, bg, { type: 'color', value: '#0a0d14' });
    }
    const lines = (s.lines || []).filter((l) => l != null);
    const body = lines.length
      ? `<div class="sr-text" style="${esc(textStyle(t))}">${lines.map((l) => `<div class="sr-line">${esc(l) || '&nbsp;'}</div>`).join('')}</div>`
      : '';
    const footer = (t.showFooter && s.footer)
      ? `<div class="sr-footer" style="font-family:${cssFont(t.font)};font-size:${t.footerSize}px;color:${t.footerColor};`
        + `text-align:${t.align};${t.shadow > 0 ? 'text-shadow:0 2px 8px rgba(0,0,0,.8);' : ''}">${esc(s.footer)}</div>`
      : '';
    const video = bg.type === 'video' && bg.value
      ? `<video class="sr-bgvideo" src="${esc(fileUrl(bg.value))}" autoplay loop muted playsinline
           style="object-fit:${bg.fit === 'contain' ? 'contain' : 'cover'}"></video>`
      : '';
    /*
     * WHY THE STYLE IS ESCAPED, and why "I added images but the slide is blank".
     *
     * bgStyle emits `background-image:url("file:///…")` — with double quotes,
     * because a path can contain almost anything. Dropped raw into
     * `style="…"` that first inner quote CLOSES the attribute: the browser
     * keeps `background-image:url(` , throws the rest away as stray attributes,
     * and paints nothing. The slide goes black and says nothing, which is
     * exactly the report.
     *
     * Colours and gradients carry no quotes, so they were unaffected — which is
     * why the ready-made backgrounds always worked and a church's own photo
     * never did. (The ready-made grid in present.js escapes this correctly
     * already; the slide renderer, which paints every thumbnail and monitor,
     * did not.)
     */
    /*
     * MOTION, without a single video file.
     *
     * "Moving backgrounds" normally means shipping loops — hundreds of
     * megabytes, licensing, and a decode running behind every slide. A slow
     * drift or push on a still image gives a room the same sense of life for
     * nothing: it is one CSS animation on a layer that is already there, it
     * works on the built-in scenes AND on a church's own photograph, and it
     * costs no download. The moves are deliberately slow (30-45s) and small —
     * anything faster competes with the words instead of sitting behind them.
     */
    const motion = bg.motion && MOTIONS[bg.motion] ? ` sr-bg-${bg.motion}` : '';
    return `<div class="sr-bg${motion}" style="${esc(bgStyle(bg))}">${video}</div>`
      + (bg.dim ? `<div class="sr-dim" style="background:rgba(0,0,0,${Number(bg.dim).toFixed(2)})"></div>` : '')
      + `<div class="sr-body" style="padding:${t.padY}px ${t.padX}px;justify-content:${JUSTIFY[t.valign] || 'center'};align-items:${ALIGNI[t.align] || 'center'}">`
      + body + footer + '</div>';
  }

  /* The slow moves a background can make. Scale is always ≥1 so an edge can
   * never drift into view as a black bar, and every one of them returns to
   * where it started so a background that loops for an hour never creeps. */
  const MOTIONS = {
    drift: 'sr-drift 42s ease-in-out infinite',
    push:  'sr-push 38s ease-in-out infinite',
    sway:  'sr-sway 30s ease-in-out infinite',
    breathe: 'sr-breathe 24s ease-in-out infinite',
  };
  const MOTION_NAMES = { drift: 'Drift', push: 'Slow push', sway: 'Sway', breathe: 'Breathe' };

  /** The CSS both the studio and the projector need. Injected once per document. */
  const CSS = `
    ${Object.entries(MOTIONS).map(([k, v]) => `.sr-bg-${k} { animation: ${v}; will-change: transform; }`).join('\n    ')}
    @keyframes sr-drift {
      0%   { transform: scale(1.10) translate(0, 0); }
      50%  { transform: scale(1.14) translate(-1.6%, -1.2%); }
      100% { transform: scale(1.10) translate(0, 0); }
    }
    @keyframes sr-push {
      0%   { transform: scale(1.00); }
      50%  { transform: scale(1.12); }
      100% { transform: scale(1.00); }
    }
    @keyframes sr-sway {
      0%   { transform: scale(1.08) translateX(0); }
      50%  { transform: scale(1.08) translateX(-2.2%); }
      100% { transform: scale(1.08) translateX(0); }
    }
    @keyframes sr-breathe {
      0%   { transform: scale(1.04); opacity: .94; }
      50%  { transform: scale(1.09); opacity: 1; }
      100% { transform: scale(1.04); opacity: .94; }
    }
    /* A projector in a hall must never stutter for the sake of decoration: if
       the operator's machine asks for less motion, it stops. */
    @media (prefers-reduced-motion: reduce) {
      ${Object.keys(MOTIONS).map((k) => `.sr-bg-${k}`).join(', ')} { animation: none; }
    }
  ` + `
    /* ABSOLUTE, not relative. The stage is a real 1920x1080 box that we scale
       with a transform — and a transform does not change layout size. Left in
       the normal flow it forces every container that holds it (a 160px
       thumbnail, the 330px side panel) to be 1920px wide, which quietly blows
       the whole three-column layout apart. Taking it out of flow means the
       container keeps its own size and the stage just paints inside it. */
    .sr-stage { position:absolute; top:0; left:0; width:${STAGE_W}px; height:${STAGE_H}px; overflow:hidden;
      transform-origin:0 0; background:#000; }
    .sr-bg { position:absolute; inset:0; }
    .sr-bgvideo { position:absolute; inset:0; width:100%; height:100%; }
    .sr-dim { position:absolute; inset:0; }
    .sr-body { position:absolute; inset:0; display:flex; flex-direction:column; }
    .sr-text { width:100%; max-width:100%; word-wrap:break-word; overflow-wrap:break-word; }
    .sr-line { white-space:pre-wrap; }
    .sr-footer { width:100%; margin-top:0.55em; opacity:.94; }
    .sr-fade { transition:opacity var(--sr-fade,320ms) ease; }
  `;
  function injectCss(doc) {
    const d = doc || document;
    if (d.getElementById('sr-css')) return;
    const st = d.createElement('style');
    st.id = 'sr-css'; st.textContent = CSS;
    d.head.appendChild(st);
  }

  /** Scale a 1920×1080 stage to fit `box` (an element), letterboxing as needed. */
  /* `size` lets a caller that is fitting many identically-sized boxes measure
   * one of them and pass the answer in. Without it, painting a grid alternates
   * a layout READ (clientWidth) with a layout WRITE (the transform) for every
   * thumbnail, and each read after a write forces a fresh synchronous layout —
   * eighty of them, for eighty boxes that are all exactly the same size. */
  function fit(stageEl, box, size) {
    if (!stageEl || !box) return 1;
    const w = (size ? size.w : box.clientWidth) || 1, h = (size ? size.h : box.clientHeight) || 1;
    const scale = Math.min(w / STAGE_W, h / STAGE_H);
    stageEl.style.transform = `translate(${Math.round((w - STAGE_W * scale) / 2)}px,${Math.round((h - STAGE_H * scale) / 2)}px) scale(${scale})`;
    return scale;
  }

  /**
   * Shrink the body text until it fits inside the stage.
   *
   * ProPresenter calls this "shrink to fit" and it is not optional: a four-line
   * verse of Psalm 119 at the same size as a two-word chorus line runs straight
   * off the bottom of the screen. Measured in real layout (not estimated from
   * character counts) because fonts, wrapping and line-height all matter.
   */
  function shrinkToFit(stageEl, look) {
    const text = stageEl.querySelector('.sr-text');
    const body = stageEl.querySelector('.sr-body');
    if (!text || !body) return;
    const t = theme(look);
    const avail = STAGE_H - t.padY * 2 - (stageEl.querySelector('.sr-footer') ? t.footerSize * 2.1 : 0);
    let size = t.sizePx;
    // fast geometric shrink, then a couple of refining steps — 8-10 reflows worst
    // case on a 1920-wide box, which is nothing next to a frame budget
    let guard = 24;
    while (text.scrollHeight > avail && size > 18 && guard-- > 0) {
      size = Math.max(18, Math.floor(size * (text.scrollHeight > avail * 1.6 ? 0.78 : 0.93)));
      text.style.fontSize = size + 'px';
    }
    return size;
  }

  /* ==================== not repainting ====================
   *
   * The studio repaints the whole slide grid for reasons that have nothing to
   * do with the slides — a selection moved, a cue went out, a letter was typed
   * into slide 3. Eighty thumbnails were being torn down and rebuilt each
   * time, and every rebuild ran shrinkToFit, whose measure-shrink-measure loop
   * forces a synchronous layout of a 1920-wide stage up to twenty-four times.
   * Eighty of those is roughly a tenth of a second of frozen window, and the
   * editor did it twice per keystroke.
   *
   * So a painted stage remembers WHAT it was painted from. Ask for the same
   * picture again and it is left alone — no HTML, no reflow, not even a
   * transform. The only thing that repaints is the thing that changed.
   *
   * The signature deliberately covers everything stageHtml() and shrinkToFit()
   * read: if a value can change the picture, changing it must change the key.
   */
  /* A signature that cannot be computed is not a signature: anything unexpected
   * falls back to a unique value, i.e. "repaint", which is the old behaviour. */
  let sigMiss = 0;
  function sigOf(parts) {
    try { return JSON.stringify(parts); } catch (e) { return ' nosig' + (++sigMiss); }
  }
  /* `opts.lookSig` lets a caller that is painting a whole grid stringify the
   * shared Look once instead of once per slide — the Look is by far the biggest
   * part of the key and it is identical for every thumbnail. */
  function paintSig(slide, look, opts) {
    const s = slide || {};
    return sigOf([
      s.lines, s.footer, s.bg, s.theme, s.label, s.group,
      opts.lookSig != null ? opts.lookSig : look,
      !!opts.still, opts.shrink !== false, !!opts.noVideo,
    ]);
  }
  /* How many stages have actually been rebuilt. The point of everything above
   * is that this number stays small, so it is countable. */
  const repaints = { slides: 0, composites: 0 };

  /* Shrink-to-fit is pure: the same words at the same size on the same fixed
   * 1920x1080 stage always land on the same font size, whatever size box the
   * thumbnail is drawn into. So the answer is worth keeping — a re-render of a
   * deck that has been rendered before costs no reflows at all. */
  const SHRINK_CACHE = new Map();
  const SHRINK_CACHE_MAX = 600;
  function shrinkCached(stage, look, slide, sig) {
    const hit = SHRINK_CACHE.get(sig);
    if (hit != null) {
      const text = stage.querySelector('.sr-text');
      if (text) text.style.fontSize = hit + 'px';
      return hit;
    }
    const size = shrinkToFit(stage, Object.assign({}, look, slide && slide.theme));
    if (size != null) {
      if (SHRINK_CACHE.size >= SHRINK_CACHE_MAX) SHRINK_CACHE.clear();
      SHRINK_CACHE.set(sig, size);
    }
    return size;
  }

  /**
   * Paint a slide into a container, scaled to fit it.
   * Returns the stage element (already in the container).
   */
  function paint(container, slide, look, opts = {}) {
    if (!container) return null;
    injectCss(container.ownerDocument);
    let stage = container.querySelector(':scope > .sr-stage');
    const sig = paintSig(slide, look, opts);
    // Read the box BEFORE writing anything — or better, don't read it at all:
    // a caller painting a grid has already measured one box for all of them.
    const cw = opts.box ? opts.box.w : container.clientWidth;
    const ch = opts.box ? opts.box.h : container.clientHeight;
    if (stage && stage.__srSig === sig) {
      if (stage.__srW !== cw || stage.__srH !== ch) { fit(stage, container, { w: cw, h: ch }); stage.__srW = cw; stage.__srH = ch; }
      return stage;
    }
    if (!stage) {
      stage = container.ownerDocument.createElement('div');
      stage.className = 'sr-stage';
      container.appendChild(stage);
    }
    repaints.slides++;
    stage.innerHTML = stageHtml(slide, look, opts);
    if (opts.shrink !== false) shrinkCached(stage, look, slide, sig);
    fit(stage, container, { w: cw, h: ch });
    stage.__srSig = sig; stage.__srW = cw; stage.__srH = ch;
    return stage;
  }

  /* ==================== per-layer painters ====================
   * The layer engine (layers.js) decides WHEN a layer changes and HOW it
   * transitions; these decide what each layer actually looks like. Shared by
   * the projector and by the studio's preview monitors so they cannot drift. */

  /** Background / foreground media: colour, gradient, still or looping video. */
  /** The non-destructive colour adjustments a switcher offers, as a CSS filter. */
  function adjustFilter(m) {
    const adj = [];
    if (m.brightness != null && m.brightness !== 1) adj.push(`brightness(${m.brightness})`);
    if (m.contrast != null && m.contrast !== 1) adj.push(`contrast(${m.contrast})`);
    if (m.saturation != null && m.saturation !== 1) adj.push(`saturate(${m.saturation})`);
    if (m.hue) adj.push(`hue-rotate(${m.hue}deg)`);
    if (m.blur) adj.push(`blur(${m.blur}px)`);
    return adj.join(' ');
  }

  function paintMedia(buf, m, look) {
    if (!m || !m.type) return;
    const fit = m.fit === 'contain' ? 'contain' : 'cover';
    // A live camera or a captured screen behaves like any other background: the
    // lyrics and lower thirds sit over it unchanged. The stream is attached
    // asynchronously, so the layer paints black for a frame and then fills in.
    if (m.type === 'camera' || m.type === 'screen') {
      const v = buf.ownerDocument.createElement('video');
      v.className = 'lyr-video';
      v.autoplay = true; v.muted = true; v.playsInline = true;
      v.style.objectFit = fit;
      const filt = adjustFilter(m);
      if (filt) v.style.filter = filt;
      // Chroma keying has to happen per pixel, so the camera goes through a
      // shader instead of straight onto the page (see chromaKey).
      const keyed = m.chroma && m.chroma.on;
      if (keyed) v.style.display = 'none';
      buf.appendChild(v);
      const want = m.type === 'screen'
        ? { video: { width: { ideal: 1920 } }, audio: false }
        : { video: m.value ? { deviceId: { exact: m.value } } : true, audio: false };
      const get = m.type === 'screen'
        ? navigator.mediaDevices.getDisplayMedia(want)
        : navigator.mediaDevices.getUserMedia(want);
      get.then((stream) => {
        v.srcObject = stream;
        // stop the tracks when this buffer is recycled, or the camera light
        // stays on for the rest of the service
        buf._stopStream = () => { try { stream.getTracks().forEach((t) => t.stop()); } catch (e) {} };
        const p = v.play(); if (p && p.catch) p.catch(() => {});
        if (keyed) chromaKey(buf, v, m.chroma, fit);
      }).catch(() => {});
      return;
    }
    // A YouTube or Vimeo link plays straight from the page — no downloading the
    // file first, no second browser window dragged onto the projector. This is
    // the one thing every volunteer asks for on a Saturday night.
    if (m.type === 'youtube' || m.type === 'vimeo') {
      const src = embedUrl(m);
      if (!src) return;
      const f = buf.ownerDocument.createElement('iframe');
      f.className = 'lyr-embed';
      f.src = src;
      f.setAttribute('frameborder', '0');
      f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
      f.setAttribute('allowfullscreen', '');
      f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
      const filt = adjustFilter(m);
      if (filt) f.style.filter = filt;
      buf.appendChild(f);
      return;
    }
    if (m.type === 'video') {
      const v = buf.ownerDocument.createElement('video');
      v.className = 'lyr-video';
      v.src = fileUrl(m.value) + (m.inSec ? `#t=${m.inSec}` : '');
      v.autoplay = !m.paused; v.loop = m.loop !== false && !m.pingpong; v.muted = m.muted !== false; v.playsInline = true;
      v.style.objectFit = fit;
      const filt = adjustFilter(m);
      if (filt) v.style.filter = filt;
      if (m.speed) v.playbackRate = Math.max(0.1, Math.min(4, m.speed));
      buf.appendChild(v);
      trimAndLoop(v, m);
      const keyed = m.chroma && m.chroma.on;
      if (keyed) { v.style.display = 'none'; v.addEventListener('loadeddata', () => chromaKey(buf, v, m.chroma, fit), { once: true }); }
      // A window opened DURING a pause must come up paused too — otherwise
      // plugging the projector in mid-service restarts the loop.
      const go = () => { if (m.paused) { try { v.pause(); } catch (e) {} return; } const p = v.play(); if (p && p.catch) p.catch(() => {}); };
      v.addEventListener('canplay', go, { once: true }); go();
    } else if (m.type === 'image') {
      const d = buf.ownerDocument.createElement('div');
      d.className = 'lyr-img';
      d.style.cssText = `background-image:url("${fileUrl(m.value)}");background-size:${fit};`
        + 'background-position:center;background-repeat:no-repeat;';
      buf.appendChild(d);
    } else {
      const d = buf.ownerDocument.createElement('div');
      d.className = 'lyr-img';
      d.style.cssText = bgStyle(m);
      buf.appendChild(d);
    }
    if (m.dim) {
      const dim = buf.ownerDocument.createElement('div');
      dim.className = 'lyr-img';
      dim.style.background = `rgba(0,0,0,${Number(m.dim).toFixed(2)})`;
      buf.appendChild(dim);
    }
  }

  /* ------------------------ YouTube / Vimeo playback ----------------------- */
  /** The id out of any of the shapes people actually paste. */
  function videoId(url, kind) {
    const u = String(url || '').trim();
    if (kind === 'vimeo') {
      const m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/) || u.match(/^(\d+)$/);
      return m ? m[1] : null;
    }
    const m = u.match(/[?&]v=([\w-]{6,})/)            // watch?v=
      || u.match(/youtu\.be\/([\w-]{6,})/)            // short link
      || u.match(/youtube\.com\/(?:embed|shorts|live)\/([\w-]{6,})/)
      || u.match(/^([\w-]{11})$/);                    // a bare id
    return m ? m[1] : null;
  }
  /**
   * An embed URL with the player stripped back to a projector: no chrome, no
   * "watch on YouTube", no related videos at the end. `mute=1` is not optional —
   * browsers refuse to autoplay a video with sound, and a background loop that
   * needs a click is useless in front of a congregation.
   */
  function embedUrl(m) {
    const id = videoId(m.value, m.type);
    if (!id) return null;
    const loop = m.loop !== false ? 1 : 0;
    const muted = m.muted === false ? 0 : 1;
    const start = Math.max(0, Math.round(m.inSec || 0));
    if (m.type === 'vimeo') {
      return `https://player.vimeo.com/video/${id}?autoplay=1&muted=${muted}&loop=${loop}`
        + `&background=${m.chrome === true ? 0 : 1}&title=0&byline=0&portrait=0${start ? '#t=' + start + 's' : ''}`;
    }
    return `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=${muted}&controls=${m.chrome === true ? 1 : 0}`
      + `&loop=${loop}&playlist=${id}&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&fs=0&disablekb=1`
      + (start ? `&start=${start}` : '');
  }

  /* --------------------------- trim & ping-pong ---------------------------- */
  /**
   * In/out points and a ping-pong loop, without touching the file. Ping-pong
   * matters for short motion backgrounds: a 6-second loop that cuts back to the
   * start is visibly jarring behind lyrics, while playing it forwards then
   * backwards is seamless.
   */
  function trimAndLoop(v, m) {
    const inS = Math.max(0, m.inSec || 0);
    const outS = m.outSec > inS ? m.outSec : 0;
    if (!inS && !outS && !m.pingpong) return;
    let back = false;
    if (inS) v.addEventListener('loadedmetadata', () => { try { v.currentTime = inS; } catch (e) {} }, { once: true });
    v.addEventListener('timeupdate', () => {
      const end = outS || v.duration || 0;
      if (!end) return;
      if (!back && v.currentTime >= end - 0.05) {
        if (m.pingpong) { back = true; reverse(v, inS, end, m); }
        else { try { v.currentTime = inS; } catch (e) {} }
      }
    });
    // Media elements can't play backwards, so the reverse leg is stepped by the
    // same clock that drives everything else on the page.
    function reverse(el, from, to, mm) {
      const rate = Math.max(0.1, Math.min(4, mm.speed || 1));
      el.pause();
      let last = performance.now();
      const step = (now) => {
        if (!back || !el.isConnected) return;
        const dt = (now - last) / 1000; last = now;
        let t = el.currentTime - dt * rate;
        if (t <= from) { back = false; try { el.currentTime = from; } catch (e) {} const p = el.play(); if (p && p.catch) p.catch(() => {}); return; }
        try { el.currentTime = t; } catch (e) {}
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  /* ------------------------------ chroma key ------------------------------- */
  /**
   * Real per-pixel chroma keying for a camera, a capture card or a video file —
   * the green-screen the drama team filmed on, or a lyric video with a green
   * background, dropped straight over the motion loop.
   *
   * It runs as a WebGL shader rather than canvas getImageData because a 1080p
   * frame is two million pixels: on the CPU that is a slideshow, on the GPU it
   * is free. The maths is the standard similarity / smoothness / spill model an
   * operator already knows from OBS, so the numbers mean what they expect.
   */
  function chromaKey(buf, video, cfg, fit) {
    const doc = buf.ownerDocument;
    const cv = doc.createElement('canvas');
    cv.className = 'lyr-video';
    cv.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};`;
    buf.appendChild(cv);
    const gl = cv.getContext('webgl', { premultipliedAlpha: false, alpha: true });
    if (!gl) { video.style.display = ''; cv.remove(); return null; }  // no GPU: show it un-keyed rather than nothing

    const vs = `attribute vec2 p; varying vec2 uv;
      void main(){ uv = vec2(p.x*0.5+0.5, 0.5-p.y*0.5); gl_Position = vec4(p,0.0,1.0); }`;
    const fs = `precision mediump float; varying vec2 uv;
      uniform sampler2D tex; uniform vec3 keyc; uniform float sim, smoo, spill;
      // distance in chroma only, so shadows and highlights on the screen don't
      // punch holes in the subject the way an RGB distance would
      vec2 cbcr(vec3 c){ return vec2(-0.169*c.r-0.331*c.g+0.5*c.b, 0.5*c.r-0.419*c.g-0.081*c.b); }
      void main(){
        vec4 px = texture2D(tex, uv);
        float d = distance(cbcr(px.rgb), cbcr(keyc));
        float a = smoothstep(sim, sim + smoo, d);
        // de-spill: pull the keyed hue back out of the edges that survive
        float m = max(px.r, max(px.g, px.b));
        vec3 rgb = mix(px.rgb, vec3(dot(px.rgb, vec3(0.2126,0.7152,0.0722))), spill * (1.0 - a) * step(0.001, m));
        gl_FragColor = vec4(rgb, a * px.a);
      }`;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog); gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

    const rgb = hexRgb(cfg.color || '#00b140');   // 3200-series green, the usual studio paint
    gl.uniform3f(gl.getUniformLocation(prog, 'keyc'), rgb[0], rgb[1], rgb[2]);
    gl.uniform1f(gl.getUniformLocation(prog, 'sim'), cfg.similarity == null ? 0.16 : cfg.similarity);
    gl.uniform1f(gl.getUniformLocation(prog, 'smoo'), cfg.smoothness == null ? 0.08 : cfg.smoothness);
    gl.uniform1f(gl.getUniformLocation(prog, 'spill'), cfg.spill == null ? 0.5 : cfg.spill);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let raf = 0;
    const draw = () => {
      if (!cv.isConnected) return;                    // the buffer was recycled
      const w = video.videoWidth, h = video.videoHeight;
      if (w && h) {
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; gl.viewport(0, 0, w, h); }
        try {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        } catch (e) {}
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    const prev = buf._stopStream;
    buf._stopStream = () => { cancelAnimationFrame(raf); if (prev) prev(); };
    return cv;
  }
  function hexRgb(hex) {
    const h = String(hex || '').replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /** The lyrics / verse layer — the slide body with NO background of its own. */
  function paintSlide(buf, slide, look) {
    const t = theme(Object.assign({}, look, slide && slide.theme));
    const lines = (slide && slide.lines) || [];
    const chords = (slide && slide.chords) || null;
    const body = lines.length
      ? `<div class="sr-text" style="${esc(textStyle(t))}">${lines.map((l, i) => lineHtml(l, chords && chords[i], t)).join('')}</div>`
      : '';
    const footer = (t.showFooter && slide && slide.footer)
      ? `<div class="sr-footer" style="font-family:${cssFont(t.font)};font-size:${t.footerSize}px;color:${t.footerColor};`
        + `text-align:${t.align};text-shadow:0 2px 8px rgba(0,0,0,.8);">${esc(slide.footer)}</div>` : '';
    const d = buf.ownerDocument.createElement('div');
    d.className = 'sr-body';
    d.style.cssText = `position:absolute;inset:0;display:flex;flex-direction:column;`
      + `padding:${t.padY}px ${t.padX}px;justify-content:${JUSTIFY[t.valign] || 'center'};align-items:${ALIGNI[t.align] || 'center'};`;
    d.innerHTML = body + footer;
    buf.appendChild(d);
    shrinkBody(d, t);
  }
  /** One lyric line, optionally with its ChordPro chords floating above it. */
  function lineHtml(line, chordRow, t) {
    if (!chordRow || !chordRow.length) return `<div class="sr-line">${esc(line) || '&nbsp;'}</div>`;
    // Chords sit in a relatively-positioned strip above the words, anchored by
    // character offset — that's what a musician needs on a stage monitor.
    const chordSize = Math.round(t.sizePx * 0.52);
    const spans = chordRow.map((c) =>
      `<span style="position:absolute;left:${(c.at * 0.55).toFixed(2)}em;white-space:nowrap">${esc(c.chord)}</span>`).join('');
    return `<div class="sr-line" style="position:relative;padding-top:${Math.round(chordSize * 1.15)}px">`
      + `<span style="position:absolute;top:0;left:0;right:0;height:${chordSize}px;font-size:${chordSize}px;`
      + `font-weight:700;color:${t.chordColor || '#ffd479'};text-align:left;">${spans}</span>`
      + `${esc(line) || '&nbsp;'}</div>`;
  }
  function shrinkBody(bodyEl, t) {
    const text = bodyEl.querySelector('.sr-text'); if (!text) return;
    const avail = STAGE_H - t.padY * 2 - (bodyEl.querySelector('.sr-footer') ? t.footerSize * 2.1 : 0);
    let size = t.sizePx, guard = 24;
    while (text.scrollHeight > avail && size > 18 && guard-- > 0) {
      size = Math.max(18, Math.floor(size * (text.scrollHeight > avail * 1.6 ? 0.78 : 0.93)));
      text.style.fontSize = size + 'px';
    }
  }

  /** Props: persistent logos / bugs / lower thirds that outlive slide changes. */
  function paintProps(buf, props) {
    for (const p of (props || [])) {
      if (!p || p.hidden) continue;
      const el = buf.ownerDocument.createElement('div');
      el.className = 'lyr-prop';
      const w = p.w != null ? p.w : 0.2, x = p.x != null ? p.x : 0.04, y = p.y != null ? p.y : 0.04;
      el.style.cssText = `left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;width:${(w * 100).toFixed(2)}%;`
        + `opacity:${p.opacity != null ? p.opacity : 1};`;
      if (p.type === 'image') {
        el.innerHTML = `<img src="${esc(fileUrl(p.value))}" style="width:100%;height:auto;display:block" />`;
      } else {
        el.style.cssText += `background:${p.bg || 'rgba(0,0,0,.62)'};padding:${p.pad || 18}px 26px;border-radius:${p.radius || 10}px;`;
        el.innerHTML = `<div style="font-family:${cssFont(p.font || 'Poppins')};font-size:${p.size || 44}px;`
          + `color:${p.color || '#ffffff'};font-weight:${p.bold === false ? 400 : 800};line-height:1.2;`
          + `text-align:${p.align || 'left'}">${esc(p.value).replace(/\n/g, '<br>')}</div>`;
      }
      buf.appendChild(el);
    }
  }

  /** A timed pop-up message, built from a template + the operator's tokens. */
  function paintMessage(buf, msg) {
    if (!msg || !msg.text) return;
    const el = buf.ownerDocument.createElement('div');
    el.className = 'lyr-msg';
    const pos = msg.position || 'bottom';
    el.style.cssText = pos === 'top' ? 'top:6%;' : pos === 'center' ? 'top:50%;transform:translateY(-50%);' : 'bottom:7%;';
    el.innerHTML = `<div class="lyr-msg-inner" style="font-family:${cssFont(msg.font || 'Poppins')};`
      + `font-size:${msg.size || 52}px;color:${msg.color || '#ffffff'};background:${msg.bg || 'rgba(0,0,0,.78)'}">`
      + `${esc(msg.text)}</div>`;
    buf.appendChild(el);
  }

  /** An announcement that stays up while slides change underneath it. */
  function paintAnnouncement(buf, a, look) {
    if (!a || !(a.lines || []).join('').trim()) return;
    const t = theme(Object.assign({}, look, a.theme));
    const d = buf.ownerDocument.createElement('div');
    d.className = 'sr-body';
    d.style.cssText = 'position:absolute;inset:0;display:flex;flex-direction:column;'
      + `padding:${t.padY}px ${t.padX}px;justify-content:${JUSTIFY[a.valign || 'center']};align-items:center;`;
    d.innerHTML = `<div class="sr-text" style="${esc(textStyle(t))}">`
      + a.lines.map((l) => `<div class="sr-line">${esc(l) || '&nbsp;'}</div>`).join('') + '</div>';
    buf.appendChild(d);
    shrinkBody(d, t);
  }

  /** Countdown / count-up / wall clock, drawn wherever it was placed. */
  function paintTimers(buf, timers, now) {
    for (const t of (timers || [])) {
      if (!t || t.hidden) continue;
      const el = buf.ownerDocument.createElement('div');
      el.className = 'lyr-timer';
      el.dataset.timer = t.id;
      const x = t.x != null ? t.x : 0.5, y = t.y != null ? t.y : 0.08;
      el.style.cssText = `left:${(x * 100).toFixed(2)}%;top:${(y * 100).toFixed(2)}%;transform:translate(-50%,-50%);`
        + `font-family:${cssFont(t.font || 'Poppins')};font-size:${t.size || 120}px;color:${t.color || '#ffffff'};`
        + 'text-shadow:0 4px 16px rgba(0,0,0,.75);';
      el.textContent = timerText(t, now);
      buf.appendChild(el);
    }
  }
  /** Timer arithmetic, pure so the tests can pin it down without a clock. */
  function timerText(t, now) {
    const n = now || Date.now();
    if (t.mode === 'clock') {
      const d = new Date(n);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: t.seconds === false ? undefined : '2-digit' });
    }
    let secs;
    if (t.mode === 'countup') secs = Math.max(0, Math.floor(((t.running ? n : (t.stoppedAt || n)) - (t.startedAt || n)) / 1000));
    else secs = Math.max(0, Math.ceil(((t.endsAt || n) - (t.running ? n : (t.stoppedAt || n))) / 1000));
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return (h > 0 ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s).padStart(2, '0');
  }

  /** A top-most mask/overlay image (vignette, LED mask, safe frame). */
  function paintMask(buf, m) {
    if (!m || !m.value) return;
    const d = buf.ownerDocument.createElement('div');
    d.className = 'lyr-img';
    d.style.cssText = `background-image:url("${fileUrl(m.value)}");background-size:${m.fit === 'contain' ? 'contain' : 'cover'};`
      + `background-position:center;background-repeat:no-repeat;opacity:${m.opacity != null ? m.opacity : 1};`;
    buf.appendChild(d);
  }

  /**
   * Paint the WHOLE stack statically into a box — all seven layers, honouring
   * clears and blackout, with no transitions. This is what the operator's Live
   * monitor uses: it has to be the real composite (props, messages, timers and
   * all), or "what I see" and "what the room sees" quietly diverge.
   */
  function paintComposite(container, st, look) {
    if (!container) return null;
    injectCss(container.ownerDocument);
    let stage = container.querySelector(':scope > .sr-stage');
    /*
     * EACH LAYER IS KEYED SEPARATELY, and that is the whole point.
     *
     * This paints the operator's Live and Next monitors. It used to describe
     * the entire composite with ONE signature, so anything that changed
     * anything rebuilt everything — and "everything" includes the background
     * <video>. Reading scripture over a motion loop therefore destroyed and
     * re-created the video on every single verse: measured, the loop restarted
     * from zero on all 20 verse changes and never got past 0.05 s. On the
     * operator's monitor that reads as a background that stutters back to the
     * start every time they press the arrow key.
     *
     * The projector never had this problem because layers.js has always keyed
     * its layers independently (that is what lets lyrics change over a running
     * loop). This brings the studio's own monitors in line: a layer whose
     * content has not changed keeps its DOM, and its video keeps playing.
     *
     * Ordering is preserved by inserting a rebuilt layer BEFORE the next layer
     * that already exists, rather than appending and re-sorting — moving a
     * playing <video> around the tree is exactly what this is trying to avoid.
     */
    const cw = container.clientWidth, ch = container.clientHeight;
    if (!stage) {
      stage = container.ownerDocument.createElement('div');
      stage.className = 'sr-stage';
      container.appendChild(stage);
    }
    if (!stage.__srLayers) { stage.__srLayers = {}; stage.innerHTML = ''; }
    const s = st || {};
    const L = s.layers || {};
    const cleared = s.cleared || {};
    const order = ['background', 'media', 'slide', 'announcement', 'props', 'messages', 'mask'];
    const content = {
      background: L.background, media: L.media, slide: L.slide, announcement: L.announcement,
      props: L.props, mask: L.mask,
      messages: { message: s.message || null, timers: (s.timers || []).filter((t) => t && t.onOutput !== false) },
    };
    // Which layers should be on screen, in z-order — plus blackout as the last
    // one, so it is handled by the same keep-or-rebuild rule as the rest.
    const want = [];
    for (const name of order) {
      if (cleared[name]) continue;
      const c = content[name];
      if (c == null) continue;
      if (name === 'messages' && !c.message && !(c.timers || []).length) continue;
      want.push([name, c]);
    }
    if (s.blackout) want.push(['__blackout', true]);

    const lookSig = sigOf(look);
    const kept = stage.__srLayers;
    const wanted = new Set(want.map(([n]) => n));
    for (const name of Object.keys(kept)) {
      if (!wanted.has(name)) { try { kept[name].el.remove(); } catch (e) {} delete kept[name]; }
    }
    want.forEach(([name, c], i) => {
      const lsig = sigOf([name, c, lookSig]);
      const old = kept[name];
      if (old && old.sig === lsig) return;            // same picture — leave it alone
      repaints.composites++;
      const buf = container.ownerDocument.createElement('div');
      buf.style.cssText = name === '__blackout'
        ? 'position:absolute;inset:0;background:#000;'
        : 'position:absolute;inset:0;';
      if (old) {
        try { old.el.replaceWith(buf); } catch (e) { stage.appendChild(buf); }
      } else {
        // insert before the next layer that is already standing, so a new layer
        // lands at the right depth without disturbing the ones around it
        let before = null;
        for (let k = i + 1; k < want.length && !before; k++) {
          const nxt = kept[want[k][0]];
          if (nxt && nxt.el && nxt.el.parentNode === stage) before = nxt.el;
        }
        stage.insertBefore(buf, before);
      }
      if (name !== '__blackout') paintLayer(name, buf, c, look);
      kept[name] = { sig: lsig, el: buf };
    });

    if (stage.__srW !== cw || stage.__srH !== ch) { fit(stage, container); stage.__srW = cw; stage.__srH = ch; }
    return stage;
  }

  /** One entry point the layer engine calls for whichever layer changed. */
  function paintLayer(name, buf, content, look) {
    if (name === 'background' || name === 'media') paintMedia(buf, content, look);
    else if (name === 'slide') paintSlide(buf, content, look);
    else if (name === 'announcement') paintAnnouncement(buf, content, look);
    else if (name === 'props') paintProps(buf, content);
    else if (name === 'messages') { paintMessage(buf, content && content.message); paintTimers(buf, content && content.timers); }
    else if (name === 'mask') paintMask(buf, content);
  }

  window.SlideRender = {
    STAGE_W, STAGE_H, DEFAULT_THEME, theme, stageHtml, injectCss, fit, paint, shrinkToFit, paintSig, repaints,
    bgStyle, textStyle, fileUrl, esc, CSS, cssFont,
    paintLayer, paintMedia, paintSlide, paintProps, paintMessage, paintAnnouncement, paintTimers, paintMask,
    paintComposite, timerText, embedUrl, videoId, adjustFilter, chromaKey,
    MOTIONS, MOTION_NAMES,
  };
})();
