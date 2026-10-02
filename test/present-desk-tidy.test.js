'use strict';
/*
 * Six complaints from the operator's chair, each one held down by a check.
 *
 *   1. the strip of eleven coloured chips under the slides — gone
 *   2. a section tab ("Verse 1", "Blank") can be renamed to whatever the
 *      running order actually calls it
 *   3. a second playlist can be created, and "This Sunday" renamed
 *   4. renaming one playlist entry does NOT rename the other entry that points
 *      at the same song
 *   5. the Show/Edit mode pair is gone, and editing no longer latches
 *   6. the four unlabelled music glyphs moved into ⋯ More → 🎵 Music
 *
 * The one that made the rest possible is not on that list: window.prompt()
 * does not exist in Electron — it throws "prompt() is and will not be
 * supported." — so every button built on it did nothing at all. There were
 * seventeen. [0] covers the replacement, because if ask() breaks, "＋ New
 * playlist" goes silently dead again and nothing else here would notice.
 *
 *   npm run test:desktidy
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-desktidy-'));
app.setPath('userData', path.join(WORK, 'ud'));   // never read the dev's real localStorage

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (data) => ({ ok: true, data });
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, present: { translation: 'kjv' } }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', appVersion: '9.9.9-test' }));
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', (e, { id }) => { mem.presentations = mem.presentations.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:savePlaylist', (e, { playlist }) => {
  const i = mem.playlists.findIndex((p) => p.id === playlist.id);
  if (i >= 0) mem.playlists[i] = playlist; else mem.playlists.push(playlist);
  return ok(playlist);
});
ipcMain.handle('present:deletePlaylist', (e, { id }) => { mem.playlists = mem.playlists.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'present:displays',
  'bible:installed', 'bible:catalogue', 'live:screenSources', 'live:destinations', 'bgvideo:installed',
  'captions:models']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('present:set', () => ok(true));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('bible:books', () => ok({ books: [] }));

const js = (win, src) => win.webContents
  .executeJavaScript(`(async () => {
     try { const __r = await (async () => { ${src} })(); return JSON.stringify(__r === undefined ? null : __r); }
     catch (e) { return JSON.stringify({ __error: (e && e.message) + '\\n' + (e && e.stack) }); }
   })()`)
  .then((s) => { try { return JSON.parse(s); } catch (e) { return { __error: 'unparsable: ' + String(s).slice(0, 200) }; } },
    (e) => ({ __error: 'rejected: ' + String((e && e.message) || e) }));

app.whenReady().then(async () => {
  console.log('== PRESENTATION DESK TIDY ==');
  const win = new BrowserWindow({
    show: true, width: 1600, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  const pageErrors = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 3) pageErrors.push(msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1800);

  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-present').classList.add('active');
    window.Presenter.onShow();
    return true;`);
  await sleep(800);

  /* ---------------- [0] the dead function under everything ---------------- */
  console.log('\n[0] window.prompt is not a thing in Electron');
  const promptGone = await js(win, `
    try { window.prompt('x', 'y'); return 'returned'; }
    catch (e) { return String(e.message); }`);
  log(/not be supported/i.test(String(promptGone)),
    'calling prompt() really does throw here — this is what killed the buttons', String(promptGone));

  const asked = await js(win, `return window.Presenter.__test.askProbe('Communion');`);
  log(asked.opened === true, 'ask() opens an in-app dialog instead');
  log(asked.seeded === 'seed', 'seeded with the default, the way prompt() was', asked.seeded);
  log(asked.value === 'Communion', 'and hands back what was typed', JSON.stringify(asked.value));
  log(asked.closed === true, 'and closes itself afterwards');
  /* Cancel has to mean null, not empty string — every caller reads a falsy
   * result as "the operator changed their mind" and stops. */
  const cancelled = await js(win, `
    const p = window.Presenter.__test.askCancelProbe();
    return p;`);
  log(cancelled.value === null, 'Cancel gives back null, the way prompt() did', JSON.stringify(cancelled));

  /* ---------------- [1] the chip strip ---------------- */
  console.log('\n[1] The coloured chip strip under the slides');
  const chips = await js(win, `return window.Presenter.__test.groupChipBar();`);
  log(chips.present === false, 'the #pvGroups strip is gone from the page');
  log(chips.chips === 0, 'and no chip buttons are rendered anywhere', String(chips.chips));

  /* ---------------- [2] renaming a section ---------------- */
  console.log('\n[2] Renaming a section tab');
  const setup = await js(win, `
    const T = window.Presenter.__test;
    T.newDoc('Test song', 'song');
    T.setGroup(0, 'Verse 1');
    T.addSlide();
    T.setGroup(1, 'Blank');
    return { bars: T.sectionBars(), n: T.state().slides };`);
  log(setup.bars.length >= 2, 'two sections to work with', JSON.stringify(setup.bars.map((b) => b.name)));

  const renamed = await js(win, `
    const T = window.Presenter.__test;
    const groups = T.renameSection(0, 'Communion');
    return { groups, bars: T.sectionBars() };`);
  log(renamed.groups && renamed.groups[0] === 'Communion',
    'double-clicking a section bar renames it to anything you like', JSON.stringify(renamed.groups));
  log(renamed.bars[0] && renamed.bars[0].name === 'Communion',
    'and the bar on screen says so', renamed.bars[0] && renamed.bars[0].name);

  /* The studio cues the projector from bare letters on `document`: b blacks
   * the screen, 1-7 clear layers, x clears everything. Typing a section name
   * must not do any of that — which is exactly the sort of thing that stays
   * broken for a year because nobody types "Bridge 1" in a test. */
  const typed = await js(win, `return window.Presenter.__test.typeIntoRename(0, ['B','r','i','d','g','e',' ','1']);`);
  log(typed && typed.typed === 'Bridge 1', 'a name can be typed into the rename box', JSON.stringify(typed));
  log(typed && typed.blackout === false, 'and the "b" in it does NOT black out the projector');
  log(typed && typed.cleared === 0, 'and the "1" does not clear a layer');

  /* A custom name still needs a colour, and the same name must get the same
   * one every time — a section that changes colour on re-render is worse than
   * no colour at all. */
  const colours = await js(win, `
    const T = window.Presenter.__test;
    return {
      communion1: T.groupColor('Communion'),
      communion2: T.groupColor('Communion'),
      response: T.groupColor('Response'),
      verse4: T.groupColor('Verse 4'),
      verse1: T.groupColor('Verse 1'),
      chorus2: T.groupColor('Chorus 2'),
      chorus: T.groupColor('Chorus'),
      pre: T.groupColor('Pre-Chorus 2'),
      stage: T.groupColor('Stage notes'),
      tag: T.groupColor('Tag'),
    };`);
  log(colours.communion1 === colours.communion2, 'a custom name gets a stable colour', colours.communion1);
  log(colours.communion1 !== colours.response, 'and different names get different ones',
    `${colours.communion1} vs ${colours.response}`);
  log(colours.verse4 === colours.verse1, '"Verse 4" keeps the verse blue', colours.verse4);
  log(colours.chorus2 === colours.chorus, '"Chorus 2" keeps the chorus red', colours.chorus2);
  log(colours.pre !== colours.chorus, 'and "Pre-Chorus 2" is not swallowed by "Chorus"', colours.pre);
  log(colours.stage !== colours.tag, '"Stage notes" is not read as "Tag" — whole words only',
    `${colours.stage} vs tag ${colours.tag}`);

  /* ---------------- [3] playlists ---------------- */
  console.log('\n[3] Adding and renaming playlists');
  const before = await js(win, `return window.Presenter.__test.playlistDom();`);
  log(before.rows.length === 1 && /Sunday/i.test(before.rows[0]),
    'starts on the one seeded playlist', before.rows.join(' | '));

  const made = await js(win, `return window.Presenter.__test.newPlaylist('Christmas Eve');`);
  log(made.opened === true, '＋ New playlist opens a dialog (it used to die on prompt())');
  log(made.playlists && made.playlists.includes('Christmas Eve'),
    'and a second playlist actually exists afterwards', (made.playlists || []).join(' | '));

  const plRenamed = await js(win, `
    const T = window.Presenter.__test;
    T.renamePlaylist(0, 'Morning Service');
    return T.playlists().map(p => p.name);`);
  log(plRenamed.includes('Morning Service'),
    '"This Sunday" is not locked — double-click renames it', (plRenamed || []).join(' | '));

  /* ---------------- [4] one entry, one name ---------------- */
  console.log('\n[4] The same song twice in one service');
  const dup = await js(win, `
    const T = window.Presenter.__test;
    T.selectPlaylist(0);
    T.addOpenDocToPlaylist();
    T.addOpenDocToPlaylist();
    const two = T.playlistDom().items;
    T.renamePlaylistItem(0, 'Opening');
    return { two, after: T.playlistDom().items, names: T.playlists()[0].items };`);
  log(dup.two.length === 2 && dup.two[0] === dup.two[1],
    'the same song added twice shows the same name in both rows', dup.two.join(' | '));
  log(dup.after[0] === 'Opening' && dup.after[1] !== 'Opening',
    'renaming the FIRST entry leaves the second one alone', dup.after.join(' | '));
  log(dup.names && dup.names[0] === 'Opening' && !dup.names[1],
    'the name is stored on the entry, not on the song', JSON.stringify(dup.names));

  const songSafe = await js(win, `
    const T = window.Presenter.__test;
    return { docName: T.state().docId ? T.docName() : null, items: T.playlistDom().items };`);
  log(songSafe.docName === 'Test song',
    'and the song in the Library still has its own name', String(songSafe.docName));

  /* ---------------- [5] Show / Edit ---------------- */
  console.log('\n[5] The Edit button');
  const modes = await js(win, `return window.Presenter.__test.modeLabels();`);
  log(Array.isArray(modes) && modes.length === 0, 'the Show/Edit pair is off the toolbar',
    (modes || []).join(' | ') || '(none)');

  const trip = await js(win, `return window.Presenter.__test.editRoundTrip(0);`);
  log(trip.during === 'edit', 'a double-click still opens the editor', JSON.stringify(trip));
  log(trip.edited === true, 'and typing in it still changes the slide');
  log(trip.after === 'show',
    'but the studio is back in Show the moment you finish — no mode to get stuck in', trip.after);

  const cues = await js(win, `
    const T = window.Presenter.__test;
    const r = T.clickSlide(0);
    return { live: T.state().liveIx };`);
  log(cues.live === 0, 'so the very next click puts a slide on the screen', JSON.stringify(cues));

  /* An operator who opens a section rename, changes their mind and goes
   * straight to editing a slide must not end up in Edit with no editor open —
   * that is the stuck mode this round is supposed to have removed, arriving by
   * a different door. */
  const interleaved = await js(win, `
    const T = window.Presenter.__test;
    const opened = T.openRenameAndLeave(0);
    const trip = T.editRoundTrip(0);
    const click = T.clickSlide(1);
    return { opened, trip, mode: T.state().mode, live: T.state().liveIx };`);
  log(interleaved.opened === true, 'a rename box left open on a section bar', JSON.stringify(interleaved.opened));
  log(interleaved.trip && interleaved.trip.edited === true,
    'editing a slide still works with that box open', JSON.stringify(interleaved.trip));
  log(interleaved.mode === 'show' && interleaved.live === 1,
    'and the studio is still cueing afterwards — no stuck Edit by the back door',
    `mode ${interleaved.mode}, live ${interleaved.live}`);

  /* ---------------- [6] the music glyphs ---------------- */
  console.log('\n[6] Where the chord buttons went');
  const musicClosed = await js(win, `
    const T = window.Presenter.__test;
    T.clearMore(false);
    return T.musicPanel();`);
  log(musicClosed.inDocHead === false, 'the glyphs are out of the document header');
  log(musicClosed.exists === true, 'there is a 🎵 Music panel');
  log(musicClosed.hidden === true, 'hidden while ⋯ More is closed, like Easy view');

  const musicOpen = await js(win, `
    const T = window.Presenter.__test;
    T.clearMore(true);
    return T.musicPanel();`);
  log(musicOpen.hidden === false, '⋯ More reveals it');
  log(musicOpen.buttons.length === 4, 'holding all four controls', musicOpen.buttons.join(' | '));
  log(musicOpen.buttons.every((b) => /[a-z]{3}/i.test(b)),
    'and every one of them is a word now, not a bare glyph', musicOpen.buttons.join(' | '));
  log(/Test song/.test(String(musicOpen.key)),
    'with the song it will act on named at the top', String(musicOpen.key));

  /* nothing above may have thrown in the page */
  log(pageErrors.length === 0, 'and the page logged no errors through all of that',
    pageErrors.slice(0, 3).join(' | ') || 'clean');

  const shot = path.join(process.env.MW_SAMPLE_DIR || WORK, 'present-desk.png');
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    win.webContents.invalidate();
    const buf = (await win.webContents.capturePage()).toPNG();
    if (buf && buf.length > 8000) { fs.writeFileSync(shot, buf); console.log('    screenshot -> ' + shot); break; }
  }

  console.log('\n============  DESK TIDY ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
