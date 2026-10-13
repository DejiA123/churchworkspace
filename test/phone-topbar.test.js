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
 *   [3] Home scrolled past the banner: white
 *   [4] the studio: black · Posts and Projects: white
 *   [5] a sheet's dimmed backdrop dims the bar too; closed, it comes back
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
    const settle = async () => { await sleep(900); return (await tint())[0]; };
    const BLUE = '#0a4fc4';

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
    check(dist(home, BLUE) < 12, 'Home: the banner\'s blue runs on into the bar', home);

    console.log('\n[3] Home scrolled');
    // (a new space has little on Home: made as long as a busy church's, so the banner can leave the top)
    await page.evaluate(() => {
      const sc = document.querySelector('#cloudHome .ch-scroll');
      const pad = document.createElement('div'); pad.id = 'tallPad'; pad.style.height = '1600px'; sc.appendChild(pad);
      for (const el of [sc, document.getElementById('cloudHome')]) el.scrollTop = 900;
    });
    const scrolled = await settle();
    check(dist(scrolled, '#ffffff') < 12, 'scrolled past the banner: white (the clock turns dark)', scrolled);
    await page.evaluate(() => { for (const el of [document.querySelector('#cloudHome .ch-scroll'), document.getElementById('cloudHome')]) el.scrollTop = 0; });
    check(dist(await settle(), BLUE) < 12, 'back at the top: blue again', await tint());

    console.log('\n[4] the studio, Posts, Projects');
    await page.evaluate(() => window.MWSocial.go('scheduler'));
    const posts = await settle();
    check(dist(posts, '#ffffff') < 12, 'Posts: white', posts);
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
    check(dist(back, BLUE) < 12, 'back on Home: blue', back);
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
