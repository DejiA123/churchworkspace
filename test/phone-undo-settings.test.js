'use strict';
/*
 * UNDO AND REDO TAKE BACK EVERY CHANGE in the video editor, on the phone:
 * a clip's look (Adjust, one step per change, the preview repainted), the
 * export quality, the frame fill, follow the speaker, the caption look —
 * and redo puts each back. Tapping a clip (selecting it) is not a change.
 *   node test/phone-undo-settings.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { ({ chromium, devices } = require('/opt/node-tools/node_modules/playwright')); }
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7431;
const CODE = 'undo-test-5821';
const WORK = path.join(os.tmpdir(), 'mw-phone-undo-' + process.pid);
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
  for (let i = 0; i < 80; i++) {
    try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; }
    catch (e) { await sleep(250); }
  }
  return false;
}

(async () => {
  const VID = path.join(MEDIA, 'undo.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=20', '-f', 'lavfi', '-i', 'sine=f=220:d=20',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  let browser;
  try { browser = await chromium.launch(); } catch (e) { browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }); }
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1500);

    // a person's change: the finger goes down on the control first, then it changes
    const set = (id, v) => page.evaluate(([id, v]) => {
      const el = document.getElementById(id);
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      if (el.type === 'checkbox') el.checked = v; else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    }, [id, v]);
    const press = async (id) => { await page.evaluate((id) => { const b = document.getElementById(id); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.click(); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); }, id); await sleep(900); };
    const undo = () => press('veUndo'), redo = () => press('veRedo');
    const val = (id) => page.evaluate((id) => { const el = document.getElementById(id); return el.type === 'checkbox' ? el.checked : el.value; }, id);
    const fx = () => page.evaluate(() => { const s = (window.VideoEditor.__test && window.VideoEditor.__test.segments) ? window.VideoEditor.__test.segments()[0] : null; return s ? (s.fx || null) : 'n/a'; });
    const canUndo = () => page.evaluate(() => !document.getElementById('veUndo').disabled);
    const sharpOn = () => page.evaluate(() => { const c = document.getElementById('veSharpCv'); return !!(c && c.classList.contains('on')); });

    console.log('\n=== [A] Adjust: each change is its own step, and the picture follows ===');
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('#cloudDock button, #cloudDock .cloud-tool')].find((x) => /Adjust/.test(x.textContent));
      if (b) b.click();
    });
    await sleep(600);
    await set('fxSharp', '1'); await sleep(1200);
    await set('fxBri', '0.2'); await sleep(1200);
    check(await val('fxSharp') === '1' && await val('fxBri') === '0.2' && await sharpOn(), 'Sharpen and Brightness are set, and the preview sharpens');
    await undo();
    check(await val('fxBri') === '0' && await val('fxSharp') === '1', 'one undo takes back the last change only (Brightness), not the whole visit', { bri: await val('fxBri'), sharp: await val('fxSharp') });
    await undo();
    check(await val('fxSharp') === '0' && !(await sharpOn()), 'the next undo takes back Sharpen — the slider AND the preview', { sharp: await val('fxSharp'), on: await sharpOn() });
    await redo();
    check(await val('fxSharp') === '1' && await sharpOn(), 'redo puts Sharpen back, on the preview too', { sharp: await val('fxSharp'), on: await sharpOn() });
    await redo();
    check(await val('fxBri') === '0.2', 'and redo again puts Brightness back', await val('fxBri'));
    await page.evaluate(() => { const c = document.getElementById('fxClose') || document.querySelector('#fxModal .fxq-done, #fxModal [data-close]'); if (c) c.click(); else document.getElementById('fxModal').classList.add('hidden'); });
    await sleep(500);

    console.log('\n=== [B] the export and picture settings ===');
    const q0 = await val('veQuality');
    const q1 = q0 === '720p' ? '1080p' : '720p';
    await set('veQuality', q1); await sleep(1200);
    check(await val('veQuality') === q1, 'quality changed', await val('veQuality'));
    await undo();
    check(await val('veQuality') === q0, 'undo puts the export quality back', { want: q0, got: await val('veQuality') });
    await redo();
    check(await val('veQuality') === q1, 'redo changes it again', await val('veQuality'));

    const f0 = await val('veFill');
    await set('veFill', 'blur'); await sleep(1200);
    await undo();
    check(await val('veFill') === f0, 'undo takes back the frame fill (Blur background)', { want: f0, got: await val('veFill') });

    const rf0 = await val('veAutoReframe');
    await set('veAutoReframe', !rf0); await sleep(1200);
    await undo();
    check(await val('veAutoReframe') === rf0, 'undo takes back follow the speaker', { want: rf0, got: await val('veAutoReframe') });

    const st0 = await val('capStyleSel');
    const st1 = st0 === 'neon' ? 'karaoke' : 'neon';
    await set('capStyleSel', st1); await sleep(1200);
    await undo();
    check(await val('capStyleSel') === st0, 'undo takes back the caption look', { want: st0, got: await val('capStyleSel') });

    console.log('\n=== [C] selecting is not an edit ===');
    for (let i = 0; i < 12 && await canUndo(); i++) await undo();
    check(!(await canUndo()), 'everything undone: nothing left to undo');
    await page.evaluate(() => { const seg = document.querySelector('.ve-seg[data-id]'); if (seg) { seg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); seg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); seg.click(); } });
    await sleep(1500);
    check(!(await canUndo()), 'tapping a clip to select it does not become a step to undo');
    void fx;
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await done();
    console.log(`\n${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
  }
})();
