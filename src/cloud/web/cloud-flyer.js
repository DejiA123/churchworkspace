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
  const META = new Map();   // picture key -> where the person is in it (preparePerson)
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

  /*
   * THE GRADE. Brightness / contrast / saturation by hand (Safari's canvas
   * has no ctx.filter), and the GRADIENT MAP that gives a designer's flyer
   * its colour: every brightness in the photo takes its colour from the
   * flyer's own ramp — deep shadows, the main colour in the middle, the
   * accent in the light — so any photo comes out orange-and-gold, or
   * purple-and-pink, like the rest of the flyer.
   */
  const adjCache = new Map();
  function duoLut(stops) {
    const lut = new Float32Array(256 * 3);
    for (let v = 0; v < 256; v++) {
      const t = v / 255;
      let j = 0; while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
      const [t0, c0] = stops[j], [t1, c1] = stops[Math.min(stops.length - 1, j + 1)];
      const u = t1 > t0 ? Math.max(0, Math.min(1, (t - t0) / (t1 - t0))) : 0;
      const a = hexRgb(c0), b = hexRgb(c1);
      for (let k = 0; k < 3; k++) lut[v * 3 + k] = a[k] + (b[k] - a[k]) * u;
    }
    return lut;
  }
  function adjusted(im, a, w, h) {
    const key = [IMGS_KEY(im), w, h, a.bright || 0, a.contrast || 0, a.sat || 0, a.gray ? 1 : 0, a.blur || 0, a.duo ? JSON.stringify(a.duo) : '', a.keep == null ? '' : a.keep].join('|');
    if (adjCache.has(key)) return adjCache.get(key);
    const c = canvas(w, h); const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingQuality = 'high';
    cover(x, im, 0, 0, w, h);
    if (a.blur) {   // a soft blur: down and back up
      const f = clamp(1 - a.blur / 30, 0.04, 1), s = canvas(w * f, h * f);
      s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
      x.clearRect(0, 0, w, h); x.drawImage(s, 0, 0, w, h);
    }
    if (a.bright || a.contrast || a.sat || a.gray || a.duo) {
      const d = x.getImageData(0, 0, w, h), p = d.data;
      const br = (a.bright || 0) * 2.55, ct = 1 + (a.contrast || 0) / 100, st = a.gray ? 0 : 1 + (a.sat || 0) / 100;
      const lut = a.duo ? duoLut(a.duo) : null, keep = a.keep == null ? 0.16 : a.keep;
      for (let i = 0; i < p.length; i += 4) {
        let r = p[i], g = p[i + 1], b = p[i + 2];
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        r = l + (r - l) * st; g = l + (g - l) * st; b = l + (b - l) * st;
        r = (r - 128) * ct + 128 + br; g = (g - 128) * ct + 128 + br; b = (b - 128) * ct + 128 + br;
        if (lut) {
          const L = Math.max(0, Math.min(255, Math.round(0.299 * r + 0.587 * g + 0.114 * b))) * 3;
          r = lut[L] * (1 - keep) + r * keep; g = lut[L + 1] * (1 - keep) + g * keep; b = lut[L + 2] * (1 - keep) + b * keep;
        }
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

  /* For when no photo could be had: rays, glow and bokeh in the flyer's colours. */
  function proceduralBg(w, h, pal, seed, style) {
    const c = canvas(w, h), x = c.getContext('2d'), r = rng(seed || 7);
    const g = x.createLinearGradient(0, 0, w * 0.3, h);
    g.addColorStop(0, pal.mid); g.addColorStop(0.55, mix(pal.mid, pal.deep, 0.6)); g.addColorStop(1, pal.deep);
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    const cx = w * (0.3 + r() * 0.4), cy = h * (0.12 + r() * 0.2);
    x.save(); x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      const a = -Math.PI / 2 + (r() - 0.5) * 2.6, len = h * 1.6, wd = 0.03 + r() * 0.07;
      const rg = x.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      rg.addColorStop(0, rgba(pal.hi, 0.22)); rg.addColorStop(1, rgba(pal.hi, 0));
      x.fillStyle = rg; x.beginPath(); x.moveTo(cx, cy);
      x.lineTo(cx + Math.cos(a - wd) * len, cy + Math.sin(a - wd) * len); x.lineTo(cx + Math.cos(a + wd) * len, cy + Math.sin(a + wd) * len); x.closePath(); x.fill();
    }
    const glow = x.createRadialGradient(cx, cy, 0, cx, cy, w * 0.75);
    glow.addColorStop(0, rgba(pal.accent, 0.55)); glow.addColorStop(0.35, rgba(pal.accent, 0.12)); glow.addColorStop(1, rgba(pal.accent, 0));
    x.fillStyle = glow; x.fillRect(0, 0, w, h);
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
  /* a fill: a colour, or a gradient centred on (cx, cy) over w × h */
  function gradAt(ctx, f, cx, cy, w, h) {
    if (f && typeof f === 'object' && f.stops) {
      const a = ((f.angle == null ? 90 : f.angle) * Math.PI) / 180;
      const dx = Math.cos(a) * w / 2, dy = Math.sin(a) * h / 2;
      const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
      f.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, f.stops.length - 1), c));
      return g;
    }
    return f || '#ffffff';
  }
  const fillOf = (x, f, w, h) => gradAt(x, f, 0, 0, w, h);

  function drawShape(x, L) {
    const w = L.w, h = L.h;
    x.fillStyle = fillOf(x, L.fill, w, h);
    if (L.shadow) { x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24 * Q; x.shadowOffsetY = 8 * Q; }
    switch (L.shape) {
      case 'pill': roundRect(x, -w / 2, -h / 2, w, h, h / 2); x.fill(); break;
      case 'round': roundRect(x, -w / 2, -h / 2, w, h, L.radius == null ? 18 : L.radius); x.fill(); break;
      case 'band': { const k = L.skew == null ? 40 : L.skew; x.beginPath(); x.moveTo(-w / 2 + k, -h / 2); x.lineTo(w / 2, -h / 2); x.lineTo(w / 2 - k, h / 2); x.lineTo(-w / 2, h / 2); x.closePath(); x.fill(); break; }
      case 'slant': { const k = L.skew == null ? 60 : L.skew; x.beginPath(); x.moveTo(-w / 2, -h / 2 + k); x.lineTo(w / 2, -h / 2); x.lineTo(w / 2, h / 2); x.lineTo(-w / 2, h / 2); x.closePath(); x.fill(); break; }
      case 'torn': tornPath(x, w, h, L.seed, { top: true, bottom: true }); x.fill(); break;
      case 'ragged': tornPath(x, w, h, L.seed, { top: true, bottom: true, side: true }); x.fill(); break;
      case 'circle': x.beginPath(); x.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); x.fill();
        if (L.ring) { x.shadowColor = 'transparent'; x.lineWidth = L.ring; x.strokeStyle = L.ringColor || '#fff'; x.beginPath(); x.ellipse(0, 0, w / 2 - L.ring * 1.6, h / 2 - L.ring * 1.6, 0, 0, Math.PI * 2); x.stroke(); }
        break;
      case 'ring': {
        const lw = L.line || 6; x.lineWidth = lw; x.strokeStyle = x.fillStyle;
        if (Math.abs(w - h) < 2) { x.beginPath(); x.ellipse(0, 0, w / 2 - lw, h / 2 - lw, 0, 0, Math.PI * 2); }
        else roundRect(x, -w / 2 + lw / 2, -h / 2 + lw / 2, w - lw, h - lw, L.radius == null ? (h - lw) / 2 : L.radius);
        x.stroke(); break;
      }
      case 'line': x.fillRect(-w / 2, -h / 2, w, h); break;
      case 'cross': { const t = w * 0.2; x.fillRect(-t / 2, -h / 2, t, h); x.fillRect(-w / 2, -h / 2 + h * 0.24, w, t); break; }
      case 'glow': {
        const col = typeof L.fill === 'string' ? L.fill : '#ffffff';
        const g = x.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
        g.addColorStop(0, col); g.addColorStop(0.45, rgba(col, 0.35)); g.addColorStop(1, rgba(col, 0));
        x.globalCompositeOperation = 'screen'; x.fillStyle = g; x.beginPath(); x.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); x.fill(); x.globalCompositeOperation = 'source-over';
        break;
      }
      case 'pin': {
        const s = Math.min(w, h);
        x.beginPath(); x.arc(0, -s * 0.12, s * 0.34, Math.PI * 0.85, Math.PI * 2.15); x.lineTo(0, s * 0.48); x.closePath(); x.fill();
        x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(0, -s * 0.12, s * 0.13, 0, Math.PI * 2); x.fill(); x.globalCompositeOperation = 'source-over';
        break;
      }
      case 'fade': {
        const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
        const col = typeof L.fill === 'string' ? L.fill : '#000000';
        g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.55, rgba(col, (L.strength || 0.85) * 0.75)); g.addColorStop(1, rgba(col, L.strength || 0.85));
        x.fillStyle = g; x.fillRect(-w / 2, -h / 2, w, h); break;
      }
      default: x.fillRect(-w / 2, -h / 2, w, h);
    }
    x.shadowColor = 'transparent';
  }

  /* ------------------------------------------------------------------ light */

  /*
   * LIGHT — what makes a designer's flyer glow: a halo behind the preacher,
   * a streak of light through the title, rays from above, embers rising,
   * soft out-of-focus lights. Each only ever adds light (screen / lighter),
   * so it can sit on any picture.
   */
  function drawFx(x, S, L) {
    const p = S.pal, c1 = L.color || p.accent, c2 = L.color2 || p.hi, r = rng(L.seed || 11);
    x.save();
    x.globalAlpha = L.opacity == null ? 1 : L.opacity;
    x.globalCompositeOperation = 'screen';
    const blob = (cx, cy, rx, ry, col, a, rot) => {
      x.save(); x.translate(cx, cy); if (rot) x.rotate(rot); x.scale(Math.max(1, rx), Math.max(1, ry));
      const g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, rgba(col, a)); g.addColorStop(0.35, rgba(col, a * 0.5)); g.addColorStop(0.7, rgba(col, a * 0.12)); g.addColorStop(1, rgba(col, 0));
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, Math.PI * 2); x.fill(); x.restore();
    };
    switch (L.kind) {
      case 'glow': blob(L.x, L.y, L.w / 2, L.h / 2, c1, 0.95); break;
      case 'streak': {
        const rot = (L.rot || 0) * Math.PI / 180;
        const cols = L.colors || ['#ff2d55', '#ff9500', '#ffd60a', '#34c759', '#0a84ff', '#bf5af2'];
        const n = cols.length;
        cols.forEach((col, i) => {
          const off = (i - (n - 1) / 2) * L.h / n;
          blob(L.x - Math.sin(rot) * off, L.y + Math.cos(rot) * off, L.w / 2, L.h / n * 1.1, col, 0.5, rot);
        });
        blob(L.x, L.y, L.w / 2, Math.max(3, L.h * 0.05), '#ffffff', 0.8, rot);
        break;
      }
      case 'rays': {
        const n = L.n || 16;
        for (let i = 0; i < n; i++) {
          const a = Math.PI / 2 + (r() - 0.5) * (L.spread || 1.5), len = L.h, wd = 0.012 + r() * 0.04;
          const g = x.createLinearGradient(L.x, L.y, L.x + Math.cos(a) * len, L.y + Math.sin(a) * len);
          g.addColorStop(0, rgba(i % 3 ? c1 : c2, 0.2 + r() * 0.25)); g.addColorStop(1, rgba(c1, 0));
          x.fillStyle = g; x.beginPath(); x.moveTo(L.x, L.y);
          x.lineTo(L.x + Math.cos(a - wd) * len, L.y + Math.sin(a - wd) * len);
          x.lineTo(L.x + Math.cos(a + wd) * len, L.y + Math.sin(a + wd) * len); x.closePath(); x.fill();
        }
        break;
      }
      case 'sparks': {
        x.globalCompositeOperation = 'lighter';
        const n = L.n || 80;
        for (let i = 0; i < n; i++) {
          const px = L.x - L.w / 2 + r() * L.w, py = L.y - L.h / 2 + r() * L.h, s = 0.8 + r() * r() * 4;
          const col = r() > 0.35 ? c1 : c2, len = 1 + r() * 4;
          x.save(); x.translate(px, py); x.rotate((r() - 0.5) * 0.9); x.scale(1, len);
          const g = x.createRadialGradient(0, 0, 0, 0, 0, s * 2.2);
          g.addColorStop(0, 'rgba(255,255,255,.95)'); g.addColorStop(0.3, rgba(col, 0.85)); g.addColorStop(1, rgba(col, 0));
          x.fillStyle = g; x.beginPath(); x.arc(0, 0, s * 2.2, 0, Math.PI * 2); x.fill(); x.restore();
        }
        break;
      }
      case 'bokeh': {
        const n = L.n || 30;
        for (let i = 0; i < n; i++) {
          const px = L.x - L.w / 2 + r() * L.w, py = L.y - L.h / 2 + r() * L.h, s = 8 + r() * (L.size || 42);
          const col = r() > 0.5 ? c1 : c2, a = 0.1 + r() * 0.28;
          const g = x.createRadialGradient(px, py, 0, px, py, s);
          g.addColorStop(0, rgba(col, a)); g.addColorStop(0.8, rgba(col, a * 0.7)); g.addColorStop(1, rgba(col, 0));
          x.fillStyle = g; x.beginPath(); x.arc(px, py, s, 0, Math.PI * 2); x.fill();
        }
        break;
      }
      case 'beams': {
        // stage lights: long soft beams from points above, crossing
        const srcs = L.from || [[0.1, -0.05], [0.9, -0.05], [0.5, -0.08]];
        srcs.forEach(([fx0, fy0], si) => {
          const ox = fx0 * S.w, oy = fy0 * S.h, n = L.n || 4;
          for (let i = 0; i < n; i++) {
            const tx = L.x - L.w / 2 + r() * L.w, ty = L.y + L.h / 2;
            const ang = Math.atan2(ty - oy, tx - ox), len = Math.hypot(tx - ox, ty - oy) * 1.15, wd = 0.02 + r() * 0.035;
            const g = x.createLinearGradient(ox, oy, ox + Math.cos(ang) * len, oy + Math.sin(ang) * len);
            const col = (si + i) % 2 ? c1 : c2;
            g.addColorStop(0, rgba('#ffffff', 0.55)); g.addColorStop(0.15, rgba(col, 0.35)); g.addColorStop(1, rgba(col, 0));
            x.fillStyle = g; x.beginPath(); x.moveTo(ox, oy);
            x.lineTo(ox + Math.cos(ang - wd) * len, oy + Math.sin(ang - wd) * len); x.lineTo(ox + Math.cos(ang + wd) * len, oy + Math.sin(ang + wd) * len); x.closePath(); x.fill();
          }
          blob(ox, oy + 10, 90, 60, '#ffffff', 0.7);
        });
        break;
      }
      case 'ring': {
        // the halo behind a head: a glowing ring of light
        x.lineWidth = L.thick || Math.max(4, L.w * 0.012);
        for (let k = 3; k >= 0; k--) {
          x.strokeStyle = rgba(k ? c1 : c2, k ? 0.18 : 0.95); x.lineWidth = (L.thick || Math.max(4, L.w * 0.012)) * (1 + k * 2.2);
          x.beginPath(); x.ellipse(L.x, L.y, L.w / 2, L.h / 2, 0, 0, Math.PI * 2); x.stroke();
        }
        break;
      }
      case 'confetti': {
        x.globalCompositeOperation = 'source-over';
        const cols = L.colors || [c1, c2, '#ffffff'];
        for (let i = 0; i < (L.n || 70); i++) {
          const px = L.x - L.w / 2 + r() * L.w, py = L.y - L.h / 2 + r() * L.h, sz = 6 + r() * 16;
          x.save(); x.translate(px, py); x.rotate(r() * Math.PI); x.fillStyle = cols[i % cols.length]; x.globalAlpha = 0.65 + r() * 0.35;
          x.fillRect(-sz / 2, -sz * 0.18, sz, sz * 0.36); x.restore();
        }
        break;
      }
      case 'flare': {
        blob(L.x, L.y, L.w * 0.12, L.w * 0.12, '#ffffff', 0.95);
        blob(L.x, L.y, L.w * 0.4, L.w * 0.4, c1, 0.6);
        blob(L.x, L.y, L.w / 2, Math.max(3, L.w * 0.012), '#ffffff', 0.85);
        blob(L.x, L.y, L.w / 2, Math.max(6, L.w * 0.04), c2, 0.5);
        break;
      }
      default:
    }
    x.restore();
  }

  /* ------------------------------------------------------------------- text */

  const METALS = {
    gold: ['#fff4cc', '#f6d47e', '#d8a23e', '#fbe6a2', '#b47a1d', '#eec35a', '#8a5a12'],
    rust: ['#8a4d1f', '#c27a35', '#6b3514', '#b0692b', '#4f260c'],
    silver: ['#ffffff', '#e3e7ec', '#a3abb5', '#f4f6f8', '#78818c', '#d9dee4'],
    fire: ['#fff6a0', '#ffd400', '#ff9d00', '#e14b00'],
    ice: ['#ffffff', '#d7f1ff', '#7cc8ff', '#2f7fd6'],
  };
  const textFillAt = (ctx, L, cx, cy, w, h) => gradAt(ctx, typeof L.fill === 'string' && METALS[L.fill] ? { stops: METALS[L.fill], angle: 90 } : L.fill, cx, cy, w, h);

  /* a worn, printed texture for distressed lettering */
  let grungeC = null;
  function grungeTile() {
    if (grungeC) return grungeC;
    grungeC = canvas(256, 256);
    const x = grungeC.getContext('2d'), r = rng(23);
    for (let i = 0; i < 900; i++) { x.fillStyle = r() > 0.5 ? 'rgba(0,0,0,.5)' : 'rgba(255,255,255,.4)'; x.beginPath(); x.arc(r() * 256, r() * 256, 0.4 + r() * r() * 3.2, 0, Math.PI * 2); x.fill(); }
    for (let i = 0; i < 40; i++) { x.strokeStyle = 'rgba(0,0,0,.35)'; x.lineWidth = 0.5 + r(); x.beginPath(); const sx = r() * 256, sy = r() * 256; x.moveTo(sx, sy); x.lineTo(sx + (r() - 0.5) * 60, sy + (r() - 0.5) * 18); x.stroke(); }
    return grungeC;
  }

  /*
   * A TEXT LAYER, SET LIKE A DESIGNER SETS IT. The box of a text layer is its
   * INK — the letters themselves, measured — not the font's line box, so a
   * stack of words lines up edge to edge. `fit` sets a line exactly as wide
   * as asked (the stacked titles every one of those flyers has), `maxH` caps
   * how tall the capitals may be, `stretch` makes condensed letters taller.
   * Drawn on its own canvas (cached) at the flyer's output sharpness.
   */
  const txtCache = new Map();
  let measC = null;
  function textCanvas(L) {
    const key = JSON.stringify([Q, L.text, L.font, L.size, L.fit, L.maxH, L.maxW, L.stretch, L.fill, L.stroke, L.strokeColor, L.extrude, L.extrudeColor, L.bevel, L.edge, L.edgeColor, L.glow, L.shadow, L.letter, L.align, L.line, L.slant, L.upper, L.grain, L.imgFill, L.imgFill && IMGS.has(L.imgFill)]);
    if (txtCache.has(key)) return txtCache.get(key);
    const m = (measC || (measC = canvas(8, 8))).getContext('2d');
    let text = String(L.text == null ? '' : L.text);
    // script lettering in capitals is a jumble of swashes ("WORD" in Alex Brush): a word typed in capitals is set Like This
    if (!L.upper && /[A-Z]{2}/.test(text) && text === text.toUpperCase() && (FONTS.find((q) => q.id === L.font) || {}).kind === 'script') {
      text = text.toLowerCase().replace(/(^|[\s\n-])([a-z])/g, (m, a, c) => a + c.toUpperCase());
    }
    const lines = (L.upper ? text.toUpperCase() : text).split('\n');
    const sy = L.stretch || 1;
    let size = L.size || 80;
    const fontOf = (s) => `${s}px ${fam(L.font || 'Anton')}, "Arial Black", Impact, sans-serif`;
    const lsp = (s) => (L.letter || 0) * s;
    const metr = (ln, s) => {
      m.font = fontOf(s);
      if (!L.letter || ln.length < 2) {
        const t = m.measureText(ln || ' ');
        return { l: t.actualBoundingBoxLeft || 0, r: t.actualBoundingBoxRight != null ? t.actualBoundingBoxRight : t.width, a: (t.actualBoundingBoxAscent != null ? t.actualBoundingBoxAscent : s * 0.72) * sy, d: (t.actualBoundingBoxDescent || 0) * sy };
      }
      let x = 0, l = 0, r = 0, a = 0, d = 0; const ch = Array.from(ln);
      ch.forEach((c, i) => { const t = m.measureText(c); if (i === 0) l = t.actualBoundingBoxLeft || 0; r = x + (t.actualBoundingBoxRight != null ? t.actualBoundingBoxRight : t.width); a = Math.max(a, t.actualBoundingBoxAscent || 0); d = Math.max(d, t.actualBoundingBoxDescent || 0); x += t.width + lsp(s); });
      return { l, r, a: a * sy, d: d * sy };
    };
    const inkW = (ln, s) => { const t = metr(ln, s); return Math.max(1, t.l + t.r); };
    const widest = (s) => Math.max(1, ...lines.map((ln) => inkW(ln, s)));
    // a long single line that would have to shrink below two-thirds of its size is broken in two instead (an address stays readable)
    if (L.maxW && !L.fit && lines.length === 1 && /\s/.test(lines[0]) && widest(size) > L.maxW / 0.66) {
      const ws = lines[0].split(/\s+/); let best = 1, diff = 1e9;
      for (let i = 1; i < ws.length; i++) { const dd = Math.abs(inkW(ws.slice(0, i).join(' '), size) - inkW(ws.slice(i).join(' '), size)); if (dd < diff) { diff = dd; best = i; } }
      lines.splice(0, 1, ws.slice(0, best).join(' '), ws.slice(best).join(' '));
    }
    if (L.fit) size = size * L.fit / widest(size);
    if (L.maxW && widest(size) > L.maxW) size = size * L.maxW / widest(size);
    if (L.maxH) { const h0 = Math.max(1, ...lines.map((ln) => { const t = metr(ln, size); return t.a + t.d; })); if (h0 > L.maxH) size = size * L.maxH / h0; }
    size = Math.max(6, size);
    const lh = size * (L.line || 1.0) * sy;
    const M = lines.map((ln) => metr(ln, size));
    const blockW = Math.max(1, ...M.map((t) => t.l + t.r));
    const xs = M.map((t) => { const w = t.l + t.r; return (L.align === 'left' ? 0 : L.align === 'right' ? blockW - w : (blockW - w) / 2) + t.l; });
    const ys = M.map((t, i) => i * lh);
    let y0 = Infinity, y1 = -Infinity;
    M.forEach((t, i) => { y0 = Math.min(y0, ys[i] - t.a); y1 = Math.max(y1, ys[i] + t.d); });
    if (!isFinite(y0)) { y0 = -size * 0.7; y1 = 0; }
    const inkW_ = blockW, inkH_ = Math.max(1, y1 - y0);
    const depth = L.extrude ? Math.round(L.extrude * size / 100) : 0;
    const slant = L.slant ? 0.2 : 0;
    const edge = L.edge ? Math.max(1.5, L.edge * size / 100) : 0;
    const pad = Math.ceil(size * 0.1 + depth * 1.3 + edge * 2 + (L.glow ? size * 0.5 : 0) + (L.stroke || 0) * 2 + (L.shadow ? size * 0.22 : 0) + slant * inkH_ / 2) + 4;
    const W = inkW_ + pad * 2, H = inkH_ + pad * 2;
    const ox = pad, oy = pad - y0, midY = pad + inkH_ / 2;
    const c = canvas(W * Q, H * Q), x = c.getContext('2d');
    const setT = (ctx) => { ctx.setTransform(Q, 0, 0, Q, 0, 0); if (slant) ctx.transform(1, 0, -slant, 1, slant * midY, 0); };
    const draw = (ctx, dx, dy, how) => lines.forEach((ln, i) => {
      let px = ox + xs[i] + dx; const py = oy + ys[i] + dy;
      ctx.save(); ctx.translate(0, py); if (sy !== 1) ctx.scale(1, sy);
      if (!L.letter || ln.length < 2) ctx[how](ln, px, 0);
      else for (const ch of ln) { ctx[how](ch, px, 0); px += ctx.measureText(ch).width + lsp(size); }
      ctx.restore();
    });
    setT(x); x.font = fontOf(size); x.textBaseline = 'alphabetic'; x.lineJoin = 'round';
    if (L.glow) { x.save(); x.shadowColor = L.glow; x.shadowBlur = size * 0.45 * Q; x.fillStyle = L.glow; draw(x, 0, 0, 'fillText'); if (depth) draw(x, depth * 0.55, depth, 'fillText'); x.restore(); }
    if (L.shadow && L.fill !== 'none') { x.save(); x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = size * 0.2 * Q; x.shadowOffsetY = size * 0.06 * Q; x.fillStyle = 'rgba(0,0,0,.6)'; draw(x, depth * 0.55, depth, 'fillText'); x.restore(); }
    /*
     * 3D, AS THE FLYERS DO IT: the letters stand on a solid block of
     * themselves (extrude) that darkens as it goes back — two colours, near and
     * far — with a hard dark edge round the whole thing (edge), so a title
     * reads from across a room.
     */
    if (edge) {
      x.save(); x.lineWidth = edge * 2; x.strokeStyle = L.edgeColor || '#000000'; x.fillStyle = L.edgeColor || '#000000';
      if (depth) draw(x, depth * 0.55, depth, 'strokeText');
      draw(x, 0, 0, 'strokeText'); x.restore();
    }
    if (depth) {
      const ec = Array.isArray(L.extrudeColor) ? L.extrudeColor : [L.extrudeColor || 'rgba(0,0,0,.55)', L.extrudeColor || 'rgba(0,0,0,.55)'];
      const solid = ec.every((c) => /^#[0-9a-f]{6}$/i.test(c));
      for (let d = depth; d >= 1; d--) { x.fillStyle = solid ? mix(ec[0], ec[1], (d - 1) / Math.max(1, depth - 1)) : ec[0]; draw(x, d * 0.55, d, 'fillText'); }
    }
    if (L.stroke) { x.save(); if (L.shadow && L.fill === 'none') { x.shadowColor = 'rgba(0,0,0,.6)'; x.shadowBlur = size * 0.12 * Q; } x.lineWidth = L.stroke * 2; x.strokeStyle = L.strokeColor || '#000'; draw(x, 0, 0, 'strokeText'); x.restore(); }
    if (L.fill !== 'none') {
      const face = canvas(W * Q, H * Q), fx = face.getContext('2d');
      setT(fx); fx.font = x.font; fx.lineJoin = 'round';
      // the letters first, then the fill laid into them: a gradient set while
      // each line is moved into place moved with it, so every gold, fire and
      // chrome title came out as its first colour only (flat cream)
      fx.fillStyle = '#000'; draw(fx, 0, 0, 'fillText');
      fx.globalCompositeOperation = 'source-in';
      fx.fillStyle = textFillAt(fx, L, pad + inkW_ / 2, midY, inkW_, inkH_);
      fx.fillRect(-W, -H, W * 3, H * 3);
      fx.globalCompositeOperation = 'source-over';
      fx.setTransform(1, 0, 0, 1, 0, 0);
      const im = L.imgFill && imgOf(L.imgFill);
      if (im) { fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = 0.9; cover(fx, im, 0, 0, face.width, face.height); fx.globalAlpha = 1; }
      if (L.grain) { fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = 0.45; fx.fillStyle = fx.createPattern(grungeTile(), 'repeat'); fx.fillRect(0, 0, face.width, face.height); fx.globalAlpha = 1; }
      if (L.bevel) {
        // a bevel: light catching the top edge of every letter, shade under the bottom one
        const k = Math.max(1.2, size * 0.035 * L.bevel);
        const band = (dy, col, a) => {
          const bc = canvas(face.width, face.height), bx = bc.getContext('2d');
          setT(bx); bx.font = x.font; bx.fillStyle = '#000'; draw(bx, 0, 0, 'fillText');
          bx.globalCompositeOperation = 'destination-out'; draw(bx, 0, dy, 'fillText');
          bx.setTransform(1, 0, 0, 1, 0, 0); bx.globalCompositeOperation = 'source-in'; bx.fillStyle = col; bx.fillRect(0, 0, bc.width, bc.height);
          fx.save(); fx.setTransform(1, 0, 0, 1, 0, 0); fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = a; fx.filter = `blur(${Math.max(0.5, k * Q * 0.25)}px)`; fx.drawImage(bc, 0, 0); fx.restore();
        };
        band(k, '#ffffff', 0.75);
        band(-k, '#000000', 0.32);
        // and a gloss across the upper half
        fx.save(); fx.setTransform(1, 0, 0, 1, 0, 0); fx.globalCompositeOperation = 'source-atop';
        const gg = fx.createLinearGradient(0, (pad - 0) * Q, 0, (pad + inkH_) * Q);
        gg.addColorStop(0, 'rgba(255,255,255,.28)'); gg.addColorStop(0.48, 'rgba(255,255,255,.06)'); gg.addColorStop(0.5, 'rgba(0,0,0,0)'); gg.addColorStop(1, 'rgba(0,0,0,.12)');
        fx.fillStyle = gg; fx.fillRect(0, 0, face.width, face.height); fx.restore();
      }
      x.setTransform(1, 0, 0, 1, 0, 0);
      x.drawImage(face, 0, 0);
    }
    const out = { c, w: W, h: H, ink: { w: inkW_, h: inkH_ }, pad, size };
    if (txtCache.size > 160) txtCache.delete(txtCache.keys().next().value);
    txtCache.set(key, out);
    return out;
  }

  /* ----------------------------------------------------------------- images */

  const picCache = new Map();
  const srcOf = (L) => L.src || (L.crop && L.crop < 1 ? { x: 0, y: 0, w: 1, h: L.crop } : null);
  /*
   * A PICTURE LAYER — a person, mostly. `src` is the part of the photo shown
   * (head to hips, say). The preacher is lit by the flyer: a halo of the
   * accent colour behind (glow), a thin bright edge (rim) as if a light were
   * behind them, and the bottom melts into the design (fade).
   */
  function imageCanvas(L, im) {
    const w = Math.max(1, Math.round(L.w * Q)), h = Math.max(1, Math.round(L.h * Q));
    const sr = srcOf(L);
    const key = [IMGS_KEY(im), w, h, sr ? [sr.x, sr.y, sr.w, sr.h].map((v) => (+v).toFixed(4)).join(',') : '', L.gray ? 1 : 0, L.fade || 0, L.glow || '', L.rim || '', L.bright || 0, L.contrast || 0, L.sat || 0, L.radius || 0, L.round ? 1 : 0, L.outline || '', L.tint ? JSON.stringify(L.tint) : '', L.rimW || 0, L.shade || '', L.feather || 0].join('|');
    if (picCache.has(key)) return picCache.get(key);
    const pad = Math.round((L.glow || L.shade ? Math.max(40, L.h * 0.08) : L.outline ? 14 : 0) * Q);
    const c = canvas(w + pad * 2, h + pad * 2), x = c.getContext('2d');
    let pic = im;
    if (sr) {
      const sx = sr.x * iw(im), sy = sr.y * ih(im), sw = Math.max(1, sr.w * iw(im)), sh = Math.max(1, sr.h * ih(im));
      pic = canvas(sw, sh); pic.getContext('2d').drawImage(im, -sx, -sy);
    }
    const body = (L.gray || L.bright || L.contrast || L.sat) ? adjusted(pic, { gray: L.gray, bright: L.bright, contrast: L.contrast, sat: L.sat }, w, h) : null;
    const layer = canvas(w, h), lx = layer.getContext('2d');
    lx.imageSmoothingQuality = 'high';
    if (L.round) { lx.beginPath(); lx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); lx.clip(); }
    else if (L.radius) { roundRect(lx, 0, 0, w, h, L.radius * Q); lx.clip(); }
    if (body) lx.drawImage(body, 0, 0); else lx.drawImage(pic, 0, 0, w, h);
    if (L.feather) {
      /* a cut-out's edge, softened by a pixel or two: a mask made at the photo's
         own size and blown up to a poster stair-steps along every shoulder */
      const fr = Math.max(0.8, L.feather * h / 1000);
      const mk = canvas(w, h), mx = mk.getContext('2d');
      mx.filter = `blur(${fr}px)`; mx.drawImage(layer, 0, 0); mx.filter = 'none';
      const keep = canvas(w, h), kx = keep.getContext('2d');
      kx.drawImage(layer, 0, 0); kx.globalCompositeOperation = 'destination-in'; kx.drawImage(mk, 0, 0); kx.drawImage(mk, 0, 0);
      lx.clearRect(0, 0, w, h); lx.drawImage(keep, 0, 0);
    }
    if (L.tint) {
      /* GRADED INTO THE FLYER: the scene's own colour laid over the person
         (soft light), stronger towards the edge it comes from, so a blue suit
         in front of a fire is lit by the fire, not pasted on it */
      const t = canvas(w, h), tx = t.getContext('2d');
      tx.drawImage(layer, 0, 0);
      tx.globalCompositeOperation = L.tint.mode || 'soft-light';
      const g = tx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, rgba(L.tint.top || L.tint.color, L.tint.a == null ? 0.5 : L.tint.a));
      g.addColorStop(1, rgba(L.tint.bottom || L.tint.color, (L.tint.a == null ? 0.5 : L.tint.a) * (L.tint.fall == null ? 0.6 : L.tint.fall)));
      tx.fillStyle = g; tx.fillRect(0, 0, w, h);
      tx.globalCompositeOperation = 'destination-in'; tx.drawImage(layer, 0, 0);
      lx.clearRect(0, 0, w, h); lx.drawImage(t, 0, 0);
    }
    if (L.rim) {   // the edge lit from behind: the outline minus the outline pulled in
      const r = Math.max(1.5, h * 0.004 * (L.rimW || 1));
      const e = canvas(w, h), ex = e.getContext('2d');
      ex.drawImage(layer, 0, 0); ex.globalCompositeOperation = 'destination-in';
      ex.drawImage(layer, r, 0); ex.drawImage(layer, -r, 0); ex.drawImage(layer, 0, r); ex.drawImage(layer, 0, -r);
      const t = canvas(w, h), tx = t.getContext('2d');
      tx.drawImage(layer, 0, 0); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = L.rim; tx.fillRect(0, 0, w, h);
      tx.globalCompositeOperation = 'destination-out'; tx.drawImage(e, 0, 0);
      tx.globalCompositeOperation = 'destination-in';   // stronger at the top (head and shoulders), gone by the waist
      const g = tx.createLinearGradient(0, 0, 0, h); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(0.55, 'rgba(0,0,0,.5)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      tx.fillStyle = g; tx.fillRect(0, 0, w, h);
      lx.globalCompositeOperation = 'screen'; lx.globalAlpha = 0.9; lx.filter = `blur(${Math.max(0.6, r * 0.45)}px)`; lx.drawImage(t, 0, 0); lx.filter = 'none'; lx.globalAlpha = 1; lx.globalCompositeOperation = 'source-over';
    }
    if (L.fade) {
      /* the bottom of a person melts into SHADOW, as a designer does it — it
         used to just go see-through, and a white suit fading over the picture
         behind looked like a ghost */
      lx.globalCompositeOperation = 'source-atop';
      const sg = lx.createLinearGradient(0, h * (1 - L.fade * 1.6), 0, h);
      sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(0.55, 'rgba(0,0,0,.45)'); sg.addColorStop(1, 'rgba(0,0,0,.85)');
      lx.fillStyle = sg; lx.fillRect(0, 0, w, h);
      lx.globalCompositeOperation = 'destination-out';
      const g = lx.createLinearGradient(0, h * (1 - L.fade), 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      lx.fillStyle = g; lx.fillRect(0, 0, w, h);
      lx.globalCompositeOperation = 'source-over';
    }
    if (L.outline) {
      const o = canvas(w + pad * 2, h + pad * 2), ox = o.getContext('2d');
      for (let a = 0; a < 16; a++) ox.drawImage(layer, pad + Math.cos(a / 8 * Math.PI) * 9 * Q, pad + Math.sin(a / 8 * Math.PI) * 9 * Q);
      ox.globalCompositeOperation = 'source-in'; ox.fillStyle = L.outline; ox.fillRect(0, 0, o.width, o.height);
      x.drawImage(o, 0, 0);
    }
    if (L.shade) { x.save(); x.shadowColor = L.shade; x.shadowBlur = Math.max(24, L.h * 0.05) * Q; x.drawImage(layer, pad, pad); x.restore(); }
    if (L.glow) { x.save(); x.shadowColor = L.glow; x.shadowBlur = Math.max(30, L.h * 0.07) * Q; x.drawImage(layer, pad, pad); x.restore(); }
    x.drawImage(layer, pad, pad);
    const out = { c, pad };
    if (picCache.size > 30) picCache.delete(picCache.keys().next().value);
    picCache.set(key, out);
    return out;
  }

  /* ------------------------------------------------------------------ scene */

  /* the colour ramp a background is mapped onto: near-black, deep, main, accent, light */
  function gradeStops(p, kind) {
    const dk = mix(p.deep, '#000000', 0.7), lt = mix(p.accent, '#ffffff', 0.6);
    // vivid: the loud, saturated look of the flyers people stop scrolling for —
    // the shadows keep their colour (no black), the lights go to the accent
    if (kind === 'vivid') return [[0, mix(p.deep, '#000000', 0.35)], [0.28, p.deep], [0.55, p.mid], [0.8, p.accent], [1, mix(p.accent, '#ffffff', 0.7)]];
    const at = kind === 'dark' ? [0.34, 0.66, 0.9] : kind === 'bright' ? [0.1, 0.36, 0.7] : [0.22, 0.5, 0.82];
    return [[0, dk], [at[0], p.deep], [at[1], p.mid], [at[2], p.accent], [1, lt]];
  }
  function drawBg(x, S, L) {
    const im = imgOf(L.img);
    const W = S.w, H = S.h, pal = S.pal;
    if (im) {
      /* THE PHOTO STAYS A PHOTO. The grade mapped 85-90% of every pixel onto the
         flyer's four colours, which posterised a real picture into something
         drawn ("too cartoonish"). Now at least half of the photograph's own
         colour stays, and a touch of depth of field puts it behind the speaker. */
      const keep = Math.max(L.keep == null ? 0.16 : L.keep, L.keepFloor == null ? 0.55 : L.keepFloor);
      const a = { bright: L.bright, contrast: L.contrast, sat: L.sat, gray: L.gray, blur: L.blur == null ? 1.5 : L.blur, duo: L.grade ? gradeStops(pal, L.grade) : null, keep };
      x.drawImage(adjusted(im, a, Math.round(W * Q), Math.round(H * Q)), 0, 0, W, H);
    } else {
      const g = x.createLinearGradient(0, 0, W * 0.3, H); g.addColorStop(0, pal.mid); g.addColorStop(1, pal.deep);
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    if (L.tint > 0) {   // the older grade (colour + soft light), kept for designs made with it
      x.save();
      x.globalCompositeOperation = 'color'; x.globalAlpha = L.tint * 0.85;
      const g = x.createLinearGradient(0, 0, W * 0.4, H); g.addColorStop(0, pal.mid); g.addColorStop(1, pal.deep);
      x.fillStyle = g; x.fillRect(0, 0, W, H);
      x.restore();
    }
    if (L.wash) { x.fillStyle = L.wash; x.fillRect(0, 0, W, H); }
    // colour laid over the picture in a blend (overlay / color / screen…): the magenta-to-orange sweep
    for (const cw of [].concat(L.colorWash || [])) {
      x.save(); x.globalCompositeOperation = cw.mode || 'overlay'; x.globalAlpha = cw.a == null ? 0.6 : cw.a;
      if (cw.radial) {
        const g = x.createRadialGradient(cw.x * W, cw.y * H, 0, cw.x * W, cw.y * H, (cw.r || 0.7) * Math.max(W, H));
        cw.stops.forEach((c, i) => g.addColorStop(i / Math.max(1, cw.stops.length - 1), c));
        x.fillStyle = g;
      } else x.fillStyle = gradAt(x, { stops: cw.stops, angle: cw.angle }, W / 2, H / 2, W, H);
      x.fillRect(0, 0, W, H); x.restore();
    }
    // shade where the words sit, in the flyer's own darkest colour
    const dark = mix(pal.deep, '#000000', 0.45);
    const shade = (yA, yB, a) => { const g = x.createLinearGradient(0, yA, 0, yB); g.addColorStop(0, rgba(dark, 0)); g.addColorStop(1, rgba(dark, a)); x.fillStyle = g; x.fillRect(0, Math.min(yA, yB), W, Math.abs(yB - yA)); };
    if (L.topShade) shade(H * (L.topTo || 0.3), 0, L.topShade);
    if (L.bottomShade) shade(H * (L.bottomFrom || 0.55), H, L.bottomShade);
    if (L.vignette) {
      const v = x.createRadialGradient(W / 2, H * 0.45, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.78);
      v.addColorStop(0, rgba(dark, 0)); v.addColorStop(1, rgba(dark, L.vignette));
      x.fillStyle = v; x.fillRect(0, 0, W, H);
    }
    if (L.grain !== 0) {
      x.save(); x.globalCompositeOperation = 'overlay'; x.globalAlpha = 0.06 * (L.grain == null ? 1 : L.grain);
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

  /** The size of a layer as it is seen: a text layer's letters, a picture's frame. */
  function boxOf(L) {
    if (L.type === 'text') { const t = textCanvas(L); return { w: t.ink.w, h: t.ink.h }; }
    return { w: L.w || 0, h: L.h || 0 };
  }

  function drawLayer(x, S, L) {
    if (L.hidden) return;
    if (L.type === 'bg') return drawBg(x, S, L);
    if (L.type === 'fx') return drawFx(x, S, L);
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

  /* ============================================================ THE PEOPLE */

  /*
   * A SPEAKER'S PHOTO, MADE READY. The cut-out keeps whatever touched the
   * person — the podium they stood at, a chair, a microphone stand ("what is
   * that black thing in the corner?"). The pose model (on this phone) says
   * where the body is; anything outside the outline it draws — head, neck,
   * body, arms, hands, and the legs only when they can be seen — goes. Then
   * only the person is kept and the picture is trimmed round them. The
   * landmarks also say where the head, shoulders and hips are, so every
   * flyer frames every photo the same way, the face the same size.
   */
  function alphaStats(c) {
    const k = Math.min(1, 120 / Math.max(c.width, c.height)), s = canvas(c.width * k, c.height * k), x = s.getContext('2d', { willReadFrequently: true });
    x.drawImage(c, 0, 0, s.width, s.height);
    const d = x.getImageData(0, 0, s.width, s.height).data; let clear = 0, mass = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] < 128) clear++; mass += d[i]; }
    return { clear: clear / (d.length / 4), mass };
  }
  function onGray(c, max) {
    const k = Math.min(1, (max || 640) / Math.max(c.width, c.height)), s = canvas(c.width * k, c.height * k), x = s.getContext('2d');
    x.fillStyle = '#7f7f7f'; x.fillRect(0, 0, s.width, s.height); x.drawImage(c, 0, 0, s.width, s.height);
    return s;
  }
  function softened(c, r) {
    const k = clamp(2 / r, 0.04, 1), s = canvas(c.width * k, c.height * k);
    s.getContext('2d').drawImage(c, 0, 0, s.width, s.height);
    const o = canvas(c.width, c.height), x = o.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(s, 0, 0, c.width, c.height);
    return o;
  }
  function envelope(w, h, lm) {
    const P = (i, v) => { const q = lm[i]; return q && (q.visibility == null || q.visibility >= v) ? { x: q.x * w, y: q.y * h } : null; };
    const ls = P(11, 0.3), rs = P(12, 0.3);
    if (!ls || !rs) return null;
    const sw = Math.max(8, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    const sm = { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
    const nose = P(0, 0.3) || { x: sm.x, y: sm.y - sw * 0.75 };
    const c = canvas(w, h), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.lineCap = 'round'; x.lineJoin = 'round';
    const line = (pts, r) => { const ps = pts.filter(Boolean); if (ps.length < 2) return; x.lineWidth = r * 2; x.beginPath(); x.moveTo(ps[0].x, ps[0].y); ps.slice(1).forEach((q) => x.lineTo(q.x, q.y)); x.stroke(); };
    const dot = (q, r) => { if (!q) return; x.beginPath(); x.arc(q.x, q.y, r, 0, Math.PI * 2); x.fill(); };
    // the head, generously (hair, a hat, a head-tie)
    const hr = Math.max(sw * 0.42, Math.hypot(nose.x - sm.x, nose.y - sm.y) * 0.8);
    x.beginPath(); x.ellipse(nose.x, nose.y - hr * 0.45, hr * 1.25, hr * 1.6, 0, 0, Math.PI * 2); x.fill();
    line([nose, sm], sw * 0.32);
    // the body to the hips
    const lh = P(23, 0.2), rh = P(24, 0.2);
    const hy = lh && rh ? (lh.y + rh.y) / 2 : sm.y + sw * 1.7;
    const L2 = lh || { x: ls.x, y: hy }, R2 = rh || { x: rs.x, y: hy };
    x.beginPath(); x.moveTo(ls.x, ls.y); x.lineTo(rs.x, rs.y); x.lineTo(R2.x, R2.y); x.lineTo(L2.x, L2.y); x.closePath(); x.fill();
    x.lineWidth = sw * 0.6; x.stroke();
    // arms and hands (a microphone in a hand stays)
    [[11, 13, 15, 19, 21], [12, 14, 16, 20, 22]].forEach(([s, e, wr, ix, th]) => {
      const S2 = P(s, 0.2), E = P(e, 0.35), Wr = P(wr, 0.35);
      line([S2, E, Wr], sw * 0.21);
      if (Wr) { dot(Wr, sw * 0.36); line([Wr, P(ix, 0.3)], sw * 0.16); line([Wr, P(th, 0.3)], sw * 0.16); }
      else if (E) dot(E, sw * 0.24);
    });
    // the legs only when they can be seen (a podium in front of them is not them)
    [[23, 25, 27, 31, 29], [24, 26, 28, 32, 30]].forEach(([hp, kn, an, ft, hl]) => {
      const K = P(kn, 0.6); if (!K) return;
      line([P(hp, 0.2) || { x: (lh || ls).x, y: hy }, K, P(an, 0.6), P(ft, 0.6)], sw * 0.22);
      dot(P(hl, 0.6), sw * 0.16);
    });
    return softened(c, Math.max(2, sw * 0.05));
  }
  /* the person's own outline: only the biggest shape, trimmed tight (feet at the bottom edge) */
  function tidyCanvas(cv) {
    const W = cv.width, H = cv.height;
    const k = Math.min(1, 360 / Math.max(W, H)), w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    const sm = canvas(w, h), sx = sm.getContext('2d', { willReadFrequently: true });
    sx.drawImage(cv, 0, 0, w, h);
    const a = sx.getImageData(0, 0, w, h).data;
    const lab = new Int32Array(w * h).fill(-1), sizes = [], boxes = [], st = [];
    for (let i = 0; i < w * h; i++) {
      if (lab[i] >= 0 || a[i * 4 + 3] < 60) continue;
      const id = sizes.length; let n = 0; const bx = [w, h, 0, 0];
      lab[i] = id; st.push(i);
      while (st.length) {
        const j = st.pop(), x = j % w, y = (j / w) | 0; n++;
        if (x < bx[0]) bx[0] = x; if (y < bx[1]) bx[1] = y; if (x > bx[2]) bx[2] = x; if (y > bx[3]) bx[3] = y;
        if (x > 0 && lab[j - 1] < 0 && a[(j - 1) * 4 + 3] >= 60) { lab[j - 1] = id; st.push(j - 1); }
        if (x < w - 1 && lab[j + 1] < 0 && a[(j + 1) * 4 + 3] >= 60) { lab[j + 1] = id; st.push(j + 1); }
        if (y > 0 && lab[j - w] < 0 && a[(j - w) * 4 + 3] >= 60) { lab[j - w] = id; st.push(j - w); }
        if (y < h - 1 && lab[j + w] < 0 && a[(j + w) * 4 + 3] >= 60) { lab[j + w] = id; st.push(j + w); }
      }
      sizes.push(n); boxes.push(bx);
    }
    if (!sizes.length) return { c: cv, x0: 0, y0: 0 };
    const big = sizes.indexOf(Math.max(...sizes));
    const B = boxes[big], bw = B[2] - B[0], left = B[0] - bw * 0.08, right = B[2] + bw * 0.08;
    const keep = sizes.map((n, i) => i === big || (n >= sizes[big] * 0.1 && boxes[i][0] >= left && boxes[i][2] <= right));
    const full = canvas(W, H), fx = full.getContext('2d', { willReadFrequently: true });
    fx.drawImage(cv, 0, 0);
    const d = fx.getImageData(0, 0, W, H), p = d.data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) {
      const my = Math.min(h - 1, (y * k) | 0);
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (p[i + 3] === 0) continue;
        const l = lab[my * w + Math.min(w - 1, (x * k) | 0)];
        if (l < 0 || !keep[l]) { p[i + 3] = 0; continue; }
        if (p[i + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 <= x0 || y1 <= y0) return { c: cv, x0: 0, y0: 0 };
    fx.putImageData(d, 0, 0);
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + 1);
    const out = canvas(x1 - x0 + 1, y1 - y0 + 1);
    out.getContext('2d').drawImage(full, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { c: out, x0, y0 };
  }
  /* where the head, shoulders and hips are in a (trimmed) cut-out */
  function metaOf(c, lm, x0, y0, W0, H0) {
    const w = c.width, h = c.height;
    const k = Math.min(1, 220 / Math.max(w, h)), aw = Math.max(1, Math.round(w * k)), ah = Math.max(1, Math.round(h * k));
    const s = canvas(aw, ah), sx = s.getContext('2d', { willReadFrequently: true }); sx.drawImage(c, 0, 0, aw, ah);
    const a = sx.getImageData(0, 0, aw, ah).data;
    const on = (X, Y) => a[(Y * aw + X) * 4 + 3] > 110;
    const topIn = (xa, xb) => { const A = clamp(Math.floor(xa * k), 0, aw - 1), B = clamp(Math.ceil(xb * k), 0, aw - 1); for (let Y = 0; Y < ah; Y++) for (let X = A; X <= B; X++) if (on(X, Y)) return Y / k; return 0; };
    let top = topIn(0, w);
    if (lm) {
      const P = (i, v) => { const q = lm[i]; return q && (q.visibility == null || q.visibility >= v) ? { x: q.x * W0 - x0, y: q.y * H0 - y0 } : null; };
      const ls = P(11, 0.3), rs = P(12, 0.3);
      if (ls && rs) {
        const sw = Math.max(8, Math.hypot(ls.x - rs.x, ls.y - rs.y)), sy = (ls.y + rs.y) / 2, cx = (ls.x + rs.x) / 2;
        const nose = P(0, 0.3), hx = nose ? nose.x : cx;
        top = topIn(hx - sw * 0.6, hx + sw * 0.6);
        const lh = P(23, 0.45), rh = P(24, 0.45);
        const hy = lh && rh ? (lh.y + rh.y) / 2 : null;
        // the lowest hand: a chest-up flyer ends just under it — below the hands
        // is where a podium, a lectern's glass or a front-row head gets in
        const ws = [P(15, 0.35), P(16, 0.35)].filter(Boolean).map((q) => q.y);
        const wy = ws.length ? Math.max(...ws) : null;
        return { w, h, top, cx, sy: Math.max(sy, top + 10), sw, hy: hy && hy > sy + 10 ? hy : null, wy: wy && wy > sy ? wy : null, full: !!(P(27, 0.6) || P(28, 0.6)) };
      }
    }
    const tall = h / w;
    let cxs = 0, n = 0; const ya = Math.round(top * k), yb = Math.min(ah - 1, Math.round((top + h * 0.15) * k));
    for (let Y = ya; Y <= yb; Y++) for (let X = 0; X < aw; X++) if (on(X, Y)) { cxs += X; n++; }
    return { w, h, top, cx: n ? cxs / n / k : w / 2, sy: top + (tall > 1.7 ? h * 0.17 : h * 0.33), sw: w * 0.45, hy: null, full: tall > 2.3, guess: true };
  }
  const QM = new WeakMap();
  function quickMeta(im) {
    if (QM.has(im)) return QM.get(im);
    const k = Math.min(1, 400 / Math.max(iw(im), ih(im)));
    const c = canvas(iw(im) * k, ih(im) * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    const m0 = metaOf(c, null, 0, 0, c.width, c.height), f = 1 / k;
    const m = Object.assign({}, m0, { w: iw(im), h: ih(im), top: m0.top * f, cx: m0.cx * f, sy: m0.sy * f, sw: m0.sw * f });
    QM.set(im, m);
    return m;
  }
  /*
   * A CLEAN EDGE. A cut-out made small and blown up to a poster stair-steps
   * along every shoulder and keeps a pale fringe of the old background (the
   * blocky white outline round a suit). The edge is smoothed — the alpha
   * blurred and cut again a little inside — which rounds the steps into the
   * real curve and takes the fringe off with them. It only ever takes away.
   */
  function smoothEdge(c) {
    const W = c.width, H = c.height;
    if (W < 8 || H < 8) return c;
    const x = c.getContext('2d', { willReadFrequently: true });
    const d = x.getImageData(0, 0, W, H), p = d.data, n = W * H;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = p[i * 4 + 3] / 255;
    const r = Math.max(2, Math.round(Math.max(W, H) * 0.0035));
    const b = Float32Array.from(a), tmp = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {   // two box passes ≈ a gaussian
      for (let y = 0; y < H; y++) { let acc = 0; const row = y * W; for (let k = -r; k <= r; k++) acc += b[row + clamp(k, 0, W - 1)]; for (let xx = 0; xx < W; xx++) { tmp[row + xx] = acc / (2 * r + 1); acc += b[row + Math.min(W - 1, xx + r + 1)] - b[row + Math.max(0, xx - r)]; } }
      for (let xx = 0; xx < W; xx++) { let acc = 0; for (let k = -r; k <= r; k++) acc += tmp[clamp(k, 0, H - 1) * W + xx]; for (let y = 0; y < H; y++) { b[y * W + xx] = acc / (2 * r + 1); acc += tmp[Math.min(H - 1, y + r + 1) * W + xx] - tmp[Math.max(0, y - r) * W + xx]; } }
    }
    for (let i = 0; i < n; i++) {
      if (a[i] === 0) continue;
      const t = clamp((b[i] - 0.5) / 0.4, 0, 1), sm = t * t * (3 - 2 * t);
      p[i * 4 + 3] = Math.round(Math.min(a[i], sm) * 255);
    }
    x.putImageData(d, 0, 0);
    return c;
  }
  /*
   * WHERE THE PERSON STOPS BEING CLEAN. A glass lectern in front of a
   * preacher comes out of the cut-out HALF see-through — a pane of nothing
   * with the old background ghosting in it, a sliver at the hand ("the remove
   * from background is terrible"). A person's own edge is only a pixel or two
   * of half-transparency per side; glass is a wide band of it. The first row
   * below the shoulders where that band starts is where the flyer frames them
   * down to, and no lower.
   */
  function cleanBottom(c, top, sy) {
    const W = c.width, H = c.height, k = Math.min(1, 240 / Math.max(W, H));
    const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
    const s2 = canvas(w, h), x = s2.getContext('2d', { willReadFrequently: true });
    x.drawImage(c, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data;
    const u = Math.max(4, (sy - top) * k), from = Math.round(sy * k + u * 0.35);
    let run = 0;
    for (let y = Math.max(0, from); y < h; y++) {
      let part = 0, solid = 0;
      for (let xx = 0; xx < w; xx++) { const a = d[(y * w + xx) * 4 + 3]; if (a >= 215) solid++; else if (a > 25) part++; }
      if (part >= Math.max(8, solid * 0.14)) { if (++run >= 3) return (y - 2) / k; } else run = 0;
    }
    return null;
  }
  const PREP = new WeakMap();
  function preparePerson(im) {
    if (PREP.has(im)) return PREP.get(im);
    const job = (async () => {
      const W0 = iw(im), H0 = ih(im);
      let c = canvas(W0, H0); c.getContext('2d').drawImage(im, 0, 0);
      const st0 = alphaStats(c);
      if (st0.clear < 0.04) return { img: c, meta: null };   // a plain photo, nothing cut out: leave it
      let lm = null;
      try { if (root.FlyerAI && root.FlyerAI.poseOf) lm = await root.FlyerAI.poseOf(onGray(c)); } catch (e) { lm = null; }
      if (lm) {
        const env = envelope(W0, H0, lm);
        if (env) {
          const o = canvas(W0, H0), ox = o.getContext('2d');
          ox.drawImage(c, 0, 0); ox.globalCompositeOperation = 'destination-in'; ox.drawImage(env, 0, 0);
          // a wrong pose would take half the person: then it is not trusted
          if (alphaStats(o).mass >= st0.mass * 0.55) c = o;
        }
      }
      const t = tidyCanvas(c);
      const meta = metaOf(t.c, lm, t.x0, t.y0, W0, H0);
      if (meta) { const cb = cleanBottom(t.c, meta.top, meta.sy); if (cb) meta.clean = cb; }
      return { img: smoothEdge(t.c), meta };
    })().catch(() => ({ img: im, meta: null }));
    PREP.set(im, job);
    return job;
  }

  /* ================================================================ LAYOUTS */

  const T = (o) => Object.assign({ id: uid(), type: 'text', x: 540, y: 200, rot: 0, s: 1, font: 'Anton', size: 100, fill: '#ffffff', align: 'center', line: 1 }, o);
  const SH = (o) => Object.assign({ id: uid(), type: 'shape', x: 540, y: 200, rot: 0, s: 1, shape: 'rect', w: 200, h: 80, fill: '#ffffff' }, o);
  const IM = (o) => Object.assign({ id: uid(), type: 'image', x: 540, y: 600, rot: 0, s: 1, w: 500, h: 700 }, o);
  const BG = (o) => Object.assign({ id: 'bg', type: 'bg', name: 'Background', lock: true }, o);
  const FX = (o) => Object.assign({ id: uid(), type: 'fx', name: 'Light', lock: true, x: 540, y: 400, w: 800, h: 800 }, o);
  const W = 1080;

  function box(L) { const b = boxOf(L), s = L.s || 1, w = b.w * s, h = b.h * s; return { w, h, l: L.x - w / 2, r: L.x + w / 2, t: L.y - h / 2, b: L.y + h / 2 }; }
  function put(L, o) {
    const b = box(L);
    if (o.l != null) L.x = o.l + b.w / 2; if (o.r != null) L.x = o.r - b.w / 2; if (o.cx != null) L.x = o.cx;
    if (o.t != null) L.y = o.t + b.h / 2; if (o.b != null) L.y = o.b - b.h / 2; if (o.cy != null) L.y = o.cy;
    return L;
  }
  /* things one under another, lined up on one side, from a top, a bottom or a middle */
  function col(items, o) {
    const list = items.filter(Boolean);
    const gap = o.gap == null ? 6 : o.gap;
    const total = list.reduce((a, L) => a + box(L).h, 0) + gap * Math.max(0, list.length - 1);
    let y = o.t != null ? o.t : o.b != null ? o.b - total : (o.cy || 0) - total / 2;
    list.forEach((L) => { const q = { t: y }; if (o.l != null) q.l = o.l; else if (o.r != null) q.r = o.r; else q.cx = o.cx; put(L, q); y = box(L).b + gap; });
    list.top = list.length ? box(list[0]).t : y; list.bottom = y - gap;
    return list;
  }
  /* the lines of a title, each set exactly as wide as the block — the stacked look */
  function stackLines(lines, o) {
    return col(lines.filter(Boolean).map((ln, i, a) => T(Object.assign({ name: (o.name || 'Title') + (a.length > 1 ? ' ' + (i + 1) : ''), text: ln, fit: o.fit, maxH: o.maxH }, o.style || {}))),
      { t: o.t, b: o.b, cx: o.cx == null ? 540 : o.cx, gap: o.gap == null ? 12 : o.gap });
  }
  /* a tilted block keeps its lines on the tilt */
  function tilt(list, deg) {
    if (!list.length) return list;
    const yc = (box(list[0]).t + box(list[list.length - 1]).b) / 2, k = Math.tan((-deg * Math.PI) / 180);
    list.forEach((L) => { L.rot = deg; L.x += (L.y - yc) * k; });
    return list;
  }
  /* a rounded label with text in it; place(cx, cy) puts it */
  function pill(lines, o) {
    const ts = lines.filter((l) => l && l.text).map((l) => T(Object.assign({ name: (o.name || 'Label') + ' text', fill: o.ink || '#141414', line: 1 }, l)));
    const padX = o.padX == null ? 22 : o.padX, padY = o.padY == null ? 14 : o.padY, gap = o.gap == null ? 4 : o.gap;
    let w = Math.max(o.minW || 0, ...ts.map((t) => box(t).w)) + padX * 2;
    let h = ts.reduce((a, t) => a + box(t).h, 0) + gap * Math.max(0, ts.length - 1) + padY * 2;
    if (o.circle) w = h = Math.max(w, h);
    const bg = SH({ name: o.name || 'Label', shape: o.circle ? 'circle' : o.shape || 'round', radius: o.radius == null ? 14 : o.radius, fill: o.fill, w, h, shadow: !!o.shadow, rot: o.rot || 0 });
    const g = [bg, ...ts];
    g.w = w; g.h = h;
    g.place = (cx, cy) => {
      bg.x = cx; bg.y = cy; col(ts, { cx, cy, gap });
      if (o.rot) { const a = (o.rot * Math.PI) / 180; ts.forEach((t) => { const dx = t.x - cx, dy = t.y - cy; t.x = cx + dx * Math.cos(a) - dy * Math.sin(a); t.y = cy + dx * Math.sin(a) + dy * Math.cos(a); t.rot = o.rot; }); }
      return g;
    };
    return g;
  }
  /* things side by side, centred */
  function hrow(gs, cx, cy, gap) {
    const list = gs.filter(Boolean).map((g) => (g.place ? g : Object.assign([g], { w: box(g).w, h: box(g).h, place: (x, y) => { put(g, { cx: x, cy: y }); return [g]; } })));
    const total = list.reduce((a, g) => a + g.w, 0) + gap * Math.max(0, list.length - 1);
    let x = cx - total / 2; const out = [];
    list.forEach((g) => { g.place(x + g.w / 2, cy); out.push(...g); x += g.w + gap; });
    return out;
  }
  function venueGroup(text, color, maxW, o) {
    o = o || {};
    const pin = SH({ name: 'Pin', shape: 'pin', fill: color, w: 32, h: 32 });
    const t = T({ name: 'Venue', text, upper: true, font: 'Montserrat', size: o.size || 16, align: 'left', line: 1.2, maxW, fill: o.ink || '#ffffff', shadow: o.shadow !== false });
    const tb = box(t), g = [pin, t];
    g.w = 40 + tb.w; g.h = Math.max(32, tb.h);
    g.place = (cx, cy) => { const l = cx - g.w / 2; pin.x = l + 15; pin.y = cy; put(t, { l: l + 40, cy }); return g; };
    return g;
  }
  /* the details row: date | time | where, with hairlines between */
  function infoRow(D, cy, cells, o) {
    o = o || {};
    const ink = o.ink || '#ffffff', acc = o.accent || D.pal.accent, out = [];
    const cols = cells.filter((c) => c && (c.big || c.small)).map((c) => {
      const items = [];
      if (c.big) items.push(T({ name: c.name || 'Detail', text: c.big, font: c.font || 'Anton', size: c.size || 50, fill: c.accent ? acc : ink, align: 'left', line: 0.95, upper: true, maxW: c.maxW || 340, shadow: true }));
      if (c.small) items.push(T({ name: (c.name || 'Detail') + ' note', text: c.small, font: 'Montserrat', size: c.smallSize || 16, fill: ink, align: 'left', line: 1.22, upper: true, maxW: c.maxW || 320, letter: 0.02, shadow: true }));
      return { c, items, w: Math.max(...items.map((L) => box(L).w)) + (c.pin ? 42 : 0) };
    });
    if (!cols.length) return out;
    const gap = o.gap || 28;
    const total = cols.reduce((a, k) => a + k.w, 0) + gap * 2 * (cols.length - 1);
    let x = (o.cx || 540) - total / 2;
    cols.forEach((k, i) => {
      let lx = x;
      if (k.c.pin) { out.push(SH({ name: 'Pin', shape: 'pin', fill: acc, x: lx + 15, y: cy, w: 32, h: 32 })); lx += 42; }
      out.push(...col(k.items, { l: lx, cy, gap: 6 }));
      x += k.w;
      if (i < cols.length - 1) { out.push(SH({ name: 'Divider', shape: 'line', fill: rgba(ink, 0.6), x: x + gap, y: cy, w: 2, h: o.lineH || 70 })); x += gap * 2; }
    });
    return out;
  }
  /* up to `max` lines, the long words alone */
  function stack(title, max = 3) {
    const w = String(title || '').trim().split(/\s+/).filter(Boolean);
    if (w.length <= max) return w;
    const lines = []; let cur = '';
    const target = Math.ceil(w.join(' ').length / max);
    for (const word of w) { if (cur && (cur + ' ' + word).length > target && lines.length < max - 1) { lines.push(cur); cur = word; } else cur = cur ? cur + ' ' + word : word; }
    if (cur) lines.push(cur);
    return lines;
  }
  /* a title in two balanced lines */
  function twoLines(s) {
    const w = String(s || '').trim().split(/\s+/).filter(Boolean);
    if (w.length <= 1) return [w[0] || '', ''];
    let best = 1, diff = 1e9;
    for (let i = 1; i < w.length; i++) { const d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i).join(' ').length); if (d < diff) { diff = d; best = i; } }
    return [w.slice(0, best).join(' '), w.slice(best).join(' ')];
  }
  /* "Glory to Glory" → GLORY [to] GLORY: the little word between two big ones */
  const CONN = /^(to|of|the|for|and|&|in|on|at|by|with|from|into|unto|is)$/i;
  function splitConnector(title) {
    const w = String(title || '').trim().split(/\s+/);
    if (w.length < 3) return null;
    let best = -1, bd = 1e9;
    for (let i = 1; i < w.length - 1; i++) if (CONN.test(w[i])) { const d = Math.abs(w.slice(0, i).join(' ').length - w.slice(i + 1).join(' ').length); if (d < bd) { bd = d; best = i; } }
    return best < 0 ? null : { a: w.slice(0, best).join(' '), conn: w[best], b: w.slice(best + 1).join(' ') };
  }
  /* "Bishop David Richman" → Bishop + David Richman */
  const HON = /^((?:rt\.?\s+)?(?:rev(?:erend|d)?\.?\s+)?(?:dr\.?\s+)?(?:arch\s*bishop|bishop|apostle|prophet(?:ess)?|pastor|pst\.?|rev(?:erend|d)?\.?|evang(?:elist)?\.?|dr\.?|min(?:ister)?\.?|elder|deacon(?:ess)?|bro(?:ther)?\.?|sis(?:ter)?\.?|mrs?\.?|ms\.?|prof\.?))\s+/i;
  function nameParts(n) { const s = String(n || '').trim(); const m = HON.exec(s); return m && s.length > m[0].length ? { title: m[1], name: s.slice(m[0].length) } : { title: '', name: s }; }
  /* the address as a flyer prints it: not the church's name again, three parts at most */
  function venueParts(D) {
    let parts = String(D.f.venue || '').split(/\s*,\s*/).filter(Boolean);
    const ch = String(D.f.church || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (parts.length > 1 && ch && parts[0].toLowerCase().replace(/[^a-z0-9]+/g, '') === ch) parts = parts.slice(1);
    return parts.slice(0, 3);
  }
  const venueText = (D) => venueParts(D).join(', ');
  const venueLines = (D, n) => { const p = venueParts(D); if (p.length <= n) return p.join(',\n'); return [p.slice(0, p.length - n + 1).join(', ')].concat(p.slice(p.length - n + 1)).join(',\n'); };
  const spsOf = (D) => D.sp.filter((s) => imgOf(s.img));
  const sp0 = (D) => spsOf(D)[0] || null;
  // backlit in the flyer's colour, softly — a white line round a person reads as a sticker
const lit = (p) => ({ glow: rgba(p.accent, 0.28), rim: rgba(mix(p.accent, '#ffffff', 0.35), 0.55), rimW: 1.1, tint: { color: p.accent, a: 0.28, fall: 0.35 } });
  /* titles that stand off the page: chrome or gold, bevelled, on a deep block with a dark edge */
  const CHROME = { stops: ['#ffffff', '#ffffff', '#eceff3', '#d5dae1'], angle: 90 };
  const GOLD = { stops: ['#fff6c7', '#ffe066', '#f5b301', '#ffd84d', '#c97a00'], angle: 90 };
  // refined, not WordArt: a shallow block in the flyer's own dark colour, a soft light on top, a real shadow
  const solid3d = (p, o) => Object.assign({ extrude: 3, extrudeColor: [mix(p.deep, '#000000', 0.25), mix(p.deep, '#000000', 0.6)], bevel: 0.55, shadow: true }, o || {});
  function footerWords(f) {
    const k = String((f.kind || '') + ' ' + (f.title || '')).toLowerCase();
    if (/prayer|vigil|fast/.test(k)) return 'PRAYER   |   PRAISE   |   POWER';
    if (/bible|word|study|teach/.test(k)) return 'STUDY   |   GROW   |   GO';
    if (/miracle|healing|crusade|revival/.test(k)) return 'MIRACLES   |   SIGNS   |   WONDERS';
    return 'PRAISE   |   WORSHIP   |   WORD';
  }

  /*
   * THE PERSON, FRAMED. `mode` says how much of them: bust (head and
   * shoulders), chest, waist, or full. The frame is worked out from where the
   * head and shoulders are in THIS photo, so a full-length stage photo and a
   * studio portrait both come out with the face the same size.
   */
  function frameOf(m, mode) {
    const u = Math.max(12, m.sy - m.top);
    let nb;
    if (mode === 'full') nb = m.h;
    else if (mode === 'waist') nb = m.hy ? m.hy + u * 0.25 : m.sy + u * 2.4;
    else if (mode === 'chest') nb = m.wy ? clamp(m.wy + u * 0.12, m.sy + u * 0.95, m.sy + u * 1.25) : m.sy + u * 1.2;
    else nb = m.sy + u * 0.9;
    // never down into a lectern's glass (cleanBottom): framed tighter, the cut melting into shadow
    if (m.clean && mode !== 'full') nb = Math.min(nb, Math.max(m.sy + u * 0.45, m.clean));
    return { t: Math.max(0, m.top - u * 0.06), nb, cx: m.cx };
  }
  let PAINTED = false;   // buildScene: the preacher is painted into the picture itself — no cut-out on top
  function hero(sp, o) {
    if (PAINTED) return null;
    const im = imgOf(sp.img); if (!im) return null;
    const m = META.get(sp.img) || quickMeta(im);
    const mode = o.mode || 'waist', fr = frameOf(m, mode);
    const k = (o.b - o.t) / Math.max(1, fr.nb - fr.t);
    const vb = Math.min(m.h, fr.nb);
    const h = (vb - fr.t) * k, w = m.w * k;
    const whole = mode === 'full' && vb >= m.h - 2;
    // a wide photo (arms out, a second person's shoulder) is moved over rather than run into the words beside it
    let X = o.cx + (m.w / 2 - fr.cx) * k;
    if (o.maxR != null) X = Math.min(X, o.maxR - w / 2);
    if (o.minL != null) X = Math.max(X, o.minL + w / 2);
    return IM(Object.assign({
      img: sp.img, name: sp.name || 'Speaker', speaker: sp.id || '', photo: sp.photo || '',
      src: { x: 0, y: fr.t / m.h, w: 1, h: (vb - fr.t) / m.h },
      w, h, x: X, y: o.t + h / 2,
      fade: whole ? 0 : Math.max(o.fade == null ? 0.22 : o.fade, mode === 'chest' ? 0.34 : 0), feather: 1.4,
      frame: { mode, t: o.t, b: o.b, cx: o.cx },
    }, o.extra || {}));
  }
  /* a person on a rounded card (head and shoulders), for a small portrait */
  function card(sp, o, p) {
    if (PAINTED) return [];
    const im = imgOf(sp.img); if (!im) return [];
    const m = META.get(sp.img) || quickMeta(im);
    const fr = frameOf(m, 'chest'), vb = Math.min(m.h, fr.nb);
    const k = (o.h * 0.92) / Math.max(1, vb - fr.t);
    const sw = o.w / k, sh = o.h / k, sx = fr.cx - sw / 2, sy = vb - sh;
    return [
      SH({ name: 'Card', shape: 'round', radius: 18, fill: { stops: [mix(p.mid, '#ffffff', 0.2), p.deep], angle: 90 }, shadow: true, x: o.l + o.w / 2, y: o.t + o.h / 2, w: o.w, h: o.h }),
      IM({ img: sp.img, name: sp.name || 'Speaker', speaker: sp.id || '', photo: sp.photo || '', src: { x: sx / m.w, y: sy / m.h, w: sw / m.w, h: sh / m.h }, radius: 18, x: o.l + o.w / 2, y: o.t + o.h / 2, w: o.w, h: o.h }),
    ];
  }
  /*
   * THE CHURCH'S LOGO, AS IT IS — never cut out. A logo with a background of
   * its own sits in a white disc, the way a church's emblem sits on the flyers
   * it likes; one that is already see-through goes on as it is.
   */
  const opaqueOf = new WeakMap();
  function isOpaque(im) {
    if (opaqueOf.has(im)) return opaqueOf.get(im);
    let o = true;
    try {
      const c = canvas(24, 24), x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(im, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data;
      for (const [px, py] of [[0, 0], [23, 0], [0, 23], [23, 23], [12, 0], [0, 12], [23, 12], [12, 23]]) if (d[(py * 24 + px) * 4 + 3] < 200) { o = false; break; }
    } catch (e) { o = true; }
    opaqueOf.set(im, o);
    return o;
  }
  function logoLayers(D, cx, cy, size) {
    const im = imgOf(D.logo); if (!im) return [];
    if (!isOpaque(im)) { const h = size, w = Math.min(size * 2.6, h * iw(im) / ih(im)); return [IM({ img: D.logo, name: 'Logo', x: cx, y: cy, w, h })]; }
    const d = size, f = Math.min(d * 0.7 / iw(im), d * 0.7 / ih(im));
    return [SH({ name: 'Logo disc', shape: 'circle', fill: '#ffffff', shadow: true, x: cx, y: cy, w: d, h: d }), IM({ img: D.logo, name: 'Logo', x: cx, y: cy, w: iw(im) * f, h: ih(im) * f })];
  }
  /* logo and church name: top left, or centred */
  function header(D, o) {
    o = o || {};
    const out = [];
    if (o.center) {
      let y = o.t || 40;
      if (D.logo && imgOf(D.logo)) { out.push(...logoLayers(D, 540, y + 38, 76)); y += 86; }
      if (D.f.church) { const t = put(T({ name: 'Church', text: D.f.church, upper: true, font: 'Montserrat', size: 21, letter: 0.06, shadow: true, maxW: 760 }), { cx: 540, t: y }); out.push(t); y = box(t).b + 12; }
      out.bottom = y;
      return out;
    }
    let x = 60; const cy = o.cy || 78;
    if (D.logo && imgOf(D.logo)) { const ls = logoLayers(D, 0, cy, 76); const w = Math.max(...ls.map((l) => l.w)); ls.forEach((l) => { l.x = x + w / 2; }); out.push(...ls); x += w + 14; }
    if (D.f.church) {
      const name = D.f.church.length > 20 ? twoLines(D.f.church).filter(Boolean).join('\n') : D.f.church;
      out.push(put(T({ name: 'Church', text: name, upper: true, font: 'Montserrat', size: 21, align: 'left', line: 1.12, letter: 0.03, shadow: true, maxW: o.maxW || 420 }), { l: x, cy }));
    }
    out.bottom = cy + 40;
    return out;
  }

  /* "Ministering" in script over the name in bold capitals, the title above it small */
  function nameTag(sp, o) {
    const np = nameParts(sp.name || ''), al = o.align || 'left', p = o.p;
    const items = [
      o.script && T({ name: 'Ministering', text: o.script, font: 'Great Vibes', size: o.scriptSize || 46, fill: o.scriptFill || p.accent, align: al, shadow: true }),
      np.title && T({ name: 'Speaker title', text: np.title, upper: true, font: 'Montserrat', size: o.titleSize || 18, letter: 0.18, align: al, shadow: true, fill: o.ink || '#ffffff' }),
      T({ name: 'Speaker', text: np.name, upper: true, font: o.font || 'Anton', size: o.size || 46, align: al, line: 0.95, shadow: true, maxW: o.maxW || 420, fill: o.ink || '#ffffff' }),
    ];
    const pos = { gap: o.gap == null ? 2 : o.gap }; if (o.t != null) pos.t = o.t; else pos.b = o.b;
    if (al === 'left') pos.l = o.l; else if (al === 'right') pos.r = o.r; else pos.cx = o.cx;
    return col(items, pos);
  }

  const LAYOUTS = {
    /* ── GLORY: two enormous lines, a little tag between, the preacher in front of them ── */
    glory(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 18, sat: 10, keep: 0.1, topShade: 0.5, bottomShade: 0.92, bottomFrom: 0.6, vignette: 0.45,
        colorWash: [{ radial: true, x: 0.5, y: 0.45, r: 0.6, stops: [rgba(p.mid, 0.9), rgba(p.deep, 0)], mode: 'screen', a: 0.5 }] }));
      L.push(FX({ kind: 'beams', x: 540, y: H * 0.45, w: 1000, h: H * 0.5, n: 3, seed: 6, color: p.accent, opacity: 0.55 }));
      L.push(FX({ kind: 'streak', x: 540, y: H * 0.3, w: 2000, h: 190, rot: -13, opacity: 0.7 }));
      L.push(FX({ kind: 'glow', x: 560, y: H * 0.55, w: 900, h: 800, opacity: 0.45 }));
      L.push(...header(D));
      const sc = splitConnector(f.title);
      const lines = sc ? [sc.a, sc.b] : twoLines(f.title || 'Glory to Glory').filter(Boolean);
      const ts = stackLines(lines, { t: H * 0.13, fit: 940, maxH: H * (lines.length === 1 ? 0.3 : sp ? 0.21 : 0.25), gap: sc ? 66 : 18,
        style: solid3d(p, { font: 'Anton', upper: true, fill: CHROME, extrude: 3 }) });
      L.push(...ts);
      if (sc && ts.length === 2) {
        const g = pill([{ text: sc.conn.charAt(0).toUpperCase() + sc.conn.slice(1), font: 'Barlow Italic', size: 50 }], { fill: p.accent, ink: '#141414', radius: 0, padX: 16, padY: 9 });
        L.push(...g.place(540, (box(ts[0]).b + box(ts[1]).t) / 2));
      }
      if (sp) { const lb = box(ts[ts.length - 1]); L.push(hero(sp, { cx: 560, t: Math.max(lb.t + lb.h * 0.15, H * 0.3), b: H + 30, mode: 'chest', fade: 0.3, extra: lit(p) })); }
      L.push(...col([f.time && T({ name: 'Time', text: f.time, font: 'Barlow Italic', size: 72, align: 'left', shadow: true }),
        d && T({ name: 'Date', text: `${d.day3}, ${d.mon3} ${d.ddn}`, font: 'Barlow Italic', size: 40, align: 'left', shadow: true }),
        d && T({ name: 'Year', text: d.year, font: 'Barlow Italic', size: 40, align: 'left', shadow: true })], { l: 70, b: H - 122, gap: 4 }));
      if (sp && sp.name) {
        const np = nameParts(sp.name);
        L.push(...col([np.title && T({ name: 'Speaker title', text: np.title, font: 'Great Vibes', size: 64, align: 'right', shadow: true }),
          T({ name: 'Speaker', text: twoLines(np.name).filter(Boolean).join('\n'), upper: true, font: 'Barlow Italic', size: 44, line: 0.95, align: 'right', shadow: true, maxW: 320 })], { r: 1010, b: H - 122, gap: -6 }));
      }
      if (f.theme && f.theme.length <= 28) { const v = T({ name: 'Theme', text: f.theme, font: 'Great Vibes', size: 54, fill: rgba('#ffffff', 0.85), rot: -90, maxW: H * 0.42 }); v.x = 50; v.y = H * 0.48; L.push(v); }
      const vt = venueText(D);
      if (vt) {
        L.push(SH({ name: 'Address bar', shape: 'rect', fill: p.accent, x: 540, y: H - 58, w: 960, h: 62 }));
        L.push(put(T({ name: 'Venue', text: vt, upper: true, font: 'Barlow Italic', size: 27, fill: '#141414', maxW: 910 }), { cx: 540, cy: H - 58 }));
      }
      return L;
    },

    /* ── FIRE: PUSH / 6 HOURS PRAYER WATCH — a burning italic title, the preacher in front ── */
    fire(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 22, sat: 20, keep: 0.12, topShade: 0.45, bottomShade: 0.9, bottomFrom: 0.62, vignette: 0.4,
        colorWash: [{ stops: [p.mid, p.accent], angle: 90, mode: 'overlay', a: 0.5 }] }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.52, w: 1100, h: 900, opacity: 0.6 }));
      L.push(FX({ kind: 'sparks', x: 540, y: H * 0.55, w: 1080, h: H * 0.9, n: 110, seed: 5, opacity: 0.9 }));
      L.push(...header(D));
      let y = H * 0.155;
      if (f.theme) {
        const k = put(T({ name: 'Theme label', text: 'THEME:', font: 'Montserrat', size: 16, letter: 0.14 }), { cx: 540, t: y });
        const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Anton', size: 46, shadow: true, maxW: 960, letter: 0.03 }), { cx: 540, t: box(k).b + 8 });
        L.push(k, th); y = box(th).b + 20;
      }
      const lines = stack(f.title || 'Push', 3), n = lines.length;
      const ts = stackLines(lines, { t: y, fit: 990, maxH: H * (n === 1 ? 0.26 : n === 2 ? 0.16 : 0.12), gap: 8,
        style: solid3d(p, { font: 'Barlow Italic', upper: true, fill: CHROME, grain: true, extrude: 3, extrudeColor: [mix(p.mid, '#000000', 0.3), mix(p.deep, '#000000', 0.6)], glow: rgba(p.accent, 0.45) }) });
      L.push(...ts);
      if (sp) { const lb = box(ts[ts.length - 1]); L.push(hero(sp, { cx: 540, t: Math.max(lb.t + lb.h * 0.1, y + (ts.bottom - y) * 0.4), b: H - 40, mode: 'chest', fade: 0.3, extra: lit(p) })); }
      if (d) L.push(...col([d.day3, d.ddth, d.month, d.year].map((s, i) => T({ name: 'Date ' + (i + 1), text: s, font: 'Barlow Italic', size: 56, line: 0.9, fill: { stops: ['#ffffff', mix(p.accent, '#ffffff', 0.45)], angle: 90 }, align: 'left', shadow: true, edge: 2.4, edgeColor: mix(p.deep, '#000000', 0.55) })), { l: 62, t: H * 0.6, gap: -2 }));
      L.push(...col([f.time && T({ name: 'Time', text: f.time, font: 'Anton', size: 66, align: 'right', shadow: true }), f.time2 && T({ name: 'Time 2', text: f.time2, font: 'Anton', size: 42, align: 'right', shadow: true })], { r: 1016, t: H * 0.6, gap: 6 }));
      if (sp && sp.name) {
        const np = nameParts(sp.name);
        L.push(...col([T({ name: 'Ministering', text: 'MINISTERING', font: 'Montserrat', size: 15, letter: 0.18, align: 'right', shadow: true }),
          T({ name: 'Speaker', text: (np.title ? np.title + '\n' : '') + np.name, upper: true, font: 'Anton', size: 34, line: 1.0, align: 'right', shadow: true, maxW: 300 })], { r: 1016, b: H - 168, gap: 6 }));
      }
      const vt = venueText(D);
      if (vt) L.push(put(T({ name: 'Venue', text: vt, upper: true, font: 'Anton', size: 34, shadow: true, maxW: 980, line: 1.05 }), { cx: 540, b: H - 44 }));
      return L;
    },

    /* ── ENCOUNTER: the ministers in the light, the title across them, the details on labels ── */
    encounter(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [];
      L.push(BG({ img: D.bg, grade: 'bright', contrast: 8, keep: 0.2, topShade: 0.45, bottomShade: 0.95, bottomFrom: 0.48, vignette: 0.35 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.3, w: 1300, h: 1000, opacity: 0.6 }));
      L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.35, w: 1080, h: H * 0.6, n: 26, seed: 3, opacity: 0.7 }));
      L.push(...header(D));
      L.push(put(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 19, letter: 0.9, shadow: true }), { cx: 540, t: H * 0.14 }));
      const ps = spsOf(D).slice(0, 3), n = ps.length, pb = H * 0.8;
      if (n === 1) L.push(hero(ps[0], { cx: 540, t: H * 0.17, b: H * 0.86, mode: 'chest', fade: 0.3, extra: lit(p) }));
      if (n === 2) L.push(hero(ps[1], { cx: 770, t: H * 0.23, b: pb, mode: 'chest', extra: lit(p) }), hero(ps[0], { cx: 320, t: H * 0.21, b: pb, mode: 'chest', extra: lit(p) }));
      if (n === 3) L.push(hero(ps[1], { cx: 220, t: H * 0.27, b: pb, mode: 'chest', extra: lit(p) }), hero(ps[2], { cx: 860, t: H * 0.27, b: pb, mode: 'chest', extra: lit(p) }), hero(ps[0], { cx: 540, t: H * 0.2, b: pb, mode: 'chest', extra: lit(p) }));
      const ts = stackLines(twoLines(f.title || 'Worship Encounter').filter(Boolean), { t: H * (n ? 0.57 : 0.36), fit: 880, maxH: H * (n ? 0.115 : 0.16), gap: 6,
        style: solid3d(p, { font: 'Anton', fill: CHROME, extrude: 3, glow: rgba(p.accent, 0.4) }) });
      L.push(...ts);
      let y = ts.bottom + 18;
      if (f.theme) { const th = put(T({ name: 'Theme', text: 'Theme: ' + f.theme, font: 'DM Serif', size: 34, maxW: 920, shadow: true }), { cx: 540, t: y }); L.push(th); y = box(th).b + 12; }
      if (f.extra) {
        const ex = put(T({ name: 'Scripture', text: f.extra, font: 'Montserrat', size: 20, maxW: 560, letter: 0.04, shadow: true }), { cx: 540, t: y }); const b = box(ex);
        L.push(SH({ name: 'Line', shape: 'line', fill: rgba('#ffffff', 0.7), x: b.l - 74, y: b.t + b.h / 2, w: 110, h: 2 }), SH({ name: 'Line', shape: 'line', fill: rgba('#ffffff', 0.7), x: b.r + 74, y: b.t + b.h / 2, w: 110, h: 2 }), ex);
      }
      const items = [];
      if (d) items.push(pill([{ text: `${d.day3}, ${d.ddth}`, font: 'Anton', size: 32 }, { text: `${d.month} ${d.year}`, font: 'Montserrat', size: 15 }], { fill: p.accent, ink: '#161616', radius: 12, padX: 20, padY: 12 }));
      if (f.time) items.push(pill([{ text: f.time, font: 'Anton', size: 38 }, { text: f.time2 ? 'AND ' + f.time2 : 'PROMPT', font: 'Montserrat', size: 13 }], { fill: p.accent, ink: '#161616', radius: 12, padX: 20, padY: 12 }));
      if (venueText(D)) items.push(venueGroup(venueLines(D, 3), p.accent, 320));
      L.push(...hrow(items, 540, H - 86, 20));
      return L;
    },

    /* ── SPOTLIGHT (Miracle Service): the minister lit from behind, a wide title below ── */
    miracle(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [];
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 15, sat: 15, keep: 0.12, topShade: 0.35, bottomShade: 0.96, bottomFrom: 0.55, vignette: 0.45 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.32, w: 1050, h: 950, opacity: 0.65 }));
      L.push(FX({ kind: 'ring', x: 540, y: H * 0.26, w: 560, h: 560, color: p.accent, opacity: 0.55 }));
      L.push(FX({ kind: 'sparks', x: 540, y: H * 0.45, w: 1080, h: H * 0.8, n: 60, seed: 9, opacity: 0.75 }));
      L.push(...header(D));
      if (f.handles) L.push(put(T({ name: 'Handles', text: f.handles, font: 'Montserrat', size: 16, align: 'right', maxW: 360, shadow: true }), { r: 1016, cy: 78 }));
      const ps = spsOf(D);
      if (ps[1]) L.push(hero(ps[1], { cx: 200, t: H * 0.25, b: H * 0.7, mode: 'chest', extra: lit(p) }));
      if (ps[2]) L.push(hero(ps[2], { cx: 880, t: H * 0.25, b: H * 0.7, mode: 'chest', extra: lit(p) }));
      if (ps[0]) L.push(hero(ps[0], { cx: 540, t: H * 0.1, b: H * 0.76, mode: 'chest', fade: 0.3, extra: lit(p) }));
      const ws = String(f.title || 'Miracle Service').trim().split(/\s+/);
      const big = ws.length > 1 ? ws.slice(0, -1).join(' ') : ws[0], small = ws.length > 1 ? ws[ws.length - 1] : '';
      const t1 = put(T(Object.assign({ name: 'Title', text: big, upper: true, font: 'Archivo Black', fit: 960, maxH: H * (ps.length ? 0.11 : 0.15) }, solid3d(p, { fill: CHROME, extrude: 3, glow: rgba(p.accent, 0.35) }))), { cx: 540, t: H * (ps.length ? 0.66 : 0.42) });
      L.push(t1);
      let y = box(t1).b + 18;
      if (small) { const t2 = put(T({ name: 'Subtitle', text: small.toUpperCase().split('').join(' '), font: 'Montserrat', size: 40, letter: 0.3, fit: Math.min(880, box(t1).w * 0.9), maxH: 34, shadow: true }), { cx: 540, t: y }); L.push(t2); y = box(t2).b + 16; }
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, font: 'Alex Brush', size: 58, fill: p.accent, maxW: 900, shadow: true }), { cx: 540, t: y }); L.push(th); y = box(th).b + 10; }
      L.push(...infoRow(D, Math.min(H - 92, Math.max(y + 56, H * 0.88)), [
        d && { name: 'Date', big: `${d.day3}. ${d.ddth}`, small: `${d.month}, ${d.year}`, size: 40 },
        f.time && { name: 'Time', big: f.time, small: f.time2 ? 'AND ' + f.time2 : 'PROMPT', size: 54, accent: true },
        venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 300, smallSize: 15 }]));
      L.push(put(T({ name: 'Footer', text: footerWords(f), font: 'Montserrat', size: 13, letter: 0.4, fill: rgba('#ffffff', 0.75), maxW: 980 }), { cx: 540, b: H - 22 }));
      return L;
    },

    /* ── BIBLE STUDY: a gold serif title with a red JOIN US tab, the teacher below ── */
    bible(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'dark', bright: -4, contrast: 14, keep: 0.25, topShade: 0.5, bottomShade: 0.95, bottomFrom: 0.5, vignette: 0.6 }));
      L.push(FX({ kind: 'glow', x: 260, y: H * 0.2, w: 900, h: 760, opacity: 0.4 }));
      const hd = header(D, { center: true, t: 32 }); L.push(...hd);
      const pr = put(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 15, letter: 1.0, shadow: true }), { cx: 540, t: hd.bottom }); L.push(pr);
      const ts = stackLines(twoLines(f.title || 'Bible Study').filter(Boolean), { t: box(pr).b + 18, cx: 600, fit: 740, maxH: H * (sp ? 0.13 : 0.17), gap: 4,
        style: solid3d(p, { font: 'Abril Fatface', fill: GOLD, extrude: 3, extrudeColor: ['#5a3300', '#1f1000'], edgeColor: '#1f1000', glow: rgba('#ffcf33', 0.3) }) });
      L.push(...ts);
      const tT = box(ts[0]).t, tB = ts.bottom, tl = Math.min(...ts.map((t) => box(t).l));
      L.push(SH({ name: 'Join tab', shape: 'rect', fill: '#d71920', x: tl - 52, y: (tT + tB) / 2, w: 62, h: tB - tT + 8, shadow: true }));
      const jt = T({ name: 'Join us', text: 'JOIN US', font: 'Anton', size: 40, rot: -90, maxW: tB - tT - 16 }); jt.x = tl - 52; jt.y = (tT + tB) / 2; L.push(jt);
      const y = tB + 28; let cb = y;
      if (d || f.time) {
        const dc = col([d && T({ name: 'Day', text: `${d.day3}. ${d.ddn}`, font: 'Anton', size: 46, align: 'right', shadow: true }), d && T({ name: 'Month', text: d.month, font: 'Anton', size: 46, align: 'right', shadow: true })], { r: 574, t: y, gap: 4 });
        const tc = col([f.time && T({ name: 'Time', text: f.time, font: 'Anton', size: 46, fill: p.accent, align: 'left', shadow: true, edge: 2.2, edgeColor: mix(p.deep, '#000000', 0.55) }), f.time2 && T({ name: 'Time 2', text: f.time2, font: 'Anton', size: 46, fill: p.accent, align: 'left', shadow: true, edge: 2.2, edgeColor: mix(p.deep, '#000000', 0.55) }), !f.time2 && T({ name: 'Prompt', text: 'PROMPT', font: 'Montserrat', size: 18, letter: 0.2, align: 'left', shadow: true })], { l: 626, t: y, gap: 6 });
        cb = Math.max(dc.bottom, tc.bottom);
        L.push(...dc, ...tc, SH({ name: 'Divider', shape: 'line', fill: rgba('#ffffff', 0.75), x: 600, y: (y + cb) / 2, w: 3, h: cb - y }));
      }
      if (sp) L.push(hero(sp, { cx: 500, t: Math.max(cb + 20, H * 0.4), b: H - 40, mode: 'chest', fade: 0.25, extra: lit(p) }));
      if (sp && sp.name) {
        const np = nameParts(sp.name);
        const g = pill([{ text: 'with', font: 'Great Vibes', size: 40 }, { text: (np.title ? np.title + '\n' : '') + np.name, upper: true, font: 'Anton', size: 34, line: 0.98, fill: '#c81e1e', maxW: 230 }], { fill: '#ffd21f', ink: '#141414', radius: 18, rot: -4, shadow: true, padX: 22, padY: 14, gap: 2 });
        L.push(...g.place(860, H - 290));
      }
      const vt = venueText(D);
      if (vt) L.push(put(T({ name: 'Venue', text: vt, upper: true, font: 'Montserrat', size: 18, letter: 0.03, shadow: true, maxW: 980 }), { cx: 540, b: H - 26 }));
      return L;
    },

    /* ── GOLD (Night of Prophetic Prayers): a red ribbon, a blazing gold title, the details down the right ── */
    prophetic(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [];
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 14, sat: 18, keep: 0.12, topShade: 0.3, bottomShade: 0.7, bottomFrom: 0.62, vignette: 0.3,
        colorWash: [{ stops: [p.accent, p.mid], angle: 90, mode: 'overlay', a: 0.45 }] }));
      L.push(FX({ kind: 'rays', x: 540, y: -60, h: H * 1.05, n: 22, seed: 4, color: p.hi, opacity: 0.7 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.3, w: 1300, h: 900, opacity: 0.6 }));
      L.push(FX({ kind: 'sparks', x: 540, y: H * 0.6, w: 1080, h: H * 0.7, n: 70, seed: 8, opacity: 0.8 }));
      const hd = header(D, { center: true, t: 28 }); L.push(...hd);
      const m = /^((?:a\s+)?(?:night|day|days|hour|hours|evening|morning|season|week|weekend)\s+of)\s+(.+)$/i.exec(String(f.title || '').trim());
      const tag = m ? m[1] : (D.dir.kicker && D.dir.kicker.length <= 20 ? D.dir.kicker : '');
      const rest = m ? m[2] : (f.title || 'Prophetic Prayers');
      let y = hd.bottom + 22;
      if (tag) { const g = pill([{ text: tag, upper: true, font: 'Anton', size: 40 }], { fill: { stops: ['#ff3b30', '#b3000c'], angle: 90 }, ink: '#ffffff', radius: 6, padX: 22, padY: 8, rot: -6, shadow: true }); L.push(...g.place(400, y + g.h / 2)); y += g.h - 4; }
      const ts = tilt(stackLines(stack(rest, 3), { t: y, fit: 960, maxH: H * 0.155, gap: 0,
        style: { font: 'Anton', upper: true, fill: { stops: ['#fff6c2', '#ffd94a', '#f7a800', '#e88600'], angle: 90 }, extrude: 4, extrudeColor: ['#7a2600', '#3a0a00'], bevel: 0.6, glow: rgba('#ffb300', 0.4), shadow: true } }), -4);
      L.push(...ts);
      const tb = ts.bottom;
      if (f.theme) L.push(put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 23, align: 'right', maxW: 470, line: 1.12, shadow: true }), { r: 1000, t: tb + 26 }));
      const ps = spsOf(D).slice(0, 2), top = Math.max(tb + 30, H * 0.42);
      const grade = lit(p);
      if (ps[1]) L.push(hero(ps[1], { cx: 170, t: top + 70, b: H + 40, mode: 'chest', fade: 0.12, extra: grade }));
      if (ps[0]) L.push(hero(ps[0], { cx: ps[1] ? 430 : 360, t: top, b: H + 40, mode: 'chest', fade: 0.12, maxR: 700, extra: grade }));
      L.push(SH({ name: 'Floor shade', shape: 'rect', fill: { stops: [rgba(p.deep, 0), rgba(mix(p.deep, '#000000', 0.5), 0.9)], angle: 90 }, x: 540, y: H - 110, w: W, h: 220 }));
      const right = [];

      if (d) right.push(T({ name: 'Day', text: `${d.day}, ${d.year}`, upper: true, font: 'Montserrat', size: 19, letter: 0.32, align: 'right', shadow: true }),
        T({ name: 'Date', text: `${d.ddth} ${d.month}`, upper: true, font: 'Anton', size: 84, align: 'right', shadow: true, maxW: 430, fill: { stops: ['#ffffff', '#ffffff', '#ffe9a8'], angle: 90 } }));
      if (f.time) right.push(T({ name: 'Time', text: f.time, font: 'Anton', size: 84, align: 'right', shadow: true, fill: { stops: ['#ffffff', '#ffffff', '#ffe9a8'], angle: 90 } }));
      const rc = col(right, { r: 1010, b: H - 150, gap: 6 }); L.push(...rc);
      if (venueText(D)) L.push(put(T({ name: 'Venue', text: venueLines(D, 3), upper: true, font: 'Montserrat', size: 16, align: 'right', line: 1.25, maxW: 380, shadow: true }), { r: 1010, t: rc.bottom + 16 }));
      if (ps[0] && ps[0].name) L.push(...nameTag(ps[0], { l: 60, b: H - 40, align: 'left', script: 'Ministering', p }));
      return L;
    },

    /* ── GIANT WORDS (Sunday Service): the title as tall as the flyer, the preacher walking out of it ── */
    sunday(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'normal', contrast: 10, keep: 0.22, topShade: 0.45, bottomShade: 0.8, bottomFrom: 0.68, vignette: 0.35 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.45, w: 1100, h: 1100, opacity: 0.5 }));
      const kw = String(D.dir.kicker || 'Worship with us at our').toUpperCase().split(/\s+/);
      const ka = kw.slice(0, Math.ceil(kw.length / 2)).join(' '), kb = kw.slice(Math.ceil(kw.length / 2)).join(' ');
      const k1 = put(T({ name: 'Kicker', text: ka, font: 'League Gothic', size: 36, align: 'left', letter: 0.04, shadow: true }), { l: 62, cy: 62 });
      L.push(k1);
      // the church's logo always, in the middle of the line between the two kicker words
      const logo = D.logo && imgOf(D.logo) ? logoLayers(D, 540, 62, 64) : [];
      L.push(...logo);
      if (kb) {
        const k2 = put(T({ name: 'Kicker 2', text: kb, font: 'League Gothic', size: 36, align: 'right', letter: 0.04, shadow: true }), { r: 1018, cy: 62 }); L.push(k2);
        const l0 = box(k1).r + 15, l1 = box(k2).l - 15, gap = logo.length ? 52 : 0;
        if (gap) {
          L.push(SH({ name: 'Line', shape: 'line', fill: rgba('#ffffff', 0.8), x: (l0 + 540 - gap) / 2, y: 64, w: Math.max(10, 540 - gap - l0), h: 2 }));
          L.push(SH({ name: 'Line', shape: 'line', fill: rgba('#ffffff', 0.8), x: (540 + gap + l1) / 2, y: 64, w: Math.max(10, l1 - 540 - gap), h: 2 }));
        } else L.push(SH({ name: 'Line', shape: 'line', fill: rgba('#ffffff', 0.8), x: (l0 + l1) / 2, y: 64, w: Math.max(20, l1 - l0), h: 2 }));
      }
      const lines = stack(f.title || 'Sunday Service', 2), n = lines.length, top = 108, avail = H - top - (sp ? 60 : 150);
      const ts = stackLines(lines, { t: top, fit: 1000, maxH: avail / n - 14, gap: 14,
        style: { font: 'League Gothic', upper: true, stretch: 1.45, fill: { stops: ['#ffffff', mix('#ffffff', p.accent, 0.3), mix(p.accent, p.hi, 0.25)], angle: 90 }, bevel: 0.6, glow: rgba(p.accent, 0.35), shadow: true } });
      L.push(...ts);
      if (sp) L.push(hero(sp, { cx: 780, t: top + (ts.bottom - top) * 0.6, b: H + 30, mode: 'chest', minL: 330, extra: lit(p) }));
      // the details down the left: the speaker stands on the right, clear of them and of the title's second line
      L.push(...col([d && T({ name: 'Date', text: `${d.mon3}. ${d.ddth}`, font: 'Anton', size: 50, fill: p.accent, align: 'left', shadow: true, edge: 2, edgeColor: mix(p.deep, '#000000', 0.5) }), f.time && T({ name: 'Time', text: f.time, font: 'Anton', size: 50, align: 'left', shadow: true }),
        sp && sp.name && T({ name: 'Speaker', text: sp.name, upper: true, font: 'Montserrat', size: 18, align: 'left', shadow: true, maxW: 300 }),
        venueText(D) && T({ name: 'Venue', text: venueLines(D, 3), upper: true, font: 'Montserrat', size: 14, align: 'left', line: 1.22, maxW: 280, shadow: true })], { l: 62, b: H - 50, gap: 10 }));
      return L;
    },

    /* ── LINE-UP: everyone ministering, each named, under a bold title ── */
    lineup(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [];
      L.push(BG({ img: D.bg, grade: 'normal', contrast: 14, keep: 0.15, topShade: 0.5, bottomShade: 0.96, bottomFrom: 0.6, vignette: 0.45 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.55, w: 1300, h: 800, opacity: 0.55 }));
      const hd = header(D, { center: true, t: 30 }); L.push(...hd);
      const pr = put(T({ name: 'Presents', text: 'PRESENTS', font: 'Montserrat', size: 15, letter: 1.0, shadow: true }), { cx: 540, t: hd.bottom }); L.push(pr);
      const ps = spsOf(D).slice(0, 7), n = ps.length;
      const ts = stackLines(stack(f.title || 'The Power of Praise', 3), { t: box(pr).b + 14, fit: 880, maxH: H * (n ? 0.085 : 0.14), gap: 6,
        style: { font: 'Barlow Italic', upper: true, fill: { stops: [mix(p.accent, '#ffffff', 0.4), p.accent, mix(p.accent, p.mid, 0.35)], angle: 90 }, extrude: 4, extrudeColor: rgba(p.deep, 0.85), shadow: true } });
      L.push(...ts);
      let y = ts.bottom + 12;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 20, letter: 0.08, maxW: 900, shadow: true }), { cx: 540, t: y }); L.push(th); y = box(th).b; }
      if (n) {
        const mid = Math.floor((n - 1) / 2), pos = ps.map((s, i) => ({ s, j: mid + (i === 0 ? 0 : (i % 2 ? Math.ceil(i / 2) : -Math.ceil(i / 2))) }));
        const minJ = Math.min(...pos.map((q) => q.j)); pos.forEach((q) => { q.j -= minJ; });
        const cMid = (n - 1) / 2, stepX = Math.min(330, 1000 / n), baseT = Math.max(y + 90, H * 0.4), names = [];
        pos.sort((a, b) => Math.abs(b.j - cMid) - Math.abs(a.j - cMid)).forEach((q) => {
          const dist = Math.abs(q.j - cMid), cx = 540 + (q.j - cMid) * stepX, t = n === 1 ? y + 130 : baseT + dist * 30;
          // one minister alone fills the space a line of them would (not a small figure in an empty stage)
          const P = hero(q.s, { cx, t, b: n === 1 ? H + 30 : H - 80, mode: 'chest', extra: lit(p) }); if (P) L.push(P);
          if (q.s.name) { const np = nameParts(q.s.name); names.push(...col([np.title && T({ name: 'Title', text: np.title, upper: true, font: 'Montserrat', size: n === 1 ? 20 : 12, letter: 0.12, maxW: n === 1 ? 600 : stepX - 14, shadow: true }), T({ name: 'Name', text: np.name, upper: true, font: n === 1 ? 'Anton' : 'Montserrat', size: n === 1 ? 44 : 16, maxW: n === 1 ? 700 : stepX - 14, line: 1.05, shadow: true })], { cx, b: t - 10, gap: 3 })); }
        });
        L.push(...names);
      }
      L.push(...infoRow(D, H - 60, [d && { name: 'Date', big: `${d.ddth} ${d.month}, ${d.year}`, size: 30 }, venueText(D) && { name: 'Venue', small: venueLines(D, 2), pin: true, maxW: 400, smallSize: 14 }, f.time && { name: 'Time', big: f.time, size: 40, accent: true }], { lineH: 50 }));
      return L;
    },

    /* ── SCRIPT (Special Sunday Service): one word in flowing script, capitals around it ── */
    script(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 15, sat: 20, keep: 0.12, topShade: 0.35, bottomShade: 0.85, bottomFrom: 0.65, vignette: 0.35,
        colorWash: [{ stops: [p.mid, p.accent, '#ff7a00'], angle: 35, mode: 'overlay', a: 0.55 }] }));
      L.push(FX({ kind: 'streak', x: 540, y: H * 0.42, w: 1900, h: 260, rot: 22, opacity: 0.55 }));
      L.push(FX({ kind: 'glow', x: 780, y: H * 0.64, w: 900, h: 900, opacity: 0.5 }));
      const hd = header(D, { center: true, t: 30 }); L.push(...hd);
      const words = String(f.title || 'Sunday Service').trim().split(/\s+/);
      const want = String(D.script || '').toLowerCase();
      let si = words.findIndex((w) => w.toLowerCase() === want); if (si < 0) si = words.findIndex((w) => /day$/i.test(w)); if (si < 0) si = 0;
      const pre = words.slice(0, si).join(' '), word = words[si], post = words.slice(si + 1).join(' ');
      let y = hd.bottom + 4;
      const jo = put(T({ name: 'Kicker', text: 'Join Our', font: 'Great Vibes', size: 62, shadow: true }), { cx: 540, t: y }); L.push(jo); y = box(jo).b + 6;
      if (pre) { const t = put(T(Object.assign({ name: 'Title', text: pre, upper: true, font: 'Barlow Italic', fit: 700, maxH: H * 0.085 }, solid3d(p, { fill: CHROME, extrude: 3 }))), { cx: 540, t: y }); L.push(t); y = box(t).b - 6; }
      const sw = put(T({ name: 'Script word', text: word, font: 'Alex Brush', fill: { stops: ['#fffdf2', '#fff0b8', '#ffd76a'], angle: 90 }, fit: 990, maxH: H * 0.2, extrude: 4, extrudeColor: [mix(p.deep, '#000000', 0.1), mix(p.deep, '#000000', 0.6)], glow: rgba('#ffffff', 0.25), shadow: true }), { cx: 540, t: y }); L.push(sw);
      y = box(sw).b - box(sw).h * 0.2;
      if (post) { const t = put(T(Object.assign({ name: 'Title 2', text: post, upper: true, font: 'Barlow Italic', fit: 780, maxH: H * 0.11 }, solid3d(p, { fill: CHROME, extrude: 3 }))), { cx: 560, t: y }); L.push(t); y = box(t).b; }
      if (sp) L.push(hero(sp, { cx: 760, t: Math.max(y - 20, H * 0.42), b: H + 30, mode: 'chest', fade: 0.12, extra: lit(p) }));
      const lc = col([d && T({ name: 'Date', text: `${d.day3} ${d.ddth}.\n${d.mon3}, ${d.year}`, font: 'Anton', size: 50, line: 1.02, align: 'left', shadow: true })], { l: 62, t: Math.max(y + 34, H * 0.6), gap: 10 });
      L.push(...lc);
      let yy = lc.length ? lc.bottom + 22 : Math.max(y + 34, H * 0.6);
      if (f.time) { const g = pill([{ text: f.time.replace(/(AM|PM)$/, '\n$1'), font: 'Anton', size: 30, line: 0.95 }], { fill: p.accent, ink: '#ffffff', circle: true, padX: 16, padY: 16, shadow: true }); L.push(...g.place(62 + g.w / 2, yy + g.h / 2)); yy += g.h + 20; }
      if (venueText(D)) { const g = venueGroup(venueLines(D, 3), p.accent, 300, { size: 15 }); L.push(...g.place(62 + g.w / 2, yy + g.h / 2)); yy += g.h + 18; }
      if (sp && sp.name) { const np = nameParts(sp.name); L.push(...col([T({ name: 'With', text: 'with ' + (np.title || ''), font: 'Montserrat', size: 15, align: 'left', shadow: true }), T({ name: 'Speaker', text: np.name, upper: true, font: 'Montserrat', size: 26, align: 'left', shadow: true, maxW: 360 })], { l: 62, t: yy, gap: 4 })); }
      return L;
    },

    /* ── SCENIC (Doctrines of Faith): a landscape, one huge word, the preacher on a card ── */
    scenic(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'normal', contrast: 12, keep: 0.38, topShade: 0.4, bottomShade: 0.92, bottomFrom: 0.42, vignette: 0.4 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.25, w: 1200, h: 800, color: p.hi, opacity: 0.35 }));
      const hd = header(D, { center: true, t: 30 }); L.push(...hd);
      const ws = String(f.title || 'Faith').trim().split(/\s+/);
      // the word that says what it is goes big: PRAYER (meeting), BIBLE (study), SUNDAY (service) — not the generic one
      const generic = /^(meeting|service|study|night|session|fellowship|programme|program|conference|gathering|hangout|vigil)$/i;
      let big = ws.length > 1 ? ws[ws.length - 1] : ws[0], kick = ws.length > 1 ? ws.slice(0, -1).join(' ') : '';
      let below = false;
      if (ws.length === 2 && generic.test(ws[1])) { big = ws[0]; kick = ws[1]; below = true; }
      let y = H * 0.5;
      if (kick && !below) { const k = put(T({ name: 'Kicker', text: kick, upper: true, font: 'Montserrat', size: kick.length <= 8 ? 46 : 32, letter: kick.length <= 8 ? 0.6 : 0.4, shadow: true, glow: rgba('#000000', 0.55), maxW: 1000 }), { cx: 540, t: y }); L.push(k); y = box(k).b + 14; }
      const t = put(T({ name: 'Title', text: big, upper: true, font: 'Anton', fit: 1000, maxH: H * 0.2, fill: { stops: ['#ffffff', mix(p.hi, p.accent, 0.4), p.accent], angle: 90 }, grain: true, shadow: true, extrude: 3, extrudeColor: rgba(p.deep, 0.8) }), { cx: 540, t: y });
      L.push(t); y = box(t).b + 26;
      if (kick && below) { const k = put(T({ name: 'Kicker', text: kick, upper: true, font: 'Montserrat', size: 46, letter: 0.6, shadow: true, glow: rgba('#000000', 0.55), maxW: 1000 }), { cx: 540, t: y - 10 }); L.push(k); y = box(k).b + 22; }
      const cardT = Math.max(y, H - 320), cardB = H - 60, cardW = Math.min(250, (cardB - cardT) * 0.8);
      if (sp) L.push(...card(sp, { l: 66, t: cardT, w: cardW, h: cardB - cardT }, p));
      const ix = sp ? 66 + cardW + 34 : 66;
      L.push(...col([sp && sp.name && T({ name: 'With', text: 'With ' + sp.name, font: 'Great Vibes', size: 44, align: 'left', shadow: true, maxW: 1010 - ix }),
        d && T({ name: 'Date', text: `${d.day3}. ${d.ddth} ${d.month}`, font: 'Montserrat', size: 24, align: 'left', shadow: true, maxW: 1010 - ix }),
        f.time && T({ name: 'Time', text: f.time + (f.time2 ? ' & ' + f.time2 : ' Prompt'), font: 'Anton', size: 52, align: 'left', shadow: true }),
        venueText(D) && T({ name: 'Venue', text: venueLines(D, 3), font: 'Montserrat', size: 16, align: 'left', line: 1.25, maxW: 1010 - ix, shadow: true })], { l: ix, cy: (cardT + cardB) / 2, gap: 10 }));
      return L;
    },

    /* ── LIGHT (Workers' Meeting / Single Men Hangout): a bright page, a bold dark title, a script word in colour ── */
    light(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      const red = lum(p.mid) < 0.5 ? p.mid : '#c8102e', ink = '#1c1c1f';
      L.push(BG({ img: D.bg, sat: -35, bright: 34, contrast: -10, wash: 'rgba(255,250,244,.55)', grain: 0.4,
        colorWash: [{ stops: ['#ffffff', '#fff1e0', '#ffb36b', '#e8641e'], angle: 90, mode: 'soft-light', a: 0.85 },
          { radial: true, x: 0.5, y: 0.3, r: 0.6, stops: ['rgba(255,255,255,.9)', 'rgba(255,255,255,0)'], mode: 'screen', a: 0.7 }] }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.35, w: 1300, h: 800, color: '#fff3dd', opacity: 0.85 }));
      const hd = header(D, { center: true, t: 30 });
      hd.forEach((l) => { if (l.type === 'text') { l.fill = ink; l.shadow = false; } });
      L.push(...hd);
      const ws = String(f.title || 'Workers Meeting').trim().split(/\s+/);
      const scriptW = ws.length > 1 ? ws[ws.length - 1] : '', main = ws.length > 1 ? ws.slice(0, -1).join(' ') : ws[0];
      let y = hd.bottom + 18;
      if (f.extra) { const k = put(T({ name: 'Kicker', text: f.extra, upper: true, font: 'Barlow Italic', size: 34, fill: red }), { cx: 540, t: y }); L.push(k); y = box(k).b + 10; }
      const ts = stackLines(stack(main, 2), { t: y, fit: 820, maxH: H * 0.14, gap: 6, style: { font: 'Anton', upper: true, fill: { stops: ['#3a3a40', ink], angle: 90 }, shadow: false, extrude: 3, extrudeColor: rgba('#000000', 0.18) } });
      L.push(...ts); y = ts.bottom;
      if (scriptW) { const s = put(T({ name: 'Script word', text: scriptW.toLowerCase(), font: 'Yellowtail', fill: red, fit: 640, maxH: H * 0.11 }), { cx: 600, t: y - H * 0.03 }); s.rot = -6; L.push(s); y = box(s).b; }
      if (f.theme) { const th = put(T({ name: 'Theme', text: 'Theme: ' + f.theme, upper: true, font: 'Barlow Italic', size: 34, fill: ink, maxW: 820 }), { cx: 540, t: y + 14 }); L.push(th); y = box(th).b; }
      if (sp) L.push(hero(sp, { cx: 540, t: Math.max(y + 10, H * 0.38), b: H - 60, mode: 'chest', fade: 0.35, extra: { shade: 'rgba(60,30,10,.35)', tint: { color: '#ffb36b', a: 0.25, fall: 0.4 } } }));
      L.push(SH({ name: 'Info bar', shape: 'round', radius: 0, fill: { stops: [rgba('#ffffff', 0), rgba('#ffffff', 0.92)], angle: 90 }, x: 540, y: H - 90, w: W, h: 180 }));
      L.push(...infoRow(D, H - 74, [d && { name: 'Date', big: `${d.ddth} ${d.mon3}. ${d.year}`, size: 40 }, f.time && { name: 'Time', big: f.time, size: 40, accent: true }, venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 320, smallSize: 14 }], { ink, accent: red, lineH: 56 }));
      return L;
    },
  };
  const LOOK_NAMES = { glory: 'Glory', fire: 'Fire', encounter: 'Encounter', miracle: 'Spotlight', bible: 'Bible Study', prophetic: 'Gold', sunday: 'Giant words', lineup: 'Line-up', script: 'Script', scenic: 'Scenic', light: 'Light' };
  /* each look's own colours (the AI's colours go on the first few designs; these on the rest, for variety) */
  const SIGNATURE = {
    glory: { deep: '#0b0b10', mid: '#2a2140', accent: '#f6c915', hi: '#ffffff' },
    fire: { deep: '#1a0300', mid: '#c2410c', accent: '#ffb300', hi: '#fff3c4' },
    encounter: { deep: '#3a1200', mid: '#d4560b', accent: '#ffc233', hi: '#fff4d6' },
    miracle: { deep: '#1a0630', mid: '#6d1fb0', accent: '#ff8a1e', hi: '#ffe6ff' },
    bible: { deep: '#0d0804', mid: '#4a2e12', accent: '#ffcf33', hi: '#fff6dd' },
    prophetic: { deep: '#3a1800', mid: '#c77400', accent: '#ffd23f', hi: '#fff8dc' },
    sunday: { deep: '#2b1600', mid: '#b86f00', accent: '#ffd54a', hi: '#fffbe6' },
    lineup: { deep: '#2a0400', mid: '#c2260c', accent: '#ffc21a', hi: '#ffffff' },
    script: { deep: '#14063a', mid: '#5b21b6', accent: '#ff3d8b', hi: '#ffe4f2' },
    scenic: { deep: '#012a30', mid: '#0e6f7a', accent: '#7ee0d6', hi: '#ffffff' },
    light: { deep: '#3a2a1a', mid: '#c8102e', accent: '#c8102e', hi: '#ffffff' },
  };

  /** The event, the art direction and the pictures → everything a layout reads. */
  function dataFor(o) {
    const f = Object.assign({}, o.fields || {});
    const dp = dateParts(f.date);
    if (dp) Object.assign(f, { dd: dp.dd, month: dp.month, mon: dp.mon, year: dp.year, day: dp.dayName });
    f.time = niceTime(f.time);
    f.time2 = niceTime(f.time2);
    const dir = o.dir || {};
    const pal = o.pal || { deep: '#1a0638', mid: '#5b21b6', accent: '#f5c542', hi: '#ffffff' };
    return {
      w: o.w || 1080, h: o.h || 1350, pal, dir, f, bg: o.bg, logo: o.logo,
      sp: (o.speakers || []).map((s) => ({ name: s.name, img: s.img, id: s.id, photo: s.photo })),
      script: dir.scriptWord || (dp ? dp.dayName : 'Sunday'),
      d: dp ? { day3: dp.day.slice(0, 3), day: dp.day, dayName: dp.dayName, ddn: dp.dd.replace(/\D+$/, ''), ddth: dp.dd, month: dp.month, mon3: dp.month.slice(0, 3), year: dp.year } : null,
    };
  }

  /** A whole flyer: { w, h, pal, look, layers } */
  function buildScene(o) {
    const D = dataFor(o);
    const look = LAYOUTS[o.look] ? o.look : 'glory';
    PAINTED = !!o.painted;
    let layers;
    try { layers = LAYOUTS[look](D).filter(Boolean); } finally { PAINTED = false; }
    // a painted-in preacher stands in the picture: the light effects go behind the words only, not over a face
    if (o.painted) {
      layers = layers.filter((l) => !(l.type === 'fx' && /glow|ring|sparks/.test(l.kind)));
      // the picture has a face in it: its own colours kept (skin is not regraded), and no blur
      layers.forEach((l) => { if (l.type === 'bg') { l.keepFloor = 0.88; l.blur = 0; } });
    }
    return { w: D.w, h: D.h, pal: D.pal, look, painted: !!o.painted, layers };
  }

  /* A cut-out, tidied — the upload path keeps a data URL (see tidyCanvas). */
  async function tidyCut(src) {
    const im = await loadImg(src);
    const c = canvas(iw(im), ih(im)); c.getContext('2d').drawImage(im, 0, 0);
    const t = tidyCanvas(c);
    return t.c === c && !t.x0 && !t.y0 ? src : t.c.toDataURL('image/png');
  }

  root.MWFlyer = { tidyCut, preparePerson, hero, META, HD, render, buildScene, loadFonts, IMGS, loadImg, proceduralBg, LAYOUTS, LOOK_NAMES, SIGNATURE, FONTS, textCanvas, boxOf, Dates };

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
        const raw = await loadImg(url);
        // the person made ready: what is not them taken away, where their head and shoulders are noted
        const pr = await root.MWFlyer.preparePerson(raw);
        IMGS.set(picKey(p), pr.img);
        if (pr.meta) META.set(picKey(p), pr.meta); else META.delete(picKey(p));
        return pr.img;
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

  async function open(opts) {
    opts = opts || {};
    F.panel = C.openPanel({ id: 'cloudFlyer', title: 'Flyers', cls: 'cp-flyer', full: true, onClose: () => { F.panel = null; } });
    F.panel.body.innerHTML = '<div class="fs-loading">Opening the flyer studio…</div>';
    loadFonts();
    const [st] = await Promise.all([window.api.flyer.status().catch(() => null), loadKit()]);
    F.status = st;
    F.step = 'make';
    // from Home's "This week": that service, ready to make
    const want = opts.occasion && upcoming(F.kit).find((o) => o.id === opts.occasion);
    if (want) pickOccasion(want);
    else if (!F.occasion) pickOccasion((upcoming(F.kit)[0]) || null);
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
    // what was typed for this service last time comes back by itself
    const last = k.lastFor && k.lastFor[occKey(o)];
    if (last) applyPreset(last);
  }

  function draw() {
    if (!F.panel) return;
    if (F.step === 'make') return drawMake();
    if (F.step === 'pick') return drawPick();
    return drawEdit();
  }

  /* ------------------------------------------------------ step 1: what for */

  /* a typed box that behaves: capitals where a flyer has them, no autocorrect fighting names and addresses, Next on the keyboard */
  const TXT = (cap) => `autocapitalize="${cap}" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="next"`;
  /* "7:00PM" → "19:00" for the time wheel, and back */
  const hhmm = (t) => { const m = timeMinutes(t); return m == null ? '' : `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
  /* the form is never redrawn under a finger that is typing: it waits till the box is let go */
  const typingIn = (el) => { const a = document.activeElement; return !!(a && el && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
  function applyPreset(pr) {
    if (!pr) return;
    Object.assign(F.fields, pr.fields || {});
    const have = new Set(((F.kit && F.kit.speakers) || []).map((x) => x.id));
    const sps = (pr.speakers || []).filter((id) => have.has(id));
    if (sps.length) { F.speakers = sps; F.pinned = {}; }
    if (pr.size && SIZES.some((z) => z.id === pr.size)) F.size = pr.size;
  }
  const presetNow = () => ({ fields: Object.fromEntries(['title', 'theme', 'time', 'time2', 'venue', 'extra', 'phone', 'handles', 'notes'].map((key) => [key, F.fields[key] || ''])), speakers: F.speakers.slice(), size: F.size });
  const occKey = (o) => (o && o.id ? String(o.id).replace(/^(season:[a-z-]+)\d{4}$/, '$1') : '');
  function drawMake() {
    if (F.panel && typingIn(F.panel.body)) {
      if (!F._redraw) { F._redraw = true; F.panel.body.addEventListener('focusout', () => setTimeout(() => { F._redraw = false; if (F.step === 'make' && !typingIn(F.panel && F.panel.body)) drawMake(); }, 60), { once: true }); }
      return;
    }
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
          <h3>My presets <small>tap one to fill everything in</small></h3>
          <div class="fs-occs fs-presets">${(k.presets || []).map((pr) => `<span class="fs-occ fs-preset" data-preset="${escAttr(pr.id)}"><b>${esc(pr.name)}</b><small>${esc([pr.fields && niceTime(pr.fields.time), pr.fields && pr.fields.venue].filter(Boolean).join(' · ') || 'saved details')}</small><button type="button" class="fs-preset-x" data-unpreset="${escAttr(pr.id)}" aria-label="Delete ${escAttr(pr.name)}">×</button></span>`).join('')}<button type="button" class="fs-occ fs-preset-add" data-act="savepreset"><b>＋ Save these</b><small>as a preset</small></button></div>
        </section>
        <section class="fs-sec">
          <h3>Who is preaching? <small>tap to put them on · tap again for their pictures</small></h3>
          <div class="fs-sps">${sp}</div>
          ${chosenSpeakers().map((s) => `<button type="button" class="fs-bulk" data-act="bulk" data-id="${escAttr(s.id)}">${ic('photo')}<span><b>Add photos of ${esc(s.name || 'this speaker')}</b><small>pick many at once — each is cut out for you · ${(s.photos || []).length} in the bank</small></span>${ic('plus')}</button>`).join('')}
        </section>
        <section class="fs-sec fs-form">
          <label class="fs-f fs-wide"><span>Title</span><input data-f="title" value="${escAttr(f.title)}" placeholder="Sunday Service" ${TXT('words')}></label>
          <label class="fs-f fs-wide"><span>Theme <i>(optional)</i></span><input data-f="theme" value="${escAttr(f.theme)}" placeholder="e.g. Loose Him and Let Him Go" ${TXT('sentences')}></label>
          <label class="fs-f"><span>Date</span><input type="date" data-f="date" value="${escAttr(f.date)}"></label>
          <label class="fs-f"><span>Time</span><input type="time" data-f="time" data-time value="${escAttr(hhmm(f.time))}"></label>
          <label class="fs-f fs-wide"><span>Where</span><input data-f="venue" value="${escAttr(f.venue)}" placeholder="12 Airport Road, Benin City" ${TXT('words')}></label>
          <details class="fs-more"${f.extra || f.time2 || f.notes ? ' open' : ''}><summary>More</summary>
            <label class="fs-f"><span>Second service</span><input type="time" data-f="time2" data-time value="${escAttr(hhmm(f.time2))}"></label>
            <label class="fs-f"><span>Extra line</span><input data-f="extra" value="${escAttr(f.extra)}" placeholder="10th Edition" ${TXT('words')}></label>
            <label class="fs-f fs-wide"><span>Phone / email</span><input data-f="phone" value="${escAttr(f.phone)}" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>
            <label class="fs-f fs-wide"><span>Social handles</span><input data-f="handles" value="${escAttr(f.handles)}" placeholder="@yourchurch" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
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
    const boxes = $$('[data-f]', P.body);
    boxes.forEach((el, i) => {
      const keep = () => { F.fields[el.dataset.f] = el.hasAttribute('data-time') ? niceTime(el.value) : el.value; };
      el.addEventListener('input', keep); el.addEventListener('change', keep);
      // Next goes to the next box, the last one puts the keyboard away
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || el.tagName === 'TEXTAREA') return;
        e.preventDefault();
        const nx = boxes.slice(i + 1).find((b) => b.offsetParent && b.type !== 'date' && b.type !== 'time');
        if (nx) nx.focus(); else el.blur();
      });
      // the box being typed in stays in sight above the keyboard
      el.addEventListener('focus', () => setTimeout(() => {
        const r = el.getBoundingClientRect(), body = P.body.getBoundingClientRect();
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const bottom = Math.min(body.bottom, vh) - 24;
        if (r.bottom > bottom || r.top < body.top + 8) P.body.scrollTop += r.top - (body.top + Math.max(60, (bottom - body.top) * 0.3));
      }, 320));
    });
    P.body.onclick = async (e) => {
      const x = e.target.closest('[data-unpreset]');
      if (x) {
        const pr = (F.kit.presets || []).find((q) => q.id === x.dataset.unpreset);
        if (pr && window.confirm(`Delete the preset “${pr.name}”?`)) { F.kit.presets = F.kit.presets.filter((q) => q !== pr); await saveKit(true); drawMake(); }
        return;
      }
      const pb = e.target.closest('[data-preset]');
      if (pb) { applyPreset((F.kit.presets || []).find((q) => q.id === pb.dataset.preset)); toast('Filled in from your preset.', 'good', 2500); return drawMake(); }
      const b = e.target.closest('[data-occ],[data-sp],[data-size],[data-act]'); if (!b) return;
      if (b.dataset.act === 'savepreset') {
        const name = (window.prompt('Name this preset (e.g. Tuesday Word Study):', F.fields.title || '') || '').trim();
        if (!name) return;
        const list = (F.kit.presets || []).filter((q) => q.name.toLowerCase() !== name.toLowerCase());
        F.kit.presets = [Object.assign({ id: 'pr' + Date.now().toString(36), name }, presetNow())].concat(list).slice(0, 40);
        await saveKit(true);
        toast(`Saved “${name}”. Tap it any time to fill everything in.`, 'good');
        return drawMake();
      }
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
      if (b.dataset.act === 'bulk') {
        const s = ((F.kit && F.kit.speakers) || []).find((x) => x.id === b.dataset.id);
        if (s) return addPhotos(s, async () => { await saveKit(true); drawMake(); });
      }
    };
    P.foot.onclick = (e) => { if (e.target.closest('[data-act="make"]')) makeFlyers(); };
  }

  /* ------------------------------------------------------ step 2: make + pick */

  async function makeFlyers() {
    F.cfTold = false; F.inTold = false; F.premium = [];
    if (!F.fields.title.trim()) { toast('Give it a title first.', 'error'); return; }
    // remember these details for this service (Tuesday's Word Study comes back as typed)
    const ok = occKey(F.occasion);
    if (ok && ok !== 'other' && F.kit) { F.kit.lastFor = Object.assign({}, F.kit.lastFor, { [ok]: presetNow() }); saveKit(true); }
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
    // six AI pictures, six ideas, six lights: every design on the board gets its own
    const scenes = (F.dir.scenes || []).slice(0, 6);
    for (let j = 0; scenes.length && scenes.length < 6; j++) scenes.push(scenes[j % scenes.length]);
    F.painting = scenes.length;
    drawPick();
    const paintingIn = paintPreacherIn(tryNo, sz);   // alongside the six, not after them
    autoPremium(tryNo);   // and the premium ones, when Puter is on (its own account, its own pace)
    let failed = '';
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        // each picture in its own light — the AI's colours, royal blue, purple — so the board is as varied as a Pinterest page
        const tone = TONES[i % TONES.length];
        const out = await window.api.flyer.paint({ scene: tone.words ? scene + ', ' + tone.words : scene, w: sz.w, h: sz.h, seed: Math.floor(Math.random() * 1e9), people: chosenSpeakers().some((s) => (s.photos || []).length) });
        if (tryNo !== F.tries) return;
        let im = await loadImg(out.dataUrl);
        // the backup painter signs its pictures in the bottom corner: that strip is cut off
        if (/pollinations/i.test(out.by || '')) im = cropBottom(im, 0.06);
        if (out.cfFailed && !F.cfTold) { F.cfTold = true; toast('Cloudflare did not paint (' + out.cfFailed.slice(0, 140) + ') — the backup painter made these. The best designs need Cloudflare working.', 'error', 12000); }
        const key = 'ai:' + tryNo + ':' + i;
        IMGS.set(key, im);
        // AI pictures lead; the photos stay on for variety until three AI ones are in
        const ai = F.bgs.filter((b) => !b.proc).concat({ key, by: out.by, scene, tone: tone.id });
        // AI pictures in order of their light, the studio's photos only standing in until three are here
        ai.sort((a, b) => TONES.findIndex((t) => t.id === a.tone) - TONES.findIndex((t) => t.id === b.tone));
        F.bgs = ai.concat(F.bgs.filter((b) => b.proc)).slice(0, Math.max(3, ai.length));
        rebuildDesigns();
      } catch (e) { failed = e.message || String(e); }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
    await paintingIn;
    if (tryNo === F.tries && F.bgs.every((b) => b.proc) && failed) toast('The AI could not paint just now (' + failed.slice(0, 120) + '). These use the studio’s own photographs — tap “New pictures” to try again.', 'error', 9000);
  }

  /*
   * ►► THE PREACHER PAINTED IN (option 1). ◄◄ Their photo — the cut-out, on a
   * plain grey, so a lectern or a crowd behind them is not copied — goes to
   * FLUX.2 as a reference, and two pictures come back with them standing in
   * the scene, lit by it. They become their own designs, marked so that the
   * face is checked before posting: the model can change a face a little.
   */
  const PAINT_IN_LOOKS = ['glory', 'miracle'];
  function refPhoto(sp) {
    const im = sp && imgOf(sp.img); if (!im) return null;
    const k = Math.min(1, 512 / Math.max(iw(im), ih(im)));
    const c = canvas(iw(im) * k, ih(im) * k), x = c.getContext('2d');
    x.fillStyle = '#7a7a7a'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }
  async function paintPreacherIn(tryNo, sz) {
    F.paintedIn = [];
    if (!(F.status && F.status.cloudflare)) return;
    const sp = speakersFor(0)[0]; const ref = refPhoto(sp);
    if (!ref) return;
    const scenes = (F.dir.scenes || []).slice(0, PAINT_IN_LOOKS.length);
    F.painting += scenes.length; if (F.step === 'pick') drawPick();
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        const out = await window.api.flyer.paintWith({ scene, w: sz.w, h: sz.h, seed: Math.floor(Math.random() * 1e9), refs: [ref] });
        if (tryNo !== F.tries) return;
        const key = 'aiin:' + tryNo + ':' + i;
        IMGS.set(key, await loadImg(out.dataUrl));
        F.paintedIn = F.paintedIn.concat({ key, by: out.by, scene, look: PAINT_IN_LOOKS[i % PAINT_IN_LOOKS.length] });
        rebuildDesigns();
      } catch (e) { if (!F.inTold) { F.inTold = true; toast('The AI could not paint the preacher into a scene: ' + String(e.message || e).slice(0, 160), 'error', 10000); } }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
  }

  /*
   * ►► PREMIUM AI (Puter.js, "user pays"). ◄◄ The top image models — Google's
   * Nano Banana, OpenAI's GPT Image, ByteDance's Seedream — called from the
   * phone itself through Puter, paid from the operator's own free Puter
   * account (a monthly allowance; more can be bought there), never from the
   * church's. Loaded only when Premium is tapped. Two pictures a round: the
   * preacher painted into the scene from his photo, and a background. Model
   * names differ between Puter's pages, so each choice tries a few.
   */
  const PUTER_MODELS = [
    { id: 'nano', name: 'Nano Banana', by: 'Google', ids: ['google/gemini-2.5-flash-image', 'gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'] },
    { id: 'gpt', name: 'GPT Image', by: 'OpenAI', ids: ['gpt-image-1', 'openai/gpt-image-1'] },
    { id: 'seedream', name: 'Seedream', by: 'ByteDance', ids: ['byteplus/dola-seedream-5-0-pro-260628', 'bytedance/seedream-4', 'seedream-4'] },
    { id: 'pro', name: 'Nano Banana Pro', by: 'Google · best, uses more of the allowance', ids: ['google/gemini-3-pro-image', 'gemini-3-pro-image'] },
  ];
  let puterP = null;
  function loadPuter() {
    if (window.puter && window.puter.ai) return Promise.resolve(window.puter);
    if (!puterP) {
      puterP = new Promise((res, rej) => {
        const sc = document.createElement('script');
        sc.src = 'https://js.puter.com/v2/';
        sc.onload = () => (window.puter && window.puter.ai ? res(window.puter) : rej(new Error('Puter did not start')));
        sc.onerror = () => { puterP = null; rej(new Error('Could not reach Puter — check the connection')); };
        document.head.appendChild(sc);
      });
    }
    return puterP;
  }
  const puterMsg = (e) => String((e && (e.error && (e.error.message || e.error)) ) || (e && e.message) || e || 'unknown');
  const outOfAllowance = (e) => /insufficient|funds|credit|balance|quota|allowance|402|usage limit|payment/i.test(puterMsg(e));
  /* Puter answers with an <img>; drawn on a canvas it must be ours (a picture from another site cannot be), so it is fetched as a blob first */
  async function asOwnImage(el) {
    let src = el && (el.src || (typeof el === 'string' ? el : ''));
    if (!src) throw new Error('Puter sent no picture');
    if (!/^(data:|blob:)/.test(src)) {
      const r = await fetch(src); if (!r.ok) throw new Error('could not fetch the picture (' + r.status + ')');
      src = URL.createObjectURL(await r.blob());
    }
    return loadImg(src);
  }
  async function puterImage(prompt, model, refs) {
    const P = await loadPuter();
    const rs = [].concat(refs || []).filter(Boolean);
    let last = null;
    for (const id of model.ids) {
      try {
        const opt = { model: id };
        if (rs.length === 1) opt.input_image = rs[0];
        else if (rs.length > 1) opt.input_images = rs;
        const el = await P.ai.txt2img(prompt, opt);
        return { im: await asOwnImage(el), model: id };
      } catch (e) { last = e; if (outOfAllowance(e)) throw e; }
    }
    throw last || new Error('no model answered');
  }
  /* the flyer's words, exactly as typed, for a design the AI letters itself */
  function flyerWords() {
    const f = F.fields || {}, dp = dateParts(f.date), sp = chosenSpeakers()[0];
    const q = (t) => '"' + String(t || '').replace(/"/g, "'").trim() + '"';
    const lines = [];
    if (f.church || (F.kit && F.kit.church)) lines.push('the church name, small at the top: ' + q((f.church || F.kit.church).toUpperCase()));
    lines.push('the title, huge and bold: ' + q((f.title || 'Sunday Service').toUpperCase()));
    if (f.theme) lines.push('the theme: ' + q(f.theme));
    if (dp) lines.push('the date: ' + q(`${dp.dayName.toUpperCase()} ${dp.dd} ${dp.month.toUpperCase()} ${dp.year}`));
    if (f.time) lines.push('the time: ' + q(niceTime(f.time)));
    if (sp && sp.name) lines.push('the minister: ' + q('Ministering: ' + sp.name));
    if (f.venue) lines.push('the venue, small: ' + q(f.venue));
    return lines;
  }
  function fullPrompt(scene, hasPerson, hasLogo) {
    return [
      'Design a complete, finished church event flyer, vertical 4:5, in the style of the best church flyers on Pinterest: a cinematic photographic background (' + scene + '), bold glossy 3D lettering in gold or chrome with depth and glow, dramatic light, a polished professional layout with clear hierarchy.',
      hasPerson ? 'The minister is the man in the FIRST reference photo — keep him exactly the same person (same face, skin tone, hairline, beard, clothes), large, from the chest up, lit by the scene with a rim light.' : '',
      hasLogo ? 'Place the church logo from the ' + (hasPerson ? 'SECOND' : 'FIRST') + ' reference image small at the top centre, unchanged.' : '',
      'Use exactly this text and no other words, spelled exactly as given: ' + flyerWords().join('; ') + '.',
      'No watermark, no extra text, no misspellings.',
    ].filter(Boolean).join(' ');
  }
  function premiumPrompts(scene, withPerson) {
    const look = 'vertical 4:5 portrait photograph for a premium church event flyer, photorealistic, cinematic colour grade, volumetric stage light and haze, shallow depth of field, sharp detail, the upper third darker and open for a headline. Absolutely no text, no letters, no words, no logos, no watermark.';
    return withPerson
      ? `Use the man in the reference photo — keep him exactly the same person: the same face, skin tone, hairline, beard and clothes. Show him from the chest up in the lower half of the frame, a little off-centre, preaching with passion, standing IN this scene: ${scene}. He is lit by the scene itself — a strong rim light behind him in the scene's colour, soft warm light on his face, haze around him. ${look}`
      : `${scene}. No person in the middle of the frame. ${look}`;
  }
  function openPremium() {
    const P = C.openPanel({ id: 'cloudFlyerPremium', title: 'Premium AI', cls: 'cp-flyer-kit' });
    let model = PUTER_MODELS.find((m) => m.id === (localStorage.getItem('mw.flyer.premium') || 'nano')) || PUTER_MODELS[0];
    let state = 'loading', who = '';
    const draw = () => {
      P.body.innerHTML = `<div class="fs-kit">
        <p class="fs-note">The best image AIs, from your own <b>free Puter account</b> — it has a free monthly allowance (shown on puter.com), and more can be bought there for pennies if you ever want. The church pays nothing. Three designs: <b>a whole flyer designed by the AI</b> (your words, your logo, ${esc(chosenSpeakers()[0] ? chosenSpeakers()[0].name : 'the preacher')}), <b>him painted into a scene</b>, and a background.</p>
        <div class="fs-occs fs-premium-models">${PUTER_MODELS.map((m) => `<button type="button" class="fs-occ${m.id === model.id ? ' on' : ''}" data-pm="${m.id}"><b>${esc(m.name)}</b><small>${esc(m.by)}</small></button>`).join('')}</div>
        <label class="fs-premium-auto"><input type="checkbox" data-pauto${premiumAuto() ? ' checked' : ''}> Add premium designs every time I make flyers</label>
        <p class="fs-status">${state === 'loading' ? '<i class="fs-spin"></i> Opening Puter…' : state === 'out' ? 'Signed out of Puter.' : state === 'in' ? 'Signed in to Puter' + (who ? ' as <b>' + esc(who) + '</b>' : '') + '.' : state === 'busy' ? '<i class="fs-spin"></i> Painting with ' + esc(model.name) + '… (up to a minute)' : esc(state)}</p>
      </div>`;
      P.foot.innerHTML = state === 'out'
        ? '<button type="button" class="fs-go" data-pa="signin"><span>Sign in to Puter (free)</span></button>'
        : `<button type="button" class="fs-go" data-pa="make"${state === 'in' ? '' : ' disabled'}><span>✦ Make premium designs</span></button>`;
    };
    draw();
    loadPuter().then(async (pu) => {
      state = pu.auth.isSignedIn() ? 'in' : 'out';
      if (state === 'in') { try { who = (await pu.auth.getUser()).username || ''; } catch (e) {} }
      draw();
    }, (e) => { state = e.message; draw(); });
    P.body.addEventListener('change', (e) => { if (e.target.matches('[data-pauto]')) { try { localStorage.setItem('mw.flyer.premiumAuto', e.target.checked ? '1' : '0'); } catch (er) {} } });
    const click = async (e) => {
      const m = e.target.closest('[data-pm]');
      if (m) { model = PUTER_MODELS.find((x) => x.id === m.dataset.pm) || model; try { localStorage.setItem('mw.flyer.premium', model.id); } catch (er) {} return draw(); }
      const a = e.target.closest('[data-pa]'); if (!a) return;
      if (a.dataset.pa === 'signin') {
        // straight from the tap: a sign-in window may only be opened by one
        try { await window.puter.auth.signIn(); state = 'in'; try { localStorage.setItem('mw.flyer.premiumAuto', '1'); } catch (er) {} try { who = (await window.puter.auth.getUser()).username || ''; } catch (er) {} }
        catch (er) { toast('Puter sign-in did not finish: ' + puterMsg(er).slice(0, 140), 'error', 9000); }
        return draw();
      }
      if (a.dataset.pa === 'make') {
        state = 'busy'; draw();
        const ok = await makePremium(model);
        if (ok) { P.close(); return; }
        state = 'in'; draw();
      }
    };
    P.body.addEventListener('click', click);
    P.foot.addEventListener('click', click);
  }
  function logoRef() {
    const im = IMGS.get('logo'); if (!im) return null;
    const k = Math.min(1, 384 / Math.max(iw(im), ih(im)));
    const c = canvas(iw(im) * k, ih(im) * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }
  /* kinds: 'full' (the AI designs the whole flyer, words and all), 'in' (the preacher painted into a scene), 'bg' (a background) */
  async function makePremium(model, kinds, quiet) {
    const tryNo = F.tries;
    const scenes = (F.dir && F.dir.scenes) || ['a worship stage with golden spotlights and haze, a crowd with raised hands far behind, out of focus'];
    const sp = speakersFor(0)[0], ref = refPhoto(sp), logo = logoRef();
    kinds = kinds || ['full', 'in', 'bg'];
    const jobs = kinds.map((k, i) => (k === 'in' && !ref ? null : { kind: k, scene: scenes[i % scenes.length], refs: k === 'full' ? [ref, logo] : k === 'in' ? [ref] : [] })).filter(Boolean);
    let made = 0, err = null;
    for (const j of jobs) {   // one at a time: a free account may run only a few at once
      try {
        const prompt = j.kind === 'full' ? fullPrompt(j.scene, !!ref, !!logo) : premiumPrompts(j.scene, j.kind === 'in');
        const out = await puterImage(prompt, model, j.refs.filter(Boolean));
        if (tryNo !== F.tries) return false;
        const key = 'prem:' + tryNo + ':' + j.kind + ':' + made;
        IMGS.set(key, out.im);
        F.premium = (F.premium || []).concat({ key, kind: j.kind, name: model.name });
        made++;
        rebuildDesigns();
        if (F.step === 'pick') { drawPick(); if (F.panel) F.panel.body.scrollTop = 0; }   // new cards, at the top, in sight
      } catch (e) { err = e; if (outOfAllowance(e)) break; }
    }
    if (err) toast(outOfAllowance(err) ? 'Your free Puter allowance is used up for this month — more can be bought on puter.com, or carry on with the free designs.' : 'Premium AI: ' + puterMsg(err).slice(0, 160), 'error', 11000);
    if (made && !quiet) toast(`${made} premium design${made > 1 ? 's' : ''} by ${model.name} — at the top of the board.`, 'good', 5000);
    return made > 0;
  }
  /* SEAMLESS: once signed in to Puter, every "Make my flyers" brings premium designs by itself (no tap needed) */
  const premiumAuto = () => { try { return localStorage.getItem('mw.flyer.premiumAuto') === '1'; } catch (e) { return false; } };
  const premiumModel = () => { let id = 'nano'; try { id = localStorage.getItem('mw.flyer.premium') || 'nano'; } catch (e) {} return PUTER_MODELS.find((m) => m.id === id) || PUTER_MODELS[0]; };
  async function autoPremium(tryNo) {
    if (!premiumAuto()) return;
    try {
      const pu = await loadPuter();
      if (tryNo !== F.tries || !pu.auth.isSignedIn()) return;
      F.premiumBusy = true; if (F.step === 'pick') drawPick();
      await makePremium(premiumModel(), ['full', 'in'], true);
    } catch (e) { /* the free designs stand */ }
    finally { F.premiumBusy = false; if (tryNo === F.tries && F.step === 'pick') drawPick(); }
  }

  function cropBottom(im, f) {
    const c = canvas(iw(im), Math.round(ih(im) * (1 - f)));
    c.getContext('2d').drawImage(im, 0, 0);
    return c;
  }
  function chosenSpeakers() {
    const all = (F.kit && F.kit.speakers) || [];
    return F.speakers.map((id) => all.find((s) => s.id === id)).filter(Boolean);
  }

  const TONES = [
    { id: 'own', words: '' },
    { id: 'blue', words: 'the whole scene lit in deep royal blue and cool white light, blue haze' },
    { id: 'purple', words: 'the whole scene lit in rich purple and magenta light with warm orange highlights' },
    { id: 'red', words: 'the whole scene lit in deep crimson red and warm orange light, glowing embers' },
    { id: 'gold', words: 'the whole scene bathed in warm golden sunlight and amber haze, glowing highlights' },
    { id: 'teal', words: 'the whole scene lit in deep teal and emerald light with soft white highlights' },
  ];
  const TONE_PAL = {
    own: 'own',
    blue: { deep: '#020b2e', mid: '#0b3d91', accent: '#ffd23f', hi: '#ffffff' },
    purple: { deep: '#14063a', mid: '#6d1fb0', accent: '#ff9a2e', hi: '#ffe6ff' },
    red: { deep: '#240003', mid: '#a5111d', accent: '#ffc21a', hi: '#fff3e0' },
    gold: { deep: '#2a1400', mid: '#b86f00', accent: '#ffd54a', hi: '#fffbe6' },
    teal: { deep: '#012226', mid: '#0e6f7a', accent: '#ffd23f', hi: '#ffffff' },
  };
  function rebuildDesigns() {
    const sz = sizeOf();
    const looks = (F.dir && F.dir.looks && F.dir.looks.length ? F.dir.looks : Object.keys(LAYOUTS)).filter((l) => LAYOUTS[l]);
    const all = Array.from(new Set(looks.concat(Object.keys(LAYOUTS))));
    F.designs = all.map((look, i) => {
      const bg = F.bgs[i % F.bgs.length];
      // the AI's colours on the first designs, each look's own on the rest — a board of different flyers, not one flyer ten times
      // a picture painted in its own light takes colours that match it; the AI's own on the rest
      const tp = bg && bg.tone && TONE_PAL[bg.tone];
      const pal = tp ? (tp === 'own' ? F.pal : tp) : (i < 3 || !SIGNATURE[look] ? F.pal : SIGNATURE[look]);
      return buildScene({ look, w: sz.w, h: sz.h, pal, dir: F.dir, fields: F.fields, speakers: speakersFor(i), logo: IMGS.has('logo') ? 'logo' : null, bg: bg && bg.key });
    });
    // the preacher painted into the scene (paintPreacherIn): first on the board, labelled so the face is checked
    const pin = (F.paintedIn || []).map((b) => Object.assign(buildScene({ look: b.look, painted: true, w: sz.w, h: sz.h, pal: F.pal, dir: F.dir, fields: F.fields, speakers: speakersFor(0), logo: IMGS.has('logo') ? 'logo' : null, bg: b.key }), { label: 'AI scene · check the face' }));
    // Premium AI (Puter): the preacher painted in → two painted designs; a background → two designs on it
    const prem = [];
    (F.premium || []).forEach((b) => {
      if (b.kind === 'full') {
        // the AI's own finished flyer: shown as it made it (no grade, no words over it); text can still be added in the editor
        prem.push({ w: sz.w, h: sz.h, pal: F.pal, look: 'glory', painted: true, aiFull: true, label: `✦ ${b.name} · full design · check the spelling`,
          layers: [BG({ img: b.key, keepFloor: 1, blur: 0, grain: 0 })] });
        return;
      }
      const looks = b.kind === 'in' ? ['glory', 'miracle'] : ['sunday', 'fire'];
      looks.forEach((look) => prem.push(Object.assign(buildScene({ look, painted: b.kind === 'in', w: sz.w, h: sz.h, pal: F.pal, dir: F.dir, fields: F.fields, speakers: speakersFor(0), logo: IMGS.has('logo') ? 'logo' : null, bg: b.key }),
        { label: `✦ ${b.name}${b.kind === 'in' ? ' · check the face' : ''}` })));
    });
    F.designs = prem.concat(pin, F.designs);
    if (F.step === 'pick') paintThumbs();
  }

  function drawPick() {
    const P = F.panel; if (!P) return;
    P.setTitle('Pick one');
    P.el.classList.remove('fs-editing');
    const busy = !F.designs.length;
    P.body.innerHTML = `<div class="fs-pick">
      <p class="fs-status">${busy ? 'The AI is reading your event…' : F.premiumBusy ? '<i class="fs-spin"></i> Making premium designs with ' + esc(premiumModel().name) + '…' : F.painting > 0 ? `<i class="fs-spin"></i> Painting ${F.painting} picture${F.painting > 1 ? 's' : ''} with AI — they appear as they’re ready` : 'Tap one to edit every part of it'}</p>
      <div class="fs-grid">${busy ? '<div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div>' : F.designs.map((d, i) => `<button type="button" class="fs-card" data-i="${i}"><canvas></canvas><small>${esc(d.label || LOOK_NAMES[d.look] || d.look)}</small></button>`).join('')}</div>
    </div>`;
    P.foot.innerHTML = `<button type="button" class="fs-ghost" data-act="back">${ic('back')}<span>Details</span></button><button type="button" class="fs-ghost" data-act="again">${ic('refresh')}<span>New pictures</span></button><button type="button" class="fs-go fs-premium" data-act="premium">${ic('spark')}<span>Premium</span></button>`;
    paintThumbs();
    P.body.onclick = (e) => { const c = e.target.closest('.fs-card'); if (c) openEditor(F.designs[+c.dataset.i]); };
    P.foot.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'back') { F.step = 'make'; F.tries++; drawMake(); }
      if (b.dataset.act === 'again') makeFlyers();
      if (b.dataset.act === 'premium') openPremium();
    };
  }
  function paintThumbs() {
    if (!F.panel) return;
    $$('.fs-card', F.panel.body).forEach((c) => {
      const S = F.designs[+c.dataset.i]; if (!S) return;
      const cv = c.querySelector('canvas');
      // as sharp as this screen shows it (a phone has three pixels to each point)
      const px = Math.max(240, Math.round((cv.clientWidth || 170) * (window.devicePixelRatio || 1)));
      render(S, cv, px / S.w);
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
      const k = stageScale();
      render(F.scene, cv, clamp(k * (window.devicePixelRatio || 1), 1, 2));
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
              const sr = L.src || { x: 0, y: 0, w: 1, h: L.crop || 1 };
              const u0 = (rx / s + L.w / 2) / L.w, v = (ry / s + L.h / 2) / L.h, u = L.flip ? 1 - u0 : u0;
              tx.drawImage(im, (sr.x + u * sr.w) * iw(im), (sr.y + v * sr.h) * ih(im), 1, 1, 0, 0, 1, 1);
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
      case 'imglook': return sliders([['Length', 'len', 0.4, 1.6, 0.01], ['Brightness', 'bright', -60, 60], ['Contrast', 'contrast', -50, 80], ['Colour', 'sat', -100, 100], ['Round corners', 'radius', 0, 300]], L);
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
        change(() => { refit(L, { img: key }); });
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
    // "Length": how much of the person is shown, the head staying where it is
    if (L.type === 'image' && L.len == null) { L.len = 1; L._src0 = L.src ? Object.assign({}, L.src) : { x: 0, y: 0, w: 1, h: L.crop || 1 }; L._h0 = L.h; L._top0 = L.y - L.h / 2; }
    openSheet(list.map(([label, k, min, max, step]) => {
      const v = L[k] == null ? (k === 'opacity' || k === 's' || k === 'crop' ? 1 : k === 'line' ? 1 : k === 'tint' ? 0.45 : k === 'vignette' ? 0.75 : 0) : L[k];
      return `<label class="fs-slider"><span>${esc(label)}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step || 1}" value="${v}"><output>${Math.round(v * (step && step < 1 ? 100 : 1))}</output></label>`;
    }).join(''), (sh) => {
      $$('input[type=range]', sh).forEach((r) => r.addEventListener('input', () => {
        L[r.dataset.k] = +r.value;
        if (r.dataset.k === 'len' && L._src0) {
          const im = imgOf(L.img), maxH = im ? 1 - L._src0.y : 1;
          L.src = Object.assign({}, L._src0, { h: Math.min(maxH, L._src0.h * L.len) });
          L.h = L._h0 * L.src.h / L._src0.h; L.y = L._top0 + L.h / 2; delete L.crop;
        }
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

  /* a person's layer given another photo: framed the same way (head where it was, same size) */
  function refit(L, o) {
    if (L.frame) {
      const N = root.MWFlyer.hero({ img: o.img, name: L.name, id: L.speaker, photo: o.photo || L.photo }, L.frame);
      if (N) { ['img', 'photo', 'src', 'w', 'h', 'x', 'y', 'fade'].forEach((k) => { L[k] = N[k]; }); delete L.crop; delete L.len; return; }
    }
    const im = imgOf(o.img); L.img = o.img; if (o.photo) L.photo = o.photo; delete L.src; delete L.crop;
    if (im) L.w = L.h * iw(im) / ih(im);
  }

  /* swap a speaker's picture for another from their bank */
  function sheetBank(L) {
    const s = ((F.kit && F.kit.speakers) || []).find((x) => x.id === L.speaker); if (!s) return;
    openSheet(`<h4>${esc(s.name || 'Speaker')}</h4><div class="fs-bank">${(s.photos || []).map((p) => `<button type="button" class="fs-bank-pic${L.photo === p ? ' on' : ''}" data-photo="${escAttr(p)}">${picTag(p)}</button>`).join('')}</div>`, (sh) => {
      fillPics(sh);
      sh.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-photo]'); if (!b) return;
        const p = b.dataset.photo, im = await bankPic(p); if (!im) return;
        change(() => { refit(L, { img: picKey(p), photo: p }); });
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
        <button type="button" class="fs-bank-pic fs-bank-add" data-b="add">${ic('plus')}<small>Add photos<br>(many at once)</small></button></div></div>`;
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
      const files = Array.from(inp.files || []).slice(0, 30); if (!files.length) return;
      if (files.length === 1) {
        const url = await shrinkToDataUrl(files[0], 1800);
        return cutOutUrl(url, async (png) => {
          png = await tidyCut(png).catch(() => png);
          let kept = png;
          try { kept = await window.api.flyer.kitAddPhoto(s.id, png, s.name); PICURL.set(kept, png); } catch (e) { /* the next Save sends it */ }
          s.photos = (s.photos || []).concat(kept); await then();
        });
      }
      let n = 0;
      for (const f of files) {
        toast(`Cutting out ${++n} of ${files.length}…`, '', 4000);
        try {
          const url = await shrinkToDataUrl(f, 1800);
          let png = url;
          try { png = await tidyCut((await window.FlyerAI.removePerson(url)).src); } catch (e) { /* kept as it is */ }
          // each one kept on the server as soon as it is cut out (a speaker not yet saved is made as it goes)
          let kept = png;
          try { kept = await window.api.flyer.kitAddPhoto(s.id, png, s.name); PICURL.set(kept, png); } catch (e) { /* the next Save sends it */ }
          s.photos = (s.photos || []).concat(kept);
        } catch (e) { /* skip that one */ }
      }
      toast(`${files.length} photos added to ${s.name || 'the bank'}. Tap one in My church to fix its cut-out.`, 'good', 6000);
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

  function pickImage(then, o = {}) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0]; if (!file) return;
      try { then(await shrinkToDataUrl(file, o.max || 1800, o.png)); } catch (e) { toast(e.message || 'That picture could not be opened.', 'error'); }
    };
    inp.click();
  }
  /* a phone photo is 12 megapixels; a flyer needs a fraction of that */
  async function shrinkToDataUrl(file, max, png) {
    const url = URL.createObjectURL(file);
    try {
      const im = await loadImg(url);
      const k = Math.min(1, max / Math.max(iw(im), ih(im)));
      const c = canvas(iw(im) * k, ih(im) * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      return png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.92);
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
      png = await tidyCut(png).catch(() => png);
      const pr = await preparePerson(await loadImg(png)); const key = 'cut:' + uid(); IMGS.set(key, pr.img);
      if (pr.meta) META.set(key, pr.meta);
      change(() => { refit(L, { img: key }); });
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

  function openKit(onSaved) {
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
        // the logo exactly as it is — never cut out (see logoLayers); a PNG keeps its see-through parts
        case 'logo': return pickImage(async (url) => { k.logoUrl = url; IMGS.set('logo', await loadImg(url)); drawKit(); }, { png: true, max: 900 });
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
            return cutOutUrl(PICURL.get(p) || p, async (png) => { sp.photos[j] = await tidyCut(png).catch(() => png); drawKit(); });
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
          if (typeof onSaved === 'function') { try { onSaved(); } catch (e) {} }
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

  /* "My church" straight from Home (This week → Edit) */
  async function openKitAlone(onSaved) { await loadKit(); openKit(onSaved); }
  root.MWFlyerStudio = { open, openKit: openKitAlone, _state: F };
})();
