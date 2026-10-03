'use strict';
/*
 * The Cloud Studio's home-screen icons.
 *
 * A PWA is only installable if it can show the person an icon, and this project
 * has no image library and no designer's export step — so the icons are drawn
 * here, in maths, and encoded as PNG by hand (zlib is in Node; the rest of PNG
 * is a header, a CRC and an adler sum). Run it when the mark changes:
 *
 *     npm run build:cloudicons
 *
 * Two shapes, because Android and iOS want different things: a SQUARE icon with
 * its own rounded corners for iOS, and a MASKABLE one that fills the whole
 * canvas edge to edge, which Android crops to whatever shape the launcher uses.
 * A maskable icon with rounded corners baked in gets those corners cropped off
 * twice and looks chewed.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'src', 'cloud', 'web', 'icons');

/* ------------------------------------------------------------ PNG writing */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** RGBA pixel buffer (w*h*4) -> PNG bytes. */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                       // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------- the mark */

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/*
 * Everything is drawn from SIGNED distances: negative inside the shape,
 * positive outside, zero on the edge. Coverage is then `0.5 - d` clamped, which
 * gives one pixel of anti-aliasing for free and — the part that matters — gives
 * FULL opacity everywhere inside. An unsigned distance reads 0 both on the edge
 * and deep inside, so every filled pixel comes out half strength: a cross that
 * should be white arrives pink.
 */
const sdBox = (px, py, cx, cy, hw, hh) => {
  const dx = Math.abs(px - cx) - hw;
  const dy = Math.abs(py - cy) - hh;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
};
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => sdBox(px, py, cx, cy, hw - r, hh - r) - r;

/** Signed distance to a triangle: the largest of its three edge half-planes. (No longer drawn; kept for the tests.) */
function sdTriangle(px, py, a, b, c) {
  const edge = (p, q) => {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const len = Math.hypot(ex, ey) || 1;
    // normal pointing away from the third corner is handled by the sign below
    return ((px - p[0]) * ey - (py - p[1]) * ex) / len;
  };
  const d = Math.max(edge(a, b), edge(b, c), edge(c, a));
  return d;
}

/*
 * THE MARK: a white cross on an indigo square — the church's own, taken from
 * the woven badge it sent (measured off the photograph: the cross runs from 17%
 * to 82% of the square's height, its arm sits just above the middle at 37–52%
 * and spans 31–71% of the width, and both bars are about 13% thick). Redrawn
 * clean rather than traced, so it stays sharp at every size a phone asks for.
 */
const INDIGO_TOP = [86, 88, 214];
const INDIGO_BOT = [70, 72, 190];
const CROSS = { bar: 0.13, top: 0.17, bottom: 0.82, armY: 0.445, armLeft: 0.30, armRight: 0.70, round: 0.012 };

/**
 * Draw the icon.
 *   shape 'rounded' — its own rounded corners, transparent outside (the
 *                     manifest's plain icon, for launchers that use it as is);
 *   shape 'square'  — opaque edge to edge: what an iPhone wants for its home
 *                     screen, where iOS cuts the corners itself (transparent
 *                     corners turn black there);
 *   shape 'maskable'— colour to the edges and the cross inside Android's safe
 *                     circle, because the launcher crops to its own shape.
 */
function draw(size, { maskable, shape } = {}) {
  const kind = shape || (maskable ? 'maskable' : 'rounded');
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const radius = size * 0.2237;

  const put = (x, y, rr, gg, bb, aa) => {
    if (aa <= 0) return;
    const i = (y * size + x) * 4;
    const a0 = rgba[i + 3] / 255;
    const out = aa + a0 * (1 - aa);
    if (out <= 0) return;
    rgba[i] = Math.round((rr * aa + rgba[i] * a0 * (1 - aa)) / out);
    rgba[i + 1] = Math.round((gg * aa + rgba[i + 1] * a0 * (1 - aa)) / out);
    rgba[i + 2] = Math.round((bb * aa + rgba[i + 2] * a0 * (1 - aa)) / out);
    rgba[i + 3] = Math.round(out * 255);
  };

  // the indigo field, a breath lighter at the top
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = kind === 'rounded' ? sdRoundRect(px, py, c, c, c, c, radius) : -1;
      const a = clamp01(0.5 - d);
      if (a <= 0) continue;
      const t = py / size;
      put(x, y, Math.round(lerp(INDIGO_TOP[0], INDIGO_BOT[0], t)), Math.round(lerp(INDIGO_TOP[1], INDIGO_BOT[1], t)),
        Math.round(lerp(INDIGO_TOP[2], INDIGO_BOT[2], t)), a);
    }
  }

  // the cross, scaled into the safe circle on a maskable icon
  const k = kind === 'maskable' ? 0.78 : 1;
  const midY = (CROSS.top + CROSS.bottom) / 2;
  const at = (v, mid) => (mid + (v - mid) * k) * size;
  const bar = CROSS.bar * k * size, r = CROSS.round * k * size;
  const vTop = at(CROSS.top, midY), vBot = at(CROSS.bottom, midY);
  const armY = at(CROSS.armY, midY);
  const armL = at(CROSS.armLeft, 0.5), armR = at(CROSS.armRight, 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.min(
        sdRoundRect(px, py, c, (vTop + vBot) / 2, bar / 2, (vBot - vTop) / 2, r),
        sdRoundRect(px, py, (armL + armR) / 2, armY, (armR - armL) / 2, bar / 2, r),
      );
      const a = clamp01(0.5 - d);
      if (a > 0) put(x, y, 255, 255, 255, a);
    }
  }
  return rgba;
}

/* ------------------------------------------------------------------ write */

function write(name, size, opts) {
  const png = encodePng(size, size, draw(size, opts || {}));
  fs.writeFileSync(path.join(OUT, name), png);
  return png.length;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const made = [
    ['icon-192.png', write('icon-192.png', 192, {})],
    ['icon-512.png', write('icon-512.png', 512, {})],
    ['icon-maskable-512.png', write('icon-maskable-512.png', 512, { maskable: true })],
    // the iPhone home screen: 180 x 180, opaque, iOS rounds it
    ['apple-touch-icon.png', write('apple-touch-icon.png', 180, { shape: 'square' })],
  ];
  for (const [n, b] of made) console.log(`  ${n}  ${(b / 1024).toFixed(1)} KB`);
  console.log('Cloud Studio icons written to ' + OUT);
}

if (require.main === module) main();
module.exports = { encodePng, draw };
