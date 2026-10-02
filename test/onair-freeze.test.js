'use strict';
/*
 * ON AIR — the only test that matches an actual Sunday morning.
 *
 * The other freeze tests load the studios but never turn the encoder on. That
 * is the gap that matters: recording and streaming are the heaviest thing this
 * app does, and they run for the whole service, on the same machine, while the
 * operator is cueing lyrics and cutting cameras. A studio that is responsive
 * while idle and jammed while broadcasting is a studio that only fails when it
 * counts.
 *
 * So: eight inputs compositing, RECORDING to disk, STREAMING to a real local
 * RTMP receiver, a projector window open, an 80-slide deck — and then the two
 * things an operator actually does, measured:
 *   • cue the next lyric slide,
 *   • cut to another camera.
 *
 * Both threads are watched, because they fail differently: the renderer holds
 * the compositor and the controls, and main is shared with the projector, the
 * stage screen and the encoder plumbing.
 *
 * It also checks the broadcast SURVIVED being used — a desk that stays smooth
 * by dropping the recording is not a desk that works.
 *
 *   npm run test:onair-freeze
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Store } = require(path.join(ROOT, 'src/main/store'));
const presenter = require(path.join(ROOT, 'src/main/presenter'));
const ffmod = require(path.join(ROOT, 'src/main/ffmpeg'));
const FF = ffmod.resolveFfmpeg();

const WORK = path.join(os.tmpdir(), 'mw-onair-freeze');
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
  console.log(`\n  !! WATCHDOG: still in "${stage}" after 300 s — treating as a hang.`);
  console.log(`  ${pass} PASS / ${fail + 1} FAIL`);
  app.exit(1);
}, 300000);

/* main-process heartbeat — shared with the projector AND the encoder plumbing */
const mainMeter = { on: false, all: [] };
let mainLast = Date.now();
setInterval(() => {
  const now = Date.now(); const late = now - mainLast - 10; mainLast = now;
  if (mainMeter.on && late > 0) mainMeter.all.push(late);
}, 10);
const mainStart = () => { mainMeter.all = []; mainLast = Date.now(); mainMeter.on = true; };
const mainStop = () => {
  mainMeter.on = false;
  const a = mainMeter.all.slice().sort((x, y) => x - y);
  const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0);
  return { p50: q(0.5), p95: q(0.95), max: Math.round(a[a.length - 1] || 0) };
};

function freePort() {
  return new Promise((res) => {
    const sv = net.createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

const store = new Store(path.join(WORK, 'workstation.json'),
  { settings: {}, presentations: [], playlists: [], presentThemes: [] });
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a = {}) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const deck = (k) => (store.get(k) || []);

/* The REAL livestream + recorder main-process wiring, not a stub — the whole
 * point is to have an encoder running. */
const { ProgramHub, LiveStream, DESTINATIONS, QUALITIES, buildUrl, detectEncoder, encoderLabel } =
  require(path.join(ROOT, 'src/main/livestream'));

ipcMain.handle('present:library', wrap(async () => ({
  presentations: deck('presentations'), playlists: deck('playlists'), themes: deck('presentThemes') })));
ipcMain.handle('present:savePresentation', wrap(async (e, { presentation }) => {
  const l = deck('presentations').slice(); const i = l.findIndex((p) => p.id === presentation.id);
  if (i >= 0) l[i] = presentation; else l.unshift(presentation);
  store.set('presentations', l); return presentation;
}));
ipcMain.handle('present:savePlaylist', wrap(async (e, { playlist }) => playlist));
ipcMain.handle('present:saveThemes', wrap(async (e, { themes }) => themes || []));
ipcMain.handle('present:deletePresentation', wrap(async () => true));
ipcMain.handle('present:deletePlaylist', wrap(async () => true));
ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
ipcMain.handle('present:open', wrap(async (e, a) => Object.assign(presenter.open(a || {}), { state: presenter.state() })));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async (e, patch) => { presenter.setState(patch || {}); return true; }));
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {}, present: { translation: 'kjv' } }));
ipcMain.handle('settings:update', (e, p) => ok(p));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: FF, ffprobe: ffmod.resolveFfprobe(), fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('live:metrics', () => ok({ cpu: 40, appCpu: 20 }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed',
  'bible:catalogue', 'bible:books', 'live:screenSources', 'bgvideo:installed', 'bgvideo:list',
  'captions:models', 'present:outputs', 'ndi:list']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
for (const ch of ['webout:state', 'ndiout:state', 'ndi:status', 'dmx:state', 'phone:state'])
  ipcMain.handle(ch, () => ok({ running: false, available: false, feeds: [] }));
ipcMain.handle('video:thumbnail', () => ({ ok: false, error: 'n/a' }));

/* --- the program hub, wired exactly as main.js wires it ---
 * One capture in the renderer, one encode in the hub, many consumers hanging
 * off it. Anything less than the real wiring and this measures a desk that is
 * NOT broadcasting — which is exactly what the first run of this file did: it
 * reported green "cueing on air" numbers while nothing was encoding at all,
 * because `program:session` had no handler. A performance test that silently
 * measures the wrong state is worse than no test. */
const ctx = { ffmpeg: FF, ffprobe: ffmod.resolveFfprobe() };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    if (type === 'ended' && payload && payload.error) console.log(`   [event] ${id} ended: ${payload.error}`);
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: 'auto' })), sid: a.sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url: buildUrl({ dest, key, customUrl }), q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying };
}));
ipcMain.on('live:chunk', (e, payload) => {
  try { hub.write(payload && payload.sid, Buffer.from(payload && payload.buf ? payload.buf : payload)); } catch (er) {}
});
ipcMain.handle('live:stop', wrap(async (e, { destId } = {}) => {
  if (destId) await hub.removeOutput(destId);
  else await Promise.all([...hub.outputs.keys()].filter((id) => !isProgramRec(id)).map((id) => hub.removeOutput(id)));
  if (!hub.outputCount) await hub.stop();
  return true;
}));
ipcMain.handle('live:state', wrap(async () => {
  const out = {};
  for (const id of hub.outputs.keys()) if (!isProgramRec(id)) out[id] = hub.outputState(id);
  return out;
}));
ipcMain.handle('live:copyCheck', wrap(async () => ({ ok: true })));
ipcMain.handle('live:pickScreen', () => ok(true));
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const file = path.join(WORK, `${String(name || 'rec').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`);
  wireHub(e.sender);
  hubRecFiles.set(recId, file);
  hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps });
  return { file };
}));
ipcMain.on('rec:chunk', () => {});
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  await hub.removeOutput(recId);
  if (!hub.outputCount) await hub.stop();
  return true;
}));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const uid = () => 'x' + Math.random().toString(36).slice(2, 10);
const LYRIC = ['Amazing grace, how sweet the sound', 'That saved a wretch like me',
  'I once was lost, but now am found', 'Was blind, but now I see'];
const makeDoc = (name, n) => ({
  id: uid(), name, kind: 'song', updated: Date.now(),
  slides: Array.from({ length: n }, (_, i) => ({
    id: uid(), group: ['Verse 1', 'Chorus', 'Bridge'][i % 3], lines: LYRIC.slice(0, 2 + (i % 3)),
    footer: '', notes: '', bg: null, look: null })),
});

app.whenReady().then(async () => {
  at('starting a local RTMP receiver (a stand-in for the platform)');
  const port = await freePort();
  const recv = spawn(FF, ['-y', '-loglevel', 'error', '-listen', '1', '-timeout', '200',
    '-i', `rtmp://127.0.0.1:${port}/live/app1`, '-c', 'copy', '-f', 'flv', path.join(WORK, 'received.flv')],
    { windowsHide: true });
  recv.stderr.on('data', () => {});
  await sleep(1500);

  store.set('presentations', [makeDoc('Opening set', 80)]);
  store.flushSync();

  at('opening the app');
  const win = new BrowserWindow({ width: 1520, height: 950, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true,
      sandbox: false, backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  presenter.setNotifier(() => { if (win && !win.isDestroyed()) win.webContents.send('present:outputs', presenter.state()); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1800);

  const js = (code) => Promise.race([
    win.webContents.executeJavaScript(`(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) + '\\n' + (e && e.stack || '') }; } })()`),
    sleep(60000).then(() => ({ __error: 'executeJavaScript timed out' })),
  ]);
  const bad = (r) => r && r.__error;

  await js(`
    window.__fm = { on: false, last: 0, all: [] };
    setInterval(() => {
      const now = performance.now();
      if (window.__fm.on && window.__fm.last) { const l = now - window.__fm.last - 10; if (l > 0) window.__fm.all.push(l); }
      window.__fm.last = now;
    }, 10);
    window.__fmStart = () => { window.__fm.all = []; window.__fm.last = performance.now(); window.__fm.on = true; };
    window.__fmStop = () => {
      window.__fm.on = false;
      const a = window.__fm.all.slice().sort((x, y) => x - y);
      const q = (p) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * p))] || 0);
      return { n: a.length, p50: q(0.5), p95: q(0.95), max: Math.round(a[a.length - 1] || 0), over250: a.filter((x) => x > 250).length };
    };
    return 1;`);
  const fmt = (f) => `p50 ${ms(f.p50)} · p95 ${ms(f.p95)} · worst ${ms(f.max)}`;

  at('building the switcher and the service');
  const built = await js(`
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise(r=>setTimeout(r,500));
    const L = window.LiveStudio.__test;
    for (let i = 1; i <= 6; i++) L.addSynthetic('Camera ' + i, i * 40);
    L.addColor('Announcements', '#2244cc');
    L.addTitle({ headline: 'Sunday Service', subtext: 'Grace Chapel', style: 'lower' });
    await new Promise(r=>setTimeout(r,1200));
    document.querySelector('.nav-item[data-view="present"]').click();
    await new Promise(r=>setTimeout(r,700));
    await window.Presenter.__test.clickGoLive();
    await new Promise(r=>setTimeout(r,800));
    return { inputs: window.LiveStudio.__test.state().inputs.length,
             slides: document.querySelectorAll('#pvSlides .pv-slide').length };`);
  if (bad(built)) { check('the Sunday desk is set up', false, built.__error); }
  else check('a switcher, a projector and an 80-slide service are all up',
    built.inputs >= 7 && built.slides >= 80, `${built.inputs} inputs, ${built.slides} slides`);

  /* ---------------- baseline: off air ---------------- */
  head('[1] Cueing lyrics — OFF AIR (the baseline)');
  mainStart(); await js('window.__fmStart(); return 1;');
  const off = await js(`
    const T = window.Presenter.__test; const out = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); T.step(1); out.push(performance.now() - t); await new Promise(r=>setTimeout(r,60)); }
    return out;`);
  const offFm = await js('return window.__fmStop();'); const offMain = mainStop();
  const offWorst = bad(off) ? null : Math.max(...off);
  console.log(`    per cue worst ${ms(offWorst)}   renderer ${fmt(offFm)}   main ${ms(offMain.max)}`);
  check('cueing is responsive before anything is broadcasting', offFm.p95 < 60, fmt(offFm));

  /* ---------------- ON AIR: recording + streaming ---------------- */
  at('starting the recording and the stream');
  const onair = await js(`
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise(r=>setTimeout(r,400));
    const T = window.LiveStudio.__test;
    document.getElementById('vmxRecord').click();
    await new Promise(r=>setTimeout(r,3500));
    await T.setStreamSlot(1, { dest: 'custom', key: 'app1', customUrl: 'rtmp://127.0.0.1:${port}/live', quality: '720p' });
    await T.startStreamNum(1);
    await new Promise(r=>setTimeout(r,6000));
    const s = T.state();
    return { recording: s.recording, streaming: s.streaming, encoders: s.programEncoders,
             consumers: s.programConsumers, fps: s.fps, mode: s.captureMode, label: s.encoderLabel };`);
  if (bad(onair)) { check('the broadcast started', false, onair.__error); }
  else {
    console.log(`    recording=${onair.recording} streaming=${onair.streaming} · ${onair.encoders} encode for ${onair.consumers} consumers · capture ${onair.mode} · ${onair.label} · ${onair.fps} fps`);
    check('the desk is genuinely ON AIR — recording and streaming',
      onair.recording === true && onair.streaming === true, `rec=${onair.recording} stream=${onair.streaming}`);
    check('and it is ONE encode feeding both, not one each',
      onair.encoders === 1, `${onair.encoders} encoders for ${onair.consumers} consumers`);
  }

  head('[2] Cueing lyrics WHILE recording and streaming');
  await js(`document.querySelector('.nav-item[data-view="present"]').click(); await new Promise(r=>setTimeout(r,600)); return 1;`);
  mainStart(); await js('window.__fmStart(); return 1;');
  const on = await js(`
    const T = window.Presenter.__test; const out = [];
    for (let i = 0; i < 20; i++) { const t = performance.now(); T.step(1); out.push(performance.now() - t); await new Promise(r=>setTimeout(r,60)); }
    return out;`);
  const onFm = await js('return window.__fmStop();'); const onMain = mainStop();
  const onWorst = bad(on) ? null : Math.max(...on);
  console.log(`    per cue worst ${ms(onWorst)}   renderer ${fmt(onFm)}   main ${fmt(onMain)}`);
  console.log(`    vs off air:   per cue worst ${ms(offWorst)}   renderer p95 ${ms(offFm.p95)}`);
  check('cueing a lyric on air never stalls the studio past a quarter second',
    onFm.max < 250 && onFm.over250 === 0, fmt(onFm));
  check('a cue still lands inside 150 ms while broadcasting', onWorst < 150, `worst ${ms(onWorst)}`);
  check('the main process — shared with the projector — holds up on air',
    onMain.max < 250, `worst ${ms(onMain.max)}`);
  check('going on air costs a small multiple, not an order of magnitude',
    onFm.p95 <= Math.max(offFm.p95 * 4, offFm.p95 + 80),
    `p95 ${ms(offFm.p95)} off air -> ${ms(onFm.p95)} on air`);

  head('[3] Cutting cameras WHILE recording and streaming');
  await js(`document.querySelector('.nav-item[data-view="live"]').click(); await new Promise(r=>setTimeout(r,500)); return 1;`);
  mainStart(); await js('window.__fmStart(); return 1;');
  const cuts = await js(`
    const T = window.LiveStudio.__test;
    const ids = T.state().inputs.filter(i => i.type !== 'title').map(i => i.id);
    const out = [];
    for (let n = 0; n < 20; n++) {
      T.setPreview(ids[n % ids.length]);
      const t = performance.now();
      document.getElementById('vmxCut').click();
      out.push(performance.now() - t);
      await new Promise(r=>setTimeout(r,80));
    }
    return out;`);
  const cutFm = await js('return window.__fmStop();'); const cutMain = mainStop();
  if (bad(cuts)) check('cutting on air measured', false, cuts.__error);
  else {
    console.log(`    per cut worst ${ms(Math.max(...cuts))}   renderer ${fmt(cutFm)}   main ${fmt(cutMain)}`);
    check('cutting on air never stalls the desk past a quarter second',
      cutFm.max < 250 && cutFm.over250 === 0, fmt(cutFm));
    check('a cut still lands inside 100 ms while broadcasting',
      Math.max(...cuts) < 100, `worst ${ms(Math.max(...cuts))}`);
  }

  /* ---------------- did the broadcast survive being used? ---------------- */
  head('[4] The broadcast survived being operated');
  const after = await js(`
    const s = window.LiveStudio.__test.state();
    return { recording: s.recording, streaming: s.streaming, fps: s.fps, encoders: s.programEncoders,
             chunks: s.chunksSent, recChunks: s.recChunksSent,
             reconnecting: (s.streams || []).some(x => x.reconnecting) };`);
  console.log(`    still recording=${after.recording} streaming=${after.streaming} · compositor ${after.fps} fps · ${after.chunks} stream chunks, ${after.recChunks} recording chunks`);
  check('it is still recording after being operated', after.recording === true);
  check('it is still streaming, and never had to reconnect',
    after.streaming === true && !after.reconnecting, `reconnecting=${after.reconnecting}`);
  check('the compositor never stopped', after.fps > 0, `${after.fps} fps`);
  check('frames really went out to the platform', (after.chunks || 0) > 0, `${after.chunks} chunks`);

  at('stopping the broadcast');
  await js(`
    const T = window.LiveStudio.__test;
    await T.stopAllStreams();
    T.stopRecord();
    await new Promise(r=>setTimeout(r,3000));
    return 1;`);
  await sleep(2500);

  /* A recording that plays is the only proof the encode was real. */
  const recFile = fs.readdirSync(WORK).filter((f) => /\.(mp4|mkv|webm)$/i.test(f)).map((f) => path.join(WORK, f))
    .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
  const got = recFile ? fs.statSync(recFile).size : 0;
  const rx = fs.existsSync(path.join(WORK, 'received.flv')) ? fs.statSync(path.join(WORK, 'received.flv')).size : 0;
  console.log(`    recording on disk: ${(got / 1e6).toFixed(2)} MB   ·   received at the "platform": ${(rx / 1e6).toFixed(2)} MB`);
  check('the recording is a real file with real video in it', got > 200000, `${(got / 1e6).toFixed(2)} MB`);
  check('and the stream really arrived at the far end', rx > 100000, `${(rx / 1e6).toFixed(2)} MB received`);

  head('[5] Still answering');
  const alive = await Promise.race([
    js(`return { ok: true, inputs: window.LiveStudio.__test.state().inputs.length };`),
    sleep(5000).then(() => ({ __timeout: true })),
  ]);
  check('the app still answers after a broadcast',
    !!(alive && alive.ok), alive && alive.__timeout ? 'NO RESPONSE IN 5 s — hung' : 'responsive');

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  try { recv.kill(); } catch (e) {}
  try { presenter.shutdown(); } catch (e) {}
  try { hub.stop(); } catch (e) {}
  win.destroy();
  app.exit(fail ? 1 : 0);
});
