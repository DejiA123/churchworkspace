'use strict';
/*
 * MY CHURCH (Flyers → My church) on a phone. Checks:
 *   - every box you type in is readable: dark text on its light ground (the
 *     speaker's name was near-white on light grey — "a text hidden by white")
 *   - each photo in a speaker's bank has its own ✕: tapping it takes that one
 *     photo out (no questions in between), the others stay, and after Save the
 *     server's bank no longer has it
 * MW_SHOTS=<dir> saves screenshots.
 *   node test/phone-flyer-kit.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here — My church was not tested.');
  process.exit(0);
}
const ROOT = path.join(__dirname, '..');
const PORT = 7463;
const CODE = 'flyer-kit-test-7731';
const WORK = path.join(os.tmpdir(), 'mw-flyerkit-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const SHOTS = process.env.MW_SHOTS || '';

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
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA],
    { stdio: 'ignore', env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: '', GROQ_API_KEY: '', CLOUDFLARE_API_TOKEN: '' }) });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWFlyerStudio && window.MWFlyerStudio.openKit && window.api && window.api.flyer, null, { timeout: 30000 });
    // a speaker with three photos in the bank
    const files = await page.evaluate(async () => {
      const pic = (col) => { const c = document.createElement('canvas'); c.width = 300; c.height = 400; const x = c.getContext('2d'); x.fillStyle = col; x.beginPath(); x.ellipse(150, 110, 60, 75, 0, 0, Math.PI * 2); x.fill(); x.fillRect(60, 200, 180, 200); return c.toDataURL('image/png'); };
      const k = await window.api.flyer.kitGet();
      await window.api.flyer.kitSave(Object.assign({}, k, { church: 'The Power House International', handles: '@thepowerhouseintl', speakers: [{ id: 'dr', name: 'Bishop David Richman', photos: [] }] }));
      const out = [];
      for (const col of ['#1e3a8a', '#7f1d1d', '#14532d']) out.push(await window.api.flyer.kitAddPhoto('dr', pic(col), 'Bishop David Richman'));
      return out;
    });
    await page.evaluate(() => window.MWFlyerStudio.openKit());
    await page.waitForSelector('.cp-flyer-kit .fs-kit-sp-top input', { timeout: 15000 });
    await page.waitForFunction(() => [...document.querySelectorAll('.cp-flyer-kit .fs-bank-cell img')].filter((i) => i.naturalWidth > 0).length === 3, null, { timeout: 15000 }).catch(() => {});

    // ── every box readable: its text against its own ground
    const boxes = await page.evaluate(() => {
      const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const ground = (el) => { for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.length >= 3 && (c[3] == null || c[3] > 0.5)) return c; } return [255, 255, 255]; };
      return [...document.querySelectorAll('.cp-flyer-kit input:not([type=file]), .cp-flyer-kit select, .cp-flyer-kit textarea')].map((el) => {
        const fg = lum(rgb(getComputedStyle(el).color)), bg = lum(ground(el));
        return { what: el.dataset.spf || el.dataset.kf || el.dataset.svf || el.tagName, value: el.value, ratio: +((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toFixed(1) };
      });
    });
    const name = boxes.find((b) => b.what === 'name' && b.value === 'Bishop David Richman');
    check(name && name.ratio >= 7, 'the speaker’s name is dark on its light box (readable)', name);
    check(boxes.length >= 6 && boxes.every((b) => b.ratio >= 4.5), 'every box in My church is readable', boxes.filter((b) => b.ratio < 4.5));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'kit-1.png') });

    // ── each photo has its own ✕
    const xs = await page.evaluate(() => [...document.querySelectorAll('.cp-flyer-kit .fs-bank-cell')].map((c) => {
      const x = c.querySelector('.fs-pic-x'), r = x && x.getBoundingClientRect(), cr = c.getBoundingClientRect();
      return { x: !!x, label: x && x.getAttribute('aria-label'), inside: !!r && r.left >= cr.left - 1 && r.right <= cr.right + 1 && r.top >= cr.top - 1 && r.width >= 24 };
    }));
    check(xs.length === 3 && xs.every((x) => x.x && x.inside && /Remove/.test(x.label)), 'each of the three photos has its own ✕, on the photo', xs);
    await page.locator('.cp-flyer-kit .fs-bank-cell').nth(1).locator('.fs-pic-x').tap();
    await sleep(400);
    const left = await page.evaluate(() => document.querySelectorAll('.cp-flyer-kit .fs-bank-cell').length);
    check(left === 2 && dialogs.length === 0, 'its ✕ takes that one photo out, without questions in between', { left, dialogs });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'kit-2.png') });
    await page.locator('.cp-flyer-kit [data-k="save"]').tap();
    let kit = null;
    for (let t = 0; t < 40; t++) { kit = await page.evaluate(() => window.api.flyer.kitGet()); if (kit.speakers[0].photos.length === 2) break; await sleep(250); }
    check(kit && JSON.stringify(kit.speakers[0].photos) === JSON.stringify([files[0], files[2]]), 'after Save the bank has the other two, in their order', kit && kit.speakers[0].photos);
    check(!fs.existsSync(path.join(DATA, 'flyer-kit', files[1])), 'and the removed photo is gone from the server');
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally { await done(); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
