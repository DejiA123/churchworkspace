'use strict';
/*
 * GO LIVE — HARD-SELECTING A CAMERA FRAME RATE.
 *
 * Runs the REAL Add Input dialog against Chromium's fake camera, which is
 * deliberately started with a LOW reported rate (20 fps) — the exact situation
 * that used to hide every other rate from the list ("only the detected one is
 * available"). Proves:
 *   - every standard rate is offered anyway (they are only flagged, not hidden),
 *   - choosing one applies an EXACT constraint (a lock, not a hint),
 *   - a rate the camera really can do is delivered and reported as locked,
 *   - a rate it cannot do falls back honestly and SAYS SO instead of silently
 *     running at a different rate,
 *   - the choice survives into the added input.
 *
 * Run: npx electron test/camera-fps.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

// A fake webcam that reports 20 fps — under-reporting hardware, on purpose.
app.commandLine.appendSwitch('use-fake-device-for-media-stream', 'fps=20');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.disableHardwareAcceleration();

const ok = (data) => ({ ok: true, data });
const tmp = os.tmpdir();
let saved = { brand: {}, accounts: {}, apiKeys: {}, live: { quality: '720p30', fpsMode: 'auto' } };
ipcMain.handle('settings:get', () => ok(saved));
ipcMain.handle('settings:update', (e, { patch }) => { saved = { ...saved, ...patch }; return ok(saved); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(false));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('ndi:status', () => ok({ available: false, error: 'not needed for this test' }));
ipcMain.handle('ndi:sources', () => ok([]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1500, height: 950,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false } });
  win.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(true));
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1600);

  const js = (code) => win.webContents.executeJavaScript(code);

  // open Go Live, then the real Add Input dialog on the Camera category
  await js(`(() => {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-live').classList.add('active');
    window.LiveStudio.onShow();
    document.getElementById('vmxAddInput').click();
    return true;
  })()`);
  await sleep(400);
  await js(`(() => { const r = [...document.querySelectorAll('.vmx-is-cat')].find(c => /camera/i.test(c.textContent)); r.click(); return true; })()`);
  // camera opening + preview
  let panel = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    panel = await js(`window.LiveStudio.__test.camPanel()`);
    if (panel && panel.settings && panel.settings.width) break;
  }
  check(!!(panel && panel.settings && panel.settings.width), 'fake camera opened in the dialog',
    panel && panel.settings ? `${panel.settings.width}x${panel.settings.height} @ ${panel.settings.frameRate} fps` : 'no preview');
  const reportedMax = panel && panel.caps && panel.caps.frameRate ? panel.caps.frameRate.max : null;
  console.log(`  camera reports frameRate max = ${reportedMax}`);

  // ---- 1) every standard rate is offered, not just the reported ones ----
  const opts = await js(`(() => {
    const s = document.getElementById('vmxIsCamFps');
    return [...s.options].map(o => ({ v: o.value, t: o.textContent, dis: o.disabled }));
  })()`);
  const values = opts.map((o) => o.v);
  const wanted = ['24', '25', '30', '50', '60', '120'];
  const missing = wanted.filter((w) => !values.includes(w));
  check(missing.length === 0, 'every standard frame rate is selectable (not filtered to what the camera reports)',
    `${opts.length} options; missing: ${missing.length ? missing.join(',') : 'none'}`);
  check(opts.every((o) => !o.dis), 'none of them are disabled — any rate can be forced');
  const above = opts.find((o) => o.v === '60');
  check(!!above && /not reported/i.test(above.t), 'rates the camera did not report are flagged, not hidden', above ? above.t : '');

  // ---- 2) a rate the camera CAN do is applied EXACTLY ----
  const pick = async (v) => {
    await js(`(() => { const s = document.getElementById('vmxIsCamFps'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(1400);
    return js(`(() => Object.assign(window.LiveStudio.__test.camPanel(), {
      actual: (document.querySelector('.vmx-is-camactual')||{}).textContent || '',
      warn: (document.querySelector('.vmx-is-camwarn')||{}).textContent || '' }))()`);
  };
  const at20 = await pick('20');
  check(at20.constraints && at20.constraints.frameRate && at20.constraints.frameRate.exact === 20,
    'choosing a rate applies an EXACT constraint (a lock, not a hint)', JSON.stringify(at20.constraints && at20.constraints.frameRate));
  check(!!at20.settings && Math.abs(at20.settings.frameRate - 20) < 0.6, 'the camera really delivers the chosen rate', at20.settings.frameRate + ' fps');
  check(/locked at 20 fps/.test(at20.actual), 'the dialog confirms the rate is locked', at20.actual.trim());
  check(!at20.warn, 'no warning when the rate really took');

  // ---- 3) a rate it CANNOT do is reported honestly ----
  const at60 = await pick('60');
  const got60 = at60.settings ? at60.settings.frameRate : 0;
  if (Math.abs(got60 - 60) < 0.6) {
    check(/locked at 60 fps/.test(at60.actual), 'this camera accepted 60 fps — reported as locked', at60.actual.trim());
  } else {
    check(/would not run at 60 fps/.test(at60.warn), 'a refused rate is stated plainly instead of silently ignored', at60.warn.trim());
    check(new RegExp(`@ ${Math.round(got60 * 100) / 100} fps`).test(at60.actual), 'and the panel shows what the camera IS delivering', at60.actual.trim());
  }

  // ---- 4) the choice survives into the added input ----
  await pick('20');
  await js(`(() => { document.getElementById('vmxIsOk').click(); return true; })()`);
  await sleep(1800);
  const state = await js(`window.LiveStudio.__test.state()`);
  const cam = state.inputs.find((i) => i.type === 'camera');
  check(!!cam, 'the camera was added as an input', cam ? cam.name : 'none');
  const live = cam ? await js(`window.LiveStudio.__test.inputFps(${cam.id})`) : null;
  check(!!live && live.cfg && String(live.cfg.fps) === '20', 'the chosen rate is stored on the input (and saved in presets)', live ? JSON.stringify(live.cfg) : '');
  check(!!live && live.fps && Math.abs(live.fps - 20) < 0.6, 'the ADDED input really runs at the chosen rate', live ? live.fps + ' fps' : '');
  // A locked rate must drive the WHOLE chain unsnapped — not get rounded to a
  // "standard" rate nothing on the mix is producing.
  const prod = await js(`window.LiveStudio.__test.productionFps()`);
  check(Math.abs(prod - 20) < 0.6, 'the locked rate drives the production/encode rate exactly', prod + ' fps');

  console.log(`\n==== camera frame rate: ${pass} PASS / ${fail} FAIL ====`);
  win.destroy();
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error('FATAL ' + e.message + '\n' + e.stack); app.exit(1); });
