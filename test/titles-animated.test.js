'use strict';
/*
 * ANIMATED TITLES (CapCut's "Trending" templates) — in a real browser, on the
 * real Cloud Studio, the way an iPhone uses it, through to the exported file.
 *
 * "The speaker name could be Bishop David Richman: I select one of the
 *  trending templates, and his name slides in from time to time — every 12
 *  seconds it appears for about 4. The user can select how long it stays. It
 *  must be animated, slide in."
 *   [1] Templates opens on Trending: fourteen animated looks, each card moving
 *   [2] "Name & title" goes on at the playhead: repeating every 12 s for 4 s,
 *       to the end of the video; the panel shows its words and its timing
 *   [3] the name typed in the panel is on the picture, and remembered
 *   [4] on the picture it slides in (part of it out from behind the bar),
 *       stays, slides away, and comes back 12 s later
 *   [5] "every" and "on screen" change when it comes back and how long it stays
 *   [6] the next name banner starts with the name typed last time
 *   [7] the exported file has it: arriving, up, leaving, and gone between —
 *       at the times the preview showed — and the video is as long as before
 *
 * Needs Playwright with Chromium (not one of the app's dependencies); without
 * it this says so and skips.
 *
 *   node test/titles-animated.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  try { ({ chromium, devices } = require('/opt/node-tools/node_modules/playwright')); } catch (er) {
    console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the animated titles were not tested.');
    process.exit(0);
  }
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7404;
const CODE = 'titles-test-7712';
const WORK = path.join(os.tmpdir(), 'mw-titles-' + process.pid);
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
/** One frame's pixels inside a rectangle, as RGB bytes. */
function framePixels(file, t, box) {
  return execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=${box.w}:${box.h}:${box.x}:${box.y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 });
}
/** How much of the rectangle differs between two files at time t (0..1 of its pixels). */
function differs(a, b, t, box) {
  const pa = framePixels(a, t, box), pb = framePixels(b, t, box);
  let n = 0;
  for (let i = 0; i + 2 < Math.min(pa.length, pb.length); i += 3) {
    if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 90) n++;
  }
  return n / (pa.length / 3);
}

(async () => {
  // a 30 s 9:16 picture the browser can play (Chromium here has no H.264), with sound
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=540x960:r=30:d=30', '-f', 'lavfi', '-i', 'sine=f=220:d=30',
    '-c:v', 'libvpx-vp9', '-b:v', '800k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1000);
    const T = (fn, ...a) => page.evaluate(([fn, a]) => window.VideoEditor.__test[fn](...a), [fn, a]);
    const seek = (t) => page.evaluate(async (t) => {
      const p = document.getElementById('vePlayer'); p.pause();
      if (Math.abs(p.currentTime - t) > 0.001) { p.currentTime = t; await new Promise((r) => p.addEventListener('seeked', r, { once: true })); }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }, t);
    const putDown = () => page.evaluate(() => {
      const d = document.getElementById('vtDone'); if (d) d.click();
      document.getElementById('vePlayer').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    // what is on the picture: is the title there, and how far out are its lines
    const onPicture = () => page.evaluate(() => {
      const box = document.querySelector('.ve-title-box');
      if (!box) return { shown: false };
      const lines = Array.from(box.querySelectorAll('.ve-title div[style*="translateX"]')).map((d) => {
        const m = /translateX\((-?[\d.]+)%\)/.exec(d.getAttribute('style')); return m ? +m[1] : null;
      });
      return { shown: true, text: box.textContent.replace(/\s+/g, ' ').trim(), lines };
    });

    console.log('\n=== [1] Templates opens on Trending ===');
    await page.evaluate(() => window.VideoEditor.textTemplates());
    await sleep(700);
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('#veTextTplModal [data-ttl]')).map((c) => c.dataset.ttl));
    check(cards.length === 14 && cards[0] === 'bar2', 'fourteen Trending titles, "Name & title" first', cards);
    const a1 = await page.evaluate(() => document.querySelector('[data-ttl-demo="bar2"]').innerHTML);
    await sleep(450);
    const a2 = await page.evaluate(() => document.querySelector('[data-ttl-demo="bar2"]').innerHTML);
    check(a1 !== a2, 'the cards move (each performs its slide-in)');

    console.log('\n=== [2] "Name & title" at the playhead, repeating ===');
    await page.click('[data-ttl="bar2"]');
    await sleep(900);
    let ovs = await T('textOverlaysRaw');
    let o = ovs.find((x) => x.kind === 'title');
    check(!!o && o.ttl === 'bar2' && o.start === 0 && Math.abs(o.end - 30) < 0.2 && o.repeat.on && o.repeat.every === 12 && o.repeat.hold === 4,
      'it goes on at the playhead, comes back every 12 s for 4 s, to the end of the video', o);
    const panel = await page.evaluate(() => ({
      title: document.getElementById('veTextTools').classList.contains('is-title'),
      t1: document.getElementById('vtT1').value, every: document.getElementById('vtEvery').value, hold: document.getElementById('vtHold').value,
      rep: document.getElementById('vtRepeat').checked, fontShown: getComputedStyle(document.getElementById('vtFont')).display !== 'none',
    }));
    check(panel.title && panel.t1 === 'SIMPLE TITLE' && panel.rep && panel.every === '12' && panel.hold === '4' && !panel.fontShown,
      'the panel shows its words, Repeat on, every 12 s, on screen 4 s (not the plain-text controls)', panel);

    console.log('\n=== [3] the name, typed ===');
    await page.fill('#vtT1', 'Bishop David Richman');
    await page.dispatchEvent('#vtT1', 'change');
    await page.fill('#vtT2', 'Senior Pastor');
    await page.dispatchEvent('#vtT2', 'change');
    await sleep(300);
    const typed = await onPicture();
    check(typed.shown && /Bishop David Richman/i.test(typed.text) && /Senior Pastor/i.test(typed.text), 'the name is on the picture as it is typed', typed);
    const remembered = await page.evaluate(() => localStorage.getItem('mw-title-last'));
    check(/Bishop David Richman/.test(remembered || ''), 'and remembered for next time', remembered);

    console.log('\n=== [4] it slides in, stays, slides away — and comes back ===');
    await putDown();
    await sleep(300);
    await seek(0.2);
    let p = await onPicture();
    check(p.shown && p.lines.length === 2 && p.lines[0] < -5 && p.lines[0] > -100, 'at 0.2 s it is sliding out from behind the bar', p);
    await seek(1.0);
    p = await onPicture();
    check(p.shown && p.lines.every((x) => x === 0), 'at 1 s it is fully in', p);
    await seek(3.85);
    p = await onPicture();
    check(p.shown && p.lines.some((x) => x < -5), 'at 3.85 s it is sliding back in', p);
    await seek(6);
    p = await onPicture();
    check(!p.shown, 'at 6 s it is gone', p);
    await seek(12.3);
    p = await onPicture();
    check(p.shown && p.lines[0] < 0, 'at 12.3 s it is coming in again', p);
    await seek(16.5);
    p = await onPicture();
    check(!p.shown, 'at 16.5 s it is gone again', p);

    console.log('\n=== [5] every 6 s, on screen 3 s ===');
    const box = await page.evaluate(() => { const b = document.querySelector('.ve-title-box'); return !!b; });
    await seek(13);
    await page.evaluate(() => { const b = document.querySelector('.ve-title-box .ve-title'); if (b) b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 })); document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); });
    await sleep(300);
    await page.fill('#vtEvery', '6'); await page.dispatchEvent('#vtEvery', 'change');
    await page.fill('#vtHold', '3'); await page.dispatchEvent('#vtHold', 'change');
    await sleep(200);
    ovs = await T('textOverlaysRaw');
    o = ovs.find((x) => x.kind === 'title');
    check(o && o.repeat.every === 6 && o.repeat.hold === 3, 'the panel sets every 6 s and on screen 3 s', o && o.repeat);
    await putDown();
    await seek(7);
    const at7 = (await onPicture()).shown;
    await seek(9.6);
    const at96 = (await onPicture()).shown;
    await seek(19);
    const at19 = (await onPicture()).shown;
    check(at7 && !at96 && at19, 'it now comes back at 6, 12, 18 s… and stays 3 s each time', { at7, at96, at19, box });

    console.log('\n=== [6] the next name banner starts with that name ===');
    await seek(25);
    await page.evaluate(() => window.VideoEditor.textTemplates());
    await sleep(500);
    await page.click('[data-ttl="bar1"]');
    await sleep(800);
    ovs = await T('textOverlaysRaw');
    const second = ovs.filter((x) => x.kind === 'title').find((x) => x.ttl === 'bar1');
    check(second && second.text === 'Bishop David Richman', '“Username” comes with the name already in', second && second.text);
    await page.click('#vtDelete');
    await sleep(300);
    ovs = await T('textOverlaysRaw');
    check(ovs.filter((x) => x.kind === 'title').length === 1, 'and deleting it leaves the first one');

    console.log('\n=== [7] the exported file ===');
    const info = await T('textPngsForShort', 0, 30, 540, 960);
    const strip = info && info[0] && info[0].strip;
    check(!!strip && strip.frames >= 25 && strip.frames <= 40 && strip.fps === 30, 'the title is drawn once: a strip of its arrival and leaving frames', strip && { frames: strip.frames, fps: strip.fps });
    const out = await T('burnTextNow', 0, 30, 540, 960);
    check(typeof out === 'string' && fs.existsSync(out), 'the burn makes a file', out);
    if (out && fs.existsSync(out)) {
      const ffprobe = require('ffprobe-static').path;
      const durOf = (f) => parseFloat(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
      check(Math.abs(durOf(out) - durOf(VID)) < 0.15, 'the video is as long as before', { out: durOf(out), src: durOf(VID) });
      const b = strip.band;
      const band = { x: b.x, y: b.y, w: b.w, h: b.h };
      const at = (t) => Math.round(differs(out, VID, t, band) * 1000) / 1000;
      const d = { up: at(7.5), arriving: at(6.12), gone: at(10.5), leaving: at(8.75), up2: at(13.5), gone2: at(16.5) };
      // (the encode itself makes a little difference everywhere: "gone" is under 2 %)
      check(d.up > 0.12 && d.up2 > 0.12, 'in the file it is up at 7.5 s and at 13.5 s (its appearances every 6 s)', d);
      check(d.gone < 0.02 && d.gone2 < 0.02, 'and gone at 10.5 s and 16.5 s, between them', d);
      check(d.arriving > 0.01 && d.arriving < d.up && d.leaving > 0.01 && d.leaving < d.up, 'arriving and leaving, it is part of the way out', d);
      // MW_SHOTS=dir: the file's frames through one appearance, to look at
      if (process.env.MW_SHOTS) {
        for (const t of [6.05, 6.15, 6.3, 6.5, 7.5, 8.7, 8.85, 8.95, 10.5]) {
          execFileSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(t), '-i', out, '-frames:v', '1',
            '-vf', `crop=${band.w}:${band.h}:${band.x}:${band.y}`, path.join(process.env.MW_SHOTS, `export-${t}.png`)]);
        }
      }
    }
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
