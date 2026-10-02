'use strict';
/*
 * THE CUT-OUT EDITOR — "sometimes it removes too much".
 *
 * Two controls have to work, and one relationship between them:
 *
 *   1. the STRENGTH dial really changes how much goes;
 *   2. the ERASE / BRING-BACK brushes really change the picture;
 *   3. and moving the dial must NOT throw the brush work away — which is the
 *      whole reason for having both rather than either one.
 *
 * Measured on the alpha channel itself, because "removed too much" is a number:
 * the fraction of the picture that is now see-through.
 *
 *   npx electron test/cutout-editor.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');

const WORK = path.join(os.tmpdir(), 'mw-cutout');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

/*
 * A "logo on a backdrop": a near-white background with a solid red disc in the
 * middle and a slightly-off-white ring around it. The ring is the point — it is
 * the fringe that a gentle setting keeps and a strong setting eats, so it makes
 * "how much is removed" measurable rather than a matter of opinion.
 */
const LOGO = path.join(WORK, 'logo.png');
execFileSync(ffmpeg, ['-y', '-v', 'error',
  '-f', 'lavfi', '-i', 'gradients=s=400x400:c0=0xf6f6f6:c1=0xa8a8a8:x0=0:y0=0:x1=400:y1=400:nb_colors=2',
  '-vf', 'drawbox=x=150:y=150:w=100:h=100:color=0xd42020:t=fill,format=rgb24',
  '-frames:v', '1', LOGO]);

let failed = false;
const log = (ok, n, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!ok) failed = true; };

const ok = (d) => ({ ok: true, data: d });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('library:list', () => ok([]));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('fs:readImageDataUrl', async (_e, { path: p }) => {
  const b = fs.readFileSync(p);
  const ext = (path.extname(p).slice(1) || 'png').toLowerCase();
  return ok(`data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${b.toString('base64')}`);
});
let written = null;
ipcMain.handle('fs:writeImageDataUrl', async (_e, { dataUrl, name }) => {
  const m = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) throw new Error('not an image');
  const out = path.join(WORK, `${String(name || 'cut').replace(/[^\w.-]+/g, '_')}-${Date.now()}.png`);
  fs.writeFileSync(out, Buffer.from(m[2], 'base64'));
  written = out;
  return ok(out);
});

app.disableHardwareAcceleration();
const js = (w, src) => w.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

app.whenReady().then(async () => {
  const errs = [];
  const win = new BrowserWindow({ show: false, width: 1500, height: 1000,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, l, m) => { if (l >= 3) errs.push(m); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1400);
  const boot = errs.slice();

  console.log('\n[1] It opens with a cut-out to look at');
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64');
  const opened = await js(win, `
    window.CutOut.wire();
    await window.CutOut.open(${J(dataUrl)}, () => {});
    await new Promise(r => setTimeout(r, 900));
    const T = window.CutOut.__test;
    return { st: T.state(), removed: T.removedFraction(),
             shown: !document.getElementById('cutModal').classList.contains('hidden') };`);
  if (opened.__error) { console.error(opened.__error); app.exit(1); return; }
  log(opened.shown, 'the editor is on screen');
  log(opened.st.w > 0 && opened.st.h > 0, 'the picture is loaded', `${opened.st.w}x${opened.st.h}`);
  log(opened.removed > 0.1, 'something was actually removed', (opened.removed * 100).toFixed(1) + '% see-through');
  log(/ai|colour/.test(opened.st.method), 'it says which method it used', opened.st.method);

  console.log('\n[2] THE ASK: a dial for how much is removed');
  const dial = await js(win, `
    const T = window.CutOut.__test;
    await T.setMode('colour');
    await T.setStrength(0.15); const gentle = T.removedFraction();
    await T.setStrength(0.85); const strong = T.removedFraction();
    await T.setStrength(0.5);  const middle = T.removedFraction();
    return { gentle, strong, middle };`);
  log(dial.strong > dial.gentle, 'turning it up removes MORE of the picture',
    `${(dial.gentle * 100).toFixed(1)}% → ${(dial.strong * 100).toFixed(1)}%`);
  log(dial.middle > dial.gentle && dial.middle < dial.strong, '…and the middle really is in between',
    (dial.middle * 100).toFixed(1) + '%');
  log(dial.gentle < 0.98, 'the gentlest setting does not eat the whole picture', (dial.gentle * 100).toFixed(1) + '%');

  console.log('\n[3] THE ASK: erase and bring-back brushes');
  const brushes = await js(win, `
    const T = window.CutOut.__test;
    await T.setStrength(0.5);
    const before = T.alphaAt(0.5, 0.5);           // the middle of the red disc
    T.paint('erase', 0.5, 0.5, 0.12);
    const afterErase = T.alphaAt(0.5, 0.5);
    T.paint('keep', 0.5, 0.5, 0.12);
    const afterKeep = T.alphaAt(0.5, 0.5);
    let spot = null;
    for (const [fx, fy] of [[0.5, 0.06], [0.06, 0.5], [0.94, 0.5], [0.5, 0.94], [0.2, 0.2], [0.8, 0.8], [0.04, 0.04]]) {
      if (T.alphaAt(fx, fy) < 40) { spot = [fx, fy]; break; }
    }
    const cornerBefore = spot ? T.alphaAt(spot[0], spot[1]) : null;
    if (spot) T.paint('keep', spot[0], spot[1], 0.06);
    const cornerAfter = spot ? T.alphaAt(spot[0], spot[1]) : null;
    return { before, afterErase, afterKeep, cornerBefore, cornerAfter, spot, undo: T.state().undoDepth };`);
  log(brushes.before > 200, 'the middle of the logo starts opaque', String(brushes.before));
  log(brushes.afterErase < 40, 'ERASE really rubs it out', `${brushes.before} → ${brushes.afterErase}`);
  log(brushes.afterKeep > 200, 'BRING BACK really paints it back', `${brushes.afterErase} → ${brushes.afterKeep}`);
  log(!!brushes.spot && brushes.cornerBefore < 40, 'part of the backdrop was removed by the dial',
    JSON.stringify(brushes.spot) + ' → alpha ' + brushes.cornerBefore);
  log(brushes.cornerAfter > 200, '…and BRING BACK restores backdrop the dial had taken',
    `${brushes.cornerBefore} → ${brushes.cornerAfter}`);
  log(brushes.undo > 0, 'every stroke is undoable', brushes.undo + ' steps');

  console.log('\n[4] The two controls do not fight each other');
  const together = await js(win, `
    const T = window.CutOut.__test;
    let spot = null;
    for (const [fx, fy] of [[0.5, 0.06], [0.06, 0.5], [0.94, 0.5], [0.5, 0.94], [0.2, 0.2], [0.8, 0.8], [0.04, 0.04]]) {
      if (T.alphaAt(fx, fy) < 40) { spot = [fx, fy]; break; }
    }
    if (!spot) return { painted: 0, afterDial: 0, spot: null };
    T.paint('keep', spot[0], spot[1], 0.06);       // paint some backdrop back
    const painted = T.alphaAt(spot[0], spot[1]);
    await T.setStrength(0.9);                      // now turn the dial right up
    const afterDial = T.alphaAt(spot[0], spot[1]);
    return { painted, afterDial, spot };`);
  log(together.afterDial > 200, 'THE POINT: moving the dial keeps the hand-painted work',
    `${together.painted} → ${together.afterDial} after re-running at 90%`);

  // A spot nothing has touched yet, so undoing THIS stroke is unambiguous.
  const undone = await js(win, `
    const T = window.CutOut.__test;
    const clean = T.alphaAt(0.94, 0.06);
    T.paint('keep', 0.94, 0.06, 0.05);
    const painted = T.alphaAt(0.94, 0.06);
    T.undo();
    return { clean, painted, after: T.alphaAt(0.94, 0.06) };`);
  log(undone.painted > undone.clean, 'a fresh stroke lands', `${undone.clean} → ${undone.painted}`);
  log(undone.after === undone.clean, 'undo takes exactly that stroke off again',
    `${undone.painted} → ${undone.after}`);

  console.log('\n[5] What comes out is a real transparent PNG');
  const applied = await js(win, `
    const T = window.CutOut.__test;
    const png = T.apply();
    return { isPng: png.startsWith('data:image/png;base64,'), len: png.length };`);
  log(applied.isPng, 'Apply produces a PNG', (applied.len / 1024).toFixed(0) + 'KB of data URL');

  const saved = await js(win, `
    return await window.api.fs.writeImageDataUrl(window.CutOut.__test.apply(), 'logo-cutout');`);
  log(!!saved && fs.existsSync(saved), 'and it saves to a real file', saved ? path.basename(saved) : 'NONE');
  if (saved && fs.existsSync(saved)) {
    // Probe the saved file: it must carry an alpha channel, or nothing was cut.
    const out = execFileSync(require('ffprobe-static').path,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,width,height', '-of', 'json', saved],
      { maxBuffer: 1 << 22 });
    const st = JSON.parse(out).streams[0];
    log(/a$|rgba|argb/i.test(st.pix_fmt), 'the saved PNG really has transparency', st.pix_fmt);
    log(st.width > 0 && st.height > 0, '…at a sensible size', `${st.width}x${st.height}`);
  }

  const newErrs = errs.filter((m) => !boot.includes(m) && !/Autofill|DevTools|source-map|No handler registered|mwasset/i.test(m));
  log(newErrs.length === 0, 'no new console errors', newErrs.slice(0, 2).join(' | '));

  console.log(failed ? '\nFAILED' : '\nALL PASSED');
  if (!failed) fs.rmSync(WORK, { recursive: true, force: true });
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
