'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Static preset data shared with the Go Live renderer — one source of truth in
// livestream.js. The app runs this preload with sandbox:false so the require
// works; in a sandboxed context (some test harnesses) it can't, and the
// renderer then hydrates the same data over the async live:destinations IPC.
let QUALITIES = null, QUALITY_GROUPS = null, LEGACY_QUALITY = null, DEFAULT_QUALITY = null;
let AUDIO_QUALITIES = null, DEFAULT_AUDIO_QUALITY = null;
// What each picture size actually costs on a platform (src/main/streamrate.js)
// and the headroom rule the pre-flight plans against (src/main/uplink.js). Both
// are plain data; the page needs them to say, synchronously and without a round
// trip, whether the stream it is about to send will be reported as under-rated.
let RATE_TIERS = null, UPLINK_USABLE = 0.66;
try {
  ({ QUALITIES, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY,
    AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY } = require('./livestream'));
  ({ TIERS: RATE_TIERS } = require('./streamrate'));
  ({ USABLE: UPLINK_USABLE } = require('./uplink'));
} catch (e) {}

// Unwrap the { ok, data, error } envelope from main into a value or thrown Error.
// A job the user cancelled comes back flagged, so the UI can go quiet instead of
// shouting "⚠️ ffmpeg failed" at someone who just pressed Cancel.
async function call(channel, args) {
  const res = await ipcRenderer.invoke(channel, args);
  if (res && res.ok) return res.data;
  const err = new Error((res && res.error) || 'Unknown error in ' + channel);
  if (res && res.cancelled) err.cancelled = true;
  throw err;
}

/*
 * NDI frames bypass this bridge entirely.
 *
 * Main hands us one end of a MessagePort whose other end is held by the NDI
 * receiver process; we forward the PORT ITSELF into the page's main world with
 * window.postMessage (the documented Electron pattern for MessagePorts under
 * contextIsolation). Frames then arrive in the renderer with no contextBridge
 * deep-clone in the way — passing an 8 MB frame through the bridge would copy it
 * a second time inside this process, for nothing.
 */
ipcRenderer.on('ndi:port', (e, payload) => {
  try { window.postMessage({ __ndiPort: true, id: payload && payload.id }, '*', e.ports); } catch (er) {}
});

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', { patch }),
  },
  paths: {
    get: () => call('paths:get'),
  },
  dialog: {
    openFile: (filters, multi) => call('dialog:openFile', { filters, multi }),
    saveFile: (defaultName, filters) => call('dialog:saveFile', { defaultName, filters }),
    openDir: () => call('dialog:openDir'),
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
    setExportPrefs: (a) => call('video:setExportPrefs', a),
    getExportPrefs: () => call('video:getExportPrefs'),
    applyEdits: (a) => call('video:applyEdits', a),
    waveform: (a) => call('video:waveform', a),
    stabilize: (a) => call('video:stabilize', a),
    reverse: (a) => call('video:reverse', a),
    freezeFrame: (a) => call('video:freezeFrame', a),
    overlayComposite: (a) => call('video:overlayComposite', a),
    detectSilence: (a) => call('video:detectSilence', a),
    speechPauses: (a) => call('video:speechPauses', a),
    mixMusic: (a) => call('video:mixMusic', a),
    appendClips: (a) => call('video:appendClips', a),
  },
  // Stop a running ffmpeg/whisper job (the Cancel button on the progress overlay).
  job: {
    cancel: (id) => call('job:cancel', { id }),
  },
  // Saved background music + outro/intro clips.
  // Saved editing sessions — the Video Studio's "pick up where I left off".
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
  // Presentation Studio — the Bible, and the projector/stage output windows.
  /* 🎤 Listen — the microphone stays in the page; the model lives in main. */
  voice: {
    available: () => call('voice:available'),
    /* `model` is the operator's choice from the Listen picker — '' or absent
     * means automatic, which climbs to Small and never picks Medium or Turbo
     * by itself (they cannot keep up with a live service; see voicelisten). */
    warmUp: (fast, model) => call('voice:warmUp', { fast, model }),
    translation: (translation) => call('voice:translation', { translation }),
    /** One finished phrase of 16 kHz mono PCM -> what was heard, and what to do.
     * `meta` carries { partial, capped } from the ear — see voiceear.js. They
     * only ever reach the cloud engine's allowance, never the parser. */
    hear: (pcm, live, fast, quote, model, meta) => call('voice:hear', Object.assign(
      { pcm, live, fast, quote, model }, { partial: !!(meta && meta.partial), capped: !!(meta && meta.capped),
        // `local` is the close-follow look-back saying "this PC, never the
        // cloud" — see followReading/close-follow in present.js.
        local: !!(meta && meta.local) })),
    /* The free cloud ear: what it is set to, changing it, and proving the key
     * works from the operator's chair. See src/main/cloudspeech.js. */
    cloudState: () => call('voice:cloudState'),
    cloudSet: (patch) => call('voice:cloudSet', patch || {}),
    cloudTest: (patch) => call('voice:cloudTest', patch || null),
    /** How often the ear should offer a look-back, given who is listening. */
    cadence: () => call('voice:cadence'),
    parse: (text, live) => call('voice:parse', { text, live }),
    /* Listening for QUOTED scripture: index this church's translations, and
     * ask what a line of speech was quoting. See src/main/versefind.js. */
    quotePrepare: (translation) => call('voice:quotePrepare', { translation }),
    quoteState: () => call('voice:quoteState'),
    quoteFind: (text) => call('voice:quoteFind', { text }),
    /** A transcript straight in, through the real parser and matcher. */
    hearText: (text, live, quote) => call('voice:hearText', { text, live, quote }),
  },
  bible: {
    catalogue: (refresh) => call('bible:catalogue', { refresh }),
    installed: () => call('bible:installed'),
    download: (abbr, jobId) => call('bible:download', { abbr, jobId }),
    remove: (abbr) => call('bible:remove', { abbr }),
    lookup: (translation, ref) => call('bible:lookup', { translation, ref }),
    search: (a) => call('bible:search', a),
    books: (translation) => call('bible:books', { translation }),
    chapter: (translation, bookNr, chapter) => call('bible:chapter', { translation, bookNr, chapter }),
    parseRef: (ref) => call('bible:parseRef', { ref }),
    apiVersions: () => call('bible:apiVersions'),
    import: (p, abbr, name) => call('bible:import', { path: p, abbr, name }),
  },
  // The motion backgrounds: posters ship with the app, the clip is fetched once.
  bgVideos: {
    installed: () => call('bgvideo:installed'),
    download: (id, url, jobId) => call('bgvideo:download', { id, url, jobId }),
    remove: (id) => call('bgvideo:remove', { id }),
  },
  // The songs the church sings, kept between services. The catalogue ships
  // with the app; the words in it are the church's own.
  songBank: {
    list: () => call('songbank:list'),
    save: (song) => call('songbank:save', { song }),
    remove: (id) => call('songbank:remove', { id }),
    merge: (songs) => call('songbank:merge', { songs }),
  },
  present: {
    library: () => call('present:library'),
    savePresentation: (presentation) => call('present:savePresentation', { presentation }),
    deletePresentation: (id) => call('present:deletePresentation', { id }),
    savePlaylist: (playlist) => call('present:savePlaylist', { playlist }),
    deletePlaylist: (id) => call('present:deletePlaylist', { id }),
    saveThemes: (themes) => call('present:saveThemes', { themes }),
    displays: () => call('present:displays'),
    // Switch the desktop from Duplicate to Extend, so a mirrored projector
    // becomes a screen of its own that slides can be sent to.
    extendScreens: () => call('present:extendScreens'),
    open: (role, displayId, windowed, id, name, render) => call('present:open', { role, displayId, windowed, id, name, render }),
    close: (key) => call('present:close', { role: key }),
    state: () => call('present:state'),
    set: (patch) => call('present:set', patch),
    // the output windows subscribe to this; the studio listens for open/close
    onState: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('present:state', fn);
      return () => ipcRenderer.removeListener('present:state', fn);
    },
    onOutputs: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('present:outputs', fn);
      return () => ipcRenderer.removeListener('present:outputs', fn);
    },
    // next/prev/black/clear arriving from a phone or a Stream Deck
    onRemote: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('present:remote', fn);
      return () => ipcRenderer.removeListener('present:remote', fn);
    },
  },
  // DMX lighting over Art-Net — house lights and colour washes from a macro.
  dmx: {
    state: () => call('dmx:state'),
    configure: (a) => call('dmx:configure', a || {}),
    send: (a) => call('dmx:send', a || {}),
    blackout: (universe) => call('dmx:blackout', { universe }),
  },
  // Publishing the presentation screens onto the network over NDI.
  ndiOut: {
    state: () => call('ndiout:state'),
    start: (a) => call('ndiout:start', a || {}),
    stop: (id) => call('ndiout:stop', { id }),
  },
  // App-free stage display + REST API on the local network.
  webout: {
    start: (a) => call('webout:start', a || {}),
    stop: () => call('webout:stop'),
    state: () => call('webout:state'),
  },
  // Phone Studio — the Video Studio, driven from a phone on the same wifi.
  /* The Video Studio, from anywhere in the world (src/cloud/). `cloud:url`
   * arrives on its own when the tunnel hands back a public address — it can
   * take a few seconds, and the panel should not have to poll for it. */
  cloud: {
    state: () => call('cloud:state'),
    status: () => call('cloud:status'),
    start: (port, allowUpload) => call('cloud:start', { port, allowUpload }),
    stop: () => call('cloud:stop'),
    newCode: (code) => call('cloud:newCode', { code }),
    setUpload: (allow) => call('cloud:setUpload', { allow }),
    tunnelInstall: (jobId) => call('cloud:tunnelInstall', { jobId }),
    tunnelStart: () => call('cloud:tunnelStart'),
    tunnelStop: () => call('cloud:tunnelStop'),
    tunnelToken: (token) => call('cloud:tunnelToken', { token }),
    onUrl: (cb) => {
      const fn = (_e, payload) => cb(payload);
      ipcRenderer.on('cloud:url', fn);
      return () => ipcRenderer.removeListener('cloud:url', fn);
    },
  },
  phone: {
    start: (a) => call('phone:start', a || {}),
    stop: () => call('phone:stop'),
    state: () => call('phone:state'),
    newPin: () => call('phone:newPin'),
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
    /* ☁️ The free cloud ear for captions (Groq's full-size Whisper), and the
     * key it needs. See cloudCaptions in main.js. */
    cloud: () => call('captions:cloud'),
    cloudKey: (a) => call('captions:cloudKey', a),
    /* ✍ The AI half of the caption proof-reader. See src/renderer/capgrammar.js. */
    grammar: (a) => call('captions:grammar', a),
    /* The Word Book: the words this church's captions keep getting wrong, and
     * what they should say instead. See src/main/wordbook.js. */
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
  // The optional local thinking model that judges Long-to-shorts clips.
  llm: {
    status: () => call('llm:status'),
    install: (a) => call('llm:install', a),
    removeModel: (a) => call('llm:removeModel', a),
  },
  overlays: {
    burn: (a) => call('overlays:burn', a),
    burnImages: (a) => call('overlays:burnImages', a),
  },
  flyer: {
    render: (a) => call('flyer:render', a),
    savePng: (a) => call('flyer:savePng', a),
  },
  fonts: {
    data: () => call('fonts:data'),
  },
  accounts: {
    list: () => call('accounts:list'),
    connectFb: () => call('accounts:connectFb'),
    connectYt: () => call('accounts:connectYt'),
    connectTk: () => call('accounts:connectTk'),
    connectTkEasy: () => call('accounts:connectTkEasy'),
    connectZo: () => call('accounts:connectZo'),
    connectZoYt: () => call('accounts:connectZoYt'),
    connectZoFb: () => call('accounts:connectZoFb'),
    connectZoIg: () => call('accounts:connectZoIg'),
    connectUpIg: () => call('accounts:connectUpIg'),
    add: (connectId, selections) => call('accounts:add', { connectId, selections }),
    remove: (id) => call('accounts:remove', { id }),
    check: (id) => call('accounts:check', { id }),
  },
  // 🎯 the reframe's eye — which of the people found is preaching (cloudsee.js)
  reframe: {
    aiState: () => call('reframe:aiState'),
    whoIsSpeaking: (a) => call('reframe:whoIsSpeaking', a || {}),
  },
  social: {
    suggestCopy: (a) => call('social:suggestCopy', a),
    planSchedule: (a) => call('social:planSchedule', a),
    // Who writes the captions: the free cloud model, this PC, or the rules.
    cloudState: () => call('social:cloudState'),
    cloudSet: (patch) => call('social:cloudSet', patch || {}),
    cloudTest: (patch) => call('social:cloudTest', patch || null),
  },
  scheduler: {
    list: () => call('scheduler:list'),
    add: (post) => call('scheduler:add', { post }),
    update: (id, patch) => call('scheduler:update', { id, patch }),
    remove: (id) => call('scheduler:remove', { id }),
    publish: (id) => call('scheduler:publish', { id }),
    publishAuto: (id) => call('scheduler:publishAuto', { id }),
    retry: (id) => call('scheduler:retry', { id }),
    // Which accounts a platform is holding the post for (PC can be off) and
    // which still need this PC on — keyed by post id.
    plans: () => call('scheduler:plans'),
    handOff: (id) => call('scheduler:handOff', { id }),
    testFb: (pageId, token) => call('scheduler:testFb', { pageId, token }),
  },
  // Posting when the app is closed: the OS-level poster (src/main/autopost.js).
  autopost: {
    status: () => call('autopost:status'),
    enable: (everyMinutes) => call('autopost:enable', { everyMinutes }),
    disable: () => call('autopost:disable'),
    runNow: () => call('autopost:runNow'),
    testBackground: () => call('autopost:testBackground'),
  },
  live: {
    destinations: () => call('live:destinations'),
    // vMix-style quality presets (synchronous — plain data, cloned by the bridge)
    qualityPresets: QUALITIES,
    qualityGroups: QUALITY_GROUPS,
    legacyQuality: LEGACY_QUALITY,
    defaultQuality: DEFAULT_QUALITY,
    // Sound quality is its own dial — the picture presets all say 128 kbps
    // because vMix's list does, and that is not enough for a room that sings.
    audioQualities: AUDIO_QUALITIES,
    defaultAudioQuality: DEFAULT_AUDIO_QUALITY,
    // The platform's own recommended bitrate per picture size, and the share of
    // a measured line a plan is allowed to use.
    rateTiers: RATE_TIERS,
    uplinkUsable: UPLINK_USABLE,
    // Which destinations would have to be re-encoded live? Asked of the main
    // process rather than worked out here, so the warning in the dialog and the
    // decision the hub actually makes can never disagree again.
    copyCheck: (qualities, fps) => call('live:copyCheck', { qualities, fps }),
    // Measure the line and say whether this Sunday's destinations fit down it.
    uplinkTest: (qualities, fps) => call('live:uplinkTest', { qualities, fps }),
    // cut / fade / start a broadcast, sent from another machine on the LAN
    onRemote: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:remote', fn);
      return () => ipcRenderer.removeListener('live:remote', fn);
    },
    onUplinkProgress: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:uplinkProgress', fn);
      return () => ipcRenderer.removeListener('live:uplinkProgress', fn);
    },
    start: (destId, cfg) => call('live:start', { destId, ...cfg }),
    stop: (destId) => call('live:stop', destId ? { destId } : {}),
    state: () => call('live:state'),
    // The program capture session the chunks belong to — lets the main process
    // ignore anything still in flight from a recorder it has already replaced.
    session: (cfg) => call('program:session', cfg),
    // Raise the shared encode in place when a platform joins a session that was
    // created for a recording — see upgradeCaptureForStream.
    rerate: (videoKbps) => call('program:rerate', { videoKbps }),
    engine: () => call('live:engine'),
    chunk: (sid, buf) => ipcRenderer.send('live:chunk', { sid, buf }),
    onStats: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('live:stats', fn);
      return () => ipcRenderer.removeListener('live:stats', fn);
    },
    onEnded: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:ended', fn);
      return () => ipcRenderer.removeListener('live:ended', fn);
    },
    onReconnecting: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:reconnecting', fn);
      return () => ipcRenderer.removeListener('live:reconnecting', fn);
    },
    onConnected: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:connected', fn);
      return () => ipcRenderer.removeListener('live:connected', fn);
    },
    // A destination's upload can't keep up and is having picture shed to protect
    // the sound. Silence here is what let a church stream crackle for a whole
    // service without a clue why.
    onBandwidth: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('live:bandwidth', fn);
      return () => ipcRenderer.removeListener('live:bandwidth', fn);
    },
    // AUTO-FIT: the hub asks the capture to change the video bitrate it is
    // encoding at, so the stream fits the line instead of being shed at the
    // far end. Only the renderer can do it — it owns the encoder.
    onBitrate: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('program:bitrate', fn);
      return () => ipcRenderer.removeListener('program:bitrate', fn);
    },
    /** …and the answer: did the encoder actually take it? */
    bitrateApplied: (videoKbps, ok) => ipcRenderer.send('live:bitrateApplied', { videoKbps, ok }),
    // The program encoder died and needs a fresh capture session from us.
    onProgramRestart: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('program:restart', fn);
      return () => ipcRenderer.removeListener('program:restart', fn);
    },
    // Record / MultiCorder (program → a local file via ffmpeg). The container
    // follows the chosen sound format — MP4 for AAC, MKV for MP3, MOV for PCM.
    recStart: (a) => call('rec:start', a),
    recFormats: () => call('rec:formats'),
    recChunk: (recId, buf) => ipcRenderer.send('rec:chunk', { recId, buf }),
    recStop: (recId) => call('rec:stop', { recId }),
    onRecStats: (cb) => {
      const fn = (_e, s) => cb(s);
      ipcRenderer.on('rec:stats', fn);
      return () => ipcRenderer.removeListener('rec:stats', fn);
    },
    onRecEnded: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('rec:ended', fn);
      return () => ipcRenderer.removeListener('rec:ended', fn);
    },
    // screen-capture inputs + status-bar metrics
    screenSources: () => call('live:screenSources'),
    pickScreen: (id) => call('live:pickScreen', { id }),
    metrics: () => call('live:metrics'),
    // Web Browser / Video Call / PowerPoint (offscreen browser engine)
    browserOpen: (id, url) => call('browser:open', { id, url }),
    browserNav: (id, url) => call('browser:nav', { id, url }),
    browserClose: (id) => call('browser:close', { id }),
    onBrowserFrame: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('browser:frame', fn);
      return () => ipcRenderer.removeListener('browser:frame', fn);
    },
    // Stream / SRT network ingest
    netStreamStart: (id, url) => call('netstream:start', { id, url }),
    netStreamStop: (id) => call('netstream:stop', { id }),
    onNetStreamEnded: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('netstream:ended', fn);
      return () => ipcRenderer.removeListener('netstream:ended', fn);
    },
    // NDI — real network video/audio sources (discovery + receive)
    ndiStatus: () => call('ndi:status'),
    ndiSources: () => call('ndi:sources'),
    ndiStart: (id, source, opts) => call('ndi:start', { id, source, ...(opts || {}) }),
    ndiStop: (id) => call('ndi:stop', { id }),
    ndiFps: (id, fps) => call('ndi:fps', { id, fps }),
    onNdiError: (cb) => {
      const fn = (_e, p) => cb(p);
      ipcRenderer.on('ndi:error', fn);
      return () => ipcRenderer.removeListener('ndi:error', fn);
    },
  },
  ppt: {
    check: () => call('ppt:check'),
    convert: (pptxPath) => call('ppt:convert', { pptxPath }),
  },
  shell: {
    openExternal: (url) => call('shell:openExternal', { url }),
    showItem: (p) => call('shell:showItem', { path: p }),
    openPath: (p) => call('shell:openPath', { path: p }),
  },
  fs: {
    readImageDataUrl: (p) => call('fs:readImageDataUrl', { path: p }),
    writeText: (p, text) => call('fs:writeText', { path: p, text }),
    writeImageDataUrl: (dataUrl, name) => call('fs:writeImageDataUrl', { dataUrl, name }),
    readText: (p) => call('fs:readText', { path: p }),
  },
  photos: {
    list: () => call('photos:list'),
  },
  // Event subscriptions
  onJobProgress: (cb) => {
    const fn = (_e, payload) => cb(payload);
    ipcRenderer.on('job:progress', fn);
    return () => ipcRenderer.removeListener('job:progress', fn);
  },
  onSchedulerDue: (cb) => {
    const fn = (_e, id) => cb(id);
    ipcRenderer.on('scheduler:due', fn);
    ipcRenderer.on('scheduler:focus-post', fn);
    return () => {
      ipcRenderer.removeListener('scheduler:due', fn);
      ipcRenderer.removeListener('scheduler:focus-post', fn);
    };
  },
});
