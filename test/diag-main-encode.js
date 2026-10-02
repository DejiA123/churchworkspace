'use strict';
/*
 * WHERE THE MAIN ENCODE'S TIME GOES.
 *
 * Everything after it is now cheap (see diag-export-speed.js), so this is what
 * an export costs. `encodeWithFallback` is not one ffmpeg run: it renders a
 * checked voice track first, then encodes the picture, then DECODES THE WHOLE
 * THING AGAIN to prove Quick Sync did not write garbage. This times each part
 * on real sermon footage, because testsrc2 is a pathological encode and says
 * nothing useful about a person talking in a hall.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ff = require(path.join(ROOT, 'src/main/ffmpeg'));
const ffmpeg = require('ffmpeg-static');
const { sermonPath, noSermon } = require('./sermon');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const REAL = sermonPath(process.argv[2]);
const WORK = path.join(os.tmpdir(), 'mw-main-encode');
fs.mkdirSync(WORK, { recursive: true });
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/* Every ffmpeg run, with what it was for. */
const runs = [];
const realRun = ff.runFfmpeg;
ff.runFfmpeg = async (bin, args, opts) => {
  const enc = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : '(no video)';
  const to = args[args.length - 1];
  const t0 = Date.now();
  let err = null;
  try { return await realRun(bin, args, opts); } catch (e) { err = e; throw e; }
  finally {
    runs.push({ enc, ms: Date.now() - t0, out: String(to).split(/[\\/]/).pop(), err: !!err,
                hwaccel: args.includes('-hwaccel'), args });
  }
};

(async () => {
  if (!REAL) { console.log(noSermon()); return; }
  const info = await video.getInfo(ctx, REAL);
  console.log(`\n  source: ${info.width}x${info.height} ${info.fps}fps ${(info.durationSec / 60).toFixed(0)}min ${info.vcodec}\n`);

  const CLIP = 30;                                  // a typical short
  const START = Math.min(600, info.durationSec / 2); // ten minutes in, past the notices
  for (const quality of ['1080p', '720p']) {
    runs.length = 0;
    const out = path.join(WORK, `main-${quality}.mp4`);
    const t0 = Date.now();
    await video.exportShort(ctx, { input: REAL, startSec: START, endSec: START + CLIP,
      preset: 'reel-9x16', quality, output: out });
    const total = Date.now() - t0;
    const ffTotal = runs.reduce((n, r) => n + r.ms, 0);
    const o = await video.getInfo(ctx, out);
    console.log(`  ${quality} -> ${o.width}x${o.height}   TOTAL ${secs(total)}  (${(total / (CLIP * 1000)).toFixed(2)}x real time)`);
    for (const r of runs) {
      console.log(`      ${r.enc.padEnd(12)} ${secs(r.ms).padStart(7)}   ${r.hwaccel ? 'hwaccel ' : '        '}-> ${r.out}`);
    }
    console.log(`      ${'(ffmpeg)'.padEnd(12)} ${secs(ffTotal).padStart(7)}   the rest is probes + the decode-verify`);
    console.log(`      file ${(fs.statSync(out).size / 1048576).toFixed(1)} MB\n`);
  }

  /* ---- what the SAME picture costs with the filters on the GPU ---- */
  console.log('  THE SAME 30 SECONDS, FOUR WAYS (1080p, 9:16):');
  const W = 1080, H = 1920;
  const cw = Math.round(info.height * 9 / 16 / 2) * 2;     // 9:16 crop of the source
  const cx = Math.round((info.width - cw) / 2 / 2) * 2;
  const variants = [
    ['software everything', ['-ss', String(START), '-t', String(CLIP), '-i', REAL,
      '-vf', `crop=${cw}:${info.height}:${cx}:0,scale=${W}:${H}:flags=lanczos,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18']],
    ['what it does now', ['-hwaccel', 'auto', '-ss', String(START), '-t', String(CLIP), '-i', REAL,
      '-vf', `crop=${cw}:${info.height}:${cx}:0,scale=${W}:${H}:flags=lanczos,format=nv12`,
      '-c:v', 'h264_qsv', '-global_quality', '19']],
    ['no hwaccel decode', ['-ss', String(START), '-t', String(CLIP), '-i', REAL,
      '-vf', `crop=${cw}:${info.height}:${cx}:0,scale=${W}:${H}:flags=lanczos,format=nv12`,
      '-c:v', 'h264_qsv', '-global_quality', '19']],
    ['filters on the GPU too', ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv',
      '-ss', String(START), '-t', String(CLIP), '-i', REAL,
      '-vf', `vpp_qsv=cw=${cw}:ch=${info.height}:cx=${cx}:cy=0:w=${W}:h=${H}`,
      '-c:v', 'h264_qsv', '-global_quality', '19']],
  ];
  const made = [];
  for (const [name, args] of variants) {
    const out = path.join(WORK, 'v-' + name.replace(/[^a-z]+/gi, '-') + '.mp4');
    const t0 = Date.now();
    const r = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...args, '-an', out],
      { encoding: 'utf8', maxBuffer: 1 << 26 });
    const ms = Date.now() - t0;
    const ok = r.status === 0 && fs.existsSync(out) && fs.statSync(out).size > 10000;
    console.log(`   ${name.padEnd(24)} ${ok ? secs(ms).padStart(7) : '   FAILED'}   `
      + (ok ? (fs.statSync(out).size / 1048576).toFixed(1) + ' MB' : String(r.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || ''));
    if (ok) made.push({ name, out });
  }

  /* ---- and is the picture the same? ---- */
  if (made.length > 1) {
    console.log('\n  QUALITY, each against the all-software render (the reference):');
    const ref = made[0].out;
    for (const m of made.slice(1)) {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-i', m.out, '-i', ref,
        '-lavfi', '[0:v][1:v]ssim;[0:v][1:v]psnr', '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      const e = r.stderr || '';
      const ssim = (e.match(/SSIM[^\n]*All:([\d.]+)/) || [])[1];
      const psnr = (e.match(/PSNR[^\n]*average:([\d.inf]+)/) || [])[1];
      console.log(`   ${m.name.padEnd(24)} SSIM ${ssim || '?'}   PSNR ${psnr || '?'} dB`);
    }
  }
})().catch((e) => console.error(e));
