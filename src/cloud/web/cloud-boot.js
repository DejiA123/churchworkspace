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
    const seenBin = new Map();   // the same picture used by many caption frames travels once
    const swap = (v, d) => {
      if (d > 12 || v == null) return v;
      if (isBinary(v)) {
        if (seenBin.has(v)) return { __bin: seenBin.get(v) };
        bins.push(v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        seenBin.set(v, bins.length - 1);
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
    // remembered: a batch started from THIS phone brings its shorts down to it (showServerBatch)
    open: (label, total) => call('batch:open', { label, total }).then((b) => { if (b && b.id) ownBatch(b.id); return b; }),
    add: (id, label, steps) => call('batch:add', { id, label, steps }),
    seal: (id) => call('batch:seal', { id }),
    list: () => call('batch:list', {}),
    cancel: (id) => call('batch:cancel', { id }),
  };

  /*
   * ►► EXPORT ALL ENDS ON THE PHONE TOO. ◄◄
   * A batch started from this phone, finishing while the app is open, brings
   * every short down by itself as the last part of the batch's own number
   * (the export is the first 100 - SAVE_SHARE of it, the shorts coming down
   * the rest), and ends on ONE tap: "N shorts on your phone · Save all". The
   * download needs no tap — only the share sheet does. Measured: a short's
   * download is ~25 units of work against 150-190 for making it, so 15%.
   *
   * Which batches are this phone's is remembered on the phone (the last 20).
   * A batch from another phone, or one that finishes while this app is in the
   * background (iOS stops a download there), ends as before: "N shorts ready
   * · Save all", which fetches them when tapped.
   */
  const OWN_BATCHES_KEY = 'mw.cloud.ownBatches';
  const SAVE_SHARE = 15;
  const batchSaving = new Map();   // taskId -> 'export' | 'save'
  const batchStops = new Map();    // taskId -> stop the bringing-down
  function ownBatches() {
    try { const v = JSON.parse(localStorage.getItem(OWN_BATCHES_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function ownBatch(id) {
    try { localStorage.setItem(OWN_BATCHES_KEY, JSON.stringify(ownBatches().filter((x) => x !== id).concat(id).slice(-20))); } catch (e) {}
  }
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
      if (canSaveHere() && ownBatches().includes(b.id)) batchSaving.set(tid, 'export');
    }
    const left = b.total - b.done - b.failed;
    if (window.__setTaskBatch) window.__setTaskBatch(tid, Math.min(b.total, b.done + b.failed + 1), b.total);
    for (const it of b.items || []) if (it.state === 'done' && it.output && window.__taskAddFile) window.__taskAddFile(tid, it.output);
    if (b.state === 'running') {
      const cur = b.current;
      const step = cur ? `On the server · ${cur.label}` : (b.received < b.total ? `Preparing on your phone… ${b.received} of ${b.total} sent — keep the app open until all are sent` : 'Queued on the server');
      if (window.__taskSay) window.__taskSay(tid, step + (b.sealed ? ' — you can close the app' : ''));
      // the chip's number is THIS short's, as for every export; "1 of 20" beside it is the batch
      if (window.__taskProgress) window.__taskProgress(tid, cur ? cur.pct : 0);
      return;
    }
    serverTasks.delete(b.id);
    const outs0 = (b.items || []).filter((it) => it.state === 'done' && it.output).map((it) => it.output);
    if (b.state === 'done' && outs0.length && batchSaving.has(tid) && document.visibilityState === 'visible' && canSaveHere()) {
      bringBatchDown(b, tid, outs0);
      return;
    }
    batchSaving.delete(tid);
    const note = b.state === 'cancelled' ? 'Stopped.'
      : `✅ ${b.done} short${b.done === 1 ? '' : 's'} exported on the server${b.failed ? ` · ${b.failed} could not be made` : ''}.`;
    if (window.__endTask) window.__endTask(tid, { ok: b.state !== 'cancelled' && b.done > 0, state: b.state === 'cancelled' ? 'stopped' : (b.done ? 'done' : 'fail'), note });
    if (b.state === 'done') {
      const outs = (b.items || []).filter((it) => it.state === 'done' && it.output).map((it) => it.output);
      for (const o of outs.slice().reverse()) if (!cloud.downloads.some((d) => d.path === o)) cloud.downloads.unshift({ path: o, name: String(o).split(/[\\/]/).pop(), at: Date.now() });
      renderDownloadCount();
      island({ kind: b.failed ? 'warn' : 'good', title: `${b.done} short${b.done === 1 ? '' : 's'} ready`, sticky: !!outs.length,
        sub: b.failed ? `${b.failed} could not be made — tap Running now for why.` : 'Save them all to your Photos',
        action: outs.length ? { label: 'Save all', onClick: () => saveAll(outs, { tapped: true }) } : undefined });
      if (typeof refreshFiles === 'function') { try { refreshFiles(); } catch (e) {} }
    }
    void left;
  }
  /*
   * The end of an Export all started on this phone: every short onto it, as
   * the last SAVE_SHARE of the batch's own number (overallPct), then one tap.
   */
  async function bringBatchDown(b, tid, outs) {
    batchSaving.set(tid, 'save');
    for (const o of outs.slice().reverse()) if (!cloud.downloads.some((d) => d.path === o)) cloud.downloads.unshift({ path: o, name: String(o).split(/[\\/]/).pop(), at: Date.now() });
    renderDownloadCount();
    if (window.__setTaskBatch) window.__setTaskBatch(tid, null);
    const say = (m) => { if (window.__taskSay) window.__taskSay(tid, m); };
    const pct = (n) => { if (window.__taskProgress) window.__taskProgress(tid, n); };
    say('📲 Getting the shorts onto your phone…');
    pct(0);
    let stop = false;
    batchStops.set(tid, () => { stop = true; });
    let res = { got: 0, space: null };
    try {
      res = await prefetchShorts(outs, { stopped: () => stop, progress: (n, line) => { pct(n); if (line) say(line); } });
    } catch (e) { /* the shorts are made; the Save all panel fetches whatever did not come down */ }
    batchStops.delete(tid);
    batchSaving.delete(tid);
    const made = `${b.done} short${b.done === 1 ? '' : 's'}`;
    const all = res.got === outs.length;
    if (window.__endTask) {
      window.__endTask(tid, { ok: true, state: 'done',
        note: `✅ ${made} exported on the server${b.failed ? ` · ${b.failed} could not be made` : ''}${res.got ? ` — ${all ? 'all' : res.got} on your phone, ready to save` : ''}.` });
    }
    // one tap from Photos — never "saved" before they are
    island({ kind: b.failed || res.space ? 'warn' : 'good', sticky: true,
      title: all ? `${made} on your phone` : `${made} ready`,
      sub: res.space ? `${res.got} on your phone — ${res.space}`
        : b.failed ? `${b.failed} could not be made — tap Running now for why`
        : all ? 'Tap Save all to put them in Photos' : 'Save them all to your Photos',
      action: { label: 'Save all', onClick: () => saveAll(outs, { tapped: true }) } });
    if (typeof refreshFiles === 'function') { try { refreshFiles(); } catch (e) {} }
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
  /** A free song from the music shelf, played through the server (cloud-api.js /api/free-song). */
  /** A narrator voice's sample line, made once on the server (cloud-api.js /api/voice-sample). */
  window.MW_VOICE_SAMPLE_URL = (id) => '/api/voice-sample?voice=' + encodeURIComponent(id) + (token ? '&k=' + encodeURIComponent(token) : '');
  window.MW_FREE_SONG_URL = (id) => '/api/free-song?id=' + encodeURIComponent(id) + (token ? '&k=' + encodeURIComponent(token) : '');
  /* The bundled caption fonts, by file name: an address the phone may keep
   * (cloud-api.js /fonts/, cached by sw.js) — through the media route above
   * all 3.2 MB came down again every time the app opened. */
  window.MW_FONT_URL = (file) => '/fonts/' + encodeURIComponent(file);
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
      project: (path) => call('montage:project', { path }),
      remake: (a) => call('montage:remake', a),
    },
    library: {
      list: () => call('library:list'),
      add: (kind, p, name, source) => call('library:add', { kind, path: p, name, source }),
      remove: (kind, id) => call('library:remove', { kind, id }),
      rename: (kind, id, name) => call('library:rename', { kind, id, name }),
    },
    /* songs that are safe to post (freemusic.js) */
    freeMusic: {
      list: (wait) => call('music:free', { wait: !!wait }),
      get: (id) => call('music:freeGet', { id }),
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
      trackPut: (a) => call('captions:trackPut', a),
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
      say: (a) => call('audio:say', a),
      voices: () => call('audio:voices'),
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
      withMusic: (a) => call('social:withMusic', a),
      accounts: () => call('social:accounts'),
      setKeys: (keys) => call('social:setKeys', keys),
      linkStart: (platform) => call('social:linkStart', { platform }),
      linkClaim: (platform) => call('social:linkClaim', { platform }),
      unlink: (id) => call('social:unlink', { id }),
      check: (id) => call('social:check', { id }),
      // whether the cloud AI writer/judge has its key (never the key itself) — the Cloud AI picker needs it
      cloudState: () => call('social:cloudState'),
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
  /*
   * ►► A PASSING NOTE NEVER LOSES A BUTTON. ◄◄ "Ready to save · Save Video"
   * waits for its tap for as long as it takes — and then any note at all
   * ("Copied", a thumbnail written) took its place, and when the note folded
   * away the button had gone with it. Now the button is set aside while the
   * note shows, and comes back when it goes. Only another BUTTON replaces it.
   */
  let islandParked = null;
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
    if (msg.sticky && msg.action) islandParked = null;
    else if (islandCur && islandCur.sticky && islandCur.action && el.classList.contains('on') && islandCur.id !== msg.id) islandParked = islandCur;
    /*
     * The SAME message moving on (a percentage ticking up) changes its words in
     * place — no swap, no spring. Redrawing the capsule for every percent made
     * a long download's "Getting it ready…" blink the whole way through.
     */
    if (el.classList.contains('on') && islandCur && msg.id && islandCur.id === msg.id
      && islandCur.kind === msg.kind && !!islandCur.spin === !!msg.spin && !islandCur.action && !msg.action) {
      const t = body.querySelector('.ci-title'), sb = body.querySelector('.ci-sub');
      if (t && (sb || !msg.sub)) {
        t.textContent = msg.title;
        if (sb) sb.textContent = msg.sub || '';
        islandCur = msg;
        clearTimeout(islandTimer);
        if (!msg.sticky) islandTimer = setTimeout(islandHide, msg.ms || 4200);
        return;
      }
    }
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
    if (id && (!islandCur || islandCur.id !== id)) {
      if (islandParked && islandParked.id === id) islandParked = null;
      return;
    }
    clearTimeout(islandTimer);
    const was = islandCur;
    islandCur = null;
    islandEl.classList.remove('on');
    // the note has gone: the button it covered comes back (not the button itself, tapped)
    const back = islandParked;
    if (back && back !== was) {
      islandParked = null;
      clearTimeout(islandHide._back);
      islandHide._back = setTimeout(() => { if (!islandCur) island(back); }, 280);
    } else if (back === was) islandParked = null;
  }
  window.__island = island;
  window.__islandHide = islandHide;

  let _jobCounter = 0;
  const newJobId = () => 'job_' + (++_jobCounter) + '_' + Date.now();

  function showOverlay(msg) {
    clearTimeout(_hideTimer); _hideTimer = null;
    clearOverlaySave();   // the last export's "Save to Photos" card never greets the next job
    const m = $('#overlayMsg'); if (m) m.textContent = msg || 'Working…';
    showWaiting(0);
    resetProgress();
    const o = $('#overlay');
    // over the captions editor when the job was started from it (🎧 Generate
    // captions, Save video with captions) — it ran hidden behind it before
    if (o) { o.classList.toggle('on-top', !!document.querySelector('#capModal:not(.hidden), #libModal:not(.hidden)')); o.classList.remove('hidden'); }
  }
  /*
   * The bar AND the number under it. This moved only the bar, so on a phone
   * the overlay read "0%" from the first short to the last while the work went
   * on underneath it (renderer.js, which the desk uses, sets both).
   */
  /*
   * ALWAYS MOVING. The real figure arrives in steps (a stretch heard, a pass
   * finished) and can sit still for a minute while the server works — which
   * reads as "stuck". So the bar glides towards each real figure, and between
   * them keeps creeping on, ever slower, never past the next likely step and
   * never past 99 % until the job really is done. It never goes backwards.
   */
  const prog = { target: 0, shown: 0, at: 0, timer: null };
  function drawProgress(v) {
    const pct = Math.max(0, Math.min(100, Math.floor(v)));
    const b = $('#progressBar'); if (b) b.style.width = Math.max(2, v) + '%';
    const n = $('#overlayPct'); if (n) n.textContent = pct + '%';
  }
  function tickProgress() {
    const now = Date.now();
    if (prog.shown < prog.target) prog.shown += Math.max(0.15, (prog.target - prog.shown) * 0.15);
    else if (prog.target < 100) {
      // creep: towards a ceiling a little ahead of the real figure, slower the longer it waits
      const ceil = Math.min(99, prog.target + Math.max(4, (100 - prog.target) * 0.25));
      const waited = (now - prog.at) / 1000;
      prog.shown += Math.max(0, ceil - prog.shown) * Math.min(0.02, 0.6 / (10 + waited));
    }
    prog.shown = Math.min(prog.target >= 100 ? 100 : 99, prog.shown);
    drawProgress(prog.shown);
  }
  function resetProgress() {
    prog.target = 0; prog.shown = 0; prog.at = Date.now();
    if (!prog.timer) prog.timer = setInterval(tickProgress, 100);
    drawProgress(0);
  }
  function stopProgress() { clearInterval(prog.timer); prog.timer = null; }
  function setProgress(p) {
    const pct = Math.max(0, Math.min(100, Number(p) || 0));
    if (!prog.timer) resetProgress();
    if (pct > prog.target) { prog.target = pct; prog.at = Date.now(); }
    if (pct >= 100) { prog.shown = 100; drawProgress(100); }
  }
  /*
   * IN LINE. Many people captioning at once take turns on the server
   * (fairqueue.js): while this job waits, the overlay says so — and where it
   * is in the line — so a wait never looks like a hang or a failure.
   */
  function showWaiting(n) {
    const msg = $('#overlayMsg');
    let el = $('#overlayWait');
    if (!el && msg && n > 0) {
      el = document.createElement('div');
      el.id = 'overlayWait';
      el.style.cssText = 'font-size:13px;opacity:.8;margin-top:4px';
      msg.insertAdjacentElement('afterend', el);
    }
    if (!el) return;
    el.textContent = n > 0 ? `Waiting for your turn — ${n === 1 ? 'you are next' : 'number ' + n + ' in line'}` : '';
    el.classList.toggle('hidden', !(n > 0));
  }
  function hideOverlay() {
    clearTimeout(_hideTimer); _hideTimer = null;
    showWaiting(0);
    clearOverlaySave();
    const o = $('#overlay'); if (o) { o.classList.add('hidden'); o.classList.remove('on-top'); }
    stopProgress();
    setJobBatch(null);
    showCancel(null);
    const bg = $('#overlayBackground');
    if (bg) { bg.classList.add('hidden'); bg.onclick = null; }
  }
  function setJobBatch(i, n, what, tail) {
    const el = $('#overlayBatch');
    if (!el) return;
    if (!i || !n) { el.classList.add('hidden'); el.textContent = ''; }
    else { el.classList.remove('hidden'); el.textContent = `${what || 'Short'} ${Math.min(i, n)} of ${n}${tail ? ' ' + tail : ''}`; }
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
  /*
   * This one was never actually called until now: tasks.js, loaded after this
   * file, replaced it with the desk's (toast "Saved", then shell.showItem —
   * here, a download under a second bar of its own). The exports that run as a
   * task now bring their file down inside their own number (deliverFile) and
   * never come here; what does come here is the rest — the captions window's
   * "Save video with captions", Apply effects, the tools, the bulk logo — and
   * on a phone each of those is brought down in the SAME overlay it was made
   * in, ending on the same "Save to Photos" button. Anywhere else (a computer's
   * browser) it is the ordinary download it has always been.
   */
  function finishedFile(p) {
    const name = String(p).split(/[\\/]/).pop();
    if (!cloud.downloads.some((d) => d.path === p)) cloud.downloads.unshift({ path: p, name, at: Date.now() });
    renderDownloadCount();
    if (canSaveHere() && /\.[A-Za-z0-9]{2,5}$/.test(name)) {
      const jid = 'deliver_' + newJobId();
      showOverlay('📲 Getting it onto your phone…');
      showCancel(jid);
      deliverFile(p, {
        copyShare: null,
        say: (m) => { const el = $('#overlayMsg'); if (el) el.textContent = m; },
        progress: (pc) => setProgress(Math.min(99, pc)),
        background: () => false,
        stopped: () => _cancelledJobs.has(jid),
      }).then((r) => {
        _cancelledJobs.delete(jid);
        hideOverlay();
        if (r && r.show) r.show();
      });
      return;
    }
    toast('✅ Saved: ' + name, 'good');
    setTimeout(() => offerDownload(p), 400);
  }
  window.finishedFile = finishedFile;
  // 🖼️ the thumbnail written beside an export: on the Saved list too, to save to Photos
  window.__thumbMade = (img) => {
    if (!img || cloud.downloads.some((d) => d.path === img)) return;
    cloud.downloads.unshift({ path: img, name: String(img).split(/[\\/]/).pop(), at: Date.now() });
    renderDownloadCount();
  };

  window.__newJobId = newJobId;
  /*
   * ►► THE SCREEN STAYS ON WHILE SOMETHING IS BEING MADE. ◄◄
   * An iPhone in Low Power Mode locks itself after 30 seconds, and a locked
   * phone puts the page to sleep mid-export. Like CapCut, the studio keeps the
   * screen awake while an export, a montage or a save to the phone is running,
   * and lets it sleep again shortly after nothing is.
   *
   * WHAT AN IPHONE ACTUALLY ALLOWS (WebKit's own source, not folklore — the
   * first version of this trusted folklore and kept nothing awake):
   *  • The Screen Wake Lock is granted only to a page the person has just
   *    TAPPED (within 5 s). Once one request has been granted that way, later
   *    ones in the same page life go through without a tap (WakeLock.cpp). So
   *    the lock is asked for INSIDE taps — the first tap of every page life,
   *    to unlock the later asks, and any tap while work runs — never only from
   *    a timer, which is all this used to do: it held only when a 2-second
   *    tick happened to land within 5 s of a tap, which is why it "worked"
   *    sometimes, and never after the app reopened itself mid-export.
   *  • When it is still refused (the app reopened and resumed an export by
   *    itself, before anyone touched it), the page says "tap the screen once".
   *  • The silent looping MUTED video it leant on can never keep an iPhone
   *    awake: WebKit ignores a video that loops, that is muted, or that has no
   *    sound track — and in Low Power Mode it will not even start one without
   *    a tap. The video is now only for phones without a working wake lock
   *    (home-screen apps before iOS 18.4): a clip with a silent sound track,
   *    not muted, sent back to its start instead of looping, started in a tap
   *    and kept (a new element would need a new tap). Being "sound", it can
   *    pause music playing in another app — which is why it is the fallback.
   *  • Work pauses between shorts for a second or two; the screen is held for
   *    a short grace after the work stops, so those gaps never drop it.
   */
  const AWAKE_GRACE_MS = 15000;
  const awake = { holds: new Set(), lock: null, pending: null, primed: false, err: '', vid: null, vidErr: '', busy: false, idleSince: 0, timer: null, grace: AWAKE_GRACE_MS, note: null };
  const AWAKE_MP4 = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAXpbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAD6AAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAot0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAAAAABAAAAAAIDbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAABAABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABrm1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAW5zdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAe/+EAF2dCwB7ZBCbARAAAAwAEAAADABA8WLkgAQAGaMuAZRMgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAABboAAAW6AAAAGHN0dHMAAAAAAAAAAQAAAAgAACAAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAANHN0c3oAAAAAAAAAAAAAAAgAAAKPAAAACwAAAAwAAAALAAAACwAAAAsAAAALAAAACwAAADBzdGNvAAAAAAAAAAgAAAYdAAAJBAAACWcAAAnHAAAKKgAACokAAArsAAALSwAAAq10cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAACAAAAAAAAD6AAAAAAAAAAAAAAAAEBAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAA+gAAAEAAABAAAAAAIlbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAACsRAACtRBVxAAAAAAALWhkbHIAAAAAAAAAAHNvdW4AAAAAAAAAAAAAAABTb3VuZEhhbmRsZXIAAAAB0G1pbmYAAAAQc21oZAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABlHN0YmwAAAB+c3RzZAAAAAAAAAABAAAAbm1wNGEAAAAAAAAAAQAAAAAAAAAAAAEAEAAAAACsRAAAAAAANmVzZHMAAAAAA4CAgCUAAgAEgICAF0AVAAAAAAA+gAAABWcFgICABRIIVuUABoCAgAECAAAAFGJ0cnQAAAAAAAA+gAAABWcAAAAgc3R0cwAAAAAAAAACAAAArQAABAAAAAABAAABEAAAAHBzdHNjAAAAAAAAAAgAAAABAAAAAQAAAAEAAAACAAAAFgAAAAEAAAAEAAAAFQAAAAEAAAAFAAAAFgAAAAEAAAAGAAAAFQAAAAEAAAAHAAAAFgAAAAEAAAAIAAAAFQAAAAEAAAAJAAAAFgAAAAEAAAAUc3RzegAAAAAAAAAEAAAArgAAADRzdGNvAAAAAAAAAAkAAAYZAAAIrAAACQ8AAAlzAAAJ0gAACjUAAAqUAAAK9wAAC1YAAAAac2dwZAEAAAByb2xsAAAAAgAAAAH//wAAABxzYmdwAAAAAHJvbGwAAAABAAAArgAAAAEAAAA9dWR0YQAAADVtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAAhpbHN0AAAACGZyZWUAAAWdbWRhdAEYIAcAAAJvBgX//2vcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY0IHIzMTA4IDMxZTE5ZjkgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDIzIC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MyBkZWJsb2NrPTE6LTM6LTMgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTIuMDA6MC43MCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTQgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTgga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9OCByYz1jcmYgbWJ0cmVlPTEgY3JmPTUxLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjIwAIAAAAAYZYiEBjOcmKAAIb8nJyddddddddddddeAARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmjgMZzhGARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAhBmlQDGc4RgAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmmAYznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwAAAAdBmoAXznCMARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GaoBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHAAAAB0GawBfOcIwBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcAAAAHQZrgFc5wjAEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAcBGCAHARggBwEYIAc=';
  // a home-screen app on iOS before 18.4: the wake lock is there but does nothing (WebKit bug 254545)
  const awakeLockBroken = (() => {
    try {
      const standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
      const m = /(?:iPhone|iPad|iPod).*? OS (\d+)_(\d+)/.exec(navigator.userAgent || '');
      return !!(standalone && m && (+m[1] < 18 || (+m[1] === 18 && +m[2] < 4)));
    } catch (e) { return false; }
  })();
  const awakeUseVideo = () => !('wakeLock' in navigator) || awakeLockBroken;
  function awakeNeeded() {
    if (awake.holds.size) return true;
    const o = document.getElementById('overlay'); if (o && !o.classList.contains('hidden')) return true;
    try { if (window.__tasksBusy && window.__tasksBusy()) return true; } catch (e) {}
    try { if ((window.__tasksList ? window.__tasksList() : []).some((t) => t.state === 'run')) return true; } catch (e) {}
    try { if (window.MWSocial && window.MWSocial.busy && window.MWSocial.busy()) return true; } catch (e) {}
    return false;
  }
  // needed now, or only just stopped being (the grace between one short and the next)
  function awakeWanted() {
    if (awakeNeeded()) { awake.idleSince = 0; awake.busy = true; return true; }
    if (!awake.busy) return false;
    if (!awake.idleSince) awake.idleSince = Date.now();
    if (Date.now() - awake.idleSince < awake.grace) return true;
    awake.busy = false; awake.idleSince = 0;
    return false;
  }
  /** Ask for the screen lock — synchronously, so a tap that calls this counts. One ask at a time. */
  function awakeRequestLock() {
    if (!('wakeLock' in navigator) || awake.lock || awake.pending || document.visibilityState !== 'visible') return;
    let req;
    try { req = navigator.wakeLock.request('screen'); } catch (e) { awake.err = (e && e.name) || 'Error'; return; }
    awake.pending = req;
    Promise.resolve(req).then((lock) => {
      awake.pending = null; awake.primed = true; awake.err = '';
      // the first-tap ask that only unlocks later ones: let go at once
      if (!awakeWanted()) { try { lock.release(); } catch (e) {} return; }
      awake.lock = lock;
      lock.addEventListener('release', () => { if (awake.lock === lock) awake.lock = null; });
      awakeNote(false);
    }, (e) => { awake.pending = null; awake.err = (e && e.name) || 'Error'; awakeNote(awakeWanted()); });
  }
  function awakeVideo() {
    if (awake.vid) return awake.vid;
    const v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.setAttribute('aria-hidden', 'true'); v.setAttribute('title', 'Keeping the screen on');
    v.muted = false; v.volume = 1;   // its sound track is silence; a muted video keeps nothing awake
    v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    // no `loop`: back to the start before it can end
    v.addEventListener('timeupdate', () => { if (v.currentTime > 0.5) v.currentTime = Math.random() * 0.4; });
    v.src = AWAKE_MP4;
    document.body.appendChild(v);
    awake.vid = v;
    return v;
  }
  function awakePlayVideo() {
    const v = awakeVideo();
    if (!v.paused) return;
    try { const p = v.play(); if (p && p.then) p.then(() => { awake.vidErr = ''; awakeNote(false); }, (e) => { awake.vidErr = (e && e.name) || 'Error'; awakeNote(awakeWanted()); }); } catch (e) {}
  }
  const awakeHeld = () => !!awake.lock || !!(awake.vid && !awake.vid.paused);
  /* "Tap the screen once": shown only while work runs, nothing holds the screen and an ask was refused. */
  function awakeNote(show) {
    show = !!show && !awakeHeld() && document.visibilityState === 'visible' && (awake.err === 'NotAllowedError' || !!awake.vidErr);
    if (!show) { if (awake.note) awake.note.classList.add('hidden'); return; }
    if (!awake.note) {
      const n = document.createElement('div');
      n.id = 'awakeNote';
      n.setAttribute('role', 'status');
      n.textContent = '👆 Tap the screen once so it stays on while this works';
      n.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top, 0px) + 8px);z-index:2147483000;'
        + 'background:#f5b301;color:#111;font:600 14px/1.3 system-ui,-apple-system,sans-serif;padding:8px 14px;border-radius:18px;'
        + 'box-shadow:0 4px 18px rgba(0,0,0,.35);max-width:calc(100% - 32px);text-align:center';
      document.body.appendChild(n);
      awake.note = n;
    }
    awake.note.classList.remove('hidden');
  }
  function awakeOn() {
    if (document.visibilityState !== 'visible') return;
    awakeRequestLock();                 // without a tap: goes through once a tap has unlocked it
    if (awakeUseVideo()) awakePlayVideo();
    if (!awake.pending) awakeNote(true);
  }
  function awakeOff() {
    if (awake.lock) { try { awake.lock.release(); } catch (e) {} awake.lock = null; }
    if (awake.vid && !awake.vid.paused) { try { awake.vid.pause(); } catch (e) {} }   // kept: a new one would need a new tap
    awakeNote(false);
  }
  function awakeCheck() { if (awakeWanted()) awakeOn(); else awakeOff(); }
  // EVERY TAP: the one moment WebKit grants the lock (and lets a sound-carrying video start)
  function awakeTap() {
    if (document.visibilityState !== 'visible') return;
    const want = awakeWanted();
    if (!awake.primed || (want && !awake.lock)) awakeRequestLock();
    if (want && awakeUseVideo()) awakePlayVideo();
  }
  ['click', 'touchend', 'pointerup', 'keydown'].forEach((t) => document.addEventListener(t, awakeTap, { capture: true, passive: true }));
  /** keepAwake(key, true|false) — hold the screen on for a piece of work. */
  window.__keepAwake = (key, on) => { if (on) awake.holds.add(key); else awake.holds.delete(key); awakeCheck(); };
  window.__awakeState = () => ({
    needed: awakeNeeded(), wanted: awakeWanted(), lock: !!awake.lock, pending: !!awake.pending, primed: awake.primed, err: awake.err,
    video: !!(awake.vid && !awake.vid.paused), videoErr: awake.vidErr, videoEl: !!awake.vid, videoMuted: !!(awake.vid && awake.vid.muted), videoLoop: !!(awake.vid && awake.vid.loop),
    useVideo: awakeUseVideo(), note: !!(awake.note && !awake.note.classList.contains('hidden')),
  });
  window.__awakeGrace = (ms) => { awake.grace = ms == null ? AWAKE_GRACE_MS : ms; };   // for the tests
  // a lock is dropped whenever the app leaves the screen: taken again on return (no tap needed once unlocked)
  document.addEventListener('visibilitychange', awakeCheck);
  awake.timer = setInterval(awakeCheck, 2000);

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
      if (d.waiting != null) showWaiting(d.waiting);
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

  /* What kind of file the studio asked for, so the chooser can say it: "Send
     music from this phone" when a song was asked for, not "a video". */
  const AUDIO_RE = /^\.(mp3|m4a|wav|aac|ogg|flac|opus|wma)$/, PIC_RE = /^\.(jpe?g|png|webp|gif|bmp|tiff?|avif|heic|heif)$/,
    VID_RE = /^\.(mp4|mov|m4v|mkv|webm|avi|wmv|flv|3gp)$/;
  function kindOf(exts) {
    if (!exts) return 'video';
    if (exts.every((e) => AUDIO_RE.test(e))) return 'music';
    if (exts.every((e) => PIC_RE.test(e))) return 'picture';
    if (exts.every((e) => VID_RE.test(e))) return 'video';
    if (exts.every((e) => PIC_RE.test(e) || VID_RE.test(e))) return 'media';
    return 'file';
  }
  const SEND_WHAT = { music: 'music', picture: 'a picture', video: 'a video', media: 'a video or picture', file: 'a file' };
  const PICK_TITLE = { music: 'Choose music', picture: 'Choose a picture', video: 'Choose a video', media: 'Choose a video or picture', file: 'Choose a file' };
  /*
   * The extensions asked for, as an iPhone's picker reads them. Audio also gets
   * audio/*, so every song in Files is tappable. HEIC is left out: an iPhone
   * hands over a JPEG copy of a photo unless the page says it takes HEIC, and
   * the studio cannot. Videos keep their plain list (a video/* family can make
   * iOS re-compress a video from Photos).
   */
  function acceptFor(exts) {
    const list = exts.filter((e) => e !== '.heic' && e !== '.heif');
    if (list.length && list.every((e) => AUDIO_RE.test(e))) list.push('audio/*');
    return list.join(',');
  }

  function pickFiles(filters, multi) {
    // a second ask while one is open answers the first with "nothing", instead
    // of leaving its caller waiting for ever
    if (pickResolve) { const r = pickResolve; pickResolve = null; r(null); }
    const exts = extsOf(filters);
    pickState = { multi: !!multi, exts, kind: kindOf(exts) };
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

  /*
   * ►► A SHEET COMES UP OVER WHATEVER ASKED FOR IT. ◄◄
   * "Your files" is in the page BEFORE the studio's own windows, with the same
   * z-index as them, so when 🎵 My music (or My clips, the cover picker, the
   * effects panel, the captions window) asked for a file, the chooser opened
   * BEHIND it: "Add music" seemed to do nothing, and the chooser was only found
   * after closing My music. It now goes one step above the highest window that
   * is up — never over the sign-in gate, the full-screen viewer or the island.
   */
  function raiseSheet(m) {
    if (!m) return;
    let z = 0;
    for (const n of $$('.cap-modal:not(.hidden), .fx-side:not(.hidden), .cp-panel, .cp-scrim')) {
      if (n === m) continue;
      const v = parseInt(getComputedStyle(n).zIndex, 10);
      if (v > z && v < 2000) z = v;
    }
    m.style.zIndex = z ? String(Math.min(z + 2, 398)) : '';
  }
  async function openFilesModal(opts = {}) {
    const m = $('#cloudFilesModal');
    if (!m) return;
    raiseSheet(m);
    m.classList.remove('hidden');
    m.dataset.picking = opts.picking ? '1' : '';
    const kind = opts.picking ? (pickState.kind || 'video') : 'video';
    const up = $('#cloudUpload span');
    // (one short line: "Send a video or picture from this phone" ran off the button)
    if (up) up.textContent = `Send ${String(SEND_WHAT[kind]).length <= 10 ? SEND_WHAT[kind] + ' ' : ''}from ${window.matchMedia('(max-width: 900px)').matches ? 'this phone' : 'this computer'}`;
    const title = m.querySelector('.cloud-files-title');
    if (title) title.textContent = opts.picking ? PICK_TITLE[kind] : 'Your files';
    setSelecting(false);
    /*
     * PICKING SEVERAL (the AI Montage's "From your files"): a tap ticks a video
     * instead of taking it and closing, and "Add N" takes all the ticked ones.
     */
    filesUi.pickMulti = !!(opts.picking && pickState.multi);
    m.classList.toggle('cf-picking-multi', filesUi.pickMulti);
    paintSelBar();
    await refreshFiles();
  }
  function closeFilesModal() {
    const m = $('#cloudFilesModal');
    if (m) { m.classList.add('hidden'); m.dataset.picking = ''; m.style.zIndex = ''; m.classList.remove('cf-picking-multi'); }
    filesUi.pickMulti = false;
    setSelecting(false);
    if (pickResolve) finishPick(null);
  }

  async function refreshFiles(quiet) {
    const list = $('#cloudFilesList');
    if (!list) return;
    if (quiet !== true || !filesCache) list.innerHTML = '<div class="cf-loading"><i class="cf-spin"></i>Looking…</div>';
    try {
      // picking a song or a picture lists songs and pictures too, not only videos
      const res = await fetch('/api/videos' + (isPicking() && pickState.kind !== 'video' ? '?all=1' : ''), { headers: authHeaders() });
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
      + (AUDIO_RE.test((/\.[^.]+$/.exec(String(f.name).toLowerCase()) || [''])[0])
        ? '<span class="cf-pic cf-pic-audio" aria-hidden="true">🎵</span>'   // a song has no picture to ask for
        : `<span class="cf-pic" data-thumb="${escAttr(f.path)}"></span>`)
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
      // finished exports: every video to Photos in one go (the same Save all as an Export all ends on)
      const vids = !picking && g.key === 'output' ? files.filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name)) : [];
      const saveAllBtn = vids.length > 1
        ? `<button type="button" class="cv-act cv-save sa-all cf-saveall" data-saveall="output">${mi('download')}<span>Save all ${vids.length} to Photos</span></button>` : '';
      // …and all of them deleted in one go, once they are saved (asks once more first: it cannot be undone)
      const sureAll = filesUi.delAllSure === g.key;
      const delAllBtn = !picking && del && g.key === 'output' && files.length > 1
        ? `<button type="button" class="cf-delall${sureAll ? ' sure' : ''}" data-delall="${g.key}">${mi('trash')}<span>${sureAll ? `Delete all ${files.length} for good?` : `Delete all ${files.length}`}</span></button>` : '';
      let acts = saveAllBtn || delAllBtn ? `<div class="cf-group-acts">${saveAllBtn}${delAllBtn}</div>` : '';
      // choosing, one by one or all at once: Select all / Clear in place of Save all · Delete all
      if (filesUi.selecting && !picking && del) {
        const all = files.length && files.every((f) => filesUi.chosen.has(f.path));
        acts = `<div class="cf-group-acts"><button type="button" class="cf-selall" data-selall="${g.key}">${all ? '' : mi('check')}<span>${all ? 'Clear selection' : `Select all ${files.length}`}</span></button></div>`;
      }
      html += `<section class="cloud-files-group"><h4 class="cloud-files-head"><span>${escHtml(g.label)}</span><small>${files.length} · ${fmtSize(total)}</small></h4>`
        + acts + files.map((f) => fileRow(f, del, picking)).join('') + '</section>';
    }
    if (!any) {
      html = `<div class="cloud-files-empty"><div class="cf-empty-art">${mi('folder')}</div><b>Nothing here yet</b>`
        + `<p>${exts ? 'Nothing of that kind, anyway. ' : ''}Send ${SEND_WHAT[picking ? (pickState.kind || 'video') : 'video']} with the button above.</p></div>`;
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
    if (filesCache) renderFiles();     // the group buttons change with it (Select all / Save all)
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
    const use = $('#cloudFilesSelUse');
    if (filesUi.pickMulti) {
      const k = filesUi.chosen.size;
      bar.classList.remove('hidden');
      for (const id of ['#cloudFilesSelSave', '#cloudFilesSelDelete']) { const b = $(id); if (b) b.classList.add('hidden'); }
      if (use) { use.classList.remove('hidden'); use.disabled = !k; const t = use.querySelector('span'); if (t) t.textContent = k ? `Add ${k}` : 'Add'; }
      const info = $('#cloudFilesSelInfo');
      if (info) info.textContent = k ? `${k} chosen` : 'Tap the videos and photos to add';
      return;
    }
    if (use) use.classList.add('hidden');
    for (const id of ['#cloudFilesSelSave', '#cloudFilesSelDelete']) { const b = $(id); if (b) b.classList.remove('hidden'); }
    bar.classList.toggle('hidden', !filesUi.selecting);
    const n = filesUi.chosen.size;
    const bytes = Array.from(filesUi.chosen).reduce((t, p) => t + sizeOf(p), 0);
    const info = $('#cloudFilesSelInfo');
    if (info) info.textContent = n ? `${n} selected · ${fmtSize(bytes)}` : 'Tap videos to save or delete';
    const sv = $('#cloudFilesSelSave');
    if (sv) { sv.disabled = !n; const t = sv.querySelector('span'); if (t) t.textContent = n > 1 ? `Save ${n}` : 'Save'; }
    const del = $('#cloudFilesSelDelete');
    if (!del) return;
    del.disabled = !n;
    del.classList.toggle('sure', !!(filesUi.sure && n));
    const tx = del.querySelector('span');
    if (tx) tx.textContent = filesUi.sure && n ? `Delete ${n === 1 ? 'it' : 'all ' + n} for good?` : n > 1 ? `Delete ${n}` : 'Delete';
  }
  function onFilesClick(e) {
    const sa0 = e.target.closest('[data-selall]');
    if (sa0 && filesUi.selecting) {
      const g = ((filesCache && filesCache.groups) || []).find((x) => x.key === sa0.dataset.selall);
      const ps = ((g && g.files) || []).map((f) => f.path);
      const all = ps.length && ps.every((p) => filesUi.chosen.has(p));
      for (const p of ps) { if (all) filesUi.chosen.delete(p); else filesUi.chosen.add(p); }
      filesUi.sure = false;
      renderFiles(); paintSelBar();
      return;
    }
    const da = e.target.closest('[data-delall]');
    if (da && !filesUi.selecting) {
      const key = da.dataset.delall;
      if (filesUi.delAllSure !== key) {
        // first tap: ask. It goes back to asking by itself if nothing more is tapped.
        filesUi.delAllSure = key;
        clearTimeout(filesUi.delAllTimer);
        filesUi.delAllTimer = setTimeout(() => { if (filesUi.delAllSure) { filesUi.delAllSure = null; renderFiles(); } }, 6000);
        renderFiles();
        return;
      }
      filesUi.delAllSure = null;
      clearTimeout(filesUi.delAllTimer);
      const g = ((filesCache && filesCache.groups) || []).find((x) => x.key === key);
      const paths = ((g && g.files) || []).map((f) => f.path);
      if (paths.length) deletePaths(paths);
      return;
    }
    if (filesUi.delAllSure) { filesUi.delAllSure = null; renderFiles(); }
    const sa = e.target.closest('[data-saveall]');
    if (sa && !filesUi.selecting) {
      const g = ((filesCache && filesCache.groups) || []).find((x) => x.key === sa.dataset.saveall);
      const paths = ((g && g.files) || []).filter((f) => /\.(mp4|mov|m4v)$/i.test(f.name)).map((f) => f.path);
      if (!paths.length) return;
      closeFilesModal();
      saveAll(paths, { tapped: true });
      return;
    }
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
    if (act === 'open' && filesUi.pickMulti) {
      if (filesUi.chosen.has(p)) filesUi.chosen.delete(p); else filesUi.chosen.add(p);
      row.classList.toggle('chosen', filesUi.chosen.has(p));
      return paintSelBar();
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
    const ed = window.VideoEditor;
    const openNow = [ed && ed.sourcePath && ed.sourcePath(), ed && ed.montagePath && ed.montagePath()].filter(Boolean);
    const isOpen = (p) => openNow.includes(p);
    // the one the studio has open goes too (it was asked for, twice) — the server
    // deletes it first, and only once it is really gone does the studio let go of
    // it (a refused or failed delete leaves the edit exactly as it was)
    let closing = false;
    const kept = ed && ed.closeVideo ? [] : paths.filter(isOpen);
    const go = paths.filter((p) => !kept.includes(p));
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
    if (ed && ed.closeVideo && [...gone].some(isOpen)) {
      closing = true;
      try { ed.closeVideo(); } catch (e) {}
    }
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
        sub: (out.freed ? `${fmtSize(out.freed)} freed` : 'Removed') + (closing ? ' · closed in the Video Studio' : '') + (refused.length ? ` · ${refused.length} kept: ${refused[0].why}` : ''),
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
  /* A file with no ending of its own (some phones and apps hand one over
   * like that) is named for what it IS, so the server knows it is a video. */
  const MIME_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/3gpp': '.3gp',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heic', 'image/gif': '.gif',
    'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg' };
  function nameWithExt(file) {
    const n = String(file.name || 'upload');
    if (/\.[a-z0-9]{2,5}$/i.test(n)) return n;
    return n + (MIME_EXT[String(file.type || '').toLowerCase()] || (/^video\//.test(file.type) ? '.mp4' : /^image\//.test(file.type) ? '.jpg' : /^audio\//.test(file.type) ? '.mp3' : ''));
  }
  /*
   * One piece, sent so it says how far it has got WHILE it goes. fetch() cannot
   * say that, so the bar sat still for each 8 MB piece — a minute and more on
   * a phone — and an upload looked stuck at 2%. Cut off by `signal` (Stop).
   */
  function postPiece(url, body, signal, onSent) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      const h = Object.assign({ 'Content-Type': 'application/octet-stream' }, authHeaders());
      for (const k of Object.keys(h)) x.setRequestHeader(k, h[k]);
      x.responseType = 'text';
      if (onSent) x.upload.onprogress = (e) => { if (e.lengthComputable) onSent(e.loaded); };
      x.onload = () => {
        let j = {};
        try { j = JSON.parse(x.responseText || '{}'); } catch (e) { j = {}; }
        resolve({ status: x.status, ok: x.status >= 200 && x.status < 300, json: async () => j });
      };
      const fail = (why) => { const e = new Error(why); e.name = why === 'aborted' ? 'AbortError' : 'NetworkError'; reject(e); };
      x.onerror = () => fail('network');
      x.onabort = () => fail('aborted');
      if (signal) { if (signal.aborted) return fail('aborted'); signal.addEventListener('abort', () => { try { x.abort(); } catch (e) {} }, { once: true }); }
      x.send(body);
    });
  }

  async function uploadFile(file, onProgress, ctlIn) {
    const CHUNK = 8 * 1024 * 1024;
    const id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const q = (extra) => `/api/upload?name=${encodeURIComponent(nameWithExt(file))}&id=${id}&size=${file.size}${extra || ''}`;
    let sent = 0;
    /*
     * STOP MEANS NOW. It used to be looked at only between 8 MB pieces — on a
     * phone's connection a minute or more — so Stop seemed to do nothing. The
     * piece on its way is cut off (abort), and the half-sent file on the server
     * is thrown away (discard): a stopped upload leaves nothing behind.
     */
    const ctl = ctlIn || newUploadCtl();
    ctl.id = id;              // the server's progress messages carry it (showUploadProgress)
    const ac = ctl.ac;
    if (!ctlIn) currentUpload = ctl;
    const stopped = () => {
      if (currentUpload === ctl) currentUpload = null;
      fetch(q('&discard=1'), { method: 'POST', headers: authHeaders() }).catch(() => {});
      const e = new Error('Stopped.'); e.stopped = true; return e;
    };

    // Where did we get to last time (if this is a retry of the same id)?
    try {
      const probe = await fetch(q('&probe=1'), { method: 'POST', headers: authHeaders() });
      const info = await probe.json();
      if (info && info.have) sent = Math.min(info.have, file.size);
    } catch (e) { sent = 0; }

    while (sent < file.size) {
      if (ctl.cancelled) throw stopped();
      const end = Math.min(sent + CHUNK, file.size);
      const slice = file.slice(sent, end);
      let res;
      try {
        const base = sent;
        res = await postPiece(q('&offset=' + sent), slice, ac.signal,
          (n) => { if (onProgress) onProgress(Math.min(99, Math.floor(((base + n) / file.size) * 100)), { sent: base + n, total: file.size }); });
      } catch (e) {
        if (ctl.cancelled) throw stopped();
        // A dropped connection is not a lost upload — wait and pick up where the
        // server says it got to.
        await new Promise((r) => setTimeout(r, 1500));
        if (ctl.cancelled) throw stopped();
        const probe = await fetch(q('&probe=1'), { method: 'POST', headers: authHeaders() }).then((r) => r.json()).catch(() => null);
        if (probe && typeof probe.have === 'number') { sent = probe.have; continue; }
        throw new Error('The upload stopped and could not be picked up again.');
      }
      if (res.status === 401) { signedOut(); throw new Error('Signed out.'); }
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || 'Upload failed.');
      if (out.partial) { sent = out.have; }
      else if (out.ok && out.path) { if (onProgress) onProgress(100); if (currentUpload === ctl) currentUpload = null; return out.path; }
      else sent = end;
      if (onProgress) onProgress(Math.round((sent / file.size) * 100), { sent, total: file.size });
    }
    if (currentUpload === ctl) currentUpload = null;
    throw new Error('The upload finished without a file coming back.');
  }

  function newUploadCtl() {
    const ac = new AbortController();
    return { ac, cancelled: false, stop() { this.cancelled = true; try { ac.abort(); } catch (e) {} } };
  }
  /*
   * ►► SEVERAL AT ONCE. ◄◄ "I should be able to upload more than one file
   * simultaneously." Every file sent from this phone is a row of its own — its
   * name, its bar, its own Stop — and up to UP_AT_ONCE go up together (more
   * than that only splits the same connection thinner); the rest wait their
   * turn, listed as waiting. Sending more while some are on their way just adds
   * rows. Each is still sent in resumable pieces (uploadFile).
   */
  const UP_AT_ONCE = 3;
  const upRows = new Map();      // key -> { name, pct, state: 'wait'|'run', ctl, start }
  let upRunning = 0;
  const upQueue = [];
  let upSeq = 0;
  function renderUploads() {
    const bar = $('#cloudUploadBar');
    if (!bar) return;
    if (!upRows.size) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
    bar.classList.remove('hidden');
    bar.classList.add('multi');
    const rows = Array.from(upRows.entries());
    bar.innerHTML = rows.map(([k, r]) => `<div class="cloud-up-row${r.state === 'wait' ? ' wait' : ''}" data-up="${k}">`
      + `<div class="cloud-upload-name">${escHtml(r.name)}</div>`
      + (r.state === 'wait' ? '<div class="cloud-up-wait">Waiting…</div>'
        : `<div class="cloud-up-mid"><div class="progress"><div class="progress-bar" style="width:${Math.max(2, Math.min(100, r.pct || 0))}%"></div></div>`
          + `<div class="cloud-up-pct">${upLine(r)}</div></div>`)
      + (r.ctl ? `<button type="button" class="cloud-files-pill" data-upstop="${k}">${r.stopping ? 'Stopping…' : 'Stop'}</button>` : '')
      + '</div>').join('')
      + (rows.filter(([, r]) => r.ctl).length > 1 ? '<button type="button" class="cloud-up-stopall" data-upstop="*">Stop all</button>' : '');
  }
  /* "34% · 412 MB of 1.2 GB · 3 min left" — how far, of how much, and how long to go */
  function upLine(r) {
    const pct = Math.max(0, Math.min(100, Math.round(r.pct || 0)));
    let t = `<b>${pct}%</b>`;
    if (r.total) t += ` · ${fmtSize(r.sent || 0)} of ${fmtSize(r.total)}`;
    if (r.rate && r.total && pct < 100) {
      const left = Math.max(0, (r.total - (r.sent || 0)) / r.rate);
      t += ' · ' + (left < 60 ? Math.max(5, Math.ceil(left / 5) * 5) + ' s left' : left < 3600 ? Math.ceil(left / 60) + ' min left' : (left / 3600).toFixed(1).replace(/\.0$/, '') + ' h left');
    }
    return t;
  }
  /* just the bar and line of one row, so a progress tick does not redraw (and steal) a tap */
  function paintUploadPct(k) {
    const r = upRows.get(k);
    const row = document.querySelector(`#cloudUploadBar [data-up="${k}"]`);
    const bar = row && row.querySelector('.progress-bar'), line = row && row.querySelector('.cloud-up-pct');
    if (!r || !bar || !line) return renderUploads();
    bar.style.width = Math.max(2, Math.min(100, r.pct || 0)) + '%';
    line.innerHTML = upLine(r);
  }
  function stopUpload(k) {
    const keys = k === '*' ? Array.from(upRows.keys()) : [k];
    for (const key of keys) {
      const r = upRows.get(key); if (!r || !r.ctl) continue;
      r.stopping = true; r.ctl.stop();
      if (r.state === 'wait') { r.done(Object.assign(new Error('Stopped.'), { stopped: true })); }
    }
    renderUploads();
  }
  function pumpUploads() {
    while (upRunning < UP_AT_ONCE && upQueue.length) {
      const key = upQueue.shift();
      const r = upRows.get(key); if (!r || r.ctl.cancelled) continue;
      r.state = 'run'; upRunning++;
      renderUploads();
      r.t0 = Date.now(); r.b0 = null;
      uploadFile(r.file, (pc, b) => {
        r.pct = pc;
        if (b) {
          r.sent = b.sent; r.total = b.total;
          // the speed since it started (from where it started, for a resumed one), steadied
          const now = Date.now();
          if (r.b0 == null) { r.b0 = b.sent; r.t0 = now; }
          const secs = (now - r.t0) / 1000;
          if (secs > 1.5 && b.sent > r.b0) {
            const rate = (b.sent - r.b0) / secs;
            r.rate = r.rate ? r.rate * 0.7 + rate * 0.3 : rate;
          }
        }
        paintUploadPct(key);
      }, r.ctl)
        .then((p) => r.done(null, p), (e) => r.done(e))
        .finally(() => { upRunning--; pumpUploads(); });
    }
  }
  /** Send files, several at once; resolves with [{ name, path } | { name, error }] in the order given. */
  function sendFiles(files) {
    return Promise.all(files.map((file) => new Promise((resolve) => {
      const key = 'f' + (++upSeq);
      const r = { name: file.name, pct: 0, state: 'wait', file, ctl: newUploadCtl() };
      let settled = false;
      r.done = (err, p) => {
        if (settled) return; settled = true;
        upRows.delete(key); renderUploads();
        resolve(err ? { name: file.name, error: err } : { name: file.name, path: p });
      };
      upRows.set(key, r); upQueue.push(key);
    })));
  }
  function sendFilesNow(files) { const all = sendFiles(files); renderUploads(); pumpUploads(); return all; }
  /** Say how a batch went: stopped ones quietly, failures once each. */
  function reportSent(results) {
    const stopped = results.filter((x) => x.error && x.error.stopped).length;
    for (const x of results) if (x.error && !x.error.stopped) toast('⚠️ ' + (x.name ? x.name + ': ' : '') + (x.error.message || x.error), 'error');
    if (stopped) island({ kind: 'info', title: stopped > 1 ? `${stopped} uploads stopped` : 'Upload stopped', sub: 'Nothing of them was kept on the server.', ms: 3500 });
  }
  /* an upload reported by the server (another device's): shown, without a Stop of ours */
  function showUploadProgress(d) {
    if (!d || !d.id) return;
    for (const r of upRows.values()) if (r.ctl && r.ctl.id === d.id) return;
    const key = 'srv-' + d.id;
    if (d.done) { upRows.delete(key); renderUploads(); return; }
    const had = upRows.has(key);
    upRows.set(key, Object.assign(upRows.get(key) || { name: d.name || 'Sending…', state: 'run' }, { pct: d.percent || 0 }));
    if (had) paintUploadPct(key); else renderUploads();
  }

  /** Pick files off this device and send them; resolves with studio paths. */
  function chooseFromDevice(multi, exts) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (multi) input.multiple = true;
      if (exts && exts.length) input.accept = acceptFor(exts);
      input.style.position = 'fixed';
      input.style.left = '-9999px';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const files = Array.from(input.files || []);
        input.remove();
        if (!files.length) return resolve(null);
        const results = await sendFilesNow(files);
        reportSent(results);
        const paths = results.filter((x) => x.path).map((x) => x.path);
        if (!paths.length) { refreshFiles(); return resolve(null); }
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
  const isStandalone = () => navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  const onPhone = () => window.matchMedia('(max-width: 900px)').matches;
  function openInPlayer(p) {
    island({ kind: 'info', title: 'Opening it in the player', sub: 'Tap the share button, then “Save Video”', ms: 6000 });
    window.open(downloadUrl(p).replace('/api/file?', '/api/media?').replace('&dl=1', ''), '_blank');
  }
  /*
   * ►► A BIG FILE COMES DOWN IN PIECES. ◄◄
   * One request for a 700 MB montage over a phone's connection stalled at 2%
   * and never moved again. It is fetched in 4 MB pieces, four at a time; a
   * piece that stalls for 25 s is asked for again (up to six times), so a
   * dropped connection costs one piece, not the whole download. Each piece is
   * kept as a Blob (WebKit keeps those out of the page's memory) and the file
   * is put together from them.
   */
  /*
   * `opts.stopped()` — the export this download is the last part of was
   * cancelled (or stopped from the jobs sheet): no new piece is asked for, the
   * ones on their way are let go, and it ends as an AbortError, the same thing
   * a closed share sheet is — "not saved", never "something went wrong".
   * `opts.hold`: a Save all's file, kept on the phone until it has gone to
   * Photos (see ONE SAVE NEVER WIPES ANOTHER).
   */
  async function fetchForSaving(p, name, size, onPct, opts) {
    const url = downloadUrl(p);
    const stopped = () => !!(opts && typeof opts.stopped === 'function' && opts.stopped());
    const halt = () => { const e = new Error('Stopped'); e.name = 'AbortError'; return e; };
    if (stopped()) throw halt();
    let total = Number(size) || 0;
    if (!total) {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      const cr = r.headers.get('content-range') || '';
      total = Number((/\/(\d+)$/.exec(cr) || [])[1]) || Number(r.headers.get('content-length')) || 0;
      try { await r.arrayBuffer(); } catch (e) {}
    }
    const type = /\.mov$/i.test(name) ? 'video/quicktime' : /\.(jpe?g)$/i.test(name) ? 'image/jpeg' : /\.png$/i.test(name) ? 'image/png' : 'video/mp4';
    if (!total) {   // a server that will not say how big: one go
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return new File([await res.blob()], name, { type });
    }
    const CHUNK = 4 * 1024 * 1024;
    const n = Math.ceil(total / CHUNK);
    // a short, plain name ending in its real extension (what Photos and Files show)
    const ext = (/\.[A-Za-z0-9]{2,5}$/.exec(name) || ['.mp4'])[0];
    const nice = (name.length > 60 ? name.slice(0, 60 - ext.length).replace(/[-_.\s]+$/, '') + ext : name).replace(/[\\/:*?"<>|]+/g, '_');
    /*
     * ►► THE VIDEO GOES TO THE PHONE'S STORAGE, NOT ITS MEMORY. ◄◄
     * Kept in memory, a 700 MB montage (and the copy iOS makes of it for the
     * share sheet) got the app's page killed: a white screen, then the app
     * starting again on its home screen. Each piece is written to the app's
     * own storage on the phone the moment it arrives and let go, and the share
     * sheet is handed that file — a few MB of memory whatever the size.
     */
    const disk = await diskSaver(nice, total, !!(opts && opts.hold));
    if (!disk && total > MEMORY_MAX) {
      const e = new Error('This phone cannot hold a video this big for saving from inside the app.');
      e.code = 'TOO_BIG';
      throw e;
    }
    const parts = disk ? null : new Array(n);
    let next = 0, got = 0, shown = -1;
    const one = async (i) => {
      const a = i * CHUNK, b = Math.min(total, a + CHUNK) - 1;
      for (let tries = 0; ; tries++) {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 25000);
        // a Cancel lets go of the pieces already on their way, not only the next one
        const watch = opts && opts.stopped ? setInterval(() => { if (stopped()) ac.abort(); }, 250) : null;
        try {
          const r = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, signal: ac.signal, cache: 'no-store' });
          if (!(r.status === 206 || (r.status === 200 && n === 1))) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          if (blob.size !== b - a + 1) throw new Error('short piece');
          clearTimeout(timer); clearInterval(watch);
          return blob;
        } catch (e) {
          clearTimeout(timer); clearInterval(watch);
          if (stopped()) throw halt();
          if (tries >= 5) throw e;
          await new Promise((res) => setTimeout(res, 800 * (tries + 1)));
        }
      }
    };
    const worker = async () => {
      while (next < n) {
        if (stopped()) throw halt();
        const i = next++;
        const blob = await one(i);
        if (disk) await disk.write(i * CHUNK, blob); else parts[i] = blob;
        got += blob.size;
        const pc = Math.min(99, Math.floor((got / total) * 100));
        if (pc !== shown) { shown = pc; onPct(pc, got, total); }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker(), worker()]);
    } catch (e) {
      if (disk) disk.abort();
      if (e && (e.name === 'QuotaExceededError' || /quota/i.test(e.message || ''))) {
        const q = new Error(`Not enough free space on this phone — it needs about ${Math.ceil(total / 1048576)} MB.`); q.code = 'SPACE'; throw q;
      }
      throw e;
    }
    if (disk) {
      let f;
      try { f = await disk.finish(); } catch (e) { disk.abort(); throw e; }
      const file = f.type ? f : new File([f], nice, { type });
      saveFolderOf.set(file, disk.dir);
      return file;
    }
    return new File(parts, nice, { type });
  }

  /* Past this, a video is only ever saved through the phone's storage. */
  const MEMORY_MAX = 150 * 1024 * 1024;
  /*
   * ►► ONE SAVE NEVER WIPES ANOTHER. ◄◄
   * Every save used to begin by deleting the whole 'mw-saves' folder — "one
   * save at a time". Once an export brings its file down by itself, two of
   * them finishing together (or a Save tapped in Files while an export is
   * bringing its own down) is ordinary, and the second one deleted the file
   * the first was about to hand to the share sheet.
   *
   * So each save writes into a folder of its own (mw-saves/<n>/<name>: the
   * name stays the plain one the share sheet shows), and what a new save
   * clears is only what nobody holds any more: not a folder still being
   * written, and not one still offered behind a "Save Video" button — the
   * last few of those are kept, so a second tap is instant. A folder is let go
   * of when its video has gone to Photos (releaseSave), or when it is aborted.
   */
  const SAVE_DIR = 'mw-saves';
  const KEEP_OFFERED = 4;
  const liveSaves = new Set();       // folders being written, or still offered
  const offeredSaves = [];           // the finished ones, oldest first
  const saveFolderOf = new WeakMap(); // a File brought down -> its folder
  let saveSeq = 0;
  function releaseSave(file) {
    const d = file && saveFolderOf.get(file);
    if (!d) return;
    liveSaves.delete(d);
    const k = offeredSaves.indexOf(d); if (k >= 0) offeredSaves.splice(k, 1);
  }
  /* Is this File still readable? One kept in memory always is; one on the
     phone's storage only while its folder has not been let go of. */
  const saveAlive = (file) => !!file && (!saveFolderOf.has(file) || liveSaves.has(saveFolderOf.get(file)));
  /* Clear what nobody holds. False when this browser cannot list a folder. */
  async function sweepSaves(dir) {
    try {
      const gone = [];
      for await (const key of dir.keys()) if (!liveSaves.has(key)) gone.push(key);
      for (const key of gone) { try { await dir.removeEntry(key, { recursive: true }); } catch (e) { /* still open somewhere: next time */ } }
      return true;
    } catch (e) { return false; }
  }
  /*
   * A file in the app's private storage on the phone (the Origin Private File
   * System), written piece by piece. Through a writable stream where the
   * browser has one; otherwise from a small worker with a synchronous handle
   * (what older iPhones offer). Null when there is neither, or not the room.
   */
  async function diskSaver(name, total, hold = false) {
    let sub = null;
    try {
      if (!navigator.storage || !navigator.storage.getDirectory) return null;
      try {
        const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
        if (est && est.quota && est.quota - (est.usage || 0) < total * 1.05) {
          const q = new Error(`Not enough free space on this phone — it needs about ${Math.ceil(total / 1048576)} MB.`); q.code = 'SPACE'; throw q;
        }
      } catch (e) { if (e && e.code === 'SPACE') throw e; }
      const root = await navigator.storage.getDirectory();
      let saves = await root.getDirectoryHandle(SAVE_DIR, { create: true });
      sub = 's' + (++saveSeq) + '-' + Date.now().toString(36);
      liveSaves.add(sub);   // before the sweep, so a save started alongside cannot take it
      // A browser that cannot list a folder cannot sweep one: with nothing else
      // held it is cleared the old way, whole — or the phone would fill up.
      if (!(await sweepSaves(saves)) && liveSaves.size === 1) {
        try { await root.removeEntry(SAVE_DIR, { recursive: true }); } catch (e) {}
        saves = await root.getDirectoryHandle(SAVE_DIR, { create: true });
      }
      const dir = await saves.getDirectoryHandle(sub, { create: true });
      const fh = await dir.getFileHandle(name, { create: true });
      // finished: offered from now on, and only the last few are kept — unless
      // it is HELD (a Save all's: kept until it has gone to Photos, releaseSave)
      const offered = () => {
        if (hold) return;
        offeredSaves.push(sub);
        while (offeredSaves.length > KEEP_OFFERED) liveSaves.delete(offeredSaves.shift());
      };
      const drop = () => { liveSaves.delete(sub); };
      if (typeof fh.createWritable === 'function') {
        const w = await fh.createWritable({ keepExistingData: false });
        let chain = Promise.resolve();
        return {
          dir: sub,
          // one write at a time, in whatever order the pieces arrive (each at its own place)
          write: (pos, blob) => (chain = chain.then(() => w.write({ type: 'write', position: pos, data: blob }))),
          finish: async () => { await chain; await w.close(); offered(); return fh.getFile(); },
          abort: () => { try { w.abort(); } catch (e) {} drop(); },
        };
      }
      const src = "let h=null;onmessage=async(e)=>{const d=e.data;try{if(d.op==='open'){const r=await navigator.storage.getDirectory();const s=await r.getDirectoryHandle('" + SAVE_DIR + "',{create:true});const dir=await s.getDirectoryHandle(d.dir,{create:true});const f=await dir.getFileHandle(d.name,{create:true});h=await f.createSyncAccessHandle();h.truncate(0);}else if(d.op==='write'){h.write(new Uint8Array(await d.blob.arrayBuffer()),{at:d.pos});}else if(d.op==='close'){h.flush();h.close();h=null;}postMessage({id:d.id});}catch(err){postMessage({id:d.id,err:String((err&&err.name==='QuotaExceededError'?'quota ':'')+((err&&err.message)||err))});}};";
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      const wk = new Worker(url);
      let seq = 0; const pend = new Map();
      wk.onmessage = (e) => { const q = pend.get(e.data.id); pend.delete(e.data.id); if (q) { if (e.data.err) q.rej(new Error(e.data.err)); else q.res(); } };
      const call = (msg) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); wk.postMessage(Object.assign({ id }, msg)); });
      try { await call({ op: 'open', dir: sub, name }); } catch (e) { wk.terminate(); URL.revokeObjectURL(url); drop(); throw e; }
      return {
        dir: sub,
        write: (pos, blob) => call({ op: 'write', pos, blob }),
        finish: async () => { await call({ op: 'close' }); wk.terminate(); URL.revokeObjectURL(url); offered(); return fh.getFile(); },
        abort: () => { try { wk.terminate(); URL.revokeObjectURL(url); } catch (e) {} drop(); },
      };
    } catch (e) {
      if (sub) liveSaves.delete(sub);
      if (e && e.code === 'SPACE') throw e;
      return null;
    }
  }
  /*
   * The files last brought down for saving, kept so a second tap (the share
   * sheet closed by mistake, "Not now" on the card) does not download hundreds
   * of MB again. A few of them, not one: two exports finishing together each
   * keep their own (an entry whose file on the phone has since been let go of
   * is simply fetched again).
   */
  const saveCache = new Map();   // path -> { parts, make }
  function cachedSave(p) {
    const c = saveCache.get(p);
    if (!c) return null;
    if (c.parts.some((x) => !x.saved && x.file && !saveAlive(x.file))) { saveCache.delete(p); return null; }
    return c;
  }
  function rememberSave(p, entry) {
    saveCache.delete(p);
    saveCache.set(p, entry);
    while (saveCache.size > KEEP_OFFERED) saveCache.delete(saveCache.keys().next().value);
  }
  /*
   * How a save SHOWS itself. Out of the viewer it is the island; the viewer
   * passes its own (the Save button itself fills up, then becomes "Save to
   * Photos") — the island sat underneath the full-screen viewer, so tapping
   * Save there looked like nothing happened at all.
   */
  function islandSaveUi(name) {
    const id = 'save-' + name;
    const of = (k, n) => (n > 1 ? ` part ${k + 1} of ${n}` : '');
    return {
      making: (pc, q) => island({ id, title: `Saving to your phone… ${pc}%`, spin: true, sticky: true,
        sub: `Step 1 of 2 · making a ${q === 'fast' ? '720p' : '1080p'} copy your iPhone can save · ${name}` }),
      progress: (pc, got, total, k, n, two) => island({ id, title: `Saving to your phone${of(k, n)}… ${pc}%`, spin: true, sticky: true,
        sub: `${two ? 'Step 2 of 2 · ' : ''}downloading${total ? ` ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB` : ''} · ${name}` }),
      ready: (share, k, n) => island({ id, kind: 'good', title: `Ready to save${of(k, n)}`, sub: name, sticky: true,
        action: { label: 'Save Video', onClick: () => { islandHide(id); share(); } } }),
      done: (n) => island({ id, kind: 'good', title: n > 1 ? `All ${n} parts saved` : 'Saved', sub: 'Find it in Photos (or Files, if you chose that)', ms: 4000 }),
      cancelled: (share, k, n) => island({ id, kind: 'info', title: `Not saved yet${of(k, n)}`, sub: name, sticky: true,
        action: { label: 'Save Video', onClick: () => { islandHide(id); share(); } } }),
      fail: (msg) => island({ id, kind: 'warn', title: 'Could not save it', sub: msg, ms: 6000 }),
    };
  }
  /*
   * ►► NEVER MORE THAN THE SHARE SHEET CAN CARRY. ◄◄
   * Safari reads a shared file whole into the app's memory before the share
   * sheet sees it, so a 500 MB montage got the app killed (white screen) and
   * the sheet opened on nothing (a blank white card) — wherever the download
   * itself had been kept. A video bigger than this is first made into a phone
   * copy on the studio (phonecopy.js): one video under it whenever that can
   * look right (up to ~16 minutes), numbered parts only for a longer one.
   */
  const PHONE_PART_MAX = 140 * 1024 * 1024;   // the same as phonecopy.js PART_MAX
  const MAKE_SHARE = 75;                      // of the one Save bar: making the phone copy (the download is the rest)
  async function offerDownload(p, size, ui) {
    const key = 'dl' + Math.random();
    window.__keepAwake(key, true);
    try { return await offerDownloadInner(p, size, ui); } finally { window.__keepAwake(key, false); }
  }
  async function offerDownloadInner(p, size, ui) {
    if (!p) return;
    const name = String(p).split(/[\\/]/).pop();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) {
      // A folder (an export finishing) — what was just made, with Save all; else the file list.
      if (cloud.downloads.length) { const b = $('#cloudDownloads'); if (b) { b.click(); return; } }
      openFilesModal();
      return;
    }
    if (!cloud.downloads.some((d) => d.path === p)) cloud.downloads.unshift({ path: p, name, at: Date.now() });
    renderDownloadCount();
    if (onPhone() && navigator.canShare && navigator.share) {
      const show = ui || islandSaveUi(name);
      const failed = (e) => {
        if (e && e.name === 'AbortError') return;
        if (e && e.code === 'SPACE') return show.fail(e.message);
        if (e && e.code === 'TOO_BIG') { show.fail('Too big to save from inside the app on this phone — opening it in the player: tap Share, then “Save Video”.'); openInPlayer(p); return; }
        if (e && e.code === 'COPY') return show.fail(e.message);
        show.fail('The download kept dropping. Check the signal and try again.');
      };
      try {
        const cached = cachedSave(p);
        let parts = cached ? cached.parts : null;
        let make = 0;
        if (!parts) {
          let list = [{ path: p, size: Number(size) || 0 }];
          let needed = !size || size > PHONE_PART_MAX;
          /*
           * 1080p or 720p? Asked only when a copy has to be made: the full-HD
           * one takes a few minutes on a small server, the 720p one about half
           * that. A copy already made (the one started when a montage
           * finished) is used without asking.
           */
          let quality = 'hd';
          let ready = false;   // the copy is already made (one is started when a montage finishes)
          if (needed) {
            let stt = null;
            try { stt = await call('video:phoneCopyStatus', { input: p }); } catch (e) { /* an older studio: just make it */ }
            if (stt && stt.needed === false) needed = false;
            else if (stt && stt.needed && !(stt.hd && stt.hd.ready) && show.choose) quality = await show.choose(stt);
            ready = !!(stt && stt[quality] && stt[quality].ready);
          }
          /*
           * ►► ONE BAR FOR THE WHOLE SAVE. ◄◄ "Making a phone copy… 99%" and then
           * "Getting ready… 0%" read as two jobs, the second starting from
           * nothing. Now it is one number, start to finish: the copy is the first
           * MAKE_SHARE of it (on the Oracle server a 10-minute copy is a few
           * minutes, the download of the 129 MB it makes under one), the
           * download the rest; with no copy to make, the download is all of it.
           */
          // (a copy already made is no copy to make: the download is the whole bar)
          // An export bringing its own file down says how much of ITS number the
          // copy is (ui.makeShare — see deliverFile); a Save on its own is 75/25.
          make = needed && !ready ? (ui && ui.makeShare != null ? ui.makeShare : MAKE_SHARE) : 0;
          if (needed) {
            if (make) show.making(0, quality);
            const jobId = 'pc' + Date.now().toString(36);
            const off = window.api.onJobProgress((d) => { if (make && d && d.jobId === jobId) show.making(Math.round((Math.min(99, d.percent || 0) * make) / 100), quality); });
            /*
             * Cancel while the copy is being made: stop WAITING for it. The copy
             * itself carries on at the studio and is kept there, so the next
             * Save of this video finds it made and goes straight to the download.
             */
            try {
              const got = await unlessStopped(call('video:phoneCopy', { input: p, jobId, quality }), ui && ui.stopped);
              if (got && Array.isArray(got.parts) && got.parts.length) list = got.parts;
            } catch (e) {
              if (e && e.name === 'AbortError') throw e;
              const c = new Error('The studio could not make a copy for your phone' + (e && e.message ? ' — ' + String(e.message).split('\n')[0].slice(0, 120) : '') + '. Try again.');
              c.code = 'COPY'; throw c;
            } finally { off(); }
          }
          const stem = name.replace(/\.[^.]+$/, '');
          parts = list.map((x, i) => ({ path: x.path, size: x.size, file: null, saved: false,
            name: list.length > 1 ? `${stem}-part${i + 1}of${list.length}.mp4` : (x.path === p ? name : stem + '.mp4') }));
          rememberSave(p, { parts, make });
        } else make = cached.make || 0;
        const n = parts.length;
        const step = async (k) => {
          while (k < n && parts[k].saved) k++;
          if (k >= n) { saveCache.delete(p); return show.done(n); }
          const part = parts[k];
          if (!part.file) {
            // where the whole save has got: the copy's share, then this part's place among the parts
            const whole = (pc) => Math.min(99, Math.round(make + (((k + pc / 100) / n) * (100 - make))));
            show.progress(whole(0), 0, part.size || 0, k, n, make > 0);
            part.file = await fetchForSaving(part.path, part.name, part.size, (pc, got, total) => show.progress(whole(pc), got, total, k, n, make > 0),
              { stopped: ui && ui.stopped });
          }
          if (!navigator.canShare({ files: [part.file] })) {
            show.fail('This phone cannot save it from here — opening it in the player');
            openInPlayer(part.path);
            return;
          }
          /*
           * The share sheet only opens straight after a tap — a download has
           * long used that tap up, and the sheet silently refused. So when it
           * is ready, it asks for one more tap.
           *
           * ONLY the file is shared: with a title beside it iOS shares a
           * second, TEXT item — the sheet then offers to save a .txt and
           * leaves "Save Video" out.
           */
          const share = () => navigator.share({ files: [part.file] }).then(() => {
            part.saved = true; releaseSave(part.file); part.file = null;
            step(k + 1).catch(failed);
          }, (e) => {
            if (e && e.name === 'AbortError') return show.cancelled(share, k, n);
            show.fail('The share sheet would not open — opening it in the player instead');
            openInPlayer(part.path);
          });
          show.ready(share, k, n);
        };
        await step(0);
        return;
      } catch (e) {
        failed(e);
        return;
      }
    }
    if (onPhone() && isStandalone()) { if (ui && ui.player) ui.player(); openInPlayer(p); return; }   // the phone's own player — never a blank page
    const a = document.createElement('a');
    a.href = downloadUrl(p);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (ui && ui.browser) ui.browser();
  }

  /*
   * ►► AN EXPORT ENDS ON THE PHONE, NOT ON THE STUDIO. ◄◄
   *
   * Tapping Export on an iPhone used to run one bar to 100%, close it, say
   * "Saved" — and only then start bringing the file down, under a second bar
   * of its own in the island ("Saving to your phone… 0%"). Measured on a 20 s
   * edit: the export's 100% at 3.6 s, "Saved" at 3.8 s, the second bar from
   * 4.3 s. That second bar was not even meant: the desk's finishedFile, which
   * replaced this page's, opened the file 400 ms after every export, and here
   * "open the file" is "download it".
   *
   * Now the download IS the end of the export. tasks.js plans it as the last
   * slices of the export's own chain (__deliverPlan says how much of the work it
   * is) and runs it inside the task (__deliverFile does it), so the one number
   * the operator is watching carries on from the encode to "on your phone" —
   * in the overlay, or on the chip and the jobs sheet for an export sent to
   * the background — with the same Cancel and ⇥ Run in the background.
   *
   * What it CANNOT do is the last step: the share sheet opens only straight
   * after a tap, and a download has long used that tap up. So it ends on a
   * "Save to Photos" button where the export was being watched (the overlay
   * becomes it), or "Ready to save · Save Video" in the island for one that
   * ran in the background. Nothing here says "Saved" until Photos has it.
   *
   * The desk, and a browser that cannot share files, plan nothing and deliver
   * nothing: their exports end exactly as before.
   */
  const canSaveHere = () => onPhone() && !!navigator.canShare && !!navigator.share;
  /*
   * How big the export will roughly be — only to decide whether a phone copy
   * will be needed (over PHONE_PART_MAX) and so how the last slices of the bar
   * are shared out. The exports are constant-quality, so this is a guess; a
   * wrong one changes the PACE of the end of the bar, never where it ends:
   *   • a copy planned but not needed: the download is spread over both slices;
   *   • a copy needed but not planned: it rides inside the download's slice,
   *     split as a Save on its own splits it (MAKE_SHARE).
   */
  const KBPS_GUESS = { '480p': 2500, '720p': 4500, '1080p': 8000, '4k': 30000 };
  window.__deliverPlan = ({ durationSec, quality } = {}) => {
    if (!canSaveHere()) return [];
    const bytes = (Number(durationSec) || 0) * (KBPS_GUESS[quality] || KBPS_GUESS['1080p']) * 125;
    return bytes > PHONE_PART_MAX ? ['phonecopy', 'tophone'] : ['tophone'];
  };
  /**
   * Bring a finished export onto this phone, reporting into the caller's own
   * number. `hooks`:
   *   copyShare   — how much of the delivery's 0-100 the phone copy is (null: MAKE_SHARE)
   *   say(msg)    — the words under the number
   *   progress(n) — 0-100 of the whole delivery
   *   background()— is the export being watched, or running behind the studio?
   *   stopped()   — Cancel / Stop was pressed
   * Resolves with { show, ready: true } once the first (or only) part is on the
   * phone — show() puts up the tap the share sheet needs — or with { show,
   * ready: false } when it is not (stopped, no room, no signal: show() says so);
   * null when this is not a phone that can save from the app.
   */
  function deliverFile(p, hooks) {
    if (!p || !canSaveHere()) return Promise.resolve(null);
    const name = String(p).split(/[\\/]/).pop();
    if (!/\.[A-Za-z0-9]{2,5}$/.test(name)) return Promise.resolve(null);
    const mb = (b) => Math.max(1, Math.round(b / 1048576)) + ' MB';
    return new Promise((resolve) => {
      let after = null, settled = false, copied = false;
      const settle = (show, ready = false) => { if (!settled) { settled = true; resolve({ show, ready }); } };
      // Where the save goes on once the export is over: the card where it was
      // watched, or the island for one that ran in the background. "Keep
      // editing" on the card hands the rest of it to the island.
      const fin = () => after || (after = hooks.background()
        ? islandSaveUi(name)
        : overlaySaveUi(name, { onLater: () => { after = islandSaveUi(name); } }));
      const share0 = () => (copied ? (hooks.copyShare != null ? hooks.copyShare : MAKE_SHARE) : 0);
      const ui = {
        makeShare: hooks.copyShare,
        stopped: hooks.stopped,
        making: (pc, q) => {
          if (settled) return fin().making(pc, q);
          copied = true;
          hooks.say(`📲 Making a ${q === 'fast' ? '720p' : '1080p'} copy your iPhone can save…`);
          hooks.progress(pc);
        },
        progress: (pc, got, total, k, n, two) => {
          // a later part, after the first went to Photos: the export is long over
          if (settled) return fin().progress(pc, got, total, k, n, two);
          // THIS part only: the export is done when part 1 is on the phone
          const b = share0(), part = total ? Math.min(1, got / total) : 0;
          hooks.say(`📲 Getting it onto your phone${n > 1 ? ` (part 1 of ${n})` : ''}${total && got ? ` — ${mb(got)} of ${mb(total)}` : '…'}`);
          hooks.progress(b + part * (100 - b));
        },
        ready: (share, k, n) => (settled ? fin().ready(share, k, n) : settle(() => fin().ready(share, k, n), true)),
        cancelled: (share, k, n) => fin().cancelled(share, k, n),
        done: (n) => fin().done(n),
        fail: (msg) => (settled ? fin().fail(msg) : settle(() => island({ kind: 'warn', title: 'Your video is made — it could not come to the phone',
          sub: `${msg} It’s in ⬇ Saved.`, ms: 9000 }))),
      };
      hooks.say('📲 Getting it onto your phone…');
      offerDownload(p, 0, ui).catch(() => {}).then(() => settle(() => island({ kind: 'info', title: 'Not on your phone yet',
        sub: 'Your video is made — save it from ⬇ Saved whenever you like', ms: 6000 })));
    });
  }
  window.__deliverFile = deliverFile;

  /*
   * ►► THE LAST TAP, WHERE THE EXPORT WAS WATCHED. ◄◄
   * The overlay that counted the export to 100% becomes the button that puts
   * it in Photos — the thumb is already there, the eye is already there. The
   * same interface as islandSaveUi and the viewer's, so offerDownload drives
   * all three alike. Save to Photos calls the share sheet INSIDE the tap,
   * nothing awaited first: that tap is the user activation iOS demands.
   */
  const OV_TICK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  function clearOverlaySave() {
    const o = $('#overlay'); if (!o) return;
    o.classList.remove('ov-ready', 'ov-save');
    o.querySelectorAll('.overlay-save-acts, .overlay-tick').forEach((x) => x.remove());
  }
  function overlaySaveUi(name, opts = {}) {
    const o = $('#overlay'), box = o && o.querySelector('.overlay-box');
    if (!o || !box) return islandSaveUi(name);
    const mb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
    let share = null, acts = null;
    // a headline and what to do next, or (while it is still coming) one line
    const msg = (t, sub) => {
      const m = $('#overlayMsg'); if (!m) return;
      if (sub) m.innerHTML = `<b class="ov-title">${escHtml(t)}</b><span class="ov-sub">${escHtml(sub)}</span>`;
      else m.textContent = t;
    };
    const close = () => { clearOverlaySave(); hideOverlay(); };
    function onTap(e) {
      const b = e.target.closest('[data-ov]'); if (!b) return;
      if (b.dataset.ov === 'save') {
        if (!share) return;
        const f = share; share = null;
        b.disabled = true;
        b.querySelector('span').textContent = 'Opening…';
        f();
        return;
      }
      // "Not now" (or "Keep editing" while a later part comes down): the file
      // stays on the phone, and a Save from ⬇ Saved later is instant.
      const waiting = !!share;
      share = null;
      close();
      if (opts.onLater) opts.onLater();
      if (waiting) island({ kind: 'info', title: 'It’s in ⬇ Saved', sub: 'Save it to Photos from there whenever you like', ms: 5000 });
    }
    // Take the overlay over: no Cancel, no ⇥ — the export is finished.
    const mount = () => {
      clearTimeout(_hideTimer); _hideTimer = null;
      o.classList.toggle('on-top', !!document.querySelector('#capModal:not(.hidden)'));
      o.classList.remove('hidden');
      o.classList.add('ov-save');
      setJobBatch(null);
      showCancel(null);
      const bg = $('#overlayBackground'); if (bg) { bg.classList.add('hidden'); bg.onclick = null; }
      if (!acts || !acts.isConnected) {
        clearOverlaySave();
        o.classList.add('ov-save');
        const tick = document.createElement('div');
        tick.className = 'overlay-tick';
        tick.innerHTML = OV_TICK;
        box.insertBefore(tick, box.firstChild);
        acts = document.createElement('div');
        acts.className = 'overlay-save-acts';
        acts.innerHTML = `<button type="button" class="overlay-save" data-ov="save">${mi('download')}<span>Save to Photos</span></button>`
          + '<button type="button" class="overlay-later" data-ov="later">Not now</button>';
        acts.addEventListener('click', onTap);
        box.appendChild(acts);
      }
      return acts;
    };
    const ready = (sh, title, sub, label) => {
      share = sh;
      const a = mount();
      o.classList.add('ov-ready');
      setProgress(100);
      msg(title, sub);
      const b = a.querySelector('[data-ov="save"]');
      b.disabled = false;
      b.querySelector('span').textContent = label;
      a.querySelector('[data-ov="later"]').textContent = 'Not now';
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
    };
    const busy = (pc, text) => {
      share = null;
      const a = mount();
      o.classList.remove('ov-ready');
      setProgress(pc);
      msg(text);
      a.querySelector('[data-ov="later"]').textContent = 'Keep editing';
    };
    const label = (k, n) => (n > 1 ? `Save part ${k + 1} of ${n}` : 'Save to Photos');
    return {
      making: (pc, q) => busy(pc, `📲 Making a ${q === 'fast' ? '720p' : '1080p'} copy your iPhone can save…`),
      progress: (pc, got, total, k, n) => busy(pc, `📲 Getting ${n > 1 ? `part ${k + 1} of ${n}` : 'it'} onto your phone${total && got ? ` — ${mb(got)} of ${mb(total)}` : '…'}`),
      ready: (sh, k, n) => ready(sh, n > 1 ? `Part ${k + 1} of ${n} is on your phone` : 'Your video is ready',
        `Tap “${label(k, n)}”, then choose “Save Video”.`, label(k, n)),
      cancelled: (sh, k, n) => ready(sh, 'Not saved yet', `Tap “${label(k, n)}”, then choose “Save Video”.`, label(k, n)),
      done: (n) => { close(); island({ kind: 'good', title: 'Saved to Photos', sub: n > 1 ? `All ${n} parts — find them in your Photos` : 'Find it in your Photos (or Files, if you chose that)', ms: 4500 }); },
      fail: (m) => { close(); island({ kind: 'warn', title: 'Could not save it', sub: m, ms: 8000 }); },
    };
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
      + '<p class="cv-save-note hidden" aria-live="polite"></p>'
      + '<div class="cv-acts">'
      + `<button type="button" class="cv-act cv-save" data-cv="save"><i class="cv-fill"></i>${mi('download')}<span>Save</span></button>`
      + (isVideo ? `<button type="button" class="cv-act" data-cv="studio">${mi('film')}<span>Edit</span></button>` : '')
      + (isVideo && /^montage-.*\.mp4$/i.test(name) && window.MWSocial && window.MWSocial.editMontage ? `<button type="button" class="cv-act" data-cv="shots">${mi('layers')}<span>Shots</span></button>` : '')
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
      if (act === 'save') return viewerSave(v, p);
      if (act === 'shots') { close(); const fm = $('#cloudFilesModal'); if (fm) fm.classList.add('hidden'); return window.MWSocial.editMontage(p); }
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
  /*
   * ►► SAVING, WHERE YOU CAN SEE IT. ◄◄
   * The Save button itself shows every step: it fills up as the video comes
   * down (with how much of how many MB), turns into "Save to Photos" when it
   * is on the phone, and says "Saved" when the share sheet is done — with a
   * line above the buttons saying what is happening and what to tap next.
   */
  function viewerSave(v, p) {
    const btn = v.querySelector('[data-cv="save"]');
    const note = v.querySelector('.cv-save-note');
    if (!btn || btn.dataset.state === 'loading' || btn.dataset.state === 'sharing' || btn.dataset.state === 'choose') return;
    const label = btn.querySelector('span');
    const fill = btn.querySelector('.cv-fill');
    // ready: this tap is the one the share sheet needs
    if (btn.dataset.state === 'ready' && btn._share) { go('sharing', 'Opening…', 'Choose “Save Video” to put it in Photos.'); btn._share(); return; }
    function go(state, text, line, pc) {
      btn.dataset.state = state;
      btn.className = 'cv-act cv-save cv-' + state;
      label.textContent = text;
      if (fill) fill.style.width = (pc == null ? (state === 'loading' ? 0 : 100) : pc) + '%';
      if (note) { note.textContent = line || ''; note.classList.toggle('hidden', !line); }
      return false;
    }
    const mb = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.max(1, Math.round(b / 1048576)) + ' MB');
    const of = (k, n) => (n > 1 ? ` part ${k + 1} of ${n}` : '');
    const ui = {
      making: (pc, q) => go('loading', `Saving ${pc}%`,
        `Step 1 of 2: making a ${q === 'fast' ? '720p' : '1080p'} copy your iPhone can save. Keep the app open.`, pc),
      /* two buttons above Save: full HD, or quicker */
      choose: (stt) => new Promise((resolve) => {
        go('choose', 'Pick ↑', '');
        const old = v.querySelector('.cv-q'); if (old) old.remove();
        const hint = (x, slow) => (x && x.ready ? 'Ready now' : x && x.making ? `Being made · ${x.pct || 0}%` : slow);
        const box = document.createElement('div');
        box.className = 'cv-q';
        box.innerHTML = `<button type="button" class="cv-q-b cv-q-hd" data-q="hd"><b>1080p · Best</b><small>${escHtml(hint(stt.hd, 'Takes a few minutes'))}</small></button>`
          + `<button type="button" class="cv-q-b" data-q="fast"><b>720p · Faster</b><small>${escHtml(hint(stt.fast, 'Quicker · smaller file'))}</small></button>`;
        box.addEventListener('click', (e) => {
          const b = e.target.closest('[data-q]'); if (!b) return;
          box.remove();
          resolve(b.dataset.q === 'fast' ? 'fast' : 'hd');
        });
        v.querySelector('.cv-acts').before(box);
      }),
      progress: (pc, got, total, k, n, two) => go('loading', n > 1 ? `Part ${k + 1}/${n} · ${pc}%` : `Saving ${pc}%`,
        `${two ? 'Step 2 of 2: getting' : 'Getting'}${of(k, n) || ' the video'} onto your phone${total ? ` — ${mb(got)} of ${mb(total)}` : '…'} Keep the app open.`, pc),
      ready: (share, k, n) => {
        btn._share = share;
        go('ready', n > 1 ? `Save part ${k + 1} of ${n}` : 'Save to Photos',
          n > 1 ? `Part ${k + 1} of ${n} is on your phone. Tap “Save part ${k + 1} of ${n}”, then choose “Save Video”.`
            : 'It’s on your phone. Tap “Save to Photos”, then choose “Save Video”.');
        try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {}
      },
      done: (n) => { btn._share = null; go('done', 'Saved ✓', n > 1 ? `All ${n} parts saved — find them in your Photos.` : 'Saved — find it in your Photos (or Files, if you chose that).'); },
      cancelled: (share, k, n) => { btn._share = share; go('ready', n > 1 ? `Save part ${k + 1} of ${n}` : 'Save to Photos', `Not saved yet — tap “${n > 1 ? `Save part ${k + 1} of ${n}` : 'Save to Photos'}” and choose “Save Video”.`); },
      fail: (msg) => { btn._share = null; go('fail', 'Try again', msg); },
      player: () => go('done', 'Save', 'Opening it in the player: tap Share, then “Save Video”.'),
      browser: () => go('done', 'Saved ✓', 'Your browser is downloading it.'),
    };
    go('loading', 'Starting…', 'Getting the video onto your phone…', 0);
    offerDownload(p, (findFile(p) || {}).size, ui).catch(() => ui.fail('Something went wrong. Try again.'));
  }
  /*
   * ►► SAVE ALL — EVERY SHORT OF AN EXPORT ALL, TO PHOTOS. ◄◄
   * The same road as one video (a phone copy when one is too big, the
   * download kept on the phone's storage, the share sheet), but several
   * videos to a tap: the share sheet takes a few files at once and offers
   * “Save N Videos”. Never more than PHONE_PART_MAX in one share — the whole
   * share is read into memory, which is what crashed the app at 500 MB.
   */
  async function sizeOnServer(p) {
    try {
      const r = await fetch(downloadUrl(p), { headers: { Range: 'bytes=0-0' }, cache: 'no-store' });
      const n = Number((/\/(\d+)$/.exec(r.headers.get('content-range') || '') || [])[1]) || 0;
      try { await r.arrayBuffer(); } catch (e) {}
      return n;
    } catch (e) { return 0; }
  }
  /*
   * The shorts of a Save all, brought down ahead of the tap — by an Export all
   * started on this phone (bringBatchDown), or by an earlier Save all whose
   * share sheet was never finished. Each is kept on the phone's storage until
   * it has gone to Photos, so the tap that saves them is instant. Only one
   * batch's worth is kept: a new Export all lets go of the last one's.
   */
  const prefetched = new Map();   // path -> [{ file, size, saved }]
  function dropPrefetched() {
    for (const parts of prefetched.values()) for (const x of parts) if (!x.saved) releaseSave(x.file);
    prefetched.clear();
  }
  /* The parts of this short already on the phone, or null — one let go of means fetch it again. */
  function partsOnPhone(p) {
    const parts = prefetched.get(p);
    if (!parts) return null;
    if (parts.some((x) => !x.saved && !saveAlive(x.file))) { parts.forEach((x) => releaseSave(x.file)); prefetched.delete(p); return null; }
    return parts;
  }
  const saveItemsOf = (paths) => (paths || []).filter((p) => /\.(mp4|mov|m4v)$/i.test(String(p))).map((p) => ({
    path: p, name: String(p).split(/[\\/]/).pop(), size: (findFile(p) || {}).size || 0, parts: null, done: false,
  }));
  async function sizeItems(items) { for (const it of items) if (!it.size) it.size = await sizeOnServer(it.path); }
  /* Wait for `work`, unless `stopped()` turns true first — then it is an AbortError. */
  function unlessStopped(work, stopped) {
    if (typeof stopped !== 'function') return work;
    let poll = null;
    const gaveUp = new Promise((resolve, reject) => {
      poll = setInterval(() => { if (stopped()) { const e = new Error('Stopped'); e.name = 'AbortError'; reject(e); } }, 300);
    });
    return Promise.race([work, gaveUp]).finally(() => clearInterval(poll));
  }
  /*
   * ►► ONE NUMBER FOR A WHOLE SAVE ALL. ◄◄
   * The button read "Downloading 2 of 5 · 37%" with the fill at THAT short's
   * 37% — so it ran to the end and back to nothing five times. It is now the
   * whole save, weighted by bytes: a 90 MB short is three times the work of a
   * 30 MB one. A short that needs a phone copy first is the same weight, its
   * copy the first MAKE_SHARE of it, as for one video. A short that could not
   * be got counts as done, so the number never waits on it.
   */
  function saveMeter(items) {
    const known = items.filter((it) => it.size > 0);
    const avg = known.length ? known.reduce((n, it) => n + it.size, 0) / known.length : 1;
    const w = items.map((it) => (it.size > 0 ? it.size : avg));
    const W = w.reduce((a, b) => a + b, 0) || 1;
    const f = items.map(() => 0);
    return {
      set(i, v) { f[i] = Math.max(f[i], Math.max(0, Math.min(1, Number(v) || 0))); },
      pct() { let n = 0; for (let i = 0; i < f.length; i++) n += w[i] * f[i]; return Math.min(100, Math.floor((n / W) * 100)); },
    };
  }
  /**
   * Bring one short of a Save all onto the phone: its phone copy first when it
   * is too big for a share on its own (1080p, as for one video), then each part.
   * `o`: meter, say(text, kind, got, total), stopped, beforePart(part) (a
   * chance to share what is waiting before more comes down), afterPart(entry).
   * Every file is held (not swept) until it has gone to Photos — releaseSave.
   */
  async function fetchShort(it, i, o) {
    const mb = (b) => Math.max(1, Math.round(b / 1048576)) + ' MB';
    let parts = [{ path: it.path, size: it.size }];
    let make = 0;
    if (!it.size || it.size > PHONE_PART_MAX) {
      const stt = await call('video:phoneCopyStatus', { input: it.path }).catch(() => null);
      if (!stt || stt.needed !== false) {
        make = stt && stt.hd && stt.hd.ready ? 0 : MAKE_SHARE / 100;
        const jobId = 'pc' + Date.now().toString(36) + i;
        const off = window.api.onJobProgress((d) => {
          if (!d || d.jobId !== jobId) return;
          const pc = Math.round(d.percent || 0);
          o.meter.set(i, (make * pc) / 100);
          o.say(`Making a phone copy… ${pc}%`, 'copy');
        });
        o.say('Making a phone copy…', 'copy');
        try {
          const got = await unlessStopped(call('video:phoneCopy', { input: it.path, jobId }), o.stopped);
          if (got && got.parts && got.parts.length) parts = got.parts;
        } finally { off(); }
      }
    }
    const stem = it.name.replace(/\.[^.]+$/, '');
    for (const part of parts) if (!part.size) part.size = await sizeOnServer(part.path);   // the bundle's limit needs every size
    const bytes = parts.reduce((n, x) => n + (x.size || 0), 0) || 1;
    const out = [];
    let before = 0;
    try {
      for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        const nm = parts.length > 1 ? `${stem}-part${k + 1}of${parts.length}.mp4` : (part.path === it.path ? it.name : stem + '.mp4');
        if (o.beforePart) await o.beforePart(part);
        o.say('Downloading…', 'down', 0, part.size || 0);
        const file = await fetchForSaving(part.path, nm, part.size, (pc, got, tot) => {
          o.meter.set(i, make + (1 - make) * ((before + got) / bytes));
          o.say(`Downloading ${pc}%${tot ? ' · ' + mb(got) + ' of ' + mb(tot) : ''}`, 'down', got, tot);
        }, { hold: true, stopped: o.stopped });
        before += part.size || file.size;
        const entry = { file, size: file.size, saved: false, i };
        out.push(entry);
        if (o.afterPart) await o.afterPart(entry);
      }
    } catch (e) { if (e && typeof e === 'object') e.parts = out; throw e; }
    o.meter.set(i, 1);
    return out;
  }
  /*
   * The last 15% of an Export all started on this phone (see ►► EXPORT ALL
   * ENDS ON THE PHONE TOO): every short onto the phone's storage, one after
   * another, reported as one bytes-weighted number. A full phone stops it —
   * whatever did not fit is fetched by the Save all panel when it is tapped.
   */
  async function prefetchShorts(paths, { stopped, progress }) {
    const mb = (b) => Math.max(1, Math.round(b / 1048576)) + ' MB';
    dropPrefetched();
    const items = saveItemsOf(paths);
    await sizeItems(items);
    const meter = saveMeter(items);
    const N = items.length;
    let got = 0, space = null;
    for (let i = 0; i < N; i++) {
      if (stopped()) break;
      const it = items[i];
      try {
        const parts = await fetchShort(it, i, {
          meter, stopped,
          say: (text, kind, g, t) => progress(meter.pct(), kind === 'copy'
            ? `📲 Making a phone copy of short ${i + 1} of ${N}…`
            : `📲 Getting short ${i + 1} of ${N} onto your phone${t && g ? ` — ${mb(g)} of ${mb(t)}` : '…'}`),
        });
        prefetched.set(it.path, parts);
        got++;
      } catch (e) {
        ((e && e.parts) || []).forEach((x) => releaseSave(x.file));
        meter.set(i, 1);
        if (e && e.code === 'SPACE') { space = e.message; break; }
        if (e && e.name === 'AbortError') break;
      }
      progress(meter.pct());
    }
    return { got, space };
  }
  /*
   * The parts that can go to the share sheet straight away, in order: what is
   * already on the phone from the first short not yet saved, up to one share's
   * worth (PHONE_PART_MAX). Empty when the first short still has to come down.
   */
  function firstBundleOf(items) {
    const b = [];
    let bytes = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.done) continue;
      if (!it.parts) break;
      for (const x of it.parts) {
        if (x.saved) continue;
        if (b.length && bytes + x.size > PHONE_PART_MAX) return b;
        x.i = i; b.push(x); bytes += x.size;
      }
    }
    if (b.length > 1 && !navigator.canShare({ files: b.map((x) => x.file) })) return b.slice(0, 1);
    return b;
  }
  /**
   * Save all. `opts.tapped`: this call is the tap itself (an island's Save all,
   * a button), so whatever is already on the phone goes to the share sheet in
   * this very tap — no second "are you sure" tap for files that are ready.
   */
  function saveAll(paths, opts = {}) {
    const items = saveItemsOf(paths);
    if (!items.length) return;
    if (!canSaveHere()) { items.forEach((it) => offerDownload(it.path)); return; }
    for (const it of items) {
      it.parts = partsOnPhone(it.path);
      if (it.parts && it.parts.length && it.parts.every((x) => x.saved)) it.done = true;
    }
    // The share sheet, FIRST — inside the tap, before anything is awaited.
    let first = null;
    if (opts.tapped) {
      const fb = firstBundleOf(items);
      if (fb.length) first = { bundle: fb, sharing: navigator.share({ files: fb.map((x) => x.file) }) };
    }
    const left = items.filter((it) => !it.done);
    /*
     * Everything was on the phone and fitted in that one share: there is no
     * panel to show — the share sheet is the whole of it.
     */
    if (first && left.every((it) => it.parts && it.parts.every((x) => x.saved || first.bundle.includes(x)))) {
      const n = left.length;
      first.sharing.then(() => {
        first.bundle.forEach((x) => { x.saved = true; releaseSave(x.file); });
        left.forEach((it) => prefetched.delete(it.path));
        island({ kind: 'good', title: n > 1 ? `All ${n} saved to Photos` : 'Saved to Photos', sub: 'Find them in your Photos', ms: 4500 });
      }, (e) => {
        if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) {
          island({ kind: 'info', title: 'Not saved yet', sub: `${n} video${n > 1 ? 's' : ''} on your phone`, sticky: true,
            action: { label: 'Save all', onClick: () => saveAll(paths, { tapped: true }) } });
        } else saveAll(paths);
      });
      return;
    }
    const panel = openPanel({ id: 'cloudSaveAll', title: `Save ${items.length} video${items.length > 1 ? 's' : ''}`, cls: 'cp-saveall' });
    panel.body.innerHTML = '<div class="sa-list">' + items.map((it, i) => `<div class="sa-row" data-i="${i}"><span class="sa-pic" data-thumb="${escAttr(it.path)}"></span>`
      + `<span class="sa-tx"><b>${escHtml(it.name)}</b><small></small></span><i class="sa-st"></i></div>`).join('') + '</div>';
    watchThumbs(panel.body);
    panel.foot.innerHTML = `<button type="button" class="cv-act cv-save sa-go"><i class="cv-fill"></i>${mi('download')}<span></span></button>`;
    const btn = panel.foot.querySelector('.sa-go'), label = btn.querySelector('span'), fill = btn.querySelector('.cv-fill');
    const mb = (b) => Math.max(1, Math.round(b / 1048576)) + ' MB';
    const row = (i, text, st) => {
      const r = panel.body.querySelector(`.sa-row[data-i="${i}"]`); if (!r) return;
      r.querySelector('small').textContent = text || '';
      r.dataset.st = st || '';
      if (st === 'loading') r.scrollIntoView({ block: 'nearest' });
    };
    const go = (state, text, pc) => {
      btn.dataset.state = state;
      btn.className = 'cv-act cv-save sa-go cv-' + state;
      label.textContent = text;
      if (fill) fill.style.width = (pc == null ? (state === 'loading' ? 0 : 100) : pc) + '%';
    };
    items.forEach((it, i) => {
      if (it.done) row(i, 'Saved ✓', 'done');
      else if (it.parts) row(i, 'On your phone — ready to save', 'ready');
      else row(i, it.size ? mb(it.size) : '', '');
    });
    go('ready', `Save all ${items.length} to Photos`);
    let onTap = null;
    btn.addEventListener('click', () => { if (btn.dataset.state === 'ready' && onTap) { const f = onTap; onTap = null; f(); } });
    const tapThen = (text) => new Promise((resolve) => { go('ready', text); onTap = resolve; try { if (navigator.vibrate) navigator.vibrate(15); } catch (e) {} });
    const run = async (first) => {
      const total = items.length;
      let cur = 0;
      let bundle = [];            // { file, i, size, saved }
      let bundleBytes = 0;
      // gone to Photos: let go of the files, and tick off every short now complete
      const shared = (g) => {
        g.forEach((b) => { b.saved = true; releaseSave(b.file); });
        items.forEach((it, i) => {
          if (it.done || !it.parts || !it.parts.length || !it.parts.every((x) => x.saved)) return;
          it.done = true; prefetched.delete(it.path); row(i, 'Saved ✓', 'done');
        });
      };
      if (first) {
        go('sharing', 'Opening…');
        try { await first.sharing; shared(first.bundle); }
        catch (e) {
          // closed, or not allowed: they wait for a tap below like any other
          if (!(e && (e.name === 'AbortError' || e.name === 'NotAllowedError'))) first.bundle.forEach((b) => row(b.i, 'The share sheet would not open', 'fail'));
        }
      }
      await sizeItems(items);
      const meter = saveMeter(items);
      items.forEach((it, i) => { if (it.done || it.parts) meter.set(i, 1); });
      const paint = () => { const pc = meter.pct(); go('loading', `Saving ${Math.min(total, cur + 1)} of ${total} · ${pc}%`, pc); };
      // one share: needs its own tap; cancelled → the same button again
      const flush = async () => {
        if (!bundle.length) return;
        const files = bundle.map((b) => b.file);
        const groups = files.length > 1 && !navigator.canShare({ files }) ? bundle.map((b) => [b]) : [bundle];
        for (const g of groups) {
          const n = g.length;
          for (;;) {
            await tapThen(n > 1 ? `Save ${n} videos to Photos` : 'Save to Photos');
            go('sharing', 'Opening…');
            try {
              await navigator.share({ files: g.map((b) => b.file) });
              shared(g);
              break;
            } catch (e) {
              if (!(e && e.name === 'AbortError')) { g.forEach((b) => row(b.i, 'The share sheet would not open', 'fail')); break; }
            }
          }
        }
        bundle = []; bundleBytes = 0;
      };
      const queue = async (x) => {
        if (bundle.length && bundleBytes + x.size > PHONE_PART_MAX) await flush();
        bundle.push(x); bundleBytes += x.size;
      };
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        cur = i;
        if (it.done) continue;
        try {
          if (it.parts) {
            for (const x of it.parts) if (!x.saved) { x.i = i; await queue(x); }
            continue;
          }
          paint();
          it.parts = await fetchShort(it, i, {
            meter,
            say: (text) => { row(i, text, 'loading'); paint(); },
            // share what is waiting before the next part would make it too big for one share
            beforePart: async (part) => { if (bundle.length && bundleBytes + (part.size || 0) > PHONE_PART_MAX) await flush(); },
            afterPart: (x) => { bundle.push(x); bundleBytes += x.size; },
          });
          prefetched.set(it.path, it.parts);
          row(i, 'On your phone — ready to save', 'ready');
        } catch (e) {
          meter.set(i, 1);
          row(i, (e && e.code === 'SPACE') ? e.message : 'Could not get this one — the rest carry on', 'fail');
        }
      }
      await flush();
      const saved = items.filter((it) => it.done).length;
      const failed = items.length - saved;
      go(failed ? 'fail' : 'done', failed ? `Saved ${saved} of ${items.length}` : `All ${items.length} saved ✓`);
      if (!failed) island({ kind: 'good', title: `All ${items.length} saved`, sub: 'Find them in your Photos', ms: 4000 });
    };
    if (first) { run(first).catch(() => go('fail', 'Something went wrong — try again')); return; }
    onTap = () => {
      // already on the phone: this tap opens the share sheet for them
      const fb = firstBundleOf(items);
      const now = fb.length ? { bundle: fb, sharing: navigator.share({ files: fb.map((x) => x.file) }) } : null;
      run(now).catch(() => go('fail', 'Something went wrong — try again'));
    };
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
    const vids = cloud.downloads.filter((d) => /\.(mp4|mov|m4v)$/i.test(d.name));
    list.innerHTML = (vids.length > 1 ? `<button type="button" class="cv-act cv-save cv-ready sa-all" data-act="saveall">${mi('download')}<span>Save all ${vids.length} to Photos</span></button>` : '')
      + cloud.downloads.map((d) => `<div class="cf-row" data-path="${escAttr(d.path)}">`
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
  /*
   * ►► ONLY THE SELECTED CLIP'S HANDLES. ◄◄ Every clip used to carry live trim
   * handles at both ends, and on a montage — dozens of short clips and
   * pictures — those strips covered much of the timeline: a finger meant to
   * scroll landed on one and trimmed or moved a clip instead. As in CapCut,
   * handles belong to the clip you tapped (the others do not show them,
   * cloud.css), and everywhere else a finger scrolls. The ruler scrolls too:
   * the timeline's own centre line is the scrubber now (setCentredPlayhead).
   */
  const DRAG_SEL = [
    '.ve-seg.sel .ve-seg-h', '.ve-audio-seg.sel .ve-audio-h', '.ve-cap-clip.sel .ve-cc-h', '.ve-text-clip.sel .ve-tc-h',
    '.ve-cap-edge', '[data-capedge]', '[data-capscale]', '.ve-cap-block',
    '.ve-text-box', '.ve-text-resize',
    '#veCropFrame', '#veOverlayGuide', '.ve-ovg-resize', '[data-ovresize]',
  ].join(',');
  /* A wide screen (a tablet in landscape, a laptop's browser) keeps the desk's
   * timeline: every handle visible and draggable, the ruler a scrubber. Only the
   * phone layout is CapCut's (cloud.css hides unselected handles there alone). */
  const DRAG_SEL_WIDE = [
    '.ve-seg-h', '.ve-audio-h', '.ve-cc-h', '.ve-tc-h', '[data-tedge]', '[data-cedge]',
    '.ve-cap-edge', '[data-capedge]', '[data-capscale]', '.ve-cap-block', '.ve-text-box', '.ve-text-resize',
    '#veRuler', '#veCropFrame', '#veOverlayGuide', '.ve-ovg-resize', '[data-ovresize]',
  ].join(',');
  const phoneMq = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;
  const phoneLayout = () => !phoneMq || phoneMq.matches;

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
  /*
   * ►► A CAPTION IS NEVER PICKED UP BY A FINGER THAT MEANT TO SCROLL. ◄◄
   * "When my finger is on top of the captions, the caption block shortens by
   *  itself or removes itself." A finger resting on the lane while you look
   * (350 ms is less than a glance) lifted the line under it, and the swipe that
   * followed dragged it under its neighbour; a swipe that began on the edge of
   * the selected line trimmed it to a sliver. So a caption is lifted only the
   * way CapCut does it: tap it first (it shows its handles), then hold it still
   * for half a second while nothing is moving — and a handle is only grabbed
   * while the timeline is still. An unselected caption is a tap or a scroll.
   */
  const CAP_LIFT_MS = 500;
  const CAP_BLOCK = '.ve-cap-clip';

  function installTouchBridge() {
    let dragging = false;
    let pending = null;      // a long press being waited out
    let held = null;         // the element the dragging finger first touched

    const mouse = (type, t, target, mark) => {
      const ev = new MouseEvent(type, {
        bubbles: true, cancelable: true, view: window,
        clientX: t.clientX, clientY: t.clientY,
        screenX: t.screenX, screenY: t.screenY,
        button: 0, buttons: type === 'mouseup' ? 0 : 1,
      });
      if (mark) Object.assign(ev, mark);
      (target || document).dispatchEvent(ev);
    };
    // the timeline moving under the finger: a swipe, a coasting flick, playback following
    let tlMovedAt = 0;
    document.addEventListener('scroll', (e) => { if (e.target && e.target.id === 'veTlScroll') tlMovedAt = performance.now(); }, { capture: true, passive: true });
    const tlScrollX = () => { const sc = document.getElementById('veTlScroll'); return sc ? sc.scrollLeft : 0; };
    const playing = () => { const p = document.getElementById('vePlayer'); return !!p && !p.paused && !p.ended; };
    /* A finger that lands while the clips are sliding is catching the timeline, not grabbing a caption. */
    const tlBusy = () => playing() || performance.now() - tlMovedAt < 300;

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
      if (e.touches.length !== 1) {
        cancelPending();
        // a second finger ends a drag where it is (a pinch is not a drag) — and
        // SAYS so, or the studio's mousemove listener outlives the gesture
        if (dragging) { dragging = false; release(); mouse('mouseup', e.touches[0], document, { mwCancel: true }); }
        return;
      }
      const t = e.touches[0];
      const el = t.target;
      if (!el || !el.closest) return;
      if (el.closest(NO_BRIDGE)) return;
      const capLane = !!el.closest('.ve-cap-track');

      if (el.closest(phoneLayout() ? DRAG_SEL : DRAG_SEL_WIDE) && !(capLane && tlBusy())) {
        dragging = true;
        e.preventDefault();        // no scroll, no synthetic click, no 300ms wait
        hold(el);
        mouse('mousedown', t, el);
        return;
      }

      // the caption lane: an unselected line (or the empty lane) is a tap or a scroll, never a lift
      if (capLane && !el.closest(CAP_BLOCK + '.sel')) return;
      if (el.closest(LONG_PRESS_SEL)) {
        // Hold still and this becomes a drag; move and it stays a scroll.
        // clientX/clientY by those names: mouse() reads them, and without them
        // the studio was told the press landed at the screen's left edge
        const start = { x: t.clientX, y: t.clientY, clientX: t.clientX, clientY: t.clientY, screenX: t.screenX, screenY: t.screenY };
        const sx0 = tlScrollX();
        pending = {
          el,
          start,
          timer: setTimeout(() => {
            pending = null;
            // the timeline moved while it was held (a coast, playback), or the
            // block was redrawn under the finger: not a lift
            if (capLane && (tlBusy() || Math.abs(tlScrollX() - sx0) > 1 || !el.isConnected)) return;
            dragging = true;
            // A short buzz is how a phone says "you are holding it now".
            try { if (navigator.vibrate) navigator.vibrate(12); } catch (er) {}
            hold(el);
            mouse('mousedown', start, el, capLane ? { mwLift: true } : null);
          }, capLane ? CAP_LIFT_MS : LONG_PRESS_MS),
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
      // A press that became a drag is not ALSO a tap: no compatibility mouse
      // events and no click afterwards (a caption put back down would otherwise
      // start typing — the browser's own mousedown reads as a second tap).
      if (e.cancelable) e.preventDefault();
      const t = (e.changedTouches && e.changedTouches[0]) || { clientX: 0, clientY: 0, screenX: 0, screenY: 0 };
      mouse('mouseup', t, document);
    }
    document.addEventListener('touchend', end, { capture: true });
    document.addEventListener('touchcancel', end, { capture: true });
  }

  /*
   * ►► THE CAPTIONS WINDOW'S PLAY AND PAUSE, ON AN IPHONE. ◄◄
   *
   * "When the video is playing I cannot pause it — the thing starts going down
   *  and I can't pause it." Safari does not turn a tap into a click at once: it
   * first fakes a mouse arriving, watches whether the page changes, and a tap
   * that lands while content is moving or appearing — the list scrolling itself
   * down to follow the voice, the captions coming and going on the picture, the
   * lit line moving on — is taken as a hover or a scroll-stop, and the click is
   * simply never sent. While a video plays that page never stops changing, so
   * the longer it played the more taps on ⏸ came to nothing.
   *
   * So these buttons act on the finger lifting. preventDefault on the touchend
   * tells Safari there is nothing to guess (and no click follows, so a tap is
   * exactly one press), and the button's own click handler runs as it would
   * from a mouse. A finger that moved is a scroll and is left alone.
   */
  const TAP_NOW = '#capModal .cap-player button, #capModal .cap-row-play';
  /*
   * ►► ONE TAP, NOT A PICKER. ◄◄ The captions window's short choices — Size,
   * Words per line, Position — were dropdowns, and on an iPhone a dropdown
   * opens the system's wheel picker: a pause, then a sheet over half the
   * screen, then another tap to close it. They are a row of buttons now (the
   * dropdown stays underneath, hidden, and is what the studio reads, so
   * nothing else changes). A value set from elsewhere — a saved session, the
   * look — is shown when the window opens.
   */
  const CAP_CHIPS = { capSize: null, capWords: null, capPos: { center: 'Middle' } };
  /*
   * The captions window, calm (cloud.css, "Edit captions"): the tools that are
   * not the lines themselves go under one "Tools" switch, and the close button
   * reads ✓ — the edits are kept as they are made, so closing IS done.
   */
  function installCapTidy() {
    const box = document.querySelector('#capModal .cap-box');
    const player = document.getElementById('capPlayer');
    if (!box || !player || player.querySelector('.cap-tools-btn')) return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cap-tools-btn';
    b.setAttribute('aria-expanded', 'false');
    b.innerHTML = `${mi('sliders')}<span>Tools</span>`;
    b.title = 'Style & settings, Word Book, fix words, grammar, replay, speed and loop';
    b.addEventListener('click', () => {
      const on = !box.classList.contains('cap-tools-open');
      box.classList.toggle('cap-tools-open', on);
      b.setAttribute('aria-expanded', String(on));
    });
    const time = document.getElementById('capPlayTime');
    if (time && time.nextSibling) player.insertBefore(b, time.nextSibling); else player.appendChild(b);
    const close = document.getElementById('capClose');
    if (close) { close.innerHTML = mi('check'); close.setAttribute('aria-label', 'Done'); close.title = 'Done'; }
  }

  function installCapChips() {
    const rows = [];
    for (const id of Object.keys(CAP_CHIPS)) {
      const sel = document.getElementById(id);
      if (!sel || sel._chips) continue;
      const row = document.createElement('div');
      row.className = 'cloud-chips';
      row.setAttribute('role', 'radiogroup');
      for (const o of sel.options) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.v = o.value;
        b.textContent = (CAP_CHIPS[id] && CAP_CHIPS[id][o.value]) || o.textContent;
        b.title = o.textContent;
        b.addEventListener('click', () => {
          if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          sync();
        });
        row.appendChild(b);
      }
      const sync = () => { for (const b of row.children) b.classList.toggle('on', b.dataset.v === sel.value); };
      sel._chips = sync;
      sel.classList.add('cloud-chipped');
      sel.after(row);
      sel.addEventListener('change', sync);
      sync();
      rows.push(sync);
    }
    const modal = document.getElementById('capModal');
    if (modal && rows.length) new MutationObserver(() => { if (!modal.classList.contains('hidden')) rows.forEach((f) => f()); })
      .observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  /*
   * ►► NO SYSTEM PICKER AT ALL. ◄◄ The same pause, on the choices that were
   * still dropdowns: "Font takes too long to open the first time", then "ALL
   * CAPS too". An iPhone opens a dropdown in a system picker, and the first one
   * of a page's life is slow to appear. Font, Case, Transition, Style and
   * Hearing now open a list drawn by the page itself — there at once, every
   * time — with each font shown in its own face once that face is on the phone
   * (the system picker only ever showed the names). As with the chips, the
   * dropdown stays underneath, hidden, and is what the studio reads and writes:
   * a choice made here is set on it and announced the same way a pick would be.
   */
  const CAP_SHEETS = ['capFont', 'capCase', 'capTrans', 'capStyleSel', 'capModelSel'];
  const selDesc = {
    value: Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value'),
    selectedIndex: Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex'),
  };
  const firstFamily = (ff) => String(ff || '').split(',')[0].trim().replace(/^['"]|['"]$/g, '');
  // (asked at the weight the faces are loaded at — veditor.js loadCapFontFaces)
  const faceReady = (fam) => { try { return !!fam && document.fonts && document.fonts.check(`800 16px '${fam.replace(/'/g, '')}'`); } catch (e) { return false; } };
  function installCapSheets() {
    const syncs = [];
    for (const id of CAP_SHEETS) {
      const sel = document.getElementById(id);
      if (!sel || sel._sheet) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cloud-pick';
      btn.setAttribute('aria-haspopup', 'listbox');
      const txt = document.createElement('span');
      txt.className = 'cloud-pick-v';
      btn.appendChild(txt);
      const sync = () => {
        const o = sel.options[sel.selectedIndex];
        txt.textContent = o ? o.textContent : '';
        const fam = firstFamily(sel.style.fontFamily);
        txt.style.fontFamily = fam && faceReady(fam) ? sel.style.fontFamily : '';   // the Font picker wears the chosen face
        btn.disabled = !!sel.disabled;
      };
      btn.addEventListener('click', () => { sync(); openCapSheet(sel, sync); });
      // a value set by the studio itself (a look, a saved session) fires no event: told here instead
      for (const k of ['value', 'selectedIndex']) {
        const d = selDesc[k];
        if (!d || !d.set) continue;
        Object.defineProperty(sel, k, { configurable: true, enumerable: true,
          get() { return d.get.call(this); },
          set(v) { d.set.call(this, v); Promise.resolve().then(sync); } });
      }
      new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'disabled'] });
      sel.addEventListener('change', sync);
      sel._sheet = sync;
      sel.classList.add('cloud-sheeted');
      sel.after(btn);
      sync();
      syncs.push(sync);
    }
    const modal = document.getElementById('capModal');
    if (modal && syncs.length) new MutationObserver(() => { if (!modal.classList.contains('hidden')) syncs.forEach((f) => f()); else closeCapSheet(); })
      .observe(modal, { attributes: true, attributeFilter: ['class'] });
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', () => syncs.forEach((f) => f()));
  }
  let capSheet = null;
  function closeCapSheet() {
    if (!capSheet) return;
    const s = capSheet; capSheet = null;
    try { s.remove(); } catch (e) {}
  }
  function openCapSheet(sel, sync) {
    closeCapSheet();
    if (sel.disabled) return;
    const label = sel.closest('label');
    const title = label ? Array.from(label.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ').trim() : '';
    const wrap = document.createElement('div');
    wrap.className = 'cloud-pickr';
    wrap.setAttribute('role', 'dialog');
    const panel = document.createElement('div');
    panel.className = 'cloud-pickr-panel';
    const head = document.createElement('div');
    head.className = 'cloud-pickr-head';
    const h = document.createElement('span'); h.textContent = title || 'Choose';
    const x = document.createElement('button'); x.type = 'button'; x.className = 'cloud-pickr-x'; x.textContent = '✕'; x.setAttribute('aria-label', 'Close');
    head.append(h, x);
    const list = document.createElement('div');
    list.className = 'cloud-pickr-list';
    list.setAttribute('role', 'listbox');
    let current = null;
    const row = (o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cloud-pickr-row' + (o.value === sel.value ? ' on' : '');
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', o.value === sel.value ? 'true' : 'false');
      b.disabled = !!o.disabled;
      b.textContent = o.textContent;
      // a font shown in its own face — once it is on the phone (a face still on its way would draw nothing)
      const fam = firstFamily(o.style && o.style.fontFamily);
      if (fam) {
        const wear = () => { b.style.fontFamily = o.style.fontFamily; };
        if (faceReady(fam)) wear();
        else if (document.fonts && document.fonts.load) document.fonts.load(`800 16px '${fam.replace(/'/g, '')}'`).then(() => { if (faceReady(fam)) wear(); }).catch(() => {});
      }
      b.addEventListener('click', () => {
        closeCapSheet();
        if (sel.value !== o.value) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        sync();
      });
      if (o.value === sel.value) current = b;
      return b;
    };
    for (const n of sel.children) {
      if (n.tagName === 'OPTGROUP') {
        const g = document.createElement('div'); g.className = 'cloud-pickr-group'; g.textContent = n.label || '';
        list.appendChild(g);
        for (const o of n.children) if (o.tagName === 'OPTION' && !o.hidden) list.appendChild(row(o));
      } else if (n.tagName === 'OPTION' && !n.hidden) list.appendChild(row(n));
    }
    panel.append(head, list);
    wrap.appendChild(panel);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) closeCapSheet(); });
    x.addEventListener('click', closeCapSheet);
    document.body.appendChild(wrap);
    capSheet = wrap;
    if (current) { try { current.scrollIntoView({ block: 'center' }); } catch (e) {} }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && capSheet) { e.stopPropagation(); closeCapSheet(); } }, true);

  /*
   * ►► THE PICTURE IS THERE WHEN A PROJECT REOPENS. ◄◄ An iPhone does not draw
   * a paused video's frame until it has fetched picture data for it — and it
   * fetches nothing until asked to play. So a project reopened at 0:34 showed
   * a black preview until ▶ was pressed. Now, whenever the preview gets a new
   * video or is moved while paused without a frame to show, it is asked for
   * the data (preload, load) and, if that is still not enough, played silently
   * for an instant and paused again at the same spot — the frame appears; no
   * sound plays and the position does not change.
   */
  function installFirstFrame() {
    const v = document.getElementById('vePlayer');
    if (!v || v._firstFrame) return;
    v._firstFrame = true;
    v.preload = 'auto';
    let busy = false;
    const nudge = () => {
      if (busy || !v.paused || !v.currentSrc || v.readyState >= 2) return;
      // not during an export: nothing on the page may wake the preview then
      const ov = document.getElementById('overlay');
      if ((ov && !ov.classList.contains('hidden')) || (window.__tasksBusy && window.__tasksBusy())) return;
      busy = true;
      const at = v.currentTime, wasMuted = v.muted;
      v.muted = true; v._nudging = true;   // the editor ignores this play/pause (veditor.js)
      let p = null;
      try { p = v.play(); } catch (e) { p = null; }
      const done = () => {
        try { v.pause(); if (Math.abs(v.currentTime - at) > 0.05) v.currentTime = at; } catch (e) {}
        v.muted = wasMuted; busy = false;
        setTimeout(() => { v._nudging = false; }, 400);   // after the pause/playing events have been seen
        // and the song is never left playing by itself
        try { const m = document.getElementById('veMusicAudio'); if (m && !m.paused) m.pause(); } catch (e) {}
      };
      if (p && p.then) p.then(() => requestAnimationFrame(done), done); else done();
    };
    v.addEventListener('loadedmetadata', () => setTimeout(nudge, 150));
    v.addEventListener('seeked', () => setTimeout(nudge, 150));
    v.addEventListener('emptied', () => { busy = false; });
  }

  /*
   * ►► A FLIGHT RECORDER FOR CRASHES. ◄◄ What the app was doing, step by step,
   * kept on the phone while work runs. A page closed under it (iOS does that
   * when a page uses too much memory) never says goodbye — so if the last
   * session ended mid-work, the next open sends its last steps to the server's
   * log (main.js diag:crash), and the next crash says exactly where it was.
   */
  const CRASH_KEY = 'mw-crumbs';
  const crumbs = { list: [], last: '' };
  function crumb(step) {
    step = String(step || '').trim();
    if (!step || step === crumbs.last) return;
    crumbs.last = step;
    let mb = 0;
    try { if (performance.memory) mb = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
    crumbs.list.push({ at: Date.now(), s: step, mb });
    if (crumbs.list.length > 25) crumbs.list.shift();
    try { localStorage.setItem(CRASH_KEY, JSON.stringify({ busy: true, steps: crumbs.list })); } catch (e) {}
  }
  function crumbsIdle() { try { localStorage.setItem(CRASH_KEY, JSON.stringify({ busy: false, steps: crumbs.list })); } catch (e) {} }
  window.__crumb = crumb;
  function installCrashRecorder() {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(CRASH_KEY) || 'null'); } catch (e) {}
    try { localStorage.removeItem(CRASH_KEY); } catch (e) {}
    if (prev && prev.busy && Array.isArray(prev.steps) && prev.steps.length) {
      call('diag:crash', { steps: prev.steps, ua: navigator.userAgent }).catch(() => {});
    }
    // what the progress card says is the step; a hidden card means nothing is running
    const msg = document.getElementById('overlayMsg'), batch = document.getElementById('overlayBatch'), ov = document.getElementById('overlay');
    const read = () => {
      const on = ov && !ov.classList.contains('hidden');
      const busy = on || (window.__tasksBusy && window.__tasksBusy());
      if (!busy) { if (crumbs.list.length) crumbsIdle(); return; }
      crumb(((batch && !batch.classList.contains('hidden') ? batch.textContent + ' — ' : '') + (msg ? msg.textContent : '')) || 'working');
    };
    const mo = new MutationObserver(read);
    [msg, batch, ov].forEach((el) => { if (el) mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] }); });
    setInterval(read, 5000);
    // a page that is put away cleanly is not a crash
    window.addEventListener('pagehide', () => { if (!(ov && !ov.classList.contains('hidden'))) crumbsIdle(); });
  }

  function installTapNow() {
    let down = null;
    document.addEventListener('touchstart', (e) => {
      down = null;
      if (e.touches.length !== 1) return;
      const b = e.target && e.target.closest ? e.target.closest(TAP_NOW) : null;
      if (!b || b.disabled) return;
      const t = e.touches[0];
      down = { b, x: t.clientX, y: t.clientY, at: Date.now() };
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!down || !e.touches.length) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - down.x) > 10 || Math.abs(t.clientY - down.y) > 10) down = null;
    }, { capture: true, passive: true });
    const lift = (e) => {
      const d = down; down = null;
      if (!d || Date.now() - d.at > 700) return;     // a long press is not a tap
      if (e.cancelable) e.preventDefault();
      if (d.b.isConnected && !d.b.disabled) d.b.click();
    };
    document.addEventListener('touchend', lift, { capture: true, passive: false });
    // Safari may cancel a still finger when the list under it scrolls itself; it was still a tap
    document.addEventListener('touchcancel', lift, { capture: true, passive: false });
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
      const results = await sendFilesNow(files);
      reportSent(results);
      const paths = results.filter((x) => x.path).map((x) => ({ path: x.path, name: x.name }));
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
      { icon: 'layers', label: 'Background', row: 'background' },
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
      { icon: 'sparkles', label: 'AI voice', call: 'aiVoice' },
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
      { icon: 'plus', label: 'Add caption', call: 'addCaptionHere' },
      { icon: 'captions', label: 'Captions', ai: true, sheet: 'insp', tab: '#veInspTabCaptions' },
    ],
    /* What a caption block on the timeline can do. Comes up by itself when
     * one is tapped (see followCaptionPick) — the way CapCut swaps its tools
     * for the thing you picked — so Delete is right there. */
    caption: [
      { icon: 'trash', label: 'Delete', call: 'deleteSelectedCaption' },
      { icon: 'pen', label: 'Edit words', call: 'editSelectedCaption' },
      { icon: 'plus', label: 'Add caption', call: 'addCaptionHere' },
      { icon: 'captions', label: 'Captions', sheet: 'insp', tab: '#veInspTabCaptions' },
    ],
    ratio: [],      // built from the desk's own list of shapes
    /* What fills the frame when the video is another shape (16:9 in a 9:16
     * short): CapCut's Canvas. Blur is the whole picture on its own colours. */
    background: [
      { icon: 'filters', label: 'Blur', bg: 'blur' },
      { icon: 'crop', label: 'Fill (crop)', bg: 'crop' },
      { icon: 'square', label: 'Black bars', bg: 'bars' },
      { icon: 'image', label: 'Blur behind', press: '#veOvBlur' },
    ],
    overlay: [
      { icon: 'image', label: 'Add media', press: '#veAddMedia' },
      { icon: 'overlay', label: 'To overlay', press: '#veOverlay' },
      { icon: 'fullscreen', label: 'Fill frame', press: '#veOvFill', on: true },
      { icon: 'chroma', label: 'Chroma key', call: 'chromaKey' },
      { icon: 'eraser', label: 'Cut out', press: '#veCutOut' },
      { icon: 'volume', label: 'Sound', press: '#veOvSound' },
      { icon: 'filters', label: 'Blur behind', press: '#veOvBlur' },
    ],
    project: [
      { icon: 'folder', label: 'Open', press: '#veOpen' },
      { icon: 'save', label: 'Save', press: '#veSaveSession' },
      { icon: 'layers', label: 'Projects', projects: true },
      { icon: 'clapper', label: 'Outros', press: '#veClips' },
      { icon: 'package', label: 'Batch', press: '#veBulk' },
      { icon: 'download', label: 'Saved', press: '#cloudDownloads' },
      { icon: 'book', label: 'Help', press: '#cloudHelp' },
      { icon: 'trash', label: 'Delete', deleteProject: true },
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
    syncCover();
  }
  /* The ending row: the outro's own picture, its name and length, and whether
     it goes on. Read from the studio every time the sheet opens or the clip
     library closes, so it never shows a stale choice. */
  /* The finished video's thumbnail: its picture, and what it is. */
  function syncCover() {
    const row = $('#cloudXpCover'); if (!row) return;
    const ed = window.VideoEditor;
    const c = ed && ed.coverInfo ? ed.coverInfo() : { set: false };
    row.classList.toggle('has', !!c.set);
    row.classList.toggle('on', !!c.set);
    const th = row.querySelector('.cloud-xp-end-thumb i');
    if (th) th.style.backgroundImage = c.img ? `url("${c.img}")` : '';
    const sub = $('#cloudXpCoverSub');
    if (sub) sub.textContent = c.set ? (c.photo ? 'Your photo' : 'A moment from the video') + ' · tap to change' : 'Choose the picture people see first';
  }
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
      if (!el) return;
      // the panel has tabs: open the one this control lives on (and, for
      // Adjust, pick the slider itself)
      const pane = el.closest('[data-fxpane]');
      const tab = pane && $(`#fxModal [data-fxtab="${pane.dataset.fxpane}"]`);
      if (tab) tab.click();
      const adj = $(`#fxModal [data-adj="${el.id}"]`);
      if (adj) adj.click();
      if (pane) return;
      const row = el.closest('label, .fx-row, .ve-fill-row, div') || el;
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('cloud-flash');
      setTimeout(() => row.classList.remove('cloud-flash'), 1400);
    }, 60);
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
    pin(document.getElementById('veDrop'));
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
      if (t.bg) {
        const sync = () => { const E = window.VideoEditor; b.classList.toggle('on', !!(E && E.backgroundMode && E.backgroundMode() === t.bg)); };
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
      if (t.projects) return window.MWSocial && window.MWSocial.openProjects && window.MWSocial.openProjects();
      if (t.deleteProject) return window.MWSocial && window.MWSocial.deleteOpenProject && window.MWSocial.deleteOpenProject();
      if (t.bg) {
        const E = window.VideoEditor; if (E && E.setBackground) E.setBackground(t.bg);
        const r = dock.querySelector('.cloud-dock-row.on'); if (r) for (const x of r.querySelectorAll('.cloud-tool')) if (x._sync) x._sync();
        return;
      }
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

    /*
     * Tap a caption block and the Caption tools come up; let go of it (tap a
     * clip, delete it, undo) and the dock goes back to where it was. A pick is
     * a tap, and the lane redraws on every change, so both are listened to.
     */
    (function followCaptionPick() {
      const track = $('#veCapTrack');
      if (!track) return;
      let had = -1, back = 'main';
      const follow = () => {
        const E = window.VideoEditor;
        const now = E && E.selectedCaption ? E.selectedCaption() : -1;
        if (now === had) return;
        had = now;
        const cur = dock.querySelector('.cloud-dock-row.on');
        const curName = cur ? cur.dataset.row : 'main';
        if (now >= 0) {
          if (curName !== 'caption') { back = curName; showRow('caption'); }
        } else if (curName === 'caption') showRow(back || 'main');
      };
      new MutationObserver(follow).observe(track, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
      // a tap ON the caption lane always asks again — the same caption re-tapped
      // after Back has not changed the selection, but means "show me its tools"
      const onTap = (e) => setTimeout(() => {
        if (e && e.target && e.target.closest && e.target.closest('#veCapTrack')) had = -1;
        follow();
      }, 0);
      document.addEventListener('pointerup', onTap);
      document.addEventListener('click', onTap);
    })();

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
      <div class="cloud-xp-ending cloud-xp-cover" id="cloudXpCover">
        <button type="button" class="cloud-xp-end-thumb" data-xp="cover-pick" aria-label="Choose the video's thumbnail"><i></i></button>
        <button type="button" class="cloud-xp-end-text" data-xp="cover-pick"><b>Video thumbnail</b><small id="cloudXpCoverSub">Choose the picture people see first</small></button>
        <span class="cloud-xp-chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>
      </div>
      <label class="cloud-xp-row"><span>Keep editing while it exports</span><input type="checkbox" data-mirror="#veBgExport" /></label>
      <button type="button" class="cloud-xp-link" data-xp="saved">Finished files — save them to this phone</button>
      <button type="button" class="cloud-xp-link" data-xp="more">More export settings</button>`;
    document.body.appendChild(xs);
    // The library's "from my PC" is the desk talking; here it is this phone.
    {
      const where = onPhone() ? 'this phone' : 'this computer';
      const lm = $('#libAddMusic'); if (lm) lm.textContent = `➕ Add music from ${where}`;
      const lc = $('#libAddClip'); if (lc) lc.textContent = `➕ Add a clip from ${where}`;
    }
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
    // …and the thumbnail picker closing, a new thumbnail
    const thm = $('#thumbModal');
    if (thm && window.MutationObserver) new MutationObserver(() => { if (thm.classList.contains('hidden')) syncCover(); })
      .observe(thm, { attributes: true, attributeFilter: ['class'] });
    // the clip library closing is the moment a new ending may have been chosen
    const lib = $('#libModal');
    if (lib && window.MutationObserver) new MutationObserver(() => { if (lib.classList.contains('hidden')) syncEnding(); })
      .observe(lib, { attributes: true, attributeFilter: ['class'] });
    xs.addEventListener('click', (e) => {
      const b = e.target.closest('[data-xp]');
      if (!b || b.disabled) return;
      if (b.dataset.xp === 'ending-pick') { const ed = window.VideoEditor; if (ed && ed.chooseOutro) ed.chooseOutro(); return; }
      if (b.dataset.xp === 'cover-pick') { const ed = window.VideoEditor; if (ed && ed.chooseCover) ed.chooseCover(); return; }
      const go = { shorts: '#veExportAll', video: '#veExportEdited', saved: '#cloudDownloads' }[b.dataset.xp];
      if (b.dataset.xp === 'more') return openSheet('insp', { tab: '#veInspTabExport' });
      closeSheet();
      const el = $(go);
      if (el && !el.disabled) el.click();
    });

    /*
     * ►► "A PANEL IS UP" IS A CLASS ON THE PAGE, NOT A :has(). ◄◄
     * The toast and the island move up while a panel is open. That was
     * body:has(.cap-modal:not(.hidden)) — and a :has() on the whole page makes
     * the browser re-check every element on it whenever anything is added
     * anywhere: each redraw of the timeline's ruler restyled every clip block
     * (70 ms instead of 2 at an iPhone's pace). The panels say when they open
     * and close; that is all the page needs to know.
     */
    {
      const sync = () => document.body.classList.toggle('cloud-modal-up', !!document.querySelector('.cap-modal:not(.hidden)'));
      const mo = new MutationObserver(sync);
      const watch = (m) => { if (!m._mwUpWatch) { m._mwUpWatch = true; mo.observe(m, { attributes: true, attributeFilter: ['class'] }); } };
      $$('.cap-modal').forEach(watch);
      new MutationObserver((recs) => {
        for (const r of recs) for (const n of r.addedNodes) if (n.nodeType === 1 && n.classList.contains('cap-modal')) watch(n);
        sync();
      }).observe(document.body, { childList: true });
      sync();
    }

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
        // the ＋ at the END of the row adds the NEXT clip — after the video, as CapCut's does
        add.addEventListener('click', () => {
          const E = window.VideoEditor;
          if (E && E.pickMediaAfter) return E.pickMediaAfter();
          const t = $('#veAddMedia'); if (t && !t.disabled) t.click();
        });
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
          // half a screen past the end, so the last frame can reach the centre line
          // (the block starts after the scroller's left padding; endX counts it)
          const E = window.VideoEditor;
          const padL = parseFloat(getComputedStyle(scroller).paddingLeft) || 0;
          const gap = (E && E.centreGap) ? E.centreGap() : 0;
          tail.style.width = Math.max(0, endX - (gap ? padL : 0) + Math.max(56, gap)) + 'px';
          add.style.top = Math.round(top - sr.top + scroller.scrollTop + (h - 34) / 2) + 'px';
        };
        // once a frame at most, however many changes asked for it
        let placeRaf = 0;
        const placeSoon = () => { if (!placeRaf) placeRaf = requestAnimationFrame(() => { placeRaf = 0; place(); }); };
        // A size change is heard AFTER the browser has laid the page out, so the
        // measuring in place() costs nothing there; done a frame later (as it
        // was), it measured a timeline the studio had just restyled, and paid
        // for laying all of it out again — every frame of a pinch.
        if (window.ResizeObserver) { const ro = new ResizeObserver(() => { cancelAnimationFrame(placeRaf); placeRaf = 0; place(); }); ro.observe(track); ro.observe(scroller); }
        // clips added, removed or moved between rows (sizes unchanged)
        new MutationObserver(placeSoon).observe(track, { childList: true, subtree: true });
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
      /*
       * CapCut's timeline: the white line stays in the middle and the clips
       * slide under it (veditor.js setCentredPlayhead). Turned on as soon as the
       * studio is there to take it.
       */
      const centre = (n) => {
        const E = window.VideoEditor;
        if (E && E.setCentredPlayhead) {
          // the phone layout only — and following it when a tablet turns round
          const set = () => E.setCentredPlayhead(phoneLayout());
          set();
          if (phoneMq && phoneMq.addEventListener) phoneMq.addEventListener('change', set);
          return;
        }
        if (n < 40) setTimeout(() => centre(n + 1), 250);
      };
      centre(0);

      let pinch = null, raf = 0;
      const span = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
      const midX = (ts) => (ts[0].clientX + ts[1].clientX) / 2;
      const ed = () => window.VideoEditor;
      tl.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        // A first finger may have started a drag; a pinch is not one.
        { const up = new MouseEvent('mouseup', { bubbles: true }); up.mwCancel = true; document.dispatchEvent(up); }
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
        // Typing in the text panel (the Size box, the words) brings the keyboard
        // up: the panel rides on it, and the PICTURE stays exactly as it was —
        // shrinking it under the keyboard changed the very text being sized.
        const ae = document.activeElement;
        const inPanel = !!(ae && ae.closest && ae.closest('#veTextTools, .ve-text-box'));
        const limit = Math.min(dock.getBoundingClientRect().top, vv && !inPanel ? vv.offsetTop + vv.height : window.innerHeight);
        // the studio's content ends where its padding starts; it must end at the dock
        const over = Math.ceil((vr.bottom - pb) - limit);
        if (over > 1) view.style.paddingBottom = (pb + over) + 'px';
        fitting = false;
        more();
        // The picture can MOVE without changing size (iOS shifting the page);
        // its frame is fitted to what is visible, so it is fitted again.
        const drop = $('#veDrop');
        const top = drop ? Math.round(drop.getBoundingClientRect().top) : 0;
        if (top !== lastTop) { lastTop = top; const E = ed(); if (E && E.fit) E.fit(); }
      };
      let lastTop = null;
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
    // an Export all from this phone: making the shorts, then bringing them down (bringBatchDown)
    const phase = batchSaving.get(t.id);
    if (phase === 'save') return Math.min(99, (100 - SAVE_SHARE) + (t.percent * SAVE_SHARE) / 100);
    const b = batchOf(t);
    const made = b && b.n > 1 ? Math.min(99, ((b.i - 1) + t.percent / 100) / b.n * 100) : t.percent;
    return phase === 'export' ? (made * (100 - SAVE_SHARE)) / 100 : made;
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
    /*
     * ►► NEVER OVER A BUTTON SOMEBODY NEEDS. ◄◄ A job that finishes often says
     * its own last word a moment before this runs — "Ready to save · Save
     * Video", "3 shorts on your phone · Save all" — and this, one frame later,
     * replaced it with "Export finished · View". The Save all button of a
     * server batch never stayed on screen long enough to be seen. A sticky
     * island with something to tap is the more useful of the two; the chip
     * still says Done (or Stopped), and the jobs sheet has the rest.
     */
    if (islandCur && islandCur.sticky && islandCur.action) return;
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
    // the chosen videos, all to Photos (Save all — a few to each tap of the share sheet)
    on('#cloudFilesSelUse', 'click', () => {
      const chosen = Array.from(filesUi.chosen);
      if (!chosen.length) return;
      finishPick(chosen);
    });
    on('#cloudFilesSelSave', 'click', () => {
      const chosen = Array.from(filesUi.chosen);
      if (!chosen.length) return;
      setSelecting(false);
      closeFilesModal();
      saveAll(chosen);
    });
    on('#cloudDownloadsList', 'click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b && b.dataset.act === 'saveall') {
        $('#cloudDownloadsModal').classList.add('hidden');
        return saveAll(cloud.downloads.filter((d) => /\.(mp4|mov|m4v)$/i.test(d.name)).map((d) => d.path));
      }
      const row = b && b.closest('.cf-row');
      if (!row) return;
      if (b.dataset.act === 'view') viewFile(row.dataset.path); else offerDownload(row.dataset.path);
    });
    on('#cloudUpload', 'click', async () => {
      const picking = $('#cloudFilesModal').dataset.picking === '1';
      const chosen = await chooseFromDevice(picking ? pickState.multi : true, picking ? pickState.exts : null);
      if (picking && chosen) finishPick(chosen);
    });
    on('#cloudUploadBar', 'click', (ev) => {
      const b = ev.target.closest('[data-upstop]');
      if (b) stopUpload(b.dataset.upstop);
    });
    on('#cloudDownloads', 'click', () => { renderDownloads(); raiseSheet($('#cloudDownloadsModal')); $('#cloudDownloadsModal').classList.remove('hidden'); });
    on('#cloudDownloadsClose', 'click', () => $('#cloudDownloadsModal').classList.add('hidden'));
    on('#cloudHelp', 'click', () => {
      $('#cloudHelpBody').innerHTML = HELP;
      $('#cloudHelpModal').classList.remove('hidden');
    });
    on('#cloudHelpClose', 'click', () => $('#cloudHelpModal').classList.add('hidden'));
    // Every sheet also puts itself away from a tap on the dimmed space above it,
    // or a pull down by its top — never only the ✕ (something can sit over it).
    const sheetClose = { cloudFilesModal: closeFilesModal };
    $$('.cap-modal.cloud-sheet-modal, #cloudHelpModal').forEach((m) => {
      const close = () => (sheetClose[m.id] ? sheetClose[m.id]() : m.classList.add('hidden'));
      m.addEventListener('click', (e) => { if (e.target === m) close(); });
      const box = m.querySelector('.cap-box');
      const top = box && box.firstElementChild;
      if (!top) return;
      let y0 = null, dy = 0;
      top.addEventListener('touchstart', (e) => {
        if (e.target.closest('button')) return;
        y0 = e.touches[0].clientY; dy = 0; box.style.transition = 'none';
      }, { passive: true });
      top.addEventListener('touchmove', (e) => {
        if (y0 == null) return;
        dy = Math.max(0, e.touches[0].clientY - y0);
        box.style.transform = dy ? `translateY(${dy}px)` : '';
      }, { passive: true });
      const end = () => {
        if (y0 == null) return;
        y0 = null; box.style.transition = ''; box.style.transform = '';
        if (dy > 80) close();
      };
      top.addEventListener('touchend', end);
      top.addEventListener('touchcancel', end);
    });

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
        // made already, coming down to the phone: Stop stops the download only
        if (batchStops.has(taskId)) { batchStops.get(taskId)(); return true; }
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
    authHeaders, fileUrl: (p) => window.MW_FILE_URL(p), viewFile, saveAll, openProfile, uploadFile,
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
    installTapNow();
    installCapChips();
    installCapSheets();
    installFirstFrame();
    installCrashRecorder();
    installCapTidy();
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
