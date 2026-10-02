'use strict';
/*
 * Screenshot the Bible side of the Presentation Studio, so the translation list
 * can be LOOKED AT rather than reasoned about. Real Bible engine, real network.
 *
 * Writes bible-manager.png (the translation list, NIV/NLT/ESV… in it) and
 * bible-panel.png (a verse found in the NIV, ready to go on the projector).
 *
 *   MW_SAMPLE_DIR=<dir> npx electron test/shot-bible.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const OUT = process.env.MW_SAMPLE_DIR || os.tmpdir();
const WORK = path.join(os.tmpdir(), 'mw-shot-bible');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

const bible = require(path.join(__dirname, '..', 'src', 'main', 'bible'));
const bgvideos = require(path.join(__dirname, '..', 'src', 'main', 'bgvideos'));
bible.init(WORK);

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
ipcMain.handle('dialog:openFile', () => ok(null));
ipcMain.handle('settings:get', () => ok({ present: {}, brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('bgvideo:installed', wrap(() => bgvideos.installed()));
ipcMain.handle('bgvideo:download', wrap((e, { id, url }) => bgvideos.download(id, url)));
ipcMain.handle('bgvideo:remove', wrap((e, { id }) => bgvideos.remove(id)));
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => ok(presentation));
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:saveThemes', (e, { themes }) => ok(themes || []));

/* the real Bible engine — this is the point of the shot */
ipcMain.handle('bible:catalogue', wrap((e, { refresh }) => bible.catalogue({ refresh })));
ipcMain.handle('bible:installed', wrap(() => bible.installed()));
ipcMain.handle('bible:download', wrap((e, { abbr }) => bible.download(abbr)));
ipcMain.handle('bible:remove', wrap((e, { abbr }) => bible.remove(abbr)));
ipcMain.handle('bible:lookup', wrap((e, { translation, ref }) => bible.lookup({ translation, ref })));
ipcMain.handle('bible:search', wrap((e, a) => bible.searchAny(a)));
ipcMain.handle('bible:books', wrap(async (e, { translation }) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:chapter', wrap((e, a) => bible.getChapter(a)));
ipcMain.handle('bible:parseRef', wrap((e, { ref }) => bible.parseRef(ref)));
ipcMain.handle('bible:import', wrap((e, { path: p, abbr, name }) => bible.importFile(p, { abbr, name })));

app.disableHardwareAcceleration();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.log('TIMED OUT'); app.exit(1); }, 180000).unref();

/*
 * capturePage hands back the last COMPOSITED frame, which after a DOM change
 * can still be the previous screen — three shots of three different panels came
 * out byte-identical. Nudging the window and throwing the first frame away
 * costs a second and makes the picture match the state it claims to show.
 */
async function shot(win, file) {
  win.focus(); win.moveTop();
  win.webContents.invalidate();
  await sleep(500);
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const buf = (await win.webContents.capturePage()).toPNG();
    if (buf.length > 20000 && buf.length !== last) { fs.writeFileSync(file, buf); return buf.length; }
    last = buf.length;
    await sleep(400);
  }
  return 0;
}

app.whenReady().then(async () => {
  console.log('downloading the NIV for real…');
  try { console.log('  ', JSON.stringify(await bible.download('bolls:NIV'))); } catch (e) { console.log('  download failed:', e.message); }
  // one small clip, so the video bar has something to hold
  bgvideos.init(WORK);
  try {
    const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'bgvideos.js'), 'utf8');
    const rows = [...m.matchAll(/id: '(\d+)',[^}]*url: '([^']+)', bytes: (\d+)/g)]
      .map((x) => ({ id: x[1], url: x[2], bytes: Number(x[3]) })).sort((a, b) => a.bytes - b.bytes);
    console.log('   clip:', JSON.stringify(await bgvideos.download(rows[0].id, rows[0].url)));
  } catch (e) { console.log('  clip download failed:', e.message); }

  const win = new BrowserWindow({
    show: true, width: 1500, height: 950,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, sandbox: false,
      backgroundThrottling: false,   // or an unfocused window stops repainting and every shot is the first one
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1800);

  const rows = await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('[data-view="present"]').click();
    await new Promise(r => setTimeout(r, 600));
    const T = window.Presenter.__test;
    T.setTab('bible');
    await T.setTranslation('bolls:NIV');
    return T.openBibleManager();
  })()`);
  await sleep(1200);
  console.log('bible-manager.png', await shot(win, path.join(OUT, 'bible-manager.png')), `(${rows} rows)`);

  const found = await win.webContents.executeJavaScript(`(async () => {
    const T = window.Presenter.__test;
    T.closeBibleManager();
    const picked = await T.pickBible(43, 3, null, null);   // John ▸ 3 — opens on Whole chapter
    T.setVersesPerSlide(1);
    const cue = T.clickVerse(16);                          // one click puts v16 on the screen
    T.clearMore(true);                                     // show what ⋯ More holds
    T.verseFormat('top');                                  // …and move the verse to the top
    // …and a background chosen while it is up goes behind the VERSES
    T.setBgApply('slide');
    T.usePreset((window.Backgrounds.PRESETS.find(p => p.type === 'image') || {}).id);
    await new Promise(r => setTimeout(r, 500));
    return { picked, cue, verseBg: (T.liveState().layers.background || {}).type,
             options: T.translationOptions().map(o => o.label) };
  })()`);
  await sleep(700);
  console.log('bible-panel.png', await shot(win, path.join(OUT, 'bible-panel.png')), JSON.stringify(found));

  /* The LIVE monitor with a picture behind the words — the thing that was black. */
  const live = await win.webContents.executeJavaScript(`(async () => {
    const T = window.Presenter.__test;
    T.addScripture(false);
    T.selectSlide(0);
    const scene = window.Backgrounds.PRESETS.find(p => p.type === 'image');
    T.setBackground(0, window.Backgrounds.toBg(scene));
    T.go(0);
    await new Promise(r => setTimeout(r, 400));
    return { scene: scene.name, probe: await T.liveScreenBgProbe() };
  })()`);
  await sleep(700);
  console.log('bible-live.png', await shot(win, path.join(OUT, 'bible-live.png')), JSON.stringify(live));

  /* The video bar — visible beside the monitors whenever a video is on screen. */
  const vid = await win.webContents.executeJavaScript(`(async () => {
    const T = window.Presenter.__test;
    T.setTab('media');
    await T.refreshBgVideos();
    const clip = (window.BgVideos.CLIPS || []).slice().sort((a, b) => a.bytes - b.bytes)[0];
    const files = await T.refreshBgVideos();
    if (!files[clip.id]) return { skipped: clip.name };   // nothing downloaded on this machine
    T.setBgApply('all');
    await T.useBgVideo(clip.id);
    T.go(0);
    await new Promise(r => setTimeout(r, 600));
    return { clip: clip.name, bar: T.vidPlayback() };
  })()`);
  await sleep(600);
  console.log('bg-videobar.png', await shot(win, path.join(OUT, 'bg-videobar.png')), JSON.stringify(vid));

  /* The new motion-background gallery. */
  const gallery = await win.webContents.executeJavaScript(`(async () => {
    const T = window.Presenter.__test;
    T.setTab('media'); T.setBgCat('All');
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('#pvBgGrid').scrollIntoView({ block: 'start' });
    await new Promise(r => setTimeout(r, 400));
    return { clips: T.bgClips(), tiles: T.bgVideoTiles(), flat: T.bgFlatTiles() };
  })()`);
  await sleep(900);
  console.log('bg-gallery.png', await shot(win, path.join(OUT, 'bg-gallery.png')), JSON.stringify(gallery));

  win.destroy();
  app.exit(0);
});
