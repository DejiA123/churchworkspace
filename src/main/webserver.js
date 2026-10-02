'use strict';
/*
 * The local web server behind "any phone is a stage display".
 *
 * A worship leader should not have to install anything to see the words. They
 * join the church wifi, type the IP the studio shows them, and they have a live
 * confidence monitor in their browser — current slide, next slide, chords,
 * clock, notes. Same for a second operator who wants next/previous on a phone
 * from the back of the room.
 *
 * Everything is served from this process:
 *   GET  /                  the mobile page (stage view + optional remote)
 *   GET  /events            Server-Sent Events — the live state, pushed
 *   GET  /api/state         the same state as one JSON snapshot
 *   GET|POST /api/next|prev|black|clear/:layer|slide/:n|macro/:id|message
 *
 * Control endpoints answer to GET as well as POST on purpose: an Elgato Stream
 * Deck's plain "Website" button can only do a GET, and making a $150 controller
 * work should not require a plugin.
 *
 * Scope is deliberately the local network — no tunnelling, no cloud. An
 * optional passcode keeps a curious visitor on the guest wifi from advancing
 * your slides.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let server = null;
let clients = new Set();          // open SSE responses
let lastState = {};
let onCommand = null;             // (cmd, params) -> void, wired to the studio
let onLiveCommand = null;         // …and the same for the Go Live switcher
let cfg = { port: 7373, passcode: '', allowControl: true };

const PAGE = () => path.join(__dirname, '..', 'renderer', 'mobile.html');

/** Every LAN address this machine has, so the UI can tell people what to type. */
/*
 * Ranked, and with the unreachable ones dropped. Listing every interface in
 * whatever order Node returned them is why "Phone Studio doesn't work even
 * though I'm on the same wifi" happened: on a laptop with VirtualBox and
 * Hyper-V installed, five of the six addresses offered could never be reached
 * by anything outside this PC. See lan-address.js.
 */
const addresses = () => require('./lan-address').candidates()
  .map((a) => ({ name: a.name, address: a.address, virtual: a.virtual }));

function urls() {
  return addresses().map((a) => `http://${a.address}:${cfg.port}`);
}

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({
    'Content-Type': type,
    'Cache-Control': 'no-store',
    // the page is served to phones on the same wifi; nothing here is cross-origin
    'Access-Control-Allow-Origin': '*',
  }, extra || {}));
  res.end(body);
}
const json = (res, code, obj) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(obj));

/** Passcode check. Absent passcode = open on the local network. */
function authed(url) {
  if (!cfg.passcode) return true;
  return url.searchParams.get('key') === cfg.passcode;
}

function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, 'text/plain', 'bad request'); }
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/' || p === '/index.html') {
    let html = '';
    try { html = fs.readFileSync(PAGE(), 'utf-8'); }
    catch (e) { return send(res, 500, 'text/plain', 'mobile page missing'); }
    return send(res, 200, 'text/html; charset=utf-8', html);
  }

  if (p === '/api/state') {
    if (!authed(url)) return json(res, 401, { error: 'passcode required' });
    return json(res, 200, publicState());
  }

  if (p === '/api/info') {
    return json(res, 200, { ok: true, name: 'Church Work Space', control: cfg.allowControl, needsKey: !!cfg.passcode });
  }

  // live push: one long-lived response per phone
  if (p === '/events') {
    if (!authed(url)) return json(res, 401, { error: 'passcode required' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write('data: ' + JSON.stringify(publicState()) + '\n\n');
    clients.add(res);
    // A phone that sleeps leaves a dead socket; a comment every 20s keeps the
    // live ones alive through wifi NAT and lets us drop the dead ones.
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(ka); clients.delete(res); });
    return undefined;
  }

  /*
   * GO LIVE, FROM THE OTHER MACHINE.
   *
   * The Presentation commands below have driven phones and Stream Decks for a
   * while; the switcher had nothing. A second machine running the same app —
   * or a tablet at the back of the hall — can now cut, preview, fade to black
   * and start or stop a broadcast over the same private URL, with the same
   * passcode and the same "remote control is switched off" master switch.
   *
   * They go the same way everything else does: the server never touches the
   * switcher, it hands the name to the studio, which is the only thing that
   * knows what "cut to 3" means. That also keeps this off the hot path — a
   * control message is a few dozen bytes and a single IPC send, which is why
   * linking two machines costs the desk nothing measurable.
   */
  const lcmd = p.match(/^\/api\/live\/(cut|preview|take|trans|ftb|stream|stopstream|record|stoprecord)(?:\/(.+))?$/);
  if (lcmd) {
    if (!authed(url)) return json(res, 401, { error: 'passcode required' });
    if (!cfg.allowControl) return json(res, 403, { error: 'remote control is switched off' });
    const name = lcmd[1];
    const arg = lcmd[2] ? decodeURIComponent(lcmd[2]) : (url.searchParams.get('v') || '');
    if (onLiveCommand) {
      try { onLiveCommand(name, arg); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    return json(res, 200, { ok: true, command: name, arg, target: 'live' });
  }

  const cmd = p.match(/^\/api\/(next|prev|black|clear|slide|macro|message|easy|blank)(?:\/(.+))?$/);
  if (cmd) {
    if (!authed(url)) return json(res, 401, { error: 'passcode required' });
    if (!cfg.allowControl) return json(res, 403, { error: 'remote control is switched off' });
    const name = cmd[1];
    const arg = cmd[2] ? decodeURIComponent(cmd[2]) : (url.searchParams.get('v') || '');
    if (onCommand) {
      try { onCommand(name, arg); } catch (e) { return json(res, 500, { error: e.message }); }
    }
    return json(res, 200, { ok: true, command: name, arg });
  }

  send(res, 404, 'text/plain', 'not found');
}

/** What a phone is allowed to see — the words, not the whole app's internals. */
function publicState() {
  const L = lastState.layers || {};
  const s = L.slide || null;
  const cleared = lastState.cleared || {};
  return {
    slide: (s && !cleared.slide) ? { lines: s.lines || [], footer: s.footer || '', group: s.group || '', notes: s.notes || '', chords: s.chords || null } : null,
    next: lastState.next ? { lines: lastState.next.lines || [], group: lastState.next.group || '' } : null,
    blackout: !!lastState.blackout,
    cleared,
    stageMessage: lastState.stageMessage || '',
    message: lastState.message ? lastState.message.text : '',
    timers: (lastState.timers || []).filter((t) => t && t.onStage !== false)
      .map((t) => ({ id: t.id, name: t.name, mode: t.mode, endsAt: t.endsAt, startedAt: t.startedAt, stoppedAt: t.stoppedAt, running: !!t.running })),
    macros: (lastState.macros || []).map((m) => ({ id: m.id, name: m.name })),
    at: Date.now(),
  };
}

function broadcast(state) {
  if (state) lastState = state;
  if (!clients.size) return;
  const payload = 'data: ' + JSON.stringify(publicState()) + '\n\n';
  for (const res of Array.from(clients)) {
    try { res.write(payload); } catch (e) { clients.delete(res); }
  }
}

function start(opts = {}) {
  cfg = Object.assign({}, cfg, opts);
  if (server) stop();
  return new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.on('error', (e) => {
      server = null;
      reject(new Error(e.code === 'EADDRINUSE'
        ? `Port ${cfg.port} is already in use — pick another one in the Show panel.`
        : 'Could not start the web output: ' + e.message));
    });
    // 0.0.0.0 so phones on the church wifi can reach it, not just this machine
    server.listen(cfg.port, '0.0.0.0', () => resolve({ port: cfg.port, urls: urls(), addresses: addresses() }));
  });
}

function stop() {
  for (const res of Array.from(clients)) { try { res.end(); } catch (e) {} }
  clients.clear();
  if (server) { try { server.close(); } catch (e) {} server = null; }
  return true;
}

const isRunning = () => !!server;
const state = () => ({ running: isRunning(), port: cfg.port, urls: urls(), addresses: addresses(), clients: clients.size, control: cfg.allowControl, passcode: !!cfg.passcode });
const setCommandHandler = (fn) => { onCommand = fn; };
const setLiveCommandHandler = (fn) => { onLiveCommand = fn; };

module.exports = {
  setLiveCommandHandler, start, stop, isRunning, state, broadcast, setCommandHandler, addresses, urls, publicState };
