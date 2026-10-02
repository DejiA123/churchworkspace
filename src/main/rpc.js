'use strict';
/*
 * One studio, two front ends.
 *
 * Every capability of the Video Studio already lives behind an `ipcMain.handle`
 * channel: analyse a sermon, cut a short, track a face, transcribe, burn
 * captions, mix music. The desktop renderer reaches them over Electron IPC. A
 * phone on the church wifi cannot — but the work it wants doing is identical,
 * and none of it belongs to the window.
 *
 * So rather than write a second copy of that surface for HTTP (which would rot
 * the moment a handler changes), this module RECORDS the handlers as they are
 * registered and lets another transport call the very same function. The phone
 * gets today's behaviour, including whatever was fixed this morning, for free.
 *
 * The one thing a handler expects that HTTP doesn't have is an Electron event:
 * long jobs call `event.sender.send('job:progress', …)`. `invoke()` therefore
 * takes a `sender` — any object with `send()` and `isDestroyed()` — so the
 * progress of an export started from a phone streams back to that phone.
 *
 * Nothing here decides what a remote caller is ALLOWED to run. That is a
 * security question, and it is answered in one place: the allowlist in
 * mobile-api.js. This module is only the plumbing.
 */

const registry = new Map(); // channel -> the wrapped handler main.js registered

/**
 * Patch an ipcMain so every `handle()` is remembered as well as registered.
 * Idempotent, and called before any handler exists so nothing is missed —
 * including the ones registered by submodules (ndi.registerIpc and friends).
 */
function install(ipcMain) {
  if (!ipcMain || ipcMain.__mwRpcInstalled) return registry;
  const orig = ipcMain.handle.bind(ipcMain);
  const origRemove = ipcMain.removeHandler ? ipcMain.removeHandler.bind(ipcMain) : null;
  ipcMain.handle = (channel, listener) => {
    registry.set(channel, listener);
    return orig(channel, listener);
  };
  if (origRemove) {
    ipcMain.removeHandler = (channel) => { registry.delete(channel); return origRemove(channel); };
  }
  Object.defineProperty(ipcMain, '__mwRpcInstalled', { value: true, enumerable: false });
  return registry;
}

const has = (channel) => registry.has(channel);
const channels = () => Array.from(registry.keys()).sort();

/**
 * A stand-in for the Electron event a handler receives. `send` is where
 * `job:progress` lands; a transport that has nowhere to put it passes nothing
 * and the progress is simply dropped (the job still runs).
 */
function fakeEvent(sender) {
  const s = sender || { send() {}, isDestroyed() { return false; } };
  if (typeof s.isDestroyed !== 'function') s.isDestroyed = () => false;
  if (typeof s.send !== 'function') s.send = () => {};
  return { sender: s, __remote: true };
}

/**
 * Call a recorded handler. Returns the SAME `{ ok, data }` / `{ ok:false, error }`
 * envelope the renderer gets, because it comes from the same `wrap()` — an
 * unknown channel is the only thing this module has to invent.
 */
async function invoke(channel, args, sender) {
  const fn = registry.get(channel);
  if (!fn) return { ok: false, error: 'Unknown channel: ' + channel, unknown: true };
  try {
    return await fn(fakeEvent(sender), args || {});
  } catch (err) {
    // wrap() already catches; this is for a handler registered without it.
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

module.exports = { install, invoke, has, channels, registry, fakeEvent };
