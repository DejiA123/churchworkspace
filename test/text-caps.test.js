'use strict';
/*
 * ALL CAPS ON THE TEXT TOOL.
 *
 * "There should be an option to make the text all caps even if the user types
 * in lowercase." The text panel's AA button shows the words in capitals however
 * they were typed — on the picture, while typing, and in the exported file —
 * and the words themselves are kept as typed, so turning it off brings them back.
 *
 *   [1] AA puts the words in capitals on the picture; the words are kept as typed
 *   [2] typing lowercase with it on shows capitals and still keeps what was typed
 *   [3] the export is in capitals: a short with "grace & mercy" + AA comes out
 *       the same as one typed "GRACE & MERCY", and not like the lowercase one
 *   [4] AA again turns it off
 *
 *   node test/text-caps.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require('ffmpeg-static');
const PORT = 7386, CODE = 'caps-test-6620';
const WORK = path.join(os.tmpdir(), 'mw-text-caps-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + (typeof d === 'string' ? d : JSON.stringify(d)) : '')); ok ? pass++ : fail++; };
const post = (p, body) => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } },
    (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data);
});
const up = async () => { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; };
// one grey frame from the middle of an export, as raw bytes
const frameOf = (file) => execFileSync(ffmpeg, ['-v', 'error', '-ss', '2', '-i', file, '-frames:v', '1', '-vf', 'scale=180:320,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };

(async () => {
  // a plain dark picture, so the only thing in the frame is the text
  const VID = path.join(MEDIA, 'plain.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x203040:s=640x360:r=15:d=12', '-f', 'lavfi', '-i', 'sine=f=220:d=12',
    '-c:v', 'libvpx-vp9', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await up())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'no page errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    const id = await page.evaluate(() => {
      const T = window.VideoEditor.__test;
      T.applyClips([{ start: 1, end: 7, label: 'Caps' }]);
      const p = document.getElementById('vePlayer'); p.pause(); p.currentTime = 3;
      return T.addTextAt({ text: 'grace & mercy', start: 0, end: 999, x: 0.5, y: 0.5, sizePct: 0.08 });
    });
    const sid = await page.evaluate(() => window.VideoEditor.__test.segments().find((s) => s.end - s.start < 10).id);
    await sleep(500);
    const shown = () => page.evaluate((id) => {
      const c = document.querySelector(`.ve-text-box[data-id="${id}"] .ve-text-content`);
      const b = document.getElementById('vtCaps');
      return { seen: c && c.innerText, kept: window.VideoEditor.__test.textOf(id), on: !!(b && b.classList.contains('on')), caps: window.VideoEditor.__test.textStyleOf(id).caps };
    }, id);

    console.log('\n[1] AA');
    const bb = await page.locator(`.ve-text-box[data-id="${id}"]`).boundingBox();
    await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await sleep(400);
    const btn = page.locator('#vtCaps');
    check(await btn.isVisible(), 'the text panel has an ALL CAPS button (AA)');
    const plainShot = await page.evaluate(async (sid) => window.VideoEditor.__test.exportClipWithText(sid), sid);
    await btn.tap(); await sleep(300);
    const a = await shown();
    check(a.seen === 'GRACE & MERCY', 'the picture shows the words in capitals', a.seen);
    check(a.kept === 'grace & mercy', 'the words are kept as typed', a.kept);
    check(a.on && a.caps, 'the button shows it is on', a);
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'text-caps.png') });

    console.log('\n[2] typing lowercase with it on');
    await page.evaluate((id) => window.VideoEditor.__test.editTextContent(id, 'god is good'), id);
    await sleep(300);
    const b = await shown();
    check(b.seen === 'GOD IS GOOD', 'what is typed shows in capitals', b.seen);
    check(b.kept === 'god is good', 'and is kept as typed (not changed to capitals for good)', b.kept);
    await page.evaluate((id) => window.VideoEditor.__test.editTextContent(id, 'grace & mercy'), id);

    console.log('\n[3] the export');
    const capsShot = await page.evaluate(async (sid) => window.VideoEditor.__test.exportClipWithText(sid), sid);
    // the same words typed in capitals, AA off
    await page.evaluate((id) => window.VideoEditor.__test.editTextContent(id, 'GRACE & MERCY'), id);
    await page.evaluate((id) => { window.VideoEditor.__test.selectText(id); }, id);
    await btn.tap(); await sleep(300);
    const c = await shown();
    check(!c.caps && !c.on, 'AA again turns it off', c);
    const typedShot = await page.evaluate(async (sid) => window.VideoEditor.__test.exportClipWithText(sid), sid);
    const ok = [plainShot, capsShot, typedShot].every((f) => f && fs.existsSync(f));
    check(ok, 'the three shorts export', [plainShot, capsShot, typedShot].map((f) => String(f).split('/').pop()));
    if (ok) {
      const P = frameOf(plainShot), C = frameOf(capsShot), T = frameOf(typedShot);
      const same = diff(C, T), apart = diff(C, P);
      check(same < 1.5, 'ALL CAPS exports exactly like words typed in capitals', same.toFixed(2));
      check(apart > same * 3 && apart > 1, '…and not like the lowercase words', apart.toFixed(2));
    }

    console.log('\n[4] off again');
    await page.evaluate((id) => window.VideoEditor.__test.editTextContent(id, 'grace & mercy'), id);
    await sleep(300);
    const d = await shown();
    check(d.seen === 'grace & mercy', 'with it off, the words show as typed', d.seen);
  } catch (e) {
    check(false, 'ran to the end', e.message);
  } finally {
    await browser.close().catch(() => {});
    srv.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
