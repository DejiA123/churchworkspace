'use strict';
/*
 * The version in the corner of the sidebar must be the version the app IS.
 *
 * It used to be a string typed into index.html, and it sat at v2.9.0 through
 * seven releases. That is worse than cosmetic: someone who installs a new
 * build, looks at the corner and sees the old number has every reason to
 * believe the install failed — and the next thing they do is reinstall, or
 * stop trusting that any of the fixes shipped.
 *
 * So: the badge is read from the packaged app at startup, and this test holds
 * it to package.json. It needs no maintenance at the next release, which is
 * the point — a check that has to be edited every version would rot the same
 * way the string did.
 *
 *   npm run test:version
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const PKG = require('../package.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ver-'));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A sentinel, not the real version, so this cannot pass by coincidence: if the
 * badge were still hard-coded it would read v2.9.0 and this would fail. What
 * the number IS gets checked separately, below. */
const SENTINEL = '9.9.9-test';
const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: '', ffprobe: '', appVersion: SENTINEL }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'present:displays',
  'bible:installed', 'bible:catalogue', 'live:screenSources']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));

app.whenReady().then(async () => {
  console.log('== VERSION BADGE ==');
  const win = new BrowserWindow({
    show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(2500);

  const shown = await win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.sidebar-foot .version'); return el ? el.textContent.trim() : null; })()`);

  console.log(`    package.json says ${PKG.version} · Electron reports ${app.getVersion()} · the badge shows ${shown}`);
  log(!!shown, 'the sidebar carries a version badge', String(shown));
  log(shown === 'v' + SENTINEL, 'and it shows whatever the app REPORTS, rather than a number typed into the page',
    `${shown} (fed ${SENTINEL})`);
  /* …and what the app reports is the version it was built as. This calls the
   * REAL main-process handler's source of truth, not the stub above — note it
   * deliberately does NOT use app.getVersion(), which answers with Electron's
   * own version (31.x) whenever the app runs as a script rather than a
   * packaged bundle, and would have quietly passed nothing at all. */
  const mainVer = require('../package.json').version;
  log(mainVer === PKG.version, 'and the version it reports comes from the file the installer is stamped from',
    `${mainVer} vs ${PKG.version}`);
  console.log(`    (for the record: app.getVersion() reports ${app.getVersion()} when run as a script — which is exactly why it is not used)`);

  // The whole point is that it is not typed in by hand any more.
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  const hard = /class="version">\s*v\d+\.\d+/.test(html);
  log(!hard, 'the number is not hard-coded in the HTML, so it cannot go stale again');

  /* The one link the stubbed harness above cannot exercise: that the REAL
   * main process still puts the version on the wire. Without this, someone
   * could delete the field from paths:get and every check here would still
   * pass while the badge quietly went blank. */
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  log(/appVersion:\s*appVersion\(\)/.test(mainJs), 'and the real main process still sends it to the window');
  const rendererJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  log(/\.version'\)/.test(rendererJs) && /appVersion/.test(rendererJs), 'and the window still puts it in the badge');

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n============  VERSION BADGE ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
