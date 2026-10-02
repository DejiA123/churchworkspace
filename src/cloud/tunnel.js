'use strict';
/*
 * THE PUBLIC DOOR.
 *
 * The Cloud Studio server listens on this machine. On the church wifi that is
 * enough; from a train in another country it is not, because the church's
 * router does not forward ports and nobody should be asking a volunteer to make
 * it. So the way out is a tunnel: a process here dials OUT to Cloudflare, and
 * Cloudflare hands back an https:// address that anyone, anywhere, can open.
 *
 * Why Cloudflare's quick tunnel and not the alternatives:
 *
 *   • no account, no card, no sign-up — a church cannot be asked to register
 *     for a service to get its own editor onto a phone;
 *   • https with a real certificate, which is not a nicety: a PWA will not
 *     install, and getUserMedia/clipboard will not work, over plain http on
 *     anything but localhost;
 *   • it is an OUTBOUND connection, so the router and the firewall stay shut.
 *     Nothing is exposed on the church's network; the only way in is the URL,
 *     and behind it the access code.
 *
 * The honest limitation, which the UI says too: a quick tunnel's address is
 * random and changes every time it starts. For a fixed address (studio.our
 * church.org) a Cloudflare account gives a tunnel TOKEN, and pasting that in
 * uses it instead — same binary, same door, a name that stays put.
 *
 * cloudflared is not bundled. It is ~50 MB, it updates often, and a stale copy
 * is worse than none — so it installs on request, into the same tools folder
 * the YouTube helper uses (see library.js, which this follows deliberately).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const REPO = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';

/** The release asset for this machine, and what it is once unpacked. */
function asset() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return { file: `cloudflared-windows-${arch}.exe`, local: 'cloudflared.exe', tgz: false };
  if (process.platform === 'darwin') return { file: `cloudflared-darwin-${arch}.tgz`, local: 'cloudflared', tgz: true };
  return { file: `cloudflared-linux-${arch}`, local: 'cloudflared', tgz: false };
}

let toolsDir = () => path.join(os.homedir(), '.church-work-space', 'tools');
/** The app tells us where its tools live, so this and yt-dlp share one folder. */
function setToolsDir(fn) { if (fn) toolsDir = typeof fn === 'function' ? fn : () => fn; }

/* ------------------------------------------------------------------ state */

let proc = null;
let publicUrl = '';
let lastError = '';
let starting = false;
let onUrl = null;          // told when the address arrives or changes

/* --------------------------------------------------------------- finding */

/** Where cloudflared is, or null. Our tools folder, then PATH. */
function binPath() {
  const local = path.join(toolsDir(), asset().local);
  try { if (fs.existsSync(local)) return local; } catch (e) {}
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try { const p = path.join(d, name); if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function status() {
  const p = binPath();
  return {
    available: !!p,
    path: p,
    running: !!proc,
    url: publicUrl,
    error: lastError,
    installDir: toolsDir(),
    sizeMb: 50,
    howTo: p ? null : 'A public address needs one free helper from Cloudflare (~50 MB). Click “Get a public address” once and the app downloads it for you.',
  };
}

/* -------------------------------------------------------------- installing */

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects while downloading the tunnel helper.'));
    https.get(url, { headers: { 'User-Agent': 'ChurchWorkSpace' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
      });
      res.pipe(out);
      out.on('error', reject);
      out.on('finish', () => out.close(() => {
        try {
          fs.renameSync(tmp, dest);
          if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
          resolve(dest);
        } catch (e) { reject(e); }
      }));
    }).on('error', (e) => reject(new Error('Could not reach the download server: ' + e.message)));
  });
}

async function install({ onProgress } = {}) {
  const have = binPath();
  if (have) return { ok: true, path: have, already: true };
  const a = asset();
  const dir = toolsDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, a.tgz ? a.file : a.local);
  await download(REPO + a.file, dest, onProgress);
  if (a.tgz) {
    // macOS ships it as a tarball; tar is on every Mac.
    await new Promise((resolve, reject) => {
      const t = spawn('tar', ['-xzf', dest, '-C', dir], { windowsHide: true });
      t.on('error', reject);
      t.on('close', (code) => (code === 0 ? resolve() : reject(new Error('Could not unpack the tunnel helper.'))));
    });
    try { fs.rmSync(dest, { force: true }); } catch (e) {}
    try { fs.chmodSync(path.join(dir, a.local), 0o755); } catch (e) {}
  }
  const p = binPath();
  if (!p) throw new Error('The tunnel helper did not install.');
  if (onProgress) onProgress(100);
  return { ok: true, path: p };
}

/* ---------------------------------------------------------------- running */

/**
 * Open the door.
 *
 * @param {number} port     the Cloud Studio's port on this machine
 * @param {object} opts
 * @param {string} opts.token  a Cloudflare tunnel token, for a FIXED address
 * @param {function} opts.onUrl called with the address when it arrives
 */
function start(port, opts = {}) {
  if (proc) return Promise.resolve({ url: publicUrl, running: true });
  const bin = binPath();
  if (!bin) return Promise.reject(new Error('The tunnel helper is not installed yet.'));

  onUrl = opts.onUrl || null;
  lastError = '';
  publicUrl = '';
  starting = true;

  const args = opts.token
    ? ['tunnel', '--no-autoupdate', 'run', '--token', String(opts.token)]
    : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`];

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; starting = false; fn(v); } };

    try {
      proc = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      starting = false;
      return reject(new Error('Could not start the tunnel helper: ' + e.message));
    }

    /*
     * cloudflared announces the address on stderr, inside a box of pipes and
     * dashes. Matching the URL itself rather than the banner around it is
     * deliberate — the banner has been redrawn more than once, the hostname has
     * not.
     */
    const read = (buf) => {
      const s = buf.toString();
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(s);
      if (m && m[0] !== publicUrl) {
        publicUrl = m[0];
        if (onUrl) { try { onUrl(publicUrl); } catch (e) {} }
        done(resolve, { url: publicUrl, running: true });
      }
      // A named tunnel never prints a trycloudflare address — it is up when it
      // says it has registered a connection.
      if (opts.token && /Registered tunnel connection|Connection .* registered/i.test(s)) {
        done(resolve, { url: opts.token ? (opts.hostname || '') : '', running: true });
      }
      if (/failed to (dial|connect)|error=|ERR /i.test(s) && !publicUrl) lastError = s.trim().slice(-300);
    };

    proc.stdout.on('data', read);
    proc.stderr.on('data', read);

    proc.on('error', (e) => {
      proc = null;
      lastError = e.message;
      done(reject, new Error('The tunnel helper could not run: ' + e.message));
    });
    proc.on('close', (code) => {
      proc = null;
      publicUrl = '';
      if (onUrl) { try { onUrl(''); } catch (e) {} }
      if (!settled) done(reject, new Error(lastError || `The tunnel closed straight away (exit ${code}).`));
    });

    // A quick tunnel normally answers in a second or two; a minute means it is
    // not going to, and saying so beats a spinner that never stops.
    setTimeout(() => {
      if (!settled) {
        try { if (proc) proc.kill(); } catch (e) {}
        done(reject, new Error(lastError || 'The tunnel did not come up. Check this machine can reach the internet.'));
      }
    }, 60000);
  });
}

function stop() {
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
  publicUrl = '';
  starting = false;
  return true;
}

const isRunning = () => !!proc;
const url = () => publicUrl;

module.exports = { status, install, start, stop, isRunning, url, setToolsDir, binPath, asset, _starting: () => starting };
