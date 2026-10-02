'use strict';
/*
 * DIAGNOSTIC (not a pass/fail suite): where does the A/V offset on the
 * broadcast come from?
 *
 * The program is captured as two tracks off one MediaStream — the canvas and
 * the master audio bus — and each carries timestamps on its OWN Chromium
 * clock. The muxer is what decides how those two clocks are laid on top of
 * each other, so if the sound lands ahead of the picture, the evidence is in
 * the raw arrival data: for every item, the moment it turned up (`at`, on
 * performance.now) beside the timestamp it claims (`ts`).
 *
 *   ts - at  =  that track's clock epoch  +  however long delivery took
 *
 * Delivery delay is never negative, so the LARGEST `ts - at` a track produces
 * is its true epoch. The gap between what the FIRST item implies and what the
 * track's real epoch is, is exactly the error a per-track rebase bakes in.
 *
 *   npx electron test/diag-avclock.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmod = require('../src/main/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-clock-'));
const ok = (data) => ({ ok: true, data });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: ffmod.resolveFfmpeg(), ffprobe: ffmod.resolveFfprobe() }));
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

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  // preDelay stands in for the wait between building the capture stream and
  // actually reading it (the hub session round-trip, plus the WebCodecs
  // support probes) — the window in which the picture can go stale.
  for (const pre of [0, 400, 1200]) {
    const r = await js(win, `
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-live').classList.add('active');
      window.LiveStudio.onShow();
      const T = window.LiveStudio.__test;
      T.closeAllInputs();
      const a = T.addAvPulse('Pulse');
      T.setPreview(a.id); T.cut();
      await new Promise(r => setTimeout(r, 1200));
      return await T.captureClocks({ preDelayMs: ${pre}, ms: 2500 });`);
    if (r.__error) { console.error(r.__error); break; }
    const vOff = r.v.map((x) => x.ts - x.at);
    const aOff = r.a.map((x) => x.ts - x.at);
    const mx = (arr) => Math.max(...arr), mn = (arr) => Math.min(...arr);
    console.log(`\n=== preDelay ${pre}ms ===  video items ${r.v.length}, audio items ${r.a.length}`);
    if (!vOff.length || !aOff.length) { console.log('  (one of the tracks delivered nothing)'); continue; }
    console.log(`  video ts-at (ms): first ${vOff[0].toFixed(0)}  max ${mx(vOff).toFixed(0)}  min ${mn(vOff).toFixed(0)}`);
    console.log(`  audio ts-at (ms): first ${aOff[0].toFixed(0)}  max ${mx(aOff).toFixed(0)}  min ${mn(aOff).toFixed(0)}`);
    console.log('  >> first-sample rebase error (what a per-track offset bakes in): ' +
      (((vOff[0] - mx(vOff)) - (aOff[0] - mx(aOff)))).toFixed(0) + ' ms   (negative = sound early)');
    console.log('  first 8 video: ' + r.v.slice(0, 8).map((x) => `at${x.at.toFixed(0)}/ts${x.ts.toFixed(0)}`).join(' '));
    console.log('  first 8 audio: ' + r.a.slice(0, 8).map((x) => `at${x.at.toFixed(0)}/ts${x.ts.toFixed(0)}/n${x.n}`).join(' '));
    const gaps = [];
    for (let i = 1; i < r.a.length; i++) {
      const expected = r.a[i - 1].n / (r.a[i - 1].sr / 1000);
      const d = r.a[i].ts - r.a[i - 1].ts;
      if (Math.abs(d - expected) > 2) gaps.push(`${r.a[i - 1].ts.toFixed(0)}→${r.a[i].ts.toFixed(0)} (${(d - expected).toFixed(0)}ms)`);
    }
    console.log('  audio timeline holes: ' + (gaps.length ? gaps.join(', ') : 'none'));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
