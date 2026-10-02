'use strict';
/*
 * THE BACKGROUND POSTER — the app with no studio in it.
 *
 * This is what the operating system starts every few minutes once "keep posting
 * when the app is closed" is switched on in the Social Scheduler. It is the
 * same application binary, started with --publish-due, and main.js hands
 * control here before it loads a single studio module: no window is created,
 * no NDI, no encoder, no Bible, no projector. It reads the schedule, publishes
 * what is due through exactly the same Scheduler the studio uses, lets the
 * desktop notifications go out, and exits.
 *
 * A run is a second or two and shows nothing on screen. The user finds out it
 * happened the same way they would have if the app had been open: the post is
 * on the Page, and a notification says so.
 *
 * THE ONE THING THIS MUST NEVER DO
 *
 * A church's entire library — songs, running orders, linked accounts, settings
 * — is one JSON file, and the Store writes a fresh empty one when it cannot
 * read what is there. In the studio that is right: no file means a new user.
 * Here it would be catastrophic, because this process starts unattended, and
 * the file is unreadable for the instant the studio spends renaming its
 * temp file over it. So the library is read and checked BEFORE the Store is
 * ever constructed, and a run with nothing to read does nothing at all.
 */
const fs = require('fs');
const path = require('path');

// The task itself is capped at an hour by the OS; stop well inside that so a
// wedged upload can never leave a process running until the next service.
const HARD_LIMIT_MS = 30 * 60 * 1000;
// Windows delivers toasts asynchronously — quitting instantly eats them.
const NOTIFY_GRACE_MS = 2500;

function run(app) {
  const autopost = require('./autopost');
  let exiting = false;

  // `grace` is only for the case where a notification has just been raised:
  // Windows delivers toasts asynchronously and quitting instantly eats them.
  // Every other exit is immediate — a background run that has nothing to do
  // should cost the machine as little as possible.
  const bail = (code, why, grace) => {
    if (exiting) return;
    exiting = true;
    if (why) console.log('[autopost] ' + why);
    if (grace) setTimeout(() => app.exit(code), NOTIFY_GRACE_MS);
    else app.exit(code);
  };

  // No dock icon bouncing on macOS for a background run.
  try { if (app.dock && app.dock.hide) app.dock.hide(); } catch (e) {}
  // Windows only raises a toast for an app it can identify by model id. Without
  // this the "✅ Posted" notification silently never appears from here.
  try { app.setAppUserModelId('org.church.mediaworkstation'); } catch (e) {}

  const guard = setTimeout(() => bail(1, 'run took too long — stopping'), HARD_LIMIT_MS);
  if (guard.unref) guard.unref();

  app.whenReady().then(async () => {
    const userData = app.getPath('userData');
    const file = path.join(userData, 'workstation.json');

    // See the note at the top: read it ourselves first, and never write.
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { raw = null; }
    if (!raw || !Array.isArray(raw.posts)) {
      return bail(0, 'no schedule to read — nothing to do');
    }
    if (!raw.posts.some((p) => p && p.status === 'scheduled')) {
      // Nothing is waiting; do not even open the file for writing.
      return bail(0, 'nothing scheduled');
    }
    // --force comes from the Scheduler's "Test it now" button: the studio is
    // open by definition when somebody presses it, and a run that stands down
    // would prove nothing. Two publishers at once is safe — the publish lock,
    // not the heartbeat, is what stops the same post going out twice.
    const force = process.argv.includes('--force');
    if (!force && autopost.studioIsOpen(userData)) {
      autopost.recordRun(userData, { skipped: 'studio-open', published: 0, failed: 0 });
      return bail(0, 'the studio is open — it will post these itself');
    }

    const { Store } = require('./store');
    const { Accounts } = require('./accounts');
    const { Scheduler } = require('./scheduler');

    const store = new Store(file, {});
    const accounts = new Accounts(store);
    // getWindow() is null here: there is no window. The Scheduler already
    // copes — notifications still fire, the click just has nothing to focus.
    const scheduler = new Scheduler(store, () => null, { accounts });

    let result = null;
    try {
      result = await autopost.publishDue(userData, scheduler, { force });
    } catch (e) {
      console.warn('[autopost] ' + ((e && e.message) || e));
    }
    try { store.flushSync(); } catch (e) {}

    const n = (result && result.published) || 0;
    const f = (result && result.failed) || 0;
    bail(0, result && result.skipped
      ? 'stood down (' + result.skipped + ')'
      : 'published ' + n + ', failed ' + f, n > 0 || f > 0);
  }).catch((e) => bail(1, 'could not start: ' + ((e && e.message) || e)));
}

module.exports = { run };
