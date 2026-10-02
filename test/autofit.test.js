'use strict';
/*
 * "On the Go Live page, streaming to YouTube goes choppy — the picture and the
 *  sound break up like it did before, when the bitrate was too low."
 *
 * What was happening: the app sent whatever the chosen preset said, and when the
 * line could not carry it the DESTINATION dealt with the shortfall by throwing
 * picture away (see TsShedder). That protects the sound from corruption, and it
 * is the right emergency answer, but as a steady state it is exactly what a
 * congregation watching at home sees as juddering video with the audio dragging
 * along behind it — because a platform re-times the stream every time the
 * picture stops and starts.
 *
 * The fix is to SEND LESS instead: the shared encode's video bitrate now follows
 * the slowest destination down until the stream fits, and creeps back up when it
 * plainly fits again. This suite proves the three things that have to be true
 * for that to be a fix rather than a story:
 *
 *   [1] the DECISION is right — it comes down for sustained congestion, not for
 *       a burst; it settles rather than flaps; it has a floor; and it climbs
 *       back slowly, with each premature climb costing the next one twice the
 *       wait. Proved against a fake clock, so it needs no platform and no
 *       afternoon.
 *   [2] the whole CHAIN really carries it — a real broadcast, a real GPU
 *       capture, a real RTMP push to a real ingest, and the rate change taken
 *       all the way from the hub's own timer through the IPC into the encoder.
 *   [3] and what the platform receives is genuinely SMALLER AND STILL SMOOTH —
 *       measured out of the received stream, packet by packet. A drop in
 *       bitrate that costs the picture its frame rate would be no better than
 *       the shedding it replaces.
 *
 *   npm run test:autofit
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');

const {
  ProgramHub, RateFit, QUALITIES, DESTINATIONS, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY,
  AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, buildUrl, detectEncoder, encoderLabel,
  FIT_DOWN_HOLD_MS, FIT_SETTLE_MS, FIT_UP_AFTER_MS, FIT_FLOOR_FRACTION, FIT_PROBE_FAIL_MS,
  platformKbps,
} = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-autofit-'));
const QUALITY = 'H264 720p 2.5mbps AAC 128kbps';
const CEILING = QUALITIES[QUALITY].videoKbps;      // 2500
const BEFORE_S = 14;   // at the preset
const AFTER_S = 16;    // …and after auto-fit has come down
const outFlv = path.join(tmp, 'dest1.flv');

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const warn = (n, d) => console.log('  NOTE  ' + n + (d ? '  -> ' + d : ''));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 28 }, (e, so, se) => res({ out: (so || '') + (se || '') })));

function freePort() {
  return new Promise((res) => {
    const sv = net.createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

/* ============================================================================
 * [1] THE DECISION, against a clock we control.
 *
 * Everything here is the RateFit class the hub actually uses — no re-statement
 * of its rules in the test, because a test that re-implements the thing it is
 * testing proves only that it can be written twice.
 * ==========================================================================*/
function dest(behindSec, shedding = false, copying = true, id = 'd1') { return { id, behindSec, shedding, copying }; }

function decisionChecks() {
  console.log('\n[1] The decision: when does the picture come down, and when does it go back up?');

  // A burst is not congestion. RTMP is bursty by nature — every keyframe is a
  // spike — and an encoder that reacts to one is an encoder that never settles.
  {
    const f = new RateFit(CEILING);
    let t = 0;
    f.tick([dest(3)], t); t += 1000;
    const r = f.tick([dest(0.1)], t);
    log(!r.changed && f.target === CEILING, 'one busy second does NOT change the picture', `${f.target} kbps`);
  }

  // Sustained congestion does.
  {
    const f = new RateFit(CEILING);
    let t = 0, changed = null;
    for (let i = 0; i < 5; i++) { const r = f.tick([dest(3)], t); if (r.changed) changed = r; t += 1000; }
    log(!!changed, 'sustained congestion lowers it', changed && `${changed.from} → ${changed.target} kbps`);
    log(changed && changed.target < CEILING * 0.8, 'and by a step big enough to matter', changed && `${changed.target} kbps`);
    log(changed && changed.direction === 'down', 'reported as a step down for the UI');
  }

  // It waits for the change to take effect before making another one — otherwise
  // one busy moment walks the whole broadcast down to the floor in seconds.
  {
    /* Both moments are read INSIDE the tick that made the change. Advancing the
     * clock first and then reading it reports every gap 500 ms short — one whole
     * tick of measurement error, which is enough to fail a 5000 ms rule by
     * exactly one tick and send somebody looking for a bug in the controller. */
    const f = new RateFit(CEILING);
    let t = 0, firstAt = null, secondAt = null, first = CEILING;
    for (let i = 0; i < 80 && secondAt === null; i++) {
      const r = f.tick([dest(3)], t);
      if (r.changed) {
        if (firstAt === null) { firstAt = t; first = f.target; } else secondAt = t;
      }
      t += 500;
    }
    log(firstAt !== null && secondAt !== null && secondAt - firstAt >= FIT_SETTLE_MS,
      'a second step waits for the first one to show',
      `${secondAt - firstAt} ms apart (settle ${FIT_SETTLE_MS} ms)`);
    log(f.target < first, 'and then it does come down again', `${first} → ${f.target} kbps`);
  }

  // A floor. Below a quarter of the preset the line is not busy, it is broken,
  // and quietly streaming a smear is not a kindness.
  {
    const f = new RateFit(CEILING);
    let t = 0;
    for (let i = 0; i < 400; i++) { f.tick([dest(6)], t); t += 500; }
    log(f.target === f.floor, 'it stops at a floor rather than sliding to nothing', `${f.target} kbps`);
    log(f.floor >= Math.round(CEILING * FIT_FLOOR_FRACTION) && f.floor < CEILING,
      'and the floor is a quarter of the chosen preset', `${f.floor} of ${CEILING} kbps`);
    const r = f.tick([dest(6)], t);
    log(!r.changed && r.atFloor, 'at the floor it says so instead of pretending to help');
  }

  // Up: only after a long clean spell.
  {
    const f = new RateFit(CEILING);
    let t = 0;
    for (let i = 0; i < 8; i++) { f.tick([dest(3)], t); t += 1000; }
    const low = f.target;
    let up = null;
    for (let i = 0; i < 30; i++) { const r = f.tick([dest(0.05)], t); if (r.changed) { up = r; break; } t += 1000; }
    log(!up, 'thirty clean seconds are NOT enough to put the picture back up', `still ${f.target} kbps`);
    for (let i = 0; i < 120 && !up; i++) { const r = f.tick([dest(0.05)], t); if (r.changed) up = r; t += 1000; }
    log(!!up && up.direction === 'up', 'a long clean spell does raise it', up && `${up.from} → ${up.target} kbps`);
    log(!!up && up.target > low && up.target <= CEILING, 'and never above the preset the operator chose',
      up && `${up.target} of ${CEILING} kbps`);
  }

  // A rise that was premature costs the next attempt twice the wait. Same
  // reasoning as the shed dwell: one settled state beats six tidy recoveries.
  {
    const f = new RateFit(CEILING);
    let t = 0;
    for (let i = 0; i < 8; i++) { f.tick([dest(3)], t); t += 1000; }
    const wait0 = f.upWaitMs();
    for (let i = 0; i < 400; i++) { const r = f.tick([dest(0.05)], t); t += 1000; if (r.changed) break; }
    // …and the line immediately proves it could not carry that
    t += 1000;
    for (let i = 0; i < 20; i++) { const r = f.tick([dest(4)], t); t += 1000; if (r.changed) break; }
    log(f.upWaitMs() >= wait0 * 2, 'a rise the line rejects doubles the wait before the next one',
      `${Math.round(wait0 / 1000)}s → ${Math.round(f.upWaitMs() / 1000)}s`);
    log(FIT_PROBE_FAIL_MS > 0 && FIT_UP_AFTER_MS >= 30000, 'the first climb is measured in tens of seconds, not seconds',
      `${Math.round(FIT_UP_AFTER_MS / 1000)}s`);
  }

  // A destination that is being RE-ENCODED to its own quality is short of CPU,
  // not of upload. Lowering the shared rate would take the picture off every
  // other platform to fix something it is not.
  {
    const f = new RateFit(CEILING);
    let t = 0;
    for (let i = 0; i < 20; i++) { f.tick([dest(8, true, false)], t); t += 1000; }
    log(f.target === CEILING, 'a destination doing its OWN encode never drags the shared picture down', `${f.target} kbps`);
  }

  // And the sound is never part of this.
  {
    const f = new RateFit(CEILING);
    log(typeof f.target === 'number' && !('audioKbps' in f), 'only the picture is ever lowered — the sound is the sermon');
  }

  log(FIT_DOWN_HOLD_MS <= 4000, 'congestion is answered in seconds, not minutes', `${FIT_DOWN_HOLD_MS} ms`);
}

/* ============================================================================
 * The rest of the harness: one real destination, wired exactly as main.js does.
 * ==========================================================================*/
const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const bandwidth = [];
const rateEvents = [];
const acks = [];
let savedSettings = { autoFitBitrate: 'auto' };

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    if (type === 'bandwidth') bandwidth.push({ id, ...payload });
    try { if (!sender.isDestroyed()) sender.send('live:' + type, { destId: id, ...payload }); } catch (e) {}
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'bitrate') {
      rateEvents.push(payload || {});
      try { if (!sender.isDestroyed()) sender.send('program:bitrate', payload || {}); } catch (e) {}
    } else if (type === 'restart-needed') {
      try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (e) {}
    }
  };
}

ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, present: {}, ...savedSettings }));
ipcMain.handle('settings:update', (e, patch) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('live:destinations', () => ok({
  destinations: DESTINATIONS, qualities: QUALITIES, qualityGroups: QUALITY_GROUPS,
  legacyQuality: LEGACY_QUALITY, defaultQuality: DEFAULT_QUALITY,
  audioQualities: AUDIO_QUALITIES, defaultAudioQuality: DEFAULT_AUDIO_QUALITY,
}));
ipcMain.handle('program:session', wrap(async (e, a) => {
  wireHub(e.sender);
  return { ...(await hub.session(ctx, { ...a, encoder: 'auto', autoFit: savedSettings.autoFitBitrate !== 'off' })), sid: a.sid };
}));
ipcMain.handle('live:start', wrap(async (e, { destId, dest: d, key, customUrl, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES[QUALITY];
  wireHub(e.sender);
  const r = hub.addOutput(ctx, destId, { kind: 'rtmp', url: buildUrl({ dest: d, key, customUrl }), q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));
ipcMain.handle('live:stop', wrap(async (e, { destId }) => { await (destId ? hub.removeOutput(destId) : hub.stop()); return true; }));
ipcMain.handle('live:state', wrap((e, { destId }) => hub.outputState(destId)));
ipcMain.handle('live:engine', wrap(async () => ({ label: encoderLabel(await detectEncoder(FF, 'auto')), preference: 'auto', gpu: true })));
ipcMain.on('live:chunk', (e, p) => { try { hub.write(p && p.sid, Buffer.from(p && p.buf ? p.buf : p)); } catch (er) {} });
ipcMain.on('live:bitrateApplied', (e, p) => { acks.push(p || {}); try { hub.rateApplied((p && p.videoKbps) || 0, !!(p && p.ok)); } catch (er) {} });
// Anything else the studio asks for on the way up.
for (const ch of ['video:presets', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list',
  'captions:fonts', 'captions:available', 'library:list', 'youtube:status', 'bible:catalogue',
  'bible:installed', 'dmx:state', 'webout:state', 'ndiout:state', 'present:library']) {
  ipcMain.handle(ch, () => ok(ch === 'present:library' ? { presentations: [], playlists: [], themes: [] } : []));
}

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

/** Every video packet the destination actually received. */
async function videoPackets(file) {
  const r = await run(FP, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'packet=pts_time,flags,size', '-of', 'compact=p=0', file]);
  return r.out.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const f = {};
    for (const part of line.split('|')) { const i = part.indexOf('='); if (i > 0) f[part.slice(0, i)] = part.slice(i + 1); }
    return { pts: parseFloat(f.pts_time), key: /K/.test(f.flags || ''), size: parseInt(f.size, 10) || 0 };
  }).filter((p) => isFinite(p.pts));
}

/** kbps and fps of the picture between two moments of the received stream. */
function rateWindow(pk, from, to) {
  const seg = pk.filter((p) => p.pts >= from && p.pts < to);
  const span = to - from;
  const bytes = seg.reduce((s, p) => s + p.size, 0);
  return { kbps: span > 0 ? (bytes * 8) / 1000 / span : 0, fps: span > 0 ? seg.length / span : 0, n: seg.length };
}

app.whenReady().then(async () => {
  console.log('== AUTO-FIT: the picture follows the line ==');
  console.log(`   machine: ${os.cpus().length} logical cores, ${os.cpus()[0].model.trim()}`);
  console.log(`   program encoder: ${encoderLabel(await detectEncoder(FF, 'auto'))}`);

  decisionChecks();

  console.log(`\n[2] A real broadcast at ${QUALITY}, pushed to a real RTMP ingest`);
  const port = await freePort();
  const receiver = spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '180',
    '-i', `rtmp://127.0.0.1:${port}/live/app1`, '-c', 'copy', '-f', 'flv', outFlv], { windowsHide: true });
  let recErr = '';
  receiver.stderr.on('data', (d) => { recErr += d.toString(); });
  await sleep(1500);

  const win = new BrowserWindow({
    show: true, width: 1400, height: 880,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  const started = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    const p = T.addAvPulse('Pulse');
    T.setPreview(p.id); T.cut();
    T.setLiveCfg({ quality: ${JSON.stringify(QUALITY)} });
    T.setStreamSlot(1, { dest:'custom', key:'app1', customUrl:'rtmp://127.0.0.1:${port}/live', quality:${JSON.stringify(QUALITY)} });
    await new Promise(r => setTimeout(r, 500));
    T.startAllStreams();
    for (let i = 0; i < 80 && !T.state().streams[0].streaming; i++) await new Promise(r => setTimeout(r, 250));
    return { streaming: T.state().streams[0].streaming, size: T.pgmSize(), fit: T.fitState() };`);
  if (started.__error) console.error('[2] ' + started.__error);
  log(!!started.streaming, 'the destination is live');
  log(started.fit && started.fit.on === true, 'auto-fit is armed for this broadcast (the capture owns the encoder)',
    started.fit ? JSON.stringify(started.fit) : 'no fit state');
  /*
   * It starts at the PLATFORM's rate for the picture being sent, with the
   * operator's preset as the floor — see platformKbps. The preset chooses how
   * big the picture is; what that size costs on YouTube is not a number a vMix
   * preset list can know, and sending less than it is the whole of the
   * "your bitrate is lower than the recommended bitrate" warning.
   */
  const START = platformKbps(CEILING, { width: 1280, height: 720, fps: 30 });
  log(hub.currentKbps() === START,
    'and it starts at the platform\'s rate for this picture, never below the preset',
    `${hub.currentKbps()} kbps (preset ${CEILING}, platform wants ${START})`);

  console.log(`    holding ${BEFORE_S}s at the full rate…`);
  await sleep(BEFORE_S * 1000);
  const limitsFull = hub._limits();

  /* ---- the line fills up, for real as far as everything downstream knows ----
   *
   * The one thing that cannot be produced to order on a test machine is a
   * congested church broadband line, so the destination's own backlog — the
   * number the hub reads, and the honest measure of an upload that cannot keep
   * up — is held high. EVERYTHING else from here is the shipping code: the
   * hub's own one-second timer, RateFit's decision, the IPC to the renderer,
   * the encoder reconfigure, the ack, and the bytes on the wire.
   */
  console.log('\n[3] The upload backs up — what the app does about it');
  const o = [...hub.outputs.values()].find((x) => x.kind === 'rtmp');
  log(!!(o && o.proc), 'the destination has a live ffmpeg to back up behind', o ? o.id : 'none');
  const changedAt = Date.now();
  // TWO SECONDS behind, deliberately: that is a line which cannot quite carry
  // the stream, and it is BELOW the point where picture starts being thrown
  // away. If auto-fit is worth having, it acts here — before the congregation
  // has seen anything at all.
  const bytesPerSec = ((CEILING + 128) * 1000) / 8;
  Object.defineProperty(o.proc.stdin, 'writableLength', { get: () => Math.round(bytesPerSec * 2), configurable: true });
  await sleep(13000);
  delete o.proc.stdin.writableLength;   // …the line recovers; back to the real number

  log(rateEvents.length > 0, 'the hub noticed and asked for a lower rate by itself',
    rateEvents.length ? `${rateEvents.length} change(s), down to ${rateEvents[rateEvents.length - 1].videoKbps} kbps` : 'nothing happened');
  const last = rateEvents[rateEvents.length - 1] || {};
  /*
   * MEASURED AGAINST WHAT IT WAS SENDING, not against the preset — and the
   * distinction is the point of the floor.
   *
   * This used to assert the rate fell below the operator's preset (2500). It
   * cannot any more, and must not: the platform charges 2800 for this picture,
   * which is ABOVE that preset, and a stream under the platform's number is
   * reported as faulty for as long as it lasts. Auto-fit now softens the picture
   * as far as that number and stops there. What it is really being asked here —
   * "did the app give the line relief by itself?" — is answered against the rate
   * it was actually sending.
   */
  const recHere = require('../src/main/streamrate').recommendedKbps(1280, 720, 30);
  log(last.videoKbps && last.videoKbps < START, 'the rate really came down', `${START} → ${last.videoKbps} kbps`);
  log(last.videoKbps >= recHere,
    'and stopped at what the platform charges rather than going under it',
    `${last.videoKbps} kbps, platform wants ${recHere} (preset was ${CEILING})`);
  log(acks.length > 0 && acks.every((a) => a.ok), 'and the capture ACCEPTED it — the encoder was re-rated in place',
    JSON.stringify(acks));
  log(hub.currentKbps() === last.videoKbps && hub.fitting, 'the hub knows what it is now sending',
    `${hub.currentKbps()} kbps (preset ${CEILING})`);
  const limitsLow = hub._limits();
  log(limitsLow.shed < limitsFull.shed, 'and judges "is this destination behind?" against the new rate, not the old one',
    `${Math.round(limitsFull.shed / 1024)} KB → ${Math.round(limitsLow.shed / 1024)} KB`);

  const ui = await js(win, `const T = window.LiveStudio.__test; return { banner: T.fitBannerText(), fit: T.fitState() };`);
  log(!!(ui.banner && /lowered/i.test(ui.banner)), 'the operator is TOLD, on screen, that the picture was lowered',
    ui.banner ? ui.banner.slice(0, 110) : 'no banner');
  log(!!(ui.banner && /sound/i.test(ui.banner)), 'and told that the sound is untouched');
  log(!!(ui.fit && ui.fit.kbps === last.videoKbps), 'and the number on screen is the number being sent',
    ui.fit ? `${ui.fit.kbps} kbps` : 'none');

  console.log(`    holding ${AFTER_S}s at the reduced rate…`);
  await sleep(AFTER_S * 1000);
  const rateEventsAtEnd = rateEvents.length;

  await js(win, `window.LiveStudio.__test.stopAllStreams(); return true;`);
  await sleep(2500);
  try { receiver.kill('SIGINT'); } catch (e) {}
  await sleep(2500);

  /* ---- what the platform received ---- */
  console.log('\n[4] What the platform actually received');
  const exists = fs.existsSync(outFlv) && fs.statSync(outFlv).size > 100000;
  log(exists, 'the destination received the broadcast', exists ? `${Math.round(fs.statSync(outFlv).size / 1024)} KB` : recErr.slice(-200));
  if (exists) {
    const pk = await videoPackets(outFlv);
    const end = pk.length ? pk[pk.length - 1].pts : 0;
    // The change happened BEFORE_S into the broadcast; the received timeline
    // starts a beat later, so both windows are taken well clear of it.
    const before = rateWindow(pk, 3, BEFORE_S - 1);
    const after = rateWindow(pk, BEFORE_S + 11, Math.max(BEFORE_S + 12, end - 1));
    const cut = before.kbps > 0 ? (1 - after.kbps / before.kbps) * 100 : 0;
    console.log(`    before: ${before.kbps.toFixed(0)} kbps at ${before.fps.toFixed(1)} fps`);
    console.log(`    after:  ${after.kbps.toFixed(0)} kbps at ${after.fps.toFixed(1)} fps  (${cut.toFixed(0)}% less on the wire)`);
    log(after.n > 30 && before.n > 30, 'both halves of the broadcast were received', `${before.n} / ${after.n} frames`);
    /*
     * The size of the cut is bounded by the floor now: from 2968 to the
     * platform's 2800 is all the relief there is to give before the picture
     * would start being reported as under-rated, so the old ">= 20% smaller"
     * measured a behaviour that has deliberately been replaced. What still has
     * to be true is that the change reached the wire at all.
     */
    log(cut > 2, 'THE STREAM ON THE WIRE REALLY GOT SMALLER — this is the fix, measured',
      `${before.kbps.toFixed(0)} → ${after.kbps.toFixed(0)} kbps`);

    /* The point of the whole exercise. Shedding makes a stream smaller too —
     * by deleting the picture. If auto-fit did that it would be no better. */
    log(after.fps >= before.fps * 0.85, 'and the PICTURE KEPT RUNNING — the frame rate survived the change',
      `${before.fps.toFixed(1)} → ${after.fps.toFixed(1)} fps`);
    const gaps = [];
    for (let i = 1; i < pk.length; i++) gaps.push(pk[i].pts - pk[i - 1].pts);
    const worst = gaps.length ? Math.max(...gaps) : 0;
    log(worst < 1.0, 'the picture never stopped, not even for a moment, while the rate changed',
      `worst gap ${(worst * 1000).toFixed(0)} ms`);
    const keys = pk.filter((p) => p.key).map((p) => p.pts);
    const kg = []; for (let i = 1; i < keys.length; i++) kg.push(keys[i] - keys[i - 1]);
    log(kg.length > 2 && Math.max(...kg) <= 4.0, 'and keyframes stayed inside the 4s every platform requires',
      kg.length ? `worst ${Math.max(...kg).toFixed(2)}s` : 'too few');

    const ar = await run(FP, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
      'stream=codec_name,sample_rate,bit_rate', '-of', 'csv=p=0', outFlv]);
    console.log(`    sound: ${ar.out.trim()}`);
    log(/aac/.test(ar.out), 'the sound is still AAC and was never touched by any of this');
  }

  console.log('\n[5] It settles instead of flapping');
  log(rateEventsAtEnd === rateEvents.length,
    'once the line recovered, nothing kept changing the rate up and down',
    `${rateEvents.length} changes in the whole broadcast`);
  /*
   * THE RULE CHANGED HERE, DELIBERATELY, AND THIS IS THE PROPERTY THAT REPLACED IT.
   *
   * It used to be "no upward move at all for 45 seconds", which is what left a
   * service that dipped once in the first hymn still under-rated at the
   * benediction — the operator's actual complaint, seen as YouTube's yellow
   * banner for a whole service. A stream sitting BELOW what the platform
   * charges for the picture it is sending is not merely softer, it is being
   * reported as faulty, so it now climbs back quickly — but only ever AS FAR AS
   * that price, never a step into the rate that just failed, and with its own
   * backoff if the line refuses it again. That is what "did not climb back into
   * the rate that had just failed" was really protecting, and it still holds.
   */
  const ups = rateEvents.filter((r) => r.direction === 'up');
  const failedAt = Math.max(...rateEvents.filter((r) => r.direction === 'down').map((r) => r.from || 0), 0);
  log(ups.every((r) => r.videoKbps < failedAt),
    'and it did not climb back into the rate that had just failed',
    ups.length ? `climbed to ${ups.map((r) => r.videoKbps).join(', ')} kbps; ${failedAt} is what failed` : 'no climb at all');
  log(bandwidth.length === 0,
    'NOTHING WAS EVER SHED — the rate came down before the picture had to be thrown away',
    bandwidth.length ? JSON.stringify(bandwidth[0]).slice(0, 160) : 'clean');

  await hub.stop();
  await sleep(500);
  console.log('\n============  VERDICT  ============');
  console.log(failed
    ? '   Something above is wrong — read the FAILs.'
    : '   A destination that cannot carry the chosen quality is now sent a SMALLER stream,\n'
      + '   not a broken one: the bitrate came down by itself, the picture kept running through\n'
      + '   the change, the sound was never touched, and the operator was told on screen.');
  console.log('   files: ' + tmp);
  try { win.destroy(); } catch (e) {}
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
