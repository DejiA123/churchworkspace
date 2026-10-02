'use strict';
/*
 * DMX lighting over Art-Net.
 *
 * Nearly every church lighting rig bought in the last decade speaks Art-Net —
 * it is DMX512 wrapped in a UDP packet on the ordinary network. That means the
 * presentation desk can dim the house lights for the sermon, snap a colour wash
 * for the last chorus, or trigger a scene on the lighting console, with no
 * extra hardware at all: one macro, one packet, done.
 *
 * The protocol is small enough to implement honestly:
 *   "Art-Net\0" | opcode 0x5000 (ArtDMX) | protocol version 14 |
 *   sequence | physical | universe (lo,hi) | length (hi,lo) | up to 512 slots
 *
 * A universe's 512 channels are held here and re-sent whole on every change,
 * because Art-Net is stateless — a fixture that misses one packet must be able
 * to catch up on the next one rather than sitting at the wrong colour all
 * service. A slow (1 Hz) refresh keeps the rig in sync even if nothing changes,
 * which is what the spec recommends and what consoles actually do.
 */
const dgram = require('dgram');

const PORT = 6454;
const HEADER = Buffer.from('Art-Net\0', 'ascii');

let sock = null;
let cfg = { host: '255.255.255.255', port: PORT, enabled: false, refreshMs: 1000 };
const universes = new Map();   // universe number -> { data: Buffer(512), seq }
let refresh = null;

function ensureSocket() {
  if (sock) return sock;
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('error', () => { try { sock.close(); } catch (e) {} sock = null; });
  sock.bind(() => {
    // A rig is usually addressed by broadcast, and a UDP socket will not
    // broadcast until it is told it may.
    try { sock.setBroadcast(true); } catch (e) {}
  });
  return sock;
}

function uni(n) {
  const k = Math.max(0, Math.min(32767, n | 0));
  if (!universes.has(k)) universes.set(k, { data: Buffer.alloc(512), seq: 0 });
  return universes.get(k);
}

/** One ArtDMX packet for a whole universe. */
function packet(n, u) {
  u.seq = (u.seq % 255) + 1;   // 0 means "don't care about ordering"; 1..255 cycles
  const b = Buffer.alloc(18 + 512);
  HEADER.copy(b, 0);
  b.writeUInt16LE(0x5000, 8);   // OpDmx
  b.writeUInt16BE(14, 10);      // protocol version, big-endian per the spec
  b.writeUInt8(u.seq, 12);
  b.writeUInt8(0, 13);          // physical port, informational only
  b.writeUInt8(n & 0xff, 14);   // universe low byte…
  b.writeUInt8((n >> 8) & 0x7f, 15); // …then net/subnet
  b.writeUInt16BE(512, 16);     // always a full universe: simpler and legal
  u.data.copy(b, 18);
  return b;
}

function send(n) {
  if (!cfg.enabled) return false;
  const u = uni(n);
  try { ensureSocket().send(packet(n, u), cfg.port, cfg.host); return true; }
  catch (e) { return false; }
}

/** Set one channel (1-512, as printed on every fixture) and push the universe. */
function setChannel(universe, channel, value) {
  const ch = Math.max(1, Math.min(512, channel | 0));
  const u = uni(universe);
  u.data[ch - 1] = Math.max(0, Math.min(255, value | 0));
  send(universe);
  return { universe: universe | 0, channel: ch, value: u.data[ch - 1] };
}

/** Several channels at once — a colour is three of them, and they must land together. */
function setChannels(universe, map) {
  const u = uni(universe);
  for (const [ch, v] of Object.entries(map || {})) {
    const c = Math.max(1, Math.min(512, parseInt(ch, 10) || 0));
    if (c) u.data[c - 1] = Math.max(0, Math.min(255, parseInt(v, 10) || 0));
  }
  send(universe);
  return channels(universe);
}

function blackout(universe) {
  const u = uni(universe);
  u.data.fill(0);
  send(universe);
  return true;
}

/**
 * "1.20=255" / "20=255" / "1.20=255,21=128" — the shorthand a macro step holds,
 * because typing a JSON object into a macro during a service is not a thing
 * anyone will do.
 */
function parseCommand(str) {
  const out = [];
  for (const part of String(str || '').split(/[,;]/)) {
    const m = /^\s*(?:(\d+)\s*[.:]\s*)?(\d+)\s*=\s*(\d+)\s*$/.exec(part);
    if (m) out.push({ universe: m[1] ? parseInt(m[1], 10) : 0, channel: parseInt(m[2], 10), value: parseInt(m[3], 10) });
  }
  return out;
}
/**
 * Run a whole shorthand command as ONE packet per universe. This matters more
 * than it looks: a colour is three channels, and sending them in three packets
 * makes a fixture visibly step through red then yellow then white on its way to
 * the colour you asked for.
 */
function command(str) {
  const list = parseCommand(str);
  const byUniverse = new Map();
  for (const c of list) {
    if (!byUniverse.has(c.universe)) byUniverse.set(c.universe, {});
    byUniverse.get(c.universe)[c.channel] = c.value;
  }
  for (const [u, map] of byUniverse) setChannels(u, map);
  return list;
}

const channels = (universe) => Array.from(uni(universe).data);

function configure(opts = {}) {
  cfg = Object.assign({}, cfg, opts);
  clearInterval(refresh);
  if (cfg.enabled) {
    ensureSocket();
    // Keep the rig in step even when nothing is changing.
    refresh = setInterval(() => { for (const n of universes.keys()) send(n); }, Math.max(200, cfg.refreshMs || 1000));
    if (refresh.unref) refresh.unref();
  }
  return state();
}
const state = () => ({ enabled: !!cfg.enabled, host: cfg.host, port: cfg.port, universes: Array.from(universes.keys()) });

function stop() {
  clearInterval(refresh); refresh = null;
  if (sock) { try { sock.close(); } catch (e) {} sock = null; }
  cfg.enabled = false;
  return true;
}

module.exports = { configure, state, setChannel, setChannels, blackout, command, parseCommand, channels, stop, packet, uni };
