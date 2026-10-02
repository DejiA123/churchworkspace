'use strict';
/*
 * THE CLOUD STUDIO'S GROUND FLOOR.
 *
 * The page above this file is the real Video Studio — the desktop's own markup,
 * its own veditor.js, its own caption engine. That code knows how to ask for
 * things; it does not know, and must never learn, that the answers now come
 * over the internet instead of over Electron IPC. Keeping it ignorant is the
 * entire trick, because the moment the editor has a "cloud mode" branch in it,
 * the cloud has a feature that the desktop can lose.
 *
 * So this file is a set of impersonations:
 *
 *   window.api            — the preload bridge, over HTTP. Same names, same
 *                           arguments, same thrown errors, same `{ok,data}`
 *                           envelope unwrapped the same way.
 *   window.__toast, __runJob, __showOverlay, finishedFile, …
 *                         — the handful of globals renderer.js gives the studio
 *                           on the desktop. renderer.js is the DESKTOP shell
 *                           (flyers, accounts, the scheduler); none of that
 *                           belongs here, but these seven do.
 *   window.MW_FILE_URL    — "a file on the studio machine" as a URL this
 *                           browser can actually load.
 *   window.MW_AI_BASE     — MediaPipe's wasm, served from the studio machine,
 *                           so auto-reframe runs in THIS browser exactly as it
 *                           does in the desktop window.
 *
 * And a set of translations, for the three things a browser genuinely cannot do
 * the way Electron does:
 *
 *   • there is no native Open dialog, so `dialog.openFile` opens a chooser that
 *     offers both the studio machine's own folders AND this device's files
 *     (uploading the latter, resumably, because phones lose signal);
 *   • there is no "show in folder", so `shell.openPath` on a finished export
 *     becomes a download to this device — which is what "open it" means when
 *     you are not sitting at the machine;
 *   • there is no mouse. The desk was built for one: fifteen `mousedown`
 *     handlers drive every drag on the timeline. Rather than touch-enable the
 *     editor (a second code path through the most fiddly code in the app), a
 *     bridge turns a finger into a mouse over the surfaces that drag, and
 *     leaves scrolling alone everywhere else.
 */

(function () {
  /* ------------------------------------------------------------ constants */

  const TOKEN_KEY = 'mw.cloud.token';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  let token = '';
  try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { token = ''; }

  const cloud = {
    version: '',
    hello: null,
    started: false,
    events: null,
    downloads: [],      // { path, name, at } — what this session has finished
    online: true,
  };
  window.MWCloud = cloud;

  /* ------------------------------------------------------------ transport */

  const MAGIC = 'MWRPC1';
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const isBinary = (v) => (v && (ArrayBuffer.isView(v) || v instanceof ArrayBuffer));

  /**
   * Pack a call. Bytes travel beside the JSON, not inside it: a caption track is
   * hundreds of PNG frames, and `JSON.stringify(new Uint8Array(…))` turns every
   * one of them into {"0":137,"1":80,…} — about six times the bytes, and a parse
   * that allocates an object per byte. See the same format in cloud-api.js.
   */
  function pack(payload) {
    const bins = [];
    const swap = (v, d) => {
      if (d > 12 || v == null) return v;
      if (isBinary(v)) {
        bins.push(v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        return { __bin: bins.length - 1 };
      }
      if (Array.isArray(v)) return v.map((x) => swap(x, d + 1));
      if (typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v)) out[k] = swap(v[k], d + 1);
        return out;
      }
      return v;
    };
    const head = swap(payload, 0);
    if (!bins.length) return { body: JSON.stringify(head), type: 'application/json' };
    head.__bins = bins.map((b) => b.byteLength);
    const headBytes = enc.encode(JSON.stringify(head));
    const total = MAGIC.length + 4 + headBytes.length + bins.reduce((n, b) => n + b.byteLength, 0);
    const buf = new Uint8Array(total);
    let at = 0;
    for (let i = 0; i < MAGIC.length; i++) buf[at++] = MAGIC.charCodeAt(i);
    new DataView(buf.buffer).setUint32(at, headBytes.length, false); at += 4;
    buf.set(headBytes, at); at += headBytes.length;
    for (const b of bins) { buf.set(b, at); at += b.byteLength; }
    return { body: buf, type: 'application/x-mw-rpc' };
  }

  function unpack(buf) {
    const u8 = new Uint8Array(buf);
    let magic = '';
    for (let i = 0; i < MAGIC.length && i < u8.length; i++) magic += String.fromCharCode(u8[i]);
    if (magic !== MAGIC) return JSON.parse(dec.decode(u8));
    const headLen = new DataView(u8.buffer, u8.byteOffset).getUint32(MAGIC.length, false);
    const headStart = MAGIC.length + 4;
    const head = JSON.parse(dec.decode(u8.subarray(headStart, headStart + headLen)));
    const lens = head.__bins || [];
    const blobs = [];
    let at = headStart + headLen;
    for (const n of lens) { blobs.push(u8.subarray(at, at + n)); at += n; }
    delete head.__bins;
    const swap = (v, d) => {
      if (d > 12 || v == null) return v;
      if (Array.isArray(v)) return v.map((x) => swap(x, d + 1));
      if (typeof v === 'object') {
        if (typeof v.__bin === 'number') return blobs[v.__bin] || new Uint8Array(0);
        const out = {};
        for (const k of Object.keys(v)) out[k] = swap(v[k], d + 1);
        return out;
      }
      return v;
    };
    return swap(head, 0);
  }

  const authHeaders = () => (token ? { Authorization: 'Bearer ' + token } : {});

  /**
   * One RPC. Unwraps the same `{ ok, data, error }` envelope the preload bridge
   * unwraps, including the cancelled flag — so a job the operator stopped reads
   * as "stopped" here too, and not as "ffmpeg crashed".
   */
  async function call(channel, args) {
    const packed = pack({ channel, args: args || {} });
    let res;
    try {
      res = await fetch('/api/rpc', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': packed.type }, authHeaders()),
        body: packed.body,
      });
    } catch (e) {
      setLink(false);
      // The job itself is running on the studio machine and is NOT affected by
      // this browser losing signal — saying "failed" would be a lie that makes
      // people re-run a twenty-minute export.
      const err = new Error('Lost the connection to the studio. The job may still be running there — it will reappear when you are back.');
      err.offline = true;
      throw err;
    }
    setLink(true);
    if (res.status === 401) { signedOut(); throw new Error('Signed out.'); }
    const ct = res.headers.get('content-type') || '';
    const env = ct.indexOf('x-mw-rpc') >= 0 ? unpack(await res.arrayBuffer()) : await res.json();
    if (env && env.ok) return env.data;
    const err = new Error((env && env.error) || ('Unknown error in ' + channel));
    if (env && env.cancelled) err.cancelled = true;
    throw err;
  }

  /* ------------------------------------------------------- files as URLs */

  /** A path on the studio machine, as something this browser can load. */
  window.MW_FILE_URL = (p) => '/api/media?p=' + encodeURIComponent(p) + (token ? '&k=' + encodeURIComponent(token) : '');
  const downloadUrl = (p) => '/api/file?p=' + encodeURIComponent(p) + '&dl=1' + (token ? '&k=' + encodeURIComponent(token) : '');

  /* MediaPipe loads its own runtime by appending names to this base, so it has
   * to be a plain path with no query on it. Served unauthenticated for exactly
   * that reason — see the note in cloud-api.js. */
  window.MW_AI_BASE = '/ai/';

  /* -------------------------------------------------------- the api shim */

  /*
   * Shaped to match src/main/preload.js argument for argument. When a channel
   * is added there, it is added here — and the allowlist in cloud-api.js is
   * what decides whether it may actually run from out here.
   */
  window.api = {
    settings: {
      // The cloud never hands out the settings file: it holds API keys and
      // social tokens. The studio does not read them anyway.
      get: async () => ({}),
      update: async () => ({}),
    },
    paths: { get: () => call('paths:get') },
    dialog: {
      openFile: (filters, multi) => pickFiles(filters, multi),
      saveFile: async (defaultName) => {
        // There is no Save dialog in a browser. Everything lands in the output
        // folder on the studio machine and is offered to this device after.
        const p = await call('paths:get');
        const name = String(defaultName || 'export').replace(/[^\w.\- ()]+/g, '_');
        return (p && p.outputDir ? p.outputDir + '/' : '') + name;
      },
      openDir: async () => null,
    },
    video: {
      info: (input) => call('video:info', { input }),
      thumbnail: (input, timeSec) => call('video:thumbnail', { input, timeSec }),
      trim: (a) => call('video:trim', a),
      export: (a) => call('video:export', a),
      extractAudio: (a) => call('video:extractAudio', a),
      audioSample: (a) => call('video:audioSample', a),
      autoTrim: (a) => call('video:autoTrim', a),
      merge: (a) => call('video:merge', a),
      joinPieces: (a) => call('video:joinPieces', a),
      captions: (a) => call('video:captions', a),
      presets: () => call('video:presets'),
      filmstrip: (a) => call('video:filmstrip', a),
      makeProxy: (a) => call('video:makeProxy', a),
      applyEdits: (a) => call('video:applyEdits', a),
      waveform: (a) => call('video:waveform', a),
      stabilize: (a) => call('video:stabilize', a),
      reverse: (a) => call('video:reverse', a),
      freezeFrame: (a) => call('video:freezeFrame', a),
      overlayComposite: (a) => call('video:overlayComposite', a),
      detectSilence: (a) => call('video:detectSilence', a),
      mixMusic: (a) => call('video:mixMusic', a),
      appendClips: (a) => call('video:appendClips', a),
      attachThumb: (a) => call('video:attachThumb', a),
      extractFrames: (a) => call('video:extractFrames', a),
    },
    job: { cancel: (id) => call('job:cancel', { id }) },
    reframe: {
      aiState: () => call('reframe:aiState'),
      whoIsSpeaking: (a) => call('reframe:whoIsSpeaking', a || {}),
    },
    sessions: {
      list: () => call('session:list'),
      save: (id, name, data) => call('session:save', { id, name, data }),
      load: (id) => call('session:load', { id }),
      remove: (id) => call('session:remove', { id }),
      rename: (id, name) => call('session:rename', { id, name }),
      autosave: (data) => call('session:autosave', { data }),
      autosaveGet: () => call('session:autosaveGet'),
      autosaveClear: () => call('session:autosaveClear'),
      exportTo: (id, dest) => call('session:export', { id, dest }),
      importFrom: (src) => call('session:import', { src }),
    },
    library: {
      list: () => call('library:list'),
      add: (kind, p, name, source) => call('library:add', { kind, path: p, name, source }),
      remove: (kind, id) => call('library:remove', { kind, id }),
      rename: (kind, id, name) => call('library:rename', { kind, id, name }),
    },
    youtube: {
      status: () => call('youtube:status'),
      install: (a) => call('youtube:install', a || {}),
      search: (query, limit, copyrightFree) => call('youtube:search', { query, limit, copyrightFree }),
      import: (a) => call('youtube:import', a),
    },
    sermon: {
      analyze: (a) => call('sermon:analyze', a),
      exportShort: (a) => call('sermon:exportShort', a),
      exportReframed: (a) => call('sermon:exportReframed', a),
      exportFramed: (a) => call('sermon:exportFramed', a),
      extractFrames: (a) => call('video:extractFrames', a),
      attachThumb: (a) => call('video:attachThumb', a),
      rmdir: (dir) => call('fs:rmdir', { dir }),
    },
    captions: {
      available: () => call('captions:available'),
      engineInfo: () => call('captions:engineInfo'),
      transcribe: (a) => call('captions:transcribe', a),
      fonts: () => call('captions:fonts'),
      fontList: () => call('captions:fontList'),
      burn: (a) => call('captions:burn', a),
      burnTrack: (a) => call('captions:burnTrack', a),
      models: () => call('captions:models'),
      downloadModel: (a) => call('captions:downloadModel', a),
      removeModel: (a) => call('captions:removeModel', a),
      wordbook: {
        get: () => call('wordbook:get'),
        options: (a) => call('wordbook:options', a),
        addFix: (a) => call('wordbook:addFix', a),
        updateFix: (a) => call('wordbook:updateFix', a),
        removeFix: (a) => call('wordbook:removeFix', a),
        addTerm: (a) => call('wordbook:addTerm', a),
        removeTerm: (a) => call('wordbook:removeTerm', a),
        learn: (a) => call('wordbook:learn', a),
        tidy: () => call('wordbook:tidy'),
      },
    },
    llm: {
      status: () => call('llm:status'),
      install: (a) => call('llm:install', a),
      removeModel: (a) => call('llm:removeModel', a),
    },
    overlays: {
      burn: (a) => call('overlays:burn', a),
      burnImages: (a) => call('overlays:burnImages', a),
    },
    fonts: { data: () => call('fonts:data') },
    fs: {
      readImageDataUrl: (p) => call('fs:readImageDataUrl', { path: p }),
      writeImageDataUrl: (dataUrl, name) => call('fs:writeImageDataUrl', { dataUrl, name }),
      readText: async () => { throw new Error('Reading files on the studio machine is not available from the cloud.'); },
      writeText: async () => { throw new Error('Writing files on the studio machine is not available from the cloud.'); },
    },
    shell: {
      // "Open it" from four thousand miles away means "put it on my phone".
      openPath: (p) => { offerDownload(p); return Promise.resolve(true); },
      showItem: (p) => { offerDownload(p); return Promise.resolve(true); },
      openExternal: (u) => { window.open(u, '_blank', 'noopener'); return Promise.resolve(true); },
    },
    onJobProgress: (cb) => { jobProgressCbs.push(cb); return () => { jobProgressCbs = jobProgressCbs.filter((f) => f !== cb); }; },
    onSchedulerDue: () => () => {},
  };

  /* ---------------------------------------------------- the desktop shell */

  /*
   * What renderer.js gives the Video Studio on the desktop. Not a reimagining —
   * the same seven globals, doing the same things to the same DOM (the toast and
   * the progress overlay came across with the page), so the studio's own calls
   * land exactly where they expect to.
   */
  function toast(msg, kind = '', ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast ' + kind;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms || 4200);
  }
  window.__toast = toast;

  let _jobCounter = 0;
  const newJobId = () => 'job_' + (++_jobCounter) + '_' + Date.now();

  let _hideTimer = null;
  function showOverlay(msg) {
    clearTimeout(_hideTimer); _hideTimer = null;
    const m = $('#overlayMsg'); if (m) m.textContent = msg || 'Working…';
    const b = $('#progressBar'); if (b) b.style.width = '0%';
    const o = $('#overlay'); if (o) o.classList.remove('hidden');
  }
  function setProgress(p) {
    const b = $('#progressBar');
    if (b) b.style.width = Math.max(2, Math.min(100, p)) + '%';
  }
  function hideOverlay() {
    clearTimeout(_hideTimer); _hideTimer = null;
    const o = $('#overlay'); if (o) o.classList.add('hidden');
    setJobBatch(null);
    showCancel(null);
  }
  function setJobBatch(i, n) {
    const el = $('#overlayBatch');
    if (!el) return;
    if (!i || !n) { el.classList.add('hidden'); el.textContent = ''; }
    else { el.classList.remove('hidden'); el.textContent = `Short ${i} of ${n}`; }
  }

  let _cancelJobId = null;
  const _cancelledJobs = new Set();
  function showCancel(jobId) {
    const b = $('#overlayCancel');
    _cancelJobId = jobId || null;
    if (!b) return;
    b.classList.toggle('hidden', !jobId);
    b.disabled = false;
    b.textContent = '✕ Cancel';
  }
  async function cancelCurrentJob() {
    const id = _cancelJobId;
    if (!id) return;
    const b = $('#overlayCancel');
    if (b) { b.disabled = true; b.textContent = 'Stopping…'; }
    _cancelledJobs.add(id);
    try { await window.api.job.cancel(id); } catch (e) { /* it may have just finished */ }
  }
  const jobWasCancelled = (jobId, err) => !!(err && err.cancelled) || (jobId && _cancelledJobs.has(jobId));
  window.__jobWasCancelled = jobWasCancelled;
  window.__cancelJob = cancelCurrentJob;
  // tasks.js drives the overlay's Cancel button as it moves through a chain.
  window.__showCancel = showCancel;

  /*
   * runJob is NOT here. It lives in tasks.js, which both pages load: it is the
   * task-aware one that knows an export is a chain of passes, can send the whole
   * chain to the background, and reports one honest number for it. A simpler copy
   * used to sit here, and the moment tasks.js arrived that copy became a second
   * implementation of the most important loop in the studio — so it went.
   */

  /**
   * A finished file. On the desktop this opens the folder; here the file is on
   * a machine you are not sitting at, so it goes on the list this device can
   * pull down — and the first one announces itself, because "where did it go"
   * is the question a phone always has.
   */
  function finishedFile(p) {
    const name = String(p).split(/[\\/]/).pop();
    if (!cloud.downloads.some((d) => d.path === p)) cloud.downloads.unshift({ path: p, name, at: Date.now() });
    renderDownloadCount();
    toast('✅ Saved on the studio machine: ' + name + ' — tap ⬇ Saved to put it on this device.', 'good', 6000);
  }
  window.finishedFile = finishedFile;

  window.__newJobId = newJobId;
  window.__showOverlay = showOverlay;
  window.__hideOverlay = hideOverlay;
  window.__setJobBatch = setJobBatch;
  window.__setProgress = setProgress;

  /* ------------------------------------------------------ live connection */

  let jobProgressCbs = [];

  function setLink(ok) {
    cloud.online = !!ok;
    const el = $('#cloudLink');
    if (el) {
      el.classList.toggle('bad', !ok);
      el.title = ok ? 'Connected to the studio machine' : 'Cannot reach the studio machine';
    }
  }

  function connectEvents() {
    if (!token) return;
    try { if (cloud.events) cloud.events.close(); } catch (e) {}
    const es = new EventSource('/api/events?k=' + encodeURIComponent(token));
    cloud.events = es;
    es.onopen = () => setLink(true);
    es.onerror = () => {
      setLink(false);
      // EventSource reconnects on its own; nothing to do but say so.
    };
    es.addEventListener('job:progress', (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch (er) { return; }
      /*
       * Fan out only — the bar is NOT driven from here.
       *
       * tasks.js registers the same routing the desktop uses: a reading is
       * matched to the export it belongs to, turned into how far that whole
       * export has got, and shown on the chip if it is running in the
       * background. Setting the bar here as well would let a background encode
       * drive the progress of whatever the operator is doing in front of it,
       * and would flick the number between "this pass" and "this export".
       */
      jobProgressCbs.forEach((cb) => { try { cb(d); } catch (er) {} });
    });
    es.addEventListener('upload:progress', (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch (er) { return; }
      showUploadProgress(d);
    });
  }

  /* -------------------------------------------------------------- signing in */

  function signedOut() {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    const gate = $('#cloudGate');
    if (gate) gate.classList.remove('gone');
    const msg = $('#cloudGateMsg');
    if (msg) { msg.textContent = 'Signed out. Enter the access code again.'; msg.className = 'cloud-gate-msg'; }
  }

  async function signIn(code, remember) {
    const msg = $('#cloudGateMsg');
    const btn = $('#cloudGateGo');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    if (msg) { msg.textContent = ''; msg.className = 'cloud-gate-msg'; }
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, remember: !!remember }),
      });
      const out = await res.json();
      if (!res.ok || !out.token) throw new Error(out.error || 'That code is not right.');
      token = out.token;
      try { localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      $('#cloudGate').classList.add('gone');
      await startStudio();
    } catch (e) {
      if (msg) { msg.textContent = e.message || String(e); msg.className = 'cloud-gate-msg bad'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Open the studio'; }
    }
  }

  /* ------------------------------------------------- choosing a file to open */

  /*
   * The desktop's Open dialog can see the whole machine. A browser cannot see
   * any of it — but the machine it is talking to can, and that is where the
   * sermon already is. So the chooser offers both sides: the studio's own
   * folders (open instantly, nothing to transfer) and this device's files
   * (uploaded first, with progress, resumable).
   */
  let pickResolve = null;
  let pickState = { multi: false, exts: null };

  function extsOf(filters) {
    // `openFile` is called with an array of filters, and in one place with
    // { filters: [...] }. Accept both rather than make the studio care.
    const list = Array.isArray(filters) ? filters : (filters && filters.filters) || [];
    const out = [];
    for (const f of list) for (const e of (f && f.extensions) || []) if (e && e !== '*') out.push('.' + String(e).toLowerCase());
    return out.length ? out : null;
  }

  function pickFiles(filters, multi) {
    pickState = { multi: !!multi, exts: extsOf(filters) };
    return new Promise((resolve) => {
      pickResolve = resolve;
      openFilesModal({ picking: true });
    });
  }

  function finishPick(value) {
    const r = pickResolve;
    pickResolve = null;
    closeFilesModal();
    if (r) r(value);
  }

  /* ------------------------------------------------------ the files modal */

  let filesCache = null;

  async function openFilesModal(opts = {}) {
    const m = $('#cloudFilesModal');
    if (!m) return;
    m.classList.remove('hidden');
    m.dataset.picking = opts.picking ? '1' : '';
    await refreshFiles();
  }
  function closeFilesModal() {
    const m = $('#cloudFilesModal');
    if (m) { m.classList.add('hidden'); m.dataset.picking = ''; }
    if (pickResolve) finishPick(null);
  }

  async function refreshFiles() {
    const list = $('#cloudFilesList');
    if (!list) return;
    list.innerHTML = '<div class="muted small">Looking…</div>';
    try {
      const res = await fetch('/api/videos', { headers: authHeaders() });
      if (res.status === 401) { signedOut(); return; }
      filesCache = await res.json();
    } catch (e) {
      list.innerHTML = '<div class="muted small">Could not reach the studio machine.</div>';
      return;
    }
    renderFiles();
  }

  function renderFiles() {
    const list = $('#cloudFilesList');
    if (!list || !filesCache) return;
    const picking = $('#cloudFilesModal').dataset.picking === '1';
    const exts = picking ? pickState.exts : null;
    const fmtSize = (b) => (b > 1024 * 1024 * 1024 ? (b / 1073741824).toFixed(2) + ' GB' : Math.round(b / 1048576) + ' MB');
    const when = (t) => new Date(t).toLocaleString();
    let html = '';
    let any = false;
    for (const g of (filesCache.groups || [])) {
      const files = (g.files || []).filter((f) => !exts || exts.some((e) => f.name.toLowerCase().endsWith(e)));
      if (!files.length) continue;
      any = true;
      html += `<div class="cloud-files-group"><div class="cloud-files-head">${g.label}</div>`;
      for (const f of files) {
        html += `<button class="cloud-file" data-path="${escAttr(f.path)}">`
          + `<span class="cloud-file-name">${escHtml(f.name)}</span>`
          + `<span class="cloud-file-meta">${fmtSize(f.size)} · ${when(f.mtime)}</span>`
          + `<span class="cloud-file-go">${picking ? 'Open' : '⬇'}</span></button>`;
      }
      html += '</div>';
    }
    if (!any) {
      html = '<div class="muted small cloud-files-empty">Nothing here yet.'
        + (exts ? ' Nothing of that kind, anyway.' : '')
        + ' Send something from this device with the button above.</div>';
    }
    list.innerHTML = html;
    $$('.cloud-file', list).forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.path;
      if (picking) finishPick(pickState.multi ? [p] : p);
      else offerDownload(p);
    }));
  }

  const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const escAttr = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ----------------------------------------------------------- uploading */

  let currentUpload = null;

  /**
   * Send a file from this device, in slices, remembering where it got to.
   *
   * Not an optimisation: this is a phone on mobile data sending a recording of a
   * service. A single fetch that dies at 80% has to start again from zero, and
   * on a 4 GB file that is the difference between "editing from the car park"
   * and "give up". The server keeps the part file; `?probe=1` says how much of
   * it it already has.
   */
  async function uploadFile(file, onProgress) {
    const CHUNK = 8 * 1024 * 1024;
    const id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const q = (extra) => `/api/upload?name=${encodeURIComponent(file.name)}&id=${id}&size=${file.size}${extra || ''}`;
    let sent = 0;
    const ctl = { cancelled: false };
    currentUpload = ctl;

    // Where did we get to last time (if this is a retry of the same id)?
    try {
      const probe = await fetch(q('&probe=1'), { method: 'POST', headers: authHeaders() });
      const info = await probe.json();
      if (info && info.have) sent = Math.min(info.have, file.size);
    } catch (e) { sent = 0; }

    while (sent < file.size) {
      if (ctl.cancelled) throw new Error('Stopped.');
      const end = Math.min(sent + CHUNK, file.size);
      const slice = file.slice(sent, end);
      let res;
      try {
        res = await fetch(q('&offset=' + sent), {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, authHeaders()),
          body: slice,
        });
      } catch (e) {
        // A dropped connection is not a lost upload — wait and pick up where the
        // server says it got to.
        await new Promise((r) => setTimeout(r, 1500));
        const probe = await fetch(q('&probe=1'), { method: 'POST', headers: authHeaders() }).then((r) => r.json()).catch(() => null);
        if (probe && typeof probe.have === 'number') { sent = probe.have; continue; }
        throw new Error('The upload stopped and could not be picked up again.');
      }
      if (res.status === 401) { signedOut(); throw new Error('Signed out.'); }
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Upload failed.');
      if (out.partial) { sent = out.have; }
      else if (out.ok && out.path) { if (onProgress) onProgress(100); currentUpload = null; return out.path; }
      else sent = end;
      if (onProgress) onProgress(Math.round((sent / file.size) * 100));
    }
    currentUpload = null;
    throw new Error('The upload finished without a file coming back.');
  }

  function showUploadProgress(d) {
    const bar = $('#cloudUploadBar');
    if (!bar) return;
    if (d && d.done) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const n = bar.querySelector('.cloud-upload-name');
    if (n) n.textContent = (d && d.name) || 'Sending…';
    const p = bar.querySelector('.progress-bar');
    if (p) p.style.width = Math.max(2, Math.min(100, (d && d.percent) || 0)) + '%';
  }

  /** Pick files off this device and send them; resolves with studio paths. */
  function chooseFromDevice(multi, exts) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (multi) input.multiple = true;
      if (exts && exts.length) input.accept = exts.join(',');
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (!files.length) return resolve(null);
        const paths = [];
        for (const f of files) {
          showUploadProgress({ name: f.name, percent: 0 });
          try {
            const p = await uploadFile(f, (pc) => showUploadProgress({ name: f.name, percent: pc }));
            paths.push(p);
          } catch (e) {
            toast('⚠️ ' + (e.message || e), 'error');
          }
        }
        showUploadProgress({ done: true });
        if (!paths.length) return resolve(null);
        await refreshFiles();
        resolve(multi ? paths : paths[0]);
      }, { once: true });
      input.click();
    });
  }

  /* ----------------------------------------------------------- downloads */

  function renderDownloadCount() {
    const c = $('#cloudDlCount');
    if (!c) return;
    c.textContent = String(cloud.downloads.length);
    c.classList.toggle('hidden', !cloud.downloads.length);
  }

  function offerDownload(p) {
    if (!p) return;
    const name = String(p).split(/[\\/]/).pop();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
      // A folder — the nearest honest equivalent is the file list.
      openFilesModal();
      return;
    }
    if (!cloud.downloads.some((d) => d.path === p)) cloud.downloads.unshift({ path: p, name, at: Date.now() });
    renderDownloadCount();
    const a = document.createElement('a');
    a.href = downloadUrl(p);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function renderDownloads() {
    const list = $('#cloudDownloadsList');
    if (!list) return;
    if (!cloud.downloads.length) {
      list.innerHTML = '<div class="muted small cloud-files-empty">Nothing finished yet in this session. Exports land here.</div>';
      return;
    }
    list.innerHTML = cloud.downloads.map((d) => `<button class="cloud-file" data-path="${escAttr(d.path)}">`
      + `<span class="cloud-file-name">${escHtml(d.name)}</span>`
      + `<span class="cloud-file-meta">${new Date(d.at).toLocaleTimeString()}</span>`
      + '<span class="cloud-file-go">⬇</span></button>').join('');
    $$('.cloud-file', list).forEach((b) => b.addEventListener('click', () => offerDownload(b.dataset.path)));
  }

  /* -------------------------------------------------- a finger for a mouse */

  /*
   * The desk drags with the mouse: clips, trim handles, caption blocks, text
   * boxes, the crop frame, the playhead. A touch fires none of that, and a
   * browser only synthesises a click — never a drag.
   *
   * So: a touch that STARTS on something draggable becomes a mouse gesture, and
   * a touch anywhere else is left completely alone, because the timeline, the
   * clip list and every modal have to keep scrolling normally. That distinction
   * is the whole design — a bridge that grabs everything makes the page
   * unscrollable, which is how these usually go wrong.
   */
  const DRAG_SEL = [
    '.ve-seg', '.ve-seg-h', '.ve-audio-seg', '.ve-music-seg',
    '.ve-cap-clip', '.ve-cap-edge', '[data-cedge]', '[data-capedge]',
    '.ve-text-box', '.ve-text-resize', '.ve-text-clip', '.ve-tc-h', '[data-tedge]',
    '#veRuler', '#veCropFrame', '#veOverlayGuide', '.ve-ovg-resize', '[data-ovresize]',
  ].join(',');

  /* Things that must keep their own touch behaviour: form controls, and the
   * cut-out painter, which already listens for touch itself. */
  const NO_BRIDGE = 'input,textarea,select,button,a,[contenteditable="true"],.cut-canvas,canvas';

  /*
   * The one gesture that genuinely collides.
   *
   * On the desk, dragging across EMPTY timeline draws a new clip. On a phone,
   * dragging across the timeline has to scroll it — an hour-long service is
   * several screens wide and a timeline you cannot scroll is a timeline you
   * cannot use. Both are real; they cannot both own one finger.
   *
   * So scrolling wins by default, and drawing a clip is a LONG PRESS first —
   * the idiom every phone already uses for "I mean this one, not the page". The
   * capability is not lost and it is not hidden behind a setting: the studio's
   * own ＋ Clip button does the same job at the playhead.
   */
  const LONG_PRESS_SEL = '#veTrack, .ve-track, .ve-cap-track, .ve-text-track, .ve-audio-track, .ve-music-track';
  const LONG_PRESS_MS = 420;
  const SLOP_PX = 9;

  function installTouchBridge() {
    let dragging = false;
    let pending = null;      // a long press being waited out

    const mouse = (type, t, target) => {
      const ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: t.clientX, clientY: t.clientY,
        screenX: t.screenX, screenY: t.screenY,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
      });
      (target || document).dispatchEvent(ev);
    };

    const cancelPending = () => {
      if (!pending) return;
      clearTimeout(pending.timer);
      pending = null;
    };

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { cancelPending(); dragging = false; return; }
      const t = e.touches[0];
      const el = t.target;
      if (!el || !el.closest) return;
      if (el.closest(NO_BRIDGE)) return;

      if (el.closest(DRAG_SEL)) {
        dragging = true;
        e.preventDefault();        // no scroll, no synthetic click, no 300ms wait
        mouse('mousedown', t, el);
        return;
      }

      if (el.closest(LONG_PRESS_SEL)) {
        // Hold still and this becomes a drag; move and it stays a scroll.
        const start = { x: t.clientX, y: t.clientY, screenX: t.screenX, screenY: t.screenY };
        pending = {
          el,
          start,
          timer: setTimeout(() => {
            pending = null;
            dragging = true;
            // A short buzz is how a phone says "you are holding it now".
            try { if (navigator.vibrate) navigator.vibrate(12); } catch (er) {}
            mouse('mousedown', start, el);
          }, LONG_PRESS_MS),
        };
      }
    }, { passive: false, capture: true });

    document.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      if (pending) {
        // Moved before the hold finished: they are scrolling. Let go of it.
        if (Math.abs(t.clientX - pending.start.x) > SLOP_PX || Math.abs(t.clientY - pending.start.y) > SLOP_PX) cancelPending();
        return;
      }
      if (!dragging) return;
      e.preventDefault();
      mouse('mousemove', t, document);
    }, { passive: false, capture: true });

    const end = (e) => {
      // A tap that never became a hold is left alone: the browser turns it into
      // a click on its own, and the studio seeks there exactly as it would from
      // a mouse.
      cancelPending();
      if (!dragging) return;
      dragging = false;
      const t = (e.changedTouches && e.changedTouches[0]) || { clientX: 0, clientY: 0, screenX: 0, screenY: 0 };
      mouse('mouseup', t, document);
    };
    document.addEventListener('touchend', end, { capture: true });
    document.addEventListener('touchcancel', end, { capture: true });
  }

  /* ------------------------------------------------- dropping files on it */

  /*
   * The studio's drop handlers read `file.path`, which exists only in Electron.
   * In a browser a dropped file has bytes and no path — so the drop is caught
   * FIRST, the files are uploaded, and a drop carrying the studio-machine paths
   * is re-fired at the same element. The studio's own handler then runs exactly
   * as it does on the desktop, and nothing in it had to learn about uploads.
   */
  function installDropBridge() {
    document.addEventListener('drop', async (e) => {
      if (e.__cloud) return;                       // our own re-fired event
      const dt = e.dataTransfer;
      const files = Array.from((dt && dt.files) || []);
      if (!files.length) return;
      if (files.every((f) => f.path)) return;      // desktop-like: nothing to do
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      const paths = [];
      showUploadProgress({ name: files[0].name, percent: 0 });
      for (const f of files) {
        try { paths.push({ path: await uploadFile(f, (pc) => showUploadProgress({ name: f.name, percent: pc })), name: f.name }); }
        catch (err) { toast('⚠️ ' + (err.message || err), 'error'); }
      }
      showUploadProgress({ done: true });
      if (!paths.length) return;
      const ev = new Event('drop', { bubbles: true, cancelable: true });
      ev.__cloud = true;
      ev.dataTransfer = { files: paths, dropEffect: 'copy', types: ['Files'] };
      target.dispatchEvent(ev);
    }, true);

    // Without these the browser navigates away to the dropped file.
    for (const type of ['dragover', 'dragenter']) {
      document.addEventListener(type, (e) => { e.preventDefault(); }, false);
    }
  }

  /* --------------------------------------------------------- touch tools */

  /*
   * Undo, zoom, split, delete and play are keyboard shortcuts on the desk, and a
   * phone has no keyboard. These press the studio's OWN keys — the same handler,
   * the same undo stack — rather than reaching into its internals.
   */
  function key(k, opts = {}) {
    document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({
      key: k, bubbles: true, cancelable: true,
    }, opts)));
  }

  function installTouchBar() {
    const bar = $('#cloudTouchBar');
    if (!bar) return;
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ct]');
      if (!b) return;
      const press = (sel, k, opts) => { const el = $(sel); if (el && !el.disabled) el.click(); else key(k, opts); };
      switch (b.dataset.ct) {
        case 'undo': press('#veUndo', 'z', { ctrlKey: true }); break;
        case 'redo': press('#veRedo', 'y', { ctrlKey: true }); break;
        // Zoom is keyboard-only on the desk — there is no button to press.
        case 'zoomin': key('=', { ctrlKey: true }); break;
        case 'zoomout': key('-', { ctrlKey: true }); break;
        case 'split': press('#veSplit', 's'); break;
        case 'delete': press('#veDelClip', 'Delete'); break;
        case 'play': press('#vePlay', ' ', { code: 'Space' }); break;
        default: break;
      }
    });
    /*
     * Follow the width rather than read it once. The first read happens while
     * the studio is starting up — on a phone that is rotation, on a laptop it
     * is someone narrowing the window — and a toolbar that decided it was not
     * needed at boot would never come back.
     */
    const mq = window.matchMedia('(max-width: 900px)');
    const apply = () => bar.classList.toggle('hidden', !mq.matches);
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply);      // older WebKit
  }

  /* --------------------------------------------------------------- help */

  const HELP = `
    <p><strong>This is the Video Studio itself</strong> — the same editor as the app on the church PC,
    running in your browser. Every button here does what it does on the desktop.</p>
    <p><strong>Where the work happens.</strong> Cutting, captions, auto-reframe and exports run on the
    studio machine, not on this phone. That is why a two-hour service exports at full speed from a
    handset — and why the studio machine has to be switched on.</p>
    <p><strong>Where the files go.</strong> Exports land in the output folder on that machine.
    Tap <em>⬇ Saved</em> to pull any of them onto this device.</p>
    <p><strong>Install it.</strong> In your browser's menu choose “Add to Home Screen” and it opens
    like an app, full screen, with no address bar.</p>
    <p><strong>Dragging on a touch screen.</strong> Drag clips, trim handles, caption blocks, text boxes
    and the crop frame with one finger. Dragging <em>empty</em> timeline scrolls it; <strong>hold
    still for a moment first</strong> and the same drag draws a new clip instead — or just use
    <em>＋ Clip</em>, which adds one at the playhead. The bar along the bottom has undo, redo, zoom,
    split, delete and play.</p>
    <p class="muted small">Go Live and Presentation are not here: they drive cameras, projectors and NDI
    on the church network, which a browser somewhere else cannot reach.</p>`;

  /* ---------------------------------------------------------- wiring up */

  function wireCloudUi() {
    const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };

    on('#cloudGateForm', 'submit', (e) => {
      e.preventDefault();
      signIn($('#cloudPass').value.trim().toLowerCase().replace(/\s+/g, '-'), $('#cloudRemember').checked);
    });
    on('#cloudFiles', 'click', () => openFilesModal());
    on('#cloudFilesClose', 'click', closeFilesModal);
    on('#cloudFilesRefresh', 'click', refreshFiles);
    on('#cloudUpload', 'click', async () => {
      const picking = $('#cloudFilesModal').dataset.picking === '1';
      const chosen = await chooseFromDevice(picking ? pickState.multi : true, picking ? pickState.exts : null);
      if (picking && chosen) finishPick(chosen);
    });
    on('#cloudUploadCancel', 'click', () => { if (currentUpload) currentUpload.cancelled = true; });
    on('#cloudDownloads', 'click', () => { renderDownloads(); $('#cloudDownloadsModal').classList.remove('hidden'); });
    on('#cloudDownloadsClose', 'click', () => $('#cloudDownloadsModal').classList.add('hidden'));
    on('#cloudHelp', 'click', () => {
      $('#cloudHelpBody').innerHTML = HELP;
      $('#cloudHelpModal').classList.remove('hidden');
    });
    on('#cloudHelpClose', 'click', () => $('#cloudHelpModal').classList.add('hidden'));

    // The studio's own "open the output folder" button, which the cloud page
    // keeps because the export path ends there.
    on('#openOutput', 'click', () => openFilesModal());

    /*
     * Two buttons on the desk exist to GET you here. They stay on the desktop:
     * from inside the cloud studio, "open the cloud studio" is a button that can
     * only disappoint, and both of them jump to a Settings view this page does
     * not carry.
     */
    for (const id of ['#vePhone', '#veCloud']) {
      const b = $(id);
      if (b) b.classList.add('hidden');
    }

    window.addEventListener('online', () => setLink(true));
    window.addEventListener('offline', () => setLink(false));
  }

  /* ------------------------------------------------------------- startup */

  async function startStudio() {
    if (cloud.started) return;
    cloud.started = true;

    connectEvents();

    let presets = {};
    try { presets = await window.api.video.presets(); } catch (e) { presets = {}; }

    if (window.VideoEditor) {
      window.VideoEditor.init({}, presets || {});
      window.VideoEditor.onShow();
    }

    // The desk measures itself off the window; a phone rotating is a resize the
    // studio would otherwise never hear about.
    let fitTimer = null;
    const refit = () => {
      clearTimeout(fitTimer);
      fitTimer = setTimeout(() => { try { window.VideoEditor.fit(); } catch (e) {} }, 120);
    };
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);

    installTouchBar();

    try {
      const hello = await fetch('/api/hello', { headers: authHeaders() }).then((r) => r.json());
      cloud.hello = hello;
      const where = $('#cloudWhere');
      if (where) where.textContent = hello.standalone ? 'on the server' : 'on the studio PC';
    } catch (e) { /* the studio still works; the label is decoration */ }
  }

  /* The version this page was built from, off this script's own URL — the page
   * may not run inline script, so there is nowhere else to be told it. */
  const myVersion = (() => {
    try { return new URL(document.currentScript.src, location.href).searchParams.get('v') || ''; }
    catch (e) { return ''; }
  })();

  window.__cloudStart = async function (version) {
    cloud.version = version || '';
    wireCloudUi();
    installTouchBridge();
    installDropBridge();

    // A service worker makes it installable and makes the shell open instantly.
    // It never caches media or API calls — see sw.js.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js?v=' + encodeURIComponent(version || '')).catch(() => {});
    }

    let hello = null;
    try { hello = await fetch('/api/hello', { headers: authHeaders() }).then((r) => r.json()); }
    catch (e) { hello = null; }

    if (hello && hello.signedIn) {
      $('#cloudGate').classList.add('gone');
      await startStudio();
    } else {
      if (!hello) {
        const msg = $('#cloudGateMsg');
        if (msg) { msg.textContent = 'Cannot reach the studio machine. Is it switched on?'; msg.className = 'cloud-gate-msg bad'; }
      }
      const pass = $('#cloudPass');
      // Only invite the keyboard on a real keyboard's device — a phone popping
      // one up over the sign-in card on arrival is nobody's idea of welcoming.
      if (pass && !window.matchMedia('(max-width: 900px)').matches) pass.focus();
    }
  };

  /* DOMContentLoaded, not load: it fires once every script in the page has run
   * (so window.VideoEditor exists) but before the first video byte is fetched. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => window.__cloudStart(myVersion), { once: true });
  } else {
    window.__cloudStart(myVersion);
  }
})();
