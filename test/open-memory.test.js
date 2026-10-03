'use strict';
/*
 * OPENING A VIDEO MUST FIT A SMALL SERVER.
 *
 * The Cloud Studio on a 512 MB Render instance was killed for memory the moment
 * a 45-minute sermon was opened. The culprits were the pictures made on open:
 * the waveform (ffmpeg's showwavespic holds every sample — 471 MB for 45
 * minutes of 48 kHz stereo), and the filmstrip (six 4K decoders side by side,
 * 1.2 GB). Reverse had the same flaw: the reverse filter holds every frame.
 *
 * This runs those jobs the way the server does, on a simulated 512 MB / 1 CPU
 * machine, and measures the peak memory of ffmpeg and everything it starts.
 * Linux only (it reads /proc); elsewhere it says so and passes.
 *
 *   node test/open-memory.test.js
 */
process.env.MW_MEMORY_MB = '512';
process.env.MW_CPUS = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const video = require('../src/main/video');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-open-memory');
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};

/** Peak resident memory (MB) of every process this one started, while `fn` runs. */
async function peakChildMB(fn) {
  const kids = () => {
    const out = [];
    const all = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
    const parent = new Map();
    for (const p of all) {
      try { parent.set(p, fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch (e) {}
    }
    const mine = new Set([String(process.pid)]);
    let grew = true;
    while (grew) { grew = false; for (const [p, pp] of parent) if (!mine.has(p) && mine.has(pp)) { mine.add(p); grew = true; } }
    mine.delete(String(process.pid));
    for (const p of mine) out.push(p);
    return out;
  };
  const rss = (p) => { try { const m = /VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p}/status`, 'utf8')); return m ? Number(m[1]) / 1024 : 0; } catch (e) { return 0; } };
  let peak = 0;
  const timer = setInterval(() => { const s = kids().reduce((a, p) => a + rss(p), 0); if (s > peak) peak = s; }, 60);
  try { await fn(); } finally { clearInterval(timer); }
  return Math.round(peak);
}

(async () => {
  if (process.platform !== 'linux') { console.log('  (memory is read from /proc — Linux only; skipped)'); return process.exit(0); }
  // a 20-minute sermon soundtrack at the usual 48 kHz stereo
  const audio = path.join(WORK, 'sermon20.m4a');
  if (!fs.existsSync(audio)) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=1200:c=pink:r=48000:a=0.3', '-ac', '2', '-c:a', 'aac', '-b:a', '64k', audio]);
  }
  // a 4K phone clip, 40 s
  const uhd = path.join(WORK, 'uhd40.mp4');
  if (!fs.existsSync(uhd)) {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '6M', '-g', '30', uhd]);
  }

  console.log('OPENING A VIDEO, ON A 512 MB SERVER');
  let mb = await peakChildMB(() => video.waveform(ctx, { input: audio, width: 2400, height: 100, output: path.join(WORK, 'wave.png') }));
  log(mb < 130, 'the waveform of a 20-minute sermon stays small', `${mb} MB (was ~240 MB here, 471 MB at 45 minutes)`);
  log(fs.statSync(path.join(WORK, 'wave.png')).size > 500, 'and is drawn');

  mb = await peakChildMB(() => video.filmstrip(ctx, { input: uhd, count: 24, output: path.join(WORK, 'strip.png') }));
  log(mb < 200, 'the filmstrip of a 4K clip decodes one frame at a time', `${mb} MB (was ~1.2 GB)`);

  mb = await peakChildMB(() => Promise.all([
    video.filmstrip(ctx, { input: uhd, count: 24, output: path.join(WORK, 'strip2.png') }),
    video.waveform(ctx, { input: audio, width: 2400, height: 100, output: path.join(WORK, 'wave2.png') }),
    video.thumbnail(ctx, { input: uhd, timeSec: 5, output: path.join(WORK, 'thumb.png') }),
  ]));
  log(mb < 200, 'everything that runs on open, together, queues instead of piling up', `${mb} MB`);

  console.log('\nREVERSE, ON A 512 MB SERVER');
  const src = path.join(WORK, 'rev-src.mp4');
  // each frame's brightness is its own number, so the order can be read back
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', "color=c=black:s=1920x1080:r=30:d=8,geq=lum='16+mod(N\\,220)':cb=128:cr=128",
    '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  const out = path.join(WORK, 'rev-out.mp4');
  mb = await peakChildMB(() => video.reverseClip(ctx, { input: src, output: out }));
  log(mb < 400, 'reversing 8 s of 1080p works in pieces that fit', `${mb} MB (the whole-clip filter needed ~900 MB)`);
  const ys = (f) => { const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-vf', 'crop=2:2:100:100,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 }); const a = []; for (let i = 0; i < raw.length; i += 4) a.push(raw[i]); return a; };
  const a = ys(src), b = ys(out);
  const wrong = a.slice().reverse().filter((v, i) => Math.abs(v - b[i]) > 3).length;
  log(a.length === b.length && wrong === 0, 'every frame is there, exactly backwards', `${b.length}/${a.length} frames, ${wrong} out of place`);

  console.log('\nENCODER SETTINGS ON A SMALL SERVER');
  const ffm = require(path.join(__dirname, '..', 'src', 'main', 'ffmpeg'));
  const enc = ['-i', 'a.mp4', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', 'o.mp4'];
  const at = (a, k) => a[a.indexOf(k) + 1];
  const fin = ffm.capThreads(enc);
  log(at(fin, '-preset') === 'veryfast' && at(fin, '-crf') === '18', 'a finished file: veryfast, same CRF', fin.join(' '));
  const dr = await ffm.asDraft(true, async () => { await new Promise((r) => setTimeout(r, 5)); return ffm.capThreads(enc); });
  log(at(dr, '-preset') === 'ultrafast' && at(dr, '-crf') === '14', 'a step on the way (captions follow): ultrafast, more bits', dr.join(' '));
  log(at(ffm.capThreads(enc), '-preset') === 'veryfast', 'and only inside that export');
  const hw = ffm.capThreads(['-i', 'a.mp4', '-c:v', 'h264_qsv', '-preset', 'medium', 'o.mp4']);
  log(at(hw, '-preset') === 'medium', 'a hardware encoder is left alone');
  // under 1 GB x264 holds fewer frames: 251 MB → 166 MB for a 1080×1920 piece
  log(at(fin, '-rc-lookahead') === '5' && at(fin, '-mbtree') === '0' && at(fin, '-bf') === '1',
    'under 1 GB x264 keeps fewer frames in hand (look-ahead 5, one B-frame, no mb-tree)');
  const ownBf = ffm.capThreads(['-i', 'a.mp4', '-c:v', 'libx264', '-bf', '0', 'o.mp4']);
  log(at(ownBf, '-bf') === '0' && ownBf.filter((x) => x === '-bf').length === 1, 'a command that sets its own B-frames keeps them');

  console.log(failed ? '\n❌ open-memory test failed' : '\n✅ open-memory test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
