'use strict';
/*
 * ONE RASTERISER, THREE PAGES.
 *
 * Flyers, the "add text anywhere" overlays and the WYSIWYG caption track are
 * all the same trick: styled HTML painted into a canvas through an SVG
 * <foreignObject>, so what the export contains is what the preview showed —
 * not a screen-grab, and crisp at any size, even larger than the monitor.
 *
 * It lived in renderer.js until the Video Studio also had to run in a browser
 * that never loads renderer.js (the Cloud Studio). Copying forty lines would
 * have been the cheap move and the wrong one: the whole claim of the caption
 * engine is that the preview IS the export, and a second copy of the thing
 * that draws them is exactly how that stops being true. So it lives here, and
 * both pages load this file.
 */

/**
 * Rasterize a flyer to PNG bytes WITHOUT a screen-capture, so the output is
 * exact and crisp at any size (even larger than the monitor). We wrap the
 * styled HTML in an SVG <foreignObject> and paint it onto a canvas.
 */
async function rasterizeToCanvas(css, body, w, h, opts) {
  const transparent = !!(opts && opts.transparent);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;margin:0;overflow:hidden;">` +
    `<style>${css}</style>${body}</div>` +
    `</foreignObject></svg>`;
  /*
   * ►► EVERY PICTURE IS LET GO OF THE MOMENT IT IS DRAWN. ◄◄
   * A captioned short is hundreds of these, each carrying its font. As data:
   * URLs an iPhone's Safari kept every one of them — fourteen shorts in a row
   * and the page was killed (the white screen). A blob URL can be revoked, and
   * the image is emptied once drawn, so each one is freed straight away. A
   * browser that would refuse to read back a blob-drawn picture is found out
   * once, on a scratch canvas, and keeps the old way.
   */
  const load = async (useBlob) => {
    let blobUrl = null;
    if (useBlob) blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    const img = new Image();
    try {
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = () => rej(new Error('Flyer layout could not be rendered.'));
        img.src = blobUrl || ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
      });
    } catch (e) { release(img, blobUrl); throw e; }
    return { img, blobUrl };
  };
  const release = (img, blobUrl) => {
    img.onload = img.onerror = null;
    try { img.removeAttribute('src'); } catch (e) {}
    if (blobUrl) { try { URL.revokeObjectURL(blobUrl); } catch (e) {} }
  };
  // Once per page, on a scratch canvas (a canvas once tainted stays tainted, and
  // the caller's must never be): can a blob-drawn picture be read back?
  if (rasterizeToCanvas.blobOk == null) {
    try {
      const t = await load(true);
      const probe = document.createElement('canvas'); probe.width = 2; probe.height = 2;
      const pc = probe.getContext('2d');
      pc.drawImage(t.img, 0, 0, 2, 2);
      release(t.img, t.blobUrl);
      pc.getImageData(0, 0, 1, 1);
      rasterizeToCanvas.blobOk = true;
    } catch (e) { rasterizeToCanvas.blobOk = false; }
  }
  let got;
  try { got = await load(rasterizeToCanvas.blobOk === true); }
  catch (e) { if (rasterizeToCanvas.blobOk !== true) throw e; got = await load(false); }

  const canvas = (opts && opts.canvas) || document.createElement('canvas');
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const cx = canvas.getContext('2d');
  try {
    cx.clearRect(0, 0, w, h);
    // Flyers paint on white; video text overlays must stay TRANSPARENT so ffmpeg
    // can composite them straight onto the picture.
    if (!transparent) { cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, w, h); }
    cx.drawImage(got.img, 0, 0, w, h);
  } finally { release(got.img, got.blobUrl); }
  return canvas;
}
/** A canvas as PNG bytes, ready to hand to the main process. */
async function canvasToPngBytes(canvas) {
  const blob = await new Promise((res, rej) => {
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the image.'))), 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}
async function flyerToPngBytes(css, body, w, h, opts) {
  return canvasToPngBytes(await rasterizeToCanvas(css, body, w, h, opts));
}
// Exposed for the flyer editor (editor.js) and the automated smoke test.
window.rasterizeFlyer = flyerToPngBytes;
// …and for the caption track, which rasterises hundreds of frames and needs the
// canvas itself (to scale/fade one already-drawn caption instead of re-laying it
// out for every frame of its arrival).
window.rasterizeToCanvas = rasterizeToCanvas;
window.canvasToPngBytes = canvasToPngBytes;
