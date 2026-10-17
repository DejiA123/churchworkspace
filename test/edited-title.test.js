'use strict';
/*
 * A SAVED VIDEO IS CALLED BY ITS TITLE — in a real browser, on the real Cloud
 * Studio.
 *
 * "Can the name of the finished videos be the actual title of the video
 *  instead of 'Media Church Work Space media…'?" A video saved with Export
 * video was named after the recording's file, so every video saved from one
 * sermon had the same name in My Uploads. Now:
 *   [1] nothing else to go by: the recording's name, as before (tidied)
 *   [2] words said in it (captions): its hookiest sentence, as a "Key moment"
 *       short's title is made — not the file's name
 *   [3] cut from an AI short: that short's title — and it is the name the
 *       export is given, so the file (and My Uploads) says it
 *
 *   node test/edited-title.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.log('SKIP: Playwright is not installed here (npm i -g playwright) — saved videos’ names were not tested.');
  process.exit(0);
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7439;
const CODE = 'editedtitle-test-7731';
const WORK = path.join(os.tmpdir(), 'mw-edited-title-' + process.pid);
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
  const VID = path.join(MEDIA, 'Media_Church_Work_Space_media_2026.webm');
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1000);
    const T = (name, ...a) => page.evaluate(({ name, a }) => window.VideoEditor.__test[name](...a), { name, a });

    console.log('\n=== [1] nothing else to go by ===');
    const t1 = await T('editedTitle');
    check(t1 === 'Media Church Work Space media 2026', 'the recording’s own name, tidied', t1);

    console.log('\n=== [2] the words said in it ===');
    const said = 'Once God starts to use you nothing can stop you. Are you ready for what God is about to do in your life? Lift your hands and praise Him.';
    await page.evaluate((said) => {
      const w = said.split(' ').map((text, i) => ({ text, start: 2 + i * 0.4, end: 2 + i * 0.4 + 0.35 }));
      const T = window.VideoEditor.__test; T.setCapWords(w, 0); T.revealCaps();
    }, said);
    await sleep(400);
    const t2 = await T('editedTitle');
    check(!!t2 && t2 !== t1 && !/media/i.test(t2) && said.toLowerCase().includes(t2.toLowerCase().replace(/[…?.!]+$/, '').split(' ').slice(0, 3).join(' ')),
      'a title from what is said in it (its hookiest sentence), not the file’s name', t2);

    console.log('\n=== [3] cut from an AI short ===');
    const sh = await T('addShort', 10, 30);
    await sleep(300);
    // the short's title, as the panel's name box sets it
    await page.evaluate((id) => {
      const inp = document.querySelector(`.ve-clip-name[data-id="${id}"]`);
      inp.value = 'Once God Starts To Use You'; inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, sh.id);
    // the main track cut down to that stretch: split at 0:10 and 0:30, the outer pieces deleted
    await T('splitAt', 10); await T('splitAt', 30);
    const segs = await T('segments');
    for (const s of segs.filter((x) => x.lane === 0 && x.id !== sh.id && (x.end <= 10.01 || x.start >= 29.99))) {
      await page.evaluate((id) => {
        const el = document.querySelector(`#veSegments .ve-seg[data-id="${id}"]`);
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: el.getBoundingClientRect().left + 5, clientY: el.getBoundingClientRect().top + 5 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        document.getElementById('veDelClip').click();
      }, s.id);
      await sleep(200);
    }
    const t3 = await T('editedTitle');
    check(t3 === 'Once God Starts To Use You', 'the edited video is called by the AI short’s title', { t3, segs: await T('segments') });
    // …and that is the name the export is given
    const label = await page.evaluate(async () => {
      const api = window.api.sermon, real = api.exportShort;
      let got = null;
      api.exportShort = async (a) => { got = a.label; throw new Error('stop here'); };
      try { document.getElementById('veExportEdited').click(); } catch (e) {}
      for (let i = 0; i < 60 && got == null; i++) await new Promise((r) => setTimeout(r, 100));
      api.exportShort = real;
      return got;
    });
    check(label === 'Once God Starts To Use You', 'Export video names the file by that title (My Uploads shows it)', label);
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
