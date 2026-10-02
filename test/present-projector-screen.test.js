'use strict';
/*
 * "I PLUGGED AN HDMI CABLE FROM A PROJECTOR IN, BUT THE PROJECTOR WAS ONLY
 *  SHOWING MY MAIN SCREEN — THE SOFTWARE DID NOT NOTICE A SECOND SCREEN."
 *
 * Both halves of that sentence were true, and they are the same fact. Windows
 * puts a freshly-plugged projector in DUPLICATE by default: one desktop copied
 * onto two panels. That is literally why the projector showed the main screen,
 * and it is why there was no second screen to notice — Electron reports
 * desktops, and there was one. `display-added` does not even fire. Re-reading
 * getAllDisplays() forever would never have found the projector.
 *
 * So the studio now reads the CABLES (Windows' CCD API, src/main/screen-topology.js):
 *
 *   extended    2 active paths, 2 sources
 *   duplicate   2 active paths, ONE source     <- the reported fault
 *   idle        a target that is available but in no active path
 *
 * This test proves three separate things:
 *
 *   [1] the cable reading is REAL — it is run against this machine, agrees with
 *       what Electron reports, and is cheap enough to poll once a second.
 *   [2] a duplicated projector is described in words an operator can act on,
 *       and an idle one is told apart from it.
 *   [3] the studio, driven for real: the Screens button warns, the panel names
 *       the projector, and pressing the one fix button ENDS WITH THE SLIDES ON
 *       THAT SCREEN — not with a tick-box the operator still has to find.
 *
 * [3] runs against a stand-in OS (a second monitor cannot be soldered on from
 * a test), but every line of studio code between the button and the projector
 * window is the shipped one. [1] needs no stand-in and is the half that would
 * catch a wrong struct offset.
 *
 *   npx electron test/present-projector-screen.test.js
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const presenter = require('../src/main/presenter');
const topology = require('../src/main/screen-topology');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-projector-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const skip = (n, d) => console.log('  SKIP  ' + n + (d ? '  -> ' + d : ''));

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
ipcMain.handle('live:destinations', () => ok({ qualities: [], groups: [], audio: [] }));

/* ---------------------------- the stand-in OS -----------------------------
 * A laptop with a projector on the HDMI port that Windows is DUPLICATING: one
 * desktop, two panels. This is exactly the shape `presenter.state()` takes on
 * such a machine — the display list holds one entry and the cable reading says
 * why. Pressing the fix flips it to the extended shape, as Windows does.
 *
 * `realId` is which physical screen an output actually opens on, so the test
 * still gets a genuine projector window to read words off. */
let LAPTOP = null, PROJECTOR = null;
function buildFakeScreens() { // after app ready: `screen` does not exist before it
  const real = presenter.displays();
  LAPTOP = { id: 'fake-laptop', realId: String(real[0].id), label: 'Main screen — 1920×1080', width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, primary: true, internal: true, monitor: '', copiedTo: null };
  PROJECTOR = { id: 'fake-projector', realId: String((real[1] || real[0]).id), label: 'EPSON PJ — 1920×1080', width: 1920, height: 1080, x: 1920, y: 0, scaleFactor: 1, primary: false, internal: false, monitor: 'EPSON PJ', copiedTo: null };
}

let fakeOS = null;
function setDuplicating() {
  fakeOS = {
    displays: [Object.assign({}, LAPTOP, { copiedTo: ['this computer’s own screen', 'EPSON PJ'], copiedExtra: ['EPSON PJ'] })],
    suggested: 'fake-laptop',
    screens: topology.advice({
      supported: true, canExtend: true, idle: [],
      sources: [], duplicated: [{ key: 's0', targets: [
        { label: 'this computer’s own screen', name: '', internal: true, connector: 'built-in' },
        { label: 'EPSON PJ', name: 'EPSON PJ', internal: false, connector: 'HDMI' }] }],
    }),
  };
}
function setExtended() {
  fakeOS = {
    displays: [LAPTOP, PROJECTOR],
    suggested: 'fake-projector',
    screens: topology.advice({ supported: true, canExtend: true, idle: [], sources: [], duplicated: [] }),
  };
}
const fakeId = (id) => {
  const d = (fakeOS.displays || []).find((x) => String(x.id) === String(id));
  return d ? d.realId : REAL_MAIN;
};
/* Which stand-in screen each output was asked for. On a machine with one real
 * monitor both stand-in screens resolve to the same glass, so the real display
 * an output lands on cannot say which of them the studio chose — the request
 * can, and it is the request being tested. */
const requestedOn = new Map();

/** presenter.state(), with the stand-in OS's screens in place of this machine's. */
function fakeState() {
  const st = presenter.state();
  const back = (o) => requestedOn.get(o.id) || o.displayId;
  const outputs = (st.outputs || []).map((o) => Object.assign({}, o, { displayId: back(o) }));
  return Object.assign(st, {
    displays: fakeOS.displays, suggested: fakeOS.suggested, screens: fakeOS.screens,
    outputs,
    audienceDisplay: st.audienceDisplay ? (requestedOn.get('main') || st.audienceDisplay) : st.audienceDisplay,
    stageDisplay: st.stageDisplay ? (requestedOn.get('stage') || st.stageDisplay) : st.stageDisplay,
  });
}

const opened = [];       // every present:open the studio asked for
let extendCalls = 0;
ipcMain.handle('present:displays', wrap(async () => fakeOS.displays));
ipcMain.handle('present:open', wrap(async (e, { role, displayId, windowed, id, name, render }) => {
  opened.push({ role, displayId, windowed, id });
  const key = role === 'stage' ? 'stage' : (id || 'main');
  requestedOn.set(key, String(displayId));
  const r = presenter.open({ role, displayId: fakeId(displayId), windowed, id, name, render });
  return Object.assign(r, { state: fakeState() });
}));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); requestedOn.delete(role); return fakeState(); }));
ipcMain.handle('present:state', wrap(async () => fakeState()));
ipcMain.handle('present:set', wrap(async (e, patch) => { presenter.setState(patch || {}); return true; }));
// The real handler calls SetDisplayConfig; the stand-in does what Windows does.
ipcMain.handle('present:extendScreens', wrap(async () => { extendCalls++; setExtended(); return { ok: true, displays: fakeOS.displays }; }));

app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.Presenter.__test';

function audienceWins() {
  return BrowserWindow.getAllWindows().filter((w) => {
    if (w.isDestroyed()) return false;
    try { const u = w.webContents.getURL(); return u.includes('output.html') && u.includes('role=audience'); }
    catch (e) { return false; }
  });
}
async function wordsOn(w) {
  try {
    return await w.webContents.executeJavaScript(
      `(() => { const t = document.querySelector('.lyr-slide .sr-text'); return t ? t.textContent.replace(/\\s+/g,' ').trim() : ''; })()`);
  } catch (e) { return '(unreadable)'; }
}

app.whenReady().then(async () => {
  console.log('== A PROJECTOR THE MACHINE WAS MIRRORING INSTEAD OF EXTENDING ==');

  /* ============ [1] the cable reading, against THIS machine ============== */
  console.log('\n[1] Reading the real cables on this machine');
  const real = topology.read(true);
  if (!real.supported) {
    skip('the display topology API', real.error || (process.platform + ' has no reading here'));
  } else {
    const sources = real.sources || [];
    const targets = sources.reduce((n, s) => n + s.targets.length, 0);
    console.log(`   ${screen.getAllDisplays().length} desktop(s) from Electron; the cables say `
      + `${sources.length} source(s) driving ${targets} panel(s)`
      + (real.idle.length ? `, plus ${real.idle.length} connected and unused` : ''));
    for (const s of sources) console.log(`     ${s.gdi} ${s.width}x${s.height} @${s.x},${s.y} -> ` + s.targets.map((t) => t.label + ' (' + t.connector + ')').join(' + '));
    for (const i of real.idle) console.log(`     idle: ${i.label} (${i.connector})`);

    log(sources.length === screen.getAllDisplays().length,
      'the cable reading agrees with Electron about how many desktops exist',
      `${sources.length} source(s) vs ${screen.getAllDisplays().length} display(s)`);
    log(targets >= sources.length && sources.every((s) => s.targets.length >= 1),
      'every desktop is wired to at least one physical panel', `${targets} panel(s)`);
    log(sources.every((s) => s.width > 0 && s.height > 0),
      'each desktop reports a real pixel size (the struct offsets are right)',
      sources.map((s) => s.width + 'x' + s.height).join(', '));

    // The whole point of reading cables: mirroring is visible even though it
    // adds no display. On a laptop with nothing plugged in there is nothing to
    // report, and reporting something would be the worse bug.
    const adv = topology.advice();
    if (screen.getAllDisplays().length === 1 && targets === 1) {
      log(adv.state === 'ok', 'with one screen and nothing else plugged in it stays quiet — no false alarm', adv.state);
    } else {
      console.log('   verdict on this machine: ' + adv.state + (adv.headline ? ' — ' + adv.headline : ''));
      log(['ok', 'duplicating', 'idle'].includes(adv.state), 'it reaches a verdict about this machine', adv.state);
      if (adv.state === 'duplicating') log(true, 'REAL DUPLICATION DETECTED ON THIS MACHINE — the reported fault, reproduced', adv.headline);
    }

    // It is polled once a second on the thread that drives five studios.
    const t0 = Date.now();
    for (let i = 0; i < 200; i++) topology.signature(topology.read(true));
    const per = (Date.now() - t0) / 200;
    log(per < 2, 'cheap enough to poll every second', per.toFixed(3) + ' ms per reading');
  }

  /* ====== [2] the signature changes when a mirrored cable goes in ======== */
  console.log('\n[2] Plugging in a MIRRORED projector changes nothing Electron can see');
  const alone = { supported: true, sources: [{ gdi: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, targets: [{ id: 1, name: '' }] }], idle: [], duplicated: [] };
  const mirrored = { supported: true, canExtend: true, sources: [{ gdi: '\\\\.\\DISPLAY1', x: 0, y: 0, width: 1920, height: 1080, targets: [{ id: 1, name: '' }, { id: 2, name: 'EPSON PJ' }] }], idle: [], duplicated: [{ key: 's', targets: [{ label: 'this computer’s own screen', internal: true }, { label: 'EPSON PJ', name: 'EPSON PJ', internal: false }] }] };
  log(topology.signature(alone) !== topology.signature(mirrored),
    'but the cable signature DOES change, so the watchdog wakes the studio up',
    topology.signature(alone) + '  ≠  ' + topology.signature(mirrored));

  console.log('\n   the words the operator is given:');
  const dupAdvice = topology.advice(mirrored);
  console.log('     ' + dupAdvice.headline);
  console.log('     ' + dupAdvice.detail);
  console.log('     [' + dupAdvice.action + ']');
  log(dupAdvice.state === 'duplicating', 'a mirrored projector is called duplication, not "no screen"', dupAdvice.state);
  log(/EPSON PJ/.test(dupAdvice.headline), 'and it is named, so the operator knows which screen is meant');
  log(!/\b(topology|path|target|API|source)\b/i.test(dupAdvice.headline + dupAdvice.detail),
    'in words with no jargon in them');
  log(dupAdvice.canExtend === true, 'on Windows it can be fixed from here');

  const idleAdvice = topology.advice({ supported: true, canExtend: true, sources: [], duplicated: [], idle: [{ id: 9, label: 'BenQ MX550', name: 'BenQ MX550', connector: 'HDMI', internal: false }] });
  log(idleAdvice.state === 'idle', 'a screen being sent nothing is a different problem, and is told apart', idleAdvice.state);
  log(/BenQ MX550/.test(idleAdvice.headline), 'named too', idleAdvice.headline);
  const okAdvice = topology.advice({ supported: true, canExtend: true, sources: [], duplicated: [], idle: [] });
  log(okAdvice.state === 'ok', 'and a properly extended desk says nothing at all', okAdvice.state);

  /* ============ [3] the studio, driven as the operator drives it ========= */
  console.log('\n[3] The studio on a laptop whose projector is being duplicated');
  buildFakeScreens();
  setDuplicating();

  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  const setup = await js(win, `
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const T = ${T};
    T.newDoc('Projector Check');
    T.setSlideText(0, 'HOLY IS THE LORD');
    T.addSlide(); T.setSlideText(1, 'GOD ALMIGHTY');
    T.go(0);                       // a slide is live: the projector must show THESE words
    await T.refreshOutputs();
    return { slides: T.slideDom(), screens: T.screenLabels() };
  `);
  if (setup.__error) { console.error(setup.__error); app.exit(1); return; }
  log(setup.screens.length === 1, 'the screen list holds ONE entry — the projector is invisible to it', JSON.stringify(setup.screens));

  const warned = await js(win, `
    const T = ${T};
    await T.refreshOutputs();
    return { warns: T.screensButtonWarns(), advice: T.screenAdvice().state };
  `);
  log(warned.warns === true, 'the Screens button goes amber without anything being opened', 'warn=' + warned.warns);

  const banner = await js(win, `
    const T = ${T};
    await T.openScreenMenu();
    return { warning: T.screenWarning(), rows: T.screenRowNotes() };
  `);
  if (banner.__error) { console.error(banner.__error); app.exit(1); return; }
  const w = banner.warning || {};
  console.log('   the panel says:  ' + (w.headline || '(nothing)'));
  console.log('   with the button: [' + (w.fix || '(none)') + ']');
  log(!!banner.warning, 'the Screens panel explains itself instead of showing an empty list');
  log(/EPSON PJ/.test(w.headline || ''), 'it names the projector that is plugged in', w.headline);
  log(/COPY/i.test(w.headline || '') || /copying|duplicat/i.test(w.detail || ''),
    'and says the projector is showing a copy — the thing the operator actually saw');
  log(/Extend/i.test(w.fix || ''), 'there is one button, and it says what it does', w.fix);
  log((banner.rows || []).some((t) => /also copied onto/.test(t)),
    'the one screen row admits it is really two panels', JSON.stringify(banner.rows));

  if (process.env.MW_SHOT) { // MW_SHOT=1 to eyeball the panel rather than read about it
    const png = path.join(tmp, 'screens-panel.png');
    fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG());
    console.log('   screenshot: ' + png);
  }

  console.log('\n   pressing it:');
  opened.length = 0;
  const after = await js(win, `return await ${T}.pressExtend();`);
  if (after && after.__error) { console.error(after.__error); app.exit(1); return; }
  log(extendCalls === 1, 'the button asks the OS to extend the desktop, once', 'calls=' + extendCalls);
  log(after.displays === 2, 'a second screen exists afterwards', after.displays + ' screen(s)');
  log(after.screens === 1, 'AND THE SLIDES ARE ON IT — not left as a tick-box to find', after.screens + ' congregation screen(s)');
  const onProjector = (after.outputs || []).some((o) => String(o.displayId) === 'fake-projector');
  log(onProjector, 'on the PROJECTOR, not on the screen the operator is working on',
    JSON.stringify(after.outputs));
  log(opened.some((o) => String(o.displayId) === 'fake-projector' && o.role === 'audience' && !o.windowed),
    'opened full-screen there, as a congregation output must be', JSON.stringify(opened));

  await sleep(1200);
  const wins = audienceWins();
  const words = wins.length ? await wordsOn(wins[0]) : '';
  log(/HOLY IS THE LORD/i.test(words), 'THE WORDS ARE ON THE PROJECTOR GLASS', JSON.stringify(words));

  const cleared = await js(win, `
    const T = ${T};
    await T.openScreenMenu();
    return { warns: T.screensButtonWarns(), warning: T.screenWarning(), rows: T.screenRowNotes().length };
  `);
  log(cleared.warns === false && !cleared.warning, 'and the warning is gone, because the problem is', 'warn=' + cleared.warns);
  log(cleared.rows === 2, 'the picker now lists both screens', cleared.rows + ' row(s)');

  /* ====== [4] the news reaches an operator who is watching the slides ===== */
  console.log('\n[4] The moment the cable goes in, with nobody looking at the Screens panel');
  await js(win, `await window.api.present.close('main'); await ${T}.refreshOutputs(); return true;`);
  const push = async (state) => {                       // exactly what main.js's watchdog sends
    await js(win, `document.getElementById('toast').textContent = ''; return true;`);
    win.webContents.send('present:outputs', state);
    await sleep(500);
    return js(win, `return document.getElementById('toast').textContent;`);
  };
  setDuplicating(); await push(fakeState());            // prime: the first reading is not a change
  setExtended();
  const plugged = await push(fakeState());
  log(/EPSON PJ/.test(plugged) && /connect/i.test(plugged),
    'an EXTENDED projector announces itself by name, unprompted', JSON.stringify(plugged));
  setDuplicating();
  const copied = await push(fakeState());
  log(/EPSON PJ/.test(copied) && /COPY/i.test(copied),
    'and a DUPLICATED one — the reported fault — says so instead of staying silent', JSON.stringify(copied));
  log(/Screens/.test(copied), 'pointing at the button that fixes it');

  if (screen.getAllDisplays().length < 2) {
    skip('the same run against real glass', 'this machine has one monitor — plug the projector in and run again to watch [1] report it');
  }

  console.log('\n' + (failed ? '  SOME CHECKS FAILED' : '  ALL CHECKS PASSED'));
  try { presenter.shutdown(); } catch (e) {}
  await sleep(300);
  app.exit(failed ? 1 : 0);
});
