'use strict';
// Generates build/icon.ico (a white cross on a purple rounded square) using the
// bundled ffmpeg to rasterize, then wraps the PNG into an .ico container.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const png = path.join(buildDir, 'icon.png');
const ico = path.join(buildDir, 'icon.ico');

// 256x256 brand square with a clean cross.
const vf = [
  'color=c=0x6d28d9:s=256x256',
].join('');
const args = [
  '-f', 'lavfi', '-i', 'color=c=0x6d28d9:s=256x256:d=1',
  '-vf', 'drawbox=x=110:y=44:w=36:h=168:color=white:t=fill,drawbox=x=74:y=96:w=108:h=36:color=white:t=fill',
  '-frames:v', '1', '-y', png,
];
const r = spawnSync(ffmpeg, args, { encoding: 'utf-8' });
if (r.status !== 0) { console.error(r.stderr); process.exit(1); }

// Wrap the PNG into a single-image .ico (Vista+ allows PNG-compressed entries).
const pngBuf = fs.readFileSync(png);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);  // width 0 => 256
entry.writeUInt8(0, 1);  // height 0 => 256
entry.writeUInt8(0, 2);  // palette
entry.writeUInt8(0, 3);  // reserved
entry.writeUInt16LE(1, 4);  // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(pngBuf.length, 8); // size
entry.writeUInt32LE(6 + 16, 12);       // offset
fs.writeFileSync(ico, Buffer.concat([header, entry, pngBuf]));
console.log('Wrote ' + ico + ' (' + (pngBuf.length + 22) + ' bytes)');
