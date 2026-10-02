'use strict';
/*
 * "Navigating the video timeline — zoom etc — is very slow and laggy."
 *
 * This puts a number on it, on the timeline that actually hurts: a 190-minute
 * sermon (the length in the operator's screenshot), a real filmstrip image, a
 * dozen clips and the ~1500 caption lines a whole-service transcript produces.
 *
 * Two measurements, because they fail differently:
 *   • a BREAKDOWN of one render, so the fix goes where the time is rather than
 *     where it feels like it should be;
 *   • a zoom SWEEP measured from the wheel event to the frame that shows it,
 *     which is the thing a person actually experiences as lag.
 *
 * The thresholds are in human terms: 16.7 ms is one frame at 60 Hz. A zoom step
 * that lands inside two frames feels instant; one that takes 200 ms feels
 * broken, which is what was being reported.
 *
 *   npx electron test/timeline-perf.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-tlperf-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Anton']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'thumbs not needed here' }));

const DUR = 11400;   // 190 minutes, as in the report

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1500, height: 950, show: true,
    // backgroundThrottling off, like every other timing suite: covered or
    // unfocused, Chromium throttles this window's frames — a run measured 0.4 fps
    // and then waited forever on the next requestAnimationFrame.
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`);

  await js(`document.querySelector('[data-view="video"]').click(); await new Promise(r => setTimeout(r, 400)); return 1;`);

  /* The real workload: a 190-minute sermon with a real filmstrip (24 frames
   * tiled, exactly what video.filmstrip() produces), a dozen clips and a whole
   * service's worth of caption lines. */
  const setup = await js(`
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: ${DUR}, width: 1920, height: 1080 });
    // 24 tiled frames at 160x90 — the same shape the real strip has
    const cv = document.createElement('canvas'); cv.width = 24 * 160; cv.height = 90;
    const c = cv.getContext('2d');
    for (let i = 0; i < 24; i++) {
      c.fillStyle = 'hsl(' + (i * 15) + ',60%,45%)'; c.fillRect(i * 160, 0, 160, 90);
      c.fillStyle = '#fff'; c.font = 'bold 28px sans-serif'; c.fillText(String(i), i * 160 + 60, 55);
    }
    T.setFilmstrip(cv.toDataURL('image/png'));
    T.applyClips(Array.from({length: 12}, (_, i) => ({
      start: 300 + i * 800, end: 300 + i * 800 + 90, label: 'Key point ' + (i + 1)
    })));
    // a whole service transcribed: ~1500 lines
    T.setCapEvents(Array.from({length: 1500}, (_, i) => ({
      start: 60 + i * 7, end: 60 + i * 7 + 3.2, text: 'CAPTION LINE ' + (i + 1)
    })), 0);
    T.fitHook();
    await new Promise(r => requestAnimationFrame(r));
    return { caps: T.capCount(), segs: T.segments().length, trackW: T.trackWidthPx() };
  `);
  console.log(`  workload: ${DUR / 60} min · ${setup.segs} clips · ${setup.caps} caption lines`);

  head('[A] Where one render actually goes');
  const zoomedIn = await js(`window.VideoEditor.__test.setZoomPx(20); await new Promise(r=>requestAnimationFrame(r)); return window.VideoEditor.__test.renderCostBreakdown();`);
  console.log('  at 20 px/s: ' + JSON.stringify(zoomedIn));
  const fitted = await js(`window.VideoEditor.__test.fitHook(); await new Promise(r=>requestAnimationFrame(r)); return window.VideoEditor.__test.renderCostBreakdown();`);
  console.log('  fitted:     ' + JSON.stringify(fitted));

  check('the caption lane does not build a node per line',
    zoomedIn.capNodes < 400, `${zoomedIn.capNodes} nodes for ${zoomedIn.caps} lines`);
  check('…so painting it costs a fraction of a frame', zoomedIn.capTrack < 8,
    `${zoomedIn.capTrack} ms`);
  check('the film strip is not scaled to an absurd width', zoomedIn.trackW < 400000,
    `${zoomedIn.trackW}px wide track`);

  /*
   * 16.7 ms is one frame at 60 Hz. `work` is the main-thread cost of a zoom
   * step with its render forced to run inside the measurement — under a frame
   * means the timeline can keep up with the wheel. `fps` counts frames through
   * a continuous sweep, which is the thing a person calls smooth.
   */
  head('[B] Ordinary editing range (whole sermon in view, up to 8 px/s)');
  await js(`window.VideoEditor.__test.fitHook(); return 1;`);
  const sweep = await js(`return await window.VideoEditor.__test.zoomPerf({ steps: 24, factor: 1.18, lo: 0.15, hi: 8 });`);
  console.log('  ' + JSON.stringify(sweep));
  check('a zoom step costs less than one frame of work', sweep.workMedian <= 16.7, `median ${sweep.workMedian} ms`);
  check('…and even the slow ones stay inside two frames', sweep.workP90 <= 33, `p90 ${sweep.workP90} ms`);
  check('…with no step stalling past 60 ms', sweep.workWorst <= 60, `worst ${sweep.workWorst} ms`);
  check('…and a continuous sweep runs at a smooth frame rate', sweep.fps >= 40, `${sweep.fps} fps`);

  /*
   * A CONTROL. When the main-thread work is well under a frame but the frame
   * rate still is not, the cost is paint, not script — and the only way to find
   * out what is being painted is to take things away. Same band, same clips, no
   * captions at all: if the frame rate jumps, the caption lane is still the
   * cost; if it does not, it is the lanes themselves.
   */
  head('[B2] Control — the same band with no captions at all');
  const noCaps = await js(`
    const T = window.VideoEditor.__test;
    T._savedCaps = T.capLines();
    T.setCapEvents([], 0);
    return await T.zoomPerf({ steps: 8, factor: 1.18, lo: 0.15, hi: 8 });
  `);
  console.log('  ' + JSON.stringify(noCaps));
  await js(`const T = window.VideoEditor.__test; T.setCapEvents(T._savedCaps, 0); return 1;`);
  console.log(`  captions cost ${(noCaps.fps - sweep.fps).toFixed(1)} fps in this band`);

  head('[C] Deep zoom for caption work (20-90 px/s)');
  await js(`window.VideoEditor.__test.setZoomPx(60); await new Promise(r=>requestAnimationFrame(r)); return 1;`);
  const deep = await js(`return await window.VideoEditor.__test.zoomPerf({ steps: 16, factor: 1.15, lo: 20, hi: 90 });`);
  console.log('  ' + JSON.stringify(deep));
  check('zooming in close costs less than a frame', deep.workMedian <= 16.7, `median ${deep.workMedian} ms`);
  check('…and never stalls', deep.workWorst <= 60, `worst ${deep.workWorst} ms`);
  check('…staying smooth throughout', deep.fps >= 40, `${deep.fps} fps`);

  head('[D] Scrolling along the timeline');
  const scroll = await js(`
    const T = window.VideoEditor.__test;
    T.setZoomPx(20);
    await new Promise(r => requestAnimationFrame(r));
    const sc = document.getElementById('veTlScroll');
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    // Same rule as the zoom sweep: measure the WORK, with the deferred render
    // forced to run inside the measurement, or two frame waits put a 33 ms
    // floor under every reading.
    const each = [];
    for (let i = 0; i < 20; i++) {
      sc.scrollLeft = i * 1400;
      const a = performance.now();
      sc.dispatchEvent(new Event('scroll'));
      T.flushRenderHook();
      sc.scrollWidth;
      each.push(performance.now() - a);
      await frame();
    }
    const s = each.slice().sort((x, y) => x - y);
    return { median: +s[Math.floor(s.length / 2)].toFixed(1), worst: +s[s.length - 1].toFixed(1) };
  `);
  console.log('  ' + JSON.stringify(scroll));
  check('scrolling along the timeline costs under a frame', scroll.median <= 16.7, `median ${scroll.median} ms`);
  check('…without a stall', scroll.worst <= 60, `worst ${scroll.worst} ms`);

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
