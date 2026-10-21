'use strict';
/*
 * "I GENERATED CAPTIONS, I DON'T SEE THEM IN THE CAPTION EDITOR" — on a phone the
 * Style & settings panel filled the whole sheet and the 1,745 lines sat out of
 * sight below it. On a phone the lines always come first:
 *   A) lines generated while the window is open on its settings: it folds, the lines show
 *   B) settings left open last time (remembered): it still opens on the lines
 *   node test/phone-caption-lines-first.test.js
 */
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(path.join(ROOT, 'node_modules/ffmpeg-static'));
const PORT = 7481, CODE = 'caplines-test-6620';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-caplines-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=15:d=60', '-f', 'lavfi', '-i', 'sine=f=220:d=60',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1000);
    const KEY = await page.evaluate(() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/fold/i.test(k)) return k; } return null; });
    // A: the window opened on its settings (empty), lines generated while it is open
    await page.evaluate(() => { window.api.captions.engineInfo = async () => ({ available: true }); document.getElementById('veAutoCaptions').click(); });
    await sleep(1200);
    const a0 = await page.evaluate(() => document.querySelector('#capModal .cap-box').classList.contains('folded'));
    await page.evaluate(() => { const w = []; for (let i = 0; i < 60; i++) w.push({ text: 'word' + i, start: 2 + i * 0.6, end: 2.5 + i * 0.6 }); window.VideoEditor.__test.setCapWords(w, 0); });
    await sleep(800);
    const a1 = await page.evaluate(() => ({ folded: document.querySelector('#capModal .cap-box').classList.contains('folded'), seen: (() => { const l = document.getElementById('capList').getBoundingClientRect(); return [...document.querySelectorAll('#capList .cap-row')].filter((r) => { const b = r.getBoundingClientRect(); return b.height > 0 && b.bottom > l.top && b.top < Math.min(l.bottom, innerHeight); }).length; })() }));
    check(!a0 && a1.folded && a1.seen >= 2, 'A) lines generated with the settings open: the settings fold and the lines are in sight', { a0, a1 });
    await page.evaluate(() => document.getElementById('capSumToggle').click()); await sleep(300);
    await page.evaluate(() => document.querySelector('#capModal .cap-done, #capModal [data-cap-close], #capClose') && document.querySelector('#capModal .cap-done, #capModal [data-cap-close], #capClose').click());
    await page.evaluate(() => document.getElementById('capModal').classList.add('hidden'));
    await page.evaluate(() => {
      const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 30;
      const T = window.VideoEditor.__test;
      const w = []; for (let i = 0; i < 80; i++) w.push({ text: 'word' + i, start: 2 + i * 0.6, end: 2 + i * 0.6 + 0.5 });
      T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.revealCaps();
    });
    await sleep(800);
    const before = await page.evaluate(() => window.VideoEditor.__test.capLines().length);
    await page.evaluate(() => { window.api.captions.engineInfo = async () => ({ available: true }); document.getElementById('veAutoCaptions').click(); });
    await sleep(2500);
    const st = await page.evaluate(() => ({ folded: document.querySelector('#capModal .cap-box').classList.contains('folded'), pref: (() => { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (/fold/i.test(k)) return k + '=' + localStorage.getItem(k); } return null; })(), modalHidden: document.getElementById('capModal').classList.contains('hidden'), rows: document.querySelectorAll('#capList .cap-row').length, count: (document.getElementById('capCount') || {}).textContent, listText: (document.getElementById('capList') || {}).innerText.slice(0, 300) }));
    check(st.folded && /=0/.test(st.pref || '') && st.rows === before && st.rows > 0, 'B) settings left open last time: on a phone it still opens on the lines', st);
  } catch (e) { check(false, 'the run finished', e.stack); }
  finally { await browser.close(); srv.kill(); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
