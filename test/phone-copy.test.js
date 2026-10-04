'use strict';
/*
 * A VIDEO TOO BIG FOR THE iPHONE'S SHARE SHEET GETS A COPY THAT FITS.
 *
 * Safari reads a shared file whole into memory, so a 500 MB montage got the
 * app killed (white screen, then a blank share card). phonecopy.js hands the
 * phone at most PART_MAX at a time: one re-encoded video whenever it can look
 * right, numbered parts only for a very long one.
 *
 * The plan is checked on real-sized numbers; then the copies are made for
 * real on a small video with a small PART_MAX, and each must be under it,
 * play from start to end, and together last as long as the original.
 *
 *   node test/phone-copy.test.js
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
const pc = require('../src/main/phonecopy');

const ctx = { ffmpeg, ffprobe };
const WORK = path.join(os.tmpdir(), 'mw-phone-copy');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
let failed = false;
const log = (ok, name, detail) => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? '  -> ' + detail : ''));
  if (!ok) failed = true;
};
const MB = 1024 * 1024;

function plans() {
  console.log('The plan');
  // a 4-minute 1080×1920 montage at 20 Mbit/s (≈ 600 MB): one full-HD video
  let p = pc.plan({ size: 600 * MB, durationSec: 240, width: 1080, height: 1920 });
  log(p.how === 'encode' && p.parts === 1 && p.side === 1080 && p.kbps >= 2500, '4-min 600 MB montage → one 1080p video', JSON.stringify(p));
  log((p.kbps + 128) * 1000 * 240 / 8 < pc.PART_MAX, '   …that fits under the share limit', `${Math.round((p.kbps + 128) * 240 / 8 / 1024)} MB`);
  // 7 minutes: one 1080p video
  p = pc.plan({ size: 900 * MB, durationSec: 420, width: 1920, height: 1080 });
  log(p.how === 'encode' && p.parts === 1 && p.side === 1080, '7-min 900 MB video → one 1080p video', JSON.stringify(p));
  // the 8:46 montage that came out in two parts: now one video
  p = pc.plan({ size: 700 * MB, durationSec: 526, width: 1080, height: 1920 });
  log(p.how === 'encode' && p.parts === 1 && p.side === 1080, '8:46 montage → ONE 1080p video', JSON.stringify(p));
  p = pc.plan({ size: 1500 * MB, durationSec: 15 * 60, width: 1080, height: 1920 });
  log(p.parts === 1 && p.side === 1080, '15-min montage → still one 1080p video', JSON.stringify(p));
  // an hour at 15 Mbit/s: 1080p parts, each under the limit
  p = pc.plan({ size: 6500 * MB, durationSec: 3600, width: 1920, height: 1080 });
  const each = (p.kbps + 128) * 1000 * p.segSec / 8;
  log(p.how === 'encode' && p.parts > 1 && each < pc.PART_MAX, '1-hour video → 1080p parts under the limit', `${p.parts} parts of ~${Math.round(each / MB)} MB`);
  // an hour already at 2 Mbit/s: cut, not re-encoded
  p = pc.plan({ size: 900 * MB, durationSec: 3600, width: 1920, height: 1080 });
  log(p.how === 'copy' && p.parts >= 5, '1-hour lean video → cut by stream copy', JSON.stringify(p));
}

const dur = (f) => Number(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
const plays = (f) => { try { execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', f, '-f', 'null', '-'], { stdio: 'pipe' }); return true; } catch (e) { return false; } };

async function real() {
  console.log('Making copies');
  // 20 s of 1080×1920 noise at a high bit rate (noise does not compress)
  const src = path.join(WORK, 'montage-test.mp4');
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=1080x1920:r=30:d=20,geq=random(1)*255:128:128',
    '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', src]);
  const size = fs.statSync(src).size;
  const d0 = dur(src);
  console.log(`  source: ${Math.round(size / MB)} MB, ${d0.toFixed(1)} s`);

  // small enough already: handed over as it is
  let r = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: size + 1 });
  log(r.parts.length === 1 && r.parts[0].path === src, 'a video under the limit is shared as it is');

  // one re-encoded video: a limit that leaves ~3.5 Mbit/s for 20 s
  const one = Math.round(((3600 + 128) * 1000 * 20) / 8 / 0.92);
  let pcts = [];
  r = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: one, onProgress: (q) => pcts.push(q) });
  log(r.parts.length === 1 && r.made === 'encode', 'too big → ONE phone copy', JSON.stringify(r.parts.map((x) => Math.round(x.size / 1024) + ' KB')));
  log(r.parts[0].size <= one, '   …under the limit', `${r.parts[0].size} ≤ ${one}`);
  log(plays(r.parts[0].path) && Math.abs(dur(r.parts[0].path) - d0) < 0.5, '   …plays through, full length');
  log(pcts.length > 0 && pcts[pcts.length - 1] === 100, '   …with progress to 100%');
  log(r.parts[0].path.includes(path.sep + '.phone' + path.sep), '   …kept in .phone/, out of the file list');
  const again = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: one });
  log(again.parts[0].path === r.parts[0].path, 'a second tap reuses the copy');

  // the quicker 720p copy, asked for on the phone — kept beside the 1080p one
  const hdPath = r.parts[0].path;
  let stt = pc.status(src, one);
  log(stt.needed && stt.hd.ready && !stt.fast.ready, 'status: 1080p ready, 720p not yet', JSON.stringify(stt));
  const t0 = Date.now();
  const fastR = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: one, quality: 'fast' });
  const wh = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', fastR.parts[0].path]).toString().trim();
  log(fastR.parts.length === 1 && wh === '720,1280' && fastR.parts[0].size <= one, '720p copy: one video, 720×1280, under the limit', `${wh}, ${Math.round(fastR.parts[0].size / 1024)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  log(plays(fastR.parts[0].path), '   …plays through');
  stt = pc.status(src, one);
  log(stt.hd.ready && stt.fast.ready && fs.existsSync(hdPath), '   …and the 1080p copy is still there');
  log(pc.status(src, size + 1).needed === false, 'status: a small video needs no copy');

  // a limit so small not even 1 Mbit/s fits in one: parts
  const tiny = Math.round(((600 + 128) * 1000 * 20) / 8 / 0.92);
  r = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: tiny });
  const total = r.parts.reduce((a, x) => a + dur(x.path), 0);
  log(r.parts.length > 1, 'a very long video → parts', `${r.parts.length} parts`);
  log(r.parts.every((x) => x.size <= tiny), '   …each under the limit', r.parts.map((x) => Math.round(x.size / 1024) + ' KB').join(', '));
  log(r.parts.every((x) => plays(x.path)) && Math.abs(total - d0) < 1, '   …each plays, together full length', `${total.toFixed(1)} s`);

  // the copy started when the montage finished, joined by a Save tap: one job, progress for both
  pc.removeFor(src);
  const first = pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: one });
  await new Promise((res) => setTimeout(res, 300));
  pcts = [];
  const joined = await pc.phoneCopy(ctx, video.getInfo, { input: src, partMax: one, onProgress: (q) => pcts.push(q) });
  const firstGot = await first;
  log(joined.parts[0].path === firstGot.parts[0].path && pcts.length > 1 && pcts[pcts.length - 1] === 100,
    'Save tapped while the copy is being made joins it, with progress', `${pcts.length} readings`);

  const freed = pc.removeFor(src);
  const left = fs.readdirSync(path.join(WORK, '.phone')).filter((n) => n.startsWith('montage-test'));
  log(freed > 0 && left.length === 0, 'deleting the video clears its phone copies');
}

(async () => {
  plans();
  await real();
  console.log(failed ? '\nFAILED' : '\nAll passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
