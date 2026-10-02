'use strict';
/**
 * 🔴 Go Live studio (window.LiveStudio) — a vMix-style production switcher.
 *
 * Multi-input mixer: cameras, video files, images, titles, screen captures,
 * solid colours and audio-only inputs sit on the input bar. Clicking an input
 * sends it to PREVIEW (orange); Cut / Fade / the T-bar / Quick Play take it to
 * PROGRAM (green). The program is composited on a canvas at the output
 * resolution — transitions, overlay channels 1-4 and FTB are all drawn there —
 * and that canvas is what gets recorded (MP4 via ffmpeg) and streamed
 * (RTMP/RTMPS via ffmpeg), so what you see on the Output monitor is exactly
 * what the platform receives. Audio is mixed with WebAudio: by default audio
 * follows program (vMix "automatically mix audio"), with per-input Audio
 * buttons and a master bus + segmented meters.
 */
window.LiveStudio = (() => {
  const toast = (m, k) => (window.__toast ? window.__toast(m, k) : console.log(m));
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^\/+/, '');

  // vMix-style quality presets — one source of truth in src/main/livestream.js,
  // handed to the page synchronously by the preload bridge. Preset fps is null
  // unless the preset forces a rate (Twitch p60/p30): everything else follows
  // the production frame rate (see productionFps) so the stream matches the
  // camera instead of judder-converting a 25/50fps camcorder to 30.
  const FALLBACK_QUALITY = {
    'H264 720p 2.5mbps AAC 128kbps': { width: 1280, height: 720, fps: null, videoKbps: 2500, audioKbps: 128, profile: null },
  };
  const bridgeLive = (window.api && window.api.live) || {};
  const QUALITY = Object.assign({}, FALLBACK_QUALITY, bridgeLive.qualityPresets || {});
  const QUALITY_GROUPS = (bridgeLive.qualityGroups || [{ name: 'Recommended', keys: Object.keys(FALLBACK_QUALITY) }]).slice();
  const LEGACY_QUALITY = Object.assign({}, bridgeLive.legacyQuality || {});
  let DEFAULT_QUALITY = bridgeLive.defaultQuality || Object.keys(QUALITY)[0];
  // Sound quality is its own choice, not part of the vMix picture presets —
  // see AUDIO_QUALITIES in src/main/livestream.js for why 128 kbps is not
  // enough for a room that sings.
  const FALLBACK_AUDIO_Q = [{ id: 'music', kbps: 160, label: 'Music — 160 kbps (recommended)', hint: '' }];
  let AUDIO_QUALITIES = (bridgeLive.audioQualities || FALLBACK_AUDIO_Q).slice();
  let DEFAULT_AUDIO_QUALITY = bridgeLive.defaultAudioQuality || 'music';
  const STD_FPS = [15, 24, 25, 30, 50, 60, 120]; // broadcast-standard rates 'Auto' snaps to
  // Camera capture choices for the Input Select dialog — filtered per camera by
  // getCapabilities(), so only what the selected device can really do is shown.
  const CAM_RES_CHOICES = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [854, 480], [640, 480], [640, 360]];
  // Every rate an operator may need to FORCE, whether or not the camera admits
  // to supporting it. `getCapabilities()` reports what the driver feels like
  // saying for the CURRENT format — plenty of cameras under-report (a 60 fps
  // webcam claiming max 30 while it is on a 1080p profile), so hiding the rest
  // meant the rate you needed simply was not in the list. Everything is
  // offered; the camera's own answer is shown after it is applied.
  const CAM_FPS_CHOICES = [
    [10, '10 fps'], [15, '15 fps'], [20, '20 fps'], [23.976, '23.976p (film / NTSC)'], [24, '24p (film)'],
    [25, '25p (PAL)'], [29.97, '29.97p (NTSC)'], [30, '30p'], [48, '48p'], [50, '50p (PAL)'],
    [59.94, '59.94p (NTSC)'], [60, '60p'], [90, '90 fps'], [100, '100 fps'], [120, '120 fps'],
  ];

  /** Sandboxed-preload fallback: pull the same preset table over async IPC. */
  async function hydrateQualityPresets() {
    if (bridgeLive.qualityPresets) return; // preload delivered them synchronously
    try {
      const d = await window.api.live.destinations();
      if (!d || !d.qualities) return;
      Object.assign(QUALITY, d.qualities);
      if (Array.isArray(d.qualityGroups)) QUALITY_GROUPS.splice(0, QUALITY_GROUPS.length, ...d.qualityGroups);
      Object.assign(LEGACY_QUALITY, d.legacyQuality || {});
      if (d.defaultQuality) DEFAULT_QUALITY = d.defaultQuality;
      if (Array.isArray(d.audioQualities) && d.audioQualities.length) AUDIO_QUALITIES = d.audioQualities.slice();
      if (d.defaultAudioQuality) DEFAULT_AUDIO_QUALITY = d.defaultAudioQuality;
      if (Array.isArray(d.rateTiers) && d.rateTiers.length) RATE_TIERS.splice(0, RATE_TIERS.length, ...d.rateTiers);
    } catch (e) { /* engine offline — the fallback preset keeps the studio usable */ }
  }
  const MAX_STREAMS = 7; // simultaneous streaming destinations (vMix-style slots)
  const EFFECTS = ['Fade', 'Zoom', 'Wipe', 'Slide', 'Fly', 'Merge'];
  // vMix's "Input Select" dialog has more source types than any switcher clone
  // can honestly drive. DVD (disc decryption) and Virtual Set (a 3D studio
  // renderer) are the two left unimplemented — everything else here is real.
  const INPUT_CATS = [
    { id: 'video',   label: 'Video',                  icon: '▶',  supported: true },
    { id: 'dvd',     label: 'DVD',                     icon: '◎',  supported: false,
      note: 'Playing encrypted DVD discs requires circumventing copy protection, which this app won’t do. Rip the disc to an MP4 with a licensed tool first, then use Video.' },
    { id: 'list',    label: 'List',                    icon: '☰',  supported: true },
    { id: 'camera',  label: 'Camera',                   icon: '📷', supported: true },
    { id: 'desktop', label: 'NDI / Desktop Capture',    icon: '🖥', supported: true },
    { id: 'srt',     label: 'Stream / SRT',             icon: '📡', supported: true },
    { id: 'replay',  label: 'Instant Replay',           icon: '⏮', supported: true },
    { id: 'stinger', label: 'Image Sequence / Stinger', icon: '🎞', supported: true },
    { id: 'delay',   label: 'Video Delay',              icon: '⏱', supported: true },
    { id: 'image',   label: 'Image',                    icon: '🖼', supported: true },
    { id: 'photos',  label: 'Photos',                   icon: '🗂', supported: true },
    { id: 'ppt',     label: 'PowerPoint',                icon: '📊', supported: true },
    { id: 'color',   label: 'Colour',                   icon: '🎨', supported: true },
    { id: 'audiofile', label: 'Audio',                  icon: '🎵', supported: true },
    { id: 'mic',     label: 'Audio Input',               icon: '🎙', supported: true },
    { id: 'title',   label: 'Title',                    icon: '🔤', supported: true },
    { id: 'vset',    label: 'Virtual Set',              icon: '🧑', supported: true },
    { id: 'web',     label: 'Web Browser',               icon: '🌐', supported: true },
    { id: 'call',    label: 'Video Call',                icon: '📞', supported: true },
  ];

  /* --------------------------------- state -------------------------------- */
  const st = {
    settings: null,
    inputs: [],            // input objects (see makeInput)
    nextId: 1,
    previewId: null,
    programId: null,
    trans: null,           // { from, to, fx, dur, t0, m, manual }
    tbarPos: 0,            // 0..1 manual mix position
    slots: [
      { fx: 'Fade', dur: 500 }, { fx: 'Zoom', dur: 1000 },
      { fx: 'Wipe', dur: 1000 }, { fx: 'Fly', dur: 1000 },
    ],
    ftbOn: false, ftbLevel: 0,
    ovl: [
      { id: null, level: 0, mode: 'full' }, { id: null, level: 0, mode: 'lower' },
      { id: null, level: 0, mode: 'pip-br' }, { id: null, level: 0, mode: 'pip-bl' },
    ],
    autoMix: true,
    masterVol: 1, masterMuted: false, masterLevel: 0,
    // vMix-style Audio Mixer panel: headphone (monitor) volume + solo bus state.
    // Monitor/solo only affect what the operator HEARS — never the broadcast.
    // The mixer is ALWAYS visible (docked below the monitors, like vMix).
    mixerOpen: true, monitorVol: 1,
    pausedAll: false, basic: false,
    // engines
    ac: null, masterGain: null, masterAnalyser: null, dest: null, meterBuf: null,
    // Master-bus limiter: the look-ahead worklet (limNode) does the work, the
    // DynamicsCompressor (limiter) is the fallback until/unless it loads.
    limiter: null, limNode: null, limMeter: null,
    limiterOn: true, limiterStyle: 'broadcast', limiterCeiling: -1,
    outStream: null, outStreamFps: 0,
    // ONE program capture for the whole app. Every consumer — each streaming
    // destination, Record, and Instant Replay — attaches to the single encode
    // the main process makes from it (src/main/livestream.js ProgramHub). The
    // studio used to run a separate MediaRecorder per consumer, so streaming to
    // 3 platforms while recording meant four simultaneous software VP8 encodes
    // of the same picture.
    pgmRec: null, pgmSid: 0, chunksSent: 0, encoderLabel: '', h264CaptureBad: false,
    wcBad: false, pgmCaptureMode: '', // 'gpu' (WebCodecs H.264, hub copies) | 'sw' (MediaRecorder, hub encodes)
    streams: [], // [{ id, num, dest, key, customUrl, quality, streaming, startedAt, lastStats, lastEndInfo }] — MAX_STREAMS slots
    recording: false, recStartedAt: 0, recFile: '', recChunksSent: 0, lastRecEnd: null,
    multicorders: [],      // [{ inputId, canvas, rec, recId, file }]
    playlist: { ids: [], on: false, idx: -1, loop: false, handler: null, timer: 0 },
    extWin: null,
    // Instant Replay: a background recording of PROGRAM, always re-armed after a take
    replayArmed: false, replayFile: '', replayStartedAt: 0,
    // render loop
    raf: 0, watchdog: 0, lastDraw: 0, frames: 0, fps: 0, renderMs: 0, lastFpsAt: 0,
    loopOn: false, statTimer: 0, clockTimer: 0, fpsTimer: 0, syncTimer: 0, cpu: 0,
    avAutoSync: true,   // measure and correct A/V sync automatically (NDI sources)
    targetFps: 30, lastThumbAt: 0, lastMeterAt: 0, lastGainAt: 0, lastTickAt: 0, frameAcc: 0,
    lastPresetPath: '',
  };
  const refs = {};

  function grabRefs() {
    ['vmx', 'vmxOpenPreset', 'vmxSavePreset', 'vmxLastPreset', 'vmxClosePreset', 'vmxFullscreen',
     'vmxPauseInputs', 'vmxBasic', 'vmxSettingsBtn', 'vmxHelpBtn', 'vmxMore', 'vmxDrawer',
     'vmxLamp', 'vmxLampTxt',
     'vmxPrvTitle', 'vmxPrvName', 'vmxPrvCanvas', 'vmxPgmTitle', 'vmxPgmName', 'vmxPgmCanvas', 'vmxPgmGear',
     'vmxQuickPlay', 'vmxCut', 'vmxSlots', 'vmxFTB', 'vmxTbar', 'vmxTbarHandle', 'vmxMasterMeter',
     'vmxInputs', 'vmxSrcCount', 'vmxAddInput', 'vmxAddInputCfg', 'vmxRecord', 'vmxRecordCfg', 'vmxExternal',
     'vmxStream', 'vmxStreamCfg', 'vmxMultiCorder', 'vmxPlayList',
     'vmxMasterMute', 'vmxMasterVol',
     'vmxMixer', 'vmxMixerOut', 'vmxMixerIn', 'vmxMixerRailOut', 'vmxMixerRailIn',
     'vmxStName', 'vmxStFps', 'vmxStRender', 'vmxStCpu', 'vmxStRec', 'vmxStRecTime',
     'vmxStStream', 'vmxStStreamTime', 'vmxStBitrate', 'vmxStMsg', 'vmxStEngine',
     'vmxHolder', 'vmxMenu', 'vmxModal', 'vmxModalBox']
      .forEach((id) => { refs[id] = document.getElementById(id); });
    refs.prvCtx = refs.vmxPrvCanvas.getContext('2d');
    refs.pgmCtx = refs.vmxPgmCanvas.getContext('2d');
    refs.meterCtx = refs.vmxMasterMeter.getContext('2d');
  }

  function statusMsg(t) { refs.vmxStMsg.textContent = t || ''; }

  /* ================== THE ONE WARNING THAT MUST NOT BE MISSED ==============
   *
   * A destination losing its picture used to be a toast and a line of status
   * text. Both are right, and both are gone in twelve seconds — during a
   * service, while the operator is watching the room and not the desk. The
   * whole failure then plays out invisibly: one platform judders for forty
   * minutes and nobody at the desk ever sees a word about it.
   *
   * So it is also a banner across the top of the switcher that STAYS for
   * exactly as long as the destination is actually starving, names which
   * destination, and says what to change. It is built here rather than in
   * index.html so it cannot exist while there is nothing wrong with it.
   */
  function renderShedBanner() {
    const bad = st.streams.filter((s) => s.streaming && s.shedding);
    let el = document.getElementById('vmxShedBanner');
    if (!bad.length) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'vmxShedBanner';
      el.className = 'vmx-shed-banner';
      const host = document.getElementById('view-live');
      if (!host) return;
      host.insertBefore(el, host.firstChild);
    }
    const nums = bad.map((s) => s.num).join(' and ');
    const encode = bad.some((s) => s.shedReason === 'encode');
    el.innerHTML = alertHtml({
      icon: encode ? '🖥️' : '📶',
      head: `Destination ${esc(nums)} ${bad.length > 1 ? 'are' : 'is'} losing picture right now.`,
      act: encode
        ? `Give every destination the SAME quality.`
        : `Lower the streaming quality on every destination, or stop one of them.`,
      why: encode
        ? `This destination is set to a different quality from the others, so instead of being copied from the `
          + `one encode it is being made again from scratch while the service runs — and this computer cannot `
          + `keep up with that. It fails in a way that looks exactly like bad internet, which is why it is worth `
          + `naming: the fix is not a faster line, it is one quality for all of them.`
        : `Your upload cannot carry ${bad.length > 1 ? 'them' : 'it'} at this quality. The sound is being `
          + `protected and the picture is not — picture re-acquires at the next keyframe a second or two later, `
          + `whereas a hole in the sound is a hole in the preaching.`,
      btn: 'vmxShedFix',
    });
    const fix = el.querySelector('#vmxShedFix');
    if (fix) fix.onclick = () => openStreamSettingsModal();
    wireAlert(el);
  }

  /* ================== ONE SHAPE FOR EVERY ON-AIR WARNING ==================
   *
   * These strips sit across the top of the switcher, above the monitors, and
   * two of them can be true at once. Each used to be a paragraph — sixty to
   * eighty words of explanation in a full-width bar — so a service that hit
   * trouble ended up with the desk buried under prose about the connection,
   * exactly when the operator has the least attention to give it.
   *
   * Not one word of that explanation was wrong, and none of it is deleted. It
   * is moved one click away: what is happening and what to do about it stay on
   * the line, and WHY it is happening folds. An operator glancing up mid-song
   * reads a headline; an operator who wants to understand it opens the fold.
   */
  function alertHtml({ icon, head, act, why, btn }) {
    return `<span class="vmx-shed-icon">${icon}</span>` +
      `<span class="vmx-shed-text"><b>${head}</b> ${act}` +
      (why ? ` <button type="button" class="vmx-why-btn">Why</button>` : '') + `</span>` +
      `<button class="vmx-btn vmx-shed-fix" id="${btn}">Streaming Settings</button>` +
      (why ? `<p class="vmx-alert-why hidden">${why}</p>` : '');
  }

  /** Make the Why on an alert strip open and close. */
  function wireAlert(el) {
    const b = el.querySelector('.vmx-why-btn'), p = el.querySelector('.vmx-alert-why');
    if (!b || !p) return;
    b.onclick = () => {
      const open = p.classList.toggle('hidden') === false;
      b.classList.toggle('open', open);
    };
  }

  /* ==================== AUTO-FIT, SAID OUT LOUD ==========================
   *
   * When the app lowers the picture to fit the line, the operator has to be
   * able to see that it did — otherwise the honest question "why does this
   * look softer than last week?" has no answer anywhere in the building. It is
   * a calm blue strip, not the red one: nothing is broken, something is being
   * handled, and it goes away by itself when the picture comes back up.
   */
  function renderFitBanner() {
    const f = st.fit || null;
    const live = st.streams.some((s2) => s2.streaming);
    const lowered = !!(f && f.on && f.ceiling && f.kbps && f.kbps < f.ceiling && live);
    /*
     * THE YELLOW BANNER ON THE PLATFORM, SAID HERE FIRST AND IN ENGLISH.
     *
     * "The stream's current bitrate (2278.74 Kbps) is lower than the
     * recommended bitrate" is the platform noticing that the picture it is
     * being sent costs more than it is being paid for. The app now sends the
     * platform's own rate for the picture size it chose (platformKbps), so this
     * can only still happen when the LINE cannot pay it — and then the fix is
     * not a bigger number, it is a smaller picture. Said while it is happening,
     * because an operator watching a room will not find it in YouTube Studio.
     */
    /*
     * JUDGED ON WHAT IS ACTUALLY LEAVING, not on what was asked for.
     *
     * The rate the app targets and the rate that reaches the platform are two
     * different numbers, and only the second one is compared with the
     * recommendation. They part company when the machine — not the line —
     * cannot keep up: measured here on two 1080p destinations on a two-core
     * laptop, the target sat correctly at 4500 while the encoder managed 24.9
     * fps and 1473 kbps actually went out. Judging the target alone, the app
     * called that healthy and said nothing, while YouTube showed the warning.
     *
     * ffmpeg's own `bitrate=` is a running average over everything it has sent,
     * so it is already smooth; the slowest destination is the one that matters,
     * and a stream is given fifteen seconds to settle before it is judged at
     * all — the opening always ramps.
     */
    const judged = st.streams.filter((s2) => s2.streaming && s2.lastStats
      && s2.lastStats.bitrateKbps > 0 && Date.now() - (s2.startedAt || 0) > 15000);
    const leaving = judged.length ? Math.min(...judged.map((s2) => s2.lastStats.bitrateKbps)) : 0;
    const goingOut = leaving || (f ? f.kbps : 0);
    const under = !!(live && f && f.forStream && f.kbps && f.w && f.h &&
      goingOut < platformRecKbps(f.w, f.h, f.fps));
    let el = document.getElementById('vmxFitBanner');
    if (!lowered && !under) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('div');
      el.id = 'vmxFitBanner';
      el.className = 'vmx-fit-banner';
      const host = document.getElementById('view-live');
      if (!host) return;
      host.insertBefore(el, host.firstChild);
    }
    const mb = (k) => (Math.round(k / 100) / 10) + ' mbps';
    /*
     * ONE BANNER, BOTH FACTS — in the order an operator needs them.
     *
     * When auto-fit has had to lower the picture AND the stream is now under
     * what the platform charges for its size, both things are true at once and
     * neither may hide the other. What is happening right now comes first,
     * because that is the sentence that stops somebody running to the desk
     * mid-sermon; the durable fix (a smaller picture, chosen once, before next
     * Sunday) is appended to it rather than replacing it. Two banners fighting
     * over one slot would have meant the reassurance — the sound is untouched —
     * simply disappeared the moment things got worse.
     */
    const need = under ? platformRecKbps(f.w, f.h, f.fps) : 0;
    const smaller = under ? smallerPictureThatFits(goingOut, f.fps, f.h > f.w, Math.min(f.w, f.h)) : '';
    const cure = smaller
      ? 'Use “' + esc(smaller) + '” on every destination.'
      : 'Stream to one platform instead of two, or use a faster connection.';
    const underWhy = !under ? '' :
      ' <b>YouTube will also report this as a low bitrate</b> — a ' + esc(f.w + '×' + f.h) +
      ' picture at ' + Math.round(f.fps) + 'fps costs ' + esc(mb(need)) + ' there and ' + esc(mb(goingOut)) +
      ' is what is actually leaving. The picture is ' +
      'not broken, it is simply bigger than this connection or this computer can pay for. ' +
      (smaller
        ? 'Set every destination to “' + esc(smaller) + '” and that stops happening for good.'
        : 'Stream to one platform instead of two, or use a faster connection.');

    el.innerHTML = lowered
      ? alertHtml({
        icon: '📶',
        head: 'Picture quality lowered automatically to ' + esc(mb(f.kbps)) + '.',
        act: 'The sound is untouched, and it goes back up on its own.'
          + (f.atFloor ? ' <b>This is as low as it goes.</b>' : '')
          + (under ? ' ' + cure : ''),
        why: 'Your internet cannot carry ' + esc(mb(f.ceiling)) + ' right now, so the app is sending less rather '
          + 'than letting the picture stutter — a soft picture in time is worth more than a sharp one that '
          + 'judders. It climbs back the moment the connection is comfortable again.'
          + (f.atFloor ? ' It will not go lower than this; if it is still stuttering, stream to one platform instead of two.' : '')
          + underWhy,
        btn: 'vmxFitFix',
      })
      : alertHtml({
        icon: '📉',
        head: 'YouTube will report this as a low bitrate.',
        act: cure,
        why: 'A ' + esc(f.w + '×' + f.h) + ' picture at ' + Math.round(f.fps) + 'fps costs ' + esc(mb(need))
          + ' there, and only ' + esc(mb(goingOut)) + ' is going out. The picture is not broken — it is being '
          + 'sent at less than the size it is, and that is all that warning means. Sending a SMALLER picture at '
          + 'its full rate is what ends it; a bigger number cannot be sent down a line that has already refused it.',
        btn: 'vmxFitFix',
      });
    const fix = el.querySelector('#vmxFitFix');
    if (fix) fix.onclick = () => openStreamSettingsModal();
    wireAlert(el);
  }

  /**
   * The one question the board exists to answer: is anything leaving this
   * computer right now?
   *
   * Said in three places at once — the lamp, the word beside it, and a red
   * bezel round the program monitor — because an operator who is also watching
   * a room reads whichever of the three happens to be under their eye. On air
   * (a stream) outranks merely recording, since only one of them is public.
   */
  function updateAirState() {
    const streaming = st.streams.some((s) => s.streaming);
    const recording = st.recording || st.multicorders.length > 0 || st.replayArmed;
    const lamp = refs.vmxLamp;
    if (!lamp) return;
    lamp.classList.toggle('on', streaming);
    lamp.classList.toggle('rec', !streaming && recording);
    refs.vmxLampTxt.textContent = streaming ? 'ON AIR' : recording ? 'RECORDING' : 'OFF AIR';
    refs.vmx.classList.toggle('on-air', streaming);
  }
  /** Preset key → preset object, resolving legacy '4K'/'1080p'/'720p'/'480p' saves. */
  function resolveQ(key) { return QUALITY[key] || QUALITY[LEGACY_QUALITY[key]] || QUALITY[DEFAULT_QUALITY]; }
  /** Preset key → the canonical vMix-style key (what the selects list). */
  function canonicalQ(key) {
    return QUALITY_GROUPS.some((g) => g.keys.includes(key)) ? key : (LEGACY_QUALITY[key] || DEFAULT_QUALITY);
  }
  function quality() { return resolveQ((st.settings && st.settings.live && st.settings.live.quality) || DEFAULT_QUALITY); }

  /**
   * The production frame rate — the rate the program canvas is captured and
   * encoded at. 'auto' (default) matches the real rate of the cameras on the
   * mix, so a 25fps PAL camcorder streams at exactly 25fps instead of being
   * judder-converted to 30. A fixed rate can be chosen in Production Settings.
   */
  function productionFps() {
    const mode = (st.settings && st.settings.live && st.settings.live.fpsMode) || 'auto';
    if (mode !== 'auto') return Number(mode) || 30;
    // A camera the operator LOCKED to a rate in Input Select wins outright, and
    // is used UNSNAPPED: they picked that number, so the whole chain runs at it
    // (and if the camera refused, at whatever it is genuinely delivering — never
    // at a rate nothing on the mix is actually producing).
    let locked = 0;
    for (const i of st.inputs) {
      if (i.type !== 'camera' || !i.camCfg || !i.camCfg.fps || i.camCfg.fps === 'auto') continue;
      const t = i.stream && i.stream.getVideoTracks && i.stream.getVideoTracks()[0];
      const s = t && t.getSettings ? t.getSettings() : null;
      const f = (s && s.frameRate) || Number(i.camCfg.fps) || 0;
      if (f > locked) locked = f;
    }
    if (locked) return Math.round(locked * 100) / 100;
    let cam = 0, any = 0;
    for (const i of st.inputs) {
      // An NDI source has no MediaStreamTrack to interrogate, so its rate is the
      // one we have measured from its arrivals. Without this a 60fps NDI feed —
      // often the ONLY input in a church rig fed from vMix or a PTZ camera —
      // fell through to the 30fps default and was judder-converted for no
      // reason, which is precisely what "not smooth like vMix" looks like.
      let fr = 0;
      if (i.type === 'ndi' && i._ndiGotVideo) fr = ndiFpsOf(i);
      else {
        const track = i.stream && i.stream.getVideoTracks && i.stream.getVideoTracks()[0];
        fr = (track && track.getSettings && track.getSettings().frameRate) || 0;
      }
      if (!fr) continue;
      if ((i.type === 'camera' || i.type === 'ndi') && fr > cam) cam = fr; // live cameras outrank screen shares
      if (fr > any) any = fr;
    }
    const measured = cam || any;
    if (!measured) return 30;
    return STD_FPS.reduce((best, s) => (Math.abs(s - measured) < Math.abs(best - measured) ? s : best), 30);
  }

  /**
   * Drop the cached capture stream while idle so the next broadcast/recording
   * picks up a changed production frame rate. No-op mid-broadcast — the canvas
   * capture is never touched while any encoder is consuming it.
   */
  function refreshOutStream() {
    if (st.pgmRec) return;
    if (st.outStream && st.outStreamFps !== productionFps()) {
      try { st.outStream.getVideoTracks().forEach((t) => t.stop()); } catch (e) {}
      st.outStream = null;
    }
  }

  /* ================================ INPUTS ================================ */

  function makeInput(type, name) {
    return {
      id: st.nextId++, num: 0, type, name: name || type,
      el: null, stream: null,
      audioOn: true, volume: 1, solo: false, loop: false, paused: false,
      srcNode: null, gain: null, meter: null, meterData: null, level: 0,
      color: '#204080', title: null, path: '', deviceId: '',
      thumbCanvas: null, meterCanvas: null,
    };
  }

  function srcDims(inp) {
    const el = inp.el;
    if (!el) return [0, 0];
    if (el.tagName === 'VIDEO') return [el.videoWidth, el.videoHeight];
    if (el.tagName === 'IMG') return [el.naturalWidth, el.naturalHeight];
    return [el.width, el.height];
  }

  function hasVisual(inp) { return inp.type !== 'audio' && inp.type !== 'ndaudio'; }

  /* ======================= per-input colour adjust =======================
   *
   * vMix's Colour Adjust, on our inputs: per-channel Red/Green/Blue gain,
   * Saturation, Black/White Stretch (input levels), Alpha, and a Rec.601→709
   * conversion for standard-definition sources.
   *
   * It is done with ONE SVG filter per corrected input, referenced from the 2D
   * context (`ctx.filter = url(#…)`). That was chosen over the CSS shorthand
   * filters because those cannot express per-channel gain or a black/white
   * level stretch at all — and over a WebGL pass because this hooks the single
   * function every composite already goes through, rather than rebuilding the
   * compositor.
   *
   * The cost question is settled by the default: an untouched input gets NO
   * filter string at all, so the switcher runs exactly as it did before for
   * every input nobody has deliberately graded.
   */
  const COLOUR_DEFAULT = { r: 0, g: 0, b: 0, sat: 0, black: 0, white: 255, alpha: 255, rec601: false };
  const colourOf = (inp) => (inp.colour || (inp.colour = Object.assign({}, COLOUR_DEFAULT)));
  /** Is anything actually being changed? (the whole performance story) */
  function colourActive(c) {
    if (!c) return false;
    return c.r !== 0 || c.g !== 0 || c.b !== 0 || c.sat !== 0 ||
           c.black !== 0 || c.white !== 255 || c.rec601 === true;
  }

  /* Rec.601 → Rec.709 primaries. An SD source (an older camera, a DVD player on
   * a capture card) carries 601 primaries; showing it untranslated alongside HD
   * sources is why one camera can look greener than the rest of the rig. */
  const REC601_TO_709 = [
    0.9395, 0.0502, 0.0103,
    -0.0178, 0.9658, 0.0520,
    -0.0016, -0.0044, 1.0060,
  ];

  function colourDefs() {
    if (st._colourDefs) return st._colourDefs;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:fixed;width:0;height:0;pointer-events:none';
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    st._colourDefs = defs;
    return defs;
  }

  /**
   * Build (or rebuild) this input's filter and return the id to reference.
   *
   * Levels and per-channel gain collapse into ONE feComponentTransfer: a linear
   * transfer per channel whose slope stretches black→white and then applies the
   * channel's own gain, so a full grade is a single pass rather than three.
   */
  function colourFilterId(inp) {
    const c = colourOf(inp);
    const sig = [c.r, c.g, c.b, c.sat, c.black, c.white, c.rec601 ? 1 : 0].join(',');
    if (inp._colourSig === sig && inp._colourNode) return inp._colourId;
    const id = inp._colourId || ('mwColour-' + inp.id);
    const defs = colourDefs();
    if (inp._colourNode && inp._colourNode.parentNode) inp._colourNode.parentNode.removeChild(inp._colourNode);

    const black = clamp(Number(c.black) || 0, 0, 254) / 255;
    const white = clamp(Number(c.white) == null ? 255 : Number(c.white), 1, 255) / 255;
    const span = Math.max(1 / 255, white - black);
    const gain = (v) => 1 + clamp(Number(v) || 0, -100, 100) / 100; // -100 → 0, +100 → 2×
    const NS = 'http://www.w3.org/2000/svg';
    const f = document.createElementNS(NS, 'filter');
    f.setAttribute('id', id);
    // Operate on the source's own pixels, untouched by the page's colour space.
    f.setAttribute('color-interpolation-filters', 'sRGB');
    f.setAttribute('x', '0%'); f.setAttribute('y', '0%');
    f.setAttribute('width', '100%'); f.setAttribute('height', '100%');

    const ct = document.createElementNS(NS, 'feComponentTransfer');
    for (const [ch, g] of [['feFuncR', c.r], ['feFuncG', c.g], ['feFuncB', c.b]]) {
      const fn = document.createElementNS(NS, ch);
      const slope = (1 / span) * gain(g);
      fn.setAttribute('type', 'linear');
      fn.setAttribute('slope', String(slope));
      fn.setAttribute('intercept', String(-black * slope));
      ct.appendChild(fn);
    }
    f.appendChild(ct);

    if (c.sat !== 0) {
      const m = document.createElementNS(NS, 'feColorMatrix');
      m.setAttribute('type', 'saturate');
      m.setAttribute('values', String(clamp(1 + (Number(c.sat) || 0) / 100, 0, 3)));
      f.appendChild(m);
    }
    if (c.rec601) {
      const m = document.createElementNS(NS, 'feColorMatrix');
      const k = REC601_TO_709;
      m.setAttribute('type', 'matrix');
      m.setAttribute('values',
        `${k[0]} ${k[1]} ${k[2]} 0 0  ${k[3]} ${k[4]} ${k[5]} 0 0  ${k[6]} ${k[7]} ${k[8]} 0 0  0 0 0 1 0`);
      f.appendChild(m);
    }
    defs.appendChild(f);
    inp._colourNode = f;
    inp._colourSig = sig;
    inp._colourId = id;
    return id;
  }

  /** Letterbox-fit an input into a rect of the target context. Draws the
   *  A/V-sync-delayed picture when one is active (see drawSourceOf), through
   *  this input's colour adjustment when it has one. */
  function drawInputTo(ctx, inp, x, y, w, h) {
    if (!inp || !inp.el) return;
    const el = drawSourceOf(inp);
    const sw = el === inp.el ? srcDims(inp)[0] : el.width;
    const sh = el === inp.el ? srcDims(inp)[1] : el.height;
    if (!sw || !sh) return;
    const s = Math.min(w / sw, h / sh);
    const dw = sw * s, dh = sh * s;
    const c = inp.colour;
    const graded = colourActive(c);
    const alpha = c && c.alpha != null ? clamp(Number(c.alpha), 0, 255) / 255 : 1;
    if (graded) ctx.filter = 'url(#' + colourFilterId(inp) + ')';
    if (alpha < 1) ctx.globalAlpha = alpha;
    try { ctx.drawImage(el, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh); } catch (e) { /* not ready yet */ }
    if (graded) ctx.filter = 'none';
    if (alpha < 1) ctx.globalAlpha = 1;
  }

  /**
   * Auto white balance: read the picture, and scale the channels so the average
   * of the brightest part of the frame comes out neutral.
   *
   * Grey-world over the WHOLE frame is the usual textbook answer and it is the
   * wrong one for a church: a big saturated backdrop or a wash of coloured stage
   * light drags the average and the correction fights it. Averaging only the top
   * of the luminance range instead anchors on what is actually being lit —
   * faces, the lectern, white shirts — which is what the operator means by
   * "make this camera match the others".
   */
  function autoWhiteBalance(inp) {
    const el = drawSourceOf(inp);
    const [sw, sh] = el === inp.el ? srcDims(inp) : [el.width, el.height];
    if (!sw || !sh) return null;
    const W = 160, H = Math.max(1, Math.round(W * sh / sw));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    try { c2.drawImage(el, 0, 0, W, H); } catch (e) { return null; }
    let px;
    try { px = c2.getImageData(0, 0, W, H).data; } catch (e) { return null; }
    // luminance histogram → the threshold above which we average
    const lum = new Float32Array(W * H);
    for (let i = 0, p = 0; i < px.length; i += 4, p++) lum[p] = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    const sorted = Float32Array.from(lum).sort();
    const cut = sorted[Math.floor(sorted.length * 0.8)] || 0;
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let i = 0, p = 0; i < px.length; i += 4, p++) {
      if (lum[p] < cut) continue;
      sr += px[i]; sg += px[i + 1]; sb += px[i + 2]; n++;
    }
    if (n < 8) return null;
    const mr = sr / n, mg = sg / n, mb = sb / n;
    const target = (mr + mg + mb) / 3;
    if (target < 8) return null; // an essentially black picture has no white to balance
    const col = colourOf(inp);
    // green is the reference channel (it carries most of the luminance), so a
    // balance never changes overall exposure — only the colour of the light
    const toSlider = (mean) => clamp(Math.round(((target / Math.max(1, mean)) - 1) * 100), -100, 100);
    col.r = toSlider(mr); col.g = toSlider(mg); col.b = toSlider(mb);
    return { r: col.r, g: col.g, b: col.b, sampled: n, cut: Math.round(cut) };
  }

  function registerInput(inp) {
    inp.num = st.inputs.length + 1;
    st.inputs.push(inp);
    if (hasVisual(inp)) {
      if (st.programId == null) st.programId = inp.id;
      else if (st.previewId == null) st.previewId = inp.id;
    }
    renderInputs();
    ensureLoop();
    statusMsg('');
    return inp;
  }

  function inputById(id) { return st.inputs.find((i) => i.id === id) || null; }

  /* ------- concrete input types ------- */

  // Open a camera stream resiliently. Windows/Chromium sometimes throws a
  // TRANSIENT error (NotReadable/Overconstrained/Abort/NotFound) when a device
  // is re-acquired a beat after another stream on it was released — exactly the
  // preview→add hand-off (stopPreview() then addCamera() on the SAME device).
  // That produced a false "camera not found" toast even though the camera works.
  // Retry once after a short delay, relaxing an `exact` deviceId to `ideal`, so a
  // momentarily-busy device settles instead of erroring.
  async function openCameraStream(constraints) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      const transient = ['NotReadableError', 'AbortError', 'OverconstrainedError', 'NotFoundError'].includes(e && e.name);
      if (!transient) throw e;
      await new Promise((r) => setTimeout(r, 350));
      const relaxed = { audio: constraints.audio, video: Object.assign({}, constraints.video) };
      if (relaxed.video && relaxed.video.deviceId && relaxed.video.deviceId.exact) {
        relaxed.video.deviceId = relaxed.video.deviceId.exact; // ideal match, not exact
      }
      return await navigator.mediaDevices.getUserMedia(relaxed);
    }
  }

  /* =================== THE DEVICE LIST, READY BEFORE IT IS ASKED FOR ========
   *
   * Clicking Camera in Add Input used to sit on "Looking for cameras…" for
   * seconds. It was not looking: it was OPENING a camera it had not been asked
   * for, purely to unlock the device LABELS, waiting for the driver to spin
   * up, closing it again, and only then listing anything — and then opening a
   * second stream for the preview before the list appeared.
   *
   * Enumerating devices is fast (milliseconds). Only the labels need
   * permission, and once permission has been granted ONCE the labels keep
   * coming for free. So:
   *   • the list is enumerated when Go Live opens and kept in this cache, and
   *     refreshed whenever Windows says a device was plugged or unplugged —
   *     by the time anyone clicks Camera the answer is already sitting here;
   *   • the unlock-the-labels stream is only ever opened if the labels really
   *     are blank, and the list is shown immediately either way;
   *   • the preview opens in the background instead of the list waiting on it.
   */
  const devCache = { cams: null, mics: null, warming: null, bound: false };

  /* =================== AND THE CAPTURE STACK, TOO =========================
   *
   * Listing the devices got fast (above), but the first camera still took
   * about five seconds to appear. Measured on this machine: the FIRST
   * getUserMedia of a session costs 4.9-5.2 s, and every one after it costs
   * ~0.6 s — the same camera, the same request, warm instead of cold. It is
   * not the resolution (640x360, 720p and 1080p all land at ~0.6-1.4 s once
   * warm) and it is not our code: it is Chromium starting its video capture
   * service, which on a media machine has a pile of virtual cameras to walk
   * (vMix, OBS, NDI, XSplit, phone-as-webcam) before it answers.
   *
   * That cost cannot be removed, but it does not have to be paid while the
   * operator is staring at "Opening camera…". It is paid HERE, the moment they
   * show intent by moving onto ＋ Add Source, using the smallest possible
   * stream, which is then stopped immediately. By the time the dialog has
   * opened and drawn its list, the stack is warm.
   *
   * Deliberately NOT done at startup: opening a camera nobody asked for lights
   * the privacy LED, and an app that does that on launch is one nobody trusts.
   * Intent first.
   *
   * There are TWO costs, and warming has to cover both: the service coming up
   * (~5 s, once per session) and the individual device spinning up (~3 s the
   * first time that camera is touched). Warming some other camera only pays
   * the first, so this warms the camera the dialog is about to preview — the
   * first in the cached list, which is the one it selects by default.
   */
  const capWarm = { done: false, busy: null, dev: null };
  function warmCapture(deviceId) {
    if (st.pgmRec) return Promise.resolve();     // never mid-broadcast
    const want = deviceId || (devCache.cams && devCache.cams[0] && devCache.cams[0].deviceId) || null;
    if (capWarm.done && capWarm.dev === want) return Promise.resolve();
    if (capWarm.busy) return capWarm.busy;
    capWarm.busy = (async () => {
      const ask = { video: Object.assign({ width: { ideal: 320 }, height: { ideal: 180 } },
        want ? { deviceId: { exact: want } } : {}) };
      try {
        const s = await navigator.mediaDevices.getUserMedia(ask);
        s.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        capWarm.done = true; capWarm.dev = want;
      } catch (e) {
        /* That camera may be owned by another app (a phone-as-webcam bridge
         * often is). Fall back to warming the SERVICE with whatever will open,
         * which still takes the five seconds off the dialog. */
        try {
          const s2 = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 180 } } });
          s2.getTracks().forEach((t) => { try { t.stop(); } catch (e2) {} });
          capWarm.done = true; capWarm.dev = null;
        } catch (e2) {
          // No camera, or permission refused. Say nothing: the Add Input dialog
          // is where that gets reported, and it reports it properly.
        }
      }
      capWarm.busy = null;
    })();
    return capWarm.busy;
  }

  function bindDeviceChange() {
    if (devCache.bound || !navigator.mediaDevices) return;
    devCache.bound = true;
    try {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        devCache.cams = devCache.mics = null;
        warmDevices().catch(() => {});
      });
    } catch (e) {}
  }

  /**
   * Fill the cache. Idempotent, and safe to call at any time — except during a
   * broadcast. Enumerating devices is work inside the same media stack that
   * the capture is using, and on a slow machine it competes with the encoder
   * coming up; it is never urgent enough to risk that. A broadcast in progress
   * defers it until whatever comes next asks.
   */
  function warmDevices() {
    if (devCache.warming) return devCache.warming;
    if (st.pgmRec) return Promise.resolve();
    bindDeviceChange();
    devCache.warming = (async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        devCache.cams = devs.filter((d) => d.kind === 'videoinput');
        devCache.mics = devs.filter((d) => d.kind === 'audioinput');
      } catch (e) { devCache.cams = devCache.cams || []; devCache.mics = devCache.mics || []; }
      devCache.warming = null;
    })();
    return devCache.warming;
  }

  /**
   * Ask for permission ONLY when the labels are actually blank, and only for
   * the kind being listed. Returns true if a fresh enumeration is worth doing.
   */
  async function unlockDeviceLabels(kind) {
    const list = kind === 'video' ? devCache.cams : devCache.mics;
    if (list && list.length && list.some((d) => d.label)) return false;
    if (!list || !list.length) return false;   // nothing plugged in — nothing to name
    try {
      const tmp = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { video: true } : { audio: true });
      tmp.getTracks().forEach((t) => t.stop());
    } catch (e) { return false; }              // refused — ids still work, names stay blank
    return true;
  }

  /**
   * cfg (all optional — every field defaults to the old automatic behaviour):
   *   width/height — capture resolution picked in Input Select
   *   fps          — 'auto' (default) or an explicit rate the camera supports
   *   resizeMode   — '' (default) | 'none' | 'crop-and-scale' (the "Video
   *                  Format" row: native frames vs. browser scaling)
   *   audioId      — a microphone deviceId to bring in WITH the camera (vMix's
   *                  camera Audio Device), so the input carries its own sound
   */
  async function addCamera(deviceId, label, cfg) {
    cfg = cfg || {};
    const q = quality();
    const inp = makeInput('camera', label || 'Camera');
    inp.deviceId = deviceId || '';
    inp.camCfg = { width: cfg.width || 0, height: cfg.height || 0, fps: cfg.fps || 'auto',
                   resizeMode: cfg.resizeMode || '', audioId: cfg.audioId || '' };
    // On 'auto', no frameRate constraint: the camera delivers its NATIVE rate
    // (a 25fps camcorder stays 25fps) and the whole capture chain follows it.
    // An explicit rate from Input Select outranks the production setting.
    const mode = (st.settings && st.settings.live && st.settings.live.fpsMode) || 'auto';
    const wantFps = cfg.fps && cfg.fps !== 'auto' ? Number(cfg.fps)
                  : (mode === 'auto' ? 0 : Number(mode) || 30);
    const audio = cfg.audioId ? { deviceId: { exact: cfg.audioId },
                                  // Camera audio is raw (no voice processing): it's a service feed, not a call.
                                  echoCancellation: false, noiseSuppression: false, autoGainControl: false }
                              : false;
    const videoBase = { deviceId: deviceId ? { exact: deviceId } : undefined,
                        width: { ideal: cfg.width || q.width }, height: { ideal: cfg.height || q.height },
                        ...(cfg.resizeMode ? { resizeMode: cfg.resizeMode } : {}) };
    // A rate chosen in Input Select is a LOCK: ask for it exactly, and only fall
    // back to a preference if the camera refuses outright (so the input still
    // opens). What it really delivers drives the production rate either way.
    let stream;
    if (wantFps && cfg.fps && cfg.fps !== 'auto') {
      try {
        stream = await openCameraStream({ video: Object.assign({ frameRate: { exact: wantFps } }, videoBase), audio });
      } catch (e) { stream = null; }
    }
    if (!stream) {
      stream = await openCameraStream({
        video: Object.assign(wantFps ? { frameRate: { ideal: wantFps } } : {}, videoBase), audio });
    }
    attachStream(inp, stream);
    const got = stream.getVideoTracks()[0];
    const settled = got && got.getSettings ? got.getSettings().frameRate : 0;
    if (wantFps && settled && Math.abs(settled - wantFps) > 0.6) {
      toast(`⚠️ ${inp.name} could not run at ${wantFps} fps — it is delivering ${Math.round(settled * 100) / 100} fps.`, 'error');
    }
    return registerInput(inp);
  }

  async function addMic(deviceId, label) {
    const inp = makeInput('audio', label || 'Microphone');
    inp.deviceId = deviceId || '';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: deviceId ? { exact: deviceId } : undefined,
               echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    inp.stream = stream;
    hookStreamAudio(inp, stream);
    return registerInput(inp);
  }

  /** Standalone audio track (music bed, sound effect) — audio-only, file-backed. */
  function addAudioFile(p, name) {
    const inp = makeInput('audio', name || String(p).split(/[\\/]/).pop());
    inp.path = p;
    const el = document.createElement('audio');
    el.src = fileUrl(p);
    el.loop = false; el.preload = 'auto';
    refs.vmxHolder.appendChild(el);
    inp.el = el;
    inp.paused = true;
    hookElementAudio(inp, el);
    return registerInput(inp);
  }

  async function addScreen() {
    const inp = makeInput('screen', 'Screen Capture');
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true }); // no loopback audio on this box
    }
    attachStream(inp, stream);
    return registerInput(inp);
  }

  /* ------------------ WHEN DID THIS SOURCE LAST MOVE? ---------------------
   *
   * An NDI input announces every frame — that is what `_ndiPending` is, and it
   * is what lets the draw loop below line itself up behind the sender instead
   * of free-running against it.
   *
   * A CAMERA ANNOUNCES NOTHING. getUserMedia gives a MediaStream, the app puts
   * it in a <video> element, and the element quietly presents frames on the
   * camera's own crystal. `drawImage(video)` always succeeds and always hands
   * back *a* picture, so the compositor had no way to tell a new frame from the
   * one it drew a moment ago — and every test in this project used a canvas
   * source, which by its nature can never be stale, so nothing ever noticed.
   *
   * requestVideoFrameCallback is the element's equivalent of `_ndiPending`: it
   * fires once for each frame actually presented, and the spec runs it before
   * the animation-frame callbacks of the same rendering opportunity, so by the
   * time the draw loop asks, the answer describes the frame it is about to
   * draw. Cheap — it is a notification, not a copy.
   */
  function watchVideoFrames(inp, el) {
    if (!el || !el.requestVideoFrameCallback) return;   // older engine: behave as before
    const step = () => {
      if (inp._closed || inp.el !== el) return;
      inp._vfFresh = true;
      inp._vfAt = performance.now();
      inp._vfSeen = (inp._vfSeen || 0) + 1;
      try { el.requestVideoFrameCallback(step); } catch (e) {}
    };
    inp._vfWatch = true;
    try { el.requestVideoFrameCallback(step); } catch (e) { inp._vfWatch = false; }
  }

  /**
   * Is this source still handing over pictures on a clock of its own?
   *
   * A camera that has been unplugged, a video file that has been paused and an
   * element that never started all stop calling back, and a source that has
   * stopped moving must never be allowed to hold the draw loop up waiting for
   * a frame that is not coming. Half a second is several frames at any rate a
   * production runs at, so this says "stalled", not "between frames".
   */
  function videoIsClocked(inp) {
    return !!(inp && inp._vfWatch && inp._vfAt && performance.now() - inp._vfAt < 500);
  }

  /** Generic MediaStream input (cameras, screens, synthetic test sources). */
  function attachStream(inp, stream) {
    inp.stream = stream;
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    v.srcObject = stream;
    refs.vmxHolder.appendChild(v);
    v.play().catch(() => {});
    inp.el = v;
    watchVideoFrames(inp, v);
    if (stream.getAudioTracks().length) hookStreamAudio(inp, stream);
    stream.getVideoTracks().forEach((t) => { t.addEventListener('ended', () => closeInput(inp.id)); });
  }

  function addVideoFile(p, name) {
    const inp = makeInput('video', name || String(p).split(/[\\/]/).pop());
    inp.path = p;
    const v = document.createElement('video');
    v.src = fileUrl(p);
    v.loop = false; v.muted = false; v.playsInline = true; v.preload = 'auto';
    refs.vmxHolder.appendChild(v);
    inp.el = v;
    inp.paused = true;
    v.addEventListener('loadedmetadata', () => { try { v.currentTime = 0.01; } catch (e) {} });
    watchVideoFrames(inp, v);
    hookElementAudio(inp, v);
    return registerInput(inp);
  }

  async function addImageFile(p, name) {
    const inp = makeInput('image', name || String(p).split(/[\\/]/).pop());
    inp.path = p;
    const img = document.createElement('img');
    img.src = fileUrl(p);
    refs.vmxHolder.appendChild(img);
    inp.el = img;
    await new Promise((res) => { img.onload = res; img.onerror = res; });
    return registerInput(inp);
  }

  function addColor(name, color) {
    const inp = makeInput('color', name || 'Colour');
    inp.color = color || '#204080';
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 180;
    const c = cv.getContext('2d');
    c.fillStyle = inp.color; c.fillRect(0, 0, 320, 180);
    inp.el = cv;
    return registerInput(inp);
  }

  /**
   * A virtual set input. It has no picture of its own — it borrows a camera
   * (or any other input) and keys it into a scene, so it can be cut to,
   * faded, overlaid and recorded exactly like a camera.
   */
  async function addVirtualSet(cfg) {
    cfg = cfg || {};
    const inp = makeInput('vset', cfg.name || 'Virtual Set');
    const vs = buildVirtualSet(inp, {
      sourceId: cfg.sourceId == null ? null : cfg.sourceId,
      presets: (cfg.presets || window.VirtualSet.DEFAULT_PRESETS).map((p) => ({ ...p })),
      key: Object.assign({ on: true, color: '#00b140', tolerance: 0.16, softness: 0.08, spill: 0.5 }, cfg.key || {}),
    });
    vs.mover = window.VirtualSet.makeMover(vs.presets);
    if (cfg.bgPath) await loadSetImage(inp, 'bg', cfg.bgPath);
    if (cfg.fgPath) await loadSetImage(inp, 'fg', cfg.fgPath);
    // Render one frame up front so the tile is never a black square.
    try { vs.surface.render({ source: null, pos: vs.mover.current(), key: vs.key }); } catch (e) {}
    return registerInput(inp);
  }

  function addTitle(cfg) {
    const inp = makeInput('title', (cfg && cfg.headline) || 'Title');
    inp.title = Object.assign({ headline: 'Sunday Service', subtext: '', style: 'lower', color: '#ffffff', accent: null }, cfg || {});
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    inp.el = cv;
    renderTitle(inp);
    return registerInput(inp);
  }

  function renderTitle(inp) {
    const cv = inp.el, c = cv.getContext('2d');
    const t = inp.title;
    const accent = t.accent || (st.settings && st.settings.brand && st.settings.brand.primaryColor) || '#1f6feb';
    c.clearRect(0, 0, cv.width, cv.height);
    if (t.style === 'full') {
      c.fillStyle = 'rgba(10,12,18,0.88)'; c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = accent; c.fillRect(0, cv.height * 0.62, cv.width, 6);
      c.fillStyle = t.color; c.font = 'bold 84px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(t.headline, cv.width / 2, cv.height * 0.46);
      if (t.subtext) { c.font = '42px Arial'; c.fillStyle = 'rgba(255,255,255,0.85)'; c.fillText(t.subtext, cv.width / 2, cv.height * 0.72); }
      c.textAlign = 'left';
    } else {
      const bh = t.subtext ? 118 : 86;
      const y = cv.height - 72 - bh;
      const grad = c.createLinearGradient(0, 0, cv.width * 0.72, 0);
      grad.addColorStop(0, 'rgba(10,12,18,0.92)'); grad.addColorStop(1, 'rgba(10,12,18,0)');
      c.fillStyle = grad; c.fillRect(0, y, cv.width * 0.72, bh);
      c.fillStyle = accent; c.fillRect(0, y, 8, bh);
      c.fillStyle = t.color; c.font = 'bold 46px Arial'; c.textBaseline = 'middle';
      c.fillText(t.headline, 30, y + (t.subtext ? bh * 0.36 : bh / 2));
      if (t.subtext) { c.font = '30px Arial'; c.fillStyle = 'rgba(255,255,255,0.8)'; c.fillText(t.subtext, 30, y + bh * 0.74); }
    }
    inp.name = t.headline || 'Title';
  }

  /* ------- List / Image Sequence (one input, several files in order) ------- */

  function addListInput(items, name) {
    const inp = makeInput('list', name || 'List');
    inp.listItems = items.map((it) => ({ ...it }));
    inp.listIdx = -1;
    inp.loop = true;
    advanceList(inp, 0);
    return registerInput(inp);
  }

  /** Swap this input's rendered element (video<->image as the list advances). */
  function swapListElement(inp, newEl, isVideo) {
    const old = inp.el;
    try { if (inp.srcNode) inp.srcNode.disconnect(); } catch (e) {}
    try { if (inp.gain) inp.gain.disconnect(); } catch (e) {}
    try { if (inp.meter) inp.meter.disconnect(); } catch (e) {}
    try { if (inp.soloGain) inp.soloGain.disconnect(); } catch (e) {}
    inp.srcNode = null; inp.gain = null; inp.meter = null; inp.soloGain = null;
    inp.el = newEl;
    if (old && old.parentNode) { try { old.parentNode.removeChild(old); } catch (e) {} }
    if (isVideo) hookElementAudio(inp, newEl);
  }

  function advanceList(inp, idx) {
    if (inp._listImgTimer) { clearTimeout(inp._listImgTimer); inp._listImgTimer = null; }
    let next = idx;
    if (next >= inp.listItems.length) next = inp.loop ? 0 : inp.listItems.length - 1;
    const it = inp.listItems[next];
    if (!it) return;
    inp.listIdx = next;
    if (it.kind === 'video') {
      const v = document.createElement('video');
      v.src = fileUrl(it.path); v.muted = false; v.playsInline = true; v.preload = 'auto';
      refs.vmxHolder.appendChild(v);
      v.addEventListener('ended', () => advanceList(inp, inp.listIdx + 1));
      swapListElement(inp, v, true);
      v.play().catch(() => {});
    } else {
      const img = document.createElement('img');
      img.src = fileUrl(it.path);
      refs.vmxHolder.appendChild(img);
      swapListElement(inp, img, false);
      inp._listImgTimer = setTimeout(() => advanceList(inp, inp.listIdx + 1), (it.durationSec || 4) * 1000);
    }
    renderInputs();
  }

  /* ------------------------- Video Delay (buffered) ------------------------ */

  function addDelayInput(sourceInp, delaySec) {
    const inp = makeInput('delay', 'Delay: ' + sourceInp.name);
    inp.delaySec = clamp(delaySec || 5, 0.5, 15);
    inp.delaySourceId = sourceInp.id;
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    inp.el = cv;
    const ctx = cv.getContext('2d');
    inp._delayBuf = []; // [{ bmp, t }] oldest..newest
    let lastSample = 0;
    const SAMPLE_MS = 90;
    const tick = async (ts) => {
      const src = inputById(inp.delaySourceId);
      if (src && src.el && (!lastSample || ts - lastSample >= SAMPLE_MS)) {
        lastSample = ts;
        try {
          const [sw, sh] = srcDims(src);
          if (sw && sh) {
            const w = Math.min(960, sw), h = Math.round(w * sh / sw);
            const bmp = await createImageBitmap(src.el, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' });
            inp._delayBuf.push({ bmp, t: performance.now() });
            const cutoff = performance.now() - (inp.delaySec * 1000 + 1000);
            while (inp._delayBuf.length && inp._delayBuf[0].t < cutoff) inp._delayBuf.shift().bmp.close();
          }
        } catch (e) { /* source not ready this tick */ }
      }
      const target = performance.now() - inp.delaySec * 1000;
      let chosen = null;
      for (let i = inp._delayBuf.length - 1; i >= 0; i--) { if (inp._delayBuf[i].t <= target) { chosen = inp._delayBuf[i]; break; } }
      if (chosen) {
        if (cv.width !== chosen.bmp.width) { cv.width = chosen.bmp.width; cv.height = chosen.bmp.height; }
        ctx.drawImage(chosen.bmp, 0, 0);
      }
      inp._delayRaf = requestAnimationFrame(tick);
    };
    inp._delayRaf = requestAnimationFrame(tick);
    if (sourceInp.srcNode) {
      const ac = ensureAudio();
      const delayNode = ac.createDelay(Math.min(30, inp.delaySec + 2));
      delayNode.delayTime.value = inp.delaySec;
      sourceInp.srcNode.connect(delayNode);
      inp._delaySrcNode = sourceInp.srcNode;
      inp.srcNode = delayNode;
      finishAudioHook(inp);
    }
    return registerInput(inp);
  }

  /* ------------- Web Browser / Video Call / PowerPoint (offscreen) --------- */

  function addBrowserInput(url, name, extra) {
    const inp = makeInput((extra && extra.type) || 'web', name || 'Web Browser');
    inp.path = url;
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    inp.el = cv;
    const ctx = cv.getContext('2d');
    const bid = 'bw' + inp.id;
    inp._browserId = bid;
    if (extra && extra.pdfPath) { inp._pdfPath = extra.pdfPath; inp._pdfPage = 1; }
    inp._browserOff = window.api.live.onBrowserFrame(({ id, buf, w, h }) => {
      if (id !== bid) return;
      const blob = new Blob([buf], { type: 'image/jpeg' });
      createImageBitmap(blob).then((bmp) => {
        try {
          if (cv.width !== w) { cv.width = w; cv.height = h; }
          ctx.drawImage(bmp, 0, 0);
        } finally { bmp.close(); }
      }).catch(() => {});
    });
    window.api.live.browserOpen(bid, url).catch((e) => toast('⚠️ ' + (e.message || e), 'error'));
    return registerInput(inp);
  }

  function pptGoToSlide(inp, page) {
    if (!inp._pdfPath) return;
    inp._pdfPage = Math.max(1, page);
    window.api.live.browserNav(inp._browserId, fileUrl(inp._pdfPath) + '#page=' + inp._pdfPage).catch(() => {});
  }

  /* --------------------------- Stream / SRT ingest -------------------------- */

  function addNetStreamInput(url, name) {
    const inp = makeInput('stream', name || 'Network Stream');
    inp.path = url;
    const cv = document.createElement('canvas');
    cv.width = 1280; cv.height = 720;
    inp.el = cv;
    const ctx = cv.getContext('2d');
    const sid = 'ns' + inp.id;
    inp._streamId = sid;
    const img = new Image();
    img.onload = () => {
      try {
        if (cv.width !== img.naturalWidth) { cv.width = img.naturalWidth; cv.height = img.naturalHeight; }
        ctx.drawImage(img, 0, 0);
      } catch (e) {}
    };
    window.api.live.netStreamStart(sid, url).then((res) => {
      inp._streamPollTimer = setInterval(() => {
        img.src = fileUrl(res.framePath) + '?t=' + Date.now();
      }, 90);
    }).catch((e) => toast('⚠️ ' + (e.message || e), 'error'));
    return registerInput(inp);
  }

  /* -------------------------------- NDI ------------------------------------ */
  // Real NDI receive. Video frames arrive as JPEGs (main.js encodes the BGRA the
  // NDI runtime hands us) and are drawn on the input's canvas — identical to the
  // Web Browser / Stream inputs. Audio arrives as stereo float PCM and is played
  // through an AudioWorklet (audio-render thread, so heavy canvas work on the
  // main thread can't glitch it) whose output plugs into the mixer as this
  // input's source node — so per-input volume, metering, auto-mix and the master
  // bus all "just work". Audio-only NDI sources (e.g. "vMix Audio - Master")
  // become audio-only inputs; sources with video become normal visual inputs.

  // The AudioWorklet processor lives in its own same-origin file (ndi-audio-
  // worklet.js) so it loads under the app's script-src 'self' CSP — a blob:
  // URL module would be blocked. Loaded lazily, once.
  // How much sound the NDI jitter buffer carries. Small enough that the picture
  // never has to wait long for it, big enough to ride out network jitter and a
  // busy main thread. The worklet holds this depth exactly (see the file).
  const NDI_AUDIO_TARGET_MS = 60;

  function ensureNdiWorklet() {
    const ac = ensureAudio();
    if (!st._ndiWorkletPromise) {
      st._ndiWorkletPromise = ac.audioWorklet.addModule('ndi-audio-worklet.js');
    }
    return st._ndiWorkletPromise;
  }

  async function setupNdiAudio(inp) {
    const ac = ensureAudio();
    try { await ensureNdiWorklet(); } catch (e) { return; }
    if (inp._closed) return;
    const node = new AudioWorkletNode(ac, 'ndi-audio', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { targetMs: NDI_AUDIO_TARGET_MS },
    });
    // The worklet reports how much sound it is holding — that IS the audio
    // latency, and the A/V sync controller needs the real number, not a guess.
    node.port.onmessage = (e) => {
      const d = e.data || {};
      // What the receiver's downmix did, relayed from the receiver's own port.
      if (d.kind === 'mix') { onNdiAudioMsg(inp, d); return; }
      // When a packet reached the audio thread, for the A/V sync controller.
      if (d.arr) { noteArrival(inp, 'audio', d.ts, ctxTimeToPerfMs(d.ct)); return; }
      if (typeof d.routed === 'boolean' && typeof d.queueMs !== 'number') { inp._ndiAudioVia = d.routed ? 'worklet' : 'main'; return; }
      if (typeof d.queueMs !== 'number') return;
      const s = syncOf(inp);
      s.queueMs = d.queueMs;
      s.targetMs = d.targetMs || 0;
      s.underruns = d.underruns || 0;
      s.underrunEvents = d.underrunEvents || 0;
      s.startupDropouts = d.startupDropouts || 0;
      s.skips = d.skips || 0;
      s.trimPpm = d.trimPpm || 0;
      s.clockPpm = d.clockPpm || 0;
      if (d.routed) {
        // The sound bypasses this thread entirely, so what it would have
        // counted on arrival is counted where the sound now arrives.
        inp._ndiAudioRx = d.rx || 0;
        s.srcRate = d.srcRate || 0;
        s.maxAudioGapMs = d.maxGapMs || 0;
        s.senderGapMs = d.senderGapMs || 0;
        s.receiverGapMs = d.receiverGapMs || 0;
        if (d.fed && !s.fedFrom) { s.fedFrom = performance.now(); s.fedBase = d.fed; }
        if (s.fedFrom && st.ac && d.srcRate) s.fedSamples = (d.fed - (s.fedBase || 0)) * (st.ac.sampleRate / d.srcRate);
      }
    };
    inp._ndiAudioNode = node;
    inp.srcNode = node;
    finishAudioHook(inp);
    routeNdiAudio(inp);
  }

  /*
   * THE SOUND GOES STRAIGHT TO THE AUDIO THREAD.
   *
   * The receiver process hands its audio packets down their own MessagePort.
   * They used to land HERE, on the renderer's main thread — the thread that
   * composites every video frame, paints the thumbnails and answers the desk —
   * and wait their turn before being passed on to the worklet. At 1080p that
   * thread is busy most of the time and pauses for garbage collection now and
   * then; every pause longer than the worklet's cushion was a dropout, and
   * every dropout made the cushion (and the lip-sync offset) grow.
   *
   * A MessagePort can be transferred into an AudioWorklet (the capture
   * worklet already relies on that), so the receiver's port is handed to the
   * NDI worklet itself and packets go from the receiver process to the audio
   * render thread with nothing in between. If the transfer is refused, the
   * port is relayed here exactly as before.
   *
   * The node and the port arrive in either order — the port comes with the
   * receiver's start-up, the node after the worklet module loads — so whichever
   * turns up second completes the routing.
   */
  function routeNdiAudio(inp) {
    const port = inp._ndiAudioPort, node = inp._ndiAudioNode;
    if (!port || !node || inp._closed) return;
    inp._ndiAudioPort = null;
    try {
      node.port.postMessage({ cmd: 'route', port }, [port]);
      inp._ndiAudioVia = 'worklet';
    } catch (e) {
      relayNdiAudioPort(inp, port);
    }
  }
  function relayNdiAudioPort(inp, port) {
    inp._ndiAudioVia = 'main';
    port.onmessage = (m) => {
      const msg = m.data;
      if (msg && (msg.kind === 'audio' || msg.kind === 'mix')) onNdiAudioMsg(inp, msg);
    };
    try { port.start(); } catch (e) {}
  }

  /**
   * A moment on the audio context's clock (as the worklet saw it) expressed on
   * this thread's performance.now(), less the output latency — i.e. when the
   * packet ARRIVED, which is what noteArrival records for the sync maths.
   * `getOutputTimestamp` pairs a context time with the performance time it is
   * heard at; the worklet's currentTime runs ahead of that by the output
   * latency, which is subtracted back out.
   */
  function ctxTimeToPerfMs(ct) {
    const ac = st.ac;
    try {
      const o = ac && ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
      if (o && o.performanceTime && typeof ct === 'number') {
        return o.performanceTime + (ct - o.contextTime) * 1000 - outputLatencyMs();
      }
    } catch (e) {}
    return performance.now();
  }

  /* ---------------------- SAMPLE-RATE CONVERSION ---------------------------
   *
   * What was here before was called resampleLinear, and it converted each NDI
   * packet INDEPENDENTLY: it computed `outLen = round(n * ratio)` and walked a
   * read position that restarted at zero for every packet. Both halves of that
   * are wrong, and neither is a subtle wrongness.
   *
   * THE PHASE RESET IS THE NOISE. A resampler's read position lands between
   * input samples, and where it lands has to carry on from wherever the last
   * packet left it. Restarting at 0 every packet re-aligns the output to the
   * input grid ~47 times a second, which is a step change in the interpolation
   * error — broadband, signal-correlated, and utterly unlike the thing that
   * went in. Measured on steady tones, 48 kHz in and 44.1 kHz out, distortion
   * as dB relative to the tone (lower is cleaner; -60 dB is transparent):
   *
   *      tone     packets of 1600   packets of 800/801   packets of 1024
   *      1 kHz        -63.9 dB           -15.8 dB            -3.1 dB
   *      3 kHz        -44.7 dB            -5.7 dB           +34.0 dB
   *      6 kHz        -32.2 dB            +2.6 dB           +34.0 dB
   *
   * A positive number means THE DISTORTION WAS LOUDER THAN THE SIGNAL. The
   * only column that behaves is 1600 samples — because 1600 × 44100/48000 is
   * exactly 1470, so the phase happens to come back to zero on its own and the
   * bug hides. Senders that packetise any other way (800/801 alternating on a
   * 59.94 feed, a flat 1024, anything jittery) get the other columns. That is
   * why this could sound fine on one rig and appalling on the next.
   *
   * THE ROUNDING IS THE DRIFT. `round(n * ratio)` per packet accumulates the
   * rounding error forever: measured at +765 ms per hour on 1024-sample
   * packets, +199 ms/hr on 800/801. The sound simply gains on the picture, and
   * nothing downstream can correct it because nothing downstream is told.
   *
   * WHAT REPLACES IT is an ordinary polyphase windowed-sinc converter, which is
   * what every real SRC is: a band-limiting filter and the interpolation are
   * the same operation. It keeps the read phase and a tail of input history
   * ACROSS packets, so packet boundaries stop existing as far as the signal is
   * concerned, and it emits exactly the number of samples the running phase
   * earns — never a rounded guess — so there is no drift to accumulate.
   *
   * Cost, for the case that still needs it: 16 taps × 2 channels × 48 000/s is
   * about 1.5 M multiply-adds a second, which is nothing next to one video
   * frame. And after ensureAudio started ASKING for 48 kHz, the ordinary NDI
   * feed matches the bus exactly and takes the passthrough below instead.
   */
  /** The converter itself lives in audio-resampler.js — see its header. */
  const makeResampler = (fromRate, toRate) => AudioResampler.make(fromRate, toRate);

  /*
   * The FALLBACK route only — normally the receiver's port is handed to the
   * worklet and nothing passes through here (see routeNdiAudio).
   *
   * The sender's rate travels with the samples and the worklet converts: its
   * read position already moves at a rate that is not exactly 1 (it is how
   * two crystals are reconciled), so a 44.1 kHz sender into a 48 kHz bus is
   * the same operation with a different nominal ratio. One converter in the
   * path, not a second one stacked in front of it.
   */
  function feedNdiAudio(inp, sampleRate, left, right) {
    const node = inp._ndiAudioNode;
    const s = syncOf(inp);
    if (!node || !st.ac) { s.droppedPackets = (s.droppedPackets || 0) + 1; return; }
    const to = st.ac.sampleRate;
    const from = sampleRate || to;
    if (!s.fedFrom) s.fedFrom = performance.now();
    s.fedSamples = (s.fedSamples || 0) + left.length * (to / from);
    s.srcRate = from;
    s.acRate = to;
    if (!left.length) return;
    try { node.port.postMessage({ l: left, r: right, sr: from }, [left.buffer, right.buffer]); } catch (e) {}
  }

  /*
   * The input's own canvas is a WebGL surface (it has to be — see ndi-video.js),
   * so the "connecting…" card is painted on a scratch 2D canvas and handed to
   * the surface as an ordinary RGBA frame. Once real video arrives it simply
   * overwrites this, exactly like any other frame.
   */
  function drawNdiPlaceholder(inp, note) {
    if (!inp._ndiSurface || inp._ndiGotVideo) return;
    const W = 1280, H = 720;
    let cv = st._phCanvas;
    if (!cv) { cv = st._phCanvas = document.createElement('canvas'); cv.width = W; cv.height = H; }
    const c = cv.getContext('2d');
    c.fillStyle = '#0b0d12'; c.fillRect(0, 0, W, H);
    c.fillStyle = '#1f6feb'; c.font = 'bold 84px Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('NDI', W / 2, H / 2 - 24);
    c.fillStyle = '#e7ecf3'; c.font = '30px Arial';
    c.fillText(inp.name || 'NDI source', W / 2, H / 2 + 40);
    if (note) { c.fillStyle = '#8a93a6'; c.font = '22px Arial'; c.fillText(note, W / 2, H / 2 + 82); }
    c.textAlign = 'left';
    try {
      const d = c.getImageData(0, 0, W, H);
      inp._ndiSurface.upload({ w: W, h: H, fmt: 'rgba', buf: new Uint8Array(d.data.buffer) });
    } catch (e) {}
  }

  /** Uint8Array (from IPC) of Float32 bytes -> owned Float32Array. */
  function ipcFloats(u8) {
    return new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
  }

  /* ------------------------- NDI frame transport --------------------------- */
  /*
   * Each NDI receiver is its own process, joined to this one by a MessagePort
   * that the preload forwards into the page. Frames therefore arrive here
   * WITHOUT passing through the Electron main process — which is what keeps main
   * free to feed ffmpeg, and is the difference between a broadcast that stutters
   * and one that does not. See src/main/ndi-proc.js.
   *
   * A received video frame is NOT drawn on arrival. It is parked as the input's
   * pending frame, replacing any earlier one, and the compositor uploads it when
   * it next draws (flushNdiFrames). Three things follow:
   *   - a source running faster than the production rate costs one texture
   *     upload per COMPOSITED frame, not per received frame;
   *   - a burst never queues up behind the compositor: the newest frame always
   *     wins, so the picture cannot drift progressively later than the sound;
   *   - frames reach the screen strictly in order. The old path decoded each
   *     JPEG through an async createImageBitmap, and those promises could settle
   *     out of order, which is visible as judder even when nothing is dropped.
   */
  const ndiPorts = new Map();     // ndiId -> MessagePort[]  (video, audio)
  const ndiHandlers = new Map();  // ndiId -> { onVideo, onAudio }

  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || !d.__ndiPort || !ev.ports || !ev.ports.length) return;
    const id = d.id;
    /*
     * ONLY OUR OWN RECEIVERS.
     *
     * Go Live is no longer the only part of the app that speaks NDI —
     * Presentation's 🎤 Listen receives a sound-desk feed too (ndi-listen.js),
     * and every receiver's ports are delivered to the page on the same
     * window message. This handler used to claim them all, so it would take
     * another module's ports, overwrite the onmessage that module had just
     * set, look the id up in a map that does not contain it and drop every
     * frame. Symptom: a receiver that starts perfectly and then delivers
     * absolutely nothing.
     *
     * The handler is always registered before ndi:start is called, so an id
     * that is not in the map is not ours.
     */
    if (!ndiHandlers.has(id)) return;
    releaseNdiPort(id, true);
    // Video and audio arrive on SEPARATE ports so a multi-megabyte frame can
    // never hold a two-kilobyte audio packet up behind it (see ndi-proc.js).
    const ports = [...ev.ports];
    const h0 = ndiHandlers.get(id);
    // The AUDIO port is not listened to here at all when the input can take
    // it: it goes on to the audio thread (see routeNdiAudio).
    if (ports.length >= 2 && h0 && h0.onAudioPort) {
      const audioPort = ports.pop();
      h0.onAudioPort(audioPort);
    }
    ndiPorts.set(id, ports);
    ports.forEach((port, i) => {
      port.onmessage = (m) => {
        const msg = m.data;
        if (!msg) return;
        const h = ndiHandlers.get(id);
        if (!h) return;
        if (msg.kind === 'video') { if (h.onVideo) h.onVideo(msg); }
        // 'mix' rides the audio port and goes to the same handler: it is a
        // statement ABOUT the audio (how many channel pairs were averaged to
        // make it), and dropping anything that was not exactly 'audio' here is
        // what made it silently never arrive.
        else if (msg.kind === 'audio' || msg.kind === 'mix') { if (h.onAudio) h.onAudio(msg); }
      };
      port.start();
    });
  });

  function releaseNdiPort(id, keepHandlers) {
    if (!keepHandlers) ndiHandlers.delete(id);
    const ports = ndiPorts.get(id);
    if (ports) {
      for (const p of ports) { try { p.onmessage = null; p.close(); } catch (e) {} }
      ndiPorts.delete(id);
    }
  }

  /* ============================ VIRTUAL SET ================================
   *
   * Each virtual-set input owns a scene (see vset.js) that keys its chosen
   * camera into a studio background. It is re-rendered once per compositor
   * frame, in the same pass that uploads NDI, so the program, the preview and
   * every thumbnail below read ONE consistent picture of it.
   *
   * A set that nobody can see is not rendered at all — GPU work for a frame no
   * one is looking at is exactly the kind of cost this app has already had to
   * hunt down twice. It stays live while it is on program or preview, while it
   * is an overlay, while its own settings dialog is open (so the operator can
   * line the shot up), or while it is being recorded by a MultiCorder.
   */
  function vsetVisible(inp) {
    if (st.programId === inp.id || st.previewId === inp.id) return true;
    if (st.trans && (st.trans.from === inp.id || st.trans.to === inp.id)) return true;
    if (st.ovl.some((o) => o.id === inp.id && o.level > 0)) return true;
    if (st.multicorders.some((m) => m.inputId === inp.id)) return true;
    if (st._vsetTuning === inp.id) return true;
    return false;
  }

  function stepVirtualSets() {
    for (const inp of st.inputs) {
      const vs = inp._vset;
      if (!vs || !vs.surface) continue;
      // A move must finish even out of sight, or bringing the input up mid-glide
      // would show the camera drifting into place on air.
      const moving = vs.mover.moving;
      if (!vsetVisible(inp) && !moving) continue;
      const src = inputById(vs.sourceId);
      const el = src ? drawSourceOf(src) : null;
      try {
        vs.surface.render({ source: el, pos: vs.mover.current(), key: vs.key });
        vs.renders = (vs.renders || 0) + 1;
      } catch (e) { /* a lost context is handled on the next settings open */ }
    }
  }

  /** Build (or rebuild) the scene behind a virtual-set input. */
  function buildVirtualSet(inp, cfg) {
    const q = quality();
    const vs = inp._vset || (inp._vset = {
      sourceId: null, presets: window.VirtualSet.DEFAULT_PRESETS.map((p) => ({ ...p })),
      key: { on: true, color: '#00b140', tolerance: 0.16, softness: 0.08, spill: 0.5 },
      bgPath: '', fgPath: '', surface: null, mover: null,
    });
    Object.assign(vs, cfg || {});
    if (!vs.surface) {
      vs.surface = window.VirtualSet.createSet(q.width, q.height);
      inp.el = vs.surface.canvas;
    }
    vs.surface.setSize(q.width, q.height);
    if (!vs.mover) vs.mover = window.VirtualSet.makeMover(vs.presets);
    return vs;
  }

  function loadSetImage(inp, which, path) {
    const vs = inp._vset;
    if (!vs || !vs.surface) return Promise.resolve(false);
    if (!path) {
      if (which === 'bg') { vs.bgPath = ''; vs.surface.setBackground(null); }
      else { vs.fgPath = ''; vs.surface.setForeground(null); }
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        if (which === 'bg') { vs.bgPath = path; vs.surface.setBackground(img); }
        else { vs.fgPath = path; vs.surface.setForeground(img); }
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = /^(file|data|https?):/.test(path) ? path : fileUrl(path);
    });
  }

  /** Switch a virtual set to one of its four positions, gliding by default. */
  function vsetGoTo(id, index, ms) {
    const inp = inputById(id);
    if (!inp || !inp._vset) return false;
    inp._vset.mover.goTo(index, ms);
    renderInputs();
    return true;
  }

  /**
   * Upload each NDI input's newest frame, once, just before the compositor reads
   * it. Returns nothing; inputs with no new frame keep showing the last one.
   */
  function flushNdiFrames() {
    for (const inp of st.inputs) {
      const f = inp._ndiPending;
      if (!f || !inp._ndiSurface) continue;
      inp._ndiPending = null;
      let drawn = false;
      try { drawn = inp._ndiSurface.upload(f); } catch (e) {}
      if (!drawn) continue;
      inp._ndiFrames = (inp._ndiFrames || 0) + 1;
      // With a hold-back active the picture is played out late, so the frame
      // also goes into the delay queue stamped with when it ARRIVED — not with
      // now, which would add this upload's own latency to the operator's offset.
      if (videoDelayMs(inp) > 0) {
        const vd = ensureVDelay(inp);
        if (!vd.busy) {
          vd.busy = true;
          createImageBitmap(inp._ndiSurface.canvas)
            .then((bmp) => { vd.busy = false; pushDelayedFrame(inp, bmp, f.at); })
            .catch(() => { vd.busy = false; });
        }
      }
    }
  }

  function addNdiInput(source, opts) {
    opts = opts || {};
    const audioOnly = !!opts.audioOnly;
    const name = source.display || source.stream || source.name || 'NDI';
    const inp = makeInput(audioOnly ? 'ndaudio' : 'ndi', name);
    inp._ndiId = 'ndi' + inp.id;
    inp._ndiSource = source;

    if (!audioOnly) {
      // A GPU surface, not a plain 2D canvas: NDI delivers UYVY, and turning it
      // into pixels is a shader pass rather than a per-pixel loop. See
      // src/renderer/ndi-video.js.
      inp._ndiSurface = window.NdiVideo.createSurface();
      inp.el = inp._ndiSurface.canvas;
      drawNdiPlaceholder(inp, 'connecting…');
      ndiHandlers.set(inp._ndiId, {
        onVideo: (msg) => {
          if (inp._closed) return;
          if (!inp._ndiGotVideo) {
            // The placeholder was drawn straight onto this canvas; the first real
            // frame takes the surface over from here.
            inp._ndiGotVideo = true;
            inp._ndiAudioOnly = false; // real video source — audio follows program again
          }
          noteArrival(inp, 'video', msg.ts);
          noteNdiRate(inp, msg.srcFps);
          inp._ndiFmt = msg.fmt;
          // Newest wins: an older pending frame is already stale by definition.
          inp._ndiPending = { w: msg.w, h: msg.h, fmt: msg.fmt, buf: msg.buf, at: performance.now() };
        },
        onAudio: (msg) => onNdiAudioMsg(inp, msg),
        onAudioPort: (port) => takeNdiAudioPort(inp, port),
      });
      // If no video ever arrives, it's an audio-only NDI source (Ableton's
      // "NDI Output" VST, "vMix Audio - Master"…) added without the Audio Only
      // checkbox. Treat its audio as always-on — auto-mix would otherwise mute
      // it because a placeholder input is never on program (vMix auto-types
      // these as Audio inputs for the same reason).
      inp._ndiPlaceholderTimer = setTimeout(() => {
        if (!inp._ndiGotVideo && !inp._closed) {
          inp._ndiAudioOnly = true;
          drawNdiPlaceholder(inp, 'audio source — no video');
        }
      }, 4000);
    }

    inp._ndiAudioRx = 0;
    if (audioOnly) {
      ndiHandlers.set(inp._ndiId, {
        onAudio: (msg) => onNdiAudioMsg(inp, msg),
        onAudioPort: (port) => takeNdiAudioPort(inp, port),
      });
    }

    setupNdiAudio(inp);
    window.api.live.ndiStart(inp._ndiId, source, {
      audioOnly, lowBandwidth: !!opts.lowBandwidth, fpsCap: ndiFpsCap(),
    }).catch((e) => toast('⚠️ NDI: ' + (e.message || e), 'error'));

    return registerInput(inp);
  }

  /** The receiver's audio port has arrived: route it once the worklet exists. */
  function takeNdiAudioPort(inp, port) {
    if (inp._closed) { try { port.close(); } catch (e) {} return; }
    inp._ndiAudioPort = port;
    routeNdiAudio(inp);
  }

  function onNdiAudioMsg(inp, msg) {
    if (inp._closed) return;
    /*
     * The receiver tells us what its channel downmix did (see ndi-proc.js).
     * More than one pair carrying sound means they are being AVERAGED, so the
     * programme arrives at 1/active of its level with the other pair mixed in.
     * An Ableton "NDI Output" VST publishing two pairs, or anything bleeding
     * onto 1-2, does that — and it is 6 dB of a Sunday service nobody can
     * account for unless somebody says so.
     */
    if (msg && msg.kind === 'mix') {
      inp._ndiMix = { channels: msg.channels, pairs: msg.pairs, active: msg.active, gain: msg.gain };
      if (msg.active > 1 && !inp._ndiMixWarned) {
        inp._ndiMixWarned = true;
        toast(`🎚️ ${inp.name} is sending sound on ${msg.active} channel pairs of ${msg.channels}. `
          + `They are being averaged, so the programme is ${Math.round(1 / (msg.gain || 1))}x quieter than it was sent `
          + `and whatever is on the other pair is mixed into it. If only one pair should be live, set the sender `
          + `(in Ableton, the NDI Output plug-in) to that pair alone.`, 'error');
      }
      return;
    }
    const { sampleRate, ts, left, right } = msg;
    inp._ndiAudioRx++;
    // How evenly the sound is actually being handed to us. A long gap here is a
    // stall in this renderer, not a network problem — worth being able to see.
    const s0 = syncOf(inp);
    const nowMs = performance.now();
    if (s0.lastAudioAt) s0.maxAudioGapMs = Math.max(s0.maxAudioGapMs || 0, nowMs - s0.lastAudioAt);
    s0.lastAudioAt = nowMs;
    noteArrival(inp, 'audio', ts);
    feedNdiAudio(inp, sampleRate, ipcFloats(left), ipcFloats(right));
  }

  /**
   * The rate NDI receivers are asked to deliver at. Sending faster than the
   * compositor draws is wasted work in three processes at once, so this follows
   * the production rate — with headroom, because the production rate is itself
   * derived from what the sources deliver and must not be able to ratchet
   * anything downward.
   */
  function ndiFpsCap() { return clamp(Math.round((st.targetFps || productionFps() || 30) * 1.25), 30, 120); }

  /**
   * Record what rate this NDI source RUNS AT. `srcFps` is the sender's own
   * declared rate and is what the production rate is built from — measuring it
   * from arrivals instead would feed our own delivery cap back into the cap that
   * produced it, and a 60fps source would walk itself down to nothing. The
   * measured interval is kept too, but only for diagnostics.
   */
  function noteNdiRate(inp, srcFps) {
    const now = performance.now();
    if (inp._ndiLastAt) {
      const dt = now - inp._ndiLastAt;
      if (dt > 3 && dt < 200) inp._ndiIntervalMs = inp._ndiIntervalMs ? inp._ndiIntervalMs * 0.9 + dt * 0.1 : dt;
    }
    inp._ndiLastAt = now;
    const f = Number(srcFps) || 0;
    if (f > 1 && f <= 120) inp._ndiSrcFps = f;
  }
  /** The source's true rate: what it says it runs at, else what we have seen. */
  function ndiFpsOf(inp) {
    if (inp._ndiSrcFps) return inp._ndiSrcFps;
    return inp._ndiIntervalMs ? 1000 / inp._ndiIntervalMs : 0;
  }
  /** What we are actually receiving right now (diagnostics only). */
  function ndiDeliveredFps(inp) { return inp._ndiIntervalMs ? 1000 / inp._ndiIntervalMs : 0; }

  /* --------------------------- Instant Replay ------------------------------- */

  async function armInstantReplay() {
    if (st.replayArmed) return;
    applyQuality();
    refreshOutStream();
    if (!(await ensureProgramEncoder([quality()]))) return;
    let res;
    // fps must be the CAPTURE's rate, not a fresh measurement — a re-measure
    // that lands one frame off is a silent full re-encode in the hub.
    try { res = await window.api.live.recStart({ recId: 'replay', name: 'instant-replay', quality: liveCfg().quality || DEFAULT_QUALITY, fps: st.outStreamFps || productionFps(), audioFormat: liveCfg().recAudioFormat }); }
    catch (e) {
      toast('⚠️ Could not arm Instant Replay: ' + (e.message || e), 'error');
      await maybeStopProgramEncoder();
      return;
    }
    st.replayFile = res && res.file ? res.file : '';
    st.replayArmed = true;
    st.replayStartedAt = Date.now();
  }

  async function takeInstantReplay() {
    if (!st.replayArmed) { toast('⚠️ Instant Replay is still buffering — try again in a moment.', 'error'); return null; }
    st.replayArmed = false;
    const file = st.replayFile;
    try { await window.api.live.recStop('replay'); } catch (e) {}
    await armInstantReplay(); // re-arm immediately so buffering never has a gap
    return file;
  }

  /** Stop buffering Instant Replay entirely (e.g. when closing the studio). */
  async function disarmInstantReplay() {
    if (!st.replayArmed) return;
    st.replayArmed = false;
    try { await window.api.live.recStop('replay'); } catch (e) {}
    await maybeStopProgramEncoder();
  }

  /* ------- input removal ------- */

  function closeInput(id) {
    const idx = st.inputs.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const inp = st.inputs[idx];
    stopMulticorderFor(id);
    if (inp._syntheticTimer) clearInterval(inp._syntheticTimer);
    if (inp._pulseTimer) clearTimeout(inp._pulseTimer);
    if (inp._vset && inp._vset.surface) { try { inp._vset.surface.destroy(); } catch (e) {} inp._vset.surface = null; }
    if (inp._listImgTimer) clearTimeout(inp._listImgTimer);
    if (inp._delayRaf) cancelAnimationFrame(inp._delayRaf);
    if (inp._delayBuf) { inp._delayBuf.forEach((b) => { try { b.bmp.close(); } catch (e) {} }); }
    if (inp._delaySrcNode && inp.srcNode) { try { inp._delaySrcNode.disconnect(inp.srcNode); } catch (e) {} }
    if (inp._browserId) { try { window.api.live.browserClose(inp._browserId); } catch (e) {} if (inp._browserOff) inp._browserOff(); }
    if (inp._streamId) { try { window.api.live.netStreamStop(inp._streamId); } catch (e) {} if (inp._streamPollTimer) clearInterval(inp._streamPollTimer); }
    if (inp._ndiId) {
      inp._closed = true;
      try { window.api.live.ndiStop(inp._ndiId); } catch (e) {}
      releaseNdiPort(inp._ndiId);
      inp._ndiPending = null;
      if (inp._ndiSurface) { try { inp._ndiSurface.destroy(); } catch (e) {} inp._ndiSurface = null; }
      if (inp._ndiPlaceholderTimer) clearTimeout(inp._ndiPlaceholderTimer);
      try { if (inp._ndiAudioNode) inp._ndiAudioNode.port.postMessage({ cmd: 'close' }); } catch (e) {}
      try { if (inp._ndiAudioNode) inp._ndiAudioNode.disconnect(); } catch (e) {}
      if (inp._ndiAudioPort) { try { inp._ndiAudioPort.close(); } catch (e) {} inp._ndiAudioPort = null; }
    }
    if (inp._vd) { inp._vd.q.forEach((f) => { try { f.bmp.close(); } catch (e) {} }); inp._vd.q = []; inp._vd.ms = 0; }
    try { if (inp.stream) inp.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    try { if (inp.srcNode) inp.srcNode.disconnect(); } catch (e) {}
    try { if (inp.delayNode) inp.delayNode.disconnect(); } catch (e) {}
    try { if (inp.gain) inp.gain.disconnect(); } catch (e) {}
    try { if (inp.soloGain) inp.soloGain.disconnect(); } catch (e) {}
    try { if (inp.el && (inp.el.tagName === 'VIDEO' || inp.el.tagName === 'AUDIO') && !inp.stream) { inp.el.pause(); inp.el.removeAttribute('src'); inp.el.load(); } } catch (e) {}
    try { if (inp.el && inp.el.parentNode) inp.el.parentNode.removeChild(inp.el); } catch (e) {}
    st.inputs.splice(idx, 1);
    st.inputs.forEach((i, n) => { i.num = n + 1; });
    st.ovl.forEach((o) => { if (o.id === id) { o.id = null; o.level = 0; } });
    st.playlist.ids = st.playlist.ids.filter((x) => x !== id);
    if (st.trans && (st.trans.from === id || st.trans.to === id)) st.trans = null;
    const visuals = st.inputs.filter(hasVisual);
    if (st.programId === id) st.programId = visuals.length ? visuals[0].id : null;
    if (st.previewId === id || st.previewId === st.programId) {
      const alt = visuals.find((i) => i.id !== st.programId);
      st.previewId = alt ? alt.id : null;
    }
    renderInputs();
  }

  function closeAllInputs() {
    [...st.inputs].forEach((i) => closeInput(i.id));
    st.previewId = st.programId = null;
    renderInputs();
  }

  /* ================================ AUDIO ================================= */

  /*
   * THE BUS RUNS AT THE SOUND CARD'S RATE, AND IT IS LEFT THAT WAY ON PURPOSE.
   *
   * Everything downstream assumes 48 000: the hub's OUT_SAMPLE_RATE, the AAC
   * the GPU capture encodes, and _canCopyAudio, which hands each destination
   * `-c:a copy` on the stated grounds that the hub is "already producing
   * exactly that, at 48 kHz". Nothing enforced it, so the obvious repair is to
   * ASK for 48 000 here — `new AudioContext({ sampleRate: 48000 })`.
   *
   * THAT WAS TRIED AND MEASURED, AND IT COSTS LIP SYNC. When the device does
   * not natively run at the requested rate, Chromium inserts its own converter
   * on the OUTPUT, and the latency that adds is not reflected in
   * `ac.outputLatency` — which is the number the A/V sync controller corrects
   * against. On test/av-sync.test.js the controller's answer moved from 177 ms
   * to 219 ms while `outputLatency` went on reporting 10 ms: a silent ~42 ms
   * error, in the one direction (sound late) nobody spots until the service is
   * over. Trading a rate mismatch we handle properly for a sync error we cannot
   * see is a bad trade.
   *
   * So the rate is whatever the card gives, and the two places it mattered are
   * fixed where the problem actually is:
   *   - a 48 kHz NDI feed onto a 44.1 kHz bus is converted by a real polyphase
   *     resampler (audio-resampler.js) instead of the per-packet interpolation
   *     that used to put out more distortion than signal and gain 765 ms an
   *     hour on the picture;
   *   - the rate is REPORTED to the hub on program:session, so _canCopyAudio
   *     re-encodes to 48 kHz for the platforms instead of copying 44.1 kHz out
   *     under a promise of 48.
   */
  const PROGRAM_SAMPLE_RATE = 48000;

  function ensureAudio() {
    if (st.ac) return st.ac;
    st.ac = new AudioContext();
    if (st.ac.sampleRate !== PROGRAM_SAMPLE_RATE) {
      // Not an error — just the case the resampler and the hub are told about.
      console.info('Go Live: the sound device is running at ' + st.ac.sampleRate +
                   ' Hz; NDI audio will be rate-converted and the stream re-encoded to ' +
                   PROGRAM_SAMPLE_RATE + ' Hz.');
    }
    st.masterGain = st.ac.createGain();
    /*
     * Master-bus limiter — the last thing between the mix and the encoder.
     *
     * It sits AFTER the master fader and BEFORE the meter, the broadcast/record
     * bus and the headphone monitor, so what the operator sees on the meter and
     * hears in the cans is exactly what the congregation gets on the stream.
     *
     * The real one is a look-ahead brickwall in an AudioWorklet
     * (limiter-worklet.js) — it has to be, because a compressor that reacts
     * after the fact cannot catch the transient at the start of a sung line,
     * which is precisely the sound this exists for. Loading a worklet module is
     * asynchronous, so a DynamicsCompressorNode is wired first and swapped out
     * the moment the real one is ready; the studio is never without protection,
     * not even for the frame it takes to open the audio context.
     */
    st.limiter = st.ac.createDynamicsCompressor();
    st.limiter.threshold.value = -2;
    st.limiter.knee.value = 0;
    st.limiter.ratio.value = 20;
    st.limiter.attack.value = 0.002;
    st.limiter.release.value = 0.25;
    loadLimiterPrefs();
    st.masterAnalyser = st.ac.createAnalyser();
    st.masterAnalyser.fftSize = 1024;
    st.meterBuf = new Uint8Array(st.masterAnalyser.fftSize);
    st.dest = st.ac.createMediaStreamDestination();
    wireLimiterRouting();
    ensureLimiterWorklet();
    // Operator monitor (headphones) path, vMix-style: the mix passes a "gate"
    // (muted while any input is solo'd) then the headphone volume. Solo'd
    // inputs tap straight into the solo bus so the operator hears ONLY them.
    // None of this touches the broadcast bus above.
    st.monitorGate = st.ac.createGain();
    st.monitorGain = st.ac.createGain();
    st.soloBus = st.ac.createGain();
    st.masterAnalyser.connect(st.monitorGate);
    st.monitorGate.connect(st.monitorGain);
    st.soloBus.connect(st.monitorGain);
    st.monitorGain.connect(st.ac.destination);
    st.ac.resume().catch(() => {});
    return st.ac;
  }

  /*
   * The three limiter styles an operator actually needs, in their words.
   *
   * `drive` is how hard the mix is pushed into the ceiling. At 0 dB nothing
   * happens at all until the mix WOULD have clipped, which is what a safety net
   * means. Above it, the loud parts are held down and the quiet parts come up
   * in relation — which is what makes a service audible on a phone in a car
   * park, and what a church means when it says "the stream is too quiet, then
   * the singing blasts".
   */
  const LIMITER_STYLES = {
    safety:    { label: 'Safety net (recommended)', drive: 0, release: 150,
                 hint: 'Does nothing at all until the mix would clip, then stops it. Your sound is otherwise untouched.' },
    broadcast: { label: 'Even it out', drive: 4, release: 120,
                 hint: 'Also holds the loud parts down a little, so quiet speech and full-voice singing sit closer together.' },
    loud:      { label: 'Loud & even', drive: 8, release: 90,
                 hint: 'Holds them down firmly. Best when most people watch on a phone, but it does change how the music breathes.' },
  };
  /*
   * SAFETY NET IS THE DEFAULT, and that is the whole point.
   *
   * The limiter this replaces was a DynamicsCompressorNode at 20:1 with a 250 ms
   * release, always on. Fed a congregation singing, that is not protection — it
   * is an effect: the whole mix ducks on every loud phrase and swells back
   * between them, which is exactly what "the audio is weird, especially when
   * people sing" describes. A safety net has to be inaudible when it is not
   * needed, so the default touches nothing until the sound would otherwise
   * clip. Anyone who WANTS the levelling can have it; nobody gets it by
   * accident.
   */
  const DEFAULT_LIMITER = { on: true, style: 'safety', ceilingDb: -1 };

  function loadLimiterPrefs() {
    const d = DEFAULT_LIMITER;
    st.limiterOn = d.on; st.limiterStyle = d.style; st.limiterCeiling = d.ceilingDb;
    try {
      const raw = localStorage.getItem('mw-vmx-limiter-cfg');
      if (raw) {
        const c = JSON.parse(raw);
        if (typeof c.on === 'boolean') st.limiterOn = c.on;
        if (LIMITER_STYLES[c.style]) st.limiterStyle = c.style;
        if (typeof c.ceilingDb === 'number') st.limiterCeiling = clamp(c.ceilingDb, -6, -0.1);
      } else {
        // the old on/off-only key from before the limiter had settings
        const legacy = localStorage.getItem('mw-vmx-limiter');
        if (legacy != null) st.limiterOn = legacy !== '0';
      }
    } catch (e) {}
  }
  function saveLimiterPrefs() {
    try {
      localStorage.setItem('mw-vmx-limiter-cfg', JSON.stringify({
        on: st.limiterOn, style: st.limiterStyle, ceilingDb: st.limiterCeiling,
      }));
    } catch (e) {}
  }
  function limiterStyle() { return LIMITER_STYLES[st.limiterStyle] || LIMITER_STYLES.broadcast; }
  function limiterOpts() {
    const s = limiterStyle();
    return { cmd: 'opts', ceilingDb: st.limiterCeiling, driveDb: s.drive, releaseMs: s.release };
  }

  /**
   * Build the real look-ahead limiter, once. Everything keeps working if this
   * fails — the DynamicsCompressor already in the chain stays — so a machine
   * that cannot load the worklet is protected, just less precisely.
   */
  function ensureLimiterWorklet() {
    if (st._limWorkletPromise) return st._limWorkletPromise;
    const ac = st.ac;
    if (!ac || !ac.audioWorklet) return Promise.resolve(null);
    st._limWorkletPromise = ac.audioWorklet.addModule('limiter-worklet.js').then(() => {
      const node = new AudioWorkletNode(ac, 'program-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { ...limiterOpts(), lookMs: 5 },
      });
      node.port.onmessage = (e) => { st.limMeter = e.data || null; };
      st.limNode = node;
      wireLimiterRouting();
      return node;
    }).catch((e) => {
      /*
       * SAID OUT LOUD, not just logged.
       *
       * The fallback is a DynamicsCompressorNode at threshold -2, ratio 20,
       * release 250 ms, and it is ALWAYS ON. That is not a quieter version of
       * the limiter, it is a different effect: fed a congregation singing, the
       * whole mix ducks on every loud phrase and swells back between them.
       * v2.12.0 identified that breathing as the "audio is weird, especially
       * when people sing" this app was reported for, and replaced it — so if
       * the replacement ever fails to load, the church is back on the exact
       * sound that was fixed, for the whole service, with only a console
       * warning nobody will ever see.
       */
      console.warn('Look-ahead limiter unavailable, using the fallback compressor:', e);
      st.limWorkletFailed = true;
      toast('⚠️ The broadcast limiter could not start, so a simpler one is protecting the mix. '
        + 'It can make singing sound as though it is breathing in and out. Restart the app before the service if you can.',
        'error', 16000);
      return null;
    });
    return st._limWorkletPromise;
  }

  /**
   * The program-audio tap the broadcast encoder reads from.
   *
   * Built once and left connected to the master bus for the life of the app: a
   * worklet costs nothing while nobody is listening to its messages, and
   * creating one at the moment a broadcast starts would miss the first samples.
   * See capture-audio-worklet.js for why the sound cannot be collected on the
   * main thread at 1080p.
   */
  function ensureCaptureWorklet() {
    if (st._capWorkletPromise) return st._capWorkletPromise;
    const ac = st.ac;
    if (!ac || !ac.audioWorklet) return Promise.resolve(null);
    st._capWorkletPromise = ac.audioWorklet.addModule('capture-audio-worklet.js').then(() => {
      const node = new AudioWorkletNode(ac, 'mw-program-capture', {
        numberOfInputs: 1, numberOfOutputs: 0,
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { chunkMs: 100 },
      });
      st.capNode = node;
      wireLimiterRouting();     // put it on the bus alongside the broadcast dest
      return node;
    }).catch((e) => {
      // Everything still works: the capture falls back to reading the media
      // stream on the main thread, which is what it always did.
      console.warn('Program audio capture worklet unavailable, using the stream reader:', e);
      return null;
    });
    return st._capWorkletPromise;
  }

  /** The node that is actually doing the limiting right now. */
  function limiterNode() { return st.limNode || st.limiter; }

  /** Route the master bus through the limiter (on) or straight through (off). */
  function wireLimiterRouting() {
    try { st.masterGain.disconnect(); } catch (e) {}
    try { st.limiter.disconnect(); } catch (e) {}
    if (st.limNode) { try { st.limNode.disconnect(); } catch (e) {} }
    // The capture tap hangs off exactly the same point as the broadcast bus, so
    // what is encoded is what the limiter produced — never the raw master.
    const source = st.limiterOn ? limiterNode() : st.masterGain;
    if (st.limiterOn) st.masterGain.connect(limiterNode());
    source.connect(st.masterAnalyser);
    source.connect(st.dest);                       // broadcast/record bus
    if (st.capNode) { try { source.connect(st.capNode); } catch (e) {} }
  }

  function setLimiterOn(on) {
    st.limiterOn = !!on;
    saveLimiterPrefs();
    if (st.ac) wireLimiterRouting();
    renderMixerStrips();
  }
  function setLimiterStyle(id) {
    if (!LIMITER_STYLES[id]) return;
    st.limiterStyle = id;
    saveLimiterPrefs();
    if (st.limNode) { try { st.limNode.port.postMessage(limiterOpts()); } catch (e) {} }
  }
  function setLimiterCeiling(db) {
    st.limiterCeiling = clamp(Number(db) || -1, -6, -0.1);
    saveLimiterPrefs();
    if (st.limNode) { try { st.limNode.port.postMessage(limiterOpts()); } catch (e) {} }
  }

  function hookStreamAudio(inp, stream) {
    const ac = ensureAudio();
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    inp.srcNode = ac.createMediaStreamSource(new MediaStream([track]));
    finishAudioHook(inp);
  }

  function hookElementAudio(inp, el) {
    const ac = ensureAudio();
    try { inp.srcNode = ac.createMediaElementSource(el); } catch (e) { return; }
    finishAudioHook(inp);
  }

  function finishAudioHook(inp) {
    const ac = st.ac;
    inp.gain = ac.createGain();
    inp.gain.gain.value = 0;
    inp.meter = ac.createAnalyser();
    inp.meter.fftSize = 256;
    inp.meterData = new Uint8Array(inp.meter.fftSize);
    // Every input gets an A/V sync delay line (0 by default, so nothing changes
    // until it is needed). Holding the SOUND back is how a source whose picture
    // arrives late — an NDI feed, a capture card, an encoder — is brought back
    // into lip-sync, and it costs nothing while it is set to zero.
    inp.delayNode = ac.createDelay(1.2);
    inp.delayNode.delayTime.value = 0;
    inp.srcNode.connect(inp.delayNode);
    const tap = inp.delayNode;
    tap.connect(inp.gain);
    tap.connect(inp.meter);
    inp.gain.connect(st.masterGain);
    // solo tap (headphones only — see ensureAudio)
    inp.soloGain = ac.createGain();
    inp.soloGain.gain.value = 0;
    tap.connect(inp.soloGain);
    inp.soloGain.connect(st.soloBus);
    applyInputSync(inp);
    renderMixerStrips(); // an input just became mixable — give it a strip
  }

  function rms(analyser, buf) {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / buf.length);
  }

  /** Program weight 0..1 for auto-mix: how visible is this input in the output? */
  function programWeight(inp) {
    let w = 0;
    const m = st.trans ? st.trans.m : 0;
    if (st.trans) {
      if (inp.id === st.trans.from) w = 1 - m;
      if (inp.id === st.trans.to) w = Math.max(w, m);
    } else if (inp.id === st.programId) w = 1;
    for (const o of st.ovl) if (o.id === inp.id) w = Math.max(w, o.level);
    return w;
  }

  function updateAudioGains() {
    if (!st.ac) return;
    const now = st.ac.currentTime;
    st.masterGain.gain.setTargetAtTime(
      (st.masterMuted ? 0 : st.masterVol) * (1 - st.ftbLevel), now, 0.05);
    // headphones: while anything is solo'd the normal mix is gated out and
    // only the solo bus is heard (vMix solo semantics — broadcast unaffected)
    const anySolo = st.inputs.some((i) => i.solo && i.gain);
    st.monitorGate.gain.setTargetAtTime(anySolo ? 0 : 1, now, 0.05);
    st.monitorGain.gain.setTargetAtTime(st.monitorVol, now, 0.05);
    for (const inp of st.inputs) {
      if (!inp.gain) continue;
      // Audio-only inputs (mics, music beds, audio-only NDI like "vMix Audio -
      // Master" — whether picked as Audio Only or auto-detected) play at full
      // level regardless of what's on program.
      const w = inp.type === 'audio' || inp.type === 'ndaudio' || inp._ndiAudioOnly || !st.autoMix ? 1 : programWeight(inp);
      const g = inp.audioOn ? inp.volume * w : 0;
      inp.gain.gain.setTargetAtTime(g, now, 0.06);
      if (inp.soloGain) inp.soloGain.gain.setTargetAtTime(anySolo && inp.solo ? inp.volume : 0, now, 0.05);
    }
  }

  /* ============================== A/V SYNC ================================ */
  /*
   * Sound and picture from the same source do NOT reach this app together.
   * Video goes through JPEG encoding, IPC and bitmap decoding; audio goes
   * through a jitter buffer and the sound card's own output latency. Nothing
   * lines those two paths up by itself, which is why an NDI feed could look
   * ahead of what you were hearing.
   *
   * Two mechanisms, in this order:
   *   1. AUTOMATIC (NDI): every NDI frame carries the sender's own timestamp,
   *      and video and audio from one sender share that clock. Comparing when
   *      each ARRIVED against when it was SENT gives the real difference
   *      between the two paths — no guessing. Add the audio buffer depth (the
   *      worklet reports it live) and the output latency, and we know exactly
   *      how much to hold one side back.
   *   2. MANUAL: a per-input offset in Input Settings, for everything the app
   *      cannot measure — a camera against a separate sound desk feed, an
   *      encoder with its own delay. Positive delays the sound, negative delays
   *      the picture.
   *
   * Corrections are applied with hysteresis and ramped, so a live broadcast
   * never hears the adjustment happen.
   */
  const SYNC_MAX_MS = 500;      // beyond this it is a broken source, not a sync error
  const SYNC_STEP_MS = 12;      // ignore changes smaller than this (well under perception)

  function syncOf(inp) {
    if (!inp._sync) inp._sync = { aOff: [], vOff: [], queueMs: 0, autoMs: null, audioMs: 0, videoMs: 0 };
    return inp._sync;
  }
  /** Note that a frame stamped `tsNs` (NDI 100 ns units) arrived just now. */
  function noteArrival(inp, kind, tsNs, atMs) {
    if (!tsNs) return;
    const s = syncOf(inp);
    // The epoch is arbitrary but SHARED by both streams, so it cancels out when
    // the two offsets are compared — only the difference is ever used.
    // `atMs` is when it arrived, if it arrived somewhere other than here (the
    // NDI worklet stamps its packets on the audio thread).
    const off = (atMs == null ? performance.now() : atMs) - tsNs / 10000;
    const arr = kind === 'audio' ? s.aOff : s.vOff;
    arr.push(off);
    if (arr.length > 40) arr.shift();
  }
  function median(a) {
    if (!a || a.length < 5) return null;
    const s = a.slice().sort((x, y) => x - y);
    return s[s.length >> 1];
  }
  /** Output latency of the sound card, in ms (what the operator hears after we play it). */
  function outputLatencyMs() {
    const ac = st.ac;
    if (!ac) return 0;
    const o = (ac.outputLatency || 0) + (ac.baseLatency || 0);
    return Math.min(200, o * 1000);
  }
  /** How far apart sound and picture are for this input, in ms (+ = sound is late). */
  function measuredSkewMs(inp) {
    const s = syncOf(inp);
    const a = median(s.aOff), v = median(s.vOff);
    if (a == null || v == null) return null;
    // (arrival − sent) for audio, plus everything still ahead of it, minus the
    // same for video. One compositor frame is the picture's remaining latency.
    const compositor = 1000 / Math.max(10, st.targetFps || 30);
    return (a + s.queueMs + outputLatencyMs()) - (v + compositor);
  }
  /** Recompute and apply this input's audio/video hold-backs. */
  function updateInputSync(inp) {
    const s = syncOf(inp);
    const auto = st.avAutoSync === false ? null : measuredSkewMs(inp);
    s.autoMs = auto == null ? null : Math.round(auto);
    const manual = Number(inp.syncMs) || 0;
    // auto > 0 means the sound is late, so the PICTURE must wait for it.
    const total = (auto || 0) - manual;   // + → hold video, − → hold audio
    const videoMs = clamp(Math.max(0, total), 0, SYNC_MAX_MS);
    const audioMs = clamp(Math.max(0, -total), 0, SYNC_MAX_MS);
    if (Math.abs(videoMs - s.videoMs) >= SYNC_STEP_MS || (videoMs === 0) !== (s.videoMs === 0)) s.videoMs = videoMs;
    if (Math.abs(audioMs - s.audioMs) >= SYNC_STEP_MS || (audioMs === 0) !== (s.audioMs === 0)) s.audioMs = audioMs;
    applyInputSync(inp);
  }
  /** Push the decided delays into the audio graph and the frame queue. */
  function applyInputSync(inp) {
    const s = syncOf(inp);
    if (inp.delayNode && st.ac) {
      const cur = inp.delayNode.delayTime.value;
      const want = s.audioMs / 1000;
      if (Math.abs(cur - want) > 0.004) {
        // Ramp at no more than 3% of real time so the change cannot be heard as
        // a pitch or speed jump — a live congregation must not notice it.
        const now = st.ac.currentTime;
        const ramp = Math.max(0.35, Math.abs(want - cur) / 0.03);
        try {
          inp.delayNode.delayTime.cancelScheduledValues(now);
          inp.delayNode.delayTime.setValueAtTime(cur, now);
          inp.delayNode.delayTime.linearRampToValueAtTime(want, now + ramp);
        } catch (e) { try { inp.delayNode.delayTime.value = want; } catch (e2) {} }
      }
    }
    if (s.videoMs > 0 || inp._vd) ensureVDelay(inp).ms = s.videoMs;
  }
  /** Set the manual offset (ms): + delays the sound, − delays the picture. */
  function setInputSyncMs(inp, ms) {
    inp.syncMs = clamp(Math.round(Number(ms) || 0), -SYNC_MAX_MS, SYNC_MAX_MS);
    const s = syncOf(inp);
    s.audioMs = -1; s.videoMs = -1;  // force the next update through the hysteresis
    updateInputSync(inp);
  }
  /** Plain-language line about what the automatic sync has measured, if anything. */
  function syncNoteFor(inp) {
    const s = inp._sync;
    if (!s || s.autoMs == null) {
      if (inp.type === 'ndaudio' || (inp.type === 'ndi' && inp._ndiAudioOnly)) {
        /*
         * A sound-only source cannot be measured against a picture it does not
         * have, so the offset is the operator's to set — but the number they
         * need is not a mystery, and it MOVES.
         *
         * The jitter buffer starts with a ~60 ms cushion and GROWS it by 30 ms
         * every time the sound runs dry, up to 260, giving the latency back at
         * 10 ms per clean 25 seconds. So an offset dialled in by ear at the
         * start of a service can be nearly 200 ms wrong by the middle of it,
         * with nothing on screen to say the ground had moved. Printing the
         * live figure is what turns "set it by ear again" into one number to
         * copy.
         */
        const held = Math.round((s && s.queueMs ? s.queueMs : 0) + outputLatencyMs());
        return 'This NDI source carries sound only, so there is no picture of its own to measure against. ' +
          `Right now its sound is being held <b>${held} ms</b> (a ${Math.round((s && s.targetMs) || 0)} ms cushion plus the sound card). ` +
          `If it runs BEHIND your camera, set that camera's offset to about <b>−${held} ms</b>. ` +
          'This figure grows when the network makes the sound run dry, so check it again if lip-sync drifts during a service.';
      }
      if (inp.type === 'ndi') return 'Measuring this NDI source automatically…';
      return 'This kind of input cannot be measured automatically, so set it by ear — the setting is saved with your preset.';
    }
    const auto = Math.round(s.autoMs);
    const held = s.videoMs > 1 ? `holding the picture back ${Math.round(s.videoMs)} ms`
      : (s.audioMs > 1 ? `holding the sound back ${Math.round(s.audioMs)} ms` : 'nothing to correct');
    return `Measured automatically: the sound of this NDI source lands ${auto} ms ${auto < 0 ? 'ahead of' : 'behind'} its picture — ${held}.`;
  }
  function syncTick() {
    for (const inp of st.inputs) {
      if (!inp._sync && !inp.syncMs) continue;
      updateInputSync(inp);
    }
  }

  /* ---- video hold-back: a small queue of finished frames, played out late ---- */
  function ensureVDelay(inp) {
    if (!inp._vd) {
      const cv = document.createElement('canvas');
      cv.width = 2; cv.height = 2;
      inp._vd = { canvas: cv, ctx: cv.getContext('2d'), q: [], ms: 0, lastSample: 0, busy: false };
    }
    return inp._vd;
  }
  function videoDelayMs(inp) { return (inp._vd && inp._vd.ms) || 0; }
  /**
   * Hand a finished frame to the queue (the caller must NOT close the bitmap).
   * `at` is when the picture was TAKEN, not when its decode finished — the
   * decode is asynchronous, and timing the frame from its completion silently
   * adds that decode time on top of the hold-back the operator asked for.
   */
  function pushDelayedFrame(inp, bmp, at) {
    const vd = ensureVDelay(inp);
    vd.q.push({ bmp, at: at || performance.now() });
    const cutoff = performance.now() - (vd.ms + 500);
    while (vd.q.length > 2 && vd.q[0].at < cutoff) { try { vd.q.shift().bmp.close(); } catch (e) {} }
    while (vd.q.length > 120) { try { vd.q.shift().bmp.close(); } catch (e) {} }
  }
  /** Inputs with no frame callback (a camera's <video>, a file, an image) are
   *  sampled here at the production rate — only while a delay is actually set. */
  function sampleForDelay(inp, now) {
    const vd = inp._vd;
    if (vd.busy) return;
    const iv = 1000 / Math.max(10, st.targetFps || 30);
    // 0.75×, not the full interval: draws never land on exact interval
    // boundaries, so demanding a whole one to have elapsed skips every other
    // frame and quietly halves the sampling rate (which shows up as extra,
    // unasked-for delay). The same trap the compositor's own accumulator avoids.
    if (now - vd.lastSample < iv * 0.75) return;
    const el = inp.el; if (!el) return;
    const [w, h] = srcDims(inp); if (!w || !h) return;
    vd.lastSample = now;
    vd.busy = true;
    const at = performance.now();
    createImageBitmap(el).then((bmp) => { vd.busy = false; pushDelayedFrame(inp, bmp, at); })
      .catch(() => { vd.busy = false; });
  }
  /** Called once per drawn frame: advance every delayed input to the frame that
   *  is now due. */
  function stepVideoDelays(now) {
    for (const inp of st.inputs) {
      const vd = inp._vd;
      if (!vd || !vd.ms) continue;
      if (inp.type !== 'ndi') sampleForDelay(inp, now);   // NDI pushes its own frames
      const cutoff = now - vd.ms;
      // The frame CLOSEST to the moment we want to show, not merely the newest
      // one old enough. Frames only exist on the sampling grid, so "newest that
      // is old enough" is always late by up to a whole frame interval — biasing
      // every hold-back longer than asked. Nearest centres that error on zero.
      let pick = -1, best = Infinity;
      for (let i = 0; i < vd.q.length; i++) {
        const d = Math.abs(vd.q[i].at - cutoff);
        if (d < best) { best = d; pick = i; }
      }
      if (pick < 0) continue;
      const f = vd.q[pick];
      try {
        if (vd.canvas.width !== f.bmp.width || vd.canvas.height !== f.bmp.height) { vd.canvas.width = f.bmp.width; vd.canvas.height = f.bmp.height; }
        vd.ctx.drawImage(f.bmp, 0, 0);
        vd.shownAt = f.at;
        vd.shownAgeMs = now - f.at;   // the hold-back actually applied to this frame
      } catch (e) { /* a closed bitmap mid-teardown */ }
      for (let i = 0; i < pick; i++) { try { vd.q[i].bmp.close(); } catch (e) {} }
      vd.q.splice(0, pick);
    }
  }
  /** What the compositor should actually draw for this input. */
  function drawSourceOf(inp) {
    const vd = inp._vd;
    return (vd && vd.ms > 0 && vd.canvas.width > 2) ? vd.canvas : inp.el;
  }

  /* ============================== SWITCHING =============================== */

  function setPreview(id) {
    const inp = inputById(id);
    if (!inp || !hasVisual(inp)) return;
    st.previewId = id;
    renderInputs();
  }

  function cut() {
    if (st.previewId == null || st.previewId === st.programId) return;
    const old = st.programId;
    st.programId = st.previewId;
    st.previewId = old;
    st.trans = null;
    renderInputs();
  }

  function startTransition(fx, dur) {
    if (st.trans && !st.trans.manual) return;
    if (st.previewId == null || st.previewId === st.programId) return;
    if (fx === 'Cut' || !dur) return cut();
    // if the T-bar is mid-way, the auto transition continues from there
    const m0 = st.trans && st.trans.manual ? st.trans.m : 0;
    st.trans = { from: st.programId, to: st.previewId, fx: fx || 'Fade', dur: dur || 500, t0: performance.now() - m0 * (dur || 500), m: m0, manual: false };
  }

  function completeTransition() {
    if (!st.trans) return;
    const t = st.trans;
    st.programId = t.to;
    st.previewId = t.from;
    st.trans = null;
    st.tbarPos = 0;
    positionTbar();
    renderInputs();
  }

  function setTbar(pos) {
    pos = clamp(pos, 0, 1);
    st.tbarPos = pos;
    if (st.previewId == null || st.previewId === st.programId) { positionTbar(); return; }
    if (pos >= 0.985) {
      if (st.trans && st.trans.manual) { st.trans.m = 1; completeTransition(); }
      else { cut(); st.tbarPos = 0; positionTbar(); }
      return;
    }
    if (pos <= 0.005) { st.trans = null; positionTbar(); return; }
    if (!st.trans || !st.trans.manual) {
      st.trans = { from: st.programId, to: st.previewId, fx: st.slots[0].fx, dur: 0, t0: 0, m: pos, manual: true };
    }
    st.trans.m = pos;
    positionTbar();
  }

  function positionTbar() {
    const h = refs.vmxTbar.clientHeight - refs.vmxTbarHandle.offsetHeight;
    refs.vmxTbarHandle.style.bottom = Math.round(st.tbarPos * Math.max(0, h)) + 'px';
  }

  function quickPlay(id) {
    const inp = inputById(id == null ? st.previewId : id);
    if (!inp || !hasVisual(inp)) return;
    if (inp.el && inp.el.tagName === 'VIDEO' && !inp.stream) {
      try { inp.el.currentTime = 0; } catch (e) {}
      inp.el.play().catch(() => {});
      inp.paused = false;
    }
    if (inp.id !== st.programId) {
      st.previewId = inp.id;
      startTransition('Fade', 500);
    }
    renderInputs();
  }

  function toggleFTB() {
    st.ftbOn = !st.ftbOn;
    refs.vmxFTB.classList.toggle('on', st.ftbOn);
  }

  function toggleOverlay(ch, id) {
    const o = st.ovl[ch];
    if (!o) return;
    if (o.id === id) { o.last = o.id; o.id = null; }
    else { o.id = id; o.last = id; }
    renderInputs();
  }

  /* ============================== RENDERING ============================== */

  /*
   * The switcher only ever needs to redraw as fast as it is captured. The
   * program canvas is sampled by captureStream at the production frame rate, so
   * running the compositor at the display's 60Hz did exactly double the work
   * for frames nobody ever saw — and on a machine that couldn't keep up, that
   * overspend is what starved the loop and made the picture stutter.
   *
   * The monitors and meters are operator aids, not broadcast output, so they get
   * their own slower budgets. Everything below is deliberately expressed as a
   * minimum interval rather than "every Nth frame" so it holds up whatever rate
   * the display or the production runs at.
   */
  const THUMB_INTERVAL_MS = 1000 / 12;  // input-bar thumbnails
  const METER_INTERVAL_MS = 1000 / 20;  // audio meters (master + mixer strips)
  const GAIN_INTERVAL_MS = 1000 / 20;   // auto-mix gain updates

  /**
   * True when there is at least one live NDI input and NONE of them is holding a
   * frame the compositor has not drawn yet — i.e. drawing right now could only
   * repeat the picture already on screen. Used to phase-align the draw loop.
   */
  /**
   * The inputs whose picture THIS draw is going to use.
   *
   * Aligning to every live source on the desk is the wrong target once there
   * is more than one: two cameras free-run against each other, so at any
   * moment one of them almost always has a new frame, the loop concludes there
   * is nothing to wait for, and the source the congregation is actually
   * watching goes on beating. What has to be lined up is what is on air.
   */
  function onAirSources() {
    const out = [];
    const add = (id, depth) => {
      const i = id == null ? null : inputById(id);
      if (!i || i._closed || out.includes(i)) return;
      // A virtual set has no picture of its own — it keys a camera into a
      // scene, so the clock that matters is that camera's. The depth guard is
      // for a set pointed at another set, which the UI allows.
      if (i._vset && i._vset.sourceId != null && (depth || 0) < 3) { add(i._vset.sourceId, (depth || 0) + 1); return; }
      out.push(i);
    };
    if (st.trans) { add(st.trans.from); add(st.trans.to); } else add(st.programId);
    for (const o of st.ovl) if (o.level > 0) add(o.id != null ? o.id : o.last);
    return out;
  }

  /**
   * Should this draw yield one display refresh so the frame that is nearly
   * here lands first?
   *
   * Yes only when every source on air is one that arrives on a clock of its
   * own AND none of them has anything new — in which case this draw could only
   * repeat a picture already on screen, and the refresh is better spent
   * waiting. If any of them has a fresh frame, draw it now.
   *
   * This used to ask about NDI inputs alone (`_ndiPending`), which is why a
   * camera — the most common source in the building — never got the benefit.
   */
  function awaitingFrame() {
    let clocked = 0;
    for (const inp of onAirSources()) {
      if (inp._ndiSurface && inp._ndiGotVideo) {
        if (inp._ndiPending) return false;
        clocked++;
      } else if (!st._noVfAlign && videoIsClocked(inp)) {
        if (inp._vfFresh) return false;
        clocked++;
      }
      // Anything else — a still, a colour, a caption canvas — holds whatever was
      // last drawn on it and can be read at any moment, so it neither waits nor
      // stops the sources that do. It is simply not counted. (Bailing out here
      // instead would mean a still slide behind a live camera overlay switched
      // the alignment off for the camera.)
    }
    return clocked > 0;
  }

  function ensureLoop() {
    if (st.loopOn) return;
    st.loopOn = true;
    st.lastFpsAt = performance.now();
    refreshTargetFps();
    const tick = (ts) => {
      st.raf = requestAnimationFrame(tick);
      const now = ts || performance.now();
      // Nobody is looking and nothing is being encoded: a camera left loaded in
      // Go Live shouldn't composite 1280x720 frames while the user is off in the
      // Video studio. A slow tick keeps late-loading sources warm.
      const interval = liveVisible() ? 1000 / Math.max(1, st.targetFps || 30) : 500;
      // Budget the elapsed time rather than testing "has a whole interval passed
      // since the last draw". Two things go wrong with the simpler test: it must
      // compare rAF timestamps with rAF timestamps (`performance.now()` inside
      // the callback is already a few ms later, which biases every comparison
      // late and quietly drops a 60Hz display to 20fps), and when the display's
      // rate isn't a clean multiple of the target it rounds down to half. Carrying
      // the remainder forward averages out to the target rate on any display.
      if (!st.lastTickAt) st.lastTickAt = now - interval;
      const dt = now - st.lastTickAt;
      st.frameAcc += dt;
      st.lastTickAt = now;
      if (dt > 0 && dt < 100) {
        st.rafDt = st.rafDt ? st.rafDt * 0.9 + dt * 0.1 : dt;
        /*
         * THE DISPLAY'S REFRESH PERIOD IS THE FLOOR, NOT THE AVERAGE.
         *
         * `slack` below asks whether there is a spare refresh to yield, which
         * is a question about the PANEL: 30fps on a 60Hz screen has one to
         * spare, 60fps on the same screen has none. The average interval does
         * not answer it, because our own slowness only ever pushes intervals
         * UP — so on a machine that is struggling the average climbs, `slack`
         * goes false, and the alignment switches itself off at exactly the
         * moment the judder it exists to remove is worst. A minimum cannot be
         * inflated that way: nothing makes rAF arrive FASTER than vsync.
         *
         * It is allowed to creep upward very slowly so that a genuine change —
         * the window dragged onto a 60Hz panel from a 144Hz one — is followed
         * within a second or two, while a busy minute is ignored.
         */
        st.rafMin = st.rafMin ? Math.min(st.rafMin * 1.0005, dt) : dt;
      }
      if (st.frameAcc < interval) { st.phaseDeferred = false; return; }
      // PHASE-ALIGN THE DRAW TO NDI ARRIVALS.
      //
      // When the source and the production run at the SAME rate, this budget and
      // the sender's clock free-run against one another. Where they nearly
      // coincide, a frame that lands just after a draw is replaced by its
      // successor before it is ever drawn, and the compositor shows the previous
      // picture twice. Nothing is dropping anywhere — arrivals stay at the full
      // rate — but measured at 1080p30 it still cost up to 17% of frames (24.9
      // drawn of 29.9 arrived), and it comes and goes as the clocks drift, which
      // is exactly the intermittent judder being reported.
      //
      // If no live NDI input has a new frame, this draw can only repeat what is
      // already on screen. Yielding ONE display refresh lets the frame that is
      // nearly here land first, after which the draw phase settles just behind
      // the arrivals and stays there. At most one refresh is ever given up
      // (phaseDeferred), and the surrendered time stays in the budget, so the
      // long-run rate is still exactly the target.
      // Only where there is slack to give: if the production rate IS the
      // display's rate, every refresh has to draw and yielding one costs a frame
      // outright (it took the 1080p60 compositor down to 53fps). A 30fps
      // production on a 60Hz panel, or 60fps on a 120Hz one, has a spare refresh
      // to spend.
      /*
       * HOW LONG THIS IS ALLOWED TO WAIT.
       *
       * Yielding exactly one refresh was enough to line up against a sender
       * whose frames come at a steady rate, but a camera's do not: the element
       * presents on vsync, so an arrival that slips lands a WHOLE refresh late
       * and one yield cannot always reach it. Waiting is therefore bounded by
       * the BUDGET rather than by a count — up to half a frame past due, after
       * which the picture goes out whatever has or has not arrived.
       *
       * Nothing is lost by waiting. The surrendered time stays in frameAcc, so
       * the draw that follows comes correspondingly sooner and the long-run
       * rate is still exactly the target — which is why the fps readout does
       * not move while the judder disappears.
       */
      /*
       * THE DISPLAY'S REFRESH PERIOD IS THE FLOOR, NOT THE AVERAGE.
       *
       * This asks whether there is a spare refresh to yield, which is a
       * question about the PANEL: 30fps on a 60Hz screen has one to spare,
       * 60fps on the same screen has none. A MEAN interval does not answer it,
       * because our own slowness only ever pushes intervals UP — so on a
       * machine that is struggling the mean climbs past the threshold, `slack`
       * goes false, and the alignment switches itself off at exactly the
       * moment the judder it exists to remove is worst. That matters for the
       * case this is for: a PC compositing a camera while pushing two 1080p
       * streams is a loaded PC. A minimum cannot be inflated that way —
       * nothing makes rAF arrive FASTER than vsync.
       *
       * HONESTLY: the benefit is reasoned and only weakly measured (this
       * laptop could not hold a scored run while it was busy enough to show
       * it). It was briefly reverted on the strength of ONE baseline run of
       * test:avsync that passed 27/27 while the changed code failed — and that
       * was a wrong read: re-run minutes later, the SHIPPED 2.73.0 asar failed
       * the same suite too, with a different check each time. The suite is
       * load-flaky on this machine; a single baseline run settles nothing.
       */
      const slack = interval >= (st.rafMin || st.rafDt || 16.7) * 1.5;
      st._slack = slack;
      if (slack && awaitingFrame()) {
        if (st.frameAcc < interval * 1.5) {
          st.phaseDeferred = true; st._deferN = (st._deferN || 0) + 1; return;
        }
        // Out of budget: the picture goes out repeating the last frame. Counted,
        // because whether this or the arrival jitter is what limits the
        // alignment decides whether widening the wait would buy anything.
        st._deferBlocked = (st._deferBlocked || 0) + 1;
      }
      st.phaseDeferred = false;
      st.frameAcc = Math.min(st.frameAcc - interval, interval); // never bank a backlog
      drawFrame(now);
    };
    st.raf = requestAnimationFrame(tick);
    // watchdog: rAF throttles when the window is hidden — keep frames flowing
    // for the encoder while recording/streaming.
    st.watchdog = setInterval(() => {
      if (broadcasting() && performance.now() - st.lastDraw > 120) drawFrame(performance.now());
    }, 66);
    // productionFps() walks every input's track settings, so it is sampled on a
    // timer rather than on every frame.
    st.fpsTimer = setInterval(refreshTargetFps, 2000);
    // A/V sync is re-measured a couple of times a second: often enough to settle
    // within a second of an input appearing, slow enough to be free.
    st.syncTimer = setInterval(syncTick, 500);
  }

  function broadcasting() { return st.recording || st.replayArmed || st.streams.some((s) => s.streaming); }

  /** Is the compositor's output actually being watched or encoded right now? */
  function liveVisible() {
    if (broadcasting() || st.multicorders.length) return true;
    if (st.extWin && !st.extWin.closed) return true; // projector / second screen
    const view = document.getElementById('view-live');
    return !!(view && view.classList.contains('active'));
  }

  function refreshTargetFps() {
    // While broadcasting, the capture rate is fixed for the session — follow it
    // exactly so the compositor and the encoder stay in step.
    st.targetFps = (st.pgmRec && st.outStreamFps) ? st.outStreamFps : productionFps();
    pushNdiFpsCap();
  }

  /** Tell every NDI receiver the rate we actually draw at (only when it moves). */
  function pushNdiFpsCap() {
    const cap = ndiFpsCap();
    if (cap === st._ndiFpsCapSent) return;
    st._ndiFpsCapSent = cap;
    for (const inp of st.inputs) {
      if (!inp._ndiId || inp._closed) continue;
      try { window.api.live.ndiFps(inp._ndiId, cap); } catch (e) {}
    }
  }

  function stepAnimations(now) {
    if (st.trans && !st.trans.manual) {
      st.trans.m = clamp((now - st.trans.t0) / st.trans.dur, 0, 1);
      if (st.trans.m >= 1) completeTransition();
    }
    // Real elapsed time, not an assumed 60fps — under CPU load or a throttled
    // window, fixed per-frame steps would make FTB/overlay fades take far
    // longer (or shorter) than their intended duration. Cap the delta so a
    // long stall (e.g. window was hidden) doesn't snap the fade instantly.
    const dtf = st.lastAnimAt ? clamp(now - st.lastAnimAt, 0, 100) : 16.7;
    st.lastAnimAt = now;
    st.ftbLevel = clamp(st.ftbLevel + (st.ftbOn ? 1 : -1) * (dtf / 400), 0, 1);
    for (const o of st.ovl) o.level = clamp(o.level + (o.id != null ? 1 : -1) * (dtf / 300), 0, 1);
  }

  function drawTransition(ctx, W, H, from, to, fx, m) {
    const A = inputById(from), B = inputById(to);
    switch (fx) {
      case 'Zoom': {
        drawInputTo(ctx, B, 0, 0, W, H);
        if (A && m < 1) {
          ctx.save();
          ctx.globalAlpha = 1 - m;
          const s = 1 + m * 1.6;
          ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
          drawInputTo(ctx, A, 0, 0, W, H);
          ctx.restore();
        }
        break;
      }
      case 'Wipe': {
        drawInputTo(ctx, A, 0, 0, W, H);
        ctx.save();
        ctx.beginPath(); ctx.rect(0, 0, W * m, H); ctx.clip();
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W * m, H);
        drawInputTo(ctx, B, 0, 0, W, H);
        ctx.restore();
        break;
      }
      case 'Slide': {
        drawInputTo(ctx, A, 0, 0, W, H);
        ctx.save();
        ctx.translate(W * (1 - m), 0);
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        drawInputTo(ctx, B, 0, 0, W, H);
        ctx.restore();
        break;
      }
      case 'Fly': {
        drawInputTo(ctx, A, 0, 0, W, H);
        ctx.save();
        ctx.globalAlpha = m;
        const s = 0.25 + 0.75 * m;
        ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
        if (m > 0.02) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
        drawInputTo(ctx, B, 0, 0, W, H);
        ctx.restore();
        break;
      }
      case 'Merge': {
        ctx.save();
        ctx.globalAlpha = 1;
        const sA = 1 + 0.12 * m;
        ctx.translate(W / 2, H / 2); ctx.scale(sA, sA); ctx.translate(-W / 2, -H / 2);
        drawInputTo(ctx, A, 0, 0, W, H);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha = m;
        const sB = 1.12 - 0.12 * m;
        ctx.translate(W / 2, H / 2); ctx.scale(sB, sB); ctx.translate(-W / 2, -H / 2);
        drawInputTo(ctx, B, 0, 0, W, H);
        ctx.restore();
        break;
      }
      default: { // Fade
        drawInputTo(ctx, A, 0, 0, W, H);
        ctx.save();
        ctx.globalAlpha = m;
        if (m > 0.02) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
        drawInputTo(ctx, B, 0, 0, W, H);
        ctx.restore();
      }
    }
  }

  function drawOverlayChannel(ctx, W, H, o) {
    if (o.level <= 0) return;
    // while fading out (id already cleared) keep drawing the remembered input
    const src = inputById(o.id != null ? o.id : (o.last != null ? o.last : -1));
    if (!src) return;
    ctx.save();
    ctx.globalAlpha = o.level;
    switch (o.mode) {
      case 'lower': {
        const h = H * 0.34;
        drawInputTo(ctx, src, 0, H - h, W, h);
        break;
      }
      case 'pip-br': case 'pip-bl': case 'pip-tr': case 'pip-tl': {
        const w = W * 0.3, h = H * 0.3, pad = W * 0.02;
        const x = o.mode.endsWith('l') ? pad : W - w - pad;
        const y = o.mode.includes('t') ? pad : H - h - pad;
        ctx.fillStyle = '#000'; ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
        drawInputTo(ctx, src, x, y, w, h);
        break;
      }
      default:
        drawInputTo(ctx, src, 0, 0, W, H);
    }
    ctx.restore();
  }

  function drawProgram() {
    const ctx = refs.pgmCtx, W = refs.vmxPgmCanvas.width, H = refs.vmxPgmCanvas.height;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (st.trans) drawTransition(ctx, W, H, st.trans.from, st.trans.to, st.trans.fx, st.trans.m);
    else drawInputTo(ctx, inputById(st.programId), 0, 0, W, H);
    for (const o of st.ovl) drawOverlayChannel(ctx, W, H, o);
    if (st.ftbLevel > 0) {
      ctx.globalAlpha = st.ftbLevel;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  function drawPreviewMon() {
    const ctx = refs.prvCtx, W = refs.vmxPrvCanvas.width, H = refs.vmxPrvCanvas.height;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    drawInputTo(ctx, inputById(st.previewId), 0, 0, W, H);
  }

  function drawThumbs() {
    /*
     * The card size is measured on a slow clock, not every pass.
     *
     * clientWidth is a LAYOUT read, and there is one per input per thumbnail
     * frame — sixteen reads interleaved with sixteen canvas writes, several
     * times a second, for a number that only changes when the window is
     * resized. The 2D context is kept too: asking an element for its context
     * repeatedly is cheap but not free, and this loop is the hottest one on
     * the desk.
     */
    /*
     * Why the bitmap is sized from the card at all: painting at a fixed size
     * the browser then rescales makes a soft thumbnail, and — because the box
     * and the bitmap rarely share an aspect ratio — the browser's letterboxing
     * lands ON TOP of drawInputTo's, so the shot ends up a different shape than
     * it really is. The shape of the shot is the whole point of the thumbnail.
     * Safe against a canvas→layout→canvas loop: the canvas's CSS size is 100%
     * of a shell inside the deck's FIXED height, so writing the bitmap cannot
     * move the box that measured it.
     */
    const now = performance.now();
    const remeasure = !st._thumbSizeAt || now - st._thumbSizeAt > 500;
    if (remeasure) st._thumbSizeAt = now;
    for (const inp of st.inputs) {
      if (!inp.thumbCanvas || !hasVisual(inp)) continue;
      const cv = inp.thumbCanvas;
      if (remeasure) {
        const w = Math.round(cv.clientWidth), h = Math.round(cv.clientHeight);
        if (w > 1 && h > 1 && (cv.width !== w || cv.height !== h)) {
          cv.width = w; cv.height = h;
          inp._thumbCtx = null;                  // resizing a canvas resets it
        }
      }
      const c = inp._thumbCtx || (inp._thumbCtx = cv.getContext('2d'));
      c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
      drawInputTo(c, inp, 0, 0, cv.width, cv.height);
    }
  }

  /** Per-input audio levels + the little level bar on each input tile. */
  function sampleInputLevels() {
    for (const inp of st.inputs) {
      if (!inp.meter) continue;
      inp.level = rms(inp.meter, inp.meterData);
      if (!inp.meterCanvas) continue;
      const c = inp.meterCanvas.getContext('2d');
      const h = inp.meterCanvas.height, lvl = clamp(inp.level * 3, 0, 1);
      c.fillStyle = '#0a0a0a'; c.fillRect(0, 0, 5, h);
      c.fillStyle = lvl > 0.85 ? '#e53935' : lvl > 0.6 ? '#fbc02d' : '#43a047';
      c.fillRect(0, h - h * lvl, 5, h * lvl);
    }
  }

  function drawMasterMeter() {
    const ctx = refs.meterCtx, cv = refs.vmxMasterMeter;
    const level = st.ac && st.masterAnalyser ? clamp(rms(st.masterAnalyser, st.meterBuf) * 3, 0, 1) : 0;
    st.masterLevel = level;
    const SEG = 26, gap = 2;
    const segH = (cv.height - 8) / SEG;
    ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, cv.width, cv.height);
    const lit = Math.round(level * SEG);
    for (let col = 0; col < 2; col++) {
      const x = col === 0 ? 3 : 15;
      for (let i = 0; i < SEG; i++) {
        const y = cv.height - 4 - (i + 1) * segH;
        const frac = i / SEG;
        ctx.fillStyle = i < lit
          ? (frac > 0.86 ? '#e53935' : frac > 0.66 ? '#fbc02d' : '#2fbf2f')
          : '#1e2a1e';
        ctx.fillRect(x, y + gap / 2, 8, Math.max(1, segH - gap));
      }
    }
  }

  function drawFrame(now) {
    const t0 = performance.now();
    st.lastDraw = t0;
    stepAnimations(now);
    /*
     * DID THE PICTURE ACTUALLY MOVE ON THIS TIME?
     *
     * Asked BEFORE the two flushes below, because both of them spend the
     * "something new arrived" flags this reads.
     *
     * The fps readout beside this counts DRAWS, and a draw that redraws the
     * picture it drew last time counts just the same. That is not a quibble: a
     * camera beating against the draw budget produced a confident, motionless
     * 30.0 on the desk while a fifth of what went out was the same frame twice
     * — and because the number looked right, five rounds of work went past it.
     * So the honest figure is counted too, and shown when the two disagree.
     */
    let movedOn = null;                       // null: nothing clocked is on air
    for (const inp of onAirSources()) {
      if (inp._ndiSurface && inp._ndiGotVideo) movedOn = movedOn || !!inp._ndiPending;
      else if (videoIsClocked(inp)) movedOn = movedOn || !!inp._vfFresh;
    }
    if (movedOn === false) st.staleDraws = (st.staleDraws || 0) + 1;
    // Newest NDI frame onto its surface FIRST, so everything below — program,
    // preview, thumbnails, the delay queue — reads one consistent picture.
    flushNdiFrames();
    // A <video> source has nothing to flush — the element holds the picture —
    // but the "something new has arrived" flag is spent here, for the same
    // reason and at the same moment as `_ndiPending` above.
    for (const inp of st.inputs) if (inp._vfFresh) inp._vfFresh = false;
    stepVirtualSets();    // key each virtual set's camera into its scene
    stepVideoDelays(now); // A/V sync: release each held-back picture when it is due
    drawProgram();
    drawPreviewMon();
    // Thumbnails, meters and the auto-mix gain ramp are operator aids — they run
    // on their own slower budgets so they never compete with the program frame.
    if (now - st.lastThumbAt >= THUMB_INTERVAL_MS) { st.lastThumbAt = now; drawThumbs(); }
    if (now - st.lastMeterAt >= METER_INTERVAL_MS) {
      st.lastMeterAt = now;
      sampleInputLevels();
      drawMasterMeter();
      drawMixerMeters();
    }
    for (const mc of st.multicorders) {
      const inp = inputById(mc.inputId);
      if (!inp) continue;
      const c = mc.canvas.getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, mc.canvas.width, mc.canvas.height);
      drawInputTo(c, inp, 0, 0, mc.canvas.width, mc.canvas.height);
    }
    if (now - st.lastGainAt >= GAIN_INTERVAL_MS) { st.lastGainAt = now; updateAudioGains(); }
    const dt = performance.now() - t0;
    st.renderMs = st.renderMs * 0.9 + dt * 0.1;
    st.frames++;
    // Measurement hook (test/camera-smooth.test.js). Null in every real run.
    if (st._drawProbe) st._drawProbe(now);
    if (now - st.lastFpsAt >= 1000) {
      st.fps = Math.round(st.frames * 1000 / (now - st.lastFpsAt));
      st.frames0 = st.frames; st.lastFpsAt0 = st.lastFpsAt;   // kept for the line below
      st.frames = 0; st.lastFpsAt = now;
      // How many of those draws showed a picture that had actually changed.
      const moving = Math.max(0, st.frames0 - (st.staleDraws || 0));
      st.movingFps = st.frames0 ? Math.round((moving * 1000) / (now - st.lastFpsAt0)) : st.fps;
      st.staleDraws = 0;
      // Only shown when it differs enough to mean something — an operator does
      // not need two numbers on a good day, and does need them on a bad one.
      refs.vmxStFps.textContent = (st.movingFps < st.fps * 0.9)
        ? `${st.fps} (${st.movingFps} new)` : String(st.fps);
      refs.vmxStRender.textContent = st.renderMs.toFixed(st.renderMs < 10 ? 1 : 0);
      checkComposureWhileLive();
    }
  }

  /**
   * Say so when this computer cannot actually sustain what it has been asked to
   * broadcast.
   *
   * A machine that falls short here is not a machine that shows a slightly lower
   * number in the corner: the picture judders in the room, the platforms receive
   * fewer frames than they were promised, and they report a bad connection for
   * it. That is invisible unless somebody is watching the fps readout, so it gets
   * said out loud — once, with the fix, rather than every second.
   */
  function checkComposureWhileLive() {
    const live = st.streams.some((s) => s.streaming) || st.recording;
    const target = st.targetFps || 30;
    // Off air: forget it, so the next broadcast is judged on its own merits.
    if (!live || !target) { st._slowFrames = 0; st._slowWarned = false; return; }
    if (st.fps < target * 0.8) st._slowFrames = (st._slowFrames || 0) + 1;
    else if (st.fps >= target * 0.95) st._slowFrames = 0;
    if ((st._slowFrames || 0) >= 5 && !st._slowWarned) {
      st._slowWarned = true;
      const q = resolveQ(quality()) || {};
      const at = q.height ? `${q.height}p` : 'this quality';
      const n = st.streams.filter((s) => s.streaming).length;
      statusMsg(`🖥️ This computer is not keeping up at ${at} — ${st.fps} of ${target} fps.`);
      toast(`🖥️ Your computer is struggling at ${at}: the switcher is drawing ${st.fps} of ${target} fps, `
        + `so the platforms are getting fewer frames than promised and may report a poor connection. `
        + (n > 1 ? `Try a lower streaming quality, or stream to fewer platforms at once.` : `Try a lower streaming quality (720p).`),
        'error', 14000);
    }
    checkPacingWhileLive();
  }

  /*
   * IS THE STREAM ACTUALLY GOING OUT AT THE RATE IT CLAIMS?
   *
   * The capture engine paces every frame onto an exact grid, and when it cannot
   * — no new picture has arrived AND the encoder has no headroom — it leaves
   * the slot empty and counts it. That count is the single most important
   * number about what a platform receives, and until now NOTHING read it.
   *
   * It is not the same thing as the fps readout beside it. That one counts what
   * the COMPOSITOR drew; this counts what reached the ENCODER's grid, and a
   * machine can hold a confident 30 on the first while dropping a third of the
   * second. So a broadcast can look perfect on the desk and still leave as a
   * stream that claims 30fps and delivers something else.
   *
   * Why it is worth saying out loud, in these words: a platform handed a
   * variable stream re-times it onto its own clock and STRETCHES THE SOUND to
   * match. Facebook tolerates it. YouTube does not — which is exactly the
   * shape of "the audio sounds weird on YouTube but Facebook is fine", a
   * complaint nobody could connect to the picture because nothing on screen
   * said the picture was the problem.
   */
  function checkPacingWhileLive() {
    const streaming = st.streams.some((s) => s.streaming);
    if (!streaming || !st.pgmRec || typeof st.pgmRec.clockDiag !== 'function') {
      st._paceLast = null; st._paceBad = 0; st._paceWarned = false; return;
    }
    let d = null;
    try { d = st.pgmRec.clockDiag(); } catch (e) { return; }
    if (!d || typeof d.missedSlots !== 'number') return;
    const prev = st._paceLast;
    st._paceLast = { paced: d.paced || 0, missed: d.missedSlots || 0 };
    if (!prev) return;
    // Measured over the LAST SECOND, not since the broadcast began: a rough
    // patch at the start must not keep the warning up for the rest of a
    // service, and a service going wrong now must not be averaged away by an
    // hour of it having been fine.
    const slots = (st._paceLast.paced - prev.paced) + (st._paceLast.missed - prev.missed);
    if (slots < 5) return;
    const missedPct = ((st._paceLast.missed - prev.missed) * 100) / slots;
    if (missedPct > 8) st._paceBad = (st._paceBad || 0) + 1;
    else if (missedPct < 3) st._paceBad = 0;
    if ((st._paceBad || 0) >= 5 && !st._paceWarned) {
      st._paceWarned = true;
      const q = resolveQ(quality()) || {};
      const at = q.height ? `${q.height}p` : 'this quality';
      const n = st.streams.filter((s) => s.streaming).length;
      statusMsg(`📉 The broadcast is leaving at an uneven frame rate — ${Math.round(missedPct)}% of frames are missing.`);
      toast(`📉 About ${Math.round(missedPct)} frames in every 100 are not reaching the stream, so it is going out at `
        + `an uneven rate even though the desk still reads ${st.fps} fps. YouTube re-times a stream like this and `
        + `stretches the sound to fit, which is what makes the audio sound wrong there while Facebook sounds fine. `
        + (n > 1 ? `Try ${at === '1080p' ? '720p' : 'a lower quality'}, or stream to fewer platforms at once.`
                 : `Try a lower streaming quality (720p).`),
        'error', 16000);
    }
  }

  /* ============================= INPUT BAR UI ============================= */

  /**
   * The sources rail.
   *
   * A source card is mostly PICTURE: on a live board the operator recognises a
   * camera by what it is looking at, never by reading a label, so the thumbnail
   * fills the card and the name rides on top of it. The controls underneath are
   * a fixed two rows — take/transport first, overlays and audio second — so the
   * button a hand is reaching for is in the same place on every card, whatever
   * kind of source it is.
   */
  /* ==================== rebuilding the rail, and not ====================
   *
   * Everything on this desk ends in renderInputs(), and renderInputs() used to
   * throw the whole input rail away and build it again — every cell, and with
   * it TWO <canvas> elements per input, plus a full rebuild of the mixer at the
   * bottom. A cut did it. So did the end of every transition, every audio
   * toggle, every overlay assignment.
   *
   * A cut changes which cell is outlined. Doing that by destroying sixteen
   * canvases — while the compositor is drawing thirty frames a second into
   * them and re-acquiring each context afterwards — is what made the desk
   * stutter through a cut and lock for over a second through a fade. On air.
   *
   * So the rail is rebuilt only when its STRUCTURE changes: an input added,
   * removed, renamed, renumbered, or changed type. Everything else — which
   * cell is on air, which is in preview, the audio/loop/pause/overlay buttons
   * — is written onto the cells that are already standing.
   */
  function railSig() {
    return JSON.stringify(st.inputs.map((i) => [
      i.id, i.num, i.name, i.type, hasVisual(i), !!i.path,
      i._vset ? i._vset.presets.map((p) => p.name).join('|') : '',
    ]));
  }

  /** Write the current state onto the cells that already exist. */
  function refreshInputCells() {
    const bar = refs.vmxInputs;
    for (const inp of st.inputs) {
      const cell = bar.querySelector(`.vmx-input[data-id="${inp.id}"]`);
      if (!cell) return false;                       // structure moved under us
      const isPgm = inp.id === st.programId || (st.trans && st.trans.to === inp.id && st.trans.m > 0.5);
      const isPv = inp.id === st.previewId;
      cell.className = 'vmx-input' + (hasVisual(inp) ? '' : ' audio-only') + (isPgm ? ' sel-pgm' : isPv ? ' sel-pv' : '');
      const stateEl = cell.querySelector('.vmx-in-state');
      if (stateEl) stateEl.textContent = isPgm ? 'ON AIR' : 'PREVIEW';
      const loop = cell.querySelector('[data-act="loop"]');
      if (loop) loop.classList.toggle('on', !!inp.loop);
      const pause = cell.querySelector('[data-act="pause"]');
      if (pause) pause.textContent = inp.paused ? '▶' : '⏸';
      const aud = cell.querySelector('[data-act="audio"]');
      if (aud) {
        aud.classList.toggle('on', !!inp.audioOn);
        if (hasVisual(inp)) {
          aud.textContent = inp.audioOn ? '🔊' : '🔇';
          aud.title = inp.audioOn
            ? 'This source’s sound is going out — click to mute it'
            : 'This source is muted — click to let its sound out';
        }
      }
      const slideNo = cell.querySelector('.vmx-in-slideno');
      if (slideNo) slideNo.textContent = String(inp._pdfPage || 1);
      cell.querySelectorAll('[data-act="vshot"]').forEach((b) => {
        b.classList.toggle('on', !!(inp._vset && inp._vset.mover.index === Number(b.dataset.shot)));
      });
      cell.querySelectorAll('[data-act="ov"]').forEach((b) => {
        b.classList.toggle('ov-on', st.ovl[Number(b.dataset.ov)].id === inp.id);
      });
    }
    return true;
  }

  /** Mixer state without rebuilding the strips (see refreshInputCells). */
  function refreshMixerStrips() {
    const panel = refs.vmxMixer;
    if (!panel || !st.mixerOpen) return true;
    const audible = st.inputs.filter((i) => i.gain);
    const want = ['master'].concat(audible.map((i) => String(i.id)));
    const have = [...panel.querySelectorAll('.vmx-strip')].map((s) => s.dataset.strip);
    // A strip appearing or disappearing IS structural — let the full path run.
    if (want.length !== have.length || want.some((k, n) => k !== have[n])) return false;
    for (const strip of panel.querySelectorAll('.vmx-strip')) {
      const key = strip.dataset.strip;
      const master = key === 'master';
      const inp = master ? null : inputById(Number(key));
      if (!master && !inp) return false;
      const on = master ? !st.masterMuted : inp.audioOn;
      const mute = strip.querySelector('[data-mact="mute"]');
      if (mute) { mute.classList.toggle('on', !!on); mute.textContent = on ? '🔊' : '🔇'; }
      const solo = strip.querySelector('[data-mact="solo"]');
      if (solo) solo.classList.toggle('solo-on', !!(inp && inp.solo));
      const lim = strip.querySelector('[data-mact="limiter"]');
      if (lim) lim.classList.toggle('on', !!st.limiterOn);
      const pct = strip.querySelector('.vmx-strip-pct');
      if (pct && inp) pct.textContent = Math.round(inp.volume * 100) + '%';
      // The fader is left alone while it is being dragged — writing the value
      // back under the operator's finger fights them for the handle.
      const fader = strip.querySelector('.vmx-vfader');
      if (fader && document.activeElement !== fader) {
        const vol = master ? st.masterVol : Math.min(1, inp.volume);
        if (Math.abs(Number(fader.value) - vol) > 0.005) fader.value = String(vol);
      }
    }
    return true;
  }

  /** How many times the rail was actually torn down and rebuilt. */
  const railRebuilds = { n: 0 };

  function renderInputs() {
    const bar = refs.vmxInputs;
    const sig = railSig();
    if (bar.__railSig === sig && bar.querySelector('.vmx-input')) {
      if (refreshInputCells() && refreshMixerStrips()) {
        const pvQ = inputById(st.previewId), pgmQ = inputById(st.programId);
        refs.vmxPrvName.textContent = pvQ ? `${pvQ.num}. ${pvQ.name}` : 'Nothing lined up';
        refs.vmxPgmName.textContent = pgmQ ? `${pgmQ.num}. ${pgmQ.name}` : 'Black';
        return;
      }
    }
    bar.__railSig = sig;
    railRebuilds.n++;
    bar.innerHTML = '';
    for (const inp of st.inputs) {
      const cell = document.createElement('div');
      const isPgm = inp.id === st.programId || (st.trans && st.trans.to === inp.id && st.trans.m > 0.5);
      const isPv = inp.id === st.previewId;
      cell.className = 'vmx-input' + (hasVisual(inp) ? '' : ' audio-only') + (isPgm ? ' sel-pgm' : isPv ? ' sel-pv' : '');
      cell.dataset.id = String(inp.id);
      if (hasVisual(inp)) {
        cell.innerHTML =
          `<div class="vmx-in-shell">` +
            `<canvas class="vmx-in-thumb" width="240" height="135"></canvas>` +
            `<canvas class="vmx-in-meter" width="5" height="135"></canvas>` +
            `<span class="vmx-in-num">${inp.num}</span>` +
            `<span class="vmx-in-state">${isPgm ? 'ON AIR' : 'PREVIEW'}</span>` +
            `<div class="vmx-in-title" title="${esc(inp.name)}">${esc(inp.name)}</div>` +
          `</div>` +
          `<div class="vmx-in-row">` +
            `<button data-act="cut" class="take" title="Put this straight on air now">TAKE</button>` +
            `<button data-act="qp" title="Restart this video and fade it to program">⚡</button>` +
            `<button data-act="loop" class="${inp.loop ? 'on' : ''}" title="Loop this video">🔁</button>` +
            `<button data-act="pause" title="Play / pause">${inp.paused ? '▶' : '⏸'}</button>` +
            `<button data-act="audio" class="${inp.audioOn ? 'on' : ''}" title="${inp.audioOn ? 'This source’s sound is going out — click to mute it' : 'This source is muted — click to let its sound out'}">${inp.audioOn ? '🔊' : '🔇'}</button>` +
            `<button data-act="cfg" title="Input settings">⚙</button>` +
            `<button data-act="close" title="Remove this input">✕</button>` +
          `</div>` +
          (inp.type === 'ppt'
            ? `<div class="vmx-in-row"><button data-act="pptprev" title="Previous slide">◀ Slide</button><span class="vmx-in-slideno">${inp._pdfPage || 1}</span><button data-act="pptnext" title="Next slide">Slide ▶</button></div>`
            : '') +
          // The four camera positions, live on the tile — this is how a virtual
          // set is actually operated during a service: press a shot, the camera
          // glides to it on air.
          (inp.type === 'vset' && inp._vset
            ? `<div class="vmx-in-row">` + inp._vset.presets.map((p, n) =>
                `<button data-act="vshot" data-shot="${n}" class="${inp._vset.mover.index === n ? 'on' : ''}" title="${esc(p.name)}">${esc(p.name)}</button>`).join('') + `</div>`
            : '') +
          `<div class="vmx-in-row adv">` +
            `<span class="vmx-in-lbl" title="Overlay channels — lay this source over the program picture">OVERLAY</span>` +
            [0, 1, 2, 3].map((n) =>
              `<button data-act="ov" data-ov="${n}" class="${st.ovl[n].id === inp.id ? 'ov-on' : ''}" title="Lay this source over the program picture on channel ${n + 1}">${n + 1}</button>`).join('') +
          `</div>`;
        inp.thumbCanvas = cell.querySelector('.vmx-in-thumb');
        inp._thumbCtx = null;          // a new element — the cached context is dead
        inp.meterCanvas = cell.querySelector('.vmx-in-meter');
      } else {
        const fileBacked = !!inp.path;
        cell.innerHTML =
          `<div class="vmx-in-vlabel" title="${esc(inp.name)}">${inp.num}. ${esc(inp.name)}</div>` +
          `<canvas class="vmx-in-meter" width="5" height="70"></canvas>` +
          (fileBacked
            ? `<div class="vmx-in-row"><button data-act="loop" class="${inp.loop ? 'on' : ''}" title="Loop this track">🔁</button><button data-act="pause" title="Play / pause">${inp.paused ? '▶' : '⏸'}</button></div>`
            : '') +
          `<div class="vmx-in-row"><button data-act="audio" class="${inp.audioOn ? 'on' : ''}" title="Audio on/off">A</button></div>` +
          `<div class="vmx-in-row"><button data-act="close" title="Remove">✕</button></div>`;
        inp.meterCanvas = cell.querySelector('.vmx-in-meter');
      }
      bar.appendChild(cell);
    }
    // An empty rail should say what to do next, not sit there as a blank shelf.
    /*
     * ONE way in, not two.
     *
     * There used to be a "＋ Add Source" button in the SOURCES header AND a
     * "＋ Add source" tile at the end of the rail, both opening the same
     * dialog — and on an empty board they appeared together with a paragraph
     * that also said to add a source, so the studio asked three times.
     *
     * The header button is the one that stays: it is always in the same place
     * whatever is on the board, whereas the tile sat after the last card and
     * scrolled out of reach exactly when the rail was full enough to need it.
     * So the tile is gone and the empty board points at the button instead.
     */
    if (!st.inputs.length) {
      const hint = document.createElement('div');
      hint.className = 'vmx-rail-empty';
      hint.innerHTML = `<b>Nothing on the board yet.</b>` +
        `<span>Press <b>＋ Add Source</b> above for a camera, a video, a title, this screen or an NDI feed — `
        + `then click its card to line it up in <b>preview</b>, and press <b>TAKE</b> (or Enter) to put it on air.</span>`;
      bar.appendChild(hint);
    }

    if (refs.vmxSrcCount) refs.vmxSrcCount.textContent = String(st.inputs.length);
    // monitor titles follow selection, like vMix
    const pv = inputById(st.previewId), pgm = inputById(st.programId);
    refs.vmxPrvName.textContent = pv ? `${pv.num}. ${pv.name}` : 'Nothing lined up';
    refs.vmxPgmName.textContent = pgm ? `${pgm.num}. ${pgm.name}` : 'Black';
    renderMixerStrips();
  }

  /* ========== AUDIO MIXER (vMix-style: always visible, docked panel) ========= */

  function mixerSectionCollapsed(which) {
    try { return localStorage['mw-vmx-mixer-' + which] === '1'; } catch (e) { return false; }
  }

  /** One channel strip. kind: 'master' | 'input'. */
  function stripHtml(kind, inp) {
    const master = kind === 'master';
    const on = master ? !st.masterMuted : inp.audioOn;
    const vol = master ? st.masterVol : Math.min(1, inp.volume);
    return `<div class="vmx-strip${master ? ' master' : ''}" data-strip="${master ? 'master' : inp.id}">` +
      `<div class="vmx-strip-title${master ? ' master' : ''}" title="${master ? 'Master' : esc(inp.num + '. ' + inp.name)}">${master ? 'Master' : esc(inp.num + '. ' + inp.name)}</div>` +
      `<div class="vmx-strip-body">` +
        `<div class="vmx-strip-btns">` +
          `<button data-mact="gear" title="${master ? 'Production settings' : 'Input settings'}">⚙</button>` +
          (master
            ? `<button data-mact="limiter" class="${st.limiterOn ? 'on' : ''}" title="${st.limiterOn ? 'Limiter is ON — click for its settings and to watch it work' : 'Limiter is OFF — the raw mix can clip. Click to set it up.'}">🛡️</button>` +
              `<button data-mact="info" title="Audio engine info">i</button>`
            : `<button data-mact="solo" class="${inp.solo ? 'solo-on' : ''}" title="Solo — hear only this input in your headphones (the stream/recording is not affected)">S</button>`) +
          `<button data-mact="mute" class="${on ? 'on' : ''}" title="Audio on/off">${on ? '🔊' : '🔇'}</button>` +
        `</div>` +
        `<div class="vmx-strip-fader"><input type="range" class="vmx-vfader" min="0" max="1" step="0.01" value="${vol}" /></div>` +
        `<canvas class="vmx-strip-meter" width="16" height="150"></canvas>` +
        // The limiter's own meter, right beside the level it is protecting.
        // Gain reduction that nobody can see is gain reduction nobody trusts.
        (master ? `<canvas class="vmx-strip-gr" width="8" height="150" title="Limiter — how much it is holding the mix down right now"></canvas>` : '') +
      `</div>` +
      `<div class="vmx-strip-foot">` +
      (master
        ? `<span class="vmx-strip-hp" title="Headphones volume — what you hear, not what gets broadcast">🎧</span><div class="vmx-knob" title="Headphones volume (drag up/down)"><div class="vmx-knob-line"></div></div>`
        : `<span class="vmx-strip-pct">${Math.round(inp.volume * 100)}%</span>`) +
      `</div>` +
    `</div>`;
  }

  function renderMixerStrips() {
    if (!st.mixerOpen || !refs.vmxMixerOut) return;
    const outCollapsed = mixerSectionCollapsed('out');
    const inCollapsed = mixerSectionCollapsed('in');
    refs.vmxMixerRailOut.classList.toggle('collapsed', outCollapsed);
    refs.vmxMixerRailIn.classList.toggle('collapsed', inCollapsed);
    refs.vmxMixerOut.classList.toggle('hidden', outCollapsed);
    refs.vmxMixerIn.classList.toggle('hidden', inCollapsed);
    refs.vmxMixerOut.innerHTML = outCollapsed ? '' : stripHtml('master');
    const audible = st.inputs.filter((i) => i.gain);
    refs.vmxMixerIn.innerHTML = inCollapsed ? '' : (audible.length
      ? audible.map((i) => stripHtml('input', i)).join('')
      : `<div class="vmx-mixer-empty">No inputs with audio yet.</div>`);
    wireMixerStrips();
  }

  function wireMixerStrips() {
    const panel = refs.vmxMixer;
    panel.querySelectorAll('.vmx-strip').forEach((strip) => {
      const key = strip.dataset.strip;
      const master = key === 'master';
      const inp = master ? null : inputById(Number(key));
      if (!master && !inp) return;
      if (master) strip._meterAnalyser = st.masterAnalyser;
      const gear = strip.querySelector('[data-mact="gear"]');
      if (gear) gear.onclick = () => (master ? openSettingsModal() : openInputSettings(inp));
      const info = strip.querySelector('[data-mact="info"]');
      if (info) info.onclick = openAudioInfoModal;
      const limBtn = strip.querySelector('[data-mact="limiter"]');
      if (limBtn) limBtn.onclick = openLimiterModal;
      const mute = strip.querySelector('[data-mact="mute"]');
      if (mute) mute.onclick = () => {
        if (master) setMasterMuted(!st.masterMuted);
        else { inp.audioOn = !inp.audioOn; renderInputs(); }
      };
      const solo = strip.querySelector('[data-mact="solo"]');
      if (solo) solo.onclick = () => { inp.solo = !inp.solo; renderMixerStrips(); };
      const fader = strip.querySelector('.vmx-vfader');
      if (fader) fader.oninput = () => {
        const v = parseFloat(fader.value);
        if (master) { st.masterVol = v; refs.vmxMasterVol.value = String(v); }
        else {
          inp.volume = v;
          const pct = strip.querySelector('.vmx-strip-pct');
          if (pct) pct.textContent = Math.round(v * 100) + '%';
        }
      };
      const knob = strip.querySelector('.vmx-knob');
      if (knob) wireKnob(knob);
    });
  }

  /** Headphones knob: drag up/down (or wheel) to set the monitor volume. */
  function wireKnob(knob) {
    const paint = () => { knob.style.setProperty('--knob-rot', (st.monitorVol * 270 - 135) + 'deg'); };
    paint();
    knob.onwheel = (ev) => { ev.preventDefault(); setMonitorVol(st.monitorVol - Math.sign(ev.deltaY) * 0.06); paint(); };
    knob.onpointerdown = (ev) => {
      ev.preventDefault();
      knob.setPointerCapture(ev.pointerId);
      const startY = ev.clientY, startVol = st.monitorVol;
      knob.onpointermove = (mv) => { setMonitorVol(startVol + (startY - mv.clientY) / 120); paint(); };
      knob.onpointerup = () => { knob.onpointermove = null; knob.onpointerup = null; };
    };
  }

  function setMonitorVol(v) { st.monitorVol = clamp(v, 0, 1); }

  function setMasterMuted(m) {
    st.masterMuted = m;
    refs.vmxMasterMute.textContent = m ? '🔇' : '🔊';
    refs.vmxMasterMute.classList.toggle('on', m);
    renderMixerStrips();
  }

  /**
   * The limiter panel.
   *
   * Deliberately built around a LIVE picture rather than a set of numbers: the
   * two things an operator has to know are "is the mix hitting the ceiling"
   * and "is the limiter catching it", and both are questions about what is
   * happening this second. The reading updates while the service runs, so the
   * panel can be left open on a second screen during soundcheck.
   */
  function openLimiterModal() {
    ensureAudio();
    ensureLimiterWorklet();
    refs.vmxModalBox.className = 'vmx-modal-box';  // the streaming dialog widens it
    const styleRow = Object.entries(LIMITER_STYLES).map(([id, s]) =>
      `<button class="vmx-lim-style${st.limiterStyle === id ? ' on' : ''}" data-limstyle="${id}">` +
      `<b>${esc(s.label)}</b><span>${esc(s.hint)}</span></button>`).join('');
    openModal(
      `<h3>🛡️ Broadcast limiter <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<label class="vmx-inline vmx-lim-onoff"><input type="checkbox" id="vmxLimOn"${st.limiterOn ? ' checked' : ''} /> ` +
        `<b>Protect the stream from clipping</b></label>` +
      `<p class="vmx-note">Sound that goes past full scale cannot be stored — it comes out as a crackle or a buzz, and it is loudest exactly when the room is (a full band, the congregation singing). ` +
      `This holds the peaks down a few milliseconds before they arrive, so nothing ever reaches that point. Leave it on.</p>` +
      `<div class="vmx-lim-styles">${styleRow}</div>` +
      `<label>Ceiling<select id="vmxLimCeil">` +
        [[-0.5, '−0.5 dB'], [-1, '−1 dB (recommended)'], [-2, '−2 dB'], [-3, '−3 dB (most headroom)']].map(([v, l]) =>
          `<option value="${v}"${Math.abs(st.limiterCeiling - v) < 0.01 ? ' selected' : ''}>${l}</option>`).join('') +
      `</select></label>` +
      `<p class="vmx-note">Facebook and YouTube re-compress everything you send them, and that re-compression overshoots. Leaving a decibel of room is what stops the overshoot turning into distortion on someone's phone.</p>` +
      `<div class="vmx-lim-live">` +
        `<div class="vmx-lim-bar"><span>Mix level</span><div class="vmx-lim-track"><i id="vmxLimIn"></i></div><b id="vmxLimInDb">—</b></div>` +
        `<div class="vmx-lim-bar"><span>Being held down</span><div class="vmx-lim-track gr"><i id="vmxLimGr"></i></div><b id="vmxLimGrDb">—</b></div>` +
        `<p class="vmx-note" id="vmxLimVerdict">Waiting for sound…</p>` +
      `</div>` +
      `</div>`);
    const box = refs.vmxModalBox;
    box.querySelector('#vmxLimOn').onchange = (e) => { setLimiterOn(e.target.checked); };
    box.querySelectorAll('[data-limstyle]').forEach((b) => {
      b.onclick = () => {
        setLimiterStyle(b.dataset.limstyle);
        box.querySelectorAll('[data-limstyle]').forEach((x) => x.classList.toggle('on', x === b));
      };
    });
    box.querySelector('#vmxLimCeil').onchange = (e) => setLimiterCeiling(parseFloat(e.target.value));
    // live readout while the panel is open
    const inBar = box.querySelector('#vmxLimIn'), grBar = box.querySelector('#vmxLimGr');
    const inDb = box.querySelector('#vmxLimInDb'), grDb = box.querySelector('#vmxLimGrDb');
    const verdict = box.querySelector('#vmxLimVerdict');
    const tick = () => {
      if (!document.body.contains(inBar)) { clearInterval(st._limTimer); st._limTimer = 0; return; }
      const m = st.limMeter;
      if (!m) return;
      const db = m.inPeak > 0 ? 20 * Math.log10(m.inPeak) : -60;
      inBar.style.width = clamp((db + 40) / 40, 0, 1) * 100 + '%';
      inBar.style.background = db > st.limiterCeiling ? '#e53935' : db > -12 ? '#fbc02d' : '#2fbf2f';
      inDb.textContent = (db <= -59 ? '—' : (db > 0 ? '+' : '') + db.toFixed(1) + ' dB');
      grBar.style.width = clamp(m.grDb / 12, 0, 1) * 100 + '%';
      grDb.textContent = m.grDb > 0.05 ? '−' + m.grDb.toFixed(1) + ' dB' : '0 dB';
      verdict.textContent = !st.limiterOn
        ? '⚠️ The limiter is off — a loud moment can still clip the stream.'
        : m.grDb > 6 ? '🛡️ Working hard. Your mix is very hot — pull the Master fader down a little and the sound will open up.'
        : m.grDb > 0.5 ? '🛡️ Catching the peaks. This is exactly what it is for.'
        : db <= -59 ? 'Waiting for sound…'
        : '✅ Plenty of headroom — nothing needs holding down right now.';
    };
    clearInterval(st._limTimer);
    st._limTimer = setInterval(tick, 100);
    tick();
  }

  function openAudioInfoModal() {
    const ac = st.ac;
    const audible = st.inputs.filter((i) => i.gain).length;
    openModal(
      `<h3>🔊 Audio engine <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<p class="vmx-note">Sample rate: <b>${ac ? ac.sampleRate + ' Hz' : '— (no audio yet)'}</b><br/>` +
      `State: <b>${ac ? ac.state : '—'}</b><br/>` +
      `Inputs with audio: <b>${audible}</b> of ${st.inputs.length}<br/>` +
      `Headphones volume: <b>${Math.round(st.monitorVol * 100)}%</b><br/>` +
      `Limiter: <b>${st.limiterOn ? 'On — ' + limiterStyle().label.replace(/\s*\(.*\)$/, '') + ', ceiling ' + st.limiterCeiling + ' dB' : 'Off — the raw mix can clip'}</b>` +
      `${st.limNode ? ' (look-ahead, ' + ((st.limMeter && st.limMeter.latencyMs) || 5) + ' ms)' : ' (fallback compressor)'}<br/>` +
      `${st.limMeter ? `Clipped samples since start: <b>${st.limMeter.hardClips}</b><br/>` : ''}<br/>` +
      `The Master fader/meter is exactly what gets recorded and streamed. The headphones knob and Solo buttons only change what you hear at the desk.</p>` +
      `</div>`);
  }

  /** Segmented vertical meter into a strip canvas (matches the master meter look). */
  function drawStripMeter(cv, level) {
    const ctx = cv.getContext('2d');
    const SEG = 18, gap = 2, segH = (cv.height - 6) / SEG;
    ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, cv.width, cv.height);
    const lit = Math.round(clamp(level, 0, 1) * SEG);
    for (let col = 0; col < 2; col++) {
      const x = col === 0 ? 2 : 9;
      for (let i = 0; i < SEG; i++) {
        const y = cv.height - 3 - (i + 1) * segH;
        const frac = i / SEG;
        ctx.fillStyle = i < lit
          ? (frac > 0.86 ? '#e53935' : frac > 0.66 ? '#fbc02d' : '#2fbf2f')
          : '#1e2a1e';
        ctx.fillRect(x, y + gap / 2, 5, Math.max(1, segH - gap));
      }
    }
  }

  function drawMixerMeters() {
    if (!st.mixerOpen) return;
    const now = performance.now();
    // Re-measuring every strip forces a layout pass; the strips only change size
    // when the window does, so measure at most once a second.
    const measure = now - (st._meterMeasureAt || 0) > 1000;
    if (measure) st._meterMeasureAt = now;
    refs.vmxMixer.querySelectorAll('.vmx-strip').forEach((strip) => {
      const cv = strip.querySelector('.vmx-strip-meter');
      if (!cv) return;
      // the canvas stretches to the strip height — keep the bitmap 1:1 so
      // segments stay crisp instead of scaling up from 150px
      const h = measure || !cv.height ? cv.clientHeight : cv.height;
      if (h && cv.height !== h) cv.height = h;
      const key = strip.dataset.strip;
      if (key === 'master') {
        drawStripMeter(cv, st.masterLevel);
        const gr = strip.querySelector('.vmx-strip-gr');
        if (gr) {
          if (h && gr.height !== h) gr.height = h;
          drawGrMeter(gr);
        }
        return;
      }
      const inp = inputById(Number(key));
      if (inp) drawStripMeter(cv, clamp(inp.level * 3, 0, 1));
    });
  }

  /**
   * Gain reduction, drawn hanging DOWN from the top — the way every limiter in
   * broadcast draws it, and the reason it reads instantly: the bar growing
   * downwards is the sound being pushed down.
   */
  function drawGrMeter(cv) {
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#101010'; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!st.limiterOn) {
      ctx.fillStyle = '#3a2020';
      ctx.fillRect(1, 0, cv.width - 2, cv.height);
      return;
    }
    const m = st.limMeter;
    const grDb = m ? m.grDb : 0;
    const frac = clamp(grDb / 12, 0, 1);            // full bar = 12 dB held down
    ctx.fillStyle = grDb > 6 ? '#e53935' : '#4f9cff';
    ctx.fillRect(1, 0, cv.width - 2, Math.round(frac * cv.height));
  }

  function onInputBarClick(ev) {
    const cell = ev.target.closest('.vmx-input');
    if (!cell) return;
    const id = Number(cell.dataset.id);
    const inp = inputById(id);
    if (!inp) return;
    const btn = ev.target.closest('button');
    if (!btn) {
      if (hasVisual(inp)) setPreview(id);
      return;
    }
    switch (btn.dataset.act) {
      case 'close': closeInput(id); break;
      case 'qp': quickPlay(id); break;
      case 'cut': setPreview(id); cut(); break;
      case 'loop':
        inp.loop = !inp.loop;
        if (inp.type !== 'list' && inp.el && (inp.el.tagName === 'VIDEO' || inp.el.tagName === 'AUDIO')) inp.el.loop = inp.loop;
        renderInputs();
        break;
      case 'pause':
        if (inp.el && (inp.el.tagName === 'VIDEO' || inp.el.tagName === 'AUDIO') && !inp.stream) {
          inp.paused = !inp.paused;
          if (inp.paused) inp.el.pause(); else inp.el.play().catch(() => {});
          renderInputs();
        }
        break;
      case 'ov': toggleOverlay(Number(btn.dataset.ov), id); break;
      case 'audio': inp.audioOn = !inp.audioOn; renderInputs(); break;
      case 'cfg': openInputSettings(inp); break;
      case 'pptprev': pptGoToSlide(inp, (inp._pdfPage || 1) - 1); renderInputs(); break;
      case 'pptnext': pptGoToSlide(inp, (inp._pdfPage || 1) + 1); renderInputs(); break;
      case 'vshot': vsetGoTo(id, Number(btn.dataset.shot)); break;
    }
  }

  /* ============================ MENUS + MODALS ============================ */

  function hideMenu() { refs.vmxMenu.classList.add('hidden'); }

  function showMenu(anchor, html, onClick) {
    const menu = refs.vmxMenu;
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    const host = refs.vmx.getBoundingClientRect();
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.min(r.left - host.left, host.width - 230) + 'px';
    const openUp = r.top - host.top > host.height * 0.55;
    if (openUp) { menu.style.bottom = (host.height - (r.top - host.top)) + 4 + 'px'; menu.style.top = 'auto'; }
    else { menu.style.top = (r.bottom - host.top) + 4 + 'px'; menu.style.bottom = 'auto'; }
    menu.onclick = (ev) => { const b = ev.target.closest('button,label'); if (b && onClick) onClick(b, ev); };
  }

  function openModal(html) {
    refs.vmxModalBox.innerHTML = html;
    refs.vmxModal.classList.remove('hidden');
    const x = refs.vmxModalBox.querySelector('.vmx-modal-x');
    if (x) x.onclick = closeModal;
  }
  function closeModal() { refs.vmxModal.classList.add('hidden'); refs.vmxModalBox.innerHTML = ''; }

  /* ------- Add Input: vMix-style "Input Select" dialog ------- */

  function openInputSelectModal() {
    const sel = {
      cat: 'video', path: '', name: '',
      color: '#204080', colorName: 'Colour',
      photos: null, photo: null,
      cams: null, camId: '', camLabel: '',
      // vMix-style camera capture options (all default to automatic)
      camRes: '', camFps: 'auto', camFormat: '', camAudioId: '',
      camCaps: null, camActual: null, camMics: [],
      mics: null, micId: '', micLabel: '',
      screens: null, screenId: '',
      desktopTab: 'ndi',               // 'ndi' | 'local' — NDI is the default tab (matches vMix)
      ndiStatus: null, ndiSources: [], ndiSourceName: '', ndiLowBw: false, ndiAudioOnly: false,
      ndiScanTimer: 0, _ndiSig: '', _ndiPreviewId: null, _ndiPreviewSurface: null,
      title: { headline: 'Sunday Service', subtext: '', style: 'lower', color: '#ffffff' },
      previewStream: null,
      listItems: [], listImgSec: 4,
      delaySrc: null, delaySec: 5,
      webUrl: 'https://',
      callUrl: 'https://meet.jit.si/' + 'church-' + Math.random().toString(36).slice(2, 8),
      srtUrl: '',
      pptPath: '', pptName: '', pptPdfPath: '', pptChecked: false, pptAvailable: false, pptConverting: false,
      replayTick: 0,
      // virtual set
      vsName: 'Virtual Set', vsSourceId: null, vsBgPath: '', vsFgPath: '',
      vsPresets: window.VirtualSet.DEFAULT_PRESETS.map((p) => ({ ...p })),
      vsShot: 0, vsSurface: null, vsRaf: 0, vsDrag: null,
      vsKey: { on: true, color: '#00b140', tolerance: 0.16, softness: 0.08, spill: 0.5 },
    };
    st._inputSel = sel; // so tests can read what the dialog is actually doing

    function stopPreview() {
      if (sel.previewStream) { sel.previewStream.getTracks().forEach((t) => t.stop()); sel.previewStream = null; }
    }
    function stopReplayTick() { if (sel.replayTick) { clearInterval(sel.replayTick); sel.replayTick = 0; } }

    function stopNdiScan() { if (sel.ndiScanTimer) { clearInterval(sel.ndiScanTimer); sel.ndiScanTimer = 0; } }
    function stopNdiPreview() {
      if (sel._ndiPreviewId) {
        releaseNdiPort(sel._ndiPreviewId);
        try { window.api.live.ndiStop(sel._ndiPreviewId); } catch (e) {}
        sel._ndiPreviewId = null;
      }
      if (sel._ndiPreviewSurface) { try { sel._ndiPreviewSurface.destroy(); } catch (e) {} sel._ndiPreviewSurface = null; }
    }
    async function startNdiScan() {
      try { sel.ndiStatus = await window.api.live.ndiStatus(); } catch (e) { sel.ndiStatus = { available: false, error: String(e.message || e) }; }
      const poll = async () => {
        try {
          const list = await window.api.live.ndiSources();
          const sig = list.map((s) => s.name).join('|');
          if (sig !== sel._ndiSig) {
            sel._ndiSig = sig; sel.ndiSources = list;
            if (sel.cat === 'desktop' && sel.desktopTab === 'ndi') render();
          }
        } catch (e) {}
      };
      await poll();
      if (!sel.ndiScanTimer) sel.ndiScanTimer = setInterval(poll, 1500);
    }
    function startNdiPreview(source) {
      stopNdiPreview();
      if (!source) return;
      const pid = 'ndipv' + Date.now();
      sel._ndiPreviewId = pid;
      // A throwaway surface for the dialog's little monitor. lowBandwidth asks
      // the SENDER for its proxy stream, so picking through a long source list
      // never pulls full-rate 1080p off the network.
      const surface = window.NdiVideo.createSurface();
      sel._ndiPreviewSurface = surface;
      ndiHandlers.set(pid, {
        onVideo: (msg) => {
          const cv = refs.vmxModalBox && refs.vmxModalBox.querySelector('#vmxIsNdiPreview');
          if (!cv) return;
          if (!surface.upload(msg)) return;
          const c = cv.getContext('2d');
          const s = Math.min(cv.width / msg.w, cv.height / msg.h), dw = msg.w * s, dh = msg.h * s;
          c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
          try { c.drawImage(surface.canvas, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh); } catch (e) {}
        },
      });
      window.api.live.ndiStart(pid, source, { lowBandwidth: true, fpsCap: 30 }).catch(() => {});
    }

    /* ---- the virtual-set page previews itself, live, before it is added ---- */
    function onVsDrag(e) {
      if (!sel.vsDrag) return;
      const cv = refs.vmxModalBox.querySelector('#vmxVsPrev');
      if (!cv) return;
      const p = sel.vsPresets[sel.vsShot];
      p.x = clamp(sel.vsDrag.px + (e.clientX - sel.vsDrag.x) / cv.clientWidth, -0.5, 1.5);
      p.y = clamp(sel.vsDrag.py + (e.clientY - sel.vsDrag.y) / cv.clientHeight, -0.5, 1.5);
    }
    function endVsDrag() { sel.vsDrag = null; }

    function stopVsPreview() {
      if (sel.vsRaf) { cancelAnimationFrame(sel.vsRaf); sel.vsRaf = 0; }
      if (sel.vsSurface) { try { sel.vsSurface.destroy(); } catch (e) {} sel.vsSurface = null; }
      window.removeEventListener('mousemove', onVsDrag);
      window.removeEventListener('mouseup', endVsDrag);
      sel.vsDrag = null;
    }
    function startVsPreview() {
      const cv = refs.vmxModalBox.querySelector('#vmxVsPrev');
      if (!cv) return;
      if (!sel.vsSurface) sel.vsSurface = window.VirtualSet.createSet(cv.width, cv.height);
      const ctx = cv.getContext('2d');
      const tick = () => {
        sel.vsRaf = 0;
        if (sel.cat !== 'vset') return;
        const src = inputById(sel.vsSourceId);
        const p = sel.vsPresets[sel.vsShot] || sel.vsPresets[0];
        try {
          sel.vsSurface.render({ source: src ? drawSourceOf(src) : null, pos: p, key: sel.vsKey });
          ctx.drawImage(sel.vsSurface.canvas, 0, 0, cv.width, cv.height);
        } catch (e) {}
        sel.vsRaf = requestAnimationFrame(tick);
      };
      // Whatever scene and layers are already chosen, before the first frame.
      const load = (path, fn) => {
        if (!path) { fn(null); return; }
        const img = new Image();
        img.onload = () => fn(img);
        img.src = /^(file|data|https?):/.test(path) ? path : fileUrl(path);
      };
      load(sel.vsBgPath, (i) => sel.vsSurface && sel.vsSurface.setBackground(i));
      load(sel.vsFgPath, (i) => sel.vsSurface && sel.vsSurface.setForeground(i));
      if (!sel.vsRaf) sel.vsRaf = requestAnimationFrame(tick);
    }

    function closeThis() { stopPreview(); stopReplayTick(); stopNdiScan(); stopNdiPreview(); stopVsPreview(); refs.vmxModalBox.className = 'vmx-modal-box'; closeModal(); }
    st._inputSelClose = closeThis;

    async function selectCat(id) {
      stopPreview();
      if (id !== 'replay') stopReplayTick();
      if (id !== 'desktop') { stopNdiScan(); stopNdiPreview(); }
      if (id !== 'vset') stopVsPreview();
      sel.cat = id;
      if (id === 'delay' && sel.delaySrc == null && st.inputs.length) sel.delaySrc = st.inputs[0].id;
      render();
      if (id === 'vset') startVsPreview();
      try {
        if (id === 'camera' && sel.cams == null) await loadCams();
        else if (id === 'mic' && sel.mics == null) await loadMics();
        else if (id === 'desktop') { if (sel.screens == null) await loadScreens(); await startNdiScan(); }
        else if (id === 'photos' && sel.photos == null) await loadPhotos();
        else if (id === 'ppt' && !sel.pptChecked) await loadPptCheck();
        else if (id === 'replay') { if (!st.replayArmed) await armInstantReplay(); render(); sel.replayTick = setInterval(render, 1000); }
      } catch (e) { toast('⚠️ ' + (e.message || e), 'error'); }
    }

    async function loadPptCheck() {
      try { const r = await window.api.ppt.check(); sel.pptAvailable = !!(r && r.available); } catch (e) { sel.pptAvailable = false; }
      sel.pptChecked = true;
      render();
    }

    /**
     * Show the cameras AT ONCE. See devCache above for why this used to take
     * seconds. The order here is the whole point: list first, names second,
     * picture third — never the other way round.
     */
    async function loadCams() {
      if (devCache.cams == null) await warmDevices();
      // Before permission has ever been granted the browser withholds the
      // device IDs as well as the names, so there is genuinely nothing
      // pickable to show yet — that ONE time, ask first. Every run after it
      // takes the fast path below.
      if ((devCache.cams || []).length && !devCache.cams.some((d) => d.deviceId)) {
        if (await unlockDeviceLabels('video')) { devCache.cams = devCache.mics = null; await warmDevices(); }
      }
      if (sel.cat !== 'camera') return;                     // moved on while we looked
      sel.cams = devCache.cams || [];
      sel.camMics = devCache.mics || [];
      render();                                             // ← the list is on screen now
      if (sel.cams.length) pickCam(sel.cams[0]);            // preview fills in behind it
      // Names but no labels (permission granted, list gone stale): relabel quietly.
      if (await unlockDeviceLabels('video')) {
        devCache.cams = devCache.mics = null;
        await warmDevices();
        if (sel.cat !== 'camera') return;
        sel.cams = devCache.cams || [];
        sel.camMics = devCache.mics || [];
        render();
      }
    }
    async function pickCam(d) {
      stopPreview();
      sel.camId = d.deviceId; sel.camLabel = d.label || 'Camera';
      sel.camPreviewFailed = false;
      sel.camCaps = null; sel.camActual = null;
      render();
      try {
        // Preview is cosmetic — use the resilient opener and, if it STILL can't
        // preview, show an inline note (NOT a toast): the camera is usually fine
        // and gets added anyway, so a "camera not found" toast here is just noise.
        sel.previewStream = await openCameraStream({ video: { deviceId: d.deviceId ? { exact: d.deviceId } : undefined } });
        readCamTrack();
      } catch (e) { sel.camPreviewFailed = true; }
      // Keep any Resolution / Frame Rate / Format choices across a device
      // switch — applyCamSel re-applies them to the new camera and re-renders.
      if (sel.previewStream && (sel.camRes || sel.camFps !== 'auto' || sel.camFormat)) return applyCamSel();
      render();
    }
    /** What the previewed camera can do, and what it is doing right now. */
    function readCamTrack() {
      const track = sel.previewStream && sel.previewStream.getVideoTracks()[0];
      if (!track) return;
      try { sel.camCaps = track.getCapabilities ? track.getCapabilities() : null; } catch (e) { sel.camCaps = null; }
      try { sel.camActual = track.getSettings ? track.getSettings() : null; } catch (e) { sel.camActual = null; }
    }
    /**
     * Live-apply the chosen Resolution / Frame Rate / Video Format to the
     * preview track, then report what the camera ACTUALLY settled on — so the
     * dialog proves a setting works before the input is ever added.
     */
    async function applyCamSel() {
      const track = sel.previewStream && sel.previewStream.getVideoTracks()[0];
      if (!track || !track.applyConstraints) { render(); return; }
      const q = quality();
      const m = /^(\d+)x(\d+)$/.exec(sel.camRes || '');
      const base = {
        width: { ideal: m ? Number(m[1]) : q.width }, height: { ideal: m ? Number(m[2]) : q.height },
        ...(sel.camFormat ? { resizeMode: sel.camFormat } : {}),
      };
      const fps = sel.camFps !== 'auto' ? Number(sel.camFps) : 0;
      try {
        // EXACT first: a chosen rate is an instruction, not a suggestion. With
        // `ideal` the browser silently hands back whatever the camera prefers,
        // which is why picking 60 used to leave you at 30 with no explanation.
        await track.applyConstraints(fps ? Object.assign({ frameRate: { exact: fps } }, base) : base);
      } catch (e) {
        // The camera refused that exact rate. Ask for it as a preference so it
        // still gets as close as it can — and the line under the preview says
        // what it actually settled on, instead of pretending it worked.
        try { await track.applyConstraints(fps ? Object.assign({ frameRate: { ideal: fps } }, base) : base); }
        catch (e2) { /* even the relaxed ask failed — the reported settings tell the truth */ }
      }
      readCamTrack();
      render();
    }

    /** Same treatment for Audio Input — list first, names after. */
    async function loadMics() {
      if (devCache.mics == null) await warmDevices();
      if (sel.cat !== 'mic') return;
      const take = () => {
        sel.mics = devCache.mics || [];
        if (sel.mics.length && !sel.mics.some((m) => m.deviceId === sel.micId)) {
          sel.micId = sel.mics[0].deviceId;
          sel.micLabel = sel.mics[0].label || 'Microphone';
        }
        render();
      };
      take();
      if (await unlockDeviceLabels('audio')) {
        devCache.cams = devCache.mics = null;
        await warmDevices();
        if (sel.cat !== 'mic') return;
        take();
      }
    }

    async function loadScreens() {
      try { sel.screens = await window.api.live.screenSources(); } catch (e) { sel.screens = []; }
      render();
    }

    async function loadPhotos() {
      try { sel.photos = await window.api.photos.list(); } catch (e) { sel.photos = []; }
      render();
    }

    function panelHtml(cat) {
      if (!cat.supported) {
        return `<div class="vmx-is-hint">${esc(cat.label)}</div>` +
          `<div class="vmx-is-empty"><div class="vmx-is-empty-ic">🚧</div>` +
          `<p>${esc(cat.label)} isn't available in Church Work Space.</p>` +
          (cat.note ? `<p class="vmx-is-empty-note">${esc(cat.note)}</p>` : '') +
          `</div>`;
      }
      if (cat.id === 'video' || cat.id === 'image') {
        const isVid = cat.id === 'video';
        return `<div class="vmx-is-hint">Select the ${isVid ? 'Video' : 'Image'} file to open.</div>` +
          `<div class="vmx-is-content">` +
          `<div class="vmx-is-browse-row"><input type="text" id="vmxIsPath" readonly value="${esc(sel.path)}" placeholder="No file selected" /><button class="vmx-btn" id="vmxIsBrowse">Browse…</button></div>` +
          `<div class="vmx-is-preview">${sel.path
            ? (isVid ? `<video src="${fileUrl(sel.path)}" muted loop autoplay></video>` : `<img src="${fileUrl(sel.path)}" />`)
            : `<div class="vmx-is-preview-empty">No preview</div>`}</div>` +
          `</div>`;
      }
      if (cat.id === 'photos') {
        if (sel.photos == null) return `<div class="vmx-is-hint">Photos</div><div class="vmx-is-content"><p class="vmx-note">Loading…</p></div>`;
        if (!sel.photos.length) return `<div class="vmx-is-hint">Photos</div><div class="vmx-is-empty"><div class="vmx-is-empty-ic">🗂</div><p>No bundled photos found.</p></div>`;
        return `<div class="vmx-is-hint">Choose a bundled photo.</div>` +
          `<div class="vmx-is-content"><div class="vmx-is-photo-grid">` +
          sel.photos.map((p) => `<div class="vmx-is-photo-tile${sel.photo && sel.photo.path === p.path ? ' sel' : ''}" data-p="${esc(p.path)}"><img src="${fileUrl(p.path)}" /><div>${esc(p.name)}</div></div>`).join('') +
          `</div></div>`;
      }
      if (cat.id === 'vset') {
        const cams = st.inputs.filter((i) => hasVisual(i) && i.type !== 'vset');
        if (!cams.length) {
          return `<div class="vmx-is-hint">Virtual Set</div><div class="vmx-is-empty"><div class="vmx-is-empty-ic">🧑</div>` +
            `<p>Add the camera first.</p>` +
            `<p class="vmx-is-empty-note">A virtual set puts an existing input inside a studio scene, so there has to be one to put in. Add your green-screen camera, then come back here.</p></div>`;
        }
        if (sel.vsSourceId == null) sel.vsSourceId = cams[0].id;
        const k = sel.vsKey;
        return `<div class="vmx-is-hint">Put a green-screen camera inside a studio scene.</div>` +
          `<div class="vmx-is-content"><div class="vmx-vs-wrap">` +
            `<div class="vmx-vs-stage"><canvas id="vmxVsPrev" width="480" height="270"></canvas>` +
              `<div class="vmx-vs-shots">` +
                sel.vsPresets.map((p, i) => `<button class="vmx-btn vmx-vs-shot${sel.vsShot === i ? ' sel' : ''}" data-shot="${i}">${esc(p.name)}</button>`).join('') +
              `</div>` +
              `<p class="vmx-note vmx-vs-tip">Drag the picture to move the camera · scroll to zoom · the four shots are yours to set up, and Go Live glides between them.</p>` +
            `</div>` +
            `<div class="vmx-vs-side"><div class="vmx-form">` +
              `<label>Name<input type="text" id="vmxVsName" value="${esc(sel.vsName)}" /></label>` +
              `<label>Camera<select id="vmxVsSrc">` +
                cams.map((c) => `<option value="${c.id}"${sel.vsSourceId === c.id ? ' selected' : ''}>${esc(c.num + '. ' + c.name)}</option>`).join('') +
              `</select></label>` +
              `<label>Scene<div class="vmx-is-browse-row"><input type="text" id="vmxVsBg" readonly value="${esc(sel.vsBgPath)}" placeholder="Choose a background image" /><button class="vmx-btn" id="vmxVsBgPick">Browse…</button></div></label>` +
              `<label>In front <span class="vmx-dim">(optional — a desk or pillar to stand behind)</span><div class="vmx-is-browse-row"><input type="text" id="vmxVsFg" readonly value="${esc(sel.vsFgPath)}" placeholder="None" /><button class="vmx-btn" id="vmxVsFgPick">Browse…</button></div></label>` +
              `<div class="vmx-vs-keyhdr"><label class="vmx-inline"><input type="checkbox" id="vmxVsKeyOn"${k.on ? ' checked' : ''} /> Remove the green screen</label>` +
                `<button class="vmx-btn vmx-btn-sm" id="vmxVsPick">Pick colour from shot</button></div>` +
              `<label>Screen colour<input type="color" id="vmxVsKeyCol" value="${esc(k.color)}" /></label>` +
              `<label>How much to remove <span class="vmx-dim">${Math.round(k.tolerance * 100)}%</span>` +
                `<input type="range" id="vmxVsTol" min="1" max="60" value="${Math.round(k.tolerance * 100)}" /></label>` +
              `<label>Edge softness <span class="vmx-dim">${Math.round(k.softness * 100)}%</span>` +
                `<input type="range" id="vmxVsSoft" min="0" max="40" value="${Math.round(k.softness * 100)}" /></label>` +
              `<label>Green spill on the presenter <span class="vmx-dim">${Math.round(k.spill * 100)}%</span>` +
                `<input type="range" id="vmxVsSpill" min="0" max="100" value="${Math.round(k.spill * 100)}" /></label>` +
            `</div></div>` +
          `</div></div>`;
      }
      if (cat.id === 'color') {
        return `<div class="vmx-is-hint">Choose a solid colour input.</div>` +
          `<div class="vmx-is-content"><div class="vmx-form">` +
          `<label>Name<input type="text" id="vmxIsColName" value="${esc(sel.colorName)}" /></label>` +
          `<label>Colour<input type="color" id="vmxIsColVal" value="${esc(sel.color)}" /></label>` +
          `</div><div class="vmx-is-preview" style="background:${esc(sel.color)}"></div></div>`;
      }
      if (cat.id === 'camera') {
        // Only ever seen if someone reaches this within the first few seconds
        // of opening the app — the list is found in the background at launch.
        if (sel.cams == null) return `<div class="vmx-is-hint">Select a camera.</div><div class="vmx-is-content"><p class="vmx-note">Finding cameras… <span class="vmx-dim">(first time after opening the app)</span></p></div>`;
        if (!sel.cams.length) return `<div class="vmx-is-hint">Select a camera.</div><div class="vmx-is-content"><p class="vmx-note">No camera found on this PC.</p></div>`;
        const caps = sel.camCaps || {};
        const qp = quality();
        const maxW = (caps.width && caps.width.max) || 4096;
        const maxH = (caps.height && caps.height.max) || 2304;
        const maxF = (caps.frameRate && caps.frameRate.max) || 0;
        const minF = (caps.frameRate && caps.frameRate.min) || 0;
        const resChoices = CAM_RES_CHOICES.filter(([w, h]) => w <= maxW && h <= maxH);
        // Every rate is selectable (see CAM_FPS_CHOICES) — rates outside what the
        // camera reports are simply flagged, not hidden, because the report is
        // often wrong and forcing the rate is exactly what this row is for.
        const fpsChoices = CAM_FPS_CHOICES.map(([f, l]) =>
          [f, l + ((maxF && f > maxF + 0.5) || (minF && f < minF - 0.5) ? ' — not reported by this camera' : '')]);
        const fmtChoices = [['', 'Default (automatic)'], ['none', 'Native — exactly what the camera sends'], ['crop-and-scale', 'Crop and scale to the requested size']]
          .filter(([v]) => !v || !Array.isArray(caps.resizeMode) || caps.resizeMode.includes(v));
        const a = sel.camActual;
        const actual = a && a.width
          ? `Camera is delivering ${a.width}×${a.height}${a.frameRate ? ` @ ${Math.round(a.frameRate * 100) / 100} fps` : ''}` : '';
        // Honest report when a forced rate did not stick: the operator picked a
        // number, so say plainly whether the camera is actually running at it.
        const wantF = sel.camFps !== 'auto' ? Number(sel.camFps) : 0;
        const gotF = a && a.frameRate ? a.frameRate : 0;
        const fpsWarn = wantF && gotF && Math.abs(gotF - wantF) > 0.6
          ? `This camera would not run at ${wantF} fps — it is delivering ${Math.round(gotF * 100) / 100} fps. Pick a rate it accepts, or lower the resolution (many cameras only reach their top rate at smaller sizes).`
          : '';
        const fpsLocked = wantF && gotF && Math.abs(gotF - wantF) <= 0.6;
        return `<div class="vmx-is-hint">Select a camera and how it should be captured.</div>` +
          `<div class="vmx-is-content">` +
          `<div class="vmx-is-camrows">` +
          `<label for="vmxIsCamSel">Camera:</label><select id="vmxIsCamSel">` +
            sel.cams.map((d, i) => `<option value="${esc(d.deviceId)}"${sel.camId === d.deviceId ? ' selected' : ''}>${esc(d.label || 'Camera ' + (i + 1))}</option>`).join('') + `</select>` +
          `<label for="vmxIsCamRes">Resolution:</label><select id="vmxIsCamRes">` +
            `<option value=""${sel.camRes ? '' : ' selected'}>Auto — match production (${qp.width}×${qp.height})</option>` +
            resChoices.map(([w, h]) => `<option value="${w}x${h}"${sel.camRes === w + 'x' + h ? ' selected' : ''}>${w}×${h}</option>`).join('') + `</select>` +
          `<label for="vmxIsCamFps">Frame Rate:</label><select id="vmxIsCamFps">` +
            `<option value="auto"${sel.camFps === 'auto' ? ' selected' : ''}>Auto — camera native, production follows it</option>` +
            fpsChoices.map(([f, l]) => `<option value="${f}"${String(sel.camFps) === String(f) ? ' selected' : ''}>${esc(l)}</option>`).join('') + `</select>` +
          `<label for="vmxIsCamFmt">Video Format:</label><select id="vmxIsCamFmt">` +
            fmtChoices.map(([v, l]) => `<option value="${v}"${sel.camFormat === v ? ' selected' : ''}>${l}</option>`).join('') + `</select>` +
          `<label for="vmxIsCamAud">Audio Device:</label><select id="vmxIsCamAud">` +
            `<option value=""${sel.camAudioId ? '' : ' selected'}>None — add sound as its own Audio Input</option>` +
            (sel.camMics || []).map((d, i) => `<option value="${esc(d.deviceId)}"${sel.camAudioId === d.deviceId ? ' selected' : ''}>${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('') + `</select>` +
          `</div>` +
          `<div class="vmx-is-preview">${sel.previewStream ? `<video id="vmxIsCamPrev" autoplay muted playsinline></video>` : `<div class="vmx-is-preview-empty">${sel.camPreviewFailed ? 'Preview unavailable — the camera will still be added.' : 'Opening camera…'}</div>`}</div>` +
          (actual ? `<div class="vmx-is-camactual">✓ ${esc(actual)}${fpsLocked ? ` — locked at ${wantF} fps` : ''}</div>` : '') +
          (fpsWarn ? `<div class="vmx-is-camwarn">⚠ ${esc(fpsWarn)}</div>` : '') +
          `</div>`;
      }
      if (cat.id === 'mic') {
        return `<div class="vmx-is-hint">Select a microphone.</div>` +
          `<div class="vmx-is-content">` +
          (sel.mics == null ? `<p class="vmx-note">Finding microphones… <span class="vmx-dim">(first time after opening the app)</span></p>` :
            !sel.mics.length ? `<p class="vmx-note">No microphone found on this PC.</p>` :
            `<div class="vmx-is-fieldrow"><label for="vmxIsMicSel">Microphone:</label>` +
            `<select id="vmxIsMicSel">` + sel.mics.map((d, i) => `<option value="${esc(d.deviceId)}"${sel.micId === d.deviceId ? ' selected' : ''}>${esc(d.label || 'Microphone ' + (i + 1))}</option>`).join('') + `</select></div>`) +
          `</div>`;
      }
      if (cat.id === 'desktop') {
        const onNdi = sel.desktopTab === 'ndi';
        const tabs =
          `<div class="vmx-is-ndi-tabs">` +
            `<button class="vmx-is-ndi-tab${onNdi ? ' sel' : ''}" data-dtab="ndi">NDI</button>` +
            `<button class="vmx-is-ndi-tab${!onNdi ? ' sel' : ''}" data-dtab="local">Local Desktop Capture</button>` +
          `</div>`;
        if (onNdi) {
          const st0 = sel.ndiStatus;
          let body;
          if (st0 && st0.available === false) {
            body = `<div class="vmx-is-empty"><div class="vmx-is-empty-ic">📡</div>` +
              `<p>NDI runtime not found on this PC.</p>` +
              `<p class="vmx-is-empty-note">${esc(st0.error || 'Install the free “NDI Tools” from ndi.video, then restart the app.')}</p></div>`;
          } else {
            const machine = (st0 && st0.machine) || '';
            const list = sel.ndiSources || [];
            const grid = !list.length
              ? `<div class="vmx-is-empty"><div class="vmx-is-empty-ic vmx-is-ndi-scan">📡</div><p>Scanning for NDI sources…</p>` +
                `<p class="vmx-is-empty-note">Make sure the sender (vMix, PTZ camera, ProPresenter, OBS…) is running on the same network.</p></div>`
              : `<div class="vmx-is-ndi-grid">` + list.map((s, i) => {
                  const selct = s.name === sel.ndiSourceName;
                  return `<div class="vmx-is-ndi-tile${selct ? ' sel' : ''}" data-ndi="${i}">` +
                    `<div class="vmx-is-ndi-thumb">${selct ? `<canvas id="vmxIsNdiPreview" width="240" height="135"></canvas>` : `<span class="vmx-is-ndi-glyph">NDI</span>`}</div>` +
                    `<div class="vmx-is-ndi-name" title="${esc(s.name)}">${esc(s.display || s.name)}</div>` +
                    `<div class="vmx-is-ndi-machine">${esc(s.machine || '')}</div>` +
                  `</div>`;
                }).join('') + `</div>`;
            body =
              `<div class="vmx-is-ndi-head"><span class="vmx-is-ndi-logo">NDI<sup>®</sup></span>` +
                `<span class="vmx-is-ndi-host">${machine ? esc(machine) : ''}${list.length ? ` — ${list.length} source${list.length > 1 ? 's' : ''}` : ''}</span></div>` +
              grid +
              `<div class="vmx-is-ndi-opts">` +
                `<label><input type="checkbox" id="vmxIsNdiLowBw"${sel.ndiLowBw ? ' checked' : ''}/> Low Bandwidth Mode</label>` +
                `<label><input type="checkbox" id="vmxIsNdiAudio"${sel.ndiAudioOnly ? ' checked' : ''}/> Audio Only</label>` +
              `</div>`;
          }
          return `<div class="vmx-is-hint">Add a network (NDI) video or audio source.</div>` +
            `<div class="vmx-is-content">` + tabs + body + `</div>`;
        }
        // Local Desktop Capture tab
        return `<div class="vmx-is-hint">Select a screen or window to capture.</div>` +
          `<div class="vmx-is-content">` + tabs +
          (sel.screens == null ? `<p class="vmx-note">Looking for screens…</p>` :
            !sel.screens.length ? `<div class="vmx-is-empty"><div class="vmx-is-empty-ic">🖥</div><p>Click OK and choose a screen or window to capture.</p></div>` :
            `<div class="vmx-is-photo-grid">` + sel.screens.map((s) => `<div class="vmx-is-photo-tile${sel.screenId === s.id ? ' sel' : ''}" data-s="${esc(s.id)}"><img src="${s.thumb}" /><div>${esc(s.name)}</div></div>`).join('') + `</div>`) +
          `</div>`;
      }
      if (cat.id === 'title') {
        return `<div class="vmx-is-hint">Set up a title / lower third.</div>` +
          `<div class="vmx-is-content"><div class="vmx-form">` +
          `<label>Headline<input type="text" id="vmxIsTHead" value="${esc(sel.title.headline)}" /></label>` +
          `<label>Second line (optional)<input type="text" id="vmxIsTSub" value="${esc(sel.title.subtext)}" /></label>` +
          `<label>Style<select id="vmxIsTStyle">` +
            `<option value="lower"${sel.title.style !== 'full' ? ' selected' : ''}>Lower third (bar at the bottom)</option>` +
            `<option value="full"${sel.title.style === 'full' ? ' selected' : ''}>Fullscreen slate</option>` +
          `</select></label>` +
          `<label>Text colour<input type="color" id="vmxIsTColor" value="${esc(sel.title.color)}" /></label>` +
          `</div>` +
          `<div class="vmx-is-title-preview"><div class="vmx-is-title-bar${sel.title.style === 'full' ? ' full' : ''}" style="color:${esc(sel.title.color)}"><b>${esc(sel.title.headline) || 'Headline'}</b>${sel.title.subtext ? `<span>${esc(sel.title.subtext)}</span>` : ''}</div></div>` +
          `</div>`;
      }
      if (cat.id === 'audiofile') {
        return `<div class="vmx-is-hint">Select the Audio file to open.</div>` +
          `<div class="vmx-is-content">` +
          `<div class="vmx-is-browse-row"><input type="text" id="vmxIsPath" readonly value="${esc(sel.path)}" placeholder="No file selected" /><button class="vmx-btn" id="vmxIsBrowse">Browse…</button></div>` +
          `<div class="vmx-is-preview">${sel.path ? `<audio controls src="${fileUrl(sel.path)}" style="width:92%"></audio>` : `<div class="vmx-is-preview-empty">No file selected</div>`}</div>` +
          `</div>`;
      }
      if (cat.id === 'list' || cat.id === 'stinger') {
        const imagesOnly = cat.id === 'stinger';
        return `<div class="vmx-is-hint">${imagesOnly ? 'Add images to play as a timed sequence.' : 'Add videos and/or images — they play in order as one input.'}</div>` +
          `<div class="vmx-is-content">` +
          `<div class="vmx-is-browse-row"><input type="text" readonly value="${sel.listItems.length} file(s) added" /><button class="vmx-btn" id="vmxIsBrowse">Add files…</button></div>` +
          `<div class="vmx-is-devlist" style="max-height:220px">` +
          sel.listItems.map((it, i) => `<div class="vmx-is-dev"><span>${i + 1}. ${it.kind === 'video' ? '🎬' : '🖼'} ${esc(it.name)}</span><button class="vmx-btn" data-rm="${i}" style="margin-left:auto">✕</button></div>`).join('') +
          (!sel.listItems.length ? `<p class="vmx-note">No files added yet.</p>` : '') +
          `</div>` +
          `<label>Seconds per image<input type="number" id="vmxIsListSec" min="1" max="60" value="${sel.listImgSec}" style="width:90px" /></label>` +
          (!imagesOnly ? `<p class="vmx-note">For a transparent video stinger transition, add it as a Video input instead and place it on an overlay channel (1-4).</p>` : '') +
          `</div>`;
      }
      if (cat.id === 'delay') {
        const candidates = st.inputs.filter((i) => i.type !== 'delay');
        if (!candidates.length) {
          return `<div class="vmx-is-hint">Video Delay</div><div class="vmx-is-empty"><div class="vmx-is-empty-ic">⏱</div><p>Add a camera or other input first, then come back to delay a copy of it.</p></div>`;
        }
        return `<div class="vmx-is-hint">Delay a copy of another input by a few seconds.</div>` +
          `<div class="vmx-is-content"><div class="vmx-form">` +
          `<label>Source input<select id="vmxIsDelaySrc">` +
            candidates.map((c) => `<option value="${c.id}"${sel.delaySrc === c.id ? ' selected' : ''}>${c.num}. ${esc(c.name)}</option>`).join('') +
          `</select></label>` +
          `<label>Delay (seconds)<input type="number" id="vmxIsDelaySec" min="0.5" max="15" step="0.5" value="${sel.delaySec}" /></label>` +
          `</div>` +
          `<p class="vmx-note">Video is buffered in memory (up to ~15s); audio is delayed with the browser's native audio engine.</p>` +
          `</div>`;
      }
      if (cat.id === 'replay') {
        const buffered = st.replayArmed ? Math.max(0, (Date.now() - st.replayStartedAt) / 1000) : 0;
        return `<div class="vmx-is-hint">Instant Replay buffers the program in the background — OK grabs everything since it was armed as a new Video input.</div>` +
          `<div class="vmx-is-empty"><div class="vmx-is-empty-ic">⏮</div>` +
          (st.replayArmed ? `<p>Buffering… ${buffered.toFixed(0)}s ready to take.</p>` : `<p>Arming the buffer for the first time — this takes a second…</p>`) +
          `</div>`;
      }
      if (cat.id === 'srt') {
        return `<div class="vmx-is-hint">Pull a network video source (RTMP, RTSP, SRT, HTTP, UDP).</div>` +
          `<div class="vmx-is-content"><div class="vmx-form">` +
          `<label>Stream URL<input type="text" id="vmxIsSrtUrl" value="${esc(sel.srtUrl)}" placeholder="rtmp://, rtsp://, srt://, http(s)://, udp://" /></label>` +
          `</div>` +
          `<p class="vmx-note">Video only for now — audio from a network source isn't mixed in yet.</p>` +
          `</div>`;
      }
      if (cat.id === 'web') {
        return `<div class="vmx-is-hint">Show a live web page as an input.</div>` +
          `<div class="vmx-is-content"><div class="vmx-is-browse-row">` +
          `<input type="text" id="vmxIsWebUrl" value="${esc(sel.webUrl)}" placeholder="https://…" />` +
          `</div>` +
          `<p class="vmx-note">Video only — a page's own audio plays through your speakers directly and isn't mixed into the recording/stream.</p>` +
          `</div>`;
      }
      if (cat.id === 'call') {
        return `<div class="vmx-is-hint">Bring a remote guest in over a video call.</div>` +
          `<div class="vmx-is-content"><div class="vmx-form">` +
          `<label>Meeting link (Jitsi Meet works with no account — edit to use Zoom/Meet/Teams' web client instead)<input type="text" id="vmxIsCallUrl" value="${esc(sel.callUrl)}" /></label>` +
          `</div>` +
          `<div class="vmx-form-btns" style="justify-content:flex-start;padding:0 14px"><button class="vmx-btn" id="vmxIsCallCopy">📋 Copy invite link</button></div>` +
          `<p class="vmx-note">Send the link to your guest so they can join from a browser. Their video appears on this input; for now their audio plays through your speakers directly rather than being mixed into the recording/stream.</p>` +
          `</div>`;
      }
      if (cat.id === 'ppt') {
        if (!sel.pptChecked) return `<div class="vmx-is-hint">PowerPoint</div><div class="vmx-is-content"><p class="vmx-note">Checking for LibreOffice…</p></div>`;
        if (!sel.pptAvailable) {
          return `<div class="vmx-is-hint">PowerPoint</div><div class="vmx-is-empty"><div class="vmx-is-empty-ic">📊</div>` +
            `<p>LibreOffice isn't installed.</p>` +
            `<p class="vmx-is-empty-note">Install it free from libreoffice.org, then reopen this dialog — it converts your slides to a PDF and pages through them live.</p></div>`;
        }
        return `<div class="vmx-is-hint">Select the PowerPoint file to open.</div>` +
          `<div class="vmx-is-content">` +
          `<div class="vmx-is-browse-row"><input type="text" readonly value="${esc(sel.pptName || sel.pptPath)}" placeholder="No file selected" /><button class="vmx-btn" id="vmxIsBrowse"${sel.pptConverting ? ' disabled' : ''}>Browse…</button></div>` +
          (sel.pptConverting ? `<p class="vmx-note">Converting with LibreOffice…</p>` : '') +
          `<p class="vmx-note">Once added, use the Slide ◀ / ▶ buttons on its input tile to page through the deck live.</p>` +
          `</div>`;
      }
      return '';
    }

    function okEnabled(cat) {
      switch (cat.id) {
        case 'video': case 'image': case 'audiofile': return !!sel.path;
        case 'photos': return !!sel.photo;
        case 'camera': return !!(sel.cams && sel.cams.length);
        case 'mic': return !!(sel.mics && sel.mics.length);
        case 'list': case 'stinger': return sel.listItems.length > 0;
        case 'delay': return st.inputs.filter((i) => i.type !== 'delay').length > 0;
        case 'replay': return !!st.replayArmed;
        case 'srt': return sel.srtUrl.trim().length > 0;
        case 'web': return /^(https?|file):\/\//i.test(sel.webUrl.trim());
        case 'call': return sel.callUrl.trim().length > 0;
        case 'ppt': return sel.pptAvailable && !!sel.pptPdfPath && !sel.pptConverting;
        case 'desktop': return sel.desktopTab === 'ndi' ? !!sel.ndiSourceName : true;
        // a scene is optional — keying a camera onto black is still a valid set
        case 'vset': return st.inputs.some((i) => hasVisual(i) && i.type !== 'vset');
        case 'color': case 'title': return true;
        default: return false;
      }
    }

    function render() {
      const cat = INPUT_CATS.find((c) => c.id === sel.cat);
      const ok = okEnabled(cat);
      refs.vmxModalBox.innerHTML =
        `<div class="vmx-is-head"><span class="vmx-is-head-icon">🎛️</span> Input Select<span class="vmx-modal-x">✕</span></div>` +
        `<div class="vmx-is-body">` +
        `<div class="vmx-is-side">` +
        INPUT_CATS.map((c) => `<button class="vmx-is-cat${c.id === sel.cat ? ' sel' : ''}" data-cat="${c.id}"><span class="vmx-is-cat-ic">${c.icon}</span>${esc(c.label)}</button>`).join('') +
        `</div>` +
        `<div class="vmx-is-main">${panelHtml(cat)}</div>` +
        `</div>` +
        `<div class="vmx-is-foot">` +
        `<span class="vmx-is-foot-note">${cat.supported ? `Will be added as input #${st.inputs.length + 1}.` : 'Not available in this app.'}</span>` +
        `<button class="vmx-btn" id="vmxIsCancel">Cancel</button>` +
        `<button class="vmx-btn" id="vmxIsOk"${ok ? '' : ' disabled'}>OK</button>` +
        `</div>`;
      wire(cat);
    }

    function wire(cat) {
      const box = refs.vmxModalBox;
      box.querySelector('.vmx-modal-x').onclick = closeThis;
      box.querySelector('#vmxIsCancel').onclick = closeThis;
      box.querySelectorAll('.vmx-is-cat').forEach((b) => { b.onclick = () => selectCat(b.dataset.cat); });
      box.querySelector('#vmxIsOk').onclick = doOk;

      if (cat.id === 'video' || cat.id === 'image' || cat.id === 'audiofile') {
        box.querySelector('#vmxIsBrowse').onclick = async () => {
          const p = await window.api.dialog.openFile(cat.id === 'video'
            ? [{ name: 'Videos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'] }]
            : cat.id === 'image'
            ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            : [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]);
          if (p) { sel.path = p; sel.name = String(p).split(/[\\/]/).pop(); render(); }
        };
      } else if (cat.id === 'list' || cat.id === 'stinger') {
        const imagesOnly = cat.id === 'stinger';
        box.querySelector('#vmxIsBrowse').onclick = async () => {
          const filters = imagesOnly
            ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }]
            : [{ name: 'Videos & Images', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }];
          const paths = await window.api.dialog.openFile(filters, true);
          if (paths && paths.length) {
            const imgExt = /\.(png|jpe?g|gif|webp|bmp)$/i;
            paths.forEach((p) => sel.listItems.push({ kind: imgExt.test(p) ? 'image' : 'video', path: p, name: String(p).split(/[\\/]/).pop() }));
            render();
          }
        };
        box.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { sel.listItems.splice(Number(b.dataset.rm), 1); render(); }; });
        const secEl = box.querySelector('#vmxIsListSec');
        if (secEl) secEl.oninput = (e) => { sel.listImgSec = Math.max(1, Number(e.target.value) || 4); };
      } else if (cat.id === 'delay') {
        const srcEl = box.querySelector('#vmxIsDelaySrc');
        if (srcEl) srcEl.onchange = (e) => { sel.delaySrc = Number(e.target.value); };
        const secEl = box.querySelector('#vmxIsDelaySec');
        if (secEl) secEl.oninput = (e) => { sel.delaySec = clamp(Number(e.target.value) || 5, 0.5, 15); };
      } else if (cat.id === 'srt') {
        // update the OK button directly instead of a full render() — re-rendering the
        // whole dialog on every keystroke would rebuild this input and steal focus
        box.querySelector('#vmxIsSrtUrl').oninput = (e) => { sel.srtUrl = e.target.value; box.querySelector('#vmxIsOk').disabled = !okEnabled(cat); };
      } else if (cat.id === 'web') {
        box.querySelector('#vmxIsWebUrl').oninput = (e) => { sel.webUrl = e.target.value; box.querySelector('#vmxIsOk').disabled = !okEnabled(cat); };
      } else if (cat.id === 'call') {
        box.querySelector('#vmxIsCallUrl').oninput = (e) => { sel.callUrl = e.target.value; };
        box.querySelector('#vmxIsCallCopy').onclick = async () => {
          try { await navigator.clipboard.writeText(box.querySelector('#vmxIsCallUrl').value); toast('📋 Invite link copied.', 'good'); }
          catch (e) { toast('⚠️ Could not copy — select and copy the link manually.', 'error'); }
        };
      } else if (cat.id === 'ppt' && sel.pptAvailable) {
        const b = box.querySelector('#vmxIsBrowse');
        if (b) b.onclick = async () => {
          const p = await window.api.dialog.openFile([{ name: 'PowerPoint', extensions: ['pptx', 'ppt'] }]);
          if (!p) return;
          sel.pptPath = p; sel.pptName = String(p).split(/[\\/]/).pop(); sel.pptConverting = true;
          render();
          try {
            const res = await window.api.ppt.convert(p);
            sel.pptPdfPath = res.pdfPath;
          } catch (e) { toast('⚠️ ' + (e.message || e), 'error'); sel.pptPath = ''; sel.pptName = ''; }
          sel.pptConverting = false;
          render();
        };
      } else if (cat.id === 'photos') {
        box.querySelectorAll('.vmx-is-photo-tile[data-p]').forEach((t) => {
          t.onclick = () => { sel.photo = sel.photos.find((p) => p.path === t.dataset.p) || null; render(); };
        });
      } else if (cat.id === 'vset') {
        const q = (s) => box.querySelector(s);
        const nm = q('#vmxVsName'); if (nm) nm.oninput = (e) => { sel.vsName = e.target.value; };
        const sr = q('#vmxVsSrc'); if (sr) sr.onchange = (e) => { sel.vsSourceId = Number(e.target.value); };
        const setImg = (which) => async () => {
          const p = await window.api.dialog.openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]);
          if (!p) return;
          if (which === 'bg') sel.vsBgPath = p; else sel.vsFgPath = p;
          const img = new Image();
          img.onload = () => {
            if (!sel.vsSurface) return;
            if (which === 'bg') sel.vsSurface.setBackground(img); else sel.vsSurface.setForeground(img);
          };
          img.src = fileUrl(p);
          render();
        };
        const bgb = q('#vmxVsBgPick'); if (bgb) bgb.onclick = setImg('bg');
        const fgb = q('#vmxVsFgPick'); if (fgb) fgb.onclick = setImg('fg');
        box.querySelectorAll('.vmx-vs-shot[data-shot]').forEach((b) => {
          b.onclick = () => { sel.vsShot = Number(b.dataset.shot); render(); };
        });
        const ko = q('#vmxVsKeyOn'); if (ko) ko.onchange = (e) => { sel.vsKey.on = e.target.checked; };
        const kc = q('#vmxVsKeyCol'); if (kc) kc.oninput = (e) => { sel.vsKey.color = e.target.value; };
        const bindRange = (id, field, div) => {
          const el = q(id);
          if (el) el.oninput = (e) => {
            sel.vsKey[field] = Number(e.target.value) / div;
            const lab = el.parentElement && el.parentElement.querySelector('.vmx-dim');
            if (lab) lab.textContent = Math.round(sel.vsKey[field] * 100) + '%';
          };
        };
        bindRange('#vmxVsTol', 'tolerance', 100);
        bindRange('#vmxVsSoft', 'softness', 100);
        bindRange('#vmxVsSpill', 'spill', 100);
        const pick = q('#vmxVsPick');
        if (pick) pick.onclick = () => {
          const src = inputById(sel.vsSourceId);
          const c = src && window.VirtualSet.sampleKeyColour(drawSourceOf(src));
          if (!c) { toast('⚠️ No picture to read the colour from yet.', 'error'); return; }
          sel.vsKey.color = c;
          render();
          toast('Screen colour read from the shot: ' + c);
        };
        /* Framing by hand: drag the picture to move the camera, scroll to zoom.
         * This edits the SHOT that is selected, which is what makes the four
         * buttons a set of camera positions rather than four copies. */
        const cv = q('#vmxVsPrev');
        if (cv) {
          cv.onmousedown = (e) => {
            const p = sel.vsPresets[sel.vsShot];
            sel.vsDrag = { x: e.clientX, y: e.clientY, px: p.x, py: p.y };
            e.preventDefault();
          };
          window.addEventListener('mousemove', onVsDrag);
          window.addEventListener('mouseup', endVsDrag);
          cv.onwheel = (e) => {
            e.preventDefault();
            const p = sel.vsPresets[sel.vsShot];
            p.scale = clamp(p.scale * (e.deltaY < 0 ? 1.06 : 1 / 1.06), 0.1, 4);
          };
        }
      } else if (cat.id === 'color') {
        box.querySelector('#vmxIsColName').oninput = (e) => { sel.colorName = e.target.value; };
        box.querySelector('#vmxIsColVal').oninput = (e) => {
          sel.color = e.target.value;
          const p = box.querySelector('.vmx-is-preview');
          if (p) p.style.background = sel.color;
        };
      } else if (cat.id === 'camera') {
        const cs = box.querySelector('#vmxIsCamSel');
        if (cs) cs.onchange = () => { const d = sel.cams.find((c) => c.deviceId === cs.value); if (d) pickCam(d); };
        // Resolution / Frame Rate / Video Format apply to the live preview
        // immediately — the "Camera is delivering…" line shows the result.
        const bindCamOpt = (id, set) => {
          const el = box.querySelector(id);
          if (el) el.onchange = () => { set(el.value); applyCamSel(); };
        };
        bindCamOpt('#vmxIsCamRes', (v) => { sel.camRes = v; });
        bindCamOpt('#vmxIsCamFps', (v) => { sel.camFps = v; });
        bindCamOpt('#vmxIsCamFmt', (v) => { sel.camFormat = v; });
        const au = box.querySelector('#vmxIsCamAud');
        if (au) au.onchange = () => { sel.camAudioId = au.value; };
        const v = box.querySelector('#vmxIsCamPrev');
        if (v && sel.previewStream) v.srcObject = sel.previewStream;
      } else if (cat.id === 'mic') {
        const ms = box.querySelector('#vmxIsMicSel');
        if (ms) ms.onchange = () => { const d = sel.mics.find((m) => m.deviceId === ms.value); if (d) { sel.micId = d.deviceId; sel.micLabel = d.label || 'Microphone'; render(); } };
      } else if (cat.id === 'desktop') {
        box.querySelectorAll('.vmx-is-ndi-tab[data-dtab]').forEach((b) => {
          b.onclick = () => {
            if (sel.desktopTab === b.dataset.dtab) return;
            sel.desktopTab = b.dataset.dtab;
            if (sel.desktopTab !== 'ndi') stopNdiPreview();
            render();
          };
        });
        box.querySelectorAll('.vmx-is-ndi-tile[data-ndi]').forEach((t) => {
          t.onclick = () => {
            const s = sel.ndiSources[Number(t.dataset.ndi)];
            if (!s) return;
            sel.ndiSourceName = s.name;
            render();
            startNdiPreview(s); // live preview of the selected source
          };
        });
        const lb = box.querySelector('#vmxIsNdiLowBw');
        if (lb) lb.onchange = (e) => { sel.ndiLowBw = e.target.checked; };
        const ao = box.querySelector('#vmxIsNdiAudio');
        if (ao) ao.onchange = (e) => { sel.ndiAudioOnly = e.target.checked; };
        box.querySelectorAll('.vmx-is-photo-tile[data-s]').forEach((t) => {
          t.onclick = () => { sel.screenId = t.dataset.s; render(); };
        });
      } else if (cat.id === 'title') {
        // patch the live preview directly on every keystroke — a full render()
        // would rebuild the text inputs mid-type and steal focus
        const patchPreview = () => {
          const bar = box.querySelector('.vmx-is-title-bar');
          if (!bar) return;
          bar.classList.toggle('full', sel.title.style === 'full');
          bar.style.color = sel.title.color;
          bar.querySelector('b').textContent = sel.title.headline || 'Headline';
          let span = bar.querySelector('span');
          if (sel.title.subtext) {
            if (!span) { span = document.createElement('span'); bar.appendChild(span); }
            span.textContent = sel.title.subtext;
          } else if (span) { span.remove(); }
        };
        box.querySelector('#vmxIsTHead').oninput = (e) => { sel.title.headline = e.target.value; patchPreview(); };
        box.querySelector('#vmxIsTSub').oninput = (e) => { sel.title.subtext = e.target.value; patchPreview(); };
        box.querySelector('#vmxIsTColor').oninput = (e) => { sel.title.color = e.target.value; patchPreview(); };
        box.querySelector('#vmxIsTStyle').onchange = (e) => { sel.title.style = e.target.value; render(); };
      }
    }

    async function doOk() {
      try {
        if (sel.cat === 'video') { addVideoFile(sel.path, sel.name); closeThis(); }
        else if (sel.cat === 'image') { await addImageFile(sel.path, sel.name); closeThis(); }
        else if (sel.cat === 'photos') { if (sel.photo) { await addImageFile(sel.photo.path, sel.photo.name); closeThis(); } }
        else if (sel.cat === 'color') { addColor(sel.colorName || 'Colour', sel.color); closeThis(); }
        else if (sel.cat === 'vset') {
          const cfg = {
            name: sel.vsName || 'Virtual Set', sourceId: sel.vsSourceId,
            bgPath: sel.vsBgPath, fgPath: sel.vsFgPath,
            presets: sel.vsPresets.map((p) => ({ ...p })),
            key: Object.assign({}, sel.vsKey),
          };
          closeThis();
          await addVirtualSet(cfg);
        }
        else if (sel.cat === 'camera') {
          const id = sel.camId, label = sel.camLabel;
          const m = /^(\d+)x(\d+)$/.exec(sel.camRes || '');
          const cfg = { width: m ? Number(m[1]) : 0, height: m ? Number(m[2]) : 0,
                        fps: sel.camFps, resizeMode: sel.camFormat, audioId: sel.camAudioId };
          stopPreview(); closeThis();
          await addCamera(id, label, cfg);
        }
        else if (sel.cat === 'mic') { const id = sel.micId, label = sel.micLabel; closeThis(); await addMic(id, label); }
        else if (sel.cat === 'desktop') {
          if (sel.desktopTab === 'ndi') {
            const source = (sel.ndiSources || []).find((s) => s.name === sel.ndiSourceName);
            const audioOnly = sel.ndiAudioOnly, lowBandwidth = sel.ndiLowBw;
            closeThis();
            if (source) addNdiInput(source, { audioOnly, lowBandwidth });
          } else {
            const sid = sel.screenId; closeThis();
            if (sid) await window.api.live.pickScreen(sid);
            await addScreen();
          }
        } else if (sel.cat === 'title') { addTitle(Object.assign({}, sel.title)); closeThis(); }
        else if (sel.cat === 'audiofile') { addAudioFile(sel.path, sel.name); closeThis(); }
        else if (sel.cat === 'list' || sel.cat === 'stinger') {
          addListInput(sel.listItems.map((it) => ({ ...it, durationSec: sel.listImgSec })), sel.cat === 'stinger' ? 'Image Sequence' : 'List');
          closeThis();
        } else if (sel.cat === 'delay') {
          const src = inputById(sel.delaySrc) || st.inputs[0];
          if (src) addDelayInput(src, sel.delaySec);
          closeThis();
        } else if (sel.cat === 'replay') {
          const file = await takeInstantReplay();
          closeThis();
          if (file) addVideoFile(file, 'Instant Replay');
        } else if (sel.cat === 'srt') {
          addNetStreamInput(sel.srtUrl.trim(), 'Network Stream');
          closeThis();
        } else if (sel.cat === 'web') {
          addBrowserInput(sel.webUrl.trim(), 'Web Browser', { type: 'web' });
          closeThis();
        } else if (sel.cat === 'call') {
          addBrowserInput(sel.callUrl.trim(), 'Video Call', { type: 'call' });
          closeThis();
        } else if (sel.cat === 'ppt') {
          addBrowserInput(fileUrl(sel.pptPdfPath) + '#page=1', sel.pptName || 'PowerPoint', { type: 'ppt', pdfPath: sel.pptPdfPath });
          closeThis();
        }
      } catch (e) { toast('⚠️ ' + (e.message || e.name || e), 'error'); }
    }

    refs.vmxModalBox.className = 'vmx-modal-box vmx-inputsel';
    refs.vmxModal.classList.remove('hidden');
    render();
  }

  function openTitleEditor(inp) {
    const t = inp.title;
    openModal(
      `<h3>🔤 Title — edit <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<label>Headline<input type="text" id="vmxTHead" value="${esc(t.headline)}" /></label>` +
      `<label>Second line (optional)<input type="text" id="vmxTSub" value="${esc(t.subtext)}" /></label>` +
      `<label>Style<select id="vmxTStyle">` +
        `<option value="lower"${t.style !== 'full' ? ' selected' : ''}>Lower third (bar at the bottom)</option>` +
        `<option value="full"${t.style === 'full' ? ' selected' : ''}>Fullscreen slate</option>` +
      `</select></label>` +
      `<label>Text colour<input type="color" id="vmxTColor" value="${esc(t.color || '#ffffff')}" /></label>` +
      `</div>` +
      `<p class="vmx-note">Tip: put the title on <b>overlay channel 1</b> (the “1” button on its input) to show it on top of the program.</p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxTOk">Save</button></div>`);
    refs.vmxModalBox.querySelector('#vmxTOk').onclick = () => {
      Object.assign(inp.title, {
        headline: refs.vmxModalBox.querySelector('#vmxTHead').value.trim() || 'Title',
        subtext: refs.vmxModalBox.querySelector('#vmxTSub').value.trim(),
        style: refs.vmxModalBox.querySelector('#vmxTStyle').value,
        color: refs.vmxModalBox.querySelector('#vmxTColor').value,
      });
      renderTitle(inp); renderInputs();
      closeModal();
    };
  }

  /* ------- per-input settings ------- */

  function openInputSettings(inp) {
    openModal(
      `<h3>⚙ Input ${inp.num} — ${esc(inp.name)} <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<label>Name<input type="text" id="vmxInName" value="${esc(inp.name)}" /></label>` +
      `<label>Volume (${Math.round(inp.volume * 100)}%)<input type="range" id="vmxInVol" min="0" max="1.5" step="0.05" value="${inp.volume}" /></label>` +
      `<label>A/V sync offset (ms)<input type="number" id="vmxInSync" min="-500" max="500" step="5" value="${Number(inp.syncMs) || 0}" /></label>` +
      `<button class="vmx-btn" type="button" id="vmxInClap">👏 Clap sync — measure it for me</button>` +
      `<p class="vmx-note">🔊 Use this when the sound and the picture of this input do not line up. <b>Positive</b> delays the SOUND (use it when you hear it before you see it); <b>negative</b> delays the PICTURE (use it when the picture runs ahead of the sound). ` +
      `Rather than guessing the number, press <b>Clap sync</b> and clap once in front of a camera — it works the gap out and sets it. ${syncNoteFor(inp)}</p>` +
      (inp.type === 'title' ? `<button class="vmx-btn" id="vmxInTitleEdit">Edit title text…</button>` : '') +
      (inp.type === 'color' ? `<label>Colour<input type="color" id="vmxInColor" value="${esc(inp.color)}" /></label>` : '') +
      `</div>` +
      (hasVisual(inp) ? colourAdjustHtml(inp) : '') +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxInOk">Save</button></div>`);
    const box = refs.vmxModalBox;
    const te = box.querySelector('#vmxInTitleEdit');
    if (te) te.onclick = () => { closeModal(); openTitleEditor(inp); };
    const clap = box.querySelector('#vmxInClap');
    if (clap) clap.onclick = () => { closeModal(); openClapSync(inp); };
    if (hasVisual(inp)) wireColourAdjust(box, inp);
    box.querySelector('#vmxInOk').onclick = () => {
      inp.name = box.querySelector('#vmxInName').value.trim() || inp.name;
      inp.volume = parseFloat(box.querySelector('#vmxInVol').value);
      const sy = box.querySelector('#vmxInSync');
      if (sy) setInputSyncMs(inp, sy.value);
      const col = box.querySelector('#vmxInColor');
      if (col && inp.type === 'color') {
        inp.color = col.value;
        const c = inp.el.getContext('2d');
        c.fillStyle = inp.color; c.fillRect(0, 0, inp.el.width, inp.el.height);
      }
      renderInputs();
      closeModal();
    };
  }

  /* ========================== clap sync ==============================
   *
   * The automatic A/V correction works by differencing the video and audio
   * timestamps of ONE NDI sender. That is exactly the case a church running its
   * sound through an audio-only NDI feed (Ableton's NDI Output, a desk send)
   * does NOT have: the picture comes from a camera on this machine and the sound
   * from a different machine entirely, and their clocks share no epoch, so there
   * is nothing honest to measure across them. Which left the operator typing
   * numbers into a box, saving, listening, and going round again.
   *
   * So: clap once in front of the camera. We watch for the transient in the
   * sound and the motion spike in the picture, on ONE clock — the renderer's —
   * and the gap between them is the answer.
   *
   * Both signals are sampled AFTER any correction already in place, so what is
   * measured is the RESIDUAL. Clapping again after a correction should read
   * ~0 and change nothing, which makes this a check as well as a fix.
   */
  const CLAP = {
    windowMs: 12000,     // how long we listen before giving up
    settleMs: 400,       // ignore the first moment (the button click itself)
    maxSkewMs: 700,      // beyond this it is not a clap we matched, it is noise
    minAudioRise: 2.2,   // how far above its own baseline a real clap gets
    minVideoRise: 2.2,
  };

  /**
   * Listen for a clap on `cam` (picture) and `aud` (sound).
   * Resolves { skewMs, audioAt, videoAt, ... } or { error }.
   *
   * skewMs > 0  the sound arrived AFTER the picture — the sound is late.
   * skewMs < 0  the picture arrived after the sound — the picture is late.
   */
  function listenForClap(cam, aud, onTick) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const cv = document.createElement('canvas');
      cv.width = 64; cv.height = 36;
      const c2 = cv.getContext('2d', { willReadFrequently: true });
      let prev = null;
      const vs = [], as = [];       // {t, v} motion / level samples
      let raf = 0, done = false;

      const finish = (res) => {
        if (done) return;
        done = true;
        if (raf) cancelAnimationFrame(raf);
        resolve(res);
      };

      const step = () => {
        raf = requestAnimationFrame(step);
        const t = performance.now();
        // picture: mean absolute frame-to-frame change, on the SAME picture the
        // operator is watching (delays included)
        try {
          const el = drawSourceOf(cam);
          c2.drawImage(el, 0, 0, cv.width, cv.height);
          const px = c2.getImageData(0, 0, cv.width, cv.height).data;
          if (prev) {
            let sum = 0;
            for (let i = 0; i < px.length; i += 4) sum += Math.abs(px[i] - prev[i]);
            vs.push({ t, v: sum / (px.length / 4) });
          }
          prev = px;
        } catch (e) { /* source not ready this frame */ }
        // sound: the input's own meter, after its delay line
        if (aud && aud.meter && aud.meterData) as.push({ t, v: rms(aud.meter, aud.meterData) });

        if (onTick && vs.length) {
          onTick({
            elapsed: t - t0,
            level: as.length ? as[as.length - 1].v : 0,
            motion: vs[vs.length - 1].v,
          });
        }
        if (t - t0 > CLAP.windowMs) {
          const r = solveClap(vs, as, t0);
          finish(r.error ? r : r);
        }
      };
      raf = requestAnimationFrame(step);
    });
  }

  /**
   * Find the clap in the two sample series and return the gap between them.
   *
   * The peak is taken relative to each signal's OWN baseline (its median), so a
   * noisy room or a busy camera shot doesn't move the answer — what matters is
   * the sharpest departure from normal, not the loudest absolute value.
   */
  function solveClap(vs, as, t0) {
    const usable = (arr) => arr.filter((s) => s.t - t0 > CLAP.settleMs);
    const V = usable(vs), A = usable(as);
    if (V.length < 20) return { error: 'No picture to watch — put a camera on the program first.' };
    if (A.length < 20) return { error: 'No sound to listen to — check the audio source is live on the mixer.' };
    const median = (arr) => {
      const s = arr.map((x) => x.v).sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)] || 0;
    };
    const peak = (arr, base, minRise) => {
      let best = null;
      for (const s of arr) if (!best || s.v > best.v) best = s;
      if (!best) return null;
      const floor = Math.max(base, 1e-4);
      return best.v >= floor * minRise ? best : null;
    };
    const vPeak = peak(V, median(V), CLAP.minVideoRise);
    const aPeak = peak(A, median(A), CLAP.minAudioRise);
    if (!aPeak) return { error: 'I didn’t hear a clap. Clap once, sharply, close to the microphone — and check the sound source is not muted.' };
    if (!vPeak) return { error: 'I didn’t see the clap. Make sure your hands are in shot and well lit, then try again.' };
    const skewMs = Math.round(aPeak.t - vPeak.t);
    if (Math.abs(skewMs) > CLAP.maxSkewMs) {
      return { error: `What I heard and what I saw were ${Math.abs(skewMs)} ms apart, which is too far to be the same clap. Try again with one sharp clap in front of the camera.` };
    }
    return {
      skewMs,
      audioAt: Math.round(aPeak.t - t0), videoAt: Math.round(vPeak.t - t0),
      samples: { v: V.length, a: A.length },
    };
  }

  /**
   * Turn a measured skew into an offset on the right input.
   *
   * Sound late  → hold the PICTURE back (negative offset on the camera).
   * Sound early → hold the SOUND back (positive offset on the audio source).
   * The measurement is a residual, so it is ADDED to whatever is already set.
   */
  function applyClapResult(cam, aud, skewMs) {
    if (skewMs > 0) {
      const next = (Number(cam.syncMs) || 0) - skewMs;
      setInputSyncMs(cam, next);
      return { input: cam, ms: next, what: `holding ${cam.name}’s picture back by ${Math.abs(Math.round(next))} ms` };
    }
    const next = (Number(aud.syncMs) || 0) + Math.abs(skewMs);
    setInputSyncMs(aud, next);
    return { input: aud, ms: next, what: `holding ${aud.name}’s sound back by ${Math.round(next)} ms` };
  }

  /** Inputs that can supply a picture / a sound for the measurement. */
  const clapCameras = () => st.inputs.filter((i) => hasVisual(i));
  const clapAudios = () => st.inputs.filter((i) => i.meter);

  function openClapSync(preferInput) {
    const cams = clapCameras(), auds = clapAudios();
    if (!cams.length || !auds.length) {
      return toast('👏 Clap sync needs one input with a picture and one with sound.', 'error');
    }
    const pickCam = (preferInput && hasVisual(preferInput) ? preferInput : inputById(st.programId)) || cams[0];
    // Default the sound to an audio-only source if there is one — that is the
    // setup this exists for (a desk or Ableton feed arriving over NDI).
    const pickAud = (preferInput && preferInput.meter && !hasVisual(preferInput) ? preferInput : null)
      || auds.find((i) => !hasVisual(i)) || (preferInput && preferInput.meter ? preferInput : auds[0]);
    const opt = (list, sel) => list.map((i) =>
      `<option value="${i.id}"${i.id === (sel && sel.id) ? ' selected' : ''}>${esc(i.num + ' — ' + i.name)}</option>`).join('');
    openModal(
      `<h3>👏 Clap sync <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<label>Picture from<select id="vmxClapCam">${opt(cams, pickCam)}</select></label>` +
      `<label>Sound from<select id="vmxClapAud">${opt(auds, pickAud)}</select></label>` +
      `</div>` +
      `<p class="vmx-note">Stand where the camera can see your hands, press <b>Start listening</b>, and <b>clap once, sharply</b>. ` +
      `I watch for the movement in the picture and listen for the crack in the sound, and set the delay to whatever the gap turns out to be. ` +
      `It measures what is left AFTER any correction already in place — so clapping a second time is how you check it worked.</p>` +
      `<div id="vmxClapMeters" class="vmx-clap-meters hidden">` +
        `<div class="vmx-clap-row"><span>Sound</span><div class="vmx-clap-bar"><i id="vmxClapA"></i></div></div>` +
        `<div class="vmx-clap-row"><span>Movement</span><div class="vmx-clap-bar"><i id="vmxClapV"></i></div></div>` +
        `<p class="vmx-clap-hint" id="vmxClapHint">Listening… clap now.</p>` +
      `</div>` +
      `<p class="vmx-note" id="vmxClapResult"></p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxClapGo">Start listening</button></div>`);
    const box = refs.vmxModalBox;
    const go = box.querySelector('#vmxClapGo');
    const result = box.querySelector('#vmxClapResult');
    let undo = null;
    go.onclick = async () => {
      if (undo) { // second press = accept and close
        closeModal();
        return;
      }
      const cam = inputById(box.querySelector('#vmxClapCam').value);
      const aud = inputById(box.querySelector('#vmxClapAud').value);
      if (!cam || !aud) return;
      go.disabled = true;
      go.textContent = 'Listening…';
      box.querySelector('#vmxClapMeters').classList.remove('hidden');
      result.textContent = '';
      const bA = box.querySelector('#vmxClapA'), bV = box.querySelector('#vmxClapV');
      const hint = box.querySelector('#vmxClapHint');
      const r = await listenForClap(cam, aud, ({ elapsed, level, motion }) => {
        if (bA) bA.style.width = Math.min(100, level * 300) + '%';
        if (bV) bV.style.width = Math.min(100, motion * 4) + '%';
        if (hint) hint.textContent = `Listening… clap now  (${Math.max(0, Math.ceil((CLAP.windowMs - elapsed) / 1000))}s)`;
      });
      box.querySelector('#vmxClapMeters').classList.add('hidden');
      go.disabled = false;
      if (r.error) {
        go.textContent = 'Try again';
        result.innerHTML = `⚠️ ${esc(r.error)}`;
        return;
      }
      const before = { cam: Number(cam.syncMs) || 0, aud: Number(aud.syncMs) || 0 };
      if (Math.abs(r.skewMs) <= 12) {
        go.textContent = 'Close';
        undo = () => {};
        result.innerHTML = `✅ <b>Already in sync</b> — I measured ${r.skewMs} ms between the clap I heard and the clap I saw, which is closer than anyone can perceive. Nothing changed.`;
        return;
      }
      const applied = applyClapResult(cam, aud, r.skewMs);
      undo = () => { setInputSyncMs(cam, before.cam); setInputSyncMs(aud, before.aud); };
      go.textContent = 'Done';
      result.innerHTML = `✅ <b>Clap found.</b> Your sound was <b>${Math.abs(r.skewMs)} ms ${r.skewMs > 0 ? 'behind' : 'ahead of'}</b> the picture. ` +
        `Now ${esc(applied.what)}. <button class="vmx-btn" id="vmxClapUndo" style="margin-left:6px">Undo</button>`;
      const ub = box.querySelector('#vmxClapUndo');
      if (ub) ub.onclick = () => { undo(); undo = null; go.textContent = 'Start listening'; result.textContent = '↩ Put back the way it was.'; };
      toast(`👏 Clap sync: ${applied.what}.`, 'good', 7000);
    };
  }

  /* ----------------------- Colour Adjust panel -----------------------
   * The control set an operator coming from vMix expects, in the same order and
   * with the same ranges, so muscle memory carries over. Every control writes
   * straight onto the live input: the program and the broadcast change as the
   * slider moves, which is the only way to grade a camera against the others.
   */
  const COLOUR_ROWS = [
    ['r', 'Red', -100, 100, 1, 'colour-r'],
    ['g', 'Green', -100, 100, 1, 'colour-g'],
    ['b', 'Blue', -100, 100, 1, 'colour-b'],
    ['sat', 'Saturation', -100, 100, 1, 'colour-s'],
  ];
  function colourAdjustHtml(inp) {
    const c = colourOf(inp);
    const row = ([key, label, min, max, step, cls]) =>
      `<div class="vmx-col-row"><span class="vmx-col-lbl ${cls}">${label}</span>` +
      `<input type="number" class="vmx-col-num" id="vmxCol_${key}_n" value="${c[key]}" min="${min}" max="${max}" step="${step}" />` +
      `<input type="range" class="vmx-col-sld" id="vmxCol_${key}" value="${c[key]}" min="${min}" max="${max}" step="${step}" /></div>`;
    return `<details class="vmx-colour" ${colourActive(c) ? 'open' : ''}>` +
      `<summary>🎨 Colour Adjust${colourActive(c) ? ' <span class="vmx-col-on">on</span>' : ''}</summary>` +
      `<div class="vmx-col-grid">` +
        `<div class="vmx-col-side">${COLOUR_ROWS.map(row).join('')}` +
          `<div class="vmx-col-btns">` +
            `<button class="vmx-btn" type="button" id="vmxColAwb">Auto White Balance</button>` +
            `<button class="vmx-btn" type="button" id="vmxColReset">Reset</button>` +
          `</div></div>` +
        `<div class="vmx-col-side">` +
          row(['black', 'Black Stretch', 0, 254, 1, 'colour-k']) +
          row(['white', 'White Stretch', 1, 255, 1, 'colour-w']) +
          `<div class="vmx-col-btns">` +
            `<button class="vmx-btn" type="button" id="vmxColAuto">Auto</button>` +
            `<button class="vmx-btn" type="button" id="vmxCol0255">0-255</button>` +
            `<button class="vmx-btn" type="button" id="vmxCol16235">16-235</button>` +
          `</div>` +
          row(['alpha', 'Alpha', 0, 255, 1, 'colour-a']) +
          `<label class="vmx-inline"><input type="checkbox" id="vmxColRec601"${c.rec601 ? ' checked' : ''} /> Rec. 601 to 709</label>` +
        `</div>` +
      `</div>` +
      `<p class="vmx-note">🎨 Adjusts this input everywhere it is used — preview, program, the recording and every destination. ` +
      `<b>Black / White Stretch</b> set where black and white sit: <b>16-235</b> is right for a camera or capture card sending broadcast-range video that looks washed out, <b>0-255</b> for full-range. ` +
      `<b>Auto White Balance</b> reads the brightest part of the picture and neutralises the colour of the light — the quickest way to match one camera to the rest.</p>` +
      `</details>`;
  }

  function wireColourAdjust(box, inp) {
    const c = colourOf(inp);
    const keys = [...COLOUR_ROWS.map((r) => r[0]), 'black', 'white', 'alpha'];
    const sync = () => {
      for (const k of keys) {
        const s = box.querySelector('#vmxCol_' + k), n = box.querySelector('#vmxCol_' + k + '_n');
        if (s) s.value = c[k];
        if (n) n.value = c[k];
      }
      const chk = box.querySelector('#vmxColRec601');
      if (chk) chk.checked = !!c.rec601;
      const badge = box.querySelector('.vmx-col-on');
      if (badge) badge.style.display = colourActive(c) ? '' : 'none';
    };
    const set = (k, v) => {
      const num = parseFloat(v);
      c[k] = isNaN(num) ? COLOUR_DEFAULT[k] : num;
      // White must stay above black or the stretch inverts the picture.
      if (k === 'black') c.black = Math.min(c.black, c.white - 1);
      if (k === 'white') c.white = Math.max(c.white, c.black + 1);
      sync();
    };
    for (const k of keys) {
      const s = box.querySelector('#vmxCol_' + k), n = box.querySelector('#vmxCol_' + k + '_n');
      if (s) s.oninput = () => set(k, s.value);
      if (n) n.oninput = () => set(k, n.value);
    }
    const rec = box.querySelector('#vmxColRec601');
    if (rec) rec.onchange = () => { c.rec601 = rec.checked; sync(); };
    const awb = box.querySelector('#vmxColAwb');
    if (awb) awb.onclick = () => {
      const r = autoWhiteBalance(inp);
      sync();
      toast(r ? `⚖️ White balanced (R ${r.r > 0 ? '+' : ''}${r.r}, G ${r.g > 0 ? '+' : ''}${r.g}, B ${r.b > 0 ? '+' : ''}${r.b}).`
              : '⚖️ Not enough picture to balance — point the camera at the lit area and try again.', r ? 'good' : 'error');
    };
    const reset = box.querySelector('#vmxColReset');
    if (reset) reset.onclick = () => { Object.assign(c, COLOUR_DEFAULT); sync(); };
    const b0 = box.querySelector('#vmxCol0255');
    if (b0) b0.onclick = () => { c.black = 0; c.white = 255; sync(); };
    const b16 = box.querySelector('#vmxCol16235');
    if (b16) b16.onclick = () => { c.black = 16; c.white = 235; sync(); };
    const bAuto = box.querySelector('#vmxColAuto');
    if (bAuto) bAuto.onclick = () => {
      const r = autoLevels(inp);
      sync();
      toast(r ? `📊 Levels set from the picture (black ${r.black}, white ${r.white}).`
              : '📊 Not enough picture to read levels yet.', r ? 'good' : 'error');
    };
  }

  /**
   * Auto levels: put Black/White Stretch where this picture's darkest and
   * brightest real content actually is, ignoring the extreme tails so one
   * blown highlight or one crushed shadow doesn't set the whole range.
   */
  function autoLevels(inp) {
    const el = drawSourceOf(inp);
    const [sw, sh] = el === inp.el ? srcDims(inp) : [el.width, el.height];
    if (!sw || !sh) return null;
    const W = 160, H = Math.max(1, Math.round(W * sh / sw));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d', { willReadFrequently: true });
    try { c2.drawImage(el, 0, 0, W, H); } catch (e) { return null; }
    let px;
    try { px = c2.getImageData(0, 0, W, H).data; } catch (e) { return null; }
    const hist = new Uint32Array(256);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      hist[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2])]++;
      n++;
    }
    if (n < 64) return null;
    const at = (frac) => {
      let acc = 0; const want = n * frac;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= want) return v; }
      return 255;
    };
    const c = colourOf(inp);
    const lo = at(0.005), hi = at(0.995);
    if (hi - lo < 8) return null; // a flat frame has no range to read
    c.black = clamp(lo, 0, 254);
    c.white = clamp(Math.max(hi, c.black + 1), 1, 255);
    return { black: c.black, white: c.white };
  }

  /* ------- production settings (record/output/audio) ------- */

  function liveCfg() { return (st.settings && st.settings.live) || {}; }

  async function saveLiveCfg(patch) {
    const next = Object.assign({}, liveCfg(), patch);
    try { st.settings = await window.api.settings.update({ live: next }); }
    catch (e) { st.settings = Object.assign({}, st.settings, { live: next }); }
  }

  async function openSettingsModal() {
    const lv = liveCfg();
    let paths = null;
    try { paths = await window.api.paths.get(); } catch (e) {}
    const outDir = (paths && paths.outputDir) || '—';
    let eng = { label: '', preference: 'auto', gpu: true };
    try { if (window.api.live.engine) eng = Object.assign(eng, await window.api.live.engine()); } catch (e) {}
    // Which audio formats this build can actually record (asked of the engine,
    // never hard-coded here — the engine is what proves each one works).
    let af = { formats: [], current: 'aac' };
    try { if (window.api.live.recFormats) af = Object.assign(af, await window.api.live.recFormats()); } catch (e) {}
    const afCur = lv.recAudioFormat || af.current || 'aac';
    const afHint = (af.formats.find((f) => f.id === afCur) || {}).hint || '';
    openModal(
      `<h3>⚙ Production settings <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-form">` +
      `<label>Output / recording quality<select id="vmxSetQ">` + qualityOptionsHtml(lv.quality || DEFAULT_QUALITY) + `</select></label>` +
      /*
       * Said out loud, because the numbers in those preset names no longer mean
       * what they look like they mean — and an operator who picks "2.5mbps" and
       * then reads 2.8 on the switcher deserves to know why rather than to
       * wonder what is wrong. The preset picks the picture; the platform prices
       * it (see platformKbps in src/main/livestream.js).
       */
      `<p class="vmx-note">You are choosing the picture SIZE here. The bitrate that goes with it is ` +
      `set to what the platform asks for that size — sending a big picture for less than it costs ` +
      `is exactly what makes YouTube report a low bitrate for a whole service. Streaming Settings ` +
      `can measure your upload and tell you which size this connection can actually pay for.</p>` +
      (af.formats.length ? `<label>Recording sound format<select id="vmxSetAudioFmt">` +
        af.formats.map((f) => `<option value="${esc(f.id)}"${f.id === afCur ? ' selected' : ''}>${esc(f.label)}</option>`).join('') +
      `</select></label><p class="vmx-note" id="vmxSetAudioHint">${esc(afHint)}</p>` : '') +
      `<label>Frame rate<select id="vmxSetFps">` +
        [['auto', 'Auto — match my camera (recommended)'], ['24', '24 fps (film look)'], ['25', '25 fps (PAL camcorders)'],
         ['30', '30 fps'], ['50', '50 fps (PAL smooth)'], ['60', '60 fps']]
          .map(([v, l]) => `<option value="${v}"${(lv.fpsMode || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('') +
      `</select></label>` +
      /*
       * "NEVER SEND LESS THAN THIS" — the floor under auto-fit.
       *
       * Auto-fit softens the picture when the line fills up, which is right, but
       * left to itself it will go under the platform's own number and that is
       * what YouTube's yellow warning measures. The default holds it at exactly
       * that number. The one thing it will still do is go below when a
       * destination is actually LOSING PICTURE, because "soft" beats "broken".
       */
      `<label>Never send less than<select id="vmxSetMinKbps">` +
        [['auto', 'What the platform asks for this picture (recommended)'],
         ['3000', '3 mbps'], ['4500', '4.5 mbps'], ['6000', '6 mbps'], ['8000', '8 mbps'],
         ['off', 'No floor — let the picture drop as far as it needs to']]
          .map(([v, l]) => `<option value="${v}"${String(lv.minKbps || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('') +
      `</select></label>` +
      `<p class="vmx-note">The picture is never sent for less than this, so a platform cannot report it as ` +
      `under-rated. If your connection genuinely cannot carry it the app still protects the picture from ` +
      `breaking up — it lowers below this only when frames would otherwise be thrown away, and says so on screen.</p>` +
      `<label class="vmx-inline"><input type="checkbox" id="vmxSetAutoMix"${st.autoMix ? ' checked' : ''} /> Automatically mix audio (only inputs on the program are heard)</label>` +
      `<label class="vmx-inline"><input type="checkbox" id="vmxSetAvSync"${st.avAutoSync ? ' checked' : ''} /> Keep sound and picture in step automatically (measures NDI sources and corrects the difference)</label>` +
      `<label>Video encoder<select id="vmxSetEnc">` +
        [['auto', 'Automatic — use my graphics card when possible (recommended)'], ['libx264', 'Software only (use if the picture glitches)']]
          .map(([v, l]) => `<option value="${v}"${(eng.preference || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('') +
      `</select></label>` +
      `<label class="vmx-inline"><input type="checkbox" id="vmxSetGpu"${eng.gpu ? ' checked' : ''} /> Use graphics acceleration for the switcher (restart required)</label>` +
      `<label>Recording folder<div class="path-row"><code id="vmxSetOutDir">${esc(outDir)}</code><button class="ghost-btn small" type="button" id="vmxSetOutBtn">Change…</button></div></label>` +
      `</div>` +
      `<p class="vmx-note">⚡ Encoding now: <b>${esc(eng.label || 'checking…')}</b>. The program is encoded <b>once</b> and shared by every destination and the recording, so streaming to several platforms at the same time costs almost nothing extra.</p>` +
      `<p class="vmx-note">💡 A stuttering live stream is almost always a frame-rate mismatch. Keep Frame rate on <b>Auto</b> and the whole chain — capture, encode, stream — follows your camera exactly (a 25 fps camcorder streams at exactly 25 fps).</p>` +
      `<p class="vmx-note">🎬 Record, MultiCorder, and Instant Replay all save into the folder above (the same output folder used app-wide), using the sound format chosen here. 📡 To set up streaming destinations, press the ⚙ next to Stream.</p>` +
      `<p class="vmx-note">🔊 The sound format applies to <b>recordings only</b>. Live streams always send AAC because YouTube and Facebook accept nothing else — that is their rule, not the app's.</p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxSetOk">Save</button></div>`);
    const box = refs.vmxModalBox;
    // Each format explains itself as you scroll through them — the whole point of
    // the setting is that the operator can tell WHICH one to pick.
    const afSel = box.querySelector('#vmxSetAudioFmt');
    if (afSel) afSel.onchange = () => {
      const hit = af.formats.find((f) => f.id === afSel.value);
      const note = box.querySelector('#vmxSetAudioHint');
      if (note && hit) note.textContent = hit.hint || '';
    };
    box.querySelector('#vmxSetOutBtn').onclick = async () => {
      const dir = await window.api.dialog.openDir();
      if (!dir) return;
      try { await window.api.settings.update({ outputDir: dir }); } catch (e) {}
      box.querySelector('#vmxSetOutDir').textContent = dir;
      toast('📁 Recording folder updated.', 'good');
    };
    box.querySelector('#vmxSetOk').onclick = async () => {
      st.autoMix = box.querySelector('#vmxSetAutoMix').checked;
      const avs = box.querySelector('#vmxSetAvSync');
      if (avs) { st.avAutoSync = avs.checked; syncTick(); }
      const encPref = box.querySelector('#vmxSetEnc').value;
      const gpuOn = box.querySelector('#vmxSetGpu').checked;
      const gpuChanged = gpuOn !== !!eng.gpu;
      const patch = { quality: box.querySelector('#vmxSetQ').value, fpsMode: box.querySelector('#vmxSetFps').value };
      const minSel = box.querySelector('#vmxSetMinKbps');
      if (minSel) patch.minKbps = minSel.value;
      if (afSel) patch.recAudioFormat = afSel.value;
      await saveLiveCfg(patch);
      try { await window.api.settings.update({ liveEncoder: encPref, gpuAcceleration: gpuOn ? 'on' : 'off' }); } catch (e) {}
      applyQuality();
      refreshOutStream();
      refreshTargetFps();
      closeModal();
      toast(gpuChanged ? '✅ Saved — restart the app for the graphics setting to take effect.' : '✅ Settings saved.', 'good');
    };
  }

  /** Grouped vMix-style preset list for the quality selects. */
  function qualityOptionsHtml(selected) {
    const sel = canonicalQ(selected);
    return QUALITY_GROUPS.map((g) =>
      `<optgroup label="${esc(g.name)}">` +
      g.keys.map((k) => `<option value="${esc(k)}"${k === sel ? ' selected' : ''}>${esc(k)}</option>`).join('') +
      `</optgroup>`).join('');
  }

  function applyQuality(explicitQ) {
    const q = explicitQ || quality();
    if (refs.vmxPgmCanvas.width !== q.width || refs.vmxPgmCanvas.height !== q.height) {
      // Never resize the canvas while any consumer is encoding it — the program
      // hub is bound to the exact capture dimensions, so a resize underneath it
      // would desync every destination and the recording at once.
      if (st.pgmRec || programConsumers() > 0) return;
      refs.vmxPgmCanvas.width = q.width; refs.vmxPgmCanvas.height = q.height;
    }
  }

  /* ------- streaming destinations (vMix-style: up to MAX_STREAMS at once) ------- */

  function initStreamsFromSettings() {
    const lv = liveCfg();
    const persisted = Array.isArray(lv.destinations) ? lv.destinations : [];
    st.streams = Array.from({ length: MAX_STREAMS }, (_, i) => i + 1).map((num) => {
      const p = persisted[num - 1];
      const base = { id: 'd' + num, num, dest: 'facebook', key: '', customUrl: '', quality: DEFAULT_QUALITY,
        streaming: false, startedAt: 0, lastStats: null, lastEndInfo: null };
      if (p) Object.assign(base, { dest: p.dest || 'facebook', key: p.key || '', customUrl: p.customUrl || '', quality: canonicalQ(p.quality || DEFAULT_QUALITY) });
      return base;
    });
    // migrate a pre-multi-destination single stream key into slot 1
    if (!persisted.length && lv.key) {
      Object.assign(st.streams[0], { dest: lv.dest || 'facebook', key: lv.key, customUrl: lv.customUrl || '', quality: canonicalQ(lv.quality || DEFAULT_QUALITY) });
    }
  }

  async function persistStreams() {
    await saveLiveCfg({ destinations: st.streams.map((s) => ({ dest: s.dest, key: s.key, customUrl: s.customUrl, quality: s.quality })) });
  }

  function updateStreamUI() {
    const any = st.streams.some((s) => s.streaming);
    refs.vmxStream.classList.toggle('on', any);
    refs.vmxStream.classList.toggle('blink', any);
    refs.vmxStStream.classList.toggle('hidden', !any);
    if (!any) refs.vmxStBitrate.textContent = '';
    updateAirState();
  }

  function updateStreamStatusBar() {
    const active = st.streams.filter((s) => s.streaming);
    if (!active.length) { refs.vmxStBitrate.textContent = ''; return; }
    const retrying = active.filter((s) => s.reconnecting);
    const totalKbps = active.reduce((sum, s) => sum + ((s.lastStats && s.lastStats.bitrateKbps) || 0), 0);
    const anyWeak = active.some((s) => s.lastStats && s.lastStats.speed && s.lastStats.speed < 0.92);
    const label = active.length > 1 ? `Σ ${Math.round(totalKbps)} kbps (${active.length} destinations)` : `${Math.round(totalKbps)} kbps`;
    refs.vmxStBitrate.textContent = label +
      (retrying.length ? ` · 🔄 ${retrying.map((s) => s.num).join(',')} reconnecting` : '') +
      (anyWeak ? ' ⚠️' : '');
  }

  function bestQualityAmong(slots) {
    // Largest pixel area wins (fps breaks ties) — the shared program canvas
    // must satisfy the most demanding destination; smaller ones scale down.
    let best = null;
    for (const s of slots) {
      const q = resolveQ(s.quality);
      const area = q.width * q.height;
      if (!best || area > best.width * best.height ||
          (area === best.width * best.height && (q.fps || 0) > (best.fps || 0))) best = q;
    }
    return best || resolveQ(DEFAULT_QUALITY);
  }

  /**
   * Actually opens the destination's ffmpeg push — no canvas-sizing decisions
   * here. `pending` describes the whole group going live together, so the shared
   * encode is sized for all of them and not just for this one.
   */
  async function reallyStartStream(slot, pending) {
    if (slot.streaming) return true;
    if (!slot.key) { toast('⚠️ Set a stream key for destination ' + slot.num + ' first.', 'error'); return false; }
    if (slot.dest === 'custom' && !slot.customUrl) { toast('⚠️ Enter the custom RTMP URL for destination ' + slot.num + '.', 'error'); return false; }
    // The program encoder comes up FIRST so the destination attaches to a feed
    // that is already flowing — this is what makes joining mid-broadcast work.
    if (!(await ensureProgramEncoder(pending || [resolveQ(slot.quality)], { forStream: true }))) return false;
    /*
     * …AND IT IS ACTUALLY PRODUCING PICTURE BEFORE THE PLATFORM IS TOLD ABOUT IT.
     *
     * The destination's ffmpeg decides ONCE, in its first moments, whether the
     * feed it has been given contains video — and if it decides wrongly the
     * whole service goes out as sound over a black screen. On a cold app the
     * first capture pays the GPU encoder's first-use initialisation and produces
     * nothing for several seconds, which is exactly when that decision was being
     * made. Widening ffmpeg's probe budget (LIVE_ANALYZE_US) made that rare;
     * this makes it impossible, because the question is no longer asked until
     * there is an answer.
     *
     * It costs nothing on a warm encoder — the frames are already flowing, so
     * this returns on the first poll — and a second or two at the moment the
     * operator presses Go Live, which is the one moment in a service where a
     * short wait is both expected and harmless.
     */
    await waitForPictureFlowing(st.pgmRec);
    try {
      await window.api.live.start(slot.id, { dest: slot.dest, key: slot.key, customUrl: slot.customUrl,
        quality: slot.quality, fps: st.outStreamFps || productionFps() });
    } catch (e) {
      toast('⚠️ Destination ' + slot.num + ': ' + (e.message || e), 'error');
      await maybeStopProgramEncoder();
      return false;
    }
    slot.streaming = true; slot.startedAt = Date.now(); slot.lastEndInfo = null; slot.reconnecting = null;
    updateStreamUI();
    return true;
  }

  /** Start one destination slot (e.g. "Start N" in Streaming Settings). Returns true on success. */
  async function startOneStream(slot) {
    if (!slot.streaming && !st.recording && !st.streams.some((s) => s.streaming)) {
      applyQuality(resolveQ(slot.quality));
      refreshOutStream();
    }
    return reallyStartStream(slot, [resolveQ(slot.quality)]);
  }

  async function stopOneStream(slot) {
    if (!slot.streaming) return;
    slot.streaming = false;
    slot.reconnecting = null;
    slot.shedding = false;
    renderShedBanner();
    renderFitBanner();
    updateStreamUI(); // reflect the stop immediately, not after ffmpeg has drained
    try { await window.api.live.stop(slot.id); } catch (e) {}
    await maybeStopProgramEncoder();
    updateStreamUI();
  }

  /**
   * PUT EVERY DESTINATION ON A PICTURE THE LINE CAN ACTUALLY PAY FOR IN FULL.
   *
   * This is the honest answer to "why can't I send the second one at the same
   * rate as the first?". One encode is fanned out to each platform over its own
   * connection, so two destinations cost twice the upload. On a line measured at
   * 12.49 Mbps — 8243 kbps of it usable once the room, RTMP framing and TCP
   * recovery are allowed for — the arithmetic is not close:
   *
   *     1080p30 × 1 = 4660 kbps      fits
   *     1080p30 × 2 = 9320 kbps      113% of the line
   *      720p30 × 2 = 5920 kbps      fits, with room to spare
   *
   * Sending 1080p to both does not give both a big picture; it gives both a
   * STARVED one — every window under what the platform charges, the yellow
   * warning on each, and one of them shedding, because TCP does not divide a
   * full line fairly. Sending 720p to both gives each of them the full rate for
   * the picture it is sending, and NEITHER is under-rated.
   *
   * So the app now makes that choice itself, before the service, instead of
   * describing it in a dialog the operator has to find. Only ever DOWNWARDS,
   * only with a measurement recent enough to mean something, only when nothing
   * is on air yet (changing a preset mid-service is what starts a second live
   * encode), and never silently.
   */
  function fitDestinationsToLine(targets) {
    if (!targets || targets.length < 1) return false;
    if (st.streams.some((s) => s.streaming) || st.recording) return false;
    const share = measuredLineKbps(targets.length);
    if (!share) return false;                       // never measured, or not recently
    const best = bestQualityAmong(targets);
    if (!best) return false;
    const fps = affordableStreamFps(productionFps(), best.width, best.height);
    const need = platformRecKbps(best.width, best.height, fps);
    if (!need || share >= need) return false;       // the line can pay for it — nothing to do
    const key = smallerPictureThatFits(share, fps, best.height > best.width, Math.min(best.width, best.height));
    if (!key || QUALITY[key] === undefined) return false;
    const fitted = resolveQ(key);
    if (!fitted || fitted.width * fitted.height >= best.width * best.height) return false;
    const changed = targets.filter((s) => s.quality !== key);
    if (!changed.length) return false;
    for (const s of changed) s.quality = key;
    persistStreams();
    const mb = (k) => (Math.round(k / 100) / 10);
    toast(`📶 ${targets.length} destinations set to “${key}”. Your upload measured `
      + `${(Math.round(Number(liveCfg().lastUplinkMbps) * 10) / 10)} Mbps, and ${targets.length} × `
      + `${best.width}×${best.height} costs ${mb(need * targets.length)} mbps of it — more than it has, so BOTH `
      + `would have gone out starved and both would have been reported as a low bitrate. At this size each one `
      + `gets the full rate its picture costs, and neither is under-rated.`, 'good', 14000);
    return true;
  }

  async function startAllStreams() {
    const targets = st.streams.filter((s) => s.key && !s.streaming);
    if (!targets.length) return false;
    // Before anything is sized or started: can this line pay for what is about
    // to be sent, to all of them, in full? If not, send a picture it can.
    fitDestinationsToLine(targets);
    // Resize ONCE for the whole batch, to the BEST quality among everything
    // about to go live — otherwise whichever destination happens to start
    // first would lock the canvas at ITS resolution and silently cap every
    // other destination in the same "Start All" to that lower tier.
    const pending = targets.map((s) => resolveQ(s.quality));
    if (!st.recording && !st.streams.some((s) => s.streaming)) { applyQuality(bestQualityAmong(targets)); refreshOutStream(); }
    // Say it BEFORE the service, not after someone complains about the sound.
    // Asked of the main process first, so this is the hub's own answer and not
    // a second opinion that misses a bitrate mismatch.
    await refreshMismatch();
    const bad = mismatchedSlots().filter((s) => targets.includes(s));
    if (bad.length) {
      toast(`⚠️ Destination ${bad.map((s) => s.num).join(', ')} cannot share the one encode the others use, so it has to be re-encoded live on this PC — that is what makes one platform judder or sound gappy while the other is fine. ` +
        `Give them all the same quality in ⚙ Streaming Settings.`, 'error', 12000);
    }
    let any = false;
    for (const s of targets) { if (await reallyStartStream(s, pending)) any = true; }
    return any;
  }

  async function stopAllStreams() {
    // In parallel: each destination's encoder takes a moment to close its RTMP
    // connection, and doing that one after another made "Stop" feel sluggish.
    await Promise.all(st.streams.filter((s) => s.streaming).map((s) => stopOneStream(s)));
  }

  async function toggleStream() {
    if (st.streams.some((s) => s.streaming)) { await stopAllStreams(); toast('⏹ Stream ended.', 'good'); return; }
    if (!st.streams.some((s) => s.key)) {
      statusMsg('⚠️ Set up at least one streaming destination first — press the ⚙ next to Stream.');
      openStreamSettingsModal();
      return;
    }
    statusMsg('Connecting to the server…');
    const any = await startAllStreams();
    statusMsg('');
    if (any) toast('🔴 You are LIVE!', 'good');
  }

  function destLabel(s) {
    if (s.dest === 'youtube') return 'YouTube Live';
    if (s.dest === 'custom') return s.customUrl || 'Custom RTMP';
    return 'Facebook Live';
  }

  /* ---------------- one encode, or one encode per destination? --------------
   *
   * THIS is why one platform can sound and look fine while another, on the same
   * internet, is a mess.
   *
   * The program is encoded ONCE, at the size of the largest destination. Any
   * destination asking for that exact size is then a straight copy — no second
   * encode, no quality lost, almost no CPU. A destination asking for a
   * DIFFERENT size cannot be copied: its own ffmpeg has to decode the broadcast
   * and re-encode it in software, on the same computer that is already
   * compositing the service and feeding everyone else. On a modest church PC
   * that encode falls behind real time, its buffer fills, the app starts
   * dropping picture to protect the sound, and the platform reports a bad
   * connection on a perfectly good line. Which destination suffers is simply
   * whichever one did not match — which is exactly why "I changed the streaming
   * quality and it got better" is a real observation and not a coincidence.
   *
   * So: say it, in the dialog, before the service — and offer the one-click fix.
   */
  /*
   * Which configured destinations cannot be copied from the shared encode.
   *
   * The ANSWER COMES FROM THE MAIN PROCESS (`live:copyCheck`), from the same
   * function the hub uses when it spawns the output. This used to be worked out
   * here with a simpler rule — "do the frame sizes match?" — and a bitrate
   * difference therefore slipped straight past it: the operator lowered one
   * destination's mbps to help a struggling platform, this dialog said "✅ all
   * your destinations use the same size, so the service is encoded once and
   * copied to each of them", and meanwhile a second full 1080p encode had
   * started on the same PC and made that platform very much worse.
   *
   * It is refreshed asynchronously and cached, so the dialog can stay
   * synchronous; `refreshMismatch()` re-renders when the answer changes.
   */
  function mismatchedSlots() {
    const slots = st.streams.filter((s) => s.key);
    if (slots.length < 2) return [];
    const ix = st.reEncodeIx;
    if (!ix) {   // not answered yet — fall back to the part we can be sure of
      const big = bestQualityAmong(slots);
      return slots.filter((s) => {
        const q = resolveQ(s.quality);
        return q.width !== big.width || q.height !== big.height;
      });
    }
    return slots.filter((s, i) => ix.includes(i));
  }

  /** Ask main which destinations would re-encode; re-render if that changed. */
  async function refreshMismatch(onChange) {
    const slots = st.streams.filter((s) => s.key);
    const before = JSON.stringify(st.reEncodeIx || null);
    if (slots.length < 2) st.reEncodeIx = [];
    else {
      try {
        const r = await window.api.live.copyCheck(slots.map((s) => resolveQ(s.quality)),
          st.outStreamFps || productionFps());
        st.reEncodeIx = (r && r.reEncoded) || [];
      } catch (e) { st.reEncodeIx = null; }
    }
    if (onChange && JSON.stringify(st.reEncodeIx || null) !== before) onChange();
  }
  function mismatchNoteHtml() {
    const bad = mismatchedSlots();
    if (!bad.length) {
      return st.streams.filter((s) => s.key).length > 1
        ? `<p class="vmx-note vmx-ok-note">✅ All your destinations can share one encode, so the service is encoded once and copied to each of them untouched. This is the setup that sounds and looks best.</p>`
        : '';
    }
    const big = bestQualityAmong(st.streams.filter((s) => s.key));
    const sizeDiffers = bad.some((s) => { const q = resolveQ(s.quality); return q.width !== big.width || q.height !== big.height; });
    return `<p class="vmx-note vmx-warn-note">⚠️ Destination${bad.length > 1 ? 's' : ''} ` +
      `<b>${bad.map((s) => s.num).join(', ')}</b> ${bad.length > 1 ? 'cannot' : 'cannot'} share the one encode the others use — ` +
      (sizeDiffers
        ? `${bad.length > 1 ? 'their sizes differ' : 'its size differs'} from ${big.width}×${big.height}. `
        : `${bad.length > 1 ? 'their bitrates are' : 'its bitrate is'} too far below the ${big.videoKbps} kbps the service is encoded at, so the picture has to be made again at the lower rate. `) +
      `That destination is <b>re-encoded on this computer</b> while the service is running, which is the usual reason one ` +
      `platform judders or its sound goes gappy while the other is perfect. ` +
      `<button class="vmx-btn vmx-btn-inline" id="vmxSsMatch">Use this destination's quality for all of them</button></p>`;
  }
  /* ==================== WILL SUNDAY FIT DOWN THIS LINE? ====================
   *
   * The mismatch note above catches a destination that costs a SECOND ENCODE.
   * This catches the other half, and the half that actually took a service
   * down: destinations that share one encode perfectly and still do not fit,
   * because two 1080p streams need ~12.3 Mbps of upload and the line has less.
   *
   * That failure is peculiarly hard to read from the desk. TCP cannot split a
   * full line fairly between two platforms, so ONE destination keeps its
   * picture and the other starves — which looks like that platform's fault,
   * not the connection's. Measured on the church laptop this was written
   * against: 12.49 Mbps up, against 12.3 Mbps of demand. 98% of the line, no
   * headroom, and forty minutes in YouTube was arriving at 2.3 Mbps with
   * warbling audio while Facebook was flawless.
   *
   * So it is measured before the service, not diagnosed after it.
   */
  function uplinkNoteHtml() {
    const u = st.uplink || {};
    const n = (x) => (Math.round(x * 10) / 10).toFixed(1);
    // What they will actually COST, not what their presets say. The app sends
    // the platform's own rate for the picture size chosen (see platformKbps),
    // so planning against the preset number is planning against a stream this
    // app no longer sends.
    const pFps = st.outStreamFps || productionFps();
    const need = st.streams.filter((s) => s.key)
      .reduce((t, s) => {
        const q = resolveQ(s.quality);
        const v = Math.max(q.videoKbps || 0, platformRecKbps(q.width, q.height, q.fps || pFps));
        return t + (v + (q.audioKbps || 0)) / 1000;
      }, 0);
    if (!need) return '';
    if (u.testing) {
      return `<p class="vmx-note">📶 Measuring your upload… ${u.step ? `(pass ${u.step} of ${u.of})` : ''}</p>`;
    }
    if (!u.result) {
      return `<p class="vmx-note">📶 These destinations need <b>${n(need)} Mbps</b> of upload between them. ` +
        `<button class="vmx-btn vmx-btn-inline" id="vmxSsUplink">Check my upload speed</button></p>`;
    }
    const r = u.result;
    if (!r.ok) {
      return `<p class="vmx-note vmx-warn-note">📶 ${esc(r.error || 'Could not measure your upload.')} ` +
        `<button class="vmx-btn vmx-btn-inline" id="vmxSsUplink">Try again</button></p>`;
    }
    const cls = r.fits ? 'vmx-ok-note' : 'vmx-warn-note';
    return `<p class="vmx-note ${cls}">${r.fits ? '✅' : '⚠️'} ${esc(r.verdict)} ` +
      (r.recommend && !r.fits
        ? `<button class="vmx-btn vmx-btn-inline" id="vmxSsFit">Use that on every destination</button> `
        : '') +
      `<button class="vmx-btn vmx-btn-inline" id="vmxSsUplink">Measure again</button></p>`;
  }

  async function runUplinkTest(onChange) {
    if (st.uplink && st.uplink.testing) return;
    st.uplink = { testing: true };
    onChange && onChange();
    const off = window.api.live.onUplinkProgress
      ? window.api.live.onUplinkProgress((p) => { if (st.uplink) { st.uplink.step = p.step; st.uplink.of = p.of; onChange && onChange(); } })
      : null;
    try {
      const qs = st.streams.filter((s) => s.key).map((s) => resolveQ(s.quality));
      const result = await window.api.live.uplinkTest(qs, st.outStreamFps || productionFps());
      st.uplink = { testing: false, result };
      /*
       * Remembered, because the encoder needs it too. Chasing a platform's
       * recommended bitrate is only sensible up to what the line can actually
       * feed (see measuredLineKbps / platformKbps), and a measurement that
       * lives only inside one open dialog cannot inform the broadcast.
       */
      if (result && result.ok && result.mbps) {
        try { await saveLiveCfg({ lastUplinkMbps: result.mbps, lastUplinkAt: Date.now() }); } catch (e) {}
      }
    } catch (e) {
      st.uplink = { testing: false, result: { ok: false, error: e.message || String(e) } };
    } finally {
      if (off) { try { off(); } catch (e) {} }
    }
    onChange && onChange();
  }

  /**
   * Put every destination on the preset that actually fits the measured line.
   *
   * Every destination, deliberately — lowering only the one that is struggling
   * is the obvious move and it is the trap the mismatch note above exists for:
   * a destination whose preset differs cannot be copied from the single encode,
   * so it gets re-encoded live and fails in a way that looks identical to bad
   * internet. One preset for all of them keeps it a copy.
   */
  function fitMyUpload() {
    const r = st.uplink && st.uplink.result;
    if (!r || !r.ok || !r.recommend) return;
    const key = r.recommend.key;
    let n = 0, live = 0;
    for (const s of st.streams) {
      if (!s.key || s.quality === key) continue;
      if (s.streaming) { live++; continue; }   // never re-point a destination that is on air
      s.quality = key; n++;
    }
    persistStreams();
    /*
     * The frame rate is part of the same answer, not an afterthought. On a line
     * that cannot pay for 60fps, changing only the preset leaves 'Auto' still
     * following a 60fps camera — so the platform still asks for the 60fps rate
     * and still reports the stream as under-fed. Both halves, or neither.
     */
    let fpsNote = '';
    if (r.recommend.setFps) {
      saveLiveCfg({ fpsMode: String(r.recommend.setFps) });
      refreshTargetFps();
      fpsNote = ` The production frame rate is now ${r.recommend.setFps} — your camera was running faster`
        + ` than this line can pay for, and that alone would have kept the platform asking for more.`;
    }
    st.uplink = { testing: false };            // the plan changed; the old verdict is stale
    toast(n
      ? `📶 ${n} destination${n > 1 ? 's' : ''} set to “${key}” — that fits your upload with room to spare.`
        + fpsNote
        + (live ? ` ${live} left alone because ${live > 1 ? 'they are' : 'it is'} on air.` : '')
      : (fpsNote.trim() || 'Nothing to change — they are already on that quality, or they are live.'), 'good', 10000);
  }

  /** Give every configured destination the quality of slot `ix`. */
  function matchDestinationQualities(ix) {
    const q = st.streams[ix] && st.streams[ix].quality;
    if (!q) return;
    let n = 0;
    for (const s of st.streams) {
      if (!s.key || s.quality === q) continue;
      if (s.streaming) continue;          // never change a destination that is on air
      s.quality = q; n++;
    }
    persistStreams();
    toast(n
      ? `✅ ${n} destination${n > 1 ? 's' : ''} now use the same quality — the service is encoded once and copied to each of them.`
      : 'Nothing to change — the other destinations are either live or already matched.', 'good', 6000);
  }

  function openStreamSettingsModal() {
    let activeSlot = st.streams.findIndex((s) => s.streaming);
    if (activeSlot < 0) activeSlot = 0;

    /*
     * WHAT THIS DESTINATION IS DOING, AT THE TOP, IN ONE LINE.
     *
     * It used to be a sentence of grey prose in the middle of four other
     * paragraphs of grey prose — so the one fact an operator opens this dialog
     * for during a service (is number 2 actually on air?) was the hardest thing
     * in it to find. A lamp and a line, above everything else.
     */
    function slotStatusHtml(s) {
      let cls = 'off', lamp = 'Offline', text = 'Not streaming.';
      if (s.streaming && s.reconnecting) {
        cls = 'warn'; lamp = 'Reconnecting';
        text = `Dropped — trying again (attempt ${s.reconnecting.attempt} of ${s.reconnecting.of}). The others are unaffected.`;
      } else if (s.streaming) {
        cls = 'live'; lamp = 'On air';
        const kb = s.lastStats && s.lastStats.bitrateKbps ? `${Math.round(s.lastStats.bitrateKbps)} kbps` : 'starting…';
        text = kb + (s.lastStats && s.lastStats.copying === false ? ' · re-encoded for this quality' : '');
      } else if (s.lastEndInfo && s.lastEndInfo.error) {
        cls = 'warn'; lamp = 'Stopped'; text = s.lastEndInfo.error;
      }
      return `<div class="vmx-ss-status ${cls}"><span class="vmx-ss-lamp"></span>` +
        `<b>${esc(destLabel(s))}</b><span class="vmx-ss-state">${esc(lamp)}</span>` +
        `<span class="vmx-ss-detail">${esc(text)}</span></div>`;
    }

    function render() {
      const s = st.streams[activeSlot];
      const anyLive = st.streams.some((x) => x.streaming);
      refs.vmxModalBox.className = 'vmx-modal-box vmx-streamsettings';
      refs.vmxModalBox.innerHTML =
        `<h3>📡 Streaming Settings <span class="vmx-modal-x">✕</span></h3>` +
        `<div class="vmx-ss-tabs">` +
        st.streams.map((slot, i) => `<button class="vmx-ss-tab${i === activeSlot ? ' sel' : ''}${slot.streaming ? ' live' : ''}" data-slot="${i}">${slot.num}</button>`).join('') +
        `</div>` +
        slotStatusHtml(s) +
        `<div class="vmx-form">` +
        `<label>Destination<select id="vmxSsDest">` +
          `<option value="facebook"${s.dest === 'facebook' ? ' selected' : ''}>Facebook Live</option>` +
          `<option value="youtube"${s.dest === 'youtube' ? ' selected' : ''}>YouTube Live</option>` +
          `<option value="custom"${s.dest === 'custom' ? ' selected' : ''}>Custom RTMP Server</option>` +
        `</select></label>` +
        `<label id="vmxSsUrlRow" class="${s.dest === 'custom' ? '' : 'hidden'}">Server URL<input type="text" id="vmxSsUrl" value="${esc(s.customUrl)}" placeholder="rtmp://server/live" /></label>` +
        `<label>Stream key<input type="password" id="vmxSsKey" value="${esc(s.key)}" placeholder="Paste your stream key" /></label>` +
        `<label>Picture size<select id="vmxSsQ">` + qualityOptionsHtml(s.quality) + `</select></label>` +
        `<label>Sound — all destinations<select id="vmxSsAudioQ">` +
          AUDIO_QUALITIES.map((a) => `<option value="${esc(a.id)}"${a.id === (liveCfg().audioQuality || DEFAULT_AUDIO_QUALITY) ? ' selected' : ''}>${esc(a.label)}</option>`).join('') +
        `</select></label>` +
        `<label>If my internet slows down<select id="vmxSsFitMode">` +
          `<option value="auto"${(st.settings || {}).autoFitBitrate === 'off' ? '' : ' selected'}>Lower the picture automatically (recommended)</option>` +
          `<option value="off"${(st.settings || {}).autoFitBitrate === 'off' ? ' selected' : ''}>Keep this quality, drop picture when it cannot keep up</option>` +
        `</select></label>` +
        `</div>` +
        /*
         * Only what is TRUE RIGHT NOW and can be acted on stays on the surface:
         * a destination that will cost a second encode, and whether Sunday fits
         * down this line. Both come with the button that fixes them.
         */
        mismatchNoteHtml() +
        uplinkNoteHtml() +
        /*
         * Everything that is merely worth knowing goes behind one fold.
         *
         * This dialog had four permanent paragraphs of explanation — 176 words
         * of small grey text — and they pushed the Start buttons off the bottom
         * of the box. During a service that is not information, it is an
         * obstacle. The words are good and they are kept exactly; they are just
         * no longer in the way of the button somebody came here to press.
         */
        `<details class="vmx-ss-more"><summary>What these settings mean</summary>` +
        `<p class="vmx-note">📐 <b>Picture size</b> is the size, not the bitrate. Whatever size you pick, the app sends ` +
        `it at the bitrate the platform publishes for that size — that is the number YouTube compares ` +
        `against when it says “your bitrate is lower than the recommended bitrate”, and it is not ` +
        `something a preset name from another product can know. If your line cannot pay for that size, ` +
        `the honest fix is a smaller picture, not a starved big one: measure your upload above and it will name one.</p>` +
        `<p class="vmx-note">🎵 <b>Sound</b> applies to every destination at once — it is encoded once and copied to all of them, so a better setting costs nothing extra on this computer. ` +
        `${esc((AUDIO_QUALITIES.find((a) => a.id === (liveCfg().audioQuality || DEFAULT_AUDIO_QUALITY)) || {}).hint || '')}</p>` +
        `<p class="vmx-note">📡 Destinations start and stop <b>independently</b> — starting number ${s.num} mid-service will not interrupt the ones already on air.</p>` +
        `</details>` +
        `<div class="vmx-form-btns">` +
        `<button class="vmx-btn" id="vmxSsStartAll">${anyLive ? 'Stop All' : 'Start All'}</button>` +
        `<button class="vmx-btn" id="vmxSsStartOne">${s.streaming ? 'Stop ' + s.num : 'Start ' + s.num}</button>` +
        `<button class="vmx-btn" id="vmxSsStatus">View Status</button>` +
        `<button class="vmx-btn" id="vmxSsClose">Save and Close</button>` +
        `</div>`;
      wire();
    }

    function wire() {
      const box = refs.vmxModalBox;
      const s = st.streams[activeSlot];
      box.querySelector('.vmx-modal-x').onclick = closeModal;
      box.querySelectorAll('.vmx-ss-tab').forEach((b) => { b.onclick = () => { activeSlot = Number(b.dataset.slot); render(); }; });
      box.querySelector('#vmxSsDest').onchange = (e) => { s.dest = e.target.value; render(); };
      const urlEl = box.querySelector('#vmxSsUrl'); if (urlEl) urlEl.oninput = (e) => { s.customUrl = e.target.value; };
      box.querySelector('#vmxSsKey').oninput = (e) => { s.key = e.target.value; };
      box.querySelector('#vmxSsQ').onchange = (e) => {
        s.quality = e.target.value;
        render();
        // The warning below the picker has to be right about THIS choice, and
        // only the main process knows the rule the hub will actually apply.
        refreshMismatch(() => { if (!refs.vmxModal.classList.contains('hidden')) render(); });
      };
      const fitMode = box.querySelector('#vmxSsFitMode');
      if (fitMode) fitMode.onchange = async (e) => {
        const off = e.target.value === 'off';
        try { await window.api.settings.update({ autoFitBitrate: off ? 'off' : 'auto' }); } catch (er) {}
        st.settings = Object.assign({}, st.settings, { autoFitBitrate: off ? 'off' : 'auto' });
        toast(off
          ? '📶 Auto-fit off — the stream will stay at the chosen quality even when your internet cannot carry it.'
          : '📶 Auto-fit on — the picture will be lowered automatically rather than stuttering.',
          off ? '' : 'good');
        render();
      };
      box.querySelector('#vmxSsAudioQ').onchange = async (e) => {
        await saveLiveCfg({ audioQuality: e.target.value });
        render();
        toast(st.streams.some((x) => x.streaming)
          ? '🎵 Sound quality saved — it takes effect when you restart the stream.'
          : '🎵 Sound quality saved.', 'good');
      };
      const matchBtn = box.querySelector('#vmxSsMatch');
      if (matchBtn) matchBtn.onclick = () => { matchDestinationQualities(activeSlot); render(); };
      const upBtn = box.querySelector('#vmxSsUplink');
      if (upBtn) upBtn.onclick = () => runUplinkTest(() => { if (!refs.vmxModal.classList.contains('hidden')) render(); });
      const fitBtn = box.querySelector('#vmxSsFit');
      if (fitBtn) fitBtn.onclick = () => { fitMyUpload(); render(); refreshMismatch(() => { if (!refs.vmxModal.classList.contains('hidden')) render(); }); };
      box.querySelector('#vmxSsStartAll').onclick = async () => {
        if (st.streams.some((x) => x.streaming)) await stopAllStreams(); else await startAllStreams();
        render();
      };
      box.querySelector('#vmxSsStartOne').onclick = async () => {
        if (s.streaming) await stopOneStream(s); else await startOneStream(s);
        render();
      };
      box.querySelector('#vmxSsStatus').onclick = openStreamStatusModal;
      box.querySelector('#vmxSsClose').onclick = async () => {
        await persistStreams();
        refs.vmxModalBox.className = 'vmx-modal-box';
        closeModal();
        toast('✅ Streaming settings saved.', 'good');
      };
    }

    refs.vmxModal.classList.remove('hidden');
    render();
    refreshMismatch(() => { if (!refs.vmxModal.classList.contains('hidden')) render(); });
  }

  function openStreamStatusModal() {
    refs.vmxModalBox.className = 'vmx-modal-box';
    openModal(
      `<h3>📡 Streaming Status <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-list">` +
      st.streams.map((s) => {
        const health = s.streaming ? (s.lastStats && s.lastStats.speed && s.lastStats.speed < 0.92 ? '⚠️ struggling' : '✅ healthy') : '';
        const bitrate = s.streaming && s.lastStats && s.lastStats.bitrateKbps ? Math.round(s.lastStats.bitrateKbps) + ' kbps' : '';
        const state = s.streaming
          ? (s.reconnecting ? `🔄 reconnecting (attempt ${s.reconnecting.attempt}/${s.reconnecting.of})` : `🔴 LIVE ${bitrate} ${health}`)
          : 'Offline';
        return `<div class="vmx-list-item"><b>${s.num}.</b>&nbsp;${esc(destLabel(s))} — ${state}</div>`;
      }).join('') +
      `</div>` +
      `<p class="vmx-note">⚙ Program encoder: <b>${esc(st.encoderLabel || 'starting…')}</b> — encoded once and shared by all ${programConsumers()} output(s).</p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxSsStatusBack">Back</button></div>`);
    refs.vmxModalBox.querySelector('#vmxSsStatusBack').onclick = openStreamSettingsModal;
  }

  /* ------- help ------- */

  function openHelpModal() {
    openModal(
      `<h3>❓ How the switcher works <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-help-body">` +
      `<p><b>1. Add Input</b> — add your cameras, videos, images, titles and microphones to the bar at the bottom.</p>` +
      `<p><b>2. Click an input</b> to put it on the <span class="pv-chip">PREVIEW</span> (left, orange) monitor.</p>` +
      `<p><b>3. Press Cut / Fade</b> (or drag the T-bar) to take it to the <span class="pgm-chip">PROGRAM</span> (right, green) monitor — the program is what gets recorded and streamed.</p>` +
      `<p><b>Quick Play</b> restarts a video and fades it straight to program. <b>FTB</b> fades the whole program (and sound) to black.</p>` +
      `<p><b>Overlays 1-4</b> — the numbered buttons on each input show it ON TOP of the program (titles, lower thirds, picture-in-picture).</p>` +
      `<p><b>Audio</b> — with auto-mix on, you hear whichever inputs are on the program; microphone inputs are always live when their Audio button is green.</p>` +
      `<p><b>Record</b> saves an MP4 to your output folder. <b>Stream</b> pushes to up to 7 destinations at once — Facebook, YouTube, and/or a custom RTMP server (set each up in the ⚙ next to Stream). <b>External</b> opens the program in its own window for a projector.</p>` +
      `<p>Shortcuts: <b>1-9</b> select preview · <b>Enter</b> cut · <b>Space</b> fade · <b>B</b> fade to black.</p>` +
      `</div>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxHelpOk">Got it</button></div>`);
    refs.vmxModalBox.querySelector('#vmxHelpOk').onclick = closeModal;
  }

  /* ============================ OUTPUT STREAM ============================= */

  function buildOutStream(fpsWanted) {
    if (st.outStream) return st.outStream;
    ensureLoop();
    ensureAudio();
    // Capture at the production frame rate (camera-matched on 'auto') — the
    // encoder is told the same rate, so no frames are duplicated or dropped.
    // A broadcast may ask for a lower one (affordableStreamFps): it MUST be the
    // rate the canvas is captured at too, or the encoder is fed 60 frames a
    // second while being paid for 30 and every second frame is thrown away.
    const fps = Number(fpsWanted) || productionFps();
    const vs = refs.vmxPgmCanvas.captureStream(fps);
    const out = new MediaStream([vs.getVideoTracks()[0], st.dest.stream.getAudioTracks()[0]]);
    st.outStream = out;
    st.outStreamFps = fps;
    return out;
  }

  /**
   * H.264 program capture is only a win when Chromium can hand it to a
   * dedicated GPU encoder (NVENC), which discrete NVIDIA cards do reliably —
   * even alongside the hub's own NVENC session. On Intel/AMD integrated
   * graphics the same request lands on openh264 in SOFTWARE (or fights the
   * hub for the iGPU's single encode session) and falls behind realtime, so
   * everything that isn't NVIDIA stays on the proven VP8 path.
   */
  function gpuIsNvidia() {
    if (st._gpuRenderer == null) {
      let s = '';
      try {
        const cv = document.createElement('canvas');
        const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
        const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
        if (gl && ext) s = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
      } catch (e) {}
      st._gpuRenderer = s;
    }
    return /nvidia|geforce|quadro|\brtx\b/i.test(st._gpuRenderer);
  }

  function pickMime(preferH264) {
    // H.264 first for the PROGRAM capture (and only that): on an NVIDIA GPU it
    // goes to NVENC, taking the whole capture encode off the CPU — software
    // VP8 of a 1080p canvas was costing more than an entire core on its own.
    // The hub's ffmpeg reads either codec from the same container, and H.264 is
    // also the cheaper of the two for it to DECODE. MultiCorder deliberately
    // stays on VP8: it runs SEVERAL recorders at once, which would exhaust
    // encoder sessions. If H.264 capture ever fails at runtime
    // (st.h264CaptureBad), everything falls back to VP8 automatically.
    const prefs = [];
    if (preferH264 && !st.h264CaptureBad && gpuIsNvidia()) prefs.push('video/webm;codecs=h264,opus', 'video/webm;codecs=h264');
    prefs.push('video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm');
    for (const m of prefs) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; }
    return 'video/webm';
  }

  function newRecorder(stream, kbps, onChunk, opts) {
    const preferH264 = !!(opts && opts.h264);
    for (;;) {
      const mime = pickMime(preferH264);
      try {
        const rec = new MediaRecorder(stream, {
          mimeType: mime,
          videoBitsPerSecond: kbps * 1400, // roomy source bitrate; ffmpeg sets the real output rate
          audioBitsPerSecond: 128000,
        });
        rec.ondataavailable = async (ev) => { if (ev.data && ev.data.size) onChunk(await ev.data.arrayBuffer()); };
        rec.start(250);
        return rec;
      } catch (e) {
        // isTypeSupported can say yes while the encoder still refuses to start —
        // blacklist H.264 for this session and retry on VP8 before giving up.
        if (/h264/i.test(mime) && !st.h264CaptureBad) { st.h264CaptureBad = true; continue; }
        throw e;
      }
    }
  }

  /* ------------- WebCodecs GPU capture (H.264 + AAC in fMP4) --------------- */
  /*
   * The MediaRecorder path encodes the program in SOFTWARE (VP8), and the hub
   * ffmpeg then decodes and re-encodes it — two full encodes plus a decode of
   * every frame, which is most of what "Go Live" costs in CPU. When WebCodecs
   * can reach a hardware H.264 encoder (Intel Quick Sync, NVIDIA NVENC and AMD
   * VCN all sit behind the same API — unlike MediaRecorder, which lands on
   * software openh264), the program is encoded ONCE on the GPU, muxed into
   * fragmented MP4 right here, and the hub just remuxes it to MPEG-TS with
   * `-c copy`. Broadcasting then costs compositing plus a remux. MediaRecorder
   * remains the automatic fallback (st.wcBad) so a machine with no usable GPU
   * encoder behaves exactly as before.
   */

  /** Smallest standard H.264 Main-profile level that fits the frame + rate. */
  function avcCodecFor(w, h, fps) {
    const area = w * h;
    if (area <= 1280 * 720 && fps <= 30) return 'avc1.4D401F';  // 3.1
    if (area <= 1920 * 1080 && fps <= 30) return 'avc1.4D4028'; // 4.0
    if (area <= 1920 * 1080) return 'avc1.4D402A';              // 4.2 (1080p60)
    if (fps <= 30) return 'avc1.4D4033';                        // 5.1 (4K30)
    return 'avc1.4D4034';                                       // 5.2
  }

  /**
   * Can this machine capture the program on the GPU? Returns the H.264 codec
   * string to use, or null → use the MediaRecorder path. AAC support is
   * required too so the hub can pass BOTH streams through untouched.
   */
  async function wcSupport(width, height, fps, sampleRate) {
    if (st.wcBad || typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined' ||
        typeof MediaStreamTrackProcessor === 'undefined' || !window.Mp4Muxer) return null;
    const codec = avcCodecFor(width, height, fps);
    try {
      const a = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 128000,
      });
      if (!a || !a.supported) return null;
      const base = { codec, width, height, bitrate: 2500000, framerate: fps,
        latencyMode: 'realtime', avc: { format: 'avc' } };

      const hw = await VideoEncoder.isConfigSupported({ ...base, hardwareAcceleration: 'prefer-hardware' });
      if (hw && hw.supported) { st.wcAccel = 'hardware'; return codec; }

      // A GPU that will not take THIS size and rate is not a reason to abandon
      // WebCodecs. `prefer-hardware` reads as a hard REQUIREMENT to
      // isConfigSupported, not as a preference, and plenty of iGPUs that encode
      // 1080p30 happily report no support at 1080p60 or 4K — measured on the
      // development machine, which answers yes to 720p30 and 1080p30 and no to
      // every 1080p60 and 4K config, at any profile or level.
      //
      // Software WebCodecs still produces H.264 + AAC in fragmented MP4, and the
      // hub remuxes THAT with `-c copy`. The MediaRecorder fallback produces
      // WebM, which the hub has to fully RE-ENCODE before it can go anywhere —
      // once, but on the same machine that is already compositing and feeding
      // every destination. Keeping WebCodecs is worth much more than keeping the
      // encode on the GPU.
      const sw = await VideoEncoder.isConfigSupported(base);
      if (sw && sw.supported) { st.wcAccel = 'software'; return codec; }
      return null;
    } catch (e) { return null; }
  }

  // NOTE deliberately NOT pre-warming the GPU encoder at view-open: Media
  // Foundation's first-use init (~4s on a loaded iGPU) contends with the first
  // <video> element's decoder init and made List/Delay playback start seconds
  // late. Nothing is lost by paying it at broadcast start instead — frames
  // queue through the init and every one still reaches the file/stream (probed:
  // 500/500 frames, 19.93s of a 20s take) — it only delays the first fragment,
  // i.e. a one-time few-second connect delay on iGPUs, sub-second on NVENC.

  /* ================== THE CAPTURE, ON A THREAD OF ITS OWN ==================
   *
   * The engine itself now lives in capture-engine.js and normally runs on the
   * worker in capture-worker.js. Read those two files for how the capture
   * works; this is only the plumbing that gets it started and keeps the rest of
   * the studio's view of it unchanged.
   *
   * WHY. The renderer's main thread composites the program, draws the preview
   * monitor, repaints every source thumbnail, runs the meters and answers the
   * desk. It was ALSO collecting every broadcast frame, pacing them onto a
   * constant grid and driving an H.264 and an AAC encoder. Measured here at
   * 1080p to three platforms: the compositor drew 28.6 fps, the encoder
   * collected 23.0, and each platform received 21.4 of 30 with keyframes up to
   * SIX SECONDS apart — past the four platforms accept. Frames were being drawn
   * and thrown away before anything encoded them, and the pacer (the thing that
   * promises a platform a constant frame rate) stands down whenever the encoder
   * has no headroom, which on a busy main thread is most of the time. A
   * platform handed a stream that claims 30fps and delivers a variable one
   * re-times it onto its own clock, and re-timing the picture STRETCHES THE
   * SOUND to match: that is "Facebook is perfect and YouTube's audio goes weird
   * at 1080p", and the same shared thread is why the preview monitor stuttered.
   *
   * The ladder, in order: worker capture → in-page WebCodecs capture (exactly
   * what shipped before) → MediaRecorder. Each rung is chosen once and stuck to
   * for the session, so a machine never oscillates mid-service.
   */

  /**
   * The capture worker — built once and kept for the life of the studio, with
   * the program-audio tap wired straight into it.
   *
   * The sound goes to the worker as well as the picture, and that is not an
   * optimisation: the engine estimates both tracks' clock epochs from when
   * their samples ARRIVE, so that whatever delay the reading thread is under
   * cancels between them. That only holds while both pumps read on the SAME
   * thread. Leaving the sound on the main thread would place the picture
   * perfectly and leave the sound behind by the whole of the main thread's
   * delay — on exactly the loaded machine least able to afford it.
   */
  function ensureCaptureWorker() {
    if (st._capWorkerPromise) return st._capWorkerPromise;
    st._capWorkerPromise = (async () => {
      if (st.capWorkerBad || typeof Worker === 'undefined' ||
          typeof MediaStreamTrackProcessor === 'undefined') return null;
      let w;
      try { w = new Worker('capture-worker.js'); } catch (e) {
        console.warn('[live] capture worker unavailable, capturing in-page:', e);
        st.capWorkerBad = true;
        return null;
      }
      // A failed importScripts, a syntax error, a security refusal: they all
      // arrive here and they all mean the same thing — capture in-page instead.
      w.onerror = (e) => {
        console.warn('[live] capture worker error:', (e && e.message) || e);
        st.capWorkerBad = true;
        if (st._capWorkerFail) { try { st._capWorkerFail(e); } catch (e2) {} }
      };
      st.capWorker = w;
      await ensureCaptureAudioRouted(w);
      return w;
    })();
    return st._capWorkerPromise;
  }

  /**
   * Route the program-audio worklet to the worker, once it can be.
   *
   * Separate from the worker's own setup because the two are not ready at the
   * same moment: the worklet needs an AudioContext, and a broadcast can be
   * armed before Go Live has ever built one. Caching a failure here alongside
   * the worker would have meant a capture that missed the worklet by a beat
   * read its sound off the media stream for the rest of the session — which
   * works, but throws away the whole reason the worklet exists.
   */
  async function ensureCaptureAudioRouted(w) {
    if (st.capWorkerAudio || !w || st.capWorkerBad) return st.capWorkerAudio;
    const cap = await ensureCaptureWorklet();
    if (!cap) return false;
    st.capWorkerAudio = await routeCaptureAudio(cap, w);
    return st.capWorkerAudio;
  }

  /**
   * Point the program-audio worklet at the worker instead of at this thread.
   *
   * Done ONCE per worker, not once per broadcast: a port nobody is reading
   * queues its messages, so a fresh handshake each time would hand the next
   * broadcast a backlog of sound from before it started. Resolves false if the
   * worklet could not take the port, in which case the sound stays on this
   * thread and the capture falls back in-page.
   */
  function routeCaptureAudio(capNode, worker) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { capNode.port.onmessage = null; } catch (e) {}
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 1500);
      capNode.port.onmessage = (e) => {
        const d = e.data;
        // Anything that is not the acknowledgement is a buffer of sound from
        // before the route took effect. There is no broadcast yet, so it is
        // dropped rather than kept.
        if (d && typeof d.routed === 'boolean') finish(!!d.routed);
      };
      const ch = new MessageChannel();
      try {
        worker.postMessage({ cmd: 'attachAudio', port: ch.port1 }, [ch.port1]);
        capNode.port.postMessage({ cmd: 'route', port: ch.port2 }, [ch.port2]);
      } catch (e) { finish(false); }
    });
  }

  /** Give the worklet's sound back to this thread (the in-page fallback). */
  function unrouteCaptureAudio() {
    if (!st.capWorkerAudio || !st.capNode) return;
    st.capWorkerAudio = false;
    try { st.capNode.port.postMessage({ cmd: 'route', port: null }); } catch (e) {}
  }

  /** Which thread the last capture ran on, and whether its sound went with it. */
  function captureHost() {
    return { worker: !!(st.capWorker && !st.capWorkerBad), audioRouted: !!st.capWorkerAudio };
  }

  /** The program canvas's frames, ready to hand to whichever thread encodes. */
  function programFrameStream(stream) {
    // FOUR FRAMES of cushion, not three seconds: a frame the reader was too
    // busy to collect is simply missing from the broadcast (the platform was
    // promised 30fps and got 25.4 — measured), so a small cushion buys back a
    // real frame rate, while a picture held longer than that is old news on a
    // live stream.
    return new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0], maxBufferSize: 4 }).readable;
  }

  /** …and the sound, for the rare case where there is no capture worklet. */
  function programAudioStream(stream) {
    const t = stream.getAudioTracks()[0];
    if (!t) return null;
    // THREE SECONDS here, because the default holds about ten 10ms buffers and
    // any moment the reader is busy for a tenth of a second loses sound —
    // measured at 1.6s lost in a 25s broadcast. Late sound is still every word
    // the preacher said.
    return new MediaStreamTrackProcessor({ track: t, maxBufferSize: 300 }).readable;
  }

  /**
   * Capture `stream` (program canvas + master audio bus) into a fragmented MP4
   * chunk feed. Returns an object with the same surface the rest of the studio
   * expects from a MediaRecorder — state / stop() / onstop / onerror /
   * mimeType — so every stop/restart path works unchanged, plus setBitrate,
   * setPad, clockDiag and fillerStats.
   */
  function startWcCapture(stream, cfg, onChunk) {
    const w = st.capWorker;
    if (w && !st.capWorkerBad) {
      try { return startWcCaptureOnWorker(w, stream, cfg, onChunk); }
      catch (e) {
        console.warn('[live] could not start the capture worker, capturing in-page:', e);
        st.capWorkerBad = true;
      }
    }
    return startWcCaptureInPage(stream, cfg, onChunk);
  }

  /** The engine on the worker. Everything below is message passing. */
  function startWcCaptureOnWorker(w, stream, cfg, onChunk) {
    const sid = (st._capSeq = (st._capSeq || 0) + 1);
    const useWorklet = !!(cfg.capNode && st.capWorkerAudio);
    const video = programFrameStream(stream);
    const audio = useWorklet ? null : programAudioStream(stream);
    const eng = {
      state: 'recording', onstop: null, onerror: null,
      mimeType: 'video/mp4;codecs=h264,aac',
      videoKbps: cfg.videoKbps,
      // Which rung of the ladder failed, so the caller knows whether to give up
      // on WebCodecs itself or only on running it over there.
      _failKind: 'codec', _worker: true,
    };
    let diag = null, fillerStats = null, onStopped = null, failed = false;

    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.sid && m.sid !== sid) return;      // a message from a dead session
      switch (m.t) {
        case 'chunk': onChunk(m.buf); break;
        case 'diag':
          diag = m.clock; fillerStats = m.filler;
          if (m.videoKbps) eng.videoKbps = m.videoKbps;
          break;
        case 'rate':
          // The hub was already told yes (see setBitrate). Only a REFUSAL has
          // to travel, or it spends the service believing it is sending less
          // than it is. hub.rateApplied ignores a second `true`.
          if (!m.ok) { try { window.api.live.bitrateApplied(m.kbps, false); } catch (e) {} }
          break;
        case 'stopped': if (onStopped) onStopped(); break;
        case 'fail': {
          if (failed || eng.state === 'inactive') break;
          failed = true;
          // A WebCodecs failure, exactly as before: this machine's GPU capture
          // is not dependable, so the session restarts on MediaRecorder.
          st.wcBad = true;
          console.warn('GPU capture failed — falling back to software capture:', m.message);
          if (eng.onerror) { try { eng.onerror(new Error(m.message)); } catch (e) {} }
          break;
        }
        default: break;
      }
    };
    w.addEventListener('message', onMsg);
    // A broken WORKER is not a broken encoder: the next session should try
    // WebCodecs again, in-page, rather than dropping to MediaRecorder.
    const workerFail = (e) => {
      if (failed || eng.state === 'inactive') return;
      failed = true;
      eng._failKind = 'worker';
      unrouteCaptureAudio();
      if (eng.onerror) { try { eng.onerror(e instanceof Error ? e : new Error(String(e))); } catch (e2) {} }
    };
    st._capWorkerFail = workerFail;

    const transfer = [video];
    if (audio) transfer.push(audio);
    w.postMessage({
      cmd: 'start', sid, video, audio, fromWorklet: useWorklet,
      cfg: {
        width: cfg.width, height: cfg.height, fps: cfg.fps,
        videoKbps: cfg.videoKbps, audioKbps: cfg.audioKbps,
        codec: cfg.codec, accel: cfg.accel, sampleRate: cfg.sampleRate,
        padKbps: cfg.padKbps || 0, padFloorKbps: cfg.padFloorKbps || 0,
        // Collecting the picture over here is quicker than doing it behind the
        // compositor, so the sound needs MORE of a lead to land on it. Measured
        // on a real ingest — see PACER_LEAD_FRAMES for the readings and for why
        // half a frame is not false precision.
        pacerLeadFrames: 2.5,
        // Test-only (see __test.setCaptureTuning); undefined in every real run.
        ...(st._capTuning || {}),
      },
    }, transfer);

    eng.stop = async () => {
      if (eng.state === 'inactive') return;
      eng.state = 'inactive';
      // The worker flushes both encoders and finalises the muxer before it
      // answers, so the closing fragments are already through by then. The
      // timeout is only so a wedged worker cannot hold up the desk.
      await new Promise((res) => {
        let done = false;
        const fin = () => { if (!done) { done = true; res(); } };
        onStopped = fin;
        const t = setTimeout(fin, 6000);
        try { w.postMessage({ cmd: 'stop', sid }); } catch (e) { clearTimeout(t); fin(); }
      });
      w.removeEventListener('message', onMsg);
      if (st._capWorkerFail === workerFail) st._capWorkerFail = null;
      if (eng.onstop) { try { eng.onstop(); } catch (e) {} }
    };
    /*
     * Auto-fit answers OPTIMISTICALLY. The hub asks for a rate and wants a
     * yes/no in the same breath; the encoder is a thread away. A refusal is
     * both rare (only a closed or failing encoder refuses) and self-correcting
     * — the worker sends it back a moment later and the hub is told then — so
     * the alternative, making every rate change a round trip, would cost more
     * than it protects.
     */
    eng.setBitrate = (kbps) => {
      const want = Math.max(100, Math.round(kbps || 0));
      if (eng.state === 'inactive' || failed) return false;
      try { w.postMessage({ cmd: 'setBitrate', sid, kbps: want }); } catch (e) { return false; }
      eng.videoKbps = want;
      return true;
    };
    eng.setPad = (kbps, floorKbps) => {
      if (eng.state === 'inactive' || failed) return false;
      try { w.postMessage({ cmd: 'setPad', sid, kbps, floorKbps }); } catch (e) { return false; }
      return true;
    };
    /*
     * The desk reads these synchronously — the auto-fit banner, the gate that
     * waits for a real picture before a destination is told to go live, the
     * test hooks. A cross-thread read cannot be synchronous, so the worker
     * pushes a snapshot every 120ms and this hands back the latest one.
     * Nothing here decides anything a tenth of a second could change: the
     * picture gate polls for seconds and the banners judge over fifteen.
     */
    eng.clockDiag = () => diag;
    eng.fillerStats = () => fillerStats;
    return eng;
  }

  /**
   * The same engine, in this page, on the main thread — what shipped before
   * the worker existed. Reached only when a worker cannot be created or has
   * failed, so it is the safety net rather than the road.
   */
  function startWcCaptureInPage(stream, cfg, onChunk) {
    // The worklet may still be posting its sound to a worker that has since
    // gone wrong; take it back before reading it here.
    unrouteCaptureAudio();
    const capNode = cfg.capNode || null;
    const eng = CaptureEngine.create({
      cfg: {
        width: cfg.width, height: cfg.height, fps: cfg.fps,
        videoKbps: cfg.videoKbps, audioKbps: cfg.audioKbps,
        codec: cfg.codec, accel: cfg.accel, sampleRate: cfg.sampleRate,
        padKbps: cfg.padKbps || 0, padFloorKbps: cfg.padFloorKbps || 0,
      },
      video: programFrameStream(stream),
      fromWorklet: !!capNode,
      audio: capNode ? null : programAudioStream(stream),
      onChunk,
      onFail: (e) => {
        // GPU capture on this machine is not dependable — the session restarts
        // on the proven MediaRecorder path and stays there.
        st.wcBad = true;
        console.warn('GPU capture failed — falling back to software capture:', e);
      },
    });
    eng._failKind = 'codec';
    if (capNode) {
      capNode.port.onmessage = (e) => {
        const d = e.data;
        if (!d || typeof d.routed === 'boolean') return;   // a routing ack
        eng.feedAudio(d);
      };
      const stopEngine = eng.stop;
      eng.stop = async () => {
        try { capNode.port.onmessage = null; } catch (e) {}
        await stopEngine();
      };
    }
    return eng;
  }

  /* ---------------------- the shared program encoder ---------------------- */
  /*
   * Everything that consumes the program — each streaming destination, Record
   * and Instant Replay — shares ONE capture and ONE encode. Consumers are
   * reference-counted: the first one to start brings the encoder up, the last
   * one to stop takes it down. Anything can join or leave mid-broadcast without
   * disturbing the others.
   */

  function programConsumers() {
    return st.streams.filter((s) => s.streaming).length + (st.recording ? 1 : 0) + (st.replayArmed ? 1 : 0);
  }

  /**
   * Bitrate for the shared encode. The most demanding consumer wins, because a
   * destination whose settings match the shared encode exactly can be copied
   * straight through with no second encode at all — whereas one that wants MORE
   * than the shared encode carries would have to be upscaled from it, which is
   * both wasteful and visibly worse.
   *
   * `pending` must list EVERY consumer about to start, not just the first one:
   * sizing this from whichever destination happened to go first is what once
   * left a 720p broadcast encoded at a 480p destination's bitrate.
   */
  function programQuality(pending) {
    const qs = st.streams.filter((s) => s.streaming).map((s) => resolveQ(s.quality));
    if (st.recording || st.replayArmed) qs.push(quality());
    for (const p of (pending || [])) if (p) qs.push(p);
    if (!qs.length) qs.push(quality());
    return {
      videoKbps: qs.reduce((m, x) => Math.max(m, x.videoKbps), 0),
      // The SOUND is not sized from the presets. Every one of them says 128
      // kbps because vMix's list does, and 128 is where a singing congregation
      // starts to sound watery. The operator's own choice wins, and because
      // every destination copies the hub's audio through untouched, one
      // encode at the better rate serves all of them for free.
      audioKbps: Math.max(streamAudioKbps(), qs.reduce((m, x) => Math.max(m, x.audioKbps), 0)),
    };
  }

  /*
   * WHAT THE PLATFORM WILL ASK FOR, ANSWERED IN THE PAGE.
   *
   * The authority is src/main/streamrate.js; the tier table is handed over by
   * the preload bridge so this can answer while a dialog is being drawn,
   * without a round trip. Only the lookup is repeated here, never the table —
   * and test:ytbitrate walks every preset size through both and fails if the
   * two ever give different answers.
   */
  /*
   * A fallback copy, for the same reason FALLBACK_QUALITY above has one: the
   * bridge cannot deliver this in a sandboxed preload, and an empty table would
   * not throw — it would simply answer "0" for every size and take the
   * under-rated warning silently off the air, which is the one failure nobody
   * would notice. test:ytbitrate walks every shipped preset size through this
   * table AND the main process's and fails if they ever disagree.
   */
  const FALLBACK_TIERS = [
    { h: 2160, fps: 60, min: 20000, max: 51000, rec: 35500 },
    { h: 2160, fps: 30, min: 13000, max: 34000, rec: 23500 },
    { h: 1440, fps: 60, min: 9000, max: 18000, rec: 13500 },
    { h: 1440, fps: 30, min: 6000, max: 13000, rec: 9500 },
    { h: 1080, fps: 60, min: 4500, max: 9000, rec: 6800 },
    { h: 1080, fps: 30, min: 3000, max: 6000, rec: 4500 },
    { h: 720, fps: 60, min: 2250, max: 6000, rec: 4100 },
    { h: 720, fps: 30, min: 1500, max: 4000, rec: 2800 },
    { h: 480, fps: 30, min: 500, max: 2000, rec: 1300 },
    { h: 360, fps: 30, min: 400, max: 1000, rec: 700 },
    { h: 240, fps: 30, min: 300, max: 700, rec: 500 },
  ];
  const RATE_TIERS = ((bridgeLive.rateTiers && bridgeLive.rateTiers.length)
    ? bridgeLive.rateTiers : FALLBACK_TIERS).slice();
  function platformBand(width, height, fps) {
    const col = Number(fps) > 32 ? 60 : 30;
    const rows = RATE_TIERS.filter((t) => t.fps === col);
    const side = Math.min(Number(width) || 0, Number(height) || 0);
    if (!rows.length || !side) return null;
    const exact = rows.find((t) => t.h === side);
    if (exact) return exact;
    // Between two tiers, the bigger one is the safe read: under-asking is the
    // failure this whole area exists to remove.
    return rows.filter((t) => t.h >= side).pop() || rows[0];
  }
  /** The one number the platform compares the arriving stream against. */
  function platformRecKbps(width, height, fps) {
    const b = platformBand(width, height, fps);
    return b ? b.rec : 0;
  }

  /**
   * The preset whose picture this many kbps can actually pay for in full.
   *
   * Named rather than described, because the operator has to find it in a
   * dropdown while a service is running — "try about 2.8 mbps" is not something
   * anybody can act on with a congregation waiting.
   */
  function smallerPictureThatFits(kbps, fps, portrait, currentShortSide) {
    const col = Number(fps) > 32 ? 60 : 30;
    /*
     * STRICTLY smaller than what is being sent — which stopped being automatic
     * the moment auto-fit gained a floor at the platform's own price.
     *
     * The rate is now held AT what the picture costs, so "the biggest tier this
     * rate can pay for" is the tier already being sent, and the banner ended up
     * with no advice to give at exactly the moment it had something to say:
     * measured on two 1080p destinations on a two-core laptop, the rate sat at
     * 4500 (correct — that is what 1080p30 costs) while the machine could only
     * encode 24.9 fps of it, and the sentence that names the way out came back
     * empty. The way out is a SMALLER PICTURE; naming the current one is not
     * advice.
     */
    const side = Math.round(Number(currentShortSide) || 0);
    const rows = RATE_TIERS.filter((t) => t.fps === col && t.rec <= kbps && (!side || t.h < side));
    for (const t of rows) {                     // largest first
      const key = Object.keys(QUALITY).find((k) => {
        const q = QUALITY[k];
        return q && !q.profile && Math.min(q.width, q.height) === t.h &&
          (portrait ? q.height > q.width : q.width >= q.height) &&
          (q.videoKbps || 0) >= t.rec && QUALITY_GROUPS.some((g) => g.keys.includes(k));
      });
      if (key) return key;
    }
    return '';
  }

  /**
   * What the line was last MEASURED to give one destination, in kbps — 0 when
   * it has never been measured.
   *
   * This is the ceiling on chasing a platform's recommendation. Asking for
   * 6800 kbps on a line that can feed 3000 does not make YouTube happy; it
   * makes auto-fit pull the rate back down while the picture judders on the
   * way, and the warning comes back anyway. The honest answer on that line is a
   * SMALLER PICTURE, which is what the pre-flight note now offers.
   */
  /**
   * What the measured line can give ONE destination, once it is shared.
   *
   * `sharing` is how many destinations will actually be on air — which is not
   * the same thing as how many are configured, and the difference was a bug
   * with the operator's name on it. This used to count every slot that had a
   * KEY SAVED IN SETTINGS, so a Facebook key typed in once and never used
   * halved the line for a YouTube-only service, for ever. On a 12.49 Mbps line
   * that is 12490 × 0.66 / 2 − 160 = 3962 kbps handed to a picture YouTube
   * charges 4500 for — under-rated, on a line with almost three times the
   * headroom needed, while streaming to one platform.
   *
   * A destination that is not broadcasting is not using the line.
   */
  function measuredLineKbps(sharing) {
    const lv = liveCfg();
    const mbps = Number(lv.lastUplinkMbps) || 0;
    if (!mbps || !uplinkIsFresh()) return 0;
    const dests = Math.max(1, Math.round(Number(sharing) || 0)
      || st.streams.filter((s) => s.streaming).length || 1);
    // USABLE (uplink.js) is the same two thirds the pre-flight plans against —
    // one number, so the check and the encoder cannot give different answers.
    const usable = mbps * 1000 * (bridgeLive.uplinkUsable || 0.66);
    return Math.max(0, Math.round(usable / dests) - streamAudioKbps());
  }

  /*
   * HOW LONG A MEASUREMENT OF THE LINE IS WORTH ANYTHING.
   *
   * This number caps the broadcast (see platformKbps): the app will not chase a
   * platform's recommended bitrate past what the line has been shown to carry.
   * That is right for a measurement taken tonight and catastrophic for one
   * taken any other night — and until now there was no difference between them.
   * `lastUplinkAt` was written and never read, so ONE bad reading (a phone
   * hotspot, a busy afternoon, a different building) capped every service from
   * then on, for good, with nothing on screen to say so.
   *
   * Worked through on the real complaint: a single stored 3.7 Mbps gives
   * 3700 × 0.66 − 160 = 2282 kbps, and YouTube reported **2278.74 Kbps against
   * a recommended 6800** — the same stream, the same service, every week.
   *
   * So a measurement is evidence about the line it was taken on, and it expires
   * with the sitting. Past that, the platform's own rate for the picture is used
   * (which is what makes the warning go away on a line that was always fine),
   * and auto-fit — which measures the line continuously, from the traffic
   * actually going out — remains the thing that copes if it is not.
   */
  const UPLINK_FRESH_MS = 6 * 60 * 60 * 1000;
  function uplinkAgeMs() {
    const at = Number(liveCfg().lastUplinkAt) || 0;
    return at ? Math.max(0, Date.now() - at) : Infinity;
  }
  const uplinkIsFresh = () => uplinkAgeMs() <= UPLINK_FRESH_MS;

  /**
   * The frame rate a BROADCAST may run at on 'Auto'.
   *
   * 'Auto' means "match my camera", and on a 60fps camera that quietly doubles
   * the bill: YouTube charges 1080p60 at 6800 kbps against 1080p30's 4500, and
   * nobody chose 60 — the camera did. A church service is 30fps content, and a
   * starved 60fps stream does not even look like 60fps: it sheds frames, and
   * the platform reports it as under-fed for the whole service.
   *
   * So on 'Auto', a stream runs at 60 only when the line has been MEASURED,
   * recently, to afford the 60fps rate for the picture being sent. Otherwise it
   * halves cleanly — 60→30, 50→25, so every frame of the source still lands on
   * a frame of the broadcast and nothing is pulled down. An operator who picks a
   * rate in Streaming Settings always gets exactly that rate, and RECORDINGS are
   * untouched: a file has no platform to be under-rated by, so a 60fps NDI feed
   * still records at 60.
   */
  function affordableStreamFps(raw, width, height) {
    const rate = Number(raw) || 30;
    const mode = (st.settings && st.settings.live && st.settings.live.fpsMode) || 'auto';
    if (mode !== 'auto') return rate;            // they chose a number; it is not ours to move
    if (rate <= 32) return rate;
    const half = rate % 25 === 0 ? 25 : 30;      // 50→25, 60→30: a clean halving, never a pulldown
    /*
     * Two separate permissions, because 60fps needs both: a line that can PAY
     * for what the platform charges at 60, and an encoder that can MAKE 60. On
     * a machine whose capture fell back to software, 1080p60 is not a quality
     * setting, it is a slideshow with a high bill. `st.wcAccel` is only known
     * once a capture has run in this session; before that the line decides
     * alone, and auto-fit and the on-air banner remain the safety net they
     * already were.
     */
    if (st.wcAccel === 'software') return half;
    const cap = measuredLineKbps();              // 0 unless measured, recently
    if (cap && cap >= platformRecKbps(width, height, rate)) return rate;
    return half;
  }

  /**
   * Say it, once, when a broadcast is not running at the camera's rate.
   *
   * Halving the frame rate is a visible decision about someone's service and it
   * must never be silent — but it is also not a problem, so it is said once, in
   * the language of the thing it prevents, with the way to get 60 back.
   */
  function noteStreamFpsCap(forStream, raw, used, width, height) {
    if (!forStream || !(raw > 32) || used >= raw || st._fpsCapSaid === used) return;
    st._fpsCapSaid = used;
    const need = platformRecKbps(width, height, raw);
    toast(`🎞 Streaming at ${used}fps rather than your camera's ${Math.round(raw)}fps. `
      + `At ${Math.round(raw)}fps the platform charges ${(Math.round(need / 100) / 10)} mbps for this picture, `
      + `and your upload has not been measured recently enough to promise that — a starved ${Math.round(raw)}fps `
      + `stream is reported as a low bitrate and sheds frames anyway. `
      + `Streaming Settings → “Test my upload” unlocks it, or pick a rate there to fix it exactly.`, 'good', 12000);
  }

  /**
   * Wait until the capture has genuinely encoded some picture.
   *
   * `vOut` is the number of video chunks the capture has handed to the muxer,
   * so it is the honest answer to "is there a picture in this stream yet?" —
   * not "has the encoder been asked for one". Half a second of frames is
   * plenty for the hub to have emitted a keyframe with its parameter sets.
   * Gives up after `ms` rather than refusing to go live: a broadcast with no
   * camera at all must still reach the platform, with its sound.
   */
  async function waitForPictureFlowing(rec, ms = 6000, frames = 12) {
    if (!rec || typeof rec.clockDiag !== 'function') return false;
    const t0 = Date.now();
    for (;;) {
      let d = null;
      try { d = rec.clockDiag(); } catch (e) { return false; }
      if (d && (d.vOut || 0) >= frames) return true;
      if (Date.now() - t0 >= ms) {
        console.warn('[live] going live without a settled picture after ' + ms + 'ms', d);
        return false;
      }
      await new Promise((r) => setTimeout(r, 80));
    }
  }

  /** How many destinations will be sharing the line: the ones already on air
   *  plus the ones this call is about to put on air. A slot sitting in settings
   *  with a key in it is neither. */
  function destinationsSharingLine(pending) {
    return Math.max(1, st.streams.filter((s) => s.streaming).length + ((pending && pending.length) || 0));
  }

  /** The AAC bitrate the shared encode runs at (Streaming Settings → Sound). */
  function streamAudioKbps() {
    const id = liveCfg().audioQuality || DEFAULT_AUDIO_QUALITY;
    const a = AUDIO_QUALITIES.find((x) => x.id === id) || AUDIO_QUALITIES.find((x) => x.id === DEFAULT_AUDIO_QUALITY);
    return (a && a.kbps) || 160;
  }

  /**
   * Bring the program encoder up if it isn't already. `pending` lists the
   * qualities of the consumers about to start, so the shared encode is sized for
   * all of them from the first frame rather than after the fact.
   */
  async function ensureProgramEncoder(pending, opts) {
    // Is a PLATFORM watching this encode, or only a file? Only a platform has a
    // recommended bitrate to fall short of, and only a platform is worth
    // padding a still slide up to — see platformKbps and h264-filler.js.
    const forStream = st.streams.some((s) => s.streaming) || !!(opts && opts.forStream);
    if (st.pgmRec) return upgradeCaptureForStream(forStream, pending);
    const q = programQuality(pending);
    // The canvas is the authority on frame size — the encoder must match what
    // is actually being captured, never what a preset says it should be.
    const W = refs.vmxPgmCanvas.width, H = refs.vmxPgmCanvas.height;
    /*
     * The rate is decided BEFORE the capture stream exists, because the capture
     * has to be created at it. On 'Auto' a broadcast is not allowed to take a
     * 60fps camera's rate unless the line has been measured to afford what the
     * platform charges for 60fps — see affordableStreamFps.
     */
    const wantFps = forStream ? affordableStreamFps(productionFps(), W, H) : productionFps();
    const stream = buildOutStream(wantFps);
    const sid = Date.now();
    const fps = st.outStreamFps || wantFps;
    noteStreamFpsCap(forStream, productionFps(), fps, W, H);
    ensureAudio();
    // Built before the encoder asks for it: the tap has to be on the bus and
    // running before the first sample of the broadcast goes past.
    await ensureCaptureWorklet();
    // …and the thread that will do the encoding, with that tap wired into it.
    // Both are one-time: a second broadcast finds them already there. The
    // routing is re-attempted rather than cached-as-failed, because the worklet
    // and the worker do not become ready at the same moment.
    await ensureCaptureAudioRouted(await ensureCaptureWorker());
    const wcCodec = await wcSupport(W, H, fps, st.ac.sampleRate);
    let hubFormat = 'webm';
    // What this capture actually encodes at. Normally the preset — but if
    // auto-fit has already had to come down (a capture re-created mid-service),
    // starting again at the preset would put the judder straight back.
    let capKbps = q.videoKbps;
    try {
      const info = await window.api.live.session({
        sid, width: W, height: H,
        videoKbps: q.videoKbps, audioKbps: q.audioKbps, fps,
        // What the AAC in this capture is REALLY at. The hub hands a
        // destination `-c:a copy` on the grounds that the sound is already
        // 48 kHz AAC; that was an assumption about the sound card, and on a
        // machine that would not open at 48 kHz it was wrong and silently so.
        // Telling the hub the truth lets it re-encode rather than promise.
        sampleRate: st.ac ? st.ac.sampleRate : PROGRAM_SAMPLE_RATE,
        format: wcCodec ? 'mp4' : 'webm',
        forStream, lineCapKbps: measuredLineKbps(destinationsSharingLine(pending)),
        // "Never send less than this" — see the Streaming Settings note.
        minKbps: liveCfg().minKbps || 'auto',
      });
      st.encoderLabel = (info && info.encoderLabel) || '';
      /*
       * The hub's answer is the AUTHORITY, not a second opinion to be clamped
       * against the preset. It is the preset raised to what the platform wants
       * for this picture (platformKbps) and then lowered by anything auto-fit
       * has already had to give up — taking Math.min with the preset here is
       * what used to throw the raise away and send YouTube an under-rated
       * 1080p stream on a line that could easily have fed it.
       */
      if (info && info.videoKbps) capKbps = info.videoKbps;
      st.fit = { on: !!(info && info.autoFit), kbps: capKbps,
        ceiling: (info && info.ceilingKbps) || q.videoKbps,
        floor: (info && info.floorKbps) || 0,
        // the shape actually going out, so the banner can compare it with what
        // the platform expects for that shape rather than with a preset
        w: W, h: H, fps, forStream };
      // only run GPU capture if the hub CONFIRMED it will read MP4 — an older
      // main process (or test harness) that ignores the field echoes nothing
      // and keeps the proven WebM path
      hubFormat = wcCodec && info && info.format === 'mp4' ? 'mp4' : 'webm';
    } catch (e) {
      toast('⚠️ Could not start the program encoder: ' + (e.message || e), 'error');
      return false;
    }
    st.pgmSid = sid;
    st.chunksSent = 0;
    const onChunk = (buf) => {
      st.chunksSent++;
      if (st.recording) st.recChunksSent = st.chunksSent;
      window.api.live.chunk(sid, buf);
    };
    try {
      st.pgmRec = hubFormat === 'mp4'
        ? startWcCapture(stream, { width: W, height: H, fps, videoKbps: capKbps, audioKbps: q.audioKbps,
                                   codec: wcCodec, accel: st.wcAccel, sampleRate: st.ac.sampleRate,
                                   capNode: st.capNode || null,
                                   // pad a still slide up to the rate we promised — but only
                                   // when a platform is watching (see h264-filler.js)
                                   padKbps: forStream ? capKbps : 0,
                                   // …and keep padding all the way down to what the
                                   // PLATFORM charges, not just to what we planned
                                   padFloorKbps: forStream ? platformRecKbps(W, H, fps) : 0 }, onChunk)
        : newRecorder(stream, q.videoKbps, onChunk, { h264: true });
      // 'gpu'  — WebCodecs on the GPU encoder, hub remuxes with -c copy
      // 'wcsw' — WebCodecs in software, hub STILL remuxes with -c copy
      // 'sw'   — MediaRecorder/WebM, hub has to re-encode
      st.pgmCaptureMode = hubFormat !== 'mp4' ? 'sw' : (st.wcAccel === 'software' ? 'wcsw' : 'gpu');
      st.pgmPadded = !!(forStream && hubFormat === 'mp4');
    } catch (e) {
      // GPU capture refused to start (wcBad is already set by its fail handler)
      // — retry once on the software path before giving up.
      if (hubFormat === 'mp4') return restartProgramEncoderSession(pending, { forStream });
      toast('⚠️ Could not capture the program: ' + (e.message || e), 'error');
      return false;
    }
    const rec = st.pgmRec;
    rec.onerror = () => {
      // A runtime capture failure (driver hiccup, encoder session limit) falls
      // back to the software path for the rest of the session; the restart is
      // invisible to the destinations either way.
      //
      // Except when it was the capture WORKER that broke rather than the
      // encoder: WebCodecs is fine there, so the next session should try it
      // again in-page rather than dropping all the way to MediaRecorder and
      // handing the hub a whole extra decode+encode for the rest of the
      // service. `capWorkerBad` has already been set, so it cannot loop.
      if (rec.mimeType.startsWith('video/mp4')) { if (rec._failKind !== 'worker') st.wcBad = true; }
      else if (/h264/i.test(rec.mimeType || '')) st.h264CaptureBad = true;
      restartProgramEncoder();
    };
    refreshTargetFps();
    return true;
  }

  /**
   * RECORD FIRST, GO LIVE SECOND — the ordinary order of a service.
   *
   * The encode is created by whichever consumer starts first, and a recording
   * has no platform to satisfy: it is sized at the preset and never padded,
   * because nothing is watching a FILE for a steady bitrate and a service is
   * long enough that padding one costs gigabytes.
   *
   * Then the operator goes live, and this function used to be a bare
   * `if (st.pgmRec) return true` — so the broadcast ran for the whole service
   * at the rate a file was sized for, under what the platform charges for the
   * picture, with the entire fix silently bypassed by the commonest order of
   * operations there is.
   *
   * Nothing is restarted to correct it. The rate can be changed in place (the
   * same mechanism auto-fit uses), the pad can be switched on in place, and the
   * hub is told so its ceiling and its "is this destination behind?" arithmetic
   * are about the stream that is actually going out. A restart here would put a
   * gap in a recording that was already running, at the exact moment somebody
   * pressed the button they care most about.
   */
  async function upgradeCaptureForStream(forStream, pending) {
    const rec = st.pgmRec;
    if (!forStream || !rec || !rec.setPad || st.pgmPadded) return true;
    const W = refs.vmxPgmCanvas.width, H = refs.vmxPgmCanvas.height;
    const fps = st.outStreamFps || productionFps();
    const q = programQuality(pending);
    const want = Math.max(q.videoKbps, platformRecKbps(W, H, fps));
    const cap = measuredLineKbps(destinationsSharingLine(pending));
    const target = Math.max(q.videoKbps, cap > 0 ? Math.min(want, cap) : want);
    let applied = target;
    try {
      // The hub owns the ceiling; it answers with what it will actually run at.
      if (window.api.live.rerate) applied = (await window.api.live.rerate(target)) || target;
    } catch (e) { applied = target; }
    if (rec.setBitrate) rec.setBitrate(applied);
    rec.setPad(applied, platformRecKbps(W, H, fps));
    st.pgmPadded = true;
    st.fit = { ...(st.fit || {}), on: !!(st.fit && st.fit.on), kbps: applied,
      ceiling: applied, w: W, h: H, fps, forStream: true };
    renderFitBanner();
    return true;
  }

  /** A fresh session id + capture after a same-call fallback (GPU → software). */
  function restartProgramEncoderSession(pending, opts) {
    st.pgmRec = null; st.pgmSid = 0;
    return ensureProgramEncoder(pending, opts);
  }

  /** Take the encoder down once nothing is consuming it any more. */
  async function maybeStopProgramEncoder() {
    if (programConsumers() > 0) return;
    st.fit = null;            // the auto-fit banner belongs to a live broadcast
    st.pgmPadded = false;
    renderFitBanner();
    const rec = st.pgmRec;
    st.pgmRec = null; st.pgmSid = 0;
    if (rec && rec.state !== 'inactive') {
      await new Promise((res) => { rec.onstop = res; try { rec.stop(); } catch (e) { res(); } });
    }
    refreshTargetFps();
  }

  /**
   * Hand the main process a brand-new capture session. Used when the capture
   * itself fails, or when main tells us its encoder had to restart: the
   * destinations stay connected throughout because they read a self-
   * synchronising stream, so this is invisible on the platforms.
   */
  async function restartProgramEncoder() {
    if (!programConsumers()) return;
    const rec = st.pgmRec;
    st.pgmRec = null; st.pgmSid = 0;
    if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
    await ensureProgramEncoder(null, { forStream: st.streams.some((s) => s.streaming) });
  }

  /* ------- recording ------- */

  async function toggleRecord() {
    if (st.recording) return stopRecord();
    applyQuality(); // recording resolution = program canvas resolution
    refreshOutStream();
    if (!(await ensureProgramEncoder([quality()]))) return;
    let res;
    try {
      res = await window.api.live.recStart({ recId: 'main', name: 'recording', quality: liveCfg().quality || DEFAULT_QUALITY, fps: st.outStreamFps || productionFps(), audioFormat: liveCfg().recAudioFormat });
    } catch (e) {
      statusMsg('⚠️ Could not start recording: ' + (e.message || e));
      await maybeStopProgramEncoder();
      return;
    }
    st.recFile = res && res.file ? res.file : '';
    st.recChunksSent = 0; st.lastRecEnd = null;
    st.recording = true;
    st.recStartedAt = Date.now();
    refs.vmxRecord.classList.add('on', 'blink');
    refs.vmxStRec.classList.remove('hidden');
    updateAirState();
    toast('● Recording started.', 'good');
  }

  async function stopRecord() {
    if (!st.recording) return;
    st.recording = false;
    try { await window.api.live.recStop('main'); } catch (e) {}
    await maybeStopProgramEncoder();
    refs.vmxRecord.classList.remove('on', 'blink');
    refs.vmxStRec.classList.add('hidden');
    updateAirState();
    toast('💾 Recording saved' + (st.recFile ? ': ' + st.recFile.split(/[\\/]/).pop() : '.'), 'good');
  }

  /* ------- MultiCorder ------- */

  function stopMulticorderFor(inputId) {
    const mc = st.multicorders.find((m) => m.inputId === inputId);
    if (mc) stopOneMulticorder(mc);
  }

  async function stopOneMulticorder(mc) {
    st.multicorders = st.multicorders.filter((m) => m !== mc);
    if (mc.rec && mc.rec.state !== 'inactive') {
      await new Promise((res) => { mc.rec.onstop = res; try { mc.rec.stop(); } catch (e) { res(); } });
    }
    try { await window.api.live.recStop(mc.recId); } catch (e) {}
    if (!st.multicorders.length) refs.vmxMultiCorder.classList.remove('on', 'blink');
    updateAirState();
  }

  async function toggleMulticorder() {
    if (st.multicorders.length) {
      const all = [...st.multicorders];
      for (const mc of all) await stopOneMulticorder(mc);
      toast('💾 MultiCorder recordings saved.', 'good');
      return;
    }
    const candidates = st.inputs.filter((i) => hasVisual(i) && (i.type === 'camera' || i.type === 'screen' || i.type === 'video' || i.type === 'color'));
    if (!candidates.length) return toast('⚠️ Add a camera or video input first.', 'error');
    openModal(
      `<h3>MultiCorder — record inputs separately <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-list">` +
      candidates.map((i) => `<label class="vmx-list-item"><input type="checkbox" data-mcid="${i.id}" checked /> ${i.num}. ${esc(i.name)}</label>`).join('') +
      `</div>` +
      `<p class="vmx-note">Each ticked input records to its own MP4 in the output folder — independent of what is on the program.</p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxMcGo">Start recording</button></div>`);
    refs.vmxModalBox.querySelector('#vmxMcGo').onclick = async () => {
      const ids = [...refs.vmxModalBox.querySelectorAll('input[data-mcid]:checked')].map((c) => Number(c.dataset.mcid));
      closeModal();
      if (!ids.length) return;
      ensureAudio();
      for (const id of ids.slice(0, 4)) {
        const inp = inputById(id);
        if (!inp) continue;
        const cv = document.createElement('canvas');
        cv.width = 1280; cv.height = 720;
        const mcFps = productionFps();
        const stream = cv.captureStream(mcFps);
        if (inp.srcNode) {
          const mdest = st.ac.createMediaStreamDestination();
          inp.srcNode.connect(mdest);
          stream.addTrack(mdest.stream.getAudioTracks()[0]);
        }
        const recId = 'mc-' + id;
        let res;
        try { res = await window.api.live.recStart({ recId, name: 'multicorder-' + inp.name, quality: DEFAULT_QUALITY, fps: mcFps, audioFormat: liveCfg().recAudioFormat }); }
        catch (e) { toast('⚠️ MultiCorder: ' + (e.message || e), 'error'); continue; }
        const mc = { inputId: id, canvas: cv, recId, file: res && res.file };
        mc.rec = newRecorder(stream, 2500, (buf) => window.api.live.recChunk(recId, buf));
        st.multicorders.push(mc);
      }
      if (st.multicorders.length) {
        refs.vmxMultiCorder.classList.add('on', 'blink');
        updateAirState();
        toast('● MultiCorder recording ' + st.multicorders.length + ' input(s).', 'good');
      }
    };
  }

  /* ------- PlayList ------- */

  function openPlaylistModal() {
    if (st.playlist.on) { stopPlaylist(); return; }
    const vids = st.inputs.filter((i) => i.type === 'video');
    if (!vids.length) return toast('⚠️ Add video file inputs first — the playlist plays them in order.', 'error');
    openModal(
      `<h3>PlayList <span class="vmx-modal-x">✕</span></h3>` +
      `<div class="vmx-list">` +
      vids.map((i) => `<label class="vmx-list-item"><input type="checkbox" data-plid="${i.id}" checked /> ${i.num}. ${esc(i.name)}</label>`).join('') +
      `</div>` +
      `<div class="vmx-form"><label class="vmx-inline"><input type="checkbox" id="vmxPlLoop" /> Loop the playlist</label></div>` +
      `<p class="vmx-note">Videos fade to program one after another. Anything else on the program comes back when the playlist ends.</p>` +
      `<div class="vmx-form-btns"><button class="vmx-btn" id="vmxPlGo">▶ Start playlist</button></div>`);
    refs.vmxModalBox.querySelector('#vmxPlGo').onclick = () => {
      const ids = [...refs.vmxModalBox.querySelectorAll('input[data-plid]:checked')].map((c) => Number(c.dataset.plid));
      st.playlist.loop = refs.vmxModalBox.querySelector('#vmxPlLoop').checked;
      closeModal();
      if (ids.length) startPlaylist(ids);
    };
  }

  function startPlaylist(ids) {
    st.playlist.ids = ids;
    st.playlist.on = true;
    st.playlist.idx = -1;
    refs.vmxPlayList.classList.add('on');
    playlistNext();
  }

  function playlistNext() {
    const pl = st.playlist;
    pl.idx++;
    if (pl.idx >= pl.ids.length) {
      if (pl.loop && pl.ids.length) pl.idx = 0;
      else return stopPlaylist();
    }
    const inp = inputById(pl.ids[pl.idx]);
    if (!inp || !inp.el) return playlistNext();
    if (pl.handler && pl.lastEl) pl.lastEl.removeEventListener('ended', pl.handler);
    pl.handler = () => playlistNext();
    pl.lastEl = inp.el;
    inp.el.loop = false;
    inp.el.addEventListener('ended', pl.handler, { once: true });
    quickPlay(inp.id);
  }

  function stopPlaylist() {
    const pl = st.playlist;
    pl.on = false; pl.idx = -1;
    if (pl.handler && pl.lastEl) { pl.lastEl.removeEventListener('ended', pl.handler); pl.handler = null; }
    refs.vmxPlayList.classList.remove('on');
  }

  /* ------- external output window ------- */

  function toggleExternal(fullscreen) {
    if (st.extWin && !st.extWin.closed) {
      try { st.extWin.close(); } catch (e) {}
      st.extWin = null;
      refs.vmxExternal.classList.remove('on');
      refs.vmxFullscreen.classList.remove('on');
      return;
    }
    let w = null;
    try { w = window.open('', fullscreen ? 'mwOutputFS' : 'mwOutput', 'width=960,height=560'); } catch (e) {}
    if (!w) return toast('⚠️ Could not open the output window.', 'error');
    try {
      w.document.title = 'Program Output';
      w.document.body.style.cssText = 'margin:0;background:#000;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;';
      const v = w.document.createElement('video');
      v.autoplay = true; v.muted = true;
      v.style.cssText = 'width:100%;height:100%;object-fit:contain;';
      v.srcObject = new MediaStream([buildOutStream().getVideoTracks()[0]]);
      w.document.body.appendChild(v);
      const play = () => { try { v.play(); } catch (e) {} };
      play();
      v.addEventListener('dblclick', () => { try { v.requestFullscreen(); } catch (e) {} });
    } catch (e) { toast('⚠️ Output window error: ' + e.message, 'error'); }
    st.extWin = w;
    refs.vmxExternal.classList.add('on');
    if (fullscreen) refs.vmxFullscreen.classList.add('on');
    const iv = setInterval(() => {
      if (!st.extWin || st.extWin.closed) {
        clearInterval(iv);
        st.extWin = null;
        refs.vmxExternal.classList.remove('on');
        refs.vmxFullscreen.classList.remove('on');
      }
    }, 800);
  }

  /* =============================== PRESETS =============================== */

  function serializePreset() {
    return {
      app: 'mw-golive-preset', version: 1,
      quality: liveCfg().quality || DEFAULT_QUALITY, autoMix: st.autoMix,
      slots: st.slots.map((s) => ({ fx: s.fx, dur: s.dur })),
      overlays: st.ovl.map((o) => ({ mode: o.mode })),
      inputs: st.inputs.map((i) => ({
        type: i.type, name: i.name, deviceId: i.deviceId, path: i.path,
        color: i.color, title: i.title, loop: i.loop, audioOn: i.audioOn, volume: i.volume,
        camCfg: i.camCfg || undefined,
        syncMs: Number(i.syncMs) || undefined,   // the operator's A/V sync trim
        // A camera's grade belongs to the rig, not to the session — a preset
        // that restores the cameras but not how they were matched is half a
        // preset, and the operator would have to redo it every Sunday.
        colour: colourActive(i.colour) || (i.colour && i.colour.alpha !== 255)
          ? Object.assign({}, i.colour) : undefined,
      })),
    };
  }

  async function restorePreset(data) {
    closeAllInputs();
    if (Array.isArray(data.slots)) data.slots.forEach((s, n) => { if (st.slots[n]) { st.slots[n].fx = s.fx || st.slots[n].fx; st.slots[n].dur = s.dur || st.slots[n].dur; } });
    if (Array.isArray(data.overlays)) data.overlays.forEach((o, n) => { if (st.ovl[n] && o.mode) st.ovl[n].mode = o.mode; });
    if (typeof data.autoMix === 'boolean') st.autoMix = data.autoMix;
    renderSlots();
    let failed = 0;
    for (const d of data.inputs || []) {
      try {
        let inp = null;
        if (d.type === 'camera') inp = await addCamera(d.deviceId, d.name, d.camCfg);
        else if (d.type === 'audio' && d.path) inp = addAudioFile(d.path, d.name);
        else if (d.type === 'audio') inp = await addMic(d.deviceId, d.name);
        else if (d.type === 'video') inp = addVideoFile(d.path, d.name);
        else if (d.type === 'image') inp = await addImageFile(d.path, d.name);
        else if (d.type === 'color') inp = addColor(d.name, d.color);
        else if (d.type === 'title') inp = addTitle(d.title);
        if (inp) {
          inp.audioOn = d.audioOn !== false;
          inp.volume = typeof d.volume === 'number' ? d.volume : 1;
          inp.loop = !!d.loop;
          if (d.syncMs) setInputSyncMs(inp, d.syncMs);
        if (d.colour) inp.colour = Object.assign({}, COLOUR_DEFAULT, d.colour);
          if (inp.el && (inp.el.tagName === 'VIDEO' || inp.el.tagName === 'AUDIO') && !inp.stream) inp.el.loop = inp.loop;
        }
      } catch (e) { failed++; }
    }
    renderInputs();
    if (failed) toast(`⚠️ ${failed} input(s) could not be restored (device unplugged / file moved?).`, 'error');
    else toast('✅ Preset loaded.', 'good');
  }

  async function savePreset() {
    try {
      const p = await window.api.dialog.saveFile('golive-preset.json', [{ name: 'Go Live preset', extensions: ['json'] }]);
      if (!p) return;
      await window.api.fs.writeText(p, JSON.stringify(serializePreset(), null, 2));
      st.lastPresetPath = p;
      await saveLiveCfg({ lastPreset: p });
      toast('💾 Preset saved.', 'good');
    } catch (e) { toast('⚠️ ' + (e.message || e), 'error'); }
  }

  async function openPreset(pathArg) {
    try {
      const p = pathArg || await window.api.dialog.openFile([{ name: 'Go Live preset', extensions: ['json'] }]);
      if (!p) return;
      const text = await window.api.fs.readText(p);
      const data = JSON.parse(text);
      if (data.app !== 'mw-golive-preset') throw new Error('That file is not a Go Live preset.');
      st.lastPresetPath = p;
      await saveLiveCfg({ lastPreset: p });
      await restorePreset(data);
    } catch (e) { toast('⚠️ Could not open the preset: ' + (e.message || e), 'error'); }
  }

  /* ============================ TRANSITION UI ============================= */

  function renderSlots() {
    refs.vmxSlots.innerHTML = st.slots.map((s, n) =>
      `<div class="vmx-slot" data-slot="${n}">` +
      `<button class="vmx-tbtn vmx-slot-go" title="Transition preview → program (${s.dur}ms)">${s.fx}</button>` +
      `<button class="vmx-slot-arrow" title="Choose effect + duration">▼</button>` +
      `</div>`).join('');
    refs.vmxSlots.querySelectorAll('.vmx-slot').forEach((el) => {
      const n = Number(el.dataset.slot);
      el.querySelector('.vmx-slot-go').onclick = () => startTransition(st.slots[n].fx, st.slots[n].dur);
      el.querySelector('.vmx-slot-arrow').onclick = (ev) => {
        ev.stopPropagation();
        showMenu(el,
          `<div class="vmx-menu-head">Effect</div>` +
          EFFECTS.map((f) => `<button data-fx="${f}">${f === st.slots[n].fx ? '✓ ' : ''}${f}</button>`).join('') +
          `<div class="vmx-menu-sep"></div><div class="vmx-menu-head">Duration</div>` +
          [250, 500, 1000, 2000].map((d) => `<button data-dur="${d}">${d === st.slots[n].dur ? '✓ ' : ''}${d / 1000}s</button>`).join(''),
          (b) => {
            if (b.dataset.fx) st.slots[n].fx = b.dataset.fx;
            if (b.dataset.dur) st.slots[n].dur = Number(b.dataset.dur);
            hideMenu();
            renderSlots();
          });
      };
    });
  }

  function closeDrawer() {
    refs.vmxDrawer.classList.add('hidden');
    refs.vmxMore.classList.remove('on');
  }

  function wireTbar() {
    let dragging = false;
    const posFromEvent = (ev) => {
      const r = refs.vmxTbar.getBoundingClientRect();
      return clamp((r.bottom - ev.clientY) / r.height, 0, 1);
    };
    refs.vmxTbar.addEventListener('mousedown', (ev) => {
      dragging = true;
      setTbar(posFromEvent(ev));
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => { if (dragging) setTbar(posFromEvent(ev)); });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  /* ========================== STATUS + TIMERS ============================ */

  function fmtHMS(ms) {
    const s = Math.floor(ms / 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  }

  function startStatusTimers() {
    if (st.statTimer) return;
    st.statTimer = setInterval(async () => {
      try {
        const m = await window.api.live.metrics();
        if (m && typeof m.cpu === 'number') {
          st.cpu = m.cpu;
          // App's own share first (what this software costs), then the whole
          // machine (what Task Manager's header shows) — one number alone kept
          // being read as the other and looking "false".
          refs.vmxStCpu.textContent = typeof m.appCpu === 'number'
            ? `app ${Math.round(m.appCpu)}% · total ${Math.round(m.cpu)}%`
            : Math.round(m.cpu) + ' %';
        }
      } catch (e) {}
    }, 1000);
    st.clockTimer = setInterval(() => {
      if (st.recording) refs.vmxStRecTime.textContent = fmtHMS(Date.now() - st.recStartedAt);
      const active = st.streams.filter((s) => s.streaming);
      if (active.length) refs.vmxStStreamTime.textContent = fmtHMS(Date.now() - Math.min(...active.map((s) => s.startedAt)));
      updateEngineLine();
    }, 500);
    updateEngineLine();
  }

  /**
   * What this board is actually producing, in the corner where a broadcast desk
   * puts it: the output size, the rate it is running at, and — once something is
   * encoding — which encoder took the job. Silent about the encoder while idle,
   * because there isn't one yet and inventing a name would be a lie.
   */
  function updateEngineLine() {
    if (!refs.vmxStEngine) return;
    const q = quality();
    const fps = st.outStreamFps || productionFps();
    refs.vmxStEngine.innerHTML =
      `Output <b>${q.width}×${q.height}</b> · <b>${Math.round(fps)}</b> fps` +
      (st.encoderLabel ? ` · <b>${esc(st.encoderLabel)}</b>` : '');
  }

  /* ============================== SHORTCUTS =============================== */

  function onKeydown(ev) {
    if (!document.getElementById('view-live').classList.contains('active')) return;
    if (!refs.vmxModal.classList.contains('hidden')) return;
    const tag = (ev.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable) return;
    if (ev.key >= '1' && ev.key <= '9') {
      const inp = st.inputs.filter(hasVisual)[Number(ev.key) - 1];
      if (inp) { setPreview(inp.id); ev.preventDefault(); }
    } else if (ev.key === 'Enter') { cut(); ev.preventDefault(); }
    else if (ev.key === ' ') { startTransition(st.slots[0].fx, st.slots[0].dur); ev.preventDefault(); }
    else if (ev.key === 'b' || ev.key === 'B') { toggleFTB(); ev.preventDefault(); }
  }

  /* ================================= WIRE ================================= */

  function wire() {
    refs.vmxInputs.addEventListener('click', onInputBarClick);
    refs.vmxAddInput.addEventListener('click', openInputSelectModal);
    refs.vmxAddInputCfg.addEventListener('click', openInputSelectModal);
    // Reaching for the button is intent enough to start the camera stack (see
    // warmCapture) — the five seconds get spent before the dialog is even open.
    for (const b of [refs.vmxAddInput, refs.vmxAddInputCfg]) {
      b.addEventListener('mouseenter', () => { warmCapture(); });
      b.addEventListener('focus', () => { warmCapture(); });
    }
    refs.vmxQuickPlay.addEventListener('click', () => quickPlay(null));
    refs.vmxCut.addEventListener('click', cut);
    refs.vmxFTB.addEventListener('click', toggleFTB);
    refs.vmxRecord.addEventListener('click', toggleRecord);
    refs.vmxRecordCfg.addEventListener('click', openSettingsModal);
    refs.vmxStream.addEventListener('click', toggleStream);
    refs.vmxStreamCfg.addEventListener('click', openStreamSettingsModal);
    refs.vmxSettingsBtn.addEventListener('click', openSettingsModal);
    refs.vmxPgmGear.addEventListener('click', openSettingsModal);
    refs.vmxExternal.addEventListener('click', () => toggleExternal(false));
    refs.vmxFullscreen.addEventListener('click', () => toggleExternal(true));
    refs.vmxMultiCorder.addEventListener('click', toggleMulticorder);
    refs.vmxPlayList.addEventListener('click', openPlaylistModal);
    refs.vmxHelpBtn.addEventListener('click', openHelpModal);
    refs.vmxOpenPreset.addEventListener('click', () => openPreset());
    refs.vmxSavePreset.addEventListener('click', savePreset);
    refs.vmxLastPreset.addEventListener('click', () => {
      if (st.lastPresetPath) openPreset(st.lastPresetPath);
      else toast('No preset saved yet — use Save Preset first.', 'error');
    });
    refs.vmxClosePreset.addEventListener('click', () => { closeAllInputs(); toast('Preset closed — all inputs removed.', 'good'); });
    refs.vmxPauseInputs.addEventListener('click', () => {
      st.pausedAll = !st.pausedAll;
      refs.vmxPauseInputs.classList.toggle('on', st.pausedAll);
      for (const inp of st.inputs) {
        if (inp.el && (inp.el.tagName === 'VIDEO' || inp.el.tagName === 'AUDIO') && !inp.stream) {
          if (st.pausedAll) inp.el.pause();
          else if (!inp.paused) inp.el.play().catch(() => {});
        }
      }
    });
    refs.vmxBasic.addEventListener('click', () => {
      st.basic = !st.basic;
      refs.vmx.classList.toggle('basic', st.basic);
      refs.vmxBasic.textContent = st.basic ? 'Advanced' : 'Basic';
    });
    // "More" holds the tools you set up WITH, not the ones you run a service
    // with — presets, extra recorders, board options. One click away is close
    // enough for those, and keeps them out of reach of an elbow mid-song.
    refs.vmxMore.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const opening = refs.vmxDrawer.classList.contains('hidden');
      refs.vmxDrawer.classList.toggle('hidden', !opening);
      refs.vmxMore.classList.toggle('on', opening);
    });
    refs.vmxDrawer.addEventListener('click', (ev) => {
      // a choice was made — put the drawer away so the board is clear again
      if (ev.target.closest('button')) closeDrawer();
    });
    document.addEventListener('click', (ev) => {
      if (refs.vmxDrawer.classList.contains('hidden')) return;
      if (!refs.vmxDrawer.contains(ev.target) && !ev.target.closest('#vmxMore')) closeDrawer();
    });
    refs.vmxMasterMute.addEventListener('click', () => setMasterMuted(!st.masterMuted));
    refs.vmxMasterVol.addEventListener('input', () => {
      st.masterVol = parseFloat(refs.vmxMasterVol.value);
      const f = refs.vmxMixer.querySelector('.vmx-strip.master .vmx-vfader');
      if (f) f.value = String(st.masterVol);
    });
    refs.vmxMixerRailOut.addEventListener('click', () => {
      try { localStorage['mw-vmx-mixer-out'] = mixerSectionCollapsed('out') ? '0' : '1'; } catch (e) {}
      renderMixerStrips();
    });
    refs.vmxMixerRailIn.addEventListener('click', () => {
      try { localStorage['mw-vmx-mixer-in'] = mixerSectionCollapsed('in') ? '0' : '1'; } catch (e) {}
      renderMixerStrips();
    });
    renderMixerStrips(); // the mixer is always visible — draw its strips from the start

    document.addEventListener('click', (ev) => {
      if (!refs.vmxMenu.classList.contains('hidden') &&
          !refs.vmxMenu.contains(ev.target) &&
          !ev.target.closest('#vmxAddInput,#vmxAddInputCfg,.vmx-slot-arrow')) hideMenu();
    });
    document.addEventListener('keydown', onKeydown);
    wireTbar();
    renderSlots();

    window.api.live.onStats((s) => {
      const slot = st.streams.find((x) => x.id === s.destId);
      if (!slot || !slot.streaming) return;
      slot.lastStats = s;
      updateStreamStatusBar();
    });
    window.api.live.onEnded((p) => {
      const slot = st.streams.find((x) => x.id === p.destId);
      if (!slot) return;
      slot.lastEndInfo = p;
      slot.reconnecting = null;
      if (slot.streaming) {
        slot.streaming = false;
        maybeStopProgramEncoder();
        updateStreamUI();
        if (p && p.error) { statusMsg('⚠️ Destination ' + slot.num + ': ' + p.error); toast('⚠️ Destination ' + slot.num + ' stream ended: ' + p.error, 'error'); }
        else toast('⏹ Destination ' + slot.num + ' stream ended.', 'good');
      }
    });
    // A destination dropped but is retrying — the broadcast and every OTHER
    // destination keep running, so this is a warning, not an ending.
    if (window.api.live.onReconnecting) {
      window.api.live.onReconnecting((p) => {
        const slot = st.streams.find((x) => x.id === p.destId);
        if (!slot || !slot.streaming) return;
        slot.reconnecting = p;
        statusMsg(`⚠️ Destination ${slot.num} dropped — reconnecting (try ${p.attempt} of ${p.of})…`);
        toast(`🔄 Destination ${slot.num} dropped — reconnecting in ${p.inSec}s…`, 'error');
        updateStreamStatusBar();
      });
    }
    if (window.api.live.onConnected) {
      window.api.live.onConnected((p) => {
        const slot = st.streams.find((x) => x.id === p.destId);
        if (!slot) return;
        const wasRetrying = !!slot.reconnecting;
        slot.reconnecting = null;
        if (wasRetrying) { statusMsg(''); toast(`✅ Destination ${slot.num} is back on air.`, 'good'); }
        updateStreamStatusBar();
      });
    }
    // Not enough upload for this destination. It keeps broadcasting — picture is
    // shed so the sound stays clean — but the operator has to be TOLD, because
    // the fix is theirs to make (a lower streaming quality, or one platform less).
    if (window.api.live.onBandwidth) {
      window.api.live.onBandwidth((p) => {
        const slot = st.streams.find((x) => x.id === p.destId);
        if (!slot || !slot.streaming) return;
        slot.shedding = !!p.shedding;
        slot.shedReason = p.reason || '';
        renderShedBanner();     // stays up for as long as it is true
        renderFitBanner();
        if (p.shedding) {
          /*
           * SAID ONCE, NOT THREE TIMES.
           *
           * This used to raise the banner AND write the full sentence into the
           * command bar AND fire a twelve-second toast — the same words in
           * three places, repeated every time the destination crossed the
           * threshold, which through a difficult service is a rhythm of alarms
           * over the desk. The banner is the one that belongs: it names the
           * destination, carries the button that fixes it, and STAYS for
           * exactly as long as the fault does, which is why it was built.
           *
           * The command bar keeps a short marker so the fault is still visible
           * from the corner of an eye once the banner has been read and stops
           * being noticed. A CPU diagnosis and a bandwidth diagnosis look
           * identical to the platform ("poor connection") and have completely
           * different fixes, so the icon has to name which one this is.
           */
          const icon = p.reason === 'encode' ? '🖥️' : '📶';
          statusMsg(`${icon} Destination ${slot.num} is struggling — see the banner above.`);
        } else {
          statusMsg('');
          // Recovery IS worth a moment's word: the banner simply vanishes, and
          // an operator who saw the warning deserves to be told it is over.
          toast(`✅ Destination ${slot.num} ${p.message}`, 'good');
        }
        updateStreamStatusBar();
      });
    }
    /*
     * AUTO-FIT — the fix for "one platform goes choppy while the other is fine".
     *
     * The hub has worked out that what we are sending is bigger than the line
     * can carry and has chosen a rate that fits. Only this side can act on it:
     * the encoder is ours. Answering honestly matters — an encoder that will
     * not take the new rate has to say so, or the hub spends the service
     * believing it is sending less than it is.
     */
    if (window.api.live.onBitrate) {
      window.api.live.onBitrate((p) => {
        if (p && p.refused) { st.fit = { ...(st.fit || {}), on: false }; renderFitBanner(); return; }
        const kbps = p && p.videoKbps;
        if (!kbps) return;
        const rec = st.pgmRec;
        const ok = !!(rec && rec.setBitrate && rec.setBitrate(kbps));
        try { window.api.live.bitrateApplied(kbps, ok); } catch (e) {}
        if (!ok) return;
        // …spread, not replaced: the picture SHAPE is what the platform's
        // recommendation is looked up against, and rebuilding this object from
        // scratch dropped it — leaving the under-rated banner unable to tell
        // 720p from 1080p for the rest of the broadcast.
        st.fit = { ...(st.fit || {}), on: true, kbps,
          ceiling: (p.ceilingKbps || (st.fit && st.fit.ceiling) || kbps), atFloor: !!p.atFloor };
        renderFitBanner();
        updateStreamStatusBar();
        const mb = (k) => (Math.round(k / 100) / 10) + ' mbps';
        if (p.direction === 'down') {
          // Once, quietly, and only when it first has to give ground — a toast
          // every step would be a rhythm of alarms through a sermon.
          if (p.steps === 1) {
            toast('📶 Your internet cannot carry ' + mb(p.from) + ' right now, so the picture has been lowered to '
              + mb(kbps) + ' to keep the stream smooth. The sound is untouched.', '', 10000);
          }
          statusMsg('📶 Auto-fit: picture at ' + mb(kbps) + ' to fit your upload.');
        } else if (kbps >= (st.fit.ceiling || kbps)) {
          statusMsg('');
          toast('✅ Your connection is comfortable again — picture back to full quality (' + mb(kbps) + ').', 'good');
        } else {
          statusMsg('📶 Auto-fit: picture at ' + mb(kbps) + ' to fit your upload.');
        }
      });
    }

    /*
     * THE SWITCHER, DRIVEN FROM THE OTHER MACHINE.
     *
     * A second computer running this app — or a tablet at the back of the hall
     * — reaches the same private URL the stage display uses, with the same
     * passcode and the same master switch. What arrives here is a few dozen
     * bytes and one IPC send, which is the whole point: LINKING TWO MACHINES
     * COSTS THE DESK NOTHING. Video between machines is a separate and far
     * heavier decision (NDI, ~130 Mbps for 1080p) and is not this.
     *
     * Every command goes through the SAME function the operator's own button
     * calls. A remote cut and a local cut are the same cut, so there is no
     * second code path to drift out of step — and anything the switcher
     * refuses locally it refuses remotely too.
     */
    if (window.api.live.onRemote) {
      window.api.live.onRemote(({ cmd, arg }) => {
        const byNum = (v) => st.inputs.find((i) => String(i.num) === String(v)) || null;
        try {
          if (cmd === 'cut') { const i = byNum(arg); if (i) st.previewId = i.id; cut(); }
          else if (cmd === 'preview') { const i = byNum(arg); if (i) setPreview(i.id); }
          else if (cmd === 'take' || cmd === 'trans') startTransition(arg || 'Fade', 500);
          else if (cmd === 'ftb') toggleFTB();
          else if (cmd === 'stream') startAllStreams();
          else if (cmd === 'stopstream') stopAllStreams();
          else if (cmd === 'record' || cmd === 'stoprecord') toggleRecord();
          else return;
          updateStreamUI();
        } catch (e) { /* a remote must never be able to throw into the desk */ }
      });
    }
    // The program encoder had to restart in the main process — hand it a fresh
    // capture. Destinations stay attached, so nothing drops off air.
    if (window.api.live.onProgramRestart) {
      window.api.live.onProgramRestart(() => { restartProgramEncoder(); });
    }
    if (window.api.live.onRecEnded) {
      window.api.live.onRecEnded((p) => {
        st.lastRecEnd = p;
        if (p && p.recId === 'main' && st.recording && p.error) {
          stopRecord();
          toast('⚠️ Recording stopped: ' + p.error, 'error');
        }
      });
    }
  }

  /* ================================= INIT ================================= */

  async function init(settings) {
    st.settings = settings;
    grabRefs();
    await hydrateQualityPresets();
    initStreamsFromSettings();
    wire();
    const lv = liveCfg();
    if (lv.lastPreset) st.lastPresetPath = lv.lastPreset;
    applyQuality();
    renderInputs();
    updateAirState();
    // The board wears the church's name, not the software's — an operator
    // glancing at the top of the screen should see whose service this is.
    const church = (settings && settings.brand && settings.brand.churchName) || '';
    if (church) { refs.vmxStName.textContent = church; refs.vmxStName.title = church; }
    statusMsg('');
    // Start finding the cameras and microphones NOW, at launch, while nobody
    // is waiting on them. See devCache: the first enumeration on a machine
    // with a lot of video devices takes ten seconds or more no matter how it
    // is asked for (measured: 11.5s for 14 video inputs), and every one after
    // it takes about a tenth of a second. Paying it here is the difference
    // between Add Input opening instantly and appearing to hang.
    setTimeout(() => { warmDevices().catch(() => {}); }, 1200);
  }

  function onShow() {
    ensureLoop();
    refreshTargetFps();
    startStatusTimers();
    positionTbar();
    // Have the camera and microphone lists in hand before anyone asks for
    // them — this is what makes Add Input open instantly instead of hunting.
    warmDevices().catch(() => {});
    if (st.ac && st.ac.state === 'suspended') st.ac.resume().catch(() => {});
  }

  /* =============================== TEST HOOKS ============================= */

  const __test = {
    /* ---- sample-rate conversion (test/ndi-resample.test.js) ---- */
    /** What the broadcast bus is ACTUALLY running at, in this real page. */
    programSampleRate: () => { ensureAudio(); return st.ac ? st.ac.sampleRate : null; },
    /**
     * Push `samples` through the real converter in packets of the given sizes,
     * exactly as an NDI feed arrives, and hand back what came out. Plain arrays
     * so the result survives the trip to the test process.
     */
    resampleProbe: (fromRate, toRate, samples, packets) => {
      const rs = makeResampler(fromRate, toRate);
      const out = [];
      let p = 0, k = 0;
      while (p < samples.length) {
        const n = Math.min(packets[k++ % packets.length], samples.length - p);
        const s = new Float32Array(samples.slice(p, p + n));
        const o = rs.process(s, s);
        for (let i = 0; i < o.l.length; i++) out.push(o.l[i]);
        p += n;
      }
      return out;
    },
    /* ---- the three things that decide whether YouTube sees a low bitrate ----
     * The measurement's age, the frame rate a broadcast is allowed to take on
     * 'Auto', and the floor the still-slide pad refuses to go below. Each one
     * of them, left alone, produced the same yellow banner every service. */
    uplinkFresh(sharing) { return { fresh: uplinkIsFresh(), ageMs: uplinkAgeMs(), cap: measuredLineKbps(sharing) }; },
    sharingLine(pending) { return destinationsSharingLine(pending); },
    /** The go-live decision: does this line pay for every destination in full? */
    fitToLine() {
      const targets = st.streams.filter((s) => s.key && !s.streaming);
      const before = targets.map((s) => s.quality);
      const changed = fitDestinationsToLine(targets);
      return { changed, before, after: targets.map((s) => s.quality),
               share: measuredLineKbps(targets.length) };
    },
    setUplinkMemory(mbps, ageMs) {
      // liveCfg() hands back a throwaway {} when nothing has been saved yet, so
      // the store has to be made real before anything is written into it.
      st.settings = st.settings || {};
      st.settings.live = st.settings.live || {};
      const lv = st.settings.live;
      lv.lastUplinkMbps = mbps;
      lv.lastUplinkAt = ageMs == null ? 0 : Date.now() - ageMs;
      return { cap: measuredLineKbps(), fresh: uplinkIsFresh() };
    },
    streamFpsFor(raw, width, height) { return affordableStreamFps(raw, width, height); },
    setFpsMode(mode) {
      st.settings = st.settings || {}; st.settings.live = st.settings.live || {};
      st.settings.live.fpsMode = mode;
      return st.settings.live.fpsMode;
    },
    platformRec(w, h, fps) { return platformRecKbps(w, h, fps); },
    /* --- will Sunday fit down this line? (see uplinkNoteHtml / fitMyUpload) --- */
    /** Configure destination slots directly, as Streaming Settings would. */
    setStreams(list) {
      st.streams = (list || []).map((s, i) => Object.assign({
        id: 'd' + (i + 1), num: i + 1, dest: 'facebook', key: '', customUrl: '',
        quality: DEFAULT_QUALITY, streaming: false,
      }, s));
      return st.streams.map((s) => s.quality);
    },
    openStreamSettings() { openStreamSettingsModal(); return true; },
    streamQualities() { return st.streams.map((s) => s.quality); },
    /** Deliver a bandwidth event exactly as the main process sends one. */
    fakeBandwidth(p) {
      const slot = st.streams.find((x) => x.id === p.destId);
      if (!slot) return false;
      slot.streaming = true;
      slot.shedding = !!p.shedding;
      slot.shedReason = p.reason || '';
      renderShedBanner();
      return true;
    },
    shedBannerText() { const el = document.getElementById('vmxShedBanner'); return el ? el.textContent : null; },
    /** Deliver an auto-fit rate change exactly as the hub sends one. */
    fakeBitrate(p) {
      const rec = st.pgmRec;
      const ok = !!(rec && rec.setBitrate && rec.setBitrate(p.videoKbps));
      // spread, exactly as the real handler does — the picture SHAPE has to
      // survive a rate change or the under-rated banner cannot look up what the
      // platform wants for it
      st.fit = { ...(st.fit || {}), on: true, kbps: p.videoKbps,
        ceiling: p.ceilingKbps || (st.fit && st.fit.ceiling) || p.videoKbps, atFloor: !!p.atFloor };
      renderFitBanner();
      return { applied: ok, captureKbps: rec && rec.videoKbps };
    },
    /** What the program capture is actually doing, including the CBR pad.
     *  (`captureDiag` further down is the A/V clock one — different question.) */
    padDiag() {
      const rec = st.pgmRec;
      return {
        mode: st.pgmCaptureMode || '', wcBad: !!st.wcBad, accel: st.wcAccel || '',
        mime: (rec && rec.mimeType) || '', videoKbps: (rec && rec.videoKbps) || 0,
        chunksSent: st.chunksSent || 0,
        filler: rec && rec.fillerStats ? rec.fillerStats() : null,
      };
    },
    fitBannerText() { const el = document.getElementById('vmxFitBanner'); return el ? el.textContent : null; },
    /** Put the auto-fit state in place directly, to look at the banner it makes.
     *  `fakeBitrate` above is the honest route and needs a live capture; this
     *  one exists for judging the strip itself — what it says and how much of
     *  the desk it takes. */
    fakeFit(f) { st.fit = Object.assign({}, f); renderFitBanner(); const el = document.getElementById("vmxFitBanner"); return el ? el.textContent : null; },
    fitState() { return st.fit || null; },
    state: () => ({
      inputs: st.inputs.map((i) => ({
        id: i.id, num: i.num, name: i.name, type: i.type,
        audioOn: i.audioOn, solo: i.solo, loop: i.loop, paused: i.paused, volume: i.volume,
        hasAudio: !!i.gain, level: i.level, ndiAudioOnly: !!i._ndiAudioOnly,
        elTag: i.el && i.el.tagName, listIdx: i.listIdx, listLen: i.listItems && i.listItems.length,
      })),
      previewId: st.previewId, programId: st.programId,
      trans: st.trans ? { from: st.trans.from, to: st.trans.to, fx: st.trans.fx, m: st.trans.m, manual: st.trans.manual } : null,
      tbar: st.tbarPos, ftbOn: st.ftbOn, ftbLevel: st.ftbLevel,
      overlays: st.ovl.map((o) => ({ id: o.id, level: o.level, mode: o.mode })),
      streaming: st.streams.some((s) => s.streaming), chunksSent: st.chunksSent,
      streams: st.streams.map((s) => ({ id: s.id, num: s.num, dest: s.dest, key: s.key, customUrl: s.customUrl, quality: s.quality, streaming: s.streaming, lastStats: s.lastStats, lastEndInfo: s.lastEndInfo, reconnecting: s.reconnecting || null })),
      recording: st.recording, recFile: st.recFile, recChunksSent: st.recChunksSent, lastRecEnd: st.lastRecEnd,
      // one capture + one encode shared by every consumer (see ensureProgramEncoder)
      programEncoders: st.pgmRec ? 1 : 0, programConsumers: programConsumers(),
      encoderLabel: st.encoderLabel, targetFps: st.targetFps, replayArmed: st.replayArmed,
      // How the program is being captured ('gpu' | 'wcsw' | 'sw'). Chunk cadence
      // differs sharply between them — WebCodecs emits one fragment per
      // keyframe, MediaRecorder emits on a timeslice — so any test counting
      // chunks needs to know which path it is on.
      captureMode: st.pgmCaptureMode, wcAccel: st.wcAccel,
      multicorders: st.multicorders.map((m) => ({ inputId: m.inputId, recId: m.recId, file: m.file })),
      playlist: { on: st.playlist.on, idx: st.playlist.idx, ids: st.playlist.ids },
      fps: st.fps, renderMs: st.renderMs, cpu: st.cpu, masterLevel: st.masterLevel,
      captureFps: st.outStreamFps, productionFps: productionFps(),
      masterMuted: st.masterMuted, masterVol: st.masterVol, autoMix: st.autoMix,
      mixerOpen: st.mixerOpen, monitorVol: st.monitorVol,
      basic: st.basic, pausedAll: st.pausedAll,
      extOpen: !!(st.extWin && !st.extWin.closed),
      slots: st.slots.map((s) => ({ fx: s.fx, dur: s.dur })),
      prvName: refs.vmxPrvName.textContent, pgmName: refs.vmxPgmName.textContent,
      statusMsg: refs.vmxStMsg.textContent,
      cellClasses: [...refs.vmxInputs.querySelectorAll('.vmx-input')].map((c) => c.className),
    }),
    addColor, addTitle, addVideoFile, addImageFile, addScreen,
    /**
     * A synthetic input that FLASHES and BEEPS at the same instant.
     *
     * This is the only honest way to ask "does the sound match the picture on the
     * broadcast": both events leave the app together, so whatever gap turns up in
     * the received stream is the app's own A/V offset, end to end — through the
     * compositor, the encoder, the hub and the RTMP push. Anything less (checking
     * that audio merely exists, or trusting the timestamps we wrote ourselves)
     * would prove nothing about what the congregation actually hears.
     */
    addAvPulse(name) {
      const inp = makeInput('camera', name || 'AV Pulse');
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const c = cv.getContext('2d');
      c.fillStyle = '#000'; c.fillRect(0, 0, cv.width, cv.height);
      inp.el = cv;
      const ac = ensureAudio();
      const og = ac.createGain(); og.gain.value = 0;
      const osc = ac.createOscillator(); osc.frequency.value = 1000;
      const mdest = ac.createMediaStreamDestination();
      osc.connect(og); og.connect(mdest); osc.start();
      hookStreamAudio(inp, mdest.stream);
      inp._pulses = [];
      /*
       * The gaps between pulses are deliberately UNEQUAL.
       *
       * Sliding one pulse train against the other is the only pairing that
       * survives a dropped frame — but with evenly spaced pulses that slide has
       * no unique answer: "the sound is 0.8s late" and "the sound is 1.2s
       * early" explain an identical 2s-spaced recording equally well, and the
       * measurement silently reports whichever is nearer zero. An irregular
       * pattern only lines up with itself at one shift, so the number means
       * something.
       */
      const GAPS = [1200, 1800, 2600, 1400, 2200];
      let gi = 0;
      const firePulse = () => {
        const t0 = ac.currentTime;
        og.gain.setValueAtTime(0.6, t0);
        og.gain.setValueAtTime(0, t0 + 0.12);
        // white + 1kHz started in the SAME tick, so the source itself carries
        // no offset for the measurement to mistake for the app's
        c.fillStyle = '#ffffff'; c.fillRect(0, 0, cv.width, cv.height);
        inp._pulses.push(performance.now());
        setTimeout(() => { c.fillStyle = '#000000'; c.fillRect(0, 0, cv.width, cv.height); }, 120);
        inp._pulseTimer = setTimeout(firePulse, GAPS[gi++ % GAPS.length]);
      };
      inp._pulseTimer = setTimeout(firePulse, 1200);
      inp._pulseGaps = GAPS;
      return registerInput(inp);
    },
    addSynthetic(name, hue) {
      // synthetic camera: animated canvas + 440Hz tone (no webcam in CI)
      const inp = makeInput('camera', name || 'Synthetic');
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const c = cv.getContext('2d');
      let n = 0;
      inp._syntheticTimer = setInterval(() => {
        n++;
        c.fillStyle = `hsl(${hue == null ? (n * 7) % 360 : hue},80%,55%)`;
        c.fillRect(0, 0, cv.width, cv.height);
        c.fillStyle = '#fff'; c.font = 'bold 48px Arial';
        c.fillText((name || 'SYN') + ' ' + n, 30, cv.height / 2);
      }, 50);
      inp.el = cv;
      const ac = ensureAudio();
      const osc = ac.createOscillator(); osc.frequency.value = 440;
      const og = ac.createGain(); og.gain.value = 0.4;
      const mdest = ac.createMediaStreamDestination();
      osc.connect(og); og.connect(mdest); osc.start();
      hookStreamAudio(inp, mdest.stream);
      return registerInput(inp);
    },
    /**
     * A LYRIC SLIDE THAT DOES NOT MOVE — the worst case for a broadcast bitrate,
     * and the picture in the photograph of the real YouTube warning.
     *
     * `addSynthetic` above repaints and renumbers itself ten times a second, so
     * it never shows what a service actually looks like for most of an hour: a
     * verse on a background, motionless. A still picture compresses to almost
     * nothing, which is exactly when a platform reports the stream as
     * under-rated — so it is the case the padding has to be proved against, not
     * the animated one.
     */
    addStillSlide(name, text) {
      const inp = makeInput('camera', name || 'Slide');
      const cv = document.createElement('canvas');
      cv.width = 1280; cv.height = 720;
      const c = cv.getContext('2d');
      c.fillStyle = '#0a1030'; c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#ffffff'; c.font = 'bold 58px Arial';
      const lines = (text || 'And the earth was without form|and void; and darkness was upon|the face of the deep.').split('|');
      lines.forEach((l, i) => c.fillText(l, 60, 240 + i * 80));
      inp.el = cv;                       // painted once; never touched again
      const ac = ensureAudio();
      const osc = ac.createOscillator(); osc.frequency.value = 440;
      const og = ac.createGain(); og.gain.value = 0.4;
      const mdest = ac.createMediaStreamDestination();
      osc.connect(og); og.connect(mdest); osc.start();
      hookStreamAudio(inp, mdest.stream);
      return registerInput(inp);
    },
    /**
     * A CAMERA AS THE APP ACTUALLY RECEIVES ONE.
     *
     * `addSynthetic` and `addStillSlide` above hand the compositor a CANVAS,
     * and a canvas always holds the newest thing drawn on it — reading it can
     * never be early or late. A real camera is not like that: getUserMedia
     * gives a MediaStream, the app puts it in a <video> element, and that
     * element presents frames on the CAMERA's clock, which has nothing to do
     * with when the compositor happens to draw. Every video test in this
     * project used a canvas, so the one thing that makes a camera judder —
     * two free-running clocks — was never in any of them.
     *
     * captureStream(fps) samples the canvas on its own timer, so this is a
     * genuinely independent clock rather than one of ours in disguise.
     */
    /**
     * The same thing as addStreamCamera, but fed by a looping FILE.
     *
     * A canvas + captureStream source shares this renderer's GPU with the
     * compositor it is being used to measure, so when the compositor gets busy
     * the SOURCE slows down too — a coupling a real camera does not have, and
     * one that makes the numbers say more about the laptop than the app. A
     * hardware-decoded file presents on its own clock and costs almost nothing.
     */
    addFileCamera(name, src, fps) {
      const inp = makeInput('camera', name || 'Camera');
      const v = document.createElement('video');
      v.src = src; v.loop = true; v.muted = true; v.playsInline = true; v.autoplay = true;
      refs.vmxHolder.appendChild(v);
      v.play().catch(() => {});
      inp.el = v;
      inp.camCfg = { width: 0, height: 0, fps: fps || 'auto', resizeMode: '', audioId: '' };
      watchVideoFrames(inp, v);
      return registerInput(inp);
    },
    /**
     * OPEN THE REAL CAMERA, THROUGH THE REAL CODE PATH.
     *
     * Everything else in this file hands the compositor a source this project
     * built. `addCamera` is what the operator's click actually calls:
     * getUserMedia, the resolution and frame-rate negotiation, the settled-rate
     * check, `attachStream`. A fault that lives in any of THAT is invisible to
     * a synthetic source no matter how faithfully the synthetic one is built —
     * which is the same trap that hid the judder in the first place.
     *
     * Skips virtual cameras (OBS, Camo, NDI): they are software sources feeding
     * the same machine, so they inherit its stalls and measure the laptop
     * rather than the camera path.
     */
    async addRealCamera(fps, want) {
      let devs = [];
      try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return { ok: false, why: e.message }; }
      const cams = devs.filter((d) => d.kind === 'videoinput');
      const real = cams.filter((d) => !/virtual|obs|camo|ndi|xsplit|droidcam/i.test(d.label || ''));
      const pick = (want && cams.find((d) => (d.label || '').includes(want))) || real[0] || cams[0];
      if (!pick) return { ok: false, why: 'no video input devices', all: cams.map((d) => d.label) };
      let inp;
      try { inp = await addCamera(pick.deviceId, pick.label, fps ? { fps } : {}); }
      catch (e) { return { ok: false, why: e.message, label: pick.label }; }
      const t = inp.stream && inp.stream.getVideoTracks()[0];
      const st2 = t && t.getSettings ? t.getSettings() : {};
      return { ok: true, id: inp.id, label: pick.label,
               width: st2.width, height: st2.height, frameRate: st2.frameRate,
               others: cams.map((d) => d.label) };
    },
    addStreamCamera(name, fps, w, h) {
      const inp = makeInput('camera', name || 'Camera');
      const cv = document.createElement('canvas');
      cv.width = w || 1280; cv.height = h || 720;
      const c = cv.getContext('2d');
      let n = 0;
      // Repainted far faster than it is captured, so captureStream's clock is
      // what decides when a frame exists.
      // Painted once, then only a narrow moving band is redrawn. Repainting a
      // whole 1920x1080 canvas every few milliseconds costs more on an
      // integrated GPU than capturing it does, and a test source that cannot
      // hold its own frame rate measures the laptop, not the compositor.
      c.fillStyle = '#123'; c.fillRect(0, 0, cv.width, cv.height);
      inp._syntheticTimer = setInterval(() => {
        n++;
        const bw = 160, x = (n * 37) % (cv.width - bw);
        c.fillStyle = '#123'; c.fillRect(0, 0, cv.width, 120);
        c.fillStyle = `hsl(${(n * 11) % 360},70%,50%)`;
        c.fillRect(x, 0, bw, 120);
        c.fillStyle = '#fff'; c.font = 'bold 64px Arial';
        c.fillText('F' + n, 40, 90);
      }, 8);
      attachStream(inp, cv.captureStream(fps || 30));
      return registerInput(inp);
    },
    /**
     * Count, for every compositor draw, how many NEW camera frames the <video>
     * element had presented since the previous draw.
     *
     *   1  — the picture moved on by exactly one frame: what smooth means
     *   0  — the compositor drew a picture it had already drawn (a repeat)
     *  >1  — camera frames that existed and were never drawn (a skip)
     *
     * `presentedFrames` comes from requestVideoFrameCallback, which the spec
     * runs before the animation-frame callbacks of the same rendering
     * opportunity — so at the moment drawFrame reads it, it describes the
     * frame drawFrame is about to draw.
     */
    camSmoothStart(id) {
      const inp = inputById(id);
      const v = inp && inp.el;
      if (!v || v.tagName !== 'VIDEO' || !v.requestVideoFrameCallback) return { ok: false };
      const rec = { presented: 0, base: null, samples: [], t0: performance.now(), deferFrom: st._deferN || 0, blockedFrom: st._deferBlocked || 0 };
      const onVf = (nowT, meta) => {
        rec.presented = meta.presentedFrames || (rec.presented + 1);
        if (rec.base == null) rec.base = rec.presented;
        try { v.requestVideoFrameCallback(onVf); } catch (e) {}
      };
      v.requestVideoFrameCallback(onVf);
      st._camRec = rec;
      st._drawProbe = () => { rec.samples.push(rec.presented); };
      return { ok: true };
    },
    camSmoothStop() {
      const rec = st._camRec;
      st._drawProbe = null; st._camRec = null;
      if (!rec) return null;
      const secs = (performance.now() - rec.t0) / 1000;
      // The first draws after the probe attaches include the attach itself.
      // Measuring them reports set-up as a stall in the compositor.
      const s = rec.samples.slice(Math.min(30, rec.samples.length - 1));
      const deltas = [];
      for (let i = 1; i < s.length; i++) deltas.push(s[i] - s[i - 1]);
      const win = secs * (s.length / Math.max(1, rec.samples.length));
      const hist = {};
      for (const d of deltas) hist[d] = (hist[d] || 0) + 1;
      const repeats = deltas.filter((d) => d === 0).length;
      const skipped = deltas.filter((d) => d > 1).reduce((a, d) => a + (d - 1), 0);
      // The longest run of consecutive repeats: one frozen frame is a flicker,
      // four in a row is the hitch people describe as choppy.
      let worstRun = 0, run = 0;
      for (const d of deltas) { if (d === 0) { run++; worstRun = Math.max(worstRun, run); } else run = 0; }
      // A draw that arrives after MANY source frames is not the beat — it is a
      // hitch, the loop not running at all for a moment — and averaging the two
      // together hides both. Counted apart, and reported.
      const stallD = [], stallAt = [];
      for (let i = 0; i < deltas.length; i++) if (deltas[i] > 5) { stallD.push(deltas[i]); stallAt.push(+(i / (deltas.length || 1) * win).toFixed(1)); }
      const stalls = stallD.length;
      const stallFrames = stallD.reduce((a, d) => a + (d - 1), 0);
      // presentedFrames is cumulative since the element began playing, so the
      // rate has to be measured against where it stood when the probe attached
      // — dividing the running total by the measurement window reports a source
      // delivering more than its own frame rate, which is nonsense.
      const grew = s.length ? s[s.length - 1] - s[0] : 0;
      return {
        seconds: win, draws: s.length, drawFps: s.length / win,
        presented: grew, presentedFps: grew / win,
        rafDt: st.rafDt || 0, rafMin: st.rafMin || 0, renderMs: st.renderMs || 0, slack: !!st._slack,
        deferrals: (st._deferN || 0) - rec.deferFrom,
        deferBlocked: (st._deferBlocked || 0) - rec.blockedFrom,
        uniqueDrawn: deltas.filter((d) => d > 0).length,
        repeats, skipped, worstRun, stalls, stallFrames, stallAt,
        repeatPct: deltas.length ? (repeats * 100) / deltas.length : 0,
        hist,
      };
    },
    /**
     * THE SOUND CARD'S CLOCK AGAINST THE SYSTEM'S, measured rather than assumed.
     *
     * The broadcast stamps its PICTURE from performance.now() (the pacer's grid)
     * and its SOUND from a running sample count divided by the nominal rate.
     * Those are two different crystals. If the card is not running at exactly
     * the rate it says it is, the two timelines advance at different speeds and
     * the gap grows for the whole service — which is invisible in a 30-second
     * test and hundreds of milliseconds by the end of a sermon.
     *
     * Returns the ratio: sound-card seconds per system second.
     */
    async clockRatio(ms) {
      const ac = ensureAudio();
      // NOT awaited. An AudioContext parked by autoplay policy hands back a
      // resume() promise that never settles, and awaiting it hangs this call
      // for ever — a measurement that reports nothing rather than failing.
      ac.resume().catch(() => {});
      // Wait for it to actually be RUNNING before timing anything. currentTime
      // only advances while it is, so timing across the start-up reports the
      // suspended seconds as a clock error — measured once as -99,534 ppm,
      // which is nine seconds of start-up wearing the costume of a crystal.
      for (let i = 0; i < 100 && ac.state !== 'running'; i++) await new Promise((r) => setTimeout(r, 100));
      await new Promise((r) => setTimeout(r, 1500));
      /*
       * SAMPLED THROUGHOUT, not just at the two ends. A single pair cannot tell
       * a clock that is steadily 40 ppm fast from one that ran perfectly and
       * then stalled for a second, and those are completely different faults
       * with completely different fixes. Per-interval ratios separate them: a
       * crystal offset is the same in every interval, a stall is one bad one.
       */
      const step = 3000;
      const n = Math.max(3, Math.round(Math.max(3000, ms || 60000) / step));
      const marks = [];
      let pa = ac.currentTime, pp = performance.now();
      const a0 = pa, p0 = pp;
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, step));
        const a = ac.currentTime, t = performance.now();
        marks.push((a - pa) / ((t - pp) / 1000));
        pa = a; pp = t;
      }
      const aS = pa - a0, pS = (pp - p0) / 1000;
      const sorted = marks.slice().sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      // How much sound never happened at all: intervals where the audio clock
      // fell behind by more than a crystal ever could.
      const stalled = marks.filter((r) => r < 0.995).length;
      return {
        state: ac.state, running: ac.state === 'running',
        sampleRate: ac.sampleRate, audioSeconds: aS, systemSeconds: pS,
        ratio: aS / pS, ppm: (aS / pS - 1) * 1e6, msPerHour: (aS / pS - 1) * 3600 * 1000,
        // The MEDIAN interval is the crystal; the overall ratio also carries
        // whatever was lost to stalls, and the two differing is the whole point.
        medianRatio: med, medianPpm: (med - 1) * 1e6, medianMsPerHour: (med - 1) * 3600 * 1000,
        intervals: n, stalled, worst: sorted[0],
      };
    },
    /**
     * Shorten the drift-correction thresholds so a test can watch the picture's
     * grid take up the sound card's rate within a few minutes. At the shipping
     * values a 51 ppm card needs about eight minutes to gather the evidence,
     * which is longer than any suite here should run.
     */
    setCaptureTuning(patch) { st._capTuning = patch ? { ...patch } : null; return st._capTuning; },
    /**
     * Turn the <video> half of the phase alignment off, so the SAME source on
     * the SAME machine can be measured with it and without it. A before/after
     * taken from two different runs of this laptop is worth very little; an
     * A/B interleaved inside one run is worth something.
     */
    setPhaseAlign(on) { st._noVfAlign = !on; return !st._noVfAlign; },
    addNdiInput,
    // Reads through a scratch 2D canvas rather than the input's own context: an
    // NDI input's canvas is a WebGL surface, which has no 2D context to ask, and
    // this also samples exactly what the compositor would draw.
    inputPixel: (id, x, y) => {
      const i = inputById(id);
      if (!i || !i.el || i.el.tagName !== 'CANVAS') return null;
      try {
        let s = st._probeCanvas;
        if (!s) { s = st._probeCanvas = document.createElement('canvas'); s.width = 8; s.height = 8; }
        const c = s.getContext('2d', { willReadFrequently: true });
        c.clearRect(0, 0, 8, 8);
        c.drawImage(i.el, x || 0, y || 0, 1, 1, 0, 0, 1, 1);
        return [...c.getImageData(0, 0, 1, 1).data];
      } catch (e) { return null; }
    },
    ndiGotVideo: (id) => { const i = inputById(id); return !!(i && i._ndiGotVideo); },
    /* ---- broadcast limiter ---- */
    async limiterReady() { ensureAudio(); await ensureLimiterWorklet(); return !!st.limNode; },
    limiterState: () => ({
      on: st.limiterOn, style: st.limiterStyle, ceilingDb: st.limiterCeiling,
      real: !!st.limNode, meter: st.limMeter ? Object.assign({}, st.limMeter) : null,
      routedThrough: st.limiterOn ? (st.limNode ? 'worklet' : 'compressor') : 'bypassed',
    }),
    setLimiter: (patch) => {
      if (patch && patch.on != null) setLimiterOn(patch.on);
      if (patch && patch.style) setLimiterStyle(patch.style);
      if (patch && patch.ceilingDb != null) setLimiterCeiling(patch.ceilingDb);
      return { on: st.limiterOn, style: st.limiterStyle, ceilingDb: st.limiterCeiling };
    },
    openLimiterModal: () => { openLimiterModal(); return !!refs.vmxModalBox.querySelector('#vmxLimOn'); },
    /**
     * Push a signal through the REAL limiter node and read what comes out.
     *
     * OfflineAudioContext, so it is the shipping worklet doing the work at a
     * known rate with nothing else running — the only way to make a claim about
     * a ceiling that means anything.
     */
    async measureLimiter({ amp = 2, freq = 220, seconds = 0.4, ceilingDb = -1, driveDb = 0, sampleRate = 48000, shape = 'sine' } = {}) {
      const clampN = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
      const oc = new OfflineAudioContext(2, Math.round(sampleRate * seconds), sampleRate);
      await oc.audioWorklet.addModule('limiter-worklet.js');
      const src = oc.createBufferSource();
      const buf = oc.createBuffer(2, oc.length, sampleRate);
      for (let c = 0; c < 2; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const t = i / sampleRate;
          if (shape === 'burst') {
            // silence, then a full-blast tone: the transient a limiter without
            // look-ahead lets straight through
            d[i] = t < seconds / 2 ? 0 : amp * Math.sin(2 * Math.PI * freq * t);
          } else {
            d[i] = amp * Math.sin(2 * Math.PI * freq * t);
          }
        }
      }
      src.buffer = buf;
      const node = new AudioWorkletNode(oc, 'program-limiter', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
        channelCount: 2, channelCountMode: 'explicit',
        processorOptions: { ceilingDb, driveDb, lookMs: 5 },
      });
      let last = null;
      node.port.onmessage = (e) => { last = e.data; };
      src.connect(node); node.connect(oc.destination);
      src.start();
      const out = await oc.startRendering();
      const L = out.getChannelData(0);
      let peak = 0, sum = 0, sumIn = 0;
      // skip the look-ahead priming at the very start
      const from = Math.round(sampleRate * 0.02);
      for (let i = from; i < L.length; i++) {
        const a = Math.abs(L[i]);
        if (a > peak) peak = a;
        sum += L[i] * L[i];
      }
      /*
       * How much of the output is still the tone that went in.
       *
       * This is the measurement that separates a limiter from a clipper: both
       * hold the peak at the ceiling, and only one of them still has a sine
       * wave afterwards. The projection is onto BOTH sine and cosine at the
       * test frequency, because the limiter delays the sound by its look-ahead
       * — correlating against an undelayed reference would score a perfect
       * passthrough at almost zero and say nothing about distortion.
       */
      let ds = 0, dc = 0, es = 0;
      for (let i = from; i < L.length; i++) {
        const w = 2 * Math.PI * freq * (i / sampleRate);
        ds += L[i] * Math.sin(w); dc += L[i] * Math.cos(w);
        es += Math.sin(w) * Math.sin(w);
      }
      // sin and cos are orthogonal over a whole number of cycles and each
      // carries half the energy, so one normaliser serves both
      const inBand = es > 0 ? (ds * ds + dc * dc) / es : 0;
      const purity = sum > 0 ? clampN(inBand / sum, 0, 1) : 0;
      sumIn = 0;
      return {
        peak, peakDb: peak > 0 ? 20 * Math.log10(peak) : -120,
        ceilingLin: Math.pow(10, ceilingDb / 20),
        purity, meter: last, samples: L.length - from, sumIn,
      };
    },
    /* ---- multi-destination sanity ---- */
    /** The live slot objects, so a test can set up a real two-platform rig. */
    rawStreams: () => st.streams,
    openStreamSettings: () => { openStreamSettingsModal(); return true; },
    mismatchedDestinations: () => mismatchedSlots().map((s) => s.num),
    matchDestinations: (ix) => { matchDestinationQualities(ix || 0); return st.streams.map((s) => s.quality); },
    streamAudioKbps,
    programQualityFor: (pending) => programQuality(pending),
    /* ---- clap sync ---- */
    openClapSync,
    /** The solver, fed synthetic sample series — no hardware, no waiting. */
    solveClap: (vs, as, t0) => solveClap(vs, as, t0 || 0),
    /** Apply a measured skew the way the dialog does, and report what it did. */
    applyClap: (camId, audId, skewMs) => {
      const cam = inputById(camId), aud = inputById(audId);
      if (!cam || !aud) return null;
      const r = applyClapResult(cam, aud, skewMs);
      return { inputId: r.input.id, ms: r.ms, what: r.what, camSync: Number(cam.syncMs) || 0, audSync: Number(aud.syncMs) || 0 };
    },
    clapConstants: () => Object.assign({}, CLAP),
    /** Run the REAL listener against the live graph (used with a synthetic clap). */
    listenForClap: (camId, audId) => listenForClap(inputById(camId), inputById(audId)),
    clapDialog: () => {
      const box = refs.vmxModalBox;
      return {
        open: !!box.querySelector('#vmxClapGo'),
        cams: [...box.querySelectorAll('#vmxClapCam option')].map((o) => o.textContent),
        auds: [...box.querySelectorAll('#vmxClapAud option')].map((o) => o.textContent),
        selectedAud: (box.querySelector('#vmxClapAud') || {}).value,
      };
    },
    /* ---- Colour Adjust ---- */
    colourOf: (id) => { const i = inputById(id); return i ? Object.assign({}, colourOf(i)) : null; },
    setColour: (id, patch) => {
      const i = inputById(id); if (!i) return null;
      Object.assign(colourOf(i), patch || {});
      return Object.assign({}, i.colour);
    },
    colourActive: (id) => { const i = inputById(id); return !!(i && colourActive(i.colour)); },
    /** The SVG filter this input's grade compiles to (proves it is real, not a label). */
    colourFilter: (id) => {
      const i = inputById(id); if (!i || !colourActive(i.colour)) return null;
      const el = document.getElementById(colourFilterId(i));
      return el ? el.outerHTML : null;
    },
    autoWhiteBalance: (id) => { const i = inputById(id); return i ? autoWhiteBalance(i) : null; },
    autoLevels: (id) => { const i = inputById(id); return i ? autoLevels(i) : null; },
    /** Open Input Settings for real and report what the Colour panel rendered. */
    colourPanel: (id) => {
      const i = inputById(id); if (!i) return null;
      openInputSettings(i);
      const box = refs.vmxModalBox;
      const ids = ['vmxCol_r', 'vmxCol_g', 'vmxCol_b', 'vmxCol_sat', 'vmxCol_black', 'vmxCol_white', 'vmxCol_alpha'];
      return {
        present: !!box.querySelector('.vmx-colour'),
        sliders: ids.filter((x) => !!box.querySelector('#' + x)),
        buttons: ['vmxColAwb', 'vmxColReset', 'vmxColAuto', 'vmxCol0255', 'vmxCol16235']
          .filter((x) => !!box.querySelector('#' + x)),
        rec601: !!box.querySelector('#vmxColRec601'),
      };
    },
    /** Click a real button in the open Colour panel. */
    colourClick: (btnId) => {
      const b = refs.vmxModalBox && refs.vmxModalBox.querySelector('#' + btnId);
      if (!b) return false;
      b.click();
      return true;
    },
    /** Drive a real slider in the open Colour panel, as a user drags it. */
    colourDrag: (key, value) => {
      const s = refs.vmxModalBox && refs.vmxModalBox.querySelector('#vmxCol_' + key);
      if (!s) return null;
      s.value = String(value);
      s.dispatchEvent(new Event('input', { bubbles: true }));
      const n = refs.vmxModalBox.querySelector('#vmxCol_' + key + '_n');
      return { slider: s.value, number: n ? n.value : null };
    },
    setMonitorVol,
    /** What the Add Input dialog's Camera panel has chosen, and what the camera
     *  is really doing about it (settings) vs. what it was ASKED (constraints —
     *  an `exact` frameRate here is the proof the rate is locked, not hinted). */
    camPanel() {
      const s = st._inputSel;
      if (!s) return null;
      const t = s.previewStream && s.previewStream.getVideoTracks()[0];
      return {
        camFps: s.camFps, camRes: s.camRes, camId: s.camId,
        caps: t && t.getCapabilities ? t.getCapabilities() : null,
        settings: t && t.getSettings ? t.getSettings() : null,
        constraints: t && t.getConstraints ? t.getConstraints() : null,
      };
    },
    /** The frame rate an added camera input is really delivering. */
    inputFps(id) {
      const i = inputById(id);
      const t = i && i.stream && i.stream.getVideoTracks && i.stream.getVideoTracks()[0];
      const s = t && t.getSettings ? t.getSettings() : null;
      return { fps: s ? s.frameRate : null, width: s ? s.width : null, height: s ? s.height : null, cfg: i ? i.camCfg : null };
    },
    // live gain values of the monitor/solo graph — lets tests prove solo and
    // headphone volume affect ONLY the operator's ears, never the broadcast bus
    audioGraph: () => ({
      monitorGate: st.monitorGate ? st.monitorGate.gain.value : null,
      monitorGain: st.monitorGain ? st.monitorGain.gain.value : null,
      masterGain: st.masterGain ? st.masterGain.gain.value : null,
    }),
    soloGainOf: (id) => { const i = inputById(id); return i && i.soloGain ? i.soloGain.gain.value : null; },
    ndiAudioDiag: (id) => { const i = inputById(id); return { acState: st.ac && st.ac.state, acRate: st.ac && st.ac.sampleRate, hasNode: !!(i && i._ndiAudioNode), rx: (i && i._ndiAudioRx) || 0, mix: (i && i._ndiMix) || null, via: (i && i._ndiAudioVia) || null }; },
    /* ---- throughput (test/ndi-perf.test.js) ---- */
    resetPerf: (id) => {
      const i = inputById(id);
      if (i) { i._ndiFrames = 0; i._perfFrom = performance.now(); }
      st._perfDraws = st.frames; st._perfDrawFrom = performance.now();
      return true;
    },
    perf: (id) => {
      const i = inputById(id);
      const secs = (performance.now() - (st._perfDrawFrom || performance.now())) / 1000 || 1;
      return {
        // frames the NDI receiver actually delivered AND we uploaded
        ndiFps: i && i._perfFrom ? (i._ndiFrames || 0) / (((performance.now() - i._perfFrom) / 1000) || 1) : 0,
        ndiDeliveredFps: i ? ndiDeliveredFps(i) : 0,
        ndiSrcFps: i ? ndiFpsOf(i) : 0,
        fmt: (i && i._ndiFmt) || '',
        drawFps: st.fps || 0,
        // What the desk now shows beside it: draws that showed a CHANGED
        // picture. The two differing is the whole fault this round was about.
        movingFps: st.movingFps == null ? (st.fps || 0) : st.movingFps,
        targetFps: st.targetFps || 0,
        renderMs: st.renderMs || 0,
        accelerated: !!(i && i._ndiSurface && i._ndiSurface.accelerated),
        captureMode: st.pgmCaptureMode || '',
        secs,
      };
    },
    startRecording: () => toggleRecord(),
    stopRecording: () => stopRecord(),
    /* ---- A/V sync ---- */
    setInputSync: (id, ms) => { const i = inputById(id); if (i) setInputSyncMs(i, ms); return i ? i.syncMs : null; },
    syncState: (id) => {
      const i = inputById(id); if (!i) return null;
      const s = i._sync || {};
      return {
        syncMs: Number(i.syncMs) || 0, autoMs: s.autoMs == null ? null : s.autoMs,
        audioMs: s.audioMs || 0, videoMs: s.videoMs || 0,
        queueMs: s.queueMs || 0, bufferTargetMs: s.targetMs || 0,
        underruns: s.underruns || 0, underrunEvents: s.underrunEvents || 0,
        maxAudioGapMs: Math.round(s.maxAudioGapMs || 0),
        // Is the SOURCE actually supplying real-time audio? (fed samples per
        // second of wall clock vs. the graph's rate — 1.0 means it keeps up.)
        feedRatio: s.fedFrom && st.ac
          ? +((s.fedSamples / ((performance.now() - s.fedFrom) / 1000)) / st.ac.sampleRate).toFixed(3) : null,
        droppedPackets: s.droppedPackets || 0, srcRate: s.srcRate || 0, acRate: st.ac ? st.ac.sampleRate : 0,
        // The NDI worklet's clock loop: the trim it is reading at now, the
        // offset between the two crystals it has converged on, and how many
        // backlogs it had to skip. `via` says whether the sound reaches it
        // straight from the receiver ('worklet') or relayed through here.
        senderGapMs: Math.round(s.senderGapMs || 0), receiverGapMs: Math.round(s.receiverGapMs || 0),
        fedSamples: Math.round(s.fedSamples || 0),
        startupDropouts: s.startupDropouts || 0, skips: s.skips || 0, trimPpm: s.trimPpm || 0, clockPpm: s.clockPpm || 0, via: i._ndiAudioVia || null,
        delayNodeSec: i.delayNode ? i.delayNode.delayTime.value : null,
        videoQueued: i._vd ? i._vd.q.length : 0,
        drawingDelayed: drawSourceOf(i) !== i.el,
        // how old the picture was when it was put on screen — the hold-back the
        // compositor actually applied (not padded by the time since that draw)
        displayedAgeMs: i._vd && i._vd.shownAgeMs != null ? Math.round(i._vd.shownAgeMs) : null,
        sinceDrawMs: i._vd && i._vd.shownAt ? Math.round(performance.now() - i._vd.shownAt) : null,
        samples: { a: (s.aOff || []).length, v: (s.vOff || []).length },
        note: syncNoteFor(i),
      };
    },
    setAutoSync: (v) => { st.avAutoSync = !!v; syncTick(); return st.avAutoSync; },
    syncTick,
    /** Feed synthetic arrival data (no NDI hardware needed) to exercise the
     *  measurement + correction maths exactly as live frames would. */
    feedSyncSample: (id, kind, tsNs) => { const i = inputById(id); if (i) noteArrival(i, kind, tsNs); },
    setSyncQueueMs: (id, ms) => { const i = inputById(id); if (i) syncOf(i).queueMs = ms; },
    resetSyncSamples: (id) => { const i = inputById(id); if (i) { const s = syncOf(i); s.aOff = []; s.vOff = []; } },
    ndiAudioTargetMs: () => NDI_AUDIO_TARGET_MS,
    syncEnv: () => ({ outputLatencyMs: outputLatencyMs(), targetFps: st.targetFps || 30, autoSync: st.avAutoSync }),
    /**
     * The two program-capture clocks, measured against ONE wall clock.
     *
     * The picture and the sound reach the encoder on different Chromium clocks
     * (canvas frames are stream-relative, WebAudio buffers boot-relative), so
     * the only way to know whether they are being placed on the SAME moment is
     * to record, for every item, when it turned up (`at`, on performance.now)
     * next to the timestamp it claims (`ts`). `ts - at` is that track's clock
     * epoch plus however long delivery took; the LARGEST value a track produces
     * is therefore its true epoch, and comparing the two epochs says whether
     * the sound will land on the picture. `preDelayMs` reproduces the wait for
     * the hub session that sits between building the stream and reading it.
     */
    /** The clocks the LIVE capture measured for itself (null on the WebM path). */
    captureDiag: () => (st.pgmRec && st.pgmRec.clockDiag ? st.pgmRec.clockDiag() : null),
    /** Did the capture actually get its own thread, and did the sound follow? */
    captureHost: () => captureHost(),
    /* ---- Add Input: what the dialog is doing, for the speed test ---- */
    deviceCache: () => ({
      cams: devCache.cams ? devCache.cams.length : null,
      mics: devCache.mics ? devCache.mics.length : null,
      bound: devCache.bound,
    }),
    inputSelectState: () => {
      const s = st._inputSel;
      if (!s) return null;
      return {
        cat: s.cat,
        // null means "still looking"; a number means the list is rendered
        cams: s.cams ? s.cams.length : null,
        mics: s.mics ? s.mics.length : null,
        camId: s.camId, micId: s.micId,
        previewing: !!s.previewStream, previewFailed: !!s.camPreviewFailed,
      };
    },
    closeInputSelect: () => { if (st._inputSelClose) st._inputSelClose(); return true; },
    /* ---- virtual set ---- */
    addVirtualSet,
    vsetGoTo,
    vsetPos: (id) => { const i = inputById(id); return i && i._vset ? i._vset.mover.current() : null; },
    vsetMoving: (id) => { const i = inputById(id); return !!(i && i._vset && i._vset.mover.moving); },
    vsetPresets: (id) => { const i = inputById(id); return i && i._vset ? i._vset.presets : null; },
    vsetRenders: (id) => { const i = inputById(id); return i && i._vset ? (i._vset.renders || 0) : -1; },
    vsetSetKey: (id, patch) => {
      const i = inputById(id);
      if (!i || !i._vset) return false;
      Object.assign(i._vset.key, patch || {});
      return true;
    },
    /**
     * A stand-in camera for keying tests: a green screen with a red block
     * where the presenter would be. Real enough to prove a key by pixel, and
     * it needs no webcam.
     */
    addGreenScreen(name) {
      const inp = makeInput('camera', name || 'Green Screen');
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 360;
      const c = cv.getContext('2d');
      c.fillStyle = '#00b140'; c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#e01010'; c.fillRect(cv.width * 0.36, cv.height * 0.3, cv.width * 0.28, cv.height * 0.7);
      inp.el = cv;
      return registerInput(inp);
    },
    async captureClocks({ preDelayMs = 0, ms = 3000 } = {}) {
      const stream = buildOutStream();
      if (preDelayMs) await new Promise((r) => setTimeout(r, preDelayMs));
      const vR = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }).readable.getReader();
      const aR = new MediaStreamTrackProcessor({ track: stream.getAudioTracks()[0] }).readable.getReader();
      const t0 = performance.now();
      const v = [], a = [];
      let stop = false;
      const pump = (reader, out, extra) => (async () => {
        for (;;) {
          let r;
          try { r = await reader.read(); } catch (e) { break; }
          if (r.done || stop) { if (r.value) r.value.close(); break; }
          out.push({ at: +(performance.now() - t0).toFixed(1), ts: +(r.value.timestamp / 1000).toFixed(1), ...(extra ? extra(r.value) : null) });
          r.value.close();
        }
      })();
      pump(vR, v, null);
      pump(aR, a, (d) => ({ n: d.numberOfFrames, sr: d.sampleRate }));
      await new Promise((r) => setTimeout(r, ms));
      stop = true;
      try { await vR.cancel(); } catch (e) {}
      try { await aR.cancel(); } catch (e) {}
      st.outStream = null;   // the readers consumed it; the next capture builds its own
      return { t0, v, a };
    },
    /** Paint a solid colour into a synthetic input's canvas (for delay tests). */
    paintInput: (id, css) => {
      const i = inputById(id);
      if (!i || !i.el || i.el.tagName !== 'CANVAS') return false;
      if (i._syntheticTimer) { clearInterval(i._syntheticTimer); i._syntheticTimer = null; }
      const c = i.el.getContext('2d');
      c.fillStyle = css; c.fillRect(0, 0, i.el.width, i.el.height);
      return true;
    },
    setPreview, cut, startTransition, setTbar, toggleFTB, toggleOverlay, quickPlay,
    // How often the input rail was torn down and rebuilt. Cutting must not
    // move this — see the note above renderInputs().
    railRebuilds,
    warmCapture, captureWarmed: () => capWarm.done,
    closeInput, closeAllInputs, startPlaylist, stopPlaylist,
    forceTrans(fx, m) {
      // deterministic mid-transition state for pixel tests
      if (st.previewId == null || st.previewId === st.programId) return false;
      st.trans = { from: st.programId, to: st.previewId, fx: fx || 'Fade', dur: 0, t0: 0, m: clamp(m, 0, 0.984), manual: true };
      return true;
    },
    setFtbLevel(v) { st.ftbLevel = clamp(v, 0, 1); st.ftbOn = v > 0.5; },
    setOverlayLevel(ch, v) { st.ovl[ch].level = clamp(v, 0, 1); },
    toggleStream, stopAllStreams, startAllStreams, toggleRecord, stopRecord, toggleExternal,
    // number-indexed (1/2/3) so a test can't accidentally operate on a detached
    // copy of a slot the way it would if it passed state().streams[i] by value
    startStreamNum: (num) => startOneStream(st.streams[num - 1]),
    stopStreamNum: (num) => stopOneStream(st.streams[num - 1]),
    serializePreset, restorePreset,
    setLiveCfg: (patch) => saveLiveCfg(patch),
    productionFps, resolveQ, canonicalQ,
    qualityGroups: () => QUALITY_GROUPS,
    setStreamSlot: (num, patch) => { const s = st.streams[num - 1]; if (s) Object.assign(s, patch); },
    /** What the Streaming Settings dialog would tell the operator right now. */
    async mismatchInfo() {
      await refreshMismatch();
      return { bad: mismatchedSlots().map((s) => s.num), note: mismatchNoteHtml().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() };
    },
    setAutoMix: (v) => { st.autoMix = !!v; },
    setOverlayMode: (ch, mode) => { st.ovl[ch].mode = mode; },
    inputGain: (id) => { const i = inputById(id); return i && i.gain ? i.gain.gain.value : null; },
    pgmPixel: (x, y) => [...refs.pgmCtx.getImageData(x, y, 1, 1).data],
    prvPixel: (x, y) => [...refs.prvCtx.getImageData(x, y, 1, 1).data],
    pgmSize: () => [refs.vmxPgmCanvas.width, refs.vmxPgmCanvas.height],
    drawNow: () => drawFrame(performance.now()),
    clickCell: (id, act, ov) => {
      const cell = refs.vmxInputs.querySelector(`.vmx-input[data-id="${id}"]`);
      if (!cell) return false;
      const target = act ? cell.querySelector(`button[data-act="${act}"]${ov != null ? `[data-ov="${ov}"]` : ''}`) : cell.querySelector('.vmx-in-thumb') || cell;
      if (!target) return false;
      target.click();
      return true;
    },
  };

  /** Lightweight status for the Dashboard card — safe to poll from outside this module. */
  function getStatus() {
    const streamCount = st.streams.filter((s) => s.streaming).length;
    const pgm = inputById(st.programId);
    return {
      streaming: streamCount > 0, streamCount,
      recording: st.recording,
      live: streamCount > 0 || st.recording,
      programName: pgm ? pgm.name : null,
    };
  }

  return { init, onShow, getStatus, __test, QUALITY };
})();
