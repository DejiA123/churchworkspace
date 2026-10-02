'use strict';
/*
 * Built-in backgrounds for the Presentation Studio.
 *
 * A volunteer who opens this app on a Saturday night has no motion loops, no
 * stock library and no time. They need something that already looks like a
 * church put thought into it. So a curated set ships with the app.
 *
 * Every one of these is VECTOR — a layered CSS gradient, or an SVG carried in a
 * data: URI. That is a deliberate choice over bundling photographs:
 *
 *   • it stays razor sharp on a 4K wall AND in a 160px thumbnail (a JPEG that
 *     looks fine in the grid turns to mush on the projector),
 *   • it adds a couple of hundred kilobytes to the installer instead of
 *     hundreds of megabytes,
 *   • it works with no network, which is the whole premise of this studio,
 *   • and there is no licence to argue about — nothing here is anyone's photo.
 *
 * They are built to be READ OVER. Lyrics live in the middle of the screen, so
 * the middle of every background is kept quiet and the interest is pushed to
 * the top, the edges and the bottom. The dark ones assume white text; the four
 * light ones are flagged so the studio can warn an operator who is about to put
 * white words on a white screen.
 */
(function () {
  /** SVG in a data: URI. encodeURIComponent, not hand-escaping: '#' inside a
   *  colour would otherwise end the URI and the background would silently
   *  vanish on some slides and not others. */
  const svgUri = (svg) => 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\s{2,}/g, ' ').trim());

  /** Wrapper every scene shares: a fixed 1920×1080 canvas that crops (never
   *  letterboxes) onto whatever shape the screen actually is. */
  const scene = (inner, defs) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">`
    + (defs ? `<defs>${defs}</defs>` : '') + inner + '</svg>';

  const linear = (id, stops, x1, y1, x2, y2) =>
    `<linearGradient id="${id}" x1="${x1 || 0}" y1="${y1 || 0}" x2="${x2 || 0}" y2="${y2 == null ? 1 : y2}">`
    + stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('')
    + '</linearGradient>';
  const radial = (id, stops, cx, cy, r) =>
    `<radialGradient id="${id}" cx="${cx == null ? 0.5 : cx}" cy="${cy == null ? 0.5 : cy}" r="${r == null ? 0.7 : r}">`
    + stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('')
    + '</radialGradient>';

  /* ------------------------------------------------------------------ *
   *  Scenes
   * ------------------------------------------------------------------ */

  /** God-rays from above. The classic worship background, done softly enough
   *  that it never competes with the words sitting across the middle. */
  const rays = (() => {
    let beams = '';
    // irregular widths, or it reads as a machine-made starburst
    const spread = [[-380, 70], [-170, 130], [40, 46], [170, 96], [420, 60], [700, 120], [980, 44]];
    for (const [x, w] of spread) {
      beams += `<polygon points="${840 + x * 0.12},0 ${840 + x * 0.12 + w * 0.35},0 ${840 + x + w},1080 ${840 + x},1080" fill="url(#ray)"/>`;
    }
    return scene(
      `<rect width="1920" height="1080" fill="url(#sky)"/>`
      + `<ellipse cx="900" cy="-120" rx="820" ry="520" fill="url(#halo)"/>`
      + `<g style="mix-blend-mode:screen">${beams}</g>`,
      // many stops, fading to nothing well inside the shape's own edge — two
      // stops leave a faintly visible arc where the halo stops
      linear('sky', [[0, '#16305e'], [0.45, '#0d1b3a'], [1, '#050a17']])
      + radial('halo', [[0, '#c6dbff', 0.52], [0.3, '#8fb0e6', 0.26], [0.5, '#6f93d6', 0.12],
        [0.7, '#6f93d6', 0.04], [0.85, '#6f93d6', 0.01], [1, '#6f93d6', 0]], 0.5, 0.5, 1)
      + linear('ray', [[0, '#dbe8ff', 0.34], [0.55, '#a8c4f5', 0.1], [1, '#a8c4f5', 0]]),
    );
  })();

  /** Soft out-of-focus lights. Kept to the corners so the centre stays clean. */
  const bokeh = (() => {
    // fixed, hand-placed rather than random: a seed that looked good once is
    // worth more than a different arrangement on every launch
    const circles = [
      [210, 190, 130, 0.20], [430, 120, 62, 0.16], [130, 470, 84, 0.12],
      [1720, 240, 150, 0.18], [1520, 130, 70, 0.14], [1830, 560, 96, 0.11],
      [300, 900, 118, 0.15], [560, 990, 66, 0.12], [1650, 880, 134, 0.16],
      [1400, 980, 74, 0.12], [980, 90, 58, 0.09], [1060, 1010, 80, 0.10],
    ];
    return scene(
      `<rect width="1920" height="1080" fill="url(#bg)"/>`
      + `<g filter="url(#soft)">`
      + circles.map(([cx, cy, r, o]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#9fc6ff" opacity="${o}"/>`).join('')
      + `</g>`,
      linear('bg', [[0, '#0a1226'], [0.5, '#111c3d'], [1, '#05080f']])
      + `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="26"/></filter>`,
    );
  })();

  /** Sunrise over layered ridges. The horizon deliberately sits low, so the
   *  lyrics land on open sky rather than on the mountains. */
  const mountainDawn = scene(
    `<rect width="1920" height="1080" fill="url(#sky)"/>`
    + `<circle cx="1180" cy="742" r="118" fill="#ffd9a0" opacity="0.55"/>`
    + `<circle cx="1180" cy="742" r="62" fill="#fff1d6" opacity="0.85"/>`
    + `<path d="M0 830 L300 690 L520 800 L760 640 L1010 810 L1240 700 L1500 830 L1740 720 L1920 812 L1920 1080 L0 1080 Z" fill="#2a2140" opacity="0.92"/>`
    + `<path d="M0 900 L260 812 L520 900 L820 790 L1080 892 L1360 810 L1650 900 L1920 846 L1920 1080 L0 1080 Z" fill="#191231" opacity="0.95"/>`
    + `<path d="M0 972 L380 918 L720 980 L1120 916 L1500 984 L1920 930 L1920 1080 L0 1080 Z" fill="#0d0819"/>`,
    linear('sky', [[0, '#1b1b46'], [0.42, '#5b3a63'], [0.68, '#b66a52'], [0.86, '#e59a5c'], [1, '#f3c081']]),
  );

  /** Dusk over open country — the calmest of the scenes, for readings. */
  const hills = scene(
    `<rect width="1920" height="1080" fill="url(#sky)"/>`
    + `<ellipse cx="520" cy="1010" rx="1100" ry="300" fill="#1d3350" opacity="0.55"/>`
    + `<path d="M0 880 C 380 790, 700 930, 1080 850 C 1420 780, 1700 880, 1920 838 L1920 1080 L0 1080 Z" fill="#16283f"/>`
    + `<path d="M0 962 C 320 906, 640 1000, 1000 940 C 1360 880, 1660 966, 1920 928 L1920 1080 L0 1080 Z" fill="#0d1929"/>`,
    linear('sky', [[0, '#0b1730'], [0.5, '#1f3357'], [0.8, '#4a5c85'], [1, '#7a7fa5']]),
  );

  /** Sea and sky with a low sun. The glint is a soft column of light spreading
   *  as it comes towards you — evenly spaced bars read as a ladder, which is
   *  what the first attempt at this looked like. */
  const ocean = scene(
    `<rect width="1920" height="1080" fill="url(#sky)"/>`
    + `<rect y="700" width="1920" height="380" fill="url(#sea)"/>`
    + `<circle cx="960" cy="700" r="92" fill="url(#sun)"/>`
    // A glint is scattered light on moving water: broken dashes that drift off
    // the centre line and spread as they come towards you. A solid cone (or a
    // stack of centred bars) reads as a road, which is what this was.
    + `<ellipse cx="960" cy="820" rx="120" ry="150" fill="url(#col)"/>`
    + `<g filter="url(#wet)" fill="#ffdcae">`
    + [[714, -6, 52, 0.30], [730, 22, 30, 0.22], [748, -38, 74, 0.24], [770, 34, 44, 0.19],
      [794, -62, 96, 0.20], [822, 48, 58, 0.16], [854, -84, 120, 0.16], [890, 70, 76, 0.13],
      [932, -110, 150, 0.12], [980, 96, 100, 0.10], [1034, -140, 186, 0.08]]
      .map(([y, dx, w, o], i) => `<ellipse cx="${960 + dx}" cy="${y}" rx="${w}" ry="${3 + i * 0.7}" opacity="${o}"/>`).join('')
    + `</g>`,
    linear('sky', [[0, '#122246'], [0.5, '#3d4f7e'], [0.86, '#c98a63'], [1, '#f0b478']])
    + linear('sea', [[0, '#2a4671'], [0.5, '#16294a'], [1, '#080f1e']])
    + radial('sun', [[0, '#fff4dd'], [0.55, '#ffd9a2'], [1, '#ffc989', 0]])
    + radial('col', [[0, '#ffd9a2', 0.16], [0.5, '#ffd9a2', 0.07], [1, '#ffd9a2', 0]])
    + `<filter id="wet" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>`,
  );

  /** A treeline receding into fog.
   *
   *  Drawn as a continuous silhouette per layer, not as separate triangles: a
   *  row of evenly-spaced spikes reads as a sawtooth waveform rather than a
   *  forest (which is exactly what the first attempt at this looked like). Each
   *  layer is one path whose base sits well below the peaks so the trunks merge
   *  into a mass, with the conifer taper built from stepped shoulders. */
  const forest = (() => {
    const layer = (baseY, seed, count, minH, varH, fill, op) => {
      let d = `M-60 1080 L-60 ${baseY}`;
      let s = seed;
      const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
      const step = (1920 + 240) / count;
      for (let i = 0; i < count; i++) {
        const cx = -60 + step * (i + 0.5) + (rnd() - 0.5) * step * 0.5;
        const h = minH + rnd() * varH;
        const w = step * (0.62 + rnd() * 0.5);
        const top = baseY - h;
        // shoulders partway down each side give the conifer its stepped taper
        d += ` L${(cx - w / 2).toFixed(0)} ${baseY.toFixed(0)}`
          + ` L${(cx - w * 0.30).toFixed(0)} ${(top + h * 0.42).toFixed(0)}`
          + ` L${(cx - w * 0.17).toFixed(0)} ${(top + h * 0.46).toFixed(0)}`
          + ` L${cx.toFixed(0)} ${top.toFixed(0)}`
          + ` L${(cx + w * 0.17).toFixed(0)} ${(top + h * 0.46).toFixed(0)}`
          + ` L${(cx + w * 0.30).toFixed(0)} ${(top + h * 0.42).toFixed(0)}`
          + ` L${(cx + w / 2).toFixed(0)} ${baseY.toFixed(0)}`;
      }
      d += ` L1980 ${baseY} L1980 1080 Z`;
      return `<path d="${d}" fill="${fill}" opacity="${op}"/>`;
    };
    return scene(
      `<rect width="1920" height="1080" fill="url(#sky)"/>`
      + layer(880, 11, 13, 180, 130, '#20465a', 0.45)
      + `<rect y="700" width="1920" height="260" fill="url(#fog)"/>`
      + layer(985, 29, 9, 250, 190, '#122c3c', 0.75)
      + `<rect y="820" width="1920" height="230" fill="url(#fog)" opacity="0.85"/>`
      + layer(1080, 47, 7, 300, 240, '#081520', 0.96),
      linear('sky', [[0, '#0b1d2c'], [0.5, '#164055'], [1, '#2a6270']])
      + linear('fog', [[0, '#b9d8e2', 0], [0.45, '#b9d8e2', 0.3], [1, '#b9d8e2', 0]]),
    );
  })();

  /** Jewel glass in lead.
   *
   *  The panes come from a JITTERED POINT MESH, not a grid of rectangles with a
   *  wobble: every corner is shared with its neighbours, so the leading runs in
   *  continuous crooked lines the way real cames do. A grid of near-rectangles
   *  just reads as a checkerboard (which is what the first attempt looked like).
   *  Big panes, few of them, and a heavy vignette — this sits behind words. */
  const stainedGlass = (() => {
    const COLS = 7, ROWS = 4;
    const cols = ['#1b4f8f', '#7d1f3f', '#0f6b60', '#2b3080', '#93611a', '#4d1f70', '#12607d', '#7a2418'];
    let s = 91;
    const rnd = () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
    // one shared point per mesh vertex; edges stay pinned so no glass is missing
    const pt = [];
    for (let r = 0; r <= ROWS; r++) {
      pt[r] = [];
      for (let c = 0; c <= COLS; c++) {
        const edge = r === 0 || c === 0 || r === ROWS || c === COLS;
        pt[r][c] = [
          Math.round((c / COLS) * 1920 + (edge ? 0 : (rnd() - 0.5) * 150)),
          Math.round((r / ROWS) * 1080 + (edge ? 0 : (rnd() - 0.5) * 110)),
        ];
      }
    }
    let cells = '';
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = [pt[r][c], pt[r][c + 1], pt[r + 1][c + 1], pt[r + 1][c]];
        const col = cols[Math.floor(rnd() * cols.length)];
        cells += `<path d="M${p.map((q) => q.join(' ')).join(' L')} Z" fill="${col}"`
          + ` opacity="${(0.55 + rnd() * 0.4).toFixed(2)}" stroke="#04060b" stroke-width="11" stroke-linejoin="round"/>`;
      }
    }
    return scene(
      `<rect width="1920" height="1080" fill="#04060b"/>`
      + `<g filter="url(#glow)">${cells}</g>`
      + `<rect width="1920" height="1080" fill="url(#vig)"/>`,
      radial('vig', [[0, '#03050a', 0.55], [0.45, '#03050a', 0.5], [1, '#000000', 0.9]], 0.5, 0.5, 0.85)
      + `<filter id="glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="2.2"/></filter>`,
    );
  })();

  /** Fine film grain over deep charcoal — texture you feel rather than see. */
  const grain = scene(
    `<rect width="1920" height="1080" fill="url(#bg)"/>`
    + `<rect width="1920" height="1080" filter="url(#n)" opacity="0.16"/>`,
    linear('bg', [[0, '#171a20'], [0.55, '#0f1116'], [1, '#08090c']])
    + `<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" stitchTiles="stitch"/>`
    + `<feColorMatrix type="saturate" values="0"/></filter>`,
  );

  /** Soft aurora ribbons. */
  const aurora = scene(
    `<rect width="1920" height="1080" fill="url(#bg)"/>`
    + `<g filter="url(#blur)" style="mix-blend-mode:screen">`
    // ribbons, not clouds: shallower bands and a smaller blur keep the colours
    // separate instead of averaging into one grey-blue smear
    + `<path d="M-200 250 C 300 130, 700 400, 1150 236 C 1500 104, 1800 300, 2120 186 L2120 420 L-200 470 Z" fill="#2fd0a2" opacity="0.5"/>`
    + `<path d="M-200 400 C 260 268, 640 540, 1080 372 C 1460 226, 1820 440, 2120 330 L2120 560 L-200 620 Z" fill="#3f7bff" opacity="0.42"/>`
    + `<path d="M-200 560 C 340 430, 760 700, 1240 520 C 1560 400, 1900 600, 2120 500 L2120 720 L-200 790 Z" fill="#a24bd8" opacity="0.3"/>`
    + `</g>`,
    linear('bg', [[0, '#050a18'], [0.5, '#0a1430'], [1, '#03060e']])
    + `<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="42"/></filter>`,
  );

  /** A quiet night sky. */
  const stars = (() => {
    let dots = '';
    // a deterministic scatter, thinned across the middle band where words go
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 220; i++) {
      const x = Math.round(rnd() * 1920), y = Math.round(rnd() * 1080);
      const mid = y > 360 && y < 760;
      if (mid && rnd() > 0.28) continue;
      const r = (rnd() * 1.9 + 0.5).toFixed(1);
      dots += `<circle cx="${x}" cy="${y}" r="${r}" fill="#dce8ff" opacity="${(rnd() * 0.6 + 0.25).toFixed(2)}"/>`;
    }
    return scene(
      `<rect width="1920" height="1080" fill="url(#bg)"/>${dots}`
      + `<ellipse cx="960" cy="1180" rx="1400" ry="420" fill="#1b2f63" opacity="0.5"/>`,
      linear('bg', [[0, '#02040d'], [0.55, '#070d20'], [1, '#0b1430']]),
    );
  })();

  /** A candle-lit room: for communion, Christmas Eve, quiet prayer. */
  const candlelight = scene(
    `<rect width="1920" height="1080" fill="url(#bg)"/>`
    + `<ellipse cx="960" cy="900" rx="560" ry="320" fill="url(#flame)"/>`
    + `<rect width="1920" height="1080" fill="url(#vig)"/>`,
    linear('bg', [[0, '#0b0603'], [0.6, '#1b0f06'], [1, '#070301']])
    + radial('flame', [[0, '#ffb964', 0.42], [0.5, '#b3600f', 0.16], [1, '#b3600f', 0]])
    + radial('vig', [[0, '#000000', 0], [0.6, '#000000', 0.2], [1, '#000000', 0.72]], 0.5, 0.5, 0.8),
  );

  /** A barely-there hexagon mesh, for announcements that need some structure. */
  const hexMesh = scene(
    `<rect width="1920" height="1080" fill="url(#bg)"/>`
    + `<rect width="1920" height="1080" fill="url(#hex)" opacity="0.5"/>`
    + `<rect width="1920" height="1080" fill="url(#vig)"/>`,
    linear('bg', [[0, '#0f1626'], [0.55, '#131c30'], [1, '#080c15']])
    + `<pattern id="hex" width="112" height="194" patternUnits="userSpaceOnUse">`
    + `<path d="M56 0 L112 32 L112 96 L56 128 L0 96 L0 32 Z M56 128 L112 160 M56 128 L0 160" fill="none" stroke="#4f6da8" stroke-width="1.6" opacity="0.5"/>`
    + `</pattern>`
    + radial('vig', [[0, '#000000', 0], [0.6, '#000000', 0.15], [1, '#000000', 0.6]], 0.5, 0.5, 0.8),
  );

  /* ------------------------------------------------------------------ *
   *  The set
   * ------------------------------------------------------------------ */

  /* ---------------- second wave: cross, church, ocean, modern -------------
   * The scenes a church actually asks for. Still vector, for the same reasons
   * the first wave was (see the header): sharp at 4K and at 160px, kilobytes
   * rather than megabytes, no network, and no photographer's licence to argue
   * about. Nothing here depicts a face — a background has to sit behind the
   * words in any tradition without becoming the subject. */

  /** A cross standing in light. */
  const crossLight = scene(
    '<rect width="1920" height="1080" fill="url(#cl-sky)"/>'
    + '<ellipse cx="960" cy="700" rx="900" ry="330" fill="url(#cl-glow)"/>'
    + '<g fill="#05070c" opacity="0.92">'
    + '<rect x="936" y="250" width="48" height="600" rx="6"/>'
    + '<rect x="816" y="404" width="288" height="46" rx="6"/>'
    + '</g>'
    + '<rect y="820" width="1920" height="260" fill="url(#cl-floor)"/>',
    linear('cl-sky', [[0, '#0a1020'], [0.45, '#1d2b4a'], [1, '#0a1020']], 0, 0, 0, 1)
    + radial('cl-glow', [[0, '#ffd9a0', 0.55], [0.5, '#ffb765', 0.16], [1, '#ffb765', 0]], 0.5, 0.5, 0.6)
    + linear('cl-floor', [[0, '#05070c', 0], [1, '#05070c', 0.9]], 0, 0, 0, 1));

  /** Empty tomb: a stone rolled back, light spilling out. */
  const tomb = scene(
    '<rect width="1920" height="1080" fill="url(#tb-bg)"/>'
    + '<path d="M0,1080 L0,620 Q420,470 700,560 Q900,624 1120,540 Q1500,398 1920,560 L1920,1080 Z" fill="#0b0d12"/>'
    + '<ellipse cx="820" cy="700" rx="230" ry="250" fill="#04050a"/>'
    + '<ellipse cx="820" cy="700" rx="150" ry="176" fill="url(#tb-in)"/>'
    + '<circle cx="1290" cy="792" r="150" fill="#12151d"/>'
    + '<circle cx="1290" cy="792" r="150" fill="url(#tb-stone)"/>',
    linear('tb-bg', [[0, '#0d1730'], [0.55, '#2a3352'], [1, '#131a2c']], 0, 0, 0, 1)
    + radial('tb-in', [[0, '#ffe6b8', 0.95], [0.6, '#ffbe70', 0.35], [1, '#ffbe70', 0]], 0.5, 0.5, 0.75)
    + radial('tb-stone', [[0, '#3a4152', 0.9], [1, '#12151d', 0.2]], 0.34, 0.3, 0.9));

  /** A dove in light — Pentecost, a baptism, a blessing. */
  const dove = scene(
    '<rect width="1920" height="1080" fill="url(#dv-bg)"/>'
    + '<circle cx="960" cy="430" r="330" fill="url(#dv-halo)"/>'
    + '<g fill="#f6f9ff" opacity="0.96" transform="translate(960,430) scale(1.5)">'
    + '<path d="M0,-52 C22,-52 44,-36 44,-12 C44,4 32,16 16,20 L38,64 L4,36 L-30,66 L-12,20 C-30,14 -44,0 -44,-14 C-44,-38 -22,-52 0,-52 Z"/>'
    + '</g>',
    linear('dv-bg', [[0, '#101a34'], [0.6, '#1b2b4e'], [1, '#080c17']], 0, 0, 0, 1)
    + radial('dv-halo', [[0, '#bcd4ff', 0.5], [0.55, '#7fa8ff', 0.14], [1, '#7fa8ff', 0]], 0.5, 0.5, 0.7));

  /** Stained-glass arches, seen from inside a nave. */
  const nave = scene(
    '<rect width="1920" height="1080" fill="#070910"/>'
    + [230, 730, 1230, 1730].map(function (cx) {
      return '<path d="M' + (cx - 150) + ',1080 L' + (cx - 150) + ',470 Q' + cx + ',250 ' + (cx + 150) + ',470 L' + (cx + 150) + ',1080 Z" fill="url(#nv-win)"/>';
    }).join('')
    + '<rect width="1920" height="1080" fill="url(#nv-vig)"/>',
    linear('nv-win', [[0, '#ffd27a', 0.85], [0.4, '#e0733f', 0.5], [1, '#2b1c3f', 0.15]], 0, 0, 0, 1)
    + radial('nv-vig', [[0, '#000000', 0], [0.62, '#000000', 0.35], [1, '#000000', 0.88]], 0.5, 0.44, 0.85));

  /** A modern auditorium: stage wash, beams through haze. */
  const auditorium = scene(
    '<rect width="1920" height="1080" fill="url(#au-bg)"/>'
    + [180, 470, 760, 1050, 1340, 1630].map(function (x, i) {
      return '<polygon points="' + x + ',0 ' + (x + 54) + ',0 ' + (x + 150 + i * 14) + ',1080 ' + (x - 120) + ',1080" fill="url(#au-beam)"/>';
    }).join('')
    + '<ellipse cx="960" cy="1080" rx="1000" ry="300" fill="url(#au-stage)"/>'
    + '<rect y="0" width="1920" height="150" fill="url(#au-truss)"/>',
    linear('au-bg', [[0, '#0a0d16'], [0.5, '#141a2b'], [1, '#05070d']], 0, 0, 0, 1)
    + linear('au-beam', [[0, '#7ea8ff', 0.20], [1, '#7ea8ff', 0]], 0, 0, 0, 1)
    + radial('au-stage', [[0, '#3d5a9e', 0.5], [1, '#3d5a9e', 0]], 0.5, 1, 0.8)
    + linear('au-truss', [[0, '#0a0d16', 0.95], [1, '#0a0d16', 0]], 0, 0, 0, 1));

  /** Concrete and glass — a contemporary church building at dusk. */
  const modernHouse = scene(
    '<rect width="1920" height="1080" fill="url(#mh-sky)"/>'
    + '<g opacity="0.9">'
    + '<polygon points="0,1080 0,470 560,300 560,1080" fill="#0d1017"/>'
    + '<polygon points="560,1080 560,300 1180,392 1180,1080" fill="#11151e"/>'
    + '<polygon points="1180,1080 1180,392 1920,250 1920,1080" fill="#0a0d13"/>'
    + '</g>'
    + [640, 760, 880, 1000, 1260, 1400, 1540, 1680].map(function (x, i) {
      return '<rect x="' + x + '" y="' + (470 + (i % 3) * 40) + '" width="62" height="150" fill="url(#mh-win)"/>';
    }).join('')
    + '<rect y="640" width="1920" height="440" fill="url(#mh-fade)"/>',
    linear('mh-sky', [[0, '#131c33'], [0.45, '#2b3b63'], [0.75, '#6a4b63'], [1, '#221a2c']], 0, 0, 0, 1)
    + linear('mh-win', [[0, '#ffd9a0', 0.85], [1, '#ffb765', 0.35]], 0, 0, 0, 1)
    + linear('mh-fade', [[0, '#05070c', 0], [1, '#05070c', 0.92]], 0, 0, 0, 1));

  /** Deep ocean swell under a wide sky. */
  const oceanDeep = scene(
    '<rect width="1920" height="1080" fill="url(#od-sky)"/>'
    + '<path d="M0,600 Q300,556 620,596 T1250,590 T1920,566 L1920,1080 L0,1080 Z" fill="url(#od-sea)"/>'
    + '<path d="M0,700 Q380,656 760,706 T1500,690 T1920,672 L1920,1080 L0,1080 Z" fill="#06182c" opacity="0.75"/>'
    + '<ellipse cx="1360" cy="330" rx="360" ry="200" fill="url(#od-sun)"/>',
    linear('od-sky', [[0, '#0a1c34'], [0.55, '#2c5a80'], [1, '#8fb6c9']], 0, 0, 0, 1)
    + linear('od-sea', [[0, '#12456d'], [1, '#04101f']], 0, 0, 0, 1)
    + radial('od-sun', [[0, '#ffe1b0', 0.55], [1, '#ffb765', 0]], 0.5, 0.5, 0.7));

  /** Light through water — seen from below. */
  const underwater = scene(
    '<rect width="1920" height="1080" fill="url(#uw-bg)"/>'
    + Array.from({ length: 9 }, function (_, i) {
      var x = 90 + i * 210;
      return '<polygon points="' + x + ',0 ' + (x + 90) + ',0 ' + (x + 250 + i * 8) + ',1080 ' + (x - 40) + ',1080" fill="url(#uw-ray)"/>';
    }).join('')
    + '<rect width="1920" height="1080" fill="url(#uw-vig)"/>',
    linear('uw-bg', [[0, '#0a3f5e'], [0.5, '#06263c'], [1, '#01101c']], 0, 0, 0, 1)
    + linear('uw-ray', [[0, '#a8e6ff', 0.24], [1, '#a8e6ff', 0]], 0, 0, 0, 1)
    + radial('uw-vig', [[0, '#000000', 0], [1, '#000000', 0.6]], 0.5, 0.35, 0.9));

  /** Waves at dawn, seen down the beach. */
  const shore = scene(
    '<rect width="1920" height="1080" fill="url(#sh-sky)"/>'
    + '<rect y="540" width="1920" height="540" fill="url(#sh-sea)"/>'
    + [640, 760, 880].map(function (y, i) {
      return '<path d="M0,' + y + ' Q480,' + (y - 40 - i * 10) + ' 960,' + y + ' T1920,' + y + '" stroke="#dff1ff" stroke-opacity="' + (0.20 - i * 0.05) + '" stroke-width="' + (8 - i * 2) + '" fill="none"/>';
    }).join('')
    + '<ellipse cx="960" cy="548" rx="700" ry="120" fill="url(#sh-glow)"/>',
    linear('sh-sky', [[0, '#20243f'], [0.5, '#7a5a6e'], [0.8, '#d99a6c'], [1, '#f0c396']], 0, 0, 0, 1)
    + linear('sh-sea', [[0, '#3a5d78'], [1, '#0a1a2a']], 0, 0, 0, 1)
    + radial('sh-glow', [[0, '#ffdcae', 0.6], [1, '#ffdcae', 0]], 0.5, 0.5, 0.7));

  const PRESETS = [
    /* ---- Worship: deep, quiet in the middle, built for white lyrics ---- */
    { id: 'bg-midnight', name: 'Midnight', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(140% 100% at 50% -12%, #2a3a72 0%, rgba(42,58,114,0) 56%), linear-gradient(180deg,#070b18 0%,#0d1430 58%,#05070f 100%)' },
    { id: 'bg-royal', name: 'Royal', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(120% 92% at 50% 0%, #4a2a8a 0%, rgba(74,42,138,0) 58%), linear-gradient(160deg,#1b1042 0%,#2d1b69 46%,#0b0720 100%)' },
    { id: 'bg-teal', name: 'Deep Teal', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(120% 92% at 50% 4%, #0e5a63 0%, rgba(14,90,99,0) 60%), linear-gradient(180deg,#04191d 0%,#072b31 56%,#02090b 100%)' },
    { id: 'bg-ember', name: 'Ember', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(110% 82% at 50% 104%, #7a2d0c 0%, rgba(122,45,12,0) 62%), linear-gradient(180deg,#170703 0%,#2a0f06 60%,#0a0402 100%)' },
    { id: 'bg-slate', name: 'Slate', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(130% 100% at 50% 0%, #3b4457 0%, rgba(59,68,87,0) 60%), linear-gradient(180deg,#0e1117 0%,#161b25 56%,#080a0f 100%)' },
    { id: 'bg-burgundy', name: 'Burgundy', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(120% 92% at 50% 8%, #6b1730 0%, rgba(107,23,48,0) 60%), linear-gradient(180deg,#150207 0%,#2c0812 58%,#0a0104 100%)' },
    { id: 'bg-forestgreen', name: 'Evergreen', cat: 'Worship', type: 'gradient',
      value: 'radial-gradient(120% 92% at 50% 6%, #1d5f3a 0%, rgba(29,95,58,0) 60%), linear-gradient(180deg,#04140c 0%,#0a2416 58%,#020806 100%)' },
    { id: 'bg-indigo', name: 'Indigo Fade', cat: 'Worship', type: 'gradient',
      value: 'linear-gradient(135deg,#0b1533 0%,#25306b 38%,#4b2a72 70%,#0a0a1c 100%)' },

    /* ---- Light: for bright rooms and dark text ---- */
    { id: 'bg-paper', name: 'Paper', cat: 'Light', light: true, type: 'gradient',
      value: 'radial-gradient(120% 100% at 50% 0%, #ffffff 0%, rgba(255,255,255,0) 62%), linear-gradient(180deg,#fbf9f4 0%,#eee8dd 100%)' },
    { id: 'bg-linen', name: 'Linen', cat: 'Light', light: true, type: 'gradient',
      value: 'radial-gradient(110% 90% at 30% 10%, #fffaf0 0%, rgba(255,250,240,0) 60%), linear-gradient(160deg,#f6efe2 0%,#e6dccb 100%)' },
    { id: 'bg-sky', name: 'Sky Wash', cat: 'Light', light: true, type: 'gradient',
      value: 'linear-gradient(180deg,#cfe3fb 0%,#e9f2fe 52%,#ffffff 100%)' },
    { id: 'bg-mist', name: 'Cool Mist', cat: 'Light', light: true, type: 'gradient',
      value: 'radial-gradient(120% 100% at 50% 0%, #ffffff 0%, rgba(255,255,255,0) 58%), linear-gradient(180deg,#e8eef4 0%,#cfd9e4 100%)' },

    /* ---- Light & atmosphere ---- */
    { id: 'bg-rays', name: 'Light Rays', cat: 'Atmosphere', type: 'image', value: svgUri(rays) },
    { id: 'bg-aurora', name: 'Aurora', cat: 'Atmosphere', type: 'image', value: svgUri(aurora) },
    { id: 'bg-bokeh', name: 'Bokeh', cat: 'Atmosphere', type: 'image', value: svgUri(bokeh) },
    { id: 'bg-stars', name: 'Starlight', cat: 'Atmosphere', type: 'image', value: svgUri(stars) },
    { id: 'bg-spotlight', name: 'Spotlight', cat: 'Atmosphere', type: 'gradient',
      value: 'radial-gradient(78% 78% at 50% 42%, #2b3247 0%, #12151f 42%, #05070c 100%)' },
    { id: 'bg-glow', name: 'Warm Glow', cat: 'Atmosphere', type: 'gradient',
      value: 'radial-gradient(90% 80% at 50% 100%, #d38a3a 0%, rgba(211,138,58,0.28) 34%, rgba(211,138,58,0) 66%), linear-gradient(180deg,#100a06 0%,#1c1109 60%,#070403 100%)' },

    /* ---- Nature ---- */
    { id: 'bg-mountain', name: 'Mountain Dawn', cat: 'Nature', type: 'image', value: svgUri(mountainDawn) },
    { id: 'bg-hills', name: 'Rolling Hills', cat: 'Nature', type: 'image', value: svgUri(hills) },
    { id: 'bg-ocean', name: 'Ocean Horizon', cat: 'Nature', type: 'image', value: svgUri(ocean) },
    { id: 'bg-forest', name: 'Forest Mist', cat: 'Nature', type: 'image', value: svgUri(forest) },

    /* ---- Texture ---- */
    { id: 'bg-glass', name: 'Stained Glass', cat: 'Texture', type: 'image', value: svgUri(stainedGlass) },
    { id: 'bg-grain', name: 'Film Grain', cat: 'Texture', type: 'image', value: svgUri(grain) },
    { id: 'bg-hex', name: 'Hex Mesh', cat: 'Texture', type: 'image', value: svgUri(hexMesh) },
    { id: 'bg-charcoal', name: 'Charcoal', cat: 'Texture', type: 'gradient',
      value: 'radial-gradient(120% 100% at 30% 0%, #262c38 0%, rgba(38,44,56,0) 58%), linear-gradient(180deg,#111419 0%,#0a0c11 100%)' },

    /* ---- Seasons & occasions ---- */
    { id: 'bg-advent', name: 'Advent', cat: 'Season', type: 'gradient',
      value: 'radial-gradient(110% 88% at 50% 4%, #b98a2e 0%, rgba(185,138,46,0.22) 30%, rgba(185,138,46,0) 62%), linear-gradient(180deg,#04140e 0%,#0b2418 58%,#020806 100%)' },
    { id: 'bg-easter', name: 'Easter Dawn', cat: 'Season', type: 'gradient',
      value: 'linear-gradient(180deg,#241a4d 0%,#6b3d63 34%,#c9764f 68%,#f2b877 100%)' },
    { id: 'bg-candle', name: 'Candlelight', cat: 'Season', type: 'image', value: svgUri(candlelight) },
    { id: 'bg-pentecost', name: 'Pentecost', cat: 'Season', type: 'gradient',
      value: 'radial-gradient(100% 80% at 50% 100%, #c2341c 0%, rgba(194,52,28,0.3) 32%, rgba(194,52,28,0) 64%), linear-gradient(180deg,#170406 0%,#3a0d0a 62%,#0a0202 100%)' },

    /* ---- Faith: the cross, the tomb, the dove ---- */
    { id: 'bg-cross', name: 'Cross in Light', cat: 'Faith', type: 'image', motion: 'breathe', value: svgUri(crossLight) },
    { id: 'bg-tomb', name: 'Empty Tomb', cat: 'Faith', type: 'image', motion: 'push', value: svgUri(tomb) },
    { id: 'bg-dove', name: 'Dove', cat: 'Faith', type: 'image', motion: 'breathe', value: svgUri(dove) },
    { id: 'bg-nave', name: 'Nave Windows', cat: 'Faith', type: 'image', value: svgUri(nave) },

    /* ---- Church: the room itself ---- */
    { id: 'bg-auditorium', name: 'Auditorium', cat: 'Church', type: 'image', motion: 'sway', value: svgUri(auditorium) },
    { id: 'bg-modernhouse', name: 'Modern Church', cat: 'Church', type: 'image', motion: 'push', value: svgUri(modernHouse) },
    { id: 'bg-stagewash', name: 'Stage Wash', cat: 'Church', type: 'gradient', motion: 'sway',
      value: 'radial-gradient(80% 70% at 20% 100%, #2f6ad9 0%, rgba(47,106,217,0) 60%), radial-gradient(80% 70% at 80% 100%, #b02f8a 0%, rgba(176,47,138,0) 60%), linear-gradient(180deg,#070a12 0%,#0d1220 60%,#04060b 100%)' },
    { id: 'bg-housewarm', name: 'Full House', cat: 'Church', type: 'gradient', motion: 'drift',
      value: 'radial-gradient(70% 60% at 50% 92%, #e0a33f 0%, rgba(224,163,63,0.18) 40%, rgba(224,163,63,0) 68%), linear-gradient(180deg,#0b0a08 0%,#1b150d 58%,#050403 100%)' },

    /* ---- Ocean & water ---- */
    { id: 'bg-oceandeep', name: 'Open Water', cat: 'Nature', type: 'image', motion: 'drift', value: svgUri(oceanDeep) },
    { id: 'bg-underwater', name: 'Below the Surface', cat: 'Nature', type: 'image', motion: 'sway', value: svgUri(underwater) },
    { id: 'bg-shore', name: 'Shore at Dawn', cat: 'Nature', type: 'image', motion: 'drift', value: svgUri(shore) },

    /* ---- Modern: the contemporary "mesh gradient" look ---- */
    { id: 'bg-mesh-dusk', name: 'Dusk Mesh', cat: 'Modern', type: 'gradient', motion: 'drift',
      value: 'radial-gradient(60% 60% at 12% 18%, #5b3bd6 0%, rgba(91,59,214,0) 62%), radial-gradient(58% 58% at 88% 22%, #d6407a 0%, rgba(214,64,122,0) 60%), radial-gradient(70% 70% at 50% 96%, #1e6fd9 0%, rgba(30,111,217,0) 64%), linear-gradient(180deg,#080a18 0%,#0d1024 100%)' },
    { id: 'bg-mesh-teal', name: 'Teal Mesh', cat: 'Modern', type: 'gradient', motion: 'drift',
      value: 'radial-gradient(60% 60% at 18% 82%, #12b3a3 0%, rgba(18,179,163,0) 62%), radial-gradient(56% 56% at 84% 26%, #2f6ad9 0%, rgba(47,106,217,0) 60%), linear-gradient(160deg,#04120f 0%,#06182a 100%)' },
    { id: 'bg-mesh-ember', name: 'Ember Mesh', cat: 'Modern', type: 'gradient', motion: 'breathe',
      value: 'radial-gradient(58% 58% at 22% 16%, #e0563f 0%, rgba(224,86,63,0) 60%), radial-gradient(62% 62% at 78% 88%, #8a2b6b 0%, rgba(138,43,107,0) 62%), linear-gradient(180deg,#100608 0%,#1a0a10 100%)' },
    { id: 'bg-mesh-mono', name: 'Graphite', cat: 'Modern', type: 'gradient', motion: 'push',
      value: 'radial-gradient(70% 60% at 30% 10%, #3b4250 0%, rgba(59,66,80,0) 62%), radial-gradient(60% 60% at 80% 90%, #232a36 0%, rgba(35,42,54,0) 60%), linear-gradient(180deg,#0b0d12 0%,#05070a 100%)' },
    { id: 'bg-mesh-dawn', name: 'Dawn Mesh', cat: 'Modern', light: true, type: 'gradient', motion: 'drift',
      value: 'radial-gradient(56% 56% at 18% 22%, #ffd9a8 0%, rgba(255,217,168,0) 62%), radial-gradient(60% 60% at 82% 78%, #cfe0ff 0%, rgba(207,224,255,0) 62%), linear-gradient(180deg,#fdf6ec 0%,#eef3fb 100%)' },

  ];

  const CATEGORIES = ['Faith', 'Church', 'Modern', 'Worship', 'Light', 'Atmosphere', 'Nature', 'Texture', 'Season'];

  /** The background object a slide (or a Look) stores. */
  const toBg = (p) => ({ type: p.type, value: p.value, fit: 'cover', dim: 0, preset: p.id, motion: p.motion || undefined });
  const byId = (id) => PRESETS.find((p) => p.id === id) || null;

  window.Backgrounds = { PRESETS, CATEGORIES, toBg, byId, svgUri };
})();
