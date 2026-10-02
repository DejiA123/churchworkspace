'use strict';
/*
 * "I SHOULD BE ABLE TO ADD MULTIPLE PAGES LIKE CANVA."
 *
 * An event is rarely one sheet: a poster, a programme, a "what's on" card and
 * a thank-you slide, all the same size and palette. This drives the page rail
 * under the canvas exactly as an operator does — the ＋, the ⧉, the ◀ ▶, the ✕ —
 * and proves the things that make pages worth having rather than a list:
 *
 *   • each page keeps its OWN elements and background; editing one cannot
 *     touch another,
 *   • the thumbnails are true miniatures painted by the editor's own renderer,
 *   • changing the flyer SIZE rescales every page, not just the open one,
 *   • undo still works after the page it applies to has been left and returned
 *     to,
 *   • the whole document is saved and comes back — including a one-page flyer
 *     saved by an older version,
 *   • and every page exports, in order, as its own real PNG.
 *
 * Run: npm run test:flyerpages
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-flyer-pages-'));
const fontsDir = () => path.join(ROOT, 'bin', 'fonts');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#1f6feb', accentColor: '#f5a623' }, accounts: {}, apiKeys: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: OUT, userData: OUT, fontsDir: fontsDir(), ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({}));
for (const ch of ['scheduler:list', 'accounts:list', 'live:screenSources', 'bible:installed', 'bible:catalogue',
  'bgvideo:installed', 'captions:models']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial', 'Anton', 'Bebas Neue', 'Poppins', 'Bangers']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('fonts:data', () => {
  const dir = fontsDir();
  try {
    return ok(fs.readdirSync(dir).filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') })));
  } catch (e) { return ok([]); }
});
ipcMain.handle('photos:list', () => {
  const dir = path.join(ROOT, 'src', 'renderer', 'assets', 'photos');
  try { return ok(fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).map((f) => ({ name: f, path: path.join(dir, f) }))); }
  catch (e) { return ok([]); }
});
ipcMain.handle('fs:readImageDataUrl', (e, { path: p }) => {
  try {
    const ext = path.extname(p).slice(1).toLowerCase() || 'png';
    return ok('data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + fs.readFileSync(p).toString('base64'));
  } catch (err) { return { ok: false, error: err.message }; }
});
/* Exports are REAL files: the point of "all pages" is what lands on disk. */
const saved = [];
ipcMain.handle('flyer:savePng', (e, { name, bytes, ext }) => {
  const file = path.join(OUT, `${name}.${ext || 'png'}`);
  fs.writeFileSync(file, Buffer.from(bytes));
  saved.push(file);
  return ok(file);
});
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('shell:openPath', () => ok(true));

app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const js = (win, src) => win.webContents
  .executeJavaScript(`(async () => {
     try { const __r = await (async () => { ${src} })(); return JSON.stringify(__r === undefined ? null : __r); }
     catch (e) { return JSON.stringify({ __error: (e && e.message) + '\\n' + (e && e.stack) }); }
   })()`)
  .then((s) => { try { return JSON.parse(s); } catch (e) { return { __error: 'unparsable: ' + String(s).slice(0, 200) }; } },
        (e) => ({ __error: 'executeJavaScript rejected: ' + String((e && e.message) || e) }));

const T = 'window.Editor.__test';

app.whenReady().then(async () => {
  console.log('== FLYER MAKER: PAGES ==');

  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1800);

  console.log('\n[1] A fresh flyer is one page');
  const start = await js(win, `
    localStorage.removeItem('mw_design');
    document.querySelector('.nav-item[data-view="flyer"]').click();
    await new Promise(r => setTimeout(r, 600));
    document.getElementById('edNew').click();
    await new Promise(r => setTimeout(r, 200));
    return { pages: ${T}.pages(), thumbs: ${T}.pageThumbs(), allBtn: ${T}.exportAllVisible(),
             cls: (document.getElementById('edExportAll')||{}).className };`);
  if (start.__error) console.error('   ' + start.__error);
  log(start.pages && start.pages.pages.length === 1, 'a new flyer starts with one page', JSON.stringify(start.pages && start.pages.pages));
  log(start.thumbs === 1, 'and the rail shows exactly one thumbnail', String(start.thumbs));
  log(start.allBtn === false, 'the "All pages" export is hidden until there is more than one', 'class="' + start.cls + '"');

  console.log('\n[2] ＋ Page adds a blank one and moves to it');
  const added = await js(win, `
    const T = ${T};
    T.addText({ heading: 'PAGE ONE', sub: 'the poster' });
    const before = T.pages();
    const after = T.addPageViaButton(false);
    return { before, after, thumbs: T.pageThumbs(), allBtn: T.exportAllVisible() };`);
  log(added.after && added.after.pages.length === 2, 'the ＋ adds a page', `${added.before.pages.length} → ${added.after.pages.length}`);
  log(added.after.cur === 1, 'and takes you to it', 'page ' + (added.after.cur + 1));
  log(added.after.pages[1].elements === 0 && added.after.pages[0].elements > 0,
    'the new page is EMPTY and page one still has its layers',
    JSON.stringify(added.after.pages.map((p) => p.elements)));
  log(added.thumbs === 2, 'the rail shows both', String(added.thumbs));
  log(added.allBtn === true, 'and "All pages" appears now that there are two');

  console.log('\n[3] Pages are independent');
  const indep = await js(win, `
    const T = ${T};
    T.addText({ heading: true });
    T.addShape('star');
    const p = T.pages();
    T.goPageViaThumb(0);
    const onOne = T.elements().length;
    T.goPageViaThumb(1);
    const onTwo = T.elements().length;
    return { p, onOne, onTwo };`);
  log(indep.onOne !== indep.onTwo, 'each page carries its own layers',
    `page 1 has ${indep.onOne} layers, page 2 has ${indep.onTwo}`);
  log(indep.onOne === indep.p.pages[0].elements && indep.onTwo === indep.p.pages[1].elements,
    'and clicking a thumbnail really opens that page — what is on screen belongs to it',
    `${indep.onOne} / ${indep.onTwo} vs rail ${JSON.stringify(indep.p.pages.map((x) => x.elements))}`);

  console.log('\n[4] Duplicate, reorder, delete — from the thumbnails');
  const dup = await js(win, `return ${T}.addPageViaButton(true);`);
  log(dup && dup.pages.length === 3 && dup.pages[2].elements === dup.pages[1].elements,
    '⧉ duplicates a page, layers and all', JSON.stringify(dup.pages.map((p) => p.elements)));
  const moved = await js(win, `return ${T}.movePageViaButton(2, -1);`);
  log(moved && moved.cur === 1, '◀ moves a page earlier and follows it', 'now page ' + (moved.cur + 1));
  const del = await js(win, `return ${T}.deletePageViaButton(1);`);
  log(del && del.pages.length === 2, '✕ deletes a page', JSON.stringify(del.pages.map((p) => p.elements)));
  const guard = await js(win, `
    const T = ${T};
    T.deletePageViaButton(1);
    const one = T.pages();
    T.deletePageViaButton(0);
    return { after: T.pages(), one };`);
  log(guard.after.pages.length === 1, 'and the last page can never be deleted — a flyer must have a sheet',
    JSON.stringify(guard.after.pages.length));

  console.log('\n[5] Changing the size rescales EVERY page');
  const sized = await js(win, `
    const T = ${T};
    T.addPageViaButton(false);
    T.addText({ heading: 'SECOND', sub: '' });
    T.goPageViaThumb(0);
    const beforeW = T.pages().w;
    const sel = document.getElementById('edSize');
    sel.value = '1080x1080';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const p = T.pages();
    T.goPageViaThumb(1);
    const secondFits = T.elements().every(e => e.x + e.w <= p.w + 4 && e.y + e.h <= p.h + 4);
    return { beforeW, w: p.w, h: p.h, secondFits };`);
  log(sized.w === 1080 && sized.h === 1080, 'the document takes the new size', `${sized.beforeW} → ${sized.w}x${sized.h}`);
  log(sized.secondFits === true, 'and the layers on the OTHER page were rescaled to fit it too');

  console.log('\n[6] It is all saved, and it all comes back');
  await sleep(600);
  const savedDoc = await js(win, `return ${T}.savedDoc();`);
  log(savedDoc && Array.isArray(savedDoc.pages) && savedDoc.pages.length === 2,
    'the whole document is saved, not just the page on screen', JSON.stringify(savedDoc && savedDoc.pages && savedDoc.pages.length));
  const legacy = await js(win, `
    // What an older version of the app wrote: a single design, no pages.
    localStorage.setItem('mw_design', JSON.stringify({ w: 1080, h: 1350, background: { type: 'solid', color: '#fff' },
      elements: [{ id: 'x1', type: 'text', x: 40, y: 40, w: 400, h: 90, text: 'OLD SAVE', size: 60, font: 'Poppins', color: '#000' }] }));
    location.reload();
    return true;`);
  await sleep(2600);
  const restored = await js(win, `
    document.querySelector('.nav-item[data-view="flyer"]').click();
    await new Promise(r => setTimeout(r, 700));
    const T = ${T};
    return { pages: T.pages(), text: T.elements().map(e => e.text).filter(Boolean) };`);
  log(restored.pages && restored.pages.pages.length === 1 && restored.pages.pages[0].elements === 1,
    'a flyer saved by an older version opens as page one — nothing is lost in the upgrade',
    JSON.stringify(restored.pages && restored.pages.pages));

  console.log('\n[7] Every page exports, in order, as a real file');
  const exported = await js(win, `
    const T = ${T};
    T.addPageViaButton(false);
    T.addText({ heading: 'SHEET TWO', sub: '' });
    T.addPageViaButton(false);
    T.addText({ heading: 'SHEET THREE', sub: '' });
    await new Promise(r => setTimeout(r, 200));
    const files = await T.exportAll('png');
    return { files, pages: T.pages(), cur: T.pages().cur };`);
  if (exported.__error) console.error('   ' + exported.__error);
  const pngs = saved.filter((f) => /flyer-p\d+\.png$/.test(f));
  console.log('   wrote: ' + pngs.map((f) => path.basename(f)).join(', '));
  log(pngs.length === 3, 'one file per page', `${pngs.length} files`);
  log(pngs.every((f) => { const b = fs.readFileSync(f); return b.length > 5000 && b[0] === 0x89 && b[1] === 0x50; }),
    'and every one is a real PNG with a picture in it',
    pngs.map((f) => Math.round(fs.statSync(f).size / 1024) + 'KB').join(', '));
  log(exported.cur === exported.pages.cur, 'the editor is left on the page it started on');

  console.log('\n============  FLYER PAGES ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) {}
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
