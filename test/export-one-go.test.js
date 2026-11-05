'use strict';
/*
 * ONE ENCODE FOR THE PICTURE, THE CAPTIONS AND THE TEXT.
 *
 *   "Someone gave a feedback that exporting videos take way too long."
 *
 * A captioned short was made twice: the picture encoded to a file, then that
 * whole file decoded and encoded again only to lay the captions on it. Now the
 * export lays them on in its own encode (`burn`, see video.encodeWithFallback).
 * That is only worth having if the file is the SAME file the two passes made —
 * so every export route is made both ways here, with real ffmpeg, and compared:
 *
 *   [1] the same frames, the same length, the same sound
 *   [2] the captions and the text are really on it, in the same place at the
 *       same moment (SSIM in the caption band against the two-pass file, and
 *       against a file with nothing laid on, which must differ)
 *   [3] each route: a plain short, gaps closed, blurred fill, the speaker
 *       followed past the edge (the pad graph), a manual crop, the whole video
 *   [4] the plumbing: the inputs a trimmed clip's output cap `-t` must stay after
 *
 *   node test/export-one-go.test.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

let pass = 0, fail = 0;
const check = (name, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + d : '')); ok ? pass++ : fail++; };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-onego-'));
const SRC = path.join(WORK, 'service.mp4');

/* A picture with real alpha: boxes of colour on a transparent sheet. */
function png(file, W, H, boxes) {
  const zlib = require('zlib');
  const rows = [];
  for (let y = 0; y < H; y++) {
    const r = Buffer.alloc(1 + W * 4);
    for (const [x0, y0, w, h, c] of boxes) if (y >= y0 && y < y0 + h) for (let x = x0; x < Math.min(W, x0 + w); x++) Buffer.from(c).copy(r, 1 + x * 4);
    rows.push(r);
  }
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcT[n] = c >>> 0; }
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8; ih[9] = 6;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]));
  return fs.readFileSync(file);
}
const capA = png(path.join(WORK, 'a.png'), 400, 90, [[10, 10, 300, 70, [255, 230, 0, 235]], [30, 30, 120, 25, [0, 0, 0, 255]]]);
const capB = png(path.join(WORK, 'b.png'), 400, 90, [[90, 15, 290, 60, [255, 255, 255, 242]], [120, 35, 90, 20, [200, 0, 0, 255]]]);
const TXT = path.join(WORK, 'txt.png'); png(TXT, 432, 768, [[40, 80, 240, 60, [230, 20, 20, 204]], [60, 95, 80, 25, [255, 255, 255, 255]]]);
const TXTW = path.join(WORK, 'txtw.png'); png(TXTW, 854, 480, [[40, 40, 220, 50, [230, 20, 20, 204]], [60, 52, 80, 22, [255, 255, 255, 255]]]);

/* The caption track the studio would send: a gap, then lines one after another. */
const track = (dur) => {
  const frames = [{ png: null, dur: 0.4 }];
  let t = 0.4, k = 0;
  while (t < dur - 0.8) { frames.push({ png: k++ % 2 ? capB : capA, dur: 0.9 }); frames.push({ png: null, dur: 0.15 }); t += 1.05; }
  // drawn for a 432x768 frame: the export below is 480p, so it is laid on at its own size
  return { frames, band: { x: 16, y: 520, w: 400, h: 90 }, fps: 30, authorW: 432, authorH: 768 };
};
const texts = (wide) => [{ path: wide ? TXTW : TXT, start: 1, end: 3.5 }, { path: wide ? TXTW : TXT, start: 4, end: 6, anim: 'pop', cx: 0.4, cy: 0.15 }];

const probe = (f) => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,width,height,duration', '-of', 'json', f]).toString()).streams;
const ssim = (a, b, crop) => {
  const r = spawnSync(ffmpeg, ['-i', a, '-i', b, '-filter_complex', crop ? `[0:v]crop=${crop}[x];[1:v]crop=${crop}[y];[x][y]ssim` : '[0:v][1:v]ssim', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /All:([0-9.]+)/.exec(r.stderr || ''); return m ? Number(m[1]) : 0;
};

(async () => {
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-t', '12', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-t', '12', '-i', 'sine=frequency=330:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC]);

  head('[4] the plumbing');
  check('extra inputs go after the last input, before a trimmed clip\'s output cap',
    JSON.stringify(video._addInputs(['-ss', '2', '-i', 'v.mp4', '-t', '6'], ['-i', 'x.png'])) === JSON.stringify(['-ss', '2', '-i', 'v.mp4', '-i', 'x.png', '-t', '6']));
  {
    const dir = fs.mkdtempSync(path.join(WORK, 'g-'));
    const g = video._burnGraph({ track: video.writeTrackFrames(track(6), dir), images: texts(false).map((t) => Object.assign({}, t)), W: 432, H: 768, idx0: 2, base: 'vb', tfps: 30 });
    check('the caption strip is the first extra input, the text pictures after it', g.inputs === 3 && g.args.filter((a) => a === '-i').length === 3 && /^\[2:v\]/.test(g.steps.find((x) => /fps=30\[ov\]/.test(x)) || ''));
    check('the text goes on under the captions (the order the passes always ran in)', g.out === 'cap' && g.steps.findIndex((x) => /\[ov\]overlay/.test(x)) > g.steps.findIndex((x) => /\[tb1\]/.test(x)));
    check('nothing to lay on: nothing added', video._burnGraph({ track: null, images: [], W: 10, H: 10, idx0: 1, base: 'vb', tfps: 30 }).any === false);
  }

  const routes = [
    { name: 'a plain short', fn: 'exportShort', a: { startSec: 2, endSec: 9, preset: 'reel-9x16', quality: '480p' } },
    { name: 'gaps closed', fn: 'exportShort', a: { startSec: 2, endSec: 10, preset: 'reel-9x16', quality: '480p', pieces: [{ start: 2, end: 5 }, { start: 6, end: 10 }] } },
    { name: 'blurred fill, with fades', fn: 'exportShort', a: { startSec: 2, endSec: 9, preset: 'reel-9x16', quality: '480p', fill: { mode: 'blur' }, fadeIn: 0.4, fadeOut: 0.6 } },
    { name: 'the speaker followed past the edge', fn: 'exportShortReframed', a: { startSec: 2, endSec: 9, preset: 'reel-9x16', quality: '480p', keyframes: [{ t: 0, x: 60 }, { t: 3, x: 640 }, { t: 6, x: 1240 }] } },
    { name: 'the speaker followed, gaps closed', fn: 'exportShortReframed', a: { startSec: 2, endSec: 10, preset: 'reel-9x16', quality: '480p', keyframes: [{ t: 0, x: 500 }, { t: 6, x: 800 }], pieces: [{ start: 2, end: 5 }, { start: 6, end: 10 }] } },
    { name: 'a manual crop', fn: 'exportShortFramed', a: { startSec: 2, endSec: 9, preset: 'reel-9x16', quality: '480p', zoom: 1.3, offsetX: 0.45, offsetY: 0.5 } },
    { name: 'the whole video, its own shape', fn: 'exportShort', wide: true, a: { startSec: 0, endSec: 7, preset: 'source', quality: '480p' } },
  ];
  for (const r of routes) {
    head(`[1-3] ${r.name}`);
    const bare = path.join(WORK, 'bare.mp4'), old = path.join(WORK, 'old.mp4'), now = path.join(WORK, 'new.mp4');
    try {
      await video[r.fn](ctx, Object.assign({ input: SRC, output: bare }, r.a));
      const info = await video.getInfo(ctx, bare);
      const tk = (W, H) => Object.assign(track(info.durationSec), r.wide ? { band: { x: 30, y: 330, w: 400, h: 90 }, authorW: 854, authorH: 480 } : {}, { authorW: r.wide ? 854 : 432, authorH: r.wide ? 480 : 768 });
      await video.burnCaptionTrack(ctx, { input: bare, track: tk(), output: old, images: texts(r.wide) });
      const dir = fs.mkdtempSync(path.join(WORK, 'b-'));
      await video[r.fn](ctx, Object.assign({ input: SRC, output: now, burn: { track: video.writeTrackFrames(tk(), dir), images: texts(r.wide) } }, r.a));
      const po = probe(old), pn = probe(now);
      const V = (p) => p.find((s) => s.codec_type === 'video'), A = (p) => p.find((s) => s.codec_type === 'audio');
      check('the same size', V(po).width === V(pn).width && V(po).height === V(pn).height, `${V(po).width}x${V(po).height} vs ${V(pn).width}x${V(pn).height}`);
      check('the same frames', V(po).nb_read_frames === V(pn).nb_read_frames, `${V(po).nb_read_frames} vs ${V(pn).nb_read_frames}`);
      check('the same sound, as long', !!A(pn) && Math.abs(Number(A(po).duration) - Number(A(pn).duration)) < 0.05, `${A(po) && A(po).duration} vs ${A(pn) && A(pn).duration}`);
      const W = V(pn).width, H = V(pn).height, k = W / (r.wide ? 854 : 432);
      const band = r.wide ? `${Math.round(400 * k)}:${Math.round(90 * k)}:${Math.round(30 * k)}:${Math.round(330 * k)}` : `${Math.round(400 * k)}:${Math.round(90 * k)}:${Math.round(16 * k)}:${Math.round(520 * k)}`;
      const same = ssim(old, now, band), whole = ssim(old, now), without = ssim(bare, now, band);
      check('>> the captions land where the two passes put them, when they did <<', same > 0.97, `band SSIM ${same}`);
      check('…and the whole picture matches', whole > 0.97, `SSIM ${whole}`);
      check('…and they are really there (a file without them differs)', without < same - 0.02, `with ${same} vs without ${without}`);
    } catch (e) { check('made both ways', false, e.stack || e.message); }
  }

  /*
   * [5] Studio sound: the voice cleaned BESIDE the picture (voiceAlongside), not
   * before it — the same sound, bit for bit, and the same picture.
   */
  for (const r of [routes[0], routes[1], routes[3]]) {
    head(`[5] studio sound beside the picture: ${r.name}`);
    const first = path.join(WORK, 'v1.mp4'), beside = path.join(WORK, 'v2.mp4');
    try {
      const a = Object.assign({}, r.a, { denoise: 'studio' });
      process.env.MW_VOICE_FIRST = '1';
      await video[r.fn](ctx, Object.assign({ input: SRC, output: first }, a));
      delete process.env.MW_VOICE_FIRST;
      const seen = [];
      await video[r.fn](ctx, Object.assign({ input: SRC, output: beside, onProgress: (p) => seen.push(p) }, a));
      const md5 = (f) => execFileSync(ffmpeg, ['-v', 'error', '-i', f, '-map', '0:a', '-f', 'md5', '-']).toString().trim();
      const V = (f) => probe(f).find((x) => x.codec_type === 'video').nb_read_frames;
      check('>> the same cleaned sound, bit for bit <<', md5(first) === md5(beside));
      check('…under the same picture', V(first) === V(beside) && ssim(first, beside) > 0.99, `${V(first)} vs ${V(beside)} frames`);
      check('…and the bar only went forward', seen.length > 2 && seen.every((p, i) => !i || p >= seen[i - 1]), seen.join(','));
    } catch (e) { delete process.env.MW_VOICE_FIRST; check('made both ways', false, e.stack || e.message); }
  }
  const left = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cws-part-'));
  check('nothing the voice-beside route made is left behind', !left.length, left.join(', '));

  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
function head(t) { console.log('\n' + t); }
