'use strict';
// A server has no graphics card to encode with, however much memory it has:
// encoders take the quick settings here (machine.js fastEncode).
if (!process.env.MW_CLOUD_SERVER) process.env.MW_CLOUD_SERVER = '1';
/*
 * THE CLOUD STUDIO, STANDALONE.
 *
 *     node src/cloud/server.js --port 7390 --data ./cloud-data
 *
 * This is the Video Studio running on a server with no desktop, no window and
 * no Electron: the real src/main/main.js, loaded on top of a stand-in for
 * Electron (electron-shim.js), with the cloud front end in front of it. Every
 * handler is the app's own, so a fix to the export pipeline is live here the
 * moment the code is deployed — there is no second backend to keep in step.
 *
 * Use it when the studio PC cannot be left on: a VPS, a box in the church
 * office, a container (see CLOUD.md and the Dockerfile).
 *
 * WHAT IS SWITCHED OFF HERE, AND WHY IT IS SWITCHED OFF HERE
 *
 * A running copy of this app does things besides edit video: it keeps a
 * heartbeat so the background poster knows the studio is open, and it runs the
 * Social Scheduler, which publishes posts when they come due.
 *
 * The heartbeat is stood down before main.js is loaded — out here, in the open,
 * rather than by a headless flag threaded through the app: it exists to tell
 * the church PC's background poster that the PC's studio is open, and this is
 * not that studio.
 *
 * The scheduler RUNS here, for the posts made here. The phone's Social
 * Scheduler (cloud-social.js) is this server's own: its posts, and the
 * accounts linked from the phone, live in this server's data folder and
 * nowhere else, so there is no second copy of any post to publish twice. Most
 * of them never need it anyway — a post to an account linked through Zernio
 * is handed to Zernio the moment it is saved, and Zernio publishes it. The tick
 * is for the rest: a booking that failed and must be retried, a post whose
 * time has already come. MW_CLOUD_SOCIAL=off stands it down again, and takes
 * the Scheduler off the phone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* --------------------------------------------------------------- options */

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (m, c) => c.toUpperCase());
    const val = eq > 0 ? a.slice(eq + 1) : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv);
const env = process.env;

const PORT = Number(args.port || env.MW_CLOUD_PORT || 7390);
const HOST = args.host || env.MW_CLOUD_HOST || '0.0.0.0';
const DATA = path.resolve(args.data || env.MW_CLOUD_DATA || path.join(os.homedir(), '.church-work-space-cloud'));
const MEDIA = path.resolve(args.media || env.MW_CLOUD_MEDIA || path.join(DATA, 'media'));
const CODE = (args.code || env.MW_CLOUD_CODE || '').trim().toLowerCase().replace(/\s+/g, '-');
const ALLOW_UPLOAD = String(args.uploads || env.MW_CLOUD_UPLOADS || 'on') !== 'off';

const version = (() => {
  try { return require('../../package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();

/* ------------------------------------------------- Electron, without Electron */

const shim = require('./electron-shim').install({ dataDir: DATA, mediaDir: MEDIA, version });

/*
 * Patch the posting machinery BEFORE main.js is loaded. Requiring the modules
 * here first means main.js gets these same module objects out of the cache.
 */
const cloudApi = require('./cloud-api');
const schedulerMod = require('../main/scheduler');
if (schedulerMod.Scheduler && schedulerMod.Scheduler.prototype) {
  const proto = schedulerMod.Scheduler.prototype;
  if (!cloudApi.SOCIAL_ON) {
    proto.start = function () {
      console.log('[cloud] social scheduler stood down (MW_CLOUD_SOCIAL=off)');
      return this;
    };
  } else {
    /*
     * There is no window here for "posted" to be told to — the scheduler's
     * desktop notification and its message to the studio window both land on
     * the Electron stand-in. So both are passed on to the signed-in phones as
     * well, which is where somebody is actually looking.
     */
    const notify = proto._notify;
    // …to the phones of the person whose post it is (space.js), not everyone's
    const ownerOf = (sched, postId) => {
      try { const p = (sched.store.get('posts') || []).find((x) => x.id === postId); return p ? (p.owner || null) : null; } catch (e) { return null; }
    };
    proto._notify = function (title, body, postId) {
      try { cloudApi.push('scheduler:notice', { title, body, postId }, { space: ownerOf(this, postId) }); } catch (e) {}
      return notify.call(this, title, body, postId);
    };
    const pushUpdate = proto._pushUpdate;
    proto._pushUpdate = function (postId) {
      // says only that a list changed; every page re-reads its own
      try { cloudApi.push('scheduler:changed', { postId }, { all: true }); } catch (e) {}
      return pushUpdate.call(this, postId);
    };
  }
}
const autopostMod = require('../main/autopost');
autopostMod.startHeartbeat = () => ({ stop() {} });

/*
 * "Open this page" from the app means the browser of whoever is in front of
 * it. On a server that is a phone, so the link is sent there (the phone shows
 * it as a button: a phone will not open a window nobody tapped for).
 */
shim.shim.shell.openExternal = async (url) => {
  if (/^https:\/\//i.test(String(url || ''))) cloudApi.push('open:url', { url: String(url) });
};

/* ------------------------------------------------------------ the app itself */

console.log(`Church Work Space — Cloud Studio v${version}`);
console.log('  data:   ' + DATA);
console.log('  media:  ' + MEDIA);

require('../main/main');       // 195 handlers, registered exactly as on the desktop

const rpc = require('../main/rpc');
const cloud = cloudApi;
const captioner = require('../main/captioner');

/** Where the offline AI assets are — the same rule main.js uses. */
function aiDir() {
  const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'ai'));
  return packaged ? path.join(process.resourcesPath, 'ai') : path.join(__dirname, '..', '..', 'bin', 'ai');
}

/* ------------------------------------------------------------------ start */

async function main() {
  // Let main.js's ready block finish: it is what builds the store and points
  // the library, sessions, captions and word book at this data folder.
  await new Promise((r) => setTimeout(r, 50));

  // Ask the app itself where things are, rather than working it out again.
  const got = await rpc.invoke('paths:get', {});
  const p = (got && got.data) || {};

  const dirs = {
    output: p.outputDir || path.join(MEDIA, 'Church Work Space'),
    uploads: path.join(DATA, 'cloud-uploads'),
    temp: shim.paths.temp,
    videos: MEDIA,
    library: path.join(DATA, 'library'),
    sessions: path.join(DATA, 'sessions'),
    fonts: (() => { try { return captioner.fontsDir(); } catch (e) { return ''; } })(),
    ai: aiDir(),
  };

  const state = await cloud.start({
    port: PORT,
    host: HOST,
    code: CODE,
    allowUpload: ALLOW_UPLOAD,
    appVersion: version,
    standalone: true,
    dirs,
  });

  const chan = rpc.channels().length;
  console.log('');
  console.log('  Cloud Studio is up.');
  console.log('  ─────────────────────────────────────────────');
  console.log('  address:      http://' + (HOST === '0.0.0.0' ? 'this-server' : HOST) + ':' + PORT);
  console.log('  access code:  ' + state.code);
  console.log('  output:       ' + dirs.output);
  console.log('  handlers:     ' + chan + ' registered, ' + Object.keys(cloud.ALLOWED).length + ' reachable from a browser');
  console.log('');
  if (!CODE) {
    console.log('  The code above was generated for this run. Set your own with');
    console.log('  --code "word-word-1234" (or MW_CLOUD_CODE) so it survives a restart.');
    console.log('');
  }
  // https is not decoration here: a PWA will not install, and a browser will not
  // treat the page as secure, over plain http to anything but localhost.
  console.log('  Put a TLS terminator in front of this (Caddy, nginx, Cloudflare)');
  console.log('  before anyone opens it from outside the building. See CLOUD.md.');
  console.log('');
}

main().catch((e) => {
  console.error('Could not start the Cloud Studio: ' + (e && e.message ? e.message : e));
  process.exit(1);
});

const bye = () => {
  console.log('\nStopping…');
  try { require('../main/jobs').killAll(); } catch (e) {}
  try { cloud.stop(); } catch (e) {}
  process.exit(0);
};
process.on('SIGINT', bye);
process.on('SIGTERM', bye);
