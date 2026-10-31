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
    // the faces those Pinterest flyers are actually set in: heavy italics (TONGUES SERVICE, PRAYER WALK),
    // ultra-condensed (SUNDAY), Didone serifs (GLORY OF GOD, PROPHETIC MANTLE), blackletter (By His Spirit, Praise Altar),
    // and the signature scripts written over names ("with", "Pst")
    { id: 'Kanit Black', file: 'Kanit-Black.ttf', kind: 'display' },
    { id: 'Kanit Italic', file: 'Kanit-BlackItalic.ttf', kind: 'display' },
    { id: 'Montserrat Black', file: 'Montserrat-Black.ttf', kind: 'display' },
    { id: 'Montserrat Italic', file: 'Montserrat-BlackItalic.ttf', kind: 'display' },
    { id: 'Barlow Black', file: 'BarlowCondensed-Black.ttf', kind: 'display' },
    { id: 'Barlow Black Italic', file: 'BarlowCondensed-BlackItalic.ttf', kind: 'display' },
    { id: 'Six Caps', file: 'SixCaps.ttf', kind: 'display' },
    { id: 'Bodoni', file: 'BodoniModa-Bold.ttf', kind: 'serif' },
    { id: 'Bodoni Light', file: 'BodoniModa-Regular.ttf', kind: 'serif' },
    { id: 'Playfair Black', file: 'PlayfairDisplay-Black.ttf', kind: 'serif' },
    { id: 'Cinzel Decorative', file: 'CinzelDecorative-Black.ttf', kind: 'serif' },
    { id: 'Blackletter', file: 'UnifrakturCook-Bold.ttf', kind: 'serif' },
    { id: 'Pirata One', file: 'PirataOne-Regular.ttf', kind: 'serif' },
    { id: 'Allura', file: 'Allura-Regular.ttf', kind: 'script' },
    { id: 'Sacramento', file: 'Sacramento-Regular.ttf', kind: 'script' },
    { id: 'Signature', file: 'MonsieurLaDoulaise-Regular.ttf', kind: 'script' },
    { id: 'Saint Delafield', file: 'MrsSaintDelafield-Regular.ttf', kind: 'script' },
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
  const imgOf = (k) => IMGS.get(k) || (typeof k === 'string' && k.startsWith('tex:') ? texture(k.slice(4)) : null);
  /*
   * ►► TITLES WITH A MATERIAL IN THEM. ◄◄ The flyers people save set their
   * title in something: gold leaf (REVIVE), stone (WATER FROM THE ROCK), fire
   * (BREAK EVERY CHAIN), brushed steel (JUDAH). These are painted here, once,
   * from noise — a picture the letters are filled with (imgFill), the bevel
   * and the block under them doing the rest.
   */
  const TEXTURES = ['gold', 'stone', 'fire', 'steel', 'rosegold'];
  function texture(name) {
    if (!TEXTURES.includes(name)) return null;
    const key = 'tex:' + name;
    if (IMGS.has(key)) return IMGS.get(key);
    const W = 640, H = 320, c = canvas(W, H), x = c.getContext('2d');
    const img = x.createImageData(W, H), d = img.data, r = rng(name.length * 977 + 13);
    // smooth noise of several sizes (value noise, bilinear)
    const octave = (cells) => {
      // square cells, the grid wrapping round (a point past an edge reads from the other side, never off the end)
      const gw = cells + 2, gh = Math.ceil(cells * H / W) + 2, g = new Float32Array(gw * gh).map(() => r());
      const at = (ix, iy) => g[(((iy % gh) + gh) % gh) * gw + (((ix % gw) + gw) % gw)];
      return (px, py) => {
        const fx = (px / W) * cells, fy = (py / W) * cells, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        const sm = (t) => t * t * (3 - 2 * t), a = at(ix, iy), b = at(ix + 1, iy), cc = at(ix, iy + 1), dd = at(ix + 1, iy + 1);
        return (a + (b - a) * sm(tx)) * (1 - sm(ty)) + (cc + (dd - cc) * sm(tx)) * sm(ty);
      };
    };
    const n1 = octave(4), n2 = octave(12), n3 = octave(40), n4 = octave(120), nb = octave(160);
    const lerp = (a, b, t) => a + (b - a) * t;
    const ramp = (stops, t) => {   // [[t, [r,g,b]], …]
      t = clamp(t, 0, 1); let i = 0; while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
      const [t0, c0] = stops[i], [t1, c1] = stops[i + 1], k = clamp((t - t0) / Math.max(1e-6, t1 - t0), 0, 1);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    };
    for (let y = 0; y < H; y++) for (let X = 0; X < W; X++) {
      const v = y / H, i = (y * W + X) * 4;
      const n = n1(X, y) * 0.5 + n2(X, y) * 0.3 + n3(X, y) * 0.15 + n4(X, y) * 0.05;
      let col;
      if (name === 'gold' || name === 'rosegold') {
        // leaf: bright at the top, a hot band of light across, deep at the foot, mottled and streaked
        const band = Math.exp(-Math.pow((v - 0.42) / 0.09, 2)) * 0.55, streak = Math.pow(n4(X * 0.2, y * 3), 3) * 0.3;
        const t = clamp(0.15 + v * 0.75 - band + (n - 0.5) * 0.35 - streak, 0, 1);
        col = ramp(name === 'gold' ? [[0, [255, 250, 214]], [0.25, [255, 214, 92]], [0.55, [222, 150, 22]], [0.8, [150, 82, 6]], [1, [92, 44, 2]]]
          : [[0, [255, 236, 226]], [0.3, [244, 176, 150]], [0.6, [196, 110, 88]], [1, [110, 52, 44]]], t);
      } else if (name === 'stone') {
        // rock: grey and warm, rough, darker cracks, lit from above
        const crack = Math.max(0, 1 - Math.abs(n3(X * 0.7, y * 0.7) - 0.5) * 60) * 0.32;
        const grit = (n4(X * 3, y * 3) - 0.5) * 0.35;
        const t = clamp(0.25 + v * 0.35 + (n - 0.5) * 0.9 + crack + grit, 0, 1);
        col = ramp([[0, [214, 208, 198]], [0.4, [150, 142, 132]], [0.75, [88, 82, 76]], [1, [34, 30, 28]]], t);
      } else if (name === 'fire') {
        // flames rising: white-yellow at the foot, orange, red, dark at the top, licked by noise
        const t = clamp(1 - v + (n - 0.5) * 0.9 - n3(X, y + 0) * 0.15, 0, 1);
        col = ramp([[0, [255, 252, 210]], [0.25, [255, 214, 64]], [0.5, [255, 122, 12]], [0.75, [196, 34, 8]], [1, [70, 6, 4]]], t);
      } else {
        // brushed steel: light, dark band, light again, brushed sideways
        const brush = nb(X * 0.05, y) * 0.25;
        const t = clamp(0.5 + 0.38 * Math.cos(v * Math.PI * 2.2) * -1 + (n - 0.5) * 0.2 + brush - 0.12, 0, 1);
        col = ramp([[0, [252, 253, 255]], [0.45, [196, 204, 214]], [0.7, [118, 128, 142]], [1, [58, 64, 74]]], t);
      }
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    // a glint or two (metal) / hot sparks (fire)
    if (name === 'gold' || name === 'steel' || name === 'rosegold') {
      x.globalCompositeOperation = 'screen';
      for (let k = 0; k < 3; k++) { const gx = r() * W, g = x.createRadialGradient(gx, H * 0.35, 0, gx, H * 0.35, 90); g.addColorStop(0, 'rgba(255,255,255,.55)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, W, H); }
    }
    IMGS.set(key, c);
    return c;
  }
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
  /* an arch: a round top on straight sides, the foot square (a doorway, a church window) */
  function archPath(x, X, Y, W, H) {
    const r = Math.min(W / 2, H);
    x.beginPath(); x.moveTo(X, Y + H); x.lineTo(X, Y + r); x.arc(X + W / 2, Y + r, r, Math.PI, 0); x.lineTo(X + W, Y + H); x.closePath();
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

  /* a shape with holes in it (a pin's eye, a brush's bristles, an icon) is made on its own canvas, then laid on */
  function cutShape(x, w, h, fn) {
    const pad = 4, c = canvas((w + pad * 2) * Q, (h + pad * 2) * Q), cx = c.getContext('2d');
    cx.setTransform(Q, 0, 0, Q, (w / 2 + pad) * Q, (h / 2 + pad) * Q);
    fn(cx);
    x.drawImage(c, -w / 2 - pad, -h / 2 - pad, w + pad * 2, h + pad * 2);
  }
  /*
   * THE ICONS a flyer's details sit by — drawn, so they are sharp at any size
   * and take the flyer's colour: a clock by the time, a calendar by the date,
   * a pin by the address, a phone by the number, and the apps by the handles.
   * Centred on 0, `s` across, in the current fill colour.
   */
  function drawIcon(x, kind, s) {
    const lw = s * 0.11, hole = () => { x.globalCompositeOperation = 'destination-out'; }, back = () => { x.globalCompositeOperation = 'source-over'; };
    x.lineCap = 'round'; x.lineJoin = 'round'; x.strokeStyle = x.fillStyle; x.lineWidth = lw;
    const ring = (r) => { x.beginPath(); x.arc(0, 0, r, 0, Math.PI * 2); x.stroke(); };
    switch (kind) {
      case 'pin':
        x.beginPath(); x.arc(0, -s * 0.12, s * 0.34, Math.PI * 0.85, Math.PI * 2.15); x.lineTo(0, s * 0.48); x.closePath(); x.fill();
        hole(); x.beginPath(); x.arc(0, -s * 0.12, s * 0.13, 0, Math.PI * 2); x.fill(); back(); break;
      case 'clock':
        ring(s * 0.42);
        x.beginPath(); x.moveTo(0, -s * 0.24); x.lineTo(0, 0); x.lineTo(s * 0.17, s * 0.1); x.stroke(); break;
      case 'calendar':
        roundRect(x, -s * 0.42, -s * 0.34, s * 0.84, s * 0.78, s * 0.1); x.stroke();
        x.fillRect(-s * 0.42, -s * 0.34, s * 0.84, s * 0.2);
        x.beginPath(); x.moveTo(-s * 0.2, -s * 0.48); x.lineTo(-s * 0.2, -s * 0.26); x.moveTo(s * 0.2, -s * 0.48); x.lineTo(s * 0.2, -s * 0.26); x.stroke();
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) x.fillRect(-s * 0.27 + i * s * 0.2, s * 0.0 + j * s * 0.17, s * 0.12, s * 0.1);
        break;
      case 'phone':
        x.save(); x.rotate(-Math.PI / 4);
        roundRect(x, -s * 0.09, -s * 0.36, s * 0.18, s * 0.72, s * 0.09); x.fill();
        roundRect(x, -s * 0.2, -s * 0.48, s * 0.4, s * 0.2, s * 0.08); x.fill();
        roundRect(x, -s * 0.2, s * 0.28, s * 0.4, s * 0.2, s * 0.08); x.fill();
        x.restore(); break;
      case 'ig':
        x.lineWidth = s * 0.1; roundRect(x, -s * 0.42, -s * 0.42, s * 0.84, s * 0.84, s * 0.24); x.stroke();
        ring(s * 0.18); x.beginPath(); x.arc(s * 0.24, -s * 0.24, s * 0.06, 0, Math.PI * 2); x.fill(); break;
      case 'fb':
        x.beginPath(); x.arc(0, 0, s * 0.46, 0, Math.PI * 2); x.fill();
        hole(); x.font = `${s * 0.78}px ${fam('Montserrat Black')}, "Arial Black", sans-serif`; x.textAlign = 'center'; x.textBaseline = 'alphabetic'; x.fillText('f', s * 0.04, s * 0.4); back(); break;
      case 'yt':
        roundRect(x, -s * 0.48, -s * 0.32, s * 0.96, s * 0.64, s * 0.18); x.fill();
        hole(); x.beginPath(); x.moveTo(-s * 0.12, -s * 0.16); x.lineTo(s * 0.2, 0); x.lineTo(-s * 0.12, s * 0.16); x.closePath(); x.fill(); back(); break;
      case 'x':
        x.lineWidth = s * 0.09; x.beginPath(); x.moveTo(-s * 0.36, -s * 0.4); x.lineTo(s * 0.36, s * 0.4); x.moveTo(s * 0.36, -s * 0.4); x.lineTo(-s * 0.36, s * 0.4); x.stroke(); break;
      case 'tiktok':
        x.lineWidth = s * 0.14; x.beginPath(); x.moveTo(s * 0.04, -s * 0.44); x.lineTo(s * 0.04, s * 0.2); x.stroke();
        x.beginPath(); x.arc(-s * 0.13, s * 0.22, s * 0.18, 0, Math.PI * 2); x.stroke();
        x.beginPath(); x.moveTo(s * 0.04, -s * 0.42); x.quadraticCurveTo(s * 0.14, -s * 0.2, s * 0.36, -s * 0.18); x.stroke(); break;
      case 'globe':
        ring(s * 0.42); x.lineWidth = lw * 0.7;
        x.beginPath(); x.ellipse(0, 0, s * 0.18, s * 0.42, 0, 0, Math.PI * 2); x.stroke();
        x.beginPath(); x.moveTo(-s * 0.42, 0); x.lineTo(s * 0.42, 0); x.moveTo(-s * 0.36, -s * 0.2); x.lineTo(s * 0.36, -s * 0.2); x.moveTo(-s * 0.36, s * 0.2); x.lineTo(s * 0.36, s * 0.2); x.stroke(); break;
      case 'mail':
        roundRect(x, -s * 0.44, -s * 0.3, s * 0.88, s * 0.6, s * 0.06); x.stroke();
        x.beginPath(); x.moveTo(-s * 0.4, -s * 0.24); x.lineTo(0, s * 0.06); x.lineTo(s * 0.4, -s * 0.24); x.stroke(); break;
      case 'mic':
        roundRect(x, -s * 0.13, -s * 0.46, s * 0.26, s * 0.52, s * 0.13); x.fill();
        x.beginPath(); x.arc(0, -s * 0.06, s * 0.27, 0.1 * Math.PI, 0.9 * Math.PI); x.stroke();
        x.beginPath(); x.moveTo(0, s * 0.22); x.lineTo(0, s * 0.42); x.moveTo(-s * 0.16, s * 0.43); x.lineTo(s * 0.16, s * 0.43); x.stroke(); break;
      case 'live':
        x.beginPath(); x.arc(0, 0, s * 0.16, 0, Math.PI * 2); x.fill();
        x.lineWidth = s * 0.08;
        [0.3, 0.44].forEach((r) => { x.beginPath(); x.arc(0, 0, s * r, -0.3 * Math.PI, 0.3 * Math.PI); x.stroke(); x.beginPath(); x.arc(0, 0, s * r, 0.7 * Math.PI, 1.3 * Math.PI); x.stroke(); });
        break;
      default: x.beginPath(); x.arc(0, 0, s * 0.4, 0, Math.PI * 2); x.fill();
    }
    back();
  }

  /* which sides of a person's picture cut through them (solid right up to that edge) */
  function cutSides(c) {
    const x = c.getContext('2d'), W = c.width, H = c.height;
    const solid = (sx, sy, sw, sh, n) => { const d = x.getImageData(sx, sy, sw, sh).data; let k = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 160) k++; return k >= n; };
    const b = Math.max(1, Math.round(Math.min(W, H) * 0.004));
    return { l: solid(0, 0, b, H, H * b * 0.03), r: solid(W - b, 0, b, H, H * b * 0.03), t: solid(0, 0, W, b, W * b * 0.03) };
  }
  function drawShape(x, L) {
    const w = L.w, h = L.h;
    x.fillStyle = fillOf(x, L.fill, w, h);
    if (L.shadow) { x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 24 * Q; x.shadowOffsetY = 8 * Q; }
    switch (L.shape) {
      case 'pill': roundRect(x, -w / 2, -h / 2, w, h, h / 2); x.fill(); break;
      case 'arch':
        if (L.line) { x.lineWidth = L.line; x.strokeStyle = x.fillStyle; archPath(x, -w / 2 + L.line / 2, -h / 2 + L.line / 2, w - L.line, h - L.line); x.stroke(); }
        else { archPath(x, -w / 2, -h / 2, w, h); x.fill(); }
        break;
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
      case 'pin': cutShape(x, w, h, (c) => { c.fillStyle = fillOf(c, L.fill, w, h); drawIcon(c, 'pin', Math.min(w, h)); }); break;
      case 'fade': {
        const g = x.createLinearGradient(0, -h / 2, 0, h / 2);
        const col = typeof L.fill === 'string' ? L.fill : '#000000';
        g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.55, rgba(col, (L.strength || 0.85) * 0.75)); g.addColorStop(1, rgba(col, L.strength || 0.85));
        x.fillStyle = g; x.fillRect(-w / 2, -h / 2, w, h); break;
      }
      /* a banner with a notched tail — JOIN US FOR OUR, THEME:, NIGHT OF */
      case 'ribbon': {
        const k = Math.min(h * 0.45, w * 0.18), side = L.tail || 'right';
        x.beginPath(); x.moveTo(-w / 2, -h / 2); x.lineTo(w / 2, -h / 2);
        if (side === 'right' || side === 'both') { x.lineTo(w / 2 - k, 0); }
        x.lineTo(w / 2, h / 2); x.lineTo(-w / 2, h / 2);
        if (side === 'left' || side === 'both') x.lineTo(-w / 2 + k, 0);
        x.closePath(); x.fill(); break;
      }
      /* >>>>> — the row of arrows that leads into an address */
      case 'chevrons': {
        const n = L.n || 5, cw = w / n, t = Math.max(2, cw * 0.32), a = Math.min(cw * 0.5, h * 0.42), dir = L.dir === 'left' ? -1 : 1;
        x.save(); if (dir < 0) x.scale(-1, 1);
        for (let i = 0; i < n; i++) {
          const x0 = -w / 2 + cw * i;
          x.globalAlpha = L.trail ? 0.35 + 0.65 * (i + 1) / n : 1;
          x.beginPath(); x.moveTo(x0, -h / 2); x.lineTo(x0 + t, -h / 2); x.lineTo(x0 + t + a, 0); x.lineTo(x0 + t, h / 2); x.lineTo(x0, h / 2); x.lineTo(x0 + a, 0); x.closePath(); x.fill();
        }
        x.restore(); break;
      }
      /* a swoosh: a crescent of colour that thins to nothing at both ends (the orange arc under a line-up) */
      case 'swoosh': {
        const up = L.bend == null ? 1 : L.bend, N = 48, th = L.thick || h * 0.22, base = (h / 2 - th / 2) * (up < 0 ? -1 : 1);
        const pt = (s) => [-w / 2 + w * s, base - (h - th) * 4 * s * (1 - s) * up];
        const top = [], bot = [];
        for (let i = 0; i <= N; i++) {
          const s = i / N, [px, py] = pt(s), [qx, qy] = pt(Math.min(1, s + 1 / N)), [rx, ry] = pt(Math.max(0, s - 1 / N));
          const dx = qx - rx, dy = qy - ry, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l, t = th * Math.pow(Math.sin(Math.PI * s), 0.7) / 2;
          top.push([px + nx * t, py + ny * t]); bot.push([px - nx * t, py - ny * t]);
        }
        x.beginPath(); top.forEach(([px, py], i) => (i ? x.lineTo(px, py) : x.moveTo(px, py))); bot.reverse().forEach(([px, py]) => x.lineTo(px, py)); x.closePath(); x.fill();
        break;
      }
      /* a stroke of paint with dry, broken ends — under a THEME word, a date, a name */
      case 'brush': cutShape(x, w, h, (x) => {
        x.fillStyle = fillOf(x, L.fill, w, h);
        const r = rng(L.seed || 5), step = 6;
        x.beginPath(); x.moveTo(-w / 2 + r() * 14, -h / 2 + r() * 4);
        for (let px = -w / 2; px <= w / 2; px += step) x.lineTo(px, -h / 2 + (r() - 0.5) * h * 0.08 + (Math.abs(px) > w * 0.42 ? r() * h * 0.25 : 0));
        for (let py = -h / 2; py <= h / 2; py += step) x.lineTo(w / 2 - r() * w * 0.04, py);
        for (let px = w / 2; px >= -w / 2; px -= step) x.lineTo(px, h / 2 + (r() - 0.5) * h * 0.08 - (Math.abs(px) > w * 0.42 ? r() * h * 0.25 : 0));
        for (let py = h / 2; py >= -h / 2; py -= step) x.lineTo(-w / 2 + r() * w * 0.03, py);
        x.closePath(); x.fill();
        // the bristles: thin dry streaks through the ends
        x.globalCompositeOperation = 'destination-out';
        for (let i = 0; i < 26; i++) {
          const yy = -h / 2 + r() * h, len = w * (0.04 + r() * 0.16), left = r() > 0.5;
          x.fillRect(left ? -w / 2 - 2 : w / 2 - len + 2, yy, len, Math.max(1, r() * h * 0.05));
        }
        x.globalCompositeOperation = 'source-over';
      }); break;
      /* the little icons by the details: clock, calendar, phone, and the social apps */
      case 'icon': cutShape(x, w, h, (c) => { c.fillStyle = fillOf(c, L.fill, w, h); drawIcon(c, L.icon || 'clock', Math.min(w, h)); }); break;
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
    x.globalCompositeOperation = L.blend || 'screen';   // (a haze of colour is laid on as it is: screened, it goes pastel)
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
      /* shards of stone flying off the foot of a title (BREAK EVERY CHAIN) */
      case 'debris': {
        x.globalCompositeOperation = 'source-over';
        for (let i = 0; i < (L.n || 60); i++) {
          const px = L.x - L.w / 2 + r() * L.w, py = L.y - L.h / 2 + r() * L.h, sz = 3 + r() * r() * (L.size || 16);
          x.save(); x.translate(px, py); x.rotate(r() * Math.PI * 2);
          x.fillStyle = r() > 0.78 ? rgba(c1, 0.95) : rgba(mix(p.deep, '#000000', 0.5), 0.92);
          x.beginPath(); x.moveTo(-sz, -sz * 0.4); x.lineTo(sz * 0.6, -sz * 0.75); x.lineTo(sz, sz * 0.3); x.lineTo(-sz * 0.25, sz * 0.85); x.closePath(); x.fill(); x.restore();
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
      /* a sunburst behind the preacher: rays all the way round from one point, hot in the middle */
      case 'burst': {
        const n = L.n || 36;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.08, len = Math.max(L.w, L.h) * (0.55 + r() * 0.5), wd = 0.018 + r() * 0.03;
          const g = x.createLinearGradient(L.x, L.y, L.x + Math.cos(a) * len, L.y + Math.sin(a) * len);
          g.addColorStop(0, rgba(c2, 0.5)); g.addColorStop(0.25, rgba(c1, 0.32)); g.addColorStop(1, rgba(c1, 0));
          x.fillStyle = g; x.beginPath(); x.moveTo(L.x, L.y);
          x.lineTo(L.x + Math.cos(a - wd) * len, L.y + Math.sin(a - wd) * len); x.lineTo(L.x + Math.cos(a + wd) * len, L.y + Math.sin(a + wd) * len); x.closePath(); x.fill();
        }
        blob(L.x, L.y, L.w * 0.32, L.h * 0.32, c2, 0.9);
        blob(L.x, L.y, L.w * 0.6, L.h * 0.6, c1, 0.55);
        break;
      }
      /* smoke and haze drifting through the light — soft overlapping wisps, never a flat fog */
      case 'smoke': {
        const n = L.n || 26;
        for (let i = 0; i < n; i++) {
          const px = L.x - L.w / 2 + r() * L.w, py = L.y - L.h / 2 + r() * L.h, rx = L.w * (0.12 + r() * 0.22), ry = rx * (0.25 + r() * 0.35);
          blob(px, py, rx, ry, r() > 0.6 ? c2 : c1, 0.1 + r() * 0.16, (r() - 0.5) * 1.2);
        }
        break;
      }
      /* one long, thin line of hard light across the page (the gleam through a title) */
      case 'beam': {
        const rot = (L.rot || 0) * Math.PI / 180;
        blob(L.x, L.y, L.w / 2, Math.max(2, L.h * 0.06), '#ffffff', 0.95, rot);
        blob(L.x, L.y, L.w / 2, Math.max(6, L.h * 0.3), c1, 0.55, rot);
        blob(L.x, L.y, L.w * 0.3, L.h, c1, 0.25, rot);
        break;
      }
      case 'flare': {
        blob(L.x, L.y, L.w * 0.12, L.w * 0.12, '#ffffff', 0.95);
        blob(L.x, L.y, L.w * 0.4, L.w * 0.4, c1, 0.6);
        blob(L.x, L.y, L.w / 2, Math.max(3, L.w * 0.012), '#ffffff', 0.85);
        blob(L.x, L.y, L.w / 2, Math.max(6, L.w * 0.04), c2, 0.5);
        break;
      }
      /*
       * SILK: great sweeping arcs of light across the page, each a soft ribbon
       * of colour with a bright thread along it, rising from the lower left —
       * the electric backdrop of the modern church flyer ("this one is better
       * than all the others"). Drawn here, so it costs no painting at all.
       */
      case 'silk': {
        const W = S.w, H = S.h, n = L.n || 7;
        for (let i = 0; i < n; i++) {
          const cx = W * (-0.4 + r() * 0.55), cy = H * (0.9 + r() * 0.45), rx = W * (0.8 + r() * 0.8), ry = rx * (0.45 + r() * 0.3), rot = -0.3 + r() * 0.35;
          const col = i % 3 === 2 ? c2 : c1, peak = 0.3 + r() * 0.45, a = 0.55 + r() * 0.4;
          x.save(); x.translate(cx, cy); x.rotate(rot);
          const along = (k) => { const g = x.createLinearGradient(-rx, 0, rx, 0); g.addColorStop(0, rgba(col, 0)); g.addColorStop(Math.max(0.05, peak - 0.25), rgba(col, k * 0.5)); g.addColorStop(peak, rgba('#ffffff', k)); g.addColorStop(Math.min(0.95, peak + 0.3), rgba(col, k * 0.4)); g.addColorStop(1, rgba(col, 0)); return g; };
          const arc = (k) => { x.beginPath(); x.ellipse(0, 0, Math.max(1, rx - k), Math.max(1, ry - k), 0, Math.PI, Math.PI * 2); };
          // the ribbon: a band of light inside the edge, truly soft — drawn far off the page and only its blurred
          // shadow laid here (a blur every phone draws; the canvas filter is not on all of them)
          const band = 40 + r() * 90, m = x.getTransform(), far = 30000;
          x.save(); x.setTransform(m.a, m.b, m.c, m.d, m.e + far, m.f);
          x.shadowOffsetX = -far; x.shadowColor = rgba(col, 1); x.shadowBlur = band * 0.9 * Q;
          x.lineWidth = band; x.strokeStyle = along(0.22 * (0.6 + a)); arc(band * 0.55); x.stroke();
          x.restore();
          // the edge, a bright thread
          x.lineWidth = 1.8 + r() * 2.4; x.strokeStyle = along(Math.min(1, a + 0.2)); x.shadowColor = rgba(col, 0.95); x.shadowBlur = 16 * Q; arc(0); x.stroke();
          x.restore();
        }
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

  /* specks and scratches knocked out of a title — sprayed through a stencil, not printed on plastic */
  let erodeC = null;
  function erodeTile() {
    if (erodeC) return erodeC;
    erodeC = canvas(240, 240);
    const x = erodeC.getContext('2d'), r = rng(77);
    for (let i = 0; i < 620; i++) { x.fillStyle = `rgba(0,0,0,${0.55 + r() * 0.45})`; x.beginPath(); x.arc(r() * 240, r() * 240, 0.3 + r() * r() * 2.4, 0, Math.PI * 2); x.fill(); }
    for (let i = 0; i < 18; i++) { x.strokeStyle = 'rgba(0,0,0,.7)'; x.lineWidth = 0.4 + r() * 0.8; x.beginPath(); const sx = r() * 240, sy = r() * 240; x.moveTo(sx, sy); x.lineTo(sx + (r() - 0.5) * 50, sy + (r() - 0.5) * 12); x.stroke(); }
    return erodeC;
  }
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
    const key = JSON.stringify([Q, L.text, L.font, L.size, L.fit, L.maxH, L.maxW, L.stretch, L.wide, L.fill, L.stroke, L.strokeColor, L.extrude, L.extrudeColor, L.bevel, L.edge, L.edgeColor, L.glow, L.shadow, L.shadowColor, L.letter, L.align, L.line, L.slant, L.upper, L.grain, L.speck, L.erode, L.imgFill, L.imgFillA, L.imgFill && IMGS.has(L.imgFill)]);
    if (txtCache.has(key)) return txtCache.get(key);
    const m = (measC || (measC = canvas(8, 8))).getContext('2d');
    let text = String(L.text == null ? '' : L.text);
    // script lettering in capitals is a jumble of swashes ("WORD" in Alex Brush): a word typed in capitals is set Like This
    if (!L.upper && /[A-Z]{2}/.test(text) && text === text.toUpperCase() && (FONTS.find((q) => q.id === L.font) || {}).kind === 'script') {
      text = text.toLowerCase().replace(/(^|[\s\n-])([a-z])/g, (m, a, c) => a + c.toUpperCase());
    }
    const lines = (L.upper ? text.toUpperCase() : text).split('\n');
    const sy = L.stretch || 1, sx = L.wide || 1;   // taller (condensed) / wider (extended) letters
    let size = L.size || 80;
    const fontOf = (s) => `${s}px ${fam(L.font || 'Anton')}, "Arial Black", Impact, sans-serif`;
    const lsp = (s) => (L.letter || 0) * s;
    const metr = (ln, s) => {
      m.font = fontOf(s);
      if (!L.letter || ln.length < 2) {
        const t = m.measureText(ln || ' ');
        return { l: (t.actualBoundingBoxLeft || 0) * sx, r: (t.actualBoundingBoxRight != null ? t.actualBoundingBoxRight : t.width) * sx, a: (t.actualBoundingBoxAscent != null ? t.actualBoundingBoxAscent : s * 0.72) * sy, d: (t.actualBoundingBoxDescent || 0) * sy };
      }
      let x = 0, l = 0, r = 0, a = 0, d = 0; const ch = Array.from(ln);
      ch.forEach((c, i) => { const t = m.measureText(c); if (i === 0) l = t.actualBoundingBoxLeft || 0; r = x + (t.actualBoundingBoxRight != null ? t.actualBoundingBoxRight : t.width); a = Math.max(a, t.actualBoundingBoxAscent || 0); d = Math.max(d, t.actualBoundingBoxDescent || 0); x += t.width + lsp(s); });
      return { l: l * sx, r: r * sx, a: a * sy, d: d * sy };
    };
    const inkW = (ln, s) => { const t = metr(ln, s); return Math.max(1, t.l + t.r); };
    const widest = (s) => Math.max(1, ...lines.map((ln) => inkW(ln, s)));
    // a long single line that would have to shrink below two-thirds of its size is broken in two instead (an address stays readable)
    if (L.maxW && !L.fit && lines.length === 1 && /\s/.test(lines[0]) && widest(size) > L.maxW / (SMALL_INFO.test(L.name || '') ? 0.9 : 0.66)) {
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
      const px = ox + xs[i] + dx, py = oy + ys[i] + dy;
      ctx.save(); ctx.translate(px, py); if (sy !== 1 || sx !== 1) ctx.scale(sx, sy);
      if (!L.letter || ln.length < 2) ctx[how](ln, 0, 0);
      else { let lx = 0; for (const ch of ln) { ctx[how](ch, lx, 0); lx += ctx.measureText(ch).width + lsp(size); } }
      ctx.restore();
    });
    setT(x); x.font = fontOf(size); x.textBaseline = 'alphabetic'; x.lineJoin = 'round';
    if (L.glow) { x.save(); x.shadowColor = L.glow; x.shadowBlur = size * 0.45 * Q; x.fillStyle = L.glow; draw(x, 0, 0, 'fillText'); if (depth) draw(x, depth * 0.55, depth, 'fillText'); x.restore(); }
    // a SOFT shadow in the flyer's own darkest colour — a hard black drop under every word is what reads as clip-art
    if (L.shadow && L.fill !== 'none') { const sc = L.shadowColor || 'rgba(0,0,0,.6)'; x.save(); x.shadowColor = sc; x.shadowBlur = size * 0.22 * Q; x.shadowOffsetY = size * 0.025 * Q; x.fillStyle = sc; draw(x, depth * 0.55, depth, 'fillText'); x.restore(); }
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
      if (im) { fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = L.imgFillA == null ? 0.9 : L.imgFillA; cover(fx, im, 0, 0, face.width, face.height); fx.globalAlpha = 1; }
      if (L.erode) { fx.globalCompositeOperation = 'destination-out'; fx.globalAlpha = Math.min(1, L.erode); fx.fillStyle = fx.createPattern(erodeTile(), 'repeat'); fx.fillRect(0, 0, face.width, face.height); fx.globalAlpha = 1; }
      if (L.speck) { fx.globalCompositeOperation = 'source-atop'; fx.globalAlpha = 0.22 * L.speck; fx.fillStyle = fx.createPattern(grainTile(), 'repeat'); fx.fillRect(0, 0, face.width, face.height); fx.globalAlpha = 1; }
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
        gg.addColorStop(0, 'rgba(255,255,255,.16)'); gg.addColorStop(0.5, 'rgba(255,255,255,0)'); gg.addColorStop(1, 'rgba(0,0,0,.10)');
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
    const key = [IMGS_KEY(im), w, h, sr ? [sr.x, sr.y, sr.w, sr.h].map((v) => (+v).toFixed(4)).join(',') : '', L.gray ? 1 : 0, L.fade || 0, L.glow || '', L.rim || '', L.bright || 0, L.contrast || 0, L.sat || 0, L.radius || 0, L.round ? 1 : 0, L.arch ? 1 : 0, L.outline || '', L.tint ? JSON.stringify(L.tint) : '', L.rimW || 0, L.shade || '', L.feather || 0, L.fadeLight ? 1 : 0, L.hard ? 1 : 0].join('|');
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
    else if (L.arch) { archPath(lx, 0, 0, w, h); lx.clip(); }
    else if (L.radius) { roundRect(lx, 0, 0, w, h, L.radius * Q); lx.clip(); }
    if (body) lx.drawImage(body, 0, 0); else lx.drawImage(pic, 0, 0, w, h);
    if (L.feather) {
      /*
       * ►► THE CUT-OUT AS SAVED IN MY CHURCH. ◄◄ Its outline used to be softened here as well — blurred all round,
       * heavily from the waist down — which ate an ear, a hand, a sleeve ("it is still cutting some off, it must be
       * exactly the same as the saved in My church"). The cut-out's own edge is soft already. The one edge faded is
       * one the original photo cut straight through (an arm at its side), so it never ends on a straight line.
       */
      const cut = cutSides(layer);
      if (!L.round && !L.radius && !L.arch && !L.hard) {
        // where the photo's own frame cut through them (an arm, a shoulder at its side): faded, never a straight line —
        // only there. Faded on every side of everyone, it took the edge of a turned face and the top of the hair
        // ("more of the speaker's face is removed than in My church").
        lx.globalCompositeOperation = 'destination-out';
        const side = (x0, x1) => { const sg = lx.createLinearGradient(x0, 0, x1, 0); sg.addColorStop(0, 'rgba(0,0,0,1)'); sg.addColorStop(1, 'rgba(0,0,0,0)'); lx.fillStyle = sg; lx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h); };
        if (cut.l) side(0, w * 0.05);
        if (cut.r) side(w, w * 0.95);
        if (cut.t) { const tg = lx.createLinearGradient(0, 0, 0, h * 0.025); tg.addColorStop(0, 'rgba(0,0,0,.9)'); tg.addColorStop(1, 'rgba(0,0,0,0)'); lx.fillStyle = tg; lx.fillRect(0, 0, w, h * 0.025); }
        lx.globalCompositeOperation = 'source-over';
      }
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
      // (on a light page, into the light: a dark foot on white reads as dirt)
      if (!L.fadeLight) {
        lx.globalCompositeOperation = 'source-atop';
        const sg = lx.createLinearGradient(0, h * (1 - L.fade * 1.6), 0, h);
        sg.addColorStop(0, 'rgba(0,0,0,0)'); sg.addColorStop(0.55, 'rgba(0,0,0,.45)'); sg.addColorStop(1, 'rgba(0,0,0,.85)');
        lx.fillStyle = sg; lx.fillRect(0, 0, w, h);
      }
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
    } else if (L.plain) {   // a plain page (the bright and simple looks): one colour, nothing painted
      x.fillStyle = gradAt(x, L.plain, W / 2, H / 2, W, H); x.fillRect(0, 0, W, H);
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

  /*
   * ►► EVERY WORD READABLE. ◄◄ A word in one plain colour is read against
   * whatever is under it once the flyer is drawn up to it: a purple "7PM" on
   * a dark red picture, dark letters on a bar the palette made dark. Where it
   * would not stand out, it is drawn white (or near-black on something
   * light). A colour picked by hand in the editor is left as chosen.
   */
  const lumOf = (r, g, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  function inkFor(x, L) {
    if (L.inkSet || L.imgFill || typeof L.fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(L.fill) || (L.opacity != null && L.opacity < 0.6)) return L;
    try {
      const b = boxOf(L), s = L.s || 1, sideways = Math.abs(((L.rot || 0) % 180 + 180) % 180 - 90) < 30;
      let w = b.w * s * 0.8, h = b.h * s * 0.7; if (sideways) { const t = w; w = h; h = t; }
      const cw = x.canvas.width, ch = x.canvas.height;
      const X0 = Math.max(0, Math.floor((L.x - w / 2) * Q)), Y0 = Math.max(0, Math.floor((L.y - h / 2) * Q));
      const X1 = Math.min(cw, Math.ceil((L.x + w / 2) * Q)), Y1 = Math.min(ch, Math.ceil((L.y + h / 2) * Q));
      if (X1 - X0 < 2 || Y1 - Y0 < 2) return L;
      const d = x.getImageData(X0, Y0, X1 - X0, Y1 - Y0).data;
      const step = Math.max(1, Math.floor(d.length / 4 / 4000)) * 4;
      let sum = 0, n = 0;
      for (let i = 0; i < d.length; i += step) { if (d[i + 3] < 8) continue; sum += lumOf(d[i], d[i + 1], d[i + 2]); n++; }
      if (!n) return L;
      const bg = sum / n, [r, g, bl] = hexRgb(L.fill), fg = lumOf(r, g, bl);
      const ratio = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
      if (ratio >= 2.6) return L;
      const ink = bg < 0.32 ? '#ffffff' : '#141414';
      return Object.assign({}, L, { fill: ink });
    } catch (e) { return L; }   // (a picture another site sent cannot be read: drawn as it is)
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
      const t = textCanvas(inkFor(x, L));
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
    try {
      for (const L of S.layers) drawLayer(x, S, L);
      if (S.finish !== false) { x.save(); x.globalCompositeOperation = 'overlay'; x.globalAlpha = 0.05; x.fillStyle = x.createPattern(grainTile(), 'repeat'); x.fillRect(0, 0, S.w, S.h); x.restore(); }
    } finally { Q = 1; }
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
    // GENEROUS, all of it: an outline drawn tight took bites out of a sleeve, a head-tie, an agbada, and cut a
    // pulpit away along a hard line ("too much was removed") — what it removes now is only what is well clear
    // of the person, and it goes softly (the blur below), so anything left beside them fades, never stops
    const hr = Math.max(sw * 0.5, Math.hypot(nose.x - sm.x, nose.y - sm.y) * 0.95);
    x.beginPath(); x.ellipse(nose.x, nose.y - hr * 0.45, hr * 1.5, hr * 1.85, 0, 0, Math.PI * 2); x.fill();
    line([nose, sm], sw * 0.5);
    // the body to the hips
    const lh = P(23, 0.2), rh = P(24, 0.2);
    const hy = lh && rh ? (lh.y + rh.y) / 2 : sm.y + sw * 1.7;
    const L2 = lh || { x: ls.x, y: hy }, R2 = rh || { x: rs.x, y: hy };
    x.beginPath(); x.moveTo(ls.x, ls.y); x.lineTo(rs.x, rs.y); x.lineTo(R2.x, R2.y); x.lineTo(L2.x, L2.y); x.closePath(); x.fill();
    x.lineWidth = sw * 1.0; x.stroke();
    // arms and hands (a microphone in a hand stays)
    [[11, 13, 15, 19, 21], [12, 14, 16, 20, 22]].forEach(([s, e, wr, ix, th]) => {
      const S2 = P(s, 0.2), E = P(e, 0.35), Wr = P(wr, 0.35);
      line([S2, E, Wr], sw * 0.36);
      if (Wr) { dot(Wr, sw * 0.55); line([Wr, P(ix, 0.3)], sw * 0.26); line([Wr, P(th, 0.3)], sw * 0.26); }
      else if (E) dot(E, sw * 0.4);
    });
    // the legs only when they can be seen (a podium in front of them is not them)
    [[23, 25, 27, 31, 29], [24, 26, 28, 32, 30]].forEach(([hp, kn, an, ft, hl]) => {
      const K = P(kn, 0.6); if (!K) return;
      line([P(hp, 0.2) || { x: (lh || ls).x, y: hy }, K, P(an, 0.6), P(ft, 0.6)], sw * 0.32);
      dot(P(hl, 0.6), sw * 0.24);
    });
    return softened(c, Math.max(4, sw * 0.16));
  }
  /* the cut-out as it is, the empty margin round it trimmed off (nothing of the person touched) */
  function cropToPerson(cv) {
    const W = cv.width, H = cv.height, p = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (p[(y * W + x) * 4 + 3] > 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; y1 = y; }
    if (x1 < x0) return { c: cv, x0: 0, y0: 0 };
    const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02);
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + 1);
    if (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1) return { c: cv, x0: 0, y0: 0 };
    const out = canvas(x1 - x0 + 1, y1 - y0 + 1);
    out.getContext('2d').drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    return { c: out, x0, y0 };
  }
  /* the person's own outline: only the biggest shape, trimmed tight (feet at the bottom edge) — on the way INTO My
     church (tidyCut), where the result is seen and can be fixed; never again on the way to a flyer */
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
    /*
     * ►► A SMOOTH EDGE, NOT BLOCKS. ◄◄ "The cut out of the man is not good, the shoulders are so pixeled." What is
     * kept was decided on the small copy and applied to the photo a small pixel at a time — five photo pixels square
     * — so the soft edge of a shoulder was chopped into steps. Now what is kept (the kept shapes, and the faint edge
     * three small pixels round them: at the outline the small copy is fainter than the photo, and a cheek, an ear, the
     * hair must stay) is softened and laid over the photo as a smooth mask: the cut-out's own edge is left as it was.
     */
    const K = new Uint8ClampedArray(w * h * 4), R = 3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l0 = lab[y * w + x];
      let on = l0 >= 0 && keep[l0];
      // (a shape that is not kept stays out, even beside the person)
      if (!on && l0 < 0) {
        for (let dy = -R; dy <= R && !on; dy++) for (let dx = -R; dx <= R && !on; dx++) {
          const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h || dx * dx + dy * dy > R * R) continue;
          const l = lab[Y * w + X]; if (l >= 0 && keep[l]) on = true;
        }
      }
      if (on) K[(y * w + x) * 4 + 3] = 255;
    }
    const km = canvas(w, h), kx = km.getContext('2d');
    kx.putImageData(new ImageData(K, w, h), 0, 0);
    const kb = canvas(w, h), kbx = kb.getContext('2d');
    kbx.filter = 'blur(1px)'; kbx.drawImage(km, 0, 0); kbx.filter = 'none';
    const full = canvas(W, H), fx = full.getContext('2d', { willReadFrequently: true });
    fx.drawImage(cv, 0, 0);
    fx.globalCompositeOperation = 'destination-in';
    fx.imageSmoothingEnabled = true; fx.imageSmoothingQuality = 'high';
    fx.drawImage(kb, 0, 0, W, H);
    fx.globalCompositeOperation = 'source-over';
    const p = fx.getImageData(0, 0, W, H).data;
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (p[(y * W + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 <= x0 || y1 <= y0) return { c: cv, x0: 0, y0: 0 };
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
      // (the pose places them on the page — and nothing more: trimming the cut-out to an outline drawn from it, an oval
      //  round the nose, took the far cheek and the back of the Bishop's head when he sang side on — "his face is too
      //  slim, parts still cut off". The cut-out is used as it is in the bank, where it can be seen and fixed.)
      // ►► EXACTLY AS SAVED IN MY CHURCH. ◄◄ "It is still cutting some off… it must be exactly the same as the saved
      // in My church": nothing is taken from it here — no bits dropped, no edge smoothed, no stop above a lectern's
      // glass. Only the empty margin round it is trimmed. (My church is where a cut-out is checked and fixed.)
      const t = cropToPerson(c);
      const meta = metaOf(t.c, lm, t.x0, t.y0, W0, H0);
      return { img: t.c, meta };
    })().catch(() => ({ img: im, meta: null }));
    PREP.set(im, job);
    return job;
  }

  /*
   * THE PHOTO ITSELF, for a frame. The bank keeps the photo a cut-out was made
   * from; a framed look (an arch, a circle) shows that instead — no edge to go
   * wrong. Where the face and shoulders are comes from the pose, as for a
   * cut-out; the top of the head (no outline to find it by) from the face.
   */
  function photoMeta(lm, W, H) {
    const P = (i, v) => { const q = lm && lm[i]; return q && (q.visibility == null || q.visibility >= v) ? { x: q.x * W, y: q.y * H } : null; };
    const ls = P(11, 0.3), rs = P(12, 0.3), nose = P(0, 0.3);
    if (!ls || !rs || !nose) return null;
    const sy = (ls.y + rs.y) / 2, sw = Math.max(8, Math.hypot(ls.x - rs.x, ls.y - rs.y));
    if (sy <= nose.y) return null;
    const top = Math.max(0, nose.y - Math.max(sw * 0.45, (sy - nose.y) * 0.9));
    const lh = P(23, 0.45), rh = P(24, 0.45), hy = lh && rh ? (lh.y + rh.y) / 2 : null;
    const ws = [P(15, 0.35), P(16, 0.35)].filter(Boolean).map((q) => q.y), wy = ws.length ? Math.max(...ws) : null;
    return { w: W, h: H, top, cx: nose.x, sy: Math.max(sy, top + 10), sw, hy: hy && hy > sy + 10 ? hy : null, wy: wy && wy > sy ? wy : null, photo: true };
  }
  const RAWP = new WeakMap();
  function prepareRaw(im) {
    if (!RAWP.has(im)) {
      RAWP.set(im, (async () => {
        const lm = root.FlyerAI && root.FlyerAI.poseOf ? await root.FlyerAI.poseOf(im) : null;
        return photoMeta(lm, iw(im), ih(im));
      })().catch(() => null));
    }
    return RAWP.get(im);
  }

  /* ================================================================ LAYOUTS */

  // the details people read on a phone (the address, the handles, a phone number, a detail's note) never smaller than this:
  // at 14–16 on a 1080 flyer they were specks on the screen. Set here, before a layout places them, so they are placed at their size.
  const SMALL_INFO = /^(Venue|Handles|Contact|Phone|Minister title)$|note$/;
  const T = (o) => {
    const L = Object.assign({ id: uid(), type: 'text', x: 540, y: 200, rot: 0, s: 1, font: 'Anton', size: 100, fill: '#ffffff', align: 'center', line: 1 }, o);
    if (SMALL_INFO.test(L.name || '') && L.size < 19) L.size = Math.min(19, Math.round(L.size * 1.3));
    return L;
  };
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
    const style = varyStyle(o.style || {});
    return col(lines.filter(Boolean).map((ln, i, a) => T(Object.assign({ name: (o.name || 'Title') + (a.length > 1 ? ' ' + (i + 1) : ''), text: ln, fit: o.fit, maxH: o.maxH }, style))),
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
  // "The Power House Int'l Galway (H91 958A)" under "The Power House International": the name is not printed twice
  // (a phone types the apostrophe curly: Int’l)
  const nameWords = (t) => String(t || '').toLowerCase().replace(/\bint['’‘ʼ`]?l\b|\bintl\b/g, 'international').replace(/\bmin\b\.?/g, 'ministries')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && w !== 'the').join(' ');
  function withoutChurch(venue, church) {
    const ch = nameWords(church), v = String(venue || '').trim();
    if (!ch || !v) return v;
    // the shortest start of the address that reads as the church's name (with or without a comma after it)
    const re = /[\s,;:\-–—]+/g; let m;
    while ((m = re.exec(v))) {
      const head = v.slice(0, m.index), rest = v.slice(m.index + m[0].length).trim();
      if (!rest) break;
      if (nameWords(head) === ch) return rest;
    }
    return v;
  }
  function venueParts(D) {
    // exactly as typed in the details (the church's name was being cut off the front — not wanted)
    return String(D.f.venue || '').split(/\s*,\s*/).filter(Boolean).slice(0, 3);
  }
  const venueText = (D) => venueParts(D).join(', ');
  const venueLines = (D, n) => { const p = venueParts(D); if (p.length <= n) return p.join(',\n'); return [p.slice(0, p.length - n + 1).join(', ')].concat(p.slice(p.length - n + 1)).join(',\n'); };
  const spsOf = (D) => D.sp.filter((s) => imgOf(s.img));
  const sp0 = (D) => spsOf(D)[0] || null;
  /* two or more ministers on one flyer: every one of them named ("BISHOP DAVID RICHMAN & PASTOR GRACE RICHMAN") */
  const namesOf = (ps) => ps.map((s) => String(s.name || '').trim()).filter(Boolean).join('  &  ');
  // backlit in the flyer's colour, softly — a white line round a person reads as a sticker
const lit = (p) => ({ glow: rgba(p.accent, 0.28), rim: rgba(mix(p.accent, '#ffffff', 0.35), 0.55), rimW: 1.1, tint: { color: p.accent, a: 0.28, fall: 0.35 } });
  /* titles that stand off the page: chrome or gold, bevelled, on a deep block with a dark edge */
  const CHROME = { stops: ['#ffffff', '#ffffff', '#eceff3', '#d5dae1'], angle: 90 };
  const GOLD = { stops: ['#fff6c7', '#ffe066', '#f5b301', '#ffd84d', '#c97a00'], angle: 90 };
  // refined, not WordArt: a shallow block in the flyer's own dark colour, a soft light on top, a real shadow
  const solid3d = (p, o) => Object.assign({ extrude: 2, extrudeColor: [mix(p.deep, '#000000', 0.15), mix(p.deep, '#000000', 0.55)], shadow: true, speck: 0.6 }, o || {});
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
    // (the top a little above the head, so no hair is ever cut by the picture's own top)
    return { t: Math.max(0, m.top - u * 0.15), nb, cx: m.cx };
  }
  function headBox(m, fr, k, left, top, im) {
    // the head is the top of the silhouette (m.cx is the middle of the shoulders, which a turned pose moves off the face)
    const q = im ? quickMeta(im) : null, hx = q ? q.cx * (m.w / Math.max(1, q.w)) : m.cx;
    const u = Math.max(12, m.sy - m.top), cx = left + hx * k;
    return { l: cx - u * 0.42 * k, r: cx + u * 0.42 * k, t: top + (m.top - fr.t) * k, b: top + (m.top + u * 0.85 - fr.t) * k };
  }
  /* "MEE_TING": the minister in front of the title may cover the foot of the letters (as the references do),
     never so much of them that a word cannot be read — the person goes down until the letters show */
  function keepTitleClear(layers, H) {
    layers.forEach((im, i) => {
      // (one set steady — stopping behind a bar — is placed against the title already: moved down, it would show below the bar)
      if (im.type !== 'image' || !im.head || (im.frame && im.frame.steady)) return;
      let dy = 0;
      layers.slice(0, i).forEach((t) => {
        if (t.type !== 'text' || !/^(Title|Script title|Word)( \d)?$/.test(t.name || '') || t.rot) return;
        const b = box(t), hd = im.head;
        if (b.h < 50 || hd.r <= b.l || hd.l >= b.r || hd.t >= b.b || hd.b <= b.t) return;
        // the head may cover the lowest quarter of a line, no more
        dy = Math.max(dy, b.b - b.h * 0.25 - hd.t);
      });
      if (dy > 0) { dy = Math.min(dy, im.h * 0.3, H * 0.12); im.y += dy; }
    });
  }
  /*
   * ►► THE FIRST NAMED IS NEVER THE SMALLER. ◄◄ "The woman is bigger than the man — it all looks nasty." Each
   * person was sized from their own photo (a bust blown up, a whole figure shrunk), so the Bishop's head came out
   * smaller than the Pastor's beside him. After any layout: no one's head is bigger than the first named's — a
   * bigger one is brought down to it, about their feet (they stand where they stood). Faces in frames (an arch, a
   * circle) are the frames' business.
   */
  function leadFirst(layers, D) {
    const people = layers.filter((l) => l.type === 'image' && l.speaker && l.head && !l.inFrame);
    if (people.length < 2) return;
    const first = D.sp && D.sp[0] && D.sp[0].id;
    const lead = people.find((l) => l.speaker === first) || people[0];
    const hh = (l) => Math.max(1, l.head.b - l.head.t), H0 = hh(lead);
    people.forEach((l) => {
      if (l === lead) return;
      const f = H0 / hh(l);
      if (f >= 0.98) return;
      const foot = l.y + l.h / 2, cx = l.x;
      l.w *= f; l.h *= f; l.y = foot - l.h / 2;
      l.head = { l: cx + (l.head.l - cx) * f, r: cx + (l.head.r - cx) * f, t: foot + (l.head.t - foot) * f, b: foot + (l.head.b - foot) * f };
      // (a frame it was fitted to keeps its foot; its head is now the lead's)
      if (l.frame) l.frame = Object.assign({}, l.frame, { t: foot - (foot - l.frame.t) * f, maxU: Math.min(l.frame.maxU || 1e9, H0 / 0.85) });
    });
  }
  let PAINTED = false;   // buildScene: the preacher is painted into the picture itself — no cut-out on top
  let PAGE_W = 1080;     // buildScene: how wide the page being built is (a flyer 1080, a YouTube thumbnail 1280)
  function hero(sp, o) {
    if (PAINTED) return null;
    const im = imgOf(sp.img); if (!im) return null;
    const m = META.get(sp.img) || quickMeta(im);
    const mode = o.mode || 'waist', fr = frameOf(m, mode);
    // steady: sized by the head and shoulders, whatever the photo — from the crown to the bottom asked for is what the
    // cut-out has clean, but never less than 2.2 of them (a cut-out faded out above a lectern is not blown up into a
    // giant head) nor more than 2.9 (one that goes on is cut at the bottom); and the head never bigger than maxU
    const u0 = Math.max(12, m.sy - m.top);
    const k = o.steady ? Math.min((o.b - o.t) / clamp(Math.min(m.h, fr.nb) - fr.t, 2.2 * u0, 2.9 * u0), (o.maxU || 1e9) / u0) : (o.b - o.t) / Math.max(1, fr.nb - fr.t);
    const vb = o.steady ? Math.min(m.h, fr.nb, fr.t + (o.b - o.t) / k) : Math.min(m.h, fr.nb);
    const h = (vb - fr.t) * k, w = m.w * k;
    // …and lowered till its foot is at that bottom (behind a bar: a lectern's edge goes behind it too), never floating above it
    if (o.steady && o.t + h < o.b - 1) o = Object.assign({}, o, { t: o.b - h, t0: o.t });
    const whole = mode === 'full' && vb >= m.h - 2;
    // a wide photo (arms out, a second person's shoulder) is moved over rather than run into the words beside it
    let X = o.cx + (m.w / 2 - fr.cx) * k;
    if (o.maxR != null) X = Math.min(X, o.maxR - w / 2);
    if (o.minL != null) X = Math.max(X, o.minL + w / 2);
    // never the face off the page: whatever the layout asked, the head stays inside it
    { const hb = headBox(m, fr, k, X - w / 2, o.t, im), pad = 24;
      if (hb.r > PAGE_W - pad) X -= hb.r - (PAGE_W - pad); else if (hb.l < pad) X += pad - hb.l; }
    return IM(Object.assign({
      img: sp.img, name: sp.name || 'Speaker', speaker: sp.id || '', photo: sp.photo || '',
      src: { x: 0, y: fr.t / m.h, w: 1, h: (vb - fr.t) / m.h },
      w, h, x: X, y: o.t + h / 2,
      // the foot melts only where the frame cuts through them, and only a little ("still cutting some off": a third of
      // the person faded away, the hands and the microphone with it); a person who ends above it is shown whole
      fade: whole || vb >= m.h - 2 ? 0 : o.steady ? (o.fade || 0) : clamp(o.fade == null ? 0.16 : o.fade, 0.1, 0.16), feather: 1.4,
      frame: o.steady ? { mode, t: o.t0 == null ? o.t : o.t0, b: o.b, cx: o.cx, steady: true, maxR: o.maxR, maxU: o.maxU } : { mode, t: o.t, b: o.b, cx: o.cx },
      // where the head is on the page (keepTitleClear: a face never hides whole letters of the title)
      head: headBox(m, fr, k, X - w / 2, o.t, im),
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

  /* ---------------------------------------------------- the small craft of those flyers */
  /* tiny tracked capitals — PRESENTS, THEME:, MINISTERING — a whisper next to the title */
  const micro = (text, o) => T(Object.assign({ name: 'Label', text, upper: true, font: 'Montserrat', size: 15, letter: 0.55, fill: rgba('#ffffff', 0.82), shadow: true }, o || {}));
  /* a thin signature script laid across a title — the accent, never the title itself */
  const sig = (text, o) => T(Object.assign({ name: 'Script', text, font: 'Signature', size: 110, rot: -7, fill: '#ffffff', shadow: true }, o || {}));
  /* a group turned about one point, every layer on the same tilt (a whole layout on one angle) */
  function turn(list, deg, cx, cy) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    list.filter(Boolean).forEach((L) => { if (L.type === 'bg' || L.type === 'fx') return; const dx = L.x - cx, dy = L.y - cy; L.x = cx + dx * c - dy * s; L.y = cy + dx * s + dy * c; L.rot = (L.rot || 0) + deg; });
    return list;
  }
  /* the handles with each app's icon in front of them */
  function socialRow(D, o) {
    const h = String(D.f.handles || '').trim(); if (!h) return [];
    const ink = o.ink || '#ffffff', size = o.size || 18, ic = Math.round(size * 1.3);
    const icons = (o.icons || ['ig', 'fb', 'yt']).map((k) => SH({ name: 'Icon', shape: 'icon', icon: k, fill: ink, w: ic, h: ic }));
    const t = T({ name: 'Handles', text: h, font: o.font || 'Montserrat', size, fill: ink, align: 'left', maxW: o.maxW || 420, shadow: o.shadow !== false });
    const tb = box(t), gap = Math.round(ic * 0.35), total = icons.length * (ic + gap) + 4 + tb.w;
    let x = o.l != null ? o.l : o.r != null ? o.r - total : (o.cx || 540) - total / 2;
    icons.forEach((L) => { L.x = x + ic / 2; L.y = o.cy; x += ic + gap; });
    put(t, { l: x + 4, cy: o.cy });
    return icons.concat(t);
  }
  /* a torn scrap of paper with a word on it — THIS, THEME, the address */
  const tornTag = (lines, o) => pill(lines, Object.assign({ shape: 'ragged', fill: '#f7f5f0', ink: '#141414', padX: 24, padY: 12, shadow: true }, o || {}));
  /* the band of coloured cells the details sit in, edge to edge (time | date | where) */
  function cells(list, o) {
    const out = []; let x = o.l;
    list.filter(Boolean).forEach((c) => {
      out.push(SH({ name: c.name || 'Cell', shape: 'rect', fill: c.fill, x: x + c.w / 2, y: o.cy, w: c.w, h: o.h, shadow: !!o.shadow }));
      const ts = c.lines.filter((l) => l && l.text).map((l) => T(Object.assign({ name: (c.name || 'Cell') + ' text', align: 'left', line: 1.0, maxW: c.w - 30 }, l)));
      out.push(...col(ts, { l: x + 16, cy: o.cy, gap: 3 }));
      x += c.w;
    });
    return out;
  }
  /* a colour that answers the flyer's own: teal against red and gold, gold against blue and purple */
  function answer(p) { const [r, g, b] = hexRgb(p.mid); return r > b + 30 ? '#46d3cb' : '#ffcf3a'; }

  /*
   * ►► BRIGHT AND SIMPLE. ◄◄ "They should be bright, simple — and the pictures
   * cut out don't look good." A white or cream page, ONE colour, clean heavy
   * type, and the minister in a FRAME — an arch, a circle, a panel of colour —
   * chest up, cut off by the frame's own edge. No fade into a painting, no glow
   * round them, and the frame stops above the hands, where a cut-out goes
   * wrong (a lectern, a microphone stand).
   */
  const INK = '#15151a';
  const SIMPLE = new Set(['arch', 'circle', 'split', 'arches', 'bigword']);
  // the one colour: the palette's own when it reads on a white page, else a deeper one of it
  function oneColour(p) { return [p.mid, p.deep, p.accent].find((h) => { const l = lum(h); return l > 0.1 && l < 0.55; }) || '#1d4ed8'; }
  /* which part of the photo a frame shows: chest (or waist) up, the head near the top, the frame's foot cutting them off */
  function framedSrc(key, w, h, o) {
    const im = imgOf(key); if (!im) return null;
    o = o || {};
    const m = META.get(key) || quickMeta(im);
    const fr = frameOf(m, o.mode || 'chest'), u = Math.max(12, m.sy - m.top);
    // a cut-out stops above the hands: that is where a lectern or a microphone stand starts (a photo shows them as they are)
    const nb = !m.photo && m.wy ? Math.min(fr.nb, Math.max(m.sy + u * 0.6, m.wy - u * 0.1)) : fr.nb;
    const vb = Math.min(m.h, nb);
    let k = (h * (1 - (o.head == null ? 0.1 : o.head))) / Math.max(1, vb - fr.t);
    if (o.fitW && m.sw) k = Math.min(k, (w * o.fitW) / m.sw);   // the shoulders inside the frame, not cut by its sides
    // the frame round the face (a turned pose moves the shoulders' middle off it)
    const cx = m.photo ? m.cx : quickMeta(im).cx * 0.65 + fr.cx * 0.35;
    if (m.photo) {
      // the photo itself (prepareRaw): cropped, never shrunk inside the frame — the frame is always full of picture
      k = Math.max(k, w / m.w, h / m.h);
      const sw = w / k, sh = h / k;
      return { x: clamp(cx - sw / 2, 0, m.w - sw) / m.w, y: clamp(vb - sh, 0, m.h - sh) / m.h, w: sw / m.w, h: sh / m.h };
    }
    const sw = w / k, sh = h / k;
    return { x: (cx - sw / 2) / m.w, y: (vb - sh) / m.h, w: sw / m.w, h: sh / m.h };
  }
  /* a person in a frame: the frame in colour, the person on it, cut by its edge */
  function framed(sp, o) {
    if (PAINTED) return [];
    // the cut-out on the frame's colour — the one made (and checked) in My church. "The cropped of the images is terrible
    // it doesn't match how it was cropped in the removed background": the photo itself brought its wall and the people beside
    const key = sp && sp.img;
    const im = imgOf(key); if (!im) return [];
    const shape = o.shape || 'arch', cx = o.l + o.w / 2, cy = o.t + o.h / 2;
    const clip = shape === 'circle' ? { round: true } : shape === 'arch' ? { arch: true } : o.radius ? { radius: o.radius } : {};
    const inFrame = { mode: o.mode || 'chest', head: o.head, fitW: o.fitW == null ? 0.92 : o.fitW };
    return [
      SH({ name: 'Frame', shape: shape === 'rect' ? (o.radius ? 'round' : 'rect') : shape, radius: o.radius, fill: o.fill, x: cx, y: cy, w: o.w, h: o.h }),
      IM(Object.assign({ img: key, name: sp.name || 'Speaker', speaker: sp.id || '', photo: sp.photo || '', src: framedSrc(key, o.w, o.h, inFrame), inFrame, x: cx, y: cy, w: o.w, h: o.h }, clip)),
    ];
  }
  /* a title's lines all at one size — as wide as `w` allows, no taller than maxH — flush left or centred */
  function titleLines(lines, o) {
    lines = lines.filter(Boolean);
    const face = o.font || (VAR && VAR.faces && VAR.faces[2]) || 'Montserrat Black';   // another heavy sans on another board
    const mk = (ln, i, size) => T(Object.assign({ name: 'Title' + (lines.length > 1 ? ' ' + (i + 1) : ''), text: ln, font: face, size, upper: true,
      fill: (o.fills || [])[i] || o.fill || INK, align: o.align || 'left', line: 1, letter: o.letter == null ? -0.01 : o.letter }, o.style || {}));
    const probe = lines.map((ln, i) => box(mk(ln, i, 100)));
    const size = Math.floor(Math.min(100 * o.w / Math.max(1, ...probe.map((b) => b.w)), 100 * o.maxH / Math.max(1, ...probe.map((b) => b.h)), o.max || 400));
    const pos = { t: o.t, gap: o.gap == null ? Math.round(size * 0.08) : o.gap };
    if (o.align === 'center') pos.cx = o.cx == null ? 540 : o.cx; else pos.l = o.l;
    return col(lines.map((ln, i) => mk(ln, i, size)), pos);
  }
  /* things moved up or down together */
  function shiftY(list, dy) { list.forEach((L) => { L.y += dy; }); return list; }
  /* the details one under another: the day, the date, the time, then where */
  function detailStack(D, o) {
    const f = D.f, d = D.d, al = o.align || 'left', w = o.w || 420;
    const items = [
      d && T({ name: 'Day', text: d.day, upper: true, font: 'Montserrat', size: 20, letter: 0.32, fill: o.acc, align: al }),
      d && T({ name: 'Date', text: `${d.ddth} ${d.month}\n${d.year}`, upper: true, font: 'Montserrat Black', size: o.big || 46, line: 1.02, fill: INK, align: al, maxW: w }),
      f.time && T({ name: 'Time', text: f.time + (f.time2 ? ' & ' + f.time2 : ''), upper: true, font: 'Montserrat Black', size: o.big || 46, fill: o.acc, align: al, maxW: w }),
      venueText(D) && SH({ name: 'Rule', shape: 'rect', fill: o.acc, w: 56, h: 5 }),
      venueText(D) && T({ name: 'Venue', text: venueLines(D, 3), upper: true, font: 'Montserrat', size: 19, line: 1.3, letter: 0.03, fill: '#3a3a42', align: al, maxW: w }),
      f.phone && T({ name: 'Phone', text: f.phone, font: 'Montserrat', size: 19, fill: '#3a3a42', align: al, maxW: w }),
    ].filter(Boolean);
    const pos = { gap: o.gap == null ? 16 : o.gap }; if (o.t != null) pos.t = o.t; else if (o.b != null) pos.b = o.b; else pos.cy = o.cy;
    if (al === 'right') pos.r = o.r; else if (al === 'center') pos.cx = o.cx; else pos.l = o.l;
    return col(items, pos);
  }
  /* MINISTERING over the name, in the page's own two inks */
  function simpleName(sp, o) {
    const n = String(sp && sp.name || '').trim(); if (!n) return [];
    const al = o.align || 'left';
    const items = [o.label !== '' && T({ name: 'Ministering', text: o.label || 'Ministering', upper: true, font: 'Montserrat', size: 16, letter: 0.32, fill: o.acc, align: al }),
      T({ name: 'Speaker', text: n, upper: true, font: 'Montserrat Black', size: o.size || 30, line: 1.05, fill: INK, align: al, maxW: o.maxW || 440 })].filter(Boolean);
    const pos = { gap: 8 }; if (o.t != null) pos.t = o.t; else if (o.b != null) pos.b = o.b; else pos.cy = o.cy;
    if (al === 'right') pos.r = o.r; else if (al === 'center') pos.cx = o.cx; else pos.l = o.l;
    return col(items, pos);
  }
  const inked = (list, ink) => { list.forEach((l) => { if (l.type === 'text') l.fill = ink; }); return list; };

  /* colours by hue, saturation and lightness (a palette's colour made vivid, or turned) */
  function hslOf(h) {
    const [r, g, b] = hexRgb(h).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let H = 0, S = 0;
    if (mx !== mn) { const d = mx - mn; S = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); H = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6; }
    return [H * 360, S, l];
  }
  function hslHex(H, S, l) {
    const q = l < 0.5 ? l * (1 + S) : l + S - l * S, p = 2 * l - q, h = (((H % 360) + 360) % 360) / 360;
    const t = (x) => { x = ((x % 1) + 1) % 1; return x < 1 / 6 ? p + (q - p) * 6 * x : x < 0.5 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p; };
    return '#' + [t(h + 1 / 3), t(h), t(h - 1 / 3)].map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
  }
  // full of colour and mid-light: an electric blue, a ruby, a gold — never a muddy brown
  const vivid = (h, l) => { const [H, S, L0] = hslOf(h); return hslHex(H, Math.max(S, 0.78), l == null ? clamp(L0, 0.4, 0.52) : l); };
  // the haze beside it: the colour turned towards magenta (blue to violet, gold to rose)
  const hazeOf = (h) => { const [H, S, l] = hslOf(h), d = ((290 - H + 540) % 360) - 180; return hslHex(H + Math.sign(d) * Math.min(48, Math.abs(d)), S, l); };
  /* "Bishop David Richman" and "Pastor Mirella Richman" → "Bishop David & Pastor Mirella Richman" (one surname, said once) */
  function jointNames(ps) {
    const ns = ps.map((s) => String(s.name || '').trim()).filter(Boolean);
    if (ns.length === 2) {
      const a = ns[0].split(/\s+/), b = ns[1].split(/\s+/);
      if (a.length > 1 && b.length > 1 && a[a.length - 1].toLowerCase() === b[b.length - 1].toLowerCase()) return a.slice(0, -1).join(' ') + ' & ' + ns[1];
    }
    return ns.length > 2 ? ns.slice(0, -1).join(', ') + ' & ' + ns[ns.length - 1] : ns.join(' & ');
  }
  /* the WHOLE address, as typed, in up to `n` lines as even as they go (not cut to its first three parts) */
  function addressLines(text, n) {
    const parts = String(text || '').trim().split(/\s*,\s*/).filter(Boolean);
    if (parts.length <= 1) return parts.join('');
    // every way of breaking it at its commas into n lines or fewer: the one whose longest line is shortest
    let best = null;
    const tryCuts = (from, left, acc) => {
      if (left === 1 || from >= parts.length) {
        const lines = acc.concat([parts.slice(from)]).filter((l) => l.length), long = Math.max(...lines.map((l) => l.join(', ').length));
        if (!best || long < best.long) best = { lines, long };
        return;
      }
      for (let k = from + 1; k <= parts.length; k++) tryCuts(k, left - 1, acc.concat([parts.slice(from, k)]));
    };
    tryCuts(0, n, []);
    return best.lines.map((l, i, a) => l.join(', ') + (i < a.length - 1 ? ',' : '')).join('\n');
  }
  /* the church's logo with its name beside it, the two centred */
  function crest(D, cy, ink) {
    const name = String(D.f.church || '').trim(), out = [];
    const t = name ? T({ name: 'Church', text: stack(name, 3).join('\n'), upper: true, font: 'Montserrat', size: 19, line: 1.16, letter: 0.02, align: 'left', fill: ink, maxW: 320, shadow: true }) : null;
    const logo = D.logo && imgOf(D.logo) ? logoLayers(D, 0, cy, 84) : [];
    const lw = logo.length ? Math.max(...logo.map((l) => l.w)) : 0, gap = logo.length && t ? 16 : 0, x0 = 540 - (lw + gap + (t ? box(t).w : 0)) / 2;
    logo.forEach((l) => { l.x = x0 + lw / 2; }); out.push(...logo);
    if (t) out.push(put(t, { l: x0 + lw + gap, cy }));
    return out;
  }
  /* a bar of deep colour with a fine light edge (WITH, the names) */
  const edgedBar = (cx, cy, w, h, fill, edge, name) => [
    SH({ name: (name || 'Bar') + ' edge', shape: 'round', radius: 3, fill: edge, x: cx, y: cy, w: w + 4, h: h + 4 }),
    SH({ name: name || 'Bar', shape: 'round', radius: 2, fill: { stops: [mix(fill, '#ffffff', 0.1), fill], angle: 90 }, x: cx, y: cy, w, h }),
  ];
  /* the foot: the apps in their own colours with the handle, a hairline, and the number to call */
  function appRow(D, cy, ink) {
    const hd = String(D.f.handles || '').trim(), ph = String(D.f.phone || '').trim(), out = [], ic = 38, both = !!(hd && ph);
    let right = 40;
    if (hd) {
      // Facebook is its own blue disc; Instagram and YouTube a white mark on theirs
      const slots = [[SH({ name: 'Icon', shape: 'icon', icon: 'fb', fill: '#1877f2', w: ic / 0.92, h: ic / 0.92 })]]
        .concat([['ig', { stops: ['#feda75', '#fa7e1e', '#d62976', '#962fbf', '#4f5bd5'], angle: 135 }], ['yt', '#ff0000']]
          .map(([k, c]) => [SH({ name: 'Icon', shape: 'circle', fill: c, w: ic, h: ic }), SH({ name: 'Icon', shape: 'icon', icon: k, fill: '#ffffff', w: ic * 0.58, h: ic * 0.58 })]));
      const t = T({ name: 'Handles', text: hd, font: 'Montserrat', size: 19, fill: ink, align: 'left', maxW: both ? 330 : 700, inkSet: true });
      let x = both ? 40 : 540 - (slots.length * (ic + 10) + box(t).w) / 2;
      slots.forEach((sl) => { sl.forEach((L) => { L.x = x + ic / 2; L.y = cy; }); out.push(...sl); x += ic + 10; });
      out.push(put(t, { l: x, cy }));
      right = box(t).r;
    }
    if (ph) {
      const t = T({ name: 'Phone', text: 'FOR MORE INFO: ' + ph, upper: true, font: 'Montserrat', size: 20, fill: ink, align: both ? 'right' : 'center', maxW: both ? 1040 - right - 60 : 900, inkSet: true });
      out.push(both ? put(t, { r: 1040, cy }) : put(t, { cx: 540, cy }));
      if (both) out.push(SH({ name: 'Divider', shape: 'line', fill: rgba(ink, 0.7), x: (right + box(t).l) / 2, y: cy, w: 2, h: 34 }));
    }
    return out;
  }

  /*
   * ►► NO TWO BOARDS THE SAME. ◄◄ Every design on a board is built with a
   * variant of its own (makeVariant): the title in another face of the same
   * family (a condensed title stays condensed, an italic one italic), in
   * another finish (chrome, gold, silver, warm, the flyer's own colours),
   * the whole layout mirrored or not, the sparks and light in a fresh
   * pattern. The layout's character stays; the flyer is a new one.
   */
  const FACE_FAMILIES = [
    ['Anton', 'League Gothic', 'Bebas Neue', 'Oswald', 'Barlow Black', 'Big Shoulders'],
    ['Barlow Italic', 'Barlow Black Italic', 'Kanit Italic', 'Montserrat Italic'],
    ['Montserrat Black', 'Kanit Black', 'Archivo Black'],
  ];
  const SILVER = { stops: ['#ffffff', '#eef1f5', '#b9c1cc', '#f4f6f9'], angle: 90 };
  let VAR = null;   // buildScene: the variant of the design being built
  function varyStyle(st) {
    if (!VAR) return st;
    const o = Object.assign({}, st);
    const fam = FACE_FAMILIES.findIndex((f) => f.includes(o.font));
    if (fam >= 0 && VAR.faces && VAR.faces[fam]) o.font = VAR.faces[fam];
    const metal = o.fill === CHROME || o.fill === GOLD || (o.fill && o.fill.stops);
    if (VAR.tex && metal && !o.imgFill && !o.noTex) {
      // a title set in a material: gold leaf, stone, fire, steel — bevelled, on its block
      Object.assign(o, { fill: '#ffffff', imgFill: 'tex:' + VAR.tex, imgFillA: 1, bevel: Math.max(o.bevel || 0, 0.9), grain: VAR.tex === 'stone', speck: 0, erode: VAR.tex === 'stone' ? 0.25 : o.erode });
      if (!o.extrude) Object.assign(o, { extrude: 3, extrudeColor: VAR.tex === 'fire' ? ['#5a0d02', '#1a0300'] : VAR.tex === 'stone' ? ['#3a3430', '#0e0c0b'] : ['#6b3a04', '#1e0f01'] });
    } else if ((o.fill === CHROME || o.fill === GOLD) && VAR.fill) o.fill = VAR.fill;
    return o;
  }
  /** A design's variant: everything that may change about a layout, picked at random. */
  function makeVariant(pal, rnd) {
    rnd = rnd || Math.random;
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const fills = [CHROME, GOLD, SILVER,
      { stops: ['#fffaf0', mix(pal.accent, '#ffffff', 0.55), pal.accent], angle: 90 },
      { stops: [pal.hi || '#ffffff', mix(pal.hi || '#ffffff', pal.accent, 0.5)], angle: 90 }];
    // the material for the title, half the time — one that suits the colours (fire with red, steel with blue)
    const [r, , b] = hexRgb(pal.mid || '#5b21b6');
    const mats = r > b + 40 ? ['fire', 'gold', 'stone', 'gold'] : b > r + 40 ? ['steel', 'gold', 'stone', 'rosegold'] : ['gold', 'stone', 'rosegold', 'steel'];
    return {
      faces: FACE_FAMILIES.map((f) => (rnd() < 0.35 ? null : pick(f))),   // a third of the time the layout's own face
      tex: rnd() < 0.5 ? pick(mats) : null,
      fill: rnd() < 0.25 ? null : pick(fills),
      mirror: rnd() < 0.45,
      seed: Math.floor(rnd() * 997),
    };
  }
  /* the whole flyer the other way round — but an address keeps its pin before it, and the handles their icons */
  function mirrorLayers(layers, w) {
    const orig = new Map(layers.map((l) => [l, l.x]));
    layers.forEach((l) => {
      if (l.type === 'bg') { (l.colorWash || []).forEach((c) => { if (c.radial && c.x != null) c.x = 1 - c.x; }); return; }
      if (l.x == null) return;
      // a person is moved, not flipped: their FACE goes to the mirrored place (a photo with the face off-centre —
      // seated, turned to clap — had the face pushed off the edge when only the picture's middle was mirrored)
      if (l.type === 'image' && l.head) { const hx = (l.head.l + l.head.r) / 2, d = hx - l.x; l.x = (w - hx) - d; return; }
      l.x = w - l.x;
      // a sideways gradient turns with the page (a fade to the right becomes a fade to the left)
      if (l.fill && l.fill.stops && l.fill.angle != null && !l.fill.flipped) l.fill = Object.assign({}, l.fill, { angle: (540 - l.fill.angle) % 360, flipped: true });
      // a tilt goes the other way; a word stood on its end stays reading the way it did
      if (l.rot && Math.abs(Math.abs(l.rot) - 90) > 25) l.rot = -l.rot;
      if (l.type === 'text' && (l.align === 'left' || l.align === 'right')) l.align = l.align === 'left' ? 'right' : 'left';
    });
    const keepOrder = (members) => {
      if (members.length < 2) return;
      const bs = members.map((m) => { const b = box(Object.assign({}, m, { x: orig.get(m) })); return b; });
      const l0 = Math.min(...bs.map((b) => b.l)), r0 = Math.max(...bs.map((b) => b.r)), dx = (w - r0) - l0;
      members.forEach((m) => { m.x = orig.get(m) + dx; if (m.type === 'text' && (m.align === 'left' || m.align === 'right')) m.align = m.align === 'left' ? 'right' : 'left'; });
    };
    layers.forEach((l, i) => { if (l.name === 'Pin' && layers[i + 1] && layers[i + 1].name === 'Venue') keepOrder([l, layers[i + 1]]); });
    const icons = []; layers.forEach((l) => { if (l.name === 'Icon' || l.name === 'Handles') icons.push(l); });
    if (icons.some((l) => l.name === 'Handles')) keepOrder(icons);
    const byName = (n) => layers.find((l) => l.name === n);
    if (byName('Contact icon') && byName('Contact')) keepOrder([byName('Contact icon'), byName('Contact')]);
    // a phrase split across the page ("A NIGHT ——— OF") still reads left to right
    layers.forEach((a) => {
      const b = a.type === 'text' && byName(a.name + ' 2');
      if (!b || Math.abs(a.y - b.y) > 12) return;
      if (a.x > b.x) { const ax = a.x, al = a.align; a.x = b.x; a.align = b.align; b.x = ax; b.align = al; }
    });
    return layers;
  }

  /*
   * ►► THE STANDARD'S PARTS ◄◄ — shared by Radiant and its family (radiantspot, radiantside, radiantwave), so the
   * finish the church held up as its standard is the same on every one of them and only the composition changes.
   */
  function stdPal(p) {
    const main = vivid(p.mid), glow = vivid(p.accent, 0.6), haze = hazeOf(main);
    const deep = mix(mix(p.deep, main, 0.3), '#000022', 0.2), light = mix(main, '#ffffff', 0.55), navy = mix(main, '#000000', 0.52);
    // the warm light at the page's edges: pink beside a cool colour (as on the standard), amber beside a warm one
    const hu = hslOf(main)[0], warm = hu > 170 && hu < 320 ? '#ff4fa8' : '#ffb347';
    return { main, glow, haze, deep, light, navy, warm };
  }
  function stdLight(D, P, kind) {
    const H = D.h, L = [], { main, glow, haze, deep } = P;
    if (kind === 'spot') {
      // a dark stage: beams of light from above, haze through them, a glow of colour behind the ministers
      L.push(BG({ plain: { stops: ['#04030a', mix(deep, '#000000', 0.35), mix(deep, main, 0.35)], angle: 90 }, grain: 0 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.56, w: W * 1.2, h: H * 0.55, color: main, opacity: 0.75, blend: 'source-over' }));
      L.push(FX({ kind: 'beams', x: 540, y: H * 0.5, w: W * 0.9, h: H * 0.7, n: 4, seed: 21, color: glow, color2: '#ffe9b0', opacity: 0.55 }));
      L.push(FX({ kind: 'smoke', x: 540, y: H * 0.66, w: W * 1.1, h: H * 0.42, n: 22, seed: 4, color: mix(main, '#ffffff', 0.35), color2: '#ffd27a', opacity: 0.55 }));
      L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.42, w: W, h: H * 0.6, n: 24, size: 26, seed: 8, color: '#ffd27a', color2: mix(glow, '#ffffff', 0.4), opacity: 0.55 }));
      L.push(FX({ kind: 'glow', x: W * 0.02, y: H * 0.5, w: W * 0.45, h: H * 0.5, color: P.warm, opacity: 0.35 }));
      L.push(SH({ name: 'Shade', lock: true, shape: 'fade', fill: '#05030c', strength: 1, x: 540, y: H - 170, w: W, h: 340 }));
      return L;
    }
    if (kind === 'wave') {
      // a light page of soft colour: the colour in the air, not on the paper
      L.push(BG({ plain: { stops: ['#ffffff', mix(P.light, '#ffffff', 0.55), mix(P.light, '#ffffff', 0.2)], angle: 90 }, grain: 0 }));
      L.push(FX({ kind: 'glow', x: W * 0.96, y: H * 0.12, w: W * 0.8, h: H * 0.45, color: mix(glow, '#ffffff', 0.2), opacity: 0.55, blend: 'source-over' }));
      L.push(FX({ kind: 'glow', x: W * 0.04, y: H * 0.42, w: W * 0.7, h: H * 0.5, color: mix(P.warm, '#ffffff', 0.35), opacity: 0.4, blend: 'source-over' }));
      L.push(FX({ kind: 'silk', x: 540, y: H / 2, w: W, h: H, n: 6, seed: 3, color: mix(main, '#ffffff', 0.25), color2: mix(haze, '#ffffff', 0.3), opacity: 0.45, blend: 'source-over' }));
      L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.35, w: W, h: H * 0.5, n: 18, size: 30, seed: 6, color: mix(main, '#ffffff', 0.3), color2: mix(P.warm, '#ffffff', 0.3), opacity: 0.4, blend: 'source-over' }));
      return L;
    }
    // the electric page (the standard; Side moves its light behind the minister)
    const side = kind === 'side';
    L.push(BG({ plain: { stops: [deep, mix(deep, main, 0.55), main, main, mix(main, glow, 0.3)], angle: side ? 100 : 80 }, grain: 0 }));
    L.push(FX({ kind: 'glow', x: W * (side ? 0.9 : 0.04), y: H * 0.58, w: W * 0.95, h: H * 0.55, color: vivid(haze, 0.5), opacity: 0.7, blend: 'source-over' }));
    // (a very light colour — lime, lemon — is kept lower: the white date stands on it)
    L.push(FX({ kind: 'glow', x: W * (side ? 0.1 : 0.98), y: H * 0.36, w: W * 0.9, h: H * 0.7, color: glow, opacity: lum(glow) > 0.75 ? 0.35 : 0.55 }));
    L.push(FX({ kind: 'glow', x: W * 0.5, y: H * 0.48, w: W * 1.1, h: H * 0.5, color: mix(main, glow, 0.5), opacity: 0.35 }));
    // the standard's warm lens light, at the page's edges (pink and amber that make the blue glow)
    L.push(FX({ kind: 'glow', x: W * (side ? 1.02 : -0.03), y: H * 0.52, w: W * 0.62, h: H * 0.6, color: P.warm, opacity: 0.68 }));
    L.push(FX({ kind: 'glow', x: W * (side ? -0.02 : 1.02), y: H * 0.07, w: W * 0.42, h: H * 0.26, color: mix(P.warm, '#ffd27a', 0.5), opacity: 0.38 }));
    L.push(FX({ kind: 'silk', x: 540, y: H / 2, w: W, h: H, n: 9, seed: 5, color: mix(glow, '#ffffff', 0.25), color2: mix(haze, '#ffffff', 0.4), opacity: 1 }));
    // soft orbs of light, and the glossy wave sweeping up under the ministers
    L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.42, w: W, h: H * 0.55, n: 22, size: 30, seed: 12, color: mix(glow, '#ffffff', 0.45), color2: mix(haze, '#ffffff', 0.3), opacity: 0.5 }));
    L.push(SH({ name: 'Wave', lock: true, shape: 'swoosh', bend: 1, thick: H * 0.07, fill: { stops: [rgba('#ffffff', 0), rgba(mix(glow, '#ffffff', 0.5), 0.55), rgba('#ffffff', 0.9)], angle: 0 },
      x: W * 0.5, y: H * 0.79, w: W * 1.5, h: H * 0.2, rot: side ? 6 : -6, opacity: 0.85 }));
    // the foot turns white: the address and the apps are read on it
    L.push(SH({ name: 'Light', lock: true, shape: 'fade', fill: '#ffffff', strength: 1, x: 540, y: H - 160, w: W, h: 320 }));
    L.push(FX({ kind: 'glow', x: 540, y: H - 40, w: W * 1.5, h: 260, color: '#ffffff', opacity: 0.7 }));
    return L;
  }
  /* the ministers in front of the title's foot, down behind the bars (sized by their own head and shoulders) */
  function stdPeople(ps, at, P) {
    const n = ps.length, people = [];
    for (let i = n - 1; i >= 0; i--) {
      const im = hero(ps[i], Object.assign({ mode: 'waist', fade: 0.06, maxR: 850, steady: true, extra: { shade: rgba(mix(P.deep, '#000000', 0.5), 0.45) } }, at(i)));
      if (im) people.push(im);
    }
    // two: the one behind never hidden by the one in front (an arm out with the microphone) — their heads kept apart
    if (people.length === 2) {
      const [back, front] = people, hc = (im) => (im.head.l + im.head.r) / 2, hw = (im) => im.head.r - im.head.l;
      const need = 1.05 * (hw(back) + hw(front)) - (hc(back) - hc(front));
      if (need > 0) {
        const a = Math.max(0, Math.min(need / 2, front.head.l - 30)), b = Math.max(0, Math.min(need - a, 840 - back.head.r));
        [[front, -a], [back, b]].forEach(([im, dx]) => { im.x += dx; im.head = Object.assign({}, im.head, { l: im.head.l + dx, r: im.head.r + dx }); });
      }
    }
    return people;
  }
  /* the day written large in script behind the title, an outline of light (the standard's "Sunday" behind SUNDAY SERVICE) */
  function stdScript(D, P, ts) {
    const d = D.d; if (!d || !ts.length) return [];
    const word = String(d.day || '').charAt(0).toUpperCase() + String(d.day || '').slice(1).toLowerCase();
    if (!word) return [];
    const top = Math.min(...ts.map((l) => box(l).t)), bot = Math.max(...ts.map((l) => box(l).b)), cx = (Math.min(...ts.map((l) => box(l).l)) + Math.max(...ts.map((l) => box(l).r))) / 2;
    const t = T({ name: 'Script word', text: word, font: 'Great Vibes', size: Math.round((bot - top) * 0.95), fill: rgba('#ffffff', 0), stroke: 4, strokeColor: rgba(mix(P.glow, '#ffffff', 0.3), 0.9),
      rot: -8, opacity: 0.5, lock: true, inkSet: true });
    return [put(t, { cx, cy: (top + bot) / 2 + (bot - top) * 0.05 })];
  }
  /* when: the day, the date large in italics, a line, the time — a column (with a line of light beside it when it is at the side) */
  function stdWhen(D, P, pos) {
    const f = D.f, d = D.d, side = pos.l != null, al = side ? 'left' : 'center';
    const items = [
      d && T({ name: 'Day', text: d.day + ',', upper: true, font: 'Montserrat Black', size: 34, align: al, maxW: 168, shadow: true, inkSet: true }),
      d && T({ name: 'Date', text: `${d.ddth}\n${d.mon3}\n${d.year}`, upper: true, font: 'Montserrat Italic', size: 48, line: 1.0, align: al, maxW: 168, shadow: true, inkSet: true }),
      d && f.time && SH({ name: 'Rule', shape: 'rect', fill: P.glow, w: 150, h: 4 }),
      f.time && T({ name: 'Time', text: f.time + (f.time2 ? '\n' + f.time2 : ''), upper: true, font: 'Montserrat Black', size: 46, line: 1.05, align: al, maxW: 168, shadow: true, inkSet: true }),
    ].filter(Boolean);
    if (!items.length) return [];
    const dc = col(items, Object.assign({ gap: 12 }, pos)), out = [];
    if (side) out.push(SH({ name: 'Line', shape: 'rect', fill: P.glow, x: pos.l - 22, y: (dc.top + dc.bottom) / 2, w: 4, h: dc.bottom - dc.top + 20 }));
    return out.concat(dc);
  }
  /* WITH, over the names on one bar (a theme there when nobody is named) */
  function stdBars(D, P, ps, barT, theme) {
    const n = ps.length, said = n ? jointNames(ps) : theme, out = [];
    if (!said) return out;
    const nt = T({ name: n ? 'Speakers' : 'Theme', text: said, upper: true, font: 'Montserrat', size: 25, letter: 0.03, fill: '#ffffff', maxW: 920, inkSet: true });
    const bw = clamp(box(nt).w + 110, 640, 1010), by = barT + 32;
    out.push(...edgedBar(540, by, bw, 64, P.navy, P.light, 'Names bar'), put(nt, { cx: 540, cy: by }));
    if (n) {
      const wt = T({ name: 'With', text: 'WITH', font: 'Montserrat', size: 27, letter: 0.32, fill: '#ffffff', inkSet: true });
      out.push(...edgedBar(540, barT - 18, Math.max(200, box(wt).w + 76), 44, P.navy, P.light, 'With tab'), put(wt, { cx: 540 + 4, cy: barT - 18 }));
    }
    return out;
  }
  /* the whole address, then the apps and the number (on the white foot; on a dark one, in white) */
  function stdFoot(D, P, t, dark) {
    const ink = dark ? '#ffffff' : P.navy, out = [], at = addressLines(D.f.venue, 3);
    if (at) out.push(put(T({ name: 'Venue', text: at, upper: true, font: 'Montserrat', size: 26, line: 1.12, fill: ink, maxW: 1010, inkSet: true }), { cx: 540, t }));
    out.push(...appRow(D, D.h - 40, ink));
    return out;
  }

  const LAYOUTS = {
    /* ── AI LETTERING: the picture already has the title in it (paintLettering); the minister at the foot, the details round him ── */
    ailetter(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      // no shade over the top (the AI's lettering is there: a shade dimmed it), a little more contrast to make it stand out
      L.push(BG({ img: D.bg, grade: 'normal', contrast: 12, keep: 0.7, bottomShade: 0.9, bottomFrom: 0.66, vignette: 0.12 }));
      if (D.f.church) L.push(put(T({ name: 'Church', text: D.f.church, upper: true, font: 'Montserrat', size: 18, letter: 0.08, shadow: true, maxW: 900 }), { cx: 540, t: 18 }));
      // two ministers (a Sunday): side by side under the lettering, the second a little behind
      const ps2 = spsOf(D).slice(0, 2);
      if (ps2.length === 2) L.push(hero(ps2[1], { cx: 700, t: H * 0.54, b: H + 10, mode: 'chest', fade: 0.3, extra: lit(p) }), hero(ps2[0], { cx: 400, t: H * 0.5, b: H + 10, mode: 'chest', fade: 0.3, extra: lit(p) }));
      else if (sp) L.push(hero(sp, { cx: 560, t: H * 0.5, b: H + 10, mode: 'chest', fade: 0.3, extra: lit(p) }));
      L.push(...col([f.time && T({ name: 'Time', text: f.time + (f.time2 ? ' & ' + f.time2 : ''), font: 'Anton', size: 62, fill: p.accent, align: 'left', shadow: true }),
        d && T({ name: 'Date', text: `${d.day3}, ${d.ddth}\n${d.month} ${d.year}`, upper: true, font: 'Barlow Black Italic', size: 40, line: 0.95, align: 'left', shadow: true })].filter(Boolean), { l: 52, b: H - 120, gap: 8 }));
      if (ps2.length === 2) L.push(...col(ps2.map((s2) => T({ name: 'Speaker', text: s2.name, upper: true, font: 'Barlow Black Italic', size: 30, align: 'right', shadow: true, maxW: 330 })), { r: 1030, b: H - 120, gap: 6 }));
      else if (sp && sp.name) { const np = nameParts(sp.name); L.push(...col([np.title && T({ name: 'Speaker title', text: np.title, font: 'Great Vibes', size: 52, align: 'right', shadow: true, fill: p.accent }), T({ name: 'Speaker', text: np.name, upper: true, font: 'Barlow Black Italic', size: 36, align: 'right', shadow: true, maxW: 320 })].filter(Boolean), { r: 1030, b: H - 120, gap: -4 })); }
      const vt = venueText(D);
      if (vt) { L.push(SH({ name: 'Address bar', shape: 'rect', fill: rgba(p.deep, 0.82), x: 540, y: H - 46, w: W, h: 70 })); L.push(put(T({ name: 'Venue', text: vt, upper: true, font: 'Montserrat', size: 20, letter: 0.05, maxW: 980 }), { cx: 540, cy: H - 46 })); }
      return L;
    },
    /* ════════ BRIGHT PAGES — a third of the flyers people save are white, cream or gold, not dark ════════ */

    /* ── JERICHO HOUR: a light page, a two-tone heavy title on the left, the minister big on the right, a ribbon with his name ── */
    jericho(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D), ink = '#1b1b1f';
      const deepInk = lum(p.mid) < 0.55 ? mix(p.mid, '#000000', 0.15) : '#7a1414';
      L.push(BG({ img: D.bg, sat: -25, bright: 30, contrast: -6, wash: 'rgba(253,250,244,.62)', grain: 0.3,
        colorWash: [{ radial: true, x: 0.25, y: 0.3, r: 0.75, stops: ['rgba(255,255,255,.95)', 'rgba(255,255,255,0)'], mode: 'screen', a: 0.8 }] }));
      const hd = header(D); hd.forEach((l) => { if (l.type === 'text') { l.fill = ink; l.shadow = false; } }); L.push(...hd);
      if (sp) L.push(hero(sp, { cx: 790, t: H * 0.2, b: H + 20, mode: 'chest', fade: 0.18, minL: 470, extra: { fadeLight: true, shade: 'rgba(40,20,10,.25)' } }));
      let y = H * 0.17;
      L.push(put(micro('PRESENTS', { size: 14, letter: 0.9, fill: rgba(ink, 0.75), shadow: false }), { l: 72, t: y })); y += 34;
      const lines = stack(f.title || 'Jericho Hour', 2);
      const ts = stackLines(lines, { t: y, cx: 72 + 290, fit: 580, maxH: H * 0.12, gap: 6,
        style: { font: 'Archivo Black', upper: true, fill: { stops: ['#3c3c44', ink], angle: 90 }, extrude: 2, extrudeColor: rgba('#000000', 0.16), shadow: false, noTex: true } });
      if (ts[1]) { ts[1].fill = { stops: [mix(deepInk, '#ffffff', 0.15), deepInk], angle: 90 }; ts[1].inkSet = true; }
      L.push(...ts); y = ts.bottom + 16;
      const tagText = f.theme || D.dir.kicker || '';
      if (tagText) { const g = pill([{ text: tagText, upper: true, font: 'Montserrat', size: 17, letter: 0.06 }], { fill: ink, ink: '#ffffff', radius: 2, padX: 14, padY: 8 }); L.push(...g.place(72 + g.w / 2, y + g.h / 2)); y += g.h + 22; }
      if (d) { const j = put(T({ name: 'Join us', text: `JOIN US THIS ${d.day.toUpperCase()}`, font: 'Montserrat', size: 20, fill: ink, align: 'left', letter: 0.04 }), { l: 72, t: y }); L.push(j); y = box(j).b + 22; }
      if (f.time) { const g = pill([{ text: f.time + (f.time2 ? ' - ' + f.time2 : ''), font: 'Archivo Black', size: 36 }], { fill: '#ffffff', ink, radius: 40, padX: 26, padY: 10, shadow: true }); L.push(...g.place(72 + g.w / 2, y + g.h / 2)); y += g.h + 22; }
      if (d) { const dt = put(T({ name: 'Date', text: `${d.day3} ${d.ddth} ${d.month} ${d.year}`, upper: true, font: 'Montserrat', size: 19, fill: ink, align: 'left' }), { l: 72, t: y }); L.push(dt); y = box(dt).b + 14; }
      const vl = venueLines(D, 3);
      if (vl) { const v = put(T({ name: 'Venue', text: vl, upper: true, font: 'Montserrat', size: 15, line: 1.25, fill: rgba(ink, 0.85), align: 'left', maxW: 380 }), { l: 72, t: y }); L.push(v); y = box(v).b + 14; }
      if (f.phone) L.push(put(T({ name: 'Phone', text: 'FOR INFO: ' + f.phone, font: 'Archivo Black', size: 22, fill: ink, align: 'left' }), { l: 72, t: y }));
      if (sp && sp.name) {
        L.push(...turn([SH({ name: 'Name ribbon', shape: 'rect', fill: '#ffffff', x: 800, y: H - 150, w: 760, h: 62, shadow: true }),
          put(T({ name: 'Speaker', text: sp.name, upper: true, font: 'Montserrat Black', size: 26, fill: deepInk, letter: 0.06, maxW: 640 }), { cx: 800, cy: H - 150 })], -14, 800, H - 150));
      }
      return L;
    },

    /* ── UNIQUE EXPERIENCE: a warm light page, a red line over a dark one, two ministers, the details on a tilted cream banner ── */
    unique(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 2), ink = '#1d1a18';
      const red = (() => { const [r, , b] = hexRgb(p.mid); return r > b + 30 && lum(p.mid) < 0.6 ? p.mid : '#d4141a'; })();
      L.push(BG({ img: D.bg, sat: -30, bright: 32, contrast: -8, wash: 'rgba(255,246,232,.6)', grain: 0.3,
        colorWash: [{ stops: ['#fffaf2', '#ffe6c4', '#f7c58a'], angle: 90, mode: 'soft-light', a: 0.8 }] }));
      const hd = header(D, { center: true, t: 30 }); hd.forEach((l) => { if (l.type === 'text') { l.fill = ink; l.shadow = false; } }); L.push(...hd);
      const [a, b] = twoLines(f.title || 'Unique Experience');
      let y = hd.bottom + 14;
      const t1 = stackLines([a || b], { t: y, fit: 900, maxH: H * 0.12, style: { font: 'Anton', upper: true, stretch: 1.15, fill: { stops: [mix(red, '#ffffff', 0.1), red], angle: 90 }, extrude: 2, extrudeColor: rgba('#000000', 0.2), shadow: false, noTex: true } });
      t1.forEach((l) => { l.inkSet = true; }); L.push(...t1); y = t1.bottom + 4;
      if (a && b) { const t2 = stackLines([b], { t: y, fit: 900, maxH: H * 0.1, style: { font: 'Anton', upper: true, stretch: 1.15, fill: { stops: ['#3a3634', ink], angle: 90 }, shadow: false, noTex: true } }); L.push(...t2); y = t2.bottom; }
      if (f.extra || f.theme) { const s = put(micro(f.extra || f.theme, { size: 18, letter: 0.7, fill: ink, shadow: false, maxW: 900 }), { cx: 540, t: y + 14 }); L.push(s); y = box(s).b; }
      const top = Math.max(y + 20, H * 0.36), bot = H - 150;
      if (ps.length === 2) {
        // each named over their own head ("nasty": the names sat on their suits, dark on dark, half hidden)
        const xs = [300, 780], nh = 64;
        L.push(hero(ps[1], { cx: xs[1], t: top + nh + 20, b: bot, mode: 'chest', fade: 0.25, minL: 560, extra: { fadeLight: true, shade: 'rgba(60,30,10,.25)' } }));
        L.push(hero(ps[0], { cx: xs[0], t: top + nh, b: bot, mode: 'chest', fade: 0.25, maxR: 600, extra: { fadeLight: true, shade: 'rgba(60,30,10,.25)' } }));
        ps.forEach((s, i) => { const np = nameParts(s.name || ''); if (!np.name) return; L.push(...col([np.title && T({ name: 'Speaker title', text: np.title, upper: true, font: 'Montserrat', size: 15, fill: ink, letter: 0.1 }), T({ name: 'Speaker', text: np.name, upper: true, font: 'Barlow Black Italic', size: 30, fill: ink, maxW: 440 })].filter(Boolean), { cx: xs[i], cy: top + nh / 2 + (i ? 20 : 0), gap: 2 })); });
      } else if (ps[0]) L.push(hero(ps[0], { cx: 540, t: Math.max(y + 10, H * 0.27), b: H - 60, mode: 'chest', fade: 0.12, extra: { fadeLight: true, shade: 'rgba(60,30,10,.25)' } }));   // one: big, standing behind the banner
      // the tilted cream banner
      const by = H - 112, band = [SH({ name: 'Banner', shape: 'rect', fill: '#f7e8cf', x: 540, y: by, w: 1240, h: 150, shadow: true })];
      const line1 = [d && `${d.day3}. ${d.mon3}. ${d.ddth} ${d.year}`, f.time].filter(Boolean).join('  |  ');
      if (line1) band.push(put(T({ name: 'When', text: line1, upper: true, font: 'Barlow Black Italic', size: 54, fill: ink, maxW: 960 }), { cx: 540, cy: by - 20 }));
      const vt = venueText(D);
      if (vt) { const g = venueGroup(vt, red, 860, { size: 18, ink, shadow: false }); band.push(...g.place(540, by + 34)); }
      L.push(...turn(band, -4, 540, by));
      return L;
    },

    /* ── THANKSGIVING: a white sky, a script word in gold over a red and gold-leaf title, the people below ── */
    thanks(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3), ink = '#211b18';
      const red = '#c5161d';
      L.push(BG({ img: D.bg, sat: -45, bright: 40, contrast: -12, wash: 'rgba(255,255,255,.66)', grain: 0.25 }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.3, w: 1300, h: 800, color: '#fff6e0', opacity: 0.9 }));
      const hd = header(D, { center: true, t: 30 }); hd.forEach((l) => { if (l.type === 'text') { l.fill = red; l.shadow = false; } }); L.push(...hd);
      let y = hd.bottom + 6;
      L.push(put(T({ name: 'Presents', text: 'presents', font: 'Great Vibes', size: 44, fill: red }), { cx: 540, t: y })); y += 56;
      const [a, b] = twoLines(f.title || 'Thanksgiving Service');
      const ts = stackLines([a, b].filter(Boolean), { t: y + 62, fit: 900, maxH: H * 0.13, gap: 4, style: { font: 'Playfair Black', upper: true, fill: { stops: ['#e2252b', '#9d0f14'], angle: 90 }, extrude: 2, extrudeColor: rgba('#5a0505', 0.4), shadow: false } });
      if (ts[1]) Object.assign(ts[1], { fill: '#ffffff', imgFill: 'tex:gold', imgFillA: 1, bevel: 0.9, extrudeColor: ['#6b3a04', '#1e0f01'] });
      ts.forEach((l) => { l.inkSet = true; });
      L.push(...ts);
      // gold on a red title, deep red on a stone or metal one ("Samson" was lost on a silver title); outlined, and sitting mostly above the words
      const onMetal = !!(ts[0] && ts[0].imgFill);
      L.push(put(T({ name: 'Script word', text: D.script, font: 'Great Vibes', size: 120, fill: onMetal ? '#b0121a' : '#c9921a', rot: -6, maxW: 620, shadow: true, inkSet: true, edge: 2.4, edgeColor: '#fffaf0' }), { cx: 470, cy: box(ts[0]).t - 16 }));
      y = ts.bottom + 18;
      // who is preaching, named under the title (it named nobody)
      if (ps.length) { const nm = put(T({ name: 'Speakers', text: (ps.length > 1 ? '' : 'with ') + namesOf(ps), upper: true, font: 'Montserrat Black', size: 21, letter: 0.06, fill: red, maxW: 960 }), { cx: 540, t: y + 6 }); L.push(nm); y = box(nm).b + 10; }
      const top = Math.max(y, H * 0.44), bot = H - 70;
      if (ps.length >= 2) {
        // two: both left of the date column on the right (the second stood over "16TH OCT")
        // ("nasty": the second stood behind the first, a shoulder and half a face) — side by side, each in their own half
        const xs = ps.length === 2 ? [240, 610] : [250, 540, 830], t2 = ps.length === 2 ? Math.max(top + (bot - top) * 0.2, bot - 600) : top;   // (no taller than fits two across)
        ps.forEach((s, i) => { if (i) L.push(hero(s, { cx: xs[i], t: t2 + 30, b: bot, mode: 'chest', fade: 0.3, maxR: ps.length === 2 ? 800 : undefined, extra: { fadeLight: true, shade: 'rgba(60,30,10,.2)' } })); });
        L.push(hero(ps[0], { cx: xs[0], t: t2, b: bot, mode: 'chest', fade: 0.3, maxR: ps.length === 2 ? 440 : undefined, extra: { fadeLight: true, shade: 'rgba(60,30,10,.2)' } }));
      } else if (ps[0]) L.push(hero(ps[0], { cx: 470, t: top, b: bot, mode: 'chest', fade: 0.3, maxR: 810, extra: { fadeLight: true, shade: 'rgba(60,30,10,.2)' } }));   // (clear of the date)
      if (d) L.push(...col([T({ name: 'Day', text: d.day.toUpperCase(), font: 'Montserrat', size: 18, fill: ink, align: 'right', letter: 0.2 }), T({ name: 'Date', text: `${d.ddth} ${d.mon3.toUpperCase()}`, font: 'Playfair Black', size: 46, fill: ink, align: 'right' }), T({ name: 'Year', text: d.year, font: 'Montserrat', size: 20, fill: ink, align: 'right' })], { r: 1020, cy: H * 0.7, gap: 2 }));
      if (f.time) L.push(...pill([{ text: f.time, font: 'Archivo Black', size: 36 }], { fill: red, ink: '#ffffff', radius: 6, padX: 18, padY: 8, shadow: true }).place(940, H * 0.81));
      const vt = venueText(D);
      if (vt) { L.push(SH({ name: 'Venue bar', shape: 'rect', fill: rgba('#ffffff', 0.9), x: 540, y: H - 40, w: W, h: 64 })); L.push(put(T({ name: 'Venue', text: 'VENUE: ' + vt, upper: true, font: 'Montserrat', size: 18, fill: ink, maxW: 980 }), { cx: 540, cy: H - 40 })); }
      return L;
    },

    /* ── PROPHETIC MANTLE: a cream and gold page, a tall elegant serif title in gold, the minister at the foot, the details either side ── */
    mantle(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D), ink = '#3b2706';
      L.push(BG({ img: D.bg, sat: -20, bright: 26, contrast: -4, wash: 'rgba(255,244,214,.55)', grain: 0.3,
        colorWash: [{ stops: ['#fff8e6', '#f6d98a', '#d9a23a'], angle: 90, mode: 'soft-light', a: 0.85 },
          { radial: true, x: 0.5, y: 0.55, r: 0.55, stops: ['rgba(255,240,190,.95)', 'rgba(255,240,190,0)'], mode: 'screen', a: 0.7 }] }));
      L.push(FX({ kind: 'beams', x: 540, y: H * 0.55, w: 1000, h: H * 0.6, n: 4, seed: 3, color: '#ffe9a8', opacity: 0.45 }));
      const hd = header(D); hd.forEach((l) => { if (l.type === 'text') { l.fill = ink; l.shadow = false; } }); L.push(...hd);
      let y = H * 0.13;
      if (D.dir.kicker) { const k = put(T({ name: 'Kicker', text: '- ' + D.dir.kicker + ' -', upper: true, font: 'Montserrat', size: 18, letter: 0.3, fill: ink }), { cx: 540, t: y }); L.push(k); y = box(k).b + 12; }
      const lines = stack(f.title || 'Prophetic Mantle Service', 3), n = lines.length;
      const ts = stackLines(lines, { t: y, fit: 900, maxH: H * (n === 1 ? 0.2 : n === 2 ? 0.14 : 0.105), gap: 0,
        style: { font: 'Bodoni Light', upper: true, stretch: 1.5, letter: -0.01, fill: { stops: ['#a8740e', '#e3b53c', '#7a4f05'], angle: 90 }, shadow: false, noTex: true } });
      ts.forEach((l) => { l.inkSet = true; }); L.push(...ts);
      if (sp) L.push(hero(sp, { cx: 540, t: Math.max(ts.bottom - 20, H * 0.5), b: H - 90, mode: 'chest', fade: 0.3, extra: { fadeLight: true, shade: 'rgba(80,50,10,.2)', tint: { color: '#f6c445', a: 0.18, fall: 0.4 } } }));
      if (f.time) L.push(...col([T({ name: 'Time', text: f.time, font: 'Bodoni', size: 52, fill: ink, align: 'left' }), f.time2 && T({ name: 'Time 2', text: f.time2, font: 'Bodoni', size: 52, fill: ink, align: 'left' })].filter(Boolean), { l: 64, cy: H * 0.68, gap: 0 }));
      if (d) L.push(...col([T({ name: 'Date', text: `${d.day3}. ${d.ddth}`, upper: true, font: 'Bodoni', size: 52, fill: ink, align: 'right' }), T({ name: 'Month', text: d.month.toUpperCase(), font: 'Bodoni', size: 40, fill: ink, align: 'right' })], { r: 1016, cy: H * 0.66, gap: 0 }));
      if (sp && sp.name) { const np = nameParts(sp.name); L.push(...col([T({ name: 'Ministering', text: 'MINISTERING', font: 'Montserrat', size: 13, letter: 0.2, fill: ink, align: 'right' }), np.title && T({ name: 'Speaker title', text: np.title, font: 'Montserrat Black', size: 22, fill: ink, align: 'right' }), T({ name: 'Speaker', text: np.name, font: 'Montserrat Black', size: 26, fill: ink, align: 'right', maxW: 300 })].filter(Boolean), { r: 1016, t: H * 0.75, gap: 2 })); }
      const vt = venueText(D);
      L.push(SH({ name: 'Foot', shape: 'rect', fill: { stops: [rgba('#3b2706', 0), rgba('#3b2706', 0.85)], angle: 90 }, x: 540, y: H - 50, w: W, h: 100 }));
      // the church's name once (the address may start with it)
      const foot = f.church && !nameWords(vt).startsWith(nameWords(f.church)) ? [f.church, vt].join(' - ') : vt;
      if (vt) L.push(put(T({ name: 'Venue', text: foot, upper: true, font: 'Montserrat', size: 18, letter: 0.08, fill: '#fff7e0', maxW: 980, shadow: true }), { cx: 540, b: H - 30 }));
      return L;
    },

    /* ════════ RADIANT — the flyer a church held up as better than all of ours ════════ */

    /* ── RADIANT: an electric page of sweeping light that turns white at the foot; the title huge and white;
          the ministers in front of it, the date in a column beside them; WITH over their names on one bar;
          then the whole address, the apps and the number, on the white ──
       ►► THE STANDARD. ◄◄ "I gave you a standard… I expected massive build and better inspiration from it." The
       church's own Sunday Service flyer is the bar, and its light is copied closer: warm lens light at the page's
       edges, a glossy wave sweeping up under the ministers, soft orbs of light, the day written large in script
       behind the title. Its family (below) keeps that finish and changes the composition. */
    radiant(D) {
      const H = D.h, f = D.f, L = [], ps = spsOf(D).slice(0, 3), P = stdPal(D.pal);
      L.push(...stdLight(D, P, 'electric'));
      L.push(...crest(D, 58, '#ffffff'));
      // the title: as wide as the page, white going icy at the foot of each line, a glow of the light behind
      const lines = stack(f.title || 'Sunday Service', 3), tTop = H > 1200 ? 112 : 100, maxH0 = Math.min(lines.length > 2 ? 128 : 178, H * (lines.length > 2 ? 0.1 : 0.165));
      const fill = { stops: ['#ffffff', '#ffffff', mix(P.glow, '#ffffff', 0.45)], angle: 90 };
      const titleAt = (stretch, maxH) => titleLines(lines, { align: 'center', t: tTop, w: 950, maxH, gap: 12, letter: -0.02,
        fill, style: { stretch, glow: rgba(P.glow, 0.5), shadow: true, inkSet: true } });
      let ts = titleAt(1.12, maxH0);
      const barT = H - 240, lineH = (t) => box(t[t.length - 1]).h;
      // the ministers, in front of the title's foot, down behind the bars (sized by their own head and shoulders)
      const n = ps.length, xs = n === 3 ? [0.25, 0.47, 0.68] : n === 2 ? [0.38, 0.645] : [0.42], dt = n === 3 ? [26, 0, 40] : [0, 34];
      const people = stdPeople(ps, (i) => ({ cx: W * xs[i], t: ts.bottom - lineH(ts) * 0.3 + (dt[i] || 0), b: barT + 46,
        maxU: W * (n === 1 ? 0.27 : n === 2 ? 0.24 : 0.17) * clamp(H / 1350, 1, 1.15) }), P);
      // their heads lower than the title's foot (a photo that stops at the chest, a tall page): the title's letters
      // stand taller to meet them, as a designer would set it, and what is left of the gap goes under it
      if (people.length) {
        const want = Math.min(...people.map((im) => im.y - im.h / 2)) + lineH(ts) * 0.2;
        if (want > ts.bottom + 8) {
          const r = Math.min(1.4, (want - tTop) / Math.max(1, ts.bottom - tTop));
          ts = titleAt(1.12 * r, maxH0 * r);
          if (want > ts.bottom) shiftY(ts, Math.min((want - ts.bottom) * 0.5, H * 0.04));
        }
      }
      L.push(...stdScript(D, P, ts), ...ts, ...people);
      const top = ts.bottom - lineH(ts) * 0.3;
      // when: the day, the date large in italics, a line, the time — a column at the right with a line of light beside it
      L.push(...stdWhen(D, P, n ? { l: 886, cy: (top + barT) / 2 + 30 } : { cx: 540, cy: (top + barT) / 2 + 30 }));
      L.push(...stdBars(D, P, ps, barT, f.theme || ''));
      L.push(...stdFoot(D, P, barT + 82, false));
      return L;
    },
    /* ── SPOTLIGHT: the standard on a dark stage, set like a poster — the ministers big at the top in the beams, the
          title huge in gold low on the page over the dark they fade into, the date on one line under it, WITH over
          their names, the address in white ("they look the same": it was Radiant's layout in gold) ── */
    radiantspot(D) {
      const H = D.h, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3), P = stdPal(D.pal), n = ps.length;
      L.push(...stdLight(D, P, 'spot'));
      L.push(...crest(D, 58, '#ffffff'));
      const barT = H - 240, gold = '#e9bd5a';
      // from the foot up: the bars, the date line, the theme, then the title
      const whenTxt = [d && `${d.day}, ${d.ddth} ${d.mon3} ${d.year}`, f.time && f.time + (f.time2 ? ' & ' + f.time2 : '')].filter(Boolean).join('  •  ');
      const whenY = barT - (n ? 92 : 50);
      const theme = n && f.theme ? f.theme : '';
      const lines = stack(f.title || 'Sunday Service', 2);
      const ts = titleLines(lines, { align: 'center', t: 0, w: 960, maxH: Math.min(lines.length > 1 ? 160 : 200, H * (lines.length > 1 ? 0.115 : 0.16)), gap: 8, letter: -0.02,
        fill: 'gold', style: { stretch: 1.12, glow: rgba('#ffcf6b', 0.35), shadow: true, inkSet: true } });
      shiftY(ts, whenY - (whenTxt ? 46 : 0) - (theme ? 52 : 0) - ts.bottom); ts.bottom = Math.max(...ts.map((l) => box(l).b));
      const tTop = Math.min(...ts.map((l) => box(l).t));
      // the ministers: big, from the top, down behind the title (their faces kept above it)
      const xs = n === 3 ? [0.24, 0.5, 0.76] : n === 2 ? [0.35, 0.65] : [0.5];
      const people = stdPeople(ps, (i) => ({ cx: W * xs[i], t: H * (H / W < 1.1 ? 0.1 : 0.11) + (n === 3 && i !== 1 ? 30 : 0), b: tTop + (tTop - H * 0.1) * 0.55, maxR: null,
        maxU: W * (n === 1 ? 0.36 : n === 2 ? 0.27 : 0.19) * clamp(H / 1350, 1, 1.15) }), P);
      L.push(...people);
      // the dark they fade into, so the gold title reads
      L.push(SH({ name: 'Stage dark', lock: true, shape: 'fade', fill: '#05030c', strength: 1, x: 540, y: (tTop - H * 0.12 + H) / 2, w: W, h: H - tTop + H * 0.12 }));
      L.push(...stdScript(D, P, ts), ...ts);
      if (theme) L.push(put(T({ name: 'Theme', text: theme, upper: true, font: 'Montserrat', size: 26, letter: 0.24, fill: '#fff3d6', maxW: 900, shadow: true, inkSet: true }), { cx: 540, cy: ts.bottom + 32 }));
      if (whenTxt) {
        const wt = put(T({ name: 'When', text: whenTxt, upper: true, font: 'Montserrat Black', size: 36, fill: '#ffffff', maxW: 860, shadow: true, inkSet: true }), { cx: 540, cy: whenY });
        const r = box(wt), rl = Math.min(90, (r.l - 40) * 0.8);
        L.push(wt);
        if (rl > 24) L.push(SH({ name: 'Rule', shape: 'rect', fill: gold, x: r.l - 20 - rl / 2, y: whenY, w: rl, h: 3 }), SH({ name: 'Rule', shape: 'rect', fill: gold, x: r.r + 20 + rl / 2, y: whenY, w: rl, h: 3 }));
      }
      L.push(...stdBars(D, P, ps, barT, f.theme || ''));
      L.push(...stdFoot(D, P, barT + 82, true));
      return L;
    },

    /* ── SIDE: the minister big at one side, from the waist; the title stacked huge beside them, the date under it,
          WITH over the name across their foot; the address and the apps on the white ── */
    radiantside(D) {
      const H = D.h, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 2), P = stdPal(D.pal), n = ps.length;
      L.push(...stdLight(D, P, 'side'));
      L.push(...crest(D, 58, '#ffffff'));
      const barT = H - 240;
      // the title, left, as many lines as its words want (3 at most), as big as the half page takes
      const colW = n ? 560 : 950, lines = stack(f.title || 'Sunday Service', 3);
      const ts = titleLines(lines, { align: n ? 'left' : 'center', l: 64, cx: 540, t: H * 0.15, w: colW, maxH: Math.min(200, H * (lines.length > 2 ? 0.11 : 0.15)), gap: 10, letter: -0.02,
        fill: { stops: ['#ffffff', '#ffffff', mix(P.glow, '#ffffff', 0.45)], angle: 90 }, style: { stretch: 1.12, glow: rgba(P.glow, 0.5), shadow: true, inkSet: true } });
      L.push(...stdScript(D, P, ts));
      L.push(...ts);
      let y = ts.bottom + 26;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 26, letter: 0.16, fill: mix(P.glow, '#ffffff', 0.6), align: n ? 'left' : 'center', maxW: colW, shadow: true, inkSet: true }), n ? { l: 68, t: y } : { cx: 540, t: y }); L.push(th); y = box(th).b + 30; }
      // the date: a card of glass under the title — the day, the date big, the time
      if (d || f.time) {
        const al = n ? 'left' : 'center';
        const when = [d && T({ name: 'Day', text: d.day + ',', upper: true, font: 'Montserrat Black', size: 36, letter: 0.04, fill: '#ffffff', align: al, shadow: true, inkSet: true }),
          d && T({ name: 'Date', text: `${d.ddth} ${d.mon3} ${d.year}`, upper: true, font: 'Montserrat Italic', size: 60, fill: '#ffffff', align: al, maxW: colW - 60, shadow: true, inkSet: true }),
          f.time && T({ name: 'Time', text: f.time + (f.time2 ? ' & ' + f.time2 : ''), upper: true, font: 'Montserrat Black', size: 56, fill: mix(P.glow, '#ffffff', 0.35), align: al, maxW: colW - 60, shadow: true, inkSet: true })].filter(Boolean);
        const wc = col(when, n ? { l: 100, t: y + 24, gap: 6 } : { cx: 540, t: y + 24, gap: 6 });
        const bw = Math.min(colW, Math.max(...wc.map((l) => box(l).w)) + 64), bh = wc.length ? box(wc[wc.length - 1]).b - box(wc[0]).t + 44 : 0;
        L.push(SH({ name: 'Date card', shape: 'round', radius: 22, fill: { stops: [rgba('#ffffff', 0.2), rgba(P.navy, 0.35)], angle: 90 }, x: n ? 64 + bw / 2 : 540, y: box(wc[0]).t - 22 + bh / 2, w: bw, h: bh }));
        if (n) L.push(SH({ name: 'Line', shape: 'rect', fill: P.glow, x: 70, y: box(wc[0]).t - 22 + bh / 2, w: 6, h: bh - 28 }));
        L.push(...wc);
      }
      // the ministers: one big at the right, from the waist; two side by side there
      // (two: smaller, and kept right of the title's column — the date card is never under an arm or a shoulder)
      const sq = H / W < 1.1, xs = n === 2 ? (sq ? [0.67, 0.87] : [0.7, 0.88]) : [0.74];
      const people = stdPeople(ps, (i) => ({ cx: W * xs[i], t: H * (n === 2 ? (sq ? 0.36 : 0.4) : 0.2) + (i ? 40 : 0), b: barT + 46, maxR: null,
        maxU: W * (n === 2 ? (sq ? 0.15 : 0.18) : sq ? 0.26 : 0.3) * clamp(H / 1350, 1, 1.15) }), P);
      L.push(...people);
      L.push(...stdBars(D, P, ps, barT, f.theme || '', n ? 1080 - 64 - 330 : 540));
      L.push(...stdFoot(D, P, barT + 82, false));
      return L;
    },

    /* ── WAVE: the standard turned over — a light page of soft colour above, the title in deep colour, the
          ministers in front of a great wave of colour rising at the foot that carries the date and the names in
          white; the address and the apps on it ── */
    radiantwave(D) {
      const H = D.h, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3), P = stdPal(D.pal), n = ps.length;
      L.push(...stdLight(D, P, 'wave'));
      L.push(...crest(D, 58, P.navy));
      const lines = stack(f.title || 'Sunday Service', 3), tTop = H > 1200 ? 112 : 100;
      const ts = titleLines(lines, { align: 'center', t: tTop, w: 950, maxH: Math.min(lines.length > 2 ? 120 : 170, H * (lines.length > 2 ? 0.095 : 0.15)), gap: 10, letter: -0.02,
        fill: { stops: [P.navy, P.main], angle: 90 }, style: { stretch: 1.1, shadow: false, inkSet: true } });
      L.push(...ts);
      let y = ts.bottom + 18;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 26, letter: 0.2, fill: P.main, maxW: 940, inkSet: true }), { cx: 540, t: y }); L.push(th); y = box(th).b + 10; }
      const waveT = H * 0.7, barT = H - 250;
      const xs = n === 3 ? [0.27, 0.5, 0.73] : n === 2 ? [0.36, 0.64] : [0.5];
      const people = stdPeople(ps, (i) => ({ cx: W * xs[i], t: y + 8 + (n === 3 && i !== 1 ? 34 : 0), b: waveT + 60, maxR: null,
        maxU: W * (n === 1 ? 0.42 : n === 2 ? 0.29 : 0.2) * clamp(H / 1350, 1, 1.15) }), P);
      L.push(...people);
      // the wave, in front of their feet: deep colour with a bright crest, the date across it in one line
      L.push(SH({ name: 'Wave glow', lock: true, shape: 'swoosh', bend: -1, thick: H * 0.05, fill: rgba(P.glow, 0.9), x: 540, y: waveT + 30, w: W * 1.3, h: H * 0.12, rot: -4 }));
      L.push(SH({ name: 'Wave', lock: true, shape: 'slant', skew: 70, fill: { stops: [P.main, P.deep], angle: 90 }, x: 540, y: (waveT + 40 + H) / 2 + 10, w: W, h: H - waveT - 20 }));
      L.push(FX({ kind: 'silk', x: 540, y: H * 0.9, w: W, h: H * 0.3, n: 5, seed: 9, color: mix(P.glow, '#ffffff', 0.3), color2: P.haze, opacity: 0.8 }));
      const whenTxt = [d && `${d.day}, ${d.ddth} ${d.mon3} ${d.year}`, f.time].filter(Boolean).join('  •  ');
      if (whenTxt) L.push(put(T({ name: 'When', text: whenTxt, upper: true, font: 'Montserrat Black', size: 40, fill: '#ffffff', maxW: 980, shadow: true, inkSet: true }), { cx: 540, cy: waveT + 108 }));
      const said = n ? jointNames(ps) : '';
      if (said) {
        const nt = T({ name: 'Speakers', text: (n ? 'WITH ' : '') + said, upper: true, font: 'Montserrat', size: 26, letter: 0.06, fill: P.navy, maxW: 900, inkSet: true });
        const bw = clamp(box(nt).w + 90, 560, 1000);
        L.push(SH({ name: 'Names bar', shape: 'pill', fill: '#ffffff', x: 540, y: waveT + 176, w: bw, h: 58 }), put(nt, { cx: 540, cy: waveT + 176 }));
      }
      const at = addressLines(f.venue, 2);
      if (at) L.push(put(T({ name: 'Venue', text: at, upper: true, font: 'Montserrat', size: 22, line: 1.15, fill: '#ffffff', maxW: 1000, inkSet: true }), { cx: 540, t: waveT + 222 }));
      L.push(...appRow(D, H - 36, '#ffffff'));
      return L;
    },

    /* ════════ BRIGHT AND SIMPLE — a light page, one colour, the minister in a frame (see SIMPLE) ════════ */

    /* ── ARCH: the title big across the top, the minister in an arch of colour, the details beside it ── */
    arch(D) {
      const H = D.h, p = D.pal, f = D.f, L = [], sp = sp0(D), acc = oneColour(p);
      L.push(BG({ plain: '#faf7f2', grain: 0 }));
      L.push(...inked(header(D), INK));
      const ts = titleLines(stack(f.title || 'Sunday Service', 2), { l: 64, t: H * 0.13, w: 952, maxH: H * 0.1, fills: [INK, acc] });
      L.push(...ts);
      let y = ts.bottom;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 22, letter: 0.14, fill: '#3a3a42', align: 'left', maxW: 952 }), { l: 64, t: y + 22 }); L.push(th); y = box(th).b; }
      const aw = 476, al = 1016 - aw, ab = H - 56, ah = Math.min(ab - (y + 44), aw * 1.85), at = ab - ah;
      if (sp) {
        L.push(SH({ name: 'Arch line', shape: 'arch', line: 3, fill: acc, x: al + aw / 2 - 20, y: at + ah / 2 - 20, w: aw, h: ah }));
        L.push(...framed(sp, { shape: 'arch', l: al, t: at, w: aw, h: ah, fill: acc }));
      } else L.push(SH({ name: 'Frame', shape: 'arch', fill: acc, x: al + aw / 2, y: at + ah / 2, w: aw, h: ah }));
      L.push(...detailStack(D, { l: 64, t: at + 6, w: al - 64 - 36, acc }));
      if (sp) L.push(...simpleName(sp, { l: 64, b: ab, acc, maxW: al - 64 - 36, size: 28 }));
      return L;
    },

    /* ── CIRCLE: a white page, the title over a circle of colour with the minister in it, the details on a band of the same colour ── */
    circle(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 2), acc = oneColour(p);
      L.push(BG({ plain: '#ffffff', grain: 0 }));
      const hd = inked(header(D, { center: true, t: 34 }), INK); L.push(...hd);
      let y = Math.max(hd.bottom || 0, 40) + 10;
      const kick = f.theme || D.dir.kicker || '';
      if (kick) { const k = put(T({ name: 'Kicker', text: kick, upper: true, font: 'Montserrat', size: 20, letter: 0.3, fill: acc, maxW: 900 }), { cx: 540, t: y }); L.push(k); y = box(k).b + 18; }
      const ts = titleLines(stack(f.title || 'Sunday Service', 2), { align: 'center', t: y, w: 920, maxH: H * 0.082, fills: [INK, acc] });
      L.push(...ts);
      const bh = Math.round(H * 0.125), top = ts.bottom + 36, bot = H - bh - 70;
      if (ps.length === 2) {
        const dd = Math.min(470, bot - top), cy = top + (bot - top) / 2;
        ps.forEach((s, i) => { const cx = 540 + (i ? 1 : -1) * dd * 0.47; L.push(...framed(s, { shape: 'circle', l: cx - dd / 2, t: cy - dd / 2, w: dd, h: dd, fill: i ? mix(acc, '#000000', 0.18) : acc, mode: 'bust', head: 0.14 })); });
        ps.forEach((s, i) => { const cx = 540 + (i ? 1 : -1) * dd * 0.5; if (s.name) L.push(...pill([{ text: s.name, upper: true, font: 'Montserrat Black', size: 18, letter: 0.03, maxW: dd * 0.8 }], { fill: INK, ink: '#ffffff', radius: 30, padX: 18, padY: 10 }).place(cx, cy + dd / 2 + 8)); });
      } else {
        const dd = Math.min(H > 1500 ? 900 : 700, bot - top), cy = top + (bot - top) / 2;
        L.push(SH({ name: 'Halo', shape: 'circle', fill: mix(acc, '#ffffff', 0.86), x: 540, y: cy, w: dd + 56, h: dd + 56 }));
        if (ps[0]) L.push(...framed(ps[0], { shape: 'circle', l: 540 - dd / 2, t: cy - dd / 2, w: dd, h: dd, fill: acc, mode: 'bust', head: 0.12 }));
        else L.push(SH({ name: 'Frame', shape: 'circle', fill: acc, x: 540, y: cy, w: dd, h: dd }));
        if (ps[0] && ps[0].name) L.push(...pill([{ text: ps[0].name, upper: true, font: 'Montserrat Black', size: 22, letter: 0.04, maxW: 640 }], { fill: INK, ink: '#ffffff', radius: 40, padX: 26, padY: 12 }).place(540, cy + dd / 2));
      }
      L.push(SH({ name: 'Band', shape: 'rect', fill: acc, x: 540, y: H - bh / 2, w: W, h: bh }));
      L.push(...infoRow(D, H - bh / 2, [d && { name: 'Date', big: `${d.ddth} ${d.mon3}`, small: `${d.day} ${d.year}`, font: 'Montserrat Black', size: 38 },
        f.time && { name: 'Time', big: f.time, small: f.time2 ? 'and ' + f.time2 : '', font: 'Montserrat Black', size: 38 },
        venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 330, smallSize: 15, pin: true }], { ink: '#ffffff', accent: '#ffffff', lineH: 60, gap: 26 }));
      return L;
    },

    /* ── COLOUR PANEL: the page split — the words on white at the left, the minister on a panel of colour at the right ── */
    split(D) {
      const H = D.h, p = D.pal, f = D.f, L = [], sp = sp0(D), acc = oneColour(p), px = 556;
      L.push(BG({ plain: '#ffffff', grain: 0 }));
      if (sp) L.push(...framed(sp, { shape: 'rect', l: px, t: 0, w: W - px, h: H, fill: acc, mode: 'waist', head: 0.34, fitW: 0.78 }));
      else L.push(SH({ name: 'Frame', shape: 'rect', fill: acc, x: (px + W) / 2, y: H / 2, w: W - px, h: H }));
      L.push(...inked(header(D, { maxW: px - 150 }), INK));
      const cw = px - 64 - 44;
      const lines = stack(f.title || 'Sunday Service', 3);
      const ts = titleLines(lines, { l: 64, t: H * 0.17, w: cw, maxH: H * 0.075, fills: lines.map((_, i) => (lines.length > 1 && i === lines.length - 1 ? acc : INK)) });
      L.push(...ts);
      let y = ts.bottom;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 20, letter: 0.12, line: 1.25, fill: '#3a3a42', align: 'left', maxW: cw }), { l: 64, t: y + 20 }); L.push(th); y = box(th).b; }
      const nm = sp ? simpleName(sp, { l: 64, b: H - 64, acc, maxW: cw, size: 28 }) : [];
      const ds = detailStack(D, { l: 64, t: 0, w: cw, acc, big: 42 });
      // the details half-way between the title and the name
      const room = (nm.length ? nm.top : H - 64) - y, dh = ds.bottom - ds.top;
      shiftY(ds, y + Math.max(36, (room - dh) / 2) - ds.top);
      L.push(...ds, ...nm);
      return L;
    },

    /* ── ARCHES: the title over the top, one minister, two or three each in an arch, the day and time in one line, the address at the foot ── */
    arches(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3), acc = oneColour(p);
      L.push(BG({ plain: '#f6f2ea', grain: 0 }));
      const hd = inked(header(D, { center: true, t: 34 }), INK); L.push(...hd);
      let y = Math.max(hd.bottom || 0, 40) + 14;
      const ts = titleLines(stack(f.title || 'Sunday Service', 2), { align: 'center', t: y, w: 900, maxH: H * 0.085, fills: [INK, acc] });
      L.push(...ts); y = ts.bottom + 22;
      const when = [d && `${d.day} ${d.ddth} ${d.month}`, f.time && f.time + (f.time2 ? ' & ' + f.time2 : '')].filter(Boolean).join('   •   ');
      if (when) { const w1 = put(T({ name: 'When', text: when, upper: true, font: 'Montserrat Black', size: 30, letter: 0.02, fill: acc, maxW: 960 }), { cx: 540, t: y }); L.push(w1); y = box(w1).b; }
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 19, letter: 0.16, fill: '#3a3a42', maxW: 900 }), { cx: 540, t: y + 14 }); L.push(th); y = box(th).b; }
      const vt = venueText(D), foot = H - 52, nameH = 58, bot = (vt ? foot - 44 : H - 40) - nameH, top = y + 40;
      // (a story is taller: the arches grow with it, not the gap above them)
      const n = Math.max(1, ps.length), tall = Math.max(1, H / 1350), gap = n === 3 ? 32 : 44;
      const aw = n === 3 ? 300 : n === 2 ? Math.min(470, 420 * tall) : Math.min(720, 560 * tall), ah = Math.min(bot - top, aw * (n === 3 ? 1.75 : n === 2 ? 1.6 : 1.45));
      for (let i = 0; i < n; i++) {
        const s = ps[i], cx = 540 + (i - (n - 1) / 2) * (aw + gap);
        if (s) L.push(...framed(s, { shape: 'arch', l: cx - aw / 2, t: bot - ah, w: aw, h: ah, fill: i % 2 ? mix(acc, '#000000', 0.18) : acc }));
        else L.push(SH({ name: 'Frame', shape: 'arch', fill: acc, x: cx, y: bot - ah / 2, w: aw, h: ah }));
        if (s && s.name) L.push(put(T({ name: 'Speaker', text: s.name, upper: true, font: 'Montserrat Black', size: n === 3 ? 20 : 24, letter: 0.03, fill: INK, maxW: aw }), { cx, t: bot + 18 }));
      }
      if (vt) { const g = venueGroup(vt, acc, 860, { size: 18, ink: '#3a3a42', shadow: false }); L.push(...g.place(540, foot)); }
      return L;
    },

    /* ── BIG WORDS: the title huge on a page of the palest colour, the minister small in a circle, the details along the foot ── */
    bigword(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3), acc = oneColour(p);
      L.push(BG({ plain: mix(acc, '#ffffff', 0.9), grain: 0 }));
      L.push(...inked(header(D), INK));
      // the people big enough to see who they are ("nasty": a 270 px circle under a 1000 px title); the title takes what is left
      const three = ps.length === 3, rowY = H - 78, lineY = H - 150, pd = three ? 230 : ps.length === 2 ? Math.round(Math.min(380, H * 0.28)) : Math.round(Math.min(540, H * 0.4)), pt = lineY - 40 - pd - (three ? 50 : 0);
      // who: one in a circle with the name beside them; two side by side, named beside them; three in a row, each named under
      if (three) {
        ps.forEach((s, i) => {
          const cx = 540 + (i - 1) * (pd + 70);
          L.push(...framed(s, { shape: 'circle', l: cx - pd / 2, t: pt, w: pd, h: pd, fill: i % 2 ? mix(acc, '#000000', 0.18) : acc, mode: 'bust', head: 0.14 }));
          if (s.name) L.push(put(T({ name: 'Speaker', text: s.name, upper: true, font: 'Montserrat Black', size: 19, line: 1.05, fill: INK, maxW: pd + 60 }), { cx, t: pt + pd + 16 }));
        });
      } else if (ps.length === 2) {
        // two circles side by side in the middle, each named under (beside them the names had 230 px and broke up)
        const gap = 70, x0 = 540 - pd - gap / 2;
        ps.forEach((s, i) => {
          const l = x0 + i * (pd + gap);
          L.push(...framed(s, { shape: 'circle', l, t: pt - 40, w: pd, h: pd, fill: i ? mix(acc, '#000000', 0.18) : acc, mode: 'bust', head: 0.14 }));
          if (s.name) L.push(put(T({ name: 'Speaker', text: s.name, upper: true, font: 'Montserrat Black', size: 22, line: 1.05, fill: INK, maxW: pd + 60 }), { cx: l + pd / 2, t: pt - 40 + pd + 14 }));
        });
      } else if (ps[0]) {
        L.push(...framed(ps[0], { shape: 'circle', l: 64, t: pt, w: pd, h: pd, fill: acc, mode: 'bust', head: 0.12 }));
        L.push(...simpleName(ps[0], { l: 64 + pd + 40, cy: pt + pd / 2, acc, size: 40, maxW: 1016 - (64 + pd + 40) }));
      }
      // the title, as big as it goes, in the room above them
      const lines = stack(f.title || 'Sunday Service', 3);
      const room = (ps.length ? pt - (ps.length === 2 ? 40 : 0) : lineY) - 40 - H * 0.13 - (f.theme ? 60 : 0);
      const ts = titleLines(lines, { l: 64, t: 0, w: 952, maxH: Math.min(H * 0.14, room / lines.length * 0.88), fills: lines.map((_, i) => (lines.length > 1 && i === lines.length - 1 ? acc : INK)) });
      const th = f.theme ? T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 22, letter: 0.14, fill: '#3a3a42', align: 'left', maxW: 952 }) : null;
      const block = th ? ts.concat(put(th, { l: 64, t: ts.bottom + 26 })) : ts;
      const bTop = ts.top, bBot = th ? box(th).b : ts.bottom, room0 = H * 0.13, room1 = (ps.length ? pt : lineY) - 40;
      shiftY(block, room0 + Math.max(0, (room1 - room0 - (bBot - bTop)) / 2) - bTop);
      L.push(...block);
      L.push(SH({ name: 'Rule', shape: 'rect', fill: rgba(INK, 0.18), x: 540, y: lineY, w: 952, h: 2 }));
      L.push(...infoRow(D, rowY, [d && { name: 'Date', big: `${d.ddth} ${d.mon3} ${d.year}`, font: 'Montserrat Black', size: 34 },
        f.time && { name: 'Time', big: f.time + (f.time2 ? ' & ' + f.time2 : ''), font: 'Montserrat Black', size: 34, accent: true },
        venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 330, smallSize: 15 }], { ink: INK, accent: acc, lineH: 52, gap: 24 }));
      return L;
    },

    /* ════════ SEVERAL MINISTERS — conferences, conventions, concerts ════════ */

    /* ── URGENCY: the main minister big in the middle, the rest in a row along the foot, each named; the title over the top ── */
    urgency(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 6);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 14, sat: 24, keep: 0.14, topShade: 0.35, bottomShade: 0.85, bottomFrom: 0.62, vignette: 0.35,
        colorWash: [{ stops: [mix(p.accent, '#ffffff', 0.2), p.mid, p.deep], angle: 90, mode: 'soft-light', a: 0.7 }] }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.42, w: 1100, h: 900, opacity: 0.55 }));
      L.push(...header(D, { center: true, t: 28 }));
      const tsT = stackLines(stack(f.title || 'Urgency', 2), { t: H * 0.1, fit: 860, maxH: H * 0.12, gap: 4,
        style: solid3d(p, { font: 'Archivo Black', fill: GOLD, extrude: 4, glow: rgba(p.accent, 0.35) }) });
      L.push(...tsT);
      let y = tsT.bottom + 10;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, font: 'Great Vibes', size: 60, maxW: 700, shadow: true }), { cx: 540, t: y }); L.push(th); y = box(th).b; }
      const others = ps.slice(1), rowH = others.length ? H * 0.2 : 0, rowT = H - 70 - rowH;
      if (ps[0]) L.push(hero(ps[0], { cx: 540, t: Math.max(y + 6, H * 0.28), b: others.length ? rowT + rowH * 0.35 : H - 40, mode: 'chest', fade: 0.3, extra: lit(p) }));
      if (others.length) {
        const n = others.length, step = Math.min(220, 1000 / n), x0 = 540 - step * (n - 1) / 2;
        others.forEach((s, i) => {
          const cx = x0 + i * step;
          L.push(hero(s, { cx, t: rowT, b: H - 64, mode: 'chest', fade: 0.25, extra: lit(p) }));
          const np = nameParts(s.name || '');
          L.push(...col([np.title && T({ name: 'Minister title', text: np.title, upper: true, font: 'Montserrat', size: 11, letter: 0.1, shadow: true }), T({ name: 'Minister', text: np.name || '', upper: true, font: 'Montserrat Black', size: 14, maxW: step - 10, shadow: true })].filter(Boolean), { cx, b: H - 22, gap: 1 }));
        });
      }
      L.push(...col([f.time && T({ name: 'Time', text: f.time, font: 'Archivo Black', size: 48, fill: p.accent, align: 'left', shadow: true }), d && T({ name: 'Date', text: `${d.day}\n${d.ddth} ${d.mon3}.\n${d.year}`, upper: true, font: 'Barlow Black Italic', size: 34, line: 0.95, align: 'left', shadow: true })].filter(Boolean), { l: 50, cy: H * 0.52, gap: 8 }));
      const vt = venueLines(D, 2);
      if (vt) { const g = venueGroup(vt, p.accent, 230, { size: 15 }); L.push(...g.place(1030 - g.w / 2, H * 0.5)); }
      return L;
    },

    /* ── THE HARVEST: the ministers in two rows across the top, each named, the title huge beneath them, the details on a bar ── */
    harvest(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 7);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 16, sat: 16, keep: 0.12, topShade: 0.5, bottomShade: 0.95, bottomFrom: 0.55, vignette: 0.4 }));
      L.push(FX({ kind: 'ring', x: 540, y: H * 0.3, w: 760, h: 760, opacity: 0.55 }));
      L.push(...header(D, { center: true, t: 26 }));
      const n = ps.length, back = ps.slice(Math.ceil(n / 2)), front = ps.slice(0, Math.ceil(n / 2));
      const row = (list, t, b, sz) => {
        if (!list.length) return;
        const step = Math.min(300, 960 / list.length), x0 = 540 - step * (list.length - 1) / 2;
        list.forEach((s, i) => {
          const cx = x0 + i * step;
          L.push(hero(s, { cx, t, b, mode: 'chest', fade: 0.3, extra: lit(p) }));
          const np = nameParts(s.name || '');
          L.push(...col([np.title && T({ name: 'Minister title', text: np.title, upper: true, font: 'Montserrat', size: sz * 0.7, letter: 0.1, shadow: true }), T({ name: 'Minister', text: np.name || '', upper: true, font: 'Montserrat Black', size: sz, maxW: step - 16, shadow: true })].filter(Boolean), { cx: cx + (i < list.length / 2 ? -step * 0.32 : step * 0.32), cy: t + (b - t) * 0.55, gap: 1 }));
        });
      };
      row(back, H * 0.12, H * 0.42, 14);
      row(front, H * 0.25, H * 0.6, 16);
      const ts = stackLines(stack(f.title || 'The Harvest', 2), { t: H * 0.6, fit: 900, maxH: H * 0.11, gap: 4,
        style: solid3d(p, { font: 'Cinzel', upper: true, fill: GOLD, extrude: 3, glow: rgba(p.accent, 0.4) }) });
      L.push(...ts);
      let y = ts.bottom + 16;
      if (d) { const dt = put(T({ name: 'Date', text: `${d.day}, ${d.ddth} OF ${d.month} ${d.year}`, upper: true, font: 'Montserrat', size: 22, letter: 0.08, fill: p.accent, shadow: true }), { cx: 540, t: y }); L.push(dt); y = box(dt).b + 18; }
      L.push(...infoRow(D, Math.max(y + 40, H - 90), [f.time && { name: 'Time', big: f.time + (f.time2 ? ' - ' + f.time2 : ''), size: 40 }, venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 360, smallSize: 15 }], { lineH: 56 }));
      return L;
    },

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
      if (n >= 2) { const nm = put(T({ name: 'Speakers', text: namesOf(ps), upper: true, font: 'Montserrat Black', size: 22, letter: 0.06, fill: p.accent, maxW: 960, shadow: true }), { cx: 540, t: y }); L.push(nm); y = box(nm).b + 12; }
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
      if (ps.length >= 2) { const nm = put(T({ name: 'Speakers', text: namesOf(ps.slice(0, 3)), upper: true, font: 'Montserrat Black', size: 21, letter: 0.06, maxW: 960, shadow: true }), { cx: 540, t: y }); L.push(nm); y = box(nm).b + 8; }
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
      // with a preacher the words take the top of the page and the preacher the foot (over the whole page, his head hid half of them)
      const lines = stack(f.title || 'Sunday Service', 2), n = lines.length, top = 108, avail = sp ? H * 0.56 : H - top - 150;
      const ts = stackLines(lines, { t: top, fit: 1000, maxH: avail / n - 14, gap: 14,
        style: { font: 'League Gothic', upper: true, stretch: 1.45, fill: { stops: ['#ffffff', mix('#ffffff', p.accent, 0.3), mix(p.accent, p.hi, 0.25)], angle: 90 }, bevel: 0.6, glow: rgba(p.accent, 0.35), shadow: true } });
      L.push(...ts);
      // the preacher stood in front of the giant words, not squeezed into the corner under them
      if (sp) L.push(hero(sp, { cx: 740, t: top + (ts.bottom - top) * 0.74, b: H + 30, mode: 'chest', minL: 320, extra: lit(p) }));
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
      // the preacher stands in the sky, the big word across their chest (a small card at the foot left the top half empty)
      if (sp) {
        const tb = box(t), at = L.indexOf(hd[hd.length - 1]) + 1 || 3;
        L.splice(at, 0, hero(sp, { cx: 540, t: hd.bottom + 18, b: tb.t + tb.h * 0.62, mode: 'chest', fade: 0.35, extra: lit(p) }));
      }
      const cardT = Math.max(y, H - 320), cardB = H - 60;
      const ix = 96;
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
      if (sp) L.push(hero(sp, { cx: 540, t: Math.max(y + 10, H * 0.38), b: H - 60, mode: 'chest', fade: 0.35, extra: { fadeLight: true, shade: 'rgba(60,30,10,.35)', tint: { color: '#ffb36b', a: 0.25, fall: 0.4 } } }));
      L.push(SH({ name: 'Info bar', shape: 'round', radius: 0, fill: { stops: [rgba('#ffffff', 0), rgba('#ffffff', 0.92)], angle: 90 }, x: 540, y: H - 90, w: W, h: 180 }));
      L.push(...infoRow(D, H - 74, [d && { name: 'Date', big: `${d.ddth} ${d.mon3}. ${d.year}`, size: 40 }, f.time && { name: 'Time', big: f.time, size: 40, accent: true }, venueText(D) && { name: 'Venue', small: venueLines(D, 3), maxW: 320, smallSize: 14 }], { ink, accent: red, lineH: 56 }));
      return L;
    },

    /* ── JOIN US THIS SUNDAY: huge white capitals on one tilt, the hosts in front, the details on angled bands ── */
    joinus(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 2);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 10, sat: 24, keep: 0.12, topShade: 0.2, bottomShade: 0.5, bottomFrom: 0.72, vignette: 0.22,
        colorWash: [{ stops: [mix(p.mid, '#ffffff', 0.18), p.mid, p.deep], angle: 60, mode: 'soft-light', a: 0.75 },
          { radial: true, x: 0.92, y: 0.86, r: 0.5, stops: [rgba(p.accent, 0.85), rgba(p.accent, 0)], mode: 'screen', a: 0.45 }] }));
      // the speaker's own face, huge and ghosted into the colour behind everything
      if (ps[0]) { const g = hero(ps[0], { cx: 640, t: H * 0.01, b: H * 0.66, mode: 'bust', fade: 0.45 }); if (g) Object.assign(g, { name: 'Ghost', opacity: 0.12, lock: true }); if (g) L.push(g); }
      L.push(FX({ kind: 'smoke', x: 260, y: H * 0.78, w: 900, h: 480, n: 18, seed: 4, color: p.hi, color2: p.accent, opacity: 0.35 }));
      L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.45, w: 1080, h: H * 0.8, n: 16, seed: 9, opacity: 0.4 }));
      L.push(...header(D));
      const t0 = String(f.title || 'Sunday Service').trim(), sc = splitConnector(t0);
      let l1, l2, tag = '';
      if (sc) { l1 = sc.a; l2 = sc.b; tag = sc.conn; }
      else if (t0.split(/\s+/).length <= 2 && t0.length <= 16) { l1 = 'Join us'; tag = 'for'; l2 = t0; }
      else [l1, l2] = twoLines(t0);
      const top = [];
      const ts = stackLines([l1, l2].filter(Boolean), { t: H * 0.115, cx: 520, fit: 930, maxH: H * 0.165, gap: tag ? 50 : 4,
        style: { font: 'Montserrat Black', upper: true, fill: '#ffffff', letter: -0.02, shadow: true } });
      top.push(...ts);
      if (tag && ts.length === 2) top.push(...tornTag([{ text: tag, upper: true, font: 'Archivo Black', size: 32, fill: p.deep }], { seed: 7, padY: 8 }).place(560, (box(ts[0]).b + box(ts[1]).t) / 2));
      const tb = ts.bottom;
      top.push(...socialRow(D, { l: 76, cy: tb + 46, size: 22 }));
      // the hosts stand in front of the lower line
      if (ps[1]) L.push(hero(ps[1], { cx: 860, t: tb - H * 0.05, b: H * 0.9, mode: 'chest', extra: lit(p) }));
      if (ps[0]) L.push(hero(ps[0], { cx: ps[1] ? 590 : 700, t: tb - H * 0.03, b: H * 0.92, mode: 'chest', extra: lit(p) }));
      // the date band and the dark details band, on the title's tilt
      const bands = [];
      const by = H * 0.805, iy = H * 0.915;
      bands.push(SH({ name: 'Date band', shape: 'rect', fill: { stops: [mix(p.accent, '#c1674b', 0.4), mix(p.mid, '#ba2165', 0.45), mix(p.deep, '#8c1065', 0.4)], angle: 0 }, x: 260, y: by, w: 640, h: H * 0.11 }));
      if (d) bands.push(put(T({ name: 'Date', text: `${d.mon3}. ${d.ddth}`, upper: true, font: 'Montserrat Black', size: 66, fill: '#ffffff', align: 'left', maxW: 300 }), { l: 70, cy: by }));
      const times = [f.time, f.time2].filter(Boolean);
      times.forEach((tm, i) => bands.push(...col([T({ name: 'Time ' + (i + 1), text: tm, font: 'Montserrat Black', size: 30, fill: mix(p.accent, '#ffffff', 0.35), align: 'left' }),
        T({ name: 'Service ' + (i + 1), text: times.length > 1 ? (i ? 'SECOND SERVICE' : 'FIRST SERVICE') : 'PROMPT', font: 'Montserrat', size: 12, letter: 0.08, fill: '#ffffff', align: 'left' })], { l: 390 + i * 150, cy: by, gap: 2 })));
      bands.push(SH({ name: 'Details band', shape: 'rect', fill: rgba(mix(p.deep, '#000000', 0.35), 0.95), x: 540, y: iy, w: 1240, h: H * 0.14 }));
      const vt = venueLines(D, 2);
      bands.push(...col([f.church && T({ name: 'Church', text: f.church, upper: true, font: 'Montserrat Black', size: 22, fill: mix(p.accent, '#ffffff', 0.3), align: 'left', maxW: 520 }),
        vt && T({ name: 'Venue', text: vt, upper: true, font: 'Montserrat Black', size: 20, line: 1.05, fill: '#ffffff', align: 'left', maxW: 520 })], { l: 70, cy: iy, gap: 4 }));
      const names = ps.map((s) => nameParts(s.name).name).filter(Boolean);
      if (names.length) {
        const np = nameParts(ps[0].name);
        // two: each with their own title, one under the other ("Bishop" under both names read as if both were bishops)
        bands.push(...col(names.length >= 2
          ? ps.slice(0, 2).map((s2) => T({ name: 'Speaker', text: s2.name, upper: true, font: 'Montserrat Black', size: 22, fill: '#ffffff', align: 'right', maxW: 440, line: 1.0 }))
          : [T({ name: 'Speaker', text: names.join(' & '), upper: true, font: 'Montserrat Black', size: 26, fill: '#ffffff', align: 'right', maxW: 420, line: 1.0 }),
            np.title && T({ name: 'Speaker title', text: np.title, font: 'Montserrat', size: 18, fill: mix(p.accent, '#ffffff', 0.3), align: 'right' })], { r: 1010, cy: iy, gap: 4 }));
      }
      turn(top.concat(bands), -4, 540, H * 0.5);
      L.push(...top, ...bands);
      return L;
    },

    /* ── GLORY OF GOD: an elegant thin Didone title in white over a loud picture, the minister below, three coloured cells ── */
    didone(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 12, sat: 22, keep: 0.14, topShade: 0.62, topTo: 0.5, bottomShade: 0.45, bottomFrom: 0.78, vignette: 0.3 }));
      L.push(FX({ kind: 'beams', x: 700, y: H * 0.3, w: 900, h: H * 0.5, n: 3, seed: 3, color: p.accent, opacity: 0.3, from: [[0.88, -0.05], [0.66, -0.06]] }));
      L.push(FX({ kind: 'glow', x: 540, y: H * 0.64, w: 1000, h: 640, opacity: 0.5 }));
      L.push(FX({ kind: 'sparks', x: 540, y: H * 0.62, w: 1080, h: H * 0.32, n: 70, seed: 12, opacity: 0.8 }));
      L.push(...header(D));
      const kick = String(D.dir.kicker || '').trim();
      if (kick && kick.length <= 26) L.push(put(T({ name: 'Kicker', text: twoLines(kick).filter(Boolean).join('\n'), upper: true, font: 'Oswald', size: 25, align: 'right', line: 1.02, maxW: 330, shadow: true }), { r: 1010, cy: 80 }));
      // two lines set to one width, the way a Didone title is justified ("GLORY / OF GOD")
      const lines = twoLines(f.title || 'Glory of God').filter(Boolean);
      const ts = stackLines(lines, { t: H * 0.19, fit: 860, maxH: H * (sp ? 0.15 : 0.2), gap: 8,
        style: { font: 'Bodoni Light', upper: true, fill: { stops: ['#ffffff', '#fff3e6'], angle: 90 }, glow: rgba(mix(p.deep, '#000000', 0.4), 0.35), shadow: true } });
      L.push(...ts);
      if (sp) L.push(hero(sp, { cx: 540, t: Math.max(ts.bottom + 18, H * 0.5), b: H + 20, mode: 'waist', fade: 0.1, extra: lit(p) }));
      if (sp && sp.name) {
        const np = nameParts(sp.name);
        L.push(...col([np.title && sig(np.title, { size: 70, rot: -8, align: 'right', fill: '#ffffff' }),
          T({ name: 'Speaker', text: twoLines(np.name).filter(Boolean).join('\n'), upper: true, font: 'Oswald', size: 32, line: 1.0, align: 'right', shadow: true, maxW: 250 })], { r: 1010, cy: H * 0.71, gap: -14 }));
      }
      const vp = venueParts(D);
      const cl = [
        f.time && { name: 'Time cell', w: 180, fill: '#fcf3f6', lines: [{ text: f.time, font: 'Oswald', size: 40, fill: '#1c212a' }, { text: f.time2 ? '& ' + f.time2 : 'PROMPT', font: 'Montserrat', size: 13, letter: 0.1, fill: '#1c212a' }] },
        d && { name: 'Date cell', w: 160, fill: mix(p.mid, '#000000', 0.2), lines: [{ text: d.day3, upper: true, font: 'Oswald', size: 24, fill: '#ffffff' }, { text: `${d.mon3} ${d.ddn}`, upper: true, font: 'Oswald', size: 30, fill: '#ffffff' }, { text: d.year, font: 'Oswald', size: 22, fill: '#ffffff' }] },
        vp.length && { name: 'Venue cell', w: 440, fill: p.accent, lines: [{ text: vp[0] + (vp.length > 1 ? ',' : ''), upper: true, font: 'Oswald', size: 25, fill: '#2a1a10' }, vp.length > 1 && { text: vp.slice(1).join(', '), font: 'Montserrat', size: 17, line: 1.15, fill: '#2a1a10', maxW: 400 }] },
      ].filter(Boolean);
      L.push(...cells(cl, { l: 540 - cl.reduce((a, c) => a + c.w, 0) / 2, cy: H - 74, h: 124, shadow: true }));
      return L;
    },

    /* ── UPPER ROOM: a super-heavy wide title lit hot white-to-gold, a script word across it, the details in modules ── */
    upper(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 16, sat: 26, keep: 0.12, topShade: 0.62, topTo: 0.52, bottomShade: 0.55, bottomFrom: 0.8, vignette: 0.32 }));
      L.push(FX({ kind: 'beams', x: 380, y: H * 0.42, w: 760, h: H * 0.6, n: 3, seed: 8, color: p.accent, opacity: 0.35, from: [[0.04, -0.05], [0.22, -0.06]] }));
      L.push(FX({ kind: 'sparks', x: 540, y: H * 0.7, w: 1080, h: H * 0.6, n: 80, seed: 14, opacity: 0.85 }));
      const hd = header(D, { center: true, t: 34 }); L.push(...hd);
      const lines = stack(f.title || 'Upper Room', 2);
      const ts = stackLines(lines, { t: Math.max(hd.bottom + 16, H * 0.15), fit: 880, maxH: H * 0.135, gap: 16,
        style: { font: 'Montserrat Black', upper: true, letter: -0.015, fill: { stops: ['#fffbe0', mix(p.accent, '#ffffff', 0.45), p.accent, mix(p.accent, '#ff6a00', 0.45)], angle: 70 }, erode: 0.55, glow: rgba(mix(p.accent, '#ff7a00', 0.5), 0.42), shadow: true } });
      L.push(...ts);
      const lb = box(ts[ts.length - 1]);
      L.push(put(T({ name: 'Script word', text: D.script, font: 'Yellowtail', size: 130, maxW: 480, maxH: H * 0.1, fill: '#ffffff', rot: -8, shadow: true }), { r: 1000, cy: lb.b + 6 }));
      let y = lb.b + 22;
      if (f.theme) { const th = put(T({ name: 'Theme', text: '(' + f.theme + ')', upper: true, font: 'Montserrat Black', size: 26, line: 0.98, fill: '#ffffff', align: 'left', maxW: 470, shadow: true }), { l: lb.l + 4, t: y }); L.push(th); y = box(th).b; }
      // the details, in modules: the date, a pin and the address, a black box with the time
      // (just under the title, so the preacher below can be big — they were a stamp at the foot)
      const iy = sp ? Math.max(y + 64, H * 0.4) : Math.max(y + 70, H * 0.6);
      if (sp) L.push(hero(sp, { cx: 540, t: iy + 84, b: H + 20, mode: 'chest', fade: 0.12, extra: lit(p) }));
      if (d) L.push(...col([T({ name: 'Day', text: `${d.day3} ${d.ddth}`, upper: true, font: 'Montserrat Black', size: 38, align: 'left', shadow: true }), T({ name: 'Month', text: `${d.month}, ${d.year}`, upper: true, font: 'Montserrat Black', size: 30, align: 'left', shadow: true })], { l: 110, cy: iy, gap: 2 }));
      const vl = venueLines(D, 3);
      if (vl) { L.push(SH({ name: 'Pin', shape: 'pin', fill: p.accent, x: 438, y: iy - 20, w: 34, h: 34 })); L.push(put(T({ name: 'Venue', text: vl, upper: true, font: 'Montserrat', size: 15, line: 1.25, align: 'left', maxW: 230, shadow: true }), { l: 462, cy: iy })); }
      if (f.time) {
        const g = [T({ name: 'Time label', text: f.time2 ? 'FIRST SERVICE:' : 'SERVICE STARTS:', font: 'Montserrat', size: 13, letter: 0.06, fill: p.accent, align: 'left' }), T({ name: 'Time', text: f.time, font: 'Montserrat Black', size: 34, align: 'left' })];
        if (f.time2) g.push(T({ name: 'Time 2 label', text: 'SECOND SERVICE:', font: 'Montserrat', size: 13, letter: 0.06, fill: p.accent, align: 'left' }), T({ name: 'Time 2', text: f.time2, font: 'Montserrat Black', size: 34, align: 'left' }));
        const bh = f.time2 ? 150 : 96;
        L.push(SH({ name: 'Time box', shape: 'rect', fill: 'rgba(0,0,0,.86)', x: 850, y: iy, w: 230, h: bh }));
        L.push(...col(g, { l: 752, cy: iy, gap: 3 }));
      }
      const contact = f.phone || f.handles;
      if (contact) {
        L.push(SH({ name: 'Contact bar', shape: 'pill', fill: '#ffffff', x: 540, y: H - 96, w: 680, h: 62, shadow: true }));
        L.push(SH({ name: 'Contact icon', shape: 'icon', icon: f.phone ? 'phone' : 'ig', fill: mix(p.mid, '#000000', 0.2), x: 236, y: H - 96, w: 28, h: 28 }));
        L.push(put(T({ name: 'Contact', text: contact, font: 'Montserrat', size: 20, fill: '#1c1c1f', align: 'left', maxW: 560 }), { l: 262, cy: H - 96 }));
      }
      L.push(put(micro(footerWords(f), { size: 13, letter: 0.4, fill: rgba('#ffffff', 0.85), maxW: 980 }), { cx: 540, b: H - 26 }));
      return L;
    },

    /* ── BREAK EVERY CHAIN: the theme painted, the title filled with the same fire, debris flying off it — the minister
       stepping out of the smoke beside it ("why does one of them not have the speaker on it?") ── */
    theme(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 14, sat: 18, keep: 0.38, topShade: 0.28, topTo: 0.2, bottomShade: 0.88, bottomFrom: 0.7, vignette: 0.42 }));
      L.push(FX({ kind: 'sparks', x: 720, y: H * 0.45, w: 900, h: H * 0.8, n: 90, seed: 21, opacity: 0.85 }));
      const lg = D.logo && imgOf(D.logo) ? logoLayers(D, 1010 - 40, 100, 74) : []; L.push(...lg);
      if (f.church) L.push(put(T({ name: 'Church', text: f.church, upper: true, font: 'Montserrat', size: 18, letter: 0.06, align: 'left', maxW: 520, shadow: true }), { l: 70, cy: 100 }));
      const lines = stack(f.title || 'Break Every Chain', 3);
      const titles = lines.map((ln, i) => T({ name: 'Title ' + (i + 1), text: ln, upper: true, font: 'Barlow Black', size: 400, maxW: 700, maxH: H * (lines.length > 2 ? 0.12 : 0.15), align: 'right',
        fill: { stops: [mix(p.hi, '#ffffff', 0.3), mix(p.accent, p.hi, 0.35), p.accent], angle: 90 }, imgFill: D.bg, imgFillA: 0.26, glow: rgba(p.accent, 0.4), shadow: true }));
      const tc = col(titles, { r: 1012, t: H * 0.19, gap: 2 });
      // dark smoke at the side, BEHIND the words (over them it blacked out half the title — and mirrored, it was a hard panel)
      L.push(SH({ name: 'Smoke', shape: 'rect', fill: { stops: [rgba(mix(p.deep, '#000000', 0.6), 0.6), rgba(mix(p.deep, '#000000', 0.6), 0)], angle: 0 }, x: 200, y: H * 0.4, w: 400, h: H * 0.62, lock: true }));
      L.push(...tc);
      L.push(FX({ kind: 'debris', x: 760, y: tc.bottom + 4, w: 560, h: 120, n: 70, seed: 33, opacity: 1 }));
      // the minister on the smoky side, under the title, clear of the theme lines on the right
      if (sp) L.push(hero(sp, { cx: 290, t: tc.bottom - H * 0.04, b: H - 150, mode: 'chest', fade: 0.3, maxR: 560, extra: lit(p) }));
      let y = tc.bottom + 34;
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, font: 'Montserrat', size: 24, align: 'right', maxW: 560, shadow: true }), { r: 1012, t: y }); L.push(th); y = box(th).b + 8; }
      if (f.extra) { const ex = put(T({ name: 'Scripture', text: f.extra, font: 'Montserrat', size: 16, align: 'right', line: 1.25, fill: rgba('#ffffff', 0.85), maxW: 420, shadow: true }), { r: 1012, t: y }); L.push(ex); }
      L.push(...infoRow(D, H - 120, [d && { name: 'Date', big: `${d.day3}. ${d.ddth} ${d.mon3}`, size: 38 }, f.time && { name: 'Time', big: f.time, size: 46, accent: true }, venueText(D) && { name: 'Venue', small: venueLines(D, 3), pin: true, maxW: 300, smallSize: 14 }], { lineH: 54 }));
      L.push(...socialRow(D, { cx: 540, cy: H - 40, size: 15 }));
      return L;
    },

    /* ── MOUNTAIN EXPERIENCE: a heavy italic title filled with the sky itself, the minister in front, small badges round him ── */
    mountain(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'normal', contrast: 12, sat: 6, keep: 0.42, topShade: 0.6, topTo: 0.32, bottomShade: 0.95, bottomFrom: 0.58, vignette: 0.42 }));
      L.push(FX({ kind: 'smoke', x: 540, y: H * 0.56, w: 1300, h: 320, n: 22, seed: 6, color: mix(p.hi, p.accent, 0.3), color2: '#ffffff', opacity: 0.3 }));
      const lg = D.logo && imgOf(D.logo) ? logoLayers(D, 540, 82, 66) : []; L.push(...lg);
      if (f.church) L.push(put(micro(f.church, { size: 17, letter: 0.55, maxW: 900 }), { cx: 540, t: lg.length ? 132 : 70 }));
      const [a, b] = twoLines(f.title || 'Mountain Experience');
      // bright, edged and only a touch of the sky in it: with more, it faded into a purple picture
      const sky = { font: 'Barlow Black Italic', fill: { stops: ['#ffffff', mix(p.hi, '#ffffff', 0.6), mix(p.accent, '#ffffff', 0.25)], angle: 90 }, imgFill: D.bg, imgFillA: 0.12, shadow: true, speck: 0.12,
        edge: 2.4, edgeColor: mix(p.deep, '#000000', 0.55), glow: rgba('#000000', 0.35) };
      const tl = [a && T(Object.assign({ name: 'Title 1', text: a, fit: b ? 720 : 900, maxH: H * 0.15 }, sky)), b && T(Object.assign({ name: 'Title 2', text: b, fit: 820, maxH: H * 0.15 }, sky))].filter(Boolean);
      const ts = col(tl, { cx: 540, t: H * 0.18, gap: 0 }); L.push(...ts);
      if (sp) L.push(hero(sp, { cx: 540, t: ts.bottom - H * 0.05, b: H + 20, mode: 'chest', fade: 0.12, extra: lit(p) }));
      const by = Math.max(ts.bottom + 120, H * 0.66);
      if (f.time) { L.push(SH({ name: 'Time ring', shape: 'ring', fill: '#ffffff', line: 3, x: 150, y: by, w: 140, h: 140 })); L.push(put(T({ name: 'Time', text: f.time, font: 'Barlow Black Italic', size: 40, maxW: 116, shadow: true }), { cx: 150, cy: by })); }
      if (sp && sp.name) { const np = nameParts(sp.name); L.push(...col([np.title && micro(np.title, { size: 13, letter: 0.3 }), T({ name: 'Speaker', text: twoLines(np.name).filter(Boolean).join('\n'), upper: true, font: 'Barlow Black Italic', size: 38, line: 0.95, shadow: true, maxW: 220 })], { cx: 150, t: by + 96, gap: 4 })); }
      if (d) {
        L.push(SH({ name: 'Highlighter', shape: 'brush', fill: mix(p.accent, '#ffffff', 0.25), x: 925, y: by, w: 230, h: 104, seed: 9, rot: -3 }));
        L.push(...col([T({ name: 'Day', text: d.ddth, upper: true, font: 'Barlow Black Italic', size: 58, fill: '#0d0d0f' }), T({ name: 'Month', text: `${d.month} ${d.year}`, upper: true, font: 'Montserrat', size: 18, fill: '#0d0d0f' })], { cx: 925, cy: by, gap: 0 }));
      }
      const vl = venueLines(D, 3);
      if (vl) { const g = tornTag([{ text: 'Address:', font: 'Montserrat', size: 15, fill: p.mid === '#000000' ? '#c94a48' : mix(p.mid, '#c94a48', 0.5) }, { text: vl, font: 'Montserrat', size: 15, line: 1.2, maxW: 230 }], { seed: 4, rot: -2, padX: 18, padY: 12 }); L.push(...g.place(915, by + 150)); }
      L.push(put(micro(footerWords(f), { size: 13, letter: 0.5, fill: rgba('#ffffff', 0.62), maxW: 980 }), { cx: 540, b: H - 26 }));
      return L;
    },

    /* ── BREAKING INVISIBLE Barriers: tall white distressed capitals on red, a signature script across them, the minister to the side ── */
    breaking(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], sp = sp0(D);
      L.push(BG({ img: D.bg, grade: 'vivid', contrast: 16, sat: 26, keep: 0.12, topShade: 0.3, bottomShade: 0.55, bottomFrom: 0.72, vignette: 0.3,
        colorWash: [{ stops: [mix(p.mid, '#ffffff', 0.1), p.mid, p.deep], angle: 90, mode: 'soft-light', a: 0.6 }] }));
      L.push(FX({ kind: 'glow', x: 780, y: H * 0.62, w: 900, h: 900, opacity: 0.45 }));
      L.push(FX({ kind: 'smoke', x: 540, y: H * 0.2, w: 1200, h: 420, n: 16, seed: 2, color: p.hi, color2: p.accent, opacity: 0.22 }));
      const hd = header(D, { center: true, t: 30 }); L.push(...hd);
      const ws = String(f.title || 'Breaking Invisible Barriers').trim().split(/\s+/);
      const scriptW = ws.length >= 3 ? ws[ws.length - 1] : '', main = scriptW ? ws.slice(0, -1).join(' ') : ws.join(' ');
      const ts = stackLines(stack(main, 2), { t: hd.bottom + 18, fit: 960, maxH: H * 0.16, gap: 6,
        style: { font: 'Anton', upper: true, stretch: 1.12, fill: { stops: ['#ffffff', '#f1f1f1', '#d9d9d9'], angle: 90 }, grain: true, shadow: true } });
      L.push(...ts);
      let y = ts.bottom;
      if (scriptW) { const s = put(T({ name: 'Script word', text: scriptW.charAt(0).toUpperCase() + scriptW.slice(1).toLowerCase(), font: 'Great Vibes', size: 190, maxW: 760, maxH: H * 0.14, fill: answer(p), stroke: 3, strokeColor: '#ffffff', rot: -6, shadow: true }), { cx: 600, cy: y - 6 }); L.push(s); y = box(s).b; }
      if (f.theme) { const th = put(T({ name: 'Theme', text: f.theme, font: 'Montserrat Italic', size: 30, maxW: 760, shadow: true }), { cx: 560, t: y + 10 }); L.push(th); y = box(th).b; }
      if (sp) L.push(hero(sp, { cx: 800, t: Math.max(y + 10, H * 0.46), b: H + 20, mode: 'chest', fade: 0.1, extra: lit(p) }));
      const iy = Math.max(y + 60, H * 0.62);
      const left = col([d && T({ name: 'Date', text: `${d.day3}. ${d.ddth}\n${d.mon3}. ${d.year}`, font: 'Kanit Italic', size: 40, line: 1.0, align: 'left', shadow: true }),
        f.time && T({ name: 'Time', text: f.time + (f.time2 ? ' &\n' + f.time2 : ''), font: 'Kanit Italic', size: 40, line: 1.0, fill: p.accent, align: 'left', shadow: true })], { l: 70, t: iy, gap: 14 });
      L.push(...left);
      let yy = left.length ? left.bottom + 22 : iy;
      if (sp && sp.name) {
        const np = nameParts(sp.name);
        const g = pill([{ text: 'MINISTERING', font: 'Montserrat', size: 12, letter: 0.15 }, { text: (np.title ? np.title + ' ' : '') + np.name, font: 'Montserrat Black', size: 22, maxW: 300 }], { fill: p.accent, ink: '#141414', radius: 4, padX: 16, padY: 10 });
        L.push(...g.place(70 + g.w / 2, yy + g.h / 2)); yy += g.h + 18;
      }
      const vl = venueLines(D, 3);
      if (vl) L.push(put(T({ name: 'Venue', text: (f.church ? f.church + ' - ' : '') + vl, font: 'Montserrat', size: 17, line: 1.25, align: 'left', maxW: 380, shadow: true }), { l: 70, t: yy }));
      return L;
    },

    /* ── SPIRIT OF DAVID: a gold-foil title with its little word on a badge, the ministers in rank (the main one front and centre) ── */
    spirit(D) {
      const H = D.h, p = D.pal, f = D.f, d = D.d, L = [], ps = spsOf(D).slice(0, 3);
      L.push(BG({ img: D.bg, grade: 'dark', contrast: 12, keep: 0.22, topShade: 0.45, bottomShade: 0.95, bottomFrom: 0.56, vignette: 0.5 }));
      L.push(FX({ kind: 'burst', x: 540, y: H * 0.3, w: 900, h: 900, n: 40, seed: 5, color: p.accent, color2: '#ffffff', opacity: 0.35 }));
      L.push(FX({ kind: 'bokeh', x: 540, y: H * 0.4, w: 1080, h: H * 0.7, n: 22, seed: 13, opacity: 0.5 }));
      const hd = header(D, { center: true, t: 28 }); L.push(...hd);
      L.push(put(micro('PRESENTS', { size: 13, letter: 1.0 }), { cx: 540, t: hd.bottom }));
      // laid out from the foot up: the details, the theme, the gold title, then the ministers standing on it
      const iy = H - 104, foil = { font: 'Montserrat Black', upper: true, fill: GOLD, speck: 0.8, extrude: 2, extrudeColor: ['#6a4300', '#2a1a00'], glow: rgba('#ffcf33', 0.25), shadow: true };
      let tb = iy - 64;
      if (f.theme) {
        const g = pill([{ text: 'THEME', font: 'Montserrat', size: 12, letter: 0.2 }], { fill: GOLD, ink: '#2a1a00', radius: 99, padX: 14, padY: 6 });
        const th = T({ name: 'Theme', text: f.theme, upper: true, font: 'Montserrat', size: 17, align: 'left', maxW: 640, shadow: true });
        L.push(...hrow([g, th], 540, tb, 14)); tb -= 34;
      }
      const sc = splitConnector(f.title);
      const lines = sc ? [sc.a, sc.b] : twoLines(f.title || 'Spirit of David').filter(Boolean);
      const ts = stackLines(lines, { b: tb, fit: 860, maxH: H * 0.095, gap: sc ? 30 : 6, style: foil });
      if (sc && ts.length === 2) { const g = pill([{ text: sc.conn, upper: true, font: 'Montserrat Black', size: 26 }], { fill: GOLD, ink: '#2a1a00', circle: true, padX: 10, padY: 10, shadow: true }); ts.push(...g.place(540, (box(ts[0]).b + box(ts[1]).t) / 2)); }
      const top = hd.bottom + 50, foot = box(ts[0]).t + 30;
      if (ps[1]) L.push(hero(ps[1], { cx: 250, t: top + 60, b: foot, mode: 'chest', fade: 0.3, extra: lit(p) }));
      if (ps[2]) L.push(hero(ps[2], { cx: 830, t: top + 60, b: foot, mode: 'chest', fade: 0.3, extra: lit(p) }));
      if (ps[0]) L.push(hero(ps[0], { cx: 540, t: top, b: foot + 20, mode: 'chest', fade: 0.3, extra: lit(p) }));
      [[ps[1], 'left'], [ps[2], 'right']].forEach(([s, al]) => { if (!s || !s.name) return; const np = nameParts(s.name); L.push(...col([np.title && micro(np.title, { size: 11, letter: 0.2, align: al }), T({ name: 'Name', text: twoLines(np.name).filter(Boolean).join('\n'), upper: true, font: 'Montserrat', size: 16, line: 1.05, align: al, shadow: true, maxW: 220 })], al === 'left' ? { l: 52, t: top + 30, gap: 2 } : { r: 1028, t: top + 30, gap: 2 })); });
      if (ps[0] && ps[0].name) { const np = nameParts(ps[0].name); L.push(...col([np.title && micro(np.title, { size: 12, letter: 0.2 }), T({ name: 'Name', text: np.name, upper: true, font: 'Montserrat Black', size: 20, shadow: true, maxW: 400 })], { cx: 540, b: box(ts[0]).t - 8, gap: 2 })); }
      L.push(...ts);
      L.push(...infoRow(D, iy, [d && { name: 'Date', big: `${d.ddth} ${d.mon3}`, small: `${d.day}, ${d.year}`, size: 40 }, f.time && { name: 'Time', big: f.time, small: f.time2 ? 'AND ' + f.time2 : 'PROMPT', size: 40, accent: true }, venueText(D) && { name: 'Venue', small: venueLines(D, 3), pin: true, maxW: 300, smallSize: 14 }], { lineH: 54 }));
      L.push(...socialRow(D, { cx: 540, cy: H - 28, size: 13, shadow: false }));
      return L;
    },
  };
  /* ════════ YOUTUBE THUMBNAILS (Home → Thumbnails) — 1280×720, the way church channels make them ════════
   *
   * A thumbnail is read at the size of a stamp, in a feed, in half a second:
   * the preacher big (a face is what people tap), three to five HUGE words,
   * the one that carries it in the accent colour, everything else dark enough
   * that the words are read first. Six looks, each one a thumbnail you see on
   * the big church channels: bold words beside the preacher; a coloured panel
   * with the key word in a box; the frame itself, cinematic; light rays and a
   * glowing cut-out; the classic thick-outlined YouTube words; one giant word
   * behind the preacher. D.frame is the video's own frame, D.sp[0] the
   * preacher cut out of it, D.bg the painted picture (or the frame again).
   */
  // the words broken the way thumbnail designers break them: the word that carries it on a line of its own
  function thumbLines(text, key) {
    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const bare = (w) => w.replace(/[^\w’']/g, '');
    const chunk = (ws, max) => {
      const out = []; let cur = [];
      ws.forEach((w) => { if (cur.length && cur.concat(w).join(' ').length > max) { out.push(cur.join(' ')); cur = [w]; } else cur.push(w); });
      if (cur.length) out.push(cur.join(' '));
      return out;
    };
    const k = key ? words.findIndex((w) => bare(w) === bare(String(key).toUpperCase())) : -1;
    const build = (max) => {
      if (k < 0) return chunk(words, max).map((t) => ({ text: t, key: false }));
      const L = chunk(words.slice(0, k), max).map((t) => ({ text: t, key: false }))
        .concat({ text: words[k], key: true }, chunk(words.slice(k + 1), max).map((t) => ({ text: t, key: false })));
      // a lone little word ("IS", "TO") does not get a line of its own: it joins the line next to it
      for (let i = 0; i < L.length; i++) {
        if (L[i].key || L[i].text.length > 3 || L.length < 2) continue;
        const j = L[i + 1] && !L[i + 1].key ? i + 1 : L[i - 1] && !L[i - 1].key ? i - 1 : -1;
        if (j < 0) continue;
        const a = Math.min(i, j); L.splice(a, 2, { text: L[a].text + ' ' + L[a + 1].text, key: false }); i = -1;
      }
      return L;
    };
    let lines = build(11);
    if (lines.length > 4) lines = build(16);
    if (lines.length > 4) lines = build(24);
    return lines;
  }
  /* the words as a stacked block: every line as wide as the block, the key line taller, in the accent */
  function titleBlock(D, o) {
    const lines = thumbLines(D.f.title || 'Your words here', D.f.key);
    const H = D.h, n = Math.max(1, lines.length), hasKey = lines.some((l) => l.key);
    const total = o.maxH || H * 0.8, gap = o.gap == null ? Math.round(H * 0.014) : o.gap;
    const unit = (total - gap * (n - 1)) / (n - 1 + (hasKey ? 1.45 : 1));
    const base = Object.assign({ font: 'Anton', upper: true, fill: '#ffffff', shadow: true, align: o.align || 'left' }, o.style || {});
    const list = lines.map((l, i) => T(Object.assign({}, base, l.key ? Object.assign({ fill: D.pal.accent }, o.keyStyle || {}) : {},
      { name: n > 1 ? 'Title ' + (i + 1) : 'Title', text: l.text, fit: o.w, maxH: unit * (l.key ? 1.45 : 1), size: 200, key: l.key || undefined })));
    const q = { gap }; if (o.l != null) q.l = o.l; else if (o.r != null) q.r = o.r; else q.cx = o.cx;
    if (o.t != null) q.t = o.t; else if (o.b != null) q.b = o.b; else q.cy = o.cy == null ? H / 2 : o.cy;
    return col(list, q);
  }
  /* the preacher, cut out, standing at the edge with the head near the top: as big as a thumbnail wants a face */
  function preacher(D, o) {
    const sp = sp0(D); if (!sp) return null;
    return hero(sp, Object.assign({ t: D.h * 0.05, b: D.h + 12, mode: 'chest', fade: 0.12 }, o));
  }
  /* which side the words go: away from the face (in the frame, when nobody was cut out) */
  const wordsLeft = (D) => (sp0(D) ? true : !(D.face && D.face.x < 0.45));
  /* the church at the top — its logo and name, small, the way every one of those thumbnails is signed */
  function thHead(D, o) {
    const out = [], cy = o.cy || 50, ink = o.ink || '#ffffff';
    const logo = D.logo && imgOf(D.logo) ? logoLayers(D, 0, cy, o.size || 64) : [];
    const lw = logo.length ? Math.max(...logo.map((l) => l.w)) : 0;
    const name = D.f.church ? T({ name: 'Church', text: D.f.church, upper: true, font: 'Montserrat Black', size: 21, letter: 0.06, line: 1.1, fill: ink, shadow: !o.light, align: 'left', maxW: 380 }) : null;
    if (!lw && !name) return out;
    const nw = name ? box(name).w : 0, gap = lw && name ? 12 : 0, total = lw + gap + nw;
    let x = o.align === 'center' ? (o.cx || D.w / 2) - total / 2 : o.align === 'right' ? (o.r || D.w - 40) - total : (o.l || 40);
    logo.forEach((l) => { l.x = x + lw / 2; }); out.push(...logo); x += lw + gap;
    if (name) out.push(put(name, { l: x, cy }));
    return out;
  }
  /* "with Pastor / VICTOR ORJI" by the preacher */
  function thName(D, o) {
    if (!D.f.preacher) return [];
    return nameTag({ name: D.f.preacher }, Object.assign({ p: D.pal, script: o.script === false ? '' : 'with', scriptSize: 46, titleSize: 20, size: 48, maxW: 420, gap: 0 }, o));
  }
  /* the kicker (SUNDAY SERVICE · PART 2), the words, the date in a pill — one column, centred on cy */
  function wordsColumn(D, o) {
    const H = D.h, align = o.align || 'left', out = [];
    const kick = D.f.kicker ? T(Object.assign({ name: 'Kicker', text: D.f.kicker, upper: true, font: 'Montserrat Black', size: 26, letter: 0.16, fill: o.kickFill || D.pal.accent, shadow: !o.light, align, maxW: o.w }, o.kickStyle || {})) : null;
    const pl = D.f.when ? pill([{ text: D.f.when, upper: true, font: 'Montserrat Black', size: 24, letter: 0.04 }], Object.assign({ fill: D.pal.accent, ink: mix(D.pal.deep, '#000000', 0.3), radius: 40, padX: 22, padY: 11, name: 'When' }, o.pillStyle || {})) : null;
    const kh = kick ? box(kick).h + 14 : 0, ph = pl ? pl.h + 22 : 0;
    const tb = titleBlock(D, Object.assign({}, o, { maxH: (o.maxH || H * 0.66) - kh - ph, t: 0, cy: undefined, b: undefined }));
    const th = tb.bottom - tb.top;
    let y = (o.cy == null ? H / 2 : o.cy) - (kh + th + ph) / 2;
    const at = (t) => (align === 'left' ? { l: o.l, t } : align === 'right' ? { r: o.r, t } : { cx: o.cx, t });
    out.top = y;
    if (kick) { out.push(put(kick, at(y))); y += kh; }
    const dy = y - tb.top; tb.forEach((l) => { l.y += dy; }); out.push(...tb); y += th;
    if (pl) { const w2 = pl.w / 2; out.push(...pl.place(align === 'left' ? o.l + w2 : align === 'right' ? o.r - w2 : o.cx, y + 22 + pl.h / 2)); y += ph; }
    out.bottom = y; out.tb = tb;
    return out;
  }
  /* a word huge and faint across the back (the SUNDAY behind "Sunday Service") */
  function watermark(D, text, o) {
    return put(T(Object.assign({ name: 'Watermark', text: String(text || '').toUpperCase(), font: 'Anton', upper: true, fit: D.w * 1.04, maxH: D.h * 0.86, size: 300, fill: 'none', stroke: 2.2, strokeColor: rgba('#ffffff', 0.16), shadow: false }, o || {})), { cx: D.w / 2, cy: D.h * 0.5 });
  }
  const keyWordOf = (D) => { const ls = thumbLines(D.f.title || '', D.f.key); return (ls.find((l) => l.key) || ls.slice().sort((a, b) => b.text.length - a.text.length)[0] || { text: '' }).text; };
  const bgOf = (D, o) => BG(Object.assign({ img: D.bg || D.frame, grade: D.bg ? 'normal' : null, keep: 0.6 }, o));
  /* each look's own colours (the board uses them; the first design wears the AI's) */
  const THUMB_PAL = {
    ytbold: { deep: '#0b1020', mid: '#1d3a8a', accent: '#ffd60a', hi: '#ffffff' },
    ytglow: { deep: '#14052e', mid: '#5b21b6', accent: '#f5c542', hi: '#ffffff' },
    ytlight: { deep: '#0e1d3d', mid: '#1f3c88', accent: '#e11d2a', hi: '#fdf8ef' },
    ytfire: { deep: '#2b0700', mid: '#c2410c', accent: '#ffd60a', hi: '#ffffff' },
    ytserif: { deep: '#2a0508', mid: '#7a1414', accent: '#f2c14e', hi: '#ffffff' },
    ytscript: { deep: '#071633', mid: '#1d4ed8', accent: '#f5c542', hi: '#ffffff' },
    ytpanel: { deep: '#0c0c10', mid: '#2a2a33', accent: '#ffd60a', hi: '#ffffff' },
    ytword: { deep: '#0b0b14', mid: '#3b1a5c', accent: '#ffb020', hi: '#ffffff' },
    ytmono: { deep: '#7c2d12', mid: '#f59e0b', accent: '#111111', hi: '#ffffff' },
    ytstage: { deep: '#0a1240', mid: '#2541b2', accent: '#38bdf8', hi: '#ffffff' },
    ytoutline: { deep: '#04263a', mid: '#0b6e99', accent: '#ffd60a', hi: '#ffffff' },
    ytcinema: { deep: '#0a0a0a', mid: '#333333', accent: '#ff3b30', hi: '#ffffff' },
  };
  const THUMBS = {
    /* ── BOLD (Build Expectations, Hope in Troubling Times): the frame dark behind, huge words left, the preacher big on the right ── */
    ytbold(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D), left = wordsLeft(D);
      // (blurred right out where the preacher is cut out of it: the same person twice, sharp and ghosted, looks wrong)
      L.push(BG({ img: D.frame || D.bg, blur: sp && D.frame ? 42 : sp ? 5 : 2, bright: sp && D.frame ? -46 : sp ? -28 : -18, sat: -15, contrast: 8, vignette: 0.6, grain: 0.4,
        colorWash: [{ stops: left ? [rgba(p.deep, 0.92), rgba(p.deep, 0.5), rgba(p.deep, 0)] : [rgba(p.deep, 0), rgba(p.deep, 0.5), rgba(p.deep, 0.92)], angle: 0, mode: 'source-over', a: 1 }] }));
      if (sp) {
        L.push(FX({ kind: 'glow', x: W2 * 0.73, y: H * 0.42, w: 980, h: 900, color: p.accent, opacity: 0.32 }));
        L.push(preacher(D, { cx: W2 * 0.73, minL: W2 * 0.46, extra: { rim: rgba('#ffffff', 0.85), rimW: 1.4, glow: rgba(p.accent, 0.3) } }));
      }
      L.push(...thHead(D, left ? { l: 44 } : { align: 'right', r: W2 - 44 }));
      L.push(...wordsColumn(D, left ? { l: 54, w: W2 * (sp ? 0.5 : 0.56), cy: H * 0.54 } : { r: W2 - 54, w: W2 * 0.56, cy: H * 0.54, align: 'right' }));
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 34, b: H - 30 }));
      return L;
    },
    /* ── GLORY (Commanding Your Day): rays of light, the preacher glowing, the key word in gold leaf ── */
    ytglow(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      L.push(bgOf(D, { blur: D.bg ? 2 : 16, bright: -12, contrast: 10, vignette: 0.5, grain: 0.3, colorWash: [{ stops: [rgba(p.deep, 0.88), rgba(p.deep, 0.15)], angle: 0, mode: 'source-over', a: 1 }] }));
      L.push(FX({ kind: 'rays', x: W2 * 0.7, y: -60, w: 1400, h: 1000, color: p.accent, color2: '#ffffff', opacity: 0.5, seed: 7, n: 18 }));
      L.push(FX({ kind: 'glow', x: W2 * 0.7, y: H * 0.38, w: 900, h: 760, color: mix(p.accent, '#ffffff', 0.3), opacity: 0.42 }));
      L.push(FX({ kind: 'sparks', x: W2 * 0.5, y: H * 0.5, w: W2, h: H, color: p.accent, opacity: 0.6, seed: 3, n: 40 }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.71, minL: W2 * 0.47, extra: { outline: '#ffffff', glow: rgba(p.accent, 0.55) } }));
      L.push(...thHead(D, { l: 44 }));
      L.push(...wordsColumn(D, { l: 54, w: W2 * 0.5, cy: H * 0.55, style: { extrude: 3, extrudeColor: rgba(mix(p.deep, '#000000', 0.5), 0.9) },
        keyStyle: { fill: '#ffffff', imgFill: 'tex:gold', imgFillA: 1, bevel: 0.9, extrudeColor: ['#6b3a04', '#1e0f01'] } }));
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 34, b: H - 28 }));
      return L;
    },
    /* ── LIGHT (The Journey to Maturity, The God of Glory): a cream page, navy words, the key word in red, the preacher on the right ── */
    ytlight(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D), ink = mix(p.deep, '#000000', 0.15);
      L.push(BG({ img: D.bg || null, sat: -40, bright: 42, contrast: -12, blur: 6, wash: 'rgba(253,249,240,.78)', grain: 0.25,
        colorWash: [{ radial: true, x: 0.72, y: 0.4, r: 0.65, stops: [rgba(p.accent, 0.18), rgba(p.accent, 0)], mode: 'multiply', a: 1 }] }));
      L.push(SH({ name: 'Band', shape: 'rect', x: W2 / 2, y: H - 10, w: W2, h: 20, fill: { stops: [p.mid, p.accent], angle: 0 } }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.74, minL: W2 * 0.5, extra: { shade: 'rgba(30,25,20,.28)', fadeLight: true } }));
      L.push(...thHead(D, { l: 44, ink, light: true }));
      L.push(...wordsColumn(D, { l: 58, w: W2 * (sp ? 0.5 : 0.62), cy: H * 0.54, light: true, kickFill: p.accent,
        style: { fill: { stops: [mix(ink, '#ffffff', 0.15), ink], angle: 90 }, shadow: false, extrude: 2, extrudeColor: rgba('#000000', 0.12) }, keyStyle: { fill: { stops: [mix(p.accent, '#ffffff', 0.12), mix(p.accent, '#000000', 0.15)], angle: 90 } },
        pillStyle: { fill: ink, ink: '#ffffff' } }));
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 34, b: H - 34, ink: '#ffffff', scriptFill: p.accent }));
      return L;
    },
    /* ── FIRE (Operating in the Spirit of Faith, Now Ministering): orange heat, sparks, white words, the preacher on the right ── */
    ytfire(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      L.push(bgOf(D, { grade: 'vivid', keep: 0.35, blur: 4, contrast: 14, vignette: 0.45, grain: 0.35,
        colorWash: [{ stops: ['#ff7a00', '#c81e1e'], angle: 30, mode: 'overlay', a: 0.55 }, { stops: [rgba(p.deep, 0.75), rgba(p.deep, 0)], angle: 0, mode: 'source-over', a: 1 }] }));
      L.push(FX({ kind: 'glow', x: W2 * 0.72, y: H * 0.45, w: 1000, h: 900, color: '#ffb020', opacity: 0.45 }));
      L.push(FX({ kind: 'sparks', x: W2 * 0.55, y: H * 0.6, w: W2 * 1.1, h: H, color: '#ffd60a', color2: '#ff5a00', opacity: 0.85, seed: 9, n: 70 }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.72, minL: W2 * 0.47, extra: { glow: rgba('#ff7a00', 0.55), rim: rgba('#ffe7a3', 0.75), rimW: 1.4 } }));
      L.push(...thHead(D, { l: 44 }));
      L.push(...wordsColumn(D, { l: 54, w: W2 * 0.5, cy: H * 0.55, kickFill: '#ffe08a', style: { shadow: true, shadowColor: 'rgba(80,10,0,.7)' }, keyStyle: { fill: { stops: ['#fff6c7', '#ffd60a', '#f59e0b'], angle: 90 } } }));
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 34, b: H - 28, scriptFill: '#ffe08a' }));
      return L;
    },
    /* ── GOLD SERIF (The End of All Spiritual Journeys, David): deep red, the words in a gold serif, a fine rule ── */
    ytserif(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D), left = !sp || true;
      L.push(bgOf(D, { grade: 'dark', keep: 0.5, blur: 3, contrast: 12, vignette: 0.6, grain: 0.4,
        colorWash: [{ stops: [rgba(p.deep, 0), rgba(p.deep, 0.7), rgba(p.deep, 0.95)], angle: 0, mode: 'source-over', a: sp ? 1 : 0.6 }] }));
      L.push(FX({ kind: 'glow', x: W2 * 0.68, y: H * 0.45, w: 900, h: 700, color: p.accent, opacity: 0.22 }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.25, maxR: W2 * 0.48, extra: { glow: rgba('#000000', 0.5), rim: rgba(p.accent, 0.5), rimW: 1 } }));
      const gold = { stops: ['#fff3c4', '#f2c14e', '#b7791f', '#f6d57a'], angle: 90 };
      void left;
      const col2 = wordsColumn(D, Object.assign(sp ? { w: W2 * 0.5, cy: H * 0.5, align: 'center', cx: W2 * 0.72, maxH: H * 0.6 } : { cx: W2 / 2, w: W2 * 0.78, cy: H * 0.5, align: 'center', maxH: H * 0.6 },
        { style: { font: 'Playfair Black', fill: gold, shadow: true }, keyStyle: { font: 'Cinzel', fill: '#ffffff', imgFill: 'tex:gold', imgFillA: 1, bevel: 0.8, shadow: true } }));
      L.push(...col2);
      const cx2 = sp ? W2 * 0.72 : W2 / 2;
      L.push(SH({ name: 'Rule', shape: 'rect', x: cx2, y: col2.bottom + 18, w: 260, h: 3, fill: p.accent }));
      if (D.f.preacher) L.push(put(T({ name: 'Speaker', text: D.f.preacher, upper: true, font: 'Montserrat', size: 26, letter: 0.28, fill: '#f6e7c1', shadow: true, maxW: 580 }), { cx: cx2, t: col2.bottom + 34 }));
      L.push(...thHead(D, { align: 'center', cx: cx2 }));
      return L;
    },
    /* ── SCRIPT (Sunday Service, Thanksgiving, Freedom for Service): the key word in a flowing script across bold capitals ── */
    ytscript(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      const kw = keyWordOf(D) || 'Glory', rest = String(D.f.title || '').toUpperCase().split(/\s+/).filter((w) => w && w !== kw).join(' ') || kw;
      L.push(bgOf(D, { grade: 'normal', keep: 0.55, blur: 3, bright: -10, contrast: 10, vignette: 0.5, grain: 0.3, colorWash: [{ stops: [rgba(p.deep, 0.9), rgba(p.deep, 0.2)], angle: 0, mode: 'source-over', a: 1 }] }));
      L.push(watermark(D, rest.split(' ').sort((a, b) => b.length - a.length)[0], { strokeColor: rgba('#ffffff', 0.1) }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.73, minL: W2 * 0.48, extra: { glow: rgba(p.accent, 0.35), rim: rgba('#ffffff', 0.6), rimW: 1.2 } }));
      L.push(...thHead(D, { l: 44 }));
      // the line around the script word in bold capitals, above and below it ("Sunday / SERVICE", "Freedom / FOR SERVICE")
      const cx = sp ? W2 * 0.31 : W2 / 2, w = sp ? W2 * 0.52 : W2 * 0.78;
      const all = String(D.f.title || '').toUpperCase().split(/\s+/).filter(Boolean), at = all.indexOf(kw);
      const before = at > 0 ? all.slice(0, at).join(' ') : '', after = at >= 0 ? all.slice(at + 1).join(' ') : '';
      const capsStyle = { font: 'Anton', upper: true, size: 200, fill: { stops: ['#ffffff', '#dfe6f5'], angle: 90 }, shadow: true };
      const sc = T({ name: 'Script title', text: kw.charAt(0) + kw.slice(1).toLowerCase(), font: 'Great Vibes', fit: w * 0.9, maxH: H * 0.34, size: 160, fill: p.accent, shadow: true, rot: -5, edge: 1.6, edgeColor: rgba(p.deep, 0.9), key: true });
      const parts = [before && T(Object.assign({ name: 'Title 1', text: before, fit: w, maxH: H * 0.17 }, capsStyle)), sc, after && T(Object.assign({ name: 'Title 2', text: after, fit: w, maxH: H * 0.2 }, capsStyle))].filter(Boolean);
      const stack2 = col(parts, { cx, cy: H * 0.53, gap: -Math.round(H * 0.035) });
      // the script laid over the capitals, not hidden behind them
      L.push(...stack2.filter((l) => l !== sc), sc);
      const bot = stack2.bottom;
      if (D.f.kicker) L.push(put(T({ name: 'Kicker', text: D.f.kicker, upper: true, font: 'Montserrat Black', size: 24, letter: 0.3, fill: p.accent, shadow: true, maxW: w }), { cx, b: stack2.top - 14 }));
      if (D.f.when) { const g = pill([{ text: D.f.when, upper: true, font: 'Montserrat Black', size: 22, letter: 0.04 }], { fill: p.accent, ink: p.deep, radius: 40, padX: 20, padY: 10, name: 'When' }); L.push(...g.place(cx, bot + 24 + g.h / 2)); }
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 34, b: H - 28 }));
      return L;
    },
    /* ── PANEL (Apostolic Prayer, Spiritual Warfare): a deep panel, the key word in a coloured box, a ribbon with the name ── */
    ytpanel(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      L.push(bgOf(D, { blur: 3, contrast: 12, sat: 10, vignette: 0.35, grain: 0.3 }));
      L.push(SH({ name: 'Panel', shape: 'rect', x: W2 * 0.3, y: H / 2, w: W2 * 0.64, h: H + 4, fill: { stops: [rgba(p.deep, 0.97), rgba(p.deep, 0.9), rgba(p.deep, 0)], angle: 0 } }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.74, minL: W2 * 0.48, extra: { glow: rgba('#000000', 0.45), rim: rgba(mix(p.accent, '#ffffff', 0.4), 0.6), rimW: 1.1 } }));
      L.push(...thHead(D, { l: 44 }));
      const col2 = wordsColumn(D, { l: 58, w: W2 * 0.47, cy: H * 0.52, keyStyle: { fill: p.deep, shadow: false }, pillStyle: { fill: '#ffffff', ink: p.deep } });
      const kl = col2.tb.find((l) => l.key);
      if (kl) {
        const b = box(kl);
        L.push(...turn([SH({ name: 'Word box', shape: 'rect', x: b.l + b.w / 2, y: (b.t + b.b) / 2, w: b.w + 30, h: b.h + 14, fill: p.accent, shadow: true })], -2, b.l + b.w / 2, (b.t + b.b) / 2));
        turn([kl], -2, b.l + b.w / 2, (b.t + b.b) / 2);
      }
      L.push(...col2);
      if (D.f.preacher) {
        const r = T({ name: 'Speaker', text: D.f.preacher, upper: true, font: 'Montserrat Black', size: 24, letter: 0.06, fill: '#ffffff', maxW: 480 });
        const rb = box(r);
        L.push(SH({ name: 'Name ribbon', shape: 'rect', x: 58 + (rb.w + 36) / 2, y: col2.bottom + 30, w: rb.w + 36, h: rb.h + 18, fill: '#d61f26', shadow: true }), put(r, { l: 76, cy: col2.bottom + 30 }));
      }
      return L;
    },
    /* ── ONE WORD (Elevation): the word that carries it, giant, behind the preacher; the rest of the line above and below ── */
    ytword(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      const kw = keyWordOf(D) || 'FAITH';
      const all = String(D.f.title || '').toUpperCase().split(/\s+/).filter(Boolean), at = all.indexOf(kw);
      const before = at > 0 ? all.slice(0, at).join(' ') : '', after = at >= 0 ? all.slice(at + 1).join(' ') : all.filter((w) => w !== kw).join(' ');
      L.push(bgOf(D, { blur: 8, bright: -42, sat: -20, vignette: 0.5, bottomShade: 0.95, bottomFrom: 0.62, grain: 0.4 }));
      L.push(put(T({ name: 'Word', text: kw, font: 'Anton', upper: true, fit: W2 * 0.94, maxH: H * (before ? 0.54 : sp ? 0.66 : 0.5), size: 300, fill: { stops: [mix(p.accent, '#ffffff', 0.35), p.accent], angle: 90 }, shadow: true, key: true }), { cx: W2 / 2, cy: H * (before ? 0.5 : sp ? 0.42 : 0.4) }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.5, t: H * 0.1, extra: { glow: rgba('#000000', 0.55), rim: rgba('#ffffff', 0.5), rimW: 1 } }));
      if (before) L.push(put(T({ name: 'Title 1', text: before, font: 'Montserrat Black', upper: true, size: 58, maxW: W2 * 0.86, fill: '#ffffff', shadow: true, letter: 0.03 }), { cx: W2 / 2, t: 26 }));
      if (after) L.push(put(T({ name: 'Title 2', text: after, font: 'Montserrat Black', upper: true, size: 64, maxW: W2 * 0.9, fill: '#ffffff', shadow: true, letter: 0.02 }), { cx: W2 / 2, b: H - 34 }));
      if (D.f.preacher) L.push(put(T({ name: 'Speaker', text: D.f.preacher, upper: true, font: 'Montserrat Black', size: 22, letter: 0.12, fill: rgba('#ffffff', 0.9), shadow: true, align: 'right', maxW: 340 }), { r: W2 - 34, b: H - (after ? 116 : 34) }));
      return L;
    },
    /* ── B&W ON COLOUR (The Comforter): the preacher in black and white on bold colour, the words dark on a white card ── */
    ytmono(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D), ink = '#111111';
      L.push(BG({ img: null, grain: 0.5, colorWash: [{ radial: true, x: 0.25, y: 0.45, r: 0.7, stops: [rgba('#ffffff', 0.35), rgba('#ffffff', 0)], mode: 'soft-light', a: 1 }] }));
      L.push(watermark(D, keyWordOf(D), { strokeColor: rgba('#ffffff', 0.28), stroke: 2.6 }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.27, maxR: W2 * 0.5, extra: { gray: true, contrast: 18, shade: 'rgba(0,0,0,.35)' } }));
      const cl = sp ? W2 * 0.5 : W2 * 0.14, cw = sp ? W2 * 0.46 : W2 * 0.72;
      L.push(SH({ name: 'Card', shape: 'round', radius: 26, fill: '#ffffff', shadow: true, x: cl + cw / 2, y: H * 0.53, w: cw, h: H * 0.6 }));
      const col2 = wordsColumn(D, { cx: cl + cw / 2, w: cw - 70, cy: H * 0.53, maxH: H * 0.5, align: 'center', light: true, kickFill: mix(p.mid, '#000000', 0.25),
        style: { fill: ink, shadow: false }, keyStyle: { fill: mix(p.mid, '#000000', 0.2) }, pillStyle: { fill: ink, ink: '#ffffff' } });
      L.push(...col2);
      L.push(...thHead(D, { align: 'center', cx: cl + cw / 2, cy: H * 0.53 - H * 0.3 - 30 }));
      if (sp) L.push(...thName(D, { align: 'left', l: 34, b: H - 26, script: false, ink: '#ffffff' }));
      return L;
    },
    /* ── STAGE (Welcome to our Sunday Service, Apostolic Visitation): stage light, a giant faint word, metallic words in the middle ── */
    ytstage(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      L.push(bgOf(D, { grade: 'dark', keep: 0.45, blur: 6, contrast: 12, vignette: 0.55, grain: 0.35 }));
      L.push(FX({ kind: 'beams', x: W2 / 2, y: -40, w: W2 * 1.3, h: H * 1.2, color: p.accent, opacity: 0.4, seed: 5 }));
      L.push(watermark(D, keyWordOf(D), { strokeColor: rgba(p.accent, 0.22) }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.8, minL: W2 * 0.6, t: H * 0.12, extra: { glow: rgba(p.accent, 0.35), rim: rgba('#ffffff', 0.55), rimW: 1 } }));
      L.push(...thHead(D, { align: 'center', cx: sp ? W2 * 0.4 : W2 / 2 }));
      L.push(...wordsColumn(D, { cx: sp ? W2 * 0.4 : W2 / 2, w: sp ? W2 * 0.62 : W2 * 0.8, cy: H * 0.54, align: 'center',
        style: { fill: { stops: ['#ffffff', '#cfd8e6', '#ffffff'], angle: 90 }, extrude: 2, extrudeColor: rgba('#000000', 0.5) }, keyStyle: { fill: { stops: [mix(p.accent, '#ffffff', 0.5), p.accent], angle: 90 } } }));
      if (sp) L.push(...thName(D, { align: 'right', r: W2 - 30, b: H - 26 }));
      return L;
    },
    /* ── OUTLINE (the classic): the preacher on the left with a white edge, tilted words with a thick black outline ── */
    ytoutline(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], sp = sp0(D);
      L.push(BG({ img: sp ? D.bg || D.frame : D.frame || D.bg, blur: sp ? (D.bg ? 3 : 42) : 1, sat: 25, bright: sp ? -24 : -8, contrast: 10, vignette: 0.45,
        colorWash: [{ radial: true, x: 0.72, y: 0.45, r: 0.7, stops: [rgba(p.accent, 0.45), rgba(p.accent, 0)], mode: 'screen', a: 0.7 }] }));
      if (sp) L.push(preacher(D, { cx: W2 * 0.27, maxR: W2 * 0.54, extra: { outline: '#ffffff', glow: rgba('#000000', 0.5) } }));
      const right = !!sp || wordsLeft(D) === false;
      const ol = { edge: 5, edgeColor: '#000000' };
      const col2 = wordsColumn(D, right ? { r: W2 - 46, w: W2 * 0.52, cy: H * 0.52, align: 'right', style: Object.assign({ shadow: true }, ol), keyStyle: ol, kickStyle: ol }
        : { l: 46, w: W2 * 0.52, cy: H * 0.52, style: Object.assign({ shadow: true }, ol), keyStyle: ol, kickStyle: ol });
      turn(col2, -4, right ? W2 * 0.72 : W2 * 0.28, H * 0.5);
      L.push(...col2);
      L.push(...thHead(D, right ? { align: 'right', r: W2 - 40 } : { l: 40 }));
      if (sp) L.push(...thName(D, { align: 'left', l: 30, b: H - 24, script: false }));
      return L;
    },
    /* ── CINEMATIC: the frame itself, graded like a film, the words low on the side away from the face ── */
    ytcinema(D) {
      const W2 = D.w, H = D.h, p = D.pal, L = [], left = !(D.face && D.face.x < 0.45);
      L.push(BG({ img: D.frame || D.bg, blur: 0, contrast: 14, sat: -8, vignette: 0.6, bottomShade: 0.9, bottomFrom: 0.4, grain: 0.5,
        colorWash: [{ stops: ['#0b4f6c', '#e07a2e'], angle: 0, mode: 'soft-light', a: 0.35 }, { stops: left ? [rgba('#000000', 0.75), rgba('#000000', 0)] : [rgba('#000000', 0), rgba('#000000', 0.75)], angle: 0, mode: 'source-over', a: 1 }] }));
      const col2 = wordsColumn(D, left ? { l: 60, w: W2 * 0.44, cy: H * 0.6, maxH: H * 0.62 } : { r: W2 - 60, w: W2 * 0.44, cy: H * 0.6, maxH: H * 0.62, align: 'right' });
      L.push(...col2);
      L.push(SH({ name: 'Line', shape: 'rect', x: left ? 60 + 45 : W2 - 60 - 45, y: col2.top - 22, w: 90, h: 7, fill: p.accent }));
      L.push(...thHead(D, left ? { l: 44 } : { align: 'right', r: W2 - 44 }));
      if (D.f.preacher) L.push(put(T({ name: 'Speaker', text: D.f.preacher, upper: true, font: 'Montserrat Black', size: 22, letter: 0.16, fill: rgba('#ffffff', 0.92), shadow: true, align: left ? 'right' : 'left', maxW: 400 }), left ? { r: W2 - 40, b: H - 30 } : { l: 40, b: H - 30 }));
      return L;
    },
  };
  /*
   * ►► RADIANT IS THE STANDARD. ◄◄ "This is the standard type of flyer, bright, simple": the church's own flyer
   * (Radiant copies it). The board opens on it in four colours — the event's own first — and the other looks wait
   * for "more designs". Each colour is the same layout under its own name, so the board can hold it more than once.
   */
  const RADIANT_WAYS = {
    radiantblue: { name: 'Radiant blue', pal: { deep: '#04114f', mid: '#1f45f0', accent: '#38d6ff', hi: '#ffffff' } },
    radiantpurple: { name: 'Radiant purple', pal: { deep: '#1a0640', mid: '#6d28d9', accent: '#f0abfc', hi: '#ffffff' } },
    radiantred: { name: 'Radiant red', pal: { deep: '#3b0505', mid: '#c81e1e', accent: '#ffc46b', hi: '#ffffff' } },
    radiantgold: { name: 'Radiant gold', pal: { deep: '#2b1600', mid: '#b7791f', accent: '#ffe08a', hi: '#ffffff' } },
    radiantteal: { name: 'Radiant teal', pal: { deep: '#022c33', mid: '#0e8f9c', accent: '#8cf3ff', hi: '#ffffff' } },
  };
  Object.keys(RADIANT_WAYS).forEach((k) => { LAYOUTS[k] = (D) => LAYOUTS.radiant(D); });
  // the standard's family: the same finish, another composition (LAYOUTS.radiantspot / radiantside / radiantwave)
  const STD_FAMILY = ['radiantside', 'radiantspot', 'radiantwave'];
  const isRadiant = (l) => l === 'radiant' || !!RADIANT_WAYS[l] || STD_FAMILY.includes(l);
  const THUMB_LOOKS = Object.keys(THUMBS);
  const LOOK_NAMES = { ytbold: 'Bold', ytglow: 'Glory light', ytlight: 'Light page', ytfire: 'Fire', ytserif: 'Gold serif', ytscript: 'Script', ytpanel: 'Panel', ytword: 'One word', ytmono: 'B&W on colour', ytstage: 'Stage', ytoutline: 'Outline', ytcinema: 'Cinematic', glory: 'Glory', fire: 'Fire', encounter: 'Encounter', miracle: 'Spotlight', bible: 'Golden classic', prophetic: 'Gold', sunday: 'Giant words', lineup: 'Line-up', script: 'Script', scenic: 'Scenic', light: 'Light', joinus: 'Join us', didone: 'Elegant', upper: 'Upper Room', theme: 'Theme picture', mountain: 'Sky letters', breaking: 'Breaking', spirit: 'Gold line-up',
    radiant: 'Radiant', radiantspot: 'Spotlight', radiantside: 'Side', radiantwave: 'Wave', arch: 'Arch', circle: 'Circle', split: 'Colour panel', arches: 'Arches', bigword: 'Big words',
    ailetter: 'AI lettering', jericho: 'Bright hour', unique: 'Bright duo', thanks: 'Bright sky', mantle: 'Cream & gold', urgency: 'Line-up stage', harvest: 'Rows' };
  Object.keys(RADIANT_WAYS).forEach((k) => { LOOK_NAMES[k] = RADIANT_WAYS[k].name; });
  /* each look's own colours (the AI's colours go on the first few designs; these on the rest, for variety) */
  const SIGNATURE = {
    radiant: { deep: '#04114f', mid: '#1f45f0', accent: '#38d6ff', hi: '#ffffff' },
    arch: { deep: '#0b1f4d', mid: '#1d4ed8', accent: '#f5c542', hi: '#ffffff' },
    circle: { deep: '#2a0303', mid: '#b91c1c', accent: '#ffd166', hi: '#ffffff' },
    split: { deep: '#012a30', mid: '#0e7c86', accent: '#f2c94c', hi: '#ffffff' },
    arches: { deep: '#14052e', mid: '#5b21b6', accent: '#f5c542', hi: '#ffffff' },
    bigword: { deep: '#3a0a00', mid: '#ea580c', accent: '#fde047', hi: '#ffffff' },
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
    joinus: { deep: '#2a0b4a', mid: '#9b2bd0', accent: '#f0a36e', hi: '#ffffff' },
    didone: { deep: '#34041e', mid: '#b5311c', accent: '#fbcc37', hi: '#ffffff' },
    upper: { deep: '#4c0804', mid: '#dd4101', accent: '#f9d21a', hi: '#fdfcd1' },
    theme: { deep: '#190101', mid: '#a50d02', accent: '#f7520a', hi: '#fcf65b' },
    mountain: { deep: '#09101a', mid: '#10415d', accent: '#39a9b9', hi: '#e5e7e9' },
    breaking: { deep: '#3a0000', mid: '#c8102e', accent: '#ffd21f', hi: '#ffffff' },
    spirit: { deep: '#140a00', mid: '#5a3208', accent: '#f5c542', hi: '#fff6dd' },
    jericho: { deep: '#2a0606', mid: '#8a1010', accent: '#c8102e', hi: '#ffffff' },
    unique: { deep: '#2a0606', mid: '#c5161d', accent: '#f5c542', hi: '#ffffff' },
    thanks: { deep: '#2a0606', mid: '#c5161d', accent: '#c9921a', hi: '#ffffff' },
    mantle: { deep: '#2a1600', mid: '#8a5a08', accent: '#e3b53c', hi: '#fff8e6' },
    urgency: { deep: '#2a0400', mid: '#d4460b', accent: '#ffd23f', hi: '#ffffff' },
    harvest: { deep: '#1a0d00', mid: '#7a4a08', accent: '#f5c542', hi: '#fff6dd' },
  };

  /* the word written in script across a title — never one the title already says ("PRAYER MEETING / Prayer") */
  function scriptWordFor(want, title, dp) {
    const t = String(title || '').toLowerCase();
    const ok = (w) => w && !t.includes(String(w).toLowerCase());
    const day = dp ? dp.dayName : '';
    return [want, day, 'Glory', 'Power', 'Grace'].find(ok) || 'Glory';
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
    return {
      w: o.w || 1080, h: o.h || 1350, pal, dir, f, bg: o.bg, logo: o.logo, frame: o.frame || null, face: o.face || null,
      sp: (o.speakers || []).map((s) => ({ name: s.name, img: s.img, raw: s.raw, id: s.id, photo: s.photo })),
      script: scriptWordFor(dir.scriptWord, f.title, dp),
      d: dp ? { day3: dp.day.slice(0, 3), day: dp.day, dayName: dp.dayName, ddn: dp.dd.replace(/\D+$/, ''), ddth: dp.dd, month: dp.month, mon3: dp.month.slice(0, 3), year: dp.year } : null,
    };
  }

  /** A whole flyer: { w, h, pal, look, layers } */
  function buildScene(o) {
    const D = dataFor(o);
    // a YouTube thumbnail's looks (THUMBS) or a flyer's
    const book = THUMBS[o.look] ? THUMBS : LAYOUTS;
    const look = book[o.look] ? o.look : 'glory';
    PAINTED = !!o.painted;
    VAR = o.variant || null;
    PAGE_W = D.w;
    let layers;
    try { layers = book[look](D).filter(Boolean); } finally { PAINTED = false; VAR = null; PAGE_W = W; }
    leadFirst(layers, D);
    keepTitleClear(layers, D.h);
    if (o.variant) {
      if (o.variant.mirror && !isRadiant(look)) mirrorLayers(layers, D.w);   // (Radiant stays as the church liked it)
      layers.forEach((l) => { if (l.type === 'fx' && l.seed != null) l.seed = l.seed + o.variant.seed; });
    }
    layers.forEach((l) => { delete l.head; });
    // a painted-in preacher stands in the picture: the light effects go behind the words only, not over a face
    if (o.painted) {
      layers = layers.filter((l) => !(l.type === 'fx' && /glow|ring|sparks/.test(l.kind)));
      // the picture has a face in it: its own colours kept (skin is not regraded), and no blur
      layers.forEach((l) => { if (l.type === 'bg') { l.keepFloor = 0.88; l.blur = 0; } });
    }
    // every soft shadow in the flyer's own darkest colour (a black one is a sticker's)
    const tint = rgba(mix(D.pal.deep, '#000000', 0.5), 0.62);
    layers.forEach((l) => { if (l.type === 'text' && l.shadow && !l.shadowColor) l.shadowColor = tint; });
    // a bright and simple page is clean print: no shadow under a word, no grain over the page
    const plain = SIMPLE.has(look);
    if (plain) layers.forEach((l) => { if (l.type === 'text' || l.type === 'shape') l.shadow = false; });
    return { w: D.w, h: D.h, pal: D.pal, look, painted: !!o.painted, variant: o.variant || null, frame: D.frame, face: D.face, layers, finish: !plain };
  }

  /* A cut-out, tidied — the upload path keeps a data URL (see tidyCanvas). */
  async function tidyCut(src) {
    const im = await loadImg(src);
    const c = canvas(iw(im), ih(im)); c.getContext('2d').drawImage(im, 0, 0);
    const t = tidyCanvas(c);
    return t.c === c && !t.x0 && !t.y0 ? src : t.c.toDataURL('image/png');
  }

  root.MWFlyer = { tidyCut, preparePerson, prepareRaw, photoMeta, hero, framedSrc, SIMPLE, META, HD, render, buildScene, loadFonts, IMGS, loadImg, proceduralBg, LAYOUTS, LOOK_NAMES, SIGNATURE, RADIANT_WAYS, FONTS, textCanvas, boxOf, Dates };

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
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    zoom: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/><path d="M11 8v6"/><path d="M8 11h6"/>',
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
  const MATERIALS = [['Gold leaf', 'gold'], ['Stone', 'stone'], ['Flames', 'fire'], ['Steel', 'steel'], ['Rose gold', 'rosegold']];

  const F = {
    panel: null, kit: null, status: null,
    step: 'make',          // make → pick → edit
    occasion: null,
    fields: { title: '', theme: '', date: '', time: '', time2: '', venue: '', church: '', phone: '', handles: '', extra: '', notes: '', kind: '' },
    speakers: [],          // ids from the kit, in order
    pinned: {},            // speaker id -> the photo chosen from their bank (else the AI picks)
    size: 'post',
    way: (() => { try { return localStorage.getItem('mw-flyer-way') || 'radiantpurple'; } catch (e) { return 'radiantpurple'; } })(),   // the colour under the live preview, first on the board
    dir: null, pal: null,
    bgs: [],               // { key, by } — painted pictures, best first
    designs: [],           // scenes offered
    scene: null, sel: null, undo: [], redo: [],
    painting: 0, tries: 0,
    mode: 'flyer',         // 'flyer' | 'thumb' (a YouTube thumbnail: the same studio, made from a video)
    th: { video: null, photo: null, frames: [], pick: 0, custom: null, dur: 0, ideas: null, line: '', key: '', ask: 0, bgs: [], person: '', frameKey: '',
      look: (() => { try { return localStorage.getItem('mw-thumb-look') || 'ytbold'; } catch (e) { return 'ytbold'; } })() },   // the look under the live preview, first on the board
  };
  const sizeOf = () => SIZES.find((s) => s.id === F.size) || SIZES[0];

  /* -------------------------------------------------------------- the kit */

  async function loadKit() {
    try { F.kit = await window.api.flyer.kitGet(); } catch (e) { F.kit = null; }
    if (!F.kit) F.kit = { church: '', address: '', phone: '', handles: '', speakers: [], services: [] };
    for (const s of F.kit.speakers || []) {
      if (!Array.isArray(s.photos)) s.photos = [];
      for (const [p, o] of Object.entries(s.orig || {})) if (!ORIG.has(p)) ORIG.set(p, o);
    }
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
  const ORIG = new Map();     // a bank picture -> the photo it was cut from (its file name on the server, or its data URL)
  const rawKey = (p) => 'kr:' + p;
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
        // and the photo it was cut from, for the framed looks (an arch, a circle): shown as it is, nothing cut out
        const o = ORIG.get(p);
        if (o) {
          try {
            const ph = await loadImg(/^data:/.test(o) ? o : await window.api.flyer.kitPic(o));
            const m = await root.MWFlyer.prepareRaw(ph);
            if (m) { IMGS.set(rawKey(p), ph); META.set(rawKey(p), m); }
          } catch (e) { /* the cut-out goes in the frame instead */ }
        }
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
    return chosenSpeakers().map((s) => { const photo = photoFor(s, i); return { id: s.id, name: s.name, photo, img: photo ? picKey(photo) : '', raw: photo && IMGS.has(rawKey(photo)) ? rawKey(photo) : '' }; });
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
    F.mode = 'flyer';
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
    if (F.step === 'tmake') return drawThumbMake();
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
  /*
   * ►► SEE IT AS YOU TYPE. ◄◄ (Option A, chosen from the mockups: "Option A for both".) The first flyer of the
   * board — Radiant in the colour picked under it, the preacher's first photo, the words as typed — drawn small at
   * the top of the page, and again a moment after each change. Tapped, it opens big. The colour picked leads the
   * board (rankLooks), so what is seen here is what comes first after Make.
   */
  const WAY_ORDER = ['radiantpurple', 'radiantblue', 'radiantred', 'radiantgold', 'radiantteal'];
  let liveN = 0, liveT = 0, liveLast = null;
  function liveScene() {
    const sz = sizeOf(), way = RADIANT_WAYS[F.way] ? F.way : WAY_ORDER[0];
    return buildScene({ look: way, w: sz.w, h: sz.h, pal: RADIANT_WAYS[way].pal, dir: F.dir || {}, fields: F.fields, speakers: speakersFor(0), logo: IMGS.has('logo') ? 'logo' : null });
  }
  async function paintLive() {
    const cv = F.panel && $('.fs-live-cv', F.panel.body); if (!cv) return;
    const n = ++liveN;
    // the last one drawn, at once (a page drawn again would otherwise blink empty while the new one is made)
    if (liveLast && !cv.dataset.p) { cv.width = liveLast.width; cv.height = liveLast.height; cv.getContext('2d').drawImage(liveLast, 0, 0); }
    cv.dataset.p = '1';
    await loadFonts();
    await Promise.all(speakersFor(0).map((s) => bankPic(s.photo)));
    if (n !== liveN || !cv.isConnected) return;
    const S = liveScene();
    const out = render(S, canvas(1, 1), Math.max(240, Math.round((cv.clientWidth || 216) * (window.devicePixelRatio || 1))) / S.w);
    cv.width = out.width; cv.height = out.height; cv.getContext('2d').drawImage(out, 0, 0);
    liveLast = out;
  }
  const liveSoon = () => { clearTimeout(liveT); liveT = setTimeout(paintLive, 140); };
  /* a preacher's face, round, for their button: the head and shoulders from where the cut-out says they are */
  const FACE = new Map();
  function faceOf(p) {
    if (!p) return Promise.resolve('');
    if (!FACE.has(p)) {
      FACE.set(p, bankPic(p).then((im) => {
        if (!im) return '';
        const m = META.get(picKey(p)), W = iw(im), H = ih(im);
        let cx = W / 2, cy = Math.min(W, H) * 0.45, side = Math.min(W, H);
        if (m && m.sy > m.top) { const hh = m.sy - m.top; cx = m.cx; cy = m.top + hh * 0.56; side = Math.max(hh * 1.2, (m.sw || 0) * 0.62); }
        side = Math.max(8, Math.min(side, W, H));
        const sx = Math.max(0, Math.min(W - side, cx - side / 2)), sy = Math.max(0, Math.min(H - side, cy - side / 2));
        const c = canvas(160, 160), g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 160, 160);
        gr.addColorStop(0, '#5b21b6'); gr.addColorStop(1, '#1c1238');
        g.fillStyle = gr; g.fillRect(0, 0, 160, 160);
        g.drawImage(im, sx, sy, side, side, 0, 0, 160, 160);
        return c.toDataURL('image/jpeg', 0.86);
      }).catch(() => ''));
    }
    return FACE.get(p);
  }
  function fillFaces(el) {
    $$('img[data-face]', el).forEach((img) => faceOf(img.dataset.face).then((u) => { if (u) img.src = u; }));
  }

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
    // each preacher with their FACE (not the whole of them, small) and their whole name
    const sp = (k.speakers || []).map((s) => {
      const on = F.speakers.includes(s.id);
      const ph = photoFor(s, 0);
      return `<button type="button" class="fs-pill${on ? ' on' : ''}" data-sp="${escAttr(s.id)}"><span class="fs-pill-pic">${ph ? `<img data-face="${escAttr(ph)}" alt="">` : esc((s.name || '?').replace(/^(pst|pastor|rev|dr|bishop|apostle|evang)\.?\s+/i, '').charAt(0))}</span>`
        + `<span class="fs-pill-tx"><b>${esc(s.name || 'Speaker')}</b>${on && (s.photos || []).length ? `<small>${F.pinned[s.id] ? 'your pick' : 'AI picks'} · ${s.photos.length} photos</small>` : ''}</span></button>`;
    }).join('') + `<button type="button" class="fs-pill fs-pill-add" data-act="addsp" aria-label="Add a preacher"><span class="fs-pill-pic">${ic('plus')}</span><span class="fs-pill-tx"><b>Add</b></span></button>`;
    const painter = F.status && F.status.cloudflare ? 'FLUX.2' : 'FLUX';
    const ways = WAY_ORDER.map((k) => `<button type="button" class="fs-way${F.way === k ? ' on' : ''}" data-way="${k}" style="background:${RADIANT_WAYS[k].pal.mid}" aria-label="${esc(RADIANT_WAYS[k].name)}"></button>`).join('');
    P.body.innerHTML = `
      <div class="fs-make fs-a">
        <div class="fs-a-top">
          <button type="button" class="fs-live" data-act="livebig" data-shape="${escAttr(F.size)}" aria-label="See this flyer big"><canvas class="fs-live-cv"></canvas></button>
          <div class="fs-ways">${ways}<small class="fs-live-note"><i></i>Live as you type</small></div>
        </div>
        <div class="fs-a-sheet">
        <section class="fs-asec">
          <h4>What is it for?</h4>
          <div class="fs-occs">${chips}</div>
        </section>
        <section class="fs-asec">
          <h4>My presets <small>tap one to fill everything in</small></h4>
          <div class="fs-occs fs-presets">${(k.presets || []).map((pr) => `<span class="fs-occ fs-preset" data-preset="${escAttr(pr.id)}"><b>${esc(pr.name)}</b><small>${esc([pr.fields && niceTime(pr.fields.time), pr.fields && pr.fields.venue].filter(Boolean).join(' · ') || 'saved details')}</small><button type="button" class="fs-preset-x" data-unpreset="${escAttr(pr.id)}" aria-label="Delete ${escAttr(pr.name)}">×</button></span>`).join('')}<button type="button" class="fs-occ fs-preset-add" data-act="savepreset"><b>＋ Save these</b><small>as a preset</small></button></div>
        </section>
        <section class="fs-asec">
          <h4>Who is preaching? <small>tap again for their photos</small></h4>
          <div class="fs-pills">${sp}</div>
          ${chosenSpeakers().map((s) => `<button type="button" class="fs-addph" data-act="bulk" data-id="${escAttr(s.id)}">${ic('plus')}<span>Add photos of ${esc(s.name || 'this speaker')} <i>· ${(s.photos || []).length} in the bank</i></span></button>`).join('')}
        </section>
        <section class="fs-asec fs-form">
          <h4>The words</h4>
          <div class="fs-box">
            <label class="fs-row"><span>Title</span><input data-f="title" value="${escAttr(f.title)}" placeholder="Sunday Service" ${TXT('words')}></label>
            <label class="fs-row"><span>Theme</span><input data-f="theme" value="${escAttr(f.theme)}" placeholder="optional — e.g. Loose Him and Let Him Go" ${TXT('sentences')}></label>
            <div class="fs-row fs-row2"><label><span>Date</span><input type="date" data-f="date" value="${escAttr(f.date)}"></label><label><span>Time</span><input type="time" data-f="time" data-time value="${escAttr(hhmm(f.time))}"></label></div>
            <label class="fs-row"><span>Where</span><input data-f="venue" value="${escAttr(f.venue)}" placeholder="12 Airport Road, Benin City" ${TXT('words')}></label>
          </div>
          <details class="fs-more"${f.extra || f.time2 || f.notes ? ' open' : ''}><summary>More</summary>
            <label class="fs-f"><span>Second service</span><input type="time" data-f="time2" data-time value="${escAttr(hhmm(f.time2))}"></label>
            <label class="fs-f"><span>Extra line</span><input data-f="extra" value="${escAttr(f.extra)}" placeholder="10th Edition" ${TXT('words')}></label>
            <label class="fs-f fs-wide"><span>Phone / email</span><input data-f="phone" value="${escAttr(f.phone)}" inputmode="email" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>
            <label class="fs-f fs-wide"><span>Social handles</span><input data-f="handles" value="${escAttr(f.handles)}" placeholder="@yourchurch" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
            <label class="fs-f fs-wide"><span>Tell the AI the mood <i>(optional)</i></span><textarea data-f="notes" rows="2" placeholder="fire, revival, purple and gold, mountains…">${esc(f.notes)}</textarea></label>
          </details>
        </section>
        <section class="fs-asec">
          <h4>Size</h4>
          <div class="fs-seg">${SIZES.map((s) => `<button type="button" data-size="${s.id}" class="${F.size === s.id ? 'on' : ''}">${esc(s.name)}</button>`).join('')}</div>
        </section>
        <button type="button" class="fs-kit-link" data-act="kit">${ic('church')}<span><b>My church</b><small>${esc(k.church ? k.church : 'Name, logo, address, speakers and service days — set once')}</small></span>${ic('back').replace('fs-ic', 'fs-ic fs-chev')}</button>
        ${F.status && F.status.owner && F.status.cloudflare && window.api.flyer.library ? `<button type="button" class="fs-kit-link" data-act="library">${ic('photo')}<span><b>Church picture library</b><small>Every AI picture kept for the church · today’s free allowance (only you see this)</small></span>${ic('back').replace('fs-ic', 'fs-ic fs-chev')}</button>` : ''}
        <p class="fs-note">${F.status && !F.status.cloudflare ? 'Pictures are painted free by FLUX. For faster, sharper ones (FLUX.2, about 70 a day, free), add a free Cloudflare account to the server — see CLOUD.md.' : `Pictures are painted free by ${painter}. Your words are set exactly as you type them.`}</p>
        </div>
      </div>`;
    P.foot.innerHTML = `<button type="button" class="fs-go" data-act="make">${ic('spark')}<span>Make my flyers</span></button>`;
    fillPics(P.body);
    fillFaces(P.body);
    paintLive();
    wireMake();
  }

  function wireMake() {
    const P = F.panel;
    const boxes = $$('[data-f]', P.body);
    boxes.forEach((el, i) => {
      const keep = () => { F.fields[el.dataset.f] = el.hasAttribute('data-time') ? niceTime(el.value) : el.value; liveSoon(); };
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
      const w = e.target.closest('[data-way]');
      if (w) {
        F.way = w.dataset.way;
        try { localStorage.setItem('mw-flyer-way', F.way); } catch (er) { /* private window */ }
        $$('[data-way]', P.body).forEach((x) => x.classList.toggle('on', x === w));
        return paintLive();
      }
      const b = e.target.closest('[data-occ],[data-sp],[data-size],[data-act]'); if (!b) return;
      if (b.dataset.act === 'livebig') {
        await Promise.all(speakersFor(0).map((x) => bankPic(x.photo)));
        return viewFlyer(liveScene());
      }
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
      if (b.dataset.act === 'library') return openLibrary();
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
    if (!F.fields.title.trim()) { toast('Give it a title first.', 'error'); return; }
    // remember these details for this service (Tuesday's Word Study comes back as typed)
    const ok = occKey(F.occasion);
    if (ok && ok !== 'other' && F.kit) { F.kit.lastFor = Object.assign({}, F.kit.lastFor, { [ok]: presetNow() }); saveKit(true); }
    // "New pictures" keeps the AI-lettered title it already has (another would spend the day's dearest painting again)
    const keepLetter = F.lettered && F.lettered.title === String(F.fields.title || '').trim() ? F.lettered : null;
    F.step = 'pick'; F.bgs = []; F.designs = []; F.dir = null; F.tries++; F.paintedIn = []; F.lettered = keepLetter;
    const tryNo = F.tries;
    drawPick();
    await loadFonts();
    const dp = dateParts(F.fields.date);
    // the day's free allowance, as it stands now (what is left decides the better painters and the AI lettering)
    try { const st = await window.api.flyer.status(); if (st) F.status = Object.assign(st, { note: allowanceNote(st) }); } catch (e) { /* the last one known stands */ }
    await Promise.all(Object.keys(LAYOUTS).map((l, i) => speakersFor(i)).flat().map((s) => bankPic(s.photo)));
    const fields = Object.assign({}, F.fields, { dateText: dp ? dp.long : '', dayName: dp ? dp.dayName : '', season: F.occasion && F.occasion.seasonal ? F.occasion.name : '', speakers: chosenSpeakers().map((s) => ({ name: s.name })) });
    let dir = null;
    try { dir = await window.api.flyer.direct(fields); } catch (e) { dir = null; }
    if (tryNo !== F.tries) return;
    F.dir = dir || { scenes: ['heavenly golden light rays through purple clouds'], palette: ['#1a0638', '#5b21b6', '#f5c542', '#ffffff'], scriptWord: dp ? dp.dayName : 'Sunday', kicker: 'WORSHIP WITH US THIS', looks: Object.keys(LAYOUTS) };
    const pp = F.dir.palette || [];
    F.pal = { deep: pp[0] || '#14052e', mid: pp[1] || '#5b21b6', accent: pp[2] || '#f5c542', hi: pp[3] || '#ffffff' };
    newBoard();
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
    // one picture for each of the board's three; the first are the title's own idea painted as key art
    const scenes = (F.dir.scenes || []).slice(0, BOARD_N);
    for (let j = 0; scenes.length && scenes.length < BOARD_N; j++) scenes.push(scenes[j % scenes.length]);
    const nTheme = Math.min(F.dir.themeScenes == null ? 0 : F.dir.themeScenes, 3);
    F.painting = scenes.length;
    drawPick();
    const paintingIn = paintPreacherIn(tryNo, sz);   // alongside the six, not after them
    const lettering = paintLettering(tryNo);
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        // each picture in its own light — the AI's colours, royal blue, purple — so the board is as varied as a Pinterest page
        const tone = F.board.tones[i % F.board.tones.length];
        const theme = i < nTheme;
        // the board's top two get the better free painter (FLUX.2 klein 9B) while the day's allowance lasts
        const tier = i < 2 && F.status && F.status.premium ? 'premium' : 'normal';
        // what the picture is FOR travels with it: the server keeps every painting in the church's library under
        // that (the kind of event, the theme, the light, the shape) and hands the next person one they have not seen
        const out = await window.api.flyer.paint({ scene: tone.words ? scene + ', ' + tone.words : scene, theme, tier, w: sz.w, h: sz.h, seed: Math.floor(Math.random() * 1e9), people: chosenSpeakers().some((s) => (s.photos || []).length),
          slot: i, tone: tone.id, event: eventOf() });
        if (tryNo !== F.tries) return;
        let im = await loadImg(picSrc(out));
        // the backup painter signs its pictures in the bottom corner: that strip is cut off
        if (/pollinations/i.test(out.by || '')) im = cropBottom(im, 0.06);
        const key = 'ai:' + tryNo + ':' + i;
        IMGS.set(key, im);
        // AI pictures lead; the photos stay on for variety until three AI ones are in
        // (a library picture says what light it is really in, and whether it is the theme's own key art)
        const ai = F.bgs.filter((b) => !b.proc).concat({ key, file: out.file, by: out.by + (out.bank ? ' · library' : ''), scene, tone: out.tone || tone.id, theme: out.themeArt != null && out.bank ? !!out.themeArt : theme });
        // AI pictures in order of their light, the studio's photos only standing in until three are here
        ai.sort((a, b) => (b.theme ? 1 : 0) - (a.theme ? 1 : 0) || F.board.tones.findIndex((t) => t.id === a.tone) - F.board.tones.findIndex((t) => t.id === b.tone));
        F.bgs = ai.concat(F.bgs.filter((b) => b.proc)).slice(0, Math.max(3, ai.length));
        rebuildDesigns();
      } catch (e) { /* the studio's own photographs stand in */ }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
    await paintingIn;
    await lettering;
  }

  /*
   * ►► THE TITLE LETTERED INTO THE PICTURE BY AI (free: Phoenix 1.0 on
   * Cloudflare, about two a day). ◄◄ The art the flyers people save have —
   * the title carved, burning, in gold — painted as part of the scene; the
   * studio adds the minister and the details. The server reads it back and
   * keeps it only when the title is spelt right (flyerart.paintTitle).
   */
  /*
   * THE DAY'S FREE AI, SAID PLAINLY. One allowance a day for the whole church:
   * when it is busy the board mixes fresh paintings with the church library's
   * (painted for someone earlier, new to you); when it has painted its share,
   * the library's — and when it comes back, in this phone's own time.
   */
  function allowanceNote(st) {
    if (!st || !st.cloudflare || !st.level || st.level === 'plenty' || st.level === 'none') return '';
    let back = 'midnight UTC';
    try { if (st.resetsAt) back = new Date(st.resetsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { /* as it is */ }
    if (st.level === 'limited') return 'A busy day for the free AI: your board mixes fresh paintings with pictures from the church library — all new to you.';
    return st.library ? `The free AI has painted its share for today (it’s back at ${back}). Your pictures come from the church library — ones you haven’t had.`
      : `The free AI has painted its share for today (it’s back at ${back}). Your board uses the studio’s own photographs until then.`;
  }
  /* a picture from the server: from the church's library by its link (the phone keeps it), else as sent */
  const picSrc = (out) => (out.file && window.MW_FLYER_LIB_URL ? window.MW_FLYER_LIB_URL(out.file) : out.dataUrl);
  /* the event, as the server's library files its pictures: the kind of service, the title, the theme, the season */
  function eventOf() {
    return { title: String(F.fields.title || '').slice(0, 80), theme: String(F.fields.theme || '').slice(0, 80), kind: String(F.fields.kind || (F.occasion && F.occasion.name) || '').slice(0, 60),
      season: F.occasion && F.occasion.seasonal ? String(F.occasion.name || '').slice(0, 60) : '' };
  }
  async function paintLettering(tryNo) {
    const title = String(F.fields.title || '').trim();
    if (F.lettered && F.lettered.title === title) return;   // kept from the last board
    F.lettered = null;
    if (!(F.status && F.status.lettering) || !title || title.split(/\s+/).length > 4 || !window.api.flyer.paintTitle) return;
    F.painting++; if (F.step === 'pick') drawPick();
    try {
      const scene = (F.dir.scenes || [])[0];
      // (read back on the server: spelt right AND standing out clearly — flyerart.paintTitle)
      const out = await window.api.flyer.paintTitle({ scene, title, seed: Math.floor(Math.random() * 1e9), event: eventOf() });
      if (tryNo !== F.tries || !out || !(out.dataUrl || out.file)) return;
      const im = await loadImg(picSrc(out));
      const key = 'ail:' + tryNo;
      IMGS.set(key, im);
      F.lettered = { key, title, checked: !!out.checked, by: out.by + (out.bank ? ' · library' : '') };
      rebuildDesigns();
    } catch (e) { /* the day's allowance, a misspelling twice: the other designs stand */ }
    finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
  }

  /*
   * ►► THE PREACHER PAINTED IN (option 1). ◄◄ Their photo — the cut-out, on a
   * plain grey, so a lectern or a crowd behind them is not copied — goes to
   * FLUX.2 as a reference, and two pictures come back with them standing in
   * the scene, lit by it. They become their own designs, marked so that the
   * face is checked before posting: the model can change a face a little.
   */
  const PAINT_IN_LOOKS = ['glory'];   // one, and only on a board without the AI lettering (the board is three)
  function refPhoto(sp) {
    const im = sp && imgOf(sp.img); if (!im) return null;
    const k = Math.min(1, 496 / Math.max(iw(im), ih(im)));   // Cloudflare: reference photos smaller than 512x512
    const c = canvas(iw(im) * k, ih(im) * k), x = c.getContext('2d');
    x.fillStyle = '#7a7a7a'; x.fillRect(0, 0, c.width, c.height);
    x.drawImage(im, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  }
  async function paintPreacherIn(tryNo, sz) {
    F.paintedIn = [];
    if (!(F.status && F.status.cloudflare)) return;
    // a board of three: the AI-lettered title takes a place when the day allows it; then this one does not
    if (F.status.lettering && String(F.fields.title || '').trim().split(/\s+/).length <= 4) return;
    const sp = speakersFor(0)[0]; const ref = refPhoto(sp);
    if (!ref) return;
    const scenes = (F.dir.scenes || []).slice(0, PAINT_IN_LOOKS.length);
    F.painting += scenes.length; if (F.step === 'pick') drawPick();
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        const out = await window.api.flyer.paintWith({ scene, w: sz.w, h: sz.h, seed: Math.floor(Math.random() * 1e9), refs: [ref], event: eventOf() });
        if (tryNo !== F.tries) return;
        const key = 'aiin:' + tryNo + ':' + i;
        IMGS.set(key, await loadImg(out.dataUrl));
        F.paintedIn = F.paintedIn.concat({ key, by: out.by, scene, look: PAINT_IN_LOOKS[i % PAINT_IN_LOOKS.length] });
        rebuildDesigns();
      } catch (e) { /* the ordinary designs stand; this is an extra */ }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
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
    { id: 'emerald', words: 'the whole scene lit in deep emerald green light with warm golden highlights' },
    { id: 'sunset', words: 'the whole scene lit by a burning sunset, magenta sky fading to orange, warm rim light' },
    { id: 'night', words: 'a dark midnight-blue night with a single bright white light source and soft haze' },
    { id: 'royal', words: 'the whole scene lit in royal blue with rich gold highlights and warm haze' },
    { id: 'crimson', words: 'the whole scene lit in deep crimson and wine red light with soft gold highlights' },
  ];
  const TONE_PAL = {
    own: 'own',
    blue: { deep: '#020b2e', mid: '#0b3d91', accent: '#ffd23f', hi: '#ffffff' },
    purple: { deep: '#14063a', mid: '#6d1fb0', accent: '#ff9a2e', hi: '#ffe6ff' },
    red: { deep: '#240003', mid: '#a5111d', accent: '#ffc21a', hi: '#fff3e0' },
    gold: { deep: '#2a1400', mid: '#b86f00', accent: '#ffd54a', hi: '#fffbe6' },
    teal: { deep: '#012226', mid: '#0e6f7a', accent: '#ffd23f', hi: '#ffffff' },
    emerald: { deep: '#01200f', mid: '#0a6b37', accent: '#f6c945', hi: '#ffffff' },
    sunset: { deep: '#2c0c46', mid: '#d9466f', accent: '#ffb347', hi: '#fff1e0' },
    night: { deep: '#02040f', mid: '#16245a', accent: '#8fd3ff', hi: '#ffffff' },
    royal: { deep: '#06103a', mid: '#1d3fb8', accent: '#f5c542', hi: '#ffffff' },
    crimson: { deep: '#26020c', mid: '#8c0f2e', accent: '#f2c46b', hi: '#fff4e6' },
  };
  /*
   * ►► FOUR, THE BEST FIRST. ◄◄ Eighteen at once was too many to choose
   * from. A board is four designs, ranked: how strong the layout is on its
   * own, whether it suits this event (the AI's own picks, a line-up only when
   * there are several ministers), what this phone has opened and saved
   * before, and a little freshness so the five are not the same five every
   * time. "More designs" brings the next four. And the four are four
   * different flyers, not one flyer in four fonts (a board of three all
   * orange, the preacher bottom-centre on each): at most two with the
   * preacher in the middle, a bright page among them when one ranks, and
   * the pictures painted in lights that alternate warm and cool. Each design is built with a
   * variant of its own (makeVariant); its picture is painted in one of
   * eleven lights picked afresh.
   */
  const BOARD_N = 4;   // "maybe 4 instead of 3": four, the best first
  // how well each layout stands up on its own (from setting them beside the Pinterest flyers)
  const STRENGTH = { glory: 9, fire: 9, joinus: 9, spirit: 8, prophetic: 8, sunday: 8, upper: 8, miracle: 8, script: 7, encounter: 7, breaking: 7, didone: 7,
    lineup: 7, mountain: 6, bible: 6, scenic: 6, light: 6, theme: 6,
    jericho: 8, unique: 8, thanks: 7, mantle: 8, urgency: 8, harvest: 8,
    arch: 9, circle: 9, split: 9, arches: 9, bigword: 8, radiant: 10, radiantside: 10, radiantspot: 10, radiantwave: 10 };
  const SEEN_KEY = 'mw-flyer-seen', LIKED_KEY = 'mw-flyer-liked';
  const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } };
  const seenLooks = () => readLS(SEEN_KEY);
  function markSeen(looks) {
    const seen = seenLooks(), now = Date.now();
    looks.forEach((l) => { seen[l] = now; });
    try { localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch (e) {}
  }
  /** A layout chosen: opened (1) or saved / posted (3) — it ranks higher on the next boards. */
  function markLiked(look, w) {
    if (!look) return;
    const liked = readLS(LIKED_KEY); liked[look] = Math.min(20, (liked[look] || 0) + (w || 1));
    try { localStorage.setItem(LIKED_KEY, JSON.stringify(liked)); } catch (e) {}
  }
  function shuffled(a) { const o = a.slice(); for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; } return o; }
  function rankLooks() {
    const seen = seenLooks(), liked = readLS(LIKED_KEY), now = Date.now();
    const ai = ((F.dir && F.dir.looks) || []).filter((l) => LAYOUTS[l]);
    const many = chosenSpeakers().filter((s) => (s.photos || []).length || s.photo).length >= 2;
    const score = (l) => {
      let v = STRENGTH[l] || 6;
      const ai0 = ai.indexOf(l); if (ai0 >= 0 && ai0 < 6) v += 3 - ai0 * 0.4;   // the AI's picks for this event, best first
      v += Math.min(4, (liked[l] || 0) * 0.5);                                   // what this church goes for
      if (seen[l] && now - seen[l] < 36e5 * 6) v -= 2.5;                         // on the last board or two: rest it
      if (['lineup', 'spirit', 'urgency', 'harvest'].includes(l) && !many) v -= 4;   // a line-up of one is not a line-up
      if (['lineup', 'urgency', 'harvest', 'unique'].includes(l) && many) v += 3;
      return v + Math.random() * 2.2;                                            // freshness
    };
    // two ministers (a Sunday): only the designs that show — and name — both; the line-ups of many wait for three or more
    const nSp = chosenSpeakers().filter((s) => (s.photos || []).length || s.photo).length;
    const fits = (l) => nSp < 2 || (nSp === 2 ? DUO.has(l) : (DUO.has(l) && l !== 'circle') || l === 'urgency' || l === 'harvest');
    // ("The circles eg are nasty": the framed photos — circle, arch, arches, big words, colour panel — are never on a board)
    const scored = Object.keys(LAYOUTS).filter((l) => l !== 'ailetter' && !SIMPLE.has(l) && fits(l)).map((l) => [l, score(l)]).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
    /* ►► BRIGHT AND SIMPLE FIRST. ◄◄ "They should be bright, simple": the
       board is Radiant and the light, framed looks (SIMPLE); the older bright pages come
       next, and the dark, dramatic ones only on "more designs". Within each,
       the scores' order. At most two with the preacher in the middle. */
    // (Radiant first of all: the one held up as better than all the rest)
    const tier = (l) => (isRadiant(l) ? -1 : SIMPLE.has(l) ? 0 : BRIGHT.has(l) ? 1 : 2);
    const order = scored.slice().sort((a, b) => tier(a) - tier(b));
    const board = [], centred = (l) => !SIMPLE.has(l) && !isRadiant(l) && !SIDE.has(l) && !BRIGHT.has(l) && !GROUP.has(l);
    // the standard first: Radiant in the event's own colours, then three more of its colours (blue, the church's own,
    // whenever the event's are not blue already); the colours left over and the other looks on "more designs"
    const [pr, , pb] = hexRgb((F.pal && F.pal.mid) || '#1f45f0'), blueOwn = pb > pr + 40;
    const ways = Object.keys(RADIANT_WAYS).filter((k) => !(blueOwn && k === 'radiantblue'));
    const firstWays = (blueOwn ? [] : ['radiantblue']).concat(shuffled(ways.filter((k) => k !== 'radiantblue')));
    // (the colour picked under the live preview leads — it IS the flyer seen there.) ►► NOT THE SAME FLYER FOUR TIMES. ◄◄
    // "They look the same": the rest of the first board is the standard's family — Side, Spotlight, Wave — each its
    // own composition in its own colour; the other colours and the event's own wait for "more designs"
    const lead = RADIANT_WAYS[F.way] ? F.way : null;
    if (fits('radiant')) board.push(lead || 'radiant', ...STD_FAMILY.filter(fits));
    for (const l of order) {
      if (board.length >= BOARD_N) break;
      if (board.includes(l)) continue;
      if (centred(l) && board.filter(centred).length >= 2) continue;
      board.push(l);
    }
    for (const l of order) if (board.length < BOARD_N && !board.includes(l)) board.push(l);
    // "more designs": the other looks, with one more colour of the standard among each three (never four of it again)
    const colours = (lead ? ['radiant'] : []).concat(firstWays.filter((k) => k !== lead)).filter((l) => !board.includes(l));
    const others = order.filter((l) => !board.includes(l) && !isRadiant(l)), more = [];
    let ci = 0;
    others.forEach((l, i) => { if (i % 3 === 0 && ci < colours.length) more.push(colours[ci++]); more.push(l); });
    return board.concat(more, colours.slice(ci));
  }
  // how a layout places the preacher (for a board of different flyers)
  const SIDE = new Set(['jericho', 'sunday', 'script', 'joinus', 'breaking', 'didone']);
  const BRIGHT = new Set(['jericho', 'unique', 'thanks', 'mantle', 'light']);
  const GROUP = new Set(['urgency', 'harvest', 'unique', 'lineup']);
  // the designs that show two ministers side by side, both named
  const DUO = new Set(['unique', 'lineup', 'spirit', 'thanks', 'encounter', 'miracle', 'joinus', 'circle', 'arches', 'bigword', 'radiant', ...Object.keys(RADIANT_WAYS), ...STD_FAMILY]);
  const COOL_TONES = ['blue', 'purple', 'teal', 'emerald', 'night', 'royal'];
  function newBoard() {
    const order = rankLooks();
    // the lights alternate: the AI's own, a cool one, a warm one, a cool one (not four oranges)
    const cool = shuffled(TONES.filter((t) => COOL_TONES.includes(t.id))), warm = shuffled(TONES.filter((t) => !COOL_TONES.includes(t.id) && t.id !== 'own'));
    const tones = [TONES[0], cool[0], warm[0], cool[1], warm[1], cool[2]].filter(Boolean);
    const palettes = shuffled(PALETTES);
    const variants = {};
    order.forEach((look, i) => { variants[look] = makeVariant(palettes[i % palettes.length]); variants[look].pal = palettes[i % palettes.length]; });
    // (never the first one's colour again: the way picked, or the one nearest the event's own colours)
    const near = (k) => { const a = hexRgb(RADIANT_WAYS[k].pal.mid), b = hexRgb((F.pal && F.pal.mid) || '#6d28d9'); return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); };
    const lead = RADIANT_WAYS[F.way] ? F.way : Object.keys(RADIANT_WAYS).sort((a, b) => near(a) - near(b))[0];
    const others = shuffled(Object.keys(RADIANT_WAYS).filter((k) => k !== lead)), pals = {};
    STD_FAMILY.forEach((l, i) => { pals[l] = RADIANT_WAYS[others[i % others.length]].pal; });
    F.board = { order, tones, variants, shown: BOARD_N, pals };
    markSeen(order.slice(0, BOARD_N));
  }
  /*
   * ►► THE DESIGN CHECKER. ◄◄ "Maybe have an agent… that runs and checks if the flyers and thumbnails generated are
   * up to standard, so it is best always!" Two looks at every board before anyone picks from it:
   *   1. THE RULES, here, on every design: no words running off the page, no words on top of other words or over a
   *      face, nothing too small to read, no words that vanish into what is behind them, no face cut off at an
   *      edge. A design that breaks one is taken off the board (two at least always stay).
   *   2. THE ART DIRECTOR, on the server (cloudsee.judgeDesigns): the board on one sheet, beside the church's own
   *      flyer (the first on its inspiration board) marked STANDARD, scored 1–10 by the vision model the way a
   *      designer would. The best go first, and what it scores 5 or less comes off the board. Each card says its
   *      score. With no AI to ask, the rules alone decide.
   */
  const INFO_TEXT = /^(Venue|Phone|Handles|Date|Day|Time|When|Speakers|Speaker|With|Theme|Church)$/;
  // the words a design lays behind everything on purpose — a giant outline word, the day in script — are not read as words
  const decorWord = (l) => l.hidden || l.lock || l.fill === 'none' || /^(Script word|Watermark)/.test(l.name || '') || !String(l.text || '').trim() || (l.opacity != null && l.opacity < 0.5);
  const lumHex = (c) => { try { return lum(c); } catch (e) { return null; } };
  function inkOf(L) {
    const f = L.fill;
    if (typeof f === 'string') return METALS[f] ? METALS[f][2] : /^#[0-9a-f]{6}$/i.test(f) ? f : null;
    if (f && Array.isArray(f.stops) && typeof f.stops[0] === 'string' && /^#[0-9a-f]{6}$/i.test(f.stops[0])) return f.stops[0];
    return null;
  }
  function designFlaws(S) {
    const W = S.w, H = S.h, flaws = [];
    const texts = S.layers.filter((l) => l.type === 'text' && !decorWord(l) && !l.rot);
    const at = (l) => S.layers.indexOf(l), short = (t) => String(t).replace(/\s+/g, ' ').slice(0, 24);
    const area = (b) => Math.max(0, b.r - b.l) * Math.max(0, b.b - b.t);
    const meet = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));
    const bx = new Map(texts.map((l) => [l, box(l)]));
    for (const l of texts) {
      const b = bx.get(l), out = Math.max(0, -b.l) + Math.max(0, b.r - W) + Math.max(0, -b.t) + Math.max(0, b.b - H);
      if (out > Math.max(10, (b.r - b.l) * 0.04)) flaws.push(`“${short(l.text)}” runs off the page`);
      if (INFO_TEXT.test(l.name || '') && (l.size || 0) * (l.s || 1) * (1080 / W) < 15) flaws.push(`“${short(l.text)}” is too small to read`);
    }
    for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i], c = texts[j];
      if (/^Title/.test(a.name || '') && /^Title/.test(c.name || '')) continue;   // the lines of one title, set close on purpose
      const m = meet(bx.get(a), bx.get(c));
      if (m > 0.18 * Math.min(area(bx.get(a)), area(bx.get(c)))) flaws.push(`“${short(a.text)}” and “${short(c.text)}” overlap`);
    }
    for (const im of S.layers.filter((l) => l.type === 'image' && l.head && !l.hidden)) {
      const h = im.head;
      if (h.t < -4 || h.l < -4 || h.r > W + 4) flaws.push('a face is cut off at the edge');
      // words laid OVER a face (a title behind the minister is how the standard is set: that is not a flaw)
      for (const l of texts) if (at(l) > at(im) && meet(bx.get(l), h) > 0.12 * area(h)) flaws.push(`“${short(l.text)}” covers a face`);
    }
    return flaws;
  }
  /* words that vanish into what is behind them: the page drawn small without its words, the light behind each measured.
     The layers that do, by name: a title that does is a flaw; a small line (the church's name, a date) is mended */
  function contrastFlaws(S) { return lowContrast(S).filter((l) => /^Title/.test(l.name || '')).map((l) => `“${String(l.text).slice(0, 24)}” is hard to read on what is behind it`); }
  function lowContrast(S) {
    const flaws = [], k = 240 / S.w;
    try {
      const bare = Object.assign({}, S, { layers: S.layers.filter((l) => l.type !== 'text') });
      const cv = render(bare, canvas(1, 1), k), x = cv.getContext('2d', { willReadFrequently: true });
      for (const l of S.layers.filter((t) => t.type === 'text' && !decorWord(t))) {
        const ink = inkOf(l); if (!ink) continue;
        const b = box(l), x0 = clamp(Math.floor(b.l * k), 0, cv.width - 1), y0 = clamp(Math.floor(b.t * k), 0, cv.height - 1);
        const w = clamp(Math.ceil((b.r - b.l) * k), 1, cv.width - x0), h = clamp(Math.ceil((b.b - b.t) * k), 1, cv.height - y0);
        const d = x.getImageData(x0, y0, w, h).data;
        let sum = 0, n = 0;
        for (let i = 0; i < d.length; i += 16) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
        const bgL = n ? sum / n : 0.5, inkL = lumHex(ink); if (inkL == null) continue;
        const ratio = (Math.max(bgL, inkL) + 0.05) / (Math.min(bgL, inkL) + 0.05);
        // (a shadow, a glow or an outline carries words over a light of their own colour: only the worst are flagged)
        // (a title in big letters, a gradient or a metal, holds up better than its first colour says)
        const need = /^Title/.test(l.name || '') ? 1.35 : 1.6;
        if (ratio < (l.shadow || l.glow || l.stroke ? Math.min(need, 1.25) : need)) flaws.push(l);
      }
      cv.width = cv.height = 1;
    } catch (e) { /* (a picture another site sent cannot be read back: not judged by this) */ }
    return flaws;
  }
  const designKey = (d) => [d.look, ((d.layers || []).find((l) => l.type === 'bg') || {}).img || '', d.w + 'x' + d.h, F.tries, d.batch || 0].join('|');
  /* the board as the checks leave it: the flawed off it (two always stay), the art director's best first */
  function checkBoard() {
    const J = F.judge || (F.judge = { tries: -1, scores: new Map(), flaws: new Map(), busy: false, model: '', why: '' });
    if (J.tries !== F.tries) { J.tries = F.tries; J.scores = new Map(); J.flaws = new Map(); J.mend = new Map(); J.done = false; J.why = ''; }
    F.designs.forEach((d) => {
      const key = designKey(d);
      if (!J.flaws.has(key)) {
        const low = lowContrast(d);
        J.flaws.set(key, designFlaws(d).concat(low.filter((l) => /^Title/.test(l.name || '')).map((l) => `“${String(l.text).slice(0, 24)}” is hard to read on what is behind it`)));
        J.mend = J.mend || new Map(); J.mend.set(key, low.filter((l) => !/^Title/.test(l.name || '')).map((l) => l.name));
      }
      // a small line lost in what is behind it: black or white, whichever the page needs there (inkFor), with a shadow
      const mend = (J.mend && J.mend.get(key)) || [];
      if (mend.length) d.layers.forEach((l) => { if (l.type === 'text' && mend.includes(l.name)) Object.assign(l, { fill: '#ffffff', inkSet: false, shadow: true }); });
      d.flaws = J.flaws.get(key); d.score = J.scores.has(key) ? J.scores.get(key).score : null; d.issue = J.scores.has(key) ? J.scores.get(key).issue : '';
    });
    const ok = F.designs.filter((d) => !d.flaws.length && !(d.score != null && d.score <= 5));
    const keep = ok.length >= 2 ? ok : F.designs.slice().sort((a, b) => a.flaws.length - b.flaws.length || (b.score || 0) - (a.score || 0)).slice(0, Math.max(2, ok.length));
    F.hidden = F.designs.length - keep.length;
    F.removed = F.designs.filter((d) => !keep.includes(d)).map((d) => ({ look: d.look, flaws: d.flaws, score: d.score, issue: d.issue }));
    // the art director's order: the best first — the colour picked under the live preview stays first unless it scored low
    const first = F.mode !== 'thumb' && keep[0] && RADIANT_WAYS[keep[0].look] && keep[0].look === F.way && !(keep[0].score != null && keep[0].score < 7) ? keep[0] : null;
    // (best first within each batch the feed brought in: what was already scrolled past stays where it was)
    const rest = keep.filter((d) => d !== first).map((d, i) => [d, i]).sort((a, b) => ((a[0].batch || 0) - (b[0].batch || 0)) || ((b[0].score == null ? 6.5 : b[0].score) - (a[0].score == null ? 6.5 : a[0].score)) || a[1] - b[1]).map((x) => x[0]);
    F.designs = (first ? [first] : []).concat(rest);
  }
  let judgeT = 0;
  function judgeSoon() {
    clearTimeout(judgeT);
    const thumb = F.mode === 'thumb';
    // when the board has settled: the paintings in (a board of the standard and its family paints nothing), the preacher cut out
    const painted = thumb || F.designs.some((d) => !isRadiant(d.look));
    if ((painted && F.painting > 0) || (thumb && F.th.cutting) || !F.designs.length || !window.api.flyer.judge) return;
    judgeT = setTimeout(judgeBoard, 700);
  }
  async function judgeBoard() {
    const J = F.judge; if (!J || J.busy || F.step !== 'pick') return;
    const todo = F.designs.filter((d) => !J.scores.has(designKey(d))).slice(0, 12);
    if (!todo.length) return;
    const tryNo = F.tries;
    J.busy = true; if (F.step === 'pick') drawPick();
    try {
      // the church's own flyer, from its inspiration board, marked STANDARD on the sheet (flyers only)
      let std = null;
      const ins = F.mode !== 'thumb' && F.kit && (F.kit.inspo || [])[0];
      if (ins && ins.thumb) { try { std = await loadImg(/^data:/.test(ins.thumb) ? ins.thumb : await window.api.flyer.kitPic(ins.thumb)); } catch (e) { std = null; } }
      const sheet = designSheet(todo, std);
      const r = await window.api.flyer.judge({ image: sheet, count: todo.length, kind: F.mode === 'thumb' ? 'thumb' : 'flyer', standard: !!std });
      if (tryNo !== F.tries) return;
      if (r && r.ok) {
        (r.scores || []).forEach((x) => { const d = todo[x.n - 1]; if (d) J.scores.set(designKey(d), { score: x.score, issue: x.issue || '' }); });
        J.model = r.model || ''; J.why = '';
      } else J.why = (r && r.why) || 'no answer';
    } catch (e) { J.why = (e && e.message) || 'no answer'; }
    finally { J.busy = false; }
    J.done = true;
    if (F.step !== 'pick') return;
    if (F.mode === 'thumb') rebuildThumbs(); else rebuildDesigns();
    drawPick();
  }
  /* the board on one sheet for the art director: each design numbered in its top-left corner, the STANDARD first */
  function designSheet(list, std) {
    const S0 = list[0], wide = S0.w / S0.h > 1.2, cw = wide ? 320 : 240, ch = Math.round(cw * S0.h / S0.w), gap = 8;
    const cells = (std ? 1 : 0) + list.length, cols = Math.min(cells, wide ? 4 : 5), rows = Math.ceil(cells / cols);
    const c = canvas(cols * cw + (cols + 1) * gap, rows * ch + (rows + 1) * gap), x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    const tag = (cx, cy, text, fill) => {
      x.font = '800 22px Arial, sans-serif'; const w = x.measureText(text).width + 16;
      x.fillStyle = fill; x.fillRect(cx, cy, w, 32); x.fillStyle = fill === '#ffd60a' ? '#000000' : '#ffffff'; x.fillText(text, cx + 8, cy + 24);
    };
    let i = 0;
    const at = (k) => [gap + (k % cols) * (cw + gap), gap + Math.floor(k / cols) * (ch + gap)];
    if (std) {
      const [px, py] = at(i++), f = Math.min(cw / iw(std), ch / ih(std));
      x.fillStyle = '#eeeeee'; x.fillRect(px, py, cw, ch);
      x.drawImage(std, px + (cw - iw(std) * f) / 2, py + (ch - ih(std) * f) / 2, iw(std) * f, ih(std) * f);
      tag(px + 4, py + 4, 'STANDARD', '#ffd60a');
    }
    list.forEach((S, n) => {
      const [px, py] = at(i++), cv = render(S, canvas(1, 1), cw / S.w);
      x.drawImage(cv, px, py, cw, ch); cv.width = cv.height = 1;
      tag(px + 4, py + 4, String(n + 1), '#000000');
    });
    return c.toDataURL('image/jpeg', 0.82);
  }

  /* the light each look is built for (the reference it copies): Join us is purple, Upper Room is fire, the gold line-up gold… */
  const LOOK_TONE = { joinus: 'purple', miracle: 'purple', script: 'purple', didone: 'red', upper: 'red', breaking: 'red', fire: 'red', mountain: 'teal', scenic: 'teal',
    spirit: 'gold', bible: 'gold', prophetic: 'gold', sunday: 'gold', encounter: 'blue', theme: 'own', glory: 'own', lineup: 'blue', light: 'own',
    jericho: 'own', unique: 'gold', thanks: 'own', mantle: 'gold', urgency: 'red', harvest: 'gold' };
  function rebuildDesigns() {
    const sz = sizeOf();
    if (!F.board) newBoard();
    const all = F.board.order.slice(0, Math.max(0, F.board.shown - (F.paintedIn || []).length - (F.lettered ? 1 : 0)));
    const used = new Map(), n = (b) => used.get(b.key) || 0;
    F.designs = all.map((look, i) => {
      // the title's own idea (key art) on the best-ranked designs first; then this look's own light; then the least used
      const unused = (b) => n(b) < 1;
      const want = F.bgs.filter((b) => b.theme && unused(b))[0] || F.bgs.filter((b) => b.tone && b.tone === LOOK_TONE[look] && unused(b))[0];
      // (a plain page takes no painting: it is left for the looks that show one)
      const bg = SIMPLE.has(look) || isRadiant(look) ? null : want || (F.bgs.some((b) => b.tone) ? F.bgs.slice().sort((a, b) => n(a) - n(b))[0] : F.bgs[i % F.bgs.length]);
      if (bg) used.set(bg.key, n(bg) + 1);
      // the AI's colours on the first designs, each look's own on the rest — a board of different flyers, not one flyer ten times
      // a picture painted in its own light takes colours that match it; the AI's own on the rest
      const tp = bg && bg.tone && TONE_PAL[bg.tone];
      const v = F.board.variants[look];
      const pal = RADIANT_WAYS[look] ? RADIANT_WAYS[look].pal : STD_FAMILY.includes(look) ? (F.board.pals && F.board.pals[look]) || F.pal
        : tp ? (tp === 'own' ? F.pal : tp) : (i === 0 ? F.pal : v.pal || SIGNATURE[look] || F.pal);
      return Object.assign(buildScene({ look, w: sz.w, h: sz.h, pal, dir: F.dir, fields: F.fields, speakers: speakersFor(i), logo: IMGS.has('logo') ? 'logo' : null, bg: bg && bg.key, variant: v }), { madeBy: (bg && bg.by) || '', batch: Math.floor(i / BOARD_N) });
    });
    // the preacher painted into the scene (paintPreacherIn): first on the board, labelled so the face is checked
    const pin = (F.paintedIn || []).map((b) => Object.assign(buildScene({ look: b.look, painted: true, w: sz.w, h: sz.h, pal: F.pal, dir: F.dir, fields: F.fields, speakers: speakersFor(0), logo: IMGS.has('logo') ? 'logo' : null, bg: b.key, variant: F.board.variants[b.look] }), { label: 'AI scene · check the face', madeBy: b.by || '' }));
    // the AI-lettered title first of all: the one most like the flyers people save
    const lt = F.lettered ? [Object.assign(buildScene({ look: 'ailetter', w: sz.w, h: sz.h, pal: F.pal, dir: F.dir, fields: F.fields, speakers: speakersFor(0), logo: IMGS.has('logo') ? 'logo' : null, bg: F.lettered.key }),
      { label: F.lettered.checked ? 'AI lettering' : 'AI lettering · check the spelling', madeBy: F.lettered.by || '' })] : [];
    // the bright, simple designs first; the AI's painted extras after them
    const nPlain = F.designs.filter((d) => SIMPLE.has(d.look) || isRadiant(d.look)).length;
    F.designs = F.designs.slice(0, nPlain).concat(lt, pin, F.designs.slice(nPlain));
    checkBoard();
    if (F.step === 'pick') { paintThumbs(); judgeSoon(); }
  }

  /*
   * MORE DESIGNS, MORE PICTURES. "4 more designs" used to dress the same four
   * pictures again (one chain picture behind five flyers): each new design now
   * fetches its own from the church's library — free, never a fresh painting —
   * and swaps it in when it lands; the board's own pictures stand in meanwhile.
   */
  async function morePictures(n) {
    if (!(F.status && F.status.cloudflare) || !F.dir || !window.api.flyer.paint) return;
    const tryNo = F.tries, sz = sizeOf();
    const scenes = F.dir.scenes || [];
    const people = chosenSpeakers().some((s) => (s.photos || []).length);
    await Promise.all(Array.from({ length: n }, async (_, j) => {
      const tone = F.board.tones[(F.bgs.length + j) % F.board.tones.length] || TONES[0];
      try {
        const out = await window.api.flyer.paint({ scene: scenes[(BOARD_N + j) % Math.max(1, scenes.length)] || 'light', w: sz.w, h: sz.h, people, slot: BOARD_N + j, tone: tone.id, event: eventOf(), libraryOnly: true });
        if (tryNo !== F.tries || !out || !(out.file || out.dataUrl)) return;
        if (F.bgs.some((b) => b.file && b.file === out.file)) return;   // already on this board
        const key = 'lib:' + tryNo + ':' + (out.file || j);
        IMGS.set(key, await loadImg(picSrc(out)));
        if (tryNo !== F.tries) return;
        F.bgs = F.bgs.concat({ key, file: out.file, by: out.by + ' · library', tone: out.tone || tone.id, theme: !!out.themeArt });
        rebuildDesigns();
      } catch (e) { /* the board's own pictures stand */ }
    }));
  }

  /* "Made by Cloudflare" under a design whose picture Cloudflare's free AI painted (FLUX.2, Phoenix), the model named */
  function madeByTag(by) {
    if (!/cloudflare/i.test(by || '')) return '';
    const model = String(by).replace(/\s*·\s*Cloudflare.*$/i, '').trim(), lib = /library/i.test(by);
    // a picture from the church's library was painted for someone earlier and kept: new to this person, and free
    return `<em class="fs-by" title="${escAttr('Painted by ' + by.replace(/\s*·\s*library/i, '') + (lib ? ' for the church’s picture library' : ''))}"><b>☁</b> Made by Cloudflare AI${model || lib ? `<i>${esc([model, lib ? 'library' : ''].filter(Boolean).join(' · '))}</i>` : ''}</em>`;
  }
  /* what the checks did to the board, in a line over it */
  function judgeLine() {
    const J = F.judge, hid = F.hidden || 0;
    if (J && J.busy) return '<p class="fs-judge"><i class="fs-spin"></i> The AI art director is checking each design against your standard…</p>';
    if (J && J.done && !J.why) return `<p class="fs-judge ok">${ic('spark')}<span>Checked by the AI art director against your standard — the best first${hid ? ` · ${hid} not good enough ${hid === 1 ? 'was' : 'were'} taken off` : ''}.</span></p>`;
    if (hid) return `<p class="fs-judge">${hid} design${hid === 1 ? '' : 's'} with a flaw (words overlapping, cut off or hard to read) ${hid === 1 ? 'was' : 'were'} taken off.</p>`;
    return '';
  }
  function drawPick() {
    const P = F.panel; if (!P) return;
    P.setTitle('Pick one');
    P.el.classList.remove('fs-editing');
    const busy = !F.designs.length, thumb = F.mode === 'thumb';
    P.body.innerHTML = `<div class="fs-pick${thumb ? ' th-pick' : ''}">
      <p class="fs-status">${busy ? (thumb ? '<i class="fs-spin"></i> Getting the moment ready…' : 'The AI is reading your event…') : thumb && F.th.cutting ? '<i class="fs-spin"></i> Cutting the preacher out of the picture…' : F.painting > 0 ? `<i class="fs-spin"></i> Painting ${F.painting} picture${F.painting > 1 ? 's' : ''} with AI — they appear as they’re ready` : 'Tap one to edit every part of it'}</p>
      ${!busy && F.status && F.status.note ? `<p class="fs-allow">${esc(F.status.note)}</p>` : ''}
      ${busy ? '' : judgeLine()}
      <div class="fs-grid">${busy ? '<div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div><div class="fs-ph"></div>' : F.designs.map((d, i) => `<button type="button" class="fs-card" data-i="${i}"><canvas></canvas><span class="fs-card-row">${d.score != null ? `<em class="fs-score${d.score >= 8 ? ' hi' : ''}" title="${escAttr(d.issue || '')}">${ic('spark')}${esc(String(Math.round(d.score)))}/10</em>` : ''}<small>${esc(d.label || LOOK_NAMES[d.look] || d.look)}</small><span class="fs-card-zoom" data-view="${i}" role="button" aria-label="See it big">${ic('zoom')}</span></span>${madeByTag(d.madeBy)}</button>`).join('')}</div>
      ${busy ? '' : moreLeft() ? `<button type="button" class="fs-ghost fs-more" data-act="more">${ic('layout')}<span>${thumb ? 'More thumbnails' : `${BOARD_N} more designs`}</span></button>`
        : `<p class="fs-end">That’s every design${thumb ? '' : ' for now'} — tap <b>New pictures</b> for fresh ones.</p>`}
    </div>`;
    // one board at a time: "New pictures" waits until this one is painted (each tap used to start five more paintings)
    P.foot.innerHTML = `<button type="button" class="fs-ghost" data-act="back">${ic('back')}<span>${thumb ? 'Back' : 'Details'}</span></button><button type="button" class="fs-ghost" data-act="again"${F.painting > 0 || busy ? ' disabled' : ''}>${ic('refresh')}<span>New pictures</span></button>`;
    paintThumbs();
    if (!busy) judgeSoon();
    // ►► A FEED. ◄◄ "When I scroll down… it automatically clicks the 4 more thing, like a Facebook news feed": near
    // the foot of the board the next designs come in by themselves (the button stays, for a screen that never scrolls)
    P.body.onscroll = () => {
      const b = P.body;
      if (F.step !== 'pick' || !b.scrollTop || b.scrollTop + b.clientHeight < b.scrollHeight - 320) return;
      if (b.querySelector('[data-act="more"]')) showMore();
    };
    P.body.onclick = (e) => {
      if (e.target.closest('[data-act="more"]')) { showMore(); return; }
      const z = e.target.closest('[data-view]'); if (z) { const d = F.designs[+z.dataset.view]; if (d) viewFlyer(d); return; }
      const c = e.target.closest('.fs-card'); if (c) { const d = F.designs[+c.dataset.i]; if (!thumb) markLiked(d && d.look, 1); openEditor(d); }
    };
    P.foot.onclick = (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'back') { F.tries++; if (thumb) { F.step = 'tmake'; drawThumbMake(); } else { F.step = 'make'; drawMake(); } }
      if (b.dataset.act === 'again' && !(F.painting > 0) && !b.disabled) { if (thumb) makeThumbs(); else makeFlyers(); }
    };
  }
  /* the next designs on the board: four more flyers, or every thumbnail look again in other colours */
  const moreLeft = () => (F.mode === 'thumb' ? thRounds() < TH_ROUNDS : !!(F.board && F.board.shown < F.board.order.length));
  let moreAt = 0;
  function showMore() {
    // (one batch at a time: a fling to the foot does not bring in three)
    if (!moreLeft() || Date.now() - moreAt < 800) return;
    moreAt = Date.now();
    if (F.mode === 'thumb') { F.th.rounds = thRounds() + 1; F.th.roundsAt = F.tries; rebuildThumbs(); return; }
    const from = F.board.shown; F.board.shown = Math.min(F.board.order.length, from + BOARD_N);
    markSeen(F.board.order.slice(from, F.board.shown)); rebuildDesigns(); drawPick();
    morePictures(F.board.shown - from);
  }
  /*
   * ►► SEE IT BIG. ◄◄ "I should be able to zoom in to the flyers that were generated too, to see closer." The flyer
   * drawn sharp (its long side about three thousand pixels), over everything: two fingers pinch it bigger and move
   * it, a double tap zooms in and back out, a mouse wheel zooms round the pointer.
   */
  function viewFlyer(S) {
    if (!S) return;
    const k = Math.min(HD(S), 3000 / Math.max(S.w, S.h));
    const cv = render(S, canvas(1, 1), k);
    const el = document.createElement('div'); el.className = 'fs-viewer';
    el.innerHTML = `<div class="fs-viewer-pic"></div><button type="button" class="fs-viewer-x" aria-label="Close">${ic('close')}</button><small class="fs-viewer-hint">Pinch or double-tap to zoom</small>`;
    const box = el.firstElementChild;
    cv.className = 'fs-viewer-cv'; box.appendChild(cv);
    document.body.appendChild(el);
    const zm = zoomer(box, cv);
    const close = () => { el.remove(); cv.width = cv.height = 1; zm.stop(); };
    el.querySelector('.fs-viewer-x').onclick = close;
    return { close, zoom: zm.zoom };
  }
  /*
   * Pinch, pan and double-tap zoom for a canvas in a viewer box. `onSwipe(±1)`, when given, hears a sideways swipe
   * made at full size (zoomed in, the same finger pans instead). `reset()` after the canvas is redrawn at a new size.
   */
  function zoomer(box, cv, onSwipe) {
    let z = 1, tx = 0, ty = 0;
    const fit = () => { const r = box.getBoundingClientRect(); const f = Math.min(r.width / cv.width, r.height / cv.height); return { f, w: cv.width * f, h: cv.height * f, W: r.width, H: r.height }; };
    const clampPan = () => { const g = fit(); const mx = Math.max(0, (g.w * z - g.W) / 2), my = Math.max(0, (g.h * z - g.H) / 2); tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty)); };
    const show = () => { clampPan(); const g = fit(); cv.style.width = g.w + 'px'; cv.style.height = g.h + 'px'; cv.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`; };
    // zoom to z1 keeping the screen point (px, py) — from the box's middle — where it is
    const zoomTo = (z1, px, py) => { z1 = Math.max(1, Math.min(8, z1)); tx = px - (px - tx) * z1 / z; ty = py - (py - ty) * z1 / z; z = z1; show(); };
    const mid = (e) => { const r = box.getBoundingClientRect(); return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }; };
    const pts = new Map(); let pinch = null, drag = null, lastTap = 0;
    // a double tap: two quick taps that did not move (a finger landing after a pinch is not one)
    let tapped = false;
    box.addEventListener('pointerdown', (e) => {
      try { box.setPointerCapture(e.pointerId); } catch (e2) { /* (a pointer the browser no longer tracks) */ } pts.set(e.pointerId, mid(e));
      if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z, tx, ty, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }; drag = null; lastTap = 0; tapped = false; }
      else if (pts.size === 1) { drag = { x: e.clientX, y: e.clientY, tx, ty, at: Date.now(), moved: 0, dx: 0, dy: 0, z }; tapped = true; }
    });
    box.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, mid(e));
      if (pinch && pts.size >= 2) {
        const [a, b] = [...pts.values()], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const z1 = Math.max(1, Math.min(8, pinch.z * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
        // the point that was under the fingers stays under them, and follows them
        tx = m.x - (pinch.m.x - pinch.tx) * z1 / pinch.z; ty = m.y - (pinch.m.y - pinch.ty) * z1 / pinch.z; z = z1; show();
      } else if (drag) {
        drag.dx = e.clientX - drag.x; drag.dy = e.clientY - drag.y;
        drag.moved = Math.max(drag.moved, Math.hypot(drag.dx, drag.dy));
        if (z > 1) { tx = drag.tx + drag.dx; ty = drag.ty + drag.dy; show(); }
      }
    });
    const up = (e) => {
      const was = pts.get(e.pointerId); pts.delete(e.pointerId);
      if (!pts.size && drag && tapped && drag.moved < 10 && Date.now() - drag.at < 300) {
        const now = Date.now();
        if (now - lastTap < 320 && was) { if (z > 1.05) { z = 1; tx = ty = 0; show(); } else zoomTo(2.5, was.x, was.y); lastTap = 0; } else lastTap = now;
      } else if (!pts.size && drag && onSwipe && drag.z <= 1.05 && z <= 1.05 && Math.abs(drag.dx) > 60 && Math.abs(drag.dx) > 1.5 * Math.abs(drag.dy)) {
        onSwipe(drag.dx < 0 ? 1 : -1);
      }
      if (pts.size < 2) pinch = null; if (!pts.size) { drag = null; tapped = false; }
    };
    box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
    box.addEventListener('wheel', (e) => { e.preventDefault(); const p = mid(e); zoomTo(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), p.x, p.y); }, { passive: false });
    window.addEventListener('resize', show);
    requestAnimationFrame(show);
    return {
      zoom: () => z,
      reset: () => { z = 1; tx = ty = 0; show(); },
      stop: () => window.removeEventListener('resize', show),
    };
  }
  /*
   * ►► SEE A BANK PHOTO BIG. ◄◄ "I should be able to click the pictures to see them in a bigger view so I can check
   * how good the cutout was." The cut-out exactly as the bank keeps it, over everything and as big as the screen:
   * pinch or double-tap to look at the edges, swipe (or the arrows) for the speaker's other photos. Behind it: dark,
   * white or checks — a leftover edge shows on one when it hides on another — or the photo it was cut from, to
   * compare. Use takes it; Fix cut-out cuts it again from that photo (o.onFix) and the view comes back on the new one.
   */
  function viewBankPics(list, at, o) {
    list = (list || []).filter(Boolean); if (!list.length) return null;
    o = o || {};
    let i = Math.max(0, Math.min(list.length - 1, at | 0)), bg = 'dark', seq = 0;
    const cv = canvas(1, 1); cv.className = 'fs-viewer-cv';
    const el = document.createElement('div'); el.className = 'fs-viewer fs-vb';
    el.innerHTML = `<div class="fs-viewer-pic"></div><div class="fs-vb-top"><b></b><small></small></div>
      <button type="button" class="fs-viewer-x" aria-label="Close">${ic('close')}</button>
      ${list.length > 1 ? `<button type="button" class="fs-vb-nav fs-vb-prev" data-vb="prev" aria-label="Previous photo">${ic('back')}</button><button type="button" class="fs-vb-nav fs-vb-next" data-vb="next" aria-label="Next photo">${ic('back')}</button>` : ''}
      <div class="fs-vb-bar"><small class="fs-vb-hint">Pinch or double-tap to zoom${list.length > 1 ? ' · swipe for the next' : ''}</small><div class="fs-vb-bgs"></div><div class="fs-vb-acts"></div></div>`;
    const box = el.firstElementChild;
    box.appendChild(cv);
    document.body.appendChild(el);
    const zm = zoomer(box, cv, (d) => go(d));
    const BGS = [['dark', 'Dark'], ['light', 'Light'], ['checks', 'Checks'], ['orig', 'Original']];
    function bar() {
      const p = list[i], used = !!(o.used && o.used(p));
      el.querySelector('.fs-vb-top b').textContent = o.name || 'Photo bank';
      el.querySelector('.fs-vb-top small').textContent = list.length > 1 ? `${i + 1} of ${list.length}` : '';
      el.querySelector('.fs-vb-bgs').innerHTML = BGS.filter(([k]) => k !== 'orig' || ORIG.has(p))
        .map(([k, t]) => `<button type="button" class="fs-vb-bg${bg === k ? ' on' : ''}" data-bg="${k}">${t}</button>`).join('');
      el.querySelector('.fs-vb-acts').innerHTML = (o.onFix ? `<button type="button" class="fs-vb-btn" data-vb="fix">${ic('cut')}Fix cut-out</button>` : '')
        + (!o.onUse ? '' : used ? `<button type="button" class="fs-vb-btn" data-vb="unuse">Don’t use it</button><span class="fs-vb-on">✓ On the thumbnail</span>`
          : `<button type="button" class="fs-vb-btn fs-vb-use" data-vb="use">Use this photo</button>`);
    }
    async function paint() {
      const n = ++seq, p = list[i];
      if (bg === 'orig' && !ORIG.has(p)) bg = 'dark';
      bar();
      el.classList.add('fs-vb-wait');
      let im = null;
      try {
        if (bg === 'orig') { const or = ORIG.get(p); im = await loadImg(/^data:/.test(or) ? or : await window.api.flyer.kitPic(or)); }
        else { await bankPic(p); im = await loadImg(PICURL.get(p) || p); }
      } catch (e) { im = null; }
      if (n !== seq) return;   // another photo was asked for meanwhile
      el.classList.remove('fs-vb-wait');
      if (!im) { toast('That photo could not be opened.', 'error'); return; }
      // sharp enough to zoom into, small enough for a phone (its long side 2400 pixels at most)
      const f = Math.min(1, 2400 / Math.max(iw(im), ih(im)));
      cv.width = Math.max(1, Math.round(iw(im) * f)); cv.height = Math.max(1, Math.round(ih(im) * f));
      const g = cv.getContext('2d');
      if (bg === 'light') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height); }
      else if (bg === 'dark') { g.fillStyle = '#231a3a'; g.fillRect(0, 0, cv.width, cv.height); }
      else if (bg === 'checks') {
        const q = Math.max(8, Math.round(Math.max(cv.width, cv.height) / 48));
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, cv.width, cv.height); g.fillStyle = '#d4d7de';
        for (let y = 0; y * q < cv.height; y++) for (let x = (y % 2); x * q < cv.width; x += 2) g.fillRect(x * q, y * q, q, q);
      }
      g.drawImage(im, 0, 0, cv.width, cv.height);
      zm.reset();
    }
    const go = (d) => { if (list.length < 2) return; i = (i + d + list.length) % list.length; paint(); };
    const close = () => { el.remove(); cv.width = cv.height = 1; zm.stop(); seq++; };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-vb],[data-bg],.fs-viewer-x'); if (!b) return;
      if (b.classList.contains('fs-viewer-x')) return close();
      if (b.dataset.bg) { bg = b.dataset.bg; return paint(); }
      const a = b.dataset.vb, p = list[i];
      if (a === 'prev') return go(-1);
      if (a === 'next') return go(1);
      if (a === 'use') { close(); return o.onUse(p); }
      if (a === 'unuse') { if (o.onUnuse) o.onUnuse(p); return bar(); }
      if (a === 'fix') { close(); return o.onFix(p, i); }
    });
    paint();
    return { close, zoom: zm.zoom, at: () => i, bg: () => bg };
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

  /* ============================================================ THUMBNAILS */
  /*
   * ►► THE YOUTUBE THUMBNAIL STUDIO (Home → Thumbnails, or "Thumbnail" on any
   * video in My Uploads). ◄◄ The same studio as the flyers — the board of
   * designs, then every layer to tap, drag and change — made from a VIDEO:
   *
   *   1. the video: the server looks through it and offers its best moments of
   *      the preacher (thumbmaker.frames), or any moment scrubbed to, or a photo;
   *   2. the words: the server listens to the sermon and an AI writes the lines
   *      a church channel would put on it (thumbmaker.ideas) — or type your own,
   *      and tap the word that should be in colour;
   *   3. Make: the preacher is cut out of that moment on this phone, the free AI
   *      paints backgrounds while the board is already up (the frame itself
   *      stands in), six YouTube looks. Save gives a 1920×1080 JPEG under 2 MB
   *      — what YouTube Studio takes for a custom thumbnail.
   */
  const TH = { w: 1280, h: 720 };
  const TH_PALS = [
    { deep: '#0b1020', mid: '#1d3a8a', accent: '#ffd60a', hi: '#ffffff' },
    { deep: '#0c0905', mid: '#3d2a0e', accent: '#f5c542', hi: '#ffffff' },
    { deep: '#14040a', mid: '#7a0f1f', accent: '#ff3b30', hi: '#ffffff' },
    { deep: '#03161a', mid: '#0e5c66', accent: '#2ee6d6', hi: '#ffffff' },
    { deep: '#12061f', mid: '#4c1d95', accent: '#ffb020', hi: '#ffffff' },
    { deep: '#08130a', mid: '#14532d', accent: '#a3ff47', hi: '#ffffff' },
  ];
  const fieldsNow = () => (F.mode === 'thumb' ? { title: F.th.line, key: F.th.key, preacher: String(F.th.preacher || '').trim(), kicker: String(F.th.kicker || '').trim(),
    when: String(F.th.when || '').trim(), church: F.th.showChurch && F.kit ? F.kit.church || '' : '' } : F.fields);
  /* the preacher on the thumbnail: a bank photo keeps its speaker (so "Their photos" in the editor swaps it), a cut-out from the video is nobody's */
  const thumbSpeakers = () => (F.th.person ? [{ id: F.th.bank ? F.th.bankSp || '' : '', name: '', img: F.th.person, photo: F.th.bank || '' }] : []);
  const logoNow = () => (F.mode === 'thumb' && !F.th.showChurch ? null : IMGS.has('logo') ? 'logo' : null);
  /* the preacher and whether the church signs it come back next time (the same on most of a church's videos) */
  const TH_KEEP = 'mw-thumb-extra';
  function keepExtras() { try { localStorage.setItem(TH_KEEP, JSON.stringify({ preacher: F.th.preacher || '', showChurch: !!F.th.showChurch })); } catch (e) { /* private window */ } }
  function loadExtras() { try { return JSON.parse(localStorage.getItem(TH_KEEP) || 'null'); } catch (e) { return null; } }
  const fmtT = (s) => { s = Math.max(0, Math.round(+s || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const baseName = (p) => String(p || '').split(/[\\/]/).pop().replace(/\.[a-z0-9]+$/i, '');

  async function openThumb(opts) {
    opts = opts || {};
    F.mode = 'thumb';
    // opened from New post: the editor's "Use" hands the finished thumbnail back to that post
    F.th.onUse = typeof opts.onUse === 'function' ? opts.onUse : null;
    F.panel = C.openPanel({ id: 'cloudFlyer', title: 'Thumbnails', cls: 'cp-flyer cp-thumb', full: true, onClose: () => { F.panel = null; F.mode = 'flyer'; F.th.onUse = null; } });
    loadFonts();
    if (!F.status) window.api.flyer.status().then((st) => { F.status = st; }).catch(() => {});
    F.step = 'tmake';
    if (!F.th.extrasRead) {
      F.th.extrasRead = true;
      const ex = loadExtras();
      if (ex) { F.th.preacher = ex.preacher || ''; F.th.showChurch = ex.showChurch !== false; } else F.th.showChurch = true;
    }
    // the church's name, logo and preachers (the flyers' kit): the thumbnail is signed with them
    if (!F.kit) loadKit().then(() => { if (F.step === 'tmake' && F.mode === 'thumb') drawThumbMake(); }).catch(() => {});
    if (opts.video && opts.video !== F.th.video) setThumbVideo(opts.video);
    draw();
  }

  /* a video chosen: its best moments and the words for it, both asked for at once */
  function setThumbVideo(p) {
    const t = F.th;
    Object.assign(t, { video: p, photo: null, frames: [], pick: 0, custom: null, dur: 0, err: '', ideas: null, scrub: false, line: '', key: '', typed: false });
    const ask = ++t.ask;
    t.loadingFrames = true; t.loadingIdeas = true;
    window.api.thumb.frames(p, 6).then((r) => {
      if (ask !== t.ask) return;
      t.frames = (r && r.frames) || []; t.dur = (r && r.dur) || 0; t.by = (r && r.by) || '';
    }).catch((e) => { if (ask === t.ask) t.err = (e && e.message) || 'Could not read that video.'; })
      .finally(() => { if (ask === t.ask) { t.loadingFrames = false; if (F.step === 'tmake') drawThumbMake(); } });
    window.api.thumb.ideas(p, '').then((r) => {
      if (ask !== t.ask || !r) return;
      t.ideas = r;
      // the AI's first line is on it already (the operator only changes it if they want)
      if (!t.typed && r.lines && r.lines[0]) { t.line = r.lines[0].text; t.key = r.lines[0].key; }
    }).catch(() => {}).finally(() => { if (ask === t.ask) { t.loadingIdeas = false; if (F.step === 'tmake') drawThumbMake(); } });
  }

  function thumbPickSrc() {
    const t = F.th;
    // a photo from the bank: the preacher already cut out; the video's moment (if there is one) goes behind them
    if (t.bank) return { bank: t.bank, bgFrom: t.custom || t.frames[t.pick] || null };
    if (t.photo) return { url: t.photo, photo: true };
    if (t.custom) return t.custom;
    return t.frames[t.pick] || t.frames[0] || null;
  }

  /*
   * ►► SEE IT AS YOU TYPE. ◄◄ (Option A, as for the flyers.) The thumbnail drawn at the top of the page in the look
   * picked under it — the moment chosen, the preacher on it, the words as typed — and drawn again a moment after
   * each change; a strip of every look under it, small, each drawn the same way. The preacher is cut out of the
   * moment as soon as it is chosen (the same cut-out Make does), so they are on the preview before Make; until then
   * the moment and the words are. Tapped, the preview opens big.
   */
  const TH_LOOK_ORDER = ['ytbold', 'ytglow', 'ytlight', 'ytfire', 'ytserif', 'ytscript', 'ytpanel', 'ytword', 'ytmono', 'ytstage', 'ytoutline', 'ytcinema'];
  const TH_PAINTED = new Set(['ytglow', 'ytlight', 'ytfire', 'ytserif', 'ytscript', 'ytpanel', 'ytword', 'ytstage']);
  const LIVECUT = new Map();   // a moment's picture -> { key } the preacher cut out of it ('' nobody; null still cutting)
  let thLiveN = 0, thLiveT = 0, thLooksN = 0, thLooksT = 0, thLiveLast = null;
  function liveCut(url) {
    if (!LIVECUT.has(url)) {
      const job = { key: null };
      LIVECUT.set(url, job);
      cutPreacher(url, 'live' + LIVECUT.size).then((k) => { job.key = k || ''; if (F.step === 'tmake' && F.mode === 'thumb') thPaint(); });
    }
    return LIVECUT.get(url);
  }
  // the looks that can be made from what is chosen (Cinematic is the video's own frame: none without one)
  const thLooks = () => { const src = thumbPickSrc(), fr = src && (src.bank ? src.bgFrom : src); return TH_LOOK_ORDER.filter((l) => l !== 'ytcinema' || !!(fr && fr.url)); };
  const thLook = () => (thLooks().includes(F.th.look) ? F.th.look : thLooks()[0]);
  async function thLiveParts() {
    const t = F.th, src = thumbPickSrc(); if (!src) return null;
    const fr = src.bank ? src.bgFrom : src;
    let frameKey = null;
    if (fr && fr.url) {
      frameKey = 'thlf:' + fr.url;
      if (!IMGS.has(frameKey)) { try { IMGS.set(frameKey, await loadImg(fr.url)); } catch (e) { frameKey = null; } }
    }
    let person = '', cutting = false;
    if (src.bank) person = (await bankPic(src.bank)) ? picKey(src.bank) : '';
    else if (fr && fr.url) { const job = liveCut(fr.url); person = job.key || ''; cutting = job.key === null; }
    return { frameKey, person, cutting, face: (!src.bank && fr && fr.face) || null, bank: t.bank || '', bankSp: t.bankSp || '' };
  }
  function thSceneOf(look, parts) {
    const t = F.th, pal = THUMB_PAL[look] || TH_PALS[0];
    // a look that shows a painting behind the preacher: a picture of light in its colours until Make paints one
    let bg = null;
    if (!parts.frameKey || TH_PAINTED.has(look)) { bg = 'thlpr:' + look; if (!IMGS.has(bg)) IMGS.set(bg, proceduralBg(TH.w, TH.h, pal, 7)); }
    const fields = Object.assign({}, fieldsNow(), { title: String(t.line || '').trim() || 'YOUR WORDS HERE' });
    return buildScene({ look, w: TH.w, h: TH.h, pal, dir: {}, fields, speakers: parts.person ? [{ id: parts.bank ? parts.bankSp : '', name: '', img: parts.person, photo: parts.bank }] : [],
      logo: logoNow(), bg, frame: parts.frameKey, face: parts.face });
  }
  async function thLiveScene(look) { await loadFonts(); const parts = await thLiveParts(); return parts ? thSceneOf(look, parts) : null; }
  function thDraw(cv, S, cssW) {
    const out = render(S, canvas(1, 1), Math.max(120, Math.round((cv.clientWidth || cssW) * (window.devicePixelRatio || 1))) / S.w);
    cv.width = out.width; cv.height = out.height; cv.getContext('2d').drawImage(out, 0, 0);
    return out;
  }
  async function thPaintLive() {
    const P = F.panel, cv = P && $('.th-live-cv', P.body); if (!cv) return;
    const n = ++thLiveN;
    if (thLiveLast && !cv.dataset.p) { cv.width = thLiveLast.width; cv.height = thLiveLast.height; cv.getContext('2d').drawImage(thLiveLast, 0, 0); }
    cv.dataset.p = '1';
    await loadFonts();
    const parts = await thLiveParts();
    if (n !== thLiveN || !cv.isConnected || !parts) return;
    thLiveLast = thDraw(cv, thSceneOf(thLook(), parts), 358);
    const tag = $('.th-live-tag', P.body);
    if (tag) tag.innerHTML = parts.cutting ? '<i class="fs-spin"></i>Cutting out the preacher…' : '<i></i>LIVE';
  }
  // every look, small (one at a time, giving the page room between them)
  async function thPaintLooks() {
    const P = F.panel; if (!P || !$('[data-lookcv]', P.body)) return;
    const n = ++thLooksN;
    await loadFonts();
    const parts = await thLiveParts();
    if (!parts) return;
    for (const cv of $$('[data-lookcv]', P.body)) {
      if (n !== thLooksN || !cv.isConnected) return;
      thDraw(cv, thSceneOf(cv.dataset.lookcv, parts), 72);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  function thPaint() { thPaintLive(); clearTimeout(thLooksT); thLooksT = setTimeout(thPaintLooks, 60); }
  function thLiveSoon() {
    clearTimeout(thLiveT); thLiveT = setTimeout(thPaintLive, 150);
    clearTimeout(thLooksT); thLooksT = setTimeout(thPaintLooks, 600);
  }

  function drawThumbMake() {
    const P = F.panel; if (!P) return;
    if (typingIn(P.body)) {
      if (!F._redraw) { F._redraw = true; P.body.addEventListener('focusout', () => setTimeout(() => { F._redraw = false; if (F.step === 'tmake' && !typingIn(F.panel && F.panel.body)) drawThumbMake(); }, 60), { once: true }); }
      return;
    }
    const t = F.th, src = thumbPickSrc();
    P.setTitle('Thumbnails');
    P.el.classList.remove('fs-editing');
    const tiles = t.loadingFrames ? '<div class="th-fr th-ph"><i class="fs-spin"></i></div>'.repeat(4)
      : t.frames.map((f, i) => `<button type="button" class="th-fr${!t.bank && !t.photo && !t.custom && t.pick === i ? ' on' : ''}${t.bank && t.pick === i && !t.custom ? ' th-behind' : ''}" data-fr="${i}"><img src="${escAttr(f.url)}" alt=""><small>${esc(fmtT(f.t))}</small>${i === 0 && t.by === 'ai' ? '<em>AI pick</em>' : ''}</button>`).join('');
    const custom = t.custom ? `<button type="button" class="th-fr ${t.bank ? 'th-behind' : 'on'}" data-act="scrub"><img src="${escAttr(t.custom.url)}" alt=""><small>${esc(fmtT(t.custom.t))}</small></button>` : '';
    const photo = t.photo ? `<button type="button" class="th-fr on" data-act="photo"><img src="${escAttr(t.photo)}" alt=""><small>Your photo</small></button>` : '';
    const words = String(t.line || '').toUpperCase().split(/\s+/).filter(Boolean);
    const lines = (t.ideas && t.ideas.lines) || [];
    const k = F.kit || {};
    const vidPic = (t.custom || t.frames[t.pick] || t.frames[0] || {}).url || '';
    const sps = k.speakers || [];
    const bsp = sps.find((x) => x.id === t.bankSp) || sps.find((x) => x.name && x.name === t.preacher) || sps[0] || null;
    const kitNames = (k.speakers || []).map((x) => String(x.name || '').trim()).filter(Boolean).slice(0, 8);
    const kickers = Array.from(new Set(['Sunday Service'].concat((k.services || []).map((x) => x.name).filter(Boolean), ['Part 2', 'Live', 'Full Sermon']))).slice(0, 8);
    const churchLine = k.church ? k.church + (IMGS.has('logo') ? ' · with the logo' : '') : 'Set your church’s name and logo once in Flyers → My church';
    P.body.innerHTML = `
      <div class="fs-make th-make fs-a">
        <div class="fs-a-top th-a-top">
          ${src ? `<button type="button" class="th-live" data-act="livebig" aria-label="See this thumbnail big"><canvas class="th-live-cv"></canvas><span class="fs-live-tag th-live-tag"><i></i>LIVE</span></button>
          <div class="th-looks">${thLooks().map((l) => `<button type="button" class="th-look${l === thLook() ? ' on' : ''}" data-look="${l}" aria-label="${escAttr(LOOK_NAMES[l] || l)}"><canvas data-lookcv="${l}"></canvas></button>`).join('')}</div>
          <small class="th-looks-tip">${esc(LOOK_NAMES[thLook()] || '')} · tap a look · it changes as you type</small>`
            : `<button type="button" class="th-livechoose" data-act="vid">${ic('photo')}<b>Choose a video</b><small>a sermon, a short — anything you made or uploaded</small></button>`}
        </div>
        <div class="fs-a-sheet">
        ${t.video ? `<button type="button" class="th-vid" data-act="vid">${vidPic ? `<img src="${escAttr(vidPic)}" alt="">` : `<span class="th-vid-ph">${ic('photo')}</span>`}<span><b>${esc(baseName(t.video))}</b><small>${t.dur ? esc(fmtT(t.dur)) + ' · ' : ''}tap to choose another video</small></span>${ic('back').replace('fs-ic', 'fs-ic fs-chev')}</button>` : ''}
        <section class="fs-asec fs-form">
          <h4>Words on it <small>3 to 5 big words work best</small></h4>
          <label class="fs-box th-linebox"><input data-th="line" value="${escAttr(t.line)}" maxlength="40" placeholder="GOD IS NOT DONE WITH YOU" ${TXT('characters')}></label>
          ${words.length > 1 ? `<div class="th-keys"><small>The word in colour:</small>${words.map((w) => `<button type="button" class="th-key${w.replace(/[^\w’']/g, '') === String(t.key || '').toUpperCase().replace(/[^\w’']/g, '') ? ' on' : ''}" data-key="${escAttr(w)}">${esc(w)}</button>`).join('')}</div>` : ''}
          <div class="th-ideas">${t.loadingIdeas && t.video ? '<p class="th-listening"><i class="fs-spin"></i> Listening to the sermon for ideas…</p>'
            : lines.map((l) => `<button type="button" class="th-idea${l.text === String(t.line || '').toUpperCase() ? ' on' : ''}" data-idea="${escAttr(l.text)}" data-ikey="${escAttr(l.key)}">${esc(l.text)}</button>`).join('')}</div>
          ${t.ideas && !t.loadingIdeas ? `<p class="fs-note">${t.ideas.by === 'rules' ? (t.ideas.heard ? 'Ideas from what was said in the sermon.' : 'A few strong lines to start from — or type your own.') : 'Written by AI from what was preached' + (t.ideas.heard ? '' : ' (no speech could be heard, so these are general)') + '.'}</p>` : ''}
        </section>
        ${t.video || t.photo ? `<section class="fs-asec">
          <h4>The moment <small>${t.loadingFrames ? 'looking through the video…' : 'the best shots of the preacher, best first'}</small></h4>
          ${t.err ? `<p class="fs-note th-err">${esc(t.err)}</p>` : ''}
          <div class="th-frames">${photo}${custom}${tiles}
            ${t.video ? `<button type="button" class="th-fr th-tool" data-act="scrub">${ic('layout')}<small>Pick a moment</small></button>` : ''}
            <button type="button" class="th-fr th-tool" data-act="photo">${ic('photo')}<small>Use a photo</small></button>
          </div>
          ${t.scrub && t.video ? `<div class="th-scrub"><div class="th-scrub-pic">${t.scrubUrl ? `<img src="${escAttr(t.scrubUrl)}" alt="">` : '<i class="fs-spin"></i>'}</div>
            <input type="range" min="0" max="${Math.max(1, Math.floor(t.dur || 1))}" step="0.5" value="${t.scrubT || 0}" data-th="scrub" aria-label="Moment in the video">
            <div class="th-scrub-row"><span data-th="scrubT">${esc(fmtT(t.scrubT || 0))}</span><button type="button" class="fs-go th-use" data-act="usemoment">Use this moment</button></div></div>` : ''}
        </section>` : ''}
        <section class="fs-asec th-banksec">
          <h4>Photo bank <small>your preachers’ photos, already cut out</small></h4>
          <div class="th-chips">${sps.map((x) => `<button type="button" class="th-chip${bsp && x.id === bsp.id ? ' on' : ''}" data-banksp="${escAttr(x.id)}">${esc(x.name || 'Speaker')} <i>${(x.photos || []).length}</i></button>`).join('')}<button type="button" class="th-chip th-chip-add" data-act="banknew">＋ New preacher</button></div>
          ${bsp ? `<div class="th-frames th-bank">${(bsp.photos || []).map((ph) => `<button type="button" class="th-fr th-bp${t.bank === ph ? ' on' : ''}" data-bank="${escAttr(ph)}" aria-label="See this photo big">${picTag(ph)}<i class="th-bp-zoom">${ic('zoom')}</i></button>`).join('')}<button type="button" class="th-fr th-bp th-tool" data-act="bankadd">${ic('plus')}<small>Add photos</small></button></div>
            <p class="fs-note">${t.bank ? (t.video ? 'Their photo goes on it, the video’s moment behind them (marked).' : 'Their photo goes on it, with a picture behind them.') + ' Tap a moment above to use the video instead.' : 'Tap a photo to see it big and check its cut-out — then Use this photo.'}</p>`
            : '<p class="fs-note">Add your preachers once — each photo is cut out and kept for every flyer and thumbnail.</p>'}
        </section>
        <section class="fs-asec fs-form th-extra">
          <h4>Also on it <small>all optional</small></h4>
          <label class="fs-f fs-wide"><span>Preacher</span><input data-th="preacher" value="${escAttr(t.preacher || '')}" placeholder="Pastor John Doe" ${TXT('words')}></label>
          ${kitNames.length ? `<div class="th-chips">${kitNames.map((n) => `<button type="button" class="th-chip${n === t.preacher ? ' on' : ''}" data-preacher="${escAttr(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
          <label class="fs-f fs-wide"><span>Small line <i>(series, service, part)</i></span><input data-th="kicker" value="${escAttr(t.kicker || '')}" placeholder="SUNDAY SERVICE · PART 2" ${TXT('characters')}></label>
          <div class="th-chips">${kickers.map((n) => `<button type="button" class="th-chip${n === t.kicker ? ' on' : ''}" data-kicker="${escAttr(n)}">${esc(n)}</button>`).join('')}</div>
          <label class="fs-f fs-wide"><span>Date or time <i>(in a pill)</i></span><input data-th="when" value="${escAttr(t.when || '')}" placeholder="SUN 19 OCT · 10AM" ${TXT('characters')}></label>
          <label class="th-switch"><input type="checkbox" data-th="church"${t.showChurch ? ' checked' : ''}><span><b>Church name & logo</b><small>${esc(churchLine)}</small></span></label>
        </section>
        </div>
      </div>`;
    P.foot.innerHTML = `<button type="button" class="fs-go" data-act="tmake"${src && String(t.line || '').trim() ? '' : ' disabled'}>${ic('spark')}<span>Make thumbnails</span></button>`;
    fillPics(P.body);
    thPaint();
    wireThumbMake();
  }

  let scrubTimer = 0;
  function wireThumbMake() {
    const P = F.panel, t = F.th;
    const line = $('[data-th="line"]', P.body);
    if (line) {
      line.addEventListener('input', () => {
        t.line = line.value; t.typed = true;
        const ws = line.value.toUpperCase().split(/\s+/).filter(Boolean);
        if (!ws.some((w) => w.replace(/[^\w’']/g, '') === String(t.key || '').toUpperCase().replace(/[^\w’']/g, ''))) t.key = ws.slice().sort((a, b) => b.length - a.length)[0] || '';
        const go = $('[data-act="tmake"]', P.foot); if (go) go.disabled = !(thumbPickSrc() && line.value.trim());
        thLiveSoon();
      });
      line.addEventListener('change', () => drawThumbMake());
      line.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); line.blur(); } });
    }
    [['preacher', 'preacher'], ['kicker', 'kicker'], ['when', 'when']].forEach(([f, k]) => {
      const el = $(`[data-th="${f}"]`, P.body); if (!el) return;
      el.addEventListener('input', () => { t[k] = el.value; if (k === 'preacher') keepExtras(); thLiveSoon(); });
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    });
    const ch = $('[data-th="church"]', P.body);
    if (ch) ch.addEventListener('change', () => { t.showChurch = ch.checked; keepExtras(); thLiveSoon(); });
    const sl = $('[data-th="scrub"]', P.body);
    if (sl) {
      sl.addEventListener('input', () => {
        t.scrubT = +sl.value;
        const lab = $('[data-th="scrubT"]', P.body); if (lab) lab.textContent = fmtT(t.scrubT);
        clearTimeout(scrubTimer);
        scrubTimer = setTimeout(async () => {
          const at = t.scrubT;
          try {
            const r = await window.api.thumb.frameAt(t.video, at, 640);
            if (at !== t.scrubT || !F.panel) return;
            t.scrubUrl = r.url;
            const box = $('.th-scrub-pic', F.panel.body); if (box) box.innerHTML = `<img src="${escAttr(r.url)}" alt="">`;
          } catch (e) { /* the last picture stays */ }
        }, 220);
      });
    }
    function viewThumbBank(ph) {
      const sp = ((F.kit && F.kit.speakers) || []).find((x) => (x.photos || []).includes(ph));
      if (!sp) return;
      const use = (p) => { t.bank = p; t.bankSp = sp.id; if (!t.preacher) { t.preacher = sp.name || ''; keepExtras(); } drawThumbMake(); };
      viewBankPics(sp.photos, sp.photos.indexOf(ph), {
        name: sp.name || 'Speaker',
        used: (p) => t.bank === p,
        onUse: use,
        onUnuse: () => { t.bank = null; drawThumbMake(); },
        // cut again, kept in the bank (My church too), and looked at again straight away
        onFix: (p, j) => recutPhoto(sp, j, async (kept) => {
          if (t.bank === p) t.bank = kept;
          await saveKit(true);
          drawThumbMake();
          viewThumbBank(kept);
        }),
      });
    }
    P.body.onclick = async (e) => {
      const lk = e.target.closest('[data-look]');
      if (lk) {
        t.look = lk.dataset.look;
        try { localStorage.setItem('mw-thumb-look', t.look); } catch (er) { /* private window */ }
        $$('[data-look]', P.body).forEach((x) => x.classList.toggle('on', x === lk));
        const tip = $('.th-looks-tip', P.body); if (tip) tip.textContent = (LOOK_NAMES[t.look] || '') + ' · tap a look · it changes as you type';
        return thPaintLive();
      }
      const b = e.target.closest('[data-act],[data-fr],[data-key],[data-idea],[data-preacher],[data-kicker],[data-banksp],[data-bank]'); if (!b) return;
      if (b.dataset.act === 'livebig') { const S = await thLiveScene(thLook()); if (S) viewFlyer(S); return; }
      if (b.dataset.banksp) { t.bankSp = b.dataset.banksp; return drawThumbMake(); }
      // a bank photo opens big — to see how good its cut-out is — and is taken from there with Use
      if (b.dataset.bank) return viewThumbBank(b.dataset.bank);
      if (b.dataset.preacher != null) { t.preacher = t.preacher === b.dataset.preacher ? '' : b.dataset.preacher; keepExtras(); return drawThumbMake(); }
      if (b.dataset.kicker != null) { t.kicker = t.kicker === b.dataset.kicker ? '' : b.dataset.kicker; return drawThumbMake(); }
      if (b.dataset.fr != null) { t.pick = +b.dataset.fr; t.custom = null; t.photo = null; t.bank = null; return drawThumbMake(); }
      if (b.dataset.key) { t.key = b.dataset.key; return drawThumbMake(); }
      if (b.dataset.idea) { t.line = b.dataset.idea; t.key = b.dataset.ikey || ''; t.typed = true; return drawThumbMake(); }
      const a = b.dataset.act;
      if (a === 'vid') {
        let p = null;
        try { p = await window.api.dialog.openFile([{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }]); } catch (er) { p = null; }
        if (Array.isArray(p)) p = p[0];
        if (p && typeof p === 'string') { setThumbVideo(p); drawThumbMake(); }
        return;
      }
      if (a === 'photo') return pickImage((url) => { t.photo = url; t.custom = null; t.bank = null; drawThumbMake(); }, { max: 1920 });
      // the photo banks are the flyers' own (My church): added here, they are there too
      if (a === 'bankadd') {
        const sp = ((F.kit && F.kit.speakers) || []).find((x) => x.id === t.bankSp) || ((F.kit && F.kit.speakers) || [])[0];
        if (sp) addPhotos(sp, async () => { await saveKit(true); t.bankSp = sp.id; drawThumbMake(); });
        return;
      }
      if (a === 'banknew') {
        if (!F.kit) await loadKit();
        const name = (window.prompt('The preacher’s name, as it should be on thumbnails (e.g. Pastor John Doe):') || '').trim();
        if (!name) return;
        const sp = { id: 'sp' + Date.now().toString(36), name, photos: [] };
        addPhotos(sp, async () => {
          F.kit.speakers = (F.kit.speakers || []).concat(sp);
          await saveKit(true); await loadKit();
          t.bankSp = sp.id; if (!t.preacher) { t.preacher = name; keepExtras(); }
          drawThumbMake();
        });
        return;
      }
      if (a === 'scrub') {
        t.scrub = !t.scrub;
        if (t.scrub && t.scrubT == null) t.scrubT = Math.round((t.frames[t.pick] && t.frames[t.pick].t) || (t.dur || 0) / 2);
        drawThumbMake();
        if (t.scrub) { const s2 = $('[data-th="scrub"]', F.panel.body); if (s2) s2.dispatchEvent(new Event('input')); }
        return;
      }
      if (a === 'usemoment') {
        try {
          const r = await window.api.thumb.frameAt(t.video, t.scrubT || 0, 1280);
          t.custom = { t: r.t, url: r.url, face: null }; t.photo = null; t.scrub = false; t.bank = null;
        } catch (er) { toast('That moment could not be read: ' + (er.message || er), 'error'); }
        return drawThumbMake();
      }
    };
    P.foot.onclick = (e) => { const b = e.target.closest('[data-act="tmake"]'); if (b && !b.disabled) makeThumbs(); };
  }

  /* the preacher cut out of the picture, on this phone (the flyers' cut-out): a key into IMGS, or '' when nobody is in it */
  async function cutPreacher(src, tryNo) {
    if (!root.FlyerAI || !root.FlyerAI.removePerson) return '';
    try {
      const r = await root.FlyerAI.removePerson(src);
      if (!r || !(r.coverage > 0.015)) return '';
      const png = await tidyCut(r.src).catch(() => r.src);
      const pr = await preparePerson(await loadImg(png));
      const key = 'thp:' + tryNo;
      IMGS.set(key, pr.img); if (pr.meta) META.set(key, pr.meta);
      return key;
    } catch (e) { return ''; }
  }

  async function makeThumbs() {
    const t = F.th, src = thumbPickSrc();
    if (!src || !String(t.line || '').trim()) return;
    F.tries++;
    const tryNo = F.tries;
    // a bank photo: the preacher already cut out, the video's moment (when there is one) only behind them
    const fr = src.bank ? src.bgFrom : src;
    Object.assign(t, { bgs: [], person: '', frameKey: '', face: (!src.bank && fr && fr.face) || null, painting: 0, cutting: true });
    F.step = 'pick'; F.designs = []; F.painting = 0;
    drawPick();
    await loadFonts();
    // the moment, sharp (the board showed a smaller copy)
    let full = fr ? fr.url : null;
    if (fr && !fr.photo && t.video && fr.t != null) { try { full = (await window.api.thumb.frameAt(t.video, fr.t, 1920)).url; } catch (e) { full = fr.url; } }
    if (tryNo !== F.tries) return;
    const fk = 'thf:' + tryNo;
    if (full) {
      try { IMGS.set(fk, await loadImg(full)); t.frameKey = fk; } catch (e) { if (!src.bank) { toast('That picture could not be opened.', 'error'); F.step = 'tmake'; return drawThumbMake(); } }
    }
    // the words decide the pictures and the colours (the flyers' art director), the sermon's own ideas first
    const ideaScenes = (t.ideas && t.ideas.scenes) || [];
    let dir = null;
    try { dir = await window.api.flyer.direct({ title: t.line, theme: (t.ideas && t.ideas.title) || '', kind: 'sermon', notes: ideaScenes.join('; ') }); } catch (e) { dir = null; }
    if (tryNo !== F.tries) return;
    const pp = (dir && dir.palette) || [];
    t.pal = pp.length === 4 ? { deep: pp[0], mid: pp[1], accent: pp[2], hi: pp[3] } : TH_PALS[0];
    // a thumbnail's accent must shout: a dull one from the director is swapped for yellow
    if (lum(t.pal.accent) < 0.45) t.pal = Object.assign({}, t.pal, { accent: '#ffd60a' });
    t.palOrder = shuffled(TH_PALS);
    F.dir = Object.assign({}, dir || {}, { scenes: ideaScenes.concat((dir && dir.scenes) || []).slice(0, 6) });
    if (!F.dir.scenes.length) F.dir.scenes = ['golden light rays breaking through dark storm clouds, photograph'];
    // the app's own photographs stand in until the AI's paintings come
    const stock = await Promise.all(((dir && dir.photos) || []).slice(0, 2).map(async (n) => {
      try { const key = 'stock:' + n; if (!IMGS.has(key)) IMGS.set(key, await loadImg('/flyerphotos/' + encodeURIComponent(n))); return { key, by: 'photo', proc: true }; } catch (e) { return null; }
    }));
    t.bgs = stock.filter(Boolean);
    // the board goes up straight away with the frame — and the preacher cut out for the live preview already on it,
    // when there is one; the sharp cut from the full-size moment takes its place a moment later
    const early = !src.bank && fr && fr.url && LIVECUT.has(fr.url) ? LIVECUT.get(fr.url).key || '' : '';
    if (early) t.person = early;
    rebuildThumbs();
    t.person = src.bank ? ((await bankPic(src.bank)) ? picKey(src.bank) : '') : (await cutPreacher(full, tryNo)) || early;
    t.cutting = false;
    if (tryNo !== F.tries) return;
    rebuildThumbs();
    // three AI pictures behind the preacher, each swapped in as it lands
    const scenes = F.dir.scenes.slice(0, 3);
    F.painting = scenes.length;
    if (F.step === 'pick') drawPick();
    await Promise.all(scenes.map(async (scene, i) => {
      try {
        const out = await window.api.flyer.paint({ scene, w: TH.w, h: TH.h, seed: Math.floor(Math.random() * 1e9), people: true, slot: i, tone: 'own', event: { title: String(t.line).slice(0, 80), theme: '', kind: 'sermon' } });
        if (tryNo !== F.tries) return;
        let im = await loadImg(picSrc(out));
        if (/pollinations/i.test(out.by || '')) im = cropBottom(im, 0.06);
        const key = 'tha:' + tryNo + ':' + i;
        IMGS.set(key, im);
        t.bgs = t.bgs.filter((b) => !b.proc).concat({ key, by: out.by || '' }, t.bgs.filter((b) => b.proc)).slice(0, 4);
        rebuildThumbs();
      } catch (e) { /* the frame and the photographs stand in */ }
      finally { if (tryNo === F.tries) { F.painting--; if (F.step === 'pick') drawPick(); } }
    }));
  }

  /* the board: twelve YouTube looks, the preacher and the words on each, the painted pictures shared out */
  /* how many rounds of the thumbnail looks the feed has brought in (one until the board is scrolled to its end) */
  const TH_ROUNDS = 3;
  const thRounds = () => (F.th.roundsAt === F.tries ? F.th.rounds || 1 : 1);
  function rebuildThumbs() {
    const t = F.th;
    const order = t.person
      ? ['ytbold', 'ytglow', 'ytlight', 'ytfire', 'ytserif', 'ytscript', 'ytpanel', 'ytword', 'ytmono', 'ytstage', 'ytoutline', 'ytcinema']
      : ['ytcinema', 'ytstage', 'ytserif', 'ytscript', 'ytlight', 'ytbold', 'ytword', 'ytpanel', 'ytfire', 'ytglow', 'ytoutline', 'ytmono'];
    // no video frame (a bank photo, no video): every look gets a picture, and the frame-only Cinematic is left out
    const painted = new Set(t.frameKey ? ['ytglow', 'ytlight', 'ytfire', 'ytserif', 'ytscript', 'ytpanel', 'ytword', 'ytstage'] : THUMB_LOOKS);
    if (!t.frameKey) order.splice(order.indexOf('ytcinema'), 1);
    // (the look picked under the live preview leads, in the colours it was seen in; the AI's colours go on the next)
    const lead = t.look && order.includes(t.look) ? t.look : null;
    if (lead) { order.splice(order.indexOf(lead), 1); order.unshift(lead); }
    const ai = t.bgs.filter((b) => !b.proc), stock = t.bgs.filter((b) => b.proc);
    let n = 0;
    F.designs = [];
    // the feed's rounds (thRounds): each round after the first is every look again in another look's colours
    // (5 places on, never its own), on the next of the AI's pictures
    for (let r = 0; r < thRounds(); r++) order.forEach((look, i) => {
      const pal = r ? THUMB_PAL[order[(i + r * 5) % order.length]] || t.pal
        : lead && i === 0 ? THUMB_PAL[look] || t.pal : i === (lead ? 1 : 0) && t.pal ? t.pal : THUMB_PAL[look] || t.pal;
      let bg = null;
      if (painted.has(look)) {
        bg = ai.length ? ai[n % ai.length] : stock.length && n < stock.length ? stock[n] : null;
        n++;
        // nothing painted yet: a picture of light in this look's own colours, made here
        if (!bg) { const key = 'thpr:' + look + ':' + F.tries + (r ? ':' + r : ''); if (!IMGS.has(key)) IMGS.set(key, proceduralBg(TH.w, TH.h, pal, F.tries * 31 + i * 7 + r * 101)); bg = { key, by: '' }; }
      }
      F.designs.push(Object.assign(buildScene({ look, w: TH.w, h: TH.h, pal, dir: F.dir || {}, fields: fieldsNow(), speakers: thumbSpeakers(),
        logo: logoNow(), bg: bg ? bg.key : null, frame: t.frameKey, face: t.face }), { madeBy: (bg && bg.by) || '', batch: r }));
    });
    checkBoard();
    if (F.step === 'pick') { drawPick(); judgeSoon(); }
  }

  /* the thumbnail as YouTube takes it: 1920×1080 JPEG, under 2 MB */
  async function thumbBlob() {
    const S = F.scene, k = 1920 / S.w;
    const cv = render(S, canvas(1, 1), k);
    try {
      for (const q of [0.92, 0.86, 0.8, 0.72, 0.62]) {
        const b = await new Promise((res) => cv.toBlob(res, 'image/jpeg', q));
        if (b && b.size < 1.95 * 1048576) return b;
      }
      const small = canvas(1280, 720); small.getContext('2d').drawImage(cv, 0, 0, 1280, 720);
      return await new Promise((res) => small.toBlob(res, 'image/jpeg', 0.85));
    } finally { cv.width = cv.height = 1; }
  }
  const thumbName = () => `${(String(F.th.line || '').replace(/[^\w' ]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Thumbnail').slice(0, 60)} thumbnail.jpg`;
  /* "Keep": the thumbnail in My Uploads, beside the video (for the scheduler, or another phone) */
  async function keepThumb(btn) {
    btn.disabled = true;
    const use = F.th.onUse;
    const label = btn.querySelector('span'); const was = label.textContent; label.textContent = use ? 'Adding…' : 'Keeping…';
    try {
      const blob = await thumbBlob();
      const p = await C.uploadFile(new File([blob], thumbName(), { type: 'image/jpeg' }));
      if (!p || typeof p !== 'string') throw new Error('it did not reach the studio');
      // from New post: the thumbnail goes on the post, and the studio closes back to it
      if (use) { F.th.onUse = null; use(p); if (F.panel) F.panel.close(); toast('Thumbnail added to the post.', 'good'); return; }
      toast('Kept in My Uploads.', 'good');
    } catch (e) { toast('Could not keep it: ' + (e.message || e), 'error'); }
    finally { btn.disabled = false; label.textContent = was; }
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
        <button type="button" class="fs-tb" data-ed="view" aria-label="See it big">${ic('zoom')}</button>
        <button type="button" class="fs-tb" data-ed="undo" aria-label="Undo" disabled>${ic('undo')}</button>
        <button type="button" class="fs-tb" data-ed="redo" aria-label="Redo" disabled>${ic('redo')}</button>
        <button type="button" class="fs-tb fs-save" data-ed="save">${ic('save')}<span>Save</span></button>
        <button type="button" class="fs-tb fs-post" data-ed="post">${F.mode === 'thumb' ? (F.th.onUse ? ic('send') + '<span>Use</span>' : ic('photo') + '<span>Keep</span>') : ic('send') + '<span>Post</span>'}</button>
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
      if (a === 'view') return viewFlyer(F.scene);
      if (a === 'undo' && F.undo.length) { F.redo.push(clone(F.scene)); F.scene = F.undo.pop(); fixSel(); paint(); tools(); syncUndo(); }
      if (a === 'redo' && F.redo.length) { F.undo.push(clone(F.scene)); F.scene = F.redo.pop(); fixSel(); paint(); tools(); syncUndo(); }
      if (a === 'save') saveFlyer(b);
      if (a === 'post') { if (F.mode === 'thumb') keepThumb(b); else postFlyer(b); }
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
      html = F.mode === 'thumb'
        ? btn('words', 'words', 'Words') + btn('looks', 'layout', 'Layouts') + btn('colours', 'palette', 'Colours') + btn('bgnew', 'spark', 'New picture') + btn('bgframe', 'photo', 'Video frame')
          + btn('bgphone', 'bg', 'Background') + btn('bgadjust', 'sun', 'Adjust') + btn('addtext', 'text', 'Text') + btn('addphoto', 'photo', 'Photo')
        : btn('addtext', 'text', 'Text') + btn('addphoto', 'photo', 'Photo') + btn('bgnew', 'spark', 'New picture') + btn('bgphone', 'bg', 'Background')
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
      case 'words': if (F.mode === 'thumb') { F.step = 'tmake'; return drawThumbMake(); } F.step = 'make'; return drawMake();
      case 'bgframe': if (F.scene.frame && IMGS.has(F.scene.frame)) change(() => { const b = ls.find((l) => l.type === 'bg'); if (b) { b.img = F.scene.frame; b.blur = 2; } }); return;
      case 'size': return sheetSizes();
      case 'edit': return editText();
      case 'font': return sheetFonts();
      case 'colour': return sheetColour(L);
      case 'effects': return sheetEffects(L);
      case 'spacing': return sliders([['Letters', 'letter', -0.05, 0.8, 0.01], ['Lines', 'line', 0.7, 1.6, 0.02], ['Size', 's', 0.2, 3, 0.02], ['Turn', 'rot', -180, 180, 1]], L);
      case 'opacity': return sliders([['Opacity', 'opacity', 0.05, 1, 0.01]], L);
      case 'imglook': return sliders(L.inFrame
        ? [['Zoom', 'zoom', 0.7, 2, 0.01], ['Brightness', 'bright', -60, 60], ['Contrast', 'contrast', -50, 80], ['Colour', 'sat', -100, 100]]   // in a frame: closer or further, the frame stays
        : [['Length', 'len', 0.4, 1.6, 0.01], ['Brightness', 'bright', -60, 60], ['Contrast', 'contrast', -50, 80], ['Colour', 'sat', -100, 100], ['Round corners', 'radius', 0, 300]], L);
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
      const v = L[k] == null ? (k === 'opacity' || k === 's' || k === 'crop' || k === 'zoom' ? 1 : k === 'line' ? 1 : k === 'tint' ? 0.45 : k === 'vignette' ? 0.75 : 0) : L[k];
      return `<label class="fs-slider"><span>${esc(label)}</span><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step || 1}" value="${v}"><output>${Math.round(v * (step && step < 1 ? 100 : 1))}</output></label>`;
    }).join(''), (sh) => {
      $$('input[type=range]', sh).forEach((r) => r.addEventListener('input', () => {
        L[r.dataset.k] = +r.value;
        if (r.dataset.k === 'zoom' && L._src0) {   // the face stays where it is in the frame
          const s0 = L._src0, z = +r.value, w = s0.w / z, h = s0.h / z;
          L.src = { x: s0.x + (s0.w - w) / 2, y: s0.y + (s0.h - h) * 0.3, w, h };
        }
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
    const html = (isText ? `<h4>Fill</h4><div class="fs-row">${FILLS.map(([n, v]) => `<button type="button" class="fs-chip${(v && L.fill === v) ? ' on' : ''}" data-metal="${v || ''}">${n}</button>`).join('')}<button type="button" class="fs-chip${L.imgFill && !String(L.imgFill).startsWith('tex:') ? ' on' : ''}" data-photo-fill="1">Picture inside</button></div>`
      + `<h4>Material</h4><div class="fs-row">${MATERIALS.map(([n, v]) => `<button type="button" class="fs-chip${L.imgFill === 'tex:' + v ? ' on' : ''}" data-tex="${v}">${n}</button>`).join('')}</div>` : '')
      + swatchRow(typeof L.fill === 'string' ? L.fill : '', 'col')
      + (isText ? `<h4>Gradient</h4><div class="fs-row">${[[F.scene.pal.hi, F.scene.pal.accent], ['#ffffff', '#9ad7ff'], ['#fff3c4', '#ff9d00'], ['#ffd1f7', '#ff2fd6'], ['#ffffff', F.scene.pal.mid]].map((g) => `<button type="button" class="fs-grad" data-grad="${g.join(',')}" style="background:linear-gradient(180deg,${g[0]},${g[1]})"></button>`).join('')}</div>` : '');
    openSheet(html, (sh) => {
      sh.addEventListener('click', (e) => {
        const b = e.target.closest('[data-col],[data-metal],[data-grad],[data-photo-fill],[data-tex]'); if (!b) return;
        if (b.dataset.tex) { L.inkSet = true; L.fill = '#ffffff'; L.imgFill = 'tex:' + b.dataset.tex; L.imgFillA = 1; L.bevel = Math.max(L.bevel || 0, 0.9); paint(); return; }
        L.inkSet = true;   // chosen by hand: drawn as chosen (inkFor)
        if (b.dataset.col) { L.fill = b.dataset.col; L.imgFill = ''; }
        if (b.dataset.metal != null) { L.fill = b.dataset.metal || '#ffffff'; L.imgFill = ''; L.grain = !!b.dataset.metal; }
        if (b.dataset.grad) { L.fill = { stops: b.dataset.grad.split(','), angle: 90 }; L.imgFill = ''; }
        if (b.dataset.photoFill) { const bg = F.scene.layers.find((l) => l.type === 'bg'); L.imgFill = L.imgFill ? '' : (bg && bg.img) || ''; L.fill = '#ffffff'; }
        paint();
      });
      const pick = $('input[type=color]', sh);
      if (pick) pick.addEventListener('input', () => { L.fill = pick.value; L.imgFill = ''; L.inkSet = true; paint(); });
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
    const S = buildScene(Object.assign({ look: F.scene.look, w: sz.w, h: sz.h, pal: F.scene.pal, dir: F.dir, fields: fieldsNow(), speakers: sp, logo: logoNow(), bg: bg && bg.img, frame: F.scene.frame, face: F.scene.face }, o));
    snapshot();
    F.scene = S; F.sel = null; paint(); tools();
  }
  /* the speakers as this flyer has them now (a photo swapped in the editor stays swapped) */
  function sceneSpeakers() {
    const base = F.mode === 'thumb' ? thumbSpeakers() : speakersFor(0);
    return base.map((s) => {
      const L = F.scene && F.scene.layers.find((l) => l.speaker === s.id && l.photo);
      // (a frame shows the photo itself: the cut-out of it for a look that cuts them out)
      return L ? Object.assign(s, { photo: L.photo, img: /^kr:/.test(L.img) ? picKey(L.photo) : L.img, raw: IMGS.has(rawKey(L.photo)) ? rawKey(L.photo) : '' }) : s;
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
    const looks = F.mode === 'thumb' ? THUMB_LOOKS : Object.keys(LAYOUTS).filter((k) => !RADIANT_WAYS[k]);   // (a colour of Radiant is Radiant here)
    openSheet(`<div class="fs-looks${F.mode === 'thumb' ? ' th-looks' : ''}">${looks.map((k) => `<button type="button" class="fs-look${F.scene.look === k ? ' on' : ''}" data-look="${k}"><canvas></canvas><small>${esc(LOOK_NAMES[k])}</small></button>`).join('')}</div>`, (sh) => {
      const bg = F.scene.layers.find((l) => l.type === 'bg');
      const sp = sceneSpeakers();
      $$('.fs-look', sh).forEach((b) => {
        const S = buildScene({ look: b.dataset.look, w: F.scene.w, h: F.scene.h, pal: F.scene.pal, dir: F.dir, fields: fieldsNow(), speakers: sp, logo: logoNow(), bg: bg && bg.img, frame: F.scene.frame, face: F.scene.face });
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
    if (L.inFrame) {   // in a frame (an arch, a circle): the frame stays, the new photo framed in it the same way
      L.img = o.photo && IMGS.has(rawKey(o.photo)) && /^k[pd]:/.test(o.img) ? rawKey(o.photo) : o.img; if (o.photo) L.photo = o.photo; delete L.crop;
      delete L.len; delete L._src0; delete L.zoom;
      L.src = root.MWFlyer.framedSrc(L.img, L.w, L.h, L.inFrame);
      return;
    }
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
   * ►► MANY PHOTOS BEING CUT OUT — WHERE IT IS, ALWAYS IN VIEW. ◄◄ "I selected 11 pictures… the loading bar
   * disappears… it's shocking." A toast said it, faded between photos, and its number went backwards (each photo's
   * own progress started again). Now every photo picked has a tile in the speaker's row at once (My church) — waiting,
   * its own bar while it is cut out, then the cut-out — and one bar is pinned to the top of the screen until the last
   * is done: the whole lot's progress, that only ever goes forward, wherever the studio is.
   */
  const CUTS = new WeakMap();   // speaker -> { name, items: [{ thumb, pct, state: 'wait'|'cut'|'done'|'fail', png }], shown }
  let cutBar = null;
  const cutJobs = new Set();
  function cutWhole(job) {
    const sum = job.items.reduce((a, it) => a + (it.state === 'done' || it.state === 'fail' ? 1 : it.state === 'cut' ? it.pct : 0), 0);
    job.shown = Math.max(job.shown || 0, Math.min(100, Math.floor(sum / job.items.length * 100)));
    return job.shown;
  }
  function cutTilesHtml(sp) {
    const job = CUTS.get(sp); if (!job) return '';
    return job.items.map((it, k) => it.state === 'done' ? '' : `<div class="fs-bank-cell fs-cut-tile ${it.state}" data-cut="${k}">
      <div class="fs-bank-pic"><img src="${escAttr(it.thumb)}" alt=""></div>
      <div class="fs-cut-tile-info"><b>${it.state === 'fail' ? 'Could not cut out' : it.state === 'cut' ? Math.round(it.pct * 100) + '%' : 'Waiting'}</b><span class="fs-cut-tile-bar"><i style="width:${it.state === 'fail' ? 100 : Math.round(it.pct * 100)}%"></i></span></div></div>`).join('');
  }
  function paintCuts(sp) {
    const job = CUTS.get(sp); if (!job) return;
    const all = cutWhole(job), done = job.items.filter((it) => it.state === 'done' || it.state === 'fail').length;
    // the tiles in the speaker's row, if My church is open
    job.items.forEach((it, k) => {
      document.querySelectorAll(`[data-cutfor="${job.key}"] [data-cut="${k}"]`).forEach((el) => {
        el.className = 'fs-bank-cell fs-cut-tile ' + it.state;
        const b = el.querySelector('b'); if (b) b.textContent = it.state === 'fail' ? 'Could not cut out' : it.state === 'cut' ? Math.round(it.pct * 100) + '%' : 'Waiting';
        const bar = el.querySelector('.fs-cut-tile-bar i'); if (bar) bar.style.width = (it.state === 'fail' ? 100 : Math.round(it.pct * 100)) + '%';
      });
    });
    // the bar pinned to the top: every speaker's photos being cut out
    if (!cutBar) { cutBar = document.createElement('div'); cutBar.className = 'fs-cutbar'; cutBar.setAttribute('role', 'status'); document.body.appendChild(cutBar); }
    const jobs = [...cutJobs];
    const total = jobs.reduce((a, j) => a + j.items.length, 0), finished = jobs.reduce((a, j) => a + j.items.filter((it) => it.state === 'done' || it.state === 'fail').length, 0);
    const pct = jobs.length === 1 ? all : Math.floor(jobs.reduce((a, j) => a + cutWhole(j) * j.items.length, 0) / Math.max(1, total));
    cutBar.innerHTML = `<div class="fs-cutbar-top"><span>Cutting out photos${jobs.length === 1 ? ' of <b>' + esc(job.name || 'this speaker') + '</b>' : ''}</span><b class="fs-cutbar-n">${pct}%</b></div>
      <div class="fs-cutbar-bar"><i style="width:${pct}%"></i></div><small>${Math.min(total, finished + 1)} of ${total} · keep the studio open — each takes about half a minute</small>`;
    if (done === job.items.length) { /* (this speaker's lot is finished: its bar goes when every lot has) */ }
  }
  function endCuts(sp) {
    const job = CUTS.get(sp); if (job) cutJobs.delete(job);
    CUTS.delete(sp);
    if (!cutJobs.size && cutBar) { cutBar.remove(); cutBar = null; }
  }

  // a question with a few answers, over everything (the cut-out editor included); resolves with the answer's key, '' for none
  function askChoice(title, options) {
    return new Promise((resolve) => {
      const el = document.createElement('div'); el.className = 'fs-choice';
      el.innerHTML = `<div class="fs-choice-box" role="dialog" aria-label="${escAttr(title)}"><h3>${esc(title)}</h3>
        ${options.map((o) => `<button type="button" class="fs-choice-opt${o.on ? ' on' : ''}" data-w="${escAttr(o.key)}"><b>${esc(o.label)}</b>${o.note ? `<small>${esc(o.note)}</small>` : ''}</button>`).join('')}
        <button type="button" class="fs-choice-x" data-w="">Cancel</button></div>`;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-w]');
        if (!b && e.target !== el) return;
        el.remove(); resolve(b ? b.dataset.w : '');
      });
      document.body.appendChild(el);
    });
  }

  /*
   * ADD TO A BANK. "The cut-out should not be automatic — I should have the option." Asked each time (the last
   * answer first): the AI cuts them all out (in the background — a tile each and a bar), or each opens in turn in the
   * cut-out editor, the AI's cut first, to be fixed and kept with "Use this".
   */
  function addPhotos(s, then, { redraw } = {}) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = async () => {
      const files = Array.from(inp.files || []).slice(0, 30); if (!files.length) return;
      let last = 'auto'; try { last = localStorage.getItem('mw.flyer.cutway') || 'auto'; } catch (e) { /* none kept */ }
      const many = files.length > 1;
      const way = await askChoice(`${files.length} photo${many ? 's' : ''} of ${s.name || 'this speaker'} — how should ${many ? 'they' : 'it'} be cut out?`, [
        { key: 'auto', on: last === 'auto', label: `Cut ${many ? 'them' : 'it'} out for me`, note: `The AI does ${many ? 'each one' : 'it'}, about half a minute each. Tap any photo later to fix its cut-out.` },
        { key: 'check', on: last === 'check', label: many ? 'Let me check each one' : 'Let me check it', note: 'Opens in the cut-out editor: the AI’s cut first, then you fix it and tap “Use this”.' },
      ]);
      if (!way) return;
      try { localStorage.setItem('mw.flyer.cutway', way); } catch (e) { /* not kept */ }
      if (way === 'check') {
        let added = 0;
        for (let k = 0; k < files.length; k++) {
          const url = await shrinkToDataUrl(files[k], 1800);
          const m = document.getElementById('cutModal'); if (m) m.style.zIndex = '2000';
          let png = await new Promise((res) => {
            if (!window.CutOut || !window.FlyerAI) { toast('The cut-out tool is not available here.', 'error'); return res(null); }
            window.CutOut.open(url, (p) => res(p), { title: many ? `Photo ${k + 1} of ${files.length}` : undefined, onCancel: () => res(null) });
          });
          if (m) m.style.zIndex = '';
          if (!png) {
            if (k === files.length - 1) break;
            const w = await askChoice(`Photo ${k + 1} was not kept.`, [{ key: 'next', on: true, label: `Go on to photo ${k + 2} of ${files.length}` }, { key: 'stop', label: 'Stop here' }]);
            if (w !== 'next') break;
            continue;
          }
          png = await tidyCut(png).catch(() => png);
          let kept = png;
          try { kept = await window.api.flyer.kitAddPhoto(s.id, png, s.name, url); PICURL.set(kept, png); ORIG.set(kept, url); } catch (e) { /* the next Save sends it */ }
          s.photos = (s.photos || []).concat(kept); added++;
          if (redraw) await redraw();
        }
        if (many) toast(`${added} of ${files.length} photos added to ${s.name || 'the bank'}.`, added ? 'good' : '', 6000);
        return then();
      }
      // every photo has its tile at once; the bar is pinned until the last is done
      const job = { key: uid(), name: s.name, items: files.map((f) => ({ thumb: URL.createObjectURL(f), pct: 0, state: 'wait' })), shown: 0 };
      CUTS.set(s, job); cutJobs.add(job);
      if (redraw) await redraw(); paintCuts(s);
      let added = 0;
      for (let k = 0; k < files.length; k++) {
        const it = job.items[k];
        it.state = 'cut'; paintCuts(s);
        // (each photo's own progress only goes forward: the server's answers can step back as its stages change)
        const prog = (p) => { if (p > it.pct) { it.pct = Math.min(0.99, p); paintCuts(s); } };
        try {
          const url = await shrinkToDataUrl(files[k], 1800);
          let png = url, cut = false;
          try { png = await tidyCut((await window.FlyerAI.removePerson(url, prog)).src); cut = true; } catch (e) { /* kept as it is */ }
          // each one kept on the server as soon as it is cut out (a speaker not yet saved is made as it goes)
          let kept = png;
          // (the photo it was cut from goes with it: the framed looks show that, nothing cut out)
          try { kept = await window.api.flyer.kitAddPhoto(s.id, png, s.name, url); PICURL.set(kept, png); ORIG.set(kept, url); } catch (e) { /* the next Save sends it */ }
          s.photos = (s.photos || []).concat(kept);
          it.state = cut ? 'done' : 'fail'; added++;
        } catch (e) { it.state = 'fail'; }
        try { URL.revokeObjectURL(it.thumb); } catch (e) { /* gone */ }
        // the cut-out takes its tile's place in the row as soon as it is done
        if (redraw) await redraw();
        paintCuts(s);
      }
      endCuts(s);
      toast(`${added} of ${files.length} photos added to ${s.name || 'the bank'}. Tap one in My church to fix its cut-out.`, added === files.length ? 'good' : '', 8000);
      await then();
    };
    if (C && C.openPicker) C.openPicker(inp); else inp.click();
  }

  async function repaintBackground() {
    const bg = F.scene.layers.find((l) => l.type === 'bg'); if (!bg) return;
    const scenes = (F.dir && F.dir.scenes) || ['heavenly golden light rays through dramatic clouds'];
    toast('Painting a new picture with AI…', '', 4000);
    try {
      const out = await window.api.flyer.paint({ scene: scenes[Math.floor(Math.random() * scenes.length)], w: F.scene.w, h: F.scene.h, seed: Math.floor(Math.random() * 1e9), people: F.mode === 'thumb' || chosenSpeakers().some((s) => (s.photos || []).length) });
      const im = await loadImg(picSrc(out)); const key = 'ai:' + uid(); IMGS.set(key, im);
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
    if (C && C.openPicker) C.openPicker(inp); else inp.click();
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
  /*
   * Cut a bank photo out again — from the PHOTO it was cut from when the bank kept it: a fresh cut of the real
   * picture, not a cut of the cut. The new one is kept on the server at once with its photo (so a later fix starts
   * from the photo again) and takes the old one's place in sp.photos; after(kept) says what is there now.
   */
  async function recutPhoto(sp, j, after) {
    const p = sp.photos[j], o = ORIG.get(p);
    await bankPic(p);
    let from = PICURL.get(p) || p, orig = '';
    if (o) { try { orig = /^data:/.test(o) ? o : await window.api.flyer.kitPic(o); from = orig; } catch (e) { orig = ''; } }
    return cutOutUrl(from, async (png) => {
      png = await tidyCut(png).catch(() => png);
      let kept = png;
      if (orig && sp.id) { try { kept = await window.api.flyer.kitAddPhoto(sp.id, png, sp.name, orig); PICURL.set(kept, png); ORIG.set(kept, orig); } catch (e) { kept = png; } }
      sp.photos[j] = kept;
      after(kept);
    });
  }
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
    const thumb = F.mode === 'thumb';
    if (!thumb) { noteUsed(); markLiked(F.scene && F.scene.look, 3); }
    btn.disabled = true;
    try {
      const blob = thumb ? await thumbBlob() : await flyerBlob();
      const file = new File([blob], thumb ? thumbName() : fileName(), { type: 'image/jpeg' });
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

  /*
   * ►► THE CHURCH PICTURE LIBRARY (the owner's page). ◄◄ Every AI picture and
   * AI-lettered title the studio has kept for the church, by kind of event;
   * any of them taken off the shelf with one tap; the day's free allowance in
   * plain words; and "Fill the library now" for a quiet day before a big one.
   */
  const KIND_NAMES = { prayer: 'Prayer meetings', word: 'Bible study', sunday: 'Sunday services', vibes: 'Youth', glory: 'Conferences & revivals', thanksgiving: 'Thanksgiving & celebrations', easter: 'Easter', christmas: 'Christmas', crossover: 'Crossover & New Year', general: 'Other' };
  function openLibrary() {
    const P = C.openPanel({ id: 'cloudFlyerLibrary', title: 'Church picture library', cls: 'cp-flyer-kit' });
    let lib = null, busy = '';
    const when = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (e) { return 'midnight UTC'; } };
    const thumb = (x, cls) => `<figure class="fs-lib-pic ${cls || ''}"><img loading="lazy" src="${escAttr(window.MW_FLYER_LIB_URL(x.file))}" alt=""><figcaption>${esc([x.tone && x.tone !== 'own' ? x.tone : '', x.tier === 'premium' ? 'premium' : '', x.uses ? 'used ' + x.uses + '×' : 'not used yet'].filter(Boolean).join(' · '))}</figcaption><button type="button" class="fs-lib-x" data-rm="${escAttr(x.id)}" aria-label="Remove">×</button></figure>`;
    const draw = () => {
      if (!lib) { P.body.innerHTML = `<p class="fs-status"><i class="fs-spin"></i> Opening the library…</p>`; return; }
      const a = lib.allowance || {};
      const used = Math.min(100, Math.round(((a.spent || 0) / (a.day || 10000)) * 100));
      const words = !a.cloudflare ? 'No Cloudflare account on the server.' : a.level === 'plenty' ? 'Plenty left for fresh paintings right now.' : a.level === 'limited' ? 'Running low — boards are mixing fresh paintings with library pictures.' : `Painted its share for now — boards use the library until more is released (the day resets at ${when(a.resetsAt)}).`;
      const groups = {};
      for (const x of lib.pictures) (groups[x.kind] || (groups[x.kind] = [])).push(x);
      P.body.innerHTML = `<div class="fs-kit fs-lib">
        <section class="fs-sec"><h3>Today’s free AI allowance</h3>
          <div class="fs-lib-bar"><i style="width:${used}%"></i></div>
          <p class="fs-note">${used}% of today’s free painting used${a.active ? ` · ${a.active} ${a.active === 1 ? 'person' : 'people'} making flyers this hour` : ''}. ${esc(words)}</p>
          <button type="button" class="fs-ghost" data-act="fill"${busy ? ' disabled' : ''}>${busy ? '<i class="fs-spin"></i> ' + esc(busy) : ic('spark') + '<span>Fill the library now</span>'}</button>
          <p class="fs-note">Paints up to a dozen pictures for your next services and for what people asked for, from what today has released — leaving some for flyers being made. The library also fills itself every night.</p>
        </section>
        <section class="fs-sec"><h3>AI-lettered titles <small>(${lib.letterings.length})</small></h3>
          ${lib.letterings.length ? `<div class="fs-lib-grid">${lib.letterings.map((x) => thumb(Object.assign({}, x, { tone: x.title }), 'fs-lib-letter')).join('')}</div>` : '<p class="fs-note">None yet. Each AI-lettered title that is read back spelt right is kept here for everyone.</p>'}
        </section>
        ${Object.keys(groups).length ? Object.keys(groups).map((k) => `<section class="fs-sec"><h3>${esc(KIND_NAMES[k] || k)} <small>(${groups[k].length})</small></h3><div class="fs-lib-grid">${groups[k].map((x) => thumb(x)).join('')}</div></section>`).join('')
          : '<section class="fs-sec"><p class="fs-note">No pictures yet. Every picture the AI paints is kept here and handed to the next person making that kind of flyer — the library grows every day.</p></section>'}
        <p class="fs-note">Tap × to take a picture off the shelf for good (nobody will be given it again).</p>
      </div>`;
    };
    const load = async () => { try { lib = await window.api.flyer.library(); } catch (e) { toast(e.message || 'The library could not be opened.', 'error'); lib = { pictures: [], letterings: [], allowance: {} }; } draw(); };
    P.body.onclick = async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        const id = rm.dataset.rm;
        try { await window.api.flyer.libraryRemove({ id }); lib.pictures = lib.pictures.filter((x) => x.id !== id); lib.letterings = lib.letterings.filter((x) => x.id !== id); draw(); toast('Taken off the shelf.'); } catch (er) { toast(er.message, 'error'); }
        return;
      }
      if (e.target.closest('[data-act="fill"]') && !busy) {
        busy = 'Painting for the library…'; draw();
        try {
          const r = await window.api.flyer.libraryFill();
          toast(r && (r.painted || r.letters) ? `${r.painted || 0} picture${r.painted === 1 ? '' : 's'}${r.letters ? ` and ${r.letters} title${r.letters === 1 ? '' : 's'}` : ''} added to the library.` : 'Nothing to paint just now — today’s free allowance is kept for the flyers being made.');
        } catch (er) { toast(er.message, 'error'); }
        busy = ''; await load();
      }
    };
    draw(); load();
  }

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
            <div class="fs-bank fs-bank-sm">${(s.photos || []).map((p, j) => `<div class="fs-bank-cell"><button type="button" class="fs-bank-pic" data-k="sppic" data-i="${i}" data-j="${j}" aria-label="Fix this photo’s cut-out">${picTag(p)}</button>
              <button type="button" class="fs-pic-x" data-k="sppicrm" data-i="${i}" data-j="${j}" aria-label="Remove this photo">${ic('close')}</button></div>`).join('')}
            <span class="fs-cut-tiles" data-cutfor="${escAttr((CUTS.get(s) || {}).key || '')}">${cutTilesHtml(s)}</span>
            <button type="button" class="fs-bank-pic fs-bank-add" data-k="spadd-pic" data-i="${i}">${ic('plus')}<small>Add photos<br>(several at once)</small></button></div></div>`).join('')}
          <button type="button" class="fs-ghost" data-k="spadd">${ic('plus')}<span>Add a speaker</span></button></div>
        </section>
        <section class="fs-sec"><h3>Inspiration <small>flyers you love — every new design leans their way</small></h3>
          <div class="fs-bank fs-bank-sm">${(F.kit.inspo || []).map((it) => `<button type="button" class="fs-bank-pic fs-inspo" data-k="inspo" data-id="${escAttr(it.id)}">${picTag(it.thumb)}${it.notes ? '<em>✓ read</em>' : ''}</button>`).join('')}
          <button type="button" class="fs-bank-pic fs-bank-add" data-k="inspoadd">${ic('plus')}<small>Add</small></button></div>
          <p class="fs-note">Screenshot flyers you like on Pinterest or Instagram and add them here. Their colours are used for your flyers.</p>
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
        case 'spadd-pic': return addPhotos(k.speakers[i], async () => drawKit(), { redraw: async () => drawKit() });
        case 'inspoadd': return addInspiration(() => drawKit());
        case 'inspo': {
          if (!window.confirm('Take this flyer off your inspiration board?')) return;
          try { await window.api.flyer.inspoRemove(b.dataset.id); F.kit.inspo = (F.kit.inspo || []).filter((x) => x.id !== b.dataset.id); } catch (e) {}
          return drawKit();
        }
        case 'sppic':     // one of the bank, tapped: fix its cut-out (Save puts the new one in this place)
          return recutPhoto(k.speakers[i], +b.dataset.j, () => drawKit());
        case 'sppicrm': {   // its ✕: out of the bank (kept until Save — closing without saving puts it back)
          k.speakers[i].photos.splice(+b.dataset.j, 1);
          drawKit();
          return toast('Photo removed. Tap Save to keep the change.', '', 3500);
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
    if (C && C.openPicker) C.openPicker(inp); else inp.click();
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
  root.MWFlyerStudio = { open, openThumb, openKit: openKitAlone, _state: F, _rebuild: () => rebuildDesigns(), _view: (S) => viewFlyer(S), _flaws: (S) => designFlaws(S).concat(contrastFlaws(S)) };
})();
