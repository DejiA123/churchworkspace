'use strict';
/*
 * "NOW MAKE THE SHORTS EXPORT FASTER TOO"
 *
 * Measured first, on a real 65-minute sermon and a real 90-second short:
 *
 *     sample the stills      15.9 s
 *     watch them (2 nets)    90.4 s     \  the processor
 *     build the camera path   0.4 s     /
 *     encode the short      185.6 s        the GPU's video engine
 *
 * Two things came out of that, and this suite is the proof of both.
 *
 * 1. THE ENCODE WAS NOT USING THE GPU AT ALL. On real footage the speaker walks
 *    to the edge of the frame, so nearly every face-tracked short takes the
 *    BLURRED-PAD branch of exportShortReframed — which was software-only on the
 *    strength of a note saying Quick Sync is flaky behind a multi-branch filter
 *    graph. That note was never re-tested. It is tested here, and the graph is
 *    also no longer blurring a full-size copy of a picture whose whole purpose
 *    is to be unrecognisable.
 *
 * 2. A BATCH RAN THE TWO HALVES STRICTLY ONE AFTER THE OTHER. They use
 *    different hardware, so each idled while the other worked. The next short is
 *    now watched while the current one encodes.
 *
 *   npx electron test/shorts-speed.test.js
 */
const { app, BrowserWindow } = require('electron');
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

const WORK = path.join(os.tmpdir(), 'mw-shorts-speed');
fs.mkdirSync(WORK, { recursive: true });
let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (t) => console.log('\n' + t);
const secs = (ms) => (ms / 1000).toFixed(1) + 's';

/* A little moving source, made once. */
function makeSrc(name, fps, w, h, dur) {
  const p = path.join(WORK, name);
  if (!fs.existsSync(p) || fs.statSync(p).size < 20000) {
    execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-t', String(dur), '-i', `testsrc2=s=${w}x${h}:r=${fps}`,
      '-f', 'lavfi', '-t', String(dur), '-i', 'sine=frequency=220:sample_rate=44100',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', p], { stdio: 'ignore' });
  }
  return p;
}

/* Record every ffmpeg the export runs, and optionally sabotage one. */
const realRun = ff.runFfmpeg;
let runs = [];
let breakEncoder = null;     // e.g. 'h264_qsv' — make that codec fail
function spy() {
  runs = [];
  ff.runFfmpeg = async (bin, args, opts) => {
    const enc = args.includes('-c:v') ? args[args.indexOf('-c:v') + 1] : '(no video)';
    runs.push({ enc, args });
    if (breakEncoder && enc === breakEncoder) throw new Error('pretend ' + enc + ' is not available here');
    return realRun(bin, args, opts);
  };
}
function unspy() { ff.runFfmpeg = realRun; breakEncoder = null; }

app.whenReady().then(async () => {
  /* ================================================================== */
  head('[1] The blurred pad: the branch a real face-tracked short takes');
  const SRC = makeSrc('walk-30fps.mp4', 30, 640, 360, 4);
  const info = await video.getInfo(ctx, SRC);
  const targetAR = 9 / 16;
  const cropW = Math.round(info.height * targetAR / 2) * 2;
  const maxX = info.width - cropW;
  /*
   * Keyframes that walk the camera PAST the left edge. This is not a contrived
   * case — it is what the measured sermon does, and it is why the pad branch
   * exists: a plain crop would pin at the boundary and leave the speaker
   * jammed against the side of the finished short.
   */
  const over = [];
  for (let t = 0; t <= 4; t += 0.25) over.push({ t, x: Math.round(cropW / 2 - 60 + 40 * Math.sin(t)) });
  const wanted = over.map((k) => Math.round(k.x - cropW / 2));
  check('the test case really does overshoot the edge',
    Math.min(...wanted) < 0, `wants x=${Math.min(...wanted)}, floor is 0`);

  {
    spy();
    const out = path.join(WORK, 'pad-hw.mp4');
    const t0 = Date.now();
    await video.exportShortReframed(ctx, { input: SRC, startSec: 0, endSec: 4,
      preset: 'reel-9x16', quality: '720p', keyframes: over, output: out });
    const ms = Date.now() - t0;
    unspy();
    const first = runs[0] || {};
    const wantHw = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_qsv';
    check('>> it asks for the GPU FIRST (it never used to ask at all) <<',
      first.enc === wantHw, `first run was ${first.enc}  (${secs(ms)})`);
    check('…and the file it produced decodes clean', await video.isCleanEncode(ctx, out));
    const o = await video.getInfo(ctx, out);
    check('…at the shape that was asked for', o.width === 720 && o.height === 1280, `${o.width}x${o.height}`);
  }

  {
    // A machine with no working hardware encoder must still get its short.
    spy();
    breakEncoder = process.platform === 'darwin' ? 'h264_videotoolbox' : 'h264_qsv';
    const out = path.join(WORK, 'pad-sw.mp4');
    await video.exportShortReframed(ctx, { input: SRC, startSec: 0, endSec: 4,
      preset: 'reel-9x16', quality: '720p', keyframes: over, output: out });
    const encoders = runs.map((r) => r.enc);
    unspy();
    check('>> when the GPU refuses, software still produces the short <<',
      encoders.includes('libx264') && fs.existsSync(out) && fs.statSync(out).size > 10000,
      encoders.join(' -> '));
    check('…and that file decodes clean too', await video.isCleanEncode(ctx, out));
  }

  head('[1b] …and the pad branch no longer halves a 60fps recording');
  {
    /*
     * `-r 30` was hard-coded in this branch — the same bug that once halved
     * every 60fps export on the main path (see export-quality). The plain crop
     * has taken the source rate for a long time; the pad branch never did, so a
     * 60fps recording lost half its frames the moment the speaker walked wide.
     */
    const SRC60 = makeSrc('walk-60fps.mp4', 60, 640, 360, 3);
    const k = [];
    for (let t = 0; t <= 3; t += 0.25) k.push({ t, x: Math.round(cropW / 2 - 60) });
    const out = path.join(WORK, 'pad-60.mp4');
    await video.exportShortReframed(ctx, { input: SRC60, startSec: 0, endSec: 3,
      preset: 'reel-9x16', quality: '720p', keyframes: k, output: out });
    const o = await video.getInfo(ctx, out);
    check('>> a 60fps recording comes out at 60fps, not 30 <<', Math.round(o.fps) === 60, `${o.fps}fps`);
  }

  head('[2] Blurring a SMALL copy is the same picture, and faster');
  {
    /*
     * The pad is a blurred copy of the frame, widened so the crop can follow the
     * speaker past the edge. A 24px-radius blur has already destroyed everything
     * finer than 24px, so doing it at a quarter scale costs a sixteenth of the
     * pixels and lands in the same place. What must be true is that the picture
     * does not change — and it barely can, because the untouched frame is
     * overlaid ON TOP of the blur; only the padding either side differs at all.
     */
    const P = 148, padW = info.width + 2 * P;
    const graph = (bg) => `[0:v]split=2[bgs][fgs];[bgs]${bg}[bg];`
      + `[bg][fgs]overlay=${P}:0,crop=${cropW}:${info.height}:x=0:y=0,scale=720:1280:flags=lanczos,setsar=1,format=yuv420p[v]`;
    const full = `scale=${padW}:-2,crop=${padW}:${info.height},`
      + `boxblur=luma_radius=24:luma_power=2:chroma_radius=12:chroma_power=2,eq=brightness=-0.06`;
    const small = `scale=${Math.round(padW / 4 / 2) * 2}:-2,`
      + `boxblur=luma_radius=6:luma_power=2:chroma_radius=3:chroma_power=2,`
      + `scale=${padW}:-2:flags=bilinear,crop=${padW}:${info.height},eq=brightness=-0.06`;
    const render = (name, bg) => {
      const out = path.join(WORK, name + '.mp4');
      spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', SRC,
        '-filter_complex', graph(bg), '-map', '[v]', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', out], { encoding: 'utf8', maxBuffer: 1 << 26 });
      return out;
    };
    const a = render('bg-full', full), b = render('bg-small', small);
    const r = spawnSync(ffmpeg, ['-hide_banner', '-i', b, '-i', a,
      '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const psnr = parseFloat((String(r.stderr).match(/PSNR[^\n]*average:([\d.]+)/) || [])[1] || '0');
    check('>> the small copy is not a different picture <<', psnr > 38, `PSNR ${psnr.toFixed(1)} dB`);

    /*
     * Time the BACKGROUND BRANCH on its own, not the whole render.
     *
     * Timed inside the full graph this measurement is worthless: the branch that
     * changed is a fraction of a pipeline whose lanczos upscale and x264 encode
     * are unchanged and dominate, and on a four-second clip the run-to-run
     * scatter is larger than the whole effect. (It was written that way first,
     * and duly reported a 2.0s-vs-1.5s "regression" for a change that is 2-7x
     * faster at every size when you measure the thing you altered.) One warm-up
     * run, because the first decode of a file pays for reading it off the disk.
     */
    const branch = (bg) => {
      const t0 = Date.now();
      spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', SRC,
        '-filter_complex', `[0:v]${bg}[v]`, '-map', '[v]', '-an', '-f', 'null', '-'],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
      return Date.now() - t0;
    };
    branch(full);
    const tFull = branch(full), tSmall = branch(small);
    console.log(`    blur branch: full-size ${secs(tFull)}   small copy ${secs(tSmall)}`
      + `   ${(tFull / Math.max(1, tSmall)).toFixed(2)}x`);
    check('>> and blurring the small copy really is cheaper <<', tSmall < tFull,
      `${secs(tSmall)} vs ${secs(tFull)}`);
  }

  /* ================================================================== */
  head('[3] A batch is a pipeline: the next short is watched while this one encodes');
  {
    const win = new BrowserWindow({ show: false, width: 1200, height: 800,
      webPreferences: { preload: path.join(ROOT, 'src/main/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    await win.loadFile(path.join(ROOT, 'src/renderer/index.html'));
    await new Promise((r) => setTimeout(r, 1400));
    const js = (src) => win.webContents.executeJavaScript(
      `(async () => { try { ${src} } catch (e) { return { __error: e.message + '\\n' + e.stack }; } })()`);

    const R = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const log = [];
      const items = ['a', 'b', 'c'];
      let inFlight = 0, everTwo = false;
      const la = mk(items, async (it) => {
        inFlight++; if (inFlight > 1) everTwo = true;
        log.push('prep ' + it + ' start');
        await sleep(120);
        log.push('prep ' + it + ' end');
        inFlight--;
        return 'KF:' + it;
      });
      const got = [];
      let waited = 0;
      for (let i = 0; i < items.length; i++) {
        const v = await la.take(items[i], (p) => { waited++; return p; });
        got.push(v);
        if (i + 1 < items.length) la.begin(items[i + 1]);
        log.push('work ' + items[i] + ' start');
        await sleep(200);                       // the "encode"
        log.push('work ' + items[i] + ' end');
      }
      la.stop();
      return { got, log, everTwo, waited };
    `);
    if (R && R.__error) { check('the pipeline ran', false, R.__error); }
    else {
      check('>> every short gets ITS OWN camera path, never another\'s <<',
        JSON.stringify(R.got) === JSON.stringify(['KF:a', 'KF:b', 'KF:c']), JSON.stringify(R.got));
      check('>> never two trackers at once <<', R.everTwo === false);
      const bStart = R.log.indexOf('prep b start'), aWorkEnd = R.log.indexOf('work a end');
      check('>> the next short is tracked DURING this one\'s encode <<',
        bStart >= 0 && aWorkEnd >= 0 && bStart < aWorkEnd, R.log.join(' | '));
      const bEnd = R.log.indexOf('prep b end');
      check('…so by the time its turn comes it is already done', bEnd >= 0 && bEnd < aWorkEnd);
      check('…and the operator is only made to wait for the FIRST one', R.waited === 1, `waited ${R.waited}x`);
    }

    const F = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const la = mk(['x', 'y'], async (it) => { if (it === 'x') throw new Error('tracking blew up'); return 'KF:' + it; });
      const first = await la.take('x');
      la.begin('y');
      const second = await la.take('y');
      return { first, second };
    `);
    check('>> a look-ahead that BREAKS yields nothing, and does not break the batch <<',
      F && F.first === null && F.second === 'KF:y', JSON.stringify(F));

    const S = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let told = false, started = 0;
      const la = mk(['p', 'q'], async (it, cancelled) => {
        started++;
        await sleep(40);                       // "sampling the stills" — cannot be interrupted
        if (cancelled && cancelled()) { told = true; return null; }   // so the LONG half is skipped
        return 'KF:' + it;
      });
      await sleep(15);                 // let it genuinely get going first
      la.stop();                       // the operator pressed Stop
      const v = await la.take('p');
      la.begin('q');                   // must not start anything new
      await sleep(80);
      return { told, started, v, busy: la.busy };
    `);
    check('>> after Stop, a tracker in flight is told to give up <<',
      S && S.told === true && S.started === 1, JSON.stringify(S));
    check('>> …and no new one is started after Stop <<',
      S && S.started === 1 && S.busy === false, JSON.stringify(S));

    const S2 = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let started = 0;
      const la = mk(['p'], async () => { started++; return 'KF'; });
      la.stop();                       // stopped before it even got off the ground
      await sleep(30);
      return { started, v: await la.take('p') };
    `);
    check('…and one stopped before it starts never runs at all', S2 && S2.started === 0, JSON.stringify(S2));

    const T = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const la = mk(['only'], async () => 'KF');
      await new Promise(r => setTimeout(r, 30));       // let it finish
      let called = false;
      const v = await la.take('only', (p) => { called = true; return p; });
      return { v, called };
    `);
    check('an ALREADY-FINISHED look-ahead shows no progress step (it would only flicker)',
      T && T.v === 'KF' && T.called === false, JSON.stringify(T));

    const U = await js(`
      const mk = window.VideoEditor.__test.makeLookAhead;
      const la = mk(['a'], async () => 'KF:a');
      return { mismatched: await la.take('SOMETHING-ELSE') };
    `);
    check('a clip never receives a camera path built for a different clip',
      U && U.mismatched === null, JSON.stringify(U));

    win.destroy();
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  app.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(1); });
