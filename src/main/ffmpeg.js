'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const jobs = require('./jobs');

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
function runFfmpeg(ffmpegPath, args, { onProgress, totalDurationSec, signal, cwd } = {}) {
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
function runFfmpegCollect(ffmpegPath, args, { cwd } = {}) {
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

module.exports = { resolveFfmpeg, resolveFfprobe, runFfmpeg, runFfmpegCollect, probe };
