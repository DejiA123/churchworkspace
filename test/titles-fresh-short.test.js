'use strict';
/*
 * A TITLE STARTS FRESH IN EVERY SHORT — in a real browser, on the real Cloud
 * Studio, on an iPhone-sized screen.
 *
 * "The animation… can there be an option that it also starts at the start of
 *  each short? At the moment it is just the whole clip it does it — there
 *  should be a fresh start of the animation for each short." A name banner put
 * on at 0:00, coming back every 12 s for 4 s, counted its 12 seconds from 0:00
 * of the whole sermon, so a short cut from 0:20 caught it wherever that count
 * was (not due until 0:24). Now, by default:
 *   [1] each short starts it afresh: the short from 0:20 has it at 0:20–0:24 and
 *       0:32–0:36 (its own 0 s and 12 s), the one from 0:41.5 at 0:41.5–0:45.5
 *   [2] the export of that short starts with the title sliding in, at once
 *   [3] the preview shows the same, short by short — and between shorts (where
 *       only the whole video is) the whole video's count
 *   [4] "Fresh in every short" in the title's panel: on by default; off, the
 *       short gets the whole video's count again (in the preview and the export)
 *
 *   node test/titles-fresh-short.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — fresh titles in every short were not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7437;
const CODE = 'freshtitle-test-5520';
const WORK = path.join(os.tmpdir(), 'mw-fresh-title-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, e = 0.05) => Math.abs(a - b) <= e;

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
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=60', '-f', 'lavfi', '-i', 'sine=f=220:d=60',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    const T = (name, ...a) => page.evaluate(({ name, a }) => window.VideoEditor.__test[name](...a), { name, a });

    // the speaker's name banner at 0:00 — every 12 s for 4 s, to the end
    await page.evaluate(() => { document.getElementById('vePlayer').currentTime = 0; });
    await sleep(300);
    await page.evaluate(() => window.VideoEditor.textTemplates());
    await sleep(600);
    await page.click('[data-ttl="bar2"]');
    await sleep(800);
    const o = (await T('textOverlaysRaw')).find((x) => x.kind === 'title');
    check(!!o && o.start === 0 && o.repeat && o.repeat.on && o.repeat.every === 12 && o.repeat.hold === 4, 'a name banner on from 0:00, every 12 s for 4 s', o);
    // two shorts, cut from 0:20 and from 0:41.5
    await T('addShort', 20, 40);
    await T('addShort', 41.5, 58);

    console.log('\n=== [1] each short starts it afresh ===');
    const s1 = await T('titleShows', o.id, 20, 40), s2 = await T('titleShows', o.id, 41.5, 58);
    check(s1.length === 2 && near(s1[0][0], 20) && near(s1[0][1], 24) && near(s1[1][0], 32) && near(s1[1][1], 36),
      'the short from 0:20: up at its 0 s and 12 s (0:20–0:24, 0:32–0:36), not at the sermon’s 0:24', s1);
    check(s2.length === 2 && near(s2[0][0], 41.5) && near(s2[1][0], 53.5), 'the short from 0:41.5: up at 0:41.5 and 0:53.5', s2);

    console.log('\n=== [2] the export of a short starts with the title sliding in ===');
    const strip = async (a, b) => { const r = await T('textPngsForShort', a, b, 540, 960); const x = (r || []).find((y) => y.strip); return x && x.strip; };
    let st = await strip(20, 40);
    const blankIdx = st ? st.frames - 1 : -1;
    const ons = (seq) => { const out = []; let t = 0; for (const [f, d] of seq) { if (f !== blankIdx) { if (!out.length || Math.abs(out[out.length - 1][1] - t) > 1e-3) out.push([t, t + d]); else out[out.length - 1][1] = t + d; } t += d; } return out; };
    const on1 = st ? ons(st.seq) : [];
    check(!!st && st.seq[0][0] === 0 && st.seq[0][1] > 0, 'its first picture, at 0 s, is the title arriving (no wait)', st && st.seq.slice(0, 3));
    check(on1.length === 2 && near(on1[0][0], 0) && near(on1[0][1], 4, 0.05) && near(on1[1][0], 12, 0.05), 'on screen at 0–4 s and from 12 s of the short', on1);

    console.log('\n=== [3] the preview shows the same ===');
    const up = async (t) => T('textUpAt', o.id, t);
    const pv = { a: await up(20.3), b: await up(26), c: await up(32.5), d: await up(41.8), gap: await up(40.8), before: await up(13) };
    check(pv.a && !pv.b && pv.c && pv.d, 'in each short it is up as the short starts and every 12 s of it (0:20.3 ✓, 0:26 ✗, 0:32.5 ✓, 0:41.8 ✓)', pv);
    check(!pv.gap && pv.before, 'outside the shorts, the whole video’s count (0:13 ✓ — up 0:12–0:16; 0:40.8 ✗)', pv);
    // and on the picture itself
    await page.evaluate(() => { document.getElementById('vtDone').click(); });
    await sleep(300);
    await page.evaluate(() => { const p = document.getElementById('vePlayer'); p.currentTime = 20.4; });
    await sleep(700);
    const shown = await page.evaluate(() => !!document.querySelector('.ve-title-box'));
    check(shown, 'at 0:20.4 the banner is on the picture', shown);

    console.log('\n=== [4] the switch in the title’s panel ===');
    await page.evaluate((id) => window.VideoEditor.__test.editText ? window.VideoEditor.__test.editText(id) : null, o.id);
    await page.evaluate(() => window.VideoEditor.editSelectedText());
    await sleep(700);
    const box = await page.evaluate(() => { const b = document.getElementById('vtFresh'); return b && { checked: b.checked, shown: !!b.offsetParent }; });
    check(box && box.checked && box.shown, '“Fresh in every short” is in the title’s panel, ticked', box);
    await page.locator('#vtFresh').tap();
    await sleep(400);
    let raw = (await T('textOverlaysRaw')).find((x) => x.id === o.id);
    const off = { fresh: raw.repeat.fresh, shows: await T('titleShows', o.id, 20, 40), up: await up(20.3) };
    check(off.fresh === false && off.shows.length && near(off.shows[0][0], 24) && off.up === false,
      'unticked: the short from 0:20 gets the whole video’s count again (first up at 0:24), the preview too', off);
    st = await strip(20, 40);
    check(!!st && st.seq[0][0] === st.frames - 1 && near(st.seq[0][1], 4, 0.05), '…and so does its export (nothing for its first 4 s)', st && st.seq.slice(0, 2));
    await page.locator('#vtFresh').tap();
    await sleep(400);
    raw = (await T('textOverlaysRaw')).find((x) => x.id === o.id);
    check(raw.repeat.fresh === true && raw.repeat.every === 12 && raw.repeat.hold === 4 && raw.repeat.on, 'ticked again, fresh in every short — the schedule kept', raw.repeat);
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
