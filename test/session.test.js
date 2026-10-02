'use strict';
/*
 * SAVED EDITING SESSIONS — "pick up where I left off" — through the REAL app.
 *
 * The promise this makes is total: close the studio in the middle of a job and
 * come back to it exactly as it was. So this test does not check that a file
 * got written; it builds a real piece of work (clips, a cut, captions with a
 * correction typed into them, text over the picture, a chosen speaker, changed
 * export settings), throws the whole studio away by loading a different video,
 * and then demands every one of those things back.
 *
 * Also checked: that it saves itself with nobody pressing anything, that the
 * rolling autosave never overwrites a named session, and that a session whose
 * recording has been moved says so rather than opening broken.
 *
 *   npx electron test/session.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const sessions = require(path.join(ROOT, 'src/main/sessions'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-session-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const SRC_A = path.join(WORK, 'service-a.mp4');
const SRC_B = path.join(WORK, 'service-b.mp4');
const GONE = path.join(WORK, 'deleted-later.mp4');

let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : '')); if (!okv) failed = true; };

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Test Church', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: path.join(ROOT, 'bin/fonts') }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:models', () => ok(require(path.join(ROOT, 'src/main/captioner')).models()));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
let THUMBS_ON = false; // [5b] needs real ones; the rest of the suite does not
ipcMain.handle('video:thumbnail', async (_e, { input, timeSec }) => {
  if (!THUMBS_ON) return { ok: false, error: 'thumbs not needed' };
  const output = path.join(WORK, `thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  await video.thumbnail(ctx, { input, timeSec, output });
  return ok(output);
});
ipcMain.handle('video:info', async (_e, { input }) => ok(await video.getInfo(ctx, input)));
ipcMain.handle('video:waveform', async (_e, { input, width, height }) => {
  const output = path.join(WORK, `wave-${Date.now()}.png`);
  await video.waveform(ctx, { input, width: width || 1600, height: height || 90, output });
  return ok(output);
});
// [5b] makes the filmstrip as slow as it is on a three-hour sermon, to prove
// "Carry on" no longer waits for it
let STRIP_DELAY_MS = 0;
ipcMain.handle('video:filmstrip', async (_e, { input, count }) => {
  if (STRIP_DELAY_MS) await new Promise((r) => setTimeout(r, STRIP_DELAY_MS));
  const output = path.join(WORK, `strip-${Date.now()}.png`);
  await video.filmstrip(ctx, { input, count: count || 16, output });
  return ok(output);
});
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const buf = fs.readFileSync(p);
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`);
});
// the real session store, pointed at this test's own folder
sessions.init(WORK);
ipcMain.handle('session:list', () => ok(sessions.list()));
ipcMain.handle('session:save', (_e, { id, name, data }) => ok(sessions.save({ id, name, data })));
ipcMain.handle('session:load', (_e, { id }) => ok(sessions.load(id)));
ipcMain.handle('session:remove', (_e, { id }) => ok(sessions.remove(id)));
ipcMain.handle('session:rename', (_e, { id, name }) => ok(sessions.rename(id, name)));
ipcMain.handle('session:autosave', (_e, { data }) => ok(sessions.autosave(data)));
ipcMain.handle('session:autosaveGet', () => ok(sessions.readAutosave()));
ipcMain.handle('session:autosaveClear', () => ok(sessions.clearAutosave()));

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CAPS = [
  { start: 1.0, end: 3.0, text: 'Peace be still' },
  { start: 3.5, end: 6.0, text: 'Why are you fearful' },
];
const SIG = { head: new Array(22).fill(0).map((_, i) => (i === 5 ? 1 : 0)), up: new Array(22).fill(0).map((_, i) => (i === 5 ? 1 : 0)), lo: new Array(22).fill(0).map((_, i) => (i === 5 ? 1 : 0)) };

function mkVideo(dest, hue) {
  if (fs.existsSync(dest)) return;
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-t', '20', '-i', `testsrc2=s=1280x720:r=30`,
    '-f', 'lavfi', '-t', '20', '-i', `sine=frequency=${hue}:sample_rate=44100`,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', dest], { stdio: 'ignore' });
}

app.whenReady().then(async () => {
  mkVideo(SRC_A, 440); mkVideo(SRC_B, 660); mkVideo(GONE, 880);

  const errors = [];
  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);

  /* ---- [1] build a real piece of work ------------------------------------ */
  console.log('\n[1] A real edit: clips, a cut, captions, text, a chosen speaker');
  const built = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-video').classList.add('active');
    window.VideoEditor.onShow();
    const T = window.VideoEditor.__test;
    await T.loadReal(${JSON.stringify(SRC_A)});
    T.addShort(2, 8);
    T.addShort(11, 17);
    const ids = T.segIds();
    T.setCaps(${JSON.stringify(CAPS)});
    T.pickPerson(${JSON.stringify(SIG)}, null);
    T.setAspect('reel-9x16');
    T.setFill('blur');
    T.setDenoise(true, 'strong');
    return { ids, segs: T.segCount(), caps: T.capCount(), clips: T.shortsCards() };`);
  if (built.__error) console.error('[1] ' + built.__error);
  log(built.segs >= 3, 'the timeline has the base clip plus two shorts', built.segs + ' clips');
  log(built.caps === 2, 'and two caption lines', built.caps + '');

  const named = await js(win, `
    const T = window.VideoEditor.__test;
    T.renameShort(${JSON.stringify(built.ids[1])}, 'The one about mercy');
    return T.shortLabel(${JSON.stringify(built.ids[1])});`);
  log(named === 'The one about mercy', 'a short renamed by hand', String(named));

  /* ---- [2] it saves itself ----------------------------------------------- */
  console.log('\n[2] It saves itself, with nobody pressing anything');
  await js(win, 'window.VideoEditor.__test.flushSession();');
  await sleep(200);
  const auto = sessions.readAutosave();
  log(!!auto, 'the studio wrote the work down on its own');
  log(auto && auto.video && auto.video.path === SRC_A, 'it knows which recording it was working on', auto && auto.video ? path.basename(auto.video.path) : '');
  log(auto && auto.timeline && auto.timeline.segments.length === built.segs, 'with every clip', auto ? auto.timeline.segments.length + '' : '');
  log(auto && auto.captions && auto.captions.events && auto.captions.events.length === 2, 'and the captions');

  /* ---- [3] save it under a name ------------------------------------------ */
  console.log('\n[3] Saved under a name');
  const saved = await js(win, 'return await window.VideoEditor.__test.saveSessionAs("Sunday morning");');
  if (saved.__error) console.error('[3] ' + saved.__error);
  log(saved && saved.id, 'the session is saved', saved && saved.name);
  const listed = sessions.list();
  log(listed.length === 1 && listed[0].name === 'Sunday morning', 'and it shows up in the list', JSON.stringify(listed.map((r) => r.name)));
  log(listed[0].shorts === 2 && listed[0].captions === 2,
    'the card says what is inside it', listed[0].shorts + ' shorts, ' + listed[0].captions + ' caption lines');
  const chip = await js(win, 'return window.VideoEditor.__test.sessionChip();');
  log(chip.name === 'Sunday morning' && chip.dirty === false, 'and the studio shows its name, with no unsaved marker', JSON.stringify(chip));

  /* ---- [4] throw it all away --------------------------------------------- */
  console.log('\n[4] Throw the studio away — a different video, a fresh start');
  const wiped = await js(win, `
    const T = window.VideoEditor.__test;
    await T.loadReal(${JSON.stringify(SRC_B)});
    return { segs: T.segCount(), caps: T.capCount(), shorts: T.shortsCards(), chip: T.sessionChip(), follow: T.followState().locked };`);
  log(wiped.caps === 0 && wiped.shorts === 0, 'nothing of the old edit survives in the studio',
    wiped.caps + ' caption lines, ' + wiped.shorts + ' shorts');
  log(wiped.chip.name === 'Unsaved session', 'and it is no longer that session', wiped.chip.name);

  /* ---- [5] demand it all back -------------------------------------------- */
  console.log('\n[5] Open the session again — everything comes back');
  const back = await js(win, `
    const T = window.VideoEditor.__test;
    const okd = await T.openSession(${JSON.stringify(saved.id)});
    return {
      okd, video: T.videoPath(), segs: T.segCount(), shorts: T.shortsCards(),
      caps: T.capLines(), labels: T.shortLabels(),
      aspect: T.aspect(), fill: T.fillState().mode, denoise: T.denoiseState(),
      follow: T.followState().locked, chip: T.sessionChip(),
    };`);
  if (back.__error) console.error('[5] ' + back.__error);
  log(back.okd === true, 'the session opened');
  log(back.video === SRC_A, 'the right recording is loaded again', path.basename(String(back.video)));
  log(back.segs === built.segs, 'every clip is back', back.segs + ' of ' + built.segs);
  log(back.shorts === 2, 'both shorts are back in the panel', back.shorts + '');
  log(back.labels.indexOf('The one about mercy') >= 0, 'including the name typed onto one of them', JSON.stringify(back.labels));
  log(back.caps.length === 2 && back.caps[0].text === CAPS[0].text,
    'the captions are back, word for word', JSON.stringify(back.caps.map((c) => c.text)));
  log(Math.abs(back.caps[0].start - CAPS[0].start) < 1e-6, 'and on their original timings');
  log(back.aspect === 'reel-9x16', 'the short format is back', back.aspect);
  log(back.fill === 'blur', 'the frame fill is back', back.fill);
  log(back.denoise && back.denoise.on === true, 'the noise setting is back', JSON.stringify(back.denoise));
  log(back.follow === true, 'and it still knows who to follow');
  log(back.chip.name === 'Sunday morning' && back.chip.dirty === false, 'the chip says which session is open', JSON.stringify(back.chip));

  /* ---- [5b] "Carry on" does not wait for the timeline's pictures ----------- */
  // On a three-hour, 2 GB sermon the filmstrip is 24 seeks into the file, and
  // the restore used to wait for all of them before putting a single clip or
  // caption back. Make it that slow here and time the restore.
  console.log('\n[5b] Carry on puts the work back without waiting for the filmstrip');
  const planted = await js(win, 'return window.VideoEditor.__test.plantOldThumbs();');
  const oldSess = await js(win, 'return await window.VideoEditor.__test.saveSessionAs("Before 2.80");');
  const oldBytes = fs.statSync(path.join(WORK, 'sessions', oldSess.id + '.json')).size;
  await js(win, `await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC_B)}); return 1;`);
  STRIP_DELAY_MS = 6000; THUMBS_ON = true;
  const fast = await js(win, `
    const T = window.VideoEditor.__test;
    const t0 = performance.now();
    const okd = await T.openSession(${JSON.stringify(oldSess.id)});
    return { okd, ms: Math.round(performance.now() - t0), segs: T.segCount(), caps: T.capLines().length, shorts: T.shortsCards() };`);
  STRIP_DELAY_MS = 0;
  log(fast.okd === true && fast.ms < 2500, 'with a 6-second filmstrip the session is back in ' + fast.ms + ' ms', JSON.stringify(fast));
  log(fast.segs === built.segs && fast.caps === 2 && fast.shorts >= 2, '…clips, captions and shorts all there', JSON.stringify(fast));
  // the background shrink starts 1.5 s after the restore; the missing thumbnail
  // is an ffmpeg run queued behind the filmstrip work now going on in the
  // background, so it is waited for rather than given a fixed time
  let th = [];
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    th = await js(win, 'return window.VideoEditor.__test.shortThumbs();');
    if (i >= 4 && th.length && th.every((t) => t.jpeg)) break;
  }
  log(planted > 300000 && th[0] && th[0].jpeg && th[0].len < 40000,
    'a full-size picture from an old session is made small (' + Math.round(planted / 1024) + ' KB -> ' + Math.round((th[0] ? th[0].len : 0) / 1024) + ' KB)', JSON.stringify(th));
  log(th.slice(1).every((t) => t.jpeg && !t.busy && t.len < 40000),
    'a short saved mid-thumbnail gets its picture instead of waiting forever', JSON.stringify(th.slice(1)));
  const newSess = await js(win, 'return await window.VideoEditor.__test.saveSessionAs("After 2.80");');
  const newBytes = fs.statSync(path.join(WORK, 'sessions', newSess.id + '.json')).size;
  log(newBytes < oldBytes / 4, 'so the session file is small again', Math.round(oldBytes / 1024) + ' KB -> ' + Math.round(newBytes / 1024) + ' KB');
  const saved2 = sessions.load(newSess.id);
  log(saved2.timeline.segments.every((s) => !s._thumbing), 'and no "making a thumbnail" flag is saved into it');
  THUMBS_ON = false;
  for (const id of [oldSess.id, newSess.id]) sessions.remove(id); // [7b] counts the cards
  await js(win, `await window.VideoEditor.__test.openSession(${JSON.stringify(saved.id)}); return 1;`);

  /* ---- [6] the autosave must not eat a named session ---------------------- */
  console.log('\n[6] The rolling autosave never overwrites a named session');
  await js(win, `
    const T = window.VideoEditor.__test;
    T.addShort(1, 4);
    T.flushSession();`);
  await sleep(200);
  const stillNamed = sessions.load(saved.id);
  log(stillNamed && stillNamed.timeline.segments.length === built.segs,
    'the saved session is exactly as it was saved', stillNamed.timeline.segments.length + ' clips');
  const auto2 = sessions.readAutosave();
  log(auto2 && auto2.timeline.segments.length === built.segs + 1,
    'while the rolling slot has the newer work', auto2.timeline.segments.length + ' clips');
  const dirty = await js(win, 'return window.VideoEditor.__test.sessionChip();');
  log(dirty.dirty === true, 'and the chip shows there are unsaved changes', JSON.stringify(dirty));

  /* ---- [7] a recording that moved ---------------------------------------- */
  /* ---- [6b] the short's own thumbnail ------------------------------------- */
  console.log('');
  console.log('[6b] The picture people see before they press play');
  const tb = await js(win, 'return window.VideoEditor.__test.thumbButtons();');
  log(tb >= 1, 'every short has a thumbnail button', tb + ' buttons');
  const tOpen = await js(win, `return await window.VideoEditor.__test.openThumb(${JSON.stringify(built.ids[1])});`);
  log(tOpen.open === true, 'the picker opens on that short');
  log(tOpen.at > 2 && tOpen.at < 8, 'it starts a little way in, not on the opening frame', String(tOpen.at));
  const scrubbed = await js(win, 'return window.VideoEditor.__test.thumbScrub(800);');
  log(scrubbed > tOpen.at, 'scrubbing moves the moment', tOpen.at + ' -> ' + scrubbed);
  const took = await js(win, 'return window.VideoEditor.__test.thumbUse();');
  log(took && Math.abs(took.at - scrubbed) < 0.01, 'taking it stores that moment on the short', JSON.stringify(took));
  const closedT = await js(win, 'return window.VideoEditor.__test.closeThumb();');
  log(closedT === false, 'and the picker closes');
  // it has to survive the round trip, or the choice is lost the moment the app closes
  const savedT = await js(win, 'return await window.VideoEditor.__test.saveSessionAs("With a thumbnail");');
  await js(win, `await window.VideoEditor.__test.loadReal(${JSON.stringify(SRC_B)});`);
  const backT = await js(win, `
    const T = window.VideoEditor.__test;
    await T.openSession(${JSON.stringify(savedT.id)});
    const ids = T.segIds();
    return ids.map((i) => T.clipThumb(i)).filter(Boolean);`);
  log(backT.length === 1 && Math.abs(backT[0].at - scrubbed) < 0.01,
    'and it comes back with the session', JSON.stringify(backT));

  console.log('\n[7] A session whose recording has been moved');
  const goneSess = await js(win, `
    const T = window.VideoEditor.__test;
    await T.loadReal(${JSON.stringify(GONE)});
    T.addShort(3, 9);
    const r = await T.saveSessionAs('Midweek');
    await T.loadReal(${JSON.stringify(SRC_B)});   // let go of the file so it can be moved
    return r;`);
  // the filmstrip is made in the background now (opening no longer waits for
  // it), so its ffmpeg runs may still have the file open for a few seconds
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { fs.rmSync(GONE, { force: true }); break; } catch (e) { if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e; }
  }
  const rows = sessions.list();
  const gr = rows.find((r) => r.id === goneSess.id);
  log(gr && gr.videoMissing === true, 'the list marks it as missing its recording');
  const openGone = await js(win, `return await window.VideoEditor.__test.openSession(${JSON.stringify(goneSess.id)});`);
  log(openGone === false, 'opening it refuses rather than opening something broken');

  /* ---- [7b] the Sessions window and the resume offer ---------------------- */
  console.log('');
  console.log('[7b] The window you pick a session from');
  const w = await js(win, 'return await window.VideoEditor.__test.openSessionsWindow();');
  log(w.open === true, 'it opens');
  log(w.cards === 3, 'and lists every saved session', w.cards + ' cards');
  const closedW = await js(win, 'return window.VideoEditor.__test.closeSessionsWindow();');
  log(closedW.open === false, 'and closes again');
  // With a video already open there is nothing to resume TO, and the bar must
  // stay out of the way rather than offering to throw away live work.
  const res = await js(win, 'return await window.VideoEditor.__test.offerResume();');
  log(res.shown === false, 'the "carry on" bar stays hidden while something is already open');

  /* ---- [8] nothing broke quietly ----------------------------------------- */
  console.log('\n[8] Nothing broke quietly');
  const real = errors.filter((e) => !/Autofill|devtools|GPU|Electron Security/i.test(e));
  log(real.length === 0, 'no console errors from the studio', real.slice(0, 3).join(' | '));

  // Put back what [1] changed. Every suite shares one Electron profile and the
  // frame fill + noise setting are REMEMBERED in it: left on Blur, the next
  // suite opens with auto-reframe quietly off (it needs a crop to follow) and
  // overlays mapped through a fitted frame — add-media and studio-ux both
  // failed that way. Flushed, because localStorage reaches disk lazily and
  // this process exits 200 ms from now.
  await js(win, 'window.VideoEditor.__test.forgetExportPrefs(); return true;');
  await win.webContents.session.flushStorageData();

  console.log('\n==================  session ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  setTimeout(() => process.exit(failed ? 1 : 0), 200);
}).catch((e) => { console.error(e); process.exit(1); });
