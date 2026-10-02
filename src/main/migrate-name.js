'use strict';
/*
 * BRINGING A CHURCH'S LIBRARY ACROSS WHEN THE APP IS RENAMED.
 *
 * Electron derives userData from the product name: %APPDATA%\<productName>.
 * Rename the app and it points at an empty folder — a church that has been
 * using it for a year opens it to find no songs, no service running orders, no
 * Bible downloads, no linked Facebook or YouTube account, no settings. Nothing
 * has been deleted; it is all still sitting in the folder under the old name.
 * But on a Sunday morning "it is somewhere else" and "it is gone" are the same
 * sentence.
 *
 * So the folder is moved, once, before anything reads it. A rename inside one
 * volume is atomic and instant even at the ~800 MB these reach once Bible
 * translations and whisper models are in them; the recursive copy is only for
 * the case where APPDATA spans volumes.
 *
 * Three rules, each of which exists because the alternative loses data:
 *   - the new folder having a library already means we are done: never
 *     overwrite what the church is using now with something older;
 *   - a new folder that exists but holds no library gets MERGED into, not
 *     replaced, so a half-started profile cannot eat the real one;
 *   - a folder left behind by a failed move is never deleted. Leaving 800 MB
 *     behind is a far better failure than losing the only copy.
 */
const fs = require('fs');
const path = require('path');

/** The file that means "a church's library lives here". */
const MARKER = 'workstation.json';

/**
 * @param {string} current   the userData folder the app will use from now on
 * @param {string[]} oldNames  every product name this app has shipped under
 * @returns {{moved:boolean, how:string, from?:string, entries?:number}}
 */
function migrateUserData(current, oldNames) {
  if (!current || !Array.isArray(oldNames) || !oldNames.length) return { moved: false, how: 'nothing to do' };
  if (fs.existsSync(path.join(current, MARKER))) return { moved: false, how: 'already here' };

  const base = path.dirname(current);
  for (const old of oldNames) {
    const from = path.join(base, old);
    if (path.resolve(from) === path.resolve(current)) continue;
    if (!fs.existsSync(path.join(from, MARKER))) continue;

    // Something is already at the new name but has no library in it.
    if (fs.existsSync(current) && fs.readdirSync(current).length) {
      let entries = 0;
      for (const entry of fs.readdirSync(from)) {
        const dest = path.join(current, entry);
        if (fs.existsSync(dest)) continue;      // never overwrite
        fs.renameSync(path.join(from, entry), dest);
        entries++;
      }
      return { moved: true, how: 'merged', from, entries };
    }

    try {
      fs.mkdirSync(base, { recursive: true });
      fs.rmSync(current, { force: true, recursive: true }); // an empty dir Electron may have made
      fs.renameSync(from, current);
      return { moved: true, how: 'moved', from };
    } catch (e) {
      fs.cpSync(from, current, { recursive: true });        // different volume: copy, keep the original
      return { moved: true, how: 'copied', from };
    }
  }
  return { moved: false, how: 'nothing to bring across' };
}

module.exports = { migrateUserData, MARKER };
