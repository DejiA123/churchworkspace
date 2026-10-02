'use strict';
/*
 * RUNNING THE APP WITH NO APP.
 *
 * The Cloud Studio can run on a server with the desktop switched off. The
 * tempting way to build that is a second, slimmer backend that registers "just
 * the video channels". That way lies exactly the rot this whole project was
 * built to avoid: two implementations of `sermon:analyze`, one of which gets
 * the fix.
 *
 * So the server runs THE REAL src/main/main.js — all 195 handlers, the same
 * ffmpeg arguments, the same whisper ladder, the same caption burner — with a
 * stand-in for Electron underneath it. That is possible because of something
 * true of this codebase and rare elsewhere: the Video Studio's engine modules
 * (video.js, captioner.js, highlights.js, sessions.js, library.js, wordbook.js,
 * llm.js, ffmpeg.js, store.js) do not import Electron at all. Only main.js and
 * the windowing modules do, and between them they touch a small, listable
 * surface — `app.getPath`, a BrowserWindow that is only ever used to post
 * messages at, a screen list, two dialogs, a protocol handler.
 *
 * All of that is answered here. The rules the stubs follow:
 *
 *   • paths are REAL: userData, temp and videos are actual directories, because
 *     everything downstream writes to them.
 *   • windows are honest fakes: `isDestroyed()` says true, so every
 *     `mainWindow.webContents.send(…)` in main.js becomes a no-op instead of
 *     pretending a studio is listening.
 *   • anything that would put something on a screen, in a menu, or in front of
 *     a person does nothing and says so — there is no screen.
 *
 * What this shim deliberately does NOT do is neutralise the app's background
 * behaviour (the social scheduler, the "keep posting with the app closed"
 * heartbeat). Those are decisions, not Electron, so they are made out in the
 * open in server.js where they can be seen.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ paths */

function mkdir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (e) {} return p; }

function makePaths(root, mediaRoot) {
  const home = os.homedir();
  const map = {
    home,
    appData: path.dirname(root),
    userData: root,
    sessionData: path.join(root, 'session'),
    temp: mkdir(path.join(os.tmpdir(), 'church-work-space')),
    exe: process.execPath,
    module: process.execPath,
    desktop: mediaRoot,
    documents: mediaRoot,
    downloads: mediaRoot,
    music: mediaRoot,
    pictures: mediaRoot,
    videos: mediaRoot,
    logs: path.join(root, 'logs'),
    crashDumps: path.join(root, 'crash'),
  };
  return map;
}

/* --------------------------------------------------------------- the stubs */

/**
 * A window that is not there.
 *
 * `isDestroyed()` returning true is the important line in this file. main.js
 * guards every message to the studio with it — so with no window, nothing is
 * sent, nothing queues up, and nothing throws. Saying "I am alive" here would
 * make the app talk to a wall for as long as the server runs.
 */
class FakeWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.id = FakeWindow._n = (FakeWindow._n || 0) + 1;
    this.webContents = Object.assign(new EventEmitter(), {
      id: this.id,
      send() {},
      isDestroyed() { return true; },
      setWindowOpenHandler() {},
      openDevTools() {},
      closeDevTools() {},
      executeJavaScript: () => Promise.resolve(null),
      setAudioMuted() {},
      getOSProcessId() { return process.pid; },
      session: { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, clearCache: () => Promise.resolve() },
      focus() {},
      capturePage: () => Promise.resolve({ toPNG: () => Buffer.alloc(0) }),
    });
    FakeWindow._all.push(this);
    /*
     * A real BrowserWindow has upwards of a hundred methods, and main.js calls
     * whichever ones a window needs — removeMenu, setVibrancy, flashFrame. Any
     * one of them missing is a crash at boot, and listing them all here would be
     * a list that goes stale the next time a window gains a line.
     *
     * So anything not defined above answers as a no-op. That is the right
     * default for a window that is not on a screen: every one of those methods
     * exists to change how something LOOKS, and there is nothing to look at.
     * Anything that returns a value a caller might act on is defined properly
     * above, so it cannot silently answer `undefined`.
     */
    return new Proxy(this, {
      get(target, prop, recv) {
        if (prop in target) return Reflect.get(target, prop, recv);
        if (typeof prop === 'symbol' || prop === 'then' || prop === 'inspect' || prop === 'toJSON') return undefined;
        return () => undefined;
      },
    });
  }
  static getAllWindows() { return FakeWindow._all.slice(); }
  static fromWebContents() { return null; }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  show() {} hide() {} focus() {} blur() {} close() {} destroy() {}
  maximize() {} minimize() {} restore() {} center() {}
  setBounds() {} setPosition() {} setSize() {} setFullScreen() {} setAlwaysOnTop() {}
  setMenu() {} setMenuBarVisibility() {} setIgnoreMouseEvents() {} setBackgroundColor() {}
  isDestroyed() { return true; }
  isVisible() { return false; }
  isMinimized() { return false; }
  isFullScreen() { return false; }
  getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  once(ev, fn) {
    // `once('ready-to-show')` is how a window is shown; there is no window, so
    // it will never be ready, and calling back would only run show() code.
    return super.once(ev, fn);
  }
}
FakeWindow._all = [];

function makeApp(paths, version) {
  const app = new EventEmitter();
  let ready = false;
  const overrides = {};

  Object.assign(app, {
    name: 'Church Work Space',
    isPackaged: false,
    commandLine: { appendSwitch() {}, appendArgument() {}, hasSwitch: () => false, getSwitchValue: () => '' },
    getPath(n) {
      const p = overrides[n] || paths[n];
      if (!p) throw new Error('Unknown path: ' + n);
      if (n !== 'exe' && n !== 'module') mkdir(p);
      return p;
    },
    setPath(n, v) { overrides[n] = v; mkdir(v); },
    getAppPath: () => path.join(__dirname, '..', '..'),
    getVersion: () => version,
    getName() { return app.name; },
    setName(n) { app.name = n; },
    getLocale: () => 'en-GB',
    whenReady() {
      // Resolved on the next turn, so main.js finishes registering its handlers
      // at module scope before its ready block runs — the same order Electron
      // gives it.
      return new Promise((res) => setImmediate(() => { ready = true; res(app); }));
    },
    isReady: () => ready,
    quit() { process.emit('mw-quit'); },
    exit(code) { process.exit(code || 0); },
    relaunch() {},
    focus() {},
    disableHardwareAcceleration() {},
    getAppMetrics: () => [],
    requestSingleInstanceLock: () => true,
    setLoginItemSettings() {},
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setAppUserModelId() {},
    on: app.on.bind(app),
  });
  return app;
}

/* ------------------------------------------------------------------ ipcMain */

/**
 * The IPC bus, with no renderer on the other end.
 *
 * `handle()` behaves exactly as Electron's does — which matters, because
 * src/main/rpc.js patches this very method to record every channel, and the
 * cloud server then calls those recorded functions. Everything downstream of
 * that patch works unchanged.
 */
function makeIpcMain() {
  const handlers = new Map();
  const listeners = new EventEmitter();
  return {
    handle(channel, fn) { handlers.set(channel, fn); },
    handleOnce(channel, fn) { handlers.set(channel, fn); },
    removeHandler(channel) { handlers.delete(channel); },
    on: listeners.on.bind(listeners),
    once: listeners.once.bind(listeners),
    off: listeners.off.bind(listeners),
    removeAllListeners: listeners.removeAllListeners.bind(listeners),
    emit: listeners.emit.bind(listeners),
    _handlers: handlers,
  };
}

/* -------------------------------------------------------------- the module */

function build({ dataDir, mediaDir, version }) {
  const root = mkdir(dataDir);
  const media = mkdir(mediaDir || path.join(root, 'media'));
  const paths = makePaths(root, media);

  const shim = {
    app: makeApp(paths, version || '0.0.0'),
    BrowserWindow: FakeWindow,
    ipcMain: makeIpcMain(),
    // A server has no screens. Returning an empty list is the truth, and every
    // caller in the app already copes with it (a machine can have no projector).
    screen: Object.assign(new EventEmitter(), {
      getAllDisplays: () => [],
      getPrimaryDisplay: () => ({ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      getDisplayNearestPoint: () => null,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    }),
    dialog: {
      // There is nobody at this machine to answer a dialog. Cancelled is the
      // only honest answer, and every caller already handles a cancel.
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true, filePath: '' }),
      showMessageBox: async () => ({ response: 0 }),
      showErrorBox() {},
    },
    shell: {
      openPath: async () => '',
      openExternal: async () => undefined,
      showItemInFolder() {},
      beep() {},
    },
    protocol: {
      registerSchemesAsPrivileged() {},
      handle() {},
      unhandle() {},
      isProtocolHandled: () => false,
    },
    desktopCapturer: { getSources: async () => [] },
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'dark' }),
    nativeImage: { createEmpty: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }), createFromPath: () => ({ isEmpty: () => true }) },
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({ popup() {} }) },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} destroy() {} },
    globalShortcut: { register: () => false, unregister() {}, unregisterAll() {} },
    powerSaveBlocker: { start: () => 0, stop() {}, isStarted: () => false },
    powerMonitor: new EventEmitter(),
    clipboard: { writeText() {}, readText: () => '' },
    session: { defaultSession: { setDisplayMediaRequestHandler() {}, setPermissionRequestHandler() {}, clearCache: async () => {} }, fromPartition: () => ({}) },
    net: { fetch: (...a) => fetch(...a), isOnline: () => true },
    /*
     * NDI's receiver runs in an Electron utilityProcess and talks to the studio
     * window over a MessagePort. There is no window here and no NDI on a server,
     * so asking for one fails loudly rather than hanging: `ndi:start` is not on
     * the cloud allowlist, and nothing else calls it.
     */
    utilityProcess: { fork() { throw new Error('NDI is not available on a cloud server — it needs the studio machine.'); } },
    MessageChannelMain: class { constructor() { this.port1 = null; this.port2 = null; } },
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: new EventEmitter(),
  };
  shim.default = shim;
  return { shim, paths };
}

/**
 * Put the shim in front of `require('electron')` for this process.
 *
 * Patching the loader rather than the require cache is deliberate: the cache is
 * keyed by RESOLVED path, and in a checkout without Electron installed there is
 * no path to resolve — the require would throw before the cache was consulted.
 */
function install(opts) {
  const built = build(opts);
  const Module = require('module');
  if (!Module.__mwElectronShim) {
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
      if (request === 'electron') return Module.__mwElectronShim;
      return load.apply(this, arguments);
    };
    Object.defineProperty(Module, '__mwElectronShim', { value: built.shim, writable: true, enumerable: false });
  } else {
    Module.__mwElectronShim = built.shim;
  }
  return built;
}

module.exports = { install, build, FakeWindow };
