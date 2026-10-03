'use strict';
// Roomier libuv threadpool — the app runs several ffmpeg/file operations and
// NDI receiver worker threads concurrently. Set before the pool is first used.
if (!process.env.UV_THREADPOOL_SIZE || Number(process.env.UV_THREADPOOL_SIZE) < 16) {
  process.env.UV_THREADPOOL_SIZE = '16';
}
// IPv4 FIRST for everything the app fetches (Groq, Meta, YouTube…). Measured on
// a real PC: the IPv6 route to api.groq.com hung while IPv4 connected at once,
// and Node's fetch sat on the IPv6 address until it timed out — every cloud
// feature then said "could not reach", intermittently. curl and browsers fall
// back to IPv4 by themselves; Node needs telling. Harmless where IPv6 works.
try {
  require('dns').setDefaultResultOrder('ipv4first');
  const net = require('net');
  if (net.setDefaultAutoSelectFamily) net.setDefaultAutoSelectFamily(true);
  if (net.setDefaultAutoSelectFamilyAttemptTimeout) net.setDefaultAutoSelectFamilyAttemptTimeout(500);
} catch (e) { /* older runtimes: their own defaults */ }
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

/*
 * THE APP WAS RENAMED, AND EVERYTHING A CHURCH OWNS LIVES UNDER THE OLD NAME.
 *
 * This runs before ANYTHING reads userData: the --publish-due branch below and
 * the GPU setting further down are the first two reads, which is why it sits
 * here and not in whenReady(). See migrate-name.js for why each rule in it
 * exists.
 *
 * OLD_NAMES are HISTORICAL FACTS, not the current name. A find-and-replace
 * across the repo must never rewrite them — doing so is exactly how a rename
 * silently loses a church's whole library, and it is what happened while making
 * this very change. Assembled from pieces so a careless replace cannot match
 * the whole string; test/rename.test.js fails loudly if this stops naming a
 * genuinely previous name.
 */
const OLD_APP_NAMES = ['Church' + ' Media ' + 'Workstation'];
try {
  const r = require('./migrate-name').migrateUserData(app.getPath('userData'), OLD_APP_NAMES);
  if (r.moved) console.log('[rename] ' + r.how + ' your library across from "' + r.from + '"');
} catch (e) {
  console.warn('[rename] could not bring the old library across: ' + e.message);
}

/*
 * "THE SOFTWARE HAS TO BE OPEN TO POST" — NOT ANY MORE.
 *
 * Started with --publish-due this is not the studio at all: it is the
 * background poster the operating system runs every few minutes once the
 * Social Scheduler's "keep posting when the app is closed" is on. It opens no
 * window and loads no studio — which is the whole reason this branch is HERE,
 * above the requires, rather than inside whenReady(). A ninety-second
 * publishing run has no business loading NDI, the encoder or the projector.
 *
 * Returning out of the module is deliberate: a CommonJS module is a function
 * body, so this genuinely stops main.js from being the studio.
 */
if (require('./autopost').isAgentArgv(process.argv)) {
  require('./agent-run').run(app);
  return;
}

/** This build's version, from the file the installer is stamped from. */
function appVersion() {
  try { return require('../../package.json').version || app.getVersion(); }
  catch (e) { return app.getVersion(); }
}

// Offline AI assets (MediaPipe wasm + face model) served to the renderer over a
// privileged custom scheme so they load under CSP without disabling web security.
function aiDir() {
  const packaged = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'ai'));
  return packaged ? path.join(process.resourcesPath, 'ai') : path.join(__dirname, '..', '..', 'bin', 'ai');
}
protocol.registerSchemesAsPrivileged([
  { scheme: 'mwasset', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Record every IPC handler as it is registered so a second transport (Phone
// Studio, below) can call the very same functions. This has to run BEFORE the
// first ipcMain.handle in this file or in any module it pulls in.
const rpc = require('./rpc');
rpc.install(ipcMain);

const { Store } = require('./store');
const ffmod = require('./ffmpeg');
const video = require('./video');
const flyer = require('./flyer');
const highlights = require('./highlights');
const captioner = require('./captioner');
const wordbook = require('./wordbook');
const llm = require('./llm');
const socialCopy = require('./social-copy');
const schedulePlan = require('./schedule-plan');
const llmjudge = require('./llmjudge');
const jobs = require('./jobs');
const library = require('./library');
const sessions = require('./sessions');
const space = require('./space');
const mediaCache = require('./media-cache');
const bible = require('./bible');
const songbank = require('./songbank');
const bgvideos = require('./bgvideos');
const presenter = require('./presenter');
const voicelisten = require('./voicelisten');
const cloudspeech = require('./cloudspeech');
const machine = require('./machine');
const pauses = require('./pauses');
// The other half of "listen to the clip, then write about it" — the hosted
// model that writes the social copy. See src/main/cloudwrite.js.
const cloudwrite = require('./cloudwrite');
// The reframe's eye: which of the people found is the one preaching. See src/main/cloudsee.js.
const cloudsee = require('./cloudsee');
const versefind = require('./versefind-host');
const webout = require('./webserver');
const phone = require('./mobile-api');
// The Video Studio, from anywhere in the world (src/cloud/). Same handlers as
// the window, a real web app in front of them, and an optional tunnel out.
const cloud = require('../cloud/cloud-api');
const tunnel = require('../cloud/tunnel');
const ndiSend = require('./ndi-send');
const artnet = require('./artnet');
const { TransCache } = require('./transcache');
const { Scheduler } = require('./scheduler');
const autopost = require('./autopost');
const { Accounts } = require('./accounts');
const publisher = require('./publisher');
const { LiveStream, ProgramHub, DESTINATIONS, QUALITIES, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY,
  detectEncoder, encoderLabel, REC_FORMATS, DEFAULT_REC_FORMAT, recFormat,
  AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, reEncodedAmong, COPY_BITRATE_TOLERANCE,
  OUT_SAMPLE_RATE } = require('./livestream');
const { BrowserSource } = require('./browsersource');
const { NetStream } = require('./netstream');
const ndi = require('./ndi');

// GPU compositing. The Go Live switcher draws the program canvas, every preview
// and every input thumbnail on each frame; in software that work alone starves
// the render loop (measured: 29fps and 50% CPU with the GPU off vs a full 60fps
// at 43% with it on — the stutter people see while recording IS this). Flyer
// export doesn't need software rendering: it rasterises through an SVG
// foreignObject onto a canvas, not Electron's capturePage. Settings keeps an
// escape hatch for machines with genuinely broken drivers.
try {
  const early = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'workstation.json'), 'utf8'));
  if (early && early.settings && early.settings.gpuAcceleration === 'off') app.disableHardwareAcceleration();
} catch (e) { /* first run / unreadable — GPU stays on */ }

// Nothing in a presentation is ever "started by a click on the video". The
// operator clicks a SLIDE and whatever is on it — a motion loop, a YouTube
// bumper with its sound — has to start immediately. Chromium's default policy
// would silently refuse to play anything with audio until someone clicked the
// picture itself, which on a projector nobody can click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let mainWindow = null;
let store = null;
let scheduler = null;
let accounts = null;
let screenWatch = null;      // polls the monitor cables (see the watchdog below)
let heartbeat = null;        // the studio-is-open beat the background poster reads
// One encode of the program, many consumers: every streaming destination plus
// Record / Instant Replay attach here (src/main/livestream.js).
const hub = new ProgramHub();
const hubRecFiles = new Map();  // recId -> the MP4 path that output is writing
const recorders = new Map(); // recId -> LiveStream writing a local MP4 (MultiCorder)
let chosenScreenId = null;   // set by the renderer before getDisplayMedia (vMix "screen capture")
const browserSources = new Map(); // id -> BrowserSource (Web Browser / Video Call / PowerPoint inputs)
const netStreams = new Map();      // id -> NetStream (Stream / SRT inputs)
// NDI receivers are owned by ndi.registerIpc (see `ndiIpc` below) — they talk to
// the renderer directly and need nothing from this process.

function defaultOutputDir() {
  const base = app.getPath('videos') || app.getPath('documents') || app.getPath('home');
  return path.join(base, 'Church Work Space');
}

function getCtx() {
  const s = store.get('settings') || {};
  return {
    ffmpeg: ffmod.resolveFfmpeg(s.ffmpegPath),
    ffprobe: ffmod.resolveFfprobe(s.ffprobePath),
  };
}

function ensureOutputDir() {
  const s = store.get('settings') || {};
  // each person on a shared Cloud Studio exports into a folder of their own (space.js)
  const dir = space.pathFor(s.outputDir || defaultOutputDir());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f1117',
    title: 'Church Work Space',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The Go Live switcher must keep mixing audio, drawing the program
      // canvas, and feeding the encoder even if the window is minimized,
      // occluded by another app, or unfocused during a live service.
      backgroundThrottling: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the studio must take the projector down with it. Output windows are
  // real BrowserWindows, so without this the app would keep running headless
  // with a stranded slide on the big screen and no way to reach it.
  // Projector windows and offscreen NDI feeds are BrowserWindows too, so the
  // app would never reach 'window-all-closed' with one still running. Closing
  // the studio closes the show.
  mainWindow.on('closed', () => {
    try { presenter.shutdown(); } catch (e) {}
    try { ndiSend.stopAll(); } catch (e) {}
    // NDI receivers are their own processes; nothing else would reap them.
    try { ndiIpc.stopAll(); } catch (e) {}
  });

  // The Go Live studio opens a blank child window ("External" / "Fullscreen")
  // showing the program output for a projector or second screen; every real URL
  // still goes to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    if (!url || url === 'about:blank') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Program Output', backgroundColor: '#000000', autoHideMenuBar: true,
          width: 960, height: 560, fullscreen: frameName === 'mwOutputFS',
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Screen-capture inputs: the renderer picks a source (live:pickScreen) then
  // calls getDisplayMedia — this handler hands Chromium the chosen source.
  mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const src = sources.find((s) => s.id === chosenScreenId) || sources[0];
      if (!src) return callback({});
      const res = { video: src };
      // system-sound loopback is Windows-only in Chromium
      if (request.audioRequested && process.platform === 'win32') res.audio = 'loopback';
      callback(res);
    }).catch(() => callback({}));
  });
}

app.whenReady().then(() => {
  // Serve bundled AI assets (mwasset://wasm/... , mwasset://blaze_face_short_range.tflite, mwasset://vision_bundle.mjs)
  protocol.handle('mwasset', async (request) => {
    try {
      const u = new URL(request.url);
      const rel = decodeURIComponent((u.hostname + u.pathname)).replace(/^\/+/, '');
      const full = path.normalize(path.join(aiDir(), rel));
      if (!full.startsWith(aiDir())) return new Response('forbidden', { status: 403 });
      const ext = path.extname(full).toLowerCase();
      const mime = ext === '.wasm' ? 'application/wasm' : (ext === '.mjs' || ext === '.js') ? 'text/javascript'
        : ext === '.tflite' ? 'application/octet-stream' : 'application/octet-stream';
      // Read the file directly — net.fetch() on file: URLs is unreliable from
      // the main process (can hang indefinitely instead of erroring).
      const buf = await fs.promises.readFile(full);
      return new Response(buf, { headers: { 'content-type': mime } });
    } catch (e) { return new Response('not found: ' + e.message, { status: 404 }); }
  });

  const userData = app.getPath('userData');
  store = new Store(path.join(userData, 'workstation.json'), {
    settings: {
      ffmpegPath: '',
      ffprobePath: '',
      outputDir: defaultOutputDir(),
      brand: { churchName: 'Our Church', primaryColor: '#1f6feb', accentColor: '#f5a623' },
      apiKeys: { anthropic: '', image: '', bible: '' },
      // Presentation Studio: which monitor each output goes to, and the
      // translation the Bible panel opens on.
      present: { audienceDisplay: '', stageDisplay: '', translation: 'kjv', versesPerSlide: 1, autoOpen: false },
      accounts: { instagram: '', facebook: '', tiktok: '', fbPageId: '', fbToken: '', fbAppId: '', fbAppSecret: '', ytClientId: '', ytClientSecret: '', tkClientKey: '', tkClientSecret: '', tkRedirectUri: '', upApiKey: '', zoApiKey: '' },
      live: { dest: 'facebook', key: '', customUrl: '', quality: DEFAULT_QUALITY, fpsMode: 'auto' },
      // 'auto' picks the best working hardware H.264 encoder; 'libx264' pins
      // software. 'gpuAcceleration' is read before app.whenReady (see top).
      liveEncoder: 'auto',
      gpuAcceleration: 'on',
      // Phone Studio — the Video Studio driven from a phone on the same wifi.
      // Off until switched on, because it opens a port on this machine.
      phone: { enabled: false, port: 7380, pin: '', allowUpload: true },
      /*
       * 🎤 Listen's speech engine. `on` is false until a church pastes a key,
       * and that is the consent as well as the setting: turning this on sends
       * the seconds of the service it is listening to over the internet to be
       * recognised, which a church should choose deliberately rather than
       * discover. Nothing is sent while it is off.
       */
      listen: { cloud: { on: false, provider: 'groq', key: '', model: '', url: '' } },
    },
    posts: [],
    socialAccounts: [],
    // Presentation Studio content: songs/scripture/custom decks, service
    // playlists, and the saved Looks (themes) applied to them.
    presentations: [],
    playlists: [],
    presentThemes: [],
  });

  space.init(userData);   // each Cloud Studio person's own folders, under <userData>/spaces
  library.init(userData); // saved music + outro clips live under <userData>/library
  sessions.init(userData); // saved editing sessions under <userData>/sessions
  mediaCache.init(path.join(app.getPath('temp'), 'cws-media-cache')); // timeline pictures + HEVC previews, per recording
  songbank.init(userData); // the songs the church sings, under <userData>/song-bank.json
  bible.init(userData);   // downloaded translations live under <userData>/bibles
  versefind.init(userData); // …and the quotation matcher reads them from its worker
  bgvideos.init(userData); // motion backgrounds fetched on demand, under <userData>/backgrounds
  captioner.init(userData); // optional higher-accuracy speech models under <userData>/models
  wordbook.init(userData); // the words the captions keep getting wrong, under <userData>/word-book.json
  llm.init(userData);      // optional local thinking model: weights beside the speech
                           // ones, llama.cpp runtime under <userData>/tools/llama
  // 🎤 Listen's cloud ear, from what this church saved last time. Doing it here
  // rather than when the studio first asks means the very first phrase of the
  // morning is already going to the right engine.
  try { video.setExportPrefs((store.get('settings') || {}).exportPrefs || {}); } catch (e) {}
  try { loadCloudSpeech(); } catch (e) {}
  // …and the model that writes the social posts, which shares that same key.
  try { loadCloudWrite(); } catch (e) {}
  // Tell the studio whenever an output window opens, closes, or a monitor is
  // plugged in — the operator's screen buttons must reflect reality.
  presenter.setNotifier((st) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('present:outputs', st);
    }
  });
  // Arrow keys pressed on a projector window belong to the studio: the output
  // holds no running order and cannot advance itself.
  presenter.setKeyHandler((cmd) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('present:remote', { cmd });
    }
  });
  const tellStudio = () => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('present:outputs', presenter.state());
    }
  };
  screen.on('display-added', tellStudio);
  screen.on('display-removed', tellStudio);
  screen.on('display-metrics-changed', tellStudio);
  /*
   * THE CABLE WATCHDOG.
   *
   * Those three events are not enough, and the gap is the common case rather
   * than an edge case. A projector plugged into a Windows laptop arrives in
   * DUPLICATE mode by default: one desktop copied onto both panels. Nothing was
   * added — Electron's display list is unchanged and `display-added` never
   * fires — so the studio sits silent while the operator watches the projector
   * show a copy of the studio itself. Windows also settles a real hot-plug over
   * a second or two, and can finish after the event it sent.
   *
   * So poll what is on the CABLES (~0.06 ms per reading, cached) alongside the
   * desktop list, and tell the studio whenever the physical picture changes for
   * any reason. This is the one thread that also drives five studios, hence the
   * measured cost rather than a hopeful one.
   */
  let lastScreenSig = null;
  const screenSig = () => {
    const ds = screen.getAllDisplays()
      .map((d) => d.id + '@' + d.bounds.x + ',' + d.bounds.y + '/' + d.size.width + 'x' + d.size.height)
      .sort().join('|');
    let cables = '';
    try { cables = presenter.topology.signature(); } catch (e) {}
    return ds + '#' + cables;
  };
  try { lastScreenSig = screenSig(); } catch (e) {}
  screenWatch = setInterval(() => {
    let sig;
    try { sig = screenSig(); } catch (e) { return; }
    if (sig === lastScreenSig) return;
    lastScreenSig = sig;
    tellStudio();
  }, 1500);
  if (screenWatch.unref) screenWatch.unref();

  accounts = new Accounts(store);
  scheduler = new Scheduler(store, () => mainWindow, { accounts });
  scheduler.start();
  // Tell the background poster we are here, so it stands down instead of
  // publishing the same post from a second process (src/main/autopost.js).
  heartbeat = autopost.startHeartbeat(userData);

  // Probe the hardware encoder now, in the background, so the first "Go Live"
  // isn't delayed by a couple of seconds of encoder validation.
  detectEncoder(getCtx().ffmpeg, (store.get('settings') || {}).liveEncoder || 'auto')
    .then((enc) => console.log('[live] program encoder: ' + encoderLabel(enc)))
    .catch(() => {});

  createWindow();

  // Somebody who switched the Cloud Studio on last Sunday expects to open it
  // from their phone this Sunday without walking to the PC. The tunnel only
  // comes back up if it was the thing they chose, not merely available.
  if (cloudSettings().enabled) {
    startCloud().then(async (st) => {
      console.log('[cloud] Cloud Studio on ' + st.localUrls.join(', '));
      if (cloudSettings().tunnel) {
        try { const t = await startTunnel(); console.log('[cloud] public address: ' + (t.url || '(named tunnel)')); }
        catch (e) { console.warn('[cloud] no public address:', e.message); }
      }
    }).catch((e) => console.warn('[cloud] could not start:', e.message));
  }

  // Someone who switched Phone Studio on last Sunday expects their phone to
  // just work this Sunday — without walking to the PC to press a button.
  if (phoneSettings().enabled) {
    startPhone().then((st) => console.log('[phone] Phone Studio on ' + st.urls.join(', ')))
      .catch((e) => console.warn('[phone] could not start:', e.message));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/*
 * Saves are written a moment after they are made rather than inside the call
 * that made them, so that typing in a studio cannot freeze every window at
 * once (see store.js). The other half of that bargain is here: on the way out,
 * anything still waiting is written synchronously before the process goes.
 */
app.on('before-quit', () => { try { if (store) store.flushSync(); } catch (e) {} try { songbank.flushSync(); } catch (e) {} try { wordbook.flushSync(); } catch (e) {} });
app.on('will-quit', () => {
  try { tunnel.stop(); } catch (e) {}   // the public door closes with the app
  try { if (store) store.flushSync(); } catch (e) {}
  try { songbank.flushSync(); } catch (e) {}
  try { wordbook.flushSync(); } catch (e) {}
  if (heartbeat) { try { heartbeat.stop(); } catch (e) {} heartbeat = null; }
  // Hand the speech model's memory back if 🎤 Listen had it resident.
  try { voicelisten.whisperfast.stop(); } catch (e) {}
  // …and the quotation finder's thread, so a question it is halfway through
  // answering cannot hold the app open on the way out.
  try { versefind.stop(); } catch (e) {}
});

app.on('window-all-closed', () => {
  try { if (store) store.flushSync(); } catch (e) {}
  try { songbank.flushSync(); } catch (e) {}
  try { wordbook.flushSync(); } catch (e) {}
  if (screenWatch) { clearInterval(screenWatch); screenWatch = null; }
  if (scheduler) scheduler.stop();
  // Hand posting back to the background poster the moment we are gone, rather
  // than making it wait for the beat to go stale.
  if (heartbeat) { try { heartbeat.stop(); } catch (e) {} heartbeat = null; }
  try { presenter.shutdown(); } catch (e) {}
  try { webout.stop(); } catch (e) {}
  try { phone.stop(); } catch (e) {}
  // The cloud goes with them, and the public door shuts first. On Windows the
  // app quits a few lines below so this is tidiness; on macOS it is not, because
  // there the app stays alive with no window — and a studio that is still
  // answering the internet with nothing on screen to say so is exactly the
  // situation nobody would choose.
  try { tunnel.stop(); } catch (e) {}
  try { cloud.stop(); } catch (e) {}
  try { ndiSend.stopAll(); } catch (e) {}
  try { artnet.stop(); } catch (e) {}
  try { hub.stop(); } catch (e) {}
  hubRecFiles.clear();
  for (const rec of recorders.values()) { try { rec.stop(); } catch (e) {} }
  recorders.clear();
  for (const bs of browserSources.values()) { try { bs.destroy(); } catch (e) {} }
  browserSources.clear();
  for (const ns of netStreams.values()) { try { ns.stop(); } catch (e) {} }
  netStreams.clear();
  try { ndiIpc.stopAll(); } catch (e) {}
  if (process.platform !== 'darwin') app.quit();
});

/* ----------------------------- IPC: helpers ----------------------------- */

const onProgress = (event, jobId) => (percent) => {
  if (jobId && event && !event.sender.isDestroyed()) {
    event.sender.send('job:progress', { jobId, percent });
  }
};

/**
 * Every long-running handler already receives a `jobId` (that's how progress is
 * routed). Running it inside jobs.run() makes that id a CANCEL handle too: any
 * ffmpeg/whisper process spawned underneath registers against it, so `job:cancel`
 * can kill the whole chain. Handlers without a jobId are short and run as before.
 */
function wrap(handler) {
  return async (event, args = {}) => {
    try {
      const jobId = args && args.jobId;
      const data = jobId ? await jobs.run(jobId, () => handler(event, args)) : await handler(event, args);
      return { ok: true, data };
    } catch (err) {
      if (jobs.isCancelError(err)) return { ok: false, error: 'Cancelled', cancelled: true };
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  };
}

// Stop a running job (Cancel on the progress overlay).
ipcMain.handle('job:cancel', wrap(async (e, { id }) => jobs.cancel(id)));

function outPath(name) {
  return path.join(ensureOutputDir(), name);
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ----------------------------- IPC: settings ---------------------------- */

ipcMain.handle('settings:get', wrap(async () => store.get('settings')));
/*
 * A settings patch replaces a top-level section WHOLESALE, which is fine for
 * the flat ones and is a trap for the two that have a `cloud` inside them.
 * Pressing Save on the Settings page sends `social: { eventName, speakers,
 * allowBait }` — and without this, that one press would delete the key the
 * caption writer runs on, with nothing to say it had happened. The same is true
 * of `listen.cloud` and the ear. A key is only ever changed through its own
 * handler, so here it is carried across.
 */
const KEEP_NESTED = { social: ['cloud'], listen: ['cloud'] };
ipcMain.handle('settings:update', wrap(async (e, { patch }) => {
  const prev = store.get('settings') || {};
  const merged = { ...prev, ...patch };
  for (const [section, keys] of Object.entries(KEEP_NESTED)) {
    if (!patch || !patch[section]) continue;
    for (const k of keys) {
      if (patch[section][k] === undefined && prev[section] && prev[section][k] !== undefined) {
        merged[section] = { ...merged[section], [k]: prev[section][k] };
      }
    }
  }
  store.set('settings', merged);
  return merged;
}));
ipcMain.handle('paths:get', wrap(async () => ({
  outputDir: ensureOutputDir(),
  userData: app.getPath('userData'),
  fontsDir: captioner.fontsDir(),
  // The REAL version. The corner of the sidebar used to carry a hand-typed
  // string, and it sat at v2.9.0 through seven releases — every one of which
  // looked, to the person who installed it, like the build had not taken.
  //
  // Read from package.json rather than app.getVersion(): that API answers with
  // ELECTRON's version (31.x) whenever the app is run as a script instead of a
  // packaged bundle, which is how every test here runs it. package.json is the
  // same file electron-builder stamps the installer from, and it is always at
  // the root of the asar, so this is right in both worlds.
  appVersion: appVersion(),
  ...getCtx(),
})));

/* ----------------------------- IPC: dialogs ----------------------------- */

ipcMain.handle('dialog:openFile', wrap(async (e, { filters, multi } = {}) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: filters || [{ name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled) return null;
  return multi ? res.filePaths : res.filePaths[0];
}));

ipcMain.handle('dialog:saveFile', wrap(async (e, { defaultName, filters } = {}) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName ? path.join(ensureOutputDir(), defaultName) : ensureOutputDir(),
    filters: filters || [{ name: 'All files', extensions: ['*'] }],
  });
  return res.canceled ? null : res.filePath;
}));

ipcMain.handle('dialog:openDir', wrap(async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
}));

/* --------------------------- IPC: saved sessions -------------------------
 * An edit of a long service takes more than one sitting. See src/main/sessions.js
 * for what a session holds and why the video is referenced rather than copied.
 */

ipcMain.handle('session:list', wrap(async () => sessions.list()));
ipcMain.handle('session:save', wrap(async (e, { id, name, data }) => sessions.save({ id, name, data })));
ipcMain.handle('session:load', wrap(async (e, { id }) => sessions.load(id)));
ipcMain.handle('session:remove', wrap(async (e, { id }) => sessions.remove(id)));
ipcMain.handle('session:rename', wrap(async (e, { id, name }) => sessions.rename(id, name)));
// The rolling slot: written continuously while editing, read once on the way in.
ipcMain.handle('session:autosave', wrap(async (e, { data }) => sessions.autosave(data)));
ipcMain.handle('session:autosaveGet', wrap(async () => sessions.readAutosave()));
ipcMain.handle('session:autosaveClear', wrap(async () => sessions.clearAutosave()));
ipcMain.handle('session:export', wrap(async (e, { id, dest }) => sessions.exportTo(id, dest)));
ipcMain.handle('session:import', wrap(async (e, { src }) => sessions.importFrom(src)));

/* ------------------------------ IPC: video ------------------------------ */

ipcMain.handle('video:info', wrap(async (e, { input }) => mediaCache.json(input, 'info-' + video.INFO_SHAPE, () => video.getInfo(getCtx(), input))));

ipcMain.handle('video:thumbnail', wrap(async (e, { input, timeSec }) => {
  const output = path.join(app.getPath('temp'), `mw-thumb-${Date.now()}.png`);
  await video.thumbnail(getCtx(), { input, timeSec, output });
  return output;
}));

ipcMain.handle('video:trim', wrap(async (e, { input, startSec, endSec, jobId }) => {
  const output = outPath(`trim-${stamp()}.mp4`);
  await video.trim(getCtx(), { input, startSec, endSec, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:export', wrap(async (e, { input, preset, fill, denoise, fadeIn, fadeOut, jobId }) => {
  const output = outPath(`export-${preset}-${stamp()}.mp4`);
  await video.exportForPlatform(getCtx(), { input, preset, fill, denoise, fadeIn, fadeOut, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:extractAudio', wrap(async (e, { input, jobId }) => {
  const output = outPath(`audio-${stamp()}.mp3`);
  await video.extractAudio(getCtx(), { input, output, onProgress: onProgress(e, jobId) });
  return output;
}));

// "Hear the difference": a few seconds of the real audio, with and without the
// noise removal. Written to temp — this is a listen, not a deliverable.
//
// The filename is unique per press on purpose. A fixed one would be the obvious
// choice, but the renderer plays these through an <audio> element, and Chromium
// will happily serve the PREVIOUS render of the same path out of its media
// cache — so the second press would play the first press's setting. Old samples
// are swept instead, which keeps temp tidy without that trap.
ipcMain.handle('video:audioSample', wrap(async (e, { input, startSec, durationSec, denoise }) => {
  const dir = app.getPath('temp');
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^mw-listen-/.test(f)) continue;
      const p = path.join(dir, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 10 * 60 * 1000) fs.rmSync(p, { force: true });
    }
  } catch (er) {}
  const output = path.join(dir, `mw-listen-${denoise ? 'clean' : 'raw'}-${Date.now()}.m4a`);
  return video.audioSample(getCtx(), { input, startSec, durationSec, denoise, output });
}));

ipcMain.handle('video:autoTrim', wrap(async (e, { input, noiseDb, minSilenceSec, jobId }) => {
  const output = outPath(`autocut-${stamp()}.mp4`);
  return video.autoTrimSilence(getCtx(), {
    input, output, noiseDb, minSilenceSec, onProgress: onProgress(e, jobId),
  });
}));

ipcMain.handle('video:merge', wrap(async (e, { inputs, jobId }) => {
  const output = outPath(`merged-${stamp()}.mp4`);
  await video.merge(getCtx(), { inputs, output, onProgress: onProgress(e, jobId) });
  return output;
}));

// "Close the gap": keep only these source ranges and join them back-to-back, so a
// clip the user removed pauses from exports as ONE continuous video. toTemp keeps
// the joined file out of the output folder when it's just a step in a short export.
ipcMain.handle('video:joinPieces', wrap(async (e, { input, pieces, toTemp, jobId }) => {
  const output = toTemp ? path.join(app.getPath('temp'), `mw-join-${Date.now()}.mp4`) : outPath(`joined-${stamp()}.mp4`);
  await video.joinPieces(getCtx(), { input, pieces, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:captions', wrap(async (e, { input, srt, jobId }) => {
  const output = outPath(`captioned-${stamp()}.mp4`);
  await video.addCaptions(getCtx(), { input, srt, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:presets', wrap(async () => video.PRESETS));

// filmstrip / waveform / HEVC preview are kept per recording — see media-cache.js
const cachedMedia = mediaCache.cached;

ipcMain.handle('video:filmstrip', wrap(async (e, { input, count }) => {
  const n = count || 16;
  return cachedMedia(input, 'strip' + n, '.png', (output) => video.filmstrip(getCtx(), { input, count: n, output }));
}));

/* Frame rate and bitrate, CapCut's two other export dials: kept on disk and
   handed to video.js, which every export reads (see setExportPrefs). */
ipcMain.handle('video:setExportPrefs', wrap(async (e, p = {}) => {
  const prefs = video.setExportPrefs(p);
  const settings = store.get('settings') || {};
  store.set('settings', Object.assign({}, settings, { exportPrefs: prefs }));
  return prefs;
}));
ipcMain.handle('video:getExportPrefs', wrap(async () => video.getExportPrefs()));

ipcMain.handle('video:makeProxy', wrap(async (e, { input, jobId }) => {
  return cachedMedia(input, 'proxy', '.mp4', (output) => video.makeProxy(getCtx(), { input, output, onProgress: onProgress(e, jobId) }));
}));

/* AI montage: a pile of videos and pictures → one edit, directed by the best
   model available (see montage.js). Its stage names ride on the progress
   events, so the phone can say what is happening, not just how far. */
const montage = require('./montage');
ipcMain.handle('montage:status', wrap(async () => montage.directorStatus()));
ipcMain.handle('montage:create', wrap(async (e, { mediaPaths, musicPath, style, lengthSec, full, aspect, brief, keepAudio, jobId }) => {
  const output = outPath(`montage-${stamp()}.mp4`);
  let pct = 0, stageName = '';
  const tell = () => { if (jobId && e && !e.sender.isDestroyed()) e.sender.send('job:progress', { jobId, percent: pct, stage: stageName }); };
  return montage.make(getCtx(), video.getInfo, {
    mediaPaths, musicPath, style, lengthSec, full, aspect, brief, keepAudio, output,
    onProgress: (p) => { pct = p; tell(); },
    stage: (name) => { stageName = name; tell(); },
    log: (m) => console.warn('[montage]', m),
  });
}));

ipcMain.handle('video:applyEdits', wrap(async (e, { input, edits, jobId }) => {
  const output = outPath(`edited-${stamp()}.mp4`);
  await video.applyEdits(getCtx(), { input, edits: edits || {}, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:waveform', wrap(async (e, { input, width, height }) => {
  const w = width || 1600, h = height || 90;
  return cachedMedia(input, `wave${w}x${h}`, '.png', (output) => video.waveform(getCtx(), { input, width: w, height: h, output }));
}));

ipcMain.handle('video:stabilize', wrap(async (e, { input, jobId }) => {
  const output = outPath(`stabilized-${stamp()}.mp4`);
  await video.stabilize(getCtx(), { input, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:reverse', wrap(async (e, { input, startSec, endSec, jobId }) => {
  const output = outPath(`reversed-${stamp()}.mp4`);
  await video.reverseClip(getCtx(), { input, startSec, endSec, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:freezeFrame', wrap(async (e, { input, timeSec, holdSec, jobId }) => {
  const output = outPath(`freeze-${stamp()}.mp4`);
  await video.freezeFrame(getCtx(), { input, timeSec, holdSec: holdSec || 2, output, onProgress: onProgress(e, jobId) });
  return output;
}));

ipcMain.handle('video:overlayComposite', wrap(async (e, { base, overlays, baseStart, baseEnd, toTemp, jobId, outName, deleteInput }) => {
  // toTemp = intermediate file for a short export (PiP composited BEFORE the crop)
  // outName = keep the source's name on the output. A bulk run writes one file
  // per input, and forty files all called "overlay-…" is not a usable result.
  const output = toTemp
    ? path.join(app.getPath('temp'), `mw-pip-${Date.now()}.mp4`)
    : outPath(`${(outName || 'overlay').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await video.exportOverlayComposite(getCtx(), { base, overlays: overlays || [], baseStart, baseEnd, output, onProgress: onProgress(e, jobId) });
  // The un-overlaid short is only ever an intermediate — leaving it beside the
  // finished one gives the operator two files and no way to tell them apart.
  if (deleteInput) removeIntermediate(base, output);
  return output;
}));

// Where the long pauses are inside a clip — the renderer turns these into the
// "cuts" that the close-the-gap export path already drops.
ipcMain.handle('video:detectSilence', wrap(async (e, { input, startSec, endSec, noiseDb, minSilenceSec, padSec, jobId }) =>
  video.detectSilences(getCtx(), { input, startSec, endSec, noiseDb, minSilenceSec, padSec, onProgress: onProgress(e, jobId) })));
/*
 * 🤫 Remove pauses BY THE WORDS: Groq's Whisper says where the speech is, the
 * clip's own loudness says how quiet "quiet" is in this hall. See pauses.js.
 * Never falls back to transcribing on the PC — that would turn a seconds-long
 * step into minutes per clip — it answers `fallback` and the studio uses
 * silencedetect for that clip instead, and says so.
 *
 * The words are handed back too (Word Book applied, clip-relative, exactly as
 * captions:transcribe returns them), so captioning the same clip afterwards
 * costs no second request.
 */
ipcMain.handle('video:speechPauses', wrap(async (e, { input, startSec, endSec, minSilenceSec, padSec, jobId, words }) => {
  const prog = onProgress(e, jobId);
  if (!cloudspeech.fileReady()) return { fallback: true, why: 'no Groq key yet' };
  const from = Math.max(0, +startSec || 0), to = +endSec || 0;
  if (!(to > from + 0.5)) return { silences: [], engine: 'cloud' };
  const t0 = Date.now();
  let r = null;
  // the scan's cloud ear already heard this short (sermon:analyze hands its words over)
  if (Array.isArray(words) && words.length) {
    r = { words: words.map((w) => ({ text: w.text, start: w.start - from, end: w.end - from })), doneSec: to - from, model: cloudspeech.state().model };
  }
  if (!r) try {
    r = await cloudspeech.transcribeWords({ input, startSec: from, endSec: to, onProgress: (p) => prog && prog(Math.round(p * 0.8)) });
  } catch (err) {
    if (err && err.cancelled) throw new jobs.CancelledError();
    return { fallback: true, why: (err && err.message) || 'could not reach the speech service' };
  }
  if (!r || r.doneSec < (to - from) - 0.5) return { fallback: true, why: (r && r.why) || 'could not reach the speech service' };
  const env = await pauses.envelope(getCtx().ffmpeg, { input, startSec: from, endSec: to, track: (p) => jobs.track(p) });
  if (prog) prog(95);
  const abs = r.words.map((w) => ({ text: w.text, start: w.start + from, end: w.end + from }));
  const found = pauses.speechPauses(abs, env, { startSec: from, endSec: to, minSilenceSec, padSec });
  const book = wordbook.apply(r.words);
  if (prog) prog(100);
  return Object.assign({}, found, {
    engine: 'cloud', ms: Date.now() - t0,
    // …the same answer captions:transcribe would give for this clip.
    transcript: {
      words: book.entries, segments: book.entries, model: r.model, engine: 'cloud',
      engineName: cloudspeech.state().providerName + ' — Whisper Large v3 Turbo',
      fixed: book.count, fixedWords: book.count ? wordbook.summarise(book.changes, 4) : '', cloudMs: Date.now() - t0,
    },
  });
}));

// Lay background music under a finished clip (video stream is copied, not re-encoded).
ipcMain.handle('video:mixMusic', wrap(async (e, { input, musicPath, musicVolume, musicStartSec, fadeIn, fadeOut, duck, voiceVolume, jobId, outName, deleteInput }) => {
  const output = outPath(`${(outName || 'music').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await video.mixMusic(getCtx(), {
    input, output, musicPath, musicVolume, musicStartSec, fadeIn, fadeOut, duck, voiceVolume,
    onProgress: onProgress(e, jobId),
  });
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

/* =================== 🎙 VOICEOVER AND 🔊 SOUND EFFECTS ====================
 *
 * The Sounds row on the timeline. A voiceover arrives as the bytes the phone's
 * (or the desk's) microphone recorded — WebM/Opus from Chrome, MP4/AAC from
 * Safari — and is kept as an ordinary .m4a beside the exports. Sound effects
 * are made here by ffmpeg (video.SFX) the first time they are asked for.
 */
ipcMain.handle('audio:sfxList', wrap(async () =>
  Object.keys(video.SFX).map((id) => ({ id, name: video.SFX[id].name, durationSec: video.SFX[id].dur }))));
ipcMain.handle('audio:sfx', wrap(async (e, { kind } = {}) => {
  const r = video.SFX[kind];
  if (!r) throw new Error('There is no sound effect called "' + kind + '".');
  const dir = path.join(ensureOutputDir(), 'Sound effects');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${kind}.m4a`);
  if (!fs.existsSync(out) || fs.statSync(out).size < 400) await video.makeSfx(getCtx(), { kind, output: out });
  return { path: out, name: r.name, durationSec: r.dur };
}));
ipcMain.handle('audio:saveRecording', wrap(async (e, { bytes, ext } = {}) => {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (buf.length < 200) throw new Error('Nothing was recorded — check the microphone and try again.');
  if (buf.length > 300 * 1024 * 1024) throw new Error('That recording is too long to keep.');
  const tmp = path.join(require('os').tmpdir(), `mw-voice-${Date.now()}.${String(ext || 'webm').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'webm'}`);
  fs.writeFileSync(tmp, buf);
  const dir = path.join(ensureOutputDir(), 'Voiceovers');
  fs.mkdirSync(dir, { recursive: true });
  const output = path.join(dir, `voiceover-${stamp()}.m4a`);
  try { await video.saveRecording(getCtx(), { inputPath: tmp, output }); }
  finally { try { fs.unlinkSync(tmp); } catch (er) {} }
  const info = await video.getInfo(getCtx(), output);
  return { path: output, durationSec: info.durationSec || 0 };
}));
ipcMain.handle('video:mixSounds', wrap(async (e, { input, sounds, jobId, outName, deleteInput }) => {
  const output = outPath(`${(outName || 'sounds').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await video.mixSounds(getCtx(), { input, sounds: sounds || [], output, onProgress: onProgress(e, jobId) });
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

// Append (or prepend) library clips — the outro on the end of every short.
ipcMain.handle('video:appendClips', wrap(async (e, { input, clips, position, fill, jobId, outName, deleteInput }) => {
  const output = outPath(`${(outName || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  // `fill` was sent by the studio all along and dropped here, so every outro
  // card went on black bars whatever the short's own fill was
  await video.appendClips(getCtx(), { input, output, clips: clips || [], position, fill, onProgress: onProgress(e, jobId) });
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

/* ------------------------ IPC: music & clip library --------------------- */

ipcMain.handle('library:list', wrap(async () => library.list()));
ipcMain.handle('library:add', wrap(async (e, { kind, path: p, name, source }) =>
  library.add(getCtx(), video, { kind, path: p, name, source })));
ipcMain.handle('library:remove', wrap(async (e, { kind, id }) => library.remove({ kind, id })));
ipcMain.handle('library:rename', wrap(async (e, { kind, id, name }) => library.rename({ kind, id, name })));

ipcMain.handle('youtube:status', wrap(async () => library.ytStatus()));
ipcMain.handle('youtube:install', wrap(async (e, { jobId }) =>
  library.ytInstall({ onProgress: onProgress(e, jobId) })));
ipcMain.handle('youtube:search', wrap(async (e, { query, limit, copyrightFree }) => library.ytSearch({ query, limit, copyrightFree })));
ipcMain.handle('youtube:import', wrap(async (e, { url, title, jobId }) =>
  library.ytImport(getCtx(), video, { url, title, onProgress: onProgress(e, jobId) })));

/* -------------------------- IPC: sermon → shorts ------------------------ */

ipcMain.handle('sermon:analyze', wrap(async (e, { input, minLen, maxLen, idealLen, maxClips, autoLen, deep, ai, aiModel, asrModel, startSec, endSec, ranges, jobId }) => {
  const ctx = getCtx();
  const installedAsr = captioner.models().filter((m) => m.installed).map((m) => m.id);
  /*
   * WHERE THE WORDS CAN COME FROM ON THIS MACHINE. A speech model that does not
   * fit in memory is never started (captioner.fitModel) — on a small server
   * that was a crash, not a slow scan. So a deep scan needs either a model that
   * fits or the free cloud ear; with neither, it is the quick scan, and the
   * result says why.
   */
  // (Tiny counts even when it is not installed yet: transcribe fetches it)
  const localEngine = captioner.isAvailable();
  const localFits = localEngine && (installedAsr.some((id) => machine.fitsWhisper(id)) || machine.fitsWhisper('tiny.en'));
  const cloudCanHear = cloudspeech.fileReady();
  /*
   * The cloud ear on its own is enough to read the sermon. This required the
   * PC engine as well, so a server with a Groq key and no model file (the
   * Docker image) ran every "Deep" scan by sound alone — no words, so every
   * short came out titled "Key moment 4" — and said nothing about why.
   */
  const wantedDeep = deep !== false && (localEngine || cloudCanHear);
  const contentAware = wantedDeep && (localFits || cloudCanHear);
  // Return SENTENCE-level segments with clip-relative timing so the highlighter can
  // snap each clip to complete-sentence boundaries (perfect human-like start/finish),
  // with FAST greedy decoding (~2x quicker, same keywords/punctuation/timing), and
  // transcribe candidate windows CONCURRENTLY on machines with enough cores.
  //
  // WHICH SPEECH MODEL. This used to be pinned to the bundled base.en for speed,
  // back when the words were only used to nudge a cut onto a sentence edge. They
  // are not any more: the editor pass now DECIDES both cut points by reading the
  // sentences, so a mis-heard line is a mis-placed cut. On a real convention
  // recording base.en wrote "Guys, the God in this right" for "There is a God in
  // Israel" — nothing downstream can recover a thought from that. So the scan now
  // uses whatever model the operator installed in Settings — if they went and
  // fetched Small for accuracy, this is the job that most needs it.
  //
  // Medium is available here too, but only when it is ASKED for by name: see
  // captioner.pickScanModel for why automatic still stops at Small. The cache key
  // carries the model id, so switching models never mixes two sets of words for
  // the same video — it does mean a switch pays for a fresh transcription.
  let asr = captioner.pickScanModel(installedAsr, asrModel);
  // …and the one it will really be heard with, so the cache key tells the truth
  // (a model that is not on disk is not heard with either: the server image
  // carries Tiny alone, and transcribe steps down to it)
  if (!machine.fitsWhisper(asr) || !installedAsr.includes(asr)) {
    const rank = (id) => (captioner.MODELS.find((m) => m.id === id) || { rank: -1 }).rank;
    const fit = installedAsr.filter((id) => machine.fitsWhisper(id)).sort((x, y) => rank(y) - rank(x))[0];
    asr = fit || 'tiny.en';
  }
  // the CPUs and memory this process really has, not the host's (see machine.js)
  const cpus = machine.cpus();
  const asrFitsTimes = Math.max(1, Math.floor((machine.memoryMB() - machine.HEADROOM_MB) / machine.whisperNeedMB(asr)));
  const concurrency = Math.max(1, Math.min(3, Math.floor(cpus / 4), asrFitsTimes));
  const threads = Math.max(2, Math.min(8, Math.floor(cpus / concurrency)));
  // Transcript spans are CACHED on disk per video (path+size+mtime): re-running
  // the analysis — same length, another length, or after a restart — reuses every
  // span already transcribed instead of paying for whisper again.
  // The signature carries the DECODE settings, so a cache written by an older
  // pipeline is never mixed with a newer one: 'v2' is the rumble high-pass on the
  // ASR audio plus non-speech-token suppression, which change the words.
  const cacheDir = path.join(app.getPath('userData'), 'transcript-cache');
  const cache = contentAware ? new TransCache(cacheDir, input, `${asr}|segment|fast|v2`) : null;
  const localRange = async (s, en) => {
    // no engine here: a stretch the cloud could not hear is a stretch with no words
    if (!localEngine) return { segs: [] };
    const hit = cache.get(s, en);
    if (hit) return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true };
    const r = await captioner.transcribe(ctx, { input, startSec: s, endSec: en, model: asr, granularity: 'segment', fast: true, threads });
    const segs = r.words || [];
    cache.add(s, en, segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
    return { segs };
  };
  /*
   * ☁️ THE CLOUD EAR. With the cloud judge chosen and the ear left on Auto (or
   * the ear set to ☁️ Cloud), the scan is heard by Whisper Large v3 Turbo on the
   * same Groq account — the words every later decision is made from, from the
   * best model available instead of base/small on a church PC, and much faster.
   * Its own cache (a different model hears different words; the two must never
   * mix). A piece the cloud cannot hear — no internet, the free hour's audio
   * used up — is heard on this PC instead, and once the allowance has said no,
   * the rest of the scan does not keep asking.
   */
  const useCloudEar = contentAware && cloudCanHear
    && (asrModel === 'cloud' || (aiModel === 'cloud' && !asrModel)
      // a machine that cannot hold the model it would use: the cloud hears it
      || !localEngine || !localFits || (!asrModel && !machine.fitsWhisper(asr))
      // Tiny is all this machine has (the server image). Small already heard
      // "What in Nigeria" as "What an engineer" and Tiny is rougher still, so
      // a scan left on Automatic is heard in the cloud, and Tiny only hears
      // what the cloud cannot
      || (!asrModel && asr === 'tiny.en'));
  const ear = { cloud: 0, pc: 0, why: '', model: '' };
  const cloudCache = useCloudEar ? new TransCache(cacheDir, input, `cloud:${cloudspeech.state().model || 'whisper'}|segment|v1`) : null;
  // …and the word timings from the same answers, for ✂️ Remove pauses (see below)
  const wordCache = useCloudEar ? new TransCache(cacheDir, input, `cloud:${cloudspeech.state().model || 'whisper'}|words|v1`) : null;
  let cloudDown = false;
  const transcribeRange = !contentAware ? null : !useCloudEar ? localRange : (async (s, en) => {
    const hit = cloudCache.get(s, en);
    if (hit) { ear.cloud++; return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })), cached: true }; }
    if (!cloudDown) {
      try {
        const r = await cloudspeech.transcribeSegments({ input, startSec: s, endSec: en });
        cloudCache.add(s, en, r.segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
        if (r.words && r.words.length) wordCache.add(s, en, r.words.map((w) => ({ start: w.start + s, end: w.end + s, text: w.text })));
        ear.cloud++; ear.fails = 0; ear.model = r.model || ear.model;
        return { segs: r.segs };
      } catch (err) {
        if (jobs.isCancelError && jobs.isCancelError(err)) throw err;
        if (err && err.cancelled) throw err;
        ear.why = (err && err.message) || 'the cloud could not hear it';
        // the allowance or the key saying no is final for this scan; the network
        // failing twice running is too (one failure already got a retry)
        ear.fails = (ear.fails || 0) + 1;
        if (/allowance|refused|no speech key/i.test(ear.why) || ear.fails >= 2) cloudDown = true;
      }
    }
    ear.pc++;
    return localRange(s, en);
  });
  // THE READING MODEL. ☁️ Cloud AI = the large hosted model (llmjudge.makeCloudJudge),
  // otherwise the PC's own small one if the operator downloaded it, otherwise the
  // rules alone. Each returns null when it cannot run, and analyzeSermon simply
  // checks whether it got one — so "is this on?" is decided in exactly one place.
  const judge = !(ai && contentAware) ? null
    : aiModel === 'cloud' ? llmjudge.makeCloudJudge() : llmjudge.makeJudge({ model: aiModel });
  const res = await highlights.analyzeSermon(ctx, {
    input, minLen, maxLen, idealLen, maxClips, autoLen, contentAware, transcribeRange,
    // the sound is decoded in pieces at once (highlights.extractPcm): 66 min 55 s -> 24 s
    totalSec: await video.getInfo(getCtx(), input).then((i) => i.durationSec || 0).catch(() => 0),
    decodeParallel: Math.max(1, Math.min(4, Math.floor(cpus / 2) || 1)),
    // the cloud ear is not bound by this PC's cores
    concurrency: useCloudEar ? Math.max(concurrency, 3) : concurrency,
    // ...and reads fast enough to let a strong judge see a wider field: loudness
    // picks the pool, and loud is not the same as important
    poolSize: useCloudEar && judge && judge.cloud ? Math.max((maxClips || 8) + 10, 16) : undefined,
    judge,
    // only the stretch left on the timeline is searched (see analyzeSermon)
    startSec, endSec, ranges,
    onProgress: onProgress(e, jobId),
  });
  if (res && res.meta) {
    if (wantedDeep && !contentAware) {
      res.meta.lowMemory = `This server has ${machine.memoryMB()} MB of memory — too little to read the words, so these were found by the sound alone. `
        + 'Add a free Groq key to the server (GROQ_API_KEY) for the full Deep scan.';
    }
    res.meta.asrModel = !contentAware ? null : useCloudEar && ear.cloud ? 'cloud:' + (ear.model || 'whisper-large-v3-turbo') : asr;
    res.meta.ear = useCloudEar ? ear : null;
    /*
     * Every word the cloud ear heard in each short, on the source clock, when it
     * heard ALL of the short. ✂️ Remove pauses runs straight after the scan and
     * used to send each short back to be heard again, one after another — the
     * same audio, the same answer, a few seconds a short. Now it is handed these.
     */
    if (wordCache && res.clips) {
      for (const c of res.clips) {
        const spans = wordCache.spans.filter((x) => x.to > c.start && x.from < c.end).sort((x, y) => x.from - y.from);
        let reach = c.start;
        for (const x of spans) { if (x.from > reach + 0.3) break; reach = Math.max(reach, x.to); }
        if (reach < c.end - 0.3) continue;   // a stretch of it was never heard in the cloud
        const seen = new Set();
        c.words = [];
        for (const x of spans) for (const w of x.segs) {
          if (w.end <= c.start || w.start >= c.end) continue;
          const k = w.start.toFixed(2) + '|' + w.text;
          if (seen.has(k)) continue;
          seen.add(k); c.words.push(w);
        }
        c.words.sort((p, q) => p.start - q.start);
      }
    }
    // asked for the cloud judge and did not get one: say why, never silently
    if (ai && contentAware && aiModel === 'cloud' && !judge) {
      res.meta.aiMissing = cloudwrite.state().hasKey || cloudwrite.reachable() ? 'the cloud AI is resting after errors — try again in a few minutes' : 'no AI key yet';
    }
  }
  return res;
}));

/* ---------------------- IPC: the local thinking model -------------------- */

ipcMain.handle('llm:status', wrap(async () => llm.status()));
// Turning the feature on is ONE action for the operator: the ~18MB runtime and
// the chosen weights arrive together, with a single progress bar across both.
ipcMain.handle('llm:install', wrap(async (e, { modelId, jobId }) => {
  const prog = onProgress(e, jobId);
  // The runtime is a rounding error next to the weights, so it owns the first
  // 5% of the bar rather than half of it.
  await llm.installRuntime({ onProgress: (p) => prog(Math.round(p * 0.05)) });
  if (modelId) await llm.downloadModel(modelId, { onProgress: (p) => prog(5 + Math.round(p * 0.95)) });
  return llm.status();
}));
ipcMain.handle('llm:removeModel', wrap(async (e, { modelId }) => {
  llm.removeModel(modelId);
  return llm.status();
}));

// `pieces` (present when the user closed gaps on this clip) cuts the pauses out
// inside the export's own pass — no joined intermediate to render first.
ipcMain.handle('sermon:exportShort', wrap(async (e, { input, startSec, endSec, preset, quality, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, label, jobId, draft }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = outPath(`short-${safe}-${stamp()}.mp4`);
  await ffmod.asDraft(draft, () => video.exportShort(getCtx(), { input, startSec, endSec, preset: preset || 'reel-9x16', quality, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, output, onProgress: onProgress(e, jobId) }));
  return output;
}));

// Extract sample frames for on-device face tracking → returns [{t, url}] plus
// scene-cut events (camera cuts / whip pans) so tracking can snap across them.
ipcMain.handle('video:extractFrames', wrap(async (e, { input, startSec, endSec, fps, pieces, pairs }) => {
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mw-frames-'));
  const frames = await video.extractFrames(getCtx(), { input, startSec, endSec, fps: fps || 2, pieces, pairs, outDir: dir });
  return { dir, cuts: frames.cuts || [], frames: frames.map((f) => ({
    t: f.t, url: pathToFileURL(f.path).toString(), path: f.path,
    // the same instant a frame later, for the mouth-motion measure. Both forms:
    // the desktop loads the file:// URL directly, Phone Studio serves the path
    // over its own media route.
    pairUrl: f.pairPath ? pathToFileURL(f.pairPath).toString() : null,
    pairPath: f.pairPath || null,
  })) };
}));
// The picture people see before they press play. Writes a JPEG beside the short
// and embeds the same frame as cover art (see video.attachThumbnail).
ipcMain.handle('video:attachThumb', wrap(async (e, { input, imagePath, atSec }) =>
  video.attachThumbnail(getCtx(), { input, imagePath, atSec })));

ipcMain.handle('fs:rmdir', wrap(async (e, { dir }) => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {} return true; }));

// Export a speaker-following (auto-reframed) 9:16 short from face-track keyframes.
ipcMain.handle('sermon:exportReframed', wrap(async (e, { input, startSec, endSec, preset, quality, keyframes, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, label, jobId, draft }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = outPath(`short-${safe}-${stamp()}.mp4`);
  await ffmod.asDraft(draft, () => video.exportShortReframed(getCtx(), { input, startSec, endSec, preset: preset || 'reel-9x16', quality, keyframes, pieces, fill, denoise, cover, fadeIn, fadeOut, motion, output, onProgress: onProgress(e, jobId) }));
  return output;
}));

// Export a short using a MANUAL pan/zoom crop the user dragged/zoomed in the preview.
ipcMain.handle('sermon:exportFramed', wrap(async (e, { input, startSec, endSec, preset, quality, zoom, offsetX, offsetY, pieces, denoise, cover, fadeIn, fadeOut, motion, label, jobId, draft }) => {
  const safe = (label || 'short').replace(/[^\w.-]+/g, '_').slice(0, 40);
  const output = outPath(`short-${safe}-${stamp()}.mp4`);
  const res = await ffmod.asDraft(draft, () => video.exportShortFramed(getCtx(), { input, startSec, endSec, preset: preset || 'reel-9x16', quality, zoom, offsetX, offsetY, pieces, denoise, cover, fadeIn, fadeOut, motion, output, onProgress: onProgress(e, jobId) }));
  return res.output;
}));

/* --------------------------- IPC: auto-captions ------------------------- */

/*
 * Captions can be heard on this machine (whisper and its model) OR by the cloud
 * ear (a Groq key). A server built without the model file — the Docker image,
 * which ships the engine but not the model — used to answer "not available"
 * here with a Groq key in place, and every caption and Deep scan quietly
 * stood down. Either one is enough.
 */
const captionsHearable = () => captioner.isAvailable() || cloudspeech.fileReady();
ipcMain.handle('captions:available', wrap(async () => captionsHearable()));
// Why captions are / aren't usable, so the UI can say something actionable
// instead of a dead-end "not available in this build".
ipcMain.handle('captions:engineInfo', wrap(async () => {
  const info = captioner.engineInfo();
  if (!info.available && cloudspeech.fileReady()) return Object.assign({}, info, { available: true, cloudOnly: true, reason: '', howTo: '' });
  return info;
}));

/**
 * Caption transcription — ACCURACY FIRST.
 *
 * This used to default to greedy decoding (`fast`), because word-level captions
 * were produced by making whisper emit one-word segments and beam search on top
 * of that ran at ~6.5x realtime. Word timings now come from the token
 * timestamps of an ordinary decode instead, so the word chopping is free and the
 * decoder budget goes where it belongs: MEASURED on this dev laptop over 99s of
 * real sermon, beam search costs 88s against greedy's 58s, and it is beam search
 * that stops "stepping, giving God praise" coming out as "stepping go giving".
 *
 * `fast: true` is still honoured (the highlights scanner asks for it), but a
 * caption that is going to be BURNED onto a video never does.
 */
ipcMain.handle('captions:transcribe', wrap(async (e, { input, startSec, endSec, fast, denoise, model, jobId }) => {
  const prog = onProgress(e, jobId);
  const local = model === CLOUD_CAPTIONS ? undefined : model;
  if (wantsCloudCaptions(model, fast)) {
    const r = await cloudCaptions({ input, startSec, endSec, denoise, localModel: local, onProgress: prog });
    if (r) return r;
  }
  const res = await captioner.transcribe(getCtx(), { input, startSec, endSec, fast: !!fast, denoise, model: local, onProgress: prog });
  // Meant for the cloud and heard on the PC instead: say so, in the answer itself.
  const meantCloud = model === CLOUD_CAPTIONS || (!model && !fast && cloudspeech.fileReady());
  return Object.assign({}, res, {
    engine: 'pc',
    cloudWhy: meantCloud ? (cloudspeech.fileReady() ? (cloudspeech.state().why || 'the cloud could not be reached') : 'no Groq key yet') : '',
  });
}));

/* ============ ☁️ CAPTIONS HEARD BY THE FULL-SIZE WHISPER, FOR FREE ===========
 *
 * "Could the Groq API do the captions rather than medium.en? I think the API
 *  ones will be more accurate… without it I'm still doing a lot of correcting."
 *
 * They were right, and it was measured before it was built: the same 60 s of a
 * real sermon through this PC's Medium took 215 s (3.6x slower than real time),
 * Small took 64 s and heard "What in Nigeria" as "What an engineer", and Groq's
 * whisper-large-v3-turbo took 1.1 s and agreed with Medium on the hard parts.
 * The cloud model is both the more accurate AND the faster one, which is not a
 * trade the PC path ever had.
 *
 * WHEN IT IS USED. The Hearing picker's "☁️ Groq cloud" choice always asks it;
 * "Automatic" asks it whenever a Groq key exists (the one 🎤 Listen or the
 * caption writer already uses). A highlights SCAN (`fast`) stays on the PC —
 * it reads an hour at a time and would spend the whole hourly allowance.
 *
 * WHEN IT CANNOT BE. No key, no internet, allowance used up: the PC hears it
 * instead — the rest of it, if the cloud stopped part-way — and the answer
 * says which engine heard what, so the studio can say it out loud. A silent
 * fallback is how the caption writer ran on templates for a month with nobody
 * knowing (see cloudwrite.js).
 */
const CLOUD_CAPTIONS = 'cloud';
function wantsCloudCaptions(model, fast) {
  if (model === CLOUD_CAPTIONS) return true;
  // a PC model this machine cannot hold, with the cloud there to hear it
  // instead (a small server — see machine.js)
  if (model && !fast && !machine.fitsWhisper(model) && cloudspeech.fileReady()) return true;
  // …or one that is not on this machine at all (a choice remembered from
  // another install): asked of the cloud rather than quietly heard by Tiny
  if (model && !fast && cloudspeech.fileReady() && captioner.MODELS.some((m) => m.id === model)
    && !captioner.models().some((m) => m.id === model && m.installed)) return true;
  // nothing on this machine to hear it with: the cloud, whatever was asked for
  if (!captioner.isAvailable() && cloudspeech.fileReady()) return true;
  if (fast || model) return false;          // an explicit PC model, or a scan
  return cloudspeech.fileReady();
}
async function cloudCaptions({ input, startSec, endSec, denoise, localModel, onProgress: prog }) {
  if (!cloudspeech.fileReady()) return null;
  const info = await video.getInfo(getCtx(), input);
  const clip = startSec != null && endSec != null;
  const from = clip ? Math.max(0, +startSec || 0) : 0;
  const to = clip ? Math.max(from, +endSec || 0) : (info.durationSec || 0);
  const span = to - from;
  if (!(span > 0.2)) return null;
  const t0 = Date.now();
  // The cloud owns most of the bar; a PC finish (if one is needed) owns the rest.
  let r = null;
  /*
   * (A block copied here from video:speechPauses used to read that handler's
   * `words` argument — which this function has never had. `let words` further
   * down made it a ReferenceError, so EVERY caption meant for the cloud failed
   * with "Cannot access 'words' before initialization": on a server with a Groq
   * key and no speech model of its own, captions did not work at all.)
   */
  try {
    r = await cloudspeech.transcribeWords({ input, startSec: from, endSec: to, onProgress: (p) => prog && prog(Math.round(p * 0.9)) });
  } catch (err) {
    if (err && err.cancelled) throw new jobs.CancelledError();
    r = { words: [], doneSec: 0, why: (err && err.message) || 'could not reach the speech service' };
  }
  if (!r) return null;
  let words = r.words || [];
  let pcSec = 0;
  if (r.doneSec < span - 0.5) {
    // Nothing came back from the cloud at all: the ordinary PC path, which
    // reports its own progress and says why (see cloudWhy in the handler).
    if (!words.length && r.doneSec <= 0) {
      if (!captioner.isAvailable()) throw new Error('The cloud could not hear this clip (' + (r.why || 'no answer') + ') and this server has no speech model of its own to try instead.');
      return null;
    }
    if (!captioner.isAvailable()) {
      throw new Error('The cloud stopped part-way (' + (r.why || 'no answer') + ') and this server has no speech model of its own to hear the rest — try again in a minute.');
    }
    // Stopped part-way: the PC hears what is left, and the two are joined.
    const restFrom = from + r.doneSec;
    const rest = await captioner.transcribe(getCtx(), {
      input, startSec: restFrom, endSec: to, denoise, model: localModel,
      onProgress: (p) => prog && prog(90 + Math.round(p * 0.1)),
    });
    pcSec = to - restFrom;
    words = words.concat((rest.words || []).map((w) => Object.assign({}, w, { start: w.start + r.doneSec, end: w.end + r.doneSec })));
  }
  if (prog) prog(100);
  // THE WORD BOOK — the same last gate every transcription passes through.
  const book = wordbook.apply(words);
  return {
    words: book.entries, segments: book.entries,
    durationSec: info.durationSec, model: r.model || 'whisper-large-v3-turbo',
    fixed: book.count, fixedWords: book.count ? wordbook.summarise(book.changes, 4) : '',
    engine: pcSec > 0 ? 'mixed' : 'cloud',
    engineName: cloudspeech.state().providerName + ' — Whisper Large v3 Turbo',
    cloudMs: Date.now() - t0,
    cloudSec: Math.round(span - pcSec), pcSec: Math.round(pcSec),
    cloudWhy: pcSec > 0 ? r.why : '',
  };
}

/** What the Hearing picker needs to offer the cloud honestly. */
ipcMain.handle('captions:cloud', wrap(async () => {
  const st = cloudspeech.state();
  return {
    ready: cloudspeech.fileReady(), provider: st.provider, providerName: st.providerName,
    model: st.model, free: st.free, why: st.why,
    keyUrl: (cloudspeech.PROVIDERS[st.provider] || {}).keyUrl || 'https://console.groq.com/keys',
  };
}));
/** Paste a Groq key from the captions window. It is the same key 🎤 Listen uses. */
ipcMain.handle('captions:cloudKey', wrap(async (e, { key } = {}) => {
  const k = String(key || '').trim();
  if (!k) throw new Error('That key is empty.');
  saveCloudSpeech({ key: k, provider: 'groq' });
  return { ready: cloudspeech.fileReady() };
}));

/* =============== ✍ THE CAPTION PROOF-READER'S AI HALF ======================
 *
 * The rules in capgrammar.js catch the mistakes that have a pattern. What they
 * cannot catch is a word speech recognition misheard as another real word —
 * "begotten SUN", "the woman did not NO" — which needs somebody to read the
 * sentence. That is a language model's job, and it is the same free model the
 * caption writer already uses (one Groq key for everything); the PC's own model
 * is the fallback when there is no key.
 *
 * Lines go in batches with two lines of context either side, so a line split
 * from its sentence is still read in it. Every answer is held to
 * CapGrammar.vetAiLine before it is shown: a "correction" that rewrote the line
 * is thrown away, because a caption is what was SAID.
 *
 * Nothing is applied here. The studio shows each suggestion beside its line,
 * and the operator says yes.
 */
const capGrammar = require('../renderer/capgrammar.js');
ipcMain.handle('captions:grammar', wrap(async (e, { lines, before, after, caseMode, mode, jobId } = {}) => {
  const okLine = (l) => l && Number.isFinite(+l.i) && typeof l.text === 'string';
  const L = (lines || []).filter(okLine);
  // The lines either side of what was asked about: read for meaning, never returned.
  const edgeBefore = (before || []).filter(okLine).slice(-2);
  const edgeAfter = (after || []).filter(okLine).slice(0, 2);
  if (!L.length) return { fixes: [], by: '', checked: 0 };
  const cloudOk = cloudwrite.ready();
  const localOk = !cloudOk && llm.isAvailable();
  if (!cloudOk && !localOk) {
    const cw = cloudwrite.state();
    return { fixes: [], by: '', checked: 0, unavailable: true,
      why: cw.why || (cw.hasKey || cw.borrowingKey ? 'the AI writer is switched off in Settings' : 'no Groq key yet') };
  }
  const chat = cloudOk ? (a) => cloudwrite.chat(a) : (a) => llm.chat(a);
  const SIZE = cloudOk ? 40 : 12;          // the PC model gets small batches: it is slow and its context is short
  const prog = onProgress(e, jobId);
  const fixes = [];
  let asked = 0, failedBatches = 0, rejected = 0;
  for (let b = 0; b < L.length; b += SIZE) {
    if (jobs.isCancelled()) throw new jobs.CancelledError();
    const part = L.slice(b, b + SIZE);
    const ctxBefore = (b === 0 ? edgeBefore : L.slice(Math.max(0, b - 2), b)).map((l) => ({ n: l.i, text: l.text, context: true }));
    const ctxAfter = (b + SIZE >= L.length ? edgeAfter : L.slice(b + SIZE, b + SIZE + 2)).map((l) => ({ n: l.i, text: l.text, context: true }));
    const batch = ctxBefore.concat(part.map((l) => ({ n: l.i, text: l.text })), ctxAfter);
    const { system, prompt } = capGrammar.buildAiPrompt(batch, { mode });
    const answer = await chat({ system, prompt, maxTokens: cloudOk ? 2000 : 700, temperature: 0, json: true, timeoutMs: cloudOk ? 45000 : 180000 });
    asked += part.length;
    const got = capGrammar.parseAiFixes(answer, batch);
    if (!got) { failedBatches++; } else {
      for (const f of got) {
        const orig = part.find((l) => l.i === f.n);
        if (!orig) continue;
        const v = capGrammar.vetAiLine(orig.text, f.text, { caseMode, mode });
        if (v.ok) fixes.push({ i: f.n, text: v.text, why: f.why || 'AI correction' });
        else if (v.reason !== 'no change') rejected++;
      }
    }
    if (prog) prog(Math.round((Math.min(L.length, b + SIZE) / L.length) * 100));
  }
  const cw = cloudwrite.state();
  return {
    fixes, checked: asked, rejected, failedBatches,
    by: cloudOk ? `${cw.providerName}${cw.usingModel ? ' — ' + cw.usingModel : ''}` : 'the AI model on this PC',
    why: failedBatches && !fixes.length ? (cw.why || 'the AI did not answer') : '',
  };
}));

/* Optional higher-accuracy speech models (one-time download, then offline). */
ipcMain.handle('captions:models', wrap(async () => captioner.models()));
ipcMain.handle('captions:downloadModel', wrap(async (e, { id, jobId }) =>
  captioner.downloadModel(id, { onProgress: onProgress(e, jobId) })));
ipcMain.handle('captions:removeModel', wrap(async (e, { id }) => captioner.removeModel(id)));

/*
 * THE WORD BOOK — corrections the captions should stop needing.
 *
 * Everything here is text arithmetic on a list that is already in memory, so
 * none of it goes near the disk on the main thread beyond a debounced save.
 * The heavy lifting (matching, learning) is in the shared pure module; these
 * handlers only carry it across the wire. See src/main/wordbook.js.
 */
ipcMain.handle('wordbook:get', wrap(async () => ({ ...wordbook.view(), tidied: wordbook.tidyReport() })));
ipcMain.handle('wordbook:options', wrap(async (e, opts) => wordbook.setOptions(opts)));
ipcMain.handle('wordbook:addFix', wrap(async (e, { from, to }) => wordbook.addFix({ from, to, src: 'user' })));
ipcMain.handle('wordbook:updateFix', wrap(async (e, { id, patch }) => wordbook.updateFix(id, patch)));
ipcMain.handle('wordbook:removeFix', wrap(async (e, { id }) => wordbook.removeFix(id)));
ipcMain.handle('wordbook:addTerm', wrap(async (e, { text }) => wordbook.addTerm(text)));
ipcMain.handle('wordbook:removeTerm', wrap(async (e, { id }) => wordbook.removeTerm(id)));
/* One retyped caption line in, everything it taught out. Called as the operator
 * types, so it must stay cheap: it is a word-level diff of one short line. */
ipcMain.handle('wordbook:learn', wrap(async (e, { edits }) => wordbook.learnFromEdits(edits)));
ipcMain.handle('wordbook:tidy', wrap(async () => ({ ...wordbook.tidy(), view: wordbook.view() })));

ipcMain.handle('captions:fonts', wrap(async () => Object.keys(captioner.FONTS)));
// …and the same list with the file each name lives in, so the picker can render
// every option IN that font instead of just naming it.
ipcMain.handle('captions:fontList', wrap(async () => captioner.FONT_LIST.map((f) => ({ name: f.name, family: f.family, file: f.file }))));

/** Delete a burn's text-less intermediate so only the final file (with the text/
 *  captions baked in) lands in the output folder. Only ever touches files INSIDE
 *  the app's output dir — a source video the user opened can never be deleted. */
function removeIntermediate(p, output) {
  try {
    if (p && p !== output && path.dirname(p) === ensureOutputDir()) fs.rmSync(p, { force: true });
  } catch (er) {}
}

ipcMain.handle('captions:burn', wrap(async (e, { input, events, opts, jobId, outName, deleteInput }) => {
  const info = await video.getInfo(getCtx(), input);
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mw-cap-'));
  const assPath = path.join(dir, 'caps.ass');
  captioner.writeAss(events, { width: info.width, height: info.height, opts: opts || {}, output: assPath });
  const output = outPath(`${(outName || 'captioned').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await captioner.burnCaptions(getCtx(), { input, assPath, output, onProgress: onProgress(e, jobId) });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {}
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

/**
 * Burn a WYSIWYG caption track: the transparent frames the renderer drew from
 * the very layout the preview shows, composited in one pass.
 *
 * The renderer is the only text engine in the picture now, so nothing here is
 * allowed to have an opinion about fonts, wrapping or placement — this writes
 * the frames to a temp folder and hands them to ffmpeg exactly as they came.
 */
/*
 * `images` are the added-text overlays, riding along with the captions.
 *
 * They used to be a pass of their own: decode the whole short, lay one picture
 * on it, encode the whole short again — 16.7 seconds on a 30-second 9:16 short,
 * measured, before the captions did exactly the same thing all over again.
 * Composited in the same graph they cost almost nothing, and the short is
 * re-encoded once instead of twice, which is a generation of quality kept as
 * well as half the time saved.
 */
ipcMain.handle('captions:burnTrack', wrap(async (e, { input, track, jobId, outName, deleteInput, images }) => {
  const list = (images || []).filter((im) => im && im.png);
  const dir = list.length ? fs.mkdtempSync(path.join(app.getPath('temp'), 'mw-captxt-')) : null;
  const files = list.map((im, i) => {
    const p = path.join(dir, `txt${i}.png`);
    fs.writeFileSync(p, Buffer.from(im.png));
    return { path: p, start: im.start, end: im.end, anim: im.anim, cx: im.cx, cy: im.cy };
  });
  const output = outPath(`${(outName || 'captioned').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  try {
    await video.burnCaptionTrack(getCtx(), { input, track, output, images: files, onProgress: onProgress(e, jobId) });
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {} }
  }
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

// Burn positioned "add text anywhere" overlays onto a video.
ipcMain.handle('overlays:burn', wrap(async (e, { input, overlays, jobId, outName, deleteInput }) => {
  const info = await video.getInfo(getCtx(), input);
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mw-ovl-'));
  const assPath = path.join(dir, 'overlays.ass');
  captioner.writeOverlayAss(overlays || [], { width: info.width, height: info.height, output: assPath });
  const output = outPath(`${(outName || 'text').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await captioner.burnCaptions(getCtx(), { input, assPath, output, onProgress: onProgress(e, jobId) });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {}
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

// Burn "add text anywhere" overlays that the RENDERER rasterised (transparent
// PNGs at the export frame size) onto a video. This is the WYSIWYG path: the
// preview and the export share one text engine, so nothing can drift between
// what the operator placed and what lands in the file.
ipcMain.handle('overlays:burnImages', wrap(async (e, { input, images, jobId, outName, deleteInput }) => {
  const list = (images || []).filter((im) => im && im.png);
  if (!list.length) throw new Error('No text to add.');
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'mw-ovlpng-'));
  const files = list.map((im, i) => {
    const p = path.join(dir, `ovl${i}.png`);
    fs.writeFileSync(p, Buffer.from(im.png));
    return { path: p, start: im.start, end: im.end, anim: im.anim, cx: im.cx, cy: im.cy };
  });
  const output = outPath(`${(outName || 'text').replace(/[^\w.-]+/g, '_').slice(0, 60)}-${stamp()}.mp4`);
  await video.burnImageOverlays(getCtx(), { input, images: files, output, onProgress: onProgress(e, jobId) });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (er) {}
  if (deleteInput) removeIntermediate(input, output);
  return output;
}));

/* ------------------------ IPC: Bible (Presentation) --------------------- */

const bibleKey = () => ((store.get('settings') || {}).apiKeys || {}).bible || '';

ipcMain.handle('bible:catalogue', wrap(async (e, { refresh } = {}) => bible.catalogue({ refresh })));
ipcMain.handle('bible:installed', wrap(async () => bible.installed()));
ipcMain.handle('bible:download', wrap(async (e, { abbr, jobId }) =>
  bible.download(abbr, { onProgress: onProgress(e, jobId) })));
ipcMain.handle('bible:remove', wrap(async (e, { abbr }) => bible.remove(abbr)));
ipcMain.handle('bible:lookup', wrap(async (e, { translation, ref }) =>
  bible.lookup({ translation, ref, apiKey: bibleKey() })));
ipcMain.handle('bible:search', wrap(async (e, { translation, query, limit, bookNr }) =>
  bible.searchAny({ translation, query, limit, bookNr })));
ipcMain.handle('bible:books', wrap(async (e, { translation } = {}) => ({ books: await bible.books(translation) })));
ipcMain.handle('bible:chapter', wrap(async (e, { translation, bookNr, chapter }) =>
  bible.getChapter({ translation, bookNr, chapter, apiKey: bibleKey() })));
ipcMain.handle('bible:parseRef', wrap(async (e, { ref }) => bible.parseRef(ref)));
ipcMain.handle('bible:apiVersions', wrap(async () => bible.apiBibleVersions(bibleKey())));

/*
 * Verse counts for the one ambiguity 🎤 Listen has to settle — see
 * bible.verseCounts. Cached per book because it is asked on every phrase and
 * must not cost anything; falls back to "I don't know", which the parser reads
 * as "assume chapter-then-verse".
 */
const verseCountCache = new Map();
function verseCountSync(bookNr, chapter) {
  const t = presentTranslation();
  if (!t) return null;
  const key = t + ':' + bookNr;
  if (!verseCountCache.has(key)) {
    let counts = null;
    try { counts = bible.verseCounts(t, bookNr); } catch (e) { counts = null; }
    verseCountCache.set(key, counts);
  }
  const counts = verseCountCache.get(key);
  return counts && counts[chapter] != null ? counts[chapter] : null;
}
/** Whichever translation the Presentation Studio is reading from. */
let voiceTranslation = null;
const presentTranslation = () => voiceTranslation;

/* ===================== 🎤 Listen (Presentation Studio) =====================
 *
 * The renderer holds the microphone and decides when a phrase has ended; it
 * sends the samples of that one phrase here and gets back both what was heard
 * and what — if anything — the screen should do about it. Returning the text as
 * well as the instruction is deliberate: the studio shows the operator every
 * line it heard, so when it does nothing they can see WHY rather than wonder
 * whether the microphone is even working.
 */
/* ===================== THE CLOUD EAR, FROM THE STUDIO'S SIDE ===============
 *
 * cloudspeech holds the key and the allowance in memory; the SETTINGS STORE
 * holds them across restarts. These two have to be kept in step, and the place
 * that is easiest to get wrong is startup — a church that set this up last
 * Sunday must not find it off this Sunday because nothing told the module what
 * the store already knew. So the store is pushed into it once here, and again
 * on every change.
 */
function loadCloudSpeech() {
  const c = ((store.get('settings') || {}).listen || {}).cloud || {};
  return cloudspeech.configure(c);
}
function saveCloudSpeech(patch) {
  const settings = store.get('settings') || {};
  const listen = Object.assign({}, settings.listen);
  listen.cloud = Object.assign({ on: false, provider: 'groq', key: '', model: '', url: '' }, listen.cloud, patch);
  store.set('settings', Object.assign({}, settings, { listen }));
  // One Groq account, two features. The caption writer borrows this key when it
  // has none of its own, so setting the ear up sets the writer up as well.
  try { cloudwrite.shareKey(listen.cloud.provider, listen.cloud.key); } catch (e) {}
  return cloudspeech.configure(listen.cloud);
}

/* =================== WHO WRITES THE SOCIAL POSTS =========================
 *
 * Same shape as the cloud ear above, and deliberately so: the store holds it
 * across restarts, the module holds it in memory, and the two are kept in step
 * here rather than anywhere else.
 *
 * `on` defaults to TRUE, which is the opposite of the ear. The ear replaces
 * something that already works offline and costs a church nothing to leave
 * alone; this replaces copy the operator has called terrible, and it does
 * nothing at all until a key exists. So there is no reason to make somebody
 * find a switch as well as paste a key.
 */
const CLOUD_WRITE_DEFAULTS = { on: true, provider: 'groq', key: '', model: '', url: '' };
function cloudWriteCfg() {
  const s = store.get('settings') || {};
  return Object.assign({}, CLOUD_WRITE_DEFAULTS, (s.social || {}).cloud);
}
/*
 * A Groq key given to a SERVER rather than typed into Settings. The Cloud
 * Studio never opens Settings (it holds the church's keys and tokens, and the
 * page is allowed nowhere near it), so on Render, Fly or a VPS the key is an
 * environment variable — set in the host's dashboard, never in the repo. It
 * fills the same box a pasted key would, and a key saved in Settings wins.
 */
const envGroqKey = () => String(process.env.GROQ_API_KEY || process.env.MW_GROQ_KEY || '').trim();
function loadCloudWrite() {
  const listenCloud = ((store.get('settings') || {}).listen || {}).cloud || {};
  try { cloudwrite.shareKey(listenCloud.provider || 'groq', listenCloud.key || ''); } catch (e) {}
  const c = cloudWriteCfg();
  if (!c.key && (c.provider || 'groq') === 'groq' && envGroqKey()) c.key = envGroqKey();
  // …and the other way round: a Groq key pasted for the writer is a Groq key
  // the captions can transcribe with (see cloudspeech.shareKey).
  try { cloudspeech.shareKey(c.provider || 'groq', c.key || ''); } catch (e) {}
  return cloudwrite.configure(c);
}
function saveCloudWrite(patch) {
  const settings = store.get('settings') || {};
  const social = Object.assign({}, settings.social);
  social.cloud = Object.assign({}, CLOUD_WRITE_DEFAULTS, social.cloud, patch);
  store.set('settings', Object.assign({}, settings, { social }));
  const listenCloud = (settings.listen || {}).cloud || {};
  try { cloudwrite.shareKey(listenCloud.provider || 'groq', listenCloud.key || ''); } catch (e) {}
  try { cloudspeech.shareKey(social.cloud.provider || 'groq', social.cloud.key || ''); } catch (e) {}
  return cloudwrite.configure(social.cloud);
}
ipcMain.handle('voice:cloudState', wrap(async () => cloudspeech.state()));
ipcMain.handle('voice:cloudSet', wrap(async (e, patch = {}) => saveCloudSpeech(patch)));
ipcMain.handle('voice:cloudTest', wrap(async (e, patch = null) => {
  // Test what is IN THE BOXES, not what was last saved — an operator who pastes
  // a key and presses Test is asking about that key, and being told the old one
  // still works is the most confusing possible answer.
  if (patch) saveCloudSpeech(patch);
  const r = await cloudspeech.test();
  return Object.assign({}, r, { state: cloudspeech.state() });
}));
/* How often the renderer should offer a look-back, given who is listening. The
 * cloud engine has an allowance to live inside; the local one has a CPU. */
ipcMain.handle('voice:cadence', wrap(async () => (cloudspeech.ready() ? cloudspeech.cadence() : null)));

ipcMain.handle('voice:available', wrap(async () => ({
  ready: voicelisten.available(),
  how: voicelisten.how(),
  cadence: cloudspeech.ready() ? cloudspeech.cadence() : null,
})));
ipcMain.handle('voice:translation', wrap(async (e, { translation } = {}) => { voiceTranslation = translation || null; verseCountCache.clear(); return { translation: voiceTranslation }; }));
ipcMain.handle('voice:warmUp', wrap(async (e, { fast, model } = {}) => ({
  warm: await voicelisten.warmUp({ fast: !!fast, modelId: model || undefined }),
  // Which model the studio will actually be heard with, so the picker can say
  // so rather than leaving 'Auto' meaning something invisible.
  modelId: (voicelisten.engine(model || undefined) || {}).modelId || null,
  // when the resident model declines, the studio shows the reason rather
  // than leaving the operator wondering why the switch did nothing
  resident: voicelisten.whisperfast.isReady(), residentWhy: voicelisten.whisperfast.why(),
  // …and which of the two engines is really going to answer, so the picker can
  // say "hearing with Whisper Large v3 Turbo" rather than naming a local model
  // that is not being asked anything.
  how: voicelisten.how(model || undefined),
})));
/* Text straight to an instruction, with no microphone in the way. The studio's
 * own tests drive this so the path they exercise is the real parser. */
ipcMain.handle('voice:parse', wrap(async (e, { text, live } = {}) =>
  ({ text: text || '', intent: require('./voiceref').parseVoice(text, { live, verseCount: verseCountSync }) })));
ipcMain.handle('voice:hear', wrap(async (e, { pcm, live, fast, quote, model, partial, capped, local } = {}) => {
  const buf = pcm && pcm.buffer ? Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength) : Buffer.from(pcm || []);
  const pcm16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const r = await voicelisten.hear({ pcm16, live, verseCount: verseCountSync, fast: !!fast,
    /*
     * `partial || capped` is the CLOUD ALLOWANCE's question, not the studio's.
     * A phrase the ear cut at its eight-second cap is not an instruction
     * somebody paused to give — it is the middle of a sentence — and during a
     * sermon one arrives every eight seconds for forty minutes. Letting those
     * spend from the reserve kept for real instructions would empty it before
     * the sermon was half done. See the `capped` note in voiceear.js.
     */
    partial: !!partial || !!capped,
    // The close-follow look-back is answered on THIS PC whatever the ear is
    // set to — it is a yes/no about text already on the screen, not a
    // transcript, and it must not spend the cloud allowance. See voicelisten.
    local: !!local,
    // '' (automatic) must reach voicelisten as undefined so its own default —
    // the ladder — applies, rather than being resolved as a named model.
    modelId: model || undefined });
  return quote ? withQuote(r, live) : r;
}));

/* ================= LISTENING FOR A QUOTATION, NOT A REFERENCE =============
 *
 * The speaker says "give and it shall be given unto you" and never names the
 * book. voiceref.js has nothing to work with — there is no reference in that
 * sentence — so it correctly returns nothing, and the quotation matcher is
 * asked instead. See versefind.js for how it decides, and how often it
 * decides not to.
 *
 * The ORDER matters and is not arbitrary: a spoken reference always wins. If
 * somebody says "John chapter three verse sixteen" that is an instruction, and
 * an instruction must never be second-guessed by a search. Only a phrase that
 * carried no instruction at all is offered to the matcher.
 *
 * What comes back is turned into exactly the same 'ref' intent a spoken
 * reference produces, so the studio's own path — load the chapter, go to the
 * verse, leave "next verse" working — is unchanged and untested code is not
 * introduced on the way to the wall.
 */
async function withQuote(r, live) {
  if (!r || !r.ok || r.intent || !r.text) return r;
  let q = null;
  try { q = await versefind.find(r.text); } catch (err) { q = null; }
  if (!q) return r;
  // The near-misses come back too, so the studio can show WHY it stayed quiet.
  r.quote = {
    ok: !!q.ok, ref: q.ref, run: q.run, share: q.share, coverage: q.coverage,
    rare: q.rare, matchedIn: q.translation, alsoAt: q.alsoAt, spans: q.spans,
    // a short quotation put up because the translations agreed on it: how many
    agree: q.byAgreement ? q.agree : null,
  };
  if (!q.ok) return r;
  r.intent = {
    kind: 'ref', bookNr: q.bookNr, book: q.book, chapter: q.chapter,
    verses: [q.verse], ref: q.ref, said: r.text, viaQuote: true,
  };
  return r;
}

/* Build the indexes for this church's translations. Called when Listen is
 * switched on, so a church that never uses it never pays for it. */
ipcMain.handle('voice:quotePrepare', wrap(async (e, { translation } = {}) =>
  versefind.prepare(translation || voiceTranslation || null)));
ipcMain.handle('voice:quoteState', wrap(async () => versefind.state()));
/*
 * The same seam voice:parse offers, with the quotation step included: a line
 * of text goes through the REAL parser and the REAL matcher and comes back as
 * the intent the studio would have acted on. It exists so the studio's own
 * tests can drive the whole path without a microphone in it — the one thing
 * they skip is whisper, which test/voice-listen.test.js speaks at directly.
 */
ipcMain.handle('voice:hearText', wrap(async (e, { text, live, quote } = {}) => {
  const r = { ok: true, text: text || '', intent: require('./voiceref').parseVoice(text, { live, verseCount: verseCountSync }) };
  return quote ? withQuote(r, live) : r;
}));
/* Text straight in, for the studio's own tests and for the diagnostics panel. */
ipcMain.handle('voice:quoteFind', wrap(async (e, { text } = {}) => versefind.find(text)));
ipcMain.handle('bible:import', wrap(async (e, { path: p, abbr, name }) => bible.importFile(p, { abbr, name })));

/* ------------------ IPC: motion backgrounds (Presentation) -------------- */
ipcMain.handle('bgvideo:installed', wrap(async () => bgvideos.installed()));
ipcMain.handle('bgvideo:download', wrap(async (e, { id, url, jobId }) =>
  bgvideos.download(id, url, { onProgress: onProgress(e, jobId) })));
ipcMain.handle('bgvideo:remove', wrap(async (e, { id }) => bgvideos.remove(id)));

/* -------------- IPC: presentations, playlists, looks (storage) ---------- */
// Plain CRUD over the JSON store — the studio keeps the whole library in memory
// and writes back on every edit, which is fine at church scale (hundreds of
// songs, not millions) and keeps a service recoverable after a crash.
const deck = (k) => (store.get(k) || []);
ipcMain.handle('present:library', wrap(async () => ({
  presentations: deck('presentations'),
  playlists: deck('playlists'),
  themes: deck('presentThemes'),
})));
ipcMain.handle('present:savePresentation', wrap(async (e, { presentation }) => {
  const list = deck('presentations').slice();
  const i = list.findIndex((p) => p.id === presentation.id);
  if (i >= 0) list[i] = presentation; else list.unshift(presentation);
  store.set('presentations', list);
  return presentation;
}));
ipcMain.handle('present:deletePresentation', wrap(async (e, { id }) => {
  store.set('presentations', deck('presentations').filter((p) => p.id !== id));
  // and drop it from every playlist, so a service can't point at a dead deck
  store.set('playlists', deck('playlists').map((pl) =>
    Object.assign({}, pl, { items: (pl.items || []).filter((it) => it.presentationId !== id) })));
  return true;
}));
ipcMain.handle('present:savePlaylist', wrap(async (e, { playlist }) => {
  const list = deck('playlists').slice();
  const i = list.findIndex((p) => p.id === playlist.id);
  if (i >= 0) list[i] = playlist; else list.push(playlist);
  store.set('playlists', list);
  return playlist;
}));
ipcMain.handle('present:deletePlaylist', wrap(async (e, { id }) => {
  store.set('playlists', deck('playlists').filter((p) => p.id !== id));
  return true;
}));
ipcMain.handle('present:saveThemes', wrap(async (e, { themes }) => {
  store.set('presentThemes', themes || []);
  return themes || [];
}));

/* --------------------- IPC: projector / stage output -------------------- */

/* ------------------------------ IPC: songs bank -------------------------
 * The list of songs the church actually sings, drawn on week after week. The
 * catalogue ships; the WORDS are the church's own and live under userData —
 * see songbank.js for why the app has no business shipping lyrics. */
ipcMain.handle('songbank:list', wrap(async () => ({ songs: songbank.list(), themes: songbank.THEMES })));
ipcMain.handle('songbank:save', wrap(async (e, { song }) => { songbank.save(song); return songbank.list(); }));
ipcMain.handle('songbank:remove', wrap(async (e, { id }) => songbank.remove(id)));
// Pour the Library the church already has into the bank, matching by title.
ipcMain.handle('songbank:merge', wrap(async (e, { songs }) => ({ result: songbank.merge(songs), songs: songbank.list() })));

ipcMain.handle('present:displays', wrap(async () => presenter.displays()));
/*
 * "The projector was only showing my main screen and the software never noticed
 * a second screen."
 *
 * It could not: Windows was DUPLICATING one desktop onto both panels, so there
 * was genuinely only one screen to present on. This is the operator saying yes
 * to the fix — the same thing Win+P → Extend does, without leaving the studio.
 */
ipcMain.handle('present:extendScreens', wrap(async () => presenter.extendScreens()));
/*
 * `render` has to be forwarded, and its absence was invisible.
 *
 * The studio sends six arguments (the sixth being 'normal' | 'fill' | 'key' —
 * downstream keying for a switcher or NDI receiver), and this handler used to
 * destructure only the first five. Every output therefore opened in 'normal'
 * no matter what the operator picked, so Fill and Key silently did nothing in
 * the shipped app. It passed its test because the test's own stub forwards the
 * whole argument object to presenter.open() — the test was exercising a path
 * production did not have.
 */
ipcMain.handle('present:open', wrap(async (e, { role, displayId, windowed, id, name, render }) => {
  const r = presenter.open({ role, displayId, windowed, id, name, render });
  return Object.assign(r, { state: presenter.state() });
}));
ipcMain.handle('present:close', wrap(async (e, { role } = {}) => { presenter.close(role); return presenter.state(); }));
ipcMain.handle('present:state', wrap(async () => presenter.state()));
ipcMain.handle('present:set', wrap(async (e, patch) => {
  const st = presenter.setState(patch || {});
  webout.broadcast(st); // phones watching the web output follow the same cue
  ndiSend.push(st);     // …and so do the NDI feeds
  return true;
}));

/* ---------------------- IPC: NDI output (send) -------------------------- */
ndiSend.setStateSource(() => presenter.getState());
ipcMain.handle('ndiout:state', wrap(async () => ndiSend.state()));
ipcMain.handle('ndiout:start', wrap(async (e, a = {}) => {
  const r = ndiSend.start(a);
  ndiSend.push(presenter.getState());
  return Object.assign({ feed: r }, ndiSend.state());
}));
ipcMain.handle('ndiout:stop', wrap(async (e, { id } = {}) => { ndiSend.stop(id); return ndiSend.state(); }));

/* ------------------ IPC: DMX lighting over Art-Net ---------------------- */
ipcMain.handle('dmx:state', wrap(async () => artnet.state()));
ipcMain.handle('dmx:configure', wrap(async (e, a = {}) => artnet.configure(a)));
ipcMain.handle('dmx:send', wrap(async (e, { command, universe, channel, value } = {}) => {
  if (command) return { sent: artnet.command(command), state: artnet.state() };
  return { sent: [artnet.setChannel(universe || 0, channel, value)], state: artnet.state() };
}));
ipcMain.handle('dmx:blackout', wrap(async (e, { universe } = {}) => artnet.blackout(universe || 0)));

/* ------------- IPC: web output (phones / tablets / Stream Deck) ---------- */
// Commands arriving over HTTP are handed to the studio, which is the only thing
// that knows what "next" means — the server never touches the cue itself.
webout.setCommandHandler((cmd, arg) => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('present:remote', { cmd, arg });
  }
});
/*
 * …and the same for the switcher, so a SECOND MACHINE running this app can cut,
 * fade and start a broadcast on this one. Deliberately the same road: a control
 * message is a few dozen bytes and one IPC send, so linking two machines costs
 * the desk nothing measurable — the video, if it is wanted at all, goes over
 * NDI, which is a separate and much heavier decision.
 */
webout.setLiveCommandHandler((cmd, arg) => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('live:remote', { cmd, arg });
  }
});
ipcMain.handle('webout:start', wrap(async (e, { port, passcode, allowControl } = {}) => {
  const r = await webout.start({ port: port || 7373, passcode: passcode || '', allowControl: allowControl !== false });
  webout.broadcast(presenter.getState());
  return Object.assign(r, webout.state());
}));
ipcMain.handle('webout:stop', wrap(async () => { webout.stop(); return webout.state(); }));
ipcMain.handle('webout:state', wrap(async () => webout.state()));

/* ----------------- IPC: Phone Studio (the Video Studio, on a phone) ------- */

/**
 * The folders a paired phone may read from and write into. Deliberately short:
 * finished exports, whatever a phone has sent over, the temp files the studio
 * makes for previews and tracking, the music/outro library, the AI assets, and
 * the user's own Videos folder (where the church's recordings land). Nothing
 * else on this machine is reachable, whatever the phone asks for.
 */
function phoneDirs() {
  const userData = app.getPath('userData');
  return {
    output: ensureOutputDir(),
    uploads: path.join(userData, 'phone-uploads'),
    temp: app.getPath('temp'),
    videos: app.getPath('videos') || '',
    library: path.join(userData, 'library'),
    ai: aiDir(),
  };
}

function phoneSettings() {
  const s = store.get('settings') || {};
  return Object.assign({ enabled: false, port: 7380, pin: '', allowUpload: true }, s.phone || {});
}
function savePhoneSettings(patch) {
  const s = store.get('settings') || {};
  const next = Object.assign({}, phoneSettings(), patch);
  store.set('settings', Object.assign({}, s, { phone: next }));
  return next;
}

async function startPhone(overrides = {}) {
  const ps = savePhoneSettings(Object.assign({}, overrides, { enabled: true }));
  const st = await phone.start({
    port: Number(ps.port) || 7380,
    pin: ps.pin || '',
    allowUpload: ps.allowUpload !== false,
    dirs: phoneDirs(),
    appVersion: appVersion(),
  });
  // A PIN generated on first start belongs in settings too, or the next launch
  // shows a different number to the phone that is already paired.
  if (st.pin && st.pin !== ps.pin) savePhoneSettings({ pin: st.pin });
  return st;
}

ipcMain.handle('phone:start', wrap(async (e, { port, allowUpload } = {}) =>
  startPhone({ port: port || phoneSettings().port, allowUpload: allowUpload !== false })));
ipcMain.handle('phone:stop', wrap(async () => { phone.stop(); savePhoneSettings({ enabled: false }); return phone.state(); }));
ipcMain.handle('phone:state', wrap(async () => Object.assign({}, phone.state(), { autoStart: !!phoneSettings().enabled })));
ipcMain.handle('phone:newPin', wrap(async () => {
  const pin = phone.resetPin();
  savePhoneSettings({ pin });
  return phone.state();
}));

/* --------- IPC: Cloud Studio (the Video Studio, from anywhere) ----------- */

/*
 * Phone Studio is this machine on the church wifi. Cloud Studio is this machine
 * from a train in another country: the same idea carried the whole way, with a
 * real web app (a PWA, installable to a home screen) and a tunnel out to the
 * internet so no router has to be opened. See src/cloud/.
 *
 * The folders it may touch are the phone's list plus three: the fonts the
 * caption preview loads, the sessions folder an edit is exported to, and the
 * cloud's own uploads. Everything else on this machine stays unreachable,
 * whatever a signed-in browser asks for.
 */
function cloudDirs() {
  const userData = app.getPath('userData');
  return {
    output: ensureOutputDir(),
    uploads: path.join(userData, 'cloud-uploads'),
    temp: app.getPath('temp'),
    videos: app.getPath('videos') || '',
    library: path.join(userData, 'library'),
    sessions: path.join(userData, 'sessions'),
    fonts: (() => { try { return captioner.fontsDir(); } catch (e) { return ''; } })(),
    ai: aiDir(),
  };
}

function cloudSettings() {
  const s = store.get('settings') || {};
  return Object.assign({
    enabled: false,
    port: 7390,
    code: '',
    allowUpload: true,
    // A public address is a separate decision from switching the studio on: on
    // the church wifi the local address is enough, and going through a tunnel
    // is what puts this machine on the internet.
    tunnel: false,
    tunnelToken: '',      // set for a FIXED address from a Cloudflare account
  }, s.cloud || {});
}
function saveCloudSettings(patch) {
  const s = store.get('settings') || {};
  const next = Object.assign({}, cloudSettings(), patch);
  store.set('settings', Object.assign({}, s, { cloud: next }));
  return next;
}

/** The whole picture the Settings panel draws: server, tunnel and address. */
function cloudState() {
  const cs = cloudSettings();
  return Object.assign({}, cloud.state(), {
    autoStart: !!cs.enabled,
    tunnel: Object.assign({}, tunnel.status(), { wanted: !!cs.tunnel, hasToken: !!cs.tunnelToken }),
  });
}

async function startCloud(overrides = {}) {
  const cs = saveCloudSettings(Object.assign({}, overrides, { enabled: true }));
  const st = await cloud.start({
    port: Number(cs.port) || 7390,
    code: cs.code || '',
    allowUpload: cs.allowUpload !== false,
    dirs: cloudDirs(),
    tokenFile: path.join(app.getPath('userData'), 'cloud-sessions.json'),
    appVersion: appVersion(),
  });
  // A code generated on first start belongs in settings too, or next launch
  // shows a different one to the phone that is already signed in.
  if (st.code && st.code !== cs.code) saveCloudSettings({ code: st.code });
  return st;
}

/** Open the public door, and keep the app's copy of the address in step. */
async function startTunnel() {
  const cs = cloudSettings();
  tunnel.setToolsDir(() => path.join(app.getPath('userData'), 'tools'));
  const r = await tunnel.start(Number(cs.port) || 7390, {
    token: cs.tunnelToken || '',
    onUrl: (u) => {
      cloud.setPublicUrl(u);
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('cloud:url', { url: u });
      }
    },
  });
  saveCloudSettings({ tunnel: true });
  return r;
}

ipcMain.handle('cloud:start', wrap(async (e, { port, allowUpload } = {}) =>
  startCloud({ port: port || cloudSettings().port, allowUpload: allowUpload !== false })));
ipcMain.handle('cloud:stop', wrap(async () => {
  try { tunnel.stop(); } catch (er) {}
  cloud.stop();
  saveCloudSettings({ enabled: false, tunnel: false });
  return cloudState();
}));
ipcMain.handle('cloud:state', wrap(async () => cloudState()));
ipcMain.handle('cloud:status', wrap(async () => cloud.status()));
ipcMain.handle('cloud:newCode', wrap(async (e, { code } = {}) => {
  const next = cloud.resetCode(code);
  saveCloudSettings({ code: next });
  return cloudState();
}));
ipcMain.handle('cloud:setUpload', wrap(async (e, { allow }) => {
  saveCloudSettings({ allowUpload: !!allow });
  if (cloud.isRunning()) await startCloud({ allowUpload: !!allow });
  return cloudState();
}));
ipcMain.handle('cloud:tunnelInstall', wrap(async (e, { jobId } = {}) => {
  tunnel.setToolsDir(() => path.join(app.getPath('userData'), 'tools'));
  return tunnel.install({ onProgress: onProgress(e, jobId) });
}));
ipcMain.handle('cloud:tunnelStart', wrap(async () => {
  if (!cloud.isRunning()) await startCloud({});
  return startTunnel();
}));
ipcMain.handle('cloud:tunnelStop', wrap(async () => {
  tunnel.stop();
  cloud.setPublicUrl('');
  saveCloudSettings({ tunnel: false });
  return cloudState();
}));
ipcMain.handle('cloud:tunnelToken', wrap(async (e, { token }) => {
  saveCloudSettings({ tunnelToken: String(token || '').trim() });
  return cloudState();
}));

/* ------------------------------ IPC: flyer ------------------------------ */

ipcMain.handle('flyer:render', wrap(async (e, { html, width, height, name }) => {
  const output = outPath(`${(name || 'flyer').replace(/[^\w.-]+/g, '_')}-${stamp()}.png`);
  await flyer.renderFlyer({ html, width, height, output });
  return output;
}));

// Save image bytes rasterized in the renderer (canvas) — screen-independent path.
ipcMain.handle('flyer:savePng', wrap(async (e, { name, bytes, ext }) => {
  const safeExt = ext === 'jpg' || ext === 'jpeg' ? 'jpg' : 'png';
  const output = outPath(`${(name || 'flyer').replace(/[^\w.-]+/g, '_') || 'flyer'}-${stamp()}.${safeExt}`);
  fs.writeFileSync(output, Buffer.from(bytes));
  return output;
}));

// Bundled flyer fonts as base64 so the renderer can build data-URI @font-face
// rules — file:// fonts do NOT load inside the SVG-foreignObject export, but
// data: URIs do, and the same CSS then works for the live canvas AND exports.
ipcMain.handle('fonts:data', wrap(async () => {
  const dir = captioner.fontsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => ({ file: f, base64: fs.readFileSync(path.join(dir, f)).toString('base64') }));
}));

/* ---------------------------- IPC: scheduler ---------------------------- */

/*
 * ✨ Write the post for me. The local thinking model when the church has one,
 * the built-in rules when it does not — the button works either way, which is
 * the whole point of it (see social-copy.js).
 */
ipcMain.handle('social:suggestCopy', wrap(async (e, { mediaPath, kind, durationSec, listen = true, quick = false, jobId } = {}) => {
  const s = store.get('settings') || {};
  const churchName = (s.brand && s.brand.churchName) || '';
  // The two facts that make a caption postable rather than generic: WHERE it
  // happened and WHO said it. Set once, in Settings, and used on every clip.
  const social = s.social || {};
  const eventName = String(social.eventName || '').trim();
  const speakers = String(social.speakers || '').split(/[,;\r\n]+/).map((x) => x.trim()).filter(Boolean);
  const allowBait = !!social.allowBait;

  /*
   * LISTEN TO THE CLIP FIRST.
   *
   * A file name is a guess; the transcript is what the video actually says, and
   * copy written from a guess is confidently wrong — which for a church is worse
   * than copy that is merely dull. So the words come first and everything else
   * is a fallback for clips that have no speech in them (a flyer, a music bed).
   *
   * ►► AND WHO DOES THE LISTENING DECIDES HOW GOOD THE COPY CAN BE. ◄◄
   *
   * The words are the raw material. Everything downstream — which line to quote,
   * what the clip is even about, which of four preachers is speaking — is read
   * out of them, so a transcript full of mistakes produces copy that is fluent
   * and wrong. That is the real reason the captions were poor, and it is only
   * half fixable by writing a better prompt.
   *
   * On this PC the speech model is `base.en` or `small.en`, run in "fast" mode
   * because nobody will wait four minutes for a caption, and capped at 150
   * seconds for the same reason. In the cloud it is the full-size Whisper on
   * hardware built for it: more accurate AND fast enough to read fifteen minutes
   * of a service rather than the first two and a half. The cloud goes first and
   * this PC is what happens when there is no key, no internet, or no allowance
   * left — see src/main/cloudspeech.js.
   */
  const LISTEN_MAX_SEC = 150;          // this PC: what it can read before the operator gives up
  const CLOUD_MAX_SEC = 900;           // the cloud: enough of a service to know what it is about
  let transcript = '';
  let heardBy = '';
  let dur = 0;
  const isVideo = /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(String(mediaPath || ''));
  if (listen && isVideo && mediaPath && fs.existsSync(mediaPath)) {
    const info = await video.getInfo(getCtx(), mediaPath).catch(() => null);
    dur = (info && info.durationSec) || 0;
    if (cloudspeech.fileReady()) {
      try {
        const words = await cloudspeech.transcribeFile({
          input: mediaPath, startSec: 0,
          endSec: dur ? Math.min(dur, CLOUD_MAX_SEC) : CLOUD_MAX_SEC,
          maxSec: CLOUD_MAX_SEC,
          onProgress: onProgress(e, jobId),
        });
        // '' means it listened and there is no speech in the clip — a flyer, a
        // music bed. That is an ANSWER, and running whisper over it again to be
        // told the same thing is a minute of somebody's life.
        if (words !== null) { transcript = words; heardBy = 'cloud'; }
      } catch (er) { transcript = ''; }
    }
    if (!heardBy) {
      try {
        if (await captioner.isAvailable()) {
          const end = Math.min(LISTEN_MAX_SEC, dur || LISTEN_MAX_SEC);
          const res = await captioner.transcribe(getCtx(), {
            input: mediaPath, startSec: 0, endSec: end, fast: true,
            onProgress: onProgress(e, jobId),
          });
          transcript = ((res && res.words) || []).map((w) => w.text).join(' ').trim();
          if (!transcript && res && Array.isArray(res.events)) {
            transcript = res.events.map((x) => x.text).join(' ').trim();
          }
          if (transcript) heardBy = 'local';
        }
      } catch (er) { transcript = ''; }
    }
  }

  /*
   * THEN WHO WRITES IT. The hosted model when there is one, the local one when
   * the church installed it, and the rules when neither — in that order,
   * because that is the order of how good the answer is. `polish` is the second
   * editing pass, and it is offered only to the hosted model: on a 1.5B model
   * on a church PC it would cost a minute and make the copy worse.
   */
  const cloudReady = cloudwrite.ready();
  const writer = cloudReady
    ? { isAvailable: () => cloudwrite.isAvailable(), chat: (a) => cloudwrite.chat(a),
        parseJson: (t) => cloudwrite.parseJson(t), polish: true }
    : { isAvailable: () => llm.isAvailable(), chat: (a) => llm.chat(a), parseJson: (t) => llm.parseJson(t) };

  const out = await socialCopy.suggest({
    // The clip's real length, when we had to open it anyway to listen to it.
    // A writer told "a 41-second clip" writes to 41 seconds.
    mediaPath, kind, durationSec: durationSec || Math.round(dur) || 0,
    churchName, eventName, speakers, allowBait, transcript, llm: writer, quick: !!quick,
  });
  // The operator has to be able to see WHY a caption is good or poor — which
  // ear heard the clip and which writer wrote it. Without this, "it's terrible
  // again" has no diagnosis.
  /*
   * WHY THE RULES WROTE IT, WHEN THEY DID.
   *
   * This used to report a reason only when the writer was not READY, which is
   * the one case that never actually happens to a church that has set it up.
   * The case that happens is: ready, asked, and it did not answer — a retired
   * model, an allowance used up, a refused key. Reporting '' for that is how an
   * operator ends up staring at template copy with nothing to go on.
   */
  const cw = cloudwrite.state();
  const rules = out.source !== 'ai';
  return Object.assign({}, out, {
    heardBy,
    wroteBy: out.source === 'ai' ? (cloudReady ? 'cloud' : 'local') : 'rules',
    writerName: cloudReady ? cw.providerName : '',
    writerWhy: !rules ? ''
      : (cw.why || (cloudReady ? '' : (cw.hasKey || cw.borrowingKey ? 'it is switched off' : 'no key yet'))),
  });
}));

/* The cloud writer's own settings, the same three calls the cloud ear has. */
ipcMain.handle('social:cloudState', wrap(async () => cloudwrite.state()));
// 🎯 Auto-reframe asks the cloud WHO is preaching; the PC still says where. Same key as the writer and Listen.
ipcMain.handle('reframe:aiState', wrap(async () => cloudsee.state()));
ipcMain.handle('reframe:whoIsSpeaking', wrap(async (e, a) => cloudsee.whoIsSpeaking(a || {})));
ipcMain.handle('social:cloudSet', wrap(async (e, patch = {}) => saveCloudWrite(patch)));
ipcMain.handle('social:cloudTest', wrap(async (e, patch = null) => {
  // Test what is IN THE BOXES, not what was last saved — an operator who pastes
  // a key and presses Test is asking about that key.
  if (patch) saveCloudWrite(patch);
  const r = await cloudwrite.test();
  return Object.assign({}, r, { state: cloudwrite.state() });
}));

// 🗓 Work out when a batch of posts should go out (see schedule-plan.js).
ipcMain.handle('social:planSchedule', wrap(async (e, { count, spacingHours } = {}) =>
  schedulePlan.planSchedule({ count, spacingHours }).map((p) => ({
    iso: p.iso, label: p.label, dayLabel: p.dayLabel, timeLabel: p.timeLabel,
  }))));

/*
 * Each person's posts are their own (space.js): a post remembers whose space
 * made it, the list shows only that space's, and nobody can move, post or
 * delete a post that is not theirs. The posting itself is one service for the
 * whole studio, so everybody's posts still go out on time.
 */
const myPost = (p) => !!p && (p.owner || null) === space.current();
const myPosts = () => scheduler.list().filter(myPost);
const ownPost = (id) => {
  if (!myPost(scheduler.list().find((p) => p.id === id))) throw new Error('That post is not in your space.');
  return id;
};
ipcMain.handle('scheduler:list', wrap(async () => myPosts()));
ipcMain.handle('scheduler:add', wrap(async (e, { post }) => scheduler.add(Object.assign({}, post, { owner: space.current() }))));
// Moving or rewording a post gives back whatever booking a platform is
// holding for it and takes a new one — see Scheduler.reschedule.
ipcMain.handle('scheduler:update', wrap(async (e, { id, patch }) => {
  const clean = Object.assign({}, patch); delete clean.owner;
  return scheduler.reschedule(ownPost(id), clean);
}));
ipcMain.handle('scheduler:remove', wrap(async (e, { id }) => scheduler.remove(ownPost(id))));
ipcMain.handle('scheduler:publish', wrap(async (e, { id }) => scheduler.publishNow(ownPost(id))));
// Real auto-posting: publish this post to the connected Facebook Page right now.
ipcMain.handle('scheduler:publishAuto', wrap(async (e, { id }) => scheduler.autoPublish(ownPost(id))));
ipcMain.handle('scheduler:retry', wrap(async (e, { id }) => scheduler.retry(ownPost(id))));
// Which of a post's accounts the PLATFORM is holding, and which still need
// this PC switched on. The Scheduler page shows this per post, because the
// difference is real and the operator has to be able to see it.
ipcMain.handle('scheduler:plans', wrap(async () => {
  const out = {};
  for (const p of myPosts()) {
    if (p.status !== 'scheduled' && p.status !== 'failed') continue;
    out[p.id] = scheduler.handoffPlan(p);
  }
  return out;
}));
ipcMain.handle('scheduler:handOff', wrap(async (e, { id }) => scheduler.handOff(ownPost(id))));

/* --------- IPC: posting while the app is closed (src/main/autopost.js) -------
 * The studio only ever asks the OS to run the poster; it never posts on the
 * poster's behalf. `enable` writes the OS task, and `status` reports what the
 * OS ACTUALLY has rather than what we last saved, so a task deleted in Windows'
 * own Task Scheduler shows up as off here too.
 */
const autopostOpts = () => ({ packaged: app.isPackaged, appDir: path.resolve(__dirname, '..', '..') });
ipcMain.handle('autopost:status', wrap(async () => autopost.status(app.getPath('userData'), autopostOpts())));
ipcMain.handle('autopost:enable', wrap(async (e, { everyMinutes }) =>
  autopost.enable(app.getPath('userData'), everyMinutes, autopostOpts())));
ipcMain.handle('autopost:disable', wrap(async () => autopost.disable(app.getPath('userData'), autopostOpts())));
ipcMain.handle('autopost:runNow', wrap(async () => {
  // "Check now" from the Scheduler: publish anything already due, here, so the
  // operator watches the cards change instead of waiting for the next round.
  await scheduler.tickNow();
  return autopost.status(app.getPath('userData'), autopostOpts());
}));
// "Test it now": start the REAL background process and wait for it to report.
// This is the only button that proves the thing the user actually asked for —
// that a post goes out with no studio involved — so it must not shortcut to
// the local tick above.
ipcMain.handle('autopost:testBackground', wrap(async () => {
  const userData = app.getPath('userData');
  const started = await autopost.runNow(userData, { ...autopostOpts(), force: true });
  const run = await autopost.waitForRun(userData, 60000);
  return { started, run, status: await autopost.status(userData, autopostOpts()) };
}));

// Verify a Page ID + token pair before saving (Settings → Test connection).
/* ------------------------ IPC: linked social accounts ------------------------ */

ipcMain.handle('accounts:list', wrap(async () => accounts.list()));
ipcMain.handle('accounts:connectFb', wrap(async () => accounts.connectFacebook(mainWindow)));
ipcMain.handle('accounts:connectYt', wrap(async () => accounts.connectYouTube(mainWindow)));
ipcMain.handle('accounts:connectTk', wrap(async () => accounts.connectTikTok(mainWindow)));
ipcMain.handle('accounts:connectTkEasy', wrap(async () => accounts.connectTikTokEasy(mainWindow)));
// Instagram through Upload-Post: the second cloud route, and the one that
// matters when a church has used up Zernio's free slots. Meta itself offers no
// way to book an Instagram post in advance, so one of these two IS the fix.
ipcMain.handle('accounts:connectUpIg', wrap(async () => accounts.connectUploadPost(mainWindow, { platform: 'instagram' })));
ipcMain.handle('accounts:connectZo', wrap(async () => accounts.connectZernio(mainWindow)));
ipcMain.handle('accounts:connectZoYt', wrap(async () => accounts.connectZernio(mainWindow, { platform: 'youtube' })));
ipcMain.handle('accounts:connectZoFb', wrap(async () => accounts.connectZernio(mainWindow, { platform: 'facebook' })));
ipcMain.handle('accounts:connectZoIg', wrap(async () => accounts.connectZernio(mainWindow, { platform: 'instagram' })));
ipcMain.handle('accounts:add', wrap(async (e, { connectId, selections }) => accounts.addFromConnect(connectId, selections)));
ipcMain.handle('accounts:remove', wrap(async (e, { id }) => accounts.remove(id)));
ipcMain.handle('accounts:check', wrap(async (e, { id }) => accounts.check(id)));

/* ------------- IPC: the Social Scheduler, from a phone (Cloud Studio) ---------
 * The desk's account channels above open windows and wait on this machine.
 * These are the halves a phone can use: the accounts WITHOUT their keys, the
 * Zernio keys going IN and never coming back out (only "is one set"), and the
 * two-step easy connect (accounts.zernioLinkStart / zernioLinkClaim). They are
 * the only social channels the cloud allowlist admits — see cloud-api.js.
 */
const SOCIAL_KEYS = ['zoApiKey', 'zoApiKeyFb'];
function socialKeyState() {
  const acc = ((store.get('settings') || {}).accounts) || {};
  return { zo: !!String(acc.zoApiKey || '').trim(), zoFb: !!String(acc.zoApiKeyFb || '').trim() };
}
ipcMain.handle('social:accounts', wrap(async () => ({ accounts: accounts.list(), keys: socialKeyState() })));
ipcMain.handle('social:setKeys', wrap(async (e, patch = {}) => {
  const s = store.get('settings') || {};
  const acc = { ...(s.accounts || {}) };
  for (const k of SOCIAL_KEYS) {
    if (!patch || !(k in patch)) continue;
    const v = String(patch[k] == null ? '' : patch[k]).trim();
    if (v.length > 400 || /\s/.test(v)) {
      throw new Error('That does not look like a Zernio API key — copy it again from zernio.com → Settings → API keys.');
    }
    acc[k] = v;
  }
  store.set('settings', { ...s, accounts: acc });
  return socialKeyState();
}));
ipcMain.handle('social:linkStart', wrap(async (e, { platform } = {}) => accounts.zernioLinkStart(platform)));
ipcMain.handle('social:linkClaim', wrap(async (e, { platform } = {}) => accounts.zernioLinkClaim(platform)));
ipcMain.handle('social:unlink', wrap(async (e, { id } = {}) => accounts.remove(id)));
ipcMain.handle('social:check', wrap(async (e, { id } = {}) => accounts.check(id)));

ipcMain.handle('scheduler:testFb', wrap(async (e, { pageId, token }) => {
  const acc = (store.get('settings') || {}).accounts || {};
  return publisher.testFacebook({
    pageId: pageId || acc.fbPageId, token: token || acc.fbToken, apiBase: acc.fbApiBase,
  });
}));

/* ---------------------------- IPC: live stream -------------------------- */
// vMix-style multi-destination streaming. The renderer captures the program
// ONCE (one MediaRecorder) and ProgramHub encodes it ONCE; every streaming
// destination and the program recording then attach to that single encode as
// independent outputs. See src/main/livestream.js for why the intermediate is
// MPEG-TS — it is what lets destination 3 join while 1 and 2 are already live.

ipcMain.handle('live:destinations', wrap(async () => ({
  destinations: DESTINATIONS, qualities: QUALITIES,
  qualityGroups: QUALITY_GROUPS, legacyQuality: LEGACY_QUALITY, defaultQuality: DEFAULT_QUALITY,
  audioQualities: AUDIO_QUALITIES, defaultAudioQuality: DEFAULT_AUDIO_QUALITY,
  // What each picture size costs on a platform — the page needs it to say
  // whether a stream will be reported as under-rated (see streamrate.js).
  rateTiers: require('./streamrate').TIERS,
})));

/** Route a hub output's events to the renderer under its own channel prefix. */
function wireHub(sender) {
  hub.onEvent = (id, type, payload) => {
    const isRec = id === 'main' || id === 'replay';
    const chan = isRec ? 'rec:' + type : 'live:' + type;
    const key = isRec ? { recId: id, file: hubRecFiles.get(id) } : { destId: id };
    try { if (!sender.isDestroyed()) sender.send(chan, { ...key, ...payload }); } catch (er) {}
    if (type === 'ended' && isRec) hubRecFiles.delete(id);
  };
  hub.onHubEvent = (type, payload) => {
    if (type === 'restart-needed') {
      // The program encoder stopped but destinations are still attached — ask
      // the renderer for a fresh capture session; the outputs resynchronise.
      try { if (!sender.isDestroyed()) sender.send('program:restart', payload || {}); } catch (er) {}
    } else if (type === 'bitrate') {
      // AUTO-FIT: the hub has decided the picture has to change size to fit
      // the line (or has been told it cannot). The renderer owns the encoder,
      // so only it can actually do this — see live.js onBitrate.
      try { if (!sender.isDestroyed()) sender.send('program:bitrate', payload || {}); } catch (er) {}
    } else if (type === 'encoder-fallback') {
      try { if (!sender.isDestroyed()) sender.send('program:encoder', { encoder: payload.to, fellBackFrom: payload.from }); } catch (er) {}
    }
  };
}

/**
 * Bind the hub to the renderer's program capture session. Called every time the
 * renderer creates its program MediaRecorder; a new `sid` replaces the hub
 * encoder while leaving the attached destinations connected.
 */
ipcMain.handle('program:session', wrap(async (e, { sid, width, height, videoKbps, audioKbps, fps, format,
                                                   forStream, lineCapKbps, minKbps, sampleRate }) => {
  wireHub(e.sender);
  const s = (store.get('settings') || {});
  const pref = s.liveEncoder || 'auto';
  const res = await hub.session(getCtx(), {
    sid, width, height, videoKbps, audioKbps, fps, encoder: pref,
    // The rate the renderer's AAC is genuinely at — see _canCopyAudio. A page
    // too old to send it is taken at the value the rest of the app assumes.
    sampleRate: Number(sampleRate) || OUT_SAMPLE_RATE,
    // Only a platform has a recommended bitrate to fall short of, and only a
    // measured line can say how much of it is honestly reachable.
    forStream: !!forStream, lineCapKbps: Number(lineCapKbps) || 0,
    // Auto-fit is on unless the operator turned it off in Streaming Settings.
    autoFit: s.autoFitBitrate !== 'off',
    /*
     * "Never send less than this." Default 'auto' = the platform's own rate for
     * the picture, so auto-fit may soften the picture but may not take it under
     * the number the low-bitrate warning is measured against — see RateFit's
     * hardFloor for the one exception (a destination actually losing picture).
     */
    minKbps: minKbps != null ? minKbps : ((s.live && s.live.minKbps) || 'auto'),
    // A user who pinned a specific encoder (e.g. "Software only" because the
    // picture glitched) wants the hub to do the encoding — no GPU passthrough.
    format: pref === 'auto' ? format : 'webm',
  });
  return { ...res, sid };
}));

ipcMain.handle('live:start', wrap(async (e, { destId, dest, key, customUrl, quality, fps }) => {
  if (!destId) throw new Error('destId required');
  const { buildUrl } = require('./livestream');
  const q = QUALITIES[quality] || QUALITIES['720p'];
  const url = buildUrl({ dest, key, customUrl });
  wireHub(e.sender);
  // Preset fps (Twitch p60/p30) wins; otherwise follow the renderer's
  // production frame rate so the output matches the camera (no 25↔30 judder).
  const r = hub.addOutput(getCtx(), destId, { kind: 'rtmp', url, q, fps: q.fps || fps });
  return { running: true, quality: q, copying: r.copying, encoder: hub.encoder };
}));

// High-frequency chunk feed — fire-and-forget (not invoke) to keep latency low.
// One consumer now (the hub), so a chunk is never parsed more than once.
// The renderer's answer to an auto-fit rate change: did its encoder take it?
// A refusal switches auto-fit off rather than leaving the hub believing it is
// sending less than it is.
// A platform joined a session that was created for a recording: raise the
// shared encode to what that platform charges for this picture, in place.
ipcMain.handle('program:rerate', wrap(async (e, { videoKbps } = {}) => hub.reRate(videoKbps)));

ipcMain.on('live:bitrateApplied', (e, payload) => {
  try { hub.rateApplied((payload && payload.videoKbps) || 0, !!(payload && payload.ok)); } catch (er) {}
});

ipcMain.on('live:chunk', (e, payload) => {
  const sid = payload && payload.sid;
  const raw = payload && payload.buf ? payload.buf : payload;
  try { hub.write(sid, Buffer.from(raw)); } catch (er) {}
});

// destId omitted = stop everything (used for "Stop All" / app shutdown).
ipcMain.handle('live:stop', wrap(async (e, { destId } = {}) => {
  if (destId) await hub.removeOutput(destId);
  else {
    await Promise.all([...hub.outputs.keys()]
      .filter((id) => !isProgramRec(id))
      .map((id) => hub.removeOutput(id)));
  }
  if (!hub.outputCount) await hub.stop();
  return true;
}));

ipcMain.handle('live:state', wrap(async () => {
  const out = {};
  for (const id of hub.outputs.keys()) {
    if (id === 'main' || id === 'replay') continue;
    out[id] = hub.outputState(id);
  }
  return out;
}));

// What the program encoder is actually doing — surfaced in Production Settings
// so "is this using my graphics card?" is answerable without guessing.
ipcMain.handle('live:engine', wrap(async () => {
  const s = (store.get('settings') || {});
  const enc = hub.running ? (hub.activeEncoder || hub.encoder) : await detectEncoder(getCtx().ffmpeg, s.liveEncoder || 'auto');
  return {
    encoder: enc, label: encoderLabel(enc), hardware: enc !== 'libx264',
    preference: s.liveEncoder || 'auto', running: hub.running,
    outputs: hub.outputCount, gpu: s.gpuAcceleration !== 'off',
  };
}));

/**
 * Which of these destinations could NOT be copied from one shared encode, and
 * would therefore run a second live encode on this machine?
 *
 * Answered HERE, by the same module that spawns the outputs, because the
 * Streaming Settings dialog used to answer it itself with a simpler rule — it
 * compared only the frame size — and so told operators that everything was fine
 * while a bitrate difference silently started a second 1080p encode mid-service.
 */
ipcMain.handle('live:copyCheck', wrap(async (e, { qualities, fps } = {}) => {
  const qs = (qualities || []).map((q) => (typeof q === 'string' ? QUALITIES[q] : q)).filter(Boolean);
  return { reEncoded: reEncodedAmong(qs, fps), tolerance: COPY_BITRATE_TOLERANCE };
}));

/*
 * WILL SUNDAY FIT DOWN THIS LINE?
 *
 * Measured BEFORE the service, because the alternative is finding out from the
 * pew: two 1080p destinations need ~12.3 Mbps, and when the line cannot carry
 * that, one of them starves while the other stays perfect — which reads as the
 * platform's fault rather than the connection's. See uplink.js.
 */
ipcMain.handle('live:uplinkTest', wrap(async (e, { qualities, fps } = {}) => {
  const uplink = require('./uplink');
  const m = await uplink.measure({
    onProgress: (p) => { if (e && e.sender && !e.sender.isDestroyed()) e.sender.send('live:uplinkProgress', p); },
  });
  if (!m.ok) return m;
  const qs = (qualities || []).map((q) => (typeof q === 'string' ? QUALITIES[q] : q)).filter(Boolean);
  // The production frame rate is part of the price: a platform asks for half as
  // much again at 60fps as at 30, and 'Auto' follows the camera — so a 60fps
  // camcorder quietly changes what this line has to carry.
  const p = uplink.plan(qs, m.mbps, QUALITIES, fps);
  return Object.assign({ ok: true, mbps: m.mbps, host: m.host, samples: m.samples }, p,
    { verdict: uplink.verdict(p) });
}));

/* --------------------- IPC: program recording (vMix) --------------------- */
// Record and Instant Replay both capture the PROGRAM, so they attach to the
// same single encode the streaming destinations use — recording while streaming
// costs a remux, not a whole extra encode. MultiCorder is different: it records
// individual inputs, each with its own capture, so those keep a LiveStream each.

const isProgramRec = (recId) => recId === 'main' || recId === 'replay';

ipcMain.handle('rec:start', wrap(async (e, { recId, name, quality, fps, audioFormat }) => {
  if (!recId) throw new Error('recId required');
  const q = QUALITIES[quality] || QUALITIES['720p'];
  // The recording's audio format decides the container, so it decides the file
  // extension too — writing MKV bytes into a .mp4 name is how you get a file
  // that "won't open" for a completely different reason than the one we fixed.
  const fmtId = audioFormat || ((store.get('settings') || {}).live || {}).recAudioFormat || DEFAULT_REC_FORMAT;
  const fmt = recFormat(fmtId);
  const file = outPath(`${String(name || 'recording').replace(/[^\w.-]+/g, '_').slice(0, 40)}-${stamp()}${fmt.ext}`);

  if (isProgramRec(recId)) {
    wireHub(e.sender);
    hubRecFiles.set(recId, file);
    try {
      hub.addOutput(getCtx(), recId, { kind: 'file', filePath: file, q, fps: q.fps || fps, recFormat: fmt.id });
    } catch (err) { hubRecFiles.delete(recId); throw err; }
    return { file, audioFormat: fmt.id };
  }

  if (recorders.has(recId)) throw new Error('That recorder is already running — stop it first.');
  const rec = new LiveStream();
  rec.onEvent = (type, payload) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('rec:' + type, { recId, file, ...payload }); } catch (er) {}
    if (type === 'ended') recorders.delete(recId);
  };
  rec.start(getCtx(), { filePath: file, videoKbps: q.videoKbps, audioKbps: q.audioKbps,
    fps: q.fps || fps, profile: q.profile, recFormat: fmt.id,
    encoder: await detectEncoder(getCtx().ffmpeg, (store.get('settings') || {}).liveEncoder || 'auto') });
  recorders.set(recId, rec);
  return { file, audioFormat: fmt.id };
}));

// The recording audio formats this build can write, for the settings dialog.
ipcMain.handle('rec:formats', wrap(async () => ({
  formats: REC_FORMATS.map((f) => ({ id: f.id, ext: f.ext, label: f.label, hint: f.hint })),
  current: ((store.get('settings') || {}).live || {}).recAudioFormat || DEFAULT_REC_FORMAT,
})));

// High-frequency chunk feed — fire-and-forget to keep latency low. Only
// MultiCorder still uses this; program recording rides the hub.
ipcMain.on('rec:chunk', (e, { recId, buf }) => {
  const rec = recorders.get(recId);
  if (rec) { try { rec.write(Buffer.from(buf)); } catch (er) {} }
});

ipcMain.handle('rec:stop', wrap(async (e, { recId }) => {
  if (isProgramRec(recId)) {
    await hub.removeOutput(recId);
    hubRecFiles.delete(recId);
    if (!hub.outputCount) await hub.stop();
    return true;
  }
  const rec = recorders.get(recId);
  if (rec) { await rec.stop(); recorders.delete(recId); }
  return true;
}));

/* ----------------- IPC: screen capture + system metrics ----------------- */

ipcMain.handle('live:screenSources', wrap(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
}));

ipcMain.handle('live:pickScreen', wrap(async (e, { id }) => { chosenScreenId = id || null; return true; }));

// CPU % for the vMix-style status bar. This is WHOLE-MACHINE usage (like vMix
// and Task Manager), not just Electron's own processes: the app's heaviest
// work happens in child ffmpeg processes that app.getAppMetrics() cannot see,
// which is how the bar once read "15%" while the machine was actually at 98%.
let _cpuSample = null;
function systemCpuPct() {
  const os = require('os');
  const now = os.cpus().map((c) => c.times);
  let idle = 0, total = 0;
  if (_cpuSample && _cpuSample.length === now.length) {
    for (let i = 0; i < now.length; i++) {
      const a = _cpuSample[i], b = now[i];
      idle += b.idle - a.idle;
      total += (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + (b.idle - a.idle);
    }
  }
  _cpuSample = now;
  if (total <= 0) return null; // first sample — nothing to diff yet
  return Math.max(0, Math.min(100, 100 * (1 - idle / total)));
}
ipcMain.handle('live:metrics', wrap(async () => {
  const sys = systemCpuPct();
  // This app's own share, scaled to the whole machine like Task Manager's
  // per-process column (percentCPUUsage is per-core). Child ffmpeg helpers
  // aren't visible to getAppMetrics, but with GPU capture they only remux, so
  // this is within a couple of points of the true figure.
  const cores = require('os').cpus().length || 1;
  const appCpu = app.getAppMetrics().reduce((s, p) => s + ((p.cpu && p.cpu.percentCPUUsage) || 0), 0) / cores;
  return { cpu: sys != null ? Math.round(sys * 10) / 10 : Math.round(appCpu * 10) / 10,
           appCpu: Math.round(appCpu * 10) / 10 };
}));

/* --------------- IPC: Web Browser / Video Call / PowerPoint input -------- */
// A hidden offscreen-rendered Chromium window whose frames are streamed to
// the renderer as JPEGs — the engine behind the "Web Browser", "Video Call"
// (a Jitsi Meet room opened through it) and "PowerPoint" (a converted PDF
// paged through it) Input Select categories.

ipcMain.handle('browser:open', wrap(async (e, { id, url }) => {
  if (browserSources.has(id)) throw new Error('That browser source is already open.');
  const bs = new BrowserSource(id, (buf, w, h) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('browser:frame', { id, buf, w, h }); } catch (er) {}
  });
  browserSources.set(id, bs);
  try {
    await bs.load(url);
  } catch (err) {
    bs.destroy(); browserSources.delete(id);
    throw err;
  }
  return true;
}));

ipcMain.handle('browser:nav', wrap(async (e, { id, url }) => {
  const bs = browserSources.get(id);
  if (!bs) throw new Error('That browser source is not open.');
  await bs.load(url);
  return true;
}));

ipcMain.handle('browser:close', wrap(async (e, { id }) => {
  const bs = browserSources.get(id);
  if (bs) { bs.destroy(); browserSources.delete(id); }
  return true;
}));

/* -------------------- IPC: Stream / SRT network ingest ------------------- */

ipcMain.handle('netstream:start', wrap(async (e, { id, url }) => {
  if (netStreams.has(id)) throw new Error('That network stream is already running.');
  const framePath = path.join(app.getPath('temp'), `mw-netstream-${id}.jpg`);
  const ns = new NetStream();
  ns.onEvent = (type, payload) => {
    try { if (!e.sender.isDestroyed()) e.sender.send('netstream:' + type, { id, ...payload }); } catch (er) {}
    if (type === 'ended') netStreams.delete(id);
  };
  ns.start(getCtx(), { url, framePath });
  netStreams.set(id, ns);
  return { framePath };
}));

ipcMain.handle('netstream:stop', wrap(async (e, { id }) => {
  const ns = netStreams.get(id);
  if (ns) { await ns.stop(); netStreams.delete(id); }
  return true;
}));

/* ----------------------------- IPC: NDI input ---------------------------- */
// Real NDI receive: discover sources on the LAN, then pull a source's video and
// audio. NOTHING about a frame is handled here — the receiver child process and
// the renderer are joined by a MessagePort and exchange frames directly, so this
// process never serializes, copies or encodes a pixel. That matters because this
// is also the process that feeds ffmpeg: when it used to encode each NDI frame
// to JPEG (~16 ms at 1080p, ~51 ms at 4K) the broadcast starved for exactly that
// long, every frame. See src/main/ndi-proc.js.

const ndiIpc = ndi.registerIpc(ipcMain, wrap);

/* --------------------- IPC: PowerPoint via LibreOffice -------------------- */
// Chromium can display a PDF natively (through the Web Browser engine above),
// but not a .pptx — LibreOffice, if installed, converts it to a PDF first.

function findSoffice() {
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
      ]
    : process.platform === 'darwin'
    ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
    : ['/usr/bin/soffice', '/usr/bin/libreoffice'];
  return candidates.find((c) => { try { return fs.existsSync(c); } catch (e) { return false; } }) || null;
}

ipcMain.handle('ppt:check', wrap(async () => ({ available: !!findSoffice() })));

// LibreOffice's headless --convert-to is known to occasionally exit 0 without
// actually writing a file (usually when a previous soffice process is still
// tearing down) — one quick retry clears this up almost every time.
function runSofficeConvert(soffice, outDir, pptxPath) {
  return new Promise((resolve, reject) => {
    const p = spawn(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, pptxPath], { windowsHide: true });
    const killTimer = setTimeout(() => {
      try { p.kill(); } catch (e) {}
      reject(new Error('LibreOffice took too long to convert the file — if it is already open elsewhere, close it and try again.'));
    }, 30000);
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e2) => { clearTimeout(killTimer); reject(e2); });
    p.on('close', (code) => {
      clearTimeout(killTimer);
      code === 0 ? resolve() : reject(new Error('LibreOffice conversion failed: ' + (err.slice(-300) || `exit code ${code}`)));
    });
  });
}

ipcMain.handle('ppt:convert', wrap(async (e, { pptxPath }) => {
  const soffice = findSoffice();
  if (!soffice) throw new Error('LibreOffice is not installed. Install it free from libreoffice.org to enable PowerPoint import.');
  const base = path.basename(pptxPath, path.extname(pptxPath));
  let pdfPath = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    const outDir = path.join(app.getPath('temp'), `mw-ppt-${Date.now()}-${attempt}`);
    fs.mkdirSync(outDir, { recursive: true });
    await runSofficeConvert(soffice, outDir, pptxPath);
    const candidate = path.join(outDir, base + '.pdf');
    if (fs.existsSync(candidate)) { pdfPath = candidate; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!pdfPath) throw new Error('LibreOffice did not produce a PDF. Try again — this occasionally happens right after LibreOffice has just closed.');
  return { pdfPath };
}));

/* ------------------------------ IPC: shell ------------------------------ */

ipcMain.handle('shell:openExternal', wrap(async (e, { url }) => { await shell.openExternal(url); return true; }));
ipcMain.handle('shell:showItem', wrap(async (e, { path: p }) => { shell.showItemInFolder(p); return true; }));
ipcMain.handle('shell:openPath', wrap(async (e, { path: p }) => { await shell.openPath(p); return true; }));
ipcMain.handle('fs:readImageDataUrl', wrap(async (e, { path: p }) => {
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase() || 'png';
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${buf.toString('base64')}`;
}));
// A picture the renderer produced (a background cut out, for instance) written
// back to disk, so the timeline and the exporter can treat it like any other file.
ipcMain.handle('fs:writeImageDataUrl', wrap(async (e, { dataUrl, name }) => {
  const m2 = /^data:image\/([a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m2) throw new Error('That is not an image.');
  const ext = m2[1].toLowerCase() === 'jpeg' ? 'jpg' : m2[1].toLowerCase();
  const dir = path.join(app.getPath('temp'), 'mw-cutouts');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'cutout').replace(/[^\w.-]+/g, '_').slice(0, 50);
  const out = path.join(dir, `${safe}-${Date.now()}.${ext}`);
  fs.writeFileSync(out, Buffer.from(m2[2], 'base64'));
  return out;
}));
ipcMain.handle('fs:writeText', wrap(async (e, { path: p, text }) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, 'utf-8');
  return p;
}));
ipcMain.handle('fs:readText', wrap(async (e, { path: p }) => fs.readFileSync(p, 'utf-8')));
// Bundled HD photo backgrounds for the flyer maker (readable from app.asar too).
ipcMain.handle('photos:list', wrap(async () => {
  const dir = path.join(__dirname, '..', 'renderer', 'assets', 'photos');
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.jpe?g$/i.test(f))
      .map((f) => ({ name: f, path: path.join(dir, f) }));
  } catch (err) { return []; }
}));
