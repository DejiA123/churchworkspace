'use strict';
/*
 * PRESENTATION — 🎤 LISTEN TO AN NDI FEED.
 *
 * The question this exists to answer, asked by a church running Ableton with
 * the official "NDI Output" VST on its master: does Presentation's Listen hear
 * what Go Live hears?
 *
 * It used to be flatly no. Listen opened a microphone with getUserMedia, which
 * can only reach a device Windows knows about, and in that building the
 * preaching is on the network and on no sound card at all. The feature looked
 * broken because it was pointed at the only thing it could be pointed at.
 *
 * So this drives the REAL path end to end against a REAL NDI sender: the feed
 * is discovered, it appears in the operator's own dropdown, it is chosen
 * through the same setter the dropdown uses, Listen is switched on, and the
 * assertion that matters is that SOUND ARRIVES AT THE EAR — the level the
 * endpointer sees, not merely that a receiver started. A receiver that starts
 * and delivers silence is exactly the failure being guarded against.
 *
 * The speech engine itself is stubbed: whisper has nothing to say about a test
 * tone, and what is under test here is the path from the network to the ear.
 * test/voice-listen.test.js covers the rest of the chain.
 *
 * Run: npx electron test/present-ndi-listen.test.js  (SKIPS if no NDI runtime)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const ndi = require('../src/main/ndi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-pvndi-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ---- IPC stubs (the NDI engine under test is REAL) ---- */
let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {} };
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
// The speech engine, stubbed: a 1 kHz tone has no words in it, and the path
// from the network to the ear is what this file is about.
ipcMain.handle('voice:available', () => ok({ ready: true }));
ipcMain.handle('voice:warmUp', () => ok({ resident: false, residentWhy: 'stubbed for this test' }));
ipcMain.handle('voice:translation', () => ok({ translation: null }));
ipcMain.handle('voice:transcribe', () => ok({ text: '' }));

const ndiReceivers = ndi.registerIpc(ipcMain, wrap).receivers;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const L = 'window.Presenter.__test.listen';

app.whenReady().then(async () => {
  console.log('== PRESENTATION — LISTEN TO AN NDI FEED ==');

  const status = ndi.getStatus();
  if (!status.available) {
    console.log('  SKIP  NDI runtime not installed on this machine -> ' + (status.error || ''));
    app.exit(0);
    return;
  }

  // The church's own source: audio-only, 4 channels, the programme on 3-4.
  const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, 'VST Output', 'vst'], { silent: true });
  await sleep(1500);

  let found = null;
  for (let i = 0; i < 20 && !found; i++) {
    found = ndi.getSources().find((s) => /VST Output/.test(s.name));
    if (!found) await sleep(500);
  }
  log(!!found, 'the sound desk is publishing on the network', found && found.name);

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);
  await js(win, `document.querySelector('.nav-item[data-view="present"]').click(); await new Promise((r)=>setTimeout(r,400)); return true;`);

  console.log('\n[1] The feed is offered to the operator');
  let feeds = null;
  for (let i = 0; i < 20; i++) {
    feeds = await js(win, `return await ${L}.ndiFeeds();`);
    if (feeds && feeds.names && feeds.names.some((n) => /VST Output/.test(n))) break;
    await sleep(500);
  }
  log(feeds && feeds.ok, 'NDI is usable from the Presentation studio', feeds && (feeds.why || 'runtime found'));
  log(feeds && (feeds.names || []).some((n) => /VST Output/.test(n)),
    'the sound desk appears in the list of feeds', feeds && JSON.stringify(feeds.names));

  const list = await js(win, `return await ${L}.mics(true);`);
  const opt = list && (list.options || []).find((o) => /^ndi:/.test(o.value) && /VST Output/.test(o.label));
  log(!!opt, 'and in the dropdown the operator actually uses', opt && opt.value);
  log(list && (list.options || []).some((o) => o.value === ''),
    'without displacing the ordinary microphones', list && `${list.options.length} entries`);

  console.log('\n[2] Choosing it and switching Listen on');
  const picked = await js(win, `return await ${L}.pickMic(${JSON.stringify(opt ? opt.value : '')});`);
  log(picked && picked.saved === (opt && opt.value), 'the choice sticks', picked && picked.saved);

  // Through the operator's own button, not a back door.
  const started = await js(win, `document.getElementById('pvListen').click();
    for (let i = 0; i < 40 && !${L}.on(); i++) await new Promise((r) => setTimeout(r, 250));
    return ${L}.on();`);
  log(started === true, 'Listen is running', `state: ` + await js(win, `return ${L}.state();`));

  console.log('\n[3] ►► IS THE PREACHING ACTUALLY REACHING THE EAR? ◄◄');
  let heard = null;
  for (let i = 0; i < 40; i++) {
    heard = await js(win, `return ${L}.audioIn();`);
    if (heard && heard.peak > 0.01 && heard.blocks > 3 && heard.ndiPackets > 10) break;
    await sleep(250);
  }
  log(heard && heard.ndi, 'it is listening to the network, not to a microphone');
  log(heard && heard.ndiPackets > 10, 'audio packets are arriving from the desk',
    heard && `${heard.ndiPackets} packets at ${heard.ndiRate} Hz`);
  log(heard && heard.blocks > 3, 'the ear is being fed blocks of it', heard && `${heard.blocks} blocks`);
  // The one that matters: a receiver that starts and delivers silence would
  // pass everything above and still be the bug this test exists for. The tone
  // is on channels 3-4 of a 4-channel stream, so this also proves the
  // multichannel downmix survives the trip.
  log(heard && heard.peak > 0.01, 'AND IT IS SOUND, NOT SILENCE — the ear hears the desk',
    heard && `peak ${heard.peak.toFixed(3)}`);
  // Full scale is 1.0. A reading far above it means the bytes were CONVERTED to
  // floats rather than reinterpreted as them — which measured peak 132 and is
  // not sound, it is the raw bytes read as numbers.
  log(heard && heard.peak <= 1.5, 'at a sane level, not raw bytes read as numbers',
    heard && `peak ${heard.peak.toFixed(3)} against 1.0 full scale`);

  console.log('\n[4] Stopping puts the receiver away');
  await js(win, `document.getElementById('pvListen').click();
    for (let i = 0; i < 20 && ${L}.on(); i++) await new Promise((r) => setTimeout(r, 200));
    return true;`);
  await sleep(600);
  const after = await js(win, `return ${L}.audioIn();`);
  log(!(await js(win, `return ${L}.on();`)), 'Listen is off');
  log(after && !after.ndi, 'the NDI receiver is released, not left running through the service');
  log(ndiReceivers.size === 0, 'and nothing is still receiving in the main process', `receivers=${ndiReceivers.size}`);

  try { source.kill(); } catch (e) {}
  await sleep(500);
  console.log('\n== ' + (failed ? 'FAILED' : 'ALL PASSED') + ' ==');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
