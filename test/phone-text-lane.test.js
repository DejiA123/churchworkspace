'use strict';
/*
 * TEXT ON THE TIMELINE, ON A PHONE — and the studio never left squeezed.
 *
 * "Let it be possible for me to click the text on the video timeline, and then
 *  a Delete option in the bottom navigator should be there." And: "What
 *  happened to the screen — why did everything move up like that?"
 *   [1] tapping a text's block on the timeline brings the Text tools to the
 *       bottom bar, Delete first; Delete takes the text away and the bar goes
 *       back to what it was
 *   [2] a title's block too; Edit brings it up on the picture with its panel,
 *       the playhead taken to its nearest showing (not back to the first)
 *   [3] the keyboard put away without iOS saying so (the visual viewport still
 *       reporting it) does not leave the studio squeezed into the top half:
 *       once nothing is being typed, the timeline reaches the bottom bar again
 *
 *   node test/phone-text-lane.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) {
  try { ({ chromium, devices } = require('/opt/node-tools/node_modules/playwright')); } catch (er) {
    console.log('SKIP: Playwright is not installed here (npm i -g playwright) — the text lane was not tested.');
    process.exit(0);
  }
}
const ffmpeg = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const PORT = 7406;
const CODE = 'textlane-test-3318';
const WORK = path.join(os.tmpdir(), 'mw-textlane-' + process.pid);
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
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=30', '-f', 'lavfi', '-i', 'sine=f=220:d=30',
    '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1',
    '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  const done = async () => { try { await browser.close(); } catch (e) {} try { srv.kill(); } catch (e) {} try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {} };
  try {
    if (!(await waitUp())) throw new Error('the cloud server did not start');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    if (!login.token) throw new Error('could not sign in');
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => {
      try { localStorage.setItem('mw.cloud.token', t); } catch (e) {}
      // A visual viewport the test can shrink, the way an iPhone's keyboard does —
      // and leave shrunk, the way iOS sometimes does after the keyboard has gone.
      const real = window.visualViewport;
      const fake = { _kb: 0, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1,
        get width() { return window.innerWidth; }, get height() { return window.innerHeight - this._kb; },
        addEventListener: (...a) => real && real.addEventListener(...a), removeEventListener: (...a) => real && real.removeEventListener(...a) };
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath, null, { timeout: 30000 });
    await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
    await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
    await sleep(1500);
    const dockRow = () => page.evaluate(() => { const r = document.querySelector('#cloudDock .cloud-dock-row.on'); return r ? r.dataset.row : null; });
    const rowLabels = () => page.evaluate(() => Array.from(document.querySelectorAll('#cloudDock .cloud-dock-row.on .cloud-tool span:first-of-type')).map((s) => s.textContent));
    const texts = () => page.evaluate(() => window.VideoEditor.__test.textOverlaysRaw().map((o) => ({ id: o.id, text: o.text, kind: o.kind || 'text' })));
    const tapBlock = async (id) => {
      await page.evaluate((id) => document.querySelector(`#veTextTrack .ve-text-clip[data-id="${id}"]`).scrollIntoView({ inline: 'center', block: 'nearest' }), id);
      await sleep(300);
      await page.locator(`#veTextTrack .ve-text-clip[data-id="${id}"]`).tap();
      await sleep(500);
    };

    console.log('\n=== [1] a text tapped on the timeline: Delete in the bottom bar ===');
    await page.evaluate(() => document.getElementById('veAddText').click());
    await sleep(600);
    await page.evaluate(() => { document.getElementById('vtDone').click(); });
    await sleep(400);
    let list = await texts();
    const plain = list[0];
    check(list.length === 1, 'a text is on the video', list);
    await tapBlock(plain.id);
    const row1 = await dockRow(), labels1 = await rowLabels();
    check(row1 === 'textpick' && labels1[0] === 'Delete', 'tapping its block brings the Text tools, Delete first', { row1, labels1 });
    await page.locator('#cloudDock .cloud-dock-row.on .cloud-tool:not(.cloud-tool-back)').first().tap();
    await sleep(600);
    list = await texts();
    const row2 = await dockRow();
    check(list.length === 0, 'Delete takes the text off the video', list);
    check(row2 !== 'textpick', 'and the bottom bar goes back', row2);

    console.log('\n=== [2] a title too; Edit brings its panel ===');
    await page.evaluate(() => { document.getElementById('vePlayer').currentTime = 2; });
    await sleep(400);
    await page.evaluate(() => window.VideoEditor.textTemplates());
    await sleep(600);
    await page.click('[data-ttl="bar2"]');
    await sleep(800);
    await page.evaluate(() => document.getElementById('vtDone').click());
    await sleep(400);
    list = await texts();
    const title = list.find((x) => x.kind === 'title');
    // a name banner from 0:02, every 12 s for 4 s: on at 2–6, 14–18, 26–30. The
    // playhead between two of them, nearer the second.
    await page.evaluate(() => { document.getElementById('vePlayer').currentTime = 12.5; });
    await sleep(400);
    await tapBlock(title.id);
    check(await dockRow() === 'textpick', 'tapping the title’s block brings the Text tools');
    await page.locator('#cloudDock .cloud-dock-row.on .cloud-tool:not(.cloud-tool-back)').nth(1).tap();   // Edit
    await sleep(800);
    const ed = await page.evaluate(() => ({
      panel: !document.getElementById('veTextTools').classList.contains('hidden'),
      isTitle: document.getElementById('veTextTools').classList.contains('is-title'),
      onPicture: !!document.querySelector('.ve-title-box'),
      t: document.getElementById('vePlayer').currentTime,
    }));
    check(ed.panel && ed.isTitle && ed.onPicture, 'Edit shows it on the picture with its panel', ed);
    check(ed.t >= 14 && ed.t <= 18, 'the playhead taken to its nearest showing (0:14), not back to the first', ed);
    await page.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); document.getElementById('vtDone').click(); });
    await sleep(400);

    console.log('\n=== [3] the keyboard gone without iOS saying so ===');
    const gap = () => page.evaluate(() => {
      const dock = document.getElementById('cloudDock').getBoundingClientRect().top;
      const view = document.getElementById('view-video');
      return { pad: parseFloat(view.style.paddingBottom || '0') || 0, dock: Math.round(dock) };
    });
    const before = await gap();
    // typing in a box (not the text panel) with a 300 px keyboard up: the studio makes room
    await page.evaluate(() => {
      const i = document.createElement('input'); i.id = 'kbProbe'; i.style.cssText = 'position:fixed;top:0;left:0;width:10px;';
      document.body.appendChild(i); i.focus();
      window.visualViewport._kb = 300;
      window.dispatchEvent(new Event('resize'));
    });
    await sleep(500);
    const up = await gap();
    // …the keyboard is put away, but the viewport still says it is there (no event either)
    await page.evaluate(() => { document.getElementById('kbProbe').blur(); });
    await sleep(1200);
    const after = await gap();
    check(up.pad > 100, 'while typing with the keyboard up, the studio makes room above it', up);
    check(after.pad <= before.pad + 1, 'once nothing is typed, the studio is whole again (not squeezed over a black gap)', { before, up, after });
    await page.evaluate(() => { window.visualViewport._kb = 0; });
  } catch (e) {
    check(false, 'ran to the end', e && e.message);
  } finally {
    await done();
  }
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
