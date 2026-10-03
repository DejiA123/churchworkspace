'use strict';
/*
 * WHOSE WORK THIS IS.
 *
 * The Cloud Studio is used by more than one person: a pastor, a media team, a
 * volunteer on their own phone. Each of them gets a SPACE of their own, the way
 * CapCut gives every account its own projects, and nobody sees anybody else's
 * uploads, exports, saved sessions, Word Book, music and outro library or
 * planned posts.
 *
 * The studio's handlers were written for one person, and most of them never
 * need to know otherwise: they read and write through a handful of folders.
 * So instead of threading a "who" through two hundred handlers, the cloud
 * server runs each request INSIDE its person's space (AsyncLocalStorage, the
 * same trick jobs.js uses for cancelling), and the few places that pick a
 * folder ask `pathFor(base)` which one is theirs.
 *
 *   • `null` is the OWNER's space: the first account made on a server, and the
 *     desktop app itself. It keeps the original folders, so everything that
 *     was on the server before spaces existed is still exactly where it was.
 *   • Any other space is `<userData>/spaces/<id>/<folder name>`.
 *
 * Work that carries on after the request (an export, a debounced save) keeps
 * the space it started in, because AsyncLocalStorage follows the promise
 * chain and the timers made inside it.
 */

const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
let ROOT = null;

/** Called once with userData. */
function init(userDataDir) {
  ROOT = path.join(userDataDir, 'spaces');
  return ROOT;
}

const validId = (id) => typeof id === 'string' && /^[a-z0-9]{6,32}$/.test(id);

/** Run `fn` as space `id` (null or undefined = the owner). */
function run(id, fn) {
  return als.run({ id: validId(id) ? id : null }, fn);
}

/** The space of the work running now; null for the owner (and the desktop). */
function current() {
  const s = als.getStore();
  return s && s.id ? s.id : null;
}

/**
 * The folder this space uses in place of `base`. The owner gets `base` itself;
 * anyone else gets a folder of the same name inside their own space.
 */
function pathFor(base, id) {
  const who = id === undefined ? current() : (validId(id) ? id : null);
  if (!who || !base || !ROOT) return base;
  const p = path.join(ROOT, who, path.basename(base));
  try { fs.mkdirSync(p, { recursive: true }); } catch (e) {}
  return p;
}

/** Where a space's own files live, for removing a space. */
function rootOf(id) {
  return validId(id) && ROOT ? path.join(ROOT, id) : null;
}

module.exports = { init, run, current, pathFor, rootOf, validId };
