'use strict';
// Tests whether the in-app <video> can actually PLAY a given file.
const { app, BrowserWindow } = require('electron');
const path = require('path');

const input = process.argv[2];
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { contextIsolation: true } });
  await win.loadURL('data:text/html,<body style="margin:0;background:%23000"><video id=v></video></body>');
  const url = 'file:///' + encodeURI(input.replace(/\\/g, '/'));
  const res = await win.webContents.executeJavaScript(`(async () => {
    const v = document.getElementById('v');
    v.muted = true; v.src = ${JSON.stringify(url)};
    const out = { events: [], error: null, videoWidth: 0, readyState: 0, canPlayType_hevc: v.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'), canPlayType_h264: v.canPlayType('video/mp4; codecs="avc1.42E01E"') };
    await new Promise((resolve) => {
      const done = () => resolve();
      v.addEventListener('loadeddata', () => { out.events.push('loadeddata'); out.videoWidth = v.videoWidth; out.readyState = v.readyState; });
      v.addEventListener('error', () => { out.error = (v.error && v.error.code) + ':' + (v.error && v.error.message); out.events.push('error'); done(); });
      v.addEventListener('canplay', async () => {
        out.events.push('canplay'); out.videoWidth = v.videoWidth;
        try { await v.play(); await new Promise(r => setTimeout(r, 600)); out.playedTo = v.currentTime; } catch (e) { out.playError = e.message; }
        done();
      });
      setTimeout(() => { out.timedOut = true; out.videoWidth = v.videoWidth; done(); }, 6000);
    });
    return out;
  })()`);
  console.log(JSON.stringify(res, null, 2));
  const canPlay = res.videoWidth > 0 && (res.playedTo > 0.05 || res.readyState >= 2) && !res.error;
  console.log('\nCAN PLAY IN APP: ' + (canPlay ? 'YES' : 'NO'));
  win.destroy();
  app.exit(canPlay ? 0 : 2);
}).catch((e) => { console.error(e); app.exit(1); });
