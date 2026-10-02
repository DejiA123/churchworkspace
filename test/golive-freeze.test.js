'use strict';
/*
 * GO LIVE — DOES IT EVER STOP ANSWERING?
 *
 * Same question as test/present-freeze.test.js, pointed at the switcher, and it
 * matters more here: the Presentation studio freezing is embarrassing, the
 * switcher freezing happens while the church is watching and the stream is up.
 *
 * Two heartbeats measure the two threads that can lock:
 *   • the RENDERER, where the compositor, the mixer and every control live;
 *   • the MAIN process, shared by every window and every encoder.
 * Any gap longer than the heartbeat's own interval is time the desk could not
 * repaint or accept a click.
 *
 * The workload is a real Sunday switcher: eight inputs (cameras, a colour, a
 * lower third), the compositor running, the mixer open. Nothing is stubbed out
 * of the render path — synthetic inputs paint real frames through the real
 * compositor, so the cost measured is the cost an operator pays.
 *
 * Thresholds, in human terms:
 *   16.7 ms  one frame at 60 Hz
 *   100 ms   the limit of "instant"
 *   250 ms   a visible stall — on air, a missed cue
 *
 *   npm run test:golive-freeze
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-golive-freeze');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => (n == null ? '?' : Math.round(n) + ' ms');

let stage = 'boot';
const at = (s) => { stage = s; console.log('  .. ' + s); };
setTimeout(() => {
  console.log(`\n  !! WATCHDOG: still in "${stage}" after 240 s — treating as a hang.`);
  console.log(`  ${pass} PASS / ${fail + 1} FAIL`);
  app.exit(1);
}, 240000);
const withTimeout = (p, msLimit, label) => Promise.race([
  p, sleep(msLimit).then(() => ({ __error: `timed out after ${msLimit} ms (${label})` })),
]);

/* ---- main-process freeze meter: a 10 ms timer reporting its own lateness ---- */
const mainMeter = { max: 0, on: false, over100: 0 };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - mainLast - 10;
  mainLast = now;
  if (mainMeter.on && late > 0) { if (late > mainMeter.max) mainMeter.max = late; if (late > 100) mainMeter.over100++; }
}, 10);
const mainMeterStart = () => { mainMeter.max = 0; mainMeter.over100 = 0; mainLast = Date.now(); mainMeter.on = true; };
const mainMeterStop = () => { mainMeter.on = false; return { max: mainMeter.max, over100: mainMeter.over100 }; };

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('present:state', () => ok(null));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('bible:books', () => ok([]));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('bgvideo:list', () => ok([]));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:list', () => ok([]));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));
/* The switcher polls this every second while it is open. */
let metricCalls = 0;
ipcMain.handle('live:metrics', () => { metricCalls++; return ok({ cpu: 30, appCpu: 12 }); });

const T = 'window.LiveStudio.__test';
const INPUTS = 8;

app.whenReady().then(async () => {
  at('opening the switcher window');
  const win = new BrowserWindow({
    width: 1520, height: 940, show: true,
    webPreferences: {
      preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false,
      // The shipped studio sets this; without it Chromium throttles timers in an
      // occluded window and the meter reads the OS scheduler, not the app.
      backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await withTimeout(win.loadFile(path.join(ROOT, 'src/renderer/index.html')), 60000, 'loadFile');
  at('index.html loaded');
  await sleep(1500);

  const js = (code) => withTimeout(win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    60000, 'executeJavaScript');
  const bad = (r) => r && r.__error;

  /*
   * WHY THIS REPORTS PERCENTILES AND NOT JUST THE WORST GAP.
   *
   * The worst single gap is the number that matters to a person — a freeze is
   * a freeze. But on a four-core laptop the worst gap in any two-second window
   * is regularly decided by something that is not this app: a GC, an antivirus
   * scan, another process waking up. Measured here, the same idle desk gave a
   * 30 ms worst gap on one run and 138 ms on the next while its own drawing
   * cost was unchanged at under 1 ms a frame.
   *
   * So both are kept and each is asked its own question. p95 says what using
   * the desk actually feels like and is stable enough to catch a real
   * regression; the worst gap is held to the much looser "a person would
   * notice a stall" bar, which outliers do not reach but a genuine freeze does.
   */
  await js(`
    window.__fm = { on: false, last: 0, all: [] };
    setInterval(() => {
      const now = performance.now();
      if (window.__fm.on && window.__fm.last) {
        const late = now - window.__fm.last - 10;
        if (late > 0) window.__fm.all.push(late);
      }
      window.__fm.last = now;
    }, 10);
    window.__fmStart = () => { window.__fm.all = []; window.__fm.last = performance.now(); window.__fm.on = true; };
    window.__fmStop = () => {
      window.__fm.on = false;
      const a = window.__fm.all.slice().sort((x, y) => x - y);
      const at = (q) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0);
      return { n: a.length, p50: at(0.5), p95: at(0.95), max: Math.round(a[a.length - 1] || 0),
               over250: a.filter((x) => x > 250).length };
    };
    return 1;`);

  at('switching to Go Live and building a Sunday switcher');
  const built = await js(`
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise(r => setTimeout(r, 500));
    const T = window.LiveStudio.__test;
    for (let i = 1; i <= ${INPUTS - 2}; i++) T.addSynthetic('Camera ' + i, i * 40);
    T.addColor('Announcements', '#2244cc');
    T.addTitle({ headline: 'Sunday Service', subtext: 'Grace Chapel', style: 'lower' });
    await new Promise(r => setTimeout(r, 1200));
    const s = T.state();
    return { inputs: s.inputs.length, fps: s.fps, mixerOpen: s.mixerOpen,
             cells: document.querySelectorAll('.vmx-input').length,
             canvases: document.querySelectorAll('.vmx-input canvas').length };`);
  if (bad(built)) { check('switcher built', false, built.__error); }
  else {
    console.log(`    ${built.inputs} inputs · ${built.cells} cells · ${built.canvases} canvases · compositor ${built.fps} fps · mixer ${built.mixerOpen ? 'open' : 'closed'}`);
    check('a Sunday-sized switcher is running', built.inputs >= INPUTS - 1 && built.cells >= INPUTS - 1,
      `${built.inputs} inputs`);
  }
  await sleep(1500);

  /* ---------------- [0] the idle baseline ----------------
   * The switcher is never doing nothing: it composites the program, the
   * preview and every input thumbnail continuously. Whatever gaps that costs
   * are the floor, and every later measurement has to be read against it —
   * otherwise the compositor's own frames get blamed on whichever button was
   * pressed at the time. */
  head('[0] Idle — the compositor running, nobody touching anything');
  await js('window.__fmStart(); return 1;');
  await sleep(3000);
  const idleFm = await js('return window.__fmStop();');
  const idleState = await js(`const s = window.LiveStudio.__test.state(); return { fps: s.fps, renderMs: s.renderMs, target: s.targetFps };`);
  console.log(`    compositor ${idleState.fps} fps (target ${idleState.target}), ${Number(idleState.renderMs || 0).toFixed(1)} ms per frame drawing`);
  const fmt = (f) => `p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · worst ${ms(f.max)}`;
  console.log(`    renderer gaps while idle: ${fmt(idleFm)}  (n=${idleFm.n})`);
  check('the desk stays responsive while simply running', idleFm.p95 < 50, fmt(idleFm));
  check('and never stalls visibly while idle', idleFm.max < 250 && idleFm.over250 === 0, `worst ${ms(idleFm.max)}`);

  /* ---------------- [1] CUT — the most-used control on air ---------------- */
  head('[1] Cutting between inputs  (the button pressed most during a service)');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const cuts = await js(`
    const T = window.LiveStudio.__test;
    const ids = T.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const out = [];
    for (let n = 0; n < 25; n++) {
      const id = ids[n % ids.length];
      T.setPreview(id);
      const t = performance.now();
      document.getElementById('vmxCut').click();
      out.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 60));
    }
    return out;`);
  const cFm = await js('return window.__fmStop();');
  const cMain = mainMeterStop();
  if (bad(cuts)) check('cutting measured', false, cuts.__error);
  else {
    const worst = Math.max(...cuts), med = cuts.slice().sort((a, b) => a - b)[Math.floor(cuts.length / 2)];
    console.log(`    per cut: median ${ms(med)}  worst ${ms(worst)}`);
    console.log(`    renderer gaps: ${fmt(cFm)}   main blocked worst: ${ms(cMain.max)}`);
    check('a cut lands inside 100 ms', worst < 100, `worst ${ms(worst)}`);
    check('cutting keeps the desk responsive', cFm.p95 < 50, fmt(cFm));
    check('and no cut ever stalls the desk visibly', cFm.max < 250 && cFm.over250 === 0, `worst ${ms(cFm.max)}`);
  }

  /* ---------------- [1b] what a cut actually rebuilds ---------------- */
  head('[1b] What one cut rebuilds');
  const rebuild = await js(`
    const T = window.LiveStudio.__test;
    const ids = T.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const before = [...document.querySelectorAll('.vmx-input canvas')];
    const rails0 = T.railRebuilds.n;
    T.setPreview(ids[1]);
    document.getElementById('vmxCut').click();
    await new Promise(r => setTimeout(r, 50));
    const after = [...document.querySelectorAll('.vmx-input canvas')];
    const same = before.length === after.length && before.every((n, i) => n === after[i]);
    // the outline must still have moved — a cheap render that renders nothing
    // would pass the "no rebuild" check and break the desk
    const onAir = document.querySelector('.vmx-input.sel-pgm');
    return { count: after.length, sameNodes: same, railRebuilds: T.railRebuilds.n - rails0,
             onAirId: onAir && onAir.dataset.id, wanted: String(ids[1]),
             onAirLabel: onAir && (onAir.querySelector('.vmx-in-state') || {}).textContent };`);
  if (bad(rebuild)) check('cut rebuild inspected', false, rebuild.__error);
  else {
    console.log(`    ${rebuild.count} canvases · same DOM nodes after the cut: ${rebuild.sameNodes} · rail rebuilds: ${rebuild.railRebuilds}`);
    /* A cut changes which cell is outlined. Throwing away every canvas to
     * change a border means the compositor re-acquires a context for each one
     * while it is drawing 30 frames a second. */
    check('a cut does not throw away and rebuild every input canvas',
      rebuild.sameNodes === true && rebuild.railRebuilds === 0,
      rebuild.sameNodes ? 'canvases reused, rail untouched' : 'ALL canvases recreated');
    check('and the cut still actually happened — the outline moved',
      rebuild.onAirId === rebuild.wanted && rebuild.onAirLabel === 'ON AIR',
      `on air: input ${rebuild.onAirId} (wanted ${rebuild.wanted}), badge "${rebuild.onAirLabel}"`);
  }

  /* ---------------- [2] auto transition ---------------- */
  head('[2] An auto transition (Fade) running while the compositor draws');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const trans = await js(`
    const T = window.LiveStudio.__test;
    const ids = T.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const out = [];
    for (let n = 0; n < 8; n++) {
      T.setPreview(ids[(n + 1) % ids.length]);
      const t = performance.now();
      T.startTransition("Fade", 400);
      out.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 550));
    }
    return out;`);
  const tFm = await js('return window.__fmStop();');
  const tMain = mainMeterStop();
  if (bad(trans)) check('transitions measured', false, trans.__error);
  else {
    console.log(`    starting a transition: worst ${ms(Math.max(...trans))}`);
    console.log(`    renderer gaps: ${fmt(tFm)}   main blocked worst: ${ms(tMain.max)}`);
    /* A fade genuinely draws two sources and blends them, so it costs more per
     * frame than sitting on one. It must stay in the same league as idle, not
     * become a stall — the old full-rail rebuild at the end of every transition
     * made this over a second. */
    check('a fade keeps the desk responsive', tFm.p95 < 50, fmt(tFm));
    check('and a fade never stalls the desk visibly', tFm.max < 250 && tFm.over250 === 0, `worst ${ms(tFm.max)}`);
  }

  /* ---------------- [3] riding a fader ---------------- */
  head('[3] Riding an audio fader  (a slider fires ~60 events a second)');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const fader = await js(`
    const f = document.querySelector('.vmx-mixer .vmx-vfader');
    if (!f) return { skipped: true };
    const t0 = performance.now();
    for (let i = 0; i <= 40; i++) {
      f.value = String(0.3 + (i % 20) * 0.03);
      f.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 16));
    }
    return { total: performance.now() - t0, ticks: 41 };`);
  const fFm = await js('return window.__fmStop();');
  const fMain = mainMeterStop();
  if (bad(fader)) check('fader measured', false, fader.__error);
  else if (fader.skipped) console.log('    SKIP — no mixer fader in the DOM');
  else {
    console.log(`    41 fader ticks in ${ms(fader.total)}`);
    console.log(`    renderer gaps: ${fmt(fFm)}   main blocked worst: ${ms(fMain.max)}`);
    check('riding a fader keeps the desk responsive', fFm.p95 < 50, fmt(fFm));
    check('and riding a fader never stalls it visibly', fFm.max < 250 && fFm.over250 === 0, `worst ${ms(fFm.max)}`);
  }

  /* ---------------- [4] adding an input mid-service ---------------- */
  head('[4] Adding an input while the desk is running');
  mainMeterStart();
  await js('window.__fmStart(); return 1;');
  const add = await js(`
    const T = window.LiveStudio.__test;
    const out = [];
    for (let n = 0; n < 4; n++) {
      const t = performance.now();
      T.addColor('Extra ' + n, '#33aa66');
      out.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 200));
    }
    return out;`);
  const aFm = await js('return window.__fmStop();');
  mainMeterStop();
  if (bad(add)) check('adding inputs measured', false, add.__error);
  else {
    console.log(`    per add: worst ${ms(Math.max(...add))}   renderer gaps: ${fmt(aFm)}`);
    check('adding an input never stalls the desk visibly', aFm.max < 250 && aFm.over250 === 0, fmt(aFm));
  }

  /* ---------------- [5] a service is long ---------------- */
  head('[5] Two hundred cuts — does it drift, leak, or slow down?');
  const drift = await js(`
    const T = window.LiveStudio.__test;
    const ids = T.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const cutOnce = (n) => { T.setPreview(ids[n % ids.length]); const t = performance.now(); document.getElementById('vmxCut').click(); return performance.now() - t; };
    const early = []; for (let i = 0; i < 5; i++) { early.push(cutOnce(i)); await new Promise(r => setTimeout(r, 30)); }
    const nodes0 = document.getElementsByTagName('*').length;
    const canv0 = document.querySelectorAll('canvas').length;
    for (let i = 0; i < 200; i++) { cutOnce(i); if (i % 20 === 0) await new Promise(r => setTimeout(r, 5)); }
    const late = []; for (let i = 0; i < 5; i++) { late.push(cutOnce(i)); await new Promise(r => setTimeout(r, 30)); }
    const nodes1 = document.getElementsByTagName('*').length;
    const canv1 = document.querySelectorAll('canvas').length;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return { early: avg(early), late: avg(late), nodes0, nodes1, canv0, canv1, fps: T.state().fps };`);
  if (bad(drift)) check('long run measured', false, drift.__error);
  else {
    console.log(`    a cut before 200 cuts: ${ms(drift.early)}   after: ${ms(drift.late)}   compositor still ${drift.fps} fps`);
    console.log(`    DOM nodes ${drift.nodes0} -> ${drift.nodes1}   canvases ${drift.canv0} -> ${drift.canv1}`);
    check('the desk does not get slower over a service',
      drift.late < Math.max(drift.early * 1.8, drift.early + 20), `${ms(drift.early)} -> ${ms(drift.late)}`);
    check('no DOM or canvas leak over 200 cuts',
      drift.nodes1 < drift.nodes0 * 1.25 + 200 && drift.canv1 <= drift.canv0 + 4,
      `${drift.nodes0}->${drift.nodes1} nodes, ${drift.canv0}->${drift.canv1} canvases`);
    check('the compositor is still running after 200 cuts', drift.fps > 0, `${drift.fps} fps`);
  }

  /* ---------------- [6] still answering ---------------- */
  head('[6] The desk is still answering');
  const alive = await Promise.race([
    js(`return { ok: true, inputs: window.LiveStudio.__test.state().inputs.length };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('the switcher still answers after everything above',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung' : 'responsive');

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
