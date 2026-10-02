'use strict';
/*
 * REAL end-to-end test for the complaint:
 *
 *   "In the Presentation page the GO LIVE button is not working — the content is
 *    not projecting on the screen/projector."
 *
 * It was not a rendering fault. live() decided WHAT was on screen and pushed it
 * to every open output — but nothing ever opened an output. From the state every
 * service actually starts in (app open, no projector window yet) pressing Go Live
 * pushed a perfect cue to nobody, and said nothing about why the wall stayed
 * black. It also did literally nothing when no slide happened to be selected.
 *
 * Nothing here is faked: the projector is a REAL second BrowserWindow driven by
 * the REAL presenter module, the button is clicked for real in the real
 * index.html, and every "it's on the screen" claim is checked by reading the text
 * back OUT of the projector window.
 *
 *   npx electron test/golive.test.js
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const presenter = require(path.join(ROOT, 'src/main/presenter'));

const WORK = path.join(os.tmpdir(), 'mw-golive-test');
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
function log(okv, name, d) {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (d ? '  -> ' + d : ''));
  if (!okv) failed = true;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

/* ---- the minimum the studio boots against (no Bible download here) ---- */
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, present: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('dialog:openFile', () => ok(null));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));

const mem = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(mem));
ipcMain.handle('present:savePresentation', (e, { presentation }) => {
  const i = mem.presentations.findIndex((p) => p.id === presentation.id);
  if (i >= 0) mem.presentations[i] = presentation; else mem.presentations.unshift(presentation);
  return ok(presentation);
});
ipcMain.handle('present:deletePresentation', (e, { id }) => { mem.presentations = mem.presentations.filter((p) => p.id !== id); return ok(true); });
ipcMain.handle('present:savePlaylist', (e, { playlist }) => ok(playlist));
ipcMain.handle('present:deletePlaylist', () => ok(true));
ipcMain.handle('present:saveThemes', (e, { themes }) => { mem.themes = themes || []; return ok(mem.themes); });

/* the projector, driven by the module the app actually ships */
/* A church laptop has the projector on a SECOND screen; this dev box has one.
 * `fakeProjector` makes the studio see a second display so the two-screen branch
 * — the one every real service takes — can be checked. Opens are then recorded
 * rather than performed: the display does not exist, so actually creating the
 * window would put a fullscreen always-on-top panel on the tester's own screen. */
const FAKE = { id: '999999', label: 'Screen 2 — 1920×1080', width: 1920, height: 1080, x: 1536, y: 0, scaleFactor: 1, primary: false, internal: false };
let fakeProjector = false;
let opens = 0;                     // how many times a window was actually created
let lastOpen = null;               // …and with what
const withFake = (st) => (fakeProjector
  ? Object.assign({}, st, { displays: st.displays.concat([FAKE]), suggested: FAKE.id })
  : st);
ipcMain.handle('present:displays', wrap(() => withFake({ displays: presenter.displays() }).displays));
ipcMain.handle('present:open', wrap((e, a) => {
  opens++; lastOpen = a;
  if (fakeProjector) return { role: a.role, id: a.id || 'main', displayId: a.displayId, state: withFake(presenter.state()) };
  return Object.assign(presenter.open(a), { state: presenter.state() });
}));
ipcMain.handle('present:close', wrap((e, { role }) => { presenter.close(role); return withFake(presenter.state()); }));
ipcMain.handle('present:state', wrap(() => withFake(presenter.state())));
ipcMain.handle('present:set', wrap((e, patch) => { presenter.setState(patch || {}); return true; }));

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(() => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/* How many projector outputs exist, from the module that owns them. Counting by
 * URL instead would be a race: a window is real the instant it is constructed,
 * but webContents.getURL() stays empty until the load commits — which is not a
 * fixed number of milliseconds on a loaded machine. */
const audCount = () => presenter.state().outputs.filter((o) => o.role !== 'stage').length;
const audienceWins = () => BrowserWindow.getAllWindows().filter((w) => {
  if (w.isDestroyed()) return false;
  try { const u = w.webContents.getURL(); return u.includes('output.html') && u.includes('role=audience'); } catch (e) { return false; }
});
/** Poll until `fn()` is truthy (or give up) — for anything that waits on a load. */
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await fn(); } catch (e) { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(120);
  }
}
const waitAud = (n = 1) => waitFor(() => (audCount() === n ? n : null));
/** The words actually painted on the projector's glass. */
const glassText = () => waitFor(async () => {
  const w = audienceWins()[0];
  if (!w) return null;
  const t = await w.webContents.executeJavaScript(
    `(() => { const t = document.querySelector('.lyr-slide .sr-text'); return t ? t.textContent.replace(/\\s+/g,' ').trim() : null; })()`);
  return t || null;
});

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  // exactly as main.js does: the studio is told whenever an output opens or closes
  presenter.setNotifier((st) => {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('present:outputs', st);
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);

  console.log('\n[1] The state every service starts in: app open, nothing projecting');
  const cold = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-present').classList.add('active');
    window.Presenter.onShow();
    const T = window.Presenter.__test;
    T.resetShow();
    return window.api.present.close().then(async () => {
      await T.refreshOutputs();
      T.newDoc('Sunday', 'song');
      T.setSlideText(0, 'HOLY IS THE LORD');
      T.addSlide(); T.setSlideText(1, 'GOD ALMIGHTY');
      T.selectSlide(-1);                        // nothing picked: the old dead case
      return { hasOutput: T.hasAudienceOutput(), slideIx: T.state().slideIx, outState: (document.getElementById('pvOutState')||{}).textContent, button: T.goLiveButton() };
    });`);
  if (cold.__error) console.error('[1] ' + cold.__error);
  log(audCount() === 0 && cold.hasOutput === false, 'no projector output is open', `${audCount()} windows`);
  log(cold.slideIx === -1, 'and no slide is selected — where the button used to do nothing at all');
  log(/no output/i.test(cold.outState), 'the studio says so', cold.outState);
  log(/projector/i.test(cold.button.title), 'and the button explains what it will do', cold.button.title);

  console.log('\n[2] One press of the real Go Live button');
  const pressed = await js(win, `return window.Presenter.__test.clickGoLive();`);
  if (pressed.__error) console.error('[2] ' + pressed.__error);
  log(await waitAud(1) === 1, 'THE FIX: it opens the projector output itself', `${audCount()} audience output(s)`);
  log(pressed.hasOutput === true, 'and the studio knows the picture has somewhere to go');
  log(pressed.liveIx === 0, 'with nothing selected it starts at the first slide', 'liveIx=' + pressed.liveIx);
  const g1 = await glassText();
  log(g1 === 'HOLY IS THE LORD', 'THE WORDS ARE ON THE PROJECTOR', JSON.stringify(g1));
  const agree = await js(win, `return window.Presenter.__test.liveScreenText();`);
  log(String(agree).replace(/\s+/g, ' ').trim() === 'HOLY IS THE LORD', 'the operator\'s Live monitor agrees with the glass');
  const st1 = await js(win, `return (document.getElementById('pvOutState')||{}).textContent;`);
  log(/on screen/i.test(st1), 'and the indicator flips to "On screen"', st1);

  console.log('\n[3] Pressing it again cues — it does not stack up windows');
  const opensBefore = opens;
  const again = await js(win, `
    const T = window.Presenter.__test; T.selectSlide(1); return T.clickGoLive();`);
  await sleep(700);
  log(audCount() === 1 && opens === opensBefore, 'still exactly one projector, and no window was re-created', `${audCount()} output(s), ${opens - opensBefore} new opens`);
  log(again.liveIx === 1, 'the newly selected slide is cued', 'liveIx=' + again.liveIx);
  const g2 = await waitFor(async () => (await glassText()) === 'GOD ALMIGHTY');
  log(!!g2, 'and the projector really changed to it', JSON.stringify(await glassText()));

  console.log('\n[4] The operator closes the projector, then presses Go Live again');
  const before = await js(win, `return window.Presenter.__test.hasAudienceOutput();`);
  audienceWins().forEach((w) => w.destroy());
  await sleep(800);
  const afterClose = await js(win, `return { has: window.Presenter.__test.hasAudienceOutput(), state: (document.getElementById('pvOutState')||{}).textContent };`);
  log(before === true && afterClose.has === false && audCount() === 0,
    'closing it really deregisters it — no ghost output left behind', `hasOutput=${afterClose.has}, ${audCount()} output(s)`);
  const revived = await js(win, `return window.Presenter.__test.clickGoLive();`);
  log(await waitAud(1) === 1, 'and Go Live brings the projector straight back', `${audCount()} output(s), ${JSON.stringify(revived)}`);
  const g3 = await glassText();
  log(g3 === 'GOD ALMIGHTY', 'showing the cue that was live', JSON.stringify(g3));

  console.log('\n[5] Clicking a slide in Show mode is a cue too');
  await js(win, `return window.api.present.close().then(() => window.Presenter.__test.refreshOutputs());`);
  await sleep(600);
  const viaClick = await js(win, `
    const T = window.Presenter.__test;
    const had = T.hasAudienceOutput();
    T.setMode('show');
    T.clickSlide(0);
    return { had, liveIxNow: T.state().liveIx };`);
  log(viaClick.had === false, 'starting again with no output');
  log(viaClick.liveIxNow === 0, 'the click cues INSTANTLY — no waiting on a window to open first', 'liveIx=' + viaClick.liveIxNow);
  log(await waitAud(1) === 1, 'and the projector opens right behind it', `${audCount()} output(s)`);
  const g4 = await glassText();
  log(g4 === 'HOLY IS THE LORD', 'with the clicked slide on it', JSON.stringify(g4));

  console.log('\n[6] Arrowing on with no output open must not flash the projector');
  await js(win, `return window.api.present.close().then(() => window.Presenter.__test.refreshOutputs());`);
  await sleep(600);
  const opens6 = opens;
  await js(win, `
    const T = window.Presenter.__test;
    T.key('ArrowRight'); T.key('ArrowLeft'); T.key('ArrowRight');   // three cues in a row
    return true;`);
  await waitAud(1);
  await sleep(900);   // give any extra opens time to show up before counting
  log(audCount() === 1 && opens - opens6 === 1,
    'three quick cues open ONE projector, not three (re-opening flashes the room black)',
    `${audCount()} output(s), ${opens - opens6} open call(s)`);

  console.log('\n[7] A correct cue that would still show a black wall says why');
  const blk = await js(win, `
    const T = window.Presenter.__test; T.blackout(true);
    return T.clickGoLive().then(() => (document.getElementById('toast')||{}).textContent || '');`);
  await sleep(300);
  log(/blacked out/i.test(blk), 'blackout is called out rather than left to be hunted for', JSON.stringify(String(blk).slice(0, 60)));
  const clr = await js(win, `
    const T = window.Presenter.__test; T.blackout(false); T.clearLayer('slide');
    return T.clickGoLive().then(() => (document.getElementById('toast')||{}).textContent || '');`);
  await sleep(300);
  log(/words layer is cleared/i.test(clr), 'so is a cleared words layer', JSON.stringify(String(clr).slice(0, 60)));
  await js(win, `const T = window.Presenter.__test; T.clearLayer('slide'); T.blackout(false); return T.cleared();`);

  console.log('\n[8] Nothing to send: say so, do not open a black screen');
  const nothing = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.close().then(async () => {
      await T.refreshOutputs();
      T.newDoc('Empty', 'song'); T.clearSlides();
      const r = await T.clickGoLive();
      return { r, toast: (document.getElementById('toast')||{}).textContent || '', has: T.hasAudienceOutput() };
    });`);
  await sleep(600);
  log(nothing.has === false && audCount() === 0, 'an empty presentation does not open a blank projector', `${audCount()} window(s)`);
  log(/nothing to send/i.test(nothing.toast), 'it tells the operator what to do instead', JSON.stringify(nothing.toast.slice(0, 60)));

  console.log('\n[9] One screen only — the studio must not be buried under its own output');
  const oneScreen = screen.getAllDisplays().length === 1;
  if (!oneScreen) {
    console.log('  SKIP  this machine has ' + screen.getAllDisplays().length + ' displays');
  } else {
    await js(win, `
      const T = window.Presenter.__test;
      T.docs().filter(d => d.name === 'Sunday').forEach(d => T.openDoc(d.id));
      return T.clickGoLive();`);
    await waitAud(1);
    const outWin = await waitFor(() => audienceWins()[0] || null);
    log(!!outWin, 'the output opened');
    if (outWin) {
      log(outWin.isFullScreen() === false && outWin.isAlwaysOnTop() === false,
        'on a single screen it is a movable, closeable window — not an always-on-top fullscreen the operator cannot escape',
        `fullscreen=${outWin.isFullScreen()} alwaysOnTop=${outWin.isAlwaysOnTop()}`);
      log(outWin.isFocusable() === true, 'and it can be focused and closed');
    }
    const toast = await js(win, `return (document.getElementById('toast')||{}).textContent || '';`);
    log(/one screen/i.test(toast), 'with an explanation of why it is a window', JSON.stringify(String(toast).slice(0, 80)));
  }

  /* The setup every real service actually has: laptop + projector on HDMI. This
   * box has one screen, so the second display is injected and the OPEN is
   * recorded rather than performed — what is being checked is the decision:
   * fullscreen, on the projector, not on the operator's own screen. */
  console.log('\n[11] A church setup: laptop + projector on a second screen');
  await js(win, `return window.api.present.close().then(() => window.Presenter.__test.refreshOutputs());`);
  await sleep(500);
  fakeProjector = true;
  const primaryId = String(screen.getPrimaryDisplay().id);
  const two = await js(win, `
    const T = window.Presenter.__test;
    return T.refreshOutputs().then(async (o) => {
      T.docs().filter(d => d.name === 'Sunday').forEach(d => T.openDoc(d.id));
      T.selectSlide(0);
      const r = await T.clickGoLive();
      return { screens: (o.displays || []).length, r, toast: (document.getElementById('toast')||{}).textContent || '' };
    });`);
  if (two.__error) console.error('[11] ' + two.__error);
  log(two.screens === 2, 'the studio sees both screens', two.screens + ' displays');
  log(!!lastOpen && lastOpen.windowed === false,
    'with a projector attached the output goes FULLSCREEN, not into a window', 'windowed=' + (lastOpen && lastOpen.windowed));
  log(!!lastOpen && String(lastOpen.displayId) === FAKE.id && String(lastOpen.displayId) !== primaryId,
    'and onto the PROJECTOR, not the screen the operator is working on', `display ${lastOpen && lastOpen.displayId} (operator is on ${primaryId})`);
  log(!!lastOpen && lastOpen.role === 'audience' && (lastOpen.id || 'main') === 'main', 'as the main audience output');
  log(/live on/i.test(two.toast), 'and it names the screen it went to', JSON.stringify(String(two.toast).slice(0, 60)));

  // …but an explicit choice from the Screen dropdown is final. A church whose
  // projector IS the primary display must not have that quietly overridden.
  const picked = await js(win, `
    const T = window.Presenter.__test;
    return window.api.present.close().then(async () => {
      await T.refreshOutputs();
      const sel = document.getElementById('pvDisplay');
      sel.value = ${JSON.stringify(primaryId)};
      sel.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 200));
      return T.clickGoLive();
    });`);
  if (picked.__error) console.error('[11] ' + picked.__error);
  log(!!lastOpen && String(lastOpen.displayId) === primaryId,
    'and if the operator picks a screen by hand, that is the one used — no second-guessing',
    'display ' + (lastOpen && lastOpen.displayId));
  fakeProjector = false;

  console.log('\n[10] Console');
  log(errors.length === 0, 'no renderer errors', errors.slice(0, 3).join(' | ') || 'clean');

  console.log('\n============  GO LIVE test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  presenter.close();
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
