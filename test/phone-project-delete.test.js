'use strict';
/*
 * DELETE THE PROJECT YOU HAVE OPEN — on a phone.
 *
 * "There should be an option for me to delete the current project." The
 * Projects list could delete every project but the open one. This drives the
 * real Cloud Studio like an iPhone and checks:
 *   [1] Project row → Delete asks first; Cancel keeps everything
 *   [2] OK deletes that project only (another one stays), the studio lets go
 *       of the video, Projects comes up, and the video file is untouched
 *   [3] the project does not come back by itself (no autosave remakes it,
 *       no "carry on" slot left behind)
 *   [4] the card at the top of Projects ("Open in the editor") has
 *       Delete this project too
 *
 * Needs Playwright with Chromium; without it this says so and skips.
 *   node test/phone-project-delete.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7391, CODE = 'projdel-test-4417';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-projdel-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function post(p, body) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(body));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 60; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }
(async () => {
  const VID = path.join(MEDIA, 'sermon.webm');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=15:d=12', '-f', 'lavfi', '-i', 'sine=f=220:d=12', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-shortest', VID]);
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore' });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => check(false, 'the page runs without errors', e.message));
    let answer = false, asked = 0;
    page.on('dialog', (d) => { asked++; answer ? d.accept() : d.dismiss(); });
    await page.goto(`http://127.0.0.1:${PORT}/#studio`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.VideoEditor && window.VideoEditor.openPath && window.MWSocial, null, { timeout: 30000 });
    const list = () => page.evaluate(async () => ((await window.api.sessions.list()) || []).map((r) => r.id));
    // another project, which must survive
    const other = await page.evaluate(async (p) => (await window.api.sessions.save(null, 'Easter service', { video: { path: p } })).id, VID);

    // open a video and change it: it becomes a project
    async function openAndEdit() {
      await page.evaluate((p) => window.VideoEditor.openPath(p), VID);
      await page.waitForFunction(() => document.getElementById('vePlayer').readyState >= 2, null, { timeout: 30000 });
      await sleep(500);
      await page.evaluate(() => { const T = window.VideoEditor.__test; T.addTextAt({ text: 'GRACE', start: 0, end: 5, x: 0.5, y: 0.3, sizePct: 0.1 }); T.selectText(null); });
      await sleep(300);
      return page.evaluate(() => window.VideoEditor.flushProject());
    }
    const id = await openAndEdit();
    check(!!id && (await list()).includes(id), 'the edited video is a project', { id, list: await list() });

    // [1] Project row → Delete, Cancel
    await page.evaluate(() => [...document.querySelectorAll('#cloudDock .cloud-dock-row[data-row="main"] .cloud-tool')].find((b) => /Project/.test(b.textContent)).click());
    const del = page.locator('#cloudDock .cloud-dock-row[data-row="project"] .cloud-tool', { hasText: 'Delete' });
    check(await del.isVisible(), 'Project row shows Delete');
    if (process.env.MW_SHOTS) { await del.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'project-row.png') }); }
    answer = false; await del.tap(); await sleep(400);
    check(asked === 1 && (await list()).includes(id) && await page.evaluate(() => window.VideoEditor.hasVideo()), 'Cancel keeps the project and the video open', { asked });

    // [2] OK
    answer = true; await del.tap();
    await page.waitForFunction(() => !window.VideoEditor.hasVideo(), null, { timeout: 5000 }).catch(() => {});
    await sleep(600);
    const after = await list();
    check(!after.includes(id), 'the project is deleted', after);
    check(after.includes(other), 'the other project stays', after);
    check(!(await page.evaluate(() => window.VideoEditor.hasVideo())), 'the studio lets go of the video');
    check(await page.evaluate(() => window.MWSocial.view()) === 'projects', 'Projects comes up', await page.evaluate(() => window.MWSocial.view()));
    check(fs.existsSync(VID), 'the video file is untouched');

    // [3] nothing remakes it
    await sleep(16500);   // longer than the 15 s autosave sweep
    const later = await list();
    check(later.length === 1 && later[0] === other, 'no autosave makes it again', later);
    check(!(await page.evaluate(() => window.api.sessions.autosaveGet())), 'no "carry on" slot is left behind');

    // [4] the card on Projects
    await page.evaluate(() => window.MWSocial.go('studio'));
    const id2 = await openAndEdit();
    await page.evaluate(() => window.MWSocial.openProjects());
    const card = page.locator('#pvCur [data-pv="delete"]');
    await card.waitFor({ state: 'visible', timeout: 5000 });
    check(await card.isVisible(), 'the open project\'s card has Delete this project');
    if (process.env.MW_SHOTS) await page.screenshot({ path: path.join(process.env.MW_SHOTS, 'project-card.png') });
    await card.tap();
    await page.waitForFunction(() => !window.VideoEditor.hasVideo(), null, { timeout: 5000 }).catch(() => {});
    await sleep(800);
    const end = await list();
    check(!end.includes(id2) && end.includes(other), 'it deletes that project only', end);
    check(await page.evaluate(() => document.getElementById('pvCur').classList.contains('hidden')), 'the card goes away');
  } catch (e) {
    check(false, 'the test ran to the end', e.message);
  } finally {
    await browser.close(); srv.kill();
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
