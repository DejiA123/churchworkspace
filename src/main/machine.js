'use strict';
/*
 * WHAT THIS MACHINE ACTUALLY HAS.
 *
 * `os.cpus()` and `os.totalmem()` describe the HOST. Inside a container — the
 * Cloud Studio on Render, Fly or a VPS — they describe a machine the studio is
 * only renting a slice of: a 512 MB, half-a-CPU instance reads as however many
 * cores and gigabytes the host has. The scan sized itself on that (four audio
 * decoders, three speech models at once), x264 and whisper started a thread per
 * host core, and the instance ran out of memory and was killed mid-job.
 *
 * So the limits are read where the container keeps them (cgroup v2, then v1),
 * and the smaller of those and the host's figures is the answer. On a desktop
 * there is no limit and nothing changes. MW_CPUS / MW_MEMORY_MB override both,
 * for a host that hides its limits.
 */
const fs = require('fs');
const os = require('os');

const read = (f) => { try { return fs.readFileSync(f, 'utf-8').trim(); } catch (e) { return ''; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

let cached = null;
function measure() {
  if (cached) return cached;
  // ---- CPUs
  let cpus = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1;
  let quota = 0;
  const v2 = read('/sys/fs/cgroup/cpu.max').split(/\s+/);          // "50000 100000" or "max 100000"
  if (v2.length === 2 && v2[0] !== 'max' && num(v2[0]) && num(v2[1])) quota = num(v2[0]) / num(v2[1]);
  else {
    const q = Number(read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
    const p = num(read('/sys/fs/cgroup/cpu/cpu.cfs_period_us'));
    if (q > 0 && p) quota = q / p;
  }
  if (quota > 0) cpus = Math.min(cpus, Math.max(1, Math.ceil(quota)));
  if (num(process.env.MW_CPUS)) cpus = Math.max(1, Math.floor(num(process.env.MW_CPUS)));

  // ---- memory
  let bytes = os.totalmem();
  const limits = [
    typeof process.constrainedMemory === 'function' ? num(process.constrainedMemory()) : 0,
    /^\d+$/.test(read('/sys/fs/cgroup/memory.max')) ? num(read('/sys/fs/cgroup/memory.max')) : 0,
    num(read('/sys/fs/cgroup/memory/memory.limit_in_bytes')),
  ].filter((b) => b && b < 2 ** 60);                                  // v1 says "no limit" with a huge number
  for (const b of limits) bytes = Math.min(bytes, b);
  let memoryMB = Math.round(bytes / 1048576);
  if (num(process.env.MW_MEMORY_MB)) memoryMB = Math.floor(num(process.env.MW_MEMORY_MB));

  cached = { cpus, memoryMB, quota };
  return cached;
}

/** CPUs this process can really use. */
const cpus = () => measure().cpus;
/** Memory this process (and everything it starts) can really use, in MB. */
const memoryMB = () => measure().memoryMB;
/** A machine where a careless job can run out of memory: a small container, not a desktop. */
const small = () => memoryMB() < 2048;

/*
 * What a speech model needs to run, in MB — whisper.cpp's own published
 * figures (README, "Memory usage"), which already include its working buffers.
 * The studio, ffmpeg feeding it and the operating system's share come on top:
 * HEADROOM_MB is that.
 */
const WHISPER_MB = { tiny: 273, base: 388, small: 852, medium: 2100, large: 3900, turbo: 2000 };
const HEADROOM_MB = 200;
function whisperNeedMB(modelId) {
  const id = String(modelId || '');
  if (/turbo/.test(id)) return WHISPER_MB.turbo;
  const k = Object.keys(WHISPER_MB).find((x) => id.startsWith(x));
  return k ? WHISPER_MB[k] : WHISPER_MB.base;
}
/** Can this machine run that speech model without being killed for memory? */
const fitsWhisper = (modelId) => whisperNeedMB(modelId) + HEADROOM_MB <= memoryMB();

/** How many encoder threads a small machine should give ffmpeg; 0 = leave it to ffmpeg. */
const ffmpegThreads = () => (small() ? Math.max(1, Math.min(2, cpus())) : 0);

module.exports = { cpus, memoryMB, small, whisperNeedMB, fitsWhisper, ffmpegThreads, HEADROOM_MB, _reset: () => { cached = null; } };
