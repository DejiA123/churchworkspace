'use strict';
/*
 * "WE CAN'T PLAY THE AUDIO … IT'S ENCODED IN MP4A FORMAT WHICH ISN'T SUPPORTED."
 *
 * A real service was recorded and Windows' own player refused the SOUND while
 * happily showing the picture. The existing recording test could not have caught
 * it: it built its feed with ffmpeg's AAC encoder and then asked CHROMIUM
 * whether the file played. Neither half matches what the church actually has —
 * the sound in a real recording comes from the renderer's WebCodecs AAC encoder
 * by way of the program hub, and the machine that has to open the file uses
 * Media Foundation, which is far stricter than Chromium.
 *
 * So this test records for real — the real capture, the real hub, the real
 * Record button — and then asks WINDOWS to play the result.
 *
 *   npx electron test/rec-windows-playback.test.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const { ProgramHub, QUALITIES, recFormat, REC_FORMATS } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');
const { mfDecodesAudio, audioSpecificConfig } = require('./helpers/mf-play');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-recwin-'));

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
/**
 * Decode the audio to raw PCM and measure it — a track that exists but is
 * silent is still a broken recording. astats reports at `info`, so the log
 * level has to allow it; asking at `-v error` returns nothing and reads as a
 * decode failure that never happened.
 */
async function audioRms(file) {
  const r = await run(FF, ['-v', 'info', '-i', file, '-map', '0:a:0', '-af', 'astats=metadata=1:reset=0', '-f', 'null', '-']);
  const all = [...r.out.matchAll(/RMS level dB:\s*(-?[\d.]+|-inf)/gi)].map((m) => m[1]);
  if (!all.length) return null;
  const vals = all.map((v) => (v === '-inf' ? -Infinity : parseFloat(v)));
  return Math.max(...vals);
}

/* ---- IPC stubs (mirror main.js; the recorder engine is REAL) ---- */
let savedSettings = {
  brand: { churchName: 'Grace Chapel' }, accounts: {}, apiKeys: {},
  live: { dest: 'facebook', key: '', customUrl: '', quality: '720p' }, liveEncoder: 'auto',
};
ipcMain.handle('settings:get', () => ok(savedSettings));
ipcMain.handle('settings:update', (e, { patch }) => { savedSettings = { ...savedSettings, ...patch }; return ok(savedSettings); });
ipcMain.handle('paths:get', () => ok({ outputDir: tmp, userData: tmp, ffmpeg: FF, ffprobe: FP }));
ipcMain.handle('video:presets', () => ok({}));
ipcMain.handle('scheduler:list', () => ok([]));
ipcMain.handle('captions:fonts', () => ok(['Arial']));
ipcMain.handle('captions:available', () => ok(true));
ipcMain.handle('fonts:data', () => ok([]));
ipcMain.handle('photos:list', () => ok([]));
ipcMain.handle('live:metrics', () => ok({ cpu: 0 }));
ipcMain.handle('live:screenSources', () => ok([]));
ipcMain.handle('rec:formats', () => ok({ formats: REC_FORMATS.map((f) => ({ id: f.id, ext: f.ext, label: f.label, hint: f.hint })), current: 'aac' }));

const ctx = { ffmpeg: FF, ffprobe: FP };
const hub = new ProgramHub();
const hubRecFiles = new Map();

function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    try { if (!sender.isDestroyed()) sender.send('rec:' + type, { recId: id, file: hubRecFiles.get(id), ...payload }); } catch (er) {}
    if (type === 'ended') hubRecFiles.delete(id);
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') { try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {} }
  };
}

ipcMain.handle('program:session', wrap(async (e, { sid, width, height, videoKbps, audioKbps, fps, format }) => {
  wireHub(e.sender);
  const res = await hub.session(ctx, { sid, width, height, videoKbps, audioKbps, fps, format, encoder: 'auto' });
  return { ...res, sid };
}));
ipcMain.on('live:chunk', (e, payload) => {
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(payload && payload.sid, Buffer.from(raw)); } catch (er) {}
});
ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps, audioFormat }) => {
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const fmt = recFormat(audioFormat || 'aac');
  const file = path.join(tmp, `${String(name || 'recording').replace(/[^\w.-]+/g, '_')}-${Date.now()}${fmt.ext}`);
  wireHub(e.sender);
  hubRecFiles.set(recId, file);
  hub.addOutput(ctx, recId, { kind: 'file', filePath: file, q, fps: q.fps || fps, recFormat: fmt.id });
  return { file, audioFormat: fmt.id };
}));
ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  await hub.removeOutput(recId);
  hubRecFiles.delete(recId);
  if (!hub.outputCount) await hub.stop();
  return true;
}));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

async function js(win, code) {
  return win.webContents.executeJavaScript(
    `(async () => { try { return await (async () => { ${code} })(); } catch (e) { return { __error: (e && e.message || String(e)) + '\\n' + (e && e.stack || '') }; } })()`);
}
const T = 'window.LiveStudio.__test';

app.whenReady().then(async () => {
  console.log('== RECORDING PLAYS ON WINDOWS ==');
  console.log('workdir: ' + tmp);

  const win = new BrowserWindow({
    show: true, width: 1400, height: 900,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await sleep(1200);

  /* ---- a real take: a source with real sound, cut to program, recorded ---- */
  console.log('\n[1] Recording a real take through the real capture + hub');
  let r = await js(win, `
    document.querySelector('.nav-item[data-view="live"]').click();
    await new Promise((s) => setTimeout(s, 300));
    const a = ${T}.addSynthetic('Camera 1', 200);   // animated picture + 440Hz tone
    ${T}.setPreview(a.id); ${T}.cut();
    // Wait for the board to be genuinely drawing before pressing Record. An
    // operator never records a board that has not started; doing it here makes
    // the take reliably contain a picture instead of occasionally probing as
    // audio-only, which is a property of the harness, not of the recorder.
    for (let i = 0; i < 60; i++) {
      if (${T}.state().fps > 0) break;
      await new Promise((s) => setTimeout(s, 100));
    }
    await new Promise((s) => setTimeout(s, 1200));
    document.getElementById('vmxRecord').click();
    await new Promise((s) => setTimeout(s, 12000));
    const st = ${T}.state();
    document.getElementById('vmxRecord').click();
    await new Promise((s) => setTimeout(s, 2500));
    return { file: st.recFile, captureMode: st.captureMode, chunks: st.recChunksSent, encoderLabel: st.encoderLabel };
  `);
  if (r.__error) { console.error(r.__error); app.exit(1); return; }
  const file = r.file;
  log(!!file && fs.existsSync(file), 'a recording was written', file ? path.basename(file) + ' · ' + Math.round(fs.statSync(file).size / 1024) + ' KB' : 'none');
  console.log(`       capture=${r.captureMode} encoder=${r.encoderLabel}`);
  if (!file || !fs.existsSync(file)) { app.exit(1); return; }

  /* ---- what is actually in it ---- */
  console.log('\n[2] What the file contains');
  const info = await probe(file);
  const v = (info.streams || []).find((s) => s.codec_type === 'video') || {};
  const a = (info.streams || []).find((s) => s.codec_type === 'audio') || {};
  log(v.codec_name === 'h264', 'video is H.264', v.codec_name);
  log(a.codec_name === 'aac', 'audio is AAC', `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch tag=${a.codec_tag_string}`);
  const rms = await audioRms(file);
  log(rms != null && rms > -50, 'the recording actually has sound in it (not a silent track)', rms == null ? 'unreadable' : rms.toFixed(1) + ' dB RMS');

  /* ---- the structural cause, named ---- */
  console.log('\n[3] The audio track carries its own decoder config');
  const asc = audioSpecificConfig(file);
  log(asc.present, 'the mp4a sample entry has an AudioSpecificConfig in its esds — without it Windows cannot build a decoder',
    asc.present ? 'ASC=' + asc.hex : asc.note);
  log(asc.present && asc.objectType === 2, 'and it declares AAC-LC', 'audioObjectType=' + asc.objectType);
  log(asc.present && asc.sampleRate === Number(a.sample_rate), 'and a sample rate that matches the track', asc.sampleRate + ' Hz');
  log(asc.present && asc.channels === Number(a.channels), 'and the right channel count', asc.channels + ' ch');

  /* ---- the question the user actually asked ---- */
  console.log('\n[4] Does WINDOWS decode the sound? (Media Foundation — what Media Player / Films & TV use)');
  const mf = mfDecodesAudio(file);
  log(mf.ok, 'Windows builds an audio decoder and gets real PCM out of the recording', mf.raw);

  win.destroy();
  console.log('\n' + (failed ? '======  RECORDING PLAYBACK FAILED  ======' : '======  RECORDING PLAYS ON WINDOWS  ======'));
  app.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
