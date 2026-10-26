'use strict';
/*
 * FINDING A FILE IN "YOUR FILES" (and the AI Montage's chooser, the same sheet):
 * "I should be able to search by name, even some sort of filter".
 *   [1] a search box over the list: every word typed must be in the name, and
 *       "gods" finds "God's"; nothing found says so, with Show everything
 *   [2] chips: Videos / Photos (the kinds there are), Today / This week / This
 *       month, and the order (Newest first → Oldest first → A–Z)
 *   [3] Delete these N, under a search, deletes what is showing — never what
 *       the search has hidden
 *   node test/phone-files-find.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7413, CODE = 'find-test-7731';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-find-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const uid = login.me && login.me.uid;
    const outs = [path.join(MEDIA, 'Church Work Space'), uid ? path.join(DATA, 'spaces', uid, 'Church Work Space') : null].filter(Boolean);
    const mp4 = path.join(WORK, 'clip.mp4'), jpg = path.join(WORK, 'pic.jpg');
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4]);
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640', '-frames:v', '1', jpg]);
    const old = Date.now() / 1000 - 20 * 86400;
    const files = [['Do Not Harden Your Heart to God.mp4', 0], ['Do Not Harden Your Heart to God thumbnail.jpg', 0], ['You Are Too Structured for God.mp4', 0],
      ['Submit Your Thuggery to God\'s Surgery.mp4', 0], ['Anointing for Breakthrough.mp4', old], ['Bishop at the altar.jpg', old], ['Walking in Divine Favour.mp4', old],
      ['Praise Night.mp4', old], ['Easter Sunday.mp4', old]];
    for (const d of outs) {
      fs.mkdirSync(d, { recursive: true });
      for (const [n, t] of files) { const f = path.join(d, n); fs.copyFileSync(/\.jpg$/.test(n) ? jpg : mp4, f); if (t) fs.utimesSync(f, t, t); }
    }
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    // the AI Montage's chooser: videos and pictures, several at a time
    page.evaluate(() => window.api.dialog.openFile([{ name: 'Media', extensions: ['mp4', 'jpg'] }], true));
    await sleep(1500);
    const shown = () => page.evaluate(() => Array.from(document.querySelectorAll('#cloudFilesList .cf-row .cf-tx b')).map((b) => b.textContent));
    const type = async (t) => { await page.fill('#cloudFilesSearch', t); await sleep(400); };

    let st = await page.evaluate(() => ({ box: !document.getElementById('cloudFilesFind').classList.contains('hidden'), chips: Array.from(document.querySelectorAll('#cloudFilesChips .cff-chip')).map((c) => c.textContent) }));
    check(st.box && ['All', 'Videos', 'Photos', 'Today', 'This week', 'This month', 'Newest first'].every((c) => st.chips.includes(c)), '[1][2] a search box, and chips for the kinds, the time and the order', st);
    if (process.env.MW_SHOTS) await page.screenshot({ path: process.env.MW_SHOTS + '/find-1.png' });
    await type('harden');
    if (process.env.MW_SHOTS) await page.screenshot({ path: process.env.MW_SHOTS + '/find-2.png' });
    let s = await shown();
    check(s.length === 2 && s.every((t) => /Harden/.test(t)), '[1] "harden" shows the two Harden files only', s);
    await type('gods  SURGERY');
    s = await shown();
    check(s.length === 1 && /Thuggery/.test(s[0]), '[1] "gods surgery" finds "God\'s Surgery" (any case, the apostrophe left out)', s);
    await type('zzz nothing');
    st = await page.evaluate(() => ({ says: document.getElementById('cloudFilesList').innerText, btn: !!document.querySelector('[data-findclear]') }));
    check(/Nothing matches/.test(st.says) && st.btn, '[1] nothing found says so, with Show everything', st);
    await page.click('[data-findclear]'); await sleep(300);
    s = await shown();
    check(s.length === files.length && (await page.inputValue('#cloudFilesSearch')) === '', '[1] Show everything brings them all back', s.length);
    await type('structured');
    await page.click('#cloudFilesList .cf-row .cf-main'); await sleep(200);
    st = await page.evaluate(() => document.getElementById('cloudFilesSelUse').textContent.trim());
    check(st === 'Add 1', '[1] a file found by searching is ticked to add, as in the full list', st);
    await type('');

    await page.click('#cloudFilesChips [data-kind="photo"]'); await sleep(300);
    s = await shown();
    check(s.length === 2 && s.every((t) => /thumbnail|altar/i.test(t)), '[2] Photos: the two pictures only', s);
    await page.click('#cloudFilesChips [data-kind="video"]'); await sleep(300);
    s = await shown();
    check(s.length === 7 && !s.some((t) => /thumbnail|altar/i.test(t)), '[2] Videos: the seven videos only', s);
    await page.click('#cloudFilesChips [data-when="today"]'); await sleep(300);
    s = await shown();
    check(s.length === 3 && !s.some((t) => /Anointing|Favour/.test(t)), '[2] Videos + Today: the three made today', s);
    await page.click('#cloudFilesChips [data-when="today"]'); await page.click('#cloudFilesChips [data-kind="all"]'); await sleep(300);
    await page.click('#cloudFilesChips [data-sort]'); await sleep(200); await page.click('#cloudFilesChips [data-sort]'); await sleep(300);
    s = await shown();
    st = await page.evaluate(() => document.querySelector('#cloudFilesChips [data-sort]').textContent);
    check(st.trim() === 'A–Z' && JSON.stringify(s) === JSON.stringify(s.slice().sort((a, b) => a.localeCompare(b))), '[2] the order chip: Newest first → Oldest first → A–Z', { st, s });

    // [3] Your files (videos): a search, then Delete these — only what is showing goes
    await page.click('#cloudFilesClose'); await sleep(300);
    await page.evaluate(() => document.getElementById('cloudFiles').click()); await sleep(1500);
    st = await page.evaluate(() => ({ box: !document.getElementById('cloudFilesFind').classList.contains('hidden'), q: document.getElementById('cloudFilesSearch').value }));
    check(st.box && st.q === '', '[1] opened again, the search starts empty', st);
    await type('god');
    st = await page.evaluate(() => (document.querySelector('[data-delall]') || {}).textContent || '');
    check(/Delete these 3/.test(st), '[3] under a search the button says "Delete these 3"', st);
    await page.click('[data-delall]'); await sleep(200); await page.click('[data-delall]'); await sleep(2500);
    const left = outs.map((d) => fs.readdirSync(d).sort());
    check(left.some((l) => l.length === 6 && !l.some((n) => /God.*\.mp4$/.test(n)) && l.includes('Do Not Harden Your Heart to God thumbnail.jpg')), '[3] it deleted the three videos that matched, and kept everything the search hid', left);
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await browser.close(); srv.kill();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
