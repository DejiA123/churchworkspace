'use strict';
/*
 * 🎵 MY MUSIC, ON A PHONE — the new look, and every control still doing its job.
 *
 * "Make the My music UI look better — it looks disgusting right now. Ensure
 * the functionalities are not damaged." The sheet is now a Thumbnail-style
 * sheet: a title with what is in it, the shelves as one segmented control, two
 * add buttons, the songs as cards each with a cover of its own colour (tap the
 * cover to listen), and what plays under the video in one panel. Here, with a
 * real finger on an iPhone-sized screen:
 *   [1] it fits: Done in sight at the top, nothing wider than the screen, and
 *       several songs in view with a song in use
 *   [2] the cover plays the song and shows ⏸; tapped again, it stops
 *   [3] Use makes a song the one in use (In use, its card picked, the panel
 *       naming it)
 *   [4] Volume, Fade in, Fade out and the start-at-the-top switch change the
 *       song in use
 *   [5] Remove takes the music off the video; the bin takes a song out of the
 *       library
 *   [6] the Free music and My clips shelves open, and back (there is no YouTube shelf)
 *   [7] Add from phone and Sound from a video open the phone's file picker;
 *       Done closes the sheet
 *
 *   node test/phone-music-sheet.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the My music sheet was not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7435;
const CODE = 'musicsheet-test-2210';
const WORK = path.join(os.tmpdir(), 'mw-music-sheet-' + process.pid);
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
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=20', '-f', 'lavfi', '-i', 'sine=f=220:d=20',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const SONGS = [['ScreenRecording_05-21-2026 12-48-01_1', 40], ['Wholesome Kevin MacLeod', 30], ['Cheery Monday Kevin MacLeod', 25], ['Sneaky Snitch Kevin MacLeod', 35]]
    .map(([n, d], i) => {
      const f = path.join(MEDIA, n + '.mp3');
      execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=${300 + i * 70}:r=22050:d=${d}`, '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k', f]);
      return f;
    });
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    // an iPhone 13 as a home-screen app: the whole 844-point screen
    const ctx = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    for (const f of SONGS) await page.evaluate((p) => window.api.library.add('music', p), f);
    // opened the way a person does: the dock's Music
    await page.evaluate(() => document.getElementById('veMusic').click());
    await page.waitForSelector('#libMusicList [data-musicuse]', { timeout: 15000 });
    await sleep(500);
    const T = (fn, arg) => page.evaluate(fn, arg);
    const ids = await T(() => Array.from(document.querySelectorAll('#libMusicList [data-musicuse]')).map((b) => b.dataset.musicuse));
    const music = () => T(() => window.VideoEditor.__test.musicState());

    console.log('\n=== [3] Use ===');
    await page.tap(`[data-musicuse="${ids[1]}"]`);
    await sleep(500);
    const used = await T((id) => {
      const row = document.querySelector(`#libMusicList .lib-row[data-musicid="${id}"]`);
      return { sel: row.classList.contains('sel'), btn: row.querySelector('[data-musicuse]').innerText.trim(), bar: !document.getElementById('libMusicBar').classList.contains('hidden'),
        name: document.getElementById('libChosenName').textContent, rowName: row.querySelector('.lib-row-main b').textContent };
    }, ids[1]);
    const m1 = await music();
    check(m1 && m1.id === ids[1], 'Use makes that song the music under the video', m1 && m1.id);
    check(used.sel && /In use/.test(used.btn) && used.bar && used.name === used.rowName, 'its card says In use, and the panel names it', used);

    console.log('\n=== [1] it fits the phone ===');
    const fit = await T(() => {
      const box = document.querySelector('#libModal .lib-box').getBoundingClientRect();
      const doneR = document.getElementById('libDone').getBoundingClientRect();
      const list = document.querySelector('[data-libpane="music"]').getBoundingClientRect();
      const wide = Array.from(document.querySelectorAll('#libModal button, #libModal input, #libModal .lib-row')).filter((el) => {
        const r = el.getBoundingClientRect(); return r.width && (r.left < box.left - 1 || r.right > box.right + 1);
      }).map((el) => el.id || el.className);
      const rows = Array.from(document.querySelectorAll('#libMusicList .lib-row')).filter((r) => { const b = r.getBoundingClientRect(); return b.top >= list.top - 1 && b.bottom <= list.bottom + 1; }).length;
      return { done: doneR.top >= box.top && doneR.bottom <= window.innerHeight && doneR.width > 40, wide, rows, boxTop: Math.round(box.top) };
    });
    check(fit.done, 'Done is in sight, at the top of the sheet', fit);
    check(fit.wide.length === 0, 'nothing is wider than the screen', fit.wide);
    check(fit.rows >= 3, 'with a song in use, at least three songs are in view at once (one was before)', fit);

    console.log('\n=== [2] the cover plays the song ===');
    await page.tap(`.lib-art[data-musicplay="${ids[2]}"]`);
    await sleep(700);
    const playing = await T((id) => {
      const a = document.getElementById('veMusicAudio'), b = document.querySelector(`[data-musicplay="${id}"]`);
      return { paused: a.paused, t: a.currentTime, cls: b.classList.contains('playing'), icon: !!b.querySelector('i svg rect') };
    }, ids[2]);
    check(!playing.paused && playing.cls && playing.icon, 'tapping a cover plays that song, its cover showing ⏸', playing);
    await page.tap(`.lib-art[data-musicplay="${ids[2]}"]`);
    await sleep(300);
    const stopped = await T((id) => ({ paused: document.getElementById('veMusicAudio').paused, cls: document.querySelector(`[data-musicplay="${id}"]`).classList.contains('playing') }), ids[2]);
    check(stopped.paused && !stopped.cls, 'tapped again, it stops and shows ▶', stopped);

    console.log('\n=== [4] the panel’s controls ===');
    await T(() => { const v = document.getElementById('libMusicVol'); v.value = '0.6'; v.dispatchEvent(new Event('input', { bubbles: true })); });
    await sleep(200);
    const vol = await T(() => ({ v: window.VideoEditor.__test.musicState().volume, label: document.getElementById('libMusicVolV').textContent }));
    check(Math.abs(vol.v - 0.6) < 0.001 && vol.label === '60%', 'Volume changes the song’s level and says so', vol);
    await page.fill('#libMusicFadeIn', '2.5'); await T(() => document.getElementById('libMusicFadeIn').dispatchEvent(new Event('change', { bubbles: true })));
    await page.fill('#libMusicFadeOut', '3'); await T(() => document.getElementById('libMusicFadeOut').dispatchEvent(new Event('change', { bubbles: true })));
    await sleep(200);
    let m2 = await music();
    check(m2.fadeIn === 2.5 && m2.fadeOut === 3, 'Fade in and Fade out are kept', { fadeIn: m2.fadeIn, fadeOut: m2.fadeOut });
    const bed0 = m2.bed;
    await page.tap('#libMusicBed');
    await sleep(200);
    m2 = await music();
    const sw = await T(() => { const i = document.getElementById('libMusicBed'), r = i.getBoundingClientRect(); return { checked: i.checked, w: Math.round(r.width), h: Math.round(r.height) }; });
    check(m2.bed === !bed0 && sw.checked === m2.bed && sw.w >= 44 && sw.h >= 26, 'the start-at-the-top switch flips (a switch a finger can hit)', { bed0, bed: m2.bed, sw });

    console.log('\n=== [5] Remove, and the bin ===');
    await page.tap('#libMusicRemove');
    await sleep(400);
    const gone = await T(() => ({ m: window.VideoEditor.__test.musicState(), bar: document.getElementById('libMusicBar').classList.contains('hidden'),
      inUse: document.querySelectorAll('#libMusicList .lib-row.sel').length }));
    check(!gone.m && gone.bar && gone.inUse === 0, 'Remove takes the music off the video (and the panel goes)', gone);
    const before = ids.length;
    await page.tap(`#libMusicList [data-musicdel="${ids[3]}"]`);
    await page.waitForFunction((n) => document.querySelectorAll('#libMusicList .lib-row').length === n - 1, before, { timeout: 8000 }).catch(() => {});
    const left = await T(() => ({ n: document.querySelectorAll('#libMusicList .lib-row').length, sub: document.getElementById('libSub').textContent }));
    check(left.n === before - 1 && /^3 songs/.test(left.sub), 'the bin takes the song out of My music (and the count under the title follows)', left);

    console.log('\n=== [6] the shelves ===');
    const shelf = async (t) => { await page.tap(`#libModal .lib-tab[data-libtab="${t}"]`); await sleep(300);
      return T((t) => ({ pane: !document.querySelector(`.lib-pane[data-libpane="${t}"]`).classList.contains('hidden'), active: document.querySelector('.lib-tab.active').dataset.libtab, title: document.getElementById('libTitle').textContent }), t); };
    const tabs = await T(() => [...document.querySelectorAll('#libModal .lib-tab')].map((b) => b.dataset.libtab));
    check(tabs.join() === 'music,free,clips', 'the shelves are My music, Free music and My clips — no YouTube', tabs);
    const fr = await shelf('free'), cl = await shelf('clips'), mu = await shelf('music');
    check(fr.pane && fr.active === 'free' && cl.pane && cl.active === 'clips' && cl.title === 'Clips' && mu.pane && mu.title === 'Music', 'Free music, My clips and back to My music', { fr, cl, mu });

    console.log('\n=== [7] adding, and Done ===');
    for (const [sel, what] of [['#libAddMusic', 'Add from phone'], ['#libAddMusicVideo', 'Sound from a video']]) {
      await page.tap(sel);
      await sleep(700);
      const open = await T(() => { const m = document.getElementById('cloudFilesModal'); return !!m && !m.classList.contains('hidden'); });
      check(open, `${what} opens the phone’s files to pick from`, open);
      await T(() => { const x = document.querySelector('#cloudFilesModal [data-close], #cloudFilesModal .cloud-files-close, #cloudFilesClose'); if (x) x.click(); });
      await sleep(400);
      await T(() => { const m = document.getElementById('cloudFilesModal'); if (m && !m.classList.contains('hidden')) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
      await sleep(300);
    }
    const label = await T(() => document.querySelector('#libAddMusic b').textContent);
    check(label === 'Add from phone', 'the button says it is this phone', label);
    await page.tap('#libDone');
    await sleep(400);
    const closed = await T(() => document.getElementById('libModal').classList.contains('hidden'));
    check(closed, 'Done closes the sheet', closed);
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
