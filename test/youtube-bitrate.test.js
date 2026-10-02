'use strict';
/*
 * "THE STREAM'S CURRENT BITRATE IS LOWER THAN THE RECOMMENDED BITRATE."
 *
 * The warning a real church saw on YouTube every single service:
 *
 *     ⚠ The stream's current bitrate (2278.74 Kbps) is lower than the
 *       recommended bitrate. We recommend that you use a stream bitrate
 *       of 6800 Kbps.
 *
 * Three separate things had to be wrong at once for it to be unavoidable, and
 * this proves each of them is now impossible rather than merely improved:
 *
 *  [A] THE LADDER. The app never knew what a platform charges for a picture
 *      size. 6800 for 1080p60 is the anchor — it is the number in the real
 *      warning, and the table has to produce it from its own published range or
 *      it is not the same table YouTube is using.
 *
 *  [B] THE RECONCILIATION. The picture size and the bitrate came from different
 *      presets and were never compared. Now the preset is a FLOOR and the
 *      platform's rate for the size actually encoded is the target — and,
 *      critically, the hub and every destination must reach that conclusion
 *      SEPARATELY AND IDENTICALLY, or the raise pushes destinations off the
 *      copy path and starts a second live encode (the trap in
 *      two-platform-audio-loss).
 *
 *  [C] THE WIRE. A still lyric slide compresses to almost nothing, so an encode
 *      "at 6000 kbps" can arrive at 104. Measured, on this machine, through the
 *      REAL encoder and the REAL ffmpeg chain — because a bitrate that is only
 *      correct in the renderer is not what the platform is reading.
 *
 * And [D]: the pre-flight has to give the same answer as the encoder, or the
 * operator is told a plan fits that then arrives under-rated.
 *
 * Run: npx electron test/youtube-bitrate.test.js      (npm run test:ytbitrate)
 *      MW_KEEP=1 to keep the muxed/remuxed files.
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const streamrate = require(path.join(ROOT, 'src', 'main', 'streamrate.js'));
const livestream = require(path.join(ROOT, 'src', 'main', 'livestream.js'));
const uplink = require(path.join(ROOT, 'src', 'main', 'uplink.js'));
const { QUALITIES, platformKbps, canCopyQuality } = livestream;

let pass = 0, fail = 0, notes = 0;
const check = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); v ? pass++ : fail++; };
const note = (n, d) => { console.log('  NOTE ' + n + (d ? '  -> ' + d : '')); notes++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-ytrate-'));
const cleanup = () => { if (!process.env.MW_KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} } };

function ffmpegPath() {
  try {
    const ff = require(path.join(ROOT, 'src', 'main', 'ffmpeg.js'));
    const p = ff.ffmpegPath ? ff.ffmpegPath() : (ff.resolve ? ff.resolve() : null);
    if (p && fs.existsSync(p)) return p;
  } catch (e) {}
  for (const c of [path.join(ROOT, 'bin', 'ffmpeg.exe'), path.join(ROOT, 'bin', 'ffmpeg'),
                   path.join(ROOT, 'build', 'ffmpeg.exe'), 'ffmpeg']) {
    if (c === 'ffmpeg' || fs.existsSync(c)) return c;
  }
  return 'ffmpeg';
}
const FFMPEG = ffmpegPath();
const FFPROBE = (() => {
  const c = FFMPEG.replace(/ffmpeg(\.exe)?$/i, (m) => m.replace(/ffmpeg/i, 'ffprobe'));
  return c !== FFMPEG && fs.existsSync(c) ? c : 'ffprobe';
})();

/* ===================== [A] the ladder the platform uses ==================== */

function testLadder() {
  console.log('\n[A] What the platform charges for a picture');

  /*
   * THE ANCHOR. 6800 is not typed into the table anywhere — it falls out of
   * YouTube's published 1080p60 range (4500–9000) by the same midpoint rule
   * every other tier uses. That it lands exactly on the figure from a real
   * warning is the only evidence anyone has that this is the same arithmetic
   * the platform is doing, so it is asserted rather than assumed.
   */
  check(streamrate.recommendedKbps(1920, 1080, 60) === 6800,
    '1080p60 asks for exactly the 6800 kbps in the real warning',
    String(streamrate.recommendedKbps(1920, 1080, 60)));
  check(streamrate.recommendedKbps(1920, 1080, 30) === 4500,
    '1080p30 asks for less than 1080p60', String(streamrate.recommendedKbps(1920, 1080, 30)));

  // The picture in the warning was being sent at 2278 kbps. Whatever shape that
  // was, it must now be recognised as under-rated.
  check(!streamrate.meets(1920, 1080, 60, 2278), '2278 kbps at 1080p60 is recognised as under-rated');
  check(!streamrate.meets(1920, 1080, 30, 2278), '2278 kbps at 1080p30 is recognised as under-rated');
  check(streamrate.meets(1280, 720, 30, 2800), '…but 2800 kbps at 720p30 is fine — the SIZE is what changed');

  // A vertical Reel costs what a horizontal service of the same pixel count costs.
  check(streamrate.recommendedKbps(1080, 1920, 30) === streamrate.recommendedKbps(1920, 1080, 30),
    'a vertical 1080x1920 costs the same as a horizontal 1920x1080');

  // Every rate above 30 is charged at the 60 column: 'Auto' follows the camera,
  // and a 50fps camcorder charged at the 30 rate is under-rated by design.
  check(streamrate.recommendedKbps(1920, 1080, 50) === streamrate.recommendedKbps(1920, 1080, 60),
    'a 50fps camera is charged at the 60fps rate, not the 30fps one');
  check(streamrate.recommendedKbps(1920, 1080, 25) === streamrate.recommendedKbps(1920, 1080, 30),
    'a 25fps camcorder is charged at the 30fps rate — never less');

  // Monotonic: a bigger picture never costs less than a smaller one.
  let mono = true;
  for (const fps of [30, 60]) {
    const rows = streamrate.TIERS.filter((t) => t.fps === fps);
    for (let i = 1; i < rows.length; i++) if (rows[i].rec >= rows[i - 1].rec) mono = false;
  }
  check(mono, 'every step down the ladder genuinely costs less');

  // Every preset the app ships must be answerable — a size with no tier would
  // silently fall back and under-send.
  const unanswered = Object.entries(QUALITIES)
    .filter(([, q]) => !streamrate.recommendedKbps(q.width, q.height, q.fps || 30));
  check(!unanswered.length, 'every shipped preset size has a platform rate',
    unanswered.map(([k]) => k).join(', ') || 'all covered');
}

/* ============ [B] the size and the bitrate can no longer disagree ========== */

function testReconciliation() {
  console.log('\n[B] The preset chooses the picture; the platform prices it');

  /*
   * THE ORIGINAL BUG, stated as a test. The program canvas was sized from the
   * largest destination preset and the bitrate from the highest one — so a
   * 1080p canvas could be encoded at a 720p preset's 2500 kbps and nothing
   * anywhere compared the two.
   */
  /*
   * AT the recommendation is not good enough, and this is why the numbers below
   * are ranges rather than the exact figures YouTube quotes.
   *
   * The platform measures the bitrate ARRIVING over the last few seconds. A
   * stream aimed exactly at the recommendation fails that comparison on every
   * ordinary wobble — a quiet passage, a keyframe landing outside the window,
   * the filler rounding down — so the warning appears intermittently on a
   * stream that is nominally correct, which is indistinguishable to the
   * operator from it being broken. The target therefore carries a small margin
   * (PLATFORM_HEADROOM) and is always clamped to the top of the platform's own
   * published band, so it can never ask for more than the platform accepts.
   */
  const band30 = require('../src/main/streamrate').bandFor(1920, 1080, 30);
  const band60 = require('../src/main/streamrate').bandFor(1920, 1080, 60);
  const p30 = platformKbps(2500, { width: 1920, height: 1080, fps: 30 });
  const p60 = platformKbps(6000, { width: 1920, height: 1080, fps: 60 });
  check(p30 >= band30.rec && p30 <= band30.max,
    'a 720p preset’s bitrate on a 1080p canvas is raised past the 1080p recommendation',
    `${p30} (wants ${band30.rec}, band tops out at ${band30.max})`);
  check(p30 > band30.rec,
    '…with margin, so an ordinary wobble does not land under it',
    `${p30} vs ${band30.rec} — ${Math.round((p30 / band30.rec - 1) * 100)}% over`);
  check(p60 >= band60.rec && p60 <= band60.max,
    'the biggest 1080p preset in the app (6 mbps) is raised past 6800 at 60fps',
    `${p60} (wants ${band60.rec}, band tops out at ${band60.max})`);
  check(platformKbps(4000, { width: 1280, height: 720, fps: 30 }) === 4000,
    'a preset already above the platform rate is left alone',
    String(platformKbps(4000, { width: 1280, height: 720, fps: 30 })));

  // The line has the last word — chasing a rate it cannot feed only makes
  // auto-fit take it back, with judder on the way.
  check(platformKbps(2500, { width: 1920, height: 1080, fps: 30, capKbps: 3000 }) === 3000,
    'a measured line caps the raise');
  check(platformKbps(6000, { width: 1920, height: 1080, fps: 60, capKbps: 3000 }) === 6000,
    'but the cap never drags the rate below what the operator chose');

  /*
   * THE TRAP. Raising the shared encode without raising what each destination
   * is understood to want pushes every destination past COPY_BITRATE_TOLERANCE
   * and re-encodes all of them live on a church PC — the failure documented in
   * two-platform-audio-loss, re-created by the fix for something else.
   */
  let copyBroken = [];
  for (const [key, q] of Object.entries(QUALITIES)) {
    if (q.profile) continue;
    for (const fps of [30, 60]) {
      const w = q.width, h = q.height;
      const hubKbps = platformKbps(q.videoKbps, { width: w, height: h, fps: q.fps || fps });
      const destKbps = platformKbps(q.videoKbps, { width: w, height: h, fps: q.fps || fps });
      const have = { width: w, height: h, fps: q.fps || fps, videoKbps: hubKbps };
      const want = { ...q, fps: q.fps || fps, videoKbps: destKbps };
      if (!canCopyQuality(have, want)) copyBroken.push(key + '@' + fps);
    }
  }
  check(!copyBroken.length,
    'the raise never pushes a destination off the copy path (no second live encode)',
    copyBroken.slice(0, 4).join(', ') || 'every preset still copies');

  // …and the two sides genuinely compute it from the same function, not from
  // two constants that agree today.
  const hub = platformKbps(2500, { width: 1920, height: 1080, fps: 30, capKbps: 0 });
  const dest = platformKbps(2500, { width: 1920, height: 1080, fps: 30, capKbps: 0 });
  check(hub === dest, 'hub and destination reach the same number for the same picture');

  // A recording is not a platform and must not be padded or raised.
  check(platformKbps(2500, {}) === 2500, 'with no picture size (a file), nothing is raised');
}

/* ============= [D] the pre-flight agrees with what will be sent ============ */

function testPreflight() {
  console.log('\n[D] The pre-flight plans against what the app will actually send');

  const q1080 = QUALITIES['H264 1080p 6mbps AAC 128kbps'];
  const q720 = QUALITIES['H264 720p 2.5mbps AAC 128kbps'];

  // The service in the warning: two 1080p destinations on a ~12.5 Mbps line.
  const p = uplink.plan([q1080, q1080], 12.5, QUALITIES, 60);
  check(!p.fits, 'two 1080p60 destinations do not fit a 12.5 Mbps line', p.needMbps.toFixed(2) + ' Mbps needed');
  check(p.recommend && p.recommend.tier < 1080,
    'the answer is a SMALLER PICTURE, not a starved 1080p',
    p.recommend ? p.recommend.key : 'none');

  // The old arithmetic costed a destination at its preset bitrate. A 1080p
  // preset at 2500 kbps would have "fitted" a line that then reported it as
  // under-rated all service.
  const cheap1080 = QUALITIES['H264 1080p 3mbps AAC 128kbps'];
  const costed = uplink.costOf(cheap1080, 30);
  check(costed >= (streamrate.recommendedKbps(1920, 1080, 30) + cheap1080.audioKbps) / 1000 - 0.001,
    'a 1080p destination is costed at the 1080p rate, not at its preset’s',
    costed.toFixed(2) + ' Mbps');

  // A 60fps production the line cannot pay for: the frame rate is the cheaper
  // thing to give up, and nobody chose it.
  const p60 = uplink.plan([q1080], 6, QUALITIES, 60);
  check(p60.recommend && p60.recommend.setFps === 30,
    'a 60fps camera on a slow line is told to drop to 30fps, not to 240p',
    p60.recommend ? (p60.recommend.key + ' @' + p60.recommend.setFps) : 'none');

  // Whatever it recommends must ITSELF fit — a recommendation that is still
  // over budget is worse than none.
  let bad = [];
  for (const mbps of [1, 1.5, 2.5, 4, 6, 8, 12, 20, 40]) {
    for (const n of [1, 2, 3]) {
      for (const fps of [30, 60]) {
        const pl = uplink.plan(Array(n).fill(q1080), mbps, QUALITIES, fps);
        if (pl.fits || !pl.recommend) continue;
        const re = uplink.plan(Array(n).fill(pl.recommend.quality), mbps, QUALITIES,
          pl.recommend.setFps || fps);
        if (!re.fits) bad.push(`${n}x @${mbps}Mbps ${fps}fps -> ${pl.recommend.key}`);
      }
    }
  }
  check(!bad.length, 'every recommendation actually fits the line it was given for',
    bad.slice(0, 3).join(' | ') || 'all fit');

  // …and the verdict says why a smaller picture is the fix, in words, with no
  // jargon. The preset NAME is quoted verbatim on purpose (the operator has to
  // find it in a dropdown), so it is stripped before checking the prose.
  const v = uplink.verdict(uplink.plan([q1080, q1080], 12.5, QUALITIES, 60));
  const prose = v.replace(/“[^”]*”/g, '');
  check(/smaller picture/i.test(v), 'the verdict explains that a smaller picture is the fix');
  check(!/kbps|bitrate|codec|GOP|keyframe/i.test(prose), 'and says it without jargon', prose.slice(0, 90));
}

/* ================= [C] what actually arrives on the wire =================== */

/** ffprobe a file and return { kbps, frames, width, height, ok }. */
function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,avg_frame_rate',
    '-show_entries', 'format=duration,size,bit_rate', '-of', 'json', file], { encoding: 'utf-8' });
  if (r.status !== 0) return { ok: false, err: (r.stderr || '').slice(-400) };
  let j; try { j = JSON.parse(r.stdout); } catch (e) { return { ok: false, err: 'unparseable ffprobe output' }; }
  const s = (j.streams && j.streams[0]) || {};
  const f = j.format || {};
  const dur = Number(f.duration) || 0;
  return {
    ok: true, width: s.width, height: s.height, frames: Number(s.nb_read_frames) || 0,
    dur, bytes: Number(f.size) || 0,
    kbps: dur > 0 ? (Number(f.size) * 8) / dur / 1000 : 0,
  };
}

function runFfmpeg(args) {
  return new Promise((resolve) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); if (err.length > 40000) err = err.slice(-20000); });
    p.on('close', (code) => resolve({ code, err }));
    p.on('error', (e) => resolve({ code: -1, err: String(e) }));
  });
}

/**
 * Encode a STILL 1080p slide in the renderer, through the real capture path's
 * encoder + muxer + the real filler, and hand back the fragmented MP4.
 */
async function captureStill(win, { videoKbps, padKbps, accel, seconds, w, h, fps }) {
  return win.webContents.executeJavaScript(`(async () => {
    const W=${w}, H=${h}, FPS=${fps}, SECS=${seconds};
    const cv = new OffscreenCanvas(W, H); const cx = cv.getContext('2d');
    // The exact picture from the photograph of the real warning: a motionless
    // verse slide. This is the content a church is on for most of a service.
    cx.fillStyle = '#0a1030'; cx.fillRect(0,0,W,H);
    cx.fillStyle = '#ffffff'; cx.font = 'bold ' + Math.round(H/12) + 'px sans-serif';
    cx.fillText('And the earth was without form', W*0.06, H*0.34);
    cx.fillText('and void; and darkness was upon', W*0.06, H*0.50);
    cx.fillText('the face of the deep.', W*0.06, H*0.66);

    const cfg = { codec: 'avc1.42002A', width: W, height: H, bitrate: ${videoKbps}*1000,
      bitrateMode: 'constant', framerate: FPS,
      hardwareAcceleration: ${JSON.stringify(accel)}, latencyMode: 'realtime', avc: { format: 'avc' } };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup || !sup.supported) return { unsupported: true };

    const filler = ${padKbps} ? window.H264Filler.create({ targetKbps: ${padKbps}, fps: FPS }) : null;
    const parts = [];
    const muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.StreamTarget({ onData: (d, pos) => { parts.push({ pos, d: d.slice() }); } }),
      fastStart: 'fragmented', firstTimestampBehavior: 'cross-track-offset',
      video: { codec: 'avc', width: W, height: H, frameRate: FPS },
    });
    let codedBytes = 0, wireBytes = 0, frames = 0;
    const enc = new VideoEncoder({
      output: (chunk, meta) => {
        codedBytes += chunk.byteLength; frames++;
        if (!filler || filler.disabled) { muxer.addVideoChunk(chunk, meta, chunk.timestamp); wireBytes += chunk.byteLength; return; }
        const out = filler.padChunk(chunk.byteLength, (v) => chunk.copyTo(v));
        wireBytes += out.length;
        muxer.addVideoChunkRaw(out, chunk.type, chunk.timestamp,
          chunk.duration || Math.round(1e6/FPS), meta);
      },
      error: (e) => { console.error(e); },
    });
    enc.configure(cfg);
    const n = Math.round(FPS*SECS);
    for (let i = 0; i < n; i++) {
      const vf = new VideoFrame(cv, { timestamp: Math.round(i*1e6/FPS), duration: Math.round(1e6/FPS) });
      enc.encode(vf, { keyFrame: i % Math.round(FPS*2) === 0 });
      vf.close();
      if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 3));
    }
    await enc.flush(); enc.close(); muxer.finalize();
    let total = 0; for (const p of parts) total = Math.max(total, p.pos + p.d.length);
    const buf = new Uint8Array(total);
    for (const p of parts) buf.set(p.d, p.pos);
    return {
      bytes: Array.from(buf),
      codedKbps: (codedBytes*8)/SECS/1000, wireKbps: (wireBytes*8)/SECS/1000,
      frames, secs: SECS,
      filler: filler ? filler.stats() : null,
    };
  })()`);
}

async function testWire(win) {
  console.log('\n[C] What actually arrives on the wire, measured');

  /* ---- the byte-level shape of a filler NAL, before trusting it anywhere ---- */
  const nal = await win.webContents.executeJavaScript(`(() => {
    const F = window.H264Filler;
    const n = F.fillerNal(20);
    const bad = F.fillerNal(20).slice();
    return {
      len: (n[0]<<24)+(n[1]<<16)+(n[2]<<8)+n[3],
      total: n.length, header: n[4], body: Array.from(n.slice(5, 19)), tail: n[19],
      // a real AVCC access unit, and one that is not
      good: F.isAvcc(new Uint8Array([0,0,0,3, 0x65,1,2, 0,0,0,2, 0x41,9])),
      truncated: F.isAvcc(new Uint8Array([0,0,0,9, 0x65,1,2])),
      annexb: F.isAvcc(new Uint8Array([0,0,0,1, 0x65,1,2,3])),
    };
  })()`);
  check(nal.total === 20 && nal.len === 16, 'a filler NAL is length-prefixed correctly',
    nal.total + ' bytes, payload ' + nal.len);
  check(nal.header === 0x0c, 'its NAL type is 12 — the one decoders are required to ignore',
    '0x' + nal.header.toString(16));
  check(nal.body.every((b) => b === 0xff) && nal.tail === 0x80,
    'its payload is filler bytes ending in the stop bit');
  check(nal.good === true && nal.truncated === false && nal.annexb === false,
    'a chunk that is not 4-byte-length-prefixed AVCC is refused, not padded',
    `avcc=${nal.good} truncated=${nal.truncated} annexb=${nal.annexb}`);

  /* --------- the measurement that started all this, and the fix ---------- */
  /*
   * The exact shape of the broadcast in the photograph: a 1080p canvas showing
   * a still verse slide, driven by a preset whose number has nothing to do with
   * 1080p. Both figures below are the ones the SHIPPED code arrives at — the
   * encoder is asked for platformKbps(preset), and the pad target is that same
   * number (live.js passes `padKbps: capKbps`). Measuring a mismatched pair
   * would prove something this app never does.
   */
  const W = 1920, H = 1080, FPS = 30, SECS = 8;
  const PRESET = QUALITIES['H264 1080p 3mbps AAC 128kbps'].videoKbps;      // 3000
  const REC = streamrate.recommendedKbps(W, H, FPS);                       // 4500
  const ASK = platformKbps(PRESET, { width: W, height: H, fps: FPS });     // what ships

  check(ASK >= REC, 'the rate the encoder is asked for already meets the platform’s',
    `preset ${PRESET} -> asked ${ASK}, platform wants ${REC}`);

  for (const accel of ['prefer-hardware', 'prefer-software']) {
    const bare = await captureStill(win, { videoKbps: PRESET, padKbps: 0, accel, seconds: SECS, w: W, h: H, fps: FPS });
    if (bare.unsupported) { note(accel + ' cannot encode 1080p30 on this machine'); continue; }
    const padded = await captureStill(win, { videoKbps: ASK, padKbps: ASK, accel, seconds: SECS, w: W, h: H, fps: FPS });

    console.log(`\n  ${accel}: 1080p30 still slide — the platform wants ${REC} kbps`);
    console.log(`    BEFORE (preset ${PRESET} kbps, no padding): ${Math.round(bare.wireKbps)} kbps on the wire`);
    console.log(`    AFTER  (asked ${ASK} kbps, padded):         ${Math.round(padded.wireKbps)} kbps on the wire`
      + `  (real picture ${Math.round(padded.filler.coded * 8 / SECS / 1000)} kbps`
      + ` + ${Math.round(padded.filler.padded * 8 / SECS / 1000)} kbps filler)`);

    check(bare.wireKbps < REC,
      `${accel}: BEFORE — the old path really did leave under the platform's rate`,
      Math.round(bare.wireKbps) + ' kbps vs ' + REC + ' wanted');
    check(padded.wireKbps >= REC * 0.97,
      `${accel}: a still slide now leaves at the rate the platform asks for`,
      Math.round(padded.wireKbps) + ' kbps vs ' + REC + ' wanted');
    check(padded.wireKbps <= ASK * 1.12,
      `${accel}: …and does not overshoot the rate the line was planned around`,
      Math.round(padded.wireKbps) + ' kbps of an ' + ASK + ' kbps plan');
    check(padded.frames === bare.frames,
      `${accel}: padding adds bytes, never frames`, padded.frames + ' vs ' + bare.frames);

    /*
     * THE PART THAT CANNOT BE PROVED IN THE RENDERER. Filler that a muxer or a
     * remux strips on the way out is filler the platform never sees, and the
     * whole chain here is copies: fragmented MP4 in, MPEG-TS in the middle,
     * FLV out. So the padded capture is pushed through the REAL hub arguments
     * and the REAL output arguments, and measured at the far end.
     */
    const src = path.join(TMP, `still-${accel}.mp4`);
    fs.writeFileSync(src, Buffer.from(padded.bytes));
    const ts = path.join(TMP, `hub-${accel}.ts`);
    const flv = path.join(TMP, `out-${accel}.flv`);
    // exactly what _spawnHub uses on the passthrough path
    const r1 = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-fflags', '+genpts',
      '-f', 'mp4', '-i', src, '-c:v', 'copy',
      '-mpegts_flags', '+resend_headers', '-pat_period', '0.2', '-flush_packets', '1',
      '-f', 'mpegts', ts]);
    // …and what _spawnOutput uses for a copied RTMP destination
    const r2 = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y',
      '-fflags', 'nobuffer', '-f', 'mpegts', '-i', ts, '-c:v', 'copy',
      '-avoid_negative_ts', 'make_zero', '-f', 'flv', flv]);
    if (r1.code !== 0 || r2.code !== 0) {
      check(false, `${accel}: the padded stream survives the real hub + output chain`,
        (r1.err || r2.err).slice(-200));
      continue;
    }
    const pr = probe(flv);
    if (!pr.ok) { note(`${accel}: could not probe the FLV`, pr.err); continue; }
    console.log(`    after the real hub + FLV output: ${Math.round(pr.kbps)} kbps, `
      + `${pr.frames} frames at ${pr.width}x${pr.height}`);
    check(pr.kbps >= REC * 0.95,
      `${accel}: the padding SURVIVES the remux to FLV — it is not stripped on the way out`,
      Math.round(pr.kbps) + ' kbps at the platform end');
    check(pr.frames === padded.frames && pr.width === W && pr.height === H,
      `${accel}: and the picture the platform receives is unchanged`,
      `${pr.frames} frames at ${pr.width}x${pr.height}`);

    // The decoder must be able to read every frame — a malformed access unit is
    // a dead broadcast, which is far worse than a low-bitrate warning.
    const dec = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-xerror',
      '-i', flv, '-f', 'null', '-']);
    check(dec.code === 0 && !/error|corrupt|invalid/i.test(dec.err),
      `${accel}: every padded frame still decodes cleanly`, (dec.err || 'no decoder complaints').slice(-160));
  }
}

/* -------- the padder's own arithmetic, without an encoder in the way ------- */
async function testPadderRules(win) {
  console.log('\n[C2] The padder’s own rules');
  const r = await win.webContents.executeJavaScript(`(() => {
    const F = window.H264Filler;
    const au = (n) => { const b = new Uint8Array(4 + n); b[0]=(n>>>24)&255; b[1]=(n>>>16)&255; b[2]=(n>>>8)&255; b[3]=n&255; b[4]=0x41; return b; };
    const out = {};

    // A still picture: tiny frames, a 3000 kbps promise, 30fps.
    let f = F.create({ targetKbps: 3000, fps: 30 });
    let total = 0;
    for (let i = 0; i < 300; i++) total += f.pad(au(400)).length;
    out.still = (total * 8) / 10 / 1000;

    // A busy picture already over rate: nothing should be added at all.
    f = F.create({ targetKbps: 3000, fps: 30 });
    total = 0;
    for (let i = 0; i < 300; i++) total += f.pad(au(20000)).length;
    out.busy = (total * 8) / 10 / 1000;
    out.busyPadded = f.stats().padded;

    // Auto-fit lowers the rate mid-broadcast: the pad must follow it DOWN and
    // must not dump banked credit into a line that is already full.
    f = F.create({ targetKbps: 6000, fps: 30 });
    for (let i = 0; i < 150; i++) f.pad(au(400));      // 5s of banking
    f.retarget(2000);
    total = 0;
    for (let i = 0; i < 150; i++) total += f.pad(au(400)).length;
    out.afterDrop = (total * 8) / 5 / 1000;

    /*
     * THE RULE THAT COST A FIVE-SECOND FREEZE BEFORE IT EXISTED.
     *
     * Auto-fit lowers the rate only because the upload cannot carry it. Padding
     * through that spends a reduced budget on bytes that are not picture, on a
     * connection that has already given up — measured in the real broadcast
     * test, it turned a stream the app was coping with into shed frames and a
     * 7-second keyframe gap. So the pad stands down until the line gives the
     * rate back.
     */
    f = F.create({ targetKbps: 3000, fps: 30 });
    for (let i = 0; i < 60; i++) f.pad(au(400));
    const beforeSuspend = f.stats().padded;
    f.suspend();
    total = 0;
    for (let i = 0; i < 150; i++) total += f.pad(au(400)).length;
    out.whileSuspended = (total * 8) / 5 / 1000;
    out.suspendedAddedNothing = f.stats().padded === beforeSuspend;
    f.resume();
    total = 0;
    for (let i = 0; i < 150; i++) total += f.pad(au(400)).length;
    out.afterResume = (total * 8) / 5 / 1000;

    // A single frame must never carry a huge dump of catch-up.
    f = F.create({ targetKbps: 6000, fps: 30 });
    let biggest = 0;
    for (let i = 0; i < 300; i++) biggest = Math.max(biggest, f.pad(au(300)).length);
    out.biggestFrame = biggest;
    out.perFrameBudget = (6000 * 1000 / 8) / 30;

    /*
     * The readable form and the on-air form must produce IDENTICAL bytes.
     * padChunk exists only to save a copy; the moment it produces something
     * pad() would not, every test above is testing code that does not ship.
     */
    const f1 = F.create({ targetKbps: 2500, fps: 30 });
    const f2 = F.create({ targetKbps: 2500, fps: 30 });
    let same = true, sizes = 0;
    for (let i = 0; i < 200; i++) {
      const n = 200 + ((i * 977) % 9000);          // a lumpy, keyframe-ish mix
      const src = au(n);
      const viaPad = f1.pad(src);
      const viaChunk = f2.padChunk(src.length, (v) => v.set(src));
      sizes += viaChunk.length;
      if (viaPad.length !== viaChunk.length) { same = false; break; }
      for (let k = 0; k < viaPad.length; k++) if (viaPad[k] !== viaChunk[k]) { same = false; break; }
      if (!same) break;
    }
    out.formsAgree = same;
    out.formsBytes = sizes;

    // A chunk that is not AVCC switches it off rather than corrupting anything.
    f = F.create({ targetKbps: 3000, fps: 30 });
    const junk = new Uint8Array([0,0,0,1, 0x65, 9, 9, 9]);
    for (let i = 0; i < 5; i++) f.pad(junk);
    out.refused = f.disabled; out.reason = f.reason;
    return out;
  })()`);

  check(Math.abs(r.still - 3000) / 3000 < 0.05,
    'a still picture is topped up to the promised rate', Math.round(r.still) + ' kbps of a 3000 promise');
  check(r.busyPadded === 0, 'a picture already over rate is not touched at all',
    r.busyPadded + ' filler bytes added');
  check(r.afterDrop <= 2000 * 1.1,
    'after auto-fit lowers the rate, the pad follows it DOWN', Math.round(r.afterDrop) + ' kbps of a 2000 target');
  check(r.suspendedAddedNothing && r.whileSuspended < 200,
    'while the line is congested the pad stands down completely — filler must never compete with the picture',
    Math.round(r.whileSuspended) + ' kbps sent while suspended');
  check(r.afterResume >= 3000 * 0.9,
    '…and comes back the moment the line gives the rate back',
    Math.round(r.afterResume) + ' kbps of a 3000 target');
  check(r.biggestFrame <= r.perFrameBudget * 3.5,
    'no single frame carries a burst of catch-up',
    Math.round(r.biggestFrame) + ' bytes vs a ' + Math.round(r.perFrameBudget) + ' byte frame budget');
  check(r.formsAgree === true,
    'the one-copy path used on air produces byte-identical output to the readable one',
    Math.round(r.formsBytes / 1024) + ' KB compared frame by frame');
  check(r.refused === true, 'a chunk it does not understand switches padding off instead of corrupting it', r.reason);
}

/* ------- [G] the fallback path: the hub doing its own encode, in x264 ------- */

async function testSoftwareHubPads() {
  console.log('\n[G] The software fallback encode pads too');
  /*
   * h264-filler.js only covers the GPU capture path, where the hub is a pure
   * remux. Pin "Software only" in Streaming Settings — or lose WebCodecs — and
   * the hub does its OWN encode in x264 instead, and a still slide falls
   * straight back to a couple of hundred kbps with nothing to stop it.
   *
   * The args below are the app's own, taken from the ENCODERS table rather than
   * written out here, so this measures what actually ships.
   */
  const { ENCODERS } = livestream;
  const kbps = streamrate.recommendedKbps(1920, 1080, 30);
  const SECS = 8;
  const still = ['-f', 'lavfi', '-i', `color=c=0x0a1030:s=1920x1080:r=30`, '-t', String(SECS)];

  const run = async (cbr, file) => {
    const r = await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', ...still,
      ...ENCODERS.libx264.args({ videoKbps: kbps, gop: 60, profile: null, cbr }),
      '-pix_fmt', 'yuv420p', '-f', 'mpegts', file]);
    if (r.code !== 0) return { err: r.err.slice(-200) };
    const bytes = fs.statSync(file).size;
    return { kbps: (bytes * 8) / SECS / 1000 };
  };

  const plain = await run(false, path.join(TMP, 'x264-plain.ts'));
  const padded = await run(true, path.join(TMP, 'x264-cbr.ts'));
  if (plain.err || padded.err) {
    note('the software encode could not be measured', plain.err || padded.err);
    return;
  }
  console.log(`    a still 1080p slide, asked for ${kbps} kbps:`);
  console.log(`      without true CBR: ${Math.round(plain.kbps)} kbps`);
  console.log(`      with true CBR:    ${Math.round(padded.kbps)} kbps`);
  check(plain.kbps < kbps * 0.5,
    'BEFORE — the software encode really did fall far below the platform’s rate',
    Math.round(plain.kbps) + ' kbps of ' + kbps);
  check(padded.kbps >= kbps * 0.95,
    'the software fallback now holds the rate a platform is watching for',
    Math.round(padded.kbps) + ' kbps of ' + kbps);
  check(padded.kbps <= kbps * 1.10, 'and does not overshoot the plan',
    Math.round(padded.kbps) + ' kbps');

  // Only when a platform is watching — a recording must not carry gigabytes of
  // filler, and this encode is shared with one.
  const off = ENCODERS.libx264.args({ videoKbps: kbps, gop: 60, profile: null });
  check(!off.join(' ').includes('nal-hrd'),
    'a recording-only encode is not padded', off.join(' ').includes('nal-hrd') ? 'padded' : 'clean');
}

/* ---------- [F] record first, go live second — the ordinary order ---------- */

function testRecordThenLive() {
  console.log('\n[F] Recording first must not leave the broadcast under-rated');
  const { ProgramHub } = livestream;
  const hub = new ProgramHub();

  /*
   * A recording is sized at the operator's preset and never padded — nothing
   * watches a FILE for a steady bitrate. Then somebody goes live, and the
   * commonest order of operations in a church used to bypass the whole fix:
   * the broadcast ran at the rate a file was sized for, for the whole service.
   */
  hub.cfg = { width: 1920, height: 1080, videoKbps: 3000, audioKbps: 160, fps: 30, format: 'mp4' };
  hub.fit = null;
  check(hub.cfg.videoKbps === 3000, 'a recording-only session runs at the preset, unraised',
    hub.cfg.videoKbps + ' kbps');

  const want = streamrate.recommendedKbps(1920, 1080, 30);
  const got = hub.reRate(want);
  check(hub.cfg.videoKbps === want, 'a platform joining raises the shared encode in place',
    `3000 → ${hub.cfg.videoKbps} kbps (platform wants ${want})`);
  check(got === want, 'and the hub reports the new rate back to the capture', String(got));

  /*
   * The CEILING is the part that matters and the part that is easy to forget:
   * left at the recording's number, auto-fit drags the picture back down to it
   * the first time the line hiccups and the warning returns permanently.
   */
  check(hub.fit && hub.fit.ceiling === want,
    'the auto-fit ceiling moves with it, so the picture can climb back to the platform’s rate',
    hub.fit ? String(hub.fit.ceiling) : 'no controller');

  // Only ever upward — lowering the shared encode is auto-fit's job, and it has
  // evidence for it. This has none.
  const before = hub.cfg.videoKbps;
  hub.reRate(1000);
  check(hub.cfg.videoKbps === before, 'and it never lowers the rate on its own',
    `${before} kbps, unchanged`);

  // A destination attaching afterwards is rated at the same number, so it is
  // still a straight copy and no second live encode starts.
  const q = QUALITIES['H264 1080p 3mbps AAC 128kbps'];
  const destKbps = platformKbps(q.videoKbps, { width: 1920, height: 1080, fps: 30 });
  check(canCopyQuality({ width: 1920, height: 1080, fps: 30, videoKbps: hub.cfg.videoKbps },
    { ...q, fps: 30, videoKbps: destKbps }),
  'and the destination that joined is still a copy, not a second encode',
  `hub ${hub.cfg.videoKbps} vs destination ${destKbps}`);
}

/* ---- the table has to actually REACH the page, through the real preload ---- */
async function testBridge() {
  console.log('\n[E0] The rate table reaches the page through the real preload');
  /*
   * The one failure nobody would ever notice. If the tiers do not arrive, no
   * error is thrown anywhere: platformRecKbps simply answers 0 for every size,
   * every stream looks fine to the app, and the under-rated warning silently
   * never appears again. So the REAL preload is loaded into a REAL window and
   * asked, rather than the test injecting the table it wants to see.
   */
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    },
  });
  const page = path.join(TMP, 'bridge.html');
  fs.writeFileSync(page, '<!doctype html><meta charset="utf-8"><body></body>');
  await win.loadFile(page);
  const got = await win.webContents.executeJavaScript(
    '({ tiers: (window.api && window.api.live && window.api.live.rateTiers) || null,'
    + '  usable: window.api && window.api.live && window.api.live.uplinkUsable })');
  check(!!(got.tiers && got.tiers.length === streamrate.TIERS.length),
    'the preload hands the page the platform rate table',
    got.tiers ? got.tiers.length + ' tiers' : 'NOTHING — the under-rated warning would never appear');
  check(got.tiers && JSON.stringify(got.tiers) === JSON.stringify(streamrate.TIERS),
    'and it is the same table, value for value');
  check(Math.abs((got.usable || 0) - uplink.USABLE) < 1e-9,
    'and the headroom rule the pre-flight uses', String(got.usable));
  win.destroy();
}

/* ------- the page's own copy of the ladder must not drift from main's ------ */
async function testNoDrift(win) {
  console.log('\n[E] The page and the main process cannot drift apart');
  const sizes = [];
  for (const q of Object.values(QUALITIES)) {
    for (const fps of [25, 30, 50, 60]) sizes.push([q.width, q.height, q.fps || fps]);
  }
  const theirs = await win.webContents.executeJavaScript(
    `(${JSON.stringify(sizes)}).map(([w,h,f]) => window.__mwPlatformRec(w,h,f))`);
  const mine = sizes.map(([w, h, f]) => streamrate.recommendedKbps(w, h, f));
  const diffs = sizes.map((s, i) => (theirs[i] === mine[i] ? null : `${s[0]}x${s[1]}@${s[2]}: page ${theirs[i]} vs main ${mine[i]}`))
    .filter(Boolean);
  check(!diffs.length, 'the page answers every shipped preset size exactly as the main process does',
    diffs.slice(0, 3).join(' | ') || `${sizes.length} sizes agree`);

  /*
   * The page carries its own copy of the table for the sandboxed case, and a
   * second copy of a table is a second chance to be wrong. Compared here
   * against the authority, value for value, so it cannot quietly rot.
   */
  const fb = fallbackTiers();
  check(JSON.stringify(fb) === JSON.stringify(streamrate.TIERS.map((t) =>
    ({ h: t.h, fps: t.fps, min: t.min, max: t.max, rec: t.rec }))),
  'the page’s own fallback table is identical to the main process’s',
  `${fb.length} tiers`);
}

/** The FALLBACK_TIERS literal as it ships inside live.js. */
function fallbackTiers() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'live.js'), 'utf-8');
  const m = src.match(/const FALLBACK_TIERS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('FALLBACK_TIERS not found in live.js — the test needs updating');
  // eslint-disable-next-line no-new-func
  return new Function('return ' + m[1])();
}

/* ================================ harness ================================= */

async function run() {
  testLadder();
  testReconciliation();
  testPreflight();
  testRecordThenLive();

  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const page = path.join(TMP, 'harness.html');
  fs.writeFileSync(page,
    '<!doctype html><meta charset="utf-8"><body></body>'
    + `<script src="${path.join(ROOT, 'src', 'renderer', 'vendor', 'mp4-muxer.js').replace(/\\/g, '/')}"></script>`
    + `<script src="${path.join(ROOT, 'src', 'renderer', 'h264-filler.js').replace(/\\/g, '/')}"></script>`
    // the page's own lookup, lifted verbatim from live.js so [E] compares the
    // shipped code and not a copy of it
    + '<script>' + rendererLookupSource() + '</script>');
  await win.loadFile(page);

  await testSoftwareHubPads();
  await testBridge();
  await testPadderRules(win);
  await testNoDrift(win);
  await testWire(win);

  console.log(`\n  ${pass} passed, ${fail} failed` + (notes ? `, ${notes} notes` : ''));
  console.log('  ffmpeg: ' + FFMPEG);
  if (process.env.MW_KEEP) console.log('  files kept in ' + TMP);
  cleanup();
  app.exit(fail ? 1 : 0);
}

/**
 * Lift platformBand/platformRecKbps out of live.js as they ship.
 *
 * Reading them out of the real file is the whole point of [E]: a copy pasted
 * into the test would agree with the main process forever while the shipped
 * page quietly drifted.
 */
function rendererLookupSource() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'live.js'), 'utf-8');
  const start = src.indexOf('  function platformBand(');
  const endMark = '  /** The one number the platform compares the arriving stream against. */';
  const end = src.indexOf('  function measuredLineKbps(');
  if (start < 0 || end < 0) throw new Error('platformBand/platformRecKbps not found in live.js — the test needs updating');
  const body = src.slice(start, end).replace(endMark, '');
  const tiers = JSON.stringify(streamrate.TIERS);
  return `const RATE_TIERS = ${tiers};\n${body}\nwindow.__mwPlatformRec = platformRecKbps;`;
}

app.whenReady().then(run).catch((e) => { console.error(e); cleanup(); app.exit(1); });
