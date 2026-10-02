'use strict';
// Builds an H.264 proxy from a (possibly HEVC) input, then confirms the proxy PLAYS in Electron.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const video = require('../src/main/video');
const ctx = { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
const input = process.argv[2];

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const info = await video.getInfo(ctx, input);
  console.log('source codec:', info.vcodec, '| needsProxy:', video.needsProxy(info));
  const out = path.join(os.tmpdir(), 'mw-proxy-test.mp4');
  const t = Date.now();
  await video.makeProxy(ctx, { input, output: out });
  const pinfo = await video.getInfo(ctx, out);
  console.log('proxy:', pinfo.width + 'x' + pinfo.height, pinfo.vcodec + '/' + pinfo.acodec, Math.round((Date.now() - t) / 1000) + 's');

  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false } });
  await win.loadURL('data:text/html,<body><video id=v muted></video></body>');
  const url = 'file:///' + encodeURI(out.replace(/\\/g, '/'));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v'); v.src = ${JSON.stringify(url)};
    return await new Promise((res) => { const o = {};
      v.addEventListener('canplay', async () => { o.w = v.videoWidth; try { await v.play(); await new Promise(r=>setTimeout(r,700)); o.playedTo = v.currentTime; } catch(e){ o.playErr = e.message; } res(o); });
      v.addEventListener('error', () => { o.error = v.error && v.error.code; res(o); });
      setTimeout(() => { o.timeout = true; o.w = v.videoWidth; res(o); }, 7000);
    });
  })()`);
  console.log('playback:', JSON.stringify(res));
  const ok = res.w > 0 && res.playedTo > 0.05;
  console.log('\nPROXY PLAYS IN APP: ' + (ok ? 'YES ✓' : 'NO ✗'));
  win.destroy();
  app.exit(ok ? 0 : 2);
}).catch((e) => { console.error(e); app.exit(1); });
