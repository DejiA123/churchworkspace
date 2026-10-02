'use strict';
/*
 * GO LIVE — REAL NDI INPUT (discovery + video + audio).
 *
 * Boots the real app UI wired to the REAL NDI engine (src/main/ndi.js + the
 * receiver worker), broadcasts a self-contained NDI test source (moving BGRA
 * pattern + 440Hz tone via test/helpers/ndi-source.js), then drives the Input
 * Select → "NDI / Desktop Capture" → NDI tab exactly as a user would: waits for
 * the source to be discovered, selects it, clicks OK, and asserts the input
 * really receives video (canvas shows the pattern) and audio (mixer meter moves).
 * Also covers the audio-only NDI path and clean teardown.
 *
 * If the NDI runtime isn't installed on this machine the whole suite SKIPS
 * (exit 0) rather than failing — NDI receive needs the SDK runtime present.
 *
 * Run: npx electron test/ndi.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const ndi = require('../src/main/ndi');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ndi-'));
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
const ndiIpc = ndi.registerIpc(ipcMain, wrap);
const ndiReceivers = ndiIpc.receivers;

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.disableHardwareAcceleration();

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== GO LIVE — REAL NDI TEST ==');

  const status = ndi.getStatus();
  if (!status.available) {
    console.log('  SKIP  NDI runtime not installed on this machine -> ' + (status.error || ''));
    app.exit(0);
    return;
  }
  log(true, 'NDI runtime available', status.dll);
  log(!!status.machine, 'reports machine name', status.machine);

  // broadcast a self-contained NDI source (video + audio)
  const source = fork(path.join(__dirname, 'helpers', 'ndi-source.js'), [status.dll, 'MW Test Source'], { silent: true });
  await sleep(1500);

  // discovery (main-thread API)
  let found = null;
  for (let i = 0; i < 20 && !found; i++) {
    const list = ndi.getSources();
    found = list.find((s) => /MW Test Source/.test(s.name));
    if (!found) await sleep(500);
  }
  log(!!found, 'discovers the broadcast source', found && found.name);
  log(found && found.display === 'MW Test Source', 'parses machine/stream from the name', found && `machine=${found.machine} stream=${found.stream}`);

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1000);
  await js(win, `document.querySelector('.nav-item[data-view="live"]').click(); await new Promise((r)=>setTimeout(r,300)); return true;`);

  /* ======================= NDI tab discovery + select ===================== */
  console.log('\n[NDI tab] discover + select in the Input Select dialog');
  let r = await js(win, `
    document.getElementById('vmxAddInput').click();
    await new Promise((r2)=>setTimeout(r2,200));
    document.querySelector('.vmx-is-cat[data-cat="desktop"]').click();
    await new Promise((r2)=>setTimeout(r2,400));
    const onNdiTab = !!document.querySelector('.vmx-is-ndi-tab.sel') && document.querySelector('.vmx-is-ndi-tab.sel').textContent === 'NDI';
    // poll the discovered-source grid for our source, then select it
    let tile = null;
    for (let i=0;i<30 && !tile;i++){
      tile = [...document.querySelectorAll('.vmx-is-ndi-tile')].find(t => /MW Test Source/.test(t.textContent));
      if (!tile) await new Promise(r2=>setTimeout(r2,400));
    }
    if (!tile) return { onNdiTab, tileFound:false };
    tile.click();
    await new Promise(r2=>setTimeout(r2,300));
    const hasPreviewCanvas = !!document.getElementById('vmxIsNdiPreview');
    const okEnabled = !document.getElementById('vmxIsOk').disabled;
    return { onNdiTab, tileFound:true, hasPreviewCanvas, okEnabled };
  `);
  log(r && r.onNdiTab, 'NDI is the default sub-tab');
  log(r && r.tileFound, 'discovered source appears as a tile in the grid');
  log(r && r.okEnabled, 'OK enabled once a source is selected');
  log(r && r.hasPreviewCanvas, 'selected source shows a live preview canvas');

  // click OK -> adds the NDI input
  await js(win, `document.getElementById('vmxIsOk').click(); await new Promise(r2=>setTimeout(r2,300)); return true;`);

  // NDI receivers take a couple of seconds to negotiate the video stream — poll
  // (up to ~12s) for the first real frame rather than assuming a fixed delay.
  r = await js(win, `
    const inp = ${T}.state().inputs.find(i => i.type === 'ndi');
    if (!inp) return { added:false };
    let px = null;
    for (let i=0;i<60;i++){
      ${T}.drawNow();
      if (${T}.ndiGotVideo(inp.id)) { px = ${T}.inputPixel(inp.id, 160, 90); if (px && px[0] > 150) break; }
      await new Promise(r2=>setTimeout(r2,200));
    }
    return { added:true, id:inp.id, type:inp.type, hasAudio:inp.hasAudio, gotVideo:${T}.ndiGotVideo(inp.id), px };
  `);
  log(r && r.added, 'NDI input added to the switcher', r && `type=${r.type}`);
  log(r && r.gotVideo, 'receiver delivered video frames');
  log(r && r.px && !(r.px[0] === 0 && r.px[1] === 0 && r.px[2] === 0), 'input canvas is live (non-black)', r && JSON.stringify(r.px));
  log(r && r.px && r.px[0] > 150, 'received pixels match the sent pattern (R≈200)', r && ('R=' + (r.px && r.px[0])));

  // audio: the worklet wires up asynchronously, so poll for the gain node AND a
  // moving meter (needs the context running + a moment of samples buffered).
  r = await js(win, `
    const id = ${T}.state().inputs.find(i => i.type==='ndi').id;
    let level = 0, hasAudio = false, diag = null;
    for (let i=0;i<40;i++){ ${T}.drawNow(); diag = ${T}.ndiAudioDiag(id); const inp = ${T}.state().inputs.find(x=>x.id===id); hasAudio = !!(inp && inp.hasAudio); level = inp ? inp.level : 0; if (hasAudio && level > 0.005) break; await new Promise(r2=>setTimeout(r2,200)); }
    return { level, hasAudio, diag };
  `);
  log(r && r.hasAudio, 'NDI input is wired into the audio mixer', r && JSON.stringify(r.diag));
  log(r && r.level > 0.005, 'audio is flowing into the input meter', r && ('level=' + (r.level != null ? r.level.toFixed(3) : 'null')));

  /* ============================ Audio-only NDI ============================ */
  console.log('\n[Audio-only] NDI source added as an audio-only input');
  r = await js(win, `
    const src = (await window.api.live.ndiSources()).find(s => /MW Test Source/.test(s.name));
    const inp0 = ${T}.addNdiInput(src, { audioOnly:true });
    let level = 0;
    for (let i=0;i<40;i++){ ${T}.drawNow(); const inp = ${T}.state().inputs.find(x=>x.id===inp0.id); level = inp ? inp.level : 0; if (level > 0.005) break; await new Promise(r2=>setTimeout(r2,200)); }
    const inp = ${T}.state().inputs.find(x=>x.id===inp0.id);
    return inp ? { added:true, type:inp.type, hasAudio:inp.hasAudio, level } : { added:false };
  `);
  log(r && r.added, 'audio-only NDI input added', r && `type=${r.type}`);
  log(r && r.hasAudio, 'audio-only input is wired into the mixer');
  log(r && r.level > 0.001, 'audio-only input receives audio', r && ('level=' + (r.level != null ? r.level.toFixed(3) : 'null')));

  /* ============================== Teardown =============================== */
  console.log('\n[Teardown] close inputs, stop receivers');
  r = await js(win, `${T}.closeAllInputs(); await new Promise(r2=>setTimeout(r2,400));
    return { count: ${T}.state().inputs.length }; `);
  log(r && r.count === 0, 'all inputs closed cleanly', r && ('remaining=' + r.count));
  log(ndiReceivers.size === 0 || [...ndiReceivers.values()].every((x) => x.stopped), 'receivers stopped');

  try { source.send('stop'); } catch (e) {}
  try { source.kill(); } catch (e) {}
  await sleep(500);

  console.log('\n== ' + (failed ? 'FAILED' : 'ALL PASSED') + ' ==');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(failed ? 1 : 0);
});
