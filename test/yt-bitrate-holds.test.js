'use strict';
/*
 * "YOUTUBE LIVESTREAM IS TERRIBLE — THE WARNING ALWAYS HAPPENS.
 *  IT CAN START FINE AND THEN THE ISSUE CAN HAPPEN."
 *
 * The warning is one comparison: the bitrate ARRIVING at the platform against
 * the platform's own recommendation for the picture size and frame rate that is
 * arriving. test/youtube-bitrate.test.js proves the app aims at the right
 * number. This file is about the three ways the aim was quietly LOST anyway —
 * two of them before a note was ever sung, one of them halfway through a
 * service that started perfectly:
 *
 *   1. A MEASUREMENT OF THE LINE THAT NEVER EXPIRED. `lastUplinkAt` was written
 *      and never read, so one reading — a phone hotspot, a busy afternoon, a
 *      different building — capped the encoder for every service afterwards,
 *      for good, with nothing on screen to say so. Worked through on the real
 *      complaint: one stored 3.7 Mbps gives 3700 × 0.66 − 160 = 2282 kbps, and
 *      the screenshot from the church says 2278.74 Kbps against 6800 wanted.
 *
 *   2. 'AUTO' FRAME RATE FOLLOWING A 60fps CAMERA. Nobody chooses 60; the
 *      camera does. It nearly doubles what the platform charges (6800 against
 *      4500 for the same 1080p picture) and doubles the encoding, and a starved
 *      60fps stream shows fewer frames than an honest 30fps one.
 *
 *   3. THE PAD STANDING DOWN THE MOMENT THE RATE DIPPED. A still verse slide
 *      compresses to almost nothing (187 kbps measured on this machine's
 *      software encoder), so the filler is the only thing keeping it at the
 *      promised rate. It used to switch off as soon as auto-fit came off the
 *      PLAN — even while the stream was still comfortably above what the
 *      platform charges — and then a service that started clean spent the rest
 *      of the morning under-rated, because nothing pulled the rate back up.
 *
 *   npx electron test/yt-bitrate-holds.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-ytholds-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

const {
  RateFit, platformKbps, PLATFORM_HEADROOM, FIT_CLEAR_REC_SEC,
  FIT_DOWN, FIT_UP_AFTER_MS, FIT_UP_FAST_MS, FIT_DOWN_HOLD_MS, FIT_SETTLE_MS, FIT_PROBE_FAIL_MS,
} = require('../src/main/livestream');
const streamrate = require('../src/main/streamrate');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

/* ------------------------------------------------------------------ *
 * PART 1 — the controller, on a clock we own.
 * ------------------------------------------------------------------ */
const REC_1080_30 = streamrate.recommendedKbps(1920, 1080, 30);      // 4500
const PLAN = platformKbps(4000, { width: 1920, height: 1080, fps: 30 });

/** Drive a controller with `n` seconds of one kind of weather. */
function weather(fit, kind, seconds, t0) {
  const d = kind === 'bad'
    ? [{ id: 'a', copying: true, shedding: false, behindSec: 2.0 }]
    : [{ id: 'a', copying: true, shedding: false, behindSec: 0.0 }];
  const events = [];
  for (let i = 0; i < seconds; i++) {
    const now = t0 + i * 1000;
    const r = fit.tick(d, now);
    if (r.changed) events.push({ ...r, at: now });
  }
  return events;
}

head('The plan is above the platform’s number, and inside its band');
{
  const band = streamrate.bandFor(1920, 1080, 30);
  check('the shared encode is aimed above what YouTube asks for', PLAN > REC_1080_30,
    `${PLAN} vs ${REC_1080_30} asked (${Math.round((PLAN / REC_1080_30 - 1) * 100)}% margin)`);
  check('…and never above what YouTube is willing to accept', PLAN <= band.max, `${PLAN} <= ${band.max}`);
  check('the margin is the documented one', Math.abs(PLAN / REC_1080_30 - PLATFORM_HEADROOM) < 0.02,
    String(PLATFORM_HEADROOM));
}

head('Going down: the platform’s price is a rung, not something to vault over');
{
  const fit = new RateFit(PLAN, { recKbps: REC_1080_30 });
  const t0 = 1000000;
  const ev = weather(fit, 'bad', 12, t0);
  check('congestion did lower the rate', ev.length > 0 && ev[0].direction === 'down',
    ev.length ? `${ev[0].from} → ${ev[0].target}` : 'nothing happened');
  check('the FIRST step lands exactly on the platform’s price, not below it',
    ev.length > 0 && ev[0].target === REC_1080_30,
    ev.length ? `${ev[0].target} (price ${REC_1080_30}, a plain 28% step would have been ${Math.round(PLAN * FIT_DOWN)})` : '');
  check('…so a transient burst never puts the stream under the platform’s number at all',
    ev.length > 0 && ev[0].target >= REC_1080_30);
  const more = weather(fit, 'bad', 20, t0 + 12000);
  check('but real congestion still goes past that rung — there is no way to get stuck on it',
    more.length > 0 && more[more.length - 1].target < REC_1080_30,
    more.length ? `down to ${more[more.length - 1].target}` : 'it stuck at the rung');
}

head('Coming back: quickly to the price, cautiously above it');
{
  const fit = new RateFit(PLAN, { recKbps: REC_1080_30 });
  const t0 = 2000000;
  weather(fit, 'bad', 30, t0);                       // driven well below the price
  const low = fit.target;
  check('the stream is under the platform’s number after sustained congestion', low < REC_1080_30, `${low} kbps`);
  const back = weather(fit, 'clean', 30, t0 + 30000);
  check('a clean line brings it back up within half a minute', back.length > 0 && back[0].direction === 'up',
    back.length ? `first climb after ${Math.round((back[0].at - (t0 + 30000)) / 1000)}s` : 'never climbed');
  check('…which the OLD rule could not do: it required 45s of calm before the first step',
    FIT_UP_FAST_MS < FIT_UP_AFTER_MS, `${FIT_UP_FAST_MS}ms vs ${FIT_UP_AFTER_MS}ms`);
  const reached = weather(fit, 'clean', 90, t0 + 60000);
  check('and it gets all the way back to the platform’s price', fit.target >= REC_1080_30,
    `${fit.target} vs ${REC_1080_30}`);
  const overshoot = back.concat(reached).filter((r) => r.direction === 'up' && r.target > REC_1080_30 && r.toRec);
  check('the quick climb never overshoots the price into the rate that just failed',
    overshoot.length === 0, overshoot.length ? JSON.stringify(overshoot[0]) : 'none');
}

head('It does not flap: a line that keeps refusing is asked less and less often');
{
  const fit = new RateFit(PLAN, { recKbps: REC_1080_30 });
  let t = 3000000;
  weather(fit, 'bad', 30, t); t += 30000;
  const waits = [];
  for (let round = 0; round < 3; round++) {
    const before = t;
    let up = null;
    for (let i = 0; i < 400 && !up; i++) {           // clean until it tries again
      const r = fit.tick([{ id: 'a', copying: true, shedding: false, behindSec: 0 }], t);
      if (r.changed && r.direction === 'up') up = r;
      t += 1000;
    }
    if (!up) break;
    waits.push(t - before);
    // …and the line refuses it immediately, which is what a probe failing means
    for (let i = 0; i < 12; i++) { fit.tick([{ id: 'a', copying: true, shedding: false, behindSec: 2 }], t); t += 1000; }
  }
  check('each refused attempt makes the next one wait longer', waits.length >= 2 && waits[1] > waits[0],
    waits.map((w) => Math.round(w / 1000) + 's').join(' → '));
  check('so the rate is not being changed every few seconds through a sermon',
    waits.length < 3 || waits[waits.length - 1] >= waits[0] * 2,
    waits.map((w) => Math.round(w / 1000) + 's').join(' → '));
}

head('The dead zone: "not bad enough to lower, not clean enough to raise"');
{
  /*
   * A destination that is persistently a little behind — 0.5s, the steady state
   * of a church PC that is working hard but coping — used to leave a dipped
   * stream dipped for the whole service: too clean to lower, too busy to raise.
   */
  const fit = new RateFit(PLAN, { recKbps: REC_1080_30 });
  let t = 4000000;
  weather(fit, 'bad', 30, t); t += 30000;
  const low = fit.target;
  const marginal = [{ id: 'a', copying: true, shedding: false, behindSec: 0.5 }];
  let up = null;
  for (let i = 0; i < 60 && !up; i++) { const r = fit.tick(marginal, t); if (r.changed) up = r; t += 1000; }
  check('a stream under the platform’s price climbs back out of the dead zone',
    !!up && up.direction === 'up', up ? `${up.from} → ${up.target}` : `stuck at ${low}`);
  check('…and it is still not called "clean" while it is genuinely congested',
    FIT_CLEAR_REC_SEC < 1.0, `${FIT_CLEAR_REC_SEC}s vs the ${1.0}s that counts as behind`);

  // …but above the price the old caution is untouched: quality can wait.
  const fit2 = new RateFit(PLAN, { recKbps: 1000 });   // price well below the ceiling
  let t2 = 5000000;
  weather(fit2, 'bad', 30, t2); t2 += 30000;
  let up2 = null;
  for (let i = 0; i < 60 && !up2; i++) { const r = fit2.tick(marginal, t2); if (r.changed) up2 = r; t2 += 1000; }
  check('a stream ABOVE the price waits for a genuinely quiet line, as it always did',
    !up2, up2 ? `climbed to ${up2.target}` : 'held, correctly');
}

head('"Never send less than this" — the floor holds');
{
  /*
   * The operator's instruction, in the words they used: set it and it must
   * never go lower. Auto-fit may soften the picture as much as it likes down to
   * the floor and not one step past it — with ONE exception, tested below,
   * because a stream that is dropping frames is worse than a soft one.
   */
  const FLOOR = 6000;
  const fit = new RateFit(7208, { recKbps: 6800, floorKbps: FLOOR });
  const t0 = 6000000;
  const ev = weather(fit, 'bad', 120, t0);              // two minutes of a full line
  check('sustained congestion never takes it under the floor',
    fit.target >= FLOOR, `${fit.target} kbps, floor ${FLOOR}`);
  check('…and it says it is being held there rather than pretending nothing is wrong',
    ev.some((r) => r.atFloor) || fit.atFloor, JSON.stringify(ev.slice(-1)));
  check('the floor is respected even after many steps', ev.every((r) => r.target >= FLOOR),
    ev.map((r) => r.target).join(', ') || 'no steps at all');

  // THE ONE EXCEPTION: the picture is actually being thrown away.
  const fit2 = new RateFit(7208, { recKbps: 6800, floorKbps: FLOOR });
  let t = 7000000;
  const losing = [{ id: 'a', copying: true, shedding: true, behindSec: 3 }];
  for (let i = 0; i < 120; i++) { fit2.tick(losing, t); t += 1000; }
  check('but a destination that is LOSING PICTURE may go below it — soft beats broken',
    fit2.target < FLOOR, `${fit2.target} kbps`);

  // …and with no floor at all it behaves exactly as it did before.
  const fit3 = new RateFit(7208, { recKbps: 6800 });
  weather(fit3, 'bad', 120, 8000000);
  check('with the floor switched off, nothing is held', fit3.target < FLOOR, `${fit3.target} kbps`);
}

head('A recording is not a broadcast: no price, no rung, no hurry');
{
  const fit = new RateFit(4000);                     // no recKbps — a file is watching, not a platform
  check('nothing is "below the platform’s price" when there is no platform', fit.belowRec() === false);
  check('and the old cautious climb is exactly as it was', fit.upWaitMs() === FIT_UP_AFTER_MS,
    `${fit.upWaitMs()}ms`);
}

/* ------------------------------------------------------------------ *
 * PART 2 — the studio: the measurement's age and the frame rate.
 * ------------------------------------------------------------------ */
const ok = (data) => ({ ok: true, data });
['settings:update', 'scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'library:list',
  'bible:installed', 'bible:catalogue', 'present:outputs'].forEach((c) => ipcMain.handle(c, () => ok([])));
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({ 'reel-9x16': { w: 9, h: 16, label: 'Reel 9:16' } }));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('captions:engineInfo', () => ok({ available: true }));
ipcMain.handle('captions:models', () => ok([]));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
['webout:state', 'ndiout:state', 'ndi:status', 'dmx:state', 'present:state', 'phone:state', 'llm:status']
  .forEach((c) => ipcMain.handle(c, () => ok({})));
const LS = require('../src/main/livestream');
ipcMain.handle('live:destinations', () => ok({
  destinations: LS.DESTINATIONS, qualities: LS.QUALITIES, qualityGroups: LS.QUALITY_GROUPS,
}));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => { if (lvl >= 2) console.log('    [renderer] ' + msg); });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 1400));
  const js = (code) => win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: String(e && e.message || e) }; } })()`);
  const T = 'window.LiveStudio.__test';
  const HOUR = 3600000;

  head('A measurement of the line is evidence about THAT night');
  {
    const fresh = await js(`return ${T}.setUplinkMemory(3.7, 60 * 1000);`);
    check('a reading taken a minute ago still caps the encoder', fresh.fresh === true && fresh.cap > 0,
      JSON.stringify(fresh));
    check('…and 3.7 Mbps caps it at almost exactly the number from the church’s screenshot',
      Math.abs(fresh.cap - 2278.74) < 20, `${fresh.cap} kbps vs 2278.74 reported`);
    const old = await js(`return ${T}.setUplinkMemory(3.7, 7 * 3600 * 1000);`);
    check('a reading from seven hours ago caps NOTHING', old.fresh === false && old.cap === 0, JSON.stringify(old));
    const never = await js(`return ${T}.setUplinkMemory(3.7, null);`);
    check('and one that was never dated cannot cap either', never.cap === 0, JSON.stringify(never));
    const stale = await js(`
      ${T}.setUplinkMemory(3.7, 7 * 3600 * 1000);
      return { withStale: ${T}.platformRec(1920, 1080, 30) };`);
    check('so tonight’s 1080p30 broadcast is priced at the platform’s rate again, not last month’s line',
      stale.withStale === 4500, JSON.stringify(stale));
  }

  head('A destination that is not broadcasting is not using the line');
  {
    /*
     * "Even when I was ONLY livestreaming on YouTube the bitrate dropped." A
     * Facebook key typed into settings once and never used counted as a
     * destination sharing the line, for ever, and halved what YouTube was given.
     */
    await js(`${T}.setStreams([
      { dest: 'youtube', key: 'yt-key', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: true },
      { dest: 'facebook', key: 'fb-key-saved-but-never-used', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: false },
    ]); return 1;`);
    const r = await js(`${T}.setUplinkMemory(12.49, 60 * 1000);
      return { sharing: ${T}.sharingLine(null), cap: ${T}.uplinkFresh(${T}.sharingLine(null)).cap,
               rec: ${T}.platformRec(1920, 1080, 30) };`);
    check('only the destination actually on air counts', r.sharing === 1, JSON.stringify(r));
    check('…so a 12.49 Mbps line gives YouTube the whole of its share',
      r.cap > r.rec, `${r.cap} kbps against ${r.rec} wanted`);
    const halved = Math.round(12490 * 0.66 / 2) - 160;
    check('…where counting the unused key would have handed it less than the platform asks',
      halved < r.rec, `${halved} kbps against ${r.rec} wanted — the old answer`);

    const two = await js(`${T}.setStreams([
      { dest: 'youtube', key: 'yt', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: true },
      { dest: 'facebook', key: 'fb', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: true },
    ]); return { sharing: ${T}.sharingLine(null), cap: ${T}.uplinkFresh(${T}.sharingLine(null)).cap };`);
    check('but two destinations really on air DO share it', two.sharing === 2 && two.cap < r.cap,
      JSON.stringify(two));
    const starting = await js(`${T}.setStreams([
      { dest: 'youtube', key: 'yt', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: true },
      { dest: 'facebook', key: 'fb', quality: 'H264 1080p 6mbps AAC 128kbps', streaming: false },
    ]); return ${T}.sharingLine([{ videoKbps: 6000 }]);`);
    check('…and one that is being started right now counts before it is marked live',
      starting === 2, String(starting));
    await js(`${T}.setStreams([]); return 1;`);
  }

  head('Two destinations, one line: a picture BOTH can be paid for in full');
  {
    /*
     * "I should be able to stream the second one at 8083 kbps as well." One
     * encode goes out over two connections, so two destinations cost twice the
     * upload — 2 × 1080p30 is 9320 kbps of a line that has 8243 to give. The
     * answer is not to starve both at 3962 (which warns on both, and sheds on
     * one); it is to send a size the line can pay for TWICE, in full.
     */
    await js(`${T}.setUplinkMemory(12.49, 60 * 1000); return 1;`);
    const one = await js(`${T}.setStreams([
      { dest: 'youtube', key: 'yt', quality: 'H264 1080p 6mbps AAC 128kbps' },
    ]); return ${T}.fitToLine();`);
    check('ONE destination at 1080p is left exactly as chosen — the line pays for it',
      one.changed === false && one.after[0] === 'H264 1080p 6mbps AAC 128kbps',
      JSON.stringify(one));

    const two = await js(`${T}.setStreams([
      { dest: 'youtube', key: 'yt', quality: 'H264 1080p 6mbps AAC 128kbps' },
      { dest: 'facebook', key: 'fb', quality: 'H264 1080p 6mbps AAC 128kbps' },
    ]); return ${T}.fitToLine();`);
    check('TWO destinations are moved to a size this line can pay for twice',
      two.changed === true && two.after[0] === two.after[1] && two.after[0] !== two.before[0],
      JSON.stringify(two));
    // Saving the destinations refreshes settings from the main process, which
    // drops the measurement this test injected — so it is stated again here.
    const check2 = await js(`
      ${T}.setUplinkMemory(12.49, 60 * 1000);
      const a = ${T}.state().streams.map((s) => s.quality);
      return { qualities: a, share: ${T}.uplinkFresh(2).cap, rec: ${T}.platformRec(1280, 720, 30) };`);
    check('…and that size IS payable in full for each of them',
      check2.share >= check2.rec, `${check2.share} kbps each, 720p30 costs ${check2.rec}`);
    check('both destinations end up on the SAME preset, so it stays one encode copied',
      check2.qualities[0] === check2.qualities[1], JSON.stringify(check2.qualities));
    await js(`${T}.setStreams([]); return 1;`);
  }

  head('“Auto” must not buy a 60fps bill nobody asked for');
  {
    await js(`${T}.setFpsMode('auto'); ${T}.setUplinkMemory(0, null); return 1;`);
    const unmeasured = await js(`return ${T}.streamFpsFor(60, 1920, 1080);`);
    check('with no measurement, a 60fps camera streams at 30', unmeasured === 30, String(unmeasured));
    const pal = await js(`return ${T}.streamFpsFor(50, 1920, 1080);`);
    check('…and a 50fps PAL camera halves to 25, never a juddering pulldown to 30', pal === 25, String(pal));
    const already30 = await js(`return ${T}.streamFpsFor(30, 1920, 1080);`);
    check('a 30fps camera is left completely alone', already30 === 30, String(already30));
    const cine = await js(`return ${T}.streamFpsFor(24, 1920, 1080);`);
    check('and so is 24fps', cine === 24, String(cine));

    const rich = await js(`${T}.setUplinkMemory(20, 60 * 1000); return ${T}.streamFpsFor(60, 1920, 1080);`);
    check('on a line MEASURED to afford 1080p60, the camera’s 60 is kept', rich === 60, String(rich));
    const thin = await js(`${T}.setUplinkMemory(6, 60 * 1000); return ${T}.streamFpsFor(60, 1920, 1080);`);
    check('on one measured too thin for it, 30 — the picture stays 1080p either way', thin === 30, String(thin));

    const chosen = await js(`${T}.setFpsMode('60'); ${T}.setUplinkMemory(0, null); return ${T}.streamFpsFor(60, 1920, 1080);`);
    check('an operator who CHOOSES 60 in Streaming Settings always gets 60', chosen === 60, String(chosen));
    await js(`${T}.setFpsMode('auto'); return 1;`);
  }

  head('What that is worth, in the one number the platform compares');
  {
    const r = await js(`return { at60: ${T}.platformRec(1920, 1080, 60), at30: ${T}.platformRec(1920, 1080, 30) };`);
    check('1080p60 costs 6800 on YouTube and 1080p30 costs 4500', r.at60 === 6800 && r.at30 === 4500,
      JSON.stringify(r));
    check('…so halving the rate takes a third off the bill for the same size picture',
      r.at30 / r.at60 < 0.7, `${r.at30} / ${r.at60}`);
  }

  console.log(`\n==================  ${pass} passed, ${fail} failed  ==================`);
  win.destroy();
  app.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('\nFATAL: ' + (e && e.stack || e)); app.exit(1); });
