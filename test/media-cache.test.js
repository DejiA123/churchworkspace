'use strict';
/*
 * THE PICTURES "CARRY ON" NO LONGER REBUILDS (v2.80).
 *
 * The filmstrip, waveform and HEVC preview depend only on the recording, so
 * they are kept per file. This proves the promise and its edges:
 *
 *   - the second ask for the same file is the kept file, and nothing is built
 *   - a re-saved recording (new size / time) is built again, never served stale
 *   - two asks at once build ONCE
 *   - a build that dies leaves nothing behind that could be served later
 *   - a different kind (strip vs waveform) is a different file
 *
 *   node test/media-cache.test.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const mc = require('../src/main/media-cache');

let failed = false;
const log = (okv, name, d) => { console.log((okv ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + d : '')); if (!okv) failed = true; };

const WORK = path.join(os.tmpdir(), 'mw-media-cache-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const CACHE = path.join(WORK, 'cache');
const SRC = path.join(WORK, 'sermon.mp4');
fs.writeFileSync(SRC, 'pretend this is two gigabytes of sermon');

(async () => {
  mc.init(CACHE);
  let builds = 0;
  const build = (body) => async (out) => { builds++; await new Promise((r) => setTimeout(r, 60)); fs.writeFileSync(out, body); };

  const a = await mc.cached(SRC, 'strip24', '.png', build('strip-1'));
  log(builds === 1 && fs.readFileSync(a, 'utf8') === 'strip-1', 'the first ask builds it');
  const t0 = Date.now();
  const b = await mc.cached(SRC, 'strip24', '.png', build('strip-2'));
  log(builds === 1 && b === a && fs.readFileSync(b, 'utf8') === 'strip-1', 'the second ask is the kept file — nothing built', (Date.now() - t0) + ' ms');

  const w = await mc.cached(SRC, 'wave1600x100', '.png', build('wave'));
  log(builds === 2 && w !== a, 'a waveform is not mistaken for the filmstrip');

  // the operator re-exports over the same name: same path, different file
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(SRC, 'a DIFFERENT, longer recording saved over the same name');
  const c = await mc.cached(SRC, 'strip24', '.png', build('strip-3'));
  log(builds === 3 && fs.readFileSync(c, 'utf8') === 'strip-3', 'a re-saved recording is built again, never served stale');

  // two asks at once (the studio and a re-render racing)
  const before = builds;
  const [p, q] = await Promise.all([
    mc.cached(SRC, 'proxy', '.mp4', build('proxy')),
    mc.cached(SRC, 'proxy', '.mp4', build('proxy')),
  ]);
  log(builds === before + 1 && p === q, 'two asks at once build it ONCE', (builds - before) + ' builds');

  // a build that dies must leave nothing a later ask could serve
  let threw = false;
  try { await mc.cached(SRC, 'dies', '.png', async (out) => { fs.writeFileSync(out, 'half'); throw new Error('ffmpeg died'); }); } catch (e) { threw = true; }
  const left = fs.readdirSync(CACHE).filter((f) => /\.part\./.test(f));
  log(threw && left.length === 0, 'a build that dies throws, and leaves no half-file behind', JSON.stringify(left));
  const after = await mc.cached(SRC, 'dies', '.png', build('ok now'));
  log(fs.readFileSync(after, 'utf8') === 'ok now', '…so the next ask builds it properly');

  // what ffprobe says about the file: asked once per file, even across a restart
  let probes = 0;
  const probe = async () => { probes++; return { durationSec: 10434.7, width: 1280, n: probes }; };
  const i1 = await mc.json(SRC, 'info-x', probe);
  mc.init(CACHE); // a restart
  const i2 = await mc.json(SRC, 'info-x', probe);
  log(probes === 1 && i2.n === 1 && i2.durationSec === i1.durationSec, 'the probe result is kept across a restart — ffprobe is not started again', probes + ' probes');
  const i3 = await mc.json(SRC, 'info-y', probe);
  log(probes === 2 && i3.n === 2, 'a different shape of answer (getInfo changed) asks again');
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(SRC, 'and saved over once more, different length again!!');
  const i4 = await mc.json(SRC, 'info-x', probe);
  log(probes === 3 && i4.n === 3, 'a re-saved recording is probed again');

  // and in memory, inside video.getInfo itself: the real ffprobe, on a real file
  const video = require('../src/main/video');
  const ffmpeg = require('ffmpeg-static'), ffprobe = require('ffprobe-static').path;
  const REAL = path.join(WORK, 'real.mp4');
  require('child_process').execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', REAL]);
  let t = Date.now(); const g1 = await video.getInfo({ ffmpeg, ffprobe }, REAL); const cold = Date.now() - t;
  t = Date.now(); const g2 = await video.getInfo({ ffmpeg, ffprobe }, REAL); const warm = Date.now() - t;
  g2.width = 1; // a caller scribbling on its answer must not change the next one
  const g3 = await video.getInfo({ ffmpeg, ffprobe }, REAL);
  log(g1.width === 320 && Math.abs(g1.durationSec - 3) < 0.1 && warm < 20 && warm < cold, `video.getInfo asks ffprobe once per file (${cold} ms, then ${warm} ms)`);
  log(g3.width === 320, '…and hands each caller its own copy');

  // a month unused is cleared when the app starts
  const old = await mc.cached(SRC, 'old', '.png', build('old'));
  const longAgo = new Date(Date.now() - 40 * 86400e3);
  fs.utimesSync(old, longAgo, longAgo);
  mc.init(CACHE);
  log(!fs.existsSync(old) && fs.existsSync(after), 'what has not been used for a month is cleared at start-up; the rest stays');

  fs.rmSync(WORK, { recursive: true, force: true });
  console.log('\n==================  media-cache ' + (failed ? 'FAILED' : 'PASSED') + '  ==================');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
