'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const jobs = require('./jobs');
const machine = require('./machine');

/**
 * Resolves bundled ffmpeg/ffprobe binaries, handling Electron's asar packing.
 * Falls back to a user-provided override, then to whatever is on PATH.
 */

function unpacked(p) {
  if (!p) return p;
  // When packaged, binaries live in app.asar.unpacked (see asarUnpack in package.json)
  return p.replace('app.asar' + require('path').sep, 'app.asar.unpacked' + require('path').sep)
          .replace('app.asar/', 'app.asar.unpacked/');
}

function resolveFfmpeg(override) {
  if (override && fs.existsSync(override)) return override;
  try {
    const p = unpacked(require('ffmpeg-static'));
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed */ }
  return 'ffmpeg';
}

function resolveFfprobe(override) {
  if (override && fs.existsSync(override)) return override;
  try {
    const p = unpacked(require('ffprobe-static').path);
    if (p && fs.existsSync(p)) return p;
  } catch (e) { /* not installed */ }
  return 'ffprobe';
}

/**
 * Spawn ffmpeg with the given args. Parses stderr for progress (time=...)
 * and reports a percentage when totalDurationSec is known.
 */
/*
 * AN EXPORT THAT FITS IN A SMALL SERVER.
 *
 * Measured on a 9:16 1080p short cut from a 1080p sermon: ffmpeg alone peaked
 * at 631 MB — more than a whole 512 MB instance — because inside a container
 * it sees the HOST's cores, starts a decoder thread and an encoder thread per
 * core, each holding frames, and x264's 'medium' looks 40 frames ahead at full
 * size. Same export, on a small machine (machine.small()):
 *
 *   encoder threads capped                   485 MB
 *   + decoder on one thread                  440 MB
 *   + x264 looking 10 frames ahead           240 MB   (same speed)
 *
 * The look-ahead is what x264 uses to place its bits, so a short is a little
 * larger for the same quality, never worse-looking. On a desktop nothing here
 * applies (machine.ffmpegThreads() is 0 there) and every command runs as written.
 */
function capThreads(args) {
  const n = machine.ffmpegThreads();
  if (!n || args.includes('-threads')) return args;
  const enc = args.findIndex((a, i) => (a === '-c:v' || a === '-vcodec') && /^lib(x264|x265|vpx)/.test(String(args[i + 1] || '')));
  const x264 = enc >= 0 && /^libx264/.test(String(args[enc + 1]));
  const out = [];
  /*
   * Each input decoded on one thread (an input option: it goes before its -i).
   * This is for EVERY command, not only the ones that encode: a decoder's
   * frame pool grows with its threads, and the decode-only jobs — filmstrip
   * frames, thumbnails, the waveform — are what run the moment a video opens.
   * A 4K HEVC frame grab measured 284 MB on default threads and 168 MB on one.
   */
  for (const a of args.slice(0, -1)) { if (a === '-i') out.push('-threads', '1'); out.push(a); }
  if (enc >= 0) out.push('-threads', String(n));
  if (x264 && !args.includes('-rc-lookahead') && !args.includes('-x264-params')) out.push('-rc-lookahead', '10');
  out.push(args[args.length - 1]);
  return out;
}

/*
 * ONE ENCODER AT A TIME ON A SMALL SERVER.
 *
 * "Export all" overlaps work to save time on the church PC: the next short's
 * speaker tracking pulls frames (an ffmpeg each) while this short encodes.
 * Measured on a 512 MB server exporting three 1080p shorts: five ffmpegs at
 * once, 735 MB — and the host kills the whole studio for memory, which on a
 * phone looks like the export crashing and the app restarting. Each ffmpeg on
 * its own is fine (an encode peaks near 270 MB), so on a machine under 1 GB
 * they take turns, under 2 GB two may run, and a desktop is left alone. A job
 * waiting its turn can still be cancelled.
 */
const ffSlots = () => {
  const mb = machine.memoryMB();
  return mb < 1024 ? 1 : mb < 2048 ? 2 : Infinity;
};
let ffRunning = 0;
const ffQueue = [];
function ffAcquire() {
  if (ffRunning < ffSlots()) { ffRunning++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, job: jobs.currentJob() };
    ffQueue.push(waiter);
  });
}
function ffRelease() {
  ffRunning = Math.max(0, ffRunning - 1);
  while (ffQueue.length && ffRunning < ffSlots()) {
    const w = ffQueue.shift();
    if (w.job && jobs.isCancelled(w.job)) { w.reject(new jobs.CancelledError()); continue; }
    ffRunning++; w.resolve();
  }
}
/** Run `start` (which returns a promise for one ffmpeg) once a slot is free. */
async function gated(start) {
  await ffAcquire();
  if (jobs.isCancelled()) { ffRelease(); throw new jobs.CancelledError(); }
  try { return await start(); } finally { ffRelease(); }
}

function runFfmpeg(ffmpegPath, args, opts = {}) {
  return gated(() => runFfmpegNow(ffmpegPath, args, opts));
}
function runFfmpegNow(ffmpegPath, args, { onProgress, totalDurationSec, signal, cwd } = {}) {
  args = capThreads(args);
  return new Promise((resolve, reject) => {
    const proc = jobs.track(spawn(ffmpegPath, args, { windowsHide: true, cwd }));
    let stderr = '';

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGKILL'); } catch (e) {}
      });
    }

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000); // cap memory
      if (onProgress && totalDurationSec) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
        if (m) {
          const sec = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          const pct = Math.max(0, Math.min(99, (sec / totalDurationSec) * 100));
          onProgress(Math.round(pct));
        }
      }
    });

    proc.on('error', (err) => reject(new Error('Could not start ffmpeg: ' + err.message)));
    proc.on('close', (code) => {
      // We killed it because the user hit Cancel — not a failure to report.
      if (jobs.isCancelled()) return reject(new jobs.CancelledError());
      if (code === 0) resolve({ stderr });
      else reject(new Error(`ffmpeg failed (exit ${code}).\n` + stderr.slice(-2500)));
    });
  });
}

/** Run ffmpeg purely to collect stderr (e.g. silencedetect with -f null). */
function runFfmpegCollect(ffmpegPath, args, opts = {}) {
  return gated(() => runFfmpegCollectNow(ffmpegPath, args, opts));
}
function runFfmpegCollectNow(ffmpegPath, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = jobs.track(spawn(ffmpegPath, args, { windowsHide: true, cwd }));
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => reject(new Error('Could not start ffmpeg: ' + err.message)));
    proc.on('close', () => (jobs.isCancelled() ? reject(new jobs.CancelledError()) : resolve(stderr)));
  });
}

/** Probe a media file, returning the parsed ffprobe JSON. */
function probe(ffprobePath, input) {
  return new Promise((resolve, reject) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
    const proc = spawn(ffprobePath, args, { windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => reject(new Error('Could not start ffprobe: ' + e.message)));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe failed (exit ${code})`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error('Could not parse ffprobe output: ' + e.message)); }
    });
  });
}

module.exports = { resolveFfmpeg, resolveFfprobe, runFfmpeg, runFfmpegCollect, probe, capThreads, gated, _ffState: () => ({ running: ffRunning, queued: ffQueue.length, slots: ffSlots() }) };
