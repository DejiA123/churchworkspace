'use strict';
/**
 * Real NDI® (Network Device Interface) engine for the Go Live switcher.
 *
 * Church setups run vMix, PTZ cameras, ProPresenter, OBS and other gear that
 * publish video AND audio over NDI. This module discovers those sources on the
 * LAN and receives them — video and audio, including audio-only NDI streams
 * (e.g. "vMix Audio - Master") — so they can be mixed like any other input.
 *
 * It drives the installed NDI runtime DLL directly through koffi (a prebuilt
 * FFI — no native compilation), matching the flat C API of the NDI SDK.
 *
 * Discovery runs on the main thread (find_get_current_sources is fast and
 * non-blocking). Receiving runs in a dedicated utilityProcess (src/main/
 * ndi-proc.js) whose synchronous capture loop drains video+audio at full rate.
 * That child talks DIRECTLY to the renderer over a MessagePort, so neither a
 * pixel nor an audio sample is ever handled by the main process — which is what
 * keeps main free to feed the broadcast encoder. See ndi-proc.js for why.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { utilityProcess, MessageChannelMain } = require('electron');
const { loadNdi } = require('./ndi-ffi');

let ndi = null;         // { koffi, lib, T, F, arrType } once loaded
let loaded = false;
let available = false;
let loadError = null;
let dllPath = null;
let finder = null;

/* ------------------------- locate the NDI runtime ------------------------- */

function findDll() {
  const c = [];
  const envDirs = [
    process.env.NDI_RUNTIME_DIR_V6, process.env.NDI_RUNTIME_DIR_V5,
    process.env.NDI_RUNTIME_DIR_V4, process.env.NDI_RUNTIME_DIR_V3, process.env.NDI_RUNTIME_DIR_V2,
  ].filter(Boolean);

  // macOS: the NDI runtime is a .dylib (installed by "NDI Tools"/the NDI SDK).
  if (process.platform === 'darwin') {
    for (const d of envDirs) { c.push(path.join(d, 'libndi.dylib')); c.push(path.join(d, 'libndi.4.dylib')); }
    c.push('/usr/local/lib/libndi.dylib');
    c.push('/opt/homebrew/lib/libndi.dylib');
    c.push('/Library/NDI SDK for Apple/lib/macOS/libndi.dylib');
    c.push('/Library/Application Support/NewTek/NDI/libndi.dylib');
    if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'ndi', 'libndi.dylib'));
    return c.find((p) => { try { return p && fs.existsSync(p); } catch (e) { return false; } }) || null;
  }

  for (const d of envDirs) c.push(path.join(d, 'Processing.NDI.Lib.x64.dll'));
  // Common install locations (NDI Tools / redistributables, newest first).
  c.push('C:\\Program Files\\NDI\\NDI 6 Runtime\\v6\\Processing.NDI.Lib.x64.dll');
  c.push('C:\\Program Files\\NDI\\NDI 5 Runtime\\v5\\Processing.NDI.Lib.x64.dll');
  c.push('C:\\Program Files\\NewTek\\NDI 5 Runtime\\v5\\Processing.NDI.Lib.x64.dll');
  c.push('C:\\Program Files\\NewTek\\NDI 4 Runtime\\v4\\Processing.NDI.Lib.x64.dll');
  c.push('C:\\Program Files\\NDI.tv\\NDI 4 Tools\\Runtime\\Processing.NDI.Lib.x64.dll');
  // Bundled fallback if we ever ship the redistributable next to the app.
  if (process.resourcesPath) c.push(path.join(process.resourcesPath, 'ndi', 'Processing.NDI.Lib.x64.dll'));
  // Last resort: the runtime DLL other NDI apps bundle — church PCs often have
  // vMix installed but never ran the separate "NDI Tools" installer.
  c.push('C:\\Program Files (x86)\\vMix\\ndi\\x64\\Processing.NDI.Lib.dll');
  c.push('C:\\Program Files\\vMix\\ndi\\x64\\Processing.NDI.Lib.dll');
  c.push('C:\\Program Files (x86)\\SplitmediaLabs\\XSplit Broadcaster\\x64\\Processing.NDI.Lib.x64.dll');
  return c.find((p) => { try { return p && fs.existsSync(p); } catch (e) { return false; } }) || null;
}

function ensureLoaded() {
  if (loaded) return available;
  loaded = true;
  try {
    dllPath = findDll();
    if (!dllPath) {
      loadError = process.platform === 'darwin'
        ? 'NDI runtime not found. Install the free "NDI Tools" for macOS from ndi.video, then restart. (NDI receiving on macOS is best-effort.)'
        : 'NDI runtime not installed. Install "NDI Tools" (free) from ndi.video, then restart.';
      return false;
    }
    ndi = loadNdi(dllPath);
    if (ndi.F.is_supported_cpu && !ndi.F.is_supported_cpu()) { loadError = 'This CPU is not supported by the NDI runtime.'; return false; }
    if (!ndi.F.init()) { loadError = 'NDIlib_initialize() failed.'; return false; }
    available = true;
  } catch (e) {
    available = false;
    loadError = 'Could not load the NDI runtime: ' + (e && e.message ? e.message : e);
  }
  return available;
}

/* ------------------------------ discovery --------------------------------- */

/** Split "MACHINE (Source Name)" into its parts for a friendly display. */
function parseSource(name, url) {
  const m = /^(.*?)\s*\((.*)\)\s*$/.exec(name || '');
  const machine = m ? m[1].trim() : (name || '');
  const stream = m ? m[2].trim() : (name || '');
  return { name: name || '', url: url || '', machine, stream, display: stream || name || '' };
}

function startDiscovery() {
  if (!ensureLoaded()) return false;
  if (!finder) {
    // show_local_sources so the operator can pick this machine's own outputs too.
    finder = ndi.F.find_create({ show_local_sources: true, p_groups: null, p_extra_ips: null });
  }
  return !!finder;
}

/** Current known NDI sources on the network. Non-blocking. */
function getSources() {
  if (!startDiscovery()) return [];
  try {
    const n = [0];
    const ptr = ndi.F.find_sources(finder, n);
    if (!n[0] || !ptr) return [];
    const arr = ndi.koffi.decode(ptr, ndi.T.source, n[0]);
    return arr.map((s) => parseSource(s.p_ndi_name, s.p_url_address));
  } catch (e) {
    return [];
  }
}

function getStatus() {
  ensureLoaded();
  return { available, dll: dllPath, error: available ? null : loadError, machine: os.hostname() };
}

/* ------------------------------- receiver --------------------------------- */

/**
 * One live NDI receiver, backed by a utilityProcess (src/main/ndi-proc.js).
 *
 * Video and audio do NOT come back through here — the caller supplies a
 * MessagePortMain (`opts.port`) whose other end is held by the renderer, and the
 * child posts frames straight down it. Nothing about a frame is ever serialized,
 * copied or encoded on the main process, which is the whole point: main stays
 * free to feed the broadcast encoder. See the header of ndi-proc.js for the
 * measurements behind that.
 *
 * What still arrives here is the control plane: `cb.onStatus({connections})` is
 * a ~1 Hz heartbeat and `cb.onError(msg)` fires if the receiver cannot start.
 */
class NdiReceiver {
  constructor(source, opts, cb) {
    if (!ensureLoaded()) throw new Error(loadError || 'NDI is not available.');
    const o = opts || {};
    this.cb = cb || {};
    this.stopped = false;
    this.child = utilityProcess.fork(path.join(__dirname, 'ndi-proc.js'), [], {
      serviceName: 'ndi-receiver',
      stdio: 'ignore',
    });
    this.child.on('message', (m) => {
      if (!m || this.stopped) return;
      if (m.kind === 'status' && this.cb.onStatus) this.cb.onStatus(m);
      else if (m.kind === 'error' && this.cb.onError) this.cb.onError(m.message);
    });
    this.child.on('exit', (code) => {
      if (this.stopped || !this.cb.onError) return;
      this.cb.onError('The NDI receiver stopped unexpectedly (code ' + code + ').');
    });
    this.child.once('spawn', () => {
      if (this.stopped) return;
      // The ports must reach the child before any frame does, so they go first.
      if (o.port) {
        const ports = o.audioPort ? [o.port, o.audioPort] : [o.port];
        try { this.child.postMessage({ cmd: 'port' }, ports); } catch (e) {}
      }
      const { port, audioPort, ...plain } = o;
      this.child.postMessage({ cmd: 'start', id: o.id, dllPath, source, opts: plain });
    });
  }

  /** Tell the receiver the rate the compositor actually draws at. */
  setFps(fps) {
    if (this.stopped) return;
    try { this.child.postMessage({ cmd: 'fps', fps }); } catch (e) {}
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    try { this.child.postMessage({ cmd: 'stop' }); } catch (e) {}
    // Give the child a moment to destroy the receiver cleanly, then force it.
    setTimeout(() => { try { this.child.kill(); } catch (e) {} }, 600);
  }
}

/* --------------------------------- IPC ------------------------------------ */

/**
 * Register every `ndi:*` channel. Lives here rather than in main.js so the app
 * and the test harnesses cannot drift apart — they used to each carry their own
 * copy of this wiring, which is how the tests went on exercising a receive path
 * the app no longer had.
 *
 * `wrap` is the caller's {ok,data,error} envelope helper.
 */
function registerIpc(ipcMain, wrap) {
  const receivers = new Map();

  ipcMain.handle('ndi:status', wrap(async () => getStatus()));

  ipcMain.handle('ndi:sources', wrap(async () => { startDiscovery(); return getSources(); }));

  ipcMain.handle('ndi:start', wrap(async (e, { id, source, audioOnly, lowBandwidth, fpsCap }) => {
    if (receivers.has(id)) throw new Error('That NDI source is already open.');
    // Two pipes joining the receiver child straight to the renderer: one for
    // video, one for audio. Frames go between those two directly and never touch
    // this process. They are separate so a megabyte-sized video frame can never
    // delay a two-kilobyte audio packet behind it — see ndi-proc.js.
    const v = new MessageChannelMain();
    const a = new MessageChannelMain();
    e.sender.postMessage('ndi:port', { id }, [v.port1, a.port1]);
    const rx = new NdiReceiver(source, {
      id, port: v.port2, audioPort: a.port2,
      audioOnly: !!audioOnly, lowBandwidth: !!lowBandwidth,
      fpsCap: Math.max(0, Math.min(120, Number(fpsCap) || 0)),
    }, {
      onError: (msg) => {
        try { if (!e.sender.isDestroyed()) e.sender.send('ndi:error', { id, message: msg }); } catch (er) {}
      },
    });
    receivers.set(id, rx);
    return { ok: true };
  }));

  // The compositor's rate changes as inputs come and go; delivering faster than
  // it draws is wasted work in the child and in the renderer both.
  ipcMain.handle('ndi:fps', wrap(async (e, { id, fps }) => {
    const rx = receivers.get(id);
    if (rx) rx.setFps(fps);
    return true;
  }));

  ipcMain.handle('ndi:stop', wrap(async (e, { id }) => {
    const rx = receivers.get(id);
    if (rx) { rx.stop(); receivers.delete(id); }
    return true;
  }));

  return {
    receivers,
    stopAll() { for (const rx of receivers.values()) { try { rx.stop(); } catch (e) {} } receivers.clear(); },
  };
}

module.exports = { getStatus, getSources, startDiscovery, NdiReceiver, parseSource, registerIpc };
