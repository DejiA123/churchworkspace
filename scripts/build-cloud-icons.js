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

/** Signed distance to a triangle: the largest of its three edge half-planes. */
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

/**
 * Draw the icon: a cross, and under it the play triangle that says this is the
 * video side of the app, on the app's own blue-into-warm gradient.
 */
function draw(size, { maskable } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  // A maskable icon is cropped by the launcher, so the art lives in the middle
  // 64% and the colour runs all the way to the edge. A square one keeps its own
  // rounded corners instead, because iOS will not add them.
  const pad = maskable ? size * 0.18 : size * 0.055;
  const inner = size - pad * 2;
  const radius = maskable ? 0 : size * 0.225;

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

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = maskable ? -1 : sdRoundRect(px, py, c, c, c, c, radius);
      const a = clamp01(0.5 - d);
      if (a <= 0) continue;
      const t = clamp01((px / size) * 0.55 + (py / size) * 0.45);
      put(x, y, Math.round(lerp(79, 255, t)), Math.round(lerp(124, 122, t)), Math.round(lerp(255, 89, t)), a);
    }
  }

  // The cross: an upright arm and a shorter cross-arm, both in the top two
  // thirds so the play mark has somewhere to sit.
  const armW = inner * 0.16;
  const vTop = pad + inner * 0.08, vBot = pad + inner * 0.68;
  const hTop = pad + inner * 0.26;
  const hHalf = inner * 0.235;
  const vcy = (vTop + vBot) / 2, vhh = (vBot - vTop) / 2;
  const hcy = hTop + armW / 2;

  // Play triangle, pointing right, under the cross.
  const tTop = pad + inner * 0.745, tBot = pad + inner * 0.945;
  const tL = c - inner * 0.085, tR = c + inner * 0.135;
  const tri = [[tL, tTop], [tR, (tTop + tBot) / 2], [tL, tBot]];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5, py = y + 0.5;
      const d = Math.min(
        sdBox(px, py, c, vcy, armW / 2, vhh),
        sdBox(px, py, c, hcy, hHalf, armW / 2),
        sdTriangle(px, py, tri[0], tri[1], tri[2]),
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
  ];
  for (const [n, b] of made) console.log(`  ${n}  ${(b / 1024).toFixed(1)} KB`);
  console.log('Cloud Studio icons written to ' + OUT);
}

if (require.main === module) main();
module.exports = { encodePng, draw };
