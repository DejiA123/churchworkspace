'use strict';
/*
 * Test-only NDI source. Two modes:
 *
 * default — broadcasts a moving BGRA test pattern (R fixed at 200 so the
 *   receiver can verify it) at ~30fps plus a 440Hz stereo tone, so the NDI
 *   receive path can be tested end-to-end with no external app.
 *
 * vst — replicates Ableton's "NDI Output" VST plugin configured as
 *   "Stereo, 3-4" (a real church setup): an AUDIO-ONLY source (no video
 *   frames, ever) publishing a 4-channel 48kHz stream whose channels 1-2 are
 *   SILENT and whose 440Hz tone rides on channels 3-4.
 *
 *   node test/helpers/ndi-source.js <dllPath> [sourceName] [vst]
 */
const koffi = require('koffi');

const dllPath = process.argv[2];
const name = process.argv[3] || 'MW Test Source';
const vstMode = process.argv[4] === 'vst';
if (!dllPath) { console.error('usage: ndi-source.js <dllPath> [name] [vst]'); process.exit(1); }

const lib = koffi.load(dllPath);
const fourcc = (a, b, c, d) => a.charCodeAt(0) | (b.charCodeAt(0) << 8) | (c.charCodeAt(0) << 16) | (d.charCodeAt(0) << 24);
const BGRA = fourcc('B', 'G', 'R', 'A');
const UYVY = fourcc('U', 'Y', 'V', 'Y');

const send_create_t = koffi.struct('s_sc', { p_ndi_name: 'str', p_groups: 'str', clock_video: 'bool', clock_audio: 'bool' });
const video_t = koffi.struct('s_vf', {
  xres: 'int', yres: 'int', FourCC: 'int', frame_rate_N: 'int', frame_rate_D: 'int',
  picture_aspect_ratio: 'float', frame_format_type: 'int', timecode: 'int64',
  p_data: 'void*', line_stride_in_bytes: 'int', p_metadata: 'str', timestamp: 'int64',
});
const il32_t = koffi.struct('s_il', { sample_rate: 'int', no_channels: 'int', no_samples: 'int', timecode: 'int64', p_data: 'void*' });

const init = lib.func('bool NDIlib_initialize()');
const send_create = lib.func('void* NDIlib_send_create(s_sc* p)');
const send_video = lib.func('void NDIlib_send_send_video_v2(void* p, s_vf* v)');
const send_audio_il = lib.func('void NDIlib_util_send_send_audio_interleaved_32f(void* p, s_il* a)');

init();
// Resolution/rate are overridable so the performance suite can broadcast a real
// 1080p60 or 4K30 feed; everything else defaults to the small pattern the
// functional tests use.
const W = Number(process.env.MW_NDI_W) || 320;
const H = Number(process.env.MW_NDI_H) || 180;
const FPS = Number(process.env.MW_NDI_FPS) || 30;
// Real NDI senders (vMix, OBS, NDI HX cameras) put UYVY 4:2:2 on the wire and
// only use BGRA when they genuinely carry alpha. MW_NDI_FMT=uyvy models the
// common case; the default stays BGRA so the existing pixel assertions, which
// were written against it, keep testing what they always did.
const UYVY_MODE = process.env.MW_NDI_FMT === 'uyvy';
// Audio rides a modest polling tick (below); VIDEO gets its own self-correcting
// per-frame timer, for two reasons that both used to make the app look broken:
//
//   RATE. `now - lastVideoAt >= 1000/FPS` tested on a polling tick can only fire
//   on that tick's boundaries, quietly quantising the rate DOWN to the next
//   multiple — 60fps on a 10 ms tick actually sends 50, and 30fps sends 25. The
//   receiver then appears to drop a fifth of the frames it was never sent.
//
//   JITTER. The tick period is also the fixture's own send jitter, and at 60fps
//   even a 4 ms tick is a quarter of a frame. That is enough for two frames to
//   land inside one compositor draw and none inside the next, which the app
//   reports as duplicated frames it never actually dropped. Dropping to a 1 ms
//   tick fixed the jitter but woke this process a thousand times a second, and
//   the CPU it stole showed up as A/V drift in the 4K case — measuring the
//   fixture again, just further downstream.
//
// Scheduling each frame against the IDEAL clock (t0 + n/FPS) is accurate in both
// respects and costs one wakeup per frame, which is what a real camera does.
const AUDIO_TICK = 5;
const BPP = UYVY_MODE ? 2 : 4;
const px = Buffer.alloc(W * H * BPP);
// NDI's own audio clocking BLOCKS each send for the packet's duration, and on
// Windows it cannot block for less than a timer tick: with callback-sized
// packets (MW_NDI_PKT, ~10 ms each) that throttled this fixture to about 90%
// of real time, and the receiver starved — measuring the fixture, not the app.
// A DAW plug-in is paced by its sound card, which is what the wall-clock
// pacing below already models, so fixed-size packets go out unclocked.
const sender = send_create({ p_ndi_name: name, p_groups: null, clock_video: !vstMode, clock_audio: vstMode && !(Number(process.env.MW_NDI_PKT) > 0) });
// Audio is paced off the WALL CLOCK, not off the timer: `setInterval(fn, 33)`
// never fires early and usually fires late, so sending a fixed 1600 samples per
// tick quietly delivers only ~82% of real time — a receiver then starves no
// matter how well it is written, and the test measures the fixture instead of
// the app. Each tick sends exactly the audio that has "happened" since the last
// one, which is what a real sound device does.
const SR = 48000, CH = vstMode ? 4 : 2, AUD_MAX = 4800;
/*
 * A REAL SENDER'S CLOCK, NOT THIS MACHINE'S. Ableton runs on its audio
 * interface's crystal; the receiving PC runs WebAudio on its own sound card's.
 * The two never agree exactly, and the disagreement only shows itself minutes
 * into a service — which is the whole of "it sounds fine, then a few minutes
 * in it crackles". MW_NDI_PPM makes this fixture's clock run that many parts
 * per million fast (or slow, if negative) against the wall clock, so a test can
 * reproduce the drift instead of inheriting whatever this laptop happens to do.
 *
 * MW_NDI_PKT sends in fixed-size packets — Ableton's plug-in hands NDI one
 * audio-callback buffer at a time (256/512/1024 samples) — rather than
 * "whatever is owed". MW_NDI_FREQ picks the tone; a high one is where a
 * glitch in the read position is loudest.
 */
const PPM = Number(process.env.MW_NDI_PPM) || 0;
const PKT = Math.max(0, Math.min(AUD_MAX, Number(process.env.MW_NDI_PKT) || 0));
const FREQ = Number(process.env.MW_NDI_FREQ) || 440;
const aud = Buffer.alloc(AUD_MAX * CH * 4);
let t = 0, phase = 0, sentSamples = 0, sentFrames = 0;
const startedAt = Date.now();

// Paint the static pattern ONCE. Redrawing every pixel per frame is 2M writes at
// 1080p and 8M at 4K, which would make this fixture the slowest thing in the
// test and measure itself instead of the app. Motion comes from a moving bar
// written per frame — O(W) instead of O(W*H). R stays 200 everywhere, which is
// what the receive tests assert on.
function paintRow(y, bright) {
  if (UYVY_MODE) {
    // U Y0 V Y1 per pixel PAIR. Y=180 with this U/V decodes to roughly
    // (248,180,132) — red well above the >150 the receive tests look for.
    for (let x = 0; x < W; x += 2) {
      const o = (y * W + x) * 2;
      px[o] = 100; px[o + 1] = bright ? 235 : 180; px[o + 2] = 160; px[o + 3] = bright ? 235 : 180;
    }
  } else {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      px[o] = bright ? 255 : (x & 255); px[o + 1] = bright ? 255 : (y & 255); px[o + 2] = 200; px[o + 3] = 255;
    }
  }
}
for (let y = 0; y < H; y++) paintRow(y, false);
const BAR = 8;
function moveBar() {
  const y0 = (t * 4) % Math.max(1, H - BAR);
  const prev = ((t - 1) * 4 + H - BAR) % Math.max(1, H - BAR);
  for (let y = prev; y < prev + BAR && y < H; y++) paintRow(y, false);
  for (let y = y0; y < y0 + BAR && y < H; y++) paintRow(y, true);
  t++;
}

let stopped = false;
/** Send frame `sentFrames`, then aim the next wakeup at the ideal time for the
 *  one after it — so a late wakeup is absorbed instead of accumulating. */
function pumpVideo() {
  if (stopped || vstMode) return;
  sentFrames++;
  moveBar();
  send_video(sender, {
    xres: W, yres: H, FourCC: UYVY_MODE ? UYVY : BGRA, frame_rate_N: FPS * 1000, frame_rate_D: 1000,
    picture_aspect_ratio: W / H, frame_format_type: 1, timecode: 0n,
    p_data: px, line_stride_in_bytes: W * BPP, p_metadata: null, timestamp: 0n,
  });
  const due = startedAt + ((sentFrames + 1) * 1000) / FPS;
  setTimeout(pumpVideo, Math.max(0, due - Date.now()));
}
if (!vstMode) setTimeout(pumpVideo, 1000 / FPS);

function sendAudio(NS) {
  const f = new Float32Array(aud.buffer, aud.byteOffset, NS * CH);
  const dph = 2 * Math.PI * FREQ / SR;
  if (vstMode) {
    // interleaved 4ch: [ch1 ch2 ch3 ch4] per sample — tone ONLY on ch 3-4
    for (let i = 0; i < NS; i++) {
      const v = Math.sin(phase) * 0.3; phase += dph;
      f[i * 4] = 0; f[i * 4 + 1] = 0; f[i * 4 + 2] = v; f[i * 4 + 3] = v;
    }
  } else {
    for (let i = 0; i < NS; i++) { const v = Math.sin(phase) * 0.3; phase += dph; f[i * 2] = v; f[i * 2 + 1] = v; }
  }
  if (phase > 2 * Math.PI) phase %= 2 * Math.PI;
  send_audio_il(sender, { sample_rate: SR, no_channels: CH, no_samples: NS, timecode: 0n, p_data: aud });
  sentSamples += NS;
}

const timer = setInterval(() => {
  const now = Date.now();
  const owed = Math.round(((now - startedAt) / 1000) * SR * (1 + PPM * 1e-6)) - sentSamples;
  if (PKT) {
    // one callback-sized buffer at a time, exactly as a DAW plug-in does
    for (let k = owed; k >= PKT; k -= PKT) sendAudio(PKT);
    return;
  }
  const NS = Math.min(AUD_MAX, owed);
  if (NS < 240) return;                         // wait for a worthwhile packet
  sendAudio(NS);
}, AUDIO_TICK);

// How much sound has really gone out, for suites that account for every hop.
if (process.env.MW_NDI_COUNT) setInterval(() => console.log('sent ' + sentSamples + ' at ' + Date.now()), 5000);
process.on('message', (m) => { if (m === 'stop') { stopped = true; clearInterval(timer); process.exit(0); } });
process.on('SIGTERM', () => process.exit(0));
console.log('ndi-source up: ' + name);
