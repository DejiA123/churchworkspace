'use strict';
/*
 * Two things about the Settings page, held in place by measurement.
 *
 * 1. A long church name used to walk straight out of the sidebar and print
 *    itself across the Settings heading. The cause was a flex item that will
 *    not shrink below its content: `.brand-name` was `white-space: nowrap`
 *    inside a flex child with the default `min-width: auto`, so the text simply
 *    made the box wider than the rail. This test feeds a genuinely long name
 *    and measures the painted box against the sidebar — a check on the CSS
 *    rule alone would pass the day someone re-adds `nowrap` somewhere else.
 *
 * 2. The API.Bible key section is gone. The Presentation studio downloads its
 *    translations without a key, so the field asked for something nobody needs.
 *    Removing a field is the easy half; the half that bites is the save path,
 *    which read `#setBibleKey` — with the input gone it must NOT write an empty
 *    string over a key an earlier build stored.
 *
 *   npm run test:settingsui
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-setui-'));
/* Own profile, or this test reads the developer's real localStorage — the
 * first run did exactly that, inherited "sidebar collapsed", and measured a
 * 0×0 brand name that satisfied every bound in this file. */
app.setPath('userData', path.join(tmp, 'userData'));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LONG_NAME = process.env.MW_TEST_NAME || 'THE POWER HOUSE INTERNATIONAL MINISTRIES WORLDWIDE';
const OLD_KEY = 'bible-key-from-an-older-build';

const ok = (data) => ({ ok: true, data });
let savedPatch = null;
ipcMain.handle('settings:get', () => ok({
  brand: { churchName: LONG_NAME, primaryColor: '#1f6feb', accentColor: '#f5a623' },
  accounts: {}, apiKeys: { bible: OLD_KEY },
}));
const allPatches = [];
// preload sends { patch } — not the patch itself.
ipcMain.handle('settings:update', (_e, arg) => {
  savedPatch = (arg && arg.patch) || arg;
  allPatches.push(savedPatch);
  return ok(savedPatch);
});
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: '', ffprobe: '', appVersion: '9.9.9-test' }));
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
  console.log('== SETTINGS UI ==');
  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) errs.push(msg); });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(2500);

  // Open Settings, exactly as clicking the rail does.
  await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('.nav-item[data-view="settings"]');
    if (b) b.click();
    return true;
  })()`);
  await sleep(400);

  /* The rail must be EXPANDED for the next block to mean anything: collapsed,
   * the name is display:none and every bound below is trivially satisfied. */
  const railW = await win.webContents.executeJavaScript(
    `Math.round(document.getElementById('sidebar').getBoundingClientRect().width)`);
  log(railW > 200, 'the sidebar is expanded, so the measurements below are real', `${railW}px wide`);

  /* ---------- 1. the name stays inside the rail ---------- */
  const m = await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('brandName');
    const rail = document.getElementById('sidebar');
    const r = el.getBoundingClientRect(), s = rail.getBoundingClientRect();
    const cs = getComputedStyle(rail);
    return {
      text: el.textContent, title: el.getAttribute('title'),
      nameRight: Math.round(r.right), nameLeft: Math.round(r.left), nameH: Math.round(r.height),
      railRight: Math.round(s.right), padRight: parseFloat(cs.paddingRight),
      spill: Math.round(el.scrollWidth - el.clientWidth),
      docScroll: Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth),
      /* Where the GLYPHS actually reach. The element's own rect is useless
       * here: a block box is capped at its parent's width, so an overflowing
       * nowrap name reports a tidy in-bounds rect while its text prints across
       * the page — which is precisely the bug. A Range over the text node
       * measures the laid-out text itself. */
      inkRight: (() => { const rg = document.createRange(); rg.selectNodeContents(el); return Math.round(rg.getBoundingClientRect().right); })(),
    };
  })()`);

  console.log(`    name "${m.text}"`);
  console.log(`    box ${m.nameLeft}→${m.nameRight}px · rail edge ${m.railRight}px (padding ${m.padRight}px) · height ${m.nameH}px`);
  log(m.text === LONG_NAME, 'the full church name is still the element text (nothing was truncated in the data)');
  log(m.nameRight <= m.railRight - m.padRight + 1, 'the painted name stops inside the sidebar',
    `${m.nameRight} <= ${m.railRight - m.padRight}`);
  log(m.spill <= 1, 'and the text does not overflow its own box', `${m.spill}px of overflow`);
  log(m.docScroll <= 0, 'so the page has no horizontal scroll', `${m.docScroll}px`);
  log(m.nameH <= 60, 'and it is clamped to at most two lines rather than growing forever', `${m.nameH}px tall`);
  log(m.title === LONG_NAME, 'hovering still reveals the whole name', String(m.title));
  log(m.inkRight <= m.railRight - m.padRight + 1, 'and the TEXT ITSELF never reaches the content area',
    `glyphs end at ${m.inkRight}px, rail text edge is ${m.railRight - m.padRight}px`);

  /* ---------- 2. the API.Bible section is gone ---------- */
  const bib = await win.webContents.executeJavaScript(`(() => {
    const view = document.getElementById('view-settings');
    return {
      field: !!document.getElementById('setBibleKey'),
      mentions: /API\\.Bible|Bible \\(Presentation\\)|scripture\\.api\\.bible/i.test(view.innerHTML),
      panels: view.querySelectorAll('.panel').length,
      saveBtn: !!document.getElementById('saveSettings'),
    };
  })()`);
  log(!bib.field, 'the API.Bible key input is gone');
  log(!bib.mentions, 'and no leftover API.Bible copy is on the page');
  log(bib.saveBtn, 'the Save settings button is still there', `${bib.panels} panels remain`);

  /* ---------- 3. saving does not wipe a key stored earlier ---------- */
  const clickErr = await win.webContents.executeJavaScript(`(() => {
    window.__mwErr = null;
    window.addEventListener('unhandledrejection', (e) => { window.__mwErr = String(e.reason && e.reason.stack || e.reason); });
    window.addEventListener('error', (e) => { window.__mwErr = String(e.message); });
    document.getElementById('saveSettings').click();
    return new Promise((r) => setTimeout(() => r(window.__mwErr), 800));
  })()`);
  await sleep(600);
  if (clickErr) console.log('    save handler threw: ' + clickErr);
  allPatches.forEach((p, i) => console.log(`    patch ${i}: keys = ${Object.keys(p || {}).join(', ')}`));
  const withKeys = allPatches.filter((p) => p && p.apiKeys);
  const sent = withKeys.length ? withKeys[withKeys.length - 1].apiKeys.bible : '<none>';
  log(!!savedPatch, 'saving settings still reaches the main process', `${allPatches.length} patch(es)`);
  log(withKeys.length > 0, 'and the Save button sends the apiKeys block', errs.length ? 'renderer errors: ' + errs.join(' | ') : '');
  log(sent === OLD_KEY, 'and a Bible key stored by an older build survives the save', String(sent));

  /* proof for the eye: the rail at the top, and the bottom of the page where
   * the Bible panel used to sit */
  const shoot = async (file) => {
    for (let i = 0; i < 8; i++) {
      await sleep(600);
      win.webContents.invalidate();
      const buf = (await win.webContents.capturePage()).toPNG();
      if (buf && buf.length > 8000) { fs.writeFileSync(file, buf); console.log('    screenshot -> ' + file); return; }
    }
    console.log('    (could not capture ' + file + ')');
  };
  const dir = process.env.MW_SAMPLE_DIR || tmp;
  await shoot(path.join(dir, 'settings-brand.png'));
  const scrolled = await win.webContents.executeJavaScript(`(() => {
    // Find whatever actually scrolls rather than guessing at a selector.
    let el = document.getElementById('saveSettings'), box = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
      if (n.scrollHeight > n.clientHeight + 4) { box = n; break; }
    }
    if (!box) return 'nothing scrolls';
    box.scrollTop = box.scrollHeight;
    return (box.id || box.className) + ' -> ' + Math.round(box.scrollTop) + '/' + box.scrollHeight;
  })()`);
  console.log('    scrolled: ' + scrolled);
  await shoot(path.join(dir, 'settings-bottom.png'));

  console.log('\n============  SETTINGS UI ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
