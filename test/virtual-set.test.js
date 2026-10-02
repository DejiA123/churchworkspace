'use strict';
/*
 * VIRTUAL SET — a camera keyed into a studio scene, vMix-style.
 *
 * Judged on PIXELS, because every part of this feature is a claim about what
 * ends up on screen and none of it is provable any other way:
 *   • the green screen is actually gone (not merely "a canvas rendered")
 *   • the scene behind it is actually showing THROUGH where the green was
 *   • the presenter's own colours survive the key
 *   • the four shots really are different framings, and switching glides
 *   • a set that nobody can see costs nothing
 *
 * The source is a synthetic "camera": a green field with a red block standing
 * in for the presenter. The scene behind is solid blue. So after keying, the
 * area around the block must read BLUE (the scene) and the block must read RED
 * (the presenter) — and if the key were not working the whole frame would read
 * green.
 *
 *   npm run test:vset
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmod = require('../src/main/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-vset-'));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

/* A blue "studio" the presenter will be standing in. */
const BG = path.join(tmp, 'studio.png');
function writeBluePng() {
  const { execFileSync } = require('child_process');
  execFileSync(ffmod.resolveFfmpeg(), ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', 'color=c=0x0000ff:s=1280x720', '-frames:v', '1', BG]);
}

let savedSettings = { brand: {}, accounts: {}, apiKeys: {}, live: {}, liveEncoder: 'auto', gpuAcceleration: 'on' };
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: ffmod.resolveFfmpeg(), ffprobe: ffmod.resolveFfprobe() }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'present:displays',
  'bible:installed', 'bible:catalogue', 'live:screenSources']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:state', () => ok({ outputs: [], displays: [] }));
ipcMain.handle('dmx:state', () => ok({ enabled: false }));
ipcMain.handle('webout:state', () => ok({ running: false }));
ipcMain.handle('ndiout:state', () => ok({ feeds: [] }));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {} }));
ipcMain.handle('dialog:openFile', () => ok(BG));

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);
const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 40 : tol);

app.whenReady().then(async () => {
  console.log('== VIRTUAL SET ==');
  writeBluePng();
  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  console.log('\n[1] The engine is there and running on the GPU');
  const eng = await js(win, `
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    const s = window.VirtualSet.createSet(320, 180);
    const r = { has: !!window.VirtualSet, accel: s.accelerated, presets: window.VirtualSet.DEFAULT_PRESETS.length };
    s.destroy();
    return r;`);
  if (eng.__error) { console.error(eng.__error); app.exit(1); return; }
  log(eng.has, 'the virtual set engine is loaded');
  log(eng.accel, 'and it is keying on the GPU — per-pixel work belongs there', eng.accel ? 'WebGL' : 'CPU fallback');
  log(eng.presets === 4, 'a set ships with four camera positions', String(eng.presets));

  console.log('\n[2] Build a set: a green-screen camera in a blue studio');
  const built = await js(win, `
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    // the "camera": a green screen with a red presenter standing in it
    const cam = T.addGreenScreen('Cam');
    const vs = await T.addVirtualSet({
      name: 'Set', sourceId: cam.id, bgPath: ${JSON.stringify(BG)},
      key: { on: true, color: '#00b140', tolerance: 0.2, softness: 0.05, spill: 0.4 },
    });
    T.setPreview(vs.id); T.cut();
    await new Promise(r => setTimeout(r, 700));
    T.drawNow();
    const s = T.state();
    return { camId: cam.id, vsId: vs.id, type: s.inputs.find(i => i.id === vs.id).type, n: s.inputs.length };`);
  if (built.__error) { console.error(built.__error); app.exit(1); return; }
  log(built.type === 'vset', 'the virtual set is an input like any other — cut to, faded, recorded', built.type);

  console.log('\n[3] ►► IS THE GREEN SCREEN ACTUALLY GONE? ◄◄');
  const px = await js(win, `
    const T = window.LiveStudio.__test;
    T.drawNow();
    await new Promise(r => setTimeout(r, 250));
    T.drawNow();
    const [w, h] = T.pgmSize();
    return {
      corner: T.pgmPixel(Math.round(w * 0.08), Math.round(h * 0.12)),
      side:   T.pgmPixel(Math.round(w * 0.92), Math.round(h * 0.5)),
      centre: T.pgmPixel(Math.round(w * 0.5),  Math.round(h * 0.62)),
      w, h };`);
  if (px.__error) console.error(px.__error);
  const c = px.corner || [], mid = px.centre || [], side = px.side || [];
  console.log(`    corner rgb(${c.slice(0, 3)}) · side rgb(${side.slice(0, 3)}) · centre rgb(${mid.slice(0, 3)})`);
  log(c[2] > 120 && c[1] < 90, 'where the green screen was, the STUDIO is showing through (blue)',
    `rgb(${c.slice(0, 3)})`);
  log(side[2] > 120 && side[1] < 90, 'and it is gone across the whole frame, not just one corner',
    `rgb(${side.slice(0, 3)})`);
  log(mid[0] > 110 && mid[2] < 110, 'the presenter survived the key (still red, not keyed away)',
    `rgb(${mid.slice(0, 3)})`);
  log(!(c[1] > 110 && c[0] < 110 && c[2] < 110), 'nothing anywhere is still green — the key really ran',
    `corner rgb(${c.slice(0, 3)})`);

  console.log('\n[4] The four shots are four different framings, and the move glides');
  const shots = await js(win, `
    const T = window.LiveStudio.__test;
    const id = ${built.vsId};
    const seen = [];
    for (let i = 0; i < 4; i++) {
      T.vsetGoTo(id, i, 0);            // 0ms = cut straight there, for measuring
      await new Promise(r => setTimeout(r, 120));
      T.drawNow();
      seen.push(T.vsetPos(id));
    }
    // and now a real glide
    T.vsetGoTo(id, 0, 0);
    await new Promise(r => setTimeout(r, 80));
    T.vsetGoTo(id, 2, 600);
    const a = T.vsetPos(id);
    await new Promise(r => setTimeout(r, 300));
    const mid = T.vsetPos(id);
    const moving = T.vsetMoving(id);
    await new Promise(r => setTimeout(r, 600));
    const end = T.vsetPos(id);
    return { seen, a, mid, end, moving, target: T.vsetPresets(id)[2] };`);
  if (shots.__error) console.error(shots.__error);
  const uniq = new Set((shots.seen || []).map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.scale.toFixed(3)}`));
  log(uniq.size === 4, 'the four shots are genuinely different camera positions', `${uniq.size} distinct`);
  const midBetween = shots.mid && shots.a && shots.end &&
    ((shots.mid.scale > Math.min(shots.a.scale, shots.end.scale) + 0.01) &&
     (shots.mid.scale < Math.max(shots.a.scale, shots.end.scale) - 0.01));
  log(midBetween, 'half way through a move the camera is BETWEEN the two shots — it glides, not cuts',
    shots.mid ? `from ${shots.a.scale.toFixed(2)} → ${shots.mid.scale.toFixed(2)} → ${shots.end.scale.toFixed(2)}` : 'no reading');
  log(shots.moving === true, 'and it reports itself as moving while it does');
  log(shots.end && shots.target && near(shots.end.scale * 100, shots.target.scale * 100, 2),
    'and it arrives exactly on the shot it was sent to',
    shots.end ? `${shots.end.scale.toFixed(3)} vs ${shots.target.scale.toFixed(3)}` : 'no reading');

  console.log('\n[5] Changing the key live changes what is on air');
  const off = await js(win, `
    const T = window.LiveStudio.__test;
    T.vsetSetKey(${built.vsId}, { on: false });
    await new Promise(r => setTimeout(r, 200));
    T.drawNow();
    const [w, h] = T.pgmSize();
    const corner = T.pgmPixel(Math.round(w * 0.08), Math.round(h * 0.12));
    T.vsetSetKey(${built.vsId}, { on: true });
    await new Promise(r => setTimeout(r, 200));
    T.drawNow();
    const back = T.pgmPixel(Math.round(w * 0.08), Math.round(h * 0.12));
    return { corner, back };`);
  if (off.__error) console.error(off.__error);
  log(off.corner && off.corner[1] > 110 && off.corner[2] < 110,
    'turning the key OFF puts the green screen back — the key is what was removing it',
    `rgb(${(off.corner || []).slice(0, 3)})`);
  log(off.back && off.back[2] > 120, 'and turning it back on restores the studio', `rgb(${(off.back || []).slice(0, 3)})`);

  console.log('\n[6] A set nobody can see costs nothing');
  const idle = await js(win, `
    const T = window.LiveStudio.__test;
    // TWO other inputs: a cut SWAPS program and preview, so pushing one thing
    // to program would only move the set to the preview bus — where it is
    // still on screen, and still has to be rendered.
    const a = T.addColor('Black', '#000000');
    const b = T.addColor('Grey', '#404040');
    T.setPreview(a.id); T.cut();
    T.setPreview(b.id);
    await new Promise(r => setTimeout(r, 150));
    const before = T.vsetRenders(${built.vsId});
    for (let i = 0; i < 12; i++) { T.drawNow(); await new Promise(r => setTimeout(r, 16)); }
    const after = T.vsetRenders(${built.vsId});
    // put it back on preview and prove it wakes up again
    T.setPreview(${built.vsId});
    await new Promise(r => setTimeout(r, 60));
    for (let i = 0; i < 6; i++) { T.drawNow(); await new Promise(r => setTimeout(r, 16)); }
    const woke = T.vsetRenders(${built.vsId});
    return { idled: after - before, woke: woke - after };`);
  if (idle.__error) console.error(idle.__error);
  log(idle.idled === 0, 'off preview and off program, the set is not rendered at all', `${idle.idled} frames while hidden`);
  log(idle.woke > 0, 'and it starts again the moment it is put back on the preview', `${idle.woke} frames`);

  /* Everything above drove the engine directly. An operator drives the DIALOG,
   * so the dialog has to be exercised too — this is the path that actually
   * ships. */
  console.log('\n[7] Adding one the way an operator does: Add Input → Virtual Set');
  const ui = await js(win, `
    const T = window.LiveStudio.__test;
    T.closeAllInputs();
    T.addGreenScreen('Cam');
    document.getElementById('vmxAddInput').click();
    await new Promise(r => setTimeout(r, 80));
    document.querySelector('.vmx-is-cat[data-cat="vset"]').click();
    await new Promise(r => setTimeout(r, 200));
    const box = document.getElementById('vmxModalBox');
    const hasCanvas = !!box.querySelector('#vmxVsPrev');
    const shots = box.querySelectorAll('.vmx-vs-shot').length;
    const hasKey = !!box.querySelector('#vmxVsKeyCol') && !!box.querySelector('#vmxVsTol');
    const okOn = !document.getElementById('vmxIsOk').disabled;
    // choose the scene through the Browse button (stubbed to the blue studio)
    box.querySelector('#vmxVsBgPick').click();
    await new Promise(r => setTimeout(r, 400));
    const bgSet = box.querySelector('#vmxVsBg').value;
    // frame the third shot, then add it
    box.querySelectorAll('.vmx-vs-shot')[2].click();
    await new Promise(r => setTimeout(r, 100));
    const nBefore = T.state().inputs.length;
    document.getElementById('vmxIsOk').click();
    await new Promise(r => setTimeout(r, 900));
    const s = T.state();
    const made = s.inputs[s.inputs.length - 1];
    return { hasCanvas, shots, hasKey, okOn, bgSet: !!bgSet, nBefore, nAfter: s.inputs.length, type: made && made.type };`);
  if (ui.__error) console.error(ui.__error);
  log(ui.hasCanvas, 'the page shows a live preview of the set being built');
  log(ui.shots === 4, 'with the four camera shots to set up', String(ui.shots));
  log(ui.hasKey, 'and the green-screen controls (colour, amount, softness, spill)');
  log(ui.okOn, 'OK is available once there is a camera to put in the set');
  log(ui.bgSet, 'Browse chooses the studio background');
  log(ui.nAfter === ui.nBefore + 1 && ui.type === 'vset', 'and OK adds the virtual set to the switcher',
    `${ui.nBefore} → ${ui.nAfter}, type ${ui.type}`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n============  VIRTUAL SET ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
