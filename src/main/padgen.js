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
 * The sound is a soft string pad (an ensemble of slightly drifting voices,
 * warm and rounded, with an airy octave on top — see padWav), not an organ.
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
  let centre = 61;     // around C#4: a warm middle, nothing high and thin
  for (const [deg, shape, beats] of prog.chords) {
    const root = (tonic + deg) % 12;
    const pcs = SHAPE[shape].map((x) => (root + x) % 12);
    let best = null;
    for (let r = 0; r < pcs.length; r++) {
      for (let base = 50; base <= 66; base++) {
        if (base % 12 !== pcs[r]) continue;
        const notes = [base];
        for (let k = 1; k < pcs.length; k++) {
          let n = notes[k - 1] + 1;
          while (n % 12 !== pcs[(r + k) % pcs.length]) n++;
          notes.push(n);
        }
        if (notes[notes.length - 1] > 76) continue;      // never above E5: soft, not sharp
        const mean = notes.reduce((a, b) => a + b, 0) / notes.length;
        const cost = Math.abs(mean - centre) + 0.15 * (notes[notes.length - 1] - notes[0]);
        if (!best || cost < best.cost) best = { notes, cost, mean };
      }
    }
    let bass = 36 + ((root - 36 % 12 + 12) % 12);   // the root, C2–B2
    if (bass > 45) bass -= 12;                        // never above A2: the bass stays a bass
    out.push({ bass, upper: best.notes, beats });
    centre = best.mean * 0.7 + 61 * 0.3;              // drift back toward the middle
  }
  return out;
}

/** The dry progression, one pass, as a 32-bit float stereo WAV file's bytes. */
function padWav(progId, key) {
  const prog = PROGRESSIONS[progId];
  const chords = voiceProgression(prog, NOTE[key]);
  const pass = chords.reduce((a, c) => a + c.beats * BEAT, 0);
  const whole = (f) => Math.max(1, Math.round(f * pass)) / pass;   // whole cycles in a pass: no seam
  const FADE = 4.5;                                                   // how long one chord swells into the next (slow: soft)
  /*
   * THE SOUND: a soft string pad — the Area 51 / Nord soft pad kind, not an organ.
   * Every note is an ENSEMBLE: three voices a few cents apart on each side (as a
   * section of strings is never perfectly together — that drift is what makes
   * it lush and alive), each a warm, rounded wave: all of a saw's harmonics, but
   * rolled off softly from ~1 kHz, so it is full without any edge. The bass is
   * one soft, round voice (several low voices would throb). Over the top, an
   * (no bright "air" layer on top any more: asked for soft, then softer).
   * Each wave is drawn once (a wavetable) and read round, so it is quick.
   */
  const TABLE = 2048;
  const tables = new Map();
  const tableFor = (f, fc) => {
    const k = f.toFixed(3) + '|' + fc;
    if (tables.has(k)) return tables.get(k);
    const t = new Float64Array(TABLE + 1);
    let peak = 0;
    for (let h = 1; h * f < 9000 && h <= 60; h++) {
      const a = Math.exp(-(h * f) / fc) / h;
      if (a < 1e-4) break;
      for (let i = 0; i < TABLE; i++) t[i] += a * Math.sin((2 * Math.PI * h * i) / TABLE);
    }
    for (let i = 0; i < TABLE; i++) peak = Math.max(peak, Math.abs(t[i]));
    for (let i = 0; i < TABLE; i++) t[i] /= peak || 1;
    t[TABLE] = t[0];
    tables.set(k, t);
    return t;
  };
  const ENSEMBLE = [[-3, 0, 3], [-2, 1, 3]];           // cents, left / right (close: a gentle shimmer, not a wobble)
  const voices = [];
  let at = 0;
  chords.forEach((c) => {
    const len = c.beats * BEAT;
    // SOFT: the overtones roll off from ~250 Hz (almost pure and round — a hint of warmth, no edge at all)
    const parts = [{ m: c.bass, lv: 0.09, fc: 150, ens: false }]
      .concat(c.upper.map((m, i, all) => ({ m, lv: (i === all.length - 1 ? 0.085 : 0.12 - i * 0.008), fc: 250, ens: true })))   // the top note a little under the rest
    parts.forEach((pt, j) => {
      for (let ch = 0; ch < 2; ch++) {
        const det = pt.ens ? ENSEMBLE[ch] : [pt.air ? (ch ? 3 : -3) : 0];
        det.forEach((cents, k) => {
          const f = whole(freq(pt.m) * Math.pow(2, cents / 1200));
          voices.push({ f, table: tableFor(f, pt.fc), lv: pt.lv / Math.sqrt(det.length), ch, start: at, len, ph: ((j * 7 + k * 13 + ch * 5) % 17) / 17 });
        });
      }
    });
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
    const out = buf[v.ch], tb = v.table;
    for (let s = 0; s < n; s++) {
      const t = s / SR;
      const e = env(v, t);
      if (!e) continue;
      // where in its wave this voice is (whole cycles in a pass, so the end meets the start)
      let x = (v.f * t + v.ph) % 1;
      x *= TABLE;
      const i = x | 0;
      out[s] += v.lv * e * (tb[i] + (tb[i + 1] - tb[i]) * (x - i));
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
    '[0:a]lowpass=f=1800,lowpass=f=3000,highpass=f=50,equalizer=f=320:t=q:w=1:g=-2.5,equalizer=f=2200:t=q:w=1.2:g=-5[dry]',
    '[dry]asplit[a][b]',
    // the room: a long soft tail (a pink-noise impulse fading over 4.5 s; no rumble in it)
    '[a][1:a]afir=dry=2:wet=10[w]',
    `[b][w]amix=inputs=2:weights=0.5 1:normalize=0,atrim=${pass}:${pass + length},asetpts=PTS-STARTPTS,`
      + 'volume=-4dB,alimiter=limit=0.6:level=false[out]',
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
