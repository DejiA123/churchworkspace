'use strict';
/*
 * Church Work Space — Video Studio (CapCut-style)
 * Video preview + scrubbable timeline (filmstrip, ruler, playhead), draggable /
 * trimmable clip segments, an AI "find sermon highlights" button that drops
 * clips onto the timeline, and one-tap 9:16 short export.
 */
(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  /* A label the studio sets on EVERY render must be written only when it
   * changes. icons.js swaps a label's leading emoji for a line icon, so each
   * rewrite strips the icon and puts it back — a fresh layout of whatever panel
   * the button sits in, paid on every zoom step. With the Save, Export and
   * Find buttons in the bin, toolbar and inspector, that took the timeline
   * sweep from 45 to 26 fps (v2.79). */
  const putText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };
  const uid = () => 'c' + Math.random().toString(36).slice(2, 9);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const COLORS = ['#1f6feb', '#f5a623', '#2ea043', '#e5534b', '#a371f7', '#0aa2c0', '#db61a2', '#c9a227'];

  /*
   * The listening model captions default to.
   *
   * Small (466 MB) rather than the bundled Base, because accuracy is the whole
   * point of captions — a wrong word on a sermon clip is worse than no clip.
   * It is not in the installer, so it downloads once, and the app asks before
   * it does (ensureCapModelReady) with the size and a way to carry on with what
   * is already installed.
   */
  const DEFAULT_CAP_MODEL = 'small.en';

  const ve = {
    video: null,     // { path, info }
    segments: [],    // { id, start, end, label, color, ai }
    sel: null,
    pxPerSec: 8,
    drag: null,
    inited: false,
    refs: {},
    presets: {},
    aspect: 'reel-9x16',
    framing: { zoom: 1, offsetX: 0.5, offsetY: 0.5 }, // manual pan/zoom crop (used when auto-reframe is off)
    textOverlays: [], // [{id,text,x,y,w,h,start,end,color,sizePct,font,bold}]
    sounds: [],       // [{id,path,label,kind:'voice'|'fx',start,dur,volume}] — the 🔊 Sounds row
    soundSel: null,
    textSel: null,
    textEditing: null,
    /*
     * Thumbnails for added media, keyed by FILE PATH rather than stored on the
     * clip. They are data URLs of a few hundred KB, and every undo snapshot is a
     * JSON copy of ve.segments — putting them on the clip would make each
     * keystroke of history carry the pictures with it.
     */
    mediaThumbs: {},
    audio: [],        // INDEPENDENT audio clips [{id,start,end,color}] — NOT tied to video segments
    audioSel: null,
    activeRow: 'video', // which timeline row Split/Delete act on: 'video' | 'audio'
    snap: true,        // magnetic snapping when dragging/trimming clips
    history: [], future: [], // undo/redo stacks (segments + text overlays + audio)
    // Saved media library (see the MEDIA LIBRARY section): the background music
    // bed under every exported clip, and the outro tacked onto the end of each.
    lib: { music: [], clips: [] },
    libTab: 'music',
    music: null,       // { id, name, file, durationSec, volume, fadeIn, fadeOut, duck, bed, tlStart, len }
    outro: null,       // a library clip appended to every short
    outroAll: true,
    capStyleId: 'outline', // which visual caption look is selected (DEFAULT_CAP_STYLE)
    /*
     * Where the captions sit, as fractions of the EXPORT FRAME (not the preview
     * window, which is a different shape and size on every screen). null means
     * "wherever the Position dropdown says"; dragging the words on the preview
     * sets an exact point, and from then on that point is what gets burned in.
     */
    capPos: null,
    /*
     * How wide the caption block is allowed to run before the words wrap, as a
     * fraction of the EXPORT FRAME's width. This is what the handles on the left
     * and right edges of the caption drag — widen it for one long line, pinch it
     * in for two or three. It goes to the export untouched, so the line breaks
     * you set on the preview are the line breaks in the file.
     */
    capWidth: null, // null = CapLayout.DEFAULT_WIDTH
    /*
     * 📦 The batch: many videos, one graphic over all of them.
     *   files    — the queued videos, untouched on disk
     *   overlays — the picture(s), stored as FRACTIONS of the frame so one
     *              placement means the same thing on every video's size and shape
     *   sel      — which one is loaded in the editor right now
     */
    bulk: { files: [], overlays: [], sel: 0 },
    /*
     * Which speech model transcribes captions. '' would mean "whatever is
     * installed"; the default is SMALL because that is the one that gets the
     * words right — it is a one-time download and the app says so, with the
     * size, at the moment it is first needed (ensureCapModelReady).
     */
    capModel: DEFAULT_CAP_MODEL,
    /*
     * Which model JUDGES the shorts ('' = the built-in rules engine).
     *
     * Deliberately defaulted OFF. The rules engine is what every measurement in
     * this pipeline was made against, it is instant, and it needs no download —
     * so the operator opts IN to the slower, better reader rather than
     * discovering one day that their scan takes three times as long.
     */
    aiModel: '',
    /*
     * Which speech model a Long-to-shorts scan LISTENS with ('' = automatic,
     * which climbs to Small and stops — see captioner.pickScanModel). Separate
     * from `capModel`, which is for captions: the two jobs read wildly different
     * amounts of audio, so the right answer for one is the wrong answer for the
     * other and a single setting could only be wrong somewhere.
     */
    asrModel: '',
    follow: true,      // keep the playhead in view while playing (off once you scroll yourself)
    // What fills the frame when the picture's shape isn't the short's shape, and
    // whether the room noise under the voice is taken out on export. Both are
    // remembered between sessions (see loadExportPrefs).
    fill: { mode: 'crop', strength: 0.6, dim: 0.18 },
    denoise: { on: false, level: 'medium' },
    fade: { in: 0, out: 0 }, // seconds of audio fade-in/out on the clip's own audio, on export
    /*
     * How many pixels every export gets: '720p' | '1080p' | '4k' | 'source'.
     * Separate from the ASPECT, because "a Reel" and "in 4K" are two different
     * decisions — the preset says the shape, this says the size.
     */
    quality: '1080p',
    fps: 0,                  // 0 = the recording's own frame rate
    bitrate: 'recommended',  // 'lower' | 'recommended' | 'higher'
    /*
     * Captions that were BURNED INTO the recording before it ever got here.
     * They cannot be removed — the picture under the words was never filmed —
     * but the strip they sit in can be covered, and the app's own captions then
     * go on top. Kept as fractions of the frame so the same setting means the
     * same place whatever size the recording is.
     */
    cover: { on: false, mode: 'blur', x: 0, w: 1, y: 0.80, h: 0.18, strength: 0.8 },
  };

  /*
   * A file on the studio machine, as something the page can load.
   *
   * In the desktop window that is `file://`. In the Cloud Studio the very same
   * editor is running in a browser on a phone on the other side of the world,
   * where `file://` means the PHONE's disk — so the page installs
   * `window.MW_FILE_URL` and every path here becomes an authenticated URL back
   * to the machine doing the work. One hook, one meaning: "where do I fetch
   * this from". Same pattern as facetrack.js's MW_AI_BASE.
   */
  function fileUrl(p) {
    if (typeof window !== 'undefined' && window.MW_FILE_URL) return window.MW_FILE_URL(p);
    return 'file:///' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');
  }
  function fmt(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  const dur = () => (ve.video && ve.video.info.durationSec) || 0;
  // The outro sits AFTER the footage, so the track has to be long enough to show
  // it. Everything else still maps pixel-position → source time inside [0, dur].
  const outroDur = () => (ve.outro ? (ve.outro.durationSec || 0) : 0);
  const timelineEnd = () => dur() + outroDur();
  const trackW = () => Math.max(300, timelineEnd() * ve.pxPerSec);
  /* How wide the timeline may get before the filmstrip is dropped from the clip
   * blocks. 40,000px is roughly 1,700px per source frame — already far more
   * stretched than is any use — and it is the point past which rasterising the
   * scaled image starts costing more than a frame. See renderSegBlocks. */
  const FILM_MAX_W = 40000;

  /* ---------------- load ---------------- */
  async function loadVideo(path) {
    try {
      window.__showOverlay && window.__showOverlay('Reading video…');
      const info = await window.api.video.info(path);
      ve.video = { path, info, proxy: null, proxying: false };
      ve.segments = []; ve.sel = null; ve.filmstripUrl = null;
      ve.audio = []; ve.audioSel = null; ve.activeRow = 'video';
      ve.liveFaceCx = null; ve.liveFaceCy = null; ve._liveJump = null; ve._liveRawHist = null; resetLiveRender();
      if (window.FaceTrack && window.FaceTrack.resetLive) window.FaceTrack.resetLive(); // a new video must not inherit the old one's face/body arbitration
      ve.capWords = null; ve.capEvents = null; ve.capOffset = 0; ve._capSource = null; ve.capTarget = null;
      ve.capSel = null; ve.capEditing = null; ve.capScope = null;
      ve.framing = { zoom: 1, offsetX: 0.5, offsetY: 0.5 };
      ve.textOverlays = []; ve.textSel = null;
      ve.mediaThumbs = {};   // a new recording is a new project — nothing is on top of it yet
      ve.history = []; ve.future = []; updateUndoRedoButtons();
      setFollow(true, true); // a fresh video starts following the playhead again
      if (ve.refs.capOverlay) ve.refs.capOverlay.classList.add('hidden');
      if (ve.refs.filmstrip) ve.refs.filmstrip.style.backgroundImage = '';
      setupPreview(path, info);
      loadWaveform(path);
      renderTextOverlays();
      $('#veName').textContent = path.split(/[\\/]/).pop();
      $('#veStats').textContent = `  ${info.width}×${info.height} · ${info.durationLabel} · ${info.fps}fps`;
      $('#veFindHighlights').disabled = false;
      const capAllBtn = $('#veCapShorts'); if (capAllBtn) capAllBtn.disabled = false;

      // Default: fit the WHOLE video in view (zoomed out). User can zoom further.
      const fitW = ((ve.refs.tlScroll ? ve.refs.tlScroll.clientWidth : ve.refs.timeline.clientWidth) || 900) - 28;
      ve.pxPerSec = clamp(fitW / Math.max(1, info.durationSec), 0.15, 24);
      const zoomCtl = $('#veZoom'); if (zoomCtl) zoomCtl.value = String(ve.pxPerSec);

      // Seed the whole video as ONE real clip on the timeline (CapCut-style). Now
      // ✂ Split cuts THIS clip into two independent blocks, and dragging a block
      // away leaves a real gap (empty dark track) so you can rearrange / overlay.
      // `seed:true` keeps it OFF the Shorts panel (it's the timeline base, not a
      // short) — and editing it (trim/move/split/close gap) keeps it that way.
      // Shorts only come from Long-to-shorts, ＋ Clip or dragging on the timeline.
      ve.segments = [{ id: uid(), start: 0, end: info.durationSec, label: 'Full video', color: COLORS[0], ai: false, seed: true }];
      ve.sel = ve.segments[0].id;
      // Audio is its OWN independent clip. Splitting the VIDEO does NOT split it —
      // it only splits when you select the audio row and Split there.
      ve.audio = [{ id: uid(), start: 0, end: info.durationSec, color: '#2ea043' }];
      // sounds belong to the video they were placed on (a restored session brings its own)
      if (!ve._restoring) { ve.sounds = []; ve.soundSel = null; }
      ve.audioSel = null; ve.activeRow = 'video';

      // a different recording is a different piece of work: it gets its own
      // session, and the one before it stays saved under its own name
      if (!ve._restoring) { ve.sessionId = null; ve.sessionName = null; ve.sessionThumb = null; ve.sessionDirty = false; }
      updateSessionChip();
      const resumeBar = $('#veResume'); if (resumeBar) resumeBar.classList.add('hidden');
      resumePromptQuiet(false);

      window.__hideOverlay && window.__hideOverlay();
      renderRuler(); renderSegments(); updatePlayhead(); updateCropMask();

      // filmstrip (one ffmpeg pass) — best effort. Painted INTO each clip block so
      // clips look like real film and the empty track shows through as a gap.
      // NOT awaited: on a three-hour sermon it is 24 seeks into a 2 GB file, and
      // "Carry on" used to sit waiting for it before putting a single clip or
      // caption back. The pictures arrive when they arrive.
      loadFilmstrip(path);
    } catch (err) {
      window.__hideOverlay && window.__hideOverlay();
      window.__toast && window.__toast('⚠️ Could not open that video: ' + err.message, 'error');
    }
  }

  async function loadFilmstrip(path) {
    try {
      const strip = await window.api.video.filmstrip({ input: path, count: 24 });
      const dataUrl = await window.api.fs.readImageDataUrl(strip);
      if (!ve.video || ve.video.path !== path) return; // another video was opened meanwhile
      ve.filmstripUrl = dataUrl;
      renderSegments();
    } catch (e) { /* strip optional */ }
  }

  // HEVC & some other codecs can't play in Electron's <video>; build an H.264
  // proxy in the background. The original file is still used for AI + export.
  function setupPreview(origPath, info) {
    const player = ve.refs.player, nov = $('#veNoVid');
    const codecUnplayable = /hevc|h265|hev1|hvc1|prores|mpeg2|vc1|wmv/i.test(info.vcodec || '');
    // HEVC is what every iPhone records, and Safari — and Chrome on hardware
    // that decodes it — plays it as it is. Asking the browser first means a
    // phone shows the sermon at once instead of waiting on a server to
    // re-encode an hour of it; if it says yes and then cannot, the player's
    // error handler (in init) falls back to the proxy, so a wrong "yes" costs a
    // moment, not the preview.
    const hevc = /hevc|h265|hev1|hvc1/i.test(info.vcodec || '');
    const playsHevc = hevc && !!(player.canPlayType('video/mp4; codecs="hvc1.1.6.L93.B0"') || player.canPlayType('video/mp4; codecs="hev1.1.6.L93.B0"'));
    if (codecUnplayable && !playsHevc) { showPreparing(nov, player, info.vcodec); makeProxyBg(origPath); return; }
    player.src = fileUrl(origPath); player.load(); nov.style.display = 'none'; player.style.display = 'block';
    if (playsHevc) {
      const fallBack = () => {
        if (!ve.video || ve.video.path !== origPath || ve.video.proxy || ve.video.proxying) return;
        showPreparing(nov, player, info.vcodec); makeProxyBg(origPath);
      };
      // A decoder that "supports" HEVC but not this profile (10-bit HDR, say)
      // can sit at a black frame without ever raising an error.
      player.addEventListener('loadeddata', () => { if (!player.videoWidth) fallBack(); }, { once: true });
    }
  }
  function showPreparing(nov, player, codec) {
    player.style.display = 'none'; nov.style.display = 'flex';
    nov.innerHTML = `<div style="font-size:44px">⏳</div>
      <p style="text-align:center">Preparing a smooth preview &nbsp;<b class="ve-prep-pct">0%</b><br><span class="muted small">(${(codec || 'this format').toUpperCase()} can't play directly — building an H.264 preview)</span><br>
      <span class="muted small">You can already make Long to short clips &amp; edit — this only affects playback.</span></p>`;
  }
  async function makeProxyBg(origPath) {
    if (ve.video) ve.video.proxying = true;
    try {
      const jobId = window.__newJobId ? window.__newJobId() : 'p';
      ve._proxyJobId = jobId;
      const proxy = await window.api.video.makeProxy({ input: origPath, jobId });
      if (ve.video && ve.video.path === origPath) {
        ve.video.proxy = proxy; ve.video.proxying = false;
        ve.refs.player.src = fileUrl(proxy); ve.refs.player.load();
        $('#veNoVid').style.display = 'none'; ve.refs.player.style.display = 'block';
      }
    } catch (e) {
      if (ve.video) ve.video.proxying = false;
      $('#veNoVid').innerHTML = `<div style="font-size:44px">🎬</div><p class="muted">Preview unavailable for this format, but <b>Long to short clips</b>, editing &amp; export all still work.</p>`;
    }
  }

  /* ---------------- timeline render ---------------- */
  function layout() {
    const w = trackW();
    ve.refs.track.style.width = w + 'px';
    ve.refs.track.style.height = trackHeight() + 'px';
    ve.refs.ruler.style.width = w + 'px';
    ve.refs.filmstrip.style.width = w + 'px';
    if (ve.refs.textTrack) ve.refs.textTrack.style.width = w + 'px';
    if (ve.refs.capTrack) ve.refs.capTrack.style.width = w + 'px';
    if (ve.refs.audioTrack) ve.refs.audioTrack.style.width = w + 'px';
    if (ve.refs.musicTrack) ve.refs.musicTrack.style.width = w + 'px';
  }

  /**
   * The stretch of the timeline that is on screen right now, in seconds, with a
   * viewport's worth of margin either side so a small scroll never exposes a
   * blank lane before the next render catches up.
   *
   * Every lane that can hold hundreds of items culls to this. It is the same
   * window the ruler has always used for its ticks — now shared, because the
   * caption lane needed it far more than the ruler did.
   */
  function visibleTimeRange(pad = 0.5) {
    const sc = ve.refs.tlScroll;
    const viewW = (sc && sc.clientWidth) || 900;
    const left = sc ? sc.scrollLeft - tlPadL() : 0;
    return [
      Math.max(0, (left - viewW * pad) / ve.pxPerSec),
      (left + viewW * (1 + pad)) / ve.pxPerSec,
    ];
  }

  /** m:ss, plus tenths when the ruler is zoomed past one tick per second. */
  function fmtTick(t, step) {
    if (step >= 1) return fmt(t);
    const m = Math.floor(t / 60), s = t % 60;
    return `${m}:${(s < 10 ? '0' : '') + s.toFixed(1)}`;
  }
  /**
   * Everything the timeline's LAYOUT depends on, as one cheap string.
   *
   * Cheap is the point: it runs on every page switch, so it may not walk a
   * transcript of two thousand caption blocks. Anything that changes the drawn
   * geometry changes this — the recording, the clips and their cuts, the zoom,
   * the width available to draw into — and anything that does not (which is
   * most of what the studio holds) is left out of it deliberately.
   */
  function timelineSig() {
    const w = (ve.refs.tlScroll && ve.refs.tlScroll.clientWidth) || 0;
    const tw = (ve.refs.timeline && ve.refs.timeline.clientWidth) || 0;
    if (!ve.video) return 'none|' + w + '|' + tw;
    let segs = '';
    for (const s of ve.segments) {
      segs += s.id + ':' + s.start.toFixed(2) + '-' + s.end.toFixed(2) + ':' + (s.lane || 0)
        + ':' + ((s.cuts || []).length) + ';';
    }
    const caps = ve.capEvents || [];
    const audio = (ve.audio || []).length;
    return [
      ve.video.path, w, tw, ve.pxPerSec.toFixed(3), ve.aspect,
      segs, ve.textOverlays.length, audio,
      // the transcript, without reading all of it: a retype changes the text of
      // one block, and the block list is what gets drawn
      caps.length, caps.length ? (caps[0].start + '-' + caps[caps.length - 1].end) : '',
      ve.sel || '', ve.capSel == null ? '' : ve.capSel,
    ].join('|');
  }

  function renderRuler() {
    layout();
    const D = dur(); if (!D) { ve.refs.ruler.innerHTML = ''; return; }
    const sc = ve.refs.tlScroll;
    const viewW = (sc && sc.clientWidth) || 900;
    // Pick the tick step from what's actually ON SCREEN, not from the whole
    // duration: zoomed in (e.g. while editing captions) an hour-long sermon would
    // otherwise show a single "0:00" tick and you'd lose all sense of time.
    const raw = Math.min(D, viewW / ve.pxPerSec) / 10;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const step = steps.find((s) => s >= raw) || 1800;
    // …and only paint the ticks near the viewport — an hour of half-second ticks
    // would be thousands of nodes.
    const left = sc ? sc.scrollLeft - tlPadL() : 0;
    const from = Math.max(0, (left - viewW) / ve.pxPerSec);
    const to = Math.min(D, (left + viewW * 2) / ve.pxPerSec);
    let html = '';
    for (let k = Math.floor(from / step); k * step <= to; k++) {
      const t = k * step;
      if (t < 0 || t > D) continue;
      html += `<div class="ve-tick" style="left:${t * ve.pxPerSec}px"><span>${fmtTick(t, step)}</span></div>`;
    }
    ve.refs.ruler.innerHTML = html;
  }

  // The video track has TWO stacked lanes (CapCut-style): an OVERLAY lane on top
  // (lane 1 → picture-in-picture) and the MAIN lane on the bottom (lane 0).
  /*
   * The video track is the MAIN lane at the bottom with a stack of OVERLAY rows
   * above it — as many as are actually in use, up to MAX_OVERLAY_LANES. Two
   * pictures on screen at once is two rows; the row a clip sits on is also its
   * stacking order, so a clip on row 2 is drawn over one on row 1, on the
   * preview and in the exported file alike.
   *
   * The rows are added as they are needed rather than always shown: a timeline
   * with nothing overlaid should not spend a third of its height on empty lanes.
   */
  const MAX_OVERLAY_LANES = 4;
  const LANE = { h: 40, gap: 3, mainH: 52 };
  /** How many overlay rows to draw right now (always at least one to drop onto). */
  function overlayLaneCount() {
    const used = ve.segments.reduce((m, x) => Math.max(m, (x.lane || 0)), 0);
    return Math.max(1, Math.min(MAX_OVERLAY_LANES, used));
  }
  /** Total height of the video track for the rows currently in use. */
  function trackHeight() {
    const n = overlayLaneCount();
    return n * (LANE.h + LANE.gap) + LANE.mainH + 4;
  }
  /** Top edge of a lane, in px. Lane 1 is nearest the main track, higher rows above. */
  function laneTop(lane) {
    const n = overlayLaneCount();
    if (!lane) return n * (LANE.h + LANE.gap) + 2;
    return (n - Math.min(lane, n)) * (LANE.h + LANE.gap) + 2;
  }
  function laneStyle(lane) {
    return lane
      ? `top:${laneTop(lane)}px;height:${LANE.h}px;`
      : `top:${laneTop(0)}px;height:${LANE.mainH}px;`;
  }
  /** Which lane a pointer at `y` (px inside the track) is over. */
  function laneAtY(y) {
    const n = overlayLaneCount();
    const mainTop = laneTop(0);
    if (y >= mainTop) return 0;
    const row = Math.floor(Math.max(0, y) / (LANE.h + LANE.gap));
    return Math.max(1, Math.min(n, n - row));
  }
  // an overlay clip plays at tlStart (independent of its footage start/end)
  const tlPos = (s) => ((s.lane || 0) >= 1 && s.tlStart != null) ? s.tlStart : s.start;

  /* ---------------- added media: a SECOND video, or a picture ----------------
   *
   * The overlay lane used to hold one thing only: another slice of the recording
   * already open, shown as picture-in-picture. An added-media clip is the same
   * kind of block on the same lane, except it carries `src` — its own file — so
   * its `start`/`end` are times inside THAT file and `tlStart` is where it sits
   * on this timeline. Everything downstream keys off `src`:
   *
   *   • the clip block paints ITS OWN thumbnail, not this video's filmstrip
   *   • the preview shows the real picture/footage inside the PiP box
   *   • trimming moves the in/out point of its own footage, not this video's
   *   • the export hands ffmpeg that file as an extra input (see
   *     video.exportOverlayComposite), looping it when it is a photo
   *
   * A picture has no duration of its own, so it gets one: IMAGE_DEFAULT_SEC on
   * the timeline, stretchable by dragging its edge like any other clip.
   */
  const IMG_RE = /\.(jpe?g|png|webp|bmp|tiff?|avif)$/i;
  const isImgPath = (p) => IMG_RE.test(String(p || ''));
  /** A clip that came from another FILE (a second video, or a picture). */
  const isMedia = (s) => !!(s && s.src);
  const IMAGE_DEFAULT_SEC = 5;
  const IMAGE_MAX_SEC = 3600;   // a photo can be held for as long as you like
  /** How much footage this clip HAS to give — its own source length. */
  function srcLen(s) {
    if (!isMedia(s)) return dur();
    if (s.kind === 'image') return IMAGE_MAX_SEC;
    return ((s.srcInfo && s.srcInfo.durationSec) || (s.end - s.start)) || 1;
  }
  /** Aspect ratio of what an overlay clip actually shows (its own, or this video's). */
  function mediaAR(s) {
    const i = isMedia(s) ? s.srcInfo : (ve.video && ve.video.info);
    return (i && i.width && i.height) ? i.width / i.height : 16 / 9;
  }
  /**
   * Where a newly added overlay sits.
   *
   * Measured against the part of the frame that IS THE EXPORT, not the whole
   * source picture. A 9:16 short keeps only the middle third of a 16:9 service,
   * so the obvious 'top-right corner' default (x=0.6) put every added picture
   * outside the short entirely — added, correctly composited, and cropped away
   * unseen. Placing it inside the crop window means what you add is what you get,
   * whichever shape is selected; drag it anywhere afterwards.
   *
   * Media that already matches the shape of that window (a title card rendered to
   * size, a full-frame lower third) FILLS it rather than sitting in a corner.
   */
  function defaultPip(ar) {
    let fAR = 9 / 16;
    try { fAR = frameAR(); } catch (e) { /* no video yet */ }
    // Something the same shape as the frame is meant to FILL it — dropping a 9:16
    // clip onto a 9:16 short should cover the picture, not perch in the corner.
    if (ar && Math.abs(ar - fAR) / fAR < 0.06) return { pipX: 0, pipY: 0, pipW: 1 };
    const w = 0.34;
    return { pipX: clamp(1 - w - 0.04, 0, 1), pipY: 0.05, pipW: w };
  }

  /* ---------------- removed pauses inside a clip ("close the gap") ----------------
   * A clip can have `cuts`: source ranges INSIDE [start,end] that the user took out
   * (a pause, an "umm", a cough). The clip stays ONE short — it just exports with
   * those ranges dropped and the remaining pieces joined back-to-back.
   *
   * Why cuts instead of moving blocks left: on this timeline a main-lane clip's
   * pixel position IS its source time, and the ruler, filmstrip, waveform, text and
   * caption lanes all share that mapping. Sliding a block left to visually close a
   * gap would desynchronise it from every other lane — captions above all, which is
   * exactly what must stay aligned. So the pieces stay put and the removed range is
   * drawn as a stitched-out notch; playback skips it, and export drops it. */
  const cutsOf = (s) => ((s && s.cuts) || []).slice().sort((a, b) => a.start - b.start);
  /** Total seconds removed from inside this clip. */
  function removedDur(s) {
    return cutsOf(s).reduce((a, c) => a + Math.max(0, Math.min(s.end, c.end) - Math.max(s.start, c.start)), 0);
  }
  /** How long the exported short will actually be. */
  function keptDur(s) { return Math.max(0, (s.end - s.start) - removedDur(s)); }
  /** The source ranges that survive, in order — what export joins together. */
  function keptPieces(s) {
    const out = []; let t = s.start;
    for (const c of cutsOf(s)) {
      const a = Math.max(s.start, c.start), b = Math.min(s.end, c.end);
      if (b <= a) continue;
      if (a > t) out.push({ start: t, end: a });
      t = Math.max(t, b);
    }
    if (t < s.end) out.push({ start: t, end: s.end });
    return out;
  }
  /** The cut covering source time t, or null. */
  function cutAt(s, t) {
    for (const c of cutsOf(s)) if (t >= c.start && t < c.end) return c;
    return null;
  }
  /**
   * Source time → time in the EXPORTED short (0-based), skipping removed ranges.
   * Returns null when t was removed, so callers can drop what fell in a pause.
   */
  function srcToOut(s, t) {
    const v = srcToOutRaw(s, t);
    if (v == null || !s.xfades) return v;
    // a transition overlaps the clips either side of it, so everything after a
    // join happens that much EARLIER in the export (see editedSpan)
    let o = v;
    for (const x of s.xfades) if (t >= x.at) o -= x.d;
    return Math.max(0, o);
  }
  function srcToOutRaw(s, t) {
    if (t < s.start || t > s.end) return null;
    let out = 0, cur = s.start;
    for (const c of cutsOf(s)) {
      const a = Math.max(s.start, c.start), b = Math.min(s.end, c.end);
      if (b <= a) continue;
      if (t < a) return out + (t - cur);
      if (t < b) return null;      // inside a removed pause
      out += a - cur; cur = b;
    }
    return out + (t - cur);
  }
  /**
   * Where a moment of the timeline lands in the export, for something that has
   * to appear even if it starts or ends inside a removed stretch (added text):
   * a start inside one moves to where the footage resumes, an end to where it
   * stopped. Without cuts or transitions this is exactly t − s.start, as it
   * always was.
   */
  function outTime(s, t, edge) {
    const tt = Math.max(s.start, Math.min(s.end, t));
    const v = srcToOut(s, tt);
    if (v != null) return v;
    const c = cutsOf(s).find((x) => tt >= x.start && tt < x.end);
    if (!c) return Math.max(0, tt - s.start);
    return srcToOut(s, edge === 'end' ? Math.max(s.start, c.start - 0.001) : Math.min(s.end, c.end)) || 0;
  }
  /** Does this export run on a different clock from its source range? */
  const reTimed = (s) => hasCuts(s) || !!(s && s.xfades && s.xfades.length);
  /** Any main-lane clip with pauses removed? (drives the preview skip.) */
  const hasCuts = (s) => cutsOf(s).length > 0;

  /* ---- magnetic snapping (CapCut-style) ---- */
  function snapPoints(excludeId) {
    const pts = [0, dur(), ve.refs.player.currentTime || 0];
    ve.segments.forEach((s) => { if (s.id !== excludeId) { pts.push(tlPos(s)); pts.push(tlPos(s) + (s.end - s.start)); } });
    return pts;
  }
  /** Snap a time to the nearest edge/playhead within ~9px; returns {t, snapped}. */
  function snapT(t, excludeId) {
    if (!ve.snap) return { t, snapped: false };
    const thresh = 9 / ve.pxPerSec;
    let best = t, bestD = thresh, hit = false;
    for (const p of snapPoints(excludeId)) { const d = Math.abs(p - t); if (d < bestD) { bestD = d; best = p; hit = true; } }
    return { t: best, snapped: hit };
  }
  function toggleSnap() {
    ve.snap = !ve.snap;
    const b = $('#veSnap'); if (b) b.classList.toggle('on', ve.snap);
    window.__toast && window.__toast(ve.snap ? '🧲 Snapping ON' : 'Snapping off', 'good');
  }

  /* ---- zoom controls ---- */
  function setZoom(px, keepCenter) {
    // A caption being typed into is skipped by renderCapTrack (so the caret is
    // never yanked out mid-word) — save it first, or the lane would keep its old
    // pixel positions while every other lane rescales.
    commitCapEdit();
    const sc = ve.refs.tlScroll;
    const centerT = (keepCenter && sc) ? (sc.scrollLeft + sc.clientWidth / 2) / ve.pxPerSec : null;
    ve.pxPerSec = clamp(px, 0.15, 200);
    const z = $('#veZoom'); if (z) z.value = String(ve.pxPerSec);
    // The wheel is turning: draw cheap now, and put the detail back shortly
    // after it stops (see showFilm in renderSegBlocks).
    ve._zoomBusy = true;
    clearTimeout(ve._zoomSettle);
    ve._zoomSettle = setTimeout(() => { ve._zoomBusy = false; renderLanesSoon(); }, 140);
    /*
     * Move the view FIRST, then draw.
     *
     * Every lane culls to what is on screen, so drawing before the scroll
     * position has been corrected paints the old window and then has to paint
     * the new one — two renders per zoom step, and a visible flash of empty
     * lanes in between.
     */
    if (centerT != null && sc) setScrollLeft(sc, Math.max(0, centerT * ve.pxPerSec - sc.clientWidth / 2));
    // Zooming rescales every lane — but only the lanes, and coalesced to one
    // render per frame, because the wheel and the slider both fire far faster
    // than the screen refreshes.
    renderRuler(); renderLanesSoon(); updatePlayhead();
  }
  function zoomBy(factor) { setZoom(ve.pxPerSec * factor, true); }
  function fitZoom() {
    if (!ve.video) return;
    const sc = ve.refs.tlScroll;
    const w = ((sc ? sc.clientWidth : ve.refs.timeline.clientWidth) || 900) - 28;
    // "Fit" means everything ON the timeline — including the outro parked after
    // the footage, which is otherwise just off the right-hand edge.
    setZoom(clamp(w / Math.max(1, timelineEnd()), 0.15, 24), false);
    if (sc) sc.scrollLeft = 0;
  }
  /* ---------------- keeping the timeline smooth ----------------
   * renderSegments() rebuilds EVERY lane plus the clip-card panel (thumbnails,
   * five listener passes). That's fine for a one-off edit and far too much to do
   * per mousemove — dragging a clip edge or spinning the zoom wheel fires 60-120
   * of those a second, and the timeline visibly stuttered.
   *
   * Two things fix it, and both matter:
   *  - coalesce to ONE render per animation frame, so a burst of events can never
   *    queue up more work than the screen can show;
   *  - while a drag is live, repaint only the clip blocks. The text / caption /
   *    audio / music lanes cannot change while a video clip is being dragged, and
   *    the clip cards are re-rendered on mouse-up anyway.
   */
  /* Three depths of repaint, cheapest first, coalesced to one per frame:
   *   'blocks' — just the clip rectangles (a clip being dragged)
   *   'lanes'  — every lane rescaled (zoom, pan)
   *   'full'   — lanes plus the Shorts panel and hints (clips added/removed) */
  const RENDER_DEPTH = { blocks: 0, lanes: 1, full: 2 };
  function renderSoon(depth) {
    const want = RENDER_DEPTH[depth];
    ve._renderDepth = Math.max(ve._renderDepth == null ? -1 : ve._renderDepth, want); // deepest request wins
    if (ve._renderRaf) return;
    ve._renderRaf = requestAnimationFrame(() => {
      ve._renderRaf = null;
      const d = ve._renderDepth; ve._renderDepth = null;
      if (d >= RENDER_DEPTH.full) renderSegments();
      else if (d >= RENDER_DEPTH.lanes) renderLanes();
      else { renderSegBlocks(); renderJoins(); }
    });
  }
  const renderLanesSoon = () => renderSoon('lanes');
  function renderSegmentsSoon(light) { renderSoon(light ? 'blocks' : 'full'); }
  /** Drop a queued frame — the caller is rendering right now instead. */
  function cancelRenderQueue() {
    if (ve._renderRaf) { cancelAnimationFrame(ve._renderRaf); ve._renderRaf = null; ve._renderDepth = null; }
  }
  /** Run a queued frame NOW. For anything that must read the DOM immediately. */
  function flushRender() {
    if (!ve._renderRaf) return;
    cancelAnimationFrame(ve._renderRaf); ve._renderRaf = null;
    const d = ve._renderDepth; ve._renderDepth = null;
    if (d >= RENDER_DEPTH.full) renderSegments();
    else if (d >= RENDER_DEPTH.lanes) renderLanes();
    else { renderSegBlocks(); renderJoins(); }
  }

  /**
   * Every LANE on the timeline, rescaled. This is what zooming and panning need
   * and all they need.
   *
   * The Shorts panel down the side, the "Long to shorts" hint and the preview
   * mask are not on the timeline and do not change when the zoom does — but
   * they used to be rebuilt with it, thumbnails, listeners and all, sixty times
   * a second while the wheel turned. Splitting them out is most of the
   * difference between a zoom that keeps up and one that does not.
   */
  function renderLanes() {
    cancelRenderQueue();
    // Zoom and pan only move the clips — patch them in place when nothing about
    // them has actually changed (see rescaleSegBlocks).
    if (!rescaleSegBlocks()) renderSegBlocks();
    renderJoins();
    renderTextTrack();
    renderCapTrack();
    renderAudioSegments();
    renderMusicLane();
    renderSoundTrack();
    renderOverlayGuide();
    renderMediaLayer();
  }

  /** Lanes PLUS everything that depends on what the clips are, not where they are drawn. */
  /* ---------------------- one gesture, one render ----------------------
   *
   * The small operations compose: addSegment() selects and renders, selectSeg()
   * renders, and a caller that used both then rendered again to be sure. Each
   * of those is correct on its own and together they meant a SPLIT rendered the
   * whole timeline five times — measured at about 30 ms each on a 90-minute
   * sermon, so one keypress cost 150 ms of frozen window.
   *
   * batchRender() lets a compound gesture keep calling the small pieces and
   * still render exactly once, at the end. It stays SYNCHRONOUS on purpose:
   * the render has happened by the time the gesture returns, so everything that
   * reads the DOM straight afterwards — the studio's own code and every test —
   * sees the finished timeline, exactly as before.
   */
  let _renderHold = 0, _renderHeld = false;
  function batchRender(fn) {
    _renderHold++;
    try { return fn(); }
    finally {
      _renderHold--;
      if (_renderHold === 0 && _renderHeld) { _renderHeld = false; renderSegments(); }
    }
  }

  function renderSegments() {
    if (_renderHold) { _renderHeld = true; return; }
    renderLanes();
    renderClipList();
    updateSearchHint();
    updateOverlayTools();
    updateGapMask(ve.refs.player.currentTime || 0); // deleting/dragging a clip blanks the preview instantly
  }

  /**
   * Keep the Long-to-shorts button honest about WHERE it is going to look. The
   * timeline decides that (see searchRanges), and an operator who has just
   * dragged the block's edge in to the start of the preaching should be able to
   * read that back off the button before spending ten minutes on an analysis.
   */
  function updateSearchHint() {
    updateEditedExportHint();
    const b = $('#veFindHighlights'); if (!b) return;
    if (!ve.video) { b.title = 'Open a video first.'; b.classList.remove('ve-trimmed'); return; }
    const rs = searchRanges(), whole = searchIsWholeVideo(rs);
    b.title = whole
      ? 'Searches the WHOLE video for its best moments.\nTip: drag the clip’s edge on the timeline and only the part you keep is searched.'
      : `Searches only what you left on the timeline: ${rs.map(([a, c]) => fmt(a) + '–' + fmt(c)).join(', ')}.\nDrag the clip’s edges to change it.`;
    b.classList.toggle('ve-trimmed', !whole);
    putText(b, whole ? '✂️ Long to short clips (AI)' : `✂️ Shorts from ${fmt(rs[0][0])}–${fmt(rs[rs.length - 1][1])}`);
  }

  /**
   * Keep "Export video" honest about what it would save right now. Its whole
   * job is to be visibly separate from the Shorts panel, so it says its own
   * length rather than leaving the operator to wonder which button does what.
   */
  function updateEditedExportHint() {
    const b = $('#veExportEdited'); if (!b) return;
    if (!ve.video) {
      b.disabled = true;
      putText(b, '💾 Export video');
      b.title = 'Open a video first.';
      return;
    }
    const span = editedSpan();
    b.disabled = !span;
    if (!span) { putText(b, '💾 Export video'); b.title = 'Nothing on the main track to export.'; return; }
    const removed = (span.end - span.start) - span.kept;
    const ovN = overlayClips().length;
    putText(b, `💾 Export video (${fmt(span.kept)})`);
    b.title = `Saves the video as edited on the timeline — ${fmt(span.start)}–${fmt(span.end)}`
      + (removed > 1 ? `, with ${fmt(removed)} of closed gaps removed` : '')
      + (ovN ? `, with ${ovN === 1 ? 'the overlay' : ovN + ' overlays'} laid on top` : '')
      + `, at its original size. This is separate from the Shorts panel: shorts are not included, and this video is not one of them.`;
  }

  /** segBgCss's object as an inline style string (the full-rebuild path). */
  function bgStyle(o) {
    if (!o.backgroundImage) return `background:${o.background};`;
    return `background-image:${o.backgroundImage};background-size:${o.backgroundSize};`
      + `background-position:${o.backgroundPosition};background-repeat:${o.backgroundRepeat};`;
  }
  /** The film background for one clip, or its solid colour when film is off. */
  function segBgCss(s, total, showFilm) {
    // Added media is a different FILE — this video's filmstrip would show frames
    // that are not in it. Its own thumbnail is tiled across the block instead,
    // which also makes the block unmistakably "something else on top".
    if (isMedia(s)) {
      const th = ve.mediaThumbs[s.src];
      if (!th) return { backgroundImage: '', background: s.color };
      return {
        backgroundImage: `linear-gradient(180deg,rgba(0,0,0,.15),rgba(0,0,0,.55)),url('${th}')`,
        backgroundSize: `auto 100%,auto 100%`,
        backgroundPosition: `left center,left center`,
        backgroundRepeat: 'repeat-x,repeat-x',
      };
    }
    if (!showFilm) return { backgroundImage: '', background: s.color };
    const srcX = -(s.start * ve.pxPerSec);
    return {
      backgroundImage: `linear-gradient(180deg,rgba(0,0,0,.12),rgba(0,0,0,.5)),url('${ve.filmstripUrl}')`,
      backgroundSize: `${total}px 100%,${total}px 100%`,
      backgroundPosition: `${srcX}px 0,${srcX}px 0`,
      backgroundRepeat: 'no-repeat,no-repeat',
    };
  }

  /**
   * Zooming does not change WHAT is on the video lane, only where it is drawn —
   * so move the blocks that are already there instead of building them again.
   *
   * Rebuilding meant parsing the lane's HTML and creating every clip, handle,
   * notch and label from scratch on every frame of a wheel gesture. Nudging the
   * existing nodes is a handful of style writes. Returns false when the lane's
   * contents really have changed (a clip added, removed or renamed), and the
   * caller falls back to the full rebuild.
   */
  function rescaleSegBlocks() {
    const seg = ve.refs.segments;
    // A rescale IS a repaint of the lane, so it counts like one — the render
    // budget this number exists to police does not care which code path drew
    // the clips, only that they were drawn once per frame.
    ve._renderCount = (ve._renderCount || 0) + 1;
    const nodes = [...seg.querySelectorAll('.ve-seg[data-id]')];
    if (nodes.length !== ve.segments.length || !nodes.length) return false;
    const byId = new Map(ve.segments.map((s) => [String(s.id), s]));
    if (nodes.some((n) => !byId.has(n.dataset.id))) return false;
    // The outro is not a clip and carries no id, so it is invisible to the
    // count above: choosing one while the lane already had the right number of
    // clips would patch their positions and never create it. Presence has to
    // match before this path is allowed to skip the rebuild.
    if (!!seg.querySelector('.ve-seg-outro') !== !!(ve.outro && ve.video)) return false;
    layout();
    const total = trackW();
    const showFilm = !!ve.filmstripUrl && total <= FILM_MAX_W && !ve._zoomBusy;
    for (const n of nodes) {
      const s = byId.get(n.dataset.id);
      // Anything the fast path cannot express — a clip moved to the overlay
      // lane, a rename — sends the whole lane back to the full rebuild. Only
      // position and selection are cheap enough to patch in place, and a stale
      // label would be a far worse bug than a slower frame.
      if (n.classList.contains('ve-seg-ov') !== ((s.lane || 0) >= 1)) return false;
      const lab = n.querySelector('.ve-seg-label');
      if (lab && !lab.textContent.includes(s.label)) return false;
      // keyframe diamonds are placed along the block: a new one, or a trim that
      // moves them, needs the full redraw
      if ((n.dataset.kf || '') !== kfSig(s)) return false;
      // …and the 🔊 badge on added media, for the same reason: a stale badge
      // would tell the operator the opposite of what the export is about to do.
      if (isMedia(s) && !!n.querySelector('.ve-seg-snd')
          !== !!(s.kind === 'video' && s.srcInfo && s.srcInfo.hasAudio && !s.mute)) return false;
      n.classList.toggle('sel', ve.sel === s.id);
      n.style.left = tlPos(s) * ve.pxPerSec + 'px';
      n.style.width = Math.max(6, (s.end - s.start) * ve.pxPerSec) + 'px';
      const bg = segBgCss(s, total, showFilm);
      n.style.background = bg.background || '';
      n.style.backgroundImage = bg.backgroundImage || '';
      n.style.backgroundSize = bg.backgroundSize || '';
      n.style.backgroundPosition = bg.backgroundPosition || '';
      n.style.backgroundRepeat = bg.backgroundRepeat || '';
      const cuts = cutsOf(s);
      const marks = n.querySelectorAll('.ve-seg-cut');
      if (marks.length !== cuts.length) return false;   // structure moved on — rebuild
      cuts.forEach((c, k) => {
        const a = Math.max(s.start, c.start), b = Math.min(s.end, c.end);
        const w = Math.max(0, (b - a) * ve.pxPerSec);
        marks[k].style.left = (a - s.start) * ve.pxPerSec + 'px';
        marks[k].style.width = w + 'px';
        const tick = marks[k].querySelector('span');
        if (tick) tick.style.display = w >= 18 ? '' : 'none';
      });
    }
    const outro = seg.querySelector('.ve-seg-outro');
    if (outro && ve.outro) {
      outro.style.left = dur() * ve.pxPerSec + 'px';
      outro.style.width = Math.max(28, (ve.outro.durationSec || 3) * ve.pxPerSec) + 'px';
    }
    return true;
  }

  /** Just the clip blocks on the video track — the only thing a drag can change. */
  function renderSegBlocks() {
    ve._renderCount = (ve._renderCount || 0) + 1;
    layout();
    const seg = ve.refs.segments;
    const total = trackW();
    /*
     * WHY THE FILM DISAPPEARS WHEN YOU ZOOM RIGHT IN — and why that is the fix.
     *
     * The strip is ONE image of 24 frames spanning the whole video, and a clip
     * shows its own slice of it by scaling that image to the full width of the
     * timeline and offsetting it. The scale factor is therefore the timeline
     * width, and on a three-hour sermon zoomed in for caption work that is over
     * two MILLION pixels: the browser is asked to rasterise a 3,840-pixel image
     * up to two million pixels wide, twice, for every clip. It does not refuse —
     * it just takes hundreds of milliseconds and megabytes per clip, on every
     * single zoom step. That is the lag.
     *
     * Past the cap the picture had stopped meaning anything anyway: at 20 px/s
     * on this sermon one source frame covers 9,500 pixels of screen, so the
     * "film" is a single smeared frame. So beyond the cap each clip falls back
     * to its own solid colour — still an opaque block, so a split still reads as
     * a real cut — and the film comes back the moment you zoom out. Short
     * videos, which is most editing, stay under the cap at every zoom level and
     * never lose it at all.
     */
    /*
     * …and the SECOND half of the same problem: the scale changes on every
     * frame of a zoom gesture, so the browser cannot reuse the bitmap it
     * scaled last frame. It re-scales the strip once per clip per frame — a
     * dozen rescales of a 3,840-pixel image every 16 ms, measured at 33 ms of
     * work per frame with only twelve clips on the timeline.
     *
     * So while the wheel is actually turning, the clips are drawn as plain
     * blocks and the film comes back a moment after it stops — the same
     * "reduce detail while the user is dragging" trade every real editor makes.
     * The resting picture is unchanged; only the in-between frames are cheaper.
     */
    const showFilm = !!ve.filmstripUrl && total <= FILM_MAX_W && !ve._zoomBusy;
    const n = overlayLaneCount();
    let laneHints = '';
    for (let L = n; L >= 1; L--) {
      const label = L === 1
        ? 'Overlay 1 — ➕ Add media, or drag a clip up here'
        : `Overlay ${L} — shows ON TOP of overlay ${L - 1}`;
      laneHints += `<div class="ve-lane-hint" style="top:${laneTop(L) + 4}px">${label}</div>`;
    }
    laneHints += `<div class="ve-lane-hint" style="top:${laneTop(0) + 4}px">🎬 Main</div>`;
    seg.innerHTML = laneHints + ve.segments.map((s) => {
      const left = tlPos(s) * ve.pxPerSec, width = Math.max(6, (s.end - s.start) * ve.pxPerSec);
      const seln = ve.sel === s.id ? ' sel' : '';
      // Paint this clip's own slice of the filmstrip so it looks like a real piece
      // of film. A dark gradient over the top keeps the label readable. When no
      // filmstrip yet, fall back to a solid coloured block (still opaque, so gaps read).
      // Added media paints its OWN thumbnail — see segBgCss, which the in-place
      // rescale path shares so a zoom can never repaint it with this video's film.
      const bg = bgStyle(segBgCss(s, total, showFilm));
      const ov = (s.lane || 0) >= 1 ? ' ve-seg-ov' : '';
      const med = isMedia(s) ? (s.kind === 'image' ? ' ve-seg-img' : ' ve-seg-vid') : '';
      // Pauses the user removed with "Close gap": stitched-out notches inside the
      // clip. The clip is ONE short; these are the bits that won't be in the export.
      const notches = cutsOf(s).map((c) => {
        const a = Math.max(s.start, c.start), b = Math.min(s.end, c.end);
        if (b <= a) return '';
        const w = (b - a) * ve.pxPerSec;
        return `<div class="ve-seg-cut" style="left:${(a - s.start) * ve.pxPerSec}px;width:${w}px;"`
          + ` title="Pause removed (${(b - a).toFixed(1)}s) — this won't be in the exported short. Undo with Ctrl+Z.">`
          + `${w >= 18 ? '<span>✂</span>' : ''}</div>`;
      }).join('');
      const cutN = cutsOf(s).length;
      const icon = isMedia(s) ? (s.kind === 'image' ? '🖼 ' : '🎞 ') : ((s.lane || 0) >= 1 ? '📺 ' : (s.ai ? '✨ ' : ''));
      // A second video that keeps its own sound says so on the block — otherwise
      // the only way to find out is to export and listen.
      const snd = (isMedia(s) && s.kind === 'video' && s.srcInfo && s.srcInfo.hasAudio && !s.mute) ? ' <span class="ve-seg-snd" title="Brings its own sound, mixed under the video">🔊</span>' : '';
      const tip = isMedia(s)
        ? ` title="${attr2(s.label)} — ${s.kind === 'image' ? 'a picture' : 'a second video'} on top of this one. Drag it sideways to move it, its edges to change how long it shows, and the pink box on the preview to place it in the frame."`
        : '';
      return `<div class="ve-seg${seln}${ov}${med}${cutN ? ' ve-seg-joined' : ''}" data-id="${s.id}" data-kf="${attr2(kfSig(s))}"${tip} style="left:${left}px;width:${width}px;${laneStyle(s.lane)}border-color:${s.color};${bg}">
        <div class="ve-seg-h l" data-edge="l"></div>
        ${notches}
        <div class="ve-seg-label">${icon}${escape2(s.label)}${snd}${cutN ? ` <span class="ve-seg-joinbadge" title="${cutN} pause${cutN > 1 ? 's' : ''} removed — exports as one ${Math.round(keptDur(s))}s video">🔗 ${Math.round(keptDur(s))}s</span>` : ''}</div>
        ${kfDotsHtml(s)}
        <div class="ve-seg-h r" data-edge="r"></div>
      </div>`;
    }).join('') + outroBlockHtml();
    // The outro isn't part of the footage, so it isn't a draggable clip — it's a
    // marker for what gets appended on export. Click it to change or drop it.
    const ob = seg.querySelector('.ve-seg-outro');
    if (ob) ob.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); openLibrary('clips'); });
  }
  /** The chosen outro, drawn on the end of the main lane. */
  function outroBlockHtml() {
    const o = ve.outro; if (!o || !ve.video) return '';
    const left = dur() * ve.pxPerSec;
    const width = Math.max(28, (o.durationSec || 3) * ve.pxPerSec);
    return `<div class="ve-seg ve-seg-outro" style="left:${left}px;width:${width}px;${laneStyle(0)}"
      title="Outro: ${attr2(o.name)} (${fmtDur(o.durationSec)}) — added to the end of every short you export${ve.outroAll === false ? ' (currently switched off)' : ''}. Click to change it.">
      <div class="ve-seg-label">🎬 ${escape2(o.name)}${ve.outroAll === false ? ' (off)' : ''}</div>
    </div>`;
  }
  function escape2(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  async function loadClipThumb(s) {
    if (!ve.video || s.thumb || s._thumbing) return;
    s._thumbing = true;
    try {
      const t = await window.api.video.thumbnail(ve.video.path, (s.start + s.end) / 2);
      s.thumb = await smallThumb(await window.api.fs.readImageDataUrl(t));
      delete s._thumbing; // a work flag, not something for the session to keep
      renderClipList();
    } catch (e) { /* thumbs are optional — and the flag stays, so a failure is not retried on every render */ }
  }
  /**
   * The card shows the picture ~70px wide, but ffmpeg hands back the frame at
   * the recording's full size as a PNG — half a megabyte EACH, carried in every
   * session save. Nine shorts made a 5 MB session that was re-serialised on
   * every autosave and that "Carry on" had to read back. A small JPEG is ~10 KB.
   */
  const THUMB_W = 240;
  /** Sessions saved before v2.80 carry the full-size pictures: make them small,
   *  after the studio is back, so the next save is a few hundred KB again. */
  function shrinkOldThumbs(segs) {
    const big = segs.filter((s) => s && typeof s.thumb === 'string' && s.thumb.length > 60000);
    if (!big.length) return;
    setTimeout(async () => {
      for (const s of big) s.thumb = await smallThumb(s.thumb);
      renderClipList();
    }, 1500);
  }
  function smallThumb(dataUrl) {
    return new Promise((resolve) => {
      if (!dataUrl || typeof dataUrl !== 'string') { resolve(dataUrl); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(1, THUMB_W / (img.naturalWidth || THUMB_W));
          const c = document.createElement('canvas');
          c.width = Math.max(2, Math.round(img.naturalWidth * k));
          c.height = Math.max(2, Math.round(img.naturalHeight * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.78));
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }
  /**
   * WHAT COUNTS AS A SHORT — one rule, no exceptions: a short is something
   * ✂️ Long to short clips produced (`ai: true`).
   *
   * Editing the timeline is a different job. Splitting, ＋ Clip, dragging out a
   * block, closing a gap — all of that shapes the video you are editing and
   * belongs to 💾 Export video. None of it may put a card in this panel. The old
   * rule ("anything that isn't the seeded base") leaked: splitting while the
   * playhead sat in a gap made two clips called "Clip", and parking it on a
   * clip's edge made two ZERO-SECOND ones, which is exactly what turned up in
   * the panel. Keying off `ai` makes that class of bug impossible instead of
   * fixing it one path at a time.
   */
  const shortsOf = () => ve.segments.filter((s) => s.ai);
  function renderClipList() {
    const el = ve.refs.clipList;
    const shorts = shortsOf();
    $('#veExportAll').disabled = shorts.length === 0;
    /*
     * The Shorts panel is not on the timeline and most timeline work does not
     * touch it. Splitting the base video, zooming, scrubbing, moving a clip —
     * none of them change a single card, yet each rebuilt all of them: every
     * card's HTML, its thumbnail <img>, and eight fresh listeners per card.
     * Measured on a 90-minute sermon that was the most expensive part of a
     * render, ~18 ms, paid on every one.
     *
     * So the panel is described first and rebuilt only if the description
     * changed. Everything the card actually draws goes in the description — if
     * it can change a card, it must be able to change the key.
     */
    // The caption part is deliberately ONE number for the whole panel, not a
    // per-card answer: hasClipCaps() scans every caption line, so asking it per
    // card is 20 x 1500 comparisons — a cost that would then be paid on every
    // render including the ones this guard exists to skip. A card's 💬 badge
    // only depends on whether ANY line falls in its range, so any change to the
    // caption set at all is a good enough reason to redraw the panel.
    const caps = ve.capEvents || [];
    const capFp = caps.length + ':' + (caps.length ? caps[0].start + '-' + caps[caps.length - 1].end : '');
    const sig = capFp + '|' + JSON.stringify(shorts.map((s) => [
      s.id, s.label, s.start, s.end, s.thumb ? 1 : 0, s.color, s.virality, s.score,
      s.reasons, cutsOf(s).length, removedDur(s).toFixed(2), s.id === ve.sel, s.subject ? 1 : 0,
      s.thumbPick ? (s.thumbPick.file || s.thumbPick.at) : 0,
    ]));
    if (el.__clipSig === sig && (shorts.length === 0) === !el.querySelector('.ve-clip')) {
      updateClipPlayButtons();          // the ▶/⏸ still tracks the playhead
      return;
    }
    el.__clipSig = sig;
    if (!shorts.length) {
      el.innerHTML = `<p class="muted small">No shorts yet. Click <b>✂️ Long to short clips</b> and the AI will drop them here.<br><br>`
        + `Clips you make yourself on the timeline (Split, ＋ Clip, dragging) stay on the timeline — they’re part of the video you’re editing, and you save that with <b>💾 Export video</b>.</p>`;
      return;
    }
    const best = shorts.reduce((m, s) => (s.ai && s.score != null && (m == null || s.score > m.score) ? s : m), null);
    // OpusClip-style card: thumbnail, editable title, time, viral-potential score
    // badge (0-100) and plain-English reasons for WHY the AI picked this moment.
    const scoreBadge = (s) => {
      if (s.virality == null) return '';
      const cls = s.virality >= 85 ? 'hot' : s.virality >= 70 ? 'warm' : 'cool';
      const why = (s.reasons && s.reasons.length) ? ' — ' + s.reasons.join(' · ') : '';
      return `<span class="ve-score ${cls}" title="Viral potential ${s.virality}/100${escape2(why)}">${s.virality}</span>`;
    };
    // Two-row card so the clip NAME gets the full panel width (never squashed):
    // row 1 = thumbnail + name/time + score badge, row 2 = reasons, row 3 = actions.
    el.innerHTML = shorts.slice().sort((a, b) => a.start - b.start).map((s) => `
      <div class="ve-clip${ve.sel === s.id ? ' sel' : ''}" data-id="${s.id}">
        <div class="ve-clip-row">
          ${s.thumb ? `<img class="ve-clip-thumb" src="${s.thumb}" alt="" />` : `<span class="ve-clip-dot" style="background:${s.color}"></span>`}
          <div class="ve-clip-main">
            <input class="ve-clip-name" data-id="${s.id}" value="${escape2(s.label)}" title="${escape2(s.label)}" />
            <div class="ve-clip-time muted small">${fmt(s.start)} – ${fmt(s.end)} · ${Math.round(keptDur(s))}s${removedDur(s) > 0.05 ? ` <span class="ve-clip-joined" title="${cutsOf(s).length} pause${cutsOf(s).length > 1 ? 's' : ''} removed — exports as ONE video without them">🔗 −${removedDur(s).toFixed(1)}s</span>` : ''}${hasClipCaps(s) ? ' <span class="ve-clip-capped" title="Captions ready — they show on the preview and are burned in when this short exports">💬 CC</span>' : ''}${best && best.id === s.id ? ' <span class="ve-top-pick">🔥 Top pick</span>' : ''}</div>
          </div>
          ${scoreBadge(s)}
        </div>
        ${s.reasons && s.reasons.length ? `<div class="ve-clip-why">${escape2(s.reasons.join(' · '))}</div>` : ''}
        <div class="ve-clip-btns">
          <button class="icon-btn" data-play="${s.id}" title="Preview">▶</button>
          <button class="icon-btn${hasClipCaps(s) ? ' on' : ''}" data-cap="${s.id}" title="${hasClipCaps(s)
            ? 'Read and edit this short’s captions — opens the words so you can fix any it misheard'
            : 'Caption THIS short only (listens to this clip, not the whole video), then opens the words to check'}">💬</button>
          <button class="icon-btn${s.thumbPick ? ' on' : ''}" data-thumb="${s.id}" title="${s.thumbPick
            ? 'This short has a thumbnail chosen — click to change it'
            : 'Choose the frame people see before they press play'}">🖼️</button>
          <button class="icon-btn${s.subject ? ' on' : ''}" data-who="${s.id}" title="${s.subject
            ? 'This short follows a person you picked — click to change or clear it'
            : 'Pick the person THIS short should keep in the middle of the frame'}">👤</button>
          <button class="icon-btn" data-exp="${s.id}" title="Export 9:16">⬇️</button>
          <button class="icon-btn danger" data-del="${s.id}" title="Delete">🗑</button>
        </div>
      </div>`).join('');
    $$('.ve-clip-name', el).forEach((inp) => inp.addEventListener('change', () => {
      const s = ve.segments.find((x) => x.id === inp.dataset.id); if (s) { s.label = inp.value; renderSegments(); }
    }));
    $$('[data-play]', el).forEach((b) => b.addEventListener('click', () => previewSegment(b.dataset.play)));
    $$('[data-cap]', el).forEach((b) => b.addEventListener('click', () => captionShort(b.dataset.cap)));
    $$('[data-thumb]', el).forEach((b) => b.addEventListener('click', () => openThumbPicker(b.dataset.thumb)));
    $$('[data-who]', el).forEach((b) => b.addEventListener('click', () => openFollowPicker(b.dataset.who, true)));
    $$('[data-exp]', el).forEach((b) => b.addEventListener('click', () => exportSegment(b.dataset.exp)));
    $$('[data-del]', el).forEach((b) => b.addEventListener('click', () => { removeSeg(b.dataset.del); }));
    $$('.ve-clip', el).forEach((c) => c.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      selectSeg(c.dataset.id); seekTo(ve.segments.find((x) => x.id === c.dataset.id).start);
    }));
    shorts.forEach((s) => loadClipThumb(s));
    updateClipPlayButtons();
  }

  // The scroller (#veTlScroll) has horizontal padding; the ruler/tracks are
  // normal-flow children living in its CONTENT box, but the playhead is
  // position:absolute so its containing block is the scroller's PADDING box —
  // meaning left:0 sits `padding-left` px to the LEFT of the ruler's t=0. That
  // constant pixel gap reads as ~padding-left/pxPerSec SECONDS of error: tiny
  // when zoomed in, huge when zoomed out (the "playhead only accurate when
  // zoomed in" bug). Anchor the playhead to the same content origin as the ticks.
  function tlPadL() {
    if (ve._tlPadL == null && ve.refs.tlScroll) ve._tlPadL = parseFloat(getComputedStyle(ve.refs.tlScroll).paddingLeft) || 0;
    return ve._tlPadL || 0;
  }
  /* Scroll the timeline OURSELVES, and remember exactly where to — the scroll
   * listener compares against it to tell an automatic scroll from the user
   * grabbing the timeline (see setFollow). Reading scrollLeft straight back gives
   * the value the browser actually applied, so a request past either end still
   * matches. Deliberately NOT a "clear the flag next frame" trick: rAF is
   * throttled in background windows, and a flag stuck on would silently disable
   * the very thing this is here to detect. */
  function setScrollLeft(sc, x) {
    if (!sc) return;
    sc.scrollLeft = x;
    ve._autoScrollTo = sc.scrollLeft;
  }
  /**
   * FOLLOW THE PLAYHEAD — on by default, and switched off the moment you scroll
   * the timeline yourself. Auto-following used to be unconditional, so scrolling
   * back to look at something while the video played was impossible: the next
   * frame yanked you straight back to the playhead. Now the timeline stays where
   * you put it, and following resumes when you press play again (or click the
   * 🎯 button).
   */
  function setFollow(on, quiet) {
    ve.follow = !!on;
    const b = $('#veFollow');
    if (b) {
      b.classList.toggle('on', ve.follow);
      b.title = ve.follow
        ? 'Following the playhead — scroll the timeline to look around freely'
        : 'Not following — the timeline stays where you put it. Click to follow the playhead again.';
    }
    if (!quiet && ve.follow) {
      const sc = ve.refs.tlScroll;
      if (sc) setScrollLeft(sc, Math.max(0, tlPadL() + (ve.refs.player.currentTime || 0) * ve.pxPerSec - sc.clientWidth / 2));
    }
  }
  function updatePlayhead() {
    const t = ve.refs.player.currentTime || 0;
    const x = tlPadL() + t * ve.pxPerSec;
    ve.refs.playhead.style.left = x + 'px';
    $('#veTime').textContent = `${fmt(t)} / ${fmt(dur())}`;
    // keep the playhead in view while playing — unless you've scrolled away yourself
    const sc = ve.refs.tlScroll;
    if (sc && !ve.refs.player.paused && ve.follow !== false) {
      if (x < sc.scrollLeft + 20 || x > sc.scrollLeft + sc.clientWidth - 60) setScrollLeft(sc, Math.max(0, x - 80));
    }
    updateGapMask(t);
    updateTransitionPreview(t);
    updateKfPreview(t);      // keyframed push-ins and moves
    if (kfFor) syncKeyframePanel();
    updateCapOverlay(t);
    updateMediaLayer(t);   // added pictures / second videos appear and go on their own windows
    renderTextOverlays();
    updateClipPlayButtons(); // the card ▶/⏸ tracks whether ITS clip is playing
    syncMusicPreview();      // the music bed follows the playhead
    syncSoundPreview();      // …and so do voiceovers and sound effects
  }

  /** Real-editor behaviour: if NO main-lane clip covers the playhead (a gap, or
   *  every clip deleted), the preview goes BLANK (black); if no AUDIO clip covers
   *  it (audio split/moved/trimmed/deleted), the sound goes SILENT. Each track
   *  masks the source independently — so editing the audio row is really audible. */
  function updateGapMask(t) {
    const m = ve.refs.gapMask; if (!m) return;
    if (!ve.video) { m.classList.add('hidden'); return; }
    // a removed pause counts as NOT covered — scrub into one and you see black,
    // which is the truth: it isn't in the exported short
    const inClip = ve.segments.some((s) => (s.lane || 0) === 0 && t >= s.start && t < s.end && !cutAt(s, t));
    const inAudio = ve.audio.some((a) => t >= a.start && t < a.end);
    m.classList.toggle('hidden', inClip);
    // silent while a voiceover records, so the sermon does not leak into the mic
    ve.refs.player.muted = !!ve._voiceMute || !inClip || !inAudio;
  }

  /**
   * Playback jumps over pauses the user removed, so the preview plays exactly what
   * the exported short will be — that's how you confirm the cut landed before
   * spending minutes on an export. Returns the time it jumped to, or null.
   */
  function skipRemovedAt(t) {
    for (const s of ve.segments) {
      if ((s.lane || 0) !== 0) continue;
      const c = cutAt(s, t);
      // don't jump past the end of the video, and leave a hair of margin so the
      // seek doesn't land back inside the same cut on a rounding edge
      if (c && c.end < dur() - 0.02) return c.end + 0.001;
    }
    return null;
  }

  /** Live captions on the preview player (before any export). */
  function updateCapOverlay(t) {
    const ov = ve.refs.capOverlay; if (!ov) return;
    const showCtl = $('#veCapShow');
    const evs = ve.capEvents;
    if (showCtl && !showCtl.checked) { ov.classList.add('hidden'); ve._capKey = null; return; }
    // While a caption block is being typed into, the preview shows THAT line —
    // you always see what you're editing, even if the playhead sits on a
    // neighbour. Otherwise: the line under the playhead, preferring the LATER one
    // where two lines touch (whisper ends one exactly where the next begins, so
    // `find` would otherwise stick on the one that just ended).
    let e = null;
    if (evs && evs.length) {
      const rel = t - (ve.capOffset || 0);
      if (ve.capEditing != null && evs[ve.capEditing]) e = evs[ve.capEditing];
      else for (const x of evs) { if (rel >= x.start && rel <= x.end && (!e || x.start >= e.start)) e = x; }
      // A line being retyped in the captions window shows its new words on the
      // picture as they are typed — the point of putting the window beside it.
      if (e && ve._capLive && evs[ve._capLive.i] === e && ve._capLive.text !== e.text) e = Object.assign({}, e, { text: ve._capLive.text });
    }
    if (!e || !e.text) { ov.classList.add('hidden'); ve._capKey = null; return; }
    const cfg = capStyleCfg();
    /*
     * The caption belongs to the EXPORT FRAME, not to the preview window, and it
     * is drawn from the SAME layout the export rasterises — window.CapLayout.
     * Every length is a fraction of the frame, and the line breaks are decided
     * once at a canonical size, so this overlay and the finished file are the
     * same picture at two sizes. Nothing here is allowed to compute a size, a
     * position or a line break of its own: that is exactly how the two drifted
     * apart before.
     */
    const fr = canvasFrameRect();
    const box = fr || { left: 0, top: 0, w: ve.refs.preview.clientWidth || 400, h: ve.refs.preview.clientHeight || 400 };
    ov.classList.remove('hidden');
    // The overlay IS the frame; the words are placed inside it.
    ov.style.left = box.left.toFixed(2) + 'px';
    ov.style.width = box.w.toFixed(2) + 'px';
    ov.style.top = box.top.toFixed(2) + 'px';
    ov.style.height = box.h.toFixed(2) + 'px';
    ov.style.right = 'auto'; ov.style.bottom = 'auto'; ov.style.transform = 'none';
    // The transition is part of "what the export looks like" too, so the preview
    // plays it: scrub or play into a line and it arrives the way it will arrive
    // in the file. A paused playhead sitting past the arrival shows the settled
    // state, which is what you want while you are placing the words.
    const rel = t - (ve.capOffset || 0);
    const state = ve.capEditing != null
      ? { sx: 1, sy: 1, opacity: 1 }
      : window.CapLayout.stateAt(cfg.transition, rel - e.start, (e.end - e.start), String(e.text).length);
    /*
     * …and in highlight mode the word under the playhead is coloured here too.
     * The whole promise of the effect is that the colour lands ON the voice, and
     * the only place an operator can check that before waiting out an export is
     * this preview — so it plays the highlight, from the same wordTimes() the
     * burn will use, rather than showing a plain line that "will animate later".
     * While a line is being retyped it settles on the first word: the words are
     * moving under the cursor and a highlight chasing them is just flicker.
     */
    state.hl = window.CapLayout.highlightOn(cfg)
      ? (ve.capEditing != null ? 0 : window.CapLayout.activeWord(window.CapLayout.wordTimes(e), rel))
      : -1;
    const q = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
    /*
     * This runs on every animation frame while the video plays, so it must not
     * touch the DOM unless something ACTUALLY changed. A caption sitting still
     * for two seconds is one write, not a hundred and twenty — the same rule
     * that keeps the timeline from locking the studio up.
     */
    const key = [
      e.text, box.w.toFixed(1), box.h.toFixed(1), cfg.styleId, cfg.font, cfg.sizeKey, cfg.position,
      cfg.color, cfg.outline, cfg.width, cfg.posX, cfg.posY,
      cfg.wordHighlight ? cfg.wordColor : '', cfg.wordGap, cfg.sizePct, cfg.tracking,
      q(state.sx), q(state.sy), q(state.opacity), state.chars == null ? '' : state.chars, state.hl,
    ].join('|');
    if (ve._capKey === key && ov.firstElementChild) return;
    ve._capKey = key;
    const L = window.CapLayout.layout(e.text, cfg, box.w, box.h);
    ve._capLayout = L;
    ov.innerHTML = window.CapLayout.html(e.text, cfg, box.w, box.h, { layout: L, state })
      + capHandlesHtml(L);
    const block = ov.firstElementChild;
    if (block) {
      block.classList.add('ve-cap-block');
      block.title = 'Drag to move the captions · drag an edge to set how wide they wrap';
      block.addEventListener('mousedown', onCapSpanDown);
    }
    $$('[data-capedge]', ov).forEach((h) => h.addEventListener('mousedown', onCapEdgeDown));
  }

  /* The caption arrives in ~150ms; `timeupdate` fires about four times a second.
   * Watching a pop through that is watching one frame of it, so while the video
   * is playing the overlay is driven off requestAnimationFrame instead — and
   * because updateCapOverlay bails out when nothing changed, a still caption
   * costs a string compare per frame and no DOM work at all. */
  let capRaf = null;
  function capTick() {
    capRaf = null;
    const p = ve.refs.player;
    if (!p || p.paused || !ve.video) return;
    // …and only while the Video Studio is the page you are looking at. All five
    // studios share one thread, so a loop left running behind the Presentation
    // desk is a loop stealing frames from the projector.
    const view = document.getElementById('view-video');
    if (!view || !view.classList.contains('active')) return;
    updateCapOverlay(p.currentTime || 0);
    // …and everything else that moves between timeupdates: text arrivals,
    // keyframed push-ins, green-screened media
    frameTick(p.currentTime || 0);
    capRaf = requestAnimationFrame(capTick);
  }
  function startCapTick() { if (capRaf == null) capRaf = requestAnimationFrame(capTick); }
  /** The per-frame work while playing. Each piece bails out cheaply when it has
   *  nothing to do, so a plain video costs a few comparisons a frame. */
  function frameTick(t) {
    try { updateKfPreview(t); } catch (e) {}
    try { animateTextBoxes(t); } catch (e) {}
    try {
      const layer = ve.refs.mediaLayer;
      if (layer && layer.querySelector('canvas[data-key-for]')) updateMediaLayer(t);
    } catch (e) {}
  }
  /** Text arrivals between redraws: a box that should now be showing (or gone)
   *  redraws the layer; one already there just has its move updated. */
  function animateTextBoxes(t) {
    const layer = ve.refs.textLayer;
    if (!layer || ve.textEditing || !ve.textOverlays.length) return;
    const want = ve.textOverlays.filter((o) => t >= o.start && t <= o.end).map((o) => o.id).join(',');
    const have = Array.from(layer.querySelectorAll('.ve-text-box')).map((b) => b.dataset.id).join(',');
    if (want !== have) { renderTextOverlays(); return; }
    const fr = outputFrameRect();
    for (const box of layer.querySelectorAll('.ve-text-box')) {
      const o = ve.textOverlays.find((x) => x.id === box.dataset.id);
      if (!o || !o.anim || o.anim === 'none') continue;
      const c = box.querySelector('.ve-text-content'); if (!c) continue;
      const css = textAnimCss(o, t, fr.h);
      const a = css ? textAnimState(o, t) : null;
      c.style.opacity = a && a.opacity < 1 ? a.opacity.toFixed(3) : '';
      c.style.transform = a && (a.dy || a.k !== 1) ? `translateY(${(a.dy * fr.h).toFixed(2)}px) scale(${a.k.toFixed(4)})` : '';
      c.style.transformOrigin = a ? '50% 50%' : '';
    }
  }
  function stopCapTick() { if (capRaf != null) { cancelAnimationFrame(capRaf); capRaf = null; } }

  /**
   * The two grab handles on the caption's left and right edges.
   *
   * This is the control that was missing: how many lines a caption breaks onto
   * is a LOOK, and it belongs on the picture, next to the words, not in a
   * numeric field in a dialog. Widen the box and "IN NIGERIA WE ARE PRAYING"
   * settles onto one line; pinch it in and it stacks onto two or three. What
   * you set here is what the exported file wraps to, because both sides ask
   * CapLayout the same question.
   */
  function capHandlesHtml(L) {
    if (!L || !L.lines.length) return '';
    const px = (v) => (Math.round(v * 100) / 100) + 'px';
    const top = px(L.cy - L.blockH / 2), h = px(L.blockH);
    const mk = (side, x) => `<div class="ve-cap-edge ${side}" data-capedge="${side}" `
      + `style="left:${px(x)};top:${top};height:${h};" `
      + `title="Drag to set how wide the captions wrap — narrower means more lines"></div>`;
    return mk('l', L.cx - L.blockW / 2) + mk('r', L.cx + L.blockW / 2);
  }

  /** Put the Width slider back in step after the edges are dragged on the
   *  preview — replaced with the real thing once that control is wired. */
  let syncCapWidthControl = () => {};

  /** The presets the Position dropdown names, as frame fractions. Kept only for
   *  the "where did I drag it from" starting point — CapLayout owns the real
   *  anchoring (an edge for top/bottom, so extra lines grow inward). */
  const CAP_POS_PRESETS = { top: { x: 0.5, y: 0.10 }, center: { x: 0.5, y: 0.5 }, bottom: { x: 0.5, y: 0.88 } };
  /** Where the words go: the dragged point, or the preset. */
  function capPosPoint(position) {
    if (ve.capPos && Number.isFinite(ve.capPos.x) && Number.isFinite(ve.capPos.y)) return ve.capPos;
    // Ask the layout where the preset actually put the block, so a drag starts
    // from where the words ARE rather than from a nominal point they no longer sit on.
    const L = ve._capLayout;
    const fr = canvasFrameRect();
    if (L && fr && fr.w > 0 && fr.h > 0) return { x: L.cx / fr.w, y: L.cy / fr.h };
    return CAP_POS_PRESETS[position] || CAP_POS_PRESETS.bottom;
  }
  /**
   * Drag the words themselves.
   *
   * The preview's own drag is "move the video inside the frame", so the caption
   * has to swallow the event before it reaches that — otherwise grabbing the
   * words pans the picture instead, which is what made this feel broken.
   */
  function onCapSpanDown(ev) {
    if (ev.target && ev.target.dataset && ev.target.dataset.capedge) return; // that's a resize
    const fr = canvasFrameRect(); if (!fr) return;
    ev.preventDefault(); ev.stopPropagation();
    const start = capPosPoint(capStyleCfg().position);
    const x0 = ev.clientX, y0 = ev.clientY;
    const from = { x: start.x, y: start.y };
    let moved = false;
    const move = (e) => {
      const dx = (e.clientX - x0) / Math.max(1, fr.w);
      const dy = (e.clientY - y0) / Math.max(1, fr.h);
      if (Math.abs(e.clientX - x0) > 2 || Math.abs(e.clientY - y0) > 2) moved = true;
      // Kept inside the frame: a caption dragged off the edge is a caption that
      // does not appear in the exported video. (CapLayout clamps the block by its
      // real size on top of this, so no glyph can leave the picture either.)
      ve.capPos = { x: clamp(from.x + dx, 0.02, 0.98), y: clamp(from.y + dy, 0.02, 0.98) };
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      if (moved) {
        saveCapLook();
        window.__toast && window.__toast('💬 Caption moved — that is where it will be in the exported video. Change Position in 💬 Auto-captions to put it back.', 'good', 6000);
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }

  /**
   * Drag a caption edge: how wide the words are allowed to run before they wrap.
   *
   * The block stays centred on its anchor, so pulling either edge widens or
   * narrows it symmetrically — the words never walk sideways while you are only
   * trying to change the number of lines.
   */
  function onCapEdgeDown(ev) {
    const fr = canvasFrameRect(); if (!fr) return;
    ev.preventDefault(); ev.stopPropagation();
    const side = ev.target.dataset.capedge === 'l' ? -1 : 1;
    const x0 = ev.clientX;
    const from = window.CapLayout.widthFrac({ width: ve.capWidth });
    const before = ve._capLayout ? ve._capLayout.lines.length : 0;
    let moved = false;
    const move = (e) => {
      if (Math.abs(e.clientX - x0) > 2) moved = true;
      // one edge moves, the box grows from BOTH — hence the 2×
      const d = (side * (e.clientX - x0) * 2) / Math.max(1, fr.w);
      ve.capWidth = clamp(from + d, window.CapLayout.MIN_WIDTH, window.CapLayout.MAX_WIDTH);
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
      syncCapWidthControl();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      if (!moved) return;
      saveCapLook();
      const now = ve._capLayout ? ve._capLayout.lines.length : 0;
      if (now && now !== before) {
        window.__toast && window.__toast(`💬 Captions now wrap onto ${now} line${now > 1 ? 's' : ''} — exactly how they will be burned in.`, 'good', 4500);
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }

  /** How the preview area maps to source-video pixels (accounts for letterboxing). */
  function previewMapping() {
    const containerW = ve.refs.preview.clientWidth, containerH = ve.refs.preview.clientHeight;
    const srcAR = ve.video.info.width / ve.video.info.height;
    const containerAR = containerW / containerH;
    let renderedW, renderedH, offX, offY;
    if (containerAR > srcAR) { renderedH = containerH; renderedW = containerH * srcAR; offX = (containerW - renderedW) / 2; offY = 0; }
    else { renderedW = containerW; renderedH = containerW / srcAR; offX = 0; offY = (containerH - renderedH) / 2; }
    return { containerW, containerH, renderedW, renderedH, offX, offY };
  }

  /** The fixed, centred export canvas rect (target ratio, as big as fits the preview). */
  function canvasFrameRect() {
    const cw = ve.refs.preview.clientWidth || 1, ch = ve.refs.preview.clientHeight || 1;
    const preset = ve.presets[ve.aspect]; if (!preset) return null;
    const tAR = preset.w / preset.h;
    let fw = ch * tAR, fh = ch;
    if (fw > cw) { fw = cw; fh = cw / tAR; }
    return { left: (cw - fw) / 2, top: (ch - fh) / 2, w: fw, h: fh, tAR };
  }

  /** The crop window inside the SOURCE frame (fractions 0..1) for the current
   *  framing: manual pan/zoom when auto-reframe is off, the live-detected face
   *  when it's on. The centre is clamped so the window never leaves the source. */
  function cropWindow() {
    const preset = ve.presets[ve.aspect] || { w: 9, h: 16 };
    const tAR = preset.w / preset.h;
    const srcAR = ve.video.info.width / ve.video.info.height;
    const manual = !reframeOn();
    const z = manual ? clamp(ve.framing.zoom, 1, 8) : 1;
    const cw = (srcAR > tAR ? tAR / srcAR : 1) / z;
    const ch = (srcAR < tAR ? srcAR / tAR : 1) / z;
    // auto mode reads the RENDER position (smoothed every animation frame — see stepLiveRender
    // above), not the raw ~220ms target directly, so the crop glides instead of hopping.
    const liveX = liveRenderCx != null ? liveRenderCx : ve.liveFaceCx;
    const liveY = liveRenderCy != null ? liveRenderCy : ve.liveFaceCy;
    let ox = manual ? clamp(ve.framing.offsetX, 0, 1) : (liveX != null ? clamp(liveX, 0, 1) : 0.5);
    let oy = manual ? clamp(ve.framing.offsetY, 0, 1) : (liveY != null ? clamp(liveY, 0, 1) : 0.5);
    ox = clamp(ox, cw / 2, 1 - cw / 2);
    oy = clamp(oy, ch / 2, 1 - ch / 2);
    return { tAR, srcAR, z, cw, ch, ox, oy };
  }

  /** The <video>'s transform = the CapCut canvas position + any live-fx rotate/flip. */
  function setPlayerTransform() {
    const p = ve.refs.player; if (!p) return;
    p.style.transform = [ve._kfT || '', ve._canvasT || '', ve._fxT || ''].join(' ').trim();
  }

  /* ---------------- blurred background on the PREVIEW ----------------
   *
   * The export builds its background by scaling the frame down 8x, blurring it
   * there and scaling it back up. The preview does exactly the same, on a small
   * canvas the video is copied onto a few times a second with a CSS blur over
   * it — which is why it looks like the finished file rather than like a
   * different effect that happens to share a name.
   *
   * Deliberately slow (8fps): this is a backdrop, not the picture. Repainting it
   * every frame would cost real GPU time and nobody would see the difference.
   */
  function updateBlurBackdrop(fr) {
    let el = ve.refs.blurBg;
    const host = ve.refs.drop;
    if (!fr) {
      if (el) el.classList.remove('on');
      if (host) host.classList.remove('blurfill');
      if (ve._blurTimer) { clearInterval(ve._blurTimer); ve._blurTimer = null; }
      return;
    }
    if (!host) return;
    // …without this the player's own black background covers the backdrop.
    host.classList.add('blurfill');
    if (!el) {
      el = document.createElement('canvas');
      el.id = 'veBlurBg'; el.className = 've-blur-bg';
      el.width = 64; el.height = 64;
      host.insertBefore(el, host.firstChild);
      ve.refs.blurBg = el;
    }
    // sized/placed to exactly cover the export frame
    el.style.left = Math.round(fr.left) + 'px'; el.style.top = Math.round(fr.top) + 'px';
    el.style.width = Math.round(fr.w) + 'px'; el.style.height = Math.round(fr.h) + 'px';
    const aspect = fr.w / Math.max(1, fr.h);
    el.width = 64; el.height = Math.max(8, Math.round(64 / Math.max(0.05, aspect)));
    el.style.filter = `blur(${(6 + ve.fill.strength * 16).toFixed(1)}px) saturate(1.15) brightness(${(1 - ve.fill.dim).toFixed(2)})`;
    el.classList.add('on');
    const paint = () => {
      const p = ve.refs.player;
      if (!p || !p.videoWidth || !ve.refs.blurBg) return;
      const c = ve.refs.blurBg.getContext('2d');
      // cover: crop the source to the frame's ratio, then draw it tiny
      const sAR = p.videoWidth / p.videoHeight, dAR = ve.refs.blurBg.width / ve.refs.blurBg.height;
      let sw = p.videoWidth, sh = p.videoHeight;
      if (sAR > dAR) sw = p.videoHeight * dAR; else sh = p.videoWidth / dAR;
      try { c.drawImage(p, (p.videoWidth - sw) / 2, (p.videoHeight - sh) / 2, sw, sh, 0, 0, ve.refs.blurBg.width, ve.refs.blurBg.height); } catch (e) {}
    };
    paint();
    if (!ve._blurTimer) ve._blurTimer = setInterval(paint, 125);
  }

  /**
   * CapCut-style preview canvas: when the export ratio differs from the source,
   * the preview becomes a FIXED centred frame at the export ratio (solid black
   * outside) and the VIDEO moves/zooms underneath it — drag the video to choose
   * what's in frame, scroll to zoom. With auto-reframe ON, the video slides by
   * itself to keep the detected speaker inside the frame (a live preview of the
   * face-tracked export).
   */
  function updateCropMask() {
    noteMonitorShape();
    updateSourceRect();
    updateCoverStrip();
    renderOverlayGuide(); // keep the PiP guide aligned on resize/aspect/show
    updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0); // …and the media it frames
    const mask = ve.refs.cropMask, frame = ve.refs.cropFrame, player = ve.refs.player;
    if (!mask || !frame) return;
    // `_frameOn` is what outputFrameRect reads: it says whether a separate export
    // frame is being drawn at all, or whether the whole picture IS the export.
    const off = () => { ve._frameOn = false; mask.classList.add('hidden'); ve.canvasMap = null; ve._canvasT = ''; if (player) { player.style.transformOrigin = ''; setPlayerTransform(); } updateBlurBackdrop(null); };
    if (!ve.video) { off(); return; }
    /*
     * A BATCH exports every video at its OWN full frame — it is not cropped to
     * the social preset — so while one is open the preview must show the whole
     * picture. Leaving the 9:16 matte up would draw a logo placed at the
     * top-right of a 16:9 service out on the black, in a part of the frame the
     * bulk export does not even crop away: the preview would be describing an
     * export nobody asked for.
     */
    if (ve.bulk.files.length) { off(); return; }
    const preset = ve.presets[ve.aspect]; if (!preset) { off(); return; }
    const targetAR = preset.w / preset.h;
    const srcAR = ve.video.info.width / ve.video.info.height;
    if (Math.abs(targetAR - srcAR) < 0.02) { off(); return; }

    const map = previewMapping();
    if (!map.containerW || !map.containerH) return;
    ve._frameOn = true;
    mask.classList.remove('hidden');

    // fixed centred canvas at the export ratio…
    const fr = canvasFrameRect();
    frame.style.left = Math.round(fr.left) + 'px'; frame.style.top = Math.round(fr.top) + 'px';
    frame.style.width = Math.round(fr.w) + 'px'; frame.style.height = Math.round(fr.h) + 'px';
    frame.classList.toggle('ve-crop-frame-static', reframeOn());

    // FRAME FILL: fit the whole picture inside the export frame instead of
    // cropping into it, and (for 'blur') paint the leftover space with the
    // picture's own blurred colours — the same thing the export does, so what
    // you see here is what lands in the file.
    if (ve.fill.mode !== 'crop') {
      const s = Math.min(fr.w / Math.max(1e-6, map.renderedW), fr.h / Math.max(1e-6, map.renderedH));
      const Cx = map.offX + map.renderedW / 2, Cy = map.offY + map.renderedH / 2;
      const Fx = fr.left + fr.w / 2, Fy = fr.top + fr.h / 2;
      player.style.transformOrigin = `${Cx.toFixed(1)}px ${Cy.toFixed(1)}px`;
      player.style.transition = 'none';
      ve._canvasT = `translate(${(Fx - Cx).toFixed(1)}px, ${(Fy - Cy).toFixed(1)}px) scale(${s.toFixed(4)})`;
      setPlayerTransform();
      ve.canvasMap = { fr, cwin: { cw: 1, ch: 1, ox: 0.5, oy: 0.5 }, s, map, Fx, Fy, Cx, Cy };
      updateBlurBackdrop(ve.fill.mode === 'blur' ? fr : null);
      return;
    }
    updateBlurBackdrop(null);

    // …and the video transforms so the chosen crop window exactly fills it
    const cwin = cropWindow();
    const s = fr.w / Math.max(1e-6, cwin.cw * map.renderedW);
    const Cx = map.offX + cwin.ox * map.renderedW, Cy = map.offY + cwin.oy * map.renderedH;
    const Fx = fr.left + fr.w / 2, Fy = fr.top + fr.h / 2;
    player.style.transformOrigin = `${Cx.toFixed(1)}px ${Cy.toFixed(1)}px`;
    // glide when the face-tracker drives the canvas; stay instant under the user's hand.
    // No CSS transition during auto-tracking: stepLiveRender() (above) already glides the
    // crop continuously at ~60fps with its own velocity-capped easing, sourced from a target
    // that only updates ~4-5x/sec. Layering a CSS transition on TOP of that used to retarget a
    // still-in-flight ease every ~220ms — each leg decelerating to a dead stop right as the next
    // one started — which read as a repeating "lurch, brake, lurch, brake" rather than one
    // continuous glide (reported as the preview looking wild/glitchy). Instant CSS application
    // of an already-smoothly-varying JS value IS the smooth motion here.
    player.style.transition = 'none';
    ve._canvasT = `translate(${(Fx - Cx).toFixed(1)}px, ${(Fy - Cy).toFixed(1)}px) scale(${s.toFixed(4)})`;
    setPlayerTransform();
    ve.canvasMap = { fr, cwin, s, map, Fx, Fy, Cx, Cy };
  }

  /* ---------------- preview size: bigger / full screen ----------------
   * The preview is small because the timeline needs the height, but before you
   * spend minutes exporting you want a proper look at what the short will be.
   * Two steps: ⤢ gives the picture most of the window (lanes stay live, so you
   * can carry on editing), ⛶ goes true full screen. Both keep the export-ratio
   * matte, captions and text overlays on, so what you see IS the export.
   */
  function isPreviewBig() { return $('#view-video').classList.contains('ve-big'); }
  function setPreviewBig(on) {
    $('#view-video').classList.toggle('ve-big', !!on);
    const b = $('#veBigger'); if (b) b.classList.toggle('on', !!on);
    // the preview and the lanes both changed size — re-fit the matte and the ruler
    ve._tlPadL = null;
    updateCropMask(); renderRuler(); renderSegments(); updatePlayhead();
  }
  const fsEl = () => document.fullscreenElement;
  function isPreviewFull() { return fsEl() === ve.refs.drop; }
  async function togglePreviewFull() {
    try {
      if (isPreviewFull()) await document.exitFullscreen();
      else if (ve.refs.drop.requestFullscreen) await ve.refs.drop.requestFullscreen();
    } catch (e) { window.__toast && window.__toast('Full screen isn’t available here.', 'error'); }
  }
  /** Fullscreen changes the preview's pixel size, so everything measured off it must be redrawn. */
  function onFullscreenChange() {
    ve._tlPadL = null;
    const f = $('#veFull'); if (f) f.classList.toggle('on', isPreviewFull());
    updateCropMask();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    renderTextOverlays();
  }

  /* ======================= THE PRO TIMELINE (v2.79) =======================
   *
   * "Video Studio: C · Pro timeline." The operator chose it from four designs
   * (design/video-studio-options): a toolbar, then the Shorts bin, a SOURCE
   * monitor, a PROGRAM monitor and an Inspector side by side, then the
   * timeline with tools.
   *
   * The PROGRAM monitor is the old preview (#veDrop), untouched: the export
   * frame, the captions, the text, every drag handle — so "what you see is what
   * exports" is exactly as true as it was. What is new is the SOURCE monitor:
   * the whole recording, with the box that goes in the short drawn on it. It is
   * a painting of the same <video>'s frames (requestVideoFrameCallback →
   * drawImage), so there is no second decoder and nothing to fall out of sync.
   * Dragging the box frames the short by hand — the same `ve.framing` the old
   * drag-the-video gesture wrote — and while 🎯 Auto-reframe is on the box
   * moves by itself, which shows at a glance what the tracker is doing.
   */
  const proView = () => document.getElementById('view-video');
  const studioActive = () => { const v = proView(); return !!v && v.classList.contains('active'); };
  const setText = (sel, text) => { const el = $(sel); if (el && el.textContent !== text) el.textContent = text; };

  /* ---- the inspector's tabs ---- */
  const INSP_KEY = 'mw-ve-insp';
  function showInspector(name, quiet) {
    const tabs = $$('.ve-insp-tabs [data-insp]');
    if (!tabs.length) return null;
    if (!tabs.some((t) => t.dataset.insp === name)) name = 'captions';
    tabs.forEach((t) => {
      const on = t.dataset.insp === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    });
    $$('.ve-insp-panel').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== name));
    if (name === 'reframe' && ve.rfAi) refreshReframeAi();   // the key may have been set elsewhere since
    if (!quiet) { try { localStorage.setItem(INSP_KEY, name); } catch (e) {} }
    return name;
  }
  function wireInspector() {
    const tabs = $$('.ve-insp-tabs [data-insp]');
    tabs.forEach((t) => t.addEventListener('click', () => showInspector(t.dataset.insp)));
    const bar = $('.ve-insp-tabs');
    if (bar) bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = tabs.findIndex((t) => t.classList.contains('on'));
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      if (n) { showInspector(n.dataset.insp); n.focus(); e.preventDefault(); }
    });
    let v = null;
    try { v = localStorage.getItem(INSP_KEY); } catch (e) {}
    showInspector(v || 'captions', true);
  }

  /* ---- how wide the program monitor is: as wide as the short's frame ---- */
  function ratioLabel(ar) {
    const known = [[16 / 9, '16:9'], [9 / 16, '9:16'], [1, '1:1'], [4 / 5, '4:5'], [4 / 3, '4:3'], [21 / 9, '21:9'], [3 / 4, '3:4']];
    const k = known.find(([v]) => Math.abs(v - ar) < 0.02);
    return k ? k[1] : ar.toFixed(2) + ':1';
  }
  const SHOW_SOURCE = false;
  function layoutMonitors() {
    const mon = $('#veMonitors'); if (!mon) return;
    const view = proView();
    const capmode = !!view && view.classList.contains('ve-capmode');
    const preset = ve.presets[ve.aspect];
    const tAR = preset ? preset.w / preset.h : 9 / 16;
    const info = ve.video && ve.video.info;
    const srcAR = info && info.width && info.height ? info.width / info.height : 16 / 9;
    // The source monitor earns its place only when the short is a DIFFERENT
    // shape from the recording — otherwise the two monitors are one picture.
    // The operator asked for the Program monitor alone (v2.80): it already
    // shows the speaker, and framing by hand still works by dragging it.
    const want = SHOW_SOURCE && !!(ve.video && !ve.bulk.files.length && Math.abs(tAR - srcAR) >= 0.02 && !capmode);
    mon.classList.toggle('solo', !want);
    if (want) {
      const left = mon.querySelector('.ve-left');
      const head = left ? left.querySelector('.ve-mon-head') : null;
      const tr = mon.querySelector('.ve-transport');
      const stageH = Math.max(120, mon.clientHeight - (tr ? tr.offsetHeight + 8 : 0) - (head ? head.offsetHeight : 0) - 2);
      const w = clamp(Math.round(stageH * tAR) + 2, 200, Math.max(200, Math.round(mon.clientWidth * 0.55)));
      if (mon.style.getPropertyValue('--prog-w') !== w + 'px') mon.style.setProperty('--prog-w', w + 'px');
    }
    setText('#veSourceAr', info ? `${info.width}×${info.height} · ${ratioLabel(srcAR)}` : '');
    sizeSource();
    drawSource();
    updateSourceRect();
  }
  /* Called from updateCropMask, which runs on every change that could alter the
   * monitors' shapes (and every frame while tracking) — so it only compares a
   * short signature, and lays out on the next frame when that changes. */
  function noteMonitorShape() {
    const v = proView();
    const sig = [ve.aspect, ve.video ? ve.video.path : '', ve.bulk.files.length, v && v.classList.contains('ve-capmode'), v && v.classList.contains('ve-big')].join('|');
    if (sig === ve._monSig) return;
    ve._monSig = sig;
    requestAnimationFrame(layoutMonitors);
  }

  /* ---- the source monitor ---- */
  const SRC = { box: null };
  function sourceVisible() { const s = $('#veSource'); return !!s && s.offsetParent !== null && s.clientWidth > 0; }
  function sizeSource() {
    const stage = $('#veSourceStage'), cv = $('#veSourceCanvas');
    if (!stage || !cv || !ve.video || !ve.video.info || !sourceVisible()) { SRC.box = null; return; }
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) { SRC.box = null; return; }
    const ar = ve.video.info.width / ve.video.info.height;
    let w = W, h = W / ar;
    if (h > H) { h = H; w = H * ar; }
    const x = (W - w) / 2, y = (H - h) / 2;
    SRC.box = { x, y, w, h };
    cv.style.left = x.toFixed(1) + 'px'; cv.style.top = y.toFixed(1) + 'px';
    cv.style.width = w.toFixed(1) + 'px'; cv.style.height = h.toFixed(1) + 'px';
    // Painted at the size it is shown, not at the recording's size: a 4K frame
    // copied into a 600-pixel monitor would be 13x the work for nothing.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = Math.max(2, Math.min(1600, Math.round(w * dpr))), ch = Math.max(2, Math.round(cw / ar));
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
  }
  function tcOf(t) {
    const fps = Math.max(1, Math.round((ve.video && ve.video.info && ve.video.info.fps) || 30));
    const x = Math.max(0, t || 0);
    const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60), s = Math.floor(x % 60);
    const f = Math.min(fps - 1, Math.floor((x - Math.floor(x)) * fps));
    return [h, m, s, f].map((n) => String(n).padStart(2, '0')).join(':');
  }
  function drawSource() {
    const p = ve.refs.player;
    if (p) setText('#veSourceTc', tcOf(p.currentTime || 0));
    if (!SRC.box || !studioActive() || !sourceVisible()) return;
    const cv = $('#veSourceCanvas');
    if (!p || !cv || p.readyState < 2 || !p.videoWidth) return;
    try { cv.getContext('2d').drawImage(p, 0, 0, cv.width, cv.height); } catch (e) {}
  }
  let srcFrameCb = null;
  function startSourceLoop() {
    const p = ve.refs.player;
    if (!p || srcFrameCb != null) return;
    if (!p.requestVideoFrameCallback) { drawSource(); return; }
    const step = () => {
      srcFrameCb = null;
      drawSource();
      if (!p.paused && studioActive() && sourceVisible()) srcFrameCb = p.requestVideoFrameCallback(step);
    };
    srcFrameCb = p.requestVideoFrameCallback(step);
  }
  /** The box that goes in the short, drawn on the source. Runs every frame while
   *  the tracker moves it, so it only writes what changed. */
  function updateSourceRect() {
    const r = $('#veSourceRect'); if (!r) return;
    if (!SRC.box || !ve.video || !ve.video.info) { r.classList.add('hidden'); return; }
    const b = SRC.box;
    let x, y, w, h, tag, cls;
    if (ve.fill.mode !== 'crop') {
      x = b.x; y = b.y; w = b.w; h = b.h;
      tag = ve.fill.mode === 'blur' ? 'The whole picture, over a blurred copy of itself' : 'The whole picture, with black bars';
      cls = 'whole';
    } else {
      const c = cropWindow();
      x = b.x + (c.ox - c.cw / 2) * b.w; y = b.y + (c.oy - c.ch / 2) * b.h; w = c.cw * b.w; h = c.ch * b.h;
      tag = reframeOn() ? '🎯 Following the speaker' : ('✋ Framed by hand' + (c.z > 1.01 ? ` · ${c.z.toFixed(1)}×` : ''));
      cls = reframeOn() ? 'auto' : '';
    }
    const key = [x, y, w, h].map((v) => v.toFixed(1)).join('|') + '|' + tag + '|' + cls;
    if (r._key === key) return;
    r._key = key;
    r.classList.remove('hidden');
    r.classList.toggle('auto', cls === 'auto');
    r.classList.toggle('whole', cls === 'whole');
    r.style.left = x.toFixed(1) + 'px'; r.style.top = y.toFixed(1) + 'px';
    r.style.width = w.toFixed(1) + 'px'; r.style.height = h.toFixed(1) + 'px';
    setText('#veSourceTag', tag);
    setText('#veSourceHint', ve.fill.mode !== 'crop'
      ? 'Frame fill shows the whole picture — switch it to ✂️ Crop to fill (🎯 Reframe tab) to choose a part of it'
      : reframeOn() ? 'The box follows the speaker — drag it to frame the short yourself'
        : 'Drag the box to choose what is in the short · scroll to zoom · double-click to centre');
  }
  function wireSource() {
    const stage = $('#veSourceStage'); if (!stage) return;
    stage.addEventListener('mousedown', (ev) => {
      if (!ve.video || !SRC.box || ev.button !== 0 || ve.fill.mode !== 'crop') return;
      ev.preventDefault();
      if (reframeOn()) takeManualFraming();
      const b = SRC.box, sr = stage.getBoundingClientRect();
      const w0 = cropWindow();
      // A click outside the box brings the box to the click, then the drag goes on from there.
      const px = (ev.clientX - sr.left - b.x) / b.w, py = (ev.clientY - sr.top - b.y) / b.h;
      if (Math.abs(px - w0.ox) > w0.cw / 2 || Math.abs(py - w0.oy) > w0.ch / 2) {
        ve.framing.offsetX = clamp(px, 0, 1); ve.framing.offsetY = clamp(py, 0, 1);
        updateCropMask();
      }
      const s0 = cropWindow();
      const d = { x0: ev.clientX, y0: ev.clientY, ox0: s0.ox, oy0: s0.oy };
      ve.cropDrag = d;           // the tracker stands still while a hand is on the box
      const move = (e) => {
        // The box moves WITH the mouse here (on the program monitor the video
        // moves under a fixed frame, so the same gesture runs the other way).
        ve.framing.offsetX = clamp(d.ox0 + (e.clientX - d.x0) / b.w, 0, 1);
        ve.framing.offsetY = clamp(d.oy0 + (e.clientY - d.y0) / b.h, 0, 1);
        updateCropMask();
      };
      const up = () => { ve.cropDrag = null; document.removeEventListener('mousemove', move); touchSession(); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up, { once: true });
    });
    stage.addEventListener('wheel', (ev) => {
      if (!ve.video || ve.fill.mode !== 'crop') return;
      ev.preventDefault();
      if (reframeOn()) takeManualFraming();
      ve.framing.zoom = clamp(ve.framing.zoom * (ev.deltaY < 0 ? 1.08 : 0.93), 1, 8);
      updateCropMask();
    }, { passive: false });
    stage.addEventListener('dblclick', () => { if (ve.video && !reframeOn()) resetCrop(); });
  }

  /* ---- the timeline's height: a handle to drag ---- */
  const TLH_KEY = 'mw-ve-tlh';
  const TLH_DEFAULT = 342;
  function setTimelineHeight(h, quiet) {
    const tl = $('#veTimeline'); if (!tl) return TLH_DEFAULT;
    const v = clamp(Math.round(h), 150, 560);
    tl.style.setProperty('--tl-h', v + 'px');
    if (!quiet) { try { localStorage.setItem(TLH_KEY, String(v)); } catch (e) {} }
    return v;
  }
  /* With no height chosen, the timeline takes about two-fifths of the studio:
   * the full 342px on a tall screen, less on a laptop, where the monitors
   * would otherwise be squeezed to a strip (the lanes scroll when it is short). */
  function autoTimelineHeight() {
    let saved = null;
    try { saved = parseInt(localStorage.getItem(TLH_KEY), 10); } catch (e) {}
    if (saved) return setTimelineHeight(saved, true);
    const v = proView();
    const h = v ? v.clientHeight : 0;
    if (!h) return TLH_DEFAULT;
    return setTimelineHeight(clamp(Math.round(h * 0.42), 200, TLH_DEFAULT), true);
  }
  function wireTimelineSplit() {
    const sp = $('#veTlSplit'); if (!sp) return;
    autoTimelineHeight();
    window.addEventListener('resize', () => { if (studioActive()) autoTimelineHeight(); });
    sp.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      if (isPreviewBig()) setPreviewBig(false);
      const tl = $('#veTimeline');
      const h0 = tl.getBoundingClientRect().height, y0 = ev.clientY;
      sp.classList.add('drag');
      const move = (e) => setTimelineHeight(h0 - (e.clientY - y0), true);
      const up = () => {
        sp.classList.remove('drag');
        document.removeEventListener('mousemove', move);
        setTimelineHeight(tl.getBoundingClientRect().height);
        ve._tlPadL = null; renderRuler(); renderSegments(); updatePlayhead();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up, { once: true });
    });
    sp.addEventListener('dblclick', () => {
      try { localStorage.removeItem(TLH_KEY); } catch (e) {}
      autoTimelineHeight();
    });
  }

  /* ---- ↖ Select and ✂ Blade ---- */
  function setTool(name) {
    ve.tool = name === 'blade' ? 'blade' : 'select';
    const a = $('#veToolSelect'), b = $('#veToolBlade');
    if (a) { a.classList.toggle('on', ve.tool === 'select'); a.setAttribute('aria-pressed', ve.tool === 'select' ? 'true' : 'false'); }
    if (b) { b.classList.toggle('on', ve.tool === 'blade'); b.setAttribute('aria-pressed', ve.tool === 'blade' ? 'true' : 'false'); }
    const v = proView(); if (v) v.classList.toggle('ve-blade', ve.tool === 'blade');
    return ve.tool;
  }
  /** The blade cuts where it is clicked — the video row cuts the clip under the
   *  click, the audio row cuts the sound only, exactly like Split does there. */
  function bladeAt(ev, row) {
    if (ve.tool !== 'blade' || !ve.video || ev.button !== 0) return;
    ev.preventDefault(); ev.stopPropagation();
    const t = clamp(trackX(ev) / ve.pxPerSec, 0, dur());
    if (row === 'audio') { ve.activeRow = 'audio'; splitAudioAt(t); return; }
    const segEl = ev.target.closest('.ve-seg');
    if (!segEl || !segEl.dataset.id) {
      window.__toast && window.__toast('✂ Blade: click ON a clip to cut it there (V goes back to Select).', 'error', 4000);
      return;
    }
    selectSeg(segEl.dataset.id);
    splitAtPlayhead(t);
  }
  function wireTools() {
    const a = $('#veToolSelect'), b = $('#veToolBlade');
    if (a) a.addEventListener('click', () => setTool('select'));
    if (b) b.addEventListener('click', () => setTool(ve.tool === 'blade' ? 'select' : 'blade'));
    if (ve.refs.track) ve.refs.track.addEventListener('mousedown', (ev) => bladeAt(ev, 'video'), true);
    if (ve.refs.audioTrack) ve.refs.audioTrack.addEventListener('mousedown', (ev) => bladeAt(ev, 'audio'), true);
    const scroll = ve.refs.tlScroll;
    if (scroll && ve.refs.track) {
      const guide = document.createElement('div');
      guide.className = 've-blade-guide';
      scroll.appendChild(guide);
      scroll.addEventListener('mousemove', (ev) => {
        if (ve.tool !== 'blade') return;
        guide.style.left = (ve.refs.track.offsetLeft + trackX(ev)).toFixed(1) + 'px';
        guide.classList.add('on');
      });
      scroll.addEventListener('mouseleave', () => guide.classList.remove('on'));
    }
    setTool('select');
  }

  /* ---- J ◂ K ▸ L ---- */
  function setPlayRate(r) {
    const p = ve.refs.player; if (p) { try { p.playbackRate = r; } catch (e) {} }
    const m = ve.refs.musicAudio; if (m) { try { m.playbackRate = r; } catch (e) {} }
  }
  function stopReverse() { if (ve._revTimer) { clearInterval(ve._revTimer); ve._revTimer = null; } }
  function showShuttle() {
    const s = ve._shuttle || 0;
    setText('.ve-jkl', s === 0 ? 'J ◂ K ▸ L' : s > 0 ? `▸ ${s}×` : `◂◂ ${-s}×`);
  }
  /** dir: -1 = J (rewind, faster each press), 0 = K (stop), 1 = L (play, faster each press). */
  function shuttle(dir) {
    const p = ve.refs.player; if (!p || !ve.video) return 0;
    if (dir === 0) { stopReverse(); if (!p.paused) p.pause(); setPlayRate(1); ve._shuttle = 0; showShuttle(); return 0; }
    if (dir > 0) {
      stopReverse();
      if (p.paused || (ve._shuttle || 0) <= 0) { setPlayRate(1); ve._shuttle = 1; if (p.paused) togglePlay(); }
      else { ve._shuttle = ve._shuttle >= 1.5 ? 2 : 1.5; setPlayRate(ve._shuttle); }
      showShuttle();
      return ve._shuttle;
    }
    // A <video> cannot play backwards, so rewinding is a run of small seeks —
    // choppier than forward play, but you can hear where you are going.
    if (!p.paused) p.pause();
    setPlayRate(1);
    ve._shuttle = (ve._shuttle || 0) < 0 ? Math.max(-4, ve._shuttle * 2) : -1;
    stopReverse();
    ve._revTimer = setInterval(() => {
      const t = (p.currentTime || 0) + ve._shuttle * 0.125;
      if (t <= 0) { seekTo(0); shuttle(0); return; }
      seekTo(t);
    }, 125);
    showShuttle();
    return ve._shuttle;
  }

  /* ---- the finder's settings, summed up in one line ---- */
  const FIND_OPEN_KEY = 'mw-ve-findopen';
  function renderFindSummary() {
    // The options carry emoji for the dropdowns; the summary line is plain words.
    const plain = (t) => String(t || '').replace(/[\u2190-\u2bff\u2600-\u27bf\u{1F000}-\u{1FAFF}\ufe0f]/gu, '').replace(/\s+/g, ' ').trim();
    const opt = (id) => { const s = document.getElementById(id); return s && s.options[s.selectedIndex] ? plain(s.options[s.selectedIndex].textContent) : ''; };
    const box = (id) => { const c = document.getElementById(id); return !!(c && c.checked); };
    const len = opt('veShortLen').replace(/ shorts$/, '').replace(/^✨ /, '');
    const how = (document.getElementById('vePauseHow') || {}).value;
    const bits = [len, box('veDeep') ? 'Deep' : 'Quick', opt('veAsrPicker'), opt('veAiPicker'),
      box('veRemovePauses') ? (how === 'cloud' ? 'pauses by words' : 'pauses by silence') : 'pauses kept'];
    setText('#veFindSum', '⚙ ' + bits.filter(Boolean).join(' · '));
  }
  function wireFindMore() {
    const d = $('#veFindMore'); if (!d) return;
    let open = null;
    try { open = localStorage.getItem(FIND_OPEN_KEY); } catch (e) {}
    d.open = open === '1';
    d.addEventListener('toggle', () => { try { localStorage.setItem(FIND_OPEN_KEY, d.open ? '1' : '0'); } catch (e) {} });
    d.addEventListener('change', renderFindSummary);
    renderFindSummary();
    // the pickers are filled in later (the models are asked for), so say it again then
    setTimeout(renderFindSummary, 1500);
  }

  /** Everything the Pro layout adds, wired once. */
  function wirePro() {
    wireInspector();
    wireFindMore();
    wireSource();
    wireTimelineSplit();
    wireTools();
    const p = ve.refs.player;
    if (p) {
      p.addEventListener('play', startSourceLoop);
      p.addEventListener('seeked', () => { drawSource(); startSourceLoop(); });
      // a paused seek may present no new frame for the loop to hear about
      p.addEventListener('timeupdate', () => { if (p.paused) drawSource(); });
      p.addEventListener('loadeddata', () => { layoutMonitors(); startSourceLoop(); });
      // the player's own controls stop a shuttle too
      p.addEventListener('pause', () => { if ((ve._shuttle || 0) > 0) { ve._shuttle = 0; setPlayRate(1); showShuttle(); } });
    }
    // Any change in the monitors' size — the window, the timeline handle, ⤢,
    // the captions taking over — re-fits them; any change in the program
    // monitor's size re-fits the frame, captions and text drawn inside it.
    if (window.ResizeObserver) {
      let q = 0;
      const refit = () => {
        if (q) return;
        q = requestAnimationFrame(() => {
          q = 0;
          if (!studioActive()) return;
          layoutMonitors();
          updateCropMask();
          updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
          renderTextOverlays();
        });
      };
      const ro = new ResizeObserver(refit);
      const mon = $('#veMonitors'); if (mon) ro.observe(mon);
      if (ve.refs.drop) ro.observe(ve.refs.drop);
    }
  }

  /* ---------------- LIVE face-tracking preview ---------------- */
  // While auto-reframe is ON and the video plays, detect the speaker a few times a
  // second and move the 9:16 crop frame onto them — a real-time preview of the reframe.
  let liveTrackBusy = false;
  // liveRenderCx/Cy = what's actually ON SCREEN, updated every animation frame (~60fps).
  // ve.liveFaceCx/Cy (below) is the TARGET, recomputed only ~4-5x/sec by applyLiveFaceSample —
  // already dead-banded/EMA'd/leashed so it's guaranteed to keep the speaker in frame. Driving
  // the crop straight off that ~220ms-cadence target via a CSS transition retriggered every tick
  // still reads as jerky: each ease-out transition DECELERATES TO A DEAD STOP, then the next
  // tick's transition starts from zero velocity again — a repeating "lurch, brake, lurch, brake"
  // during any sustained move (measured on real footage: ~1 in 7 ticks hops >60% of the leash
  // bound in one 220ms step). A real camera operator doesn't stop between samples; they glide
  // continuously. This loop is that glide: it chases the target every frame with the same
  // velocity-capped, eased physics the OFFLINE exporter's virtual camera uses (facetrack.js
  // camForSlice's step()) — smooth motion regardless of how choppy the target's own updates are.
  let liveRenderCx = null, liveRenderCy = null, liveVelX = 0, liveVelY = 0, liveRenderLastT = null, liveRenderRAF = null;
  function resetLiveRender() { liveRenderCx = null; liveRenderCy = null; liveVelX = 0; liveVelY = 0; liveRenderLastT = null; }
  /** Pure physics: advance the render position toward the current target by exactly dt
   *  seconds. Split out from the rAF scheduling below so it can be driven with an exact,
   *  controlled dt (real ticks AND tests) — same reasoning as applyLiveFaceSample above.
   *  Same shape as facetrack.js camForSlice's step(): capped speed, eased accel/decel —
   *  just tuned faster since the target itself already moves in leash-bounded ~0.08 hops
   *  every ~220ms (up to ~0.36/s); this is a glide-shape guard, not a pace-setter. */
  function tickLiveRender(dt) {
    const idle = ve.liveFaceCx == null || !reframeOn() || !ve.video || ve.cropDrag || !$('#view-video').classList.contains('active');
    if (idle) { liveRenderLastT = null; return false; }
    if (liveRenderCx == null) { liveRenderCx = ve.liveFaceCx; liveRenderCy = ve.liveFaceCy; }
    if (dt <= 0) return false;
    const step = (cam, vel, tgt) => {
      const desiredV = Math.max(-0.9, Math.min(0.9, (tgt - cam) * 6));
      vel += (desiredV - vel) * Math.min(1, 10 * dt);
      return [cam + vel * dt, vel];
    };
    [liveRenderCx, liveVelX] = step(liveRenderCx, liveVelX, ve.liveFaceCx);
    [liveRenderCy, liveVelY] = step(liveRenderCy, liveVelY, ve.liveFaceCy);
    updateCropMask();
    return true;
  }
  function stepLiveRender(now) {
    liveRenderRAF = requestAnimationFrame(stepLiveRender); // keep the loop alive regardless of this frame's outcome
    const dt = liveRenderLastT == null ? 0 : Math.min(0.05, Math.max(0, (now - liveRenderLastT) / 1000));
    liveRenderLastT = now;
    tickLiveRender(dt);
  }
  function startLiveRenderLoop() { if (liveRenderRAF == null) liveRenderRAF = requestAnimationFrame(stepLiveRender); }
  /** Pure per-tick update of ve.liveFaceCx/Cy from one raw detection sample —
   *  split out from updateLiveReframe so it can be driven directly (real ticks
   *  AND tests) without needing a live <video> element. Returns true if the
   *  crop guide should be redrawn. */
  function applyLiveFaceSample(face) {
    // ve._liveJump = { cx, cy, n } — the raw position of the latest FAR reading
    // and how many consecutive far ticks have agreed with each other so far.
    // Any miss/near tick clears it, so a stale candidate from several ticks ago
    // can never pair up with an unrelated later reading.
    if (!face) { ve._liveJump = null; return false; }
    const hasTrack = ve.liveFaceCx != null;
    // FAR/NEAR is classified on the RAW reading vs the RAW track. An earlier
    // version classified on the 3-tick rolling MEAN instead — which let a
    // phantom slip AROUND the jump filter entirely: one far reading blended
    // with two near ones lands in the 0.055..0.2 "calm move" band, so the
    // EMA+leash below chased it as if the speaker had genuinely moved
    // (measured on the real sermon: every time the speaker's face blinked out
    // for a tick while a second face was visible, the crop lurched toward the
    // other person and back — the reported "glitchy, not smooth"). Raw-vs-raw
    // classification closes that hole; the mean now only ever mixes near
    // readings with near ones.
    const rawDx = hasTrack ? Math.abs(face.cxNorm - ve.liveFaceCx) : 1;
    const rawDy = hasTrack ? Math.abs(face.cyNorm - ve.liveFaceCy) : 1;

    if (rawDx > 0.2 || rawDy > 0.2) {
      // FAR: a camera cut / whip pan / sprint… or another person's face while
      // the speaker's is momentarily undetected. Far readings NEVER enter the
      // smoothing history — only a confirmed relocation resets it.
      //
      // BODIES DON'T TELEPORT (the offline exporter's fusion-guard insight,
      // facetrack.js PASS B): if the pose tracker still sees a body at the
      // position we're tracking, the speaker cannot have relocated — the far
      // "face" is a phantom or a different person. Ignore it outright. A real
      // camera cut moves the body along with the face, so this never delays
      // genuine cut handling; it only kills steals.
      if (hasTrack && face.poseCx != null
        && Math.abs(face.poseCx - ve.liveFaceCx) <= 0.18
        && (face.poseCy == null || Math.abs(face.poseCy - ve.liveFaceCy) <= 0.18)) {
        ve._liveJump = null;
        return false;
      }
      // POSE CORROBORATION: the multi-tick raw-agreement wait below exists purely to tell a
      // genuine relocation apart from a phantom/second face — but when the pose tracker
      // independently agrees with THIS tick's far reading, that question is already answered:
      // a phantom face-like pattern has no corresponding body there, so pose agreeing means
      // the body really is at the new position. Follow now (still leash-bounded, not an
      // instant teleport) instead of freezing for up to ~660ms while raw ticks confirm each
      // other — measured on real footage: without this, a genuine fast/sustained walk (which
      // pose tracks smoothly throughout) got the exact same "hold and assess" treatment as an
      // ambiguous phantom, which is backwards — it's the single biggest source of the crop
      // visibly lagging the speaker while they're moving. Applies at COLD START too (no
      // hasTrack gate) — see the guard below for why that matters.
      const poseCorroborates = face.poseCx != null
        && Math.abs(face.poseCx - face.cxNorm) <= 0.18
        && (face.poseCy == null || Math.abs(face.poseCy - face.cyNorm) <= 0.18);
      if (poseCorroborates) {
        ve._liveJump = null;
        ve._liveRawHist = null;
        if (!hasTrack) { ve.liveFaceCx = face.cxNorm; ve.liveFaceCy = face.cyNorm; return true; }
        const lw = cropWindow();
        const leashX = 0.3 * (lw.cw / 2), leashY = 0.3 * (lw.ch / 2);
        ve.liveFaceCx = clamp(ve.liveFaceCx, face.cxNorm - leashX, face.cxNorm + leashX);
        ve.liveFaceCy = clamp(ve.liveFaceCy, face.cyNorm - leashY, face.cyNorm + leashY);
        return true;
      }
      const j = ve._liveJump;
      // COLD-START GUARD: a background/decor false-positive can legitimately repeat for 2
      // consecutive ticks (measured on real footage — a floral display got mis-detected as a
      // face twice in a row at the exact moment the real speaker's pose was clearly visible
      // elsewhere), which the ordinary 2-tick "fresh track" confirmation below would happily
      // lock onto as the INITIAL anchor, since there's no established track yet for the
      // pose-veto above to protect against. If pose is available for this tick and didn't just
      // corroborate (checked above), don't let raw-vs-raw agreement alone seed a fresh track —
      // treat it as a new, unconfirmed candidate instead of incrementing. Established tracks
      // are unaffected (already protected by the veto/corroboration checks above); cold starts
      // with NO pose data at all still fall through to the raw-agreement scheme unchanged.
      if (!hasTrack && face.poseCx != null && j) {
        ve._liveJump = { cx: face.cxNorm, cy: face.cyNorm, n: 1 };
        ve._liveRawHist = null;
        return false;
      }
      if (j && Math.abs(j.cx - face.cxNorm) <= 0.1 && Math.abs(j.cy - face.cyNorm) <= 0.1) {
        // agrees with the previous far tick — a coherent new position.
        const n = j.n + 1;
        // A fresh track (nothing to protect yet) locks on after 2 agreeing
        // ticks. An ESTABLISHED track demands 3 (~660ms of consecutive
        // sightings) before relocating: with two people in frame, a stable
        // second face + two missed detections of the speaker used to be
        // enough to steal the crop — and steal it BACK when the speaker's
        // face returned, a full-width whip each way. The crop holds perfectly
        // still while assessing, so a phantom that dies within ~660ms leaves
        // zero visible trace, while a real cut still snaps in under a second.
        if (n >= (hasTrack ? 3 : 2)) {
          ve._liveRawHist = [{ cx: face.cxNorm, cy: face.cyNorm }];
          ve.liveFaceCx = face.cxNorm; ve.liveFaceCy = face.cyNorm;
          ve._liveJump = null;
          return true;
        }
        ve._liveJump = { cx: face.cxNorm, cy: face.cyNorm, n };
        return false; // still assessing: hold perfectly still
      }
      const first = !j;
      ve._liveJump = { cx: face.cxNorm, cy: face.cyNorm, n: 1 };
      // The first far sighting always holds one tick (a lone single-tick
      // phantom never repeats, so it becomes fully invisible) — and it also
      // clears the smoothing history: if this DOES turn into a relocation or
      // fast move, pre-jump positions must not blend into what follows.
      ve._liveRawHist = null;
      if (first || !hasTrack) return false;
      // Far readings that keep DISAGREEING with each other (moving so fast no
      // two consecutive ticks land within 0.1) can never confirm — but they're
      // real, so from the 2nd consecutive far tick on, leash-drag toward each
      // reading, bounded, instead of freezing solid indefinitely.
      const lw = cropWindow();
      // 0.3x (not 0.5x): with the 60fps render glide (stepLiveRender) now handling
      // ALL visual smoothing independently, this leash no longer trades centering for
      // smoothness — tightening it directly tightens how well the crop centers on the
      // speaker, with zero cost to how the motion LOOKS on screen.
      const leashX = 0.3 * (lw.cw / 2), leashY = 0.3 * (lw.ch / 2);
      ve.liveFaceCx = clamp(ve.liveFaceCx, face.cxNorm - leashX, face.cxNorm + leashX);
      ve.liveFaceCy = clamp(ve.liveFaceCy, face.cyNorm - leashY, face.cyNorm + leashY);
      return true;
    }

    // NEAR: ordinary tracking. A light 3-tick rolling mean smooths single-frame
    // detector jitter (head tilts, blinks, bounding-box noise) to decide WHETHER
    // to move (dead-band) and to shape the EMA glide; the wide dead-band holds
    // the frame STILL through rocking/gesturing; the EMA glides it when the
    // speaker really moves; and the hard leash guarantees the face never trails
    // outside the crop's safe zone — mirrors facetrack.js camForSlice step 4:
    // "smoothness is a preference; in-frame is a guarantee".
    //
    // The leash is anchored to the RAW current reading (face.cxNorm), NOT the
    // 3-tick mean — anchoring it to the mean was a bug: during a SUSTAINED real
    // walk the mean lags the true position too (by design, it's smoothing), so
    // a leash measured against an already-lagging reference lets the EMA's own
    // lag accumulate for as long as the walk continues instead of being bounded
    // tick to tick. Measured on real footage: a 5s walk let the target drift
    // 0.134 behind the actual (pose-confirmed) position — clearly off-center —
    // even though the leash bound was only 0.079. Anchoring to the raw reading
    // (matching the offline exporter's own hard leash, which clamps against the
    // per-FRAME raw position, never a smoothed one) bounds the gap to the leash
    // on every single tick, so lag can never accumulate across a sustained move.
    ve._liveJump = null;
    const hist = (ve._liveRawHist || []).concat([{ cx: face.cxNorm, cy: face.cyNorm }]).slice(-3);
    ve._liveRawHist = hist;
    const sm = { cx: hist.reduce((a, s) => a + s.cx, 0) / hist.length, cy: hist.reduce((a, s) => a + s.cy, 0) / hist.length };
    if (!hasTrack) { ve.liveFaceCx = sm.cx; ve.liveFaceCy = sm.cy; return true; } // unreachable in practice (no track ⇒ rawDx=1 ⇒ FAR), kept for safety
    const dx = Math.abs(sm.cx - ve.liveFaceCx), dy = Math.abs(sm.cy - ve.liveFaceCy);
    const before = { cx: ve.liveFaceCx, cy: ve.liveFaceCy };
    if (!(dx < 0.055 && dy < 0.055)) {
      ve.liveFaceCx = 0.4 * sm.cx + 0.6 * ve.liveFaceCx;
      ve.liveFaceCy = 0.4 * sm.cy + 0.6 * ve.liveFaceCy;
    }
    // The leash runs UNCONDITIONALLY, even through a dead-band-held tick — not just after an
    // EMA update. During ACCELERATING movement the 3-tick mean itself lags the true (raw)
    // position enough that dx (measured against the mean) can stay under the dead-band even
    // while the raw position keeps pulling away — the dead-band would then freeze the target
    // for several ticks straight with no correction at all (measured on real footage: exactly
    // this, mid-walk). Always clamping to the raw reading closes that hole: a genuinely still
    // dead-band tick clamps to a no-op (natural sway is smaller than the leash almost always),
    // while an accelerating one gets pulled back toward the true position every single tick.
    const lw = cropWindow();
    const leashX = 0.3 * (lw.cw / 2), leashY = 0.3 * (lw.ch / 2);
    ve.liveFaceCx = clamp(ve.liveFaceCx, face.cxNorm - leashX, face.cxNorm + leashX);
    ve.liveFaceCy = clamp(ve.liveFaceCy, face.cyNorm - leashY, face.cyNorm + leashY);
    return ve.liveFaceCx !== before.cx || ve.liveFaceCy !== before.cy;
  }
  function updateLiveReframe() {
    if (!ve.video || !reframeOn() || !window.FaceTrack || !window.FaceTrack.detectElement) return;
    if (!$('#view-video').classList.contains('active')) return;
    const p = ve.refs.player;
    if (!p || p.paused || p.readyState < 2 || liveTrackBusy) return;
    maybeAskLiveAi(p);
    liveTrackBusy = true;
    window.FaceTrack.detectElement(p, { nearX: ve.liveFaceCx, nearY: ve.liveFaceCy, lock: followLock() }).then((face) => {
      liveTrackBusy = false;
      if (applyLiveFaceSample(face)) updateCropMask();
    }).catch(() => { liveTrackBusy = false; });
  }
  /** Forget where the live preview thought the speaker was — on a new video, or
   *  when the operator changes WHO is being followed (the old target belongs to
   *  the old answer, and gliding to the new one from it looks like a mistake). */
  function resetLiveTrack() {
    ve.liveFaceCx = null; ve.liveFaceCy = null; ve._liveJump = null; ve._liveRawHist = null;
    resetLiveRender();
    if (window.FaceTrack && window.FaceTrack.resetLive) window.FaceTrack.resetLive();
    if (ve.liveAi) ve.liveAi.t = null;   // the memory it seeded is gone: ask again on the next play
  }

  /*
   * THE PROGRAM VIEW ASKS THE REFEREE TOO (🧠 in the Reframe tab).
   *
   * The live tracker starts on whoever is biggest and then remembers their look
   * (FaceTrack.detectElement), so a congregant walking past the lens as a short
   * starts playing is followed — and held on to. The export asks the cloud who
   * is preaching; the preview should not disagree with it. So as a short starts
   * playing (or the playhead jumps somewhere new) the current frame is ruled
   * into the referee's columns and shown to it; the person the PC finds in its
   * column becomes the preview's memory of who to follow (FaceTrack.seedLive).
   * It never moves the picture itself: the next detection tick does, through
   * the same 60 fps glide as always, so it is as smooth as anything else the
   * preview does.
   *
   * ►► Free-tier arithmetic, MEASURED: Groq's vision model allows 200,000
   * tokens a DAY and costs a picture ~2,400 before looking at it. Asking every
   * 45 s of playback would spend ~190,000 in an hour of previewing and leave
   * nothing for the exports, which are what the AI is really for. So the
   * preview asks only on arriving somewhere new, at most LIVE_AI_PER_HOUR
   * times an hour (~30,000 tokens), and queues behind an export's questions
   * (cloudsee.js asks one at a time), never alongside them.
   */
  const LIVE_AI_EVERY = 120;      // s: the playhead must be this far from the last ask to ask again
  const LIVE_AI_MIN_GAP = 30000;  // ms — scrubbing about must not become a stream of asks
  const LIVE_AI_PER_HOUR = 12;
  ve.liveAi = { busy: false, at: 0, t: null, seeded: null, why: '', asks: [] };
  async function maybeAskLiveAi(p) {
    const L = ve.liveAi;
    if (L.busy || ve.subject || reframeAiMode() !== 'cloud' || !window.api.reframe || !window.FaceTrack.columnGrid) return;
    if (ve.rfAi.state && !ve.rfAi.state.ready) return;
    const t = p.currentTime || 0;
    const moved = L.t == null || Math.abs(t - L.t) >= LIVE_AI_EVERY;
    if (!moved || Date.now() - L.at < LIVE_AI_MIN_GAP) return;
    L.asks = L.asks.filter((a) => Date.now() - a < 3600e3);
    if (L.asks.length >= LIVE_AI_PER_HOUR) { L.why = 'hourly allowance for the preview used — the exports still ask'; return; }
    L.busy = true; L.at = Date.now(); L.t = t;
    try {
      const people = await window.FaceTrack.detectPeople(p, { thumbs: false });
      // nobody, or only one person with a body: nothing for the referee to settle
      if (people.filter((q) => q.body).length < 2 && people.length < 3) { L.why = 'one person in shot'; return; }
      const image = window.FaceTrack.columnGrid(p);
      if (!image) return;
      L.asks.push(Date.now());   // only a question actually sent counts against the hour
      const r = await window.api.reframe.whoIsSpeaking({ image, frames: [{ label: 'A' }], columns: window.FaceTrack.REF_COLS });
      if (!r || !r.ok) { L.why = (r && r.why) || 'no answer'; return; }
      const col = r.answers && r.answers.A ? r.answers.A.column : 0;
      const who = col ? window.FaceTrack.personInColumn(people, col) : null;
      // the answer is about a moment a second ago: only use it if the preview is still there
      if (who && who !== 'ambiguous' && who.sig && !p.paused && Math.abs((p.currentTime || 0) - t) < 4) {
        window.FaceTrack.seedLive(who.sig);
        L.seeded = { t, cx: who.cx, col }; L.why = '';
      } else L.why = col ? 'nobody the PC found in that column' : 'speaker not in shot';
    } catch (e) { L.why = (e && e.message) || 'failed'; } finally { L.busy = false; }
  }
  function startLiveReframeLoop() {
    if (ve._liveTrackTimer) return;
    ve._liveTrackTimer = setInterval(updateLiveReframe, 220); // ~4-5 detections/sec (cheap; early-returns when idle)
  }

  /* ---------------- drag the VIDEO inside the canvas (CapCut) ---------------- */
  /** Grabbing the video means "I want to frame this myself" — switch auto-reframe
   *  off, seed the manual framing from where the auto camera currently is (no
   *  jump), and let the drag proceed. Re-tick Auto-reframe to hand control back. */
  function takeManualFraming() {
    const box = $('#veAutoReframe');
    if (!box || !box.checked) return;
    const w = cropWindow(); // current (face-followed) window BEFORE flipping the toggle
    box.checked = false;
    ve.framing.offsetX = w.ox; ve.framing.offsetY = w.oy;
    updateCropMask();
    window.__toast && window.__toast('✋ You\'re framing manually now — tick 🎯 Auto-reframe again to follow the speaker.', 'good');
  }
  function onCropDown(ev) {
    if (!ve.video) return;
    if (ev.target.closest('#veCropReset')) return;
    if (reframeOn()) takeManualFraming();
    ev.preventDefault(); ev.stopPropagation();
    const cm = ve.canvasMap; if (!cm) return;
    const w0 = cropWindow();
    ve.cropDrag = { x0: ev.clientX, y0: ev.clientY, ox0: w0.ox, oy0: w0.oy, s: cm.s, map: cm.map };
    const move = (e) => {
      const d = ve.cropDrag; if (!d) return;
      // dragging the video right reveals footage on the LEFT → the crop centre moves left
      ve.framing.offsetX = clamp(d.ox0 - (e.clientX - d.x0) / (d.s * (d.map.renderedW || 1)), 0, 1);
      ve.framing.offsetY = clamp(d.oy0 - (e.clientY - d.y0) / (d.s * (d.map.renderedH || 1)), 0, 1);
      updateCropMask();
    };
    const up = () => { ve.cropDrag = null; document.removeEventListener('mousemove', move); touchSession(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }
  function onCropWheel(ev) {
    if (!ve.video || !ve.refs.cropMask || ve.refs.cropMask.classList.contains('hidden')) return;
    ev.preventDefault();
    if (reframeOn()) takeManualFraming(); // zooming is a manual-framing intent too
    ve.framing.zoom = clamp(ve.framing.zoom * (ev.deltaY < 0 ? 1.08 : 0.93), 1, 8);
    updateCropMask();
  }
  function resetCrop() { ve.framing = { zoom: 1, offsetX: 0.5, offsetY: 0.5 }; updateCropMask(); }

  /* ---------------- audio waveform track (mirrors the video clips) ---------------- */
  function audioTrackSkeleton(inner) {
    const track = ve.refs.audioTrack; if (!track) return;
    track.innerHTML = `${inner}<div class="ve-audio-segments" id="veAudioSegments"></div>`;
    ve.refs.audioSegments = track.querySelector('#veAudioSegments');
    renderAudioSegments();
  }
  async function loadWaveform(path) {
    const track = ve.refs.audioTrack; if (!track) return;
    ve.waveformUrl = null;
    audioTrackSkeleton('<span class="muted small">Loading waveform…</span>');
    try {
      // Sized by the recording alone — not by the zoom, which is not even set yet
      // when this runs — so the same file asks for the same picture and the
      // main side can hand back the one it kept (a resumed session is instant).
      // It is stretched to the track anyway.
      const w = Math.round(clamp(dur() * 4, 1600, 6000)) || 1600;
      const png = await window.api.video.waveform({ input: path, width: w, height: 100 });
      const dataUrl = await window.api.fs.readImageDataUrl(png);
      // the waveform is painted INSIDE each audio clip (like the video filmstrip),
      // so a gap between moved/split clips shows the EMPTY track — no phantom audio
      if (ve.video && ve.video.path === path) { ve.waveformUrl = dataUrl; audioTrackSkeleton(''); }
    } catch (e) {
      audioTrackSkeleton('<span class="muted small">No audio track</span>');
    }
  }
  /**
   * The audio row is its OWN INDEPENDENT track (ve.audio). Splitting the video
   * does NOT touch it — audio only splits when you click the audio row (making it
   * the active row) and then Split. Selecting an audio clip sets activeRow='audio'.
   */
  function renderAudioSegments() {
    const el = ve.refs.audioSegments; if (!el) return;
    const total = trackW();
    el.innerHTML = ve.audio.map((s) => {
      const left = s.start * ve.pxPerSec, width = Math.max(6, (s.end - s.start) * ve.pxPerSec);
      const sel = (ve.activeRow === 'audio' && ve.audioSel === s.id) ? ' sel' : '';
      // paint this clip's own slice of the waveform (opaque), so gaps read as EMPTY
      const wf = ve.waveformUrl
        ? `background-image:url('${ve.waveformUrl}');background-size:${total}px 100%;background-position:${-(s.start * ve.pxPerSec)}px 0;background-repeat:no-repeat;background-color:var(--bg);`
        : '';
      return `<div class="ve-audio-seg${sel}" data-id="${s.id}" style="left:${left}px;width:${width}px;border-color:${s.color || '#2ea043'};${wf}">
        <div class="ve-audio-h l" data-aedge="l" title="Drag to trim where the sound starts"></div>
        <div class="ve-audio-h r" data-aedge="r" title="Drag to trim where the sound ends"></div>
      </div>`;
    }).join('');
    $$('.ve-audio-seg', el).forEach((box) => box.addEventListener('mousedown', (ev) => onAudioSegDown(ev, box)));
    updateGapMask(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0); // audio edits change what's audible NOW
  }
  function selectAudio(id) { ve.activeRow = 'audio'; ve.audioSel = id; ve.sel = null; ve.capSel = null; renderSegments(); }
  function onAudioSegDown(ev, box) {
    const id = box.dataset.id;
    const s = ve.audio.find((x) => x.id === id); if (!s) return;
    const edge = ev.target && ev.target.dataset ? ev.target.dataset.aedge : null;
    selectAudio(id); // clicking the audio row makes it the ACTIVE row (so Split acts on audio)
    if (!edge) seekTo(trackX(ev) / ve.pxPerSec);
    ev.preventDefault(); ev.stopPropagation();
    const preSnap = snapshotState();
    const x0 = trackX(ev), s0 = s.start, e0 = s.end, len = e0 - s0;
    const move = (e) => {
      const dt = (trackX(e) - x0) / ve.pxPerSec;
      if (edge === 'l') { s.start = clamp(snapT(s0 + dt).t, 0, s.end - 0.3); }
      else if (edge === 'r') { s.end = clamp(snapT(e0 + dt).t, s.start + 0.3, dur()); }
      else { const ns = clamp(s0 + dt, 0, dur() - len); s.start = ns; s.end = ns + len; }
      renderAudioSegments();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      if (Math.abs(s.start - s0) > 0.01 || Math.abs(s.end - e0) > 0.01) commitDragHistory(preSnap);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }
  function splitAudioAt(t) {
    const s = ve.audio.find((x) => t > x.start + 0.15 && t < x.end - 0.15);
    if (!s) return window.__toast && window.__toast('Move the playhead over the audio clip, then Split.', 'error');
    pushHistory();
    const origEnd = s.end; s.end = t;
    const right = { id: uid(), start: t, end: origEnd, color: s.color };
    ve.audio.push(right); ve.audioSel = right.id; ve.activeRow = 'audio';
    renderAudioSegments();
    window.__toast && window.__toast('✂ Audio split into 2 clips.', 'good');
  }
  function removeAudioSeg(id) {
    pushHistory();
    ve.audio = ve.audio.filter((s) => s.id !== id);
    if (ve.audioSel === id) ve.audioSel = null;
    renderAudioSegments();
  }

  /* ---------------- overlay lane (picture-in-picture) ---------------- */
  /** Move the selected clip to/from the OVERLAY lane (renders as PiP on export). */
  function toggleOverlayLane() {
    const s = ve.segments.find((x) => x.id === ve.sel);
    if (!s) return window.__toast && window.__toast('Select a clip first, then move it to the Overlay lane.', 'error');
    // Added media has no place on the main lane: the main lane's pixel position
    // IS a time inside THIS recording (that is what keeps the ruler, waveform and
    // caption lanes in step), and a second video's frames are not that.
    if (isMedia(s)) {
      return window.__toast && window.__toast(
        `“${s.label}” is added media — it lives on the Overlay lane, on top of the video. Drag it sideways to move it, or 🗑 to remove it.`, 'error', 6000);
    }
    pushHistory();
    if (s.lane === 1) { s.lane = 0; s.tlStart = undefined; }
    else { s.lane = 1; if (s.tlStart == null) s.tlStart = s.start; if (s.pipX == null) { s.pipX = 0.6; s.pipY = 0.05; s.pipW = 0.34; } }
    renderSegments();
    window.__toast && window.__toast(s.lane === 1
      ? '📺 Moved to Overlay — plays as picture-in-picture. Drag it sideways to set WHEN; drag the box on the preview to set WHERE.'
      : 'Moved back to the main lane.', 'good');
  }
  /** Draggable/resizable PiP position guide on the preview (for the selected overlay clip). */
  /**
   * Where an overlay's box lands ON THE PREVIEW, in preview pixels.
   *
   * x/y/w are fractions of the SOURCE frame, because that is what the compositor
   * works in — it lays the overlay onto the full picture and only then does the
   * export crop it. So when the preview is showing an export frame (9:16 and the
   * like), the video is transformed to fit that frame and the overlay must take
   * THE SAME transform. Without it an overlay parked outside the crop window
   * still looked comfortably inside the picture — and then wasn't in the short.
   *
   * ve.canvasMap is the transform updateCropMask applied to the <video>:
   * scale `s` about (Cx, Cy), then translate to (Fx, Fy). This is that, in JS.
   */
  /**
   * The rectangle the export will actually be, in preview pixels.
   *
   * For a short that is the canvas frame the mask draws; for an export that
   * keeps the whole picture (💾 Export video with no reshaping, a 📦 batch, or a
   * recording already the target shape) it is the picture itself. `ve._frameOn`
   * is set by updateCropMask, so this always agrees with what is on screen.
   */
  function outputFrameRect() {
    const fr = ve._frameOn ? canvasFrameRect() : null;
    if (fr) return fr;
    // previewMapping reads the recording's own shape, so before one is open the
    // only honest answer is the empty preview panel itself. (This runs from
    // renderTextOverlays, which is called on an empty studio.)
    if (!ve.video || !ve.video.info || !ve.refs.preview) {
      const el = ve.refs.preview;
      return { left: 0, top: 0, w: (el && el.clientWidth) || 400, h: (el && el.clientHeight) || 225 };
    }
    const m = previewMapping();
    return { left: m.offX, top: m.offY, w: m.renderedW || 1, h: m.renderedH || 1 };
  }
  /** The export frame's shape. */
  const frameAR = () => { const f = outputFrameRect(); return (f && f.h) ? f.w / f.h : 16 / 9; };

  /**
   * Where an overlay sits on the preview.
   *
   * pipX/pipY/pipW are fractions of the EXPORT FRAME, not of the recording. That
   * is the whole reason an overlay stays put while auto-reframe walks the crop
   * across the picture: the frame is the thing that gets exported, so a corner
   * of the frame is a corner of the finished short whatever the camera did.
   */
  function overlayPreviewRect(s) {
    const fr = outputFrameRect();
    // The box is as tall as what it SHOWS: added media keeps its own shape (a
    // portrait phone clip on a 16:9 service is the normal case), so borrowing
    // this video's ratio would draw a guide that does not match the export.
    const w = (s.pipW != null ? s.pipW : 0.34) * fr.w;
    const h = w / mediaAR(s);
    const left = fr.left + (s.pipX != null ? s.pipX : 0.6) * fr.w;
    const top = fr.top + (s.pipY != null ? s.pipY : 0.05) * fr.h;
    return { left, top, w, h, fr, map: previewMapping(), scale: 1 };
  }
  function renderOverlayGuide() {
    const g = ve.refs.overlayGuide; if (!g) return;
    const s = ve.segments.find((x) => x.id === ve.sel);
    if (!ve.video || !s || !(s.lane >= 1)) { g.classList.add('hidden'); return; }
    const r = overlayPreviewRect(s);
    g.classList.remove('hidden');
    g.style.left = Math.round(r.left) + 'px'; g.style.top = Math.round(r.top) + 'px';
    g.style.width = Math.round(r.w) + 'px'; g.style.height = Math.round(r.h) + 'px';
    const lab = g.querySelector('.ve-ovg-label');
    if (lab) lab.textContent = isMedia(s) ? (s.kind === 'image' ? '🖼 ' : '🎞 ') + s.label : '📺 Overlay (PiP)';
  }
  /**
   * Keep an overlay's box inside the picture.
   *
   * x/y are the box's TOP-LEFT as fractions of the frame, so clamping them to
   * 0..1 is not enough: a logo at y = 0.99 has its top-left just inside the
   * picture and every pixel of itself below it. Drag it down far enough and it
   * silently exports as nothing at all — which is the worst possible answer,
   * because the preview happily showed a box. The box's own SIZE has to come
   * into the sum, exactly as it does for added text.
   */
  function pipFit(x, y, w, vidAR, ar) {
    const W = clamp(Number(w) || 0.34, 0.02, 1);
    // The height as a fraction of the frame HEIGHT: the width is a fraction of
    // the frame's WIDTH, and the picture keeps its own shape inside it. That is
    // also the compositor's rule (scale=wFrac*BW:-2), so this is its geometry.
    const H = clamp((W * (vidAR || 16 / 9)) / Math.max(0.05, ar || 1), 0.02, 1);
    return {
      x: clamp(Number.isFinite(x) ? x : 0.6, 0, Math.max(0, 1 - W)),
      y: clamp(Number.isFinite(y) ? y : 0.05, 0, Math.max(0, 1 - H)),
      w: W,
    };
  }
  function clampPipIntoPicture(s) {
    if (!s) return;
    const f = pipFit(s.pipX, s.pipY, s.pipW, frameAR(), mediaAR(s));
    s.pipX = f.x; s.pipY = f.y; s.pipW = f.w;
  }

  function onOverlayGuideDown(ev) {
    const s = ve.segments.find((x) => x.id === ve.sel); if (!s || !(s.lane >= 1)) return;
    ev.preventDefault(); ev.stopPropagation();
    const resizing = !!ev.target.closest('[data-ovresize]');
    const preSnap = snapshotState();
    const x0 = ev.clientX, y0 = ev.clientY;
    const px0 = s.pipX != null ? s.pipX : 0.6, py0 = s.pipY != null ? s.pipY : 0.05, pw0 = s.pipW != null ? s.pipW : 0.34;
    // Measured against the EXPORT FRAME, which is what the numbers are fractions
    // of — so a pixel of mouse movement moves the box by a pixel, whatever the
    // picture underneath is doing.
    const fr = outputFrameRect();
    const move = (e) => {
      const dx = (e.clientX - x0) / (fr.w || 1), dy = (e.clientY - y0) / (fr.h || 1);
      if (resizing) { s.pipW = clamp(pw0 + dx, 0.05, 1); }
      else { s.pipX = px0 + dx; s.pipY = py0 + dy; }
      clampPipIntoPicture(s);
      renderOverlayGuide();
      // The picture moves WITH the box, not after it — dragging an empty outline
      // and finding out where it landed on export is the thing this replaces.
      updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
      // A batch graphic is placed once for the WHOLE batch, so the numbers go
      // back to the batch as they change — not only when the drag ends, because
      // the panel reads them to show what will be exported.
      syncBulkOverlayFrom(s);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      if (Math.abs((s.pipX || 0) - px0) > 0.001 || Math.abs((s.pipY || 0) - py0) > 0.001 || Math.abs((s.pipW || 0) - pw0) > 0.001) commitDragHistory(preSnap);
      syncBulkOverlayFrom(s);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }
  const overlayClips = () => ve.segments.filter((s) => (s.lane || 0) >= 1)
    // row order IS stacking order: a later row composites on top of an earlier one
    .sort((a, b) => (a.lane || 0) - (b.lane || 0));

  /* ---------------- add media: a second video, or a picture ----------------
   *
   * Files land on the OVERLAY lane at the playhead, one after another, and from
   * that moment they are ordinary timeline blocks: drag them anywhere, trim
   * either edge, drag the box on the preview to place them in the frame.
   */
  const MEDIA_FILTERS = [
    { name: 'Video or picture', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif'] },
    { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv'] },
    { name: 'Picture', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'avif'] },
  ];

  /* ==================== 📦 BULK: one graphic, many videos ====================
   *
   * The studio edits ONE video at a time, which is right for cutting a sermon
   * and wrong for the other job a media team has every week: forty clips that
   * all need the church's logo in the same corner. Dropping ten files used to
   * open the first and silently throw away the other nine.
   *
   * So: a BATCH lives beside the timeline. Every video in it stays untouched on
   * disk; what the batch holds is a list of them and the picture(s) to put over
   * them. The picture is placed ONCE, on whichever video you are looking at, with
   * the ordinary overlay box — and it is stored as FRACTIONS of the frame, so
   * "top-right corner, a fifth of the width" means the same thing on a 4K
   * landscape service and on a 1080×1920 phone clip. That is what makes one
   * placement legitimately apply to all of them.
   *
   * The preview is the truth here too: the box drawn on screen uses the same
   * fractions the exporter scales by (see overlayPreviewRect and
   * video.exportOverlayComposite), so where you put it IS where it lands.
   */
  const BULK_VIDEO_FILTERS = [
    { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv'] },
  ];
  const BULK_IMAGE_FILTERS = [
    { name: 'Picture', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'avif'] },
  ];

  /** Pick many videos for the batch. */
  async function pickBulkVideos() {
    let paths = null;
    try { paths = await window.api.dialog.openFile(BULK_VIDEO_FILTERS, true); } catch (e) { paths = null; }
    if (!paths) return;
    await addBulkVideos(Array.isArray(paths) ? paths : [paths]);
  }

  /**
   * Put videos in the batch. Duplicates are ignored (dropping the same folder
   * twice is a normal accident, and a file exported twice is not helpful), and
   * anything ffprobe cannot read is named rather than silently skipped.
   */
  async function addBulkVideos(paths) {
    const list = (paths || []).filter((p) => p && !isImgPath(p));
    if (!list.length) return;
    const have = new Set(ve.bulk.files.map((f) => f.path));
    const added = [], failed = [];
    window.__showOverlay && window.__showOverlay('📦 Reading the batch…');
    for (const p of list) {
      if (have.has(p)) continue;
      let info = null;
      try { info = await window.api.video.info(p); } catch (e) { info = null; }
      if (!info || !info.width || !info.height) { failed.push(p.split(/[\\/]/).pop()); continue; }
      const f = { path: p, name: p.split(/[\\/]/).pop(), info, thumb: null };
      ve.bulk.files.push(f); have.add(p); added.push(f);
    }
    window.__hideOverlay && window.__hideOverlay();
    renderBulk();
    if (!added.length) {
      return window.__toast && window.__toast(
        failed.length ? `⚠️ Could not read ${failed.join(', ')} — ffprobe finds no picture in there.`
          : 'Those videos are already in the batch.', failed.length ? 'error' : '', 6000);
    }
    // Show the first one so there is something to place the picture ON — but
    // only when there was nothing to look at, or this IS the batch. Adding more
    // files to a batch you are already working in must not yank the view away.
    if (!ve.video || ve.bulk.files.length === added.length) await openBulkVideo(0);
    renderBulk();
    updateCropMask();   // a batch shows the WHOLE picture, not the social crop
    // Thumbnails one at a time: forty ffmpeg processes at once would take the
    // machine away from the operator for no gain — these are only row pictures.
    (async () => { for (const f of added) await loadBulkThumb(f); })();
    window.__toast && window.__toast(
      `📦 ${ve.bulk.files.length} video${ve.bulk.files.length > 1 ? 's' : ''} in the batch. Click 🖼 Image over all, place it on the picture, then Export all — every one of them gets it in the same spot.`
      + (failed.length ? ` (Couldn't read ${failed.join(', ')}.)` : ''), 'good', 9000);
  }

  /** A still from a batch video, for its row in the list. */
  async function loadBulkThumb(f) {
    if (!f || f.thumb) return;
    try {
      const t = Math.min(2, Math.max(0.1, (f.info.durationSec || 2) / 2));
      const p = await window.api.video.thumbnail(f.path, t);
      f.thumb = await window.api.fs.readImageDataUrl(p);
      renderBulk();
    } catch (e) { /* the row reads fine without a picture */ }
  }

  /**
   * Load one video from the batch into the editor.
   *
   * loadVideo() wipes the timeline — a new recording is a new project — so the
   * batch's picture is put back on afterwards. That is the whole trick: the
   * overlay you see is a real timeline block on THIS video, but the numbers
   * behind it belong to the batch.
   */
  async function openBulkVideo(i) {
    const f = ve.bulk.files[i]; if (!f) return;
    ve.bulk.sel = i;
    await loadVideo(f.path);
    applyBulkOverlays();
    renderBulk();
  }

  /** Put the batch's picture(s) onto the video that is loaded now. */
  function applyBulkOverlays() {
    if (!ve.video || !ve.bulk.overlays.length) return;
    // drop any from a previous video first, so switching clips cannot stack them
    ve.segments = ve.segments.filter((s) => !s.bulk);
    for (const o of ve.bulk.overlays) {
      /*
       * The stored placement is fractions of the frame, so it means the same
       * thing on every shape — but "the same fraction of the WIDTH" is a
       * different fraction of the HEIGHT on a 9:16 clip than on a 16:9 one. So
       * each video gets the placement FITTED to its own picture for display,
       * and `ve.bulk.overlays` is left alone: what the operator set stays set,
       * and merely LOOKING at another clip in the batch never edits it.
       */
      const f = pipFit(o.pipX, o.pipY, o.pipW, frameAR(), (o.width && o.height) ? o.width / o.height : 1);
      ve.segments.push({
        id: uid(), bulk: true, bulkId: o.id, lane: freeLaneFor(0, dur()),
        src: o.src, kind: 'image',
        srcInfo: { width: o.width, height: o.height, durationSec: 0, hasAudio: false },
        // A batch graphic is a watermark: it is on for the WHOLE video unless the
        // operator trims it, which is what "over all of them" has to mean.
        start: 0, end: dur(), tlStart: 0,
        label: o.name, color: '#0aa2c0', mute: true,
        pipX: f.x, pipY: f.y, pipW: f.w, opacity: o.opacity,
      });
    }
    ve.sel = ve.segments[ve.segments.length - 1].id;
    ve.activeRow = 'video';
    renderSegments();
    ve.segments.filter((s) => s.bulk).forEach(loadMediaThumb);
  }

  /** Copy a dragged/resized block's placement back onto the batch. */
  function syncBulkOverlayFrom(s) {
    if (!s || !s.bulk) return;
    const o = ve.bulk.overlays.find((x) => x.id === s.bulkId); if (!o) return;
    o.pipX = s.pipX; o.pipY = s.pipY; o.pipW = s.pipW;
    if (s.opacity != null) o.opacity = s.opacity;
    // A cut-out replaces the file with a transparent copy — the batch has to
    // follow, or Export All would burn the version with the background still on.
    if (s.src) { o.src = s.src; o.name = s.label || o.name; }
    renderBulk();
  }

  /** Pick the picture that goes over every video in the batch. */
  async function pickBulkImage() {
    if (!ve.bulk.files.length) {
      return window.__toast && window.__toast('Add some videos to the batch first — 📦 Bulk videos.', 'error');
    }
    let p = null;
    try { p = await window.api.dialog.openFile(BULK_IMAGE_FILTERS); } catch (e) { p = null; }
    if (!p) return;
    await addBulkImage(Array.isArray(p) ? p[0] : p);
  }

  /** Put a picture on the batch and show it on whatever is loaded. */
  async function addBulkImage(src) {
    if (!src) return null;
    if (!ve.bulk.files.length) {
      window.__toast && window.__toast('Add some videos to the batch first — 📦 Bulk videos.', 'error');
      return null;
    }
    let info = null;
    try { info = await window.api.video.info(src); } catch (e) { info = null; }
    if (!info || !info.width || !info.height) {
      window.__toast && window.__toast(`⚠️ Could not read “${String(src).split(/[\\/]/).pop()}” as a picture.`, 'error');
      return null;
    }
    /*
     * Born where a watermark belongs: the top-right of the WHOLE picture, a
     * fifth of its width.
     *
     * Deliberately NOT defaultPip(), which places things inside the 9:16 crop
     * window a short export will take — perfectly right for picture-in-picture
     * on a short, and wrong here, because a bulk export keeps each video's own
     * full frame. Borrowing it put the logo in the middle of a 16:9 service.
     */
    const w = 0.2;
    const o = {
      id: uid(), src, name: String(src).split(/[\\/]/).pop(),
      width: info.width, height: info.height,
      pipX: 1 - w - 0.04, pipY: 0.045, pipW: w, opacity: 1,
    };
    ve.bulk.overlays.push(o);
    applyBulkOverlays();
    renderBulk();
    window.__toast && window.__toast(
      '🖼 Drag the picture on the preview to place it and drag its corner to size it. Where you put it is where it lands on every video in the batch.', 'good', 8000);
    return o;
  }

  /** How solid the batch's picture is — shown on the preview at once, because a
   *  watermark you cannot see the strength of is a watermark you have to export
   *  to judge. */
  function setBulkOpacity(id, v) {
    const o = ve.bulk.overlays.find((x) => x.id === id); if (!o) return;
    o.opacity = clamp(Number(v) || 1, 0.05, 1);
    ve.segments.filter((s) => s.bulk && s.bulkId === id).forEach((s) => { s.opacity = o.opacity; });
    updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }

  function removeBulkOverlay(id) {
    ve.bulk.overlays = ve.bulk.overlays.filter((o) => o.id !== id);
    ve.segments = ve.segments.filter((s) => !(s.bulk && s.bulkId === id));
    renderSegments(); renderBulk();
  }
  function removeBulkVideo(i) {
    ve.bulk.files.splice(i, 1);
    if (ve.bulk.sel >= ve.bulk.files.length) ve.bulk.sel = Math.max(0, ve.bulk.files.length - 1);
    renderBulk();
  }
  function clearBulk() {
    ve.bulk = { files: [], overlays: [], sel: 0 };
    ve.segments = ve.segments.filter((s) => !s.bulk);
    renderSegments(); renderBulk();
    updateCropMask();   // the export-frame matte comes back
  }

  /** The batch panel. */
  function renderBulk() {
    const box = $('#veBulkBox'); if (!box) return;
    const n = ve.bulk.files.length;
    box.classList.toggle('hidden', n === 0);
    if (!n) return;
    const cnt = $('#veBulkCount'); if (cnt) cnt.textContent = `(${n})`;
    const list = $('#veBulkList');
    if (list) {
      list.innerHTML = ve.bulk.files.map((f, i) => `
        <div class="ve-bulk-item${i === ve.bulk.sel ? ' sel' : ''}" data-bulk="${i}" title="${attr2(f.path)}">
          <span class="ve-bulk-thumb"${f.thumb ? ` style="background-image:url('${f.thumb}')"` : ''}></span>
          <span class="ve-bulk-name">${escape2(f.name)}<br><span class="ve-bulk-meta">${f.info.width}×${f.info.height} · ${fmtDur(f.info.durationSec)}</span></span>
          <button class="icon-btn ve-bulk-drop" data-bulkdel="${i}" title="Take this video out of the batch">🗑</button>
        </div>`).join('');
      $$('[data-bulk]', list).forEach((el) => el.addEventListener('click', (e) => {
        if (e.target.closest('[data-bulkdel]')) return;
        openBulkVideo(parseInt(el.dataset.bulk, 10));
      }));
      $$('[data-bulkdel]', list).forEach((b) => b.addEventListener('click', (e) => {
        e.stopPropagation(); removeBulkVideo(parseInt(b.dataset.bulkdel, 10));
      }));
    }
    const ovl = $('#veBulkOverlays');
    if (ovl) {
      ovl.innerHTML = ve.bulk.overlays.map((o) => `
        <div class="ve-bulk-ovl" title="${attr2(o.src)}">
          <img src="${attr2(fileUrl(o.src))}" alt="" />
          <span class="ve-bulk-ovl-name">${escape2(o.name)}<br><span class="ve-bulk-meta">${Math.round(o.pipW * 100)}% wide · x ${Math.round(o.pipX * 100)}% y ${Math.round(o.pipY * 100)}%</span></span>
          <label class="ve-bulk-op" title="How solid the picture is. A faint watermark still reads without covering the sermon.">
            <input type="range" data-bulkop="${o.id}" min="10" max="100" step="5" value="${Math.round((o.opacity != null ? o.opacity : 1) * 100)}" />
          </label>
          <button class="icon-btn" data-bulkovldel="${o.id}" title="Take this picture off every video">🗑</button>
        </div>`).join('');
      $$('[data-bulkovldel]', ovl).forEach((b) => b.addEventListener('click', () => removeBulkOverlay(b.dataset.bulkovldel)));
      $$('[data-bulkop]', ovl).forEach((r) => r.addEventListener('input', () => setBulkOpacity(r.dataset.bulkop, (parseInt(r.value, 10) || 100) / 100)));
    }
    const hint = $('#veBulkHint');
    if (hint) {
      hint.innerHTML = ve.bulk.overlays.length
        ? 'Drag the picture on the preview to place it — that is where it lands on <b>every</b> video below.'
        : 'Pick a video below to see it, then <b>🖼 Image over all</b> to put a logo or graphic on top of the whole batch.';
    }
    const exp = $('#veBulkExport');
    if (exp) {
      exp.disabled = !ve.bulk.overlays.length;
      exp.textContent = `⬇️ Export all ${n}`;
      exp.title = ve.bulk.overlays.length
        ? `Write out all ${n} videos with the ${ve.bulk.overlays.length > 1 ? 'pictures' : 'picture'} burned in, each at its own size and quality.`
        : 'Add a picture first — 🖼 Image over all.';
    }
  }

  /**
   * Write out every video in the batch with the batch's picture(s) burned in.
   *
   * Each one is composited at its OWN size and frame rate — a bulk run must not
   * quietly re-shape a 4K landscape service into somebody else's preset — and the
   * output is named after its source, because "overlay-3.mp4" ten times over is
   * not a result anybody can use.
   */
  async function exportBulk() {
    if (!ve.bulk.files.length || !ve.bulk.overlays.length) return;
    const files = ve.bulk.files.slice();
    const done = [], failed = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (window.__setJobBatch) window.__setJobBatch(i + 1, files.length);
      const jobId = window.__newJobId();
      try {
        const out = await window.__runJob(`🖼 Putting the picture on “${f.name}”…`, jobId,
          () => window.api.video.overlayComposite({
            base: f.path,
            overlays: bulkOverlayPayload(f),
            jobId,
            outName: outNameFor(f.path) + '-logo',
          }));
        done.push(out);
      } catch (e) {
        if (e && e.cancelled) break;   // the operator stopped the run
        failed.push(f.name);
      }
    }
    if (window.__setJobBatch) window.__setJobBatch(null);
    if (done.length) {
      window.__toast && window.__toast(
        `✅ ${done.length} video${done.length > 1 ? 's' : ''} written with the picture on`
        + (failed.length ? ` — ${failed.join(', ')} failed.` : '.'), 'good', 8000);
      window.finishedFile(done[done.length - 1]);
    } else if (failed.length) {
      window.__toast && window.__toast(`⚠️ None of the batch could be written (${failed.join(', ')}).`, 'error', 8000);
    }
  }

  /**
   * The batch's picture(s) as the compositor wants them, for ONE video.
   * A still is held for that video's whole length, so a 40-second clip and a
   * 40-minute service each keep the logo from first frame to last.
   */
  function bulkOverlayPayload(f) {
    const len = Math.max(0.3, (f.info && f.info.durationSec) || 1);
    // a batch keeps each video's whole picture, so its frame IS its own shape
    const vAR = (f.info && f.info.height) ? f.info.width / f.info.height : 16 / 9;
    return ve.bulk.overlays.map((o) => {
      // Fitted to THIS video's shape — the same sum applyBulkOverlays does for
      // the preview, so what was on screen for this clip is what is composited
      // into it. A graphic that would hang off the bottom of a wide frame is
      // brought back on rather than exported invisible.
      const p = pipFit(o.pipX, o.pipY, o.pipW, vAR, (o.width && o.height) ? o.width / o.height : 1);
      return {
        src: o.src, still: true, mute: true,
        srcStart: 0, srcEnd: len, tlStart: 0,
        x: p.x, y: p.y, wFrac: p.w,
        opacity: o.opacity != null ? o.opacity : 1,
      };
    });
  }

  async function pickMediaOverlays() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first, then add media on top of it.', 'error');
    let paths = null;
    try { paths = await window.api.dialog.openFile(MEDIA_FILTERS, true); } catch (e) { paths = null; }
    if (!paths) return;
    await addMediaOverlays(Array.isArray(paths) ? paths : [paths]);
  }

  /**
   * Put files on the overlay lane. `atSec` is where the FIRST one starts (the
   * playhead by default); the rest queue up behind it so dropping five photos
   * gives five blocks in a row rather than five stacked on the same instant.
   */
  /** The lowest overlay row with nothing on it between `a` and `b`. */
  function freeLaneFor(a, b) {
    for (let L = 1; L <= MAX_OVERLAY_LANES; L++) {
      const clash = ve.segments.some((x) => (x.lane || 0) === L
        && tlPos(x) < b - 0.01 && (tlPos(x) + (x.end - x.start)) > a + 0.01);
      if (!clash) return L;
    }
    return MAX_OVERLAY_LANES;
  }

  async function addMediaOverlays(paths, atSec) {
    if (!ve.video) return window.__toast && window.__toast('Open a video first, then add media on top of it.', 'error');
    const list = (paths || []).filter(Boolean);
    if (!list.length) return;
    let t = clamp(atSec != null ? atSec : (ve.refs.player.currentTime || 0), 0, Math.max(0, dur() - 0.2));
    const added = [], failed = [];
    const pre = snapshotState();
    for (const p of list) {
      const image = isImgPath(p);
      let info = null;
      try { info = await window.api.video.info(p); } catch (e) { info = null; }
      // ffprobe finds no picture in it — a .txt renamed, a corrupt download, an
      // audio file. Say which one rather than dropping a block that shows black.
      if (!info || !info.width || !info.height) { failed.push(p.split(/[\\/]/).pop()); continue; }
      const len = image
        ? IMAGE_DEFAULT_SEC
        : clamp(info.durationSec || IMAGE_DEFAULT_SEC, 0.5, Math.max(0.5, dur()));
      const s = {
        id: uid(), lane: freeLaneFor(t, t + len),
        src: p, kind: image ? 'image' : 'video',
        srcInfo: { width: info.width, height: info.height, durationSec: image ? 0 : (info.durationSec || 0), hasAudio: !!info.hasAudio },
        start: 0, end: len,
        tlStart: clamp(t, 0, Math.max(0, dur() - 0.2)),
        label: p.split(/[\\/]/).pop(),
        color: image ? '#0aa2c0' : '#a371f7',
        // A picture has no sound; a second video keeps its own, which is what
        // every editor does and what "overlay the testimony clip" means.
        mute: image ? true : false,
        ...defaultPip(info.width / info.height),
      };
      ve.segments.push(s);
      added.push(s);
      // Several files at once go on their own ROWS at the same moment rather than
      // one after another — that is what "two overlays at the same time" means.
      // Only once the rows run out do they start queueing.
      if (s.lane >= MAX_OVERLAY_LANES) t = Math.min(Math.max(0, dur() - 0.2), t + len);
    }
    if (!added.length) {
      return window.__toast && window.__toast(`⚠️ Could not read ${failed.join(', ')} — that isn't a video or a picture this can open.`, 'error', 7000);
    }
    commitDragHistory(pre);   // one undo step for the whole batch
    ve.sel = added[added.length - 1].id; ve.activeRow = 'video'; ve.audioSel = null;
    renderSegments();
    added.forEach(loadMediaThumb);
    const what = added.length === 1
      ? (added[0].kind === 'image' ? `🖼 “${added[0].label}”` : `🎞 “${added[0].label}”`)
      : `${added.length} files`;
    window.__toast && window.__toast(
      `${what} added on top of the video — drag the block sideways to move it, its edges to change how long it shows, and the box on the preview to place it in the frame.`
      + (failed.length ? ` (Couldn't read ${failed.join(', ')}.)` : ''), 'good', 8000);
  }

  /** A small picture of the file, painted into its clip block. */
  async function loadMediaThumb(s) {
    if (!isMedia(s) || ve.mediaThumbs[s.src]) return;
    try {
      // Even a photo goes through ffmpeg: a 6000px phone snap read straight off
      // disk would become a multi-megabyte data URL sitting in a CSS background.
      const png = await window.api.video.thumbnail(s.src, s.kind === 'image' ? 0 : Math.min(1, (s.srcInfo.durationSec || 2) / 2));
      ve.mediaThumbs[s.src] = await window.api.fs.readImageDataUrl(png);
      renderSegments();
    } catch (e) { /* the block still shows its colour + name */ }
  }


  /**
   * Take the background out of an overlay picture.
   *
   * The same cut-out the Flyer editor uses: the person segmenter first, and a
   * flood-fill from the edges when there is no person in the shot (a logo, a
   * graphic, a sponsor card) — which is the common case for something laid over
   * a sermon. The result is written to a real PNG so the timeline, the preview
   * and the exporter all treat it like any other file, and the ORIGINAL is kept
   * on the clip so this can be undone.
   */
  async function cutOutOverlayBackground(id) {
    const s = ve.segments.find((x) => x.id === (id || ve.sel));
    if (!s || !isMedia(s) || s.kind !== 'image') {
      return window.__toast && window.__toast('Select a picture on an overlay row first — this takes the background out of a picture.', 'error');
    }
    // Editing an already-cut picture starts from the ORIGINAL, or every pass
    // would cut a cut-out and the strength dial could never give anything back.
    const hadCut = !!s.cutOut;
    if (hadCut && s.cutOutFrom) s.src = s.cutOutFrom;
    if (!window.CutOut || !window.FlyerAI) {
      return window.__toast && window.__toast('The cut-out tool is not available.', 'error');
    }
    /*
     * The EDITOR, not a one-press guess.
     *
     * Automatic removal is right about half the time; the rest of the time it
     * takes an arm off or leaves a halo, and a single button offers nothing to
     * do about it but undo. The dialog owns the strength dial and the erase /
     * bring-back brushes; this only hands it the file and takes the finished
     * PNG back. See cutout.js.
     */
    try {
      const dataUrl = await window.api.fs.readImageDataUrl(s.src);
      window.CutOut.open(dataUrl, async (png) => {
        try {
          const outPath = await window.api.fs.writeImageDataUrl(png, (s.label || 'cutout').replace(/\.[^.]+$/, '') + '-cutout');
          pushHistory();
          // Keep the ORIGINAL, so this can be undone and so re-opening the
          // editor always starts from the untouched picture rather than from a
          // cut-out of a cut-out.
          if (!s.cutOutFrom) s.cutOutFrom = s.src;
          s.src = outPath;
          s.cutOut = true;
          s.kind = 'image';
          delete ve.mediaThumbs[outPath];
          renderSegments(); renderMediaLayer(); loadMediaThumb(s);
          // A cut-out swaps the file for a transparent copy. If this is the
          // batch's graphic, the batch has to follow — otherwise Export All
          // would burn the version that still has its background on.
          syncBulkOverlayFrom(s);
          window.__toast && window.__toast('🪄 Background removed. Press the button again to adjust it, or to put the background back.', 'good', 7000);
        } catch (e) {
          window.__toast && window.__toast('⚠️ Could not save the cut-out: ' + (e.message || e), 'error');
        }
      }, {
        // Only offered once there is something to undo.
        onRestore: hadCut ? () => {
          pushHistory();
          s.src = s.cutOutFrom || s.src;
          s.cutOut = false;
          delete ve.mediaThumbs[s.src];
          renderSegments(); renderMediaLayer(); loadMediaThumb(s);
          syncBulkOverlayFrom(s);
          window.__toast && window.__toast('↩ Background put back.', 'good');
        } : null,
      });
    } catch (e) {
      window.__toast && window.__toast('⚠️ Could not read that picture: ' + (e.message || e), 'error');
    }
  }

  /** Sound on/off for an added VIDEO overlay (a picture has none to begin with). */
  function toggleOverlaySound(id) {
    const s = ve.segments.find((x) => x.id === (id || ve.sel));
    if (!s || !isMedia(s) || s.kind !== 'video') return;
    if (!(s.srcInfo && s.srcInfo.hasAudio)) {
      return window.__toast && window.__toast(`“${s.label}” has no sound track of its own.`, 'error');
    }
    pushHistory();
    s.mute = !s.mute;
    renderSegments();
    updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    window.__toast && window.__toast(s.mute
      ? `🔇 “${s.label}” now plays silently over the video.`
      : `🔊 “${s.label}” now brings its own sound, mixed under the video.`, 'good');
  }

  /** The 🔊/🔇 button only means anything while an added video is selected. */
  function updateOverlayTools() {
    updateCutOutButton();
    const kb = $('#veChromaKey');
    if (kb) {
      const sk = ve.segments.find((x) => x.id === ve.sel);
      const showK = !!(sk && isMedia(sk));
      kb.classList.toggle('hidden', !showK);
      kb.classList.toggle('on', showK && keyOn(sk));
    }
    const b = $('#veOvSound'); if (!b) return;
    const s = ve.segments.find((x) => x.id === ve.sel);
    const show = !!(s && isMedia(s) && s.kind === 'video' && s.srcInfo && s.srcInfo.hasAudio);
    b.classList.toggle('hidden', !show);
    if (!show) return;
    putText(b, s.mute ? '🔇 Sound off' : '🔊 Sound on');
    b.classList.toggle('on', !s.mute);
    b.title = s.mute
      ? `“${s.label}” plays silently. Click to bring its sound in, mixed under the video.`
      : `“${s.label}” brings its own sound, mixed under the video. Click to silence it.`;
  }

  /** 🪄 Cut out background — only a picture on an overlay row can have one. */
  function updateCutOutButton() {
    const b = $('#veCutOut'); if (!b) return;
    const s = ve.segments.find((x) => x.id === ve.sel);
    const show = !!(s && isMedia(s) && s.kind === 'image');
    b.classList.toggle('hidden', !show);
    if (!show) return;
    putText(b, s.cutOut ? '🪄 Edit cut-out' : '🪄 Cut out background');
    b.classList.toggle('on', !!s.cutOut);
  }

  /* ---------------- added media ON THE PREVIEW (what you see is what exports) ----
   *
   * The pink guide box says WHERE the overlay lands; this puts the actual picture
   * or footage inside it, at the right size, for exactly the stretch of timeline
   * it covers. Without it the operator is placing an empty rectangle and finding
   * out what it looks like only after an export.
   *
   * Overlay <video> elements are driven from the main player rather than left to
   * run free: they are seeked when the difference grows past a quarter second,
   * and play/pause follows the preview, so scrubbing shows the right frame.
   */
  function renderMediaLayer() {
    const layer = ve.refs.mediaLayer; if (!layer) return;
    const items = overlayClips().filter(isMedia);
    const seen = new Set();
    for (const s of items) {
      seen.add(String(s.id));
      let n = layer.querySelector(`[data-mid="${s.id}"]`);
      const want = s.kind === 'image' ? 'IMG' : 'VIDEO';
      if (n && (n.tagName !== want || n.dataset.msrc !== s.src)) { n.remove(); n = null; }
      if (!n) {
        n = document.createElement(s.kind === 'image' ? 'img' : 'video');
        n.className = 've-media-el';
        n.dataset.mid = String(s.id); n.dataset.msrc = s.src;
        if (want === 'VIDEO') { n.playsInline = true; n.preload = 'auto'; n.muted = true; }
        n.src = fileUrl(s.src);
        layer.appendChild(n);
      }
    }
    Array.from(layer.children).forEach((n) => { if (!seen.has(n.dataset.mid || n.dataset.keyFor)) n.remove(); });
    updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }

  function updateMediaLayer(t) {
    const layer = ve.refs.mediaLayer; if (!layer || !ve.video) return;
    if (!layer.children.length) return;
    const playing = ve.refs.player && !ve.refs.player.paused;
    for (const n of Array.from(layer.children)) {
      if (n.dataset.keyFor) continue;              // a key canvas — drawn with its source below
      const s = ve.segments.find((x) => String(x.id) === n.dataset.mid);
      if (!s) { if (n._keyCv) n._keyCv.remove(); n.remove(); continue; }
      const a = tlPos(s), b = a + (s.end - s.start);
      const on = t >= a && t < b;
      n.style.display = on ? 'block' : 'none';
      if (n._keyCv) n._keyCv.style.display = on ? 'block' : 'none';
      if (!on) { if (n.tagName === 'VIDEO' && !n.paused) n.pause(); continue; }
      const r = overlayPreviewRect(s);   // the SAME box the pink guide draws
      n.style.left = Math.round(r.left) + 'px';
      n.style.top = Math.round(r.top) + 'px';
      n.style.width = Math.round(r.w) + 'px';
      n.style.height = Math.round(r.h) + 'px';
      // Row order is stacking order here too, so what you see is what exports.
      n.style.zIndex = String(s.lane || 1);
      // …and so is how faint it is. The compositor has always honoured opacity;
      // the preview did not, so a watermark dialled down to a third still looked
      // solid right up until the file came out.
      n.style.opacity = s.opacity != null ? String(clamp(s.opacity, 0.05, 1)) : '';
      // green screen: drawn through the key, as the export will (see drawKeyed)
      if (keyOn(s)) drawKeyed(n, s, r); else hideKeyed(n);
      if (n.tagName !== 'VIDEO') continue;
      const want = s.start + (t - a);
      if (Math.abs((n.currentTime || 0) - want) > 0.25) { try { n.currentTime = want; } catch (e) { /* not seekable yet */ } }
      n.muted = !!s.mute;
      if (playing && n.paused) { const pr = n.play(); if (pr && pr.catch) pr.catch(() => {}); }
      else if (!playing && !n.paused) n.pause();
    }
  }

  /* ---------------- text-on-video overlays ----------------
   *
   * HOW AN ADDED TEXT LOOKS, IN ONE PLACE.
   *
   * The preview draws it and the export rasteriser draws it, and the only reason
   * the two agree is that both ask this one function. Anything that computes a
   * colour, a weight or a stroke of its own has already started drifting — which
   * is exactly how the captions ended up wrapping differently on screen and in
   * the file.
   *
   * `fontPx` is the size in whatever pixels the caller is working in, and `k`
   * scales the few lengths that are NOT tied to the font (the drop shadow), so
   * the export at six times the size is the same picture rather than the same
   * numbers.
   */
  /** The outward black edge, as a share of the font size. */
  const TEXT_OUTLINE = 0.08;
  /* The font size is a fraction of the EXPORT FRAME's height — not of the preview
   * panel, and not rounded to whole pixels. Both of those made the same text a
   * different size in the small preview, the big one and full screen. */
  const textFontPx = (o, frameH) => Math.max(1, (o.sizePct || 0.11) * frameH);
  /** The backing panel's fill: the chosen colour, or the original translucent
   *  black when none was chosen. Shared by the preview, the rasteriser and the
   *  payload sent to the subtitle burner, so all three paint the same panel. */
  function bgFill(o) {
    const c = String((o && o.bgColor) || '');
    return /^#[0-9a-fA-F]{6}$/.test(c) ? c : 'rgba(0,0,0,.72)';
  }
  function textLookCss(o, fontPx) {
    const px = (v) => (Math.round(v * 1000) / 1000) + 'px';
    const col = (c, d) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c || '')) ? String(c) : d);
    const fam = String(o.font || 'Arial').replace(/['"\\;{}<>]/g, '');
    let s = `font-size:${px(fontPx)};color:${col(o.color, '#ffffff')};font-weight:${o.bold ? 800 : 400};`
      + `font-family:'${fam}',sans-serif;width:100%;text-align:center;line-height:1.2;`
      // …including the drop shadow. A fixed 2px/8px shadow is enormous under a
      // 20-pixel preview and invisible under a 130-pixel export of the same text.
      + `text-shadow:0 ${px(fontPx * 0.06)} ${px(fontPx * 0.235)} rgba(0,0,0,.8);`
      // Wrapping stated the same way on both sides. It used to be `pre-wrap` in
      // the rasteriser and the browser's default on the preview, which is a
      // difference waiting to show up on a line with two spaces in it.
      + 'white-space:pre-wrap;word-break:break-word;';
    if (o.outline) {
      /*
       * A CSS text stroke is CENTRED on the glyph's edge — half of it eats into
       * the letter. `paint-order: stroke fill` paints the fill back over that
       * inner half, so a stroke of 2x reads as exactly TEXT_OUTLINE outside.
       * Same rule the captions use, and the same weight libass draws for the
       * subtitle fallback.
       */
      s += `-webkit-text-stroke:${px(fontPx * TEXT_OUTLINE * 2)} ${col(o.outlineColor, '#000000')};paint-order:stroke fill;`;
    }
    if (o.bg) {
      // The panel used to be black at 72%, full stop. A name banner is a WHITE
      // panel with black words, and there was no way to ask for one — so the
      // colour is the operator's, and black-at-72% is only what they get when
      // they have not said otherwise.
      s += 'background:' + bgFill(o) + ';padding:0.1em 0.35em;border-radius:0.14em;'
        + 'box-decoration-break:clone;-webkit-box-decoration-break:clone;';
      // A name banner fits its words: the panel shrinks to the text and sits in
      // the middle of the box, instead of running the box's whole width.
      if (o.hug) s += 'display:table;width:auto;max-width:100%;margin:0 auto;';
    }
    return s;
  }

  function addTextOverlay() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    pushHistory();
    const t = ve.refs.player.currentTime || 0;
    // Born at the TOP centre of the frame, not the middle: text on a sermon short
    // is a title/hook above the speaker almost every time, and the middle sits
    // right over their face. Drag it anywhere from there.
    const ov = {
      id: uid(), text: 'Your text', x: 0.5, y: 0.16, w: 0.86, h: 0.12, // w = 86% of the export frame
      start: Math.max(0, t - 2.5), end: Math.min(dur(), Math.max(t + 2.5, t + 5)), color: '#ffffff', sizePct: 0.11, font: 'Arial', bold: true,
      // Outlined from birth. White words over a sermon are white words over a
      // white shirt half the time, and the drop shadow alone does not carry them;
      // a black edge is what makes text READ on video. One click turns it off.
      outline: true, outlineColor: '#000000',
    };
    clampTextIntoFrame(ov); // born inside the export frame (matters when auto-reframe is on)
    ve.textOverlays.push(ov); ve.textSel = ov.id;
    renderTextOverlays(); renderTextTrack();
    // Guard the freshly-made box NOW so a re-render (e.g. a playing video's
    // timeupdate → renderTextOverlays) can't replace it in the gap before we
    // start editing — that race is what made typing impossible. Focus is deferred
    // past the button click; startEditingText re-queries the box by id.
    ve.textEditing = ov.id;
    setTimeout(() => startEditingText(ov.id), 0);
  }
  function renderTextOverlays() {
    const layer = ve.refs.textLayer; if (!layer) return;
    if (ve.textEditing) return; // don't clobber the contenteditable box mid-typing
    const t = ve.refs.player.currentTime || 0;
    const visible = ve.video ? ve.textOverlays.filter((o) => t >= o.start && t <= o.end) : [];
    // Font size must be COMPUTED IN PIXELS from the preview's height. A CSS
    // percentage font-size is relative to the PARENT'S font size (~14px), so the
    // old `${sizePct*100}%` rendered ~1px-tall, invisible text — the user saw an
    // empty box with handles and typing "did nothing". (Same math as captions.)
    const fr = outputFrameRect();
    // A text box's width is a fraction of the EXPORT FRAME, not of the preview
    // panel: the frame is what gets exported, so the words break onto the same
    // lines here and in the file. (When they were a fraction of the panel, a
    // 9:16 frame inside a wide preview gave the box 2-3× the room it really has
    // — text that read fine on screen came out clipped.)
    // The layer is CLIPPED to the frame: anything the export cannot show must not
    // look placed in the preview either.
    const g = ve.video ? textExportGeom() : null;
    layer.style.clipPath = g
      ? `inset(${Math.max(0, g.fr.top).toFixed(1)}px ${Math.max(0, g.cw - g.fr.left - g.fr.w).toFixed(1)}px ${Math.max(0, g.chh - g.fr.top - g.fr.h).toFixed(1)}px ${Math.max(0, g.fr.left).toFixed(1)}px)`
      : '';
    // The box is CENTER-anchored on (o.x, o.y) and hugs the text vertically
    // (height:auto), so the words always sit INSIDE the dashed drag border —
    // no more text spilling below the lines when the font outgrows a fixed box.
    layer.innerHTML = visible.map((o) => `
      <div class="ve-text-box${ve.textSel === o.id ? ' sel' : ''}" data-id="${o.id}" style="
        left:${(fr.left + o.x * fr.w).toFixed(2)}px; top:${(fr.top + o.y * fr.h).toFixed(2)}px; width:${(o.w * fr.w).toFixed(2)}px; transform:translate(-50%,-50%);">
        <div class="ve-text-content" style="${textLookCss(o, textFontPx(o, fr.h))}${textAnimCss(o, t, fr.h)}pointer-events:auto;outline:none;">${escape2(o.text)}</div>
        <button class="ve-text-del" data-del="${o.id}" title="Delete">✕</button>
        <div class="ve-text-resize" data-resize="${o.id}" title="Drag to resize"></div>
      </div>`).join('');
    $$('.ve-text-box', layer).forEach((box) => {
      box.addEventListener('mousedown', (e) => onTextBoxDown(e, box));
      box.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); startEditingText(box); });
    });
    $$('[data-del]', layer).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); removeTextOverlay(b.dataset.del); }));
    updateTextTools();
  }
  /** Start editing a text box (accepts a box node OR an overlay id). Re-queries
   *  the box from the DOM so it never operates on a stale/detached node. */
  function startEditingText(boxOrId) {
    const id = (typeof boxOrId === 'string') ? boxOrId : (boxOrId && boxOrId.dataset ? boxOrId.dataset.id : null);
    const o = id && ve.textOverlays.find((x) => x.id === id); if (!o) return;
    ve.textSel = id;
    // Re-fetch the live box; if a prior render removed it, render once (with the
    // guard cleared) and fetch again.
    let box = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${id}"]`);
    if (!box) { ve.textEditing = null; renderTextOverlays(); box = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${id}"]`); }
    if (!box) return;
    ve.textEditing = id;
    updateTextTools();
    const content = box.querySelector('.ve-text-content');
    if (!content) return;
    content.setAttribute('contenteditable', 'true');
    content.style.pointerEvents = 'auto';
    content.style.cursor = 'text';
    // The parent .ve-text-box sets `user-select:none` (so dragging doesn't select
    // text); that is INHERITED by this contenteditable and, in Chromium, blocks
    // the caret + typing entirely. Force selectable text on the editable node.
    content.style.userSelect = 'text';
    content.style.webkitUserSelect = 'text';
    // Focus AFTER styles are applied so the caret actually lands.
    content.focus();
    // Place the caret / select all so the user can immediately overwrite "Your text".
    try {
      const range = document.createRange();
      range.selectNodeContents(content);
      const selN = window.getSelection();
      selN.removeAllRanges(); selN.addRange(range);
    } catch (e) { /* selection is best-effort */ }
    const commit = () => {
      o.text = content.innerText.replace(/\n+$/, '') || 'Text';
      content.removeEventListener('blur', commit);
      ve.textEditing = null;
      // More words = more lines = a taller box: re-fit it inside the export
      // frame, otherwise the text you just typed can hang off the picture.
      clampTextIntoFrame(o);
      renderTextOverlays(); renderTextTrack();
    };
    content.addEventListener('blur', commit);
    content.addEventListener('keydown', (k) => {
      if (k.key === 'Enter' && !k.shiftKey) { k.preventDefault(); content.blur(); }
      if (k.key === 'Escape') { k.preventDefault(); content.blur(); }
      k.stopPropagation(); // don't trigger timeline keyboard shortcuts (Delete, S, etc.) while typing
    });
  }
  function removeTextOverlay(id) {
    pushHistory();
    ve.textOverlays = ve.textOverlays.filter((o) => o.id !== id);
    if (ve.textSel === id) { ve.textSel = null; ve.textEditing = null; }
    renderTextOverlays(); renderTextTrack(); updateTextTools();
  }

  /* ---------------- chroma key: green screen on an added video or picture ----
   * The same sum ffmpeg's chromakey does (CCIR chroma of each pixel against the
   * key colour, distance through `sim`, softened over `blend`), done on a small
   * canvas over the preview, so what is see-through here is see-through in the
   * file. The export runs the real filter (video.exportOverlayComposite).
   */
  const KEY_DEFAULT = { on: true, color: '#00b140', sim: 0.12, blend: 0.08 };
  const keyOn = (s) => !!(s && s.key && s.key.on);
  /* ffmpeg reads the KEY colour with full-range BT.601 sums and each PIXEL as
   * the TV-range video it has been turned into — two different scales, and the
   * preview has to use both or it keys a different amount than the file does
   * (measured: white over a green key came out a third see-through in one and
   * two-thirds in the other). */
  const keyUVFull = (r, g, b) => [
    128 + (-0.16874 * r - 0.33126 * g + 0.5 * b),
    128 + (0.5 * r - 0.41869 * g - 0.08131 * b),
  ];
  const keyUV = (r, g, b) => [
    128 + (-0.16874 * r - 0.33126 * g + 0.5 * b) * (224 / 255),
    128 + (0.5 * r - 0.41869 * g - 0.08131 * b) * (224 / 255),
  ];
  const hexRgb = (h) => { const n = parseInt(String(h || '#00ff00').slice(1), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  /** Alpha (0..1) a pixel keeps — ffmpeg chromakey's rule. */
  function keyAlpha(r, g, b, kuv, sim, blend) {
    const [u, v] = keyUV(r, g, b);
    const du = u - kuv[0], dv = v - kuv[1];
    const diff = Math.sqrt((du * du + dv * dv) / (255 * 255 * 2));
    if (blend > 0.0001) return clamp((diff - sim) / blend, 0, 1);
    return diff > sim ? 1 : 0;
  }
  /** Draw a keyed media element through its canvas (made on first use). */
  function drawKeyed(n, s, r) {
    // A paused overlay gets its new frame only once its OWN seek finishes —
    // after this draw has already happened — so it redraws itself then.
    if (!n._keyHook) {
      n._keyHook = true;
      const again = () => {
        const s2 = ve.segments.find((x) => String(x.id) === n.dataset.mid);
        if (s2 && keyOn(s2) && n.style.display !== 'none') drawKeyed(n, s2, { w: parseFloat(n.style.width) || r.w, h: parseFloat(n.style.height) || r.h });
      };
      ['seeked', 'loadeddata'].forEach((ev) => n.addEventListener(ev, again));
      if (n.tagName === 'IMG') n.addEventListener('load', again);
    }
    let c = n._keyCv;
    if (!c || !c.isConnected) {
      c = document.createElement('canvas');
      c.className = 've-media-el ve-media-key';
      c.dataset.keyFor = n.dataset.mid;
      n.parentNode.insertBefore(c, n.nextSibling);
      n._keyCv = c;
    }
    c.style.display = 'block';
    c.style.left = n.style.left; c.style.top = n.style.top;
    c.style.width = n.style.width; c.style.height = n.style.height;
    c.style.zIndex = n.style.zIndex; c.style.opacity = n.style.opacity;
    // the source keeps playing (so it has frames to give) but is not seen
    n.style.visibility = 'hidden';
    const w = Math.max(2, Math.min(360, Math.round(r.w))), h = Math.max(2, Math.round((r.h / Math.max(1, r.w)) * w));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d', { willReadFrequently: true });
    try {
      g.clearRect(0, 0, w, h);
      g.drawImage(n, 0, 0, w, h);
      const img = g.getImageData(0, 0, w, h), d = img.data;
      const k = s.key, kuv = keyUVFull(...hexRgb(k.color));
      const sim = clamp(Number(k.sim) || 0, 0, 1), blend = clamp(Number(k.blend) || 0, 0, 1);
      for (let i = 0; i < d.length; i += 4) {
        if (!d[i + 3]) continue;
        d[i + 3] = Math.round(d[i + 3] * keyAlpha(d[i], d[i + 1], d[i + 2], kuv, sim, blend));
      }
      g.putImageData(img, 0, 0);
    } catch (e) { /* a frame not decoded yet — the next tick draws it */ }
  }
  function hideKeyed(n) {
    if (n._keyCv) { n._keyCv.remove(); n._keyCv = null; }
    if (n.style.visibility === 'hidden') n.style.visibility = '';
  }

  /* ---- the Chroma key panel ---- */
  let keyFor = null;
  const keySeg = () => ve.segments.find((s) => s.id === keyFor) || null;
  function keyModal() {
    let m = document.getElementById('veKeyModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veKeyModal';
    m.className = 'cap-modal ve-key-modal hidden';
    m.innerHTML = `
      <div class="cap-box ve-key-box">
        <div class="cap-head"><strong>Chroma key</strong> <span class="muted small" data-key-clip></span><button type="button" class="ghost-btn small" data-key-close>✕</button></div>
        <label class="ve-key-on"><input type="checkbox" data-key-on> Remove a colour (green screen)</label>
        <div class="ve-key-swatches">
          <button type="button" class="ve-key-sw" data-key-color="#00b140" style="--sw:#00b140" title="Green screen"><i></i>Green</button>
          <button type="button" class="ve-key-sw" data-key-color="#0047bb" style="--sw:#0047bb" title="Blue screen"><i></i>Blue</button>
          <button type="button" class="ve-key-sw" data-key-pick title="Take the colour from the picture's corners — where the screen is"><i class="pick"></i>From picture</button>
          <label class="ve-key-sw" title="Any colour"><input type="color" data-key-custom value="#00b140"><span>Custom</span></label>
        </div>
        <div class="ve-kf-row"><label>Strength</label><input type="range" min="1" max="60" step="1" data-key-sim><span data-key-simv></span></div>
        <div class="ve-kf-row"><label>Soft edge</label><input type="range" min="0" max="30" step="1" data-key-blend><span data-key-blendv></span></div>
        <div class="ve-trans-foot"><span class="muted small">Raise Strength until the screen is gone; soften the edge if hair looks cut out.</span><button type="button" class="primary-btn" data-key-close>Done</button></div>
      </div>`;
    document.body.appendChild(m);
    const pre = () => { if (!m._pre) m._pre = snapshotState(); };
    const done = () => { if (m._pre) { commitDragHistory(m._pre); m._pre = null; } };
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-key-close]')) return closeChromaKey();
      const sw = e.target.closest('[data-key-color]');
      if (sw) return setChromaKey(keyFor, { on: true, color: sw.dataset.keyColor });
      if (e.target.closest('[data-key-pick]')) return pickKeyColor(keyFor);
    });
    m.querySelector('[data-key-on]').addEventListener('change', (e) => setChromaKey(keyFor, { on: e.target.checked }));
    m.querySelector('[data-key-custom]').addEventListener('change', (e) => setChromaKey(keyFor, { on: true, color: e.target.value }));
    [['[data-key-sim]', 'sim'], ['[data-key-blend]', 'blend']].forEach(([sel, k]) => {
      const r = m.querySelector(sel);
      r.addEventListener('pointerdown', pre);
      r.addEventListener('input', () => setChromaKey(keyFor, { [k]: +r.value / 100 }, true));
      r.addEventListener('change', done);
    });
    return m;
  }
  /** The overlay the panel is for: the selected one, else one under the playhead. */
  function keyTarget() {
    const t = ve.refs.player ? ve.refs.player.currentTime || 0 : 0;
    const sel = ve.segments.find((s) => s.id === ve.sel);
    if (sel && isMedia(sel)) return sel;
    return overlayClips().filter(isMedia).find((s) => t >= tlPos(s) && t < tlPos(s) + (s.end - s.start))
      || overlayClips().filter(isMedia)[0] || null;
  }
  function openChromaKey(segId) {
    const s = (segId && ve.segments.find((x) => x.id === segId)) || keyTarget();
    if (!s || !isMedia(s)) {
      window.__toast && window.__toast('Add a video or picture on top first (Overlay → Add media), then key out its green screen.', 'error');
      return false;
    }
    keyFor = s.id;
    if (ve.sel !== s.id) selectSeg(s.id);
    // Opening it is asking for it: switch it on with a green screen to start from.
    if (!s.key) setChromaKey(s.id, Object.assign({}, KEY_DEFAULT));
    keyModal().classList.remove('hidden');
    syncChromaKeyPanel();
    return true;
  }
  function closeChromaKey() {
    const m = document.getElementById('veKeyModal'); if (m) m.classList.add('hidden');
    keyFor = null;
  }
  function syncChromaKeyPanel() {
    const m = document.getElementById('veKeyModal'); const s = keySeg();
    if (!m || !s) return;
    const k = s.key || Object.assign({}, KEY_DEFAULT, { on: false });
    m.querySelector('[data-key-clip]').textContent = `— ${s.label}`;
    m.querySelector('[data-key-on]').checked = !!k.on;
    m.querySelectorAll('[data-key-color]').forEach((b) => b.classList.toggle('on', !!k.on && b.dataset.keyColor.toLowerCase() === String(k.color).toLowerCase()));
    const cu = m.querySelector('[data-key-custom]'); if (cu) cu.value = /^#[0-9a-f]{6}$/i.test(k.color) ? k.color : '#00b140';
    const sim = m.querySelector('[data-key-sim]'), bl = m.querySelector('[data-key-blend]');
    if (document.activeElement !== sim) sim.value = String(Math.round(k.sim * 100));
    if (document.activeElement !== bl) bl.value = String(Math.round(k.blend * 100));
    m.querySelector('[data-key-simv]').textContent = Math.round(k.sim * 100) + '';
    m.querySelector('[data-key-blendv]').textContent = Math.round(k.blend * 100) + '';
    m.classList.toggle('keyoff', !k.on);
  }
  /** Change the key on an overlay. One undo step unless `live` (a slider mid-drag). */
  function setChromaKey(segId, patch, live) {
    const s = ve.segments.find((x) => x.id === segId); if (!s) return null;
    if (!live) pushHistory();
    const k = Object.assign({}, KEY_DEFAULT, s.key || { on: false }, patch || {});
    k.sim = clamp(Number(k.sim) || 0, 0.01, 0.6);
    k.blend = clamp(Number(k.blend) || 0, 0, 0.3);
    if (!/^#[0-9a-f]{6}$/i.test(k.color)) k.color = KEY_DEFAULT.color;
    s.key = k;
    updateMediaLayer(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    syncChromaKeyPanel(); renderSegments();
    return Object.assign({}, k);
  }
  /** The screen's colour, read off the corners of the overlay's current frame. */
  function pickKeyColor(segId) {
    const s = ve.segments.find((x) => x.id === segId); if (!s) return null;
    const n = ve.refs.mediaLayer && ve.refs.mediaLayer.querySelector(`[data-mid="${s.id}"]`);
    if (!n) return null;
    try {
      const c = document.createElement('canvas'); c.width = 64; c.height = 64;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(n, 0, 0, 64, 64);
      let r = 0, gg = 0, b = 0, cnt = 0;
      for (const [x0, y0] of [[0, 0], [56, 0], [0, 56], [56, 56]]) {
        const d = g.getImageData(x0, y0, 8, 8).data;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; cnt++; }
      }
      const hx = (v) => Math.round(v / cnt).toString(16).padStart(2, '0');
      return setChromaKey(segId, { on: true, color: `#${hx(r)}${hx(gg)}${hx(b)}` });
    } catch (e) {
      window.__toast && window.__toast('Could not read that picture yet — play it for a moment and try again.', 'error');
      return null;
    }
  }

  /* ---------------- keyframes: zoom and move over time ----------------
   * CapCut's keyframes for the thing a sermon short needs most: pushing in on
   * the preacher at the line that matters, easing back out, drifting across the
   * frame. A keyframe on a clip holds { t: the moment (source seconds), z: how
   * far in (1 = not at all), x, y: which point of the frame it heads for }; in
   * between, the values glide with an ease in and out. It acts on the finished
   * frame — after the crop to 9:16 — so it stacks with framing and face-tracking
   * instead of fighting them. The export draws the same curve (video.motionChain).
   */
  const KF_NEAR = 0.06;          // a keyframe this close to the playhead is "here"
  const KF_MAX_Z = 3;
  const kfList = (s) => (s && Array.isArray(s.kf) ? s.kf : []);
  const kfSorted = (s) => kfList(s).slice().sort((a, b) => a.t - b.t);
  /** The clip's zoom and focus at timeline/source time t. */
  function kfAt(s, t) {
    const pts = kfSorted(s);
    if (!pts.length) return { z: 1, x: 0.5, y: 0.5 };
    if (t <= pts[0].t) return { z: pts[0].z, x: pts[0].x, y: pts[0].y };
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (t < b.t) {
        const p = clamp((t - a.t) / Math.max(1e-3, b.t - a.t), 0, 1);
        const e = p * p * (3 - 2 * p);
        return { z: a.z + (b.z - a.z) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
      }
    }
    const l = pts[pts.length - 1];
    return { z: l.z, x: l.x, y: l.y };
  }
  /** Which clip's keyframes rule the picture at t: the selected one if it is
   *  under the playhead, else the main-lane clip there. */
  function kfClipAt(t) {
    const on = (s) => (s.lane || 0) === 0 && t >= s.start && t < s.end;
    const sel = ve.segments.find((s) => s.id === ve.sel);
    if (sel && on(sel)) return sel;
    return ve.segments.find((s) => on(s) && !s.ai) || ve.segments.find(on) || null;
  }
  /** The keyframe sitting at t on clip s, if there is one. */
  const kfHere = (s, t) => kfList(s).find((k) => Math.abs(k.t - t) <= KF_NEAR) || null;
  /** A stamp of everything the diamonds on a block are drawn from. */
  const kfSig = (s) => kfList(s).map((k) => k.t.toFixed(2)).join(',') + '|' + s.start.toFixed(2) + '|' + s.end.toFixed(2);
  function kfDotsHtml(s) {
    if ((s.lane || 0) !== 0 || !kfList(s).length) return '';
    const len = Math.max(1e-3, s.end - s.start);
    return kfList(s).filter((k) => k.t >= s.start - 1e-3 && k.t <= s.end + 1e-3)
      .map((k) => `<i class="ve-kf-dot" style="left:${(((k.t - s.start) / len) * 100).toFixed(3)}%" title="Keyframe at ${fmt(k.t)} — ${Math.round(k.z * 100)}%"></i>`).join('');
  }

  /** The preview's push-in: the same zoom about the same point the export uses. */
  function updateKfPreview(t) {
    const p = ve.refs.player; if (!p || !ve.video) return;
    const s = kfClipAt(t);
    const v = s && kfList(s).length ? kfAt(s, t) : null;
    const fr = v && v.z > 1.0005 ? outputFrameRect() : null;
    const key = fr ? [v.z, v.x, v.y, fr.left, fr.top, fr.w, fr.h, ve._canvasT || ''].map(String).join('|') : '';
    if (key === ve._kfKey) return;
    ve._kfKey = key;
    if (!fr) { ve._kfT = ''; setPlayerTransform(); return; }
    // The point of the frame the push heads for stays where it is; everything
    // else grows away from it. (Window = (1 - 1/z)·x across, as in the export.)
    const ax = fr.left + v.x * fr.w, ay = fr.top + v.y * fr.h;
    const o = (getComputedStyle(p).transformOrigin || '').split(' ').map(parseFloat);
    const ox = Number.isFinite(o[0]) ? o[0] : p.clientWidth / 2, oy = Number.isFinite(o[1]) ? o[1] : p.clientHeight / 2;
    const dx = ax - ox, dy = ay - oy;
    ve._kfT = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${v.z.toFixed(4)}) translate(${(-dx).toFixed(2)}px, ${(-dy).toFixed(2)}px)`;
    setPlayerTransform();
  }

  /**
   * The keyframes of every clip in export `s`, on the export's own clock (gaps
   * closed and transitions taken into account) — the shape video.motionChain
   * draws. null when nothing moves.
   */
  function motionFor(s) {
    if (!s) return null;
    const clips = s.id === '__edited' ? mainClips() : [s];
    const out = [];
    for (const c of clips) {
      const pts = kfSorted(c);
      if (!pts.length || pts.every((k) => k.z <= 1.0005)) continue;
      const a = Math.max(c.start, s.start), b = Math.min(c.end, s.end);
      if (b <= a) continue;
      const start = outTime(s, a, 'start'), end = outTime(s, b, 'end');
      if (!(end > start)) continue;
      out.push({
        start, end,
        pts: pts.map((k) => ({ t: outTime(s, clamp(k.t, a, b), 'start'), z: clamp(k.z, 1, KF_MAX_Z), x: clamp(k.x, 0, 1), y: clamp(k.y, 0, 1) })),
      });
    }
    return out.length ? out : null;
  }
  /** The frozen copy's motion when an export is running behind the studio. */
  const motionOf = (s) => (F(s) && 'motion' in F(s) ? F(s).motion : motionFor(s));

  /** Split keyframes at t: each side keeps its own, plus the value at the cut,
   *  so the move carries on seamlessly across it. */
  function splitKf(left, right, t) {
    const pts = kfSorted(left);
    if (!pts.length) return;
    const at = kfAt(left, t);
    const mid = { t, z: at.z, x: at.x, y: at.y };
    const l = pts.filter((k) => k.t < t - 1e-3), r = pts.filter((k) => k.t > t + 1e-3);
    left.kf = l.length ? l.concat([Object.assign({}, mid)]) : [];
    right.kf = r.length ? [Object.assign({}, mid)].concat(r.map((k) => Object.assign({}, k))) : [];
    if (!left.kf.length) delete left.kf;
    if (!right.kf.length) delete right.kf;
  }

  /* ---- the Keyframe panel ---- */
  let kfFor = null;                 // the clip id the panel is editing
  const kfClip = () => ve.segments.find((s) => s.id === kfFor) || null;
  function kfModal() {
    let m = document.getElementById('veKfModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veKfModal';
    m.className = 'cap-modal ve-kf-modal hidden';
    m.innerHTML = `
      <div class="cap-box ve-kf-box">
        <div class="cap-head"><strong>Keyframes</strong> <span class="muted small" data-kf-clip></span><button type="button" class="ghost-btn small" data-kf-close>✕</button></div>
        <div class="ve-kf-nav">
          <button type="button" class="ghost-btn" data-kf-prev title="Previous keyframe">◀</button>
          <button type="button" class="primary-btn ve-kf-add" data-kf-toggle>◆ Add keyframe</button>
          <button type="button" class="ghost-btn" data-kf-next title="Next keyframe">▶</button>
        </div>
        <div class="ve-kf-row"><label>Zoom</label><input type="range" min="100" max="${KF_MAX_Z * 100}" step="1" data-kf="z"><span data-kf-v="z"></span></div>
        <div class="ve-kf-row"><label>Left ↔ right</label><input type="range" min="0" max="100" step="1" data-kf="x"><span data-kf-v="x"></span></div>
        <div class="ve-kf-row"><label>Up ↕ down</label><input type="range" min="0" max="100" step="1" data-kf="y"><span data-kf-v="y"></span></div>
        <div class="ve-kf-presets">
          <button type="button" class="ghost-btn small" data-kf-preset="punch" title="A quick push in at the playhead — for the line that matters">⚡ Punch in</button>
          <button type="button" class="ghost-btn small" data-kf-preset="slowin" title="A slow push in across the whole clip">🔍 Slow zoom in</button>
          <button type="button" class="ghost-btn small" data-kf-preset="slowout" title="Start close and ease back across the whole clip">🔎 Slow zoom out</button>
          <button type="button" class="ghost-btn small" data-kf-preset="pan" title="Drift across the frame from left to right">↔ Pan</button>
          <button type="button" class="ghost-btn small" data-kf-preset="clear" title="Take every keyframe off this clip">✕ Clear</button>
        </div>
        <div class="ve-kf-list" data-kf-list></div>
        <div class="ve-trans-foot"><span class="muted small">Move the playhead, then slide — a keyframe is added where you are.</span><button type="button" class="primary-btn" data-kf-close>Done</button></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-kf-close]')) return closeKeyframes();
      if (e.target.closest('[data-kf-toggle]')) return toggleKeyframeHere();
      if (e.target.closest('[data-kf-prev]')) return jumpKeyframe(-1);
      if (e.target.closest('[data-kf-next]')) return jumpKeyframe(1);
      const pr = e.target.closest('[data-kf-preset]');
      if (pr) return keyframePreset(kfFor, pr.dataset.kfPreset);
      const chip = e.target.closest('[data-kf-t]');
      if (chip) { seekTo(+chip.dataset.kfT); syncKeyframePanel(); }
    });
    // One undo step per gesture: the snapshot is taken when a slider is
    // grabbed, and the values written as it moves.
    m.querySelectorAll('[data-kf]').forEach((r) => {
      r.addEventListener('pointerdown', () => { r._pre = snapshotState(); });
      r.addEventListener('input', () => setKeyframeValue(r.dataset.kf, +r.value / 100, true));
      r.addEventListener('change', () => { if (r._pre) { commitDragHistory(r._pre); r._pre = null; } });
    });
    return m;
  }
  function openKeyframes(segId) {
    if (!ve.video) { window.__toast && window.__toast('Open a video first.', 'error'); return false; }
    const t = ve.refs.player.currentTime || 0;
    const s = (segId && ve.segments.find((x) => x.id === segId)) || kfClipAt(t);
    if (!s || (s.lane || 0) !== 0) {
      window.__toast && window.__toast('Put the playhead on a clip in the main row, then add keyframes to it.', 'error');
      return false;
    }
    kfFor = s.id;
    if (ve.sel !== s.id) selectSeg(s.id);
    const m = kfModal();
    m.classList.remove('hidden');
    syncKeyframePanel();
    return true;
  }
  function closeKeyframes() {
    const m = document.getElementById('veKfModal');
    if (m) m.classList.add('hidden');
    kfFor = null;
  }
  /** Mirror the clip's value at the playhead onto the sliders. */
  function syncKeyframePanel() {
    const m = document.getElementById('veKfModal'); const s = kfClip();
    if (!m || !s || m.classList.contains('hidden')) return;
    const t = ve.refs.player.currentTime || 0;
    const v = kfAt(s, t), here = kfHere(s, t);
    m.querySelector('[data-kf-clip]').textContent = `— ${s.label}`;
    const put = (k, val, txt) => { const r = m.querySelector(`[data-kf="${k}"]`); if (r && document.activeElement !== r) r.value = String(Math.round(val * 100)); m.querySelector(`[data-kf-v="${k}"]`).textContent = txt; };
    put('z', v.z, Math.round(v.z * 100) + '%');
    put('x', v.x, Math.round(v.x * 100) + '');
    put('y', v.y, Math.round(v.y * 100) + '');
    const tg = m.querySelector('[data-kf-toggle]');
    tg.textContent = here ? '◇ Remove keyframe' : '◆ Add keyframe';
    tg.classList.toggle('on', !!here);
    const inClip = t >= s.start && t <= s.end;
    tg.disabled = !inClip;
    m.querySelector('[data-kf-list]').innerHTML = kfSorted(s).map((k) =>
      `<button type="button" class="ve-kf-chip${here === k ? ' on' : ''}" data-kf-t="${k.t}">◆ ${fmt(k.t)} · ${Math.round(k.z * 100)}%</button>`).join('')
      || '<span class="muted small">No keyframes on this clip yet.</span>';
  }
  /** Write one value at the playhead — onto the keyframe there, or a new one. */
  function setKeyframeValue(key, val, live) {
    const s = kfClip(); if (!s) return null;
    const t = clamp(ve.refs.player.currentTime || 0, s.start, s.end);
    if (!live) pushHistory();
    let k = kfHere(s, t);
    if (!k) {
      const v = kfAt(s, t);
      // The first keyframe on a clip also pins the clip's start at "no zoom",
      // so the move has somewhere to come FROM — CapCut's two-keyframe rule.
      if (!kfList(s).length && t - s.start > 0.3) s.kf = [{ t: s.start, z: 1, x: 0.5, y: 0.5 }];
      k = { t, z: v.z, x: v.x, y: v.y };
      s.kf = kfList(s).concat([k]);
    }
    if (key === 'z') k.z = clamp(val, 1, KF_MAX_Z);
    else if (key === 'x' || key === 'y') k[key] = clamp(val, 0, 1);
    s.kf.sort((a, b) => a.t - b.t);
    ve._kfKey = null;
    updateKfPreview(ve.refs.player.currentTime || 0);
    syncKeyframePanel();
    renderSegments();
    return k;
  }
  function toggleKeyframeHere() {
    const s = kfClip(); if (!s) return;
    const t = ve.refs.player.currentTime || 0;
    if (t < s.start || t > s.end) return;
    const here = kfHere(s, t);
    pushHistory();
    if (here) {
      s.kf = kfList(s).filter((k) => k !== here);
      if (!s.kf.length) delete s.kf;
    } else {
      const v = kfAt(s, t);
      s.kf = kfList(s).concat([{ t, z: v.z, x: v.x, y: v.y }]).sort((a, b) => a.t - b.t);
    }
    ve._kfKey = null;
    updateKfPreview(t); syncKeyframePanel(); renderSegments();
  }
  function jumpKeyframe(dir) {
    const s = kfClip(); if (!s) return;
    const t = ve.refs.player.currentTime || 0;
    const pts = kfSorted(s);
    const k = dir > 0 ? pts.find((p) => p.t > t + KF_NEAR) : pts.slice().reverse().find((p) => p.t < t - KF_NEAR);
    if (k) { seekTo(k.t); syncKeyframePanel(); }
  }
  /** One-tap moves. Each is ordinary keyframes, editable afterwards. */
  function keyframePreset(segId, kind) {
    const s = ve.segments.find((x) => x.id === segId); if (!s) return null;
    const t = clamp(ve.refs.player.currentTime || 0, s.start, s.end);
    const len = s.end - s.start;
    pushHistory();
    if (kind === 'clear') delete s.kf;
    else if (kind === 'punch') {
      // in over half a second at the playhead, hold — the classic emphasis cut
      const a = clamp(t, s.start, Math.max(s.start, s.end - 0.6));
      const keep = kfList(s).filter((k) => k.t < a - 0.05 || k.t > a + 0.65);
      s.kf = keep.concat([{ t: a, z: 1, x: 0.5, y: 0.4 }, { t: a + Math.min(0.5, len / 2), z: 1.35, x: 0.5, y: 0.4 }]);
    } else if (kind === 'slowin') s.kf = [{ t: s.start, z: 1, x: 0.5, y: 0.45 }, { t: s.end, z: 1.25, x: 0.5, y: 0.45 }];
    else if (kind === 'slowout') s.kf = [{ t: s.start, z: 1.25, x: 0.5, y: 0.45 }, { t: s.end, z: 1, x: 0.5, y: 0.45 }];
    else if (kind === 'pan') s.kf = [{ t: s.start, z: 1.25, x: 0, y: 0.5 }, { t: s.end, z: 1.25, x: 1, y: 0.5 }];
    if (s.kf) s.kf.sort((a, b) => a.t - b.t);
    ve._kfKey = null;
    updateKfPreview(ve.refs.player.currentTime || 0); syncKeyframePanel(); renderSegments();
    const names = { punch: 'Punch in', slowin: 'Slow zoom in', slowout: 'Slow zoom out', pan: 'Pan', clear: 'Keyframes cleared' };
    window.__toast && window.__toast(kind === 'clear' ? 'Keyframes taken off this clip.' : `${names[kind]} added to “${s.label}” — play it to see the move.`, 'good');
    return kfList(s).length;
  }

  /* ---------------- text animations + templates ----------------
   * CapCut's text arrives: it fades, rises into place, pops. The same three
   * numbers drive the preview here and the export in video.textOverlaySteps —
   * how opaque, how far below its place (a fraction of the frame height), how
   * large — on the same clock, so the file moves the way the preview did.
   */
  const TEXT_ANIMS = [
    { id: 'none', name: 'None' },
    { id: 'fade', name: 'Fade' },
    { id: 'rise', name: 'Rise' },
    { id: 'pop', name: 'Pop' },
    { id: 'zoom', name: 'Zoom' },
  ];
  const TEXT_ANIM_IDS = TEXT_ANIMS.map((a) => a.id);
  const TEXT_RISE = 0.06;
  /** Same rule as video.textAnimTimes: short texts get short arrivals. */
  function textAnimTimes(len) {
    const L = Math.max(0.05, Number(len) || 0);
    return { inD: Math.min(0.35, L / 3), outD: Math.min(0.25, L / 4) };
  }
  function textAnimScale(anim, p) {
    const q = clamp(p, 0, 1);
    if (anim === 'pop') return q < 0.7 ? 0.6 + 0.48 * (q / 0.7) : 1.08 - 0.08 * ((q - 0.7) / 0.3);
    if (anim === 'zoom') return 1.35 - 0.35 * q;
    return 1;
  }
  /** Where an animated text is at `t` (timeline seconds): {opacity, dy, k}. */
  function textAnimState(o, t) {
    const anim = TEXT_ANIM_IDS.includes(o && o.anim) ? o.anim : 'none';
    if (anim === 'none') return { opacity: 1, dy: 0, k: 1 };
    const { inD, outD } = textAnimTimes(o.end - o.start);
    const p = clamp((t - o.start) / inD, 0, 1);
    const opacity = Math.min(p, clamp((o.end - t) / outD, 0, 1));
    return {
      opacity,
      dy: anim === 'rise' ? TEXT_RISE * (1 - p) * (1 - p) : 0,
      k: textAnimScale(anim, p),
    };
  }
  /** The animation as inline CSS on a text's words, for a frame `frameH` tall. */
  function textAnimCss(o, t, frameH) {
    // The text being worked on stands still while the video does: a selected
    // title that keeps shrinking under the cursor cannot be placed.
    if (ve.textSel === o.id && ve.refs.player && ve.refs.player.paused) return '';
    const a = textAnimState(o, t);
    if (a.opacity >= 1 && !a.dy && a.k === 1) return '';
    return `opacity:${a.opacity.toFixed(3)};transform:translateY(${(a.dy * frameH).toFixed(2)}px) scale(${a.k.toFixed(4)});transform-origin:50% 50%;`;
  }

  /*
   * TEMPLATES. CapCut's "text templates" are ready-made titles: a look, a place
   * and an arrival in one tap, then you type your own words over the sample.
   * Each is a set of ordinary text boxes — every one stays editable, movable and
   * restyleable exactly like text added by hand, and exports the same way.
   * Positions are fractions of the export frame, laid out for a 9:16 short and
   * narrowed for a wide picture.
   */
  const TEXT_TEMPLATES = [
    /* Each template is a STACK: its lines sit one under the other, `gap` apart
     * (fractions of the frame height), centred on `y`. They are stacked by
     * their real measured height, so a title that wraps onto two lines pushes
     * the line under it down instead of landing on top of it. `hug` makes a
     * backing panel fit the words, the way a name banner does. */
    { id: 'title', name: 'Title card', y: 0.45, gap: 0.008, items: [
      { text: 'SUNDAY SERVICE', w: 0.92, sizePct: 0.085, font: 'Bebas Neue', color: '#ffffff', outline: true, anim: 'pop' },
      { text: 'Join us live at 10 AM', w: 0.84, sizePct: 0.034, font: 'Poppins', color: '#ffe14d', outline: true, anim: 'rise' },
    ] },
    { id: 'lower', name: 'Lower third', y: 0.76, gap: 0.006, items: [
      { text: 'Speaker name', w: 0.8, sizePct: 0.04, font: 'Poppins', color: '#111111', outline: false, bg: true, bgColor: '#ffffff', hug: true, anim: 'rise' },
      { text: 'Title or role', w: 0.7, sizePct: 0.026, font: 'Poppins', color: '#ffffff', outline: false, bg: true, bgColor: '#8b5cf6', hug: true, anim: 'rise' },
    ] },
    { id: 'handle', name: 'Social handle', y: 0.9, gap: 0, items: [
      { text: '@yourchurch', w: 0.8, sizePct: 0.034, font: 'Poppins', color: '#ffffff', outline: false, bg: true, bgColor: '#8b5cf6', hug: true, anim: 'pop' },
    ] },
    { id: 'quote', name: 'Quote', y: 0.46, gap: 0.014, items: [
      { text: '“Faith comes by hearing, and hearing by the word of God.”', w: 0.84, sizePct: 0.042, font: 'Playfair Display', color: '#ffffff', outline: true, anim: 'fade' },
      { text: '— Romans 10:17', w: 0.7, sizePct: 0.028, font: 'Poppins', color: '#ffe14d', outline: true, anim: 'fade' },
    ] },
    { id: 'verse', name: 'Bible verse', y: 0.4, gap: 0.012, items: [
      { text: 'JOHN 3:16', w: 0.6, sizePct: 0.03, font: 'Montserrat', color: '#ffffff', outline: false, bg: true, bgColor: '#c1121f', hug: true, anim: 'rise' },
      { text: 'For God so loved the world…', w: 0.86, sizePct: 0.046, font: 'Montserrat', color: '#ffffff', outline: true, anim: 'rise' },
    ] },
    { id: 'hook', name: 'Hook', y: 0.14, gap: 0, items: [
      { text: 'WAIT FOR IT…', w: 0.92, sizePct: 0.08, font: 'Anton', color: '#ffe14d', outline: true, anim: 'zoom' },
    ] },
    { id: 'follow', name: 'Follow', y: 0.86, gap: 0, items: [
      { text: 'FOLLOW FOR MORE', w: 0.86, sizePct: 0.038, font: 'Montserrat', color: '#ffffff', outline: false, bg: true, bgColor: '#e11d48', hug: true, anim: 'pop' },
    ] },
    { id: 'event', name: 'Event', y: 0.4, gap: 0.01, items: [
      { text: 'THIS SUNDAY', w: 0.92, sizePct: 0.08, font: 'Anton', color: '#ffe14d', outline: true, anim: 'pop' },
      { text: 'Youth Conference · 10 AM', w: 0.9, sizePct: 0.032, font: 'Poppins', color: '#ffffff', outline: false, bg: true, bgColor: '#000000', hug: true, anim: 'rise' },
    ] },
    { id: 'series', name: 'Sermon series', y: 0.45, gap: 0.004, items: [
      { text: 'SERMON SERIES', w: 0.8, sizePct: 0.026, font: 'Montserrat', color: '#b79cff', outline: false, anim: 'fade' },
      { text: 'WALKING IN FAITH', w: 0.92, sizePct: 0.08, font: 'Bebas Neue', color: '#ffffff', outline: true, anim: 'rise' },
      { text: 'Part 1', w: 0.6, sizePct: 0.045, font: 'Great Vibes', color: '#ffe14d', outline: false, anim: 'fade' },
    ] },
    { id: 'amen', name: 'Amen', y: 0.5, gap: 0, items: [
      { text: 'AMEN!', w: 0.86, sizePct: 0.12, font: 'Luckiest Guy', color: '#ffffff', outline: true, anim: 'pop' },
    ] },
    { id: 'breaking', name: 'Headline', y: 0.15, gap: 0.01, items: [
      { text: 'NEW MESSAGE', w: 0.7, sizePct: 0.028, font: 'Montserrat', color: '#111111', outline: false, bg: true, bgColor: '#ffe14d', hug: true, anim: 'rise' },
      { text: 'God is not finished with you', w: 0.9, sizePct: 0.05, font: 'Archivo Black', color: '#ffffff', outline: true, anim: 'rise' },
    ] },
    { id: 'scripture', name: 'Script', y: 0.47, gap: 0, items: [
      { text: 'Grace', w: 0.86, sizePct: 0.11, font: 'Great Vibes', color: '#ffffff', outline: false, anim: 'fade' },
      { text: 'UPON GRACE', w: 0.8, sizePct: 0.04, font: 'Montserrat', color: '#ffe14d', outline: false, anim: 'fade' },
    ] },
  ];
  /** A template's boxes as real overlays at the playhead, for this frame shape.
   *  `y` is provisional — stackTemplate places them once they can be measured. */
  function templateOverlays(tpl, t, frame) {
    const wide = frame && frame.w > frame.h;
    const len = 4;
    const start = Math.max(0, Math.min(t, Math.max(0, dur() - 0.5)));
    const end = Math.min(dur() || start + len, start + len);
    return tpl.items.map((it) => ({
      id: uid(), text: it.text, x: 0.5, y: tpl.y,
      // a 9:16 layout on a wide picture: the same look, narrower and a touch smaller
      w: wide ? Math.min(0.7, it.w * 0.62) : it.w, h: 0.12,
      sizePct: wide ? it.sizePct * 0.9 : it.sizePct,
      start, end: Math.max(start + 0.5, end),
      font: it.font, color: it.color, bold: true,
      outline: !!it.outline, outlineColor: '#000000',
      bg: !!it.bg, bgColor: it.bgColor || undefined, hug: !!it.hug,
      anim: it.anim || 'none', tpl: tpl.id,
    }));
  }
  /** Stack a template's boxes by their real drawn height, centred on its `y`. */
  function stackTemplate(made, tpl) {
    const fr = outputFrameRect();
    if (!fr || !fr.h || !ve.refs.textLayer) return;
    const hs = made.map((o) => {
      const el = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${o.id}"]`);
      return el ? el.offsetHeight / fr.h : o.sizePct * 1.3;
    });
    const gap = tpl.gap || 0;
    const total = hs.reduce((a, b) => a + b, 0) + gap * Math.max(0, made.length - 1);
    let top = clamp(tpl.y - total / 2, 0.03, Math.max(0.03, 0.97 - total));
    made.forEach((o, i) => { o.y = top + hs[i] / 2; top += hs[i] + gap; });
  }
  /** The template's typefaces, actually fetched — a line measured in a stand-in
   *  font is stacked at the stand-in's height and lands on its neighbour once
   *  the real one arrives. Never waits more than a moment. */
  async function loadTemplateFonts(tpl) {
    try { await loadCapFonts(); } catch (e) {}
    if (!document.fonts || !document.fonts.load) return;
    const fams = Array.from(new Set(tpl.items.map((it) => it.font)));
    const all = Promise.all(fams.map((f) => {
      const fam = (CAP_FONTS.find((x) => x.name === f) || {}).family || f;
      return Promise.all([f, fam].map((n) => document.fonts.load(`800 40px '${String(n).replace(/'/g, '')}'`).catch(() => null)));
    }));
    await Promise.race([all, new Promise((r) => setTimeout(r, 1500))]);
  }
  async function addTextTemplate(id) {
    if (!ve.video) { window.__toast && window.__toast('Open a video first.', 'error'); return null; }
    const tpl = TEXT_TEMPLATES.find((x) => x.id === id);
    if (!tpl) return null;
    await loadTemplateFonts(tpl);
    pushHistory();
    const t = ve.refs.player.currentTime || 0;
    const made = templateOverlays(tpl, t, outputFrameRect());
    for (const o of made) { ve.textOverlays.push(o); }
    ve.textSel = made[0].id;
    renderTextOverlays(); renderTextTrack();
    // stacked by their real height once drawn, then kept inside the frame
    stackTemplate(made, tpl);
    made.forEach((o) => clampTextIntoFrame(o));
    renderTextOverlays();
    closeTextTemplates();
    // parked just after the arrival, so every line of it is there to be seen
    // and tapped — press play from before it to watch it come in
    try { ve.refs.player.currentTime = Math.min(made[0].end, made[0].start + 0.4); updatePlayhead(); } catch (e) {}
    window.__toast && window.__toast(`“${tpl.name}” added — tap the words to type your own.`, 'good');
    return made.map((o) => o.id);
  }
  /** A template drawn small, in its own fonts, for the gallery card. */
  function templateCardHtml(tpl) {
    const H = 192;   // the card's own height (.ve-tpl-demo), so sizes are true to scale
    // the same stack, laid out by the browser: a flex column centred on y
    return `<div class="ve-tpl-stack" style="top:${(tpl.y * 100).toFixed(1)}%;gap:${((tpl.gap || 0) * H).toFixed(1)}px;">`
      + tpl.items.map((it) => {
        const o = Object.assign({ bold: true }, it);
        return `<div class="ve-tpl-item" style="width:${(it.w * 100).toFixed(0)}%;">`
          + `<div style="${textLookCss(o, Math.max(6, it.sizePct * H))}">${escape2(it.text)}</div></div>`;
      }).join('') + '</div>';
  }
  function textTplModal() {
    let m = document.getElementById('veTextTplModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veTextTplModal';
    m.className = 'cap-modal hidden';
    m.innerHTML = `
      <div class="cap-box ve-tpl-box">
        <div class="cap-head"><strong>Text templates</strong><button type="button" class="ghost-btn small" data-tpl-close>✕</button></div>
        <div class="ve-tpl-grid">${TEXT_TEMPLATES.map((t) => `<button type="button" class="ve-tpl-card" data-tpl="${t.id}" title="${attr2(t.name)}"><span class="ve-tpl-demo">${templateCardHtml(t)}</span><span class="ve-tpl-name">${escape2(t.name)}</span></button>`).join('')}</div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-tpl-close]')) return closeTextTemplates();
      const c = e.target.closest('[data-tpl]');
      if (c) addTextTemplate(c.dataset.tpl);
    });
    return m;
  }
  async function openTextTemplates() {
    if (!ve.video) { window.__toast && window.__toast('Open a video first.', 'error'); return; }
    // the cards are drawn in the real typefaces, which have to be loaded first
    try { await loadCapFonts(); } catch (e) {}
    const m = textTplModal();
    m.classList.remove('hidden');
  }
  function closeTextTemplates() {
    const m = document.getElementById('veTextTplModal');
    if (m) m.classList.add('hidden');
  }

  /** The animation picker for the selected text: tiles that show each move. */
  function textAnimModal() {
    let m = document.getElementById('veTextAnimModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veTextAnimModal';
    m.className = 'cap-modal hidden';
    m.innerHTML = `
      <div class="cap-box ve-tanim-box">
        <div class="cap-head"><strong>Text animation</strong><button type="button" class="ghost-btn small" data-tanim-close>✕</button></div>
        <div class="ve-tanim-grid">${TEXT_ANIMS.map((a) => `<button type="button" class="ve-tanim-tile" data-tanim="${a.id}"><span class="ve-tanim-demo ta-${a.id}"><b>Aa</b></span><span class="ve-tanim-name">${a.name}</span></button>`).join('')}</div>
        <div class="ve-trans-foot">
          <button type="button" class="ghost-btn" data-tanim-all>Apply to all text</button>
          <button type="button" class="primary-btn" data-tanim-close>Done</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-tanim-close]')) { m.classList.add('hidden'); return; }
      const tile = e.target.closest('[data-tanim]');
      if (tile) { setTextAnim(ve.textSel, tile.dataset.tanim); return; }
      if (e.target.closest('[data-tanim-all]')) {
        const o = selectedTextOverlay();
        const a = (o && o.anim) || 'none';
        if (!ve.textOverlays.length) return;
        pushHistory();
        ve.textOverlays.forEach((x) => { x.anim = a; });
        renderTextOverlays(); renderTextTrack(); updateTextTools();
        window.__toast && window.__toast(a === 'none' ? 'Animation taken off every text.' : `${TEXT_ANIMS.find((x) => x.id === a).name} on all ${ve.textOverlays.length} text${ve.textOverlays.length === 1 ? '' : 's'}.`, 'good');
      }
    });
    return m;
  }
  function syncTextAnimPicker() {
    const m = document.getElementById('veTextAnimModal');
    const o = selectedTextOverlay();
    if (!m) return;
    m.querySelectorAll('[data-tanim]').forEach((b) => b.classList.toggle('on', !!o && (o.anim || 'none') === b.dataset.tanim));
  }
  function openTextAnimPicker() {
    if (!selectedTextOverlay()) {
      // nothing chosen yet: the one under the playhead, or the first there is
      const t = ve.refs.player ? ve.refs.player.currentTime || 0 : 0;
      const here = ve.textOverlays.find((o) => t >= o.start && t <= o.end) || ve.textOverlays[0];
      if (!here) { window.__toast && window.__toast('Add some text first — then choose how it arrives.', 'error'); return; }
      ve.textSel = here.id; renderTextOverlays(); renderTextTrack();
    }
    const m = textAnimModal();
    syncTextAnimPicker();
    m.classList.remove('hidden');
  }
  /** Set how a text arrives. One undo step; plays the arrival so it is seen. */
  function setTextAnim(id, anim) {
    const o = ve.textOverlays.find((x) => x.id === id);
    if (!o) return null;
    pushHistory();
    o.anim = TEXT_ANIM_IDS.includes(anim) ? anim : 'none';
    syncTextAnimPicker();
    const sel = document.getElementById('vtAnim'); if (sel) sel.value = o.anim;
    renderTextOverlays(); renderTextTrack();
    if (o.anim !== 'none' && ve.refs.player) {
      try { ve.refs.player.currentTime = Math.max(0, o.start - 0.3); const pr = ve.refs.player.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
    }
    return o.anim;
  }

  /* ---- text-style toolbar (font / size / colour / bold) ---- */
  /** The export frame's height in preview pixels — what a text's size is a
   *  fraction OF, so the number the toolbar shows means the same thing at every
   *  preview size. */
  const previewH = () => { const f = outputFrameRect(); return (f && f.h) || 400; };
  function selectedTextOverlay() { return ve.textOverlays.find((o) => o.id === ve.textSel); }
  /** Show the toolbar for the selected text + mirror its current style. */
  function updateTextTools() {
    const bar = $('#veTextTools'); if (!bar) return;
    const o = selectedTextOverlay();
    if (!ve.video || !o) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    // Keep the bar OFF the text it is editing. The preview can be short (the
    // timeline needs the height), and a bar pinned to the top swallowed every
    // click on text placed up there — the text simply would not respond. Park
    // it on the opposite side of the picture from the selected text.
    const low = (o.y || 0) < 0.5;
    bar.style.top = low ? 'auto' : '10px';
    bar.style.bottom = low ? '10px' : 'auto';
    $('#vtFont').value = o.font || 'Arial';
    $('#vtSize').value = String(Math.round(Math.max(1, (o.sizePct || 0.11) * previewH()) * 2) / 2);
    $('#vtColor').value = /^#[0-9a-f]{6}$/i.test(o.color || '') ? o.color : '#ffffff';
    $('#vtBold').classList.toggle('on', !!o.bold);
    const bg = $('#vtBg'); if (bg) bg.classList.toggle('on', !!o.bg);
    const bgc = $('#vtBgColor');
    if (bgc) { bgc.value = /^#[0-9a-f]{6}$/i.test(o.bgColor || '') ? o.bgColor : '#000000'; bgc.disabled = !o.bg; }
    const ol = $('#vtOutline'); if (ol) ol.classList.toggle('on', !!o.outline);
    const an = $('#vtAnim'); if (an) an.value = TEXT_ANIM_IDS.includes(o.anim) ? o.anim : 'none';
  }
  /** Change a style property on the selected text; updates the live node even mid-edit. */
  function applyTextProp(mutate) {
    const o = selectedTextOverlay(); if (!o) return;
    pushHistory();
    mutate(o);
    // update the live DOM node directly (works even while contenteditable-editing,
    // where renderTextOverlays is deliberately guarded from re-rendering)
    const c = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${o.id}"] .ve-text-content`);
    if (c) {
      // Repainted from the SAME look function the export uses, rather than by
      // poking the handful of properties this toolbar happens to know about —
      // which is how the outline would have been the one thing that only
      // appeared after a re-render.
      c.style.cssText = textLookCss(o, textFontPx(o, previewH())) + 'pointer-events:auto;outline:none;';
      // …and put back what editing needs, which cssText has just wiped.
      if (ve.textEditing === o.id) {
        c.style.cursor = 'text';
        c.style.userSelect = 'text';
        c.style.webkitUserSelect = 'text';
      }
    }
    // A bigger font / different family makes the box taller or wider — pull it
    // back inside the export frame so it can never grow off the picture.
    clampTextIntoFrame(o);
    if (ve.textEditing !== o.id) renderTextOverlays();
    renderTextTrack(); updateTextTools();
  }
  /*
   * SNAPPING, AS CAPCUT DOES IT. A title dragged by thumb lands a few pixels off
   * centre every time, and "nearly centred" is the first thing a viewer sees.
   * While a text box is dragged it clicks to the middle of the frame (across
   * and down) and to a safe margin at each edge, and a guide line shows which.
   * Being within SNAP_PX of a line is what catches it; dragging past lets go,
   * because the snap is worked out from where the finger really is each time.
   */
  const TEXT_SNAP_PX = 9, TEXT_SAFE = 0.05;
  let _textSnapWas = '';
  function snapTextBox(o, fr, box) {
    if (!fr || !fr.w || !fr.h) return null;
    const el = box || (ve.refs.textLayer && ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${o.id}"]`));
    const bw = el ? el.offsetWidth / fr.w : o.w, bh = el ? el.offsetHeight / fr.h : 0.08;
    const tx = TEXT_SNAP_PX / fr.w, ty = TEXT_SNAP_PX / fr.h;
    const hit = { v: null, h: null };
    // across: centre, then the left / right safe margins (by the box's edge)
    const xs = [{ at: 0.5, x: 0.5, kind: 'center' },
      { at: TEXT_SAFE, x: TEXT_SAFE + bw / 2, kind: 'edge' }, { at: 1 - TEXT_SAFE, x: 1 - TEXT_SAFE - bw / 2, kind: 'edge' }];
    for (const c of xs) if (Math.abs(o.x - c.x) <= tx) { o.x = c.x; hit.v = c; break; }
    const ys = [{ at: 0.5, y: 0.5, kind: 'center' },
      { at: TEXT_SAFE, y: TEXT_SAFE + bh / 2, kind: 'edge' }, { at: 1 - TEXT_SAFE, y: 1 - TEXT_SAFE - bh / 2, kind: 'edge' }];
    for (const c of ys) if (Math.abs(o.y - c.y) <= ty) { o.y = c.y; hit.h = c; break; }
    const key = (hit.v ? 'v' + hit.v.at : '') + (hit.h ? 'h' + hit.h.at : '');
    // a small tick in the hand the moment it catches (phones that can)
    if (key && key !== _textSnapWas) { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {} }
    _textSnapWas = key;
    return hit.v || hit.h ? hit : null;
  }
  /** The guide lines over the frame while a snap holds; null takes them away. */
  function showTextGuides(hit, fr) {
    const layer = ve.refs.textLayer; if (!layer || !layer.parentNode) return;
    let g = layer.parentNode.querySelector('.ve-snap-guides');
    if (!hit) { if (g) g.remove(); _textSnapWas = ''; return; }
    if (!g) {
      g = document.createElement('div');
      g.className = 've-snap-guides';
      g.setAttribute('aria-hidden', 'true');
      layer.parentNode.appendChild(g);
    }
    const lines = [];
    if (hit.v) lines.push(`<i class="ve-snap-v${hit.v.kind === 'center' ? ' c' : ''}" style="left:${(fr.left + hit.v.at * fr.w).toFixed(1)}px;top:${fr.top.toFixed(1)}px;height:${fr.h.toFixed(1)}px"></i>`);
    if (hit.h) lines.push(`<i class="ve-snap-h${hit.h.kind === 'center' ? ' c' : ''}" style="top:${(fr.top + hit.h.at * fr.h).toFixed(1)}px;left:${fr.left.toFixed(1)}px;width:${fr.w.toFixed(1)}px"></i>`);
    g.innerHTML = lines.join('');
  }
  function onTextBoxDown(ev, box) {
    const id = box.dataset.id;
    const o = ve.textOverlays.find((x) => x.id === id); if (!o) return;
    // If this box is currently being edited, DON'T hijack the mousedown — let the
    // browser place the text caret / select text inside the contenteditable.
    // (Calling preventDefault here is exactly what used to make typing impossible.)
    if (ve.textEditing === id) return;
    if (ev.target.closest('[data-del]')) { ve.textSel = id; renderTextOverlays(); renderTextTrack(); return; }
    const resizing = !!ev.target.closest('[data-resize]');
    ve.textSel = id; renderTextOverlays(); renderTextTrack();
    ev.preventDefault(); ev.stopPropagation();
    const fr = outputFrameRect();
    const preSnap = snapshotState();
    const x0 = ev.clientX, y0 = ev.clientY, ox0 = o.x, oy0 = o.y, w0 = o.w, h0 = o.h;
    let moved = false;
    const move = (e) => {
      if (Math.abs(e.clientX - x0) > 3 || Math.abs(e.clientY - y0) > 3) moved = true;
      // fractions of the EXPORT FRAME, which is what x/y/w are
      const dx = (e.clientX - x0) / (fr.w || 1), dy = (e.clientY - y0) / (fr.h || 1);
      // box height hugs the text, so resizing only changes WIDTH (font size sets height)
      // — measured against the export frame, which is what o.w is a fraction of.
      if (resizing) { o.w = clamp(w0 + ((e.clientX - x0) * 2) / (fr.w || 1), 0.06, 1); }
      else {
        o.x = ox0 + dx; o.y = oy0 + dy;
        // e.shiftKey (or alt) on the desk: move freely, no snapping
        const snap = (e.altKey || e.shiftKey) ? null : snapTextBox(o, fr, box);
        clampTextIntoFrame(o);
        showTextGuides(snap, fr);
      }
      renderTextOverlays();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      showTextGuides(null);
      if (moved) commitDragHistory(preSnap);
      // A plain CLICK (no drag, not the resize handle) = "I want to edit this" →
      // enter edit mode so the user can type immediately. This is what people
      // expect: click the text, then type. (Double-click still works too.)
      else if (!resizing) startEditingText(id);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }
  function renderTextTrack() {
    const track = ve.refs.textTrack; if (!track) return;
    // Each text block has TRIM HANDLES on both edges (like video clips): drag the
    // RIGHT edge to keep the text on screen longer (all the way to the end of the
    // sermon), the LEFT edge to start it earlier/later, or the middle to move it.
    track.innerHTML = ve.textOverlays.map((o) => {
      const left = o.start * ve.pxPerSec, width = Math.max(6, (o.end - o.start) * ve.pxPerSec);
      return `<div class="ve-text-clip${ve.textSel === o.id ? ' sel' : ''}" data-id="${o.id}" style="left:${left}px;width:${width}px;">`
        + `<div class="ve-tc-h l" data-tedge="l" title="Drag to change when the text starts"></div>`
        + `<span class="ve-tc-label">${escape2(o.text)}</span>`
        + `<div class="ve-tc-h r" data-tedge="r" title="Drag to keep the text on screen longer"></div>`
        + `</div>`;
    }).join('');
    $$('.ve-text-clip', track).forEach((el) => {
      el.addEventListener('mousedown', (ev) => {
        ev.stopPropagation(); ev.preventDefault();
        const id = el.dataset.id, o = ve.textOverlays.find((x) => x.id === id); if (!o) return;
        const edge = ev.target && ev.target.dataset ? ev.target.dataset.tedge : null;
        ve.textSel = id; renderTextTrack(); renderTextOverlays(); updateTextTools();
        const preSnap = snapshotState();
        const x0 = ev.clientX, s0 = o.start, e0 = o.end;
        const move = (e) => {
          const dt = (e.clientX - x0) / ve.pxPerSec;
          if (edge === 'l') {
            o.start = clamp(snapT(s0 + dt).t, 0, o.end - 0.3);
          } else if (edge === 'r') {
            o.end = clamp(snapT(e0 + dt).t, o.start + 0.3, dur());
          } else {
            const len = e0 - s0;
            let ns = clamp(s0 + dt, 0, dur() - len);
            const sl = snapT(ns), sr = snapT(ns + len);
            if (sl.snapped) ns = clamp(sl.t, 0, dur() - len);
            else if (sr.snapped) ns = clamp(sr.t - len, 0, dur() - len);
            o.start = ns; o.end = ns + len;
          }
          renderTextTrack(); renderTextOverlays();
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          if (Math.abs(o.start - s0) > 0.01 || Math.abs(o.end - e0) > 0.01) commitDragHistory(preSnap);
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up, { once: true });
      });
    });
  }

  /* ---------------- captions timeline track (CapCut-style) ----------------
   * Every generated caption line (ve.capEvents) is a SOLID block on its own
   * timeline lane showing its actual words — that lane is where you edit captions:
   *   click        → the caret lands in that line's words (zooming in first if the
   *                  block is too narrow to read), and the playhead parks on it
   *   type         → the preview caption updates live
   *   Enter/Esc    → save / throw away · Tab → save and hop to the next line
   *   drag middle  → move the line · drag an edge → change when it starts/ends
   *   Delete       → remove the line
   * Per-short captions are stored CLIP-RELATIVE, so they're drawn at
   * capOffset + start (see capAbs) and stay editable here too. */
  function capBlocksVisible() {
    return Array.isArray(ve.capEvents) && ve.capEvents.length > 0;
  }
  /* Per-short captions are stored CLIP-RELATIVE (capOffset = the clip's start), so
   * every timeline position goes through these two helpers. Whole-video captions
   * have capOffset 0, so they're absolute already. */
  const capOff = () => ve.capOffset || 0;
  const capAbs = (c) => capOff() + c.start;
  const capAbsEnd = (c) => capOff() + c.end;
  /** A caption line only READS as words if its block is wide enough to hold them. */
  const CAP_READABLE_PX = 96;
  /**
   * Is this caption line inside a pause the user removed — i.e. will it be missing
   * from the export? For per-short captions that's a question about the short they
   * belong to; for whole-video captions it's about whichever clip covers that
   * moment, so both modes grey out the lines that won't make it.
   */
  function capLineDropped(c) {
    const t = capAbs(c);
    if (ve.capTarget) return !!cutAt(ve.capTarget, t);
    return ve.segments.some((s) => (s.lane || 0) === 0 && t >= s.start && t < s.end && !!cutAt(s, t));
  }
  /**
   * Wipe every caption off the timeline. The transcript can take minutes to
   * produce, so this asks first and records a caption-bearing undo step — Ctrl+Z
   * genuinely puts them back rather than making you transcribe again.
   */
  function clearAllCaptions() {
    const n = (ve.capEvents || []).length;
    if (!n) return window.__toast && window.__toast('There are no captions on the timeline yet.', 'error');
    if (!window.confirm(`Remove all ${n} caption line${n > 1 ? 's' : ''} from the timeline?\n\nYour video isn't touched, and Ctrl+Z brings them back.`)) return;
    commitCapEdit();                 // fold any half-typed line in before snapshotting
    pushHistory({ captions: true });
    ve.capEvents = null; ve.capWords = null; ve.capOffset = 0; ve.capTarget = null;
    ve._capSource = null; ve._capMode = null; ve._capClipId = null;
    ve.capSel = null; ve.capEditing = null;
    renderCapTrack();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    window.__toast && window.__toast(`🧹 Cleared ${n} caption line${n > 1 ? 's' : ''}. Ctrl+Z brings them back.`, 'good');
  }
  function updateCapButtons() {
    const on = capBlocksVisible();
    const s = $('#veSaveCaps'), st = $('#veCapStyle');
    const cl = $('#veClearCaps'); if (cl) cl.classList.toggle('hidden', !on);
    if (s) {
      // Three scopes, three different exports — the button must not offer to burn
      // a whole-video file when the lane actually holds several shorts' captions.
      const shortsMode = ve._capMode === 'shorts' && !ve.capTarget;
      s.classList.toggle('hidden', !on || shortsMode);
      // per-short captions burn onto THAT short; whole-video captions onto the video
      putText(s, ve.capTarget ? '💾 Save short with captions' : '💾 Save with captions');
      s.title = ve.capTarget
        ? `Export "${ve.capTarget.label}" with the captions on the timeline burned in (top quality)`
        : 'Export the video with the captions on the timeline burned in (top quality)';
    }
    if (st) st.classList.toggle('hidden', !on);
    const lbl = $('#veCapLabel');
    putText(lbl, on ? `💬 Captions (${ve.capEvents.length})` : '💬 Captions');
  }
  function attr2(s) { return escape2(s).replace(/"/g, '&quot;'); }
  function renderCapTrack() {
    const track = ve.refs.capTrack; if (!track) return;
    if (ve.capEditing != null) return; // never clobber a caption block mid-edit
    updateCapButtons();
    if (!capBlocksVisible()) {
      track.innerHTML = `<div class="ve-cap-empty">💬 Run “Auto-captions” — every spoken line lands here as a block: click it to retype the words, drag it to move, drag its edges to re-time.</div>`;
      return;
    }
    /*
     * Only build the blocks that are ON SCREEN.
     *
     * A whole service transcribes to something like 1500 lines, and this used
     * to make a node for every one of them — with two listeners each — on every
     * zoom step and every render. That is 1500 nodes and 3000 listeners rebuilt
     * sixty times a second while the wheel is turning, which is the single
     * biggest reason the timeline crawled on a long sermon. The visible window
     * holds a few dozen; the rest cannot be seen, clicked or dragged, so
     * building them was pure cost.
     *
     * `data-i` still carries each line's REAL index into ve.capEvents, so every
     * handler, the selection and the editor keep working unchanged — and the
     * selected and being-edited lines are always included even when scrolled
     * off, so a click never lands on a block that has just been culled away.
     */
    const evs = ve.capEvents;
    const [from, to] = visibleTimeRange();
    const keep = (c, i) => (capAbsEnd(c) >= from && capAbs(c) <= to) || i === ve.capSel || i === ve.capEditing;
    const vis = [];
    for (let i = 0; i < evs.length; i++) if (keep(evs[i], i)) vis.push(i);
    /*
     * ZOOMED RIGHT OUT, culling by what is on screen saves nothing — the whole
     * sermon IS on screen, and all 1500 lines qualify. Each one is then about
     * half a pixel wide: impossible to read, click or drag, and 1500 of them
     * cost ~77 ms per render, which was most of the lag when zooming out.
     *
     * So below the width at which a block is any use at all, the lane draws
     * WHERE the captions are instead of what they say: neighbouring lines merge
     * into a few coverage bars, a couple of dozen nodes instead of fifteen
     * hundred. Clicking one zooms in to the words. Nothing is hidden that could
     * have been read — at this scale there was nothing to read.
     */
    const medLen = vis.length
      ? (evs[vis[Math.floor(vis.length / 2)]].end - evs[vis[Math.floor(vis.length / 2)]].start)
      : 0;
    const tooNarrow = vis.length > CAP_DENSE_MIN && medLen * ve.pxPerSec < CAP_MIN_BLOCK_PX;
    if (tooNarrow) {
      // The selected line keeps its own block on top of the summary, so a
      // selection never disappears just because the view was zoomed out.
      const selHtml = ve.capSel != null && evs[ve.capSel] ? capBlockHtml(evs[ve.capSel], ve.capSel) : '';
      track.innerHTML = capCoverageHtml(evs, vis) + selHtml;
      wireCapCoverage(track);
      wireCapBlocks(track);
      return;
    }
    track.innerHTML = vis.map((i) => capBlockHtml(evs[i], i)).join('');
    wireCapBlocks(track);
  }

  /** Click / drag / edit behaviour for whatever caption blocks are on the lane. */
  function wireCapBlocks(track) {
    $$('.ve-cap-clip', track).forEach((el) => {
      const i = +el.dataset.i;
      // double-click a block to retype its words
      el.addEventListener('dblclick', (ev) => { ev.stopPropagation(); ev.preventDefault(); editCaption(i); });
      el.addEventListener('mousedown', (ev) => {
        if (ve.capEditing === i) return; // typing — let the caret work
        ev.stopPropagation();
        const c = ve.capEvents[i]; if (!c) return;
        const edge = ev.target && ev.target.dataset ? ev.target.dataset.cedge : null;
        // select in place (don't re-render — that would replace the node a
        // double-click needs to stay stable to fire). Selection is exclusive
        // across tracks so Delete/Space act on the caption, not a hidden clip.
        ve.capSel = i; ve.activeRow = 'caption';
        ve.sel = null; ve.audioSel = null; ve.textSel = null;
        document.querySelectorAll('#veSegments .ve-seg.sel, #veAudioTrack .ve-audio-seg.sel, #veTextTrack .ve-text-clip.sel').forEach((n) => n.classList.remove('sel'));
        $$('.ve-cap-clip', track).forEach((n) => n.classList.toggle('sel', +n.dataset.i === i));
        let moved = false;
        const off = capOff();
        const x0 = ev.clientX, s0 = c.start, e0 = c.end;
        const move = (e) => {
          if (Math.abs(e.clientX - x0) > 3) moved = true;
          const dt = (e.clientX - x0) / ve.pxPerSec;
          // snap in ABSOLUTE time (that's what the ruler/clips live in), store relative
          if (edge === 'l') c.start = clamp(snapT(off + s0 + dt).t - off, -off, c.end - 0.2);
          else if (edge === 'r') c.end = clamp(snapT(off + e0 + dt).t - off, c.start + 0.2, dur() - off);
          else {
            const len = e0 - s0;
            let na = clamp(off + s0 + dt, 0, dur() - len);
            const sl = snapT(na), sr = snapT(na + len);
            if (sl.snapped) na = clamp(sl.t, 0, dur() - len);
            else if (sr.snapped) na = clamp(sr.t - len, 0, dur() - len);
            c.start = na - off; c.end = c.start + len;
          }
          // Move just THIS node — a full re-render of a sermon's ~1500 caption
          // blocks on every mousemove would make the drag crawl.
          el.style.left = Math.max(0, capAbs(c)) * ve.pxPerSec + 'px';
          el.style.width = Math.max(6, (c.end - c.start) * ve.pxPerSec) + 'px';
          updateCapOverlay(ve.refs.player.currentTime || 0);
        };
        const up = () => {
          document.removeEventListener('mousemove', move);
          if (moved) { renderCapTrack(); renderCapList(); return; }
          if (edge) return;
          seekTo(capAbs(c));   // a plain click previews the caption…
          editCaption(i);      // …and drops you straight into typing it
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up, { once: true });
      });
    });
  }
  /*
   * When individual caption blocks stop being worth their cost.
   *
   * Narrower than ~24px a block cannot hold even part of a word or be grabbed
   * by its edges, so it is a coloured sliver — and at one pixel per second on a
   * three-hour sermon there are SIX HUNDRED of those in view at once, which is
   * where the zoomed-out end of the timeline was spending its frame budget.
   * (An earlier version of this used 3px, which drew slivers right up until
   * they were literally sub-pixel and fixed almost nothing — measured at 18 fps
   * across the ordinary editing range.)
   *
   * Both conditions have to hold: a handful of narrow blocks is cheap and worth
   * keeping, so the summary only replaces them once there are enough for the
   * count to matter.
   */
  const CAP_MIN_BLOCK_PX = 24;
  /*
   * 60, not 250. The script cost of drawing narrow blocks was never the
   * problem once the lane was culled — 250 of them build in under 2 ms — but
   * PAINTING 250 bordered, shadowed, texted boxes every frame costs the
   * compositor about half the frame budget. Measured directly, by taking the
   * captions away and re-running the identical sweep: 28.6 fps with them,
   * 60.2 without. Sixty blocks is where that cost stops mattering.
   */
  const CAP_DENSE_MIN = 60;

  /** Merge run-together caption lines into a handful of coverage bars. */
  function capCoverageHtml(evs, vis) {
    const joinSec = 6 / ve.pxPerSec;   // a gap under ~6px isn't visible as a gap
    const runs = [];
    for (const i of vis) {
      const a = capAbs(evs[i]), b = capAbsEnd(evs[i]);
      const last = runs[runs.length - 1];
      if (last && a - last.b <= joinSec) { last.b = Math.max(last.b, b); last.n++; }
      else runs.push({ a, b, n: 1, i });
    }
    return runs.map((r) => {
      const left = Math.max(0, r.a) * ve.pxPerSec;
      const w = Math.max(2, (r.b - r.a) * ve.pxPerSec);
      return `<div class="ve-cap-run" data-capzoom="${r.i}" style="left:${left}px;width:${w}px;"`
        + ` title="${r.n} caption line${r.n === 1 ? '' : 's'} here — click to zoom in and read them">`
        + (w > 120 ? `<span>💬 ${r.n} lines — click to zoom in</span>` : '') + `</div>`;
    }).join('');
  }
  /**
   * A coverage bar has to behave like the slivers it replaced: clicking one
   * zooms in AND puts the caret in the line you pointed at.
   *
   * Zooming alone would be a regression dressed up as an optimisation — the
   * whole point of clicking a caption at this scale is to get at its words, and
   * "it zoomed but you still have to find the line" is not the same feature.
   * The line is chosen from WHERE along the bar the click landed, so pointing
   * at the end of a five-minute run does not open the line at its start.
   */
  function wireCapCoverage(track) {
    $$('[data-capzoom]', track).forEach((el) => {
      el.addEventListener('click', (ev) => {
        const r = el.getBoundingClientRect();
        const at = (el.offsetLeft + (ev.clientX - r.left)) / ve.pxPerSec;
        const evs = ve.capEvents || [];
        let best = +el.dataset.capzoom, bestD = Infinity;
        for (let i = 0; i < evs.length; i++) {
          const mid = (capAbs(evs[i]) + capAbsEnd(evs[i])) / 2;
          const d = Math.abs(mid - at);
          if (d < bestD) { bestD = d; best = i; }
        }
        editCaption(best);   // zooms in far enough to read, then starts typing
      });
    });
  }

  function capBlockHtml(c, i) {
    const left = Math.max(0, capAbs(c)) * ve.pxPerSec;
    const width = Math.max(6, (c.end - c.start) * ve.pxPerSec);
    const tiny = width < 44; // no room for grip handles — the words get the space
    // a line sitting inside a pause the user removed won't be in the export — show
    // it greyed out rather than letting them edit words that will never appear
    const dropped = capLineDropped(c);
    const tip = dropped
      ? `${fmt(capAbs(c))} – ${fmt(capAbsEnd(c))}\n${c.text}\n(inside a removed pause — won't be in the export)`
      : `${fmt(capAbs(c))} – ${fmt(capAbsEnd(c))}\n${c.text}\n(click to edit)`;
    return `<div class="ve-cap-clip${ve.capSel === i ? ' sel' : ''}${tiny ? ' tiny' : ''}${dropped ? ' cut' : ''}" data-i="${i}" style="left:${left}px;width:${width}px;" title="${attr2(tip)}">`
      + (tiny ? '' : `<div class="ve-cc-h l" data-cedge="l" title="Drag to change when this caption starts"></div>`)
      + `<span class="ve-cc-label" style="font-family:'${capFontFamily()}',system-ui,sans-serif">${escape2(c.text)}</span>`
      + (tiny ? '' : `<div class="ve-cc-h r" data-cedge="r" title="Drag to keep this caption on screen longer"></div>`)
      + `</div>`;
  }
  /** Scroll the timeline so caption i is comfortably on screen. */
  function scrollCapIntoView(i) {
    const c = (ve.capEvents || [])[i], sc = ve.refs.tlScroll;
    if (!c || !sc) return;
    const x = capAbs(c) * ve.pxPerSec + tlPadL(), w = (c.end - c.start) * ve.pxPerSec;
    const pad = 60;
    if (x - pad < sc.scrollLeft) sc.scrollLeft = Math.max(0, x - pad);
    else if (x + w + pad > sc.scrollLeft + sc.clientWidth) sc.scrollLeft = x + w + pad - sc.clientWidth;
  }
  /**
   * Zoom the timeline in until a TYPICAL caption line is wide enough to read its
   * words (CapCut behaviour). At "Fit" on a 60-minute sermon a caption is a
   * fraction of a pixel wide — the words are there but invisible, which is exactly
   * the "I can't see my captions" problem. Never zooms OUT.
   */
  function zoomForCaptions(i) {
    const evs = ve.capEvents || [];
    if (!evs.length || !ve.video) return false;
    const lens = evs.map((c) => Math.max(0.25, c.end - c.start)).sort((a, b) => a - b);
    const med = lens[Math.floor(lens.length / 2)] || 1.5;
    const want = clamp(170 / med, 1, 100); // ~170px on the median line, i.e. a whole phrase
    if (ve.pxPerSec >= want) { scrollCapIntoView(i == null ? 0 : i); return false; }
    setZoom(want, false);
    scrollCapIntoView(i == null ? 0 : i);
    return true;
  }
  /**
   * CLICK-TO-EDIT: put the caret straight into a caption's words. If the block is
   * currently too narrow to read/type in, zoom in first so the user always lands
   * on something they can actually see.
   */
  function editCaption(i) {
    const c = (ve.capEvents || [])[i]; if (!c) return;
    if ((c.end - c.start) * ve.pxPerSec < CAP_READABLE_PX) zoomForCaptions(i);
    else scrollCapIntoView(i);
    startEditingCap(i);
  }
  /** Save whatever caption line is being typed into right now (if any). */
  function commitCapEdit() {
    if (ve.capEditing == null) return;
    const lab = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label');
    if (lab) {
      lab.blur();
      // a window that was never focused won't fire blur() — force the commit
      if (ve.capEditing != null) lab.dispatchEvent(new FocusEvent('blur'));
    }
    ve.capEditing = null;
  }
  /** Inline-edit a caption block's text on the timeline (contenteditable). */
  function startEditingCap(i) {
    const track = ve.refs.capTrack; if (!track) return;
    // The lane only builds the blocks near the viewport, and getting here often
    // means the view has just been scrolled or zoomed to this line — so the
    // block may not have been drawn yet. Draw it now rather than silently doing
    // nothing, which is how "click to edit" would appear broken on a long
    // sermon at exactly the moment it matters.
    let el = track.querySelector(`.ve-cap-clip[data-i="${i}"]`);
    if (!el) { ve.capSel = i; renderCapTrack(); el = track.querySelector(`.ve-cap-clip[data-i="${i}"]`); }
    if (!el) return;
    const label = el.querySelector('.ve-cc-label'); if (!label) return;
    ve.capSel = i; ve.capEditing = i;
    // .editing pops the block out to a typable width even if its slice of time is
    // narrow, so you can always SEE the words you're typing.
    el.classList.add('editing', 'sel');
    label.setAttribute('contenteditable', 'true');
    label.style.userSelect = 'text'; label.style.webkitUserSelect = 'text';
    label.focus();
    try { const r = document.createRange(); r.selectNodeContents(label); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r); } catch (e) {}
    let next = null; // set by Tab: which line to hop to after committing
    const orig = ve.capEvents[i] ? ve.capEvents[i].text : ''; // for Escape (typing is live)
    const commit = () => {
      if (ve.capEditing !== i) return;
      // Retyped lines go through the same cleaner as generated ones, so a full
      // stop can't sneak back in by hand. Cleaning happens HERE and not on every
      // keystroke — stripping a character mid-word would fight the caret.
      const txt = cleanCapText(label.textContent || '');
      ve.capEditing = null;
      if (ve.capEvents[i]) ve.capEvents[i].text = txt;
      if (label.textContent !== txt) label.textContent = txt;
      label.removeAttribute('contenteditable');
      el.classList.remove('editing');
      renderCapTrack(); renderCapList(); updateCapOverlay(ve.refs.player.currentTime || 0);
      // A line retyped on the LANE teaches exactly as much as one retyped in the
      // window, and there is one Word Book, so it goes through the same door.
      learnCaptionEdit(orig, txt, i);
      if (next != null && ve.capEvents[next]) { const n = next; next = null; editCaption(n); }
    };
    // live: the words on the preview change as you type, no need to commit first
    label.addEventListener('input', () => {
      if (ve.capEvents[i]) ve.capEvents[i].text = (label.textContent || '').replace(/\s+/g, ' ').trim();
      updateCapOverlay(ve.refs.player.currentTime || 0);
    });
    label.addEventListener('blur', commit, { once: true });
    label.addEventListener('keydown', (e) => {
      e.stopPropagation(); // don't fire timeline shortcuts (Del / Space / Ctrl+Z) while typing
      if (e.key === 'Enter') { e.preventDefault(); label.blur(); }
      else if (e.key === 'Tab') { // fly through the lines without touching the mouse
        e.preventDefault();
        next = e.shiftKey ? i - 1 : i + 1;
        if (!ve.capEvents[next]) next = null;
        label.blur();
      } else if (e.key === 'Escape') { // cancel — put the original words back
        e.preventDefault(); ve.capEditing = null;
        if (ve.capEvents[i]) ve.capEvents[i].text = orig;
        label.textContent = orig;
        label.removeAttribute('contenteditable'); el.classList.remove('editing');
        renderCapTrack(); renderCapList(); updateCapOverlay(ve.refs.player.currentTime || 0);
      }
    });
  }
  function selectedTextOverlay() { return ve.textOverlays.find((o) => o.id === ve.textSel) || null; }
  /**
   * Map the text overlays overlapping a clip into the SHORT's OUTPUT frame, so
   * added text is ALWAYS inside the exported picture (e.g. the 9:16 crop) no
   * matter how auto-reframe moves the window. Like CapCut, text is fixed to the
   * screen — it does not drift with the camera — and it's clamped to a safe area
   * so it can never fall outside the frame.
   */
  /**
   * The preview geometry every text export maps from: the export-ratio canvas
   * frame (what the operator sees the short inside) and the preview's own size.
   * The frame IS the exported picture, so `output px = preview px × (outW/fr.w)`.
   */
  function textExportGeom() {
    const preset = ve.presets[ve.aspect] || { w: 1080, h: 1920 };
    const cw = ve.refs.preview.clientWidth || 1, chh = ve.refs.preview.clientHeight || 1;
    // ONE answer to "what gets exported", shared with the media overlay lane —
    // it also knows about a batch and about a blurred fill, which this used to
    // decide for itself from the aspect ratios alone.
    return { cw, chh, fr: outputFrameRect(), preset };
  }
  /** Text overlays overlapping this clip's range (in timeline order).
   *  A clip being exported in the background reads the copy frozen when it
   *  started, so text typed since cannot appear in a file already half written. */
  function textOverlaysFor(s) {
    const all = (F(s) && F(s).textOverlays) || ve.textOverlays;
    return all.filter((o) => o.start < s.end && o.end > s.start && (o.text || '').trim());
  }
  function overlaysForShortExport(s) {
    if (!ve.video) return null;
    const ovs = textOverlaysFor(s);
    if (!ovs.length) return null;
    // WYSIWYG: the canvas frame in the preview IS the exported picture, so the
    // text's position/size RELATIVE TO THE FRAME maps 1:1 into the output — no
    // matter whether the export is centre-cropped, manually panned, or face-tracked
    // (text is fixed to the screen, like CapCut).
    const SAFE = 0.03; // slim safe margin — text can sit high/low; the .ass glyph clamp prevents any cut-off
    return ovs.map((o) => ({
      text: o.text,
      x: clamp(o.x, SAFE, 1 - SAFE),
      y: clamp(o.y, SAFE, 1 - SAFE),
      start: Math.max(0, o.start - s.start),
      end: Math.min(s.end - s.start, Math.max(0.1, o.end - s.start)),
      font: o.font, bold: o.bold, color: o.color, bg: o.bg, bgColor: o.bgColor,
      // The outline travels as an explicit yes/no. The subtitle burner's own
      // default is to draw one, so leaving it out meant this fallback put a
      // black edge on text the preview showed without any — the exact drift the
      // rasterised path exists to stop.
      outline: !!o.outline, outlineColor: o.outlineColor || '#000000',
      sizePct: o.sizePct,   // already a fraction of the frame, which is what the burn wants
      anim: TEXT_ANIM_IDS.includes(o.anim) ? o.anim : 'none',
    }));
  }
  /* ------------------ WYSIWYG text: preview == export ------------------
   * The exported text is RASTERISED FROM THE SAME HTML/CSS THE PREVIEW DRAWS,
   * at the export resolution, and composited by ffmpeg as a transparent PNG.
   *
   * Why not subtitles (.ass), which is what this used to do: libass is a second,
   * independent text engine. Its line breaking, glyph metrics, outline and box
   * padding are NOT Chromium's, so the burned words came out a different size,
   * on a different number of lines, with a black outline the preview never
   * showed — the exact "the text isn't what I placed" report. One renderer, one
   * result: whatever you see on the canvas is what lands in the file.
   */
  let _ovlFontCss = null;
  /**
   * @font-face rules with the font bytes INLINED — file:// fonts do not load
   * inside the SVG-foreignObject rasteriser, data: URIs do.
   *
   * EVERY bundled typeface is inlined, not the four the text toolbar used to
   * offer, because Add text now offers the same list the captions do. Each file
   * is registered twice: under the family recorded INSIDE it ("Rubik ExtraBold")
   * and under the name the operator picked ("Rubik"). CSS will only match the
   * former; the overlays are stored with the latter. Registering both means a
   * font can never silently fall back to Arial in the exported picture — which
   * is the quietest way for an export to stop matching its preview.
   */
  /* "BebasNeue-Regular.ttf" and "Bebas Neue" are the same typeface; these are the
   * keys that say so.
   *
   * The weight suffix comes off a FILE name only when a hyphen or underscore
   * introduces it — that is the convention these files are named by, and each
   * family ships as exactly one file, so "Rubik-ExtraBold.ttf" IS the app's
   * Rubik. It must NOT come off a typeface name: "Archivo Black" is a family,
   * not Archivo in a heavy weight, and stripping it there stopped the file from
   * ever matching the name the operator picked. */
  const flatten = (s) => String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const fileKey = (s) => flatten(String(s || '')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_](regular|book|bold|black|extrabold|semibold|medium|light|italic)$/i, ''));
  const nameKey = (s) => flatten(s);

  async function overlayFontCss() {
    if (_ovlFontCss != null) return _ovlFontCss;
    await loadCapFonts();
    const byFile = new Map();   // exact filename -> the names to register it under
    const byKey = new Map();    // normalised typeface key -> the same
    const add = (map, k, names) => {
      if (!k) return;
      const have = map.get(k) || new Set();
      names.filter(Boolean).forEach((n) => have.add(n));
      map.set(k, have);
    };
    for (const f of CAP_FONTS) {
      const names = [f.family, f.name];
      if (f.file) add(byFile, String(f.file).toLowerCase(), names);
      // …and by typeface name, so the picker's list still resolves to the right
      // file if the main process could not tell us which file that was. A font
      // that silently falls back to a system face is the quietest way for an
      // export to stop matching its preview, and it must not be possible.
      add(byKey, nameKey(f.name), names);
      add(byKey, nameKey(f.family), names);
    }
    let css = '';
    try {
      const fonts = await window.api.fonts.data();
      const seen = new Set();
      for (const f of fonts || []) {
        const names = byFile.get(String(f.file).toLowerCase()) || byKey.get(fileKey(f.file));
        if (!names) continue;
        const src = `url(data:font/ttf;base64,${f.base64}) format('truetype')`;
        for (const n of names) {
          const fam = String(n).replace(/['"\\;{}]/g, '');
          if (seen.has(fam)) continue;   // first file wins; no duplicate faces
          seen.add(fam);
          css += `@font-face{font-family:'${fam}';src:${src};font-weight:400 900;font-style:normal;}`;
        }
      }
    } catch (e) { /* system fonts still render */ }
    _ovlFontCss = css;
    return css;
  }
  /**
   * One overlay as absolutely-positioned HTML on an outW×outH transparent page.
   * Every length is the PREVIEW's own length multiplied by k — including the
   * box's padding and border — so the text wraps at exactly the same words.
   */
  /**
   * Where an overlay lands in the output, in OUTPUT pixels.
   *  'frame'  — the export is the canvas frame (a short). Everything is the
   *             preview's own measurement times one scale factor.
   *  'source' — the export is the WHOLE video at its own size (the "save with
   *             captions" path). The preview may be showing that video moved and
   *             zoomed under the canvas frame, so the placement has to be taken
   *             back through that transform to land on the right part of the
   *             picture.
   */
  function overlayLayout(o, g, mode, outW, outH) {
    /*
     * x / y / w / sizePct are all fractions of the EXPORT FRAME, so the 'frame'
     * answer contains no preview geometry at all — the same numbers give the same
     * export whether they were placed on a 113-pixel preview or a full-screen
     * one. That is the whole reason the three previews now agree.
     */
    if (mode !== 'source') {
      return {
        left: o.x * outW,
        top: o.y * outH,
        width: o.w * outW,
        fontPx: Math.max(1, (o.sizePct || 0.11) * outH),
        k: outW / Math.max(1, g.fr.w),
      };
    }
    // The export keeps the WHOLE picture: take the frame fraction to a point on
    // the preview, undo the translate+scale the picture is under, and read it off
    // the video's own rect.
    const map = previewMapping();
    const cm = ve.canvasMap;
    const s = cm ? cm.s : 1;
    const Tx = cm ? cm.Fx - cm.Cx : 0, Ty = cm ? cm.Fy - cm.Cy : 0;
    const Cx = cm ? cm.Cx : 0, Cy = cm ? cm.Cy : 0;
    const px = g.fr.left + o.x * g.fr.w, py = g.fr.top + o.y * g.fr.h;
    const qx = (px - Cx - Tx) / s + Cx;
    const qy = (py - Cy - Ty) / s + Cy;
    const fx = (qx - map.offX) / Math.max(1, map.renderedW);
    const fy = (qy - map.offY) / Math.max(1, map.renderedH);
    const fontPreviewPx = Math.max(1, (o.sizePct || 0.11) * g.fr.h);
    return {
      left: fx * outW,
      top: fy * outH,
      width: ((o.w * g.fr.w) / s / Math.max(1, map.renderedW)) * outW,
      fontPx: (fontPreviewPx / s / Math.max(1, map.renderedH)) * outH,
      k: (1 / s / Math.max(1, map.renderedH)) * outH,
    };
  }
  function textOverlayHtml(o, g, mode, outW, outH) {
    const px = (v) => (Math.round(v * 1000) / 1000) + 'px';
    const { left, top, width, fontPx, k } = overlayLayout(o, g, mode, outW, outH);
    // Same look function the preview draws from — see textLookCss.
    /*
     * No padding and no border here, and none on .ve-text-box either.
     *
     * They used to be 2px/6px and 1.5px — FIXED pixels on the preview, scaled by
     * k for the export. Fixed pixels are 15% of a 97-pixel box in the small
     * preview and 3% of a 521-pixel one in full screen, so the words wrapped
     * differently in each: the operator's complaint that the big preview and
     * full screen "do not match the small default preview". The dashed drag box
     * is now an outline, which costs no layout at all, and the text's width is
     * exactly its share of the frame in every one of them.
     */
    return `<div style="position:absolute;left:${px(left)};top:${px(top)};width:${px(width)};` +
      `transform:translate(-50%,-50%);box-sizing:border-box;white-space:normal;">` +
      `<div style="${textLookCss(o, fontPx)}">` +
      `${escape2(o.text)}</div></div>`;
  }
  /** Rasterise every overlay overlapping this clip into transparent PNGs sized
   *  to the export frame, with clip-relative show/hide times. */
  async function textOverlayPngs(s, outW, outH, mode) {
    if (!ve.video) return null;
    const ovs = textOverlaysFor(s);
    if (!ovs.length) return null;
    // Measured off the preview element, so it MUST be the frozen reading for a
    // background export: in another studio #view-video is display:none and the
    // live measurement is a frame 0px wide.
    const g = (F(s) && F(s).geom) || textExportGeom();
    if (!g.fr || !g.fr.w || !g.fr.h) return null;
    // The app's global `* { box-sizing: border-box }` is NOT inside the
    // rasteriser's document — without it the text box's padding is ADDED to the
    // width instead of taken out of it, the line breaks land somewhere else and
    // the export stops matching the preview. Ship the same rule with the page.
    const css = '*{box-sizing:border-box;}' + await overlayFontCss();
    const page = `position:relative;width:${outW}px;height:${outH}px;overflow:hidden;`;
    const out = [];
    for (const o of ovs) {
      const body = `<div style="${page}">${textOverlayHtml(o, g, mode, outW, outH)}</div>`;
      const png = await window.rasterizeFlyer(css, body, outW, outH, { transparent: true });
      // through srcToOut, so text after a closed pause, a deleted stretch or a
      // transition still lands on the words it was placed against
      const start = outTime(s, o.start, 'start');
      // …and where its middle is, which a pop or zoom grows around
      const lay = overlayLayout(o, g, mode, outW, outH);
      out.push({
        png,
        start: Math.max(0, start),
        end: Math.max(start + 0.1, Math.min(outTime(s, s.end, 'end'), outTime(s, o.end, 'end'))),
        anim: TEXT_ANIM_IDS.includes(o.anim) ? o.anim : 'none',
        cx: lay.left / outW, cy: lay.top / outH,
      });
    }
    return out;
  }
  /* ------------- WYSIWYG captions: the preview IS the export -------------
   *
   * Captions used to be burned by libass from an .ass file — a second, entirely
   * independent text engine. It broke lines differently (WrapStyle 2 does not
   * wrap AT ALL), measured its outline from the other side of the glyph, and
   * anchored a multi-line block from its bottom edge rather than its middle. So
   * "IN NIGERIA WE" sat on three lines on the preview and on one in the file.
   * No amount of tuning fixes that, because it is two engines answering the same
   * question.
   *
   * Now there is one engine. The caption track is RASTERISED FROM THE SAME
   * LAYOUT THE PREVIEW DRAWS (window.CapLayout), at the export resolution, and
   * handed to ffmpeg as a strip of transparent frames composited in one pass.
   *
   * Cost is kept honest by only ever drawing what CHANGES: the track is sampled
   * at 30fps and consecutive identical states collapse into one frame with a
   * long duration, so a line that sits still for two seconds is one PNG, not
   * sixty. An arrival (pop / bounce / fade / zoom / typewriter) is the handful
   * of frames it actually animates for.
   */
  const CAP_TRACK_FPS = 30;
  /* Past this many DISTINCT frames the rasteriser stops being a reasonable way
   * to spend the operator's time — roughly a minute of drawing, which a
   * whole-sermon burn with an arrival on every line would sail past. Beyond it
   * the .ass fallback takes over, with the same line breaks and the same anchor
   * point out of CapLayout, so it is this layout drawn by the other engine. A
   * ten-minute short with the default Pop arrival is around 2,000 frames, so
   * every short lands well inside it. */
  const CAP_TRACK_MAX_FRAMES = 2500;
  /* Highlight mode redraws on every WORD rather than on every line, so the same
   * video needs roughly three times as many distinct frames — a 16-minute
   * teaching is about 3,400. Refusing at 2,500 would push the one look that most
   * needs the rasteriser onto the fallback engine, so it gets its own ceiling.
   * The frames are small (only the caption band is ever drawn) and each is a
   * recolour of a line already laid out, so the extra cost is far below 3× the
   * time — measured on the 16-minute teaching, not assumed. */
  const CAP_TRACK_MAX_FRAMES_HL = 9000;
  const capTrackCeiling = (cfg) => (window.CapLayout.highlightOn(cfg) ? CAP_TRACK_MAX_FRAMES_HL : CAP_TRACK_MAX_FRAMES);

  /** The one rectangle of the export frame the captions can ever touch. Only
   *  this band is rasterised — a 1080×1920 page per frame would cost 4× as much
   *  to draw and encode for pixels that are transparent in every one of them. */
  function capTrackBand(events, cfg, outW, outH, layouts) {
    const k = window.CapLayout.maxScale(cfg.transition);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    events.forEach((e, i) => {
      const L = layouts[i];
      if (!L || !L.lines.length) return;
      // room for the outline's overhang and for the glow/drop shadow, which are
      // drawn OUTSIDE the block's own box
      const pad = L.m.fontPx * 0.6 + L.m.outlinePx * 2;
      x0 = Math.min(x0, L.cx - (L.blockW * k) / 2 - pad);
      x1 = Math.max(x1, L.cx + (L.blockW * k) / 2 + pad);
      y0 = Math.min(y0, L.cy - (L.blockH * k) / 2 - pad);
      y1 = Math.max(y1, L.cy + (L.blockH * k) / 2 + pad);
    });
    if (!Number.isFinite(x0)) return null;
    // even edges and sizes: an odd overlay offset is a chroma-subsampling bug
    // waiting to happen on the yuv420 output
    const bx = Math.max(0, Math.floor(x0 / 2) * 2), by = Math.max(0, Math.floor(y0 / 2) * 2);
    const w = Math.min(Math.max(2, Math.ceil((Math.ceil(x1) - bx) / 2) * 2), outW - bx);
    const h = Math.min(Math.max(2, Math.ceil((Math.ceil(y1) - by) / 2) * 2), outH - by);
    return { x: bx, y: by, w, h };
  }

  /**
   * The track as a list of {which caption, what state, how many frames} — the
   * frames that actually differ. Ties go to the LATER line, matching the preview
   * (whisper ends one line exactly where the next begins).
   */
  function capTrackSegments(events, cfg, durationSec, fps) {
    const total = Math.max(1, Math.ceil(durationSec * fps));
    const active = new Int32Array(total).fill(-1);
    events.forEach((e, j) => {
      const a = Math.max(0, Math.round(e.start * fps));
      const b = Math.min(total, Math.round(e.end * fps));
      for (let i = a; i < b; i++) active[i] = j;
    });
    // In highlight mode the picture also changes on every WORD, not only on
    // every line, so the word being spoken is part of what makes a frame
    // distinct. Costed once per line rather than once per frame: a sermon's
    // worth of captions asks this question tens of thousands of times.
    const hlOn = window.CapLayout.highlightOn(cfg);
    const words = hlOn ? events.map((e) => window.CapLayout.wordTimes(e)) : null;
    const q = (v) => Math.round(v * 1000) / 1000;
    const segs = [];
    for (let i = 0; i < total; i++) {
      const j = active[i];
      let st = null, key = 'blank';
      if (j >= 0) {
        const e = events[j];
        const s = window.CapLayout.stateAt(cfg.transition, i / fps - e.start, e.end - e.start, String(e.text).length);
        const hl = hlOn ? window.CapLayout.activeWord(words[j], i / fps) : -1;
        st = { sx: q(s.sx), sy: q(s.sy), opacity: q(s.opacity), chars: s.chars == null ? null : s.chars, hl };
        key = j + '|' + st.sx + '|' + st.sy + '|' + st.opacity + '|' + st.chars + '|' + hl;
      }
      const last = segs[segs.length - 1];
      if (last && last.key === key) { last.frames++; continue; }
      segs.push({ key, ev: j, state: st, frames: 1 });
    }
    return segs;
  }

  /**
   * Rasterise the caption track for one export. Returns null when there is
   * nothing to draw or when it would be too long to draw honestly — the caller
   * falls back to the .ass burn in that case, never to no captions at all.
   */
  async function capTrackForExport(events, cfg, outW, outH, durationSec, onProgress, onStage) {
    const list = (events || []).filter((e) => e && e.text && String(e.text).trim());
    if (!list.length) return null;
    /*
     * ►► THE FONTS ARE LOADED BEFORE A SINGLE FRAME IS DRAWN. ◄◄
     *
     * Twenty-two families, fetched and registered, and on a first captioned
     * export that measured ELEVEN SECONDS in which this function reported
     * nothing whatsoever. The export's progress number had nothing to go on,
     * so it sat still — which is what "it looks stuck" was.
     *
     * It is not work that can be given a percentage (the browser decides when
     * a face is ready), so it is given a NAME instead: the operator is told
     * what is happening, and the number creeps underneath it.
     */
    if (onStage) onStage('🔤 Getting the caption fonts ready…');
    await loadCapFonts();
    // the faces must actually BE fetched before anything is measured, or the
    // first caption is wrapped against Arial and every line break is wrong
    await loadCapFontFaces();
    if (onStage) onStage('💬 Drawing the captions exactly as you see them…');
    if (onProgress) onProgress(1);
    const layouts = list.map((e) => window.CapLayout.layout(e.text, cfg, outW, outH));
    const band = capTrackBand(list, cfg, outW, outH, layouts);
    if (!band || band.w < 2 || band.h < 2) return null;
    const fps = CAP_TRACK_FPS;
    const segs = capTrackSegments(list, cfg, durationSec, fps);
    if (!segs.length || segs.length > capTrackCeiling(cfg)) return null;

    // The app's global `* { box-sizing: border-box }` is NOT inside the
    // rasteriser's document, and without it every padded caption band measures
    // differently there than it does here.
    const css = '*{box-sizing:border-box;margin:0;padding:0;}' + await overlayFontCss();
    const page = (inner) => `<div style="position:relative;width:${band.w}px;height:${band.h}px;overflow:hidden;">${inner}</div>`;
    const mk = () => { const c = document.createElement('canvas'); c.width = band.w; c.height = band.h; return c; };
    const baseCanvas = mk(), work = mk();
    const wg = work.getContext('2d');
    wg.imageSmoothingEnabled = true; wg.imageSmoothingQuality = 'high';
    let baseKey = null;
    let lastSaid = 0;
    const frames = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const dur = s.frames / fps;
      if (s.ev < 0) { frames.push({ png: null, dur }); continue; }
      const e = list[s.ev], L = layouts[s.ev], st = s.state;
      const draw = (state, canvas) => window.rasterizeToCanvas(
        css,
        page(window.CapLayout.html(e.text, cfg, outW, outH, { layout: L, state, originX: band.x, originY: band.y })),
        band.w, band.h, { transparent: true, canvas });
      let png;
      if (st.sx > 1.001 || st.sy > 1.001) {
        // Blowing a finished bitmap UP would soften the glyphs, so the words are
        // laid out at that size instead — a zoom arrives as crisp as it lands.
        // This draws into the WORK canvas, so the cached base survives (a bounce
        // goes small, big, then settles, and would otherwise re-lay-out twice).
        await draw(st, work);
        png = await window.canvasToPngBytes(work);
      } else {
        // The cached base is "this line, drawn plain". The highlighted word is
        // part of that drawing, so it belongs in the key — without it every word
        // after the first would be stamped out wearing the first word's colour.
        const bk = s.ev + '|' + st.chars + '|' + st.hl;
        if (baseKey !== bk) {
          const base = { hl: st.hl };
          if (st.chars != null) base.chars = st.chars;
          await draw(base, baseCanvas); baseKey = bk;
        }
        if (st.sx === 1 && st.sy === 1 && st.opacity === 1) {
          png = await window.canvasToPngBytes(baseCanvas);
        } else {
          const px = L.cx - band.x, py = L.cy - band.y;
          wg.setTransform(1, 0, 0, 1, 0, 0);
          wg.clearRect(0, 0, band.w, band.h);
          wg.globalAlpha = st.opacity;
          wg.translate(px, py); wg.scale(st.sx, st.sy); wg.translate(-px, -py);
          wg.drawImage(baseCanvas, 0, 0);
          wg.setTransform(1, 0, 0, 1, 0, 0); wg.globalAlpha = 1;
          png = await window.canvasToPngBytes(work);
        }
      }
      frames.push({ png, dur });
      /*
       * ►► TIME, NOT EVERY TENTH FRAME. ◄◄
       *
       * Rasterising a caption is expensive — it lays out HTML and draws it to a
       * canvas — so on a real short ten of them is many seconds. Reporting once
       * per ten frames meant this pass ran for ELEVEN SECONDS without a single
       * effective reading, and the export's progress number, having nothing to
       * go on, sat still: exactly the "it looks stuck" complaint.
       *
       * It also reported (i+1)/n, which reaches 100 while there is still work to
       * do. A pass never says it has finished; the next pass starting is what
       * settles it.
       */
      if (onProgress) {
        const now = Date.now();
        if (now - lastSaid > 120) {
          lastSaid = now;
          onProgress(Math.min(99, Math.round((i / segs.length) * 100)));
        }
      }
    }
    return { band, fps, authorW: outW, authorH: outH, frames };
  }

  /**
   * Burn captions into `input`, WYSIWYG if at all possible.
   *
   * One door for every route that burns captions (a single short, "caption all
   * my shorts on export", the whole video), so none of them can quietly end up
   * on a different engine from the others.
   */
  /*
   * `images` are the added-text overlays. When the captions are being burned
   * anyway they ride along in the SAME ffmpeg pass — one decode and one encode
   * instead of two, which on a 30-second short took the pair from 35.7 s to
   * 17.6 s and left one fewer re-encode between the operator and the picture.
   * The .ass fallback below cannot carry them, so on that route they are burned
   * the way they always were.
   */
  async function burnCapsInto({ input, events, size, label, outName, deleteInput, task, style, images }) {
    // `style` is the caption look frozen when a background export started — the
    // controls it is read off are in the DOM and the operator is still using them.
    const cfg = style || capStyleCfg();
    const list = (events || []).filter((e) => e && e.text && String(e.text).trim());
    const jobId = window.__newJobId();
    const msg = label ? `💾 Saving “${label}” with captions included…` : '💾 Saving your video with captions included…';
    // Draw at the file's OWN pixels, not at the preset's reference size — a 4K
    // short deserves 4K glyphs, and the layout is proportional either way.
    let real = null;
    try { real = await window.api.video.info(input); } catch (e) { real = null; }
    const w = capOutW(real || size), h = capOutH(real || size);
    let track = null;
    try {
      if (list.length && w && h) {
        const durationSec = Math.max(0.1, ...list.map((e) => e.end || 0));
        // Rasterising the track is renderer work with no jobId of its own, so it
        // says where it is through the task — the chip when this is in the
        // background, the overlay when it is not.
        const say = (m) => (window.__taskSay ? window.__taskSay(task, m, 'draw') : (window.__showOverlay && window.__showOverlay(m)));
        const pct = (p) => (window.__taskProgress ? window.__taskProgress(task, p) : (window.__setProgress && window.__setProgress(p)));
        say('💬 Drawing the captions exactly as you see them…');
        track = await capTrackForExport(list, cfg, w, h, durationSec, pct, say);
      }
    } catch (e) { track = null; }
    if (track) {
      return window.__runJob(msg, jobId, () => window.api.captions.burnTrack({
        input, track, jobId, outName, deleteInput, images: images || [],
      }), { task, chain: 'burn' });
    }
    /*
     * The subtitle burner draws the captions instead, and it has no way to carry
     * the text pictures — so they get their own pass here, exactly as they did
     * before the two were merged. Silently dropping them would be the worst of
     * the three possible outcomes.
     */
    if (images && images.length) {
      const jt = window.__newJobId();
      input = await window.__runJob('🔤 Adding your text…', jt,
        () => window.api.overlays.burnImages({ input, images, jobId: jt, deleteInput, outName: (outName || 'text') + '-text' }), { task, chain: 'burn' });
      deleteInput = true;
    }
    // Too long to rasterise, or the rasteriser is unavailable: the subtitle
    // burner still gets the SAME line breaks and the SAME anchor point out of
    // CapLayout, so it draws this layout with the other engine — not a layout of
    // its own. Say so rather than quietly changing engines: the whole point of
    // this work is that the operator is never surprised by the finished file.
    if (list.length) {
      window.__toast && window.__toast(
        '💬 That is a lot of caption lines, so they are being drawn by the subtitle burner instead. '
        + 'Same words, same line breaks, same place — the letter edges are drawn by the other engine.',
        '', 7000);
    }
    const p = capAssPayload(cfg, w, h, list);
    return window.__runJob(msg, jobId, () => window.api.captions.burn({
      input, events: p.events, opts: p.opts, jobId, outName, deleteInput,
    }), { task, chain: 'burn' });
  }
  /** The export frame the captions are laid out against. */
  const capOutW = (size) => (size && (size.w || size.width)) || (ve.presets[ve.aspect] || {}).w || 1080;
  const capOutH = (size) => (size && (size.h || size.height)) || (ve.presets[ve.aspect] || {}).h || 1920;

  /**
   * The .ass fallback's payload: the shared layout's answers in the shape the
   * subtitle burner understands. Each line carries its OWN pre-computed breaks
   * (libass honours an explicit break exactly, and nothing else), and the block's
   * centre travels as a point so a two-line caption is anchored the same way it
   * is on the preview.
   */
  function capAssPayload(cfg, w, h, events) {
    const opts = Object.assign({}, cfg);
    // The word times travel WITH the line, already aligned to the tokens that
    // will be drawn (CapLayout.wordTimes settles a hand-retyped line), so the
    // subtitle burner never has to work out which word is which for itself —
    // one definition of "the word being spoken", used by both engines.
    const out = (events || []).map((e) => ({
      start: e.start, end: e.end, text: e.text,
      words: window.CapLayout.highlightOn(cfg) ? window.CapLayout.wordTimes(e) : undefined,
    }));
    try {
      const first = out.find((e) => e.text);
      const L = window.CapLayout.layout(first ? first.text : 'X', cfg, w, h);
      opts.posX = L.cx / w;
      opts.posY = L.cy / h;
      out.forEach((e) => { e.lines = window.CapLayout.layout(e.text, cfg, w, h).lines; });
    } catch (er) { /* the burner's own presets still apply */ }
    return { opts, events: out };
  }

  /** Burn any text overlays onto a WHOLE-video export — same words, same place,
   *  mapped onto the full picture instead of a short's crop. Without this, text
   *  placed on the canvas silently vanished from "save with captions". */
  async function burnTextIntoWholeVideo(filePath) {
    if (!ve.video || !ve.textOverlays.length) return filePath;
    const info = ve.video.info || {};
    const w = info.width || 1920, h = info.height || 1080;
    let images = null;
    try { images = await textOverlayPngs({ start: 0, end: dur(), label: 'video' }, w, h, 'source'); }
    catch (e) { images = null; }
    if (!images || !images.length) return filePath;
    const jobId = window.__newJobId();
    return window.__runJob('🔤 Adding your text to the video…', jobId,
      () => window.api.overlays.burnImages({ input: filePath, images, jobId, deleteInput: true, outName: 'video-text' }));
  }
  /** Burn any overlapping text overlays INTO an exported short (mapped into its frame). */
  /** `size` overrides the export frame — "Export video" renders at the
   *  recording's own dimensions, not at the selected social preset. */
  /**
   * The added text as pictures, ready to composite — without running a pass.
   * Used when the captions are going to be burned too, so the two can share one
   * encode (see burnCapsInto). Null when there is no text, or it would not draw.
   */
  async function textImagesFor(s, size, mode) {
    if (!ve.video || !textOverlaysFor(s).length) return null;
    const preset = size || ve.presets[ve.aspect] || { w: 1080, h: 1920 };
    try {
      const imgs = await textOverlayPngs(s, preset.w, preset.h, mode);
      return (imgs && imgs.length) ? imgs : null;
    } catch (e) { return null; }
  }
  async function burnTextIntoShort(s, shortPath, size, ready) {
    if (!ve.video || !textOverlaysFor(s).length) return shortPath;
    const preset = size || ve.presets[ve.aspect] || { w: 1080, h: 1920 };
    const outName = `short-${(s.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-text`;
    let images = ready || null;
    if (!images) { try { images = await textOverlayPngs(s, preset.w, preset.h); } catch (e) { images = null; } }
    const jobId = window.__newJobId();
    // deleteInput: the text-less short is just an intermediate — only the final
    // file (with the text burned in) should land in the output folder.
    if (images && images.length) {
      return window.__runJob(`🔤 Adding your text to "${s.label}"…`, jobId,
        () => window.api.overlays.burnImages({ input: shortPath, images, jobId, deleteInput: true, outName }), J(s, 'text'));
    }
    // Rasterising failed (no renderer canvas?) — never lose the text: fall back
    // to the subtitle burn, which is close but not glyph-identical.
    const ovs = overlaysForShortExport(s);
    if (!ovs) return shortPath;
    return window.__runJob(`🔤 Adding your text to "${s.label}"…`, jobId,
      () => window.api.overlays.burn({ input: shortPath, overlays: ovs, jobId, deleteInput: true, outName }), J(s, 'text'));
  }
  /** Keep a text box's centre inside the visible export-frame guide (e.g. 9:16),
   *  so what you place in the preview is what actually fits in the short. */
  function clampTextIntoFrame(o) {
    const fr = outputFrameRect();
    if (!ve.video || !fr || fr.w <= 0 || fr.h <= 0) return;
    // account for the text's own rendered size (centre-anchored) so no part of it
    // can stick out of the export frame — same glyph estimate the burn side uses,
    // since the drag box is often wider than the words themselves
    const lines = String(o.text || '').split(/\n/);
    const maxLine = Math.max(1, ...lines.map((l) => l.length));
    const fontPx = textFontPx(o, fr.h);
    const el = ve.refs.textLayer && ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${o.id}"]`);
    // …measured as FRACTIONS OF THE FRAME, which is what o.x / o.y are
    const bw = Math.min(el ? el.offsetWidth : fr.w, maxLine * fontPx * 0.58) / fr.w;
    const bh = (el ? el.offsetHeight : lines.length * fontPx * 1.3) / fr.h;
    // slim margins so text can sit almost at the very top/bottom of the frame —
    // the burn side's own glyph clamp still guarantees nothing gets cut off
    const padX = Math.max(0.02, bw / 2), padY = Math.max(0.015, bh / 2);
    o.x = (padX * 2 >= 1) ? 0.5 : clamp(o.x, padX, 1 - padX);
    o.y = (padY * 2 >= 1) ? 0.5 : clamp(o.y, padY, 1 - padY);
  }

  /* ---------------- transport ---------------- */
  function togglePlay() {
    const p = ve.refs.player;
    if (!p.src || (ve.video && ve.video.proxying)) { window.__toast && window.__toast('Preview is still preparing…', 'error'); return; }
    if (p.paused) { const pr = p.play(); if (pr && pr.catch) pr.catch(() => {}); ve.refs.play.textContent = '⏸'; } else { p.pause(); ve.refs.play.textContent = '▶'; }
  }
  function seekTo(t) { ve.refs.player.currentTime = clamp(t, 0, dur()); updatePlayhead(); }

  /** The clip card's ▶ is a real play/pause TOGGLE: while its clip is playing it
   *  shows ⏸, and clicking pauses; clicking ▶ again resumes from where it paused
   *  (or restarts from the clip's start if the playhead left the clip). */
  function previewSegment(id) {
    const s = ve.segments.find((x) => x.id === id); if (!s) return;
    const p = ve.refs.player;
    const t = p.currentTime || 0;
    const inside = t >= s.start - 0.05 && t < s.end - 0.05;
    if (!p.paused && inside) { p.pause(); updateClipPlayButtons(); return; } // acting as the pause button
    selectSeg(id);
    ve._previewEnd = s.end; ve._loopSeg = $('#veLoopSel').checked ? s : null;
    if (!inside) seekTo(s.start); // resume mid-clip after a pause; restart otherwise
    const pr = p.play(); if (pr && pr.catch) pr.catch(() => {});
    ve.refs.play.textContent = '⏸';
    updateClipPlayButtons();
  }
  function updateClipPlayButtons() {
    const p = ve.refs.player;
    const t = p.currentTime || 0;
    $$('#veClipList [data-play]').forEach((b) => {
      const s = ve.segments.find((x) => x.id === b.dataset.play);
      const playing = !!(s && !p.paused && t >= s.start - 0.05 && t < s.end);
      const want = playing ? '⏸' : '▶';
      if (b.textContent !== want) { b.textContent = want; b.title = playing ? 'Pause' : 'Preview'; }
    });
  }

  /* ---------------- undo / redo (clips + text overlays) ---------------- */
  /**
   * `withCaps` folds the caption lane into the snapshot. It is OFF for ordinary
   * edits on purpose: captions cost minutes of transcription, and if every clip
   * move carried them, undoing a clip move made hours after running Auto-captions
   * would silently wipe the transcript. Only operations that change the captions
   * themselves (🧹 Clear captions) record them, so only those can restore them.
   */
  function snapshotState(withCaps) {
    const s = { segments: ve.segments, sel: ve.sel, textOverlays: ve.textOverlays, textSel: ve.textSel, audio: ve.audio, audioSel: ve.audioSel, sounds: ve.sounds || [] };
    if (withCaps) {
      s.caps = {
        events: ve.capEvents, words: ve.capWords, offset: ve.capOffset || 0,
        // capTarget is a LIVE clip object — keep its id and re-resolve on restore,
        // or we'd hand the caption lane a detached copy with stale cuts
        targetId: ve.capTarget ? ve.capTarget.id : null,
        source: ve._capSource || null, mode: ve._capMode || null, clipId: ve._capClipId || null,
      };
    }
    return JSON.stringify(s);
  }
  /** Does this snapshot carry captions? (so undo/redo stay symmetrical) */
  function snapHasCaps(json) { try { return !!JSON.parse(json).caps; } catch (e) { return false; } }
  function pushHistory(opts) {
    if (!ve.video) return;
    touchSession();   // every edit worth undoing is an edit worth keeping
    ve.history.push(snapshotState(opts && opts.captions));
    if (ve.history.length > 60) ve.history.shift();
    ve.future.length = 0;
    updateUndoRedoButtons();
  }
  function restoreState(json) {
    const s = JSON.parse(json);
    ve.segments = s.segments; ve.sel = s.sel; ve.textOverlays = s.textOverlays; ve.textSel = s.textSel;
    if (s.audio) { ve.audio = s.audio; ve.audioSel = s.audioSel; }
    if (s.sounds) { ve.sounds = s.sounds; if (!ve.sounds.some((x) => x.id === ve.soundSel)) ve.soundSel = null; renderSoundTrack(); syncSoundPreview(); }
    if (s.caps) {
      ve.capEvents = s.caps.events; ve.capWords = s.caps.words; ve.capOffset = s.caps.offset || 0;
      ve.capTarget = s.caps.targetId ? (ve.segments.find((x) => x.id === s.caps.targetId) || null) : null;
      ve._capSource = s.caps.source; ve._capMode = s.caps.mode; ve._capClipId = s.caps.clipId;
      ve.capSel = null; ve.capEditing = null;
      // the lane and the words window have to show what was just restored —
      // without these, undoing a caption change left the old lines on screen
      renderCapTrack(); renderCapList();
    }
    // Undoing a drag of the batch's graphic has to undo it for the BATCH too,
    // or the panel and the export would keep the placement the operator just
    // took back.
    ve.segments.filter((x) => x.bulk).forEach(syncBulkOverlayFrom);
    renderSegments(); renderTextOverlays(); renderTextTrack(); updateUndoRedoButtons();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }
  /** Commit a PRE-drag snapshot to history, but only if the drag actually changed anything. */
  function commitDragHistory(preSnapJson) {
    touchSession();
    ve.history.push(preSnapJson);
    if (ve.history.length > 60) ve.history.shift();
    ve.future.length = 0;
    updateUndoRedoButtons();
  }
  // The step being undone decides whether captions travel: undoing a caption
  // change must be redoable, so the opposite stack gets a caption-bearing
  // snapshot too — and an ordinary edit still leaves the lane alone.
  function undoVideo() {
    if (!ve.history.length) return;
    const prev = ve.history.pop();
    ve.future.push(snapshotState(snapHasCaps(prev)));
    restoreState(prev);
    window.__toast && window.__toast('↶ Undone', 'good');
  }
  function redoVideo() {
    if (!ve.future.length) return;
    const next = ve.future.pop();
    ve.history.push(snapshotState(snapHasCaps(next)));
    restoreState(next);
    window.__toast && window.__toast('↷ Redone', 'good');
  }
  function updateUndoRedoButtons() {
    const u = $('#veUndo'), r = $('#veRedo');
    if (u) u.disabled = ve.history.length === 0;
    if (r) r.disabled = ve.future.length === 0;
    // …and the captions window's own pair, for a phone that has no Ctrl+Z
    const cu = $('#capUndo'), cr = $('#capRedo');
    if (cu) cu.disabled = ve.history.length === 0;
    if (cr) cr.disabled = ve.future.length === 0;
  }

  /* ---------------- segments ---------------- */
  function addSegment(start, end, label, ai) {
    const s = { id: uid(), start: Math.max(0, start), end: Math.min(dur(), end), label: label || ('Clip ' + (ve.segments.length + 1)), color: COLORS[ve.segments.length % COLORS.length], ai: !!ai };
    ve.segments.push(s); selectSeg(s.id); renderSegments(); return s;
  }
  function removeSeg(id) { pushHistory(); ve.segments = ve.segments.filter((s) => s.id !== id); if (ve.sel === id) ve.sel = null; renderSegments(); }
  function selectSeg(id) { ve.sel = id; ve.activeRow = 'video'; ve.audioSel = null; ve.capSel = null; renderSegments(); }
  function duplicateSeg(id) {
    const s = ve.segments.find((x) => x.id === (id || ve.sel)); if (!s) return;
    batchRender(() => {
      pushHistory();
      const len = s.end - s.start;
      // An overlay clip is copied WHOLE — same file, same footage, same place in
      // the frame — and parked straight after itself. Sending it through
      // addSegment would have made a main-lane clip of THIS video instead, which
      // is not a copy of anything the operator can see.
      if ((s.lane || 0) >= 1) {
        const copy = { ...s, id: uid(), tlStart: clamp(tlPos(s) + len, 0, Math.max(0, dur() - 0.2)), key: s.key ? Object.assign({}, s.key) : undefined };
        ve.segments.push(copy); selectSeg(copy.id);
        return;
      }
      const ns = Math.min(dur() - len, s.end);
      const copy = addSegment(ns, Math.min(dur(), ns + len), s.label + ' copy', s.ai);
      if (copy && kfList(s).length) copy.kf = kfList(s).map((k) => Object.assign({}, k, { t: k.t - s.start + ns }));
    });
  }
  function doSplit(s, t) { return batchRender(() => doSplitInner(s, t)); }
  function doSplitInner(s, t) {
    // An OVERLAY clip is cut on the TIMELINE but split in its OWN footage: `t` is
    // where the scissors are, `srcT` is the frame there. The two halves keep the
    // same file, the same place in the frame and the same sound setting — this is
    // 'cut this insert in two', not 'make a new overlay'.
    if ((s.lane || 0) >= 1) return splitOverlayInner(s, t);
    pushHistory();
    // Splitting the BASE video is an editing gesture (cut out the announcements,
    // delete a bad take), not the act of making a short — both halves inherit
    // `seed` so the uploaded video never shows up in the Shorts panel next to the
    // AI clips. Shorts come from ✂️ Long to shorts, ＋ Clip or dragging on the
    // timeline; the edited base is saved with 💾 Export video.
    const rightStart = t, origEnd = s.end;
    // Splitting a clip that already had pauses removed: each half keeps the pauses
    // that fall on its side (one straddling the cut is divided). Without this the
    // right half would silently get its pauses back.
    const leftCuts = [], rightCuts = [];
    for (const c of cutsOf(s)) {
      if (c.end <= t) leftCuts.push(c);
      else if (c.start >= t) rightCuts.push(c);
      else { leftCuts.push({ start: c.start, end: t }); rightCuts.push({ start: t, end: c.end }); }
    }
    s.end = t;
    s.cuts = leftCuts;
    const right = addSegment(rightStart, origEnd, s.seed ? s.label : s.label + ' (2)', s.ai);
    right.seed = !!s.seed;
    if (rightCuts.length) right.cuts = rightCuts;
    splitKf(s, right, t);
    selectSeg(right.id); renderSegments();
    window.__toast && window.__toast(s.seed
      ? '✂ Split — delete the part you don’t want, then 💾 Export video. (Splitting your video doesn’t make shorts — use ✂️ Long to short clips for that.)'
      : '✂ Split into 2 clips — drag one aside to make a gap / overlay.', 'good');
  }
  /** Split an overlay-lane clip at timeline time `t` (see doSplitInner). */
  function splitOverlayInner(s, t) {
    const a = tlPos(s);
    const srcT = s.start + (t - a);
    if (srcT <= s.start + 0.15 || srcT >= s.end - 0.15) {
      return window.__toast && window.__toast('Move the playhead into the middle of that overlay, then Split.', 'error');
    }
    pushHistory();
    const origEnd = s.end;
    s.end = srcT;
    const right = {
      ...s, id: uid(), start: srcT, end: origEnd, tlStart: t,
      label: s.label, cuts: undefined,
    };
    ve.segments.push(right);
    selectSeg(right.id); renderSegments();
    window.__toast && window.__toast('✂ Overlay split in two — drag either half anywhere on the timeline.', 'good');
  }
  /**
   * CLOSE THE GAP — the other half of Split.
   *
   * You cut a pause out of a short (split, split, delete the middle) and you're left
   * with two clips and a hole. This joins them back into ONE short with that hole
   * removed: same clip, same captions, just without the pause. Press it again to
   * close the next gap.
   *
   * The clip to act on is the selected one, or — since deleting a clip clears the
   * selection — the last clip starting before the playhead, which is where you
   * already are after cutting a pause out.
   */
  function anchorClipForGap() {
    const main = ve.segments.filter((s) => (s.lane || 0) === 0);
    const sel = main.find((s) => s.id === ve.sel);
    if (sel) return sel;
    const t = ve.refs.player.currentTime || 0;
    let best = null;
    for (const s of main) if (s.start <= t + 0.001 && (!best || s.start > best.start)) best = s;
    return best || main.slice().sort((a, b) => a.start - b.start)[0] || null;
  }
  /** The clip immediately after `s` on the main lane — the far side of the hole. */
  function nextMainClip(s) {
    return ve.segments.filter((x) => (x.lane || 0) === 0 && x.id !== s.id && x.start >= s.end - 0.001)
      .sort((a, b) => a.start - b.start)[0] || null;
  }
  /** The clip immediately before `s` — so Close gap works from EITHER side of the
   *  hole. Splitting leaves the RIGHT half selected, which is exactly the clip a
   *  user is holding when they go to close the gap they just made. */
  function prevMainClip(s) {
    return ve.segments.filter((x) => (x.lane || 0) === 0 && x.id !== s.id && x.end <= s.start + 0.001)
      .sort((a, b) => b.end - a.end)[0] || null;
  }
  /** Absorb `next` into `s`, turning the hole between them into a removed range.
   *  Pure state change — history and toasts belong to the callers. */
  function absorbNext(s, next) {
    const gap = Math.max(0, next.start - s.end);
    // both sides keep whatever pauses they already had removed; the hole between
    // them becomes one more removed range
    s.cuts = cutsOf(s)
      .concat(gap > 0.001 ? [{ start: s.end, end: next.start }] : [])
      .concat(cutsOf(next))
      .sort((a, b) => a.start - b.start);
    s.end = next.end;
    // Joining two pieces of the BASE video (split → delete the middle → close gap)
    // is still just editing the uploaded video, so the result stays `seed` and off
    // the Shorts panel. Only joining real clips produces a real short.
    s.seed = !!(s.seed && next.seed);
    ve.segments = ve.segments.filter((x) => x.id !== next.id);
    // captions that belonged to the clip we just absorbed still point at the right
    // source times — only the clip they hang off changed
    if (ve.capTarget && ve.capTarget.id === next.id) { ve.capTarget = s; ve._capClipId = s.id; }
    return gap;
  }
  function joinedToast(s, gapClosed, joins) {
    const removed = removedDur(s);
    if (!removed) return window.__toast && window.__toast('🔗 Joined into one short.', 'good');
    const what = joins > 1 ? `${joins} gaps closed — ${removed.toFixed(1)}s of pauses removed` : `${gapClosed.toFixed(1)}s pause removed`;
    window.__toast && window.__toast(`🔗 Joined into one short — ${what}. It exports as a single ${Math.round(keptDur(s))}s video.`, 'good');
  }
  function closeGapAfter(idArg) {
    if (!ve.video) return;
    const s = idArg
      ? ve.segments.find((x) => x.id === idArg && (x.lane || 0) === 0)
      : anchorClipForGap();
    if (!s) return window.__toast && window.__toast('Select a clip first, then Close gap.', 'error');
    // join forwards if there's a clip after this one; otherwise backwards, so the
    // half you happen to have selected is never the wrong one
    let head = s, next = nextMainClip(s);
    if (!next) {
      const prev = prevMainClip(s);
      if (!prev) return window.__toast && window.__toast('Nothing to join this clip to — Close gap merges two clips into one short and removes the pause between them.', 'error');
      head = prev; next = s;
    }
    pushHistory();
    const gap = absorbNext(head, next);
    ve.sel = head.id; ve.activeRow = 'video';
    renderSegments();
    joinedToast(head, gap, 1);
    return head;
  }
  /* Deliberately NO "close every gap" bulk action: on a timeline of AI-found shorts
   * every clip is separated by a gap, so "all" would happily weld 16 unrelated
   * shorts into one. Removing pauses is one press per pause, which is also how you
   * see each join land. */
  /** Split at the playhead. Acts on whichever ROW is active (video vs audio). */
  function splitAtPlayhead(tArg) {
    if (!ve.video) return;
    const t = (typeof tArg === 'number') ? tArg : (ve.refs.player.currentTime || 0);
    if (t <= 0.2 || t >= dur() - 0.2) return window.__toast && window.__toast('Move the red playhead into the video, then Split.', 'error');
    // If the AUDIO row is the active selection, split audio ONLY (leave video whole).
    if (ve.activeRow === 'audio') return splitAudioAt(t);
    // 1) inside an existing clip → split that clip.
    //    Matched by where the block SITS, not by its source times: an overlay clip
    //    is positioned by tlStart, so comparing the playhead against its start/end
    //    (times inside a different file, once media can be added) would cut a clip
    //    that is nowhere near the scissors. The main lane wins a tie — that is the
    //    lane Split has always acted on.
    //    The SELECTED block wins when the playhead is inside it — that is the one
    //    highlighted on screen, and the lane it happens to be on should not decide
    //    what the scissors cut. Otherwise the main lane, then anything.
    const covers = (x) => { const a = tlPos(x), b = a + (x.end - x.start); return t > a + 0.15 && t < b - 0.15; };
    const picked = ve.segments.find((x) => x.id === ve.sel);
    const s = (picked && covers(picked)) ? picked
      : (ve.segments.find((x) => (x.lane || 0) === 0 && covers(x)) || ve.segments.find(covers));
    if (s) return doSplit(s, t);
    // 2) empty timeline / gap → carve the underlying VIDEO into two clips either
    //    side of the playhead. Both sides must be real: parked on an existing
    //    clip's edge, one side is zero-length, and creating a 0s clip is never
    //    what the operator meant (it used to leave "0s" entries lying around).
    const mains = ve.segments.filter((x) => (x.lane || 0) === 0);
    const prevEnd = mains.filter((x) => x.end <= t).reduce((m, x) => Math.max(m, x.end), 0);
    const nextArr = mains.filter((x) => x.start >= t).map((x) => x.start);
    const nextStart = nextArr.length ? Math.min(...nextArr) : dur();
    if (t - prevEnd < 0.25 || nextStart - t < 0.25) {
      return window.__toast && window.__toast('The playhead is already at a clip’s edge — move it into the footage you want to cut, then Split.', 'error');
    }
    batchRender(() => {
      pushHistory();
      addSegment(prevEnd, t, 'Clip', false);
      const right = addSegment(t, nextStart, 'Clip', false);
      selectSeg(right.id); renderSegments();
    });
    window.__toast && window.__toast('✂ Split into two clips on the timeline.', 'good');
  }

  /* ---------------- AI highlights ---------------- */
  function shortLenParams() {
    const raw = ($('#veShortLen') && $('#veShortLen').value) || 'auto';
    // Auto aims for ~1½-minute clips ON AVERAGE (the user's ask): the ideal sits at
    // 90s and the band is wide enough (60–150s) that a complete thought still sets
    // its own natural length within it.
    if (raw === 'auto') return { minLen: 60, idealLen: 90, maxLen: 150, autoLen: true };
    const v = parseInt(raw, 10) || 60;
    if (v === 30) return { minLen: 15, idealLen: 30, maxLen: 45 };
    if (v === 90) return { minLen: 70, idealLen: 90, maxLen: 115 };
    if (v === 120) return { minLen: 95, idealLen: 120, maxLen: 150 };
    return { minLen: 40, idealLen: 60, maxLen: 80 };
  }
  /**
   * WHERE Long-to-shorts is allowed to look.
   *
   * The timeline is the answer: whatever main-lane footage the operator has left
   * on it is the sermon as far as this button is concerned. Drag the "Full video"
   * block's left edge to where the preaching starts and the search starts there
   * too — the greetings, the worship set and the notices are not searched, not
   * scored, and can't turn up as a clip. Ranges are in SOURCE seconds, merged and
   * sorted; AI clips are ignored (they are this button's own output, not footage),
   * and if nothing usable is left we fall back to the whole recording.
   */
  function searchRanges() {
    const D = dur();
    const mains = ve.segments
      .filter((s) => (s.lane || 0) === 0 && !s.ai)
      .map((s) => [clamp(s.start, 0, D), clamp(s.end, 0, D)])
      .filter(([a, b]) => b - a > 1)
      .sort((a, b) => a[0] - b[0]);
    if (!mains.length) return [[0, D]];
    const out = [mains[0].slice()];
    for (const [a, b] of mains.slice(1)) {
      const last = out[out.length - 1];
      if (a <= last[1] + 0.05) last[1] = Math.max(last[1], b); // touching/overlapping → one stretch
      else out.push([a, b]);
    }
    return out;
  }
  /** True when the timeline still holds the whole recording (nothing trimmed away). */
  function searchIsWholeVideo(rs) { return rs.length === 1 && rs[0][0] < 1 && rs[0][1] > dur() - 1; }

  async function findHighlights() {
    if (!ve.video) return;
    const jobId = window.__newJobId ? window.__newJobId() : 'j';
    try {
      let p = shortLenParams();
      const deep = $('#veDeep') ? $('#veDeep').checked : false;
      const ranges = searchRanges();
      const whole = searchIsWholeVideo(ranges);
      const from = ranges[0][0], to = ranges[ranges.length - 1][1];
      // Aim for a GENEROUS set of highlights (~20) at ANY selected length. Cap at how
      // many clips of that length fit end-to-end (with a small gap) so nothing
      // overlaps; only very long clips on a short sermon give fewer than 20.
      // Measured against the KEPT footage — 20 clips can't come out of 4 minutes.
      const keptSec = ranges.reduce((a, [s, e]) => a + (e - s), 0);
      // ✨ Auto aims at ~1:30 clips, but a short recording (or a tightly trimmed
      // timeline) can't hold 90-second clips — scale the band to the footage so
      // Auto never comes back empty-handed. Fixed lengths are left alone: if the
      // user explicitly asked for 2-minute clips of a 1-minute video, "none fit"
      // is the honest answer.
      if (p.autoLen && keptSec < p.minLen * 4) {
        const ideal = clamp(Math.round(keptSec / 4), 15, p.idealLen);
        p = { minLen: Math.max(8, Math.round(ideal * 0.55)), idealLen: ideal, maxLen: Math.max(24, Math.round(ideal * 1.7)), autoLen: true };
      }
      const TARGET_CLIPS = 20;
      const fit = Math.floor(keptSec / ((p.idealLen || 50) + 8));
      const maxClips = clamp(Math.min(TARGET_CLIPS, fit), 3, TARGET_CLIPS);
      const where = whole ? 'across the whole sermon' : `in ${fmt(from)}–${fmt(to)} (the part you kept)`;
      // Name the speech model in the label — the bigger ones are both noticeably
      // better and noticeably slower, so the wait is explained rather than
      // mysterious. Mirrors captioner.pickScanModel: a named choice wins, and
      // automatic climbs to Small and stops.
      let asr = '';
      if (deep) {
        try {
          const list = await window.api.captions.models();
          const chosen = ve.asrModel && list.find((m) => m.id === ve.asrModel && m.installed);
          const best = chosen || ['small.en', 'base.en'].map((id) => list.find((m) => m.id === id && m.installed)).find(Boolean);
          if (best) asr = ` with ${best.name.split(' ')[0]}`;
        } catch (e) {}
        // ☁️ the cloud ear (see sermon:analyze): chosen outright, or implied by the
        // cloud judge with the ear left on Auto
        if (ve.asrModel === 'cloud' || (ve.aiModel === 'cloud' && !ve.asrModel)) asr = ' with ☁️ Whisper Large';
      }
      // The AI reader only has anything to read in Deep mode, and it is the one
      // thing here that visibly changes how long the operator waits — so it is
      // named in the label rather than being a mysterious extra few minutes.
      const useAi = !!(deep && ve.aiModel);
      const aiNote = !useAi ? '' : ve.aiModel === 'cloud' ? ', then weighing every clip with ☁️ Cloud AI' : ', then weighing every clip with the AI reader';
      const label = deep
        ? `🧠 Deep analysis — reading the sermon${asr} ${where} for its key points${aiNote}… (re-runs reuse the cached transcript and are much faster)`
        : `🤖 Finding the best moments ${where}…`;
      const args = {
        input: ve.video.path, minLen: p.minLen, maxLen: p.maxLen, idealLen: p.idealLen,
        autoLen: !!p.autoLen, deep, maxClips, jobId,
        ai: useAi, aiModel: ve.aiModel || undefined,
        asrModel: ve.asrModel || undefined,
        // trimmed the block? then only that stretch is decoded, scored and cut from
        startSec: whole ? 0 : from, endSec: whole ? 0 : to, ranges: whole ? null : ranges,
      };
      ve._lastAnalyzeArgs = args;
      const res = await window.__runJob(label, jobId, () => window.api.sermon.analyze(args));
      if (!res.clips.length) {
        window.__toast && window.__toast(whole
          ? 'No standout moments found — try adding clips manually.'
          : `No standout moments inside ${fmt(from)}–${fmt(to)} — drag the clip’s edges to search more of the video.`, 'error');
        return;
      }
      pushHistory();
      ve.segments = ve.segments.filter((s) => !s.ai); // replace previous AI clips
      const made = [];
      res.clips.forEach((c) => {
        const s = addSegment(c.start, c.end, c.label, true);
        s.score = c.score; s.quote = c.quote; s.virality = c.virality; s.reasons = c.reasons;
        // the words the scan's cloud ear heard in it — ✂️ Remove pauses reuses them
        if (c.words && c.words.length) (ve._scanWords || (ve._scanWords = new Map())).set(s.id, { start: s.start, end: s.end, words: c.words });
        made.push(s);
      });
      renderSegments();
      // Say what actually ran. res.meta.aiPass is false when the reader was asked
      // for but every pass no-opped (a model that answered with nothing usable),
      // and claiming it worked would be a lie the operator could not check.
      const st = (res.meta && res.meta.aiStats) || null;
      const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
      const edNote = res.meta && res.meta.aiPass
        ? ` Read and ranked by ${res.meta.aiModel || 'the AI reader'}${st && st.endingsChanged ? ` — it moved ${plural(st.endingsChanged, 'ending')}` : ''}${st && st.titled ? `, titled ${st.titled}` : ''}${res.meta.aiRejected ? ` and left out ${plural(res.meta.aiRejected, 'moment')} that would not stand alone` : ''}.`
        : (res.meta && res.meta.editorPass ? ' Ranked like an editor would — on what was actually said.' : '');
      // ☁️ asked for and not (fully) had: say so — a fallback nobody sees is how
      // the caption writer ran on templates for a month (see cloudwrite.js)
      const ear = res.meta && res.meta.ear;
      const earNote = !ear ? '' : ear.cloud && !ear.pc ? ' Heard by ☁️ Whisper Large.'
        : ear.cloud ? ` Heard by ☁️ Whisper Large, ${plural(ear.pc, 'stretch')} on this PC (${ear.why}).`
          : ` ⚠ Heard on this PC — the cloud ear could not (${ear.why || 'no answer'}).`;
      const aiMissed = useAi && ve.aiModel === 'cloud' && !(res.meta && res.meta.aiPass)
        ? ` ⚠ ☁️ Cloud AI did not judge this run (${(res.meta && res.meta.aiMissing) || (st && st.why) || 'no answer'}) — ranked by the rules instead.` : '';
      // a server too small to read the words found these by the sound: say so
      const memNote = res.meta && res.meta.lowMemory ? ` ⚠ ${res.meta.lowMemory}` : '';
      ve._lastScanNote = { edNote, earNote, aiMissed, memNote };
      window.__toast && window.__toast(`✨ Found ${res.clips.length} highlight${res.clips.length > 1 ? 's' : ''}${whole ? '' : ` in ${fmt(from)}–${fmt(to)}`}!${edNote}${earNote}${aiMissed}${memNote} Review & tweak them, then Export.`, aiMissed ? 'error' : 'good', aiMissed || memNote || earNote.includes('⚠') ? 12000 : undefined);
      // "Remove pauses" is part of the same click: the shorts land already tight,
      // rather than needing a second pass the user has to know to run.
      if (removePausesOn()) await removePausesIn(made);
    } catch (e) { /* handled */ }
  }

  const capExportsOn = () => { const c = $('#veCapExports'); return !!(c && c.checked); };
  // Auto-reframe is a CROP that follows the speaker. If the operator asked for
  // the whole picture over a blurred background there is nothing to crop, so the
  // two are mutually exclusive by construction rather than by remembering to
  // untick a box.
  const reframeOn = () => { const c = $('#veAutoReframe'); return !!(c && c.checked) && ve.fill.mode === 'crop'; };

  /* ================= EXPORT LOOK: frame fill + background noise =============
   *
   * Two settings that apply to every clip this studio exports, and that people
   * set once for their room and their camera rather than per clip — so both are
   * remembered between sessions.
   *
   *  • Frame fill — what happens to the empty space when a 16:9 recording (or a
   *    16:9 photo) goes out as a 9:16 reel. Crop into it (the default, and what
   *    the app always did), letterbox it, or fill the gap with a blurred copy of
   *    the picture's own colours so it blends and nothing is lost off the sides.
   *  • Background noise — spectral removal of the room from under the voice, at
   *    the strength the operator picks after listening to it.
   */
  /* ======================= THE SHORT'S THUMBNAIL ==========================
   *
   * One frame decides whether anybody presses play, and left alone every
   * platform picks that frame itself: almost always the first one, which on a
   * clip that opens mid-cut is a blur, and on one that opens on a face is a
   * blink. Nobody chose it.
   *
   * So each short can carry its own: a moment scrubbed to in the clip, or a
   * picture the operator made. On export it is written as a JPEG beside the
   * video (which is what every platform takes for a custom thumbnail) and
   * embedded in the file as cover art, without re-encoding a frame of the
   * video itself. See video.attachThumbnail.
   */

  /** Which short the picker is editing, and where its slider is. */
  function thumbSeg() { return ve._thumbSeg ? ve.segments.find((x) => x.id === ve._thumbSeg) : null; }

  async function openThumbPicker(id) {
    const s = ve.segments.find((x) => x.id === id);
    if (!s || !ve.video) return;
    ve._thumbSeg = id;
    const modal = $('#thumbModal');
    if (!modal) return;
    const pl = ve.refs.player;
    ve._thumbWas = pl ? { t: pl.currentTime, playing: !pl.paused } : null;
    if (pl && !pl.paused) pl.pause();
    // start where they left it, or a little way in — the opening frame of a
    // clip is the one worth avoiding
    const at = s.thumb && s.thumb.at != null ? s.thumb.at : s.start + Math.min(3, (s.end - s.start) * 0.2);
    modal.classList.remove('hidden');
    setThumbAt(at);
    await showThumbFrame();
  }
  function closeThumbPicker() {
    const modal = $('#thumbModal');
    if (modal) modal.classList.add('hidden');
    const pl = ve.refs.player, was = ve._thumbWas;
    ve._thumbWas = null; ve._thumbSeg = null;
    if (!pl || !was) return;
    try { pl.currentTime = was.t; } catch (e) {}
    if (was.playing) pl.play().catch(() => {});
  }
  /** Put the slider and the label on a source time inside the clip. */
  function setThumbAt(at) {
    const s = thumbSeg(); if (!s) return;
    const span = Math.max(0.1, s.end - s.start);
    ve._thumbAt = clamp(at, s.start, s.end);
    const sl = $('#thumbAt'); if (sl) sl.value = String(Math.round(((ve._thumbAt - s.start) / span) * 1000));
    const lab = $('#thumbWhen');
    if (lab) lab.textContent = `${fmt(ve._thumbAt - s.start)} into the short  ·  ${fmt(ve._thumbAt)} in the recording`;
  }
  /** Show the frame at the slider's position, from the preview player itself. */
  async function showThumbFrame() {
    const img = $('#thumbShot'), pl = ve.refs.player;
    if (!img || !pl) return;
    await new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; pl.removeEventListener('seeked', fin); res(); };
      pl.addEventListener('seeked', fin);
      try { pl.currentTime = ve._thumbAt; } catch (e) { fin(); return; }
      setTimeout(fin, 1200);
    });
    try {
      const c = document.createElement('canvas');
      c.width = pl.videoWidth || 1280; c.height = pl.videoHeight || 720;
      c.getContext('2d').drawImage(pl, 0, 0);
      img.src = c.toDataURL('image/jpeg', 0.85);
    } catch (e) { /* the slider still works; the preview just cannot draw */ }
  }

  function setClipThumb(s, thumb) {
    if (!s) return;
    if (thumb) s.thumbPick = thumb; else delete s.thumbPick;
    renderClipList();
    touchSession();
  }

  /**
   * Apply the chosen thumbnail to a finished short. Runs LAST, after captions,
   * text and the outro, so the picture beside the file is the picture in the
   * file people will actually download.
   */
  async function applyThumbTo(s, filePath) {
    const t = s && s.thumbPick;
    if (!t || !filePath) return filePath;
    try {
      // The moment is measured in the SHORT's own clock: the operator scrubbed
      // to a point in the clip, and the export starts at the clip's start.
      const atSec = t.file ? 0 : Math.max(0, (t.at || s.start) - s.start);
      const res = await window.api.video.attachThumb({ input: filePath, imagePath: t.file || null, atSec });
      if (res && res.image) {
        window.__toast && window.__toast('🖼️ Thumbnail saved beside the short: '
          + String(res.image).split(/[\\/]/).pop(), 'good', 7000);
      }
    } catch (e) {
      window.__toast && window.__toast('The short exported, but its thumbnail could not be written: '
        + (e && e.message), 'error', 8000);
    }
    return filePath;
  }

  /* ========================== SAVED SESSIONS ==============================
   *
   * Editing a two-hour service is not one sitting. Clips get found on Monday,
   * trimmed on Tuesday, captioned and re-captioned on Wednesday — and until now
   * closing the window threw all of it away: the app remembered your export
   * SETTINGS but not your WORK.
   *
   * A session is everything that was on screen: the recording, every clip and
   * every cut inside it, the captions and the corrections typed into them, text
   * over the picture, the music bed, the outro, who the reframe is following,
   * the export look, and where the playhead was standing. Opening one puts the
   * studio back exactly as it was.
   *
   * Two rules make it trustworthy rather than merely present:
   *
   *   1. It saves ITSELF. Every change marks the session dirty and, a couple of
   *      seconds later, it is written to a rolling slot of its own. Nobody has
   *      to remember to press anything, a crash costs nothing, and because that
   *      slot is separate the autosave can never overwrite a session the
   *      operator deliberately saved and named.
   *   2. It restores in the same order the studio builds itself — video first
   *      (which resets everything), then the timeline, then the captions, then
   *      the look — so a restored session is indistinguishable from one that
   *      was never closed.
   */
  const SESSION_AUTOSAVE_MS = 2500;

  /** Everything the studio has, as plain JSON. */
  function collectSession(name) {
    if (!ve.video) return null;
    const info = ve.video.info || {};
    return {
      name: name || ve.sessionName || (ve.video.path.split(/[\\/]/).pop() || 'Session'),
      video: {
        path: ve.video.path,
        durationSec: info.durationSec || 0,
        width: info.width || 0, height: info.height || 0, fps: info.fps || null,
      },
      timeline: {
        // the clips carry their own cuts, lanes, pip placement and per-clip
        // subject pick — they are already plain data, so they travel as-is,
        // less the "a thumbnail is being made" flag, which is about this run
        segments: (ve.segments || []).map((s) => {
          if (!s || !s._thumbing) return s;
          const c = Object.assign({}, s); delete c._thumbing; return c;
        }),
        audio: ve.audio || [],
        textOverlays: ve.textOverlays || [],
        sounds: ve.sounds || [],
        music: ve.music || null,
        outro: ve.outro || null,
        outroAll: ve.outroAll !== false,
        pxPerSec: ve.pxPerSec,
        playhead: ve.refs.player ? (ve.refs.player.currentTime || 0) : 0,
        sel: ve.sel || null,
        activeRow: ve.activeRow || 'video',
        snap: ve.snap !== false,
      },
      captions: {
        events: ve.capEvents || null,
        words: ve.capWords || null,
        offset: ve.capOffset || 0,
        targetId: ve.capTarget ? ve.capTarget.id : null,
        source: ve._capSource || null, mode: ve._capMode || null, clipId: ve._capClipId || null,
        pos: ve.capPos || null, width: ve.capWidth || null,
        style: {
          id: ve.capStyleId,
          font: valOf('#capFont'), size: valOf('#capSize'), words: valOf('#capWords'),
          case: valOf('#capCase'), position: valOf('#capPos'), colour: valOf('#capColor'),
        },
        showOnPreview: !!(($('#veCapShow') || {}).checked),
        autoOnExport: !!(($('#veCapExports') || {}).checked),
      },
      look: {
        aspect: ve.aspect, quality: ve.quality, fps: ve.fps || 0, bitrate: ve.bitrate || 'recommended',
        fill: ve.fill, denoise: ve.denoise, fade: ve.fade, cover: ve.cover,
        framing: ve.framing,
        reframe: !!(($('#veAutoReframe') || {}).checked),
        subject: ve.subject ? { sig: ve.subject.sig, thumb: ve.subject.thumb, at: ve.subject.at } : null,
      },
      models: { capModel: ve.capModel || '', aiModel: ve.aiModel || '', asrModel: ve.asrModel || '' },
      bulk: { files: (ve.bulk && ve.bulk.files) || [], overlays: (ve.bulk && ve.bulk.overlays) || [] },
      thumb: ve.sessionThumb || null,
    };
  }
  const valOf = (sel) => { const el = $(sel); return el ? el.value : null; };
  const setVal = (sel, v) => { const el = $(sel); if (el && v != null) el.value = v; };

  /**
   * Put the studio back. Loads the recording first (which clears everything the
   * way opening a video always does), then lays the saved work back over it.
   */
  async function applySession(data) {
    if (!data || !data.video || !data.video.path) return false;
    const p = data.video.path;
    if (data.videoMissing) {
      window.__toast && window.__toast(
        '⚠️ This session’s recording is not where it was — ' + p.split(/[\/]/).pop()
        + '. Open that video again and save the session; everything else is still here.', 'error', 12000);
      return false;
    }
    ve._restoring = true;
    try { await loadVideo(p); } finally { ve._restoring = false; }
    if (!ve.video) return false;

    const tl = data.timeline || {};
    if (Array.isArray(tl.segments) && tl.segments.length) {
      ve.segments = tl.segments;
      // a session saved mid-thumbnail kept the "making one" flag, and the card
      // then waited forever for a picture nobody was making
      for (const s of ve.segments) if (s) delete s._thumbing;
      shrinkOldThumbs(ve.segments);
    }
    if (Array.isArray(tl.audio)) ve.audio = tl.audio;
    if (Array.isArray(tl.textOverlays)) ve.textOverlays = tl.textOverlays;
    ve.sounds = Array.isArray(tl.sounds) ? tl.sounds : [];
    ve.music = tl.music || null;
    ve.outro = tl.outro || null;
    ve.outroAll = tl.outroAll !== false;
    ve.sel = tl.sel || (ve.segments[0] && ve.segments[0].id) || null;
    ve.activeRow = tl.activeRow || 'video';
    ve.snap = tl.snap !== false;
    if (tl.pxPerSec) {
      ve.pxPerSec = clamp(+tl.pxPerSec || ve.pxPerSec, 0.05, 240);
      const zoomCtl = $('#veZoom'); if (zoomCtl) zoomCtl.value = String(ve.pxPerSec);
    }

    const c = data.captions || {};
    ve.capEvents = c.events || null;
    ve.capWords = c.words || null;
    ve.capOffset = c.offset || 0;
    ve.capTarget = c.targetId ? (ve.segments.find((x) => x.id === c.targetId) || null) : null;
    ve._capSource = c.source || null; ve._capMode = c.mode || null; ve._capClipId = c.clipId || null;
    ve.capPos = c.pos || null; ve.capWidth = c.width || null;
    if (c.style) {
      if (c.style.id) ve.capStyleId = c.style.id;
      setVal('#capStyleSel', c.style.id); setVal('#capFont', c.style.font); setVal('#capSize', c.style.size);
      setVal('#capWords', c.style.words); setVal('#capCase', c.style.case);
      setVal('#capPos', c.style.position); setVal('#capColor', c.style.colour);
    }
    const capShow = $('#veCapShow'); if (capShow && c.showOnPreview != null) capShow.checked = !!c.showOnPreview;
    const capExp = $('#veCapExports'); if (capExp && c.autoOnExport != null) capExp.checked = !!c.autoOnExport;

    const lk = data.look || {};
    if (lk.aspect && ve.presets[lk.aspect]) { ve.aspect = lk.aspect; setVal('#veAspect', lk.aspect); }
    if (lk.quality) { ve.quality = lk.quality; setVal('#veQuality', lk.quality); }
    if (lk.fps != null) { ve.fps = Number(lk.fps) || 0; setVal('#veFps', String(ve.fps)); }
    if (lk.bitrate) { ve.bitrate = lk.bitrate; setVal('#veBitrate', lk.bitrate); }
    if (lk.fps != null || lk.bitrate) pushExportPrefs();
    if (lk.fill) ve.fill = lk.fill;
    if (lk.denoise) ve.denoise = lk.denoise;
    if (lk.cover) ve.cover = lk.cover;
    if (lk.fade) ve.fade = lk.fade;
    if (lk.framing) ve.framing = lk.framing;
    const rf = $('#veAutoReframe'); if (rf && lk.reframe != null) rf.checked = !!lk.reframe;
    ve.subject = lk.subject && lk.subject.sig ? lk.subject : null;

    const m = data.models || {};
    if (m.capModel != null) ve.capModel = m.capModel;
    if (m.aiModel != null) ve.aiModel = m.aiModel;
    if (m.asrModel != null) ve.asrModel = m.asrModel;
    if (data.bulk) { ve.bulk.files = data.bulk.files || []; ve.bulk.overlays = data.bulk.overlays || []; }

    // a restored session is a clean starting point, not something to undo INTO
    ve.history = []; ve.future = []; updateUndoRedoButtons();
    ve.sessionId = data.id && data.id !== 'autosave' ? data.id : null;
    ve.sessionName = data.name || null;
    ve.sessionThumb = data.thumb || null;
    ve.sessionDirty = false;

    syncExportPrefUi();
    renderFollowRow();
    renderRuler(); renderSegments(); renderTextOverlays(); renderTextTrack();
    renderCapTrack(); renderCapList(); renderClipList();
    if (typeof renderAudioSegments === 'function') renderAudioSegments();
    if (typeof updateMusicButton === 'function') updateMusicButton();
    updateCropMask();
    if (ve.refs.player && tl.playhead) { try { ve.refs.player.currentTime = tl.playhead; } catch (e) {} }
    updatePlayhead();
    updateSessionChip();
    return true;
  }

  /* ---- the rolling autosave --------------------------------------------- */

  /**
   * The safety net.
   *
   * touchSession() below is called from every place that changes the timeline,
   * and that is the fast path — but "every place" is a promise no growing app
   * keeps, and a session that quietly stops saving is worse than none. So the
   * studio also just LOOKS, every few seconds, at what it would save and writes
   * it if it differs from what is on disk. Nothing can be forgotten, because
   * nothing has to be remembered.
   */
  const SESSION_SWEEP_MS = 15000;
  function startSessionSweep() {
    if (ve._sessionSweep) return;
    ve._sessionSweep = setInterval(() => {
      if (!ve.video) return;
      let json = null;
      try { json = JSON.stringify(collectSession()); } catch (e) { return; }
      if (!json || json === ve._sessionLastJson) return;
      ve._sessionLastJson = json;
      window.api.sessions.autosave(JSON.parse(json)).catch(() => {});
    }, SESSION_SWEEP_MS);
  }

  /** Something changed: mark it, and schedule the write. */
  function touchSession() {
    if (!ve.video) return;
    ve.sessionDirty = true;
    updateSessionChip();
    if (ve._sessionTimer) clearTimeout(ve._sessionTimer);
    ve._sessionTimer = setTimeout(writeAutosave, SESSION_AUTOSAVE_MS);
  }
  async function writeAutosave() {
    ve._sessionTimer = null;
    const data = collectSession();
    if (!data) return;
    try {
      await window.api.sessions.autosave(data);
      ve.sessionSavedAt = Date.now();
      try { ve._sessionLastJson = JSON.stringify(data); } catch (e) {}
    } catch (e) { /* the sweep will try again */ }
  }

  /** A poster for the session card — grabbed from the preview, once. */
  function grabSessionThumb() {
    const p = ve.refs.player;
    if (!p || p.readyState < 2 || !p.videoWidth) return;
    try {
      const c = document.createElement('canvas');
      const w = 320, h = Math.max(1, Math.round((p.videoHeight / p.videoWidth) * w));
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(p, 0, 0, w, h);
      ve.sessionThumb = c.toDataURL('image/jpeg', 0.6);
    } catch (e) { /* a session without a picture is still a session */ }
  }

  /* ---- saving, opening, and the chip that says where you are -------------- */

  function updateSessionChip() {
    const el = $('#veSessionName');
    if (!el) return;
    if (!ve.video) { el.textContent = ''; el.title = ''; return; }
    const nm = ve.sessionName || 'Unsaved session';
    el.textContent = (ve.sessionDirty ? '• ' : '') + nm;
    el.title = ve.sessionDirty
      ? 'Unsaved changes — they are being kept safe automatically, but give this session a name to find it again.'
      : 'Saved: ' + nm;
  }

  async function saveSession(askName) {
    if (!ve.video) { window.__toast && window.__toast('Open a video first — there is no session to save yet.', 'error'); return null; }
    let name = ve.sessionName;
    if (askName || !name) {
      name = await ask('Name this session', name || (ve.video.path.split(/[\\/]/).pop() || '').replace(/\.[^.]+$/, ''));
      if (name == null) return null;
      name = String(name).trim();
      if (!name) return null;
    }
    grabSessionThumb();
    const data = collectSession(name);
    try {
      const res = await window.api.sessions.save(askName ? null : ve.sessionId, name, data);
      ve.sessionId = res.id; ve.sessionName = res.name; ve.sessionDirty = false;
      updateSessionChip();
      window.__toast && window.__toast('💾 Session saved — "' + res.name + '". Open it any time from 💾 Sessions.', 'good', 6000);
      return res;
    } catch (e) {
      window.__toast && window.__toast('Could not save the session: ' + (e && e.message), 'error');
      return null;
    }
  }

  async function openSessionById(id) {
    let data = null;
    try { data = await window.api.sessions.load(id); } catch (e) {}
    if (!data) { window.__toast && window.__toast('That session could not be read.', 'error'); return false; }
    const okd = await applySession(data);
    if (okd) window.__toast && window.__toast('📂 Back where you left off — "' + (data.name || 'session') + '".', 'good', 5000);
    return okd;
  }

  /* ============================ ask() ============================
   * Chromium — and therefore Electron — does not implement window.prompt(): it
   * throws and takes the rest of the click handler with it. Naming a session
   * needs a text box, so here is the same small in-app dialog the Presentation
   * studio uses, sharing its stylesheet. Enter accepts, Escape cancels.
   */
  function ask(message, initial, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'pv-ask-back';
      back.innerHTML = `<div class="pv-ask" role="dialog" aria-modal="true">
          <p class="pv-ask-msg">${escape2(message)}</p>
          <input type="text" class="pv-ask-input" value="${escape2(initial == null ? '' : initial)}" />
          <div class="pv-ask-btns">
            <button class="pv-ask-cancel">Cancel</button>
            <button class="pv-ask-ok">${escape2(o.okLabel || 'OK')}</button>
          </div>
        </div>`;
      document.body.appendChild(back);
      const input = back.querySelector('.pv-ask-input');
      let done = false;
      const close = (v) => { if (done) return; done = true; back.remove(); resolve(v); };
      back.querySelector('.pv-ask-ok').addEventListener('click', () => close(input.value));
      back.querySelector('.pv-ask-cancel').addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
      // captured: the studio binds keys on document (space plays, Delete removes
      // a clip) and typing a session name must not do any of that
      back.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); close(input.value); }
        if (e.key === 'Escape') { e.preventDefault(); close(null); }
      });
      input.focus(); input.select();
    });
  }

  /* ---- the Sessions window ---------------------------------------------- */

  const whenWords = (iso) => {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const mins = Math.round((now - d) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24 && d.getDate() === now.getDate()) return hrs + 'h ago';
    if (hrs < 48) return 'yesterday';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  async function openSessionsWindow() {
    const modal = $('#sessModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    await renderSessions();
  }
  function closeSessionsWindow() { const m = $('#sessModal'); if (m) m.classList.add('hidden'); }

  async function renderSessions() {
    const list = $('#sessList');
    if (!list) return;
    list.innerHTML = '<p class="muted small">Looking…</p>';
    let rows = [];
    try { rows = await window.api.sessions.list(); } catch (e) { rows = []; }
    const cur = $('#sessCurrent');
    if (cur) {
      cur.textContent = ve.video
        ? (ve.sessionName ? 'Open now: ' + ve.sessionName + (ve.sessionDirty ? ' (unsaved changes)' : ' (saved)') : 'Open now: an unnamed session')
        : 'Nothing open — pick a session below, or open a video first.';
    }
    if (!rows.length) {
      list.innerHTML = '<p class="muted small sess-empty">No saved sessions yet. Press <b>💾 Save session</b> while you are editing and it will be waiting here next time.</p>';
      return;
    }
    list.innerHTML = rows.map((r) => `
      <div class="sess-card${r.videoMissing ? ' missing' : ''}" data-id="${escape2(r.id)}">
        <div class="sess-shot">${r.thumb ? `<img src="${r.thumb}" alt="" />` : '<span>🎬</span>'}</div>
        <div class="sess-main">
          <div class="sess-name">${escape2(r.name)}</div>
          <div class="sess-sub muted small">${escape2(r.videoName || 'no video')}${r.videoMissing ? ' · <b>moved or deleted</b>' : ''}</div>
          <div class="sess-sub muted small">${r.shorts} short${r.shorts === 1 ? '' : 's'} · ${r.captions} caption line${r.captions === 1 ? '' : 's'} · ${escape2(whenWords(r.savedAt))}</div>
        </div>
        <div class="sess-btns">
          <button class="primary-btn small" data-open="${escape2(r.id)}"${r.videoMissing ? ' disabled title="The recording this session was made from is not where it was"' : ''}>Open</button>
          <button class="icon-btn" data-ren="${escape2(r.id)}" title="Rename">✏️</button>
          <button class="icon-btn danger" data-del="${escape2(r.id)}" title="Delete this session (your video and exports are untouched)">🗑</button>
        </div>
      </div>`).join('');
    $$('[data-open]', list).forEach((b) => b.addEventListener('click', async () => {
      closeSessionsWindow();
      await openSessionById(b.dataset.open);
    }));
    $$('[data-ren]', list).forEach((b) => b.addEventListener('click', async () => {
      const row = rows.find((x) => x.id === b.dataset.ren);
      const nm = await ask('Rename this session', row ? row.name : '');
      if (nm == null || !String(nm).trim()) return;
      try { await window.api.sessions.rename(b.dataset.ren, String(nm).trim()); } catch (e) {}
      if (ve.sessionId === b.dataset.ren) { ve.sessionName = String(nm).trim(); updateSessionChip(); }
      renderSessions();
    }));
    $$('[data-del]', list).forEach((b) => b.addEventListener('click', async () => {
      const row = rows.find((x) => x.id === b.dataset.del);
      if (!window.confirm('Delete the session "' + (row ? row.name : '') + '"?\n\nYour video and anything you have already exported are not touched — only this saved arrangement of work.')) return;
      try { await window.api.sessions.remove(b.dataset.del); } catch (e) {}
      if (ve.sessionId === b.dataset.del) { ve.sessionId = null; ve.sessionName = null; updateSessionChip(); }
      renderSessions();
    }));
  }

  /* ---- "carry on where you left off" ------------------------------------ */

  /**
   * Offered, never forced. On the way into an empty studio, if the rolling slot
   * holds work whose recording is still on disk, a bar appears above the drop
   * zone with the choice. Ignoring it and opening a fresh video is exactly as
   * easy as it was before.
   */
  /** A file name as a person would say it: no extension, no camera/upload
   *  timestamp in front ("20261002134418-Teaching…" → "Teaching…"). */
  function prettyVideoName(file) {
    const base = String(file || '').replace(/\.[a-z0-9]{2,5}$/i, '');
    const tidy = base.replace(/^(?:\d{8,14}|IMG|VID|MVI|DSC|PXL)[-_ ]*(?:\d{6,}[-_ ]*)?/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    return tidy || base || 'Your video';
  }
  const FILM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>';

  async function offerResume() {
    if (ve.video || ve._resumeOffered) return;
    ve._resumeOffered = true;
    let saved = null;
    try { saved = await window.api.sessions.autosaveGet(); } catch (e) { return; }
    if (!saved || !saved.video || !saved.video.path || saved.videoMissing) return;
    const tl = saved.timeline || {};
    const shorts = Array.isArray(tl.segments) ? tl.segments.filter((s) => s && s.ai).length : 0;
    const bar = $('#veResume');
    if (!bar) return;
    const file = saved.video.path.split(/[\\/]/).pop();
    const durSec = Number(saved.video.durationSec) || 0;
    const meta = [shorts ? `${shorts} short${shorts === 1 ? '' : 's'}` : null, `Edited ${whenWords(saved.savedAt)}`].filter(Boolean).join(' · ');
    bar.innerHTML = `
      <div class="ve-resume-card">
        <div class="ve-resume-thumb">${FILM_SVG}<img alt="" hidden>${durSec ? `<span class="ve-resume-dur">${clockText(durSec)}</span>` : ''}</div>
        <div class="ve-resume-info">
          <div class="ve-resume-kicker">Continue editing</div>
          <div class="ve-resume-name" title="${attr2(file)}">${escape2(prettyVideoName(file))}</div>
          <div class="ve-resume-meta">${escape2(meta)}</div>
        </div>
      </div>
      <div class="ve-resume-btns">
        <button id="veResumeNo" class="ghost-btn" type="button">Start fresh</button>
        <button id="veResumeYes" class="primary-btn" type="button">Continue</button>
      </div>`;
    bar.classList.remove('hidden');
    resumePromptQuiet(true);
    const done = () => { bar.classList.add('hidden'); resumePromptQuiet(false); };
    // a real frame of the video, when the studio can make one
    (async () => {
      try {
        const at = durSec ? Math.min(30, Math.max(1, durSec * 0.1)) : 2;
        const png = await window.api.video.thumbnail(saved.video.path, at);
        const img = bar.querySelector('.ve-resume-thumb img');
        if (!png || !img) return;
        img.onload = () => { img.hidden = false; };
        img.src = fileUrl(png);
      } catch (e) { /* the film icon stays */ }
    })();
    $('#veResumeYes').addEventListener('click', async () => {
      done();
      await applySession(saved);
      window.__toast && window.__toast('Everything is back — your clips, captions and edits, just as you left them.', 'good', 5000);
    });
    $('#veResumeNo').addEventListener('click', () => {
      done();
      window.api.sessions.autosaveClear().catch(() => {});
    });
  }
  /** While the card is up it IS the main thing on screen: the empty-studio
   *  prompt below it steps back to a quiet "Open another video". */
  function resumePromptQuiet(on) {
    const nv = $('#veNoVid'), open2 = $('#veOpen2');
    if (nv) nv.classList.toggle('with-resume', !!on);
    if (open2) {
      open2.textContent = on ? 'Open another video' : 'Browse…';
      open2.classList.toggle('ghost-btn', !!on);
      open2.classList.toggle('primary-btn', !on);
    }
  }
  /** A running time the way a video app shows it: 4:05, 55:12, 1:02:13. */
  function clockText(sec) {
    const t = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
  }

  /* =========================== WHO TO FOLLOW ==============================
   *
   * Auto-reframe decides for itself who a clip is about, and on a church
   * platform — a bishop preaching with a crozier-bearer beside him, a row of
   * clergy behind — it can decide wrong: the bearer stands perfectly still and
   * nearer the camera, so his face is the one detected in every single frame
   * while the man actually speaking is half-turned into a microphone.
   *
   * This is the control that settles it. The operator points at a person once
   * and the tracker follows THEM: not a position (they move), not a face (it
   * turns away), but what they LOOK like — a colour signature of head and
   * clothing that survives a camera change, which is what lets the same bishop
   * be picked out in a wide shot and in a close-up two angles away.
   *
   * One pick covers every short in the panel, because it is the same service
   * and the same person all the way through; a clip they simply are not in
   * falls back to the automatic guess rather than following a stranger.
   */
  const FOLLOW_KEY = 'mw-ve-follow';

  /** The lock to hand the tracker for this clip: nothing, or a signature. */
  function followLock() {
    const f = ve.subject;
    if (!f || !f.sig || !window.FaceTrack || !window.FaceTrack.unpackSig) return null;
    if (!f._sig) f._sig = window.FaceTrack.unpackSig(f.sig);
    return f._sig || null;
  }

  function loadSubject() {
    try {
      const f = JSON.parse(localStorage.getItem(FOLLOW_KEY) || 'null');
      if (f && f.sig) ve.subject = f;
    } catch (e) { /* a corrupt pick just means "decide for me" */ }
  }
  function saveSubject() {
    try {
      if (!ve.subject) localStorage.removeItem(FOLLOW_KEY);
      // `_sig` is the unpacked typed-array cache — never write that to storage
      else localStorage.setItem(FOLLOW_KEY, JSON.stringify({ sig: ve.subject.sig, thumb: ve.subject.thumb, at: ve.subject.at }));
    } catch (e) {}
  }
  function setSubject(pick) {
    ve.subject = pick;
    saveSubject();
    renderFollowRow();
    resetLiveTrack();
    window.__toast && window.__toast(pick
      ? '👤 Every short will now keep this person in the middle of the frame.'
      : '👤 Back to letting the AI pick whoever is speaking.', 'good', 6000);
  }

  /** The chip under the Auto-reframe toggle: who the next export will follow. */
  function renderFollowRow() {
    const box = $('#veFollowWho');
    if (!box) return;
    const row = $('#veFollowRow');
    if (row) row.classList.toggle('hidden', !reframeOn());
    if (!ve.subject) {
      box.innerHTML = '<span class="ve-follow-auto muted small">Following whoever the AI thinks is speaking.</span>';
      return;
    }
    box.innerHTML = `${ve.subject.thumb ? `<img class="ve-follow-face" src="${ve.subject.thumb}" alt="" />` : ''}
      <span class="ve-follow-name">Following this person</span>
      <button class="ve-follow-clear" id="veFollowX" title="Stop following them — let the AI decide again">✕</button>`;
    const x = $('#veFollowX');
    if (x) x.addEventListener('click', () => setSubject(null));
    renderReframeAi();
  }

  /* ===================== 🧠 WHO IS THE SPEAKER — THE AI REFEREE ==============
   *
   * This PC finds every person in the picture, precisely. What it gets wrong on
   * a busy platform is WHICH of them is preaching — and then the whole short
   * follows the wrong man, however smoothly. So by default each short's frames
   * are also shown to a cloud vision model (src/main/cloudsee.js): one frame per
   * camera shot, every person boxed and numbered, and it says which number is
   * speaking. The tracker treats that as fact and follows that person (see THE
   * REFEREE in facetrack.js). It uses the same free Groq key as 🎤 Listen and the
   * caption writer.
   *
   * Never silent: the Reframe tab says what the AI did for the last short, or
   * why it could not be asked and this PC decided instead.
   */
  const RF_AI_KEY = 'mw-ve-reframe-ai';
  ve.rfAi = { state: null, last: null, toldAt: 0 };
  function reframeAiMode() {
    let v = null; try { v = localStorage.getItem(RF_AI_KEY); } catch (e) {}
    return v === 'local' ? 'local' : 'cloud';
  }
  function setReframeAiMode(v) {
    try { localStorage.setItem(RF_AI_KEY, v === 'local' ? 'local' : 'cloud'); } catch (e) {}
    renderReframeAi();
  }
  async function refreshReframeAi() {
    try { ve.rfAi.state = window.api.reframe ? await window.api.reframe.aiState() : null; } catch (e) { ve.rfAi.state = null; }
    renderReframeAi();
  }
  function renderReframeAi() {
    const sel = $('#veRfAi'), note = $('#veRfAiState'), keyRow = $('#veRfAiKey'), row = $('#veRfAiRow');
    if (!sel || !note) return;
    if (row) row.classList.toggle('hidden', !reframeOn());
    const mode = reframeAiMode();
    if (sel.value !== mode) sel.value = mode;
    const st = ve.rfAi.state, last = ve.rfAi.last;
    const needKey = mode === 'cloud' && !!st && !st.ready;
    if (keyRow) keyRow.classList.toggle('hidden', !needKey);
    let text, cls = '';
    if (mode === 'local') {
      text = 'This PC decides who is speaking from what it can measure — fine with one person on stage. ☁️ The AI is far better when several people are in shot.';
    } else if (ve.subject) {
      text = 'You chose who to follow (👤), so the AI is not asked — your choice wins.';
    } else if (!window.api.reframe) {
      text = 'The AI cannot be reached from here — this PC decides who to follow.';
    } else if (needKey) {
      text = 'Needs the free Groq key — the same one 🎤 Listen and the caption writer use. Paste it below; no card needed.'; cls = 'warn';
    } else if (last && last.ok) {
      text = `✓ Last short: the AI checked ${last.asked} frame${last.asked === 1 ? '' : 's'} and found the speaker in ${last.vouched}`
        + `${last.none ? ` (nobody speaking in ${last.none})` : ''} — ${(last.ms / 1000).toFixed(1)} s${last.model ? ', ' + last.model.split('/').pop() : ''}.`;
      cls = 'good';
    } else if (last) {
      text = `⚠ Last short: the AI could not be asked (${last.why || 'no answer'}) — this PC chose who to follow instead.`; cls = 'warn';
    } else {
      text = `Each short: the AI looks at one frame from every camera shot and says who is speaking; this PC then follows them precisely. Free with ${(st && st.providerName) || 'Groq'}.`;
    }
    if (note.textContent !== text) note.textContent = text;
    note.className = 'muted small ve-insp-note' + (cls ? ' ' + cls : '');
  }
  /** The referee to hand the tracker for this short, or null for "this PC only". */
  function reframeReferee() {
    if (reframeAiMode() !== 'cloud' || !window.api.reframe || !window.api.reframe.whoIsSpeaking) return null;
    return async ({ image, frames, columns }) => {
      if (!image) return { ok: false, why: 'the frames could not be drawn' };
      try { return await window.api.reframe.whoIsSpeaking({ image, frames, columns }); }
      catch (e) { return { ok: false, why: (e && e.message) || 'the AI call failed' }; }
    };
  }
  /** What the AI did for the short just tracked — shown in the tab, and said once out loud when it failed. */
  function noteReframeAi(rep) {
    if (!rep) return;
    ve.rfAi.last = Object.assign({ at: Date.now() }, rep);
    renderReframeAi();
    if (!rep.ok && Date.now() - ve.rfAi.toldAt > 10 * 60e3) {
      ve.rfAi.toldAt = Date.now();
      window.__toast && window.__toast('⚠️ Auto-reframe could not ask the AI who is speaking (' + (rep.why || 'no answer')
        + ') — this short follows the person this PC chose. Details in 🎯 Reframe.', 'error', 9000);
    }
    refreshReframeAi();
  }
  function wireReframeAi() {
    const sel = $('#veRfAi');
    if (sel) sel.addEventListener('change', () => setReframeAiMode(sel.value));
    const keyIn = $('#veRfAiKeyIn'), save = $('#veRfAiKeySave'), get = $('#veRfAiKeyGet');
    if (save && keyIn) save.addEventListener('click', async () => {
      const k = keyIn.value.trim();
      if (!k) { keyIn.focus(); return; }
      try {
        await window.api.captions.cloudKey({ key: k });
        keyIn.value = '';
        window.__toast && window.__toast('☁️ Saved — auto-reframe will ask the AI who is speaking. (🎤 Listen and the caption writer use this key too.)', 'good', 7000);
      } catch (e) { window.__toast && window.__toast('Could not save that key: ' + ((e && e.message) || e), 'error'); }
      refreshReframeAi();
    });
    if (keyIn) keyIn.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && save) save.click(); });
    if (get) get.addEventListener('click', () => {
      try { window.api.shell.openExternal('https://console.groq.com/keys'); } catch (e) {}
    });
    refreshReframeAi();
  }

  /**
   * A still from the video to choose people out of. Uses the preview player
   * itself (already decoded, already at a sensible moment) drawn into a canvas,
   * so no export or extra ffmpeg pass is needed to open the picker.
   */
  function grabFrame() {
    const p = ve.refs.player;
    if (!p || p.readyState < 2 || !p.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = p.videoWidth; c.height = p.videoHeight;
    try { c.getContext('2d').drawImage(p, 0, 0); } catch (e) { return null; }
    return c;
  }

  /** Move the preview to a moment worth looking at, and wait for the picture. */
  function seekAndSettle(t) {
    const p = ve.refs.player;
    if (!p) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const fin = () => { if (done) return; done = true; p.removeEventListener('seeked', fin); res(); };
      p.addEventListener('seeked', fin);
      try { p.currentTime = Math.max(0, t); } catch (e) { fin(); return; }
      setTimeout(fin, 1500);   // a seek that never reports back must not hang the dialog
    });
  }

  /**
   * Open the picker on a moment of the video. `segId` (optional) picks a moment
   * inside that short, which is where the operator is most likely to find the
   * person they care about; otherwise wherever the playhead already is.
   */
  async function openFollowPicker(segId, oneClipOnly) {
    const modal = $('#followModal');
    if (!modal || !ve.video) return;
    const s = segId ? ve.segments.find((x) => x.id === segId) : null;
    ve._followSeg = s || null;
    ve._followOne = !!oneClipOnly && !!s;
    const h2 = modal.querySelector('.cap-head h2');
    if (h2) h2.textContent = ve._followOne ? '👤 Who should this short follow?' : '👤 Who should the shorts follow?';
    ve._followAt = s ? s.start + Math.min(6, (s.end - s.start) / 3) : (ve.refs.player ? ve.refs.player.currentTime : 0);
    const pl = ve.refs.player;
    ve._followWas = pl ? { t: pl.currentTime, playing: !pl.paused } : null;
    if (pl && !pl.paused) pl.pause();
    modal.classList.remove('hidden');
    await refreshFollowPicker();
  }
  function closeFollowPicker() {
    const modal = $('#followModal');
    if (modal) modal.classList.add('hidden');
    const pl = ve.refs.player, was = ve._followWas;
    ve._followWas = null;
    if (!pl || !was) return;
    try { pl.currentTime = was.t; } catch (e) {}
    if (was.playing) pl.play().catch(() => {});
  }

  /** Look at (another) moment: seek, detect everybody, draw them as choices. */
  async function refreshFollowPicker() {
    const hint = $('#followHint'), cards = $('#followCards'), boxes = $('#followBoxes'), shot = $('#followShot');
    if (!hint || !cards || !boxes || !shot) return;
    hint.textContent = 'Looking at the picture…';
    cards.innerHTML = ''; boxes.innerHTML = '';
    await seekAndSettle(ve._followAt);
    const canvas = grabFrame();
    if (!canvas) { hint.textContent = 'Play the video for a moment first, then try again.'; return; }
    shot.src = canvas.toDataURL('image/jpeg', 0.85);
    let people = [];
    try { people = await window.FaceTrack.detectPeople(canvas); } catch (e) { people = []; }
    if (!people.length) {
      hint.innerHTML = 'Nobody recognisable at this moment — try <b>🔀 A different moment</b>.';
      return;
    }
    hint.textContent = people.length === 1
      ? 'One person here. Click them to follow them in every short.'
      : `${people.length} people here. Click the one to keep in the middle of the frame.`;
    people.forEach((p, i) => {
      const hit = document.createElement('div');
      hit.className = 'follow-hit';
      hit.style.left = `${p.box.x * 100}%`;
      hit.style.top = `${p.box.y * 100}%`;
      hit.style.width = `${p.box.w * 100}%`;
      hit.style.height = `${p.box.h * 100}%`;
      hit.title = 'Follow this person';
      hit.addEventListener('click', () => choose(p));
      hit.addEventListener('mouseenter', () => cards.children[i] && cards.children[i].classList.add('on'));
      hit.addEventListener('mouseleave', () => cards.children[i] && cards.children[i].classList.remove('on'));
      boxes.appendChild(hit);

      const card = document.createElement('div');
      card.className = 'follow-card';
      card.innerHTML = `${p.thumb ? `<img src="${p.thumb}" alt="" />` : ''}<span>Person ${i + 1}</span>`;
      card.addEventListener('click', () => choose(p));
      card.addEventListener('mouseenter', () => hit.classList.add('on'));
      card.addEventListener('mouseleave', () => hit.classList.remove('on'));
      cards.appendChild(card);
    });
    function choose(p) {
      if (!p.sig) { window.__toast && window.__toast('Could not read that person clearly — try another moment.', 'error'); return; }
      const pick = { sig: p.sig, thumb: p.thumb, at: ve._followAt };
      if (ve._followSeg && ve._followOne) {
        // just this short: the rest of the panel keeps whatever it had
        ve._followSeg.subject = pick;
        renderClipList();
        window.__toast && window.__toast('👤 This short will follow the person you picked.', 'good', 6000);
      } else setSubject(pick);
      closeFollowPicker();
    }
  }

  /** A clip's own pick, unpacked (and cached on the clip). */
  function unpackClipSubject(s) {
    if (!s || !s.subject || !s.subject.sig || !window.FaceTrack || !window.FaceTrack.unpackSig) return null;
    if (!s.subject._sig) s.subject._sig = window.FaceTrack.unpackSig(s.subject.sig);
    return s.subject._sig || null;
  }

  /** Somewhere else in the clip (or the video) to look for people. */
  function followAnotherMoment() {
    const s = ve._followSeg;
    const lo = s ? s.start : 0;
    const hi = s ? s.end : (ve.video && ve.video.info ? ve.video.info.durationSec : 0);
    const span = Math.max(1, hi - lo);
    ve._followAt = lo + Math.random() * span;
    refreshFollowPicker();
  }

  const FILL_KEYS = { fill: 'mw-ve-fill', denoise: 'mw-ve-denoise', fade: 'mw-ve-fade', cover: 'mw-ve-cover', capModel: 'mw-ve-capmodel', aiModel: 'mw-ve-aimodel', asrModel: 'mw-ve-asrmodel' };
  /** Change one part of the cover and put everything else in step with it. */
  function setCover(patch) {
    Object.assign(ve.cover, patch || {});
    ve.cover.y = clamp(ve.cover.y, 0, 0.97);
    ve.cover.h = clamp(ve.cover.h, 0.02, 1 - ve.cover.y);
    syncCoverUi();
    updateCoverStrip();
    saveExportPrefs();
    return ve.cover;
  }
  function syncCoverUi() {
    const box = $('#veCover'); if (box) box.checked = !!ve.cover.on;
    const opts = $('#veCoverOpts'); if (opts) opts.classList.toggle('hidden', !ve.cover.on);
    const mode = $('#veCoverMode'); if (mode) mode.value = ve.cover.mode;
    const y = $('#veCoverY'); if (y) y.value = String(Math.round(ve.cover.y * 100));
    const h = $('#veCoverH'); if (h) h.value = String(Math.round(ve.cover.h * 100));
    const yv = $('#veCoverYV'); if (yv) yv.textContent = Math.round(ve.cover.y * 100) + '%';
    const hv = $('#veCoverHV'); if (hv) hv.textContent = Math.round(ve.cover.h * 100) + '%';
  }

  /** What the export needs to cover the old captions (null = leave them alone). */
  const coverCfg = () => (ve.cover && ve.cover.on
    ? { on: true, mode: ve.cover.mode, x: ve.cover.x, w: ve.cover.w, y: ve.cover.y, h: ve.cover.h, strength: ve.cover.strength }
    : null);

  /**
   * Draw the strip that will be covered, ON the preview.
   *
   * Percentages in a settings panel are not something anybody can aim with. The
   * operator needs to see the band sitting over the old words, so it is drawn
   * where the picture really is — which is not the whole preview box, because a
   * 16:9 recording is letterboxed inside it.
   */
  function updateCoverStrip() {
    const host = ve.refs.preview;
    if (!host) return;
    let el = document.getElementById('veCoverStrip');
    const want = !!(ve.cover && ve.cover.on) && !!ve.video;
    if (!want) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'veCoverStrip'; el.className = 've-cover-strip'; host.appendChild(el); }
    const m = previewMapping();
    el.style.left = m.offX + 'px';
    el.style.width = m.renderedW + 'px';
    el.style.top = (m.offY + ve.cover.y * m.renderedH) + 'px';
    el.style.height = Math.max(2, ve.cover.h * m.renderedH) + 'px';
  }

  /** What the main process needs to render the chosen fill (null = plain crop). */
  const fillCfg = () => (ve.fill.mode === 'crop' ? null
    : { mode: ve.fill.mode, strength: ve.fill.strength, dim: ve.fill.dim });
  /** The frame size every export is rendered at. */
  const qualityCfg = () => ve.quality || '1080p';
  /**
   * How far this export would be stretched beyond what was actually filmed.
   * 1 = not at all. Used to tell the operator the truth about a 4K export of a
   * 1080p recording: the file IS 4K, but the detail is not.
   */
  function upscaleWarning() {
    if (!ve.video || !ve.video.info) return '';
    const q = qualityCfg();
    if (q === 'source') return '';
    const shortSide = { '720p': 720, '1080p': 1080, '4k': 2160 }[q] || 1080;
    const srcShort = Math.min(ve.video.info.width || 0, ve.video.info.height || 0);
    if (!srcShort || srcShort >= shortSide) return '';
    return ` This recording is ${srcShort}p, so it is being stretched to ${q === '4k' ? '4K' : q} — the file really is that size, but the sharpness can only be what was filmed.`;
  }
  /** The noise-removal strength for an export (null = leave the audio alone). */
  const denoiseCfg = () => (ve.denoise.on ? ve.denoise.level : null);
  /**
   * 🎙️ Studio sound — the one button that does the whole job.
   *
   * The strength dropdown has always been there, but "Medium" only takes the
   * room out; it does not lift the voice out of the hall or steady the level,
   * which is what actually makes a recording sound like it was made in a studio
   * rather than filmed in one. This turns on the full chain (see
   * video.studioVoiceAf) and says plainly what it will do, rather than hiding
   * four decisions behind a checkbox.
   */
  function toggleStudioSound() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    const on = !(ve.denoise.on && ve.denoise.level === 'studio');
    ve.denoise.on = on;
    if (on) ve.denoise.level = 'studio';
    const cb = $('#veDenoise'); if (cb) cb.checked = on;
    const lvl = $('#veDenoiseLevel'); if (lvl && on) lvl.value = 'studio';
    const opts = $('#veDenoiseOpts'); if (opts) opts.classList.toggle('hidden', !on);
    saveExportPrefs && saveExportPrefs();
    updateStudioSoundButton();
    window.__toast && window.__toast(on
      ? '🎙️ Studio sound ON — every clip you export keeps the speaker and loses the room: the hall, hiss, air conditioning and rumble go, the voice comes forward and the level is evened out for broadcast. Use 🎧 Hear the difference to listen first.'
      : 'Studio sound off — the recording\'s own audio is exported untouched.', 'good', 8000);
  }
  function updateStudioSoundButton() {
    const b = $('#veStudioSound'); if (!b) return;
    const on = !!(ve.denoise.on && ve.denoise.level === 'studio');
    b.classList.toggle('on', on);
    b.textContent = on ? '🎙️ Studio sound ON' : '🎙️ Studio sound';
  }
  /** Fade-in/out seconds for the clip's own audio on export (0 = off). */
  const fadeInCfg = () => ve.fade.in || 0;
  const fadeOutCfg = () => ve.fade.out || 0;
  /** Which speech model transcribes captions ('' = auto → best installed). */
  const capModelCfg = () => ve.capModel || undefined;
  /**
   * Fill the "Caption accuracy" dropdown with whichever models are actually
   * installed right now (bundled ones always; downloaded ones once they're
   * there) — offering a model that isn't on disk would just fail transcription.
   */
  async function populateCapModelSelect() {
    const sel = $('#veCapModel'); if (!sel) return;
    let list = [];
    try { list = await window.api.captions.models(); } catch (e) {}
    const installed = list.filter((m) => m.installed);
    ve._capModelList = installed; // remembered so the Remove button knows what's bundled vs. downloaded
    if (ve._capCloud === undefined) await refreshCapCloud();
    const cloudOk = !!(ve._capCloud && ve._capCloud.ready);
    sel.innerHTML = `<option value="">Auto (${cloudOk ? '☁️ Groq cloud' : 'best installed'})</option>`
      + (cloudOk || ve.capModel === 'cloud' ? '<option value="cloud">☁️ Groq cloud (free, most accurate)</option>' : '')
      + installed.map((m) => `<option value="${m.id}">${m.name}</option>`).join('');
    // The saved choice might have since been removed (Remove in the download
    // manager) — fall back to auto rather than silently picking nothing. The
    // cloud is not a download, so it is never "removed" here.
    if (ve.capModel && ve.capModel !== 'cloud' && !installed.some((m) => m.id === ve.capModel)) { ve.capModel = ''; saveExportPrefs(); }
    sel.value = ve.capModel;
    updateCapModelRmBtn();
  }
  /** Show "Remove this model" only when a downloaded (non-bundled) model is
   *  actually selected — bundled tiny/base and "Auto" have nothing to remove. */
  function updateCapModelRmBtn() {
    const wrap = $('#veCapModelRmWrap'); const btn = $('#veCapModelRm');
    if (!wrap || !btn) return;
    const m = (ve._capModelList || []).find((x) => x.id === ve.capModel);
    const removable = !!(m && !m.bundled);
    wrap.classList.toggle('hidden', !removable);
    if (removable) {
      const size = m.sizeMB >= 1024 ? (m.sizeMB / 1024).toFixed(1) + ' GB' : m.sizeMB + ' MB';
      btn.textContent = `🗑️ Remove ${m.name} (frees ${size})`;
    }
  }

  function loadExportPrefs() {
    loadSubject();
    try {
      const f = JSON.parse(localStorage.getItem(FILL_KEYS.fill) || 'null');
      if (f && typeof f === 'object') {
        if (['crop', 'blur', 'bars'].includes(f.mode)) ve.fill.mode = f.mode;
        if (f.strength != null) ve.fill.strength = clamp(+f.strength || 0, 0, 1);
        if (f.dim != null) ve.fill.dim = clamp(+f.dim || 0, 0, 1);
      }
      const cv = JSON.parse(localStorage.getItem(FILL_KEYS.cover) || 'null');
      if (cv && typeof cv === 'object') {
        ve.cover.on = !!cv.on;
        if (['blur', 'smear', 'solid'].includes(cv.mode)) ve.cover.mode = cv.mode;
        for (const k of ['x', 'w', 'y', 'h', 'strength']) if (cv[k] != null) ve.cover[k] = clamp(+cv[k] || 0, 0, 1);
      }
      const d = JSON.parse(localStorage.getItem(FILL_KEYS.denoise) || 'null');
      if (d && typeof d === 'object') {
        ve.denoise.on = !!d.on;
        // 'studio' joined the list when the one-click voice chain arrived; an
        // older saved setting must still load rather than silently reset.
        if (['light', 'medium', 'strong', 'max', 'studio'].includes(d.level)) ve.denoise.level = d.level;
      }
      const q = localStorage.getItem('mwExportQuality');
      if (['480p', '720p', '1080p', '4k', 'source'].includes(q)) ve.quality = q;
      const fps = Number(localStorage.getItem('mwExportFps'));
      if ([0, 24, 25, 30, 50, 60].includes(fps)) ve.fps = fps;
      const rate = localStorage.getItem('mwExportRate');
      if (['lower', 'recommended', 'higher'].includes(rate)) ve.bitrate = rate;
      const fd = JSON.parse(localStorage.getItem(FILL_KEYS.fade) || 'null');
      if (fd && typeof fd === 'object') {
        if (fd.in != null) ve.fade.in = clamp(+fd.in || 0, 0, 5);
        if (fd.out != null) ve.fade.out = clamp(+fd.out || 0, 0, 5);
      }
      // A stored '' is a real choice (Automatic) and must survive; only a
      // first run with nothing stored takes the Small default.
      const storedModel = localStorage.getItem(FILL_KEYS.capModel);
      ve.capModel = storedModel == null ? DEFAULT_CAP_MODEL : storedModel;
      const savedAi = localStorage.getItem(FILL_KEYS.aiModel);
      ve.aiModel = savedAi || '';
      ve._aiModelUnset = savedAi == null;   // never chosen: renderAiPicker defaults it to ☁️ when a key exists
      ve.asrModel = localStorage.getItem(FILL_KEYS.asrModel) || '';
      // "Never show me that progress screen again" is a preference, not a
      // per-export decision — an operator who works this way always does.
      const bg = $('#veBgExport');
      if (bg) bg.checked = localStorage.getItem('mwBgExport') === '1';
    } catch (e) {}
    syncExportPrefUi();
    renderAiPicker();
    renderAsrPicker();
  }
  function saveExportPrefs() {
    touchSession();   // the export look is part of the session too
    try {
      localStorage.setItem(FILL_KEYS.fill, JSON.stringify(ve.fill));
      localStorage.setItem(FILL_KEYS.cover, JSON.stringify(ve.cover));
      localStorage.setItem(FILL_KEYS.denoise, JSON.stringify(ve.denoise));
      localStorage.setItem(FILL_KEYS.fade, JSON.stringify(ve.fade));
      localStorage.setItem(FILL_KEYS.capModel, ve.capModel || '');
      localStorage.setItem(FILL_KEYS.aiModel, ve.aiModel || '');
      localStorage.setItem(FILL_KEYS.asrModel, ve.asrModel || '');
      localStorage.setItem('mwExportQuality', ve.quality || '1080p');
      localStorage.setItem('mwExportFps', String(ve.fps || 0));
      localStorage.setItem('mwExportRate', ve.bitrate || 'recommended');
    } catch (e) {}
    pushExportPrefs();
  }
  /** What the studio is set to now — it keeps them, so it is asked first. */
  function pullExportPrefs() {
    const done = () => { ve._exportPrefsPulled = true; };
    try {
      if (!(window.api && window.api.video && window.api.video.getExportPrefs)) return done();
      Promise.resolve(window.api.video.getExportPrefs()).then((p) => {
        if (p) {
          ve.fps = Number(p.fps) || 0;
          ve.bitrate = p.rate || 'recommended';
          setVal('#veFps', String(ve.fps));
          setVal('#veBitrate', ve.bitrate);
          try { localStorage.setItem('mwExportFps', String(ve.fps)); localStorage.setItem('mwExportRate', ve.bitrate); } catch (e) {}
        }
        done();
      }, done);
    } catch (e) { done(); }
  }
  /*
   * Frame rate and bitrate are read by the ENCODER (video.setExportPrefs), not
   * passed with each export, so they reach every kind of export there is. Sent
   * whenever they change and once at start-up; the other end keeps them on disk.
   */
  function pushExportPrefs() {
    // Never before the studio has said what it already has: a phone opening
    // the cloud studio fresh would otherwise send its defaults and quietly
    // undo the choice made on another device (or before a restart).
    if (!ve._exportPrefsPulled) return;
    try {
      if (window.api && window.api.video && window.api.video.setExportPrefs) {
        Promise.resolve(window.api.video.setExportPrefs({ fps: ve.fps || 0, rate: ve.bitrate || 'recommended' })).catch(() => {});
      }
    } catch (e) {}
  }

  /* --------------- how the SCAN hears: automatic, or a named model ---------
   *
   * Same shape as the AI picker below: not-yet-downloaded models are still
   * offered with their size, and choosing one downloads it and then selects it.
   *
   * Medium is the reason this control exists. Automatic deliberately stops at
   * Small (a scan reads an hour of audio; Medium is ~3x slower), so Medium can
   * only ever be reached by asking for it by name — and the operator is told
   * both costs before it starts, because the second one is easy to miss: the
   * transcript cache is keyed by model, so switching throws away every cached
   * span for this video and the next scan pays full price again.
   */
  const SCAN_ORDER = ['base.en', 'small.en', 'medium.en'];
  async function renderAsrPicker() {
    const sel = $('#veAsrPicker'); if (!sel) return;
    let list = [];
    try { list = await window.api.captions.models(); } catch (e) { return; }
    ve._asrModelAll = list;
    const size = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
    // What automatic would land on, so the default option can name it.
    const auto = ['small.en', 'base.en'].map((id) => list.find((m) => m.id === id && m.installed)).find(Boolean);
    // Kept SHORT on purpose: the option text sets the select's width, and this
    // row already carries eleven controls — spelling "download 1.5 GB" out in
    // full pushed the whole topbar onto a second line at 1280px. The size still
    // shows (⬇), and the tooltip carries the explanation.
    // Auto means the cloud whenever the cloud judge is on (see sermon:analyze),
    // so the label says which ear Auto will actually be
    const autoName = ve.aiModel === 'cloud' ? '☁️' : (auto ? escape2(auto.name.split(' —')[0].split(' (')[0]) : '');
    const opts = [`<option value="">👂 Auto${autoName ? ' (' + autoName + ')' : ''}</option>`,
      '<option value="cloud">👂 ☁️ Whisper Large</option>'];
    for (const id of SCAN_ORDER) {
      const m = list.find((x) => x.id === id);
      if (!m) continue;
      const nm = escape2(m.name.split(' —')[0].split(' (')[0]);
      opts.push(m.installed
        ? `<option value="${m.id}">👂 ${nm}</option>`
        : `<option value="get:${m.id}">👂 ${nm} ⬇ ${size(m.sizeMB)}</option>`);
    }
    sel.innerHTML = opts.join('');
    if (ve.asrModel && ve.asrModel !== 'cloud' && !list.some((m) => m.id === ve.asrModel && m.installed)) { ve.asrModel = ''; saveExportPrefs(); }
    sel.value = ve.asrModel || '';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (!v.startsWith('get:')) { ve.asrModel = v; saveExportPrefs(); return; }
        const id = v.slice(4);
        sel.value = ve.asrModel || '';
        const m = (ve._asrModelAll || []).find((x) => x.id === id);
        const human = m ? (m.sizeMB >= 1024 ? (m.sizeMB / 1024).toFixed(1) + ' GB' : m.sizeMB + ' MB') : '';
        const slow = id === 'medium.en'
          ? '\n\nMedium hears the most words right, and it is about 3x slower over an hour of sermon than Small — a half-hour scan becomes more like an hour and a half on this PC.'
          : '';
        const ok = window.confirm(`Download ${m ? m.name.split(' —')[0] : id} (${human})?\n\n`
          + `It is free, runs on this PC and works offline afterwards.${slow}\n\n`
          + `Note: the saved transcript for a video is kept per model, so the first scan after switching has to listen to the whole thing again.`);
        if (!ok) return;
        const jobId = window.__newJobId();
        try {
          await window.__runJob(`⬇️ Downloading the ${m ? m.name.split(' —')[0] : id} listening model (${human}) — one time only…`, jobId,
            () => window.api.captions.downloadModel({ id, jobId }));
        } catch (e) {
          window.__toast && window.__toast('The download did not finish: ' + (e && e.message ? e.message : e), 'error');
          await renderAsrPicker();
          return;
        }
        ve.asrModel = id; saveExportPrefs();
        await renderAsrPicker();
        window.__toast && window.__toast(`👂 Long-to-shorts will listen with ${m ? m.name.split(' —')[0] : id} from now on.`, 'good');
      });
    }
  }

  /* ------------------ how the clips get chosen: rules or AI ----------------
   *
   * One control, following the caption-model picker's shape: models that are not
   * downloaded yet are still OFFERED, marked with their size, and choosing one
   * downloads it and then selects it — so "I want the better one" is a single
   * action rather than a hunt for a button.
   *
   * The download covers BOTH halves (the llama.cpp runtime and the weights)
   * behind one progress bar, because the operator does not care that it is two
   * things.
   */
  async function renderAiPicker() {
    const sel = $('#veAiPicker'); if (!sel) return;
    let st = null;
    // the PC's own models may be unknowable (Cloud Studio, a broken runtime) —
    // that must not take ☁️ Cloud AI away with them
    try { st = await window.api.llm.status(); } catch (e) { st = null; }
    if (!st || !Array.isArray(st.models)) st = { models: [], runtimeInstalled: false };
    ve._llmStatus = st;
    const size = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
    // The runtime rides along with the first model, so its size is added to
    // whatever download the operator is being quoted.
    const rt = st.runtimeInstalled ? 0 : 18;
    // Short, for the same reason as the Hearing picker above.
    // ☁️ first: it is the best of these by a distance (a 70-120B model on the
    // church's free Groq account against a 1.5-3B one on this CPU), and it is
    // what "make Long-to-shorts the best" asked for.
    let cloud = null;
    try { cloud = await window.api.social.cloudState(); } catch (e) { cloud = null; }
    ve._cloudJudge = cloud;
    const cloudKey = !!(cloud && (cloud.hasKey || cloud.borrowingKey));
    // never chosen by the operator → the cloud when there is a key, rules when not
    if (ve._aiModelUnset) {
      ve._aiModelUnset = false;
      if (cloudKey && !ve.aiModel) { ve.aiModel = 'cloud'; saveExportPrefs(); renderAsrPicker(); }
    }
    const opts = [`<option value="cloud">☁️ Cloud AI${cloudKey ? '' : ' 🔑'}</option>`, '<option value="">⚡ Rules</option>'];
    sel.title = "Who judges the clips. ☁️ Cloud AI is the best: Groq's large Whisper hears the sermon and a large AI model decides where "
      + 'each clip ends, which ones stand alone, and what to call them (free Groq key). ⚡ Rules and 🤖 run on this PC.';
    for (const m of st.models) {
      const nm = escape2(m.name.split(' —')[0]);
      opts.push(m.installed
        ? `<option value="${m.id}">🤖 ${nm}</option>`
        : `<option value="get:${m.id}">🤖 ${nm} ⬇ ${size(m.sizeMB + rt)}</option>`);
    }
    sel.innerHTML = opts.join('');
    // A chosen model that has since been removed must not leave the picker
    // claiming an AI pass that cannot run.
    if (ve.aiModel && ve.aiModel !== 'cloud' && !st.models.some((m) => m.id === ve.aiModel && m.installed)) {
      ve.aiModel = ''; saveExportPrefs();
    }
    sel.value = ve.aiModel || '';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (v === 'cloud') {
          const c = ve._cloudJudge;
          if (!(c && (c.hasKey || c.borrowingKey))) {
            // one free key does it all (🎤 Listen, captions, reframe, this)
            sel.value = ve.aiModel || '';
            const k = await ask('☁️ Cloud AI reads every clip with a large AI model on a free Groq account (no card). '
              + 'Paste the key (it starts gsk_) — get one free at console.groq.com/keys. It is the same key 🎤 Listen and the caption writer use.', '', { okLabel: 'Save key' });
            if (k == null || !String(k).trim()) return;
            try { await window.api.captions.cloudKey({ key: String(k).trim() }); }
            catch (e) { window.__toast && window.__toast('Could not save that key: ' + ((e && e.message) || e), 'error'); return; }
            await renderAiPicker();
          }
          ve.aiModel = 'cloud'; saveExportPrefs();
          sel.value = 'cloud'; updateAiHint(); renderAsrPicker();
          window.__toast && window.__toast('☁️ Long-to-shorts will be heard by Whisper Large and judged by a large AI model — endings, which clips stand alone, and titles.', 'good', 7000);
          return;
        }
        if (!v.startsWith('get:')) { ve.aiModel = v; saveExportPrefs(); updateAiHint(); renderAsrPicker(); return; }
        const id = v.slice(4);
        sel.value = ve.aiModel || '';       // don't show a model we haven't got yet
        const m = (ve._llmStatus.models || []).find((x) => x.id === id);
        const mb = (m ? m.sizeMB : 0) + (ve._llmStatus.runtimeInstalled ? 0 : 18);
        const human = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
        const ok = window.confirm(`Download the AI clip reader (${human})?\n\n`
          + `It is free and runs entirely on this PC — no account, no key, and it works offline afterwards.\n\n`
          + `It reads each clip and decides where it should end, which clips stand alone, and what to call them. `
          + `It makes a Deep scan noticeably slower.`);
        if (!ok) return;
        const jobId = window.__newJobId();
        try {
          await window.__runJob(`⬇️ Downloading the AI clip reader (${human}) — one time only…`, jobId,
            () => window.api.llm.install({ modelId: id, jobId }));
        } catch (e) {
          window.__toast && window.__toast('The download did not finish: ' + (e && e.message ? e.message : e), 'error');
          await renderAiPicker();
          return;
        }
        ve.aiModel = id; saveExportPrefs();
        await renderAiPicker();
        updateAiHint();
        window.__toast && window.__toast('🤖 AI clip reader ready — it will judge the next Long-to-shorts run.', 'good');
      });
      // Turning Deep off strands the reader — reflect that the moment it happens,
      // not when the scan comes back without having used it.
      const deep = $('#veDeep');
      if (deep && !deep._aiWired) { deep._aiWired = true; deep.addEventListener('change', updateAiHint); }
    }
    updateAiHint();
  }

  /** Deep is what produces the words, so the AI reader is meaningless without
   *  it — say so on the control instead of silently doing nothing. */
  function updateAiHint() {
    const sel = $('#veAiPicker'); const deep = $('#veDeep');
    if (!sel) return;
    const off = !!(ve.aiModel && deep && !deep.checked);
    sel.classList.toggle('warn', off);
    if (off) sel.title = 'The AI reader judges what was SAID, so it needs Deep switched on. Turn Deep back on to use it.';
  }
  /** Push the state onto the controls (called on load and after every change). */
  function syncExportPrefUi() {
    syncCoverUi();
    const sel = $('#veFill'); if (sel) sel.value = ve.fill.mode;
    const opts = $('#veFillOpts'); if (opts) opts.classList.toggle('hidden', ve.fill.mode !== 'blur');
    const st = $('#veFillStrength'); if (st) st.value = String(Math.round(ve.fill.strength * 100));
    const stv = $('#veFillStrengthV'); if (stv) stv.textContent = Math.round(ve.fill.strength * 100) + '%';
    const dm = $('#veFillDim'); if (dm) dm.value = String(Math.round(ve.fill.dim * 100));
    const dmv = $('#veFillDimV'); if (dmv) dmv.textContent = Math.round(ve.fill.dim * 100) + '%';
    const dn = $('#veDenoise'); if (dn) dn.checked = ve.denoise.on;
    const dno = $('#veDenoiseOpts'); if (dno) dno.classList.toggle('hidden', !ve.denoise.on);
    const dl = $('#veDenoiseLevel'); if (dl) dl.value = ve.denoise.level;
    const fi = $('#veFadeIn'); if (fi) fi.value = String(ve.fade.in);
    const fiv = $('#veFadeInV'); if (fiv) fiv.textContent = ve.fade.in.toFixed(1) + 's';
    const fo = $('#veFadeOut'); if (fo) fo.value = String(ve.fade.out);
    const fov = $('#veFadeOutV'); if (fov) fov.textContent = ve.fade.out.toFixed(1) + 's';
    // The folded-away row still has to say what it is set to, or "set once and
    // forget" turns into "forgot, and can't tell without opening it".
    const sum = $('#veExportSummary');
    if (sum) {
      const fillLabel = { crop: 'Crop to fill', blur: 'Blurred background', bars: 'Black bars' }[ve.fill.mode];
      const fadeBits = [];
      if (ve.fade.in > 0) fadeBits.push(`in ${ve.fade.in.toFixed(1)}s`);
      if (ve.fade.out > 0) fadeBits.push(`out ${ve.fade.out.toFixed(1)}s`);
      const fadeLabel = fadeBits.length ? ` · fade ${fadeBits.join('/')}` : '';
      sum.textContent = `${fillLabel} · noise ${ve.denoise.on ? ve.denoise.level : 'off'}${fadeLabel}`;
    }
    // Auto-reframe has no meaning while the whole picture is being shown — grey
    // it out and say why, instead of leaving a tick that quietly does nothing.
    const rf = $('#veAutoReframe');
    if (rf) {
      const cropping = ve.fill.mode === 'crop';
      rf.disabled = !cropping;
      const row = rf.closest('label');
      if (row) {
        row.style.opacity = cropping ? '' : '.5';
        row.title = cropping
          ? "AI follows the speaker's face so they stay visible & centered in the vertical crop"
          : 'Not used while Frame fill shows the whole picture — there is no crop to follow.';
      }
    }
  }
  function setFillMode(mode) {
    ve.fill.mode = ['crop', 'blur', 'bars'].includes(mode) ? mode : 'crop';
    saveExportPrefs(); syncExportPrefUi();
    updateCropMask();   // the preview switches between cropping and fitting
    // A blurred or letterboxed fill shows the WHOLE picture, so nothing is being
    // followed — the chip must not go on claiming otherwise.
    renderFollowRow();
  }

  /**
   * "Hear the difference": eight seconds from the playhead, played raw and then
   * cleaned, through the real ffmpeg chain the export uses.
   *
   * Noise removal is the one setting nobody can judge from a label — "Strong"
   * means nothing until you hear what it does to this room and this microphone.
   * So rather than describing it, play it.
   */
  async function hearDenoise() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    if (!ve.video.info.hasAudio) return window.__toast && window.__toast('This video has no audio track.', 'error');
    const btn = $('#veDenoiseTest');
    if (ve._hearing) return;
    ve._hearing = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparing…'; }
    try { ve.refs.player.pause(); } catch (e) {}
    const at = Math.max(0, (ve.refs.player.currentTime || 0));
    const SECS = 8;
    try {
      const [raw, clean] = await Promise.all([
        window.api.video.audioSample({ input: ve.video.path, startSec: at, durationSec: SECS, denoise: null }),
        window.api.video.audioSample({ input: ve.video.path, startSec: at, durationSec: SECS, denoise: ve.denoise.level }),
      ]);
      const play = (file, label) => new Promise((resolve) => {
        window.__toast && window.__toast(label, 'good', (SECS + 1) * 1000);
        const a = new Audio(fileUrl(file));   // main gives each render its own name
        ve._hearAudio = a;
        a.onended = a.onerror = () => { ve._hearAudio = null; resolve(); };
        const p = a.play(); if (p && p.catch) p.catch(() => resolve());
      });
      await play(raw, '🔊 BEFORE — the original audio…');
      await play(clean, `✨ AFTER — background noise removed (${ve.denoise.level})…`);
      window.__toast && window.__toast('Happy with it? It is applied to every clip you export while 🔇 is ticked.', 'good', 7000);
    } catch (e) {
      window.__toast && window.__toast('⚠️ Could not render the preview: ' + (e.message || e), 'error');
    } finally {
      ve._hearing = false;
      if (btn) { btn.disabled = false; btn.textContent = '🎧 Hear the difference'; }
    }
  }

  /* ---------------- how well the captions hear ----------------
   *
   * The bundled speech model is small, and on real preaching it mishears — it
   * wrote "STEPPING GO GIVING" where the preacher said "stepping, giving God
   * praise". Decoder tuning got the app most of the way (measured: 18.9% of
   * words differing from a small-model reference, down to 13.2%), but the rest
   * is simply model size, and shipping a 466MB model in the installer to serve
   * the churches that need it would punish the ones that don't.
   *
   * So it is a download, presented where the operator is already looking at
   * wrong words: pick a bigger model, wait once, and every caption after that is
   * better — offline, like everything else here.
   */
  /**
   * The accuracy panel — now a CHOICE, not a report.
   *
   * It used to show which model the app had picked for itself ("In use") with
   * nothing but a Download button beside the others, so an operator who had
   * downloaded Medium could not go back to Base for a quick pass, and one who
   * wanted the roughest-but-fastest model had no way to say so. Every installed
   * model is now a row you click, "Auto" is an explicit option rather than a
   * hidden default, and the choice is the same `ve.capModel` the Video Studio's
   * own dropdown writes — one setting, two places to set it.
   */
  /**
   * The Hearing picker: which listening model transcribes, as a dropdown.
   *
   * This was a list of cards below the caption text, and on an ordinary window
   * it had nowhere to live — it was squeezed until it overlapped the buttons,
   * so the choice it offered could not be made at all. One line, always
   * visible, is worth more than a handsome panel nobody can reach.
   *
   * Models that are not downloaded yet are still offered, marked with their
   * size; choosing one starts the download and then selects it, so "I want the
   * accurate one" is a single action rather than a hunt for a button.
   */
  async function renderCapModels() {
    const sel = $('#capModelSel'); if (!sel) return;
    let list = [];
    try { list = await window.api.captions.models(); } catch (e) { return; }
    ve._capModelAll = list;
    await refreshCapCloud();
    const cloud = ve._capCloud;
    const size = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB');
    const auto = list.find((m) => m.inUse);
    const autoName = cloud && cloud.ready ? '☁️ Groq cloud (free)' : (auto ? auto.name : '');
    const opts = [`<option value="">Automatic${autoName ? ' — ' + escape2(autoName) : ''}</option>`];
    /*
     * ☁️ THE BIG MODEL, FOR FREE — top of the list because it is the most
     * accurate AND the fastest ear the app has (see cloudCaptions in main.js).
     * Without a key it is still offered, as the way to add one.
     */
    if (cloud) {
      opts.push(cloud.ready
        ? '<option value="cloud">☁️ Groq cloud — Whisper Large v3 Turbo (free, most accurate)</option>'
        : '<option value="setup:cloud">☁️ Groq cloud (free, most accurate) — add your free key…</option>');
    }
    for (const m of list) {
      opts.push(m.installed
        ? `<option value="${m.id}">${escape2(m.name)}</option>`
        : `<option value="get:${m.id}">${escape2(m.name)} — download ${size(m.sizeMB)}</option>`);
    }
    sel.innerHTML = opts.join('');
    /*
     * A CHOSEN-BUT-NOT-YET-DOWNLOADED model must still show as the choice.
     * Small is the default and does not ship with the app, so on a fresh
     * install `sel.value = 'small.en'` matches no option and the browser
     * silently falls back to "Automatic" — the picker would then contradict
     * what the app is actually set to do. Its download option is selected
     * instead, which reads correctly: "Small — download 466 MB".
     */
    sel.value = ve.capModel || '';
    if (ve.capModel === 'cloud' && !(cloud && cloud.ready)) sel.value = cloud ? 'setup:cloud' : '';
    else if (ve.capModel && sel.value !== ve.capModel) sel.value = 'get:' + ve.capModel;
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', async () => {
        const v = sel.value;
        if (v === 'setup:cloud') {
          sel.value = ve.capModel || '';
          if (await setupCloudCaptions()) setCapModel('cloud');
          return;
        }
        if (v.startsWith('get:')) {
          const id = v.slice(4);
          sel.value = ve.capModel || '';        // don't leave it showing a model we haven't got
          const got = await getCapModel(id);
          if (got) setCapModel(id);             // downloaded — start using it straight away
          return;
        }
        setCapModel(v);
      });
    }
    updateCapModelNow();
  }

  /** Say which model is listening, wherever there is room to say it. */
  function updateCapModelNow() {
    const el = $('#capModelNow'); if (!el) return;
    if (capHearsInCloud()) { el.textContent = 'Listening with ☁️ Groq — Whisper Large v3 Turbo (free)'; return; }
    const list = ve._capModelAll || [];
    const picked = ve.capModel ? list.find((m) => m.id === ve.capModel) : null;
    const auto = list.find((m) => m.inUse);
    const m = picked || auto;

    el.textContent = m
      ? `Listening with ${m.name}${picked ? '' : ' (automatic)'}`
      : 'A bigger listening model hears more of the words right.';
  }

  /** Pick which model transcribes from now on ('' = automatic). */
  function setCapModel(id) {
    ve.capModel = id || '';
    saveExportPrefs();
    const sel = $('#veCapModel'); if (sel) sel.value = ve.capModel;
    updateCapModelRmBtn();
    // Say it NOW, from the list already in hand. renderCapModels has to ask the
    // main process what is on disk before it can redraw, and a header that
    // updates a moment later reads as the click not having worked.
    updateCapModelNow();
    renderCapModels();
    renderCapSummary();
    const m = (ve._capModelAll || []).find((x) => x.id === ve.capModel);
    window.__toast && window.__toast(ve.capModel === 'cloud'
      ? '☁️ Captions will be heard by Groq’s full-size Whisper from now on — free, far fewer wrong words, and seconds instead of minutes. If the internet drops, this PC hears them instead and says so.'
      : m
        ? `🎯 Captions will listen with ${m.name} from now on. Re-caption a clip to use it.`
        : (capHearsInCloud()
          ? '🎯 Automatic: captions are heard by ☁️ Groq’s free cloud Whisper while your key is set, and by this PC otherwise.'
          : '🎯 Captions will use the best model you have installed.'), 'good', 8000);
    return ve.capModel;
  }

  /* ---- ☁️ the free cloud ear for captions ---- */
  async function refreshCapCloud() {
    const api = window.api && window.api.captions && window.api.captions.cloud;
    if (!api) { ve._capCloud = null; return null; }
    try { ve._capCloud = await api(); } catch (e) { ve._capCloud = null; }
    if (ve._capCloud && ve._capCloud.ready) adoptCloudDefault();
    return ve._capCloud;
  }
  /*
   * ☁️ THE CLOUD IS THE DEFAULT EAR FOR CAPTIONS — "the API is the main/default
   * for captions".
   *
   * A church that set a PC model in the Hearing list (most did: Small was the
   * default, and the list nagged them towards it) would otherwise never hear
   * the cloud at all, because an explicit choice beats Automatic. So the first
   * time the app sees a working Groq key it moves the captions to the cloud
   * ONCE, says so, and remembers that it did: a PC model picked after that is
   * the operator's word and is kept.
   */
  const CLOUD_ADOPTED_KEY = 'mw-ve-capmodel-cloud-adopted';
  function adoptCloudDefault() {
    let done = null;
    try { done = localStorage.getItem(CLOUD_ADOPTED_KEY); } catch (e) {}
    if (done) return false;
    try { localStorage.setItem(CLOUD_ADOPTED_KEY, '1'); } catch (e) {}
    if (ve.capModel === 'cloud') return false;
    const was = (ve._capModelAll || ve._capModelList || []).find((m) => m.id === ve.capModel);
    ve.capModel = 'cloud';
    saveExportPrefs();
    const sel = $('#veCapModel'); if (sel && [...sel.options].some((o) => o.value === 'cloud')) sel.value = 'cloud';
    // Said when the operator is next looking at captions, not over another studio.
    ve._cloudAdoptNote = '☁️ Captions now listen with Groq’s free cloud Whisper (Whisper Large v3 Turbo) by default'
      + (was ? ` instead of ${was.name.split(' — ')[0]}` : '')
      + ' — far fewer wrong words, in seconds. If the internet drops, this PC hears them instead and says so. You can pick a PC model in Hearing any time.';
    return true;
  }
  /** Will the next caption be heard in the cloud? (Chosen outright, or Automatic with a key.) */
  function capHearsInCloud() {
    const c = ve._capCloud;
    if (!c || !c.ready) return false;
    return ve.capModel === 'cloud' || !ve.capModel;
  }
  /**
   * Add the free Groq key from the captions window. It is the same key 🎤
   * Listen and the caption writer use, saved in the same place — one key, every
   * AI feature. The key page opens in the browser so getting one is a minute.
   */
  async function setupCloudCaptions() {
    const c = ve._capCloud || {};
    try { if (window.api.shell && window.api.shell.openExternal) await window.api.shell.openExternal(c.keyUrl || 'https://console.groq.com/keys'); } catch (e) {}
    const key = await ask('☁️ Paste your free Groq key. The Groq page has just opened in your browser: sign in (free, no card), '
      + 'press “Create API Key”, copy it, and paste it here. The same key also powers 🎤 Listen and ✨ the AI writer.', '',
      { okLabel: 'Use this key' });
    if (!key || !key.trim()) return false;
    let r = null;
    try { r = await window.api.captions.cloudKey({ key: key.trim() }); }
    catch (e) { window.__toast && window.__toast('☁️ That key could not be saved: ' + ((e && e.message) || e), 'error', 8000); return false; }
    await refreshCapCloud();
    await renderCapModels();
    populateCapModelSelect();
    return !!(r && r.ready);
  }
  /** Say which ear heard the captions — and, when the cloud could not, why. */
  function noteHeardBy(res) {
    if (!res) return;
    const prior = (document.getElementById('capFixNote') || {}).textContent || '';
    const book = res.fixed ? ' · ' + prior : '';
    if (res.engine === 'cloud') {
      setCapFixNote(`☁️ Heard by ${res.engineName || 'Groq — Whisper Large v3 Turbo'} in ${((res.cloudMs || 0) / 1000).toFixed(1)} s${book}`, true);
    } else if (res.engine === 'mixed') {
      window.__toast && window.__toast(`☁️ Groq heard the first ${fmt(res.cloudSec)} — then ${res.cloudWhy || 'it stopped'}, so this PC heard the last ${fmt(res.pcSec)}.`, 'error', 10000);
    } else if (res.cloudWhy) {
      // Once a minute at most: "Caption all shorts" would otherwise say it twenty times.
      const now = Date.now();
      if (!ve._cloudWhySaid || now - ve._cloudWhySaid > 60000) {
        ve._cloudWhySaid = now;
        window.__toast && window.__toast(`☁️ Groq’s cloud Whisper could not be used (${res.cloudWhy}) — these captions were heard on this PC instead.`, 'error', 10000);
      }
    }
  }
  async function getCapModel(id) {
    const jobId = window.__newJobId();
    try {
      await window.__runJob('⬇️ Downloading the better listening model (one time — then it works offline)…', jobId,
        () => window.api.captions.downloadModel({ id, jobId }));
      window.__toast && window.__toast('🎯 Done — captions from now on use the more accurate model. Re-caption a clip to hear the difference.', 'good', 9000);
    } catch (e) { return false; }
    await populateCapModelSelect();
    await renderCapModels();
    return true;   // the picker selects it now that it is really on disk
  }
  async function rmCapModel(id) {
    if (!window.confirm('Remove this downloaded model? Captions will go back to the smaller one that ships with the app.')) return;
    try { await window.api.captions.removeModel({ id }); } catch (e) {}
    // Drop the choice FIRST if it was the model just deleted, so the panel never
    // redraws with "Using" on something that is no longer on disk.
    await populateCapModelSelect();
    renderCapModels();
  }

  /** Track the speaker's face across a clip range → pan keyframes in SOURCE px, or [] if unavailable.
   *  `srcPath`/`ss`/`ee` let the caller track a DERIVED file instead of the original (a PiP
   *  composite), and `pieces` names the ranges a gap-closed clip actually keeps — tracking the
   *  whole original range would follow the speaker through frames the export no longer contains,
   *  putting the crop in the wrong place after every cut. */
  /**
   * `giveUp` is an optional "is anyone still waiting for this?" question, asked
   * by the look-ahead tracker in exportAll between the two halves of the work.
   * Sampling the stills is an ffmpeg run that cannot be interrupted; watching
   * them is the long half, and there is no point starting it for a short the
   * operator has just stopped.
   */
  async function computeReframeKeyframes(s, srcPath, ss, ee, pieces, giveUp) {
    if (!window.FaceTrack) return [];
    let avail = false;
    try { avail = await window.FaceTrack.available(); } catch (e) {}
    if (!avail) { window.__toast && window.__toast('Face tracking isn’t available — exporting with a centered crop instead.', 'error'); return []; }
    const input = srcPath || ve.video.path;
    const startSec = ss != null ? ss : s.start, endSec = ee != null ? ee : s.end;
    let res;
    // 6 samples/sec, not 4. Multi-camera church footage cuts between angles in
    // bursts (measured: 25 scene events in 12s on this sermon), and the crop has
    // to SNAP at each one. At 4fps a cut can land up to 0.25s away from the
    // nearest sample, so the snap lands late and one or two output frames show
    // the new angle with the old framing — the speaker jammed against an edge for
    // ~0.3s. Finer sampling also catches quick darts that used to fall between
    // samples entirely. Measured over the 4 worst clips of a real sermon, going
    // to 6fps removed EVERY badly-framed frame (5 -> 0) and cut the worst offset
    // from 0.46 to 0.30 of the frame width. It costs ~50% more tracking time,
    // which is the right trade for footage this cut-heavy.
    // With gaps closed, the frames are sampled from the KEPT pieces joined together
    // — the tracker's clock is the finished short's clock, so its keyframes line up
    // with the export's crop even though no joined file was ever written.
    // `pairs` asks for a second still one frame after each sample: that is what
    // the tracker measures mouth movement across, and mouth movement is how it
    // tells the person PREACHING from the person standing beside them.
    try { res = await window.api.sermon.extractFrames({ input, startSec, endSec, fps: 6, pieces, pairs: true }); }
    catch (e) { return []; }
    const frames = (res && res.frames) || [];
    if (!frames.length) return [];
    if (giveUp && giveUp()) { if (res.dir) window.api.sermon.rmdir(res.dir).catch(() => {}); return []; }
    // Scene-cut events (multi-camera hard cuts / whip pans) ride along so the
    // tracker re-acquires instantly and the crop SNAPS at shot changes instead
    // of gliding across them (gliding = speaker off-frame for seconds).
    const cuts = (res && res.cuts) || [];
    let dets = [];
    // A clip of its own can override the panel-wide pick — useful when one short
    // is the only place a different person is speaking.
    const lock = (s && s.subject ? unpackClipSubject(s) : null) || followLock();
    // …and when nobody has, the AI is shown a few of these frames and says who
    // is preaching (🧠 in the Reframe tab). The PC still decides WHERE they are.
    const referee = lock ? null : reframeReferee();
    try { dets = await window.FaceTrack.detectFrames(frames, { cuts, lock, referee }); } catch (e) { dets = []; }
    if (referee && dets && dets.referee) noteReframeAi(dets.referee);   // null = nobody in shot to ask about
    if (res.dir) window.api.sermon.rmdir(res.dir).catch(() => {});
    if (!dets.length) return [];
    // Pass the export aspect ratio so the camera's safe-zone leash matches the real
    // crop width — this is what keeps the speaker inside the 9:16 frame.
    const preset = ve.presets[ve.aspect] || { w: 9, h: 16 };
    const kf = window.FaceTrack.buildKeyframes(dets, ve.video.info.width, ve.video.info.height, { targetAR: preset.w / preset.h, cuts });
    // If a plain centre crop would already have kept the speaker framed, say so
    // ONCE. The operator who has noticed that leaving auto-reframe off looks
    // just as good on their footage is right, and should be told rather than
    // left wondering whether the feature is doing anything at all.
    if (kf && kf.alreadyCentred && !ve._centredToldAt) {
      ve._centredToldAt = Date.now();
      window.__toast && window.__toast(
        '🎯 Your camera operator already keeps the speaker centred on this recording, so tracking has almost nothing to do — you can leave Auto-reframe off and get the same shot.', 'good', 11000);
    }
    return kf;
  }

  /** Overlay-lane (PiP) clips whose timeline window overlaps [s.start, s.end]. */
  function overlaysIntersecting(s) {
    return overlayClips().filter((o) => o.id !== s.id && tlPos(o) < s.end && (tlPos(o) + (o.end - o.start)) > s.start);
  }
  /**
   * Everything sitting on the overlay lane over the range [s.start, s.end], in the
   * shape video.exportOverlayComposite wants — CLIPPED to that range and re-timed
   * to the output's own clock, because the export it feeds starts at zero.
   *
   * The three kinds of overlay differ only in what `src` points at:
   *   • another slice of this recording  → the video already open
   *   • a second video                   → its own file, with its own sound
   *   • a picture                        → its own file, `still` so ffmpeg loops it
   */
  /**
   * When an overlay is on screen, in OUTPUT time, and which part of its own
   * footage each stretch shows.
   *
   * A clip with pauses closed is shorter than the range it came from, so an
   * overlay covering a removed pause comes back as SEVERAL windows — one per
   * surviving piece — each pointing at the footage that belongs to it. Getting
   * this wrong does not look like a bug, it looks like the overlay drifting late.
   */
  function overlayWindows(s, o, clock) {
    const ovStart = tlPos(o), ovEnd = ovStart + (o.end - o.start);
    const A = Math.max(ovStart, s.start), B = Math.min(ovEnd, s.end);
    if (B - A < 0.02) return [];
    const pieces = hasCuts(s) ? keptPieces(s) : [{ start: s.start, end: s.end }];
    const out = [];
    for (const p of pieces) {
      const a = Math.max(A, p.start), b = Math.min(B, p.end);
      if (b - a < 0.02) continue;
      // 'out': straight onto the finished export's clock — closed gaps AND
      // transitions taken out — for a composite laid on after the encode
      const tl = clock === 'out' ? outTime(s, a, 'start') : (hasCuts(s) ? srcToOut(s, a) : (a - s.start));
      if (tl == null) continue;
      out.push({ tlStart: tl, srcStart: o.start + (a - ovStart), srcEnd: o.start + (b - ovStart) });
    }
    return out;
  }

  /**
   * Everything sitting on the overlay lane over the range [s.start, s.end], in the
   * shape video.exportOverlayComposite wants — CLIPPED to that range and re-timed
   * to the output's own clock, because the export it feeds starts at zero.
   *
   * The three kinds of overlay differ only in what `src` points at:
   *   • another slice of this recording  → the video already open
   *   • a second video                   → its own file, with its own sound
   *   • a picture                        → its own file, `still` so ffmpeg loops it
   *
   * `mode` says what the numbers are measured against:
   *   'frame'  — the export IS the frame the preview draws (a short). pipX/pipY/
   *              pipW go straight through; the composite runs on the finished,
   *              already-cropped short.
   *   'source' — the export is the whole picture at its own size. The frame
   *              fractions are taken back through the preview's canvas transform
   *              onto the source, exactly as added text does.
   */
  function overlayPayloadFor(s, mode, clock) {
    return overlaysIntersecting(s).flatMap((o) => {
      const place = mode === 'source' ? pipOnSource(o) : {
        x: o.pipX != null ? o.pipX : 0.6, y: o.pipY != null ? o.pipY : 0.05, wFrac: o.pipW != null ? o.pipW : 0.34,
      };
      return overlayWindows(s, o, clock).map((w) => Object.assign({
        src: o.src || ve.video.path,
        still: o.kind === 'image',
        // A picture never has sound; a second video keeps its own unless silenced.
        mute: o.kind === 'image' ? true : !!o.mute,
        srcStart: w.srcStart, srcEnd: w.srcEnd, tlStart: w.tlStart,
        opacity: o.opacity != null ? o.opacity : 1,
        key: keyOn(o) ? { color: o.key.color, sim: o.key.sim, blend: o.key.blend } : undefined,
      }, place));
    });
  }

  /**
   * An overlay's placement expressed against the SOURCE picture rather than the
   * export frame — for the exports that keep the whole picture (💾 Export video,
   * a 📦 batch). When no frame is being drawn the two are the same rectangle and
   * this is the identity.
   */
  function pipOnSource(o) {
    const x = o.pipX != null ? o.pipX : 0.6, y = o.pipY != null ? o.pipY : 0.05;
    const w = o.pipW != null ? o.pipW : 0.34;
    const fr = ve._frameOn ? canvasFrameRect() : null;
    const cm = ve.canvasMap;
    if (!fr || !cm || !cm.s) return { x, y, wFrac: w };
    const map = previewMapping();
    // where the frame fraction lands on the preview…
    const px = fr.left + x * fr.w, py = fr.top + y * fr.h;
    // …undo the translate+scale the picture is under, then read it off the video
    const s = cm.s, Tx = cm.Fx - cm.Cx, Ty = cm.Fy - cm.Cy;
    const qx = (px - cm.Cx - Tx) / s + cm.Cx, qy = (py - cm.Cy - Ty) / s + cm.Cy;
    return {
      x: (qx - map.offX) / Math.max(1, map.renderedW),
      y: (qy - map.offY) / Math.max(1, map.renderedH),
      wFrac: (w * fr.w) / s / Math.max(1, map.renderedW),
    };
  }
  /* ============ AN EXPORT THAT CANNOT BE CHANGED UNDER ITS OWN FEET ========
   *
   * Sending an export to the background is only worth anything if the operator
   * can then EDIT — and an export is a chain: encode, burn the text, caption it,
   * lay the music under, put the outro on the end. Every link after the first
   * used to read the timeline live. So typing a new caption while a background
   * export was at the music step would have put the new words into a file that
   * was supposed to be finished half an hour ago, and nothing would have said so.
   *
   * The whole of what the later links read is therefore taken ONCE, at the
   * moment the export starts, and the chain reads that copy instead.
   *
   * Three of these are not merely "state" and are the reason this is a snapshot
   * rather than a promise not to touch anything:
   *
   *   • `geom` and `overlays` are measured off the LIVE PREVIEW ELEMENT. Walk
   *     to the Presentation studio and #view-video is display:none, so
   *     clientWidth reads 0 and text would be laid out against a frame of
   *     nothing. They have to be measured while the studio is still on screen.
   *   • `capStyle` and `capGroup` come from the caption controls in the DOM.
   *   • `segments` is what the overlay lane looked like, which a drag changes.
   *
   * Taken for every clip up front — in a 20-short batch, clip 20 starts an hour
   * after the operator walked away, and freezing it then would freeze the wrong
   * thing.
   */
  function freezeForExport(s) {
    const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : x);
    let geom = null, overlaysFrame = null, overlaysSource = null;
    try { geom = textExportGeom(); } catch (e) { geom = null; }
    try { overlaysFrame = overlayPayloadFor(s, 'frame'); } catch (e) { overlaysFrame = null; }
    try { overlaysSource = overlayPayloadFor(s, 'source'); } catch (e) { overlaysSource = null; }
    let capStyle = null, capGroup = null;
    try { capStyle = capStyleCfg(); } catch (e) { capStyle = null; }
    try { capGroup = capGroupCfg(); } catch (e) { capGroup = null; }
    return {
      geom,
      overlaysFrame, overlaysSource,
      // Deep copies: a caption event carries its own word timings, and retyping
      // a line edits those in place — a shallow copy would share them.
      textOverlays: clone(ve.textOverlays || []),
      capEvents: clone(ve.capEvents || []),
      capStyle, capGroup,
      capModel: ve.capModel || undefined,
      music: clone(ve.music), outro: clone(ve.outro), outroAll: ve.outroAll,
      sounds: clone(ve.sounds || []),
      // the keyframed push-ins, already on this export's own clock
      motion: (() => { try { return motionFor(s); } catch (e) { return null; } })(),
      cover: clone(ve.cover),
      // already in the shape the compositor wants (null = plain crop)
      fill: (() => { try { return fillCfg(); } catch (e) { return null; } })(),
    };
  }
  /** The frozen copy this clip is being exported from, or null for live state. */
  const F = (s) => (s && s.__snap) || null;
  /** The background task this clip's export belongs to, if any. */
  const taskOf = (s) => (s && s.__task) || null;
  /**
   * `{ task }` for __runJob, so a whole chain follows one ⇥ Run in the
   * background — and `chain`, which says WHICH pass of the export this is, so
   * the progress number can be the export's rather than this pass's.
   */
  const J = (s, chain) => (chain ? { task: taskOf(s), chain } : { task: taskOf(s) });

  /**
   * THE PASSES THIS CLIP'S EXPORT IS ABOUT TO RUN, in order.
   *
   * The progress number is built from this, so it has to be the truth: every
   * entry is decided by the SAME predicate the pass itself uses (musicFor,
   * outroFor, overlaysFor…). Plan a pass that does not run and the number stops
   * short; miss one that does and it stalls. The one case that cannot be known
   * in advance — whisper hearing no speech at all, which sends the text off to
   * its own pass instead — simply rides inside the captions slice.
   */
  function exportPlan(s, { track, captions, overlays } = {}) {
    const keys = [];
    if (track) keys.push('track');
    // The edited-video export lays its overlays on BEFORE the encode; a short
    // lays them on the finished frame afterwards. Either way it is one pass.
    if (overlays === 'source' && overlaysFor(s, 'source').length) keys.push('overlays');
    keys.push('encode');
    if (overlays !== 'source' && overlaysFor(s).length) keys.push('overlays');
    if (captions) {
      // Lines already on the 💬 lane need no listening — only the drawing pass.
      if (!hasClipCaps(s)) keys.push('caption');
      // Drawing the caption pictures here in the studio, then burning them into
      // the video, are two different pieces of work on two different machines.
      // Sharing one slice made the number fall back when the second began.
      keys.push('draw');
      keys.push('burn');
    } else if (textOverlaysFor(s).length) {
      // Text gets its own pass ONLY when there are no captions for it to ride with.
      keys.push('text');
    }
    if (soundsFor(s).length) keys.push('sounds');
    if (musicFor(s)) keys.push('music');
    if (outroFor(s)) keys.push('outro');
    // The cover picture is not in here on purpose — see CHAIN_WEIGHTS.
    return keys;
  }
  /**
   * The overlay-lane pictures this export will composite. 'frame' measures them
   * against the finished short, 'source' against the recording — the two paths
   * need different numbers, but they are the same CLIPS, and it is the count the
   * plan asks for. Taking the mode rather than assuming one keeps the plan and
   * the pass reading the same thing.
   */
  const overlaysFor = (s, mode) => ((mode === 'source'
    ? ((F(s) && F(s).overlaysSource) || overlayPayloadFor(s, 'source'))
    : ((F(s) && F(s).overlaysFrame) || overlayPayloadFor(s, 'frame'))) || []);
  /** Freeze a clip (and tie it to a task) before its chain starts. */
  function armExport(s, taskId) {
    if (!s) return s;
    s.__snap = freezeForExport(s);
    s.__task = taskId || null;
    return s;
  }
  /** Let go of the frozen copy once the chain is finished with it. */
  function disarmExport(s) { if (s) { delete s.__snap; delete s.__task; } }

  /* ---------------- starting, finishing and losing an export ----------------
   * The Cloud Studio loads this file with its own, simpler job shim and has no
   * task layer; every one of these degrades to exactly the behaviour it has
   * always had (a modal, a toast, Explorer) rather than breaking. */
  const bgExportOn = () => { const c = $('#veBgExport'); return !!(c && c.checked); };
  // Where this page shows background exports: the corner on the desk, the
  // progress pill at the top on a phone (the Cloud Studio's shell says so).
  const bgPlace = () => (typeof window.__bgPlace === 'function' && window.__bgPlace()) || 'the corner';
  function startTask(title) {
    if (!window.__newTask) return null;
    const bg = bgExportOn();
    // Backgrounding does not add a second processor. Three encodes at once is
    // three encodes sharing one, and an operator who cannot see them queueing
    // deserves to be told rather than to wonder why everything got slow.
    if (bg && window.__backgroundCount && window.__backgroundCount() >= 2) {
      window.__toast && window.__toast('Two exports are already running behind the studio — this one shares the same processor, '
        + 'so all three will take longer.', '', 8000);
    }
    return window.__newTask(title, { background: bg });
  }
  /**
   * Finished. In front of the operator that means the usual toast and Explorer.
   * Behind them it must NOT: they asked to go and do something else, and a
   * window opening over the Presentation desk mid-service is the opposite of
   * what was wanted. The chip holds the file with a button instead.
   */
  function doneTask(task, file, note) {
    const inBg = window.__endTask ? window.__endTask(task, { ok: true, file, note }) : false;
    if (!inBg) {
      window.finishedFile(file);
      if (note) window.__toast && window.__toast(note, 'good', 7000);
      return file;
    }
    window.__toast && window.__toast(`${note} It is waiting in ${bgPlace()} with a button to show the file.`, 'good', 8000);
    return file;
  }
  /** It broke, or the operator stopped it. A modal job has already said so. */
  function failTask(task, err) {
    const stopped = !!(err && err.cancelled);
    const why = stopped ? 'Stopped.' : '⚠️ ' + ((err && err.message) || err || 'It did not finish.');
    const inBg = window.__endTask
      ? window.__endTask(task, { ok: false, state: stopped ? 'stopped' : 'fail', note: why })
      : false;
    if (inBg && !stopped) window.__toast && window.__toast('⚠️ A background export stopped: ' + why.replace(/^⚠️ /, ''), 'error', 9000);
  }

  /**
   * Export one clip as a short — face-tracked (follows the speaker), a manual
   * pan/zoom crop the user set in the preview, or (if neither) a plain center crop.
   * Anything on the timeline rides along automatically: overlay-lane clips are
   * composited into the picture first (no separate "save with overlays" step),
   * and text overlays are burned in by the callers via burnTextIntoShort.
   */
  /**
   * The footage this clip's export will actually contain: the recording, the
   * range, and the kept pieces if pauses were closed.
   *
   * Pauses removed with "Close gap" used to be rendered into a joined
   * intermediate — a full re-encode of the clip that the export then
   * immediately re-encoded again, and (because the join trimmed from ABSOLUTE
   * source times with no seek) one that first decoded the sermon from 00:00 up
   * to the clip. A gap two hours in cost minutes of pure waiting. Now the kept
   * pieces just ride along: tracking and the export each cut the pauses out
   * inside their own single pass, so everything downstream still sees one
   * continuous clip with the pause gone — for free.
   *
   * It lives in one place because TWO callers need the identical answer now:
   * the export, and the look-ahead tracker that runs a clip early while the
   * previous one is still encoding. If those two ever disagreed about which
   * footage a clip is, the camera path would be built for one piece of film and
   * applied to another.
   */
  function clipFootage(s) {
    const input = ve.video.path;
    if (!hasCuts(s)) return { input, ss: s.start, ee: s.end, pieces: null };
    // The input is always the recording itself now, so these are its own times.
    const pieces = keptPieces(s);
    // ss/ee are only used if the pieces are dropped
    return { input, ss: pieces[0].start, ee: pieces[pieces.length - 1].end, pieces };
  }

  /**
   * `pre` is a camera path already worked out by the look-ahead in exportAll
   * (see trackAhead). When it is there this skips straight to the encode; when
   * it is not — a single export, or a look-ahead that failed — tracking happens
   * here exactly as it always did.
   */
  async function exportOneClip(s, pre) {
    const preset = ve.aspect;
    /*
     * 1) THE OVERLAY LANE GOES ON LAST, NOT FIRST.
     *
     * It used to be composited into the SOURCE picture and the short then cropped
     * out of that — which glues the logo to the footage. With auto-reframe on,
     * the crop window walks across the frame following the speaker, so the
     * overlay walked with it: a picture placed in the top-right corner slid
     * around the finished short instead of staying put. (Added text never had
     * this, because it is burned onto the finished short — see burnTextIntoShort
     * and the "text is fixed to the screen, like CapCut" note there.)
     *
     * So the overlay is now composited onto the EXPORTED frame, after the crop,
     * with pipX/pipY/pipW read as fractions of that frame. Three things fall out
     * of the new order for free: the face tracker looks at clean footage instead
     * of footage with a face-shaped picture-in-picture stuck on it; the composite
     * runs on a 1080-wide short instead of a 4K master; and a pause closed inside
     * the overlay's window now really removes that stretch of it.
     */
    const { input, ss, ee, pieces } = clipFootage(s);
    const gaps = pieces ? ` — ${cutsOf(s).length} gap${cutsOf(s).length > 1 ? 's' : ''} closed` : '';
    // 3) frame + export (tracking sees exactly the footage the export will contain)
    const fill = fillCfg(), denoise = denoiseCfg();
    const fadeIn = fadeInCfg(), fadeOut = fadeOutCfg();
    const clean = denoise ? ' 🔇' : '';
    if (reframeOn()) {
      const keyframes = pre && pre.keyframes
        ? pre.keyframes
        : await window.__runJob(`🎯 Tracking the speaker in "${s.label}"…`, window.__newJobId(), () => computeReframeKeyframes(s, input, ss, ee, pieces), J(s, 'track'));
      const jobId = window.__newJobId();
      return burnOverlaysIntoShort(s, await window.__runJob(`Exporting "${s.label}" (face-tracked)${gaps}${clean}…`, jobId,
        () => window.api.sermon.exportReframed({ input, startSec: ss, endSec: ee, preset, quality: qualityCfg(), keyframes, pieces, fill, denoise, cover: coverCfg(), fadeIn, fadeOut, motion: motionOf(s), label: s.label, jobId }), J(s, 'encode')));
    }
    // A blurred/letterboxed fill shows the WHOLE picture, so a manual pan/zoom
    // crop would contradict it — the fill wins, same as it does over reframing.
    const f = ve.framing;
    const manualFraming = !fill && f && (Math.abs(f.zoom - 1) > 0.01 || Math.abs(f.offsetX - 0.5) > 0.01 || Math.abs(f.offsetY - 0.5) > 0.01);
    if (manualFraming) {
      const jobId = window.__newJobId();
      return burnOverlaysIntoShort(s, await window.__runJob(`Exporting "${s.label}" (custom framing)${gaps}${clean}…`, jobId,
        () => window.api.sermon.exportFramed({ input, startSec: ss, endSec: ee, preset, quality: qualityCfg(), zoom: f.zoom, offsetX: f.offsetX, offsetY: f.offsetY, pieces, denoise, cover: coverCfg(), fadeIn, fadeOut, motion: motionOf(s), label: s.label, jobId }), J(s, 'encode')));
    }
    const jobId = window.__newJobId();
    const how = fill ? (fill.mode === 'blur' ? ' (blurred background)' : ' (letterboxed)') : '';
    return burnOverlaysIntoShort(s, await window.__runJob(`Exporting "${s.label}"${how}${gaps}${clean}…`, jobId,
      () => window.api.sermon.exportShort({ input, startSec: ss, endSec: ee, preset, quality: qualityCfg(), pieces, fill, denoise, cover: coverCfg(), fadeIn, fadeOut, motion: motionOf(s), label: s.label, jobId }), J(s, 'encode')));
  }

  /**
   * Lay the overlay lane onto a FINISHED short — after the crop, so the picture
   * sits where it was placed in the frame however the frame moved to get there.
   * `deleteInput` keeps the un-overlaid intermediate out of the output folder,
   * the same way the text and caption burns do.
   */
  async function burnOverlaysIntoShort(s, shortPath) {
    // Frozen when the export started: the placement is read off the live preview
    // (pipOnSource walks the canvas transform), and this runs AFTER the encode,
    // by which time the operator may be in another studio entirely.
    const overlays = overlaysFor(s);
    if (!overlays.length) return shortPath;
    const jid = window.__newJobId();
    const what = overlays.some((o) => o.src !== ve.video.path) ? '📺 Adding your overlays to' : '📺 Adding picture-in-picture to';
    return window.__runJob(`${what} "${s.label}"…`, jid, () => window.api.video.overlayComposite({
      base: shortPath, overlays, jobId: jid, deleteInput: true,
      outName: `short-${(s.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-overlay`,
    }), J(s, 'overlays'));
  }

  async function exportSegment(id) {
    const s = ve.segments.find((x) => x.id === id); if (!s) return;
    const task = startTask(`Exporting “${s.label || 'clip'}”`);
    armExport(s, task);
    /*
     * The text and the captions are the same job — pictures laid on a finished
     * short — so when both are wanted they share ONE pass. The pictures are
     * drawn once and handed to whichever pass is going to run.
     *
     * This is asked BEFORE anything renders now, because the progress number is
     * built from the list of passes this export is going to make, and "are
     * captions happening" is one of the things that decides it.
     */
    // Lines already on the 💬 lane are burned as they are — that needs no speech
    // engine on this machine (they may have come from the cloud ear, or been
    // typed). Only captions still to be HEARD wait on one.
    const withCaps = hasClipCaps(s) || (exportWantsCaps(s, capExportsOn()) && (await window.api.captions.available().catch(() => false)));
    if (window.__chainBegin) {
      window.__chainBegin(task, exportPlan(s, { track: reframeOn() && !!window.FaceTrack, captions: withCaps }));
    }
    try {
      let out = await exportOneClip(s);
      const text = await textImagesFor(s);
      if (withCaps) out = await autoCaptionExport(s, out, text);
      else out = await burnTextIntoShort(s, out, null, text);
      out = await finishExport(s, out); // background music, then the outro
      out = await applyThumbTo(s, out); // last, so the cover matches the finished file
      // Seen to finish, the same as a short inside a batch.
      if (window.__chainDone) await window.__chainDone(task);
      doneTask(task, out, `✅ Saved “${s.label || 'clip'}”.`);
    } catch (e) { failTask(task, e); } finally { disarmExport(s); }
  }

  /* ==================== export the edited long video ====================
   *
   * Two completely different jobs share this timeline, and conflating them is
   * what put a whole service into the Shorts panel:
   *
   *   • "Long to short clips" → many social clips, each reframed. Those live in
   *     the Shorts panel and are what Export all renders.
   *   • "I just want to trim this service and save it" → ONE video, the
   *     recording's own shape, everything on the main lane joined in order.
   *
   * This is the second job. It takes the main-lane footage the operator has left
   * on the timeline (the base clip trimmed, or split pieces with the bad parts
   * deleted), drops any pauses they closed, and renders one file.
   */
  /** The kept source ranges of the edited timeline, in order. */
  function editedPieces() {
    const main = mainClips();
    return main.flatMap((s, i) => keptPieces(s).map((p, j) => {
      const q = { start: p.start, end: p.end };
      // a transition belongs to the join INTO this clip, so it rides on the
      // clip's first piece (the first clip has nothing before it)
      if (i > 0 && j === 0 && s.trans && s.trans.type) q.trans = { type: s.trans.type, dur: s.trans.dur };
      return q;
    }));
  }
  /** The main-lane clips the edited video is made of, in order. */
  function mainClips() {
    return ve.segments.filter((s) => (s.lane || 0) === 0 && !s.ai).sort((a, b) => a.start - b.start);
  }
  /*
   * How long each transition really is once joined — the same clamp the export
   * makes (cutPlan, video.js): never more than half of either side.
   */
  function transitionOverlaps(pieces) {
    const out = [];
    let acc = 0;
    pieces.forEach((p, i) => {
      const len = p.end - p.start;
      if (i === 0) { acc = len; return; }
      if (p.trans) {
        const d = Math.max(0.05, Math.min(Number(p.trans.dur) || 0.5, acc / 2, len / 2));
        out.push({ at: p.start, d });
        acc += len - d;
      } else acc += len;
    });
    return out;
  }
  /* ======================= TRANSITIONS BETWEEN CLIPS =======================
   *
   * CapCut's white square between two clips on the main track: tap it, pick
   * how one clip becomes the next. Stored on the LATER clip (s.trans), so it
   * moves, splits and undoes with that clip; rendered by the export with
   * ffmpeg's xfade (cutPlan, video.js); and the export's clock — text,
   * captions — follows it through srcToOut.
   */
  const TRANSITIONS = [
    { id: '', name: 'None' },
    { id: 'fade', name: 'Dissolve' },
    { id: 'fadeblack', name: 'Black fade' },
    { id: 'fadewhite', name: 'White flash' },
    { id: 'slideleft', name: 'Slide left' },
    { id: 'slideright', name: 'Slide right' },
    { id: 'slideup', name: 'Slide up' },
    { id: 'slidedown', name: 'Slide down' },
    { id: 'wipeleft', name: 'Wipe' },
    { id: 'zoomin', name: 'Pull in' },
    { id: 'circleopen', name: 'Circle' },
    { id: 'radial', name: 'Clock' },
    { id: 'hblur', name: 'Blur' },
    { id: 'pixelize', name: 'Pixelate' },
    { id: 'smoothleft', name: 'Smooth' },
    { id: 'dissolve', name: 'Grain' },
  ];
  const TRANSITION_NAME = Object.fromEntries(TRANSITIONS.map((t) => [t.id, t.name]));
  const DEFAULT_TRANS_DUR = 0.5;

  /** Each join on the main track: the clip before it and the clip after it. */
  function mainJoins() {
    const m = mainClips();
    const out = [];
    for (let i = 1; i < m.length; i++) out.push({ prev: m[i - 1], seg: m[i] });
    return out;
  }

  /** The squares, on their own layer over the main track. */
  function renderJoins() {
    const track = ve.refs.track;
    if (!track) return;
    let layer = track.querySelector('.ve-joins');
    if (!layer) {
      layer = document.createElement('div');
      layer.className = 've-joins';
      track.appendChild(layer);
      // the track starts drawing a new clip on mousedown — not from a square
      layer.addEventListener('mousedown', (e) => { if (e.target.closest('.ve-join')) e.stopPropagation(); });
      layer.addEventListener('click', (e) => {
        const b = e.target.closest('.ve-join');
        if (b) { e.stopPropagation(); openTransitionPicker(b.dataset.join); }
      });
    }
    if (!ve.video) { layer.innerHTML = ''; return; }
    const top = laneTop(0) + LANE.mainH / 2;
    layer.innerHTML = mainJoins().map(({ seg }) => {
      const t = seg.trans && seg.trans.type ? seg.trans : null;
      const tip = t ? `${TRANSITION_NAME[t.type] || 'Transition'} (${(+t.dur).toFixed(1)}s) — tap to change` : 'Add a transition between these two clips';
      return `<button type="button" class="ve-join${t ? ' on' : ''}" data-join="${seg.id}" style="left:${seg.start * ve.pxPerSec}px;top:${top}px" title="${tip}" aria-label="${tip}">${t ? '<span class="ve-join-ic on"></span>' : '<span class="ve-join-ic"></span>'}</button>`;
    }).join('');
  }

  let transFor = null;   // the clip whose join the picker is editing
  function transModal() {
    let m = document.getElementById('veTransModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veTransModal';
    m.className = 'cap-modal hidden';
    m.innerHTML = `
      <div class="cap-box ve-trans-box">
        <div class="cap-head"><strong>Transition</strong><button type="button" class="ghost-btn small" data-tr-close>✕</button></div>
        <div class="ve-trans-grid">${TRANSITIONS.map((t) => `<button type="button" class="ve-trans-tile" data-tr="${t.id}"><span class="ve-trans-demo tr-${t.id || 'none'}"><i></i><b></b></span><span class="ve-trans-name">${t.name}</span></button>`).join('')}</div>
        <label class="ve-trans-dur">Duration <input type="range" min="0.2" max="2" step="0.1" value="${DEFAULT_TRANS_DUR}" data-tr-dur> <span data-tr-durv>${DEFAULT_TRANS_DUR.toFixed(1)}s</span></label>
        <div class="ve-trans-foot">
          <button type="button" class="ghost-btn" data-tr-all>Apply to all joins</button>
          <button type="button" class="primary-btn" data-tr-close>Done</button>
        </div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-tr-close]')) return closeTransitionPicker();
      const tile = e.target.closest('[data-tr]');
      if (tile) return setTransition(transFor, tile.dataset.tr, null);
      if (e.target.closest('[data-tr-all]')) return applyTransitionToAll();
    });
    const range = m.querySelector('[data-tr-dur]');
    range.addEventListener('input', () => { m.querySelector('[data-tr-durv]').textContent = (+range.value).toFixed(1) + 's'; });
    range.addEventListener('change', () => {
      const s = ve.segments.find((x) => x.id === transFor);
      if (s && s.trans && s.trans.type) setTransition(transFor, s.trans.type, +range.value);
    });
    return m;
  }
  function openTransitionPicker(segId) {
    const s = ve.segments.find((x) => x.id === segId);
    if (!s) return;
    transFor = segId;
    const m = transModal();
    syncTransitionPicker();
    m.classList.remove('hidden');
    if (window.MWIcons) window.MWIcons.iconizeTree(m);
  }
  function closeTransitionPicker() {
    const m = document.getElementById('veTransModal');
    if (m) m.classList.add('hidden');
    transFor = null;
  }
  function syncTransitionPicker() {
    const m = document.getElementById('veTransModal');
    const s = ve.segments.find((x) => x.id === transFor);
    if (!m || !s) return;
    const cur = (s.trans && s.trans.type) || '';
    m.querySelectorAll('[data-tr]').forEach((b) => b.classList.toggle('on', b.dataset.tr === cur));
    const d = s.trans && s.trans.dur ? +s.trans.dur : DEFAULT_TRANS_DUR;
    m.querySelector('[data-tr-dur]').value = String(d);
    m.querySelector('[data-tr-durv]').textContent = d.toFixed(1) + 's';
  }
  /** Set (or clear, with type '') the transition into this clip. One undo step. */
  function setTransition(segId, type, durIn) {
    const s = ve.segments.find((x) => x.id === segId);
    if (!s) return;
    const m = document.getElementById('veTransModal');
    const dur = durIn != null ? durIn : (s.trans && s.trans.dur) || (m ? +m.querySelector('[data-tr-dur]').value : DEFAULT_TRANS_DUR);
    pushHistory();
    if (type && TRANSITION_NAME[type]) s.trans = { type, dur: Math.max(0.2, Math.min(2, dur)) };
    else delete s.trans;
    syncTransitionPicker();
    renderSegments();
    if (type) previewTransitionAt(s);
  }
  function applyTransitionToAll() {
    const src = ve.segments.find((x) => x.id === transFor);
    const t = src && src.trans && src.trans.type ? src.trans : null;
    const joins = mainJoins();
    if (!joins.length) return;
    pushHistory();
    for (const { seg } of joins) {
      if (t) seg.trans = { type: t.type, dur: t.dur }; else delete seg.trans;
    }
    renderSegments();
    window.__toast && window.__toast(t ? `${TRANSITION_NAME[t.type]} on all ${joins.length} join${joins.length === 1 ? '' : 's'}.` : 'Transitions removed from every join.', 'good');
  }
  /** Play the moment around a join so the choice can be seen. */
  function previewTransitionAt(s) {
    const p = ve.refs.player;
    if (!p || !s) return;
    try { p.currentTime = Math.max(0, s.start - 1.2); p.play(); } catch (e) {}
  }

  /*
   * The preview plays the recording itself, one picture at a time, so a true
   * crossover cannot be drawn on it — but the picture is shaped the way the
   * transition goes as the playhead crosses the join (dimmed for a fade, slid
   * for a slide, pushed in for a pull-in), so what was chosen is visible
   * before anything is exported. The export is the real thing.
   */
  function updateTransitionPreview(t) {
    const p = ve.refs.player;
    if (!p) return;
    let style = '';
    for (const { prev, seg } of mainJoins()) {
      const tr = seg.trans;
      if (!tr || !tr.type) continue;
      const half = Math.max(0.1, (+tr.dur || DEFAULT_TRANS_DUR) / 2);
      // the crossover sits across the join: the last of one clip, the first of the next
      const inA = t >= prev.end - half && t < prev.end, inB = t >= seg.start && t < seg.start + half;
      if (!inA && !inB) continue;
      const k = inA ? 1 - (prev.end - t) / half : 1 - (t - seg.start) / half;   // 0 → 1 at the join
      const dir = inA ? 1 : -1;
      switch (tr.type) {
        case 'fadeblack': style = `filter:brightness(${(1 - k).toFixed(3)})`; break;
        case 'fadewhite': style = `filter:brightness(${(1 + 3 * k).toFixed(3)})`; break;
        case 'slideleft': style = `transform:translateX(${(-dir * k * 30).toFixed(1)}%)`; break;
        case 'slideright': style = `transform:translateX(${(dir * k * 30).toFixed(1)}%)`; break;
        case 'slideup': style = `transform:translateY(${(-dir * k * 30).toFixed(1)}%)`; break;
        case 'slidedown': style = `transform:translateY(${(dir * k * 30).toFixed(1)}%)`; break;
        case 'zoomin': style = `transform:scale(${(1 + 0.35 * k).toFixed(3)})`; break;
        case 'hblur': style = `filter:blur(${(8 * k).toFixed(1)}px)`; break;
        case 'pixelize': style = `filter:blur(${(4 * k).toFixed(1)}px) contrast(${(1 + k).toFixed(2)})`; break;
        default: style = `opacity:${(1 - 0.75 * k).toFixed(3)}`;
      }
      break;
    }
    if (p.dataset.trStyle !== style) {
      p.dataset.trStyle = style;
      p.style.removeProperty('filter'); p.style.removeProperty('transform'); p.style.removeProperty('opacity');
      if (style) { const [k, v] = style.split(':'); p.style.setProperty(k, v); }
    }
  }

  function editedSpan() {
    const p = editedPieces();
    if (!p.length) return null;
    const xfades = transitionOverlaps(p);
    // the stretches between the pieces: deleted clips, closed pauses
    const cuts = [];
    for (let i = 1; i < p.length; i++) if (p[i].start > p[i - 1].end + 0.001) cuts.push({ start: p[i - 1].end, end: p[i].start });
    const raw = p.reduce((a, x) => a + (x.end - x.start), 0);
    return { start: p[0].start, end: p[p.length - 1].end, pieces: p, cuts, xfades,
             kept: raw - xfades.reduce((a, x) => a + x.d, 0) };
  }
  async function exportEditedVideo() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    const span = editedSpan();
    if (!span) return window.__toast && window.__toast('Nothing on the timeline to export — the main track is empty.', 'error');
    const jobId = window.__newJobId();
    // A synthetic segment so the text / music / outro steps work exactly as they
    // do for a short. `seed` keeps it out of the clip list if anything renders.
    // …and the gaps and transitions, so text and captions are re-timed onto the
    // export's own clock (srcToOut) instead of drifting after each join
    const whole = { id: '__edited', start: span.start, end: span.end, label: 'edited', seed: true, cuts: span.cuts, xfades: span.xfades };
    // The longest export in the app — a whole service — and therefore the one
    // that most needs to be walkable-away-from.
    const task = startTask(`Saving your edited video (${fmt(span.kept)})`);
    armExport(whole, task);
    /*
     * One number for this export too, on the same terms as a short. Asked up
     * front because the plan needs to know whether captions are happening, and
     * this path never tracks (it keeps the recording's own shape, so there is
     * no crop window to move).
     */
    const planCaps = capExportsOn() && (hasClipCaps(whole) || (await window.api.captions.available().catch(() => false)));
    if (window.__chainBegin) {
      window.__chainBegin(task, exportPlan(whole, { track: false, captions: planCaps, overlays: 'source' }));
    }
    try {
      /*
       * Whatever is on the overlay lane goes in FIRST — the second video, the
       * pictures, the picture-in-picture — because everything after this point
       * (text, captions, music, outro) works on a finished file and the overlay
       * has to be part of the picture by then. The composite is the whole span,
       * so the pieces that follow are re-based onto its own clock: it starts at
       * zero, and absolute source times would land minutes off.
       *
       * Nothing on the overlay lane means nothing changes — the export is the
       * single pass it has always been.
       */
      let input = ve.video.path, ss = span.start, ee = span.end;
      let pieces = span.pieces.length > 1 ? span.pieces : null;
      // 'source': this export keeps the WHOLE picture, so the placement has to be
      // taken back out of the export frame the preview draws onto the recording
      // itself — the same conversion added text does for this path.
      // Keyframes push in on the VIDEO, not on what sits on top of it (that is
      // what the preview shows, and what CapCut does) — so with keyframes the
      // overlays go on AFTER the encode, on the finished export's own clock.
      const motion = motionFor(whole);
      const overlays = motion ? [] : overlaysFor(whole, 'source');
      if (overlays.length) {
        const jid = window.__newJobId();
        const n = overlays.length;
        input = await window.__runJob(`📺 Laying ${n === 1 ? 'your overlay' : n + ' overlays'} onto the video…`, jid,
          () => window.api.video.overlayComposite({ base: ve.video.path, baseStart: span.start, baseEnd: span.end, overlays, toTemp: true, jobId: jid }), J(whole, 'overlays'));
        ss = 0; ee = span.end - span.start;
        if (pieces) pieces = pieces.map((p) => Object.assign({}, p, { start: p.start - span.start, end: p.end - span.start }));
      }
      const removed = (span.end - span.start) - span.kept;
      const label = removed > 1
        ? `💾 Saving your edited video (${fmt(span.kept)}, ${fmt(removed)} removed)…`
        : `💾 Saving your edited video (${fmt(span.kept)})…`;
      let out = await window.__runJob(label, jobId, () => window.api.sermon.exportShort({
        input, startSec: ss, endSec: ee,
        // the recording's own shape — never a social crop
        preset: 'source', quality: qualityCfg(), pieces,
        // No fill: the frame isn't changing shape. Noise removal and fade still
        // apply — a noisy room is noisy, and a fade is wanted, whatever shape
        // the export is.
        denoise: denoiseCfg(), fadeIn: fadeInCfg(), fadeOut: fadeOutCfg(),
        // keyframed push-ins on every clip, on the edited video's own clock
        motion,
        label: (ve.video.path.split(/[\\/]/).pop() || 'video').replace(/\.[^.]+$/, '') + '-edited',
        jobId,
      }), J(whole, 'encode'));
      if (motion) {
        const post = overlayPayloadFor(whole, 'source', 'out');
        if (post.length) {
          const jid = window.__newJobId();
          out = await window.__runJob(`📺 Laying ${post.length === 1 ? 'your overlay' : post.length + ' overlays'} onto the video…`, jid,
            () => window.api.video.overlayComposite({ base: out, overlays: post, jobId: jid, deleteInput: true, outName: 'edited-overlay' }), J(whole, 'overlays'));
        }
      }
      const info = ve.video.info;
      const size = { w: info.width, h: info.height };
      const caps = planCaps;    // already asked, above, to build the plan
      // Same mapping this path has always used — only WHERE it is composited
      // has changed, never how it is laid out. (See text-wysiwyg.test.js.)
      const text = await textImagesFor(whole, size);
      if (caps) out = await autoCaptionExport(whole, out, text, size);
      else out = await burnTextIntoShort(whole, out, size, text);
      out = await finishExport(whole, out);
      if (window.__chainDone) await window.__chainDone(task);
      doneTask(task, out, `✅ Saved your edited video — ${fmt(span.kept)} long.`);
    } catch (e) { failTask(task, e); /* the modal path already said what went wrong */
    } finally { disarmExport(whole); }
  }

  /**
   * ONE STEP AHEAD, NEVER TWO.
   *
   * A batch of shorts is two jobs per clip on two different pieces of hardware:
   * WATCHING the footage (the processor and two neural nets, in this window) and
   * then ENCODING it (the GPU's video engine, in an ffmpeg of its own). Measured
   * on a real 90-second short: 107 s watching, 108 s encoding. Run strictly one
   * after another, each idles while the other works and a batch costs the sum of
   * both, every time.
   *
   * This runs `prep` for the NEXT item while the caller works on the current
   * one. It is deliberately a look-ahead of exactly ONE:
   *   • Two preps at once would not be twice as fast. They would be one prep
   *     sharing itself in half, both of them competing with the encode.
   *   • Every result is SPECULATIVE. A prep that throws yields null and the
   *     caller carries on exactly as it did before this existed.
   *   • After `stop()` nothing new begins, and a prep already in flight is told
   *     so through the `cancelled` predicate it was handed.
   *
   * `take(item, wait)` returns the prep's answer. When it is not finished yet,
   * `wait(promise)` is called so the caller can show the operator what is
   * holding things up; when it IS finished, `wait` is never called, because a
   * progress step that appears and vanishes in one frame is a flicker.
   */
  function makeLookAhead(items, prep) {
    let stopped = false;
    let cur = null;   // { item, done, promise }
    const start = (item) => {
      if (!item || stopped) return null;
      const rec = { item, done: false, promise: null };
      rec.promise = Promise.resolve()
        .then(() => (stopped ? null : prep(item, () => stopped)))
        .catch(() => null)                 // its own turn will just do it again
        .then((v) => { rec.done = true; return v; });
      return rec;
    };
    cur = start(items && items[0]);
    return {
      async take(item, wait) {
        const rec = cur && cur.item === item ? cur : null;
        cur = null;
        if (!rec) return null;
        if (rec.done) return rec.promise;
        return wait ? wait(rec.promise) : rec.promise;
      },
      begin(item) { cur = start(item); },
      stop() { stopped = true; },
      /**
       * Is this item's prep still running — i.e. will the caller have to WAIT
       * for it? Asked before `take` so the progress plan knows whether to
       * reserve a slice for work that is, most of the time, already finished.
       */
      pendingFor(item) { return !!cur && cur.item === item && !cur.done; },
      /** For tests: is a prep in flight right now? */
      get busy() { return !!cur && !cur.done; },
    };
  }

  async function exportAll() {
    const list = shortsOf().sort((a, b) => a.start - b.start); // only Long-to-shorts output
    if (!list.length) return;
    const capEngineOk = await window.api.captions.available().catch(() => false);
    const withCaps = capExportsOn() && capEngineOk;
    const task = startTask(`Exporting ${list.length} short${list.length > 1 ? 's' : ''}`);
    /*
     * FROZEN UP FRONT, ALL OF THEM.
     *
     * Twenty shorts is an hour of encoding. If clip 20 were frozen when its turn
     * came round, it would be frozen against a timeline the operator had been
     * editing for fifty minutes — which is precisely the situation this is here
     * to prevent. The whole batch is a picture of the studio at the moment
     * Export all was pressed.
     */
    list.forEach((s) => armExport(s, task));
    let done = 0, stopped = null;
    /*
     * A BATCH IS A PIPELINE, NOT A QUEUE.
     *
     * Every short is two jobs on two different pieces of hardware: watching the
     * footage (the processor and two neural nets, here in the studio) and then
     * encoding it (the GPU's video engine, in an ffmpeg of its own). Measured on
     * a real 90-second short: 107 s watching, 186 s encoding. Run strictly one
     * after another — which is what this loop did — each one idles while the
     * other works, and ten shorts cost the sum of both every time.
     *
     * So the NEXT short is tracked while THIS one encodes. Nothing about either
     * job changes; they simply stop waiting for each other. Three rules keep it
     * honest:
     *   • ONE look-ahead, never more. Two trackers would not be twice as fast,
     *     they would be one tracker sharing itself in half — and they would be
     *     competing with the encode for the same cores.
     *   • It is SPECULATIVE. If it fails, or the operator stops the batch before
     *     its turn, the answer is simply thrown away and that clip tracks itself
     *     when it gets there, exactly as it used to.
     *   • It is SILENT. The task's step and progress belong to the short the
     *     operator is actually waiting on; a look-ahead that wrote to them would
     *     make the dock jump back and forth between two clips.
     */
    /*
     * PRIMED, so there is never more than one tracker running.
     *
     * The first short has no encode to hide behind, so it is tracked on its own
     * before the loop starts — and because the loop always takes its camera path
     * from the look-ahead, it never tracks inline underneath one. Getting this
     * wrong is not a small thing: two trackers at once are not faster, they are
     * one tracker cut in half, both fighting the encode for the same cores.
     */
    const ahead = makeLookAhead(list, async (s, cancelled) => {
      if (!reframeOn() || !window.FaceTrack) return null;
      const { input, ss, ee, pieces } = clipFootage(s);
      const kf = await computeReframeKeyframes(s, input, ss, ee, pieces, cancelled);
      return kf && kf.length ? { keyframes: kf } : null;
    });
    try {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        // "Short 2 of 5" on the progress overlay, so the whole batch reads as one
        // continuous export instead of anonymous back-to-back jobs
        if (window.__setJobBatch) window.__setJobBatch(done + 1, list.length);
        if (window.__setTaskBatch) window.__setTaskBatch(task, done + 1, list.length);
        try {
          /*
           * Whatever the look-ahead worked out for this clip. If it is already
           * READY (it ran under the last encode) that is instant, and no job is
           * shown for it — there is nothing for the operator to wait on, and a
           * "Tracking…" step that appears and vanishes in the same frame is a
           * flicker, not information. If it is NOT ready, they really are
           * waiting on tracking and must be told so.
           */
          // One pass for both when both are wanted — see exportSegment.
          const caps = hasClipCaps(s) || (exportWantsCaps(s, withCaps) && capEngineOk);
          /*
           * The number on the chip is THIS short's, start to finish — so the
           * chain is rebuilt per short, and each one begins again at nothing.
           * "7 of 9" beside it is what says where the batch has got to.
           *
           * Tracking only counts as a pass when the operator is actually going
           * to wait for it. Most of the time the look-ahead did it under the
           * last short's encode and there is nothing to wait for, so putting it
           * in the plan would reserve a third of the bar for work already done.
           */
          const waitingOnTracking = ahead.pendingFor(s);
          if (window.__chainBegin) {
            window.__chainBegin(task, exportPlan(s, { track: waitingOnTracking, captions: caps }));
          }
          const got = await ahead.take(s, (p) => window.__runJob(
            `🎯 Tracking the speaker in "${s.label}"…`, window.__newJobId(), () => p, J(s, 'track')));
          // Start the NEXT one's tracking now, so it runs under this encode.
          if (i + 1 < list.length) ahead.begin(list[i + 1]);
          let out = await exportOneClip(s, got);
          const text = await textImagesFor(s);
          if (caps) out = await autoCaptionExport(s, out, text);
          else out = await burnTextIntoShort(s, out, null, text);
          out = await finishExport(s, out); // background music, then the outro
          if (window.__taskAddFile) window.__taskAddFile(task, out);
          done++;
          // Let this one be seen to finish before the next resets the number.
          if (window.__chainDone) await window.__chainDone(task);
        } catch (e) { stopped = e; break; }
      }
    } finally {
      // Whatever ended the batch — finished, stopped, broke — a look-ahead may
      // still be watching a clip nobody is going to export now. It cannot be
      // interrupted mid-ffmpeg, but it is asked before the long half starts, so
      // the studio goes quiet in seconds rather than minutes.
      ahead.stop();
      list.forEach(disarmExport);
    }
    if (window.__setJobBatch) window.__setJobBatch(null);
    const extras = [ve.music ? 'music' : null, (ve.outro && ve.outroAll !== false) ? 'your outro' : null].filter(Boolean).join(' + ');
    if (done) {
      const note = `✅ Exported ${done} short${done > 1 ? 's' : ''}${withCaps ? ' with captions' : ''}${extras ? ' + ' + extras : ''} to your output folder.`
        + (stopped ? ` The rest ${stopped.cancelled ? 'were stopped' : 'did not finish'}.` : '');
      const inBg = window.__endTask ? window.__endTask(task, { ok: true, note }) : false;
      window.__toast && window.__toast(note, 'good');
      // Opening the output folder over whatever the operator moved on to is the
      // one thing a background run must not do.
      if (!inBg && window.api.shell.openPath) ve._openOut();
    } else {
      failTask(task, stopped || { message: 'Nothing was exported.' });
    }
  }
  ve._openOut = async () => { try { const p = await window.api.paths.get(); window.api.shell.openPath(p.outputDir); } catch (e) {} };

  /* ---------------- timeline pointer interaction ---------------- */
  function trackX(ev) { const r = ve.refs.track.getBoundingClientRect(); return ev.clientX - r.left; }
  function trackY(ev) { const r = ve.refs.track.getBoundingClientRect(); return ev.clientY - r.top; }

  function onTrackDown(ev) {
    if (!ve.video) return;
    const segEl = ev.target.closest('.ve-seg');
    const edge = ev.target.dataset ? ev.target.dataset.edge : null;
    if (segEl) {
      const s = ve.segments.find((x) => x.id === segEl.dataset.id);
      selectSeg(s.id);
      // CapCut behaviour: the playhead follows your click (so Split "just works")
      if (!edge) seekTo(trackX(ev) / ve.pxPerSec);
      // Snapshot BEFORE the drag, but only commit it to history if something actually moved (avoid cluttering undo with plain clicks).
      const preSnap = snapshotState();
      if (edge) ve.drag = { mode: edge === 'l' ? 'trimL' : 'trimR', id: s.id, x0: trackX(ev), s0: s.start, e0: s.end, p0: tlPos(s), lane0: s.lane || 0, preSnap };
      else ve.drag = { mode: 'move', id: s.id, x0: trackX(ev), s0: s.start, e0: s.end, p0: tlPos(s), lane0: s.lane || 0, preSnap };
      bind(); ev.preventDefault(); return;
    }
    // clicking the video track (even empty space) makes VIDEO the active row
    ve.activeRow = 'video'; ve.audioSel = null; renderAudioSegments();
    // empty area: seek immediately; may become a drag-to-create-selection
    seekTo(trackX(ev) / ve.pxPerSec);
    ve.drag = { mode: 'maybe', x0: trackX(ev), t0: trackX(ev) / ve.pxPerSec, moved: false };
    bind(); ev.preventDefault();
  }

  function onMove(ev) {
    const d = ve.drag; if (!d) return;
    const x = trackX(ev), t = clamp(x / ve.pxPerSec, 0, dur());
    if (d.mode === 'maybe') {
      if (Math.abs(x - d.x0) > 4) { d.mode = 'select'; d.selStart = d.t0; }
      else return;
    }
    if (d.mode === 'select') {
      const a = Math.min(d.selStart, t), b = Math.max(d.selStart, t);
      ve.refs.selbox.style.display = 'block';
      ve.refs.selbox.style.left = (a * ve.pxPerSec) + 'px';
      ve.refs.selbox.style.width = ((b - a) * ve.pxPerSec) + 'px';
      d.a = a; d.b = b;
    } else if (d.mode === 'move') {
      const len = d.e0 - d.s0;
      const moving = ve.segments.find((y) => y.id === d.id);
      /*
       * How far right a block may go. A MAIN-lane clip cannot pass dur() - len:
       * its position IS a source time, and there is no footage past the end.
       * An OVERLAY can — the last five seconds of the service is exactly where
       * the closing graphic goes, and refusing to put a 5s picture there because
       * the video is 14s long would have made the timeline unusable at its end.
       * What hangs over the edge is simply not rendered (the composite is bounded
       * by the base), so only the START has to be on the timeline.
       */
      const maxStart = (moving && moving.lane === 1) ? Math.max(0, dur() - 0.2) : dur() - len;
      let ns = clamp(d.p0 + (x - d.x0) / ve.pxPerSec, 0, maxStart);
      // snap the clip's LEFT edge, or its right edge, to nearby edges/playhead
      const snapL = snapT(ns, d.id), snapR = snapT(ns + len, d.id);
      if (snapL.snapped) ns = clamp(snapL.t, 0, maxStart);
      else if (snapR.snapped) ns = clamp(snapR.t - len, 0, maxStart);
      const s = moving;
      // vertical position decides the lane: top = OVERLAY (picture-in-picture), bottom = MAIN.
      // Added media has no main-lane meaning (its frames are not in this recording),
      // so it stays up top however far down you drag it.
      // Which ROW the pointer is over, so a second overlay can be dropped on its
      // own row and both show at once. Added media never falls to the main lane.
      let targetLane = laneAtY(trackY(ev));
      if (isMedia(s) && targetLane === 0) targetLane = Math.max(1, d.lane0 || 1);
      if (targetLane >= 1) { s.lane = targetLane; s.start = d.s0; s.end = d.e0; s.tlStart = ns; if (s.pipX == null) { s.pipX = 0.6; s.pipY = 0.05; s.pipW = 0.34; } }
      else { s.lane = 0; s.tlStart = undefined; s.start = ns; s.end = ns + len; }
      renderSegmentsSoon(true);
    } else if (d.mode === 'trimL') {
      const s = ve.segments.find((y) => y.id === d.id);
      // An OVERLAY clip's block position is independent of its footage, so its two
      // edges do different jobs from a main-lane clip's. Dragging the left edge
      // moves the in-point AND the block together — the picture stays where it is
      // in the frame and simply starts later — and it cannot be pulled back past
      // the beginning of its own source. Main-lane clips are unchanged: there the
      // block position IS the source time.
      if ((s.lane || 0) >= 1) {
        const nt = clamp(snapT(t, d.id).t, d.p0 - d.s0, d.p0 + (d.e0 - d.s0) - 0.3);
        s.start = d.s0 + (nt - d.p0); s.tlStart = nt;
      } else s.start = clamp(snapT(t, d.id).t, 0, s.end - 0.3);
      renderSegmentsSoon(true);
    } else if (d.mode === 'trimR') {
      const s = ve.segments.find((y) => y.id === d.id);
      // The right edge says how long it shows — bounded by how much footage the
      // file actually has left (a picture has as much as you like).
      if ((s.lane || 0) >= 1) {
        const nEnd = clamp(snapT(t, d.id).t, d.p0 + 0.3, d.p0 + (srcLen(s) - s.start));
        s.end = s.start + (nEnd - d.p0);
      } else s.end = clamp(snapT(t, d.id).t, s.start + 0.3, dur());
      renderSegmentsSoon(true);
    }
  }

  function onUp() {
    const d = ve.drag; ve.drag = null;
    document.removeEventListener('mousemove', onMove);
    if (!d) return;
    // the drag only repainted the clip blocks — bring every other lane back in step
    if (d.mode === 'move' || d.mode === 'trimL' || d.mode === 'trimR') renderSegments();
    if (d.mode === 'maybe') { seekTo(d.t0); }
    else if (d.mode === 'select') {
      ve.refs.selbox.style.display = 'none';
      if (d.b - d.a >= 1) { pushHistory(); addSegment(d.a, d.b, 'Clip ' + (ve.segments.length + 1), false); }
    } else if ((d.mode === 'move' || d.mode === 'trimL' || d.mode === 'trimR') && d.preSnap) {
      const s = ve.segments.find((y) => y.id === d.id);
      if (s && (Math.abs(s.start - d.s0) > 0.01 || Math.abs(s.end - d.e0) > 0.01 || Math.abs(tlPos(s) - d.p0) > 0.01 || (s.lane || 0) !== d.lane0)) {
        // The base clip STAYS the base clip when it is trimmed or moved.
        // Dragging its edge in to where the preaching starts is how the operator
        // says "this is the part of the recording I care about" — it is not the
        // act of making a short. Clearing the flag here put the whole long video
        // into the Shorts panel, so "Export all" rendered the entire service
        // alongside the shorts. Splitting it / closing a gap keep the flag too
        // (see doSplit / absorbNext) — editing the video never creates shorts.
        commitDragHistory(d.preSnap);
        renderClipList();
      }
    }
  }
  function bind() { document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp, { once: true }); }

  /* ---------------- more tools ---------------- */
  async function moreTool(tool) {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    const input = ve.video.path, jobId = window.__newJobId();
    try {
      let out;
      if (tool === 'autotrim') {
        const res = await window.__runJob('AI is trimming dead air…', jobId, () => window.api.video.autoTrim({ input, noiseDb: -30, minSilenceSec: 0.6, jobId }));
        out = res.output; window.__toast && window.__toast(`✨ Removed ~${res.removedSeconds}s of silence.`, 'good');
      } else if (tool === 'reshape') {
        out = await window.__runJob('Reshaping for ' + ve.aspect + '…', jobId, () => window.api.video.export({ input, preset: ve.aspect, jobId }));
      } else if (tool === 'extract') {
        out = await window.__runJob('Extracting audio…', jobId, () => window.api.video.extractAudio({ input, jobId }));
      } else if (tool === 'merge') {
        const paths = await window.api.dialog.openFile([{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] }], true);
        if (!paths) return;
        const inputs = [input, ...(Array.isArray(paths) ? paths : [paths])];
        out = await window.__runJob('Merging clips…', jobId, () => window.api.video.merge({ inputs, jobId }));
      } else if (tool === 'stabilize') {
        out = await window.__runJob('🫳 Stabilizing (analyzing motion, then smoothing)…', jobId, () => window.api.video.stabilize({ input, jobId }));
        window.__toast && window.__toast('✅ Stabilized — camera shake reduced.', 'good');
      } else if (tool === 'reverse') {
        const sel = ve.segments.find((x) => x.id === ve.sel);
        const args = sel ? { input, startSec: sel.start, endSec: sel.end, jobId } : { input, jobId };
        out = await window.__runJob('⏪ Reversing…', jobId, () => window.api.video.reverse(args));
      } else if (tool === 'freeze') {
        const t = ve.refs.player.currentTime || 0;
        out = await window.__runJob('❄️ Freezing frame…', jobId, () => window.api.video.freezeFrame({ input, timeSec: t, holdSec: 2, jobId }));
      } else if (tool === 'proxy') {
        if (!ve.video) return;
        showPreparing($('#veNoVid'), ve.refs.player, ve.video.info.vcodec);
        makeProxyBg(input);
        window.__toast && window.__toast('🧩 Building a smooth-editing proxy in the background…', 'good');
        return;
      }
      if (out) window.finishedFile(out);
    } catch (e) {
      window.__toast && window.__toast('⚠️ Error: ' + (e.message || 'Tool failed'), 'error');
    }
  }

  /* ---------------- auto-captions (CapCut-style) ---------------- */
  function transformCase(t, c) {
    if (c === 'upper') return t.toUpperCase();
    if (c === 'lower') return t.toLowerCase();
    if (c === 'title') return t.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    return t;
  }
  /**
   * Punctuation earns nothing on a caption. A line holds three or four words for
   * a second and a half — the pause IS the line break — so a full stop hanging
   * off "THE END GOAL." is pure visual noise, and whisper sprinkles commas and
   * quotes liberally. So none of these are ever drawn:
   *
   *     .   ,   ?   "   “ ”   « »   …   and their full-width twins
   *
   * Apostrophes stay (DON'T, YOU'RE), and so do hyphens and exclamation marks. A
   * full stop or comma BETWEEN DIGITS stays too, so "1,000" survives.
   *
   * This MUST stay identical to captioner.cleanCaptionText in the main process —
   * that one is the last gate before the burn, and if the two disagreed the
   * preview would promise something the exported file didn't deliver.
   * test/captions-accuracy.test.js checks the two against each other.
   */
  function cleanCapText(t) {
    return String(t)
      .replace(/[’ʼ]/g, "'")                 // curly apostrophe is part of the WORD
      .replace(/["“”„‟«»‹›″＂‘]/g, '')       // quotes of every shape
      .replace(/[?？¿]/g, '')                // question marks
      .replace(/[…⋯]/g, ' ')                 // ellipsis reads as a pause
      .replace(/[.,。．，、]/g, (m, i, s) =>  // full stops / commas: keep only between digits
        (/\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '') ? m : ''))
      .replace(/\s+/g, ' ')
      .trim();
  }
  /* A silence this long ends the caption line no matter how few words are on it.
   * Two reasons: a line should not be held across a pause the viewer can hear,
   * and the word lists of several separately-captioned shorts share one array —
   * without this, regrouping would join the end of one clip to the start of the
   * next into a single line spanning the gap between them. */
  const CAP_GAP_BREAK_SEC = 1.2;
  function groupWords(words, wordsPerLine, textCase) {
    const events = [];
    const push = (g) => { if (g.length) { const text = cleanCapText(transformCase(g.map((x) => x.text).join(' '), textCase)); if (text) events.push({ start: g[0].start, end: g[g.length - 1].end, text }); } };
    const runs = [];
    let run = [];
    for (const w of words) {
      const prev = run[run.length - 1];
      if (prev && (w.start - prev.end) > CAP_GAP_BREAK_SEC) { runs.push(run); run = []; }
      run.push(w);
    }
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (wordsPerLine === 'auto') { let cur = []; for (const w of r) { cur.push(w); if (cur.length >= 6 || /[.?!,]$/.test(w.text)) { push(cur); cur = []; } } push(cur); }
      else { const n = Math.max(1, parseInt(wordsPerLine, 10) || 3); for (let i = 0; i < r.length; i += n) push(r.slice(i, i + n)); }
    }
    return events.sort((a, b) => a.start - b.start);
  }
  const capGroupCfg = () => ({ wpl: document.getElementById('capWords').value, tc: document.getElementById('capCase').value });

  /* ------------------------- the Word Book -------------------------
   * "I have to make many corrections after the captions are generated,
   *  even repeated ones, and it's slowing me down."
   *
   * A repeated correction is the bug. Retyping EPHESIANS in line 14 says
   * nothing about line 91, and says nothing at all about next Sunday, so the
   * same twenty words get retyped every week. From here on, one correction
   * does three jobs:
   *
   *   1. it is applied to every other line in this video immediately, and to
   *      the word timings underneath them (or changing Words/line later would
   *      quietly put the wrong word back);
   *   2. it is written into the Word Book in the main process, which fixes it
   *      in every transcription from now on, before the words ever arrive;
   *   3. its spelling becomes something to SOUND LIKE, so the next variant of
   *      the same name is caught without being taught.
   *
   * The matching itself is window.WordBook (src/renderer/wordbook.js) — the
   * very same module the main process runs, so what happens here as you type
   * and what happens there on the next transcription cannot disagree.
   */
  const WB = () => window.WordBook || null;
  /* Null on a build (or a test harness) whose main process does not answer the
   * Word Book channels — asked once, then remembered, so a missing handler costs
   * one caught rejection rather than one per correction. */
  const wbApi = () => (!ve._wbNoApi && window.api && window.api.captions && window.api.captions.wordbook) || null;
  const wbBlank = () => ({ enabled: true, soundAlike: true, fixes: [], terms: [], fixedTotal: 0, seedTerms: 0 });

  /** The book as the main process last described it, plus its compiled lookup
   *  tables. Held here so fixing a line is instant rather than a round trip. */
  async function loadWordBook(force) {
    if (ve._wb && !force) return ve._wb;
    const api = wbApi();
    let v = null;
    if (api) { try { v = await api.get(); } catch (e) { v = null; ve._wbNoApi = true; } }
    ve._wb = v || wbBlank();
    ve._wbM = WB() ? WB().compile(ve._wb) : null;
    syncWordBookButton();
    /*
     * A book written under the older rule is tidied by the main process before
     * it is ever used — entries like "he's → it's" that were right on one line
     * and wrong on the next. Said out loud, once: it is the operator's book,
     * and it must not change under them without a word.
     */
    if (v && v.tidied && v.tidied.removed && !ve._wbTidySaid) {
      ve._wbTidySaid = true;
      window.__toast && window.__toast(
        `📕 The Word Book had ${v.tidied.removed} correction${v.tidied.removed === 1 ? '' : 's'} that depended on the `
        + `sentence they were typed in (${(v.tidied.examples || []).slice(0, 3).join(', ')}) — one everyday word swapped `
        + `for another. They fought each other and every new video, so they have been removed; `
        + `${v.tidied.after} names and phrases are kept. From now on a correction like that is remembered `
        + `WITH the words around it instead.`, 'good', 15000);
    }
    return ve._wb;
  }
  /** The button says how much it knows, because a feature you cannot see the
   *  size of is one you do not trust to be working. */
  function syncWordBookButton() {
    const b = document.getElementById('capWordBook');
    if (!b) return;
    const n = ((ve._wb || {}).fixes || []).length + ((ve._wb || {}).terms || []).length;
    b.textContent = n ? `📕 Word Book (${n})` : '📕 Word Book';
  }
  /** Push the caption store's words into the rows that are on screen, without
   *  touching the DOM those rows are made of. Same rows, same focus, same caret. */
  function syncCapListValues() {
    const evs = ve.capEvents || [];
    document.querySelectorAll('#capList .cap-text').forEach((inp) => {
      const e = evs[+inp.dataset.i];
      if (e && inp.value !== e.text) inp.value = e.text;
    });
  }
  function setCapFixNote(text, good) {
    const el = document.getElementById('capFixNote');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('good', !!good && !!text);
  }

  /**
   * Run a matcher over EVERY caption line in this video, and over the word
   * timings the lines are re-broken from.
   *
   * Both, always. The lines are what gets burned; the words are what Words/line
   * rebuilds the lines out of — correct only the lines and the fix survives
   * exactly until somebody changes 3 words a line to 2.
   */
  function applyMatcherToCaptions(m) {
    const W = WB();
    const evs = ve.capEvents || [];
    if (!W || !m || m.empty || !evs.length) return { count: 0, lines: 0, changes: [] };
    /*
     * The lines are swept as ONE STREAM, not one at a time.
     *
     * On a shorts caption Words/line is often 1, so "A FEE SHINS" is not a line
     * with a wrong word in it — it is three lines. Fixing each line on its own
     * would never see the phrase, which is exactly the case this feature exists
     * for. A replacement that swallows a line break lands on the line the
     * phrase started on and takes the eaten line's time with it.
     */
    const r = W.applyAcrossLines(evs, m);
    const rw = (ve.capWords || []).length ? W.applyToWords(ve.capWords, m) : { count: 0, words: null };
    if (!r.count && !rw.count) return { count: 0, lines: 0, changes: [] };
    pushHistory({ captions: true });        // one Ctrl+Z puts the whole sweep back
    // An imported line keeps the words it ARRIVED with in `origText`, and the
    // Case dropdown rebuilds from those. A corrected line that kept its old
    // origText would put the wrong word straight back the moment somebody
    // picked ALL CAPS, so a corrected line loses it and is re-cased from itself.
    ve.capEvents = r.lines.map((l, i) => (l !== evs[i]
      ? Object.assign({}, l, l.origText != null ? { origText: undefined } : {},
        evs[i] && l.text !== evs[i].text ? { _was: evs[i]._was != null ? evs[i]._was : evs[i].text } : {})
      : l));
    if (rw.count) ve.capWords = rw.words;
    // The values are written into the rows that are already there rather than
    // the list being rebuilt. This sweep is triggered BY a commit, and a commit
    // is usually a click on the next line — rebuilding the list here would
    // destroy the row that click is on its way to, and swallow it.
    if (r.dropped) renderCapList(); else syncCapListValues();
    renderCapTrack();
    renderClipList();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    return { count: r.count, lines: r.linesChanged + r.dropped, changes: r.changes, words: rw.count };
  }

  /**
   * A caption line was retyped. Spread it, then remember it.
   *
   * The spread happens first and synchronously: it is local arithmetic and the
   * operator is still looking at the list. Remembering it crosses to the main
   * process, so it is not allowed to hold up the typing.
   */
  function learnCaptionEdit(before, after, at) {
    const W = WB();
    if (!W) return null;
    const b = String(before == null ? '' : before), a = String(after == null ? '' : after);
    if (!b || !a || b === a) return null;
    /*
     * THE LINES EITHER SIDE ARE PART OF THE EVIDENCE.
     *
     * At Words/line 1 — what a shorts caption normally is — a line IS one word,
     * so an edit like "he's" → "it's" arrives with no context at all and there
     * is nothing to tell a later sermon whether it applies. The neighbouring
     * caption lines are exactly the missing context, and they are right here.
     */
    const evs = ve.capEvents || [];
    const i = Number.isFinite(at) ? at : -1;
    const ctx = i >= 0
      ? { prev: (evs[i - 1] || {}).text || '', next: (evs[i + 1] || {}).text || '' }
      : null;
    let cands = [];
    try { cands = W.learnFromEdit(b, a, ctx); } catch (e) { cands = []; }
    if (!cands.length) return null;
    /*
     * WHICH corrections may be spread across the rest of the video, and which
     * may not.
     *
     * "a fee shins" → "Ephesians" is not a judgement: those words are not
     * English and every other line that says them is wrong in the same way. But
     * "there" → "their" is a judgement about ONE sentence — the video is full of
     * legitimate "there"s, and rewriting them would be this feature making the
     * captions worse instead of better. So an everyday-word swap changes the
     * line it was typed on and nothing else, until the operator has made the
     * same correction twice, at which point the main process promotes it and it
     * sweeps the rest of the video below.
     */
    const safe = cands.filter((c) => !c.risky);
    const spread = safe.length
      ? applyMatcherToCaptions(W.matcherFor(safe.map((c) => ({ from: c.from, to: c.to }))))
      : { count: 0, lines: 0, changes: [] };
    const api = wbApi();
    const done = (res) => {
      ve._wb = null;                        // the book has changed; re-read it lazily
      const learned = (res && res.learned) || [];
      const waiting = (res && res.waiting) || [];
      // A judgement call that has now been made twice is no longer a judgement
      // call: the main process has switched it on, so the rest of the video
      // catches up with it here.
      // Nothing is stored bare any more, so there is no promotion to wait for.
      const promoted = learned.filter((l) => cands.some((c) => c.risky && c.from === l.from));
      const late = promoted.length
        ? applyMatcherToCaptions(W.matcherFor(promoted.map((c) => ({ from: c.from, to: c.to }))))
        : { count: 0, lines: 0 };
      const lines = spread.lines + late.lines;
      const bits = [];
      if (lines) bits.push(`✅ same fix applied to ${lines} other line${lines === 1 ? '' : 's'}`);
      if (learned.length) {
        /*
         * Say WHICH rule was kept, because for an everyday word it is not the
         * word — it is the phrase. "their" on its own depends on the sentence;
         * "and their book" does not, and the operator should be able to see the
         * difference in the sentence the app tells them.
         */
        bits.push(learned[0].widened
          ? `📕 remembered as “${learned[0].to}” — with the words around it, because that word on its own`
            + ` depends on the sentence it is in`
          : `📕 “${learned[0].to}” remembered — it will be right from now on`);
      }
      else if ((res && res.conflicts || []).length) {
        bits.push(`📕 not remembered — the book already turns that the other way round, so the two would `
          + `undo each other. Only this line was changed`);
      } else if (waiting.length) {
        bits.push(`📕 noted “${waiting[0].from}” → “${waiting[0].to}” — that is an everyday word, so it was changed on this line only.`
          + ' Correct it once more (or switch it on in 📕 Word Book) and it becomes automatic');
      }
      if (bits.length) setCapFixNote(bits.join('  ·  '), true);
      // A toast is for the thing that changed lines you cannot see. Everything
      // else stays in the quiet note above the list — this is a proof-reading
      // window, and a toast per corrected word would be its own kind of noise.
      if (lines && window.__toast) {
        window.__toast(`✅ Fixed “${(safe[0] || promoted[0] || cands[0]).to}” on ${lines} other line${lines === 1 ? '' : 's'} too`
          + (learned.length ? ' — and remembered it for next time.' : '.'), 'good', 5000);
      }
      loadWordBook(true).then(() => { if (wbPanelOpen()) renderWordBook(); });
    };
    if (api) api.learn({ edits: [{ before: b, after: a }] }).then(done).catch(() => done(null));
    else done(null);
    return { spread, cands };
  }

  /** Run the WHOLE book over the captions that are open — for lines that were
   *  generated before a word was taught, and for imported subtitles. */
  async function fixCaptionsFromBook() {
    if (!(ve.capEvents || []).length) {
      return window.__toast && window.__toast('There are no caption lines open to fix yet.', 'error');
    }
    await loadWordBook(true);
    const m = ve._wbM;
    if (!m || m.empty) {
      return window.__toast && window.__toast(
        '📕 The Word Book has nothing in it yet. Correct a word in the list — that is all it takes — or add one in 📕 Word Book.', 'error', 6000);
    }
    const r = applyMatcherToCaptions(m);
    const W = WB();
    if (!r.count) {
      setCapFixNote('📕 Nothing to change — these captions already match the Word Book.', false);
      return window.__toast && window.__toast('📕 Nothing to change — every word here already matches the Word Book.', 'good');
    }
    const what = wbSummarise(r.changes);
    setCapFixNote(`📕 Fixed ${r.count} word${r.count === 1 ? '' : 's'} on ${r.lines} line${r.lines === 1 ? '' : 's'}: ${what}`, true);
    window.__toast && window.__toast(`📕 Fixed ${r.count} word${r.count === 1 ? '' : 's'} on ${r.lines} line${r.lines === 1 ? '' : 's'} — ${what}. ↶ Undo puts them back.`, 'good', 6000);
  }

  /** "Ephesians ×3, Adeboye" — the words, not the numbers. */
  function wbSummarise(changes, limit) {
    const by = new Map();
    for (const c of (changes || [])) by.set(c.to, (by.get(c.to) || 0) + 1);
    const parts = [...by.entries()].sort((x, y) => y[1] - x[1]).slice(0, limit || 3)
      .map(([to, n]) => (n > 1 ? `${to} ×${n}` : to));
    const more = by.size - parts.length;
    return parts.join(', ') + (more > 0 ? ` and ${more} more` : '');
  }

  /** Say what the book already fixed on the way in, rather than handing back
   *  different words from the ones that were spoken and saying nothing. */
  function noteBookFixes(res) {
    const n = (res && res.fixed) || 0;
    if (!n) return;
    setCapFixNote(`📕 Word Book fixed ${n} word${n === 1 ? '' : 's'} while transcribing: ${res.fixedWords || ''}`, true);
  }

  /* ---- the panel ---- */
  const wbPanelOpen = () => {
    const p = document.getElementById('capWordBookPanel');
    return !!p && !p.classList.contains('hidden');
  };
  async function showWordBook(on) {
    const p = document.getElementById('capWordBookPanel');
    if (!p) return;
    p.classList.toggle('hidden', !on);
    if (!on) return;
    await loadWordBook(true);
    renderWordBook();
  }
  function renderWordBook() {
    const list = document.getElementById('capWbList');
    if (!list) return;
    const b = ve._wb || wbBlank();
    const on = document.getElementById('capWbOn'); if (on) on.checked = b.enabled !== false;
    const sd = document.getElementById('capWbSound'); if (sd) sd.checked = b.soundAlike !== false;
    const cnt = document.getElementById('capWbCount');
    if (cnt) {
      cnt.textContent = `${b.fixes.length} correction${b.fixes.length === 1 ? '' : 's'}`
        + `, ${b.terms.length} name${b.terms.length === 1 ? '' : 's'}`
        + (b.seedTerms ? ` · it already knows ${b.seedTerms} Bible and church words` : '')
        + (b.fixedTotal ? ` · ${b.fixedTotal} words fixed for you so far` : '');
    }
    const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    let html = '';
    if (!b.fixes.length && !b.terms.length) {
      html += `<div class="cap-wb-empty">
        <b>Nothing in the book yet — and you do not have to fill it in.</b><br />
        Just correct a word in the caption list the way you already do. The same fix is applied to every
        other line in this video straight away, written down here, and used on every video after this one.<br /><br />
        It already knows the books of the Bible and ${b.seedTerms || 'the'} common church words, so a name
        like EZEKIAL or HABAKUK is put right before you ever see it. What it cannot know is
        <b>your</b> people and places — add those above and they will be spelled right from the first time.
      </div>`;
    }
    if (b.fixes.length) {
      html += '<div class="cap-wb-sec">Corrections</div>';
      html += b.fixes.map((f) => `
        <div class="cap-wb-row ${f.on ? '' : 'off'}" data-id="${esc(f.id)}">
          <input type="checkbox" class="cap-wb-tog" data-id="${esc(f.id)}" ${f.on ? 'checked' : ''}
            title="${f.on ? 'This correction is being applied.' : 'Switched off — the captions are left as they come.'}" />
          <span class="cap-wb-from" title="${esc(f.from)}">${esc(f.from)}</span>
          <span class="cap-wb-arrow">→</span>
          <span class="cap-wb-to" title="${esc(f.to)}">${esc(f.to)}</span>
          <span class="cap-wb-tag">${f.on
            ? (f.hits ? `used ${f.hits}×` : (f.src === 'user' ? 'added by you' : 'learned'))
            : 'waiting for one more'}</span>
          <button type="button" class="icon-btn cap-wb-del" data-id="${esc(f.id)}" title="Forget this correction">🗑</button>
        </div>`).join('');
    }
    if (b.terms.length) {
      html += '<div class="cap-wb-sec">Names it should always spell this way</div>';
      html += b.terms.map((t) => `
        <div class="cap-wb-row" data-term="${esc(t.id)}">
          <span class="cap-wb-name">${esc(t.text)}</span>
          <span class="cap-wb-tag">${t.src === 'user' ? 'added by you' : 'from a correction'}</span>
          <button type="button" class="icon-btn cap-wb-delterm" data-id="${esc(t.id)}" title="Forget this name">🗑</button>
        </div>`).join('');
    }
    list.innerHTML = html;
    list.querySelectorAll('.cap-wb-tog').forEach((c) => c.addEventListener('change', async () => {
      const api = wbApi(); if (!api) return;
      await api.updateFix({ id: c.dataset.id, patch: { on: c.checked } }).catch(() => null);
      await loadWordBook(true); renderWordBook();
    }));
    list.querySelectorAll('.cap-wb-del').forEach((btn) => btn.addEventListener('click', async () => {
      const api = wbApi(); if (!api) return;
      await api.removeFix({ id: btn.dataset.id }).catch(() => null);
      await loadWordBook(true); renderWordBook();
    }));
    list.querySelectorAll('.cap-wb-delterm').forEach((btn) => btn.addEventListener('click', async () => {
      const api = wbApi(); if (!api) return;
      await api.removeTerm({ id: btn.dataset.id }).catch(() => null);
      await loadWordBook(true); renderWordBook();
    }));
    syncWordBookButton();
  }
  /** Add a correction by hand: the wrong words on the left, the right ones on
   *  the right. Typed by a person, so it is trusted at once. */
  async function wbAddFix() {
    const api = wbApi(); if (!api) return;
    const f = document.getElementById('capWbFrom'), t = document.getElementById('capWbTo');
    if (!f || !t) return;
    const r = await api.addFix({ from: f.value, to: t.value }).catch((e) => ({ ok: false, reason: e && e.message }));
    if (!r || !r.ok) return window.__toast && window.__toast('📕 ' + ((r && r.reason) || 'That could not be added.'), 'error', 6000);
    f.value = ''; t.value = ''; f.focus();
    await loadWordBook(true); renderWordBook();
    window.__toast && window.__toast(`📕 Added — “${r.fix.to}” from now on.`, 'good');
  }
  /** Add a name it should always spell one way. */
  async function wbAddTerm() {
    const api = wbApi(); if (!api) return;
    const el = document.getElementById('capWbTerm'); if (!el) return;
    const r = await api.addTerm({ text: el.value }).catch((e) => ({ ok: false, reason: e && e.message }));
    if (!r || !r.ok) return window.__toast && window.__toast('📕 ' + ((r && r.reason) || 'That could not be added.'), 'error', 8000);
    el.value = ''; el.focus();
    await loadWordBook(true); renderWordBook();
    window.__toast && window.__toast(`📕 “${r.term.text}” added — anything that sounds like it will be spelled this way.`, 'good', 5000);
  }
  /**
   * Throw out the rules that were never facts about words.
   *
   * One everyday word swapped for another depends on the sentence it was in, so
   * a book full of them fights itself — and hides the entries that matter. This
   * keeps names, phrases and anything typed in by hand, and says what went.
   */
  async function wbTidyUp() {
    const api = wbApi(); if (!api || !api.tidy) return;
    const r = await api.tidy().catch(() => null);
    await loadWordBook(true);
    renderWordBook();
    if (!r || !r.removed) {
      return window.__toast && window.__toast('🧹 Nothing to tidy — every correction in the book is a name or a phrase.', 'good');
    }
    window.__toast && window.__toast(
      `🧹 Removed ${r.removed} correction${r.removed === 1 ? '' : 's'} that depended on the sentence they were typed in`
      + (r.examples && r.examples.length ? ` (${r.examples.slice(0, 3).join(', ')})` : '')
      + `. ${r.after} kept — the names and phrases that are true every time.`, 'good', 12000);
  }

  async function wbSetOption(patch) {
    const api = wbApi(); if (!api) return;
    await api.options(patch).catch(() => null);
    await loadWordBook(true);
    renderWordBook();
  }

  /* ---------------- caption looks ----------------
   * A dropdown reading "White + outline" tells you nothing about what lands on
   * the video; CapCut shows the words themselves in each style and you pick with
   * your eyes. These presets are drawn TWICE from one definition — as HTML in the
   * picker and on the preview overlay — and translate into the same three ASS
   * primitives the burner already supports (drop shadow / outline / boxed band),
   * plus a colour. `color` is the fill; `outline` doubles as the band colour for
   * boxed looks. A style with `pickColor:true` uses the Colour swatch instead, so
   * the classic "any colour you like" behaviour survives.
   */
  const CAP_STYLES = [
    { id: 'clean', name: 'Clean', style: 'shadow', color: '#ffffff', pickColor: true },
    { id: 'outline', name: 'Outline', style: 'outline', color: '#ffffff', outline: '#000000', pickColor: true },
    { id: 'pop', name: 'Pop', style: 'outline', color: '#ffffff', outline: '#000000', outlineScale: 1.7 },
    { id: 'sunshine', name: 'Sunshine', style: 'outline', color: '#ffe14d', outline: '#000000', outlineScale: 1.4 },
    { id: 'neon', name: 'Neon', style: 'outline', color: '#2ff3ff', outline: '#062a33', outlineScale: 1.5 },
    { id: 'mint', name: 'Mint', style: 'outline', color: '#57ff9b', outline: '#04331b', outlineScale: 1.4 },
    { id: 'candy', name: 'Candy', style: 'outline', color: '#ff77d4', outline: '#2c0722', outlineScale: 1.4 },
    { id: 'fire', name: 'Fire', style: 'outline', color: '#ff8b34', outline: '#2b0e00', outlineScale: 1.4 },
    /* The short-form staple: a heavy white line with a black outline, one word
     * of it lit up as it is said. `wordGap` pads the spaces because the words
     * are read as separate blocks once one of them is a different colour, and
     * the default single space runs them together. */
    { id: 'spoken', name: 'Spoken', style: 'outline', color: '#ffffff', outline: '#000000',
      outlineScale: 1, wordHighlight: true, wordColor: '#ffff00', wordGap: 0.1 },
    /* CapCut's animated caption looks: the same whole line on screen, with the
     * word being spoken picked out a different way (see CapLayout's word modes).
     * `wordColor` is the colour that does the picking — the block behind the word
     * for Box word — and `wordInk` the letters on that block. */
    { id: 'boxword', name: 'Box word', style: 'outline', color: '#ffffff', outline: '#000000',
      wordHighlight: true, wordMode: 'box', wordColor: '#8b5cf6', wordInk: '#ffffff', wordGap: 0.12 },
    { id: 'limebox', name: 'Lime box', style: 'outline', color: '#ffffff', outline: '#000000',
      wordHighlight: true, wordMode: 'box', wordColor: '#3ddc84', wordInk: '#000000', wordGap: 0.12 },
    { id: 'karaoke', name: 'Karaoke', style: 'outline', color: '#ffffff', outline: '#000000',
      wordHighlight: true, wordMode: 'karaoke', wordColor: '#ffe14d', wordGap: 0.06 },
    { id: 'reveal', name: 'Word by word', style: 'outline', color: '#ffffff', outline: '#000000', outlineScale: 1.2,
      wordHighlight: true, wordMode: 'reveal', wordColor: '#ffffff', wordGap: 0.06 },
    { id: 'popword', name: 'Pop word', style: 'outline', color: '#ffffff', outline: '#000000', outlineScale: 1.2,
      wordHighlight: true, wordMode: 'pop', wordColor: '#57ff9b', wordGap: 0.14 },
    { id: 'goldband', name: 'Gold band', style: 'box', color: '#ffffff', outline: '#1d1238',
      wordHighlight: true, wordMode: 'karaoke', wordColor: '#ffd54a' },
    { id: 'band', name: 'Band', style: 'box', color: '#ffffff', outline: '#000000' },
    { id: 'highlight', name: 'Highlight', style: 'box', color: '#000000', outline: '#ffe14d' },
    { id: 'royal', name: 'Royal', style: 'box', color: '#ffffff', outline: '#7b3ff2' },
    { id: 'preach', name: 'Preach', style: 'box', color: '#ffffff', outline: '#c1121f' },
  ];
  /* What a caption looks like out of the box, before anyone touches a control:
   * Bebas Neue in ALL CAPS with a black outline — the shorts look, and the one
   * that survives being posted over any background. Case lives on #capCase and
   * the font on #capFont (both set in the markup / font list); this is the look. */
  const DEFAULT_CAP_STYLE = 'outline';
  const DEFAULT_CAP_FONT = 'Bebas Neue';
  const DEFAULT_CAP_TRANS = 'pop';
  /*
   * The fonts, as the main process knows them: display name, the family libass
   * matches on, and the file it lives in. The renderer needs the FILE so it can
   * @font-face each one and draw its name in its own typeface — a list of names
   * in the browser's UI font tells you nothing about what lands on the video.
   */
  let CAP_FONTS = [];
  /** Which transition is selected (a value the burner understands). */
  const capTransId = () => (document.getElementById('capTrans') || {}).value || DEFAULT_CAP_TRANS;
  /** The caption typeface, safe to drop straight into a CSS font-family. */
  /**
   * Make every bundled caption font usable BY THE PAGE, so the picker can show
   * each name in its own face and the live preview on the video matches what the
   * burner will draw. Without this the dropdown is 22 identical-looking rows.
   */
  async function loadCapFonts() {
    if (CAP_FONTS.length) return CAP_FONTS;
    let list = [];
    try { list = (await window.api.captions.fontList()) || []; } catch (e) { list = []; }
    if (!list.length) {
      // Older main process, or the call failed: fall back to plain names so the
      // picker still works — just without the previews.
      try { list = ((await window.api.captions.fonts()) || []).map((n) => ({ name: n, family: n, file: null })); }
      catch (e) { list = [{ name: 'Arial', family: 'Arial', file: null }]; }
    }
    CAP_FONTS = list;
    try {
      const p = await window.api.paths.get();
      const dir = (p.fontsDir || '').replace(/\\/g, '/');
      if (dir) {
        // Registered under BOTH names: the family recorded inside the file
        // ("Rubik ExtraBold") and the name the picker shows ("Rubik"). Text
        // overlays are stored by the name the operator chose, captions by the
        // family — and either way the page has to be able to draw it, or it
        // silently falls back to Arial and the export stops matching.
        const clean = (s) => String(s).replace(/['"\\;{}]/g, '');
        /*
         * `font-weight: 400 900` is not decoration — it is what stops Chromium
         * SYNTHESISING a bold. These faces ship in a single weight; ask for 800
         * from a face declared at 400 and the browser smears every glyph
         * sideways to fake one. The export rasteriser declares the same range,
         * so without this line the preview drew visibly fatter letters than the
         * file: the same look, quietly heavier — exactly the drift this whole
         * module exists to kill.
         */
        const css = list.filter((f) => f.file)
          .flatMap((f) => Array.from(new Set([f.family, f.name].filter(Boolean)))
            .map((n) => `@font-face{font-family:'${clean(n)}';src:url('${fileUrl(dir + '/' + f.file)}');`
              + `font-weight:400 900;font-style:normal;font-display:block;}`))
          .join('');
        let st = document.getElementById('capFontFaces');
        if (!st) { st = document.createElement('style'); st.id = 'capFontFaces'; document.head.appendChild(st); }
        st.textContent = css;
        await loadCapFontFaces();
      }
    } catch (e) { /* previews are a nicety; the names still work */ }
    return CAP_FONTS;
  }
  /**
   * Actually FETCH the faces, don't just declare them.
   *
   * A declared @font-face is lazy: nothing is downloaded until something on the
   * page asks to be drawn in it — and `canvas.measureText` is not that
   * something. It silently measures the fallback instead. That is not a cosmetic
   * bug here: line breaking is decided by measuring, so the preview wrapped
   * "IN NIGERIA WE ARE PRAYING" onto five Arial-width lines while the finished
   * picture drew two Bebas-width ones. Load them, then throw away every
   * measurement taken before they arrived.
   */
  async function loadCapFontFaces() {
    if (!document.fonts || !document.fonts.load) return;
    const names = new Set();
    CAP_FONTS.forEach((f) => { if (f.file) { if (f.family) names.add(f.family); if (f.name) names.add(f.name); } });
    await Promise.all([...names].map((n) => document.fonts.load(`800 100px '${n}'`).catch(() => null)));
    try { await document.fonts.ready; } catch (e) {}
    window.CapLayout.forgetMeasurements();
  }

  /**
   * 🔤 Add text used to offer five typefaces out of the twenty-two that ship
   * with the app — the captions had the whole list, the text tool had a
   * hard-coded handful, and there was no reason for the difference. Same list,
   * same order, each option wearing its own face.
   */
  function renderTextFontPicker() {
    const sel = document.getElementById('vtFont'); if (!sel) return;
    const cur = sel.value || 'Arial';
    if (!CAP_FONTS.length) return;
    sel.innerHTML = CAP_FONTS.map((f) =>
      `<option value="${attr2(f.name)}" style="font-family:'${attr2(f.name)}','${attr2(f.family)}',system-ui,sans-serif">${escape2(f.name)}</option>`).join('');
    sel.value = CAP_FONTS.some((f) => f.name === cur) ? cur : 'Arial';
    sel.style.fontFamily = `'${String(sel.value).replace(/['"\\;{}]/g, '')}', system-ui, sans-serif`;
  }

  /** The font dropdown, every option wearing its own typeface. */
  function renderCapFontPicker() {
    const sel = document.getElementById('capFont'); if (!sel) return;
    const cur = sel.value || DEFAULT_CAP_FONT;
    sel.innerHTML = CAP_FONTS.map((f) =>
      `<option value="${attr2(f.name)}" style="font-family:'${attr2(f.family)}',system-ui,sans-serif">${escape2(f.name)}</option>`).join('');
    sel.value = CAP_FONTS.some((f) => f.name === cur) ? cur : DEFAULT_CAP_FONT;
    // …and the closed dropdown shows the chosen face too, not just the open list.
    const fam = (CAP_FONTS.find((f) => f.name === sel.value) || {}).family || sel.value;
    sel.style.fontFamily = `'${String(fam).replace(/['"\\;{}]/g, '')}', system-ui, sans-serif`;
    sel.style.fontSize = '15px';
  }

  /** The transitions dropdown. */
  function renderCapTransPicker() {
    const sel = document.getElementById('capTrans'); if (!sel) return;
    if (sel.options.length) return;
    const list = [
      ['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['bounce', 'Bounce'],
      ['slideup', 'Slide up'], ['zoom', 'Zoom out'], ['typewriter', 'Typewriter'],
    ];
    sel.innerHTML = list.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    sel.value = DEFAULT_CAP_TRANS;
  }

  /**
   * The row of looks inside the captions window. Same definitions as the big
   * gallery, drawn small — so the choice is visible without opening anything.
   */
  function renderCapStyleStrip() {
    const strip = document.getElementById('capStyleStrip'); if (!strip) return;
    strip.innerHTML = CAP_STYLES.map((def) => {
      const cfg = Object.assign({}, capStyleCfg(), {
        color: def.pickColor ? (document.getElementById('capColor') || {}).value || '#ffffff' : def.color,
        outline: def.outline || '#000000', style: def.style, outlineScale: def.outlineScale || 1,
      });
      const inline = capSpanCss(cfg, 15) + `font-family:'${attr2(capFontFamily())}',system-ui,sans-serif;`;
      return `<button type="button" class="cap-style-chip${ve.capStyleId === def.id ? ' sel' : ''}" data-capstyle="${def.id}" title="${attr2(def.name)}">
        <span class="cs-sample" style="${inline}">Aa</span><span class="cs-name">${escape2(def.name)}</span>
      </button>`;
    }).join('');
    strip.querySelectorAll('[data-capstyle]').forEach((b) => {
      b.addEventListener('click', () => setCapStyle(b.dataset.capstyle));
    });
  }

  function capFontFamily() {
    const f = (document.getElementById('capFont') || {}).value || DEFAULT_CAP_FONT;
    // The picker shows "Rubik"; the font file calls itself "Rubik ExtraBold", and
    // CSS will only match the latter. Same lookup libass does on the other side.
    const fam = (CAP_FONTS.find((x) => x.name === f) || {}).family || f;
    return String(fam).replace(/['"\\;{}]/g, '');
  }
  /** Read back the look the user last picked, or fall back to the default. */
  function applySavedCapStyle() {
    let saved = null;
    try { saved = localStorage.getItem(LIB_KEYS.capStyle); } catch (e) {}
    ve.capStyleId = capStyleDef(saved).id;
    const sel = $('#capStyleSel'); if (sel) sel.value = ve.capStyleId;
    syncCapWordColor();
    restoreCapLook();
    renderCapStyleGrid();
  }
  /* Where the words sit and how wide they wrap are DRAGGED, not typed, so they
   * have nowhere else to live — remember them between sessions, the same way the
   * chosen look is remembered. (Both are frame fractions, so they survive a
   * different screen, a different preview size and a different export preset.) */
  function saveCapLook() {
    try {
      localStorage.setItem(LIB_KEYS.capLook, JSON.stringify({
        pos: ve.capPos ? { x: ve.capPos.x, y: ve.capPos.y } : null,
        width: ve.capWidth,
      }));
    } catch (e) {}
  }
  function restoreCapLook() {
    let raw = null;
    try { raw = localStorage.getItem(LIB_KEYS.capLook); } catch (e) {}
    if (!raw) return;
    try {
      const v = JSON.parse(raw) || {};
      if (v.pos && Number.isFinite(v.pos.x) && Number.isFinite(v.pos.y)) ve.capPos = { x: v.pos.x, y: v.pos.y };
      if (Number.isFinite(v.width)) ve.capWidth = clamp(v.width, window.CapLayout.MIN_WIDTH, window.CapLayout.MAX_WIDTH);
    } catch (e) {}
  }
  const capStyleDef = (id) => CAP_STYLES.find((s) => s.id === (id || ve.capStyleId))
    || CAP_STYLES.find((s) => s.id === DEFAULT_CAP_STYLE) || CAP_STYLES[0];

  /** Everything the burner AND the live overlay need to draw the chosen look. */
  const capStyleCfg = () => {
    const def = capStyleDef();
    const picked = document.getElementById('capColor');
    return {
      // the font list loads async — fall back to the default rather than to ''
      font: document.getElementById('capFont').value || DEFAULT_CAP_FONT,
      // …and the family the FILE calls itself, which is the only string CSS (and
      // libass) will match on. Without it "Rubik" silently draws as Arial.
      family: capFontFamily(),
      transition: capTransId(),
      // Only sent once the operator has actually dragged the words — otherwise
      // the burner keeps using the named preset.
      posX: ve.capPos ? ve.capPos.x : undefined,
      posY: ve.capPos ? ve.capPos.y : undefined,
      // How wide the words may run before they wrap (the edge handles).
      width: window.CapLayout.widthFrac({ width: ve.capWidth }),
      sizeKey: document.getElementById('capSize').value,
      // …and the typed-in exact height, when there is one. Blank means "use
      // the step above", which is what an empty number input has to mean —
      // Number('') is 0, and a 0 here would draw invisible captions.
      sizePct: capExactSize(),
      // Letter spacing, typed as a percentage of the caption's height and
      // carried as the fraction both engines work in.
      tracking: capTracking(),
      position: document.getElementById('capPos').value,
      // Only the "any colour" looks follow the swatch; a named look owns its palette.
      color: def.pickColor && picked ? picked.value : def.color,
      outline: def.outline || '#000000',
      style: def.style,
      outlineScale: def.outlineScale || 1,
      styleId: def.id,
      /*
       * FOLLOWING THE VOICE. The look proposes it (only "Spoken" does), and the
       * tick box disposes — an operator who wants the word lit up on any other
       * look can have it, and one who picked Spoken for its weight but not its
       * colour can turn it off. Both are one boolean, read here so the preview,
       * the frame rasteriser and the subtitle burner cannot disagree about it.
       */
      wordHighlight: capWordHlOn(def),
      wordColor: (document.getElementById('capWordColor') || {}).value || def.wordColor || '#ffff00',
      wordGap: def.wordGap || 0,
      // how the spoken word is picked out, and the letters on a Box word's block
      wordMode: def.wordMode || 'color',
      wordInk: def.wordInk || '#ffffff',
    };
  };
  /** Letter spacing as a fraction of the font size (0 when not set). */
  function capTracking() {
    const el = document.getElementById('capTracking');
    const v = el ? parseFloat(el.value) : NaN;
    return Number.isFinite(v) ? clamp(v / 100, -0.2, 0.5) : 0;
  }

  /** The typed exact caption height as a frame fraction, or undefined. */
  function capExactSize() {
    const el = document.getElementById('capSizePct');
    const v = el ? parseFloat(el.value) : NaN;
    return Number.isFinite(v) && v > 0 ? clamp(v / 100, 0.01, 0.30) : undefined;
  }

  /** Whether the spoken word is coloured: the look's own answer until the
   *  operator touches the box, and their answer from then on. */
  function capWordHlOn(def) {
    const box = document.getElementById('capWordHl');
    if (!box) return !!def.wordHighlight;
    const on = box.dataset.touched === '1' ? box.checked : !!def.wordHighlight;
    box.checked = on;
    // A colour picker for a colour nothing is using is a control that lies about
    // what it does; grey it out until the words are actually being lit.
    // …and the swatch is HIDDEN, not merely greyed: a dead control still costs a
    // slot in a row that has to fit on a 1280x720 laptop.
    const row = document.getElementById('capWordColorRow');
    if (row) row.classList.toggle('hidden', !on);
    return on;
  }

  /**
   * Inline CSS that makes a sample look like `cfg` at `px` font size.
   *
   * Straight out of CapLayout, so a chip in the picker advertises the outline,
   * the band and the glow the burn actually draws — the card and the file wear
   * the same look because there is only one definition of it.
   */
  function capSpanCss(cfg, px) {
    return window.CapLayout.lineCss({ m: window.CapLayout.metricsAt(cfg, px, px * 10), cfg })
      + 'font-weight:800;';
  }

  /** The picker: each card shows real words wearing that style. */
  /**
   * The Style picker: a dropdown, plus a sample of the chosen look.
   *
   * It used to be a grid of eighteen cards, each wearing the look it sold —
   * which was lovely and unreachable. In a window of ordinary height the grid
   * and the accuracy list below it had nowhere to go, and the layout squeezed
   * them until their own headings overlapped the buttons. A picker you cannot
   * see is worse than a plain one you can, so the cards became a list and the
   * one card that matters — the look you have actually chosen — is still drawn,
   * right beside it, in the style it names.
   */
  function renderCapStyleGrid() {
    const sel = document.getElementById('capStyleSel');
    if (sel) {
      if (sel.options.length !== CAP_STYLES.length) {
        sel.innerHTML = CAP_STYLES.map((s) => `<option value="${s.id}">${escape2(s.name)}</option>`).join('');
      }
      sel.value = capStyleDef().id;
    }
    const chip = document.getElementById('capStyleSample');
    if (!chip) return;
    const def = capStyleDef();
    const cfg = Object.assign({}, capStyleCfg(), {
      color: def.pickColor ? (document.getElementById('capColor') || {}).value || '#ffffff' : def.color,
      outline: def.outline || '#000000', style: def.style, outlineScale: def.outlineScale || 1,
    });
    chip.style.cssText = capSpanCss(cfg, 15);
    chip.textContent = 'Aa';
    chip.title = `“${def.name}” — this is how your captions will look. Click to see all the looks.`;
    renderCapStyleCards();
    renderCapStyleStrip();
  }

  /**
   * The gallery of looks, each card wearing the one it sells.
   *
   * Picking a caption style by reading names is guesswork, so this stays — but
   * it lives in an overlay that floats over the whole window rather than as a
   * section competing for height with the caption text. That is the difference
   * between a gallery you can open and one that quietly eats the layout.
   */
  function renderCapStyleCards() {
    const grid = document.getElementById('capStyleGrid'); if (!grid) return;
    const sample = 'THE QUICK BROWN FOX'.split(' ').slice(0, 3).join(' ');
    grid.innerHTML = CAP_STYLES.map((def) => {
      const cfg = Object.assign({}, capStyleCfg(), {
        color: def.pickColor ? (document.getElementById('capColor') || {}).value || '#ffffff' : def.color,
        outline: def.outline || '#000000', style: def.style, outlineScale: def.outlineScale || 1,
      });
      const inline = capSpanCss(cfg, 19);
      if (def.wordHighlight && def.wordMode) {
        // An animated look is shown DOING it: the spoken word travels along the
        // sample (see capSampleTick), drawn by the same code as the captions.
        const wcfg = capSampleCfg(def, cfg);
        return `<button type="button" class="cap-style-card${ve.capStyleId === def.id ? ' sel' : ''}" data-capstyle="${def.id}" title="${escape2(def.name)}">
        <span class="cap-style-sample cap-style-live" data-wm="${def.id}" style="font-size:19px;font-weight:800;font-family:'${attr2(capFontFamily())}',system-ui,sans-serif;line-height:1.25;">${capSampleHtml(wcfg, 19, sample, 1)}</span>
        <span class="cap-style-name">${escape2(def.name)}</span>
      </button>`;
      }
      return `<button type="button" class="cap-style-card${ve.capStyleId === def.id ? ' sel' : ''}" data-capstyle="${def.id}" title="${escape2(def.name)}">
        <span class="cap-style-sample" style="${inline}">${escape2(sample)}</span>
        <span class="cap-style-name">${escape2(def.name)}</span>
      </button>`;
    }).join('');
    $$('.cap-style-card', grid).forEach((b) => b.addEventListener('click', () => {
      setCapStyle(b.dataset.capstyle);
      showCapStylePicker(false);   // you picked one; get out of the way
    }));
  }

  /** A look's full settings for a sample, with its own word colours. */
  function capSampleCfg(def, base) {
    return Object.assign({}, base, {
      wordHighlight: true, wordMode: def.wordMode, wordColor: def.wordColor || '#ffff00',
      wordInk: def.wordInk || '#ffffff', wordGap: def.wordGap || 0,
    });
  }
  /** One sample line drawn by CapLayout itself, with word `hl` being spoken. */
  function capSampleHtml(cfg, px, text, hl) {
    const L = { m: window.CapLayout.metricsAt(cfg, px, px * 40), cfg };
    return window.CapLayout.lineHtml(L, text, 0, hl);
  }
  let _capSampleTimer = null, _capSampleStep = 0;
  /** Walks the spoken word along every animated sample that is on screen, and
   *  stops itself as soon as none is. */
  function capSampleTick() {
    if (_capSampleTimer) return;
    _capSampleTimer = setInterval(() => {
      const live = $$('[data-wm]').filter((el) => el.offsetParent !== null);
      if (!live.length) { clearInterval(_capSampleTimer); _capSampleTimer = null; return; }
      _capSampleStep = (_capSampleStep + 1) % 4;
      const hl = _capSampleStep - 1;        // -1 (nothing said yet), 0, 1, 2
      const base = capStyleCfg();
      for (const el of live) {
        const def = CAP_STYLES.find((d) => d.id === el.dataset.wm); if (!def) continue;
        const cfg = Object.assign({}, base, {
          color: def.color, outline: def.outline || '#000000', style: def.style, outlineScale: def.outlineScale || 1,
        });
        el.innerHTML = capSampleHtml(capSampleCfg(def, cfg), 19, 'THE QUICK BROWN', hl);
      }
    }, 520);
  }
  function showCapStylePicker(on) {
    const p = document.getElementById('capStylePicker'); if (!p) return false;
    p.classList.toggle('hidden', !on);
    if (on) capSampleTick();
    return on;
  }
  /** A look that brings its own word colour puts it on the swatch, so Box word
   *  arrives purple rather than wearing whatever the last look left there. */
  function syncCapWordColor() {
    const def = capStyleDef();
    const wc = document.getElementById('capWordColor');
    if (wc && def.wordColor) wc.value = def.wordColor;
  }
  function setCapStyle(id) {
    ve.capStyleId = capStyleDef(id).id;
    syncCapWordColor();
    const sel = document.getElementById('capStyleSel'); if (sel) sel.value = ve.capStyleId;
    try { localStorage.setItem(LIB_KEYS.capStyle, ve.capStyleId); } catch (e) {}
    renderCapStyleGrid();
    renderCapSummary();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }

  /**
   * Per-word timings ESTIMATED from finished caption lines.
   *
   * Captions that came from a subtitle file, or that were typed in by hand, know
   * when each LINE starts and stops but not when each word does — so Words/line
   * had nothing to regroup and used to refuse outright. It doesn't have to:
   * inside one line, sharing its time out between the words in proportion to how
   * long they are puts every word within a few tens of milliseconds of where it
   * really falls, which is far finer than the thing being rebuilt (a line that
   * holds for a second and a half). The estimate is only ever used to decide
   * where to BREAK; the words themselves are the user's own.
   */
  function wordsFromEvents(events) {
    const out = [];
    for (const e of (events || [])) {
      const parts = String(e.text || '').split(/\s+/).filter(Boolean);
      if (!parts.length) continue;
      const start = e.start || 0;
      const dur = Math.max(0.08, (e.end || 0) - start);
      const total = parts.reduce((n, w) => n + w.length + 1, 0);
      let t = start;
      for (const w of parts) {
        const d = (dur * (w.length + 1)) / total;
        out.push({ start: t, end: t + d, text: w });
        t += d;
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  /** Re-case the lines exactly as they are. Changing CASE is not a reason to
   *  re-break anybody's lines, and on imported captions it must not quietly
   *  strip their punctuation either — so this touches nothing but the letters. */
  function recaseCapEvents(tc) {
    ve.capEvents = (ve.capEvents || []).map((e) => Object.assign({}, e, {
      text: transformCase(e.origText != null ? e.origText : e.text, tc),
      origText: e.origText != null ? e.origText : e.text,
    }));
    renderCapList();
    renderCapTrack();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }

  /**
   * Rebuild the caption lines from the words.
   *
   * `caseOnly` is the difference between the two dropdowns: picking ALL CAPS
   * should change the letters and nothing else, while picking a different
   * Words/line genuinely has to re-break the lines.
   */
  function rebuildCapEvents(opts) {
    const g = capGroupCfg();
    const caseOnly = !!(opts && opts.caseOnly);
    let words = ve.capWords || [];
    if (!words.length) {
      if (!(ve.capEvents || []).length) return;
      if (caseOnly) { pushHistory({ captions: true }); recaseCapEvents(g.tc); return; }
      words = wordsFromEvents(ve.capEvents);
      if (!words.length) return;
      // The lines are about to be re-broken from an estimate, so say so once —
      // and undo puts the originals straight back.
      window.__toast && window.__toast(
        '💬 Re-broke your caption lines at ' + (g.wpl === 'auto' ? 'automatic' : g.wpl + ' words')
        + ' a line. These captions came without word timings, so the timing inside each line is estimated — Ctrl+Z puts your lines back.', 'good', 7000);
    }
    pushHistory({ captions: true });
    ve.capEvents = groupWords(words, g.wpl, g.tc);
    ve.capSel = null; ve.capEditing = null;
    renderCapList();
    renderCapTrack(); // show the caption blocks on the timeline
    updateCapOverlay(ve.refs.player.currentTime || 0);
  }
  /**
   * Make the freshly-generated captions actually VISIBLE on the timeline: zoom in
   * far enough that each block reads as words (at "Fit" on an hour-long sermon a
   * caption is a sliver), park the view on the first line, and say so.
   */
  /** Bring the caption lane into view (zoom in far enough to READ the blocks) and
   *  turn the preview overlay on. `quiet` suppresses the toast for callers that
   *  say their own thing — two toasts about the same action just fight. */
  function revealCaptions(quiet) {
    if (!capBlocksVisible()) return false;
    const evs = ve.capEvents;
    const zoomed = zoomForCaptions(0);
    renderCapTrack();
    const cc = $('#veCapShow'); if (cc && !cc.checked) cc.checked = true; // captions live on the preview too
    updateCapOverlay(ve.refs.player.currentTime || 0);
    if (!quiet) {
      window.__toast && window.__toast(
        `💬 ${evs.length} caption line${evs.length === 1 ? '' : 's'} added to the timeline — click any one to edit its words.`
        + (zoomed ? ' (Zoomed in so you can read them — press “Fit” for the whole video.)' : ''), 'good');
    }
    return zoomed;
  }
  /**
   * The editable transcript inside the captions window.
   *
   * When the window was opened from ONE short's 💬 button (`ve.capScope`), only
   * that short's lines are listed. Handing someone the whole sermon's transcript
   * when they asked to fix one word in a 40-second clip is how a wrong word ends
   * up going out: the line they want is somewhere in six hundred rows. The rows
   * still carry their real index into `ve.capEvents`, so an edit here is an edit
   * to the one shared caption store — the timeline blocks, the preview overlay
   * and the burned-in export all change with it, because there is only one copy.
   */
  function renderCapList() {
    const all = ve.capEvents || [];
    const scope = ve.capScope;
    const rows = all
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !scope || (c.end > scope.start + 0.02 && c.start < scope.end - 0.02));
    document.getElementById('capCount').textContent = scope
      ? `${rows.length} caption line${rows.length === 1 ? '' : 's'} in this short`
      : all.length + ' caption lines';
    const list = document.getElementById('capList');
    if (!rows.length) {
      /*
       * THE WINDOW OPENS BEFORE THERE ARE ANY WORDS, and that is the point.
       *
       * Pressing 💬 used to start a transcription immediately, so the only way
       * to see the look and the listening model was to wait out the transcribe
       * you had not chosen the settings for yet. Now the window opens straight
       * away on an empty list: every setting along the top is live, the sample
       * chip shows the look, the Hearing picker chooses the model — and this is
       * the button that actually goes and listens.
       */
      list.innerHTML =
        `<div class="cap-empty-state">
           <div class="cap-empty-ic">💬</div>
           <p class="cap-empty-title">${scope ? 'No captions for this short yet' : 'No captions yet'}</p>
           <p class="cap-empty-sub muted small">Choose the <b>look</b> and the <b>Hearing</b> model above first — they are what the
             words will be written and listened with. Then press the button and the app transcribes the speech on this PC.</p>
           <button type="button" id="capGenerate" class="cap-generate">🎧 Generate captions</button>
           <p class="cap-empty-note muted small" id="capGenNote"></p>
         </div>`;
      const gen = document.getElementById('capGenerate');
      if (gen) gen.addEventListener('click', () => generateCaptions(scope));
      const note = document.getElementById('capGenNote');
      if (note && ve.video && ve.video.info) {
        const mins = ve.video.info.durationSec / 60;
        const span = scope ? (scope.end - scope.start) / 60 : mins;
        const est = Math.max(1, Math.round(span * 2.5));
        note.textContent = `Listening to ${span < 1 ? Math.round(span * 60) + ' seconds' : Math.round(span) + ' minutes'} of speech`
          + (capHearsInCloud()
            ? ` — Groq's free cloud Whisper hears it in seconds.`
            : ` — about ${est >= 60 ? (est / 60).toFixed(1) + ' hours' : est + ' min'} on this PC.`);
      }
      updateGrammarSummary();
      capPlayerPaint(true);
      return;
    }
    // Times are shown from the START OF THE SHORT, because that is where the
    // person editing will hear them — a source-absolute 41:07 means nothing
    // when the clip they are posting is 45 seconds long.
    const base = scope ? scope.start : 0;
    const keepScroll = list.scrollTop;
    // Each line: its own ▶, the time, the words with the proof-reader's
    // underlines laid over them, the badge that opens its suggestions, and ✨
    // to have the AI read just this line.
    list.innerHTML = rows.map(({ c, i }) =>
      `<div class="cap-row" data-row="${i}">`
      + `<button type="button" class="cap-row-play" data-play-i="${i}" title="Play this line">▶</button>`
      + `<span class="cap-time">${fmt(Math.max(0, c.start - base))}</span>`
      + `<div class="cap-field"><input class="cap-text" data-i="${i}" value="${String(c.text).replace(/"/g, '&quot;')}" spellcheck="false" />`
      + `<div class="cap-hl" aria-hidden="true"></div></div>`
      + `<button type="button" class="cap-g-badge hidden" data-g-i="${i}"></button>`
      + `<button type="button" class="cap-ai-line" data-ai-i="${i}" title="✨ Ask the AI to proof-read just this line">✨</button>`
      // A line a fix changed says so, and what it said before, with its own way back.
      + (c._was != null && c._was !== c.text
        ? `<div class="cap-was"><span class="cap-was-tx">✍ Fixed — was “${escape2(c._was)}”</span>`
          + `<button type="button" class="cap-was-back" data-was-i="${i}" title="Put this line back to what it said before">↶ Put back</button></div>`
        : '')
      + `</div>`).join('');
    list.querySelectorAll('.cap-was-back').forEach((b) => b.addEventListener('click', () => putLineBack(+b.dataset.wasI)));
    list.querySelectorAll('.cap-was').forEach((w) => w.closest('.cap-row').classList.add('fixed'));
    list.scrollTop = keepScroll;
    list.querySelectorAll('.cap-text').forEach((inp) => {
      const commit = () => {
        ve._capLive = null;
        const e = ve.capEvents[+inp.dataset.i];
        if (!e || e.text === inp.value) return;
        const before = e.text;
        e.text = inp.value;
        if (e._was != null && e._was === e.text) { delete e._was; renderCapList(); }
        renderCapTrack(); renderClipList();
        updateCapOverlay(ve.refs.player.currentTime || 0);
        // The whole point: this correction is now also made everywhere else in
        // the video, and remembered for every video after it. See the Word Book.
        learnCaptionEdit(before, inp.value, +inp.dataset.i);
        updateGrammarSummary();
      };
      // The proof-reader's buttons commit a half-typed line before acting on it.
      inp._commit = commit;
      inp.addEventListener('change', commit);
      // As you type: the underlines follow the words, the caption on the
      // picture shows what you are typing, and (if asked) the sound stops so
      // you do not miss what comes next while your hands are busy.
      inp.addEventListener('input', () => {
        ve._capLive = { i: +inp.dataset.i, text: inp.value };
        updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
        capPauseForTyping();
        clearTimeout(inp._gT);
        inp._gT = setTimeout(() => { const row = inp.closest('.cap-row'); if (row) paintGrammarRow(row, inp.value); }, 120);
      });
      inp.addEventListener('scroll', () => { const hl = inp.parentNode.querySelector('.cap-hl'); if (hl) hl.scrollLeft = inp.scrollLeft; });
      inp.addEventListener('blur', () => { if (ve._capLive && ve._capLive.i === +inp.dataset.i) { ve._capLive = null; } });
      // Enter commits and moves on — this is a list of lines being proof-read,
      // not a form.
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        const at = +inp.dataset.i;
        commit();
        // The list may have just been REDRAWN underneath us — a correction that
        // also fixed other lines rebuilds them — so the next row is found by its
        // index in the fresh DOM rather than by walking away from a dead node.
        const here = document.querySelector(`#capList .cap-text[data-i="${at}"]`) || inp;
        const row = here.closest('.cap-row');
        const nx = row && row.nextElementSibling && row.nextElementSibling.querySelector('.cap-text');
        if (nx) { nx.focus(); nx.select(); } else here.blur();
      });
      // Clicking a line takes the playhead to it, so you can hear what you are
      // correcting without leaving the window. While a single line is being
      // played (or looped), clicking another line moves the loop with you.
      inp.addEventListener('focus', () => {
        const i = +inp.dataset.i;
        const e = ve.capEvents[i];
        ve._capFocusI = i;
        if (!e) return;
        const p = ve.refs.player;
        if (ve._capLine && p && !p.paused) { capPlayLine(i); return; }
        ve._capLine = null;
        seekTo(Math.max(0, capOff() + e.start));
        capPlayerPaint(true);
      });
    });
    paintAllGrammar();
    capPlayerPaint(true);
  }

  /**
   * Open the captions window on ONE short — the 💬 button on a clip card.
   *
   * Everything here already existed except the way in: the lines were on the
   * timeline lane, editable by clicking a block, and people did not find them.
   * A window with the words in it, opened by the button that made them, is what
   * "let me read and fix the captions" actually means.
   */
  function openCaptionsForShort(s) {
    commitCapEdit();
    ve.capScope = s || null;
    ve.capTarget = null;                 // lane times stay source-absolute
    const t = document.getElementById('capTitle');
    if (t) t.textContent = s ? `💬 Captions — “${s.label}”` : '💬 Auto-captions — whole video';
    const burn = document.getElementById('capBurn');
    if (burn) {
      burn.textContent = s ? '💾 Save this short with captions' : '💾 Save video with captions';
      burn.title = s
        ? `Export “${s.label}” with these captions burned into the picture`
        : 'Saves a new video file with these captions permanently included in the picture, like subtitles baked in.';
    }
    renderCapList();
    renderCapTrack();
    // The Word Book is read once, in the background: correcting a line must not
    // wait on a round trip, so the matcher is here before the first keystroke.
    loadWordBook(!ve._wb).catch(() => {});
    showWordBook(false);
    setCapFixNote('');
    renderCapModels();      // the Accuracy header must say what it will listen with
    // Both panels start folded: the window opens on the WORDS.
    renderCapStyleGrid();   // the sample chip wears whatever look is chosen
    const modal = document.getElementById('capModal');
    modal.classList.remove('hidden');
    enterCapMode();
    renderCapSummary();
    applyCapFold();
    capPlayerOpen();
    loadAiAuto();
    if (ve._cloudAdoptNote) {
      window.__toast && window.__toast(ve._cloudAdoptNote, 'good', 12000);
      ve._cloudAdoptNote = null;
    }
    const list = document.getElementById('capList');
    if (list) list.scrollTop = 0;
    const first = document.querySelector('#capList .cap-text');
    if (first) setTimeout(() => { first.focus(); first.select(); }, 30);
  }

  /** Leaving the window always drops the scope, or the next opener inherits it. */
  /** One line back to what it said before its fixes — one undo step of its own. */
  function putLineBack(i) {
    const e = (ve.capEvents || [])[i];
    if (!e || e._was == null) return;
    pushHistory({ captions: true });
    const was = e._was;
    ve.capEvents[i] = Object.assign({}, e, { text: was });
    delete ve.capEvents[i]._was;
    syncCapWordsFor(e, e.text, was);
    afterGrammarChange();
    window.__toast && window.__toast(`↶ Put back: “${was}”`, 'good', 3500);
  }
  function closeCapModal() {
    commitCapEdit();
    // The "fixed — was …" marks are for this sitting; the next one starts clean.
    (ve.capEvents || []).forEach((e) => { if (e && e._was != null) delete e._was; });
    ve.capScope = null;
    capPlayerClose();
    document.getElementById('capModal').classList.add('hidden');
    exitCapMode();
  }

  /* ======================= ▶ LISTEN WHILE YOU FIX =======================
   *
   * "There should be a play button in the captions window so it is easy for me
   *  to listen and edit the captions."
   *
   * Proof-reading captions is half reading and half HEARING, and the window had
   * only the reading half: clicking a line moved the playhead, but the only
   * play button was the studio's own, underneath the window. Now:
   *
   *   • ▶ / ⏸ plays the short (or the video) from where you are, and stops at
   *     the end of the short rather than running on into the next one;
   *   • every line has its own ▶, which plays exactly that line — and with
   *     🔁 Loop line, keeps playing it until you have it right;
   *   • the line being spoken lights up and the list follows it;
   *   • ⌨ Pause while typing stops the sound the moment you start correcting,
   *     and Ctrl+Space carries on from a second before — the way transcription
   *     software works, because typing while it keeps talking means missing
   *     the next line;
   *   • 0.5× – 1.5×: a fast preacher is far easier to check at three-quarters.
   *
   * It drives the studio's own player, so what you hear is exactly what the
   * timeline plays — removed pauses are skipped here too.
   */
  let capPlRaf = null;
  const capModalOpen = () => { const m = document.getElementById('capModal'); return !!m && !m.classList.contains('hidden'); };

  /** The stretch the window is about: the short, or the whole video. */
  function capPlayRange() {
    const s = ve.capScope;
    if (s) return { a: s.start, b: s.end };
    return { a: 0, b: dur() };
  }
  function capPlayerOpen() {
    ve._capLine = null; ve._capTypePausedAt = null;
    const rate = parseFloat(($('#capPlayRate') || {}).value) || 1;
    capSetRate(rate);
    capPlayerPaint(true);
    const p = ve.refs.player;
    if (p && !p.paused) capPlayerLoop();
  }
  function capPlayerClose() {
    if (capPlRaf != null) { cancelAnimationFrame(capPlRaf); capPlRaf = null; }
    ve._capLine = null; ve._capTypePausedAt = null; ve._capLive = null;
    // The speed is for checking captions. Leaving it at 0.75× would make the
    // studio's own preview quietly play slow.
    capSetRate(1, true);
  }
  function capSetRate(rate, quiet) {
    const p = ve.refs.player;
    const r = clamp(rate || 1, 0.25, 2);
    if (p) { try { p.playbackRate = r; } catch (e) {} }
    // The music bed has to keep pace, or it drifts and re-seeks every frame.
    const m = ve.refs.musicAudio;
    if (m) { try { m.playbackRate = r; } catch (e) {} }
    if (!quiet) { const sel = $('#capPlayRate'); if (sel && parseFloat(sel.value) !== r) sel.value = String(r); }
  }
  function capPlayerPlay() {
    const p = ve.refs.player;
    if (!p || !p.src || (ve.video && ve.video.proxying)) {
      window.__toast && window.__toast('The preview is still getting ready — try again in a moment.', 'error');
      return false;
    }
    const pr = p.play(); if (pr && pr.catch) pr.catch(() => {});
    if (ve.refs.play) ve.refs.play.textContent = '⏸';
    capPlayerLoop();
    return true;
  }
  /** ▶ / ⏸ — the short from where you are, stopping at its end. */
  function capTogglePlay() {
    const p = ve.refs.player;
    if (!p) return;
    if (!p.paused) { p.pause(); capPlayerPaint(true); return; }
    const R = capPlayRange();
    let t = p.currentTime || 0;
    // Carrying on after a pause-for-typing starts a second early, so the line
    // that was cut off is heard whole.
    if (ve._capTypePausedAt != null) { t = Math.max(R.a, ve._capTypePausedAt - 1.0); ve._capTypePausedAt = null; seekTo(t); }
    if (t < R.a - 0.05 || t >= R.b - 0.1) { seekTo(R.a); }
    ve._capLine = null;
    ve._previewEnd = ve.capScope ? R.b : null;
    ve._loopSeg = null;
    capPlayerPlay();
  }
  /** One line's ▶: exactly that line, a breath either side. */
  function capPlayLine(i) {
    const e = (ve.capEvents || [])[i]; if (!e) return;
    const a = Math.max(0, capOff() + e.start - 0.12), b = capOff() + e.end + 0.1;
    ve._capLine = { i, a, b };
    ve._capTypePausedAt = null;
    ve._previewEnd = null; ve._loopSeg = null;
    seekTo(a);
    capPlayerPlay();
  }
  /** The line under the playhead (or the one being typed in), as an index. */
  function capLineAt(t) {
    const evs = ve.capEvents || [];
    const rel = t - capOff();
    let best = -1;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (rel >= e.start && rel <= e.end + 0.05) best = i;   // the later one wins where two touch
      if (e.start > rel) break;
    }
    return best;
  }
  function capReplayLine() {
    const p = ve.refs.player;
    let i = ve._capLine ? ve._capLine.i : -1;
    const focused = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('cap-text')
      ? +document.activeElement.dataset.i : -1;
    if (focused >= 0) i = focused;
    if (i < 0 && p) i = capLineAt(p.currentTime || 0);
    if (i >= 0) capPlayLine(i);
  }
  function capBack(sec) {
    const p = ve.refs.player; if (!p) return;
    const R = capPlayRange();
    ve._capTypePausedAt = null;
    seekTo(Math.max(R.a, (p.currentTime || 0) - (sec || 3)));
    capPlayerPaint(true);
  }
  /** Typing stops the sound (when that box is ticked). */
  function capPauseForTyping() {
    const p = ve.refs.player;
    const box = $('#capPlayTypePause');
    if (!p || p.paused || !box || !box.checked) return;
    p.pause();
    ve._capTypePausedAt = p.currentTime || 0;
    capPlayerPaint(true);
  }

  /* The bar, the lit line and the follow-scroll, every frame while it plays. */
  function capPlayerLoop() {
    if (capPlRaf != null) return;
    const step = () => {
      capPlRaf = null;
      const p = ve.refs.player;
      if (!p || !capModalOpen()) return;
      // A single line ends where the line ends — checked per frame, because
      // `timeupdate` comes four times a second and would overshoot into the
      // next line by up to a quarter of a second.
      if (ve._capLine && !p.paused && (p.currentTime || 0) >= ve._capLine.b) {
        const loop = $('#capPlayLoop');
        if (loop && loop.checked) { p.currentTime = ve._capLine.a; }
        else { p.pause(); ve._capLine = null; }
      }
      capPlayerPaint(false);
      if (!p.paused) capPlRaf = requestAnimationFrame(step);
    };
    capPlRaf = requestAnimationFrame(step);
  }

  let capPlLast = { key: '', now: -2 };
  function capPlayerPaint(force) {
    if (!capModalOpen()) return;
    const p = ve.refs.player;
    const t = p ? (p.currentTime || 0) : 0;
    const R = capPlayRange();
    const span = Math.max(0.001, R.b - R.a);
    const playing = !!(p && !p.paused);
    const btn = $('#capPlay');
    if (btn) { const want = playing ? '⏸' : '▶'; if (btn.textContent !== want) btn.textContent = want; }
    const lab = $('#capPlayTime');
    if (lab) {
      const txt = ve._capTypePausedAt != null && !playing
        ? '⏸ paused while you type — Ctrl+Space carries on'
        : `${fmt(clamp(t - R.a, 0, span))} / ${fmt(span)}`;
      if (lab.textContent !== txt) lab.textContent = txt;
    }
    const scrub = $('#capPlayScrub');
    if (scrub && !scrub._dragging) {
      const v = String(Math.round(clamp((t - R.a) / span, 0, 1) * 1000));
      if (scrub.value !== v) scrub.value = v;
    }
    // The line being spoken.
    const now = capLineAt(t);
    if (force || now !== capPlLast.now) {
      capPlLast.now = now;
      $$('#capList .cap-row.now').forEach((r) => { if (+r.dataset.row !== now) r.classList.remove('now'); });
      const row = now >= 0 ? document.querySelector(`#capList .cap-row[data-row="${now}"]`) : null;
      if (row) {
        row.classList.add('now');
        // Follow it — unless the operator is typing in a line, in which case
        // the list stays exactly where their hands are.
        const typing = document.activeElement && document.activeElement.classList
          && document.activeElement.classList.contains('cap-text');
        if (playing && !typing) {
          const list = document.getElementById('capList');
          const lb = list.getBoundingClientRect(), rb = row.getBoundingClientRect();
          if (rb.top < lb.top + 4 || rb.bottom > lb.bottom - 4) {
            list.scrollTop += (rb.top - lb.top) - list.clientHeight / 3;
          }
        }
      }
    }
  }

  /* ---- 💬 BESIDE THE VIDEO ----
   *
   * "Captions editor: 1 · Beside the video." The editor takes the studio over:
   * the studio folds itself down to its PROGRAM monitor — the short exactly as it
   * will burn in — which then fills the left of the screen, the listening bar
   * moves under the picture, and the words take the right. Nothing is drawn
   * twice: it is the same preview, the same caption overlay and the same
   * player, just given the room. On a narrow screen (a phone, the Cloud Studio)
   * there is no "beside", so the window simply fills the screen as before.
   */
  const capBesideFits = () => window.innerWidth >= 900 && !!(proView() && proView().classList.contains('ve-pro'));
  function enterCapMode() {
    const m = document.getElementById('capModal'); if (!m) return false;
    const view = proView(), mon = $('#veMonitors'), pl = $('#capPlayer');
    const beside = capBesideFits();
    m.classList.toggle('beside', beside);
    if (beside && view && mon) {
      view.classList.add('ve-capmode');
      if (pl && pl.parentNode !== mon) {
        ve._capPlayerHome = { parent: pl.parentNode, next: pl.nextSibling };
        mon.appendChild(pl);
      }
    }
    ve._monSig = null;
    requestAnimationFrame(() => {
      layoutMonitors(); updateCropMask();
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
      renderTextOverlays();
    });
    return beside;
  }
  function exitCapMode() {
    const m = document.getElementById('capModal');
    const view = proView(), pl = $('#capPlayer');
    if (m) m.classList.remove('beside');
    if (view) view.classList.remove('ve-capmode');
    const home = ve._capPlayerHome;
    if (pl && home && home.parent && pl.parentNode !== home.parent) {
      try { home.parent.insertBefore(pl, home.next && home.next.parentNode === home.parent ? home.next : null); } catch (e) { home.parent.appendChild(pl); }
    }
    ve._capPlayerHome = null;
    ve._monSig = null;
    requestAnimationFrame(() => {
      layoutMonitors(); updateCropMask();
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
      renderTextOverlays();
      ve._tlPadL = null; renderRuler(); renderSegments(); updatePlayhead();
    });
  }

  /* ---- the settings, folded under one row of what they are set to ---- */
  const CAP_FOLD_KEY = 'mw-cap-fold';
  function selText(id) {
    const s = document.getElementById(id);
    return s && s.selectedIndex >= 0 && s.options[s.selectedIndex] ? s.options[s.selectedIndex].textContent.trim() : '';
  }
  function renderCapSummary() {
    const el = document.getElementById('capSumChips'); if (!el) return;
    const look = selText('capStyleSel') || 'Look';
    const font = selText('capFont');
    const words = (document.getElementById('capWords') || {}).value;
    const hearing = capHearsInCloud() ? '☁️ Groq' : (selText('capModelSel').split(' — ')[0].replace(/^Automatic/, 'Auto') || 'PC');
    const chips = [
      `<span class="cap-sum-chip look" title="The look">${escape2(look)}</span>`,
      font ? `<span class="cap-sum-chip" title="Font">${escape2(font)}</span>` : '',
      `<span class="cap-sum-chip" title="Words per line">${words === 'auto' ? 'Auto words' : escape2(words || '3') + ' words'}</span>`,
      `<span class="cap-sum-chip" title="Case">${escape2(selText('capCase') || 'ALL CAPS')}</span>`,
      `<span class="cap-sum-chip" title="Position">${escape2(selText('capPos') || 'Bottom')}</span>`,
      `<span class="cap-sum-chip" title="Who listens">${escape2(hearing)}</span>`,
    ].join('');
    if (el.innerHTML !== chips) el.innerHTML = chips;
  }
  function setCapFolded(folded, remember) {
    const box = document.querySelector('#capModal .cap-box'); if (!box) return;
    box.classList.toggle('folded', !!folded);
    const b = document.getElementById('capSumToggle');
    if (b) {
      b.textContent = folded ? '🎨 Style & settings ▾' : '🎨 Style & settings ▴';
      b.setAttribute('aria-expanded', folded ? 'false' : 'true');
    }
    if (remember) { try { localStorage.setItem(CAP_FOLD_KEY, folded ? '1' : '0'); } catch (e) {} }
  }
  /** Folded when there are words to fix (unless the operator said otherwise);
   *  always open on an empty list, because the look is chosen before listening. */
  function applyCapFold() {
    const hasLines = capScopedIndexes().length > 0;
    let pref = null;
    try { pref = localStorage.getItem(CAP_FOLD_KEY); } catch (e) {}
    setCapFolded(hasLines && pref !== '0', false);
  }

  /* ======================= ✍ THE PROOF-READER =======================
   *
   * "Maybe add a Grammarly kind of thing in the captions window — an option to
   *  correct grammatical errors either per line or overall."
   *
   * Two halves, shown the same way:
   *
   *   • THE RULES (src/renderer/capgrammar.js) run as you look and as you type,
   *     on this PC, instantly and for free: missing apostrophes, the wrong
   *     sound-alike word, a/an, a stuttered word, names that need capitals, and
   *     the things speech recognition does to a sermon (HOLY GOAT, LET US PREY).
   *     Each mistake is underlined under the very letters it is about, like a
   *     spell-checker.
   *   • THE AI (✨) reads the lines the way a person would, and catches the
   *     word that was misheard as another real word — "begotten SUN" — which no
   *     rule can. It only ever SUGGESTS; the operator says yes.
   *
   * Per line: the badge on a line opens what is wrong with it — click one fix,
   * or "Fix all" for that line, or Ignore. Overall: ✍ Fix all at the top takes
   * every underlined fix and every AI suggestion in one go, as one Ctrl+Z.
   *
   * Fixes made here are NOT taught to the Word Book. The Word Book remembers
   * what the operator corrected by hand; these are the proof-reader's own rules,
   * and they run again on every video anyway.
   */
  const CG = () => window.CapGrammar || null;
  const escA = (s) => escape2(s).replace(/"/g, '&quot;');
  function gram() {
    if (!ve._gram) ve._gram = { ai: new Map(), open: new Set(), ignore: new Set() };
    return ve._gram;
  }
  /* A line is known by when it starts — indexes move when a line is removed. */
  const lineKey = (e) => (e ? Number(e.start).toFixed(3) : '');
  const ignoreKey = (text, id) => String(text).toLowerCase() + '|' + id;

  /** The rows the window is showing, as indexes into the caption store. */
  function capScopedIndexes() {
    const all = ve.capEvents || [];
    const scope = ve.capScope;
    const out = [];
    all.forEach((c, i) => { if (!scope || (c.end > scope.start + 0.02 && c.start < scope.end - 0.02)) out.push(i); });
    return out;
  }
  /** The lines either side, but only when they are part of the same breath —
   *  the neighbour of a short's last line may be in a different short. */
  function capNeighbours(i) {
    const evs = ve.capEvents || [];
    const e = evs[i], p = evs[i - 1], n = evs[i + 1];
    const near = (a, b) => !!(a && b && (b.start - a.end) <= 1.5);
    return { prev: near(p, e) ? p.text : '', next: near(e, n) ? n.text : '' };
  }
  /** The rules' verdict on one line, minus anything the operator ignored. */
  function grammarFor(i, text) {
    const G = CG(); if (!G) return null;
    const e = (ve.capEvents || [])[i]; if (!e) return null;
    const t = text != null ? String(text) : String(e.text);
    const r = G.checkLine(t, Object.assign({ caseMode: capGroupCfg().tc }, capNeighbours(i)));
    const ign = gram().ignore;
    r.issues = r.issues.filter((x) => !ign.has(ignoreKey(t, x.id)));
    let s = t;
    [...r.issues].sort((a, b) => b.start - a.start).forEach((x) => { s = s.slice(0, x.start) + x.to + s.slice(x.end); });
    r.fixed = G.tidySpaces(s);
    return r;
  }
  /** The AI's suggestion for a line, if it still applies to what the line says. */
  function aiFor(i, text) {
    const e = (ve.capEvents || [])[i]; if (!e) return null;
    const s = gram().ai.get(lineKey(e));
    const t = text != null ? String(text) : String(e.text);
    if (!s || s.orig !== t) return null;
    if (gram().ignore.has(ignoreKey(t, 'ai:' + s.text.toLowerCase()))) return null;
    return s;
  }
  /** Character ranges of the words the AI would change, for underlining. */
  function aiChangedRanges(t, sugg) {
    const G = CG(); if (!G) return [];
    const toks = G.tokenize(t);
    const ops = G.diffWords(t, sugg);
    const out = [];
    let k = 0;
    for (const op of ops) {
      if (op.op === 'add') continue;
      const tok = toks[k++];
      if (op.op === 'del' && tok) out.push({ start: tok.start, end: tok.end });
    }
    return out;
  }
  function diffHtml(a, b) {
    const G = CG(); if (!G) return escape2(b);
    return G.diffWords(a, b).map((o) => (o.op === 'same' ? escape2(o.text)
      : o.op === 'del' ? `<del>${escape2(o.text)}</del>` : `<ins>${escape2(o.text)}</ins>`)).join(' ');
  }
  /* The see-through copy of the words must be laid out exactly like the box. */
  function syncHlStyle(inp, hl) {
    // Re-measured when the window changes size: the box's padding is smaller
    // on a short screen, and stale padding would put every underline off by it.
    const sizeKey = window.innerWidth + 'x' + window.innerHeight;
    if (hl._styled === sizeKey) return;
    const cs = getComputedStyle(inp);
    ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'textTransform', 'lineHeight',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth',
      'borderBottomWidth', 'borderLeftWidth', 'textIndent', 'boxSizing'].forEach((k) => { hl.style[k] = cs[k]; });
    hl.style.borderStyle = 'solid';
    hl.style.borderColor = 'transparent';
    hl.style.display = 'flex';
    hl.style.alignItems = 'center';
    hl._styled = sizeKey;
  }

  /** Underlines, badge and (if open) the suggestion card for one row. */
  function paintGrammarRow(row, text) {
    const inp = row.querySelector('.cap-text'); if (!inp) return 0;
    const i = +inp.dataset.i;
    const e = (ve.capEvents || [])[i]; if (!e) return 0;
    const t = text != null ? String(text) : inp.value;
    const r = grammarFor(i, t);
    const ai = aiFor(i, t);
    const issues = r ? r.issues : [];
    const hl = row.querySelector('.cap-hl');
    if (hl) {
      syncHlStyle(inp, hl);
      const marks = issues.filter((x) => x.end > x.start && x.kind !== 'space')
        .map((x) => ({ start: x.start, end: x.end, cls: 'g-' + x.kind, why: x.why }))
        .concat(ai ? aiChangedRanges(t, ai.text).map((x) => Object.assign(x, { cls: 'g-ai', why: ai.why })) : [])
        .sort((a, b) => a.start - b.start);
      let html = '', at = 0;
      for (const m of marks) {
        if (m.start < at) continue;
        // A removal underlines the word, not the space in front of it.
        let s0 = m.start;
        while (s0 < m.end && /\s/.test(t[s0])) s0++;
        html += escape2(t.slice(at, s0)) + `<mark class="${m.cls}">${escape2(t.slice(s0, m.end))}</mark>`;
        at = m.end;
      }
      html += escape2(t.slice(at));
      if (hl.innerHTML !== html) hl.innerHTML = '<span>' + html + '</span>';
      hl.scrollLeft = inp.scrollLeft;
    }
    const n = issues.length + (ai ? 1 : 0);
    const badge = row.querySelector('.cap-g-badge');
    if (badge) {
      badge.classList.toggle('hidden', !n);
      const aiOnly = !!ai && !issues.length;
      badge.classList.toggle('ai', aiOnly);
      badge.textContent = aiOnly ? '✨ Suggestion' : `✍ ${n}`;
      badge.title = n
        ? (issues.map((x) => `${x.from || '…'} → ${x.to || '(remove)'}  (${x.why})`).concat(ai ? [`✨ AI: ${ai.text}`] : []).join('\n')
          + '\n\nClick to see and fix')
        : '';
    }
    row.classList.toggle('has-g', !!n);
    const open = n && gram().open.has(lineKey(e));
    let card = row.querySelector('.cap-sugg');
    if (!open) { if (card) card.remove(); return n; }
    if (!card) { card = document.createElement('div'); card.className = 'cap-sugg'; row.appendChild(card); }
    const chips = issues.map((x, k) =>
      `<button type="button" class="cap-sugg-chip" data-gfix="${i}" data-gk="${k}" title="${escA(x.why)} — click to fix just this">`
      + `${x.from ? `<del>${escape2(x.from.trim())}</del> → ` : ''}${x.to ? `<ins>${escape2(x.to)}</ins>` : '<ins>(remove it)</ins>'}`
      + ` <span class="cap-sugg-why">${escape2(x.why)}</span></button>`).join('');
    const aiHtml = ai
      ? `<div class="cap-sugg-line"><span class="tag">✨ AI</span>${diffHtml(t, ai.text)}`
        + (ai.why ? ` <span class="cap-sugg-why">— ${escape2(ai.why)}</span>` : '') + '</div>'
      : '';
    const acts = '<span class="cap-sugg-acts">'
      + (ai ? `<button type="button" class="primary-btn" data-gai="${i}">✓ Use the AI's line</button>` : '')
      + (issues.length > 1 || (issues.length && ai) ? `<button type="button" class="ghost-btn" data-gline="${i}">✓ Fix this line</button>` : '')
      + `<button type="button" class="ghost-btn" data-gignore="${i}">Ignore</button></span>`;
    const html = aiHtml + chips + acts;
    if (card.innerHTML !== html) card.innerHTML = html;
    return n;
  }
  function paintAllGrammar() {
    $$('#capList .cap-row').forEach((row) => paintGrammarRow(row));
    updateGrammarSummary();
  }
  /** The ✍ button at the top says how many mistakes there are, always. */
  function updateGrammarSummary() {
    const b = document.getElementById('capGrammarFix');
    if (!b) return;
    let n = 0, lines = 0;
    if (CG()) {
      for (const i of capScopedIndexes()) {
        const r = grammarFor(i);
        const k = (r ? r.issues.length : 0) + (aiFor(i) ? 1 : 0);
        n += k; if (k) lines++;
      }
    }
    b.textContent = n ? `✍ Fix ${n} mistake${n === 1 ? '' : 's'}` : '✍ No mistakes';
    b.classList.toggle('has', !!n);
    b.dataset.count = String(n);
    b.title = n
      ? `Fix all ${n} underlined mistake${n === 1 ? '' : 's'} on ${lines} line${lines === 1 ? '' : 's'} in one go. ↶ Undo puts them all back.`
      : 'Nothing is underlined in these lines. ✨ AI check reads them for misheard words too.';
  }

  /* ---- applying a fix ---- */
  /** Back to the words' own case: the lines may be in CAPS, the word list is not. */
  function naturalWord(tok, sample) {
    const G = CG();
    const a = (window.WordBook && window.WordBook.splitAffix) ? window.WordBook.splitAffix(tok) : { pre: '', core: tok, post: '' };
    const k = a.core.toLowerCase();
    let w;
    if (G && G.PROPER && G.PROPER.has(k)) w = G.PROPER.get(k);
    else if (k === 'i' || k.startsWith("i'")) w = 'I' + a.core.slice(1).toLowerCase();
    else if (k === 'god' || k === "god's" || k === 'lord' || k === "lord's") w = a.core.charAt(0).toUpperCase() + a.core.slice(1).toLowerCase();
    else if (/[a-z]/.test(a.core)) w = a.core;                       // the line was not in caps: keep it as typed
    else w = /^[A-Z]/.test(String(sample || '')) ? a.core.charAt(0) + a.core.slice(1).toLowerCase() : a.core.toLowerCase();
    return a.pre + w + a.post;
  }
  /**
   * Put a corrected line's words back into the word timings underneath it, so
   * changing Words/line later cannot resurrect the mistake (the same reason the
   * Word Book corrects both). One-for-one where the count is unchanged; where a
   * word was removed or added, the line's span is shared out by length.
   */
  function syncCapWordsFor(e, before, after) {
    const W = ve.capWords;
    if (!Array.isArray(W) || !W.length || !e) return;
    const idx = [];
    W.forEach((w, k) => { const mid = (w.start + w.end) / 2; if (mid >= e.start - 0.01 && mid <= e.end + 0.01) idx.push(k); });
    if (!idx.length) return;
    const oldT = String(before).split(/\s+/).filter(Boolean);
    const newT = String(after).split(/\s+/).filter(Boolean);
    if (idx.length !== oldT.length) return;   // these words are not one-for-one with the line — leave them alone
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9']/g, '');
    if (newT.length === oldT.length) {
      newT.forEach((tok, j) => {
        if (norm(tok) === norm(oldT[j]) && tok === oldT[j]) return;
        const w = W[idx[j]];
        W[idx[j]] = Object.assign({}, w, { text: naturalWord(tok, w.text) });
      });
      return;
    }
    const a = W[idx[0]].start, b = W[idx[idx.length - 1]].end;
    const total = newT.reduce((s, x) => s + x.length, 0) || 1;
    let acc = 0;
    const fresh = newT.map((tok, j) => {
      const s = a + (b - a) * (acc / total);
      acc += tok.length;
      return { text: naturalWord(tok, (W[idx[Math.min(j, idx.length - 1)]] || {}).text), start: +s.toFixed(3), end: +(a + (b - a) * (acc / total)).toFixed(3) };
    });
    W.splice(idx[0], idx.length, ...fresh);
  }
  /** One line rewritten by the proof-reader. An emptied line (a repeat that was
   *  the whole line) is removed, and its time goes to the line before it. */
  function setCapLineText(i, text) {
    const evs = ve.capEvents || [];
    const e = evs[i]; if (!e) return false;
    const G = CG();
    const t = G ? G.tidySpaces(text) : String(text).trim();
    if (t === e.text) return false;
    if (!t) {
      const p = evs[i - 1];
      if (p && p.end >= e.start - 1.5) p.end = Math.max(p.end, e.end);
      evs.splice(i, 1);
      if (Array.isArray(ve.capWords)) {
        ve.capWords = ve.capWords.filter((w) => { const mid = (w.start + w.end) / 2; return !(mid >= e.start - 0.01 && mid <= e.end + 0.01); });
      }
      return true;
    }
    // A corrected line loses its arrival text, or the Case dropdown would
    // rebuild it from the old words (same rule as the Word Book's sweep).
    // `_was` keeps what the line said before the FIRST fix, so the window can
    // show which lines were changed, from what, and put one back on its own.
    evs[i] = Object.assign({}, e, { text: t, origText: undefined, _was: e._was != null ? e._was : e.text });
    syncCapWordsFor(e, e.text, t);
    gram().ai.delete(lineKey(e));
    return true;
  }
  /** After any proof-reader change: everything that shows the words, redrawn. */
  function afterGrammarChange() {
    renderCapTrack(); renderClipList();
    renderCapList();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
  }
  /** Commit a half-typed line first, so a fix acts on what is on screen. */
  function commitCapRow(i) {
    const inp = document.querySelector(`#capList .cap-text[data-i="${i}"]`);
    if (inp && inp._commit) inp._commit();
  }
  function fixOneIssue(i, k) {
    commitCapRow(i);
    const r = grammarFor(i); if (!r || !r.issues[k]) return;
    const G = CG();
    pushHistory({ captions: true });
    const e = ve.capEvents[i];
    setCapLineText(i, G.applyIssue(e.text, r.issues[k]));
    afterGrammarChange();
    refocusRow(i);
  }
  function fixLine(i, useAi) {
    commitCapRow(i);
    const e = (ve.capEvents || [])[i]; if (!e) return;
    const ai = aiFor(i);
    let t = useAi && ai ? ai.text : e.text;
    const r = grammarFor(i, t);
    if (r) t = r.fixed;
    if (t === e.text) return;
    pushHistory({ captions: true });
    setCapLineText(i, t);
    gram().open.delete(lineKey(e));
    afterGrammarChange();
    refocusRow(i);
  }
  function ignoreLine(i) {
    const e = (ve.capEvents || [])[i]; if (!e) return;
    const r = grammarFor(i);
    (r ? r.issues : []).forEach((x) => gram().ignore.add(ignoreKey(e.text, x.id)));
    const ai = aiFor(i);
    if (ai) gram().ignore.add(ignoreKey(e.text, 'ai:' + ai.text.toLowerCase()));
    gram().open.delete(lineKey(e));
    const row = document.querySelector(`#capList .cap-row[data-row="${i}"]`);
    if (row) paintGrammarRow(row);
    updateGrammarSummary();
  }
  function refocusRow(i) {
    const inp = document.querySelector(`#capList .cap-text[data-i="${i}"]`)
      || document.querySelector(`#capList .cap-text[data-i="${Math.max(0, i - 1)}"]`);
    if (inp) { try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); } }
  }
  /** ✍ Fix all — every underlined mistake and every AI suggestion, one Ctrl+Z. */
  function fixAllGrammar() {
    const focused = document.activeElement && document.activeElement.classList
      && document.activeElement.classList.contains('cap-text') ? +document.activeElement.dataset.i : -1;
    if (focused >= 0) commitCapRow(focused);
    const plan = [];
    for (const i of capScopedIndexes()) {
      const e = ve.capEvents[i];
      const ai = aiFor(i);
      let t = ai ? ai.text : e.text;
      const r = grammarFor(i, t);
      if (r) t = r.fixed;
      if (t !== e.text) plan.push({ i, t, from: e.text });
    }
    if (!plan.length) {
      window.__toast && window.__toast('✍ Nothing to fix — no line here has a mistake underlined. ✨ AI check can read them for misheard words too.', 'good', 6000);
      return 0;
    }
    pushHistory({ captions: true });
    let removed = 0;
    // From the end, so removing a whole repeated line cannot shift the ones still to do.
    for (const p of plan.sort((a, b) => b.i - a.i)) {
      if (!CG().tidySpaces(p.t)) removed++;
      setCapLineText(p.i, p.t);
    }
    gram().open.clear();
    afterGrammarChange();
    const n = plan.length;
    setCapFixNote(`✍ Fixed ${n} line${n === 1 ? '' : 's'}${removed ? ` (${removed} repeated word${removed === 1 ? '' : 's'} removed)` : ''} — ↶ Undo puts them back`, true);
    window.__toast && window.__toast(`✍ Fixed ${n} line${n === 1 ? '' : 's'} — marked below. ↶ Undo puts them all back.`, 'good', 5000);
    return n;
  }

  /* ---- the window's own controls, wired once ---- */
  function wireCapPlayerAndGrammar() {
    const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };
    on('capPlay', 'click', capTogglePlay);
    on('capPlayBack', 'click', () => capBack(3));
    on('capPlayLine', 'click', capReplayLine);
    on('capPlayRate', 'change', (e) => capSetRate(parseFloat(e.target.value) || 1));
    on('capSumToggle', 'click', () => setCapFolded(!document.querySelector('#capModal .cap-box').classList.contains('folded'), true));
    // The one-row summary follows every setting it describes.
    const ctl = document.querySelector('#capModal .cap-controls');
    if (ctl) ctl.addEventListener('change', () => renderCapSummary());
    on('capGrammarFix', 'click', fixAllGrammar);
    on('capGrammarAi', 'click', () => aiProofread(null));
    loadAiAuto();
    const scrub = document.getElementById('capPlayScrub');
    if (scrub) {
      const go = () => {
        const R = capPlayRange();
        ve._capLine = null; ve._capTypePausedAt = null;
        seekTo(R.a + (R.b - R.a) * (+scrub.value / 1000));
        capPlayerPaint(true);
      };
      scrub.addEventListener('pointerdown', () => { scrub._dragging = true; });
      scrub.addEventListener('input', go);
      scrub.addEventListener('change', () => { scrub._dragging = false; go(); });
      scrub.addEventListener('pointerup', () => { scrub._dragging = false; });
    }
    // The studio's own player drives the bar: a play/pause/seek from anywhere
    // (the timeline, the studio's ▶, a clip card) shows up here too.
    const p = ve.refs.player;
    if (p) {
      p.addEventListener('play', () => { if (capModalOpen()) capPlayerLoop(); });
      ['pause', 'seeked', 'ended'].forEach((ev) => p.addEventListener(ev, () => { if (capModalOpen()) capPlayerPaint(true); }));
    }
    const list = document.getElementById('capList');
    if (list) {
      // mousedown is swallowed so the line being typed in keeps its focus — a
      // click that blurred it would commit and redraw the list underneath the
      // button, and the click would land on nothing.
      list.addEventListener('mousedown', (e) => {
        if (e.target.closest('.cap-row-play, .cap-g-badge, .cap-ai-line, .cap-sugg button')) e.preventDefault();
      });
      list.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b || !list.contains(b)) return;
        const d = b.dataset;
        if (d.playI != null) {
          const i = +d.playI;
          const p2 = ve.refs.player;
          if (p2 && !p2.paused && ve._capLine && ve._capLine.i === i) { p2.pause(); ve._capLine = null; capPlayerPaint(true); return; }
          capPlayLine(i);
          return;
        }
        if (d.gI != null) {
          const e2 = (ve.capEvents || [])[+d.gI]; if (!e2) return;
          const k = lineKey(e2);
          if (gram().open.has(k)) gram().open.delete(k); else gram().open.add(k);
          const row = b.closest('.cap-row'); if (row) paintGrammarRow(row);
          return;
        }
        if (d.aiI != null) { aiProofread(+d.aiI); return; }
        if (d.gfix != null) { fixOneIssue(+d.gfix, +d.gk); return; }
        if (d.gai != null) { fixLine(+d.gai, true); return; }
        if (d.gline != null) { fixLine(+d.gline, false); return; }
        if (d.gignore != null) { ignoreLine(+d.gignore); }
      });
    }
    /*
     * KEYS. Ctrl+Space plays and pauses even while typing in a line — that is
     * the whole point of it — and Ctrl+Shift+Space hears the line again. A
     * plain Space on a button is left to the button: the studio's own Space
     * shortcut would otherwise ALSO fire, and play-then-pause is nothing.
     */
    const modal = document.getElementById('capModal');
    if (modal) {
      modal.addEventListener('keydown', (e) => {
        if (e.code !== 'Space') return;
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault(); e.stopPropagation();
          if (e.shiftKey) capReplayLine(); else capTogglePlay();
          return;
        }
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
        e.stopPropagation();
        if (tag === 'BUTTON') return;
        e.preventDefault();
        capTogglePlay();
      }, true);
    }
  }

  /* ---- ✨ proof-read new captions by itself (the "auto" tick) ---- */
  const AI_AUTO_KEY = 'mw-cap-ai-auto';
  function loadAiAuto() {
    const box = document.getElementById('capGrammarAuto'); if (!box) return;
    let v = null;
    try { v = localStorage.getItem(AI_AUTO_KEY); } catch (e) {}
    box.checked = v !== '0';
    if (!box._wired) {
      box._wired = true;
      box.addEventListener('change', () => { try { localStorage.setItem(AI_AUTO_KEY, box.checked ? '1' : '0'); } catch (e) {} });
    }
  }
  /** After captions are made: hand the new lines to the AI, without waiting on it. */
  function maybeAutoProofread(indexes) {
    const box = document.getElementById('capGrammarAuto');
    if (!box || !box.checked || !indexes || !indexes.length) return;
    aiProofread(null, { indexes, auto: true }).catch(() => {});
  }

  /* ---- ✨ the AI ---- */
  async function aiProofread(only, opts) {
    const o = opts || {};
    const api = window.api && window.api.captions && window.api.captions.grammar;
    if (!api) { if (!o.auto) window.__toast && window.__toast('✨ The AI proof-reader is not available in this build.', 'error'); return null; }
    const focused = document.activeElement && document.activeElement.classList
      && document.activeElement.classList.contains('cap-text') ? +document.activeElement.dataset.i : -1;
    if (focused >= 0) commitCapRow(focused);
    const evs = ve.capEvents || [];
    const idx = only != null ? [only] : (o.indexes || capScopedIndexes());
    if (!idx.length) { if (!o.auto) window.__toast && window.__toast('There are no caption lines to proof-read yet.', 'error'); return null; }
    const lines = idx.map((i) => ({ i, text: evs[i].text }));
    // Context for the edges: a lone line is read with the lines around it.
    const lo = idx[0], hi = idx[idx.length - 1];
    const before = [lo - 2, lo - 1].filter((k) => k >= 0 && evs[k]).map((k) => ({ i: k, text: evs[k].text }));
    const after = [hi + 1, hi + 2].filter((k) => evs[k]).map((k) => ({ i: k, text: evs[k].text }));
    const mode = ($('#capGrammarMode') || {}).value || 'exact';
    const btn = only != null ? document.querySelector(`#capList .cap-ai-line[data-ai-i="${only}"]`) : $('#capGrammarAi');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.classList.add('busy'); if (only == null) btn.textContent = `✨ Reading ${lines.length} line${lines.length === 1 ? '' : 's'}…`; }
    const jobId = window.__newJobId ? window.__newJobId() : 'g' + Date.now();
    let offProg = null;
    if (only == null && window.api.onJobProgress && btn) {
      offProg = window.api.onJobProgress(({ jobId: j, percent }) => { if (j === jobId && btn.classList.contains('busy')) btn.textContent = `✨ Reading… ${percent}%`; });
    }
    let res = null;
    try { res = await api({ lines, before, after, caseMode: capGroupCfg().tc, mode, jobId }); }
    catch (e) { res = { fixes: [], why: (e && e.message) || 'the AI did not answer' }; }
    finally {
      if (btn) { btn.classList.remove('busy'); btn.textContent = label; }
      if (typeof offProg === 'function') { try { offProg(); } catch (e) {} }
    }
    if (!res) return null;
    if (res.unavailable) {
      if (o.auto) return res;            // switched on but no key: the rules still run, quietly
      window.__toast && window.__toast(`✨ The AI proof-reader needs the free Groq key (${res.why}). Add it with ☁️ Groq cloud in the Hearing list above, or in 🎤 Listen — the same key does both. The underlined fixes work without it.`, 'error', 12000);
      return res;
    }
    let shown = 0;
    for (const f of (res.fixes || [])) {
      const e = evs[f.i];
      const sent = lines.find((l) => l.i === f.i);
      if (!e || !sent || e.text !== sent.text) continue;     // the line changed while the AI was reading
      gram().ai.set(lineKey(e), { text: f.text, orig: e.text, why: f.why || '' });
      gram().open.add(lineKey(e));
      shown++;
    }
    paintAllGrammar();
    const by = res.by ? ` (${res.by})` : '';
    if (o.auto) {
      // Proof-read on its own after the captions were made: one quiet word,
      // and only if there is something to look at.
      if (shown) {
        const where = capModalOpen() ? 'they are shown under each line' : 'open 💬 on a short to see them under each line';
        setCapFixNote(`✨ The AI suggests changes to ${shown} line${shown === 1 ? '' : 's'}${by} — ${where}`, true);
        window.__toast && window.__toast(`✨ The AI proof-read the new captions and suggests changes to ${shown} line${shown === 1 ? '' : 's'} — ${where}. ✍ Fix all takes them all.`, 'good', 8000);
      }
      return Object.assign({}, res, { shown });
    }
    if (only != null) {
      if (!shown) window.__toast && window.__toast(res.why ? `✨ The AI could not check that line — ${res.why}.` : '✨ The AI read that line and would not change it.', res.why ? 'error' : 'good', 5000);
    } else if (shown) {
      setCapFixNote(`✨ The AI suggests changes to ${shown} of ${lines.length} lines${by} — see them under each line, or ✍ Fix all`, true);
      window.__toast && window.__toast(`✨ The AI suggests changes to ${shown} line${shown === 1 ? '' : 's'} — they are shown under each line. Use them one by one, or ✍ Fix all takes them all.`, 'good', 8000);
      const first = document.querySelector('#capList .cap-sugg');
      if (first) first.scrollIntoView({ block: 'nearest' });
    } else {
      window.__toast && window.__toast(res.why ? `✨ The AI could not proof-read these lines — ${res.why}.` : `✨ The AI read ${lines.length} lines${by} and found nothing to change.`, res.why ? 'error' : 'good', 7000);
    }
    return Object.assign({}, res, { shown });
  }
  /**
   * Is the on-device speech engine usable? If not, say WHY and what to do about
   * it (on a Mac build without the whisper binary that's a fixable packaging
   * thing, not a broken app) — a bare "not available in this build" leaves the
   * user with nowhere to go.
   */
  async function checkCapEngine() {
    let info = null;
    try { info = await window.api.captions.engineInfo(); } catch (e) {}
    if (!info) { // older/leaner build without the info channel
      let avail = false;
      try { avail = await window.api.captions.available(); } catch (e) {}
      if (!avail) window.__toast && window.__toast('The caption engine is not available in this build.', 'error');
      return avail;
    }
    if (info.available) return true;
    const msg = [info.reason, info.howTo].filter(Boolean).join(' ');
    window.__toast && window.__toast('💬 ' + (msg || 'The caption engine is not available in this build.'), 'error', 12000);
    return false;
  }
  /**
   * Open the captions window. It NEVER transcribes on the way in.
   *
   * Pressing 💬 used to go straight to a transcription — minutes of it — and
   * only then show the window where the look and the listening model are
   * chosen. So the one moment those settings matter was the one moment you
   * could not reach them. The window now opens immediately on whatever there
   * is (usually nothing), with every setting live and a Generate button that
   * does the listening when the settings are right.
   */
  async function openCaptions() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    if (!(await checkCapEngine())) return;
    // Already transcribed this exact video? Show it, edits and all.
    if (ve.capEvents && ve.capEvents.length && ve._capSource === ve.video.path && ve._capMode === 'full') {
      renderCapTrack();
      revealCaptions();
    }
    openCaptionsForShort(null);
  }

  /**
   * Actually go and listen. Called by the Generate button in the window, so the
   * style and the Hearing model have already been chosen by the time it runs.
   * `scope` is a short's range, or null for the whole video.
   */
  async function generateCaptions(scope) {
    if (!ve.video) return;
    if (!(await checkCapEngine())) return;
    const wanted = await ensureCapModelReady();
    if (wanted === 'cancelled') return;
    const spanSec = scope ? scope.end - scope.start : ve.video.info.durationSec;
    const mins = spanSec / 60;
    // Word-level transcription runs at roughly 2-3x REALTIME on a typical laptop
    // (measured: 65-97s for 30s of audio), so an hour of video is a couple of
    // hours of waiting. A prompt promising "~N min" for an N-minute video is off
    // by a factor of three and sends people away to make tea.
    const estMins = Math.round(mins * 2.5);
    const estText = estMins >= 60 ? `${(estMins / 60).toFixed(1)} hours` : `${estMins} min`;
    const cloud = capHearsInCloud();
    // In the cloud a long video is a minute or two, not hours — but two hours of
    // audio is Groq's whole free allowance for an hour, so THAT is what is said.
    if (!scope && cloud && mins > 100 && !window.confirm(`This video is ${Math.round(mins)} min long. Groq's free cloud Whisper hears it in a minute or two, but that uses most of this hour's free allowance (2 hours of audio an hour).\n\nTip: make your shorts first, then press 💬 Auto-caption all shorts — that only listens to the clips you're posting. Transcribe the whole video anyway?`)) return;
    if (!scope && !cloud && mins > 10 && !window.confirm(`This video is ${Math.round(mins)} min long, so transcribing all of it takes around ${estText} on this PC.\n\nTip: ✂️ make your shorts first, then press 💬 Auto-caption all shorts — that only listens to the clips you're actually posting, which is far quicker. Transcribe the whole video anyway?`)) return;
    const jobId = window.__newJobId();
    // A short whose pauses were just found by the words has been heard already.
    let res = scope && cloud ? cachedCloudWords(scope) : null;
    if (!res) try {
      res = await window.__runJob(cloud ? '☁️ Groq’s free cloud Whisper is listening… (word-by-word timing)' : '🎧 Transcribing speech on your PC… (word-by-word timing)', jobId,
        () => window.api.captions.transcribe(Object.assign(
          { input: ve.video.path, model: capModelCfg(), jobId },
          scope ? { startSec: scope.start, endSec: scope.end } : {})));
    } catch (e) { return; }
    const words = (res && res.words) || [];
    if (!words.length) return window.__toast && window.__toast('No speech was detected to caption.', 'error');
    noteBookFixes(res);
    noteHeardBy(res);
    commitCapEdit();
    pushHistory({ captions: true });
    if (scope) {
      const g = capGroupCfg();
      const lines = groupWords(words, g.wpl, g.tc)
        .filter((x) => x.text && x.text.trim())
        .map((x) => ({ start: x.start + scope.start, end: x.end + scope.start, text: x.text }));
      const keep = (ve.capEvents || []).filter((e) => !(e.end > scope.start + 0.02 && e.start < scope.end - 0.02));
      ve.capEvents = keep.concat(lines).sort((a, b) => a.start - b.start);
      // Keep the WORD timings too, in timeline time, replacing only this clip's
      // stretch. Without them Words/line has nothing to regroup from and would
      // clear every caption the moment it was touched.
      const absWords = words.map((w) => ({ ...w, start: w.start + scope.start, end: w.end + scope.start }));
      const keepWords = (ve.capWords || []).filter((w) => !(w.end > scope.start + 0.02 && w.start < scope.end - 0.02));
      ve.capWords = keepWords.concat(absWords).sort((a, b) => a.start - b.start);
      ve.capOffset = 0; ve.capTarget = null;
      ve._capSource = ve.video.path; ve._capMode = 'shorts'; ve._capClipId = null;
      scope._capKey = clipCapKey(scope);
      // A captioned short is one you meant to post with captions on.
      const c = $('#veCapExports'); if (c) c.checked = true;
      ve.capSel = null; ve.capEditing = null;
      renderClipList();
      revealClipCaptions(scope);
    } else {
      ve.capWords = words;
      ve.capTarget = null; ve.capOffset = 0; ve._capSource = ve.video.path; ve._capMode = 'full';
      rebuildCapEvents();
    }
    revealCaptions();
    renderCapList();
    renderCapTrack();
    maybeAutoProofread(capScopedIndexes());
  }

  /**
   * The chosen listening model has to BE here before it can listen.
   *
   * Small is the default because it is the one that gets the words right, but
   * it is a download rather than part of the app. Saying so at the moment it
   * matters — with the size, and a way to carry on without it — beats either a
   * silent fallback to a rougher model or a dead end.
   * Returns 'ready' | 'fallback' | 'cancelled'.
   */
  async function ensureCapModelReady() {
    const id = ve.capModel;
    if (!id) return 'ready';                       // automatic: uses what is installed
    let list = ve._capModelAll || [];
    if (!list.length) { try { list = await window.api.captions.models(); ve._capModelAll = list; } catch (e) { return 'ready'; } }
    const m = list.find((x) => x.id === id);
    if (!m || m.installed) return 'ready';
    const size = m.sizeMB >= 1024 ? (m.sizeMB / 1024).toFixed(1) + ' GB' : m.sizeMB + ' MB';
    const best = list.find((x) => x.inUse);
    const go = window.confirm(
      `Captions are set to listen with ${m.name}, which is a ${size} download (once — then it works offline forever).\n\n`
      + `OK — download it now.\nCancel — use ${best ? best.name : 'the model already installed'} for this one.`);
    if (!go) return 'fallback';
    const got = await getCapModel(id);
    return got ? 'ready' : 'fallback';
  }
  /**
   * Put ONE short's caption lines on the timeline lane. Both caption buttons go
   * through here, so "caption all" and "caption this one" can never disagree
   * about where the lines live or what counts as already done.
   * Returns 'skipped' | 'done' | 'none' | 'cancelled' | 'failed'.
   */
  async function captionClipIntoLane(s, g) {
    if (hasClipCaps(s) && s._capKey === clipCapKey(s)) return 'skipped';
    const jid = window.__newJobId();
    // Heard already while its pauses were found? Then that IS the transcript.
    let res = capHearsInCloud() ? cachedCloudWords(s) : null;
    if (!res) try {
      res = await window.__runJob(`${capHearsInCloud() ? '☁️' : '🎧'} Captioning "${s.label}" (${Math.round(s.end - s.start)}s clip only — never the whole video)…`, jid,
        () => window.api.captions.transcribe({ input: ve.video.path, startSec: s.start, endSec: s.end, model: capModelCfg(), jobId: jid }));
    } catch (e) { return (e && e.cancelled) ? 'cancelled' : 'failed'; }
    const words = (res && res.words) || [];
    if (!words.length) return 'none';
    noteBookFixes(res);
    noteHeardBy(res);
    // Word times come back CLIP-RELATIVE; the lane is on the source's clock, so
    // they are shifted once here and never converted again until export.
    const lines = groupWords(words, g.wpl, g.tc)
      .filter((x) => x.text && x.text.trim())
      .map((x) => ({ start: x.start + s.start, end: x.end + s.start, text: x.text }));
    // Replace anything already on the lane inside this clip (a re-caption after
    // trimming shouldn't leave the old lines lying underneath the new ones).
    const keep = (ve.capEvents || []).filter((e) => !(e.end > s.start + 0.02 && e.start < s.end - 0.02));
    ve.capEvents = keep.concat(lines).sort((a, b) => a.start - b.start);
    ve.capOffset = 0;               // lane times are absolute for short captions
    ve.capTarget = null;
    ve._capSource = ve.video.path;
    ve._capMode = 'shorts';
    ve._capClipId = null;
    s._capKey = clipCapKey(s);
    return 'done';
  }

  /** Take the operator to a clip's caption lines on the lane: zoom in far enough
   *  to read them, scroll there, select the first one and park the playhead on it. */
  function revealClipCaptions(s) {
    const i = (ve.capEvents || []).findIndex((e) => e.end > s.start + 0.02 && e.start < s.end - 0.02);
    if (i < 0) return false;
    ve.capSel = i; ve.activeRow = 'caption';
    zoomForCaptions(i);            // zooms only if the blocks are too narrow to read
    renderCapTrack();
    seekTo(Math.max(0, ve.capEvents[i].start));
    updateCapOverlay(ve.refs.player.currentTime || 0);
    return true;
  }

  /**
   * The 💬 button on a short's card.
   *
   * If that short's lines are ALREADY on the timeline — which they are after
   * "Auto-caption all shorts" — this must not transcribe again. Re-running
   * whisper on work that is already done (and possibly already hand-edited)
   * costs minutes and would throw the edits away. It takes you to the lines
   * instead.
   */
  async function captionShort(id) {
    const s = ve.segments.find((x) => x.id === id); if (!s || !ve.video) return;
    // Already done — go straight to the words. Re-running whisper on work that
    // is finished (and possibly already hand-corrected) costs minutes and would
    // throw the corrections away.
    if (hasClipCaps(s)) {
      revealClipCaptions(s);
      renderClipList();
      openCaptionsForShort(s);
      return;
    }
    if (!(await checkCapEngine())) return;
    commitCapEdit();
    // The window first, with the look and the listening model on it — the
    // Generate button inside is what transcribes. Same rule as the whole-video
    // button: settings are chosen before the minutes are spent, not after.
    openCaptionsForShort(s);
  }

  /* ============ 💬 Auto-caption ALL shorts — and ONLY the shorts ============
   * One press captions every clip in the Shorts panel. Each short's own time
   * range is transcribed separately (seconds per clip), so the full uploaded
   * video is NEVER transcribed — that is the entire point of this button vs the
   * whole-video "Auto-captions" tool.
   *
   * The lines land on the timeline's 💬 Captions track in SOURCE-ABSOLUTE
   * seconds, where they are fully editable — click a block to retype it, drag it
   * to re-time it — and they are burned onto the short exactly as edited.
   */
  /**
   * ONE caption store: the timeline lane (`ve.capEvents`, SOURCE-ABSOLUTE with
   * `capOffset = 0`).
   *
   * The per-short captions used to live on the segment (`s.capEvents`), which
   * meant they were invisible — the operator could not see or fix a misheard
   * word, which is the whole point of having a transcript. Putting them on the
   * lane instead makes every existing caption tool work on them for free: click
   * a block to retype it, drag it to re-time, Delete to drop it, Ctrl+Z to undo,
   * and the preview overlay shows the edit as you type. Keeping a second copy on
   * the clip would only let the two drift apart, so the clip stores nothing but
   * a marker of WHAT RANGE it was captioned at (to skip re-transcribing it).
   */
  const capLinesIn = (s) => (((F(s) && F(s).capEvents) || ve.capEvents) || []).filter((e) =>
    e && e.end > s.start + 0.02 && e.start < s.end - 0.02);
  /*
   * A short remembers that it HAS HAD captions (s.hadCaps, saved with the
   * session). "Auto-caption my shorts on export" is ticked for you by
   * 💬 Auto-caption all shorts, so without this a short whose captions the
   * operator then REMOVED was quietly transcribed again at export and came out
   * captioned anyway. Had them, has none now = removed on purpose: exported
   * clean. (Captioning it again brings it straight back.)
   */
  const hasClipCaps = (s) => {
    const yes = capLinesIn(s).length > 0;
    if (yes && s && !s.hadCaps) s.hadCaps = true;
    return yes;
  };
  /** Should this short's export carry captions? Its own lines always do; the
   *  auto-caption box adds them only to a short whose captions were never removed. */
  const exportWantsCaps = (s, autoOn) => hasClipCaps(s) || (!!autoOn && !(s && s.hadCaps));
  const clipCapKey = (s) => `${s.start.toFixed(2)}|${s.end.toFixed(2)}`;
  async function captionAllShorts() {
    if (!ve.video) return;
    const shorts = shortsOf().filter((s) => (s.lane || 0) === 0).sort((a, b) => a.start - b.start);
    if (!shorts.length) {
      return window.__toast && window.__toast('No shorts to caption yet — click ✂️ Long to short clips first. (This button captions ONLY the shorts, never your whole video.)', 'error', 7000);
    }
    if (!(await checkCapEngine())) return;
    const g = capGroupCfg();
    // Captions are slow to produce, so make this ONE undoable step before any of
    // it lands — Ctrl+Z must restore whatever was on the lane before, not force
    // a re-transcribe.
    commitCapEdit();
    pushHistory({ captions: true });
    let done = 0, skipped = 0;
    const fresh = [];
    for (let i = 0; i < shorts.length; i++) {
      const s = shorts[i];
      if (window.__setJobBatch) window.__setJobBatch(i + 1, shorts.length);
      // SAME function the per-clip 💬 button uses, so the two can never disagree
      // about what "already captioned" means.
      const r = await captionClipIntoLane(s, g);
      if (r === 'cancelled') break;   // Cancel stops the whole sweep
      if (r === 'skipped') { skipped++; continue; }
      if (r !== 'done') continue;     // no speech / failed — don't sink the rest
      done++;
      fresh.push(s);
      renderCapTrack();               // blocks appear as each short finishes
    }
    if (window.__setJobBatch) window.__setJobBatch(null);
    if (done || skipped) {
      // captions must actually land on the exports — flip the export toggle on
      const c = $('#veCapExports'); if (c) c.checked = true;
    }
    ve.capSel = null; ve.capEditing = null;
    renderCapTrack(); renderCapList(); renderClipList();
    updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    const zoomed = (done || skipped) ? revealCaptions(true) : false; // lane in view, no rival toast
    const n = (ve.capEvents || []).length;
    window.__toast && window.__toast(done || skipped
      ? `💬 ${done + skipped === shorts.length ? 'All ' : ''}${done + skipped} short${done + skipped > 1 ? 's' : ''} captioned — ${n} line${n > 1 ? 's' : ''} on the 💬 Captions track. Click any line to retype it, drag it to re-time it.`
        + (zoomed ? ' (Zoomed in so you can read them — press “Fit” for the whole video.)' : '')
      : 'No speech was detected in the shorts.', done || skipped ? 'good' : 'error', 9000);
    // The freshly captioned lines go to the AI proof-reader (if "auto" is on).
    if (fresh.length) {
      const idx = [];
      (ve.capEvents || []).forEach((e, i) => { if (fresh.some((s) => e.end > s.start + 0.02 && e.start < s.end - 0.02)) idx.push(i); });
      maybeAutoProofread(idx);
    }
  }
  /**
   * Re-time a short's caption lines for an export whose pauses were removed.
   *
   * Caption times are stored relative to the clip's start; once "Close gap" drops a
   * pause, everything after it happens EARLIER in the exported video. Without this,
   * every line after the first cut drifts later and later — the words stop matching
   * the mouth. Each line is intersected with the kept pieces, so a line that fell
   * entirely inside a removed pause disappears, and one that straddled the cut is
   * clipped to the part that survived.
   */
  function remapCapEventsThroughCuts(s, events) {
    const pieces = keptPieces(s);
    const out = [];
    for (const e of (events || [])) {
      const a = s.start + e.start, b = s.start + e.end;
      for (const p of pieces) {
        const A = Math.max(a, p.start), B = Math.min(b, p.end);
        if (B - A < 0.02) continue; // nothing of this line survived in this piece
        const oa = srcToOut(s, A), ob = srcToOut(s, Math.min(B, p.end - 0.001));
        if (oa == null) continue;
        out.push(Object.assign({}, e, { start: oa, end: Math.max(oa + 0.05, ob == null ? oa + (B - A) : ob) }));
      }
    }
    return out.sort((x, y) => x.start - y.start);
  }
  async function burnCaps() {
    commitCapEdit();
    const scope = ve.capScope;
    document.getElementById('capModal').classList.add('hidden');
    ve.capScope = null;
    /*
     * Opened from one short's 💬 button: export THAT short with THESE lines.
     *
     * The lane holds source-absolute times and the exported short starts at the
     * clip's own start, so the lines are rebased once here — the same
     * conversion "auto-caption my shorts on export" does, deliberately shared so
     * the two routes can never put the words in different places.
     */
    if (scope) {
      const rel = capLinesIn(scope)
        .map((e) => ({ start: Math.max(0, e.start - scope.start), end: Math.min(scope.end, e.end) - scope.start, text: e.text }))
        .filter((e) => e.text && e.text.trim());
      if (!rel.length) return window.__toast && window.__toast('There are no caption lines on this short to burn in.', 'error');
      const timed = hasCuts(scope) ? remapCapEventsThroughCuts(scope, rel) : rel;
      if (!timed.length) return window.__toast && window.__toast('Every caption line fell inside a removed pause — nothing left to burn.', 'error');
      try {
        let shortPath = await exportOneClip(scope);
        shortPath = await burnTextIntoShort(scope, shortPath);
        let out = await burnCapsInto({
          input: shortPath, events: timed, label: scope.label, deleteInput: true,
          outName: `short-${(scope.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-captioned`,
        });
        out = await finishExport(scope, out);
        window.finishedFile(out);
      } catch (e) { /* __runJob already said what went wrong */ }
      return;
    }
    const events = (ve.capEvents || []).filter((s) => s.text && s.text.trim());
    if (!events.length) return;
    try {
      if (ve.capTarget) {
        // 1) export the short (optionally face-tracked), 2) burn the clip-timed captions onto it
        const s = ve.capTarget;
        // pull the lines back in time over any pause this clip had removed (a no-op
        // when it has none) so they still land on the words being spoken
        const timed = remapCapEventsThroughCuts(s, events);
        if (!timed.length) return window.__toast && window.__toast('Every caption line fell inside a removed pause — nothing left to burn.', 'error');
        let shortPath = await exportOneClip(s);
        shortPath = await burnTextIntoShort(s, shortPath);
        let out = await burnCapsInto({
          input: shortPath, events: timed, label: s.label, deleteInput: true,
          outName: `short-${(s.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-captioned`,
        });
        out = await finishExport(s, out); // background music, then the outro
        window.finishedFile(out);
      } else {
        let out = await burnCapsInto({
          input: ve.video.path, events, size: (ve.video && ve.video.info) || null,
        });
        out = await burnTextIntoWholeVideo(out); // added text rides along here too
        out = await finishExport(null, out); // background music, then the outro
        window.finishedFile(out);
      }
    } catch (e) {}
  }
  /** Silent per-short captioning used by "auto-caption my shorts on export". */
  /*
   * `textSize` travels with the pictures for one reason: if they could not be
   * drawn up front, the text fallback below has to re-draw them at the RIGHT
   * frame. 💾 Export video renders at the recording's own size, not at the
   * social preset, and defaulting would put the text on the wrong canvas.
   */
  async function autoCaptionExport(s, shortPath, textImages, textSize) {
    // The timeline's 💬 Captions track already holds lines covering this clip —
    // burn THOSE, so every retype and re-time the operator did on the lane is
    // what ends up in the file, and whisper is not paid for twice. Lane times
    // are source-absolute; the exported short starts at s.start.
    if (hasClipCaps(s)) {
      const rel = capLinesIn(s)
        .map((e) => ({ start: Math.max(0, e.start - s.start), end: Math.min(s.end, e.end) - s.start, text: e.text }))
        .filter((e) => e.text && e.text.trim());
      const timed = reTimed(s) ? remapCapEventsThroughCuts(s, rel) : rel;
      if (timed.length) {
        return burnCapsInto({
          input: shortPath, events: timed, label: s.label, deleteInput: true,
          outName: `short-${(s.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-captioned`,
          task: taskOf(s), style: F(s) && F(s).capStyle, images: textImages,
        });
      }
      // Every line fell inside a removed pause, so there are no captions to
      // burn — but the TEXT still has to go on, and it was handed to this
      // function instead of being burned before it. Dropping it here would lose
      // it silently, which is the one thing worse than an extra pass.
      return burnTextIntoShort(s, shortPath, textSize || null, textImages);
    }
    const j1 = window.__newJobId();
    // A clip with pauses removed no longer matches its source range, so transcribe
    // the exported short itself — it already has the pauses taken out, which makes
    // the word timings right by construction (same audio, no mapping to get wrong).
    const model = (F(s) ? F(s).capModel : capModelCfg());
    const src = reTimed(s)
      ? { input: shortPath, model, jobId: j1 }
      : { input: ve.video.path, startSec: s.start, endSec: s.end, model, jobId: j1 };
    const res = await window.__runJob(`🎧 Captioning "${s.label}" (clip only)…`, j1,
      () => window.api.captions.transcribe(src), J(s, 'caption'));
    const words = (res && res.words) || [];
    // No speech in the clip: no captions, but the added text still belongs on it.
    if (!words.length) return burnTextIntoShort(s, shortPath, textSize || null, textImages);
    const g = (F(s) && F(s).capGroup) || capGroupCfg();
    const events = groupWords(words, g.wpl, g.tc).filter((x) => x.text && x.text.trim());
    // …and the same if the grouping left nothing to draw.
    if (!events.length) return burnTextIntoShort(s, shortPath, textSize || null, textImages);
    return burnCapsInto({
      input: shortPath, events, label: s.label, deleteInput: true,
      outName: `short-${(s.label || 'clip').replace(/[^\w.-]+/g, '_').slice(0, 40)}-captioned`,
      task: taskOf(s), style: F(s) && F(s).capStyle, images: textImages,
    });
  }

  /* ---------------- adjust & effects ---------------- */
  async function applyFx() {
    document.getElementById('fxModal').classList.add('hidden');
    const q = (id) => document.getElementById(id);
    const edits = {
      speed: +q('fxSpeed').value, volume: +q('fxVol').value, look: q('fxLook').value,
      brightness: +q('fxBri').value, contrast: +q('fxCon').value, saturation: +q('fxSat').value,
      sharpen: +q('fxSharp').value,
      fadeIn: +q('fxFadeIn').value, fadeOut: +q('fxFadeOut').value, rotate: +q('fxRot').value,
      flipH: q('fxFlipH').checked, flipV: q('fxFlipV').checked,
      // Fall back to the library track, so music chosen in the 🎵 Music panel
      // also lands on a whole-video export without picking a file twice.
      musicPath: ve.fxMusic || (ve.music && ve.music.file) || null,
      musicVolume: (!ve.fxMusic && ve.music) ? ve.music.volume : +q('fxMusicVol').value,
      // one setting, every export route: the Shorts panel's noise removal
      denoise: denoiseCfg(),
    };
    const jobId = window.__newJobId();
    try {
      let out = await window.__runJob('✨ Applying effects & exporting…', jobId,
        () => window.api.video.applyEdits({ input: ve.video.path, edits, jobId }));
      out = await appendOutroTo(null, out); // the outro goes on this too
      window.finishedFile(out);
    } catch (e) {}
    resetFxPreview();
  }

  const FX_LOOK_CSS = {
    '': '', vivid: 'saturate(1.6) contrast(1.15)', warm: 'sepia(0.25) saturate(1.2) hue-rotate(-8deg)',
    cool: 'saturate(1.1) hue-rotate(12deg)', bw: 'grayscale(1)', vintage: 'sepia(0.35) contrast(0.92) saturate(0.85) brightness(1.03)',
  };
  /**
   * Approximate live preview of the Effects panel directly on the <video>
   * element (CSS filter/transform + playbackRate/volume) so changes are visible
   * BEFORE exporting. This is a close visual approximation, not pixel-identical
   * to the ffmpeg render (CSS eq math differs slightly from ffmpeg's `eq` filter).
   */
  function updateFxPreview() {
    const q = (id) => document.getElementById(id);
    const p = ve.refs.player; if (!p) return;
    const speed = clamp(parseFloat(q('fxSpeed').value) || 1, 0.0625, 16); // HTMLMediaElement playbackRate range
    p.playbackRate = speed;
    p.volume = clamp(parseFloat(q('fxVol').value) / 2, 0, 1); // fxVol is 0-2 (export gain); video.volume maxes at 1
    const bri = parseFloat(q('fxBri').value) || 0, con = parseFloat(q('fxCon').value) || 1, sat = parseFloat(q('fxSat').value) || 1;
    const look = FX_LOOK_CSS[q('fxLook').value] || '';
    // Sharpness: CSS has no sharpen, so drive the inline SVG convolution filter
    // (#fxSharpen) live. amount 0..2 → kernel edge weight 0..0.8 (0 = identity).
    const sharp = clamp(parseFloat(q('fxSharp').value) || 0, 0, 2);
    const sv = q('fxSharpV'); if (sv) sv.textContent = sharp ? sharp.toFixed(1) + '×' : 'Off';
    const km = document.getElementById('fxSharpKernel');
    if (km) { const a = sharp * 0.4; km.setAttribute('kernelMatrix', `0 ${-a} 0 ${-a} ${(1 + 4 * a).toFixed(3)} ${-a} 0 ${-a} 0`); }
    p.style.filter = `brightness(${1 + bri}) contrast(${con}) saturate(${sat}) ${look} ${sharp > 0 ? 'url(#fxSharpen)' : ''}`.replace(/\s+/g, ' ').trim();
    const rot = parseInt(q('fxRot').value, 10) || 0;
    const flipH = q('fxFlipH').checked ? -1 : 1, flipV = q('fxFlipV').checked ? -1 : 1;
    // compose with the CapCut canvas transform (pan/zoom) instead of clobbering it
    ve._fxT = (rot || flipH < 0 || flipV < 0) ? `rotate(${rot}deg) scale(${flipH},${flipV})` : '';
    setPlayerTransform();
  }
  function resetFxPreview() {
    const p = ve.refs.player; if (!p) return;
    p.playbackRate = 1; p.volume = 1; p.style.filter = ''; ve._fxT = '';
    setPlayerTransform();
  }

  /* ================= MEDIA LIBRARY: background music & outro clips =================
   *
   * Two problems, one shelf. Adding music used to mean a file dialog inside the
   * export panel — you re-found the same MP3 for every video and the choice was
   * gone the moment the panel closed. Outros didn't exist at all. So both now
   * live in a saved library in the main process: add a file once, it's there for
   * every service after that, one click to use.
   *
   * The music you pick is a BED, not a clip you have to place: by default it
   * starts at the top of every short you export, ducks under the preaching, and
   * fades out at the end. Drag it on the 🎵 lane and it switches to following the
   * timeline instead, for the people who want that control.
   */
  // capStyle is on a -v2 key: the shipped default moved from Clean to Outline, and
  // a value stored under the old key would quietly keep overriding it. Bumping the
  // key hands everyone the new default once; anything picked from now on sticks.
  const LIB_KEYS = { music: 'mw-ve-music', outro: 'mw-ve-outro', capStyle: 'mw-cap-style-v2', capLook: 'mw-cap-look-v1' };
  const outNameFor = (p) => String(p).split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/-\d{8}-\d{6}$/, '').slice(0, 50) || 'clip';
  const fmtDur = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  function saveMusicPref() {
    try {
      localStorage.setItem(LIB_KEYS.music, ve.music ? JSON.stringify({
        id: ve.music.id, volume: ve.music.volume, fadeIn: ve.music.fadeIn,
        fadeOut: ve.music.fadeOut, duck: ve.music.duck, bed: ve.music.bed,
      }) : '');
    } catch (e) {}
  }
  function saveOutroPref() {
    try { localStorage.setItem(LIB_KEYS.outro, ve.outro ? JSON.stringify({ id: ve.outro.id, all: ve.outroAll }) : ''); } catch (e) {}
  }

  /** Pull the saved library from main and re-attach whatever was chosen last time. */
  async function libRefresh() {
    try { ve.lib = await window.api.library.list(); }
    catch (e) { ve.lib = { music: [], clips: [] }; }
    // Re-bind the remembered choices to the live entries (a track deleted from
    // the library must not linger as an invisible bed on the next export).
    const readPref = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
    if (!ve.music) {
      const p = readPref(LIB_KEYS.music);
      const hit = p && ve.lib.music.find((m) => m.id === p.id);
      if (hit) ve.music = musicFrom(hit, p);
    } else if (!ve.lib.music.some((m) => m.id === ve.music.id)) { ve.music = null; }
    if (!ve.outro) {
      const p = readPref(LIB_KEYS.outro);
      const hit = p && ve.lib.clips.find((c) => c.id === p.id);
      if (hit) { ve.outro = hit; ve.outroAll = p.all !== false; }
    } else if (!ve.lib.clips.some((c) => c.id === ve.outro.id)) { ve.outro = null; }
    renderLibrary();
    renderMusicLane(); renderSegments();
    return ve.lib;
  }
  function musicFrom(entry, pref = {}) {
    return {
      id: entry.id, name: entry.name, file: entry.file, durationSec: entry.durationSec || 0,
      volume: pref.volume != null ? pref.volume : 0.25,
      fadeIn: pref.fadeIn != null ? pref.fadeIn : 1,
      fadeOut: pref.fadeOut != null ? pref.fadeOut : 1.5,
      duck: pref.duck !== false,
      bed: pref.bed !== false,       // start the song at the top of every short
      tlStart: 0, srcStart: 0, len: entry.durationSec || 0,
    };
  }

  function openLibrary(tab) {
    const m = $('#libModal'); if (!m) return;
    setLibTab(tab || ve.libTab || 'music');
    m.classList.remove('hidden');
    libRefresh();
  }
  function setLibTab(tab) {
    ve.libTab = tab;
    $$('.lib-tab').forEach((b) => b.classList.toggle('active', b.dataset.libtab === tab));
    $$('.lib-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.libpane !== tab));
    const title = $('#libTitle');
    if (title) title.textContent = tab === 'clips' ? '🎬 My clips' : tab === 'youtube' ? '▶️ Music from YouTube' : '🎵 My music';
    const hint = $('#libHint');
    if (hint) hint.textContent = tab === 'clips'
      ? 'The clip you pick is added to the END of every short you export.'
      : 'The track you pick plays under every clip you export.';
    if (tab === 'youtube') ytRefreshStatus();
  }

  function renderLibrary() {
    renderMusicList(); renderClipGrid(); renderMusicBar(); renderOutroBar();
  }

  function renderMusicList() {
    const el = $('#libMusicList'); if (!el) return;
    const list = (ve.lib && ve.lib.music) || [];
    if (!list.length) {
      el.innerHTML = `<p class="muted small lib-empty">No music saved yet. Click <b>➕ Add music from my PC</b> — or grab a track from the <b>▶️ YouTube</b> tab.</p>`;
      return;
    }
    el.innerHTML = list.map((m) => `
      <div class="lib-row${ve.music && ve.music.id === m.id ? ' sel' : ''}" data-musicid="${m.id}">
        <span class="lib-row-icon">${m.source === 'youtube' ? '▶️' : '🎵'}</span>
        <span class="lib-row-main">
          <b>${escape2(m.name)}</b>
          <span class="muted small">${fmtDur(m.durationSec)}${m.source === 'youtube' ? ' · from YouTube' : ''}</span>
        </span>
        <button class="lib-mini" data-musicplay="${m.id}" title="Listen">▶</button>
        <button class="primary-btn small" data-musicuse="${m.id}">${ve.music && ve.music.id === m.id ? '✓ In use' : 'Use'}</button>
        <button class="lib-mini danger" data-musicdel="${m.id}" title="Remove from my library">🗑</button>
      </div>`).join('');
    $$('[data-musicuse]', el).forEach((b) => b.addEventListener('click', () => useMusic(b.dataset.musicuse)));
    $$('[data-musicplay]', el).forEach((b) => b.addEventListener('click', () => auditionMusic(b.dataset.musicplay)));
    $$('[data-musicdel]', el).forEach((b) => b.addEventListener('click', () => removeFromLibrary('music', b.dataset.musicdel)));
  }

  function renderClipGrid() {
    const el = $('#libClipList'); if (!el) return;
    const list = (ve.lib && ve.lib.clips) || [];
    if (!list.length) {
      el.innerHTML = `<p class="muted small lib-empty">No clips saved yet. Click <b>➕ Add a clip from my PC</b> and your outro is one tap away from then on.</p>`;
      return;
    }
    el.innerHTML = list.map((c) => `
      <div class="lib-card${ve.outro && ve.outro.id === c.id ? ' sel' : ''}" data-clipid="${c.id}">
        <div class="lib-card-thumb">${c.thumb ? `<img src="${fileUrl(c.thumb)}" alt="" />` : '<span>🎬</span>'}
          <span class="lib-card-dur">${fmtDur(c.durationSec)}</span>
          ${ve.outro && ve.outro.id === c.id ? '<span class="lib-card-badge">✓ Outro</span>' : ''}
        </div>
        <div class="lib-card-name" title="${attr2(c.name)}">${escape2(c.name)}</div>
        <div class="lib-card-btns">
          <button class="primary-btn small" data-clipuse="${c.id}">Add to end</button>
          <button class="lib-mini danger" data-clipdel="${c.id}" title="Remove from my library">🗑</button>
        </div>
      </div>`).join('');
    $$('[data-clipuse]', el).forEach((b) => b.addEventListener('click', () => useOutro(b.dataset.clipuse)));
    $$('[data-clipdel]', el).forEach((b) => b.addEventListener('click', () => removeFromLibrary('clips', b.dataset.clipdel)));
  }

  function renderMusicBar() {
    const bar = $('#libMusicBar'); if (!bar) return;
    const m = ve.music;
    bar.classList.toggle('hidden', !m || ve.libTab === 'clips');
    if (!m) return;
    $('#libChosenName').textContent = m.name;
    const v = $('#libMusicVol'); if (v) v.value = String(m.volume);
    const vv = $('#libMusicVolV'); if (vv) vv.textContent = Math.round(m.volume * 100) + '%';
    const fi = $('#libMusicFadeIn'); if (fi) fi.value = String(m.fadeIn);
    const fo = $('#libMusicFadeOut'); if (fo) fo.value = String(m.fadeOut);
    const d = $('#libMusicDuck'); if (d) d.checked = !!m.duck;
    const b = $('#libMusicBed'); if (b) b.checked = !!m.bed;
  }
  function renderOutroBar() {
    const bar = $('#libOutroBar'); if (!bar) return;
    bar.classList.toggle('hidden', !ve.outro || ve.libTab !== 'clips');
    if (!ve.outro) return;
    $('#libOutroName').textContent = ve.outro.name;
    const a = $('#libOutroAll'); if (a) a.checked = ve.outroAll !== false;
  }

  async function addToLibrary(kind) {
    const filters = kind === 'music'
      ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'wma', 'opus'] }]
      // Pictures too: a church's end card is very often a flyer, not footage.
      : [{ name: 'Video or picture', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif'] }];
    let p;
    try { p = await window.api.dialog.openFile(filters); } catch (e) { p = null; }
    if (!p) return;
    window.__showOverlay && window.__showOverlay(kind === 'music' ? '🎵 Saving to your music library…' : '🎬 Saving to your clip library…');
    try {
      const entry = await window.api.library.add(kind, p);
      await libRefresh();
      // Adding it IS choosing it — that's the whole point of the button.
      if (kind === 'music') useMusic(entry.id); else useOutro(entry.id);
    } catch (e) {
      window.__toast && window.__toast('⚠️ ' + (e.message || 'Could not add that file.'), 'error');
    } finally { window.__hideOverlay && window.__hideOverlay(); }
  }

  async function removeFromLibrary(kind, id) {
    try { await window.api.library.remove(kind, id); } catch (e) {}
    if (kind === 'music' && ve.music && ve.music.id === id) clearMusic();
    if (kind === 'clips' && ve.outro && ve.outro.id === id) clearOutro();
    libRefresh();
  }

  function useMusic(id) {
    const entry = ((ve.lib && ve.lib.music) || []).find((m) => m.id === id);
    if (!entry) return;
    const keep = ve.music && ve.music.id === id ? ve.music : {};
    ve.music = musicFrom(entry, keep);
    saveMusicPref();
    renderLibrary(); renderMusicLane(); updateMusicButton();
    syncMusicPreview(true);
    window.__toast && window.__toast(`🎵 "${entry.name}" is now the background music — it plays under every clip you export.`, 'good');
  }
  function clearMusic() {
    ve.music = null; saveMusicPref();
    stopAudition();
    const a = ve.refs.musicAudio; if (a) { a.pause(); a.removeAttribute('src'); a.dataset.file = ''; }
    renderLibrary(); renderMusicLane(); updateMusicButton();
  }
  function useOutro(id) {
    const entry = ((ve.lib && ve.lib.clips) || []).find((c) => c.id === id);
    if (!entry) return;
    ve.outro = entry; ve.outroAll = true;
    saveOutroPref();
    renderLibrary(); renderSegments(); updateMusicButton();
    window.__toast && window.__toast(`🎬 "${entry.name}" goes on the end of the timeline — and on the end of every short you export.`, 'good');
  }
  function clearOutro() {
    ve.outro = null; saveOutroPref();
    renderLibrary(); renderSegments(); updateMusicButton();
  }

  /** Listen to a library track without committing to it. */
  function auditionMusic(id) {
    const entry = ((ve.lib && ve.lib.music) || []).find((m) => m.id === id); if (!entry) return;
    const a = ve.refs.musicAudio; if (!a) return;
    if (ve._auditionId === id && !a.paused) return stopAudition();
    ve.refs.player && ve.refs.player.pause();
    ve._auditionId = id;
    a.src = fileUrl(entry.file); a.dataset.file = entry.file;
    a.volume = 0.7; a.currentTime = 0;
    const pr = a.play(); if (pr && pr.catch) pr.catch(() => {});
    $$('[data-musicplay]').forEach((b) => { b.textContent = b.dataset.musicplay === id ? '⏸' : '▶'; });
  }
  function stopAudition() {
    const a = ve.refs.musicAudio;
    if (a) a.pause();
    ve._auditionId = null;
    $$('[data-musicplay]').forEach((b) => { b.textContent = '▶'; });
  }

  function updateMusicButton() {
    const mb = $('#veMusic');
    if (mb) { mb.classList.toggle('on', !!ve.music); mb.textContent = ve.music ? `🎵 ${ve.music.name.slice(0, 16)}` : '🎵 Music'; }
    const cb = $('#veClips');
    if (cb) { cb.classList.toggle('on', !!ve.outro); cb.textContent = ve.outro ? `🎬 ${ve.outro.name.slice(0, 16)}` : '🎬 Clips'; }
  }

  /* ---- the 🎵 lane on the timeline ---- */
  function renderMusicLane() {
    const track = ve.refs.musicTrack; if (!track) return;
    layout();
    const m = ve.music;
    if (!m || !ve.video) {
      track.innerHTML = `<span class="muted small ve-lane-empty">🎵 No background music — click <b>Music</b> up top to add some.</span>`;
      return;
    }
    const start = m.bed ? 0 : (m.tlStart || 0);
    const len = m.bed ? dur() : Math.min(m.len || m.durationSec || 0, Math.max(1, dur() - start));
    const left = start * ve.pxPerSec, width = Math.max(24, len * ve.pxPerSec);
    track.innerHTML = `<div class="ve-music-seg${m.bed ? ' bed' : ''}" data-musicseg="1" style="left:${left}px;width:${width}px;"
        title="${attr2(m.name)} — ${Math.round(m.volume * 100)}% volume.${m.bed ? ' Starts at the top of every short. Drag it to place it on the timeline instead.' : ' Drag to move it.'}">
        <span class="ve-music-label">🎵 ${escape2(m.name)}</span>
        <span class="ve-music-vol">${Math.round(m.volume * 100)}%</span>
      </div>`;
    const box = track.querySelector('.ve-music-seg');
    if (box) {
      box.addEventListener('mousedown', onMusicSegDown);
      box.addEventListener('dblclick', () => openLibrary('music'));
    }
  }
  function onMusicSegDown(ev) {
    const m = ve.music; if (!m) return;
    ev.preventDefault(); ev.stopPropagation();
    const x0 = trackX(ev);
    const wasBed = m.bed, t0 = m.bed ? 0 : (m.tlStart || 0);
    let moved = false;
    const move = (e) => {
      const dt = (trackX(e) - x0) / ve.pxPerSec;
      if (Math.abs(dt) < 0.05 && !moved) return;
      moved = true;
      // Dragging the music is an explicit "put it HERE", so it stops being a
      // per-short bed and starts following the timeline.
      m.bed = false;
      m.len = m.len || m.durationSec || dur();
      m.tlStart = clamp(snapT(t0 + dt).t, 0, Math.max(0, dur() - 0.5));
      renderMusicLane();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      if (moved) {
        saveMusicPref(); renderMusicBar(); syncMusicPreview(true);
        if (wasBed) window.__toast && window.__toast('🎵 Music now follows the timeline — each short uses the part of the song sitting under it. Tick “Start the song at the top of every short” in the Music panel to go back.', 'good', 7000);
      } else { openLibrary('music'); }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up, { once: true });
  }

  /* ---- live music under the preview ---- */
  /** Where in the song the playhead is, or null when no music plays here. */
  function musicPosFor(t) {
    const m = ve.music; if (!m) return null;
    const md = m.durationSec || 0;
    if (m.bed) {
      // The bed restarts with each clip, exactly as the export does.
      const s = ve.segments.find((x) => (x.lane || 0) === 0 && t >= x.start && t < x.end);
      const rel = t - (s ? s.start : 0);
      return md > 0.1 ? rel % md : rel;
    }
    const tl = m.tlStart || 0, len = m.len || md;
    if (t < tl || t > tl + len) return null;
    return (m.srcStart || 0) + (t - tl);
  }
  function syncMusicPreview(force) {
    const a = ve.refs.musicAudio; if (!a) return;
    if (ve._auditionId) return; // listening to a track in the library — don't fight it
    const m = ve.music;
    if (!m || !m.file) { if (!a.paused) a.pause(); return; }
    if (a.dataset.file !== m.file) { a.src = fileUrl(m.file); a.dataset.file = m.file; }
    a.volume = clamp(m.volume, 0, 1);
    const p = ve.refs.player;
    const pos = musicPosFor(p.currentTime || 0);
    if (pos == null) { if (!a.paused) a.pause(); return; }
    // Only re-seek when it has genuinely drifted; nudging every frame stutters.
    if (force || Math.abs((a.currentTime || 0) - pos) > 0.35) { try { a.currentTime = pos; } catch (e) {} }
    if (!p.paused) { if (a.paused) { const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); } }
    else if (!a.paused) a.pause();
  }

  /* ---- YouTube ---- */
  async function ytRefreshStatus() {
    let st = { available: false };
    try { st = await window.api.youtube.status(); } catch (e) {}
    ve.ytReady = !!st.available;
    const setup = $('#libYtSetup'), main = $('#libYtMain');
    if (setup) setup.classList.toggle('hidden', ve.ytReady);
    if (main) main.classList.toggle('hidden', !ve.ytReady);
  }
  async function ytInstall() {
    const jid = window.__newJobId();
    try {
      await window.__runJob('⬇️ Setting up YouTube support…', jid, () => window.api.youtube.install({ jobId: jid }));
      await ytRefreshStatus();
      window.__toast && window.__toast('✅ YouTube is ready — search for a track above.', 'good');
    } catch (e) {}
  }
  async function ytSearch() {
    const q = ($('#libYtQuery') || {}).value || '';
    if (!q.trim()) return;
    const free = (() => { const c = $('#libYtNoCopyright'); return !c || c.checked; })(); // safe by default
    const el = $('#libYtList'); if (el) el.innerHTML = '<p class="muted small lib-empty">Searching…</p>';
    let res = [];
    try { res = await window.api.youtube.search(q, 12, free); }
    catch (e) {
      if (el) el.innerHTML = `<p class="muted small lib-empty">⚠️ ${escape2(e.message || 'Search failed.')}</p>`;
      return;
    }
    if (!el) return;
    if (!res.length) { el.innerHTML = '<p class="muted small lib-empty">Nothing found — try different words.</p>'; return; }
    // Thumbnails are remote images and the app's CSP only allows local ones, so
    // results are text cards. The title/channel/length is what you pick on anyway.
    el.innerHTML = res.map((r) => `
      <div class="lib-row">
        <span class="lib-row-icon">▶️</span>
        <span class="lib-row-main">
          <b>${escape2(r.title)}</b>
          <span class="muted small">${escape2(r.uploader || 'YouTube')}${r.durationSec ? ' · ' + fmtDur(r.durationSec) : ''}${r.copyrightFree ? ' · <span class="lib-free-badge" title="The title or channel declares this track no-copyright / royalty-free">🛡️ Copyright-free</span>' : ''}</span>
        </span>
        <button class="primary-btn small" data-ytuse="${attr2(r.url)}" data-yttitle="${attr2(r.title)}">Use as music</button>
      </div>`).join('');
    $$('[data-ytuse]', el).forEach((b) => b.addEventListener('click', () => ytImport(b.dataset.ytuse, b.dataset.yttitle)));
  }
  async function ytImport(url, title) {
    const jid = window.__newJobId();
    try {
      const entry = await window.__runJob(`▶️ Getting the audio from "${(title || '').slice(0, 40)}"…`, jid,
        () => window.api.youtube.import({ url, title, jobId: jid }));
      await libRefresh();
      useMusic(entry.id);
      setLibTab('music');
    } catch (e) {}
  }

  /* ---- what happens on export ---- */
  /** Lay the music bed under a finished clip. Returns the new path (or the old one). */
  /**
   * The music bed that will go under THIS clip, and where in the song to start,
   * or null if none will. One predicate, two callers: the pass below, and the
   * chain the progress number is built from. Anything that answers "will this
   * pass run?" has to be asked identically by both, or the export would plan a
   * step it never takes and the number would stop short of the end.
   */
  function musicFor(s) {
    // The bed this export was started with — not whatever is loaded in the
    // 🎵 Music panel by the time a background export reaches this step.
    const m = F(s) ? F(s).music : ve.music;
    if (!m || !m.file) return null;
    if (m.bed || !s) return { m, startSec: 0 };
    const tl = m.tlStart || 0, len = m.len || m.durationSec || 0;
    if (tl + len <= s.start || tl >= s.end) return null;   // the song doesn't reach this clip
    return { m, startSec: Math.max(0, s.start - tl) + (m.srcStart || 0) };
  }
  /** The outro that will go on the end of THIS clip, or null. Same rule. */
  function outroFor(s) {
    const snap = F(s);
    const o = snap ? snap.outro : ve.outro;
    if (!o || !o.file || (snap ? snap.outroAll : ve.outroAll) === false) return null;
    return o;
  }

  async function mixMusicInto(s, filePath) {
    const pick = musicFor(s);
    if (!pick) return filePath;
    const { m, startSec } = pick;
    const jid = window.__newJobId();
    return window.__runJob(`🎵 Adding background music to "${(s && s.label) || 'your video'}"…`, jid,
      () => window.api.video.mixMusic({
        input: filePath, musicPath: m.file, musicVolume: m.volume, musicStartSec: startSec,
        fadeIn: m.fadeIn, fadeOut: m.fadeOut, duck: !!m.duck,
        jobId: jid, deleteInput: true, outName: outNameFor(filePath),
      }), J(s, 'music'));
  }
  /* ================= 🎙 VOICEOVER AND 🔊 SOUND EFFECTS =================
   *
   * CapCut's Audio → Voiceover and Audio → Sound effects, on a row of their
   * own (🔊 Sounds) under the music. Each sound sits at a moment of the
   * timeline (start, source time — like text), plays under the preview as the
   * playhead crosses it, and is mixed into every export that covers it, re-timed
   * onto the export's clock the same way text is (outTime).
   */
  function renderSoundTrack() {
    const tr = document.getElementById('veSfxTrack');
    if (!tr) return;
    tr.style.width = trackW() + 'px';
    const list = ve.sounds || [];
    tr.classList.toggle('has', !!list.length);
    if (!ve.video || !list.length) {
      tr.innerHTML = '<span class="muted small ve-lane-empty">🔊 No sounds — 🎙 Voiceover or 🔊 Sound FX adds one at the playhead.</span>';
      return;
    }
    tr.innerHTML = list.map((x) => {
      const sel = ve.soundSel === x.id;
      const w = Math.max(20, (x.dur || 1) * ve.pxPerSec);
      const vol = Math.round((x.volume == null ? 1 : x.volume) * 100);
      return `<div class="ve-sfx-clip ${x.kind === 'voice' ? 'voice' : 'fx'}${sel ? ' sel' : ''}" data-sid="${x.id}" style="left:${x.start * ve.pxPerSec}px;width:${w}px"
        title="${attr2(x.label)} at ${fmt(x.start)} — ${vol}% volume. Drag to move it.${sel ? ' ✕ removes it.' : ''}">
        <span class="ve-sfx-name">${x.kind === 'voice' ? '🎙' : '🔊'} ${escape2(x.label)}</span>${sel ? `<button type="button" class="ve-sfx-vol" data-svol="${x.id}" title="Volume — tap to change">${vol}%</button><button type="button" class="ve-sfx-x" data-sdel="${x.id}" title="Remove this sound">✕</button>` : ''}
      </div>`;
    }).join('');
  }

  function addSound({ path, label, kind, dur, volume, at }) {
    if (!ve.video || !path) return null;
    pushHistory();
    const start = Math.max(0, at != null ? at : (ve.refs.player ? ve.refs.player.currentTime || 0 : 0));
    const x = { id: uid(), path, label, kind, start, dur: Math.max(0.05, dur || 1), volume: volume == null ? 1 : volume };
    ve.sounds.push(x);
    ve.soundSel = x.id;
    renderSoundTrack();
    return x;
  }
  function removeSound(id) {
    if (!ve.sounds.some((x) => x.id === id)) return;
    pushHistory();
    ve.sounds = ve.sounds.filter((x) => x.id !== id);
    if (ve.soundSel === id) ve.soundSel = null;
    renderSoundTrack();
    syncSoundPreview();
  }
  const SOUND_VOLUMES = [1, 1.5, 2, 0.25, 0.5, 0.75];
  function cycleSoundVolume(id) {
    const x = ve.sounds.find((y) => y.id === id); if (!x) return;
    pushHistory();
    const cur = x.volume == null ? 1 : x.volume;
    const i = SOUND_VOLUMES.findIndex((v) => Math.abs(v - cur) < 0.01);
    x.volume = SOUND_VOLUMES[(i + 1) % SOUND_VOLUMES.length];
    renderSoundTrack();
    window.__toast && window.__toast(`${x.label}: ${Math.round(x.volume * 100)}% volume.`, 'good');
  }

  /* dragging a sound along its row (the touch bridge long-presses into this) */
  function wireSoundTrack() {
    const tr = document.getElementById('veSfxTrack');
    if (!tr || tr._wired) return;
    tr._wired = true;
    tr.addEventListener('click', (e) => {
      const del = e.target.closest('[data-sdel]');
      if (del) { e.stopPropagation(); return removeSound(del.dataset.sdel); }
      const vol = e.target.closest('[data-svol]');
      if (vol) { e.stopPropagation(); return cycleSoundVolume(vol.dataset.svol); }
    });
    tr.addEventListener('mousedown', (e) => {
      if (e.target.closest('[data-sdel],[data-svol]')) return;
      const el = e.target.closest('.ve-sfx-clip');
      if (!el) { if (ve.soundSel) { ve.soundSel = null; renderSoundTrack(); } return; }
      e.preventDefault(); e.stopPropagation();
      const x = ve.sounds.find((y) => y.id === el.dataset.sid); if (!x) return;
      const pre = snapshotState();
      const x0 = e.clientX, s0 = x.start;
      let moved = false;
      if (ve.soundSel !== x.id) { ve.soundSel = x.id; renderSoundTrack(); }
      const mv = (ev) => {
        const dt = (ev.clientX - x0) / ve.pxPerSec;
        if (!moved && Math.abs(ev.clientX - x0) < 3) return;
        moved = true;
        x.start = Math.max(0, Math.min(dur(), s0 + dt));
        const c = document.querySelector(`#veSfxTrack .ve-sfx-clip[data-sid="${x.id}"]`);
        if (c) c.style.left = (x.start * ve.pxPerSec) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        if (moved) { commitDragHistory(pre); renderSoundTrack(); }
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up, { once: true });
    });
  }

  /* the sounds under the preview, following the playhead */
  const soundEls = new Map();
  function syncSoundPreview() {
    const p = ve.refs.player;
    if (!p) return;
    const t = p.currentTime || 0, playing = !p.paused;
    const list = ve.sounds || [];
    for (const x of list) {
      let a = soundEls.get(x.id);
      if (!a || a._src !== x.path) {
        if (a) a.pause();
        a = new Audio(); a.preload = 'auto'; a._src = x.path; a.src = fileUrl(x.path);
        soundEls.set(x.id, a);
      }
      const inside = t >= x.start && t < x.start + x.dur;
      if (playing && inside) {
        const want = t - x.start;
        a.volume = Math.max(0, Math.min(1, x.volume == null ? 1 : x.volume));
        if (a.paused) { try { a.currentTime = want; } catch (e) {} a.play().catch(() => {}); }
        else if (Math.abs(a.currentTime - want) > 0.35) { try { a.currentTime = want; } catch (e) {} }
      } else if (!a.paused) a.pause();
    }
    for (const [id, a] of soundEls) if (!list.some((x) => x.id === id)) { a.pause(); soundEls.delete(id); }
  }

  /* ---- 🔊 Sound FX: a grid, tap to hear, ＋ to add at the playhead ---- */
  let sfxCatalog = null;
  async function openSfxPicker() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    let m = document.getElementById('veSfxModal');
    if (!m) {
      m = document.createElement('div');
      m.id = 'veSfxModal';
      m.className = 'cap-modal hidden';
      m.innerHTML = `<div class="cap-box ve-sfx-box">
        <div class="cap-head"><strong>🔊 Sound effects</strong><button type="button" class="ghost-btn small" data-sfx-close>✕</button></div>
        <p class="muted small ve-sfx-note">Tap one to hear it, ＋ to put it on the timeline at the playhead. Made by the studio — free to use anywhere.</p>
        <div class="ve-sfx-grid"></div></div>`;
      document.body.appendChild(m);
      m.addEventListener('click', async (e) => {
        if (e.target === m || e.target.closest('[data-sfx-close]')) { m.classList.add('hidden'); return; }
        const add = e.target.closest('[data-sfx-add]');
        const tile = e.target.closest('[data-sfx]');
        if (!tile) return;
        const kind = tile.dataset.sfx;
        tile.classList.add('busy');
        try {
          const r = await window.api.audio.sfx(kind);
          if (add) {
            addSound({ path: r.path, label: r.name, kind: 'fx', dur: r.durationSec, volume: 1 });
            m.classList.add('hidden');
            window.__toast && window.__toast(`🔊 ${r.name} added at ${fmt(ve.refs.player.currentTime || 0)}.`, 'good');
          } else {
            const a = new Audio(fileUrl(r.path)); a.play().catch(() => {});
          }
        } catch (er) { window.__toast && window.__toast('⚠️ ' + (er.message || er), 'error'); }
        finally { tile.classList.remove('busy'); }
      });
    }
    if (!sfxCatalog) {
      try { sfxCatalog = await window.api.audio.sfxList(); } catch (e) { sfxCatalog = []; }
    }
    m.querySelector('.ve-sfx-grid').innerHTML = (sfxCatalog || []).map((x) =>
      `<div class="ve-sfx-tile" data-sfx="${x.id}" role="button" tabindex="0"><span class="ve-sfx-wave"></span><span class="ve-sfx-tname">${escape2(x.name)}</span><span class="muted small">${x.durationSec.toFixed(1)}s</span><button type="button" class="ve-sfx-add" data-sfx-add title="Add at the playhead">＋</button></div>`).join('');
    m.classList.remove('hidden');
  }

  /* ---- 🎙 Voiceover: the microphone, while the video plays from the playhead ---- */
  const rec = { stream: null, recorder: null, chunks: [], startAt: 0, t0: 0, timer: null, wasMuted: false, meter: null, ctx: null };
  function voiceModal() {
    let m = document.getElementById('veVoiceModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'veVoiceModal';
    m.className = 'cap-modal hidden';
    m.innerHTML = `<div class="cap-box ve-voice-box">
      <div class="cap-head"><strong>🎙 Voiceover</strong><button type="button" class="ghost-btn small" data-vo-close>✕</button></div>
      <div class="ve-voice-body">
        <div class="ve-voice-time" data-vo-time>0:00</div>
        <div class="ve-voice-meter"><i data-vo-level></i></div>
        <button type="button" class="ve-voice-rec" data-vo-rec aria-label="Record"><span></span></button>
        <div class="ve-voice-msg muted small" data-vo-msg>Recording starts at the playhead (${'0:00'}). The video plays silently so you can speak over it.</div>
        <label class="ve-voice-opt"><input type="checkbox" data-vo-count checked> 3-second countdown</label>
      </div></div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-vo-close]')) return closeVoiceover();
      if (e.target.closest('[data-vo-rec]')) return rec.recorder ? stopVoiceover() : startVoiceover();
    });
    return m;
  }
  function openVoiceover() {
    if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || typeof MediaRecorder === 'undefined') {
      return window.__toast && window.__toast('⚠️ This browser cannot record from the microphone. On a phone, open the studio in Safari or Chrome over https.', 'error', 9000);
    }
    const m = voiceModal();
    m.querySelector('[data-vo-msg]').textContent = `Recording starts at the playhead (${fmt(ve.refs.player.currentTime || 0)}). The video plays silently so you can speak over it.`;
    m.querySelector('[data-vo-time]').textContent = '0:00';
    m.classList.remove('hidden');
  }
  function closeVoiceover() {
    if (rec.recorder) { rec.cancel = true; stopVoiceover(); }
    const m = document.getElementById('veVoiceModal'); if (m) m.classList.add('hidden');
  }
  async function startVoiceover() {
    const m = voiceModal();
    const msg = m.querySelector('[data-vo-msg]');
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      msg.textContent = '⚠️ The microphone was not allowed. Allow it for this site in the browser settings, then try again.';
      return;
    }
    // a level meter, so it is obvious the phone is hearing you
    try {
      rec.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = rec.ctx.createAnalyser(); an.fftSize = 512;
      rec.ctx.createMediaStreamSource(rec.stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const lvl = m.querySelector('[data-vo-level]');
      const draw = () => {
        if (!rec.stream) return;
        an.getByteTimeDomainData(buf);
        let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        lvl.style.width = Math.min(100, peak / 128 * 140) + '%';
        rec.meter = requestAnimationFrame(draw);
      };
      draw();
    } catch (e) { /* the meter is a nicety */ }
    if (m.querySelector('[data-vo-count]').checked) {
      for (const n of [3, 2, 1]) {
        if (!rec.stream) return;
        msg.textContent = `Recording in ${n}…`;
        m.querySelector('[data-vo-time]').textContent = String(n);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!rec.stream) return;
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    const type = types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
    rec.chunks = []; rec.cancel = false;
    rec.recorder = new MediaRecorder(rec.stream, type ? { mimeType: type } : undefined);
    rec.recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) rec.chunks.push(ev.data); };
    rec.recorder.onstop = () => finishVoiceover(type || rec.recorder.mimeType || '');
    const p = ve.refs.player;
    rec.startAt = p.currentTime || 0;
    ve._voiceMute = true;
    p.muted = true;
    rec.recorder.start(250);
    rec.t0 = Date.now();
    p.play().catch(() => {});
    m.querySelector('[data-vo-rec]').classList.add('on');
    msg.textContent = 'Recording… tap ■ to stop.';
    rec.timer = setInterval(() => { m.querySelector('[data-vo-time]').textContent = fmt((Date.now() - rec.t0) / 1000); }, 250);
  }
  function stopVoiceover() {
    const m = voiceModal();
    clearInterval(rec.timer); rec.timer = null;
    if (rec.meter) cancelAnimationFrame(rec.meter);
    try { if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) {}
    try { if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (rec.ctx) rec.ctx.close(); } catch (e) {}
    rec.stream = null; rec.ctx = null;
    const p = ve.refs.player; p.pause(); ve._voiceMute = false; updateGapMask(p.currentTime || 0);
    m.querySelector('[data-vo-rec]').classList.remove('on');
  }
  async function finishVoiceover(type) {
    const m = voiceModal();
    const chunks = rec.chunks; rec.chunks = []; rec.recorder = null;
    if (rec.cancel || !chunks.length) { rec.cancel = false; return; }
    const msg = m.querySelector('[data-vo-msg]');
    msg.textContent = 'Saving your voiceover…';
    try {
      const blob = new Blob(chunks, { type: type || 'audio/webm' });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const ext = /mp4|aac|m4a/.test(type) ? 'm4a' : /ogg/.test(type) ? 'ogg' : 'webm';
      const r = await window.api.audio.saveRecording({ bytes, ext });
      addSound({ path: r.path, label: 'Voiceover', kind: 'voice', dur: r.durationSec || (blob.size ? 1 : 0), volume: 1, at: rec.startAt });
      m.classList.add('hidden');
      window.__toast && window.__toast(`🎙 Voiceover added at ${fmt(rec.startAt)} (${fmt(r.durationSec || 0)}).`, 'good');
    } catch (e) {
      msg.textContent = '⚠️ ' + (e.message || e);
    }
  }

  /* ---- into the export: every sound this export covers, on its clock ---- */
  function soundsFor(s) {
    const snap = F(s);
    const list = (snap && snap.sounds) || ve.sounds || [];
    return list.filter((x) => x && x.path && x.start < s.end && x.start + (x.dur || 0) > s.start);
  }
  async function mixSoundsInto(s, filePath) {
    const list = soundsFor(s);
    if (!list.length) return filePath;
    const sounds = list.map((x) => {
      const from = Math.max(0, s.start - x.start);
      return { path: x.path, at: outTime(s, Math.max(s.start, x.start), 'start'), from, dur: Math.max(0.05, (x.dur || 0) - from), volume: x.volume == null ? 1 : x.volume };
    });
    const jid = window.__newJobId();
    return window.__runJob(`🔊 Adding ${sounds.length === 1 ? 'a sound' : sounds.length + ' sounds'} to "${(s && s.label) || 'your video'}"…`, jid,
      () => window.api.video.mixSounds({ input: filePath, sounds, jobId: jid, deleteInput: true, outName: outNameFor(filePath) }), J(s, 'sounds'));
  }
  /** Stick the chosen outro on the end. Returns the new path (or the old one). */
  async function appendOutroTo(s, filePath) {
    const snap = F(s);
    const o = outroFor(s);
    if (!o) return filePath;
    const jid = window.__newJobId();
    return window.__runJob(`🎬 Adding the "${o.name}" outro…`, jid,
      () => window.api.video.appendClips({
        // a photo carries how long to hold it; a video clip is its own length
        input: filePath, clips: [{ path: o.file, durationSec: o.still ? (o.durationSec || 4) : undefined }], position: 'end',
        // A 16:9 outro card (or a photo) on the end of a 9:16 short is exactly
        // where black bars look worst — give it the same fill the short uses.
        fill: snap ? snap.fill : fillCfg(),
        jobId: jid, deleteInput: true, outName: outNameFor(filePath),
      }), J(s, 'outro'));
  }
  /**
   * The last two steps of every export: music bed, then the outro on the end.
   * Music goes on FIRST so the bed covers the sermon only — the outro keeps its
   * own soundtrack — and because mixing music copies the video stream untouched
   * while appending has to re-encode, doing it in this order re-encodes once.
   */
  async function finishExport(s, filePath) {
    filePath = await mixSoundsInto(s, filePath);   // voiceovers and sound effects, on the export's clock
    filePath = await mixMusicInto(s, filePath);
    filePath = await appendOutroTo(s, filePath);
    return filePath;
  }

  /* ================= remove long pauses from the AI shorts =================
   * Reuses the clip `cuts` model wholesale: silencedetect says where the dead air
   * is, each range becomes a cut, and the existing close-the-gap export path
   * drops them and joins what's left into one continuous short. That means the
   * notches show on the timeline, the preview skips them, captions re-time
   * themselves, and Ctrl+Z puts them back — all for free.
   */
  const removePausesOn = () => { const c = $('#veRemovePauses'); return !!(c && c.checked); };
  /*
   * ☁️ BY THE WORDS, OR 🔉 BY SILENCE. The words are the default whenever the
   * free Groq key is there: measured on a real sermon, silence-below-32-dB cut
   * into 3 spoken words in one 90 s stretch and missed 2.6 s, 2.4 s and 0.9 s
   * pauses in another, because a hall is never silent. See src/main/pauses.js.
   */
  const PAUSE_HOW_KEY = 'mw-ve-pausehow';
  function pauseHow() {
    const sel = $('#vePauseHow');
    return sel ? sel.value : 'cloud';
  }
  function loadPauseHow() {
    const sel = $('#vePauseHow'); if (!sel) return;
    let v = null;
    try { v = localStorage.getItem(PAUSE_HOW_KEY); } catch (e) {}
    sel.value = v === 'silence' ? 'silence' : 'cloud';
    if (!sel._wired) {
      sel._wired = true;
      sel.addEventListener('change', () => {
        try { localStorage.setItem(PAUSE_HOW_KEY, sel.value); } catch (e) {}
        window.__toast && window.__toast(sel.value === 'cloud'
          ? '🤫 Pauses will be found by the WORDS — Groq’s free cloud Whisper hears where the speech is, so a quiet word is never cut and pauses in a noisy hall are still found.'
          : '🤫 Pauses will be found by SILENCE on this PC — works offline, but can miss pauses in a noisy room.', 'good', 7000);
      });
    }
  }
  /* Words heard while finding pauses are kept for a while, so captioning the
   * same clip next costs nothing: same request, same answer. */
  const capWordsCacheKey = (s) => `${ve.video ? ve.video.path : ''}|${(+s.start).toFixed(2)}|${(+s.end).toFixed(2)}`;
  function cachedCloudWords(s) {
    const c = ve._cloudWords && ve._cloudWords.get(capWordsCacheKey(s));
    if (!c || Date.now() - c.at > 30 * 60e3) return null;
    return c.res;
  }

  /** The scan's own words for this short, while it is still the range the scan heard. */
  function scanWordsFor(s) {
    const k = ve._scanWords && ve._scanWords.get(s.id);
    return k && Math.abs(k.start - s.start) < 0.05 && Math.abs(k.end - s.end) < 0.05 ? k.words : undefined;
  }
  async function removePausesIn(clips, { quiet } = {}) {
    const list = (clips || []).filter((s) => s && !s.seed && (s.lane || 0) === 0);
    if (!list.length || !ve.video) return { clips: 0, removed: 0 };
    let touched = 0, removed = 0, byWords = 0, bySilence = 0, why = '';
    let useCloud = pauseHow() === 'cloud' && !!(window.api.video && window.api.video.speechPauses);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (window.__setJobBatch) window.__setJobBatch(i + 1, list.length);
      let res = null;
      if (useCloud) {
        const jid = window.__newJobId();
        try {
          res = await window.__runJob(`☁️ Listening for pauses in "${s.label}" (by the words)…`, jid,
            () => window.api.video.speechPauses({
              input: ve.video.path, startSec: s.start, endSec: s.end, minSilenceSec: 0.7, padSec: 0.12, jobId: jid,
              words: scanWordsFor(s),
            }));
        } catch (e) {
          if (e && e.cancelled) break;
          res = { fallback: true, why: (e && e.message) || 'it failed' };
        }
        if (res && res.fallback) {
          // No key, no internet, allowance gone: the rest of the sweep uses
          // silence rather than asking (and failing) once per clip.
          why = res.why || why;
          useCloud = false;
          res = null;
        } else if (res && res.transcript) {
          if (!ve._cloudWords) ve._cloudWords = new Map();
          ve._cloudWords.set(capWordsCacheKey(s), { at: Date.now(), res: res.transcript });
          byWords++;
        }
      }
      if (!res) {
        const jid = window.__newJobId();
        try {
          res = await window.__runJob(`🤫 Listening for pauses in "${s.label}"…`, jid,
            () => window.api.video.detectSilence({
              input: ve.video.path, startSec: s.start, endSec: s.end,
              noiseDb: -32, minSilenceSec: 0.7, padSec: 0.12, jobId: jid,
            }));
          bySilence++;
        } catch (e) {
          if (e && e.cancelled) break;  // Cancel means stop the whole sweep, not skip one clip
          continue;                      // a clip we couldn't analyse just keeps its pauses
        }
      }
      // Anything under a quarter-second isn't a pause, it's punctuation — cutting
      // those makes the speech sound clipped and unnatural.
      const cuts = ((res && res.silences) || []).filter((c) => c.end - c.start >= 0.25);
      if (!cuts.length) continue;
      s.cuts = cuts;
      touched++;
      removed += cuts.reduce((a, c) => a + (c.end - c.start), 0);
    }
    if (window.__setJobBatch) window.__setJobBatch(null);
    renderSegments(); renderClipList();
    if (!quiet) {
      const how = byWords && !bySilence ? ' (found by the words — ☁️ Groq)' : '';
      window.__toast && window.__toast(touched
        ? `🤫 Took ${removed.toFixed(1)}s of pauses out of ${touched} clip${touched > 1 ? 's' : ''}${how} — they export as one tight short each. Ctrl+Z puts them back.`
        : 'No long pauses found in those clips — they were already tight.', 'good', 7000);
      // Said out loud: the operator chose the words and got silence.
      if (bySilence && pauseHow() === 'cloud' && why) {
        window.__toast && window.__toast(`☁️ Pauses were found by silence on this PC instead of by the words — ${why}.`, 'error', 9000);
      }
    }
    return { clips: touched, removed, byWords, bySilence, why };
  }

  /* ---------------- init ---------------- */
  function wire() {
    const openFn = async () => {
      try {
        const p = await window.api.dialog.openFile([{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv'] }]);
        if (p) loadVideo(p);
      } catch (err) {
        window.__toast && window.__toast('⚠️ ' + (err.message || 'Failed to open file'), 'error');
      }
    };
    const veOpenBtn = $('#veOpen');
    const veOpenBtn2 = $('#veOpen2');
    if (veOpenBtn) veOpenBtn.addEventListener('click', openFn);
    if (veOpenBtn2) veOpenBtn2.addEventListener('click', openFn);
    $('#veFindHighlights').addEventListener('click', findHighlights);
    // 🎙 Voiceover and 🔊 Sound FX, and the row they land on
    const voBtn = $('#veVoiceover'); if (voBtn) voBtn.addEventListener('click', openVoiceover);
    const sfxBtn = $('#veSfxBtn'); if (sfxBtn) sfxBtn.addEventListener('click', openSfxPicker);
    wireSoundTrack();
    const capShortsBtn = $('#veCapShorts'); if (capShortsBtn) capShortsBtn.addEventListener('click', captionAllShorts);
    $('#veExportEdited').addEventListener('click', exportEditedVideo);
    $('#veExportAll').addEventListener('click', exportAll);
    $('#vePlay').addEventListener('click', togglePlay);
    $('#veAddClip').addEventListener('click', () => { if (!ve.video) return; pushHistory(); const t = ve.refs.player.currentTime || 0; addSegment(t, Math.min(dur(), t + 30), 'Clip ' + (ve.segments.length + 1), false); });
    $('#veSplit').addEventListener('click', () => splitAtPlayhead());
    const gapBtn = $('#veCloseGap');
    if (gapBtn) gapBtn.addEventListener('click', () => closeGapAfter());
    const ovBtn = $('#veOverlay'); if (ovBtn) ovBtn.addEventListener('click', toggleOverlayLane);
    const addMediaBtn = $('#veAddMedia'); if (addMediaBtn) addMediaBtn.addEventListener('click', pickMediaOverlays);
    // 📦 the batch: many videos, one graphic over all of them
    const bulkBtn = $('#veBulk'); if (bulkBtn) bulkBtn.addEventListener('click', pickBulkVideos);
    const bulkMore = $('#veBulkAddMore'); if (bulkMore) bulkMore.addEventListener('click', pickBulkVideos);
    const bulkImg = $('#veBulkAddImage'); if (bulkImg) bulkImg.addEventListener('click', pickBulkImage);
    const bulkExp = $('#veBulkExport'); if (bulkExp) bulkExp.addEventListener('click', exportBulk);
    const bulkClr = $('#veBulkClear'); if (bulkClr) bulkClr.addEventListener('click', () => {
      if (!ve.bulk.files.length) return;
      clearBulk();
      window.__toast && window.__toast('📦 Batch emptied — the files themselves are untouched.', '');
    });
    /* Dropping ON the panel is the obvious gesture once the panel exists: videos
     * join the batch, a picture becomes the thing that goes over all of them. */
    const bulkBox = $('#veBulkBox');
    if (bulkBox) {
      ['dragenter', 'dragover'].forEach((ev) => bulkBox.addEventListener(ev, (e) => {
        e.preventDefault(); bulkBox.classList.add('drag');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }));
      ['dragleave', 'drop'].forEach((ev) => bulkBox.addEventListener(ev, () => bulkBox.classList.remove('drag')));
      bulkBox.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation();
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => f.path).filter(Boolean);
        if (!files.length) return;
        const imgs = files.filter(isImgPath), vids = files.filter((p) => !isImgPath(p));
        if (vids.length) await addBulkVideos(vids);
        for (const p of imgs) await addBulkImage(p);
      });
    }
    const ovSndBtn = $('#veOvSound'); if (ovSndBtn) ovSndBtn.addEventListener('click', () => toggleOverlaySound());
    const cutBtn = $('#veCutOut'); if (cutBtn) cutBtn.addEventListener('click', () => cutOutOverlayBackground());
    const keyBtn = $('#veChromaKey'); if (keyBtn) keyBtn.addEventListener('click', () => openChromaKey());
    const kfBtn = $('#veKeyframes'); if (kfBtn) kfBtn.addEventListener('click', () => openKeyframes());
    if (window.CutOut && window.CutOut.wire) window.CutOut.wire();
    const studioBtn = $('#veStudioSound'); if (studioBtn) { studioBtn.addEventListener('click', toggleStudioSound); updateStudioSoundButton(); }
    const ovGuide = $('#veOverlayGuide'); if (ovGuide) ovGuide.addEventListener('mousedown', onOverlayGuideDown);
    const snapBtn = $('#veSnap'); if (snapBtn) snapBtn.addEventListener('click', toggleSnap);
    // captions timeline: open the style modal, or export the video with the
    // on-timeline captions burned in
    const capStyleBtn = $('#veCapStyle'); if (capStyleBtn) capStyleBtn.addEventListener('click', () => {
      if (!capBlocksVisible()) return;
      openCaptionsForShort(null);   // the whole lane — commits any half-typed line first
    });
    const saveCapsBtn = $('#veSaveCaps'); if (saveCapsBtn) saveCapsBtn.addEventListener('click', () => { if (capBlocksVisible()) { commitCapEdit(); burnCaps(); } });
    const clearCapsBtn = $('#veClearCaps'); if (clearCapsBtn) clearCapsBtn.addEventListener('click', clearAllCaptions);
    // preview size
    const bigBtn = $('#veBigger'); if (bigBtn) bigBtn.addEventListener('click', () => setPreviewBig(!isPreviewBig()));
    const fullBtn = $('#veFull'); if (fullBtn) fullBtn.addEventListener('click', togglePreviewFull);
    const fsExit = $('#veFsExit'); if (fsExit) fsExit.addEventListener('click', togglePreviewFull);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    const followBtn = $('#veFollow'); if (followBtn) followBtn.addEventListener('click', () => setFollow(!ve.follow));
    // text-style toolbar (font / size / colour / bold / delete)
    const vtFont = $('#vtFont');
    if (vtFont) {
      vtFont.addEventListener('change', () => {
        applyTextProp((o) => { o.font = vtFont.value; });
        // the closed dropdown wears the chosen face too, like the caption picker
        vtFont.style.fontFamily = `'${String(vtFont.value).replace(/['"\\;{}]/g, '')}', system-ui, sans-serif`;
      });
    }
    const vtSize = $('#vtSize'); if (vtSize) vtSize.addEventListener('change', () => {
      // Down to 1, and in half-pixel steps: on a short preview the frame is only
      // a couple of hundred pixels tall, so 8 was already a heading and there was
      // no way to ask for a small caption-sized line at all.
      const px = clamp(parseFloat(vtSize.value) || 22, 1, 300);
      applyTextProp((o) => { o.sizePct = px / previewH(); });
    });
    const vtColor = $('#vtColor'); if (vtColor) vtColor.addEventListener('change', () => applyTextProp((o) => { o.color = vtColor.value; }));
    const vtBold = $('#vtBold'); if (vtBold) vtBold.addEventListener('click', () => applyTextProp((o) => { o.bold = !o.bold; }));
    const vtBg = $('#vtBg'); if (vtBg) vtBg.addEventListener('click', () => applyTextProp((o) => { o.bg = !o.bg; }));
    const vtBgColor = $('#vtBgColor');
    if (vtBgColor) vtBgColor.addEventListener('change', () => applyTextProp((o) => { o.bg = true; o.bgColor = vtBgColor.value; }));
    const vtOl = $('#vtOutline');
    if (vtOl) vtOl.addEventListener('click', () => applyTextProp((o) => {
      o.outline = !o.outline;
      if (!o.outlineColor) o.outlineColor = '#000000';
    }));
    const vtDelete = $('#vtDelete'); if (vtDelete) vtDelete.addEventListener('click', () => { if (ve.textSel) removeTextOverlay(ve.textSel); });
    const vtAnim = $('#vtAnim'); if (vtAnim) vtAnim.addEventListener('change', () => { if (ve.textSel) setTextAnim(ve.textSel, vtAnim.value); });
    // Clicking anywhere on the preview OUTSIDE a text box deselects the text:
    // commits any in-progress edit, hides the style toolbar, drops the drag border.
    ve.refs.preview.addEventListener('mousedown', (e) => {
      if (!ve.textSel) return;
      if (e.target.closest('.ve-text-box') || e.target.closest('#veTextTools')) return;
      const editing = ve.textEditing && ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${ve.textEditing}"] .ve-text-content`);
      if (editing) editing.blur(); // commit the typed text first
      ve.textSel = null; ve.textEditing = null;
      renderTextOverlays(); renderTextTrack(); updateTextTools();
    });
    const zoomIn = $('#veZoomIn'); if (zoomIn) zoomIn.addEventListener('click', () => zoomBy(1.5));
    const zoomOut = $('#veZoomOut'); if (zoomOut) zoomOut.addEventListener('click', () => zoomBy(1 / 1.5));
    const zoomFit = $('#veZoomFit'); if (zoomFit) zoomFit.addEventListener('click', fitZoom);
    $('#veUndo').addEventListener('click', undoVideo);
    $('#veRedo').addEventListener('click', redoVideo);
    $('#veDupClip').addEventListener('click', () => duplicateSeg());
    $('#veDelClip').addEventListener('click', () => {
      if (ve.activeRow === 'audio' && ve.audioSel) removeAudioSeg(ve.audioSel);
      else if (ve.sel) {
        const s = ve.segments.find((x) => x.id === ve.sel);
        const media = s && isMedia(s) ? s.label : null;
        removeSeg(ve.sel);
        if (media) window.__toast && window.__toast(`Took “${media}” off the video. Ctrl+Z puts it back.`, 'good');
      }
    });
    $('#veBack5').addEventListener('click', () => seekTo((ve.refs.player.currentTime || 0) - 5));
    $('#veFwd5').addEventListener('click', () => seekTo((ve.refs.player.currentTime || 0) + 5));
    $('#veZoom').addEventListener('input', (e) => {
      ve.pxPerSec = clamp(parseFloat(e.target.value) || 4, 0.15, 200);
      renderRuler(); renderSegments(); updatePlayhead();
    });
    $('#veCapShow').addEventListener('change', () => updateCapOverlay(ve.refs.player.currentTime || 0));
    const bgBox = $('#veBgExport');
    if (bgBox) bgBox.addEventListener('change', () => {
      try { localStorage.setItem('mwBgExport', bgBox.checked ? '1' : '0'); } catch (e) {}
      if (bgBox.checked) {
        window.__toast && window.__toast(`⇥ Exports now go straight to ${bgPlace()}. Carry on working while they finish — `
          + 'each one saves the timeline exactly as it was when you pressed export.', 'good', 8000);
      }
    });
    $('#veAspect').addEventListener('change', (e) => { ve.aspect = e.target.value; updateCropMask(); });
    $('#veAutoReframe').addEventListener('change', () => {
      if ($('#veAutoReframe').checked && !window.FaceTrack) window.__toast && window.__toast('Face tracking module failed to load — will use a centered crop.', 'error');
      resetLiveTrack(); updateCropMask();   // reset the live guide when toggled
      renderFollowRow();                    // "who to follow" only means anything while reframing
    });
    wireReframeAi();
    // hiding captions that came burned into the recording
    const coverBox = $('#veCover');
    if (coverBox) coverBox.addEventListener('change', () => setCover({ on: coverBox.checked }));
    const coverMode = $('#veCoverMode');
    if (coverMode) coverMode.addEventListener('change', () => setCover({ mode: coverMode.value }));
    const coverY = $('#veCoverY');
    if (coverY) coverY.addEventListener('input', () => setCover({ y: (parseFloat(coverY.value) || 0) / 100 }));
    const coverH = $('#veCoverH');
    if (coverH) coverH.addEventListener('input', () => setCover({ h: (parseFloat(coverH.value) || 0) / 100 }));

    // frame fill (background blur) + background-noise removal
    const fillSel = $('#veFill'); if (fillSel) fillSel.addEventListener('change', () => setFillMode(fillSel.value));
    const fillStr = $('#veFillStrength');
    if (fillStr) fillStr.addEventListener('input', () => {
      ve.fill.strength = clamp((parseFloat(fillStr.value) || 0) / 100, 0, 1);
      saveExportPrefs(); syncExportPrefUi(); updateCropMask();
    });
    const fillDim = $('#veFillDim');
    if (fillDim) fillDim.addEventListener('input', () => {
      ve.fill.dim = clamp((parseFloat(fillDim.value) || 0) / 100, 0, 1);
      saveExportPrefs(); syncExportPrefUi(); updateCropMask();
    });
    const dnBox = $('#veDenoise');
    if (dnBox) dnBox.addEventListener('change', () => { ve.denoise.on = dnBox.checked; saveExportPrefs(); syncExportPrefUi(); });
    const dnLev = $('#veDenoiseLevel');
    if (dnLev) dnLev.addEventListener('change', () => { ve.denoise.level = dnLev.value; saveExportPrefs(); syncExportPrefUi(); });
    const dnTest = $('#veDenoiseTest'); if (dnTest) dnTest.addEventListener('click', hearDenoise);
    const feIn = $('#veFadeIn');
    if (feIn) feIn.addEventListener('input', () => {
      ve.fade.in = clamp(parseFloat(feIn.value) || 0, 0, 5);
      saveExportPrefs(); syncExportPrefUi();
    });
    const feOut = $('#veFadeOut');
    if (feOut) feOut.addEventListener('input', () => {
      ve.fade.out = clamp(parseFloat(feOut.value) || 0, 0, 5);
      saveExportPrefs(); syncExportPrefUi();
    });
    const capModelSel = $('#veCapModel');
    if (capModelSel) capModelSel.addEventListener('change', () => {
      // Same setting as the Accuracy panel in the captions window — keep both
      // showing the same answer.
      ve.capModel = capModelSel.value; saveExportPrefs(); updateCapModelRmBtn(); renderCapModels();
    });
    const capModelRm = $('#veCapModelRm');
    if (capModelRm) capModelRm.addEventListener('click', () => { if (ve.capModel) rmCapModel(ve.capModel); });
    loadExportPrefs();
    loadPauseHow();
    renderFollowRow();
    populateCapModelSelect();

    startLiveReframeLoop();
    startLiveRenderLoop();
    window.addEventListener('resize', () => { if ($('#view-video').classList.contains('active')) updateCropMask(); });
    $$('#view-video [data-vtool]').forEach((b) => b.addEventListener('click', () => moreTool(b.dataset.vtool)));

    // auto-captions
    const capBtn = $('#veAutoCaptions'); if (capBtn) capBtn.addEventListener('click', openCaptions);
    renderCapModels();
    // the Word Book — the words this church's captions keep getting wrong
    const wbOpenBtn = $('#capWordBook'); if (wbOpenBtn) wbOpenBtn.addEventListener('click', () => showWordBook(true));
    const wbCloseBtn = $('#capWbClose'); if (wbCloseBtn) wbCloseBtn.addEventListener('click', () => showWordBook(false));
    const wbFixNow = $('#capFixNow'); if (wbFixNow) wbFixNow.addEventListener('click', fixCaptionsFromBook);
    const wbApply = $('#capWbApply'); if (wbApply) wbApply.addEventListener('click', () => { showWordBook(false); fixCaptionsFromBook(); });
    const wbTidy = $('#capWbTidy'); if (wbTidy) wbTidy.addEventListener('click', wbTidyUp);
    const wbAddBtn = $('#capWbAdd'); if (wbAddBtn) wbAddBtn.addEventListener('click', wbAddFix);
    const wbAddTermBtn = $('#capWbAddTerm'); if (wbAddTermBtn) wbAddTermBtn.addEventListener('click', wbAddTerm);
    ['#capWbFrom', '#capWbTo'].forEach((sel) => {
      const el = $(sel); if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wbAddFix(); } });
    });
    const wbTermIn = $('#capWbTerm');
    if (wbTermIn) wbTermIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wbAddTerm(); } });
    const wbOnBox = $('#capWbOn'); if (wbOnBox) wbOnBox.addEventListener('change', () => wbSetOption({ enabled: wbOnBox.checked }));
    const wbSoundBox = $('#capWbSound'); if (wbSoundBox) wbSoundBox.addEventListener('change', () => wbSetOption({ soundAlike: wbSoundBox.checked }));
    $('#capClose').addEventListener('click', closeCapModal);
    { const cu = $('#capUndo'), cr = $('#capRedo');
      if (cu) cu.addEventListener('click', () => { commitCapEdit(); undoVideo(); });
      if (cr) cr.addEventListener('click', () => { commitCapEdit(); redoVideo(); }); }
    $('#capCancel').addEventListener('click', closeCapModal);
    $('#capBurn').addEventListener('click', burnCaps);
    wireCapPlayerAndGrammar();
    wirePro();
    $('#capWords').addEventListener('change', () => rebuildCapEvents());
    $('#capCase').addEventListener('change', () => rebuildCapEvents({ caseOnly: true }));
    // Once the box has been clicked it holds its own answer, instead of being
    // reset by the next look the operator tries on.
    //
    // This listener MUST be added before the overlay's (below). Listeners run in
    // the order they were added, and the overlay's redraw reads the box through
    // capWordHlOn — which, until the box is marked touched, puts it back to the
    // look's own answer. Added after, the first tick was undone on the spot:
    // "Follow the voice" took two clicks to switch on.
    const capWordHl = $('#capWordHl');
    if (capWordHl) capWordHl.addEventListener('change', () => {
      capWordHl.dataset.touched = '1';
      // Show the swatch straight away. It used to appear only when the caption
      // overlay next redrew, which needs a video open — so ticking the box in a
      // fresh window did nothing visible at all.
      const row = document.getElementById('capWordColorRow');
      if (row) row.classList.toggle('hidden', !capWordHl.checked);
    });
    // Style tweaks update the live overlay immediately.
    ['#capFont', '#capSize', '#capSizePct', '#capTracking', '#capPos', '#capColor', '#capStyleSel', '#capWordHl', '#capWordColor'].forEach((sel) => {
      const el = $(sel); if (el) el.addEventListener('change', () => updateCapOverlay(ve.refs.player.currentTime || 0));
    });
    // The typography controls are folded away until asked for — see the note in
    // the markup. The button says which way it is.
    const capFine = $('#capFine'), capFineWrap = $('#capFineWrap');
    if (capFine && capFineWrap) capFine.addEventListener('click', () => {
      const open = capFineWrap.classList.toggle('hidden') === false;
      capFine.classList.toggle('on', open);
      capFine.title = open ? 'Hide the exact size and letter spacing'
        : 'Caption size and letter spacing to the decimal, for matching another look exactly.';
    });
    const capWordColor = $('#capWordColor');
    if (capWordColor) capWordColor.addEventListener('input', () => updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0));
    // Picking Top/Centre/Bottom again is how you undo a drag.
    const capPosSel = $('#capPos');
    if (capPosSel) capPosSel.addEventListener('change', () => {
      ve.capPos = null;
      saveCapLook();
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    });
    /* How wide the words may run before they wrap — the same number the drag
     * handles on the preview change, so the slider and the handles are two ways
     * of turning one knob and always agree. */
    const capWidthSel = $('#capWidth');
    if (capWidthSel) {
      const syncW = (save) => {
        ve.capWidth = clamp((parseInt(capWidthSel.value, 10) || 86) / 100,
          window.CapLayout.MIN_WIDTH, window.CapLayout.MAX_WIDTH);
        const out = $('#capWidthV');
        if (out) out.textContent = Math.round(ve.capWidth * 100) + '%';
        updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
        if (out && ve._capLayout) out.textContent = `${Math.round(ve.capWidth * 100)}% · ${ve._capLayout.lines.length} line${ve._capLayout.lines.length > 1 ? 's' : ''}`;
        if (save) saveCapLook();
      };
      capWidthSel.addEventListener('input', () => syncW(false));
      capWidthSel.addEventListener('change', () => syncW(true));
      syncCapWidthControl = () => {
        capWidthSel.value = String(Math.round(window.CapLayout.widthFrac({ width: ve.capWidth }) * 100));
        const out = $('#capWidthV');
        if (out) out.textContent = capWidthSel.value + '%';
      };
      syncCapWidthControl();
    }
    // The visual style picker. The old <select> stays in the DOM (hidden) as the
    // saved value, so anything that reads or sets it keeps working.
    const styleSel = $('#capStyleSel');
    if (styleSel) {
      styleSel.innerHTML = CAP_STYLES.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
      styleSel.addEventListener('change', () => setCapStyle(styleSel.value));
    }
    applySavedCapStyle();
    const styleChip = $('#capStyleSample');
    if (styleChip) styleChip.addEventListener('click', () => showCapStylePicker(true));
    const stylePickClose = $('#capStylePickerClose');
    if (stylePickClose) stylePickClose.addEventListener('click', () => showCapStylePicker(false));
    // The "any colour you like" looks follow the swatch, so repaint their cards.
    const capColor = $('#capColor'); if (capColor) capColor.addEventListener('input', () => { renderCapStyleGrid(); renderCapStyleStrip(); });
    // 🎞️ frame rate and 📶 bitrate, beside the size
    const fpsSel = $('#veFps');
    if (fpsSel) {
      fpsSel.value = String(ve.fps || 0);
      fpsSel.addEventListener('change', () => {
        ve.fps = Number(fpsSel.value) || 0;
        ve._exportPrefsPulled = true;   // an explicit choice always goes through
        saveExportPrefs();
        window.__toast && window.__toast(ve.fps ? `Exports will be ${ve.fps} frames a second.` : 'Exports will keep the recording\'s own frame rate.', 'good');
      });
    }
    const rateSel = $('#veBitrate');
    if (rateSel) {
      rateSel.value = ve.bitrate || 'recommended';
      rateSel.addEventListener('change', () => {
        ve.bitrate = rateSel.value;
        ve._exportPrefsPulled = true;
        saveExportPrefs();
        window.__toast && window.__toast(`Bitrate: ${rateSel.options[rateSel.selectedIndex].text}.`, 'good');
      });
    }
    pullExportPrefs();
    const qSel = $('#veQuality');
    if (qSel) {
      qSel.value = ve.quality;
      qSel.addEventListener('change', () => {
        ve.quality = qSel.value;
        saveExportPrefs && saveExportPrefs();
        updateEditedExportHint();
        const label = qSel.options[qSel.selectedIndex].text.replace(/^\W+\s*/, '');
        window.__toast && window.__toast(`Exports will be ${label}.` + upscaleWarning(), 'good', 7000);
      });
    }
    $('#capPreview').addEventListener('click', () => {
      closeCapModal();
      const evs = ve.capEvents || [];
      if (!evs.length) return;
      const cc = $('#veCapShow'); if (cc) cc.checked = true;
      seekTo((ve.capOffset || 0) + Math.max(0, evs[0].start));
      const pr = ve.refs.player.play(); if (pr && pr.catch) pr.catch(() => {});
      window.__toast && window.__toast('👁 Captions are now live on the preview — tweak them any time via 💬 Auto-captions.', 'good');
    });
    // Every caption face is loaded into the page first, so the picker can show
    // each name IN that face. Bebas Neue stays the default — tall, condensed and
    // all-caps by design, which is the shorts look.
    loadCapFonts().then(() => {
      renderCapFontPicker();
      const want = [DEFAULT_CAP_FONT, 'Anton'].find((f) => CAP_FONTS.some((x) => x.name === f));
      if (want) $('#capFont').value = want;
      renderCapFontPicker();
      renderTextFontPicker();   // 🔤 Add text gets the same typefaces
      renderCapStyleGrid();
      renderCapStyleStrip();
      // Captions measured before the faces arrived were measured against Arial —
      // throw those answers away and redraw, or the first preview keeps a set of
      // line breaks the export will not agree with.
      window.CapLayout.forgetMeasurements();
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    }).catch(() => {});
    renderCapTransPicker();
    // Changing the face repaints every sample, including the closed dropdown.
    $('#capFont').addEventListener('change', () => {
      renderCapFontPicker(); renderCapStyleGrid(); renderCapStyleStrip();
      updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
    });
    const transSel = $('#capTrans');
    if (transSel) {
      transSel.addEventListener('change', () => {
        // Show it immediately on the preview rather than only in the exported file.
        ve._capTransPreview = 0;
        updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
        window.__toast && window.__toast(
          transSel.value === 'none'
            ? 'Caption lines will simply appear.'
            : `Caption lines will “${transSel.options[transSel.selectedIndex].text}” onto the screen.`, 'good');
      });
    }
    const stripMore = $('#capStyleMore');
    if (stripMore) stripMore.addEventListener('click', () => showCapStylePicker(true));

    // adjust & effects — live preview on the <video> as you tweak (approximate; ffmpeg does the real export)
    const fxBtn = $('#veEffects'); if (fxBtn) fxBtn.addEventListener('click', () => {
      if (!ve.video) return window.__toast && window.__toast('Open a video first.', 'error');
      $('#fxModal').classList.remove('hidden'); updateFxPreview();
    });
    $('#fxClose').addEventListener('click', () => { $('#fxModal').classList.add('hidden'); resetFxPreview(); });
    $('#fxCancel').addEventListener('click', () => { $('#fxModal').classList.add('hidden'); resetFxPreview(); });
    $('#fxApply').addEventListener('click', applyFx);
    $('#fxVol').addEventListener('input', () => { $('#fxVolV').textContent = Math.round($('#fxVol').value * 100) + '%'; updateFxPreview(); });
    ['#fxSpeed', '#fxLook', '#fxBri', '#fxCon', '#fxSat', '#fxSharp', '#fxRot', '#fxFlipH', '#fxFlipV'].forEach((sel) => {
      const el = $(sel); if (el) el.addEventListener('input', updateFxPreview);
    });
    $$('.fx-speed-presets button').forEach((b) => b.addEventListener('click', () => { $('#fxSpeed').value = b.dataset.speed; updateFxPreview(); }));
    $('#fxMusic').addEventListener('click', async () => {
      try {
        const p = await window.api.dialog.openFile([{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]);
        if (p) { ve.fxMusic = p; $('#fxMusicName').textContent = p.split(/[\\/]/).pop(); }
      } catch (err) { window.__toast && window.__toast('⚠️ Could not open audio: ' + (err.message || 'Unknown error'), 'error'); }
    });

    // manual pan/zoom crop (drag to pan, scroll to zoom, ↺ to reset)
    $('#veCropFrame').addEventListener('mousedown', onCropDown);
    $('#veCropReset').addEventListener('click', (e) => { e.stopPropagation(); resetCrop(); });
    ve.refs.preview.addEventListener('wheel', onCropWheel, { passive: false });

    // text-on-video overlays (burned into every exported clip automatically)
    $('#veAddText').addEventListener('click', addTextOverlay);
    const tplBtn = $('#veTextTpl'); if (tplBtn) tplBtn.addEventListener('click', openTextTemplates);

    /* ---- media library: background music + outro clips ---- */
    const musicBtn = $('#veMusic'); if (musicBtn) musicBtn.addEventListener('click', () => openLibrary('music'));
    // Ctrl+S is what everybody's hands already do. Only while the studio is the
    // view on screen, and never while a text box has the caret.
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's' || e.shiftKey || e.altKey) return;
      if (!document.getElementById('view-video').classList.contains('active')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      saveSession(false);
    });
    const clipsBtn = $("#veClips"); if (clipsBtn) clipsBtn.addEventListener('click', () => openLibrary('clips'));
    const thumbCloseBtn = $('#thumbClose'); if (thumbCloseBtn) thumbCloseBtn.addEventListener('click', closeThumbPicker);
    const thumbModalEl = $('#thumbModal'); if (thumbModalEl) thumbModalEl.addEventListener('click', (e) => { if (e.target === thumbModalEl) closeThumbPicker(); });
    const thumbSlider = $('#thumbAt');
    if (thumbSlider) thumbSlider.addEventListener('input', () => {
      const sg = thumbSeg(); if (!sg) return;
      setThumbAt(sg.start + ((parseFloat(thumbSlider.value) || 0) / 1000) * Math.max(0.1, sg.end - sg.start));
      if (ve._thumbTimer) clearTimeout(ve._thumbTimer);
      ve._thumbTimer = setTimeout(showThumbFrame, 140);   // scrubbing must not seek on every pixel
    });
    const thumbUseBtn = $('#thumbUse');
    if (thumbUseBtn) thumbUseBtn.addEventListener('click', () => {
      const sg = thumbSeg(); if (!sg) return;
      setClipThumb(sg, { at: ve._thumbAt });
      closeThumbPicker();
      window.__toast && window.__toast('🖼️ That frame is this short\'s thumbnail. It is written beside the file when you export.', 'good', 7000);
    });
    const thumbFileBtn = $('#thumbFile');
    if (thumbFileBtn) thumbFileBtn.addEventListener('click', async () => {
      const sg = thumbSeg(); if (!sg) return;
      const f = await window.api.dialog.openFile({ filters: [{ name: 'Pictures', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] }).catch(() => null);
      if (!f) return;
      setClipThumb(sg, { file: f });
      closeThumbPicker();
      window.__toast && window.__toast('🖼️ That picture is this short\'s thumbnail. It is fitted to the short\'s shape on export.', 'good', 7000);
    });
    const thumbClearBtn = $('#thumbClear');
    if (thumbClearBtn) thumbClearBtn.addEventListener('click', () => {
      const sg = thumbSeg(); if (sg) setClipThumb(sg, null);
      closeThumbPicker();
    });
    const saveSessBtn = $('#veSaveSession'); if (saveSessBtn) saveSessBtn.addEventListener('click', () => saveSession(false));
    const sessBtn = $('#veSessions'); if (sessBtn) sessBtn.addEventListener('click', openSessionsWindow);
    const sessCloseBtn = $('#sessClose'); if (sessCloseBtn) sessCloseBtn.addEventListener('click', closeSessionsWindow);
    const sessNewBtn = $('#sessSaveNew'); if (sessNewBtn) sessNewBtn.addEventListener('click', async () => { if (await saveSession(true)) renderSessions(); });
    const sessModal = $('#sessModal'); if (sessModal) sessModal.addEventListener('click', (e) => { if (e.target === sessModal) closeSessionsWindow(); });
    startSessionSweep();
    const pickWhoBtn = $('#veFollowPick'); if (pickWhoBtn) pickWhoBtn.addEventListener('click', () => openFollowPicker(ve.sel || null, false));
    const followX = $('#followClose'); if (followX) followX.addEventListener('click', closeFollowPicker);
    const followAnotherBtn = $('#followAnother'); if (followAnotherBtn) followAnotherBtn.addEventListener('click', followAnotherMoment);
    const followClearBtn = $('#followClear'); if (followClearBtn) followClearBtn.addEventListener('click', () => {
      // "let the AI decide" clears whichever pick this dialog is editing
      if (ve._followOne && ve._followSeg) { delete ve._followSeg.subject; renderClipList(); window.__toast && window.__toast('👤 This short goes back to the automatic pick.', 'good', 5000); }
      else setSubject(null);
      closeFollowPicker();
    });
    const followModal = $('#followModal'); if (followModal) followModal.addEventListener('click', (e) => { if (e.target === followModal) closeFollowPicker(); });
    const closeLib = () => { stopAudition(); $('#libModal').classList.add('hidden'); syncMusicPreview(true); };
    const libCloseBtn = $('#libClose'); if (libCloseBtn) libCloseBtn.addEventListener('click', closeLib);
    const libDoneBtn = $('#libDone'); if (libDoneBtn) libDoneBtn.addEventListener('click', closeLib);
    $$('.lib-tab').forEach((b) => b.addEventListener('click', () => { setLibTab(b.dataset.libtab); renderLibrary(); }));
    const addMusicBtn = $('#libAddMusic'); if (addMusicBtn) addMusicBtn.addEventListener('click', () => addToLibrary('music'));
    const addClipBtn = $('#libAddClip'); if (addClipBtn) addClipBtn.addEventListener('click', () => addToLibrary('clips'));
    const musicRm = $('#libMusicRemove'); if (musicRm) musicRm.addEventListener('click', clearMusic);
    const outroRm = $('#libOutroRemove'); if (outroRm) outroRm.addEventListener('click', clearOutro);
    // Volume is live: drag it while the preview plays and you hear the balance.
    const mVol = $('#libMusicVol'); if (mVol) mVol.addEventListener('input', () => {
      if (!ve.music) return;
      ve.music.volume = clamp(parseFloat(mVol.value) || 0, 0, 1);
      const vv = $('#libMusicVolV'); if (vv) vv.textContent = Math.round(ve.music.volume * 100) + '%';
      const a = ve.refs.musicAudio; if (a && !ve._auditionId) a.volume = ve.music.volume;
      renderMusicLane(); saveMusicPref();
    });
    const mFi = $('#libMusicFadeIn'); if (mFi) mFi.addEventListener('change', () => { if (ve.music) { ve.music.fadeIn = clamp(parseFloat(mFi.value) || 0, 0, 10); saveMusicPref(); } });
    const mFo = $('#libMusicFadeOut'); if (mFo) mFo.addEventListener('change', () => { if (ve.music) { ve.music.fadeOut = clamp(parseFloat(mFo.value) || 0, 0, 10); saveMusicPref(); } });
    const mDuck = $('#libMusicDuck'); if (mDuck) mDuck.addEventListener('change', () => { if (ve.music) { ve.music.duck = mDuck.checked; saveMusicPref(); } });
    const mBed = $('#libMusicBed'); if (mBed) mBed.addEventListener('change', () => {
      if (!ve.music) return;
      ve.music.bed = mBed.checked;
      if (!ve.music.bed && !ve.music.len) { ve.music.tlStart = 0; ve.music.len = ve.music.durationSec || dur(); }
      saveMusicPref(); renderMusicLane(); syncMusicPreview(true);
    });
    const oAll = $('#libOutroAll'); if (oAll) oAll.addEventListener('change', () => {
      ve.outroAll = oAll.checked; saveOutroPref(); renderSegments(); updateMusicButton();
    });
    // YouTube
    const ytInst = $('#libYtInstall'); if (ytInst) ytInst.addEventListener('click', ytInstall);
    const ytBtn = $('#libYtSearch'); if (ytBtn) ytBtn.addEventListener('click', ytSearch);
    const ytQ = $('#libYtQuery'); if (ytQ) ytQ.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); ytSearch(); } });
    // one-tap searches for the tracks a service actually needs
    $$('.lib-chip').forEach((b) => b.addEventListener('click', () => {
      const q = $('#libYtQuery'); if (q) q.value = b.dataset.ytchip || '';
      ytSearch();
    }));
    // the audition player must reset its buttons when the track ends
    if (ve.refs.musicAudio) ve.refs.musicAudio.addEventListener('ended', () => { if (ve._auditionId) stopAudition(); });
    libRefresh();

    ve.refs.track.addEventListener('mousedown', onTrackDown);
    ve.refs.ruler.addEventListener('mousedown', (e) => { if (ve.video) seekTo(trackX(e) / ve.pxPerSec); });
    ve.refs.audioTrack.addEventListener('mousedown', (e) => {
      if (!ve.video || e.target.closest('.ve-audio-seg')) return; // empty audio area -> just move the playhead
      seekTo(trackX(e) / ve.pxPerSec);
    });
    // The ruler and the caption lane only build what is near the viewport (a
    // zoomed-in sermon would otherwise be thousands of nodes), so panning has to
    // repaint them — coalesced to one frame, and only the lanes, never the
    // Shorts panel, which cannot change by scrolling.
    ve.refs.tlScroll.addEventListener('scroll', () => {
      // You just grabbed the timeline — stop dragging you back to the playhead.
      const mine = ve._autoScrollTo != null && Math.abs(ve.refs.tlScroll.scrollLeft - ve._autoScrollTo) <= 1;
      ve._autoScrollTo = null; // one scroll event per programmatic scroll
      if (!mine && ve.follow !== false) setFollow(false, true);
      if (!ve.video || ve._rulerRaf) return;
      ve._rulerRaf = requestAnimationFrame(() => {
        ve._rulerRaf = null;
        renderRuler();
        if (capBlocksVisible()) renderCapTrack();
      });
    }, { passive: true });
    ve.refs.timeline.addEventListener('wheel', (e) => {
      if (e.ctrlKey && ve.video) {
        e.preventDefault();
        setZoom(ve.pxPerSec * (e.deltaY < 0 ? 1.2 : 0.83), true);
      } else { ve.refs.tlScroll.scrollLeft += e.deltaY; }
    }, { passive: false });

    // drag & drop
    const drop = ve.refs.drop;
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    /*
     * The PREVIEW is the 'open this video' target and stays that way. A PICTURE
     * dropped on it cannot mean that — there is nothing to open — so it means the
     * other obvious thing: put it on top of what is playing. Videos meant as
     * overlays go on the TIMELINE (below), which is where they will live anyway.
     */
    drop.addEventListener('drop', (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => f.path).filter(Boolean);
      if (!files.length) return;
      if (ve.video && files.every(isImgPath)) return void addMediaOverlays(files);
      const vids = files.filter((p) => !isImgPath(p));
      // SEVERAL videos at once is a batch, not a mistake. It used to open the
      // first and throw the rest away without a word — which is exactly the
      // "I dropped forty clips and got one" report.
      if (vids.length > 1 || ve.bulk.files.length) return void addBulkVideos(vids);
      if (vids.length === 1) loadVideo(vids[0]);
      else addMediaOverlays(files);
    });

    /*
     * DROP ONTO THE TIMELINE = put it on top, WHERE YOU DROPPED IT. The x position
     * is the time, so a picture lands on the sentence it belongs to without a
     * second gesture — and a second video does not replace the one being edited,
     * which is what dropping on the preview would do.
     */
    const tl = ve.refs.tlScroll;
    if (tl) {
      ['dragenter', 'dragover'].forEach((ev) => tl.addEventListener(ev, (e) => {
        if (!ve.video) return;
        e.preventDefault(); e.stopPropagation(); tl.classList.add('ve-tl-drag');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      }));
      ['dragleave', 'drop'].forEach((ev) => tl.addEventListener(ev, () => tl.classList.remove('ve-tl-drag')));
      tl.addEventListener('drop', (e) => {
        const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).map((f) => f.path).filter(Boolean);
        if (!ve.video || !files.length) return;
        e.preventDefault(); e.stopPropagation();
        const r = ve.refs.track.getBoundingClientRect();
        addMediaOverlays(files, clamp((e.clientX - r.left) / ve.pxPerSec, 0, Math.max(0, dur() - 0.2)));
      });
    }

    const p = ve.refs.player;
    p.addEventListener('timeupdate', () => {
      // hop over any pause the user removed, so what plays IS what exports
      const jump = skipRemovedAt(p.currentTime || 0);
      if (jump != null) { p.currentTime = jump; updatePlayhead(); return; }
      updatePlayhead();
      if (ve._previewEnd != null && p.currentTime >= ve._previewEnd) {
        if (ve._loopSeg) { p.currentTime = ve._loopSeg.start; } else { p.pause(); ve.refs.play.textContent = '▶'; ve._previewEnd = null; }
      }
    });
    // Pressing play is you asking to watch, so following comes back on; scrolling
    // away during playback turns it off again (see the scroll listener).
    p.addEventListener('play', () => { ve.refs.play.textContent = '⏸'; setFollow(true, true); updateClipPlayButtons(); syncMusicPreview(true); startCapTick(); });
    p.addEventListener('pause', () => { ve.refs.play.textContent = '▶'; updateClipPlayButtons(); syncMusicPreview(); syncSoundPreview(); stopCapTick(); });
    p.addEventListener('ended', stopCapTick);
    p.addEventListener('seeked', () => syncMusicPreview(true));
    p.addEventListener('error', () => {
      // Some other unplayable codec — fall back to building a proxy.
      if (ve.video && ve.video.path && !ve.video.proxy && !ve.video.proxying) { showPreparing($('#veNoVid'), p, ve.video.info.vcodec); makeProxyBg(ve.video.path); }
    });
    // live % while a preview proxy builds
    if (window.api.onJobProgress) window.api.onJobProgress(({ jobId, percent }) => {
      if (ve.video && ve.video.proxying && jobId === ve._proxyJobId) {
        const el = document.querySelector('#veNoVid .ve-prep-pct'); if (el) el.textContent = percent + '%';
      }
    });
    document.addEventListener('keydown', (e) => {
      if (!$('#view-video').classList.contains('active')) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
      if (!ve.video) return;
      if (ve.capEditing != null) return; // typing INTO a caption block — never treat keys as timeline shortcuts
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redoVideo() : undoVideo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redoVideo(); return; }
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ve.activeRow === 'caption' && ve.capSel != null && capBlocksVisible()) { e.preventDefault(); ve.capEvents.splice(ve.capSel, 1); ve.capSel = null; renderCapTrack(); renderCapList(); updateCapOverlay(ve.refs.player.currentTime || 0); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ve.activeRow === 'audio' && ve.audioSel) { e.preventDefault(); removeAudioSeg(ve.audioSel); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ve.sel) { e.preventDefault(); removeSeg(ve.sel); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ve.textSel) { e.preventDefault(); removeTextOverlay(ve.textSel); }
      else if (e.key === 's' || e.key === 'S') { e.preventDefault(); splitAtPlayhead(); }
      // B = bigger preview, F = full screen — a proper look at the short before exporting
      else if (e.key === 'b' || e.key === 'B') { e.preventDefault(); setPreviewBig(!isPreviewBig()); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); togglePreviewFull(); }
      // G closes the gap next to the selected clip — the counterpart to S (Split),
      // for putting a split short back together minus the pause
      else if (e.key === 'g' || e.key === 'G') { e.preventDefault(); closeGapAfter(); }
      // The Pro timeline's keys: V select, C blade, and J/K/L to shuttle.
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); setTool('select'); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'c' || e.key === 'C')) { e.preventDefault(); setTool(ve.tool === 'blade' ? 'select' : 'blade'); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); shuttle(-1); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); shuttle(0); }
      else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); shuttle(1); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSeg(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); seekTo((ve.refs.player.currentTime || 0) + (e.shiftKey ? 5 : 1 / 30)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); seekTo((ve.refs.player.currentTime || 0) - (e.shiftKey ? 5 : 1 / 30)); }
      else if (e.key === 'Home') { e.preventDefault(); seekTo(0); }
      else if (e.key === 'End') { e.preventDefault(); seekTo(dur()); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.5); }
      else if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomBy(1 / 1.5); }
    });
  }

  window.VideoEditor = {
    init(settings, presets) {
      if (ve.inited) return; ve.inited = true;
      ve.presets = presets || {};
      ve.refs = {
        player: $('#vePlayer'), timeline: $('#veTimeline'), tlScroll: $('#veTlScroll'), track: $('#veTrack'), ruler: $('#veRuler'),
        filmstrip: $('#veFilmstrip'), segments: $('#veSegments'), playhead: $('#vePlayhead'), selbox: $('#veSelbox'),
        clipList: $('#veClipList'), play: $('#vePlay'), drop: $('#veDrop'), preview: $('#veDrop'), capOverlay: $('#veCapOverlay'),
        cropMask: $('#veCropMask'), cropFrame: $('#veCropFrame'), overlayGuide: $('#veOverlayGuide'),
        textLayer: $('#veTextLayer'), textTrack: $('#veTextTrack'), capTrack: $('#veCapTrack'), audioTrack: $('#veAudioTrack'),
        mediaLayer: $('#veMediaLayer'),
        gapMask: $('#veGapMask'), musicTrack: $('#veMusicTrack'), musicAudio: $('#veMusicAudio'),
      };
      // Load bundled caption fonts so the live preview matches the burned output.
      window.api.paths.get().then((p) => {
        if (!p.fontsDir) return;
        const dir = p.fontsDir.replace(/\\/g, '/');
        const face = (fam, file) => `@font-face{font-family:'${fam}';src:url('${fileUrl(dir + '/' + file)}');}`;
        const st = document.createElement('style');
        st.textContent = face('Anton', 'Anton-Regular.ttf') + face('Bebas Neue', 'BebasNeue-Regular.ttf') +
          face('Poppins', 'Poppins-Bold.ttf') + face('Bangers', 'Bangers-Regular.ttf');
        document.head.appendChild(st);
      }).catch(() => {});
      $('#veAspect').innerHTML = Object.entries(ve.presets).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
      ve.aspect = 'reel-9x16';
      $('#veAspect').value = ve.aspect;
      wire();
      // One set of line icons in place of the colour emoji, in the studio and its
      // captions window (see icons.js — every label keeps its text).
      if (window.MWIcons) window.MWIcons.mount([document.getElementById('view-video'), document.getElementById('capModal')]);
    },
    /*
     * COMING BACK TO THE STUDIO SHOULD NOT COST A FRAME.
     *
     * This used to redraw the whole timeline every single time the page was
     * shown — ruler, every clip, every caption block, the crop mask — and on a
     * 90-minute service with twenty clips and a full transcript that was
     * MEASURED AT 126 ms, on the one thread all five studios share, in the
     * frame the operator is watching. It happened because a hidden element has
     * no geometry, so anything laid out while hidden would be laid out against
     * zero.
     *
     * But nothing on the timeline CHANGES while the studio is hidden, and the
     * widths it was last drawn at are still the right ones unless the window
     * has been resized. So the redraw now happens only when the thing it would
     * draw is actually different. Coming back to an untouched timeline costs
     * nothing at all.
     */
    onShow() {
      const sig = timelineSig();
      if (sig !== ve._shownSig) {
        ve._shownSig = sig;
        renderRuler(); renderSegments(); updatePlayhead(); updateCropMask();
      }
      updateMusicButton();
      // the monitors were measured against nothing while the page was hidden
      ve._monSig = null;
      requestAnimationFrame(() => { autoTimelineHeight(); layoutMonitors(); startSourceLoop(); });
      // coming back to a video left playing picks the caption animation back up
      if (ve.refs.player && !ve.refs.player.paused) startCapTick();
      // Nothing open? See whether last time's work is still waiting.
      offerResume();
      updateSessionChip();
    },
    /*
     * LEAVING THE STUDIO. Nobody can watch a preview on a page that is not on
     * screen, but the browser does not know that: a <video> left playing goes
     * on decoding, and the caption animation goes on running a frame callback,
     * for as long as the operator is in another studio. On a 90-minute 1080p
     * recording that is a continuous cost paid through the whole sermon, on the
     * one thread the Presentation studio is putting slides on the wall with.
     *
     * It is left PAUSED rather than resumed on return: coming back to a studio
     * and having sound start playing by itself is worse than pressing play.
     */
    onHide() {
      stopCapTick();
      stopReverse();
      // The captions editor takes the studio over; leaving the studio closes it,
      // or it would sit over whichever page came next.
      try { if (capModalOpen()) closeCapModal(); } catch (e) {}
      try {
        const p = ve.refs && ve.refs.player;
        if (p && !p.paused) { p.pause(); if (ve.refs.play) ve.refs.play.textContent = '▶'; }
      } catch (e) {}
      try { syncMusicPreview(); } catch (e) {}
    },
    fit() { if (ve.video) { renderRuler(); renderSegments(); updatePlayhead(); updateCropMask(); } },
    /**
     * The phone's Transition tool: the join nearest the playhead (or the one
     * into the selected clip). Says so when there is no join to put one on.
     */
    transitionAtPlayhead() {
      const joins = mainJoins();
      if (!joins.length) {
        window.__toast && window.__toast('Split the video first (Edit → Split) — a transition goes between two clips.', 'error');
        return false;
      }
      const t = ve.refs.player ? (ve.refs.player.currentTime || 0) : 0;
      const sel = joins.find((j) => j.seg.id === ve.sel);
      const best = sel || joins.slice().sort((a, b) => Math.abs(a.seg.start - t) - Math.abs(b.seg.start - t))[0];
      openTransitionPicker(best.seg.id);
      return true;
    },
    /** The outro that goes on the end of every short (CapCut's "ending"). */
    /** Write the rolling autosave NOW (before the page reloads for an update). */
    async flushSession() {
      if (!ve.video) return false;
      if (ve._sessionTimer) clearTimeout(ve._sessionTimer);
      await writeAutosave();
      return true;
    },
    /** Is a video open? (The home screen says "continue" rather than "open".) */
    hasVideo() { return !!ve.video; },
    /** The file the studio has open — the Cloud Studio will not delete it from under the edit. */
    sourcePath() { return (ve.video && ve.video.path) || null; },
    /** The edit the Continue card offers is gone (its video was deleted): put the card away. */
    forgetResume() {
      const bar = $('#veResume');
      if (bar && !bar.classList.contains('hidden')) { bar.classList.add('hidden'); resumePromptQuiet(false); }
    },
    outroInfo() {
      const o = ve.outro;
      return o ? { name: o.name, durationSec: o.durationSec || 0, on: ve.outroAll !== false, thumb: o.thumb ? fileUrl(o.thumb) : null } : null;
    },
    /** Switch the outro on or off for every short; with none chosen yet, open the library to choose one. */
    setOutroOn(on) {
      if (!ve.outro) { openLibrary('clips'); return false; }
      ve.outroAll = !!on;
      saveOutroPref(); renderOutroBar(); renderSegments(); updateMusicButton();
      window.__toast && window.__toast(on ? `“${ve.outro.name}” ends every short` : 'Shorts export without the outro', on ? 'good' : '');
      return ve.outroAll;
    },
    chooseOutro() { openLibrary('clips'); },
    /** The phone's Chroma key tool: the selected overlay, or one under the playhead. */
    chromaKey() { return openChromaKey(); },
    /** The phone's Keyframe tool: the clip under the playhead (or the selected one). */
    keyframes() { return openKeyframes(); },
    /** The phone's Text row: ready-made titles, and how a text arrives. */
    textTemplates() { openTextTemplates(); },
    textAnimation() { openTextAnimPicker(); },
    // test hooks (no real ffmpeg/player needed)
    __test: {
      // The batch pipeline, on its own: "Export all" hands it real tracking, a
      // test hands it a stopwatch. See shorts-speed.test.js.
      makeLookAhead,
      clipFootage,
      // The passes an export is about to make — what the progress number is
      // built from. See export-progress.test.js.
      exportPlan,
      // loads a REAL file through the actual production path (same as opening it
      // in the app) -- for tests that need genuine playback, not synthetic state.
      async loadReal(path) { await loadVideo(path); },
      loadFake(info) {
        ve.video = { path: 'C:/fake/sermon.mp4', info: Object.assign({ durationLabel: '2:25', fps: 30 }, info) };
        ve.segments = []; ve.sel = null; ve.framing = { zoom: 1, offsetX: 0.5, offsetY: 0.5 }; ve.textOverlays = []; ve.textSel = null;
        ve.capEvents = null; ve.capWords = null; ve.capOffset = 0; ve.capTarget = null; ve.capSel = null; ve.capEditing = null;
        resetLiveRender(); // a fresh (fake) load should not inherit stale live-render animation state
        // audio starts as ONE independent full-length clip (like the real load)
        ve.audio = [{ id: uid(), start: 0, end: info.durationSec, color: '#2ea043' }]; ve.audioSel = null; ve.activeRow = 'video';
        ve.history = []; ve.future = []; updateUndoRedoButtons();
        audioTrackSkeleton('<span class="muted small">(fake — no waveform in tests)</span>'); // normally set by loadWaveform()
        const fitW = ve.refs.timeline.clientWidth || 900; ve.pxPerSec = clamp(fitW / Math.max(1, info.durationSec), 4, 40);
        renderRuler(); renderSegments(); updatePlayhead();
      },
      /* --- the captions window, opened BEFORE anything has been transcribed --- */
      async openCaptionsWindow() {
        await openCaptions();
        // The window fires the model render without waiting for it (it asks the
        // main process what is on disk); the test reads the picker afterwards,
        // so it has to wait for that answer or it reads the previous one.
        await renderCapModels();
        const box = document.getElementById('capModal');
        const styleSel = document.getElementById('capStyleSel');
        const modelSel = document.getElementById('capModelSel');
        return {
          open: !!box && !box.classList.contains('hidden'),
          styles: styleSel ? Array.from(styleSel.options).map((o) => o.value) : [],
          style: styleSel ? styleSel.value : null,
          models: modelSel ? Array.from(modelSel.options).map((o) => ({ value: o.value, label: o.textContent })) : [],
          model: modelSel ? modelSel.value : null,
          pref: ve.capModel,
          controls: ['capFont', 'capSize', 'capWords', 'capCase', 'capPos', 'capColor', 'capStyleSel', 'capModelSel']
            .filter((id) => !!document.getElementById(id)),
          generateBtn: !!document.getElementById('capGenerate'),
          emptyText: (document.querySelector('.cap-empty-state') || {}).textContent || '',
          transcribed: !!(ve.capEvents && ve.capEvents.length),
        };
      },
      capModelPref() { return ve.capModel; },
      /** Forget the stored choice and take the default again, as a fresh install would. */
      resetCapModelPref() {
        try { localStorage.removeItem(FILL_KEYS.capModel); } catch (e) {}
        loadExportPrefs();
        return ve.capModel;
      },
      setCapStyleFromPicker(id) { setCapStyle(id); return ve.capStyleId; },
      capStyleNow() { return ve.capStyleId; },
      // --- independent audio row (#2) ---
      audioClips() { return ve.audio.map((s) => ({ id: s.id, start: s.start, end: s.end })); },
      activeRow() { return ve.activeRow; },
      selectAudioClip(id) { selectAudio(id || ve.audio[0].id); },
      splitAudio(t) { ve.activeRow = 'audio'; ve.audioSel = ve.audio[0] && ve.audio[0].id; splitAtPlayhead(t); },
      applyClips(clips) { ve.segments = clips.map((c, i) => ({ id: uid(), start: c.start, end: c.end, label: c.label || ('Key ' + (i + 1)), color: COLORS[i % COLORS.length], ai: true, virality: c.virality, reasons: c.reasons })); renderSegments(); },
      /** Add AI clips WITHOUT clearing the existing ones (a later Long-to-shorts pass). */
      applyClipsAppend(clips) {
        clips.forEach((c, i) => { const s = addSegment(c.start, c.end, c.label || ('Key ' + (i + 1)), true); s.virality = c.virality; s.reasons = c.reasons; });
        renderSegments();
      },
      segmentDomCount() { return $$('#veSegments .ve-seg').length; },
      rulerTickCount() { return $$('#veRuler .ve-tick').length; },
      segments() { return ve.segments.map((s) => ({ id: s.id, start: s.start, end: s.end, left: s.start * ve.pxPerSec, width: (s.end - s.start) * ve.pxPerSec })); },
      addManual(a, b) { return addSegment(a, b, 'Manual', false); },
      addShort(a, b) { pushHistory(); const s = addSegment(a, b, 'Short', true); renderClipList(); return s; },
      // --- what Long-to-shorts is allowed to search (the timeline decides) ---
      searchRanges() { return searchRanges(); },
      // --- the Shorts panel vs the edited-video export ---
      /** Exactly what the Shorts panel lists (and what Export all would render). */
      shortsList() {
        return shortsOf()
          .sort((a, b) => a.start - b.start)
          .map((s) => ({ id: s.id, start: s.start, end: s.end, label: s.label, ai: !!s.ai }));
      },
      shortsCards() { return $$('#veClipList .ve-clip').length; },
      exportAllDisabled() { const b = document.getElementById('veExportAll'); return !b || b.disabled; },
      isSeed(id) { const s = ve.segments.find((x) => x.id === id); return s ? !!s.seed : null; },
      editedSpan() { return editedSpan(); },
      // where a timeline moment lands in the edited export (cuts and transitions)
      editedOutTime(t, edge) {
        const sp = editedSpan(); if (!sp) return null;
        return outTime({ start: sp.start, end: sp.end, cuts: sp.cuts, xfades: sp.xfades }, t, edge);
      },
      setTransition(segId, type, dur) { setTransition(segId, type, dur); },
      setChromaKey(id, patch) { return setChromaKey(id, patch); },
      chromaKeyOf(id) { const x = ve.segments.find((v) => v.id === id); return x && x.key ? Object.assign({}, x.key) : null; },
      openChromaKey(id) { return openChromaKey(id); },
      pickKeyColor(id) { return pickKeyColor(id); },
      keyAlpha(rgb, color, sim, blend) { return keyAlpha(rgb[0], rgb[1], rgb[2], keyUVFull(...hexRgb(color)), sim, blend); },
      overlayExportPayload(mode) { const sp = editedSpan(); return sp ? overlayPayloadFor({ id: '__edited', start: sp.start, end: sp.end, cuts: sp.cuts, xfades: sp.xfades }, mode || 'frame') : null; },
      keyframePreset(id, kind) { return keyframePreset(id, kind); },
      setKeyframes(id, kf) { const x = ve.segments.find((v) => v.id === id); if (!x) return null; if (kf && kf.length) x.kf = kf.map((k) => Object.assign({}, k)); else delete x.kf; ve._kfKey = null; renderSegments(); return (x.kf || []).length; },
      keyframesOf(id) { const x = ve.segments.find((v) => v.id === id); return x ? (x.kf || []).map((k) => Object.assign({}, k)) : null; },
      kfAt(id, t) { const x = ve.segments.find((v) => v.id === id); return x ? kfAt(x, t) : null; },
      motionForEdited() { const sp = editedSpan(); if (!sp) return null; return motionFor({ id: '__edited', start: sp.start, end: sp.end, cuts: sp.cuts, xfades: sp.xfades }); },
      motionForClip(id) { const x = ve.segments.find((v) => v.id === id); return x ? motionFor(x) : null; },
      playerTransform() { return ve.refs.player ? ve.refs.player.style.transform : null; },
      openKeyframes(id) { return openKeyframes(id); },
      setKeyframeValue(key, val) { const k = setKeyframeValue(key, val, false); return k ? Object.assign({}, k) : null; },
      textTemplateIds() { return TEXT_TEMPLATES.map((t) => t.id); },
      addTextTemplate(id) { return addTextTemplate(id); },
      setTextAnim(id, anim) { return setTextAnim(id, anim); },
      textAnimState(id, t) { const o = ve.textOverlays.find((x) => x.id === id); return o ? textAnimState(o, t) : null; },
      textAnimOf(id) { const o = ve.textOverlays.find((x) => x.id === id); return o ? (o.anim || 'none') : null; },
      exportEditedButton() {
        const b = document.getElementById('veExportEdited');
        return b ? { text: b.textContent, title: b.title, disabled: b.disabled } : null;
      },
      exportEditedVideo() { return exportEditedVideo(); },
      exportAll() { return exportAll(); },
      /* --- ⇥ exports that run behind the studio --- */
      setBgExport(on) {
        const c = document.getElementById('veBgExport');
        if (!c) return null;
        c.checked = !!on;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return c.checked;
      },
      /** Is the whole app still behind the modal, or is the operator free? */
      overlayUp() {
        const o = document.getElementById('overlay');
        return !!o && !o.classList.contains('hidden');
      },
      /** The ⇥ button the running overlay offers, and pressing it. */
      backgroundButton() {
        const b = document.getElementById('overlayBackground');
        return b ? { shown: !b.classList.contains('hidden'), text: b.textContent.trim() } : null;
      },
      clickRunInBackground() {
        const b = document.getElementById('overlayBackground');
        if (!b || b.classList.contains('hidden')) return false;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      },
      /** What the corner is reporting right now. */
      bgDock() {
        const d = document.getElementById('bgDock');
        if (!d) return null;
        return {
          shown: !d.classList.contains('hidden'),
          head: (d.querySelector('.bgd-head') || {}).textContent || '',
          jobs: Array.from(d.querySelectorAll('.bgj')).map((j) => ({
            state: j.className.replace('bgj', '').trim(),
            title: (j.querySelector('.bgj-title') || {}).textContent || '',
            step: (j.querySelector('.bgj-step') || {}).textContent || '',
            batch: (j.querySelector('.bgj-batch') || {}).textContent || '',
            pct: parseFloat(((j.querySelector('.progress-bar') || {}).style || {}).width) || 0,
            canStop: !!j.querySelector('[data-stop]'),
            canShow: !!j.querySelector('[data-open]'),
          })),
        };
      },
      clickExportEdited() {
        const b = document.getElementById('veExportEdited');
        if (!b || b.disabled) return false;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      },
      aiClips() { return ve.segments.filter((s) => s.ai).map((s) => ({ id: s.id, start: s.start, end: s.end, label: s.label })); },
      searchLabel() { const b = document.getElementById('veFindHighlights'); return b ? { text: b.textContent, title: b.title, trimmed: b.classList.contains('ve-trimmed') } : null; },
      /** Drag a clip's trim handle for real (edge='l'|'r'), exactly as a user would. */
      trimEdge(id, edge, deltaPx) {
        const el = ve.refs.segments.querySelector(`.ve-seg[data-id="${id}"]`);
        if (!el) return null;
        const h = el.querySelector(`.ve-seg-h.${edge}`); if (!h) return null;
        const r = h.getBoundingClientRect();
        const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2;
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: y0 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x0 + deltaPx, clientY: y0 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        flushRender();
        const s = ve.segments.find((x) => x.id === id);
        return s ? { start: s.start, end: s.end, seed: !!s.seed } : null;
      },
      /** Click the real button and hand back the analyze() payload the app sent. */
      async clickFindHighlights() {
        const b = document.getElementById('veFindHighlights');
        const p = findHighlights();
        void b; await p;
        return ve._lastAnalyzeArgs || null;
      },
      split(t) { splitAtPlayhead(t); },
      moveClip(id, newStart) { const s = ve.segments.find((x) => x.id === id); if (!s) return; const len = s.end - s.start; s.start = newStart; s.end = newStart + len; renderSegments(); },
      moveClipWithHistory(id, newStart) { pushHistory(); const s = ve.segments.find((x) => x.id === id); if (!s) return; const len = s.end - s.start; s.start = newStart; s.end = newStart + len; renderSegments(); },
      audioSegDomCount() { return $$('#veAudioSegments .ve-audio-seg').length; },
      audioTrimHandleCount() { return $$('#veAudioSegments .ve-audio-seg .ve-audio-h').length; },
      playerMuted() { return !!ve.refs.player.muted; },
      removeAudioClip(id) { removeAudioSeg(id || (ve.audio[0] && ve.audio[0].id)); },
      // Simulate a real drag of an audio clip's trim handle (edge='l'|'r').
      trimAudioEdge(id, edge, deltaPx) {
        const el = ve.refs.audioSegments.querySelector(`.ve-audio-seg[data-id="${id}"]`);
        if (!el) return null;
        const h = el.querySelector(`.ve-audio-h.${edge}`); if (!h) return null;
        const r = h.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: r.top + 5 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x0 + deltaPx, clientY: r.top + 5 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const a = ve.audio.find((x) => x.id === id);
        return a ? { start: a.start, end: a.end } : null;
      },
      audioSegRect(id) { const el = ve.refs.audioSegments.querySelector(`[data-id="${id}"]`); if (!el) return null; return { left: parseFloat(el.style.left), width: parseFloat(el.style.width) }; },
      clickAudioSeg(id) {
        const el = ve.refs.audioSegments.querySelector(`[data-id="${id}"]`);
        if (el) onAudioSegDown({ clientX: el.getBoundingClientRect().left + 5, preventDefault(){}, stopPropagation(){} }, el);
        document.dispatchEvent(new MouseEvent('mouseup'));
      },
      // --- text editing ---
      editTextContent(id, newText) {
        const box = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${id}"]`);
        if (!box) return false;
        startEditingText(box);
        const content = box.querySelector('.ve-text-content');
        content.innerText = newText;
        content.dispatchEvent(new Event('blur'));
        return true;
      },
      // Exercises the REAL DOM path a user hits: enter edit mode, click into the
      // box (mousedown), then type. Proves the box's mousedown no longer hijacks
      // the caret and that the contenteditable is actually selectable/typable.
      editByTyping(id, newText) {
        const box = ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${id}"]`);
        if (!box) return { ok: false };
        startEditingText(box);
        const content = box.querySelector('.ve-text-content');
        const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        box.dispatchEvent(md); // used to call preventDefault() and block the caret
        const cs = getComputedStyle(content);
        const editable = content.getAttribute('contenteditable') === 'true';
        content.innerText = newText;
        content.dispatchEvent(new Event('input', { bubbles: true }));
        content.dispatchEvent(new Event('blur'));
        const o = ve.textOverlays.find((x) => x.id === id);
        const computedUS = cs.getPropertyValue('user-select') || cs.getPropertyValue('-webkit-user-select');
        return {
          ok: true,
          caretHijacked: md.defaultPrevented, // must be FALSE now (was TRUE = the bug)
          userSelect: content.style.userSelect || content.style.webkitUserSelect, // inline override we set
          computedNotNone: computedUS !== 'none', // and it definitely isn't the blocking 'none'
          editable,
          committed: o ? o.text : null,
        };
      },
      textOf(id) { const o = ve.textOverlays.find((x) => x.id === id); return o ? o.text : null; },
      clearText() { ve.textOverlays = []; ve.textSel = null; ve.textEditing = null; renderTextOverlays(); renderTextTrack(); },
      // What text would be burned into a short of [start,end] (frame-mapped payload).
      overlaysForShort(start, end) { return overlaysForShortExport({ start, end, label: 'test' }); },
      // The REAL export payload: transparent PNGs rasterised from the preview's
      // own HTML/CSS (this is what actually gets burned in).
      async textPngsForShort(start, end, w, h, mode) {
        const r = await textOverlayPngs({ start, end, label: 'test' }, w, h, mode);
        return r ? r.map((x) => ({ png: Array.from(x.png), start: x.start, end: x.end })) : null;
      },
      overlayLayout(id, mode, outW, outH) {
        const o = ve.textOverlays.find((x) => x.id === id);
        return o ? overlayLayout(o, textExportGeom(), mode, outW, outH) : null;
      },
      textExportGeom() { const g = textExportGeom(); return { cw: g.cw, chh: g.chh, fr: g.fr }; },
      // Where the preview actually draws a text box, in preview pixels.
      textBoxRect(id) {
        const el = ve.refs.textLayer && ve.refs.textLayer.querySelector(`.ve-text-box[data-id="${id}"]`);
        if (!el) return null;
        const c = el.querySelector('.ve-text-content');
        return { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight,
                 fontPx: c ? parseFloat(getComputedStyle(c).fontSize) : 0,
                 lines: c ? Math.round(c.getBoundingClientRect().height / (parseFloat(getComputedStyle(c).lineHeight) || 1)) : 0 };
      },
      setTextPos(id, x, y) { const o = ve.textOverlays.find((v) => v.id === id); if (!o) return null; o.x = x; o.y = y; clampTextIntoFrame(o); renderTextOverlays(); return { x: o.x, y: o.y }; },
      /**
       * The added text as the eye sees it, IN FRACTIONS OF THE EXPORT FRAME —
       * where it sits, how wide it runs, how big it is and how many lines it
       * wraps to. Every one of these must be identical in the small preview, the
       * bigger one and full screen, because all three are showing the same
       * exported picture at three sizes.
       */
      textLookInFrame(id) {
        const el = ve.refs.textLayer && ve.refs.textLayer.querySelector(
          id ? `.ve-text-box[data-id="${id}"]` : '.ve-text-box');
        const c = el && el.querySelector('.ve-text-content');
        if (!el || !c) return null;
        const fr = outputFrameRect();
        const b = c.getBoundingClientRect();
        const host = ve.refs.preview.getBoundingClientRect();
        const lh = parseFloat(getComputedStyle(c).lineHeight) || 1;
        return {
          frame: { w: +fr.w.toFixed(1), h: +fr.h.toFixed(1) },
          // the WORDS' own box, relative to the export frame
          x0: +(((b.left - host.left) - fr.left) / fr.w).toFixed(4),
          x1: +(((b.right - host.left) - fr.left) / fr.w).toFixed(4),
          y0: +(((b.top - host.top) - fr.top) / fr.h).toFixed(4),
          fontFrac: +(parseFloat(getComputedStyle(c).fontSize) / fr.h).toFixed(4),
          lines: Math.max(1, Math.round(b.height / lh)),
          boxFrac: +(el.offsetWidth / fr.w).toFixed(4),
        };
      },
      cropFrameBox() { const f = ve.refs.cropFrame; return f ? { left: f.offsetLeft, top: f.offsetTop, width: f.offsetWidth, height: f.offsetHeight } : null; },
      // --- timeline: real clip blocks + gaps ---
      seedFullClip() {
        ve.segments = [{ id: uid(), start: 0, end: dur(), label: 'Full video', color: COLORS[0], ai: false, seed: true }];
        ve.sel = ve.segments[0].id; renderSegments();
        return { count: ve.segments.length, domCount: $$('#veSegments .ve-seg').length };
      },
      setFilmstrip(url) { ve.filmstripUrl = url; renderSegments(); },
      /* ---------------- timeline performance ----------------
       * Zooming is the heaviest thing the timeline does, and "it feels laggy"
       * is not something that can be fixed by reading the code. These two hooks
       * put numbers on it: where the time goes in one render, and how long a
       * real zoom step takes from the wheel to the frame that shows it. */
      /** Run any deferred render now — so a measurement can include its cost. */
      flushRenderHook() {
        if (ve._rulerRaf) { cancelAnimationFrame(ve._rulerRaf); ve._rulerRaf = null; renderRuler(); if (capBlocksVisible()) renderCapTrack(); }
        flushRender();
      },
      renderCostBreakdown() {
        const t = (fn) => { const a = performance.now(); fn(); return +(performance.now() - a).toFixed(2); };
        // read a layout property each time so the cost of the reflow each
        // render provokes lands on the render that caused it
        const settle = () => ve.refs.tlScroll && ve.refs.tlScroll.scrollWidth;
        return {
          pxPerSec: +ve.pxPerSec.toFixed(3),
          trackW: Math.round(trackW()),
          caps: (ve.capEvents || []).length,
          segs: ve.segments.length,
          segBlocks: t(() => { renderSegBlocks(); settle(); }),
          clipList: t(() => { renderClipList(); settle(); }),
          textTrack: t(() => { renderTextTrack(); settle(); }),
          capTrack: t(() => { renderCapTrack(); settle(); }),
          audio: t(() => { renderAudioSegments(); settle(); }),
          music: t(() => { renderMusicLane(); settle(); }),
          ruler: t(() => { renderRuler(); settle(); }),
          capNodes: $$('#veCapTrack .ve-cap-clip').length,
          segNodes: $$('#veSegments .ve-seg').length,
        };
      },
      /**
       * What one zoom step COSTS, and what the timeline then RUNS AT.
       *
       * Two numbers, because one of them lies on its own. Waiting for animation
       * frames around each step puts a floor of one frame (~16.7 ms) under
       * every reading — two waits and the floor is 33 ms, which is how an
       * earlier version of this reported "33 ms" for work that took under one.
       * So `work` is measured synchronously with the render forced to run
       * inside the measurement, and `fps` is measured separately by counting
       * frames through a continuous sweep, which is what smooth actually means.
       */
      async zoomPerf({ steps = 24, factor = 1.18, lo = 0.4, hi = 60 } = {}) {
        const frame = () => new Promise((r) => requestAnimationFrame(r));
        const each = [];
        await frame();
        for (let i = 0; i < steps; i++) {
          const a = performance.now();
          zoomBy(i < steps / 2 ? factor : 1 / factor);
          flushRender();                                       // do the work now, not next frame
          if (ve.refs.tlScroll) ve.refs.tlScroll.scrollWidth;  // …including the reflow it causes
          each.push(performance.now() - a);
          await frame();                                       // let the page breathe between steps
        }
        const s = each.slice().sort((x, y) => x - y);
        const at = (p) => +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(1);

        /* Achieved frame rate through a continuous wheel-style sweep.
         *
         * Warm up first and throw those frames away: the first sweep after a
         * video is loaded is still decoding the filmstrip and settling the
         * caption lane, and counting it measures the load rather than the zoom.
         * Two runs of the identical sweep differed by 20 fps until this was
         * added, which is the tell that it was measuring the wrong thing. */
        let dir = 1;
        setZoom(lo, false);
        const sweepOnce = () => {
          zoomBy(dir > 0 ? 1.06 : 1 / 1.06);
          if (ve.pxPerSec >= hi) dir = -1;
          if (ve.pxPerSec <= lo) dir = 1;
        };
        const warm = performance.now();
        while (performance.now() - warm < 350) { sweepOnce(); await frame(); }
        let frames = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) { sweepOnce(); await frame(); frames++; }
        const fps = +(frames / ((performance.now() - t0) / 1000)).toFixed(1);
        return {
          steps, workMedian: at(0.5), workP90: at(0.9), workWorst: +s[s.length - 1].toFixed(1),
          fps, band: `${lo}–${hi} px/s`, trackW: Math.round(trackW()), pxPerSec: +ve.pxPerSec.toFixed(2),
        };
      },
      segIsOpaque(id) {
        const el = ve.refs.segments.querySelector(`[data-id="${id}"]`);
        if (!el) return null;
        const cs = getComputedStyle(el);
        // opaque = a solid background colour (alpha 1) OR a painted film image
        const solid = cs.backgroundColor && !/rgba\([^)]*,\s*0\s*\)/.test(cs.backgroundColor) && cs.backgroundColor !== 'transparent';
        return { solid, hasImage: cs.backgroundImage !== 'none' };
      },
      continuousStripHidden() {
        const el = ve.refs.filmstrip; if (!el) return true;
        return getComputedStyle(el).display === 'none';
      },
      // --- overlay lane (PiP) #1 ---
      toggleOverlay(id) { if (id) { ve.sel = id; ve.activeRow = 'video'; ve.audioSel = null; } toggleOverlayLane(); },
      laneOf(id) { const s = ve.segments.find((x) => x.id === id); return s ? (s.lane || 0) : null; },
      overlayCount() { return ve.segments.filter((s) => s.lane === 1).length; },
      segTop(id) { const el = ve.refs.segments.querySelector(`[data-id="${id}"]`); return el ? parseFloat(el.style.top) : null; },
      tlStartOf(id) { const s = ve.segments.find((x) => x.id === id); return s ? (s.tlStart != null ? s.tlStart : s.start) : null; },
      footageOf(id) { const s = ve.segments.find((x) => x.id === id); return s ? { start: s.start, end: s.end } : null; },
      setOverlayTl(id, tl) { const s = ve.segments.find((x) => x.id === id); if (s) { s.lane = 1; if (s.tlStart == null) s.tlStart = s.start; s.tlStart = tl; if (s.pipX == null) { s.pipX = 0.6; s.pipY = 0.05; s.pipW = 0.34; } renderSegments(); } },
      overlayGuideVisible() { return ve.refs.overlayGuide && !ve.refs.overlayGuide.classList.contains('hidden'); },
      overlayPayload() { return overlayClips().map((s) => ({ srcStart: s.start, srcEnd: s.end, tlStart: (s.tlStart != null ? s.tlStart : s.start), x: s.pipX, y: s.pipY, wFrac: s.pipW })); },
      // the EXACT overlay mapping a short export would composite (clip-relative)
      pipPayloadForShort(start, end) {
        const s = { id: '__test', start, end };
        return overlaysIntersecting(s).map((o) => {
          const ovStart = tlPos(o), ovEnd = ovStart + (o.end - o.start);
          const A = Math.max(ovStart, s.start), B = Math.min(ovEnd, s.end);
          const srcOff = A - ovStart;
          return { srcStart: o.start + srcOff, srcEnd: o.start + srcOff + (B - A), tlStart: A - s.start };
        });
      },
      // --- added media: a SECOND video, or a picture, on the overlay lane ---
      async addMedia(paths, at) { await addMediaOverlays(Array.isArray(paths) ? paths : [paths], at); return ve.sel; },
      mediaIds() { return overlayClips().filter(isMedia).map((s) => String(s.id)); },
      mediaOf(id) {
        const s = ve.segments.find((x) => String(x.id) === String(id));
        if (!s) return null;
        return {
          src: s.src || null, kind: s.kind || null, lane: s.lane || 0,
          start: s.start, end: s.end, tlStart: tlPos(s), mute: !!s.mute,
          x: s.pipX, y: s.pipY, w: s.pipW, srcInfo: s.srcInfo || null,
        };
      },
      setMediaTl(id, tl) { const s = ve.segments.find((x) => String(x.id) === String(id)); if (s) { s.tlStart = tl; renderSegments(); } return s ? tlPos(s) : null; },
      setMediaBox(id, x, y, w) {
        const s = ve.segments.find((x2) => String(x2.id) === String(id));
        if (!s) return null;
        s.pipX = x; s.pipY = y; s.pipW = w; renderSegments();
        return { x: s.pipX, y: s.pipY, w: s.pipW };
      },
      toggleMediaSound(id) { toggleOverlaySound(id); const s = ve.segments.find((x) => String(x.id) === String(id)); return s ? !!s.mute : null; },
      // The EXACT payload handed to video.exportOverlayComposite for a range —
      // the one thing that decides what actually lands in the file.
      mediaPayloadFor(start, end) { return overlayPayloadFor({ id: '__test', start, end }); },
      // …and the one the "Export video" button builds for the whole edited span.
      editedOverlayPayload() {
        const sp = editedSpan();
        // 'source' — the same mode the real 💾 Export video passes, or this hook
        // would report a payload nothing ever sends.
        return sp ? overlayPayloadFor({ id: '__edited', start: sp.start, end: sp.end }, 'source') : null;
      },
      // What the PREVIEW is showing right now: is that picture/footage on screen,
      // and where. This is the WYSIWYG claim, checked rather than asserted.
      mediaOnScreen(id) {
        const n = ve.refs.mediaLayer && ve.refs.mediaLayer.querySelector(`[data-mid="${id}"]`);
        if (!n) return null;
        return {
          tag: n.tagName, shown: n.style.display !== 'none',
          left: parseFloat(n.style.left) || 0, top: parseFloat(n.style.top) || 0,
          width: parseFloat(n.style.width) || 0, height: parseFloat(n.style.height) || 0,
          muted: n.tagName === 'VIDEO' ? !!n.muted : null,
        };
      },
      mediaBlockRect(id) {
        const el = ve.refs.segments.querySelector(`[data-id="${id}"]`);
        return el ? { left: parseFloat(el.style.left), width: parseFloat(el.style.width), top: parseFloat(el.style.top), cls: el.className } : null;
      },
      soundBtn() {
        const b = document.getElementById('veOvSound');
        return b ? { hidden: b.classList.contains('hidden'), text: b.textContent } : null;
      },
      clickAddMediaExists() { return !!document.getElementById('veAddMedia'); },
      // --- where the captions sit on the frame ---
      setCaps(events) { ve.capEvents = (events || []).slice(); ve.capWords = null; renderCapTrack(); renderCapList && renderCapList(); updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0); return ve.capEvents.length; },
      capPosNow() { return ve.capPos ? { x: ve.capPos.x, y: ve.capPos.y } : null; },
      exportFrameRect() { const r = canvasFrameRect(); return r ? { left: r.left, top: r.top, w: r.w, h: r.h } : null; },
      // --- export size ---
      quality() { return qualityCfg(); },
      setQuality(q) { const el = document.getElementById('veQuality'); if (el) { el.value = q; el.dispatchEvent(new Event('change', { bubbles: true })); } return qualityCfg(); },
      qualityOptions() { const el = document.getElementById('veQuality'); return el ? [...el.options].map((o) => o.value) : []; },
      upscaleWarning() { return upscaleWarning(); },
      setCapPos(x, y) { ve.capPos = { x, y }; updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0); return ve.capPos; },
      framing() { return { zoom: ve.framing.zoom, offsetX: ve.framing.offsetX, offsetY: ve.framing.offsetY }; },
      burnCaps() { return burnCaps(); },
      capOptsNow() { return capStyleCfg(); },
      /** The slice of the source frame the current export preset actually keeps. */
      cropWindowNow() {
        const w = cropWindow();
        return { left: w.ox - w.cw / 2, top: w.oy - w.ch / 2, cw: w.cw, ch: w.ch };
      },
      mediaSeek(t) { seekTo(t); updatePlayhead(); return ve.refs.player.currentTime || 0; },
      selectClip(id) { selectSeg(id); return ve.sel; },
      duplicateClip(id) { duplicateSeg(id); return ve.sel; },
      /*
       * A REAL drag on a clip block — the same mousedown/mousemove/mouseup the
       * mouse produces — so the trim and lane rules are tested through the code
       * that actually runs, not through a copy of its arithmetic.
       * edge: 'l' | 'r' | null (move). `laneY` picks the lane for a move.
       */
      dragSeg(id, edge, toSec, laneY) {
        const el = ve.refs.segments.querySelector(`[data-id="${id}"]`);
        if (!el) return null;
        const r = ve.refs.track.getBoundingClientRect();
        const target = edge ? el.querySelector(`.ve-seg-h.${edge}`) : el;
        const s2 = ve.segments.find((x) => String(x.id) === String(id));
        const fromSec = edge === 'r' ? tlPos(s2) + (s2.end - s2.start) : tlPos(s2);
        const y = r.top + (laneY != null ? laneY : (s2.lane === 1 ? 20 : 75));
        const ev = (type, sec, node) => node.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, clientX: r.left + sec * ve.pxPerSec, clientY: y,
        }));
        ev('mousedown', fromSec, target);
        ev('mousemove', toSec, document);
        ev('mouseup', toSec, document);
        renderSegments();
        return this.mediaOf(id);
      },
      // --- close the gap: join split clips back into ONE short, pause removed ---
      segCount() { return ve.segments.length; },
      segIds() { return ve.segments.slice().sort((a, b) => a.start - b.start).map((s) => s.id); },
      selId() { return ve.sel; },
      clickCloseGap() {
        const b = document.getElementById('veCloseGap'); if (!b) return null;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return ve.sel;
      },
      closeGap(id) { const s = closeGapAfter(id); return s ? s.id : null; },
      cutsOf(id) { const s = ve.segments.find((x) => x.id === id); return s ? cutsOf(s) : null; },
      keptOf(id) {
        const s = ve.segments.find((x) => x.id === id); if (!s) return null;
        return { start: s.start, end: s.end, kept: keptDur(s), removed: removedDur(s), pieces: keptPieces(s) };
      },
      srcToOut(id, t) { const s = ve.segments.find((x) => x.id === id); return s ? srcToOut(s, t) : null; },
      // the notches drawn inside the clip block for each removed pause
      cutNotches(id) {
        const el = ve.refs.segments.querySelector(`[data-id="${id}"]`); if (!el) return null;
        return Array.from(el.querySelectorAll('.ve-seg-cut')).map((n) => ({ left: parseFloat(n.style.left), width: parseFloat(n.style.width) }));
      },
      joinBadge(id) {
        const el = ve.refs.segments.querySelector(`[data-id="${id}"] .ve-seg-joinbadge`);
        return el ? el.textContent.trim() : null;
      },
      // what playback would jump to at time t (null = nothing removed here)
      skipAt(t) { return skipRemovedAt(t); },
      // caption lines re-timed for an export with the pauses taken out
      remapCaps(id) {
        const s = ve.segments.find((x) => x.id === id); if (!s) return null;
        return remapCapEventsThroughCuts(s, (ve.capEvents || []).filter((e) => e.text && e.text.trim()))
          .map((e) => ({ start: +e.start.toFixed(3), end: +e.end.toFixed(3), text: e.text }));
      },
      capBlockCut(i) {
        const el = ve.refs.capTrack.querySelector(`.ve-cap-clip[data-i="${i}"]`);
        return el ? el.classList.contains('cut') : null;
      },
      setCuts(id, cuts) { const s = ve.segments.find((x) => x.id === id); if (s) { s.cuts = cuts; renderSegments(); } },
      // real export of one clip (pauses joined out) — returns the written file
      exportClip(id) { const s = ve.segments.find((x) => x.id === id); return s ? exportOneClip(s) : null; },
      // the FULL per-short export path (text burn + captions + music + outro)
      exportSegmentFull(id) { return exportSegment(id); },
      // --- gap-aware preview + text visibility ---
      gapMaskVisible() { return ve.refs.gapMask && !ve.refs.gapMask.classList.contains('hidden'); },
      deleteClip(id) { removeSeg(id); },
      textFontPx() {
        const c = ve.refs.textLayer.querySelector('.ve-text-content');
        return c ? parseFloat(getComputedStyle(c).fontSize) : null;
      },
      textToolsVisible() { const b = document.getElementById('veTextTools'); return !!b && !b.classList.contains('hidden'); },
      textStyleOf(id) { const o = ve.textOverlays.find((x) => x.id === id); return o ? { font: o.font, sizePct: o.sizePct, color: o.color, bold: o.bold, bg: !!o.bg, bgColor: o.bgColor, outline: !!o.outline, outlineColor: o.outlineColor } : null; },
      textOverlays() { return ve.textOverlays.map((o) => ({ id: o.id, text: o.text, x: o.x, y: o.y, w: o.w, start: o.start, end: o.end, sizePct: o.sizePct, font: o.font, color: o.color, bold: !!o.bold, bg: !!o.bg, outline: !!o.outline })); },
      /** The stroke the preview is ACTUALLY painting, straight off the element. */
      textOutlineCss() {
        const c = ve.refs.textLayer.querySelector('.ve-text-content');
        if (!c) return null;
        const st = getComputedStyle(c);
        return { width: st.webkitTextStrokeWidth, color: st.webkitTextStrokeColor, paintOrder: st.paintOrder, fontSize: st.fontSize };
      },
      /** Toggle the outline through the real toolbar button. */
      clickTextOutline() { const b = document.getElementById('vtOutline'); if (b) b.click(); return this.textStyleOf(ve.textSel); },
      selectText(id) { ve.textSel = id; ve.textEditing = null; renderTextOverlays(); updateTextTools(); },
      deselectText() { ve.textSel = null; ve.textEditing = null; renderTextOverlays(); updateTextTools(); },
      setTextSizePct(id, v) { const o = ve.textOverlays.find((x) => x.id === id); if (o) { o.sizePct = v; renderTextOverlays(); } return o ? o.sizePct : null; },
      info() { return ve.video ? ve.video.info : null; },
      textBgCss() { const c = ve.refs.textLayer.querySelector('.ve-text-content'); return c ? getComputedStyle(c).backgroundColor : null; },
      textBoxGeom() {
        const box = ve.refs.textLayer.querySelector('.ve-text-box');
        const c = box && box.querySelector('.ve-text-content');
        if (!box || !c) return null;
        const b = box.getBoundingClientRect(), t = c.getBoundingClientRect();
        return { boxTop: b.top, boxBottom: b.bottom, boxH: b.height, textTop: t.top, textBottom: t.bottom, textH: t.height };
      },
      // --- timeline flexibility (#6): snapping + zoom ---
      snapOn() { return ve.snap; },
      setSnap(v) { ve.snap = !!v; },
      snapValue(t, excludeId) { return snapT(t, excludeId).t; },
      pxPerSec() { return ve.pxPerSec; },
      // the renders are rAF-coalesced, so flush before reading the DOM back
      zoomInHook() { zoomBy(1.5); flushRender(); return ve.pxPerSec; },
      zoomOutHook() { zoomBy(1 / 1.5); flushRender(); return ve.pxPerSec; },
      fitHook() { fitZoom(); flushRender(); return ve.pxPerSec; },
      flushRender() { flushRender(); },
      renderPending() { return ve._renderRaf != null; },
      zoomStep(f) { zoomBy(f); return ve.pxPerSec; },
      setZoomPx(px) { setZoom(px, false); flushRender(); return ve.pxPerSec; },
      /** Drive a REAL edge-trim drag: mousedown on the handle, N mousemoves, mouseup.
       *  Reports the rebuilds each phase cost — the moves are the ones that must be free. */
      dragTrim(id, edge, steps, dxPerStep) {
        const h = ve.refs.segments.querySelector(`[data-id="${id}"] .ve-seg-h.${edge}`);
        if (!h) return null;
        const n = () => ve._renderCount || 0;
        const r = h.getBoundingClientRect();
        const y = r.top + r.height / 2;
        let x = r.left + r.width / 2;
        const c0 = n();
        h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }));
        const c1 = n();
        for (let i = 0; i < steps; i++) {
          x += (dxPerStep == null ? -1 : dxPerStep);
          document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        }
        const c2 = n();
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
        return { down: c1 - c0, moves: c2 - c1, up: n() - c2, steps };
      },
      /** How many DOM rebuilds a burst of N zoom steps actually costs. */
      countRenders(fn) {
        const before = ve._renderCount || 0;
        fn();
        return (ve._renderCount || 0) - before;
      },
      // --- follow the playhead ---
      followOn() { return ve.follow !== false; },
      setFollowHook(v) { setFollow(v); return ve.follow; },
      userScroll(px) { ve.refs.tlScroll.scrollLeft = px; ve.refs.tlScroll.dispatchEvent(new Event('scroll')); return ve.follow; },
      scrollLeft() { return ve.refs.tlScroll.scrollLeft; },
      playheadTick() { updatePlayhead(); return ve.refs.tlScroll.scrollLeft; },
      fakePlaying(on) { Object.defineProperty(ve.refs.player, 'paused', { value: !on, configurable: true }); },
      // --- preview size ---
      previewBig() { return isPreviewBig(); },
      setPreviewBigHook(v) { setPreviewBig(v); return isPreviewBig(); },
      timelineHeight() { return $('#veTimeline').getBoundingClientRect().height; },
      previewHeight() { return ve.refs.drop.getBoundingClientRect().height; },
      fullBtnExists() { return !!$('#veFull') && !!$('#veFsExit'); },
      // --- captions: clear all ---
      clearCapsBtnVisible() { const b = $('#veClearCaps'); return !!b && !b.classList.contains('hidden'); },
      clickClearCaps() { $('#veClearCaps').dispatchEvent(new MouseEvent('click', { bubbles: true })); return (ve.capEvents || []).length; },
      capCount() { return (ve.capEvents || []).length; },
      capState() { return { events: (ve.capEvents || []).length, words: (ve.capWords || []).length, offset: ve.capOffset || 0, target: ve.capTarget ? ve.capTarget.id : null, mode: ve._capMode || null }; },
      // --- 💬 Auto-caption all shorts (shorts only, never the whole video) ---
      captionAllShorts() { return captionAllShorts(); },
      // The caption lines the 💬 Captions track holds for one clip (the single
      // store — there is no separate per-clip copy any more).
      clipCapEvents(id) { const s = ve.segments.find((x) => x.id === id); if (!s) return null; const l = capLinesIn(s); return l.length ? l.map((e) => ({ ...e })) : null; },
      /** Every line on the 💬 Captions lane, on the source's clock. */
      capLines() { return (ve.capEvents || []).map((e) => ({ start: e.start, end: e.end, text: e.text })); },
      // drive the two caption dropdowns the way a click on them does
      setCapWordsPerLine(v) { document.getElementById('capWords').value = String(v); rebuildCapEvents(); return this.capLines(); },
      setCapCase(v) { document.getElementById('capCase').value = String(v); rebuildCapEvents({ caseOnly: true }); return this.capLines(); },
      estimatedWords() { return wordsFromEvents(ve.capEvents).map((w) => ({ start: +w.start.toFixed(3), end: +w.end.toFixed(3), text: w.text })); },
      capSelIndex() { return ve.capSel; },
      /** Click a short card's 💬 button for real. */
      clickClipCaption(id) {
        const b = document.querySelector(`#veClipList [data-cap="${id}"]`);
        if (!b) return false;
        b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      },
      /* --- the captions WINDOW: what the operator can actually read and edit --- */
      capModal() {
        const box = document.getElementById('capModal');
        const rows = $$('#capList .cap-row');
        return {
          open: !!box && !box.classList.contains('hidden'),
          title: (document.getElementById('capTitle') || {}).textContent || '',
          burnLabel: (document.getElementById('capBurn') || {}).textContent || '',
          count: (document.getElementById('capCount') || {}).textContent || '',
          scope: ve.capScope ? ve.capScope.id : null,
          styleOptions: document.querySelectorAll('#capStyleSel option').length,
          modelOptions: document.querySelectorAll('#capModelSel option').length,
          rows: rows.length,
          texts: rows.map((r) => (r.querySelector('.cap-text') || {}).value),
          times: rows.map((r) => (r.querySelector('.cap-time') || {}).textContent),
        };
      },
      /** Retype a line in the window the way a person does, and commit it. */
      editCapRow(i, text) {
        const inp = $$('#capList .cap-text')[i];
        if (!inp) return null;
        inp.focus();
        inp.value = text;
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return { lane: (ve.capEvents || []).map((e) => e.text), row: inp.value };
      },
      closeCapModal() { closeCapModal(); return { scope: ve.capScope, open: !document.getElementById('capModal').classList.contains('hidden') }; },
      /* --- ▶ listening in the captions window --- */
      capPlayerState() {
        const p = ve.refs.player;
        const now = document.querySelector('#capList .cap-row.now');
        return {
          paused: !p || p.paused, t: p ? +(p.currentTime || 0).toFixed(3) : 0, rate: p ? p.playbackRate : 1,
          line: ve._capLine ? Object.assign({}, ve._capLine) : null,
          typePausedAt: ve._capTypePausedAt,
          playLabel: ($('#capPlay') || {}).textContent || '',
          time: ($('#capPlayTime') || {}).textContent || '',
          rowPlayButtons: $$('#capList .cap-row-play').length,
          nowRow: now ? +now.dataset.row : -1,
          beside: document.getElementById('capModal').classList.contains('beside'),
        };
      },
      capPlayLine(i) { capPlayLine(i); return this.capPlayerState(); },
      setCapModel(id) { setCapModel(id); return ve.capModel; },
      framingNow() { return Object.assign({}, ve.framing); },
      pxPerSecNow() { return ve.pxPerSec; },
      capTogglePlay() { capTogglePlay(); return this.capPlayerState(); },
      clickRowPlay(i) { const b = document.querySelector(`#capList .cap-row-play[data-play-i="${i}"]`); if (!b) return false; b.click(); return true; },
      seekPlayer(t) { seekTo(t); capPlayerPaint(true); return this.capPlayerState(); },
      capBeside() {
        const m = document.getElementById('capModal'), v = proView();
        return { beside: !!m && m.classList.contains('beside'), capmode: !!v && v.classList.contains('ve-capmode'),
          playerUnderPicture: !!$('#capPlayer') && $('#capPlayer').parentNode === $('#veMonitors'),
          folded: !!document.querySelector('#capModal .cap-box.folded'),
          summary: (document.getElementById('capSumChips') || {}).textContent || '' };
      },
      setCapFolded(f) { setCapFolded(!!f, false); return this.capBeside().folded; },
      /* --- ✍ the proof-reader --- */
      capGrammar() {
        return {
          summary: ($('#capGrammarFix') || {}).textContent || '',
          count: +(($('#capGrammarFix') || {}).dataset || {}).count || 0,
          rows: $$('#capList .cap-row').map((r) => ({
            i: +r.dataset.row,
            text: (r.querySelector('.cap-text') || {}).value,
            badge: r.querySelector('.cap-g-badge.hidden') ? '' : ((r.querySelector('.cap-g-badge') || {}).textContent || ''),
            marks: [...r.querySelectorAll('.cap-hl mark')].map((m) => m.textContent),
            card: r.querySelector('.cap-sugg') ? r.querySelector('.cap-sugg').textContent : null,
            chips: r.querySelectorAll('.cap-sugg-chip').length,
          })),
        };
      },
      grammarCheckLine(text, caseMode) { return window.CapGrammar ? window.CapGrammar.checkLine(text, { caseMode: caseMode || 'upper' }) : null; },
      fixAllGrammar() { return fixAllGrammar(); },
      async aiProofread(only) { const r = await aiProofread(only == null ? null : only); return r ? { shown: r.shown, by: r.by, unavailable: !!r.unavailable } : null; },
      capHearsInCloud() { return capHearsInCloud(); },
      async refreshCapCloud() { await refreshCapCloud(); await renderCapModels(); await populateCapModelSelect(); return { cloud: ve._capCloud, pref: ve.capModel }; },
      pauseHow(v) { const s = $('#vePauseHow'); if (s && v) { s.value = v; } return pauseHow(); },
      cachedCloudWords(id) { const s = ve.segments.find((x) => x.id === id); return s ? cachedCloudWords(s) : null; },
      /* --- the Word Book: corrections that stop having to be made twice --- */
      /** Seed BOTH halves of the caption store — the lines and the word timings
       *  the lines are re-broken from — which is the state a real transcription
       *  leaves behind, and the only state in which "does Words/line undo my
       *  correction?" can honestly be asked. */
      seedCaps(events, words) {
        ve.capEvents = (events || []).slice();
        ve.capWords = words ? words.slice() : null;
        ve._capSource = ve.video ? ve.video.path : null;
        ve._capMode = 'full';
        renderCapTrack(); renderCapList();
        return { lines: ve.capEvents.length, words: (ve.capWords || []).length };
      },
      capWordsText() { return (ve.capWords || []).map((w) => w.text); },
      capLinesText() { return (ve.capEvents || []).map((e) => e.text); },
      capFixNote() { return (document.getElementById('capFixNote') || {}).textContent || ''; },
      async openWordBook(on) {
        await showWordBook(on !== false);
        return this.wordBook();
      },
      wordBook() {
        const p = document.getElementById('capWordBookPanel');
        const rows = $$('#capWbList .cap-wb-row');
        return {
          open: !!p && !p.classList.contains('hidden'),
          button: (document.getElementById('capWordBook') || {}).textContent || '',
          count: (document.getElementById('capWbCount') || {}).textContent || '',
          enabled: !!(document.getElementById('capWbOn') || {}).checked,
          soundAlike: !!(document.getElementById('capWbSound') || {}).checked,
          fixes: rows.filter((r) => r.dataset.id).map((r) => ({
            id: r.dataset.id,
            from: (r.querySelector('.cap-wb-from') || {}).textContent || '',
            to: (r.querySelector('.cap-wb-to') || {}).textContent || '',
            on: !!(r.querySelector('.cap-wb-tog') || {}).checked,
            tag: (r.querySelector('.cap-wb-tag') || {}).textContent || '',
          })),
          names: rows.filter((r) => r.dataset.term).map((r) => (r.querySelector('.cap-wb-name') || {}).textContent || ''),
        };
      },
      /** Type a correction into the panel the way a person does. */
      async wbAdd(from, to) {
        document.getElementById('capWbFrom').value = from;
        document.getElementById('capWbTo').value = to;
        await wbAddFix();
        return this.wordBook();
      },
      async wbAddName(text) {
        document.getElementById('capWbTerm').value = text;
        await wbAddTerm();
        return this.wordBook();
      },
      async wbToggle(id, on) {
        const c = document.querySelector(`#capWbList .cap-wb-tog[data-id="${id}"]`);
        if (!c) return null;
        c.checked = !!on;
        c.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 60));
        return this.wordBook();
      },
      async wbDelete(id) {
        const b2 = document.querySelector(`#capWbList .cap-wb-del[data-id="${id}"]`);
        if (!b2) return null;
        b2.click();
        await new Promise((r) => setTimeout(r, 60));
        return this.wordBook();
      },
      /** The real 🪄 button above the words. */
      async clickFixNow() {
        document.getElementById('capFixNow').click();
        await new Promise((r) => setTimeout(r, 120));
        return { lines: this.capLinesText(), words: this.capWordsText(), note: this.capFixNote() };
      },
      /**
       * The GEOMETRY of the captions window — is the text actually reachable?
       * Measured, because "the layout is fine" is exactly the claim that was
       * wrong: the list was present in the DOM, correctly populated, and 40px
       * tall behind the buttons.
       */
      capModalLayout() {
        const box = document.querySelector('#capModal .cap-box');
        const list = document.getElementById('capList');
        const foot = document.querySelector('#capModal .cap-foot');
        if (!box || !list || !foot) return null;
        const lb = list.getBoundingClientRect(), bb = box.getBoundingClientRect(), fb = foot.getBoundingClientRect();
        const rows = $$('#capList .cap-row');
        const visibleRows = rows.filter((r) => {
          const rb = r.getBoundingClientRect();
          return rb.top >= lb.top - 1 && rb.bottom <= lb.bottom + 1;
        }).length;
        return {
          listH: Math.round(lb.height), boxH: Math.round(bb.height),
          rows: rows.length, visibleRows,
          scrollable: list.scrollHeight > list.clientHeight + 1,
          // the whole window, and its buttons, must be on the screen
          boxFitsViewport: bb.bottom <= window.innerHeight + 1 && bb.top >= -1,
          /*
           * The box has overflow:hidden, so a footer pushed past the bottom of
           * the BOX is invisible while still sitting inside the viewport —
           * which is exactly how an open panel clipped the Save button while a
           * viewport-only check reported everything fine. Measure against the
           * box, and against the footer's full height, not just its top edge.
           */
          footVisible: fb.height > 0 && fb.bottom <= bb.bottom + 1 && fb.top >= bb.top,
          footClippedBy: Math.max(0, Math.round(fb.bottom - bb.bottom)),
          styleOptions: document.querySelectorAll('#capStyleSel option').length,
          modelOptions: document.querySelectorAll('#capModelSel option').length,
        };
      },
      /**
       * Do any two stacked parts of the window sit on top of each other?
       *
       * Screenshots on some machines composite a stale frame over a fresh one,
       * which looks exactly like a broken layout — two headings drawn over each
       * other, a panel across the buttons. This asks the live DOM instead:
       * consecutive children of a column must not overlap, and every one of
       * them must be inside the box. Nothing here can be faked by a bad paint.
       */
      capModalOverlaps() {
        const box = document.querySelector('#capModal .cap-box');
        if (!box) return null;
        // Only the children in the FLOW can crowd each other out. An overlay
        // that is absolutely positioned over the window (the style gallery) is
        // meant to cover what is underneath, so counting it as an overlap would
        // make this check cry wolf and, worse, train someone to ignore it.
        const kids = [...box.children].filter((el) => {
          if (!el.getClientRects().length) return false;
          const pos = getComputedStyle(el).position;
          return pos !== 'absolute' && pos !== 'fixed';
        });
        const r = kids.map((el) => ({ el, b: el.getBoundingClientRect() }));
        const bad = [];
        for (let i = 1; i < r.length; i++) {
          if (r[i].b.top < r[i - 1].b.bottom - 1) {
            bad.push({ a: r[i - 1].el.className, b: r[i].el.className,
              overlapPx: Math.round(r[i - 1].b.bottom - r[i].b.top) });
          }
        }
        const bb = box.getBoundingClientRect();
        const outside = r.filter((x) => x.b.bottom > bb.bottom + 1 || x.b.top < bb.top - 1)
          .map((x) => x.el.className);
        /*
         * THE CHECK THAT WAS MISSING, and the reason a real bug was dismissed
         * as a screenshot artefact.
         *
         * Comparing the children's rectangles only catches boxes that overlap.
         * A flex child squeezed below the height of its own contents does NOT
         * overlap anything by that measure — its box is two pixels tall — while
         * the heading inside it spills out and paints straight over the next
         * section and the buttons. That is exactly what happened, it was
         * plainly visible in a screenshot, and this function reported "no
         * overlaps" the whole time. So: does each part actually FIT what is
         * inside it, unless it is a deliberate scroller.
         */
        const squashed = r.filter(({ el }) => {
          const scrolls = getComputedStyle(el).overflowY;
          if (scrolls === 'auto' || scrolls === 'scroll') return false;   // meant to scroll
          return el.scrollHeight > el.clientHeight + 1;
        }).map(({ el }) => ({ el: el.className, needs: el.scrollHeight, has: el.clientHeight }));
        return { children: kids.length, overlaps: bad, outsideBox: outside, squashed };
      },
      /* ---- which listening model captions use (a dropdown since v2.12.3) ---- */
      capModelRows() {
        const sel = document.getElementById('capModelSel');
        if (!sel) return [];
        return [...sel.options].map((o) => ({
          id: o.value, label: o.textContent, using: o.value === sel.value,
          needsDownload: o.value.startsWith('get:'),
        }));
      },
      pickCapModel(id) {
        const sel = document.getElementById('capModelSel');
        if (!sel || ![...sel.options].some((o) => o.value === id)) return null;
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return { chosen: ve.capModel, sentToEngine: capModelCfg(), shown: sel.options[sel.selectedIndex].textContent };
      },
      /** Edit a caption block exactly as a user does: real click on the block,
       *  type into the contenteditable label, commit with Enter. */
      async editCapByTyping(i, text) {
        const el = $$('#veCapTrack .ve-cap-clip')[i || 0];
        if (!el) return false;
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await new Promise((res) => setTimeout(res, 30));
        const lab = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label');
        if (!lab) return false;
        lab.textContent = text;
        lab.dispatchEvent(new InputEvent('input', { bubbles: true }));
        lab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await new Promise((res) => setTimeout(res, 30));
        return true;
      },
      capShortsButton() { const b = document.getElementById('veCapShorts'); return b ? { disabled: b.disabled, text: b.textContent } : null; },
      lenParams() { return shortLenParams(); },
      // --- caption defaults ---
      capDefaults() {
        return {
          style: ve.capStyleId, font: $('#capFont').value, case: $('#capCase').value,
          cfg: capStyleCfg(), reframe: reframeOn(),
        };
      },
      /** Re-run the "what look do we start with?" decision (as a fresh install would). */
      // A fresh install starts from the default IN MEMORY too: with nothing saved,
      // capStyleDef() keeps whatever is current, so a look left by an earlier
      // suite in the shared profile would otherwise survive the "fresh install".
      forgetCapStyle() { try { localStorage.removeItem(LIB_KEYS.capStyle); } catch (e) {} ve.capStyleId = DEFAULT_CAP_STYLE; applySavedCapStyle(); return ve.capStyleId; },
      capStyleKey() { return LIB_KEYS.capStyle; },
      // --- frame fill (background blur) + background-noise removal ---
      /** Everything an export would be handed, plus what the UI is showing. */
      fillState() {
        const bg = document.getElementById('veBlurBg');
        return {
          mode: ve.fill.mode, strength: ve.fill.strength, dim: ve.fill.dim,
          cfg: fillCfg(), reframeOn: reframeOn(),
          select: ($('#veFill') || {}).value,
          optsVisible: !!($('#veFillOpts') && !$('#veFillOpts').classList.contains('hidden')),
          reframeDisabled: !!($('#veAutoReframe') || {}).disabled,
          // how the preview is drawing it: scale, and whether the blurred
          // backdrop canvas is on screen
          canvasScale: ve.canvasMap ? ve.canvasMap.s : null,
          cropWindow: ve.canvasMap ? ve.canvasMap.cwin : null,
          blurBg: !!(bg && bg.classList.contains('on')),
          blurFilter: bg ? bg.style.filter : '',
          // the backdrop is only actually VISIBLE if the player stops painting
          // its own black background over it
          playerBg: ve.refs.player ? getComputedStyle(ve.refs.player).backgroundColor : '',
          bgBehindPlayer: !!(bg && ve.refs.player &&
            (bg.compareDocumentPosition(ve.refs.player) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
          bgRect: bg ? { l: Math.round(parseFloat(bg.style.left)), t: Math.round(parseFloat(bg.style.top)), w: Math.round(parseFloat(bg.style.width)), h: Math.round(parseFloat(bg.style.height)) } : null,
        };
      },
      setFill(mode) { const s = $('#veFill'); if (s) s.value = mode; setFillMode(mode); return this.fillState(); },
      setFillStrength(pct) {
        const s = $('#veFillStrength'); if (s) { s.value = String(pct); s.dispatchEvent(new Event('input')); }
        return this.fillState();
      },
      denoiseState() {
        return {
          on: ve.denoise.on, level: ve.denoise.level, cfg: denoiseCfg(),
          checked: !!($('#veDenoise') || {}).checked,
          optsVisible: !!($('#veDenoiseOpts') && !$('#veDenoiseOpts').classList.contains('hidden')),
        };
      },
      setDenoise(on, level) {
        const c = $('#veDenoise'); if (c) { c.checked = !!on; c.dispatchEvent(new Event('change')); }
        if (level) { const l = $('#veDenoiseLevel'); if (l) { l.value = level; l.dispatchEvent(new Event('change')); } }
        return this.denoiseState();
      },
      /** Wipe the remembered choices and re-read them, as a fresh install would. */
      forgetExportPrefs() {
        try { Object.values(FILL_KEYS).forEach((k) => localStorage.removeItem(k)); } catch (e) {}
        ve.fill = { mode: 'crop', strength: 0.6, dim: 0.18 };
        ve.denoise = { on: false, level: 'medium' };
        loadExportPrefs();
        return { fill: this.fillState(), denoise: this.denoiseState() };
      },
      /** Re-read from storage without touching it — proves the choice stuck. */
      reloadExportPrefs() { loadExportPrefs(); return { fill: this.fillState(), denoise: this.denoiseState() }; },
      exportPrefKeys() { return FILL_KEYS; },
      // --- undo/redo ---
      undo() { undoVideo(); }, redo() { redoVideo(); },
      historyLen() { return ve.history.length; }, futureLen() { return ve.future.length; },
      undoBtnDisabled() { return document.getElementById('veUndo').disabled; },
      redoBtnDisabled() { return document.getElementById('veRedo').disabled; },
      setCapEvents(evts, off) { ve.capEvents = evts; ve.capWords = evts; ve.capOffset = off || 0; ve.capTarget = off ? ve.capTarget : null; ve.capSel = null; ve.capEditing = null; renderCapTrack(); },
      /** Feed REAL word timings through the app's own grouping + reveal path. */
      setCapWords(words, off) {
        ve.capWords = words; ve.capOffset = off || 0; ve.capTarget = null;
        ve._capSource = ve.video ? ve.video.path : null; ve._capMode = 'full';
        rebuildCapEvents();
        return (ve.capEvents || []).length;
      },
      revealCaps() { revealCaptions(); },
      // --- captions timeline track (CapCut-style) ---
      capTrackBlocks() {
        return $$('#veCapTrack .ve-cap-clip').map((el) => ({
          i: +el.dataset.i, left: parseFloat(el.style.left), width: parseFloat(el.style.width),
          text: el.querySelector('.ve-cc-label').textContent,
        }));
      },
      capTrackEmptyShown() { const e = document.querySelector('#veCapTrack .ve-cap-empty'); return !!e; },
      capSaveBtnVisible() { const b = document.getElementById('veSaveCaps'); return !!b && !b.classList.contains('hidden'); },
      capLaneLabel() { const l = document.getElementById('veCapLabel'); return l ? l.textContent : ''; },
      /** What the user ACTUALLY SEES on a caption block: its rendered size and
       *  whether the whole caption text fits (no ellipsis) inside it. */
      capBlockReadout(i) {
        const el = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"]`); if (!el) return null;
        const label = el.querySelector('.ve-cc-label');
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          text: label.textContent,
          fontPx: parseFloat(getComputedStyle(label).fontSize),
          // the label's natural width vs the space it has -> is the phrase whole?
          needed: Math.ceil(label.scrollWidth), have: Math.ceil(label.clientWidth),
          fullyVisible: label.scrollWidth <= label.clientWidth + 1,
          opaque: cs.backgroundColor, color: cs.color,
          // is this block actually inside the visible scroll window?
          onScreen: (() => {
            const sr = ve.refs.tlScroll.getBoundingClientRect();
            return r.right > sr.left && r.left < sr.right && r.width >= 1;
          })(),
        };
      },
      /** Is the caption lane painting words a human can read right now? */
      capWordsReadable() {
        const blocks = $$('#veCapTrack .ve-cap-clip');
        const sr = ve.refs.tlScroll.getBoundingClientRect();
        const vis = blocks.filter((el) => { const r = el.getBoundingClientRect(); return r.right > sr.left && r.left < sr.right; });
        const withWords = vis.filter((el) => {
          const lab = el.querySelector('.ve-cc-label');
          return lab.textContent.trim().length > 0 && lab.clientWidth >= 24; // room for real words
        });
        return { visible: vis.length, withWords: withWords.length };
      },
      /**
       * Click caption line `i` on the lane the way a person does.
       *
       * Zoomed far out the lane draws coverage bars rather than a block per
       * line, so "click that caption" means clicking the bar at that line's
       * position — which is exactly what the operator does, and it must land in
       * the same place: zoomed in, with the caret in that line's words.
       */
      clickCapBlock(i) {
        const el = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"]`);
        if (el) {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + r.width / 2, clientY: r.top + 5, bubbles: true }));
          document.dispatchEvent(new MouseEvent('mouseup'));
          return true;
        }
        const c = (ve.capEvents || [])[i]; if (!c) return false;
        const x = ((capAbs(c) + capAbsEnd(c)) / 2) * ve.pxPerSec;
        const bar = [...document.querySelectorAll('#veCapTrack .ve-cap-run')]
          .find((b) => x >= b.offsetLeft - 1 && x <= b.offsetLeft + b.offsetWidth + 1);
        if (!bar) return false;
        const br = bar.getBoundingClientRect();
        bar.dispatchEvent(new MouseEvent('click', { clientX: br.left + (x - bar.offsetLeft), clientY: br.top + 5, bubbles: true }));
        return true;
      },
      capEditingIndex() { return ve.capEditing; },
      /** Type into whichever caption block is currently in edit mode. */
      typeIntoCapEdit(text) {
        const el = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label');
        if (!el) return false;
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
        return true;
      },
      capEditKey(key, shift) {
        const el = document.querySelector('#veCapTrack .ve-cap-clip.editing .ve-cc-label');
        if (!el) return false;
        const ev = new KeyboardEvent('keydown', { key, shiftKey: !!shift, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        if (!ev.defaultPrevented) return true;
        if (key === 'Enter' || key === 'Tab') el.dispatchEvent(new FocusEvent('blur'));
        return true;
      },
      capEditBoxWidth() {
        const el = document.querySelector('#veCapTrack .ve-cap-clip.editing');
        return el ? Math.round(el.getBoundingClientRect().width) : 0;
      },
      editCapBlock(i, newText) {
        startEditingCap(i);
        const label = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"] .ve-cc-label`);
        if (!label) return false;
        label.textContent = newText;
        label.dispatchEvent(new FocusEvent('blur'));
        return ve.capEvents[i] && ve.capEvents[i].text === newText.replace(/\s+/g, ' ').trim();
      },
      capZoom() { return ve.pxPerSec; },
      videoDuration() { return dur(); },
      playheadTime() { return ve.refs.player.currentTime || 0; },
      capScrollLeft() { return ve.refs.tlScroll ? ve.refs.tlScroll.scrollLeft : 0; },
      capOverlayText() {
        const lines = this.capOverlayLines();
        return lines ? lines.join(' ') : null;
      },
      /** The caption on the preview, one entry per line it actually wraps onto —
       *  the thing that has to match the exported file line for line. */
      capOverlayLines() {
        const ov = ve.refs.capOverlay;
        if (!ov || ov.classList.contains('hidden') || !ov.firstElementChild) return null;
        return [...ov.firstElementChild.querySelectorAll('span')].map((s) => s.textContent);
      },
      /** The block's rectangle on the preview, as fractions of the export frame. */
      capOverlayBox() {
        const L = ve._capLayout, fr = canvasFrameRect();
        if (!L || !fr) return null;
        return {
          x: L.cx / fr.w, y: L.cy / fr.h, w: L.blockW / fr.w, h: L.blockH / fr.h,
          lines: L.lines.length, fontPx: L.m.fontPx, frame: { w: fr.w, h: fr.h },
        };
      },
      /** The export frame's rectangle in window coordinates — what to screenshot
       *  when you want "the picture the file will contain, and nothing else". */
      frameRect() {
        const fr = canvasFrameRect(); if (!fr) return null;
        const r = ve.refs.preview.getBoundingClientRect();
        return {
          x: Math.round(r.left + fr.left), y: Math.round(r.top + fr.top),
          width: Math.round(fr.w), height: Math.round(fr.h),
        };
      },
      /* ---- 📦 bulk: many videos, one graphic over all of them ---- */
      bulkAdd(paths) { return addBulkVideos(paths); },
      bulkFiles() { return ve.bulk.files.map((f) => ({ path: f.path, name: f.name, w: f.info.width, h: f.info.height })); },
      bulkOverlays() { return ve.bulk.overlays.map((o) => ({ ...o })); },
      bulkSel() { return ve.bulk.sel; },
      bulkOpen(i) { return openBulkVideo(i); },
      /** Add the batch's picture without the file dialog (same code path after it). */
      bulkSetImage(src) { return addBulkImage(src); },
      bulkSetOpacity(id, v) { setBulkOpacity(id, v); return ve.bulk.overlays.find((o) => o.id === id) || null; },
      /** What the preview is actually showing for the batch graphic. */
      bulkPreviewOpacity() {
        const s = ve.segments.find((x) => x.bulk); if (!s) return null;
        const el = ve.refs.mediaLayer && ve.refs.mediaLayer.querySelector(`[data-mid="${s.id}"]`);
        return el ? (el.style.opacity === '' ? 1 : Number(el.style.opacity)) : null;
      },
      /** Drive the real preview box, exactly as a mouse would. */
      bulkDragImage(dxPx, dyPx, resize) {
        const g = document.getElementById('veOverlayGuide');
        if (!g || g.classList.contains('hidden')) return null;
        const r = g.getBoundingClientRect();
        const target = resize ? g.querySelector('[data-ovresize]') : g;
        const sx = resize ? r.right - 4 : r.left + r.width / 2;
        const sy = resize ? r.bottom - 4 : r.top + r.height / 2;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: sx + dxPx, clientY: sy + dyPx }));
        document.dispatchEvent(new MouseEvent('mouseup'));
        return ve.bulk.overlays.map((o) => ({ pipX: o.pipX, pipY: o.pipY, pipW: o.pipW }));
      },
      /** The box drawn on the preview, as fractions of the VIDEO's own picture —
       *  the same numbers the compositor scales by. */
      bulkGuideBox() {
        const s = ve.segments.find((x) => x.bulk); if (!s) return null;
        const r = overlayPreviewRect(s), f = r.fr;
        return {
          x: (r.left - f.left) / f.w, y: (r.top - f.top) / f.h,
          w: r.w / f.w, h: r.h / f.h,
        };
      },
      /** Exactly what each video in the batch will be composited with. */
      bulkPayload(i) {
        const f = ve.bulk.files[i]; return f ? bulkOverlayPayload(f) : null;
      },
      bulkExport() { return exportBulk(); },
      bulkClear() { clearBulk(); },
      bulkPanel() {
        const box = document.getElementById('veBulkBox');
        return {
          shown: !!box && !box.classList.contains('hidden'),
          rows: document.querySelectorAll('#veBulkList [data-bulk]').length,
          overlayRows: document.querySelectorAll('#veBulkOverlays .ve-bulk-ovl').length,
          exportEnabled: !document.getElementById('veBulkExport').disabled,
          exportLabel: (document.getElementById('veBulkExport').textContent || '').trim(),
        };
      },
      capWidthNow() { return window.CapLayout.widthFrac({ width: ve.capWidth }); },
      setCapWidth(v) {
        ve.capWidth = clamp(Number(v), window.CapLayout.MIN_WIDTH, window.CapLayout.MAX_WIDTH);
        updateCapOverlay(ve.refs.player ? (ve.refs.player.currentTime || 0) : 0);
        syncCapWidthControl();
        return this.capOverlayBox();
      },
      /** Drive the real edge handle, exactly as a mouse would. */
      dragCapWidthEdge(side, deltaPx) {
        const h = document.querySelector(`#veCapOverlay [data-capedge="${side}"]`);
        if (!h) return null;
        const r = h.getBoundingClientRect();
        h.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + 6, clientY: r.top + 6, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 6 + deltaPx, clientY: r.top + 6 }));
        document.dispatchEvent(new MouseEvent('mouseup'));
        return this.capOverlayBox();
      },
      /** The export payload: the caption track that actually gets burned in. */
      capTrackFor(events, outW, outH, durationSec) {
        return capTrackForExport(events, capStyleCfg(), outW, outH, durationSec);
      },
      capLayoutAt(text, outW, outH) {
        const L = window.CapLayout.layout(text, capStyleCfg(), outW, outH);
        return { lines: L.lines, cx: L.cx, cy: L.cy, blockW: L.blockW, blockH: L.blockH, fontPx: L.m.fontPx };
      },
      dragCapEdge(i, edge, deltaPx) {
        const el = document.querySelector(`#veCapTrack .ve-cap-clip[data-i="${i}"]`); if (!el) return false;
        const target = edge ? el.querySelector(`.ve-cc-h.${edge}`) : el;
        const r = target.getBoundingClientRect();
        target.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + 2, clientY: r.top + 5, bubbles: true }));
        document.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 2 + deltaPx, clientY: r.top + 5 }));
        document.dispatchEvent(new MouseEvent('mouseup'));
        return true;
      },
      capEventsState() { return (ve.capEvents || []).map((c) => ({ start: c.start, end: c.end, text: c.text })); },
      deleteSelectedCap() { ve.activeRow = 'caption'; document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })); },
      setAspect(a) { ve.aspect = a; const sel = document.getElementById('veAspect'); if (sel) sel.value = a; updateCropMask(); },
      cropMaskVisible() { return ve.refs.cropMask && !ve.refs.cropMask.classList.contains('hidden'); },
      cropFrameRect() { const r = ve.refs.cropFrame.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; },
      cropMatteBoxShadow() { return getComputedStyle(ve.refs.cropFrame).boxShadow; }, // solid black = CapCut framing
      // live face-tracking preview: set a face x/y and read where the crop frame lands
      setLiveFace(cx, cy) { ve.liveFaceCx = cx; ve.liveFaceCy = cy; updateCropMask(); },
      // live face-tracking preview: feed ONE raw detection tick through the real
      // dead-band/EMA/jump/leash pipeline (applyLiveFaceSample) — same code path
      // updateLiveReframe uses, without needing a live <video> element.
      liveTick(cxNorm, cyNorm, poseCx, poseCy) { const moved = applyLiveFaceSample({ cxNorm, cyNorm, poseCx, poseCy }); if (moved) updateCropMask(); return moved; },
      liveFaceState() { return { cx: ve.liveFaceCx, cy: ve.liveFaceCy }; },
      resetLiveTrack() { resetLiveTrack(); },
      /* ---- who the shorts follow ---- */
      /* ---- captions already burned into the recording ---- */
      coverState() {
        const strip = document.getElementById('veCoverStrip');
        return {
          on: !!ve.cover.on, mode: ve.cover.mode, y: ve.cover.y, h: ve.cover.h,
          cfg: coverCfg(), optsVisible: !!($('#veCoverOpts') && !$('#veCoverOpts').classList.contains('hidden')),
          strip: strip ? { top: parseFloat(strip.style.top), height: parseFloat(strip.style.height) } : null,
        };
      },
      setCover(patch) { setCover(patch); return this.coverState(); },

      /* ---- the short's thumbnail ---- */
      async openThumb(id) { await openThumbPicker(id); const m = $('#thumbModal'); return { open: !!m && !m.classList.contains('hidden'), at: ve._thumbAt }; },
      closeThumb() { closeThumbPicker(); const m = $('#thumbModal'); return !!m && !m.classList.contains('hidden'); },
      thumbScrub(v) { const sl = $('#thumbAt'); if (!sl) return null; sl.value = String(v); sl.dispatchEvent(new Event('input')); return ve._thumbAt; },
      thumbUse() { const id = ve._thumbSeg; const b = $('#thumbUse'); if (b) b.click(); return this.clipThumb(id); },
      clipThumb(id) { const x = ve.segments.find((y) => y.id === id); return x && x.thumbPick ? Object.assign({}, x.thumbPick) : null; },
      setClipThumbAt(id, at) { const x = ve.segments.find((y) => y.id === id); setClipThumb(x, { at }); return this.clipThumb(id); },
      clearClipThumb(id) { const x = ve.segments.find((y) => y.id === id); setClipThumb(x, null); return this.clipThumb(id); },
      thumbButtons() { return $$('#veClipList [data-thumb]').length; },
      async applyThumb(id, file) { const x = ve.segments.find((y) => y.id === id); return applyThumbTo(x, file); },

      /* ---- saved sessions ---- */
      videoPath() { return ve.video ? ve.video.path : null; },
      sessionChip() { return { name: ve.sessionName || 'Unsaved session', dirty: !!ve.sessionDirty, id: ve.sessionId || null }; },
      async saveSessionAs(name) { ve.sessionName = name; ve.sessionId = null; return await saveSession(false); },
      async openSession(id) { return await openSessionById(id); },
      /** Give every short the full-size PNG a pre-2.80 session carried, plus the
       *  stuck "making one" flag. */
      plantOldThumbs() {
        const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
        const g = c.getContext('2d'), im = g.createImageData(1280, 720);
        for (let i = 0; i < im.data.length; i++) im.data[i] = (i % 4 === 3) ? 255 : (Math.random() * 255) | 0;
        g.putImageData(im, 0, 0);
        const big = c.toDataURL('image/png');
        shortsOf().forEach((s, i) => { if (i === 0) { s.thumb = big; } else { delete s.thumb; s._thumbing = true; } });
        return big.length;
      },
      /* ---- 🧠 the AI referee ---- */
      reframeAiUi() {
        const n = $('#veRfAiState'), k = $('#veRfAiKey'), r = $('#veRfAiRow');
        return { mode: reframeAiMode(), select: ($('#veRfAi') || {}).value, note: n ? n.textContent : null, cls: n ? n.className : '',
          keyShown: !!k && !k.classList.contains('hidden'), rowShown: !!r && !r.classList.contains('hidden'), state: ve.rfAi.state, last: ve.rfAi.last };
      },
      setReframeAiMode(v) { const s = $('#veRfAi'); if (s) { s.value = v; s.dispatchEvent(new Event('change')); } return reframeAiMode(); },
      async refreshReframeAi() { await refreshReframeAi(); return this.reframeAiUi(); },
      noteReframeAi(rep) { noteReframeAi(rep); return this.reframeAiUi(); },
      hasReferee() { return !!reframeReferee(); },
      shortThumbs() { return shortsOf().map((s) => ({ id: s.id, len: s.thumb ? s.thumb.length : 0, jpeg: !!s.thumb && s.thumb.startsWith('data:image/jpeg'), busy: !!s._thumbing })); },
      flushSession() { return writeAutosave(); },
      collectSession() { return collectSession(); },
      async offerResume() { ve._resumeOffered = false; await offerResume(); const b = $('#veResume'); return { shown: !!b && !b.classList.contains('hidden'), text: b ? b.textContent.trim().slice(0, 80) : null }; },
      resumeClick(which) { const b = $(which === 'yes' ? '#veResumeYes' : '#veResumeNo'); if (b) b.click(); return !!b; },
      sessionsWindow() { const m = $('#sessModal'); return { open: !!m && !m.classList.contains('hidden'), cards: $$('#sessList .sess-card').length }; },
      async openSessionsWindow() { await openSessionsWindow(); return this.sessionsWindow(); },
      closeSessionsWindow() { closeSessionsWindow(); return this.sessionsWindow(); },
      shortLabels() { return ve.segments.filter((x) => x.ai).map((x) => x.label); },
      shortLabel(id) { const x = ve.segments.find((y) => y.id === id); return x ? x.label : null; },
      renameShort(id, label) { const x = ve.segments.find((y) => y.id === id); if (x) { x.label = label; renderSegments(); renderClipList(); touchSession(); } return x ? x.label : null; },
      aspect() { return ve.aspect; },
      followState() {
        const row = $('#veFollowRow'), who = $('#veFollowWho');
        let stored = null;
        try { stored = JSON.parse(localStorage.getItem('mw-ve-follow') || 'null'); } catch (e) {}
        return {
          hasRow: !!row, rowHidden: !!row && row.classList.contains('hidden'),
          hasButton: !!$('#veFollowPick'),
          chip: who ? who.textContent.trim() : null,
          hasFace: !!(who && who.querySelector('.ve-follow-face')),
          locked: !!ve.subject,
          stored: !!(stored && stored.sig),
          modalOpen: !!($('#followModal') && !$('#followModal').classList.contains('hidden')),
        };
      },
      // Drive the pick without needing a real face: the picker's job is to hand
      // setSubject a signature, and everything downstream only cares that it did.
      pickPerson(sig, thumb) { setSubject({ sig, thumb: thumb || null, at: 0 }); return this.followState(); },
      clearPerson() { setSubject(null); return this.followState(); },
      forgetFollow() { ve.subject = null; try { localStorage.removeItem('mw-ve-follow'); } catch (e) {} renderFollowRow(); return this.followState(); },
      reloadFollow() { ve.subject = null; loadSubject(); renderFollowRow(); return this.followState(); },
      // What detectFrames would actually be handed for this clip.
      lockForClip(id) {
        const seg = id ? ve.segments.find((x) => x.id === id) : null;
        const clip = seg && seg.subject ? unpackClipSubject(seg) : null;
        const lock = clip || followLock();
        return { fromClip: !!clip, any: !!lock, bins: lock && lock.up ? lock.up.length : 0 };
      },
      setClipPerson(id, sig) { const seg = ve.segments.find((x) => x.id === id); if (seg) seg.subject = { sig, thumb: null, at: 0 }; renderClipList(); return this.lockForClip(id); },
      clipHasPerson(id) { const seg = ve.segments.find((x) => x.id === id); return !!(seg && seg.subject); },
      clipFollowButtons() { return $$('#veClipList [data-who]').length; },
      async openPicker(id, one) { await openFollowPicker(id || null, !!one); return { open: this.followState().modalOpen, title: ($('#followModal .cap-head h2') || {}).textContent }; },
      closePicker() { closeFollowPicker(); return this.followState().modalOpen; },
      pickerPeople() { return $$('#followCards .follow-card').length; },
      pickerHint() { const h = $('#followHint'); return h ? h.textContent : null; },
      clickPickerPerson(i) { const c = $$('#followCards .follow-card')[i]; if (c) c.click(); return this.followState(); },
      // the ON-SCREEN render position (tickLiveRender's ~60fps glide toward liveFaceState()'s
      // target, normally driven by the background requestAnimationFrame loop) — what a viewer
      // actually sees, as opposed to the target itself.
      liveRenderState() { return { cx: liveRenderCx, cy: liveRenderCy }; },
      // Advance the render glide by an EXACT dt (seconds) without depending on real
      // requestAnimationFrame ticks — Chromium throttles rAF to ~1fps for windows that are
      // never shown (as these test harnesses use), regardless of backgroundThrottling, so a
      // real-time-based test can't exercise this reliably. The real, visible app window has
      // no such throttling. Same underlying function the live rAF loop calls every frame.
      liveRenderTick(dt) { return tickLiveRender(dt); },
      // Stop the background rAF loop while a test drives frames via liveRenderTick —
      // otherwise the (1fps-throttled) real loop interleaves its own steps (dt clamped to
      // 0.05s) between the synthetic ones, double-stepping the glide mid-measurement.
      liveRenderLoopStop() { if (liveRenderRAF != null) { cancelAnimationFrame(liveRenderRAF); liveRenderRAF = null; } },
      cropFrameLeft() { return parseFloat(ve.refs.cropFrame.style.left) || 0; },
      // CapCut canvas: the VIDEO's pan/zoom under the fixed export frame
      canvasTransform() { return ve._canvasT || ''; },
      videoPanX() { const m = /translate\((-?[\d.]+)px/.exec(ve._canvasT || ''); return m ? parseFloat(m[1]) : 0; },
      canvasScale() { const m = /scale\(([\d.]+)\)/.exec(ve._canvasT || ''); return m ? parseFloat(m[1]) : 1; },
      overlayAt(t) {
        updateCapOverlay(t);
        // Each wrapped line is its own element now (a boxed look paints a band
        // per line), so the words have to be re-joined — reading textContent
        // straight off the block would run "HELLO" into "CHURCH".
        return this.capOverlayText();
      },
      // --- pan/zoom crop ---
      setFraming(zoom, ox, oy) { ve.framing = { zoom, offsetX: ox, offsetY: oy }; updateCropMask(); },
      getFraming() { return { ...ve.framing }; },
      resetCrop() { resetCrop(); },
      cropReframeDecision() {
        const f = ve.framing;
        return !!(Math.abs(f.zoom - 1) > 0.01 || Math.abs(f.offsetX - 0.5) > 0.01 || Math.abs(f.offsetY - 0.5) > 0.01);
      },
      // --- text overlays ---
      addTextAt(opts) {
        const t = ve.refs.player.currentTime || 0;
        const ov = Object.assign({ id: uid(), text: 'Your text', x: 0.5, y: 0.5, w: 0.86, h: 0.12, start: t, end: Math.min(dur(), t + 5), color: '#ffffff', sizePct: 0.11, font: 'Arial', bold: true }, opts || {});
        ve.textOverlays.push(ov); ve.textSel = ov.id; renderTextOverlays(); renderTextTrack(); return ov.id;
      },
      textOverlayCount() { return ve.textOverlays.length; },
      textBoxDomCount() { return $$('#veTextLayer .ve-text-box').length; },
      textTrackDomCount() { return $$('#veTextTrack .ve-text-clip').length; },
      textTimeOf(id) { const o = ve.textOverlays.find((x) => x.id === id); return o ? { start: o.start, end: o.end } : null; },
      textTrimHandleCount() { return $$('#veTextTrack .ve-text-clip .ve-tc-h').length; },
      // Simulate a real drag of a text block's trim handle (edge='l'|'r') or body (edge=null).
      dragTextEdge(id, edge, deltaPx) {
        const el = ve.refs.textTrack.querySelector(`.ve-text-clip[data-id="${id}"]`);
        if (!el) return null;
        const target = edge ? el.querySelector(`.ve-tc-h.${edge}`) : el;
        const r = target.getBoundingClientRect();
        const x0 = r.left + r.width / 2;
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x0, clientY: r.top + 5 }));
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x0 + deltaPx, clientY: r.top + 5 }));
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const o = ve.textOverlays.find((x) => x.id === id);
        return o ? { start: o.start, end: o.end } : null;
      },
      seekAndRefresh(t) { seekTo(t); renderTextOverlays(); },
      // --- audio waveform (now painted INSIDE each clip, not one full-track img) ---
      audioTrackHasImage() {
        if (ve.waveformUrl) return true;
        const seg = ve.refs.audioSegments && ve.refs.audioSegments.querySelector('.ve-audio-seg');
        return !!(seg && /url\(/.test(seg.style.backgroundImage || ''));
      },
      setWaveformUrl(u) { ve.waveformUrl = u; renderAudioSegments(); },
      audioSegHasWaveSlice(id) {
        const el = ve.refs.audioSegments.querySelector(`.ve-audio-seg[data-id="${id}"]`);
        return !!(el && /url\(/.test(el.style.backgroundImage || ''));
      },
      audioTrackBgIsEmptyHatch() {
        const cs = getComputedStyle(ve.refs.audioTrack);
        return /repeating-linear-gradient/.test(cs.backgroundImage || cs.background || '');
      },
      // --- live effects preview ---
      applyFxPreview(vals) {
        const q = (id) => document.getElementById(id);
        Object.entries(vals || {}).forEach(([k, v]) => {
          const el = q(k); if (!el) return;
          if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
        });
        updateFxPreview();
      },
      fxPreviewState() {
        const p = ve.refs.player;
        return { playbackRate: p.playbackRate, volume: p.volume, filter: p.style.filter, transform: p.style.transform };
      },
      resetFxPreview() { resetFxPreview(); },

      /* --- background music, outro clips, caption looks, pause removal --- */
      openLibrary(tab) { openLibrary(tab); return { open: !$('#libModal').classList.contains('hidden'), tab: ve.libTab }; },
      closeLibrary() { stopAudition(); $('#libModal').classList.add('hidden'); },
      libState() { return { music: (ve.lib.music || []).length, clips: (ve.lib.clips || []).length }; },
      async libReload() { return libRefresh(); },
      setLib(lib) { ve.lib = Object.assign({ music: [], clips: [] }, lib || {}); renderLibrary(); return ve.lib; },
      useMusic(id) { useMusic(id); return ve.music && { id: ve.music.id, volume: ve.music.volume, bed: ve.music.bed }; },
      clearMusic() { clearMusic(); return ve.music; },
      musicState() { return ve.music ? Object.assign({}, ve.music) : null; },
      setMusicVolume(v) {
        const el = document.getElementById('libMusicVol'); if (!el) return null;
        el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true }));
        return ve.music ? ve.music.volume : null;
      },
      musicLaneWidthPx() { const b = ve.refs.musicTrack && ve.refs.musicTrack.querySelector('.ve-music-seg'); return b ? parseFloat(b.style.width) : 0; },
      musicPosAt(t) { return musicPosFor(t); },
      useOutro(id) { useOutro(id); return ve.outro && { id: ve.outro.id, all: ve.outroAll }; },
      clearOutro() { clearOutro(); return ve.outro; },
      outroState() { return ve.outro ? { id: ve.outro.id, name: ve.outro.name, all: ve.outroAll !== false, durationSec: ve.outro.durationSec } : null; },
      outroBlockPx() {
        const el = ve.refs.segments.querySelector('.ve-seg-outro');
        return el ? { left: parseFloat(el.style.left), width: parseFloat(el.style.width) } : null;
      },
      trackWidthPx() { return trackW(); },
      // caption looks
      capStyles() { return CAP_STYLES.map((s) => s.id); },
      /** Every look the Style picker offers (a dropdown since v2.12.3). */
      capStyleCards() { return [...document.querySelectorAll('#capStyleSel option')].map((o) => o.value); },
      pickCapStyle(id) {
        const sel = document.getElementById('capStyleSel');
        if (sel) { sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        else setCapStyle(id);
        return capStyleCfg();
      },
      openCapStylePicker(on) {
        if (on === false) return showCapStylePicker(false);
        const chip = document.getElementById('capStyleSample');
        if (chip) chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const p = document.getElementById('capStylePicker');
        return !!p && !p.classList.contains('hidden');
      },
      /** The live sample beside the picker — it must wear the chosen look. */
      capStyleSampleCss() {
        const el = document.getElementById('capStyleSample');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { color: cs.color, background: cs.backgroundColor, shadow: cs.textShadow, text: el.textContent };
      },
      capStyleCfg() { return capStyleCfg(); },
      updateCapOverlayAt(t) { updateCapOverlay(t); return !ve.refs.capOverlay.classList.contains('hidden'); },
      addText() { addTextOverlay(); return ve.textSel; },
      textPos(id) { const o = ve.textOverlays.find((x) => x.id === (id || ve.textSel)); return o ? { x: o.x, y: o.y } : null; },
      keptDurOf(id) { const s = ve.segments.find((x) => x.id === id); return s ? keptDur(s) : null; },
      capOverlayCss() {
        // the look lives on each LINE now (a boxed style paints a band per line,
        // the way CapCut does and the way the burn does)
        const block = ve.refs.capOverlay && ve.refs.capOverlay.firstElementChild;
        const span = block && block.querySelector('span');
        if (!span) return null;
        return {
          color: span.style.color,
          background: span.style.background || 'transparent',
          stroke: span.style.webkitTextStroke,
          shadow: span.style.textShadow,
        };
      },
      // comma stripping / grouping
      groupWords(words, wpl, tc) { return groupWords(words, wpl, tc); },
      // pause removal
      setRemovePauses(on) { const c = $('#veRemovePauses'); if (c) c.checked = !!on; return removePausesOn(); },
      async removePauses(ids) {
        const list = (ids && ids.length) ? ve.segments.filter((s) => ids.includes(s.id)) : ve.segments.filter((s) => s.ai);
        return removePausesIn(list, { quiet: true });
      },
      cutsFor(id) { const s = ve.segments.find((x) => x.id === id); return s ? cutsOf(s).map((c) => ({ start: c.start, end: c.end })) : null; },
      // cancel button
      cancelVisible() { const b = document.getElementById('overlayCancel'); return !!(b && !b.classList.contains('hidden')); },
    },
  };
})();
