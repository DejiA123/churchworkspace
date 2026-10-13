'use strict';
/*
 * THE BAR ABOVE THE APP WEARS THE SCREEN'S COLOUR (cloud-boot.js topTint).
 *
 * "The black bar at the top where the time and wifi are — make it blue too,
 * like CapCut." An iPhone home-screen app has an opaque status bar that iOS
 * fills with theme-color; it was black whatever the screen. Now:
 *
 *   [1] the page asks for iOS's default bar (no see-through style: broken on
 *       iOS 26+) and has ONE theme-color
 *   [2] sign-in and Home: the banner's blue
 *   [2b] Home and sign-in cannot be pulled down past the top: iOS stretched
 *       them and showed the white behind the banner (the bar went white too)
 *   [3] Home scrolled: the bar follows the banner's fade (a lighter blue half
 *       way up it, white past it), and what slides under it fades into it
 *       (CapCut's soft edge) — none of that at rest
 *   [4] the studio: black · Posts and Projects: white
 *   [5] a sheet's dimmed backdrop dims the bar too; closed, it comes back
 *   [5b] a page's pinned title bar (AI Montage, Posts): no hairline under it,
 *       and what scrolls up fades into it once the page is scrolled
 *   [6] iOS 26 reads the colour off a solid fixed strip on the top edge, not
 *       theme-color: the strip is there in every one of those colours, full
 *       width, put in afresh when the colour changes, and the page's own
 *       background follows; taps just under it still reach the top buttons
 *
 *   node test/phone-topbar.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const PORT = 7388, CODE = 'topbar-test-2719';
const WORK = path.join(os.tmpdir(), 'mw-topbar-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const post = (p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };
// how far two #rrggbb colours are apart (0..441)
const dist = (a, b) => { const p = (h) => [1, 3, 5].map((i) => parseInt(String(h).slice(i, i + 2), 16)); const x = p(a), y = p(b); return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]); };

(async () => {
  const VID = path.join(MEDIA, 'Sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6',
    '-c:v', 'libvpx-vp9', '-b:v', '150k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await up())) throw new Error('server did not start');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'no page errors', e.message));
    const tint = () => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
    // what iOS 26 reads: the strip on the top edge (and the page's background)
    const edge = () => page.evaluate(() => {
      const all = document.querySelectorAll('.mw-edge-tint'), s = all[0];
      if (!s) return { n: 0 };
      const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
      const hex = (c) => '#' + (c.match(/\d+/g) || []).slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('');
      return { n: all.length, top: r.top, h: r.height, w: r.width, full: Math.abs(r.width - innerWidth) < 1, pos: cs.position, color: hex(cs.backgroundColor),
        opaque: !/rgba\(.*,\s*0?\.\d+\)$/.test(cs.backgroundColor), page: hex(getComputedStyle(document.documentElement).backgroundColor), id: s.dataset.k || (s.dataset.k = String(Math.random())) };
    });
    const seen = [];
    const settle = async () => {
      await sleep(900);
      const m = (await tint())[0], e = await edge();
      seen.push(Object.assign({ meta: m }, e));
      return m;
    };
    const BLUE = '#0a4fc4';
    const HOME = '#f4f1fb';   // Church Space's own Home (design D): a soft lilac page

    console.log('\n[1] the page');
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    const head = await page.evaluate(() => ({
      style: (document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]') || {}).content || null,
      capable: (document.querySelector('meta[name="apple-mobile-web-app-capable"]') || {}).content,
    }));
    check(head.style === null, 'no see-through (or black) status-bar style: iOS gives the opaque bar tinted with theme-color', head.style);
    check(head.capable === 'yes', 'still a full-screen home-screen app');
    const man = JSON.parse(await (await ctx.request.get(`http://127.0.0.1:${PORT}/manifest.webmanifest`)).text());
    check(man.theme_color === BLUE, 'the app starts in the banner\'s blue (manifest)', man.theme_color);

    console.log('\n[2] sign-in and Home');
    await page.waitForSelector('#cloudGate:not(.gone)', { timeout: 30000 });
    const gate = await settle();
    check((await tint()).length === 1, 'one theme-color', await tint());
    check(dist(gate, BLUE) < 12, 'sign-in: the bar is the sign-in page\'s blue', gate);
    const login = await post('/api/login', { create: true, code: CODE, name: 'Deji Ade', password: 'tester-pass-1', remember: true });
    await page.evaluate((t) => { localStorage.setItem('mw.cloud.token', t); }, login.token);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('cloudHome') && document.body.classList.contains('mw-home'), null, { timeout: 30000 });
    const home = await settle();
    check(dist(home, HOME) < 12, 'Home: the page\'s lilac runs on into the bar', home);
    // pulled down from the top it showed the white page behind the banner (and the bar went white): it does not stretch
    const stretch = await page.evaluate(() => ({
      home: getComputedStyle(document.querySelector('#cloudHome .ch-scroll')).overscrollBehaviorY,
      gate: getComputedStyle(document.getElementById('cloudGate')).overscrollBehaviorY,
      app: getComputedStyle(document.documentElement).overscrollBehaviorY,
    }));
    check(stretch.home === 'none' && stretch.gate === 'none' && stretch.app === 'none', 'Home and the sign-in page cannot be pulled down past the top (no white above the banner)', stretch);

    // pulled away for a moment, nothing at the top: the bar keeps its colour (it went white)
    const kept = await page.evaluate(() => {
      const T = window.MWCloud && window.MWCloud.topTint;
      if (!T) return 'no handle';
      const real = document.elementsFromPoint.bind(document);
      document.elementsFromPoint = () => [document.documentElement];
      try { T.check(); } finally { document.elementsFromPoint = real; }
      return document.querySelector('meta[name="theme-color"]').content;
    });
    check(dist(kept, HOME) < 12, 'nothing at the top for a moment (the app stretched): the bar keeps Home\'s colour, not white', kept);
    console.log('\n[3] Home scrolled');
    const fadeOp = () => page.evaluate(() => { const f = document.querySelector('.mw-edge-fade'); return f ? +getComputedStyle(f).opacity : null; });
    check(await fadeOp() === 0, 'at rest, no fade over the top of Home', await fadeOp());
    // (a new space has little on Home: made as long as a busy church's, so it can scroll)
    await page.evaluate(() => {
      const sc = document.querySelector('#cloudHome .ch-scroll');
      const pad = document.createElement('div'); pad.id = 'tallPad'; pad.style.height = '1600px'; sc.appendChild(pad);
      sc.scrollTop = 160;
    });
    const mid = await settle();
    check(dist(mid, HOME) < 12, 'scrolled a little: the bar stays Home\'s own colour', mid);
    check(await fadeOp() === 1, 'scrolled: the soft edge is on, so what slides under the bar fades into it', await fadeOp());
    const fadeBg = await page.evaluate(() => getComputedStyle(document.querySelector('.mw-edge-fade')).backgroundImage);
    const fadeTop = '#' + (fadeBg.match(/\d+/g) || []).slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('');
    check(dist(fadeTop, mid) < 4, 'the edge fades from the bar\'s own colour', { fadeTop, mid });
    await page.evaluate(() => { for (const el of [document.querySelector('#cloudHome .ch-scroll'), document.getElementById('cloudHome')]) el.scrollTop = 900; });
    const scrolled = await settle();
    check(dist(scrolled, HOME) < 12, 'scrolled further: still Home\'s colour (the clock stays dark on it)', scrolled);
    await page.evaluate(() => { for (const el of [document.querySelector('#cloudHome .ch-scroll'), document.getElementById('cloudHome')]) el.scrollTop = 0; });
    check(dist(await settle(), HOME) < 12, 'back at the top: the same colour', await tint());
    check(await fadeOp() === 0, 'and the fade is gone', await fadeOp());

    console.log('\n[4] the studio, Posts, Projects');
    await page.evaluate(() => window.MWSocial.go('scheduler'));
    const posts = await settle();
    check(dist(posts, '#ffffff') < 12, 'Posts: white', posts);
    // its back button sits in a pinned bar: what scrolls goes under THAT, so no fade over it
    await page.evaluate(() => {
      const sc = document.querySelector('.cloud-sched .csb-scroll') || document.querySelector('.csb-scroll');
      if (!sc) return;
      const pad = document.createElement('div'); pad.style.height = '1500px'; sc.appendChild(pad); sc.scrollTop = 300;
    });
    const postsScrolled = await settle();
    check(dist(postsScrolled, '#ffffff') < 12 && await fadeOp() === 0, 'Posts scrolled: its pinned top bar stays sharp (no fade over it), the bar white', { postsScrolled, fade: await fadeOp() });
    await page.evaluate(() => window.MWSocial.go('projects'));
    const proj = await settle();
    check(dist(proj, '#ffffff') < 12, 'Projects: white', proj);
    await page.evaluate(async (p) => { window.MWSocial.go('studio'); await window.VideoEditor.openPath(p); }, VID);
    await page.waitForFunction(() => document.body.classList.contains('mw-in-studio'), null, { timeout: 30000 });
    const studio = await settle();
    check(dist(studio, '#000000') < 12, 'the studio: black, like its own top', studio);

    console.log('\n[5] a sheet');
    await page.evaluate(() => window.VideoEditor.presets());
    await page.waitForSelector('#vePresetModal:not(.hidden)');
    const dim = await settle();
    check(dist(dim, '#000000') < 40, 'a sheet open over the studio: the bar stays dark with its backdrop', dim);
    await page.evaluate(() => window.MWSocial.go('home'));
    await page.evaluate(() => { const m = document.getElementById('vePresetModal'); if (m) m.classList.add('hidden'); });
    const back = await settle();
    check(dist(back, HOME) < 12, 'back on Home: its own colour', back);

    console.log('\n[5b] a page\'s title bar');
    const softHead = (sel) => page.evaluate((sel) => {
      const h = document.querySelector(sel); if (!h) return null;
      const a = getComputedStyle(h, '::after'), cs = getComputedStyle(h);
      return { on: h.classList.contains('on'), soft: h.classList.contains('mw-softedge'), fade: +a.opacity, top: a.backgroundImage.slice(0, 40),
        line: cs.borderBottomStyle !== 'none' && parseFloat(cs.borderBottomWidth) > 0, bg: cs.backgroundColor, rgb: h.style.getPropertyValue('--soft-rgb') };
    }, sel);
    await page.evaluate(() => window.MWSocial.openMontage());
    await page.waitForSelector('#cloudMontage .cp-body');
    await sleep(700);
    const mt0 = await softHead('#cloudMontage .cp-head');
    check(mt0 && !mt0.line, 'AI Montage: no line under its title bar', mt0);
    await page.evaluate(() => { const b = document.querySelector('#cloudMontage .cp-body'); const p = document.createElement('div'); p.style.height = '1400px'; b.appendChild(p); b.scrollTop = 200; });
    await sleep(600);
    const mt1 = await softHead('#cloudMontage .cp-head');
    check(mt1 && mt1.on && mt1.fade === 1, 'scrolled: what goes up under it fades into it', mt1);
    check(mt1 && /246, 247, 249/.test(mt1.rgb) && /rgb\(246, 247, 249\)/.test(mt1.top), 'in the title bar\'s own colour', mt1 && { rgb: mt1.rgb, top: mt1.top });
    await page.evaluate(() => { document.querySelector('#cloudMontage .cp-body').scrollTop = 0; });
    await sleep(600);
    const mt2 = await softHead('#cloudMontage .cp-head');
    check(mt2 && !mt2.on && mt2.fade === 0, 'back at the top: no fade', mt2);
    await page.evaluate(() => { const x = document.querySelector('#cloudMontage .cp-x'); if (x) x.click(); });
    await sleep(700);
    await page.evaluate(() => window.MWSocial.go('scheduler'));
    await sleep(900);
    await page.evaluate(() => { const sc = document.querySelector('.cloud-sched .csb-scroll'); sc.scrollTop = 40; sc.scrollTop = 300; });
    await sleep(600);
    const ps = await softHead('.cloud-sched .csb-top');
    check(ps && ps.on && ps.fade === 1 && /255, 255, 255/.test(ps.rgb), 'Posts scrolled: the same soft edge under its bar, in white', ps);
    await page.evaluate(() => window.MWSocial.go('home'));
    await sleep(700);

    console.log('\n[6] what iOS 26 reads: a solid strip on the top edge');
    check(seen.every((x) => x.n === 1), 'there is always exactly one strip', seen.map((x) => x.n));
    check(seen.every((x) => x.top === 0 && x.h >= 6 && x.full && x.pos === 'fixed' && x.opaque), 'fixed, on the top edge, full width, at least 6 px tall, solid', seen.map((x) => [x.top, x.h, x.full, x.pos, x.opaque]));
    check(seen.every((x) => x.color === x.meta && x.page === x.meta), 'in each screen\'s colour — the same as theme-color, and the page\'s background with it', seen.map((x) => [x.meta, x.color, x.page]));
    const ids = seen.map((x) => x.id), cols = seen.map((x) => x.meta);
    const remade = cols.every((c, i) => !i || c === cols[i - 1] || ids[i] !== ids[i - 1]);
    check(remade, 'when the colour changes, the strip is a new one (iOS reads it when it appears)', seen.map((x) => [x.meta, x.id.slice(2, 6)]));
    // the top buttons still answer a tap just under the strip
    await page.evaluate(() => { for (const el of [document.querySelector('#cloudHome .ch-scroll'), document.getElementById('cloudHome')]) el.scrollTop = 0; });
    await sleep(500);
    const me = await page.locator('#cloudHome .ch-me').boundingBox();
    const hit = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest('.ch-me')); }, { x: me.x + me.width / 2, y: Math.max(me.y + 2, 7) });
    check(me.y >= 6 && hit, 'the strip lies above the top buttons, not over them (the avatar still takes a tap)', { top: me.y, hit });
  } catch (e) {
    check(false, 'ran to the end', e.message);
  } finally {
    await browser.close().catch(() => {});
    srv.kill(); await sleep(600);
    try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
