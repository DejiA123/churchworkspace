'use strict';
/**
 * STREAMING QUALITY PRESET TEST (plain Node).
 *
 * Proves the vMix-style quality system produces SMOOTH, correct output:
 *   1. the preset table is complete and sane (Facebook/Twitch/Twitter/
 *      Vertical/low-bandwidth/4K groups, legacy '720p'-style keys still work)
 *   2. a 25fps camcorder-style source (PAL) encoded with a matched frame rate
 *      comes out as clean constant-frame-rate 25fps — the judder fix: no
 *      frames are duplicated or dropped by a forced 25→30 conversion
 *   3. Twitch p60 presets force 60fps + High profile
 *   4. Vertical (portrait) presets letterbox a landscape program instead of
 *      stretching it, and use Main profile
 *   5. a null/absent fps from an old caller still lands on a safe 30fps CFR
 *
 * Run: node test/quality-presets.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { LiveStream, QUALITIES, QUALITY_GROUPS, LEGACY_QUALITY, DEFAULT_QUALITY } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decode-and-count the real video frames (fragmented MP4s don't record nb_frames). */
function countFrames(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FP, ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames', '-print_format', 'json', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', reject);
    p.on('close', () => {
      try { resolve(+JSON.parse(out).streams[0].nb_read_frames || 0); } catch (e) { resolve(0); }
    });
  });
}

/** Encode the source webm through the engine into an MP4 with the given opts, probe it. */
async function encodeAndProbe(tmp, srcBytes, name, opts) {
  const file = path.join(tmp, name + '.mp4');
  const live = new LiveStream();
  const ended = [];
  live.onEvent = (t, p) => { if (t === 'ended') ended.push(p); };
  live.start({ ffmpeg: FF }, Object.assign({ filePath: file }, opts));
  // file mode needs no realtime pacing — pour the whole clip in and flush
  const CHUNK = 256 * 1024;
  for (let i = 0; i < srcBytes.length; i += CHUNK) {
    live.write(srcBytes.slice(i, i + CHUNK));
    await sleep(5);
  }
  await live.stop();
  await Promise.race([
    (async () => { while (!ended.length) await sleep(100); })(),
    sleep(8000),
  ]);
  const probed = await ffmod.probe(FP, file);
  const v = (probed.streams || []).find((s) => s.codec_type === 'video');
  const a = (probed.streams || []).find((s) => s.codec_type === 'audio');
  const dur = parseFloat((probed.format || {}).duration || '0');
  return { v, a, dur, file, clean: ended.length && ended[0].clean };
}

/** avg_frame_rate "num/den" → frames per second. */
const rateOf = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : 0; };

(async () => {
  console.log('== STREAMING QUALITY PRESET TEST ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-quality-'));

  /* ---------------- 1. preset table integrity ---------------- */
  const grouped = QUALITY_GROUPS.reduce((all, g) => all.concat(g.keys), []);
  check('vMix-style table: 29 presets across 8 groups (Recommended/Facebook/Low bandwidth/Full HD/Twitch/Twitter/Vertical/4K)',
    grouped.length === 29 && QUALITY_GROUPS.length === 8, grouped.length + ' presets / ' + QUALITY_GROUPS.length + ' groups');
  check('every grouped preset exists with sane, even dimensions and bitrates',
    grouped.every((k) => {
      const p = QUALITIES[k];
      return p && p.width % 2 === 0 && p.height % 2 === 0 && p.width >= 240 && p.height >= 240 &&
        p.videoKbps >= 300 && p.videoKbps <= 16000 && (p.audioKbps === 96 || p.audioKbps === 128) &&
        (p.fps === null || p.fps === 30 || p.fps === 60) &&
        (p.profile === null || p.profile === 'high' || p.profile === 'main');
    }));
  check('no duplicate preset labels across groups', new Set(grouped).size === grouped.length);
  check('default preset matches vMix (H264 720p 2.5mbps AAC 128kbps)',
    DEFAULT_QUALITY === 'H264 720p 2.5mbps AAC 128kbps' && QUALITIES[DEFAULT_QUALITY].width === 1280);
  check('legacy 4-choice keys (4K/1080p/720p/480p) still resolve to real presets',
    ['4K', '1080p', '720p', '480p'].every((k) => LEGACY_QUALITY[k] && QUALITIES[k] === QUALITIES[LEGACY_QUALITY[k]]));
  check('Twitch presets force their named rate + High profile',
    QUALITIES['Twitch H264 1080p60 6mbps High AAC 128kbps'].fps === 60 &&
    QUALITIES['Twitch H264 720p30 3.5mbps High AAC 128kbps'].fps === 30 &&
    QUALITIES['Twitch H264 720p60 4.5mbps High AAC 128kbps'].profile === 'high');
  check('Vertical presets are portrait (Reels/TikTok) with Main profile',
    QUALITIES['Vertical H264 1280 2.5mbps Main AAC 128kbps'].width === 720 &&
    QUALITIES['Vertical H264 1280 2.5mbps Main AAC 128kbps'].height === 1280 &&
    QUALITIES['Vertical H264 1920 6mbps Main AAC 128kbps'].height === 1920 &&
    QUALITIES['Vertical H264 1920 6mbps Main AAC 128kbps'].profile === 'main');
  check('camera-following presets leave fps null (follow the production rate)',
    QUALITIES[DEFAULT_QUALITY].fps === null && QUALITIES['Facebook H264 1080p 6mbps AAC 128kbps'].fps === null);

  /* --------- 2. camcorder-style source: 25fps PAL, VP8+Opus like MediaRecorder --------- */
  const srcWebm = path.join(tmp, 'camcorder-25fps.webm');
  await new Promise((res, rej) => {
    const p = spawn(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '6', '-c:v', 'libvpx', '-b:v', '1200k', '-c:a', 'libopus', '-b:a', '96k', srcWebm],
      { windowsHide: true });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('webm gen failed ' + c))));
  });
  const srcBytes = fs.readFileSync(srcWebm);
  check('25fps camcorder-style source created', srcBytes.length > 100000);

  /* --------- matched frame rate → clean constant 25fps (the judder fix) --------- */
  const q720 = QUALITIES[DEFAULT_QUALITY];
  const r25 = await encodeAndProbe(tmp, srcBytes, 'matched-25fps',
    { videoKbps: q720.videoKbps, audioKbps: q720.audioKbps, fps: 25, width: q720.width, height: q720.height });
  check('25fps source + matched rate → H.264 at 1280x720', r25.v && r25.v.codec_name === 'h264' && r25.v.width === 1280 && r25.v.height === 720,
    r25.v && `${r25.v.codec_name} ${r25.v.width}x${r25.v.height}`);
  check('output is constant 25fps — SMOOTH, no 25→30 pulldown judder',
    r25.v && r25.v.r_frame_rate === '25/1' && Math.abs(rateOf(r25.v.avg_frame_rate) - 25) < 0.5,
    r25.v && `r=${r25.v.r_frame_rate} avg=${rateOf(r25.v.avg_frame_rate).toFixed(2)}`);
  const frames25 = await countFrames(r25.file);
  const expFrames = Math.round(r25.dur * 25);
  check('decoded frame count matches duration (no duplicated/dropped frames)',
    Math.abs(frames25 - expFrames) <= Math.max(3, expFrames * 0.06),
    `${frames25} frames over ${r25.dur.toFixed(2)}s (expected ~${expFrames})`);
  check('most of the 6s clip survived the pipeline', r25.dur >= 4.5, r25.dur + 's');
  // 48kHz, not 44.1 — the whole broadcast chain was moved to 48k deliberately
  // (it is what the capture, the platforms and every sound card here run at,
  // and resampling in the middle of it was part of what made one platform's
  // audio sound crusty). This expectation was left behind at 44100 by that
  // change; the encoder has been asked for OUT_SAMPLE_RATE ever since.
  check('AAC audio at broadcast settings', r25.a && r25.a.codec_name === 'aac' && r25.a.sample_rate === '48000',
    r25.a && `${r25.a.codec_name} ${r25.a.sample_rate}Hz`);

  /* --------- 50fps "PAL smooth" — high-rate camcorders match too --------- */
  const r50 = await encodeAndProbe(tmp, srcBytes, 'pal-50fps',
    { videoKbps: 3500, audioKbps: 128, fps: 50, width: 1280, height: 720 });
  check('50fps production rate → constant 50fps output', r50.v && r50.v.r_frame_rate === '50/1',
    r50.v && r50.v.r_frame_rate);

  /* --------- 3. Twitch 720p60 preset: forced 60fps + High profile --------- */
  const qTw = QUALITIES['Twitch H264 720p60 4.5mbps High AAC 128kbps'];
  const rTw = await encodeAndProbe(tmp, srcBytes, 'twitch-720p60',
    { videoKbps: qTw.videoKbps, audioKbps: qTw.audioKbps, fps: qTw.fps, width: qTw.width, height: qTw.height, profile: qTw.profile });
  check('Twitch preset → constant 60fps', rTw.v && rTw.v.r_frame_rate === '60/1', rTw.v && rTw.v.r_frame_rate);
  check('Twitch preset → H.264 High profile', rTw.v && rTw.v.profile === 'High', rTw.v && rTw.v.profile);
  check('Twitch preset → 1280x720', rTw.v && rTw.v.width === 1280 && rTw.v.height === 720, rTw.v && `${rTw.v.width}x${rTw.v.height}`);

  /* --------- 4. Vertical preset: landscape program letterboxed, not stretched --------- */
  const qVert = QUALITIES['Vertical H264 1280 2.5mbps Main AAC 128kbps'];
  const rV = await encodeAndProbe(tmp, srcBytes, 'vertical-1280',
    { videoKbps: qVert.videoKbps, audioKbps: qVert.audioKbps, fps: 25, width: qVert.width, height: qVert.height, profile: qVert.profile });
  check('Vertical preset → exact 720x1280 portrait frame', rV.v && rV.v.width === 720 && rV.v.height === 1280,
    rV.v && `${rV.v.width}x${rV.v.height}`);
  check('Vertical preset → H.264 Main profile', rV.v && rV.v.profile === 'Main', rV.v && rV.v.profile);
  check('Vertical encode finished cleanly (aspect-safe pad filter is valid)', rV.clean === true);

  /* --------- 5. an old caller passing no/null fps still gets safe 30fps CFR --------- */
  const rNull = await encodeAndProbe(tmp, srcBytes, 'null-fps',
    { videoKbps: 2500, audioKbps: 128, fps: null, width: 1280, height: 720 });
  check('null fps from a legacy caller → sanitized to constant 30fps', rNull.v && rNull.v.r_frame_rate === '30/1',
    rNull.v && rNull.v.r_frame_rate);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
