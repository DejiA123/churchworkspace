'use strict';
/*
 * WHERE A REMOTE CALLER MAY POINT.
 *
 * Two transports now hand this PC work from somewhere else: Phone Studio on the
 * church wifi (mobile-api.js) and the Cloud Studio over the internet
 * (../cloud/cloud-api.js). The allowlist in each of them answers "what may run".
 * This answers "where may it run", and there is one copy of it because a rule
 * that exists twice is a rule that will be fixed once.
 *
 * The test that matters is by ARGUMENT NAME, not by "does this string look like
 * a path". Caption text, ASS style strings and clip labels are free-form user
 * text: a line of a sermon that happens to begin with a slash must not be
 * refused, and a path hiding in `edits.musicPath` or `clips[3].path` must not be
 * missed. So the walk is recursive, and it only ever inspects keys it knows
 * carry filenames.
 */

const path = require('path');

/** Which argument names carry a filesystem path. */
const PATH_KEYS = new Set(['input', 'base', 'path', 'musicPath', 'src', 'dir', 'file', 'dest', 'imagePath', 'mediaPath']);

/** Arrays whose ENTRIES may themselves be bare path strings. */
const PATH_ARRAYS = new Set(['inputs', 'clips', 'mediaPaths']);

/** Is `p` inside `root`? Resolved, and case-insensitively on Windows. */
function within(p, root) {
  if (!p || !root) return false;
  let a = path.resolve(p);
  let b = path.resolve(root);
  if (process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase(); }
  if (a === b) return true;
  return a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}

/**
 * A guard bound to a set of roots.
 *
 * `roots` is a FUNCTION, not an array: the folders a transport allows are read
 * from live settings (the output folder can be changed while the server runs),
 * and a guard holding a stale copy would either refuse the new folder or keep
 * admitting the old one.
 */
function makeGuard(roots) {
  const list = () => (typeof roots === 'function' ? roots() : roots) || [];

  const allowedPath = (p) => {
    if (!p || typeof p !== 'string') return false;
    return list().filter(Boolean).some((r) => within(p, r));
  };

  /**
   * Walk an argument tree; return the name of the first path argument pointing
   * outside the allowed roots, or null when everything is in bounds.
   */
  function checkArgPaths(value, keyPath = '', depth = 0) {
    if (depth > 8 || value == null) return null;
    if (Array.isArray(value)) {
      const bare = PATH_ARRAYS.has(keyPath.split('.').pop());
      for (let i = 0; i < value.length; i++) {
        const one = value[i];
        if (typeof one === 'string') {
          if (bare && one && !allowedPath(one)) return `${keyPath}[${i}]`;
          continue;
        }
        const bad = checkArgPaths(one, `${keyPath}[${i}]`, depth + 1);
        if (bad) return bad;
      }
      return null;
    }
    if (typeof value !== 'object') return null;
    // A Buffer/typed array is bytes, not a tree — walking it would be pointless
    // and, for a 4 MB caption frame, slow.
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return null;
    for (const k of Object.keys(value)) {
      const v = value[k];
      const here = keyPath ? `${keyPath}.${k}` : k;
      if (typeof v === 'string') {
        // a batch recipe's "the file step N made" (batch.js) — not a path yet
        if (PATH_KEYS.has(k) && /^@@step-\d+@@(\.[a-z0-9]+)?$/i.test(v)) continue;
        if (PATH_KEYS.has(k) && v && !allowedPath(v)) return here;
      } else if (v && typeof v === 'object') {
        const bad = checkArgPaths(v, here, depth + 1);
        if (bad) return bad;
      }
    }
    return null;
  }

  return { allowedPath, checkArgPaths, within, roots: list };
}

module.exports = { makeGuard, within, PATH_KEYS, PATH_ARRAYS };
