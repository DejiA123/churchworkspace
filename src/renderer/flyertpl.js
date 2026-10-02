'use strict';
/*
 * Flyer Maker — template engine + "Magic Create" (free, on-device AI).
 *
 * - PALETTES: colour schemes inspired by real church-event flyers.
 * - Art builders: self-contained SVG data-URI backgrounds (gradients, rain
 *   streaks, fire glows, neon sparkles, rays, bokeh…) — safe inside the
 *   foreignObject export because everything is a data: URI.
 * - TEMPLATES: build(data, w, h, palette) → a design in the editor's element
 *   format (movable/editable layers, photo placeholder slots).
 * - parseEventText(): extracts title/theme/speakers/date/time/venue/church
 *   from free text the user types.
 * - generateDesigns(): text → several ready-made flyers, ranked by vibe.
 */
(function () {
  const uid = () => 'e' + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /* ============================ palettes ============================ */
  // deep/deep2 = background darks, base = background mid, accent/accent2 =
  // highlight colours, ink = main text, chipInk = text on accent chips.
  const PALETTES = {
    emerald:  { name: 'Emerald',  deep: '#02291a', deep2: '#0a7a3c', base: '#12a44f', accent: '#c9f731', accent2: '#ffffff', ink: '#ffffff', chipInk: '#06301d' },
    lime:     { name: 'Lime Rain', deep: '#0b5c14', deep2: '#2f9e1a', base: '#54cf17', accent: '#eaff2e', accent2: '#ffffff', ink: '#ffffff', chipInk: '#123a06' },
    fire:     { name: 'Fire',     deep: '#160301', deep2: '#71190a', base: '#c2410c', accent: '#ffb300', accent2: '#ffe066', ink: '#ffffff', chipInk: '#2b0a02' },
    neon:     { name: 'Neon Party', deep: '#0a0523', deep2: '#231251', base: '#37207f', accent: '#ff2fd6', accent2: '#19e0ff', ink: '#ffffff', chipInk: '#140a33' },
    sky:      { name: 'Sky',      deep: '#1c5e96', deep2: '#5aa7d8', base: '#a8d4ef', accent: '#ffd54a', accent2: '#ffffff', ink: '#0e3a61', chipInk: '#0e3a61' },
    royal:    { name: 'Royal Gold', deep: '#080d20', deep2: '#16264c', base: '#22366b', accent: '#e8c15a', accent2: '#f7e7b3', ink: '#ffffff', chipInk: '#171004' },
    midnight: { name: 'Midnight', deep: '#04060c', deep2: '#0e1a30', base: '#16263f', accent: '#4da3ff', accent2: '#bfe0ff', ink: '#ffffff', chipInk: '#03101f' },
    crimson:  { name: 'Crimson',  deep: '#1c0205', deep2: '#6f0e1c', base: '#a4172a', accent: '#ffd166', accent2: '#ffffff', ink: '#ffffff', chipInk: '#31050c' },
    sunset:   { name: 'Sunset',   deep: '#2c0c46', deep2: '#8f2a4e', base: '#e4653a', accent: '#ffd166', accent2: '#ffe9c7', ink: '#ffffff', chipInk: '#361233' },
    ocean:    { name: 'Ocean',    deep: '#012a30', deep2: '#02565c', base: '#079e8e', accent: '#8ef5d2', accent2: '#ffffff', ink: '#ffffff', chipInk: '#02343a' },
    mono:     { name: 'Ink',      deep: '#0d0d0f', deep2: '#232327', base: '#3a3a41', accent: '#f5a623', accent2: '#ffffff', ink: '#ffffff', chipInk: '#141416' },
    paper:    { name: 'Paper',    deep: '#f4efe4', deep2: '#e9e1cd', base: '#fbf8f1', accent: '#8a6d27', accent2: '#42351a', ink: '#28221a', chipInk: '#f8f4ea' },
    army:     { name: 'Army Green', deep: '#08190a', deep2: '#1c4a14', base: '#2f7a1a', accent: '#7dff2e', accent2: '#d9ffb8', ink: '#ffffff', chipInk: '#0c2a05' },
    gold:     { name: 'Black & Gold', deep: '#0b0805', deep2: '#291d0b', base: '#453113', accent: '#f2c94c', accent2: '#f8e7b0', ink: '#ffffff', chipInk: '#241a05' },
    spotlight:{ name: 'Spotlight Red', deep: '#08090c', deep2: '#17181d', base: '#26272d', accent: '#e5342a', accent2: '#ffffff', ink: '#ffffff', chipInk: '#2a0604' },
    scripture:{ name: 'Scripture', deep: '#071022', deep2: '#0f2447', base: '#123a6b', accent: '#eec158', accent2: '#f6e9c6', ink: '#ffffff', chipInk: '#2a1f06' },
    purple:   { name: 'Purple Gold', deep: '#160431', deep2: '#3a1178', base: '#6d28d9', accent: '#f5c542', accent2: '#eaddff', ink: '#ffffff', chipInk: '#22103a' },
  };

  /* ======================= element factories ======================= */
  function T(o) {
    return Object.assign({
      id: uid(), type: 'text', text: '', x: 0, y: 0, w: 200, h: 60, rot: 0,
      font: 'Montserrat', size: 40, color: '#ffffff', weight: 700, italic: false,
      align: 'left', lineHeight: 1.08, letter: 0, stroke: 0, strokeColor: '#000000',
      bg: 'transparent', opacity: 1, shadow: false, effect: 'none', fxColor: '',
    }, o);
  }
  function R(o) {
    return Object.assign({
      id: uid(), type: 'rect', x: 0, y: 0, w: 100, h: 100, rot: 0, fill: '#ffffff',
      radius: 0, opacity: 1, borderColor: '#ffffff', borderWidth: 0,
    }, o);
  }
  function IMG(o) {
    return Object.assign({
      id: uid(), type: 'image', src: '', x: 0, y: 0, w: 100, h: 100, rot: 0,
      fit: 'cover', radius: 0, opacity: 1, flipH: false, flipV: false,
    }, o);
  }

  /* ====================== SVG artwork builders ====================== */
  const svgUri = (w, h, inner) =>
    'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">${inner}</svg>`);

  // Wrapper for the ARTWORK backgrounds: finishes every design with a soft
  // edge vignette + fine film grain. The grain dithers away the visible
  // banding ("pixel lines") that large smooth gradients produce, and the
  // vignette blends the edges like professionally designed flyers.
  const artUri = (w, h, inner) => svgUri(w, h, inner + `
      <defs>
        <radialGradient id="vg" cx="0.5" cy="0.42" r="0.95">
          <stop offset="0.55" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.36"/>
        </radialGradient>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" stitchTiles="stitch"/>
          <feColorMatrix type="saturate" values="0"/>
        </filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#vg)"/>
      <rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.05"/>`);

  // SVG filters clip at 120% of the element's bounding box by default — a
  // heavily blurred glow gets cut into a visible RECTANGLE. Every blur filter
  // must carry this expanded region.
  const BLUR_REGION = 'x="-100%" y="-100%" width="300%" height="300%"';

  // Deterministic pseudo-random so template previews & tests are stable.
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  const bgImage = (src) => ({ type: 'image', color: '#000000', src, fit: 'cover' });

  /* ==================== HD photo background library ==================== */
  // Real photos bundled in assets/photos (Unsplash License — see CREDITS.md).
  // Loaded once as data URIs (the export pipeline can't fetch file paths),
  // then templates prefer them over the procedural SVG artwork.
  const PHOTOS = [
    { id: 'fire-flames', name: 'Fire flames', tags: 'fire flame burn hot power revival supernatural' },
    { id: 'fire-embers', name: 'Campfire embers', tags: 'fire embers sparks camp bonfire night' },
    { id: 'smoke-red', name: 'Red smoke', tags: 'smoke red war battle dark dramatic fire' },
    { id: 'smoke-crimson', name: 'Crimson smoke', tags: 'smoke crimson red dark moody war' },
    { id: 'smoke-teal', name: 'Teal smoke', tags: 'smoke teal dark storm clouds moody ocean' },
    { id: 'city-night', name: 'City at night', tags: 'city skyline night lights urban buildings conference' },
    { id: 'city-gold', name: 'Golden city', tags: 'city skyline sunset gold buildings urban' },
    { id: 'storm-fire-sky', name: 'Fire storm sky', tags: 'storm lightning war sky dramatic apocalyptic fire battle' },
    { id: 'storm-lightning', name: 'Lightning strike', tags: 'storm lightning thunder power night dramatic' },
    { id: 'clouds-gold', name: 'Golden clouds', tags: 'clouds gold sunset heaven sky glory thanksgiving' },
    { id: 'clouds-dark-gold', name: 'Dark gold clouds', tags: 'clouds dark gold dramatic sky heaven storm' },
    { id: 'sky-rays', name: 'Rays through clouds', tags: 'rays light clouds heaven sky crusade glory hope' },
    { id: 'sky-rays-dark', name: 'God rays', tags: 'rays light clouds heaven dark crusade revival' },
    { id: 'stars-purple', name: 'Purple starfield', tags: 'stars night sky purple vigil galaxy worship' },
    { id: 'galaxy', name: 'Galaxy nebula', tags: 'galaxy stars space nebula night glory wonder' },
    { id: 'stars-night', name: 'Night stars', tags: 'stars night dark sky vigil midnight prayer' },
    { id: 'mountain-night', name: 'Mountain night sky', tags: 'mountain stars night milky way majesty vigil' },
    { id: 'worship-gold', name: 'Worship hands gold', tags: 'worship hands praise crowd golden concert church' },
    { id: 'worship-blue', name: 'Worship hands blue', tags: 'worship hands praise crowd blue lights concert church' },
    { id: 'concert-fire-glow', name: 'Stage fire glow', tags: 'concert stage lights orange fire crowd worship praise' },
    { id: 'concert-gold', name: 'Golden concert', tags: 'concert crowd gold lights praise worship night' },
    { id: 'concert-neon', name: 'Neon stage', tags: 'concert neon party stage pink blue lights youth' },
    { id: 'party-confetti', name: 'Confetti party', tags: 'party confetti celebration crowd purple jam youth' },
    { id: 'bokeh-gold', name: 'Gold bokeh', tags: 'bokeh gold lights celebration elegant anniversary' },
    { id: 'bokeh-gold-rain', name: 'Gold sparkle rain', tags: 'bokeh gold sparkle glitter celebration elegant' },
    { id: 'glow-gold', name: 'Golden glow', tags: 'glow gold light soft elegant celebration royal' },
    { id: 'soldiers-march', name: 'Soldiers marching', tags: 'army soldiers military march war volunteers battalion' },
    { id: 'soldiers-ridge', name: 'Soldiers on ridge', tags: 'army soldiers military ridge war mission volunteers' },
    { id: 'soldier-watch', name: 'Soldier watch', tags: 'army soldier military rifle watch war battle' },
    { id: 'rain-street', name: 'Rainy street', tags: 'rain umbrella street city night abundance overflow' },
    { id: 'highlands-green', name: 'Green highlands', tags: 'green nature mountains clouds harvest growth' },
    { id: 'royal-purple', name: 'Royal purple', tags: 'purple gradient royal abstract worship majesty' },
    { id: 'bible-open', name: 'Open Bible', tags: 'bible word study scripture book teaching devotional the word read gospel church midweek' },
    { id: 'praying-hands', name: 'Praying hands on Bible', tags: 'prayer praying hands bible intercession fasting vigil supplication devotional altar meeting cry' },
    { id: 'worship-sunset', name: 'Worship at sunset', tags: 'worship surrender hands raised sunset praise thanksgiving encounter freedom outdoor glory' },
    { id: 'jesus-worship', name: 'Jesus worship night', tags: 'worship jesus praise crowd hands raised concert night revival encounter atmosphere youth' },
    { id: 'surrender-sunrise', name: 'Surrender at sunrise', tags: 'surrender hands raised sunrise worship thanksgiving hope new season revival dawn glory' },
  ];
  const PHOTO_DATA = {}; // id -> data URI, filled by loadPhotoLibrary()

  async function loadPhotoLibrary() {
    if (!window.api || !window.api.photos || !window.api.photos.list) return 0;
    try {
      const files = await window.api.photos.list();
      const byName = {};
      files.forEach((f) => { byName[f.name.replace(/\.jpe?g$/i, '')] = f.path; });
      for (const ph of PHOTOS) {
        if (!PHOTO_DATA[ph.id] && byName[ph.id]) {
          PHOTO_DATA[ph.id] = await window.api.fs.readImageDataUrl(byName[ph.id]);
        }
      }
    } catch (err) { /* photos are an enhancement — templates fall back to artwork */ }
    return Object.keys(PHOTO_DATA).length;
  }
  const photoSrc = (id) => PHOTO_DATA[id] || '';
  const photosLoaded = () => Object.keys(PHOTO_DATA).length;

  // Best-matching LOADED photo for a keyword query; nth picks runners-up so
  // different palettes of one template can use different photos.
  function pickPhoto(query, nth) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const scored = PHOTOS
      .filter((ph) => PHOTO_DATA[ph.id])
      .map((ph) => ({ id: ph.id, score: words.reduce((s, w) => s + (ph.tags.includes(w) ? 1 : 0), 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    return scored[Math.min(nth || 0, scored.length - 1)].id;
  }

  function rgba(hex, a) {
    const m = String(hex).replace('#', '');
    const n = parseInt(m.length === 3 ? m.replace(/./g, '$&$&') : m, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  // Colour-wash overlays that keep text readable over real photos.
  // 'duo' = strong palette duotone (army green look); 'dark' = subtle darken.
  function scrim(p, kind) {
    if (kind === 'duo') return `linear-gradient(180deg,${rgba(p.base, 0.62)} 0%,${rgba(p.deep2, 0.72)} 55%,${rgba(p.deep, 0.94)} 100%)`;
    if (kind === 'tint') return `linear-gradient(180deg,${rgba(p.deep, 0.66)} 0%,${rgba(p.deep, 0.38)} 40%,${rgba(p.deep, 0.88)} 100%)`;
    return 'linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.28) 42%,rgba(0,0,0,0.72) 100%)';
  }
  // Photo-backed background when the library is loaded, else procedural art.
  // Palettes with DARK ink (sky, paper) are designed for light artwork — a
  // dark photo would swallow their text, so they keep the procedural art.
  function photoOrArt(query, p, artFn, w, h, kind, nth) {
    const darkInk = p && String(p.ink).toLowerCase() !== '#ffffff';
    const id = darkInk ? null : pickPhoto(query, nth);
    if (id) return { type: 'image', color: '#000000', src: PHOTO_DATA[id], photoId: id, fit: 'cover', overlay: scrim(p, kind) };
    return bgImage(artFn(p, w, h));
  }

  function artRain(p, w, h) {
    const r = rng(7);
    let streaks = '';
    for (let i = 0; i < 46; i++) {
      const x = r() * w, y = r() * h, len = 60 + r() * 240, wd = 2 + r() * 5, op = 0.10 + r() * 0.25;
      streaks += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${wd.toFixed(1)}" height="${len.toFixed(0)}" rx="${(wd / 2).toFixed(1)}" fill="#ffffff" opacity="${op.toFixed(2)}" transform="rotate(14 ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" stop-color="${p.deep2}"/><stop offset="0.45" stop-color="${p.base}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.055)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.78}" cy="${h * 0.12}" rx="${w * 0.5}" ry="${h * 0.22}" fill="${p.accent}" opacity="0.5" filter="url(#b)"/>
      <ellipse cx="${w * 0.1}" cy="${h * 0.9}" rx="${w * 0.45}" ry="${h * 0.2}" fill="${p.deep}" opacity="0.8" filter="url(#b)"/>
      ${streaks}`);
  }

  function artFire(p, w, h) {
    const r = rng(21);
    let embers = '';
    for (let i = 0; i < 34; i++) {
      const x = r() * w, y = h * 0.35 + r() * h * 0.65, s = 2 + r() * 7;
      embers += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="${i % 3 ? p.accent : p.accent2}" opacity="${(0.25 + r() * 0.6).toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="0.55" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.base}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.06)}"/></filter>
        <filter id="b2" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.02)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 1.02}" rx="${w * 0.75}" ry="${h * 0.3}" fill="${p.base}" opacity="0.95" filter="url(#b)"/>
      <ellipse cx="${w * 0.2}" cy="${h * 0.98}" rx="${w * 0.3}" ry="${h * 0.16}" fill="${p.accent}" opacity="0.75" filter="url(#b)"/>
      <ellipse cx="${w * 0.85}" cy="${h * 0.96}" rx="${w * 0.28}" ry="${h * 0.14}" fill="${p.accent}" opacity="0.7" filter="url(#b)"/>
      <ellipse cx="${w * 0.55}" cy="${h * 0.99}" rx="${w * 0.18}" ry="${h * 0.1}" fill="${p.accent2}" opacity="0.8" filter="url(#b2)"/>
      ${embers}`);
  }

  function artNeon(p, w, h) {
    const r = rng(5);
    let sparks = '';
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * h, s = 4 + r() * 14, op = 0.35 + r() * 0.6;
      const c = [p.accent, p.accent2, '#ff9d00'][i % 3];
      sparks += `<path d="M ${x} ${y - s} L ${x + s * 0.28} ${y - s * 0.28} L ${x + s} ${y} L ${x + s * 0.28} ${y + s * 0.28} L ${x} ${y + s} L ${x - s * 0.28} ${y + s * 0.28} L ${x - s} ${y} L ${x - s * 0.28} ${y - s * 0.28} Z" fill="${c}" opacity="${op.toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="0.6" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.base}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.07)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.06}" cy="${h * 0.2}" rx="${w * 0.3}" ry="${h * 0.16}" fill="${p.accent}" opacity="0.55" filter="url(#b)"/>
      <ellipse cx="${w * 0.95}" cy="${h * 0.3}" rx="${w * 0.3}" ry="${h * 0.18}" fill="${p.accent2}" opacity="0.5" filter="url(#b)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 1.0}" rx="${w * 0.5}" ry="${h * 0.2}" fill="#ff9d00" opacity="0.45" filter="url(#b)"/>
      ${sparks}`);
  }

  function artSky(p, w, h) {
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.base}"/><stop offset="0.55" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.04)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <polygon points="${w * 0.5},0 ${w * 0.05},${h} ${w * 0.28},${h}" fill="#ffffff" opacity="0.10"/>
      <polygon points="${w * 0.5},0 ${w * 0.45},${h} ${w * 0.62},${h}" fill="#ffffff" opacity="0.12"/>
      <polygon points="${w * 0.5},0 ${w * 0.78},${h} ${w * 0.98},${h}" fill="#ffffff" opacity="0.10"/>
      <ellipse cx="${w * 0.18}" cy="${h * 0.3}" rx="${w * 0.3}" ry="${h * 0.07}" fill="#ffffff" opacity="0.75" filter="url(#b)"/>
      <ellipse cx="${w * 0.85}" cy="${h * 0.16}" rx="${w * 0.34}" ry="${h * 0.08}" fill="#ffffff" opacity="0.65" filter="url(#b)"/>
      <ellipse cx="${w * 0.6}" cy="${h * 0.45}" rx="${w * 0.4}" ry="${h * 0.08}" fill="#ffffff" opacity="0.4" filter="url(#b)"/>`);
  }

  function artRays(p, w, h) {
    const cx = w / 2, cy = h * 0.32; let rays = '';
    for (let i = 0; i < 18; i++) {
      const a1 = (i * 20) * Math.PI / 180, a2 = (i * 20 + 9) * Math.PI / 180, R2 = Math.max(w, h) * 1.4;
      rays += `<polygon points="${cx},${cy} ${(cx + Math.cos(a1) * R2).toFixed(0)},${(cy + Math.sin(a1) * R2).toFixed(0)} ${(cx + Math.cos(a2) * R2).toFixed(0)},${(cy + Math.sin(a2) * R2).toFixed(0)}" fill="${p.accent}" opacity="0.10"/>`;
    }
    return artUri(w, h, `
      <defs>
        <radialGradient id="g" cx="0.5" cy="0.3" r="1">
          <stop offset="0" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </radialGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.05)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>${rays}
      <ellipse cx="${cx}" cy="${cy}" rx="${w * 0.3}" ry="${w * 0.3}" fill="${p.accent}" opacity="0.3" filter="url(#b)"/>`);
  }

  function artBokeh(p, w, h) {
    const r = rng(11); let dots = '';
    for (let i = 0; i < 30; i++) {
      const x = r() * w, y = r() * h, s = 6 + r() * (w * 0.06), op = 0.06 + r() * 0.3;
      dots += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(0)}" fill="${i % 4 ? p.accent : p.accent2}" opacity="${op.toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="0.6" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.012)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <g filter="url(#b)">${dots}</g>`);
  }

  function artWaves(p, w, h) {
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="0.65" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.base}"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <path d="M0 ${h * 0.78} Q ${w * 0.25} ${h * 0.7} ${w * 0.5} ${h * 0.78} T ${w} ${h * 0.78} L ${w} ${h} L 0 ${h} Z" fill="${p.base}" opacity="0.55"/>
      <path d="M0 ${h * 0.85} Q ${w * 0.25} ${h * 0.78} ${w * 0.5} ${h * 0.85} T ${w} ${h * 0.85} L ${w} ${h} L 0 ${h} Z" fill="${p.accent}" opacity="0.35"/>
      <path d="M0 ${h * 0.92} Q ${w * 0.25} ${h * 0.85} ${w * 0.5} ${h * 0.92} T ${w} ${h * 0.92} L ${w} ${h} L 0 ${h} Z" fill="${p.deep}" opacity="0.9"/>`);
  }

  function artHalftone(p, w, h) {
    let dots = '';
    const step = Math.round(w / 26);
    for (let yy = 0; yy < 10; yy++) for (let xx = 0; xx < 12; xx++) {
      const rr = Math.max(0.6, (10 - yy - xx * 0.35) * step * 0.05);
      if (rr > 0.7) dots += `<circle cx="${w - xx * step - step / 2}" cy="${yy * step + step / 2}" r="${rr.toFixed(1)}" fill="${p.accent}" opacity="0.5"/>`;
    }
    let dots2 = '';
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 10; xx++) {
      const rr = Math.max(0.6, (8 - yy - xx * 0.4) * step * 0.05);
      if (rr > 0.7) dots2 += `<circle cx="${xx * step + step / 2}" cy="${h - yy * step - step / 2}" r="${rr.toFixed(1)}" fill="${p.accent2}" opacity="0.35"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="1" stop-color="${p.deep2}"/>
        </linearGradient>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>${dots}${dots2}`);
  }

  function artClean(p, w, h) {
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0.7" y2="1">
          <stop offset="0" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.06)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <circle cx="${w * 0.92}" cy="${h * 0.08}" r="${w * 0.35}" fill="${p.accent}" opacity="0.4" filter="url(#b)"/>
      <circle cx="${w * 0.05}" cy="${h * 0.95}" r="${w * 0.3}" fill="${p.base}" opacity="0.5" filter="url(#b)"/>`);
  }

  // Creative Bible artwork for Bible-study / Word-study flyers: a glowing open
  // book at centre with radiant light rays and a soft cross halo behind it.
  function artBible(p, w, h) {
    const cx = w / 2, cy = h * 0.46;
    const R2 = Math.max(w, h) * 1.5; let rays = '';
    for (let i = 0; i < 24; i++) {
      const a1 = (i * 15) * Math.PI / 180, a2 = (i * 15 + 6) * Math.PI / 180;
      rays += `<polygon points="${cx},${cy} ${(cx + Math.cos(a1) * R2).toFixed(0)},${(cy + Math.sin(a1) * R2).toFixed(0)} ${(cx + Math.cos(a2) * R2).toFixed(0)},${(cy + Math.sin(a2) * R2).toFixed(0)}" fill="${p.accent}" opacity="0.07"/>`;
    }
    const bw = w * 0.62, bh = bw * 0.52, bx = cx - bw / 2, by = cy - bh * 0.28;
    const pageTop = (dir) => `M${cx} ${by + bh * 0.06} C${cx + dir * bw * 0.16} ${by - bh * 0.04} ${cx + dir * bw * 0.4} ${by - bh * 0.02} ${cx + dir * bw * 0.5} ${by + bh * 0.08} L${cx + dir * bw * 0.5} ${by + bh * 0.92} C${cx + dir * bw * 0.4} ${by + bh * 0.82} ${cx + dir * bw * 0.16} ${by + bh * 0.8} ${cx} ${by + bh * 0.86} Z`;
    const lines = (dir) => { let s = ''; for (let i = 0; i < 5; i++) { const y = by + bh * (0.22 + i * 0.13); s += `<line x1="${cx + dir * bw * 0.08}" y1="${y}" x2="${cx + dir * bw * 0.42}" y2="${y - dir * bh * 0.02}" stroke="${p.deep}" stroke-width="${Math.max(1, w * 0.0025)}" opacity="0.28"/>`; } return s; };
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="0.6" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <radialGradient id="halo" cx="0.5" cy="0.46" r="0.5">
          <stop offset="0" stop-color="${p.accent}" stop-opacity="0.55"/><stop offset="1" stop-color="${p.accent}" stop-opacity="0"/>
        </radialGradient>
        <filter id="bb" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.02)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      ${rays}
      <rect width="${w}" height="${h}" fill="url(#halo)"/>
      <g opacity="0.9" filter="url(#bb)"><rect x="${cx - w * 0.012}" y="${cy - h * 0.14}" width="${w * 0.024}" height="${h * 0.2}" fill="${p.accent2}" opacity="0.5"/><rect x="${cx - w * 0.05}" y="${cy - h * 0.07}" width="${w * 0.1}" height="${w * 0.022}" fill="${p.accent2}" opacity="0.5"/></g>
      <path d="M${bx} ${by + bh * 0.1} C${bx + bw * 0.14} ${by + bh * 0.98} ${cx - bw * 0.02} ${by + bh * 0.9} ${cx} ${by + bh * 0.98} C${cx + bw * 0.02} ${by + bh * 0.9} ${bx + bw * 0.86} ${by + bh * 0.98} ${bx + bw} ${by + bh * 0.1} L${bx + bw} ${by + bh * 1.08} C${bx + bw * 0.86} ${by + bh * 1.16} ${cx + bw * 0.02} ${by + bh * 1.08} ${cx} ${by + bh * 1.16} C${cx - bw * 0.02} ${by + bh * 1.08} ${bx + bw * 0.14} ${by + bh * 1.16} ${bx} ${by + bh * 1.08} Z" fill="${p.deep}" opacity="0.85"/>
      <path d="${pageTop(-1)}" fill="${p.accent2}"/>
      <path d="${pageTop(1)}" fill="${p.accent2}"/>
      ${lines(-1)}${lines(1)}
      <rect x="${cx - w * 0.006}" y="${by + bh * 0.04}" width="${w * 0.012}" height="${bh * 0.86}" fill="${p.deep}" opacity="0.4"/>
      <rect x="${cx - w * 0.01}" y="${by + bh * 0.82}" width="${w * 0.02}" height="${bh * 0.4}" rx="3" fill="#c62828"/>`);
  }

  function artStars(p, w, h) {
    const r = rng(13); let stars = '';
    for (let i = 0; i < 60; i++) {
      const x = r() * w, y = r() * h * 0.7, s = 0.6 + r() * 2.4;
      stars += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="#ffffff" opacity="${(0.2 + r() * 0.7).toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.deep}"/><stop offset="1" stop-color="${p.deep2}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.04)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>${stars}
      <circle cx="${w * 0.82}" cy="${h * 0.14}" r="${w * 0.09}" fill="${p.accent2}" opacity="0.9"/>
      <circle cx="${w * 0.82}" cy="${h * 0.14}" r="${w * 0.16}" fill="${p.accent}" opacity="0.25" filter="url(#b)"/>`);
  }

  function artArmy(p, w, h) {
    const r = rng(31);
    // rows of saluting-soldier silhouettes, smaller & lighter towards the horizon
    let rows = '';
    for (let row = 0; row < 3; row++) {
      const sy = h * (0.52 - row * 0.07), s = (1 - row * 0.28) * w / 900, op = 0.55 - row * 0.15;
      for (let i = 0; i < 9 + row * 3; i++) {
        const sx = (i + r() * 0.6) * (w / (8 + row * 3)) - w * 0.04;
        rows += `<g transform="translate(${sx.toFixed(0)} ${sy.toFixed(0)}) scale(${(s * 34).toFixed(1)})" fill="${p.deep}" opacity="${op.toFixed(2)}">
          <path d="M0.28 0.13 A0.22 0.22 0 0 1 0.72 0.13 L0.76 0.22 L0.24 0.22 Z"/>
          <circle cx="0.5" cy="0.3" r="0.14"/>
          <path d="M0.3 0.48 Q0.5 0.42 0.7 0.48 L0.76 1 L0.24 1 Z"/>
          <rect x="0.62" y="0.18" width="0.3" height="0.09" rx="0.04" transform="rotate(-38 0.66 0.3)"/>
        </g>`;
      }
    }
    let drones = '';
    for (let i = 0; i < 6; i++) {
      const x = r() * w, y = h * 0.06 + r() * h * 0.16, s = 4 + r() * 7;
      drones += `<g fill="${p.deep}" opacity="0.7"><rect x="${(x - s).toFixed(0)}" y="${y.toFixed(0)}" width="${(s * 2).toFixed(0)}" height="${(s * 0.5).toFixed(1)}" rx="${(s * 0.25).toFixed(1)}"/><circle cx="${(x - s).toFixed(0)}" cy="${y.toFixed(0)}" r="${(s * 0.45).toFixed(1)}"/><circle cx="${(x + s).toFixed(0)}" cy="${y.toFixed(0)}" r="${(s * 0.45).toFixed(1)}"/></g>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="${p.base}"/><stop offset="0.5" stop-color="${p.deep2}"/><stop offset="1" stop-color="${p.deep}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.06)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 0.4}" rx="${w * 0.55}" ry="${h * 0.2}" fill="${p.accent}" opacity="0.28" filter="url(#b)"/>
      ${drones}${rows}
      <rect x="0" y="${h * 0.52}" width="${w}" height="${h * 0.48}" fill="${p.deep}" opacity="0.55"/>`);
  }

  function artWarSky(p, w, h) {
    const r = rng(17);
    let embers = '';
    for (let i = 0; i < 26; i++) {
      const x = r() * w, y = r() * h, s = 1.5 + r() * 5;
      embers += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="${i % 3 ? p.accent : p.accent2}" opacity="${(0.2 + r() * 0.5).toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#050203"/><stop offset="0.5" stop-color="${p.deep}"/><stop offset="1" stop-color="${p.deep2}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.05)}"/></filter>
        <filter id="b2" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.023)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.2}" cy="${h * 0.2}" rx="${w * 0.5}" ry="${h * 0.13}" fill="#000000" opacity="0.75" filter="url(#b)"/>
      <ellipse cx="${w * 0.85}" cy="${h * 0.34}" rx="${w * 0.45}" ry="${h * 0.11}" fill="#000000" opacity="0.65" filter="url(#b)"/>
      <ellipse cx="${w * 0.6}" cy="${h * 0.26}" rx="${w * 0.34}" ry="${h * 0.07}" fill="${p.base}" opacity="0.5" filter="url(#b2)"/>
      <ellipse cx="${w * 0.3}" cy="${h * 0.48}" rx="${w * 0.4}" ry="${h * 0.08}" fill="${p.accent}" opacity="0.22" filter="url(#b)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 1.04}" rx="${w * 0.8}" ry="${h * 0.22}" fill="#000000" opacity="0.85" filter="url(#b)"/>
      <ellipse cx="${w * 0.75}" cy="${h * 0.88}" rx="${w * 0.3}" ry="${h * 0.1}" fill="${p.base}" opacity="0.45" filter="url(#b)"/>
      <polygon points="${w * 0.62},0 ${w * 0.42},${h} ${w * 0.55},${h}" fill="${p.accent2}" opacity="0.05"/>
      ${embers}`);
  }

  function artFlames(p, w, h) {
    const r = rng(23);
    let tongues = '';
    for (let i = 0; i < 12; i++) {
      const x = (i + 0.5) * (w / 12) + (r() - 0.5) * 40, base = h * (0.98 + r() * 0.04);
      const fh = h * (0.12 + r() * 0.22), fw = w * (0.05 + r() * 0.06);
      const c = i % 3 === 0 ? p.accent2 : i % 2 ? p.accent : p.base;
      tongues += `<path d="M${(x - fw).toFixed(0)} ${base.toFixed(0)} Q${x.toFixed(0)} ${(base - fh * 0.5).toFixed(0)} ${(x - fw * 0.15).toFixed(0)} ${(base - fh).toFixed(0)} Q${(x + fw * 0.4).toFixed(0)} ${(base - fh * 0.45).toFixed(0)} ${(x + fw).toFixed(0)} ${base.toFixed(0)} Z" fill="${c}" opacity="${(0.5 + r() * 0.4).toFixed(2)}" filter="url(#fb)"/>`;
    }
    let embers = '';
    for (let i = 0; i < 40; i++) {
      const x = r() * w, y = h * 0.3 + r() * h * 0.7, s = 1.5 + r() * 5;
      embers += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${s.toFixed(1)}" fill="${i % 3 ? p.accent : p.accent2}" opacity="${(0.25 + r() * 0.6).toFixed(2)}"/>`;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0a0302"/><stop offset="0.55" stop-color="${p.deep}"/><stop offset="1" stop-color="${p.deep2}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.06)}"/></filter>
        <filter id="fb" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.012)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 1.05}" rx="${w * 0.8}" ry="${h * 0.28}" fill="${p.base}" opacity="0.9" filter="url(#b)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 1.02}" rx="${w * 0.5}" ry="${h * 0.16}" fill="${p.accent}" opacity="0.65" filter="url(#b)"/>
      ${tongues}${embers}`);
  }

  function artCity(p, w, h) {
    const r = rng(41);
    let buildings = '', windows = '';
    let x = -w * 0.02;
    while (x < w) {
      const bw = w * (0.05 + r() * 0.08), bh = h * (0.12 + r() * 0.22), by = h - bh;
      buildings += `<rect x="${x.toFixed(0)}" y="${by.toFixed(0)}" width="${bw.toFixed(0)}" height="${bh.toFixed(0)}" fill="#000000" opacity="0.82"/>`;
      for (let wy = by + 14; wy < h - 16; wy += 26) {
        for (let wx = x + 8; wx < x + bw - 10; wx += 20) {
          if (r() < 0.32) windows += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="7" height="10" fill="${p.accent}" opacity="${(0.35 + r() * 0.5).toFixed(2)}"/>`;
        }
      }
      x += bw + w * 0.012;
    }
    return artUri(w, h, `
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#070304"/><stop offset="0.55" stop-color="${p.deep}"/><stop offset="1" stop-color="${p.deep2}"/>
        </linearGradient>
        <filter id="b" ${BLUR_REGION}><feGaussianBlur stdDeviation="${Math.round(w * 0.055)}"/></filter>
      </defs>
      <rect width="${w}" height="${h}" fill="url(#g)"/>
      <ellipse cx="${w * 0.5}" cy="${h * 0.95}" rx="${w * 0.7}" ry="${h * 0.3}" fill="${p.base}" opacity="0.6" filter="url(#b)"/>
      <ellipse cx="${w * 0.2}" cy="${h * 0.15}" rx="${w * 0.4}" ry="${h * 0.12}" fill="#000000" opacity="0.7" filter="url(#b)"/>
      ${buildings}${windows}`);
  }

  /* ===================== sticker / graphics library ===================== */
  // Movable vector graphics (image elements with SVG data-URIs) — the
  // "creative stuff": flames, jets, soldiers, skylines, crowns, QR blocks…
  // Each builder gets (c1 = main colour, c2 = accent colour).
  const STICKER_DEFS = {
    flame: { name: 'Flame', ratio: 1.25, svg: (c1, c2) => `<defs><linearGradient id="f" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <path d="M50 4 C68 26 84 40 80 64 C77 84 65 96 50 96 C35 96 23 84 20 64 C16 40 32 26 50 4 Z" fill="url(#f)"/>
      <path d="M50 34 C59 46 66 52 64 66 C62 76 57 82 50 82 C43 82 38 76 36 66 C34 52 41 46 50 34 Z" fill="${c2}" opacity="0.9"/>`, vb: '0 0 100 125' },
    jet: { name: 'Fighter jet', ratio: 0.5, svg: (c1) => `<path d="M4 28 L36 24 L58 4 L64 6 L52 24 L86 20 L96 25 L86 30 L52 28 L60 44 L54 46 L40 30 L18 34 Z" fill="${c1}"/><circle cx="90" cy="25" r="3" fill="${c1}" opacity="0.5"/>`, vb: '0 0 100 50' },
    soldier: { name: 'Soldier', ratio: 1.7, svg: (c1) => `<g fill="${c1}"><path d="M28 13 A22 22 0 0 1 72 13 L76 22 L24 22 Z"/><circle cx="50" cy="30" r="14"/><path d="M30 48 Q50 42 70 48 L78 118 L64 122 L60 86 L40 86 L36 122 L22 118 Z"/><rect x="60" y="18" width="34" height="9" rx="4" transform="rotate(-38 66 30)"/><rect x="20" y="58" width="12" height="34" rx="5" transform="rotate(14 26 75)"/><rect x="68" y="58" width="12" height="34" rx="5" transform="rotate(-14 74 75)"/></g>`, vb: '0 0 100 170' },
    skyline: { name: 'City skyline', ratio: 0.32, svg: (c1, c2) => { let b = '', wnd = ''; const hs = [60, 90, 45, 75, 100, 55, 82, 65, 95, 50]; let x = 0; for (let i = 0; i < 10; i++) { const bw = 26 + (i % 3) * 6, bh = hs[i]; b += `<rect x="${x}" y="${100 - bh}" width="${bw}" height="${bh}" fill="${c1}"/>`; for (let wy = 106 - bh; wy < 92; wy += 12) for (let wx = x + 4; wx < x + bw - 5; wx += 9) { if ((wx * 7 + wy * 13 + i) % 3 === 0) wnd += `<rect x="${wx}" y="${wy}" width="4" height="6" fill="${c2}" opacity="0.8"/>`; } x += bw + 4; } return b + wnd; }, vb: '0 0 310 100' },
    rays: { name: 'Light rays', ratio: 1, svg: (c1) => { let r2 = ''; for (let i = 0; i < 12; i++) { const a1 = i * 30 * Math.PI / 180, a2 = (i * 30 + 13) * Math.PI / 180; r2 += `<polygon points="50,50 ${(50 + Math.cos(a1) * 50).toFixed(1)},${(50 + Math.sin(a1) * 50).toFixed(1)} ${(50 + Math.cos(a2) * 50).toFixed(1)},${(50 + Math.sin(a2) * 50).toFixed(1)}" fill="${c1}" opacity="0.55"/>`; } return r2 + `<circle cx="50" cy="50" r="12" fill="${c1}"/>`; }, vb: '0 0 100 100' },
    crown: { name: 'Crown', ratio: 0.72, svg: (c1, c2) => `<path d="M8 62 L4 22 L28 40 L50 10 L72 40 L96 22 L92 62 Z" fill="${c1}"/><rect x="8" y="62" width="84" height="10" rx="3" fill="${c1}"/><circle cx="4" cy="20" r="5" fill="${c2}"/><circle cx="50" cy="8" r="5" fill="${c2}"/><circle cx="96" cy="20" r="5" fill="${c2}"/>`, vb: '0 0 100 72' },
    dove: { name: 'Dove', ratio: 0.8, svg: (c1) => `<path d="M82 30 C74 22 60 22 52 32 C48 20 36 12 22 16 C34 20 40 28 40 38 L12 34 C20 46 34 52 46 50 C42 62 32 68 20 70 C38 76 58 68 64 54 C76 52 84 42 82 30 Z" fill="${c1}"/><circle cx="76" cy="30" r="2.4" fill="#000" opacity="0.55"/>`, vb: '0 0 100 80' },
    cross: { name: 'Cross', ratio: 1.4, svg: (c1, c2) => `<defs><filter id="cg" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6"/></filter></defs><rect x="38" y="8" width="24" height="124" rx="5" fill="${c2}" filter="url(#cg)" opacity="0.7"/><rect x="10" y="38" width="80" height="24" rx="5" fill="${c2}" filter="url(#cg)" opacity="0.7"/><rect x="40" y="10" width="20" height="120" rx="4" fill="${c1}"/><rect x="12" y="40" width="76" height="20" rx="4" fill="${c1}"/>`, vb: '0 0 100 140' },
    qr: { name: 'QR code (replace with yours)', ratio: 1, svg: (c1) => { const r3 = rng(97); let m = `<rect x="0" y="0" width="100" height="100" rx="6" fill="#ffffff"/>`; const fp = (x, y) => `<rect x="${x}" y="${y}" width="22" height="22" fill="${c1}"/><rect x="${x + 3.5}" y="${y + 3.5}" width="15" height="15" fill="#fff"/><rect x="${x + 7}" y="${y + 7}" width="8" height="8" fill="${c1}"/>`; m += fp(8, 8) + fp(70, 8) + fp(8, 70); for (let y = 8; y < 92; y += 4.5) for (let x = 8; x < 92; x += 4.5) { const inFinder = (x < 32 && y < 32) || (x > 66 && y < 32) || (x < 32 && y > 66); if (!inFinder && r3() < 0.42) m += `<rect x="${x}" y="${y}" width="3.6" height="3.6" fill="${c1}"/>`; } return m; }, vb: '0 0 100 100' },
    stamp: { name: 'Stamp frame', ratio: 2.4, svg: (c1) => `<rect x="4" y="4" width="232" height="92" rx="14" fill="none" stroke="${c1}" stroke-width="7"/><rect x="16" y="16" width="208" height="68" rx="8" fill="none" stroke="${c1}" stroke-width="2.6" stroke-dasharray="12 7"/>`, vb: '0 0 240 100' },
    badge: { name: 'Shield badge', ratio: 1.15, svg: (c1, c2) => `<path d="M50 4 L92 16 L92 58 C92 84 72 102 50 110 C28 102 8 84 8 58 L8 16 Z" fill="${c1}"/><path d="M50 12 L84 22 L84 57 C84 79 67 94 50 101 C33 94 16 79 16 57 L16 22 Z" fill="none" stroke="${c2}" stroke-width="3.4"/>`, vb: '0 0 100 115' },
    ribbon: { name: 'Ribbon banner', ratio: 0.32, svg: (c1, c2) => `<polygon points="0,18 34,0 34,64 0,46" fill="${c2}"/><polygon points="300,18 266,0 266,64 300,46" fill="${c2}"/><rect x="26" y="6" width="248" height="52" rx="7" fill="${c1}"/>`, vb: '0 0 300 64' },
    sparkle: { name: 'Sparkles', ratio: 1, svg: (c1) => `<path d="M50 6 L58 42 L94 50 L58 58 L50 94 L42 58 L6 50 L42 42 Z" fill="${c1}"/><path d="M82 8 L85.4 20.6 L98 24 L85.4 27.4 L82 40 L78.6 27.4 L66 24 L78.6 20.6 Z" fill="${c1}" opacity="0.85"/><path d="M18 66 L20.6 76.4 L31 79 L20.6 81.6 L18 92 L15.4 81.6 L5 79 L15.4 76.4 Z" fill="${c1}" opacity="0.7"/>`, vb: '0 0 100 100' },
    smoke: { name: 'Smoke', ratio: 0.62, svg: (c1) => `<defs><filter id="sb" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="7"/></filter></defs><g fill="${c1}" filter="url(#sb)"><circle cx="30" cy="48" r="22" opacity="0.75"/><circle cx="58" cy="36" r="26" opacity="0.65"/><circle cx="80" cy="50" r="18" opacity="0.6"/><circle cx="50" cy="20" r="16" opacity="0.5"/></g>`, vb: '0 0 100 62' },
    openbook: { name: 'Open Bible', ratio: 0.72, svg: (c1, c2) => `
      <path d="M100 26 C74 8 34 8 12 20 L12 118 C34 106 74 106 100 124 C126 106 166 106 188 118 L188 20 C166 8 126 8 100 26 Z" fill="${c1}"/>
      <path d="M100 30 C78 16 42 16 22 26 L22 110 C42 100 78 100 100 114 Z" fill="${c2}"/>
      <path d="M100 30 C122 16 158 16 178 26 L178 110 C158 100 122 100 100 114 Z" fill="${c2}"/>
      <g stroke="${c1}" stroke-width="2" opacity="0.35"><line x1="34" y1="42" x2="86" y2="46"/><line x1="34" y1="56" x2="86" y2="60"/><line x1="34" y1="70" x2="86" y2="74"/><line x1="34" y1="84" x2="80" y2="88"/><line x1="114" y1="46" x2="166" y2="42"/><line x1="114" y1="60" x2="166" y2="56"/><line x1="114" y1="74" x2="166" y2="70"/><line x1="120" y1="88" x2="166" y2="84"/></g>
      <rect x="97" y="24" width="6" height="96" fill="${c1}" opacity="0.55"/>
      <rect x="96" y="112" width="8" height="34" rx="3" fill="#c62828"/>`, vb: '0 0 200 150' },
  };

  function stickerSrc(id, c1, c2) {
    const s = STICKER_DEFS[id];
    if (!s) return '';
    const body = typeof s.svg === 'function' ? s.svg(c1 || '#f5a623', c2 || '#ffe066') : s.svg;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.vb}">${body}</svg>`);
  }
  const STICKERS = Object.entries(STICKER_DEFS).map(([id, s]) => ({ id, name: s.name, ratio: s.ratio }));

  /* ==================== photo placeholder slots ==================== */
  // ratio = slot h/w so tall/wide slots get an aspect-matched SVG — a square
  // placeholder cover-fitted into a tall slot blows the hint text up 4x.
  // Renders at the slot's TRUE pixel size (W×H) so the frame stroke and
  // silhouette stay a constant thickness no matter how big the slot is — a
  // fixed 200px SVG scaled into a 900px hero slot ballooned into giant outlines.
  function placeholderPhoto(p, hint, W, H, round) {
    W = Math.round(W || 200); H = Math.round(H || 200);
    const acc = p ? p.accent : '#f5a623';
    const d1 = p ? p.deep2 : '#2b3242', d2 = p ? p.deep : '#101319';
    const cx = Math.round(W / 2), cy = Math.round(H / 2), r = Math.min(W, H);
    const sw = clamp(Math.round(r * 0.02), 3, 10);      // frame / silhouette stroke
    const head = Math.round(r * 0.13), shy = Math.round(r * 0.27), shx = Math.round(r * 0.24);
    // A soft frame so the empty slot reads as an intentional portrait frame, not
    // a broken blank: circle-cropped slots get a ring, rectangular ones a rounded
    // border. Both hug the crop edge because they sit at the SVG's own border.
    const frame = round
      ? `<circle cx="${cx}" cy="${cy}" r="${Math.round(r / 2 - sw)}" fill="none" stroke="${acc}" stroke-opacity="0.6" stroke-width="${sw}"/>`
      : `<rect x="${Math.round(sw * 1.5)}" y="${Math.round(sw * 1.5)}" width="${W - Math.round(sw * 3)}" height="${H - Math.round(sw * 3)}" rx="${Math.round(r * 0.07)}" fill="none" stroke="${acc}" stroke-opacity="0.42" stroke-width="${Math.max(2, sw - 1)}"/>`;
    const pillW = Math.round(clamp(r * 0.62, 96, 190)), pillH = Math.round(clamp(r * 0.17, 26, 40)), pillF = Math.round(clamp(r * 0.06, 12, 20));
    const pill = hint === false ? '' : `<g transform="translate(${cx} ${H - Math.round(pillH * 0.9)})">
        <rect x="${-pillW / 2}" y="${-pillH / 2}" width="${pillW}" height="${pillH}" rx="${Math.round(pillH / 2)}" fill="#000000" fill-opacity="0.5"/>
        <text x="0" y="${Math.round(pillF * 0.35)}" font-family="Montserrat,Arial" font-size="${pillF}" font-weight="700" fill="rgba(255,255,255,0.95)" text-anchor="middle">+  Add photo</text></g>`;
    return svgUri(W, H, `
      <defs>
        <linearGradient id="pg" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${d1}"/><stop offset="1" stop-color="${d2}"/></linearGradient>
        <radialGradient id="pgl" cx="0.5" cy="0.36" r="0.72"><stop offset="0" stop-color="${acc}" stop-opacity="0.22"/><stop offset="1" stop-color="${acc}" stop-opacity="0"/></radialGradient>
        <radialGradient id="pvg" cx="0.5" cy="0.5" r="0.78"><stop offset="0.5" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.45"/></radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#pg)"/>
      <rect width="${W}" height="${H}" fill="url(#pgl)"/>
      <g transform="translate(${cx} ${cy})" opacity="0.9">
        <circle cx="0" cy="${-Math.round(head * 1.15)}" r="${head}" fill="none" stroke="${acc}" stroke-opacity="0.5" stroke-width="${sw}"/>
        <path d="M${-shx} ${shy} Q${-shx} ${-Math.round(head * 0.15)} 0 ${-Math.round(head * 0.15)} Q${shx} ${-Math.round(head * 0.15)} ${shx} ${shy}" fill="none" stroke="${acc}" stroke-opacity="0.5" stroke-width="${sw}" stroke-linecap="round"/>
      </g>
      <rect width="${W}" height="${H}" fill="url(#pvg)"/>
      ${frame}
      ${pill}`);
  }

  /* ========================= layout helpers ========================= */
  // Split a title into 1-4 stacked display lines (huge word-poster look).
  function stackWords(title) {
    const words = String(title || '').trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return ['YOUR EVENT'];
    const lines = [];
    let cur = '';
    for (const wd of words) {
      if (!cur) { cur = wd; continue; }
      if ((cur + ' ' + wd).length <= 10 || wd.length <= 3 && (cur + ' ' + wd).length <= 12) cur += ' ' + wd;
      else { lines.push(cur); cur = wd; }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, 4).concat(lines.length > 4 ? [words.slice(lines.slice(0, 4).join(' ').split(/\s+/).length).join(' ')] : []).filter(Boolean).slice(0, 4);
  }

  // Font size so the longest line fits in `boxW` for a condensed display font.
  function fitSize(lines, boxW, factor, maxSize) {
    const longest = Math.max(...lines.map((l) => l.length), 1);
    return Math.round(clamp(boxW / (longest * factor), 24, maxSize));
  }

  // Speaker photo circles + name labels, evenly spread inside [x, x+w].
  function speakerRow(d, p, speakers, x, y, w, size, els, nameColor, U) {
    const n = Math.min(speakers.length, 4);
    if (!n) return y;
    const gap = Math.min(size * 1.35, w / n);
    const total = gap * n;
    let sx = x + (w - total) / 2 + (gap - size) / 2;
    for (let i = 0; i < n; i++) {
      // hint text clips badly inside small circles — silhouette only, with an
      // accent ring (round) + soft shadow that blends the circle into the artwork
      const cx = Math.round(sx), cyy = Math.round(y), sz = Math.round(size);
      // faint accent halo behind each portrait so the speaker row reads as one band
      els.push(R({ x: cx - Math.round(6 * U), y: cyy - Math.round(6 * U), w: sz + Math.round(12 * U), h: sz + Math.round(12 * U), radius: Math.round((sz + 12 * U) / 2), fill: rgba(p.accent, 0.14), name: 'Portrait halo' }));
      els.push(IMG({ src: placeholderPhoto(p, false, sz, sz, true), x: cx, y: cyy, w: sz, h: sz, radius: Math.round(sz / 2), ph: true, shadowEl: true, name: 'Photo — ' + speakers[i].name }));
      els.push(T({
        text: speakers[i].name, x: Math.round(sx - gap * 0.18), y: Math.round(y + size + 12 * U), w: Math.round(size + gap * 0.36), h: Math.round(38 * U),
        size: Math.round(clamp(size * 0.135, 14 * U, 27 * U)), font: 'Montserrat', weight: 800, align: 'center', color: nameColor, lineHeight: 1.05,
      }));
      sx += gap;
    }
    return y + size + 48 * U;
  }

  // "📅 date  •  🕘 time" + venue bar at the bottom.
  function detailsBar(d, p, w, h, U, els, opts = {}) {
    const barH = Math.round(96 * U);
    const y = Math.round(h - barH - 40 * U);
    const acc = opts.accent || p.accent;
    els.push(R({ x: Math.round(40 * U), y, w: w - Math.round(80 * U), h: barH, fill: opts.fill || 'rgba(0,0,0,0.55)', radius: Math.round(barH / 2), name: 'Details bar' }));
    const line = [d.date, d.time].filter(Boolean).join('   •   ') || 'Date & time';
    els.push(T({
      text: line, x: Math.round(60 * U), y: y + Math.round(barH * 0.14), w: w - Math.round(120 * U), h: Math.round(barH * 0.42),
      size: Math.round(30 * U), font: 'Poppins', weight: 700, align: 'center', color: acc,
    }));
    els.push(T({
      text: '📍 ' + (d.venue || 'Venue'), x: Math.round(60 * U), y: y + Math.round(barH * 0.52), w: w - Math.round(120 * U), h: Math.round(barH * 0.4),
      size: Math.round(22 * U), font: 'Montserrat', weight: 600, align: 'center', color: opts.ink || '#ffffff',
    }));
    return y;
  }

  function chip(text, x, y, w, h, fill, ink, size, font, weight) {
    return [
      R({ x, y, w, h, fill, radius: Math.round(h / 2), name: 'Chip' }),
      T({ text, x, y: y + Math.round(h * 0.18), w, h: Math.round(h * 0.7), size, font: font || 'Poppins', weight: weight || 700, align: 'center', color: ink }),
    ];
  }

  /* ============================ templates ============================ */
  // Every build() gets normalized data `d`, canvas w/h, palette p.
  // U scales 1080-design units to the canvas width.

  const TEMPLATES = [
    {
      id: 'rain-stack', name: 'Big Word Poster', tags: 'rain abundance revival blessing overflow word bold',
      palettes: ['lime', 'emerald', 'fire', 'sunset'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.62, 0.62, h * 0.19);
        // Chips top-right: date + time
        if (d.date) els.push(...chip(d.date, Math.round(w * 0.56), Math.round(44 * U), Math.round(w * 0.4), Math.round(58 * U), p.accent, p.chipInk, Math.round(24 * U)));
        if (d.time) els.push(...chip(d.time, Math.round(w * 0.66), Math.round(116 * U), Math.round(w * 0.3), Math.round(52 * U), 'rgba(0,0,0,0.5)', '#ffffff', Math.round(22 * U)));
        // Church badge top-left
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(48 * U), y: Math.round(52 * U), w: Math.round(w * 0.48), h: Math.round(64 * U), size: Math.round(26 * U), font: 'Bebas Neue', letter: 3, color: p.ink }));
        if (d.theme) els.push(T({ text: d.theme.toUpperCase(), x: Math.round(48 * U), y: Math.round(104 * U), w: Math.round(w * 0.5), h: Math.round(50 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, color: p.accent, letter: 1 }));
        // Giant stacked words — per-line size (Alfa Slab One caps average
        // ~0.82em wide) + nowrap so slab glyphs never wrap mid-word
        // ("ABUNDAN/CE") or overlap the line above.
        let y = Math.round(h * 0.2);
        for (const line of lines) {
          const sz = Math.min(size, Math.round((w * 0.82) / (Math.max(line.length, 2) * 0.82)));
          els.push(T({
            text: line, x: Math.round(44 * U), y, w: Math.round(w * 0.88), h: Math.round(sz * 1.18),
            size: sz, font: 'Alfa Slab One', weight: 400, lineHeight: 1, effect: 'chrome3d', nowrap: true,
          }));
          y += Math.round(sz * 1.1);
        }
        // Photo bottom-right
        const ps = Math.round(w * 0.42);
        els.push(IMG({ src: placeholderPhoto(p, true, ps, ps), x: w - ps - Math.round(36 * U), y: h - ps - Math.round(140 * U), w: ps, h: ps, radius: Math.round(24 * U), ph: true, shadowEl: true, name: 'Speaker photo' }));
        if (d.speakers.length) els.push(T({
          text: 'With ' + d.speakers[0].name, x: w - ps - Math.round(36 * U), y: h - Math.round(132 * U), w: ps, h: Math.round(46 * U),
          size: Math.round(26 * U), font: 'Poppins', weight: 700, align: 'center', color: p.ink, effect: 'shadow',
        }));
        // "LIVE ON" style venue box bottom-left
        els.push(R({ x: Math.round(40 * U), y: h - Math.round(150 * U), w: Math.round(w * 0.42), h: Math.round(104 * U), fill: 'rgba(0,0,0,0.55)', radius: Math.round(16 * U), name: 'Venue box' }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(56 * U), y: h - Math.round(136 * U), w: Math.round(w * 0.39), h: Math.round(80 * U), size: Math.round(21 * U), font: 'Montserrat', weight: 600, color: '#ffffff', lineHeight: 1.25 }));
        return { w, h, background: photoOrArt('rain abundance overflow', p, artRain, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'fire-conference', name: 'Fire Conference', tags: 'fire conference power revival flame supernatural encounter',
      palettes: ['fire', 'crimson', 'sunset'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        if (d.theme) els.push(...chip('THEME: ' + d.theme.toUpperCase(), Math.round(40 * U), Math.round(40 * U), Math.round(w * 0.52), Math.round(56 * U), 'rgba(0,0,0,0.45)', p.accent2, Math.round(19 * U), 'Montserrat'));
        if (d.date) els.push(...chip(d.date, Math.round(w * 0.62), Math.round(40 * U), Math.round(w * 0.34), Math.round(56 * U), p.accent, p.chipInk, Math.round(22 * U)));
        const rowEnd = speakerRow(d, p, d.speakers.length ? d.speakers : [{ name: 'Guest Minister' }], Math.round(w * 0.06), Math.round(h * 0.14), Math.round(w * 0.88), Math.round(w * 0.22), els, p.ink, U);
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.9, 0.52, h * 0.155);
        let y = Math.round(h * 0.52);
        for (const line of lines) {
          els.push(T({
            text: line, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(size * 1.1),
            size, font: 'Anton', weight: 400, align: 'center', lineHeight: 1, effect: 'fire3d', nowrap: true,
          }));
          y += Math.round(size * 1.04);
        }
        detailsBar(d, p, w, h, U, els);
        return { w, h, background: photoOrArt('fire flame supernatural power', p, artFire, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'neon-party', name: 'Neon Party', tags: 'party holy ghost celebration praise jam youth night vibes',
      palettes: ['neon', 'sunset', 'midnight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(48 * U), w: Math.round(w * 0.8), h: Math.round(50 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 4, align: 'center', color: p.accent2 }));
        if (d.theme) els.push(T({ text: '— ' + d.theme + ' —', x: Math.round(w * 0.1), y: Math.round(100 * U), w: Math.round(w * 0.8), h: Math.round(44 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, align: 'center', color: p.ink, opacity: 0.85 }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.88, 0.56, h * 0.15);
        let y = Math.round(h * 0.15);
        lines.forEach((line, i) => {
          els.push(T({
            text: line, x: Math.round(w * 0.06), y, w: Math.round(w * 0.88), h: Math.round(size * 1.14),
            size, font: 'Bangers', weight: 400, align: 'center', lineHeight: 1, letter: 2,
            color: i % 2 ? p.accent2 : p.accent, effect: 'neon', fxColor: i % 2 ? p.accent2 : p.accent,
          }));
          y += Math.round(size * 1.08);
        });
        const speakers = d.speakers.length ? d.speakers : [{ name: 'Special Guest' }];
        speakerRow(d, p, speakers.slice(0, 2), Math.round(w * 0.1), y + Math.round(30 * U), Math.round(w * 0.8), Math.round(w * 0.26), els, p.ink, U);
        if (d.time) els.push(...chip(d.time, Math.round(w * 0.7), Math.round(h * 0.86) - Math.round(70 * U), Math.round(w * 0.24), Math.round(58 * U), p.accent, p.chipInk, Math.round(26 * U)));
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(0,0,0,0.6)' });
        return { w, h, background: photoOrArt('party concert neon confetti', p, artNeon, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'script-night', name: 'Script Night', tags: 'night worship praise halleluyah hallelujah songs volunteers congress',
      palettes: ['sky', 'royal', 'ocean'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(44 * U), w: Math.round(w * 0.8), h: Math.round(46 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 5, align: 'center', color: p.ink }));
        const words = String(d.title || 'Worship Night').trim().split(/\s+/);
        const last = words.length > 1 ? words.pop() : '';
        const first = words.join(' ').toUpperCase();
        const fSize = Math.round(clamp((w * 0.86) / (Math.max(first.length, 4) * 0.52), 40 * U, h * 0.13));
        els.push(T({ text: first, x: Math.round(w * 0.07), y: Math.round(h * 0.14), w: Math.round(w * 0.86), h: Math.round(fSize * 1.1), size: fSize, font: 'Anton', align: 'center', color: p.ink, lineHeight: 1, effect: 'shadow' }));
        if (last) {
          const sSize = Math.round(clamp((w * 0.8) / (Math.max(last.length, 3) * 0.42), 50 * U, h * 0.16));
          els.push(T({ text: last, x: Math.round(w * 0.1), y: Math.round(h * 0.14 + fSize * 0.82), w: Math.round(w * 0.8), h: Math.round(sSize * 1.3), size: sSize, font: 'Great Vibes', weight: 400, align: 'center', color: p.accent, lineHeight: 1.1, effect: 'shadow', rot: -4 }));
        }
        if (d.theme) {
          els.push(...chip('Theme: ' + d.theme, Math.round(w * 0.12), Math.round(h * 0.46), Math.round(w * 0.76), Math.round(58 * U), 'rgba(0,0,0,0.4)', '#ffffff', Math.round(21 * U), 'Montserrat', 600));
        }
        speakerRow(d, p, d.speakers.length ? d.speakers : [{ name: 'Worship Team' }], Math.round(w * 0.06), Math.round(h * 0.56), Math.round(w * 0.88), Math.round(w * 0.19), els, p.ink, U);
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(9,32,58,0.75)' });
        return { w, h, background: photoOrArt('worship stars night praise', p, artSky, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'blocks-power', name: 'Power Blocks', tags: 'manifestation power bold student pray program mighty',
      palettes: ['emerald', 'ocean', 'neon', 'crimson'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(44 * U), y: Math.round(44 * U), w: Math.round(w * 0.55), h: Math.round(48 * U), size: Math.round(26 * U), font: 'Bebas Neue', letter: 3, color: p.ink }));
        if (d.edition) els.push(...chip(d.edition.toUpperCase(), Math.round(w * 0.72), Math.round(40 * U), Math.round(w * 0.24), Math.round(56 * U), p.accent, p.chipInk, Math.round(22 * U), 'Bebas Neue'));
        // Title words: alternate plain + accent-backed blocks
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.85, 0.55, h * 0.14);
        let y = Math.round(h * 0.13);
        lines.forEach((line, i) => {
          const lw = Math.round(Math.min(w * 0.88, line.length * size * 0.58 + 40 * U));
          const lx = Math.round((w - lw) / 2);
          if (i % 2 === 1) els.push(R({ x: lx, y: y + Math.round(size * 0.06), w: lw, h: Math.round(size * 1.02), fill: p.accent, radius: Math.round(10 * U), rot: -1.5, name: 'Word block' }));
          els.push(T({
            text: line, x: lx, y, w: lw, h: Math.round(size * 1.12), size, font: 'Anton', align: 'center', lineHeight: 1.05,
            color: i % 2 === 1 ? p.chipInk : p.ink, effect: i % 2 === 1 ? 'none' : 'shadow', rot: i % 2 === 1 ? -1.5 : 0,
          }));
          y += Math.round(size * 1.14);
        });
        speakerRow(d, p, d.speakers.length ? d.speakers : [{ name: 'Convener' }], Math.round(w * 0.05), y + Math.round(24 * U), Math.round(w * 0.9), Math.round(w * 0.24), els, p.ink, U);
        detailsBar(d, p, w, h, U, els);
        return { w, h, background: bgImage(artClean(p, w, h)), elements: els };
      },
    },

    {
      id: 'royal-worship', name: 'Royal Worship', tags: 'worship encounter glory presence anointing gold royal atmosphere',
      palettes: ['royal', 'midnight', 'mono'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(56 * U), w: Math.round(w * 0.8), h: Math.round(44 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 600, letter: 6, align: 'center', color: p.accent2 }));
        els.push(R({ x: Math.round(w * 0.42), y: Math.round(118 * U), w: Math.round(w * 0.16), h: Math.round(4 * U), fill: p.accent, name: 'Rule' }));
        // Serial layout: title → theme → photo → name, so long script titles
        // (with big descenders) can never collide with what follows.
        const tSize = Math.round(clamp((w * 0.9) / (Math.max(String(d.title).length, 6) * 0.34), 48 * U, h * 0.13));
        let y = Math.round(h * 0.16);
        els.push(T({
          text: d.title, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(tSize * 2.5),
          size: tSize, font: 'Great Vibes', weight: 400, align: 'center', color: p.accent, lineHeight: 1.1, effect: 'glow', fxColor: p.accent,
        }));
        y += Math.round(tSize * 2.5 + 26 * U);
        if (d.theme) {
          els.push(T({ text: d.theme.toUpperCase(), x: Math.round(w * 0.1), y, w: Math.round(w * 0.8), h: Math.round(52 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 4, align: 'center', color: p.ink }));
          y += Math.round(64 * U);
        }
        const ps = Math.round(Math.min(w * 0.3, h - y - (96 + 40 + 130) * U - (w * 0.3)) > 0 ? w * 0.3 : w * 0.24);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, ps, true), x: Math.round((w - ps) / 2), y, w: ps, h: ps, radius: Math.round(ps / 2), ph: true, shadowEl: true, name: 'Minister photo' }));
        if (d.speakers.length) els.push(T({ text: d.speakers[0].name, x: Math.round(w * 0.2), y: y + ps + Math.round(12 * U), w: Math.round(w * 0.6), h: Math.round(44 * U), size: Math.round(26 * U), font: 'Playfair Display', weight: 700, align: 'center', color: p.ink }));
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(0,0,0,0.5)' });
        return { w, h, background: photoOrArt('worship purple royal glow', p, artBokeh, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'rays-crusade', name: 'Crusade Rays', tags: 'crusade revival healing miracle deliverance open air gospel',
      palettes: ['crimson', 'fire', 'royal'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(...chip((d.church || 'OUR CHURCH').toUpperCase(), Math.round(w * 0.25), Math.round(44 * U), Math.round(w * 0.5), Math.round(56 * U), p.accent, p.chipInk, Math.round(22 * U), 'Bebas Neue'));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.9, 0.54, h * 0.16);
        let y = Math.round(h * 0.16);
        for (const line of lines) {
          els.push(T({
            text: line, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(size * 1.12),
            size, font: 'Anton', align: 'center', lineHeight: 1, effect: 'chrome3d', nowrap: true,
          }));
          y += Math.round(size * 1.05);
        }
        speakerRow(d, p, d.speakers.length ? d.speakers : [{ name: 'Ministering' }], Math.round(w * 0.06), y + Math.round(20 * U), Math.round(w * 0.88), Math.round(w * 0.21), els, p.ink, U);
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(w * 0.1), y: Math.round(h * 0.78), w: Math.round(w * 0.8), h: Math.round(48 * U), size: Math.round(24 * U), font: 'Pacifico', weight: 400, align: 'center', color: p.accent }));
        detailsBar(d, p, w, h, U, els);
        return { w, h, background: photoOrArt('rays clouds crusade light heaven', p, artRays, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'split-photo', name: 'Photo Split', tags: 'conference summit speaker guest modern corporate seminar',
      palettes: ['midnight', 'royal', 'ocean', 'mono'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        // Right side: big photo panel
        els.push(IMG({ src: placeholderPhoto(p, true, Math.round(w * 0.48), h), x: Math.round(w * 0.52), y: 0, w: Math.round(w * 0.48), h, radius: 0, ph: true, name: 'Main photo' }));
        els.push(R({ x: Math.round(w * 0.5), y: 0, w: Math.round(w * 0.04), h, fill: p.accent, name: 'Divider' }));
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(44 * U), y: Math.round(60 * U), w: Math.round(w * 0.42), h: Math.round(46 * U), size: Math.round(21 * U), font: 'Montserrat', weight: 700, letter: 3, color: p.accent }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.42, 0.56, h * 0.1);
        let y = Math.round(h * 0.2);
        for (const line of lines) {
          els.push(T({ text: line, x: Math.round(44 * U), y, w: Math.round(w * 0.44), h: Math.round(size * 1.12), size, font: 'Anton', lineHeight: 1, effect: 'silver3d', nowrap: true }));
          y += Math.round(size * 1.06);
        }
        if (d.theme) { els.push(T({ text: d.theme, x: Math.round(44 * U), y: y + Math.round(10 * U), w: Math.round(w * 0.42), h: Math.round(72 * U), size: Math.round(24 * U), font: 'Playfair Display', italic: true, weight: 500, color: p.accent2, lineHeight: 1.25 })); y += Math.round(90 * U); }
        const dt = [d.date, d.time].filter(Boolean).join('  •  ');
        if (dt) els.push(T({ text: dt, x: Math.round(44 * U), y: h - Math.round(230 * U), w: Math.round(w * 0.44), h: Math.round(46 * U), size: Math.round(24 * U), font: 'Poppins', weight: 700, color: p.accent }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(44 * U), y: h - Math.round(174 * U), w: Math.round(w * 0.44), h: Math.round(88 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, color: p.ink, lineHeight: 1.3 }));
        if (d.speakers.length) els.push(T({
          text: 'With ' + d.speakers.map((s) => s.name).join(' • '), x: Math.round(w * 0.54), y: h - Math.round(96 * U), w: Math.round(w * 0.42), h: Math.round(64 * U),
          size: Math.round(20 * U), font: 'Poppins', weight: 700, align: 'center', color: '#ffffff', effect: 'shadow', lineHeight: 1.2,
        }));
        return { w, h, background: bgImage(artClean(p, w, h)), elements: els };
      },
    },

    {
      id: 'vigil-minimal', name: 'Night Vigil', tags: 'vigil prayer midnight night watch intercession tarry',
      palettes: ['midnight', 'royal', 'mono'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(h * 0.08), w: Math.round(w * 0.8), h: Math.round(44 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, letter: 8, align: 'center', color: p.accent2 }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.8, 0.6, h * 0.11);
        let y = Math.round(h * 0.3);
        for (const line of lines) {
          els.push(T({ text: line, x: Math.round(w * 0.1), y, w: Math.round(w * 0.8), h: Math.round(size * 1.15), size, font: 'Bebas Neue', letter: Math.round(6 * U), align: 'center', lineHeight: 1.05, effect: 'silver3d', nowrap: true }));
          y += Math.round(size * 1.12);
        }
        if (d.theme) els.push(T({ text: '“' + d.theme + '”', x: Math.round(w * 0.14), y: y + Math.round(18 * U), w: Math.round(w * 0.72), h: Math.round(60 * U), size: Math.round(24 * U), font: 'Playfair Display', italic: true, align: 'center', color: p.accent2, weight: 500 }));
        const dt = [d.date, d.time].filter(Boolean).join('   |   ');
        if (dt) els.push(T({ text: dt, x: Math.round(w * 0.1), y: Math.round(h * 0.74), w: Math.round(w * 0.8), h: Math.round(48 * U), size: Math.round(26 * U), font: 'Bebas Neue', letter: 3, align: 'center', color: p.accent }));
        els.push(T({ text: (d.venue || 'Venue'), x: Math.round(w * 0.1), y: Math.round(h * 0.79), w: Math.round(w * 0.8), h: Math.round(64 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, align: 'center', color: p.ink, opacity: 0.9, lineHeight: 1.3 }));
        return { w, h, background: photoOrArt('prayer praying hands vigil intercession night', p, artStars, w, h, 'dark'), elements: els };
      },
    },

    {
      id: 'waves-thanks', name: 'Thanksgiving Waves', tags: 'thanksgiving gratitude praise harvest anniversary celebration',
      palettes: ['sunset', 'emerald', 'ocean'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(48 * U), w: Math.round(w * 0.8), h: Math.round(44 * U), size: Math.round(22 * U), font: 'Bebas Neue', letter: 5, align: 'center', color: p.ink }));
        const words = String(d.title || 'Thanksgiving').trim().split(/\s+/);
        const scriptWord = words[0], rest = words.slice(1).join(' ').toUpperCase();
        const sSize = Math.round(clamp((w * 0.86) / (Math.max(scriptWord.length, 4) * 0.56), 60 * U, h * 0.15));
        els.push(T({ text: scriptWord, x: Math.round(w * 0.07), y: Math.round(h * 0.14), w: Math.round(w * 0.86), h: Math.round(sSize * 1.4), size: sSize, font: 'Pacifico', weight: 400, align: 'center', color: p.accent, effect: 'shadow', lineHeight: 1.15 }));
        if (rest) els.push(T({ text: rest, x: Math.round(w * 0.08), y: Math.round(h * 0.14 + sSize * 1.35), w: Math.round(w * 0.84), h: Math.round(h * 0.1), size: fitSize([rest], w * 0.8, 0.55, h * 0.09), font: 'Anton', align: 'center', color: p.ink, lineHeight: 1 }));
        const ps = Math.round(w * 0.36);
        els.push(IMG({ src: placeholderPhoto(p, true, ps, ps), x: Math.round((w - ps) / 2), y: Math.round(h * 0.44), w: ps, h: ps, radius: Math.round(28 * U), ph: true, shadowEl: true, name: 'Photo' }));
        if (d.speakers.length) els.push(T({ text: 'With ' + d.speakers[0].name, x: Math.round(w * 0.2), y: Math.round(h * 0.44 + ps + 10 * U), w: Math.round(w * 0.6), h: Math.round(42 * U), size: Math.round(24 * U), font: 'Poppins', weight: 700, align: 'center', color: p.ink }));
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(0,0,0,0.45)' });
        return { w, h, background: photoOrArt('clouds gold thanksgiving sunset', p, artWaves, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'youth-sticker', name: 'Youth Sticker', tags: 'youth teens campus students hangout games sticker fun',
      palettes: ['neon', 'lime', 'sunset', 'ocean'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(...chip((d.church || 'YOUTH CHURCH').toUpperCase(), Math.round(w * 0.06), Math.round(44 * U), Math.round(w * 0.55), Math.round(54 * U), '#000000', '#ffffff', Math.round(20 * U), 'Bebas Neue'));
        if (d.date) els.push(...chip(d.date, Math.round(w * 0.64), Math.round(44 * U), Math.round(w * 0.3), Math.round(54 * U), p.accent, p.chipInk, Math.round(20 * U)));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.82, 0.56, h * 0.15);
        let y = Math.round(h * 0.17);
        lines.forEach((line, i) => {
          const rot = i % 2 ? 2.5 : -2.5;
          const lw = Math.round(Math.min(w * 0.9, line.length * size * 0.6 + 60 * U));
          const lx = Math.round((w - lw) / 2);
          els.push(R({ x: lx, y: y + Math.round(size * 0.04), w: lw, h: Math.round(size * 1.06), fill: i % 2 ? p.accent2 : p.accent, radius: Math.round(18 * U), rot, borderWidth: Math.max(2, Math.round(4 * U)), borderColor: '#000000', name: 'Sticker' }));
          els.push(T({ text: line, x: lx, y: y + Math.round(size * 0.06), w: lw, h: Math.round(size * 1.06), size, font: 'Bangers', align: 'center', lineHeight: 1, color: '#111111', rot, letter: 2 }));
          y += Math.round(size * 1.2);
        });
        speakerRow(d, p, d.speakers, Math.round(w * 0.08), y + Math.round(20 * U), Math.round(w * 0.84), Math.round(w * 0.2), els, p.ink, U);
        detailsBar(d, p, w, h, U, els, { fill: '#000000' });
        return { w, h, background: bgImage(artHalftone(p, w, h)), elements: els };
      },
    },

    {
      id: 'classic-elegant', name: 'Classic Elegant', tags: 'elegant anniversary wedding dinner gala classic formal ordination',
      palettes: ['paper', 'royal', 'mono'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        const dark = p.id === 'paper';
        const main = dark ? p.accent2 : p.ink, acc = p.accent;
        els.push(R({ x: Math.round(50 * U), y: Math.round(50 * U), w: w - Math.round(100 * U), h: h - Math.round(100 * U), fill: 'rgba(0,0,0,0)', borderWidth: Math.max(2, Math.round(3 * U)), borderColor: acc, radius: 0, name: 'Frame' }));
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(h * 0.1), w: Math.round(w * 0.8), h: Math.round(44 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 600, letter: 7, align: 'center', color: acc }));
        const tSize = Math.round(clamp((w * 0.82) / (Math.max(String(d.title).length, 6) * 0.42), 40 * U, h * 0.1));
        els.push(T({ text: d.title, x: Math.round(w * 0.09), y: Math.round(h * 0.24), w: Math.round(w * 0.82), h: Math.round(tSize * 2.6), size: tSize, font: 'Playfair Display', weight: 800, align: 'center', color: main, lineHeight: 1.15 }));
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(w * 0.12), y: Math.round(h * 0.48), w: Math.round(w * 0.76), h: Math.round(64 * U), size: Math.round(26 * U), font: 'Great Vibes', align: 'center', color: acc, weight: 400 }));
        els.push(R({ x: Math.round(w * 0.44), y: Math.round(h * 0.58), w: Math.round(w * 0.12), h: Math.round(3 * U), fill: acc, name: 'Rule' }));
        const meta = [d.date, d.time, d.venue].filter(Boolean).join('\n');
        els.push(T({ text: meta || 'Date • Time • Venue', x: Math.round(w * 0.12), y: Math.round(h * 0.63), w: Math.round(w * 0.76), h: Math.round(h * 0.18), size: Math.round(25 * U), font: 'Playfair Display', weight: 500, align: 'center', color: main, lineHeight: 1.7 }));
        if (d.speakers.length) els.push(T({ text: 'With ' + d.speakers.map((s) => s.name).join(' & '), x: Math.round(w * 0.12), y: Math.round(h * 0.84), w: Math.round(w * 0.76), h: Math.round(46 * U), size: Math.round(21 * U), font: 'Montserrat', weight: 600, align: 'center', color: acc, italic: true }));
        const bg = p.id === 'paper' ? { type: 'solid', color: p.base } : bgImage(artBokeh(p, w, h));
        return { w, h, background: bg, elements: els };
      },
    },

    {
      id: 'bold-minimal', name: 'Bold Minimal', tags: 'minimal modern clean announcement service bold simple',
      palettes: ['mono', 'paper', 'midnight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        const paper = p.id === 'paper';
        const ink = paper ? '#191510' : '#ffffff';
        els.push(R({ x: Math.round(60 * U), y: Math.round(70 * U), w: Math.round(w * 0.12), h: Math.round(10 * U), fill: p.accent, name: 'Bar' }));
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(60 * U), y: Math.round(104 * U), w: Math.round(w * 0.8), h: Math.round(42 * U), size: Math.round(21 * U), font: 'Montserrat', weight: 600, letter: 4, color: paper ? '#8a8377' : '#9aa3b2' }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.86, 0.56, h * 0.14);
        let y = Math.round(h * 0.2);
        for (const line of lines) {
          els.push(T({ text: line, x: Math.round(56 * U), y, w: Math.round(w * 0.88), h: Math.round(size * 1.12), size, font: 'Anton', lineHeight: 1, color: ink }));
          y += Math.round(size * 1.05);
        }
        if (d.theme) { els.push(T({ text: d.theme, x: Math.round(60 * U), y: y + Math.round(14 * U), w: Math.round(w * 0.8), h: Math.round(56 * U), size: Math.round(28 * U), font: 'Montserrat', weight: 600, color: p.accent })); }
        const rows = [['📅', d.date], ['🕘', d.time], ['📍', d.venue]].filter((r) => r[1]);
        let my = h - Math.round((rows.length * 64 + 120) * U);
        els.push(R({ x: Math.round(60 * U), y: my - Math.round(24 * U), w: Math.round(w * 0.5), h: Math.round(3 * U), fill: paper ? '#d9d2c2' : '#39414f', name: 'Rule' }));
        for (const [icon, val] of rows) {
          els.push(T({ text: icon + '  ' + val, x: Math.round(60 * U), y: my, w: w - Math.round(120 * U), h: Math.round(56 * U), size: Math.round(28 * U), font: 'Poppins', weight: 700, color: ink }));
          my += Math.round(64 * U);
        }
        if (d.speakers.length) els.push(T({ text: 'Ministering: ' + d.speakers.map((s) => s.name).join(', '), x: Math.round(60 * U), y: my + Math.round(6 * U), w: w - Math.round(120 * U), h: Math.round(52 * U), size: Math.round(21 * U), font: 'Montserrat', weight: 600, color: p.accent, lineHeight: 1.25 }));
        const bg = paper ? { type: 'solid', color: '#faf7f0' } : { type: 'gradient', color: p.deep2, color2: p.deep, angle: 160 };
        return { w, h, background: bg, elements: els };
      },
    },

    {
      id: 'gradient-modern', name: 'Modern Gradient', tags: 'service sunday church welcome program general modern',
      palettes: ['emerald', 'royal', 'neon', 'ocean', 'crimson'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(70 * U), y: Math.round(90 * U), w: w - Math.round(140 * U), h: Math.round(50 * U), size: Math.round(28 * U), font: 'Bebas Neue', letter: 4, color: p.ink }));
        const tSize = Math.round(clamp((w * 0.86) / (Math.max(...String(d.title).split(/\s+/).map((x) => x.length), 6) * 0.5), 48 * U, h * 0.12));
        els.push(T({ text: d.title, x: Math.round(66 * U), y: Math.round(170 * U), w: w - Math.round(132 * U), h: Math.round(tSize * 2.3), size: tSize, font: 'Poppins', weight: 800, color: p.ink, lineHeight: 1.05, effect: 'shadow' }));
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(70 * U), y: Math.round(170 * U + tSize * 2.3), w: w - Math.round(140 * U), h: Math.round(60 * U), size: Math.round(34 * U), font: 'Pacifico', weight: 400, color: p.accent }));
        const meta = [d.date && '📅  ' + d.date, d.time && '🕙  ' + d.time, d.venue && '📍  ' + d.venue].filter(Boolean).join('\n');
        els.push(T({ text: meta || '📅  Date\n🕙  Time\n📍  Venue', x: Math.round(70 * U), y: Math.round(h * 0.62), w: w - Math.round(140 * U), h: Math.round(h * 0.2), size: Math.round(30 * U), font: 'Montserrat', weight: 600, color: p.ink, lineHeight: 1.75 }));
        els.push(...chip(d.tagline || 'Everyone is welcome!', Math.round(70 * U), h - Math.round(140 * U), Math.round(w * 0.42), Math.round(76 * U), p.accent, p.chipInk, Math.round(25 * U)));
        return { w, h, background: bgImage(artClean(p, w, h)), elements: els };
      },
    },

    {
      id: 'army-volunteers', name: 'Army Duotone', tags: 'volunteers army soldiers military camo mission mobilization retreat',
      palettes: ['army', 'emerald', 'midnight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(44 * U), y: Math.round(44 * U), w: Math.round(w * 0.5), h: Math.round(46 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 3, color: p.ink }));
        const dt = [d.date, d.time].filter(Boolean).join('\n');
        if (dt) {
          els.push(R({ x: Math.round(w * 0.68), y: Math.round(40 * U), w: Math.round(w * 0.28), h: Math.round(110 * U), fill: p.accent, radius: Math.round(14 * U), rot: 2, name: 'Date chip' }));
          els.push(T({ text: dt, x: Math.round(w * 0.68), y: Math.round(52 * U), w: Math.round(w * 0.28), h: Math.round(90 * U), size: Math.round(26 * U), font: 'Bebas Neue', letter: 2, align: 'center', color: p.chipInk, lineHeight: 1.25, rot: 2 }));
        }
        // centre photo (soldier cut-out goes here) + convener chip
        const ps = Math.round(w * 0.44);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, ps, true), x: Math.round((w - ps) / 2), y: Math.round(h * 0.13), w: ps, h: ps, radius: Math.round(ps / 2), ph: true, shadowEl: true, name: 'Photo' }));
        if (d.speakers.length) {
          els.push(...chip(d.speakers[0].name, Math.round(w * 0.28), Math.round(h * 0.13) + ps + Math.round(10 * U), Math.round(w * 0.44), Math.round(52 * U), '#000000', '#ffffff', Math.round(20 * U)));
          els.push(...chip('CONVENER', Math.round(w * 0.38), Math.round(h * 0.13) + ps + Math.round(64 * U), Math.round(w * 0.24), Math.round(40 * U), p.accent, p.chipInk, Math.round(16 * U), 'Bebas Neue'));
        }
        // blocky stacked title + script overlay on the last line
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.84, 0.5, h * 0.14);
        let y = Math.round(h * 0.6);
        lines.forEach((line) => {
          els.push(T({ text: line, x: Math.round(44 * U), y, w: Math.round(w * 0.9), h: Math.round(size * 1.1), size, font: 'Anton', lineHeight: 1, letter: 2, effect: 'stone3d', nowrap: true }));
          y += Math.round(size * 0.96);
        });
        const scriptWord = d.theme ? d.theme.split(/\s+/).slice(0, 2).join(' ') : 'Meeting';
        els.push(T({ text: scriptWord, x: Math.round(w * 0.24), y: y - Math.round(size * 0.5), w: Math.round(w * 0.7), h: Math.round(size * 1.1), size: Math.round(size * 0.72), font: 'Great Vibes', align: 'center', color: p.accent2, rot: -6, effect: 'shadow', nowrap: true }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(44 * U), y: h - Math.round(92 * U), w: Math.round(w * 0.9), h: Math.round(56 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 700, color: p.ink }));
        return { w, h, background: photoOrArt('army soldiers military volunteers', p, artArmy, w, h, 'duo'), elements: els };
      },
    },

    {
      id: 'stamp-conference', name: 'Stamp Conference', tags: 'conference national confirmed registration convention summit gods army',
      palettes: ['crimson', 'gold', 'midnight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(44 * U), y: Math.round(40 * U), w: Math.round(w * 0.5), h: Math.round(70 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 700, color: p.ink, lineHeight: 1.2 }));
        els.push(T({ text: 'PRESENTS', x: Math.round(w * 0.72), y: Math.round(40 * U), w: Math.round(w * 0.24), h: Math.round(30 * U), size: Math.round(16 * U), font: 'Montserrat', weight: 600, letter: 4, align: 'center', color: p.ink, opacity: 0.85 }));
        els.push(T({ text: (d.edition || 'National Conference').toUpperCase(), x: Math.round(w * 0.66), y: Math.round(72 * U), w: Math.round(w * 0.3), h: Math.round(60 * U), size: Math.round(20 * U), font: 'Bebas Neue', letter: 2, align: 'center', color: p.accent, lineHeight: 1.2 }));
        // badge emblem behind the title
        const bw2 = Math.round(w * 0.34);
        els.push(IMG({ src: stickerSrc('badge', 'rgba(0,0,0,0.55)', p.accent), x: Math.round((w - bw2) / 2), y: Math.round(h * 0.09), w: bw2, h: Math.round(bw2 * 1.15), name: 'Badge' }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.4, 0.5, h * 0.06);
        let y = Math.round(h * 0.13);
        lines.forEach((line) => {
          els.push(T({ text: line, x: Math.round(w * 0.2), y, w: Math.round(w * 0.6), h: Math.round(size * 1.1), size, font: 'Anton', align: 'center', lineHeight: 1, effect: 'stone3d', nowrap: true }));
          y += Math.round(size * 1.0);
        });
        // giant rotated STAMP word behind the photo
        const stampWord = (d.tagline || 'CONFIRMED').toUpperCase();
        const stW = Math.round(w * 0.94);
        els.push(IMG({ src: stickerSrc('stamp', p.accent), x: Math.round(w * 0.03), y: Math.round(h * 0.42), w: stW, h: Math.round(stW / 2.4), rot: -10, opacity: 0.9, name: 'Stamp frame' }));
        els.push(T({ text: stampWord, x: Math.round(w * 0.05), y: Math.round(h * 0.44), w: Math.round(w * 0.9), h: Math.round(stW / 2.4 * 0.8), size: Math.round(clamp((w * 0.8) / (Math.max(stampWord.length, 5) * 0.5), 40 * U, 150 * U)), font: 'Anton', align: 'center', color: 'rgba(0,0,0,0)', stroke: Math.max(2, Math.round(4 * U)), strokeColor: p.accent, rot: -10, letter: 4, opacity: 0.95, effect: 'outline', nowrap: true }));
        // photo over the stamp
        const ps = Math.round(w * 0.46);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, Math.round(ps * 1.2)), x: Math.round((w - ps) / 2), y: Math.round(h * 0.36), w: ps, h: Math.round(ps * 1.2), radius: Math.round(18 * U), ph: true, shadowEl: true, name: 'Speaker photo' }));
        if (d.speakers.length) els.push(...chip(d.speakers[0].name, Math.round(w * 0.6), Math.round(h * 0.36) + Math.round(ps * 1.05), Math.round(w * 0.32), Math.round(46 * U), p.accent, p.chipInk, Math.round(17 * U)));
        // bottom info grid: date banner + venue + QR
        const by = Math.round(h * 0.8);
        els.push(R({ x: Math.round(40 * U), y: by, w: w - Math.round(80 * U), h: Math.round(64 * U), fill: p.accent, radius: Math.round(10 * U), name: 'Date banner' }));
        els.push(T({ text: (d.date || 'Date') + (d.time ? '  •  ' + d.time : ''), x: Math.round(60 * U), y: by + Math.round(10 * U), w: w - Math.round(120 * U), h: Math.round(46 * U), size: Math.round(28 * U), font: 'Poppins', weight: 700, align: 'center', color: p.chipInk }));
        els.push(R({ x: Math.round(40 * U), y: by + Math.round(76 * U), w: Math.round(w * 0.66), h: Math.round(120 * U), fill: 'rgba(0,0,0,0.55)', radius: Math.round(10 * U), name: 'Venue box' }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(60 * U), y: by + Math.round(92 * U), w: Math.round(w * 0.62), h: Math.round(92 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 700, color: '#ffffff', lineHeight: 1.35 }));
        const qs = Math.round(w * 0.15);
        els.push(IMG({ src: stickerSrc('qr', '#111111'), x: w - qs - Math.round(48 * U), y: by + Math.round(80 * U), w: qs, h: qs, ph: true, name: 'QR code — replace with yours' }));
        els.push(T({ text: 'SCAN TO REGISTER', x: w - qs - Math.round(64 * U), y: by + Math.round(84 * U) + qs, w: qs + Math.round(32 * U), h: Math.round(26 * U), size: Math.round(12 * U), font: 'Montserrat', weight: 700, letter: 1, align: 'center', color: p.ink }));
        return { w, h, background: photoOrArt('city night skyline', p, artCity, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'gold-celebration', name: 'Gold 3D Celebration', tags: 'celebration service anniversary gold thanksgiving jubilee hand of god',
      palettes: ['gold', 'crimson', 'royal'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        // collage strip: three photo slots across the top
        const cs = Math.round(w * 0.3);
        for (let i = 0; i < 3; i++) {
          els.push(IMG({ src: placeholderPhoto(p, false, cs, Math.round(cs * 0.78)), x: Math.round(w * 0.03 + i * (cs + w * 0.02)), y: Math.round(44 * U), w: cs, h: Math.round(cs * 0.78), radius: Math.round(12 * U), ph: true, shadowEl: true, name: 'Collage photo ' + (i + 1) }));
        }
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(44 * U + cs * 0.78 + 16 * U), w: Math.round(w * 0.8), h: Math.round(40 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, letter: 5, align: 'center', color: p.accent2 }));
        // gold 3D stacked title + script word
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.8, 0.78, h * 0.15);
        let y = Math.round(h * 0.32);
        lines.forEach((line) => {
          const sz = Math.min(size, Math.round((w * 0.82) / (Math.max(line.length, 2) * 0.8)));
          els.push(T({ text: line, x: Math.round(w * 0.06), y, w: Math.round(w * 0.88), h: Math.round(sz * 1.16), size: sz, font: 'Alfa Slab One', align: 'center', lineHeight: 1, effect: 'gold3d', nowrap: true }));
          y += Math.round(sz * 1.04);
        });
        const script = d.theme || 'Service';
        els.push(T({ text: script, x: Math.round(w * 0.15), y: y - Math.round(size * 0.32), w: Math.round(w * 0.7), h: Math.round(size * 0.9), size: Math.round(clamp((w * 0.6) / (Math.max(script.length, 5) * 0.42), 34 * U, size * 0.6)), font: 'Great Vibes', align: 'center', color: '#ff5464', rot: -5, effect: 'shadow', nowrap: true }));
        // speaker bottom-right + details left
        const ps = Math.round(w * 0.4);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, ps, true), x: w - ps - Math.round(36 * U), y: h - ps - Math.round(60 * U), w: ps, h: ps, radius: Math.round(ps / 2), ph: true, shadowEl: true, name: 'Speaker photo' }));
        if (d.speakers.length) els.push(...chip(d.speakers[0].name, w - ps - Math.round(20 * U), h - Math.round(104 * U), Math.round(ps * 0.9), Math.round(46 * U), p.accent, p.chipInk, Math.round(17 * U)));
        const meta = [d.date, d.time].filter(Boolean).join('   ');
        els.push(T({ text: meta || 'Date  •  Time', x: Math.round(48 * U), y: h - Math.round(300 * U), w: Math.round(w * 0.5), h: Math.round(50 * U), size: Math.round(30 * U), font: 'Poppins', weight: 800, color: p.ink }));
        els.push(T({ text: (d.venue || 'Venue').toUpperCase(), x: Math.round(48 * U), y: h - Math.round(240 * U), w: Math.round(w * 0.5), h: Math.round(120 * U), size: Math.round(24 * U), font: 'Poppins', weight: 700, color: p.accent, lineHeight: 1.35 }));
        return { w, h, background: photoOrArt('bokeh gold celebration glow', p, artBokeh, w, h, 'dark'), elements: els };
      },
    },

    {
      id: 'war-metal', name: 'War Chrome', tags: 'war weapons battle warfare spiritual sword victory conquer',
      palettes: ['crimson', 'fire', 'midnight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(...chip((d.church || 'OUR CHURCH').toUpperCase(), Math.round(w * 0.28), Math.round(44 * U), Math.round(w * 0.44), Math.round(54 * U), p.accent, p.chipInk, Math.round(20 * U), 'Bebas Neue'));
        // jet silhouettes sweeping across the sky
        els.push(IMG({ src: stickerSrc('jet', '#0d0507'), x: Math.round(w * 0.56), y: Math.round(h * 0.12), w: Math.round(w * 0.34), h: Math.round(w * 0.17), rot: -8, opacity: 0.9, name: 'Jet' }));
        els.push(IMG({ src: stickerSrc('jet', '#0d0507'), x: Math.round(w * 0.1), y: Math.round(h * 0.2), w: Math.round(w * 0.2), h: Math.round(w * 0.1), rot: -14, opacity: 0.7, name: 'Jet 2' }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.88, 0.52, h * 0.15);
        let y = Math.round(h * 0.3);
        lines.forEach((line) => {
          els.push(T({ text: line, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(size * 1.12), size, font: 'Anton', align: 'center', lineHeight: 1, letter: 2, effect: 'chrome3d', nowrap: true }));
          y += Math.round(size * 1.03);
        });
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(w * 0.15), y: y + Math.round(12 * U), w: Math.round(w * 0.7), h: Math.round(46 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 600, align: 'center', color: p.accent, letter: 2 }));
        const dt = [d.date, d.time].filter(Boolean).join('  •  ');
        if (dt) els.push(...chip(dt, Math.round(w * 0.22), Math.round(h * 0.68), Math.round(w * 0.56), Math.round(62 * U), 'rgba(0,0,0,0.6)', p.accent2, Math.round(24 * U)));
        els.push(T({ text: 'VENUE:', x: Math.round(48 * U), y: h - Math.round(250 * U), w: Math.round(w * 0.3), h: Math.round(36 * U), size: Math.round(19 * U), font: 'Bebas Neue', letter: 3, color: p.accent }));
        els.push(T({ text: (d.venue || 'Venue').toUpperCase(), x: Math.round(48 * U), y: h - Math.round(210 * U), w: Math.round(w * 0.52), h: Math.round(150 * U), size: Math.round(23 * U), font: 'Montserrat', weight: 700, color: p.ink, lineHeight: 1.4 }));
        const ps = Math.round(w * 0.34);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, ps, true), x: w - ps - Math.round(40 * U), y: h - ps - Math.round(64 * U), w: ps, h: ps, radius: Math.round(ps / 2), ph: true, shadowEl: true, name: 'Host photo' }));
        if (d.speakers.length) els.push(...chip(d.speakers[0].name, w - ps - Math.round(28 * U), h - Math.round(96 * U), Math.round(ps * 0.94), Math.round(44 * U), p.accent, p.chipInk, Math.round(16 * U)));
        return { w, h, background: photoOrArt('war storm smoke battle', p, artWarSky, w, h, 'tint'), elements: els };
      },
    },

    {
      id: 'fire-plaque', name: 'Fire & Gold Plaque', tags: 'fire understanding series part teaching word encounter glory',
      palettes: ['fire', 'gold', 'crimson'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(40 * U), w: Math.round(w * 0.8), h: Math.round(42 * U), size: Math.round(22 * U), font: 'Bebas Neue', letter: 5, align: 'center', color: p.ink }));
        // tall photo slot left (full-height minister cut-out)
        els.push(IMG({ src: placeholderPhoto(p, true, Math.round(w * 0.4), Math.round(h * 0.62)), x: Math.round(28 * U), y: Math.round(h * 0.24), w: Math.round(w * 0.4), h: Math.round(h * 0.62), radius: Math.round(16 * U), ph: true, shadowEl: true, name: 'Minister photo' }));
        // dark plaque with gold title
        const px = Math.round(w * 0.45), pw = Math.round(w * 0.51), py = Math.round(h * 0.26), phh = Math.round(h * 0.36);
        els.push(R({ x: px, y: py, w: pw, h: phh, fill: 'rgba(16,7,2,0.8)', radius: Math.round(16 * U), borderWidth: Math.max(2, Math.round(3 * U)), borderColor: p.accent, name: 'Plaque' }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, pw * 0.84, 0.55, phh / (lines.length + 1));
        let y = py + Math.round(phh * 0.5 - (lines.length * size * 1.02) / 2);
        lines.forEach((line) => {
          els.push(T({ text: line, x: px + Math.round(pw * 0.05), y, w: Math.round(pw * 0.9), h: Math.round(size * 1.14), size, font: 'Anton', align: 'center', lineHeight: 1, effect: 'fire3d', nowrap: true }));
          y += Math.round(size * 1.02);
        });
        if (d.edition) els.push(...chip(d.edition.toUpperCase(), px + Math.round(pw * 0.25), py + phh - Math.round(4 * U), Math.round(pw * 0.5), Math.round(46 * U), p.accent, p.chipInk, Math.round(18 * U), 'Bebas Neue'));
        if (d.speakers.length) els.push(T({ text: 'Ministering: ' + d.speakers[0].name, x: px, y: py + phh + Math.round(64 * U), w: pw, h: Math.round(44 * U), size: Math.round(21 * U), font: 'Poppins', weight: 700, align: 'center', color: p.ink }));
        if (d.theme) els.push(T({ text: d.theme, x: px, y: py + phh + Math.round(116 * U), w: pw, h: Math.round(48 * U), size: Math.round(22 * U), font: 'Pacifico', align: 'center', color: p.accent2 }));
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(12,4,1,0.72)' });
        return { w, h, background: photoOrArt('fire flame burn', p, artFlames, w, h, 'dark'), elements: els };
      },
    },

    {
      // Text-behind-photo look: the tall photo is pushed AFTER the title so it
      // renders ABOVE it — drop in a cut-out (Pop out subject) and the person
      // overlaps the giant gold letters like the reference posters.
      id: 'hero-overlap', name: 'Hero Overlap', tags: 'hero overlap depth power encounter atmosphere bold anointing',
      palettes: ['gold', 'fire', 'crimson', 'royal'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(40 * U), w: Math.round(w * 0.8), h: Math.round(40 * U), size: Math.round(22 * U), font: 'Bebas Neue', letter: 5, align: 'center', color: p.ink }));
        // left-aligned title column — the photo overlaps only its right edge,
        // so the preview stays readable even before a cut-out is dropped in
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.62, 0.6, h * 0.17);
        let y = Math.round(h * 0.18);
        lines.forEach((line) => {
          els.push(T({ text: line, x: Math.round(48 * U), y, w: Math.round(w * 0.66), h: Math.round(size * 1.12), size, font: 'Anton', align: 'left', lineHeight: 1, effect: 'gold3d', nowrap: true }));
          y += Math.round(size * 1.0);
        });
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(52 * U), y: y - Math.round(size * 0.28), w: Math.round(w * 0.55), h: Math.round(size * 0.9), size: Math.round(clamp((w * 0.45) / (Math.max(d.theme.length, 6) * 0.42), 30 * U, size * 0.55)), font: 'Great Vibes', align: 'center', color: p.accent2, rot: -5, effect: 'shadow', nowrap: true }));
        const dt = [d.date, d.time].filter(Boolean).join('  •  ');
        if (dt) els.push(...chip(dt, Math.round(48 * U), h - Math.round(212 * U), Math.round(w * 0.44), Math.round(56 * U), p.accent, p.chipInk, Math.round(22 * U)));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(48 * U), y: h - Math.round(136 * U), w: Math.round(w * 0.46), h: Math.round(100 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 700, color: p.ink, lineHeight: 1.35 }));
        // photo OVER the title (later in the array = higher layer)
        const pw2 = Math.round(w * 0.46), ph2 = Math.round(h * 0.58);
        els.push(IMG({ src: placeholderPhoto(p, false, pw2, ph2), x: w - pw2 - Math.round(30 * U), y: h - ph2 - Math.round(96 * U), w: pw2, h: ph2, radius: Math.round(18 * U), ph: true, shadowEl: true, name: 'Photo — sits over the title (try Pop out subject)' }));
        if (d.speakers.length) els.push(...chip(d.speakers[0].name, w - pw2 + Math.round(10 * U), h - Math.round(152 * U), Math.round(pw2 * 0.82), Math.round(46 * U), '#000000', '#ffffff', Math.round(17 * U)));
        return { w, h, background: photoOrArt('smoke fire dramatic dark', p, artFlames, w, h, 'tint'), elements: els };
      },
    },
    {
      // Filled title with an offset outline "echo" behind it — the double-vision
      // poster look; the echo + fill pair also frames the circle photo above.
      id: 'echo-outline', name: 'Echo Outline', tags: 'echo outline youth modern praise jam concert overflow joy vibes',
      palettes: ['neon', 'lime', 'crimson', 'ocean'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(...chip((d.church || 'OUR CHURCH').toUpperCase(), Math.round(w * 0.28), Math.round(40 * U), Math.round(w * 0.44), Math.round(50 * U), 'rgba(0,0,0,0.55)', '#ffffff', Math.round(18 * U), 'Bebas Neue'));
        const ps = Math.round(w * 0.4);
        els.push(IMG({ src: placeholderPhoto(p, false, ps, ps, true), x: Math.round((w - ps) / 2), y: Math.round(h * 0.12), w: ps, h: ps, radius: Math.round(ps / 2), ph: true, shadowEl: true, name: 'Photo' }));
        if (d.speakers.length) els.push(...chip(d.speakers[0].name, Math.round(w * 0.3), Math.round(h * 0.12) + ps + Math.round(10 * U), Math.round(w * 0.4), Math.round(44 * U), p.accent, p.chipInk, Math.round(17 * U)));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.86, 0.55, h * 0.13);
        let y = Math.round(h * 0.55);
        lines.forEach((line) => {
          const off = Math.round(size * 0.1);
          els.push(T({ text: line, x: Math.round(w * 0.07) - off, y: y - off, w: Math.round(w * 0.86), h: Math.round(size * 1.12), size, font: 'Anton', align: 'center', color: 'rgba(0,0,0,0)', effect: 'outline', stroke: Math.max(2, Math.round(3 * U)), strokeColor: p.accent2, lineHeight: 1, nowrap: true, opacity: 0.85, name: 'Echo outline' }));
          els.push(T({ text: line, x: Math.round(w * 0.07), y, w: Math.round(w * 0.86), h: Math.round(size * 1.12), size, font: 'Anton', align: 'center', color: p.accent, lineHeight: 1, effect: 'shadow', nowrap: true }));
          y += Math.round(size * 1.02);
        });
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(w * 0.15), y: y + Math.round(8 * U), w: Math.round(w * 0.7), h: Math.round(48 * U), size: Math.round(22 * U), font: 'Pacifico', align: 'center', color: p.accent2 }));
        detailsBar(d, p, w, h, U, els, { fill: 'rgba(0,0,0,0.6)' });
        return { w, h, background: photoOrArt('concert party neon lights crowd', p, artNeon, w, h, 'tint'), elements: els };
      },
    },

    {
      // Bible / Word study poster: a glowing open Bible centrepiece (artBible),
      // big title, a scripture reference, and the weekly schedule.
      id: 'bible-study', name: 'Bible / Word Study', tags: 'bible study word study scripture midweek teaching devotional lesson the word expository growth',
      palettes: ['scripture', 'royal', 'ocean', 'gold'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.1), y: Math.round(44 * U), w: Math.round(w * 0.8), h: Math.round(46 * U), size: Math.round(22 * U), font: 'Bebas Neue', letter: 5, align: 'center', color: p.accent2 }));
        els.push(...chip((d.edition || 'MIDWEEK BIBLE STUDY').toUpperCase(), Math.round(w * 0.24), Math.round(102 * U), Math.round(w * 0.52), Math.round(54 * U), p.accent, p.chipInk, Math.round(20 * U), 'Poppins'));
        const lines = stackWords(d.title || 'Word Study');
        const size = fitSize(lines, w * 0.86, 0.52, h * 0.12);
        let y = Math.round(h * 0.19);
        for (const line of lines) {
          els.push(T({ text: line, x: Math.round(w * 0.07), y, w: Math.round(w * 0.86), h: Math.round(size * 1.12), size, font: 'Anton', align: 'center', lineHeight: 1, effect: 'gold3d', nowrap: true }));
          y += Math.round(size * 1.02);
        }
        els.push(T({ text: d.theme ? '“' + d.theme + '”' : '“Study to show yourself approved.” — 2 Timothy 2:15', x: Math.round(w * 0.12), y: Math.round(h * 0.63), w: Math.round(w * 0.76), h: Math.round(96 * U), size: Math.round(26 * U), font: 'Playfair Display', italic: true, align: 'center', color: p.accent2, lineHeight: 1.25 }));
        const when = [d.date, d.time].filter(Boolean).join('   •   ') || 'Every Wednesday   •   6:00 PM';
        els.push(...chip(when, Math.round(w * 0.16), Math.round(h * 0.75), Math.round(w * 0.68), Math.round(70 * U), 'rgba(0,0,0,0.5)', p.accent, Math.round(26 * U), 'Poppins'));
        els.push(T({ text: d.speakers.length ? 'Teacher: ' + d.speakers.map((s) => s.name).join(' • ') : 'Come and grow in the Word', x: Math.round(w * 0.1), y: Math.round(h * 0.84), w: Math.round(w * 0.8), h: Math.round(46 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 700, align: 'center', color: p.ink }));
        els.push(T({ text: '📍 ' + (d.venue || 'The Church Auditorium'), x: Math.round(w * 0.1), y: Math.round(h * 0.89), w: Math.round(w * 0.8), h: Math.round(60 * U), size: Math.round(20 * U), font: 'Montserrat', weight: 600, align: 'center', color: p.accent2, opacity: 0.92, lineHeight: 1.25 }));
        return { w, h, background: photoOrArt('bible word study scripture the word read devotional', p, artBible, w, h, 'tint'), elements: els };
      },
    },

    {
      // Revival / crusade poster: one DOMINANT speaker portrait, a huge title
      // (last word accented), scripture-script theme, and a QR to register.
      id: 'revival-poster', name: 'Revival Poster', tags: 'revival crusade healing conference guest minister single speaker portrait register anointed emerging encounter',
      palettes: ['spotlight', 'fire', 'crimson', 'royal'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        // Host line + big stacked title at the top third.
        els.push(T({ text: (d.speakers.length ? d.speakers[0].name : (d.church || 'Guest Minister')).toUpperCase(), x: Math.round(w * 0.1), y: Math.round(44 * U), w: Math.round(w * 0.8), h: Math.round(48 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 4, align: 'center', color: p.accent2 }));
        const lines = stackWords(d.title);
        const size = fitSize(lines, w * 0.9, 0.5, h * 0.12);
        let y = Math.round(h * 0.1);
        lines.forEach((line, i) => {
          els.push(T({ text: line, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(size * 1.1), size, font: 'Anton', align: 'center', color: i === lines.length - 1 ? p.accent : p.ink, lineHeight: 1, effect: 'shadow', nowrap: true }));
          y += Math.round(size * 0.98);
        });
        if (d.theme) { els.push(T({ text: d.theme, x: Math.round(w * 0.13), y: y + Math.round(6 * U), w: Math.round(w * 0.74), h: Math.round(60 * U), size: Math.round(30 * U), font: 'Great Vibes', align: 'center', color: p.accent2 })); y += Math.round(56 * U); }
        // Solid bottom band holds the details so nothing overlaps the portrait.
        const bandY = Math.round(h * 0.74);
        // Contained portrait frame that ADAPTS to how tall the title ran, filling
        // the gap between title and band (empty reads as an intentional frame; drop
        // a full-body cut-out here + Pop out subject for the reference-poster look).
        const py = Math.round(y + 26 * U);
        const ph2 = Math.round(clamp(bandY - py - 28 * U, h * 0.18, h * 0.42));
        const pw = Math.round(Math.min(w * 0.6, ph2 * 0.92));
        els.push(IMG({ src: placeholderPhoto(p, false, pw, ph2), x: Math.round((w - pw) / 2), y: py, w: pw, h: ph2, radius: Math.round(20 * U), ph: true, shadowEl: true, name: 'Minister photo — drop a cut-out here' }));
        els.push(R({ x: 0, y: bandY, w, h: h - bandY, fill: 'rgba(0,0,0,0.62)', name: 'Bottom band' }));
        els.push(R({ x: 0, y: bandY, w, h: Math.round(5 * U), fill: p.accent, name: 'Accent rule' }));
        const dt = [d.date, d.time].filter(Boolean).join('   •   ') || 'Date • Time';
        els.push(T({ text: dt, x: Math.round(w * 0.06), y: bandY + Math.round(28 * U), w: Math.round(w * 0.6), h: Math.round(52 * U), size: Math.round(32 * U), font: 'Poppins', weight: 800, align: 'left', color: p.accent }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(w * 0.06), y: bandY + Math.round(84 * U), w: Math.round(w * 0.6), h: Math.round(88 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 600, align: 'left', color: '#ffffff', lineHeight: 1.25 }));
        const qs = Math.round(w * 0.17);
        els.push(IMG({ src: stickerSrc('qr', '#111111'), x: w - qs - Math.round(40 * U), y: bandY + Math.round(30 * U), w: qs, h: qs, ph: true, name: 'QR code — replace with yours' }));
        els.push(T({ text: 'SCAN TO REGISTER', x: w - qs - Math.round(40 * U), y: bandY + Math.round(34 * U) + qs, w: qs, h: Math.round(30 * U), size: Math.round(14 * U), font: 'Bebas Neue', letter: 2, align: 'center', color: p.accent2 }));
        return { w, h, background: photoOrArt('rays light crusade revival glory', p, artRays, w, h, 'dark'), elements: els };
      },
    },

    {
      // Holy Ghost fire night: fiery background, one minister photo, a GIANT
      // glowing title, and a date/time range across the bottom.
      id: 'holyghost-fire', name: 'Holy Ghost Fire', tags: 'holy ghost holy spirit fire hours vigil power encounter anointing outpouring pentecost night',
      palettes: ['fire', 'crimson', 'sunset', 'spotlight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(T({ text: (d.church || 'OUR CHURCH').toUpperCase(), x: Math.round(w * 0.06), y: Math.round(44 * U), w: Math.round(w * 0.5), h: Math.round(44 * U), size: Math.round(20 * U), font: 'Bebas Neue', letter: 3, color: p.accent2 }));
        if (d.edition) els.push(...chip(d.edition.toUpperCase(), Math.round(w * 0.56), Math.round(40 * U), Math.round(w * 0.38), Math.round(54 * U), p.accent, p.chipInk, Math.round(20 * U)));
        const ph2 = Math.round(h * 0.4), pw = Math.round(ph2 * 0.82);
        els.push(IMG({ src: placeholderPhoto(p, false, pw, ph2), x: Math.round((w - pw) / 2), y: Math.round(h * 0.1), w: pw, h: ph2, radius: Math.round(16 * U), ph: true, shadowEl: true, name: 'Minister photo' }));
        if (d.speakers.length) els.push(T({ text: d.speakers[0].name, x: Math.round(w * 0.1), y: Math.round(h * 0.1) + ph2 + Math.round(8 * U), w: Math.round(w * 0.8), h: Math.round(40 * U), size: Math.round(22 * U), font: 'Poppins', weight: 700, align: 'center', color: p.accent2, effect: 'shadow' }));
        const lines = stackWords(d.title);
        // cap by line count so a 3-4 line title still clears the bottom date/time
        const size = Math.min(fitSize(lines, w * 0.92, 0.46, h * 0.14), Math.round((h * 0.32) / lines.length));
        let y = Math.round(h * 0.54);
        for (const line of lines) {
          els.push(T({ text: line, x: Math.round(w * 0.04), y, w: Math.round(w * 0.92), h: Math.round(size * 1.08), size, font: 'Anton', align: 'center', lineHeight: 1, effect: 'silver3d', nowrap: true }));
          y += Math.round(size * 0.94);
        }
        if (d.theme) els.push(T({ text: d.theme, x: Math.round(w * 0.16), y: y + Math.round(4 * U), w: Math.round(w * 0.68), h: Math.round(50 * U), size: Math.round(22 * U), font: 'Playfair Display', italic: true, align: 'center', color: p.accent2 }));
        els.push(T({ text: (d.date || 'Date').toUpperCase(), x: Math.round(w * 0.06), y: Math.round(h * 0.9), w: Math.round(w * 0.44), h: Math.round(48 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 2, align: 'left', color: p.accent }));
        els.push(T({ text: (d.time || '6PM – 6AM').toUpperCase(), x: Math.round(w * 0.5), y: Math.round(h * 0.9), w: Math.round(w * 0.44), h: Math.round(48 * U), size: Math.round(24 * U), font: 'Bebas Neue', letter: 2, align: 'right', color: p.accent }));
        els.push(T({ text: '📍 ' + (d.venue || 'Venue'), x: Math.round(w * 0.06), y: Math.round(h * 0.94), w: Math.round(w * 0.88), h: Math.round(50 * U), size: Math.round(18 * U), font: 'Montserrat', weight: 600, align: 'center', color: '#ffffff', lineHeight: 1.2 }));
        return { w, h, background: photoOrArt('fire flame holy ghost power', p, artFire, w, h, 'tint'), elements: els };
      },
    },

    {
      // Wisdom / online-service poster: an eyebrow "LIVE" pill, a two-tone
      // graduated title, date + time chips, a venue handle, and two speakers.
      id: 'wisdom-service', name: 'Wisdom Service', tags: 'wisdom service impartation instagram live prophetic word online broadcast midweek two speakers encounter',
      palettes: ['midnight', 'royal', 'spotlight', 'ocean'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        els.push(...chip('● LIVE   ·   ' + (d.church || 'Wisdom Service').toUpperCase(), Math.round(w * 0.18), Math.round(48 * U), Math.round(w * 0.64), Math.round(54 * U), p.accent, p.chipInk, Math.round(19 * U), 'Poppins'));
        const lines = stackWords(d.title);
        const n = lines.length;
        let y = Math.round(h * 0.15);
        lines.forEach((line, i) => {
          const isLast = i === n - 1;
          const base = fitSize([line], w * 0.9, 0.5, h * 0.115);
          const size = isLast ? base : Math.max(Math.round(24 * U), Math.round(base * 0.6));
          els.push(T({ text: line, x: Math.round(w * 0.06), y, w: Math.round(w * 0.88), h: Math.round(size * 1.14), size, font: 'Anton', align: 'center', color: isLast ? p.accent : p.ink, lineHeight: 1, effect: 'shadow', nowrap: true }));
          y += Math.round(size * 1.02);
        });
        els.push(T({ text: '📅  ' + (d.date || 'Date'), x: Math.round(w * 0.1), y: Math.round(h * 0.575), w: Math.round(w * 0.8), h: Math.round(50 * U), size: Math.round(28 * U), font: 'Poppins', weight: 700, align: 'center', color: p.accent2 }));
        els.push(...chip(d.time || 'Time', Math.round(w * 0.3), Math.round(h * 0.64), Math.round(w * 0.4), Math.round(58 * U), 'rgba(0,0,0,0.5)', p.accent, Math.round(24 * U), 'Poppins'));
        els.push(...chip('VENUE:  ' + (d.venue || '@yourhandle'), Math.round(w * 0.2), Math.round(h * 0.72), Math.round(w * 0.6), Math.round(54 * U), p.accent, p.chipInk, Math.round(20 * U), 'Montserrat', 700));
        const speakers = d.speakers.length ? d.speakers : [{ name: 'Speaker One' }, { name: 'Speaker Two' }];
        speakerRow(d, p, speakers.slice(0, 2), Math.round(w * 0.08), Math.round(h * 0.79), Math.round(w * 0.84), Math.round(Math.min(w * 0.2, h * 0.14)), els, p.ink, U);
        return { w, h, background: photoOrArt('dark clouds glory prophetic night', p, artClean, w, h, 'dark'), elements: els };
      },
    },

    {
      // Portrait montage — a birthday / tribute poster modelled on the "Happy
      // Birthday Apostle Joshua Selman" flyers: a big hero portrait with several
      // faded, colour-washed portraits collaged around it, a gold script line +
      // a bold 3D name, a date ribbon, and a torn-paper footer.
      id: 'portrait-montage', name: 'Portrait Montage', tags: 'birthday celebrating father mother tribute appreciation honour anniversary happy birthday legend champion mentor thanksgiving thank you sir farewell ordination retirement dedication remembrance',
      palettes: ['purple', 'royal', 'crimson', 'spotlight'],
      build(d, w, h, p) {
        const U = w / 1080, els = [];
        // Faded secondary portraits collaged around the hero — drop your extra
        // photos here and they wash into the purple background like the reference.
        const ghost = (x, y, gw, gh, rot) => els.push(IMG({
          src: placeholderPhoto(p, false, Math.round(gw), Math.round(gh)),
          x: Math.round(x), y: Math.round(y), w: Math.round(gw), h: Math.round(gh),
          rot: rot || 0, radius: Math.round(14 * U), opacity: 0.34, filter: { sat: 0.5 },
          ph: true, name: 'Montage photo (faded — optional)',
        }));
        ghost(w * 0.01, h * 0.09, w * 0.30, h * 0.26, -3);   // top-left
        ghost(w * 0.70, h * 0.05, w * 0.29, h * 0.24, 3);    // top-right
        ghost(w * 0.00, h * 0.42, w * 0.25, h * 0.25, 2);    // mid-left
        ghost(w * 0.75, h * 0.40, w * 0.26, h * 0.30, -2);   // mid-right
        // eyebrow: the theme, else a "Celebrating…" phrase pulled from the text
        const eyebrow = d.theme || (((d.raw || '').match(/celebrating[^\n.]*|a (?:father|mother|man|woman|legend|general|hero|king|queen)[^\n.]*|man of god/i) || [])[0] || 'Celebrating a Father').trim();
        els.push(T({ text: eyebrow.toUpperCase(), x: Math.round(w * 0.08), y: Math.round(44 * U), w: Math.round(w * 0.84), h: Math.round(44 * U), size: Math.round(22 * U), font: 'Montserrat', weight: 700, letter: 6, align: 'center', color: p.accent2 }));
        // gold script line — Happy Birthday / Thank You / Congratulations
        const blob = ((d.title || '') + ' ' + (d.theme || '') + ' ' + (d.raw || '')).toLowerCase();
        const script = /birthday/.test(blob) ? 'Happy Birthday' : /(appreciat|thank)/.test(blob) ? 'Thank You' : /(farewell|retire)/.test(blob) ? 'Farewell' : 'Congratulations';
        els.push(T({ text: script, x: Math.round(w * 0.1), y: Math.round(86 * U), w: Math.round(w * 0.8), h: Math.round(104 * U), size: Math.round(74 * U), font: 'Great Vibes', align: 'center', color: p.accent, effect: 'glow', fxColor: p.accent }));
        // bold 3D name — the honouree (first speaker, else the title)
        const nameSrc = d.speakers.length ? d.speakers[0].name.replace(/^[A-Za-z]+\.\s*/, '') : d.title;
        const lines = stackWords(nameSrc);
        const size = fitSize(lines, w * 0.86, 0.5, h * 0.095);
        let y = Math.round(h * 0.185);
        lines.forEach((line, i) => {
          els.push(T({ text: line, x: Math.round(w * 0.05), y, w: Math.round(w * 0.9), h: Math.round(size * 1.1), size, font: 'Anton', align: 'center', lineHeight: 1, effect: i === lines.length - 1 ? 'gold3d' : 'silver3d', nowrap: true }));
          y += Math.round(size * 0.98);
        });
        // hero portrait — big, centre-lower, fully opaque + framed
        const hw = Math.round(w * 0.5), hh = Math.round(h * 0.46), hx = Math.round((w - hw) / 2), hy = Math.round(h * 0.40);
        els.push(IMG({ src: placeholderPhoto(p, false, hw, hh), x: hx, y: hy, w: hw, h: hh, radius: Math.round(22 * U), ph: true, shadowEl: true, name: 'Main portrait — drop the celebrant here, then Pop out subject' }));
        // date ribbon (gold banner, top-right of the hero)
        if (d.date) {
          const rw = Math.round(w * 0.28), rh = Math.round(rw * 0.34), rx = Math.round(w * 0.70), ry = Math.round(h * 0.33);
          els.push(IMG({ src: stickerSrc('ribbon', p.accent, p.deep2), x: rx, y: ry, w: rw, h: rh, name: 'Date ribbon' }));
          els.push(T({ text: d.date, x: rx, y: ry + Math.round(rh * 0.24), w: rw, h: Math.round(rh * 0.56), size: Math.round(clamp((rw * 0.82) / (Math.max(d.date.length, 6) * 0.5), 14 * U, 24 * U)), font: 'Bebas Neue', letter: 1, align: 'center', color: p.chipInk, lineHeight: 1 }));
        }
        // torn-paper footer with church + a tribute tagline
        const bandY = Math.round(h * 0.88);
        els.push(R({ x: 0, y: bandY - Math.round(10 * U), w, h: Math.round(20 * U), fill: '#f4f0ea', rot: -1, name: 'Torn edge' }));
        els.push(R({ x: 0, y: bandY, w, h: h - bandY, fill: '#f4f0ea', name: 'Footer paper' }));
        els.push(T({ text: (d.church || 'Our Church'), x: Math.round(w * 0.06), y: bandY + Math.round(22 * U), w: Math.round(w * 0.88), h: Math.round(46 * U), size: Math.round(27 * U), font: 'Poppins', weight: 800, align: 'center', color: p.deep2 }));
        els.push(T({ text: (d.tagline || 'Keep living. Keep soaring. We celebrate you.'), x: Math.round(w * 0.06), y: bandY + Math.round(66 * U), w: Math.round(w * 0.88), h: Math.round(40 * U), size: Math.round(17 * U), font: 'Montserrat', weight: 600, align: 'center', color: '#5b5348' }));
        return { w, h, background: photoOrArt('royal purple worship majesty glory', p, artBokeh, w, h, 'tint'), elements: els };
      },
    },
  ];

  /* ======================= free-text event parser ======================= */
  const MONTH_RX = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const DAY_RX = '\\d{1,2}(?:st|nd|rd|th)?';
  const WDCORE = '(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
  const WD_RX = WDCORE + '\\.?,?\\s+';
  const DATE_PATTERNS = [
    // recurring schedules: "Every Friday", "Every Sunday", "Daily", "Weekly"
    `(?:every|each)\\s+${WDCORE}s?`,
    `\\b(?:daily|weekly|fortnightly|monthly)\\b`,
    // "April 24th - April 30th, 2023" / "June 30th" / "Dec. 26th 2024"
    `(?:${WD_RX})?${MONTH_RX}\\.?\\s+${DAY_RX}(?:\\s*[-–]\\s*(?:${MONTH_RX}\\.?\\s+)?${DAY_RX})?(?:,?\\s*\\d{4})?`,
    // "24th April 2023" / "14th - 16th March" / "Fri 14th March 2025"
    `(?:${WD_RX})?${DAY_RX}(?:\\s*[-–]\\s*${DAY_RX})?\\s+(?:of\\s+)?${MONTH_RX}\\.?(?:,?\\s*\\d{4})?`,
    // 30/06/2026, 30-06-2026
    `\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}`,
  ];
  const TIME_RX = /\b(\d{1,2})([:.]\d{2})?\s*([ap])\.?m\.?\b/i;
  const TITLES = new Set(['pst', 'pastor', 'rev', 'reverend', 'evang', 'evangelist', 'min', 'minister', 'apostle', 'prophet', 'prophetess', 'bishop', 'dr', 'deacon', 'deaconess', 'elder', 'bro', 'brother', 'sis', 'sister', 'p']);
  const SP_RX = /\b([A-Za-z]{1,11})\.?\s+([A-Z][\w'’-]+(?:\s+[A-Z][\w'’.-]*){0,2})/g;
  const VENUE_WORDS = /(park|centre|center|auditorium|hall|arena|pavilion|stadium|cathedral|chapel|dome|camp\s?ground|road|rd\.?|street|avenue|ave\.?|junction|estate|close|crescent|area|complex|field|ground)/i;
  // NOTE: deliberately no "service" — "Celebration Service" etc. are TITLES;
  // host-service lines like "Wisdom & Power Service" still match via other words.
  // \bprays?\b matches the ministry word "Pray"/"Prays" (e.g. "Students Pray")
  // but NOT "Prayer" — "Prayer & Fasting" is a valid event TITLE, not a host.
  const HOST_WORDS = /(ministr(?:y|ies)|church|chapel|fellowship|assembly|global|international|int'?l|network|platforms|outreach|mission|\bprays?\b|wisdom)/i;

  function titleCase(s) {
    return String(s).toLowerCase().replace(/(^|\s|[-'’])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  function extractSpeakers(line, f) {
    let out = line, sm;
    SP_RX.lastIndex = 0;
    const found = [];
    while ((sm = SP_RX.exec(line))) {
      const t = sm[1].toLowerCase();
      if (!TITLES.has(t)) continue;
      const pretty = (sm[1].length <= 2 ? sm[1].toUpperCase() : titleCase(sm[1])) + '. ' + sm[2].trim();
      found.push({ raw: sm[0], name: pretty.replace(/\.\./g, '.') });
    }
    for (const s of found) {
      if (!f.speakers.some((x) => x.name.toLowerCase() === s.name.toLowerCase())) f.speakers.push({ name: s.name });
      out = out.replace(s.raw, ' ');
    }
    return out;
  }

  function parseEventText(text) {
    const raw = String(text || '').trim();
    const f = { title: '', theme: '', speakers: [], date: '', time: '', venue: '', church: '', edition: '', tagline: '', raw };
    if (!raw) return f;

    // Work line by line: extract fields and REMOVE what was consumed, so the
    // title can be found in whatever meaningful text survives.
    let lines = raw.replace(/\r/g, '').split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 1) lines = lines[0].split(/(?:[;|•]|,(?=\s*(?:venue|theme|time|date)\b))/i).map((l) => l.trim()).filter(Boolean);

    lines = lines.map((line) => {
      // theme
      const themeM = line.match(/theme\s*[:\-–]\s*(.+)/i);
      if (themeM && !f.theme) { f.theme = themeM[1].trim().replace(/["“”]/g, ''); return ''; }
      // edition
      const edM = line.match(/(\d{1,3}(?:st|nd|rd|th))\s+edition/i);
      if (edM && !f.edition) { f.edition = edM[0].trim(); line = line.replace(edM[0], ' '); }
      // date (longest pattern match on this line)
      if (true) {
        let dateM = null;
        for (const pat of DATE_PATTERNS) {
          const m = line.match(new RegExp(pat, 'i'));
          if (m && (!dateM || m[0].length > dateM[0].length)) dateM = m;
        }
        if (dateM && (!f.date || dateM[0].length > f.date.length)) {
          f.date = dateM[0].trim().replace(/\s+/g, ' ').replace(/[,\s]+$/, '');
          line = line.replace(dateM[0], ' ');
        }
      }
      // time
      const tM = line.match(TIME_RX);
      if (tM && !f.time) {
        f.time = tM[1] + (tM[2] ? tM[2].replace('.', ':') : '') + (tM[3].toLowerCase() === 'a' ? 'AM' : 'PM');
        if (/daily/i.test(line)) f.time += ' Daily';
        line = line.replace(tM[0], ' ').replace(/\(?\s*daily\s*\)?/i, ' ');
      }
      // titled speakers
      line = extractSpeakers(line, f);
      return line.replace(/\s+/g, ' ').trim();
    });

    // venue: explicit label first…
    for (let i = 0; i < lines.length; i++) {
      const venM = lines[i].match(/(?:venue|location|📍)\s*[:\-–]?\s*(.+)/i);
      if (venM) { f.venue = venM[1].trim(); lines[i] = ''; break; }
    }
    // …else the line with the most address-y words
    if (!f.venue) {
      let bestI = -1, bestScore = 0;
      lines.forEach((l, i) => {
        const words = (l.match(new RegExp(VENUE_WORDS.source, 'gi')) || []).length;
        const score = words * 2 + (/,\s/.test(l) ? 1 : 0) + (/^(at|@)\s/i.test(l) ? 2 : 0);
        if (words && score > bestScore) { bestI = i; bestScore = score; }
      });
      if (bestI >= 0) { f.venue = lines[bestI].replace(/^(at|@)\s+/i, ''); lines[bestI] = ''; }
    }
    f.venue = f.venue.replace(/\s+/g, ' ').replace(/[.,\s]+$/, '').trim();

    // church / host ministry
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l && l.length < 60 && HOST_WORDS.test(l) && !VENUE_WORDS.test(l) && i !== 0) {
        f.church = l.replace(/^\s*(by|from|host(?:ed)?\s*(?:by)?)[:\s]+/i, '').trim();
        lines[i] = '';
        break;
      }
    }

    // untitled speakers: "with First Last"
    if (!f.speakers.length) {
      for (let i = 0; i < lines.length; i++) {
        const withM = lines[i].match(/\bwith\s+((?:[A-Z][\w'’.-]+[\s&]*){1,4})/);
        if (withM) { f.speakers.push({ name: withM[1].trim() }); lines[i] = lines[i].replace(withM[0], ' '); break; }
      }
    }

    // title: explicit label, else the first meaningful surviving line
    const titleM = raw.match(/title\s*[:\-–]\s*([^\n;|]+)/i);
    if (titleM) f.title = titleM[1].trim();
    else {
      const left = lines.map((l) => l.replace(/^[\s\-•|*@:,.]+|[\s\-•|*@:,.&]+$/g, '').replace(/\s+/g, ' ').trim())
        .filter((l) => l && l.length > 2 && !/^(with|at|on|by|live on|time|date|daily|prompt|and)$/i.test(l));
      if (left.length) {
        // Prefer the first line that doesn't look like the host ministry's name
        // (e.g. "Osun Students Pray" above "Manifestation of His Power").
        const pick = left.find((l) => !HOST_WORDS.test(l)) || left[0];
        f.title = pick.replace(/\s*\bwith\b\s*$/i, '').trim();
        if (!f.church && pick !== left[0] && HOST_WORDS.test(left[0])) f.church = left[0];
        // leftover short brand-ish line ("The Envoys", "JCCF Nigeria…") → host slot
        if (!f.church) {
          const spare = left.find((l) => l !== pick && l.length <= 40 && !/\d/.test(l) && !VENUE_WORDS.test(l)
            && !/^(celebrat|happy|honou?r|congratulat|thank|welcome|introduc|presenting|a\s+(?:father|mother|man|woman|legend))/i.test(l));
          if (spare) f.church = spare;
        }
      }
    }
    if (f.title) f.title = titleCase(f.title.replace(/["“”]+/g, '')).slice(0, 70);
    return f;
  }

  /* ======================== design generation ======================== */
  const VIBES = [
    // specific looks first — they win the top slots when their keywords appear
    // Bible/Word study → the glowing open-Bible design (very distinctive keywords)
    { rx: /bible\s*stud|word\s*stud|scriptures?|midweek|devotional|expositor|\bthe word\b|study\s*group/i, tpl: ['bible-study', 'classic-elegant', 'royal-worship'], pal: ['scripture', 'royal', 'ocean'] },
    // Birthday / tribute / appreciation → the multi-portrait montage poster
    { rx: /\bbirthday\b|celebrating\s+a\s+(?:father|mother|man|woman|legend|king|queen|hero|champion|general|icon)|appreciation|\btribute\b|\bhonou?r(?:ing)?\b|farewell|retirement|\bthank\s*you\s*(?:pastor|daddy|father|sir|ma|mummy)|man\s+of\s+god/i, tpl: ['portrait-montage', 'gold-celebration', 'classic-elegant'], pal: ['purple', 'gold', 'royal'] },
    // Wisdom / online broadcast services → the two-speaker "LIVE" layout
    { rx: /wisdom\s*service|impartation|instagram\s*live|prophetic|online\s*(service|church|broadcast)|broadcast/i, tpl: ['wisdom-service', 'split-photo'], pal: ['midnight', 'royal'] },
    // national/confirmed conferences beat plain "army" (God's Army NATIONAL Conference → stamp look)
    { rx: /confirm|register|national|delegates?/i, tpl: ['stamp-conference', 'war-metal'], pal: ['crimson', 'gold'] },
    { rx: /volunteer|army|soldier|camo|military|troops|battalion/i, tpl: ['army-volunteers', 'stamp-conference'], pal: ['army', 'crimson'] },
    { rx: /weapons?|warfare|\bwar\b|battle|sword|conquer/i, tpl: ['war-metal', 'stamp-conference'], pal: ['crimson', 'fire'] },
    // "party" beats "celebration" when both appear (Holy Ghost Party celebration…)
    // \b guards: "Abundance" contains "dance", "Benjamin" contains "jam"
    { rx: /\bpart(y|ies)\b|\bjam|\bdance|\bvibes?\b|\bhang\s?out/i, tpl: ['neon-party', 'echo-outline', 'youth-sticker'], pal: ['neon', 'sunset'] },
    { rx: /celebrat|jubilee|hand of god/i, tpl: ['gold-celebration', 'waves-thanks'], pal: ['gold', 'sunset'] },
    // Holy Ghost / Holy Spirit fire nights — BELOW the party rule so "Holy Ghost
    // Party" still reads as a party, but "12 Hours in the Holy Ghost" gets fire.
    { rx: /holy\s*(ghost|spirit)|outpouring|pentecost|hours\s*in\s*the|fire\s*night/i, tpl: ['holyghost-fire', 'fire-conference', 'rays-crusade'], pal: ['fire', 'crimson', 'sunset'] },
    { rx: /understanding|part\s*\d|series|episode/i, tpl: ['fire-plaque', 'split-photo'], pal: ['fire', 'gold'] },
    { rx: /fire|flame|ignit|burn|power|supernatural/i, tpl: ['fire-conference', 'fire-plaque', 'hero-overlap', 'rays-crusade'], pal: ['fire', 'crimson'] },
    { rx: /\brain|abundan|overflow|harvest|\bdew\b|\bflow|shower/i, tpl: ['rain-stack', 'gradient-modern', 'waves-thanks'], pal: ['lime', 'emerald'] },
    { rx: /hallelu|praise|worship|songs?|choir|concert|encounter|presence|glory/i, tpl: ['script-night', 'royal-worship', 'waves-thanks'], pal: ['sky', 'royal', 'ocean'] },
    { rx: /vigil|midnight|night\s*watch|tarry|all\s*night/i, tpl: ['vigil-minimal', 'script-night'], pal: ['midnight', 'royal'] },
    { rx: /youth|teens?|campus|student/i, tpl: ['youth-sticker', 'echo-outline', 'neon-party', 'blocks-power'], pal: ['neon', 'lime'] },
    { rx: /conference|summit|convention|congress|retreat/i, tpl: ['fire-conference', 'split-photo', 'bold-minimal'], pal: ['fire', 'royal', 'midnight'] },
    { rx: /crusade|revival|healing|miracle|deliverance/i, tpl: ['revival-poster', 'rays-crusade', 'fire-conference'], pal: ['spotlight', 'crimson', 'fire'] },
    // single-portrait "anointed/emerging" posters (register/seats handled by the stamp rule above)
    { rx: /anointed|emerging|\bseats?\b|guest\s*minister|mentorship|impartation/i, tpl: ['revival-poster', 'split-photo'], pal: ['spotlight', 'royal'] },
    { rx: /thanks|gratitude|anniversary/i, tpl: ['waves-thanks', 'classic-elegant'], pal: ['sunset', 'emerald'] },
    { rx: /prayer|pray|intercess|fasting/i, tpl: ['vigil-minimal', 'blocks-power', 'royal-worship'], pal: ['midnight', 'royal'] },
    { rx: /wedding|dinner|gala|ordination|induction/i, tpl: ['classic-elegant', 'royal-worship'], pal: ['paper', 'royal'] },
    { rx: /manifest|mighty|dominion|glory/i, tpl: ['blocks-power', 'fire-conference'], pal: ['emerald', 'fire'] },
  ];

  const SAMPLE = {
    title: 'Manifestation of His Power', theme: 'Flood Gates of the Supernatural',
    speakers: [{ name: 'Pst. Daniel Olawande' }, { name: 'Evang. Moses Ade Bamijoko' }],
    date: 'Friday, June 30th', time: '9PM', venue: 'Oba Adenile Park, Onisekere Area, Osogbo',
    church: 'Osun Students Pray', edition: '10th Edition', tagline: 'Everyone is welcome!', raw: '',
  };

  function normalize(fields, brand) {
    const d = Object.assign({}, SAMPLE, { speakers: [] }, fields || {});
    if (!d.title) d.title = 'Special Service';
    if (!Array.isArray(d.speakers)) d.speakers = [];
    d.speakers = d.speakers.map((s) => (typeof s === 'string' ? { name: s } : s)).slice(0, 4);
    if (!d.church && brand && brand.churchName) d.church = brand.churchName;
    return d;
  }

  function buildTemplate(templateId, paletteId, fields, w, h, brand) {
    const tpl = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
    const p = Object.assign({ id: paletteId }, PALETTES[paletteId] || PALETTES.emerald);
    const d = normalize(fields, brand);
    const design = tpl.build(d, w || 1080, h || 1350, p);
    design.meta = { templateId: tpl.id, paletteId: p.id };
    return design;
  }

  /** text or fields → ranked list of ready designs. */
  function generateDesigns({ text, fields, w = 1080, h = 1350, count = 8, brand } = {}) {
    const f = fields || parseEventText(text || '');
    const hay = [f.title, f.theme, f.raw].filter(Boolean).join(' ');
    const combos = [];
    const seen = new Set();
    const push = (tplId, palId) => {
      const key = tplId + '|' + palId;
      if (seen.has(key)) return;
      if (!TEMPLATES.some((t) => t.id === tplId) || !PALETTES[palId]) return;
      seen.add(key); combos.push({ tplId, palId });
    };
    // Wiser routing: score every vibe by how strongly the wording matches (more
    // keyword hits = stronger theme), so even vague or mixed text lands on the
    // most fitting design first. Ties keep VIBES declaration order (its priority),
    // so "Holy Ghost Party" still reads party and "God's Army National" still stamps.
    const countHits = (rx) => {
      const g = new RegExp(rx.source, rx.flags.includes('g') ? rx.flags : rx.flags + 'g');
      const m = hay.match(g);
      return m ? m.length : 0;
    };
    const ranked = VIBES.map((v, idx) => ({ v, idx, hits: countHits(v.rx) }))
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || a.idx - b.idx);
    for (const { v } of ranked) v.tpl.forEach((t, i) => push(t, v.pal[Math.min(i, v.pal.length - 1)]));
    // fill with each template's own favourite palettes for variety
    for (const t of TEMPLATES) push(t.id, t.palettes[0]);
    for (const t of TEMPLATES) for (const pl of t.palettes.slice(1)) push(t.id, pl);
    return combos.slice(0, count).map(({ tplId, palId }) => {
      const design = buildTemplate(tplId, palId, f, w, h, brand);
      const tpl = TEMPLATES.find((t) => t.id === tplId);
      return { templateId: tplId, paletteId: palId, name: tpl.name + ' · ' + PALETTES[palId].name, design, fields: f };
    });
  }

  window.FlyerTemplates = { PALETTES, TEMPLATES, SAMPLE, parseEventText, generateDesigns, buildTemplate, placeholderPhoto, stackWords, STICKERS, stickerSrc, PHOTOS, loadPhotoLibrary, photoSrc, photosLoaded, pickPhoto, scrim };
})();
