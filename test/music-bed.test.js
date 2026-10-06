'use strict';
/*
 * "When I add my own background music it sounds terrible — choppy."
 *
 * REAL mixes through the real mixMusic, decoded back out and measured. Nothing
 * here is listened to by a person, so every complaint is turned into a number:
 *
 *   [1] the sermon keeps its level — a bed under it used to make the SERMON
 *       6 dB quieter (amix halved every input)
 *   [2] the bed does not pump — the old ducking followed every syllable: 2.2 dB
 *       of movement every tenth of a second, up to 9 dB, under a real sermon
 *       …and ducking still ducks: the bed sits well under the preacher
 *   [3] a song shorter than the video loops without a hole — an iPhone's .m4a
 *       left ~20 ms of silence and a tick at every restart; and the temporary
 *       decode that fixes it is gone afterwards, Cancel included
 *   [4] the library keeps a browser-safe preview copy of every song (and the
 *       entry still points the export at the original); remove deletes both
 *
 *   node test/music-bed.test.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const jobs = require(path.join(ROOT, 'src/main/jobs'));
const library = require(path.join(ROOT, 'src/main/library'));
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const ctx = { ffmpeg, ffprobe };

const WORK = path.join(os.tmpdir(), 'mw-music-bed-test');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
library.init(WORK);

let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined ? '  -> ' + d : '')); ok ? pass++ : fail++; };
const ff = (args) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 30 });

/** A file's audio as mono 48 kHz floats, through an optional filter. */
function pcm(file, af) {
  const b = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:a:0', ...(af ? ['-af', af] : []), '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
}
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));
function rmsDb(x, from = 0, to = x.length) {
  let s = 0; for (let i = from; i < to; i++) s += x[i] * x[i];
  return db(Math.sqrt(s / Math.max(1, to - from)));
}
/** RMS in dB of each 100 ms window. */
function envelope(x) {
  const W = 4800, out = [];
  for (let i = 0; i + W <= x.length; i += W) out.push(rmsDb(x, i, i + W));
  return out;
}
const median = (a) => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };
const mean = (a) => a.reduce((p, q) => p + q, 0) / a.length;
/*
 * Where a looped 440 Hz tone breaks: holes (over 3 ms below −80 dB) and clicks
 * (a sample the tone could not have predicted: x[n+1] = 2cos(w)·x[n] − x[n−1]),
 * between the fade-in and the fade-out. Times in seconds.
 */
function loopFaults(file) {
  const x = pcm(file), sr = 48000;
  const from = Math.floor(1.1 * sr), to = x.length - Math.floor(1.4 * sr);
  const holes = [], clicks = []; let run = 0, amp = 0, last = -1e9;
  const c = 2 * Math.cos(2 * Math.PI * 440 / sr);
  for (let n = 1; n < x.length - 1; n++) {
    amp = Math.max(amp * 0.999, Math.abs(x[n]));
    if (n < from || n >= to) continue;
    if (Math.abs(x[n]) < 1e-4) run++;
    else { if (run > sr * 0.003) holes.push(`${((n - run) / sr).toFixed(3)} s (${(run / sr * 1000).toFixed(1)} ms)`); run = 0; }
    const e = x[n + 1] - c * x[n] + x[n - 1];
    if (amp > 0.005 && Math.abs(e) > 0.05 * amp && n - last > 240) { clicks.push(+(n / sr).toFixed(3)); last = n; }
  }
  return { holes, clicks };
}
const bedFiles = () => fs.readdirSync(os.tmpdir()).filter((f) => /^mw-bed-/.test(f));

(async () => {
  try {
    /* ---- the material: a real sermon, a steady tone as the "music" ---- */
    const FIX = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
    const SERMON = path.join(WORK, 'sermon.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=160x90:r=25', '-i', FIX, '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-shortest', SERMON]);
    // 11 kHz sits above all the speech we measure the voice by (lowpass 6 kHz),
    // and the speech has almost nothing up there — so each can be measured alone
    const TONE = path.join(WORK, 'tone-11k.wav');
    ff(['-f', 'lavfi', '-i', 'sine=f=11000:r=48000:d=30', '-ac', '2', TONE]);

    console.log('\n[1] The sermon comes out as loud as it went in');
    const flat = path.join(WORK, 'mix-flat.mp4'), ducked = path.join(WORK, 'mix-duck.mp4');
    await video.mixMusic(ctx, { input: SERMON, output: flat, musicPath: TONE, musicVolume: 0.25, duck: false });
    await video.mixMusic(ctx, { input: SERMON, output: ducked, musicPath: TONE, musicVolume: 0.25, duck: true });
    const voiceIn = rmsDb(pcm(SERMON, 'lowpass=f=6000,lowpass=f=6000'));
    const voiceFlat = rmsDb(pcm(flat, 'lowpass=f=6000,lowpass=f=6000'));
    const voiceDuck = rmsDb(pcm(ducked, 'lowpass=f=6000,lowpass=f=6000'));
    check(Math.abs(voiceFlat - voiceIn) < 1, 'with music under it, the sermon is within 1 dB of the original', `${voiceIn.toFixed(1)} → ${voiceFlat.toFixed(1)} dB (was −5.8 dB before the fix)`);
    check(Math.abs(voiceDuck - voiceIn) < 1, '…with ducking on too', `${voiceIn.toFixed(1)} → ${voiceDuck.toFixed(1)} dB`);
    let peak = 0; for (const v of pcm(ducked)) peak = Math.max(peak, Math.abs(v));
    check(peak <= 1.0, 'and it does not clip', peak.toFixed(3));

    console.log('\n[2] The bed does not pump — and still ducks');
    const band = 'bandpass=f=11000:width_type=h:w=200,bandpass=f=11000:width_type=h:w=200';
    const envD = envelope(pcm(ducked, band)).slice(20, 180);   // 2 s .. 18 s
    const envF = envelope(pcm(flat, band)).slice(20, 180);
    const steps = []; for (let i = 1; i < envD.length; i++) steps.push(Math.abs(envD[i] - envD[i - 1]));
    check(mean(steps) < 1.0, 'the bed moves under 1 dB per tenth of a second on average', `${mean(steps).toFixed(2)} dB (was 2.18)`);
    check(Math.max(...steps) < 7, 'and never jumps 7 dB in a tenth of a second', `${Math.max(...steps).toFixed(1)} dB (was 9.1)`);
    const depth = median(envF) - median(envD);
    check(depth >= 6, 'under the preacher the bed sits well down (≥ 6 dB)', `${depth.toFixed(1)} dB`);
    // the sermon's one long pause (≈ 10.6-12.2 s): the music comes back up in it
    const pauseLvl = Math.max(...envD.slice(100, 120));
    check(median(envF) - pauseLvl < 3, '…and comes back up in a real pause', `${(median(envF) - pauseLvl).toFixed(1)} dB under full`);

    console.log('\n[3] A short song loops without a hole');
    const SONG = path.join(WORK, 'song-8s.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=8', '-ac', '2', '-c:a', 'aac', '-b:a', '160k', SONG]);
    const QUIET = path.join(WORK, 'quiet-20s.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=10:d=20', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '20', QUIET]);
    const looped = path.join(WORK, 'looped.mp4');
    const before = bedFiles().length;
    await video.mixMusic(ctx, { input: QUIET, output: looped, musicPath: SONG, musicVolume: 0.5, fadeIn: 0.6, fadeOut: 1.2 });
    const m4a = loopFaults(looped);
    check(m4a.holes.length === 0, 'no hole of silence where an .m4a goes round (8 s, 16 s)', m4a.holes.join(', ') || 'none');
    // the last 11 ms of an AAC frame is the file's own (a real song ends in its
    // own tail anyway); everywhere else the tone must be untouched
    const mid = m4a.clicks.filter((t) => Math.abs(t - 8) > 0.04 && Math.abs(t - 16) > 0.04);
    check(mid.length === 0, 'and no click anywhere mid-song', mid.join(', ') || 'none');
    // a sample-exact loopable song (lossless, a whole number of cycles) must go
    // round with no seam at all: proof the decode-and-loop adds nothing of its own
    const FLAC = path.join(WORK, 'song-8s.flac');
    ff(['-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=8', '-ac', '2', FLAC]);
    const loopedFlac = path.join(WORK, 'looped-flac.mp4');
    await video.mixMusic(ctx, { input: QUIET, output: loopedFlac, musicPath: FLAC, musicVolume: 0.5, fadeIn: 0.6, fadeOut: 1.2 });
    const fl = loopFaults(loopedFlac);
    check(fl.holes.length === 0 && fl.clicks.length === 0, 'a seamless song loops with no hole and no click at all',
      `holes ${fl.holes.join(', ') || 'none'}; clicks ${fl.clicks.join(', ') || 'none'}`);
    const info = await video.getInfo(ctx, looped);
    check(Math.abs(info.durationSec - 20) < 0.15, 'the finished video is still 20 s long', info.durationSec.toFixed(2));
    check(bedFiles().length === before, 'the temporary decode of the song is cleaned up', bedFiles().join(', ') || 'none left');

    // a song that covers the clip is read straight from the file: no temp file at all
    const longSong = path.join(WORK, 'song-30s.m4a');
    ff(['-f', 'lavfi', '-i', 'sine=f=440:r=44100:d=30', '-ac', '2', '-c:a', 'aac', longSong]);
    let sawTemp = false;
    const watch = setInterval(() => { if (bedFiles().length > before) sawTemp = true; }, 2);
    await video.mixMusic(ctx, { input: QUIET, output: path.join(WORK, 'no-loop.mp4'), musicPath: longSong });
    clearInterval(watch);
    check(!sawTemp, 'a song long enough to cover the video is not decoded first');

    // Cancel while it works: the temp file must not be left behind
    const LONG = path.join(WORK, 'quiet-240s.mp4');
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=5:d=240', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-t', '240', LONG]);
    let cancelled = false, seen = false;
    const jid = 'music-bed-cancel';
    const poll = setInterval(() => { if (bedFiles().length > before) { seen = true; jobs.cancel(jid); } }, 1);
    try { await jobs.run(jid, () => video.mixMusic(ctx, { input: LONG, output: path.join(WORK, 'cancelled.mp4'), musicPath: SONG })); }
    catch (e) { cancelled = jobs.isCancelError ? jobs.isCancelError(e) : true; }
    clearInterval(poll);
    check(seen && cancelled, 'Cancel stops the music step', `saw temp=${seen} cancelled=${cancelled}`);
    check(bedFiles().length === before, '…and leaves no temporary song behind', bedFiles().join(', ') || 'none left');

    console.log('\n[4] The library keeps a preview copy the phone can play');
    const entry = await library.add(ctx, video, { kind: 'music', path: SONG, name: 'Worship bed' });
    check(entry.file && /\.m4a$/.test(entry.file) && fs.existsSync(entry.file), 'the song itself is kept as it came (the export mixes this one)', path.basename(entry.file || ''));
    check(entry.preview && /\.preview\.mp3$/.test(entry.preview) && fs.existsSync(entry.preview), 'a .preview.mp3 copy is made beside it', path.basename(entry.preview || ''));
    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', entry.preview]).toString());
    const st = probe.streams[0];
    check(st.codec_name === 'mp3' && Number(st.sample_rate) === 44100 && st.channels === 2, 'it is a plain mp3, 44.1 kHz stereo', `${st.codec_name} ${st.sample_rate} ${st.channels}ch`);
    check(Math.abs(Number(probe.format.duration) - entry.durationSec) < 0.1, 'and as long as the song', `${Number(probe.format.duration).toFixed(2)} vs ${entry.durationSec.toFixed(2)}`);
    check(library.list().music.find((m) => m.id === entry.id).preview === entry.preview, 'the library lists it');
    // a song saved before preview copies existed, or whose copy went missing, still plays from the original
    fs.rmSync(entry.preview, { force: true });
    const relisted = library.list().music.find((m) => m.id === entry.id);
    check(relisted && !relisted.preview && relisted.file === entry.file, 'a missing preview copy falls back to the original');
    const e2 = await library.add(ctx, video, { kind: 'music', path: SONG, name: 'Second' });
    library.remove({ kind: 'music', id: e2.id });
    check(!fs.existsSync(e2.file) && !fs.existsSync(e2.preview), 'removing a song deletes the song AND its preview copy');
  } catch (e) {
    console.log('  FAIL crashed: ' + (e.stack || e.message)); fail++;
  } finally {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
