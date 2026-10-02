'use strict';
/*
 * Projector output for the Presentation Studio.
 *
 * Two independent output windows, exactly like ProPresenter:
 *
 *   AUDIENCE — what the congregation sees. Borderless, always fullscreen on a
 *              chosen display, no menu, and NOT focusable-by-accident: clicking
 *              the projector must never steal focus from the operator's laptop
 *              mid-service.
 *   STAGE    — what the preacher/worship leader sees on a confidence monitor:
 *              the current slide, what's coming next, a clock and the notes.
 *
 * Both load the same output.html and are driven by one broadcast state object,
 * so they can never disagree about what's live. The renderer owns the deciding
 * (which slide, which look); this module owns the glass.
 *
 * Windows are re-created rather than moved when the display changes: dragging a
 * fullscreen window between monitors is unreliable across Windows/macOS, and a
 * 200 ms black flash while re-opening is far better than an output that ends up
 * half on the wrong screen in front of 300 people.
 */
const path = require('path');
const { BrowserWindow, screen } = require('electron');
// One level below `screen`: what is on the CABLES, so a projector Windows is
// merely mirroring is reported as connected instead of invisible.
const topology = require('./screen-topology');

// key -> BrowserWindow. 'stage' is the confidence monitor; every other key is an
// audience output ('main', or a user-named one) so a church can drive the room
// screen, a lobby screen and a keyable stream feed from one cue.
const outputs = new Map();
const meta = new Map();          // key -> { role, id, name, displayId, windowed }
let lastState = { layers: {}, cleared: {}, transitions: {}, blackout: false, next: null };
let onChange = null;             // notify the main window when an output opens/closes
let onKey = null;                // keys pressed ON an output window, sent back to the studio

const OUTPUT_HTML = () => path.join(__dirname, '..', 'renderer', 'output.html');
const PRELOAD = () => path.join(__dirname, 'preload.js');

function setNotifier(fn) { onChange = fn; }
/** Where a key pressed on a projector window goes ('next' | 'prev' | 'black'). */
function setKeyHandler(fn) { onKey = fn; }
function notify() {
  if (onChange) { try { onChange(state()); } catch (e) {} }
}

/**
 * Put a real monitor name against each Electron display.
 *
 * Electron's display.id is an internal number with no relationship to anything
 * Windows exposes, so the two lists are matched on the only thing both sides
 * agree about: the physical pixel rectangle. Electron reports DIPs, so its
 * bounds are scaled back up by the display's own scaleFactor first (1536×864 at
 * 1.25 is the 1920×1080 panel Windows is describing).
 *
 * Purely cosmetic, and deliberately timid: a match has to be unambiguous or the
 * display keeps its generic name. "Screen 2" is a poor label; "BenQ MX550" put
 * against the WRONG screen would send the sermon to the lobby.
 */
function nameDisplays(list) {
  let t;
  try { t = topology.read(); } catch (e) { return; }
  if (!t || !t.supported || !t.sources || !t.sources.length) return;
  const free = t.sources.slice();
  const phys = list.map((d) => ({
    w: Math.round(d.width * d.scaleFactor), h: Math.round(d.height * d.scaleFactor),
    x: Math.round(d.x * d.scaleFactor), y: Math.round(d.y * d.scaleFactor),
  }));
  const take = (i, s) => {
    free.splice(free.indexOf(s), 1);
    const named = s.targets.find((x) => x.name) || s.targets[0];
    if (named && named.name) list[i].monitor = named.name;
    // A desktop wired to more than one panel is being duplicated: the operator
    // is looking at one row that is really two screens showing one picture.
    // `copiedExtra` is the OTHER panels — the row's own panel is the one whose
    // built-in-ness matches it, so a laptop row reads "also copied onto EPSON
    // PJ" rather than naming the screen the operator is already looking at.
    if (s.targets.length > 1) {
      const own = s.targets.findIndex((x) => !!x.internal === !!list[i].internal);
      const mine = own < 0 ? 0 : own;
      list[i].copiedTo = s.targets.map((x) => x.label);
      list[i].copiedExtra = s.targets.filter((_, k) => k !== mine).map((x) => x.label);
    }
  };
  const pending = list.map((_, i) => i);
  // 1. same size AND same place — unambiguous.
  for (const i of pending.slice()) {
    const p = phys[i];
    const hit = free.filter((s) => s.width === p.w && s.height === p.h && s.x === p.x && s.y === p.y);
    if (hit.length === 1) { take(i, hit[0]); pending.splice(pending.indexOf(i), 1); }
  }
  // 2. same size, and only one candidate left with it.
  for (const i of pending.slice()) {
    const p = phys[i];
    const hit = free.filter((s) => s.width === p.w && s.height === p.h);
    if (hit.length === 1) { take(i, hit[0]); pending.splice(pending.indexOf(i), 1); }
  }
  // 3. one of each left over: it can only be that one.
  if (pending.length === 1 && free.length === 1) take(pending[0], free[0]);
}

/** Every monitor Electron can see, in a form the UI can put in a dropdown. */
function displays() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const list = all.map((d, i) => ({
    id: String(d.id),
    label: `${d.id === primary.id ? 'Main screen' : 'Screen ' + (i + 1)} — ${d.size.width}×${d.size.height}`,
    width: d.size.width, height: d.size.height,
    x: d.bounds.x, y: d.bounds.y,
    scaleFactor: d.scaleFactor,
    primary: d.id === primary.id,
    internal: !!d.internal,
    monitor: '',       // the panel's own name out of its EDID, when it is knowable
    copiedTo: null,    // every panel this one desktop is being mirrored onto
    copiedExtra: null, // ...minus this row's own panel
  }));
  nameDisplays(list);
  // The name the monitor calls itself beats "Screen 2" every time, but the size
  // stays: it is how an operator spots the projector in a list of TVs.
  for (const d of list) {
    if (d.monitor) d.label = `${d.monitor} — ${d.width}×${d.height}`;
  }
  return list;
}
/** The display a projector is most likely to be: the first non-primary one. */
function suggestedDisplayId() {
  const all = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const ext = all.find((d) => d.id !== primary.id);
  return String((ext || primary).id);
}
function displayById(id) {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(id)) || screen.getPrimaryDisplay();
}

/**
 * Open (or re-open) an output.
 *
 * `render` is the downstream-keying mode, and it is why one cue can drive a
 * projector and a broadcast switcher at the same time:
 *   'normal' — the picture, as the room sees it.
 *   'fill'   — the picture on a TRANSPARENT background (no background layer),
 *              for a switcher or NDI receiver that does its own keying.
 *   'key'    — the matching key channel: the same composite's alpha drawn as
 *              white-on-black luminance, which is exactly what an SDI fill+key
 *              pair needs on the second cable.
 */
function open({ role = 'audience', displayId, windowed, id, name, render } = {}) {
  const r = role === 'stage' ? 'stage' : 'audience';
  // One stage display; unlimited audience outputs, each keyed by its own id.
  const key = r === 'stage' ? 'stage' : (id || 'main');
  const mode = render === 'fill' || render === 'key' ? render : 'normal';
  close(key);
  const d = displayById(displayId || suggestedDisplayId());
  const b = d.bounds;
  const win = new BrowserWindow({
    x: windowed ? b.x + 60 : b.x,
    y: windowed ? b.y + 60 : b.y,
    width: windowed ? Math.min(1280, b.width - 120) : b.width,
    height: windowed ? Math.min(720, b.height - 120) : b.height,
    frame: !!windowed,
    fullscreen: !windowed,
    // A projector window must never end up behind the operator's editor, and
    // must never take the keyboard away from it either.
    alwaysOnTop: !windowed,
    skipTaskbar: !windowed,
    focusable: !!windowed,
    // 'fill' has to let whatever is behind it through — that IS the alpha.
    transparent: mode === 'fill',
    backgroundColor: mode === 'fill' ? '#00000000' : '#000000',
    title: r === 'stage' ? 'Stage Display' : ('Audience Output' + (key !== 'main' ? ' — ' + key : '')),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: PRELOAD(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false, // a still slide on a background window must not stall
    },
  });
  win.removeMenu();
  win.setMenuBarVisibility(false);
  if (!windowed) {
    // above full-screen video players too, but not above OS alerts
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch (e) { }
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (e) {}
  }
  win.loadFile(OUTPUT_HTML(), { query: { role: r, id: key, render: mode } });
  win.once('ready-to-show', () => {
    win.show();
    if (!windowed) win.setFullScreen(true);
    push(); // whatever is live right now, immediately — never a blank projector
  });
  win.webContents.on('did-finish-load', () => push());
  win.on('closed', () => { outputs.delete(key); meta.delete(key); notify(); });
  /*
   * KEYS PRESSED ON THE PROJECTOR WINDOW.
   *
   * On one screen the output is a normal, focusable window, so the moment the
   * operator clicks it the studio stops hearing the keyboard — and "the arrow
   * keys don't change slides" is exactly what that looks like. The window holds
   * no presentation and cannot advance anything itself, so the keys are handed
   * back to the studio, which owns the running order.
   *
   * Esc still closes the output outright: the panic button for a projector that
   * has landed on the wrong screen.
   */
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const k = input.key;
    if (k === 'Escape') { e.preventDefault(); close(key); return; }
    const cmd = (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ' || k === 'Enter') ? 'next'
      : (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp') ? 'prev'
      : (k === 'b' || k === 'B') ? 'black' : null;
    if (!cmd) return;
    e.preventDefault();
    if (onKey) { try { onKey(cmd); } catch (err) {} }
  });
  outputs.set(key, win);
  meta.set(key, { role: r, id: key, name: name || (r === 'stage' ? 'Stage' : key === 'main' ? 'Audience' : key), displayId: String(d.id), windowed: !!windowed, render: mode });
  notify();
  return { role: r, id: key, displayId: String(d.id), width: b.width, height: b.height, render: mode };
}

function close(key) {
  const keys = key ? [key] : Array.from(outputs.keys());
  for (const k of keys) {
    const w = outputs.get(k);
    outputs.delete(k); meta.delete(k);
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch (e) {} }
  }
  notify();
  return true;
}

const isOpen = (key) => { const w = outputs.get(key); return !!(w && !w.isDestroyed()); };

/** Which display each output is actually on (it may have been moved). */
function state() {
  const where = (k) => {
    const w = outputs.get(k);
    if (!w || w.isDestroyed()) return null;
    try { return String(screen.getDisplayMatching(w.getBounds()).id); } catch (e) { return null; }
  };
  const list = Array.from(meta.values())
    .filter((m) => isOpen(m.id))
    .map((m) => Object.assign({}, m, { displayId: where(m.id) || m.displayId }));
  return {
    // kept for the simple one-projector case the UI started with
    audience: isOpen('main'), stage: isOpen('stage'),
    audienceDisplay: where('main'), stageDisplay: where('stage'),
    outputs: list,
    blackout: !!lastState.blackout,
    cleared: lastState.cleared || {},
    displays: displays(),
    suggested: suggestedDisplayId(),
    // Screens that are plugged in but that `displays` cannot show, because the
    // OS is mirroring them or sending them nothing. Without this the studio can
    // only say "no second screen" about a projector that is right there, lit.
    screens: (() => { try { return topology.advice(); } catch (e) { return { state: 'ok', supported: false, canExtend: false }; } })(),
  };
}

/** Do what Win+P → Extend does, then wait for the desktop to actually appear. */
async function extendScreens() {
  const before = screen.getAllDisplays().length;
  const res = await topology.extend();
  if (!res.ok) return res;
  // Windows applies the topology asynchronously; presenting onto a screen that
  // is not there yet opens a window on the wrong monitor.
  for (let i = 0; i < 60 && screen.getAllDisplays().length <= before; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  notify();
  return Object.assign({}, res, { displays: displays() });
}

/** Send the current live state to every open output. */
function push() {
  for (const [, w] of outputs) {
    if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
      try { w.webContents.send('present:state', lastState); } catch (e) {}
    }
  }
}

/**
 * Set what is live. Partial updates merge, so the renderer can send just
 * `{ mode: 'black' }` without having to resend the whole slide.
 */
function setState(patch) {
  lastState = Object.assign({}, lastState, patch || {});
  push();
  return lastState;
}
const getState = () => lastState;

function shutdown() { close(); }

module.exports = {
  displays, suggestedDisplayId, open, close, isOpen, state, setState, getState, push, shutdown,
  setNotifier, setKeyHandler, extendScreens, topology,
};
