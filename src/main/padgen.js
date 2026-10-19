'use strict';
/*
 * ►► WORSHIP PADS, MADE HERE — CHORD PROGRESSIONS, NOT ONE NOTE. ◄◄
 *
 * "One note is disgusting — it should be a beautiful worship progression:
 *  minor ones, 2-5-1, gospel progressions, church progressions." So each pad
 * is a real progression, the way a church keyboardist plays under a prayer
 * or an altar call: the chords that churches actually use, voiced the gospel
 * way (sevenths, ninths, thirteenths, suspensions), each chord moving to the
 * next by the nearest notes (voice leading), the bass on the root, every chord
 * swelling into the next over a couple of seconds — no beat, no tune on top.
 *
 *   Worship 1–5–6–4     I(add9) – V(add9) – vi7 – IV(maj9)        (the most used worship progression)
 *   Gospel 2–5–1        ii9 – V13 – Imaj9 – Imaj9                 (the gospel cadence)
 *   Church 1–6–2–5      Imaj9 – vi9 – ii9 – V9sus4                (the church turnaround)
 *   Minor Prayer        i9 – VImaj7 – IIImaj7 – VII6/9            (in a minor key)
 *   Soaking 4–1         IVmaj9 – I(add9)                          (two chords, very slow)
 *   Gospel Plagal       Imaj9 – IVmaj9 – iv6 – Imaj9              (the "Amen" with the minor four)
 *   Hymn 1–4–1–5        I – IV(add9) – I – V7sus4                 (the old church hymn cadence)
 *   Emotional 6–4–1–5   vi9 – IVmaj7 – I(add9) – V(add9)
 *
 * Nobody else's recording — nothing to credit, nothing for a platform to flag.
 *
 * Made as one pass of the progression that loops without a seam (every
 * frequency completes whole cycles in it, and the last chord swells back into
 * the first), then looped to about three minutes and given its room by ffmpeg:
 * a gentle filter, a long soft reverb and a fixed level that sits under a
 * voice. The file loops without a seam too (one extra pass first lets the room
 * fill; no fades — the studio puts its own on the bed). A few seconds' work on
 * the server, once; it lives in the music library after that.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const SR = 44100;
const TARGET = 180;     // seconds: about how long the finished pad is (a whole number of passes)

const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

/* The upper notes of each chord, in semitones above its root (the root itself is in the bass). */
const SHAPE = {
  add9: [4, 7, 14], maj7: [4, 7, 11], maj9: [4, 7, 11, 14], six9: [4, 9, 14],
  m7: [3, 7, 10], m9: [3, 7, 10, 14], m6: [3, 7, 9],
  dom9: [4, 10, 14], dom13: [4, 10, 14, 21], sus9: [5, 10, 14], sus7: [5, 7, 10],
};
/* [degree in semitones above the key's tonic, chord shape, length in beats] — one beat = 1.5 s */
const PROGRESSIONS = {
  w1564: { name: 'Worship 1-5-6-4', minor: false, chords: [[0, 'add9', 4], [7, 'add9', 4], [9, 'm7', 4], [5, 'maj9', 4]] },
  g251: { name: 'Gospel 2-5-1', minor: false, chords: [[2, 'm9', 4], [7, 'dom13', 4], [0, 'maj9', 4], [0, 'maj9', 4]] },
  c1625: { name: 'Church 1-6-2-5', minor: false, chords: [[0, 'maj9', 4], [9, 'm9', 4], [2, 'm9', 4], [7, 'sus9', 4]] },
  minor: { name: 'Minor Prayer', minor: true, chords: [[0, 'm9', 4], [8, 'maj7', 4], [3, 'maj7', 4], [10, 'six9', 4]] },
  soak41: { name: 'Soaking 4-1', minor: false, chords: [[5, 'maj9', 6], [0, 'add9', 6]] },
  plagal: { name: 'Gospel Plagal', minor: false, chords: [[0, 'maj9', 4], [5, 'maj9', 4], [5, 'm6', 4], [0, 'maj9', 4]] },
  hymn: { name: 'Hymn 1-4-1-5', minor: false, chords: [[0, 'add9', 4], [5, 'add9', 4], [0, 'add9', 4], [7, 'sus7', 4]] },
  e6415: { name: 'Emotional 6-4-1-5', minor: false, chords: [[9, 'm9', 4], [5, 'maj7', 4], [0, 'add9', 4], [7, 'add9', 4]] },
};
/* Which progressions, in which keys (the keys churches most often play them in) — 24 pads */
const SHELF = [
  ['w1564', ['C', 'D', 'G']], ['g251', ['Eb', 'Ab', 'Bb']], ['c1625', ['C', 'F', 'Db']],
  ['minor', ['A', 'E', 'D']], ['soak41', ['D', 'E', 'A']], ['plagal', ['Bb', 'C', 'F']],
  ['hymn', ['G', 'D', 'F']], ['e6415', ['C', 'E', 'G']],
];
const BEAT = 1.5;

const freq = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

/*
 * VOICE LEADING: each chord's upper notes are placed (which inversion, which
 * octave) as close as they can be to where the last chord's were, inside a
 * warm middle range — so the hands hardly move and the pad flows instead of
 * jumping. The bass is the root, low.
 */
function voiceProgression(prog, tonic) {
  const out = [];
  let centre = 64;     // E4 to start
  for (const [deg, shape, beats] of prog.chords) {
    const root = (tonic + deg) % 12;
    const pcs = SHAPE[shape].map((x) => (root + x) % 12);
    let best = null;
    for (let r = 0; r < pcs.length; r++) {
      for (let base = 52; base <= 70; base++) {
        if (base % 12 !== pcs[r]) continue;
        const notes = [base];
        for (let k = 1; k < pcs.length; k++) {
          let n = notes[k - 1] + 1;
          while (n % 12 !== pcs[(r + k) % pcs.length]) n++;
          notes.push(n);
        }
        if (notes[notes.length - 1] > 81) continue;
        const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
        const cost = Math.abs(mean - centre) + 0.15 * (notes[notes.length - 1] - notes[0]);
        if (!best || cost < best.cost) best = { notes, cost, mean };
      }
    }
    let bass = 36 + ((root - 36 % 12 + 12) % 12);   // the root, C2–B2
    if (bass > 45) bass -= 12;                        // never above A2: the bass stays a bass
    out.push({ bass, upper: best.notes, beats });
    centre = best.mean * 0.7 + 64 * 0.3;              // drift back toward the middle
  }
  return out;
}

/** The dry progression, one pass, as a 32-bit float stereo WAV file's bytes. */
function padWav(progId, key) {
  const prog = PROGRESSIONS[progId];
  const chords = voiceProgression(prog, NOTE[key]);
  const pass = chords.reduce((a, c) => a + c.beats * BEAT, 0);
  const whole = (f) => Math.max(1, Math.round(f * pass)) / pass;   // whole cycles in a pass: no seam
  const FADE = 2.4;                                                   // how long one chord swells into the next
  // every note of every chord, with when it sounds
  const voices = [];
  let at = 0;
  chords.forEach((c) => {
    const len = c.beats * BEAT;
    // (the CHORD is what is heard: the bass under it is felt more than heard)
    const notes = [{ m: c.bass, lv: 0.075, cents: 0 }, { m: c.bass + 12, lv: 0.03, cents: 0 }]
      .concat(c.upper.map((m, i) => ({ m, lv: 0.16 - i * 0.01, cents: 1.5 })))
      .concat([{ m: c.upper[c.upper.length - 1] + 12, lv: 0.025, cents: 2.5 }]);   // a soft shimmer an octave up
    for (const n of notes) {
      for (let ch = 0; ch < 2; ch++) {
        // one true voice, the same left and right (so no note ever fades away), and a much
        // quieter one a hair off — sharp on one side, flat on the other — for warmth and width
        voices.push({ f: whole(freq(n.m)), lv: n.lv, ch, start: at, len });
        if (n.cents) voices.push({ f: whole(freq(n.m) * Math.pow(2, (ch ? n.cents : -n.cents) / 1200)), lv: n.lv * 0.3, ch, start: at, len });
      }
    }
    at += len;
  });
  // a chord's loudness through the pass: up over FADE before its start, held, down over FADE after its end (wrapping round)
  const env = (v, t) => {
    let d = t - v.start; if (d < -pass / 2) d += pass; if (d > pass / 2) d -= pass;
    if (d < -FADE / 2 || d > v.len + FADE / 2) return 0;
    if (d < FADE / 2) return Math.sin(((d + FADE / 2) / FADE) * Math.PI / 2) ** 2;
    if (d > v.len - FADE / 2) return Math.cos(((d - v.len + FADE / 2) / FADE) * Math.PI / 2) ** 2;
    return 1;
  };
  const n = Math.round(SR * pass);
  const data = Buffer.alloc(n * 8);
  const TAU = 2 * Math.PI;
  const buf = [new Float64Array(n), new Float64Array(n)];
  for (const v of voices) {
    const out = buf[v.ch];
    for (let s = 0; s < n; s++) {
      const t = s / SR;
      const e = env(v, t);
      if (!e) continue;
      const a = TAU * v.f * t;
      // a warm tone: the note, a little of its octave and its twelfth
      out[s] += v.lv * e * (Math.sin(a) + 0.18 * Math.sin(2 * a) + 0.05 * Math.sin(3 * a));
    }
  }
  for (let s = 0; s < n; s++) {
    // the whole pad breathes, once a pass
    const breath = 0.9 + 0.1 * Math.sin(TAU * (s / SR) / pass);
    data.writeFloatLE(buf[0][s] * breath * 0.9, s * 8);
    data.writeFloatLE(buf[1][s] * breath * 0.9, s * 8 + 4);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(3, 20);   // 3 = IEEE float
  head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 8, 28);
  head.writeUInt16LE(8, 32); head.writeUInt16LE(32, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([head, data]), pass };
}

/** The finished pad (an mp3) at `out`. */
function makePad(ffmpeg, progId, key, out) {
  if (!PROGRESSIONS[progId] || !(key in NOTE)) return Promise.reject(new Error('No such pad: ' + progId + ' in ' + key));
  const { wav, pass } = padWav(progId, key);
  const dry = path.join(os.tmpdir(), `mw-pad-${process.pid}-${Date.now().toString(36)}.wav`);
  fs.writeFileSync(dry, wav);
  const passes = Math.max(1, Math.round(TARGET / pass));
  const length = passes * pass;
  const fc = [
    '[0:a]lowpass=f=3600,highpass=f=50[dry]',
    '[dry]asplit[a][b]',
    // the room: a long soft tail (a pink-noise impulse fading over 4.5 s; no rumble in it)
    '[a][1:a]afir=dry=2:wet=8[w]',
    `[b][w]amix=inputs=2:weights=0.5 1:normalize=0,atrim=${pass}:${pass + length},asetpts=PTS-STARTPTS,`
      + 'volume=0dB,alimiter=limit=0.8:level=false[out]',
  ].join(';');
  const args = ['-v', 'error', '-y', '-stream_loop', String(passes), '-i', dry,
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

/** The shelf of pads: id, title, progression and key. */
function shelf() {
  const out = [];
  for (const [id, keys] of SHELF) {
    const p = PROGRESSIONS[id];
    for (const key of keys) {
      out.push({ id: `pad-${id}-${key.toLowerCase().replace('#', 's')}`, title: `${p.name} in ${key}${p.minor ? ' minor' : ''}`, prog: id, key });
    }
  }
  return out;
}

module.exports = { makePad, padWav, voiceProgression, shelf, PROGRESSIONS, SHAPE, NOTE };
