'use strict';
/*
 * ONE caption layout, used twice.
 *
 * The captions on the preview and the captions in the exported file used to be
 * laid out by two different engines: Chromium drew the overlay, libass drew the
 * burn. They disagreed about the only thing that matters — WHERE THE LINE
 * BREAKS. Chromium wrapped "IN NIGERIA WE" onto three lines inside a 92%-wide
 * box; libass (WrapStyle 2) never wraps at all and put it on one. Same words,
 * same style, a completely different picture: the preview was lying.
 *
 * So the layout is computed ONCE, here, in numbers that are fractions of the
 * EXPORT FRAME, and handed to both sides:
 *
 *   - the live overlay renders it at the preview frame's size,
 *   - the export rasteriser renders the same HTML at the output size,
 *
 * and because every length is the same fraction of the frame, the two are the
 * same picture at two sizes. The line breaks in particular are decided ONCE, at
 * a canonical font size, and then written out explicitly — so they cannot drift
 * with the preview window, the export resolution, or the device pixel ratio.
 *
 * Nothing in here touches the app's DOM; it only builds numbers and an HTML
 * string. That is what lets the export rasteriser reuse it verbatim.
 */
window.CapLayout = (() => {
  /** Font height as a fraction of the frame height. MUST match SIZE_PCT in
   *  src/main/captioner.js — that is the .ass fallback's copy of this table. */
  const SIZE_PCT = { s: 0.045, m: 0.058, l: 0.072, xl: 0.088 };
  /** How wide the caption block is, as a fraction of the frame — the thing the
   *  drag handles on the preview change. */
  const DEFAULT_WIDTH = 0.86;
  const MIN_WIDTH = 0.18, MAX_WIDTH = 1.0;
  /** Leading. A fixed multiple (rather than the font's own line gap) so the
   *  block's height is predictable arithmetic on both sides. */
  const LINE_HEIGHT = 1.16;
  /** Where the presets put the block, as frame fractions. `bottom` and `top`
   *  anchor an EDGE — extra lines grow inward, never off the picture. */
  const EDGE = { bottom: 0.94, top: 0.06 };
  /** Keep the whole block this far inside the frame. */
  const SAFE = 0.01;
  /** The canonical size line breaking is decided at. Any size would do; what
   *  matters is that preview and export use the SAME one. */
  const REF_PX = 200;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /* `Number(null)` is 0 and `Number('')` is 0, which is not what "no value
   * given" means anywhere in here — read as 0, a null `chars` meant "type zero
   * characters" and every caption rasterised EMPTY, and a null posX meant
   * "dragged to the very left edge". Absent is absent. */
  const num = (v, d) => (v === null || v === undefined || v === ''
    || !Number.isFinite(Number(v)) ? d : Number(v));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  /** A colour only ever gets dropped into inline CSS — never let it close the
   *  attribute or start a declaration of its own. */
  const col = (c, dflt) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? String(c) : dflt);
  const fam = (f) => String(f || 'Arial').replace(/['"\\;{}<>]/g, '');
  const widthFrac = (cfg) => clamp(num(cfg && cfg.width, DEFAULT_WIDTH), MIN_WIDTH, MAX_WIDTH);

  /* ------------------------------ measuring ------------------------------ */
  let _mc = null;
  function measurer() {
    if (!_mc) _mc = document.createElement('canvas').getContext('2d');
    return _mc;
  }
  /**
   * The width of `text` at the canonical size, in canonical pixels. Cached:
   * wrapping a whole sermon's captions asks the same questions thousands of
   * times.
   */
  const _wCache = new Map();
  function refWidth(text, family, weight) {
    const key = weight + '|' + family + '|' + text;
    let v = _wCache.get(key);
    if (v === undefined) {
      const cx = measurer();
      cx.font = weight + ' ' + REF_PX + "px '" + family + "', Arial, sans-serif";
      v = cx.measureText(text).width;
      _wCache.set(key, v);
    }
    return v;
  }
  /** Drop every cached measurement — call it when a font finishes loading, or
   *  the first captions get measured against Arial and keep that answer. */
  function forgetMeasurements() { _wCache.clear(); }

  /**
   * Break `text` into lines that fit `usableRefPx` of canonical width.
   *
   * Greedy, word by word, exactly like a browser — but decided HERE so both
   * sides get the identical answer. A single word longer than the line is left
   * alone rather than chopped mid-word: a broken word is worse than a wide one,
   * and the block is centred, so it overhangs evenly.
   */
  function wrapLines(text, family, weight, usableRefPx, gapRefPx, trackRefPx) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    if (!(usableRefPx > 0)) return [words.join(' ')];
    // A look that pads the gaps between words (see wordGap) makes every line
    // wider than the text measures, so the padding has to be part of the width
    // the break is decided on — otherwise the last word is pushed outside the
    // block on exactly the lines that were closest to fitting.
    const gap = Math.max(0, Number(gapRefPx) || 0);
    const track = Number(trackRefPx) || 0;
    const width = (s) => refWidth(s, family, weight)
      + gap * Math.max(0, s.split(/\s+/).filter(Boolean).length - 1)
      // letter spacing lands after every character but the last of the line
      + track * Math.max(0, s.length - 1);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? cur + ' ' + w : w;
      if (!cur || width(next) <= usableRefPx) { cur = next; continue; }
      lines.push(cur); cur = w;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  /* ------------------------------ geometry ------------------------------- */
  /**
   * Every length the caption needs, in the pixels of a frame `frameW`×`frameH`.
   * Called with the preview frame's size for the overlay and with the output
   * size for the export; the two results differ by exactly one scale factor.
   */
  /** The caption's font height as a fraction of the frame.
   *
   *  Four named steps, and — when the operator has asked for one — an exact
   *  figure. S/M/L/XL are 1.3x apart, which is a big jump when the size is being
   *  matched to something (a house style, another channel's look, the size the
   *  last video went out at): the answer is often between two of them, and
   *  before `sizePct` there was simply no way to say so. */
  function sizeFrac(cfg) {
    const exact = num(cfg && cfg.sizePct, 0);
    if (exact > 0) return clamp(exact, 0.01, 0.30);
    return SIZE_PCT[cfg && cfg.sizeKey] || SIZE_PCT.m;
  }
  function metrics(cfg, frameW, frameH) {
    cfg = cfg || {};
    const fontPx = Math.max(1, frameH * sizeFrac(cfg));
    return metricsAt(cfg, fontPx, frameW * widthFrac(cfg));
  }
  /** The same lengths from an explicit font size — what the little style-picker
   *  samples need, so a chip advertises the outline the burn actually draws. */
  function metricsAt(cfg, fontPx, blockW) {
    cfg = cfg || {};
    const style = cfg.style || 'shadow';
    const scale = clamp(num(cfg.outlineScale, 1), 0.5, 3);
    // ASS draws its outline entirely OUTSIDE the glyph; a CSS text-stroke is
    // centred on it. With `paint-order: stroke fill` the inner half is painted
    // over by the fill, so a stroke of 2× reads as the same weight of outline.
    const outlinePx = style === 'outline' ? fontPx * 0.09 * scale : 0;
    const strokePx = outlinePx * 2;
    const padX = style === 'box' ? fontPx * 0.45 : 0;
    const padY = style === 'box' ? fontPx * 0.14 : 0;
    const radius = style === 'box' ? fontPx * 0.18 : 0;
    // What a line of words actually has to itself, once the band's padding and
    // the outline's overhang come out of the block.
    const usablePx = Math.max(fontPx * 0.5, blockW - 2 * padX - 2 * outlinePx);
    /*
     * TRACKING — the space between letters, as a fraction of the font size, and
     * negative as often as positive. Every caption tool has it and this one did
     * not, so a look could be matched in typeface, size and colour and still
     * come out five per cent wider than the thing it was copied from, with no
     * control that could close the gap.
     */
    const trackPx = fontPx * clamp(num(cfg.tracking, 0), -0.2, 0.5);
    return { fontPx, style, outlinePx, strokePx, padX, padY, radius, blockW, usablePx, trackPx, lineHeight: LINE_HEIGHT };
  }

  /** How tall a block of `n` lines is, in the same frame's pixels. */
  function blockHeight(m, n) {
    const lineBox = m.fontPx * m.lineHeight + 2 * m.padY;
    return Math.max(1, n) * lineBox + 2 * m.outlinePx;
  }

  /**
   * Where the block's CENTRE sits, in frame pixels.
   *
   * A dragged caption owns an exact point. Otherwise the preset decides, and
   * `top`/`bottom` pin an EDGE so a caption that grows from one line to three
   * grows into the picture instead of off it. Everything is then clamped so no
   * part of the block can leave the frame — a caption you cannot see in the file
   * is the same bug as a caption in the wrong place.
   */
  function anchor(cfg, m, lineCount, frameW, frameH) {
    cfg = cfg || {};
    const h = blockHeight(m, lineCount), w = m.blockW;
    const dragged = Number.isFinite(num(cfg.posX, NaN)) && Number.isFinite(num(cfg.posY, NaN));
    let cx = (dragged ? num(cfg.posX, 0.5) : 0.5) * frameW;
    let cy;
    if (dragged) cy = num(cfg.posY, 0.88) * frameH;
    else if (cfg.position === 'top') cy = EDGE.top * frameH + h / 2;
    else if (cfg.position === 'center') cy = 0.5 * frameH;
    else cy = EDGE.bottom * frameH - h / 2;
    const mx = SAFE * frameW, my = SAFE * frameH;
    cx = (w + 2 * mx >= frameW) ? frameW / 2 : clamp(cx, mx + w / 2, frameW - mx - w / 2);
    cy = (h + 2 * my >= frameH) ? frameH / 2 : clamp(cy, my + h / 2, frameH - my - h / 2);
    return { cx, cy, w, h };
  }

  /**
   * The whole layout of one caption line, ready to draw at this frame size.
   * `lines` is decided at the canonical size, so it is the same list whatever
   * `frameW`/`frameH` are.
   */
  function layout(text, cfg, frameW, frameH) {
    cfg = cfg || {};
    const m = metrics(cfg, frameW, frameH);
    const family = fam(cfg.family || cfg.font);
    const weight = cfg.bold === false ? '400' : '800';
    // the usable width in CANONICAL pixels — a pure ratio, so the answer does
    // not depend on which frame asked
    const usableRef = m.usablePx * (REF_PX / m.fontPx);
    const lines = wrapLines(text, family, weight, usableRef,
      Math.max(0, num(cfg.wordGap, 0)) * REF_PX, clamp(num(cfg.tracking, 0), -0.2, 0.5) * REF_PX);
    const a = anchor(cfg, m, lines.length, frameW, frameH);
    return { lines, m, cfg, family, weight, cx: a.cx, cy: a.cy, blockW: a.w, blockH: a.h };
  }

  /* ------------------------------- drawing ------------------------------- */
  const cssPx = (v) => (Math.round(v * 1000) / 1000) + 'px';

  /** The stroke and shadow an outlined look wears — shared by the whole-line
   *  form and the per-word form so they cannot drift apart. */
  function strokeCss(L, outline) {
    const c = L.m, cfg = L.cfg || {};
    if (c.style !== 'outline') return '';
    let s = '-webkit-text-stroke:' + cssPx(c.strokePx) + ' ' + outline + ';paint-order:stroke fill;';
    if (clamp(num(cfg.outlineScale, 1), 0.5, 3) > 1.2) {
      s += 'text-shadow:0 0 ' + cssPx(c.fontPx * 0.28) + ' ' + outline + ';';
    } else {
      const sh = c.outlinePx / 2;
      if (sh >= 0.5) s += 'text-shadow:' + cssPx(sh) + ' ' + cssPx(sh) + ' 0 ' + outline + ';';
    }
    return s;
  }

  /** The inline CSS one LINE of words wears — the look, drawn per line, so a
   *  boxed style gives the CapCut band-per-line rather than one tall slab.
   *
   *  `override` recolours ONE element without disturbing anything else about the
   *  look — it is how the spoken word is picked out in highlight mode, and why
   *  the highlighted word keeps the same outline, band and shadow as its
   *  neighbours instead of becoming a different-looking caption. */
  function lineCss(L, override, part) {
    const c = L.m, cfg = L.cfg || {};
    const color = col(override || cfg.color, '#ffffff');
    const outline = col(cfg.outline, '#000000');
    let s = 'display:inline-block;color:' + color + ';';
    /*
     * `part` splits the look in two for highlight mode: 'band' is what the LINE
     * wears, 'ink' is what each word wears. Only a boxed look has anything to
     * split, and it has to be split — a band drawn per word is four bands with
     * gaps between them, which is not what the .ass side draws (BorderStyle 3
     * paints one band per Dialogue line) and so would be the two engines
     * disagreeing about the same caption again.
     */
    if (part === 'ink') return 'display:inline-block;color:' + color + ';' + strokeCss(L, outline);
    if (c.style === 'box') {
      s += 'background:' + outline + ';padding:' + cssPx(c.padY) + ' ' + cssPx(c.padX)
        + ';border-radius:' + cssPx(c.radius) + ';';
    } else if (c.style === 'outline') {
      s += strokeCss(L, outline);
    } else {
      const o = c.fontPx * 0.05;
      s += 'text-shadow:0 ' + cssPx(o) + ' ' + cssPx(o * 2) + ' rgba(0,0,0,.85),0 0 ' + cssPx(o) + ' rgba(0,0,0,.7);';
    }
    return s;
  }

  /** The first `n` characters of an already-wrapped block (typewriter). */
  function typedLines(lines, n) {
    const out = [];
    let left = Math.max(0, Math.round(n));
    for (const l of lines) {
      if (left <= 0) break;
      out.push(left >= l.length ? l : l.slice(0, left));
      left -= l.length + 1; // the line break counts as the space it replaced
    }
    return out;
  }

  /* ----------------------- the word being spoken -------------------------
   *
   * HIGHLIGHT MODE. The whole line stays on the picture and the word currently
   * coming out of the speaker's mouth is painted a second colour, switching on
   * that word's own boundary. It is the thing that reads as "edited" in a short:
   * the line is readable a beat before it is said, and the colour tells you
   * exactly where the voice is.
   *
   * Note what it is NOT. Karaoke `\k` in a subtitle file sweeps text from the
   * secondary colour to the primary as it is sung — every word before the
   * playhead stays changed. That is a two-state wipe; this is three states
   * (coming, now, said) with only ONE word ever picked out, so it is drawn as a
   * word per element rather than as a colour sweep.
   */

  /**
   * The words of `event`, each with the moment it is spoken, aligned one-to-one
   * with the whitespace tokens of the text that will actually be DRAWN.
   *
   * The transcriber hands over real per-word timings and those are used verbatim
   * — that is what makes the colour land on the voice rather than near it. But
   * a caption can also be retyped by hand on the timeline, and then the stored
   * words describe a line that no longer exists. Rather than switch the effect
   * off (a caption that silently loses its highlight because a typo was fixed is
   * a worse answer), the line's own span is shared out across the new tokens in
   * proportion to their length, which is close enough to read as deliberate and
   * cannot be wrong about where the line starts and ends.
   */
  function wordTimes(event) {
    const e = event || {};
    const toks = String(e.text == null ? '' : e.text).split(/\s+/).filter(Boolean);
    if (!toks.length) return [];
    const start = num(e.start, 0), end = Math.max(start + 0.06, num(e.end, start + 1));
    const given = Array.isArray(e.words) ? e.words.filter((w) => w && String(w.text || '').trim()) : [];
    if (given.length === toks.length) {
      return toks.map((t, i) => ({
        text: t,
        start: clamp(num(given[i].start, start), start, end),
        end: clamp(num(given[i].end, end), start, end),
      }));
    }
    const total = toks.reduce((s, t) => s + t.length, 0) || toks.length;
    let acc = 0;
    return toks.map((t) => {
      const a = start + (end - start) * (acc / total);
      acc += t.length;
      return { text: t, start: a, end: start + (end - start) * (acc / total) };
    });
  }

  /**
   * Which word of `event` is being spoken at `tSec` — an index into wordTimes(),
   * or -1 for none.
   *
   * A word holds the colour until the NEXT word starts, not until its own end
   * timestamp: whisper leaves a gap wherever the speaker drew breath, and
   * dropping the highlight into every one of those gaps flickers.
   */
  function activeWord(words, tSec) {
    if (!words || !words.length) return -1;
    const t = num(tSec, 0);
    if (t < words[0].start) return -1;
    for (let i = words.length - 1; i >= 0; i--) if (t >= words[i].start) return i;
    return -1;
  }

  /** Extra space between words, in frame pixels — 0 unless the look asks for it. */
  const wordGapPx = (L) => Math.max(0, num((L.cfg || {}).wordGap, 0)) * L.m.fontPx;
  const highlightOn = (cfg) => !!(cfg && cfg.wordHighlight && cfg.wordColor);

  /**
   * One line as elements. Without a highlight that is the single span it always
   * was; with one, a span per word so exactly one of them can be recoloured.
   * `from` is the index this line's first word has within the whole caption.
   */
  function lineHtml(L, text, from, hl) {
    const cfg = L.cfg || {};
    const gap = wordGapPx(L);
    const marks = highlightOn(cfg) && hl != null && hl >= 0;
    // Nothing to pick out and no extra spacing asked for: one span, exactly as
    // every look that came before drew it.
    if (!marks && !(gap > 0)) return '<span style="' + lineCss(L) + '">' + esc(text) + '</span>';
    const toks = String(text).split(/\s+/).filter(Boolean);
    const boxed = L.m.style === 'box';
    const words = toks.map((w, i) => {
      const on = marks && (from + i) === hl;
      const extra = (i > 0 && gap > 0) ? 'margin-left:' + cssPx(gap) + ';' : '';
      return '<span style="' + lineCss(L, on ? cfg.wordColor : null, boxed ? 'ink' : null) + extra + '">' + esc(w) + '</span>';
    }).join(' ');
    // The band belongs to the line; the colour belongs to the word.
    return boxed ? '<span style="' + lineCss(L) + '">' + words + '</span>' : words;
  }

  /**
   * The caption as absolutely-positioned HTML on a page `frameW`×`frameH`.
   *
   * `originX`/`originY` shift it (the export rasteriser draws onto a BAND cut
   * out of the frame, not onto the whole frame). `state` carries a transition's
   * scale/opacity, for the typewriter how many characters are typed, and for
   * highlight mode which word (`hl`) is being spoken.
   */
  function html(text, cfg, frameW, frameH, opts) {
    const o = opts || {};
    const L = o.layout || layout(text, cfg, frameW, frameH);
    if (!L.lines.length) return '';
    const st = o.state || {};
    const sx = num(st.sx, 1), sy = num(st.sy, 1), op = clamp(num(st.opacity, 1), 0, 1);
    const ox = num(o.originX, 0), oy = num(o.originY, 0);
    let lines = L.lines;
    const chars = num(st.chars, NaN);
    if (Number.isFinite(chars)) lines = typedLines(lines, chars);
    if (!lines.length) return '';
    const hl = num(st.hl, -1);
    let seen = 0;
    const body = lines.map((t) => {
      const h = lineHtml(L, t, seen, hl);
      seen += String(t).split(/\s+/).filter(Boolean).length;
      return h;
    }).join('<br/>');
    const tf = 'translate(-50%,-50%)' + ((sx !== 1 || sy !== 1) ? ' scale(' + sx + ',' + sy + ')' : '');
    return '<div style="position:absolute;left:' + cssPx(L.cx - ox) + ';top:' + cssPx(L.cy - oy)
      + ';width:' + cssPx(L.blockW) + ';transform:' + tf + ';transform-origin:50% 50%;'
      + (op < 1 ? 'opacity:' + op.toFixed(3) + ';' : '')
      + 'text-align:center;line-height:' + L.m.lineHeight + ";font-family:'" + L.family + "',Arial,sans-serif;"
      /*
       * Letter spacing belongs on the BLOCK, not on each word.
       *
       * Put on the word spans it skips the spaces between them, while the .ass
       * side — where the whole line is one run — spaces those too. The line then
       * comes out the same total width in both engines with the words sitting in
       * different places inside it, which measured 18px apart on a 576-wide
       * frame. On the block, both engines space every character of the line
       * including its spaces, and the words land together.
       */
      + 'font-size:' + cssPx(L.m.fontPx) + ';font-weight:' + L.weight + ';font-style:normal;'
      + 'letter-spacing:' + (Math.abs(L.m.trackPx) > 0.01 ? cssPx(L.m.trackPx) : 'normal') + ';'
      // grayscale antialiasing on both sides: the screen would otherwise use LCD
      // subpixel rendering, which puts orange and blue on the letter edges that
      // no exported frame can contain
      + '-webkit-font-smoothing:antialiased;white-space:pre;word-break:normal;">' + body + '</div>';
  }

  /* ----------------------------- transitions -----------------------------
   * The same arrivals the .ass burner writes as override tags, expressed as a
   * scale / opacity / typed-characters state at a moment in the line's life —
   * so the preview can ANIMATE them and the export rasteriser can draw them.
   * The timings are the burner's, to the millisecond.
   */
  const TRANSITIONS = ['none', 'fade', 'pop', 'bounce', 'slideup', 'zoom', 'typewriter'];
  const capMs = (v, max) => Math.max(30, Math.min(max, Math.round(v)));
  /** How long the arrival lasts, in seconds (0 when there isn't one). */
  function enterDuration(id, durSec) {
    const ms = Math.max(60, (durSec || 1) * 1000);
    switch (id) {
      case 'fade': return capMs(ms * 0.35, 200) / 1000;
      case 'pop': return capMs(ms * 0.30, 140) / 1000;
      case 'bounce': return Math.max(capMs(ms * 0.25, 110) + 30, capMs(ms * 0.45, 190)) / 1000;
      case 'slideup': return capMs(ms * 0.32, 160) / 1000;
      case 'zoom': return capMs(ms * 0.33, 170) / 1000;
      case 'typewriter': return Math.min((durSec || 1) * 0.5, 0.9);
      default: return 0;
    }
  }
  /** The state of a line `tRel` seconds after it appeared. */
  function stateAt(id, tRel, durSec, textLen) {
    const t = Math.max(0, tRel), D = Math.max(0.06, durSec || 1);
    const ms = Math.max(60, D * 1000);
    const lin = (a, b, x) => a + (b - a) * clamp(x, 0, 1);
    switch (id) {
      case 'fade': {
        const din = capMs(ms * 0.35, 200) / 1000, dout = capMs(ms * 0.25, 160) / 1000;
        const inO = din > 0 ? clamp(t / din, 0, 1) : 1;
        const outO = dout > 0 ? clamp((D - t) / dout, 0, 1) : 1;
        return { sx: 1, sy: 1, opacity: Math.min(inO, outO) };
      }
      case 'pop': {
        const d = capMs(ms * 0.30, 140) / 1000, k = lin(0.6, 1, d ? t / d : 1);
        return { sx: k, sy: k, opacity: 1 };
      }
      case 'bounce': {
        const a = capMs(ms * 0.25, 110) / 1000;
        const b = Math.max(a + 0.03, capMs(ms * 0.45, 190) / 1000);
        const k = t < a ? lin(0.45, 1.12, a ? t / a : 1) : lin(1.12, 1, (t - a) / Math.max(0.001, b - a));
        return { sx: k, sy: k, opacity: 1 };
      }
      case 'slideup': {
        const d = capMs(ms * 0.32, 160) / 1000;
        return { sx: 1, sy: lin(0.55, 1, d ? t / d : 1), opacity: clamp(t / Math.max(0.001, d * 0.8), 0, 1) };
      }
      case 'zoom': {
        const d = capMs(ms * 0.33, 170) / 1000, k = lin(1.65, 1, d ? t / d : 1);
        return { sx: k, sy: k, opacity: 1 };
      }
      case 'typewriter': {
        const n = Math.max(1, textLen || 1);
        const typeFor = Math.min(D * 0.5, 0.9);
        const done = typeFor <= 0 ? 1 : clamp(t / typeFor, 0, 1);
        return { sx: 1, sy: 1, opacity: 1, chars: Math.max(1, Math.ceil(done * n)) };
      }
      default: return { sx: 1, sy: 1, opacity: 1 };
    }
  }
  /** The largest the block ever gets — how much room the export band needs. */
  function maxScale(id) { return id === 'zoom' ? 1.65 : id === 'bounce' ? 1.12 : 1; }

  return {
    SIZE_PCT, DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH, LINE_HEIGHT, REF_PX, EDGE, SAFE, TRANSITIONS,
    widthFrac, sizeFrac, metrics, metricsAt, blockHeight, anchor, layout, html, lineCss, lineHtml, typedLines,
    wrapLines, refWidth, forgetMeasurements,
    enterDuration, stateAt, maxScale,
    wordTimes, activeWord, highlightOn,
  };
})();
