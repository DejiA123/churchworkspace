'use strict';
/*
 * ►► EXPORTS THAT FINISH WITH THE PHONE IN A POCKET. ◄◄
 *
 * A batch of shorts was driven by the phone: each step (cut the short, burn the
 * captions, add the text, the music, the outro) was a request the phone sent
 * when the step before it came back. Lock the phone or close the app and the
 * chain stopped where it was — the server had nothing left to do, because the
 * next step lived in the page.
 *
 * Now the phone hands over a RECIPE per short. It still does the work only a
 * browser can do — following the speaker, drawing the captions and the text
 * exactly as they look in the studio — and then, instead of waiting on each
 * server step, it writes them down (cloud-boot.js, "record mode") and sends the
 * list here. This runs the list on its own: the same handlers, in the same
 * order, each step given the file the one before it made. The phone can go
 * away the moment its part is done; the finished shorts are in Files.
 *
 * Recipes carry the caption pictures (megabytes a short), so each one is kept
 * on disk, not in memory, until its turn — twenty of them would not fit in a
 * 512 MB server otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const v8 = require('v8');
const rpc = require('./rpc');
const jobs = require('./jobs');
const space = require('./space');

const PLACEHOLDER = /^@@step-(\d+)@@(\.[a-z0-9]+)?$/i;
/* The only things a recipe may do: the steps of an export. Anything else in a
   recipe is refused — a recipe is not a way round what a phone is allowed. */
const STEPS = new Set([
  'sermon:exportShort', 'sermon:exportReframed', 'sermon:exportFramed',
  'captions:burnTrack', 'captions:burn', 'overlays:burnImages', 'overlays:burn',
  'video:overlayComposite', 'video:mixSounds', 'video:mixMusic', 'video:appendClips', 'video:attachThumb',
]);
const KEEP_MS = 24 * 3600e3;
const batches = new Map();
let seq = 0;
let DIR = null;

function dir() {
  if (!DIR) DIR = path.join(os.tmpdir(), 'mw-batches');
  fs.mkdirSync(DIR, { recursive: true });
  return DIR;
}

/*
 * ►► A RESTART DOES NOT LOSE THE BATCH. ◄◄
 * The host restarts the server when a new version deploys (and sometimes for
 * its own reasons). The recipes and the batch's state are on the persistent
 * disk, so on the way back up every short that was not finished is queued
 * again and the batch carries on — the one that was half-encoded starts over.
 */
let defaultSender = null;
function stateFile() { return path.join(dir(), 'batches.json'); }
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const out = Array.from(batches.values()).map((b) => ({
        id: b.id, space: b.space, label: b.label, total: b.total, sealed: b.sealed, cancelled: b.cancelled,
        createdAt: b.createdAt, finishedAt: b.finishedAt || null,
        items: b.items.map((x) => ({ label: x.label, file: x.file, nSteps: x.nSteps, state: x.state, jobId: x.jobId, output: x.output || null, error: x.error || null, secs: x.secs || null, startedAt: x.startedAt || null, made: x.made || [] })),
      }));
      fs.writeFileSync(stateFile() + '.tmp', JSON.stringify(out));
      fs.renameSync(stateFile() + '.tmp', stateFile());
    } catch (e) { /* the next change tries again */ }
  }, 300);
  if (saveTimer.unref) saveTimer.unref();
}

/** Called once at start-up with a folder on the persistent disk. */
let onInterrupted = null;
function init(folder, opts = {}) {
  DIR = folder;
  defaultSender = opts.sender || null;
  onInterrupted = opts.onInterrupted || null;
  let saved = [];
  try { saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) || []; } catch (e) { saved = []; }
  for (const sb of saved) {
    const b = Object.assign({}, sb, { running: false, sender: defaultSender, resumed: true });
    let again = 0;
    for (const it of b.items) {
      if (it.state === 'running' && onInterrupted) {
        // the half-made files of the attempt the restart cut off
        const finished = new Set(b.items.filter((x) => x.output).map((x) => x.output));
        try { onInterrupted({ space: b.space, label: it.label, since: it.startedAt || b.createdAt, made: it.made || [], keep: finished }); } catch (e) {}
      }
      if (it.state === 'running' || it.state === 'queued') {
        if (it.file && fs.existsSync(it.file)) { it.state = 'queued'; it.pct = 0; it.made = []; again++; }
        else { it.state = 'failed'; it.error = 'Lost when the server restarted.'; }
      }
    }
    batches.set(b.id, b);
    // a moment after start-up: the export handlers are registered after this runs
    if (again && !b.cancelled) setTimeout(() => kick(b), 4000);
    else if (!b.finishedAt && b.sealed) b.finishedAt = Date.now();
  }
  // recipes nobody will run any more
  try {
    const keep = new Set();
    for (const b of batches.values()) for (const it of b.items) if (it.file) keep.add(path.basename(it.file));
    for (const f of fs.readdirSync(dir())) if (/\.bin$/.test(f) && !keep.has(f)) fs.rmSync(path.join(dir(), f), { force: true });
  } catch (e) {}
}

const now = () => Date.now();
function summary(b) {
  const done = b.items.filter((x) => x.state === 'done').length;
  const failed = b.items.filter((x) => x.state === 'failed').length;
  const running = b.items.find((x) => x.state === 'running');
  const total = Math.max(b.total || 0, b.items.length);
  const pct = total ? Math.round(((done + failed + (running ? running.pct / 100 : 0)) / total) * 100) : 0;
  return {
    id: b.id, label: b.label, total, received: b.items.length, sealed: b.sealed,
    done, failed, cancelled: b.cancelled, pct,
    state: b.cancelled ? 'cancelled' : (b.sealed && done + failed === total ? 'done' : 'running'),
    current: running ? { label: running.label, pct: Math.round(running.pct), step: running.step } : null,
    items: b.items.map((x) => ({ label: x.label, state: x.state, output: x.output || null, error: x.error || null, secs: x.secs || null })),
    startedAt: b.createdAt, finishedAt: b.finishedAt || null,
  };
}

function emit(b) {
  save();
  const sn = b.sender || defaultSender;
  try { if (sn && !sn.isDestroyed()) sn.send('batch:progress', summary(b)); } catch (e) {}
}

function sweep() {
  for (const [id, b] of batches) {
    if (b.finishedAt && now() - b.finishedAt > KEEP_MS) { batches.delete(id); save(); }
  }
}

/** A new batch for the person asking (their space). */
function open({ label, total } = {}, sender) {
  sweep();
  const id = 'b' + now().toString(36) + (++seq);
  const b = { id, space: space.current(), label: String(label || 'Exporting shorts').slice(0, 120), total: Math.max(0, Number(total) || 0),
    items: [], sealed: false, cancelled: false, createdAt: now(), sender, running: false };
  batches.set(id, b);
  return summary(b);
}

function mine(id) {
  const b = batches.get(String(id || ''));
  if (!b || b.space !== space.current()) throw new Error('That export is not in your space.');
  return b;
}

/** One short's recipe: [{ channel, args }], later steps naming earlier outputs as @@step-N@@. */
function add({ id, label, steps } = {}, sender) {
  const b = mine(id);
  if (b.cancelled) throw new Error('That export was stopped.');
  if (!Array.isArray(steps) || !steps.length) throw new Error('Nothing to export for that short.');
  for (const st of steps) {
    if (!st || !STEPS.has(st.channel)) throw new Error(`"${st && st.channel}" is not an export step.`);
    // a step may only name the output of a step BEFORE it
    const refs = JSON.stringify(st.args || {}, (k, v) => (ArrayBuffer.isView(v) ? null : v)).match(/@@step-(\d+)@@/g) || [];
    if (refs.some((r) => Number(r.match(/\d+/)[0]) >= steps.indexOf(st))) throw new Error('A step used a file that comes after it.');
  }
  const n = b.items.length;
  const file = path.join(dir(), `${b.id}-${n}.bin`);
  fs.writeFileSync(file, v8.serialize(steps));
  b.items.push({ label: String(label || `Short ${n + 1}`).slice(0, 120), file, nSteps: steps.length, state: 'queued', pct: 0, jobId: `${b.id}_${n}` });
  if (sender) b.sender = sender;
  emit(b);
  kick(b);
  return summary(b);
}

function seal({ id } = {}) {
  const b = mine(id);
  b.sealed = true;
  b.total = b.items.length;
  if (!b.running && b.items.every((x) => x.state !== 'queued' && x.state !== 'running')) b.finishedAt = b.finishedAt || now();
  emit(b);
  return summary(b);
}

function list(sender) {
  sweep();
  if (sender) for (const b of batches.values()) if (b.space === space.current() && !b.sender) b.sender = sender;
  const me = space.current();
  return Array.from(batches.values()).filter((b) => b.space === me).map(summary).sort((a, b) => b.startedAt - a.startedAt);
}

function cancel({ id } = {}) {
  const b = mine(id);
  b.cancelled = true;
  for (const it of b.items) {
    if (it.state === 'queued') { it.state = 'cancelled'; try { fs.rmSync(it.file, { force: true }); } catch (e) {} }
    if (it.state === 'running') jobs.cancel(it.jobId);
  }
  b.finishedAt = now();
  emit(b);
  return summary(b);
}

/* ------------------------------------------------------------------ running */

function fill(v, outs, depth = 0) {
  if (depth > 10 || v == null) return v;
  if (typeof v === 'string') {
    const m = v.match(PLACEHOLDER);
    if (!m) return v;
    const out = outs[Number(m[1])];
    if (!out) throw new Error('A step used a file that was never made.');
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => fill(x, outs, depth + 1));
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return v;
  if (typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = fill(v[k], outs, depth + 1);
    return o;
  }
  return v;
}

async function runItem(b, it) {
  it.state = 'running';
  it.pct = 0;
  it.made = [];
  const t0 = now();
  it.startedAt = t0;
  emit(b);
  // the recipe stays on disk until the short is finished, so a restart part-way
  // through can start it again
  const steps = v8.deserialize(fs.readFileSync(it.file));
  const outs = [];
  const n = steps.length;
  for (let k = 0; k < n; k++) {
    if (b.cancelled) { it.state = 'cancelled'; return; }
    const st = steps[k];
    const args = fill(st.args || {}, outs);
    args.jobId = it.jobId;
    it.step = st.channel;
    let last = 0;
    const sender = {
      send(ch, payload) {
        if (ch === 'job:progress' && payload && payload.jobId === it.jobId) {
          const p = Math.max(0, Math.min(100, Number(payload.percent) || 0));
          it.pct = ((k + p / 100) / n) * 100;
          if (now() - last > 700) { last = now(); emit(b); }
          return;
        }
        try { if (b.sender) b.sender.send(ch, payload); } catch (e) {}
      },
      isDestroyed() { return false; },
    };
    const res = await rpc.invoke(st.channel, args, sender);
    if (!res || !res.ok) {
      if (res && res.cancelled) { it.state = 'cancelled'; return; }
      throw new Error((res && res.error) || `${st.channel} failed`);
    }
    const d = res.data;
    outs[k] = typeof d === 'string' ? d : (d && typeof d.output === 'string' ? d.output : args.input);
    if (typeof outs[k] === 'string') { it.made.push(outs[k]); save(); }
  }
  it.output = outs.filter((x) => typeof x === 'string').pop() || null;
  it.secs = Math.round((now() - t0) / 1000);
  it.state = 'done';
  it.pct = 100;
  try { fs.rmSync(it.file, { force: true }); } catch (e) {}
}

function kick(b) {
  if (b.running) return;
  b.running = true;
  space.run(b.space, async () => {
    try {
      for (;;) {
        const it = b.items.find((x) => x.state === 'queued');
        if (!it || b.cancelled) break;
        try {
          await runItem(b, it);
          if (it.state === 'cancelled') { try { fs.rmSync(it.file, { force: true }); } catch (er) {} }
        } catch (e) {
          if (it.state !== 'cancelled') { it.state = 'failed'; it.error = (e && e.message) || String(e); }
          try { fs.rmSync(it.file, { force: true }); } catch (er) {}
        }
        emit(b);
      }
    } finally {
      b.running = false;
      if (b.sealed && b.items.every((x) => x.state !== 'queued' && x.state !== 'running')) {
        b.finishedAt = b.finishedAt || now();
        emit(b);
      }
    }
  });
}

module.exports = { init, open, add, seal, list, cancel, PLACEHOLDER, STEPS, _batches: batches };
