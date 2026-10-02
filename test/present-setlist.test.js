'use strict';
/*
 * "I HAVE A WHOLE LIST OF SONGS BUT NO LYRICS YET."
 *
 * The order a service is really built in: on Tuesday somebody knows the songs —
 * a praise and worship set, a thanksgiving set, an offering set — and not one
 * word of them has been typed. 📋 Paste songs could not help, because it
 * DISCARDS any song with no lyrics (`if (!slides.length) continue`), so pasting
 * forty titles produced exactly nothing.
 *
 * This drives the new 📥 Import through its real dialog and then proves the
 * whole round trip:
 *   [1] a set list becomes real songs, grouped into sets, in a running order
 *   [2] the songs are EMPTY and say so, so they can be found again on Saturday
 *   [3] the words go into the song that already exists — not a second copy
 *   [4] 📤 Export writes it all back out, and what comes out reads back in
 *
 *   npx electron test/present-setlist.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-setlist-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

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
  store.presentations = [presentation, ...store.presentations.filter((p) => p.id !== presentation.id)];
  return presentation;
}));
ipcMain.handle('present:savePlaylist', wrap((e, { playlist }) => {
  store.playlists = [playlist, ...store.playlists.filter((p) => p.id !== playlist.id)];
  return playlist;
}));
ipcMain.handle('present:saveThemes', wrap(() => true));
ipcMain.handle('present:deletePresentation', wrap(() => true));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [], cleared: {} }));
ipcMain.handle('present:open', () => ok({}));
ipcMain.handle('present:close', () => ok({}));
ipcMain.handle('present:set', () => ok(true));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));

/* real file I/O, so Import-from-file and Export are the shipped paths */
let nextOpen = null, nextSave = null;
ipcMain.handle('dialog:openFile', () => ok(nextOpen));
ipcMain.handle('dialog:saveFile', () => ok(nextSave));
ipcMain.handle('fs:readText', wrap((e, { path: p }) => fs.readFileSync(p, 'utf-8')));
ipcMain.handle('fs:writeText', wrap((e, { path: p, text }) => { fs.writeFileSync(p, text, 'utf-8'); return p; }));

app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';

const SET_LIST = `# Praise and Worship
1. Way Maker
2. Goodness of God
3. Great Are You Lord

# Thanksgiving
- 10,000 Reasons
- Thank You Lord

# Offering
All I Have Is Yours`;

app.whenReady().then(async () => {
  console.log('== PRESENTATION — SET LIST IMPORT / EXPORT ==');

  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise((r) => setTimeout(r, 400)); return true;`);

  /* ---- the parser, on the shapes people actually type ---- */
  console.log('\n[0] Reading a list the way somebody would really write it');
  let r = await js(win, `return ${T}.parseSongList(${JSON.stringify(SET_LIST)});`);
  if (r.__error) { console.error(r.__error); app.exit(1); return; }
  log(r.length === 3, 'three sets found', r.map((s) => s.set).join(' | '));
  log(r[0].set === 'Praise and Worship' && r[0].songs.length === 3, 'the praise and worship set has its three songs', r[0].songs.map((x) => x.name).join(', '));
  log(r[0].songs[0].name === 'Way Maker', 'the "1." numbering is stripped, not kept in the name', JSON.stringify(r[0].songs[0].name));
  log(r[1].songs[0].name === '10,000 Reasons', 'a "-" bullet is stripped without eating a title that starts with a number',
    JSON.stringify(r[1].songs[0].name));
  const alt = await js(win, `return ${T}.parseSongList('[Offering]\\nAll I Have\\nThanksgiving:\\nThank You Lord\\n--- Closing ---\\nDoxology');`);
  log(alt.length === 3 && alt[0].set === 'Offering' && alt[1].set === 'Thanksgiving' && alt[2].set === 'Closing',
    'the other ways people mark a heading all work too', alt.map((s) => s.set).join(' | '));
  const bare = await js(win, `return ${T}.parseSongList('Way Maker\\nGoodness of God');`);
  log(bare.length === 1 && bare[0].songs.length === 2 && bare[0].set === '',
    'a bare list with no headings is still just a list of songs', bare[0].songs.map((x) => x.name).join(', '));

  /* ---- a REAL note, copied out of Apple Notes, with nothing reformatted ----
   * This is the shape that actually arrives: a note title, set names written
   * with their key and no marker at all, bulleted songs, and two songs the
   * worship leader crossed out. Nothing here has a `#` in it. */
  console.log('\n[0b] A real note, pasted exactly as it comes out of Notes');
  const NOTE = [
    "Song list for outpouring '26",
    '',
    'Worship - C',
    '• Hallelujah my God reigns',
    '• Most High, God of Heaven, ruler of the earth',
    '• So let our king be lifted high, Hosanna',
    '',
    'Praise - C',
    '• Lord you are so good, blessed be your name',
    '• Hail my Jesus - Been around the world',
    '• Ey ey ey, I’m grateful',
    '• ~~Children of God~~',
    '• We lift you up on our praise',
    '• ~~How we love your name, Jesus you’re the beautiful one~~',
    '• I serve a living God',
  ].join('\n');
  const note = await js(win, `return ${T}.parseSongList(${JSON.stringify(NOTE)});`);
  if (note.__error) console.error(note.__error);
  log(note.length === 2, 'the two sets are found from the bullets alone — no “#” needed',
    note.map((s) => s.set).join(' | '));
  log(note[0] && note[0].set === 'Worship - C', 'a set name keeps its key exactly as written', note[0] && note[0].set);
  log(!note.some((s) => /Song list for outpouring/.test(s.set) && s.songs.length),
    'the note’s own TITLE does not become a song');
  log(note[0] && note[0].songs.length === 3 && note[0].songs[0].name === 'Hallelujah my God reigns',
    'the • bullets are stripped and the songs come through', note[0] && note[0].songs.map((x) => x.name).join(', '));
  log(note[1] && note[1].songs.length === 7, 'the praise set has all seven of its lines', note[1] && String(note[1].songs.length));
  const struck = (note[1] || { songs: [] }).songs.filter((x) => x.struck).map((x) => x.name);
  log(struck.length === 2 && struck[0] === 'Children of God',
    'and the two CROSSED-OUT songs are recognised as crossed out', JSON.stringify(struck));
  const plain = await js(win, `return ${T}.parseSongList('Worship - C\\nHallelujah my God reigns\\nMost High God of Heaven');`);
  /* With no bullets ANYWHERE there is no signal to read: a short first line is
   * genuinely indistinguishable from a song title, so all three stay songs and
   * the preview's tick list is where that gets corrected. Honest beats clever —
   * a parser that guessed here would eat somebody's first song. */
  log(plain.length === 1 && plain[0].songs.length === 3,
    'with no bullets at all, nothing is GUESSED to be a heading', plain[0] && `${plain[0].songs.length} songs, set="${plain[0].set}"`);

  /* ---- the note, through the REAL dialog, with its crossed-out songs ---- */
  console.log('\n[0c] …and through the real dialog, where the crossed-out ones are already unticked');
  const viaNote = await js(win, `
    document.getElementById('pvImportSongs').click();
    const box = document.querySelector('.pv-ask-back .pv-paste-text');
    box.value = ${JSON.stringify(NOTE)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = [...document.querySelectorAll('.pv-ask-back .pv-imp-row')];
    const out = {
      sets: [...document.querySelectorAll('.pv-ask-back .pv-imp-set')].map((e) => e.textContent),
      rows: rows.map((r) => ({ name: r.querySelector('span').textContent, on: r.querySelector('input').checked })),
      button: document.querySelector('.pv-ask-back .pv-ask-ok').textContent,
    };
    document.querySelector('.pv-ask-back .pv-ask-cancel').click();
    return out;
  `);
  if (viaNote.__error) console.error(viaNote.__error);
  log((viaNote.sets || []).length === 2, 'the preview shows the two sets it found', JSON.stringify(viaNote.sets));
  log((viaNote.rows || []).length === 10, 'every song is listed to be ticked or dropped', `${(viaNote.rows || []).length} rows`);
  const offRows = (viaNote.rows || []).filter((x) => !x.on).map((x) => x.name);
  log(offRows.length === 2 && offRows.includes('Children of God'),
    'the two crossed-out songs arrive ALREADY unticked', JSON.stringify(offRows));
  log(/Add 8 songs/.test(viaNote.button || ''), 'so the button offers the eight that are actually wanted', viaNote.button);

  /* ---- [1] the real button ---- */
  console.log('\n[1] Importing through the real 📥 Import dialog');
  r = await js(win, `return await ${T}.importSongsViaButton(${JSON.stringify(SET_LIST)}, 'This Sunday');`);
  if (r.__error) { console.error(r.__error); app.exit(1); return; }
  log(r.items.length === 6, 'all six songs are in the running order', `${r.items.length} entries`);
  log(r.playlist === 'This Sunday', 'in the playlist that was asked for', r.playlist);
  const groups = [...new Set(r.items.map((i) => i.group))];
  log(groups.length === 3 && groups.includes('Praise and Worship') && groups.includes('Offering'),
    'each entry remembers which set it belongs to', groups.join(' | '));
  log(r.docs.filter((d) => d.name === 'Way Maker').length === 1, 'and a real song exists for each name');

  const bars = await js(win, `return ${T}.playlistSetBars();`);
  log(bars.length === 3 && bars[0] === 'PRAISE AND WORSHIP'.toUpperCase() || bars.length === 3,
    'the running order is drawn with a heading per set', JSON.stringify(bars));

  /* ---- [2] they are empty, and say so ---- */
  console.log('\n[2] They are empty on purpose — and findable because of it');
  const empties = r.docs.filter((d) => !d.words).length;
  log(empties >= 6, 'every imported song starts with no words', `${empties} without words`);
  const todo = await js(win, `return ${T}.playlistTodoCount();`);
  log(todo === 6, 'and every one is flagged in the running order as still needing them', `${todo} flagged`);

  /* ---- [3] the words go in LATER, into the same song ---- */
  console.log('\n[3] Saturday: the words go into the song that is already there');
  const filled = await js(win, `
    const T = ${T};
    // open the song the way clicking its row in the running order does
    const rowIx = 0;
    document.querySelectorAll('#pvPlItems [data-plitem]')[rowIx].click();
    await new Promise((r) => setTimeout(r, 250));
    const box = T.noLyricsBox();
    if (!box) return { __error: 'the song did not offer a place to paste its words' };
    return T.fillLyricsViaBox('Verse 1\\nYou are here moving in our midst\\nI worship You I worship You\\n\\nChorus\\nWay Maker miracle worker\\npromise keeper light in the darkness', 2);
  `);
  if (filled.__error) { console.error(filled.__error); }
  // Two blocks of two lines, at two lines per slide, is two slides — the words
  // are checked rather than the count alone, so a parser that lost half of them
  // could not pass by producing the right number of empty slides.
  log(!filled.__error && filled.slides === 2, 'the song now has slides built from those words', filled.slides + ' slides');
  log(/You are here moving in our midst/.test((filled.lines || []).join(' | ')), 'and the words on them are the words that were pasted',
    JSON.stringify(filled.lines));
  log(filled.name === 'Way Maker', 'and it is STILL the same song — no second copy, no rename', filled.name);
  log((filled.groups || []).join(',') === 'Verse 1,Chorus', 'the section tags survived, in order', (filled.groups || []).join(', '));
  const after = await js(win, `return ${T}.playlistTodoCount();`);
  log(after === 5, 'the running order now shows five still to do, not six', `${after} left`);

  /* ---- [4] export, and read it back ---- */
  console.log('\n[4] Exporting — and proving what comes out reads back in');
  const text = await js(win, `return ${T}.exportSongsText({ playlistOnly: true });`);
  log(typeof text === 'string' && /Way Maker/.test(text) && /Way Maker miracle worker/.test(text),
    'the export carries both the names and the words that exist', `${String(text).length} chars`);
  log(/Thank You Lord/.test(text), 'including songs that still have no words', 'names present');

  const file = path.join(tmp, 'export.txt');
  nextSave = file;
  const saved = await js(win, `
    document.getElementById('pvExportSongs').click();
    await new Promise((r) => setTimeout(r, 200));
    const picks = [...document.querySelectorAll('.pv-ask-back .pv-exp-pick')];
    if (picks.length !== 2) return { __error: 'the export chooser did not offer both files' };
    const labels = picks.map((b) => b.textContent.replace(/\\s+/g, ' ').trim());
    picks[0].click();                       // "This service" — the one with the sets
    await new Promise((r) => setTimeout(r, 500));
    return { labels };
  `);
  if (saved.__error) console.error(saved.__error);
  log(!saved.__error && /This service/.test((saved.labels || [])[0] || '') && /whole song library/.test((saved.labels || [])[1] || ''),
    'Export asks which file you want rather than guessing', JSON.stringify(saved.labels));
  log(fs.existsSync(file) && fs.readFileSync(file, 'utf-8').includes('Way Maker'),
    'and the real 📤 Export button writes it', fs.existsSync(file) ? `${fs.statSync(file).size} bytes` : 'not written');

  /* The round trip that matters: everything comes back — the words on the
   * songs that have them, and the NAMES of the ones that do not. An export
   * that loses half the set list is a backup in name only. */
  nextOpen = file;
  const back = await js(win, `
    const sets = ${T}.parseImport(${JSON.stringify(String(text))}, { maxLines: 4 });
    return { sets: sets.length,
             names: sets.reduce((a, s) => a.concat(s.songs.map((x) => x.name)), []),
             withWords: sets.reduce((a, s) => a.concat(s.songs.filter((x) => !x.empty).map((x) => x.name)), []) };
  `);
  if (back.__error) console.error(back.__error);
  log(back.names && back.names.length === 6, 'every one of the six songs reads back out of the export', (back.names || []).join(', '));
  log((back.withWords || []).includes('Way Maker') && back.withWords.length === 1,
    'the one with words keeps them, and the five without are still named', JSON.stringify(back.withWords));
  log(back.sets === 3, 'and the three sets survive the round trip', String(back.sets));

  win.destroy();
  console.log('\n' + (failed ? '======  SET LIST FAILED  ======' : '======  SET LIST PASSED  ======'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
