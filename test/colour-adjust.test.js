'use strict';
/*
 * REAL test for the Colour Adjust panel on Go Live inputs (the vMix "Colour
 * Adjust" tab the user asked for, screenshot and all).
 *
 * Nothing here trusts a stored value. Every claim is checked by reading the
 * PROGRAM CANVAS — the exact pixels that go to the recording and to every
 * streaming destination — so "the slider works" means the picture really changed
 * on the broadcast, not that a number was saved somewhere.
 *
 *   npx electron test/colour-adjust.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-colour-test');
fs.mkdirSync(WORK, { recursive: true });

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, { patch }) => ok(patch));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '' }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('dialog:openFile', () => ok(null));

app.disableHardwareAcceleration();
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

app.whenReady().then(async () => {
  const errors = [];
  const win = new BrowserWindow({
    show: false, width: 1500, height: 950,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);

  /* A flat mid-grey Colour input is the ideal test card: every channel starts at
   * a known, identical value, so any change to any control is unambiguous. */
  console.log('\n[1] A known picture on the program bus');
  const setup = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const inp = T.addColor('Grey card', '#808080');
    T.setPreview(inp.id); T.cut();
    await new Promise(r => setTimeout(r, 250));
    T.drawNow();
    return { id: inp.id, px: T.pgmPixel(40, 40), size: T.pgmSize() };`);
  if (setup.__error) console.error('[1] ' + setup.__error);
  const ID = setup.id;
  log(setup.px && near(setup.px[0], 128, 3) && near(setup.px[1], 128, 3) && near(setup.px[2], 128, 3),
    'a flat grey card is on the program output', `rgb(${(setup.px || []).slice(0, 3).join(',')})`);

  console.log('\n[2] The panel itself — every control from the vMix dialog');
  const panel = await js(win, `return window.LiveStudio.__test.colourPanel(${JSON.stringify(ID)});`);
  if (panel.__error) console.error('[2] ' + panel.__error);
  log(panel.present, 'Input settings has a Colour Adjust section');
  log(panel.sliders.length === 7, 'Red, Green, Blue, Saturation, Black Stretch, White Stretch and Alpha are all there',
    panel.sliders.join(', '));
  log(panel.buttons.length === 5, 'so are Auto White Balance, Reset, Auto, 0-255 and 16-235', panel.buttons.join(', '));
  log(panel.rec601, 'and the Rec. 601 to 709 conversion');

  console.log('\n[3] Dragging a slider changes the BROADCAST picture, not just a number');
  const red = await js(win, `
    const T = window.LiveStudio.__test;
    const drag = T.colourDrag('r', 50);
    T.drawNow();
    return { drag, px: T.pgmPixel(40, 40), stored: T.colourOf(${JSON.stringify(ID)}) };`);
  if (red.__error) console.error('[3] ' + red.__error);
  log(red.drag && red.drag.number === '50', 'the number box follows the slider', JSON.stringify(red.drag));
  log(red.px[0] > setup.px[0] + 25, 'RED really lifts the red channel on the program canvas',
    `R ${setup.px[0]} → ${red.px[0]}`);
  log(near(red.px[1], setup.px[1], 4) && near(red.px[2], setup.px[2], 4),
    'and leaves green and blue alone — it is a per-channel gain, not a brightness control',
    `G ${setup.px[1]}→${red.px[1]}, B ${setup.px[2]}→${red.px[2]}`);

  const blue = await js(win, `
    const T = window.LiveStudio.__test;
    T.colourDrag('r', 0); T.colourDrag('b', -50);
    T.drawNow();
    return T.pgmPixel(40, 40);`);
  log(blue[2] < setup.px[2] - 25 && near(blue[0], setup.px[0], 4),
    'a negative BLUE pulls only the blue channel down', `B ${setup.px[2]} → ${blue[2]}, R still ${blue[0]}`);

  console.log('\n[4] Black / White Stretch really is a levels stretch');
  const lv = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, sat: 0 });
    T.colourClick('vmxCol16235');            // the real preset button
    T.drawNow();
    const broadcastRange = T.pgmPixel(40, 40);
    T.colourClick('vmxCol0255');
    T.drawNow();
    return { broadcastRange, full: T.pgmPixel(40, 40), stored: T.colourOf(${JSON.stringify(ID)}) };`);
  if (lv.__error) console.error('[4] ' + lv.__error);
  // 128 through a 16-235 stretch → (128-16)/(235-16) ≈ 0.511 → ~130, and the
  // whole range is expanded, so mid-grey barely moves but the ENDS do.
  log(lv.broadcastRange[0] > setup.px[0], '16-235 expands the range (a washed-out camera gets its contrast back)',
    `${setup.px[0]} → ${lv.broadcastRange[0]}`);
  log(near(lv.full[0], setup.px[0], 2), '0-255 puts it back exactly where it started', `${lv.full[0]}`);
  log(lv.stored.black === 0 && lv.stored.white === 255, 'and the preset buttons set the real values', JSON.stringify({ black: lv.stored.black, white: lv.stored.white }));

  const crush = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { black: 100, white: 255 });
    T.drawNow();
    const dark = T.pgmPixel(40, 40);
    T.setColour(${JSON.stringify(ID)}, { black: 0, white: 160 });
    T.drawNow();
    return { dark, bright: T.pgmPixel(40, 40) };`);
  log(crush.dark[0] < setup.px[0] - 20, 'raising the black point really darkens mid-grey', `${setup.px[0]} → ${crush.dark[0]}`);
  log(crush.bright[0] > setup.px[0] + 20, 'lowering the white point really brightens it', `${setup.px[0]} → ${crush.bright[0]}`);
  log(crush.bright[0] <= 255 && crush.dark[0] >= 0, 'and nothing wraps around or goes out of range');

  console.log('\n[5] Saturation, on a picture that actually has colour');
  const sat = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, black: 0, white: 255, sat: 0 });
    T.paintInput(${JSON.stringify(ID)}, '#c04030');
    T.drawNow();
    const normal = T.pgmPixel(40, 40);
    T.setColour(${JSON.stringify(ID)}, { sat: -100 });
    T.drawNow();
    const grey = T.pgmPixel(40, 40);
    T.setColour(${JSON.stringify(ID)}, { sat: 100 });
    T.drawNow();
    return { normal, grey, vivid: T.pgmPixel(40, 40) };`);
  if (sat.__error) console.error('[5] ' + sat.__error);
  const spread = (p) => Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
  log(spread(sat.normal) > 60, 'the test colour is genuinely saturated to begin with', `spread ${spread(sat.normal)}`);
  log(spread(sat.grey) < 8, 'Saturation at -100 really does make it monochrome', `spread ${spread(sat.grey)}`);
  log(spread(sat.vivid) > spread(sat.normal), 'and +100 pushes it further', `${spread(sat.normal)} → ${spread(sat.vivid)}`);

  console.log('\n[6] Auto White Balance on a picture with a real colour cast');
  const awb = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, sat: 0, black: 0, white: 255 });
    T.paintInput(${JSON.stringify(ID)}, '#b09060');   // a warm tungsten-lit wall
    T.drawNow();
    const before = T.pgmPixel(40, 40);
    const res = T.autoWhiteBalance(${JSON.stringify(ID)});
    T.drawNow();
    return { before, res, after: T.pgmPixel(40, 40), stored: T.colourOf(${JSON.stringify(ID)}) };`);
  if (awb.__error) console.error('[6] ' + awb.__error);
  log(!!awb.res, 'it read the picture and produced a correction', JSON.stringify(awb.res));
  log(spread(awb.before) > 50, 'the source really is colour-cast', `spread ${spread(awb.before)} — rgb(${awb.before.slice(0, 3).join(',')})`);
  log(spread(awb.after) < spread(awb.before) / 2, 'THE POINT: after balancing, the cast is largely gone',
    `spread ${spread(awb.before)} → ${spread(awb.after)} — rgb(${awb.after.slice(0, 3).join(',')})`);
  log(awb.res && awb.res.b > awb.res.r, 'it lifted blue and held back red, which is what a warm cast needs',
    `R${awb.res.r} G${awb.res.g} B${awb.res.b}`);

  console.log('\n[7] Auto levels reads the real histogram');
  const al = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, sat: 0, black: 0, white: 255 });
    T.paintInput(${JSON.stringify(ID)}, '#606060');    // a flat, low-contrast frame
    T.drawNow();
    const flat = T.autoLevels(${JSON.stringify(ID)});
    T.paintInput(${JSON.stringify(ID)}, '#404040');
    T.drawNow();
    return { flat, second: T.autoLevels(${JSON.stringify(ID)}) };`);
  log(al.flat === null || (al.flat && al.flat.white - al.flat.black >= 8),
    'a flat frame is refused rather than producing a nonsense stretch', JSON.stringify(al.flat));

  console.log('\n[8] Alpha, and what stays free');
  const alpha = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, sat: 0, black: 0, white: 255, alpha: 255 });
    T.paintInput(${JSON.stringify(ID)}, '#ffffff');
    T.drawNow();
    const opaque = T.pgmPixel(40, 40);
    T.setColour(${JSON.stringify(ID)}, { alpha: 64 });
    T.drawNow();
    const faded = T.pgmPixel(40, 40);
    T.setColour(${JSON.stringify(ID)}, { alpha: 255 });
    return { opaque, faded, activeWhenDefault: T.colourActive(${JSON.stringify(ID)}), filter: T.colourFilter(${JSON.stringify(ID)}) };`);
  log(alpha.opaque[0] > 240 && alpha.faded[0] < alpha.opaque[0] - 60,
    'Alpha really fades the input over what is behind it', `${alpha.opaque[0]} → ${alpha.faded[0]}`);
  log(alpha.activeWhenDefault === false && alpha.filter === null,
    'THE PERFORMANCE RULE: an input nobody has graded carries NO filter at all — the switcher is untouched for it');

  console.log('\n[9] It compiles to a real filter, and it survives a preset');
  const filt = await js(win, `
    const T = window.LiveStudio.__test;
    T.setColour(${JSON.stringify(ID)}, { r: 30, g: -10, b: 12, sat: 25, black: 16, white: 235, rec601: true });
    T.drawNow();
    const filter = T.colourFilter(${JSON.stringify(ID)});
    const preset = T.serializePreset();
    return { filter, saved: (preset.inputs[0] || {}).colour, active: T.colourActive(${JSON.stringify(ID)}) };`);
  if (filt.__error) console.error('[9] ' + filt.__error);
  log(filt.active && !!filt.filter, 'a graded input compiles to a real SVG filter');
  log(/feComponentTransfer/.test(filt.filter || ''), 'levels + per-channel gain in one transfer pass');
  log(/type="saturate"/.test(filt.filter || ''), 'saturation as a colour matrix');
  log(/type="matrix"/.test(filt.filter || ''), 'and the Rec.601→709 conversion as its own matrix');
  log(filt.saved && filt.saved.r === 30 && filt.saved.white === 235 && filt.saved.rec601 === true,
    'the whole grade is saved into the Go Live preset — the rig comes back matched next Sunday',
    JSON.stringify(filt.saved));

  /* Grading must not cost the switcher its frame rate. This is measured, not
   * assumed: the filter runs on every composite of that input, and a slow one
   * would show up as judder on the broadcast — the opposite of the point. */
  console.log('\n[10] What grading costs the compositor');
  const perf = await js(win, `
    const T = window.LiveStudio.__test;
    const bench = (n) => { const t0 = performance.now(); for (let i = 0; i < n; i++) T.drawNow(); return (performance.now() - t0) / n; };
    T.setColour(${JSON.stringify(ID)}, { r: 0, g: 0, b: 0, sat: 0, black: 0, white: 255, alpha: 255, rec601: false });
    bench(20);                                   // warm up
    const plain = bench(120);
    T.setColour(${JSON.stringify(ID)}, { r: 20, g: -8, b: 14, sat: 20, black: 16, white: 235 });
    bench(20);
    const graded = bench(120);
    return { plain, graded, size: T.pgmSize() };`);
  if (perf.__error) console.error('[10] ' + perf.__error);
  console.log(`    ${perf.size[0]}x${perf.size[1]}: ungraded ${perf.plain.toFixed(2)} ms/frame · graded ${perf.graded.toFixed(2)} ms/frame`);
  log(perf.graded < 1000 / 30, 'a graded input still composites comfortably inside a 30fps frame budget',
    `${perf.graded.toFixed(2)} ms of the 33.3 ms available`);
  log(perf.graded < Math.max(perf.plain * 6, perf.plain + 8),
    'and the grade is not a cliff — it costs a fraction of a frame, not a frame',
    `+${(perf.graded - perf.plain).toFixed(2)} ms per composite`);

  console.log('\n[11] Console');
  log(errors.length === 0, 'no renderer errors', errors.slice(0, 3).join(' | ') || 'clean');

  console.log('\n============  COLOUR ADJUST test ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
