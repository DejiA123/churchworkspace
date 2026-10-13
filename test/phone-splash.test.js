'use strict';
/*
 * OPENING THE APP: "when I close the app completely and open it, it shows the
 * login page for a split second, then Home." The page drew the sign-in card
 * first and only then asked the server who was here. Now a launch screen (the
 * icon, the name, a running bar) is up from the first paint until that answer:
 *   [1] signed in: what is on screen goes launch screen → Home; the sign-in
 *       page is never seen, even with the server slow to answer
 *   [2] the launch screen really shows the icon and the bar, and is gone after
 *   [3] signed out: the launch screen gives way to the sign-in page
 *
 *   node test/phone-splash.test.js            (MW_SHOTS=dir for screenshots)
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const PORT = 7419, CODE = 'splash-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-splash-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (!ok && d !== undefined ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const post = (p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };

// every frame from the first: which screen is under the middle of the phone
const WATCH = () => {
  window.__seen = [];
  const look = () => {
    const el = document.elementFromPoint(innerWidth / 2, innerHeight * 0.45);
    const who = !el ? 'none' : el.closest('#mwSplash') ? 'splash' : el.closest('#cloudGate') ? 'signin' : el.closest('.ch-scroll, #cloudHome, .cloud-home') ? 'home' : 'other';
    const s = window.__seen;
    if (s[s.length - 1] !== who) s.push(who);
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
};

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const SHOTS = process.env.MW_SHOTS || '';
  try {
    if (!(await up())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Deji Ade', password: 'tester-pass-1', remember: true });

    // [1] [2] signed in, the server slow to say so (a phone waking on mobile data)
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    await ctx.addInitScript(WATCH);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    let first = true;
    await page.route('**/api/hello', async (route) => { if (first) { first = false; await sleep(900); } route.continue(); });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await sleep(500);
    const mid = await page.evaluate(() => {
      const sp = document.getElementById('mwSplash'); const img = sp && sp.querySelector('.mw-splash-icon'); const bar = sp && sp.querySelector('.mw-splash-bar i');
      return { up: !!sp && getComputedStyle(sp).opacity === '1', icon: !!img && img.complete && img.naturalWidth > 0, name: sp ? sp.innerText.trim() : '', running: !!bar && getComputedStyle(bar).animationName === 'mwSplashRun' };
    });
    if (SHOTS) await page.screenshot({ path: SHOTS + '/splash.png' });
    check(mid.up && mid.icon && /Church Space/.test(mid.name) && mid.running, '[2] while it asks: the launch screen, with the app icon, its name and a running bar', mid);
    await page.waitForFunction(() => !document.getElementById('mwSplash'), null, { timeout: 15000 }).catch(() => {});
    await sleep(600);
    const seen = await page.evaluate(() => window.__seen);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/splash-home.png' });
    check(!seen.includes('signin'), '[1] signed in: the sign-in page is never on screen, not for a frame', seen);
    check(seen[0] === 'splash' && seen[seen.length - 1] === 'home', '[1] launch screen first, Home last', seen);
    const gone = await page.evaluate(() => !document.getElementById('mwSplash') && !!document.querySelector('#cloudGate.gone'));
    check(gone, '[2] and the launch screen is gone afterwards (nothing left over the app)', gone);
    await ctx.close();

    // [3] signed out
    const ctx2 = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx2.addInitScript(WATCH);
    const p2 = await ctx2.newPage();
    await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
    await p2.waitForFunction(() => !document.getElementById('mwSplash'), null, { timeout: 15000 }).catch(() => {});
    await sleep(300);
    const s2 = await p2.evaluate(() => window.__seen);
    check(s2[s2.length - 1] === 'signin' && !s2.includes('home'), '[3] signed out: the launch screen gives way to the sign-in page', s2);
    await ctx2.close();
  } finally { await browser.close(); srv.kill(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
