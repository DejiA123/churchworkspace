'use strict';
/*
 * ►► WORSHIP PADS, MADE HERE. ◄◄
 *
 * "The prayer soft pads should be Christian ones." What a church plays under a
 * prayer or an altar call is a WORSHIP PAD: one long, soft chord in the key the
 * band is in, swelling slowly, with no beat and no tune — so it sits under any
 * prayer, any song, any voice. The stock-music shelves have hardly any, and the
 * ones churches pass around carry no licence for posting. So the studio makes
 * its own: nobody else's recording, nothing to credit, nothing for a platform
 * to flag.
 *
 * A pad in a key is the chord a worship keyboardist holds: the root low, then
 * the fifth, the octave, the ninth and the fifth above — no third, so it fits a
 * major or a minor song alike. Each note is three voices a few cents apart
 * (left and right differently, which is what makes it wide and alive), every
 * note breathes on its own slow swell, and "Shimmer" adds the high octaves.
 *
 * Made as a 30-second piece that loops without a seam — every frequency and
 * every swell completes whole cycles in it — then looped to three minutes and
 * given its warmth and its room by ffmpeg (a gentle filter, a long soft
 * reverb, and a fixed level that sits under a voice). A few seconds of work
 * on the server, once: the result lives in the music library after that.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SR = 44100;
const LOOP = 30;        // seconds: the piece that repeats
const LENGTH = 180;     // seconds: the finished pad

const NOTE = { C: 0, 'C#': 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
const C2 = 65.406;
// the fixed level (dB) that puts a pad near -21 dB average — under a voice, never over it
const GAIN_WARM = 3, GAIN_SHIMMER = 3;
/** In the loop, a frequency that completes whole cycles (moved by at most 1/60 Hz — nobody can hear it). */
const whole = (f) => Math.max(1, Math.round(f * LOOP)) / LOOP;

/** The dry pad: 30 s of 32-bit float stereo, as a WAV file's bytes. */
function padWav(key, colour) {
  const root = C2 * Math.pow(2, NOTE[key] / 12);
  const shimmer = colour === 'shimmer';
  // [semitones above the root, level]
  // [semitones above the root, level, detune in cents]: the low notes held steady
  // (detuned, two voices that low beat — a throb, not a pad), the upper ones
  // spread a little, left and right differently, which is what makes it wide
  // (the warmth is in the middle: the bass is there to hold it up, not to boom)
  // (a cent or two: a slow, calm movement — more is a flutter)
  const notes = [[0, 0.11, 0], [12, 0.15, 0], [19, 0.18, 1.2], [24, 0.17, 1.5], [26, 0.1, 2], [31, 0.08, 2]];
  if (shimmer) notes.push([36, 0.05, 2.5], [43, 0.03, 3]);
  const swells = [1, 1, 2, 3, 2, 3, 4, 3];          // whole swells per loop, note by note (slow)
  const voices = [[], []];
  notes.forEach(([st, lv, cents], i) => {
    const f = root * Math.pow(2, st / 12);
    const depth = i < 2 ? 0.08 : 0.25;               // the bass barely moves
    for (let ch = 0; ch < 2; ch++) {
      const spread = cents ? (ch ? [-cents * 0.6, cents] : [-cents, cents * 0.6]) : [0];
      for (const c of spread) {
        voices[ch].push({ f: whole(f * Math.pow(2, c / 1200)), lv: lv / spread.length, rate: swells[i] / LOOP, ph: i * 1.3 + ch * 0.7, depth });
      }
    }
  });
  const n = SR * LOOP;
  const data = Buffer.alloc(n * 8);
  const TAU = 2 * Math.PI;
  for (let s = 0; s < n; s++) {
    const t = s / SR;
    for (let ch = 0; ch < 2; ch++) {
      let x = 0;
      for (const v of voices[ch]) {
        const a = TAU * v.f * t;
        // a touch of the second harmonic for warmth; each note swells on its own
        x += v.lv * (1 - v.depth + v.depth * Math.sin(TAU * v.rate * t + v.ph)) * (Math.sin(a) + 0.18 * Math.sin(2 * a));
      }
      data.writeFloatLE(x * 0.8, s * 8 + ch * 4);
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20);   // 3 = IEEE float
  head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 8, 28);
  head.writeUInt16LE(8, 32); head.writeUInt16LE(32, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/** The finished pad (an mp3) at `out`. */
function makePad(ffmpeg, key, colour, out) {
  if (!(key in NOTE)) return Promise.reject(new Error('No such key: ' + key));
  const dry = path.join(os.tmpdir(), `mw-pad-${process.pid}-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(dry, padWav(key, colour));
  const shimmer = colour === 'shimmer';
  /*
   * THE FILE LOOPS WITHOUT A SEAM TOO. A song shorter than the video goes round
   * again (video.js mixMusic), so the pad must not fade out and back in every
   * three minutes. One extra loop is played first, for the room to fill, and
   * cut off: from then on what comes out repeats exactly every 30 s, and three
   * minutes is a whole number of those. No fades (the studio puts its own on
   * the bed) and a FIXED level — a level that follows the sound would differ
   * from one end to the other.
   */
  const loops = Math.ceil(LENGTH / LOOP) + 1;
  const fc = [
    `[0:a]lowpass=f=${shimmer ? 5200 : 2400},highpass=f=55[dry]`,
    '[dry]asplit[a][b]',
    // the room: a long soft tail (a pink-noise impulse fading over 4.5 s; no rumble in it)
    `[a][1:a]afir=dry=2:wet=${shimmer ? 9 : 7}[w]`,
    `[b][w]amix=inputs=2:weights=0.5 1:normalize=0,atrim=${LOOP}:${LOOP + LENGTH},asetpts=PTS-STARTPTS,`
      + `volume=${shimmer ? GAIN_SHIMMER : GAIN_WARM}dB,alimiter=limit=0.8:level=false[out]`,
  ].join(';');
  const args = ['-v', 'error', '-y', '-stream_loop', String(loops - 1), '-i', dry,
    '-f', 'lavfi', '-i', `anoisesrc=d=4.5:c=pink:r=${SR}:a=0.5:seed=7,highpass=f=220,lowpass=f=7000,afade=t=out:st=0:d=4.5:curve=exp,aformat=channel_layouts=stereo`,
    '-filter_complex', fc, '-map', '[out]', '-ar', String(SR), '-c:a', 'libmp3lame', '-b:a', '160k', out];
  return new Promise((resolve, reject) => {
    execFile(ffmpeg, args, { maxBuffer: 8 * 1024 * 1024 }, (err, so, se) => {
      try { fs.rmSync(dry, { force: true }); } catch (e) {}
      if (err) reject(new Error('The pad could not be made (' + String(se || err.message).trim().split('\n').pop() + ')'));
      else resolve(out);
    });
  });
}

module.exports = { makePad, padWav, KEYS: Object.keys(NOTE), LOOP, LENGTH };
