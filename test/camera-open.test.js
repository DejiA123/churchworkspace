'use strict';
/*
 * "THE OPENING CAMERA TAKES TOO LONG."
 *
 * It did, and the reason was not this app. Measured on a real camera here:
 * the FIRST getUserMedia of a session takes about five seconds, and every one
 * after it takes about six hundred milliseconds — same camera, same request.
 * It is Chromium starting its video capture service, which on a media machine
 * has a row of virtual cameras to walk (vMix, OBS, NDI, XSplit, phone-as-
 * webcam) before it answers. Asking for a smaller picture does not help: 640x360,
 * 720p and 1080p all land in the same place once the stack is up.
 *
 * So the cost is moved rather than removed. warmCapture() pays it when the
 * operator reaches for ＋ Add Source, before the dialog is open, using the
 * smallest stream it can and stopping it at once.
 *
 * This test proves the thing that matters: after warming, opening a camera is
 * quick. It needs a real camera and is skipped without one.
 *
 *   npm run test:camera-open
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'mw-camera-open');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
app.setPath('userData', path.join(WORK, 'profile'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (n) => Math.round(n) + ' ms';

const ok = (data) => ({ ok: true, data });
ipcMain.handle('settings:get', () => ok({ brand: {}, accounts: {}, apiKeys: {}, live: {} }));
ipcMain.handle('paths:get', () => ok({ outputDir: WORK, userData: WORK, ffmpeg: '', ffprobe: '', fontsDir: WORK }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('live:metrics', () => ok({ cpu: 10, appCpu: 5 }));
for (const ch of ['scheduler:list', 'accounts:list', 'fonts:data', 'photos:list', 'bible:installed',
  'bible:catalogue', 'bible:books', 'live:screenSources', 'bgvideo:installed', 'bgvideo:list',
  'captions:models', 'present:outputs', 'present:displays', 'ndi:list']) ipcMain.handle(ch, () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('captions:engineInfo', () => ok({ available: false }));
ipcMain.handle('library:list', () => ok({ music: [], clips: [] }));
ipcMain.handle('youtube:status', () => ok({ available: false }));
ipcMain.handle('live:destinations', () => ok({ destinations: {}, qualities: {}, qualityGroups: [] }));
ipcMain.handle('live:engine', () => ok({ label: 'test', gpu: false }));
ipcMain.handle('rec:formats', () => ok({ formats: [], current: 'aac' }));
ipcMain.handle('present:library', () => ok({ presentations: [], playlists: [], themes: [] }));
ipcMain.handle('present:state', () => ok(null));
ipcMain.handle('present:savePresentation', () => ok(true));
for (const ch of ['webout:state', 'ndiout:state', 'ndi:status', 'dmx:state', 'phone:state'])
  ipcMain.handle(ch, () => ok({ running: false, available: false, feeds: [] }));
ipcMain.handle('video:thumbnail', () => ({ ok: false }));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, show: true,
    webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
  await sleep(1500);
  const js = (c) => win.webContents.executeJavaScript(
    `(async()=>{try{return await (async()=>{${c}})()}catch(e){return{__error:String(e&&e.name||'')+': '+String(e&&e.message||e)}}})()`);

  await js(`document.querySelector('.nav-item[data-view="live"]').click(); await new Promise(r=>setTimeout(r,600)); return 1;`);

  /* A camera that is free to open. Virtual cameras owned by another app report
   * "Device in use", which says nothing about speed. */
  const found = await js(`
    const d = await navigator.mediaDevices.enumerateDevices();
    const cams = d.filter(x => x.kind === 'videoinput');
    return { n: cams.length, labels: cams.map(c => c.label || '(unlabelled)') };`);
  if (found.__error || !found.n) {
    console.log('  SKIP — no camera on this machine.');
    win.destroy(); app.exit(0); return;
  }
  console.log(`  ${found.n} video inputs registered: ${found.labels.slice(0, 4).join(', ')}${found.n > 4 ? ' …' : ''}`);
  check('the studio can see the machine\'s cameras', found.n > 0, `${found.n} inputs`);

  /* Warm and then open the SAME device. Warming one camera pays the service's
   * start-up but not another device's, so picking a camera that is free — the
   * built-in one, rather than a virtual camera another app already owns — is
   * what makes this measure anything. */
  const target = await js(`
    const d = await navigator.mediaDevices.enumerateDevices();
    const c = d.filter(x => x.kind === 'videoinput');
    const pick = c.find(x => /integrated|usb|webcam/i.test(x.label || '')) || c[0] || {};
    window.__camId = pick.deviceId || null;
    return pick.label || null;`);
  console.log(`  warming and opening: ${target || '(first available)'}`);

  /* The warm-up is what the operator triggers by reaching for the button. */
  const warm = await js(`
    const T = window.LiveStudio.__test;
    const before = T.captureWarmed();
    const t0 = performance.now();
    await T.warmCapture(window.__camId);
    return { took: performance.now() - t0, before, after: T.captureWarmed() };`);
  if (warm.__error) { check('warming the capture stack', false, warm.__error); }
  else {
    console.log(`  warming the capture stack took ${ms(warm.took)} (was warm already: ${warm.before})`);
    check('reaching for ＋ Add Source warms the capture stack', warm.after === true,
      `warmed in ${ms(warm.took)}`);
  }

  /* Now the thing the operator actually waits for. */
  const open = await js(`
    const d = await navigator.mediaDevices.enumerateDevices();
    const cams = d.filter(x => x.kind === 'videoinput');
    const out = [];
    const target = cams.filter(c => c.deviceId === window.__camId).concat(cams);
    for (const c of target.slice(0, 6)) {
      const t0 = performance.now();
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: c.deviceId } } });
        const took = performance.now() - t0;
        s.getTracks().forEach(t => t.stop());
        out.push({ label: c.label || '(unlabelled)', took: Math.round(took) });
        break;                       // one that actually opens is all we need
      } catch (e) {
        out.push({ label: c.label || '(unlabelled)', err: String(e.name) });
      }
    }
    return out;`);
  if (open.__error) { check('opening a camera', false, open.__error); }
  else {
    const opened = open.find((o) => o.took != null);
    for (const o of open) console.log(`    ${o.label}: ${o.took != null ? ms(o.took) : o.err}`);
    if (!opened) {
      console.log('  SKIP — every camera on this machine is in use by another app.');
    } else {
      /*
       * WHAT THIS CAN AND CANNOT CLAIM.
       *
       * There are two costs and the app only controls where one of them is
       * paid. Chromium's capture service coming up is the big one (measured
       * 4.2-5.2 s here) and warmCapture now absorbs it before the dialog opens.
       * Acquiring the device itself still costs whatever that camera costs —
       * 0.6 s on a good run, 2.3 s on a loaded machine — and no amount of
       * application code makes a webcam enumerate its formats faster.
       *
       * So the check is relative, and self-calibrating: the operator's open
       * must be meaningfully cheaper than the cold start that preceded it. A
       * regression that put the service start-up back on the operator's wait
       * would make these two numbers converge, and that is what fails here.
       */
      const warmCost = (warm && warm.took) || 0;
      console.log(`    cold start absorbed by the warm-up: ${ms(warmCost)} · operator's open: ${ms(opened.took)}`);
      check('warming absorbs the cold start, so the operator does not wait for it',
        warmCost > 0 && opened.took < warmCost * 0.75,
        `${ms(warmCost)} paid up front, then ${ms(opened.took)}`);
      check('and the camera is on screen in under three seconds',
        opened.took < 3000, `${opened.label} opened in ${ms(opened.took)}`);
    }
  }

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  win.destroy();
  app.exit(fail ? 1 : 0);
});
