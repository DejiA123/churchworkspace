'use strict';
/*
 * ►► A COPY OF A VIDEO THAT AN iPHONE CAN ACTUALLY SAVE. ◄◄
 *
 * Saving from the app means handing the file to the phone's share sheet
 * (“Save Video”). Safari does not pass the share sheet a file on disk: it
 * reads the WHOLE file into the page's memory first, then copies it across.
 * A 500 MB montage is well over a gigabyte of memory doing that — iOS kills
 * the app's page (a white screen) and the share sheet opens on nothing (a
 * blank white card). Keeping the download on disk (OPFS) could not help,
 * because the share itself is what takes the memory.
 *
 * So a phone is never handed more than PART_MAX at a time. A video bigger
 * than that gets a copy made for the phone, kept beside it in `.phone/`:
 *
 *   – re-encoded to fit in ONE full-HD (1080p) file, up to ~16 minutes;
 *   – only when that cannot fit (a very long video), in parts: cut by
 *     stream copy when the video is already lean (seconds, not a pixel
 *     changed), otherwise encoded once with a key frame exactly at each cut.
 *
 * The copy is made once per video (a second tap reuses it), cleared with
 * the video, and swept after two days.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');
const machine = require('./machine');

/*
 * What one share may carry. The montages that crashed were 300-700 MB (well
 * over a gigabyte of memory once Safari had read and copied them); 95 MB parts
 * saved fine on the iPhone. 140 MB keeps a long margin from the crash and
 * lets a video of up to ~16 minutes save as ONE video, not parts.
 */
const PART_MAX = 140 * 1024 * 1024;
const KEEP_MS = 2 * 24 * 3600e3;
const AUDIO_KBPS = 128;

const dirOf = (input) => path.join(path.dirname(input), '.phone');
const baseOf = (input) => path.basename(input).replace(/\.[^.]+$/, '').slice(0, 70);
const statOf = (p) => { try { return fs.statSync(p); } catch (e) { return null; } };

/* What a manifest says, if it still describes this very file and its parts are all there. */
function cached(input, st, partMax) {
  const man = path.join(dirOf(input), baseOf(input) + '.json');
  try {
    const m = JSON.parse(fs.readFileSync(man, 'utf-8'));
    if (m.size !== st.size || m.mtime !== st.mtimeMs || m.partMax !== partMax || !Array.isArray(m.parts) || !m.parts.length) return null;
    const parts = m.parts.map((n) => path.join(dirOf(input), n));
    if (!parts.every((p) => statOf(p))) return null;
    const now = new Date();
    for (const p of [man, ...parts]) { try { fs.utimesSync(p, now, now); } catch (e) {} }
    return { parts: parts.map((p) => ({ path: p, size: statOf(p).size })), height: m.height || 0, made: m.how };
  } catch (e) { return null; }
}

/* Old copies go: they are only there to be saved, and a server's disk is small. */
function sweep(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    const st = statOf(p);
    if (st && st.isFile() && now - st.mtimeMs > KEEP_MS) { try { fs.unlinkSync(p); } catch (e) {} }
  }
}

/* Everything made for one video — gone with it (cloud-api deleteFiles). */
function removeFor(input) {
  const dir = dirOf(input), base = baseOf(input);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return 0; }
  let freed = 0;
  for (const n of names) {
    if (n !== base + '.json' && !n.startsWith(base + '.phone')) continue;
    const p = path.join(dir, n);
    const st = statOf(p);
    try { fs.unlinkSync(p); freed += st ? st.size : 0; } catch (e) {}
  }
  return freed;
}

/* The size the picture is scaled to, so its SHORT side is at most `side` (even numbers). */
function fitTo(w, h, side) {
  if (!w || !h || Math.min(w, h) <= side) return null;
  const k = side / Math.min(w, h);
  const ev = (x) => Math.max(2, Math.round((x * k) / 2) * 2);
  return [ev(w), ev(h)];
}

/*
 * The plan, from the facts alone (kept apart from ffmpeg so it can be tested):
 *   { how: 'copy'|'encode', parts, side, kbps, segSec }
 */
function plan({ size, durationSec, width, height, encode }, partMax = PART_MAX) {
  const dur = Math.max(1, durationSec || 1);
  const short = Math.min(width || 1080, height || 1920) || 1080;
  const totalKbps = (size * 8) / dur / 1000;
  const fitKbps = Math.floor(((partMax * 0.92) * 8) / dur / 1000) - AUDIO_KBPS;   // one file, a little headroom
  // one video, in full HD, is what anyone wants in Photos: re-encoded to fit (down to 1 Mbit/s — an
  // 8:46 montage came in two parts at a higher floor, and was asked for in 1080p, not 720p)
  if (fitKbps >= 1000) return { how: 'encode', parts: 1, side: Math.min(short, 1080), kbps: Math.min(fitKbps, 8000), segSec: 0 };
  // a long video already at a modest bit rate only needs cutting
  if (totalKbps <= 4500 && !encode) {
    const parts = Math.ceil(size / (partMax * 0.85));
    return { how: 'copy', parts, side: short, kbps: Math.round(totalKbps), segSec: dur / parts };
  }
  // too long for one file at any decent quality: full HD at 2.5 Mbit/s, in parts
  const kbps = 2500;
  const perPartSec = ((partMax * 0.88) * 8) / ((kbps + AUDIO_KBPS) * 1000);
  const parts = Math.ceil(dur / perPartSec);
  return { how: 'encode', parts, side: Math.min(short, 1080), kbps, segSec: dur / parts };
}

/* A copy being made, with everyone waiting on it told how far it has got —
   the one started when a montage finished, and the Save tap that joins it. */
const inflight = new Map();

/**
 * The file(s) to hand a phone for saving `input`: the video itself when it is
 * small enough, otherwise a copy made for the phone (see the top of the file).
 * Resolves to { parts: [{ path, size }], height, made }.
 */
function phoneCopy(ctx, getInfo, { input, onProgress, partMax = PART_MAX }) {
  const st = statOf(input);
  if (!st || !st.isFile()) return Promise.reject(new Error('That video is not on the studio any more.'));
  if (st.size <= partMax) return Promise.resolve({ parts: [{ path: input, size: st.size }], height: 0, made: 'none' });
  const hit = cached(input, st, partMax);
  if (hit) return Promise.resolve(hit);
  const key = path.resolve(input) + '|' + partMax;
  let run = inflight.get(key);
  if (!run) {
    const listeners = new Set();
    let last = 0;
    const tell = (q) => { last = q; for (const fn of listeners) { try { fn(q); } catch (e) {} } };
    run = { listeners, last: () => last };
    run.promise = make(ctx, getInfo, input, st, tell, partMax).finally(() => inflight.delete(key));
    inflight.set(key, run);
  }
  if (onProgress) { run.listeners.add(onProgress); if (run.last()) onProgress(run.last()); }
  return run.promise.finally(() => onProgress && run.listeners.delete(onProgress));
}

/*
 * Started the moment a montage is made, so the copy is usually ready by the
 * time Save is tapped (it takes a couple of minutes on a small server).
 * Nobody waits on this one: a failure just means Save makes it instead.
 */
function prepare(ctx, getInfo, input) {
  const st = statOf(input);
  if (!st || st.size <= PART_MAX) return;
  phoneCopy(ctx, getInfo, { input }).catch((e) => console.warn('[phonecopy]', (e && e.message) || e));
}

async function make(ctx, getInfo, input, st, onProgress, partMax) {
  const dir = dirOf(input), base = baseOf(input);
  fs.mkdirSync(dir, { recursive: true });
  sweep(dir);
  removeFor(input);
  const info = await getInfo(ctx, input);
  let p = plan({ size: st.size, durationSec: info.durationSec, width: info.width, height: info.height }, partMax);
  const tmp = path.join(dir, `${base}.tmp-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    let files = await run(ctx, input, tmp, p, info, onProgress);
    // a copy-cut that came out lopsided (key frames far apart): encode instead
    if (p.how === 'copy' && files.some((f) => statOf(f).size > partMax)) {
      for (const f of files) { try { fs.unlinkSync(f); } catch (e) {} }
      p = plan({ size: st.size, durationSec: info.durationSec, width: info.width, height: info.height, encode: true }, partMax);
      files = await run(ctx, input, tmp, p, info, onProgress);
    }
    const names = files.map((f, i) => (files.length === 1 ? `${base}.phone.mp4` : `${base}.phone-${i + 1}of${files.length}.mp4`));
    files.forEach((f, i) => fs.renameSync(f, path.join(dir, names[i])));
    const fit = fitTo(info.width, info.height, p.side);
    const height = fit ? Math.min(fit[0], fit[1]) : Math.min(info.width || 0, info.height || 0);
    fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify({ size: st.size, mtime: st.mtimeMs, partMax, parts: names, how: p.how, height }));
    onProgress(100);
    return { parts: names.map((n) => ({ path: path.join(dir, n), size: statOf(path.join(dir, n)).size })), height, made: p.how };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

async function run(ctx, input, tmp, p, info, onProgress) {
  const dur = info.durationSec || 0;
  const out = p.parts > 1 ? path.join(tmp, 'part-%03d.mp4') : path.join(tmp, 'part-000.mp4');
  const seg = p.parts > 1
    ? ['-f', 'segment', '-segment_time', p.segSec.toFixed(3), '-reset_timestamps', '1', '-segment_format', 'mp4',
      '-segment_format_options', 'movflags=+faststart']
    : ['-movflags', '+faststart'];
  let args;
  if (p.how === 'copy') {
    args = ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', ...seg, out];
  } else {
    const fit = fitTo(info.width, info.height, p.side);
    const vf = ['format=yuv420p'];
    if (fit) vf.unshift(`scale=${fit[0]}:${fit[1]}:flags=bicubic`);
    args = ['-y', '-hide_banner', '-i', input, '-map', '0:v:0', '-map', '0:a:0?', '-vf', vf.join(','),
      // full HD on few bits needs x264's better search: 'veryfast' below 2.5 Mbit/s, even on a small server
      '-c:v', 'libx264', '-preset', machine.small() && p.kbps >= 2500 ? 'superfast' : 'veryfast', '-profile:v', 'high',
      '-b:v', `${p.kbps}k`, '-maxrate', `${Math.round(p.kbps * 1.4)}k`, '-bufsize', `${p.kbps * 2}k`,
      ...(p.parts > 1 ? ['-force_key_frames', `expr:gte(t,n_forced*${p.segSec.toFixed(3)})`] : []),
      '-c:a', 'aac', '-b:a', `${AUDIO_KBPS}k`, '-ac', '2', ...seg, out];
  }
  await ff.runFfmpeg(ctx.ffmpeg, args, { onProgress: (q) => onProgress(Math.min(99, q)), totalDurationSec: dur });
  return fs.readdirSync(tmp).filter((n) => /^part-\d+\.mp4$/.test(n)).sort().map((n) => path.join(tmp, n));
}

module.exports = { phoneCopy, prepare, plan, removeFor, PART_MAX };
