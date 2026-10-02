'use strict';
/*
 * ✨ WRITE IT FOR ME + 📦 BULK UPLOAD + 🗓 AUTO-SCHEDULE, in the real UI.
 *
 * Drives the actual Social Scheduler page: presses the write-for-me button and
 * checks the fields really fill with copy about THIS clip, then loads a batch,
 * auto-schedules it, and checks that N posts were created at sensible, spaced,
 * future times — each with its own title and its own file.
 *
 *   npx electron test/social-ai-bulk.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const socialCopy = require(path.join(ROOT, 'src/main/social-copy'));
const schedulePlan = require(path.join(ROOT, 'src/main/schedule-plan'));
const video = require(path.join(ROOT, 'src/main/video'));

const WORK = path.join(os.tmpdir(), 'mw-aibulk');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
// Files named the way this app names its own shorts.
const FILES = [
  'short-Sister_Marela_God_bless_you-captioned-20260818-064218.mp4',
  'short-Somebody_say_Amen-captioned-20260818-071103.mp4',
  'short-Darkness_can_never_overcome_light-captioned-20260818-070701.mp4',
  'flyer-Prayer_Night.png',
].map((n) => { const p = path.join(WORK, n); fs.writeFileSync(p, 'x'); return p; });

let failed = false;
const log = (ok, n, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!ok) failed = true; };

const ok = (d) => ({ ok: true, data: d });
const posts = [];
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'The Power House International' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok(posts.slice()));
// preload wraps the payload as { post } — unwrap it exactly as the real handler does.
ipcMain.handle('scheduler:add', (_e, { post }) => { posts.push({ id: 'p' + posts.length, status: 'scheduled', ...post }); return ok(posts[posts.length - 1]); });
ipcMain.handle('accounts:list', () => ok([{ id: 'fb_1', platform: 'facebook', name: 'Grace Chapel', picture: '' }]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
// No model installed — the rules must carry the whole feature.
ipcMain.handle('social:suggestCopy', async (_e, a) => ok(await socialCopy.suggest({ ...a, churchName: 'The Power House International', llm: null })));
ipcMain.handle('social:planSchedule', (_e, { count, spacingHours }) =>
  ok(schedulePlan.planSchedule({ count, spacingHours }).map((p) => ({ iso: p.iso, label: p.label, dayLabel: p.dayLabel, timeLabel: p.timeLabel }))));
let picked = [];
ipcMain.handle('dialog:openFile', () => ok(picked));

app.disableHardwareAcceleration();
const js = (w, src) => w.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

app.whenReady().then(async () => {
  const errs = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);
  const boot = errs.slice();
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-scheduler').classList.add('active');
    return true;`);

  /* ---------- ✨ write it for me ---------- */
  console.log('\n[1] ✨ Write the title & caption for me');
  log(!!(await js(win, "return !!document.getElementById('sWriteForMe');")), 'the button is on the page');

  const noMedia = await js(win, `
    document.getElementById('sTitle').value = '';
    document.getElementById('sWriteForMe').click();
    await new Promise(r => setTimeout(r, 400));
    return { toast: document.getElementById('toast').textContent, title: document.getElementById('sTitle').value };`);
  log(/attach/i.test(noMedia.toast) && !noMedia.title, 'with nothing attached it asks for the media instead of inventing a post', noMedia.toast);

  picked = FILES[0];
  const wrote = await js(win, `
    document.getElementById('pickPostMedia').click();
    await new Promise(r => setTimeout(r, 400));
    document.getElementById('sWriteForMe').click();
    await new Promise(r => setTimeout(r, 900));
    return { title: document.getElementById('sTitle').value, caption: document.getElementById('sCaption').value };`);
  log(wrote.title.length > 8, 'a title is written', J(wrote.title));
  log(/Sister Marela/i.test(wrote.title + wrote.caption), '…about THIS clip, taken from its name', J(wrote.title));
  log((wrote.caption.match(/#\w+/g) || []).length >= 6, 'the caption comes with hashtags',
    (wrote.caption.match(/#\w+/g) || []).length + ' tags');
  log(/Power House/.test(wrote.caption), 'and the church name');
  log(wrote.caption.length <= 2200, 'the caption is within Instagram\'s limit', wrote.caption.length + ' chars');

  /* ---------- 📦 bulk + 🗓 auto-schedule ---------- */
  console.log('\n[2] 📦 Bulk upload and 🗓 Auto-schedule');
  picked = FILES;
  const bulk = await js(win, `
    document.getElementById('pickPostBatch').click();
    await new Promise(r => setTimeout(r, 700));
    return {
      shown: !document.getElementById('bulkBox').classList.contains('hidden'),
      count: document.getElementById('bulkCount').textContent,
      items: document.querySelectorAll('#bulkList .bulk-item').length,
      titles: document.querySelectorAll('#bulkList .bi-title').length,
      whens: [...document.querySelectorAll('#bulkList .bi-when')].map(e => e.textContent).filter(Boolean),
      note: document.getElementById('bulkPlanNote').textContent,
    };`);
  log(bulk.shown && bulk.items === FILES.length, 'the batch is listed', bulk.count);
  log(bulk.whens.length === FILES.length, 'every file is shown WITH the time it would go out', bulk.whens.join(' · '));
  log(/apart/.test(bulk.note), 'the plan is described before anything is scheduled', bulk.note);

  const spaced = await js(win, `
    const sel = document.getElementById('bulkSpacing');
    sel.value = '3'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 500));
    return [...document.querySelectorAll('#bulkList .bi-when')].map(e => e.textContent);`);
  log(spaced.join('|') !== bulk.whens.join('|'), 'changing the spacing re-plans the times', spaced.join(' · '));

  const before = posts.length;
  const done = await js(win, `
    window.confirm = () => true;
    document.getElementById('bulkSchedule').click();
    await new Promise(r => setTimeout(r, 2500));
    return { toast: document.getElementById('toast').textContent,
             cleared: document.getElementById('bulkBox').classList.contains('hidden') };`);
  const made = posts.slice(before);
  log(made.length === FILES.length, 'one post per file was scheduled', made.length + ' of ' + FILES.length);
  log(made.every((p) => p.mediaPaths && p.mediaPaths.length === 1), 'each post carries its own file');
  log(new Set(made.map((p) => p.mediaPaths[0])).size === FILES.length, 'no file was posted twice');
  log(made.every((p) => p.title && p.title.length > 3), 'each post got its own written title',
    made.map((p) => p.title.slice(0, 22)).join(' | '));
  log(new Set(made.map((p) => p.title)).size > 1, '…and they are not all the same title');
  const times = made.map((p) => new Date(p.scheduledAt)).sort((a, b) => a - b);
  log(times.every((t) => t > new Date()), 'nothing is scheduled in the past');
  log(times.every((t) => t.getHours() >= 7 && t.getHours() <= 21), 'nothing is scheduled in the middle of the night',
    times.map((t) => t.getHours() + ':00').join(', '));
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 3600000);
  log(gaps.every((g) => g >= 3 - 0.01), 'the posts keep to the 3-hour spacing', gaps.map((g) => g.toFixed(1) + 'h').join(', '));
  log(made.every((p) => (p.accountIds || []).length || (p.platforms || []).length), 'they all target the ticked account');
  log(done.cleared, 'the batch box clears once they are scheduled');
  log(/Scheduled/i.test(done.toast), 'and it says what happened', done.toast);

  const newErrs = errs.filter((m) => !boot.includes(m) && !/Autofill|DevTools|source-map|No handler registered/i.test(m));
  log(newErrs.length === 0, 'no new console errors', newErrs.slice(0, 2).join(' | '));

  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
