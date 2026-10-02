'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * Tiny, dependency-free JSON store.
 * Writes atomically-ish (write temp, rename) to avoid corruption on crash.
 *
 * WHY THE WRITE IS NOT SYNCHRONOUS ANY MORE
 *
 * Every studio in the app saves through here, and this file is the one place
 * where a save turns into disk I/O. It used to be `writeFileSync` on the main
 * process, once per `set()`. The main process is shared by every window — the
 * studio, the projector, the stage monitor — so for as long as it sat inside
 * that write, nothing anywhere in the app could repaint or answer a click.
 *
 * That was survivable when a save meant "the operator pressed Save". It stopped
 * being survivable once saves came from typing: the Presentation studio wrote
 * the whole library on every keystroke, and each write serialised the entire
 * library first. Measured on a thirty-song library that was over 100 ms of the
 * WHOLE APP frozen, per letter.
 *
 * So a `set()` now marks the store dirty and returns immediately; the write
 * happens off the main thread a moment later, and a burst of sets collapses
 * into one write. Two rules keep it as safe as the synchronous version was:
 *
 *   • only one write is ever in flight, and anything that arrives during it is
 *     written straight after — so the file always ends up holding the newest
 *     data, never a stale snapshot that raced past a newer one;
 *   • `flushSync()` writes immediately and synchronously, and the app calls it
 *     on quit. Nothing that was set before the app closes is ever lost.
 */
const WRITE_DELAY_MS = 50;

class Store {
  constructor(filePath, defaults = {}) {
    this.path = filePath;
    this.defaults = defaults;
    this.data = { ...defaults };
    this._timer = null;
    this._writing = false;
    this._again = false;
    this._dirty = false;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.path, 'utf-8');
      this.data = { ...this.defaults, ...JSON.parse(raw) };
      this._stamp();
    } catch (e) {
      this.data = { ...this.defaults };
      this.flushSync();
    }
  }

  /** Remember the file's modified time and size, so a change made by ANOTHER
   *  process (the background poster — see autopost.js) can be told from ours. */
  _stamp() {
    try {
      const st = fs.statSync(this.path);
      this._mtimeMs = st.mtimeMs; this._size = st.size;
    } catch (e) { this._mtimeMs = 0; this._size = -1; }
  }

  /**
   * Re-read ONE key from disk when another process has written the file. The
   * studio and the background poster are separate processes over one file:
   * without this the studio could hold a stale `posts` array, write it back,
   * and resurrect a post the poster had already published.
   *
   * The cheap check is modified-time plus size, because this is called on a
   * timer and the file can be megabytes. That pair is a heuristic, not a
   * proof: a write inside the same filesystem timestamp tick that happens not
   * to change the length would look like no change at all. So the one caller
   * where being wrong would mean posting something twice — Scheduler's
   * autoPublish, which runs once per post, not once per tick — passes `force`
   * and simply re-reads.
   *
   * A pending write of our own always wins: it is newer than the disk.
   */
  reloadKey(key, force) {
    if (this._dirty || this._writing) return this.data[key];
    try {
      const st = fs.statSync(this.path);
      if (!force && this._mtimeMs && st.mtimeMs === this._mtimeMs && st.size === this._size) return this.data[key];
      const raw = JSON.parse(fs.readFileSync(this.path, 'utf-8'));
      this._mtimeMs = st.mtimeMs; this._size = st.size;
      if (raw && Object.prototype.hasOwnProperty.call(raw, key)) this.data[key] = raw[key];
    } catch (e) { /* unreadable / mid-rename — keep what we have */ }
    return this.data[key];
  }

  /** Serialise + write, without blocking the main thread. */
  async _writeNow() {
    if (this._writing) { this._again = true; return; }
    this._writing = true;
    this._dirty = false;
    const json = JSON.stringify(this.data, null, 2);
    const tmp = this.path + '.tmp';
    try {
      await fsp.mkdir(path.dirname(this.path), { recursive: true });
      await fsp.writeFile(tmp, json, 'utf-8');
      await fsp.rename(tmp, this.path);
    } catch (e) {
      // Last-resort direct write
      try { await fsp.writeFile(this.path, json, 'utf-8'); } catch (e2) {}
    }
    this._stamp();
    this._writing = false;
    if (this._again) { this._again = false; this._writeNow(); }
  }

  _save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this._writeNow(); }, WRITE_DELAY_MS);
  }

  /**
   * Write right now, synchronously, and forget any pending write.
   * For shutdown, and for anything that must be on the disk before it returns.
   */
  flushSync() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
      fs.renameSync(tmp, this.path);
    } catch (e) {
      try { fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8'); } catch (e2) {}
    }
    this._stamp();
  }

  get(key) {
    return key === undefined ? this.data : this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._save();
    return this.data[key];
  }

  update(patch) {
    this.data = { ...this.data, ...patch };
    this._save();
    return this.data;
  }
}

module.exports = { Store };
