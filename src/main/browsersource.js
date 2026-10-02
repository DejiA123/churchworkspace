'use strict';
const { BrowserWindow } = require('electron');

/**
 * Web Browser input engine (the vMix-style "Web Browser" / "Video Call" /
 * "PowerPoint" source) — a hidden offscreen-rendered Chromium window whose
 * painted frames are streamed to the renderer as JPEGs and drawn onto that
 * input's canvas. One instance per input; video only (see note in main.js
 * about why call audio isn't mixed in).
 */
class BrowserSource {
  constructor(id, onFrame) {
    this.id = id;
    this.destroyed = false;
    this.win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: {
        offscreen: true,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.win.webContents.setFrameRate(15);
    // Video-call rooms (Jitsi etc.) ask for camera/mic — this input exists to
    // grant that, so auto-allow media permissions for this source only.
    this.win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
      callback(permission === 'media');
    });
    this.win.webContents.on('paint', (event, dirty, image) => {
      if (this.destroyed) return;
      try {
        const { width, height } = image.getSize();
        if (!width || !height) return;
        onFrame(image.toJPEG(80), width, height);
      } catch (e) { /* a mid-teardown paint race is harmless */ }
    });
  }

  async load(url) {
    await this.win.loadURL(url);
  }

  destroy() {
    this.destroyed = true;
    try { if (!this.win.isDestroyed()) this.win.destroy(); } catch (e) {}
  }
}

module.exports = { BrowserSource };
