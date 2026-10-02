'use strict';
/*
 * "If I click Camera it stays on 'Looking for camera' a bit too long."
 *
 * It was not looking. It was OPENING a camera nobody had asked for — purely to
 * unlock the device NAMES — waiting for the driver to spin up, closing it, and
 * only then listing anything; then opening a SECOND stream for the preview
 * before the list was allowed to appear. Two camera warm-ups stood between the
 * click and the list.
 *
 * This measures the thing the complaint is about: the time from clicking the
 * category to the list of devices being ON SCREEN. The preview picture is
 * explicitly NOT part of that — it is allowed to arrive later, because a
 * camera takes as long as it takes to open and the operator does not need to
 * wait for it to choose from a list.
 *
 *   npm run test:devicespeed
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const ffmod = require('../src/main/ffmpeg');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-devspeed-'));
let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (data) => ({ ok: true, data });

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
ipcMain.handle('ppt:check', () => ok({ available: false }));

const js = (win, src) => win.webContents.executeJavaScript(`(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

app.whenReady().then(async () => {
  console.log('== ADD INPUT: HOW FAST DOES THE DEVICE LIST APPEAR? ==');
  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  // Cameras and microphones are granted without a prompt, exactly as the
  // shipping app does — otherwise this would measure a permission dialog.
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1500);

  const show = `document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
                document.getElementById('view-live').classList.add('active');
                window.LiveStudio.onShow();`;

  /* WHY THIS WAITS FIRST, and why that is not cheating.
   *
   * The first enumerateDevices() a Chromium process ever makes is slow on a
   * machine with a lot of video devices — measured on this laptop, which has
   * 14 of them: 11.5 SECONDS, and it hangs indefinitely if asked before the
   * media stack is up. Every enumeration after it costs about 100ms. Nothing
   * the app does changes that, so the fix was never to make the FIRST lookup
   * fast: it was to stop the operator ever being the one waiting for it. It
   * now runs in the background at app launch.
   *
   * So the promise under test is "by the time you click Camera, the answer is
   * already there" — which is what the complaint was actually about. */
  console.log('\n[1] The lists are found in the background, without opening any camera or microphone');
  const warm = await js(win, `${show}
    const T = window.LiveStudio.__test;
    const t0 = performance.now();
    let ms = -1;
    for (let i = 0; i < 300; i++) {
      const d = T.deviceCache();
      if (d.cams !== null && d.mics !== null) { ms = performance.now() - t0; break; }
      await new Promise(r => setTimeout(r, 100));
    }
    const d = T.deviceCache();
    return { cams: d.cams, mics: d.mics, bound: d.bound, ms };`);
  if (warm.__error) { console.error(warm.__error); app.exit(1); return; }
  console.log(`    background warm-up completed in ${warm.ms < 0 ? 'never' : (warm.ms / 1000).toFixed(1) + 's'}`);
  log(warm.cams !== null && warm.mics !== null, 'the device lists are in hand without the operator asking',
    `${warm.cams} camera(s), ${warm.mics} audio input(s)`);
  log(warm.bound, 'and a plugged-in or unplugged device will refresh them');

  /* The measurement. `render()` is what puts the list on screen, so the moment
   * the category's own state stops saying "still looking" is the moment the
   * operator sees something to choose from. */
  const timeCat = async (cat, key) => js(win, `
    const T = window.LiveStudio.__test;
    document.getElementById('vmxAddInput').click();
    await new Promise(r => setTimeout(r, 60));
    const t0 = performance.now();
    document.querySelector('.vmx-is-cat[data-cat="${cat}"]').click();
    let shown = -1;
    for (let i = 0; i < 400; i++) {
      const s = T.inputSelectState();
      if (s && s.${key} !== null) { shown = performance.now() - t0; break; }
      await new Promise(r => setTimeout(r, 5));
    }
    const s = T.inputSelectState();
    const listed = s ? s.${key} : -1;
    T.closeInputSelect();
    return { ms: shown, listed };`);

  console.log('\n[2] Clicking Camera');
  const cam = await timeCat('camera', 'cams');
  if (cam.__error) console.error(cam.__error);
  console.log(`    list on screen after ${cam.ms < 0 ? 'never' : cam.ms.toFixed(0) + ' ms'} (${cam.listed} camera(s) on this machine)`);
  log(cam.ms >= 0, 'the camera list appears at all');
  log(cam.ms >= 0 && cam.ms < 400, 'and it appears IMMEDIATELY — no waiting on a camera to warm up',
    `${cam.ms.toFixed(0)} ms`);

  console.log('\n[3] Clicking Audio Input');
  const mic = await timeCat('mic', 'mics');
  if (mic.__error) console.error(mic.__error);
  console.log(`    list on screen after ${mic.ms < 0 ? 'never' : mic.ms.toFixed(0) + ' ms'} (${mic.listed} input(s) on this machine)`);
  log(mic.ms >= 0, 'the microphone list appears at all');
  log(mic.ms >= 0 && mic.ms < 400, 'and it appears IMMEDIATELY too', `${mic.ms.toFixed(0)} ms`);

  console.log('\n[4] Opening it a second time is still instant (the cache is not thrown away)');
  const again = await timeCat('camera', 'cams');
  console.log(`    second open: ${again.ms < 0 ? 'never' : again.ms.toFixed(0) + ' ms'}`);
  log(again.ms >= 0 && again.ms < 250, 'a repeat open is instant', `${again.ms.toFixed(0)} ms`);

  console.log('\n[5] The picture still arrives — it is just no longer in the way');
  const prev = await js(win, `
    const T = window.LiveStudio.__test;
    document.getElementById('vmxAddInput').click();
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('.vmx-is-cat[data-cat="camera"]').click();
    let got = false;
    for (let i = 0; i < 200; i++) {
      const s = T.inputSelectState();
      if (s && (s.previewing || s.previewFailed)) { got = !!s.previewing; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    const s = T.inputSelectState();
    T.closeInputSelect();
    return { got, failed: s ? s.previewFailed : null, cams: s ? s.cams : 0 };`);
  if (prev.cams > 0) {
    log(prev.got || prev.failed, 'the preview is opened in the background after the list is shown',
      prev.got ? 'previewing' : 'this machine has no usable camera to preview');
  } else {
    console.log('    (no camera on this machine — nothing to preview)');
    log(true, 'no camera present, so there is nothing to preview');
  }

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n============  DEVICE PICK SPEED ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  if (!win.isDestroyed()) win.destroy();
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.stack); app.exit(1); });
