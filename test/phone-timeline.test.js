'use strict';
/*
 * THE PHONE'S TIMELINE, AS CAPCUT HAS IT — in a real browser, on the real
 * Cloud Studio, the way an iPhone uses it.
 *
 *   [A] the white line stays in the middle: at the start, after a swipe, while
 *       playing, at the very end, after a pinch and after Fit — and the start
 *       and the end of the video both reach it
 *   [B] a swipe is a scrub: whatever is under the line is what the picture
 *       shows, and taking the timeline stops playback
 *   [C] nothing jumps on a tap; trim handles belong to the selected clip only;
 *       a first tap on a caption selects it, its handle trims it, a second tap
 *       types into it
 *   [D] the things a review found: a touch on a block the lane redraws cannot
 *       freeze the timeline; Play during a coasting flick keeps playing; a
 *       long press on empty track still draws a clip; a wide screen keeps the
 *       desk's timeline
 *   [E] a caption typed in lower case wears the Case that is chosen
 *
 * Needs Playwright with Chromium (it is not one of the app's dependencies);
 * without it this says so and skips.
 *
 *   node test/phone-timeline.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the phone timeline was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7397;
const CODE = 'timeline-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-timeline-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

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

(async () => {
  // a 40 s picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=40', '-f', 'lavfi', '-i', 'sine=f=220:d=40',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const open = async (ctxOpts) => {
      const ctx = await browser.newContext(ctxOpts);
      await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
      await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(1000);
      return page;
    };
    const page = await open({ ...devices['iPhone 13'] });
    const geo = () => page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), ph = document.getElementById('vePlayhead'), p = document.getElementById('vePlayer');
      const r = sc.getBoundingClientRect(), h = ph.getBoundingClientRect();
      return { centred: sc.classList.contains('ve-centred'), pad: parseFloat(sc.style.paddingLeft) || 0, half: sc.clientWidth / 2,
        x: h.left + h.width / 2 - r.left, scroll: sc.scrollLeft, t: p.currentTime, paused: p.paused, D: p.duration };
    });
    // a finger on the timeline: touchstart, the scroll it makes, touchend
    const swipe = (dx) => page.evaluate((dx) => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const fire = (type) => { const t = new Touch({ identifier: 1, target: sc, clientX: r.left + 100, clientY: r.top + 60 });
        sc.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] })); };
      fire('touchstart'); sc.scrollLeft += dx;
      return new Promise((res) => setTimeout(() => { fire('touchend'); res(); }, 120));
    }, dx);
    const centred = (g) => Math.abs(g.x - g.half) <= 3;

    // the phone runs the Word Book too ("Fix captions from book"): its built-in names must have the
    // known-word list, or the phone could do what the server no longer does ("plate" -> "Pilate")
    const wb = await page.evaluate(() => {
      const W = window.WordBook, m = W.compile({ enabled: true, soundAlike: true, fixes: [], terms: [] });
      const say = (t) => W.applyToWords(t.split(' ').map((x, i) => ({ text: x, start: i, end: i + 0.9 })), m).words.map((w) => w.text).join(' ');
      return { list: typeof window.WordBookEnglish === 'string', plate: say('the plate was'), name: say('think about Methabosheth who') };
    });
    check(wb.list && wb.plate === 'the plate was' && wb.name === 'think about Mephibosheth who',
      'the phone loads the known-word list: "plate" stays, "Methabosheth" is still fixed', wb);

    console.log('\n=== [A] the line stays in the middle ===');
    let g = await geo();
    check(g.centred && Math.abs(g.pad - g.half) <= 1, 'the phone timeline is centred, with half a screen of room before the start', g);
    check(centred(g) && g.t === 0, 'at 0:00 the start of the video is on the line', g);
    await swipe(100000);
    await sleep(500);
    g = await geo();
    check(g.t > g.D - 0.6 && centred(g), 'scrolled all the way, the end of the video is on the line', g);

    console.log('\n=== [B] a swipe is a scrub ===');
    await swipe(-100000); await swipe(220);
    await sleep(500);
    g = await geo();
    const pps = await page.evaluate(() => window.VideoEditor.zoomLevel());
    check(centred(g) && Math.abs(g.t - 220 / pps) < 0.15, 'the picture shows whatever the swipe left under the line', { t: g.t, want: 220 / pps });
    const b0 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').play());
    await sleep(1500);
    const b1 = await geo();
    check(b1.t > b0.t + 0.8 && b1.scroll > b0.scroll + 8 && centred(b1), 'playing slides the clips under a still line', { b0, b1 });
    await swipe(-60);
    await sleep(400);
    check((await geo()).paused, 'taking the timeline while it plays stops it');

    console.log('\n=== [C] taps, handles, captions ===');
    const t0 = (await geo()).t;
    const seg = await page.locator('#veSegments .ve-seg').first().boundingBox();
    await page.touchscreen.tap(seg.x + Math.min(seg.width - 30, 260), seg.y + seg.height / 2);
    await sleep(500);
    check(await page.evaluate(() => !!document.querySelector('#veSegments .ve-seg.sel')), 'a tap on a clip selects it');
    check(Math.abs((await geo()).t - t0) < 0.05, 'and nothing moves');
    const hs = await page.evaluate(() => Array.from(document.querySelectorAll('#veSegments .ve-seg')).map((s) => ({ sel: s.classList.contains('sel'), h: getComputedStyle(s.querySelector('.ve-seg-h')).display })));
    check(hs.every((x) => (x.sel ? x.h !== 'none' : x.h === 'none')), 'trim handles show on the selected clip only', hs);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.currentTime = 14; });
    await sleep(500);
    await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      const w = 'the lord is my shepherd i shall not want he makes me lie down'.split(' ').map((x, i) => ({ text: x, start: 12 + i * 0.6, end: 12 + i * 0.6 + 0.5 }));
      T.setCapWords(w, 0); T.setCapWordsPerLine(3); T.setCapCase('upper'); T.revealCaps();
    });
    await sleep(700);
    // (showing the captions takes the timeline to the first line: tap the one on screen)
    const ci = await page.evaluate(() => { const sc = document.getElementById('veTlScroll').getBoundingClientRect();
      const b = Array.from(document.querySelectorAll('#veCapTrack .ve-cap-clip')).find((n) => { const r = n.getBoundingClientRect(); return r.left >= sc.left && r.right <= sc.right && r.width > 60; });
      return b ? +b.dataset.i : -1; });
    const blk = page.locator(`#veCapTrack .ve-cap-clip[data-i="${ci}"]`);
    let bb = await blk.boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(400);
    const cs = await page.evaluate((ci) => ({ ci, sel: !!document.querySelector(`#veCapTrack .ve-cap-clip.sel[data-i="${ci}"]`), editing: !!document.querySelector('#veCapTrack .ve-cap-clip.editing') }), ci);
    check(cs.sel && !cs.editing, 'a first tap on a caption selects it without starting to type', cs);
    const before = await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].end, ci);
    const hr = await page.locator(`#veCapTrack .ve-cap-clip[data-i="${ci}"] .ve-cc-h.r`).boundingBox();
    const hx = hr.x + hr.width / 2, hy = hr.y + hr.height / 2;
    const fireAt = (type, x, y) => page.evaluate(({ type, x, y }) => {
      const el = document.elementFromPoint(x, y) || document.body;
      const t = new Touch({ identifier: 3, target: el, clientX: x, clientY: y });
      (type === 'touchstart' ? el : document).dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], changedTouches: [t], targetTouches: type === 'touchend' ? [] : [t] }));
    }, { type, x, y });
    await fireAt('touchstart', hx, hy);
    for (let k = 1; k <= 6; k++) { await fireAt('touchmove', hx + k * 6, hy); await sleep(30); }
    await fireAt('touchend', hx + 36, hy);
    await sleep(400);
    check(await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].end, ci) > before + 0.1, 'its handle trims it, on the phone');
    bb = await blk.boundingBox();
    await page.touchscreen.tap(bb.x + Math.min(20, bb.width / 3), bb.y + bb.height / 2);
    await sleep(400);
    check(await page.evaluate(() => !!document.querySelector('#veCapTrack .ve-cap-clip.editing')), 'a second tap types into it');
    await page.evaluate(() => { const l = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label'); if (l) { l.textContent = 'my shepherd is good'; l.blur(); } });
    await sleep(300);

    console.log('\n=== [E] the chosen Case ===');
    check(await page.evaluate((ci) => window.VideoEditor.__test.capLines()[ci].text, ci) === 'MY SHEPHERD IS GOOD', 'a line typed in lower case is saved in ALL CAPS when that is chosen');

    console.log('\n=== [F] every fixed line in one place ===');
    {
      await page.evaluate(() => window.VideoEditor.__test.openCaptionsWindow());
      await sleep(600);
      await page.evaluate(() => {
        const T = window.VideoEditor.__test;
        T.markCapFixed(1, 'WHAT TO TO', 'TO');
        T.markCapFixed(3, 'WE WE HURT', 'WE HURT');
        // (no speech engine on a test machine, so the window is shown by hand)
        document.getElementById('capModal').classList.remove('hidden');
        document.querySelector('#capModal .cap-box').classList.add('folded');   // as it is once there are lines
      });
      await sleep(400);
      const st = () => page.evaluate(() => ({
        tabs: document.querySelectorAll('#capList .cap-fix-tabs [data-capfix]').length,
        rows: document.querySelectorAll('#capList .cap-row').length,
        fixed: document.querySelectorAll('#capList .cap-row.fixed').length,
      }));
      const all = await st();
      check(all.tabs === 2 && all.rows > 2 && all.fixed === 2, 'the captions window offers "All lines | ✍ Fixed" when lines were fixed', all);
      if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'fixed-all.png') });
      await page.locator('#capList [data-capfix="fixed"]').tap();
      await sleep(300);
      const only = await st();
      check(only.rows === 2 && only.fixed === 2, '"✍ Fixed" lists only the fixed lines, with their Put back', only);
      if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'fixed-only.png') });
      await page.locator('#capList [data-capfix="all"]').tap();
      await sleep(300);
      check((await st()).rows === all.rows, '"All lines" brings the whole transcript back');
      await page.evaluate(() => { const T = window.VideoEditor.__test; T.markCapFixed(1, null); T.markCapFixed(3, null); });
      await page.evaluate(() => document.getElementById('capModal').classList.add('hidden'));
      await sleep(400);
    }

    console.log('\n=== [H] ⚠ Check: only the lines the two listens disagreed on ===');
    {
      await page.evaluate(() => window.VideoEditor.__test.openCaptionsWindow());
      await sleep(500);
      const L = await page.evaluate(() => window.VideoEditor.__test.capLines());
      await page.evaluate((L) => {
        const T = window.VideoEditor.__test;
        // the other ear heard line 2 as "I SHALL NOT WANT" — over that line's own time
        const alt = 'i shall not want'.split(' ').map((x, k) => ({ text: x, start: L[2].start + k * 0.3, end: L[2].start + k * 0.3 + 0.25 }));
        T.markCapDoubt(2, 'differ', alt);
        T.markCapDoubt(4, 'unsure');
        document.getElementById('capModal').classList.remove('hidden');
        document.querySelector('#capModal .cap-box').classList.add('folded');
      }, L);
      await sleep(300);
      const st = () => page.evaluate(() => ({
        note: (document.querySelector('#capList .cap-check-note') || {}).textContent || '',
        check: (document.querySelector('#capList [data-capfix="check"]') || {}).textContent || '',
        rows: document.querySelectorAll('#capList .cap-row').length,
        doubts: document.querySelectorAll('#capList .cap-row.doubt').length,
        laneDots: document.querySelectorAll('#veCapTrack .ve-cap-clip.doubt').length,
      }));
      const a = await st();
      check(/⚠ Check\s*2/.test(a.check) && a.doubts === 2, 'the window offers "⚠ Check 2" and marks those two lines', a);
      // (with Fixed too, four tabs are wider than a phone — nothing may slide sideways)
      await page.evaluate(() => window.VideoEditor.__test.markCapFixed(0, 'WAS', 'NOW'));
      await sleep(300);
      const wide = await page.evaluate(() => {
        const l = document.getElementById('capList');
        // as on a whole sermon: four-digit counts
        l.querySelectorAll('.cap-fix-tabs [data-capfix]').forEach((b, k) => { const sp = b.lastElementChild; if (sp) sp.textContent = ['1537', '252', '1'][k]; });
        const r = l.getBoundingClientRect();
        const out = [...l.querySelectorAll('.cap-fix-tabs button, .cap-row')].filter((e) => { const b = e.getBoundingClientRect(); return b.right > r.right + 1 || b.left < r.left - 1; }).length;
        const tb = l.querySelector('.cap-fix-tabs').getBoundingClientRect(), first = l.querySelector('.cap-row').getBoundingClientRect();
        return { head: Math.round(first.top - r.top), tabsH: Math.round(tb.height), sw: l.scrollWidth, cw: l.clientWidth, out, tabs: [...l.querySelectorAll('.cap-fix-tabs button')].map((b) => b.textContent + ':' + Math.round(b.getBoundingClientRect().right)), lw: Math.round(r.right) };
      });
      check(wide.sw <= wide.cw + 1 && wide.out === 0 && wide.tabs.length === 4, 'the tabs and lines all fit the phone\'s width (no sideways scroll)', wide);
      check(wide.tabsH <= 64 && wide.head <= 110, 'the summary and the filters take one slim line each — the lines get the room', wide);
      if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'tabs-fit.png') });
      const sum = await page.evaluate(() => {
        window.VideoEditor.__test.markAllChecked();
        const n = document.querySelector('#capList .cap-check-note');
        return n ? { text: n.textContent, h: Math.round(n.getBoundingClientRect().height), bar: !!n.querySelector('.cap-check-bar i') } : null;
      });
      check(sum && /Heard twice · \d+ of \d+ agree/.test(sum.text) && sum.bar && sum.h <= 24, 'what the two listens found is one slim line with a bar', sum);
      if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'tabs-sum.png') });
      await page.evaluate(() => window.VideoEditor.__test.markCapFixed(0, null));
      check(a.laneDots >= 1, 'a doubtful line is marked on the timeline lane too', a);
      await page.locator('#capList [data-capfix="check"]').tap();
      await sleep(300);
      const b = await st();
      check(b.rows === 2, '"⚠ Check" lists only the two lines worth a look', b);
      if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'check-tab.png') });
      const ctx = await page.evaluate((L) => {
        const row = document.querySelector('#capList .cap-row[data-row="2"]');
        const before = row && row.querySelector('.cap-ctx-before'), after = row && row.querySelector('.cap-ctx-after .cap-ctx-tx');
        const bb = before && before.getBoundingClientRect(), ib = row && row.querySelector('.cap-text').getBoundingClientRect();
        return { before: before && before.textContent, after: after && after.textContent, above: !!(bb && ib && bb.bottom <= ib.top + 1), want: [L[1].text, L[3].text] };
      }, L);
      check(ctx.before && ctx.before.includes(ctx.want[0]) && ctx.after && ctx.after.includes(ctx.want[1]) && ctx.above,
        'a line to check shows the line before (above it) and the line after', ctx);
      await page.evaluate(() => { document.getElementById('vePlayer').muted = true; });
      await page.locator('#capList .cap-row[data-row="2"] [data-ctx-i]').tap();
      await sleep(250);
      const heard = await page.evaluate(() => ({ t: document.getElementById('vePlayer').currentTime, paused: document.getElementById('vePlayer').paused }));
      check(!heard.paused && heard.t >= L[1].start - 0.2 && heard.t < L[2].start, '"Hear it in context" plays from the line before', { heard, from: L[1].start });
      await page.evaluate(() => document.getElementById('vePlayer').pause());
      const use = page.locator('#capList [data-doubt-use]');
      check(await use.count() === 1 && /I SHALL NOT WANT/.test(await page.locator('#capList .cap-doubt-tx').first().textContent()),
        'the doubtful line shows what the other ear heard, in the chosen Case');
      await use.first().tap();
      await sleep(300);
      const after = await page.evaluate(() => window.VideoEditor.__test.capLines()[2].text);
      check(after === 'I SHALL NOT WANT', '"Use that" takes it in one tap', after);
      await page.locator('#capList [data-doubt-ok]').first().tap();
      await sleep(300);
      const c = await st();
      check(c.doubts === 0 && !/⚠ Check/.test(c.check), '"✓ It\'s right" settles the other — nothing left to check', c);
      await page.evaluate(() => { document.getElementById('veUndo').click(); });   // put line 2 back as it was
      await page.evaluate(() => document.getElementById('capModal').classList.add('hidden'));
      await sleep(300);
    }

    console.log('\n=== [I] ▶ in the captions window keeps playing ===');
    {
      await page.evaluate(() => window.VideoEditor.__test.openCaptionsWindow());
      await sleep(500);
      await page.evaluate(() => {
        document.getElementById('capModal').classList.remove('hidden');
        document.querySelector('#capModal .cap-box').classList.add('folded');
        document.getElementById('vePlayer').muted = true;
      });
      await sleep(300);
      await page.locator('#capPlay').tap();
      await sleep(1500);
      // iPhone: the address bar folds away and the screen grows — the timeline under the window re-lays itself
      const vp = page.viewportSize();
      await page.setViewportSize({ width: vp.width, height: vp.height + 60 });
      await sleep(1500);
      await page.setViewportSize(vp);
      await sleep(800);
      // a scroll nobody made (the timeline under the window re-laid) is not a hand taking it
      await page.evaluate(() => { const sc = document.getElementById('veTlScroll'); sc.scrollLeft += 150; });
      await sleep(1200);
      const st = await page.evaluate(() => { const p = document.getElementById('vePlayer'); return { paused: p.paused, t: p.currentTime, btn: document.getElementById('capPlay').textContent }; });
      check(!st.paused && st.t > 3 && st.btn === '⏸', 'after five seconds it is still playing', st);
      await page.locator('#capPlay').tap();
      await sleep(300);
      await page.evaluate(() => document.getElementById('capModal').classList.add('hidden'));
      await sleep(300);
    }

    console.log('\n=== [G] ＋ Add caption, after the AI made some ===');
    {
      const L0 = await page.evaluate(() => window.VideoEditor.__test.capLines());
      // the playhead ON the second line
      await page.evaluate((t) => { document.getElementById('vePlayer').currentTime = t; }, L0[1].start + 0.2);
      await sleep(400);
      // the phone's tool: Captions → the caption row's "Add caption" (same call)
      await page.evaluate(() => window.VideoEditor.addCaptionHere());
      await sleep(400);
      const ed = await page.evaluate(() => { const l = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label'); return { editing: !!l, focused: !!l && document.activeElement === l }; });
      check(ed.editing && ed.focused, 'a new line opens for typing at once', ed);
      await page.evaluate(() => { const l = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label'); l.textContent = 'praise the lord'; l.dispatchEvent(new Event('input')); l.blur(); });
      await sleep(400);
      const L1 = await page.evaluate(() => window.VideoEditor.__test.capLines());
      const added = L1.find((c) => c.text === 'PRAISE THE LORD');
            check(!!added && L1.length === L0.length + 1, 'it is on the lane, in the chosen Case', L1.map((c) => c.text));
      // lines that run end to end have no gap: the line under the playhead gives up its tail
      check(added && Math.abs(added.start - Math.max(L0[1].start + 0.3, L0[1].start + 0.2)) < 0.05 && L1.every((c) => c === added || c.end <= added.start + 0.001 || c.start >= added.end - 0.001),
        'it goes in at the playhead (not at the next gap far away), overlapping nothing', { added, was: L0[1] });
      await page.evaluate(() => window.VideoEditor.__test.setCapWordsPerLine(2));
      await sleep(300);
      check((await page.evaluate(() => window.VideoEditor.__test.capLines())).some((c) => c.text === 'PRAISE THE LORD'),
        'changing Words per line keeps a line typed by hand');
      await page.evaluate(() => window.VideoEditor.__test.setCapWordsPerLine(3));
      await page.evaluate(() => { document.getElementById('veUndo').click(); document.getElementById('veUndo').click(); document.getElementById('veUndo').click(); });
      await sleep(300);
      check(!(await page.evaluate(() => window.VideoEditor.__test.capLines())).some((c) => c.text === 'PRAISE THE LORD'), 'Undo takes it away again');
      await page.evaluate(() => document.getElementById('veRedo').click());
      await sleep(200);
    }

    console.log('\n=== [D] what the review found ===');
    await page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const el = document.createElement('div'); el.style.cssText = 'position:absolute;left:0;top:0;width:50px;height:30px'; sc.appendChild(el);
      const t = new Touch({ identifier: 7, target: el, clientX: r.left + 20, clientY: r.top + 20 });
      el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      el.remove();     // the lane redrew the block under the finger
      el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
    });
    await sleep(300);
    const d0 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').play());
    await sleep(1200);
    const d1 = await geo();
    await page.evaluate(() => document.getElementById('vePlayer').pause());
    check(d1.t > d0.t + 0.6 && d1.scroll > d0.scroll + 4 && centred(d1), 'a touch on a block the lane redrew does not stop the timeline following playback', { d0, d1 });
    await sleep(300);
    // a flick that is still coasting, then Play
    await page.evaluate(() => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect();
      const t = new Touch({ identifier: 9, target: sc, clientX: r.left + 120, clientY: r.top + 60 });
      sc.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      sc.scrollLeft += 40;
      sc.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
    });
    await sleep(60);
    await page.evaluate(() => document.getElementById('vePlayer').play());
    for (let k = 0; k < 4; k++) { await page.evaluate(() => { document.getElementById('veTlScroll').scrollLeft += 6; }); await sleep(40); }
    await sleep(800);
    check(!(await geo()).paused, 'Play during a coasting flick keeps playing');
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.pause(); });
    await sleep(300);
    // the same with the studio's own Play button, the coast stepping in the SAME frame (second review:
    // the media 'play' event comes later, and a coasting step before it paused the video again)
    const events = await page.evaluate(async () => {
      const sc = document.getElementById('veTlScroll'), r = sc.getBoundingClientRect(), p = document.getElementById('vePlayer');
      const seen = []; const on = (e) => seen.push(e.type); p.addEventListener('play', on); p.addEventListener('pause', on);
      const t = new Touch({ identifier: 11, target: sc, clientX: r.left + 120, clientY: r.top + 60 });
      sc.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] }));
      sc.scrollLeft += 40;
      sc.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], changedTouches: [t], targetTouches: [] }));
      await new Promise((res) => setTimeout(res, 60));
      document.getElementById('vePlay').click();
      sc.scrollLeft += 6; sc.dispatchEvent(new Event('scroll'));   // the coast, before 'play' arrives
      for (let k = 0; k < 4; k++) { await new Promise((res) => requestAnimationFrame(res)); sc.scrollLeft += 6; }
      await new Promise((res) => setTimeout(res, 600));
      p.removeEventListener('play', on); p.removeEventListener('pause', on);
      return { seen, paused: p.paused };
    });
    check(!events.paused && !events.seen.includes('pause'), 'tapping Play during a coasting flick keeps playing (no play-then-pause)', events);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 12; });
    await sleep(400);
    await page.evaluate(() => { const f = document.getElementById('veZoomFit'); if (f) f.click(); });
    await sleep(500);
    g = await geo();
    check(Math.abs(g.t - 12) < 0.1 && centred(g), 'Fit keeps the video where it was, the line in the middle', g);
    await page.evaluate(() => { const E = window.VideoEditor; E.zoomAround(E.zoomLevel() * 2, 0, 10); });
    await sleep(400);
    g = await geo();
    check(Math.abs(g.t - 12) < 0.1 && centred(g), 'a pinch keeps the line on the same moment', g);
    const lp = await page.evaluate(async () => {
      const tk = document.getElementById('veTrack'), b = tk.getBoundingClientRect();
      const t0 = document.getElementById('vePlayer').currentTime;
      const x = b.left + b.width * 0.3, y = b.top + 3;
      const mk = (type, cx) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
      tk.dispatchEvent(mk('mousedown', x));      // the touch bridge's long press: untrusted, like this
      for (let k = 1; k <= 5; k++) document.dispatchEvent(mk('mousemove', x + k * 12));
      const shown = getComputedStyle(document.getElementById('veSelbox')).display;
      document.dispatchEvent(mk('mouseup', x + 60));
      await new Promise((r) => setTimeout(r, 300));
      return { shown, moved: Math.abs(document.getElementById('vePlayer').currentTime - t0) };
    });
    check(lp.shown === 'block' && lp.moved < 0.05, 'a long press on empty track still draws a clip, without moving the line', lp);
    const still = await page.evaluate(async () => {
      const tk = document.getElementById('veTrack'), b = tk.getBoundingClientRect();
      const t0 = document.getElementById('vePlayer').currentTime;
      const x = b.left + b.width * 0.7, y = b.top + 3;
      const mk = (type) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1 });
      tk.dispatchEvent(mk('mousedown'));                     // a long press that ends without moving (a slow tap)
      document.dispatchEvent(mk('mouseup'));
      await new Promise((r) => setTimeout(r, 300));
      return Math.abs(document.getElementById('vePlayer').currentTime - t0);
    });
    check(still < 0.05, 'a long press that lifts without moving does not jump the video there', still);
    console.log('\n=== [J] "Follow the voice" survives closing the app ===');
    {
      const was = await page.evaluate(() => { const b = document.getElementById('capWordHl'); return b.checked; });
      await page.evaluate((want) => { const b = document.getElementById('capWordHl'); b.checked = want; b.dispatchEvent(new Event('change', { bubbles: true })); }, !was);
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
      await sleep(800);
      const now = await page.evaluate(() => document.getElementById('capWordHl').checked);
      check(now === !was, 'the tick is still there after the app is closed and opened again', { was, now });
      await page.evaluate((want) => { const b = document.getElementById('capWordHl'); b.checked = want; b.dispatchEvent(new Event('change', { bubbles: true })); }, was);
    }
    const wide = await open({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const wg = await wide.evaluate(() => ({ centred: document.getElementById('veTlScroll').classList.contains('ve-centred'), pad: document.getElementById('veTlScroll').style.paddingLeft }));
    check(!wg.centred && !wg.pad, 'a wide screen keeps the desk\'s timeline', wg);
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
