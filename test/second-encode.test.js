'use strict';
/*
 * THE SECOND ENCODE — the one a church pays for without being told.
 *
 * Every destination that matches the shared program encode is copied through
 * byte for byte. A destination that does NOT match has to be decoded and
 * encoded again, live, on the same computer that is compositing the service.
 * That second encode is the difference between "one platform is perfect and the
 * other judders" and "both are perfect", so three things about it have to be
 * true, and this proves each of them without needing two platforms or an
 * afternoon:
 *
 *   1. the rule that decides copy-or-re-encode is ONE rule — the dialog that
 *      warns the operator and the hub that spawns the output cannot disagree
 *      (they used to: the dialog compared only frame size, so lowering a
 *      destination's BITRATE started a second live encode in silence),
 *   2. when the second encode is unavoidable, a machine with a discrete NVIDIA
 *      encoder uses it instead of the CPU,
 *   3. and if that hardware encoder cannot actually take a second session — the
 *      usual case on integrated graphics, and on older NVIDIA drivers — the
 *      destination falls back to software BY ITSELF and still goes to air.
 *
 * Point 3 is what this machine can prove directly: asking any non-NVIDIA box
 * for h264_nvenc fails exactly as a session-limited card would.
 *
 * Run: npm run test:secondencode
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const ffmod = require('../src/main/ffmpeg');
const { ProgramHub, QUALITIES, canCopyQuality, reEncodedAmong, COPY_BITRATE_TOLERANCE, platformKbps } = require('../src/main/livestream');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-2nd-'));

let failed = false;
const log = (v, n, d) => { console.log((v ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); if (!v) failed = true; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { ffmpeg: FF, ffprobe: FP };

const Q = (k) => QUALITIES[k];
const BIG = 'H264 720p 2.5mbps AAC 128kbps';
/*
 * A SMALLER PICTURE, not a smaller bitrate.
 *
 * This used to be 'H264 720p 1.5mbps' — a same-size destination on a lower
 * bitrate, which was once the commonest way to end up with a second live
 * encode. It no longer is one: every destination is rated at what the PLATFORM
 * charges for the picture the hub is encoding (platformKbps), so two 720p
 * destinations cannot differ in bitrate at all and both are copied. A smaller
 * SIZE is now the mismatch that exercises the re-encode and hardware-fallback
 * paths this file exists to prove.
 */
const SMALLER_PICTURE = 'H264 480p 1mbps AAC 96kbps';

function freePort() {
  return new Promise((res) => {
    const sv = net.createServer();
    sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => res(p)); });
  });
}

/** A few seconds of real WebM, the shape MediaRecorder hands the hub. */
function makeWebm(file, secs) {
  return new Promise((res, rej) => {
    const p = spawn(FF, ['-y', '-f', 'lavfi', '-i', `testsrc2=size=1280x720:rate=30`,
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-t', String(secs), '-c:v', 'libvpx', '-b:v', '2000k', '-deadline', 'realtime', '-cpu-used', '8',
      '-c:a', 'libopus', '-b:a', '128k', file], { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('webm gen failed ' + c + ' ' + err.slice(-300)))));
  });
}

const probe = (file, stream, fields) => new Promise((res) => {
  const p = spawn(FP, ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=' + fields,
    '-of', 'default=nw=1:nk=1', file], { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('close', () => res(out.trim().split(/\r?\n/)));
});

(async () => {
  console.log('== THE SECOND ENCODE ==');
  console.log(`   ${os.cpus().length} logical cores, ${os.cpus()[0].model.trim()}`);

  /* ---------------- [1] one rule, not two ---------------- */
  console.log('\n[1] The rule that decides copy-or-re-encode');
  const hubQ = { width: 1920, height: 1080, videoKbps: 4500, fps: 30 };
  log(canCopyQuality(hubQ, { width: 1920, height: 1080, videoKbps: 4500, fps: 30 }), 'an identical destination is copied');
  log(canCopyQuality(hubQ, { width: 1920, height: 1080, videoKbps: 4000, fps: 30 }),
    'a destination asking for a little less is still copied (a second worse encode helps nobody)');
  log(!canCopyQuality(hubQ, { width: 1920, height: 1080, videoKbps: 3000, fps: 30 }),
    'a destination asking for much less is re-encoded — it must not be handed a 4.5mbps feed');
  log(!canCopyQuality(hubQ, { width: 1280, height: 720, videoKbps: 4500, fps: 30 }), 'a different SIZE is re-encoded');
  log(!canCopyQuality(hubQ, { width: 1920, height: 1080, videoKbps: 4500, fps: 60 }), 'a different RATE is re-encoded');
  log(COPY_BITRATE_TOLERANCE > 1 && COPY_BITRATE_TOLERANCE < 2, 'the tolerance is a single named constant', String(COPY_BITRATE_TOLERANCE));

  /*
   * THE regression this exists for: two 1080p destinations, one on a lower
   * bitrate. Same size, so the old size-only check called it fine while the hub
   * quietly ran a second live encode.
   *
   * It cannot happen at all now. A destination's bitrate is no longer a dial:
   * every destination is rated at what the platform charges for the picture the
   * hub encodes (platformKbps), so two 1080p destinations are identical whatever
   * presets they were given. The trap is gone rather than merely reported.
   *
   * The property that actually mattered — THE DIALOG AND THE HUB NEVER DISAGREE
   * — is asserted below over every pair of presets the app ships, which is a
   * stronger statement than the single case this started as.
   */
  const both = reEncodedAmong([Q('H264 1080p 4.5mbps AAC 128kbps'), Q('H264 1080p 3mbps AAC 128kbps')], 30);
  log(both.length === 0,
    'lowering one destination\'s bitrate can no longer start a second live encode — same size, same platform rate',
    JSON.stringify(both));
  log(reEncodedAmong([Q('H264 1080p 4.5mbps AAC 128kbps'), Q(BIG)], 30).length > 0,
    'a destination on a smaller PICTURE is still reported — that one really is a second encode');
  const same = reEncodedAmong([Q('Facebook H264 1080p 6mbps AAC 128kbps'), Q('H264 1080p 4.5mbps AAC 128kbps')], 30);
  log(same.length === 0, 'and a bitrate that is merely a little lower is NOT reported — no false alarms', JSON.stringify(same));

  const keys = Object.keys(QUALITIES).filter((k) => !QUALITIES[k].profile);
  const disagree = [];
  for (const k1 of keys) for (const k2 of keys) {
    const qs = [Q(k1), Q(k2)];
    const said = reEncodedAmong(qs, 30);
    const big = qs.reduce((m, q) => (q.width * q.height > m.width * m.height ? q : m), qs[0]);
    const rate = (q) => platformKbps(q.videoKbps, { width: big.width, height: big.height, fps: q.fps || 30 });
    const have = { width: big.width, height: big.height, fps: 30, videoKbps: Math.max(rate(qs[0]), rate(qs[1])) };
    const did = qs.map((q, i) => (canCopyQuality(have, { ...q, fps: q.fps || 30, videoKbps: rate(q) }) ? -1 : i))
      .filter((i) => i >= 0);
    if (JSON.stringify(said) !== JSON.stringify(did)) disagree.push(k1 + ' + ' + k2);
  }
  log(!disagree.length, 'over every pair of presets, the dialog and the hub give the same answer',
    disagree.slice(0, 3).join(' | ') || (keys.length * keys.length) + ' pairs agree');

  /* ---------------- [2] a real broadcast through the hub ---------------- */
  console.log('\n[2] A real broadcast: one copied destination, one re-encoded');
  const src = path.join(tmp, 'src.webm');
  await makeWebm(src, 14);
  const bytes = fs.readFileSync(src);
  log(bytes.length > 50000, 'a real WebM program feed was made', Math.round(bytes.length / 1024) + ' KB');

  /* THREE ingests, because one of these destinations is deliberately going to
   * fail over and reconnect — and a local `ffmpeg -listen 1` accepts exactly
   * one connection, so the destination that reconnects can never reach the one
   * it was using. Judging the fallback by that empty file would be judging the
   * harness, not the app. */
  const ports = [await freePort(), await freePort(), await freePort()];
  const outFiles = [path.join(tmp, 'copied.flv'), path.join(tmp, 'hw-fallback.flv'), path.join(tmp, 'reencoded.flv')];
  const rx = ports.map((port, i) => spawn(FF, ['-y', '-loglevel', 'error', '-listen', '1', '-timeout', '60',
    '-i', `rtmp://127.0.0.1:${port}/live/app`, '-c', 'copy', '-f', 'flv', outFiles[i]], { windowsHide: true }));
  await sleep(1200);

  const hub = new ProgramHub();
  const events = [];
  hub.onEvent = (id, type, payload) => events.push({ id, type, payload });
  await hub.session(ctx, { sid: 1, width: 1280, height: 720, videoKbps: Q(BIG).videoKbps,
    audioKbps: Q(BIG).audioKbps, fps: 30, encoder: 'auto', format: 'webm' });

  /* Force the hardware path for the re-encoding output. On a machine with no
   * NVIDIA encoder this is exactly what a card that has run out of encoding
   * sessions looks like — the ffmpeg dies within a second — so the automatic
   * fallback is exercised for real rather than described in a comment. */
  const hadNvenc = hub.hwName === 'h264_nvenc';
  hub.hwName = 'h264_nvenc';
  hub.addOutput(ctx, 'copy-dest', { kind: 'rtmp', url: `rtmp://127.0.0.1:${ports[0]}/live/app`, q: Q(BIG), fps: 30 });
  hub.addOutput(ctx, 'hw-dest', { kind: 'rtmp', url: `rtmp://127.0.0.1:${ports[1]}/live/app`, q: Q(SMALLER_PICTURE), fps: 30 });
  // …and one more re-encoding destination on the ordinary software path, to
  // prove that what a re-encoded platform receives is a real broadcast.
  hub.hwName = 'libx264';
  hub.addOutput(ctx, 'reenc-dest', { kind: 'rtmp', url: `rtmp://127.0.0.1:${ports[2]}/live/app`, q: Q(SMALLER_PICTURE), fps: 30 });
  log(hub.outputState('copy-dest').copying === true, 'the matching destination is a straight copy');
  log(hub.outputState('reenc-dest').copying === false, 'the smaller-PICTURE destination has to be re-encoded');

  // feed the program in at real time, the way the renderer does
  const CHUNK = Math.ceil(bytes.length / 28);
  for (let off = 0; off < bytes.length; off += CHUNK) {
    hub.write(1, bytes.subarray(off, off + CHUNK));
    await sleep(250);
  }
  await sleep(2500);

  /* The fallback is a RECONNECT: hwFailed is set the moment the hardware
   * encoder dies, and the software respawn follows on the retry backoff a
   * second or two later. Reading the encoder the instant the flag appears
   * measures the race, not the recovery. */
  for (let i = 0; i < 40; i++) {
    const o = [...hub.outputs.values()].find((x) => x.id === 'hw-dest');
    if (!o || (o.hwFailed && o.encoder === 'libx264')) break;
    await sleep(250);
  }
  const hw = [...hub.outputs.values()].find((o) => o.id === 'hw-dest');
  console.log(`   the destination asked to use the GPU ended up on: ${hw ? hw.encoder : '(gone)'}`
    + (hw && hw.hwFailed ? ' (hardware refused a second session, fell back by itself)' : ''));
  if (hadNvenc) {
    log(hw && (hw.encoder === 'h264_nvenc' || hw.hwFailed),
      'on an NVIDIA machine the second encode goes to the GPU (or falls back if the driver refuses)', hw && hw.encoder);
  } else {
    log(!!(hw && hw.hwFailed && hw.encoder === 'libx264'),
      'HARDWARE REFUSED AND THE DESTINATION FELL BACK TO SOFTWARE BY ITSELF — it is still on air',
      hw ? `${hw.encoder}, hwFailed=${!!hw.hwFailed}` : 'the output was dropped entirely');
  }

  await hub.stop();
  await sleep(1500);
  rx.forEach((p) => { try { p.kill('SIGINT'); } catch (e) {} });
  await sleep(1500);

  console.log('\n[3] What each destination received');
  for (const i of [0, 2]) {
    const label = i === 0 ? 'the copied destination' : 'the re-encoded destination';
    const exists = fs.existsSync(outFiles[i]) && fs.statSync(outFiles[i]).size > 20000;
    log(exists, `${label} received the broadcast`, exists ? Math.round(fs.statSync(outFiles[i]).size / 1024) + ' KB' : 'nothing arrived');
    if (!exists) continue;
    const [codec, w, h] = await probe(outFiles[i], 'v:0', 'codec_name,width,height');
    const [acodec, ar] = await probe(outFiles[i], 'a:0', 'codec_name,sample_rate');
    const [ew, eh] = i === 0 ? [1280, 720] : [Q(SMALLER_PICTURE).width, Q(SMALLER_PICTURE).height];
    log(codec === 'h264' && Number(w) === ew && Number(h) === eh,
      `${label}: real H.264 at ${ew}x${eh}`, `${codec} ${w}x${h}`);
    log(acodec === 'aac' && Number(ar) === 48000, `${label}: AAC at 48 kHz`, `${acodec} ${ar}`);
  }

  const reconnects = events.filter((e) => e.type === 'reconnecting');
  console.log(`   ${reconnects.length} reconnect(s) along the way` +
    (reconnects.length ? ' — expected: that is the hardware fallback happening' : ''));

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log('\n============  SECOND ENCODE ' + (failed ? 'FAILED' : 'PASSED') + '  ============\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message + '\n' + e.stack); process.exit(1); });
