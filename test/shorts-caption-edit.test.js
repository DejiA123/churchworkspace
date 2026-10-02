'use strict';
/*
 * "I should be able to click the caption button of the short and it opens the
 *  window of the captions text and I can edit it there as well."
 *
 * The words WERE editable before this — as blocks on the timeline lane, which is
 * a fine way to re-time a line and a poor way to proof-read forty of them. This
 * drives the real Shorts panel: click the real 💬 button on a real clip card,
 * and prove that (a) a window opens with that short's words in it, (b) only that
 * short's words, (c) typing in it really changes the one caption store the
 * export reads, and (d) the whole-video route still shows everything.
 *
 * No speech engine is involved: whisper's accuracy is tested elsewhere, and what
 * is in question here is the editing, so the transcript is seeded directly.
 *
 *   npx electron test/shorts-caption-edit.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-shorts-cap-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));   // see present-media.test.js

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
/* A real-shaped model list: two bundled, one downloaded, one not — the state an
 * operator is in after paying for the Small download once. */
let MODELS = [
  { id: 'tiny.en', name: 'Tiny (fastest, roughest)', sizeMB: 78, bundled: true, installed: true, downloadable: false, inUse: false },
  { id: 'base.en', name: 'Base (ships with the app)', sizeMB: 148, bundled: true, installed: true, downloadable: false, inUse: false },
  { id: 'small.en', name: 'Small — much more accurate', sizeMB: 466, bundled: false, installed: true, downloadable: true, inUse: true },
  { id: 'medium.en', name: 'Medium — the most accurate', sizeMB: 1536, bundled: false, installed: false, downloadable: true, inUse: false },
];
ipcMain.handle('captions:models', () => ok(MODELS));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1200));
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) }; } })()`);
  const T = 'window.VideoEditor.__test';

  await js(`document.querySelector('[data-view="video"]').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);

  /* A 10-minute sermon with two shorts cut from it, and a transcript covering
   * both — the state an operator is in right after "Auto-caption all shorts". */
  const ids = await js(`
    ${T}.loadFake({ durationSec: 600, width: 1920, height: 1080 });
    ${T}.applyClips([{ start: 60, end: 90, label: 'Grace' }, { start: 300, end: 330, label: 'Mercy' }]);
    ${T}.setCapEvents([
      { start: 61, end: 63, text: 'GRACE IS FREE' },
      { start: 64, end: 66, text: 'BUT IT IS NOT CHEEP' },
      { start: 67, end: 69, text: 'IT COST EVERYTHING' },
      { start: 301, end: 303, text: 'HIS MERCY IS NEW' },
      { start: 304, end: 306, text: 'EVERY SINGLE MORNING' },
    ], 0);
    return ${T}.segments().map(s => s.id);
  `);
  check('two shorts and a transcript are in place', Array.isArray(ids) && ids.length === 2, JSON.stringify(ids));

  head('[A] The 💬 button opens the words');
  const clicked = await js(`return ${T}.clickClipCaption(${JSON.stringify(ids[0])});`);
  await new Promise((r) => setTimeout(r, 200));
  const m = await js(`return ${T}.capModal();`);
  check('clicking a short’s 💬 opens the captions window', clicked === true && m.open === true, JSON.stringify(m.open));
  check('…titled with that short, not "whole video"', /Grace/.test(m.title), m.title);
  check('…and it lists exactly that short’s lines', m.rows === 3 && /GRACE IS FREE/.test(m.texts[0] || ''),
    `${m.rows} rows: ${JSON.stringify(m.texts)}`);
  check('…not the other short’s', !m.texts.some((t) => /MERCY/.test(t)), JSON.stringify(m.texts));
  check('…with times counted from the start of the short, not the sermon',
    m.times[0] === '0:01', JSON.stringify(m.times));
  check('…and the save button offers to save THIS short', /short/i.test(m.burnLabel), m.burnLabel);

  head('[B] Editing there really changes what gets burned in');
  const edited = await js(`return ${T}.editCapRow(1, 'BUT IT IS NOT CHEAP');`);
  check('retyping a misheard word updates the one caption store',
    edited && edited.lane[1] === 'BUT IT IS NOT CHEAP', JSON.stringify(edited && edited.lane));
  const clipLines = await js(`return ${T}.clipCapEvents(${JSON.stringify(ids[0])});`);
  check('…so the short itself now carries the corrected line',
    clipLines && clipLines.some((e) => e.text === 'BUT IT IS NOT CHEAP'),
    JSON.stringify((clipLines || []).map((e) => e.text)));
  const laneBlock = await js(`return ${T}.capLines()[1];`);
  check('…and the timeline block shows the same words (one store, not two)',
    laneBlock && laneBlock.text === 'BUT IT IS NOT CHEAP', JSON.stringify(laneBlock));
  check('…while the other short is untouched',
    (await js(`return ${T}.capLines()[3].text;`)) === 'HIS MERCY IS NEW');

  head('[C] The other short, and the whole video');
  await js(`return ${T}.closeCapModal();`);
  await js(`return ${T}.clickClipCaption(${JSON.stringify(ids[1])});`);
  await new Promise((r) => setTimeout(r, 200));
  const m2 = await js(`return ${T}.capModal();`);
  check('the second short opens its own words', m2.rows === 2 && /Mercy/.test(m2.title),
    `${m2.rows} rows, "${m2.title}"`);
  check('…scoped to it, so an edit here cannot touch the first',
    m2.texts.every((t) => /MERCY|MORNING/.test(t)), JSON.stringify(m2.texts));

  await js(`return ${T}.closeCapModal();`);
  const closed = await js(`return ${T}.capModal();`);
  check('closing the window drops the scope', closed.open === false && closed.scope === null,
    JSON.stringify({ open: closed.open, scope: closed.scope }));

  const whole = await js(`
    document.getElementById('veCapStyle').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    return ${T}.capModal();
  `);
  check('the timeline’s own caption button still shows the WHOLE transcript',
    whole.open === true && whole.rows === 5 && !/Grace|Mercy/.test(whole.title),
    `${whole.rows} rows, "${whole.title}"`);
  check('…and offers to save the whole video', !/short/i.test(whole.burnLabel), whole.burnLabel);
  await js(`return ${T}.closeCapModal();`);

  /* ==================================================================== */
  head('[D] You can actually reach the words');
  /*
   * The reported failure: "I cannot scroll down to see the caption texts to
   * edit them." The list was in the DOM and correctly filled — and about 40
   * pixels tall, behind the buttons, because the Style grid and the Accuracy
   * list above it had taken the whole window and the box does not scroll. So
   * this measures GEOMETRY, not presence.
   */
  await js(`
    ${T}.setCapEvents(Array.from({length: 109}, (_, i) => ({
      start: 61 + i * 0.25, end: 61.2 + i * 0.25, text: 'LINE ' + (i + 1)
    })), 0);
    ${T}.clickClipCaption(${JSON.stringify(ids[0])});
    return 1;
  `);
  await new Promise((r) => setTimeout(r, 250));
  const L = await js(`return ${T}.capModalLayout();`);
  check('the caption list gets real height, not a sliver', L && L.listH >= 150, `${L && L.listH}px`);
  check('…enough to read several lines at once', L && L.visibleRows >= 4, `${L && L.visibleRows} rows on screen`);
  check('…and it scrolls, so all 109 lines are reachable', L && L.scrollable && L.rows > 100,
    `${L && L.rows} rows, scrollable=${L && L.scrollable}`);
  check('the window and its buttons fit on the screen', L && L.boxFitsViewport && L.footVisible,
    JSON.stringify({ box: L && L.boxH, fits: L && L.boxFitsViewport, foot: L && L.footVisible }));
  const m0 = await js(`return ${T}.capModal();`);
  check('Style and Hearing are pickers in the settings row, always visible',
    m0.styleOptions > 5 && m0.modelOptions >= 2,
    `${m0.styleOptions} looks, ${m0.modelOptions} listening models`);

  /*
   * THE BUG THIS SECTION EXISTS FOR.
   *
   * Style and Accuracy used to be panels under the caption text. On an ordinary
   * window they were squeezed until their own headings overflowed their boxes
   * and painted over each other and the Save button — clearly visible in a
   * screenshot, while a check that only compared the panels' RECTANGLES
   * reported everything fine (a box two pixels tall overlaps nothing; its
   * contents spill out anyway). So the check now asks whether each part of the
   * window actually fits what is inside it.
   */
  const ov = await js(`return ${T}.capModalOverlaps();`);
  check('nothing in the window sits on top of anything else',
    ov && ov.overlaps.length === 0 && ov.outsideBox.length === 0,
    JSON.stringify({ overlaps: ov && ov.overlaps, outside: ov && ov.outsideBox }));
  check('…and nothing is squeezed smaller than its own contents',
    ov && ov.squashed.length === 0, JSON.stringify(ov && ov.squashed));

  /*
   * A SHORT SCREEN is the case that actually broke. On a 1366×768 church laptop
   * there is far less room, and that is exactly where a panel opening pushes
   * the Save button off the bottom.
   */
  win.setSize(1280, 720);
  await new Promise((r) => setTimeout(r, 600));
  const small = await js(`return ${T}.capModalLayout();`);
  const smallOv = await js(`return ${T}.capModalOverlaps();`);
  check('on a small laptop screen the words are still readable',
    small && small.listH >= 100 && small.visibleRows >= 2, `list ${small && small.listH}px, ${small && small.visibleRows} rows`);
  check('…the Save button is still there', small && small.footVisible,
    small && small.footClippedBy ? `clipped by ${small.footClippedBy}px` : 'visible');
  check('…nothing overlaps', smallOv && smallOv.overlaps.length === 0,
    JSON.stringify(smallOv && smallOv.overlaps));
  // The size the report came from — a window barely taller than it is wide.
  check('…and nothing is squeezed smaller than its contents',
    smallOv && smallOv.squashed.length === 0, JSON.stringify(smallOv && smallOv.squashed));
  const smallPickers = await js(`return ${T}.capModal();`);
  check('…and both pickers are still there', smallPickers.styleOptions > 5 && smallPickers.modelOptions >= 2,
    `${smallPickers.styleOptions} looks, ${smallPickers.modelOptions} models`);
  win.setSize(1500, 950);
  await new Promise((r) => setTimeout(r, 400));

  head('[E] Choosing how accurately it listens');
  const rows = await js(`return ${T}.capModelRows();`);
  check('every model is in the picker — Automatic, the installed ones, and the rest',
    rows.length === 5 && rows[0].id === '' && rows.some((r) => r.id === 'base.en') && rows.some((r) => r.id === 'tiny.en'),
    JSON.stringify(rows.map((r) => r.id)));
  check('…with one you have not downloaded offered as a download, not a silent no-op',
    rows.some((r) => r.id === 'get:medium.en' && /download/i.test(r.label)),
    JSON.stringify(rows.filter((r) => r.needsDownload).map((r) => r.label)));
  /*
   * A fresh install is on `DEFAULT_CAP_MODEL`, which is small.en — not
   * Automatic. This asserted Automatic and had gone stale against a default the
   * product moved deliberately (it is the model the app loads at startup). What
   * matters is that exactly ONE row is marked in use and it is a real model,
   * not that it happens to be the first row.
   */
  const inUse = rows.filter((r) => r.using);
  check('exactly one model is marked as the one in use',
    inUse.length === 1, JSON.stringify(rows.map((r) => ({ id: r.id, using: r.using }))));
  check('...and a fresh install is on a real model, not left undecided',
    inUse.length === 1 && inUse[0].id === 'small.en', inUse.length ? inUse[0].id : '(none)');

  const picked = await js(`return ${T}.pickCapModel('base.en');`);
  check('choosing a model really selects it', picked && picked.chosen === 'base.en', JSON.stringify(picked));
  check('…and that is the model handed to the speech engine',
    picked && picked.sentToEngine === 'base.en', String(picked && picked.sentToEngine));
  const rows2 = await js(`return ${T}.capModelRows();`);
  check('…and the picker shows it as the one in use',
    rows2.filter((r) => r.using).length === 1 && rows2.find((r) => r.using).id === 'base.en',
    JSON.stringify(rows2.filter((r) => r.using).map((r) => r.id)));

  const back = await js(`return ${T}.pickCapModel('');`);
  check('and Automatic can be chosen again', back && back.chosen === '' && back.sentToEngine === undefined,
    JSON.stringify(back));

  head('[F] The Style picker still shows you the look');
  const styles = await js(`return ${T}.capStyleCards();`);
  check('every look is in the dropdown', styles.length > 5, `${styles.length} looks`);
  // Choosing a caption look by reading names is guesswork, so the gallery is
  // still there — as an overlay that cannot take height from the words.
  const gallery = await js(`
    const open = ${T}.openCapStylePicker();
    const cards = document.querySelectorAll('#capStyleGrid .cap-style-card').length;
    const ov = ${T}.capModalOverlaps();
    ${T}.openCapStylePicker(false);
    return { open, cards, squashed: ov.squashed.length, overlaps: ov.overlaps.length };
  `);
  check('the sample opens a gallery of every look, worn by its own card',
    gallery.open === true && gallery.cards > 5, `${gallery.cards} cards`);
  check('…and having it open squeezes nothing',
    gallery.squashed === 0 && gallery.overlaps === 0, JSON.stringify(gallery));
  const before = await js(`return ${T}.capStyleSampleCss();`);
  const cfgBefore = await js(`return ${T}.capStyleCfg();`);
  await js(`return ${T}.pickCapStyle('band');`);
  const after = await js(`return ${T}.capStyleSampleCss();`);
  check('choosing one changes what the sample beside it looks like',
    before && after && JSON.stringify(before) !== JSON.stringify(after),
    JSON.stringify({ before: before && before.background, after: after && after.background }));
  // Compare what the BURNER is handed, rather than asserting an internal name:
  // a look's id and the drawing mode it uses are not the same thing.
  const cfgAfter = await js(`return ${T}.capStyleCfg();`);
  check('…and the burner is handed the new look, not the old one',
    cfgAfter && JSON.stringify(cfgAfter) !== JSON.stringify(cfgBefore),
    JSON.stringify({ was: cfgBefore && cfgBefore.style, now: cfgAfter && cfgAfter.style }));
  await js(`return ${T}.closeCapModal();`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
