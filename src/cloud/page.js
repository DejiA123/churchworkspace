'use strict';
/*
 * THE CLOUD PAGE IS NOT A SECOND VIDEO STUDIO. IT IS THE VIDEO STUDIO.
 *
 * There is exactly one way to ship "every functionality, nothing missing" and
 * keep it true next month: serve the REAL page. So this module does not write a
 * mobile editor — it takes `src/renderer/index.html`, lifts out the Video Studio
 * and everything it reaches (its modals, the progress overlay, the toast), and
 * re-heads it for a browser that is not Electron.
 *
 * Every id, every button, every tooltip is the desktop's own. A feature added to
 * the Video Studio tomorrow is in the cloud the moment the page is next served,
 * because nothing here lists what the studio HAS — it only lists what it does
 * NOT need (the other four studios' views, and the scripts that drive them).
 *
 * What genuinely has to be different, and why:
 *
 *   • the sidebar goes. Its five other studios are not reachable from here (Go
 *     Live and Presentation drive hardware that is in the building, not in the
 *     browser), so a nav that cannot navigate would only lie.
 *   • the <script> list is replaced. `renderer.js` is the desktop shell: it
 *     calls `api.onJobProgress`, drives the flyer editor, the scheduler, the
 *     accounts. The cloud shell (`cloud-boot.js`) provides the same handful of
 *     globals the Video Studio actually reaches for — and nothing else.
 *   • the CSP is rewritten. `file:` is meaningless over HTTP; `blob:` and the
 *     service worker are not.
 *
 * `check()` is the guard that makes the claim testable: it asserts that every
 * DOM id `veditor.js` reaches for is still present in what we generated. Move a
 * modal in index.html and the cloud page fails loudly instead of quietly losing
 * the caption editor.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const INDEX = path.join(RENDERER_DIR, 'index.html');

/** The studio's own view. Everything else in the nav stays on the desktop. */
const KEEP_VIEW = 'view-video';

/*
 * Renderer files the cloud page loads verbatim, served from /r/.
 * These are the Video Studio's own dependencies — the editor, the caption
 * layout engine that makes the preview and the export the same thing, the face
 * tracker, the word book, and the two the caption/text paths call into.
 */
const RENDERER_SCRIPTS = [
  'facetrack.js',    // auto-reframe — runs in THIS browser (MW_AI_BASE = /ai/)
  'caplayout.js',    // one layout module for preview and burn
  'wordbook.js',     // the same-wrong-word-never-twice list
  'capgrammar.js',   // the caption proof-reader (needs wordbook.js first)
  'icons.js',        // the studio's line icons
  'cutout.js',       // background removal for added pictures
  'flyerai.js',      // the model cut-out uses
  'rasterize.js',    // the ONE rasteriser behind text overlays and WYSIWYG captions
  'tasks.js',        // background exports + the one honest progress number
  'veditor.js',      // the Video Studio itself
];

/** Stylesheets the studio's markup expects. */
const RENDERER_STYLES = ['styles.css'];

/** Everything /r/ will hand over. Anything not named here is 404, not served. */
const SERVABLE = new Set([...RENDERER_SCRIPTS, ...RENDERER_STYLES]);

/* ------------------------------------------------------------- extraction */

/**
 * Cut out the balanced `<tag …>…</tag>` block that starts at `from`.
 * The markup here is hand-written and well formed, so counting opens against
 * closes is enough — and being wrong is loud (check() fails), not silent.
 */
function blockEnd(html, tag, from) {
  const open = new RegExp(`<${tag}\\b`, 'gi');
  const close = new RegExp(`</${tag}\\s*>`, 'gi');
  let depth = 0;
  let i = from;
  for (;;) {
    open.lastIndex = i; close.lastIndex = i;
    const o = open.exec(html);
    const c = close.exec(html);
    if (!c) return html.length;
    if (o && o.index < c.index) { depth++; i = o.index + 1; continue; }
    depth--;
    i = c.index + 1;
    if (depth <= 0) return c.index + c[0].length;
  }
}

/** Drop every `<section class="view" id="…">` except the one we keep. */
function stripOtherViews(html) {
  const re = /<section[^>]*class="[^"]*\bview\b[^"]*"[^>]*id="([A-Za-z0-9_-]+)"[^>]*>/gi;
  const cuts = [];
  let m;
  while ((m = re.exec(html))) {
    if (m[1] === KEEP_VIEW) continue;
    cuts.push([m.index, blockEnd(html, 'section', m.index)]);
  }
  for (let i = cuts.length - 1; i >= 0; i--) html = html.slice(0, cuts[i][0]) + html.slice(cuts[i][1]);
  return html;
}

/** Drop a whole element by a regex that matches its opening tag. */
function stripElement(html, openRe, tag) {
  const m = openRe.exec(html);
  if (!m) return html;
  return html.slice(0, m.index) + html.slice(blockEnd(html, tag, m.index));
}

/** Everything between <body> and the first <script> — the DOM, and only that. */
function bodyOf(html) {
  const start = html.indexOf('<body>');
  const end = html.search(/<script\b/i);
  if (start < 0 || end < 0) throw new Error('index.html does not look like the app page any more.');
  return html.slice(start + '<body>'.length, end);
}

/* ---------------------------------------------------------------- the page */

/**
 * The cache key every shell URL carries (`?v=…`), and so the service worker's
 * cache name. The version ALONE is not enough: a fix shipped without a version
 * bump kept the same key, and phones went on running last build's
 * cloud-boot.js out of their cache with the fix sitting on the server. So the
 * key is the version plus a hash of the files the shell is made of — change a
 * byte in any of them and every phone fetches the new one.
 */
let _assetKey = null;
function assetKey(version) {
  if (_assetKey && _assetKey.version === version) return _assetKey.key;
  const h = crypto.createHash('sha1');
  const files = [INDEX, ...[...RENDERER_SCRIPTS, ...RENDERER_STYLES].map((f) => path.join(RENDERER_DIR, f)),
    ...['cloud-boot.js', 'cloud.css', 'sw.js'].map((f) => path.join(__dirname, 'web', f))];
  for (const f of files) { try { h.update(fs.readFileSync(f)); } catch (e) {} }
  const key = version + '-' + h.digest('hex').slice(0, 10);
  _assetKey = { version, key };
  return key;
}

/**
 * Build the cloud page.
 *
 * @param {object} opts
 * @param {string} opts.version   what to show in the corner, and the cache key
 *                                for the service worker (a new build must not
 *                                serve last build's editor out of a phone cache)
 * @param {boolean} opts.needsPin whether to render the pairing gate
 */
function build(opts = {}) {
  const version = opts.version || '0';
  const key = assetKey(version);
  const raw = fs.readFileSync(INDEX, 'utf-8');

  let body = bodyOf(raw);
  body = stripOtherViews(body);
  body = stripElement(body, /<aside[^>]*class="[^"]*\bsidebar\b[^"]*"[^>]*>/i, 'aside');

  // The Video Studio's own view is the only one left, so it is the active one.
  body = body.replace(
    new RegExp(`<section([^>]*)class="view"([^>]*)id="${KEEP_VIEW}"`, 'i'),
    `<section$1class="view active"$2id="${KEEP_VIEW}"`,
  );

  const styles = RENDERER_STYLES.map((f) => `  <link rel="stylesheet" href="/r/${f}?v=${key}" />`).join('\n');
  const scripts = RENDERER_SCRIPTS.map((f) => `  <script src="/r/${f}?v=${key}"></script>`).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' blob: data:; worker-src 'self' blob:; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com;" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1, user-scalable=no" />
  <meta name="theme-color" content="#0d1117" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <meta name="apple-mobile-web-app-title" content="Video Studio" />
  <meta name="format-detection" content="telephone=no" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="apple-touch-icon" href="/icons/icon-192.png" />
  <link rel="icon" href="/icons/icon-192.png" />
  <title>Video Studio — Church Work Space</title>
${styles}
  <link rel="stylesheet" href="/cloud.css?v=${key}" />
</head>
<body class="mw-cloud">
  <!-- The cloud bar replaces the desktop sidebar: who you are connected to,
       how the work is getting home, and the way back to your files. -->
  <div id="cloudBar" class="cloud-bar">
    <div class="cloud-brand"><span class="cloud-logo">✝</span><span class="cloud-name">Video Studio</span><span id="cloudWhere" class="cloud-where"></span></div>
    <div class="cloud-bar-actions">
      <button id="cloudFiles" class="cloud-chip" title="Your recordings and finished exports on the studio machine">📁 Files</button>
      <button id="cloudDownloads" class="cloud-chip" title="Everything this session has finished — tap to save it to this phone">⬇ Saved <span id="cloudDlCount" class="cloud-badge hidden">0</span></button>
      <button id="cloudHelp" class="cloud-chip" title="What this is, and what to do when something is missing">?</button>
      <span id="cloudLink" class="cloud-link" title="Connection to the studio machine">●</span>
    </div>
  </div>

  <div id="cloudGate" class="cloud-gate">
    <form class="cloud-gate-box" id="cloudGateForm" autocomplete="off">
      <div class="cloud-gate-logo">✝</div>
      <h1>Video Studio</h1>
      <p class="cloud-gate-sub">Church Work Space, wherever you are.</p>
      <label for="cloudPass" class="cloud-gate-label">Access code</label>
      <input type="password" id="cloudPass" inputmode="text" autocomplete="current-password"
             placeholder="from the app's Settings → Cloud" enterkeyhint="go" />
      <label class="cloud-gate-remember"><input type="checkbox" id="cloudRemember" checked /> Keep me signed in on this device</label>
      <button type="submit" id="cloudGateGo" class="primary-btn cloud-gate-go">Open the studio</button>
      <div id="cloudGateMsg" class="cloud-gate-msg"></div>
      <div class="cloud-gate-foot">v${version}</div>
    </form>
  </div>

  <!-- Files on the studio machine: what you can open, and what you can send. -->
  <div id="cloudFilesModal" class="cap-modal hidden">
    <div class="cap-box cloud-files-box">
      <div class="cap-head">
        <strong>📁 Your files</strong>
        <button id="cloudFilesClose" class="ghost-btn small">✕</button>
      </div>
      <div class="cloud-files-bar">
        <button id="cloudUpload" class="primary-btn small">⬆ Send a video from this phone</button>
        <button id="cloudFilesRefresh" class="ghost-btn small">↻ Refresh</button>
      </div>
      <div id="cloudUploadBar" class="cloud-upload-bar hidden">
        <div class="cloud-upload-name"></div>
        <div class="progress"><div class="progress-bar" style="width:0%"></div></div>
        <button id="cloudUploadCancel" class="ghost-btn small">Stop</button>
      </div>
      <div id="cloudFilesList" class="cloud-files-list"></div>
    </div>
  </div>

  <!-- Finished work. On a phone "the file is in your output folder" is no use;
       this is the way it gets onto the phone itself. -->
  <div id="cloudDownloadsModal" class="cap-modal hidden">
    <div class="cap-box cloud-files-box">
      <div class="cap-head">
        <strong>⬇ Finished in this session</strong>
        <button id="cloudDownloadsClose" class="ghost-btn small">✕</button>
      </div>
      <div id="cloudDownloadsList" class="cloud-files-list"></div>
    </div>
  </div>

  <div id="cloudHelpModal" class="cap-modal hidden">
    <div class="cap-box cloud-help-box">
      <div class="cap-head"><strong>☁️ About this studio</strong><button id="cloudHelpClose" class="ghost-btn small">✕</button></div>
      <div id="cloudHelpBody" class="cloud-help-body"></div>
    </div>
  </div>

  <!-- Touch tools. The desk was built for a mouse and a keyboard; these are the
       shortcuts a thumb cannot reach for. They drive the very same buttons. -->
  <div id="cloudTouchBar" class="cloud-touchbar hidden">
    <button data-ct="undo" title="Undo">↶</button>
    <button data-ct="redo" title="Redo">↷</button>
    <button data-ct="zoomout" title="Zoom out">⊖</button>
    <button data-ct="zoomin" title="Zoom in">⊕</button>
    <button data-ct="split" title="Split at the playhead">✂</button>
    <button data-ct="delete" title="Delete what is selected">🗑</button>
    <button data-ct="play" class="cloud-ct-play" title="Play / pause">▶</button>
  </div>
${body}
  <!-- The shell first (it must own window.api before the studio asks for it),
       then the studio itself. Nothing is inlined: the CSP above forbids inline
       script, and weakening it for one bootstrap line would weaken it for every
       injection this page will ever meet. cloud-boot.js starts itself on
       DOMContentLoaded, by which time everything below has loaded. -->
  <script src="/cloud-boot.js?v=${key}"></script>
${scripts}
</body>
</html>
`;
}

/* ------------------------------------------------------------- the guard */

/** Every DOM id `veditor.js` reaches for. */
function idsVeditorNeeds() {
  const src = fs.readFileSync(path.join(RENDERER_DIR, 'veditor.js'), 'utf-8');
  const ids = new Set();
  for (const m of src.matchAll(/[$(]['"]#([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
  for (const m of src.matchAll(/getElementById\(['"]([A-Za-z0-9_-]+)['"]/g)) ids.add(m[1]);
  return ids;
}

/**
 * The `window.…` globals the Video Studio reaches for, and who provides them.
 *
 * THE OTHER HALF OF THE GUARD, and the half that was missing.
 *
 * `check()` below proves the page still has every DOM element the studio needs.
 * It says nothing about the SHELL — the handful of globals renderer.js gives the
 * studio on the desktop. When the background-export layer was added, the studio
 * began calling `window.__newTask` and seven friends; the cloud page had none of
 * them, and because the studio guards each call (`if (window.__newTask)`) it did
 * not crash. It quietly fell back to a full-screen overlay for a forty-minute
 * export and a percentage that reached 100 once per pass. Nothing failed, so
 * nothing said anything, for two weeks.
 *
 * So the shell surface is now checked too, against the scripts the cloud page
 * actually loads plus its own boot file.
 */
function shellCheck() {
  const need = new Set();
  for (const f of ['veditor.js', 'wordbook.js', 'caplayout.js', 'cutout.js']) {
    let src = '';
    try { src = fs.readFileSync(path.join(RENDERER_DIR, f), 'utf-8'); } catch (e) { continue; }
    for (const m of src.matchAll(/window\.(__[A-Za-z]+|finishedFile)\b/g)) need.add(m[1]);
  }

  // Everything the cloud page will have loaded by the time the studio runs.
  let provided = '';
  try { provided += fs.readFileSync(path.join(__dirname, 'web', 'cloud-boot.js'), 'utf-8'); } catch (e) {}
  for (const f of RENDERER_SCRIPTS) {
    try { provided += fs.readFileSync(path.join(RENDERER_DIR, f), 'utf-8'); } catch (e) {}
  }
  const has = new Set(Array.from(provided.matchAll(/window\.(__[A-Za-z]+|finishedFile)\s*=/g), (m) => m[1]));

  const missing = [...need].filter((n) => !has.has(n)).sort();
  return { ok: missing.length === 0, missing, checked: need.size };
}

/**
 * Does the generated page still contain everything the studio reaches for?
 *
 * Ids the studio CREATES at runtime are not in index.html either, so the test
 * is "present in the desktop page but missing from the cloud page" — that is
 * exactly the breakage this guards against, and it cannot false-alarm on a
 * dynamically built element.
 *
 * @returns {{ok:boolean, missing:string[], checked:number}}
 */
function check(html) {
  const page = html || build({ version: 'check' });
  const desktop = fs.readFileSync(INDEX, 'utf-8');
  const idsIn = (s) => new Set(Array.from(s.matchAll(/id="([A-Za-z0-9_-]+)"/g), (m) => m[1]));
  const inCloud = idsIn(page);
  const inDesktop = idsIn(desktop);
  const missing = [];
  let checked = 0;
  for (const id of idsVeditorNeeds()) {
    if (!inDesktop.has(id)) continue;   // built at runtime — nothing to keep
    checked++;
    if (!inCloud.has(id)) missing.push(id);
  }
  return { ok: missing.length === 0, missing, checked };
}

module.exports = {
  build, check, shellCheck, idsVeditorNeeds,
  RENDERER_DIR, RENDERER_SCRIPTS, RENDERER_STYLES, SERVABLE, KEEP_VIEW,
};
