'use strict';
const { spawn } = require('child_process');
const streamrate = require('./streamrate');

/**
 * Live streaming / recording engine (the vMix-style "Go Live" backend).
 *
 * The renderer composites the program on a canvas, captures it, and encodes ONE
 * WebM stream with MediaRecorder which arrives here as a chunk feed.
 *
 * ProgramHub then does the expensive work exactly ONCE:
 *
 *      renderer WebM ──► [hub ffmpeg]  decode once, encode H.264/AAC once
 *                            │          (hardware encoder when available)
 *                            │  MPEG-TS on stdout
 *          ┌─────────────────┼─────────────────┬────────────────┐
 *          ▼                 ▼                 ▼                ▼
 *    dest 1 ffmpeg     dest 2 ffmpeg     dest 3 ffmpeg    recording ffmpeg
 *    -c copy → RTMP    -c copy → RTMP    -c copy → RTMP   -c copy → MP4
 *
 * Two things fall out of this that the old "one ffmpeg per destination, each
 * fed the raw WebM" design could not do:
 *
 *  1. A destination can join (or leave, or reconnect) AT ANY TIME. MPEG-TS is a
 *     self-synchronising broadcast format — it repeats its stream headers and
 *     carries a keyframe every GOP — so a late joiner locks on within ~2s. Feeding
 *     a second ffmpeg the middle of a WebM stream, by contrast, cannot work at
 *     all: the EBML header only exists once at the very start, and Chromium's
 *     MediaRecorder emits a keyframe about as rarely. That was the exact cause of
 *     "Destination N stream ended: The camera feed could not be read".
 *
 *  2. N destinations cost one decode + one encode, not N of each. Adding a fourth
 *     platform, or recording while streaming, is nearly free.
 *
 * The bundled ffmpeg supports rtmps natively, which Facebook requires.
 */

const DESTINATIONS = {
  facebook: { name: 'Facebook Live', url: 'rtmps://live-api-s.facebook.com:443/rtmp/' },
  youtube:  { name: 'YouTube Live',  url: 'rtmp://a.rtmp.youtube.com/live2/' },
  custom:   { name: 'Custom RTMP',   url: '' },
};

// vMix-style streaming quality presets. `fps: null` means "follow the
// production frame rate" (the renderer detects the camera's real rate so a
// 25/50fps camcorder isn't judder-converted to 30) — only presets that name a
// rate (Twitch p60/p30) force one. `profile` maps to x264 -profile:v.
const q = (width, height, videoKbps, audioKbps, fps = null, profile = null) =>
  ({ width, height, videoKbps, audioKbps, fps, profile });
const QUALITIES = {
  'H264 720p 2.5mbps AAC 128kbps':                  q(1280, 720,  2500,  128),
  'H264 720p 1.5mbps AAC 96kbps':                   q(1280, 720,  1500,  96),
  'Facebook H264 720p 1.5mbps AAC 128kbps':         q(1280, 720,  1500,  128),
  'Facebook H264 720p 2.5mbps AAC 128kbps':         q(1280, 720,  2500,  128),
  'Facebook H264 720p 3.5mbps AAC 128kbps':         q(1280, 720,  3500,  128),
  'Facebook H264 1080p 4.5mbps AAC 128kbps':        q(1920, 1080, 4500,  128),
  'Facebook H264 1080p 6mbps AAC 128kbps':          q(1920, 1080, 6000,  128),
  'H264 480p 1mbps AAC 96kbps':                     q(854,  480,  1000,  96),
  'H264 480p 500kbps AAC 96kbps':                   q(854,  480,  500,   96),
  'H264 360p 750kbps AAC 96kbps':                   q(640,  360,  750,   96),
  'H264 360p 400kbps AAC 96kbps':                   q(640,  360,  400,   96),
  'H264 240p 400kbps AAC 96kbps':                   q(426,  240,  400,   96),
  'H264 240p 300kbps AAC 96kbps':                   q(426,  240,  300,   96),
  'H264 1080p 6mbps AAC 128kbps':                   q(1920, 1080, 6000,  128),
  'H264 1080p 4.5mbps AAC 128kbps':                 q(1920, 1080, 4500,  128),
  'H264 1080p 3mbps AAC 128kbps':                   q(1920, 1080, 3000,  128),
  'Twitch H264 1080p60 6mbps High AAC 128kbps':     q(1920, 1080, 6000,  128, 60, 'high'),
  'Twitch H264 1080p30 4.5mbps High AAC 128kbps':   q(1920, 1080, 4500,  128, 30, 'high'),
  'Twitch H264 720p60 4.5mbps High AAC 128kbps':    q(1280, 720,  4500,  128, 60, 'high'),
  'Twitch H264 720p30 3.5mbps High AAC 128kbps':    q(1280, 720,  3500,  128, 30, 'high'),
  'Twitter Low H264 720p 900kbps AAC 96kbps':       q(1280, 720,  900,   96),
  'Twitter Recommended H264 720p 2.5mbps AAC 128kbps': q(1280, 720, 2500, 128),
  'Twitter Max H264 720p 4mbps AAC 128kbps':        q(1280, 720,  4000,  128),
  'Vertical H264 1280 2.5mbps Main AAC 128kbps':    q(720,  1280, 2500,  128, null, 'main'),
  'Vertical H264 1280 3.5mbps Main AAC 128kbps':    q(720,  1280, 3500,  128, null, 'main'),
  'Vertical H264 1920 4.5mbps Main AAC 128kbps':    q(1080, 1920, 4500,  128, null, 'main'),
  'Vertical H264 1920 6mbps Main AAC 128kbps':      q(1080, 1920, 6000,  128, null, 'main'),
  'H264 2160p 8mbps AAC 128kbps':                   q(3840, 2160, 8000,  128),
  'H264 2160p 13mbps AAC 128kbps':                  q(3840, 2160, 13000, 128),
};

// UI grouping (vMix's Streaming Quality dropdown, in optgroups).
const QUALITY_GROUPS = [
  { name: 'Recommended', keys: ['H264 720p 2.5mbps AAC 128kbps', 'H264 720p 1.5mbps AAC 96kbps'] },
  { name: 'Facebook', keys: ['Facebook H264 720p 1.5mbps AAC 128kbps', 'Facebook H264 720p 2.5mbps AAC 128kbps',
    'Facebook H264 720p 3.5mbps AAC 128kbps', 'Facebook H264 1080p 4.5mbps AAC 128kbps', 'Facebook H264 1080p 6mbps AAC 128kbps'] },
  { name: 'Low bandwidth', keys: ['H264 480p 1mbps AAC 96kbps', 'H264 480p 500kbps AAC 96kbps',
    'H264 360p 750kbps AAC 96kbps', 'H264 360p 400kbps AAC 96kbps', 'H264 240p 400kbps AAC 96kbps', 'H264 240p 300kbps AAC 96kbps'] },
  { name: 'Full HD', keys: ['H264 1080p 6mbps AAC 128kbps', 'H264 1080p 4.5mbps AAC 128kbps', 'H264 1080p 3mbps AAC 128kbps'] },
  { name: 'Twitch', keys: ['Twitch H264 1080p60 6mbps High AAC 128kbps', 'Twitch H264 1080p30 4.5mbps High AAC 128kbps',
    'Twitch H264 720p60 4.5mbps High AAC 128kbps', 'Twitch H264 720p30 3.5mbps High AAC 128kbps'] },
  { name: 'Twitter / X', keys: ['Twitter Low H264 720p 900kbps AAC 96kbps',
    'Twitter Recommended H264 720p 2.5mbps AAC 128kbps', 'Twitter Max H264 720p 4mbps AAC 128kbps'] },
  { name: 'Vertical (Reels / TikTok)', keys: ['Vertical H264 1280 2.5mbps Main AAC 128kbps',
    'Vertical H264 1280 3.5mbps Main AAC 128kbps', 'Vertical H264 1920 4.5mbps Main AAC 128kbps', 'Vertical H264 1920 6mbps Main AAC 128kbps'] },
  { name: '4K', keys: ['H264 2160p 8mbps AAC 128kbps', 'H264 2160p 13mbps AAC 128kbps'] },
];

const DEFAULT_QUALITY = 'H264 720p 2.5mbps AAC 128kbps';

/*
 * STREAMING SOUND QUALITY — a separate dial from the picture presets.
 *
 * Every preset above says "AAC 128kbps" because that is what the vMix preset
 * list says, and 128 is fine for a person talking. It is NOT fine for a room
 * full of people singing over a band: AAC spends its bits where the sound is
 * dense, and a congregation plus drums plus a piano is about as dense as
 * church audio gets. At 128 the result is the smeared, watery, slightly
 * metallic sound people describe as "weird when they sing" — and it is the one
 * problem that no limiter, fader or platform setting can fix afterwards,
 * because the detail is already gone by the time it leaves the building.
 *
 * 160 kbps is the default here (OBS ships 160 for the same reason) and costs
 * an extra 4 MB per hour of stream — nothing next to the picture. The hub
 * encodes ONCE at whichever of these is chosen, and every destination copies
 * that stream through untouched, so the choice costs no extra CPU either.
 */
const AUDIO_QUALITIES = [
  { id: 'standard', kbps: 128, label: 'Standard — 128 kbps', hint: 'Fine for speech. What the old presets used.' },
  { id: 'music', kbps: 160, label: 'Music — 160 kbps (recommended)', hint: 'Handles a full band and a singing congregation without going watery.' },
  { id: 'best', kbps: 192, label: 'Best — 192 kbps', hint: 'The most any platform will take advantage of. Use it if the music is the point.' },
];
const DEFAULT_AUDIO_QUALITY = 'music';
const audioKbpsFor = (id) =>
  (AUDIO_QUALITIES.find((a) => a.id === id) || AUDIO_QUALITIES.find((a) => a.id === DEFAULT_AUDIO_QUALITY)).kbps;

/*
 * 48 kHz everywhere, deliberately.
 *
 * WebAudio runs the program bus at the sound card's rate, which is 48 kHz on
 * essentially every machine a church streams from, and the GPU capture path
 * encodes AAC at that rate. Forcing 44.1 kHz anywhere downstream inserted a
 * resample of the whole service for no reason — every platform (YouTube,
 * Facebook, Twitch, X) takes 48 kHz AAC over RTMP; it is what OBS sends by
 * default. Matching the source end to end means the common case is a straight
 * copy with no rate conversion at all.
 */
const OUT_SAMPLE_RATE = 48000;

/*
 * Audio filter for anything that must genuinely re-encode.
 *
 * A live MPEG-TS arriving over a pipe can have small timestamp discontinuities —
 * a hub restart, a shed burst, a hiccup in the renderer's capture. Without this,
 * ffmpeg butts the samples either side of the gap straight together, and every
 * one of those splices is an audible click. `aresample=async` stretches or pads
 * across the gap instead, which is inaudible.
 */
const AUDIO_RESAMPLE = 'aresample=async=1:min_hard_comp=0.100:first_pts=0';

/* ==================== RECORDING AUDIO FORMAT ====================
 *
 * The hub broadcasts H.264 + AAC because every streaming platform demands
 * exactly that — RTMP destinations are NOT configurable here and never will be
 * (YouTube and Facebook reject anything else outright).
 *
 * A RECORDING is a different thing: it is a file that has to open in whatever
 * the church already owns. AAC-in-MP4 carries the `mp4a` tag, and while modern
 * players are fine with it, older editors and presentation software on the
 * team's machines are not — which is the complaint this exists to answer. So
 * the recording gets a choice, and each option below is proved by
 * `test/rec-audio-formats.test.js`: it is really written, really probed, and
 * really loaded in a Chromium <video> to confirm the audio DECODES.
 *
 * `chromiumMustPlay` marks the options whose label promises broad
 * compatibility — those must pass the playback check or the claim is a lie.
 * PCM is deliberately not marked: browsers don't decode PCM-in-MOV, but video
 * editors do, and that is exactly who it is for.
 */
const REC_FORMATS = [
  {
    id: 'aac', ext: '.mp4', label: 'AAC in MP4 — best for uploading (smallest files)',
    hint: 'What YouTube, Facebook and phones expect. Leave this unless a program refuses to open your recording.',
    probeCodec: 'aac', chromiumMustPlay: true,
    /*
     * NOT copied, even though the hub's sound is already AAC at the right
     * bitrate — see recFormat() below for the whole story. Copying here is the
     * single change that would make every recording unplayable on Windows
     * again, so the reason lives on the format itself as well.
     */
    canCopy: false,
  },
  {
    id: 'mp3', ext: '.mkv', label: 'MP3 in MKV — opens in almost anything',
    hint: 'Use when a recording will not open or has no sound in older editing or presentation software. MKV is the container that carries MP3 cleanly.',
    probeCodec: 'mp3', chromiumMustPlay: false, canCopy: false,
  },
  /*
   * "MP3 in MP4" USED TO BE OFFERED HERE. It has been withdrawn, and the reason
   * is worth keeping so nobody adds it back as a kindness.
   *
   * It existed as the escape hatch for "my machine cannot open mp4a" — which
   * turned out to be this file's own fragmented-copy bug (see recFormat below),
   * now fixed. And it never actually worked as an escape hatch: Media
   * Foundation has no decoder for MP3 inside an MP4 container, so Windows
   * refuses it with the very same MF_E_TOPO_CODEC_NOT_FOUND the operator was
   * running away from. Measured, on Windows 11, in test/rec-audio-formats.
   * A fallback that cannot open is not a fallback; it is a second dead end
   * offered to someone already stuck. MKV (below) genuinely does open, and the
   * default AAC/MP4 now does too. Saved settings naming it fall back to the
   * default automatically, because recFormat() resolves unknown ids.
   */
  {
    id: 'pcm', ext: '.mov', label: 'Uncompressed PCM in MOV — for video editing',
    hint: 'Perfect quality with no re-compression, and the friendliest option for editing software. Files are much larger — roughly 0.6 GB extra per hour of audio.',
    probeCodec: 'pcm_s16le', chromiumMustPlay: false, canCopy: false,
  },
];
const DEFAULT_REC_FORMAT = 'aac';

/**
 * The ffmpeg arguments for one recording format. `audioArgs` re-encodes (or
 * copies, for AAC); `muxArgs` picks the container and, for MP4, the fragmented
 * layout that keeps a file playable even if the machine dies mid-service.
 */
function recFormat(id) {
  const f = REC_FORMATS.find((x) => x.id === id) || REC_FORMATS.find((x) => x.id === DEFAULT_REC_FORMAT);
  const FRAG_MP4 = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'];
  const enc = {
    /*
     * THE RECORDING'S AAC IS RE-ENCODED, NOT COPIED. This costs a little CPU
     * and it is not optional.
     *
     * Copying looked free and correct: the hub's sound is already AAC at the
     * right bitrate, and `aac_adtstoasc` turns the MPEG-TS's ADTS frames into
     * the config form MP4 wants. What that misses is WHEN each thing happens.
     * `+empty_moov` (below) makes ffmpeg write the moov header IMMEDIATELY, so
     * a file that dies mid-service is still playable — but the
     * AudioSpecificConfig that aac_adtstoasc derives can only exist once the
     * FIRST AUDIO PACKET has been seen, which is after the header has already
     * gone out. The recording therefore got an `esds` with no
     * DecoderSpecificInfo at all.
     *
     * ffmpeg and Chromium both guess the missing config and play it, which is
     * why this shipped. Windows does not guess: Media Foundation cannot build
     * an AAC decoder without that config and fails with
     * MF_E_TOPO_CODEC_NOT_FOUND (0xC00D5212) — on screen, in Media Player:
     * "It's encoded in mp4a format which isn't supported. You can still watch
     * the video." A whole service was recorded with no usable sound.
     *
     * An encoder, unlike a bitstream filter, publishes its extradata when it is
     * CONFIGURED — before the header is written — so the esds comes out
     * complete and the file keeps its crash-resilient fragmented layout.
     * Measured on all three variants with a real Media Foundation decode:
     * fragmented+copy FAILS, fragmented+re-encode and plain+copy both decode.
     * Proved by test/rec-windows-playback.test.js.
     */
    aac: (kbps) => ['-c:a', 'aac', '-b:a', kbps + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE],
    mp3: (kbps) => ['-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE],
    mp3mp4: (kbps) => ['-c:a', 'libmp3lame', '-b:a', kbps + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE],
    pcm: () => ['-c:a', 'pcm_s16le', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE],
  }[f.id];
  const mux = {
    aac: (out) => [...FRAG_MP4, '-f', 'mp4', out],
    mp3: (out) => ['-f', 'matroska', out],
    mp3mp4: (out) => [...FRAG_MP4, '-f', 'mp4', out],
    pcm: (out) => ['-f', 'mov', out],
  }[f.id];
  return {
    ...f,
    /** Audio encoder args at the given bitrate (ignored by PCM). */
    audioArgs: (kbps) => enc(kbps || 128),
    /*
     * The same, for a source whose audio is NOT already AAC.
     *
     * Every format now RE-ENCODES the recording's sound, so this is the same
     * answer either way and is kept only so callers need not know that. It used
     * to matter, and the reason is worth keeping: a MediaRecorder's WebM
     * carries Opus, and handing ffmpeg `-c:a copy -bsf:a aac_adtstoasc` for an
     * Opus track does not fall back to encoding; it refuses to open the output
     * at all:
     *     Error initializing bitstream filter: aac_adtstoasc
     *     Error opening output files: Invalid argument
     * …and the recording is a ZERO-BYTE FILE. That is what every MultiCorder
     * take was, on every machine, silently.
     */
    audioArgsFromOpus: (kbps) => enc(kbps || 128),
    /** Container + destination path. */
    muxArgs: (out) => mux(out),
    /** Swap a path's extension to the one this format needs. */
    withExt: (p) => String(p).replace(/\.[^.\\/]+$/, '') + f.ext,
  };
}

// Settings saved by the old 4-choice picker keep working: the legacy keys are
// real entries in QUALITIES aliased to the closest vMix preset.
const LEGACY_QUALITY = {
  '4K':    'H264 2160p 13mbps AAC 128kbps',
  '1080p': 'H264 1080p 4.5mbps AAC 128kbps',
  '720p':  'H264 720p 2.5mbps AAC 128kbps',
  '480p':  'H264 480p 1mbps AAC 96kbps',
};
for (const [legacy, canonical] of Object.entries(LEGACY_QUALITY)) QUALITIES[legacy] = QUALITIES[canonical];

/* ===================== copy, or a second live encode? =====================
 *
 * THE most consequential decision in the whole broadcast, and the one an
 * operator can least see. The program is encoded ONCE and fanned out; a
 * destination whose settings match that encode is copied through byte for byte
 * and costs almost nothing. A destination that does NOT match has to be decoded
 * and re-encoded, live, on the same computer that is already compositing the
 * service and feeding everyone else — and on a church PC that second encode
 * falls behind real time, its buffer fills, picture gets dropped to protect the
 * sound, and the platform reports a bad connection on a perfectly good line.
 * Which destination suffers is simply whichever one did not match.
 *
 * ONE definition of "matches", used by the hub when it spawns an output AND by
 * the Streaming Settings dialog when it decides whether to warn. They were two
 * definitions once: the dialog compared only the frame SIZE, so setting one
 * destination to a lower BITRATE — the obvious thing to try when a platform
 * looks unhappy — silently started a second live encode while the dialog
 * cheerfully said "all your destinations use the same size, so the service is
 * encoded once and copied to each of them".
 *
 * The bitrate only has to be CLOSE, not equal: the hub encodes at the highest
 * of all consumers, and a destination that asked for a little less is far
 * better served by the copy than by a second, worse encode. Past ~35% over its
 * ask, re-encode — a genuinely low-bandwidth destination must not be handed a
 * 6 mbps feed.
 */
const COPY_BITRATE_TOLERANCE = 1.35;

/*
 * THE PRESET CHOOSES THE PICTURE. THE PLATFORM CHOOSES WHAT THAT PICTURE COSTS.
 *
 * Every preset in the list above carries a bitrate, and for years that number
 * was treated as the answer. It is not — it is a number vMix printed next to a
 * picture size, and the platform receiving the stream has its own, different
 * number for the same size, which it will quote back at the operator in a
 * yellow banner for the whole service:
 *
 *     The stream's current bitrate (2278.74 Kbps) is lower than the
 *     recommended bitrate. We recommend that you use a stream bitrate
 *     of 6800 Kbps.
 *
 * Nothing was broken when that appeared. The line was fine, the encoder was
 * fine, the copy path was fine. The app was simply sending a 1080p picture at
 * a bitrate that came from somewhere with no opinion about 1080p — sometimes
 * from a 720p preset on a different destination, sometimes from the largest
 * 1080p preset the list has, which is 6 mbps against YouTube's 6800 for 1080p60
 * and therefore under-rated even at full tilt.
 *
 * So the preset's bitrate becomes a FLOOR and the platform's recommendation for
 * the picture actually being encoded becomes the target. An operator picking
 * "1080p" is choosing how big the picture is; what that costs on the wire is
 * not something they should have to look up, and it is not something a preset
 * list from another product can know.
 *
 * This is deliberately in the same file, a dozen lines from canCopyQuality,
 * because the two rules MUST agree. Raising the shared encode without raising
 * what each destination is understood to want would push every destination past
 * COPY_BITRATE_TOLERANCE and re-encode all of them live — the exact trap
 * documented above, sprung by the fix for something else. Both sides call this.
 */
/*
 * A LITTLE ABOVE THE RECOMMENDATION, NEVER EXACTLY ON IT.
 *
 * The platform compares a MEASURED bitrate over the last few seconds with its
 * recommendation. Aiming at exactly the recommendation makes every ordinary
 * wobble — a quiet passage, a keyframe landing outside the window, the filler
 * rounding down — a failed comparison, so the warning appears intermittently on
 * a stream that is nominally correct. This margin costs a few hundred kbps of a
 * church's upload and is what turns "usually fine" into "never warns"; it is
 * always clamped to the top of the platform's own published band, so it can
 * never ask for more than the platform is willing to accept.
 */
const PLATFORM_HEADROOM = 1.06;

function platformKbps(chosenKbps, { width, height, fps, capKbps } = {}) {
  const chosen = Math.round(Number(chosenKbps) || 0);
  if (!width || !height) return chosen;
  const band = streamrate.bandFor(width, height, fps);
  /*
   * `capKbps` is what the line has been MEASURED to carry for this destination
   * (uplink.js). Chasing a recommendation the line cannot feed does not stop
   * the warning — auto-fit pulls the rate straight back down and the picture is
   * worse on the way — so the cap wins, and the caller is expected to say
   * plainly that a smaller picture is the actual fix. It never drags the rate
   * BELOW what the operator chose: that is their decision, not ours.
   */
  const target = Math.min(Math.round(band.rec * PLATFORM_HEADROOM), band.max);
  const cap = Math.round(Number(capKbps) || 0);
  return Math.max(chosen, cap > 0 ? Math.min(target, cap) : target);
}

function canCopyQuality(have, want) {
  if (!have || !want) return false;
  return want.width === have.width && want.height === have.height && !want.profile &&
         (want.fps || have.fps) === have.fps &&
         have.videoKbps <= (want.videoKbps || have.videoKbps) * COPY_BITRATE_TOLERANCE;
}

/**
 * Which of these destinations would have to be re-encoded live, given that the
 * hub encodes once at the most demanding of them? Returns their indexes.
 *
 * `productionFps` is the rate the program is actually captured at (the camera's
 * real rate, usually) — a preset that names its own rate, like Twitch p60,
 * cannot be copied from a 30fps program and that has to count as a mismatch.
 */
function reEncodedAmong(qualities, productionFps, lineCapKbps) {
  const qs = (qualities || []).filter(Boolean);
  if (qs.length < 2) return [];
  const biggest = qs.reduce((m, q) => (q.width * q.height > m.width * m.height ? q : m), qs[0]);
  const fps = Math.round(Number(productionFps) || 30);
  /*
   * Every destination is rated the way addOutput rates it — through
   * platformKbps, at the size the hub actually encodes. Comparing raw preset
   * bitrates here would put this back out of step with the hub, which is the
   * one thing this function exists to prevent.
   *
   * A side effect worth naming, because it removes a trap rather than hiding
   * it: two destinations of the same size can no longer differ in bitrate at
   * all. Both are raised to what the platform charges for that size, so
   * "I lowered one destination's bitrate and it silently started a second live
   * encode" is now impossible by construction instead of merely detected.
   */
  const rate = (q) => platformKbps(q.videoKbps || 0, {
    width: biggest.width, height: biggest.height, fps: q.fps || fps, capKbps: lineCapKbps });
  const have = {
    width: biggest.width, height: biggest.height, fps,
    videoKbps: qs.reduce((m, q) => Math.max(m, rate(q)), 0),
  };
  const out = [];
  qs.forEach((q, i) => {
    if (!canCopyQuality(have, { ...q, fps: q.fps || fps, videoKbps: rate(q) })) out.push(i);
  });
  return out;
}

function buildUrl({ dest, key, customUrl }) {
  let base = dest === 'custom' ? (customUrl || '') : (DESTINATIONS[dest] ? DESTINATIONS[dest].url : '');
  base = String(base || '').trim();
  if (!base) throw new Error(dest === 'custom' ? 'Enter the custom RTMP server URL.' : 'Unknown destination: ' + dest);
  if (!/^rtmps?:\/\//i.test(base)) throw new Error('The server URL must start with rtmp:// or rtmps://');
  const k = String(key || '').trim();
  if (!k) throw new Error('Enter your stream key (from Facebook Live Producer / YouTube Studio).');
  if (!base.endsWith('/')) base += '/';
  return base + k;
}

/* ========================== encoder selection ============================= */
/*
 * Live encoding is the single biggest CPU cost in the whole app, so we hand it
 * to the GPU whenever the machine has a usable H.264 encoder. Measured on the
 * development laptop (Intel UHD 620), encoding 720p30:
 *      libx264 veryfast  ~38% of a core
 *      h264_qsv          ~14% of a core
 *      h264_mf           ~42% of a core   ← worse than software; not offered
 * Availability is probed by ACTUALLY ENCODING a couple of frames: `-encoders`
 * only lists what ffmpeg was built with, not what this machine's drivers can do
 * (h264_nvenc and h264_amf are both listed on an Intel-only laptop and both fail
 * instantly at runtime).
 */
const ENCODERS = {
  h264_nvenc: {
    label: 'NVIDIA NVENC (GPU)',
    args: ({ videoKbps, gop, profile }) => [
      '-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr',
      '-b:v', videoKbps + 'k', '-maxrate', videoKbps + 'k', '-bufsize', (videoKbps * 2) + 'k',
      '-g', String(gop), ...(profile ? ['-profile:v', profile] : []),
    ],
  },
  h264_qsv: {
    label: 'Intel Quick Sync (GPU)',
    args: ({ videoKbps, gop, profile }) => [
      '-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1',
      '-b:v', videoKbps + 'k', '-maxrate', videoKbps + 'k', '-bufsize', (videoKbps * 2) + 'k',
      '-g', String(gop), ...(profile ? ['-profile:v', profile] : []),
    ],
  },
  h264_amf: {
    label: 'AMD AMF (GPU)',
    args: ({ videoKbps, gop, profile }) => [
      '-c:v', 'h264_amf', '-usage', 'lowlatency', '-rc', 'cbr',
      '-b:v', videoKbps + 'k', '-maxrate', videoKbps + 'k', '-bufsize', (videoKbps * 2) + 'k',
      '-g', String(gop), ...(profile ? ['-profile:v', profile] : []),
    ],
  },
  libx264: {
    label: 'Software (x264)',
    /*
     * `cbr` asks x264 for TRUE constant bitrate — it pads each access unit up to
     * the rate with filler NALs instead of letting a still picture fall to a
     * few hundred kbps. That is the same thing h264-filler.js does on the GPU
     * capture path, and it is here for the same reason: a platform judges a
     * stream by the bits arriving, and a motionless lyric slide arriving at
     * 187 kbps is reported as a low bitrate for the whole service.
     *
     * Only when a PLATFORM is watching. A recording has nobody to satisfy, and
     * this encode is shared, so padding it unasked would put gigabytes of
     * nothing into every file a church keeps.
     */
    args: ({ videoKbps, gop, profile, fast, cbr }) => [
      '-c:v', 'libx264', '-preset', fast ? 'ultrafast' : 'veryfast', '-tune', 'zerolatency',
      '-b:v', videoKbps + 'k', '-maxrate', videoKbps + 'k', '-bufsize', (videoKbps * 2) + 'k',
      '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
      ...(cbr ? ['-x264opts', 'nal-hrd=cbr:force-cfr=1'] : []),
      ...(profile ? ['-profile:v', profile] : []),
    ],
  },
};
const HW_ORDER = ['h264_nvenc', 'h264_qsv', 'h264_amf'];

let _encoderCache = new Map(); // ffmpegPath -> Promise<name>

/** Encode a few real frames with `name` — returns true only if ffmpeg exits 0. */
function tryEncoder(ffmpegPath, name) {
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=0.5',
      ...ENCODERS[name].args({ videoKbps: 1500, gop: 60, profile: null }),
      '-pix_fmt', 'yuv420p', '-an', '-f', 'null', '-'];
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let proc;
    try { proc = spawn(ffmpegPath, args, { windowsHide: true }); }
    catch (e) { return finish(false); }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} finish(false); }, 15000);
    proc.stderr.on('data', () => {});
    proc.on('error', () => { clearTimeout(timer); finish(false); });
    proc.on('close', (code) => { clearTimeout(timer); finish(code === 0); });
  });
}

/**
 * Best available H.264 encoder for live work, probed once per ffmpeg binary.
 * `prefer` ('auto' | an encoder name) comes from Settings so a user with a
 * flaky driver can pin software encoding.
 */
function detectEncoder(ffmpegPath, prefer = 'auto') {
  if (prefer && prefer !== 'auto') return Promise.resolve(ENCODERS[prefer] ? prefer : 'libx264');
  if (_encoderCache.has(ffmpegPath)) return _encoderCache.get(ffmpegPath);
  const p = (async () => {
    for (const name of HW_ORDER) {
      if (await tryEncoder(ffmpegPath, name)) return name;
    }
    return 'libx264';
  })();
  _encoderCache.set(ffmpegPath, p);
  return p;
}

function resetEncoderCache() { _encoderCache = new Map(); }
function encoderLabel(name) {
  if (name === 'copy') return 'GPU capture — passed through, no re-encode';
  return (ENCODERS[name] && ENCODERS[name].label) || name;
}

/**
 * Parse one ffmpeg progress line into the shape the status bar expects.
 *
 * `frame=`/`fps=` are only printed when ffmpeg is actually encoding — a stream
 * copy reports `size= … time= … bitrate= … speed=` and nothing else. Requiring
 * the frame counter meant every copied destination looked like it was reporting
 * nothing at all: no bitrate on the status bar and no "connected" signal.
 */
function parseStats(s) {
  const t = s.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
  const speed = s.match(/speed=\s*([\d.]+|N\/A)/);
  if (!t || !speed) return null; // a partial write, not a whole progress line
  const bitrate = s.match(/bitrate=\s*([\d.]+|N\/A)/);
  const frame = s.match(/frame=\s*(\d+)/);
  const fps = s.match(/fps=\s*([\d.]+)/);
  return {
    frames: frame ? +frame[1] : 0,
    fps: fps ? +fps[1] : 0,
    timeSec: (+t[1]) * 3600 + (+t[2]) * 60 + parseFloat(t[3]),
    bitrateKbps: bitrate && bitrate[1] !== 'N/A' ? parseFloat(bitrate[1]) : 0,
    speed: speed[1] === 'N/A' ? 0 : parseFloat(speed[1]),
  };
}

/** Turn an ffmpeg log tail into a human error for the UI. */
function explainExit(log, { isInput } = {}) {
  const t = String(log || '').toLowerCase();
  if (t.includes('connection refused') || t.includes('failed to connect') ||
      t.includes('error opening output') || t.includes('no route to host') || t.includes('network is unreachable')) {
    return 'Could not reach the streaming server. Check your internet connection, the server URL, and your stream key.';
  }
  if (t.includes('i/o error') || t.includes('broken pipe') || t.includes('connection reset') || t.includes('end of file')) {
    return 'The streaming server closed the connection. Check that your stream key is valid and the broadcast is still available.';
  }
  if (t.includes('invalid data found') || t.includes('ebml header parsing failed')) {
    return isInput
      ? 'The program feed could not be read — try restarting the preview and going live again.'
      : 'The broadcast feed dropped out for a moment.';
  }
  if (t.includes('no space left')) return 'The disk is full — free some space and start again.';
  const tail = String(log || '').split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220);
  return 'The stream ended unexpectedly. ' + tail;
}

/* =============================== LiveStream ============================== */

/**
 * A single WebM-chunks-in, H.264-out ffmpeg process. Used on its own by
 * MultiCorder (which records individual inputs, each with its own capture, so
 * they cannot share the program hub). Program recording and every streaming
 * destination go through ProgramHub instead.
 */
class LiveStream {
  constructor() {
    this.proc = null;
    this.startedAt = 0;
    this.stats = null;        // { fps, bitrateKbps, timeSec, speed }
    this.onEvent = null;      // (type, payload) => void   ('stats' | 'ended')
    this.lastLog = '';
    this._stopping = false;
    this._bytesIn = 0;
  }

  get running() { return !!this.proc; }

  /**
   * Start pushing to `url` (RTMP/RTMPS) — or, when `filePath` is given instead,
   * recording to a local MP4. Chunks written via write() land on ffmpeg stdin.
   * Re-encodes (zero-latency, 2s keyframes + AAC) — required: platforms demand
   * an exact keyframe cadence that MediaRecorder can't promise.
   */
  start(ctx, { url, filePath, videoKbps = 2500, audioKbps = 128, fps = 30, width, height, profile, encoder = 'libx264', recFormat: recFormatId }) {
    if (this.proc) throw new Error('A live stream is already running — end it first.');
    fps = Math.max(1, Math.round(Number(fps) || 30)); // null/garbage → safe CFR default
    const enc = ENCODERS[encoder] ? encoder : 'libx264';
    // Recording to a file? Honour the chosen audio format (MultiCorder takes the
    // same setting as program Record). Streaming stays AAC — RTMP requires it.
    const recFmt = recFormat(recFormatId);
    const args = [
      '-hide_banner', '-loglevel', 'info', '-stats_period', '1', '-y',
      '-fflags', '+genpts', '-f', 'webm',
      '-i', 'pipe:0',
      '-r', String(fps), // MediaRecorder's webm has irregular frame timing; force CFR output
      // Lets one shared program capture serve several simultaneous outputs at
      // DIFFERENT resolutions (vMix-style multi-destination streaming) — each
      // destination scales down (or up) from the same source independently.
      // Aspect-preserving: a landscape program pushed to a Vertical preset is
      // letterboxed onto the portrait frame instead of being stretched.
      ...(width && height ? ['-vf',
        `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`] : []),
      ...ENCODERS[enc].args({ videoKbps, gop: fps * 2, profile }),
      '-pix_fmt', 'yuv420p',
      // A file gets the operator's chosen recording format; a stream is always
      // AAC. The source here is WebM/Opus from MediaRecorder, so the sound is
      // re-encoded either way — see audioArgsFromOpus for what happened when
      // this path took the hub's copy shortcut instead.
      ...(filePath
        ? recFmt.audioArgsFromOpus(audioKbps)
        : ['-c:a', 'aac', '-b:a', audioKbps + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE]),
      '-avoid_negative_ts', 'make_zero',
      // Fragmented MP4: the moov atom is written up front and each fragment is
      // flushed as it's encoded, so the file stays valid throughout — even if
      // the process were killed mid-recording, unlike +faststart which defers
      // the moov rewrite to a slow final pass that a forced kill can wreck.
      ...(filePath ? recFmt.muxArgs(filePath) : ['-f', 'flv', url]),
    ];
    const proc = spawn(ctx.ffmpeg, args, { windowsHide: true });
    this.proc = proc;
    this.encoder = enc;
    this.startedAt = Date.now();
    this.stats = null;
    this.lastLog = '';
    this._stopping = false;
    this._bytesIn = 0;

    // MediaRecorder can outpace the encoder briefly; stdin errors (EPIPE when
    // ffmpeg dies mid-write) must never crash the main process.
    proc.stdin.on('error', () => {});

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      this.lastLog += s;
      if (this.lastLog.length > 60000) this.lastLog = this.lastLog.slice(-30000);
      const stats = parseStats(s);
      if (stats) {
        this.stats = { ...stats, bytesIn: this._bytesIn };
        if (this.onEvent) { try { this.onEvent('stats', this.stats); } catch (e) {} }
      }
    });

    proc.on('error', (err) => {
      this.proc = null;
      if (this.onEvent) { try { this.onEvent('ended', { code: -1, error: 'Could not start ffmpeg: ' + err.message }); } catch (e) {} }
    });

    proc.on('close', (code) => {
      const wasStopping = this._stopping;
      this.proc = null;
      const payload = {
        code,
        clean: wasStopping || code === 0,
        error: (wasStopping || code === 0) ? null : explainExit(this.lastLog),
        log: this.lastLog.slice(-1500),
      };
      if (this.onEvent) { try { this.onEvent('ended', payload); } catch (e) {} }
    });
  }

  /** Feed one recorded chunk into the encoder. */
  write(buf) {
    if (!this.proc || this._stopping) return false;
    this._bytesIn += buf.length;
    try { return this.proc.stdin.write(buf); } catch (e) { return false; }
  }

  /** Graceful stop: close stdin so ffmpeg flushes the stream, then force-kill. */
  stop() {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc) return resolve(true);
      this._stopping = true;
      const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 6000);
      proc.once('close', () => { clearTimeout(killTimer); resolve(true); });
      try { proc.stdin.end(); } catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
    });
  }
}

/* =============================== ProgramHub ============================== */

// Per-output stdin backlog. SHED_BACKLOG starts dropping picture; MAX_OUT_BACKLOG
// is the last resort where even sound has to go. The gap between them is what
// lets a destination lose video and keep the sermon audible.
const SHED_BACKLOG = 3 * 1024 * 1024;
const MAX_OUT_BACKLOG = 12 * 1024 * 1024;
// …and the same two limits expressed as how far BEHIND REAL TIME a destination
// is allowed to get, which is the thing that actually matters to a platform.
// See ProgramHub._limits().
const SHED_SECONDS = 4;
const DEEP_SECONDS = 12;
/*
 * SHEDDING HAS TO SETTLE, NOT FLAP.
 *
 * Dropping picture drains the backlog fast, which immediately puts the
 * destination back under the threshold, which restores the picture, which
 * refills the backlog. Measured on a two-platform 1080p broadcast where the
 * second destination ran at 0.855x real time: EIGHT shed→restore cycles in
 * fifty seconds, every single one of them a mid-GOP video stop followed by a
 * restart at the next keyframe.
 *
 * A platform reads that as a stream whose picture keeps dying and coming back,
 * so it re-buffers and re-times each round — and re-timing the video is what
 * drags the SOUND with it. "YouTube was fine at first and then went glitchy and
 * laggy" is this oscillation, heard from the pew.
 *
 * So the two edges are separated: shedding still starts the instant the backlog
 * is over the line (an emergency cannot wait), but it does not stop until the
 * backlog has genuinely drained AND it has held that way for a moment. One
 * steady state that the platform can settle into beats eight tidy recoveries.
 */
const SHED_RESUME_FRACTION = 0.45;   // must drain to 45% of the threshold to restore picture
const SHED_MIN_MS = 5000;            // …and have been shedding at least this long
/*
 * …and each time restoring the picture turns out to have been premature, wait
 * longer before trying again.
 *
 * Hysteresis alone was not enough. Shedding drains the backlog quickly, so the
 * destination looks healthy the moment the picture stops — and then refills the
 * instant it comes back, because the line genuinely cannot carry that bitrate.
 * Measured: a fixed 5-second dwell took the flapping from eight spells in fifty
 * seconds to five. Still six a minute, and each one costs the platform a
 * re-buffer.
 *
 * So the dwell DOUBLES with every spell — 5s, 10s, 20s, 40s — until the
 * destination settles into one long reduced-picture state, which is what a
 * platform can actually hold on to. It is not a punishment: a destination that
 * then behaves for a couple of minutes has its escalation forgiven, so a single
 * hiccup early in a service does not cost it the rest of the morning.
 */
const SHED_BACKOFF_MAX = 3;          // 5s → 10s → 20s → 40s
const SHED_CALM_MS = 120000;         // healthy this long and the escalation is forgiven
// How long the fan-out waits for a decodable picture before giving up and
// broadcasting what there is anyway. Short, because everything downstream is
// waiting on it — a recording that starts late has lost that time for good.
// See ProgramHub._hasKeyframeYet.
/*
 * How long a LIVE destination's ffmpeg may spend working out what it is being
 * fed before it decides. Ten seconds of stream time and 4 MB, against the
 * defaults of two seconds and 1 MB that dropped the video of a cold broadcast
 * entirely. It exits as soon as it knows, so a warm feed never pays it.
 */
const LIVE_ANALYZE_US = 10000000;
const LIVE_PROBE_BYTES = 4000000;
const VIDEO_WAIT_MS = 8000;
// The most stream that may be held while waiting for that first picture. Two
// seconds of a 6mbps broadcast; past this the wait has failed and what there is
// goes out rather than nothing.
const PREROLL_MAX = 4 * 1024 * 1024;
/*
 * The most stream kept so that a destination attaching MID-BROADCAST can be
 * started at a keyframe instead of in the middle of one. Three megabytes is a
 * comfortable GOP at any rate this app sends; past that the buffer is dropped
 * rather than grown, and the joiner waits for the next keyframe as it used to.
 */
const JOIN_BUF_MAX = 3 * 1024 * 1024;
const RECONNECT_DELAYS = [1500, 3000, 5000, 8000, 12000]; // RTMP retry backoff
// How long a destination may sit deep enough in backlog that even its SOUND is
// being shed before it is reconnected instead. Long enough to ride out a hiccup,
// short enough that nobody sits through a distorted sermon.
const DEEP_BACKLOG_GRACE_MS = 4000;
// How long an output may run without reporting a single byte of progress before
// we assume it has wedged and restart it.
const CONNECT_TIMEOUT_MS = 25000;

/* ===================== transport-aware shedding ==========================
 *
 * When a destination's upload cannot keep up with the encode, something has to
 * give. The old answer was to drop whole write buffers from the middle of that
 * destination's MPEG-TS — which cuts the stream at arbitrary byte offsets, right
 * through a 188-byte transport packet and through the AAC frame inside it. What
 * reached the platform was not "less stream", it was CORRUPT stream: the clicks,
 * crackle and "crusty" sound a church hears on the slower of two simultaneous
 * destinations while the faster one sounds perfect. Streaming to two platforms
 * doubles the upstream you need, so on typical church broadband one of them
 * always backs up — and nothing in the app ever said so.
 *
 * Shedding is now packet-aligned and audio-LAST:
 *   • audio is ~5% of the bitrate and carries the preaching — it is never shed
 *     until the very last resort,
 *   • PAT/PMT are never shed (an output that loses them can't decode anything),
 *   • video is the other ~95%, and is dropped in WHOLE GOPs: once we start
 *     shedding picture we keep shedding until the next random-access point, so
 *     the platform gets clean keyframe-to-keyframe segments rather than half a
 *     GOP of undecodable slices.
 *
 * The result: a destination that is short on bandwidth loses picture for a few
 * seconds and keeps perfect sound, then comes back cleanly.
 */
const TS_PACKET = 188;
const TS_SYNC = 0x47;

/**
 * Splits a byte stream into 188-byte transport packets and learns which PID
 * carries what, by reading the PAT and PMT that the hub repeats every 200ms.
 */
class TsShedder {
  constructor() {
    this.tail = null;      // bytes of a packet split across two writes
    this.pmtPid = -1;
    this.videoPids = new Set();
    this.audioPids = new Set();
    this.sheddingVideo = false; // mid-GOP: keep shedding until the next keyframe
  }

  /** Essential = anything an output needs to stay decodable: PSI and audio. */
  _essential(pid) {
    return pid === 0 || pid === this.pmtPid || pid === 0x1fff || this.audioPids.has(pid) || !this.videoPids.has(pid);
  }

  _learn(pid, buf, off, payloadStart) {
    // PAT: first program's PMT PID. PMT: which elementary stream is which.
    if (pid === 0 && payloadStart) {
      const p = off + 4 + 1 + 8; // header + pointer_field + PAT table header
      if (p + 3 < off + TS_PACKET) this.pmtPid = ((buf[p + 2] & 0x1f) << 8) | buf[p + 3];
      return;
    }
    if (pid !== this.pmtPid || !payloadStart || this.pmtPid < 0) return;
    let p = off + 4 + 1;                              // skip header + pointer_field
    if (p + 12 > off + TS_PACKET) return;
    const sectionLen = ((buf[p + 1] & 0x0f) << 8) | buf[p + 2];
    const end = Math.min(off + TS_PACKET, p + 3 + sectionLen - 4); // less the CRC
    const infoLen = ((buf[p + 10] & 0x0f) << 8) | buf[p + 11];
    p += 12 + infoLen;
    while (p + 4 < end) {
      const type = buf[p];
      const esPid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      const esInfo = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
      // 0x1b H.264, 0x24 HEVC, 0x02 MPEG-2 · 0x0f AAC(ADTS), 0x11 LATM, 0x03/0x04 MPEG audio
      if (type === 0x1b || type === 0x24 || type === 0x02) this.videoPids.add(esPid);
      else if (type === 0x0f || type === 0x11 || type === 0x03 || type === 0x04) this.audioPids.add(esPid);
      p += 5 + esInfo;
    }
  }

  /** True when this packet begins a random-access point (a keyframe). */
  _isRandomAccess(buf, off) {
    const afc = (buf[off + 3] >> 4) & 0x03;
    if (afc !== 2 && afc !== 3) return false;
    const afLen = buf[off + 4];
    return afLen > 0 && (buf[off + 5] & 0x40) !== 0; // random_access_indicator
  }

  /**
   * Is this output still being filtered?
   *
   * A held-back partial packet counts. Once `tail` has bytes, bypassing the
   * filter and writing the next buffer raw would strand those bytes and put the
   * destination half a packet out of step — which is the very corruption this
   * class exists to prevent, reintroduced on the way OUT of shedding.
   */
  get active() { return this.sheddingVideo || !!(this.tail && this.tail.length); }

  /**
   * Filter `buf` for an output under pressure, packet by packet.
   *
   * `shed` means the backlog is over the threshold RIGHT NOW; `dropAudio` is the
   * last resort where even sound has to go. The two edges are deliberately not
   * symmetrical:
   *   • shedding starts IMMEDIATELY, mid-GOP — a bandwidth emergency cannot wait
   *     up to two seconds for the next keyframe while the backlog keeps growing;
   *   • it stops only at a random-access point, so the platform gets picture back
   *     as a clean keyframe rather than half a GOP of undecodable slices.
   *
   * Returns the bytes still to be written (packet-aligned), or null for none.
   */
  filter(buf, { shed = false, dropAudio = false } = {}) {
    if (shed) this.sheddingVideo = true;
    // Nothing to drop and nothing held back: hand the bytes straight through.
    // Scanning every packet of every destination that is perfectly healthy would
    // be pure overhead on the common path.
    if (!this.sheddingVideo && !(this.tail && this.tail.length)) return buf;
    let data = buf;
    if (this.tail && this.tail.length) { data = Buffer.concat([this.tail, buf]); this.tail = null; }
    // Align to a sync byte; anything before it is a fragment we can't classify.
    let i = 0;
    while (i < data.length && data[i] !== TS_SYNC) i++;
    const keep = [];
    for (; i + TS_PACKET <= data.length; i += TS_PACKET) {
      if (data[i] !== TS_SYNC) {                 // lost alignment — resync and retry
        while (i < data.length && data[i] !== TS_SYNC) i++;
        i -= TS_PACKET;                          // the loop's += puts us back on it
        continue;
      }
      const pid = ((data[i + 1] & 0x1f) << 8) | data[i + 2];
      this._learn(pid, data, i, (data[i + 1] & 0x40) !== 0);
      if (this.videoPids.has(pid)) {
        // Recovering (not shedding any more)? Wait for a keyframe, then let go.
        if (!shed && this.sheddingVideo && this._isRandomAccess(data, i)) this.sheddingVideo = false;
        if (this.sheddingVideo) continue;
      } else if (dropAudio && this.audioPids.has(pid)) {
        continue;
      }
      keep.push(data.subarray(i, i + TS_PACKET));
    }
    if (i < data.length) this.tail = Buffer.from(data.subarray(i)); // partial packet
    return keep.length ? Buffer.concat(keep) : null;
  }
}

/* ====================== AUTO-FIT: the picture follows the line ============
 *
 * Everything above this point deals with a destination that cannot keep up by
 * THROWING ITS PICTURE AWAY. That is the right emergency answer and the wrong
 * steady state: what the church hears when a 6 mbps stream is pushed down a
 * line that can carry four is picture that stops and starts, sound that judders
 * with it as the platform re-times, and — once the backlog is deep enough — a
 * reconnect. "Choppy on YouTube while Facebook is perfect" is that, and no
 * amount of tidier shedding fixes it, because the stream being sent is simply
 * bigger than the line.
 *
 * So the app now does what every serious encoder does: it SENDS LESS. The
 * shared encode's video bitrate follows the slowest destination down until the
 * stream fits, and creeps back up when it plainly fits again. A service at 3
 * mbps that never stutters is a better broadcast than a 6 mbps one that breaks
 * every twenty seconds, and it is the operator's morning that this saves — the
 * old answer was a banner asking them to go and change a preset mid-sermon.
 *
 * Three rules, each of them deliberate:
 *
 *   • ONLY THE PICTURE. The sound is the sermon and it is ~3% of the bitrate;
 *     there is nothing worth saving there and everything to lose.
 *   • DOWN FAST, UP SLOW. Congestion is answered in a couple of seconds; a rise
 *     is only attempted after a long clean spell, and every rise that turns out
 *     to have been premature DOUBLES the next wait (same reasoning as the shed
 *     dwell above — one settled state beats six tidy recoveries).
 *   • A FLOOR. Below a quarter of the chosen preset the problem is not a busy
 *     line, and quietly streaming a smear is not a kindness: shedding and the
 *     existing banner take over from there.
 */
const RATE_TICK_MS = 1000;
// How far behind real time a destination has to be before its line is judged
// full. Below a second is ordinary jitter — RTMP writes are bursty and every
// keyframe is a spike.
const FIT_BEHIND_SEC = 1.0;
// …and how clean it has to be to count as comfortable again.
const FIT_CLEAR_SEC = 0.35;
/*
 * …and how clean it has to be when the stream is BELOW WHAT THE PLATFORM CHARGES.
 *
 * There was a dead zone between these two numbers, and a church PC lives in it.
 * A destination sitting 0.4–1.0s behind is not congested enough to lower the
 * rate (FIT_BEHIND_SEC) and not clean enough to raise it (FIT_CLEAR_SEC), so a
 * stream that dipped once STAYED DOWN for the rest of the service with nothing
 * wrong and nothing changing. Measured on the real RTMP run: released the
 * congestion, waited 45 seconds, and the rate never moved off 2000 against a
 * price of 2800 — which on YouTube is the yellow banner, all morning, exactly
 * as reported.
 *
 * Above the price that caution is right: it is quality, and quality can wait
 * for a genuinely quiet line. Below it the stream is being reported as faulty,
 * so "clean" means only "not actually falling behind" — still under
 * FIT_BEHIND_SEC, so nothing can ever be clean and congested at the same time,
 * and a rise that turns out to be too much is taken back and backed off.
 */
const FIT_CLEAR_REC_SEC = 0.8;
const FIT_DOWN_HOLD_MS = 2500;    // sustained congestion, not one burst
const FIT_SETTLE_MS = 5000;       // a step needs time to show before the next
const FIT_UP_AFTER_MS = 45000;    // clean this long before asking for more
/*
 * …UNLESS THE STREAM IS CURRENTLY BELOW WHAT THE PLATFORM CHARGES.
 *
 * "It can start fine and then the issue happens" — this is that. One burst of
 * congestion takes a step off the rate, and with the ordinary caution above
 * (45s clean, then 90s, 3m, 6m, 12m after each failed probe, climbing 15% at a
 * time) a stream that dipped in the first hymn can still be under-rated at the
 * benediction. Below the recommendation that caution is the wrong trade: the
 * stream is not merely softer, it is being REPORTED AS FAULTY for the whole
 * service, and the platform's own band says these bits are affordable. So the
 * climb back UP TO the recommendation is quick and is never made to serve a
 * backoff penalty. Above it, every bit of the old caution still applies.
 */
const FIT_UP_FAST_MS = 12000;
const FIT_UP_FAST = 1.35;
const FIT_REC_BACKOFF_MAX = 3;    // 12s → 24s → 48s → 96s, then it stops trying
const FIT_PROBE_BACKOFF_MAX = 4;  // 45s → 90s → 3m → 6m → 12m
// A rise that is answered by congestion within this long was the rise's fault.
const FIT_PROBE_FAIL_MS = 30000;
const FIT_DOWN = 0.72;            // one step down ≈ a quarter off
const FIT_UP = 1.15;              // …and back up in smaller ones
const FIT_FLOOR_FRACTION = 0.25;  // never below a quarter of the preset
const FIT_MIN_KBPS = 500;
const FIT_STEP_KBPS = 50;         // round steps so the UI reads sensibly

/**
 * Decides what video bitrate the shared encode should be running at.
 *
 * Deliberately a plain object with a clock passed in: this is the one piece of
 * the broadcast that has to be provable without a platform, an uplink or an
 * afternoon (`npm run test:autofit`).
 */
class RateFit {
  constructor(ceilingKbps, opts = {}) {
    this.ceiling = Math.max(FIT_MIN_KBPS, Math.round(ceilingKbps) || 2500);
    /*
     * THE FLOOR THE OPERATOR SET: "never send less than this."
     *
     * Auto-fit exists to stop a full line turning into a stuttering picture, and
     * it is right about that — but left to itself it will trade away the
     * platform's own number, and a stream under that number is reported as
     * faulty for as long as it lasts. So the rate may be lowered freely down to
     * here, and below here ONLY when the destination is actually LOSING PICTURE
     * (shedding), because at that point the choice is no longer "soft or sharp",
     * it is "soft or broken", and nobody watching a service wants broken.
     *
     * Defaulted by the studio to what the platform charges for the picture being
     * sent, so out of the box the answer to "can it go below what YouTube asks?"
     * is no, unless the alternative is a frozen picture.
     */
    this.hardFloor = Math.max(0, Math.round(Number(opts.floorKbps) || 0));
    /*
     * What the platform charges for the picture this session is sending, or 0
     * when nothing is watching but a file. Never above the ceiling: a rung the
     * controller could never reach would make every climb "urgent" forever.
     */
    this.rec = Math.min(this.ceiling, Math.max(0, Math.round(Number(opts.recKbps) || 0)));
    this.floor = Math.max(FIT_MIN_KBPS, Math.round(this.ceiling * FIT_FLOOR_FRACTION));
    if (this.floor > this.ceiling) this.floor = this.ceiling;
    this.target = this.ceiling;
    /*
     * "Has not happened yet" is NULL, not zero.
     *
     * These are moments on a clock, and zero is a moment. With zero standing in
     * for "never", a controller whose clock starts near zero reads "the last
     * change was at time 0" and refuses to act for the whole of the first
     * settle window — and reads "congestion started at 0" as if it had not
     * started at all. Against Date.now() the difference never shows, which is
     * exactly why it survived: it only appears where the clock is small.
     */
    this.badSince = null;
    this.cleanSince = null;
    this.lastChangeAt = null;
    this.lastUpAt = null;
    this.probes = 0;          // rises that had to be taken back
    this.recProbes = 0;       // …of those, the ones that were only trying to reach the platform's price
    this.steps = 0;           // how many times the picture has been cut
    this.atFloor = false;
    this.opts = opts;
  }

  /** Is the stream currently being sent for less than the platform charges? */
  belowRec() { return this.rec > 0 && this.target < this.rec; }

  /** How long a clean spell has to last before the next attempt to climb. */
  upWaitMs() {
    // Getting back to the platform's price is not a luxury — but a line that has
    // already refused it twice is telling us something, and a stream that flaps
    // in and out of a rate every fifteen seconds costs a keyframe each time. So
    // it is quick, then quickly patient.
    if (this.belowRec()) return FIT_UP_FAST_MS * Math.pow(2, Math.min(this.recProbes, FIT_REC_BACKOFF_MAX));
    return FIT_UP_AFTER_MS * Math.pow(2, Math.min(this.probes, FIT_PROBE_BACKOFF_MAX));
  }

  /** The lowest rate allowed right now. `losing` = the picture is already being
   *  thrown away, which is the one thing worse than a soft picture. */
  floorNow(losing) {
    const hard = Math.min(this.ceiling, this.hardFloor);
    return losing || !hard ? this.floor : Math.max(this.floor, hard);
  }

  _round(kbps, losing) {
    const v = Math.round(kbps / FIT_STEP_KBPS) * FIT_STEP_KBPS;
    return Math.min(this.ceiling, Math.max(this.floorNow(losing), v));
  }

  /**
   * One second of evidence.
   *
   * `dests` is every LIVE destination: `{ id, behindSec, shedding, copying }`.
   * Only destinations that are being COPIED from the shared encode count
   * towards lowering it — one that is being re-encoded to its own quality is
   * short of CPU, not of upload, and lowering the shared rate would take the
   * picture off every other platform to fix something it isn't.
   */
  tick(dests, now = Date.now()) {
    const live = (dests || []).filter((d) => d && d.copying);
    if (!live.length) { this.badSince = null; this.cleanSince = null; return { changed: false, target: this.target }; }
    const bad = live.filter((d) => d.shedding || d.behindSec > FIT_BEHIND_SEC);
    if (bad.length) {
      this.cleanSince = null;
      if (this.badSince == null) this.badSince = now;
      if (now - this.badSince < FIT_DOWN_HOLD_MS) return { changed: false, target: this.target };
      // A step needs time to show before the next one — but only if a step has
      // actually been taken. "Never changed" must not read as "changed at 0".
      if (this.lastChangeAt != null && now - this.lastChangeAt < FIT_SETTLE_MS) {
        return { changed: false, target: this.target };
      }
      // Is a destination actually losing picture, or merely behind? Only the
      // first one may take the rate under the floor the operator set.
      const losing = bad.some((d) => d.shedding);
      let next = this._round(this.target * FIT_DOWN, losing);
      /*
       * THE PLATFORM'S PRICE IS A RUNG ON THE WAY DOWN.
       *
       * A step is roughly a quarter off, so the first one usually vaults clean
       * over the recommendation and lands the stream in "your bitrate is lower
       * than recommended" for as long as the congestion lasts plus as long as
       * the climb back takes. Stopping AT the price first costs the few percent
       * of headroom above it and nothing else, and on the transient bursts that
       * cause most of these dips it is the whole of the difference: the line
       * gets its relief, the platform never sees a stream below its own number.
       * If the congestion is real, the next step goes straight past this rung —
       * `next < target` is still required, so there is no way to get stuck on it.
       */
      if (this.rec > 0 && next < this.rec && this.target > this.rec) {
        const rung = this._round(this.rec, losing);
        if (rung < this.target) next = rung;
      }
      if (next >= this.target) {
        this.atFloor = true;
        return { changed: false, target: this.target, atFloor: true, heldByFloor: !losing && this.floorNow(false) > this.floor };
      }
      // A rise we have only just made, undone by the line: remember it, so the
      // next attempt waits twice as long as this one did. A climb back to the
      // recommendation is exempt — it is not speculation about how fast the
      // line might be, it is the price of the picture already being sent, and
      // penalising it is what leaves a service under-rated for forty minutes.
      if (this.lastUpAt != null && now - this.lastUpAt < FIT_PROBE_FAIL_MS) {
        if (this._lastUpWasToRec) this.recProbes++; else this.probes++;
      }
      const from = this.target;
      this.target = next;
      this.steps++;
      this.badSince = now;
      this.lastChangeAt = now;
      return {
        changed: true, target: next, from, direction: 'down',
        atFloor: next <= this.floor, dests: bad.map((d) => d.id),
      };
    }
    this.badSince = null;
    this.atFloor = false;
    const clearBar = this.belowRec() ? FIT_CLEAR_REC_SEC : FIT_CLEAR_SEC;
    const clear = live.every((d) => !d.shedding && d.behindSec <= clearBar);
    if (!clear) { this.cleanSince = null; return { changed: false, target: this.target }; }
    if (this.cleanSince == null) this.cleanSince = now;
    if (this.target >= this.ceiling) return { changed: false, target: this.target };
    if (now - this.cleanSince < this.upWaitMs()) return { changed: false, target: this.target };
    if (this.lastChangeAt != null && now - this.lastChangeAt < this.upWaitMs()) {
      return { changed: false, target: this.target };
    }
    // Below the recommendation the step is bigger as well as sooner — three
    // 15% steps at 45 seconds each is four minutes of a service spent under-rated
    // for a line that was only briefly busy.
    const belowRec = this.belowRec();
    const grow = belowRec ? FIT_UP_FAST : FIT_UP;
    let next = this._round(Math.max(this.target * grow, this.target + FIT_STEP_KBPS), false);
    /*
     * THE QUICK CLIMB STOPS AT THE PRICE, and never a step beyond it.
     *
     * Above the platform's number the old caution is exactly right: that is
     * speculation about how fast the line might be, and it is answered by
     * flapping. Below it, the bits are not speculative — they are what the
     * picture already being sent is worth. Landing precisely on the price means
     * a stream that has just been knocked down can never climb back into the
     * rate that knocked it down, which is the property this had to keep.
     */
    /*
     * …and below the price it goes STRAIGHT there, in one step.
     *
     * Geometric steps are for climbing towards a ceiling nobody has measured —
     * each one is a question to the line. This is not a question: the picture
     * already going out is worth exactly this much, the line has just been clean
     * for the whole wait, and creeping up in 35% stages only means more of the
     * service spent under the platform's number (measured on the real RTMP run:
     * two steps, 24 seconds of a stream still being reported as under-rated
     * after the congestion had cleared). If the line refuses it, that answer
     * arrives just as fast, and the backoff above is what handles it.
     */
    if (belowRec) next = this._round(this.rec, false);
    if (next <= this.target) return { changed: false, target: this.target };
    const from = this.target;
    this._lastUpWasToRec = this.belowRec();
    this.target = next;
    this.cleanSince = now;
    this.lastChangeAt = now;
    this.lastUpAt = now;
    return { changed: true, target: next, from, direction: 'up', toRec: this._lastUpWasToRec };
  }
}

/**
 * One encode of the program, many consumers.
 *
 * `session()` (re)starts the hub encoder for a renderer capture session;
 * `addOutput()` attaches an RTMP destination or a recording file, which can
 * happen at any point during the broadcast; `write()` feeds WebM chunks in.
 */
class ProgramHub {
  constructor() {
    this.proc = null;
    this.sid = 0;             // renderer capture-session id the hub is bound to
    this.cfg = null;          // { width, height, videoKbps, audioKbps, fps }
    this.encoder = 'libx264';
    this.outputs = new Map(); // id -> output record
    this.onEvent = null;      // (id, type, payload) — 'stats' | 'ended' | 'reconnecting' | 'connected'
    this.onHubEvent = null;   // (type, payload)     — 'restart-needed' | 'ended'
    this.lastLog = '';
    this.bytesIn = 0;
    this.tsBytes = 0;
    this.startedAt = 0;
    this._stopping = false;
    this._tsOffsetSec = 0;    // keeps TS timestamps monotonic across hub restarts
    this._broadcastStartedAt = 0;
    this._swFallbackDone = false;
    this._stopPromise = null;
    this._sawVideo = false;   // nothing is fanned out before the picture exists
    this._videoWaitSince = 0;
    this._probe = null;
    this._keys = 0;
    this._preroll = null;     // the held opening stream, replayed once it can be decoded
    this._prerollLen = 0;
    this._firstKeyAt = null;
    this.fit = null;          // the auto-fit rate controller (see RateFit)
    this.fitEnabled = false;  // …only where the rate can actually be changed live
    this.fitRefused = false;  // …and the renderer said it could not do it
    this._rateTimer = 0;
  }

  get running() { return !!this.proc; }
  get outputCount() { return this.outputs.size; }

  /**
   * Bind the hub to a renderer capture session. Called when the renderer creates
   * (or re-creates) its program MediaRecorder — a new `sid` means a brand-new
   * WebM stream, so the old hub process is replaced.
   */
  async session(ctx, { sid, width, height, videoKbps, audioKbps, fps, encoder = 'auto', format,
                       autoFit = true, forStream = false, lineCapKbps = 0, minKbps = 0,
                       sampleRate = OUT_SAMPLE_RATE }) {
    if (this.proc && this.sid === sid) {
      return { encoder: this.encoder, format: this.cfg && this.cfg.format, videoKbps: this.currentKbps() };
    }
    await this._killHub();
    this.sid = sid;
    const W = Math.max(2, Math.round(width) || 1280);
    const H = Math.max(2, Math.round(height) || 720);
    const F = Math.max(1, Math.round(fps) || 30);
    this.cfg = {
      width: W, height: H,
      /*
       * The shared encode runs at what the PLATFORM wants for a W×H picture at
       * F fps, floored by the operator's preset — the same rule addOutput
       * applies to every destination, so the two can never disagree and no
       * destination is pushed off the copy path by it. `forStream` is what
       * keeps a recording-only session at the preset: see platformKbps.
       */
      videoKbps: forStream
        ? Math.max(100, platformKbps(videoKbps, { width: W, height: H, fps: F, capKbps: lineCapKbps }))
        : Math.max(100, Math.round(videoKbps) || 2500),
      audioKbps: Math.max(32, Math.round(audioKbps) || 128),
      // The rate the renderer's AAC is genuinely at, REPORTED rather than
      // assumed. _canCopyAudio used to hand every RTMP destination `-c:a copy`
      // on the stated grounds that the hub was "already producing exactly
      // that, at 48 kHz" — true only if the sound card opened at 48 kHz, which
      // nothing checked and which is false on any machine whose output device
      // sits at 44 100.
      sampleRate: Math.round(Number(sampleRate)) || OUT_SAMPLE_RATE,
      fps: F,
      // What the line was measured at, carried so a destination attaching later
      // is rated against the same ceiling this session was.
      lineCapKbps: Math.round(Number(lineCapKbps) || 0),
      // Is a platform watching? Decides both the rate above and whether the
      // encode is padded up to it.
      forStream: !!forStream,
      // 'mp4' = the renderer captured on the GPU (H.264 + AAC in fragmented
      // MP4) and the hub PASSES BOTH STREAMS THROUGH — no decode, no encode.
      // 'webm' = classic MediaRecorder capture; the hub transcodes it.
      format: format === 'mp4' ? 'mp4' : 'webm',
    };
    if (!this._broadcastStartedAt) this._broadcastStartedAt = Date.now();
    /*
     * AUTO-FIT lives across hub restarts within one broadcast. A capture that
     * has to be re-created mid-service (a driver hiccup, an encoder fallback)
     * must not go back to a bitrate this line has already been shown not to
     * carry — that is a service that judders every time something restarts.
     */
    const recNow = forStream ? streamrate.recommendedKbps(W, H, F) : 0;
    /*
     * "NEVER SEND LESS THAN THIS." 'auto' (the default) is the platform's own
     * number for the picture, so the app will not quietly trade away the one
     * figure the warning is measured against. A recording has no floor: nothing
     * is watching a file for a steady rate.
     */
    const floorNow = forStream
      ? (String(minKbps) === 'auto' || !minKbps ? recNow : Math.round(Number(minKbps) || 0))
      : 0;
    this.cfg.minKbps = floorNow;
    if (!this.fit || this.fit.ceiling !== this.cfg.videoKbps) {
      this.fit = new RateFit(this.cfg.videoKbps, { recKbps: recNow, floorKbps: floorNow });
    } else {
      this.fit.rec = Math.min(this.fit.ceiling, recNow);      // same rate, new picture: re-price it
      this.fit.hardFloor = floorNow;
    }
    /*
     * …and it is only offered where the rate can genuinely be changed WITHOUT
     * interrupting anything. On the mp4 path the renderer owns the encoder and
     * can be re-rated in place; on the webm path the bitrate is an argument to
     * a running ffmpeg, and the only way to change it is to restart the hub —
     * which every destination would see. Shedding stays the answer there.
     */
    this.fitEnabled = autoFit !== false && this.cfg.format === 'mp4';
    // Probed even when the renderer captured on the GPU and the hub is only
    // remuxing: a destination that has to be re-encoded still needs to know
    // whether this machine has an encoder that can take a SECOND session.
    this.hwName = await detectEncoder(ctx.ffmpeg, encoder);
    this.encoder = this.cfg.format === 'mp4' ? 'copy' : this.hwName;
    this._spawnHub(ctx);
    this._startRateTimer();
    return {
      encoder: this.encoder, encoderLabel: encoderLabel(this.encoder), format: this.cfg.format,
      // What the capture should actually run at RIGHT NOW — the preset, unless
      // auto-fit has already had to come down.
      videoKbps: this.currentKbps(), ceilingKbps: this.cfg.videoKbps, autoFit: this.fitEnabled,
      floorKbps: this.cfg.minKbps || 0,
    };
  }

  /**
   * Raise the shared encode's rate without restarting anything.
   *
   * A session created for a RECORDING is sized at the operator's preset and
   * never padded — nothing is watching a file for a steady bitrate. When a
   * platform then joins that session, the rate has to become what the platform
   * charges for the picture, or the broadcast runs under-rated for the whole
   * service. The capture can be re-rated in place (auto-fit does it every
   * week), so the only thing that has to move here is the CEILING: leave it at
   * the recording's number and auto-fit will drag the picture back down to it
   * the first time the line hiccups, and the warning returns for good.
   *
   * Only ever upward. Lowering the shared encode is auto-fit's job and it has
   * evidence for it; this has none.
   */
  reRate(videoKbps) {
    const c = this.cfg;
    if (!c) return 0;
    const next = Math.max(100, Math.round(Number(videoKbps) || 0));
    if (next <= c.videoKbps) return this.currentKbps();
    c.videoKbps = next;
    c.forStream = true;
    // A fresh controller at the new ceiling: the old one's floor, steps and
    // probe backoff were all derived from a number that no longer applies.
    this.fit = new RateFit(next, {
      recKbps: streamrate.recommendedKbps(c.width, c.height, c.fps),
      floorKbps: c.minKbps || streamrate.recommendedKbps(c.width, c.height, c.fps),
    });
    return this.currentKbps();
  }

  _spawnHub(ctx, forceSoftware) {
    const c = this.cfg;
    const passthrough = c.format === 'mp4' && !forceSoftware;
    const enc = passthrough ? 'copy' : (forceSoftware || this.encoder === 'copy' ? 'libx264' : this.encoder);
    // Restarts continue the timeline instead of jumping back to zero, so the
    // already-connected outputs never see time run backwards.
    this._tsOffsetSec = Math.max(0, (Date.now() - this._broadcastStartedAt) / 1000);
    const args = [
      '-hide_banner', '-loglevel', 'info', '-stats_period', '1', '-y',
      '-fflags', '+genpts', '-f', c.format === 'mp4' ? 'mp4' : 'webm', '-i', 'pipe:0',
      ...(passthrough
        // GPU-captured H.264/AAC: remux only. The mpegts muxer converts avcC →
        // Annex B and ASC → ADTS itself, so a plain copy is a complete answer.
        ? ['-c:v', 'copy', '-c:a', 'copy']
        : ['-r', String(c.fps),
           ...ENCODERS[enc].args({ videoKbps: c.videoKbps, gop: c.fps * 2, profile: null,
             // …and pad it to that rate when a platform is watching: see the
             // libx264 entry. This is the path an operator lands on by pinning
             // "Software only" in Streaming Settings.
             cbr: !!c.forStream }),
           '-pix_fmt', 'yuv420p',
           '-c:a', 'aac', '-b:a', c.audioKbps + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE]),
      // A broadcast-shaped intermediate: stream headers are repeated constantly
      // and every GOP starts with a keyframe, so an output attaching halfway
      // through locks on within ~2s instead of seeing undecodable garbage.
      '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', '-flush_packets', '1',
      '-output_ts_offset', this._tsOffsetSec.toFixed(3),
      '-f', 'mpegts', 'pipe:1',
    ];
    const proc = spawn(ctx.ffmpeg, args, { windowsHide: true });
    this.proc = proc;
    this.activeEncoder = enc;
    this.startedAt = Date.now();
    this.lastLog = '';
    this._stopping = false;
    this.bytesIn = 0;

    proc.stdin.on('error', () => {});
    proc.stdout.on('data', (buf) => this._fanOut(buf));

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      this.lastLog += s;
      if (this.lastLog.length > 60000) this.lastLog = this.lastLog.slice(-30000);
      const stats = parseStats(s);
      if (stats) {
        this.stats = { ...stats, bytesIn: this.bytesIn, encoder: enc };
        if (this.onHubEvent) { try { this.onHubEvent('stats', this.stats); } catch (e) {} }
      }
    });

    proc.on('error', () => { this.proc = null; this._hubDied(ctx, -1, enc); });
    proc.on('close', (code) => {
      if (this.proc !== proc) return; // already replaced
      this.proc = null;
      if (this._stopping) return;
      this._hubDied(ctx, code, enc);
    });
  }

  /**
   * The hub encoder stopped on its own. A hardware encoder that dies within the
   * first few seconds is almost always a driver that can't actually do the job
   * (they advertise support and then fail on the first real frame) — fall back
   * to software once, transparently, before giving up.
   */
  _hubDied(ctx, code, enc) {
    const quick = Date.now() - this.startedAt < 8000;
    if (enc !== 'libx264' && quick && !this._swFallbackDone) {
      this._swFallbackDone = true;
      this.encoder = 'libx264';
      if (this.onHubEvent) { try { this.onHubEvent('encoder-fallback', { from: enc, to: 'libx264' }); } catch (e) {} }
      this._spawnHub(ctx, true);
      if (this.onHubEvent) { try { this.onHubEvent('restart-needed', { reason: 'encoder-fallback' }); } catch (e) {} }
      return;
    }
    if (this.outputs.size && this.onHubEvent) {
      // Outputs stay connected: they're reading MPEG-TS, which resynchronises by
      // itself once the renderer hands us a fresh capture session.
      try { this.onHubEvent('restart-needed', { reason: 'hub-exit', code, error: explainExit(this.lastLog, { isInput: true }) }); } catch (e) {}
    }
  }

  /**
   * Hand the shared MPEG-TS to every consumer.
   *
   * A destination whose upload has stalled must not grow an unbounded buffer in
   * this process, or slow the other destinations down. What it loses when that
   * happens is picture, not sound — see TsShedder for why that distinction is
   * the whole difference between "the stream went blocky for a moment" and "the
   * sermon crackled".
   */
  /*
   * How much backlog is too much, in SECONDS as well as bytes.
   *
   * A fixed byte limit means completely different things at different
   * qualities: 3 MB is about four seconds behind on a 6 mbps feed, and about
   * twenty-four seconds behind on a 1 mbps one. Twenty-four seconds is not a
   * destination under pressure, it is a destination that has left the service —
   * and nothing would have been shed, said or done about it. The byte figures
   * stay as the ceiling (they are what the memory budget allows); the time
   * figures are what actually decides at every quality below the top.
   */
  /**
   * The video bitrate the broadcast is ACTUALLY running at.
   *
   * `cfg.videoKbps` is the preset the operator chose — the ceiling. This is
   * what auto-fit has settled on underneath it, and it is what every judgement
   * about "is this destination keeping up" has to be made against: a backlog of
   * three megabytes is four seconds behind at 6 mbps and twenty-four at one.
   */
  currentKbps() {
    const c = this.cfg;
    if (!c) return 0;
    if (!this.fitEnabled || this.fitRefused || !this.fit) return c.videoKbps;
    return Math.min(c.videoKbps, this.fit.target);
  }

  /** True while the picture is being held below the operator's chosen preset. */
  get fitting() { return this.currentKbps() < ((this.cfg && this.cfg.videoKbps) || 0); }

  _startRateTimer() {
    if (this._rateTimer) return;
    this._rateTimer = setInterval(() => { try { this._rateTick(); } catch (e) {} }, RATE_TICK_MS);
    if (this._rateTimer.unref) this._rateTimer.unref();
  }

  _stopRateTimer() {
    if (this._rateTimer) clearInterval(this._rateTimer);
    this._rateTimer = 0;
  }

  /**
   * One second of evidence, gathered from the destinations themselves.
   *
   * A destination's own stdin backlog is the honest measure of whether its
   * upload is keeping up: its ffmpeg reads from us as fast as it can push to
   * the platform, so bytes piling up in front of it ARE the line being full.
   * (Its reported `bitrate=` is not — that is what it managed to send, which
   * looks healthy right up until it isn't.)
   */
  _rateTick() {
    if (!this.fit || !this.fitEnabled || this.fitRefused || !this.proc || this._stopping) return;
    const c = this.cfg || {};
    const bytesPerSec = ((this.currentKbps() + (c.audioKbps || 128)) * 1000) / 8;
    const dests = [];
    for (const o of this.outputs.values()) {
      if (o.kind !== 'rtmp' || !o.proc || !o.proc.stdin || o.stopping || !o.connected) continue;
      dests.push({
        id: o.id,
        behindSec: o.proc.stdin.writableLength / bytesPerSec,
        shedding: !!o.shedding,
        copying: !!o.copying,
      });
    }
    const r = this.fit.tick(dests, Date.now());
    if (!r.changed) return;
    if (process.env.MW_HUB_DEBUG) {
      console.log(`[hub-debug] auto-fit ${r.direction} ${r.from} → ${r.target} kbps`
        + (r.dests ? ` (${r.dests.join(', ')} behind)` : ''));
    }
    if (this.onHubEvent) {
      try {
        this.onHubEvent('bitrate', {
          videoKbps: r.target, from: r.from, ceilingKbps: c.videoKbps,
          direction: r.direction, atFloor: !!r.atFloor, dests: r.dests || [],
          steps: this.fit.steps,
        });
      } catch (e) {}
    }
  }

  /**
   * The renderer's answer to a rate change.
   *
   * If its encoder would not take the new rate there is no point pretending:
   * auto-fit switches itself off for the rest of the broadcast and the picture
   * goes back to being protected by shedding and the banner, exactly as before.
   */
  rateApplied(kbps, ok) {
    if (ok) return true;
    this.fitRefused = true;
    if (this.fit) this.fit.target = this.fit.ceiling;
    if (this.onHubEvent) { try { this.onHubEvent('bitrate', { videoKbps: this.currentKbps(), refused: true }); } catch (e) {} }
    return false;
  }

  _limits() {
    const c = this.cfg || {};
    // Against what is being SENT, not against the preset — see currentKbps().
    const bytesPerSec = (((this.currentKbps() || c.videoKbps || 2500) + (c.audioKbps || 128)) * 1000) / 8;
    return {
      shed: Math.min(SHED_BACKLOG, bytesPerSec * SHED_SECONDS),
      deep: Math.min(MAX_OUT_BACKLOG, bytesPerSec * DEEP_SECONDS),
    };
  }

  /**
   * Has the shared stream carried a KEYFRAME yet — a real, decodable picture?
   *
   * A destination's ffmpeg decides what a feed contains by looking at its
   * opening seconds, and whatever it decides there it keeps for the whole
   * broadcast. The renderer's GPU encoder can take several seconds to hand back
   * its first frames (Media Foundation's first-use init on a loaded machine)
   * and then trickle them — measured at 3.1 fps for the first moments — while
   * the sound is ready immediately. A destination attached at that moment sees
   * a video PID with no picture parameters in it and gives up on the stream:
   *
   *     Could not find codec parameters for stream 0 (Video: h264, none)
   *     Output #0, flv: Stream #0:0: Audio: aac        ← THE WHOLE SERVICE
   *
   * A black screen with perfect sound, on the destination that was started
   * first, for the entire service, with nothing anywhere to explain it. That is
   * a real broadcast this app made — the SECOND destination, attached eight
   * seconds later, carried a perfect 1080p picture from the same hub.
   *
   * So nothing is fanned out until a RANDOM-ACCESS POINT has gone past: the
   * mpegts muxer writes the picture parameters immediately before each one, so
   * the first bytes any destination sees are bytes it can decode. Waiting for
   * merely the first video PACKET is not enough — that is what it did, and this
   * is what it got. The bytes held back are the trickle nobody could have
   * decoded anyway, and MPEG-TS is self-synchronising, so every consumer simply
   * starts a moment later.
   */
  _hasKeyframeYet(buf, base) {
    const s = this._probe || (this._probe = new TsShedder());
    let i = 0;
    while (i + TS_PACKET <= buf.length) {
      if (buf[i] !== TS_SYNC) { i++; continue; }        // resync rather than give up
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
      s._learn(pid, buf, i, (buf[i + 1] & 0x40) !== 0);
      if (s.videoPids.has(pid) && s._isRandomAccess(buf, i)) {
        this._keys = (this._keys || 0) + 1;
        // Where the picture starts. The held bytes are replayed FROM HERE, so
        // the wait costs a consumer nothing but the undecodable preamble.
        if (this._firstKeyAt == null) this._firstKeyAt = base + i;
      }
      i += TS_PACKET;
    }
    /*
     * ONE random-access point is the bar, and the deadline below is short.
     *
     * The fault this gate exists for is a consumer probing a stream that has no
     * picture parameters in it yet and giving up on the video for good. A
     * stream that STARTS at a keyframe cannot have that problem: the mpegts
     * muxer writes SPS/PPS immediately before each one.
     *
     * TWO of them, not one, and that was established by measurement in both
     * directions. With one, a consumer still probed a stream whose encoder was
     * only trickling and gave up on the picture — an eleven-second recording
     * came out as an audio file. With two, the stream a consumer sees is
     * already running properly. The capture emits keyframes every half second
     * for its first two seconds (see live.js) so this costs a moment rather
     * than a whole GOP.
     */
    return (this._keys || 0) >= 2;
  }

  /**
   * Keep the stream since the last keyframe, so a destination that attaches
   * later can be handed a decodable start instead of the middle of a picture.
   *
   * A joiner used to be spliced in wherever the broadcast happened to be, which
   * meant its ffmpeg had nothing it could decode until the NEXT keyframe — up to
   * a whole GOP of silence-with-sound at the very moment a platform is forming
   * its first opinion of the stream. Measured on a cold start: a first
   * four-second window of 160 kbps on a broadcast that was otherwise running at
   * 3129. The scan is the same one the opening gate uses, ~3,300 iterations a
   * second at church bitrates.
   */
  _trackSinceKey(buf) {
    const s = this._probe || (this._probe = new TsShedder());
    let last = -1, i = 0;
    while (i + TS_PACKET <= buf.length) {
      if (buf[i] !== TS_SYNC) { i++; continue; }
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
      s._learn(pid, buf, i, (buf[i + 1] & 0x40) !== 0);
      if (s.videoPids.has(pid) && s._isRandomAccess(buf, i)) last = i;
      i += TS_PACKET;
    }
    if (last >= 0) {
      this._sinceKey = [buf.subarray(last)];
      this._sinceKeyLen = buf.length - last;
      return;
    }
    if (!this._sinceKey) return;
    this._sinceKeyLen += buf.length;
    if (this._sinceKeyLen > JOIN_BUF_MAX) { this._sinceKey = null; this._sinceKeyLen = 0; }
    else this._sinceKey.push(buf);
  }

  /** Give a just-spawned destination the picture it needs to start decoding. */
  _primeJoiner(o) {
    if (!o || o.kind !== 'rtmp' || !o.proc || !o.proc.stdin) return 0;
    if (!this._sinceKey || !this._sinceKeyLen) return 0;
    let n = 0;
    try { for (const b of this._sinceKey) { o.proc.stdin.write(b); n += b.length; } } catch (e) { return 0; }
    if (process.env.MW_HUB_DEBUG) console.log(`[hub-debug] ${o.id}: joined at a keyframe, ${(n / 1024) | 0} KB of GOP replayed`);
    return n;
  }

  _fanOut(buf) {
    this.tsBytes += buf.length;
    /*
     * THE OPENING SECONDS ARE HELD, NOT THROWN AWAY.
     *
     * Waiting for a decodable picture is right (see _hasKeyframeYet), but an
     * earlier version simply DROPPED everything until then — and on a machine
     * whose encoder is slow to start that was measured at 6.4 seconds, which
     * an eleven-second recording cannot survive. The take came out empty.
     *
     * So the wait is a BUFFER, not a bin. The bytes are kept, and the moment
     * the picture is there they are replayed from the first keyframe onward:
     * every consumer still opens on a stream it can decode, and nothing after
     * that first picture is lost from anybody's recording.
     */
    if (!this._sawVideo) {
      if (!this._videoWaitSince) this._videoWaitSince = Date.now();
      const base = this._prerollLen || 0;
      const key = this._hasKeyframeYet(buf, base);
      if (!this._preroll) this._preroll = [];
      this._preroll.push(buf);
      this._prerollLen = base + buf.length;
      // A broadcast that genuinely has no picture must still go out rather than
      // nothing at all, and the buffer may never grow without bound.
      /*
       * A RECORDING IS NOT HELD. It is written to disk by an ffmpeg with a
       * generous probe budget (see _spawnOutput) and all the time in the world
       * to work out what it is reading — and a take that is eleven seconds
       * long cannot spare eight of them waiting for a slow encoder's second
       * keyframe. What a live platform cannot tolerate, a file can.
       */
      for (const o of this.outputs.values()) {
        if (o.kind !== 'file' || !o.proc || !o.proc.stdin || o.stopping) continue;
        try { o.proc.stdin.write(buf); } catch (e) {}
      }
      const timedOut = Date.now() - this._videoWaitSince > VIDEO_WAIT_MS;
      const tooBig = this._prerollLen > PREROLL_MAX;
      if (!key && !timedOut && !tooBig) return;
      this._sawVideo = true;
      // …and NOW the platforms are connected, so the first bytes each of them
      // ever sees are the keyframe this buffer starts at.
      this._spawnWaitingOutputs();
      const held = Buffer.concat(this._preroll);
      this._preroll = null; this._prerollLen = 0;
      // From the first picture. If none ever came, from wherever we gave up.
      buf = key && this._firstKeyAt != null ? held.subarray(this._firstKeyAt) : held;
      this._replaying = true;   // files already had these bytes as they arrived
      if (process.env.MW_HUB_DEBUG) {
        console.log(`[hub-debug] fan-out opened after ${Date.now() - this._videoWaitSince}ms `
          + `(${key ? 'keyframe seen' : tooBig ? 'buffer full' : 'gave up waiting'}), `
          + `replaying ${(buf.length / 1024).toFixed(0)} KB of held stream`);
      }
    }
    const lim = this._limits();
    const replaying = this._replaying; this._replaying = false;
    for (const o of this.outputs.values()) {
      const p = o.proc;
      if (!p || !p.stdin || o.stopping) continue;
      if (replaying && o.kind === 'file') continue;   // it was fed live, not held
      const backlog = p.stdin.writableLength;
      /*
       * Hysteresis, not a single threshold — see SHED_RESUME_FRACTION. Once
       * this destination is shedding it keeps shedding until the backlog has
       * really drained and a minimum dwell has passed, so the platform gets one
       * settled state instead of a rhythm of stops and starts.
       */
      // A destination that has behaved for a while starts again with a clean
      // sheet, so one early hiccup does not hold its picture down all morning.
      if (!o.shedding && o.shedSpells && o.lastRecoverAt && Date.now() - o.lastRecoverAt > SHED_CALM_MS) o.shedSpells = 0;
      const dwellMs = SHED_MIN_MS * Math.pow(2, Math.min(o.shedSpells || 0, SHED_BACKOFF_MAX));
      const shed = o.shedding
        ? (backlog > lim.shed * SHED_RESUME_FRACTION || (Date.now() - (o.shedSince || 0)) < dwellMs)
        : backlog > lim.shed;
      const dropAudio = backlog > lim.deep;
      let out = buf;
      if (shed || o.shedder.active) {
        out = o.shedder.filter(buf, { shed, dropAudio });
        o.dropped += buf.length - (out ? out.length : 0);
        if (shed && !o.shedding) {
          o.shedding = true;
          o.shedSince = Date.now();
          // Say it out loud. This used to happen in complete silence, which is
          // how a church ends up streaming crackle to one platform for a whole
          // service without a single hint of what to change.
          this._emit(o.id, 'bandwidth', {
            shedding: true,
            // A destination that is re-encoding is far more likely to be short
            // of CPU than of bandwidth — say the thing that is actually true.
            reason: o.copying ? 'upload' : 'encode',
            fitting: this.fitting, fitKbps: this.currentKbps(),
            message: o.copying
              ? (this.fitting
                ? `is falling behind your upload speed. The picture quality is being lowered automatically (now ${Math.round(this.currentKbps() / 100) / 10} mbps) to fit your internet — the sound is not touched.`
                : 'is falling behind your upload speed — dropping picture to keep the sound clean. Try a lower streaming quality.')
              : 'is falling behind — it is being re-encoded to its own quality, which costs this computer a second encode. '
                + 'Dropping picture to keep the sound clean; give it the same quality as your other destination to remove the extra encode.',
          });
        }
      } else if (o.shedding) {
        o.shedding = false;
        o.shedSince = 0;
        o.lastRecoverAt = Date.now();
        o.shedSpells = (o.shedSpells || 0) + 1;
        this._emit(o.id, 'bandwidth', { shedding: false, spells: o.shedSpells, message: 'is keeping up again — picture restored.' });
      }
      /*
       * The last resort, and the reason it exists.
       *
       * Once a destination is past MAX_OUT_BACKLOG even the sound is being
       * dropped, and sound with holes in it is not a degraded broadcast — it is
       * the "weird, distorted, low" audio a church hears on one platform while
       * the other is perfect. Nothing about that state improves by continuing:
       * the destination is already many seconds behind real time, so the
       * platform is being fed slower than it plays. Cutting it and letting the
       * normal reconnect path bring it back loses a few seconds and returns it
       * to REAL TIME, which is the only state a live platform can use.
       */
      if (dropAudio && o.kind === 'rtmp') {   // never a recording: a file is not a live consumer
        if (!o.deepSince) o.deepSince = Date.now();
        else if (Date.now() - o.deepSince > DEEP_BACKLOG_GRACE_MS && !o.stopping) {
          o.deepSince = 0;
          this._emit(o.id, 'bandwidth', {
            shedding: true, reason: o.copying ? 'upload' : 'encode', resetting: true,
            message: 'has fallen so far behind that the sound was starting to break up, so it has been '
              + 'reconnected to catch up. It will be back in a few seconds. This machine or this '
              + 'internet connection cannot carry that destination at this quality — lower it, or stop it.',
          });
          try { p.kill('SIGKILL'); } catch (e) {}   // the close handler reconnects it
          continue;
        }
      } else if (o.deepSince) o.deepSince = 0;
      if (!out || !out.length) continue;
      try { p.stdin.write(out); } catch (e) {}
    }
  
    // …and remember the tail from the last keyframe, for whoever joins next.
    this._trackSinceKey(buf);
  }

  /** Feed one WebM chunk from the renderer's program capture. */
  write(sid, buf) {
    if (sid && this.sid && sid !== this.sid) return false; // stale session
    if (!this.proc || this._stopping) return false;
    this.bytesIn += buf.length;
    try { return this.proc.stdin.write(buf); } catch (e) { return false; }
  }

  /**
   * Attach a consumer. `kind:'rtmp'` pushes to `url`; `kind:'file'` writes an
   * MP4 to `filePath`. When the requested quality matches what the hub is
   * already producing the stream is copied through untouched (no second encode
   * at all); otherwise this output re-encodes to its own size/bitrate.
   */
  addOutput(ctx, id, { kind, url, filePath, q, fps, recFormat: recFormatId }) {
    if (this.outputs.has(id)) throw new Error('That output is already running — stop it first.');
    /*
     * A live destination wants what the PLATFORM wants for the picture this hub
     * is actually encoding — not what its preset says, and not what a preset
     * for some other size says. See platformKbps. A recording is left alone:
     * no file has ever complained about a low bitrate, and a service is long
     * enough that padding one costs real gigabytes.
     */
    const eq = (kind === 'rtmp' && q && this.cfg)
      ? { ...q, videoKbps: platformKbps(q.videoKbps, {
          width: this.cfg.width, height: this.cfg.height, fps: q.fps || fps || this.cfg.fps,
          capKbps: this.cfg.lineCapKbps }) }
      : q;
    const o = {
      id, kind, url, filePath, recFormat: recFormatId,
      q: eq || {}, fps: Math.max(1, Math.round(fps) || (this.cfg && this.cfg.fps) || 30),
      proc: null, lastLog: '', stats: null, startedAt: Date.now(),
      retries: 0, retryTimer: 0, watchdog: 0, stopping: false, dropped: 0, connected: false,
      // per-output, because each destination falls behind independently
      shedder: new TsShedder(), shedding: false, shedSince: 0, shedSpells: 0, lastRecoverAt: 0,
      slowTicks: 0, slowWarned: false,   // "this destination can't encode in real time"
    };
    /*
     * Both of these are decided by the PRESETS, so they are known now — and
     * they must not appear to change just because the process starts later.
     */
    o.copying = this._canCopyVideo(o);
    o.encoderWanted = this.hwName === 'h264_nvenc' ? 'h264_nvenc' : 'libx264';
    this.outputs.set(id, o);
    /*
     * A PLATFORM IS NOT GIVEN A STREAM THAT HAS NO PICTURE IN IT YET.
     *
     * Measured, cold app, one destination, the ordinary thing an operator does
     * on a Sunday morning: the whole 22-second broadcast arrived AUDIO ONLY —
     * 0x0, 0.0 fps, 159 kbps. The first encode after launch pays Media
     * Foundation's first-use initialisation and trickles for several seconds;
     * this ffmpeg was spawned at the same instant and spent that time probing a
     * pipe with no picture parameters in it, concluded there was no video
     * stream, and then wrote sound alone for the entire service —
     *
     *     Could not find codec parameters for stream 0 (Video: h264, none)
     *     Output #0, flv: Stream #0:0: Audio: aac
     *
     * — which is both a black screen and, inevitably, "your bitrate is lower
     * than recommended". Nothing downstream can recover from it: the decision
     * is made once, in the first seconds, and holds for the broadcast.
     *
     * So a live destination's process is not started until the hub actually has
     * a decodable picture to hand it — at which point its very first bytes are a
     * keyframe (the preroll is replayed from `_firstKeyAt`) and the probe cannot
     * fail. It costs the platform a few seconds of connection it had nothing to
     * send into anyway. A FILE is spawned at once, as before: it is fed the held
     * bytes as they arrive and has all the time in the world to work out what it
     * is reading.
     */
    if (kind === 'rtmp' && !this._sawVideo && this.proc) {
      o.waitingForVideo = true;
      o.ctx = ctx;
      /*
       * …but never for longer than the hub itself would wait. If no picture ever
       * arrives — a broadcast with no video source at all, a capture that dies
       * before its first frame — the destination still goes live with the sound,
       * exactly as it did before. Holding is an improvement on the opening
       * seconds, not a new way to fail to go live.
       */
      o.holdTimer = setTimeout(() => {
        o.holdTimer = 0;
        if (!o.waitingForVideo || o.stopping || o.proc) return;
        o.waitingForVideo = false;
        const c2 = o.ctx; o.ctx = null;
        try { this._spawnOutput(c2, o); } catch (e) { o.lastLog = String(e && e.message || e); }
      }, VIDEO_WAIT_MS + 2000);
      if (o.holdTimer.unref) o.holdTimer.unref();
      if (process.env.MW_HUB_DEBUG) console.log(`[hub-debug] ${id}: holding the connection until there is a picture`);
    } else {
      this._spawnOutput(ctx, o);
    }
    return { copying: this._canCopyVideo(o) };
  }

  /** Start any live destination that was waiting for a picture to exist. */
  _spawnWaitingOutputs() {
    for (const o of this.outputs.values()) {
      if (!o.waitingForVideo || o.stopping || o.proc) continue;
      o.waitingForVideo = false;
      if (o.holdTimer) { clearTimeout(o.holdTimer); o.holdTimer = 0; }
      const ctx = o.ctx; o.ctx = null;
      try { this._spawnOutput(ctx, o); } catch (e) { o.lastLog = String(e && e.message || e); }
    }
  }

  _canCopyVideo(o) {
    const c = this.cfg;
    if (!c) return false;
    // A recording IS the broadcast — copy the hub's encode into the file no
    // matter what preset the recording named. Re-encoding here can only lose
    // quality, and it's what used to burn a whole extra core per file (Record
    // asked for 2500kbps while the hub carried 3500, or measured the camera at
    // a slightly different instant and got 24 vs 25 — either mismatch silently
    // ran a second full libx264 encode of every frame).
    if (o.kind === 'file') return true;
    return canCopyQuality(c, { ...o.q, fps: o.fps });
  }

  /**
   * Audio is copied far more readily than video, and that is deliberate.
   *
   * Re-encoding sound is not like re-encoding picture: it means decode → resample
   * → lossy-encode a stream that was ALREADY lossy, and generation loss on AAC is
   * audible on exactly the material a church streams — cymbals, sung consonants,
   * room reverb. It buys nothing either, because no platform rejects a 128 kbps
   * track from a destination configured for 96. So a destination only re-encodes
   * when the hub is carrying substantially more than it asked for.
   */
  _canCopyAudio(o) {
    const c = this.cfg;
    if (!c) return false;
    if (o.kind === 'file') return true; // same reasoning as video: record what was broadcast
    // Every RTMP platform wants AAC and the hub is already producing exactly
    // that, at 48 kHz, at or above what this destination asked for. There is
    // nothing a second encode could improve and a great deal it can spoil, so
    // the bar for doing one is deliberately far out of reach of any preset the
    // app offers: only a hub carrying more than TWICE the requested bitrate is
    // worth re-encoding down, and no combination of presets gets there.
    /*
     * …AT 48 kHz. If the broadcast bus could not open there (see ensureAudio in
     * live.js), copying would put a 44.1 kHz track on air under a promise of
     * 48 — which is the one case where a re-encode genuinely earns its CPU,
     * because it is the platform's own resampler that gets skipped by doing it
     * here. One re-encode with a real converter beats YouTube guessing.
     */
    if ((c.sampleRate || OUT_SAMPLE_RATE) !== OUT_SAMPLE_RATE) return false;
    return c.audioKbps <= (o.q.audioKbps || c.audioKbps) * 2;
  }

  /*
   * Which encoder a destination that CANNOT be copied should use.
   *
   * Software, by default, and that is not timidity: the hub (or the renderer's
   * GPU capture) already holds one hardware encoding session, and a second
   * concurrent session on INTEGRATED graphics is not something Intel or AMD
   * iGPUs reliably supply — on a UHD 620 the second encoder simply stops
   * producing output, with no error and no exit, so the destination never goes
   * live and nothing says why.
   *
   * A discrete NVIDIA card is a different machine. NVENC is a separate block
   * from the display pipeline and supports several concurrent sessions, so the
   * second encode belongs there rather than on a church PC's CPU — which is
   * exactly the case where it matters, because a second 1080p software encode
   * is what makes one platform judder while the other is perfect. If the driver
   * refuses anyway (older cards cap the session count), `hwFailed` sends this
   * output back to software on its next attempt, which is seconds later.
   */
  _outputEncoder(o) {
    if (o.hwFailed) return 'libx264';
    /*
     * Pinned when the destination was ADDED, not read fresh at spawn time.
     * A live destination's process is now started a moment later than it used
     * to be (it waits for a picture to exist — see addOutput), and reading
     * mutable hub state at that later moment means two destinations added one
     * line apart can be spawned against different answers. The choice belongs
     * to the destination, made once, when it was attached.
     */
    if (o.encoderWanted) return o.encoderWanted;
    return this.hwName === 'h264_nvenc' ? 'h264_nvenc' : 'libx264';
  }

  _spawnOutput(ctx, o) {
    const vCopy = this._canCopyVideo(o);
    const aCopy = this._canCopyAudio(o);
    const recFmt = recFormat(o.recFormat);
    const w = o.q.width, h = o.q.height;
    // How much of the feed ffmpeg reads before it will start writing. It has to
    // be at least one GOP: an output attaching mid-broadcast sees no picture
    // parameters until the next keyframe comes round. It must NOT be much more
    // than that, though — ffmpeg reads this budget in full, so an oversized one
    // is pure startup delay, and a short recording can finish before a fixed
    // 2MB is ever satisfied (which is exactly how a 5-second take produced an
    // empty file). Deriving it from the bitrate keeps it right at every quality.
    const c = this.cfg || { videoKbps: 2500, audioKbps: 128, fps: 30 };
    const outEnc = this._outputEncoder(o);
    const gopSec = 2;
    /*
     * How long ffmpeg may spend working out what this feed contains.
     *
     * This is the number that decides whether a consumer keeps the video
     * stream or throws it away. ffmpeg gives up when EITHER budget runs out,
     * and what it does when it gives up is not "wait a bit longer" — it drops
     * the stream and pushes SOUND ONLY for the rest of the service.
     *
     * One GOP is not enough. The renderer's encoder can take seconds to start
     * and then trickles (measured: 3.4 fps at 6 kb/s for the first moments), so
     * two seconds of stream time can contain no complete picture at all. The
     * budget is generous in TIME and modest in BYTES: ffmpeg stops the moment
     * it has what it needs, so a healthy feed pays nothing for the headroom,
     * while the byte budget stays small enough that a five-second take is never
     * left waiting for a quota it cannot fill.
     */
    const analyzeUs = gopSec * 1000000;
    const gopBytes = ((c.videoKbps + c.audioKbps) * 1000 / 8) * gopSec;
    const probeBytes = Math.round(Math.min(6e6, Math.max(3e5, gopBytes * 1.25)));
    const args = [
      '-hide_banner', '-loglevel', 'info', '-stats_period', '1', '-y',
      /*
       * A LIVE DESTINATION IS GIVEN THE SAME PATIENCE AS A RECORDING, and the
       * reason is the whole of the audio-only failure.
       *
       * This used to say that a live destination "locks on fast — the hub
       * repeats its headers every 200 ms and the picture is gated to start at a
       * keyframe, so a long scan buys nothing and costs latency". Every clause
       * of that is true and the conclusion was still wrong, because it assumed
       * a warm encoder. Measured on a COLD app — an operator opening the app
       * and pressing Go Live, which is what happens every Sunday — the first
       * capture pays Media Foundation's first-use init and trickles, so two
       * seconds of stream time contain no picture ffmpeg can measure, and it
       * says so and gives up:
       *
       *     Could not find codec parameters for stream 0 (Video: h264, none):
       *     unspecified size … Consider increasing 'analyzeduration' (2000000)
       *     and 'probesize' (977500)
       *     Output #0, flv: Stream #0:0(und): Audio: aac
       *
       * The whole broadcast then went out as SOUND ONLY: 0x0, 0.0 fps, 160 kbps
       * against 500 wanted — a black screen for the congregation online and, of
       * course, "your bitrate is lower than recommended" as well.
       *
       * The budget is generous in TIME and modest in BYTES, which costs a
       * healthy feed nothing: probing ends the instant ffmpeg has the
       * parameters, which on a warm encoder is immediate. What it buys is that a
       * slow start can no longer be mistaken for a stream with no picture in it.
       */
      ...(o.kind === 'file'
        ? ['-analyzeduration', '15000000', '-probesize', '12000000']
        : ['-fflags', 'nobuffer', '-scan_all_pmts', '0',
           '-analyzeduration', String(Math.max(analyzeUs, LIVE_ANALYZE_US)),
           '-probesize', String(Math.max(probeBytes, LIVE_PROBE_BYTES))]),
      '-f', 'mpegts', '-i', 'pipe:0',
      ...(vCopy ? ['-c:v', 'copy'] : [
        '-r', String(o.fps),
        ...(w && h ? ['-vf',
          `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
          `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`] : []),
        // See _outputEncoder for why this is software on every machine except a
        // discrete NVIDIA one. `fast: true` drops x264 to its cheapest preset
        // for this one output: the alternative is not "a slightly nicer
        // picture", it is an encode that cannot keep up with real time on a
        // two-core church PC, whose backlog then makes the app shed data and
        // the platform report a bad connection. A secondary destination that
        // arrives intact at ultrafast beats a prettier one that stutters.
        ...ENCODERS[outEnc].args({ videoKbps: o.q.videoKbps || 2500, gop: o.fps * 2, profile: o.q.profile, fast: true }),
        '-pix_fmt', 'yuv420p',
      ]),
      // The hub's MPEG-TS carries AAC in ADTS frames; both MP4 and FLV want the
      // codec-config form instead, so copying audio straight through needs the
      // ADTS→ASC filter. Without it the MP4 muxer rejects the very first audio
      // packet ("Malformed AAC bitstream") and the recording dies seconds in.
      //
      // A RECORDING may ask for a different audio format than the broadcast
      // (see REC_FORMATS): a church machine that can't open `mp4a` needs MP3 or
      // PCM in the file even though the live stream must stay AAC. Only the
      // recording branch can choose — RTMP is AAC because the platforms say so.
      ...(o.kind === 'file'
        ? (recFmt.canCopy && aCopy ? recFmt.audioArgs() : recFmt.audioArgs(o.q.audioKbps || 128))
        : (aCopy
          ? ['-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']
          : ['-c:a', 'aac', '-b:a', (o.q.audioKbps || 128) + 'k', '-ar', String(OUT_SAMPLE_RATE), '-ac', '2', '-af', AUDIO_RESAMPLE])),
      '-avoid_negative_ts', 'make_zero',
      ...(o.kind === 'file' ? recFmt.muxArgs(o.filePath) : ['-f', 'flv', o.url]),
    ];
    const proc = spawn(ctx.ffmpeg, args, { windowsHide: true });
    o.proc = proc;
    o.lastLog = '';
    // A destination joining a broadcast already in flight starts at the last
    // keyframe, not in the middle of a picture. See _trackSinceKey.
    this._primeJoiner(o);
    o.copying = vCopy;
    o.encoder = vCopy ? 'copy' : outEnc;
    o.spawnedAt = Date.now();
    // A fresh process is a fresh stream. The shedder may be holding half a
    // transport packet from the connection that just died, and prepending those
    // bytes to the new one puts the destination permanently half a packet out of
    // step — the exact corruption the shedder exists to prevent, reintroduced by
    // the reconnect that was supposed to fix things.
    o.shedder = new TsShedder();
    o.shedding = false;
    o.shedSince = 0;
    o.deepSince = 0;
    proc.stdin.on('error', () => {});

    proc.stderr.on('data', (d) => {
      const s = d.toString();
      o.lastLog += s;
      if (o.lastLog.length > 40000) o.lastLog = o.lastLog.slice(-20000);
      const stats = parseStats(s);
      if (stats) {
        o.stats = { ...stats, dropped: o.dropped, copying: !!vCopy };
        /*
         * "Fast internet, and YouTube still says poor connection."
         *
         * A destination's backlog does not only grow when the UPLOAD is slow —
         * it grows just as readily when that destination's own ffmpeg cannot
         * READ fast enough, which is what happens to one that is re-encoding in
         * software on a busy machine. The platform sees the same thing either
         * way (data arriving late and in gaps) and reports the same thing, so
         * the operator goes looking at their broadband, which is fine, and
         * finds nothing.
         *
         * ffmpeg says so itself: `speed=` below 1.0 on a live feed means it is
         * not keeping up with real time. Sustained, that is a CPU diagnosis, and
         * it has a completely different fix from a bandwidth one — matching the
         * destinations' quality removes the second encode altogether.
         */
        if (!vCopy && stats.speed > 0 && stats.speed < 0.95) o.slowTicks = (o.slowTicks || 0) + 1;
        else if (stats.speed >= 0.99) o.slowTicks = 0;
        if (!o.slowWarned && (o.slowTicks || 0) >= 3) {
          o.slowWarned = true;
          this._emit(o.id, 'bandwidth', {
            shedding: true, reason: 'encode', speed: stats.speed,
            message: 'is being re-encoded to its own quality and this computer cannot keep up (' +
              stats.speed.toFixed(2) + '× real time). This looks like a bad connection to the platform even on fast internet. ' +
              'Give it the SAME streaming quality as your other destination and the extra encode disappears.',
          });
        }
        if (!o.connected) {
          o.connected = true;
          o.retries = 0;
          if (o.watchdog) { clearTimeout(o.watchdog); o.watchdog = 0; }
          this._emit(o.id, 'connected', { copying: !!vCopy });
        }
        this._emit(o.id, 'stats', o.stats);
      }
    });

    proc.on('error', (err) => { o.proc = null; this._outputDied(ctx, o, -1, 'Could not start ffmpeg: ' + err.message); });
    proc.on('close', (code) => {
      if (o.proc !== proc) return;
      o.proc = null;
      if (o.watchdog) { clearTimeout(o.watchdog); o.watchdog = 0; }
      if (o.stopping) return;
      this._outputDied(ctx, o, code, code === 0 ? null : explainExit(o.lastLog));
    });

    // A process that is alive but producing nothing is the worst failure mode:
    // the UI says LIVE and the platform sees silence. If no progress at all has
    // been reported by now, stop waiting and go round the reconnect path.
    if (o.watchdog) clearTimeout(o.watchdog);
    o.watchdog = setTimeout(() => {
      o.watchdog = 0;
      if (o.stopping || o.connected || o.proc !== proc) return;
      try { proc.kill('SIGKILL'); } catch (e) {}
    }, CONNECT_TIMEOUT_MS);
  }

  /**
   * A destination dropped. RTMP destinations reconnect on their own (a flaky
   * church wifi mid-service should not end the broadcast) — the rest of the
   * destinations, and the hub encoder, carry on untouched while it retries.
   */
  _outputDied(ctx, o, code, error) {
    if (process.env.MW_HUB_DEBUG) console.log(`[hub-debug] output ${o.id} died code=${code}\n` + o.lastLog.slice(-4000));
    // A hardware encoder that dies in the first few seconds is a driver that
    // cannot actually give this process a second session — say so once and use
    // software from here on, rather than reconnecting into the same wall five
    // times and then giving up on the destination entirely.
    if (o.encoder && o.encoder !== 'copy' && o.encoder !== 'libx264' && !o.hwFailed
        && Date.now() - (o.spawnedAt || 0) < 10000) {
      o.hwFailed = true;
      o.retries = 0;
    }
    const retriable = o.kind === 'rtmp' && this.outputs.has(o.id) && o.retries < RECONNECT_DELAYS.length;
    if (retriable) {
      const delay = RECONNECT_DELAYS[o.retries];
      o.retries++;
      o.connected = false;
      this._emit(o.id, 'reconnecting', { attempt: o.retries, of: RECONNECT_DELAYS.length, inSec: Math.round(delay / 1000), error });
      o.retryTimer = setTimeout(() => {
        o.retryTimer = 0;
        if (!this.outputs.has(o.id) || o.stopping) return;
        this._spawnOutput(ctx, o);
      }, delay);
      return;
    }
    this.outputs.delete(o.id);
    this._emit(o.id, 'ended', { code, clean: code === 0, error, log: o.lastLog.slice(-1500) });
  }

  _emit(id, type, payload) {
    if (this.onEvent) { try { this.onEvent(id, type, payload); } catch (e) {} }
  }

  outputState(id) {
    const o = this.outputs.get(id);
    if (!o) return null;
    return { running: !!o.proc, startedAt: o.startedAt, stats: o.stats, retries: o.retries, copying: !!o.copying, file: o.filePath };
  }

  async removeOutput(id) {
    const o = this.outputs.get(id);
    if (!o) return false;
    this.outputs.delete(id);
    o.stopping = true;
    if (o.retryTimer) { clearTimeout(o.retryTimer); o.retryTimer = 0; }
    if (o.watchdog) { clearTimeout(o.watchdog); o.watchdog = 0; }
    if (o.holdTimer) { clearTimeout(o.holdTimer); o.holdTimer = 0; }   // never spawned: see addOutput
    // A recording gets longer to finish than a stream does. Ending a broadcast
    // should feel instant and the platform doesn't care how the socket closed,
    // but a recording may still be holding buffered footage that hasn't reached
    // the file yet — cutting that short would lose the end of the take.
    await endProcess(o.proc, o.kind === 'file' ? 10000 : 2500, 'output ' + id);
    o.proc = null;
    return true;
  }

  _killHub() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return Promise.resolve(true);
    this._stopping = true;
    return endProcess(proc, 2500, 'hub encoder');
  }

  /** Stop the hub and every attached output. Safe to call concurrently. */
  stop() {
    if (this._stopPromise) return this._stopPromise;
    this._stopPromise = (async () => {
      this._stopping = true;
      this._stopRateTimer();
      await this._killHub();
      // Let the last encoded bytes reach the destinations before closing them.
      await new Promise((r) => setTimeout(r, 250));
      // All at once: each RTMP teardown takes a second or two on its own, and
      // waiting for them one after another is what made "Stop" feel slow.
      await Promise.all([...this.outputs.keys()].map((id) => this.removeOutput(id)));
      this.sid = 0;
      this.cfg = null;
      this.fit = null;
      this.fitEnabled = false;
      this.fitRefused = false;
      this._broadcastStartedAt = 0;
      this._swFallbackDone = false;
      this._sawVideo = false;
      this._videoWaitSince = 0;
      this._probe = null;
      this._keys = 0;
      this._preroll = null;
      this._prerollLen = 0;
      this._firstKeyAt = null;
      this._stopping = false;
      this._stopPromise = null;
      return true;
    })();
    return this._stopPromise;
  }
}

/**
 * Close stdin so ffmpeg flushes cleanly, then force-kill if it hangs.
 *
 * The grace period is deliberately short. Ending a broadcast has to feel
 * immediate, and neither output format needs a tidy goodbye: an RTMP push ends
 * when the socket drops (the platform doesn't wait for an FLV trailer), and
 * recordings are fragmented MP4 precisely so the file on disk is already valid
 * at every moment rather than depending on a final rewrite.
 */
function endProcess(proc, timeoutMs = 2500, label) {
  return new Promise((resolve) => {
    if (!proc) return resolve(true);
    const t0 = Date.now();
    let done = false;
    const finish = (killed) => {
      if (done) return;
      done = true;
      if (process.env.MW_TEARDOWN_LOG) console.log(`[teardown] ${label || 'proc'} ${Date.now() - t0}ms${killed ? ' (force-killed)' : ''}`);
      resolve(true);
    };
    const killTimer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} finish(true); }, timeoutMs);
    proc.once('close', () => { clearTimeout(killTimer); finish(false); });
    try { proc.stdin.end(); } catch (e) { try { proc.kill('SIGKILL'); } catch (e2) {} }
  });
}

module.exports = {
  LiveStream, ProgramHub, TsShedder, RateFit,
  DESTINATIONS, QUALITIES, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY, buildUrl,
  canCopyQuality, reEncodedAmong, COPY_BITRATE_TOLERANCE, platformKbps,
  detectEncoder, resetEncoderCache, encoderLabel, ENCODERS, parseStats, explainExit,
  OUT_SAMPLE_RATE, AUDIO_RESAMPLE, SHED_BACKLOG, MAX_OUT_BACKLOG,
  FIT_BEHIND_SEC, FIT_CLEAR_SEC, FIT_DOWN_HOLD_MS, FIT_SETTLE_MS, FIT_UP_AFTER_MS,
  FIT_DOWN, FIT_UP, FIT_FLOOR_FRACTION, FIT_MIN_KBPS, FIT_PROBE_FAIL_MS, RATE_TICK_MS,
  FIT_UP_FAST_MS, FIT_UP_FAST, FIT_REC_BACKOFF_MAX, PLATFORM_HEADROOM, FIT_CLEAR_REC_SEC,
  REC_FORMATS, DEFAULT_REC_FORMAT, recFormat,
  AUDIO_QUALITIES, DEFAULT_AUDIO_QUALITY, audioKbpsFor,
};
