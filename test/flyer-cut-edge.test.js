'use strict';
/*
 * THE CUT-OUT'S EDGE, AS IT GOES INTO MY CHURCH (MWFlyer.tidyCut).
 *
 *   "The cut out of the man here is not good, the shoulders are so pixeled."
 *
 * Every cut-out is tidied on its way into the bank: only the person is kept (a speck of the background, a piece
 * of a chair apart from them, goes) and the empty margin is trimmed. What to keep was decided on a small copy and
 * applied to the photo five pixels square at a time, so a soft shoulder came out in steps. Proved here:
 *
 *   [1] a soft edge stays soft: no step between two neighbouring pixels much steeper than the cut-out's own
 *   [2] a speck apart from the person still goes, and the margin is still trimmed
 *
 *   node test/flyer-cut-edge.test.js
 */
const fs = require('fs'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here — the cut-out edge was not tested.'); process.exit(0); }
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
      if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script>window.MWCloud=null;window.api={flyer:{}}</script><script src="/flyer.js"></script>' });
      if (p === '/flyer.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: fs.readFileSync(path.join(ROOT, 'src/cloud/web/cloud-flyer.js')) });
      return route.fulfill({ status: 404, body: '' });
    });
    await page.goto('http://local/');
    const r = await page.evaluate(async () => {
      // a person: a head and sloping shoulders with a soft, feathered outline — and a speck of background far off
      const W = 1400, H = 1800, c = document.createElement('canvas'); c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.filter = 'blur(7px)'; x.fillStyle = '#d8dce6';
      x.beginPath(); x.ellipse(700, 420, 230, 280, 0, 0, Math.PI * 2); x.fill();
      x.beginPath(); x.moveTo(120, 1800); x.lineTo(260, 900); x.lineTo(1140, 900); x.lineTo(1280, 1800); x.closePath(); x.fill();
      x.filter = 'none';
      const before = x.getImageData(0, 0, W, H).data;   // (the person's own edge, before the speck is added)
      x.fillRect(1330, 60, 40, 40);   // the speck
      const out = await window.MWFlyer.tidyCut(c.toDataURL('image/png'));
      const im = await window.MWFlyer.loadImg(out);
      const w2 = im.naturalWidth || im.width, h2 = im.naturalHeight || im.height;
      const c2 = document.createElement('canvas'); c2.width = w2; c2.height = h2;
      c2.getContext('2d').drawImage(im, 0, 0);
      const after = c2.getContext('2d').getImageData(0, 0, w2, h2).data;
      // the steepest step between neighbouring pixels, round the shoulders and head only (not the photo's own bottom edge)
      const steep = (d, w, h) => { let m = 0; for (let y = 1; y < h - 40; y++) for (let xx = 1; xx < w; xx++) { const i = (y * w + xx) * 4 + 3; m = Math.max(m, Math.abs(d[i] - d[i - 4]), Math.abs(d[i] - d[i - w * 4])); } return m; };
      // the top-right corner of what is left: where the speck was (it is 1330..1370 across, 60..100 down)
      let speck = 0;
      for (let y = 0; y < Math.min(h2, 140); y++) for (let xx = Math.max(0, w2 - 140); xx < w2; xx++) speck = Math.max(speck, after[(y * w2 + xx) * 4 + 3]);
      let sumB = 0, sumA = 0;
      for (let i = 3; i < before.length; i += 4) sumB += before[i];
      for (let i = 3; i < after.length; i += 4) sumA += after[i];
      return { size: [w2, h2], steepBefore: steep(before, W, H), steepAfter: steep(after, w2, h2), speck, kept: sumA / sumB };
    });
    check(r.steepAfter <= r.steepBefore + 8, 'a soft edge stays soft: no hard steps cut into it', r);
    check(r.kept > 0.99, 'the person is all still there (their soft edge too)', r);
    check(r.speck < 10, 'a speck apart from the person still goes', r);
    check(r.size[0] < 1400 && r.size[1] < 1800, 'the empty margin is still trimmed', r.size);
  } catch (e) {
    check(false, 'ran to the end', e.stack || e.message);
  } finally {
    await b.close();
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
})();
