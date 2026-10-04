'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const space = require('./space');

/*
 * SAVED EDITING SESSIONS — "pick up where I left off".
 *
 * An edit of a two-hour service is not one sitting. Clips get found, trimmed,
 * captioned and re-captioned over days, and until now closing the window threw
 * the lot away: the app remembered your export SETTINGS but not your WORK.
 *
 * A session is one JSON file holding everything the Video Studio had on screen
 * — the recording it was working on, every clip and cut, the captions and their
 * corrections, text, music, the outro, who the reframe is following, and where
 * the playhead was. Opening one puts the studio back exactly as it was.
 *
 * Two things are deliberate:
 *
 *   • The VIDEO is referenced, never copied. Sessions stay a few hundred KB, and
 *     the recording stays where the operator put it. If it moves, the session
 *     still opens and says which file it wants.
 *   • The most recent state is ALSO written continuously to its own slot
 *     (`autosave`), separate from the named saves. A power cut, an accidental
 *     close or a crash therefore costs nothing, and it can never overwrite a
 *     session the operator deliberately saved.
 */

let DIR = null;
function init(userDataDir) {
  DIR = path.join(userDataDir, 'sessions');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) {}
  return DIR;
}
function dir() {
  if (!DIR) throw new Error('sessions not initialised');
  // each person on a shared Cloud Studio has their own saved sessions (space.js)
  return space.pathFor(DIR);
}
const fileOf = (id) => path.join(dir(), id + '.json');
const AUTOSAVE = 'autosave';

function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
}

/**
 * A session is only worth listing if it can be described, so the card the
 * operator picks from is built here rather than by re-reading every file in the
 * renderer. `thumb` is a small JPEG data URL of the poster frame.
 */
function summarise(id, data, stat) {
  const v = (data && data.video) || {};
  const tl = (data && data.timeline) || {};
  return {
    id,
    name: (data && data.name) || 'Untitled session',
    savedAt: (data && data.savedAt) || (stat ? new Date(stat.mtimeMs).toISOString() : null),
    videoPath: v.path || null,
    videoName: v.path ? String(v.path).split(/[\\/]/).pop() : null,
    videoMissing: v.path ? !fs.existsSync(v.path) : true,
    durationSec: v.durationSec || 0,
    clips: Array.isArray(tl.segments) ? tl.segments.filter((s) => s && !s.seed).length : 0,
    shorts: Array.isArray(tl.segments) ? tl.segments.filter((s) => s && s.ai).length : 0,
    captions: data && data.captions && Array.isArray(data.captions.events) ? data.captions.events.length : 0,
    thumb: (data && data.thumb) || null,
    bytes: stat ? stat.size : 0,
    fromAutosave: !!(data && data.fromAutosave),
  };
}

/*
 * An edit from before projects lived only in the rolling slot, so Projects
 * came up empty with work still open. The first time the list is asked for,
 * that edit becomes a project of its own (once: the slot remembers which),
 * and the studio adopts it rather than making a twin (fromAutosave).
 */
function migrateAutosave() {
  const a = readAutosave();
  if (!a || a.projectId || !a.video || !a.video.path) return;
  // a video open in the studio is a project, edited yet or not
  if (!fs.existsSync(a.video.path)) return;
  // a project for this video already (made here earlier, or by the studio): nothing to add
  if (listRaw().some((r) => r.videoPath === a.video.path)) return;
  const data = Object.assign({}, a);
  delete data.id; delete data.summary; delete data.videoMissing;
  const base = String(a.video.path).split(/[\\/]/).pop().replace(/\.[a-z0-9]{2,5}$/i, '');
  const res = save({ name: a.name && a.name !== 'Session' ? String(a.name).replace(/\.[a-z0-9]{2,5}$/i, '') : base, data: Object.assign(data, { auto: true, fromAutosave: true }) });
  try { autosave(Object.assign(data, { projectId: res.id, fromAutosave: undefined })); } catch (e) { /* listed again next time: harmless, it checks */ }
}

/** Every saved session, newest first. The autosave slot is NOT one of them. */
function list() {
  try { migrateAutosave(); } catch (e) { /* the list still answers */ }
  return listRaw();
}
function listRaw() {
  let files = [];
  try { files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json')); } catch (e) { return []; }
  const out = [];
  for (const f of files) {
    const id = f.replace(/\.json$/, '');
    if (id === AUTOSAVE) continue;
    try {
      const full = path.join(dir(), f);
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      out.push(summarise(id, data, fs.statSync(full)));
    } catch (e) { /* a corrupt file is skipped, not fatal */ }
  }
  return out.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
}

/**
 * Write a session. Written to a temporary file and renamed into place, so a
 * crash mid-write cannot leave a half-written session where a good one was.
 */
function save({ id, name, data }) {
  const sid = id || newId();
  const body = Object.assign({}, data, {
    v: 1,
    name: name || (data && data.name) || 'Untitled session',
    savedAt: new Date().toISOString(),
  });
  const dest = fileOf(sid);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf-8');
  fs.renameSync(tmp, dest);
  return summarise(sid, body, fs.statSync(dest));
}

function load(id) {
  const full = fileOf(id);
  if (!fs.existsSync(full)) return null;
  const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
  data.id = id;
  // Answered here rather than in the renderer: only this side can look at the
  // disk, and a session whose recording has been moved must SAY so instead of
  // failing to open with no explanation.
  data.videoMissing = !(data.video && data.video.path && fs.existsSync(data.video.path));
  return data;
}

function remove(id) {
  if (id === AUTOSAVE) return false;
  try { fs.rmSync(fileOf(id), { force: true }); return true; } catch (e) { return false; }
}

function rename(id, name) {
  const data = load(id);
  if (!data) return null;
  return save({ id, name, data });
}

/** The rolling "what was on screen a moment ago" slot. */
function autosave(data) {
  const dest = fileOf(AUTOSAVE);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, data, { v: 1, savedAt: new Date().toISOString() })), 'utf-8');
  fs.renameSync(tmp, dest);
  return true;
}
function readAutosave() {
  const full = fileOf(AUTOSAVE);
  if (!fs.existsSync(full)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
    data.id = AUTOSAVE;
    data.summary = summarise(AUTOSAVE, data, fs.statSync(full));
    return data;
  } catch (e) { return null; }
}
function clearAutosave() {
  try { fs.rmSync(fileOf(AUTOSAVE), { force: true }); return true; } catch (e) { return false; }
}

/** Export a session to a file the operator chose (a backup, or another machine). */
function exportTo(id, dest) {
  const data = load(id);
  if (!data) throw new Error('no such session');
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), 'utf-8');
  return dest;
}
/** Take one back in. */
function importFrom(src) {
  const data = JSON.parse(fs.readFileSync(src, 'utf-8'));
  if (!data || typeof data !== 'object') throw new Error('not a session file');
  return save({ name: data.name || path.basename(src).replace(/\.[^.]+$/, ''), data });
}

module.exports = { init, list, save, load, remove, rename, autosave, readAutosave, clearAutosave, exportTo, importFrom, AUTOSAVE };
