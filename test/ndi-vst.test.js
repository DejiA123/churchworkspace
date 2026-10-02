'use strict';
/*
 * GO LIVE — NDI "VST Output" (Ableton) scenario.
 *
 * Reproduces a real church install that failed: Ableton Live (48kHz, digital
 * mixer ASIO) with the official NDI "NDI Output" VST on its master, configured
 * "Stereo, 3-4" — an AUDIO-ONLY NDI source publishing a 4-channel stream whose
 * channels 1-2 are silent and whose program audio is on channels 3-4.
 *
 * Two bugs this guards against (both found via that install):
 *  1. Downmixing only channels 0/1 → pure silence from "Stereo, 3-4" sources.
 *     The worker now sums channel pairs.
 *  2. Adding the source WITHOUT the "Audio Only" checkbox made it a video-type
 *     input whose audio follows Program via auto-mix → muted forever (a
 *     placeholder input is never on program). The renderer now auto-detects
 *     video-less NDI inputs and treats their audio as always-on, like vMix
 *     auto-typing them as Audio inputs.
 *
 * Run: npx electron test/ndi-vst.test.js   (SKIPS cleanly if no NDI runtime)
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const ndi = require('../src/main/ndi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ndivst-'));
const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

/* ---- IPC stubs (mirrors main.js; the NDI engine under test is REAL) ---- */
let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' } };
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

/* ---- REAL NDI handlers — the SAME registration the app uses ---- */
const ndiReceivers = ndi.registerIpc(ipcMain, wrap).receivers;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== GO LIVE — NDI "VST OUTPUT" (ABLETON) TEST ==');

  const status = ndi.getStatus();
  if (!status.available) {
    console.log('  SKIP  NDI runtime not installed on this machine -> ' + (status.error || ''));
    app.exit(0);
    return;
  }

  // broadcast the church source: audio-only, 4ch, tone ONLY on channels 3-4, 48kHz
  const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, 'VST Output', 'vst'], { silent: true });
  await sleep(1500);

  let found = null;
  for (let i = 0; i < 20 && !found; i++) {
    const list = ndi.getSources();
    found = list.find((s) => /VST Output/.test(s.name));
    if (!found) await sleep(500);
  }
  log(!!found, 'discovers the audio-only VST source', found && found.name);

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1000);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r)=>setTimeout(r,300)); return true;`);

  /* Church repro: something ELSE is on program (camera/FreeShow), the VST
   * audio input is NOT — exactly when auto-mix used to mute it. */
  await js(win, `${T}.addColor('Backdrop', '#204080'); return true;`);

  console.log('\n[Church scenario] add "VST Output" WITHOUT the Audio Only checkbox');
  let r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2)=>setTimeout(r2,200));
    document.querySelector('.vmx-is-cat[data-cat="desktop"]').click();
    await new Promise((r2)=>setTimeout(r2,400));
    let tile = null;
    for (let i=0;i<30 && !tile;i++){
      tile = [...document.querySelectorAll('.vmx-is-ndi-tile')].find(t => /VST Output/.test(t.textContent));
      if (!tile) await new Promise(r2=>setTimeout(r2,400));
    }
    if (!tile) return { tileFound:false };
    tile.click();
    await new Promise(r2=>setTimeout(r2,300));
    const okBtn = document.getElementById('vmxIsOk');
    const okEnabled = !okBtn.disabled;
    okBtn.click();
    await new Promise(r2=>setTimeout(r2,300));
    return { tileFound:true, okEnabled };
  `);
  log(r && r.tileFound, 'VST source appears as a tile in the grid');
  log(r && r.okEnabled, 'OK enabled for the audio-only source');

  // Poll (grace period 4s + gain ramp): audio-only auto-detected, meter moving,
  // gain ramped to full DESPITE not being on program.
  r = await js(win, `
    const inp0 = ${T}.state().inputs.find(i => i.type === 'ndi');
    if (!inp0) return { added:false };
    let level = 0, gain = 0, det = false, onPgm = null, gotVideo = null;
    for (let i=0;i<70;i++){
      ${T}.drawNow();
      const st = ${T}.state();
      const inp = st.inputs.find(x=>x.id===inp0.id);
      level = inp ? inp.level : 0; det = !!(inp && inp.ndiAudioOnly);
      gain = ${T}.inputGain(inp0.id) || 0;
      onPgm = st.programId === inp0.id; gotVideo = ${T}.ndiGotVideo(inp0.id);
      if (det && level > 0.005 && gain > 0.5) break;
      await new Promise(r2=>setTimeout(r2,200));
    }
    const diag = ${T}.ndiAudioDiag(inp0.id) || {};
    const mix = diag.mix || null;
    return { added:true, level, gain, det, onPgm, gotVideo, mix, via: diag.via, rx: diag.rx };
  `);
  log(r && r.added, 'input added from the dialog');
  log(r && r.onPgm === false, 'input is NOT on program (auto-mix would have muted it)', r && ('onPgm=' + r.onPgm));
  log(r && r.gotVideo === false, 'source has no video stream', r && ('gotVideo=' + r.gotVideo));
  log(r && r.det, 'auto-detected as an audio-only NDI source');
  log(r && r.level > 0.005, 'AUDIO FLOWS from channels 3-4 (multichannel downmix)', r && ('level=' + r.level.toFixed(3)));
  /*
   * AND IT SAYS SO. The downmix's own account of what it did used to be thrown
   * away, so a feed whose programme was being halved and mixed with a second
   * pair looked identical to a clean one. Here exactly one pair is live, so
   * the programme must arrive at FULL level — `gain: 1`. If this ever reports
   * 2 active pairs on this sender, the downmix has started hearing something
   * on the silent channels and the service would be 6 dB down.
   */
  const mix = r && r.mix;
  log(!!mix, 'the receiver reports what its channel downmix did', mix && JSON.stringify(mix));
  log(!!mix && mix.channels === 4 && mix.pairs === 2, 'it sees the four VST channels as two pairs',
    mix && `${mix.channels}ch / ${mix.pairs} pairs`);
  log(!!mix && mix.active === 1 && mix.gain === 1,
    'only ONE pair is carrying sound, so nothing is attenuated',
    mix && `active=${mix.active} gain=${mix.gain}`);
  log(r && r.gain > 0.5, 'audio is AUDIBLE (gain ramped to full despite auto-mix)', r && ('gain=' + r.gain.toFixed(2)));
  /*
   * THE SOUND NEVER TOUCHES THE RENDERER'S MAIN THREAD. The receiver's audio
   * port is handed to the NDI worklet, so packets go from the receiver process
   * to the audio render thread directly — the main thread composites video and
   * is the one thing that can stall for 100 ms. If this reads 'main', the port
   * transfer was refused and the sound is being relayed the old way.
   */
  log(r && r.via === 'worklet', 'the Ableton feed goes straight to the audio thread, not through the busy main thread',
    r && `via=${r.via}, ${r.rx} packets counted on the audio thread`);

  /* Audio Only checkbox path with the same 4ch source */
  console.log('\n[Audio Only path] same source added WITH the checkbox');
  r = await js(win, `
    const src = (await window.api.live.ndiSources()).find(s => /VST Output/.test(s.name));
    const inp0 = ${T}.addNdiInput(src, { audioOnly:true });
    let level = 0;
    for (let i=0;i<50;i++){ ${T}.drawNow(); const inp = ${T}.state().inputs.find(x=>x.id===inp0.id); level = inp ? inp.level : 0; if (level > 0.005) break; await new Promise(r2=>setTimeout(r2,200)); }
    const inp = ${T}.state().inputs.find(x=>x.id===inp0.id);
    return { added: !!inp, type: inp && inp.type, level };
  `);
  log(r && r.added && r.type === 'ndaudio', 'added as an audio-only input', r && `type=${r.type}`);
  log(r && r.level > 0.005, 'audio flows on the Audio Only path too', r && ('level=' + r.level.toFixed(3)));

  /* Teardown */
  r = await js(win, `${T}.closeAllInputs(); await new Promise(r2=>setTimeout(r2,400)); return { count: ${T}.state().inputs.length };`);
  log(r && r.count === 0, 'all inputs closed cleanly');

  try { source.kill(); } catch (e) {}
  await sleep(500);
  console.log('\n== ' + (failed ? 'FAILED' : 'ALL PASSED') + ' ==');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
