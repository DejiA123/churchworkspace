'use strict';
/*
 * The plain backgrounds the Go Live switcher offers as an input.
 *
 * These are what an operator drops behind a title, a lower third or a holding
 * slide, so what they must be is QUIET: no subject, no faces, no focal point to
 * fight the words laid over them. Half the old set were photographs — a city at
 * night, a concert crowd, an open Bible — which are lovely pictures and poor
 * backgrounds, and the JPEG grain in the dark ones banded on a projector.
 *
 * They are PAINTED, not downloaded, and that is the better answer:
 *   • exact 1920×1080 with no compression mush in the gradients,
 *   • no licence to explain to anybody, ever,
 *   • the whole set regenerates from this file if the palette ever changes,
 *   • ~90 KB each instead of half a megabyte of photograph.
 *
 * Painted with a real canvas in Electron (the same trick the flyer exporter
 * uses) because CSS-quality radial meshes, grain and vignettes are exactly what
 * makes a flat gradient look like a photograph of light rather than a fill.
 *
 *   npx electron scripts/build-photos.js             # paint into photos-new/
 *   npx electron scripts/build-photos.js --install   # …and install them
 *   npx electron scripts/build-photos.js --sheet     # contact sheet to eyeball
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'src', 'renderer', 'assets', 'photos');
const STAGE = path.join(ROOT, 'src', 'renderer', 'assets', 'photos-new');
const W = 1920, H = 1080;

/*
 * The set. `stops` are radial pools of light painted over `base`, each
 * [x, y, radius, colour] in fractions of the frame — a mesh gradient, which is
 * what gives these depth rather than the flat banding of a two-stop linear.
 * `mood` decides the grain and vignette weight.
 */
const BACKGROUNDS = [
  { name: 'plain-dawn-blue.jpg', base: '#0b1b3a', mood: 'deep', stops: [
    [0.22, 0.18, 0.85, '#2a5fb0'], [0.78, 0.30, 0.70, '#1b3f7d'], [0.55, 0.95, 0.80, '#071026'] ] },
  { name: 'plain-cream-peach.jpg', base: '#f6ead9', mood: 'light', stops: [
    [0.25, 0.25, 0.85, '#ffe6c9'], [0.80, 0.35, 0.70, '#f8d3b0'], [0.55, 1.00, 0.75, '#e9c8a6'] ] },
  { name: 'plain-teal-midnight.jpg', base: '#06181d', mood: 'deep', stops: [
    [0.30, 0.25, 0.80, '#0f4c5c'], [0.82, 0.55, 0.65, '#12626f'], [0.50, 1.00, 0.80, '#041014'] ] },
  { name: 'plain-rose-blush.jpg', base: '#2a1220', mood: 'deep', stops: [
    [0.28, 0.22, 0.85, '#8f3f63'], [0.80, 0.40, 0.65, '#c9738b'], [0.50, 1.00, 0.75, '#1b0b14'] ] },
  { name: 'plain-charcoal-gold.jpg', base: '#101215', mood: 'deep', stops: [
    [0.50, 0.18, 0.75, '#3a3227'], [0.50, 0.55, 0.55, '#6b5433'], [0.50, 1.00, 0.85, '#0a0b0d'] ] },
  { name: 'plain-sage-calm.jpg', base: '#eef0e6', mood: 'light', stops: [
    [0.28, 0.28, 0.85, '#f3f5ec'], [0.78, 0.42, 0.70, '#d9e0cb'], [0.55, 1.00, 0.75, '#c8d2bb'] ] },
  { name: 'plain-aurora.jpg', base: '#04121c', mood: 'deep', stops: [
    [0.22, 0.35, 0.75, '#0f6b6b'], [0.62, 0.20, 0.65, '#1f4f8f'], [0.85, 0.70, 0.60, '#2a7f6a'], [0.45, 1.00, 0.80, '#020a10'] ] },
  { name: 'plain-amber-haze.jpg', base: '#1d1206', mood: 'deep', stops: [
    [0.30, 0.30, 0.85, '#8a5a1c'], [0.78, 0.28, 0.60, '#c98a34'], [0.50, 1.00, 0.80, '#120b04'] ] },
  { name: 'plain-plum-indigo.jpg', base: '#150a24', mood: 'deep', stops: [
    [0.25, 0.25, 0.80, '#4b2472'], [0.80, 0.45, 0.70, '#2b3480'], [0.50, 1.00, 0.80, '#0b0616'] ] },
  { name: 'plain-ivory-paper.jpg', base: '#f4f1ea', mood: 'paper', stops: [
    [0.30, 0.25, 0.90, '#fbf9f4'], [0.75, 0.55, 0.75, '#eae4d8'], [0.50, 1.00, 0.80, '#ded7c8'] ] },
  { name: 'plain-slate-blue.jpg', base: '#161c27', mood: 'deep', stops: [
    [0.28, 0.22, 0.85, '#2c3a52'], [0.80, 0.50, 0.70, '#3b4a66'], [0.50, 1.00, 0.80, '#0d1119'] ] },
  { name: 'plain-warm-studio.jpg', base: '#1a1614', mood: 'deep', stops: [
    [0.50, 0.20, 0.70, '#4a3d34'], [0.20, 0.70, 0.55, '#2a221d'], [0.85, 0.80, 0.55, '#332a24'] ] },
];

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head>
<body><canvas id="c" width="${W}" height="${H}"></canvas><script>
window.paint = function (spec) {
  const c = document.getElementById('c'), x = c.getContext('2d');
  x.fillStyle = spec.base; x.fillRect(0, 0, ${W}, ${H});
  // Mesh: each pool of light is a radial gradient fading to transparent, so
  // they blend into one another instead of stacking as discs.
  for (const [px, py, pr, col] of spec.stops) {
    const g = x.createRadialGradient(px * ${W}, py * ${H}, 0, px * ${W}, py * ${H}, pr * ${W});
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    /*
     * A DARK mesh is built by ADDING light — that is what gives it the glow of
     * a lit backdrop. A light one cannot be: adding to an already-bright base
     * runs everything to white, which is exactly what the first pass produced
     * (a cream and a sage that were both, in the end, paper). Light moods paint
     * their pools normally instead, so the colour that was designed is the
     * colour that survives.
     */
    const light = spec.mood === 'light' || spec.mood === 'paper';
    x.globalCompositeOperation = light ? 'source-over' : 'lighter';
    x.globalAlpha = light ? 0.85 : 0.9;
    x.fillStyle = g; x.fillRect(0, 0, ${W}, ${H});
  }
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1;
  // Vignette: what stops a gradient reading as a flat fill.
  const v = x.createRadialGradient(${W} / 2, ${H} * 0.45, ${H} * 0.25, ${W} / 2, ${H} * 0.5, ${W} * 0.75);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, spec.mood === 'light' || spec.mood === 'paper' ? 'rgba(60,50,40,0.20)' : 'rgba(0,0,0,0.55)');
  x.fillStyle = v; x.fillRect(0, 0, ${W}, ${H});
  // Grain: a projector bands a clean gradient into visible steps; a little
  // noise dithers it away. Paper gets more of it, on purpose.
  const amt = spec.mood === 'paper' ? 16 : 7;
  const img = x.getImageData(0, 0, ${W}, ${H}), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * amt;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
};
</script></body></html>`;

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const tmpPage = path.join(app.getPath('temp'), 'mw-bg-paint.html');
  fs.writeFileSync(tmpPage, PAGE);
  const win = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: true } });
  await win.loadFile(tmpPage);
  fs.mkdirSync(STAGE, { recursive: true });

  const made = [];
  for (const spec of BACKGROUNDS) {
    const data = await win.webContents.executeJavaScript(`window.paint(${JSON.stringify(spec)})`);
    const buf = Buffer.from(String(data).split(',')[1], 'base64');
    fs.writeFileSync(path.join(STAGE, spec.name), buf);
    made.push(spec.name);
    console.log(`  ✓ ${spec.name.padEnd(26)} ${(buf.length / 1024).toFixed(0)} KB`);
  }

  if (process.argv.includes('--sheet')) {
    const cells = made.map((n) =>
      `<figure><img src="${path.join(STAGE, n).replace(/\\/g, '/')}"><figcaption>${n}</figcaption></figure>`).join('');
    const sheet = path.join(STAGE, 'contact-sheet.html');
    fs.writeFileSync(sheet, `<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:#111;color:#ddd;font:13px system-ui;display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:10px}
      figure{margin:0} img{width:100%;display:block;border-radius:6px} figcaption{padding:4px 2px}
      </style>${cells}`);
    const shot = new BrowserWindow({ show: false, width: 1500, height: 1000, webPreferences: { offscreen: true } });
    await shot.loadFile(sheet);
    await new Promise((r) => setTimeout(r, 1200));
    const png = await shot.webContents.capturePage();
    fs.writeFileSync(path.join(STAGE, 'contact-sheet.png'), png.toPNG());
    console.log('contact sheet: ' + path.join(STAGE, 'contact-sheet.png'));
  }

  if (process.argv.includes('--install')) {
    // The photographs that were never backgrounds go; anything the church may
    // have come to rely on by name stays until it is deliberately replaced.
    for (const n of made) fs.copyFileSync(path.join(STAGE, n), path.join(OUT, n));
    fs.writeFileSync(path.join(OUT, 'CREDITS.md'), fs.existsSync(path.join(OUT, 'CREDITS.md'))
      ? fs.readFileSync(path.join(OUT, 'CREDITS.md'), 'utf8').replace(/\n*$/, '\n')
        + '\n## Plain backgrounds\n\nPainted by scripts/build-photos.js — no third-party licence applies.\n'
      : '# Photo credits\n\nPainted by scripts/build-photos.js.\n');
    console.log('installed ' + made.length + ' into ' + OUT);
  }
  console.log(`\n${made.length} painted in ${STAGE}`);
  app.exit(0);
}).catch((e) => { console.error(e); app.exit(1); });
