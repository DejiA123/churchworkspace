'use strict';
/*
 * The streamed loudness envelope (extractEnvelope) must be the SAME envelope
 * the scan used to build from the whole sermon's samples
 * (buildEnvelope(extractPcm(...))) — figure for figure, not "close". If it ever
 * drifts, every cut the scanner places moves with it.
 *
 *   node test/envelope-stream.test.js [a long recording]
 *
 * Without an argument it makes its own recordings: a short one (one piece) and
 * a twenty-minute one (decoded in parallel pieces), with odd lengths and a
 * start offset so the piece seams and the last partial hop are both exercised.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpeg = require('ffmpeg-static');
const highlights = require('../src/main/highlights');
const { extractPcm, buildEnvelope, extractEnvelope } = highlights._internals;

const WORK = path.join(os.tmpdir(), 'mw-envelope-test');
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};

function make(name, sec) {
  const out = path.join(WORK, name);
  if (fs.existsSync(out)) return out;
  // speech-like: a tone whose loudness swings, with a near-silence every 7 s
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', `aevalsrc='0.6*sin(2*PI*180*t)*(0.5+0.5*sin(2*PI*0.13*t))*if(eq(mod(floor(t)\\,7)\\,6)\\,0.004\\,1)':s=44100:d=${sec}`,
    '-f', 'lavfi', '-i', `color=c=0x203040:s=320x180:r=5:d=${sec}`,
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '64k', out]);
  return out;
}

function same(a, b) {
  if (a.hops !== b.hops) return `hops ${a.hops} vs ${b.hops}`;
  for (let i = 0; i < a.hops; i++) {
    if (a.db[i] !== b.db[i] || a.rms[i] !== b.rms[i]) return `hop ${i}: ${a.db[i]} vs ${b.db[i]}`;
  }
  return '';
}

(async () => {
  const short = make('short.mp4', 93.7);
  const long = process.argv[2] || make('long.mp4', 1213.3);

  const cases = [
    ['a short recording, one piece', short, 0, null, {}],
    ['the same, from 11.35 s to 80 s', short, 11.35, 80, {}],
    ['a long recording, one piece', long, 0, 1213.3, { parallel: 1 }],
    ['…in two pieces at once', long, 0, 1213.3, { parallel: 2 }],
    ['…in four pieces at once', long, 0, 1213.3, { parallel: 4 }],
    ['…four pieces, from 7.4 s', long, 7.4, 1213.3, { parallel: 4 }],
  ];
  for (const [name, file, from, to, opts] of cases) {
    const old = buildEnvelope(await extractPcm(ffmpeg, file, from, to, opts));
    const neu = await extractEnvelope(ffmpeg, file, from, to, opts);
    const diff = same(old, neu);
    log(!diff, name + ' — identical envelope', diff || `${neu.hops} hops`);
  }

  // and it never holds the sound: measured as the heap's growth during the call
  global.gc && global.gc();
  const before = process.memoryUsage().arrayBuffers;
  let peak = before;
  const tick = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 20);
  await extractEnvelope(ffmpeg, long, 0, 1213.3, { parallel: 4 });
  clearInterval(tick);
  const grewMB = (peak - before) / 1048576;
  // twenty minutes of samples is 19 MB; the envelope itself is under 0.4 MB
  log(grewMB < 8, 'it never holds the recording in memory', `${grewMB.toFixed(1)} MB at most, against 19 MB of samples`);

  console.log(failed ? '\n❌ envelope test failed' : '\n✅ envelope test passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
