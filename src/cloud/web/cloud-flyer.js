'use strict';
/*
 * ►► THE FLYER STUDIO (Home → Flyers). ◄◄
 *
 * "Church flyers on Pinterest — it must match that standard." Those flyers are
 * made in Photoshop by a designer, and they are always the same three layers:
 *
 *   1. a DRAMATIC PICTURE — light rays, a mountain at dawn, a stage in haze,
 *      graded hard into the flyer's two colours;
 *   2. the PEOPLE — the pastor and the guest, cut out, big, glowing at the edge,
 *      their heads over the headline;
 *   3. the WORDS — huge condensed capitals with depth, a script word across
 *      the speaker, the date in a pill, the address with a pin.
 *
 * So that is how this makes them. The picture is painted by a free image AI on
 * the server (flyerart.js: FLUX.2 on Cloudflare, else FLUX on Pollinations);
 * the people are cut out on THIS phone (FlyerAI, the same MediaPipe model the
 * studio uses — nothing is uploaded); the words are set here, by the six
 * layouts below, every letter exactly as typed — an image model asked for
 * "12 Airport Road" writes "12 Aiport Raod".
 *
 * Then it is the operator's: every piece is a layer to tap, drag, pinch,
 * rotate, recolour, change the font of, cut the background out of, duplicate,
 * delete — with undo — the way Canva works. Save puts it in Photos; Post opens
 * the Social Scheduler with the flyer in it.
 *
 * THE KIT (flyer:kitGet / kitSave) means nothing is typed twice: the church's
 * name and logo, the address, the handles, the preachers with their photos
 * already cut out, and the week — Tuesday Bible Study, Friday prayer meeting,
 * Sunday service. Tap "Sunday Service" and the next Sunday's date is already
 * on it; Easter, Christmas and the crossover come up by themselves as they
 * near.
 */
(function () {
  const root = typeof window !== 'undefined' ? window : globalThis;

  /* ================================================================ DATES */

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYMS = 86400000;
  const atNoon = (d) => { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; };
  const addDays = (d, n) => { const x = atNoon(d); x.setDate(x.getDate() + n); return x; };

  function ordinal(n) {
    const s = ['TH', 'ST', 'ND', 'RD'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  /* "6pm", "18:30", "9.30 AM" → minutes after midnight (or null) */
  function timeMinutes(t) {
    const m = /(\d{1,2})(?:[:.](\d{2}))?\s*([ap])?\.?\s*m?\.?/i.exec(String(t || ''));
    if (!m) return null;
    let h = +m[1]; const min = +(m[2] || 0);
    if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    return h * 60 + min;
  }
  /* "6pm" → "6:00PM", "18:30" → "6:30PM" — the way flyers print it */
  function niceTime(t) {
    const s = String(t || '').trim();
    if (!s) return '';
    const parts = s.split(/\s*(?:-|–|to)\s*/i).filter(Boolean);
    if (parts.length > 1) return parts.map(niceTime).join(' – ');
    const mins = timeMinutes(s);
    if (mins == null) return s.toUpperCase();
    const h = Math.floor(mins / 60), m = mins % 60;
    return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'PM' : 'AM'}`;
  }

  /* The next time a weekly service comes round — today, if it has not started yet. */
  function nextWeekday(day, now = new Date(), time = '') {
    const n = new Date(now);
    let add = (day - n.getDay() + 7) % 7;
    if (add === 0) {
      const mins = timeMinutes(time);
      if (mins != null && n.getHours() * 60 + n.getMinutes() > mins + 60) add = 7;
    }
    return addDays(n, add);
  }

  /* Easter Sunday (the Anonymous Gregorian algorithm) */
  function easter(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(y, month - 1, day, 12);
  }
  function nthSunday(y, month, n) { const d = new Date(y, month, 1, 12); d.setDate(1 + ((7 - d.getDay()) % 7) + (n - 1) * 7); return d; }

  /* The church year's big days, with the look each one wants. */
  function seasons(y) {
    const e = easter(y);
    const xmas = new Date(y, 11, 25, 12);
    const carol = addDays(xmas, -((xmas.getDay() + 7) % 7 || 7));   // the Sunday before Christmas
    return [
      { id: 'newyear', name: 'New Year Thanksgiving Service', date: nthSunday(y, 0, 1), script: 'Thanksgiving', theme: 'A Year of Open Doors', kind: 'new year thanksgiving service' },
      { id: 'mothering', name: 'Mothering Sunday', date: addDays(e, -21), script: 'Mothers', theme: 'Celebrating Our Mothers', kind: "mother's day service" },
      { id: 'palm', name: 'Palm Sunday', date: addDays(e, -7), script: 'Hosanna', theme: 'Hosanna in the Highest', kind: 'palm sunday easter' },
      { id: 'goodfriday', name: 'Good Friday Service', date: addDays(e, -2), script: 'It is Finished', theme: 'The Power of the Cross', kind: 'good friday cross easter' },
      { id: 'easter', name: 'Easter Sunday', date: e, script: 'Easter', theme: 'He Is Risen', kind: 'easter resurrection sunday' },
      { id: 'pentecost', name: 'Pentecost Sunday', date: addDays(e, 49), script: 'Pentecost', theme: 'Fire on the Altar', kind: 'pentecost holy ghost fire' },
      { id: 'fathers', name: "Father's Day Service", date: nthSunday(y, 5, 3), script: 'Fathers', theme: 'Honouring Our Fathers', kind: "father's day celebration" },
      { id: 'carol', name: 'Carol Service', date: carol, script: 'Christmas', theme: 'Joy to the World', kind: 'christmas carol service' },
      { id: 'christmas', name: 'Christmas Day Service', date: xmas, script: 'Christmas', theme: 'Emmanuel, God With Us', kind: 'christmas' },
      { id: 'crossover', name: 'Crossover Night', date: new Date(y, 11, 31, 12), script: 'Crossover', theme: 'Into the New Year', kind: 'crossover night new year', time: '10:00PM' },
    ];
  }

  /*
   * What a flyer might be wanted for next: each weekly service at its next
   * date, and any big day in the next ten weeks (sooner first).
   */
  function upcoming(kit, now = new Date()) {
    const out = [];
    for (const s of (kit && kit.services) || []) {
      const d = nextWeekday(s.day, now, s.time);
      out.push({ id: 'svc:' + s.id, name: s.name, date: d, time: s.time, kind: s.kind || s.name, service: s, weekly: true });
    }
    const today = atNoon(now).getTime();
    for (const y of [now.getFullYear(), now.getFullYear() + 1]) {
      for (const s of seasons(y)) {
        const t = atNoon(s.date).getTime();
        if (t >= today && t - today <= 70 * DAYMS) out.push(Object.assign({}, s, { id: 'season:' + s.id + y, seasonal: true }));
      }
    }
    // soonest first — a big day on the same date as a weekly service comes before it
    out.sort((a, b) => (atNoon(a.date) - atNoon(b.date)) || (a.seasonal === b.seasonal ? 0 : a.seasonal ? -1 : 1));
    return out;
  }

  /* A date in every shape a flyer prints it in. */
  function dateParts(d) {
    if (!d || isNaN(+new Date(d))) return null;
    const x = new Date(d);
    const day = DAYS[x.getDay()], month = MONTHS[x.getMonth()];
    return {
      day: day.toUpperCase(), dayName: day, dd: ordinal(x.getDate()), month: month.toUpperCase(), mon: month.slice(0, 3).toUpperCase() + '.', year: String(x.getFullYear()),
      short: `${ordinal(x.getDate())} ${month.toUpperCase()}`,
      long: `${day}, ${ordinal(x.getDate()).toLowerCase()} ${month} ${x.getFullYear()}`,
      iso: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`,
    };
  }

  const Dates = { nextWeekday, easter, seasons, upcoming, dateParts, niceTime, timeMinutes, ordinal };
  root.MWFlyerDates = Dates;
  if (typeof module !== 'undefined' && module.exports) module.exports = Dates;
  if (typeof document === 'undefined') return;

  /* ================================================================ FONTS */

  /*
   * The studio's own faces (bin/fonts, served at /fonts/), named for what a
   * flyer uses them for. Display: the big condensed capitals; script: the
   * word across the pastor; serif: the elegant theme.
   */
  const FONTS = [
    { id: 'Anton', file: 'Anton-Regular.ttf', kind: 'display' },
    { id: 'League Gothic', file: 'LeagueGothic-Regular.ttf', kind: 'display' },
    { id: 'Big Shoulders', file: 'BigShouldersDisplay-Black.ttf', kind: 'display' },
    { id: 'Barlow Italic', file: 'BarlowCondensed-ExtraBoldItalic.ttf', kind: 'display' },
    { id: 'Cinzel', file: 'Cinzel-Black.ttf', kind: 'serif' },
    { id: 'DM Serif', file: 'DMSerifDisplay-Regular.ttf', kind: 'serif' },
    { id: 'Abril Fatface', file: 'AbrilFatface-Regular.ttf', kind: 'serif' },
    { id: 'Alex Brush', file: 'AlexBrush-Regular.ttf', kind: 'script' },
    { id: 'Yellowtail', file: 'Yellowtail-Regular.ttf', kind: 'script' },
    { id: 'Bebas Neue', file: 'BebasNeue-Regular.ttf', kind: 'display' },
    { id: 'Oswald', file: 'Oswald-Bold.ttf', kind: 'display' },
    { id: 'Teko', file: 'Teko-Bold.ttf', kind: 'display' },
    { id: 'Archivo Black', file: 'ArchivoBlack-Regular.ttf', kind: 'display' },
    { id: 'Montserrat', file: 'Montserrat-ExtraBold.ttf', kind: 'text' },
    { id: 'Poppins', file: 'Poppins-Bold.ttf', kind: 'text' },
    { id: 'Rubik', file: 'Rubik-ExtraBold.ttf', kind: 'text' },
    { id: 'Playfair Display', file: 'PlayfairDisplay-ExtraBold.ttf', kind: 'serif' },
    { id: 'Alfa Slab One', file: 'AlfaSlabOne-Regular.ttf', kind: 'serif' },
    { id: 'Great Vibes', file: 'GreatVibes-Regular.ttf', kind: 'script' },
    { id: 'Pacifico', file: 'Pacifico-Regular.ttf', kind: 'script' },
    { id: 'Bowlby One', file: 'BowlbyOne-Regular.ttf', kind: 'display' },
    { id: 'Passion One', file: 'PassionOne-Bold.ttf', kind: 'display' },
    { id: 'Bungee', file: 'Bungee-Regular.ttf', kind: 'display' },
    { id: 'Titan One', file: 'TitanOne-Regular.ttf', kind: 'display' },
    { id: 'Luckiest Guy', file: 'LuckiestGuy-Regular.ttf', kind: 'display' },
    { id: 'Bangers', file: 'Bangers-Regular.ttf', kind: 'display' },
    { id: 'Sigmar One', file: 'SigmarOne-Regular.ttf', kind: 'display' },
  ];
  const fam = (id) => `"FL ${id}"`;
  let fontsReady = null;
  function loadFonts(base) {
    if (fontsReady) return fontsReady;
    const b = base || root.MW_FLYER_FONTS || '/fonts/';
    fontsReady = Promise.all(FONTS.map(async (f) => {
      try {
        const face = new FontFace('FL ' + f.id, `url(${b}${encodeURIComponent(f.file)})`);
        await face.load();
        document.fonts.add(face);
      } catch (e) { /* a missing face falls back to the next in the stack */ }
    }));
    return fontsReady;
  }

  /* ============================================================== DRAWING */

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const uid = () => 'l' + Math.random().toString(36).slice(2, 9);
  function rng(seed) { let s = (seed >>> 0) || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h)); return c; }
  function hexRgb(h) { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); const n = m ? parseInt(m[1], 16) : 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgba(h, a) { const [r, g, b] = hexRgb(h); return `rgba(${r},${g},${b},${a})`; }
  function mix(h1, h2, t) { const a = hexRgb(h1), b = hexRgb(h2); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); }
  const lum = (h) => { const [r, g, b] = hexRgb(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

  /*
   * HOW SHARP. A flyer is laid out at 1080 wide; Save and Post draw it at
   * THREE times that — 3240 × 4050, past 4K — every letter, edge and glow
   * redrawn at that size, never blown up. (An iPhone will not make a canvas
   * over about 16.7 million pixels, so a tall Story stops just under it.)
   */
  let Q = 1;
  const HD = (S) => Math.min(3, Math.sqrt(16.5e6 / (S.w * S.h)));

  /* the pictures a scene refers to by key (a scene stays plain JSON, so undo is cheap) */
  const IMGS = new Map();
  const imgOf = (k) => IMGS.get(k) || null;
  function loadImg(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That picture could not be opened.')); i.src = src; });
  }
  const iw = (im) => im.naturalWidth || im.width;
  const ih = (im) => im.naturalHeight || im.height;

  function cover(ctx, im, x, y, w, h, fx = 0.5, fy = 0.5) {
    const s = Math.max(w / iw(im), h / ih(im));
    const dw = iw(im) * s, dh = ih(im) * s;
    ctx.drawImage(im, x + (w - dw) * fx, y + (h - dh) * fy, dw, dh);
  }

  /* brightness / contrast / saturation / black-and-white, by hand (Safari's canvas has no ctx.filter) */
  const adjCache = new Map();
  function adjusted(im, a, w, h) {
    const key = [IMGS_KEY(im), w, h, a.bright || 0, a.contrast || 0, a.sat || 0, a.gray ? 1 : 0, a.blur || 0].join('|');
    if (adjCache.has(key)) return adjCache.get(key);
    let c = canvas(w, h); const x = c.getContext('2d', { willReadFrequently: true });
    cover(x, im, 0, 0, w, h);
    if (a.blur) {   // a soft blur: down and back up
      const f = clamp(1 - a.blur / 30, 0.04, 1), s = canvas(w * f, h * f);
      s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
      x.clearRect(0, 0, w, h); x.imageSmoothingQuality = 'high'; x.drawImage(s, 0, 0, w, h);
    }
    if (a.bright || a.contrast || a.sat || a.gray) {
      const d = x.getImageData(0, 0, w, h), p = d.data;
      const br = (a.bright || 0) * 2.55, ct = 1 + (a.contrast || 0) / 100, st = a.gray ? 0 : 1 + (a.sat || 0) / 100;
      for (let i = 0; i < p.length; i += 4) {
        let r = p[i], g = p[i + 1], b = p[i + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * st; g = l + (g - l) * st; b = l + (b - l) * st;
        r = (r - 128) * ct + 128 + br; g = (g - 128) * ct + 128 + br; b = (b - 128) * ct + 128 + br;
        p[i] = r < 0 ? 0 : r > 255 ? 255 : r; p[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; p[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      x.putImageData(d, 0, 0);
    }
    if (adjCache.size > 24) adjCache.delete(adjCache.keys().next().value);
    adjCache.set(key, c);
    return c;
  }
  const imKeys = new WeakMap(); let imN = 0;
  function IMGS_KEY(im) { if (!imKeys.has(im)) imKeys.set(im, 'i' + (++imN)); return imKeys.get(im); }

  /* ------------------------------------------------ the painted-here background */

  /* For when no AI could be reached (and while it paints): rays, glow and bokeh in the flyer's colours. */
  function proceduralBg(w, h, pal, seed, style) {
    const c = canvas(w, h), x = c.getContext('2d'), r = rng(seed || 7);
    const g = x.createLinearGradient(0, 0, w * 0.3, h);
    g.addColorStop(0, pal.mid); g.addColorStop(0.55, mix(pal.mid, pal.deep, 0.6)); g.addColorStop(1, pal.deep);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    const cx = w * (0.3 + r() * 0.4), cy = h * (0.12 + r() * 0.2);
    // god rays
    x.save(); x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + (r() - 0.5) * 2.6, len = h * 1.6, wd = 0.03 + r() * 0.07;
      const rg = x.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      rg.addColorStop(0, rgba(pal.hi, 0.22)); rg.addColorStop(1, rgba(pal.hi, 0));
      x.fillStyle = rg; x.beginPath(); x.moveTo(cx, cy);
      x.lineTo(cx + Math.cos(a - wd) * len, cy - Math.sin(-a + wd) * len); x.lineTo(cx + Math.cos(a + wd) * len, cy + Math.sin(a + wd) * len); x.closePath(); x.fill();
    }
    const glow = x.createRadialGradient(cx, cy, 0, cx, cy, w * 0.75);
    glow.addColorStop(0, rgba(pal.accent, 0.55)); glow.addColorStop(0.35, rgba(pal.accent, 0.12)); glow.addColorStop(1, rgba(pal.accent, 0));
    x.fillStyle = glow; x.fillRect(0, 0, w, h);
    // bokeh
    for (let i = 0; i < 46; i++) {
      const bx = r() * w, by = r() * h, br = 6 + r() * (style === 'big' ? 70 : 38);
      const bg = x.createRadialGradient(bx, by, 0, bx, by, br);
      const col = r() > 0.5 ? pal.accent : pal.hi;
      bg.addColorStop(0, rgba(col, 0.28 * r())); bg.addColorStop(0.75, rgba(col, 0.1)); bg.addColorStop(1, rgba(col, 0));
      x.fillStyle = bg; x.beginPath(); x.arc(bx, by, br, 0, Math.PI * 2); x.fill();
    }
    x.restore();
    return c;
  }

  /* ---------------------------------------------------------------- shapes */

  function tornPath(x, w, h, seed, edges) {
    const r = rng(seed || 3), step = 14;
    x.beginPath();
    x.moveTo(-w / 2, -h / 2);
    for (let px = -w / 2; px <= w / 2; px += step) x.lineTo(px, -h / 2 + (edges.top ? (r() - 0.5) * 18 + (r() > 0.85 ? (r() - 0.5) * 26 : 0) : 0));
    for (let py = -h / 2; py <= h / 2; py += step) x.lineTo(w / 2 + (edges.side ? (r() - 0.5) * 12 : 0), py);
    for (let px = w / 2; px >= -w / 2; px -= step) x.lineTo(px, h / 2 + (edges.bottom ? (r() - 0.5) * 18 + (r() > 0.85 ? (r() - 0.5) * 26 : 0) : 0));
    for (let py = h / 2; py >= -h / 2; py -= step) x.lineTo(-w / 2 + (edges.side ? (r() - 0.5) * 12 : 0), py);
    x.closePath();
  }
  function roundRect(x, X, Y, W, H, R) {
    const r = Math.min(R, W / 2, H / 2);
    x.beginPath(); x.moveTo(X + r, Y); x.arcTo(X + W, Y, X + W, Y + H, r); x.arcTo(X + W, Y + H, X, Y + H, r); x.arcTo(X, Y + H, X, Y, r); x.arcTo(X, Y, X + W, Y, r); x.closePath();
  }
  function fillOf(x, f, w, h) {
    if (f && typeof f === 'object' && f.stops) {
      const a = ((f.angle == null ? 90 : f.angle) * Math.PI) / 180;
      const dx = Math.cos(a) * w / 2, dy = Math.sin(a) * h / 2;
      const g = x.createLinearGradient(-dx, -dy, dx, dy);
      f.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, f.stops.length - 1), c));
      return g;
    }
    return f || '#ffffff';
  }

  function drawShape(x, L) {
    const w = L.w, h = L.h;
    x.fillStyle = fillOf(x, L.fill, w, h);
    if (L.shadow) { x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24 * Q; x.shadowOffsetY = 8 * Q; }
    switch (L.shape) {
      case 'pill': roundRect(x, -w / 2, -h / 2, w, h, h / 2); x.fill(); break;
      case 'round': roundRect(x, -w / 2, -h / 2, w, h, L.radius || 18); x.fill(); break;
      case 'band': { const k = L.skew == null ? 40 : L.skew; x.beginPath(); x.moveTo(-w / 2 + k, -h / 2); x.lineTo(w / 2, -h / 2); x.lineTo(w / 2 - k, h / 2); x.lineTo(-w / 2, h / 2); x.closePath(); x.fill(); break; }
      case 'slant': { const k = L.skew == null ? 60 : L.skew; x.beginPath(); x.moveTo(-w / 2, -h / 2 + k); x.lineTo(w / 2, -h / 2); x.lineTo(w / 2, h / 2); x.lineTo(-w / 2, h / 2); x.closePath(); x.fill(); break; }
      case 'torn': tornPath(x, w, h, L.seed, { top: true, bottom: true }); x.fill(); break;
      case 'ragged': tornPath(x, w, h, L.seed, { top: true, bottom: true, side: true }); x.fill(); break;
      case 'circle': x.beginPath(); x.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); x.fill();
        if (L.ring) { x.shadowColor = 'transparent'; x.lineWidth = L.ring; x.strokeStyle = L.ringColor || '#fff'; x.beginPath(); x.ellipse(0, 0, w / 2 - L.ring * 1.6, h / 2 - L.ring * 1.6, 0, 0, Math.PI * 2); x.stroke(); }
        break;
      case 'ring': {   // an outline: a circle when square, a pill when long
        const lw = L.line || 6; x.lineWidth = lw; x.strokeStyle = x.fillStyle;
        if (Math.abs(w - h) < 2) { x.beginPath(); x.ellipse(0, 0, w / 2 - lw, h / 2 - lw, 0, 0, Math.PI * 2); }
        else roundRect(x, -w / 2 + lw / 2, -h / 2 + lw / 2, w - lw, h - lw, (h - lw) / 2);
        x.stroke(); break;
      }
      case 'brush': {   // a painted swoosh, tapered at both ends
        const r = rng(L.seed || 9);
        x.beginPath(); x.moveTo(-w / 2, h * 0.1);
        x.bezierCurveTo(-w * 0.2, -h * 0.55, w * 0.2, -h * 0.5, w / 2, -h * 0.18);
        x.bezierCurveTo(w * 0.22, h * 0.05 + r() * 6, -w * 0.15, h * 0.12, -w / 2, h * 0.1);
        x.closePath(); x.fill();
        break;
      }
      case 'line': x.fillRect(-w / 2, -h / 2, w, h); break;
      case 'glow': {   // a soft light behind the people
        const col = typeof L.fill === 'string' ? L.fill : '#ffffff';
        const g = x.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
        g.addColorStop(0, col); g.addColorStop(0.45, rgba(col.length === 7 ? col : '#ffffff', 0.35)); g.addColorStop(1, rgba(col.length === 7 ? col : '#ffffff', 0));
        x.globalCompositeOperation = 'screen'; x.fillStyle = g; x.beginPath(); x.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); x.fill(); x.globalCompositeOperation = 'source-over';
        break;
      }
      case 'pin': {
        const s = Math.min(w, h);
        x.beginPath(); x.arc(0, -s * 0.12, s * 0.34, Math.PI * 0.85, Math.PI * 2.15); x.lineTo(0, s * 0.48); x.closePath(); x.fill();
        x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(0, -s * 0.12, s * 0.13, 0, Math.PI * 2); x.fill(); x.globalCompositeOperation = 'source-over';
        break;
      }
      case 'fade': {   // a gradient wash: transparent at the top to the colour at the bottom
        const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
        const col = typeof L.fill === 'string' ? L.fill : '#000000';
        g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.55, rgba(col, (L.strength || 0.85) * 0.75)); g.addColorStop(1, rgba(col, L.strength || 0.85));
        x.fillStyle = g; x.fillRect(-w / 2, -h / 2, w, h); break;
      }
      default: x.fillRect(-w / 2, -h / 2, w, h);
    }
    x.shadowColor = 'transparent';
  }

  /* ------------------------------------------------------------------- text */

  /* the face fills a flyer's lettering wears */
  const METALS = {
    gold: ['#7a4b0e', '#f8dc8b', '#b97d1c', '#fff2c4', '#8d5a12'],
    rust: ['#3b1c0a', '#a8611f', '#5a2d0e', '#d58a3a', '#3b1c0a'],
    silver: ['#5d6470', '#f2f5f8', '#8f97a3', '#ffffff', '#5d6470'],
    fire: ['#ffef9a', '#ffb300', '#ff5a00', '#b31200'],
    ice: ['#ffffff', '#d7f1ff', '#7cc8ff', '#2f7fd6'],
  };
  function textFill(x, L, w, h) {
    const f = L.fill;
    if (typeof f === 'string' && METALS[f]) return fillOf(x, { stops: METALS[f], angle: 90 }, w, h);
    return fillOf(x, f, w, h);
  }

  const txtCache = new Map();
  /* A text layer drawn on its own canvas (cached): depth, glow, outline, gradient or picture inside the letters. */
  function textCanvas(L) {
    const key = JSON.stringify([Q, L.text, L.font, L.size, L.fill, L.stroke, L.strokeColor, L.extrude, L.extrudeColor, L.glow, L.shadow, L.letter, L.align, L.line, L.slant, L.upper, L.maxW, L.grain, L.imgFill, L.imgFill && IMGS.has(L.imgFill)]);
    if (txtCache.has(key)) return txtCache.get(key);
    const m = canvas(4, 4).getContext('2d');
    const text = String(L.text == null ? '' : L.text);
    const lines = (L.upper ? text.toUpperCase() : text).split('\n');
    let size = L.size || 80;
    const fontOf = (s) => `${s}px ${fam(L.font || 'Anton')}, "Arial Black", Impact, sans-serif`;
    const lsp = (s) => (L.letter || 0) * s;
    const widthOf = (ln, s) => { m.font = fontOf(s); return m.measureText(ln).width + Math.max(0, ln.length - 1) * lsp(s); };
    let maxW = Math.max(1, ...lines.map((ln) => widthOf(ln, size)));
    if (L.maxW && maxW > L.maxW) { size = Math.max(8, size * (L.maxW / maxW)); maxW = Math.max(1, ...lines.map((ln) => widthOf(ln, size))); }
    const lh = size * (L.line || 1.0);
    const depth = L.extrude ? Math.round(L.extrude * size / 100) : 0;
    const pad = Math.ceil(size * 0.35 + depth + (L.glow ? size * 0.3 : 0) + (L.stroke || 0) * 2 + (L.shadow ? size * 0.12 : 0));
    const slant = L.slant ? 0.2 : 0;
    const W = maxW + pad * 2 + size * slant, H = lh * lines.length + pad * 2 + size * 0.25;
    const c = canvas(W * Q, H * Q), x = c.getContext('2d');
    x.scale(Q, Q);
    x.font = fontOf(size); x.textBaseline = 'alphabetic'; x.lineJoin = 'round';
    const asc = size * 0.82;
    const put = (ctx, ln, i, ox, oy, how) => {
      const lw = widthOf(ln, size);
      let sx = L.align === 'left' ? pad : L.align === 'right' ? W - pad - lw - size * slant : (W - lw - size * slant) / 2;
      const sy = pad + asc + i * lh + (lh - size) / 2;
      sx += ox; const yy = sy + oy;
      if (!L.letter) { ctx[how](ln, sx + (slant ? (H - yy) * slant * 0 : 0), yy); return; }
      for (const ch of ln) { ctx[how](ch, sx, yy); sx += ctx.measureText(ch).width + lsp(size); }
    };
    if (slant) x.setTransform(Q, 0, -slant * Q, Q, slant * H * 0.5 * Q, 0);
    const each = (fn) => lines.forEach((ln, i) => fn(ln, i));
    // depth: the letters stepped back toward the bottom right in a darker colour
    if (depth) {
      x.fillStyle = L.extrudeColor || 'rgba(0,0,0,.55)';
      for (let d = depth; d >= 1; d--) each((ln, i) => put(x, ln, i, d * 0.7, d, 'fillText'));
    }
    if (L.glow) {
      x.save(); x.shadowColor = L.glow; x.shadowBlur = size * 0.35 * Q; x.fillStyle = L.glow;
      each((ln, i) => put(x, ln, i, 0, 0, 'fillText')); x.restore();
    }
    if (L.shadow) { x.save(); x.shadowColor = 'rgba(0,0,0,.55)'; x.shadowBlur = size * 0.14 * Q; x.shadowOffsetY = size * 0.05 * Q; }
    if (L.stroke) { x.lineWidth = L.stroke * 2; x.strokeStyle = L.strokeColor || '#000'; each((ln, i) => put(x, ln, i, 0, 0, 'strokeText')); }
    if (L.shadow && !L.stroke) { x.fillStyle = 'rgba(0,0,0,.01)'; }
    // the face: plain, gradient, metal, or a picture inside the letters
    if (L.fill !== 'none') {
      const face = canvas(W * Q, H * Q), fx = face.getContext('2d');
      fx.scale(Q, Q);
      fx.font = x.font; fx.lineJoin = 'round';
      if (slant) fx.setTransform(Q, 0, -slant * Q, Q, slant * H * 0.5 * Q, 0);
      fx.translate(W / 2, H / 2);
      fx.fillStyle = textFill(fx, L, maxW, lh * lines.length);
      fx.translate(-W / 2, -H / 2);
      each((ln, i) => put(fx, ln, i, 0, 0, 'fillText'));
      fx.setTransform(Q, 0, 0, Q, 0, 0);
      const im = L.imgFill && imgOf(L.imgFill);
      if (im) { fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = 0.9; cover(fx, im, 0, 0, W, H); fx.globalAlpha = 1; }
      if (L.grain) {   // a worn, printed texture
        fx.globalCompositeOperation = 'source-atop';
        const r = rng(7);
        for (let i = 0; i < (W * H) / 90; i++) { fx.fillStyle = r() > 0.5 ? 'rgba(0,0,0,.18)' : 'rgba(255,255,255,.14)'; fx.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 2); }
      }
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.drawImage(face, 0, 0);
      x.setTransform(Q, 0, 0, Q, 0, 0);
    }
    if (L.shadow) x.restore();
    const out = { c, w: W, h: H, pad, size };
    if (txtCache.size > 120) txtCache.delete(txtCache.keys().next().value);
    txtCache.set(key, out);
    return out;
  }

  /* ----------------------------------------------------------------- images */

  const picCache = new Map();
  function imageCanvas(L, im) {
    const w = Math.round(L.w * Q), h = Math.round(L.h * Q);
    const key = [IMGS_KEY(im), w, h, L.gray ? 1 : 0, L.fade || 0, L.glow || '', L.bright || 0, L.contrast || 0, L.sat || 0, L.radius || 0, L.outline || ''].join('|');
    if (picCache.has(key)) return picCache.get(key);
    const pad = Math.round((L.glow ? 40 : L.outline ? 14 : 0) * Q);
    const c = canvas(w + pad * 2, h + pad * 2), x = c.getContext('2d');
    const body = (L.gray || L.bright || L.contrast || L.sat) ? adjusted(im, { gray: L.gray, bright: L.bright, contrast: L.contrast, sat: L.sat }, w, h) : null;
    const layer = canvas(w, h), lx = layer.getContext('2d');
    if (L.radius) { roundRect(lx, 0, 0, w, h, L.radius * Q); lx.clip(); }
    if (body) lx.drawImage(body, 0, 0); else cover(lx, im, 0, 0, w, h);
    if (L.fade) {   // melt into the flyer at the bottom
      lx.globalCompositeOperation = 'destination-out';
      const g = lx.createLinearGradient(0, h * (1 - L.fade), 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      lx.fillStyle = g; lx.fillRect(0, 0, w, h);
    }
    if (L.outline) {   // a sticker edge, the cut-out traced in a colour
      const o = canvas(w + pad * 2, h + pad * 2), ox = o.getContext('2d');
      for (let a = 0; a < 16; a++) ox.drawImage(layer, pad + Math.cos(a / 8 * Math.PI) * 9 * Q, pad + Math.sin(a / 8 * Math.PI) * 9 * Q);
      ox.globalCompositeOperation = 'source-in'; ox.fillStyle = L.outline; ox.fillRect(0, 0, o.width, o.height);
      x.drawImage(o, 0, 0);
    }
    if (L.glow) { x.save(); x.shadowColor = L.glow; x.shadowBlur = 38 * Q; x.drawImage(layer, pad, pad); x.restore(); }
    x.drawImage(layer, pad, pad);
    const out = { c, pad };
    if (picCache.size > 30) picCache.delete(picCache.keys().next().value);
    picCache.set(key, out);
    return out;
  }

  /* ------------------------------------------------------------------ scene */

  function drawBg(x, S, L) {
    const im = imgOf(L.img);
    const W = S.w, H = S.h, pal = S.pal;
    if (im) {
      const a = { bright: L.bright, contrast: L.contrast, sat: L.sat, gray: L.gray, blur: L.blur };
      x.drawImage(adjusted(im, a, Math.round(W * Q), Math.round(H * Q)), 0, 0, W, H);
    } else { x.fillStyle = pal.deep; x.fillRect(0, 0, W, H); }
    const t = L.tint == null ? 0.45 : L.tint;
    if (t > 0) {   // the grade: the picture wears the flyer's two colours
      x.save();
      x.globalCompositeOperation = 'color'; x.globalAlpha = t * 0.85;
      const g = x.createLinearGradient(0, 0, W * 0.4, H);
      g.addColorStop(0, pal.mid); g.addColorStop(1, pal.deep);
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.globalCompositeOperation = 'soft-light'; x.globalAlpha = t * 0.7;
      x.fillStyle = pal.mid; x.fillRect(0, 0, W, H);
      x.restore();
    }
    if (L.vignette !== 0) {
      const v = x.createRadialGradient(W / 2, H * 0.42, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.8);
      v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, rgba(pal.deep, L.vignette == null ? 0.75 : L.vignette));
      x.fillStyle = v; x.fillRect(0, 0, W, H);
    }
    if (L.wash) { x.fillStyle = L.wash; x.fillRect(0, 0, W, H); }
    // the photographic finish: a light leak in the flyer's colour, and fine grain
    if (L.leak !== 0) {
      x.save(); x.globalCompositeOperation = 'screen';
      const g = x.createRadialGradient(W * 0.85, H * 0.05, 0, W * 0.85, H * 0.05, W * 0.9);
      g.addColorStop(0, rgba(pal.accent, 0.32 * (L.leak == null ? 1 : L.leak))); g.addColorStop(1, rgba(pal.accent, 0));
      x.fillStyle = g; x.fillRect(0, 0, W, H); x.restore();
    }
    if (L.grain !== 0) {
      x.save(); x.globalCompositeOperation = 'overlay'; x.globalAlpha = 0.07 * (L.grain == null ? 1 : L.grain);
      x.fillStyle = x.createPattern(grainTile(), 'repeat'); x.fillRect(0, 0, W, H); x.restore();
    }
  }
  let grainC = null;
  function grainTile() {
    if (grainC) return grainC;
    grainC = canvas(160, 160);
    const x = grainC.getContext('2d'), d = x.createImageData(160, 160), r = rng(42);
    for (let i = 0; i < d.data.length; i += 4) { const v = r() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; }
    x.putImageData(d, 0, 0);
    return grainC;
  }

  /** Where a layer sits, for picking and the selection box: centre, size, turn. */
  function boxOf(L) {
    if (L.type === 'text') { const t = textCanvas(L); return { w: t.w - t.pad * 1.4, h: t.h - t.pad * 1.4 }; }
    return { w: L.w, h: L.h };
  }

  function drawLayer(x, S, L) {
    if (L.hidden) return;
    if (L.type === 'bg') return drawBg(x, S, L);
    x.save();
    x.globalAlpha = L.opacity == null ? 1 : L.opacity;
    x.translate(L.x, L.y);
    if (L.rot) x.rotate((L.rot * Math.PI) / 180);
    const s = L.s || 1; if (s !== 1) x.scale(s, s);
    if (L.flip) x.scale(-1, 1);
    if (L.type === 'text') {
      const t = textCanvas(L);
      x.drawImage(t.c, -t.w / 2, -t.h / 2, t.w, t.h);
    } else if (L.type === 'image') {
      const im = imgOf(L.img);
      if (im) { const p = imageCanvas(L, im); x.drawImage(p.c, -L.w / 2 - p.pad / Q, -L.h / 2 - p.pad / Q, p.c.width / Q, p.c.height / Q); }
    } else if (L.type === 'shape') drawShape(x, L);
    x.restore();
  }

  function render(S, cv, q) {
    Q = q || 1;
    cv.width = Math.round(S.w * Q); cv.height = Math.round(S.h * Q);
    const x = cv.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.setTransform(Q, 0, 0, Q, 0, 0);
    x.clearRect(0, 0, S.w, S.h);
    try { for (const L of S.layers) drawLayer(x, S, L); } finally { Q = 1; }
    return cv;
  }

  /* ================================================================ LAYOUTS */

  /*
   * Six looks, each one a family of real flyers (the Pinterest board the
   * operator showed): SCRIPT — a script word sweeping across the pastor;
   * JOIN US — enormous stacked capitals, the speakers' heads over them, a
   * slanted band of details; BREAKTHROUGH — a giant metal title on a light
   * page; TORN — a black-and-white photo and a torn paper strip; SCENIC — an
   * italic gradient title over a landscape; THEME BOX — the theme in serif
   * lettering in a black ragged box. Each takes the event (D) and returns
   * layers; the operator can then move every one.
   */
  const T = (o) => Object.assign({ id: uid(), type: 'text', x: 540, y: 200, rot: 0, s: 1, font: 'Anton', size: 100, fill: '#ffffff', align: 'center', line: 1 }, o);
  const SH = (o) => Object.assign({ id: uid(), type: 'shape', x: 540, y: 200, rot: 0, s: 1, shape: 'rect', w: 200, h: 80, fill: '#ffffff' }, o);
  const IM = (o) => Object.assign({ id: uid(), type: 'image', x: 540, y: 600, rot: 0, s: 1, w: 500, h: 700 }, o);
  const BG = (o) => Object.assign({ id: 'bg', type: 'bg', name: 'Background', lock: true, tint: 0.45 }, o);

  /* the people, sized to stand on a line: height h, feet at y */
  function person(sp, cx, footY, h, extra) {
    const im = imgOf(sp.img); if (!im) return null;
    const w = h * iw(im) / ih(im);
    return IM(Object.assign({ img: sp.img, name: sp.name || 'Speaker', speaker: sp.id || '', photo: sp.photo || '', x: cx, y: footY - h / 2, w, h }, extra || {}));
  }
  function people(D, opts) {
    const list = D.sp.filter((s) => imgOf(s.img)).slice(0, opts.max || 2);
    if (!list.length) return [];
    const n = list.length, out = [];
    const h = opts.h * (n > 1 ? opts.shrink || 0.9 : 1);
    list.forEach((s, i) => {
      const cx = n === 1 ? opts.cx : opts.cx + (i - (n - 1) / 2) * opts.gap;
      const L = person(s, cx, opts.foot + (i ? opts.lift || 0 : 0), i ? h * 0.94 : h, opts.extra);
      if (L) out.push(L);
    });
    return n > 1 ? out.reverse() : out;   // the first-named stands in front
  }
  function brand(D, opts = {}) {
    const out = [];
    const ink = opts.ink || '#ffffff';
    let x = opts.x || 70; const y = opts.y || 78;
    if (D.logo && imgOf(D.logo)) {
      const im = imgOf(D.logo), h = 74, w = Math.min(160, h * iw(im) / ih(im));
      out.push(IM({ img: D.logo, name: 'Logo', x: x + w / 2, y, w, h }));
      x += w + 18;
    }
    if (D.f.church) out.push(T({ name: 'Church', text: D.f.church, font: 'Montserrat', size: 26, upper: true, fill: ink, align: 'left', maxW: opts.maxW || 520, x: x + Math.min(520, D.f.church.length * 15) / 2, y, letter: 0.02 }));
    return out;
  }
  /* lay layers side by side, centred on cx, each as wide as it draws */
  function row(items, cx, gap) {
    const ws = items.map((L) => (L.type === 'text' ? boxOf(L).w : L.w));
    let x = cx - (ws.reduce((a, b) => a + b, 0) + gap * (items.length - 1)) / 2;
    items.forEach((L, i) => { L.x = x + ws[i] / 2; x += ws[i] + gap; });
    return items;
  }
  /*
   * THE DETAILS ROW every one of those flyers ends on: date | time | where,
   * with hairlines between — each cell a big line and a small one.
   */
  function infoRow(D, y, cells, o = {}) {
    const ink = o.ink || '#ffffff', acc = o.accent || D.pal.accent, out = [];
    const items = cells.filter((c) => c && (c.big || c.small));
    if (!items.length) return out;
    const cols = items.map((c) => {
      const big = c.big ? T({ name: c.name || 'Detail', text: c.big, font: c.font || 'Anton', size: c.size || 54, fill: c.accent ? acc : ink, align: 'left', line: 0.95, y: y - (c.small ? 14 : 0), maxW: c.maxW || 300, upper: true }) : null;
      const small = c.small ? T({ name: (c.name || 'Detail') + ' note', text: c.small, font: 'Montserrat', size: c.smallSize || 18, fill: c.accent && !c.big ? acc : rgba(ink, 0.88), align: 'left', line: 1.15, y: y + (c.big ? 30 : 0), maxW: c.maxW || 300, upper: true }) : null;
      const label = c.label ? T({ name: c.label, text: c.label + ':', font: 'Montserrat', size: 15, fill: o.labelInk || '#111111', align: 'left', y: y - (c.big ? 64 : 46), letter: 0.12 }) : null;
      const w = Math.max(big ? boxOf(big).w : 0, small ? boxOf(small).w : 0, label ? boxOf(label).w + 20 : 0);
      return { big, small, w, pin: c.pin, label };
    });
    const gap = o.gap || 34;
    const total = cols.reduce((a, c) => a + c.w + (c.pin ? 40 : 0), 0) + gap * 2 * (cols.length - 1);
    let x = (o.cx || 540) - total / 2;
    cols.forEach((c, i) => {
      if (c.pin) { out.push(SH({ name: 'Pin', shape: 'pin', fill: acc, x: x + 16, y, w: 34, h: 34 })); x += 40; }
      if (c.label) {
        const lw = boxOf(c.label).w + 20;
        out.push(SH({ name: 'Label', shape: 'round', fill: acc, radius: 8, x: x + lw / 2, y: c.label.y, w: lw, h: 28 }));
        c.label.x = x + lw / 2; out.push(c.label);
      }
      if (c.big) { c.big.x = x + boxOf(c.big).w / 2; out.push(c.big); }
      if (c.small) { c.small.x = x + boxOf(c.small).w / 2; out.push(c.small); }
      x += c.w;
      if (i < cols.length - 1) { out.push(SH({ name: 'Divider', shape: 'line', fill: rgba(ink, 0.5), x: x + gap, y, w: 2, h: 76 })); x += gap * 2; }
    });
    return out;
  }
  /* up to three lines, the long words alone, so each line can be set as wide as the flyer */
  function stack(title, max = 3) {
    const w = String(title || '').trim().split(/\s+/).filter(Boolean);
    if (w.length <= max) return w;
    const lines = []; let cur = '';
    const target = Math.ceil(w.join(' ').length / max);
    for (const word of w) { if (cur && (cur + ' ' + word).length > target && lines.length < max - 1) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; }
    if (cur) lines.push(cur);
    return lines;
  }
  const speakerLine = (D) => D.sp.map((s) => s.name).filter(Boolean).join(' & ');
  const venueText = (D) => D.f.venue || '';
  const W = 1080;

  const LAYOUTS = {
    /* ── a script word across the pastor (the purple "Sunday" flyer) ── */
    script(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.55 })];
      L.push(...people(D, { cx: 600, foot: H - 120, h: H * 0.76, gap: 330, max: 2, extra: { glow: rgba(p.accent, 0.55), fade: 0.18 } }));
      L.push(SH({ name: 'Shade', shape: 'fade', fill: p.deep, x: 540, y: H - 260, w: W, h: 520, strength: 0.92 }));
      L.push(...brand(D));
      L.push(T({ name: 'Kicker', text: (D.dir.kicker || 'WORSHIP WITH US THIS').split(/\s+/).reduce((a, w, i, arr) => a + w + (i === Math.ceil(arr.length / 2) - 1 ? '\n' : ' '), '').trim(), font: 'Montserrat', size: 30, upper: true, fill: '#ffffff', shadow: true, align: 'right', line: 1.1, x: 200, y: H - 640 }));
      L.push(T({ name: 'Script', text: D.script, font: 'Great Vibes', size: 330, fill: '#ffffff', glow: rgba(p.accent, 0.8), shadow: true, x: 540, y: H - 400, rot: -7, maxW: 980 }));
      if (speakerLine(D)) L.push(T({ name: 'With', text: 'WITH\n' + speakerLine(D).replace(' & ', '\n& '), font: 'Montserrat', size: 24, upper: true, fill: '#ffffff', shadow: true, align: 'left', line: 1.2, x: 880, y: H - 610, maxW: 330 }));
      // 16TH AUGUST (7AM)
      const day = T({ name: 'Day', text: f.dd || '', font: 'Bebas Neue', size: 96, fill: '#ffffff', shadow: true, y: H - 205 });
      const mon = T({ name: 'Month', text: f.month || '', font: 'Bebas Neue', size: 96, fill: p.accent, slant: true, shadow: true, y: H - 205 });
      const tm = T({ name: 'Time', text: f.time || '', font: 'Bebas Neue', size: 70, fill: '#ffffff', y: H - 203, maxW: 220 });
      const ring = SH({ name: 'Time ring', shape: 'pill', fill: 'rgba(255,255,255,.14)', y: H - 207, w: boxOf(tm).w + 44, h: 86 });
      row([day, mon, ring], 540, 22);
      tm.x = ring.x;
      L.push(day, mon, ring, SH({ name: 'Time line', shape: 'ring', fill: '#ffffff', line: 3, x: ring.x, y: ring.y, w: ring.w, h: ring.h }), tm);
      if (venueText(D)) {
        L.push(SH({ name: 'Pin', shape: 'pin', fill: p.accent, x: 120, y: H - 120, w: 40, h: 40 }));
        L.push(T({ name: 'Venue', text: venueText(D), font: 'Montserrat', size: 24, upper: true, fill: '#ffffff', align: 'left', x: 560, y: H - 118, maxW: 860 }));
      }
      if (f.handles) L.push(T({ name: 'Handles', text: f.handles, font: 'Montserrat', size: 22, fill: rgba('#ffffff', 0.85), x: 540, y: H - 62, maxW: 900 }));
      return L;
    },

    /* ── JOIN US THIS SUNDAY: huge stacked capitals, heads over them, a slanted band ── */
    joinus(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.7, sat: 20 })];
      L.push(...brand(D));
      const top = D.titleTop, big = D.titleBig;
      L.push(T({ name: 'Title 1', text: top, font: 'Anton', size: 250, upper: true, fill: '#ffffff', extrude: 6, extrudeColor: rgba(p.deep, 0.75), x: 540, y: 300, maxW: 960, line: 0.9 }));
      L.push(T({ name: 'Title 2', text: big, font: 'Anton', size: 300, upper: true, fill: { stops: ['#ffffff', mix('#ffffff', p.hi, 0.4)], angle: 90 }, extrude: 6, extrudeColor: rgba(p.deep, 0.75), x: 540, y: 560, maxW: 980 }));
      L.push(SH({ name: 'Chip', shape: 'band', fill: p.accent, x: 560, y: 420, w: 220, h: 78, rot: -8, skew: 18, shadow: true }));
      L.push(T({ name: 'Chip text', text: D.chip || 'THIS', font: 'Anton', size: 62, fill: lum(p.accent) > 0.6 ? '#111111' : '#ffffff', x: 560, y: 422, rot: -8, maxW: 190 }));
      L.push(...people(D, { cx: 640, foot: H - 230, h: H * 0.55, gap: 400, max: 2, lift: -10, extra: { glow: rgba(p.hi, 0.35) } }));
      // the band
      L.push(SH({ name: 'Band', shape: 'slant', fill: { stops: [p.deep, mix(p.deep, p.mid, 0.5)], angle: 0 }, x: 540, y: H - 145, w: W, h: 300, skew: 70 }));
      L.push(SH({ name: 'Band edge', shape: 'slant', fill: p.accent, x: 540, y: H - 300, w: W, h: 16, skew: 70 }));
      L.push(T({ name: 'Date', text: `${f.mon || ''} ${f.dd || ''}`.trim(), font: 'Anton', size: 104, fill: '#ffffff', align: 'left', x: 260, y: H - 205, maxW: 440 }));
      L.push(T({ name: 'Time', text: [f.time, f.time2].filter(Boolean).join('   '), font: 'Anton', size: 46, fill: p.accent, align: 'left', x: 260, y: H - 130, maxW: 440 }));
      if (venueText(D)) L.push(T({ name: 'Venue', text: venueText(D), font: 'Montserrat', size: 24, upper: true, fill: '#ffffff', align: 'left', x: 270, y: H - 72, maxW: 460, line: 1.1 }));
      if (f.handles) L.push(T({ name: 'Handles', text: f.handles, font: 'Montserrat', size: 22, fill: p.accent, align: 'right', x: 820, y: H - 60, maxW: 400 }));
      if (speakerLine(D)) L.push(T({ name: 'Speakers', text: speakerLine(D).replace(/ & /g, '\n& '), font: 'Anton', size: 46, upper: true, fill: '#ffffff', align: 'right', x: 820, y: H - 130, maxW: 400, line: 1.0 }));
      return L;
    },

    /* ── BREAKTHROUGH: a giant metal title on a light page ── */
    breakthrough(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.15, wash: 'rgba(250,247,241,.78)', vignette: 0, sat: 10 })];
      L.push(SH({ name: 'Glow', shape: 'glow', fill: p.accent, x: 900, y: 140, w: 700, h: 700, opacity: 0.5 }));
      L.push(...brand(D, { ink: '#1a1a1a' }));
      if (f.extra) L.push(T({ name: 'Edition', text: f.extra, font: 'Playfair Display', size: 44, fill: '#2a2a2a', align: 'right', x: 880, y: 150, maxW: 360, line: 0.95 }));
      const words = D.titleWords;
      L.push(T({ name: 'Title 1', text: words[0], font: 'Anton', size: 330, upper: true, fill: 'gold', grain: true, extrude: 7, extrudeColor: '#3b2208', x: 520, y: 510, maxW: 1000, line: 0.86 }));
      if (words[1]) L.push(T({ name: 'Title 2', text: words[1], font: 'Anton', size: 250, upper: true, fill: 'rust', grain: true, extrude: 7, extrudeColor: '#2a1405', x: 480, y: 750, maxW: 900 }));
      L.push(T({ name: 'Kicker', text: D.dir.kicker || 'JOIN US', font: 'Barlow Italic', size: 92, upper: true, fill: '#c81e1e', shadow: true, x: 300, y: 285, rot: -5, maxW: 480 }));
      if (f.theme) {
        L.push(T({ name: 'Theme label', text: 'THEME:', font: 'Montserrat', size: 20, fill: '#555', x: 90, y: 880, align: 'left' }));
        L.push(T({ name: 'Theme', text: twoLines(f.theme.toUpperCase()).filter(Boolean).join('\n'), font: 'Anton', size: 50, fill: '#1a1a1a', slant: true, align: 'left', x: 230, y: 950, line: 0.95, maxW: 360 }));
      }
      L.push(...people(D, { cx: 770, foot: H - 80, h: H * 0.52, gap: 300, max: 2, extra: {} }));
      // the dates, as red chips
      L.push(SH({ name: 'Date chip', shape: 'rect', fill: '#c81e1e', x: 190, y: H - 290, w: 250, h: 100 }));
      L.push(T({ name: 'Date', text: `${f.dd || ''}\n${(f.month || '').slice(0, 3)}, ${f.year || ''}`, font: 'Anton', size: 42, fill: '#ffffff', x: 190, y: H - 290, line: 0.95, maxW: 220 }));
      L.push(SH({ name: 'Time chip', shape: 'rect', fill: '#1a1a1a', x: 375, y: H - 290, w: 120, h: 100 }));
      L.push(T({ name: 'Time', text: (f.time || '').replace(/\s*–\s*/, '–\n'), font: 'Anton', size: 34, fill: '#ffffff', x: 375, y: H - 290, line: 1, maxW: 110 }));
      if (venueText(D)) {
        L.push(SH({ name: 'Pin', shape: 'pin', fill: '#c81e1e', x: 90, y: H - 192, w: 34, h: 34 }));
        L.push(T({ name: 'Venue', text: venueText(D).replace(/,\s*/g, ',\n'), font: 'Montserrat', size: 22, fill: '#222', align: 'left', slant: true, x: 270, y: H - 160, line: 1.15, maxW: 340 }));
      }
      L.push(SH({ name: 'Footer', shape: 'rect', fill: '#ffffff', x: 540, y: H - 40, w: W, h: 80 }));
      L.push(T({ name: 'Contacts', text: [f.phone, f.handles].filter(Boolean).join('  |  ') || (f.church || ''), font: 'Montserrat', size: 24, fill: '#1a1a1a', x: 540, y: H - 40, maxW: 980 }));
      return L;
    },

    /* ── TORN: black and white, a torn paper strip, two boxes ── */
    torn(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0, gray: true, contrast: 25, bright: -18 })];
      L.push(...brand(D));
      L.push(...people(D, { cx: 720, foot: H * 0.66, h: H * 0.6, gap: 280, max: 2, extra: { gray: true, contrast: 15 } }));
      L.push(T({ name: 'Title', text: D.titleBig, font: 'Anton', size: 210, upper: true, fill: 'none', stroke: 3, strokeColor: rgba('#ffffff', 0.9), x: 540, y: H * 0.58, maxW: 1000 }));
      L.push(SH({ name: 'Paper', shape: 'torn', fill: '#f7f7f5', x: 540, y: H * 0.78, w: 1180, h: H * 0.2, rot: -2, shadow: true, seed: 11 }));
      if (speakerLine(D)) L.push(T({ name: 'Speakers', text: D.sp.map((s) => s.name).join('\n'), font: 'Montserrat', size: 26, fill: '#ffffff', align: 'left', x: 860, y: 260, line: 1.3, maxW: 360 }));
      const by = H * 0.27;
      L.push(SH({ name: 'Box 1', shape: 'rect', fill: p.accent, x: 210, y: by, w: 290, h: 110, shadow: true }));
      L.push(T({ name: 'When', text: (D.whenWord || 'THIS SUNDAY').replace(' ', '\n'), font: 'Anton', size: 46, fill: lum(p.accent) > 0.6 ? '#0f172a' : '#ffffff', align: 'left', x: 210, y: by, line: 0.95, maxW: 240 }));
      L.push(SH({ name: 'Box 2', shape: 'rect', fill: '#151515', x: 210, y: by + 108, w: 290, h: 100, shadow: true }));
      L.push(T({ name: 'Time', text: f.time || '', font: 'Anton', size: 64, fill: '#ffffff', x: 210, y: by + 110, maxW: 250 }));
      L.push(T({ name: 'Theme', text: f.theme || f.title || '', font: 'Anton', size: 92, upper: true, fill: '#151515', x: 540, y: H * 0.77, rot: -2, maxW: 960 }));
      L.push(SH({ name: 'Footer', shape: 'round', fill: '#ffffff', x: 540, y: H - 50, w: 1000, h: 64, radius: 32 }));
      L.push(T({ name: 'Venue', text: venueText(D) || f.church || '', font: 'Montserrat', size: 24, upper: true, fill: '#151515', x: 540, y: H - 50, letter: 0.04, maxW: 940 }));
      return L;
    },

    /* ── SCENIC: an italic gradient title over a landscape (the "Mountain Experience") ── */
    scenic(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.3, contrast: 10 })];
      if (f.church) L.push(T({ name: 'Church', text: f.church, font: 'Montserrat', size: 22, upper: true, fill: rgba('#ffffff', 0.9), letter: 0.5, x: 540, y: 90, maxW: 960 }));
      if (D.logo && imgOf(D.logo)) L.push(...brand(D).filter((l) => l.name === 'Logo').map((l) => Object.assign(l, { x: 540, y: 160 })));
      const words = D.titleWords;
      const grad = { stops: ['#ffffff', mix('#ffffff', p.accent, 0.35), p.accent], angle: 90 };
      L.push(T({ name: 'Title 1', text: words[0], font: 'Barlow Italic', size: 260, upper: true, fill: grad, shadow: true, extrude: 4, extrudeColor: rgba(p.deep, 0.9), x: 540, y: 330, maxW: 900 }));
      if (words[1]) L.push(T({ name: 'Title 2', text: words[1], font: 'Barlow Italic', size: 240, upper: true, fill: grad, shadow: true, extrude: 4, extrudeColor: rgba(p.deep, 0.9), x: 560, y: 540, maxW: 960 }));
      L.push(SH({ name: 'Brush', shape: 'brush', fill: '#e11d2a', x: 260, y: words[1] ? 560 : 360, w: 260, h: 90, rot: -14, opacity: 0.92 }));
      L.push(...people(D, { cx: 540, foot: H - 60, h: H * 0.55, gap: 340, max: 2, extra: { fade: 0.15 } }));
      L.push(SH({ name: 'Shade', shape: 'fade', fill: p.deep, x: 540, y: H - 120, w: W, h: 240, strength: 0.8 }));
      L.push(SH({ name: 'Time badge', shape: 'circle', fill: rgba(p.deep, 0.55), ring: 3, ringColor: '#ffffff', x: 190, y: H * 0.62, w: 190, h: 190 }));
      L.push(T({ name: 'Time', text: f.time || '', font: 'Anton', size: 60, fill: '#ffffff', slant: true, x: 190, y: H * 0.62, maxW: 160 }));
      L.push(T({ name: 'Day', text: f.dd || '', font: 'Anton', size: 120, fill: '#ffffff', slant: true, shadow: true, x: 880, y: H * 0.6, maxW: 300 }));
      L.push(SH({ name: 'Month tag', shape: 'rect', fill: '#ffffff', x: 880, y: H * 0.6 + 82, w: 250, h: 52 }));
      L.push(T({ name: 'Month', text: `${f.month || ''} ${f.year || ''}`, font: 'Anton', size: 40, fill: p.deep, x: 880, y: H * 0.6 + 84, maxW: 230 }));
      if (venueText(D)) {
        L.push(SH({ name: 'Address tag', shape: 'rect', fill: '#ffffff', x: 860, y: H * 0.6 + 200, w: 330, h: 130 }));
        L.push(T({ name: 'Address', text: 'Address:', font: 'Montserrat', size: 20, fill: '#e11d2a', align: 'left', x: 760, y: H * 0.6 + 155 }));
        L.push(T({ name: 'Venue', text: venueText(D).replace(/,\s*/g, ',\n'), font: 'Montserrat', size: 18, fill: '#111', align: 'left', x: 860, y: H * 0.6 + 212, line: 1.15, maxW: 300 }));
      }
      if (speakerLine(D)) L.push(T({ name: 'Speakers', text: 'With ' + speakerLine(D), font: 'Great Vibes', size: 54, fill: '#ffffff', glow: rgba(p.accent, 0.6), x: 540, y: H - 120, maxW: 860 }));
      L.push(T({ name: 'Footer', text: (f.kind || 'PRAYERS | WORSHIP').toUpperCase(), font: 'Montserrat', size: 18, fill: rgba('#ffffff', 0.85), letter: 0.6, x: 540, y: H - 40, maxW: 960 }));
      return L;
    },

    /* ── THEME BOX: the theme in serif lettering in a black ragged box ── */
    themebox(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.35 })];
      L.push(...brand(D));
      L.push(T({ name: 'Kicker', text: (D.dir.kicker || f.title || '').toUpperCase().replace(/^(\S+\s\S+)\s/, '$1\n'), font: 'Anton', size: 52, fill: '#ffffff', slant: true, shadow: true, align: 'right', x: 860, y: 110, line: 0.95, maxW: 360 }));
      L.push(SH({ name: 'Box', shape: 'ragged', fill: '#0b0b0d', x: 540, y: H * 0.36, w: 880, h: 440, rot: -1, shadow: true, seed: 5 }));
      L.push(T({ name: 'Theme label', text: 'THEME', font: 'Montserrat', size: 22, fill: '#ffffff', letter: 0.9, x: 540, y: H * 0.36 - 165 }));
      const tw = D.themeWords;
      L.push(T({ name: 'Theme 1', text: tw[0], font: 'DM Serif', size: 150, upper: true, fill: '#ffffff', x: 540, y: H * 0.36 - 55, maxW: 760 }));
      if (tw[1]) {
        const t2 = T({ name: 'Theme 2', text: tw[1], font: 'DM Serif', size: 130, upper: true, fill: '#ffffff', y: H * 0.36 + 100, maxW: tw[2] ? 560 : 760 });
        if (tw[2]) { const ac = T({ name: 'Accent', text: tw[2], font: 'Anton', size: 74, upper: true, fill: p.accent, slant: true, y: H * 0.36 + 106, rot: -4, maxW: 200 }); row([ac, t2], 540, 18); L.push(ac); } else t2.x = 540;
        L.push(t2);
      }
      L.push(...people(D, { cx: 540, foot: H - 140, h: H * 0.38, gap: 320, max: 2, extra: { glow: rgba('#ffffff', 0.25) } }));
      L.push(SH({ name: 'Info bar', shape: 'band', fill: '#0b0b0d', x: 560, y: H - 105, w: 940, h: 150, skew: 30, rot: -1, shadow: true }));
      L.push(SH({ name: 'Pin', shape: 'pin', fill: '#e11d2a', x: 110, y: H - 108, w: 70, h: 70 }));
      L.push(T({ name: 'Date', text: `${f.dd || ''}\n${f.month || ''}, ${f.year || ''}`, font: 'Anton', size: 46, fill: '#ffffff', align: 'left', x: 290, y: H - 108, line: 0.95, maxW: 260 }));
      L.push(T({ name: 'Time', text: `${f.time || ''}\n${(f.day || '').toUpperCase()}`, font: 'Anton', size: 40, fill: p.accent, align: 'left', x: 545, y: H - 108, line: 1, maxW: 200 }));
      if (venueText(D)) L.push(T({ name: 'Venue', text: venueText(D).replace(/,\s*/g, ',\n'), font: 'Montserrat', size: 18, fill: '#ffffff', align: 'left', x: 830, y: H - 108, line: 1.15, maxW: 250 }));
      return L;
    },
  };
  Object.assign(LAYOUTS, {
    /* ── GIANT: PUSH / PROPHETIC PRAYER MEETING / 6 HOURS PRAYER WATCH — the title fills the flyer, the preacher in front ── */
    giant(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.5, contrast: 12 })];
      L.push(...brand(D));
      if (f.theme && f.theme !== f.title) L.push(T({ name: 'Theme', text: 'THEME: ' + f.theme, font: 'Montserrat', size: 24, upper: true, fill: '#ffffff', shadow: true, x: 540, y: 165, maxW: 900, letter: 0.04 }));
      const lines = stack(f.title || 'Prayer Meeting', 3);
      const n = lines.length, top = n === 1 ? 420 : n === 2 ? 330 : 290, step = n === 3 ? 215 : 250;
      const grad = { stops: ['#ffffff', mix('#ffffff', p.accent, 0.55), p.accent], angle: 90 };
      lines.forEach((ln, i) => L.push(T({ name: 'Title ' + (i + 1), text: ln, font: 'Anton', size: n === 1 ? 380 : 300, upper: true, fill: i === n - 1 && n > 1 ? grad : '#ffffff', extrude: 5, extrudeColor: rgba(p.deep, 0.85), shadow: true, x: 540, y: top + i * step, maxW: 1010, line: 0.9 })));
      const main = D.sp.filter((s) => imgOf(s.img));
      if (main.length) {
        const P1 = person(main[0], 760, H - 150, H * 0.6, { glow: rgba(p.accent, 0.45) });
        if (P1) L.push(P1);
        L.push(T({ name: 'With', text: 'with', font: 'Yellowtail', size: 66, fill: p.accent, x: 300, y: H - 330, rot: -8 }));
        L.push(T({ name: 'Speaker', text: (main[0].name || '').replace(/^(\S+\.?)\s+/, '$1\n'), font: 'Anton', size: 54, upper: true, fill: '#ffffff', shadow: true, align: 'left', x: 300, y: H - 250, line: 0.95, maxW: 360 }));
      }
      L.push(SH({ name: 'Shade', shape: 'fade', fill: p.deep, x: 540, y: H - 90, w: W, h: 180, strength: 0.9 }));
      L.push(...infoRow(D, H - 95, [
        { name: 'Date', big: `${(f.day || '').slice(0, 3)}. ${f.dd || ''}`, small: `${f.month || ''} ${f.year || ''}`, accent: true, size: 50 },
        { name: 'Time', big: f.time, small: f.time2 ? 'and ' + f.time2 : 'prompt', size: 64 },
        { name: 'Venue', small: venueText(D).replace(/,\s*/g, ',\n'), pin: true, maxW: 330, smallSize: 17 },
      ]));
      return L;
    },

    /* ── LINE-UP: THE HARVEST / YADAH / OVERFLOW — everyone ministering, named, over a big title ── */
    lineup(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.55 })];
      L.push(...brand(D));
      L.push(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 18, fill: rgba('#ffffff', 0.85), letter: 0.8, x: 540, y: 150 }));
      const list = D.sp.filter((s) => imgOf(s.img)).slice(0, 8);
      L.push(SH({ name: 'Glow', shape: 'glow', fill: p.accent, x: 540, y: H * 0.42, w: 900, h: 900, opacity: list.length ? 0.55 : 0.3 }));
      const n = list.length;
      const back = n > 4 ? list.slice(0, Math.ceil(n / 2)) : [];
      const front = n > 4 ? list.slice(Math.ceil(n / 2)) : list;
      const place = (row, foot, h, spread) => row.forEach((sp, i) => {
        const cx = row.length === 1 ? 540 : 540 + (i - (row.length - 1) / 2) * Math.min(spread, 900 / (row.length - 0.4));
        const P1 = person(sp, cx, foot, h, { glow: rgba('#000000', 0.35) });
        if (!P1) return;
        L.push(P1);
        L.push(T({ name: 'Name', text: (sp.name || '').toUpperCase().replace(/^(\S+\.?)\s+/, '$1\n'), font: 'Montserrat', size: 17, fill: '#ffffff', shadow: true, line: 1.1, x: cx + (i < row.length / 2 ? -1 : 1) * P1.w * 0.36, y: foot - h * 0.42, maxW: 170 }));
      });
      if (back.length) place(back, H * 0.5, H * 0.3, 260);
      place(front, H * (back.length ? 0.66 : 0.64), H * (back.length ? 0.34 : n === 1 ? 0.5 : 0.42), n <= 2 ? 360 : 270);
      L.push(SH({ name: 'Shade', shape: 'fade', fill: p.deep, x: 540, y: H * 0.74, w: W, h: H * 0.3, strength: 0.95 }));
      L.push(SH({ name: 'Floor', shape: 'rect', fill: p.deep, x: 540, y: H * 0.94, w: W, h: H * 0.13 }));
      if (f.extra || f.kicker) L.push(T({ name: 'Kicker', text: f.extra || f.kicker, font: 'Montserrat', size: 24, upper: true, fill: p.accent, letter: 0.3, x: 540, y: H * 0.665 }));
      L.push(T({ name: 'Title', text: f.title || 'The Harvest', font: 'Cinzel', size: 150, upper: true, fill: 'gold', extrude: 4, extrudeColor: '#3b2208', shadow: true, x: 540, y: H * 0.735, maxW: 1000 }));
      if (f.theme) L.push(T({ name: 'Theme', text: f.theme, font: 'Montserrat', size: 26, upper: true, fill: '#ffffff', letter: 0.12, x: 540, y: H * 0.8, maxW: 900 }));
      L.push(T({ name: 'Date', text: `${f.day ? f.day.toUpperCase() + ', ' : ''}${f.dd || ''} OF ${f.month || ''}, ${f.year || ''}`, font: 'Montserrat', size: 26, fill: p.accent, x: 540, y: H * 0.845, maxW: 900 }));
      L.push(...infoRow(D, H * 0.925, [
        { name: 'Time', big: f.time + (f.time2 ? ' & ' + f.time2 : ''), size: 50 },
        { name: 'Venue', small: venueText(D).replace(/,\s*/g, ',\n'), pin: true, maxW: 420, smallSize: 18 },
      ]));
      return L;
    },

    /* ── PRESENTS: MIRACLE SERVICE / INVOCATION — the minister in the middle, the title across him ── */
    presents(D) {
      const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.5 })];
      if (D.logo && imgOf(D.logo)) L.push(...brand(D).filter((l) => l.name === 'Logo').map((l) => Object.assign(l, { x: 540, y: 80, h: 64, w: l.w * 64 / l.h })));
      if (f.church) L.push(T({ name: 'Church', text: f.church, font: 'Montserrat', size: 22, upper: true, fill: '#ffffff', letter: 0.12, x: 540, y: D.logo ? 140 : 90, maxW: 900 }));
      L.push(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 16, fill: rgba('#ffffff', 0.8), letter: 0.9, x: 540, y: D.logo ? 172 : 124 }));
      L.push(...people(D, { cx: 540, foot: H * 0.8, h: H * 0.66, gap: 420, max: 3, extra: { glow: rgba(p.accent, 0.4), fade: 0.12 } }));
      L.push(SH({ name: 'Shade', shape: 'fade', fill: p.deep, x: 540, y: H * 0.8, w: W, h: H * 0.42, strength: 0.96 }));
      L.push(SH({ name: 'Floor', shape: 'rect', fill: p.deep, x: 540, y: H * 0.955, w: W, h: H * 0.1 }));
      const words = twoLines(f.title || 'Miracle Service');
      const word2 = words[1] || '';
      L.push(T({ name: 'Title', text: words[0], font: 'Anton', size: 220, upper: true, fill: { stops: ['#ffffff', mix('#ffffff', p.accent, 0.5), p.accent], angle: 90 }, extrude: 5, extrudeColor: rgba('#000000', 0.6), shadow: true, x: 540, y: H * 0.71, maxW: 1000 }));
      if (word2) L.push(T({ name: 'Subtitle', text: word2.toUpperCase().split('').join(' '), font: 'Montserrat', size: 38, fill: '#ffffff', letter: 0.3, x: 540, y: H * 0.79, maxW: 900 }));
      if (f.theme) L.push(T({ name: 'Theme', text: '“' + f.theme + '”', font: 'Alex Brush', size: 66, fill: p.accent, x: 540, y: H * (word2 ? 0.84 : 0.8), maxW: 900 }));
      L.push(...infoRow(D, H * 0.915, [
        { name: 'Date', label: 'DATE', big: `${(f.day || '').slice(0, 3)}. ${f.dd || ''}`, small: `${f.month || ''}, ${f.year || ''}`, size: 44 },
        { name: 'Time', label: 'TIME', big: f.time, small: f.time2 ? 'and ' + f.time2 : 'prompt', size: 56, accent: true },
        { name: 'Venue', label: 'VENUE', small: venueText(D).replace(/,\s*/g, ',\n'), maxW: 330, smallSize: 17 },
      ], { labelInk: lum(p.accent) > 0.55 ? '#111111' : '#ffffff' }));
      L.push(T({ name: 'Footer', text: (f.footer || 'PRAYERS  |  WORSHIP  |  WORD').toUpperCase(), font: 'Montserrat', size: 16, fill: rgba('#ffffff', 0.75), letter: 0.5, x: 540, y: H - 32, maxW: 960 }));
      return L;
    },
  });
  /* ── SLAB: BIBLE STUDY / SPIRIT OF DAVID — a yellow slab-serif title, a red JOIN US tab, the pastor under a round badge ── */
  LAYOUTS.slab = function slab(D) {
    const H = D.h, p = D.pal, f = D.f, L = [BG({ img: D.bg, tint: 0.4, bright: -12 })];
    L.push(...brand(D));
    L.push(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 16, fill: rgba('#ffffff', 0.85), letter: 0.8, x: 540, y: 150 }));
    const words = twoLines(f.title || 'Bible Study');
    const fillY = { stops: ['#fff6a8', '#ffd21f', '#f0a500'], angle: 90 };
    L.push(T({ name: 'Title 1', text: words[0], font: 'Alfa Slab One', size: 190, fill: fillY, extrude: 5, extrudeColor: '#5a2a00', shadow: true, x: 580, y: 300, maxW: 820 }));
    if (words[1]) L.push(T({ name: 'Title 2', text: words[1], font: 'Alfa Slab One', size: 190, fill: fillY, extrude: 5, extrudeColor: '#5a2a00', shadow: true, x: 580, y: 500, maxW: 860 }));
    L.push(SH({ name: 'Join tab', shape: 'rect', fill: '#d71920', x: 110, y: words[1] ? 400 : 300, w: 64, h: 230, shadow: true }));
    L.push(T({ name: 'Join us', text: 'JOIN US', font: 'Anton', size: 40, fill: '#ffffff', rot: -90, x: 110, y: words[1] ? 400 : 300 }));
    L.push(...infoRow(D, words[1] ? 660 : 470, [
      { name: 'Date', big: `${(f.day || '').slice(0, 3)}. ${f.dd ? f.dd.replace(/\D+$/, '') : ''}\n${f.month || ''}`, size: 46 },
      { name: 'Time', big: [f.time, f.time2].filter(Boolean).join('\n'), size: 46, accent: true },
    ], { gap: 26 }));
    L.push(...people(D, { cx: 540, foot: H - 70, h: H * 0.5, gap: 330, max: 3, extra: { glow: rgba('#000000', 0.4) } }));
    const sp = D.sp[0];
    if (sp && sp.name) {
      L.push(SH({ name: 'Badge', shape: 'circle', fill: '#ffd21f', x: 830, y: H - 330, w: 230, h: 230, shadow: true }));
      L.push(T({ name: 'With', text: 'with', font: 'Great Vibes', size: 44, fill: '#111111', x: 830, y: H - 395 }));
      L.push(T({ name: 'Speaker', text: sp.name.toUpperCase().replace(/^(\S+\.?)\s+/, '$1\n'), font: 'Anton', size: 40, fill: '#d71920', line: 0.95, x: 830, y: H - 315, maxW: 190 }));
    }
    L.push(SH({ name: 'Footer', shape: 'rect', fill: rgba('#000000', 0.75), x: 540, y: H - 32, w: W, h: 64 }));
    L.push(T({ name: 'Venue', text: [venueText(D), f.phone].filter(Boolean).join('   •   '), font: 'Montserrat', size: 20, upper: true, fill: '#ffffff', x: 540, y: H - 32, maxW: 1000 }));
    return L;
  };
  const LOOK_NAMES = { slab: 'Slab title', giant: 'Giant title', lineup: 'Line-up', presents: 'Presents', script: 'Script', joinus: 'Join us', breakthrough: 'Breakthrough', torn: 'Torn paper', scenic: 'Scenic', themebox: 'Theme box' };

  /* split a title into two balanced lines */
  function twoLines(s) {
    const w = String(s || '').trim().split(/\s+/).filter(Boolean);
    if (w.length <= 1) return [w[0] || '', ''];
    let best = 1, diff = 1e9;
    for (let i = 1; i < w.length; i++) { const d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i).join(' ').length); if (d < diff) { diff = d; best = i; } }
    return [w.slice(0, best).join(' '), w.slice(best).join(' ')];
  }

  /** The event, the art direction and the pictures → everything a layout reads. */
  function dataFor(o) {
    const f = Object.assign({}, o.fields || {});
    const dp = dateParts(f.date);
    if (dp) Object.assign(f, { dd: dp.dd, month: dp.month, mon: dp.mon, year: dp.year, day: dp.dayName });
    f.time = niceTime(f.time);
    f.time2 = niceTime(f.time2);
    const dir = o.dir || {};
    const pal = o.pal || { deep: '#1a0638', mid: '#5b21b6', accent: '#f5c542', hi: '#ffffff' };
    const title = (f.title || 'Sunday Service').trim();
    const isWeekly = /service|meeting|study|fellowship|prayer/i.test(title) && title.split(/\s+/).length <= 3;
    const dayWord = (dp && dp.day) || 'SUNDAY';
    const D = {
      w: o.w || 1080, h: o.h || 1350, pal, dir, f,
      bg: o.bg, logo: o.logo,
      sp: (o.speakers || []).map((s) => ({ name: s.name, img: s.img, id: s.id, photo: s.photo })),
      script: dir.scriptWord || (dp ? dp.dayName : 'Sunday'),
      titleTop: isWeekly ? 'JOIN US' : (dir.kicker || 'JOIN US FOR').split(/\s+/).slice(0, 3).join(' '),
      titleBig: isWeekly && /sunday/i.test(title) ? dayWord : title,
      chip: isWeekly ? 'THIS' : (dp ? dp.day.slice(0, 3) : 'THIS'),
      whenWord: dp ? 'THIS ' + dp.day : 'THIS SUNDAY',
      titleWords: twoLines(f.theme && o.look === 'scenic' ? f.theme : title),
      themeWords: (() => { const t = twoLines(f.theme || title); const w2 = t[1].split(/\s+/); return w2.length > 2 ? [t[0], w2.slice(1).join(' '), w2[0]] : t; })(),
    };
    return D;
  }

  /** A whole flyer: { w, h, pal, look, layers } */
  function buildScene(o) {
    const D = dataFor(o);
    const look = LAYOUTS[o.look] ? o.look : 'script';
    let layers = LAYOUTS[look](D).filter(Boolean);
    if (D.h !== 1350) layers = layers;   // layouts are written against the height they are given
    return { w: D.w, h: D.h, pal: D.pal, look, layers };
  }

  root.MWFlyer = { HD, render, buildScene, loadFonts, IMGS, loadImg, proceduralBg, LAYOUTS, LOOK_NAMES, FONTS, textCanvas, boxOf, Dates };

  /* ================================================================== THE UI */

  const C = root.MWCloud;
  if (!C) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => C.esc(s);
  const escAttr = (s) => C.escAttr(s);
  const toast = (m, k, ms) => C.toast(m, k, ms);

  const ICON = {
    back: '<path d="m15 18-6-6 6-6"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
    save: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
    send: '<path d="M21.5 2.5 10.6 13.4"/><path d="m21.5 2.5-7 19-3.9-8.1-8.1-3.9z"/>',
    text: '<path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
    photo: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
    bg: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 15l5-5 4 4 3-3 6 6"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 21 9.8C21 6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    words: '<path d="M4 7h16"/><path d="M4 12h10"/><path d="M4 17h13"/>',
    font: '<path d="m4 20 6-16h1l6 16"/><path d="M6.5 14h9"/>',
    fx: '<path d="m12 3 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 8.3l5-.7z"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 13h12l1-13"/><path d="M9 7V4h6v3"/>',
    up: '<path d="m12 5-7 7"/><path d="m12 5 7 7"/><path d="M12 5v14"/>',
    down: '<path d="m12 19-7-7"/><path d="m12 19 7-7"/><path d="M12 19V5"/>',
    cut: '<path d="m15 4 5 5L8 21l-5-5z"/><path d="M13 6l5 5"/><path d="M5 2.5v3M3.5 4h3"/><path d="M19.5 15.5v3M18 17h3"/>',
    flip: '<path d="M12 3v18"/><path d="M8 7 3 12l5 5z"/><path d="M16 7l5 5-5 5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    church: '<path d="M12 2v5M9.5 4.5h5"/><path d="M5 21V11l7-4 7 4v10"/><path d="M10 21v-5h4v5"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    size: '<rect x="6" y="2" width="12" height="20" rx="2"/>',
    gray: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
    glow: '<circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="9" stroke-dasharray="2 3"/>',
  };
  const ic = (n) => `<svg class="fs-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;

  /* the colour sets offered for a flyer — the AI's own comes first */
  const PALETTES = [
    { name: 'Royal purple', deep: '#14052e', mid: '#5b21b6', accent: '#f5c542', hi: '#ffffff' },
    { name: 'Magenta', deep: '#2a0738', mid: '#a21caf', accent: '#facc15', hi: '#ffe4f9' },
    { name: 'Royal blue', deep: '#030b2b', mid: '#1d4ed8', accent: '#38e1ff', hi: '#ffffff' },
    { name: 'Crimson gold', deep: '#1c0205', mid: '#a4172a', accent: '#ffd166', hi: '#ffffff' },
    { name: 'Teal', deep: '#012a30', mid: '#0e7c86', accent: '#a3ff47', hi: '#ffffff' },
    { name: 'Fire', deep: '#160301', mid: '#c2410c', accent: '#ffb300', hi: '#fff3c4' },
    { name: 'Emerald', deep: '#02291a', mid: '#0a7a3c', accent: '#c9f731', hi: '#ffffff' },
    { name: 'Black gold', deep: '#0b0805', mid: '#453113', accent: '#f2c94c', hi: '#fff4cf' },
    { name: 'Sky', deep: '#0c2c52', mid: '#2f80d1', accent: '#ffd54a', hi: '#ffffff' },
    { name: 'Sunset', deep: '#2c0c46', mid: '#e4653a', accent: '#ffd166', hi: '#ffe9c7' },
    { name: 'Golden glow', deep: '#2a1300', mid: '#b8650a', accent: '#ffd36b', hi: '#fff8e1' },
    { name: 'Revival red', deep: '#2a0303', mid: '#b91c1c', accent: '#ffd166', hi: '#ffffff' },
    { name: 'Prophetic teal', deep: '#032b2b', mid: '#0f6b6b', accent: '#f2c94c', hi: '#ffffff' },
    { name: 'Orange fire', deep: '#3a0a00', mid: '#ea580c', accent: '#fde047', hi: '#ffffff' },
  ];
  const SIZES = [
    { id: 'post', name: 'Post 4:5', w: 1080, h: 1350 },
    { id: 'story', name: 'Story 9:16', w: 1080, h: 1920 },
    { id: 'square', name: 'Square', w: 1080, h: 1080 },
  ];
  const SWATCHES = ['#ffffff', '#111111', '#f5c542', '#facc15', '#ffb300', '#ff5a00', '#e11d2a', '#c81e1e', '#ff2fd6', '#a21caf', '#7c3aed', '#5b21b6', '#1d4ed8', '#38bdf8', '#19e0ff', '#0e7c86', '#22c55e', '#a3ff47', '#c9f731', '#8a6d27'];
  const FILLS = [['Plain', null], ['Gold', 'gold'], ['Rust', 'rust'], ['Silver', 'silver'], ['Fire', 'fire'], ['Ice', 'ice']];

  const F = {
    panel: null, kit: null, status: null,
    step: 'make',          // make → pick → edit
    occasion: null,
    fields: { title: '', theme: '', date: '', time: '', time2: '', venue: '', church: '', phone: '', handles: '', extra: '', notes: '', kind: '' },
    speakers: [],          // ids from the kit, in order
    pinned: {},            // speaker id -> the photo chosen from their bank (else the AI picks)
    size: 'post',
    dir: null, pal: null,
    bgs: [],               // { key, by } — painted pictures, best first
    designs: [],           // scenes offered
    scene: null, sel: null, undo: [], redo: [],
    painting: 0, tries: 0,
  };
  const sizeOf = () => SIZES.find((s) => s.id === F.size) || SIZES[0];

  /* -------------------------------------------------------------- the kit */

  async function loadKit() {
    try { F.kit = await window.api.flyer.kitGet(); } catch (e) { F.kit = null; }
    if (!F.kit) F.kit = { church: '', address: '', phone: '', handles: '', speakers: [], services: [] };
    for (const s of F.kit.speakers || []) if (!Array.isArray(s.photos)) s.photos = [];
    if (F.kit.logoUrl) { try { IMGS.set('logo', await loadImg(F.kit.logoUrl)); } catch (e) {} }
    return F.kit;
  }

  /*
   * THE PICTURE BANKS. Each speaker has a set of photos, already cut out.
   * They come from the server one at a time, when something draws them, and
   * stay on this phone. A photo not yet saved is its data URL until it is.
   */
  const PICURL = new Map();   // file name or data URL -> data URL
  const PICLOAD = new Map();  // -> Promise<image>
  const dataKeys = new Map(); let dataN = 0;
  const picKey = (p) => { if (!/^data:/.test(p)) return 'kp:' + p; if (!dataKeys.has(p)) dataKeys.set(p, 'kd:' + (++dataN)); return dataKeys.get(p); };
  function bankPic(p) {
    if (!p) return Promise.resolve(null);
    if (!PICLOAD.has(p)) {
      PICLOAD.set(p, (async () => {
        const url = /^data:/.test(p) ? p : await window.api.flyer.kitPic(p);
        PICURL.set(p, url);
        const im = await loadImg(url);
        IMGS.set(picKey(p), im);
        return im;
      })().catch(() => { PICLOAD.delete(p); return null; }));
    }
    return PICLOAD.get(p);
  }
  /* fill the <img data-pic> thumbnails as their pictures arrive */
  function fillPics(root) {
    $$('img[data-pic]', root).forEach((img) => {
      const p = img.dataset.pic;
      if (PICURL.has(p)) { img.src = PICURL.get(p); return; }
      bankPic(p).then(() => { if (PICURL.has(p)) img.src = PICURL.get(p); });
    });
  }
  const picTag = (p) => (p ? `<img data-pic="${escAttr(p)}" alt="">` : '');

  /*
   * WHICH PHOTO. One the operator chose for this flyer; otherwise the AI's
   * pick goes round the bank — the one after the last flyer's — and each
   * design on offer wears a different one, so the choice is there to see.
   */
  function photoFor(s, i) {
    const ph = s.photos || [];
    if (!ph.length) return '';
    if (F.pinned[s.id] && ph.includes(F.pinned[s.id])) return F.pinned[s.id];
    const start = (ph.indexOf(s.last) + 1) % ph.length;
    return ph[(start + (i || 0)) % ph.length];
  }
  function speakersFor(i) {
    return chosenSpeakers().map((s) => { const photo = photoFor(s, i); return { id: s.id, name: s.name, photo, img: photo ? picKey(photo) : '' }; });
  }
  async function saveKit(quiet) {
    try {
      F.kit = await window.api.flyer.kitSave(F.kit);
      for (const s of F.kit.speakers || []) if (!Array.isArray(s.photos)) s.photos = [];
      if (!quiet) toast('Saved — every flyer starts with these now.', 'good');
    } catch (e) { toast('Could not save: ' + (e.message || e), 'error'); }
  }

  /* -------------------------------------------------------- the entry door */

  async function open() {
    F.panel = C.openPanel({ id: 'cloudFlyer', title: 'Flyers', cls: 'cp-flyer', full: true, onClose: () => { F.panel = null; } });
    F.panel.body.innerHTML = '<div class="fs-loading">Opening the flyer studio…</div>';
    loadFonts();
    const [st] = await Promise.all([window.api.flyer.status().catch(() => null), loadKit()]);
    F.status = st;
    F.step = 'make';
    if (!F.occasion) pickOccasion((upcoming(F.kit)[0]) || null);
    draw();
  }

  function pickOccasion(o) {
    F.occasion = o;
    const k = F.kit || {};
    const f = F.fields;
    f.church = k.church || ''; f.phone = k.phone || ''; f.handles = k.handles || '';
    if (!o) return;
    f.title = o.name || '';
    f.theme = o.theme || '';
    f.kind = o.kind || '';
    f.time = (o.service && o.service.time) || o.time || f.time || '';
    f.venue = (o.service && o.service.venue) || k.address || '';
    const dp = dateParts(o.date); f.date = dp ? dp.iso : '';
    F.speakers = []; F.pinned = {};
    const sv = o.service && o.service.speaker;
    if (sv && (k.speakers || []).some((s) => s.id === sv)) F.speakers = [sv];
    else if ((k.speakers || []).length) F.speakers = [k.speakers[0].id];
  }

  function draw() {
    if (!F.panel) return;
    if (F.step === 'make') return drawMake();
    if (F.step === 'pick') return drawPick();
    return drawEdit();
  }

  /* ------------------------------------------------------ step 1: what for */

  function drawMake() {
    const P = F.panel, k = F.kit || {};
    P.setTitle('Flyers');
    P.el.classList.remove('fs-editing');
    const occ = upcoming(k);
    const f = F.fields;
    const chips = occ.map((o) => {
      const d = dateParts(o.date);
      const on = F.occasion && F.occasion.id === o.id;
      return `<button type="button" class="fs-occ${on ? ' on' : ''}${o.seasonal ? ' season' : ''}" data-occ="${escAttr(o.id)}"><b>${esc(o.name)}</b><small>${esc(d ? d.dayName.slice(0, 3) + ' ' + d.dd.toLowerCase() + ' ' + d.month.slice(0, 3).toLowerCase() : '')}${o.time || (o.service && o.service.time) ? ' · ' + esc(niceTime(o.time || o.service.time)) : ''}</small></button>`;
    }).join('') + `<button type="button" class="fs-occ${F.occasion && F.occasion.id === 'other' ? ' on' : ''}" data-occ="other"><b>Something else</b><small>a conference, a crusade…</small></button>`;
    const sp = (k.speakers || []).map((s) => {
      const on = F.speakers.includes(s.id);
      const ph = photoFor(s, 0);
      return `<button type="button" class="fs-sp${on ? ' on' : ''}" data-sp="${escAttr(s.id)}"><span class="fs-sp-pic">${ph ? picTag(ph) : esc((s.name || '?').replace(/^(pst|pastor|rev|dr|bishop|apostle|evang)\.?\s+/i, '').charAt(0))}</span><small>${esc(s.name || 'Speaker')}</small>`
        + (on && (s.photos || []).length ? `<em class="fs-sp-bank">${F.pinned[s.id] ? 'your pick' : 'AI picks'} · ${s.photos.length}</em>` : '') + '</button>';
    }).join('') + '<button type="button" class="fs-sp fs-sp-add" data-act="addsp"><span class="fs-sp-pic">' + ic('plus') + '</span><small>Add</small></button>';
    const painter = F.status && F.status.cloudflare ? 'FLUX.2' : 'FLUX';
    P.body.innerHTML = `
      <div class="fs-make">
        <section class="fs-sec">
          <h3>What is it for?</h3>
          <div class="fs-occs">${chips}</div>
        </section>
        <section class="fs-sec">
          <h3>Who is preaching? <small>tap to put them on · tap again for their pictures</small></h3>
          <div class="fs-sps">${sp}</div>
        </section>
        <section class="fs-sec fs-form">
          <label class="fs-f fs-wide"><span>Title</span><input data-f="title" value="${escAttr(f.title)}" placeholder="Sunday Service"></label>
          <label class="fs-f fs-wide"><span>Theme <i>(optional)</i></span><input data-f="theme" value="${escAttr(f.theme)}" placeholder="e.g. Loose Him and Let Him Go"></label>
          <label class="fs-f"><span>Date</span><input type="date" data-f="date" value="${escAttr(f.date)}"></label>
          <label class="fs-f"><span>Time</span><input data-f="time" value="${escAttr(f.time)}" placeholder="9:00AM"></label>
          <label class="fs-f fs-wide"><span>Where</span><input data-f="venue" value="${escAttr(f.venue)}" placeholder="12 Airport Road, Benin City"></label>
          <details class="fs-more"${f.extra || f.time2 || f.notes ? ' open' : ''}><summary>More</summary>
            <label class="fs-f"><span>Second service</span><input data-f="time2" value="${escAttr(f.time2)}" placeholder="11:00AM"></label>
            <label class="fs-f"><span>Extra line</span><input data-f="extra" value="${escAttr(f.extra)}" placeholder="10th Edition"></label>
            <label class="fs-f fs-wide"><span>Phone / email</span><input data-f="phone" value="${escAttr(f.phone)}"></label>
            <label class="fs-f fs-wide"><span>Social handles</span><input data-f="handles" value="${escAttr(f.handles)}" placeholder="@yourchurch"></label>
            <label class="fs-f fs-wide"><span>Tell the AI the mood <i>(optional)</i></span><textarea data-f="notes" rows="2" placeholder="fire, revival, purple and gold, mountains…">${esc(f.notes)}</textarea></label>
          </details>
        </section>
        <section class="fs-sec">
          <h3>Size</h3>
          <div class="fs-seg">${SIZES.map((s) => `<button type="button" data-size="${s.id}" class="${F.size === s.id ? 'on' : ''}">${esc(s.name)}</button>`).join('')}</div>
        </section>
        <button type="button" class="fs-kit-link" data-act="kit">${ic('church')}<span><b>My church</b><small>${esc(k.church ? k.church : 'Name, logo, address, speakers and service days — set once')}</small></span>${ic('back').replace('fs-ic', 'fs-ic fs-chev')}</button>
        <p class="fs-note">${F.status && !F.status.cloudflare ? 'Pictures are painted free by FLUX. For faster, sharper ones (FLUX.2, about 70 a day, free), add a free Cloudflare account to the server — see CLOUD.md.' : `Pictures are painted free by ${painter}. Your words are set exactly as you type them.`}</p>
      </div>`;
    P.foot.innerHTML = `<button type="button" class="fs-go" data-act="make">${ic('spark')}<span>Make my flyers</span></button>`;
    fillPics(P.body);
    wireMake();
  }

  function wireMake() {
    const P = F.panel;
    $$('[data-f]', P.body).forEach((el) => el.addEventListener('input', () => { F.fields[el.dataset.f] = el.value; }));
    P.body.onclick = (e) => {
      const b = e.target.closest('[data-occ],[data-sp],[data-size],[data-act]'); if (!b) return;
      if (b.dataset.occ) {
        if (b.dataset.occ === 'other') { F.occasion = { id: 'other' }; Object.assign(F.fields, { title: '', theme: '', kind: '' }); }
        else pickOccasion(upcoming(F.kit).find((o) => o.id === b.dataset.occ));
        return drawMake();
      }
      if (b.dataset.sp) {
        const id = b.dataset.sp;
        if (F.speakers.includes(id)) return openBank(id);
        F.speakers = F.speakers.concat(id).slice(-8); return drawMake();
      }
      if (b.dataset.size) { F.size = b.dataset.size; return drawMake(); }
      if (b.dataset.act === 'kit') return openKit();
      if (b.dataset.act === 'addsp') return addSpeaker(true);
    };
    P.foot.onclick = (e) => { if (e.target.closest('[data-act="make"]')) makeFlyers(); };
  }

  /* ------------------------------------------------------ step 2: make + pick */

  async function makeFlyers() {
    if (!F.fields.title.trim()) { toast('Give it a title first.', 'error'); return; }
    F.step = 'pick'; F.bgs = []; F.designs = []; F.dir = null; F.tries++;
    const tryNo = F.tries;
    drawPick();
    await loadFonts();
    const dp = dateParts(F.fields.date);
    await Promise.all(Object.keys(LAYOUTS).map((l, i) => speakersFor(i)).flat().map((s) => bankPic(s.photo)));
    const fields = Object.assign({}, F.fields, { dateText: dp ? dp.long : '', dayName: dp ? dp.dayName : '', season: F.occasion && F.occasion.seasonal ? F.occasion.name : '', speakers: chosenSpeakers().map((s) => ({ name: s.name })) });
    let dir = null;
    try { dir = await window.api.flyer.direct(fields); } catch (e) { dir = null; }
    if (tryNo !== F.tries) return;
    F.dir = dir || { scenes: ['heavenly golden light rays through purple clouds'], palette: ['#1a0638', '#5b21b6', '#f5c542', '#ffffff'], scriptWord: dp ? dp.dayName : 'Sunday', kicker: 'WORSHIP WITH US THIS', looks: Object.keys(LAYOUTS) };
    const pp = F.dir.palette || [];
    F.pal = { deep: pp[0] || '#14052e', mid: pp[1] || '#5b21b6', accent: pp[2] || '#f5c542', hi: pp[3] || '#ffffff' };
    // the app's own photographs first (on screen at once); the AI's join them as they are painted
    const sz = sizeOf();
    const stock = await Promise.all((F.dir.photos || []).slice(0, 3).map(async (n) => {
      try { const key = 'stock:' + n; if (!IMGS.has(key)) IMGS.set(key, await loadImg('/flyerphotos/' + encodeURIComponent(n))); return { key, by: 'photo', proc: true }; } catch (e) { return null; }
    }));
    if (tryNo !== F.tries) return;
    F.bgs = stock.filter(Boolean);
    if (!F.bgs.length) { IMGS.set('proc:' + tryNo, proceduralBg(sz.w, sz.h, F.pal, tryNo * 13 + 5)); F.bgs = [{ key: 'proc:' + tryNo, by: 'painted here', proc: true }]; }
    rebuildDesigns();
    // then the AI's — three at once, each swapped in as it lands
    const scenes = (F.dir.scenes || []).slice(0, 3);
    F.painting = scenes.length;
    drawPick();
    let failed = '';
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        const out = await window.api.flyer.paint({ scene, w: sz.w, h: sz.h, seed: Math.floor(Math.random() * 1e9), people: chosenSpeakers().some((s) => (s.photos || []).length) });
        if (tryNo !== F.tries) return;
        const im = await loadImg(out.dataUrl);
        const key = 'ai:' + tryNo + ':' + i;
        IMGS.set(key, im);
        // AI pictures lead; the photos stay on for variety until three AI ones are in
        const ai = F.bgs.filter((b) => !b.proc).concat({ key, by: out.by, scene });
        F.bgs = ai.concat(F.bgs.filter((b) => b.proc)).slice(0, Math.max(3, ai.length));
        rebuildDesigns();
      } catch (e) { failed = e.message || String(e); }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
    if (tryNo === F.tries && F.bgs.every((b) => b.proc) && failed) toast('The AI could not paint just now (' + failed.slice(0, 120) + '). These use the studio’s own photographs — tap “New pictures” to try again.', 'error', 9000);
  }

  function chosenSpeakers() {
    const all = (F.kit && F.kit.speakers) || [];
    return F.speakers.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  }

  function rebuildDesigns() {
    const sz = sizeOf();
    const looks = (F.dir && F.dir.looks && F.dir.looks.length ? F.dir.looks : Object.keys(LAYOUTS)).filter((l) => LAYOUTS[l]);
    const all = Array.from(new Set(looks.concat(Object.keys(LAYOUTS))));
    F.designs = all.map((look, i) => {
      const bg = F.bgs[i % F.bgs.length];
      return buildScene({ look, w: sz.w, h: sz.h, pal: F.pal, dir: F.dir, fields: F.fields, speakers: speakersFor(i), logo: IMGS.has('logo') ? 'logo' : null, bg: bg && bg.key });
    });
    if (F.step === 'pick') paintThumbs();
  }

  function drawPick() {
    const P = F.panel; if (!P) return;
    P.setTitle('Pick one');
    P.el.classList.remove('fs-editing');
    const busy = !F.designs.length;
    P.body.innerHTML = `<div class="fs-pick">
      <p class="fs-status">${busy ? 'The AI is reading your event…' : F.painting > 0 ? `<i class="fs-spin"></i> Painting ${F.painting} picture${F.painting > 1 ? 's' : ''} with AI — they appear as they’re ready` : 'Tap one to edit every part of it'}</p>
      <div class="fs-grid">${busy ? '<div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div>' : F.designs.map((d, i) => `<button type="button" class="fs-card" data-i="${i}"><canvas></canvas><small>${esc(LOOK_NAMES[d.look] || d.look)}</small></button>`).join('')}</div>
    </div>`;
    P.foot.innerHTML = `<button type="button" class="fs-ghost" data-act="back">${ic('back')}<span>Details</span></button><button type="button" class="fs-ghost" data-act="again">${ic('refresh')}<span>New pictures</span></button>`;
    paintThumbs();
    P.body.onclick = (e) => { const c = e.target.closest('.fs-card'); if (c) openEditor(F.designs[+c.dataset.i]); };
    P.foot.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'back') { F.step = 'make'; F.tries++; drawMake(); }
      if (b.dataset.act === 'again') makeFlyers();
    };
  }
  function paintThumbs() {
    if (!F.panel) return;
    $$('.fs-card', F.panel.body).forEach((c) => {
      const S = F.designs[+c.dataset.i]; if (!S) return;
      const big = render(S, canvas(1, 1), 0.5);
      const cv = c.querySelector('canvas');
      cv.width = 360; cv.height = Math.round(360 * S.h / S.w);
      const x = cv.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(big, 0, 0, cv.width, cv.height);
    });
  }

  /* ============================================================ THE EDITOR */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  function snapshot() { F.undo.push(clone(F.scene)); if (F.undo.length > 60) F.undo.shift(); F.redo = []; syncUndo(); }
  function syncUndo() {
    if (!F.panel) return;
    const u = $('[data-ed="undo"]', F.panel.el), r = $('[data-ed="redo"]', F.panel.el);
    if (u) u.disabled = !F.undo.length; if (r) r.disabled = !F.redo.length;
  }
  const layerById = (id) => F.scene && F.scene.layers.find((l) => l.id === id);

  function openEditor(scene) {
    F.scene = clone(scene); F.sel = null; F.undo = []; F.redo = [];
    F.step = 'edit';
    drawEdit();
  }

  function drawEdit() {
    const P = F.panel; if (!P) return;
    P.setTitle('');
    P.el.classList.add('fs-editing');
    P.body.innerHTML = `<div class="fs-ed">
      <div class="fs-topbar">
        <button type="button" class="fs-tb" data-ed="back" aria-label="Back">${ic('back')}</button>
        <span class="fs-tb-sp"></span>
        <button type="button" class="fs-tb" data-ed="undo" aria-label="Undo" disabled>${ic('undo')}</button>
        <button type="button" class="fs-tb" data-ed="redo" aria-label="Redo" disabled>${ic('redo')}</button>
        <button type="button" class="fs-tb fs-save" data-ed="save">${ic('save')}<span>Save</span></button>
        <button type="button" class="fs-tb fs-post" data-ed="post">${ic('send')}<span>Post</span></button>
      </div>
      <div class="fs-stage" id="fsStage"><canvas id="fsCanvas"></canvas><div class="fs-selbox hidden" id="fsSel"><i class="fs-h fs-h-rot"></i><i class="fs-h fs-h-br"></i></div></div>
      <div class="fs-tools" id="fsTools"></div>
      <div class="fs-sheet hidden" id="fsSheet"></div>
    </div>`;
    P.foot.innerHTML = '';
    paint();
    tools();
    wireStage();
    syncUndo();
    $('.fs-topbar', P.body).onclick = (e) => {
      const b = e.target.closest('[data-ed]'); if (!b || b.disabled) return;
      const a = b.dataset.ed;
      if (a === 'back') { F.step = 'pick'; F.sel = null; return drawPick(); }
      if (a === 'undo' && F.undo.length) { F.redo.push(clone(F.scene)); F.scene = F.undo.pop(); fixSel(); paint(); tools(); syncUndo(); }
      if (a === 'redo' && F.redo.length) { F.undo.push(clone(F.scene)); F.scene = F.redo.pop(); fixSel(); paint(); tools(); syncUndo(); }
      if (a === 'save') saveFlyer(b);
      if (a === 'post') postFlyer(b);
    };
  }
  function fixSel() { if (F.sel && !layerById(F.sel)) F.sel = null; }

  /* the stage: the flyer scaled to fit, with the selection box over it */
  function stageScale() {
    const st = $('#fsStage'); if (!st || !F.scene) return 1;
    const r = st.getBoundingClientRect();
    return Math.min((r.width - 16) / F.scene.w, (r.height - 16) / F.scene.h);
  }
  let paintQueued = false;
  function paint() {
    if (paintQueued) return;
    paintQueued = true;
    requestAnimationFrame(() => {
      paintQueued = false;
      const cv = $('#fsCanvas'); if (!cv || !F.scene) return;
      render(F.scene, cv);
      const k = stageScale();
      cv.style.width = Math.round(F.scene.w * k) + 'px'; cv.style.height = Math.round(F.scene.h * k) + 'px';
      selBox();
    });
  }
  function selBox() {
    const box = $('#fsSel'), cv = $('#fsCanvas'); if (!box || !cv) return;
    const L = F.sel && layerById(F.sel);
    if (!L || L.type === 'bg') { box.classList.add('hidden'); return; }
    const k = stageScale(), b = boxOf(L), s = L.s || 1;
    const cr = cv.getBoundingClientRect(), sr = $('#fsStage').getBoundingClientRect();
    box.classList.remove('hidden');
    box.style.width = b.w * s * k + 'px'; box.style.height = b.h * s * k + 'px';
    box.style.left = (cr.left - sr.left + L.x * k - b.w * s * k / 2) + 'px';
    box.style.top = (cr.top - sr.top + L.y * k - b.h * s * k / 2) + 'px';
    box.style.transform = `rotate(${L.rot || 0}deg)`;
  }

  /* which layer is under a point (top first), the background when nothing is */
  function hit(px, py) {
    const ls = F.scene.layers;
    for (let i = ls.length - 1; i >= 0; i--) {
      const L = ls[i];
      if (L.type === 'bg' || L.hidden || L.lock) continue;
      const b = boxOf(L), s = L.s || 1, a = -((L.rot || 0) * Math.PI) / 180;
      const dx = px - L.x, dy = py - L.y;
      const rx = dx * Math.cos(a) - dy * Math.sin(a), ry = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(rx) <= (b.w * s) / 2 + 12 && Math.abs(ry) <= (b.h * s) / 2 + 12) {
        // a person's empty corners do not count: only where there is picture
        if (L.type === 'image' && L.w * L.h > 160000) {
          const im = imgOf(L.img);
          if (im) {
            try {
              const t = canvas(1, 1), tx = t.getContext('2d');
              const u = (rx / s + L.w / 2) / L.w, v = (ry / s + L.h / 2) / L.h;
              tx.drawImage(im, (L.flip ? 1 - u : u) * iw(im), v * ih(im), 1, 1, 0, 0, 1, 1);
              if (tx.getImageData(0, 0, 1, 1).data[3] < 30) continue;
            } catch (e) { /* tainted: count it */ }
          }
        }
        return L;
      }
    }
    return ls.find((l) => l.type === 'bg') || null;
  }

  function wireStage() {
    const st = $('#fsStage'), cv = $('#fsCanvas');
    const toScene = (cx, cy) => { const r = cv.getBoundingClientRect(); const k = r.width / F.scene.w; return [(cx - r.left) / k, (cy - r.top) / k]; };
    let g = null;   // the gesture in progress
    const pts = new Map();
    st.addEventListener('pointerdown', (e) => {
      if (!F.scene) return;
      st.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const [sx, sy] = toScene(e.clientX, e.clientY);
      const handle = e.target.closest('.fs-h');
      if (pts.size === 2 && g && g.L && g.L.type !== 'bg') {
        const [a, b] = Array.from(pts.values());
        g = { mode: 'pinch', L: g.L, d0: Math.hypot(a[0] - b[0], a[1] - b[1]), a0: Math.atan2(b[1] - a[1], b[0] - a[0]), s0: g.L.s || 1, r0: g.L.rot || 0, snap: g.snap };
        return;
      }
      if (handle) {
        const L = layerById(F.sel); if (!L) return;
        g = { mode: handle.classList.contains('fs-h-rot') ? 'rotate' : 'scale', L, s0: L.s || 1, r0: L.rot || 0, d0: Math.hypot(sx - L.x, sy - L.y), a0: Math.atan2(sy - L.y, sx - L.x), snap: clone(F.scene) };
        return;
      }
      const L = hit(sx, sy);
      const was = F.sel;
      F.sel = L ? L.id : null;
      g = { mode: 'move', L, x0: sx, y0: sy, lx: L ? L.x : 0, ly: L ? L.y : 0, moved: false, snap: clone(F.scene), was };
      paint(); if (was !== F.sel) tools();
    });
    st.addEventListener('pointermove', (e) => {
      if (!g || !pts.has(e.pointerId)) return;
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const L = g.L; if (!L || L.type === 'bg') return;
      if (g.mode === 'pinch' && pts.size >= 2) {
        const [a, b] = Array.from(pts.values());
        L.s = clamp(g.s0 * Math.hypot(a[0] - b[0], a[1] - b[1]) / g.d0, 0.1, 8);
        L.rot = snapAngle(g.r0 + ((Math.atan2(b[1] - a[1], b[0] - a[0]) - g.a0) * 180) / Math.PI);
        g.moved = true; paint(); return;
      }
      const [sx, sy] = toScene(e.clientX, e.clientY);
      if (g.mode === 'move') {
        if (!g.moved && Math.hypot(sx - g.x0, sy - g.y0) < 6) return;
        g.moved = true;
        let nx = g.lx + sx - g.x0, ny = g.ly + sy - g.y0;
        // snap to the middle, the way Canva's guides do
        if (Math.abs(nx - F.scene.w / 2) < 14) nx = F.scene.w / 2;
        L.x = nx; L.y = ny; paint();
      } else if (g.mode === 'scale') {
        L.s = clamp(g.s0 * Math.hypot(sx - L.x, sy - L.y) / Math.max(1, g.d0), 0.1, 8); g.moved = true; paint();
      } else if (g.mode === 'rotate') {
        L.rot = snapAngle(g.r0 + ((Math.atan2(sy - L.y, sx - L.x) - g.a0) * 180) / Math.PI); g.moved = true; paint();
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (!g) return;
      if (g.moved && g.snap) { F.undo.push(g.snap); if (F.undo.length > 60) F.undo.shift(); F.redo = []; syncUndo(); }
      // a second tap on a selected text: edit its words
      else if (!g.moved && g.L && g.L.type === 'text' && g.was === g.L.id && g.mode === 'move') editText();
      if (pts.size === 0) g = null;
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (F.step === 'edit') paint(); });
  }
  const snapAngle = (a) => { let r = ((a % 360) + 540) % 360 - 180; for (const s of [-90, 0, 90, 180, -180]) if (Math.abs(r - s) < 4) r = s; return r; };

  /* -------------------------------------------------------------- the tools */

  function tools() {
    const el = $('#fsTools'); if (!el) return;
    closeSheet();
    const L = F.sel && layerById(F.sel);
    const btn = (act, icon, label) => `<button type="button" class="fs-tool" data-t="${act}">${ic(icon)}<span>${label}</span></button>`;
    let html;
    if (!L || L.type === 'bg') {
      html = btn('addtext', 'text', 'Text') + btn('addphoto', 'photo', 'Photo') + btn('bgnew', 'spark', 'New picture') + btn('bgphone', 'bg', 'Background')
        + btn('bgadjust', 'sun', 'Adjust') + btn('colours', 'palette', 'Colours') + btn('looks', 'layout', 'Layouts') + btn('words', 'words', 'Details') + btn('size', 'size', 'Size');
    } else if (L.type === 'text') {
      html = btn('edit', 'words', 'Edit') + btn('font', 'font', 'Font') + btn('colour', 'palette', 'Colour') + btn('effects', 'fx', 'Effects')
        + btn('spacing', 'layout', 'Spacing') + btn('opacity', 'sun', 'Opacity') + btn('dup', 'copy', 'Duplicate') + btn('front', 'up', 'Forward') + btn('back', 'down', 'Back') + btn('del', 'trash', 'Delete');
    } else if (L.type === 'image') {
      html = (L.speaker ? btn('bank', 'photo', 'Their photos') : '') + btn('cutout', 'cut', 'Remove BG') + btn('replace', 'photo', 'Replace') + btn('imglook', 'sun', 'Adjust') + btn('glow', 'glow', 'Glow') + btn('outline', 'fx', 'Outline')
        + btn('gray', 'gray', 'B&W') + btn('fade', 'down', 'Fade') + btn('flip', 'flip', 'Flip') + btn('opacity', 'sun', 'Opacity') + btn('dup', 'copy', 'Duplicate') + btn('front', 'up', 'Forward') + btn('back', 'down', 'Back') + btn('del', 'trash', 'Delete');
    } else {
      html = btn('colour', 'palette', 'Colour') + btn('opacity', 'sun', 'Opacity') + btn('dup', 'copy', 'Duplicate') + btn('front', 'up', 'Forward') + btn('back', 'down', 'Back') + btn('del', 'trash', 'Delete');
    }
    el.innerHTML = `<div class="fs-tools-row">${html}</div>`;
    el.onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) tool(b.dataset.t); };
  }

  function change(fn) { snapshot(); fn(); paint(); }

  function tool(t) {
    const L = F.sel && layerById(F.sel);
    const ls = F.scene.layers;
    switch (t) {
      case 'addtext': {
        const N = { id: uid(), type: 'text', name: 'Text', text: 'Your text', font: 'Anton', size: 110, fill: '#ffffff', shadow: true, align: 'center', line: 1, x: F.scene.w / 2, y: F.scene.h / 2, rot: 0, s: 1 };
        change(() => { ls.push(N); F.sel = N.id; }); tools(); return editText();
      }
      case 'addphoto': return pickImage(async (url) => {
        const im = await loadImg(url); const key = 'user:' + uid(); IMGS.set(key, im);
        const h = Math.min(F.scene.h * 0.5, ih(im)), w = h * iw(im) / ih(im);
        const N = { id: uid(), type: 'image', name: 'Photo', img: key, x: F.scene.w / 2, y: F.scene.h / 2, w, h, rot: 0, s: 1 };
        change(() => { ls.push(N); F.sel = N.id; }); tools();
        toast('Tap Remove BG to cut the background out.', 'good');
      });
      case 'bgnew': return repaintBackground();
      case 'bgphone': return pickImage(async (url) => {
        const im = await loadImg(url); const key = 'user:' + uid(); IMGS.set(key, im);
        change(() => { const b = ls.find((l) => l.type === 'bg'); if (b) b.img = key; });
      });
      case 'bgadjust': return sliders([['Brightness', 'bright', -60, 60], ['Contrast', 'contrast', -50, 80], ['Colour', 'sat', -100, 100], ['Blur', 'blur', 0, 25], ['Tint', 'tint', 0, 1, 0.05], ['Edges', 'vignette', 0, 1, 0.05]], ls.find((l) => l.type === 'bg'));
      case 'colours': return sheetPalettes();
      case 'looks': return sheetLooks();
      case 'words': F.step = 'make'; return drawMake();
      case 'size': return sheetSizes();
      case 'edit': return editText();
      case 'font': return sheetFonts();
      case 'colour': return sheetColour(L);
      case 'effects': return sheetEffects(L);
      case 'spacing': return sliders([['Letters', 'letter', -0.05, 0.8, 0.01], ['Lines', 'line', 0.7, 1.6, 0.02], ['Size', 's', 0.2, 3, 0.02], ['Turn', 'rot', -180, 180, 1]], L);
      case 'opacity': return sliders([['Opacity', 'opacity', 0.05, 1, 0.01]], L);
      case 'imglook': return sliders([['Brightness', 'bright', -60, 60], ['Contrast', 'contrast', -50, 80], ['Colour', 'sat', -100, 100], ['Round corners', 'radius', 0, 300]], L);
      case 'dup': { const N = Object.assign(clone(L), { id: uid(), x: L.x + 30, y: L.y + 30 }); change(() => { ls.splice(ls.indexOf(L) + 1, 0, N); F.sel = N.id; }); return; }
      case 'front': { const i = ls.indexOf(L); if (i < ls.length - 1) change(() => { ls.splice(i, 1); ls.splice(i + 1, 0, L); }); return; }
      case 'back': { const i = ls.indexOf(L); if (i > 1) change(() => { ls.splice(i, 1); ls.splice(i - 1, 0, L); }); return; }
      case 'del': change(() => { ls.splice(ls.indexOf(L), 1); F.sel = null; }); return tools();
      case 'gray': return change(() => { L.gray = !L.gray; });
      case 'flip': return change(() => { L.flip = !L.flip; });
      case 'glow': return change(() => { L.glow = L.glow ? '' : rgba(F.scene.pal.accent, 0.7); });
      case 'outline': return change(() => { L.outline = L.outline ? '' : '#ffffff'; });
      case 'fade': return change(() => { L.fade = L.fade ? 0 : 0.25; });
      case 'cutout': return cutOut(L);
      case 'bank': return sheetBank(L);
      case 'replace': return pickImage(async (url) => {
        const im = await loadImg(url); const key = 'user:' + uid(); IMGS.set(key, im);
        change(() => { L.img = key; L.w = L.h * iw(im) / ih(im); });
      });
      default:
    }
  }

  /* ----------------------------------------------------------------- sheets */

  function openSheet(html, wire) {
    const sh = $('#fsSheet'); if (!sh) return;
    sh.innerHTML = `<div class="fs-sheet-in">${html}</div><button type="button" class="fs-sheet-done">Done</button>`;
    sh.classList.remove('hidden');
    $('.fs-sheet-done', sh).onclick = closeSheet;
    if (wire) wire(sh);
  }
  function closeSheet() { const sh = $('#fsSheet'); if (sh) { sh.classList.add('hidden'); sh.innerHTML = ''; } }

  function sliders(list, L) {
    if (!L) return;
    snapshot();
    openSheet(list.map(([label, k, min, max, step]) => {
      const v = L[k] == null ? (k === 'opacity' || k === 's' ? 1 : k === 'line' ? 1 : k === 'tint' ? 0.45 : k === 'vignette' ? 0.75 : 0) : L[k];
      return `<label class="fs-slider"><span>${esc(label)}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step || 1}" value="${v}"><output>${Math.round(v * (step && step < 1 ? 100 : 1))}</output></label>`;
    }).join(''), (sh) => {
      $$('input[type=range]', sh).forEach((r) => r.addEventListener('input', () => {
        L[r.dataset.k] = +r.value;
        r.nextElementSibling.textContent = Math.round(+r.value * (+r.step < 1 ? 100 : 1));
        paint();
      }));
    });
  }

  function editText() {
    const L = F.sel && layerById(F.sel); if (!L || L.type !== 'text') return;
    snapshot();
    openSheet(`<textarea class="fs-textedit" rows="3">${esc(L.text)}</textarea>
      <div class="fs-row"><button type="button" class="fs-chip${L.upper ? ' on' : ''}" data-x="upper">AA Capitals</button>
      ${['left', 'center', 'right'].map((a) => `<button type="button" class="fs-chip${(L.align || 'center') === a ? ' on' : ''}" data-x="align" data-v="${a}">${a === 'left' ? 'Left' : a === 'right' ? 'Right' : 'Centre'}</button>`).join('')}
      <button type="button" class="fs-chip${L.slant ? ' on' : ''}" data-x="slant"><i>Italic</i></button></div>`, (sh) => {
      const ta = $('textarea', sh);
      setTimeout(() => { ta.focus(); ta.select(); }, 60);
      ta.addEventListener('input', () => { L.text = ta.value; paint(); });
      sh.addEventListener('click', (e) => {
        const b = e.target.closest('[data-x]'); if (!b) return;
        if (b.dataset.x === 'upper') L.upper = !L.upper;
        if (b.dataset.x === 'slant') L.slant = !L.slant;
        if (b.dataset.x === 'align') L.align = b.dataset.v;
        $$('[data-x]', sh).forEach((c) => c.classList.toggle('on', c.dataset.x === 'upper' ? !!L.upper : c.dataset.x === 'slant' ? !!L.slant : c.dataset.v === (L.align || 'center')));
        paint();
      });
    });
  }

  function sheetFonts() {
    const L = layerById(F.sel); if (!L) return;
    snapshot();
    openSheet(`<div class="fs-fonts">${FONTS.map((f) => `<button type="button" class="fs-font${L.font === f.id ? ' on' : ''}" data-font="${escAttr(f.id)}" style="font-family:${escAttr(fam(f.id))}">${esc(f.kind === 'script' ? 'Sunday' : 'SUNDAY')}<small>${esc(f.id)}</small></button>`).join('')}</div>`, (sh) => {
      sh.addEventListener('click', (e) => { const b = e.target.closest('[data-font]'); if (!b) return; L.font = b.dataset.font; $$('.fs-font', sh).forEach((x) => x.classList.toggle('on', x === b)); paint(); });
    });
  }

  function swatchRow(cur, attr) {
    const pal = F.scene.pal;
    const cols = Array.from(new Set([pal.accent, pal.hi, pal.mid, pal.deep].concat(SWATCHES)));
    return `<div class="fs-swatches">${cols.map((c) => `<button type="button" class="fs-sw${cur === c ? ' on' : ''}" data-${attr}="${c}" style="background:${c}"></button>`).join('')}<label class="fs-sw fs-sw-pick" style="background:conic-gradient(red,yellow,lime,cyan,blue,magenta,red)"><input type="color" data-${attr}-pick value="${typeof cur === 'string' && /^#/.test(cur) ? cur : '#ffffff'}"></label></div>`;
  }
  function sheetColour(L) {
    if (!L) return;
    snapshot();
    const isText = L.type === 'text';
    const html = (isText ? `<h4>Fill</h4><div class="fs-row">${FILLS.map(([n, v]) => `<button type="button" class="fs-chip${(v && L.fill === v) ? ' on' : ''}" data-metal="${v || ''}">${n}</button>`).join('')}<button type="button" class="fs-chip${L.imgFill ? ' on' : ''}" data-photo-fill="1">Picture inside</button></div>` : '')
      + swatchRow(typeof L.fill === 'string' ? L.fill : '', 'col')
      + (isText ? `<h4>Gradient</h4><div class="fs-row">${[[F.scene.pal.hi, F.scene.pal.accent], ['#ffffff', '#9ad7ff'], ['#fff3c4', '#ff9d00'], ['#ffd1f7', '#ff2fd6'], ['#ffffff', F.scene.pal.mid]].map((g) => `<button type="button" class="fs-grad" data-grad="${g.join(',')}" style="background:linear-gradient(180deg,${g[0]},${g[1]})"></button>`).join('')}</div>` : '');
    openSheet(html, (sh) => {
      sh.addEventListener('click', (e) => {
        const b = e.target.closest('[data-col],[data-metal],[data-grad],[data-photo-fill]'); if (!b) return;
        if (b.dataset.col) { L.fill = b.dataset.col; L.imgFill = ''; }
        if (b.dataset.metal != null) { L.fill = b.dataset.metal || '#ffffff'; L.imgFill = ''; L.grain = !!b.dataset.metal; }
        if (b.dataset.grad) { L.fill = { stops: b.dataset.grad.split(','), angle: 90 }; L.imgFill = ''; }
        if (b.dataset.photoFill) { const bg = F.scene.layers.find((l) => l.type === 'bg'); L.imgFill = L.imgFill ? '' : (bg && bg.img) || ''; L.fill = '#ffffff'; }
        paint();
      });
      const pick = $('input[type=color]', sh);
      if (pick) pick.addEventListener('input', () => { L.fill = pick.value; L.imgFill = ''; paint(); });
    });
  }
  function sheetEffects(L) {
    if (!L) return;
    snapshot();
    const fx = [
      ['None', { extrude: 0, glow: '', shadow: false, stroke: 0 }],
      ['Shadow', { shadow: true, extrude: 0, glow: '', stroke: 0 }],
      ['3D', { extrude: 7, extrudeColor: rgba(F.scene.pal.deep, 0.85), shadow: false, glow: '' }],
      ['Deep 3D', { extrude: 12, extrudeColor: '#1a1206', shadow: true, glow: '' }],
      ['Glow', { glow: rgba(F.scene.pal.accent, 0.85), extrude: 0, shadow: false }],
      ['Neon', { glow: '#ff2fd6', stroke: 2, strokeColor: '#ffffff', extrude: 0 }],
      ['Outline', { stroke: 3, strokeColor: '#ffffff', fill: 'none', extrude: 0, glow: '' }],
      ['Outline + fill', { stroke: 6, strokeColor: F.scene.pal.deep, extrude: 0, glow: '' }],
      ['Worn', { grain: true }],
    ];
    openSheet(`<div class="fs-fx">${fx.map(([n], i) => `<button type="button" class="fs-chip" data-fx="${i}">${n}</button>`).join('')}</div>
      <label class="fs-slider"><span>Depth</span><input type="range" data-k="extrude" min="0" max="20" step="1" value="${L.extrude || 0}"><output>${L.extrude || 0}</output></label>
      <label class="fs-slider"><span>Outline</span><input type="range" data-k="stroke" min="0" max="14" step="1" value="${L.stroke || 0}"><output>${L.stroke || 0}</output></label>`, (sh) => {
      sh.addEventListener('click', (e) => {
        const b = e.target.closest('[data-fx]'); if (!b) return;
        const [, o] = fx[+b.dataset.fx];
        if (o.fill === 'none') L.fill = 'none'; else if (L.fill === 'none') L.fill = '#ffffff';
        Object.assign(L, Object.assign({}, o, { fill: L.fill }));
        if (o.extrude == null && o.grain) L.grain = !L.grain;
        $$('input[type=range]', sh).forEach((r) => { r.value = L[r.dataset.k] || 0; r.nextElementSibling.textContent = r.value; });
        paint();
      });
      $$('input[type=range]', sh).forEach((r) => r.addEventListener('input', () => {
        L[r.dataset.k] = +r.value; r.nextElementSibling.textContent = r.value;
        if (r.dataset.k === 'extrude' && !L.extrudeColor) L.extrudeColor = rgba(F.scene.pal.deep, 0.85);
        if (r.dataset.k === 'stroke' && !L.strokeColor) L.strokeColor = '#000000';
        paint();
      }));
    });
  }

  /* the whole flyer in another colour set — or another layout — keeping the words, pictures and people */
  function rescene(o) {
    const bg = F.scene.layers.find((l) => l.type === 'bg');
    const sz = { w: F.scene.w, h: F.scene.h };
    const sp = sceneSpeakers();
    const S = buildScene(Object.assign({ look: F.scene.look, w: sz.w, h: sz.h, pal: F.scene.pal, dir: F.dir, fields: F.fields, speakers: sp, logo: IMGS.has('logo') ? 'logo' : null, bg: bg && bg.img }, o));
    snapshot();
    F.scene = S; F.sel = null; paint(); tools();
  }
  /* the speakers as this flyer has them now (a photo swapped in the editor stays swapped) */
  function sceneSpeakers() {
    return speakersFor(0).map((s) => {
      const L = F.scene && F.scene.layers.find((l) => l.speaker === s.id && l.photo);
      return L ? Object.assign(s, { photo: L.photo, img: L.img }) : s;
    });
  }
  function sheetPalettes() {
    const own = F.pal ? [Object.assign({ name: 'The AI’s' }, F.pal)] : [];
    const board = ((F.kit && F.kit.inspo) || []).filter((i) => (i.palette || []).length === 4).slice(0, 9)
      .map((i, n) => ({ name: 'Inspiration ' + (n + 1), deep: i.palette[0], mid: i.palette[1], accent: i.palette[2], hi: i.palette[3] }));
    const list = own.concat(board, PALETTES);
    openSheet(`<div class="fs-pals">${list.map((p, i) => `<button type="button" class="fs-pal" data-pal="${i}"><i style="background:${p.deep}"></i><i style="background:${p.mid}"></i><i style="background:${p.accent}"></i><small>${esc(p.name)}</small></button>`).join('')}</div>`, (sh) => {
      sh.addEventListener('click', (e) => { const b = e.target.closest('[data-pal]'); if (!b) return; const p = list[+b.dataset.pal]; rescene({ pal: { deep: p.deep, mid: p.mid, accent: p.accent, hi: p.hi } }); });
    });
  }
  function sheetLooks() {
    openSheet(`<div class="fs-looks">${Object.keys(LAYOUTS).map((k) => `<button type="button" class="fs-look${F.scene.look === k ? ' on' : ''}" data-look="${k}"><canvas></canvas><small>${esc(LOOK_NAMES[k])}</small></button>`).join('')}</div>`, (sh) => {
      const bg = F.scene.layers.find((l) => l.type === 'bg');
      const sp = sceneSpeakers();
      $$('.fs-look', sh).forEach((b) => {
        const S = buildScene({ look: b.dataset.look, w: F.scene.w, h: F.scene.h, pal: F.scene.pal, dir: F.dir, fields: F.fields, speakers: sp, logo: IMGS.has('logo') ? 'logo' : null, bg: bg && bg.img });
        const big = render(S, canvas(1, 1), 0.34), cv = $('canvas', b);
        cv.width = 150; cv.height = Math.round(150 * S.h / S.w); cv.getContext('2d').drawImage(big, 0, 0, cv.width, cv.height);
      });
      sh.addEventListener('click', (e) => { const b = e.target.closest('[data-look]'); if (b) rescene({ look: b.dataset.look }); });
    });
  }
  function sheetSizes() {
    openSheet(`<div class="fs-seg">${SIZES.map((s) => `<button type="button" data-size="${s.id}" class="${F.scene.w === s.w && F.scene.h === s.h ? 'on' : ''}">${esc(s.name)}</button>`).join('')}</div>`, (sh) => {
      sh.addEventListener('click', (e) => { const b = e.target.closest('[data-size]'); if (!b) return; F.size = b.dataset.size; const s = sizeOf(); rescene({ w: s.w, h: s.h }); });
    });
  }

  /* swap a speaker's picture for another from their bank */
  function sheetBank(L) {
    const s = ((F.kit && F.kit.speakers) || []).find((x) => x.id === L.speaker); if (!s) return;
    openSheet(`<h4>${esc(s.name || 'Speaker')}</h4><div class="fs-bank">${(s.photos || []).map((p) => `<button type="button" class="fs-bank-pic${L.photo === p ? ' on' : ''}" data-photo="${escAttr(p)}">${picTag(p)}</button>`).join('')}</div>`, (sh) => {
      fillPics(sh);
      sh.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-photo]'); if (!b) return;
        const p = b.dataset.photo, im = await bankPic(p); if (!im) return;
        change(() => { L.photo = p; L.img = picKey(p); L.w = L.h * iw(im) / ih(im); });
        F.pinned[s.id] = p;
        $$('.fs-bank-pic', sh).forEach((x) => x.classList.toggle('on', x === b));
      });
    });
  }

  /* from the Make page: which of a speaker's pictures goes on — or let the AI choose */
  function openBank(id) {
    const s = ((F.kit && F.kit.speakers) || []).find((x) => x.id === id); if (!s) return;
    const P = C.openPanel({ id: 'cloudFlyerBank', title: s.name || 'Speaker', cls: 'cp-flyer-kit' });
    const drawB = () => {
      P.body.innerHTML = `<div class="fs-kit"><p class="fs-note">${(s.photos || []).length ? 'Pick the picture for this flyer, or let the AI pick — it goes round all of them, a different one each time.' : 'No pictures yet. Add some — they are cut out and kept for every flyer.'}</p>
        <div class="fs-bank"><button type="button" class="fs-bank-pic fs-bank-ai${F.pinned[id] ? '' : ' on'}" data-b="ai">${ic('spark')}<small>AI picks</small></button>
        ${(s.photos || []).map((p) => `<button type="button" class="fs-bank-pic${F.pinned[id] === p ? ' on' : ''}" data-b="pin" data-photo="${escAttr(p)}">${picTag(p)}</button>`).join('')}
        <button type="button" class="fs-bank-pic fs-bank-add" data-b="add">${ic('plus')}<small>Add</small></button></div></div>`;
      P.foot.innerHTML = `<button type="button" class="fs-ghost" data-b="off"><span>Take ${esc((s.name || 'them').split(' ').slice(-1)[0])} off this flyer</span></button><button type="button" class="fs-go" data-b="done"><span>Done</span></button>`;
      fillPics(P.body);
    };
    drawB();
    const click = (e) => {
      const b = e.target.closest('[data-b]'); if (!b) return;
      if (b.dataset.b === 'ai') { delete F.pinned[id]; drawB(); }
      if (b.dataset.b === 'pin') { F.pinned[id] = b.dataset.photo; drawB(); }
      if (b.dataset.b === 'add') return addPhotos(s, async () => { await saveKit(true); drawB(); });
      if (b.dataset.b === 'off') { F.speakers = F.speakers.filter((x) => x !== id); delete F.pinned[id]; P.close(); drawMake(); }
      if (b.dataset.b === 'done') { P.close(); drawMake(); }
    };
    P.body.addEventListener('click', click); P.foot.addEventListener('click', click);
  }

  /*
   * ADD TO A BANK. One photo: the cut-out editor, to get it perfect. Several
   * at once: each cut out by the AI on its own (any one can be fixed later
   * from the bank).
   */
  function addPhotos(s, then) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []).slice(0, 20); if (!files.length) return;
      if (files.length === 1) {
        const url = await shrinkToDataUrl(files[0], 1800);
        return cutOutUrl(url, async (png) => { s.photos = (s.photos || []).concat(png); await then(); });
      }
      toast(`Cutting out ${files.length} pictures…`, '', 5000);
      for (const f of files) {
        try {
          const url = await shrinkToDataUrl(f, 1800);
          let png = url;
          try { png = (await window.FlyerAI.removePerson(url)).src; } catch (e) { /* kept as it is */ }
          s.photos = (s.photos || []).concat(png);
        } catch (e) { /* skip that one */ }
      }
      await then();
    };
    inp.click();
  }

  async function repaintBackground() {
    const bg = F.scene.layers.find((l) => l.type === 'bg'); if (!bg) return;
    const scenes = (F.dir && F.dir.scenes) || ['heavenly golden light rays through dramatic clouds'];
    toast('Painting a new picture with AI…', '', 4000);
    try {
      const out = await window.api.flyer.paint({ scene: scenes[Math.floor(Math.random() * scenes.length)], w: F.scene.w, h: F.scene.h, seed: Math.floor(Math.random() * 1e9), people: chosenSpeakers().some((s) => (s.photos || []).length) });
      const im = await loadImg(out.dataUrl); const key = 'ai:' + uid(); IMGS.set(key, im);
      change(() => { bg.img = key; });
    } catch (e) { toast('The AI could not paint just now: ' + (e.message || e), 'error', 8000); }
  }

  /* ------------------------------------------------- pictures, and cut-outs */

  function pickImage(then) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0]; if (!file) return;
      try { then(await shrinkToDataUrl(file, 1800)); } catch (e) { toast(e.message || 'That picture could not be opened.', 'error'); }
    };
    inp.click();
  }
  /* a phone photo is 12 megapixels; a flyer needs a fraction of that */
  async function shrinkToDataUrl(file, max) {
    const url = URL.createObjectURL(file);
    try {
      const im = await loadImg(url);
      const k = Math.min(1, max / Math.max(iw(im), ih(im)));
      const c = canvas(iw(im) * k, ih(im) * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.92);
    } finally { URL.revokeObjectURL(url); }
  }

  /*
   * REMOVE BACKGROUND — the studio's own cut-out editor (cutout.js): the AI
   * finds the person at once, a dial says how much goes, and two brushes put
   * back an arm it took or rub out a corner it left. All on the phone.
   */
  function cutOutUrl(src, done) {
    if (!window.CutOut || !window.FlyerAI) { toast('The cut-out tool is not available here.', 'error'); return; }
    const m = document.getElementById('cutModal'); if (m) m.style.zIndex = '2000';
    window.CutOut.open(src, (png) => { if (m) m.style.zIndex = ''; done(png); });
  }
  function cutOut(L) {
    const im = imgOf(L.img); if (!im) return;
    const c = canvas(iw(im), ih(im)); c.getContext('2d').drawImage(im, 0, 0);
    cutOutUrl(c.toDataURL('image/png'), async (png) => {
      const cut = await loadImg(png); const key = 'cut:' + uid(); IMGS.set(key, cut);
      change(() => { L.img = key; L.w = L.h * iw(cut) / ih(cut); });
      toast('Background removed.', 'good');
    });
  }

  /* ---------------------------------------------------------- save and post */

  function flyerBlob() {
    const cv = render(F.scene, canvas(1, 1), HD(F.scene));   // 4K
    return new Promise((res) => cv.toBlob((b) => { cv.width = cv.height = 1; res(b); }, 'image/jpeg', 0.95));
  }
  // the scheduler names a post after its file: "Bible Study flyer", not "bible study 2026 10 13"
  const fileName = () => `${(F.fields.title || 'Flyer').replace(/[^\w' ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Flyer'} flyer.jpg`;

  /* the next flyer for each speaker starts with a different picture */
  function noteUsed() {
    for (const L of (F.scene && F.scene.layers) || []) {
      if (!L.speaker || !L.photo || /^data:/.test(L.photo)) continue;
      const s = ((F.kit && F.kit.speakers) || []).find((x) => x.id === L.speaker);
      if (s) s.last = L.photo;
      window.api.flyer.kitUsed(L.speaker, L.photo).catch(() => {});
    }
  }
  async function saveFlyer(btn) {
    noteUsed();
    btn.disabled = true;
    try {
      const blob = await flyerBlob();
      const file = new File([blob], fileName(), { type: 'image/jpeg' });
      // an iPhone saves a picture to Photos from the share sheet
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      toast('Saved.', 'good');
    } catch (e) { toast('Could not save: ' + (e.message || e), 'error'); }
    finally { btn.disabled = false; }
  }

  async function postFlyer(btn) {
    if (!window.MWSocial || !window.MWSocial.compose) { toast('Posting is switched off on this server.', 'error'); return; }
    noteUsed();
    btn.disabled = true;
    const label = btn.querySelector('span'); const was = label.textContent; label.textContent = 'Sending…';
    try {
      const blob = await flyerBlob();
      const path = await C.uploadFile(new File([blob], fileName(), { type: 'image/jpeg' }));
      if (!path || typeof path !== 'string') throw new Error('it did not reach the studio');
      window.MWSocial.compose({ files: [path] });
    } catch (e) { toast('Could not send the flyer to Post: ' + (e.message || e), 'error'); }
    finally { btn.disabled = false; label.textContent = was; }
  }

  /* ============================================================ MY CHURCH */

  function openKit() {
    const P = C.openPanel({ id: 'cloudFlyerKit', title: 'My church', cls: 'cp-flyer-kit' });
    const k = JSON.parse(JSON.stringify(F.kit));   // a copy: closing without Save keeps the kit as it was
    const drawKit = () => {
      P.body.innerHTML = `<div class="fs-kit">
        <section class="fs-sec">
          <div class="fs-logo-row"><button type="button" class="fs-logo" data-k="logo">${k.logoUrl ? `<img src="${escAttr(k.logoUrl)}" alt="">` : ic('plus') + '<small>Logo</small>'}</button>
          <label class="fs-f fs-wide"><span>Church name</span><input data-kf="church" value="${escAttr(k.church || '')}" placeholder="The Gospel Faith Mission Int’l"></label></div>
          <label class="fs-f fs-wide"><span>Address</span><input data-kf="address" value="${escAttr(k.address || '')}" placeholder="144 Airport Road, Benin City"></label>
          <label class="fs-f fs-wide"><span>Phone / email</span><input data-kf="phone" value="${escAttr(k.phone || '')}" placeholder="+234 803 000 0000"></label>
          <label class="fs-f fs-wide"><span>Social handles</span><input data-kf="handles" value="${escAttr(k.handles || '')}" placeholder="@yourchurch"></label>
        </section>
        <section class="fs-sec"><h3>Speakers <small>their photos are cut out once and kept</small></h3>
          <div class="fs-kit-sps">${(k.speakers || []).map((s, i) => `<div class="fs-kit-sp"><div class="fs-kit-sp-top">
            <input data-spf="name" data-i="${i}" value="${escAttr(s.name || '')}" placeholder="Bishop David Richman"><button type="button" class="fs-x" data-k="sprm" data-i="${i}" aria-label="Remove">${ic('trash')}</button></div>
            <div class="fs-bank fs-bank-sm">${(s.photos || []).map((p, j) => `<button type="button" class="fs-bank-pic" data-k="sppic" data-i="${i}" data-j="${j}">${picTag(p)}</button>`).join('')}
            <button type="button" class="fs-bank-pic fs-bank-add" data-k="spadd-pic" data-i="${i}">${ic('plus')}<small>Photos</small></button></div></div>`).join('')}
          <button type="button" class="fs-ghost" data-k="spadd">${ic('plus')}<span>Add a speaker</span></button></div>
        </section>
        <section class="fs-sec"><h3>Inspiration <small>flyers you love — every new design leans their way</small></h3>
          <div class="fs-bank fs-bank-sm">${(F.kit.inspo || []).map((it) => `<button type="button" class="fs-bank-pic fs-inspo" data-k="inspo" data-id="${escAttr(it.id)}">${picTag(it.thumb)}${it.notes ? '<em>✓ read</em>' : ''}</button>`).join('')}
          <button type="button" class="fs-bank-pic fs-bank-add" data-k="inspoadd">${ic('plus')}<small>Add</small></button></div>
          <p class="fs-note">Screenshot flyers you like on Pinterest or Instagram and add them here.${F.status && F.status.writer === 'claude' ? ' The AI studies each one’s lettering, layout and picture.' : ' Their colours are used for your flyers.'}</p>
        </section>
        <section class="fs-sec"><h3>Service days <small>a flyer for one comes with its next date</small></h3>
          ${(k.services || []).map((s, i) => `<div class="fs-svc"><select data-svf="day" data-i="${i}">${DAYS.map((d, j) => `<option value="${j}"${+s.day === j ? ' selected' : ''}>${d}</option>`).join('')}</select>
            <input data-svf="name" data-i="${i}" value="${escAttr(s.name || '')}" placeholder="Sunday Service"><input data-svf="time" data-i="${i}" class="fs-svc-t" value="${escAttr(s.time || '')}" placeholder="9:00AM">
            <select data-svf="speaker" data-i="${i}"><option value="">Speaker…</option>${(k.speakers || []).map((p) => `<option value="${escAttr(p.id)}"${s.speaker === p.id ? ' selected' : ''}>${esc(p.name || 'Speaker')}</option>`).join('')}</select>
            <button type="button" class="fs-x" data-k="svrm" data-i="${i}" aria-label="Remove">${ic('trash')}</button></div>`).join('')}
          <button type="button" class="fs-ghost" data-k="svadd">${ic('plus')}<span>Add a service day</span></button>
        </section>
      </div>`;
      P.foot.innerHTML = '<button type="button" class="fs-go" data-k="save"><span>Save</span></button>';
      fillPics(P.body);
    };
    drawKit();
    const onInput = (e) => {
      const t = e.target;
      if (t.dataset.kf) k[t.dataset.kf] = t.value;
      if (t.dataset.spf) k.speakers[+t.dataset.i][t.dataset.spf] = t.value;
      if (t.dataset.svf) k.services[+t.dataset.i][t.dataset.svf] = t.dataset.svf === 'day' ? +t.value : t.value;
    };
    P.body.addEventListener('input', onInput);
    P.body.addEventListener('change', onInput);
    const click = async (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const i = +b.dataset.i;
      switch (b.dataset.k) {
        case 'logo': return pickImage((url) => cutOutUrl(url, async (png) => { k.logoUrl = png; IMGS.set('logo', await loadImg(png)); drawKit(); }));
        case 'spadd-pic': return addPhotos(k.speakers[i], async () => drawKit());
        case 'inspoadd': return addInspiration(() => drawKit());
        case 'inspo': {
          if (!window.confirm('Take this flyer off your inspiration board?')) return;
          try { await window.api.flyer.inspoRemove(b.dataset.id); F.kit.inspo = (F.kit.inspo || []).filter((x) => x.id !== b.dataset.id); } catch (e) {}
          return drawKit();
        }
        case 'sppic': {   // one of the bank: fix its cut-out, or take it out
          const sp = k.speakers[i], j = +b.dataset.j, p = sp.photos[j];
          const fix = window.confirm('Fix this picture’s cut-out?\n\n(Cancel to choose whether to remove it.)');
          if (fix) {
            await bankPic(p);
            return cutOutUrl(PICURL.get(p) || p, (png) => { sp.photos[j] = png; drawKit(); });
          }
          if (window.confirm('Remove this picture from ' + (sp.name || 'the speaker') + '’s bank?')) { sp.photos.splice(j, 1); drawKit(); }
          return;
        }
        case 'spadd': k.speakers.push({ id: 'sp' + Date.now().toString(36), name: '', photos: [] }); return drawKit();
        case 'sprm': k.speakers.splice(i, 1); return drawKit();
        case 'svadd': k.services.push({ id: 'sv' + Date.now().toString(36), day: 3, name: '', time: '6:00PM' }); return drawKit();
        case 'svrm': k.services.splice(i, 1); return drawKit();
        case 'save': {
          b.disabled = true;
          F.kit = k;
          await saveKit();
          await loadKit();
          P.close();
          if (F.panel && F.step === 'make') { if (F.occasion) pickOccasion(upcoming(F.kit).find((o) => o.id === F.occasion.id) || F.occasion); drawMake(); }
          return;
        }
        default:
      }
    };
    P.body.addEventListener('click', click);
    P.foot.addEventListener('click', click);
  }

  /* the four colours of a picture: its darkest, a mid, its most vivid, its lightest */
  function paletteOf(im) {
    const c = canvas(64, 80), x = c.getContext('2d', { willReadFrequently: true });
    cover(x, im, 0, 0, 64, 80);
    const d = x.getImageData(0, 0, 64, 80).data, bins = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const k = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const b = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 }; b.n++; b.r += d[i]; b.g += d[i + 1]; b.b += d[i + 2]; bins.set(k, b);
    }
    const cols = Array.from(bins.values()).filter((b) => b.n > 6).map((b) => {
      const r = b.r / b.n, g = b.g / b.n, bl = b.b / b.n, mx = Math.max(r, g, bl), mn = Math.min(r, g, bl);
      return { hex: '#' + [r, g, bl].map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''), n: b.n, l: (0.299 * r + 0.587 * g + 0.114 * bl) / 255, sat: mx ? (mx - mn) / mx : 0 };
    });
    if (!cols.length) return [];
    const by = (f) => cols.slice().sort(f)[0].hex;
    const deep = by((a, b) => (a.l - b.l) || (b.n - a.n));
    const hi = by((a, b) => (b.l - a.l) || (b.n - a.n));
    const accent = by((a, b) => (b.sat * b.l * Math.log(b.n + 1)) - (a.sat * a.l * Math.log(a.n + 1)));
    const mid = by((a, b) => (Math.abs(a.l - 0.35) - Math.abs(b.l - 0.35)) || (b.n * b.sat - a.n * a.sat));
    return [deep, mid, accent, hi];
  }
  function addInspiration(then) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []).slice(0, 12); if (!files.length) return;
      toast(`Reading ${files.length} flyer${files.length > 1 ? 's' : ''}…`, '', 5000);
      for (const f of files) {
        try {
          const image = await shrinkToDataUrl(f, 1024);
          const im = await loadImg(image);
          const t = canvas(300, 300 * ih(im) / iw(im)); t.getContext('2d').drawImage(im, 0, 0, t.width, t.height);
          const it = await window.api.flyer.inspoAdd({ thumb: t.toDataURL('image/jpeg', 0.8), image, palette: paletteOf(im) });
          F.kit.inspo = [it].concat(F.kit.inspo || []);
        } catch (e) { toast('One flyer could not be read: ' + (e.message || e), 'error'); }
      }
      then();
    };
    inp.click();
  }

  /* a new speaker straight from the Make page: photo → cut out → name → kept in the kit */
  function addSpeaker() {
    const name = (window.prompt('Their name, as it should be on flyers (e.g. Bishop David Richman):') || '').trim();
    if (!name) return;
    const sp = { id: 'sp' + Date.now().toString(36), name, photos: [] };
    addPhotos(sp, async () => {
      F.kit.speakers = (F.kit.speakers || []).concat(sp);
      await saveKit(true); await loadKit();
      F.speakers = F.speakers.concat(sp.id).slice(-8);
      drawMake();
    });
  }

  root.MWFlyerStudio = { open, _state: F };
})();
