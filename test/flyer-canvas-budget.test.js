'use strict';
/*
 * THE FLYERS' CANVAS MEMORY, ON A BUDGET.
 *
 *   "This page is buggy" — the board's designs had their light and bars but no words, no people, no logo.
 *
 * An iPhone gives a page so much canvas memory; past it every new canvas comes out blank, and the words, the
 * people and the logo are each drawn on one first. The flyer's caches kept hundreds of canvases, some at the
 * size a flyer is seen big. Proved here, in a real browser:
 *
 *   [1] flyers drawn again and again, at the board's size and at 3000 px, keep the caches inside their budget
 *   [2] a flyer drawn after all that still has its words on it (what left a cache was not still in use)
 *
 *   node test/flyer-canvas-budget.test.js
 */
const fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here — the canvas budget was not tested.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };

(async () => {
  const b = await chromium.launch();
  try {
    const page = await b.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.route('http://local/**', (route) => {
      const p = decodeURIComponent(new URL(route.request().url()).pathname);
      if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script>window.MW_FLYER_FONTS="/fonts/";window.MWCloud=null;window.api={flyer:{}}</script><script src="/flyer.js"></script>' });
      const f = p === '/flyer.js' ? path.join(ROOT, 'src/cloud/web/cloud-flyer.js') : p.startsWith('/fonts/') ? path.join(ROOT, 'bin/fonts', p.slice(7)) : null;
      if (!f || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'font/ttf', body: fs.readFileSync(f) });
    });
    await page.goto('http://local/');
    const r = await page.evaluate(async () => {
      const F = window.MWFlyer;
      await F.loadFonts();
      const ways = Object.keys(F.RADIANT_WAYS);
      const scene = (title, k) => F.buildScene({ look: ['radiant', 'radiantside', 'radiantspot', 'radiantwave'][k % 4], w: 1080, h: 1350, pal: F.RADIANT_WAYS[ways[k % ways.length]].pal,
        dir: {}, fields: { title, date: '2026-11-01', time: '10AM', venue: 'The Power House International, Galway', church: 'The Power House International' }, speakers: [], logo: null });
      // the words of a flyer, measured: the title's part of it, drawn with and without its words
      const inked = (S) => {
        const a = F.render(S, document.createElement('canvas'), 0.25), bare = F.render(Object.assign({}, S, { layers: S.layers.filter((l) => l.type !== 'text') }), document.createElement('canvas'), 0.25);
        const da = a.getContext('2d').getImageData(0, 0, a.width, a.height).data, db = bare.getContext('2d').getImageData(0, 0, a.width, a.height).data;
        let diff = 0; for (let i = 0; i < da.length; i += 4) diff += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        return diff / (da.length / 4);
      };
      const first = scene('SUNDAY SERVICE', 0);
      const before = inked(first);
      // the board at a phone's size, the live preview, and each flyer seen big — sixty times over
      let peak = { txt: 0, pic: 0, adj: 0 };
      for (let k = 0; k < 60; k++) {
        const S = scene('SERVICE ' + k, k);
        for (const q of [0.45, 0.9, 3000 / 1350]) { const c = F.render(S, document.createElement('canvas'), q); c.width = c.height = 0; }
        const px = F._canvasPx(); peak = { txt: Math.max(peak.txt, px.txt), pic: Math.max(peak.pic, px.pic), adj: Math.max(peak.adj, px.adj) };
      }
      const after = inked(scene('SUNDAY SERVICE', 0));
      return { before, after, peak };
    });
    // (the newest of each may stand alone over its budget: one canvas the size a flyer is seen big)
    check(r.peak.txt <= 8e6 + 7e6 && r.peak.pic <= 10e6 + 7e6 && r.peak.adj <= 6e6 + 7e6, 'drawn sixty times, at every size, the caches stay within their budget', r.peak);
    check(r.before > 2 && r.after > r.before * 0.9, 'a flyer drawn after all that still has its words on it', { before: r.before, after: r.after });
  } catch (e) {
    check(false, 'ran to the end', e.stack || e.message);
  } finally {
    await b.close();
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
})();
