'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow } = require('electron');

/**
 * Render a self-contained HTML document to a PNG (or JPEG) at an EXACT pixel
 * size by loading it in a hidden, off-screen BrowserWindow and capturing it.
 *
 * The captured image can come back scaled by the display's device-scale-factor
 * (e.g. 125%), so we normalize to the requested size with nativeImage.resize()
 * — built in, no native dependencies. The HTML is rendered from a temp file
 * (more reliable than a data: URL) and cleaned up afterwards.
 *
 * Returns { output, rawWidth, rawHeight, width, height } for diagnostics.
 */
async function renderFlyer({ html, width, height, output, format = 'png' }) {
  width = Math.round(width);
  height = Math.round(height);

  const tmpHtml = path.join(os.tmpdir(), `mw-flyer-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf-8');

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(tmpHtml);

    // Let layout, web fonts and gradients settle before capturing.
    await new Promise((r) => setTimeout(r, 500));

    let image = await win.webContents.capturePage();
    const raw = image.getSize();

    // Normalize to the exact requested dimensions.
    if (raw.width !== width || raw.height !== height) {
      image = image.resize({ width, height, quality: 'best' });
    }

    const buffer = format === 'jpeg' ? image.toJPEG(92) : image.toPNG();
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, buffer);
    return { output, rawWidth: raw.width, rawHeight: raw.height, width, height };
  } finally {
    if (!win.isDestroyed()) win.destroy();
    try { fs.unlinkSync(tmpHtml); } catch (e) {}
  }
}

module.exports = { renderFlyer };
