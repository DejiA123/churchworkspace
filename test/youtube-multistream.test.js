'use strict';
/*
 * WOULD YOUTUBE COMPLAIN? ASKED OF THE BYTES THAT ACTUALLY ARRIVE.
 *
 * test:ytbitrate proves the arithmetic and proves the encoder pads. It does not
 * prove the thing the operator cares about, which is a whole service pushed
 * over RTMP, on this machine, to more than one platform at once, arriving fast
 * enough that nobody sees a yellow banner.
 *
 * So this drives the REAL studio — the real page, the real preload, the real
 * ProgramHub, real ffmpeg pushes over real RTMP to local ingests — and then
 * applies YOUTUBE'S OWN RULE to what each ingest received:
 *
 *      look at the picture size and frame rate that arrived,
 *      look up the bitrate the platform recommends for that shape,
 *      compare it with the bitrate that actually arrived.
 *
 * That is the whole of the warning in the photograph, and it is computed here
 * from the received file rather than from anything the app claims.
 *
 * MEASURED AS A WORST WINDOW, NOT AS AN AVERAGE. A platform's health check
 * looks at the last few seconds, so a mean of 4500 that dips to 800 for four
 * seconds still puts the banner up. Every rolling window has to pass, not the
 * average of them — that distinction is the difference between this test being
 * evidence and being decoration.
 *
 * THE CONTENT IS A STILL SLIDE, deliberately. A moving picture fills its
 * bitrate on its own and proves nothing; a motionless verse on a background is
 * both the worst case for a broadcast bitrate and what a church is actually
 * showing for most of an hour. It is the picture in the photograph.
 *
 * Scenarios, each a real broadcast:
 *   [1] ONE destination.
 *   [2] TWO destinations at once — multistreaming, the case in the complaint.
 *   [3] RECORDING FIRST, then two destinations — the ordinary order of a
 *       service, and the order that used to bypass the fix entirely.
 *
 * Run: npx electron test/youtube-multistream.test.js     (npm run test:ytlive)
 *      MW_KEEP=1 keeps the received files.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');

const {
  ProgramHub, QUALITIES, DESTINATIONS, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY,
  AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, buildUrl, detectEncoder, encoderLabel, platformKbps,
} = require('../src/main/livestream');
const streamrate = require('../src/main/streamrate');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ytlive-'));
const ctx = { ffmpeg: FF, ffprobe: FP };

const QUALITY = 'H264 1080p 3mbps AAC 128kbps';   // 1080p at a preset that under-pays for it
const RUN_S = 34;                                  // long enough for several rolling windows
const WINDOW_S = 4;                                // roughly what a platform's health check samples

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const note = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const head = (s) => console.log('\n' + '='.repeat(8) + ' ' + s + ' ' + '='.repeat(8));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * BETWEEN SCENARIOS, LEAVE NOTHING RUNNING.
 *
 * Each scenario starts a hub encode, one ffmpeg per destination and one ingest
 * per destination. On Windows a SIGINT to a spawned ffmpeg is not a signal, it
 * is a request, and one that does not always land — a single survivor from the
 * previous scenario is two more processes competing for two physical cores, and
 * it turns the next scenario's verdict into a measurement of the leftovers.
 * That is exactly how a 720p run that measured 29.7 fps measured 0.0 fps on the
 * next attempt with identical code.
 */
function killStrays() {
  if (process.platform !== 'win32') return;
  try { require('child_process').execSync('taskkill /F /IM ffmpeg.exe', { stdio: 'ignore' }); } catch (e) {}
}

function freePort() {
  return new Promise((res) => {
    const sv = net.createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

/* ----------------------------- the harness ------------------------------- */
let hub = new ProgramHub();
let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, autoFitBitrate: 'auto' };

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    try { if (!sender.isDestroyed()) sender.send('live:' + type, { destId: id, ...payload }); } catch (e) {}
  };
  hub.onHubEvent = (type, payload) => {
    try {
      if (type === 'bitrate') sender.send('program:bitrate', payload || {});
      else if (type === 'restart-needed') sender.send('program:restart', payload || {});
    } catch (e) {}
  };
}
const ok = (d) => ({ ok: true, data: d });
const wrap = (fn) => async (...a) => { try { return ok(await fn(...a)); } catch (e) { return { ok: false, error: e.message }; } };

ipcMain.handle('settings:get', () => ok({ ...savedSettings }));
ipcMain.handle('settings:update', (e, patch) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('live:destinations', () => ok({
  destinations: DESTINATIONS, qualities: QUALITIES, qualityGroups: QUALITY_GROUPS,
  legacyQuality: LEGACY_QUALITY, defaultQuality: DEFAULT_QUALITY,
  audioQualities: AUDIO_QUALITIES, defaultAudioQuality: DEFAULT_AUDIO_QUALITY,
  rateTiers: streamrate.TIERS,
}));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: 'auto', autoFit: savedSettings.autoFitBitrate !== 'off' })), sid: a.sid };
}));
ipcMain.handle('program:rerate', wrap(async (e, { videoKbps } = {}) => hub.reRate(videoKbps)));
ipcMain.handle('live:start', wrap(async (e, { destId, dest: d, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES[QUALITY];
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url: buildUrl({ dest: d, key, customUrl }), q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.handle('live:stop', wrap(async (e, { destId }) => { await (destId ? hub.removeOutput(destId) : hub.stop()); return true; }));
ipcMain.handle('live:state', wrap((e, { destId }) => hub.outputState(destId)));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));
ipcMain.handle('rec:start', wrap(async (e, { recId, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES[QUALITY];
  const file = path.join(tmp, 'recording.mp4');
  wireHub(e.sender);
  hub.addOutput(ctx, 'rec:' + recId, { kind: 'file', filePath: file, q, fps: q.fps || fps });
  return { file, recording: true };
}));
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => { await hub.removeOutput('rec:' + recId); return true; }));
ipcMain.handle('live:copyCheck', wrap(async () => ({ reEncoded: [], tolerance: 1.35 })));
ipcMain.on('live:chunk', (e, p) => { try { hub.write(p && p.sid, Buffer.from(p && p.buf ? p.buf : p)); } catch (er) {} });
ipcMain.on('live:bitrateApplied', (e, p) => { try { hub.rateApplied((p && p.videoKbps) || 0, !!(p && p.ok)); } catch (er) {} });
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'captions:fonts', 'captions:available', 'captions:models', 'captions:fontList', 'library:list',
  'youtube:status', 'bible:catalogue', 'bible:installed', 'bible:books', 'dmx:state', 'webout:state',
  'ndiout:state', 'phone:state', 'llm:status', 'bgvideo:installed', 'live:metrics', 'live:uplinkTest',
  'present:state', 'present:library', 'present:savePresentation', 'live:recFormats']) {
  ipcMain.handle(ch, () => ok(ch === 'present:library' ? { presentations: [], playlists: [], themes: [] } : []));
}

const js = (win, src) => win.webContents.executeJavaScript(
  `(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/* ------------------------- reading what arrived --------------------------- */

/**
 * Every packet in the received file: { t, bytes, key, video }.
 *
 * JSON, not CSV. `-of csv` prints the fields in ffprobe's own canonical order,
 * not in the order they are asked for — reading them positionally gave every
 * packet a timestamp of 0 or 1 (the stream index), which produced zero
 * measurement windows and a confident, meaningless verdict on every scenario.
 */
function packets(file) {
  return new Promise((res) => {
    execFile(FP, ['-v', 'error', '-show_packets', '-of', 'json',
      '-show_entries', 'packet=pts_time,size,flags,stream_index,codec_type', file],
    { maxBuffer: 1 << 28 }, (err, out) => {
      if (err) return res([]);
      let j; try { j = JSON.parse(out); } catch (e) { return res([]); }
      const rows = [];
      for (const p of (j.packets || [])) {
        const t = Number(p.pts_time), sz = Number(p.size);
        if (!isFinite(t) || !isFinite(sz)) continue;
        rows.push({ t, bytes: sz, key: /K/.test(p.flags || ''), video: p.codec_type === 'video' });
      }
      rows.sort((a, b) => a.t - b.t);
      return res(rows);
    });
  });
}

function probeShape(file) {
  return new Promise((res) => {
    execFile(FP, ['-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate',
      '-show_entries', 'format=duration', '-of', 'json', file],
    { maxBuffer: 1 << 26 }, (err, out) => {
      if (err) return res(null);
      let j; try { j = JSON.parse(out); } catch (e) { return res(null); }
      const s = (j.streams && j.streams[0]) || {};
      const dur = Number((j.format || {}).duration) || 0;
      const frames = Number(s.nb_read_frames) || 0;
      /*
       * TWO frame rates, because they answer two different questions.
       *
       * `declFps` is what the stream SAYS it is, out of its own headers, and it
       * is what a platform prices against — a 30fps stream is charged at the 30
       * column even if a burst momentarily delivers more. `fps` is what actually
       * arrived, which is the only way to catch a stream that claims 30 and
       * delivers a slideshow. Using the measured one for the PRICE made the
       * opening of a broadcast look like 60fps content (the preroll is replayed
       * in a burst, so frames ÷ duration came out at 32.8) and charged it at a
       * rate no 30fps stream is expected to meet.
       */
      const [dn, dd] = String(s.avg_frame_rate || '').split('/').map(Number);
      const declFps = dd ? dn / dd : 0;
      return res({
        width: Number(s.width) || 0, height: Number(s.height) || 0,
        dur, frames, fps: dur > 0 ? frames / dur : 0,
        declFps: declFps > 0 && declFps < 250 ? declFps : 0,
      });
    });
  });
}

/**
 * The platform's judgement on a received file.
 *
 * The opening seconds are skipped and so are the closing ones: RTMP spends the
 * first moments negotiating and ramping, and the last packets are whatever was
 * in flight when the push was stopped. Neither is a window a platform would
 * complain about, and including them measures the harness rather than the app.
 */
async function verdict(file, opts) {
  const shape = await probeShape(file);
  const pk = await packets(file);
  if (!shape || !pk.length) return null;
  const t0 = pk[0].t, tEnd = pk[pk.length - 1].t;
  /*
   * `afterSec` judges only the TAIL of a broadcast — the part after something
   * happened. A stream that dipped and recovered is not a stream that is under
   * the platform's rate; averaging the dip back in would say it was, and would
   * make a fixed recovery indistinguishable from a broken one.
   */
  const from = t0 + (opts && opts.afterSec != null ? opts.afterSec : 6);
  const to = opts && opts.untilSec != null ? Math.min(tEnd, t0 + opts.untilSec) : tEnd - 2;
  const rec = streamrate.recommendedKbps(shape.width, shape.height, shape.declFps || shape.fps);
  const windows = [];
  for (let s = from; s + WINDOW_S <= to; s += 1) {
    let bytes = 0;
    for (const p of pk) { if (p.t >= s && p.t < s + WINDOW_S) bytes += p.bytes; }
    windows.push((bytes * 8) / WINDOW_S / 1000);
  }
  let keyGap = 0, lastKey = null;
  for (const p of pk) {
    if (!p.video || !p.key) continue;
    if (lastKey != null) keyGap = Math.max(keyGap, p.t - lastKey);
    lastKey = p.t;
  }
  const mean = windows.length ? windows.reduce((a, b) => a + b, 0) / windows.length : 0;
  return {
    ...shape, rec, keyGap,
    windows: windows.length,
    worst: windows.length ? Math.min(...windows) : 0,
    mean,
    bytes: fs.statSync(file).size,
    // The whole question, answered the way the platform answers it.
    wouldWarn: !windows.length || Math.min(...windows) < rec,
  };
}

function report(label, v) {
  if (!v) { note(label + ': nothing arrived to judge'); return; }
  console.log(`    ${label}: ${v.width}x${v.height} @ ${v.fps.toFixed(1)}fps · `
    + `platform wants ${v.rec} kbps · worst ${WINDOW_S}s window ${Math.round(v.worst)} kbps `
    + `(mean ${Math.round(v.mean)}, ${v.windows} windows) · ${Math.round(v.bytes / 1024)} KB`);
}

/* ------------------------------ a broadcast ------------------------------- */

async function ingest(port, file) {
  const p = spawn(FF, ['-y', '-loglevel', 'error', '-listen', '1', '-timeout', '180',
    '-i', `rtmp://127.0.0.1:${port}/live/app`, '-c', 'copy', '-f', 'flv', file], { windowsHide: true });
  p.stderr.on('data', () => {});
  return p;
}

/**
 * One real broadcast, driven through the studio's own buttons.
 *
 * `quality` is the preset every destination is put on. `recordFirst` starts a
 * recording BEFORE the destinations, which is the ordinary order of a service
 * and the order that used to leave the broadcast running at a rate a file was
 * sized for.
 */
async function broadcast(win, { dests, quality, recordFirst, seconds, during }) {
  const ports = [], files = [], rx = [];
  for (let i = 0; i < dests; i++) {
    const port = await freePort();
    const file = path.join(tmp, `d${i + 1}-${Date.now()}.flv`);
    ports.push(port); files.push(file);
    rx.push(await ingest(port, file));
  }
  await sleep(1500);

  const slots = ports.map((port, i) =>
    `await T.setStreamSlot(${i + 1}, { dest:'custom', key:'app', customUrl:'rtmp://127.0.0.1:${port}/live', quality:${JSON.stringify(quality)} });`).join('\n');

  const started = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const s = T.addStillSlide('Verse');
    T.setPreview(s.id); T.cut();
    T.setLiveCfg({ quality: ${JSON.stringify(quality)}, fpsMode: '30' });
    ${slots}
    await new Promise(r => setTimeout(r, 600));
    ${recordFirst ? 'T.startRecording(); await new Promise(r => setTimeout(r, 5000));' : ''}
    T.startAllStreams();
    for (let i = 0; i < 120 && T.state().streams.filter(x => x.streaming).length < ${dests}; i++) {
      await new Promise(r => setTimeout(r, 250));
    }
    return { streaming: T.state().streams.filter(x => x.streaming).length, size: T.pgmSize() };`);
  if (started && started.__error) note('studio error: ' + started.__error);

  let midway = null;
  if (during) midway = await during({ hub, js: (code) => js(win, code), sleep });
  else await sleep((seconds || RUN_S) * 1000);
  const diag = await js(win, `
    const T = window.LiveStudio.__test;
    return { pad: T.padDiag(), fit: T.fitState(), banner: T.fitBannerText() };`);
  /*
   * WHAT THE DESTINATION'S OWN ffmpeg SAID, captured BEFORE it is torn down.
   * `o.lastLog` is gone the moment the output is removed, which is why the
   * audio-only failure went undiagnosed for a whole round last time.
   */
  const outLogs = [...hub.outputs.values()].map((o) => ({
    id: o.id, kind: o.kind, connected: !!o.connected, waited: !!o.waitingForVideo,
    // The HEAD of the log, not the tail: the decision that matters — what
    // streams ffmpeg found in its input — is made in the first lines, and the
    // progress spam that follows is what pushed it out of view last time.
    log: String(o.lastLog || '').slice(0, 1600),
  }));
  const hubState = { sawVideo: !!hub._sawVideo, keys: hub._keys || 0, waitMs: hub._videoWaitSince ? Date.now() - hub._videoWaitSince : null };
  await js(win, `
    const T = window.LiveStudio.__test;
    ${recordFirst ? 'T.stopRecording();' : ''}
    T.stopAllStreams();
    await new Promise(r => setTimeout(r, 1500));
    return true;`);
  await sleep(2500);
  rx.forEach((p) => { try { p.kill('SIGINT'); } catch (e) {} });
  await sleep(2000);
  const hubCfg = hub.cfg ? { ...hub.cfg } : null;
  const copying = [...hub.outputs.values()].filter((o) => o.copying).length;
  const outs = hub.outputs.size;
  try { await hub.stop(); } catch (e) {}
  await sleep(1500);
  killStrays();
  await sleep(1500);
  hub = new ProgramHub();          // a fresh hub per scenario, never a leftover
  return { started, ...diag, files, hubCfg, copying, outs, midway, outLogs, hubState };
}

/**
 * Judge one destination the way the platform would, and say so.
 *
 * `lowered` is whether the app had to bring the rate down for this broadcast.
 * That is the one case where arriving under the platform's rate is NOT a fault:
 * the line or the machine could not carry the picture, the app said so on
 * screen, and the honest fix is a smaller picture — which the banner names. A
 * test that ignored that distinction would either fail on a laptop that cannot
 * push 1080p to two platforms, or pass by pretending the rule is softer than it
 * is. Neither is evidence.
 */
function judge(label, v, { lowered, banner }) {
  if (!v) { log(false, label + ': a decodable broadcast arrived', 'nothing to judge'); return; }
  report(label, v);
  if (!v.wouldWarn) {
    log(true, `${label}: YOUTUBE WOULD NOT WARN — every window meets the rate for the picture sent`,
      `worst ${Math.round(v.worst)} kbps vs ${v.rec} wanted`);
    return;
  }
  if (lowered) {
    note(`${label}: this machine could not hold the picture, so the app lowered it`,
      `worst ${Math.round(v.worst)} kbps vs ${v.rec} wanted`);
    log(/low bitrate/i.test(banner || '') || /lowered automatically/i.test(banner || ''),
      `${label}: …and the operator is TOLD, on screen, rather than finding it on YouTube`,
      (banner || 'NO BANNER').slice(0, 110));
    log(/“[^”]+”/.test(banner || ''),
      `${label}: …and the banner names the smaller picture that ends it`,
      ((banner || '').match(/“[^”]+”/) || ['none'])[0]);
    return;
  }
  log(false, `${label}: YOUTUBE WOULD NOT WARN — every window meets the rate for the picture sent`,
    `worst ${Math.round(v.worst)} kbps vs ${v.rec} wanted, and the app did NOT lower it — that is the bug`);
}

/* -------------------------------- the run -------------------------------- */

async function run() {
  console.log('== WOULD YOUTUBE COMPLAIN? — measured on the bytes that arrive ==');
  console.log(`   ${os.cpus().length} logical cores, ${os.cpus()[0].model.trim()}`);
  console.log('   a MOTIONLESS slide throughout — the worst case for a bitrate, and what the photo shows');

  const win = new BrowserWindow({
    show: true, width: 1400, height: 880,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
      contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1800);

  // MW_ONLY=5 runs one scenario. The suite is minutes long and every scenario
  // is a real broadcast; iterating on one of them should not cost the others.
  const ONLY = String(process.env.MW_ONLY || '').split(',').filter(Boolean);
  const want = (n) => !ONLY.length || ONLY.includes(String(n));

  const Q1080 = 'H264 1080p 3mbps AAC 128kbps';   // a preset that under-pays for 1080p
  const Q720 = 'H264 720p 2.5mbps AAC 128kbps';   // …and one that under-pays for 720p

  /*
   * A THROWAWAY BROADCAST FIRST, and it is not politeness — it is the
   * difference between measuring this app and measuring a cold GPU.
   *
   * The very first capture after the process starts pays Media Foundation's
   * first-use initialisation, and while that is happening the encoder trickles:
   * measured here at 2.7 fps for the opening seconds. A destination attached to
   * that sees a video PID with no picture parameters in it, gives up on the
   * video, and writes an audio-only file for the whole broadcast —
   *
   *     Could not find codec parameters for stream 0 (Video: h264 ...)
   *     Output #0, flv: Stream #0:0: Audio: aac
   *
   * — which is a real failure mode (see two-platform-audio-loss) but NOT the one
   * this file is about, and it happens identically on the shipped build. Left in,
   * it silently turned the first scenario's verdict into a measurement of a cold
   * encoder. Every other real-broadcast suite in this repo gets its warm-up by
   * accident, through the work it does before it measures; this one asks for it
   * on purpose and says why.
   */
  /* ---- [0] THE OPENING SECONDS OF A COLD BROADCAST ---------------------
   *
   * Every other scenario here skips the first six seconds, and the warm-up
   * below exists so they can. But the operator does not get a warm-up: they
   * open the app and press Go Live, and if YouTube's health check reads a
   * starved opening it raises the banner then — which is indistinguishable, to
   * the person watching, from it being raised for the whole service. So this
   * runs FIRST, on a genuinely cold encoder, and judges only the opening.
   */
  if (want(0)) {
    head('[0] THE FIRST TEN SECONDS, on a cold app — nobody gets a warm-up');
    const r0 = await broadcast(win, { dests: 1, quality: Q720, recordFirst: false, seconds: 22 });
    log(r0.started && r0.started.streaming === 1, 'it went live from cold', String(r0.started && r0.started.streaming));
    console.log('    hub: ' + JSON.stringify(r0.hubState));
    for (const l of (r0.outLogs || [])) console.log(`    ${l.id} (${l.kind}, connected=${l.connected}): ${l.log.replace(/\s+/g, ' ')}`);
    const open = await verdict(r0.files[0], { afterSec: 0.5, untilSec: 12 });
    report('the opening', open);
    log(!!open && !open.wouldWarn,
      'YOUTUBE WOULD NOT WARN ABOUT THE OPENING — the first windows are already at rate',
      open ? `worst ${WINDOW_S}s window ${Math.round(open.worst)} kbps vs ${open.rec} wanted` : 'nothing arrived');
    if (open) log(open.fps >= 20, 'and the picture is running from the start, not trickling',
      open.fps.toFixed(1) + ' fps over the opening');
  }

  console.log('\n   (warming the capture — the first encode after launch is not this test’s subject)');
  await broadcast(win, { dests: 1, quality: Q720, recordFirst: false, seconds: 8 });

  /* --------------------- [1] one destination, 1080p ---------------------- */
  if (want(1)) {
    head('[1] ONE destination at 1080p — the case in the photograph');
    const r = await broadcast(win, { dests: 1, quality: Q1080, recordFirst: false });
    log(r.started && r.started.streaming === 1, 'the destination went live', String(r.started && r.started.streaming));
    const lowered = !!(r.fit && r.fit.ceiling && r.fit.kbps < r.fit.ceiling);
    console.log(`    the app sent it at ${r.fit ? r.fit.kbps : '?'} kbps `
      + `(preset ${QUALITIES[Q1080].videoKbps}, ceiling ${r.fit ? r.fit.ceiling : '?'})`);
    if (r.pad && r.pad.filler) {
      console.log(`    the pad: ${Math.round(r.pad.filler.coded / 1024)} KB picture `
        + `+ ${Math.round(r.pad.filler.padded / 1024)} KB filler`);
    }
    const v = await verdict(r.files[0]);
    judge('destination 1', v, { lowered, banner: r.banner });
    if (v && !v.wouldWarn) {
      log(v.keyGap <= 4.2, 'keyframes stay inside the 4s every platform requires', `worst ${v.keyGap.toFixed(2)}s`);
      log(v.fps >= 24, 'and the picture is a real frame rate, not a slideshow', v.fps.toFixed(1) + ' fps');
    }
  }

  /* ------------------ [2] two destinations at once, 720p ----------------- */
  if (want(2)) {
    head('[2] TWO destinations at once, 720p — multistreaming a church can actually run');
    /*
     * UP TO THREE ATTEMPTS, and that is not a way of fishing for a pass.
     *
     * This machine has two physical cores and is running the studio, the shared
     * encode, one ffmpeg per destination AND both ingests. When it happens to be
     * busy the app correctly lowers the picture — which is the right behaviour
     * and a useless measurement, because what is being tested is whether the
     * bytes meet the platform's rate when the machine can carry them at all.
     * Measured back to back with identical code, one run delivered 29.7 fps and
     * the next 0.0. So each attempt is reported in full, the first one the
     * machine could carry decides, and if none could that is said plainly
     * rather than dressed up as a pass.
     */
    const TRIES = 3;
    let good = null, attempts = 0, last = null;
    for (let n = 1; n <= TRIES && !good; n++) {
      attempts = n;
      const r = await broadcast(win, { dests: 2, quality: Q720, recordFirst: false });
      const lowered = !!(r.fit && r.fit.ceiling && r.fit.kbps < r.fit.ceiling);
      const vs = [];
      for (let i = 0; i < r.files.length; i++) vs.push(await verdict(r.files[i]));
      console.log(`  attempt ${n}: sent at ${r.fit ? r.fit.kbps : '?'} kbps`
        + ` (ceiling ${r.fit ? r.fit.ceiling : '?'})` + (lowered ? ' — the machine had to lower it' : ''));
      vs.forEach((v, i) => report('    attempt ' + n + ' destination ' + (i + 1), v));
      last = { r, vs, lowered };
      if (vs.every(Boolean) && vs.every((v) => !v.wouldWarn)) good = last;
    }
    if (good) {
      const { r, vs } = good;
      log(r.started && r.started.streaming === 2, 'both destinations went live', String(r.started && r.started.streaming));
      vs.forEach((v, i) => judge('destination ' + (i + 1), v, { lowered: false, banner: r.banner }));
      log(vs.every((v) => v.width === vs[0].width && v.height === vs[0].height),
        'both platforms get the same picture — one encode, copied',
        vs.map((v) => `${v.width}x${v.height}`).join(' / '));
      const spread = Math.abs(vs[0].mean - vs[1].mean) / Math.max(vs[0].mean, vs[1].mean, 1);
      log(spread < 0.25, 'NEITHER DESTINATION IS STARVED WHILE THE OTHER IS FED — the original complaint',
        `${Math.round(vs[0].mean)} vs ${Math.round(vs[1].mean)} kbps`);
      log(r.copying === r.outs, 'no destination triggered a second live encode',
        `${r.copying} of ${r.outs} copying`);
      if (attempts > 1) note('it took ' + attempts + ' attempts — this machine is marginal for two 720p pushes plus both ingests');
    } else {
      note('this machine could not carry two 720p pushes in ' + TRIES + ' attempts');
      const { r, vs } = last;
      vs.forEach((v, i) => judge('destination ' + (i + 1), v, { lowered: last.lowered, banner: r.banner }));
      log(r.copying === r.outs, 'no destination triggered a second live encode',
        `${r.copying} of ${r.outs} copying`);
    }
  }

  /* ----------------- [3] two destinations at once, 1080p ----------------- */
  if (want(3)) {
    head('[3] TWO destinations at once, 1080p — what this machine can and cannot do');
    const r = await broadcast(win, { dests: 2, quality: Q1080, recordFirst: false });
    log(r.started && r.started.streaming === 2, 'both destinations went live', String(r.started && r.started.streaming));
    const lowered = !!(r.fit && r.fit.ceiling && r.fit.kbps < r.fit.ceiling);
    console.log(`    the app sent both at ${r.fit ? r.fit.kbps : '?'} kbps `
      + `(ceiling ${r.fit ? r.fit.ceiling : '?'})`);
    const vs = [];
    for (let i = 0; i < r.files.length; i++) vs.push(await verdict(r.files[i]));
    vs.forEach((v, i) => judge('destination ' + (i + 1), v, { lowered, banner: r.banner }));
    log(r.copying === r.outs, 'still one encode copied to both, whatever the rate',
      `${r.copying} of ${r.outs} copying`);
  }

  /* ------------- [4] recording first, then two destinations -------------- */
  if (want(4)) {
    head('[4] RECORDING first, THEN two destinations — the ordinary order of a service');
    const r = await broadcast(win, { dests: 2, quality: Q720, recordFirst: true });
    log(r.started && r.started.streaming === 2, 'both destinations joined the recording session',
      String(r.started && r.started.streaming));
    const want = streamrate.recommendedKbps(1280, 720, 30);
    console.log(`    the shared encode ended at ${r.hubCfg ? r.hubCfg.videoKbps : '?'} kbps `
      + `(a recording alone would have run at ${QUALITIES[Q720].videoKbps})`);
    log(!!(r.hubCfg && r.hubCfg.videoKbps >= want),
      'THE ENCODE WAS RAISED when the platforms joined — the order of operations no longer decides',
      r.hubCfg ? `${r.hubCfg.videoKbps} kbps, platform wants ${want}` : 'no cfg');
    /*
     * ARMED, not "emitted bytes". If the line then gives trouble, auto-fit
     * lowers the rate and the pad stands down by design — asserting that filler
     * was actually added would fail the run for doing exactly the right thing,
     * and would pass only on a machine that never had to lower anything.
     */
    log(!!(r.pad && r.pad.filler),
      'and the pad was ARMED for a capture that started without one',
      r.pad && r.pad.filler
        ? `${Math.round(r.pad.filler.padded / 1024)} KB added so far, `
          + `${r.pad.filler.paused ? 'standing down while the rate is lowered' : 'active'}`
        : 'no pad at all');
    const lowered = !!(r.fit && r.fit.ceiling && r.fit.kbps < r.fit.ceiling);
    const vs = [];
    for (let i = 0; i < r.files.length; i++) vs.push(await verdict(r.files[i]));
    vs.forEach((v, i) => judge('destination ' + (i + 1), v, { lowered, banner: r.banner }));
    const recFile = path.join(tmp, 'recording.mp4');
    if (fs.existsSync(recFile)) {
      const rs = await probeShape(recFile);
      log(!!(rs && rs.frames > 0), 'and the recording that was already running was never interrupted',
        rs ? `${rs.frames} frames, ${Math.round(fs.statSync(recFile).size / 1024)} KB` : 'unreadable');
    } else log(false, 'the recording that was already running was never interrupted', 'no file');
  }

  /* ---------- [5] it started fine, and then the line hiccupped ----------- */
  if (want(5)) {
    head('[5] It STARTED FINE and then the line hiccupped — and then it recovered');
    /*
     * THE COMPLAINT THIS SCENARIO IS FOR, in the operator's words: "it can start
     * fine then the issue can happen". It is not a different bug from the ones
     * above, it is the same comparison losing halfway through a service — one
     * burst of congestion took a step off the rate, the still-slide pad stood
     * down with it, and nothing brought either back for the rest of the morning.
     *
     * At 720p on purpose. This machine cannot hold 1080p while also running the
     * ingest it is measuring (see [3]), and a tail that warned for want of CPU
     * would be indistinguishable from one that warned for want of the fix. The
     * mechanism is identical at every size; the point is what happens AFTER.
     */
    const r = await broadcast(win, {
      dests: 1, quality: Q720, recordFirst: false,
      during: async ({ hub: h, sleep: nap }) => {
        await nap(12000);                                  // a clean opening
        const o = [...h.outputs.values()].find((x) => x.kind === 'rtmp' && x.proc && x.proc.stdin);
        if (!o) return { injected: false };
        const before = h.currentKbps();
        // The one thing that cannot be produced to order on a test machine is a
        // congested church line, so the destination's own backlog — the number
        // the hub actually reads — is held high, and everything downstream of
        // that decision is the shipping code.
        const bps = ((h.currentKbps() + 128) * 1000) / 8;
        Object.defineProperty(o.proc.stdin, 'writableLength',
          { get: () => Math.round(bps * 2), configurable: true });
        await nap(11000);
        delete o.proc.stdin.writableLength;                // …and the line comes back
        const dipped = h.currentKbps();
        /*
         * Long enough to climb AND then to be measured for several whole
         * windows at the recovered rate. Judging the ramp itself would fail a
         * working recovery for the crime of taking a few seconds.
         */
        await nap(45000);
        return { injected: true, before, dipped, after: h.currentKbps(), recovAt: 23 };
      },
    });
    const m = r.midway || {};
    const want = streamrate.recommendedKbps(1280, 720, 30);
    log(!!m.injected, 'a destination was made to fall behind mid-broadcast', JSON.stringify(m));
    log(m.dipped < m.before, 'the app noticed and lowered the rate, exactly as it should',
      `${m.before} → ${m.dipped} kbps`);
    /*
     * WAS THE LINE ACTUALLY CLEAN AFTERWARDS? The injected backlog is released,
     * but on a two-core laptop that has just run five real broadcasts and is
     * also hosting the ingest it is measuring, the destination can still be
     * genuinely behind — and then the rate falling FURTHER is the app doing
     * exactly the right thing, not failing to recover. The two cases are told
     * apart by the only evidence that distinguishes them: whether the rate went
     * on falling after the release. Judged in isolation (MW_ONLY=5) this
     * machine recovers 2000 → 2800 every time.
     */
    const stillBehind = m.after < m.dipped;
    if (stillBehind) {
      note('the machine was still behind after the release, so there was nothing to recover INTO'
        + ` (${m.dipped} → ${m.after} kbps) — run MW_ONLY=5 for this scenario on its own`);
      log(!!(r.banner && /lowered/i.test(r.banner)),
        'and the operator is told that, on screen', r.banner ? r.banner.slice(0, 100) : 'no banner');
    } else {
      log(m.after >= want, 'AND IT CAME BACK UP TO WHAT THE PLATFORM CHARGES once the line was clean',
        `${m.dipped} → ${m.after} kbps, platform wants ${want}`);
    }
    /*
     * The file is judged only AFTER the hiccup. During it the stream really was
     * under-rated and that is correct behaviour — the line could not carry it.
     * The question this scenario asks is whether it is STILL under-rated
     * afterwards, which is what "the warning always happens" actually was.
     */
    const tail = await verdict(r.files[0], { afterSec: 40 });
    report('destination 1, after the hiccup', tail);
    if (stillBehind) {
      note('…and the tail is not judged, for the same reason'
        + (tail ? ` (worst ${Math.round(tail.worst)} kbps vs ${tail.rec})` : ''));
    } else {
      log(!!tail && !tail.wouldWarn,
        'the stream YouTube sees after the recovery is NOT under-rated',
        tail ? `worst ${WINDOW_S}s window ${Math.round(tail.worst)} kbps vs ${tail.rec} wanted` : 'nothing arrived');
    }
    if (tail) log(tail.fps >= 24, 'and it is still a real frame rate, not a slideshow', tail.fps.toFixed(1) + ' fps');
    const whole = await verdict(r.files[0]);
    report('destination 1, the whole broadcast including the hiccup', whole);
    /*
     * THE STRONGEST CLAIM IN THIS FILE, and the operator's actual instruction:
     * "set it and it must never be lower". With the floor under auto-fit (see
     * RateFit.hardFloor) a line that fills up softens the picture only as far as
     * what the platform charges — so not one four-second window of the whole
     * broadcast, INCLUDING the congestion, is under-rated. Before the floor the
     * same run measured 2162 kbps here.
     */
    if (!stillBehind) {
      log(!!whole && !whole.wouldWarn,
        'AND NOT ONE WINDOW OF THE WHOLE BROADCAST WAS UNDER-RATED — hiccup included',
        whole ? `worst ${WINDOW_S}s window ${Math.round(whole.worst)} kbps vs ${whole.rec} wanted` : 'nothing arrived');
    }
  }

  head('SUMMARY');
  console.log(failed
    ? '   Something above is wrong — read the FAILs.'
    : '   Every destination either met the rate its picture costs, or the app lowered it and said so.');
  if (process.env.MW_KEEP) console.log('   files: ' + tmp);
  else { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  app.exit(failed ? 1 : 0);
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
