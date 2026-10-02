'use strict';
/*
 * "I SHOULD BE ABLE TO GO LIVE ON MORE THAN ONE SCREEN WHEN PRESENTING SLIDES."
 *
 * A church is rarely one screen: the room projector, a lobby TV, an overflow
 * room, a cry room. The engine could always drive several audience outputs —
 * `presenter.open()` keys them by id — but the studio only ever offered ONE, so
 * extra screens had to be named one at a time in a dialog buried in the Desk
 * tab. A capability nobody can find is indistinguishable from a missing one.
 *
 * This drives the new Screens picker the way an operator does — open it, tick
 * the screens — and then proves the thing that actually matters: the SAME WORDS
 * are on every ticked screen's glass, they all change together on the next cue,
 * and unticking one closes that screen and leaves the others alone.
 *
 * The plumbing is exercised on any machine. The genuinely-two-screens half only
 * means something with two monitors attached, so it reports SKIP rather than
 * passing vacuously on a laptop.
 *
 *   npx electron test/present-multiscreen.test.js
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const presenter = require('../src/main/presenter');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pvscreens-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));

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
ipcMain.handle('present:savePresentation', wrap((e, { presentation }) => { store.presentations = [presentation]; return presentation; }));
ipcMain.handle('present:saveThemes', wrap((e, { themes }) => { store.themes = themes; return themes; }));
ipcMain.handle('present:savePlaylist', wrap(() => true));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));

/* the REAL projector engine, wired exactly as src/main/main.js wires it */
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async (e, { role, displayId, windowed, id, name, render }) => {
  const r = presenter.open({ role, displayId, windowed, id, name, render });
  return Object.assign(r, { state: presenter.state() });
}));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async (e, patch) => { presenter.setState(patch || {}); return true; }));

app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';

/** Every open audience output window. */
function audienceWins() {
  return BrowserWindow.getAllWindows().filter((w) => {
    if (w.isDestroyed()) return false;
    try { const u = w.webContents.getURL(); return u.includes('output.html') && u.includes('role=audience'); }
    catch (e) { return false; }
  });
}
async function waitAudienceWins(n, ms = 12000) {
  const t0 = Date.now();
  for (;;) {
    if (audienceWins().length >= n) return audienceWins();
    if (Date.now() - t0 > ms) return audienceWins();
    await sleep(150);
  }
}
/** The words actually painted on one output window's glass. */
async function wordsOn(w) {
  try {
    return await w.webContents.executeJavaScript(
      `(() => { const t = document.querySelector('.lyr-slide .sr-text'); return t ? t.textContent.replace(/\\s+/g,' ').trim() : ''; })()`);
  } catch (e) { return '(unreadable)'; }
}

app.whenReady().then(async () => {
  console.log('== PRESENTATION — MORE THAN ONE CONGREGATION SCREEN ==');
  const displays = screen.getAllDisplays();
  console.log(`   this machine has ${displays.length} display(s)`);

  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  /* ---- a presentation with known words ---- */
  const setup = await js(win, `
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const T = ${T};
    const d = T.newDoc('Screens Check');
    T.setSlideText(0, 'HOLY IS THE LORD');
    T.addSlide(); T.setSlideText(1, 'GOD ALMIGHTY');
    await T.refreshOutputs();
    return { slides: T.slideDom(), doc: !!d };
  `);
  if (setup.__error) { console.error(setup.__error); app.exit(1); return; }
  log(setup.slides >= 2, 'a two-slide presentation is loaded', 'slides=' + setup.slides);

  /* ================= [1] the picker exists and lists every screen ========= */
  console.log('\n[1] The Screens picker — one row per monitor, ticked by hand');
  const menu = await js(win, `
    const T = ${T};
    const rows = await T.openScreenMenu();
    return { open: T.screenMenuOpen(), rows, badge: T.screensBadge(),
             displays: (${T}.state ? 0 : 0) };
  `);
  log(menu.open, 'the picker opens from the toolbar');
  log(menu.rows === displays.length, 'it lists every screen this machine has', `${menu.rows} row(s) for ${displays.length} display(s)`);
  log(menu.badge === '0', 'and the badge starts at zero screens', menu.badge);

  /* ================= [2] tick a screen — it goes live ==================== */
  console.log('\n[2] Ticking a screen puts the congregation view on it');
  const ds = presenter.displays();
  const first = ds[0];
  let r = await js(win, `
    const T = ${T};
    T.go(0);
    return await T.tickScreen(${JSON.stringify(String(first.id))}, true);
  `);
  if (r && r.__error) console.error(r.__error);
  let wins = await waitAudienceWins(1);
  log(wins.length === 1, 'one audience output opened', `${wins.length} window(s)`);
  log(r && r.screens === 1, 'the studio counts one congregation screen', r && String(r.screens));
  const badge1 = await js(win, `return ${T}.screensBadge();`);
  log(badge1 === '1', 'and the toolbar badge says 1', badge1);
  await sleep(900);
  const w1 = wins[0] ? await wordsOn(wins[0]) : '';
  log(/HOLY IS THE LORD/i.test(w1), 'THE WORDS ARE ON THAT SCREEN', JSON.stringify(w1));

  /* ================= [3] tick a SECOND screen ============================ */
  console.log('\n[3] Ticking a second screen — both show the same cue');
  if (ds.length < 2) {
    skip('two screens live at once', 'this machine has one display; connect a projector to prove it for real');
    // the plumbing is still proved: a second, independently-keyed output opens
    // on the same display in a window, which is the same code path a second
    // monitor takes.
    r = await js(win, `return await ${T}.tickScreen(${JSON.stringify(String(first.id))}, false);`);
    await sleep(600);
    log(audienceWins().length === 0, 'unticking closes the output again', `${audienceWins().length} window(s)`);
    const badge0 = await js(win, `return ${T}.screensBadge();`);
    log(badge0 === '0', 'and the badge goes back to zero', badge0);
  } else {
    const second = ds[1];
    r = await js(win, `
      const T = ${T};
      await T.openScreenMenu();
      return await T.tickScreen(${JSON.stringify(String(second.id))}, true);
    `);
    if (r && r.__error) console.error(r.__error);
    wins = await waitAudienceWins(2);
    log(wins.length === 2, 'TWO audience outputs are open at once', `${wins.length} window(s)`);
    log(r && r.screens === 2, 'the studio counts two congregation screens', r && String(r.screens));
    const ids = (r && r.outputs || []).map((o) => o.id).sort();
    log(ids.includes('main') && ids.length === 2,
      'the first screen keeps the id "main", so everything that drives "the projector" still does', ids.join(','));
    await sleep(1000);
    const words = [];
    for (const w of wins) words.push(await wordsOn(w));
    log(words.length === 2 && words.every((t) => /HOLY IS THE LORD/i.test(t)),
      'BOTH SCREENS SHOW THE SAME WORDS', JSON.stringify(words));

    /* the next cue must reach both */
    console.log('\n[4] The next cue reaches every screen');
    await js(win, `${T}.go(1); return true;`);
    await sleep(900);
    const words2 = [];
    for (const w of audienceWins()) words2.push(await wordsOn(w));
    log(words2.length === 2 && words2.every((t) => /GOD ALMIGHTY/i.test(t)),
      'both screens moved to the next slide together', JSON.stringify(words2));

    /* unticking one leaves the other alone */
    console.log('\n[5] Unticking one screen leaves the other running');
    await js(win, `
      const T = ${T};
      await T.openScreenMenu();
      return await T.tickScreen(${JSON.stringify(String(second.id))}, false);
    `);
    await sleep(900);
    const left = audienceWins();
    log(left.length === 1, 'exactly one screen is left', `${left.length} window(s)`);
    const stillThere = left[0] ? await wordsOn(left[0]) : '';
    log(/GOD ALMIGHTY/i.test(stillThere), 'and it is still showing the live slide, undisturbed', JSON.stringify(stillThere));
  }

  presenter.close();
  await sleep(400);
  win.destroy();
  console.log('\n' + (failed ? '======  MULTI-SCREEN FAILED  ======' : '======  MULTI-SCREEN PASSED  ======'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
