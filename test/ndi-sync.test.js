'use strict';
/*
 * GO LIVE — A/V SYNC AGAINST A REAL NDI SENDER.
 *
 * test/av-sync.test.js proves the maths. This proves the whole chain on a live
 * NDI stream: a real sender (video + audio) → the real receiver worker → main →
 * the renderer's audio worklet and sync controller. It measures what an operator
 * would actually get:
 *   - the sound is held for a small, KNOWN time (~60 ms), not "wherever the last
 *     burst left it", and that number does not creep upward while it runs,
 *   - the sender's own timestamps really arrive on both streams, so the gap
 *     between sound and picture is measured rather than guessed,
 *   - the correction that comes out of it is small and sensible on a local feed,
 *   - the audio keeps flowing throughout (no underrun storm from the new clock
 *     tracking).
 *
 * SKIPS (exit 0) when the NDI runtime is not installed.
 * Run: npx electron test/ndi-sync.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const ndi = require('../src/main/ndi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ndisync-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { quality: '720p30', fpsMode: '30' } };
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
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));

/* REAL NDI handlers — the SAME registration the app uses, timestamps included */
ndi.registerIpc(ipcMain, wrap);

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// The shipping app runs with GPU compositing ON (see the Go Live settings
// escape hatch). The NDI sound itself no longer passes through the renderer's
// main thread — the receiver's audio port is handed straight to the worklet —
// but the picture does, and the sync maths compares the two. Testing the
// software-rendering fallback would measure a machine nobody streams from.
// MW_NOGPU=1 exercises that fallback deliberately.
if (process.env.MW_NOGPU) app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== GO LIVE — A/V SYNC ON A REAL NDI STREAM ==');
  const status = ndi.getStatus();
  if (!status.available) {
    console.log('  SKIP  NDI runtime not installed -> ' + (status.error || ''));
    app.exit(0);
    return;
  }
  console.log('  runtime: ' + status.dll);

  const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, 'MW Sync Source'], { silent: true });
  await sleep(1500);
  let found = null;
  for (let i = 0; i < 20 && !found; i++) {
    found = ndi.getSources().find((s) => /MW Sync Source/.test(s.name));
    if (!found) await sleep(500);
  }
  check(!!found, 'the test NDI sender was discovered', found && found.name);
  if (!found) { source.kill(); app.exit(1); return; }

  const win = new BrowserWindow({ show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r)=>setTimeout(r,300)); return true;`);

  // add the source straight through the real API the dialog uses
  const id = await js(win, `
    const inp = ${T}.addNdiInput(${JSON.stringify(found)}, { audioOnly: false, lowBandwidth: false });
    return inp.id;
  `);
  check(typeof id === 'number', 'NDI input added', 'input ' + id);

  // let it run: the buffer needs to settle and the sync controller needs samples
  await sleep(5000);
  const early = await js(win, `return ${T}.syncState(${id});`);
  console.log('  after 5 s: ' + JSON.stringify(early));
  await sleep(9000);
  const later = await js(win, `return ${T}.syncState(${id});`);
  console.log('  after 14 s: ' + JSON.stringify(later));
  const target = await js(win, `return ${T}.ndiAudioTargetMs();`);

  check(later.samples.a > 5 && later.samples.v > 5,
    'the sender\'s timestamps arrive on BOTH streams (so the gap is measured, not guessed)',
    `${later.samples.a} audio / ${later.samples.v} video samples`);

  check(later.queueMs > 5 && later.queueMs < later.bufferTargetMs + 60,
    `the audio buffer holds a small, known amount of sound (starts at ${target} ms, adapts to this machine)`,
    `${later.queueMs.toFixed(1)} ms held, ${later.bufferTargetMs} ms target`);
  check(later.bufferTargetMs <= 260,
    'the cushion it settles on is still small enough to keep the stream responsive', later.bufferTargetMs + ' ms');
  // A dry buffer is an audible dropout, so it has to be rare — and when one does
  // happen the cushion must grow in response rather than letting it repeat.
  check(later.feedRatio > 0.97 && later.feedRatio < 1.03,
    'the source really is supplying real-time audio (so this measures US, not the sender)', 'feed ratio ' + later.feedRatio);
  check(later.underrunEvents <= 4, 'the sound runs continuously — dropouts are rare', later.underrunEvents + ' in 14 s');
  // Dropouts while the connection is still settling are counted but do NOT
  // grow the cushion (see onUnderrun in ndi-audio-worklet.js): growing it for
  // a start-up hiccup left the sound 150 ms later than lip-sync was set for a
  // quarter of an hour. Any dropout after that must.
  const settledDrops = later.underrunEvents - (later.startupDropouts || 0);
  check(settledDrops === 0 || later.bufferTargetMs > target,
    'and any dropout once the feed has settled makes the cushion adapt so it stops happening',
    `${settledDrops} settled dropout(s) (+${later.startupDropouts || 0} at start-up), cushion ${target} → ${later.bufferTargetMs} ms`);

  check(later.autoMs != null, 'the difference between the sound and picture paths was measured', later.autoMs + ' ms');
  check(Math.abs(later.autoMs) < 400, 'and it is a sane number for a local sender', later.autoMs + ' ms');
  const applied = Math.max(later.audioMs, later.videoMs);
  check(applied <= 500 && (later.audioMs === 0 || later.videoMs === 0),
    'exactly one side is held back, within the safety limit',
    `audio +${Math.round(later.audioMs)} ms, video +${Math.round(later.videoMs)} ms`);
  if (later.autoMs > 20) check(later.videoMs > 0, 'sound behind picture → the picture is held back');
  else if (later.autoMs < -20) check(later.audioMs > 0, 'picture behind sound → the sound is held back');
  else check(applied === 0, 'already in step → nothing is delayed at all', `${Math.round(later.autoMs)} ms measured`);

  // the meter must still be moving: correcting sync must not cost us the audio
  const lvl = await js(win, `const s = ${T}.state(); return (s.inputs.find(i=>i.id===${id})||{}).level;`);
  check(lvl > 0.02, 'audio is still flowing through the corrected path', 'level=' + Number(lvl).toFixed(3));

  await js(win, `${T}.closeInput(${id}); return true;`);
  await sleep(600);
  source.kill();
  console.log(`\n==== NDI A/V sync: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
