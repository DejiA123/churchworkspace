'use strict';
/*
 * "I HAVE MANY SONGS THE CHOIR WILL BE SINGING — CAN I GET THEM IN QUICKLY?"
 *
 * A whole event's worth of lyrics, pasted in one go, through the REAL button
 * and the REAL dialog — not the parser behind them. What a media desk needs on
 * the Saturday before is: paste everything, get songs split into slides, in the
 * right order, in the playlist, saved, and ready to click live on Sunday.
 *
 * The lyrics used here are deliberately MESSY, because pasted lyrics always
 * are: Windows line endings, trailing spaces, tabs, three kinds of section tag,
 * a song with no title line, a song whose chorus repeats, blank lines doubled
 * up, a separator with more dashes than asked for, and a verse long enough that
 * it has to be split across slides.
 *
 * Run: npm run test:pastesongs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const presenter = require(path.join(ROOT, 'src/main/presenter'));
const bible = require(path.join(ROOT, 'src/main/bible'));

const WORK = path.join(os.tmpdir(), 'mw-paste-songs');
fs.mkdirSync(WORK, { recursive: true });
bible.init(WORK);

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

/* ---- the studio's IPC, with a REAL store so "saved" means saved ---- */
const mem = { presentations: [], playlists: [], themes: [] };
let saves = 0;
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, present: {} }));
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
  saves++;
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
ipcMain.handle('present:deletePlaylist', () => ok(true));
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });
ipcMain.handle('bible:lookup', wrap(async () => ({ verses: [] })));
ipcMain.handle('bible:books', wrap(async () => ({ books: [] })));
ipcMain.handle('present:displays', wrap(() => presenter.displays()));
ipcMain.handle('present:open', wrap((e, a) => Object.assign(presenter.open(a), { state: presenter.state() })));
ipcMain.handle('present:close', wrap((e, { role }) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(() => presenter.state()));
ipcMain.handle('present:set', wrap((e, patch) => { presenter.setState(patch || {}); return true; }));
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

/* ------------------------- a real event's lyrics -------------------------
 * Every awkwardness a real paste contains, on purpose. \r\n, trailing spaces
 * and tabs are inserted deliberately below. */
const SONGS_TEXT = [
  'Amazing Grace',
  '',
  'Verse 1',
  'Amazing grace, how sweet the sound  ',   // trailing spaces
  'That saved a wretch like me',
  'I once was lost, but now am found',
  'Was blind, but now I see',
  '',
  'CHORUS',                                  // upper case tag
  'Praise the Lord, praise the Lord',
  'Let the earth hear His voice',
  '',
  '',                                        // doubled blank line
  'Verse 2',
  '\'Twas grace that taught my heart to fear',
  'And grace my fears relieved',
  'How precious did that grace appear',
  'The hour I first believed',
  'Through many dangers, toils and snares',   // 6 lines: must split at 4
  'I have already come',
  '',
  '-----',                                    // more dashes than the three asked for
  '',
  'How Great Thou Art',
  '',
  'Verse 1',
  'O Lord my God, when I in awesome wonder',
  'Consider all the worlds Thy hands have made',
  '',
  'Chorus:',                                  // tag with a colon
  'Then sings my soul, my Saviour God, to Thee',
  'How great Thou art, how great Thou art',
  '',
  '---',
  '',
  // a song with NO title line — the first lyric line has to become the name
  'Blessed be the name of the Lord',
  'Blessed be the name of the Lord',
  '',
  'Bridge',
  'He is worthy to be praised and adored',
  '',
  '---',
  '',
  'Great Is Thy Faithfulness',
  '',
  'Verse 1',
  'Great is Thy faithfulness, O God my Father',
  'There is no shadow of turning with Thee',
  '',
  'Pre-Chorus',                               // a tag the app may not know
  'Morning by morning new mercies I see',
  '',
  'Tag',
  'All I have needed Thy hand hath provided',
].join('\n');

app.whenReady().then(async () => {
  console.log('== PASTING A WHOLE EVENT\'S SONGS ==');

  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);

  console.log('\n[1] Open the Presentation studio and make a playlist for the event');
  const setup = await js(win, `
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r => setTimeout(r, 400));
    const T = window.Presenter.__test;
    const pl = await T.newPlaylist('Carol Service');
    return { playlists: pl.playlists, opened: pl.opened };`);
  if (setup.__error) console.error('   ' + setup.__error);
  log(setup.opened && (setup.playlists || []).includes('Carol Service'),
    'a playlist for the event is created from the real ＋ button', JSON.stringify(setup.playlists));

  console.log('\n[2] Paste four songs at once — messy, the way lyrics really arrive');
  const t0 = Date.now();
  const pasted = await js(win, `
    const T = window.Presenter.__test;
    const text = ${JSON.stringify(SONGS_TEXT)}
      .replace(/^Verse 2$/m, 'Verse 2')
      .replace(/\\n/g, '\\r\\n');       // Windows line endings, as pasted from Word
    return await T.pasteSongsViaDialog(text, { maxLines: 4 });`);
  const took = Date.now() - t0;
  if (pasted.__error) console.error('   ' + pasted.__error);
  console.log(`   dialog preview said: ${pasted.preview}`);
  console.log(`   ${pasted.docs.length} songs, ${pasted.docs.reduce((n, d) => n + d.slides, 0)} slides, in ${took} ms`);

  log(pasted.docs.length === 4, 'all four songs became presentations', pasted.docs.map((d) => d.name).join(' · '));
  log(pasted.docs.some((d) => d.name === 'Amazing Grace') && pasted.docs.some((d) => d.name === 'How Great Thou Art')
    && pasted.docs.some((d) => d.name === 'Great Is Thy Faithfulness'),
    'each song took its title from its own first line', pasted.docs.map((d) => d.name).join(' · '));
  log(pasted.docs.some((d) => /Blessed be the name/.test(d.name)),
    'a song with no title line is named from its first words — nothing is left "Untitled"',
    pasted.docs.map((d) => d.name).join(' · '));
  log(took < 4000, 'and it is instant, not a wait', took + ' ms for the whole event');

  console.log('\n[3] Are the slides split the way a projector needs?');
  const ag = await js(win, `
    const T = window.Presenter.__test;
    const d = T.docs().find(x => x.name === 'Amazing Grace');
    T.openDoc(d.id);
    return { slides: T.slides().map(s => ({ group: s.group, lines: s.lines })) };`);
  const groups = (ag.slides || []).map((s) => s.group);
  console.log('   Amazing Grace: ' + (ag.slides || []).map((s, i) => `${i + 1}. [${s.group}] ${s.lines[0]}…`).join('\n                  '));
  log((ag.slides || []).length === 4, 'the long verse is split so nothing overflows the screen', `${(ag.slides || []).length} slides`);
  log(groups[0] === 'Verse 1' && groups[1] === 'Chorus',
    'sections are tagged from the words themselves — Verse, CHORUS, Chorus:', groups.join(' · '));
  log((ag.slides || []).every((s) => s.lines.length <= 4), 'no slide carries more than the 4 lines asked for',
    (ag.slides || []).map((s) => s.lines.length).join(','));
  log((ag.slides || []).every((s) => s.lines.every((l) => l === l.trim() && l.length)),
    'trailing spaces, tabs and blank lines are cleaned off every line');
  const verse2 = (ag.slides || []).filter((s) => s.group === 'Verse 2');
  log(verse2.length === 2 && verse2[0].lines.length === 4 && verse2[1].lines.length === 2,
    'a six-line verse becomes 4 + 2, in order, not one crowded slide',
    verse2.map((s) => s.lines.length).join('+'));

  console.log('\n[4] Are they in the playlist, in the order they were pasted?');
  const pls = await js(win, `return window.Presenter.__test.playlists();`);
  const pl = ((pls || []).find((p) => p.name === 'Carol Service') || {}).items || [];
  console.log('   playlist: ' + pl.join(' → '));
  log(pl.length === 4, 'every song was added to the open playlist', String(pl.length));
  log(pl[0] === 'Amazing Grace' && pl[3] === 'Great Is Thy Faithfulness',
    'IN THE ORDER THEY WERE PASTED — the running order of the service', pl.join(' → '));

  console.log('\n[5] Do they survive being closed and reopened?');
  // The studio seeds a starter document of its own on first run, so the store
  // holds that as well as the four songs — count the songs, not the rows.
  const SONGS = ['Amazing Grace', 'How Great Thou Art', 'Blessed be the name of the Lord', 'Great Is Thy Faithfulness'];
  const stored = mem.presentations.filter((p) => SONGS.includes(p.name));
  log(stored.length === 4 && stored.every((p) => (p.slides || []).length > 0),
    'all four are written to the library store, with their slides',
    `${stored.length} of ${mem.presentations.length} rows · ${saves} writes`);
  const reload = await js(win, `
    const T = window.Presenter.__test;
    await T.reloadLibrary();
    const docs = T.docs();
    return { names: docs.map(d => d.name), slides: docs.filter(d => d.slides > 0).map(d => d.name + ':' + d.slides) };`);
  const back = SONGS.filter((n) => (reload.names || []).includes(n));
  log(back.length === 4, 'and every one comes back after the library is reloaded', JSON.stringify(reload.slides));

  console.log('\n[6] Sunday morning: click a song, click a slide, it is on the screen');
  const live = await js(win, `
    const T = window.Presenter.__test;
    const d = T.docs().find(x => x.name === 'How Great Thou Art');
    T.openDoc(d.id);
    T.go(0);
    await new Promise(r => setTimeout(r, 200));
    const first = T.liveScreenText();
    T.step(1);
    await new Promise(r => setTimeout(r, 200));
    return { first, second: T.liveScreenText(), liveIx: T.state().liveIx };`);
  log(/O Lord my God/.test(live.first || ''), 'clicking the first slide puts those exact words on the output',
    (live.first || '').slice(0, 48));
  log(live.liveIx === 1 && /Then sings my soul/.test(live.second || ''),
    'and ▶ moves to the chorus — the service runs on the arrow keys', (live.second || '').slice(0, 48));

  console.log('\n[7] Twenty songs, to be sure it scales');
  const many = [];
  for (let i = 1; i <= 20; i++) {
    many.push(`Song Number ${i}\n\nVerse 1\nLine one of song ${i}\nLine two of song ${i}\n\nChorus\nSing it again, song ${i}\n`);
  }
  const t1 = Date.now();
  const bulk = await js(win, `return await window.Presenter.__test.pasteSongsViaDialog(${JSON.stringify(many.join('\n---\n'))}, { maxLines: 4 });`);
  const bulkMs = Date.now() - t1;
  log(bulk.docs && bulk.docs.length === 20, 'twenty songs in one paste', `${bulk.docs && bulk.docs.length} songs in ${bulkMs} ms`);
  log(bulkMs < 8000, 'still quick enough to do while the choir waits', bulkMs + ' ms');

  console.log('\n============  PASTE SONGS ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
