'use strict';
/*
 * GO LIVE — FULL END-TO-END TEST (the real user path, multi-destination edition).
 *
 * Boots the REAL app UI (index.html + preload + the REAL ProgramHub engine wired
 * to IPC exactly like main.js), stands up FOUR LOCAL RTMP ingest servers standing
 * in for real platforms, and:
 *   1. opens the 🔴 Go Live switcher and adds inputs
 *   2. clicks Stream with NOTHING configured → clear error + settings open
 *   3. configures destinations with different URLs/keys/qualities
 *   4. clicks Stream (Start All) → destinations 1+2 go live AT THE SAME TIME,
 *      from ONE shared program capture and ONE shared encode
 *   5. RECORDS at the same time too — and that must NOT add a second encoder
 *   6. ►► THE REGRESSION THIS TEST EXISTS FOR ◄◄ starts destination 3 LATE,
 *      well into the broadcast, while 1 and 2 are already on air. This is what
 *      used to fail with "Destination 3 stream ended: The camera feed could not
 *      be read" — a destination joining after the WebM header had gone by could
 *      never decode anything.
 *   6b. brings up a FOURTH destination and then kills its ingest server, to prove
 *      a platform dropping us mid-service reconnects on its own without touching
 *      the other destinations or the recording
 *   7. mid-broadcast: stops JUST destination 1 → the others keep running
 *   8. stops everything; PROBES every ingested file and the recording for real
 *      picture, real sound, the right resolution and the expected duration
 *
 * Every "is it live" check reads the encoder's own progress output rather than a
 * flag in the UI: a spawned process that never sends a byte is exactly the
 * failure this suite exists to catch.
 *
 * Run: npx electron test/live-e2e.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { ProgramHub, LiveStream, DESTINATIONS, QUALITIES, buildUrl, detectEncoder, encoderLabel } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');
const captioner = require('../src/main/captioner');
const video = require('../src/main/video');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
// Ports handed out by the OS rather than hard-coded: a receiver left behind by
// an earlier run would squat a fixed port, and on Windows whole blocks in the
// 19000-20000 range are commonly reserved by Hyper-V, so a guessed port can fail
// to bind for reasons that have nothing to do with the code under test.
const net = require('net');
function freePorts(n) {
  return new Promise((resolve) => {
    const servers = [], ports = [];
    const next = () => {
      if (ports.length === n) { servers.forEach((sv) => sv.close()); return resolve(ports); }
      const sv = net.createServer();
      sv.listen(0, '127.0.0.1', () => { ports.push(sv.address().port); servers.push(sv); next(); });
    };
    next();
  });
}
let PORTS = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-livee2e-'));
const outFlv = [1, 2, 3, 4].map((i) => path.join(tmp, `ingested${i}.flv`));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ---- IPC wiring: settings stubs + the REAL program hub (mirrors main.js) ---- */
let savedSettings = {
  brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' },
  accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on',
};
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP, fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:pickScreen', () => ok(true));
ipcMain.handle('live:metrics', wrap(async () => {
  const m = app.getAppMetrics();
  return { cpu: Math.round(m.reduce((s, p) => s + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) * 10) / 10 };
}));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const recorders = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';
const events = []; // every hub event, for assertions

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    events.push({ id, type, payload });
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
    if (type === 'ended' && isRec) hubRecFiles.delete(id);
  };
  hub.onHubEvent = (type, payload) => {
    events.push({ id: '__hub', type, payload });
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}

ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('program:session', wrap(async (e, { sid, width, height, videoKbps, audioKbps, fps, format }) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { sid, width, height, videoKbps, audioKbps, fps, format, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const url = buildUrl({ dest, key, customUrl });
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url, q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.on('live:chunk', (e, payload) => {
  const sid = payload && payload.sid;
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(sid, Buffer.from(raw)); } catch (er) {}
});
ipcMain.handle('live:stop', wrap(async (e, { destId } = {}) => {
  if (destId) await hub.removeOutput(destId);
  else for (const id of [...hub.outputs.keys()]) { if (!isProgramRec(id)) await hub.removeOutput(id); }
  if (!hub.outputCount) await hub.stop();
  return true;
}));
ipcMain.handle('live:state', wrap(async () => {
  const out = {};
  for (const id of hub.outputs.keys()) { if (!isProgramRec(id)) out[id] = hub.outputState(id); }
  return out;
}));
ipcMain.handle('live:engine', wrap(async () => {
  const enc = hub.running ? (hub.activeEncoder || hub.encoder) : await detectEncoder(FF, savedSettings.liveEncoder || 'auto');
  return { encoder: enc, label: encoderLabel(enc), hardware: enc !== 'libx264', preference: savedSettings.liveEncoder || 'auto', running: hub.running, outputs: hub.outputCount, gpu: true };
}));

ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`);
  if (isProgramRec(recId)) {
    wireHub(e.sender);
    hubRecFiles.set(recId, file);
    try { hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps }); }
    catch (err) { hubRecFiles.delete(recId); throw err; }
    return { file };
  }
  if (recorders.has(recId)) throw new Error('recorder busy');
  const rec = new LiveStream();
  rec.onEvent = (type, payload) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('rec:' + type, { recId, file, ...payload }); } catch (er) {}
    if (type === 'ended') recorders.delete(recId);
  };
  rec.start(ctx, { filePath: file, videoKbps: q.videoKbps, audioKbps: q.audioKbps, fps: q.fps || fps });
  recorders.set(recId, rec);
  return { file };
}));
ipcMain.on('rec:chunk', (e, { recId, buf }) => { const r = recorders.get(recId); if (r) { try { r.write(Buffer.from(buf)); } catch (er) {} } });
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  if (isProgramRec(recId)) { await hub.removeOutput(recId); hubRecFiles.delete(recId); if (!hub.outputCount) await hub.stop(); return true; }
  const r = recorders.get(recId); if (r) { await r.stop(); recorders.delete(recId); }
  return true;
}));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

/**
 * Playable duration, measured by DECODING rather than by reading the container
 * header. Destination 3's ingest is deliberately killed mid-stream to test
 * reconnection, which leaves its FLV without a finalised duration field.
 */
async function mediaDuration(file) {
  const r = await run(FF, ['-i', file, '-f', 'null', '-']);
  const m = [...r.out.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
}

/** Mean luma of the frame `atSec` into a file — proves real picture, not black. */
async function lumaAt(file, atSec) {
  const r = await run(FF, ['-i', file, '-vf', `select='gte(t,${atSec})',signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-']);
  return parseFloat((r.out.match(/YAVG=([\d.]+)/) || [])[1] || '0');
}

app.whenReady().then(async () => {
  console.log('== GO LIVE END-TO-END TEST (multi-destination, late join) ==');
  PORTS = await freePorts(4);
  console.log('   program encoder: ' + encoderLabel(await detectEncoder(FF, 'auto')));

  /* three local RTMP ingests — Facebook, YouTube and a custom server */
  const receivers = PORTS.map((port, i) => spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '120',
    '-i', `rtmp://127.0.0.1:${port}/live/app${i + 1}`, '-c', 'copy', '-f', 'flv', outFlv[i]], { windowsHide: true }));
  const recErr = ['', '', '', ''];
  receivers.forEach((r, i) => r.stderr.on('data', (d) => { recErr[i] += d.toString(); }));
  const receiversDone = receivers.map((r) => new Promise((res) => r.on('close', res)));
  await sleep(1500);

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);

  /* 1. open the switcher + add inputs */
  let r = await js(win, `
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const syn = ${T}.addSynthetic('Main Camera');
    ${T}.addColor('Announcements', '#2244cc');
    ${T}.addTitle({ headline: 'Sunday Service — LIVE', subtext: 'Grace Chapel', style: 'lower' });
    await new Promise((r2) => setTimeout(r2, 800));
    const s = ${T}.state();
    return { n: s.inputs.length, programId: s.programId, synId: syn.id, masterLevel: s.masterLevel, fps: s.fps };
  `);
  if (r.__error) console.error(r.__error);
  log(r.n === 3, 'switcher opens with camera + colour + title inputs', 'n=' + r.n);
  log(r.programId === r.synId, 'first input lands on PROGRAM automatically');
  await sleep(1200);
  r = await js(win, `const s = ${T}.state(); return { masterLevel: s.masterLevel, fps: s.fps, targetFps: s.targetFps };`);
  log(r.masterLevel > 0.02, 'program audio flowing (master meter live)', 'rms=' + r.masterLevel.toFixed(3));
  log(r.fps > 5, 'render loop running (' + r.fps + ' fps)');
  log(r.fps <= r.targetFps + 3, 'compositor runs at the production rate, not the display rate', `${r.fps} fps vs target ${r.targetFps}`);

  /* 2. Stream with NOTHING configured → friendly error, settings open, NOT live */
  r = await js(win, `
    document.getElementById('vmxStream').click();
    await new Promise((r2) => setTimeout(r2, 500));
    const s = ${T}.state();
    const modalOpen = !document.getElementById('vmxModal').classList.contains('hidden');
    const x = document.querySelector('#vmxModalBox .vmx-modal-x'); if (x) x.click();
    return { streaming: s.streaming, msg: s.statusMsg, modalOpen };
  `);
  if (r.__error) console.error(r.__error);
  log(!r.streaming && /destination/i.test(r.msg), 'Stream with nothing configured → clear message, not live', r.msg);
  log(r.modalOpen, 'Streaming Settings opens automatically');

  /* 3. configure THREE independent destinations at their own qualities */
  r = await js(win, `
    await ${T}.setStreamSlot(1, { dest: 'custom', key: 'app1', customUrl: 'rtmp://127.0.0.1:${PORTS[0]}/live', quality: '480p' });
    await ${T}.setStreamSlot(2, { dest: 'custom', key: 'app2', customUrl: 'rtmp://127.0.0.1:${PORTS[1]}/live', quality: '720p' });
    return ${T}.state().streams.slice(0, 2).map((s) => ({ num: s.num, key: s.key, quality: s.quality }));
  `);
  if (r.__error) console.error(r.__error);
  log(r[0].key === 'app1' && r[0].quality === '480p' && r[1].key === 'app2' && r[1].quality === '720p',
    'destinations configured with different keys/URLs/qualities', JSON.stringify(r));

  /* 4. Start All — destinations 1 and 2 go live at the same time */
  r = await js(win, `
    document.getElementById('vmxStream').click();
    await new Promise((r2) => setTimeout(r2, 3500));
    const s = ${T}.state();
    return {
      streams: s.streams.slice(0, 3).map((x) => ({ num: x.num, streaming: x.streaming })),
      canvas: ${T}.pgmSize(),
      encoders: s.programEncoders, consumers: s.programConsumers, encoderLabel: s.encoderLabel,
      btnOn: document.getElementById('vmxStream').classList.contains('on'),
      stShown: !document.getElementById('vmxStStream').classList.contains('hidden'),
    };
  `);
  if (r.__error) console.error(r.__error);
  log(r.streams && r.streams[0].streaming && r.streams[1].streaming, 'destinations 1 + 2 are live at once', JSON.stringify(r.streams));
  log(r.canvas[0] === 1280 && r.canvas[1] === 720, 'program canvas captures at the HIGHER of the two qualities (720p)', r.canvas.join('x'));
  log(r.btnOn && r.stShown, 'Stream button blinks red + status bar shows ◉ LIVE');
  log(r.encoders === 1, 'ONE program capture serves both destinations', 'captures=' + r.encoders);
  {
    // "Streaming" must mean bytes are moving to the platform, not merely that a
    // process was spawned — those are very different things to a live audience.
    for (const id of ['d1', 'd2']) {
      let conn = null;
      for (let i = 0; i < 80 && !conn; i++) {
        conn = events.find((ev) => ev.id === id && ev.type === 'connected');
        if (!conn) await sleep(250);
      }
      log(!!conn, `destination ${id.slice(1)} is really on air (its encoder is reporting live stats)`,
        conn ? 'connected' : 'never reported stats — log: ' + String((hub.outputs.get(id) || {}).lastLog || '').split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300));
    }
  }
  console.log('        program encoder in use: ' + r.encoderLabel);
  let engineState = await win.webContents.executeJavaScript('window.api.live.state()');
  log(Object.keys(engineState).length === 2, 'two independent push outputs are running', JSON.stringify(Object.keys(engineState)));

  /* 5. record at the SAME time — and it must NOT spin up a second encoder */
  r = await js(win, `
    document.getElementById('vmxRecord').click();
    await new Promise((r2) => setTimeout(r2, 1500));
    const s = ${T}.state();
    return { recording: s.recording, file: s.recFile, encoders: s.programEncoders, consumers: s.programConsumers };
  `);
  const recFile = r.file;
  log(r.recording === true && !!recFile, 'Record runs at the same time as both streams', recFile && path.basename(recFile));
  log(r.encoders === 1 && r.consumers === 3,
    'recording shares the SAME single program encode (no extra encoder)', `captures=${r.encoders} consumers=${r.consumers}`);

  await sleep(6000);

  /* 6. ►► THE REGRESSION ◄◄ — bring destination 3 up LATE, mid-broadcast */
  console.log('  -- starting destination 3 six seconds into the live broadcast --');
  const lateJoinAt = Date.now();
  r = await js(win, `
    await ${T}.setStreamSlot(3, { dest: 'custom', key: 'app3', customUrl: 'rtmp://127.0.0.1:${PORTS[2]}/live', quality: '720p' });
    await ${T}.startStreamNum(3);
    await new Promise((r2) => setTimeout(r2, 4000));
    const s = ${T}.state();
    return {
      streams: s.streams.slice(0, 3).map((x) => ({ num: x.num, streaming: x.streaming, err: x.lastEndInfo && x.lastEndInfo.error })),
      encoders: s.programEncoders, consumers: s.programConsumers,
    };
  `);
  if (r.__error) console.error(r.__error);
  log(r.streams[2].streaming === true, 'destination 3 goes live MID-BROADCAST', r.streams[2].err || 'no error');
  {
    // How long from "Start 3" until bytes are actually moving to that platform?
    // A late joiner has to wait for the next keyframe in the shared feed, so a
    // couple of seconds is expected and fine — minutes, or never, would not be.
    let conn = null;
    for (let i = 0; i < 120 && !conn; i++) {
      conn = events.find((ev) => ev.id === 'd3' && ev.type === 'connected');
      if (!conn) await sleep(100);
    }
    const lockMs = Date.now() - lateJoinAt;
    log(!!conn && lockMs < 12000, 'destination 3 is really on air (its encoder is reporting live stats)',
      conn ? `locked on ${(lockMs / 1000).toFixed(1)}s after pressing Start` : 'never reported stats');
    if (!conn) {
      const o = hub.outputs.get('d3');
      console.log('     [diag] d3 ffmpeg log tail:\n' + (o ? o.lastLog.slice(-900).split('\n').map((l) => '       ' + l).join('\n') : '(output gone)'));
    }
    log(!events.some((ev) => ev.id === 'd3' && ev.type === 'reconnecting'), 'destination 3 did not have to reconnect',
      JSON.stringify(events.filter((ev) => ev.id === 'd3' && ev.type === 'reconnecting').map((ev) => ev.payload)));
  }
  log(r.streams[0].streaming && r.streams[1].streaming,
    'destinations 1 + 2 were NOT interrupted by destination 3 joining', JSON.stringify(r.streams.map((x) => x.streaming)));
  log(r.encoders === 1 && r.consumers === 4, 'still ONE program encode for 3 streams + recording', `captures=${r.encoders} consumers=${r.consumers}`);
  {
    // Destinations that want exactly what the shared encode already produces must
    // be COPIED through, not encoded a second time. Getting this wrong is silent:
    // the picture still arrives, it just costs a whole extra encode per platform.
    const copying = [...hub.outputs.entries()].map(([id, o]) => `${id}:${o.copying ? 'copy' : 're-encode'}`);
    const copies = [...hub.outputs.values()].filter((o) => o.copying).length;
    log(copies === 3, 'the 720p destinations + recording are copied, not re-encoded', copying.join(' '));
    log(!hub.outputs.get('d1').copying, 'the 480p destination re-encodes, as it must (different size)');
  }
  for (const ev of events.filter((e2) => e2.type === 'ended' && e2.payload && e2.payload.error)) {
    console.log(`     [diag] output ${ev.id} ended early:\n` + String(ev.payload.log || '').split('\n').slice(-14).map((l) => '       ' + l).join('\n'));
  }
  const noCameraFeedError = !events.some((ev) => ev.type === 'ended' && ev.payload && /camera feed|program feed/i.test(ev.payload.error || ''));
  log(noCameraFeedError, 'no "feed could not be read" failure anywhere (the reported bug)',
    events.filter((e2) => e2.type === 'ended').map((e2) => e2.id + ':' + (e2.payload && e2.payload.error)).join(' | ') || 'no ended events');

  await sleep(4000);

  /* 6b. THE PLATFORM DROPS US. Church wifi hiccups and YouTube's ingest closes
        the connection. That must not end the service: the destination has to
        reconnect on its own, and the OTHER destinations must not even notice.
        This runs on its own destination (4) so that severing a connection on
        purpose doesn't damage the evidence gathered for destinations 1-3. */
  r = await js(win, `
    await ${T}.setStreamSlot(4, { dest: 'custom', key: 'app4', customUrl: 'rtmp://127.0.0.1:${PORTS[3]}/live', quality: '720p' });
    await ${T}.startStreamNum(4);
    await new Promise((r2) => setTimeout(r2, 5000));
    return ${T}.state().streams[3].streaming;
  `);
  log(r === true, 'a FOURTH destination joins the same broadcast');
  console.log('  -- killing the ingest server for destination 4 to force a real disconnect --');
  try { receivers[3].kill('SIGKILL'); } catch (e) {}
  await sleep(2500);
  let reconnEvent = null;
  for (let i = 0; i < 80 && !reconnEvent; i++) {
    reconnEvent = events.find((ev) => ev.id === 'd4' && ev.type === 'reconnecting');
    if (!reconnEvent) await sleep(250);
  }
  log(!!reconnEvent, 'a dropped destination reports that it is reconnecting, not that it ended',
    reconnEvent ? `attempt ${reconnEvent.payload.attempt} of ${reconnEvent.payload.of}` : 'no reconnect attempt seen');
  r = await js(win, `
    const s = ${T}.state();
    return { streams: s.streams.slice(0, 4).map((x) => ({ num: x.num, streaming: x.streaming, retrying: !!x.reconnecting })), encoders: s.programEncoders };
  `);
  log(r.streams[0].streaming && r.streams[1].streaming && r.streams[2].streaming,
    'destinations 1-3 stay on air while destination 4 is reconnecting', JSON.stringify(r.streams));
  log(r.streams[3].streaming && r.streams[3].retrying,
    'the dropped destination stays "live but reconnecting" rather than silently stopping');
  log(r.encoders === 1, 'the program encoder keeps running through the drop');

  // bring the "platform" back and confirm the destination reattaches by itself
  const outFlv4b = path.join(tmp, 'ingested4-reconnected.flv');
  let recErr4b = '';
  const receiver4b = spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '60',
    '-i', `rtmp://127.0.0.1:${PORTS[3]}/live/app4`, '-c', 'copy', '-f', 'flv', outFlv4b], { windowsHide: true });
  receiver4b.stderr.on('data', (d) => { recErr4b += d.toString(); });
  const receiver4bDone = new Promise((res) => receiver4b.on('close', res));
  const backAt = Date.now();
  let backOn = false;
  for (let i = 0; i < 100 && !backOn; i++) {
    r = await js(win, `const s = ${T}.state(); return { retrying: !!s.streams[3].reconnecting, streaming: s.streams[3].streaming };`);
    backOn = r.streaming && !r.retrying;
    if (!backOn) await sleep(300);
  }
  log(backOn, 'the destination reconnects by itself once the platform is reachable again',
    backOn ? `back on air ${((Date.now() - backAt) / 1000).toFixed(1)}s after the server returned` : 'never came back');
  await sleep(6000);

  /* 7. stop JUST destination 1 mid-broadcast — the others must keep running */
  r = await js(win, `
    await ${T}.stopStreamNum(1);
    await new Promise((r2) => setTimeout(r2, 1000));
    const s = ${T}.state();
    return { streams: s.streams.slice(0, 4).map((x) => ({ num: x.num, streaming: x.streaming })), btnStillOn: document.getElementById('vmxStream').classList.contains('on') };
  `);
  if (r.__error) console.error(r.__error);
  log(!r.streams[0].streaming && r.streams[1].streaming && r.streams[2].streaming,
    'stopping ONE destination leaves the others running uninterrupted', JSON.stringify(r.streams));
  log(r.btnStillOn, 'Stream button stays lit while any destination is still live');
  engineState = await win.webContents.executeJavaScript('window.api.live.state()');
  log(Object.keys(engineState).length === 3, 'the other three push outputs remain running', JSON.stringify(Object.keys(engineState)));

  await sleep(4000);

  /* 8. stop everything + recording gracefully — and it must feel immediate */
  const stopAt = Date.now();
  r = await js(win, `
    document.getElementById('vmxStream').click(); // Stop All
    document.getElementById('vmxRecord').click();
    // poll rather than guess a fixed wait, so the test reports how long a real
    // "stop everything" actually takes instead of hiding it behind a sleep
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const s2 = ${T}.state();
      if (!s2.streaming && !s2.recording && s2.programEncoders === 0) break;
      await new Promise((r2) => setTimeout(r2, 150));
    }
    const s = ${T}.state();
    return { anyStreaming: s.streaming, recording: s.recording, encoders: s.programEncoders,
             ms: Date.now() - t0, btnOff: !document.getElementById('vmxStream').classList.contains('on') };
  `);
  log(r.anyStreaming === false && r.btnOff, 'Stop All stops every remaining destination and the button resets');
  log(r.recording === false, 'Record stops');
  log(r.encoders === 0, 'the program encoder shuts down when the last consumer leaves');
  log(r.ms < 6000, `stopping everything completes promptly (${(r.ms / 1000).toFixed(1)}s)`);
  engineState = await win.webContents.executeJavaScript('window.api.live.state()');
  log(Object.keys(engineState).length === 0, 'no push outputs remain running');
  for (let i = 0; i < 40 && hub.running; i++) await sleep(100);
  log(!hub.running, `the shared program encoder process is gone (${((Date.now() - stopAt) / 1000).toFixed(1)}s after Stop)`);

  /* 9. verify what all three "platforms" received + the local recording */
  await Promise.race([Promise.all([...receiversDone, receiver4bDone]),
    sleep(12000).then(() => { [...receivers, receiver4b].forEach((rc) => { try { rc.kill('SIGKILL'); } catch (e) {} }); })]);

  {
    // What the platform got AFTER the reconnect has to be a real broadcast, not
    // a connection that merely opened.
    const okFile = fs.existsSync(outFlv4b) && fs.statSync(outFlv4b).size > 40000;
    log(okFile, 'the reconnected destination delivered a real broadcast after coming back',
      okFile ? Math.round(fs.statSync(outFlv4b).size / 1024) + 'KB' : 'nothing received: ' + recErr4b.slice(-160));
    if (okFile) {
      const y = await lumaAt(outFlv4b, 0.5);
      log(y > 24, `the reconnected stream carries real picture (mean luma ${y.toFixed(1)})`);
    }
  }

  const expect = [[854, 480, 3], [1280, 720, 3], [1280, 720, 3]];
  for (let i = 0; i < 3; i++) {
    const n = i + 1, file = outFlv[i], [ew, eh, minDur] = expect[i];
    const exists = fs.existsSync(file) && fs.statSync(file).size > 60000;
    log(exists, `destination ${n}'s ingest server received the broadcast (${exists ? Math.round(fs.statSync(file).size / 1024) + 'KB' : 'missing'})`, recErr[i].slice(-200));
    if (!exists) continue;
    const probed = await ffmod.probe(FP, file);
    const v = (probed.streams || []).find((x) => x.codec_type === 'video');
    const a = (probed.streams || []).find((x) => x.codec_type === 'audio');
    const dur = await mediaDuration(file);
    log(v && v.codec_name === 'h264' && a && a.codec_name === 'aac', `destination ${n} is H.264 + AAC`, `${v && v.codec_name}/${a && a.codec_name}`);
    log(v && v.width === ew && v.height === eh, `destination ${n} arrived at its OWN configured quality`, v && `${v.width}x${v.height}`);
    log(dur >= minDur, `destination ${n} received ${dur.toFixed(1)}s of broadcast`);
    const yavg = await lumaAt(file, Math.min(2, dur / 2));
    log(yavg > 24, `destination ${n} received REAL picture, not black (mean luma ${yavg.toFixed(1)})`);
  }
  // The late joiner is the whole point: prove it had a watchable picture almost
  // immediately, not several seconds of undecodable garbage.
  {
    const early = await lumaAt(outFlv[2], 0.5);
    log(early > 24, `destination 3 (the LATE joiner) had real picture within half a second (luma ${early.toFixed(1)})`);
  }

  await sleep(1000);
  {
    const exists = fs.existsSync(recFile) && fs.statSync(recFile).size > 60000;
    log(exists, 'simultaneous MP4 recording exists (' + (exists ? Math.round(fs.statSync(recFile).size / 1024) + 'KB' : 'missing') + ')');
    if (exists) {
      const pr = await ffmod.probe(FP, recFile);
      const rv = (pr.streams || []).find((x) => x.codec_type === 'video');
      const ra = (pr.streams || []).find((x) => x.codec_type === 'audio');
      const rdur = parseFloat((pr.format || {}).duration || '0');
      log(rv && rv.codec_name === 'h264' && ra && ra.codec_name === 'aac', 'recording is H.264 + AAC', `${rv && rv.codec_name}/${ra && ra.codec_name}`);
      log(rdur >= 10, `recording captured ${rdur.toFixed(1)}s across the whole session`);
      log((await lumaAt(recFile, 2)) > 24, 'recording has real picture');
      // Audio silently dropping out would be the worst possible failure for a
      // church service, and a valid-looking AAC track proves nothing on its own.
      const vol = await run(FF, ['-i', recFile, '-af', 'volumedetect', '-f', 'null', '-']);
      const mean = parseFloat((vol.out.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1] || '-99');
      log(mean > -50, `recording has audible sound, not silence (mean ${mean.toFixed(1)} dB)`);
    }
  }
  for (let i = 0; i < 3; i++) {
    if (!fs.existsSync(outFlv[i])) continue;
    const vol = await run(FF, ['-i', outFlv[i], '-af', 'volumedetect', '-f', 'null', '-']);
    const mean = parseFloat((vol.out.match(/mean_volume:\s*(-?[\d.]+) dB/) || [])[1] || '-99');
    log(mean > -50, `destination ${i + 1} received audible sound, not silence (mean ${mean.toFixed(1)} dB)`);
  }
  console.log(`  (destination 3 joined ${((Date.now() - lateJoinAt) / 1000).toFixed(0)}s before the end of the run)`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  GO LIVE end-to-end (multi-destination) ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
