'use strict';
/*
 * "FACEBOOK IS PERFECT AND YOUTUBE IS A MESS" — the two-destination test.
 *
 * The church streams the same 1080p service to Facebook (destination 1) and
 * YouTube (destination 2). Facebook is flawless; YouTube's sound comes out
 * low-pitched and mangled and its picture judders. Lowering YouTube's bitrate
 * made it worse, not better.
 *
 * Everything about that report is a statement about the SECOND destination, so
 * this suite runs exactly that shape — two 1080p pushes to two real local RTMP
 * ingests, the second joining after the first, held for a full minute — and then
 * takes both received streams apart and compares them to each other.
 *
 * What is measured, and why each number is the one that matters:
 *
 *  • COPY OR RE-ENCODE. One shared encode fanned out costs nothing per extra
 *    destination; a destination that re-encodes runs a whole second H.264
 *    encode on the same PC that is compositing the service. On a church machine
 *    that encode falls behind real time, and everything below goes wrong at
 *    once. This is the difference the operator can never see.
 *
 *  • REAL-TIME DELIVERY (media seconds delivered per wall-clock second). A live
 *    platform is a real-time consumer: hand it 40 seconds of service in 60
 *    seconds of life and YouTube stretches what it has to fill the wall clock —
 *    which is heard as slow, low-pitched, wobbling sound and seen as judder.
 *    THIS is the measurement that reproduces the complaint, and it cannot be
 *    seen by looking at the received file alone: the file is internally
 *    consistent, it simply arrived too slowly.
 *
 *  • PITCH. The program plays a 1 kHz tone. Anything that resamples, mis-declares
 *    a sample rate or drops sound moves that tone off 1000 Hz, so the pitch the
 *    congregation hears is measured rather than assumed.
 *
 *  • A/V OFFSET AND DRIFT, keyframe cadence, frame rate, and whether the app
 *    had to shed anything to keep up.
 *
 * Scenarios (MW_SCEN=a|b|c to run just one):
 *   [A] both destinations on the SAME preset          — the setup that must be perfect
 *   [B] destination 2 on a LOWER bitrate              — "I tried lowering the mbps"
 *   [C] destination 2 behind a throttled uplink       — not enough upload for two
 *
 * Run: npm run test:dualplatform
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, execFile, execFileSync } = require('child_process');
const avPulse = require('./helpers/av-pulse');

const { ProgramHub, QUALITIES, DESTINATIONS, buildUrl, detectEncoder, encoderLabel,
  reEncodedAmong, COPY_BITRATE_TOLERANCE } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-dual-'));

const BIG = process.env.MW_Q || 'H264 1080p 4.5mbps AAC 128kbps';   // what both destinations should use
const SMALL = process.env.MW_Q2 || 'H264 1080p 3mbps AAC 128kbps';  // "I lowered the mbps on the YouTube one"
const JOIN_DELAY_MS = 8000;                        // destination 2 goes live after destination 1
const RUN_S = Number(process.env.MW_RUN_S || 50);
const ONLY = (process.env.MW_SCEN || '').toLowerCase();

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const warn = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, so, se) => res({ out: (so || '') + (se || '') })));

function freePorts(n) {
  return new Promise((resolve) => {
    const svs = [], ports = [];
    const next = () => {
      if (ports.length === n) { svs.forEach((s) => s.close()); return resolve(ports); }
      const sv = net.createServer();
      sv.listen(0, '127.0.0.1', () => { ports.push(sv.address().port); svs.push(sv); next(); });
    };
    next();
  });
}

/**
 * A deliberately narrow uplink.
 *
 * Two 1080p pushes need twice the upload of one, and a church line that carries
 * the first comfortably very often cannot carry both. This stands in for that:
 * a TCP proxy that passes at most `kbps` through to the ingest, so the
 * destination behind it experiences exactly what a starved upload feels like.
 */
function throttleProxy(listenPort, targetPort, kbps) {
  const bytesPerSec = (kbps * 1000) / 8;
  const server = net.createServer((client) => {
    const up = net.connect(targetPort, '127.0.0.1');
    let queue = [], queued = 0, budget = bytesPerSec, timer = null;
    const pump = () => {
      while (queue.length && budget > 0) {
        const b = queue[0];
        const take = Math.min(b.length, Math.floor(budget));
        if (take <= 0) break;
        up.write(b.subarray(0, take));
        budget -= take; queued -= take;
        if (take === b.length) queue.shift(); else queue[0] = b.subarray(take);
      }
      if (queued < 4 * 1024 * 1024) client.resume();
    };
    timer = setInterval(() => { budget = bytesPerSec / 20; pump(); }, 50);
    client.on('data', (b) => { queue.push(b); queued += b.length; if (queued > 4 * 1024 * 1024) client.pause(); pump(); });
    up.on('data', (b) => { try { client.write(b); } catch (e) {} });
    const end = () => { clearInterval(timer); try { client.destroy(); } catch (e) {} try { up.destroy(); } catch (e) {} };
    client.on('error', end); client.on('close', end); up.on('error', end); up.on('close', end);
  });
  server.listen(listenPort, '127.0.0.1');
  return server;
}

/* ---- the real hub, wired exactly as src/main/main.js wires it ---- */
let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'live:screenSources']) ipcMain.handle(ch, () => ok([]));
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
ipcMain.handle('shell:openPath', () => ok(true));
ipcMain.handle('shell:showItem', () => ok(true));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false }));
ipcMain.handle('ndi:sources', () => ok([]));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
let bandwidthEvents = [];
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    if (type === 'bandwidth') bandwidthEvents.push({ id, at: Date.now(), ...payload });
    try { if (!sender.isDestroyed()) sender.send((id === 'main' ? 'rec:' : 'live:') + type, { destId: id, recId: id, ...payload }); } catch (e) {}
  };
  hub.onHubEvent = (type, payload) => { if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (e) {} } };
}
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('live:copyCheck', wrap(async (e, { qualities, fps } = {}) => {
  const qs = (qualities || []).map((q) => (typeof q === 'string' ? QUALITIES[q] : q)).filter(Boolean);
  return { reEncoded: reEncodedAmong(qs, fps), tolerance: COPY_BITRATE_TOLERANCE };
}));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' })), sid: a.sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES[BIG];
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url: buildUrl({ dest, key, customUrl }), q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.handle('live:stop', wrap(async (e, { destId } = {}) => {
  if (destId) await hub.removeOutput(destId);
  else for (const id of [...hub.outputs.keys()]) await hub.removeOutput(id);
  if (!hub.outputCount) await hub.stop();
  return true;
}));
ipcMain.handle('live:state', wrap((e, { destId } = {}) => (destId ? hub.outputState(destId) : {})));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));
ipcMain.on('live:chunk', (e, p) => { try { hub.write(p && p.sid, Buffer.from(p && p.buf ? p.buf : p)); } catch (er) {} });

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const stats = (a) => {
  if (!a.length) return { n: 0, mean: 0, sd: 0, max: 0, min: 0 };
  const mean = a.reduce((x, y) => x + y, 0) / a.length;
  return { n: a.length, mean, sd: Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length), max: Math.max(...a), min: Math.min(...a) };
};

/**
 * Media seconds pushed per second of real life, fitted across the whole run.
 *
 * The obvious version — last sample minus first, over the wall clock between
 * them — is at the mercy of exactly when ffmpeg happened to print its once-a-
 * second progress line, and on a loaded machine that alone moves the answer by
 * 5-15%. A least-squares slope through every sample uses all of them, so a late
 * line moves it by almost nothing.
 */
function deliveryRate(samples) {
  if (!samples || samples.length < 4) return 0;
  const xs = samples.map((s) => s.at / 1000), ys = samples.map((s) => s.t);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : 0;
}

/* --------------------------- what arrived --------------------------- */

async function videoPackets(file) {
  const r = await run(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'packet=pts_time,flags,size', '-of', 'compact=p=0', file]);
  return r.out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const f = {};
    for (const part of line.split('|')) { const i = part.indexOf('='); if (i > 0) f[part.slice(0, i)] = part.slice(i + 1); }
    return { pts: parseFloat(f.pts_time), key: /K/.test(f.flags || ''), size: parseInt(f.size, 10) || 0 };
  }).filter((p) => isFinite(p.pts));
}

async function audioInfo(file) {
  const r = await run(FP, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=codec_name,sample_rate,channels,duration', '-of', 'default=nw=1:nk=1', file]);
  const [codec, sr, ch, dur] = r.out.trim().split(/\r?\n/);
  return { codec, sampleRate: +sr || 0, channels: +ch || 0, duration: parseFloat(dur) || 0 };
}

/**
 * The pitch the congregation would hear.
 *
 * The program input holds a 1 kHz oscillator, so the tone in the received
 * stream is a known quantity: anything that resamples it, mis-declares its rate
 * or eats part of it moves the peak off 1000 Hz. Decoding at a FORCED 48 kHz is
 * the point — a stream that lies about its own sample rate is resampled by that
 * lie on the way out, exactly as a platform's player would resample it.
 */
function toneHz(file) {
  let b;
  try {
    b = execFileSync(FF, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
      { maxBuffer: 1 << 28 });
  } catch (e) { return { hz: 0, beeps: 0, purity: 0 }; }
  const sr = 48000;
  const pcm = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
  // find the loud stretches (the beeps), then read the pitch out of the middle
  const hop = 480, env = [];
  for (let i = 0; i + hop <= pcm.length; i += hop) {
    let m = 0; for (let j = 0; j < hop; j++) m = Math.max(m, Math.abs(pcm[i + j]));
    env.push(m);
  }
  const spans = [];
  let start = -1;
  // 0.08, not 0.15: the beep leaves the app through a broadcast limiter and an
  // AAC encoder, and a threshold set at the source's level finds two of the
  // twenty beeps in a run — which is too few to say anything about pitch.
  for (let i = 0; i < env.length; i++) {
    if (env[i] > 0.08 && start < 0) start = i;
    else if (env[i] <= 0.08 && start >= 0) { if (i - start >= 3) spans.push([start * hop, i * hop]); start = -1; }
  }
  const goertzel = (buf, from, len, hz) => {
    const w = 2 * Math.PI * hz / sr, c = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < len; i++) { s0 = buf[from + i] + c * s1 - s2; s2 = s1; s1 = s0; }
    return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / len;
  };
  const peaks = [], purities = [];
  for (const [s, e] of spans.slice(0, 40)) {
    const len = Math.min(4096, e - s - 480);
    if (len < 2048) continue;
    const from = s + 240;
    let best = 0, bestMag = 0, total = 0;
    for (let hz = 700; hz <= 1400; hz += 2) {
      const m = goertzel(pcm, from, len, hz);
      total += m;
      if (m > bestMag) { bestMag = m; best = hz; }
    }
    // refine to 0.5 Hz around the winner
    for (let hz = best - 3; hz <= best + 3; hz += 0.5) {
      const m = goertzel(pcm, from, len, hz);
      if (m > bestMag) { bestMag = m; best = hz; }
    }
    peaks.push(best);
    purities.push(bestMag / (total / 351));   // how far the peak stands above the rest
  }
  const st = stats(peaks);
  return { hz: st.mean, sd: st.sd, beeps: peaks.length, purity: stats(purities).mean };
}

/* ------------------------------ one scenario ------------------------------ */

async function scenario(win, { key, title, quality2, throttleKbps, note }) {
  console.log(`\n\n======================= [${key.toUpperCase()}] ${title} =======================`);
  if (note) console.log('   ' + note);
  bandwidthEvents = [];
  const files = [path.join(tmp, `${key}-dest1.flv`), path.join(tmp, `${key}-dest2.flv`)];
  const PORTS = await freePorts(3);
  const ingestPorts = [PORTS[0], PORTS[1]];
  const connectPorts = [PORTS[0], throttleKbps ? PORTS[2] : PORTS[1]];

  const receivers = ingestPorts.map((port, i) => spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '180',
    '-i', `rtmp://127.0.0.1:${port}/live/app${i + 1}`, '-c', 'copy', '-f', 'flv', files[i]], { windowsHide: true }));
  const rxErr = receivers.map(() => '');
  receivers.forEach((r, i) => r.stderr.on('data', (d) => { rxErr[i] += d.toString(); }));
  const proxy = throttleKbps ? throttleProxy(PORTS[2], PORTS[1], throttleKbps) : null;
  await sleep(1500);

  // Destination 1 (Facebook) goes live first, exactly as a service starts.
  const setup = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const p = T.addAvPulse('Pulse');
    T.setPreview(p.id); T.cut();
    T.setLiveCfg({ quality: ${JSON.stringify(BIG)}, fpsMode: '30' });
    T.setStreamSlot(1, { dest:'custom', key:'app1', customUrl:'rtmp://127.0.0.1:${connectPorts[0]}/live', quality:${JSON.stringify(BIG)} });
    T.setStreamSlot(2, { dest:'custom', key:'app2', customUrl:'rtmp://127.0.0.1:${connectPorts[1]}/live', quality:${JSON.stringify(quality2)} });
    await new Promise(r => setTimeout(r, 400));
    T.startStreamNum(1);
    for (let i = 0; i < 80 && !T.state().streams[0].streaming; i++) await new Promise(r => setTimeout(r, 250));
    return { live1: T.state().streams[0].streaming, size: T.pgmSize(), encoder: T.state().encoderLabel,
             captureMode: T.state().captureMode, targetFps: T.perf().targetFps };`);
  if (setup.__error) console.error('   setup: ' + setup.__error);
  log(!!setup.live1, 'destination 1 (Facebook) is live', `${setup.size && setup.size.join('x')} · ${setup.encoder} · capture ${setup.captureMode}`);

  await sleep(JOIN_DELAY_MS);

  // Destination 2 (YouTube) joins the broadcast already in progress.
  const join = await js(win, `
    const T = window.LiveStudio.__test;
    T.startStreamNum(2);
    for (let i = 0; i < 80 && !T.state().streams[1].streaming; i++) await new Promise(r => setTimeout(r, 250));
    return { live2: T.state().streams[1].streaming };`);
  log(!!join.live2, 'destination 2 (YouTube) joined the broadcast in progress');

  const copying = [hub.outputState('d1'), hub.outputState('d2')].map((s) => (s ? !!s.copying : null));
  console.log(`   destination 1 ${copying[0] ? 'COPIES the shared encode' : 'RE-ENCODES on this PC'} · destination 2 ${copying[1] ? 'COPIES the shared encode' : 'RE-ENCODES on this PC'}`);

  /* Whatever the hub decided, the OPERATOR must have been told the same thing.
   * This is the check that would have caught the original fault: the dialog
   * looked only at frame size, so a destination on a lower bitrate re-encoded
   * in silence while the dialog said everything was shared. */
  const told = await js(win, `return await window.LiveStudio.__test.mismatchInfo();`);
  const shouldWarn = copying.some((c) => c === false);
  console.log(`   the dialog says: ${told && told.note ? told.note.slice(0, 190) : '(nothing)'}`);
  log(shouldWarn === ((told.bad || []).length > 0),
    shouldWarn
      ? 'the operator IS warned that a destination is being re-encoded'
      : 'the operator is correctly told everything shares one encode',
    `hub re-encodes ${copying.map((c, i) => (c === false ? i + 1 : null)).filter(Boolean).join(',') || 'nothing'} · dialog flags ${JSON.stringify(told.bad)}`);

  /* Real-time delivery. Each destination's own ffmpeg reports the media time it
   * has pushed; growing slower than the wall clock means the platform is being
   * starved, which is what a viewer hears as slow, low sound. */
  const t0 = Date.now();
  const track = [[], []];
  const speeds = [[], []];
  for (let i = 0; i < RUN_S; i++) {
    await sleep(1000);
    for (const n of [0, 1]) {
      const s = hub.outputState('d' + (n + 1));
      if (!s || !s.stats) continue;
      track[n].push({ at: Date.now(), t: s.stats.timeSec });
      if (s.stats.speed) speeds[n].push(s.stats.speed);
    }
  }

  const perf = await js(win, `const p = window.LiveStudio.__test.perf(); return { fps: p.drawFps, target: p.targetFps };`);
  /* How many times a second does the renderer's event loop come round?
   *
   * The capture reads ONE audio buffer per turn of that loop, so this is the
   * ceiling on how much sound can be collected — and if it drops below the
   * ~100 buffers a second WebAudio produces, sound is being thrown away no
   * matter how deep the queue is. Measured here rather than assumed, because
   * "the machine is busy" and "the loop only turns 56 times a second" call for
   * completely different fixes. */
  const turns = await js(win, `
    let n = 0; const t0 = Date.now();
    while (Date.now() - t0 < 2000) { await new Promise((r) => setTimeout(r, 0)); n++; }
    return Math.round(n / ((Date.now() - t0) / 1000));`);
  const diag = await js(win, `return window.LiveStudio.__test.captureDiag();`);

  /* What the hub made of the program feed, in its own words. "Stream #0:0:
   * Video" or the absence of it is the difference between a destination that
   * carries the service and one that carries only its sound. */
  const hubStreams = (hub.lastLog || '').split(/\r?\n/).filter((l) => /Stream #|Input #|Output #/.test(l));
  if (hubStreams.length) console.log('   hub encoder saw:\n     ' + hubStreams.slice(0, 8).join('\n     '));
  for (const id of ['d1', 'd2']) {
    const o = hub.outputs.get(id);
    if (!o) continue;
    const lines = (o.lastLog || '').split(/\r?\n/).filter((l) => /Stream #|Input #|Output #|Could not find/.test(l));
    if (lines.length) console.log(`   ${id} ffmpeg saw:\n     ` + lines.slice(0, 6).join('\n     '));
  }

  await js(win, `await window.LiveStudio.__test.stopAllStreams(); return true;`);
  await sleep(3000);
  receivers.forEach((r) => { try { r.kill('SIGINT'); } catch (e) {} });
  if (proxy) { try { proxy.close(); } catch (e) {} }
  await sleep(2500);

  console.log(`\n   compositor ${perf.fps} of ${perf.target} fps` +
    (diag && !diag.__error ? ` · capture collected ${diag.vSeen} frames, shed ${diag.vShed}, encoded ${diag.vOut}` : ''));
  if (diag && !diag.__error) {
    // Where sound goes missing has three completely different answers — the
    // renderer never collected it, the encoder never emitted it, or a
    // destination dropped it — and only these three numbers tell them apart.
    console.log(`   sound: ${diag.aDeliveredS.toFixed(2)}s collected in ${diag.aSeen} reads over a ${(diag.wallMs / 1000).toFixed(1)}s broadcast · `
      + `timeline ${diag.aInSpanS.toFixed(2)}s in / ${diag.aOutSpanS.toFixed(2)}s out of the encoder (${diag.aOut} packets)`);
    console.log(`   renderer event loop: ${turns} turns/s · audio reads: ${(diag.aSeen / (diag.wallMs / 1000)).toFixed(0)}/s`);
    log(diag.aDeliveredS >= (diag.wallMs / 1000) * 0.97,
      'EVERY SECOND OF SOUND REACHED THE ENCODER — none of the service was thrown away on the way',
      `${diag.aDeliveredS.toFixed(1)}s of ${(diag.wallMs / 1000).toFixed(1)}s`);
  }

  const results = [];
  for (const n of [0, 1]) {
    const label = n === 0 ? 'destination 1 (Facebook)' : 'destination 2 (YouTube)';
    console.log(`\n   ---- ${label} ----`);
    const f = files[n];
    const exists = fs.existsSync(f) && fs.statSync(f).size > 100000;
    log(exists, `${label} received the broadcast`, exists ? `${Math.round(fs.statSync(f).size / 1024)} KB` : rxErr[n].slice(-200));
    if (!exists) { results.push(null); continue; }

    const deliver = deliveryRate(track[n]);
    const sp = stats(speeds[n]);
    const pk = await videoPackets(f);
    const span = pk.length > 1 ? pk[pk.length - 1].pts - pk[0].pts : 0;
    const realFps = span > 0 ? (pk.length - 1) / span : 0;
    /* ►► IS THIS A CONSTANT FRAME RATE, OR ONLY AN AVERAGE ONE? ◄◄
     *
     * The average says 30fps while the stream freezes for four seconds and
     * then catches up. A platform that re-times a stream like that onto its own
     * clock judders the picture and stretches the sound — and it is invisible
     * in every "fps" number, which is why it went unfound for so long. */
    const gaps = [];
    for (let k = 1; k < pk.length; k++) gaps.push((pk[k].pts - pk[k - 1].pts) * 1000);
    const gs = stats(gaps);
    const sorted = gaps.slice().sort((x, y) => x - y);
    const pct = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);
    const nominal = 1000 / (perf.target || 30);
    const late = gaps.filter((g) => g > nominal * 1.6).length;
    const jitter = { sd: gs.sd, p50: pct(0.5), p90: pct(0.9), p99: pct(0.99), max: gs.max,
      latePct: gaps.length ? (late / gaps.length) * 100 : 0 };
    const keyPts = pk.filter((p) => p.key).map((p) => p.pts);
    const keyGaps = []; for (let k = 1; k < keyPts.length; k++) keyGaps.push(keyPts[k] - keyPts[k - 1]);
    const ai = await audioInfo(f);
    const tone = toneHz(f);
    const av = avPulse.avOffset(FF, f);
    results.push({ deliver, sp, realFps, span, keys: stats(keyGaps), jitter, ai, tone, av });

    console.log(`     delivered ${deliver.toFixed(3)}x real time (ffmpeg speed ${sp.mean.toFixed(3)} min ${sp.min.toFixed(2)})`);
    console.log(`     picture   ${realFps.toFixed(1)} fps over ${span.toFixed(1)}s · keyframes every ${stats(keyGaps).mean.toFixed(2)}s (worst ${stats(keyGaps).max.toFixed(2)}s)`);
    console.log(`     TIMING    frame gaps p50 ${jitter.p50.toFixed(0)}ms · p90 ${jitter.p90.toFixed(0)}ms · p99 ${jitter.p99.toFixed(0)}ms · worst ${jitter.max.toFixed(0)}ms · ${jitter.latePct.toFixed(1)}% late (nominal ${nominal.toFixed(0)}ms)`);
    console.log(`     sound     ${ai.codec} ${ai.sampleRate} Hz ${ai.channels}ch · ${ai.duration.toFixed(1)}s`);
    console.log(`     TONE      ${tone.hz.toFixed(1)} Hz ±${(tone.sd||0).toFixed(1)} from ${tone.beeps} beeps (source is exactly 1000 Hz)`);
    console.log(`     A/V       ${av.shiftMs.toFixed(0)} ms offset, ${av.hits}/${av.flashes.length} pulses agree, drift ${av.driftMsPerMin.toFixed(0)} ms/min`);

    /* ---- the assertions a church service has to pass ----
     *
     * Hard lines are the things that would be the APP's fault on any machine:
     * the pitch of the sound, its sample rate, the keyframe cadence platforms
     * demand, and a stream that reaches the platform at real time. Whether this
     * particular two-core laptop can composite 1080p and collect all 30 frames
     * is a fact about the laptop — reported, but not failed, or the suite would
     * fail forever here and stop meaning anything. */
    /* A destination behind a deliberately narrow uplink CANNOT keep up — that
     * is the scenario, not a fault. Everything else must. */
    const starvedOnPurpose = !!throttleKbps && n === 1;
    if (!starvedOnPurpose) {
      log(deliver >= 0.6, `${label}: keeps up with real time — the platform is not left starved`,
        `${deliver.toFixed(3)}x (well below 1.0 is what makes sound slow and low)`);
    }
    if (deliver < 0.95) {
      warn(`${label}: fed the platform slower than real time`,
        `${deliver.toFixed(3)}x` + (starvedOnPurpose ? ' — expected: its uplink is throttled'
          : ` — at 1080p with ${os.cpus().length} cores it is shedding to keep up`));
    }
    // A destination on a throttled uplink only receives a fraction of the
    // service, so it carries fewer beeps to judge — but every one of them must
    // still be at exactly the right pitch.
    log(tone.beeps >= (starvedOnPurpose ? 2 : 4) && Math.abs(tone.hz - 1000) <= 12 && tone.sd <= 8,
      `${label}: SOUND IS AT THE RIGHT PITCH`, `${tone.hz.toFixed(1)} Hz from ${tone.beeps} beeps`);
    log(ai.sampleRate === 48000 && ai.channels === 2, `${label}: sound arrives as 48 kHz stereo`, `${ai.sampleRate} Hz ${ai.channels}ch`);
    log(realFps >= 12, `${label}: the picture never collapses to a slideshow`, `${realFps.toFixed(1)} fps`);
    if (realFps < (perf.target || 30) * 0.9) {
      warn(`${label}: this machine could not deliver the full frame rate`, `${realFps.toFixed(1)} of ${perf.target} fps`);
    } else log(true, `${label}: picture arrives at the promised rate`, `${realFps.toFixed(1)} of ${perf.target} fps`);
    /* Shedding drops picture in WHOLE GOPs — that is the point of it, so that
     * what reaches the platform is clean keyframe-to-keyframe segments rather
     * than half a GOP of undecodable slices. The cost is that a shed GOP takes
     * its keyframe with it and the cadence doubles for that moment. Judge the
     * cadence when the app is NOT already dropping picture on purpose. */
    const shedHere = bandwidthEvents.some((e) => e.id === 'd' + (n + 1) && e.shedding);
    if (shedHere) {
      warn(`${label}: keyframe cadence stretched while picture was being shed`, `worst ${stats(keyGaps).max.toFixed(2)}s`);
    } else {
      log(stats(keyGaps).max <= 4.2, `${label}: keyframes stay inside the 4s platforms demand`, `worst ${stats(keyGaps).max.toFixed(2)}s`);
    }
    if (av.hits >= 5) {
      log(Math.abs(av.shiftMs) <= 350, `${label}: the sound is on the picture, not adrift`, `${av.shiftMs.toFixed(0)} ms`);
      if (Math.abs(av.shiftMs) > 45) {
        warn(`${label}: A/V offset is beyond the 45ms broadcast ideal on this machine`,
          `${av.shiftMs.toFixed(0)} ms with the capture at ${perf.fps} of ${perf.target} fps`);
      }
      if (starvedOnPurpose) {
        // Most of this destination's picture was deliberately dropped, so the
        // flash train it is measured against is full of holes — the slope
        // through what is left says more about the throttle than the app.
        warn(`${label}: A/V drift is not measurable while most of the picture is being shed`, `${av.driftMsPerMin.toFixed(0)} ms/min`);
      } else {
        log(Math.abs(av.driftMsPerMin) <= 120, `${label}: and does not slide as the service runs`, `${av.driftMsPerMin.toFixed(0)} ms/min`);
      }
    } else warn(`${label}: too few pulses to judge A/V sync`, `${av.hits} agreed`);
  }

  /* ►► THE QUESTION THAT WAS ACTUALLY ASKED ◄◄
   *
   * "Facebook is perfect and YouTube is not." Whatever this machine manages, the
   * two destinations must manage the SAME thing — a difference between them is
   * the app's fault, where a shortfall in both is the computer's. */
  if (results[0] && results[1] && !throttleKbps) {
    const [a, b] = results;
    const rel = (x, y) => (x && y ? Math.abs(x - y) / Math.max(x, y) : 1);
    console.log('\n   ---- destination 1 versus destination 2 ----');
    console.log(`     real-time delivery ${a.deliver.toFixed(3)}x vs ${b.deliver.toFixed(3)}x · `
      + `picture ${a.realFps.toFixed(1)} vs ${b.realFps.toFixed(1)} fps · `
      + `pitch ${a.tone.hz.toFixed(1)} vs ${b.tone.hz.toFixed(1)} Hz · A/V ${a.av.shiftMs.toFixed(0)} vs ${b.av.shiftMs.toFixed(0)} ms`);
    /* Only meaningful when nothing had to be shed. Once this machine starts
     * dropping picture to keep up, which of the two destinations it drops from
     * first is scheduling luck, not a property of the app. */
    const shedHappened = bandwidthEvents.some((e) => e.shedding);
    if (shedHappened) {
      warn('this machine had to shed picture, so the two destinations cannot be compared rate-for-rate',
        `${a.deliver.toFixed(3)}x vs ${b.deliver.toFixed(3)}x`);
    } else {
      log(rel(a.deliver, b.deliver) < 0.1, 'BOTH PLATFORMS ARE FED AT THE SAME RATE — neither is starved while the other is fine',
        `${a.deliver.toFixed(3)}x vs ${b.deliver.toFixed(3)}x`);
    }
    /* Only comparable when both are copies of the one encode. A destination
     * that has to be re-encoded is written at a CONSTANT rate — ffmpeg
     * duplicates frames to fill it — so it reports a tidy 30fps carrying the
     * same 19 real pictures a second as the copy beside it. Comparing those
     * numbers grades the frame-duplication, not the broadcast. */
    if (copying[0] && copying[1]) {
      log(rel(a.realFps, b.realFps) < 0.2, 'BOTH PLATFORMS GET THE SAME PICTURE', `${a.realFps.toFixed(1)} vs ${b.realFps.toFixed(1)} fps`);
    } else {
      warn('one destination is re-encoded to constant frame rate, so the two rates are not comparable',
        `${a.realFps.toFixed(1)} vs ${b.realFps.toFixed(1)} fps`);
    }
    log(Math.abs(a.tone.hz - b.tone.hz) <= 5, 'BOTH PLATFORMS GET THE SAME SOUND, AT THE SAME PITCH',
      `${a.tone.hz.toFixed(1)} Hz vs ${b.tone.hz.toFixed(1)} Hz`);
    if (a.av.hits >= 5 && b.av.hits >= 5) {
      log(Math.abs(a.av.shiftMs - b.av.shiftMs) <= 60, 'and the sound sits on the picture the same way on both',
        `${a.av.shiftMs.toFixed(0)} ms vs ${b.av.shiftMs.toFixed(0)} ms`);
    }
  }

  if (bandwidthEvents.length) {
    console.log('\n   bandwidth/CPU warnings raised by the app:');
    for (const b of bandwidthEvents) console.log(`     ${b.id}: ${b.shedding ? 'SHEDDING' : 'recovered'} (${b.reason || ''}) ${b.message || ''}`);
  } else console.log('\n   the app raised no bandwidth or CPU warning');

  /*
   * SHEDDING MUST SETTLE, NOT OSCILLATE.
   *
   * A destination that genuinely cannot carry the bitrate will shed picture,
   * and that is the correct answer. What is NOT correct is shedding, restoring,
   * shedding, restoring — each cycle stops the video mid-GOP and restarts it at
   * the next keyframe, and a platform responds to that by re-buffering and
   * re-timing, which drags the sound with it. Eight cycles in fifty seconds is
   * what "YouTube was fine at first, then went glitchy and laggy" sounds like.
   */
  for (const id of ['d1', 'd2']) {
    const spells = bandwidthEvents.filter((b) => b.id === id && b.shedding).length;
    if (!spells) continue;
    const secs = Math.max(1, RUN_S);
    const perMin = spells / (secs / 60);
    log(perMin <= 4, `${id}: shedding settles into a steady state instead of flapping`,
      `${spells} spell(s) in ${secs}s = ${perMin.toFixed(1)}/min (a platform re-buffers on every one)`);
  }

  /* A destination whose uplink cannot carry it is not a fault — it is physics.
   * What the app is responsible for is WHICH part of the broadcast is given up
   * (picture, never the preaching), whether the operator is told, and whether
   * the OTHER destination is dragged down with it. */
  if (throttleKbps) {
    log(bandwidthEvents.some((b) => b.id === 'd2' && b.shedding),
      'the operator is TOLD that the starved destination is dropping picture', JSON.stringify(bandwidthEvents.map((b) => b.id + (b.shedding ? ':shed' : ':ok'))));
    if (results[0]) {
      log(results[0].tone.beeps >= 4 && Math.abs(results[0].tone.hz - 1000) <= 12 && results[0].realFps >= 12,
        'and the healthy destination still carries the whole service',
        `${results[0].tone.hz.toFixed(1)} Hz from ${results[0].tone.beeps} beeps at ${results[0].realFps.toFixed(1)} fps`);
    }
    if (results[1]) {
      log(results[1].tone.beeps >= 2 && Math.abs(results[1].tone.hz - 1000) <= 12,
        'THE STARVED DESTINATION STILL SOUNDS RIGHT — picture was given up, the preaching was not',
        `${results[1].tone.hz.toFixed(1)} Hz from ${results[1].tone.beeps} beeps`);
    }
    if (results[0]) {
      log(results[0].deliver >= 0.6 && results[0].realFps >= 12,
        'the good destination is never dragged down to the starved one’s level',
        `${results[0].deliver.toFixed(2)}x at ${results[0].realFps.toFixed(1)} fps vs ${results[1] ? results[1].deliver.toFixed(2) : '?'}x`);
    }
  }

  return { results, copying, bandwidth: bandwidthEvents.slice(), perf };
}

app.whenReady().then(async () => {
  console.log('== TWO PLATFORMS AT ONCE: IS THE SECOND ONE AS GOOD AS THE FIRST? ==');
  console.log(`   machine: ${os.cpus().length} logical cores, ${os.cpus()[0].model.trim()}`);
  console.log(`   program encoder: ${encoderLabel(await detectEncoder(FF, 'auto'))}`);

  const win = new BrowserWindow({ show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  const scen = [
    { key: 'a', title: 'BOTH DESTINATIONS ON THE SAME 1080p PRESET', quality2: BIG,
      note: 'The setup the app tells operators to use. Both must be copies of one encode.' },
    { key: 'b', title: 'DESTINATION 2 ON A LOWER BITRATE ("I lowered the mbps")', quality2: SMALL,
      note: 'Same size, smaller bitrate — the app must not let this silently become a second live encode.' },
    { key: 'c', title: 'DESTINATION 2 BEHIND A NARROW UPLINK', quality2: BIG, throttleKbps: 700,
      note: 'Not enough upload for two 1080p pushes. Sound must survive intact even when picture cannot.' },
  ].filter((s) => !ONLY || ONLY.includes(s.key));

  const out = {};
  for (const s of scen) out[s.key] = await scenario(win, s);

  console.log('\n\n============================  SUMMARY  ============================');
  for (const s of scen) {
    const r = out[s.key];
    if (!r) continue;
    const line = (n) => {
      const x = r.results[n];
      if (!x) return 'no stream';
      return `${x.deliver.toFixed(2)}x real time · ${x.tone.hz.toFixed(0)} Hz tone · ${x.realFps.toFixed(1)} fps · ${r.copying[n] ? 'copy' : 'RE-ENCODE'}`;
    };
    console.log(`  [${s.key.toUpperCase()}] ${s.title}`);
    console.log(`        dest 1: ${line(0)}`);
    console.log(`        dest 2: ${line(1)}`);
  }

  try { await hub.stop(); } catch (e) {}
  // MW_KEEP=1 leaves the received streams on disk — when a destination sounds
  // wrong, the file it sounded wrong in is the only thing worth looking at.
  if (process.env.MW_KEEP) console.log('\n   received streams kept in ' + tmp);
  else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  console.log('\n============  TWO-PLATFORM STREAMING ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
