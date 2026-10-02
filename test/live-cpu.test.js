'use strict';
/*
 * GO LIVE — CPU COST TEST.
 *
 * The complaint this exists for: "this software uses a lot of CPU, and there is
 * a lot of jittering when recording or live streaming."
 *
 * Absolute CPU numbers are meaningless as a pass/fail bar — they depend entirely
 * on the machine. What IS machine-independent, and what actually went wrong, is
 * the SHAPE of the cost:
 *
 *   - the studio must capture and encode the program ONCE, no matter how many
 *     destinations and recordings consume it (it used to run a separate
 *     MediaRecorder per consumer, so 3 platforms + a recording meant four
 *     simultaneous software VP8 encodes of the same picture);
 *   - adding two more platforms must therefore cost a small fraction of the
 *     encode itself, not another whole encode each time;
 *   - the compositor must run at the production frame rate, not the display's.
 *
 * Real CPU figures are printed for the record.
 *
 * Run: npx electron test/live-cpu.test.js
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
// OS-assigned ports: fixed ones can collide with a leftover receiver, and on
// Windows blocks in the 19000-20000 range are often reserved by Hyper-V.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-livecpu-'));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
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
ipcMain.handle('live:metrics', wrap(async () => ({ cpu: appCpu() })));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const recorders = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    // Surface any unexpected drop so a real streaming failure can't hide behind
    // a green CPU number.
    if (type === 'ended' && payload && payload.error) {
      console.log(`   [event] ${id} ended: ${payload.error}`);
    }
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder })), sid: a.sid };
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
ipcMain.handle('live:engine', wrap(async () => {
  const enc = hub.running ? (hub.activeEncoder || hub.encoder) : await detectEncoder(FF, 'auto');
  return { encoder: enc, label: encoderLabel(enc), hardware: enc !== 'libx264', preference: 'auto', running: hub.running, outputs: hub.outputCount, gpu: true };
}));
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const file = path.join(tmp, `${String(name || 'rec').replace(/[^\w.-]+/g, '_')}-${Date.now()}.mp4`);
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

/** Total CPU% across every process this app owns (Electron + all ffmpeg children). */
function appCpu() {
  const m = app.getAppMetrics();
  return Math.round(m.reduce((s, p) => s + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) * 10) / 10;
}

/** Average app CPU over `sec`, discarding the first sample (transient spike). */
async function measure(sec) {
  const samples = [];
  for (let i = 0; i < sec; i++) { await sleep(1000); samples.push(appCpu()); }
  const use = samples.slice(1);
  return use.reduce((a, b) => a + b, 0) / use.length;
}

/**
 * Sustained compositor frame rate. `state().fps` is whatever the last one-second
 * window happened to be, which dips while ffmpeg processes are still starting —
 * averaging several windows measures the steady state we actually care about.
 */
async function sampleFps(win, sec = 6) {
  const vals = [];
  for (let i = 0; i < sec; i++) {
    await sleep(1000);
    const v = await win.webContents.executeJavaScript('window.LiveStudio.__test.state().fps');
    if (typeof v === 'number') vals.push(v);
  }
  return vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length);
}

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== GO LIVE CPU COST TEST ==');
  console.log(`   machine: ${os.cpus().length} logical cores, ${os.cpus()[0].model.trim()}`);
  console.log(`   program encoder: ${encoderLabel(await detectEncoder(FF, 'auto'))}\n`);
  PORTS = await freePorts(3);

  const receivers = PORTS.map((port, i) => spawn(FF, ['-y', '-loglevel', 'error', '-listen', '1', '-timeout', '180',
    '-i', `rtmp://127.0.0.1:${port}/live/app${i + 1}`, '-c', 'copy', '-f', 'flv', path.join(tmp, `r${i}.flv`)], { windowsHide: true }));
  receivers.forEach((r) => r.stderr.on('data', () => {}));
  await sleep(1500);

  const win = new BrowserWindow({ show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);

  await js(win, `
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise((r) => setTimeout(r, 300));
    ${T}.addSynthetic('Camera 1');
    ${T}.addColor('Announcements', '#2244cc');
    ${T}.addTitle({ headline: 'Sunday Service', subtext: 'Grace Chapel', style: 'lower' });
    await new Promise((r) => setTimeout(r, 800));
    return true;
  `);
  await sleep(2500);

  /* ---- 1. idle: switcher open, compositing, nothing being encoded ---- */
  const idle = await measure(6);
  let s = await js(win, `const s = ${T}.state(); return { fps: s.fps, targetFps: s.targetFps, encoders: s.programEncoders, renderMs: s.renderMs };`);
  console.log(`  idle (switcher running, not broadcasting):        ${idle.toFixed(1)}% CPU   compositor ${s.fps}fps (target ${s.targetFps}, ${s.renderMs.toFixed(1)}ms/frame drawing)`);
  log(s.encoders === 0, 'nothing is being encoded while idle');
  log(s.fps <= s.targetFps + 3, `the compositor runs at the production rate, not the display's`, `${s.fps}fps vs target ${s.targetFps}`);

  /* ---- 2. recording only ---- */
  await js(win, `document.getElementById('vmxRecord').click(); return true;`);
  await sleep(4000);
  const recOnly = await measure(8);
  s = await js(win, `const s = ${T}.state(); return { encoders: s.programEncoders, consumers: s.programConsumers, recording: s.recording };`);
  console.log(`  recording:                                       ${recOnly.toFixed(1)}% CPU`);
  log(s.recording && s.encoders === 1, 'recording runs one program encode', `captures=${s.encoders}`);

  /* ---- 3. recording + ONE streaming destination ---- */
  await js(win, `
    await ${T}.setStreamSlot(1, { dest: 'custom', key: 'app1', customUrl: 'rtmp://127.0.0.1:${PORTS[0]}/live', quality: '720p' });
    await ${T}.startStreamNum(1);
    return true;
  `);
  await sleep(6000);
  const oneDest = await measure(8);
  console.log(`  recording + 1 streaming destination:             ${oneDest.toFixed(1)}% CPU`);

  /* ---- 4. recording + THREE streaming destinations ---- */
  await js(win, `
    await ${T}.setStreamSlot(2, { dest: 'custom', key: 'app2', customUrl: 'rtmp://127.0.0.1:${PORTS[1]}/live', quality: '720p' });
    await ${T}.setStreamSlot(3, { dest: 'custom', key: 'app3', customUrl: 'rtmp://127.0.0.1:${PORTS[2]}/live', quality: '720p' });
    await ${T}.startStreamNum(2);
    await ${T}.startStreamNum(3);
    return true;
  `);
  await sleep(8000);
  const threeDest = await measure(8);
  s = await js(win, `const s = ${T}.state(); return { encoders: s.programEncoders, consumers: s.programConsumers, fps: s.fps, targetFps: s.targetFps, label: s.encoderLabel, renderMs: s.renderMs };`);
  console.log(`  recording + 3 streaming destinations:            ${threeDest.toFixed(1)}% CPU`);
  console.log(`  (program encoder: ${s.label})\n`);

  log(s.encoders === 1 && s.consumers === 4,
    'ONE capture and ONE encode serve 3 destinations + the recording', `captures=${s.encoders} consumers=${s.consumers}`);

  // The architectural claim, measured against the recording-only baseline rather
  // than against the cost of one destination. Comparing to "the cost of
  // destination 1" reads well but is a terrible test: that figure is close to
  // zero precisely when the design is working, and a ratio with a near-zero
  // denominator swings wildly on measurement noise.
  console.log(`  cost of destination 1: ${(oneDest - recOnly).toFixed(1)}%   cost of destinations 2+3: ${(threeDest - oneDest).toFixed(1)}%`);
  log(threeDest - recOnly < recOnly * 0.6,
    'adding THREE streaming platforms costs a fraction of what the encode itself costs',
    `+${(threeDest - recOnly).toFixed(1)}% on top of a ${recOnly.toFixed(1)}% baseline`);
  log(threeDest < recOnly * 2,
    'streaming to 3 platforms while recording stays close to the cost of recording alone',
    `${threeDest.toFixed(1)}% vs ${recOnly.toFixed(1)}% recording-only`);
  const sustainedFps = await sampleFps(win, 6);
  log(sustainedFps >= s.targetFps * 0.8,
    'the compositor still holds its frame rate under full broadcast load (no stutter)',
    `${sustainedFps.toFixed(1)}fps sustained with target ${s.targetFps}`);

  /* ---- 5. and it all still works, not just runs cheaply ---- */
  let engineState = {};
  let liveOnes = [];
  for (let i = 0; i < 20; i++) {
    engineState = await win.webContents.executeJavaScript('window.api.live.state()');
    liveOnes = Object.entries(engineState).filter(([, v]) => v && v.running);
    if (liveOnes.length === 3) break;
    await sleep(500); // a destination may briefly be mid-reconnect
  }
  log(liveOnes.length === 3, 'all three destinations are genuinely running',
    Object.entries(engineState).map(([k, v]) => `${k}:${v && v.running ? 'running' : 'down'}${v && v.retries ? ' retries=' + v.retries : ''}`).join(' '));
  const copying = [...hub.outputs.values()].filter((o) => o.copying).length;
  log(copying === 4, 'all four outputs are copies of the single encode', `${copying}/4 copying`);

  await js(win, `
    await ${T}.stopAllStreams();
    document.getElementById('vmxRecord').click();
    await new Promise((r) => setTimeout(r, 2500));
    return true;
  `);
  await sleep(2500);
  receivers.forEach((r) => { try { r.kill('SIGKILL'); } catch (e) {} });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  GO LIVE CPU cost ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
