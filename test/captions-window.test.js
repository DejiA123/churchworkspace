'use strict';
/*
 * "AFTER I UPLOAD A VIDEO I WANT TO SEE THE CAPTIONS WINDOW — the styles and
 *  the model — even though no captions exist yet."
 *
 * Pressing 💬 used to start a transcription immediately and only show the
 * window afterwards, so the one moment the look and the listening model matter
 * was the one moment you could not reach them. This proves the window now opens
 * on an empty list with every setting live, and that nothing is transcribed
 * until the Generate button inside it is pressed.
 *
 * It also pins the default: Small (en), because a wrong word on a sermon clip
 * is worse than a slow one.
 *
 * Run: npm run test:capwindow
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const captioner = require(path.join(ROOT, 'src/main/captioner'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-capwin-'));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

/* Whether the machine ever gets asked to transcribe is the whole point, so the
 * channel is real but counts its calls instead of running whisper. */
let transcribes = 0;
ipcMain.handle('captions:transcribe', wrap(async () => { transcribes++; return { words: [] }; }));
ipcMain.handle('captions:models', wrap(async () => captioner.models()));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue']));
ipcMain.handle('captions:styles', () => ok([]));

ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, fontsDir: path.join(ROOT, 'bin/fonts') }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'live:screenSources',
  'bible:installed', 'bible:catalogue', 'bgvideo:installed']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const js = (win, src) => win.webContents
  .executeJavaScript(`(async () => {
     try { const __r = await (async () => { ${src} })(); return JSON.stringify(__r === undefined ? null : __r); }
     catch (e) { return JSON.stringify({ __error: (e && e.message) + '\\n' + (e && e.stack) }); }
   })()`)
  .then((s) => { try { return JSON.parse(s); } catch (e) { return { __error: 'unparsable: ' + String(s).slice(0, 200) }; } },
        (e) => ({ __error: 'executeJavaScript rejected: ' + String((e && e.message) || e) }));

app.whenReady().then(async () => {
  console.log('== THE CAPTIONS WINDOW, BEFORE THERE ARE ANY CAPTIONS ==');

  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);

  console.log('\n[1] The default listening model');
  const pref = await js(win, `
    document.querySelector('.nav-item[data-view="video"]').click();
    await new Promise(r => setTimeout(r, 300));
    const T = window.VideoEditor.__test;
    // loadFake finishes by drawing the playhead, which needs a laid-out preview
    // this headless window does not always have. The video state it sets up
    // first is all this test needs.
    try { T.loadFake({ durationSec: 300, width: 1920, height: 1080 }); } catch (e) {}
    // A fresh install: this window's profile keeps localStorage between runs,
    // so the stored choice is cleared and the preferences reloaded properly.
    return T.resetCapModelPref();`);
  log(pref === "small.en", "captions default to the Small (en) model", JSON.stringify(pref));

  console.log('\n[2] Open the captions window on a video with no captions');
  const w = await js(win, `return await window.VideoEditor.__test.openCaptionsWindow();`);
  if (w.__error) console.error('   ' + w.__error);
  log(w.open === true, 'the window opens straight away');
  log(w.transcribed === false && transcribes === 0,
    'AND NOTHING WAS TRANSCRIBED to open it', `${transcribes} transcribe calls`);
  log(w.generateBtn === true, 'there is a Generate captions button inside it');
  console.log('   empty state says: ' + (w.emptyText || '').replace(/\s+/g, ' ').trim().slice(0, 150));

  console.log('\n[3] Every setting is there to choose BEFORE the words are made');
  log(w.controls.length === 8, 'font, size, words-per-line, case, position, colour, style and hearing are all present',
    w.controls.join(', '));
  log((w.styles || []).length >= 4, 'the caption LOOKS are offered', `${(w.styles || []).length} styles: ${(w.styles || []).join(', ')}`);
  console.log('   models offered: ' + (w.models || []).map((m) => m.label).join(' | '));
  log((w.models || []).length >= 3, 'and every listening MODEL is offered, installed or not', `${(w.models || []).length} models`);
  log(w.model === 'small.en' || w.model === 'get:small.en',
    'with Small shown as the current choice even before it is downloaded', String(w.model));

  console.log('\n[4] Changing a look sticks, without transcribing anything');
  const styled = await js(win, `
    const T = window.VideoEditor.__test;
    const before = T.capStyleNow();
    const styles = Array.from(document.getElementById('capStyleSel').options).map(o => o.value);
    const other = styles.find(s => s !== before);
    T.setCapStyleFromPicker(other);
    return { before, after: T.capStyleNow(), other };`);
  log(styled.after === styled.other && styled.after !== styled.before,
    'picking a different look changes the setting', `${styled.before} → ${styled.after}`);
  log(transcribes === 0, 'and STILL nothing has been transcribed', `${transcribes} transcribe calls`);

  console.log('\n[5] The Generate button is what does the listening');
  const gen = await js(win, `
    // Small is the default and is not installed here, so the app asks whether to
    // download it. That question is the right behaviour and is answered "no —
    // use what is installed" so this test measures the transcribe, not the box.
    window.confirm = () => false;
    const b = document.getElementById('capGenerate');
    if (!b) return { clicked: false };
    b.click();
    await new Promise(r => setTimeout(r, 900));
    return { clicked: true };`);
  log(gen.clicked === true, 'the button is clickable');
  log(transcribes === 1, 'ONE transcription runs, and only when asked for', `${transcribes} transcribe calls`);

  console.log('\n============  CAPTIONS WINDOW ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
