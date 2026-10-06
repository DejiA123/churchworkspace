'use strict';
/*
 * EXPORTING ON A PHONE: ONE NUMBER, FROM THE TAP TO "IT'S ON YOUR PHONE" —
 * in a real browser, on the real Cloud Studio, the way an iPhone uses it
 * (the share sheet is stubbed: navigator.share records what it was handed).
 *
 * The owner's words: "When exporting, the 'saving to your phone…' should be
 * part of the overall percentage exporting process instead of separately."
 * It used to count to 100%, close, say "Saved" (it was not), and then start a
 * second bar in the island: "Saving to your phone… 0%".
 *
 *   [A] Export video, watched: the overlay's number only goes forward, never
 *       closes on the way, says "onto your phone" before 100, reaches 100 only
 *       once every byte is on the phone, and becomes "Save to Photos" — whose
 *       tap hands the share sheet exactly the server's file. No "Saving to
 *       your phone…" island, no "Saved" before Photos has it.
 *   [B] one short, the same
 *   [C] Keep editing while it exports: the chip carries the download in the
 *       same number, then "Ready to save · Save Video" stays put
 *   [D] Not now: the file stays on the phone; a later Save is instant
 *   [E] Cancel during the download: nothing shared, it says it is in ⬇ Saved,
 *       and no half-written file is left on the phone's storage
 *   [F] the plan: what a phone adds to an export's chain, and what a desk adds
 *   [G] a video too big for the share sheet: the phone copy and the download
 *       are one forward-only number
 *   [H] Export all: the server batch's number includes bringing the shorts
 *       down, and ends on "on your phone · Save all", one tap for both; a batch
 *       that cannot bring them down keeps its Save all, with ONE bar
 *   [I] two saves at once do not wipe each other's files
 *   [K] a file finished outside an export task comes down in its own overlay
 *       and ends on the same card (the phone's finishedFile is the one used)
 *   [J] a computer's browser: an export ends as it always has
 *
 * Needs Playwright with Chromium (it is not one of the app's dependencies);
 * without it this says so and skips.
 *
 *   node test/phone-export-save.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — exporting on a phone was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7602;
const CODE = 'export-save-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-export-save-' + process.pid);
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
async function until(fn, ms = 120000, every = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(every);
  }
}
const nonDecreasing = (xs) => xs.every((x, i) => i === 0 || x >= xs[i - 1]);

/*
 * What the phone is showing, every 50 ms: the overlay (its words and number),
 * whether it is the Save card, the island, the jobs chip, the running task's
 * step, the chain's slice — and how many bytes of a download have arrived.
 */
function installSampler() {
  window.__samples = [];
  window.__dlBytes = 0;
  clearInterval(window.__sampler);
  const txt = (el) => (el ? el.textContent : '');
  window.__sampler = setInterval(() => {
    const o = document.getElementById('overlay');
    const isl = document.querySelector('.cloud-island');
    const chip = document.getElementById('cloudJobsChip');
    const run = (window.__tasksList ? window.__tasksList() : []).find((t) => t.state === 'run');
    const dbg = window.__chainDebug ? window.__chainDebug() : null;
    window.__samples.push({
      t: Date.now(),
      ov: !!o && !o.classList.contains('hidden'),
      pct: parseInt(txt(document.getElementById('overlayPct')), 10),
      msg: txt(document.getElementById('overlayMsg')),
      card: !!document.querySelector('#overlay:not(.hidden) .overlay-save'),
      isl: isl && isl.classList.contains('on') ? txt(isl.querySelector('.ci-title')) : '',
      islAct: isl && isl.classList.contains('on') ? txt(isl.querySelector('.ci-act')) : '',
      chip: chip && !chip.classList.contains('hidden') ? chip.dataset.state + ':' + txt(chip.querySelector('.cj-tx')) : '',
      step: run ? run.step : '',
      key: dbg ? dbg.key : null, base: dbg ? dbg.base : null, span: dbg ? dbg.span : null,
      dl: window.__dlBytes || 0,
      shares: (window.__shares || []).length,
    });
  }, 50);
}
const stopSampler = (page) => page.evaluate(() => { clearInterval(window.__sampler); return window.__samples; });

(async () => {
  // a 20 s picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=20', '-f', 'lavfi', '-i', 'sine=f=220:d=20',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const errors = [];
    const open = async (ctxOpts, phone) => {
      const ctx = await browser.newContext(ctxOpts);
      await ctx.addInitScript(([t, share]) => {
        try { localStorage.setItem('mw.cloud.token', t); } catch (e) {}
        // every byte of a download, as it arrives
        window.__dlBytes = 0;
        const ob = Response.prototype.blob;
        Response.prototype.blob = async function () {
          const b = await ob.call(this);
          if (/\/api\/file\?/.test(this.url) && this.status === 206) window.__dlBytes += b.size;
          return b;
        };
        if (!share) return;
        // the share sheet: records what it was handed (and can be told to read it all)
        window.__shares = [];
        window.__shareRead = false;
        Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
        Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => {
          const files = (d && d.files) || [];
          const rec = files.map((f) => ({ name: f.name, size: f.size }));
          window.__shares.push(rec);
          if (window.__shareRead) for (let i = 0; i < files.length; i++) rec[i].read = (await files[i].arrayBuffer()).byteLength;
          await new Promise((r) => setTimeout(r, 120));
        } });
      }, [login.token, !!phone]);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(1000);
      return { ctx, page };
    };
    const { page } = await open({ ...devices['iPhone 13'] }, true);
    const sizeOf = (p) => page.evaluate(async (p) => {
      const r = await fetch('/api/file?p=' + encodeURIComponent(p) + '&k=' + encodeURIComponent(localStorage.getItem('mw.cloud.token')), { headers: { Range: 'bytes=0-0' } });
      await r.arrayBuffer();
      return Number((/\/(\d+)$/.exec(r.headers.get('content-range') || '') || [])[1]) || 0;
    }, p);
    const newest = () => page.evaluate(() => (window.MWCloud.downloads || []).map((d) => d.path).filter((p) => /\.mp4$/.test(p))[0] || null);

    /* ---- one export, watched in the overlay, to the Save to Photos card ---- */
    async function watchedExport(label, start) {
      await page.evaluate(() => window.__islandHide && window.__islandHide());   // the last one's "Saved to Photos"
      await sleep(300);
      await page.evaluate(installSampler);
      const shares0 = await page.evaluate(() => window.__shares.length);
      await page.evaluate(start);
      const card = await until(() => page.evaluate(() => !!document.querySelector('#overlay:not(.hidden) .overlay-save')), 150000);
      await sleep(300);
      const S = await stopSampler(page);
      check(!!card, `${label}: the export ends on the "Save to Photos" card`, S.slice(-3));
      const firstOv = S.findIndex((s) => s.ov);
      const firstCard = S.findIndex((s) => s.card);
      const watched = S.slice(firstOv, firstCard + 1);
      const pcts = watched.filter((s) => s.ov && !isNaN(s.pct)).map((s) => s.pct);
      check(firstOv >= 0 && nonDecreasing(pcts), `${label}: the overlay's number only ever goes forward (${pcts[0]}→${pcts[pcts.length - 1]}%, ${pcts.length} readings)`,
        pcts.filter((x, i) => i && x < pcts[i - 1]).slice(0, 5));
      check(watched.every((s) => s.ov), `${label}: the overlay never closes between the tap and the Save card`, watched.filter((s) => !s.ov).length);
      const phone = watched.filter((s) => /onto your phone/.test(s.msg));
      check(phone.length > 0 && phone.some((s) => s.pct < 100), `${label}: it says "Getting it onto your phone" while the number is still climbing`,
        phone.slice(0, 2).map((s) => s.msg + ' ' + s.pct));
      const p = await newest();
      const size = p ? await sizeOf(p) : 0;
      const early = watched.filter((s) => s.pct >= 100 && s.dl < size);
      check(size > 0 && early.length === 0, `${label}: 100% only once all ${Math.round(size / 1048576)} MB are on the phone`, early.slice(0, 2));
      check(S.every((s) => !/Saving to your phone/.test(s.isl)), `${label}: there is no second "Saving to your phone… N%" bar`, S.filter((s) => /Saving to your phone/.test(s.isl)).slice(0, 1));
      check(S.every((s) => !/^Saved\b/.test(s.isl)), `${label}: nothing says "Saved" before the video is in Photos`, Array.from(new Set(S.map((s) => s.isl).filter(Boolean))));
      const end = await page.evaluate(() => ({ btn: document.querySelector('.overlay-save').textContent.trim(), pct: document.getElementById('overlayPct').textContent,
        msg: document.getElementById('overlayMsg').textContent, cancel: !document.getElementById('overlayCancel').classList.contains('hidden') }));
      check(/Save to Photos/.test(end.btn) && end.pct === '100%' && /ready/.test(end.msg) && !end.cancel,
        `${label}: the card reads "Your video is ready", 100%, with one big "Save to Photos"`, end);
      return { S, path: p, size, shares0 };
    }
    async function tapSave(label, r) {
      await page.click('#overlay .overlay-save');
      const shared = await until(() => page.evaluate((n) => window.__shares.length > n && window.__shares[window.__shares.length - 1], r.shares0), 5000, 30);
      check(!!shared && shared.length === 1 && shared[0].size === r.size && shared[0].name === path.basename(r.path),
        `${label}: "Save to Photos" hands the share sheet the server's file, byte for byte in size`, { shared, size: r.size, name: path.basename(r.path || '') });
      const after = await until(() => page.evaluate(() => {
        const o = document.getElementById('overlay'), i = document.querySelector('.cloud-island.on .ci-title');
        return o.classList.contains('hidden') && i && /Saved to Photos/.test(i.textContent) ? i.textContent : null;
      }), 4000, 50);
      check(!!after, `${label}: then the overlay goes and the island says "Saved to Photos"`, after);
    }

    console.log('\n=== [F] the plan ===');
    const plan = await page.evaluate(() => ({ short: window.__deliverPlan({ durationSec: 60, quality: '1080p' }),
      long: window.__deliverPlan({ durationSec: 600, quality: '1080p' }), w: window.__chainWeights }));
    check(JSON.stringify(plan.short) === '["tophone"]', 'a minute at 1080p: only the download is added to the export', plan.short);
    check(JSON.stringify(plan.long) === '["phonecopy","tophone"]', 'ten minutes at 1080p: the phone copy, then the download', plan.long);
    check(plan.w.tophone > 0 && plan.w.phonecopy > plan.w.tophone && plan.w.encode > plan.w.phonecopy,
      'the weights: an encode outweighs the phone copy, which outweighs the download', plan.w);
    check(await page.evaluate(() => /offerDownload|deliverFile|canSaveHere/.test(String(window.finishedFile))),
      "the phone's own finishedFile is the one in use (tasks.js no longer replaces it)");

    console.log('\n=== [A] Export video, watched ===');
    const A = await watchedExport('[A] edited', () => window.VideoEditor.__test.clickExportEdited());
    const tail = A.S.filter((s) => s.key === 'tophone');
    check(tail.length > 0 && tail.every((s) => s.base > 50 && Math.abs(s.base + s.span - 100) < 0.01),
      '[F] while it comes down the chain is in its last slice, "tophone", after the export\'s own share', tail.slice(0, 1));
    await tapSave('[A] edited', A);

    console.log('\n=== [B] one short ===');
    const B = await watchedExport('[B] short', () => {
      const r = document.getElementById('veAutoReframe'); if (r) r.checked = false;
      const s = window.VideoEditor.__test.addShort(2, 8);
      window.VideoEditor.__test.exportSegmentFull(s.id);
    });
    await tapSave('[B] short', B);

    console.log('\n=== [D] Not now ===');
    const D = await watchedExport('[D] edited again', () => window.VideoEditor.__test.clickExportEdited());
    await page.click('#overlay .overlay-later');
    await sleep(300);
    const dState = await page.evaluate((p) => ({ ov: !document.getElementById('overlay').classList.contains('hidden'),
      card: !!document.querySelector('#overlay .overlay-save-acts'), listed: window.MWCloud.downloads.some((d) => d.path === p),
      isl: (document.querySelector('.cloud-island.on .ci-title') || {}).textContent || '' }), D.path);
    check(!dState.ov && !dState.card && dState.listed && /Saved/.test(dState.isl),
      '[D] "Not now" closes the card and the video is in ⬇ Saved', dState);
    const reqs = [];
    const onReq = (r) => { if (/\/api\/file\?/.test(r.url())) reqs.push(r.headers().range || 'whole'); };
    page.on('request', onReq);
    await page.evaluate((p) => { window.MWCloud.offerDownload(p); }, D.path);
    const again = await until(() => page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i && /Ready to save/.test(i.textContent) && /Save Video/.test(i.textContent); }), 8000, 50);
    page.off('request', onReq);
    check(!!again && reqs.length === 0, '[D] a later Save is instant: "Ready to save" with nothing downloaded again', reqs);
    await page.evaluate(() => { const a = document.querySelector('.cloud-island.on .ci-act'); if (a) a.click(); });
    await sleep(400);
    const dShare = await page.evaluate(() => window.__shares[window.__shares.length - 1]);
    check(dShare && dShare[0].size === D.size, '[D] …and its Save Video shares the whole file', dShare);
    await page.evaluate(() => window.__islandHide && window.__islandHide());

    console.log('\n=== [E] Cancel while it comes down ===');
    // a slow connection: every piece takes a while
    await page.route(/\/api\/file\?/, async (route) => {
      const h = route.request().headers();
      if (h.range && !/bytes=0-0$/.test(h.range)) await sleep(1500);
      try { await route.continue(); } catch (e) { /* aborted by the Cancel */ }
    });
    await page.evaluate(installSampler);
    const sharesE = await page.evaluate(() => window.__shares.length);
    errors.length = 0;
    await page.evaluate(() => window.VideoEditor.__test.clickExportEdited());
    const coming = await until(() => page.evaluate(() => /onto your phone/.test(document.getElementById('overlayMsg').textContent)
      && !document.getElementById('overlay').classList.contains('hidden')), 120000, 50);
    check(!!coming, '[E] the download is under way, in the export\'s overlay');
    const cancelShown = await page.evaluate(() => !document.getElementById('overlayCancel').classList.contains('hidden')
      && !document.getElementById('overlayBackground').classList.contains('hidden'));
    check(cancelShown, '[E] …with ✕ Cancel and ⇥ Run in the background still there');
    await page.click('#overlayCancel');
    const gone = await until(() => page.evaluate(() => {
      const i = document.querySelector('.cloud-island.on');
      return document.getElementById('overlay').classList.contains('hidden') && i && /Saved/.test(i.textContent) ? i.textContent : null;
    }), 10000, 50);
    await page.unroute(/\/api\/file\?/);
    const ES = await stopSampler(page);
    check(!!gone && /Not on your phone yet/.test(gone), '[E] Cancel closes it, and the island says it is in ⬇ Saved', gone);
    check((await page.evaluate(() => window.__shares.length)) === sharesE && ES.every((s) => !s.card), '[E] nothing was handed to the share sheet, and no Save card appeared');
    check(errors.length === 0, '[E] no page errors from the cancelled download', errors);
    await sleep(2000);   // the pieces that were on their way have settled
    // the next save sweeps what nobody holds — the half-written file of the cancelled one among it
    const E = await newest();
    await page.evaluate((p) => { window.__islandHide && window.__islandHide(); window.MWCloud.offerDownload(p); }, E);
    await until(() => page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i && /Ready to save/.test(i.textContent); }), 30000, 50);
    const eSize = await sizeOf(E);
    const opfs = await page.evaluate(async () => {
      const out = [];
      const root = await navigator.storage.getDirectory();
      const saves = await root.getDirectoryHandle('mw-saves');
      for await (const [n, h] of saves.entries()) {
        if (h.kind !== 'directory') { out.push({ dir: '(loose)', name: n }); continue; }
        for await (const [fn, fh] of h.entries()) out.push({ dir: n, name: fn, size: (await fh.getFile()).size });
      }
      return out;
    });
    const sizes = {};
    for (const p of [A.path, B.path, D.path, E]) sizes[path.basename(p)] = p === E ? eSize : p === A.path ? A.size : p === B.path ? B.size : D.size;
    const partial = opfs.filter((f) => !(f.name in sizes) || f.size !== sizes[f.name]);
    check(opfs.length > 0 && partial.length === 0, `[E] no half-written file is left on the phone's storage (${opfs.length} whole files kept)`, { opfs, sizes });
    await page.evaluate(() => { const a = document.querySelector('.cloud-island.on .ci-act'); if (a) a.click(); });
    await sleep(400);

    console.log('\n=== [G] the phone copy and the download: one number ===');
    {
      // the studio is asked for a phone copy (as for a video over 140 MB) — answered here
      const target = A.path;
      await page.route('**/api/rpc', async (route) => {
        let body = null;
        try { body = JSON.parse(route.request().postData() || 'null'); } catch (e) { body = null; }
        const ch = body && body.channel;
        if (ch === 'video:phoneCopyStatus') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { needed: true, hd: { ready: false }, fast: { ready: false } } }) });
        }
        if (ch === 'video:phoneCopy') {
          for (const pc of [10, 35, 60, 90]) {
            await page.evaluate(([j, pc]) => (window.__pcCbs || []).forEach((cb) => cb({ jobId: j, percent: pc })), [body.args.jobId, pc]);
            await sleep(60);
          }
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { parts: [{ path: target, size: A.size }] } }) });
        }
        return route.continue();
      });
      const g = await page.evaluate(async (p) => {
        const real = window.api.onJobProgress;
        window.__pcCbs = [];
        window.api.onJobProgress = (cb) => { window.__pcCbs.push(cb); return () => { window.__pcCbs = window.__pcCbs.filter((x) => x !== cb); }; };
        const seen = [], said = [];
        const copyShare = (60 / 85) * 100;
        try {
          const r = await window.__deliverFile(p, { copyShare, say: (m) => said.push(m), progress: (n) => seen.push(n), background: () => false, stopped: () => false });
          return { seen, said, copyShare, ok: !!(r && r.show) };
        } finally { window.api.onJobProgress = real; }
      }, target);
      await page.unroute('**/api/rpc');
      check(g.ok && nonDecreasing(g.seen), `[G] the delivery's number only goes forward through the copy and the download (${g.seen.map((x) => Math.round(x)).join(',')})`, g);
      check(g.said.some((m) => /Making a 1080p copy/.test(m)) && g.seen.some((x) => x > 0 && x <= g.copyShare) && Math.max(...g.seen) > g.copyShare,
        '[G] the copy is the first part of it, the download the rest', { said: g.said.slice(0, 3), copyShare: g.copyShare });
      await page.evaluate(() => window.__islandHide && window.__islandHide());
    }

    console.log('\n=== [C] Keep editing while it exports ===');
    await page.evaluate(() => window.VideoEditor.__test.setBgExport(true));
    await page.evaluate(installSampler);
    const sharesC = await page.evaluate(() => window.__shares.length);
    await page.evaluate(() => window.VideoEditor.__test.clickExportEdited());
    const ready = await until(() => page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i && /Ready to save/.test(i.textContent) && /Save Video/.test(i.textContent); }), 150000, 50);
    let CS = await stopSampler(page);
    check(!!ready, '[C] a background export ends on "Ready to save · Save Video" by itself');
    const chipPcts = CS.filter((s) => /^run:\d+%$/.test(s.chip)).map((s) => parseInt(s.chip.split(':')[1], 10));
    check(chipPcts.length > 3 && nonDecreasing(chipPcts), `[C] the chip's number only goes forward (${chipPcts[0]}→${chipPcts[chipPcts.length - 1]}%)`, chipPcts.filter((x, i) => i && x < chipPcts[i - 1]));
    check(CS.some((s) => /onto your phone/.test(s.step)), '[C] the job says "Getting it onto your phone" while it is still running', Array.from(new Set(CS.map((s) => s.step))).slice(-4));
    check(CS.every((s) => !s.ov), '[C] the overlay never comes up for it');
    check(CS.every((s) => !/Saving to your phone/.test(s.isl)), '[C] and there is no second "Saving to your phone… N%" bar');
    await sleep(1200);
    const still = await page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i ? i.textContent : ''; });
    check(/Ready to save/.test(still) && /Save Video/.test(still), '[C] "Ready to save · Save Video" is still there a second later (not replaced by "Export finished · View")', still);
    // a passing note does not take the button away
    await page.evaluate(() => window.__toast('Copied.', 'good', 600));
    await sleep(1400);
    const back = await page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i ? i.textContent : ''; });
    check(/Ready to save/.test(back) && /Save Video/.test(back), '[C] a note shown over it folds away and the Save Video button comes back', back);
    await page.evaluate(() => { const a = document.querySelector('.cloud-island.on .ci-act'); if (a) a.click(); });
    const cShared = await until(() => page.evaluate((n) => window.__shares.length > n && window.__shares[window.__shares.length - 1], sharesC), 4000, 30);
    check(!!cShared && cShared.length === 1, '[C] its Save Video calls the share sheet', cShared);
    await page.evaluate(() => window.VideoEditor.__test.setBgExport(false));
    await page.evaluate(() => window.__islandHide && window.__islandHide());

    console.log('\n=== [H] Export all, on the server ===');
    await page.evaluate(() => { (window.__tasksList() || []).forEach((t) => window.__taskClear(t.id)); });
    await page.evaluate(() => {
      const r = document.getElementById('veAutoReframe'); if (r) r.checked = false;
      window.VideoEditor.__test.addShort(10, 15);
    });
    await sleep(300);
    await page.evaluate(installSampler);
    const sharesH = await page.evaluate(() => window.__shares.length);
    await page.evaluate(() => document.getElementById('veExportAll').click());
    const hReady = await until(() => page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i && /on your phone/.test(i.textContent) && /Save all/.test(i.textContent) ? i.textContent : null; }), 240000, 50);
    const HS = await stopSampler(page);
    check(!!hReady, '[H] Export all ends on "N shorts on your phone · Save all"', Array.from(new Set(HS.map((s) => s.isl).filter(Boolean))));
    const hp = HS.filter((s) => /^run:\d+%$/.test(s.chip)).map((s) => parseInt(s.chip.split(':')[1], 10));
    check(hp.length > 3 && nonDecreasing(hp), `[H] the batch's number only goes forward, to the end (${hp[0]}→${hp[hp.length - 1]}%)`, hp.filter((x, i) => i && x < hp[i - 1]));
    const saving = HS.filter((s) => /onto your phone/.test(s.step));
    // (the step's words and the chip's number are painted in separate frames, so the
    // very first sample of the save phase may still carry the export's last number)
    check(saving.length > 0 && saving.slice(1).every((s) => !/^run:/.test(s.chip) || parseInt(s.chip.split(':')[1], 10) >= 85),
      '[H] bringing the shorts down is the last part of that number (85-100%)', saving.slice(0, 2).map((s) => s.chip + ' ' + s.step));
    await sleep(1200);
    const hStill = await page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i ? i.textContent : ''; });
    check(/on your phone/.test(hStill) && /Save all/.test(hStill), '[H] "Save all" is still on the island a second later', hStill);
    await page.evaluate(() => { const a = document.querySelector('.cloud-island.on .ci-act'); if (a) a.click(); });
    const hShared = await until(() => page.evaluate((n) => window.__shares.length > n && window.__shares[window.__shares.length - 1], sharesH), 5000, 30);
    const outs = await page.evaluate(() => (window.__tasksList() || []).filter((t) => t.files && t.files.length > 1).map((t) => t.files)[0] || []);
    check(!!hShared && hShared.length === 2 && outs.length === 2, '[H] one tap of Save all hands the share sheet both shorts at once', { hShared, outs });
    const allSaved = await until(() => page.evaluate(() => { const i = document.querySelector('.cloud-island.on .ci-title'); return i && /All 2 saved/.test(i.textContent); }), 4000, 50);
    check(!!allSaved, '[H] then "All 2 saved to Photos"');

    // a batch from another phone (or that finished while this app was away): the old Save all, kept
    await page.evaluate((outs) => {
      const items = outs.map((o, i) => ({ label: 'Short ' + (i + 1), state: 'done', output: o }));
      window.MWCloud.showServerBatch({ id: 'b-elsewhere', label: 'Exporting 2 shorts', total: 2, done: 1, failed: 0, received: 2, sealed: true, state: 'running',
        current: { label: 'Short 2', pct: 50 }, items: [items[0], { label: 'Short 2', state: 'running', output: null }] });
    }, outs);
    await sleep(300);
    await page.evaluate((outs) => {
      const items = outs.map((o, i) => ({ label: 'Short ' + (i + 1), state: 'done', output: o }));
      window.MWCloud.showServerBatch({ id: 'b-elsewhere', label: 'Exporting 2 shorts', total: 2, done: 2, failed: 0, received: 2, sealed: true, state: 'done', current: null, items });
    }, outs);
    await sleep(1200);
    const other = await page.evaluate(() => { const i = document.querySelector('.cloud-island.on'); return i ? i.textContent : ''; });
    check(/2 shorts ready/.test(other) && /Save all/.test(other), '[H] a batch that did not come down keeps "2 shorts ready · Save all" (not replaced by "View")', other);
    await page.evaluate(() => { const a = document.querySelector('.cloud-island.on .ci-act'); if (a) a.click(); });
    await page.waitForSelector('#cloudSaveAll .sa-go', { timeout: 5000 });
    await page.evaluate(() => {
      window.__fills = [];
      clearInterval(window.__fillIv);
      window.__fillIv = setInterval(() => {
        const b = document.querySelector('#cloudSaveAll .sa-go'); if (!b) return;
        window.__fills.push({ st: b.dataset.state, text: b.textContent.trim(), w: parseFloat(b.querySelector('.cv-fill').style.width) || 0 });
      }, 20);
    });
    // (the ready button breathes — a CSS pulse — so it is tapped directly rather than waited still)
    const tapPanel = () => page.evaluate(() => document.querySelector('#cloudSaveAll .sa-go').click());
    await tapPanel();
    const panelDone = await until(async () => {
      const st = await page.evaluate(() => { const b = document.querySelector('#cloudSaveAll .sa-go'); return b ? b.dataset.state + '|' + b.textContent.trim() : ''; });
      if (/^ready\|Save/.test(st)) await tapPanel();
      return /^done\|/.test(st) ? st : null;
    }, 30000, 100);
    const fills = await page.evaluate(() => { clearInterval(window.__fillIv); return window.__fills; });
    const loading = fills.filter((f) => f.st === 'loading');
    check(!!panelDone, '[H] the Save all panel saves both', panelDone);
    check(loading.length > 1 && nonDecreasing(loading.map((f) => f.w)) && loading.every((f) => /^Saving [12] of 2 · \d+%$/.test(f.text)),
      `[H] its bar is ONE number for the whole save — it never starts again for the second short (${loading.map((f) => Math.round(f.w)).join(',')})`,
      loading.filter((f, i) => i && f.w < loading[i - 1].w).slice(0, 3).concat(loading.slice(0, 2)));
    await page.evaluate(() => window.MWCloud.closePanel && window.MWCloud.closePanel('cloudSaveAll'));

    console.log('\n=== [I] two saves at once ===');
    {
      await page.evaluate(() => { window.__shareRead = true; });
      const sizes2 = [await sizeOf(outs[0]), await sizeOf(outs[1])];
      const res = await page.evaluate(async (outs) => {
        const got = [];
        const ui = (k) => ({
          making() {}, progress() {}, done() {}, cancelled() {},
          fail: (m) => got.push({ k, fail: m }),
          ready: (share) => { got.push({ k, ready: true }); share(); },
        });
        await Promise.all([window.MWCloud.offerDownload(outs[0], 0, ui(0)), window.MWCloud.offerDownload(outs[1], 0, ui(1))]);
        await new Promise((r) => setTimeout(r, 800));
        return { got, shares: window.__shares.slice(-2) };
      }, outs);
      await page.evaluate(() => { window.__shareRead = false; });
      const flat = res.shares.map((s) => s[0]).sort((a, b) => a.name.localeCompare(b.name));
      const want = outs.map((o, i) => ({ name: path.basename(o), size: sizes2[i] })).sort((a, b) => a.name.localeCompare(b.name));
      check(res.got.filter((g) => g.ready).length === 2 && !res.got.some((g) => g.fail)
        && flat.length === 2 && flat.every((f, i) => f.name === want[i].name && f.size === want[i].size && f.read === want[i].size),
        '[I] both reach "ready", and each shares its whole file, readable to the last byte', { res, want });
    }

    console.log('\n=== [K] a file made outside an export task (Apply effects, Save video with captions) ===');
    {
      await page.evaluate(() => window.__islandHide && window.__islandHide());
      await page.evaluate(installSampler);
      await page.evaluate((p) => window.finishedFile(p), outs[1]);
      const card = await until(() => page.evaluate(() => !!document.querySelector('#overlay:not(.hidden) .overlay-save')), 20000, 50);
      const KS = await stopSampler(page);
      // (this file was already brought down earlier in the run, so the "onto your phone"
      // stage can be over between two samples — the card in the same overlay is the point)
      check(!!card && KS.some((s) => s.ov && (/onto your phone/.test(s.msg) || /ready/i.test(s.msg))),
        '[K] it comes down in the overlay and ends on the same "Save to Photos" card', KS.slice(-2));
      check(KS.every((s) => !/Saving to your phone/.test(s.isl) && !/^Saved/.test(s.isl)), '[K] no island bar, no "Saved" before Photos',
        Array.from(new Set(KS.map((s) => s.isl).filter(Boolean))));
      await page.click('#overlay .overlay-later');
      await sleep(200);
      check(await page.evaluate(() => document.getElementById('overlay').classList.contains('hidden') && !document.querySelector('.overlay-save-acts')),
        '[K] "Not now" puts the overlay away clean');
    }

    check(errors.length === 0, 'the phone page ran without errors', errors);

    console.log('\n=== [J] a computer\'s browser ===');
    {
      const { page: desk, ctx } = await open({ viewport: { width: 1280, height: 800 }, acceptDownloads: true }, false);
      const dPlan = await desk.evaluate(() => window.__deliverPlan({ durationSec: 600, quality: '1080p' }));
      check(Array.isArray(dPlan) && dPlan.length === 0, '[J] a desk plans nothing for a phone', dPlan);
      const dl = desk.waitForEvent('download', { timeout: 150000 }).catch(() => null);
      await desk.evaluate(installSampler);
      await desk.evaluate(() => window.VideoEditor.__test.clickExportEdited());
      const got = await dl;
      const DS = await stopSampler(desk);
      check(!!got && /edited/.test(got.suggestedFilename()), '[J] the export ends in the browser\'s own download, as before', got && got.suggestedFilename());
      check(DS.every((s) => !s.card) && DS.every((s) => !/onto your phone/.test(s.msg)), '[J] no Save card, nothing about a phone');
      check(DS.some((s) => /^Saved/.test(s.isl)), '[J] and it still says "Saved: …"', Array.from(new Set(DS.map((s) => s.isl).filter(Boolean))));
      await ctx.close();
    }
    check(errors.length === 0, 'no page errors anywhere', errors);
  } catch (e) {
    console.log('ERROR', e && e.stack || e);
    fail++;
  } finally {
    await done();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
