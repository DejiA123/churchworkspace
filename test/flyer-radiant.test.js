'use strict';
/*
 * RADIANT (cloud-flyer.js) — the flyer a church held up as better than all of
 * ours, made as a look: an electric page of sweeping light turning white at
 * the foot, the title huge and white, the ministers in front of it, WITH over
 * their names on one bar, the whole address, the apps and the number.
 * Drawn in Chromium:
 *   - it draws at the three sizes with none to three ministers
 *   - "Bishop David Richman" and "Pastor Mirella Richman" are named as
 *     "Bishop David & Pastor Mirella Richman"; the whole address is printed,
 *     in up to three lines as even as they go
 *   - each minister stops behind the names bar (a cut-out that ends at the
 *     chest is lowered to it, not left floating; one that goes on is cut there)
 *   - the page is vivid at the top and light at the foot, where the address is
 *   - "this is the standard type of flyer": the board in the studio is it in
 *     four colours — the event's own first, the church's blue next when the
 *     event's are not blue — and the other looks wait for "more designs"
 *   node test/flyer-radiant.test.js
 */
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here — Radiant was not drawn.');
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
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><script>window.MW_FLYER_FONTS="/fonts/";window.MWCloud={};window.api={flyer:{}}</script><script src="/flyer.js"></script>' });
    const f = p === '/flyer.js' ? path.join(ROOT, 'src/cloud/web/cloud-flyer.js') : p.startsWith('/fonts/') ? path.join(ROOT, 'bin/fonts', p.slice(7)) : null;
    if (!f || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'font/ttf', body: fs.readFileSync(f) });
  });
  await page.goto('http://local/');
  const r = await page.evaluate(async () => {
    const F = window.MWFlyer; await F.loadFonts();
    const cv = (w, h, fn) => { const c = document.createElement('canvas'); c.width = w; c.height = h; fn(c.getContext('2d')); return c; };
    // two cut-outs: one whole (to the knees), one that stops at the chest (as the server leaves one stood at a lectern)
    const person = (h) => cv(420, h, (x) => { x.fillStyle = '#20202c'; x.fillRect(40, 250, 340, h - 250); x.fillStyle = '#8a5a3c'; x.beginPath(); x.ellipse(210, 130, 95, 120, 0, 0, Math.PI * 2); x.fill(); });
    F.IMGS.set('tall', person(1300)); F.IMGS.set('bust', person(560));
    const fields = { title: 'Sunday Service', date: '2026-10-11', time: '10:00AM', church: 'The Power House International', handles: '@The Power House International', phone: '+353 87 923 0934',
      venue: 'The Power House International Church, Unit 22 Marangonii House, Oldenway Business Park, Monivea Road, Galway (H91 958A)' };
    const pal = { deep: '#04114f', mid: '#1f45f0', accent: '#38d6ff', hi: '#ffffff' };
    const sp = [{ id: 'a', name: 'Bishop David Richman', img: 'bust' }, { id: 'b', name: 'Pastor Mirella Richman', img: 'tall' }, { id: 'c', name: 'Minister John Ade', img: 'tall' }];
    const stat = (c, y0, y1, x1 = 1) => { const x = c.getContext('2d'), d = x.getImageData(0, Math.round(y0 * c.height), Math.round(x1 * c.width), Math.round((y1 - y0) * c.height)).data; let L = 0, S = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 53) { const r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255, mx = Math.max(r, g, bl), mn = Math.min(r, g, bl); L += 0.299 * r + 0.587 * g + 0.114 * bl; S += mx ? (mx - mn) / mx : 0; n++; }
      return { L: L / n, S: S / n }; };
    const out = { draws: [], names: [], venue: '', feet: [], top: null, foot: null };
    for (const [w, h] of [[1080, 1350], [1080, 1080], [1080, 1920]]) {
      for (let n = 0; n <= 3; n++) {
        try {
          const S = F.buildScene({ look: 'radiant', w, h, pal, dir: {}, fields, speakers: sp.slice(0, n) });
          const c = F.render(S, document.createElement('canvas'), 0.5);
          out.draws.push(S.look);
          const nm = S.layers.find((l) => l.name === 'Speakers'); if (nm) out.names.push(nm.text);
          const bar = S.layers.find((l) => l.name === 'Names bar');
          S.layers.filter((l) => l.type === 'image' && l.speaker).forEach((im) => out.feet.push({ h, n, foot: Math.round(im.y + im.h / 2), barT: Math.round(bar.y - bar.h / 2), barB: Math.round(bar.y + bar.h / 2) }));
          if (h === 1350 && n === 2) { out.venue = (S.layers.find((l) => l.name === 'Venue') || {}).text || ''; out.top = stat(c, 0.05, 0.5, 0.04); /* (the page's edge: the title is white) */ out.foot = stat(c, 0.9, 0.97); }
        } catch (e) { out.draws.push('ERR ' + h + '/' + n + ' ' + e.message); }
      }
    }
    // the studio's board: Radiant in four colours
    const St = window.MWFlyerStudio, Fs = St._state;
    Fs.kit = { speakers: [{ id: 's1', name: 'Bishop David Richman', photos: ['p1'] }] }; Fs.speakers = ['s1'];
    Fs.board = null; Fs.bgs = []; Fs.pal = pal; Fs.dir = { looks: ['glory'] }; Fs.fields.title = 'Sunday Service'; Fs.step = 'edit';
    St._rebuild();
    out.board = Fs.designs.map((d) => d.look);
    out.order = Fs.board.order;
    out.pals = Fs.designs.slice(1, 4).map((d) => [d.look, d.pal.mid, (F.RADIANT_WAYS[d.look] || {}).pal]);
    // an event in red: the church's blue comes second
    Fs.board = null; Fs.pal = { deep: '#3b0505', mid: '#c81e1e', accent: '#ffc46b', hi: '#ffffff' };
    St._rebuild();
    out.redBoard = Fs.designs.map((d) => d.look);
    return out;
  });
  ok(errors.length === 0, 'no errors on the page', errors);
  ok(r.draws.length === 12 && r.draws.every((d) => d === 'radiant'), 'it draws at every size with none, one, two and three ministers', r.draws.filter((d) => d !== 'radiant'));
  ok(r.names.includes('Bishop David & Pastor Mirella Richman'), 'one surname is said once: Bishop David & Pastor Mirella Richman', r.names);
  ok(r.names.includes('Bishop David Richman, Pastor Mirella Richman & Minister John Ade'), 'three are all named', r.names);
  ok(r.venue === 'The Power House International Church,\nUnit 22 Marangonii House, Oldenway Business Park,\nMonivea Road, Galway (H91 958A)', 'the whole address, in three even lines', r.venue);
  ok(r.feet.length === 18 && r.feet.every((f) => f.foot > f.barT && f.foot <= f.barB), 'every minister stops behind the names bar (lowered to it, or cut there)', r.feet.filter((f) => !(f.foot > f.barT && f.foot <= f.barB)));
  ok(r.top && r.top.S > 0.5 && r.top.L < 0.7, 'the page is vivid at the top', r.top);
  ok(r.foot && r.foot.L > 0.8, 'and light at the foot, where the address is read', r.foot);
  ok(r.board[0] === 'radiant' && r.board.slice(1, 4).every((l) => /^radiant./.test(l)) && new Set(r.board.slice(0, 4)).size === 4, 'the board is Radiant, in four different colours', r.board);
  ok(!r.board.slice(1, 4).includes('radiantblue'), 'an event in blue already: no second blue', r.board);
  ok(r.pals.every(([, mid, way]) => way && way.mid === mid), 'each colour is drawn in its own colours', r.pals);
  ok(r.redBoard[0] === 'radiant' && r.redBoard[1] === 'radiantblue', "an event in red: the church's blue next", r.redBoard);
  ok(r.order.slice(4, 8).some((l) => !/^radiant/.test(l)) && r.order.includes('arch') && r.order.includes('glory'), 'the other looks are still there, on "more designs"', r.order.slice(0, 10));
  await b.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
