'use strict';
/*
 * VIDEO STUDIO — DOES IT EVER STOP ANSWERING?
 *
 * The third of the freeze tests (see present-freeze and golive-freeze). Zooming
 * the timeline already has its own guard in timeline-perf.test.js; this one
 * covers everything that happens AFTER the zoom is right — playing the video,
 * scrubbing, cutting clips, undoing — on a timeline big enough to hurt.
 *
 * The workload is the sermon this studio exists for: 90 minutes, a real tiled
 * filmstrip, 20 clips, and the ~1500 caption lines a whole-service transcript
 * produces.
 *
 * A renderer heartbeat measures the only thread that matters here — the editor
 * is all in the renderer. Gaps are reported as percentiles as well as a worst
 * case, because on a four-core laptop the single worst gap in a short window is
 * regularly decided by a GC or another process rather than by this app (see the
 * note in golive-freeze.test.js).
 *
 *   npm run test:video-freeze
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-video-freeze');
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
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:displays', () => ok([]));
ipcMain.handle('present:outputs', () => ok([]));
ipcMain.handle('present:state', () => ok(null));
ipcMain.handle('present:savePresentation', () => ok(true));
ipcMain.handle('bible:installed', () => ok([]));
ipcMain.handle('bible:catalogue', () => ok([]));
ipcMain.handle('bible:books', () => ok([]));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('bgvideo:list', () => ok([]));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ available: false, feeds: [] }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('dmx:state', () => ok({ on: false }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));
ipcMain.handle('live:metrics', () => ok({ cpu: 30, appCpu: 12 }));

const DUR = 5400;        // 90 minutes
const CLIPS = 20;
const CAPS = 1500;

app.whenReady().then(async () => {
  at('opening the studio window');
  const win = new BrowserWindow({
    width: 1520, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await withTimeout(win.loadFile(path.join(ROOT, 'src/renderer/index.html')), 60000, 'loadFile');
  at('index.html loaded');
  await sleep(1500);

  const js = (code) => withTimeout(win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    60000, 'executeJavaScript');
  const bad = (r) => r && r.__error;

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
  const fmt = (f) => `p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · worst ${ms(f.max)}`;

  at('loading a 90-minute sermon with clips and a full transcript');
  const setup = await js(`
    document.querySelector('.nav-item[data-view="video"]').click();
    await new Promise(r => setTimeout(r, 400));
    const T = window.VideoEditor.__test;
    T.loadFake({ durationSec: ${DUR}, width: 1920, height: 1080 });
    const cv = document.createElement('canvas'); cv.width = 24 * 160; cv.height = 90;
    const c = cv.getContext('2d');
    for (let i = 0; i < 24; i++) {
      c.fillStyle = 'hsl(' + (i * 15) + ',60%,45%)'; c.fillRect(i * 160, 0, 160, 90);
    }
    T.setFilmstrip(cv.toDataURL('image/png'));
    T.applyClips(Array.from({length: ${CLIPS}}, (_, i) => ({
      start: 200 + i * 250, end: 200 + i * 250 + 70, label: 'Key point ' + (i + 1)
    })));
    T.setCapEvents(Array.from({length: ${CAPS}}, (_, i) => ({
      start: 20 + i * 3.5, end: 20 + i * 3.5 + 2.4, text: 'CAPTION LINE ' + (i + 1)
    })), 0);
    T.fitHook();
    await new Promise(r => requestAnimationFrame(r));
    return { caps: T.capCount(), segs: T.segments().length, shorts: T.shortsCards() };`);
  if (bad(setup)) { check('workload loaded', false, setup.__error); }
  else {
    console.log(`    ${DUR / 60} min · ${setup.segs} clips · ${setup.caps} caption lines · ${setup.shorts} shorts cards`);
    check('a 90-minute sermon with a full transcript is loaded', setup.segs >= CLIPS && setup.caps === CAPS,
      `${setup.segs} clips, ${setup.caps} captions`);
  }

  /* ---------------- [0] idle baseline ---------------- */
  head('[0] Idle — the studio open, nobody touching anything');
  await js('window.__fmStart(); return 1;');
  await sleep(3000);
  const idle = await js('return window.__fmStop();');
  console.log(`    renderer gaps while idle: ${fmt(idle)}  (n=${idle.n})`);
  check('the studio is responsive while simply open', idle.p95 < 50, fmt(idle));

  /* ---------------- [1] PLAYING the video ----------------
   * Every timeupdate runs updatePlayhead, which moves the playhead, re-times the
   * caption overlay, re-lays the text overlays and follows the scroll. This is
   * the busiest repeating path in the studio and it runs while a person is
   * watching, so a stall here is visible as a stutter in the preview. */
  head('[1] Playing back  (the playhead path, 60 ticks)');
  await js(`window.VideoEditor.__test.fakePlaying(true); return 1;`);
  await js('window.__fmStart(); return 1;');
  const play = await js(`
    const T = window.VideoEditor.__test;
    const out = [];
    for (let i = 0; i < 60; i++) {
      T.seekAndRefresh(300 + i * 0.5);
      const t0 = performance.now();
      T.playheadTick();
      out.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 16));
    }
    return out;`);
  const pFm = await js('return window.__fmStop();');
  await js(`window.VideoEditor.__test.fakePlaying(false); return 1;`);
  if (bad(play)) check('playback measured', false, play.__error);
  else {
    const worst = Math.max(...play), med = play.slice().sort((a, b) => a - b)[Math.floor(play.length / 2)];
    console.log(`    per playhead tick: median ${ms(med)}  worst ${ms(worst)}`);
    console.log(`    renderer gaps: ${fmt(pFm)}`);
    check('a playhead tick costs less than one 60 Hz frame', med <= 16.7, `median ${ms(med)}`);
    check('playback keeps the studio responsive', pFm.p95 < 50, fmt(pFm));
    check('and playback never stalls it visibly', pFm.max < 250 && pFm.over250 === 0, `worst ${ms(pFm.max)}`);
  }

  /* ---------------- [2] scrubbing ---------------- */
  head('[2] Scrubbing across the whole sermon');
  await js('window.__fmStart(); return 1;');
  const scrub = await js(`
    const T = window.VideoEditor.__test;
    const out = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      T.seekAndRefresh((i / 40) * ${DUR});
      out.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 16));
    }
    return out;`);
  const sFm = await js('return window.__fmStop();');
  if (bad(scrub)) check('scrubbing measured', false, scrub.__error);
  else {
    console.log(`    per seek: median ${ms(scrub.slice().sort((a, b) => a - b)[20])}  worst ${ms(Math.max(...scrub))}`);
    console.log(`    renderer gaps: ${fmt(sFm)}`);
    check('scrubbing keeps the studio responsive', sFm.p95 < 50, fmt(sFm));
    check('and scrubbing never stalls it visibly', sFm.max < 250 && sFm.over250 === 0, `worst ${ms(sFm.max)}`);
  }

  /* ---------------- [3] cutting clips ---------------- */
  head('[3] Splitting, moving and undoing clips');
  await js('window.__fmStart(); return 1;');
  const edit = await js(`
    const T = window.VideoEditor.__test;
    const out = { split: [], move: [], undo: [] };
    for (let i = 0; i < 10; i++) {
      const ids = T.segIds();
      const id = ids[i % ids.length];
      T.selId && T.selId();
      let t0 = performance.now();
      T.split(220 + i * 250);
      out.split.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 20));
      const ids2 = T.segIds();
      t0 = performance.now();
      T.moveClip(ids2[0], 40 + i * 3);
      out.move.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 20));
      t0 = performance.now();
      T.undo();
      out.undo.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 20));
    }
    return out;`);
  const eFm = await js('return window.__fmStop();');
  if (bad(edit)) check('editing measured', false, edit.__error);
  else {
    const w = (a) => ms(Math.max(...a));
    console.log(`    split worst ${w(edit.split)} · move worst ${w(edit.move)} · undo worst ${w(edit.undo)}`);
    console.log(`    renderer gaps: ${fmt(eFm)}`);
    check('every edit lands inside 100 ms',
      Math.max(...edit.split, ...edit.move, ...edit.undo) < 100,
      `worst ${w([...edit.split, ...edit.move, ...edit.undo])}`);
    /*
     * A looser bar here than for playback and scrubbing, on purpose.
     *
     * The 50 ms p95 used above is the bar for CONTINUOUS interaction — a stream
     * of events where every one of them has to land inside a frame or two or
     * the thing feels broken under your hand. Splitting, moving and undoing are
     * discrete: one keypress, one result, and the bar a person actually holds
     * them to is "instant", which is 100 ms. Each of them genuinely rebuilds
     * the timeline once, on a 90-minute sermon carrying 1500 caption lines.
     *
     * What must not come back is the old behaviour, and that is what the checks
     * are shaped to catch: one gesture rendering the whole timeline five times
     * over, which put a split at 158 ms and a run of edits well past a quarter
     * of a second of dead window.
     */
    check('editing keeps the studio responsive', eFm.p95 < 100, fmt(eFm));
    check('and editing never stalls it visibly', eFm.max < 250 && eFm.over250 === 0, `worst ${ms(eFm.max)}`);
  }

  /* Where a split's time actually goes — the same seams timeline-perf measures,
   * read after the splits above have grown the clip list. */
  const bd = await js(`return window.VideoEditor.__test.renderCostBreakdown();`);
  if (!bad(bd)) {
    console.log(`    breakdown at ${bd.pxPerSec} px/s · ${bd.segs} clips · ${bd.caps} captions:`);
    console.log(`      segBlocks ${bd.segBlocks} · clipList ${bd.clipList} · textTrack ${bd.textTrack}`
      + ` · capTrack ${bd.capTrack} · audio ${bd.audio} · music ${bd.music} · ruler ${bd.ruler}`);
    console.log(`      (${bd.segNodes} clip nodes, ${bd.capNodes} caption nodes, track ${bd.trackW}px)`);
  }

  /* ---------------- [3b] what makes a split cost what it costs ----------
   * One thing varied at a time, on the timeline that is already loaded. */
  head('[3b] Bisecting the split cost');
  const splitCost = `
    const out = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      T.split(220 + i * 250);
      out.push(performance.now() - t0);
      await new Promise(r => setTimeout(r, 20));
      T.undo();
      await new Promise(r => setTimeout(r, 20));
    }
    out.sort((a, b) => a - b);
    return { med: Math.round(out[4]), worst: Math.round(out[out.length - 1]) };`;
  const withCaps = await js(`const T = window.VideoEditor.__test;` + splitCost);
  const noCaps = await js(`
    const T = window.VideoEditor.__test;
    T._saved = T.capLines();
    T.setCapEvents([], 0);
    await new Promise(r => requestAnimationFrame(r));
    ${splitCost}`);
  await js(`const T = window.VideoEditor.__test; T.setCapEvents(T._saved, 0); return 1;`);
  const renders = await js(`
    const T = window.VideoEditor.__test;
    const n = T.countRenders(() => T.split(3000));
    T.undo();
    // and how long each PART of one render takes, at this zoom
    const bd = T.renderCostBreakdown();
    return { n, bd };`);
  if (!bad(renders)) {
    console.log(`    one split triggers ${renders.n} timeline render(s)`);
    const b = renders.bd;
    console.log(`    one render: segBlocks ${b.segBlocks} · clipList ${b.clipList} · capTrack ${b.capTrack}`
      + ` · audio ${b.audio} · ruler ${b.ruler}  (sum ${(b.segBlocks + b.clipList + b.capTrack + b.audio + b.ruler + b.music + b.textTrack).toFixed(1)} ms)`);
  }
  if (!bad(withCaps) && !bad(noCaps)) {
    console.log(`    with ${CAPS} caption lines: median ${ms(withCaps.med)}  worst ${ms(withCaps.worst)}`);
    console.log(`    with no captions at all:   median ${ms(noCaps.med)}  worst ${ms(noCaps.worst)}`);
    console.log(`    -> captions account for ${ms(withCaps.med - noCaps.med)} of a split`);
  } else {
    console.log('    (bisect unavailable: ' + String((withCaps && withCaps.__error) || (noCaps && noCaps.__error) || '').slice(0, 160) + ')');
  }

  /* ---------------- [4] a long session ---------------- */
  head('[4] A long editing session — drift and leaks');
  const drift = await js(`
    const T = window.VideoEditor.__test;
    const sample = () => { const t = performance.now(); T.seekAndRefresh(1000 + Math.random() * 100); T.flushRender && T.flushRender(); return performance.now() - t; };
    const early = []; for (let i = 0; i < 5; i++) { early.push(sample()); await new Promise(r => setTimeout(r, 20)); }
    const nodes0 = document.getElementsByTagName('*').length;
    for (let i = 0; i < 200; i++) { T.seekAndRefresh((i / 200) * ${DUR}); if (i % 20 === 0) await new Promise(r => setTimeout(r, 5)); }
    const late = []; for (let i = 0; i < 5; i++) { late.push(sample()); await new Promise(r => setTimeout(r, 20)); }
    const nodes1 = document.getElementsByTagName('*').length;
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    return { early: avg(early), late: avg(late), nodes0, nodes1 };`);
  if (bad(drift)) check('long session measured', false, drift.__error);
  else {
    console.log(`    a seek before 200 seeks: ${ms(drift.early)}   after: ${ms(drift.late)}`);
    console.log(`    DOM nodes ${drift.nodes0} -> ${drift.nodes1}`);
    check('the studio does not get slower the longer it is used',
      drift.late < Math.max(drift.early * 1.8, drift.early + 20), `${ms(drift.early)} -> ${ms(drift.late)}`);
    check('no DOM leak over 200 seeks', drift.nodes1 < drift.nodes0 * 1.25 + 200,
      `${drift.nodes0} -> ${drift.nodes1}`);
  }

  /* ---------------- [5] still answering ---------------- */
  head('[5] The studio is still answering');
  const alive = await Promise.race([
    js(`return { ok: true, segs: window.VideoEditor.__test.segments().length };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('the studio still answers after everything above',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung' : 'responsive');

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
