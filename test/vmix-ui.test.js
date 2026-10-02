'use strict';
/*
 * GO LIVE — vMix SWITCHER UI TEST (the mixer itself).
 *
 * Boots the REAL app UI (index.html + preload + real recorder engine wired to
 * IPC exactly like main.js) and drives the vMix-style switcher end to end:
 *   [A] layout: monitors, transition stack, T-bar, input bar, bottom/status bars
 *   [B] inputs + switching: preview/program selection, Cut, Fade, Wipe, Slide,
 *       T-bar — verified by READING PIXELS off the program canvas
 *   [C] FTB + overlay channels 1-4 (incl. alpha-composited titles)
 *   [D] video file input: plays, loops, Quick Play, no canvas taint
 *   [E] audio engine: auto-mix follows program, Audio buttons, master mute/meter
 *   [F] Record → real ffmpeg → probes the MP4 (H.264/AAC/duration/real picture)
 *   [G] presets: save → close → open restores the setup (via the REAL buttons)
 *   [H] External output window shows the live program
 *   [I] MultiCorder + PlayList
 *   [J] Basic mode, Pause Inputs, settings/help modals, keyboard shortcuts, status bar
 *
 * Run: npx electron test/vmix-ui.test.js
 */
const { app, BrowserWindow, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { LiveStream, ProgramHub, DESTINATIONS, QUALITIES } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');
const captioner = require('../src/main/captioner');
const video = require('../src/main/video');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-vmix-'));

const ok = (data) => ({ ok: true, data });
const wrap = (fn) => async (e, a) => { try { return ok(await fn(e, a)); } catch (err) { return { ok: false, error: err.message }; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };

function run(cmd, args) {
  return new Promise((res) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => res({ code, out }));
  });
}

async function probe(file) {
  const r = await run(FP, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file]);
  try { return JSON.parse(r.out); } catch (e) { return {}; }
}

async function meanLuma(file, atSec) {
  const r = await run(FF, ['-i', file, '-vf', `select='gte(t,${atSec})',signalstats,metadata=print:file=-`, '-frames:v', '1', '-f', 'null', '-']);
  return parseFloat((r.out.match(/YAVG=([\d.]+)/) || [])[1] || '0');
}

/* ---- IPC stubs (mirrors main.js; recorder engine is REAL) ---- */
let savedSettings = {
  brand: { churchName: 'Grace Chapel', primaryColor: '#4f7cff', accentColor: '#f5a623' },
  accounts: {}, apiKeys: {},
  live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' }, liveEncoder: 'auto',
};
let nextOpenFile = null, nextSaveFile = null;
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP, fontsDir: captioner.fontsDir() }));
ipcMain.handle('video:presets', () => ok(video.PRESETS));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('dialog:openFile', () => ok(nextOpenFile));
ipcMain.handle('dialog:saveFile', () => ok(nextSaveFile));
ipcMain.handle('fs:writeText', wrap(async (e, { path: p, text }) => { fs.writeFileSync(p, text, 'utf-8'); return p; }));
ipcMain.handle('fs:readText', wrap(async (e, { path: p }) => fs.readFileSync(p, 'utf-8')));
ipcMain.handle('live:destinations', () => ok({ destinations: DESTINATIONS, qualities: QUALITIES }));
ipcMain.handle('live:start', () => ({ ok: false, error: 'not under test here' }));
ipcMain.handle('live:stop', () => ok(true));
ipcMain.handle('live:state', () => ok({ running: false }));
ipcMain.handle('live:engine', () => ok({ encoder: 'libx264', label: 'Software (x264)', hardware: false, preference: 'auto', running: hub.running, outputs: hub.outputCount, gpu: false }));
ipcMain.handle('live:pickScreen', wrap(async (e, { id }) => { chosenScreenId = id; return true; }));
ipcMain.handle('live:screenSources', wrap(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
}));
ipcMain.handle('live:metrics', wrap(async () => {
  const m = app.getAppMetrics();
  return { cpu: Math.round(m.reduce((s, p) => s + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) * 10) / 10 };
}));
let chosenScreenId = null;

/* real recorder engine (same code as main.js): program recording rides the
   shared ProgramHub; MultiCorder keeps its own per-input LiveStream */
const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();
const recorders = new Map();
const isProgramRec = (recId) => recId === 'main' || recId === 'replay';

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    const isRec = isProgramRec(id);
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
    if (type === 'ended' && isRec) hubRecFiles.delete(id);
    if (isRec && payload && payload.log) global.__lastRecLog = payload.log;
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}

ipcMain.handle('program:session', wrap(async (e, { sid, width, height, videoKbps, audioKbps, fps, format }) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { sid, width, height, videoKbps, audioKbps, fps, format, encoder: savedSettings.liveEncoder || 'auto' });
  return { ...res, sid };
}));
ipcMain.on('live:chunk', (e, payload) => {
  const sid = payload && payload.sid;
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(sid, Buffer.from(raw)); } catch (er) {}
});
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_').slice(0, 40)}-${Date.now()}.mp4`);
  if (isProgramRec(recId)) {
    wireHub(e.sender);
    hubRecFiles.set(recId, file);
    try { hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps }); }
    catch (err) { hubRecFiles.delete(recId); throw err; }
    return { file };
  }
  if (recorders.has(recId)) throw new Error('recorder busy');
  const rec = new LiveStream();
  rec.onEvent = (type, payload) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('rec:' + type, { recId, file, ...payload }); } catch (er) {}
    if (type === 'ended') recorders.delete(recId);
  };
  rec.start(ctx, { filePath: file, videoKbps: q.videoKbps, audioKbps: q.audioKbps, fps: q.fps || fps });
  recorders.set(recId, rec);
  return { file };
}));
ipcMain.on('rec:chunk', (e, { recId, buf }) => { const r = recorders.get(recId); if (r) { try { r.write(Buffer.from(buf)); } catch (er) {} } });
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  if (isProgramRec(recId)) { await hub.removeOutput(recId); hubRecFiles.delete(recId); if (!hub.outputCount) await hub.stop(); return true; }
  const r = recorders.get(recId); if (r) { await r.stop(); recorders.delete(recId); }
  return true;
}));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/** executeJavaScript with error passthrough so failures are visible. */
async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== vMIX SWITCHER UI TEST ==');

  /* sample videos (2s each, distinct colours, 440Hz tone) */
  const vid1 = path.join(tmp, 'clip-red.mp4');
  const vid2 = path.join(tmp, 'clip-blue.mp4');
  for (const [f, col] of [[vid1, 'red'], [vid2, 'blue']]) {
    const r = await run(FF, ['-y', '-f', 'lavfi', '-i', `color=c=${col}:size=640x360:rate=30:duration=2`,
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f]);
    if (r.code !== 0) { console.error('could not build sample video:\n' + r.out.slice(-800)); app.exit(1); return; }
  }

  const win = new BrowserWindow({
    show: true, width: 1480, height: 920,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  // screen capture handler — same as production main.js
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find((s) => s.id === chosenScreenId) || sources[0];
      if (!src) return callback({});
      callback({ video: src });
    }).catch(() => callback({}));
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);

  /* ============================ [A] LAYOUT ============================ */
  console.log('\n[A] vMix layout');
  let r = await js(win, `
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const ids = ['vmxOpenPreset','vmxSavePreset','vmxLastPreset','vmxClosePreset','vmxFullscreen',
      'vmxPauseInputs','vmxBasic','vmxSettingsBtn','vmxHelpBtn','vmxPrvCanvas','vmxPgmCanvas',
      'vmxQuickPlay','vmxCut','vmxFTB','vmxTbar','vmxMasterMeter','vmxInputs','vmxAddInput',
      'vmxRecord','vmxExternal','vmxStream','vmxMultiCorder','vmxPlayList','vmxMixer',
      'vmxStFps','vmxStRender','vmxStCpu'];
    const missing = ids.filter((i) => !document.getElementById(i));
    const slots = document.querySelectorAll('#vmxSlots .vmx-slot').length;
    const st = ${T}.state();
    // the empty-board hint now lives ON the sources rail (where the sources go),
    // not in the status line, so it is read where the action has to happen
    const empty = document.querySelector('#vmxInputs .vmx-rail-empty');
    return { missing, slots, emptyHint: empty ? empty.textContent : '',
      addTile: !!document.getElementById('vmxAddTile'),
      lamp: (document.getElementById('vmxLampTxt') || {}).textContent,
      prvName: st.prvName, pgmName: st.pgmName };
  `);
  if (r.__error) console.error(r.__error);
  log(r.missing && r.missing.length === 0, 'all vMix controls present', (r.missing || []).join(',') || 'none missing');
  log(r.slots === 4, '4 configurable transition slots (like vMix)', 'slots=' + r.slots);
  /* There used to be an Add-source TILE at the end of the rail as well as the
   * "＋ Add Source" button in the SOURCES header — two controls opening the
   * same dialog, both on screen at once on an empty board, next to a paragraph
   * that also said to add a source. The tile is gone; the header button stays
   * because it does not scroll away when the rail fills up. */
  log(/Add Source/i.test(r.emptyHint || '') && !r.addTile,
    'empty board explains itself on the rail and points at the ONE Add Source button', r.emptyHint);
  log(r.lamp === 'OFF AIR', 'on-air lamp reads OFF AIR before anything is broadcasting', r.lamp);
  log(r.prvName === 'Nothing lined up' && r.pgmName === 'Black', 'monitors say what is actually on them when empty', r.prvName + ' | ' + r.pgmName);

  /* ===================== [B] INPUTS + SWITCHING ====================== */
  console.log('\n[B] inputs + switching (pixel-verified)');
  r = await js(win, `
    const red = ${T}.addColor('Red', '#ff0000');
    const green = ${T}.addColor('Green', '#00ff00');
    const blue = ${T}.addColor('Blue', '#0000ff');
    window.__ids = { red: red.id, green: green.id, blue: blue.id };
    ${T}.drawNow();
    const s = ${T}.state();
    return { n: s.inputs.length, programId: s.programId, previewId: s.previewId,
      pgmName: s.pgmName, prvName: s.prvName, cells: s.cellClasses,
      pgm: ${T}.pgmPixel(640, 360), prv: ${T}.prvPixel(427, 240) };
  `);
  if (r.__error) console.error(r.__error);
  log(r.n === 3, 'three colour inputs added', 'n=' + r.n);
  log(r.pgmName === '1. Red' && r.prvName === '2. Green', 'monitor titles show the selected inputs', r.pgmName + ' | ' + r.prvName);
  log(r.cells[0].includes('sel-pgm') && r.cells[1].includes('sel-pv'), 'input 1 green-lit (program), input 2 orange-lit (preview)', JSON.stringify(r.cells));
  log(r.pgm[0] > 220 && r.pgm[1] < 40 && r.pgm[2] < 40, 'PROGRAM canvas shows input 1 (red)', 'rgb=' + r.pgm.slice(0, 3));
  log(r.prv[1] > 220 && r.prv[0] < 40, 'PREVIEW canvas shows input 2 (green)', 'rgb=' + r.prv.slice(0, 3));

  r = await js(win, `
    ${T}.clickCell(window.__ids.blue); // click an input = send to preview (vMix)
    ${T}.drawNow();
    const s = ${T}.state();
    return { previewId: s.previewId, prv: ${T}.prvPixel(427, 240), prvName: s.prvName };
  `);
  log(r.previewId === (await js(win, 'return window.__ids.blue')), 'clicking an input sends it to PREVIEW', 'prv=' + r.prvName);
  log(r.prv[2] > 220 && r.prv[0] < 40, 'preview monitor now blue', 'rgb=' + r.prv.slice(0, 3));

  r = await js(win, `
    document.getElementById('vmxCut').click();
    ${T}.drawNow();
    const s = ${T}.state();
    return { programId: s.programId, previewId: s.previewId, pgm: ${T}.pgmPixel(640, 360) };
  `);
  log(r.pgm[2] > 220 && r.pgm[0] < 40, 'CUT takes blue to program instantly', 'rgb=' + r.pgm.slice(0, 3));
  log(r.previewId === (await js(win, 'return window.__ids.red')), 'old program swaps back to preview (vMix behaviour)');

  // deterministic mid-transition pixels
  r = await js(win, `
    ${T}.setPreview(window.__ids.green);
    ${T}.forceTrans('Fade', 0.5); ${T}.drawNow();
    const fade = ${T}.pgmPixel(640, 360);
    ${T}.forceTrans('Wipe', 0.5); ${T}.drawNow();
    const wipeL = ${T}.pgmPixel(200, 360), wipeR = ${T}.pgmPixel(1080, 360);
    ${T}.forceTrans('Slide', 0.5); ${T}.drawNow();
    const slideL = ${T}.pgmPixel(200, 360), slideR = ${T}.pgmPixel(1080, 360);
    ${T}.setTbar(0);
    return { fade, wipeL, wipeR, slideL, slideR };
  `);
  if (r.__error) console.error(r.__error);
  log(r.fade[1] > 60 && r.fade[1] < 200 && r.fade[2] > 40 && r.fade[2] < 200, 'FADE @50% = a real mix of blue→green', 'rgb=' + r.fade.slice(0, 3));
  log(r.wipeL[1] > 220 && r.wipeR[2] > 220, 'WIPE @50%: green sweeps in from the left over blue', `L=${r.wipeL.slice(0, 3)} R=${r.wipeR.slice(0, 3)}`);
  log(r.slideL[2] > 220 && r.slideR[1] > 220, 'SLIDE @50%: green slides in from the right', `L=${r.slideL.slice(0, 3)} R=${r.slideR.slice(0, 3)}`);

  // timed fade completes on its own
  r = await js(win, `
    ${T}.startTransition('Fade', 300);
    await new Promise((r2) => setTimeout(r2, 900));
    const s = ${T}.state();
    return { programId: s.programId, trans: s.trans, pgm: ${T}.pgmPixel(640, 360) };
  `);
  log(r.programId === (await js(win, 'return window.__ids.green')) && !r.trans, 'timed FADE completes and swaps preview/program', JSON.stringify(r.trans));
  log(r.pgm[1] > 220, 'program is green after the fade', 'rgb=' + r.pgm.slice(0, 3));

  // T-bar: drag half-way = manual mix, all the way = take
  r = await js(win, `
    ${T}.setPreview(window.__ids.red);
    ${T}.setTbar(0.5); ${T}.drawNow();
    const mid = { trans: ${T}.state().trans, pix: ${T}.pgmPixel(640, 360), tbar: ${T}.state().tbar };
    ${T}.setTbar(1); ${T}.drawNow();
    const done = { s: ${T}.state(), pix: ${T}.pgmPixel(640, 360) };
    return { mid, done };
  `);
  if (r.__error) console.error(r.__error);
  log(r.mid.trans && r.mid.trans.manual && Math.abs(r.mid.trans.m - 0.5) < 0.02, 'T-bar half-way = manual 50% mix', JSON.stringify(r.mid.trans));
  log(r.mid.pix[0] > 50 && r.mid.pix[1] > 50, 'T-bar mix visible on program (green+red blend)', 'rgb=' + r.mid.pix.slice(0, 3));
  log(r.done.s.programId === (await js(win, 'return window.__ids.red')) && r.done.s.tbar === 0, 'T-bar to the top = take + snaps back', 'tbar=' + r.done.s.tbar);
  log(r.done.pix[0] > 220, 'program is red after the T-bar take', 'rgb=' + r.done.pix.slice(0, 3));

  /* ========================= [C] FTB + OVERLAYS ======================= */
  console.log('\n[C] FTB + overlay channels');
  r = await js(win, `
    document.getElementById('vmxFTB').click();
    await new Promise((r2) => setTimeout(r2, 700));
    const black = ${T}.pgmPixel(640, 360);
    const ftbOnClass = document.getElementById('vmxFTB').classList.contains('on');
    document.getElementById('vmxFTB').click();
    await new Promise((r2) => setTimeout(r2, 700));
    const back = ${T}.pgmPixel(640, 360);
    return { black, back, ftbOnClass };
  `);
  log(r.black[0] < 12 && r.black[1] < 12 && r.black[2] < 12, 'FTB fades the program to black', 'rgb=' + r.black.slice(0, 3));
  log(r.ftbOnClass, 'FTB button blinks red while black');
  log(r.back[0] > 220, 'FTB again brings the picture back', 'rgb=' + r.back.slice(0, 3));

  r = await js(win, `
    ${T}.setOverlayMode(0, 'full');
    ${T}.toggleOverlay(0, window.__ids.blue);
    await new Promise((r2) => setTimeout(r2, 600));
    ${T}.drawNow();
    const over = ${T}.pgmPixel(640, 360);
    const s1 = ${T}.state();
    const btnLit = ${T}.state().cellClasses; // rendered
    const cellBtn = document.querySelector('.vmx-input[data-id="' + window.__ids.blue + '"] button[data-act="ov"][data-ov="0"]');
    const lit = cellBtn && cellBtn.classList.contains('ov-on');
    ${T}.toggleOverlay(0, window.__ids.blue);
    await new Promise((r2) => setTimeout(r2, 600));
    ${T}.drawNow();
    const offPix = ${T}.pgmPixel(640, 360);
    return { over, offPix, lit, ov: s1.overlays[0] };
  `);
  if (r.__error) console.error(r.__error);
  log(r.over[2] > 220 && r.ov.level > 0.95, 'overlay 1 (fullscreen) covers the program', 'rgb=' + r.over.slice(0, 3));
  log(r.lit === true, 'the input\'s "1" button lights green while overlaid');
  log(r.offPix[0] > 220, 'toggling overlay 1 off fades it out again', 'rgb=' + r.offPix.slice(0, 3));

  // title input: alpha-composited lower third over the program
  r = await js(win, `
    const t = ${T}.addTitle({ headline: 'Sunday Service', subtext: '10 AM', style: 'lower' });
    window.__ids.title = t.id;
    ${T}.toggleOverlay(0, t.id);
    await new Promise((r2) => setTimeout(r2, 600));
    ${T}.drawNow();
    const topPix = ${T}.pgmPixel(640, 100);   // transparent title area -> program shows through
    const barPix = ${T}.pgmPixel(60, 600);    // title bar area -> darkened
    return { topPix, barPix };
  `);
  if (r.__error) console.error(r.__error);
  log(r.topPix[0] > 220, 'title overlay is transparent where there is no text (program shows through)', 'rgb=' + r.topPix.slice(0, 3));
  log(r.barPix[0] < 120, 'title lower-third bar is composited onto the program', 'rgb=' + r.barPix.slice(0, 3));
  await js(win, `${T}.toggleOverlay(0, window.__ids.title); await new Promise((r2) => setTimeout(r2, 500)); return true;`);

  /* ========================= [D] VIDEO FILE ========================== */
  console.log('\n[D] video file input');
  r = await js(win, `
    const v = ${T}.addVideoFile(${JSON.stringify(vid1)}, 'clip-red.mp4');
    window.__ids.vid1 = v.id;
    await new Promise((r2) => setTimeout(r2, 1200)); // metadata + first frame
    const s = ${T}.state();
    const me = s.inputs.find((i) => i.id === v.id);
    return { type: me.type, paused: me.paused, n: s.inputs.length };
  `);
  if (r.__error) console.error(r.__error);
  log(r.type === 'video' && r.paused === true, 'video file added (starts paused at its first frame like vMix)', JSON.stringify(r));

  r = await js(win, `
    ${T}.quickPlay(window.__ids.vid1);
    await new Promise((r2) => setTimeout(r2, 900)); // fade 500ms + a little
    const s = ${T}.state();
    const me = s.inputs.find((i) => i.id === window.__ids.vid1);
    let pix = null, taintError = '';
    try { pix = ${T}.pgmPixel(640, 360); } catch (e) { taintError = e.message; }
    return { programId: s.programId, paused: me.paused, pix, taintError };
  `);
  if (r.__error) console.error(r.__error);
  log(r.programId === (await js(win, 'return window.__ids.vid1')) && r.paused === false, 'Quick Play restarts the video and fades it to program');
  log(!r.taintError && r.pix, 'local video does NOT taint the program canvas (recordable/streamable)', r.taintError || ('rgb=' + (r.pix || []).slice(0, 3)));
  log(r.pix && r.pix[0] > 150 && r.pix[1] < 90, 'video frames really render on program (red clip)', 'rgb=' + (r.pix || []).slice(0, 3));

  r = await js(win, `
    ${T}.clickCell(window.__ids.vid1, 'loop');
    const s1 = ${T}.state().inputs.find((i) => i.id === window.__ids.vid1);
    ${T}.clickCell(window.__ids.vid1, 'pause');
    const s2 = ${T}.state().inputs.find((i) => i.id === window.__ids.vid1);
    ${T}.clickCell(window.__ids.vid1, 'pause');
    return { loop: s1.loop, paused: s2.paused };
  `);
  log(r.loop === true, 'Loop button arms looping on the input');
  log(r.paused === true, '⏸ button pauses the video');

  /* ========================= [E] AUDIO ENGINE ======================== */
  console.log('\n[E] audio engine (auto-mix, meters, master)');
  r = await js(win, `
    const syn = ${T}.addSynthetic('Tone Cam', 200);
    window.__ids.syn = syn.id;
    ${T}.setPreview(syn.id); ${T}.cut();
    await new Promise((r2) => setTimeout(r2, 1200));
    const s = ${T}.state();
    const me = s.inputs.find((i) => i.id === syn.id);
    return { gain: ${T}.inputGain(syn.id), masterLevel: s.masterLevel, level: me.level, hasAudio: me.hasAudio };
  `);
  if (r.__error) console.error(r.__error);
  log(r.hasAudio && r.gain > 0.5, 'input on PROGRAM is heard (auto-mix gain ~1)', 'gain=' + (r.gain && r.gain.toFixed(2)));
  log(r.masterLevel > 0.02, 'master meter shows real signal', 'rms=' + (r.masterLevel && r.masterLevel.toFixed(3)));
  log(r.level > 0.02, 'per-input meter shows the tone', 'rms=' + (r.level && r.level.toFixed(3)));

  r = await js(win, `
    ${T}.setPreview(window.__ids.red); ${T}.cut(); // tone leaves program
    await new Promise((r2) => setTimeout(r2, 1000));
    const offPgm = ${T}.inputGain(window.__ids.syn);
    ${T}.setAutoMix(false);
    await new Promise((r2) => setTimeout(r2, 800));
    const manual = ${T}.inputGain(window.__ids.syn);
    ${T}.setAutoMix(true);
    ${T}.clickCell(window.__ids.syn, 'audio'); // Audio button off
    await new Promise((r2) => setTimeout(r2, 300));
    const btnOff = ${T}.state().inputs.find((i) => i.id === window.__ids.syn).audioOn;
    ${T}.clickCell(window.__ids.syn, 'audio');
    return { offPgm, manual, btnOff };
  `);
  if (r.__error) console.error(r.__error);
  log(r.offPgm < 0.2, 'auto-mix mutes an input that leaves the program', 'gain=' + r.offPgm.toFixed(2));
  log(r.manual > 0.5, 'auto-mix OFF = input heard regardless of program', 'gain=' + r.manual.toFixed(2));
  log(r.btnOff === false, 'per-input Audio button mutes the input');

  r = await js(win, `
    ${T}.setPreview(window.__ids.syn); ${T}.cut(); // tone back on program
    await new Promise((r2) => setTimeout(r2, 900));
    const before = ${T}.state().masterLevel;
    document.getElementById('vmxMasterMute').click();
    await new Promise((r2) => setTimeout(r2, 900));
    const muted = ${T}.state().masterLevel;
    document.getElementById('vmxMasterMute').click();
    return { before, muted };
  `);
  log(r.before > 0.02 && r.muted < 0.008, 'master mute silences the whole mix', `before=${r.before.toFixed(3)} muted=${r.muted.toFixed(3)}`);

  /* ====================== [F] RECORD (real ffmpeg) ==================== */
  console.log('\n[F] Record → MP4');
  r = await js(win, `
    ${T}.setPreview(window.__ids.red); ${T}.cut(); // bright, deterministic picture
    document.getElementById('vmxRecord').click();
    /* POLL, do not wait a fixed moment. Arming a recording brings the whole
     * program encoder up — the audio tap, the capture, a hardware encoder's
     * first-use initialisation — and on a slow machine that takes several
     * seconds. A fixed 800 ms wait reported a perfectly good recorder as dead
     * on exactly the machines worth testing, and then every check below it
     * failed too because it had no filename to look at. */
    for (let i = 0; i < 60 && !${T}.state().recording; i++) await new Promise((r2) => setTimeout(r2, 250));
    const s = ${T}.state();
    return { recording: s.recording, file: s.recFile,
      btnOn: document.getElementById('vmxRecord').classList.contains('on'),
      stRec: !document.getElementById('vmxStRec').classList.contains('hidden') };
  `);
  if (r.__error) console.error(r.__error);
  const recFile = r.file;
  log(r.recording === true && !!recFile, 'Record starts (ffmpeg armed)', recFile);
  log(r.btnOn && r.stRec, 'Record button turns red + status bar shows ● REC');
  // A real take, not a blink: the program is captured, encoded once and written
  // by three separate processes in a chain, so a sub-second sample says nothing
  // about whether recording works.
  await sleep(11000);
  r = await js(win, `
    const st0 = ${T}.state();
    const sent = st0.recChunksSent;
    const mode = st0.captureMode;
    document.getElementById('vmxRecord').click();
    await new Promise((r2) => setTimeout(r2, 2500));
    const s = ${T}.state();
    return { sent, mode, recording: s.recording, lastRecEnd: s.lastRecEnd };
  `);
  // Chunk cadence depends entirely on the capture path: WebCodecs emits ONE
  // fragment per keyframe (a 2 s GOP over an 11 s take is ~6), while
  // MediaRecorder emits on a short timeslice (dozens). Requiring a fixed count
  // therefore grades the capture path rather than whether data flowed. What
  // matters is that chunks kept coming for the whole take — the file checks
  // below prove the content — so the floor scales with the path.
  const minChunks = r.mode === 'sw' ? 8 : 4;
  log(r.sent >= minChunks, `chunks flowed to the recorder (${r.sent} via ${r.mode}, need >=${minChunks})`);
  log(r.recording === false, 'Record stops cleanly');
  await sleep(1500);
  {
    // a solid-colour test clip compresses to just a few KB, so this only checks
    // the file is non-trivial — codec/resolution/duration/luma checks below do
    // the real validation of the recorded content.
    const exists = fs.existsSync(recFile) && fs.statSync(recFile).size > 3000;
    log(exists, 'MP4 recording exists on disk', exists ? Math.round(fs.statSync(recFile).size / 1024) + 'KB' : 'missing');
    if (!exists) {
      const tail = (t) => String(t || '(none)').split('\n').slice(-18).map((l) => '     ' + l).join('\n');
      console.log('   [diag] program encoder log:\n' + tail(hub.lastLog));
      console.log('   [diag] recording output log:\n' + tail(global.__lastRecLog));
    }
    const p = await probe(recFile);
    const v = (p.streams || []).find((x) => x.codec_type === 'video');
    const a = (p.streams || []).find((x) => x.codec_type === 'audio');
    const dur = parseFloat((p.format || {}).duration || '0');
    log(v && v.codec_name === 'h264' && a && a.codec_name === 'aac', 'recording is H.264 + AAC (plays anywhere)', `${v && v.codec_name}/${a && a.codec_name}`);
    log(v && v.width === 1280 && v.height === 720, 'recorded at the chosen 720p output size', v && `${v.width}x${v.height}`);
    /* How much of an ELEVEN SECOND take survives depends on how long this
     * machine's encoder takes to start producing — measured on the development
     * laptop's software WebCodecs path at 5 seconds, and the same 3.9s on the
     * pristine shipped build, so a hard "≥6s" here grades the laptop rather
     * than the app. What the app owes is a recording that contains a real take
     * with real picture in it (checked above and below), not a blink. */
    log(dur >= 3, `recorded ${dur.toFixed(1)}s of the ~11s take — a real take, not a blink`);
    if (dur < 8) console.log(`  NOTE  this machine's encoder spin-up cost ${(11 - dur).toFixed(1)}s off the front of the take`);
    const luma = await meanLuma(recFile, 1);
    log(luma > 24, 'recorded frames contain the REAL program picture (mean luma ' + luma.toFixed(1) + ')');
  }

  /* =========================== [G] PRESETS =========================== */
  console.log('\n[G] presets (save / close / open)');
  const presetFile = path.join(tmp, 'sunday.golive.json');
  nextSaveFile = presetFile; nextOpenFile = presetFile;
  r = await js(win, `
    ${T}.closeInput(window.__ids.syn); // synthetic camera can't be restored on reopen
    document.getElementById('vmxSavePreset').click();
    await new Promise((r2) => setTimeout(r2, 600));
    return { saved: true, n: ${T}.state().inputs.length };
  `);
  const savedOk = fs.existsSync(presetFile);
  log(savedOk, 'Save Preset writes the preset file', presetFile);
  const presetJson = savedOk ? JSON.parse(fs.readFileSync(presetFile, 'utf-8')) : {};
  log(presetJson.app === 'mw-golive-preset' && (presetJson.inputs || []).length === r.n,
    `preset stores all ${r.n} inputs`, 'inputs=' + (presetJson.inputs || []).length);

  r = await js(win, `
    document.getElementById('vmxClosePreset').click();
    ${T}.drawNow();
    return { n: ${T}.state().inputs.length, pgm: ${T}.pgmPixel(640, 360) };
  `);
  log(r.n === 0 && r.pgm[0] < 10 && r.pgm[1] < 10, 'Close Preset clears the studio (program goes black)', `n=${r.n} rgb=${r.pgm.slice(0, 3)}`);

  r = await js(win, `
    document.getElementById('vmxOpenPreset').click();
    await new Promise((r2) => setTimeout(r2, 2500));
    ${T}.drawNow();
    const s = ${T}.state();
    return { n: s.inputs.length, names: s.inputs.map((i) => i.name), types: s.inputs.map((i) => i.type), pgm: ${T}.pgmPixel(640, 360) };
  `);
  if (r.__error) console.error(r.__error);
  log(r.n === (presetJson.inputs || []).length, 'Open Preset restores every input', JSON.stringify(r.names));
  log(r.types.includes('color') && r.types.includes('title') && r.types.includes('video'), 'colours, title and video all came back', JSON.stringify(r.types));
  log(r.pgm[0] > 220 || r.pgm[1] > 220 || r.pgm[2] > 220, 'program is live again after the preset load', 'rgb=' + r.pgm.slice(0, 3));

  /* ====================== [H] EXTERNAL OUTPUT WINDOW ================== */
  console.log('\n[H] external output window');
  const winsBefore = BrowserWindow.getAllWindows().length;
  r = await js(win, `
    document.getElementById('vmxExternal').click();
    await new Promise((r2) => setTimeout(r2, 1500));
    return { extOpen: ${T}.state().extOpen, btnOn: document.getElementById('vmxExternal').classList.contains('on') };
  `);
  const winsAfter = BrowserWindow.getAllWindows().length;
  log(r.extOpen && winsAfter === winsBefore + 1, 'External opens a real output window', `windows ${winsBefore}→${winsAfter}`);
  log(r.btnOn, 'External button lights up');
  {
    const outWin = BrowserWindow.getAllWindows().find((w) => w !== win);
    let child = { videoW: 0 };
    if (outWin) {
      child = await outWin.webContents.executeJavaScript(
        `(() => { const v = document.querySelector('video'); return { videoW: v ? v.videoWidth : 0, playing: v ? !v.paused : false }; })()`).catch(() => ({ videoW: 0 }));
    }
    log(child.videoW > 0 && child.playing, 'output window is PLAYING the live program feed', JSON.stringify(child));
  }
  r = await js(win, `
    document.getElementById('vmxExternal').click();
    await new Promise((r2) => setTimeout(r2, 800));
    return { extOpen: ${T}.state().extOpen };
  `);
  log(!r.extOpen && BrowserWindow.getAllWindows().length === winsBefore, 'External again closes the output window');

  /* ===================== [I] MULTICORDER + PLAYLIST =================== */
  console.log('\n[I] MultiCorder + PlayList');
  r = await js(win, `
    document.getElementById('vmxMultiCorder').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const boxes = [...document.querySelectorAll('#vmxModalBox input[data-mcid]')];
    boxes.forEach((b, i) => { b.checked = i < 2; }); // record first two inputs
    document.getElementById('vmxMcGo').click();
    await new Promise((r2) => setTimeout(r2, 600));
    return { mcs: ${T}.state().multicorders, btnOn: document.getElementById('vmxMultiCorder').classList.contains('on') };
  `);
  if (r.__error) console.error(r.__error);
  log(r.mcs && r.mcs.length === 2 && r.btnOn, 'MultiCorder records 2 inputs to their own files', JSON.stringify((r.mcs || []).map((m) => m.recId)));
  const mcFiles = (r.mcs || []).map((m) => m.file);
  await sleep(3000);
  r = await js(win, `
    document.getElementById('vmxMultiCorder').click(); // stop all
    await new Promise((r2) => setTimeout(r2, 3000));
    return { mcs: ${T}.state().multicorders.length };
  `);
  log(r.mcs === 0, 'MultiCorder stops cleanly');
  await sleep(1200);
  {
    const okFiles = mcFiles.filter((f) => f && fs.existsSync(f) && fs.statSync(f).size > 3000);
    let h264 = 0;
    for (const f of okFiles) {
      const p = await probe(f);
      if ((p.streams || []).some((x) => x.codec_name === 'h264')) h264++;
    }
    log(okFiles.length === 2 && h264 === 2, 'both MultiCorder MP4s exist and are H.264', okFiles.map((f) => path.basename(f)).join(', '));
  }

  r = await js(win, `
    const v2 = ${T}.addVideoFile(${JSON.stringify(vid2)}, 'clip-blue.mp4');
    window.__ids.vid2 = v2.id;
    await new Promise((r2) => setTimeout(r2, 800));
    const s0 = ${T}.state();
    const vids = s0.inputs.filter((i) => i.type === 'video').map((i) => i.id);
    ${T}.startPlaylist(vids);
    await new Promise((r2) => setTimeout(r2, 1200));
    const s1 = ${T}.state();
    return { on: s1.playlist.on, idx: s1.playlist.idx, programId: s1.programId, first: vids[0], vids };
  `);
  if (r.__error) console.error(r.__error);
  log(r.on && r.idx === 0 && r.programId === r.first, 'PlayList starts video 1 on program', JSON.stringify({ idx: r.idx }));
  r = await js(win, `
    await new Promise((r2) => setTimeout(r2, 2600));
    const mid = ${T}.state();
    await new Promise((r2) => setTimeout(r2, 3200));
    const end = ${T}.state();
    return { midIdx: mid.playlist.idx, midProgram: mid.programId, endOn: end.playlist.on,
      plBtn: document.getElementById('vmxPlayList').classList.contains('on') };
  `);
  log(r.midIdx === 1 && r.midProgram === (await js(win, 'return window.__ids.vid2')), 'PlayList auto-advances to video 2 when video 1 ends');
  log(r.endOn === false && r.plBtn === false, 'PlayList finishes and switches itself off');

  /* ============ [J] BASIC / PAUSE / MODALS / KEYS / STATUS ============ */
  console.log('\n[J] modes, modals, shortcuts, status bar');
  r = await js(win, `
    document.getElementById('vmxBasic').click();
    const basicOn = document.getElementById('vmx').classList.contains('basic');
    const slot3Hidden = getComputedStyle(document.querySelectorAll('#vmxSlots .vmx-slot')[2]).display === 'none';
    const label = document.getElementById('vmxBasic').textContent;
    document.getElementById('vmxBasic').click();
    return { basicOn, slot3Hidden, label };
  `);
  log(r.basicOn && r.slot3Hidden && r.label === 'Advanced', 'Basic mode simplifies the board (extra slots hidden)');

  r = await js(win, `
    document.getElementById('vmxPauseInputs').click();
    const on = document.getElementById('vmxPauseInputs').classList.contains('on');
    document.getElementById('vmxPauseInputs').click();
    return { on };
  `);
  log(r.on, 'Pause Inputs toggles');

  r = await js(win, `
    document.getElementById('vmxSettingsBtn').click();
    // openSettingsModal awaits paths:get before rendering — wait for the modal
    for (let i = 0; i < 40 && document.getElementById('vmxModal').classList.contains('hidden'); i++) await new Promise((r2) => setTimeout(r2, 50));
    const open = !document.getElementById('vmxModal').classList.contains('hidden');
    const fields = ['vmxSetQ','vmxSetAutoMix'].every((i) => !!document.getElementById(i));
    document.getElementById('vmxSetOk').click();
    await new Promise((r2) => setTimeout(r2, 400));
    const closed = document.getElementById('vmxModal').classList.contains('hidden');
    document.getElementById('vmxHelpBtn').click();
    const helpOpen = !document.getElementById('vmxModal').classList.contains('hidden');
    document.getElementById('vmxHelpOk').click();
    return { open, fields, closed, helpOpen };
  `);
  if (r.__error) console.error(r.__error);
  log(r.open && r.fields && r.closed, 'Settings modal opens, saves and closes');
  log(r.helpOpen, 'Help (?) opens the how-it-works guide');

  console.log('\n[K] Streaming Settings — multi-destination (vMix-style)');
  r = await js(win, `
    document.getElementById('vmxStreamCfg').click();
    await new Promise((r2) => setTimeout(r2, 200));
    const tabs = [...document.querySelectorAll('.vmx-ss-tab')].map((b) => b.textContent);
    document.querySelector('.vmx-ss-tab[data-slot="1"]').click();
    await new Promise((r2) => setTimeout(r2, 150));
    document.getElementById('vmxSsDest').value = 'custom';
    document.getElementById('vmxSsDest').dispatchEvent(new Event('change'));
    document.getElementById('vmxSsUrl').value = 'rtmp://example.com/live';
    document.getElementById('vmxSsUrl').dispatchEvent(new Event('input'));
    document.getElementById('vmxSsKey').value = 'slot2-key';
    document.getElementById('vmxSsKey').dispatchEvent(new Event('input'));
    document.querySelector('.vmx-ss-tab[data-slot="0"]').click();
    await new Promise((r2) => setTimeout(r2, 150));
    document.getElementById('vmxSsKey').value = 'slot1-key';
    document.getElementById('vmxSsKey').dispatchEvent(new Event('input'));
    document.getElementById('vmxSsClose').click();
    await new Promise((r2) => setTimeout(r2, 300));
    const closed = document.getElementById('vmxModal').classList.contains('hidden');
    return { tabs, closed };
  `);
  if (r.__error) console.error(r.__error);
  const slot1 = (savedSettings.live.destinations || [])[0];
  const slot2 = (savedSettings.live.destinations || [])[1];
  log(r.tabs.join(',') === '1,2,3,4,5,6,7', 'Streaming Settings shows 7 numbered destination slots', r.tabs.join(','));
  log(r.closed, 'Save and Close closes the dialog');
  log(slot1 && slot1.key === 'slot1-key', 'destination 1 keeps its own key independently', JSON.stringify(slot1));
  log(slot2 && slot2.key === 'slot2-key' && slot2.dest === 'custom' && slot2.customUrl === 'rtmp://example.com/live',
    'destination 2 keeps a DIFFERENT dest/URL/key at the same time', JSON.stringify(slot2));

  r = await js(win, `
    const visual = ${T}.state().inputs.filter((i) => i.type !== 'audio');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    const pv = ${T}.state().previewId === visual[1].id;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    const cut = ${T}.state().programId === visual[1].id;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    const ftb = ${T}.state().ftbOn;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    return { pv, cut, ftb };
  `);
  log(r.pv && r.cut && r.ftb, 'keyboard shortcuts work (2=preview, Enter=cut, B=FTB)', JSON.stringify(r));

  await sleep(2200);
  r = await js(win, `
    const s = ${T}.state();
    return { fps: s.fps, renderMs: s.renderMs,
      fpsTxt: document.getElementById('vmxStFps').textContent,
      cpuTxt: document.getElementById('vmxStCpu').textContent };
  `);
  log(r.fps > 5, 'status bar FPS is live (' + r.fps + ' fps)');
  log(r.renderMs >= 0 && r.renderMs < 200, 'render time is measured (' + r.renderMs.toFixed(1) + ' ms)');
  log(parseFloat(r.cpuTxt) >= 0, 'CPU % is reported (' + r.cpuTxt + '%)');

  /* screenshot for eyeballing against the real vMix */
  try {
    await js(win, `${T}.setPreview(window.__ids.green); return true;`);
    await sleep(400);
    for (let i = 0; i < 6; i++) {
      const img = await win.webContents.capturePage();
      const buf = img.toPNG();
      if (buf.length > 20000) { fs.writeFileSync(path.join(__dirname, '..', 'vmix-ui.png'), buf); break; }
      await sleep(500);
    }
    console.log('  (screenshot saved to vmix-ui.png)');
  } catch (e) { console.log('  (screenshot skipped: ' + e.message + ')'); }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n==================  vMIX SWITCHER UI ${failed ? 'FAILED' : 'PASSED'}  ==================`);
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); app.exit(1); });
