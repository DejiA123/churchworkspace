'use strict';
/*
 * Cancellable jobs.
 *
 * Every long IPC call already carries a `jobId` (it's how the progress bar knows
 * which job it belongs to). This module makes that same id a CANCEL handle: the
 * handler runs inside an AsyncLocalStorage scope tagged with the job, every
 * ffmpeg / whisper process spawned anywhere underneath registers itself against
 * it, and `cancel(jobId)` kills the lot.
 *
 * Why AsyncLocalStorage instead of threading a `signal` through every function:
 * a single export is a chain of five or six helpers across three modules
 * (composite → join → track → encode → burn captions), each with its own options
 * object. Passing an abort signal down all of them means touching every
 * signature for something none of the maths cares about. The store follows the
 * async chain by itself, so the only two places that need to know about jobs are
 * the IPC wrapper (opens the scope) and the spawn sites (register the child).
 *
 * Cancelling is deliberately blunt — SIGKILL. These are ffmpeg/whisper worker
 * processes writing to temp files; there is no graceful state to preserve, and a
 * user who clicked Cancel wants the CPU back now.
 */
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
const live = new Map();       // jobId -> Set<ChildProcess> currently running
const cancelled = new Set();  // jobIds the user pulled the plug on

/** Thrown (and recognised across IPC) when the user cancelled the job. */
class CancelledError extends Error {
  constructor(msg) {
    super(msg || 'Cancelled');
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}
const isCancelError = (e) => !!(e && (e.cancelled || e.name === 'CancelledError'));

/** The jobId of the handler we're currently inside, if any. */
function currentJob() {
  const s = als.getStore();
  return s ? s.jobId : null;
}

/** Run `fn` as job `jobId` so anything it spawns can be cancelled. */
async function run(jobId, fn) {
  if (!jobId) return fn();
  cancelled.delete(jobId);
  live.set(jobId, new Set());
  try {
    return await als.run({ jobId }, fn);
  } catch (err) {
    // A killed ffmpeg fails with a meaningless "exit null" — report the real
    // reason so the renderer can stay quiet instead of shouting an error at
    // someone who just clicked Cancel.
    if (cancelled.has(jobId)) throw new CancelledError();
    throw err;
  } finally {
    live.delete(jobId);
    cancelled.delete(jobId);
  }
}

/**
 * Register a freshly spawned child against the running job. Returns the child so
 * it can be used inline: `const proc = jobs.track(spawn(...))`.
 */
function track(proc) {
  const jobId = currentJob();
  if (!jobId || !proc) return proc;
  // Cancelled between spawns (e.g. deep analysis transcribing window 7 of 20) —
  // kill this one on arrival so the chain unwinds instead of running to the end.
  if (cancelled.has(jobId)) { try { proc.kill('SIGKILL'); } catch (e) {} return proc; }
  let set = live.get(jobId);
  if (!set) { set = new Set(); live.set(jobId, set); }
  set.add(proc);
  const drop = () => set.delete(proc);
  proc.once('close', drop);
  proc.once('error', drop);
  return proc;
}

/** Kill everything running under `jobId`. Safe to call for an unknown id. */
function cancel(jobId) {
  if (!jobId) return { cancelled: false, killed: 0 };
  cancelled.add(jobId);
  const set = live.get(jobId);
  let killed = 0;
  if (set) for (const p of set) { try { p.kill('SIGKILL'); killed++; } catch (e) {} }
  return { cancelled: true, killed };
}

/** Did the user cancel (this job, or the one we're running inside)? */
function isCancelled(jobId) {
  const id = jobId || currentJob();
  return !!id && cancelled.has(id);
}

/** Bail out of a loop between spawns. */
function throwIfCancelled() {
  if (isCancelled()) throw new CancelledError();
}

/** Shutting down: every process a job started goes with the server — an encode
 *  left running on its own would finish a file nobody is waiting for, and the
 *  restarted server would do the same short again beside it. */
function killAll() {
  let n = 0;
  for (const set of live.values()) for (const p of set) { try { p.kill('SIGKILL'); n++; } catch (e) {} }
  return n;
}

module.exports = { killAll, run, track, cancel, isCancelled, throwIfCancelled, currentJob, CancelledError, isCancelError };
