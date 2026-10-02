'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/*
 * What the studio builds FROM a recording to show it — the timeline's filmstrip
 * and waveform, the H.264 preview of an HEVC file — depends only on that file.
 * "Carry on" reopens the same three-hour sermon, so these are kept, keyed by
 * what the file IS (path, size, modified time), and come back instantly instead
 * of being rebuilt: 24 seeks into a 2 GB file, a decode of all of its sound, or,
 * for a phone recording, a transcode of the whole thing. A different or
 * re-saved file is a different key.
 *
 * Built under a unique .part name and renamed into place, so an interrupted
 * build is never mistaken for a finished one; the same picture asked for twice
 * at once is built once.
 */

let DIR = null;
const KEEP_DAYS = 30;
/** Point it at a folder, and clear out what has not been used for a month (a
 *  preview of a phone recording can be gigabytes) and any build that died. */
function init(dir) {
  DIR = dir;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(DIR)) {
      const full = path.join(DIR, f);
      try {
        const st = fs.statSync(full);
        if (/\.part(\.|$)/.test(f) ? now - st.mtimeMs > 6 * 3600e3 : now - st.mtimeMs > KEEP_DAYS * 86400e3) fs.rmSync(full, { force: true });
      } catch (e) {}
    }
  } catch (e) { /* no folder yet */ }
  return DIR;
}

function keyPath(input, kind, ext) {
  if (!DIR) return null;
  try {
    const st = fs.statSync(input);
    const key = crypto.createHash('sha1')
      .update([path.resolve(input).toLowerCase(), st.size, Math.round(st.mtimeMs), kind].join('|'))
      .digest('hex').slice(0, 24);
    fs.mkdirSync(DIR, { recursive: true });
    return path.join(DIR, key + ext);
  } catch (e) { return null; }
}

const building = new Map(); // dest -> promise

/**
 * The file `build(output)` would make for this recording — from the cache when
 * it has been made before. `build` is handed a path to write and must leave a
 * finished file there.
 */
async function cached(input, kind, ext, build) {
  const dest = keyPath(input, kind, ext);
  if (!dest) {
    const os = require('os');
    const output = path.join(os.tmpdir(), `mw-${String(kind).replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}${ext}`);
    await build(output);
    return output;
  }
  try {
    if (fs.statSync(dest).size > 0) {
      try { const t = new Date(); fs.utimesSync(dest, t, t); } catch (e) {} // still in use: keep it past the month
      return dest;
    }
  } catch (e) { /* not built yet */ }
  if (building.has(dest)) return building.get(dest);
  const job = (async () => {
    const part = dest.slice(0, -ext.length) + '.' + process.pid + '-' + Date.now() + '.part' + ext;
    try {
      await build(part);
      fs.renameSync(part, dest);
    } finally { try { fs.rmSync(part, { force: true }); } catch (e) {} }
    return dest;
  })();
  building.set(dest, job);
  try { return await job; } finally { building.delete(dest); }
}

/**
 * A small fact about the recording (what ffprobe says about it), kept the same
 * way: the first open after a restart is the one that pays for a cold
 * ffprobe.exe, and that is exactly the open "Carry on" makes.
 */
async function json(input, kind, compute) {
  const dest = keyPath(input, kind, '.json');
  if (dest) {
    try { const v = JSON.parse(fs.readFileSync(dest, 'utf-8')); if (v && typeof v === 'object') return v; } catch (e) { /* not kept yet */ }
  }
  const v = await compute();
  if (dest && v && typeof v === 'object') {
    try { const tmp = dest + '.' + process.pid + '.part'; fs.writeFileSync(tmp, JSON.stringify(v)); fs.renameSync(tmp, dest); } catch (e) {}
  }
  return v;
}

module.exports = { init, cached, json, keyPath };
