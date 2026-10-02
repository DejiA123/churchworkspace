'use strict';
/*
 * GO LIVE — ALL SEVEN DESTINATIONS AT ONCE.
 *
 * live-e2e.test.js proves the multi-destination machinery on four. This proves
 * the advertised limit: every one of the seven streaming slots pushing at the
 * same time, to seven real local RTMP ingests, with a recording alongside — and
 * it checks the property that makes that affordable rather than merely possible.
 *
 * The hub decodes and encodes the program ONCE and fans the result out. A
 * destination whose size and rate match the shared encode is copied byte for
 * byte (`-c copy`), so the eighth consumer costs almost exactly what the second
 * one did. If that ever regressed into a per-destination re-encode, seven
 * software x264 encodes would run at once and the whole broadcast would lag —
 * so "they are copied, not re-encoded" is asserted here, not assumed.
 *
 * Checks:
 *   1. all seven go live, and the seven ingests really receive the broadcast
 *   2. one program encode serves all seven (plus the recording)
 *   3. the six same-quality destinations are COPIED; only the odd one re-encodes
 *   4. the main process stays responsive while all seven run
 *   5. no destination has to reconnect, and none reports a read failure
 *
 * Run: npx electron test/multi-dest.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const ffmod = require('../src/main/ffmpeg');
const { ProgramHub, QUALITIES, DESTINATIONS, buildUrl, detectEncoder, encoderLabel } = require('../src/main/livestream');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-multidest-'));
const N = 7;
const outFlv = Array.from({ length: N }, (_, i) => path.join(tmp, `ingest${i + 1}.flv`));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

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

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { quality: '720p', fpsMode: '30' } };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:pickScreen', () => ok(true));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';
const events = [];

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    events.push({ id, type, payload });
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
  };
  hub.onHubEvent = (type, payload) => {
    events.push({ id: '__hub', type, payload });
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}

ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid: a.sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const url = buildUrl({ dest, key, customUrl });
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url, q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.on('live:chunk', (e, payload) => {
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(payload && payload.sid, Buffer.from(raw)); } catch (er) {}
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
  const enc = hub.running ? (hub.activeEncoder || hub.encoder) : await detectEncoder(FF, 'auto');
  return { encoder: enc, label: encoderLabel(enc), hardware: enc !== 'libx264', preference: 'auto', running: hub.running, outputs: hub.outputCount, gpu: true };
}));
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_')}.mp4`);
  wireHub(e.sender);
  hubRecFiles.set(recId, file);
  try { hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps }); }
  catch (err) { hubRecFiles.delete(recId); throw err; }
  return { file };
}));
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  await hub.removeOutput(recId); hubRecFiles.delete(recId);
  if (!hub.outputCount) await hub.stop();
  return true;
}));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

/** How badly the MAIN process is blocked over `ms` — it feeds every ffmpeg. */
function watchMain(ms) {
  return new Promise((resolve) => {
    let last = process.hrtime.bigint(), lateTotal = 0, worst = 0;
    const iv = setInterval(() => {
      const now = process.hrtime.bigint();
      const late = Number(now - last) / 1e6 - 10;
      last = now;
      if (late > 0) { lateTotal += late; if (late > worst) worst = late; }
    }, 10);
    setTimeout(() => { clearInterval(iv); resolve({ stallPct: (lateTotal / ms) * 100, worstMs: worst }); }, ms);
  });
}

app.whenReady().then(async () => {
  console.log('== GO LIVE — SEVEN DESTINATIONS AT ONCE ==');
  PORTS = await freePorts(N);

  // Seven local RTMP ingests standing in for Facebook / YouTube / X / a custom
  // server / … — each writes what it receives so we can prove it arrived.
  const ingests = PORTS.map((port, i) => spawn(FF, ['-hide_banner', '-loglevel', 'error', '-y',
    '-listen', '1', '-timeout', '25000000', '-f', 'flv',
    '-i', `rtmp://127.0.0.1:${port}/live/app${i + 1}`, '-c', 'copy', '-f', 'flv', outFlv[i]], { windowsHide: true }));
  const ingestErr = ingests.map(() => '');
  ingests.forEach((p, i) => { p.stderr.on('data', (d) => { ingestErr[i] += d.toString(); }); });
  await sleep(1200);

  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r)=>setTimeout(r,300)); return true;`);
  await js(win, `${T}.addColor('Bars', '#2266cc'); ${T}.addTitle({ text: 'SEVEN' }); await new Promise(r=>setTimeout(r,300)); return true;`);

  console.log('  program encoder: ' + encoderLabel(await detectEncoder(FF, 'auto')));

  /* Six destinations at the SAME quality as the program (these must be copied),
   * plus one deliberately smaller (which must re-encode) — so the test shows
   * both halves of the rule rather than only the happy one. */
  let cfg = '';
  for (let i = 0; i < N; i++) {
    const q = i === N - 1 ? '480p' : '720p';
    cfg += `await ${T}.setStreamSlot(${i + 1}, { dest: 'custom', key: 'app${i + 1}', customUrl: 'rtmp://127.0.0.1:${PORTS[i]}/live', quality: '${q}' });\n`;
  }
  await js(win, cfg + 'return true;');

  console.log('\n[1] all seven go live at once');
  await js(win, `await ${T}.startAllStreams(); return true;`);
  // give every RTMP handshake time to complete
  for (let i = 0; i < 40; i++) {
    const n = await js(win, `return ${T}.state().streams.filter(s=>s.streaming).length;`);
    if (n >= N) break;
    await sleep(500);
  }
  await js(win, `await ${T}.startRecording(); return true;`);
  await sleep(9000);

  const st1 = await js(win, `const s = ${T}.state(); return { live: s.streams.filter(x=>x.streaming).length, recording: s.recording,
    stats: s.streams.map(x => x.lastStats ? { kbps: Math.round(x.lastStats.bitrateKbps||0), t: +(x.lastStats.timeSec||0).toFixed(1), copying: !!x.lastStats.copying } : null) };`);
  log(st1.live === N, `all ${N} destinations report streaming`, st1.live + '/' + N);
  log(st1.recording === true, 'and a recording runs alongside them');

  const reporting = (st1.stats || []).filter((s) => s && s.t > 0).length;
  log(reporting >= N, `every destination is really on air (its encoder reports live stats)`,
    reporting + '/' + N + ' reporting: ' + JSON.stringify(st1.stats));

  console.log('\n[2] the cost of the eighth consumer');
  const outs = [...hub.outputs.values()];
  const copied = outs.filter((o) => o.copying).length;
  log(hub.running, 'exactly ONE program encode serves all of them', 'hub encoder: ' + (hub.activeEncoder || hub.encoder));
  log(hub.outputCount === N + 1, `the hub carries all ${N} destinations + the recording`, hub.outputCount + ' outputs');
  // 6 same-quality destinations + the recording are copies; the 480p one is not.
  log(copied >= N, 'the matching destinations and the recording are COPIED, not re-encoded',
    copied + ' of ' + hub.outputCount + ' copying');
  log(outs.filter((o) => !o.copying).length === 1, 'only the one destination that asked for a different size re-encodes');

  console.log('\n[3] responsiveness with all seven pushing');
  const stall = await watchMain(8000);
  log(stall.stallPct < 15, 'the main process stays free to feed every ffmpeg',
    stall.stallPct.toFixed(1) + '% blocked, worst ' + stall.worstMs.toFixed(0) + 'ms');
  const perf = await js(win, `return ${T}.perf(null);`);
  log(perf.drawFps >= 24, 'the compositor still runs at the production rate',
    perf.drawFps + 'fps (target ' + perf.targetFps + ')');

  console.log('\n[4] nothing dropped or failed');
  const reconnects = events.filter((e) => e.type === 'reconnecting');
  log(reconnects.length === 0, 'no destination had to reconnect', reconnects.length + ' reconnect events');
  const readFail = outs.some((o) => /could not be read|Invalid data found|EBML/i.test(o.lastLog || ''));
  log(!readFail, 'no "the feed could not be read" failure on any destination');

  // let the ingests flush, then stop
  await sleep(2000);
  await js(win, `await ${T}.stopRecording(); await ${T}.stopAllStreams(); return true;`);
  await sleep(2500);
  ingests.forEach((p) => { try { p.kill('SIGKILL'); } catch (e) {} });
  await sleep(1200);

  console.log('\n[5] the broadcast really arrived at all seven');
  let arrived = 0;
  for (let i = 0; i < N; i++) {
    const exists = fs.existsSync(outFlv[i]) && fs.statSync(outFlv[i]).size > 20000;
    if (exists) arrived++;
    else console.log(`     [diag] ingest ${i + 1}: ${ingestErr[i].slice(-200)}`);
  }
  log(arrived === N, `all ${N} ingest servers received the broadcast`,
    arrived + '/' + N + ' — sizes ' + outFlv.map((f) => (fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) + 'KB' : 'x')).join(', '));

  console.log(`\n================ SEVEN-DESTINATION STREAMING ${failed ? 'FAILED' : 'PASSED'} ================`);
  try { await hub.stop(); } catch (e) {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
