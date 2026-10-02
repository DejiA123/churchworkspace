'use strict';
/*
 * The motion backgrounds the Presentation Studio offers.
 *
 * The gallery ships as posters only (see scripts/build-bg-videos.js); the clip
 * itself arrives on the click that chooses it and lands in
 * <userData>/backgrounds/<id>.mp4. After that it is an ordinary local file —
 * the slide holds a path, the projector plays it off the disk, and the church
 * wifi is never again between the operator and the picture.
 *
 * Downloads are atomic: bytes go to <id>.mp4.part and the file is only renamed
 * into place once the whole thing has arrived. A half-file that still had the
 * right name would be worse than no file at all — it plays for four seconds on
 * a Sunday and then stops.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

let ROOT = null;

function init(userDataDir) {
  ROOT = path.join(userDataDir, 'backgrounds');
  try { fs.mkdirSync(ROOT, { recursive: true }); } catch (e) {}
  return ROOT;
}
const root = () => ROOT || init(path.join(require('os').homedir(), '.church-work-space'));
const safeId = (id) => String(id || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
const fileFor = (id) => path.join(root(), safeId(id) + '.mp4');

/** Which clips are already on this machine, and how much room they take. */
function installed() {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(root()); } catch (e) { return out; }
  for (const f of files) {
    if (!f.endsWith('.mp4')) continue;
    try {
      const st = fs.statSync(path.join(root(), f));
      out.push({ id: path.basename(f, '.mp4'), file: path.join(root(), f), bytes: st.size });
    } catch (e) {}
  }
  return out;
}
const isInstalled = (id) => fs.existsSync(fileFor(id));
const pathFor = (id) => (isInstalled(id) ? fileFor(id) : null);

/**
 * Fetch one clip. `url` comes from the bundled manifest, and is checked against
 * the host it is supposed to come from — a URL is the one thing here that could
 * turn "click a background" into "download anything at all".
 */
function download(id, url, { onProgress, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const key = safeId(id);
    if (!key) return reject(new Error('That background has no id.'));
    let u;
    try { u = new URL(String(url)); } catch (e) { return reject(new Error('That background has no usable link.')); }
    if (u.protocol !== 'https:' || !/(^|\.)pixabay\.com$/i.test(u.hostname)) {
      return reject(new Error('That background link is not one of the built-in ones.'));
    }
    if (isInstalled(key)) return resolve({ id: key, file: fileFor(key), bytes: fs.statSync(fileFor(key)).size, already: true });

    fs.mkdirSync(root(), { recursive: true });
    const tmp = fileFor(key) + '.part';
    const out = fs.createWriteStream(tmp);
    const fail = (err) => {
      try { out.destroy(); } catch (e) {}
      try { fs.rmSync(tmp, { force: true }); } catch (e) {}
      reject(err);
    };
    const req = https.get(u.toString(), { headers: { 'User-Agent': 'ChurchWorkSpace' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 4) {
        res.resume();
        out.destroy(); try { fs.rmSync(tmp, { force: true }); } catch (e) {}
        return resolve(download(key, res.headers.location, { onProgress, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`The background server said ${res.statusCode}.`)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      res.on('data', (c) => {
        got += c.length;
        if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
      });
      res.on('error', fail);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        try {
          // A truncated download is a file that plays for four seconds and stops.
          if (total && got < total) throw new Error('The download was cut short — try again.');
          fs.renameSync(tmp, fileFor(key));
        } catch (e) { return fail(e instanceof Error ? e : new Error(String(e))); }
        if (onProgress) onProgress(100);
        resolve({ id: key, file: fileFor(key), bytes: got });
      }));
    });
    req.on('error', (e) => fail(new Error('Could not reach the background library: ' + e.message)));
    req.setTimeout(180000, () => { req.destroy(new Error('The download took too long.')); });
  });
}

function remove(id) {
  try { fs.rmSync(fileFor(id), { force: true }); } catch (e) {}
  return true;
}

module.exports = { init, root, installed, isInstalled, pathFor, download, remove };
