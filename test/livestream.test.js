'use strict';
/**
 * LIVE STREAM ENGINE TEST (plain Node).
 *
 * Proves the whole broadcast pipeline actually pushes a playable RTMP stream:
 *   1. a local ffmpeg RTMP SERVER listens like Facebook's ingest would
 *   2. a synthetic WebM (VP8+Opus — exactly what MediaRecorder produces) is fed
 *      into LiveStream in small timed chunks, like the renderer does
 *   3. the engine re-encodes H.264+AAC and pushes rtmp:// to the receiver
 *   4. the received file is PROBED: right codecs, resolution, duration
 * Also checks URL building, live stats parsing, graceful stop, and the
 * connection-failure path.
 *
 * Run: node test/livestream.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { LiveStream, buildUrl, DESTINATIONS, QUALITIES } = require('../src/main/livestream');
const ffmod = require('../src/main/ffmpeg');

const FF = ffmod.resolveFfmpeg();
const FP = ffmod.resolveFfprobe();
const PORT = 19351;

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' — ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== LIVE STREAM ENGINE TEST ==');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-live-'));
  const srcWebm = path.join(tmp, 'cam.webm');
  const outFlv = path.join(tmp, 'received.flv');

  /* --- URL building --- */
  check('facebook URL joins key onto rtmps ingest',
    buildUrl({ dest: 'facebook', key: 'FB-KEY-123' }) === 'rtmps://live-api-s.facebook.com:443/rtmp/FB-KEY-123');
  check('youtube URL joins key', buildUrl({ dest: 'youtube', key: 'yt-abcd' }) === 'rtmp://a.rtmp.youtube.com/live2/yt-abcd');
  check('custom URL gets trailing slash added',
    buildUrl({ dest: 'custom', customUrl: 'rtmp://myserver/live', key: 'k1' }) === 'rtmp://myserver/live/k1');
  let e1 = ''; try { buildUrl({ dest: 'facebook', key: '' }); } catch (e) { e1 = e.message; }
  check('missing stream key is a clear error', /stream key/i.test(e1), e1);
  let e2 = ''; try { buildUrl({ dest: 'custom', customUrl: 'http://x', key: 'k' }); } catch (e) { e2 = e.message; }
  check('non-rtmp custom URL rejected', /rtmp/.test(e2), e2);
  check('destinations + qualities exported for the UI',
    !!DESTINATIONS.facebook && !!QUALITIES['720p'] && QUALITIES['720p'].videoKbps > 0);

  /* --- the bundled ffmpeg MUST support rtmps (Facebook requires TLS ingest) --- */
  const protoOut = await new Promise((res) => {
    const p = spawn(FF, ['-hide_banner', '-protocols'], { windowsHide: true });
    let s = ''; p.stdout.on('data', (d) => { s += d; }); p.stderr.on('data', (d) => { s += d; });
    p.on('close', () => res(s));
  });
  check('bundled ffmpeg supports rtmps (required for Facebook Live)', /\brtmps\b/.test(protoOut));
  check('bundled ffmpeg supports tls', /\btls\b/.test(protoOut));

  /* --- make an 8s synthetic "camera" WebM: VP8 + Opus, like MediaRecorder --- */
  await new Promise((res, rej) => {
    const p = spawn(FF, ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '8', '-c:v', 'libvpx', '-b:v', '800k', '-c:a', 'libopus', '-b:a', '96k', srcWebm],
      { windowsHide: true });
    p.on('close', (c) => c === 0 ? res() : rej(new Error('webm gen failed ' + c)));
  });
  check('synthetic MediaRecorder-style webm created', fs.existsSync(srcWebm) && fs.statSync(srcWebm).size > 100000);

  /* --- start a local RTMP ingest server (stands in for Facebook) --- */
  const receiver = spawn(FF, ['-y', '-loglevel', 'warning', '-listen', '1', '-timeout', '30',
    '-i', `rtmp://127.0.0.1:${PORT}/live/app`, '-c', 'copy', '-f', 'flv', outFlv], { windowsHide: true });
  let recErr = '';
  receiver.stderr.on('data', (d) => { recErr += d.toString(); });
  const receiverDone = new Promise((res) => receiver.on('close', res));
  await sleep(1500); // let it bind

  /* --- push through the engine, feeding timed chunks like the renderer --- */
  const live = new LiveStream();
  const events = { stats: [], ended: [] };
  live.onEvent = (type, payload) => events[type] && events[type].push(payload);
  live.start({ ffmpeg: FF }, { url: `rtmp://127.0.0.1:${PORT}/live/app`, videoKbps: 800, audioKbps: 96, fps: 30 });
  check('engine reports running after start', live.running === true);

  const bytes = fs.readFileSync(srcWebm);
  const CHUNK = 32 * 1024;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    live.write(bytes.slice(i, i + CHUNK));
    await sleep(25); // ~real-time-ish feed, like MediaRecorder's timeslice
  }
  await sleep(1500); // let the encoder drain
  const stopped = await live.stop();
  check('graceful stop resolves', stopped === true && live.running === false);

  const endEvent = await Promise.race([
    (async () => { while (!events.ended.length) await sleep(100); return events.ended[0]; })(),
    sleep(8000).then(() => null),
  ]);
  check('ended event fired and was clean', !!endEvent && endEvent.clean === true, JSON.stringify(endEvent));
  check('live stats were parsed while streaming (fps/bitrate/time)',
    events.stats.length >= 2 && events.stats.some((s) => s.timeSec > 3 && s.fps >= 0),
    `${events.stats.length} stats events`);

  /* --- verify what the "platform" actually received --- */
  await Promise.race([receiverDone, sleep(10000).then(() => { try { receiver.kill('SIGKILL'); } catch (e) {} })]);
  check('receiver wrote the incoming stream', fs.existsSync(outFlv) && fs.statSync(outFlv).size > 50000,
    recErr.slice(-200));

  const probed = await ffmod.probe(FP, outFlv);
  const v = (probed.streams || []).find((s) => s.codec_type === 'video');
  const a = (probed.streams || []).find((s) => s.codec_type === 'audio');
  const dur = parseFloat((probed.format || {}).duration || '0');
  check('received stream is H.264 video (what Facebook requires)', v && v.codec_name === 'h264', v && v.codec_name);
  check('received stream is AAC audio', a && a.codec_name === 'aac', a && a.codec_name);
  check('resolution preserved 640x360', v && v.width === 640 && v.height === 360, v && `${v.width}x${v.height}`);
  check('duration ≥ 6s of the 8s feed arrived', dur >= 6, dur + 's');

  /* --- failure path: nothing listening → clear error, engine recovers --- */
  const live2 = new LiveStream();
  const ended2 = [];
  live2.onEvent = (t, p) => { if (t === 'ended') ended2.push(p); };
  live2.start({ ffmpeg: FF }, { url: `rtmp://127.0.0.1:19999/live/app`, videoKbps: 800, fps: 30 });
  live2.write(bytes.slice(0, 64 * 1024));
  const end2 = await Promise.race([
    (async () => { while (!ended2.length) await sleep(100); return ended2[0]; })(),
    sleep(15000).then(() => null),
  ]);
  check('unreachable server → ended with a human-readable error',
    !!end2 && end2.clean === false && /server|connect/i.test(end2.error || ''), end2 && end2.error);
  check('engine is reusable after the failure (running=false)', live2.running === false);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('TEST CRASH:', e); process.exit(1); });
