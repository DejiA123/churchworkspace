'use strict';
/*
 * MY CHURCH (Flyers → My church) on a phone. Checks:
 *   - every box you type in is readable: dark text on its light ground (the
 *     speaker's name was near-white on light grey — "a text hidden by white")
 *   - each photo in a speaker's bank has its own ✕: tapping it takes that one
 *     photo out (no questions in between), the others stay, and after Save the
 *     server's bank no longer has it
 *   - several photos picked at once: a tile for each at once, and one bar pinned
 *     to the top until the last is cut out — only ever going forward ("I
 *     selected 11 pictures… the loading bar disappears… it's shocking")
 *   - asked each time how: cut out for me, or check each one in the cut-out
 *     editor ("the cut-out should not be automatic — I should have the option")
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

    // the studio's AI stood in for: half a minute there, four seconds here — asked after by its ticket, as the real one is
    await page.evaluate(() => {
      const t0 = {};
      window.api.flyer.cutoutStatus = async (ticket) => {
        const at = t0[ticket]; if (!at) return { job: { stage: 'waiting', ahead: 1, pct: 0 } };
        const f = Math.min(1, (Date.now() - at) / 4000);
        return { job: { stage: f < 0.85 ? 'thinking' : 'finishing', pct: 0.22 + 0.64 * f, to: 0.86, rate: 0.64 / 4 } };
      };
      window.api.flyer.cutout = async (dataUrl, pose, ticket) => {
        await new Promise((r) => setTimeout(r, 900)); t0[ticket] = Date.now();
        await new Promise((r) => setTimeout(r, 4000));
        return { dataUrl, w: 300, h: 400, coverage: 0.5 };
      };
    });
    // ── tapping a photo opens its cut-out: on a phone the picture big on top, every control on the screen
    await page.locator('.cp-flyer-kit .fs-bank-cell .fs-bank-pic').first().tap();
    // …and while the studio's AI works, a live bar: the words, a percentage, filling
    const bar = [];
    for (let t = 0; t < 12; t++) {
      await sleep(500);
      bar.push(await page.evaluate(() => {
        const b = document.querySelector('#cutBusy.cut-prog:not(.hidden)'); if (!b) return null;
        return { words: b.querySelector('.cut-prog-w').textContent, n: b.querySelector('.cut-prog-n').textContent, w: parseFloat(b.querySelector('.cut-prog-bar i').style.width) };
      }));
      if (t === 4 && SHOTS) await page.screenshot({ path: path.join(SHOTS, 'kit-progress.png') });
    }
    const seen = bar.filter(Boolean), ws = seen.map((x) => x.w);
    check(seen.length >= 4 && seen.every((x) => /^\d+%$/.test(x.n) && x.w === parseInt(x.n, 10)), 'while the studio’s AI cuts it out, a live bar with a percentage', bar);
    check(ws.length >= 4 && ws[ws.length - 1] > ws[0] + 25 && ws.every((w, i) => !i || w >= ws[i - 1]), 'the bar keeps filling, never going back', ws);
    check(seen.some((x) => /Waiting|cutting it out/.test(x.words)), 'it says what is happening (waiting its turn, cutting it out)', seen.map((x) => x.words));
    await page.waitForSelector('#cutModal:not(.hidden)', { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const ed = await page.evaluate(() => {
      const r = (q) => { const e = document.querySelector(q); return e ? e.getBoundingClientRect() : null; };
      const st = r('#cutModal .cut-stage'), soft = r('#cutModal .cut-check'), apply = r('#cutApply');
      return { open: !!document.querySelector('#cutModal:not(.hidden)'), vw: innerWidth, vh: innerHeight, stage: st && { w: Math.round(st.width), h: Math.round(st.height) },
        softIn: !!soft && soft.right <= innerWidth + 1 && soft.width > 60, applyIn: !!apply && apply.bottom <= innerHeight + 1 && apply.right <= innerWidth + 1,
        label: (document.getElementById('cutMethod') || {}).textContent || '' };
    });
    check(ed.open && ed.stage && ed.stage.w >= ed.vw * 0.9 && ed.stage.h >= ed.vh * 0.28, 'the cut-out editor opens with the picture across the phone, big', ed);
    check(ed.softIn && ed.applyIn, 'its controls are all on the screen (Soft edge, Use this)', ed);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'kit-cut.png') });
    await page.evaluate(() => { const c = document.getElementById('cutCancel'); if (c) c.click(); });
    await sleep(300);

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

    // ── several photos at once: a tile each straight away, one bar pinned to the top until the last is done
    const ff = require('ffmpeg-static');
    const picks = ['0x1e3a8a', '0x7f1d1d', '0x14532d'].map((c, k) => {
      const f = path.join(WORK, `pick-${k}.png`);
      require('child_process').execFileSync(ff, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${c}:s=300x400`, '-frames:v', '1', f]);
      return f;
    });
    await page.evaluate(() => window.MWFlyerStudio.openKit());
    await page.waitForSelector('.cp-flyer-kit [data-k="spadd-pic"]', { timeout: 15000 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.locator('.cp-flyer-kit [data-k="spadd-pic"]').first().tap()]);
    await chooser.setFiles(picks);
    // asked how: the two ways, then "cut them out for me"
    await page.waitForSelector('.fs-choice [data-w="auto"]', { timeout: 10000 });
    const ways = await page.evaluate(() => [...document.querySelectorAll('.fs-choice [data-w]')].map((b) => b.dataset.w));
    check(ways.join() === 'auto,check,', 'picking photos asks how: cut them out for me, or check each one (or cancel)', ways);
    await page.locator('.fs-choice [data-w="auto"]').tap();
    const seenB = [];
    for (let t = 0; t < 80; t++) {
      await sleep(400);
      const v = await page.evaluate(() => {
        const b = document.querySelector('.fs-cutbar');
        return { bar: b ? parseInt(b.querySelector('.fs-cutbar-n').textContent, 10) : null, words: b ? b.textContent.replace(/\s+/g, ' ').trim() : '',
          tiles: [...document.querySelectorAll('.cp-flyer-kit .fs-cut-tile')].map((x) => x.className.replace(/.*fs-cut-tile ?/, '')),
          bank: document.querySelectorAll('.cp-flyer-kit .fs-bank-cell:not(.fs-cut-tile)').length };
      });
      seenB.push(v);
      if (t === 6 && SHOTS) await page.screenshot({ path: path.join(SHOTS, 'kit-bulk.png') });
      if (t > 3 && v.bar == null && !v.tiles.length) break;
    }
    const first = seenB.find((v) => v.tiles.length) || {};
    check(seenB.slice(0, 4).some((v) => v.tiles.length === 3), 'three photos picked: three tiles in the speaker’s row straight away', seenB.slice(0, 4));
    check(first.tiles && first.tiles.filter((x) => x === 'wait').length >= 2, 'the ones not yet started say they are waiting', first.tiles);
    const bars = seenB.filter((v) => v.bar != null).map((v) => v.bar);
    const gone = seenB.findIndex((v) => v.bar == null && seenB.indexOf(v) > 0);
    check(bars.length >= 8 && bars.every((b, i) => !i || b >= bars[i - 1]), 'one bar pinned to the top the whole time, only going forward', bars);
    check(seenB.slice(0, Math.max(1, seenB.length - 2)).every((v) => v.bar != null || !v.tiles.length), 'it never disappears while photos are still being cut out', seenB.map((v) => [v.bar, v.tiles.length]));
    check(/Bishop David Richman/.test((seenB.find((v) => v.words) || {}).words || '') && /of 3/.test((seenB.find((v) => v.words) || {}).words || ''), 'it says whose photos and how many', (seenB.find((v) => v.words) || {}).words);
    const last = seenB[seenB.length - 1];
    check(last.bar == null && last.tiles.length === 0 && last.bank === 5, 'when the last is done the bar goes, and the three cut-outs are in the bank', last);

    // ── "let me check each one": each opens in the cut-out editor in turn; one not kept, the next comes on
    const [ch2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.locator('.cp-flyer-kit [data-k="spadd-pic"]').first().tap()]);
    await ch2.setFiles(picks.slice(0, 2));
    await page.waitForSelector('.fs-choice [data-w="check"]', { timeout: 10000 });
    const remembered = await page.evaluate(() => (document.querySelector('.fs-choice .on') || {}).dataset.w);
    check(remembered === 'auto', 'the last way chosen is offered first', remembered);
    await page.locator('.fs-choice [data-w="check"]').tap();
    await page.waitForSelector('#cutModal:not(.hidden)', { timeout: 20000 });
    const t1 = await page.evaluate(() => document.querySelector('#cutModal .cut-head h2').textContent);
    check(/Photo 1 of 2/.test(t1), 'the first opens in the cut-out editor: "Photo 1 of 2"', t1);
    await page.waitForFunction(() => window.CutOut.__test.state().w > 0, null, { timeout: 30000 }).catch(() => {});
    await page.evaluate(() => document.getElementById('cutApply').click());
    await page.waitForFunction(() => /Photo 2 of 2/.test((document.querySelector('#cutModal:not(.hidden) .cut-head h2') || {}).textContent || ''), null, { timeout: 30000 }).catch(() => {});
    const t2 = await page.evaluate(() => (document.querySelector('#cutModal:not(.hidden) .cut-head h2') || {}).textContent || '');
    check(/Photo 2 of 2/.test(t2), '"Use this" keeps it, and the next opens: "Photo 2 of 2"', t2);
    await page.evaluate(() => document.getElementById('cutCancel').click());
    await sleep(800);
    const after = await page.evaluate(() => ({ bank: document.querySelectorAll('.cp-flyer-kit .fs-bank-cell:not(.fs-cut-tile)').length, open: !!document.querySelector('#cutModal:not(.hidden)'), ask: !!document.querySelector('.fs-choice') }));
    check(after.bank === 6 && !after.open && !after.ask, 'the one kept is in the bank; the last one closed is not', after);
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally { await done(); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
