'use strict';
/*
 * EXPORT ALL, CUT OFF PART-WAY, CARRIES ON BY ITSELF.
 *
 * The owner's words: "During exporting it crashed a white screen and I had to
 * click the continue session button!!! Fix that it should never crash!!!"
 *
 * The memory a phone needs for a batch was cut (caption pictures sent ahead,
 * one short tracked at a time, every picture let go once drawn). And should iOS
 * still close the page, nothing is lost: the shorts already handed over keep
 * exporting on the server, and opening the project again hands over the rest —
 * into the same export, none of them twice.
 *
 *   [1] a page killed after the server took short 1 — but before the phone
 *       could note it (the hardest moment)
 *   [2] Continue: the rest are handed over by themselves, into the SAME batch
 *   [3] every short reaches the server exactly once, and the export finishes
 *   [4] nothing is left over to resume afterwards
 *   [5] Start fresh on a cut-off export seals it, so the server finishes what it got
 *
 *   NODE_PATH=$(npm root -g) node test/phone-export-resume.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright).');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7613;
const CODE = 'export-resume-test-3311';
const WORK = path.join(os.tmpdir(), 'mw-phone-export-resume-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d).slice(0, 900) : '')); ok ? pass++ : fail++; };
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
async function until(fn, ms = 120000, every = 200) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}

(async () => {
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=20', '-f', 'lavfi', '-i', 'sine=f=220:d=20',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const errors = [];
    const studio = async () => {
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.__test && window.__mwBatch, null, { timeout: 30000 });
      return page;
    };

    let page = await studio();
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await page.evaluate(() => {
      const r = document.getElementById('veAutoReframe'); if (r) r.checked = false;
      const T = window.VideoEditor.__test;
      [['One', 1, 4], ['Two', 6, 9], ['Three', 12, 15]].forEach(([n, a, b]) => { const s = T.addShort(a, b); s.label = n; });
    });
    const saved = await until(() => page.evaluate(async () => {
      const s = await window.api.sessions.autosaveGet();
      const segs = (s && s.timeline && s.timeline.segments) || [];
      return segs.filter((x) => x.ai).map((x) => x.label).join(',') === 'One,Two,Three';
    }), 40000, 500);
    check(!!saved, 'the project with its three shorts is saved, as it is on the phone');

    console.log('\n[1] the page is killed just after the server took short 1, before the phone noted it');
    await page.evaluate(() => {
      const orig = window.__mwBatch.add;
      let n = 0;
      window.__mwBatch.add = async (...a) => { const r = await orig(...a); if (++n === 1) { window.__tookOne = true; await new Promise(() => {}); } return r; };
      window.VideoEditor.__test.exportAll();
    });
    await until(() => page.evaluate(() => window.__tookOne === true), 120000);
    const before = await page.evaluate(() => window.VideoEditor.__test.handover());
    check(before && before.total === 3 && before.sent.length === 0, 'the phone had noted nothing yet', before);
    const bid = before && before.batchId;
    await page.close({ runBeforeUnload: false });

    console.log('\n[2] opened again → Continue');
    page = await studio();
    const card = await until(() => page.evaluate(() => { const b = document.getElementById('veResume'); return b && !b.classList.contains('hidden'); }), 30000);
    check(!!card, 'the "Continue editing" card is there');
    await page.evaluate(() => window.VideoEditor.__test.resumeClick('yes'));
    const toast = await until(() => page.evaluate(() => /Carrying on with your export/.test(document.body.textContent) ? (document.body.textContent.match(/Carrying on with your export[^.]*\./) || [''])[0] : null), 30000);
    check(!!toast, 'it says it is carrying on with the export by itself', toast);

    console.log('\n[3] every short reaches the server exactly once');
    const fin = await until(() => page.evaluate(async (id) => {
      const b = ((await window.__mwBatch.list()) || []).find((x) => x.id === id);
      return b && b.sealed && b.state === 'done' ? b : null;
    }, bid), 240000, 1000);
    const labels = fin ? fin.items.map((x) => x.label) : [];
    check(!!fin, 'the SAME export finishes', fin && { state: fin.state, received: fin.received });
    check(labels.length === 3 && new Set(labels).size === 3 && ['One', 'Two', 'Three'].every((l) => labels.includes(l)), 'One, Two and Three — each once', labels);
    check(fin && fin.done === 3 && fin.items.every((x) => x.state === 'done' && x.output), 'and all three are made', fin && fin.items);
    const others = await page.evaluate(async (id) => ((await window.__mwBatch.list()) || []).filter((x) => x.id !== id).length, bid);
    check(others === 0, 'no second export was started for the rest', others);

    console.log('\n[4] nothing left over');
    check(await page.evaluate(() => window.VideoEditor.__test.handover()) === null, 'nothing is waiting to be resumed');

    console.log('\n[5] Start fresh on a cut-off export');
    const open2 = await page.evaluate(async () => {
      const b = await window.__mwBatch.open('Exporting 2 shorts', 2);
      localStorage.setItem('mw.handover', JSON.stringify({ batchId: b.id, video: '/nowhere.mp4', ids: ['x', 'y'], total: 2, sent: [], skipped: [], at: Date.now() }));
      return b.id;
    });
    await page.close({ runBeforeUnload: false });
    page = await studio();
    await until(() => page.evaluate(() => { const b = document.getElementById('veResume'); return b && !b.classList.contains('hidden'); }), 30000);
    await page.evaluate(() => window.VideoEditor.__test.resumeClick('no'));
    const sealed = await until(() => page.evaluate(async (id) => {
      const b = ((await window.__mwBatch.list()) || []).find((x) => x.id === id);
      return b && b.sealed ? b : null;
    }, open2), 15000, 300);
    check(!!sealed, 'the cut-off export is sealed, so the server finishes what it was given', sealed);
    check(await page.evaluate(() => window.VideoEditor.__test.handover()) === null, 'and it is not offered again');

    check(errors.length === 0, 'the page runs without errors', errors.slice(0, 3));
  } catch (e) { check(false, 'the test ran to the end', e.stack || e.message); }
  finally { await browser.close(); srv.kill(); fs.rmSync(WORK, { recursive: true, force: true }); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
