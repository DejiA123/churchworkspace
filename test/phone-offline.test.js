'use strict';
/*
 * WORKING WITH NO SIGNAL. "Make it work offline like CapCut — with no risk."
 * Drives the real Cloud Studio like an iPhone, with the network really cut
 * (the whole browser offline, service worker included). Checks:
 *   [1] ⬇ Keep on this phone (Projects) downloads the video; ✓ shows
 *   [2] with NO signal the kept video still loads, seeks and plays — from the phone
 *   [3] a video NOT kept is not answered from the phone (nothing else changed)
 *   [4] an edit made with no signal is kept on the phone, and "No signal — keep
 *       editing" says so
 *   [5] the app closed with no signal, opened again with one: the edit reaches
 *       the studio, and is crossed off on the phone
 *   [6] several edits with no signal, then the signal back: the NEWEST is what
 *       the studio ends up with (an older save never lands last)
 *   [7] a kept edit OLDER than the studio's copy never overwrites it
 *   node test/phone-offline.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7467, CODE = 'offline-test-6620';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-offline-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
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
const until = async (page, fn, arg, ms = 20000) => { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { v = await page.evaluate(fn, arg).catch(() => null); if (v) return v; await sleep(250); } return v; };
(async () => {
  const VID = path.join(MEDIA, 'sunday.webm'), OTHER = path.join(MEDIA, 'other.webm');
  for (const [f, hz] of [[VID, 220], [OTHER, 330]]) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=30', '-f', 'lavfi', '-i', `sine=f=${hz}:d=30`,
      '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-g', '15', '-c:a', 'libopus', '-shortest', f]);
  }
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const open = async () => {
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath && window.MWOffline, null, { timeout: 30000 });
      return page;
    };
    let page = await open();
    // the service worker in charge of the page (the first visit installs it)
    await until(page, () => navigator.serviceWorker && navigator.serviceWorker.ready.then(() => true));
    if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) { await page.reload({ waitUntil: 'load' }); await page.waitForFunction(() => window.VideoEditor && window.MWOffline, null, { timeout: 30000 }); }
    check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'the app runs under its service worker');
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    const projId = await page.evaluate(() => window.VideoEditor.flushProject());

    console.log('\n=== [1] keep it on this phone ===');
    await page.evaluate(() => window.MWSocial.openProjects());
    await page.waitForSelector('#cloudProjView [data-pjkeep]', { timeout: 15000 });
    await page.locator('#cloudProjView .pv-cur [data-pjkeep]').tap();
    const kept = await until(page, (v) => window.MWOffline.keptFor(v), VID, 30000);
    check(!!kept && kept.play === VID && kept.size > 100000, 'the video is kept on the phone', kept && { play: kept.play, size: kept.size });
    await sleep(600);
    const on = await page.evaluate(() => { const b = document.querySelector('#cloudProjView .pv-cur [data-pjkeep]'); return b && b.classList.contains('on'); });
    check(on, '…and Projects shows ✓ on it');
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'offline-kept.png') });
    await page.evaluate(() => window.MWSocial.go('studio'));
    await sleep(500);

    console.log('\n=== [2] no signal: the kept video still plays ===');
    await ctx.setOffline(true);
    const play = await page.evaluate(async () => {
      const p = document.getElementById('vePlayer');
      const src = p.getAttribute('src');
      p.src = ''; p.removeAttribute('src'); p.load();
      p.src = src; p.load();          // from nothing: whatever it shows now came from the phone
      await new Promise((r) => { p.addEventListener('loadedmetadata', r, { once: true }); setTimeout(r, 8000); });
      p.currentTime = 20;
      await new Promise((r) => { p.addEventListener('seeked', r, { once: true }); setTimeout(r, 8000); });
      const atSeek = { t: p.currentTime, ready: p.readyState, err: p.error && p.error.code };
      p.muted = true; await p.play().catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
      const after = p.currentTime; p.pause();
      return { atSeek, after, dur: p.duration };
    });
    check(play.atSeek.ready >= 2 && Math.abs(play.atSeek.t - 20) < 0.3 && !play.atSeek.err, 'with no signal it loads and seeks to 20 s', play);
    check(play.after > 20.5, '…and plays on', play);

    console.log('\n=== [3] a video not kept is not answered from the phone ===');
    const other = await page.evaluate(async (f) => { try { const r = await fetch(window.MW_FILE_URL(f), { headers: { Range: 'bytes=0-99' } }); return 'got ' + r.status; } catch (e) { return 'failed'; } }, OTHER);
    check(other === 'failed', 'with no signal, a video that was not kept is not there (only what was kept is on the phone)', other);

    console.log('\n=== [4] an edit with no signal is kept on the phone ===');
    await page.evaluate(() => { window.VideoEditor.__test.split(10); });
    const pend = await until(page, () => window.MWOffline.allPending().then((a) => (a.length ? a : null)), null, 10000);
    check(!!pend && pend.length >= 1 && pend.some((r) => (r.data.timeline.segments || []).filter((x) => !x.lane).length === 2), 'the edit is kept on the phone, waiting for the studio', pend && pend.map((r) => r.key));
    const said = await until(page, () => /No signal — keep editing/.test(document.body.innerText) ? document.body.innerText.match(/No signal[^\n]*\n?[^\n]*/)[0] : null, null, 8000);
    const sub = await page.evaluate(() => document.body.innerText.includes('This video plays from your phone'));
    check(!!said && sub, '"No signal — keep editing … this video plays from your phone" is said', said);

    console.log('\n=== [5] closed with no signal, opened again with one ===');
    await page.close();
    await ctx.setOffline(false);
    page = await open();
    const landed = await until(page, (id) => window.api.sessions.load(id).then((d) => {
      const n = ((d && d.timeline && d.timeline.segments) || []).filter((x) => !x.lane).length;
      return n === 2 ? n : null;
    }), projId, 20000);
    check(landed === 2, 'the edit made with no signal reached the studio', landed);
    const left = await until(page, () => window.MWOffline.allPending().then((a) => (a.length ? null : 'none')), null, 8000);
    check(left === 'none', '…and is crossed off on the phone', left);

    console.log('\n=== [6] several edits with no signal: the newest wins ===');
    await page.evaluate((p) => window.VideoEditor.openProject(p), projId);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 1, null, { timeout: 30000 });
    await sleep(1000);
    await ctx.setOffline(true);
    await sleep(500);
    for (const t of [5, 15, 20, 25]) { await page.evaluate((x) => window.VideoEditor.__test.split(x), t); await sleep(3200); }
    await ctx.setOffline(false);
    const final = await until(page, (id) => window.api.sessions.load(id).then((d) => {
      const n = ((d && d.timeline && d.timeline.segments) || []).filter((x) => !x.lane).length;
      return n === 6 ? n : null;
    }), projId, 40000);
    await sleep(4000);   // anything older still on its way would land now
    const still = await page.evaluate((id) => window.api.sessions.load(id).then((d) => ((d && d.timeline && d.timeline.segments) || []).filter((x) => !x.lane).length), projId);
    check(final === 6 && still === 6, 'the studio ends up with the newest edit (all four cuts) — an older save never lands last', { final, still });

    console.log('\n=== [7] an old kept edit never overwrites a newer one ===');
    await page.evaluate(({ id, v }) => window.MWOffline.putPending({ key: id, id, video: v, name: 'stale', auto: true, at: Date.now() - 3600e3,
      data: { video: { path: v, durationSec: 30 }, timeline: { segments: [{ id: 'stale', start: 0, end: 30, label: 'Stale', seed: true }] } } }), { id: projId, v: VID });
    await page.close();
    page = await open();
    await sleep(4000);
    const after = await page.evaluate((id) => window.api.sessions.load(id).then((d) => ({ n: ((d && d.timeline && d.timeline.segments) || []).filter((x) => !x.lane).length, name: d && d.name })), projId);
    const gone = await page.evaluate(() => window.MWOffline.allPending().then((a) => a.length));
    check(after.n === 6 && gone === 0, 'the studio keeps its newer copy; the old one on the phone is dropped', { after, gone });
  } catch (e) {
    check(false, 'the run completes', e.message);
  } finally {
    try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
