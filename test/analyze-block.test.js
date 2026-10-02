'use strict';
/*
 * DOES "FIND SERMON HIGHLIGHTS" FREEZE THE WHOLE APP?
 *
 * The other freeze tests measure the renderer, because that is where a studio's
 * own controls live. This one measures the MAIN process, because that is what
 * every window shares: while main is inside a synchronous stretch of work, the
 * studio, the projector, the stage monitor and the streaming pipeline are all
 * equally unable to do anything.
 *
 * analyzeSermon() is the one piece of heavy computation this app does on main
 * rather than in a child process. ffmpeg decodes the audio (a child process, so
 * free), but everything after that — the loudness envelope, the percentile sort,
 * speech classification, segmentation, scoring and selection — is straight-line
 * JavaScript over a 90-minute recording. Nothing in it yields.
 *
 * So: run it on a REAL recording with a heartbeat running, and report the
 * longest stretch main was unavailable. The threshold is generous on purpose —
 * this is a deliberate, progress-barred action a person waits for. What it must
 * not do is stop the projector for seconds at a time, because on a Sunday this
 * button gets pressed while the service is still running.
 *
 *   MW_SERMON=<file> npx electron test/analyze-block.test.js
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ff = require(path.join(ROOT, 'src/main/ffmpeg'));
const highlights = require(path.join(ROOT, 'src/main/highlights'));

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  -> ' + d : '')); c ? pass++ : fail++; };
const ms = (n) => Math.round(n) + ' ms';

/* Candidate recordings, longest first — a long one is the point. */
function pickInput() {
  if (process.env.MW_SERMON && fs.existsSync(process.env.MW_SERMON)) return process.env.MW_SERMON;
  const dir = 'C:/Users/dejia/Videos';
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp4|mkv|mov)$/i.test(f)) continue;
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      // big enough to be a service, small enough not to spend all night decoding
      if (st.size < 80e6 || st.size > 1.6e9) continue;
      if (!best || st.size > best.size) best = { p, size: st.size };
    }
  } catch (e) {}
  return best && best.p;
}

/* main-process heartbeat: a 10 ms timer that reports how late it actually ran */
const meter = { on: false, all: [] };
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const late = now - last - 10;
  last = now;
  if (meter.on && late > 0) meter.all.push(late);
}, 10);
const start = () => { meter.all = []; last = Date.now(); meter.on = true; };
const stop = () => {
  meter.on = false;
  const a = meter.all.slice().sort((x, y) => x - y);
  const at = (q) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0);
  return { n: a.length, p50: at(0.5), p95: at(0.95), max: Math.round(a[a.length - 1] || 0),
           over1s: a.filter((x) => x > 1000).length };
};

app.whenReady().then(async () => {
  const input = pickInput();
  if (!input) {
    console.log('  SKIP — no suitable recording found. Set MW_SERMON=<file> to run this.');
    app.exit(0); return;
  }
  const ffmpeg = ff.resolveFfmpeg(), ffprobe = ff.resolveFfprobe();
  const info = await new Promise((res) => {
    const { execFile } = require('child_process');
    execFile(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', input],
      { maxBuffer: 8e6 }, (e, out) => { try { res(JSON.parse(out).format); } catch (er) { res({}); } });
  });
  const dur = Number(info.duration) || 0;
  console.log(`  recording: ${path.basename(input)}  (${(dur / 60).toFixed(1)} min, ${(fs.statSync(input).size / 1e6).toFixed(0)} MB)`);

  start();
  const t0 = Date.now();
  let out = null, err = null;
  try {
    out = await highlights.analyzeSermon({ ffmpeg, ffprobe }, {
      input, maxClips: 12, autoLen: true,
      onProgress: () => {},
    });
  } catch (e) { err = e; }
  const wall = Date.now() - t0;
  const m = stop();

  // analyzeSermon hands back an object, not a bare array — read the clips out
  // of whichever field carries them rather than printing "undefined clips".
  const clips = Array.isArray(out) ? out : (out && (out.clips || out.highlights || out.segments)) || null;
  if (err) console.log(`  analyze failed: ${err.message}`);
  else console.log(`  analysis produced ${clips ? clips.length : '?'} clips in ${(wall / 1000).toFixed(1)} s of wall time`);
  console.log(`  MAIN PROCESS blocked: p50 ${ms(m.p50)} · p95 ${ms(m.p95)} · worst ${ms(m.max)}   (stretches over 1 s: ${m.over1s})`);

  check('the analysis actually ran and produced clips',
    !err && !!clips && clips.length > 0, err ? err.message : `${clips ? clips.length : 0} clips`);
  /*
   * A person pressing this expects to wait, and a progress bar says so. What
   * must not happen is the rest of the app going with it: main is shared, so a
   * multi-second block here is a multi-second black projector and a stalled
   * stream. One second is already bad; anything past two is the complaint.
   */
  check('it never freezes the whole app for more than 2 s at a stretch',
    m.max < 2000, `worst ${ms(m.max)}`);
  check('and it does not do that repeatedly', m.over1s <= 1, `${m.over1s} stretches over 1 s`);

  console.log(`\n  ${pass} PASS / ${fail} FAIL`);
  app.exit(fail ? 1 : 0);
});
