'use strict';
/*
 * WHAT THE MACHINE IS ACTUALLY DOING WITH THE MONITORS.
 *
 * Electron's `screen` module reports DESKTOPS, not cables — and that gap is a
 * real bug in a church hall. Plug a projector into a Windows laptop and the
 * factory default is "Duplicate": ONE desktop copied onto two panels. Electron
 * sees exactly one display, `display-added` never fires at all, and the
 * honest-looking conclusion — "no second screen is connected" — is wrong. The
 * projector is plugged in and lit; Windows is just pointing the same desktop at
 * it. No amount of re-reading getAllDisplays() can ever see past that, which is
 * why "I connected the HDMI and the software didn't notice" is not a refresh
 * bug and cannot be fixed by refreshing harder.
 *
 * Windows' Connecting and Configuring Displays (CCD) API sits one level below
 * the desktop and does know about cables. QueryDisplayConfig() returns PATHS,
 * each wiring a SOURCE (a desktop) to a TARGET (a physical connector):
 *
 *   extended   2 active paths, 2 different sources
 *   duplicate  2 active paths, ONE source          <- the bug above
 *   idle       a target that is available but sits in no active path
 *              ("Second screen only" / "PC screen only" left the wrong way)
 *
 * So "more active targets than active sources" IS mirroring, precisely, and it
 * is knowable the instant the cable goes in. SetDisplayConfig() with
 * SDC_TOPOLOGY_EXTEND is exactly what the Win+P "Extend" button does, so the
 * studio can offer the fix instead of a lecture.
 *
 * Both calls are ~0.06 ms measured on the dev laptop, so this is polled once a
 * second forever without the main thread noticing (see main.js's watchdog —
 * the one thread also drives five studios; see the freeze notes).
 *
 * Everything is best-effort. If koffi, user32 or the API misbehaves the module
 * reports `supported: false` and every caller behaves exactly as it did before
 * this file existed: nothing gains a hard dependency on it.
 *
 * macOS mirrors too, but has no public "extend now" call, so there we DETECT
 * (via system_profiler, cached — it is slow) and tell the operator where the
 * switch is instead of offering a button that cannot exist.
 */
const { execFile } = require('child_process');

/* ------------------------------- constants ------------------------------- */
const PATH_SIZE = 72;   // DISPLAYCONFIG_PATH_INFO, x64
const MODE_SIZE = 64;   // DISPLAYCONFIG_MODE_INFO, x64
const QDC_ALL_PATHS = 0x1;
const QDC_ONLY_ACTIVE_PATHS = 0x2;
const PATH_ACTIVE = 0x1;
const MODE_INFO_TYPE_SOURCE = 1;
const INFO_GET_SOURCE_NAME = 1;
const INFO_GET_TARGET_NAME = 2;
const SDC_TOPOLOGY_EXTEND = 0x4;
const SDC_APPLY = 0x80;
const OUTPUT_INTERNAL = -2147483648; // 0x80000000 read back as a signed int32

// DISPLAYCONFIG_VIDEO_OUTPUT_TECHNOLOGY -> what the operator calls the cable.
const CONNECTOR = {
  0: 'VGA', 1: 'S-Video', 2: 'composite', 3: 'component', 4: 'DVI', 5: 'HDMI',
  6: 'built-in', 8: 'D-Terminal', 9: 'SDI', 10: 'DisplayPort', 11: 'DisplayPort',
  12: 'USB-C', 13: 'USB-C', 14: 'TV', 15: 'wireless', 16: 'wireless',
  17: 'virtual', 18: 'USB-C', [OUTPUT_INTERNAL]: 'built-in',
};

/* --------------------------------- win32 --------------------------------- */
let ffi = null;          // null = not tried yet, false = unavailable
function win32() {
  if (ffi !== null) return ffi;
  ffi = false;
  if (process.platform !== 'win32') return ffi;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    ffi = {
      getSizes: user32.func('int32 GetDisplayConfigBufferSizes(uint32 flags, _Inout_ uint32 *nPath, _Inout_ uint32 *nMode)'),
      query: user32.func('int32 QueryDisplayConfig(uint32 flags, _Inout_ uint32 *nPath, void *paths, _Inout_ uint32 *nMode, void *modes, void *topology)'),
      deviceInfo: user32.func('int32 DisplayConfigGetDeviceInfo(void *packet)'),
      setConfig: user32.func('int32 SetDisplayConfig(uint32 nPath, void *paths, uint32 nMode, void *modes, uint32 flags)'),
    };
  } catch (e) {
    console.warn('[screens] display topology unavailable: ' + (e && e.message));
    ffi = false;
  }
  return ffi;
}

/** A fixed-length WCHAR field out of a raw struct. */
function wstr(buf, off, chars) {
  let s = '';
  for (let i = 0; i < chars; i++) {
    const c = buf.readUInt16LE(off + i * 2);
    if (!c) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

/** The monitor's own name out of its EDID ("EPSON PJ", "BenQ MX550"). */
function targetName(f, low, high, id) {
  try {
    const b = Buffer.alloc(420); // DISPLAYCONFIG_TARGET_DEVICE_NAME
    b.writeUInt32LE(INFO_GET_TARGET_NAME, 0);
    b.writeUInt32LE(420, 4);
    b.writeUInt32LE(low, 8); b.writeInt32LE(high, 12); b.writeUInt32LE(id, 16);
    if (f.deviceInfo(b) !== 0) return { name: '', path: '' };
    return { name: wstr(b, 36, 64), path: wstr(b, 164, 128) };
  } catch (e) { return { name: '', path: '' }; }
}

/** The GDI name of a desktop ("\\.\DISPLAY1"). */
function sourceName(f, low, high, id) {
  try {
    const b = Buffer.alloc(84); // DISPLAYCONFIG_SOURCE_DEVICE_NAME
    b.writeUInt32LE(INFO_GET_SOURCE_NAME, 0);
    b.writeUInt32LE(84, 4);
    b.writeUInt32LE(low, 8); b.writeInt32LE(high, 12); b.writeUInt32LE(id, 16);
    return f.deviceInfo(b) === 0 ? wstr(b, 20, 32) : '';
  } catch (e) { return ''; }
}

/** One QueryDisplayConfig call, decoded. Byte offsets, not koffi structs: the
 *  layout is fixed by the OS ABI and hand-decoding cannot get out of step with
 *  a struct definition. Verified against a known machine before shipping. */
function queryPaths(f, flags) {
  const nPath = [0], nMode = [0];
  if (f.getSizes(flags, nPath, nMode) !== 0) return null;
  if (!nPath[0]) return { paths: [], modes: null, nMode: 0 };
  const paths = Buffer.alloc(nPath[0] * PATH_SIZE);
  const modes = Buffer.alloc(Math.max(1, nMode[0]) * MODE_SIZE);
  const p = [nPath[0]], m = [nMode[0]];
  if (f.query(flags, p, paths, m, modes, null) !== 0) return null;
  const out = [];
  for (let i = 0; i < p[0]; i++) {
    const o = i * PATH_SIZE;
    out.push({
      srcLow: paths.readUInt32LE(o), srcHigh: paths.readInt32LE(o + 4),
      srcId: paths.readUInt32LE(o + 8), srcModeIdx: paths.readInt32LE(o + 12),
      tgtLow: paths.readUInt32LE(o + 20), tgtHigh: paths.readInt32LE(o + 24),
      tgtId: paths.readUInt32LE(o + 28),
      outputTech: paths.readInt32LE(o + 36),
      available: paths.readInt32LE(o + 60) !== 0,
      active: (paths.readUInt32LE(o + 68) & PATH_ACTIVE) !== 0,
    });
  }
  return { paths: out, modes, nMode: m[0] };
}

/** The physical pixel rectangle a desktop occupies, from its source mode. */
function sourceRect(modes, nMode, idx) {
  if (!modes || idx < 0 || idx >= nMode) return null;
  const o = idx * MODE_SIZE;
  if (modes.readUInt32LE(o) !== MODE_INFO_TYPE_SOURCE) return null;
  return {
    width: modes.readUInt32LE(o + 16), height: modes.readUInt32LE(o + 20),
    x: modes.readInt32LE(o + 28), y: modes.readInt32LE(o + 32),
  };
}

const connectorOf = (tech) => CONNECTOR[tech] || 'display';
/** What to call a monitor on screen when it has no EDID name of its own. */
function screenLabel(name, tech) {
  if (name) return name;
  if (tech === OUTPUT_INTERNAL || tech === 6) return 'this computer’s own screen';
  return connectorOf(tech) + ' screen';
}

/* ------------------------------ the reading ------------------------------ */
/**
 * Read the real topology.
 *
 * `sources` are desktops (what Electron would call displays); each carries the
 * physical targets wired to it. Two targets on one source is duplication.
 * `idle` are monitors the machine can see that nothing is being sent to.
 */
function readWindows() {
  const f = win32();
  if (!f) return { supported: false };
  let active, all;
  try {
    active = queryPaths(f, QDC_ONLY_ACTIVE_PATHS);
    all = queryPaths(f, QDC_ALL_PATHS);
  } catch (e) { return { supported: false, error: e.message }; }
  if (!active) return { supported: false, error: 'QueryDisplayConfig failed' };

  const sources = new Map();
  const activeTargets = new Set();
  for (const p of active.paths) {
    if (!p.active) continue;
    const key = p.srcLow + ':' + p.srcHigh + ':' + p.srcId;
    let s = sources.get(key);
    if (!s) {
      const rect = sourceRect(active.modes, active.nMode, p.srcModeIdx) || { width: 0, height: 0, x: 0, y: 0 };
      s = { key, gdi: sourceName(f, p.srcLow, p.srcHigh, p.srcId), targets: [], ...rect };
      sources.set(key, s);
    }
    const t = targetName(f, p.tgtLow, p.tgtHigh, p.tgtId);
    activeTargets.add(p.tgtLow + ':' + p.tgtHigh + ':' + p.tgtId);
    s.targets.push({
      id: p.tgtId, name: t.name, label: screenLabel(t.name, p.outputTech),
      connector: connectorOf(p.outputTech), internal: p.outputTech === OUTPUT_INTERNAL || p.outputTech === 6,
    });
  }

  // Plugged in, powered, and being sent nothing. A projector left on "PC screen
  // only" shows "no signal" and looks broken; it is one click from working.
  //
  // Wireless, indirect and virtual targets are skipped here on purpose. A
  // Miracast receiver or a virtual-display driver can report itself available
  // forever without anything being plugged into anything, and an amber warning
  // that is up every single Sunday is a warning nobody reads by Christmas.
  // Duplication is NOT filtered the same way: mirroring onto a wireless screen
  // is a real thing that really costs you the projector.
  const NOT_A_CABLE = new Set([15, 16, 17]); // MIRACAST, INDIRECT_WIRED, INDIRECT_VIRTUAL
  const idle = [];
  const seen = new Set();
  for (const p of (all ? all.paths : [])) {
    const key = p.tgtLow + ':' + p.tgtHigh + ':' + p.tgtId;
    if (!p.available || p.active || activeTargets.has(key) || seen.has(key)) continue;
    if (NOT_A_CABLE.has(p.outputTech)) continue;
    seen.add(key);
    const t = targetName(f, p.tgtLow, p.tgtHigh, p.tgtId);
    idle.push({
      id: p.tgtId, name: t.name, label: screenLabel(t.name, p.outputTech),
      connector: connectorOf(p.outputTech), internal: p.outputTech === OUTPUT_INTERNAL || p.outputTech === 6,
    });
  }

  const list = Array.from(sources.values());
  return {
    supported: true,
    sources: list,
    idle,
    // Every desktop that is being copied onto more than one panel.
    duplicated: list.filter((s) => s.targets.length > 1),
    canExtend: true,
  };
}

/* --------------------------------- macOS --------------------------------- */
/* system_profiler is the only public way to see a mirror, and it takes seconds,
 * so it is refreshed in the background and read from a cache. */
let macCache = { at: 0, mirrored: [], busy: false };
const MAC_TTL = 15000;
function refreshMac() {
  if (process.platform !== 'darwin' || macCache.busy) return;
  if (Date.now() - macCache.at < MAC_TTL) return;
  macCache.busy = true;
  execFile('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 12000, maxBuffer: 4 << 20 }, (err, out) => {
    macCache.busy = false; macCache.at = Date.now();
    if (err) return;
    try {
      const j = JSON.parse(out);
      const found = [];
      for (const gpu of j.SPDisplaysDataType || []) {
        for (const d of gpu.spdisplays_ndrvs || []) {
          if (String(d.spdisplays_mirror || '').includes('on')) found.push(d._name || 'a screen');
        }
      }
      macCache.mirrored = found;
    } catch (e) {}
  });
}
function readMac() {
  refreshMac();
  if (!macCache.at) return { supported: false, pending: true };
  if (macCache.mirrored.length < 2) return { supported: true, sources: [], idle: [], duplicated: [], canExtend: false };
  return {
    supported: true, canExtend: false, idle: [], sources: [],
    duplicated: [{ key: 'mac', targets: macCache.mirrored.map((n) => ({ label: n, name: n, internal: false, connector: 'display' })) }],
  };
}

/* The reading is cheap but not free, and it is asked for from several places at
 * once whenever an output opens. A quarter-second cache makes a burst of
 * callers cost exactly one reading while still noticing a cable within a tick
 * of the watchdog. */
let cache = { at: 0, value: null };
const CACHE_MS = 250;
function read(force) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  let v;
  if (process.platform === 'win32') v = readWindows();
  else if (process.platform === 'darwin') v = readMac();
  else v = { supported: false };
  cache = { at: Date.now(), value: v };
  return v;
}

/* ------------------------- what to tell the operator ---------------------- */
const listWords = (a) => a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];

/**
 * Turn the topology into one plain-English verdict the Screens picker can show
 * verbatim. `state` is what is wrong, not what the API returned:
 *
 *   'ok'          nothing to say.
 *   'duplicating' a screen is connected but showing a copy of another one, so
 *                 the studio genuinely has nowhere separate to present.
 *   'idle'        a screen is connected and being sent nothing at all.
 */
function advice(injected) {
  const t = injected || read();
  if (!t || !t.supported) return { state: 'ok', supported: false, canExtend: false };
  const dup = (t.duplicated || [])[0];
  if (dup) {
    const names = dup.targets.map((x) => x.label);
    const other = dup.targets.filter((x) => !x.internal).map((x) => x.label);
    return {
      state: 'duplicating', supported: true, canExtend: !!t.canExtend,
      screens: names,
      headline: other.length
        ? (other.length === 1 ? other[0] : listWords(other)) + ' is plugged in, but it is showing a COPY of this screen'
        : 'Two screens are showing the same picture',
      detail: 'Windows is duplicating one desktop onto ' + listWords(names) + ', so there is only one screen to present on. '
        + 'Extend the desktop and the projector becomes its own screen — the congregation sees the slides while you keep the studio.',
      macDetail: 'Turn mirroring off in  → System Settings → Displays (select the projector, set “Use as” to Extended Display).',
      action: 'Extend onto ' + (other.length === 1 ? other[0] : 'the projector'),
    };
  }
  const idle = (t.idle || []).filter((x) => !x.internal);
  if (idle.length) {
    return {
      state: 'idle', supported: true, canExtend: !!t.canExtend,
      screens: idle.map((x) => x.label),
      headline: (idle.length === 1 ? idle[0].label : listWords(idle.map((x) => x.label))) + ' is connected, but Windows is not using it',
      detail: 'The cable is in and the screen is awake, but nothing is being sent to it — that is the “PC screen only” setting. '
        + 'Switch it on and it becomes a screen you can present on.',
      macDetail: 'Switch it on in  → System Settings → Displays.',
      action: 'Use ' + (idle.length === 1 ? idle[0].label : 'the connected screen'),
    };
  }
  return { state: 'ok', supported: true, canExtend: !!t.canExtend };
}

/**
 * A short string that changes whenever the physical picture changes. The
 * watchdog compares this instead of deep-diffing, so plugging a cable in is
 * noticed even when Electron itself sees no new display (which is exactly what
 * happens in Duplicate mode: `display-added` never fires).
 */
function signature(injected) {
  const t = injected || read();
  if (!t || !t.supported) return 'n/a';
  const src = (t.sources || []).map((s) => s.gdi + '@' + s.x + ',' + s.y + '/' + s.width + 'x' + s.height
    + '[' + s.targets.map((x) => x.id + x.name).join('+') + ']').sort().join('|');
  return src + '#idle:' + (t.idle || []).map((x) => x.id).sort().join(',');
}

/* ------------------------------- the fix ---------------------------------- */
/**
 * Do what Win+P → Extend does.
 *
 * SetDisplayConfig with SDC_TOPOLOGY_EXTEND is the documented call and needs no
 * elevation. DisplaySwitch.exe is the fallback for the machine where the FFI
 * did not load — same effect, just a process spawn and about a second slower.
 */
function extend() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, error: 'Only Windows can be switched from here.' });
    const f = win32();
    if (f) {
      let rc = -1;
      try { rc = f.setConfig(0, null, 0, null, SDC_TOPOLOGY_EXTEND | SDC_APPLY); } catch (e) { rc = -1; }
      cache = { at: 0, value: null }; // the world just changed; never answer from before it
      if (rc === 0) return resolve({ ok: true, how: 'SetDisplayConfig' });
      console.warn('[screens] SetDisplayConfig(extend) returned ' + rc + ', falling back to DisplaySwitch');
    }
    const exe = (process.env.WINDIR || 'C:\\Windows') + '\\System32\\DisplaySwitch.exe';
    execFile(exe, ['/extend'], { timeout: 15000 }, (err) => {
      cache = { at: 0, value: null };
      if (err) return resolve({ ok: false, error: err.message });
      resolve({ ok: true, how: 'DisplaySwitch' });
    });
  });
}

module.exports = { read, advice, signature, extend };
