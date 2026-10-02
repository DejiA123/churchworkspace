'use strict';
/*
 * Church Work Space — Flyer Maker (Canva-style, free & offline).
 *
 * - Freeform design surface: drag / resize / rotate / inline-edit layers.
 * - Left rail: 🪄 Magic (type your event → AI builds flyers), 🗂️ Templates,
 *   🔤 Text, ⬡ Elements, 🖼️ Background artwork, 📚 Layers.
 * - Bundled display fonts embedded as data-URI @font-face — they render on
 *   the live canvas AND inside the SVG-foreignObject export (file:// fonts
 *   would silently fail there).
 * - AI background removal via window.FlyerAI (on-device segmentation with a
 *   flood-fill fallback).
 * - Photoshop-style layer tools: 16 blend modes (mix-blend-mode), drop-shadow
 *   layer styles, skew transforms, full image adjustments (brightness/contrast/
 *   saturation/hue/sepia/B&W/invert/blur + 12 presets), crop-inside-frame
 *   (zoom + pan), gradient shape fills, eyedropper colour picking, and
 *   canvas resize that re-scales every layer (Image Size).
 * - Exact-size export (window.rasterizeFlyer): PNG / JPG / PNG 2×.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const uid = () => 'e' + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const SIZES = [
    { id: '1080x1350', label: 'Instagram portrait (1080×1350)' },
    { id: '1080x1080', label: 'Instagram square (1080×1080)' },
    { id: '1080x1920', label: 'Story / Reel (1080×1920)' },
    { id: '1920x1080', label: 'Wide / Slide (1920×1080)' },
    { id: '1200x628', label: 'Facebook post (1200×628)' },
    { id: '2480x3508', label: 'Print A4 (300dpi)' },
    { id: '1748x2480', label: 'Print A5 (300dpi)' },
  ];

  // Bundled font files → families (loaded as data-URI @font-face at init).
  const FONT_FILES = {
    'Anton-Regular.ttf': { family: 'Anton', weight: '400' },
    'BebasNeue-Regular.ttf': { family: 'Bebas Neue', weight: '400' },
    'Poppins-Bold.ttf': { family: 'Poppins', weight: '700' },
    'Bangers-Regular.ttf': { family: 'Bangers', weight: '400' },
    'Pacifico-Regular.ttf': { family: 'Pacifico', weight: '400' },
    'GreatVibes-Regular.ttf': { family: 'Great Vibes', weight: '400' },
    'AlfaSlabOne-Regular.ttf': { family: 'Alfa Slab One', weight: '400' },
    /*
     * Montserrat and Playfair ship as STATIC ExtraBold rather than variable.
     * The variable files' default instance is Thin, which drew hairline
     * captions on the video side; swapping them fixed that but renamed the
     * files, and this map is keyed by FILE NAME — so both names are listed and
     * the CSS family stays 'Montserrat' / 'Playfair Display' either way, which
     * is what every flyer template already asks for.
     */
    'PlayfairDisplay-ExtraBold.ttf': { family: 'Playfair Display', weight: '800' },
    'Montserrat-ExtraBold.ttf': { family: 'Montserrat', weight: '800' },
    'PlayfairDisplay-Variable.ttf': { family: 'Playfair Display', weight: '400 900' },
    'Montserrat-Variable.ttf': { family: 'Montserrat', weight: '100 900' },
    // the display faces added for captions are just as useful on a flyer
    'ArchivoBlack-Regular.ttf': { family: 'Archivo Black', weight: '400' },
    'Rubik-ExtraBold.ttf': { family: 'Rubik', weight: '800' },
    'Bungee-Regular.ttf': { family: 'Bungee', weight: '400' },
    'LuckiestGuy-Regular.ttf': { family: 'Luckiest Guy', weight: '400' },
    'TitanOne-Regular.ttf': { family: 'Titan One', weight: '400' },
    'LilitaOne-Regular.ttf': { family: 'Lilita One', weight: '400' },
    'SigmarOne-Regular.ttf': { family: 'Sigmar One', weight: '400' },
    'BowlbyOne-Regular.ttf': { family: 'Bowlby One', weight: '400' },
    'PassionOne-Bold.ttf': { family: 'Passion One', weight: '700' },
    'Fredoka-Bold.ttf': { family: 'Fredoka', weight: '700' },
    'Oswald-Bold.ttf': { family: 'Oswald', weight: '700' },
    'Teko-Bold.ttf': { family: 'Teko', weight: '700' },
  };
  const SYSTEM_FONTS = ['Segoe UI', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman', 'Verdana', 'Trebuchet MS', 'Courier New', 'Comic Sans MS', 'Segoe UI Emoji'];

  const TEXT_EFFECTS = [
    ['none', 'None'], ['shadow', 'Shadow'], ['lift', 'Lift'], ['outline', 'Outline'],
    ['glow', 'Glow'], ['neon', 'Neon'], ['chip', 'Backing chip'],
    // Cinematic 3D poster looks (real extrusion + metallic/textured faces)
    ['gold3d', '★ Gold 3D'], ['fire3d', '★ Fire 3D'], ['chrome3d', '★ Chrome 3D'],
    ['silver3d', '★ Liquid Silver'], ['stone3d', '★ Stone 3D'], ['emerald3d', '★ Emerald 3D'], ['royal3d', '★ Royal 3D'],
    ['gold', 'Gold (flat)'], ['chrome', 'Chrome (flat)'],
    ['fire', 'Fire (flat)'], ['ice', 'Ice'], ['royal', 'Royal'], ['toxic', 'Toxic'],
  ];

  // Photoshop-style layer blend modes (CSS mix-blend-mode — renders identically
  // on the live canvas and inside the SVG-foreignObject export).
  const BLEND_MODES = [
    'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
    'color-dodge', 'color-burn', 'hard-light', 'soft-light',
    'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
  ];

  // Metallic looks: the glyphs are FILLED with a gradient (background-clip:
  // text), so the element colour goes transparent and depth comes from a
  // drop-shadow filter (text-shadow would bleed through the transparent fill).
  const METAL_GRADIENTS = {
    gold: 'linear-gradient(180deg,#fdf0b0 0%,#f7d868 22%,#eab52d 40%,#8f5d0a 52%,#f9dc7a 66%,#d9a72e 82%,#6e4605 100%)',
    chrome: 'linear-gradient(180deg,#f4f8fc 0%,#c9d6e3 28%,#8fa3b8 46%,#42566b 52%,#dfe9f4 58%,#9db1c5 80%,#2e4053 100%)',
    fire: 'linear-gradient(180deg,#fff7ae 0%,#ffd54a 20%,#ff9a1f 40%,#ff5c12 58%,#b3210a 78%,#ffb84a 90%,#7a1503 100%)',
    ice: 'linear-gradient(180deg,#ffffff 0%,#d9f3ff 26%,#9fd8f7 44%,#3f8fc4 54%,#e8fbff 62%,#7fb8dd 84%,#1d4d74 100%)',
    royal: 'linear-gradient(180deg,#f3d9ff 0%,#c98fff 28%,#8a3ff0 52%,#5c17b5 72%,#d9a6ff 88%,#3c0b7e 100%)',
    toxic: 'linear-gradient(180deg,#f4ffb8 0%,#c8ff4a 26%,#7ddf1f 48%,#2f8f06 62%,#d6ff6b 80%,#1d5a02 100%)',
    // Cinematic 3D poster faces — richer highlight bands read as beveled metal.
    gold3d: 'linear-gradient(180deg,#fffbe6 0%,#ffe999 14%,#f7c948 34%,#b9791a 50%,#7a4a08 55%,#ffd76a 70%,#f0b73a 84%,#5e3a04 100%)',
    fire3d: 'linear-gradient(180deg,#fff6cf 0%,#ffdf6b 16%,#ffa92b 34%,#ff6a1a 52%,#e8330a 70%,#ff8a2a 86%,#8f1c04 100%)',
    chrome3d: 'linear-gradient(180deg,#ffffff 0%,#e6eef7 20%,#aebfd2 42%,#6d8298 50%,#37485c 56%,#d4e2f0 66%,#8ea3ba 86%,#243447 100%)',
    silver3d: 'linear-gradient(180deg,#ffffff 0%,#eef6ff 22%,#cfe0f2 44%,#9fb4cc 52%,#e9f3ff 62%,#b9cbe0 84%,#5f7086 100%)',
    stone3d: 'linear-gradient(180deg,#e9e6df 0%,#c9c4ba 26%,#918b7f 48%,#5f584d 56%,#d3cec4 68%,#8a8479 86%,#3c372f 100%)',
    emerald3d: 'linear-gradient(180deg,#eafff2 0%,#8bf5c0 20%,#22c56e 44%,#0b7a3c 56%,#7dffb8 70%,#12a350 86%,#064524 100%)',
    royal3d: 'linear-gradient(180deg,#f6e4ff 0%,#d6a6ff 22%,#a855f7 46%,#6d28d9 56%,#e0b3ff 70%,#7c3aed 86%,#3b0a70 100%)',
  };
  // Dark extrusion colour behind each 3D face (the "side" of the block letters).
  const EXTRUDE_3D = {
    gold3d: '#5a3806', fire3d: '#4a0d02', chrome3d: '#1b2836', silver3d: '#3f4d5c',
    stone3d: '#17171a', emerald3d: '#053a1e', royal3d: '#2a0b52',
  };
  // Stacked drop-shadows accumulate into a solid, crisp 3D extrusion behind the
  // gradient-filled glyphs (text-shadow would bleed through the transparent fill).
  // The filter chain is CAPPED at a few passes (with a larger per-step offset for
  // depth) — each drop-shadow re-rasterizes the whole layer, so a long chain would
  // hang print-size (A4/2×) exports. A short chain looks just as solid on big text.
  function extrude3dCss(size, color) {
    const steps = Math.min(Math.max(Math.round(size * 0.04), 2), 6);
    const step = Math.min(Math.max(size * 0.013, 1), 3).toFixed(2);
    let s = '';
    for (let i = 0; i < steps; i++) s += `drop-shadow(${step}px ${step}px 0 ${color}) `;
    return s;
  }

  const EMOJIS = ['✝️', '🙏', '❤️', '🔥', '✨', '⭐', '🕊️', '📖', '🎵', '🎶', '👑', '💧', '🌿', '☀️', '🌟', '💯', '🎉', '🙌', '👏', '😊', '🥰', '🤝', '💪', '🌈', '⛪', '📣', '📅', '📍', '🕙', '➡️', '✅', '💡', '🎬', '🎨', '📷', '🎧'];

  /* ------------------------------- state ------------------------------- */
  const ed = {
    design: null,
    sel: null,
    scale: 1,
    zoom: null,          // null = fit-to-screen, number = explicit zoom
    editing: null,
    drag: null,
    clipboard: null,
    brand: { churchName: 'Our Church', primaryColor: '#1f6feb', accentColor: '#f5a623' },
    refs: {},
    inited: false,
    tab: 'magic',
    lastFields: null,    // fields from the last Magic generation
    lastResults: [],
    fonts: {},           // family -> { base64, weight, file }
    fontsReady: null,    // promise
    bgPalette: 'emerald',
  };

  function newDesign(w = 1080, h = 1350) {
    return { w, h, background: { type: 'gradient', color: ed.brand.primaryColor, color2: shade(ed.brand.primaryColor, -45), angle: 135, src: null, fit: 'cover' }, elements: [] };
  }

  /* =============================== PAGES ===============================
   *
   * A flyer is rarely one sheet. An event has a poster, a programme, a
   * "what's on" card and a thank-you slide, and they share a size, a palette
   * and half their furniture — which is exactly what Canva's pages are for.
   *
   * The whole editor is written against `ed.design` ({ w, h, background,
   * elements }), and it stays that way: `ed.design` IS the current page,
   * holding the SAME arrays the page holds, so every tool, drag handler,
   * inspector and export path keeps working with no idea pages exist. All this
   * layer does is decide which page `ed.design` is pointing at.
   */
  function newPage(from) {
    const p = from
      ? JSON.parse(JSON.stringify({ background: from.background, elements: from.elements }))
      : { background: newDesign(ed.doc ? ed.doc.w : 1080, ed.doc ? ed.doc.h : 1350).background, elements: [] };
    if (from) for (const e of p.elements) e.id = uid();   // a copy is not the same element
    p.id = 'p' + Math.random().toString(36).slice(2, 8);
    return p;
  }
  /** Wrap a plain single design (an old save, a template, Magic) as a one-page doc. */
  function docFromDesign(d) {
    return { w: d.w, h: d.h, cur: 0, pages: [{ id: 'p' + Math.random().toString(36).slice(2, 8), background: d.background, elements: d.elements }] };
  }
  /** Point ed.design at page `i`, keeping the arrays shared (no copying). */
  function usePage(i) {
    const doc = ed.doc;
    if (!doc || !doc.pages.length) return;
    doc.cur = clamp(i, 0, doc.pages.length - 1);
    const p = doc.pages[doc.cur];
    ed.design = { w: doc.w, h: doc.h, background: p.background, elements: p.elements };
    ed.sel = null; ed.editing = null;
  }
  /** Undo/redo and template loads REPLACE ed.design — put it back on the page. */
  function commitDesignToPage() {
    const doc = ed.doc;
    if (!doc || !ed.design) return;
    const p = doc.pages[doc.cur];
    if (!p) return;
    p.background = ed.design.background;
    p.elements = ed.design.elements;
    doc.w = ed.design.w; doc.h = ed.design.h;
  }
  const pageCount = () => (ed.doc ? ed.doc.pages.length : 1);

  function addPage(copyCurrent) {
    commitDesignToPage();
    const doc = ed.doc;
    doc.pages.splice(doc.cur + 1, 0, newPage(copyCurrent ? doc.pages[doc.cur] : null));
    usePage(doc.cur + 1);
    renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave();
    toast(copyCurrent ? `📄 Page ${doc.cur + 1} — a copy of the one before it.` : `📄 Page ${doc.cur + 1} added.`, 'good');
  }
  function removePage(i) {
    const doc = ed.doc;
    if (doc.pages.length < 2) return toast('A flyer needs at least one page.', 'error');
    commitDesignToPage();
    doc.pages.splice(i, 1);
    usePage(Math.min(doc.cur, doc.pages.length - 1));
    renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave();
  }
  function movePage(i, dir) {
    const doc = ed.doc;
    const j = i + dir;
    if (j < 0 || j >= doc.pages.length) return;
    commitDesignToPage();
    const [p] = doc.pages.splice(i, 1);
    doc.pages.splice(j, 0, p);
    usePage(j);
    renderAll(); renderPages(); autosave();
  }
  function goPage(i) {
    if (i === ed.doc.cur) return;
    commitDesignToPage();
    usePage(i);
    renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave();
  }

  /** The page rail: a live miniature of every page, in order. */
  function renderPages() {
    const rail = ed.refs.pages;
    if (!rail || !ed.doc) return;
    const doc = ed.doc;
    commitDesignToPage();
    const ratio = doc.h / Math.max(1, doc.w);
    const tw = 74, th = Math.round(tw * ratio);
    rail.innerHTML = doc.pages.map((p, i) => {
      // Painted with the editor's own element renderer, scaled — so a page
      // thumbnail is a true miniature rather than a guess.
      const s = tw / doc.w;
      const inner = p.elements.filter((e) => !e.hidden).map((e) =>
        `<div style="${elPosStyle(e)}">${elInner(e)}</div>`).join('');
      return `<button type="button" class="ed-page${i === doc.cur ? ' sel' : ''}" data-page="${i}" title="Page ${i + 1}">
          <span class="ed-page-thumb" style="width:${tw}px;height:${th}px">
            <span class="ed-page-scale" style="width:${doc.w}px;height:${doc.h}px;transform:scale(${s});${bgCss(p.background)}">${inner}</span>
          </span>
          <span class="ed-page-no">${i + 1}</span>
          <span class="ed-page-tools">
            <span class="ed-page-btn" data-pmove="${i}" data-dir="-1" title="Move earlier">◀</span>
            <span class="ed-page-btn" data-pdup="${i}" title="Duplicate this page">⧉</span>
            <span class="ed-page-btn" data-pdel="${i}" title="Delete this page">✕</span>
            <span class="ed-page-btn" data-pmove="${i}" data-dir="1" title="Move later">▶</span>
          </span>
        </button>`;
    }).join('') +
      `<button type="button" class="ed-page-add" id="edPageAdd" title="Add a page">＋<span>Page</span></button>`;

    $$('[data-page]', rail).forEach((b) => b.addEventListener('click', (e) => {
      if (e.target.closest('.ed-page-btn')) return;      // a tool, not the page
      goPage(+b.dataset.page);
    }));
    $$('[data-pmove]', rail).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); movePage(+b.dataset.pmove, +b.dataset.dir);
    }));
    $$('[data-pdup]', rail).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); goPage(+b.dataset.pdup); addPage(true);
    }));
    $$('[data-pdel]', rail).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation(); removePage(+b.dataset.pdel);
    }));
    const add = $('#edPageAdd', rail);
    if (add) add.addEventListener('click', () => addPage(false));
    const all = $('#edExportAll');
    if (all) all.classList.toggle('hidden', doc.pages.length < 2);
  }

  function shade(hex, pct) {
    try {
      const n = parseInt(hex.slice(1), 16);
      let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; const f = pct / 100;
      r = Math.round(clamp(r + 255 * f, 0, 255)); g = Math.round(clamp(g + 255 * f, 0, 255)); b = Math.round(clamp(b + 255 * f, 0, 255));
      return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    } catch (e) { return hex; }
  }

  function hexRgba(hex, a) {
    try {
      const n = parseInt(String(hex).slice(1), 16);
      return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a == null ? 1 : a})`;
    } catch (e) { return hex; }
  }

  /* ------------------------------- fonts ------------------------------- */
  async function loadFonts() {
    try {
      const list = await window.api.fonts.data();
      for (const f of list) {
        const meta = FONT_FILES[f.file];
        if (meta) ed.fonts[meta.family] = { base64: f.base64, weight: meta.weight, file: f.file };
      }
      const css = fontFaceCss(Object.keys(ed.fonts));
      if (css) {
        let st = document.getElementById('edFontFaces');
        if (!st) { st = document.createElement('style'); st.id = 'edFontFaces'; document.head.appendChild(st); }
        st.textContent = css;
      }
    } catch (e) { console.warn('flyer fonts unavailable:', e && e.message); }
  }

  function fontFaceCss(families) {
    let css = '';
    for (const fam of families || []) {
      const f = ed.fonts[fam];
      if (!f) continue;
      css += `@font-face{font-family:'${fam}';src:url(data:font/ttf;base64,${f.base64}) format('truetype');font-weight:${f.weight};font-style:normal;}\n`;
    }
    return css;
  }

  function fontList() {
    return [...Object.keys(ed.fonts), ...SYSTEM_FONTS];
  }

  /** Families used by the design that we have embeddable data for. */
  function usedFontFamilies(d) {
    const used = new Set();
    for (const e of d.elements) if (e.type === 'text' && ed.fonts[e.font]) used.add(e.font);
    return [...used];
  }

  /* -------------------------- element factories ------------------------- */
  function addText({ heading, sub, font, size, color, weight, effect } = {}) {
    const d = ed.design;
    const el = {
      id: uid(), type: 'text',
      text: heading ? 'Your Heading' : sub ? 'Add a subheading' : 'Double-click to edit text',
      x: Math.round(d.w * 0.1), y: Math.round(d.h * 0.12), w: Math.round(d.w * 0.8),
      h: Math.round(heading ? d.h * 0.12 : d.h * 0.06),
      rot: 0, font: font || (heading ? 'Anton' : sub ? 'Poppins' : 'Montserrat'),
      size: size || Math.round(heading ? d.w * 0.09 : sub ? d.w * 0.05 : d.w * 0.035),
      color: color || '#ffffff', weight: weight == null ? (heading ? 700 : sub ? 700 : 500) : weight,
      italic: false, align: heading || sub ? 'center' : 'left', lineHeight: 1.1, letter: 0,
      stroke: 0, strokeColor: '#000000', bg: 'transparent', opacity: 1, shadow: false,
      effect: effect || 'none', fxColor: '',
    };
    pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
    return el;
  }

  function addShape(kind) {
    const d = ed.design;
    const isLine = kind === 'line';
    const el = {
      id: uid(), type: kind === 'roundrect' ? 'rect' : kind,
      x: Math.round(d.w * 0.3), y: Math.round(d.h * (isLine ? 0.5 : 0.4)),
      w: Math.round(d.w * 0.4), h: Math.round(isLine ? d.w * 0.02 : d.w * 0.4),
      rot: 0, fill: ed.brand.accentColor, radius: kind === 'roundrect' ? Math.round(d.w * 0.04) : 0,
      opacity: 1, borderColor: '#ffffff', borderWidth: 0,
    };
    pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
    return el;
  }

  function addEmoji(ch) {
    const d = ed.design;
    const el = { id: uid(), type: 'text', text: ch, x: Math.round(d.w * 0.4), y: Math.round(d.h * 0.4), w: Math.round(d.w * 0.2), h: Math.round(d.w * 0.2), rot: 0, font: 'Segoe UI Emoji', size: Math.round(d.w * 0.15), color: '#ffffff', weight: 400, italic: false, align: 'center', lineHeight: 1, letter: 0, stroke: 0, strokeColor: '#000', bg: 'transparent', opacity: 1, effect: 'none', fxColor: '' };
    pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
  }

  function addPhotoSlot(shape) {
    const d = ed.design;
    const s = Math.round(d.w * 0.36);
    const el = {
      id: uid(), type: 'image', src: window.FlyerTemplates.placeholderPhoto(null),
      x: Math.round((d.w - s) / 2), y: Math.round(d.h * 0.3), w: s, h: s, rot: 0,
      fit: 'cover', radius: shape === 'circle' ? Math.round(s / 2) : Math.round(s * 0.08),
      opacity: 1, ph: true, name: 'Photo slot',
    };
    pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
  }

  async function addImage() {
    try {
      const p = await window.api.dialog.openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]);
      if (!p) return;
      const src = await window.api.fs.readImageDataUrl(p);
      const dim = await loadImgDim(src);
      const d = ed.design;
      const maxW = d.w * 0.5;
      const ratio = dim.h / dim.w;
      const w = Math.round(Math.min(maxW, dim.w));
      const el = {
        id: uid(), type: 'image', src,
        x: Math.round(d.w * 0.25), y: Math.round(d.h * 0.3), w, h: Math.round(w * ratio),
        rot: 0, fit: 'contain', radius: 0, opacity: 1,
      };
      pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
    } catch (err) { toast('⚠️ Could not open image: ' + (err.message || 'Unknown error'), 'error'); }
  }

  function toast(msg, kind) { window.__toast && window.__toast(msg, kind || ''); }
  function loadImgDim(src) {
    return new Promise((res) => { const i = new Image(); i.onload = () => res({ w: i.naturalWidth, h: i.naturalHeight }); i.onerror = () => res({ w: 1, h: 1 }); i.src = src; });
  }

  /* ------------------------- background removal ------------------------- */
  async function removeBgSelected() {
    const e = selected(); if (!e || e.type !== 'image') return;
    toast('✂️ Removing background… (AI person cut-out, falls back to edge cleanup)');
    try {
      const out = await window.FlyerAI.removeBackground(e.src);
      pushHistory(); e.src = out.src; e.fit = 'contain'; delete e.ph; renderAll(); autosave(); renderInspector();
      toast(out.method === 'ai' ? '✅ Background removed with AI person cut-out!' : '✅ Background removed (edge cleanup — best on plain backgrounds).', 'good');
    } catch (err) { toast('⚠️ Could not process this image.', 'error'); }
  }

  async function setBackgroundImage() {
    try {
      const p = await window.api.dialog.openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]);
      if (!p) return;
      pushHistory();
      ed.design.background = { ...ed.design.background, type: 'image', src: await window.api.fs.readImageDataUrl(p), fit: 'cover' };
      renderAll(); autosave(); renderInspector();
    } catch (err) { toast('⚠️ Could not set background: ' + (err.message || 'Unknown error'), 'error'); }
  }

  /* ---------------------------- undo / redo ---------------------------- */
  ed.history = []; ed.future = [];
  function snapshot() { return JSON.stringify(ed.design); }
  function pushHistory() { ed.history.push(snapshot()); if (ed.history.length > 60) ed.history.shift(); ed.future.length = 0; }
  function undo() { if (!ed.history.length) return; ed.future.push(snapshot()); ed.design = JSON.parse(ed.history.pop()); ed.sel = null; commitDesignToPage(); renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave(); }
  function redo() { if (!ed.future.length) return; ed.history.push(snapshot()); ed.design = JSON.parse(ed.future.pop()); ed.sel = null; commitDesignToPage(); renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave(); }

  /* --------------------------- selection utils -------------------------- */
  function select(id) { ed.sel = id; ed.editing = null; renderInspector(); syncLayerSel(); }
  function selected() { return ed.design.elements.find((e) => e.id === ed.sel) || null; }
  function idx() { return ed.design.elements.findIndex((e) => e.id === ed.sel); }
  function bringForward() { const i = idx(); if (i >= 0 && i < ed.design.elements.length - 1) swap(i, i + 1); }
  function sendBackward() { const i = idx(); if (i > 0) swap(i, i - 1); }
  function bringFront() { const i = idx(); if (i >= 0) { const [e] = ed.design.elements.splice(i, 1); ed.design.elements.push(e); renderAll(); refreshLayers(); autosave(); } }
  function sendBack() { const i = idx(); if (i >= 0) { const [e] = ed.design.elements.splice(i, 1); ed.design.elements.unshift(e); renderAll(); refreshLayers(); autosave(); } }
  function swap(a, b) { const arr = ed.design.elements; [arr[a], arr[b]] = [arr[b], arr[a]]; renderAll(); refreshLayers(); autosave(); }
  function duplicate() { const e = selected(); if (!e) return; pushHistory(); const c = JSON.parse(JSON.stringify(e)); c.id = uid(); c.x += 24; c.y += 24; ed.design.elements.push(c); select(c.id); renderAll(); refreshLayers(); autosave(); }
  function removeSel() { const i = idx(); if (i >= 0) { pushHistory(); ed.design.elements.splice(i, 1); ed.sel = null; renderAll(); renderInspector(); refreshLayers(); autosave(); } }

  function alignEl(how) {
    const e = selected(); if (!e) return;
    pushHistory();
    const d = ed.design;
    if (how === 'left') e.x = 0;
    if (how === 'hcenter') e.x = Math.round((d.w - e.w) / 2);
    if (how === 'right') e.x = d.w - e.w;
    if (how === 'top') e.y = 0;
    if (how === 'vcenter') e.y = Math.round((d.h - e.h) / 2);
    if (how === 'bottom') e.y = d.h - e.h;
    renderAll(); renderInspector(); autosave();
  }

  /* -------------------- element → CSS (editor + export) ------------------ */
  function bgCss(bg) {
    if (!bg) return 'background:#ffffff;';
    if (bg.type === 'solid') return `background:${bg.color};`;
    if (bg.type === 'gradient') return `background:linear-gradient(${bg.angle}deg,${bg.color},${bg.color2});`;
    // bg.overlay is a CSS gradient painted OVER the photo (colour-wash scrim
    // that keeps text readable) — multiple background-image layers, top first.
    if (bg.type === 'image' && bg.src) return `background-image:${bg.overlay ? bg.overlay + ',' : ''}url('${bg.src}');background-size:${bg.fit};background-position:center;background-repeat:no-repeat;background-color:${bg.color || '#111'};`;
    return `background:${bg.color || '#ffffff'};`;
  }

  function textEffectCss(e) {
    const s = e.size || 40;
    const glow = e.fxColor || e.color;
    const eff = e.effect && e.effect !== 'none' ? e.effect : (e.shadow ? 'shadow' : 'none');
    switch (eff) {
      case 'shadow': return `text-shadow:${Math.round(s * 0.045)}px ${Math.round(s * 0.05)}px ${Math.round(s * 0.07)}px rgba(0,0,0,.6);`;
      case 'lift': return `text-shadow:0 ${Math.round(s * 0.06)}px ${Math.round(s * 0.22)}px rgba(0,0,0,.55);`;
      case 'glow': return `text-shadow:0 0 ${Math.round(s * 0.16)}px ${glow},0 0 ${Math.round(s * 0.45)}px ${glow};`;
      case 'neon': return `text-shadow:0 0 ${Math.round(s * 0.06)}px #ffffff,0 0 ${Math.round(s * 0.18)}px ${glow},0 0 ${Math.round(s * 0.4)}px ${glow},0 0 ${Math.round(s * 0.7)}px ${glow};`;
      case 'gold': case 'chrome': case 'fire': case 'ice': case 'royal': case 'toxic':
        return `filter:drop-shadow(0 ${Math.round(s * 0.035)}px ${Math.round(s * 0.05)}px rgba(0,0,0,0.6));`;
      case 'gold3d': case 'fire3d': case 'chrome3d': case 'silver3d': case 'stone3d': case 'emerald3d': case 'royal3d': {
        const ext = extrude3dCss(s, EXTRUDE_3D[eff]);
        const ground = `drop-shadow(0 ${Math.round(s * 0.08)}px ${Math.round(s * 0.1)}px rgba(0,0,0,0.55))`;
        const aura = eff === 'fire3d' ? `drop-shadow(0 0 ${Math.round(s * 0.22)}px #ff5a12) `
          : eff === 'silver3d' ? `drop-shadow(0 0 ${Math.round(s * 0.13)}px #d6ecff) `
          : eff === 'emerald3d' ? `drop-shadow(0 0 ${Math.round(s * 0.13)}px #37f59a) `
          : eff === 'royal3d' ? `drop-shadow(0 0 ${Math.round(s * 0.13)}px #b98cff) ` : '';
        return `filter:${ext}${aura}${ground};`;
      }
      default: return '';
    }
  }

  function imgFilterCss(e) {
    const f = e.filter || {};
    const parts = [];
    if (f.bright != null && +f.bright !== 1) parts.push(`brightness(${f.bright})`);
    if (f.contrast != null && +f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
    if (f.sat != null && +f.sat !== 1) parts.push(`saturate(${f.sat})`);
    if (f.blur) parts.push(`blur(${f.blur}px)`);
    if (f.gray) parts.push(`grayscale(${f.gray})`);
    if (f.sepia) parts.push(`sepia(${f.sepia})`);
    if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
    if (f.invert) parts.push(`invert(${f.invert})`);
    return parts.length ? `filter:${parts.join(' ')};` : '';
  }

  /** Shape fill — solid colour or a two-stop linear gradient (Photoshop gradient fill). */
  function fillCss(e) {
    return e.fill2 ? `linear-gradient(${e.gradAngle == null ? 135 : e.gradAngle}deg,${e.fill},${e.fill2})` : e.fill;
  }

  function elInner(e) {
    if (e.type === 'text') {
      const eff = e.effect && e.effect !== 'none' ? e.effect : (e.shadow ? 'shadow' : 'none');
      const stroke = (eff === 'outline' || e.stroke > 0) ? `-webkit-text-stroke:${e.stroke > 0 ? e.stroke : Math.max(1, Math.round((e.size || 40) * 0.02))}px ${e.strokeColor || '#000'};` : '';
      const chip = eff === 'chip';
      const metal = METAL_GRADIENTS[eff];
      const colorCss = metal
        ? `background-image:${metal};-webkit-background-clip:text;background-clip:text;color:transparent;`
        : `color:${e.color};`;
      const bg = chip ? `background:${e.bg && e.bg !== 'transparent' ? e.bg : 'rgba(0,0,0,0.65)'};border-radius:0.18em;padding:0.08em 0.3em;`
        : (!metal && e.bg && e.bg !== 'transparent' ? `background:${e.bg};` : '');
      return `<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;${bg}opacity:${e.opacity == null ? 1 : e.opacity};
        font-family:'${e.font}',sans-serif;font-size:${e.size}px;${colorCss}font-weight:${e.weight};
        font-style:${e.italic ? 'italic' : 'normal'};text-align:${e.align};line-height:${e.lineHeight};
        ${e.caps ? 'text-transform:uppercase;' : ''}${e.underline ? 'text-decoration:underline;' : ''}letter-spacing:${e.letter}px;white-space:${e.nowrap ? 'pre' : 'pre-wrap'};overflow-wrap:${e.nowrap ? 'normal' : 'break-word'};word-break:${e.nowrap ? 'normal' : 'break-word'};${stroke}${textEffectCss(e)}box-sizing:border-box;padding:${chip ? '0.08em 0.3em' : '2px'};">${esc(e.text)}</div>`;
    }
    if (e.type === 'image') {
      // Crop-inside-frame (Photoshop crop): zoom scales the picture inside the
      // overflow-hidden frame, panX/panY choose which part shows.
      const zoom = +e.zoom > 1 ? +e.zoom : 1;
      const sx = (e.flipH ? -1 : 1) * zoom, sy = (e.flipV ? -1 : 1) * zoom;
      const flip = (sx !== 1 || sy !== 1) ? `transform:scale(${sx},${sy});` : '';
      const pos = `object-position:${e.panX == null ? 50 : e.panX}% ${e.panY == null ? 50 : e.panY}%;`;
      const shadow = e.shadowEl ? `box-shadow:0 ${Math.round(e.h * 0.04)}px ${Math.round(e.h * 0.12)}px rgba(0,0,0,.5);` : '';
      return `<div style="width:100%;height:100%;border-radius:${e.radius}px;overflow:hidden;${shadow}"><img src="${e.src}" style="width:100%;height:100%;object-fit:${e.fit};${pos}opacity:${e.opacity};display:block;${flip}${imgFilterCss(e)}" /></div>`;
    }
    if (e.type === 'triangle' || e.type === 'star') {
      const pts = e.type === 'triangle' ? '50,3 97,97 3,97'
        : '50,2 61,38 98,38 68,60 79,96 50,74 21,96 32,60 2,38 39,38';
      // SVG shapes need a real <linearGradient> for gradient fills. Base vector
      // (top→bottom) equals CSS linear-gradient(180deg), so rotate by angle-180.
      const gid = 'lg' + e.id;
      const grad = e.fill2
        ? `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1" gradientTransform="rotate(${(e.gradAngle == null ? 135 : e.gradAngle) - 180} 0.5 0.5)"><stop offset="0" stop-color="${e.fill}"/><stop offset="1" stop-color="${e.fill2}"/></linearGradient></defs>` : '';
      return `<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:100%;opacity:${e.opacity};display:block;overflow:visible;">
        ${grad}<polygon points="${pts}" fill="${e.fill2 ? `url(#${gid})` : e.fill}" ${e.borderWidth > 0 ? `stroke="${e.borderColor}" stroke-width="${e.borderWidth / 20}"` : ''} /></svg>`;
    }
    if (e.type === 'line') {
      return `<div style="width:100%;height:100%;background:${fillCss(e)};opacity:${e.opacity};border-radius:${Math.round(e.h / 2)}px;"></div>`;
    }
    const radius = e.type === 'ellipse' ? '50%' : (e.radius || 0) + 'px';
    const border = e.borderWidth > 0 ? `border:${e.borderWidth}px solid ${e.borderColor};` : '';
    return `<div style="width:100%;height:100%;background:${fillCss(e)};border-radius:${radius};opacity:${e.opacity};${border}box-sizing:border-box;"></div>`;
  }

  function elPosStyle(e) {
    let tr = `rotate(${e.rot}deg)`;
    if (e.skewX || e.skewY) tr += ` skew(${e.skewX || 0}deg,${e.skewY || 0}deg)`;
    let css = `position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;transform:${tr};transform-origin:center;`;
    if (e.blend && e.blend !== 'normal') css += `mix-blend-mode:${e.blend};`;
    // Drop shadow "layer style" — a filter on the OUTER box so it hugs the real
    // silhouette (text glyphs, SVG shapes, transparent PNG cut-outs alike).
    if (e.ds && e.ds.on) {
      css += `filter:drop-shadow(${e.ds.x == null ? 0 : e.ds.x}px ${e.ds.y == null ? 10 : e.ds.y}px ${e.ds.blur == null ? 18 : e.ds.blur}px ${hexRgba(e.ds.color || '#000000', e.ds.alpha == null ? 0.6 : e.ds.alpha)});`;
    }
    return css;
  }

  /* --------------------------- canvas rendering -------------------------- */
  function renderAll() {
    const d = ed.design, c = ed.refs.canvas;
    if (!c || !d) return;
    fit();
    let html = `<div class="ed-bg" style="position:absolute;inset:0;${bgCss(d.background)}"></div>`;
    for (const e of d.elements) {
      if (e.hidden) continue;
      const editing = ed.editing === e.id && e.type === 'text';
      const locked = e.locked ? 'pointer-events:none;' : '';
      html += `<div class="ed-el${ed.sel === e.id ? ' sel' : ''}" data-id="${e.id}" style="${elPosStyle(e)}${editing ? 'cursor:text;' : ''}${locked}">${elInner(e)}</div>`;
    }
    c.innerHTML = html;
    if (ed.sel && !ed.editing) drawHandles();
    drawGuides();
  }

  function drawGuides() {
    if (!ed._guides || !ed._guides.length) return;
    for (const [dir, pos] of ed._guides) {
      const g = document.createElement('div');
      g.style.cssText = dir === 'v'
        ? `position:absolute;left:${pos}px;top:0;width:${Math.max(1, 1.5 / ed.scale)}px;height:${ed.design.h}px;background:#ff2d78;pointer-events:none;z-index:20;`
        : `position:absolute;top:${pos}px;left:0;height:${Math.max(1, 1.5 / ed.scale)}px;width:${ed.design.w}px;background:#ff2d78;pointer-events:none;z-index:20;`;
      ed.refs.canvas.appendChild(g);
    }
  }

  function drawHandles() {
    const e = selected(); if (!e || e.hidden) return;
    const hs = 12 / ed.scale, bw = 1.5 / ed.scale;
    const overlay = document.createElement('div');
    overlay.className = 'ed-sel-overlay';
    overlay.style.cssText = `position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;transform:rotate(${e.rot}deg);transform-origin:center;pointer-events:none;outline:${bw}px solid #1f6feb;`;
    if (!e.locked) {
      const handles = [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]];
      for (const [name, fx, fy] of handles) {
        overlay.innerHTML += `<div class="ed-h" data-handle="${name}" style="position:absolute;left:calc(${fx * 100}% - ${hs / 2}px);top:calc(${fy * 100}% - ${hs / 2}px);width:${hs}px;height:${hs}px;background:#fff;border:${bw}px solid #1f6feb;border-radius:2px;pointer-events:auto;cursor:${cursorFor(name)};"></div>`;
      }
      overlay.innerHTML += `<div class="ed-h" data-handle="rot" style="position:absolute;left:calc(50% - ${hs / 2}px);top:${-hs * 2}px;width:${hs}px;height:${hs}px;background:#f5a623;border:${bw}px solid #fff;border-radius:50%;pointer-events:auto;cursor:grab;"></div>`;
    } else {
      overlay.innerHTML += `<div style="position:absolute;right:${-hs}px;top:${-hs * 2}px;font-size:${hs * 1.2}px;">🔒</div>`;
    }
    ed.refs.canvas.appendChild(overlay);
  }

  function cursorFor(name) {
    return { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[name] || 'pointer';
  }

  /* --------------------------- pointer handling -------------------------- */
  function canvasPoint(ev) {
    const r = ed.refs.canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / ed.scale, y: (ev.clientY - r.top) / ed.scale };
  }

  function snapMove(e) {
    const d = ed.design, tol = 8 / ed.scale, guides = [];
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    if (Math.abs(cx - d.w / 2) < tol) { e.x = Math.round(d.w / 2 - e.w / 2); guides.push(['v', d.w / 2]); }
    if (Math.abs(cy - d.h / 2) < tol) { e.y = Math.round(d.h / 2 - e.h / 2); guides.push(['h', d.h / 2]); }
    if (Math.abs(e.x) < tol) { e.x = 0; guides.push(['v', 0]); }
    if (Math.abs(e.y) < tol) { e.y = 0; guides.push(['h', 0]); }
    if (Math.abs(e.x + e.w - d.w) < tol) { e.x = d.w - e.w; guides.push(['v', d.w]); }
    if (Math.abs(e.y + e.h - d.h) < tol) { e.y = d.h - e.h; guides.push(['h', d.h]); }
    ed._guides = guides;
  }

  function onPointerDown(ev) {
    if (ed.editing) return;
    const handle = ev.target.closest('.ed-h');
    const elNode = ev.target.closest('.ed-el');
    if (handle) {
      const e = selected(); if (!e) return;
      ev.preventDefault();
      pushHistory();
      ed.drag = { mode: handle.dataset.handle === 'rot' ? 'rot' : 'resize', handle: handle.dataset.handle, id: e.id, start: canvasPoint(ev), orig: { ...e } };
      bindMove();
      return;
    }
    if (elNode) {
      const id = elNode.dataset.id;
      select(id); renderAll();
      const e = selected();
      if (e && e.locked) return;
      const p = canvasPoint(ev);
      pushHistory();
      ed.drag = { mode: 'move', id, offX: p.x - e.x, offY: p.y - e.y };
      bindMove();
      ev.preventDefault();
      return;
    }
    ed.sel = null; renderAll(); renderInspector(); syncLayerSel();
  }

  function bindMove() {
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp, { once: true });
  }

  function onPointerMove(ev) {
    const dr = ed.drag; if (!dr) return;
    const e = ed.design.elements.find((x) => x.id === dr.id); if (!e) return;
    const p = canvasPoint(ev);
    if (dr.mode === 'move') {
      e.x = Math.round(p.x - dr.offX); e.y = Math.round(p.y - dr.offY);
      snapMove(e);
    } else if (dr.mode === 'resize') {
      resize(e, dr, p, ev);
    } else if (dr.mode === 'rot') {
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      let ang = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI + 90;
      if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
      e.rot = Math.round(ang);
    }
    renderAll();
  }

  function resize(e, dr, p, ev) {
    const o = dr.orig, h = dr.handle, min = 16;
    let x = o.x, y = o.y, w = o.w, hgt = o.h;
    if (h.includes('e')) w = clamp(p.x - o.x, min, 100000);
    if (h.includes('s')) hgt = clamp(p.y - o.y, min, 100000);
    if (h.includes('w')) { const nx = clamp(p.x, -100000, o.x + o.w - min); w = o.x + o.w - nx; x = nx; }
    if (h.includes('n')) { const ny = clamp(p.y, -100000, o.y + o.h - min); hgt = o.y + o.h - ny; y = ny; }
    // Corner drags on images keep the aspect ratio (Canva-style); Shift frees it.
    if (e.type === 'image' && h.length === 2 && !ev.shiftKey) {
      const ratio = o.h / o.w;
      hgt = Math.round(w * ratio);
      if (h.includes('n')) y = o.y + o.h - hgt;
    }
    e.x = Math.round(x); e.y = Math.round(y); e.w = Math.round(w); e.h = Math.round(hgt);
    if (e.type === 'text' && h.length === 2) e.size = Math.max(8, Math.round(o.size * (hgt / o.h)));
  }

  function onPointerUp() {
    document.removeEventListener('mousemove', onPointerMove);
    if (ed.drag) { ed.drag = null; ed._guides = null; renderAll(); renderInspector(); autosave(); }
  }

  function onDblClick(ev) {
    const elNode = ev.target.closest('.ed-el');
    if (!elNode) return;
    const e = ed.design.elements.find((x) => x.id === elNode.dataset.id);
    if (!e || e.locked) return;
    if (e.type === 'image') { replaceImage(); return; }
    if (e.type !== 'text') return;
    ed.editing = e.id; ed.sel = e.id;
    renderAll();
    const node = ed.refs.canvas.querySelector(`.ed-el[data-id="${e.id}"] > div`);
    if (node) {
      node.setAttribute('contenteditable', 'true');
      node.style.cursor = 'text';
      node.focus();
      document.execCommand && document.execCommand('selectAll', false, null);
      const commit = () => {
        e.text = node.innerText.replace(/\n$/, '');
        ed.editing = null;
        node.removeEventListener('blur', commit);
        renderAll(); renderInspector(); refreshLayers(); autosave();
      };
      node.addEventListener('blur', commit);
      node.addEventListener('keydown', (k) => { if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); node.blur(); } });
    }
  }

  function inFormField() {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  }

  function onKey(ev) {
    if (ed.editing || !ed.design) return;
    if (!$('#view-flyer').classList.contains('active')) return;
    if (inFormField()) return;
    const k = ev.key.toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); return; }
    const e = selected();
    if ((ev.ctrlKey || ev.metaKey) && k === 'c' && e) { ed.clipboard = JSON.stringify(e); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'x' && e) { ed.clipboard = JSON.stringify(e); removeSel(); return; }
    if ((ev.ctrlKey || ev.metaKey) && k === 'v' && ed.clipboard) {
      ev.preventDefault(); pushHistory();
      const c = JSON.parse(ed.clipboard); c.id = uid(); c.x += 24; c.y += 24;
      ed.design.elements.push(c); select(c.id); renderAll(); refreshLayers(); autosave(); return;
    }
    if ((ev.ctrlKey || ev.metaKey) && (ev.key === ']' || ev.key === '[') && e) {
      ev.preventDefault();
      if (ev.key === ']') { ev.shiftKey ? bringFront() : bringForward(); }
      else { ev.shiftKey ? sendBack() : sendBackward(); }
      return;
    }
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && e && !e.locked) { ev.preventDefault(); removeSel(); return; }
    if (ev.key === 'Escape') { ed.sel = null; renderAll(); renderInspector(); syncLayerSel(); return; }
    if (e && !e.locked && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) {
      ev.preventDefault(); const step = ev.shiftKey ? 10 : 1;
      if (ev.key === 'ArrowUp') e.y -= step; if (ev.key === 'ArrowDown') e.y += step;
      if (ev.key === 'ArrowLeft') e.x -= step; if (ev.key === 'ArrowRight') e.x += step;
      renderAll(); autosave();
    }
    if ((ev.ctrlKey || ev.metaKey) && k === 'd' && e) { ev.preventDefault(); duplicate(); }
  }

  /* ------------------------------ inspector ------------------------------ */
  function row(label, control) { return `<div class="ins-row"><label>${label}</label>${control}</div>`; }
  function num(id, val, min, max, step) { return `<input type="number" data-k="${id}" value="${val}" min="${min == null ? '' : min}" max="${max == null ? '' : max}" step="${step || 1}">`; }
  function color(id, val) {
    // 💧 = Photoshop eyedropper: pick any colour from anywhere on screen.
    const eye = window.EyeDropper ? `<button type="button" class="ins-eye" data-eye="${id}" title="Eyedropper — pick a colour from anywhere on screen">💧</button>` : '';
    return `<span class="ins-colorwrap"><input type="color" data-k="${id}" value="${val}">${eye}</span>`;
  }
  function slider(id, val, min, max, step) { return `<input type="range" data-k="${id}" value="${val}" min="${min}" max="${max}" step="${step}">`; }

  /** Blend mode + drop shadow + skew — Photoshop "layer style", any element type. */
  function layerStyleRows(e) {
    const ds = e.ds || {};
    let html = `<h4 class="ins-sec">Layer style</h4>`;
    html += row('Blend mode', `<select data-k="blend">${BLEND_MODES.map((m) => `<option value="${m}"${(e.blend || 'normal') === m ? ' selected' : ''}>${m[0].toUpperCase() + m.slice(1).replace('-', ' ')}</option>`).join('')}</select>`);
    html += row('Drop shadow', `<input type="checkbox" data-k="ds.on"${ds.on ? ' checked' : ''}>`);
    if (ds.on) {
      html += row('Shadow X', num('ds.x', ds.x == null ? 0 : ds.x, -300, 300));
      html += row('Shadow Y', num('ds.y', ds.y == null ? 10 : ds.y, -300, 300));
      html += row('Shadow blur', num('ds.blur', ds.blur == null ? 18 : ds.blur, 0, 300));
      html += row('Shadow colour', color('ds.color', ds.color || '#000000'));
      html += row('Shadow opacity', slider('ds.alpha', ds.alpha == null ? 0.6 : ds.alpha, 0, 1, 0.05));
    }
    html += row('Skew X°', num('skewX', e.skewX || 0, -60, 60));
    html += row('Skew Y°', num('skewY', e.skewY || 0, -60, 60));
    return html;
  }

  function renderInspector() {
    const ins = ed.refs.inspector; if (!ins || !ed.design) return;
    const e = selected();
    if (!e) {
      const bg = ed.design.background;
      ins.innerHTML = `
        <h3>Canvas</h3>
        ${row('Background', `<select data-bg="type">
            <option value="solid"${bg.type === 'solid' ? ' selected' : ''}>Solid colour</option>
            <option value="gradient"${bg.type === 'gradient' ? ' selected' : ''}>Gradient</option>
            <option value="image"${bg.type === 'image' ? ' selected' : ''}>Image / artwork</option></select>`)}
        ${bg.type !== 'image' ? row('Colour', `<input type="color" data-bg="color" value="${bg.color || '#1f6feb'}">`) : ''}
        ${bg.type === 'gradient' ? row('Colour 2', `<input type="color" data-bg="color2" value="${bg.color2 || '#0a3d91'}">`) : ''}
        ${bg.type === 'gradient' ? row('Angle', `<input type="number" data-bg="angle" value="${bg.angle}" min="0" max="360">`) : ''}
        ${bg.type === 'image' ? `<button class="ghost-btn small" id="insBgImg">Choose image…</button>` : ''}
        ${bg.type === 'image' ? row('Fit', `<select data-bg="fit"><option value="cover"${bg.fit === 'cover' ? ' selected' : ''}>Cover</option><option value="contain"${bg.fit === 'contain' ? ' selected' : ''}>Contain</option></select>`) : ''}
        <p class="muted small" style="margin-top:14px">💡 Try the <b>🪄 Magic</b> tab: type your event details and get ready-made flyers. Click any item on the canvas to edit it here.</p>`;
      bindInspector();
      return;
    }

    let html = `<div class="ins-head"><h3>${e.type === 'text' ? 'Text' : e.type === 'image' ? 'Image' : 'Shape'}</h3>
      <div class="ins-actions">
        <button class="icon-btn" data-act="front" title="Bring to front">⤒</button>
        <button class="icon-btn" data-act="forward" title="Forward">↑</button>
        <button class="icon-btn" data-act="backward" title="Backward">↓</button>
        <button class="icon-btn" data-act="back" title="Send to back">⤓</button>
        <button class="icon-btn" data-act="dup" title="Duplicate (Ctrl+D)">⧉</button>
        <button class="icon-btn${e.locked ? ' on' : ''}" data-act="lock" title="${e.locked ? 'Unlock' : 'Lock'}">${e.locked ? '🔒' : '🔓'}</button>
        <button class="icon-btn danger" data-act="del" title="Delete">🗑</button>
      </div></div>
      <div class="ins-align">
        <button data-align="left" title="Align left">⇤</button>
        <button data-align="hcenter" title="Center horizontally">⇹</button>
        <button data-align="right" title="Align right">⇥</button>
        <button data-align="top" title="Align top">⤒</button>
        <button data-align="vcenter" title="Center vertically">⇳</button>
        <button data-align="bottom" title="Align bottom">⤓</button>
      </div>
      <h4 class="muted small" style="margin:10px 0 4px">Layer position — image over text, or text over image <span style="font-weight:400">(Ctrl+] / Ctrl+[)</span></h4>
      <div class="ins-order">
        <button class="ghost-btn small" data-act="back" title="Send all the way behind">⤓ Back</button>
        <button class="ghost-btn small" data-act="backward" title="One step behind">↓ Behind</button>
        <button class="ghost-btn small" data-act="forward" title="One step in front">↑ In front</button>
        <button class="ghost-btn small" data-act="front" title="Bring all the way forward">⤒ Front</button>
      </div>`;

    if (e.type === 'text') {
      const fonts = fontList();
      html += row('Text', `<textarea data-k="text" rows="3">${esc(e.text)}</textarea>`);
      html += row('Font', `<select data-k="font">${fonts.map((f) => `<option style="font-family:'${f}'"${f === e.font ? ' selected' : ''}>${f}</option>`).join('')}</select>`);
      html += row('Size', num('size', e.size, 8, 900));
      html += row('Colour', color('color', e.color));
      html += row('Effect', `<select data-k="effect">${TEXT_EFFECTS.map(([v, l]) => `<option value="${v}"${(e.effect || 'none') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`);
      if (e.effect === 'glow' || e.effect === 'neon') html += row('Effect colour', color('fxColor', e.fxColor || e.color));
      if (e.effect === 'outline') { html += row('Outline width', num('stroke', e.stroke || 2, 0, 30, 0.5)); html += row('Outline colour', color('strokeColor', e.strokeColor)); }
      if (e.effect === 'chip') html += row('Chip colour', `<input type="color" data-k="bg" value="${e.bg === 'transparent' ? '#000000' : e.bg}">`);
      html += row('Weight', `<select data-k="weight">${[300, 400, 500, 600, 700, 800, 900].map((w) => `<option value="${w}"${+e.weight === w ? ' selected' : ''}>${w}</option>`).join('')}</select>`);
      html += row('Align', `<select data-k="align">${['left', 'center', 'right'].map((a) => `<option${e.align === a ? ' selected' : ''}>${a}</option>`).join('')}</select>`);
      html += row('Italic', `<input type="checkbox" data-k="italic"${e.italic ? ' checked' : ''}>`);
      html += row('ALL CAPS', `<input type="checkbox" data-k="caps"${e.caps ? ' checked' : ''}>`);
      html += row('Underline', `<input type="checkbox" data-k="underline"${e.underline ? ' checked' : ''}>`);
      html += row('Line height', num('lineHeight', e.lineHeight, 0.7, 3, 0.05));
      html += row('Letter spacing', num('letter', e.letter, -20, 80, 0.5));
      html += row('Opacity', num('opacity', e.opacity == null ? 1 : e.opacity, 0, 1, 0.05));
      html += layerStyleRows(e);
    } else if (e.type === 'image') {
      const f = e.filter || {};
      html += `<div class="ins-imgbtns">
        <button class="primary-btn small" data-act="removebg">✂️ Remove background</button>
        <button class="ghost-btn small" data-act="popout" title="AI-cuts the subject and layers it ABOVE your title — the classic 'person over the text' poster look">🪄 Pop out subject</button>
        <button class="ghost-btn small" data-act="replaceImg">Replace…</button>
        <button class="ghost-btn small" data-act="setAsBg">Set as background</button>
      </div>
      <div class="ins-align" style="margin-top:6px">
        <button data-act="flipH" title="Flip horizontally"${e.flipH ? ' class="on"' : ''}>⇋</button>
        <button data-act="flipV" title="Flip vertically"${e.flipV ? ' class="on"' : ''}>⥮</button>
      </div>
      <div class="ins-filters">
        <span class="muted small">Filters:</span>
        ${PRESET_LIST.map(([id, label]) => `<button data-preset="${id}">${label}</button>`).join('')}
      </div>
      <h4 class="ins-sec">Adjustments</h4>`;
      html += row('Brightness', slider('f.bright', f.bright == null ? 1 : f.bright, 0.3, 2, 0.05));
      html += row('Contrast', slider('f.contrast', f.contrast == null ? 1 : f.contrast, 0.3, 2, 0.05));
      html += row('Saturation', slider('f.sat', f.sat == null ? 1 : f.sat, 0, 2.5, 0.05));
      html += row('Hue shift', slider('f.hue', f.hue || 0, -180, 180, 1));
      html += row('Sepia', slider('f.sepia', f.sepia || 0, 0, 1, 0.05));
      html += row('B&amp;W', slider('f.gray', f.gray || 0, 0, 1, 0.05));
      html += row('Invert', slider('f.invert', f.invert || 0, 0, 1, 0.05));
      html += row('Blur', slider('f.blur', f.blur || 0, 0, 20, 0.5));
      html += `<h4 class="ins-sec">Crop / framing</h4>`;
      html += row('Zoom in frame', slider('zoom', e.zoom || 1, 1, 4, 0.05));
      html += row('Position X', slider('panX', e.panX == null ? 50 : e.panX, 0, 100, 1));
      html += row('Position Y', slider('panY', e.panY == null ? 50 : e.panY, 0, 100, 1));
      html += row('Fit', `<select data-k="fit"><option value="cover"${e.fit === 'cover' ? ' selected' : ''}>Cover (fill)</option><option value="contain"${e.fit === 'contain' ? ' selected' : ''}>Contain</option></select>`);
      html += row('Corner radius', num('radius', e.radius, 0, 2000));
      html += row('Shadow', `<input type="checkbox" data-k="shadowEl"${e.shadowEl ? ' checked' : ''}>`);
      html += row('Opacity', num('opacity', e.opacity, 0, 1, 0.05));
      html += layerStyleRows(e);
    } else {
      html += row('Fill', color('fill', e.fill));
      html += row('Gradient fill', `<input type="checkbox" data-k="gradOn"${e.fill2 ? ' checked' : ''}>`);
      if (e.fill2) {
        html += row('Fill colour 2', color('fill2', e.fill2));
        html += row('Gradient angle', num('gradAngle', e.gradAngle == null ? 135 : e.gradAngle, 0, 360));
      }
      if (e.type === 'rect') html += row('Corner radius', num('radius', e.radius, 0, 4000));
      html += row('Opacity', num('opacity', e.opacity, 0, 1, 0.05));
      html += row('Border width', num('borderWidth', e.borderWidth, 0, 80));
      html += row('Border colour', color('borderColor', e.borderColor));
      html += layerStyleRows(e);
    }
    html += `<div class="ins-grid">${row('X', num('x', e.x))}${row('Y', num('y', e.y))}${row('W', num('w', e.w))}${row('H', num('h', e.h))}${row('Rotate', num('rot', e.rot, -360, 360))}</div>`;
    ins.innerHTML = html;
    bindInspector();
  }

  const FILTER_PRESETS = {
    none: {},
    bw: { gray: 1, contrast: 1.05 },
    noir: { gray: 1, contrast: 1.35, bright: 0.92 },
    warm: { sepia: 0.3, sat: 1.2, bright: 1.05 },
    cool: { hue: -14, sat: 1.05, bright: 1.02 },
    vivid: { sat: 1.5, contrast: 1.12 },
    vintage: { sepia: 0.45, contrast: 0.95, bright: 1.08, sat: 0.85 },
    film: { sepia: 0.12, contrast: 0.9, sat: 0.8, bright: 1.06 },
    dramatic: { contrast: 1.35, sat: 1.15, bright: 0.94 },
    fade: { contrast: 0.82, bright: 1.12, sat: 0.7 },
    pop: { sat: 1.75, contrast: 1.2 },
    invert: { invert: 1 },
  };
  const PRESET_LIST = [
    ['none', 'None'], ['bw', 'B&W'], ['noir', 'Noir'], ['warm', 'Warm'], ['cool', 'Cool'], ['vivid', 'Vivid'],
    ['vintage', 'Vintage'], ['film', 'Film'], ['dramatic', 'Dramatic'], ['fade', 'Fade'], ['pop', 'Pop'], ['invert', 'Invert'],
  ];

  function bindInspector() {
    const ins = ed.refs.inspector;
    $$('[data-k]', ins).forEach((inp) => {
      const k = inp.dataset.k;
      const evt = (inp.type === 'checkbox' || inp.tagName === 'SELECT' || inp.type === 'color') ? 'change' : 'input';
      inp.addEventListener(evt, () => {
        const e = selected(); if (!e) return;
        let v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (inp.type === 'number' || inp.type === 'range') v = parseFloat(v) || 0;
        if (k.startsWith('f.')) { e.filter = e.filter || {}; e.filter[k.slice(2)] = v; }
        else if (k.startsWith('ds.')) { e.ds = e.ds || { x: 0, y: 10, blur: 18, color: '#000000', alpha: 0.6 }; e.ds[k.slice(3)] = v; }
        else if (k === 'gradOn') { if (v) e.fill2 = e.fill2 || shade(e.fill, -35); else delete e.fill2; }
        else e[k] = v;
        renderAll(); autosave();
        if (k === 'effect' || k === 'ds.on' || k === 'gradOn') renderInspector();
        if (k === 'text') refreshLayers();
      });
    });
    // Eyedropper (Photoshop-style): sample any pixel on screen into the paired swatch.
    $$('[data-eye]', ins).forEach((b) => b.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        const inp = ins.querySelector(`input[type="color"][data-k="${b.dataset.eye}"]`);
        if (inp && res && res.sRGBHex) { inp.value = res.sRGBHex; inp.dispatchEvent(new Event('change')); }
      } catch (err) { /* pick cancelled */ }
    }));
    $$('[data-bg]', ins).forEach((inp) => {
      inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'color' ? 'change' : 'input', () => {
        const key = inp.dataset.bg; let v = inp.value; if (inp.type === 'number') v = parseFloat(v) || 0;
        ed.design.background[key] = v;
        if (key === 'type' && v === 'image' && !ed.design.background.src) setBackgroundImage();
        else { renderAll(); autosave(); renderInspector(); }
      });
    });
    const bgImgBtn = $('#insBgImg', ins); if (bgImgBtn) bgImgBtn.addEventListener('click', setBackgroundImage);
    $$('[data-align]', ins).forEach((b) => b.addEventListener('click', () => alignEl(b.dataset.align)));
    $$('[data-preset]', ins).forEach((b) => b.addEventListener('click', () => {
      const e = selected(); if (!e) return;
      pushHistory(); e.filter = { ...FILTER_PRESETS[b.dataset.preset] }; renderAll(); renderInspector(); autosave();
    }));
    $$('[data-act]', ins).forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.act;
      const e = selected();
      if (a === 'front') bringFront(); else if (a === 'forward') bringForward();
      else if (a === 'backward') sendBackward(); else if (a === 'back') sendBack();
      else if (a === 'dup') duplicate(); else if (a === 'del') removeSel();
      else if (a === 'replaceImg') replaceImage();
      else if (a === 'removebg') removeBgSelected();
      else if (a === 'popout') popOutSubject();
      else if (a === 'setAsBg' && e && e.type === 'image') { pushHistory(); ed.design.background = { type: 'image', src: e.src, fit: 'cover' }; removeSel(); renderAll(); autosave(); }
      else if (a === 'lock' && e) { e.locked = !e.locked; renderAll(); renderInspector(); refreshLayers(); autosave(); }
      else if (a === 'flipH' && e) { pushHistory(); e.flipH = !e.flipH; renderAll(); renderInspector(); autosave(); }
      else if (a === 'flipV' && e) { pushHistory(); e.flipV = !e.flipV; renderAll(); renderInspector(); autosave(); }
    }));
  }

  // "Depth" effect from the reference flyers: the FULL photo stays where it
  // is (usually behind the title) and an AI cut-out of the subject is added
  // as the TOP layer at the same spot — so the person overlaps the text.
  async function popOutSubject() {
    const e = selected(); if (!e || e.type !== 'image') return;
    toast('🪄 Cutting out the subject…', '');
    try {
      const out = await window.FlyerAI.removeBackground(e.src, {});
      pushHistory();
      const c = {
        id: uid(), type: 'image', src: out.src,
        x: e.x, y: e.y, w: e.w, h: e.h, rot: e.rot || 0,
        fit: e.fit || 'cover', radius: 0, opacity: 1, name: 'Cut-out (over text)',
      };
      ed.design.elements.push(c);
      select(c.id); renderAll(); refreshLayers(); autosave();
      toast('✅ Subject popped out on top — put your title between the photo and the cut-out.', 'good');
    } catch (err) { toast('⚠️ Could not cut out the subject: ' + (err.message || 'Unknown error'), 'error'); }
  }

  async function replaceImage() {
    const e = selected(); if (!e || e.type !== 'image') return;
    try {
      const p = await window.api.dialog.openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]);
      if (!p) return;
      pushHistory();
      e.src = await window.api.fs.readImageDataUrl(p);
      delete e.ph;
      renderAll(); autosave(); refreshLayers();
    } catch (err) { toast('⚠️ Could not replace image: ' + (err.message || 'Unknown error'), 'error'); }
  }

  /* ------------------------------ left drawer ---------------------------- */
  function renderDrawer() {
    const dr = ed.refs.drawer; if (!dr) return;
    $$('.ed-rail-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === ed.tab));
    if (ed.tab === 'magic') return renderMagicTab();
    if (ed.tab === 'templates') return renderTemplatesTab();
    if (ed.tab === 'text') return renderTextTab();
    if (ed.tab === 'elements') return renderElementsTab();
    if (ed.tab === 'background') return renderBackgroundTab();
    if (ed.tab === 'layers') return refreshLayers(true);
  }

  function previewCard(design, label, extra) {
    const tw = 178;
    const k = tw / design.w;
    const th = Math.round(design.h * k);
    return `<div class="ed-card" ${extra || ''}>
      <div class="ed-thumb" style="width:${tw}px;height:${th}px;"><div style="position:relative;width:${design.w}px;height:${design.h}px;overflow:hidden;transform:scale(${k});transform-origin:top left;pointer-events:none;">${designInnerHtml(design)}</div></div>
      <div class="ed-card-label">${esc(label)}</div>
    </div>`;
  }

  function designInnerHtml(d) {
    let html = `<div style="position:absolute;inset:0;${bgCss(d.background)}"></div>`;
    for (const e of d.elements) { if (!e.hidden) html += `<div style="${elPosStyle(e)}">${elInner(e)}</div>`; }
    return html;
  }

  const MAGIC_PLACEHOLDER = `Holy Ghost Party with P. Daniel Olawande & Min. Tobi Akuraku
Theme: Wisdom & Power Service
Sun. 7th June, 2026 at 3PM
Venue: The Envoys Centre, 6A Cocoa Industries Road, Ikeja, Lagos`;

  function renderMagicTab() {
    const dr = ed.refs.drawer;
    const saved = localStorage.getItem('mw_magic_text') || '';
    dr.innerHTML = `
      <h3>🪄 Magic Create</h3>
      <p class="muted small">Type (or paste) your event details — title, minister(s), date, time, venue, theme — and get ready-made flyers instantly. Free, on-device AI.</p>
      <textarea id="magicText" rows="7" placeholder="${esc(MAGIC_PLACEHOLDER)}">${esc(saved)}</textarea>
      <button class="primary-btn" id="magicGo" style="width:100%">✨ Generate flyers</button>
      <div id="magicMeta" class="muted small"></div>
      <div id="magicResults" class="ed-cards"></div>`;
    $('#magicGo', dr).addEventListener('click', doMagic);
    $('#magicText', dr).addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) doMagic(); });
    if (ed.lastResults.length) paintMagicResults();
  }

  function doMagic() {
    const text = $('#magicText').value.trim();
    if (!text) { toast('Type your event details first ✍️', 'error'); return; }
    localStorage.setItem('mw_magic_text', text);
    const d = ed.design;
    const out = window.FlyerTemplates.generateDesigns({ text, w: d.w, h: d.h, count: 8, brand: ed.brand });
    ed.lastResults = out;
    ed.lastFields = out.length ? out[0].fields : null;
    paintMagicResults();
  }

  function paintMagicResults() {
    const meta = $('#magicMeta'), box = $('#magicResults');
    if (!meta || !box) return;
    const f = ed.lastFields;
    if (f) {
      const bits = [f.title && `<b>${esc(f.title)}</b>`, f.speakers.length && esc(f.speakers.map((s) => s.name).join(', ')), f.date && esc(f.date), f.time && esc(f.time), f.venue && '📍 ' + esc(f.venue)].filter(Boolean);
      meta.innerHTML = '✅ Understood: ' + bits.join(' · ') + '<br/><span class="muted">Click a design to load it — everything stays editable.</span>';
    }
    box.innerHTML = ed.lastResults.map((r, i) => previewCard(r.design, r.name, `data-magic="${i}"`)).join('');
    $$('[data-magic]', box).forEach((c) => c.addEventListener('click', () => applyGenerated(+c.dataset.magic)));
  }

  function applyGenerated(i) {
    const r = ed.lastResults[i]; if (!r) return;
    pushHistory();
    ed.design = JSON.parse(JSON.stringify(r.design));
    ed.sel = null;
    commitDesignToPage();
    $('#edSize').value = ed.design.w + 'x' + ed.design.h;
    renderAll(); renderInspector(); renderPages(); autosave();
    toast('✅ Design loaded — click any part to edit it.', 'good');
  }

  function renderTemplatesTab() {
    const dr = ed.refs.drawer;
    const FT = window.FlyerTemplates;
    const d = ed.design;
    const fields = ed.lastFields || FT.SAMPLE;
    dr.innerHTML = `
      <h3>🗂️ Templates</h3>
      <p class="muted small">Professionally designed church-event starters. ${ed.lastFields ? 'Using your Magic details.' : 'Generate in 🪄 Magic first to fill these with your event.'}</p>
      <div class="ed-cards" id="tplCards"></div>`;
    const box = $('#tplCards', dr);
    let html = '';
    FT.TEMPLATES.forEach((t) => {
      const design = FT.buildTemplate(t.id, t.palettes[0], fields, d.w, d.h, ed.brand);
      const dots = t.palettes.map((pl) => `<button class="ed-pal-dot" data-tpl="${t.id}" data-pal="${pl}" title="${FT.PALETTES[pl].name}" style="background:linear-gradient(135deg,${FT.PALETTES[pl].deep2},${FT.PALETTES[pl].accent})"></button>`).join('');
      html += `<div class="ed-card-wrap">${previewCard(design, t.name, `data-tplcard="${t.id}" data-pal="${t.palettes[0]}"`)}<div class="ed-pal-row">${dots}</div></div>`;
    });
    box.innerHTML = html;
    $$('[data-tplcard]', box).forEach((c) => c.addEventListener('click', () => applyTemplate(c.dataset.tplcard, c.dataset.pal)));
    $$('.ed-pal-dot', box).forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); applyTemplate(b.dataset.tpl, b.dataset.pal); }));
  }

  function applyTemplate(tplId, palId) {
    const d = ed.design;
    const design = window.FlyerTemplates.buildTemplate(tplId, palId, ed.lastFields || undefined, d.w, d.h, ed.brand);
    pushHistory();
    ed.design = design;
    ed.sel = null;
    commitDesignToPage();
    renderAll(); renderInspector(); renderPages(); autosave();
    toast('✅ Template loaded — every layer is editable.', 'good');
  }

  function renderTextTab() {
    const dr = ed.refs.drawer;
    const showcase = Object.keys(ed.fonts).map((f) =>
      `<button class="ed-font-btn" data-font="${esc(f)}" style="font-family:'${f}'">${esc(f)}</button>`).join('');
    dr.innerHTML = `
      <h3>🔤 Text</h3>
      <button class="ed-big-btn" data-addtext="heading" style="font-family:'Anton';font-size:22px">Add a heading</button>
      <button class="ed-big-btn" data-addtext="sub" style="font-family:'Poppins';font-weight:700;font-size:16px">Add a subheading</button>
      <button class="ed-big-btn" data-addtext="body" style="font-size:13px">Add body text</button>
      <h4 class="muted small" style="margin:14px 0 6px">Font styles — click to add</h4>
      <div class="ed-font-list">${showcase}</div>`;
    $$('[data-addtext]', dr).forEach((b) => b.addEventListener('click', () => {
      const kind = b.dataset.addtext;
      addText(kind === 'heading' ? { heading: true } : kind === 'sub' ? { sub: true } : {});
    }));
    $$('[data-font]', dr).forEach((b) => b.addEventListener('click', () => addText({ heading: true, font: b.dataset.font })));
  }

  function renderElementsTab() {
    const dr = ed.refs.drawer;
    const FT = window.FlyerTemplates;
    const stickers = FT.STICKERS.map((s) =>
      `<button class="ed-sticker" data-sticker="${s.id}" title="${esc(s.name)}"><img src="${FT.stickerSrc(s.id, ed.brand.accentColor || '#f5a623', '#ffe066')}" alt="${esc(s.name)}"/></button>`).join('');
    dr.innerHTML = `
      <h3>⬡ Elements</h3>
      <h4 class="muted small">Graphics &amp; stickers</h4>
      <div class="ed-sticker-grid">${stickers}</div>
      <h4 class="muted small">Shapes</h4>
      <div class="ed-shape-grid">
        <button data-shape="rect" title="Rectangle">▭</button>
        <button data-shape="roundrect" title="Rounded">▢</button>
        <button data-shape="ellipse" title="Circle">⬤</button>
        <button data-shape="triangle" title="Triangle">▲</button>
        <button data-shape="star" title="Star">★</button>
        <button data-shape="line" title="Line">━</button>
      </div>
      <h4 class="muted small">Photos</h4>
      <div class="ed-shape-grid">
        <button id="elAddImage" title="Upload an image">🖼️<span>Upload</span></button>
        <button data-photoslot="circle" title="Circle photo frame">⭕<span>Frame</span></button>
        <button data-photoslot="round" title="Rounded photo frame">🖽<span>Card</span></button>
      </div>
      <h4 class="muted small">Emoji &amp; icons</h4>
      <div class="ed-emoji-grid">${EMOJIS.map((e) => `<button class="ed-emoji" data-e="${e}">${e}</button>`).join('')}</div>`;
    $$('[data-sticker]', dr).forEach((b) => b.addEventListener('click', () => addSticker(b.dataset.sticker)));
    $$('[data-shape]', dr).forEach((b) => b.addEventListener('click', () => addShape(b.dataset.shape)));
    $('#elAddImage', dr).addEventListener('click', addImage);
    $$('[data-photoslot]', dr).forEach((b) => b.addEventListener('click', () => addPhotoSlot(b.dataset.photoslot)));
    $$('.ed-emoji', dr).forEach((b) => b.addEventListener('click', () => addEmoji(b.dataset.e)));
  }

  function addSticker(id) {
    const FT = window.FlyerTemplates;
    const def = FT.STICKERS.find((s) => s.id === id);
    if (!def) return;
    const d = ed.design;
    const w = Math.round(d.w * 0.32);
    const el = {
      id: uid(), type: 'image', src: FT.stickerSrc(id, ed.brand.accentColor || '#f5a623', '#ffe066'),
      x: Math.round((d.w - w) / 2), y: Math.round(d.h * 0.35), w, h: Math.round(w * def.ratio),
      rot: 0, fit: 'contain', radius: 0, opacity: 1, name: def.name,
    };
    pushHistory(); d.elements.push(el); select(el.id); renderAll(); autosave();
    return el;
  }

  function renderBackgroundTab() {
    const dr = ed.refs.drawer;
    const FT = window.FlyerTemplates;
    const pals = Object.entries(FT.PALETTES);
    const arts = ['rain', 'fire', 'neon', 'sky', 'rays', 'bokeh', 'waves', 'halftone', 'stars', 'clean'];
    dr.innerHTML = `
      <h3>🖼️ Background</h3>
      <div class="ins-row"><label>Solid</label><input type="color" id="bgSolid" value="${ed.design.background.color || '#1f6feb'}"></div>
      <div class="ins-row"><label>Gradient</label><input type="color" id="bgG1" value="${ed.design.background.color || ed.brand.primaryColor}"><input type="color" id="bgG2" value="${ed.design.background.color2 || shade(ed.brand.primaryColor, -45)}"><button class="ghost-btn small" id="bgGradApply">Apply</button></div>
      <button class="ghost-btn small" id="bgImageBtn" style="width:100%">📂 Use an image…</button>
      <h4 class="muted small" style="margin:14px 0 4px">HD photos <span style="font-weight:400">(auto-tinted so your text stays readable)</span></h4>
      <div class="ed-photo-grid">${FT.PHOTOS.map((ph) => `<button class="ed-photo" data-photo="${ph.id}" title="${esc(ph.name)}"><img src="assets/photos/${ph.id}.jpg" alt="${esc(ph.name)}" loading="lazy"/></button>`).join('')}</div>
      <h4 class="muted small" style="margin:14px 0 4px">Artwork styles</h4>
      <div class="ed-pal-row" id="bgPals">${pals.map(([id, p]) => `<button class="ed-pal-dot${id === ed.bgPalette ? ' on' : ''}" data-bgpal="${id}" title="${p.name}" style="background:linear-gradient(135deg,${p.deep2},${p.accent})"></button>`).join('')}</div>
      <div class="ed-cards" id="bgArts"></div>`;
    $('#bgSolid', dr).addEventListener('change', (ev) => { pushHistory(); ed.design.background = { type: 'solid', color: ev.target.value }; renderAll(); autosave(); });
    $('#bgGradApply', dr).addEventListener('click', () => { pushHistory(); ed.design.background = { type: 'gradient', color: $('#bgG1').value, color2: $('#bgG2').value, angle: 135 }; renderAll(); autosave(); });
    $('#bgImageBtn', dr).addEventListener('click', setBackgroundImage);
    $$('[data-photo]', dr).forEach((b) => b.addEventListener('click', () => applyPhotoBackground(b.dataset.photo)));
    $$('[data-bgpal]', dr).forEach((b) => b.addEventListener('click', () => { ed.bgPalette = b.dataset.bgpal; renderBackgroundTab(); }));
    paintArtCards(arts);
  }

  function applyPhotoBackground(id) {
    const FT = window.FlyerTemplates;
    const src = FT.photoSrc(id);
    if (!src) { toast('⏳ Photos are still loading — try again in a second.', ''); return false; }
    pushHistory();
    ed.design.background = { type: 'image', src, photoId: id, fit: 'cover', overlay: FT.scrim(null, 'dark') };
    renderAll(); autosave();
    toast('✅ HD photo background applied.', 'good');
    return true;
  }

  function paintArtCards(arts) {
    const FT = window.FlyerTemplates;
    const box = $('#bgArts'); if (!box) return;
    const p = Object.assign({ id: ed.bgPalette }, FT.PALETTES[ed.bgPalette]);
    // Build tiny sample designs whose only content is the artwork background.
    const d = ed.design;
    box.innerHTML = arts.map((a) => {
      const design = { w: d.w, h: d.h, background: artBackground(a, p, d.w, d.h), elements: [] };
      return previewCard(design, a[0].toUpperCase() + a.slice(1), `data-art="${a}"`);
    }).join('');
    $$('[data-art]', box).forEach((c) => c.addEventListener('click', () => {
      pushHistory();
      ed.design.background = artBackground(c.dataset.art, p, ed.design.w, ed.design.h);
      renderAll(); autosave();
      toast('✅ Background applied.', 'good');
    }));
  }

  function artBackground(art, p, w, h) {
    // The art builders live inside flyertpl.js templates; regenerate via a
    // minimal template call: build a design with the wanted art and steal
    // its background.
    const FT = window.FlyerTemplates;
    const probe = {
      rain: ['rain-stack', 0], fire: ['fire-conference', 0], neon: ['neon-party', 0],
      sky: ['script-night', 0], rays: ['rays-crusade', 0], bokeh: ['royal-worship', 0],
      waves: ['waves-thanks', 0], halftone: ['youth-sticker', 0], stars: ['vigil-minimal', 0],
      clean: ['gradient-modern', 0],
    }[art];
    const design = FT.buildTemplate(probe[0], p.id, FT.SAMPLE, w, h);
    return design.background;
  }

  /* ------------------------------- layers ------------------------------- */
  function layerLabel(e) {
    if (e.name) return e.name;
    if (e.type === 'text') return (e.text || 'Text').split('\n')[0].slice(0, 24) || 'Text';
    if (e.type === 'image') return e.ph ? 'Photo slot' : 'Image';
    return e.type[0].toUpperCase() + e.type.slice(1);
  }
  function layerIcon(e) {
    return e.type === 'text' ? '🔤' : e.type === 'image' ? '🖼️' : '⬛';
  }

  function refreshLayers(force) {
    if (ed.tab !== 'layers' && !force) return;
    const dr = ed.refs.drawer; if (!dr || ed.tab !== 'layers') return;
    const els = ed.design.elements;
    let html = `<h3>📚 Layers</h3><p class="muted small">Top layer first. Click to select; use the arrows to restack.</p><div class="ed-layers">`;
    for (let i = els.length - 1; i >= 0; i--) {
      const e = els[i];
      html += `<div class="ed-layer${ed.sel === e.id ? ' sel' : ''}${e.hidden ? ' isHidden' : ''}" data-layer="${e.id}">
        <span class="ed-layer-ico">${layerIcon(e)}</span>
        <span class="ed-layer-name">${esc(layerLabel(e))}</span>
        <button data-lup="${e.id}" title="Raise">↑</button>
        <button data-ldown="${e.id}" title="Lower">↓</button>
        <button data-lhide="${e.id}" title="${e.hidden ? 'Show' : 'Hide'}">${e.hidden ? '🙈' : '👁'}</button>
        <button data-llock="${e.id}" title="${e.locked ? 'Unlock' : 'Lock'}">${e.locked ? '🔒' : '🔓'}</button>
      </div>`;
    }
    html += `</div><div class="ed-layer ed-layer-bg"><span class="ed-layer-ico">🎨</span><span class="ed-layer-name">Background</span></div>`;
    dr.innerHTML = html;
    $$('[data-layer]', dr).forEach((r) => r.addEventListener('click', () => { select(r.dataset.layer); renderAll(); refreshLayers(true); }));
    $$('[data-lup]', dr).forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); ed.sel = b.dataset.lup; bringForward(); refreshLayers(true); }));
    $$('[data-ldown]', dr).forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); ed.sel = b.dataset.ldown; sendBackward(); refreshLayers(true); }));
    $$('[data-lhide]', dr).forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const e = ed.design.elements.find((x) => x.id === b.dataset.lhide);
      if (e) { e.hidden = !e.hidden; if (e.hidden && ed.sel === e.id) ed.sel = null; renderAll(); refreshLayers(true); autosave(); }
    }));
    $$('[data-llock]', dr).forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const e = ed.design.elements.find((x) => x.id === b.dataset.llock);
      if (e) { e.locked = !e.locked; renderAll(); renderInspector(); refreshLayers(true); autosave(); }
    }));
    const bgRow = $('.ed-layer-bg', dr);
    if (bgRow) bgRow.addEventListener('click', () => { ed.sel = null; renderAll(); renderInspector(); refreshLayers(true); });
  }

  function syncLayerSel() {
    if (ed.tab === 'layers') refreshLayers(true);
  }

  /* -------------------------------- export ------------------------------- */
  function designToHtml(d) {
    let html = `<div style="position:absolute;inset:0;${bgCss(d.background)}"></div>`;
    for (const e of d.elements) {
      if (e.hidden) continue;
      html += `<div style="${elPosStyle(e)}">${elInner(e)}</div>`;
    }
    // isolation:isolate — blend-mode layers must compose against the flyer
    // only, never against whatever sits behind the export wrapper.
    return `<div style="position:relative;width:${d.w}px;height:${d.h}px;overflow:hidden;isolation:isolate;">${html}</div>`;
  }

  async function rasterizeDesign(d, scaleFactor = 1) {
    const css = fontFaceCss(usedFontFamilies(d));
    let body = designToHtml(d);
    let w = d.w, h = d.h;
    if (scaleFactor !== 1) {
      w = Math.round(d.w * scaleFactor); h = Math.round(d.h * scaleFactor);
      body = `<div style="transform:scale(${scaleFactor});transform-origin:top left;width:${d.w}px;height:${d.h}px;">${body}</div>`;
    }
    return { bytes: await window.rasterizeFlyer(css, body, w, h), w, h };
  }

  async function pngToJpeg(bytes, w, h) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const cx = cv.getContext('2d');
    cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h);
    cx.drawImage(bmp, 0, 0);
    const out = await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('jpeg encode failed'))), 'image/jpeg', 0.93));
    return new Uint8Array(await out.arrayBuffer());
  }

  async function exportImage(fmt) {
    const d = ed.design;
    const prevSel = ed.sel; ed.sel = null; renderAll();
    try {
      const scaleFactor = fmt === 'png2x' ? 2 : 1;
      const r = await rasterizeDesign(d, scaleFactor);
      let bytes = r.bytes, ext = 'png';
      if (fmt === 'jpeg') { bytes = await pngToJpeg(r.bytes, r.w, r.h); ext = 'jpg'; }
      const name = pageCount() > 1 ? `flyer-p${ed.doc.cur + 1}` : 'flyer';
      const out = await window.api.flyer.savePng({ name, bytes, ext });
      toast('✅ Saved: ' + out.split(/[\\/]/).pop(), 'good');
      window.api.shell.showItem(out);
      return out;
    } finally { ed.sel = prevSel; renderAll(); }
  }

  /**
   * Every page, one file each, in order.
   *
   * A four-page set exported one page at a time is four trips through a menu
   * and four chances to name something wrong. Each page goes through exactly
   * the same path as a single export — made current, drawn, rasterised — so a
   * page in a set is byte-for-byte the file it would have been on its own.
   */
  async function exportAllPages(fmt) {
    if (pageCount() < 2) return exportImage(fmt);
    commitDesignToPage();
    const back = ed.doc.cur;
    const prevSel = ed.sel; ed.sel = null;
    const files = [];
    try {
      for (let i = 0; i < ed.doc.pages.length; i++) {
        usePage(i); renderAll();
        const r = await rasterizeDesign(ed.design, fmt === 'png2x' ? 2 : 1);
        let bytes = r.bytes, ext = 'png';
        if (fmt === 'jpeg') { bytes = await pngToJpeg(r.bytes, r.w, r.h); ext = 'jpg'; }
        files.push(await window.api.flyer.savePng({ name: `flyer-p${i + 1}`, bytes, ext }));
      }
      toast(`✅ ${files.length} pages saved.`, 'good');
      if (files.length) window.api.shell.showItem(files[0]);
      return files;
    } finally {
      usePage(back); ed.sel = prevSel; renderAll(); renderPages();
    }
  }

  /* ------------------------------ persistence ---------------------------- */
  let _saveT = null;
  function autosave() {
    clearTimeout(_saveT);
    _saveT = setTimeout(() => {
      try {
        commitDesignToPage();
        localStorage.setItem('mw_design', JSON.stringify(ed.doc || docFromDesign(ed.design)));
      } catch (e) {}
    }, 300);
  }
  /**
   * Read the saved flyer back — as a DOCUMENT with pages, or as the single
   * design older versions wrote, which becomes page one. A church that opens
   * this after an update must find its flyer where it left it.
   */
  function restore() {
    try {
      const s = localStorage.getItem('mw_design');
      if (!s) return null;
      const d = JSON.parse(s);
      if (d && d.w && Array.isArray(d.pages) && d.pages.length) return d;
      if (d && d.w && Array.isArray(d.elements)) return docFromDesign(d);
    } catch (e) {}
    return null;
  }

  /* ---------------------- legacy presets (smoke compat) ------------------- */
  function preset(name, w, h) {
    const FT = window.FlyerTemplates;
    if (name === 'blank') { const d = newDesign(w, h); d.background = { type: 'solid', color: '#ffffff' }; return d; }
    if (name === 'bold') return FT.buildTemplate('bold-minimal', 'mono', undefined, w, h, ed.brand);
    return FT.buildTemplate('gradient-modern', 'emerald', undefined, w, h, ed.brand); // 'event'
  }

  /* ------------------------------ layout fit ----------------------------- */
  function fit() {
    const wrap = ed.refs.stageWrap, stage = ed.refs.stage, canvas = ed.refs.canvas, d = ed.design;
    if (!wrap || !d) return;
    const availW = wrap.clientWidth - 48, availH = wrap.clientHeight - 48;
    const scale = ed.zoom != null ? ed.zoom : Math.min(availW / d.w, availH / d.h, 1.5);
    ed.scale = scale;
    canvas.style.width = d.w + 'px'; canvas.style.height = d.h + 'px';
    canvas.style.transform = `scale(${scale})`; canvas.style.transformOrigin = 'top left';
    stage.style.width = d.w * scale + 'px'; stage.style.height = d.h * scale + 'px';
    const pct = $('#edZoomPct'); if (pct) pct.textContent = Math.round(scale * 100) + '%';
  }

  function setZoom(z) { ed.zoom = z == null ? null : clamp(z, 0.05, 4); renderAll(); }

  /* ------------------------------- toolbar ------------------------------- */
  function setSize(id) {
    const [w, h] = id.split('x').map(Number);
    pushHistory();
    const d = ed.design;
    // Photoshop "Image Size": scale every layer with the canvas so the design
    // survives a format change (portrait → story → print) instead of breaking.
    const rx = w / d.w, ry = h / d.h;
    if ((rx !== 1 || ry !== 1) && d.elements.length) {
      const rs = Math.min(rx, ry);
      for (const e of d.elements) {
        e.x = Math.round(e.x * rx); e.y = Math.round(e.y * ry);
        e.w = Math.max(8, Math.round(e.w * rx)); e.h = Math.max(8, Math.round(e.h * ry));
        if (e.type === 'text') {
          e.size = Math.max(8, Math.round(e.size * rs));
          if (e.letter) e.letter = Math.round(e.letter * rs * 10) / 10;
        }
        if (e.radius) e.radius = Math.round(e.radius * rs);
      }
    }
    d.w = w; d.h = h;
    renderAll(); renderInspector(); autosave();
    if (ed.tab === 'templates' || ed.tab === 'magic') renderDrawer();
  }

  function wireToolbar() {
    $('#edUndo').addEventListener('click', undo);
    $('#edRedo').addEventListener('click', redo);
    $('#edSize').addEventListener('change', (e) => setSize(e.target.value));
    $('#edNew').addEventListener('click', () => {
      pushHistory();
      const [w, h] = $('#edSize').value.split('x').map(Number);
      // A new flyer is a NEW DOCUMENT: one page, not a blank page bolted onto
      // whatever was open before it.
      ed.doc = docFromDesign(newDesign(w, h));
      usePage(0);
      renderAll(); renderInspector(); refreshLayers(); renderPages(); autosave();
    });
    $('#edExport').addEventListener('click', async () => {
      try { await exportImage($('#edExportFmt').value); }
      catch (err) { toast('⚠️ ' + err.message, 'error'); }
    });
    const allBtn = $('#edExportAll');
    if (allBtn) allBtn.addEventListener('click', async () => {
      try { await exportAllPages($('#edExportFmt').value); }
      catch (err) { toast('⚠️ ' + err.message, 'error'); }
    });
    $('#edSchedule').addEventListener('click', async () => {
      try { const out = await exportImage('png'); if (out && window.attachFlyerToPost) window.attachFlyerToPost(out, ed.brand.churchName + ' event', ''); } catch (err) {}
    });
    $('#edZoomIn').addEventListener('click', () => setZoom((ed.zoom || ed.scale) * 1.25));
    $('#edZoomOut').addEventListener('click', () => setZoom((ed.zoom || ed.scale) / 1.25));
    $('#edZoomFit').addEventListener('click', () => setZoom(null));
    ed.refs.stageWrap.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      setZoom((ed.zoom || ed.scale) * (ev.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    $$('.ed-rail-tab').forEach((b) => b.addEventListener('click', () => { ed.tab = b.dataset.tab; renderDrawer(); }));
  }

  /* ------------------------------ public API ----------------------------- */
  window.Editor = {
    init(settings) {
      if (ed.inited) return;
      ed.inited = true;
      if (settings && settings.brand) ed.brand = settings.brand;
      ed.refs = { stageWrap: $('#edStageWrap'), stage: $('#edStage'), canvas: $('#edCanvas'),
        inspector: $('#edInspector'), drawer: $('#edDrawer'), pages: $('#edPages') };
      $('#edSize').innerHTML = SIZES.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
      ed.doc = restore() || docFromDesign(preset('event', 1080, 1350));
      usePage(ed.doc.cur || 0);
      renderPages();
      $('#edSize').value = SIZES.some((s) => s.id === ed.design.w + 'x' + ed.design.h) ? ed.design.w + 'x' + ed.design.h : SIZES[0].id;
      ed.fontsReady = loadFonts().then(() => { renderAll(); renderDrawer(); });
      // HD photo backgrounds: load once as data URIs, then Magic + Background tab use them
      ed.photosReady = window.FlyerTemplates.loadPhotoLibrary().then((n) => {
        if (n && ed.tab === 'background') renderDrawer();
        return n;
      });
      wireToolbar();
      ed.refs.canvas.addEventListener('mousedown', onPointerDown);
      ed.refs.canvas.addEventListener('dblclick', onDblClick);
      document.addEventListener('keydown', onKey);
      renderAll(); renderInspector(); renderDrawer();
    },
    onShow() { renderAll(); renderInspector(); },
    fit,
    // test hooks
    __test: {
      loadPreset(name, w, h) { ed.design = preset(name, w, h); ed.sel = null; },
      setSize(w, h) { ed.design.w = w; ed.design.h = h; },
      addText(o) { addText(o); },
      addShape(k) { addShape(k); },
      addEmoji(c) { addEmoji(c); },
      undo() { undo(); }, redo() { redo(); },
      historyLen() { return ed.history.length; },
      async removeBg(src, tol) {
        const out = await window.FlyerAI.removeBackground(src, { tol });
        const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = out.src; });
        const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
        const cx = c.getContext('2d'); cx.drawImage(im, 0, 0);
        const a = (x, y) => cx.getImageData(x, y, 1, 1).data[3];
        return { corner: a(1, 1), center: a(Math.floor(c.width / 2), Math.floor(c.height / 2)), w: c.width, h: c.height, method: out.method };
      },
      async exportInfo(scale) { const d = ed.design; const r = await rasterizeDesign(d, scale || 1); const bytes = r.bytes; return { w: (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19], h: (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23], len: bytes.length }; },
      async exportJpegInfo() { const d = ed.design; const r = await rasterizeDesign(d); const j = await pngToJpeg(r.bytes, r.w, r.h); return { b0: j[0], b1: j[1], len: j.length }; },
      async exportBase64() { const d = ed.design; const r = await rasterizeDesign(d); const bytes = r.bytes; let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); },
      addImageSrc(src, x, y, w, h) { ed.design.elements.push({ id: uid(), type: 'image', src, x, y, w, h, rot: 0, fit: 'contain', radius: 0, opacity: 1 }); renderAll(); },
      elementCount() { return ed.design.elements.length; },
      /** What is on the page right now — enough to tell one page from another. */
      elements() { return ed.design.elements.map((e) => ({ id: e.id, type: e.type, text: e.text, x: e.x, y: e.y, w: e.w, h: e.h })); },
      // new hooks
      fontsReady() { return ed.fontsReady || Promise.resolve(); },
      photosReady() { return ed.photosReady || Promise.resolve(0); },
      bringFront() { bringFront(); }, sendBack() { sendBack(); },
      bringForward() { bringForward(); }, sendBackward() { sendBackward(); },
      async popOut() { await popOutSubject(); return ed.design.elements.length; },
      photoCount() { return window.FlyerTemplates.photosLoaded(); },
      applyPhotoBg(id) { return applyPhotoBackground(id); },
      getBackground() { return JSON.parse(JSON.stringify(ed.design.background)); },
      fontFamilies() { return Object.keys(ed.fonts); },
      parse(text) { return window.FlyerTemplates.parseEventText(text); },
      generate(text) { const d = ed.design; ed.lastResults = window.FlyerTemplates.generateDesigns({ text, w: d.w, h: d.h, count: 8, brand: ed.brand }); ed.lastFields = ed.lastResults.length ? ed.lastResults[0].fields : null; return ed.lastResults.map((r) => ({ templateId: r.templateId, paletteId: r.paletteId, name: r.name, elements: r.design.elements.length })); },
      applyGenerated(i) { applyGenerated(i); return ed.design.elements.length; },
      applyTemplate(tplId, palId) { applyTemplate(tplId, palId); return ed.design.elements.length; },
      templateCount() { return window.FlyerTemplates.TEMPLATES.length; },
      addSticker(id) { const el = addSticker(id); return el ? { type: el.type, isSvg: el.src.startsWith('data:image/svg'), ratio: el.h / el.w } : null; },
      stickerCount() { return window.FlyerTemplates.STICKERS.length; },
      setTab(t) { ed.tab = t; renderDrawer(); },
      getDesign() { return JSON.parse(JSON.stringify(ed.design)); },
      setDesign(d) { ed.design = d; ed.sel = null; commitDesignToPage(); renderAll(); renderInspector(); renderPages(); },
      /* ---- pages ---- */
      pages() {
        commitDesignToPage();
        return { cur: ed.doc.cur, w: ed.doc.w, h: ed.doc.h,
          pages: ed.doc.pages.map((p) => ({ id: p.id, elements: p.elements.length, bg: p.background && p.background.type })) };
      },
      addPageViaButton(dup) {
        const b = document.querySelector(dup ? '#edPages [data-pdup="' + ed.doc.cur + '"]' : '#edPageAdd');
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return this.pages();
      },
      goPageViaThumb(i) {
        const b = document.querySelector(`#edPages [data-page="${i}"]`);
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { cur: ed.doc.cur, elements: ed.design.elements.length };
      },
      movePageViaButton(i, dir) {
        const b = document.querySelector(`#edPages [data-pmove="${i}"][data-dir="${dir}"]`);
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return this.pages();
      },
      deletePageViaButton(i) {
        const b = document.querySelector(`#edPages [data-pdel="${i}"]`);
        if (!b) return null;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return this.pages();
      },
      pageThumbs() { return document.querySelectorAll('#edPages .ed-page').length; },
      exportAllVisible() { const b = document.getElementById('edExportAll'); return !!b && !b.classList.contains('hidden'); },
      async exportAll(fmt) { return exportAllPages(fmt || 'png'); },
      savedDoc() { try { return JSON.parse(localStorage.getItem('mw_design') || 'null'); } catch (e) { return null; } },
      select(id) { select(id); renderAll(); },
      selectedId() { return ed.sel; },
      toggleHidden(id) { const e = ed.design.elements.find((x) => x.id === id); if (e) { e.hidden = !e.hidden; renderAll(); } return e ? !!e.hidden : null; },
      toggleLocked(id) { const e = ed.design.elements.find((x) => x.id === id); if (e) { e.locked = !e.locked; renderAll(); } return e ? !!e.locked : null; },
      alignEl(how) { alignEl(how); const e = selected(); return e ? { x: e.x, y: e.y } : null; },
      layersHtml() { return ed.refs.drawer ? ed.refs.drawer.innerHTML : ''; },
      usedFonts() { return usedFontFamilies(ed.design); },
      designHtml() { return designToHtml(ed.design); },
      setZoom(z) { setZoom(z); return ed.scale; },
    },
  };
})();
