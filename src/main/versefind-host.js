'use strict';
/*
 * The main process's side of the quotation matcher. Owns the worker, decides
 * which translations to listen with, and answers "did they just quote
 * scripture?" in a few milliseconds.
 *
 * Everything here is written so that a failure is silence rather than an
 * error: if the worker will not start, if no translation is downloaded, if the
 * index is still building when the first phrase arrives — 🎤 Listen carries on
 * doing exactly what it did before, which is act on spoken references. The
 * quotation half simply does not answer yet.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const bible = require('./bible');
const vf = require('./versefind');

let worker = null;
let seq = 0;
const pending = new Map();
let prepared = [];          // translations the worker has finished indexing
let preparing = null;
let failed = false;
let userData = '';

function start() {
  if (worker || failed) return worker;
  try {
    worker = new Worker(path.join(__dirname, 'versefind-worker.js'), { workerData: { userData } });
    worker.on('message', (m) => {
      const p = pending.get(m && m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.data); else p.reject(new Error(m.error || 'verse finder failed'));
    });
    worker.on('error', (e) => {
      console.warn('[versefind] worker error:', e && e.message);
      stop();
      failed = true;                      // one attempt; the feature goes quiet
      for (const p of pending.values()) p.resolve(null);
      pending.clear();
    });
    worker.on('exit', () => { worker = null; for (const p of pending.values()) p.resolve(null); pending.clear(); });
    worker.unref();                       // never hold the app open
  } catch (e) {
    console.warn('[versefind] could not start the worker:', e && e.message);
    failed = true;
  }
  return worker;
}

function stop() {
  const w = worker;
  worker = null; prepared = []; preparing = null;
  if (w) { try { w.terminate(); } catch (e) {} }
}

function call(cmd, extra, timeoutMs) {
  const w = start();
  if (!w) return Promise.resolve(null);
  const id = ++seq;
  return new Promise((resolve) => {
    const t = setTimeout(() => { if (pending.delete(id)) resolve(null); }, timeoutMs || 15000);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: () => { clearTimeout(t); resolve(null); },
    });
    try { w.postMessage({ id, cmd, ...extra }); } catch (e) { pending.delete(id); clearTimeout(t); resolve(null); }
  });
}

function init(dir) { userData = dir; }

/**
 * Get ready to listen for quotations in `display`'s church.
 *
 * Called when 🎤 Listen is switched on, not at startup: a church that never
 * uses it should never pay for it. The build happens on the worker, so this
 * returning slowly costs nothing anyone can feel.
 */
async function prepare(display) {
  const installed = bible.installed().map((t) => t.abbr);
  const abbrs = vf.chooseTranslations(display, installed);
  if (!abbrs.length) return { ready: false, reason: 'no-bible', indexes: [] };
  const same = abbrs.length === prepared.length && abbrs.every((a) => prepared.includes(a));
  if (same) return { ready: true, indexes: prepared };
  if (preparing) return preparing;
  preparing = (async () => {
    const r = await call('prepare', { abbrs }, 120000);
    prepared = r && r.indexes ? r.indexes.map((i) => i.translation) : [];
    preparing = null;
    return { ready: prepared.length > 0, indexes: prepared, detail: (r && r.indexes) || [] };
  })();
  return preparing;
}

const FIND_MS = 8000;

/** Did this line quote scripture? Returns null far more often than not. */
async function find(text, opts) {
  if (!prepared.length && !preparing) return null;
  // Not waited on any more: the worker answers from whatever is built so far
  // (it adds each translation as it finishes), so the first minutes of a
  // service are searched in the church's own Bible instead of not at all.
  /*
   * …AND AN ANSWER NOBODY IS WAITING FOR IS NOT WORTH WORKING OUT. The worker
   * takes questions in order, and each one is given up on here after 8 s — but
   * the worker did not know that, and went on answering every stale question
   * in its queue. Replaying readings faster than they are spoken built a queue
   * the worker was still chewing through twenty minutes after the last reply
   * was wanted. So each question carries its deadline, and the worker drops
   * the ones that have passed it.
   */
  return call('find', { text, opts, deadline: Date.now() + FIND_MS }, FIND_MS);
}

function state() { return { started: !!worker, failed, prepared: [...prepared], preparing: !!preparing }; }

module.exports = { init, prepare, find, stop, state, chooseTranslations: vf.chooseTranslations };
