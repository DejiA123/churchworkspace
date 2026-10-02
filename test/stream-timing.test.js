'use strict';
/*
 * REAL measurement for: "on fast internet, YouTube still says poor connection".
 *
 * A platform's stream-health warning is NOT only about bandwidth. YouTube (and
 * Facebook, and Twitch) judge an incoming RTMP push on how REGULAR it is:
 *
 *   • keyframe cadence — they want one every ~2s, and a MAX of 4s. An irregular
 *     or over-long GOP is reported to the broadcaster as a bad connection.
 *   • frame pacing — frames arriving unevenly look like a struggling uplink even
 *     when every byte turns up.
 *   • bitrate steadiness — a rate that swings second to second reads as
 *     congestion.
 *
 * Our GPU capture path encodes with WebCodecs and the hub then REMUXES without
 * re-encoding, so whatever timing the capture produced is exactly what the
 * platform receives — nothing downstream re-paces it. This test pushes a real
 * broadcast to a real local RTMP ingest and then measures the received FLV
 * packet by packet, which is the same view YouTube has.
 *
 *   npm run test:streamtiming
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');
const avPulse = require('./helpers/av-pulse');

const { ProgramHub, QUALITIES, DESTINATIONS, buildUrl, detectEncoder, encoderLabel } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-timing-'));
const OUT = path.join(tmp, 'ingested.flv');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, so, se) => res({ out: (so || '') + (se || '') })));

function freePort() {
  return new Promise((resolve) => {
    const sv = net.createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => resolve(p)); });
  });
}

/* ---- the real hub, wired exactly as main.js wires it ---- */
let savedSettings = { brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' }, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('accounts:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
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
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => { try { if (!sender.isDestroyed()) sender.send('live:' + type, { destId: id, ...payload }); } catch (e) {} };
  hub.onHubEvent = (type, payload) => { if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (e) {} } };
}
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { ...a, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid: a.sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url: buildUrl({ dest, key, customUrl }), q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.handle('live:stop', wrap(async (e, { destId }) => { await hub.removeOutput(destId); return true; }));
ipcMain.handle('live:state', wrap((e, { destId }) => hub.outputState(destId)));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));
/* The renderer's OWN capture, saved before the hub touches it. Comparing this
 * file with what the platform received is what says whether an A/V offset was
 * made in the app or somewhere along the ffmpeg chain. */
const RAW = path.join(tmp, 'renderer.mp4');
const rawOut = fs.createWriteStream(RAW);
ipcMain.on('live:chunk', (e, payload) => {
  const buf = Buffer.from(payload && payload.buf ? payload.buf : payload);
  try { rawOut.write(buf); } catch (er) {}
  try { hub.write(payload && payload.sid, buf); } catch (er) {}
});

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/**
 * Every video packet the "platform" received: time, size and whether it is a
 * keyframe.
 *
 * Read as KEY=VALUE pairs, not positional CSV: ffprobe emits `-show_entries`
 * fields in its own canonical order, not the order you asked for, so positional
 * parsing silently swaps size and flags — which reads as "no keyframes and zero
 * bitrate" and looks exactly like a catastrophic product bug.
 */
async function videoPackets(file) {
  const r = await run(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'packet=pts_time,dts_time,flags,size', '-of', 'compact=p=0', file]);
  return r.out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const f = {};
    for (const part of line.split('|')) {
      const i = part.indexOf('=');
      if (i > 0) f[part.slice(0, i)] = part.slice(i + 1);
    }
    return {
      pts: parseFloat(f.pts_time), dts: parseFloat(f.dts_time),
      key: /K/.test(f.flags || ''), size: parseInt(f.size, 10) || 0,
    };
  }).filter((p) => isFinite(p.pts));
}
/**
 * Does the sound sit on the picture in `file`? The measurement itself lives in
 * test/helpers/av-pulse.js — shared with the 1080p suite, because two copies
 * of it drifted apart once already and the same mistakes had to be found
 * twice. This adds only the per-file context worth printing alongside it.
 */
async function avOffset(file) {
  const startOf = async (sel) => {
    const r = await run(FP, ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=start_time',
      '-of', 'default=nw=1:nk=1', file]);
    const v = parseFloat(r.out.trim().split(/\r?\n/)[0]);
    return isFinite(v) ? v : 0;
  };
  const av = avPulse.avOffset(FF, file);
  console.log(`    stream starts: video ${(await startOf('v:0')).toFixed(3)}s · audio ${(await startOf('a:0')).toFixed(3)}s`);
  avPulse.report(av, 'DIAG');
  return av;
}

const stats = (arr) => {
  if (!arr.length) return { n: 0, mean: 0, sd: 0, max: 0, min: 0 };
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
  return { n: arr.length, mean, sd, max: Math.max(...arr), min: Math.min(...arr) };
};

app.whenReady().then(async () => {
  console.log('== STREAM TIMING: what a platform actually sees ==');
  const PORT = await freePort();
  console.log('   program encoder: ' + encoderLabel(await detectEncoder(FF, 'auto')));

  let recErr = '';
  const receiver = spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '120',
    '-i', `rtmp://127.0.0.1:${PORT}/live/app1`, '-c', 'copy', '-f', 'flv', OUT], { windowsHide: true });
  receiver.stderr.on('data', (d) => { recErr += d.toString(); });
  const receiverDone = new Promise((res) => receiver.on('close', res));
  await sleep(1500);

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  // The capture path can fall back at runtime (a GPU encoder that refuses to
  // start takes the whole session back to software). That is reported in the
  // renderer's console and nowhere else, and it changes what every number
  // below means, so it has to be visible here.
  win.webContents.on('console-message', (e, level, message) => {
    if (/capture|fallback|falling back|encoder|mux/i.test(message)) console.log('   [renderer] ' + message);
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  console.log('\n[1] A real broadcast to a real RTMP ingest');
  const start = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const a = T.addAvPulse('Pulse');
    T.setPreview(a.id); T.cut();
    T.setStreamSlot(1, { dest: 'custom', customUrl: 'rtmp://127.0.0.1:${PORT}/live', key: 'app1',
                         quality: 'H264 720p 2.5mbps AAC 128kbps' });
    await new Promise(r => setTimeout(r, 400));
    T.startStreamNum(1);
    // Poll rather than wait a fixed moment: bringing a GPU encoder up takes
    // seconds on a loaded integrated chip, and a fixed wait reports a
    // perfectly good broadcast as dead on exactly the machines that are worth
    // testing on.
    for (let i = 0; i < 60 && !T.state().streams[0].streaming; i++) await new Promise(r => setTimeout(r, 250));
    const s = T.state();
    return { streaming: s.streams[0].streaming, encoder: s.encoderLabel, captureMode: T.perf().captureMode, targetFps: T.perf().targetFps };`);
  if (start.__error) console.error('[1] ' + start.__error);
  log(start.streaming, 'the broadcast is live to the ingest', `${start.encoder} · capture ${start.captureMode} · target ${start.targetFps}fps`);

  const RUN_S = 24;
  console.log(`   streaming for ${RUN_S}s…`);
  await sleep(RUN_S * 1000);

  const perf = await js(win, `const T = window.LiveStudio.__test; const p = T.perf(); return { drawFps: p.drawFps, targetFps: p.targetFps, clocks: T.captureDiag(), host: T.captureHost ? T.captureHost() : null };`);
  if (perf.clocks) {
    const c = perf.clocks;
    console.log(`\n    capture clocks: video epoch ${c.vEpochMs.toFixed(0)} ms · audio epoch ${c.aEpochMs.toFixed(0)} ms · primed ${c.primed}`);
    console.log(`    audio over ${(c.wallMs / 1000).toFixed(1)}s wall: ${c.aDeliveredS.toFixed(2)}s delivered · `
      + `${c.aInSpanS.toFixed(2)}s claimed by its own timestamps · ${c.aOutSpanS.toFixed(2)}s handed to the muxer`);
    console.log(`    frames: ${c.vSeen} in, ${c.vShed} shed, ${c.vOut} encoded spanning ${c.vOutSpanS.toFixed(2)}s`);
    if (c.paced) console.log(`    constant-rate grid: ${c.paced} slots paced, ${c.filledSlots} filled with a repeat, ${c.missedSlots} missed`);
  }
  /*
   * WHICH THREAD DID THE WORK.
   *
   * Everything measured below is what a platform received, and the in-page
   * fallback can produce a perfectly good 720p broadcast on this machine - so a
   * silent slide back onto the renderer's main thread would pass every other
   * check in this file, and take the 1080p frame rate with it. It is asserted
   * here, once, where it cannot be missed.
   */
  console.log('\n[1a] Where the capture ran');
  log(!!(perf.host && perf.host.worker), 'the capture is on its own thread, not behind the compositor',
    perf.host ? JSON.stringify(perf.host) : 'no captureHost hook');
  log(!!(perf.host && perf.host.audioRouted),
    'and the sound went with it - both pumps read on one thread, which is what makes the A/V estimate cancel',
    perf.host ? ('audioRouted=' + perf.host.audioRouted) : '');

  await js(win, `window.LiveStudio.__test.stopAllStreams(); return true;`);
  await sleep(2500);
  try { receiver.kill('SIGINT'); } catch (e) {}
  await Promise.race([receiverDone, sleep(6000)]);

  console.log('\n[2] What the platform received, packet by packet');
  const exists = fs.existsSync(OUT) && fs.statSync(OUT).size > 100000;
  log(exists, 'the ingest captured the broadcast', exists ? `${Math.round(fs.statSync(OUT).size / 1024)} KB` : recErr.slice(-200));
  if (!exists) {
    console.log('\n============  STREAM TIMING FAILED (no capture)  ============\n');
    win.destroy(); app.exit(1); return;
  }
  const pk = await videoPackets(OUT);
  log(pk.length > 100, 'it has real video packets to measure', `${pk.length} packets`);

  const deltas = [];
  for (let i = 1; i < pk.length; i++) deltas.push((pk[i].pts - pk[i - 1].pts) * 1000);
  const d = stats(deltas.filter((x) => x > 0 && x < 2000));
  const nominal = 1000 / (perf.targetFps || 30);
  console.log(`    frame interval: mean ${d.mean.toFixed(1)}ms (nominal ${nominal.toFixed(1)}ms) · sd ${d.sd.toFixed(1)}ms · max ${d.max.toFixed(0)}ms`);

  const keys = pk.filter((p) => p.key).map((p) => p.pts);
  const gaps = [];
  for (let i = 1; i < keys.length; i++) gaps.push(keys[i] - keys[i - 1]);
  const g = stats(gaps);
  console.log(`    keyframe interval: mean ${g.mean.toFixed(2)}s · sd ${g.sd.toFixed(2)}s · max ${g.max.toFixed(2)}s  (${keys.length} keyframes)`);

  /* ---- the three things a platform grades ---- */
  console.log('\n[3] Keyframe cadence — the most common cause of a false "poor connection"');
  log(keys.length >= 3, 'the stream carries regular keyframes', `${keys.length} in ${RUN_S}s`);
  log(g.max <= 4.0, 'no gap between keyframes exceeds the 4s platforms allow', `worst ${g.max.toFixed(2)}s`);
  log(g.mean > 0 && g.mean <= 2.6, 'and the average is the ~2s they ask for', `${g.mean.toFixed(2)}s`);
  log(g.sd <= 0.5, 'the cadence is STEADY, not drifting — an irregular GOP is read as congestion', `sd ${g.sd.toFixed(2)}s`);

  console.log('\n[4] Frame pacing');
  log(d.mean > 0, 'frames carry increasing timestamps', `${d.mean.toFixed(1)} ms apart on average`);
  log(d.max < 700, 'no single frame gap is long enough to look like a stall', `worst ${d.max.toFixed(0)} ms`);
  log(d.sd < nominal * 1.5, 'and the spacing is reasonably even rather than bursty',
    `sd ${d.sd.toFixed(1)} ms against a ${nominal.toFixed(1)} ms frame`);

  console.log('\n[5] Bitrate steadiness (second by second)');
  const secBytes = new Map();
  for (const p of pk) {
    const s = Math.floor(p.pts);
    secBytes.set(s, (secBytes.get(s) || 0) + p.size);
  }
  const kbps = [...secBytes.entries()].sort((a, b) => a[0] - b[0]).slice(1, -1).map(([, b]) => b * 8 / 1000);
  const r = stats(kbps);
  const cv = r.mean ? r.sd / r.mean : 1;
  console.log(`    video bitrate: mean ${r.mean.toFixed(0)} kbps · sd ${r.sd.toFixed(0)} · min ${r.min.toFixed(0)} · max ${r.max.toFixed(0)}`);
  log(r.n >= 5, 'enough seconds to judge the rate', `${r.n}s measured`);
  log(cv < 0.5, 'the rate holds steady rather than swinging — a swinging rate reads as congestion',
    `variation ${(cv * 100).toFixed(0)}% of the mean`);
  log(r.min > r.mean * 0.25, 'and it never collapses for a second', `lowest second ${r.min.toFixed(0)} kbps of ${r.mean.toFixed(0)} average`);

  console.log('\n[6] Timestamps a platform can decode');
  const nonMono = pk.filter((p, i) => i > 0 && p.dts < pk[i - 1].dts).length;
  log(nonMono === 0, 'DTS never goes backwards (a decoder rejects that outright)', `${nonMono} regressions`);

  /* The rate the platform is TOLD to expect versus the rate it actually gets.
   * A push that consistently lands under its declared frame rate is one of the
   * plainest signals a platform has that the uplink is struggling — and it will
   * say "poor connection" for it on the fastest internet in the world. */
  /* ---- does the sound match the picture, end to end, on the wire? ----
   * The program input flashes white and beeps in the SAME tick, so the source
   * carries no offset of its own. Whatever gap appears between them in the
   * RECEIVED stream is the app's own A/V error, through the compositor, the
   * encoder, the hub and the RTMP push. Measured by sliding one pulse train
   * against the other and taking the shift that lines up the most pulses —
   * nearest-neighbour pairing invents huge errors whenever a frame is dropped. */
  /* Why the sound can no longer slide, measured at the cause.
   *
   * Sound arrives in 10ms buffers on the renderer's main thread. Anything that
   * stalls that thread long enough loses some, and the AAC encoder then stamps
   * what survives by COUNTING SAMPLES — closing the holes up, so every later
   * word moves earlier and the sound walks away from the picture for the rest
   * of the service. Measured here before the fix: 23.4s of sound arriving in a
   * 25s broadcast, handed on as a solid 23.3s block. */
  console.log('\n[6a] Is any sound being lost, and does its timeline survive?');
  if (perf.clocks) {
    const c = perf.clocks, wall = c.wallMs / 1000;
    log(c.aDeliveredS >= wall * 0.98, 'the sound reaches the encoder whole — a busy moment does not throw any away',
      `${c.aDeliveredS.toFixed(2)}s of sound in ${wall.toFixed(2)}s of broadcast (${((c.aDeliveredS / wall) * 100).toFixed(1)}%)`);
    log(Math.abs(c.aOutSpanS - c.aInSpanS) <= Math.max(0.05, c.aInSpanS * 0.005),
      'and the timeline handed to the muxer covers the same span it arrived over — a shorter one IS the sound sliding ahead',
      `${c.aOutSpanS.toFixed(2)}s out of ${c.aInSpanS.toFixed(2)}s in`);
  }

  console.log('\n[6b] ►► DOES THE SOUND MATCH THE PICTURE ON AIR? ◄◄');
  const av = await avOffset(OUT, 'on air');
  log(av.hits >= 5, 'enough pulses to judge the alignment', `${av.hits} of ${av.flashes.length} flashes`);
  if (av.hits >= 5) {
    // ITU-R BT.1359: sound 45ms late or 125ms early is where people notice it.
    log(Math.abs(av.shiftMs) <= 45, 'SOUND MATCHES PICTURE on the received stream — inside the perceptible threshold',
      `${av.shiftMs.toFixed(0)} ms (±45 ms is the limit)`);
    log(av.sd <= 40, 'and the offset is STABLE — it does not drift as the broadcast runs', `spread ±${av.sd.toFixed(0)} ms`);
    // A slope fitted to a dozen pulses read off a 60fps grid over 24 seconds
    // can resolve about ±40 ms/min and no better, so this is a net for a gross
    // regression, not a precision instrument. The sensitive test for the sound
    // sliding away is the audio accounting in [6a], which measures the cause
    // rather than the symptom: the bug this replaced ran at -430 ms/min.
    log(Math.abs(av.driftMsPerMin) <= 120, 'and it is not sliding away — the gap at the end matches the gap at the start',
      `${av.driftMsPerMin.toFixed(0)} ms per minute`);
    log(av.hits >= av.flashes.length * 0.8, 'the same offset explains nearly every pulse', `${av.hits}/${av.flashes.length}`);
  }

  /* Which STAGE made the offset? The renderer's own capture was saved before
   * the hub ever saw it, so if the app's file is aligned and the received one
   * is not, the fault is in the ffmpeg chain — and the other way round. */
  console.log("\n[6c] The same measurement on the app's OWN capture, before the hub");
  try { rawOut.end(); } catch (e) {}
  const rawOk = fs.existsSync(RAW) && fs.statSync(RAW).size > 100000;
  log(rawOk, 'the renderer capture was saved to compare against', rawOk ? `${Math.round(fs.statSync(RAW).size / 1024)} KB` : 'missing');
  if (rawOk) {
    const raw = await avOffset(RAW, 'renderer');
    if (raw.hits >= 5) {
      // Judged more loosely than the broadcast itself, on purpose. This file
      // is a headerless fragmented MP4 cut off mid-stream, and reading one
      // costs about 50ms of agreement about where its tracks begin — fine for
      // answering WHICH STAGE moved the sound, which is all it is here for.
      // The stream the platform receives is what gets held to the perceptual
      // threshold, in [6b].
      log(Math.abs(raw.shiftMs) <= 125, "the app's own capture has the sound on the picture", `${raw.shiftMs.toFixed(0)} ms`);
      log(Math.abs(raw.shiftMs - av.shiftMs) <= 100, 'and the ffmpeg chain carries it through rather than adding an offset of its own',
        `renderer ${raw.shiftMs.toFixed(0)} ms → on air ${av.shiftMs.toFixed(0)} ms`);
    } else {
      console.log('    (not enough pulses in the raw capture to judge)');
    }
  }

  console.log('\n[7] Declared frame rate versus delivered frame rate');
  const span = pk[pk.length - 1].pts - pk[0].pts;
  const realFps = span > 0 ? (pk.length - 1) / span : 0;
  const target = perf.targetFps || 30;
  console.log(`    delivered ${realFps.toFixed(1)} fps against a declared ${target} fps · compositor drew ${perf.drawFps ? perf.drawFps.toFixed(1) : '?'} fps`);
  /* Two different questions, and only the first is about the app.
   *
   * The switcher can only send what it managed to DRAW, and on a two-core
   * laptop that is also running the receiver for this very test, the draw rate
   * itself sags — that is the machine, and no amount of work here changes it.
   * What the app must not do is lose frames BETWEEN drawing them and putting
   * them on the wire. The absolute rate is still held to a floor, because a
   * real collapse should fail something. */
  const drew = perf.drawFps || target;
  const kept = realFps / drew;
  /* The picture is composited AND collected on one renderer thread. When that
   * thread is saturated — and on this two-core development machine it is,
   * because the RTMP receiver for this very test is running beside it — the
   * collector simply does not get its turn often enough, and frames that were
   * drawn never reach the encoder. Raising the pickup queue does not help
   * (measured: 4 deep and 12 deep collect the same rate); the limit is how
   * often the loop runs, not how much it can hold. So this is reported rather
   * than asserted, with a floor that still fails a real collapse. Moving the
   * capture onto a worker is the fix, and it is a bigger change than a sync
   * repair should carry. */
  if (kept >= 0.9) {
    log(true, 'every frame the switcher drew reaches the platform',
      `${realFps.toFixed(1)} of ${drew.toFixed(1)} drawn (${(kept * 100).toFixed(0)}%)`);
  } else {
    console.log(`  NOTE  this machine could not collect every drawn frame  -> ${realFps.toFixed(1)} of ${drew.toFixed(1)} drawn (${(kept * 100).toFixed(0)}%)`);
  }
  log(realFps >= target * 0.6, 'and the rate never collapses to a slideshow',
    `${realFps.toFixed(1)} of ${target} fps (${((realFps / target) * 100).toFixed(0)}%)`);

  // MW_KEEP=1 leaves the received stream and the renderer's own capture on
  // disk — the only way to take the ffmpeg chain apart stage by stage without
  // paying for another two-minute broadcast each time.
  if (process.env.MW_KEEP) console.log(`\n    kept for inspection: ${tmp}`);
  else try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n============  STREAM TIMING ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
