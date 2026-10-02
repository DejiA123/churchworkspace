'use strict';
/*
 * WHICH ADDRESS DO I GIVE THE PHONE?
 *
 * "Phone Studio doesn't work even though I'm on the same wifi." The server was
 * fine — listening on 0.0.0.0, firewall allowed, phone on the same network. It
 * was the ADDRESS being handed out. Both servers listed every non-internal IPv4
 * interface in whatever order Node returned them, and on the church laptop that
 * is:
 *
 *   192.168.56.1     VirtualBox host-only    — nothing outside this PC exists on it
 *   172.31.80.1      Hyper-V Default Switch  — same
 *   169.254.252.171  link-local (APIPA)      — an adapter with no DHCP; unroutable
 *   169.254.27.68    link-local
 *   169.254.176.171  link-local
 *   192.168.8.100    WiFi                    — the ONLY one a phone can reach
 *
 * Six addresses, one of which works, presented in an order decided by nothing.
 * Anybody installing Docker, WSL, VirtualBox, VMware or Hyper-V — which is most
 * people with a laptop that also does video — gets the dead ones first.
 *
 * So addresses are FILTERED (link-local can never work) and RANKED (a real
 * network before a virtual one), and the caller shows the best first. The rest
 * are still offered, because ranking is a heuristic and the operator's odd
 * network might be the exception — but they are offered second.
 */
const os = require('os');

/* Adapter names that are virtual machines, containers or tunnels talking to
 * this computer only. Matched case-insensitively against the interface name. */
const VIRTUAL_HINTS = [
  'virtualbox', 'vmware', 'hyper-v', 'vethernet', 'default switch', 'wsl',
  'docker', 'loopback', 'npcap', 'tap-', 'tun', 'zerotier', 'tailscale',
  'radmin', 'hamachi', 'bluetooth', 'vpn', 'wintun', 'nordlynx',
];
/* …and names that are almost certainly the real thing. */
const REAL_HINTS = ['wi-fi', 'wifi', 'wlan', 'wireless', 'ethernet', 'eth', 'en0', 'lan'];

const isLinkLocal = (ip) => /^169\.254\./.test(ip);
const isPrivate = (ip) => /^192\.168\./.test(ip) || /^10\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

function scoreOf(name, ip) {
  const n = String(name).toLowerCase();
  let score = 0;
  if (VIRTUAL_HINTS.some((h) => n.includes(h))) score -= 100;
  if (REAL_HINTS.some((h) => n.includes(h))) score += 10;
  // Wi-Fi first: the phone is on the wifi, and a laptop plugged into a wired
  // network the phone cannot see is a very common church setup.
  if (/wi-?fi|wlan|wireless/.test(n)) score += 6;
  if (isPrivate(ip)) score += 20;
  /* 192.168.56.x is VirtualBox's default host-only network and 172.31.80.x is
   * Hyper-V's; both are private, so the private bonus above would otherwise
   * float them to the top on a machine whose adapter names are unhelpful. */
  if (/^192\.168\.56\./.test(ip)) score -= 60;
  if (/^172\.3[01]\./.test(ip)) score -= 40;
  return score;
}

/**
 * Every address a phone could plausibly reach, best first.
 * Link-local is dropped outright — it is unroutable by definition, so offering
 * it is offering a URL that cannot ever work.
 */
function candidates() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (isLinkLocal(i.address)) continue;
      out.push({ name, address: i.address, score: scoreOf(name, i.address), virtual: scoreOf(name, i.address) < 0 });
    }
  }
  out.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return out;
}

/** The one to print big. Null when this machine is on no network at all. */
function best() {
  const c = candidates();
  return c.length ? c[0] : null;
}

/** `http://ip:port` for every candidate, best first. */
const urlsFor = (port) => candidates().map((a) => `http://${a.address}:${port}`);

/**
 * What to tell the operator when nothing is reachable — the difference between
 * "no network" and "only virtual adapters" is the difference between plugging
 * the wifi in and ignoring a Docker install.
 */
function advice() {
  const c = candidates();
  if (!c.length) return 'This computer is not on a network. Connect it to the church wifi and try again.';
  if (c.every((a) => a.virtual)) {
    return 'This computer only has virtual network adapters (VirtualBox, Hyper-V or similar). '
      + 'Connect it to the church wifi and try again.';
  }
  return '';
}

module.exports = { candidates, best, urlsFor, advice, isLinkLocal, isPrivate };
