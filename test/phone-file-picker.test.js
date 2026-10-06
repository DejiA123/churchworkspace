'use strict';
/*
 * THE FILE CHOOSER COMES UP OVER WHATEVER ASKED FOR IT — on a phone.
 *
 * "When you click Add music from my PC I have to close My music to see Your
 * files." The chooser sat earlier in the page than the studio's windows with
 * the same z-index, so it opened BEHIND them. This drives the real Cloud Studio
 * like an iPhone and checks, by what is actually under the finger:
 *   [1] My music → the chooser is on top, says "music", accepts audio, and a
 *       song sent from the phone lands in My music under its own name
 *   [2] My clips, the cover's own photo, the effects panel, the captions
 *       window → the chooser is on top of each
 *   [3] the timeline's + (nothing open) still works
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-file-picker.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7386, CODE = 'picker-test-5821';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const onTop = (r) => r && !r.filesHidden && r.grid.every((g) => /cloudFilesModal/.test(g));
const WORK = path.join(os.tmpdir(), 'mw-zorder-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const VID = path.join(MEDIA, 'tl.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=10', '-f', 'lavfi', '-i', 'sine=f=220:d=10', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const SONG = path.join(WORK, 'Amazing Grace.mp3');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=8', '-c:a', 'libmp3lame', SONG]);
  const PIC = path.join(WORK, 'flyer.png');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=1', '-frames:v', '1', PIC]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const out = {};
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(800);
    const topAt = () => page.evaluate(() => {
      const fm = document.getElementById('cloudFilesModal'); const box = fm.querySelector('.cap-box');
      const r = box.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + 30);
      const grid = []; for (let y = r.top + 10; y < r.bottom; y += 60) { const e = document.elementFromPoint(r.left + r.width/2, y); const o = e && e.closest('#cloudFilesModal,#libModal,#thumbModal,#fxModal,#capModal,.cloud-dock,.cloud-export-sheet'); grid.push(Math.round(y)+':'+(o ? (o.id||o.className) : (e && (e.id||e.className)))); }
      const owner = el && el.closest('[id]');
      const zs = ['cloudFilesModal', 'libModal', 'thumbModal', 'fxModal'].map((id) => { const n = document.getElementById(id); return n ? id + ':' + getComputedStyle(n).zIndex + (n.classList.contains('hidden') ? '(h)' : '') : id + ':none'; });
      return { grid, filesHidden: fm.classList.contains('hidden'), filesBoxRect: [Math.round(r.top), Math.round(r.height)], topElement: el ? (el.id || el.className) : null, topOwner: owner && owner.id, z: zs,
        uploadLabel: (document.querySelector('#cloudUpload span') || {}).textContent, list: document.getElementById('cloudFilesList').innerText.slice(0, 200) };
    });
    // ---- 1. the music library
    await page.evaluate(() => window.VideoEditor.__test.openLibrary('music'));
    await sleep(300);
    await page.tap('#libAddMusic');
    await sleep(800);
    out.music = await topAt();
    // what does the hidden <input type=file> accept? Catch the chooser.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.evaluate(() => document.getElementById('cloudUpload').click())]);
    out.music.accept = await chooser.element().evaluate((n) => n.accept);
    await chooser.setFiles(SONG);
    await page.waitForFunction(() => { const m = document.getElementById('cloudFilesModal'); return m.classList.contains('hidden'); }, null, { timeout: 30000 }).catch(() => {});
    await sleep(2500);
    out.musicAfter = await page.evaluate(() => ({ libOpen: !document.getElementById('libModal').classList.contains('hidden'),
      list: document.getElementById('libMusicList').innerText.slice(0, 300), musicBtn: document.getElementById('veMusic') && document.getElementById('veMusic').textContent,
      overlayZ: getComputedStyle(document.getElementById('overlay')).zIndex }));
    // Is the uploaded audio visible in Your files?
    await page.evaluate(() => document.getElementById('libClose').click());
    await page.evaluate(() => document.getElementById('cloudFiles').click());
    await sleep(1200);
    out.filesAfterSong = await page.evaluate(() => document.getElementById('cloudFilesList').innerText.slice(0, 300));
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    out.uploadsDir = fs.readdirSync ? null : null;
    // ---- 2. the clips library (ending)
    await page.evaluate(() => window.VideoEditor.__test.openLibrary('clips'));
    await sleep(300);
    await page.tap('#libAddClip'); await sleep(800);
    out.clips = await topAt();
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    await page.evaluate(() => document.getElementById('libClose').click());
    // ---- 3. thumbnail picker, own photo
    await page.evaluate(() => window.VideoEditor.chooseCover && window.VideoEditor.chooseCover());
    await sleep(1200);
    out.thumbOpen = await page.evaluate(() => !document.getElementById('thumbModal').classList.contains('hidden'));
    await page.evaluate(() => document.getElementById('thumbFile').click()); await sleep(800);
    out.thumb = await topAt();
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    await page.evaluate(() => { const c = document.getElementById('thumbClose') || document.querySelector('#thumbModal [id$=Close]'); if (c) c.click(); else document.getElementById('thumbModal').classList.add('hidden'); });
    // ---- 4. effects side panel: music
    await page.evaluate(() => document.getElementById('fxModal').classList.remove('hidden'));
    await page.evaluate(() => document.getElementById('fxMusic').click()); await sleep(800);
    out.fx = await topAt();
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    await page.evaluate(() => document.getElementById('fxModal').classList.add('hidden'));
    // ---- 5. the + at the end of the timeline (no modal open)
    await page.evaluate(() => { setTimeout(() => window.VideoEditor.pickMediaAfter(), 0); }); await sleep(800);
    out.plus = await topAt();
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    // ---- 6. captions window open, then a picker
    await page.evaluate(() => document.getElementById('capModal').classList.remove('hidden'));
    await page.evaluate(() => { setTimeout(() => window.api.dialog.openFile([{ name: 'x', extensions: ['srt'] }]), 0); }); await sleep(800);
    out.caps = await topAt();
    await page.evaluate(() => document.getElementById('cloudFilesClose').click());
    await page.evaluate(() => document.getElementById('capModal').classList.add('hidden'));
    out.uploads = fs.readdirSync(path.join(DATA)).join(',');
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    out.files = walk(DATA).filter((f) => /\.mp3$|library\.json|db\.json/.test(f)).map((f) => f.replace(DATA, ''));
    const lj = walk(DATA).find((f) => /library.*\.json$/.test(f));
    if (lj) out.libJson = fs.readFileSync(lj, 'utf8').slice(0, 600);
    console.log('\n[1] My music');
    check(onTop(out.music), 'tapping Add music brings the chooser up OVER My music', out.music && out.music.grid);
    check(/Send music from this phone/.test(out.music.uploadLabel), 'it says "Send music from this phone"', out.music.uploadLabel);
    check(/audio\/\*/.test(out.music.accept) && /\.mp3/.test(out.music.accept), 'the phone picker is told to offer songs', out.music.accept);
    check(out.musicAfter.libOpen, 'after sending, My music is still open where it was');
    check(/Amazing Grace/.test(out.musicAfter.list) && !/\d{14}/.test(out.musicAfter.list), 'the song is in My music under its own name (no timestamp)', out.musicAfter.list);
    console.log('\n[2] every other window that asks for a file');
    check(onTop(out.clips), 'My clips', out.clips && out.clips.grid);
    check(out.thumbOpen && onTop(out.thumb), 'the cover picker\'s own photo', out.thumb && out.thumb.grid);
    check(onTop(out.fx), 'the effects panel', out.fx && out.fx.grid);
    check(onTop(out.caps), 'the captions window', out.caps && out.caps.grid);
    console.log('\n[3] nothing open');
    check(onTop(out.plus), 'the timeline + still opens the chooser', out.plus && out.plus.grid);
  } catch (e) { check(false, 'the test ran to the end', e.message); }
  finally { await browser.close(); srv.kill(); fs.rmSync(WORK, { recursive: true, force: true }); }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
