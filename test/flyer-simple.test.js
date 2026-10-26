'use strict';
/*
 * BRIGHT AND SIMPLE FLYERS (cloud-flyer.js: arch, circle, split, arches,
 * bigword) — "they should be bright, simple, and the cut-outs don't look
 * good". Drawn in Chromium, at the three sizes, with none to three
 * ministers:
 *   - every look builds and draws, and the page is light (not a dark poster);
 *     Arches and Big words show three ministers when there are three
 *   - one colour, clean print: no shadow under a word, no grain over the page
 *   - the CUT-OUT in the frame, on the frame's colour, even when the bank kept
 *     the photo ("it doesn't match how it was cropped in the removed
 *     background"): never the photo's own wall, the face near the top
 *   node test/flyer-simple.test.js
 */
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here — the simple flyers were not drawn.');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, name, d) => { console.log((cond ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !cond ? '  -> ' + JSON.stringify(d) : '')); cond ? pass++ : fail++; };

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://local/**', (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname);
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script>window.MW_FLYER_FONTS="/fonts/"</script><script src="/flyer.js"></script>' });
    const f = p === '/flyer.js' ? path.join(ROOT, 'src/cloud/web/cloud-flyer.js') : p.startsWith('/fonts/') ? path.join(ROOT, 'bin/fonts', p.slice(7)) : null;
    if (!f || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'font/ttf', body: fs.readFileSync(f) });
  });
  await page.goto('http://local/');
  const r = await page.evaluate(async () => {
    const F = window.MWFlyer; await F.loadFonts();
    const cv = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d')); return c; };
    // a photo: a stage in green, a man in a dark suit, his face at (600, 330), shoulders at y 560
    const photo = cv(1200, 1800, (x) => {
      x.fillStyle = '#2f8f4e'; x.fillRect(0, 0, 1200, 1800);
      x.fillStyle = '#1b1b2a'; x.fillRect(420, 540, 360, 1260);
      x.fillStyle = '#8a5a3c'; x.beginPath(); x.ellipse(600, 330, 110, 140, 0, 0, Math.PI * 2); x.fill();
    });
    const pt = (px, py) => ({ x: px / 1200, y: py / 1800, visibility: 0.99 });
    const lm = Array.from({ length: 33 }, () => pt(600, 330));
    Object.assign(lm, { 0: pt(600, 340), 11: pt(470, 560), 12: pt(730, 560), 15: pt(500, 980), 16: pt(700, 980), 23: pt(520, 1100), 24: pt(680, 1100) });
    F.IMGS.set('kr:p1', photo); F.META.set('kr:p1', F.photoMeta(lm, 1200, 1800));
    // the cut-out of it (no pose here: framed by its outline)
    const cut = cv(400, 1300, (x) => { x.fillStyle = '#1b1b2a'; x.fillRect(20, 240, 360, 1060); x.fillStyle = '#8a5a3c'; x.beginPath(); x.ellipse(200, 130, 110, 130, 0, 0, Math.PI * 2); x.fill(); });
    F.IMGS.set('c1', cut);
    const fields = { title: 'Sunday Service', date: '2026-11-01', time: '10:00AM', venue: 'The Power House, Galway, H91 958A', church: 'The Power House International', theme: 'Walking in Divine Favour' };
    const pal = { deep: '#030b2b', mid: '#1d4ed8', accent: '#38e1ff', hi: '#ffffff' };
    const lumOf = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0, n = 0; for (let i = 0; i < d.length; i += 4 * 97) { s += (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255; n++; } return s / n; };
    const out = { looks: [...F.SIMPLE], draws: [], dark: [], shadows: [], grain: [], frames: [], three: [], rawUsed: [] };
    const sp1 = [{ id: 'a', name: 'Bishop David Richman', img: 'c1', raw: 'kr:p1', photo: 'p1' }];
    const sp2 = sp1.concat({ id: 'b', name: 'Pastor Grace Richman', img: 'c1', raw: '', photo: 'p2' });
    const sp3 = sp2.concat({ id: 'c', name: 'Minister John Ade', img: 'c1', raw: 'kr:p1', photo: 'p3' });
    for (const look of F.SIMPLE) {
      for (const [w, h] of [[1080, 1350], [1080, 1920], [1080, 1080]]) {
        for (const speakers of [[], sp1, sp2, sp3]) {
          try {
            const S = F.buildScene({ look, w, h, pal, dir: {}, fields, speakers });
            const c = F.render(S, document.createElement('canvas'), 0.5);
            out.draws.push(look);
            const L = lumOf(c); if (L < 0.55) out.dark.push([look, h, speakers.length, +L.toFixed(2)]);
            if (S.layers.some((l) => l.type === 'text' && l.shadow)) out.shadows.push(look);
            if (S.finish !== false) out.grain.push(look);
            if (speakers.length === 3 && look !== 'circle') out.three.push([look, S.layers.filter((l) => l.type === 'image' && l.speaker).length]);
            if (S.layers.some((l) => l.type === 'image' && l.img === 'kr:p1')) out.rawUsed.push([look, h, speakers.length]);
            // the cut-out in its frame: on the frame's colour (never the photo's green wall), the face near the top
            const im = S.layers.find((l) => l.type === 'image' && l.img === 'c1' && l.speaker === 'a');
            if (im && h === 1350 && speakers.length === 1) {
              const s = im.src, k = c.width / w;
              // (low down and to one side: inside an arch, a panel and a circle alike)
              const g = c.getContext('2d').getImageData(Math.round((im.x - im.w * 0.3) * k), Math.round((im.y + im.h * 0.3) * k), 1, 1).data;
              const frame = S.layers[S.layers.indexOf(im) - 1];
              const faceAt = (130 / 1300 - s.y) / s.h;   // where the face's middle is, down the frame
              out.frames.push({ look, foot: [g[0], g[1], g[2]], frameIs: frame && frame.name, faceAt: +faceAt.toFixed(2) });
            }
          } catch (e) { out.draws.push('ERR ' + look + ' ' + e.message); }
        }
      }
    }
    // no photo kept: the cut-out goes in the frame, on its colour
    const S = F.buildScene({ look: 'arch', w: 1080, h: 1350, pal, dir: {}, fields, speakers: [{ id: 'a', name: 'X', img: 'c1', raw: '' }] });
    out.cutIn = S.layers.some((l) => l.type === 'image' && l.img === 'c1' && l.arch);
    return out;
  });
  ok(errors.length === 0, 'no errors on the page', errors);
  ok(r.looks.length === 5, 'five bright and simple looks', r.looks);
  ok(r.draws.length === 60 && r.draws.every((d) => !/^ERR/.test(d)), 'each draws at every size, with none, one, two and three ministers', r.draws.filter((d) => /^ERR/.test(d)));
  ok(r.three.filter(([l]) => l === 'arches' || l === 'bigword').every(([, n]) => n === 3), 'three ministers: Arches and Big words show all three', r.three);
  ok(r.dark.length === 0, 'every one is a light page', r.dark);
  ok(r.shadows.length === 0 && r.grain.length === 0, 'clean print: no shadows under words, no grain', { s: r.shadows, g: r.grain });
  ok(r.frames.length >= 4 && r.frames.every((f) => f.frameIs === 'Frame'), 'the cut-out goes in the frame, on the frame', r.frames.map((f) => [f.look, f.frameIs]));
  ok(r.rawUsed.length === 0, 'the photo itself never does, though the bank kept it (its wall, the people beside)', r.rawUsed);
  ok(r.frames.every((f) => Math.abs(f.foot[0] - 0x2f) + Math.abs(f.foot[1] - 0x8f) + Math.abs(f.foot[2] - 0x4e) > 60),
    "no green wall at the frame's foot", r.frames.map((f) => [f.look, f.foot]));
  ok(r.frames.every((f) => f.faceAt > 0.08 && f.faceAt < 0.5), 'the face is in the top half of the frame', r.frames.map((f) => [f.look, f.faceAt]));
  ok(r.cutIn, 'no photo kept: the cut-out goes in the frame instead');
  await b.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
