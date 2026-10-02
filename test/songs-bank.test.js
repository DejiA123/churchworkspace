'use strict';
/*
 * "CAN THERE BE A SONGS BANK IN THE PRESENTATION PAGE, WHERE COMMON CHRISTIAN
 *  CONTEMPORARY SONGS ARE STORED WHICH WOULD BE EASY TO ADD TO FUTURE
 *  PLAYLISTS — AND I SHOULD ALSO BE ABLE TO ADD SONGS IN THE SONGS BANK."
 *
 * The Library is what is in THIS service. The bank is what the church SINGS,
 * and before this there was no such thing: every Sunday the same fifteen songs
 * were pasted again, or hunted for among four hundred old services.
 *
 * The catalogue ships with the app. The WORDS do not, and that is deliberate
 * rather than missing: worship lyrics are precisely what a church's CCLI
 * licence covers, and an app has no business handing out its own copy of them.
 * So this test proves the loop that makes the bank the CHURCH'S:
 *
 *   [1] the catalogue is really there, searchable, and filtered by what a
 *       service is planned by (Praise · Communion · Christmas · Ours…);
 *   [2] one press puts a song into this Sunday — with the right sections even
 *       before it has words — and pressing it again reuses that song instead of
 *       making a second copy of it;
 *   [3] words typed once go INTO the bank, and the next service gets them
 *       without anybody retyping anything. This is the whole feature;
 *   [4] a Library that already has the church's arrangements pours into the
 *       bank by title, so day one is not an empty shelf.
 *
 *   npx electron test/songs-bank.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const presenter = require('../src/main/presenter');
const songbank = require('../src/main/songbank');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bank-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ------------------------------ studio stubs ------------------------------ */
let store = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'live:screenSources', 'bible:installed', 'bible:catalogue', 'bible:books']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('present:library', () => ok(store));
ipcMain.handle('present:savePresentation', wrap((e, { presentation }) => {
  const at = store.presentations.findIndex((p) => p.id === presentation.id);
  if (at >= 0) store.presentations[at] = presentation; else store.presentations.push(presentation);
  return presentation;
}));
ipcMain.handle('present:deletePresentation', wrap(() => true));
ipcMain.handle('present:savePlaylist', wrap((e, { playlist }) => {
  const at = store.playlists.findIndex((p) => p.id === playlist.id);
  if (at >= 0) store.playlists[at] = playlist; else store.playlists.push(playlist);
  return playlist;
}));
ipcMain.handle('present:deletePlaylist', wrap(() => true));
ipcMain.handle('present:saveThemes', wrap((e, { themes }) => { store.themes = themes; return themes; }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));
ipcMain.handle('live:destinations', () => ok({ qualities: [], groups: [], audio: [] }));
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async () => ({})));
ipcMain.handle('present:close', wrap(async () => presenter.state()));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async () => true));

/* the REAL bank, wired exactly as src/main/main.js wires it */
ipcMain.handle('songbank:list', wrap(async () => ({ songs: songbank.list(), themes: songbank.THEMES })));
ipcMain.handle('songbank:save', wrap(async (e, { song }) => { songbank.save(song); return songbank.list(); }));
ipcMain.handle('songbank:remove', wrap(async (e, { id }) => songbank.remove(id)));
ipcMain.handle('songbank:merge', wrap(async (e, { songs }) => ({ result: songbank.merge(songs), songs: songbank.list() })));

app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';
const die = (r) => { if (r && r.__error) { console.error(r.__error); app.exit(1); throw new Error('stop'); } return r; };

app.whenReady().then(async () => {
  console.log('== A SONGS BANK IN THE PRESENTATION PAGE ==');
  songbank.init(tmp);

  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  die(await js(win, `document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise((r) => setTimeout(r, 400)); return true;`));

  /* ==================== [1] the bank is there and searchable ============== */
  console.log('\n[1] The bank, and finding a song in it');
  const opened = die(await js(win, `return await ${T}.openBank();`));
  log(opened > 60, 'the bank opens with a catalogue already in it', opened + ' songs');

  const rows = die(await js(win, `return ${T}.bankRows();`));
  console.log('   first rows: ' + rows.slice(0, 3).map((r) => r.title + ' (' + r.meta + ')').join(' · '));
  log(rows.length > 0 && rows.every((r) => r.title), 'every row is a named song');
  log(rows.some((r) => /\d{4}/.test(r.meta)), 'credited to whoever wrote it, and dated', rows[0].meta);

  const found = die(await js(win, `return ${T}.bankSearch('way maker');`));
  const wayMaker = die(await js(win, `return ${T}.bankRows();`));
  log(found >= 1 && wayMaker.some((r) => /Way Maker/i.test(r.title)),
    'searching finds a contemporary song by title', wayMaker.map((r) => r.title).join(', '));
  const bySinger = die(await js(win, `${T}.bankSearch(''); return ${T}.bankSearch('sinach');`));
  log(bySinger >= 1, 'and by who wrote it', bySinger + ' by Sinach');

  const chips = die(await js(win, `${T}.bankSearch(''); return ${T}.bankChips();`));
  const chipIds = chips.map((c) => c.id);
  console.log('   filters: ' + chipIds.join(' · '));
  log(chipIds.includes('Christmas') && chipIds.includes('Communion') && chipIds.includes('Praise'),
    'and it filters by what a service is actually planned by', chipIds.slice(0, 8).join(', '));
  const xmas = die(await js(win, `return ${T}.bankPickChip('Christmas');`));
  const xmasRows = die(await js(win, `return ${T}.bankRows();`));
  log(xmas > 0 && xmasRows.every((r) => r.title), 'picking Christmas narrows it to the Christmas songs',
    xmasRows.slice(0, 4).map((r) => r.title).join(', '));

  /* ============ [2] one press puts a song into this Sunday =============== */
  console.log('\n[2] Putting a song into this service');
  die(await js(win, `${T}.bankPickChip('all'); return ${T}.bankSearch('way maker');`));
  const id = (die(await js(win, `return ${T}.bankRows();`)).find((r) => /^Way Maker$/i.test(r.title)) || {}).id;
  log(!!id, 'the song can be picked out', id);

  const added = die(await js(win, `return await ${T}.bankAddToService(${JSON.stringify(id)});`));
  log(added.service.includes('Way Maker'), 'ONE PRESS PUTS IT IN THIS SUNDAY', JSON.stringify(added.service));
  log(added.library.includes('Way Maker'), 'and in the Library, so it can be edited');
  log(added.openDoc === 'Way Maker', 'and opens it, ready for the words', added.openDoc);
  log(added.groups.join(',') === 'Verse 1,Chorus,Verse 2,Chorus,Bridge,Chorus',
    'with the sections it is actually sung in, before a word is typed', added.groups.join(' · '));

  const again = die(await js(win, `return await ${T}.bankAddToService(${JSON.stringify(id)});`));
  const copies = again.library.filter((n) => n === 'Way Maker').length;
  log(copies === 1, 'pressing it a second time reuses that song rather than making a duplicate', copies + ' copy');
  const marked = die(await js(win, `return ${T}.bankRows();`)).find((r) => r.id === id);
  log(marked && marked.inService, 'and the row shows it is already in this service');

  /* ============== [3] words typed once are kept — the point ============== */
  console.log('\n[3] Typing the words once');
  const banked = die(await js(win, `return await ${T}.bankOpenSong('Verse 1\\nour first line here\\nour second line here\\n\\nChorus\\nthe chorus we sing');`));
  log(banked.ready.includes('Way Maker'), 'THE WORDS ARE IN THE BANK NOW', JSON.stringify(banked.ready));
  log(!!banked.bankId, 'and the song in the Library knows which bank song it is', banked.bankId);

  const kept = die(await js(win, `return ${T}.bankWordsOf(${JSON.stringify(id)});`));
  log(/our first line here/.test(kept) && /Chorus/.test(kept),
    'kept in the same format the paste box reads, sections and all', JSON.stringify(kept));

  const rowNow = die(await js(win, `${T}.bankSearch('way maker'); return ${T}.bankRows();`)).find((r) => r.id === id);
  log(rowNow && rowNow.ready, 'the row says it is ready to use');

  // Now the thing that was impossible before: NEXT Sunday.
  const next = die(await js(win, `
    const T = ${T};
    // a brand new service, and the song deleted out of the library entirely
    await T.newPlaylist('Next Sunday');
    T.delDoc(T.docIdByName('Way Maker'));
    await T.openBank();
    T.bankSearch('way maker');
    return await T.bankAddToService(${JSON.stringify(id)});
  `));
  log(next.service.includes('Way Maker'), 'NEXT SUNDAY it is one press again', JSON.stringify(next.service));
  log(next.slides === 2, 'and it arrives WITH the words — nobody retyped anything', next.slides + ' slides');
  const words = die(await js(win, `return ${T}.songWordsOfOpen();`));
  log(/our first line here/.test(words) && /the chorus we sing/.test(words),
    'the church’s own arrangement, exactly as it was typed', JSON.stringify(words));

  /* ============ [4] a Library that already exists pours in =============== */
  console.log('\n[4] The songs the church already had');
  const merged = die(await js(win, `
    const T = ${T};
    // two songs typed the old way: one the catalogue lists, one entirely theirs
    const a = T.newDoc('goodness of god'); T.setSlideText(0, 'our arrangement of it');
    const b = T.newDoc('Owner Of My Life'); T.setSlideText(0, 'a song only we sing');
    const r = await T.bankMerge();
    await T.openBank();
    return { r, rows: T.bankRows().length };
  `));
  log(merged.r && merged.r.filled >= 1, 'their words land IN the catalogue entry, not beside it',
    JSON.stringify(merged.r));
  log(merged.r && merged.r.added === 1, 'and a song only they sing is added to the bank — the welcome deck is not a song',
    'added ' + merged.r.added);

  const goodness = die(await js(win, `${T}.bankSearch('goodness of god'); return ${T}.bankRows();`));
  const oneOnly = goodness.filter((r) => /goodness of god/i.test(r.title));
  log(oneOnly.length === 1, 'ONE "Goodness Of God" — matched despite being typed in lower case', oneOnly.length + ' row');
  log(oneOnly[0] && oneOnly[0].ready && /Bethel/.test(oneOnly[0].meta),
    'with their words in it, still credited to whoever wrote it', oneOnly[0] && oneOnly[0].meta);

  const own = die(await js(win, `${T}.bankSearch('owner of my life'); return ${T}.bankRows();`));
  log(own.length === 1 && own[0].ready, 'and their own song is in the bank too, ready to use', own[0] && own[0].title);
  const mineChip = die(await js(win, `${T}.bankSearch(''); return ${T}.bankPickChip('mine');`));
  log(mineChip >= 2, '"Ours" shows the songs the church put in', mineChip + ' songs');

  /* The bank survives the app being shut.
   *
   * Flush FIRST: writes are debounced (400 ms) so that banking twenty songs in
   * a loop is one disk write rather than twenty, which means reading the file
   * straight after a save is a race — it passed for a week and then reported
   * "1 saved" on a slower run. This is exactly what the app does on the way
   * out, so it is also the honest thing to test. */
  songbank.flushSync();
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'song-bank.json'), 'utf8'));
  log((onDisk.songs || []).length >= 3, 'and all of it is on disk, so next Sunday it is still there',
    (onDisk.songs || []).length + ' saved');
  log(onDisk.songs.every((s) => !s.words || typeof s.words === 'string'), 'with the words the church typed, and only those');

  console.log('\n' + (failed ? '  SOME CHECKS FAILED' : '  ALL CHECKS PASSED'));
  try { songbank.flushSync(); } catch (e) {}
  await sleep(300);
  app.exit(failed ? 1 : 0);
}).catch((e) => { if (e.message !== 'stop') { console.error(e); app.exit(1); } });
