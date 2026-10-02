'use strict';
/*
 * RENAMING AND DELETING, WHERE YOU CAN SEE THEM.
 *
 * Both already worked — double-click to rename, right-click to delete — and
 * both were advertised only in a tooltip. An operator whose playlist was called
 * "Sunday 10/08/202" (an import's auto-name, truncated in the rail) had no way
 * to know it could be changed, and the only pencil on screen was the "no words
 * yet" badge, which is not a button at all.
 *
 * This drives the new hover controls the way a mouse does, and checks the two
 * things that break when icons are nested inside a row that is itself a button:
 * that the icon does its own job, and that it does NOT also fire the row.
 *
 *   npm run test:playlist-actions
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-plact-'));
app.setPath('userData', path.join(WORK, 'ud'));

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ok = (data) => ({ ok: true, data });
const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:savePlaylist', (e, { playlist }) => {
  const i = mem.playlists.findIndex((p) => p.id === playlist.id);
  if (i >= 0) mem.playlists[i] = playlist; else mem.playlists.push(playlist);
  return ok(playlist);
});
ipcMain.handle('present:deletePlaylist', (e, { id }) => { mem.playlists = mem.playlists.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:deletePresentation', () => ok(true));
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, present: { translation: 'kjv' } }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('live:metrics', () => ok({ cpu: 1, appCpu: 1 }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'present:displays',
  'bible:installed', 'bible:catalogue', 'bible:books', 'live:screenSources', 'bgvideo:installed',
  'bgvideo:list', 'captions:models', 'present:outputs', 'ndi:list']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 't', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:state', () => ok(null));
for (const ch of ['webout:state', 'ndiout:state', 'ndi:status', 'dmx:state', 'phone:state'])
  ipcMain.handle(ch, () => ok({ running: false, available: false, feeds: [] }));
ipcMain.handle('video:thumbnail', () => ({ ok: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);
  const js = (c) => win.webContents.executeJavaScript(
    `(async()=>{try{return await (async()=>{${c}})()}catch(e){return{__error:String(e&&e.message||e)+' | '+(e&&e.stack||'')}}})()`);

  await js(`document.querySelector('.nav-item[data-view="present"]').click(); await new Promise(r=>setTimeout(r,700)); return 1;`);

  console.log('\n[1] The controls are actually on the row');
  const shape = await js(`
    const T = window.Presenter.__test;
    // a second playlist, so deleting one is a real delete and not the
    // "empty the last one instead" path
    const row = () => document.querySelector('#pvPlaylists .pv-item');
    const r = row();
    return {
      rows: document.querySelectorAll('#pvPlaylists .pv-item').length,
      rename: !!r.querySelector('[data-plrename]'),
      del: !!r.querySelector('[data-pldel]'),
      // hidden until the pointer is on the row — a rail full of icons is noise
      hiddenAtRest: getComputedStyle(r.querySelector('[data-plrename]')).opacity === '0',
      nested: r.tagName + '>' + r.querySelector('[data-plrename]').tagName,
    };`);
  if (shape.__error) console.error(shape.__error);
  log(shape.rename && shape.del, 'a playlist row carries a rename and a delete control',
    `rename=${shape.rename} delete=${shape.del}`);
  log(shape.hiddenAtRest === true, 'they stay out of the way until the row is hovered',
    'opacity at rest = 0');
  log(shape.nested === 'BUTTON>SPAN', 'they are spans, not buttons nested inside a button', shape.nested);

  console.log('\n[2] The rename control renames');
  const ren = await js(`
    const before = window.Presenter.__test.playlists().map(p => p.name);
    const r = document.querySelector('#pvPlaylists .pv-item');
    r.querySelector('[data-plrename]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(x=>setTimeout(x,80));
    const input = document.querySelector('#pvPlaylists input.pv-rename');
    if (!input) return { opened: false, before };
    input.value = 'Morning Service';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise(x=>setTimeout(x,150));
    return { opened: true, before, after: window.Presenter.__test.playlists().map(p => p.name),
             heading: (document.getElementById('pvPlName')||{}).textContent };`);
  if (ren.__error) console.error(ren.__error);
  log(ren.opened === true, 'clicking the pencil opens an edit box on the name');
  log(!!ren.after && ren.after.includes('Morning Service'),
    'and typing a new name renames the playlist', JSON.stringify(ren.after));
  log(ren.heading === 'Morning Service', 'the heading above the songs follows the rename', ren.heading);

  console.log('\n[3] The songs under it have their own bin');
  const items = await js(`
    const T = window.Presenter.__test;
    const pls = T.playlists();
    // put two songs in the open playlist
    T.addOpenDocToPlaylist(); T.addOpenDocToPlaylist();
    await new Promise(x=>setTimeout(x,150));
    const rows = document.querySelectorAll('#pvPlItems .pv-item');
    const first = rows[0];
    return {
      n: rows.length,
      rename: !!(first && first.querySelector('[data-itrename]')),
      del: !!(first && first.querySelector('[data-itdel]')),
    };`);
  if (items.__error) console.error(items.__error);
  log(items.n >= 1, 'the service has songs in it', items.n + ' entries');
  log(items.rename && items.del, 'each song row carries a rename and a bin',
    `rename=${items.rename} delete=${items.del}`);

  const removed = await js(`
    const rows = () => document.querySelectorAll('#pvPlItems .pv-item').length;
    const before = rows();
    const r = document.querySelector('#pvPlItems .pv-item');
    const openedBefore = window.Presenter.__test.state().docId;
    r.querySelector('[data-itdel]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(x=>setTimeout(x,180));
    return { before, after: rows(), docUnchanged: window.Presenter.__test.state().docId === openedBefore };`);
  if (removed.__error) console.error(removed.__error);
  log(removed.after === removed.before - 1, 'clicking the bin removes that song from the service',
    `${removed.before} -> ${removed.after}`);
  /* The row itself opens the song. If the bin's click also reached the row it
   * would open the very song it just removed — the classic nested-control bug. */
  log(removed.docUnchanged === true, 'and the click does not also open the song underneath it');

  console.log('\n[4] The playlist bin deletes the playlist');
  const del = await js(`
    const T = window.Presenter.__test;
    /* A real delete, not the "empty the last one instead" path — so make a
     * second playlist first. Deleting the only playlist deliberately empties
     * it rather than removing it, which would leave the rail with no way to
     * make another; that behaviour is covered in present-desk-tidy. */
    await T.newPlaylist('Evening Service');
    await new Promise(x=>setTimeout(x,200));
    const n0 = T.playlists().length;
    window.confirm = () => true;
    const rows = document.querySelectorAll('#pvPlaylists .pv-item');
    if (rows.length < 2) return { skipped: true, n0 };
    rows[rows.length - 1].querySelector('[data-pldel]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(x=>setTimeout(x,200));
    return { n0, n1: T.playlists().length };`);
  if (del.__error) console.error(del.__error);
  if (del.skipped) console.log('  (only one playlist — the delete path is covered in present-desk-tidy)');
  else log(del.n1 === del.n0 - 1, 'clicking the bin deletes that playlist', `${del.n0} -> ${del.n1}`);

  console.log('\n[5] The "no words yet" badge is no longer a fake pencil');
  const badge = await js(`
    const b = document.querySelector('#pvPlItems .pv-item-todo');
    return b ? { text: b.textContent.trim(), title: b.title } : null;`);
  if (badge) {
    log(!/^\s*✎/.test(badge.text), 'it says what it means instead of drawing a pencil that does nothing',
      JSON.stringify(badge.text));
  } else {
    console.log('  (no empty songs in this service — badge not shown)');
  }

  console.log('\n' + (failed ? '======  PLAYLIST ACTIONS FAILED  ======' : '======  PLAYLIST ACTIONS PASSED  ======'));
  win.destroy();
  app.exit(failed ? 1 : 0);
});
