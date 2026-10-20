'use strict';
/*
 * The AI Montage's "your montage" sheet (and its other sheets) are LIGHT like
 * the AI Montage page: every word readable on the white sheet. They kept the
 * old dark theme's white text on a white sheet ("I can't see the text").
 * Checks the contrast of each piece of text against what is behind it.
 *   node test/phone-montage-done.test.js     (MW_SHOTS=<dir> saves a screenshot)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here — the montage sheet was not tested.');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const PORT = 7463;
const CODE = 'montage-done-test-8810';
const WORK = path.join(os.tmpdir(), 'mw-mtdone-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
async function waitUp() {
  for (let k = 0; k < 60; k++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); }
  }
  return false;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWSocial && window.MWSocial._mtResult, null, { timeout: 30000 });
    await page.evaluate(() => window.MWSocial._mtResult({
      title: 'Gospel Jamz 2026 Day 1 recap, them', duration: 29, mode: 'talk', lines: 6, shots: new Array(10).fill({}),
      concept: 'Represent Christ in every post you make', autoCaps: 'talk', output: '/nowhere.mp4', project: 'p1',
      postCaption: 'Represent Christ in every post you make 🙌\n\nYour content can point people to Jesus, even in a hype vibe.', hashtags: ['GospelJamz'],
    }));
    await page.waitForSelector('#cloudMontageDone .mt-brief', { timeout: 10000 });
    await sleep(500);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'montage-done.png') });
    // every piece of text against the colour behind it (the nearest painted background up the tree)
    const rows = await page.evaluate(() => {
      const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const behind = (el) => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length >= 3 && (c[3] == null || c[3] > 0.5)) return c; } return [255, 255, 255]; };
      const sel = ['.cp-title', '.mt-lead', '.mt-concept', '.mt-tip', '.mt-sec h3', '.mt-brief', '[data-mt-copy]', '[data-mt-shots]', '[data-mt-ok]'];
      return sel.map((q) => {
        const el = document.querySelector('#cloudMontageDone ' + q); if (!el) return { q, missing: true };
        const fg = rgb(getComputedStyle(el).color), bg = behind(el);
        const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        return { q, ratio: +ratio.toFixed(2), fg: getComputedStyle(el).color, bg: 'rgb(' + bg.slice(0, 3).join(',') + ')' };
      });
    });
    for (const r of rows) {
      // body text 4.5:1, the small grey labels (a heading in capitals) at least 3:1
      const need = r.q === '.mt-sec h3' ? 3 : 4.5;
      check(!r.missing && r.ratio >= need, `${r.q}: readable on the sheet (${r.ratio}:1, needs ${need}:1)`, r);
    }
    const sheet = await page.evaluate(() => getComputedStyle(document.getElementById('cloudMontageDone')).backgroundColor);
    // three takes from one video: the two others are made after it, each around its own idea, and listed to watch
    const takes = await page.evaluate(async () => {
      const asked = [];
      window.api.montage.create = async (a) => { asked.push(a); await new Promise((r) => setTimeout(r, 150)); return { output: '/media/montage-take' + asked.length + '.mp4', title: 'Take ' + (asked.length + 1), duration: 30 }; };
      window.MWSocial._mtResult({ title: 'Recap', duration: 29, mode: 'talk', lines: 6, shots: [], postCaption: 'x', moreArgs: { mediaPaths: ['/media/sermon.mp4'], mode: 'talk', style: 'hype' } });
      for (let i = 0; i < 40 && document.querySelectorAll('#mtTakes [data-mt-take]').length < 2; i++) await new Promise((r) => setTimeout(r, 100));
      return { n: document.querySelectorAll('#mtTakes [data-mt-take]').length, angles: asked.map((a) => a.angle), same: asked.every((a) => a.mediaPaths[0] === '/media/sermon.mp4' && a.mode === 'talk') };
    });
    check(takes.n === 2 && takes.same && takes.angles.length === 2 && takes.angles[0] !== takes.angles[1], 'a Viral montage makes two more takes of the same video, each around its own idea, ready to watch', takes);
    check(/255, 255, 255|246, 247, 249/.test(sheet), 'the sheet is light, like the AI Montage page', sheet);
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    try { await browser.close(); } catch (e) {}
    try { srv.kill(); } catch (e) {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
