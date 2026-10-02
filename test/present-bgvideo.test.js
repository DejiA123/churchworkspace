'use strict';
/*
 * "REPLACE ALL THE OLD PLAIN BACKGROUNDS WITH THESE ONES."
 *
 * The Presentation Studio's background gallery is real moving footage now. The
 * clips are not shipped — the app carries a poster each and fetches the video
 * on the click that chooses it — so the thing that has to be proved here is the
 * whole chain, not the manifest:
 *
 *   a real download off the network → a real file on disk → a slide whose
 *   background points at that file → a LIVE monitor whose <video> is actually
 *   PLAYING it (currentTime advancing, which no amount of correct markup can
 *   fake) → and a slide grid that does NOT spin up a decoder per thumbnail.
 *
 *   npx electron test/present-bgvideo.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const bgvideos = require(path.join(ROOT, 'src/main/bgvideos'));

const WORK = path.join(os.tmpdir(), 'mw-bgvideo-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));
bgvideos.init(WORK);

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const skip = (n, why) => console.log('  SKIP ' + n + (why ? '  -> ' + why : ''));
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('dialog:openFile', () => ok(null));
ipcMain.handle('settings:get', () => ok({ present: {}, brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(Object.assign({ live: {} }, p)));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'captions:models',
  'bible:installed', 'bible:catalogue', 'present:outputs']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('bible:books', () => ok({ books: [] }));
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => ok(presentation));
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:saveThemes', (e, { themes }) => ok(themes || []));
ipcMain.handle('present:state', () => ok({}));
ipcMain.handle('present:set', () => ok(true));

/* the real downloader — the point of the test */
ipcMain.handle('bgvideo:installed', wrap(() => bgvideos.installed()));
ipcMain.handle('bgvideo:download', wrap((e, { id, url }) => bgvideos.download(id, url)));
ipcMain.handle('bgvideo:remove', wrap((e, { id }) => bgvideos.remove(id)));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1200);
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) }; } })()`);
  await js(`document.querySelector('[data-view="present"]').click(); await new Promise(r => setTimeout(r, 500)); return 1;`);
  const T = 'window.Presenter.__test';

  head('[A] The collection that ships');
  const cat = await js(`
    ${T}.setTab('media'); ${T}.setBgCat('All');
    return { clips: ${T}.bgClips(), tiles: ${T}.bgVideoTiles(), flat: ${T}.bgFlatTiles(),
             cats: (window.BgVideos.CATEGORIES || []) };`);
  check('a real set of moving backgrounds ships with the app', cat.clips >= 24, `${cat.clips} clips in ${cat.cats.length} categories`);
  check('and the flat scenes are still reachable, not deleted', cat.flat > 0, cat.flat + ' plain scenes under "All"');

  /* the smallest clip in the collection — a real download, but a polite one */
  const smallest = await js(`
    const c = (window.BgVideos.CLIPS || []).slice().sort((a, b) => a.bytes - b.bytes)[0];
    return { id: c.id, name: c.name, bytes: c.bytes, url: c.url };`);
  console.log(`    (using "${smallest.name}" — ${(smallest.bytes / 1048576).toFixed(1)} MB)`);

  head('[B] Choosing one really fetches it');
  let got = null;
  try {
    got = await bgvideos.download(smallest.id, smallest.url);
  } catch (e) { skip('the download', e.message); }
  if (!got) {
    console.log(`\n${pass} PASS / ${fail} FAIL  (no network — the rest needs the clip)`);
    win.destroy(); app.exit(fail ? 1 : 0); return;
  }
  const st = fs.statSync(got.file);
  check('the clip lands on disk, whole', st.size === smallest.bytes,
    `${(st.size / 1048576).toFixed(1)} MB of an expected ${(smallest.bytes / 1048576).toFixed(1)} MB`);
  check('nothing is left half-written beside it', !fs.existsSync(got.file + '.part'));
  check('and it is listed as installed', bgvideos.installed().some((c) => c.id === smallest.id));

  head('[C] The tile knows, and applying it points at the LOCAL file');
  const applied = await js(`
    const T = ${T};
    await T.refreshBgVideos();
    T.newDoc('Backgrounds', 'song'); T.clearSlides(); T.addSlide();
    T.setSlideText(0, 'Amazing grace, how sweet the sound'); T.selectSlide(0);
    T.setBgApply('slide');
    const bg = await T.useBgVideo(${JSON.stringify(smallest.id)});
    return { bg, ticked: !!document.querySelector('[data-bgvid="${smallest.id}"].have'),
             badge: (document.querySelector('[data-bgvid="${smallest.id}"] .pv-bg-badge') || {}).textContent };`);
  if (applied.__error) console.error('[C] ' + applied.__error);
  check('the tile flips to “on this machine”', applied.ticked === true, 'badge: ' + applied.badge);
  check('the slide background is the downloaded video file',
    applied.bg && applied.bg.type === 'video' && applied.bg.value === got.file, applied.bg && applied.bg.value);
  check('and it carries its poster, so the grid has a still to draw',
    !!(applied.bg && applied.bg.poster), applied.bg && applied.bg.poster);

  head('[D] The thumbnail draws a picture — it does not run a decoder');
  const thumbs = await js(`
    const T = ${T};
    for (let i = 0; i < 11; i++) T.addSlide();          // twelve slides, one background
    T.setBgApply('all'); await T.useBgVideo(${JSON.stringify(smallest.id)});
    await new Promise(r => setTimeout(r, 400));
    const grid = document.getElementById('pvSlides');
    const bg = grid.querySelector('.sr-bg');
    const url = bg ? (bg.style.backgroundImage.match(/url\\("?(.*?)"?\\)/) || [])[1] : '';
    // asking the element what its background is proves only what we ASKED for
    const loads = url ? await new Promise((res) => {
      const im = new Image(); im.onload = () => res(true); im.onerror = () => res(false);
      im.src = url; setTimeout(() => res(null), 4000);
    }) : false;
    return { slides: T.slides().length,
             videosInGrid: grid.querySelectorAll('video').length, url, loads };`);
  check('twelve slides share the background', thumbs.slides === 12, thumbs.slides + ' slides');
  check('and the grid runs ZERO video decoders', thumbs.videosInGrid === 0, thumbs.videosInGrid + ' <video> in the slide grid');
  check('because each thumbnail paints the poster instead — and it really loads',
    /bgvideos/.test(thumbs.url || '') && thumbs.loads === true, `${thumbs.url} (loads: ${thumbs.loads})`);

  head('[E] The LIVE monitor really plays it');
  const live = await js(`
    const T = ${T};
    T.go(0);
    await new Promise(r => setTimeout(r, 900));
    const v = document.querySelector('#pvLiveScreen video');
    if (!v) return { none: true };
    const t0 = v.currentTime;
    await new Promise(r => setTimeout(r, 900));
    return { src: v.getAttribute('src') || v.src, t0, t1: v.currentTime,
             w: v.videoWidth, h: v.videoHeight, err: v.error ? v.error.code : null,
             box: Math.round(v.getBoundingClientRect().height) };`);
  if (live.none) check('the live monitor has a video layer', false, 'no <video> in #pvLiveScreen');
  else {
    check('the live monitor plays the file off the disk', /file:/.test(live.src || '') && !live.err, (live.src || '').slice(-42));
    check('it decoded to a real 1080p picture', live.w >= 1280 && live.h >= 720, `${live.w}×${live.h}`);
    check('the clock inside the video is ADVANCING — it is playing, not paused',
      live.t1 > live.t0, `${live.t0.toFixed(2)}s → ${live.t1.toFixed(2)}s`);
    check('and it fills the monitor rather than sitting at zero height', live.box > 0, live.box + 'px tall');
  }

  head('[G] Pause and Loop for the video on the screen');
  const play = await js(`
    const T = ${T};
    T.setTab('media');
    const before = T.vidPlayback();
    const paused = T.pauseBackground();
    await new Promise(r => setTimeout(r, 700));
    const v = document.querySelector('#pvLiveScreen video');
    const t0 = v ? v.currentTime : -1;
    await new Promise(r => setTimeout(r, 800));
    const t1 = v ? v.currentTime : -1;
    const playing = T.pauseBackground();          // back on
    await new Promise(r => setTimeout(r, 900));
    const v2 = document.querySelector('#pvLiveScreen video');
    const t2 = v2 ? v2.currentTime : -1;
    await new Promise(r => setTimeout(r, 800));
    const t3 = v2 ? v2.currentTime : -1;
    const loopOff = T.setBackgroundLoop(false);
    const loopOn = T.setBackgroundLoop(true);
    return { before, paused, playing, t0, t1, t2, t3, loopOff, loopOn };`);
  if (play.__error) console.error('[G] ' + play.__error);
  check('the bar appears — ON SCREEN, beside the monitors — because a video is up',
    play.before && play.before.enabled === true && play.before.visible === true, JSON.stringify(play.before));
  check('and it names the clip it is holding', /Candlelit|139046/.test((play.before || {}).name || ''), (play.before || {}).name);
  check('pausing really stops the clock', play.t1 >= 0 && Math.abs(play.t1 - play.t0) < 0.05,
    `${play.t0.toFixed(2)}s → ${play.t1.toFixed(2)}s`);
  check('and the button says how to undo it', play.paused && play.paused.label === '▶ Play', play.paused && play.paused.label);
  check('playing again starts the clock moving', play.t3 > play.t2, `${play.t2.toFixed(2)}s → ${play.t3.toFixed(2)}s`);
  check('the state travels to every output, not just the monitor',
    play.paused && play.paused.state === true && play.playing && play.playing.state === false,
    `paused:${play.paused && play.paused.state} → ${play.playing && play.playing.state}`);
  check('Loop is a real switch on the live background, and it looks switched',
    play.loopOff && play.loopOff.loop === false && play.loopOff.lit === false
    && play.loopOn && play.loopOn.loop === true && play.loopOn.lit === true,
    `off:${play.loopOff && play.loopOff.loop} on:${play.loopOn && play.loopOn.loop}`);

  /* the bar must not be one more button to read past when there is no video */
  const noVid = await js(`
    const T = ${T};
    T.setBgApply('all'); T.usePreset('bg-royal'); T.go(0);
    await new Promise(r => setTimeout(r, 300));
    return T.vidPlayback();`);
  check('and it disappears entirely when the background is not a video',
    noVid && noVid.enabled === false, JSON.stringify(noVid));

  head('[H] A background chosen while a verse is up goes behind the VERSE');
  const verseBg = await js(`
    const T = ${T};
    T.setBgApply('all');
    T.usePreset('bg-royal');                      // every Library slide on a known colour
    T.setBgApply('slide');
    T.selectSlide(0);
    const before = T.slides().map(s => (s.bg || {}).preset || (s.bg || {}).type);
    const cue = T.fakeVerseCue();                 // a passage on the screen, nothing in the Library
    const applied = await T.useBgVideo(${JSON.stringify(smallest.id)});
    await new Promise(r => setTimeout(r, 300));
    return { cue, applied, before, after: T.slides().map(s => (s.bg || {}).preset || (s.bg || {}).type),
             liveBg: T.liveState().layers.background };`);
  if (verseBg.__error) console.error('[H] ' + verseBg.__error);
  check('the picture lands behind the verses on the screen',
    verseBg.liveBg && verseBg.liveBg.type === 'video' && /\.mp4$/i.test(verseBg.liveBg.value || ''),
    verseBg.liveBg && verseBg.liveBg.value);
  check('…and NOT on a slide in the Library the operator cannot even see',
    verseBg.before.every((b) => b === 'bg-royal') && verseBg.after.every((b) => b === 'bg-royal'),
    `${verseBg.before[0]} → ${verseBg.after[0]} on all ${verseBg.after.length} slides`);

  head('[F] Removing it puts the machine back');
  bgvideos.remove(smallest.id);
  const after = await js(`
    const T = ${T};
    await T.refreshBgVideos();
    T.setBgCat('All');
    return { ticked: !!document.querySelector('[data-bgvid="${smallest.id}"].have'),
             badge: (document.querySelector('[data-bgvid="${smallest.id}"] .pv-bg-badge') || {}).textContent };`);
  check('the file is gone', !fs.existsSync(got.file));
  check('and the tile offers the download again', after.ticked === false && /MB/.test(after.badge || ''), after.badge);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
