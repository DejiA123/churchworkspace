'use strict';
/*
 * THE FLYERS PAGE, OPTION A (cloud-flyer.js drawMake): "Option A for both" — the flyer seen live at the top,
 * the details on a white sheet below it. On a phone-sized page, against the real cloud server:
 *   - the flyer is drawn at the top as soon as the page opens (Radiant, the preacher on it)
 *   - each preacher's button shows their face, cut from their bank photo, and their whole name
 *   - typing redraws it; a colour under it puts it in that colour (remembered); the size changes its shape
 *   - tapped, it opens big
 *   - Make: the colour picked leads the board, the standard's family after it
 *   - the design checker: the art director (stood in for) scores the board on one sheet — the best first,
 *     what scores 5 or less off it, each card its score; the rules see words off the page or on other words
 * The AI painter is stood in for (no network in a test).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the Flyers page was not tested.');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const PORT = 7463;
const CODE = 'flyer-live-test-6617';
const WORK = path.join(os.tmpdir(), 'mw-flyer-live-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const SHOTS = process.env.MW_SHOTS || '';

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
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
async function until(page, fn, arg, ms = 30000) {
  const t0 = Date.now();
  let v = null;
  while (Date.now() - t0 < ms) { v = await page.evaluate(fn, arg); if (v && v.ok) return v; await sleep(250); }
  return v;
}

(async () => {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore', env: Object.assign({}, process.env, { ANTHROPIC_API_KEY: '', GROQ_API_KEY: '', CLOUDFLARE_API_TOKEN: '' }) });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} await sleep(300); try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.MWFlyerStudio && window.MWFlyer, null, { timeout: 30000 });
    // the painter stood in for; a preacher with a cut-out photo in the bank; the church's services
    await page.evaluate(async () => {
      window.__painted = 0;
      const pics = ['concert-fire-glow.jpg', 'sky-rays-dark.jpg', 'worship-blue.jpg'];
      window.api.flyer.paint = async (a) => ({ dataUrl: '/flyerphotos/' + pics[window.__painted++ % pics.length], by: 'test painter', w: a.w, h: a.h });
      const c = document.createElement('canvas'); c.width = 600; c.height = 800;
      const x = c.getContext('2d');
      x.fillStyle = '#8d5524'; x.beginPath(); x.ellipse(300, 230, 110, 140, 0, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#1e3a8a'; x.beginPath(); x.moveTo(60, 800); x.quadraticCurveTo(80, 420, 300, 400); x.quadraticCurveTo(520, 420, 540, 800); x.fill();
      const k = await window.api.flyer.kitGet();
      await window.api.flyer.kitSave(Object.assign({}, k, { church: 'Grace Life Chapel', services: [{ id: 'sv1', day: 5, name: 'Prayer Meeting', time: '7:00PM' }],
        speakers: [{ id: 'spmike', name: 'Pastor Mike Adeyemi', photos: [] }] }));
      await window.api.flyer.kitAddPhoto('spmike', c.toDataURL('image/png'), 'Pastor Mike Adeyemi');
    });

    await page.evaluate(() => window.MWFlyerStudio.open());
    await page.waitForSelector('.cp-flyer .fs-live', { timeout: 20000 });
    await page.locator('.cp-flyer [data-occ]').first().tap();
    await sleep(300);
    if (!(await page.evaluate(() => window.MWFlyerStudio._state.speakers.includes('spmike')))) await page.locator('.cp-flyer [data-sp="spmike"]').tap();
    let s = await until(page, () => {
      const c = document.querySelector('.cp-flyer .fs-live canvas'), tag = document.querySelector('.cp-flyer .fs-live-note');
      return { ok: !!c && c.width > 300 && Math.abs(c.width / c.height - 0.8) < 0.02 && /Live/.test(tag && tag.textContent), w: c && c.width, h: c && c.height };
    }, null, 20000);
    check(s && s.ok, 'the flyer is drawn live at the top of the page (4:5, marked LIVE)', s);
    s = await until(page, () => {
      const p = document.querySelector('.cp-flyer .fs-pill.on'), img = p && p.querySelector('img');
      return { ok: !!(img && /^data:image\/jpeg/.test(img.getAttribute('src') || '') && img.naturalWidth === 160) && /Pastor Mike Adeyemi/.test(p.textContent), text: p && p.textContent };
    }, null, 15000);
    check(s && s.ok, 'the preacher’s button shows their face and their whole name', s);
    const face = await page.evaluate(() => {
      const img = document.querySelector('.cp-flyer .fs-pill.on img'), c = document.createElement('canvas'); c.width = 160; c.height = 160;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(80, 70, 1, 1).data; return [d[0], d[1], d[2]];
    });
    check(Math.abs(face[0] - 141) < 30 && Math.abs(face[1] - 85) < 30 && Math.abs(face[2] - 36) < 30, 'the round picture is their head (the face colour in its middle), not the whole of them small', face);
    const livePx = () => page.evaluate(() => { const c = document.querySelector('.cp-flyer .fs-live canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 389) h = (h * 31 + d[i]) >>> 0; return h; });
    const px0 = await livePx();
    await page.locator('.cp-flyer [data-f="title"]').fill('NIGHT OF PRAYER');
    await sleep(700);
    const px1 = await livePx();
    check(px1 !== px0, 'typing redraws it', { px0, px1 });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.evaluate(() => { document.querySelector('.cp-flyer .cp-body').scrollTop = 0; });
    await page.locator('.cp-flyer [data-way="radiantgold"]').tap();
    await sleep(700);
    const px2 = await livePx();
    s = await page.evaluate(() => ({ way: window.MWFlyerStudio._state.way, kept: localStorage.getItem('mw-flyer-way'), on: (document.querySelector('.cp-flyer .fs-way.on') || {}).dataset }));
    check(s.way === 'radiantgold' && s.kept === 'radiantgold' && px2 !== px1, 'a colour under it puts it in that colour (and it is remembered)', { s, px1, px2 });
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'flyer-live-top.png') });
    await page.locator('.cp-flyer .fs-seg [data-size="story"]').tap();
    s = await until(page, () => { const c = document.querySelector('.cp-flyer .fs-live canvas'); return { ok: !!c && Math.abs(c.width / c.height - 0.5625) < 0.02, w: c && c.width, h: c && c.height }; }, null, 10000);
    check(s && s.ok, 'Story 9:16 changes its shape', s);
    await page.locator('.cp-flyer .fs-seg [data-size="post"]').tap();
    await sleep(400);
    await page.evaluate(() => { document.querySelector('.cp-flyer .cp-body').scrollTop = 0; });
    await page.locator('.cp-flyer .fs-live').tap();
    s = await until(page, () => ({ ok: !!document.querySelector('.fs-viewer canvas') }), null, 10000);
    check(s && s.ok, 'tapped, it opens big', s);
    await page.locator('.fs-viewer-x').tap();
    await sleep(200);

    // ── Make: the colour seen live leads the board — and the art director checks it (stood in for: no AI in a test)
    await page.evaluate(() => {
      window.__judged = [];
      window.api.flyer.judge = async (a) => {
        window.__judged.push({ count: a.count, kind: a.kind, sheet: a.image.length });
        const sc = { 1: 8, 2: 4, 3: 9, 4: 7 };
        return { ok: true, model: 'test', scores: Array.from({ length: a.count }, (x, i) => ({ n: i + 1, score: sc[i + 1] || 7, issue: i === 1 ? 'words over the face' : '' })) };
      };
    });
    await page.locator('.cp-flyer [data-act="make"]').tap();
    s = await until(page, () => { const st = window.MWFlyerStudio._state; return { ok: st.designs.length >= 3, looks: st.designs.map((d) => d.look), removed: (st.removed || []).map((r) => r.look) }; }, null, 60000);
    check(s && s.looks[0] === 'radiantgold' && ['radiantside', 'radiantspot', 'radiantwave'].every((l) => s.looks.includes(l) || s.removed.includes(l)),
      'Make: the colour picked comes first, then the standard’s family (Side, Spotlight, Wave)', s);
    s = await until(page, () => {
      const st = window.MWFlyerStudio._state, line = document.querySelector('.cp-flyer .fs-judge');
      return { ok: !!(st.judge && st.judge.done) && /art director/.test(line && line.textContent), looks: st.designs.map((d) => d.look), scores: st.designs.map((d) => d.score),
        removed: (st.removed || []).map((r) => r.look), badges: [...document.querySelectorAll('.cp-flyer .fs-score')].map((b) => b.textContent), line: line && line.textContent, judged: window.__judged };
    }, null, 20000);
    check(s && s.ok && s.judged.length === 1 && s.judged[0].count === 4 && s.judged[0].kind === 'flyer', 'the art director is shown the board on one sheet', s);
    check(s && s.removed.length === 1 && s.looks.length === 3 && !s.scores.some((x) => x <= 5), 'what it scores 5 or less comes off the board', s);
    check(s && s.looks[0] === 'radiantgold' && s.scores[1] >= s.scores[2], 'the best first (the colour picked stays first: it scored well)', s);
    check(s && s.badges.length === 3 && s.badges.every((b) => /\/10$/.test(b)) && /taken off/.test(s.line), 'each card says its score, and the line says one was taken off', s);
    // the rules, on a design: words off the page, words on words
    s = await page.evaluate(() => {
      const st = window.MWFlyerStudio._state, d = JSON.parse(JSON.stringify(st.designs[0]));
      const clean = window.MWFlyerStudio._flaws(d);
      const venue = d.layers.find((l) => l.type === 'text' && /^(Time|Speakers|Day|Date)$/.test(l.name || '')); if (venue) venue.x = 1300;
      const off = window.MWFlyerStudio._flaws(d);
      if (venue) { venue.x = 540; const t = d.layers.find((l) => /^Title/.test(l.name)); venue.y = t.y; }
      const on = window.MWFlyerStudio._flaws(d);
      return { clean, off, on };
    });
    check(s && !s.clean.length && s.off.some((f) => /runs off the page/.test(f)) && s.on.some((f) => /overlap/.test(f)), 'the rules see words run off the page and words on top of words (and nothing on a good design)', s);
  } catch (e) {
    check(false, 'the run finished', e.stack || e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
