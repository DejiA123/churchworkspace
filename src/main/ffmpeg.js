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
  /*
   * ►► 'veryfast', NOT 'medium', ON A SMALL SERVER. ◄◄
   *
   * 'medium' is right on the church PC. On a cloud box with half a CPU it
   * encoded a 1080p service at a few frames a second: an hour-long export took
   * hours, and to the person holding the phone that is an export that never
   * finishes. 'veryfast' is about four times quicker at the same CRF (the same
   * look; the file is somewhat larger) and needs less memory, since it
   * compares fewer reference frames.
   */
  const draft = x264 && draftAls.getStore() === true;
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === '-preset' && x264 && /^(medium|slow|slower|veryslow|fast|faster)$/.test(String(out[i + 1]))) out[i + 1] = draft ? 'ultrafast' : 'veryfast';
    else if (draft && out[i] === '-crf' && Number(out[i + 1]) > 0) out[i + 1] = String(Math.max(10, Number(out[i + 1]) - 4));
  }
  /*
   * ►► UNDER 1 GB, x264 KEEPS FEWER FRAMES IN HAND. ◄◄
   * A 1080×1920 encode on its own measured 251 MB on 'veryfast' — the
   * look-ahead, the macroblock tree and three B-frames each hold full frames.
   * A montage piece cut from a 4K iPhone clip came to 353 MB with its decoder,
   * and with the studio beside it a 512 MB server was killed for memory.
   * Five frames of look-ahead, one B-frame and no macroblock tree: 166 MB for
   * the same encode, the same CRF (the same look), a somewhat larger file.
   */
  const tiny = x264 && machine.memoryMB() < 1024;
  const uf = /^ultrafast$/.test(String(out[out.indexOf('-preset') + 1] || ''));   // looks ahead at nothing anyway
  if (x264 && !uf && !args.includes('-rc-lookahead') && !args.includes('-x264-params')) {
    out.push('-rc-lookahead', tiny ? '5' : '10');
    if (tiny) { out.push('-mbtree', '0'); if (!args.includes('-bf')) out.push('-bf', '1'); }
  }
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
/*
 * The encoders run BELOW the server in priority. On a small cloud box (half a
 * CPU) an x264 encode takes every cycle there is, and the server that has to
 * answer the phone, the progress stream and the host's health check was left
 * queuing behind it: pages timed out, and a host that sees its health check
 * time out restarts the box — taking the export with it. Niceness only matters
 * when the two compete, so an encode on its own runs exactly as fast.
 */
/*
 * ►► A SHORT THAT IS ONLY A STEP ON THE WAY IS ENCODED FAST. ◄◄
 *
 * A captioned short is encoded twice: the crop, then the captions laid on that
 * file. The first file is thrown away the moment the second exists, yet on a
 * small server it was encoded with the same care as the finished one — over a
 * minute of a 90-second short's time on one CPU, twenty times for a batch.
 * Inside `asDraft` an x264 encode is 'ultrafast' at a LOWER CRF (more bits, so
 * nothing is lost to the second encode): 56 s → 23 s for that pass, measured.
 * Only on a small machine; the church PC keeps its settings.
 */
const { AsyncLocalStorage } = require('async_hooks');
const draftAls = new AsyncLocalStorage();
const asDraft = (on, fn) => (on && machine.small() ? draftAls.run(true, fn) : fn());

function lowPriority(proc, nice = 10) {
  try { if (proc && proc.pid) require('os').setPriority(proc.pid, nice); } catch (e) {}
  return proc;
}

async function gated(start) {
  await ffAcquire();
  if (jobs.isCancelled()) { ffRelease(); throw new jobs.CancelledError(); }
  try { return await start(); } finally { ffRelease(); }
}

/*
 * ►► A THUMBNAIL DOES NOT WAIT FOR SOMEONE ELSE'S EXPORT. ◄◄
 * Measured with 20 people on one 512 MB / 1 CPU server: the encodes take
 * turns (as they must), and a thumbnail or the timeline's filmstrip waited
 * behind them — up to 113 s for a picture that takes a moment. Those preview
 * jobs (one at a time already: video.js inPreviewLane, under 200 MB each even
 * for 4K, test/open-memory.test.js) now run BESIDE the encode — but only when
 * what is really in use (this server plus every ffmpeg it has running) leaves
 * PREVIEW_MB to spare. A big 4K encode or speech recognition fills the
 * machine, and then the preview waits its turn exactly as before.
 */
const PREVIEW_MB = 200;
const liveProcs = new Set();
function rssMB(pid) {
  try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8')); return m ? Number(m[1]) / 1024 : 0; } catch (e) { return 0; }
}
/** Memory in use now: this process and the ffmpegs it runs (null where /proc cannot say). */
function usedMB() {
  if (!fs.existsSync('/proc/self/status')) return null;
  let mb = process.memoryUsage().rss / 1048576;
  for (const p of liveProcs) mb += rssMB(p.pid);
  return mb;
}
function previewMayRunBeside() {
  if (ffRunning < ffSlots()) return false;            // a turn is free anyway: take it
  const used = usedMB();
  return used != null && used + PREVIEW_MB <= machine.memoryMB();
}

function runFfmpeg(ffmpegPath, args, opts = {}) {
  if (opts.preview && previewMayRunBeside()) return runFfmpegNow(ffmpegPath, args, Object.assign({}, opts, { nice: 5 }));
  /*
   * `background`: work nobody is waiting on to finish (the preview copy of a
   * recording the phone cannot play). It is light — ultrafast, one thread,
   * under 100 MB — but long, and in the queue it made every export wait behind
   * an hour of it. So it does not take a turn: it runs beside the encoders at
   * the lowest priority, and an export starting gets nearly all of the CPU.
   */
  if (opts.background) return runFfmpegNow(ffmpegPath, args, opts);
  return gated(() => runFfmpegNow(ffmpegPath, args, opts));
}
function runFfmpegNow(ffmpegPath, args, { onProgress, totalDurationSec, signal, cwd, background, nice } = {}) {
  args = capThreads(args);
  return new Promise((resolve, reject) => {
    const proc = lowPriority(jobs.track(spawn(ffmpegPath, args, { windowsHide: true, cwd })), background ? 19 : (nice != null ? nice : 10));
    liveProcs.add(proc);
    proc.on('close', () => liveProcs.delete(proc));
    proc.on('error', () => liveProcs.delete(proc));
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
    const proc = lowPriority(jobs.track(spawn(ffmpegPath, args, { windowsHide: true, cwd })));
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

module.exports = { usedMB, asDraft, lowPriority, resolveFfmpeg, resolveFfprobe, runFfmpeg, runFfmpegCollect, probe, capThreads, gated, _ffState: () => ({ running: ffRunning, queued: ffQueue.length, slots: ffSlots() }) };
