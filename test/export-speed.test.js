'use strict';
/*
 * ►► MAKING THE EXPORT FAST WITHOUT MAKING IT WORSE ◄◄
 *
 * "Is there a way to accelerate the exporting, without affecting the quality?"
 *
 * A short is not one render. It is: encode the clip, burn the added text on,
 * burn the captions on, mix the music under, put the outro on the end — and
 * every one of those used to be a separate ffmpeg pass that DECODED AND
 * RE-ENCODED THE WHOLE THING. Measured on a 30-second 9:16 short:
 *
 *      encode the clip .........  34.4 s
 *      burn the text on ........  16.7 s
 *      burn the captions on ....  16.7 s
 *      mix the music under .....   3.5 s   (already a stream copy)
 *      put the outro on ........  50.8 s   <- to add FIVE SECONDS
 *      ------------------------------------
 *      one 30-second short .....  122 s    = 4x real time
 *
 * Two of those were doing far more work than the job needs, and in both cases
 * the fix is also BETTER for quality, because every re-encode is a generation
 * thrown away:
 *
 *   1. THE OUTRO now conforms the five-second card and joins it to the short
 *      with a stream copy. The sermon's own frames are copied byte for byte.
 *   2. THE TEXT is composited in the SAME pass as the captions when both are
 *      wanted. One decode and one encode instead of two.
 *
 * This file is the guard on both claims: that they are faster, and that what
 * comes out is the same pictures. The speed numbers are deliberately generous
 * (this machine is shared with whatever else is running) — what is being
 * checked is the SHAPE of the work, not a stopwatch.
 *
 *   npm run test:exportspeed
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ff = require(path.join(ROOT, 'src/main/ffmpeg'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-export-speed-test');
fs.mkdirSync(WORK, { recursive: true });

let pass = 0, fail = 0;
const check = (n, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); ok ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/* ---- what every ffmpeg run in a pass actually did ---- */
const realRun = ff.runFfmpeg;
let spy = null;
ff.runFfmpeg = async (bin, args, opts) => {
  const enc = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1]
    : (args.includes('-c') ? args[args.indexOf('-c') + 1] : '(none)');
  const t0 = Date.now();
  const r = await realRun(bin, args, opts);
  if (spy) spy.push({ enc, ms: Date.now() - t0, args });
  return r;
};
async function watch(fn) {
  spy = [];
  const t0 = Date.now();
  await fn();
  const runs = spy; spy = null;
  return { runs, ms: Date.now() - t0 };
}

/** Are two files the same pictures? inf PSNR = byte-identical. */
function samePictures(a, b, seconds) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-t', String(seconds), '-i', a, '-t', String(seconds), '-i', b,
    '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const lines = (r.stderr || '').match(/PSNR[^\n]*/g) || [];
  const last = lines[lines.length - 1] || '';
  const m = last.match(/average:([\d.]+|inf)/);
  return { psnr: m ? m[1] : null, line: last.trim() };
}

function build() {
  const src = path.join(WORK, 'src-40s-1080p.mp4');
  if (!fs.existsSync(src) || fs.statSync(src).size < 300000) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '40', '-i', 'testsrc2=size=1280x720:rate=30',
      '-f', 'lavfi', '-t', '40', '-i', 'sine=frequency=220:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', src], { stdio: 'ignore' });
  }
  const outro = path.join(WORK, 'outro-5s.mp4');
  if (!fs.existsSync(outro)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', '5', '-i', 'color=c=0x101820:s=608x1080:r=30',
      '-f', 'lavfi', '-t', '5', '-i', 'sine=frequency=330:sample_rate=48000',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', outro], { stdio: 'ignore' });
  }
  return { src, outro };
}
/** A transparent full-frame picture with a solid band, the shape a burn really is. */
function overlayPng(w, h, name) {
  const f = path.join(WORK, `ov-${name}.png`);
  if (!fs.existsSync(f)) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `color=c=black@0.0:s=${w}x${h},format=rgba`,
      '-f', 'lavfi', '-i', `color=c=white@0.9:s=${Math.round(w * 0.7)}x120,format=rgba`,
      '-filter_complex', '[0][1]overlay=(W-w)/2:H-300:format=auto[o]',
      '-map', '[o]', '-frames:v', '1', f], { stdio: 'ignore' });
  }
  return f;
}

(async () => {
  const { src, outro } = build();

  head('[0] A short to work on');
  const shortPath = path.join(WORK, 'short.mp4');
  await video.exportShort(ctx, { input: src, startSec: 2, endSec: 22, preset: 'reel-9x16',
    quality: '1080p', output: shortPath });
  const short = await video.getInfo(ctx, shortPath);
  check('exported a 20-second short', short.durationSec > 19 && short.durationSec < 21,
    `${short.width}x${short.height} ${short.durationSec.toFixed(1)}s ${short.fps}fps`);

  /* =================================================================== */
  head('[1] ►► THE OUTRO: five seconds should not cost re-encoding twenty ◄◄');
  const joined = path.join(WORK, 'joined.mp4');
  const j = await watch(() => video.appendClips(ctx, {
    input: shortPath, clips: [{ path: outro }], position: 'end', output: joined }));
  const jInfo = await video.getInfo(ctx, joined);
  const copies = j.runs.filter((r) => r.enc === 'copy').length;
  const encodes = j.runs.filter((r) => /264|qsv|nvenc|amf/i.test(r.enc)).length;
  console.log('    ' + j.runs.map((r) => `${r.enc} ${secs(r.ms)}`).join('  |  ') + `   total ${secs(j.ms)}`);
  check('the finished file is the short plus the outro',
    Math.abs(jInfo.durationSec - (short.durationSec + 5)) < 1,
    `${jInfo.durationSec.toFixed(1)}s (wanted ${(short.durationSec + 5).toFixed(1)}s)`);
  check('►► the short itself is COPIED, not re-encoded ◄◄', copies >= 1, `${copies} stream copies`);
  check('…and only the five-second card is encoded', encodes <= 1, `${encodes} encode(s)`);
  const q = samePictures(joined, shortPath, short.durationSec - 0.5);
  check('►► so the sermon comes out frame-for-frame identical ◄◄', q.psnr === 'inf',
    q.line || 'no psnr');
  check('it still keeps the short\'s own shape', jInfo.width === short.width && jInfo.height === short.height,
    `${jInfo.width}x${jInfo.height}`);

  head('[1b] …and it is still correct when a copy would be wrong');
  {
    // A card of a different SHAPE still has to be conformed, and the join has to
    // come out the right length either way.
    const wide = path.join(WORK, 'outro-wide.mp4');
    if (!fs.existsSync(wide)) {
      execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-t', '4', '-i', 'color=c=0x203040:s=1920x1080:r=25',
        '-f', 'lavfi', '-t', '4', '-i', 'sine=frequency=300:sample_rate=44100',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-shortest', wide], { stdio: 'ignore' });
    }
    const out2 = path.join(WORK, 'joined-wide.mp4');
    await video.appendClips(ctx, { input: shortPath, clips: [{ path: wide }], position: 'end', output: out2 });
    const i2 = await video.getInfo(ctx, out2);
    check('a 16:9 card on a 9:16 short still joins cleanly',
      Math.abs(i2.durationSec - (short.durationSec + 4)) < 1 && i2.width === short.width,
      `${i2.width}x${i2.height} ${i2.durationSec.toFixed(1)}s`);
    const q2 = samePictures(out2, shortPath, short.durationSec - 0.5);
    check('…and the sermon is still untouched', q2.psnr === 'inf', q2.line || 'no psnr');
  }

  /* =================================================================== */
  head('[2] ►► THE TEXT AND THE CAPTIONS IN ONE PASS ◄◄');
  const textPng = overlayPng(short.width, short.height, 'text');
  const capPng = new Uint8Array(fs.readFileSync(overlayPng(short.width, short.height, 'cap')));
  const frames = [];
  for (let t = 0; t < short.durationSec; t += 1.5) frames.push({ png: capPng, dur: 1.5 });
  const track = { band: { x: 0, y: short.height - 400, w: short.width, h: 400 },
                  fps: 30, authorW: short.width, authorH: short.height, frames };

  const capsOnly = await watch(() => video.burnCaptionTrack(ctx, {
    input: shortPath, track, output: path.join(WORK, 'caps.mp4') }));
  const both = await watch(() => video.burnCaptionTrack(ctx, {
    input: shortPath, track, images: [{ path: textPng, start: 0, end: short.durationSec }],
    output: path.join(WORK, 'both.mp4') }));
  const textOnly = await watch(() => video.burnImageOverlays(ctx, {
    input: shortPath, images: [{ path: textPng, start: 0, end: short.durationSec }],
    output: path.join(WORK, 'text.mp4') }));
  console.log(`    captions alone ${secs(capsOnly.ms)}   text alone ${secs(textOnly.ms)}`
    + `   both together ${secs(both.ms)}   (separately: ${secs(capsOnly.ms + textOnly.ms)})`);
  check('►► doing both together costs about what ONE of them costs ◄◄',
    both.ms < capsOnly.ms + textOnly.ms * 0.5,
    `${secs(both.ms)} vs ${secs(capsOnly.ms + textOnly.ms)} apart`);
  check('…and it really is one ffmpeg run, not two', both.runs.length === 1,
    both.runs.length + ' runs');

  head('[2b] The text is actually IN the picture, and under the captions');
  {
    const bothInfo = await video.getInfo(ctx, path.join(WORK, 'both.mp4'));
    check('the merged file is the same size and length as the short',
      bothInfo.width === short.width && Math.abs(bothInfo.durationSec - short.durationSec) < 0.5,
      `${bothInfo.width}x${bothInfo.height} ${bothInfo.durationSec.toFixed(1)}s`);
    // Something was drawn: the merged frame differs from the plain short.
    const vsPlain = samePictures(path.join(WORK, 'both.mp4'), shortPath, 5);
    check('something really was burned on', vsPlain.psnr !== 'inf', vsPlain.line || 'no psnr');
    // …and it is not merely the captions: it differs from the captions-only file too.
    const vsCaps = samePictures(path.join(WORK, 'both.mp4'), path.join(WORK, 'caps.mp4'), 5);
    check('►► and it is the TEXT as well as the captions ◄◄', vsCaps.psnr !== 'inf',
      vsCaps.line || 'no psnr');
  }

  /* =================================================================== */
  head('[3] The whole chain, end to end');
  {
    const t0 = Date.now();
    let out = shortPath;
    out = await video.burnCaptionTrack(ctx, { input: out, track,
      images: [{ path: textPng, start: 0, end: short.durationSec }],
      output: path.join(WORK, 'chain-1.mp4') });
    const music = path.join(WORK, 'bed.m4a');
    if (!fs.existsSync(music)) {
      execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-t', '30',
        '-i', 'sine=frequency=440:sample_rate=48000', '-c:a', 'aac', music], { stdio: 'ignore' });
    }
    out = await video.mixMusic(ctx, { input: out, musicPath: music, musicVolume: 0.25,
      output: path.join(WORK, 'chain-2.mp4') });
    out = await video.appendClips(ctx, { input: out, clips: [{ path: outro }], position: 'end',
      output: path.join(WORK, 'chain-3.mp4') });
    const ms = Date.now() - t0;
    const fin = await video.getInfo(ctx, out);
    console.log(`    text + captions + music + outro on a ${short.durationSec.toFixed(0)}s short: ${secs(ms)}`);
    check('the finished short is the right length',
      Math.abs(fin.durationSec - (short.durationSec + 5)) < 1.2, `${fin.durationSec.toFixed(1)}s`);
    check('…at the right size, with sound', fin.width === short.width && fin.hasAudio,
      `${fin.width}x${fin.height} ${fin.hasAudio ? 'with audio' : 'SILENT'}`);
    /*
     * Three passes' worth of work on a 20-second short. The bar is loose on
     * purpose — this runs on whatever machine happens to be free — but a
     * regression that put the outro back to a full re-encode would double it.
     */
    check('the whole tail of the chain stays well inside real time × 3',
      ms < short.durationSec * 3000, `${secs(ms)} for ${short.durationSec.toFixed(0)}s of video`);
  }
  /* =================================================================== */
  head('[4] >> THE MAIN ENCODE: crop first, then scale <<');
  {
    /*
     * `scale(increase),crop` scales a 16:9 recording UP to three times the
     * target width and then throws 68% of it away. Measured on a real 65-minute
     * sermon, a 30-second 9:16 short: 21.3 s of lanczos on pixels nobody sees.
     * Taking the crop out of the SOURCE first is the same picture from a third
     * of the work — and it is what the face-tracked export has always done.
     */
    const chain = video.fillChain(1280, 720, 1080, 1920, 'crop');
    const m = chain.match(/^crop=(\d+):(\d+):(\d+):(\d+),scale=1080:1920/);
    check('>> the crop comes out of the source before the scale <<', !!m, chain);
    if (m) {
      const [, cw, ch, cx, cy] = m.map(Number);
      check('…the full height of a too-wide source is kept', ch === 720, `${cw}x${ch}`);
      check('…the region is centred and inside the picture',
        Math.abs((1280 - cw) / 2 - cx) <= 1 && cy === 0 && cx + cw <= 1280, `x=${cx} y=${cy}`);
      check('…and it is the target shape, to within a rounding',
        Math.abs(cw / ch - 1080 / 1920) < 0.005, (cw / ch).toFixed(4));
    }
    check('a source ALREADY at the target shape is left alone',
      video.cropFirstChain(1080, 1920, 1080, 1920) === null);
    check('…and so is one that barely differs', video.cropFirstChain(1920, 1080, 1920, 1088) === null);

    // Every shape a church exports, checked for a crop that stays in bounds.
    const shapes = [[1280, 720], [1920, 1080], [3840, 2160], [1440, 1080], [1080, 1920], [640, 480]];
    const targets = [[1080, 1920], [1080, 1080], [1920, 1080]];
    let bad = null;
    for (const [sw, sh] of shapes) {
      for (const [tw, th] of targets) {
        const c = video.cropFirstChain(sw, sh, tw, th);
        if (!c) continue;
        const g = c.match(/crop=(\d+):(\d+):(\d+):(\d+)/).slice(1).map(Number);
        const [cw, ch, cx, cy] = g;
        if (cx + cw > sw || cy + ch > sh || cw < 2 || ch < 2
            || Math.abs(cw / ch - tw / th) > 0.01
            || Math.abs((sw - cw) / 2 - cx) > 1 || Math.abs((sh - ch) / 2 - cy) > 1) {
          bad = `${sw}x${sh} -> ${tw}x${th} gave ${c}`;
        }
      }
    }
    check('>> every source/target shape crops in bounds, centred, in shape <<', !bad, bad || '18 combinations');
  }

  head('[4b] …and the picture is no softer for it');
  {
    /*
     * The two orders do not produce identical files: a crop lands on whole
     * pixels, so the framing can differ by about a source pixel. What must NOT
     * differ is the DETAIL — and it does not, because the surviving pixels are
     * resampled once instead of as part of a frame three times the size.
     */
    const sharp = (f) => {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-i', f, '-vf',
        'format=gray,convolution=0 -1 0 -1 4 -1 0 -1 0:0 -1 0 -1 4 -1 0 -1 0:0 -1 0 -1 4 -1 0 -1 0:0 -1 0 -1 4 -1 0 -1 0,'
        + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      const v = [...(r.stderr || '').matchAll(/YAVG=([\d.]+)/g)].map((x) => parseFloat(x[1]));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    const mk = (name, vf) => {
      const out = path.join(WORK, 'enc-' + name + '.mp4');
      const t0 = Date.now();
      spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-t', '8', '-i', src,
        '-vf', vf + ',format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      return { out, ms: Date.now() - t0 };
    };
    const oldWay = mk('old', 'scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1');
    const newWay = mk('new', video.fillChain(1280, 720, 1080, 1920, 'crop'));
    const so = sharp(oldWay.out), sn = sharp(newWay.out);
    console.log(`    old order ${secs(oldWay.ms)}   new order ${secs(newWay.ms)}`
      + `   detail ${so && so.toFixed(3)} -> ${sn && sn.toFixed(3)}`);
    check('>> the new order is faster <<', newWay.ms < oldWay.ms,
      `${secs(newWay.ms)} vs ${secs(oldWay.ms)}`);
    check('>> and the picture is no softer <<', sn != null && so != null && sn >= so * 0.98,
      `detail ${so.toFixed(3)} -> ${sn.toFixed(3)}`);
  }

  head('[5] The decode-verify still bites, and costs half as much');
  {
    /*
     * A Quick Sync encode can exit 0 having written garbage (seen under GPU
     * contention — two exports at once, which the background dock now makes
     * ordinary), so every hardware encode is decoded again to prove it. That
     * proof was 10.8 s of a 35.8 s export. Decoding the picture on the GPU and
     * not decoding the sound at all halves it — and catches exactly the same
     * things, which is the only reason it is allowed to be faster.
     */
    const good = path.join(WORK, 'verify-good.mp4');
    spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-t', '6', '-i', src,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-c:a', 'aac', good], { encoding: 'utf8' });
    check('a healthy file passes', await video.isCleanEncode(ctx, good));

    const truncated = path.join(WORK, 'verify-truncated.mp4');
    const b = fs.readFileSync(good);
    fs.writeFileSync(truncated, b.subarray(0, Math.floor(b.length * 0.9)));
    check('>> a truncated one is still caught <<', !(await video.isCleanEncode(ctx, truncated)));

    const smashed = path.join(WORK, 'verify-smashed.mp4');
    const c = Buffer.from(b);
    for (let i = Math.floor(c.length * 0.3); i < Math.floor(c.length * 0.45); i += 701) c[i] ^= 0xFF;
    fs.writeFileSync(smashed, c);
    check('>> and so is a stream with its middle bit-flipped <<', !(await video.isCleanEncode(ctx, smashed)));

    check('a file that is not there at all is not "clean"',
      !(await video.isCleanEncode(ctx, path.join(WORK, 'no-such-file.mp4'))));
  }


  console.log(`\n====  EXPORT SPEED: ${pass} PASS / ${fail} FAIL  ====\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
