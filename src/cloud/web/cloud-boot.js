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

// The overlay's pending hide. Top level, NOT inside the closure below: tasks.js
// schedules it (`_hideTimer = setTimeout(hideOverlay, 250)`) when a job ends, as
// it does against renderer.js's top-level `let` on the desktop. Scripts share the
// page's top-level scope, but not a closure's — declared inside, the assignment
// threw "_hideTimer is not defined" at the end of every successful job.
let _hideTimer = null;

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
    jobListeners: [],   // views that show the background jobs (the home screen)
    fileListeners: [],  // views that list files (the home screen's exports)
    eventListeners: {}, // server events other views want (the scheduler)
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
  /*
   * ►► A CALL SURVIVES THE PHONE LOCKING. ◄◄
   *
   * Each call carries a name (`X-MW-Call`) and the studio keeps its answer, so
   * a long one — an export above all — no longer depends on one request staying
   * open for twenty minutes. The studio answers "still working" (202) after a
   * while and this page keeps asking; if the connection drops (screen locked,
   * app in the background, signal gone) it waits and asks again, and the answer
   * is still there. See "calls that outlive a request" in cloud-api.js.
   */
  const newCallId = () => {
    const b = new Uint8Array(12);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach((_, i) => { b[i] = Math.random() * 256; });
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  };
  const pause = (ms) => new Promise((resolve) => {
    // coming back to the app is the moment to try, not the end of a back-off
    const back = () => { if (document.visibilityState === 'visible') done(); };
    const done = () => { clearTimeout(t); document.removeEventListener('visibilitychange', back); window.removeEventListener('online', done); resolve(); };
    const t = setTimeout(done, ms);
    document.addEventListener('visibilitychange', back);
    window.addEventListener('online', done);
  });
  // How long a call may go unanswered by an UNREACHABLE studio before giving up.
  const GIVE_UP_MS = 6 * 3600 * 1000;

  const answerOf = async (res, channel) => {
    const ct = res.headers.get('content-type') || '';
    const env = ct.indexOf('x-mw-rpc') >= 0 ? unpack(await res.arrayBuffer()) : await res.json();
    if (env && env.ok) return env.data;
    const err = new Error((env && env.error) || ('Unknown error in ' + channel));
    if (env && env.cancelled) err.cancelled = true;
    throw err;
  };

  /*
   * ►► RECORD MODE: A SHORT BECOMES A RECIPE FOR THE SERVER. ◄◄
   * While a batch export is being handed to the server (window.__mwBatch, used
   * by the studio's Export all), the steps that are server work are not sent
   * one by one and waited on: they are written down, and each answers at once
   * with a stand-in for the file it will make ("@@step-N@@.mp4"), so the studio
   * carries on to the next step exactly as it always does. Everything that
   * needs THIS device — following the speaker, drawing the captions and the
   * text — really runs. The finished list goes to the server (batch.js), which
   * runs it on its own: the phone can be closed. A step that would need to look
   * at a file that does not exist yet throws, and that short is exported the
   * ordinary way instead.
   */
  const REC_STEPS = new Set([
    'sermon:exportShort', 'sermon:exportReframed', 'sermon:exportFramed',
    'captions:burnTrack', 'captions:burn', 'overlays:burnImages', 'overlays:burn',
    'video:overlayComposite', 'video:mixSounds', 'video:mixMusic', 'video:appendClips', 'video:attachThumb',
  ]);
  const IS_STANDIN = /^@@step-\d+@@(\.[a-z0-9]+)?$/i;
  const rec = { on: false, steps: null };
  const hasStandIn = (v, d = 0) => {
    if (d > 8 || v == null) return false;
    if (typeof v === 'string') return IS_STANDIN.test(v);
    if (Array.isArray(v)) return v.some((x) => hasStandIn(x, d + 1));
    if (typeof v === 'object' && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer)) return Object.keys(v).some((k) => hasStandIn(v[k], d + 1));
    return false;
  };
  function recordCall(channel, args) {
    // the size of a short that is not made yet is known from its shape and quality
    if (channel === 'video:info' && rec.expect && args && typeof args.input === 'string' && IS_STANDIN.test(args.input)) {
      return Object.assign({}, rec.expect);
    }
    if (!REC_STEPS.has(channel)) {
      if (hasStandIn(args)) {
        const err = new Error('This step needs a file the server has not made yet.');
        err.recordUnsupported = true;
        throw err;
      }
      return undefined;
    }
    const n = rec.steps.length;
    rec.steps.push({ channel, args: args || {} });
    if (channel === 'video:attachThumb') return {};
    return `@@step-${n}@@.mp4`;
  }
  window.__mwBatch = {
    supported: () => true,
    isStandIn: (p) => typeof p === 'string' && IS_STANDIN.test(p),
    begin(expect) { rec.on = true; rec.steps = []; rec.expect = expect || null; },
    end() { const st = rec.steps || []; rec.on = false; rec.steps = null; rec.expect = null; return st; },
    recording: () => rec.on,
    open: (label, total) => call('batch:open', { label, total }),
    add: (id, label, steps) => call('batch:add', { id, label, steps }),
    seal: (id) => call('batch:seal', { id }),
    list: () => call('batch:list', {}),
    cancel: (id) => call('batch:cancel', { id }),
  };

  /*
   * A batch running on the server, shown where every export is shown (the pill
   * at the top, Running now) — on this phone, on another, or after the app was
   * closed and opened again. Its progress arrives as 'batch:progress' events;
   * Stop stops it on the server.
   */
  const serverTasks = new Map(); // batchId -> taskId
  function showServerBatch(b) {
    if (!b || !b.id || !window.__newTask) return;
    let tid = serverTasks.get(b.id);
    if (!tid) {
      if (b.state !== 'running') return;
      tid = window.__newTask(b.label || 'Exporting on the server', { background: true });
      serverTasks.set(b.id, tid);
    }
    const left = b.total - b.done - b.failed;
    if (window.__setTaskBatch) window.__setTaskBatch(tid, Math.min(b.total, b.done + b.failed + 1), b.total);
    for (const it of b.items || []) if (it.state === 'done' && it.output && window.__taskAddFile) window.__taskAddFile(tid, it.output);
    if (b.state === 'running') {
      const cur = b.current;
      const step = cur ? `On the server · ${cur.label}` : (b.received < b.total ? `Preparing on your phone… ${b.received} of ${b.total} sent` : 'Queued on the server');
      if (window.__taskSay) window.__taskSay(tid, step + (b.sealed ? ' — you can close the app' : ''));
      // the chip's number is THIS short's, as for every export; "1 of 20" beside it is the batch
      if (window.__taskProgress) window.__taskProgress(tid, cur ? cur.pct : 0);
      return;
    }
    serverTasks.delete(b.id);
    const note = b.state === 'cancelled' ? 'Stopped.'
      : `✅ ${b.done} short${b.done === 1 ? '' : 's'} exported on the server${b.failed ? ` · ${b.failed} could not be made` : ''}.`;
    if (window.__endTask) window.__endTask(tid, { ok: b.state !== 'cancelled' && b.done > 0, state: b.state === 'cancelled' ? 'stopped' : (b.done ? 'done' : 'fail'), note });
    if (b.state === 'done') {
      island({ kind: b.failed ? 'warn' : 'good', title: `${b.done} short${b.done === 1 ? '' : 's'} ready`, text: b.failed ? `${b.failed} could not be made — tap Running now for why.` : 'They are in Files.' });
      if (typeof refreshFiles === 'function') { try { refreshFiles(); } catch (e) {} }
    }
    void left;
  }
  cloud.serverTasks = serverTasks;
  cloud.showServerBatch = showServerBatch;

  async function call(channel, args) {
    if (rec.on) {
      const r = recordCall(channel, args);
      if (r !== undefined) return r;
    }
    const packed = pack({ channel, args: args || {} });
    const id = newCallId();
    const post = () => fetch('/api/rpc', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': packed.type, 'X-MW-Call': id }, authHeaders()),
      body: packed.body,
    });
    const ask = () => fetch('/api/rpc/wait?call=' + id, { headers: authHeaders(), cache: 'no-store' });
    let sent = false;   // the studio is known to have this call
    let unsure = false; // the POST may or may not have arrived
    let lostAt = 0;
    let delay = 1000;
    for (;;) {
      let res = null;
      try { res = await (sent || unsure ? ask() : post()); } catch (e) { res = null; }
      const ct = res ? (res.headers.get('content-type') || '') : '';
      // anything but our own answer is the HOST (a 502 page while it restarts)
      const ours = !!res && (ct.indexOf('x-mw-rpc') >= 0 || ct.indexOf('json') >= 0);
      if (ours) {
        setLink(true);
        lostAt = 0;
        if (res.status === 401) { signedOut(); throw new Error('Signed out.'); }
        if (res.status === 200) return answerOf(res, channel);
        if (res.status === 202) { sent = true; unsure = false; delay = 1000; continue; }
        if (res.status === 404 && unsure && !sent) { unsure = false; continue; } // never arrived: send it
        if (res.status === 404 && sent) {
          throw new Error('The studio server restarted while doing this, so it was lost — most often because it ran out of '
            + 'memory on a long video. Please try again; if it keeps happening, give the server more memory.');
        }
        let env = null;
        try { env = await res.json(); } catch (e) { env = null; }
        throw new Error((env && env.error) || ('The studio refused this (HTTP ' + res.status + ').'));
      }
      /*
       * No answer at all, or the host's error page. The work may well still be
       * running on the studio, so wait and ask again rather than calling it a
       * failure — the call is named, so asking cannot start it twice.
       */
      setLink(false);
      if (!sent) unsure = true;
      if (!lostAt) lostAt = Date.now();
      if (Date.now() - lostAt > GIVE_UP_MS) {
        const err = new Error('Lost the connection to the studio. The job may still be running there — it will reappear when you are back.');
        err.offline = true;
        throw err;
      }
      await pause(delay);
      delay = Math.min(10000, delay * 2);
    }
  }

  /* ------------------------------------------------------- files as URLs */

  /** A path on the studio machine, as something this browser can load. */
  window.MW_FILE_URL = (p) => '/api/media?p=' + encodeURIComponent(p) + (token ? '&k=' + encodeURIComponent(token) : '');
  const downloadUrl = (p) => '/api/file?p=' + encodeURIComponent(p) + '&dl=1' + (token ? '&k=' + encodeURIComponent(token) : '');

  /* MediaPipe loads its own runtime by appending names to this base, so it has
   * to be a plain path with no query on it. Served unauthenticated for exactly
   * that reason — see the note in cloud-api.js. */
  window.MW_AI_BASE = '/ai/';

  /*
   * The frames auto-reframe looks at come back from the studio as paths with a
   * `file://` URL beside them — right for the desktop window, and a picture
   * this browser is not allowed to open (it means THIS device's disk). Every
   * frame failed to load, the tracker saw nobody, and every "face-tracked"
   * short quietly came out as a centre crop. So they are served back over the
   * media route like everything else.
   */
  const servedFrames = (res) => {
    if (!res || !Array.isArray(res.frames)) return res;
    res.frames = res.frames.map((f) => Object.assign({}, f, {
      url: f.path ? window.MW_FILE_URL(f.path) : f.url,
      pairUrl: f.pairPath ? window.MW_FILE_URL(f.pairPath) : f.pairUrl,
    }));
    return res;
  };

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
      // ✂️ Remove pauses heard by the cloud (the server allowed it; the page never asked)
      speechPauses: (a) => call('video:speechPauses', a),
      trim: (a) => call('video:trim', a),
      export: (a) => call('video:export', a),
      extractAudio: (a) => call('video:extractAudio', a),
      setExportPrefs: (a) => call('video:setExportPrefs', a),
      mixSounds: (a) => call('video:mixSounds', a),
      getExportPrefs: () => call('video:getExportPrefs'),
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
      extractFrames: (a) => call('video:extractFrames', a).then(servedFrames),
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
    montage: {
      status: () => call('montage:status'),
      create: (a) => call('montage:create', a),
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
      extractFrames: (a) => call('video:extractFrames', a).then(servedFrames),
      attachThumb: (a) => call('video:attachThumb', a),
      rmdir: (dir) => call('fs:rmdir', { dir }),
    },
    captions: {
      available: () => call('captions:available'),
      engineInfo: () => call('captions:engineInfo'),
      // ✨ AI check, and whether the cloud is the one listening. Both were allowed
      // on the server and missing here, so the phone said "The AI proof-reader is
      // not available in this build" and labelled Groq's captions as heard on the PC.
      grammar: (a) => call('captions:grammar', a),
      cloud: () => call('captions:cloud'),
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
    audio: {
      sfxList: () => call('audio:sfxList'),
      sfx: (kind) => call('audio:sfx', { kind }),
      // the recording's bytes travel as binary (pack), not as text
      saveRecording: (a) => call('audio:saveRecording', a),
    },
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
    // The Social Scheduler (cloud-social.js): the same names as the desk's
    // preload, plus the phone's own account calls — keys go in, never out.
    scheduler: {
      list: () => call('scheduler:list'),
      add: (post) => call('scheduler:add', { post }),
      update: (id, patch) => call('scheduler:update', { id, patch }),
      remove: (id) => call('scheduler:remove', { id }),
      publishAuto: (id) => call('scheduler:publishAuto', { id }),
      retry: (id) => call('scheduler:retry', { id }),
      plans: () => call('scheduler:plans'),
    },
    social: {
      suggestCopy: (a) => call('social:suggestCopy', a),
      accounts: () => call('social:accounts'),
      setKeys: (keys) => call('social:setKeys', keys),
      linkStart: (platform) => call('social:linkStart', { platform }),
      linkClaim: (platform) => call('social:linkClaim', { platform }),
      unlink: (id) => call('social:unlink', { id }),
      check: (id) => call('social:check', { id }),
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
  /*
   * THE MESSAGE PILL. One look on the phone and the desk: frosted glass, a small
   * status mark in the kind's colour (done / problem / note), and the words —
   * without the decorative emoji the studio's messages open with, which read as
   * clutter beside a proper icon. Symbols that MEAN something in a sentence
   * (▶ ◆ ✓ ✕ arrows) are kept. It slides in, and fades out rather than blinking.
   */
  const TOAST_ICONS = {
    good: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6.5"/><path d="M12 17.2v.1"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 7v6.5"/><path d="M12 17.2v.1"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 11v6"/><path d="M12 7.2v.1"/></svg>',
  };
  const toastText = (msg) => String(msg == null ? '' : msg)
    .replace(/(?![▶⏸◆◇✓✕↔↕→←↑↓★])[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}][\u{FE0F}\u{20E3}\u{200D}\p{Extended_Pictographic}]*/gu, '')
    .replace(/️/g, '')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s{2,}/g, ' ')
    .trim();
  /** Split a studio message into a bold headline and a softer line under it. */
  function toastParts(msg, kind) {
    // a message that opens with a warning sign is a warning, whatever kind it was sent as
    const warn = !kind && /^\s*(?:⚠|🚫|⛔)/u.test(String(msg || ''));
    const k = kind === 'good' || kind === 'error' ? kind : (warn ? 'warn' : 'info');
    const text = toastText(msg) || String(msg || '');
    // "Headline — the detail" (or "Headline. The detail.") reads as a bold
    // title over a softer line; anything else is a single line.
    let title = text, sub = '';
    // a long message with no short headline still leads with its first sentence
    const cut = text.match(/^(.{4,52}?)(?:\s+—\s+|\.\s+)(.+)$/) || (text.length > 64 && text.match(/^(.{4,110}?)(?:\.\s+|\s+—\s+)(.+)$/));
    if (cut) { title = cut[1].replace(/[.:]$/, ''); sub = cut[2].charAt(0).toUpperCase() + cut[2].slice(1); }
    else title = title.replace(/\.$/, '');   // a one-line note reads cleaner without its full stop
    return { k, text, title, sub };
  }
  function toast(msg, kind = '', ms) {
    const { k, text, title, sub } = toastParts(msg, kind);
    island({ title, sub, kind: k, ms: ms || Math.min(7000, Math.max(3200, 1600 + text.length * 38)) });
  }
  window.__toast = toast;

  /*
   * THE ISLAND. Every message in the Cloud Studio comes out of one black capsule
   * at the top of the screen, the way an iPhone shows a timer or a call: it
   * drops in from under the top bar, springs to the size of what it has to say,
   * and folds itself away. A message that arrives while another is showing does
   * not stack a second box on the first — the capsule MORPHS to the new words.
   *
   * It can carry one button ("Refresh", "View"), the whole capsule can be
   * tapped, and a flick upwards sends it away early. A finger anywhere else goes
   * straight through: it never sits over a clip's trim handle the way a box
   * along the bottom did.
   */
  let islandEl = null, islandCur = null, islandTimer = null;
  function islandMount() {
    if (islandEl) return islandEl;
    islandEl = document.createElement('div');
    islandEl.id = 'cloudIsland';
    islandEl.className = 'cloud-island';
    islandEl.setAttribute('role', 'status');
    islandEl.setAttribute('aria-live', 'polite');
    islandEl.innerHTML = '<div class="ci-body"></div>';
    document.body.appendChild(islandEl);
    islandEl.addEventListener('click', (e) => {
      const m = islandCur;
      if (!m) return;
      const act = e.target.closest('[data-ci-act]');
      const fn = act ? (m.action && m.action.onClick) : m.onTap;
      if (!fn && !act) { islandHide(); return; }
      islandHide();
      if (fn) { try { fn(); } catch (er) {} }
    });
    // flick it up to dismiss it early
    let y0 = null;
    islandEl.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    islandEl.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      if (dy < -14) { y0 = null; islandHide(); }
    }, { passive: true });
    islandEl.addEventListener('touchend', () => { y0 = null; });
    return islandEl;
  }
  function islandHtml(m) {
    const ic = TOAST_ICONS[m.kind] || TOAST_ICONS.info;
    return `<span class="ci-ic ci-${m.kind}">${m.spin ? '<i class="ci-spin"></i>' : ic}</span>`
      + `<span class="ci-tx"><b class="ci-title">${escHtml(m.title)}</b>${m.sub ? `<span class="ci-sub">${escHtml(m.sub)}</span>` : ''}</span>`
      + (m.action ? `<button type="button" class="ci-act" data-ci-act>${escHtml(m.action.label)}</button>` : '')
      + (m.onTap && !m.action ? '<span class="ci-chev" aria-hidden="true"></span>' : '');
  }
  /**
   * Show a message in the island.
   *   { title, sub?, kind: good|error|warn|info, ms?, sticky?, action?: {label, onClick}, onTap?, id? }
   * A sticky message stays until it is tapped, replaced, or hidden by its id.
   */
  function island(m) {
    if (!m || !m.title) return;
    const el = islandMount();
    const body = el.querySelector('.ci-body');
    const msg = Object.assign({ kind: 'info' }, m);
    const html = islandHtml(msg);
    // Measure the new words at their own size, so the capsule can spring to it.
    // Off to one side, not inside the capsule: on its way in the capsule is
    // scaled down, and a measure taken in there came out a fifth too narrow —
    // "TikTok connect", with the View button cut off.
    const probe = document.createElement('div');
    probe.className = 'ci-body ci-probe';
    probe.innerHTML = html;
    document.body.appendChild(probe);
    const box = probe.getBoundingClientRect();
    const w = Math.ceil(box.width) + 1;
    const h = Math.ceil(box.height);
    probe.remove();
    const showing = el.classList.contains('on');
    clearTimeout(islandTimer);
    clearTimeout(island._swap);
    islandCur = msg;
    el.className = 'cloud-island ci-k-' + msg.kind + (msg.action || msg.onTap ? ' ci-tappable' : '');
    el.setAttribute('role', msg.kind === 'error' ? 'alert' : 'status');
    if (!showing) {
      // start as a small pill tucked under the top bar
      el.style.width = '120px'; el.style.height = '36px';
      body.innerHTML = html;
      body.classList.add('swap');
      void el.offsetWidth;
      el.classList.add('on');
      body.classList.remove('swap');
    } else {
      el.classList.add('on');
      body.classList.add('swap');
      island._swap = setTimeout(() => { body.innerHTML = html; body.classList.remove('swap'); }, 110);
    }
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    if (!msg.sticky) islandTimer = setTimeout(islandHide, msg.ms || 4200);
  }
  function islandHide(id) {
    if (!islandEl) return;
    if (id && (!islandCur || islandCur.id !== id)) return;
    clearTimeout(islandTimer);
    islandCur = null;
    islandEl.classList.remove('on');
  }
  window.__island = island;
  window.__islandHide = islandHide;

  let _jobCounter = 0;
  const newJobId = () => 'job_' + (++_jobCounter) + '_' + Date.now();

  function showOverlay(msg) {
    clearTimeout(_hideTimer); _hideTimer = null;
    const m = $('#overlayMsg'); if (m) m.textContent = msg || 'Working…';
    const b = $('#progressBar'); if (b) b.style.width = '0%';
    const n = $('#overlayPct'); if (n) n.textContent = '0%';
    const o = $('#overlay'); if (o) o.classList.remove('hidden');
  }
  /*
   * The bar AND the number under it. This moved only the bar, so on a phone
   * the overlay read "0%" from the first short to the last while the work went
   * on underneath it (renderer.js, which the desk uses, sets both).
   */
  function setProgress(p) {
    const pct = Math.max(0, Math.min(100, Math.round(p) || 0));
    const b = $('#progressBar'); if (b) b.style.width = Math.max(2, pct) + '%';
    const n = $('#overlayPct'); if (n) n.textContent = pct + '%';
  }
  function hideOverlay() {
    clearTimeout(_hideTimer); _hideTimer = null;
    const o = $('#overlay'); if (o) o.classList.add('hidden');
    setJobBatch(null);
    showCancel(null);
    const bg = $('#overlayBackground');
    if (bg) { bg.classList.add('hidden'); bg.onclick = null; }
  }
  function setJobBatch(i, n) {
    const el = $('#overlayBatch');
    if (!el) return;
    if (!i || !n) { el.classList.add('hidden'); el.textContent = ''; }
    else { el.classList.remove('hidden'); el.textContent = `Short ${i} of ${n}`; }
  }

  let _cancelJobId = null;
  const _cancelledJobs = new Set();
  window.__cancelledJobs = _cancelledJobs;   // tasks.js stops background jobs through this
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
   * …and a press of it has to reach cancelCurrentJob. On the desk renderer.js
   * wires that click; the cloud page does not load renderer.js, and the copy
   * of these functions above came without the wiring, so on a phone ✕ Cancel
   * lit up, said nothing and stopped nothing — twenty shorts of captioning had
   * to be sat through. One listener on the document, so it holds whatever
   * redraws the overlay.
   */
  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('#overlayCancel') : null;
    if (b && !b.disabled) cancelCurrentJob();
  });

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
    for (const name of Object.keys(cloud.eventListeners)) attachEvent(es, name);
  }
  function attachEvent(es, name) {
    es.addEventListener(name, (e) => {
      let d = {};
      try { d = JSON.parse(e.data); } catch (er) { return; }
      for (const fn of cloud.eventListeners[name] || []) { try { fn(d); } catch (er) {} }
    });
  }
  /** Hear a server event by name — the connection may be remade, the listener stays. */
  cloud.onEvent = (name, fn) => {
    const fresh = !cloud.eventListeners[name];
    (cloud.eventListeners[name] = cloud.eventListeners[name] || []).push(fn);
    if (fresh && cloud.events) attachEvent(cloud.events, name);
  };

  /* -------------------------------------------------------------- signing in */

  /*
   * SIGNING IN TO YOUR OWN SPACE. A name and a password (cloud-api.js,
   * "accounts"); "New here" makes a space, which needs the church's access code
   * as well. The very first space on a studio is the owner's and keeps what was
   * already there. `gateMode` is which of the two the card is showing.
   */
  let gateMode = 'signin';
  const NAME_KEY = 'mw.cloud.name';
  function setGateMode(mode, firstEver) {
    gateMode = mode === 'create' ? 'create' : 'signin';
    const form = $('#cloudGateForm'); if (!form) return;
    form.classList.toggle('mode-create', gateMode === 'create');
    $$('#cloudGateTabs .cg-tab').forEach((t) => t.classList.toggle('on', t.dataset.gmode === gateMode));
    const tabs = $('#cloudGateTabs'); if (tabs) tabs.classList.toggle('hidden', !!firstEver);
    const note = $('#cloudGateNote');
    if (note) {
      note.textContent = firstEver
        ? 'You are the first here. Make your space: it is the owner’s, and keeps everything already on the studio.'
        : gateMode === 'create' ? 'Your own space: your videos, exports, captions and posts, and nobody else’s.' : '';
      note.classList.toggle('hidden', !note.textContent);
    }
    const pw = $('#cloudPw'); if (pw) pw.setAttribute('autocomplete', gateMode === 'create' ? 'new-password' : 'current-password');
    const go = $('#cloudGateGo'); if (go) go.textContent = gateMode === 'create' ? 'Create my space' : 'Sign in';
    const msg = $('#cloudGateMsg'); if (msg) { msg.textContent = ''; msg.className = 'cloud-gate-msg'; }
  }

  function signedOut(why) {
    token = '';
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    const gate = $('#cloudGate');
    if (gate) gate.classList.remove('gone');
    setGateMode('signin', cloud.hello && cloud.hello.accounts === 0);
    const msg = $('#cloudGateMsg');
    if (msg) { msg.textContent = why || 'Signed out. Sign in to your space again.'; msg.className = 'cloud-gate-msg'; }
  }

  async function signIn(remember) {
    const msg = $('#cloudGateMsg');
    const btn = $('#cloudGateGo');
    const label = btn ? btn.textContent : '';
    const name = ($('#cloudName') || {}).value || '';
    const password = ($('#cloudPw') || {}).value || '';
    const code = String(($('#cloudPass') || {}).value || '').trim().toLowerCase().replace(/\s+/g, '-');
    if (btn) { btn.disabled = true; btn.textContent = gateMode === 'create' ? 'Making your space…' : 'Opening…'; }
    if (msg) { msg.textContent = ''; msg.className = 'cloud-gate-msg'; }
    try {
      const body = gateMode === 'create'
        ? { create: true, name, password, code, remember: !!remember }
        : { name, password, remember: !!remember };
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok || !out.token) throw new Error(out.error || 'That did not work — check your name and password.');
      token = out.token;
      try { localStorage.setItem(TOKEN_KEY, token); localStorage.setItem(NAME_KEY, name.trim()); } catch (e) {}
      cloud.me = out.me || null;
      if (cloud.hello) { cloud.hello.me = cloud.me; cloud.hello.accounts = Math.max(1, cloud.hello.accounts || 0); }
      $('#cloudGate').classList.add('gone');
      await startStudio();
    } catch (e) {
      if (msg) { msg.textContent = e.message || String(e); msg.className = 'cloud-gate-msg bad'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label || 'Sign in'; }
    }
  }

  /* ------------------------------------------------------------ your space */

  /*
   * The person menu: who is signed in, a new password, signing out — and for
   * the owner, the people with spaces here (a new password for someone who
   * forgot theirs; removing a space when someone leaves).
   */
  async function api(pathname, body) {
    const res = await fetch(pathname, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
      body: body ? JSON.stringify(body) : undefined,
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'That did not work.');
    return out;
  }
  async function openProfile() {
    let info = null;
    try { info = await api('/api/me'); } catch (e) { info = { me: cloud.me }; }
    const me = info.me || cloud.me;
    const panel = openPanel({ id: 'cloudProfile', title: 'Your space', cls: 'cp-profile' });
    const paint = () => {
      const people = (info.people || []).filter((u) => !me || u.uid !== me.uid);
      panel.body.innerHTML = `<div class="pf-me"><span class="pf-ava">${escHtml(((me && me.name) || '?').charAt(0).toUpperCase())}</span>`
        + `<span class="pf-tx"><b>${escHtml((me && me.name) || 'This studio')}</b><small>${me ? (me.owner ? 'Owner · your space keeps the studio’s own files' : 'Your own space — only you see your work') : 'Signed in with the access code'}</small></span></div>`
        + (me ? `<div class="pf-sec"><b>Change your password</b>`
          + '<input type="password" class="pf-in" id="pfCur" placeholder="current password" autocomplete="current-password" />'
          + '<input type="password" class="pf-in" id="pfNew" placeholder="new password (6+ characters)" autocomplete="new-password" />'
          + '<button type="button" class="pf-btn" data-pf="pass">Save new password</button></div>' : '')
        + (me && me.owner ? `<div class="pf-sec"><b>People with a space here</b>${people.length ? '' : '<small class="pf-empty">Nobody else yet. Share the studio’s address and access code, and they tap “New here”.</small>'}`
          + people.map((u) => `<div class="pf-person" data-uid="${escAttr(u.uid)}"><span class="pf-ava sm">${escHtml(u.name.charAt(0).toUpperCase())}</span>`
            + `<span class="pf-pname">${escHtml(u.name)}</span>`
            + '<button type="button" class="pf-mini" data-pf="reset">New password</button>'
            + '<button type="button" class="pf-mini danger" data-pf="remove">Remove</button></div>').join('') + '</div>' : '')
        + `<button type="button" class="pf-out" data-pf="out">${mi('x')}Sign out</button>`;
    };
    paint();
    panel.body.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-pf]'); if (!b) return;
      const act = b.dataset.pf;
      const row = b.closest('.pf-person'); const uid = row && row.dataset.uid;
      const who = uid && (info.people || []).find((u) => u.uid === uid);
      try {
        if (act === 'out') {
          try { await api('/api/logout', {}); } catch (er) {}
          closePanel(panel, true);
          signedOut('Signed out. Sign in to your space again.');
          setTimeout(() => location.reload(), 300);
          return;
        }
        if (act === 'pass') {
          await api('/api/me/password', { current: $('#pfCur').value, password: $('#pfNew').value });
          island({ kind: 'good', title: 'Password changed' });
          paint();
          return;
        }
        if (act === 'reset' && who) {
          if (!window.confirm(`Give ${who.name} a new password? Their old one stops working.`)) return;
          const r = await api('/api/people/reset', { uid });
          island({ kind: 'good', title: `New password for ${who.name}: ${r.password}`, sub: 'Tell them — they can change it in Your space after signing in.', sticky: true });
          return;
        }
        if (act === 'remove' && who) {
          if (!window.confirm(`Remove ${who.name}’s space? Their uploads, exports, sessions and posts are deleted for good.`)) return;
          await api('/api/people/remove', { uid });
          info.people = (info.people || []).filter((u) => u.uid !== uid);
          island({ kind: 'good', title: `${who.name}’s space was removed` });
          paint();
        }
      } catch (er) { island({ kind: 'error', title: er.message || String(er) }); }
    });
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

  /*
   * YOUR FILES. What is on the studio machine — finished exports, what was sent
   * from a phone, the Videos folder — each with a picture, its size, when it was
   * made, and what can be done with it: open it (when the studio asked for a
   * file), save it to this phone, or delete it.
   *
   * Deleting is for what a phone could have put there: exports and uploads. The
   * server refuses anything else, and anything a planned post still needs (see
   * deleteFiles in cloud-api.js); the video open in the studio is kept here,
   * before it is ever asked. One file is the bin on its row and a second tap to
   * be sure; many is Select, tick them, Delete.
   */
  let filesCache = null;
  const filesUi = { selecting: false, chosen: new Set(), sure: false };

  async function openFilesModal(opts = {}) {
    const m = $('#cloudFilesModal');
    if (!m) return;
    m.classList.remove('hidden');
    m.dataset.picking = opts.picking ? '1' : '';
    const up = $('#cloudUpload span');
    if (up) up.textContent = window.matchMedia('(max-width: 900px)').matches ? 'Send a video from this phone' : 'Send a video from this computer';
    setSelecting(false);
    await refreshFiles();
  }
  function closeFilesModal() {
    const m = $('#cloudFilesModal');
    if (m) { m.classList.add('hidden'); m.dataset.picking = ''; }
    setSelecting(false);
    if (pickResolve) finishPick(null);
  }

  async function refreshFiles(quiet) {
    const list = $('#cloudFilesList');
    if (!list) return;
    if (quiet !== true || !filesCache) list.innerHTML = '<div class="cf-loading"><i class="cf-spin"></i>Looking…</div>';
    try {
      const res = await fetch('/api/videos', { headers: authHeaders() });
      if (res.status === 401) { signedOut(); return; }
      filesCache = await res.json();
    } catch (e) {
      list.innerHTML = '<div class="cloud-files-empty"><b>Could not reach the studio machine</b><p>Check the connection and tap Refresh.</p></div>';
      return;
    }
    renderFiles();
  }

  const fmtSize = (b) => {
    b = Number(b) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(b >= 10737418240 ? 0 : 1) + ' GB';
    if (b >= 1048576) return Math.round(b / 1048576) + ' MB';
    return Math.max(1, Math.round(b / 1024)) + ' KB';
  };
  /** "Today 6:35 PM", "Yesterday 2:44 PM", "Thu 4:10 PM", "2 Oct". */
  function niceWhen(t) {
    const d = new Date(t), now = new Date();
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const ago = Math.round((day(now) - day(d)) / 86400000);
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (ago === 0) return 'Today ' + time;
    if (ago === 1) return 'Yesterday ' + time;
    if (ago > 1 && ago < 7) return d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  const isPicking = () => { const m = $('#cloudFilesModal'); return !!(m && m.dataset.picking === '1'); };
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

  function fileRow(f, del, picking) {
    return `<div class="cf-row${del ? ' can-del' : ''}${filesUi.chosen.has(f.path) ? ' chosen' : ''}" data-path="${escAttr(f.path)}">`
      + `<button type="button" class="cf-main" data-act="${picking ? 'open' : 'view'}">`
      + `<span class="cf-check" aria-hidden="true">${CHECK}</span>`
      + `<span class="cf-pic" data-thumb="${escAttr(f.path)}"></span>`
      + `<span class="cf-tx"><b>${escHtml(f.name)}</b><small>${fmtSize(f.size)} · ${escHtml(niceWhen(f.mtime))}</small></span>`
      + '</button>'
      + (picking
        ? '<button type="button" class="cf-open" data-act="open">Open</button>'
        : `<button type="button" class="cf-btn" data-act="save" aria-label="Save to this phone" title="Save to this phone">${mi('download')}</button>`
          + (del ? `<button type="button" class="cf-btn cf-bin" data-act="delete" aria-label="Delete" title="Delete">${mi('trash')}</button>` : ''))
      + (del ? `<div class="cf-sure"><span>Delete ${fmtSize(f.size)} for good?</span>`
        + '<button type="button" class="cf-no" data-act="cancel">Cancel</button>'
        + '<button type="button" class="cf-yes" data-act="confirm">Delete</button></div>' : '')
      + '</div>';
  }

  function renderFiles() {
    const list = $('#cloudFilesList');
    if (!list || !filesCache) return;
    const picking = isPicking();
    const exts = picking ? pickState.exts : null;
    const canDelete = filesCache.canDelete !== false && !picking;
    let html = '', any = false, anyDel = false;
    for (const g of (filesCache.groups || [])) {
      const files = (g.files || []).filter((f) => !exts || exts.some((e) => f.name.toLowerCase().endsWith(e)));
      if (!files.length) continue;
      any = true;
      // exports and uploads only: the Videos folder is the machine's own
      const del = canDelete && (g.key === 'output' || g.key === 'uploads');
      if (del) anyDel = true;
      const total = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
      html += `<section class="cloud-files-group"><h4 class="cloud-files-head"><span>${escHtml(g.label)}</span><small>${files.length} · ${fmtSize(total)}</small></h4>`
        + files.map((f) => fileRow(f, del, picking)).join('') + '</section>';
    }
    if (!any) {
      html = `<div class="cloud-files-empty"><div class="cf-empty-art">${mi('folder')}</div><b>Nothing here yet</b>`
        + `<p>${exts ? 'Nothing of that kind, anyway. ' : ''}Send a video with the button above.</p></div>`;
    }
    list.innerHTML = html;
    const sel = $('#cloudFilesSelect');
    if (sel) sel.classList.toggle('hidden', !anyDel);
    if (filesUi.selecting && !anyDel) setSelecting(false);
    renderDisk();
    paintSelBar();
    watchThumbs(list);
  }

  function renderDisk() {
    const el = $('#cloudFilesDisk');
    if (!el) return;
    const d = filesCache && filesCache.disk;
    if (!d || !d.total) { el.classList.add('hidden'); return; }
    const used = Math.max(0, d.total - d.free);
    el.classList.remove('hidden');
    el.classList.toggle('low', d.free < d.total * 0.1);
    const where = cloud.hello && cloud.hello.standalone ? 'the server' : 'the studio machine';
    el.innerHTML = `<div class="cf-disk-bar"><i style="width:${Math.min(100, (used / d.total) * 100).toFixed(1)}%"></i></div>`
      + `<span><b>${fmtSize(d.free)} free</b> of ${fmtSize(d.total)} on ${where}</span>`;
  }

  /* ---- deleting ---- */
  function closeSure() { for (const r of $$('#cloudFilesList .cf-row.sure')) r.classList.remove('sure'); }
  function setSelecting(on) {
    filesUi.selecting = !!on;
    filesUi.chosen.clear();
    filesUi.sure = false;
    const m = $('#cloudFilesModal');
    if (m) m.classList.toggle('cf-selecting', filesUi.selecting);
    const sel = $('#cloudFilesSelect');
    if (sel) sel.textContent = filesUi.selecting ? 'Done' : 'Select';
    for (const r of $$('#cloudFilesList .cf-row.chosen')) r.classList.remove('chosen');
    closeSure();
    paintSelBar();
  }
  const sizeOf = (p) => {
    for (const g of (filesCache && filesCache.groups) || []) for (const f of g.files || []) if (f.path === p) return Number(f.size) || 0;
    return 0;
  };
  function paintSelBar() {
    const bar = $('#cloudFilesSelBar');
    if (!bar) return;
    bar.classList.toggle('hidden', !filesUi.selecting);
    const n = filesUi.chosen.size;
    const bytes = Array.from(filesUi.chosen).reduce((t, p) => t + sizeOf(p), 0);
    const info = $('#cloudFilesSelInfo');
    if (info) info.textContent = n ? `${n} selected · ${fmtSize(bytes)}` : 'Tap the videos to delete';
    const del = $('#cloudFilesSelDelete');
    if (!del) return;
    del.disabled = !n;
    del.classList.toggle('sure', !!(filesUi.sure && n));
    const tx = del.querySelector('span');
    if (tx) tx.textContent = filesUi.sure && n ? `Delete ${n === 1 ? 'it' : 'all ' + n} for good?` : n > 1 ? `Delete ${n}` : 'Delete';
  }
  function onFilesClick(e) {
    const b = e.target.closest('[data-act]');
    const row = b && b.closest('.cf-row');
    if (!row) return;
    const p = row.dataset.path, act = b.dataset.act;
    if (filesUi.selecting) {
      if (!row.classList.contains('can-del')) return;
      if (filesUi.chosen.has(p)) filesUi.chosen.delete(p); else filesUi.chosen.add(p);
      row.classList.toggle('chosen', filesUi.chosen.has(p));
      filesUi.sure = false;
      paintSelBar();
      return;
    }
    if (act === 'open') return finishPick(pickState.multi ? [p] : p);
    // the row itself plays it here; the ⬇ button saves it
    if (act === 'view') return viewFile(p);
    if (act === 'save') return offerDownload(p, (findFile(p) || {}).size);
    if (act === 'delete') { closeSure(); row.classList.add('sure'); return; }
    if (act === 'cancel') return closeSure();
    if (act === 'confirm') return deletePaths([p]);
  }
  function onSelDelete() {
    if (!filesUi.chosen.size) return;
    if (!filesUi.sure) { filesUi.sure = true; paintSelBar(); return; }
    deletePaths(Array.from(filesUi.chosen));
  }
  async function deletePaths(paths) {
    const open = window.VideoEditor && window.VideoEditor.sourcePath ? window.VideoEditor.sourcePath() : null;
    const kept = paths.filter((p) => open && p === open);
    const go = paths.filter((p) => !(open && p === open));
    const rows = $$('#cloudFilesList .cf-row').filter((r) => go.includes(r.dataset.path));
    let out = { deleted: [], refused: [], freed: 0 };
    if (go.length) {
      rows.forEach((r) => r.classList.add('busy'));
      try {
        const res = await fetch('/api/delete', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
          body: JSON.stringify({ paths: go }),
        });
        if (res.status === 401) { signedOut(); return; }
        out = await res.json();
        if (!res.ok) throw new Error(out.error || 'The studio could not delete that.');
      } catch (e) {
        rows.forEach((r) => r.classList.remove('busy'));
        closeSure();
        island({ kind: 'error', title: 'Nothing was deleted', sub: e.message || String(e), ms: 7000 });
        return;
      }
    }
    const gone = new Set(out.deleted || []);
    for (const r of $$('#cloudFilesList .cf-row')) {
      r.classList.remove('busy');
      if (gone.has(r.dataset.path)) r.classList.add('gone');
    }
    closeSure();
    cloud.downloads = cloud.downloads.filter((d) => !gone.has(d.path));
    renderDownloadCount();
    if (out.disk && filesCache) filesCache.disk = out.disk;
    if (out.autosaveCleared && window.VideoEditor && window.VideoEditor.forgetResume) window.VideoEditor.forgetResume();
    for (const fn of cloud.fileListeners) { try { fn({ deleted: Array.from(gone), autosaveCleared: !!out.autosaveCleared }); } catch (e) {} }
    const refused = (out.refused || []).concat(kept.map((p) => ({ path: p, why: 'It is open in the Video Studio — open a different video there first.' })));
    if (gone.size) {
      island({
        kind: refused.length ? 'warn' : 'good',
        title: gone.size > 1 ? `${gone.size} videos deleted` : 'Video deleted',
        sub: (out.freed ? `${fmtSize(out.freed)} freed` : 'Removed') + (refused.length ? ` · ${refused.length} kept: ${refused[0].why}` : ''),
        ms: refused.length ? 9000 : 4000,
      });
    } else if (refused.length) {
      island({ kind: 'warn', title: refused.length > 1 ? `${refused.length} videos kept` : 'Not deleted', sub: refused[0].why, ms: 9000 });
    }
    setTimeout(() => { if (filesUi.selecting) setSelecting(false); refreshFiles(true); }, gone.size ? 320 : 0);
  }

  /* ---- a picture for every video, made as its row comes into view ---- */
  const fileThumbs = new Map();          // path -> image URL ('' while it is being made)
  let thumbQueue = Promise.resolve();     // one at a time: a small server makes them in turn anyway
  function watchThumbs(list) {
    if (list._thumbs) list._thumbs.disconnect();
    const paintAll = (p) => {
      const u = fileThumbs.get(p);
      if (!u) return;
      for (const el of $$(`[data-thumb="${CSS.escape(p)}"]`)) el.style.backgroundImage = `url("${u}")`;
    };
    const want = (el) => {
      const p = el.dataset.thumb;
      if (fileThumbs.get(p)) return paintAll(p);
      if (fileThumbs.has(p)) return;     // on its way
      fileThumbs.set(p, '');
      thumbQueue = thumbQueue.then(async () => {
        try {
          const t = await window.api.video.thumbnail(p, 1);
          if (t) fileThumbs.set(p, window.MW_FILE_URL(t)); else fileThumbs.delete(p);
        } catch (e) { fileThumbs.delete(p); }
        paintAll(p);
      });
    };
    const els = $$('[data-thumb]', list);
    if (!('IntersectionObserver' in window)) { els.forEach(want); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); want(en.target); }
    }, { root: list, rootMargin: '160px' });
    list._thumbs = io;
    els.forEach((el) => { if (fileThumbs.get(el.dataset.thumb)) want(el); else io.observe(el); });
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

  /*
   * SAVING A FILE TO THE PHONE. A plain download link, in an iPhone home-screen
   * app, replaced the whole app with a grey "MP4 · Open in…" page that had no
   * way back. So on a phone a video is handed to the share sheet as a file
   * (Save Video puts it in Photos), and when that cannot be done — too big to
   * hold in memory, or no share sheet — it opens in an in-app browser page,
   * which has its own Done button. The desk keeps the ordinary download.
   */
  const SHARE_MAX = 200 * 1024 * 1024;
  const isStandalone = () => navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const onPhone = () => window.matchMedia('(max-width: 900px)').matches;
  async function offerDownload(p, size) {
    if (!p) return;
    const name = String(p).split(/[\\/]/).pop();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
      // A folder — the nearest honest equivalent is the file list.
      openFilesModal();
      return;
    }
    if (!cloud.downloads.some((d) => d.path === p)) cloud.downloads.unshift({ path: p, name, at: Date.now() });
    renderDownloadCount();
    if (onPhone() && navigator.canShare && (!size || size <= SHARE_MAX)) {
      const id = 'save-' + name;
      island({ id, title: 'Getting it ready…', sub: name, spin: true, sticky: true });
      try {
        const res = await fetch(downloadUrl(p));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const type = blob.type && blob.type !== 'application/octet-stream' ? blob.type : (/\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4');
        const file = new File([blob], name, { type });
        islandHide(id);
        if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
      } catch (e) {
        islandHide(id);
        if (e && e.name === 'AbortError') return;          // they closed the share sheet
      }
    }
    if (onPhone() && isStandalone()) { window.open(downloadUrl(p), '_blank'); return; }
    const a = document.createElement('a');
    a.href = downloadUrl(p);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /*
   * WATCHING A FILE. Tapping a video in Files used to "download" it, which on
   * an iPhone meant leaving the app. Now it plays here, full screen, with ✕
   * to come back and what you would want to do next: save it to the phone,
   * open it in the Video Studio, or post it.
   */
  function viewFile(p) {
    if (!p) return;
    const name = String(p).split(/[\\/]/).pop();
    const isVideo = /\.(mp4|mov|m4v|webm|mkv)$/i.test(name);
    const isPic = /\.(png|jpe?g|webp|gif)$/i.test(name);
    if (!isVideo && !isPic) return offerDownload(p);
    const old = document.getElementById('cloudViewer'); if (old) old.remove();
    const v = document.createElement('div');
    v.id = 'cloudViewer'; v.className = 'cloud-viewer';
    v.setAttribute('role', 'dialog'); v.setAttribute('aria-label', name);
    const social = !!(cloud.hello && cloud.hello.social) && window.MWSocial;
    v.innerHTML = `<div class="cv-top"><button type="button" class="cv-btn cv-close" data-cv="close" aria-label="Back">${mi('x')}</button>`
      + `<b class="cv-name">${escHtml(name)}</b></div>`
      + `<div class="cv-stage">${isVideo
        ? `<video class="cv-media" src="${escAttr(window.MW_FILE_URL(p))}" controls playsinline autoplay preload="metadata"></video>`
        : `<img class="cv-media" src="${escAttr(window.MW_FILE_URL(p))}" alt="">`}</div>`
      + '<div class="cv-acts">'
      + `<button type="button" class="cv-act" data-cv="save">${mi('download')}<span>Save</span></button>`
      + (isVideo ? `<button type="button" class="cv-act" data-cv="studio">${mi('film')}<span>Edit</span></button>` : '')
      + (isVideo && social ? `<button type="button" class="cv-act cv-primary" data-cv="post">${mi('send')}<span>Post</span></button>` : '')
      + '</div>';
    document.body.appendChild(v);
    requestAnimationFrame(() => v.classList.add('on'));
    const close = () => {
      const m = v.querySelector('video'); if (m) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch (e) {} }
      v.classList.remove('on'); setTimeout(() => v.remove(), 220);
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    v.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cv]'); if (!b) return;
      const act = b.dataset.cv;
      if (act === 'close') return close();
      if (act === 'save') return offerDownload(p, (findFile(p) || {}).size);
      if (act === 'studio') {
        close();
        $$('.cap-modal:not(.hidden)').forEach((m) => m.classList.add('hidden'));
        const fm = $('#cloudFilesModal'); if (fm) fm.classList.add('hidden');
        if (window.MWSocial) window.MWSocial.go('studio');
        if (window.VideoEditor && window.VideoEditor.openPath) window.VideoEditor.openPath(p);
        return;
      }
      if (act === 'post') { close(); const fm = $('#cloudFilesModal'); if (fm) fm.classList.add('hidden'); return window.MWSocial.compose({ files: [p] }); }
    });
  }
  function findFile(p) {
    for (const g of ((filesCache && filesCache.groups) || [])) for (const f of (g.files || [])) if (f.path === p) return f;
    return null;
  }

  function renderDownloads() {
    const list = $('#cloudDownloadsList');
    if (!list) return;
    if (!cloud.downloads.length) {
      list.innerHTML = `<div class="cloud-files-empty"><div class="cf-empty-art">${mi('download')}</div><b>Nothing finished yet</b>`
        + '<p>Exports from this session land here, ready to save to this phone.</p></div>';
      return;
    }
    list.innerHTML = cloud.downloads.map((d) => `<div class="cf-row" data-path="${escAttr(d.path)}">`
      + `<button type="button" class="cf-main" data-act="view"><span class="cf-pic" data-thumb="${escAttr(d.path)}"></span>`
      + `<span class="cf-tx"><b>${escHtml(d.name)}</b><small>Finished ${escHtml(niceWhen(d.at))}</small></span></button>`
      + `<button type="button" class="cf-btn" data-act="save" aria-label="Save to this phone" title="Save to this phone">${mi('download')}</button></div>`).join('');
    watchThumbs(list);
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
  /*
   * What a finger drags AT ONCE: the white trim handles and edges, and what
   * sits on the picture (text, the crop frame, an overlay). Not the BODY of a
   * clip on the timeline — the video clip spans the whole row, and grabbing it
   * on touch meant a swipe to scroll the timeline moved the sermon instead.
   * Clip bodies are picked up the way CapCut does it: swipe scrolls, a tap
   * selects (the browser's own click), and a long press lifts the clip so it
   * can be moved — the LONG_PRESS_SEL path below, which the rows contain.
   */
  const DRAG_SEL = [
    '.ve-seg-h', '.ve-audio-h', '.ve-cc-h',
    '.ve-cap-edge', '[data-cedge]', '[data-capedge]',
    '.ve-text-box', '.ve-text-resize', '.ve-tc-h', '[data-tedge]',
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
  const LONG_PRESS_SEL = '#veTrack, .ve-track, .ve-cap-track, .ve-text-track, .ve-audio-track, .ve-music-track, .ve-sfx-track';
  const LONG_PRESS_MS = 350;
  const SLOP_PX = 9;

  function installTouchBridge() {
    let dragging = false;
    let pending = null;      // a long press being waited out
    let held = null;         // the element the dragging finger first touched

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

    /*
     * A touch's moves and its lift are delivered to the element it STARTED on,
     * even after that element has left the page. Picking a clip up makes the
     * studio redraw the timeline — the very block under the finger is replaced —
     * and from then on the moves went to a detached node and never reached the
     * document: the clip lifted, moved once, and stuck. So while a finger drags,
     * the element it touched is listened to as well (each event handled once).
     */
    const hold = (el) => {
      release();
      if (!el || !el.addEventListener) return;
      held = el;
      el.addEventListener('touchmove', onMove, { passive: false });
      el.addEventListener('touchend', end);
      el.addEventListener('touchcancel', end);
    };
    const release = () => {
      if (!held) return;
      held.removeEventListener('touchmove', onMove, { passive: false });
      held.removeEventListener('touchend', end);
      held.removeEventListener('touchcancel', end);
      held = null;
    };

    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { cancelPending(); dragging = false; release(); return; }
      const t = e.touches[0];
      const el = t.target;
      if (!el || !el.closest) return;
      if (el.closest(NO_BRIDGE)) return;

      if (el.closest(DRAG_SEL)) {
        dragging = true;
        e.preventDefault();        // no scroll, no synthetic click, no 300ms wait
        hold(el);
        mouse('mousedown', t, el);
        return;
      }

      if (el.closest(LONG_PRESS_SEL)) {
        // Hold still and this becomes a drag; move and it stays a scroll.
        // clientX/clientY by those names: mouse() reads them, and without them
        // the studio was told the press landed at the screen's left edge
        const start = { x: t.clientX, y: t.clientY, clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY };
        pending = {
          el,
          start,
          timer: setTimeout(() => {
            pending = null;
            dragging = true;
            // A short buzz is how a phone says "you are holding it now".
            try { if (navigator.vibrate) navigator.vibrate(12); } catch (er) {}
            hold(el);
            mouse('mousedown', start, el);
          }, LONG_PRESS_MS),
        };
      }
    }, { passive: false, capture: true });

    function onMove(e) {
      if (e.__mwTouch) return;             // already handled on the way down
      e.__mwTouch = true;
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
    }
    document.addEventListener('touchmove', onMove, { passive: false, capture: true });

    function end(e) {
      if (e.__mwTouch) return;
      e.__mwTouch = true;
      // A tap that never became a hold is left alone: the browser turns it into
      // a click on its own, and the studio seeks there exactly as it would from
      // a mouse.
      cancelPending();
      if (!dragging) return;
      dragging = false;
      release();
      const t = (e.changedTouches && e.changedTouches[0]) || { clientX: 0, clientY: 0, screenX: 0, screenY: 0 };
      mouse('mouseup', t, document);
    }
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

  /* ---------------------------------------------------- the phone editor */

  /*
   * The other half of the phone layout in cloud.css: the top bar's quality and
   * Export, the tool dock along the bottom, and the sheets that come up over
   * the timeline. Every tool here PRESSES one of the desk's own buttons — the
   * same handler, the same undo stack, the same disabled state — so a tool on
   * the phone can never do something the desktop's button does not, and a
   * button the studio greys out is greyed out here too.
   */
  const mi = (name, extra) => `<i class="mi${extra ? ' ' + extra : ''}" data-i="${name}"></i>`;

  // Icons the desk has no use for, drawn in the same line style as its set.
  const PHONE_ICONS = {
    'chev-left': '<path d="m15 18-6-6 6-6"/>',
    'zoom-in': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>',
    'zoom-out': '<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>',
    'fit': '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    'expand': '<path d="m18 15-6-6-6 6"/>',
    'shrink': '<path d="m6 9 6 6 6-6"/>',
    'clapper': '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    // the home screen, the jobs sheet and the scheduler
    'home': '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
    'calendar': '<rect width="18" height="17" x="3" y="4.5" rx="2.5"/><path d="M3 9.5h18"/><path d="M8 2.5v4"/><path d="M16 2.5v4"/>',
    'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    'send': '<path d="M21.5 2.5 10.6 13.4"/><path d="m21.5 2.5-7 19-3.9-8.1-8.1-3.9z"/>',
    'chev-right': '<path d="m9 18 6-6-6-6"/>',
    'refresh': '<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>',
    'grid': '<rect width="7" height="7" x="3" y="3" rx="1.5"/><rect width="7" height="7" x="14" y="3" rx="1.5"/><rect width="7" height="7" x="3" y="14" rx="1.5"/><rect width="7" height="7" x="14" y="14" rx="1.5"/>',
    'stop': '<rect width="12" height="12" x="6" y="6" rx="2"/>',
    'key': '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8"/><path d="m17 6 3 3"/><path d="m14.5 8.5 2 2"/>',
    'external': '<path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    'list': '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><circle cx="4" cy="6" r=".6"/><circle cx="4" cy="12" r=".6"/><circle cx="4" cy="18" r=".6"/>',
    'wand-sparkle': '<path d="m15 4 5 5L8 21l-5-5z"/><path d="M13 6l5 5"/><path d="M5 2.5v3M3.5 4h3"/><path d="M19.5 15.5v3M18 17h3"/>',
  };
  /*
   * On the phone the icons are drawn finer, the way CapCut's are: the desk's
   * 1.9 stroke reads well at 16px on a monitor and heavy at 24px on a phone.
   * A few take CapCut's own shapes too — subtitles in a frame for Captions,
   * three circles for Filters, the two arrows for full screen.
   */
  const PHONE_SHAPES = {
    captions: '<rect width="18" height="14" x="3" y="5" rx="2.5"/><path d="M7 15h4"/><path d="M14 15h3"/><path d="M7 11h2"/><path d="M12 11h5"/>',
    filters: '<circle cx="12" cy="8.5" r="5"/><circle cx="8.5" cy="14.5" r="5"/><circle cx="15.5" cy="14.5" r="5"/>',
    fullscreen: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    overlay: '<rect width="12" height="12" x="9" y="9" rx="2"/><path d="M15 9V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h4"/>',
    rotate: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    sfx: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="m19 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/>',
    transition: '<rect width="8" height="14" x="2" y="5" rx="1.5"/><rect width="8" height="14" x="14" y="5" rx="1.5"/><path d="m11 9 2 3-2 3"/>',
    keyframe: '<path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M12 8.5 15.5 12 12 15.5 8.5 12z"/>',
    chroma: '<rect width="18" height="14" x="3" y="5" rx="2.5"/><path d="M12 16.5c-2 0-3.2-1.4-3.2-3.1 0-1.9 1.5-3.4 3.2-3.4s3.2 1.5 3.2 3.4c0 1.7-1.2 3.1-3.2 3.1z"/><path d="M8 19v-1.2a4 4 0 0 1 8 0V19"/>',
    template: '<rect width="18" height="18" x="3" y="3" rx="2.5"/><path d="M3 9h18"/><path d="M9 21V9"/>',
    animate: '<path d="M5 18h6"/><path d="M3 13h5"/><path d="M5 8h4"/><path d="M14.5 6.5 19 12l-4.5 5.5"/><circle cx="15" cy="12" r="0.6"/>',
    sliders: '<line x1="4" x2="20" y1="7" y2="7"/><line x1="4" x2="20" y1="17" y2="17"/><circle cx="9" cy="7" r="2.4" fill="#fff"/><circle cx="15" cy="17" r="2.4" fill="#fff"/>',
  };
  const fineUri = (body) => 'url("data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round">${body.replace(/fill="#fff"/g, 'fill="none"')}</svg>`) + '")';
  function addPhoneIcons() {
    if ($('#cloudPhoneIcons') || !window.MWIcons || !window.MWIcons.svgUri) return;
    const st = document.createElement('style');
    st.id = 'cloudPhoneIcons';
    const all = Object.assign({}, window.MWIcons.ICONS || {}, PHONE_ICONS, PHONE_SHAPES);
    const scope = (k) => ['.cloud-dock', '.cloud-bar', '.cloud-sheet-head', '.cloud-tl-add', '#view-video .ve-transport', '.cloud-export-sheet',
      '.cloud-home', '.cloud-sched', '.cp-panel']
      .map((r) => `${r} .mi[data-i="${k}"]`).join(',');
    st.textContent = Object.keys(PHONE_ICONS)
      .map((k) => `.mi[data-i="${k}"]{--mi:${window.MWIcons.svgUri(PHONE_ICONS[k])}}`).join('\n')
      + '\n@media (max-width: 900px) {\n'
      + Object.keys(all).map((k) => `${scope(k)}{--mi:${fineUri(all[k])}}`).join('\n')
      + '\n}';
    document.head.appendChild(st);
  }

  /* What the dock holds. `press` is a desk button; `sheet` opens a sheet;
     `row` swaps the dock for that row of tools; `check` toggles a desk box. */
  const DOCK = {
    main: [
      { icon: 'sparkles', label: 'AI Shorts', ai: true, sheet: 'shorts', count: true },
      { icon: 'wand-sparkle', label: 'Montage', ai: true, montage: true },
      { icon: 'scissors', label: 'Edit', row: 'edit' },
      { icon: 'music', label: 'Audio', row: 'audio' },
      { icon: 'type', label: 'Text', row: 'text' },
      { icon: 'captions', label: 'Captions', ai: true, sheet: 'insp', tab: '#veInspTabCaptions' },
      { icon: 'overlay', label: 'Overlay', row: 'overlay' },
      { icon: 'filters', label: 'Filters', fx: '#fxLook' },
      { icon: 'sliders', label: 'Adjust', fx: '#fxBri' },
      { icon: 'crop', label: 'Ratio', row: 'ratio' },
      { icon: 'target', label: 'Reframe', ai: true, sheet: 'insp', tab: '#veInspTabReframe' },
      { icon: 'palette', label: 'Look', sheet: 'insp', tab: '#veInspTabLook' },
      { icon: 'folder', label: 'Project', row: 'project' },
    ],
    edit: [
      { icon: 'scissors', label: 'Split', press: '#veSplit' },
      { icon: 'transition', label: 'Transition', call: 'transitionAtPlayhead' },
      { icon: 'keyframe', label: 'Keyframe', call: 'keyframes' },
      { icon: 'zap', label: 'Speed', fx: '#fxSpeed' },
      { icon: 'volume', label: 'Volume', fx: '#fxVol' },
      { icon: 'trash', label: 'Delete', press: '#veDelClip' },
      { icon: 'copy', label: 'Duplicate', press: '#veDupClip' },
      { icon: 'rotate', label: 'Rotate', fx: '#fxRot' },
      { icon: 'rewind', label: 'Reverse', press: '[data-vtool="reverse"]' },
      { icon: 'snowflake', label: 'Freeze', press: '[data-vtool="freeze"]' },
      { icon: 'hand', label: 'Stabilize', press: '[data-vtool="stabilize"]' },
      { icon: 'link', label: 'Close gap', press: '#veCloseGap' },
      { icon: 'plus', label: 'New clip', press: '#veAddClip' },
      { icon: 'pen', label: 'Blade', blade: true },
      { icon: 'magnet', label: 'Snap', press: '#veSnap', on: true },
      { icon: 'repeat', label: 'Loop', check: '#veLoopSel' },
      { icon: 'zoom-out', label: 'Zoom out', press: '#veZoomOut' },
      { icon: 'fit', label: 'Fit', press: '#veZoomFit' },
      { icon: 'zoom-in', label: 'Zoom in', press: '#veZoomIn' },
      { icon: 'eye', label: 'Follow', press: '#veFollow', on: true },
    ],
    audio: [
      { icon: 'music', label: 'Music', press: '#veMusic' },
      { icon: 'mic', label: 'Voiceover', press: '#veVoiceover' },
      { icon: 'sfx', label: 'Sound FX', press: '#veSfxBtn' },
      { icon: 'volume', label: 'Volume', fx: '#fxVol' },
      { icon: 'mic', label: 'Clean voice', sheet: 'insp', tab: '#veInspTabAudio' },
      { icon: 'audio-lines', label: 'Extract', press: '[data-vtool="extract"]' },
      { icon: 'volume-x', label: 'Trim silence', press: '[data-vtool="autotrim"]' },
      { icon: 'volume', label: 'Clip sound', press: '#veOvSound' },
    ],
    text: [
      { icon: 'type', label: 'Add text', press: '#veAddText' },
      { icon: 'template', label: 'Templates', call: 'textTemplates' },
      { icon: 'animate', label: 'Animation', call: 'textAnimation' },
      { icon: 'captions', label: 'Captions', ai: true, sheet: 'insp', tab: '#veInspTabCaptions' },
    ],
    ratio: [],      // built from the desk's own list of shapes
    overlay: [
      { icon: 'image', label: 'Add media', press: '#veAddMedia' },
      { icon: 'overlay', label: 'To overlay', press: '#veOverlay' },
      { icon: 'chroma', label: 'Chroma key', call: 'chromaKey' },
      { icon: 'eraser', label: 'Cut out', press: '#veCutOut' },
      { icon: 'volume', label: 'Sound', press: '#veOvSound' },
    ],
    project: [
      { icon: 'folder', label: 'Open', press: '#veOpen' },
      { icon: 'save', label: 'Save', press: '#veSaveSession' },
      { icon: 'layers', label: 'Sessions', press: '#veSessions' },
      { icon: 'clapper', label: 'Outros', press: '#veClips' },
      { icon: 'package', label: 'Batch', press: '#veBulk' },
      { icon: 'download', label: 'Saved', press: '#cloudDownloads' },
      { icon: 'book', label: 'Help', press: '#cloudHelp' },
    ],
  };

  const SHEET_KINDS = ['shorts', 'insp', 'export'];
  function closeSheet() {
    document.body.classList.remove('mw-sheet', 'mw-sheet-tall', ...SHEET_KINDS.map((k) => 'mw-sheet-' + k));
  }
  function sheetTitle(t) { const el = $('#cloudSheetHead .cloud-sheet-title'); if (el) el.textContent = t; }
  function inspTitle() {
    const on = $('#view-video .ve-insp-tabs button.on .ve-tab-tx');
    return on ? on.textContent.trim() : 'Settings';
  }
  function openSheet(kind, opts = {}) {
    closeSheet();
    document.body.classList.add('mw-sheet', 'mw-sheet-' + kind);
    if (kind === 'insp' && opts.tab) { const t = $(opts.tab); if (t) t.click(); }
    if (kind === 'export') renderExportSheet();
    sheetTitle(kind === 'shorts' ? 'AI Shorts' : kind === 'export' ? 'Export' : inspTitle());
    const body = kind === 'shorts' ? $('#view-video .ve-bin') : kind === 'insp' ? $('#view-video .ve-side') : $('#cloudExportSheet');
    if (body) body.scrollTop = 0;
  }

  const plain = (s) => String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  const QUALITY_SHORT = { '480p': '480p', '720p': '720p', '1080p': '1080p', '4k': '4K', source: 'Original' };

  function fillQuality(sel) {
    const q = $('#veQuality');
    if (!q || !sel) return;
    if (sel.options.length !== q.options.length) {
      sel.innerHTML = '';
      for (const o of q.options) sel.add(new Option(plain(o.textContent), o.value));
    }
    sel.value = q.value;
  }
  function setQuality(v) {
    const q = $('#veQuality');
    if (!q || q.value === v) return;
    q.value = v;
    q.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function syncQualityPill() {
    const q = $('#veQuality');
    const tx = $('#cloudQualityTx');
    if (q && tx) tx.textContent = QUALITY_SHORT[q.value] || plain(q.options[q.selectedIndex] && q.options[q.selectedIndex].textContent);
    fillQuality($('#cloudQuality'));
    fillQuality($('#cloudXpQuality'));
  }

  function renderExportSheet() {
    syncQualityPill();
    const ed = $('#veExportEdited');
    const all = $('#veExportAll');
    const n = $$('#veClipList .ve-clip').length;
    const v = $('#cloudExportSheet [data-xp="video"]');
    const s = $('#cloudExportSheet [data-xp="shorts"]');
    if (v) {
      v.disabled = !ed || ed.disabled;
      const m = /\(([^)]+)\)/.exec(ed ? ed.textContent : '');
      $('#cloudXpVideoSub').textContent = v.disabled ? 'Open a video first' : 'The whole edit as one file' + (m ? ' · ' + m[1] : '');
    }
    if (s) {
      s.disabled = !all || all.disabled;
      $('#cloudXpShortsSub').textContent = n ? `${n} short${n === 1 ? '' : 's'}, 9:16, ready for Reels, TikTok and Shorts` : 'Make shorts with AI Shorts first';
    }
    for (const sel of $$('#cloudExportSheet [data-mirror-sel]')) {
      const src = $(sel.dataset.mirrorSel);
      sel.closest('.cloud-xp-row').classList.toggle('hidden', !src);
      if (!src) continue;
      if (sel.options.length !== src.options.length) {
        sel.innerHTML = '';
        for (const o of src.options) sel.add(new Option(plain(o.textContent), o.value));
      }
      sel.value = src.value;
    }
    for (const box of $$('#cloudExportSheet [data-mirror]')) {
      const src = $(box.dataset.mirror);
      box.checked = !!(src && src.checked);
      box.closest('.cloud-xp-row').classList.toggle('hidden', !src);
    }
    syncEnding();
  }
  /* The ending row: the outro's own picture, its name and length, and whether
     it goes on. Read from the studio every time the sheet opens or the clip
     library closes, so it never shows a stale choice. */
  function syncEnding() {
    const row = $('#cloudXpEnding'); if (!row) return;
    const ed = window.VideoEditor;
    const o = ed && ed.outroInfo ? ed.outroInfo() : null;
    const sub = $('#cloudXpEndSub'), box = $('#cloudXpEndOn'), th = row.querySelector('.cloud-xp-end-thumb i');
    const t = (sec) => { const x = Math.round(sec || 0); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };
    row.classList.toggle('has', !!o);
    row.classList.toggle('on', !!(o && o.on));
    if (box) box.checked = !!(o && o.on);
    if (sub) sub.textContent = o ? `${o.name} · ${t(o.durationSec)}${o.on ? '' : ' · off'}` : 'Choose a clip or picture to end every short';
    if (th) th.style.backgroundImage = o && o.thumb ? `url("${o.thumb}")` : '';
  }

  /*
   * Speed, Volume, Filters, Adjust and Rotate are all in the studio's one
   * effects panel (🎛️ Video quality). On the phone each is its own tool, so the
   * panel opens AT that control rather than at the top of a long list.
   */
  function openFx(sel) {
    const open = $('#veEffects');
    if (!open || open.disabled) return;
    closeSheet();
    open.click();
    setTimeout(() => {
      const el = $(sel);
      const row = el && (el.closest('label, .fx-row, .ve-fill-row, div') || el);
      if (!row) return;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('cloud-flash');
      setTimeout(() => row.classList.remove('cloud-flash'), 1400);
    }, 120);
  }

  /*
   * THE STUDIO NEVER SCROLLS ON A PHONE. Its frame is the screen; the timeline
   * and the sheets scroll inside it. But `overflow: hidden` only stops a finger,
   * not code: a lane or a caption block brought into view with scrollIntoView
   * scrolled the view itself, and the preview slid up under the top bar with
   * its top cut off until the app was reloaded. Any such scroll is put back.
   */
  function pinStudioFrame() {
    const pin = (el) => {
      if (!el || el._mwPinned) return;
      el._mwPinned = true;
      el.addEventListener('scroll', () => {
        if (!window.matchMedia('(max-width: 900px)').matches) return;
        if (el.scrollTop || el.scrollLeft) { el.scrollTop = 0; el.scrollLeft = 0; }
      }, { passive: true });
    };
    pin(document.querySelector('#view-video'));
    pin(document.querySelector('main.content'));
    pin(document.getElementById('app'));
    /*
     * …and the page itself. Typing (a text box, a caption line) brings up the
     * keyboard, and iOS scrolls the whole page up to show the field — then, in
     * a home-screen app, often leaves it there when the keyboard goes. The
     * studio stayed shifted up under the top bar, the top of the preview cut
     * off. Once nothing is being typed in and the keyboard is down, it goes
     * back to the top.
     */
    if (!pinStudioFrame._page) {
      pinStudioFrame._page = true;
      const typing = () => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); };
      const settle = () => {
        if (!window.matchMedia('(max-width: 900px)').matches || typing()) return;
        if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
          window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
        }
      };
      document.addEventListener('focusout', () => setTimeout(settle, 120));
      window.addEventListener('scroll', () => { if (!typing()) settle(); }, { passive: true });
      if (window.visualViewport) window.visualViewport.addEventListener('resize', () => setTimeout(settle, 120));
    }
  }
  function installPhoneEditor() {
    pinStudioFrame();
    const view = $('#view-video');
    if (!view || $('#cloudDock')) return;
    if (window.MWIcons) window.MWIcons.mount([]);      // the icon set's own CSS
    addPhoneIcons();

    /* ---- the top bar: icons, the export quality, and Export ---------- */
    const chip = (sel, icon, label) => {
      const b = $(sel);
      if (!b) return;
      const badge = b.querySelector('.cloud-badge');
      b.innerHTML = `${mi(icon, 'mi-l')}<span class="cloud-chip-tx">${label}</span>`;
      if (badge) b.appendChild(badge);
      b.setAttribute('aria-label', label);
    };
    chip('#cloudFiles', 'folder', 'Files');
    chip('#cloudDownloads', 'download', 'Saved');

    const actions = $('#cloudBar .cloud-bar-actions') || $('#cloudBar');
    const qWrap = document.createElement('label');
    qWrap.className = 'cloud-q';
    qWrap.title = 'Export quality';
    qWrap.innerHTML = '<span id="cloudQualityTx">1080p</span><select id="cloudQuality" aria-label="Export quality"></select>';
    actions.appendChild(qWrap);
    $('#cloudQuality').addEventListener('change', (e) => { setQuality(e.target.value); syncQualityPill(); });
    const q = $('#veQuality');
    if (q) q.addEventListener('change', syncQualityPill);
    syncQualityPill();

    const xp = document.createElement('button');
    xp.id = 'cloudExport';
    xp.className = 'cloud-export';
    xp.textContent = 'Export';
    xp.addEventListener('click', () => openSheet('export'));
    actions.appendChild(xp);

    /* ---- the play row: undo and redo where a thumb expects them -------- */
    const right = $('#view-video .ve-transport-right');
    if (right) {
      const extra = document.createElement('span');
      extra.className = 'cloud-tr-extra';
      extra.innerHTML = `<button type="button" data-press="#veUndo" aria-label="Undo">${mi('undo')}</button>`
        + `<button type="button" data-press="#veRedo" aria-label="Redo">${mi('redo')}</button>`;
      right.insertBefore(extra, $('#veFull') || null);
      for (const b of extra.querySelectorAll('[data-press]')) {
        b.addEventListener('click', () => { const t = $(b.dataset.press); if (t && !t.disabled) t.click(); });
        mirror(b, $(b.dataset.press), {});
      }
    }

    /* ---- the dock ---------------------------------------------------- */
    const dock = document.createElement('nav');
    dock.id = 'cloudDock';
    dock.className = 'cloud-dock';
    dock.setAttribute('aria-label', 'Editing tools');
    document.body.appendChild(dock);

    // Ratio: one button per shape the desk offers, in the desk's own order.
    const aspect = $('#veAspect');
    const ratioRow = () => (aspect ? Array.from(aspect.options).map((o) => ({
      ratio: o.value, label: plain(o.textContent).replace(/\s*\(.*\)$/, ''), short: (/(\d+:\d+)/.exec(o.textContent) || [, plain(o.textContent).slice(0, 4)])[1],
    })) : []);

    function buildRow(name) {
      const row = document.createElement('div');
      row.className = 'cloud-dock-row' + (name === 'main' ? ' on' : '');
      row.dataset.row = name;
      if (name !== 'main') {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'cloud-tool cloud-tool-back';
        back.setAttribute('aria-label', 'Back');
        back.innerHTML = mi('chev-left');
        back.addEventListener('click', () => showRow('main'));
        row.appendChild(back);
      }
      const items = name === 'ratio' ? ratioRow() : DOCK[name];
      for (const t of items) row.appendChild(buildTool(t));
      dock.appendChild(row);
      return row;
    }

    function buildTool(t) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cloud-tool' + (t.ratio !== undefined ? ' cloud-tool-ratio' : '');
      b.innerHTML = (t.ratio !== undefined ? `<b>${t.short}</b>` : mi(t.icon))
        + `<span>${t.label}</span>`
        + (t.ai ? '<span class="cloud-tool-ai">AI</span>' : '')
        + (t.count ? '<span class="cloud-tool-count hidden" data-count></span>' : '');
      b.addEventListener('click', () => act(t));
      if (t.press) mirror(b, $(t.press), { on: t.on });
      if (t.fx) mirror(b, $('#veEffects'), {});
      if (t.blade) mirror(b, $('#veToolBlade'), { on: true });
      if (t.check) {
        const box = $(t.check);
        const sync = () => b.classList.toggle('on', !!(box && box.checked));
        if (box) box.addEventListener('change', sync);
        b._sync = sync; sync();
      }
      if (t.ratio !== undefined) {
        const sync = () => b.classList.toggle('on', !!aspect && aspect.value === t.ratio);
        if (aspect) aspect.addEventListener('change', sync);
        b._sync = sync; sync();
      }
      return b;
    }

    function act(t) {
      if (t.montage) return window.MWSocial && window.MWSocial.openMontage && window.MWSocial.openMontage();
      if (t.row) return showRow(t.row);
      if (t.fx) return openFx(t.fx);
      if (t.call) { const ed = window.VideoEditor; if (ed && typeof ed[t.call] === 'function') ed[t.call](); return; }
      if (t.sheet) return openSheet(t.sheet, t);
      if (t.press) { const el = $(t.press); if (el && !el.disabled) el.click(); return; }
      if (t.blade) {
        const blade = $('#veToolBlade');
        const on = blade && blade.classList.contains('on');
        const el = $(on ? '#veToolSelect' : '#veToolBlade');
        if (el) el.click();
        return;
      }
      if (t.check) {
        const box = $(t.check);
        if (box) { box.checked = !box.checked; box.dispatchEvent(new Event('change', { bubbles: true })); }
        return;
      }
      if (t.ratio !== undefined && aspect && aspect.value !== t.ratio) {
        aspect.value = t.ratio;
        aspect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function showRow(name) {
      for (const r of dock.querySelectorAll('.cloud-dock-row')) {
        const on = r.dataset.row === name;
        r.classList.toggle('on', on);
        if (on) {
          r.scrollLeft = 0;
          for (const b of r.querySelectorAll('.cloud-tool')) if (b._sync) b._sync();
        }
      }
    }

    for (const name of Object.keys(DOCK)) buildRow(name);

    // How many shorts the AI has made, on the AI Shorts button.
    const list = $('#veClipList');
    const count = $('#cloudDock [data-count]');
    if (list && count) {
      const sync = () => {
        const n = list.querySelectorAll('.ve-clip').length;
        count.textContent = String(n);
        count.classList.toggle('hidden', !n);
      };
      new MutationObserver(sync).observe(list, { childList: true });
      sync();
    }

    /* ---- sheets ------------------------------------------------------ */
    const head = document.createElement('div');
    head.id = 'cloudSheetHead';
    head.className = 'cloud-sheet-head';
    head.innerHTML = '<span class="cloud-sheet-title"></span>'
      + `<button type="button" class="cloud-sheet-act" data-press="#veExportAll">${mi('download')}Export all</button>`
      + `<button type="button" class="cloud-sheet-size" aria-label="Make the panel taller">${mi('expand')}</button>`
      + `<button type="button" class="cloud-sheet-done" aria-label="Done">${mi('check')}</button>`;
    document.body.appendChild(head);
    head.querySelector('.cloud-sheet-done').addEventListener('click', closeSheet);
    const exportAll = head.querySelector('.cloud-sheet-act');
    exportAll.addEventListener('click', () => { const t = $('#veExportAll'); if (t && !t.disabled) { closeSheet(); t.click(); } });
    mirror(exportAll, $('#veExportAll'), {});
    head.querySelector('.cloud-sheet-size').addEventListener('click', () => {
      const tall = document.body.classList.toggle('mw-sheet-tall');
      head.querySelector('.cloud-sheet-size').innerHTML = mi(tall ? 'shrink' : 'expand');
    });
    // Picking another tab inside the settings sheet retitles it.
    const tabs = $('#view-video .ve-insp-tabs');
    if (tabs) tabs.addEventListener('click', () => setTimeout(() => {
      if (document.body.classList.contains('mw-sheet-insp')) sheetTitle(inspTitle());
    }, 0));

    const xs = document.createElement('div');
    xs.id = 'cloudExportSheet';
    xs.className = 'cloud-export-sheet';
    xs.innerHTML = `
      <button type="button" class="cloud-xp-main" data-xp="shorts">${mi('sparkles')}<span>Export all shorts<small id="cloudXpShortsSub"></small></span></button>
      <button type="button" class="cloud-xp-main alt" data-xp="video">${mi('film')}<span>Export video<small id="cloudXpVideoSub"></small></span></button>
      <div class="cloud-xp-row"><span>Resolution</span><select id="cloudXpQuality" aria-label="Export resolution"></select></div>
      <div class="cloud-xp-row"><span>Frame rate</span><select data-mirror-sel="#veFps" aria-label="Frame rate"></select></div>
      <div class="cloud-xp-row"><span>Bitrate</span><select data-mirror-sel="#veBitrate" aria-label="Bitrate"></select></div>
      <div class="cloud-xp-ending" id="cloudXpEnding">
        <button type="button" class="cloud-xp-end-thumb" data-xp="ending-pick" aria-label="Choose the ending clip"><i></i></button>
        <button type="button" class="cloud-xp-end-text" data-xp="ending-pick"><b>Ending</b><small id="cloudXpEndSub">Add your outro to the end of every short</small></button>
        <label class="cloud-switch" aria-label="Add the ending to every short"><input type="checkbox" id="cloudXpEndOn" /><span></span></label>
      </div>
      <label class="cloud-xp-row"><span>Caption the shorts as they export</span><input type="checkbox" data-mirror="#veCapExports" /></label>
      <label class="cloud-xp-row"><span>Keep editing while it exports</span><input type="checkbox" data-mirror="#veBgExport" /></label>
      <button type="button" class="cloud-xp-link" data-xp="saved">Finished files — save them to this phone</button>
      <button type="button" class="cloud-xp-link" data-xp="more">More export settings</button>`;
    document.body.appendChild(xs);
    $('#cloudXpQuality').addEventListener('change', (e) => { setQuality(e.target.value); syncQualityPill(); });
    // Frame rate and bitrate: the desk's own selects, mirrored both ways
    for (const sel of xs.querySelectorAll('[data-mirror-sel]')) {
      sel.addEventListener('change', () => {
        const src = $(sel.dataset.mirrorSel);
        if (!src || src.value === sel.value) return;
        src.value = sel.value;
        src.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    for (const box of xs.querySelectorAll('[data-mirror]')) {
      box.addEventListener('change', () => {
        const src = $(box.dataset.mirror);
        if (!src || src.checked === box.checked) return;
        src.checked = box.checked;
        src.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    const endOn = $('#cloudXpEndOn');
    if (endOn) endOn.addEventListener('change', () => {
      const ed = window.VideoEditor;
      if (!ed || !ed.setOutroOn) return;
      if (ed.setOutroOn(endOn.checked) === false) endOn.checked = false;   // none yet: the library opened
      syncEnding();
    });
    // the clip library closing is the moment a new ending may have been chosen
    const lib = $('#libModal');
    if (lib && window.MutationObserver) new MutationObserver(() => { if (lib.classList.contains('hidden')) syncEnding(); })
      .observe(lib, { attributes: true, attributeFilter: ['class'] });
    xs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-xp]');
      if (!b || b.disabled) return;
      if (b.dataset.xp === 'ending-pick') { const ed = window.VideoEditor; if (ed && ed.chooseOutro) ed.chooseOutro(); return; }
      const go = { shorts: '#veExportAll', video: '#veExportEdited', saved: '#cloudDownloads' }[b.dataset.xp];
      if (b.dataset.xp === 'more') return openSheet('insp', { tab: '#veInspTabExport' });
      closeSheet();
      const el = $(go);
      if (el && !el.disabled) el.click();
    });

    /* ---- pinch the timeline to zoom it ------------------------------- */
    const tl = $('#veTimeline');
    if (tl) {

      /*
       * CapCut's ＋ sits at the END of the video row — you scroll right to the
       * last clip and there it is — not floating over the clips. It lives in
       * the sideways scroller, so it moves with the timeline, and follows the
       * row's end whenever the timeline is zoomed or a clip changes.
       */
      const scroller = $('#veTlScroll'), track = $('#veTrack');
      if (scroller && track) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'cloud-tl-add';
        add.setAttribute('aria-label', 'Add a video or picture');
        add.innerHTML = mi('plus');
        add.addEventListener('click', () => { const t = $('#veAddMedia'); if (t && !t.disabled) t.click(); });
        mirror(add, $('#veAddMedia'), {});
        scroller.appendChild(add);
        /*
         * Room for it that iOS counts: Safari does not scroll into a scroller's
         * padding or out to an absolutely placed child, so the timeline stopped
         * at the last clip with the ＋ just past the edge. A plain block this
         * wide is content every browser scrolls to.
         */
        const tail = document.createElement('div');
        tail.className = 'cloud-tl-tail';
        tail.setAttribute('aria-hidden', 'true');
        scroller.appendChild(tail);
        const place = () => {
          const main = Array.from(track.querySelectorAll('.ve-seg')).filter((n) => !n.classList.contains('ve-seg-ov'));
          const sr = scroller.getBoundingClientRect(), tr = track.getBoundingClientRect();
          let top = tr.bottom - 39, h = 36;
          if (main.length) { const r = main[0].getBoundingClientRect(); top = r.top; h = r.height; }
          const endX = Math.round(tr.right - sr.left + scroller.scrollLeft);
          add.style.left = (endX + 10) + 'px';
          tail.style.width = (endX + 56) + 'px';
          add.style.top = Math.round(top - sr.top + scroller.scrollTop + (h - 34) / 2) + 'px';
        };
        if (window.ResizeObserver) new ResizeObserver(() => requestAnimationFrame(place)).observe(track);
        new MutationObserver(() => requestAnimationFrame(place)).observe(track, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        setTimeout(place, 400);
      }

      /*
       * ►► PINCH TO ZOOM, SMOOTHLY. ◄◄
       * It used to press the − and + buttons each time the fingers had spread
       * by 20%: the timeline jumped in steps, about its middle, and lagged the
       * fingers. Now the zoom follows the spread continuously (once a frame),
       * the moment that was under the fingers stays under them, and moving
       * both fingers sideways pans — CapCut's feel.
       */
      let pinch = null, raf = 0;
      const span = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
      const midX = (ts) => (ts[0].clientX + ts[1].clientX) / 2;
      const ed = () => window.VideoEditor;
      tl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        // A first finger may have started a drag; a pinch is not one.
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const E = ed();
        if (!E || !E.zoomAround) return;
        const m = midX(e.touches);
        pinch = { d: Math.max(20, span(e.touches)), px: E.zoomLevel(), t: E.timeAtClientX(m), x: m, nd: 0 };
      }, { passive: true });
      tl.addEventListener('touchmove', (e) => {
        if (!pinch || e.touches.length !== 2) return;
        e.preventDefault();
        pinch.nd = span(e.touches);
        pinch.x = midX(e.touches);
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!pinch) return;
          const E = ed();
          if (E && E.zoomAround) E.zoomAround(pinch.px * (pinch.nd / pinch.d), pinch.t, pinch.x);
        });
      }, { passive: false });
      const done = (e) => { if (e.touches.length < 2) pinch = null; };
      tl.addEventListener('touchend', done);
      tl.addEventListener('touchcancel', done);
      // iOS zooms the whole page on a pinch unless told not to.
      tl.addEventListener('gesturestart', (e) => e.preventDefault());
      // Lanes below the fold (text, captions, sound, music): fade the bottom
      // edge so it is plain there is more to scroll to.
      const more = () => tl.classList.toggle('cloud-tl-more', tl.scrollTop + tl.clientHeight < tl.scrollHeight - 4);
      tl.addEventListener('scroll', more, { passive: true });
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(more);
        ro.observe(tl);
        const inner = $('#veTlScroll') || tl.firstElementChild;
        if (inner) ro.observe(inner);
      }
      setTimeout(more, 500);

      /*
       * ►► THE TIMELINE ENDS WHERE THE TOOLS BEGIN. ◄◄
       * On an iPhone the bottom ~58pt of the timeline sat BEHIND the dock (the
       * window iOS gives a home-screen app is not the one CSS was told about),
       * so the last lane — the music — was in that hidden strip: scrolled to
       * the end it was still under the tools, and the finger bounced back. So
       * the real positions are measured and the timeline is made to stop at the
       * dock; if it would get too short, its lanes get room to scroll up instead.
       */
      let fitting = false;
      const fitTl = () => {
        if (fitting || !document.body.classList.contains('mw-cloud')) return;
        const dock = $('#cloudDock'), view = $('#view-video');
        if (!dock || !view || !tl.offsetParent) return;
        fitting = true;
        view.style.paddingBottom = '';
        const vr = view.getBoundingClientRect();
        const pb = parseFloat(getComputedStyle(view).paddingBottom) || 0;
        const vv = window.visualViewport;
        const limit = Math.min(dock.getBoundingClientRect().top, vv ? vv.offsetTop + vv.height : window.innerHeight);
        // the studio's content ends where its padding starts; it must end at the dock
        const over = Math.ceil((vr.bottom - pb) - limit);
        if (over > 1) view.style.paddingBottom = (pb + over) + 'px';
        fitting = false;
        more();
      };
      cloud.fitTimeline = fitTl;
      window.addEventListener('resize', fitTl);
      window.addEventListener('orientationchange', () => setTimeout(fitTl, 350));
      if (window.visualViewport) window.visualViewport.addEventListener('resize', fitTl);
      if (window.ResizeObserver) {
        const ro2 = new ResizeObserver(() => requestAnimationFrame(fitTl));
        const dockEl = $('#cloudDock'), viewEl = $('#view-video');
        for (const el of [dockEl, viewEl]) if (el) ro2.observe(el);
      }
      setTimeout(fitTl, 300); setTimeout(fitTl, 1500);
    }
  }

  /**
   * Keep a phone tool in step with the desk button it presses: greyed out when
   * that is, gone when that is hidden, lit when that is switched on.
   */
  function mirror(tool, target, { on } = {}) {
    if (!tool) return;
    if (!target) { tool.classList.add('cloud-tool-hidden'); tool.disabled = true; return; }
    const sync = () => {
      tool.disabled = !!target.disabled;
      tool.classList.toggle('cloud-tool-hidden', target.classList.contains('hidden'));
      if (on) tool.classList.toggle('on', target.classList.contains('on'));
    };
    new MutationObserver(sync).observe(target, { attributes: true, attributeFilter: ['disabled', 'class'] });
    tool._sync = sync;
    sync();
  }

  /* -------------------------------------------------------------- panels */

  /*
   * A SHEET THAT CAN COVER ANYTHING. The studio's own sheets live inside the
   * editor's layout (they take the timeline's place), so they cannot come up
   * over the home screen or the scheduler. These can: a sheet on its own dimmed
   * backdrop, the way an iPhone brings up a share sheet, that you pull down by
   * its grabber to put away. On a wide screen it is a card in the middle.
   */
  const CLOSE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  const panels = [];
  function openPanel(o = {}) {
    if (o.id) closePanel(o.id, true);
    const scrim = document.createElement('div');
    scrim.className = 'cp-scrim';
    const el = document.createElement('section');
    el.className = 'cp-panel' + (o.cls ? ' ' + o.cls : '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    if (o.id) el.id = o.id;
    el.innerHTML = '<header class="cp-head"><span class="cp-grab" aria-hidden="true"></span><h2 class="cp-title"></h2>'
      + `<button type="button" class="cp-x" aria-label="Close">${CLOSE_SVG}</button></header>`
      + '<div class="cp-body"></div><footer class="cp-foot"></footer>';
    const z = 330 + panels.length * 4;
    scrim.style.zIndex = String(z);
    el.style.zIndex = String(z + 1);
    document.body.append(scrim, el);
    const p = {
      id: o.id || '', el, scrim, onClose: o.onClose,
      head: el.querySelector('.cp-head'), body: el.querySelector('.cp-body'), foot: el.querySelector('.cp-foot'),
      setTitle(t) { el.querySelector('.cp-title').textContent = t || ''; },
      close() { closePanel(p); },
    };
    p.setTitle(o.title);
    panels.push(p);
    document.body.classList.add('mw-panel');
    requestAnimationFrame(() => requestAnimationFrame(() => { scrim.classList.add('on'); el.classList.add('on'); }));
    scrim.addEventListener('click', () => p.close());
    el.querySelector('.cp-x').addEventListener('click', () => p.close());
    // Pull it down by the top to put it away.
    let y0 = null, dy = 0;
    p.head.addEventListener('touchstart', (e) => {
      // (a sheet only on a phone — on a wide screen it is a card that stays put)
      if (e.target.closest('button') || !window.matchMedia('(max-width: 900px)').matches) return;
      y0 = e.touches[0].clientY; dy = 0; el.style.transition = 'none';
    }, { passive: true });
    p.head.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      el.style.transform = `translateY(${dy}px)`;
    }, { passive: true });
    const end = () => {
      if (y0 == null) return;
      y0 = null; el.style.transition = ''; el.style.transform = '';
      if (dy > 90) p.close();
    };
    p.head.addEventListener('touchend', end);
    p.head.addEventListener('touchcancel', end);
    return p;
  }
  function closePanel(which, instant) {
    const p = typeof which === 'string' ? panels.find((x) => x.id === which) : which;
    if (!p || panels.indexOf(p) < 0) return;
    panels.splice(panels.indexOf(p), 1);
    if (!panels.length) document.body.classList.remove('mw-panel');
    p.el.classList.remove('on');
    p.scrim.classList.remove('on');
    if (instant) { p.el.remove(); p.scrim.remove(); }
    else setTimeout(() => { p.el.remove(); p.scrim.remove(); }, 300);
    if (p.onClose) { try { p.onClose(); } catch (e) {} }
  }
  const panelOf = (id) => panels.find((p) => p.id === id) || null;

  /*
   * AN iPHONE THAT GIVES THE APP A SHORT SCREEN.
   *
   * iOS 26 has a bug (WebKit 301108): a home-screen app with the see-through
   * ("black-translucent") status bar is drawn from the top of the screen but
   * given a window one status bar SHORTER than the screen, and the strip left
   * at the bottom is outside the web view. Nothing can be drawn there. This
   * used to stretch the page over the whole screen to reach it. That only
   * pushed the dock into the strip, where iOS cut it off halfway down the
   * icons (a church's own screenshot: 932 points of screen, nothing drawn
   * below 873).
   *
   * The cure is in page.js: the status bar is now opaque black, which gives
   * the app the whole screen down to the bottom edge. iOS reads that setting
   * only when the app is ADDED to the home screen, though. So an install made
   * before it still has the short window, and that is all this does now: it
   * notices one (short by the status bar's height, on a home-screen iPhone),
   * keeps the dock tight to the bottom the app is given (html.mw-vpshort in
   * cloud.css; the home bar is down in the dead strip anyway), and says once
   * how to get the full screen back. Anything else is left exactly as it was.
   */
  const vpFix = {
    probe: null,
    on: false,
    /** How far short the window is, from what was measured; 0 for "it is not". */
    judge({ standalone, ios, portrait, screenW, screenH, bottomAt, safeTop }) {
      if (!standalone || !ios || !screenW || !screenH) return 0;
      const full = portrait ? Math.max(screenW, screenH) : Math.min(screenW, screenH);
      const gap = Math.round(full - bottomAt);
      return gap >= 20 && gap <= 80 && Math.abs(gap - safeTop) <= 8 ? gap : 0;
    },
    measure() {
      if (!this.probe) {
        this.probe = document.createElement('div');
        this.probe.setAttribute('aria-hidden', 'true');
        this.probe.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:env(safe-area-inset-top);'
          + 'visibility:hidden;pointer-events:none;z-index:-1';
        document.documentElement.appendChild(this.probe);
      }
      const r = this.probe.getBoundingClientRect();
      return {
        standalone: navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches,
        ios: /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
        portrait: window.matchMedia('(orientation: portrait)').matches,
        screenW: window.screen.width,
        screenH: window.screen.height,
        bottomAt: r.bottom,
        safeTop: r.height,
      };
    },
    apply(gap) {
      const on = gap > 0;
      document.documentElement.classList.toggle('mw-vpshort', on);
      if (on !== this.on) {
        this.on = on;
        // the studio measures itself off the room it has
        setTimeout(() => { try { if (window.VideoEditor && window.VideoEditor.fit) window.VideoEditor.fit(); } catch (e) {} }, 60);
        if (on) this.advise();
      }
      return on;
    },
    /** Once a day at most, and only once someone is in: how to get the whole screen. */
    advise() {
      if (this.advised) return;
      this.advised = true;
      let seen = '';
      const today = new Date().toDateString();
      try { seen = localStorage.getItem('mw-vpshort-advised') || ''; } catch (e) {}
      if (seen === today) return;
      const tell = () => {
        if (!cloud.started) { setTimeout(tell, 2000); return; }
        try { localStorage.setItem('mw-vpshort-advised', today); } catch (e) {}
        island({
          id: 'vpshort', kind: 'info', ms: 14000,
          title: 'Re-add the app for the full screen',
          sub: 'Your iPhone is leaving a strip at the bottom. Remove Church Work Space from your Home Screen, then add it again from Safari (Share → Add to Home Screen) and the tools sit on the bottom edge.',
        });
      };
      setTimeout(tell, 2500);
    },
    /** For the tests: hold a measurement, as a phone with the fault would give it (null lets go). */
    pin(gap) { this.pinned = gap == null ? null : { gap }; return this.check(); },
    check() {
      if (this.pinned) return this.apply(this.pinned.gap);
      return this.apply(this.judge(this.measure()));
    },
  };
  cloud.vpFix = vpFix;
  {
    let t = null;
    const recheck = () => { clearTimeout(t); t = setTimeout(() => { try { vpFix.check(); } catch (e) {} }, 120); };
    try { vpFix.check(); } catch (e) {}
    // iOS settles the viewport a moment after launch, and again after a turn
    for (const ms of [400, 1200, 3000]) setTimeout(recheck, ms);
    window.addEventListener('resize', recheck);
    window.addEventListener('orientationchange', recheck);
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) recheck(); });
  }

  /*
   * The keyboard. A sheet sits on the bottom of the screen, which is exactly
   * where an iPhone's keyboard comes up — over the caption being typed. The
   * visual viewport says how much of the screen the keyboard has taken, and the
   * sheets stand on top of it (--kb in cloud.css).
   */
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onKb = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty('--kb', (kb > 90 ? kb : 0) + 'px');
      // …and whether it is up at all, for layouts that make room while it is
      // (the captions window gives its lines the space)
      document.documentElement.classList.toggle('mw-kb', kb > 90);
    };
    vv.addEventListener('resize', onKb);
    vv.addEventListener('scroll', onKb);
  }

  /* ----------------------------------------------------- background jobs */

  /*
   * WHAT IS RUNNING, WHERE A THUMB CAN REACH IT.
   *
   * On the desk the background exports sit in a box in the corner. On a phone
   * that box was behind the tool dock and the sheets — "1 job running in the
   * background", in grey, half hidden — and there was nothing to tap.
   *
   * So the phone gets three things, all fed by tasks.js's own list:
   *   • a live chip in the top bar: a ring that fills, the percentage, and how
   *     many are running. Green with a tick when something has finished;
   *   • a thin purple line along the bottom of the top bar, the same number;
   *   • tap the chip and the jobs sheet comes up: every export with its step,
   *     its bar, how long it has been going and roughly how long is left, and
   *     Stop — and once it is done, its files, to save to this phone or to
   *     schedule as posts.
   *
   * A finished job stays on the sheet for the session; the desk's corner lets
   * them go after a minute, but somebody who walked away has to find it there.
   */
  const jobs = { history: new Map(), last: new Map(), unseen: new Set(), sig: '', timer: null };
  window.__bgPlace = () => (window.matchMedia('(max-width: 900px)').matches ? 'the jobs pill at the top' : 'the corner');
  const baseName = (p) => String(p || '').split(/[\\/]/).pop();
  const jobTitle = (t) => toastText(t.title || 'Export').replace(/[“”"]/g, '"');
  /** "3 of 20" → { i: 3, n: 20 }. */
  const batchOf = (t) => { const m = /(\d+)\s*of\s*(\d+)/.exec(t.batch || ''); return m ? { i: +m[1], n: +m[2] } : null; };
  /** The whole job's progress — for a batch, the whole batch, not this short. */
  function overallPct(t) {
    if (t.state !== 'run') return t.state === 'done' ? 100 : t.percent;
    const b = batchOf(t);
    return b && b.n > 1 ? Math.min(99, ((b.i - 1) + t.percent / 100) / b.n * 100) : t.percent;
  }
  const clockOf = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  };
  function etaOf(t) {
    const pc = overallPct(t), ran = Date.now() - t.at;
    if (t.state !== 'run' || pc < 3 || ran < 8000) return '';
    const left = ran * (100 - pc) / pc;
    if (left < 60000) return 'less than a minute left';
    const min = Math.round(left / 60000);
    return min < 90 ? `about ${min} min left` : `about ${Math.floor(min / 60)} h ${min % 60} min left`;
  }
  const agoOf = (at) => {
    const s = Math.round((Date.now() - at) / 1000);
    return s < 45 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
  };

  function jobList() {
    const live = window.__tasksList ? window.__tasksList() : [];
    const ids = new Set(live.map((t) => t.id));
    for (const t of live) jobs.history.set(t.id, t);
    // a running job that is no longer listed was cleared; a finished one stays
    for (const [id, t] of jobs.history) if (!ids.has(id) && t.state === 'run') jobs.history.delete(id);
    return Array.from(jobs.history.values()).sort((a, b) =>
      ((b.state === 'run') - (a.state === 'run')) || ((b.endedAt || b.at) - (a.endedAt || a.at)));
  }

  function jobFinished(t) {
    jobs.unseen.add(t.id);
    // "Done" on the chip is news, not a fixture: it lets itself go after a while.
    setTimeout(() => { if (jobs.unseen.delete(t.id)) renderJobChips(jobList()); }, 5 * 60000);
    // Every file it made goes on the Saved list as well: nothing finished is
    // ever further than one tap away.
    for (const f of t.files || []) {
      if (!cloud.downloads.some((d) => d.path === f)) cloud.downloads.unshift({ path: f, name: baseName(f), at: Date.now() });
    }
    renderDownloadCount();
    const n = (t.files || []).length;
    const view = { label: 'View', onClick: openJobsSheet };
    if (t.state === 'done') {
      island({ kind: 'good', title: n > 1 ? `${n} videos ready` : 'Export finished', sub: jobTitle(t), action: view, ms: 8000, id: 'job-' + t.id });
    } else if (t.state === 'fail') {
      island({ kind: 'error', title: 'An export stopped', sub: toastText(t.step) || jobTitle(t), action: view, ms: 10000, id: 'job-' + t.id });
    } else {
      island({ kind: 'info', title: 'Stopped', sub: jobTitle(t), ms: 3500 });
    }
  }

  function onJobsChanged() {
    const list = jobList();
    for (const t of list) {
      const was = jobs.last.get(t.id);
      if (was === 'run' && t.state !== 'run') jobFinished(t);
      if (!was && t.state === 'run') jobs.fresh = t.id;
      jobs.last.set(t.id, t.state);
    }
    renderJobChips(list);
    if (panelOf('cloudJobs')) renderJobsSheet(list);
    for (const fn of cloud.jobListeners) { try { fn(list); } catch (e) {} }
  }

  const RING = (r, cls) => `<svg viewBox="0 0 ${r * 2 + 6} ${r * 2 + 6}" class="${cls}" aria-hidden="true">`
    + `<circle class="rt" cx="${r + 3}" cy="${r + 3}" r="${r}"/><circle class="rf" cx="${r + 3}" cy="${r + 3}" r="${r}" pathLength="100" stroke-dasharray="0 100"/></svg>`;
  const TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" class="cj-tick" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const BANG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" class="cj-bang" aria-hidden="true"><path d="M12 6.5v7"/><path d="M12 17.5v.1"/></svg>';

  /** A jobs chip, for whichever bar wants one. It keeps itself up to date. */
  function makeJobChip() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cloud-jobchip hidden';
    b.innerHTML = `<span class="cj-ic">${RING(7.5, 'cj-ring')}${TICK}${BANG}</span><span class="cj-tx"></span><span class="cj-n"></span>`;
    b.addEventListener('click', openJobsSheet);
    requestAnimationFrame(() => renderJobChips(jobList()));
    return b;
  }
  function renderJobChips(list) {
    const run = list.filter((t) => t.state === 'run');
    const failed = list.some((t) => t.state === 'fail' && jobs.unseen.has(t.id));
    const done = list.some((t) => t.state === 'done' && jobs.unseen.has(t.id));
    const pct = run.length ? Math.round(run.reduce((n, t) => n + overallPct(t), 0) / run.length) : 0;
    const state = run.length ? 'run' : failed ? 'fail' : done ? 'done' : '';
    const label = state === 'run' ? `${run.length} running, ${pct}% — tap to see them`
      : state === 'done' ? 'Finished — tap to see it' : state === 'fail' ? 'An export stopped — tap to see why' : 'Background jobs';
    for (const chip of $$('.cloud-jobchip')) {
      const was = chip.dataset.state || '';
      chip.dataset.state = state;
      chip.classList.toggle('hidden', !state);
      // a job just started, or just finished: say so with a little bounce
      if (state && (state !== was || jobs.fresh)) { chip.classList.remove('cj-pop'); void chip.offsetWidth; chip.classList.add('cj-pop'); }
      const ring = chip.querySelector('.rf');
      if (ring) ring.setAttribute('stroke-dasharray', `${Math.max(3, pct)} 100`);
      chip.querySelector('.cj-tx').textContent = state === 'run' ? pct + '%' : state === 'done' ? 'Done' : state === 'fail' ? 'Stopped' : '';
      chip.querySelector('.cj-n').textContent = run.length > 1 ? String(run.length) : '';
      chip.setAttribute('aria-label', label);
      chip.title = label;
    }
    jobs.fresh = null;
    const line = $('#cloudBarProgress');
    if (line) {
      line.classList.toggle('on', !!run.length);
      line.style.transform = `scaleX(${run.length ? Math.max(0.02, pct / 100) : 0})`;
    }
  }

  function openJobsSheet() {
    const list = jobList();
    for (const t of list) jobs.unseen.delete(t.id);
    renderJobChips(list);
    const p = openPanel({
      id: 'cloudJobs', title: 'Background jobs', cls: 'cp-jobs',
      onClose: () => { clearInterval(jobs.timer); jobs.timer = null; jobs.sig = ''; },
    });
    p.body.addEventListener('click', onJobsClick);
    p.foot.innerHTML = `<button type="button" class="cp-link" data-jobs="saved">${mi('download')}Everything finished this session</button>`
      + '<small class="cj-server" id="cjServer"></small>';
    // What the exports are running on — the one number that explains their speed.
    call('machine:info').then((m) => {
      const el = $('#cjServer'); if (!el || !m) return;
      const cpu = m.quota ? (m.quota >= 1 ? `${Math.round(m.quota * 10) / 10} CPU` : `${Math.round(m.quota * 100) / 100} of a CPU`) : `${m.cpus} CPU${m.cpus > 1 ? 's' : ''}`;
      const slow = m.quota && m.quota < 1;
      el.innerHTML = `Server: ${escHtml(cpu)} · ${escHtml(String(Math.round(m.memoryMB)))} MB`
        + (slow ? '<br>A 90-second 1080p short takes several minutes on this — a bigger server plan makes every export faster.' : '');
    }).catch(() => {});
    p.foot.addEventListener('click', (e) => {
      if (!e.target.closest('[data-jobs="saved"]')) return;
      p.close();
      const b = $('#cloudDownloads'); if (b) b.click();
    });
    jobs.sig = '';
    renderJobsSheet(list);
    clearInterval(jobs.timer);
    jobs.timer = setInterval(() => paintJobs(jobList()), 1000);
  }
  window.__openJobs = openJobsSheet;

  const jobSig = (list) => list.map((t) => `${t.id}:${t.state}:${(t.files || []).length}`).join('|');
  function renderJobsSheet(list) {
    const p = panelOf('cloudJobs'); if (!p) return;
    const sig = jobSig(list);
    if (sig === jobs.sig) { paintJobs(list); return; }
    jobs.sig = sig;
    const run = list.filter((t) => t.state === 'run').length;
    p.setTitle(run ? `Running now · ${run}` : 'Background jobs');
    const canSchedule = !!(window.MWSocial && window.MWSocial.compose);
    if (!list.length) {
      p.body.innerHTML = `<div class="cj-empty"><div class="cj-empty-art">${mi('layers')}</div><b>Nothing running</b>`
        + '<p>Exports you send to the background show up here with their progress. To send every export here, switch on '
        + '<em>Keep editing while it exports</em> in Export.</p></div>';
      return;
    }
    p.body.innerHTML = list.map((t) => {
      const id = escAttr(t.id);
      if (t.state === 'run') {
        return `<article class="cj-card run" data-id="${id}">`
          + `<div class="cj-row"><div class="cj-big">${RING(19, 'cj-ring-lg')}<b class="cj-pc"></b></div>`
          + `<div class="cj-main"><div class="cj-title">${escHtml(jobTitle(t))}</div><div class="cj-step"></div></div></div>`
          + '<div class="cj-bar"><i></i></div>'
          + '<div class="cj-meta"><span class="cj-time"></span><span class="cj-eta"></span></div>'
          + `<div class="cj-btns"><button type="button" class="cj-btn danger" data-stop="${id}">${mi('stop')}Stop</button></div>`
          + '</article>';
      }
      const files = t.files || [];
      const ok = t.state === 'done';
      const fileRows = files.map((f) => `<li><span class="cj-fname">${mi('film')}<span>${escHtml(baseName(f))}</span></span>`
        + `<button type="button" class="cj-mini" data-save="${escAttr(f)}">${mi('download')}Save</button>`
        + (canSchedule ? `<button type="button" class="cj-mini accent" data-sched="${escAttr(f)}">${mi('calendar')}Post</button>` : '')
        + '</li>').join('');
      return `<article class="cj-card ${ok ? 'done' : t.state === 'fail' ? 'fail' : 'stopped'}" data-id="${id}">`
        + `<div class="cj-row"><span class="cj-badge">${ok ? TICK : BANG}</span>`
        + `<div class="cj-main"><div class="cj-title">${escHtml(jobTitle(t))}</div>`
        + `<div class="cj-step">${escHtml(toastText(t.step) || (ok ? 'Finished.' : 'Stopped.'))}</div></div>`
        + `<button type="button" class="cj-x" data-clear="${id}" aria-label="Clear">${CLOSE_SVG}</button></div>`
        + (fileRows ? `<ul class="cj-files">${fileRows}</ul>` : '')
        + (canSchedule && files.length > 1 ? `<div class="cj-btns"><button type="button" class="cj-btn accent" data-sched-all="${id}">${mi('calendar')}Schedule all ${files.length} as posts</button></div>` : '')
        + `<div class="cj-meta"><span>${ok ? 'Finished' : 'Ended'} ${agoOf(t.endedAt || t.at)}</span>${t.endedAt ? `<span>took ${clockOf(t.endedAt - t.at)}</span>` : ''}</div>`
        + '</article>';
    }).join('');
    paintJobs(list);
  }
  /** Move the numbers where they already are — never rebuild under a finger. */
  function paintJobs(list) {
    const p = panelOf('cloudJobs'); if (!p) return;
    if (jobSig(list) !== jobs.sig) { renderJobsSheet(list); return; }
    for (const t of list) {
      if (t.state !== 'run') continue;
      const card = p.body.querySelector(`.cj-card[data-id="${CSS.escape(t.id)}"]`);
      if (!card) continue;
      const pc = Math.round(overallPct(t));
      card.querySelector('.cj-pc').textContent = pc + '%';
      card.querySelector('.rf').setAttribute('stroke-dasharray', `${Math.max(2, pc)} 100`);
      card.querySelector('.cj-bar i').style.width = Math.max(2, pc) + '%';
      const b = batchOf(t);
      const step = toastText(t.step) || 'Starting…';
      card.querySelector('.cj-step').textContent = b && b.n > 1 ? `Short ${b.i} of ${b.n} · ${t.percent}% · ${step}` : step;
      card.querySelector('.cj-time').textContent = 'Running ' + clockOf(Date.now() - t.at);
      card.querySelector('.cj-eta').textContent = etaOf(t);
    }
  }
  async function onJobsClick(e) {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.stop) {
      b.disabled = true;
      b.innerHTML = `${mi('stop')}Stopping…`;
      if (window.__taskStop) await window.__taskStop(b.dataset.stop);
      return;
    }
    if (b.dataset.clear) {
      if (window.__taskClear) window.__taskClear(b.dataset.clear);
      jobs.history.delete(b.dataset.clear);
      onJobsChanged();
      return;
    }
    if (b.dataset.save) { offerDownload(b.dataset.save); return; }
    if (b.dataset.sched) { closePanel('cloudJobs'); window.MWSocial.compose({ files: [b.dataset.sched] }); return; }
    if (b.dataset.schedAll) {
      const t = jobs.history.get(b.dataset.schedAll);
      if (t) { closePanel('cloudJobs'); window.MWSocial.compose({ files: (t.files || []).slice() }); }
    }
  }

  function installJobs() {
    if (cloud.jobsInstalled) return;
    cloud.jobsInstalled = true;
    const bar = $('#cloudBar');
    if (bar) {
      const actions = $('#cloudBar .cloud-bar-actions') || bar;
      const chip = makeJobChip();
      chip.id = 'cloudJobsChip';
      actions.insertBefore(chip, actions.firstChild);
      const line = document.createElement('div');
      line.id = 'cloudBarProgress';
      line.className = 'cloud-bar-progress';
      bar.appendChild(line);
    }
    if (window.__onTasks) window.__onTasks(onJobsChanged);
    onJobsChanged();
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
      signIn($('#cloudRemember').checked);
    });
    on('#cloudGateTabs', 'click', (e) => { const t = e.target.closest('[data-gmode]'); if (t) setGateMode(t.dataset.gmode); });
    on('#cloudFiles', 'click', () => openFilesModal());
    on('#cloudFilesClose', 'click', closeFilesModal);
    on('#cloudFilesRefresh', 'click', () => refreshFiles());
    on('#cloudFilesList', 'click', onFilesClick);
    on('#cloudFilesSelect', 'click', () => setSelecting(!filesUi.selecting));
    on('#cloudFilesSelDelete', 'click', onSelDelete);
    on('#cloudDownloadsList', 'click', (e) => {
      const b = e.target.closest('[data-act]'); const row = b && b.closest('.cf-row');
      if (!row) return;
      if (b.dataset.act === 'view') viewFile(row.dataset.path); else offerDownload(row.dataset.path);
    });
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

    // The icon set first: the home screen draws with it.
    if (window.MWIcons) window.MWIcons.mount([]);
    addPhoneIcons();
    // The home screen comes up at once, before the studio behind it has
    // finished waking — nobody should see the editor flash past on the way.
    if (window.MWSocial) { try { window.MWSocial.start(cloud.hello); } catch (e) { console.error(e); } }

    connectEvents();
    setTimeout(wireServerBatches, 1200);

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
    installPhoneEditor();
    installJobs();
    watchForUpdates();

    try {
      const hello = await fetch('/api/hello', { headers: authHeaders() }).then((r) => r.json());
      cloud.hello = Object.assign(cloud.hello || {}, hello);
      const where = $('#cloudWhere');
      if (where) where.textContent = hello.standalone ? 'on the server' : 'on the studio PC';
    } catch (e) { /* the studio still works; the label is decoration */ }
  }

  /* ------------------------------------------------------------- updates */

  /*
   * A NEW VERSION, ON A PHONE THAT NEVER RELOADS.
   *
   * An app on an iPhone's home screen is not reopened, it is RESUMED: iOS keeps
   * the page alive for days, so a fix deployed on Sunday was still not on the
   * phone on Wednesday — the screenshot showed last week's messages. So the page
   * asks the server which build it is serving whenever it comes back to the
   * front (and every ten minutes while it is open), and when that is not the
   * build this page was made from, the island offers to refresh.
   *
   * Never in the middle of an export: the chain of passes is driven from this
   * page, and reloading it would leave the captions and the outro undone. The
   * offer waits for the jobs to finish.
   */
  let updateAt = 0;
  async function checkForUpdate(force) {
    if (!myVersion || document.hidden) return;
    if (!force && Date.now() - updateAt < 45000) return;
    updateAt = Date.now();
    let h = null;
    try { h = await fetch('/api/hello', { cache: 'no-store', headers: authHeaders() }).then((r) => r.json()); }
    catch (e) { return; }
    const build = h && h.build;
    if (!build || build === myVersion) return;
    cloud.updateBuild = build;
    offerUpdate();
  }
  function offerUpdate() {
    if (!cloud.updateBuild) return;
    const overlay = $('#overlay');
    const busy = jobList().some((t) => t.state === 'run') || (overlay && !overlay.classList.contains('hidden'));
    if (busy) { cloud.updateWaiting = true; return; }      // asked again when the jobs are done
    cloud.updateWaiting = false;
    island({
      id: 'update', kind: 'info', sticky: true,
      title: 'A new version is ready',
      sub: 'Refresh to start using it — your edit is kept.',
      action: { label: 'Refresh', onClick: refreshForUpdate },
    });
  }
  async function refreshForUpdate() {
    island({ id: 'update', kind: 'info', sticky: true, spin: true, title: 'Updating…' });
    try { if (window.VideoEditor && window.VideoEditor.flushSession) await window.VideoEditor.flushSession(); } catch (e) {}
    location.reload();
  }
  function watchForUpdates() {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
    window.addEventListener('focus', () => checkForUpdate());
    window.addEventListener('pageshow', () => checkForUpdate());
    setInterval(() => checkForUpdate(true), 10 * 60 * 1000);
    // the jobs that held the offer back have finished
    cloud.jobListeners.push((list) => {
      if (cloud.updateWaiting && !list.some((t) => t.state === 'run')) setTimeout(offerUpdate, 2500);
    });
    setTimeout(() => checkForUpdate(true), 4000);
  }
  cloud.checkForUpdate = checkForUpdate;

  /* Server batches: their progress, Stop, and picking them up again after the
     app was closed (see showServerBatch). */
  function wireServerBatches() {
    if (cloud._batchWired) return;
    cloud._batchWired = true;
    cloud.onEvent('batch:progress', (b) => showServerBatch(b));
    const stop = window.__taskStop;
    if (stop) {
      window.__taskStop = async (taskId) => {
        for (const [bid, tid] of serverTasks) {
          if (tid === taskId) { try { await window.__mwBatch.cancel(bid); } catch (e) {} return true; }
        }
        return stop(taskId);
      };
    }
    const pick = async () => {
      try { for (const b of (await window.__mwBatch.list()) || []) if (b.state === 'running' || serverTasks.has(b.id)) showServerBatch(b); } catch (e) {}
    };
    pick();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pick(); });
  }
  cloud.wireServerBatches = wireServerBatches;

  /* What the home screen and the scheduler (cloud-social.js) borrow from here. */
  Object.assign(cloud, {
    call, island, islandHide, toast, toastText, openPanel, closePanel, panelOf,
    offerDownload, pickFiles, chooseFromDevice, refreshFiles, downloadUrl,
    mi, esc: escHtml, escAttr, jobChip: makeJobChip, jobList, jobPct: overallPct, openJobs: openJobsSheet,
    authHeaders, fileUrl: (p) => window.MW_FILE_URL(p), viewFile, openProfile, uploadFile,
  });

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
    cloud.hello = hello;

    cloud.me = (hello && hello.me) || null;
    if (hello && hello.signedIn) {
      $('#cloudGate').classList.add('gone');
      await startStudio();
    } else {
      // no spaces yet: the first one is made here, and it is the owner's
      setGateMode(hello && hello.accounts === 0 ? 'create' : 'signin', !!hello && hello.accounts === 0);
      try { const n = localStorage.getItem(NAME_KEY); if (n && $('#cloudName')) $('#cloudName').value = n; } catch (e) {}
      if (!hello) {
        const msg = $('#cloudGateMsg');
        if (msg) { msg.textContent = 'Cannot reach the studio machine. Is it switched on?'; msg.className = 'cloud-gate-msg bad'; }
      }
      const pass = $('#cloudName') && $('#cloudName').value ? $('#cloudPw') : $('#cloudName');
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
