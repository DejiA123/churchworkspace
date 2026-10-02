'use strict';
/*
 * "TEST THAT THE SOFTWARE WON'T FREEZE AGAIN."
 *
 * The five existing freeze tests cover the five studios — and not one line of
 * what was added in v2.26.8 and v2.27.0, because none of them loads presenter,
 * main.js or the Songs Bank. Two of those additions are exactly the shape that
 * has frozen this app before:
 *
 *   THE CABLE WATCHDOG runs FOREVER, every 1.5 s, on the main process — the one
 *     thread that also serves every studio and drives the projector windows.
 *     It calls into Windows (QueryDisplayConfig) through FFI. A blocking OS
 *     call on a timer is precisely how you freeze a desk mid-service, and it
 *     would do it during the service, not while anybody was testing.
 *   presenter.state() now READS THE CABLES on the way past, and it is called on
 *     every output opening, closing or moving.
 *   THE SONGS BANK renders 100+ rows, re-renders on every keystroke in its
 *     search box, and re-renders again on every playlist edit while it is open
 *     — the same "one edit rebuilds the whole grid" shape that made typing
 *     freeze the studio for 3.7 s in v2.26.2.
 *
 * So this measures those three, plus the disk: banking fifty songs must not be
 * fifty synchronous writes on the main thread.
 *
 * Percentiles AND the worst gap, for the reason golive-freeze.test.js spells
 * out: on a two-core laptop the single worst gap in any window is regularly
 * decided by something that is not this app.
 *
 *   npm run test:freeze-new
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const presenter = require(path.join(ROOT, 'src/main/presenter'));
const topology = require(path.join(ROOT, 'src/main/screen-topology'));
const songbank = require(path.join(ROOT, 'src/main/songbank'));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-newfreeze-'));
const ok = (d) => ({ ok: true, data: d });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => Math.round(n) + ' ms';
let pass = 0, fail = 0;
const check = (name, okv, detail) => {
  console.log((okv ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  okv ? pass++ : fail++;
};
const head = (s) => console.log('\n' + s);
const pct = (arr) => {
  const a = arr.slice().sort((x, y) => x - y);
  const at = (q) => a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0;
  return { n: a.length, p50: at(0.5), p95: at(0.95), max: a[a.length - 1] || 0 };
};
const fmt = (p) => `p50 ${ms(p.p50)} · p95 ${ms(p.p95)} · worst ${ms(p.max)}`;

/*
 * THE MAIN-PROCESS METER.
 *
 * A 10 ms timer that records how late it actually fired. Anything that blocks
 * the main thread — an FFI call into the OS, a synchronous write, a big JSON
 * parse — shows up here as lateness, which is what a frozen window is.
 */
const meter = { on: false, all: [] };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - mainLast - 10;
  mainLast = now;
  if (meter.on && late > 0) meter.all.push(late);
}, 10);
const meterStart = () => { meter.all = []; mainLast = Date.now(); meter.on = true; };
const meterStop = () => { meter.on = false; return pct(meter.all); };

/* ------------------------------ studio stubs ------------------------------ */
ipcMain.handle('settings:get', () => ok({ brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('settings:update', () => ok({}));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'live:screenSources', 'bible:installed', 'bible:catalogue', 'bible:books']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
let store = { presentations: [], playlists: [], themes: [] };
ipcMain.handle('present:library', () => ok(store));
ipcMain.handle('present:savePresentation', wrap((e, { presentation }) => presentation));
ipcMain.handle('present:deletePresentation', wrap(() => true));
ipcMain.handle('present:savePlaylist', wrap((e, { playlist }) => playlist));
ipcMain.handle('present:deletePlaylist', wrap(() => true));
ipcMain.handle('present:saveThemes', wrap((e, { themes }) => themes));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('phone:state', () => ok({ running: false }));
ipcMain.handle('bgvideo:installed', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));
ipcMain.handle('live:destinations', () => ok({ qualities: [], groups: [], audio: [] }));
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async (a) => ({})));
ipcMain.handle('present:close', wrap(async () => presenter.state()));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async () => true));
ipcMain.handle('songbank:list', wrap(async () => ({ songs: songbank.list(), themes: songbank.THEMES })));
ipcMain.handle('songbank:save', wrap(async (e, { song }) => { songbank.save(song); return songbank.list(); }));
ipcMain.handle('songbank:remove', wrap(async (e, { id }) => songbank.remove(id)));
ipcMain.handle('songbank:merge', wrap(async (e, { songs }) => ({ result: songbank.merge(songs), songs: songbank.list() })));

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  console.log('== WILL IT FREEZE? — the projector watchdog and the Songs Bank ==');
  songbank.init(WORK);

  /* ================= [1] the watchdog that runs forever ================== */
  head('[1] The cable watchdog — every 1.5 s, on the thread everything shares');
  // The exact reading main.js does on its timer.
  const sig = () => {
    const ds = screen.getAllDisplays()
      .map((d) => d.id + '@' + d.bounds.x + ',' + d.bounds.y + '/' + d.size.width + 'x' + d.size.height)
      .sort().join('|');
    return ds + '#' + topology.signature();
  };
  /*
   * The FIRST reading is measured on its own, because it is a different event:
   * it loads koffi and binds user32, and that cost is paid once. main.js takes
   * it deliberately inside app.whenReady(), BEFORE the first window exists, so
   * in the shipped app it lands in startup where there is nothing to freeze.
   * Averaged into the other 399 it would hide behind the mean; left in the
   * worst-case it would look like a stall that recurs. It is neither.
   */
  const tCold = process.hrtime.bigint();
  sig();
  const cold = Number(process.hrtime.bigint() - tCold) / 1e6;
  const one = [];
  for (let i = 0; i < 400; i++) { const t = process.hrtime.bigint(); sig(); one.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const p1 = pct(one);
  console.log(`    binding the OS call, once, during startup: ${cold.toFixed(1)} ms`);
  console.log(`    every reading after that: ${fmt(p1)}   (n=${p1.n})`);
  check('the one-time cost of binding it is paid at startup, and is small', cold < 250, cold.toFixed(1) + ' ms, once');
  // A tick every 1.5 s, forever. The honest unit is "how much of an hour".
  const perHour = (p1.p50 * (3600 / 1.5)) / 1000;
  console.log(`    a whole hour of watching the cables: ${perHour.toFixed(2)} s of CPU`);
  check('one reading of the cables is sub-millisecond', p1.p50 < 2, `p50 ${p1.p50.toFixed(3)} ms`);
  check('and even its worst reading could not be seen', p1.max < 50, `worst ${p1.max.toFixed(1)} ms`);
  check('an hour of watching costs under a second of CPU', perHour < 1, perHour.toFixed(2) + ' s/hour');

  // Now the real thing: the timer installed, running, while the main process is
  // asked to do real work — which is the only arrangement that could freeze.
  let ticks = 0;
  let lastSig = sig();
  const watch = setInterval(() => { const s = sig(); ticks++; if (s !== lastSig) lastSig = s; }, 1500);
  meterStart();
  await sleep(9000);
  const mWatch = meterStop();
  console.log(`    ${ticks} ticks in 9 s · main thread lateness ${fmt(mWatch)}`);
  check('the watchdog really ran', ticks >= 5, ticks + ' ticks');
  check('and never blocked the main thread past a frame', mWatch.p95 < 20, fmt(mWatch));
  check('nor stalled it even once', mWatch.max < 120, `worst ${ms(mWatch.max)}`);

  /* =============== [2] presenter.state(), on every output change ========= */
  head('[2] presenter.state() — it now reads the cables on the way past');
  const st = [];
  for (let i = 0; i < 300; i++) { const t = process.hrtime.bigint(); presenter.state(); st.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const p2 = pct(st);
  console.log(`    ${fmt(p2)}   (n=${p2.n})`);
  check('asking what the outputs are doing stays instant', p2.p95 < 5, fmt(p2));
  check('and never blocks long enough to drop a frame', p2.max < 60, `worst ${ms(p2.max)}`);
  // 300 calls in a burst must not be 300 trips into the OS: the reading is
  // cached for 250 ms precisely so a flurry of refreshes costs one.
  const burst = st.reduce((a, b) => a + b, 0);
  console.log(`    300 back-to-back calls: ${burst.toFixed(1)} ms total`);
  check('a burst of them costs about one reading, not three hundred', burst < 300, burst.toFixed(1) + ' ms for 300');

  /* ============ [3] banking songs must not hammer the disk =============== */
  head('[3] Banking fifty songs — writes are debounced, not one per song');
  const bankFile = path.join(WORK, 'song-bank.json');
  let writes = 0;
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = function (p, ...rest) { if (String(p) === bankFile) writes++; return realWrite.call(this, p, ...rest); };
  meterStart();
  const t3 = Date.now();
  for (let i = 0; i < 50; i++) songbank.save({ title: 'Test Song ' + i, author: 'Us', words: 'Verse 1\nline\nline' });
  const saveMs = Date.now() - t3;
  await sleep(900);           // let the debounce fire
  const mBank = meterStop();
  songbank.flushSync();
  fs.writeFileSync = realWrite;
  console.log(`    50 saves in ${saveMs} ms · ${writes} disk write(s) · main lateness ${fmt(mBank)}`);
  check('banking fifty songs is instant', saveMs < 250, ms(saveMs));
  check('and does NOT write the file fifty times', writes <= 3, writes + ' write(s) for 50 saves');
  check('the main thread never stalls while banking', mBank.max < 150, `worst ${ms(mBank.max)}`);
  const saved = JSON.parse(fs.readFileSync(bankFile, 'utf8'));
  check('and every one of them is actually on disk', (saved.songs || []).length >= 50, (saved.songs || []).length + ' saved');

  // A big bank is what a church has after two years. Reading it must stay cheap.
  const rd = [];
  for (let i = 0; i < 200; i++) { const t = process.hrtime.bigint(); songbank.list(); rd.push(Number(process.hrtime.bigint() - t) / 1e6); }
  const p3 = pct(rd);
  console.log(`    listing a ${songbank.list().length}-song bank: ${fmt(p3)}`);
  check('listing a big bank is cheap enough to do on every render', p3.p95 < 15, fmt(p3));

  /* ================== [4] the Songs Bank in the studio =================== */
  head('[4] The Songs Bank pane — typing, filtering, and adding to a service');
  /*
   * `backgroundThrottling: false` IS THE MEASUREMENT, not a detail.
   *
   * Chromium throttles timers in a window that is not in front to ONE A SECOND.
   * The meter below is a 10 ms timer, so an unfocused window turns every single
   * sample into a ~1000 ms "gap" and this test then reports three confident
   * freezes of 992, 1005 and 993 ms that never happened. That is exactly what
   * it did when run as part of a sweep rather than by hand — and the giveaway
   * was the numbers being identical rather than scattered.
   *
   * The shipped main window sets this too (main.js), as does every other freeze
   * test, so this matches what is actually measured in the app.
   */
  const win = new BrowserWindow({
    show: true, width: 1500, height: 940,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false },
  });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1600);
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`);
  const bad = (r) => r && r.__error;

  await js(`
    window.__fm = { on: false, last: 0, all: [] };
    setInterval(() => {
      const now = performance.now();
      if (window.__fm.on && window.__fm.last) { const late = now - window.__fm.last - 10; if (late > 0) window.__fm.all.push(late); }
      window.__fm.last = now;
    }, 10);
    window.__fmStart = () => { window.__fm.all = []; window.__fm.last = performance.now(); window.__fm.on = true; };
    window.__fmStop = () => {
      window.__fm.on = false;
      const a = window.__fm.all.slice().sort((x, y) => x - y);
      const at = (q) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0);
      /* This catches the METER lying rather than the app freezing: if a 10 ms
       * timer only ever fired about once a second, every sample is the throttle
       * and none of them is a freeze. Reported, never silently swallowed — a
       * suppressed measurement is worse than a wrong one.
       * (No backticks in here: this whole block lives inside a template literal.) */
      const ticks = a.length;
      const throttled = ticks > 0 && a.filter((x) => x > 900 && x < 1100).length > ticks * 0.5;
      return { n: ticks, throttled, p50: at(0.5), p95: at(0.95),
        max: Math.round(a[a.length - 1] || 0), over250: a.filter((x) => x > 250).length };
    };
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r => setTimeout(r, 500));
    return 1;`);

  const opened = await js(`return await window.Presenter.__test.openBank();`);
  if (bad(opened)) { console.error(opened.__error); app.exit(1); return; }
  console.log(`    the bank holds ${opened} songs`);
  check('a two-year-old bank is loaded', opened >= 150, opened + ' songs');

  // Typing in the search box re-renders the whole list on EVERY keystroke —
  // the shape that froze the studio for 3.7 s in v2.26.2.
  await js('window.__fmStart(); return 1;');
  const typed = await js(`
    const T = window.Presenter.__test;
    const q = 'goodness of god';
    const per = [];
    for (let i = 1; i <= q.length; i++) {
      const t = performance.now();
      T.bankSearch(q.slice(0, i));
      per.push(performance.now() - t);
      await new Promise(r => setTimeout(r, 30));
    }
    return per;`);
  const fType = await js('return window.__fmStop();');
  if (bad(typed)) check('typing measured', false, typed.__error);
  else {
    const p = pct(typed);
    console.log(`    ${typed.length} keystrokes: ${fmt(p)}   renderer gaps ${fType.p50} / ${fType.p95} / worst ${fType.max} ms (n=${fType.n}${fType.throttled ? ', THROTTLED' : ''})`);
    check('every keystroke in the search box redraws in under a frame', p.p95 < 40, fmt(p));
    check(fType.throttled ? 'the frame meter was NOT throttled (measurement is valid)' : 'and typing never freezes the studio',
      !fType.throttled && fType.max < 250 && fType.over250 === 0,
      fType.throttled ? 'meter throttled to 1/s — window was not in front, numbers are meaningless' : `worst ${ms(fType.max)}`);
  }

  // Flipping filters, then adding songs to the service — each add re-renders
  // the playlist AND the bank, because the bank ticks what is already in.
  await js('window.__fmStart(); return 1;');
  const worked = await js(`
    const T = window.Presenter.__test;
    T.bankSearch('');
    const chips = T.bankChips().map(c => c.id);
    const per = [];
    for (const c of chips) { const t = performance.now(); T.bankPickChip(c); per.push(performance.now() - t); }
    T.bankPickChip('all');
    const rows = T.bankRows().slice(0, 12);
    const adds = [];
    for (const r of rows) { const t = performance.now(); await T.bankAddToService(r.id); adds.push(performance.now() - t); }
    return { chips: per, adds, service: T.bankRows().filter(r => r.inService).length };`);
  const fWork = await js('return window.__fmStop();');
  if (bad(worked)) check('filtering measured', false, worked.__error);
  else {
    const pc = pct(worked.chips), pa = pct(worked.adds);
    console.log(`    ${worked.chips.length} filters: ${fmt(pc)}`);
    console.log(`    12 songs added to the service: ${fmt(pa)}   renderer gaps ${fWork.p50} / ${fWork.p95} / worst ${fWork.max} ms (n=${fWork.n}${fWork.throttled ? ', THROTTLED' : ''})`);
    check('switching a filter is instant', pc.p95 < 40, fmt(pc));
    check(fWork.throttled ? 'the frame meter was NOT throttled (measurement is valid)' : 'adding a song to the service never stalls the studio',
      !fWork.throttled && fWork.max < 300 && fWork.over250 === 0,
      fWork.throttled ? 'meter throttled to 1/s — numbers are meaningless' : `worst ${ms(fWork.max)}`);
    check('and the songs really went in', worked.service >= 10, worked.service + ' in the service');
  }

  /* ================= [5] a long service, with all of it open ============= */
  head('[5] Two hours later — does any of it drift or leak?');
  await js('window.__fmStart(); return 1;');
  const drift = await js(`
    const T = window.Presenter.__test;
    const before = document.querySelectorAll('*').length;
    const t0 = performance.now(); T.bankSearch('a'); const first = performance.now() - t0;
    const each = [];
    for (let i = 0; i < 150; i++) {
      const t = performance.now();
      T.bankSearch(i % 2 ? 'a' : 'o');
      each.push(performance.now() - t);
      // A person types with gaps between the keys. A 150-iteration loop with no
      // yield is ONE task however fast the work inside it is, so it would report
      // its own total as a freeze no matter what the code did — it measures the
      // loop, not the app. Yielding is what makes this sustained USE.
      if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
    }
    T.bankSearch('');
    const t1 = performance.now(); T.bankSearch('a'); const last = performance.now() - t1;
    T.bankSearch('');
    return { first, last, before, after: document.querySelectorAll('*').length,
      worstRedraw: Math.max(...each), sumRedraw: each.reduce((a, b) => a + b, 0) };`);
  const fDrift = await js('return window.__fmStop();');
  if (bad(drift)) check('drift measured', false, drift.__error);
  else {
    console.log(`    a redraw before 150 more: ${ms(drift.first)}  after: ${ms(drift.last)} · DOM ${drift.before} -> ${drift.after}`);
    console.log(`    150 redraws: ${ms(drift.sumRedraw)} of work in total, worst single redraw ${ms(drift.worstRedraw)}`);
    check('the bank does not get slower the more it is used', drift.last < Math.max(40, drift.first * 3),
      `${ms(drift.first)} -> ${ms(drift.last)}`);
    check('and leaks no DOM behind it', drift.after <= drift.before + 60, `${drift.before} -> ${drift.after}`);
    check('no single redraw is ever close to visible', drift.worstRedraw < 50, `worst ${ms(drift.worstRedraw)}`);
    check(fDrift.throttled ? 'the frame meter was NOT throttled (measurement is valid)' : '150 redraws never froze the window',
      !fDrift.throttled && fDrift.max < 250,
      fDrift.throttled ? 'meter throttled to 1/s — numbers are meaningless' : `worst ${ms(fDrift.max)}`);
  }

  // The watchdog has been ticking through all of the above.
  console.log(`    the cable watchdog ticked ${ticks} times during this test`);
  check('the watchdog was running the whole time and nothing above stalled', ticks > 10, ticks + ' ticks');
  clearInterval(watch);

  /* ======================= [6] everything still answers ================== */
  head('[6] Still answering');
  const alive = await js(`
    const T = window.Presenter.__test;
    return { bank: T.bankRows().length, slides: T.slideDom(), screens: (window.Presenter.__test.screenAdvice() || {}).state };`);
  check('the studio still answers after all of it', !bad(alive) && alive.bank > 0, JSON.stringify(alive));

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  try { songbank.flushSync(); } catch (e) {}
  await sleep(200);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
