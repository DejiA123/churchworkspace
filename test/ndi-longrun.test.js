'use strict';
/*
 * "IT SOUNDS FINE, THEN A FEW MINUTES IN IT CRACKLES" — the whole chain, for
 * minutes, the way the church runs it.
 *
 * Every other audio suite here runs for 20-40 seconds. Both of the faults
 * behind this complaint are INVISIBLE at that length, because both are driven
 * by two crystals disagreeing, and that takes minutes to add up:
 *
 *   1. The NDI jitter buffer used to hold its read rate at exactly 1.0 inside
 *      a band and flip to ±2% at its edges. A sender clock 100 ppm off walks
 *      the buffer to the edge in about three and a half minutes, and from
 *      then on the rate flips several times a second — for the rest of the
 *      service.
 *   2. The capture engine used to re-stamp the sound onto the system clock
 *      whenever the card ran fast, so the broadcast claimed less time than the
 *      sound it carried; YouTube cut the surplus out at the AAC frame joins.
 *
 * So this runs the REAL app against a REAL NDI sender built like the church's
 * Ableton "NDI Output" plug-in — audio only, four channels, programme on 3-4,
 * one 512-sample callback buffer per packet — whose clock is deliberately
 * MW_NDI_PPM off, and records the broadcast through the hub exactly as a
 * platform receives it (the recording is `-c copy` of the same stream). Then
 * it takes the recording apart:
 *
 *   - the TONE that went in, window by window over the whole run: a splice, a
 *     dropout or a rate flip all show up as a window that is no longer a pure
 *     tone — and the last minutes must be as clean as the first;
 *   - the AUDIO TIMESTAMPS: every AAC frame exactly one frame after the last,
 *     the whole track spanning exactly the sound it holds;
 *   - the jitter buffer's own account: no dropouts, no skips, and a clock loop
 *     that found the sender's offset.
 *
 *   npm run test:ndi-longrun
 *   MW_RUN_S=n (360)  MW_NDI_PPM=n (200)  MW_Q=<quality> (1080p)  MW_KEEP=1 keeps the file
 *
 * SKIPS cleanly if the NDI runtime is not installed.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork, execFileSync, spawnSync } = require('child_process');
const ndi = require('../src/main/ndi');
const { ProgramHub, QUALITIES, DESTINATIONS, detectEncoder, encoderLabel } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-longrun-'));
const ctx = { ffmpeg: FF, ffprobe: FP };
const RUN_S = Number(process.env.MW_RUN_S || 360);
const PPM = Number(process.env.MW_NDI_PPM == null ? 200 : process.env.MW_NDI_PPM);
const FREQ = 3000;
const QUALITY = process.env.MW_Q || 'H264 1080p 4.5mbps AAC 128kbps';
// The capture resamples the sound card onto real time; this laptop's card is
// honest, so the suite makes the engine behave as if it were as far out as the
// church PC's (0.12%) — the real resampler and the real AAC encoder carry the
// correction for the whole run. MW_CARD_PPM=0 turns it off.
const CARD_PPM = Number(process.env.MW_CARD_PPM == null ? 1200 : process.env.MW_CARD_PPM);

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const note = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + '='.repeat(8) + ' ' + s + ' ' + '='.repeat(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
for (const ch of ['video:presets', 'present:state']) ipcMain.handle(ch, () => ok({}));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed',
  'bible:catalogue', 'present:displays', 'live:screenSources']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
const ndiReceivers = ndi.registerIpc(ipcMain, wrap).receivers;

const hub = new ProgramHub();
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => { try { if (!sender.isDestroyed()) sender.send('live:' + type, { destId: id, ...payload }); } catch (e) {} };
  hub.onHubEvent = (type, payload) => { if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (e) {} } };
}
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid: a.sid };
}));
let recFile = '';
ipcMain.handle('rec:start', wrap(async (e, { recId, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  recFile = path.join(tmp, `longrun-${Date.now()}.mp4`);
  wireHub(e.sender);
  hub.addOutput(ctx, recId, { kind: 'file', filePath: recFile, q, fps: q.fps || fps });
  return { file: recFile };
}));
// The encoded broadcast, from the capture into the hub — exactly main.js's wiring.
ipcMain.on('live:chunk', (e, payload) => {
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(payload && payload.sid, Buffer.from(raw)); } catch (er) {}
});
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => { await hub.removeOutput(recId); return true; }));
ipcMain.handle('live:state', wrap((e, { destId }) => hub.outputState(destId)));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/** The recording's sound, decoded to mono float at 48 kHz. */
function decodeAudio(file) {
  const r = spawnSync(FF, ['-v', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
    { maxBuffer: 1 << 30 });
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

/**
 * THD+N of one window against a sine of FREE frequency (±1%): a steady pitch
 * scores clean, and anything that is not that sine — a splice, a gap, a flip
 * of the read rate — scores as distortion. dB relative to the window's power.
 */
function thdN(x, s, W, f0) {
  const fit = (f) => {
    const w = 2 * Math.PI * f / 48000;
    let ss = 0, sc = 0, cc = 0, ys = 0, yc = 0, yy = 0;
    for (let i = 0; i < W; i++) { const y = x[s + i], si = Math.sin(w * i), co = Math.cos(w * i); ss += si * si; sc += si * co; cc += co * co; ys += y * si; yc += y * co; yy += y * y; }
    const det = ss * cc - sc * sc;
    const a = (ys * cc - yc * sc) / det, b = (yc * ss - ys * sc) / det;
    return { res: Math.max(1e-20, yy - (a * ys + b * yc)), yy };
  };
  let lo = f0 * 0.99, hi = f0 * 1.01, best = lo, bestR = Infinity;
  for (let k = 0; k <= 40; k++) { const f = lo + (hi - lo) * k / 40; const r = fit(f).res; if (r < bestR) { bestR = r; best = f; } }
  let a = best - (hi - lo) / 40, c = best + (hi - lo) / 40;
  for (let it = 0; it < 28; it++) { const m1 = a + (c - a) * 0.382, m2 = a + (c - a) * 0.618; if (fit(m1).res < fit(m2).res) c = m2; else a = m1; }
  const r = fit((a + c) / 2);
  return r.yy < 1e-8 ? null : 10 * Math.log10(r.res / r.yy);
}

app.whenReady().then(async () => {
  console.log('== NDI LONG RUN: does the sound stay clean for minutes, not seconds? ==');
  const status = ndi.getStatus();
  if (!status.available) { console.log('  SKIP  NDI runtime not installed -> ' + (status.error || '')); app.exit(0); return; }
  console.log(`   ${RUN_S}s · sender clock ${PPM >= 0 ? '+' : ''}${PPM} ppm · ${FREQ} Hz tone on channels 3-4 · 512-sample packets · ${QUALITY}`);

  const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, 'MW Longrun VST', 'vst'],
    { silent: true, env: { ...process.env, MW_NDI_PPM: String(PPM), MW_NDI_PKT: '512', MW_NDI_FREQ: String(FREQ), MW_NDI_COUNT: '1' } });
  // Every hop's own count of the sound it passed on, so a shortfall can be
  // placed: what the sender sent, what the receiver took off the SDK, what the
  // audio thread received.
  const hop = { sent: 0, sentAt: 0, recv: 0, recvAt: 0 };
  source.stdout.on('data', (b) => {
    const m = String(b).match(/sent (\d+) at (\d+)/g);
    if (m) { const last = m[m.length - 1].match(/sent (\d+) at (\d+)/); hop.sent = Number(last[1]); hop.sentAt = Number(last[2]); }
  });
  /*
   * A DAW's audio runs on a real-time thread; this fixture is a Node timer.
   * On a two-core laptop holding a 1080p broadcast, a normal-priority Node
   * process was starved of CPU for up to 1.9 SECONDS at a time — measured by
   * the sender's OWN timestamps (senderGapMs), so the gap was here, before
   * the network, before the app. The app cannot play sound it was never sent,
   * and the suite was measuring the fixture. HIGH priority is what Ableton's
   * audio thread effectively has.
   */
  try { os.setPriority(source.pid, os.constants.priority.PRIORITY_HIGH); } catch (e) { note('could not raise the sender priority', e.message); }
  await sleep(1500);
  let found = null;
  for (let i = 0; i < 30 && !found; i++) {
    found = ndi.getSources().find((s) => /MW Longrun VST/.test(s.name));
    if (!found) await sleep(500);
  }
  log(!!found, 'the Ableton-style sender was discovered', found && found.name);
  if (!found) { source.kill(); app.exit(1); return; }

  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);
  await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    return true;`);
  await sleep(500);

  head('[1] ON AIR');
  const start = await js(win, `
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    // A silent picture on program. (addStillSlide carries a 440 Hz tone of
    // its own — right for other suites, and it would be mixed into this one.)
    const a = T.addColor('Backdrop', '#204080');
    T.setPreview(a.id); T.cut();
    const inp = T.addNdiInput(${JSON.stringify(found)}, { audioOnly: true });
    T.setLiveCfg({ quality: ${JSON.stringify(QUALITY)} });
    T.setCaptureTuning(${CARD_PPM ? `{ forceCardPpm: ${CARD_PPM} }` : 'null'});
    for (let i = 0; i < 40; i++) { const s = T.syncState(inp.id); if (s && s.queueMs > 20) break; await new Promise(r => setTimeout(r, 250)); }
    T.startRecording();
    for (let i = 0; i < 60 && !T.captureDiag(); i++) await new Promise(r => setTimeout(r, 250));
    return { id: inp.id, capturing: !!T.captureDiag(), host: T.captureHost ? T.captureHost() : null,
             rate: T.programSampleRate(), diag: T.ndiAudioDiag(inp.id) };`);
  if (start.__error) { console.error(start.__error); log(false, 'start'); app.exit(1); return; }
  log(start.capturing, 'the broadcast capture is running', `bus ${start.rate} Hz, capture on the ${start.host && start.host.worker ? 'worker' : 'main thread'}`);
  log(start.diag && start.diag.via === 'worklet', 'the NDI sound goes straight to the audio thread', `via=${start.diag && start.diag.via}`);
  for (const rx of ndiReceivers.values()) {
    rx.cb.onStatus = (m) => { if (m && m.audioSamples != null) { hop.recv = m.audioSamples; hop.recvAt = Date.now(); } };
  }

  console.log(`   running ${RUN_S}s…`);
  const t0 = Date.now();
  let last = null, prevHop = null;
  const rows = [];
  while (Date.now() - t0 < RUN_S * 1000) {
    await sleep(Date.now() - t0 < 30000 ? 5000 : 30000);
    const s = await js(win, `return window.LiveStudio.__test.syncState(${start.id});`);
    if (!s || s.__error) continue;
    last = s;
    const t = Math.round((Date.now() - t0) / 1000);
    const now = Date.now();
    if (prevHop) {
      const dt = (now - prevHop.at) / 1000;
      const rate = (a, b) => ((a - b) / dt).toFixed(0);
      console.log(`           per second: sender ${rate(hop.sent, prevHop.sent)} · receiver ${rate(hop.recv, prevHop.recv)} · audio thread ${rate(s.fedSamples, prevHop.fed)}  (card consumes 48000)`);
    }
    prevHop = { sent: hop.sent, recv: hop.recv, fed: s.fedSamples, at: now };
    rows.push({ t, ...s });
    console.log(`    ${String(t).padStart(4)}s  held ${s.queueMs.toFixed(0).padStart(3)} ms (target ${s.bufferTargetMs})  dropouts ${s.underrunEvents}  skips ${s.skips}`
      + `  trim ${String(s.trimPpm).padStart(5)} ppm  clock ${String(s.clockPpm).padStart(5)} ppm`
      + `  worst gap: sender ${s.senderGapMs} / receiver ${s.receiverGapMs} / audio thread ${s.maxAudioGapMs} ms`);
  }
  const capDiag = await js(win, `return window.LiveStudio.__test.captureDiag();`);
  await js(win, `window.LiveStudio.__test.stopRecording(); return true;`);
  await sleep(4000);
  try { source.kill(); } catch (e) {}

  head('[2] THE JITTER BUFFER, BY ITS OWN ACCOUNT');
  if (last) {
    const settled = last.underrunEvents - (last.startupDropouts || 0);
    log(settled === 0, 'the sound never ran dry once the feed had settled',
      `${settled} dropout(s) in ${RUN_S}s (${last.startupDropouts || 0} while the connection was starting)`);
    log(last.skips === 0, 'no backlog ever had to be skipped', `${last.skips} skip(s)`);
    const firstClock = rows.length ? rows[Math.min(rows.length - 1, 3)].clockPpm : 0;
    note('the clock loop settled on the offset between the sender and this sound card', `${last.clockPpm} ppm (sender set to ${PPM} ppm against the wall clock; the card has its own)`);
    log(Math.abs(last.clockPpm - PPM) < 120, 'and that offset is the one the sender was given, give or take this card\'s own error',
      `${last.clockPpm} ppm vs ${PPM} ppm`);
    const held = rows.slice(2).map((r) => r.queueMs);
    const spread = held.length ? Math.max(...held) - Math.min(...held) : 0;
    log(spread < 40, 'the latency it holds is steady for the whole run (so a lip-sync offset set at the start stays right)',
      `${held.length ? Math.min(...held).toFixed(0) : '?'}–${held.length ? Math.max(...held).toFixed(0) : '?'} ms`);
  }

  if (CARD_PPM && capDiag && !capDiag.__error) {
    head('[2b] THE SOUND WAS PUT ON REAL TIME');
    const ratio = capDiag.audioInS / Math.max(1e-9, capDiag.audioOutS);
    log(Math.abs((ratio - 1) * 1e6 - CARD_PPM) < 60,
      `the capture took the card's ${CARD_PPM} ppm off the sound before encoding it`,
      `${capDiag.audioInS.toFixed(2)} s in -> ${capDiag.audioOutS.toFixed(2)} s out = ${((ratio - 1) * 1e6).toFixed(0)} ppm (step now ${capDiag.resampleStepPpm.toFixed(0)} ppm)`);
  }

  head('[3] THE RECORDING — WHAT A PLATFORM RECEIVES');
  console.log('    recording: ' + (recFile || '(rec:start never called)'));
  const exists = recFile && fs.existsSync(recFile);
  log(exists, 'the broadcast was recorded', exists ? `${(fs.statSync(recFile).size / 1e6).toFixed(1)} MB` : 'no file');
  if (exists) {
    // Timestamps: every AAC frame exactly one frame after the one before.
    const pk = execFileSync(FP, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=time_base:packet=pts,duration',
      '-of', 'compact=p=0', recFile], { maxBuffer: 1 << 28 }).toString().trim().split(/\r?\n/);
    const tbLine = pk.find((l) => /time_base=/.test(l));
    const tb = tbLine ? tbLine.match(/time_base=(\d+)\/(\d+)/) : null;
    const pts = pk.filter((l) => /^pts=/.test(l)).map((l) => Number(l.match(/pts=(-?\d+)/)[1]));
    const frameTicks = tb ? (1024 / 48000) * (Number(tb[2]) / Number(tb[1])) : 1024;
    let off = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i] - pts[i - 1] - frameTicks) > 1) off++;
    log(pts.length > 100 && off === 0, 'every AAC frame is stamped exactly one frame after the one before',
      `${off} of ${pts.length - 1} joins irregular (time base ${tb ? tb[1] + '/' + tb[2] : '?'})`);

    // The tone, window by window, over the whole run.
    const x = decodeAudio(recFile);
    const W = 2048, perBucket = 30;
    const buckets = [];
    for (let s0 = 48000 * 2; s0 + W < x.length - 48000; s0 += W * 3) {
      const d = thdN(x, s0, W, FREQ);
      if (d == null) continue;
      const k = Math.floor(s0 / 48000 / perBucket);
      (buckets[k] = buckets[k] || []).push(d);
    }
    console.log('    window of the run     median THD+N   worst    damaged (> -40 dB)');
    let firstBad = null, lateBad = 0, lateN = 0, earlyMed = null, lateMed = null;
    buckets.forEach((b, k) => {
      if (!b) return;
      const sorted = b.slice().sort((p, q) => p - q);
      const med = sorted[sorted.length >> 1], worst = sorted[sorted.length - 1];
      const bad = b.filter((v) => v > -40).length;
      console.log(`    ${String(k * perBucket).padStart(4)}-${String((k + 1) * perBucket).padEnd(4)}s          ${med.toFixed(1).padStart(6)} dB   ${worst.toFixed(1).padStart(6)}   ${bad} of ${b.length}`);
      if (k === 0) earlyMed = med;
      lateMed = med;
      if (k * perBucket >= 120) { lateBad += bad; lateN += b.length; }
      if (bad && firstBad == null) firstBad = k * perBucket;
    });
    log(lateN > 0 && lateBad / lateN < 0.005, 'after two minutes, the sound is still a clean tone (the point where it used to go wrong)',
      `${lateBad} damaged windows of ${lateN} from 2:00 on`);
    log(earlyMed != null && lateMed != null && lateMed < earlyMed + 6, 'and the end of the run is as clean as the start',
      `median ${earlyMed != null ? earlyMed.toFixed(1) : '?'} dB → ${lateMed != null ? lateMed.toFixed(1) : '?'} dB`);
    if (process.env.MW_KEEP) note('recording kept', recFile);
    else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }
  console.log('\n' + (failed ? 'NDI LONG RUN: FAILURES ABOVE' : 'NDI LONG RUN: all checks passed'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
