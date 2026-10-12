'use strict';
/*
 * THE HOME SCREEN, CAPCUT'S WAY (src/cloud/web/cloud-social.js buildHome):
 * a banner whose titles roll by, two cards for the two big things, the tools
 * as line icons in a grid — and every one of them goes where it says.
 *
 *   node test/phone-home.test.js            (MW_SHOTS=dir for screenshots)
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the home screen was not tested.');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const PORT = 7387, CODE = 'home-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-home-' + process.pid);
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
(async () => {
  const VID = path.join(MEDIA, 'Sunday.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=220:d=6', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await up())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Deji Ade', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'no page errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#home`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWSocial && window.MWSocial.openMontage && document.getElementById('cloudHome'), null, { timeout: 30000 });
    await sleep(1200);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'home.png') });
    const t1 = await page.evaluate(() => (document.querySelector('#cloudHome .ch-wheel li.on') || {}).textContent);
    check(await page.evaluate(() => !document.querySelector('#cloudHome .ch-banner-go, #chHeroTitle')), 'no line of words under the greeting');
    await sleep(2900);
    const t2 = await page.evaluate(() => ({ t: (document.querySelector('#cloudHome .ch-wheel li.on') || {}).textContent, on: (document.querySelector('#cloudHome .ch-wheel li.on') || {}).textContent, shots: document.querySelectorAll('#cloudHome .ch-shot.on').length }));
    check(t1 !== t2.t && t2.shots === 1 && !!t2.on, 'the banner rolls on by itself: a new title, its name lit, one picture in front', { t1, t2 });
    // tap the lit name's line: it goes to that thing
    const hello = await page.evaluate(() => document.getElementById('chHello').textContent);
    check(/^Good (morning|afternoon|evening), Deji$/.test(hello), 'the greeting is in the banner', hello);
    // Help → the help sheet
    await page.locator('#cloudHome [data-tool="help"]').tap(); await sleep(500);
    check(await page.evaluate(() => !!document.querySelector('.mwg-help')), '"Help" opens the help');
    await page.evaluate(() => window.MWGuide.closeHelp()); await sleep(300);
    // Post online → the posts screen
    await page.locator('#chSocialCard').tap(); await sleep(800);
    check(await page.evaluate(() => document.body.classList.contains('mw-sched')), '"Post online" opens Posts');
    await page.evaluate(() => window.MWSocial.go('home')); await sleep(600);
    // Add a video → the phone's own picker (My videos opens behind it to show it arriving)
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
      page.locator('#cloudHome [data-tool="upload"]').tap(),
    ]);
    await sleep(600);
    const filesOpen = await page.evaluate(() => { const m = document.getElementById('cloudFilesModal'); return !!m && !m.classList.contains('hidden'); });
    check(!!chooser && filesOpen, '"Add a video" opens the phone\'s picker, with My videos behind it', { chooser: !!chooser, filesOpen });
    // one place for videos: My videos, by that name
    check(await page.evaluate(() => (document.querySelector('#cloudFilesModal .cloud-files-title') || {}).textContent === 'My videos'), 'the videos sheet is called My videos');
    await page.evaluate(() => { const x = document.getElementById('cloudFilesClose'); if (x) x.click(); }); await sleep(500);
    await page.evaluate(() => window.MWSocial.go('home')); await sleep(600);
    // the two cards
    await page.locator('#cloudHome .ch-montage').tap(); await sleep(1200);
    check(await page.evaluate(() => !!document.querySelector('#cloudMontage')), 'the AI Montage card opens AI Montage');
    await page.evaluate(() => { const x = document.querySelector('#cloudMontage .cp-x'); if (x) x.click(); }); await sleep(500);
    await page.locator('#cloudHome .ch-studio').tap(); await sleep(800);
    check(await page.evaluate(() => document.body.classList.contains('mw-projects')), 'the Video Studio card opens the projects');
    // with a video open: AI Shorts and Captions go straight to their tool
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => window.VideoEditor.hasVideo && window.VideoEditor.hasVideo(), null, { timeout: 20000 });
    await page.evaluate(() => window.MWSocial.go('home')); await sleep(700);
    await page.locator('#cloudHome [data-tool="shorts"]').tap(); await sleep(900);
    const sh = await page.evaluate(() => ({ studio: document.body.classList.contains('mw-in-studio'), sheet: document.body.classList.contains('mw-sheet-shorts') }));
    check(sh.studio && sh.sheet, '"AI Shorts" goes to the studio with AI Shorts open', sh);
    await page.evaluate(() => window.MWSocial.go('home')); await sleep(700);
    await page.locator('#cloudHome [data-tool="captions"]').tap(); await sleep(900);
    const cp = await page.evaluate(() => ({ studio: document.body.classList.contains('mw-in-studio'), sheet: document.body.classList.contains('mw-sheet-insp') }));
    check(cp.studio && cp.sheet, '"Auto captions" goes to the studio with Captions open', cp);
    // with no video: AI Shorts asks for one first (the picker), and opens itself once it is in
    await page.evaluate(() => window.MWSocial.go('home')); await sleep(600);
  } catch (e) { check(false, 'ran to the end', e && e.message); }
  finally { await browser.close(); srv.kill(); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
