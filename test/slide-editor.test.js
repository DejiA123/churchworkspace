'use strict';
/*
 * "I HAVE TO DOUBLE-CLICK A SLIDE TO EDIT IT, AND I CAN ONLY CHANGE THE WORDS."
 *
 * Editing was a double-click — undiscoverable — that produced a bare textarea.
 * How the words LOOKED (size, colour, font, where they sat) could only be
 * changed for the whole Look, so one verse that needed to be a little smaller
 * meant restyling the entire service.
 *
 * This drives the ✏️ on a slide card exactly as an operator does, and proves:
 *   • the button exists, opens the editor, and does NOT cue the slide
 *   • every type control is there and each one really changes the slide
 *   • the change reaches the RENDERED text, not just the data
 *   • the grid thumbnail and a LIVE projector follow the edit as it is made
 *   • one slide can differ from the Look without disturbing its neighbours
 *   • Cancel puts everything back
 *
 * Run: npm run test:slideeditor
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const presenter = require(path.join(ROOT, 'src/main/presenter'));
const bible = require(path.join(ROOT, 'src/main/bible'));

const WORK = path.join(os.tmpdir(), 'mw-slide-editor');
fs.mkdirSync(WORK, { recursive: true });
bible.init(WORK);

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, present: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'live:screenSources',
  'bible:installed', 'bible:catalogue', 'bgvideo:installed', 'captions:models']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('dialog:openFile', () => ok(null));
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', () => ok(true));
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:deletePlaylist', () => ok(true));
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });
ipcMain.handle('bible:lookup', wrap(async () => ({ verses: [] })));
ipcMain.handle('bible:books', wrap(async () => ({ books: [] })));
ipcMain.handle('present:displays', wrap(() => presenter.displays()));
ipcMain.handle('present:open', wrap((e, a) => Object.assign(presenter.open(a), { state: presenter.state() })));
ipcMain.handle('present:close', wrap((e, { role }) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(() => presenter.state()));
/* The projector is REAL: the state it is sent is kept, so "the live screen
 * follows the edit" is checked against what the output would actually show. */
let lastLive = null;
ipcMain.handle('present:set', wrap((e, patch) => { lastLive = presenter.setState(patch || {}); return true; }));
ipcMain.handle('webout:state', wrap(async () => ({ running: false })));
ipcMain.handle('dmx:state', wrap(async () => ({ enabled: false })));
ipcMain.handle('ndiout:state', wrap(async () => ({ available: false, feeds: [] })));

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
  console.log('== EDITING A SLIDE ==');

  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);

  console.log('\n[1] A song with three slides, the first of them LIVE');
  const setup = await js(win, `
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r => setTimeout(r, 400));
    const T = window.Presenter.__test;
    const id = T.newDoc('Slide Editor Song', 'song');
    T.openDoc(id); T.clearSlides();
    T.addSlide(); T.setSlideText(0, 'AMAZING GRACE\\nHOW SWEET THE SOUND');
    T.addSlide(); T.setSlideText(1, 'THAT SAVED A WRETCH LIKE ME');
    T.addSlide(); T.setSlideText(2, 'I ONCE WAS LOST');
    T.go(0);
    await new Promise(r => setTimeout(r, 200));
    return { slides: T.slides().length, liveIx: T.state().liveIx };`);
  if (setup.__error) console.error('   ' + setup.__error);
  log(setup.slides === 3 && setup.liveIx === 0, 'three slides, slide 1 on the screen', JSON.stringify(setup));

  console.log('\n[2] The ✏️ button — visible, and it opens an editor');
  const opened = await js(win, `return window.Presenter.__test.openSlideEditorViaButton(1);`);
  if (opened.__error) console.error('   ' + opened.__error);
  log(opened.opened === true, 'every slide carries a ✏️ that opens the editor — no secret double-click');
  log(opened.liveIxAfter === 0, 'and pressing it does NOT cue that slide onto the screen', 'live slide still ' + opened.liveIxAfter);
  log(opened.hasPreview === true, 'the editor shows a live preview painted by the real projector renderer');
  log(opened.text === 'THAT SAVED A WRETCH LIKE ME', 'with the slide\'s own words in the box', JSON.stringify(opened.text));

  console.log('\n[3] Every text option is there');
  console.log('   controls: ' + opened.controls.join(' '));
  log(opened.controls.length === 13,
    'font, size, colour, bold, italic, caps, across, down, line spacing, margin, shadow, outline, outline colour',
    `${opened.controls.length} of 13`);

  console.log('\n[4] Each option really changes the slide AND the rendered text');
  const colour = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-color', '#ffcc00');`);
  log(colour.theme.color === '#ffcc00' && /color:#ffcc00/i.test(colour.css || ''),
    'COLOUR reaches the rendered words', (colour.css || '').match(/color:[^;]+/i) || '');
  const size = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-size', 150);`);
  log(size.theme.sizePx === 150 && /font-size:150px/.test(size.css || ''), 'SIZE reaches the rendered words',
    (size.css || '').match(/font-size:[^;]+/) || '');
  const font = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-font', 'Anton');`);
  log(font.theme.font === 'Anton' && /Anton/.test(font.css || ''), 'FONT reaches the rendered words',
    (font.css || '').match(/font-family:[^;]+/) || '');
  const align = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-align', 'left');`);
  log(align.theme.align === 'left' && /text-align:left/.test(align.css || ''), 'POSITION ACROSS reaches the rendered words');
  const valign = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-valign', 'top');`);
  log(valign.theme.valign === 'top', 'POSITION DOWN is set on the slide', JSON.stringify(valign.theme.valign));
  const caps = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-caps');`);
  log(caps.theme.allCaps === true && /text-transform:uppercase/.test(caps.css || ''), 'ALL CAPS reaches the rendered words');
  const outline = await js(win, `return window.Presenter.__test.setSlideStyle('.sled-outline', 2);`);
  log(outline.theme.outline === 2 && /text-stroke/.test(outline.css || ''), 'OUTLINE reaches the rendered words');

  console.log('\n[5] The words themselves');
  const typed = await js(win, `return window.Presenter.__test.typeSlideText('THAT SAVED A WRETCH\\nLIKE ME');`);
  log(Array.isArray(typed) && typed.length === 2 && typed[1] === 'LIKE ME',
    'typing in the box rewrites the slide, line for line', JSON.stringify(typed));

  console.log('\n[6] The grid thumbnail follows the edit');
  const thumb = await js(win, `return window.Presenter.__test.slideThumbCss(1);`);
  log(/color:#ffcc00/i.test(thumb || '') && /font-size:150px/.test(thumb || ''),
    'the slide in the library shows the new styling immediately', (thumb || '').slice(0, 90));

  console.log('\n[7] Only THIS slide changed');
  const others = await js(win, `
    const T = window.Presenter.__test;
    return { one: T.slideTheme(0), two: T.slideTheme(1), three: T.slideTheme(2) };`);
  log(others.one === null && others.three === null && others.two && others.two.color === '#ffcc00',
    'its neighbours are untouched — one slide can differ from the Look', JSON.stringify(others));

  console.log('\n[8] A LIVE slide follows the editing as it happens');
  const liveEdit = await js(win, `
    const T = window.Presenter.__test;
    T.clickSlideEditor('.pv-sled-done');
    T.go(2);                                   // put slide 3 on the screen
    await new Promise(r => setTimeout(r, 150));
    T.openSlideEditorViaButton(2);
    T.setSlideStyle('.sled-color', '#00ffaa');
    await new Promise(r => setTimeout(r, 200));
    return { editing: T.slideEditorOpen(), theme: T.slideTheme(2) };`);
  const liveSlide = lastLive && lastLive.layers && lastLive.layers.slide;
  log(liveEdit.theme && liveEdit.theme.color === '#00ffaa', 'editing a live slide sets its colour');
  log(!!liveSlide && !!liveSlide.theme && liveSlide.theme.color === '#00ffaa',
    'AND THE PROJECTOR IS SENT THE CHANGE while the editor is still open',
    JSON.stringify(liveSlide && liveSlide.theme));

  console.log('\n[9] Cancel puts it back');
  const cancelled = await js(win, `
    const T = window.Presenter.__test;
    T.clickSlideEditor('.pv-sled-cancel');
    return { open: T.slideEditorOpen(), theme: T.slideTheme(2) };`);
  log(cancelled.open === false, 'the editor closes');
  log(cancelled.theme === null, 'and the slide is exactly as it was before it opened', JSON.stringify(cancelled.theme));

  console.log('\n[10] "Use this styling for the whole song"');
  const all = await js(win, `
    const T = window.Presenter.__test;
    T.openSlideEditorViaButton(0);
    T.setSlideStyle('.sled-color', '#ff66cc');
    T.clickSlideEditor('.pv-sled-apply-all');
    T.clickSlideEditor('.pv-sled-done');
    return [T.slideTheme(0), T.slideTheme(1), T.slideTheme(2)].map(t => t && t.color);`);
  log(Array.isArray(all) && all.every((c) => c === '#ff66cc'),
    'one click gives every slide in the song the same styling', JSON.stringify(all));

  console.log('\n============  SLIDE EDITOR ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
