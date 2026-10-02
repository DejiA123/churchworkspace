'use strict';
/* Transcribe a whole range of a video once into a flat JSON, so shorts-boundary
 * experiments can run offline and instantly.
 * Usage: node test/diag-full-transcript.js <video> <fromSec> <toSec> <out.json> */
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');
const ffprobe = require('ffprobe-static').path;
const cap = require('../src/main/captioner');

const ctx = { ffmpeg, ffprobe };
const input = process.argv[2];
const from = +process.argv[3], to = +process.argv[4];
const out = process.argv[5];
const CHUNK = 300;

(async () => {
  let segs = [];
  try { segs = JSON.parse(fs.readFileSync(out, 'utf8')).segs || []; } catch (e) {}
  const done = new Set(segs.length ? JSON.parse(fs.readFileSync(out, 'utf8')).done || [] : []);
  const t0 = Date.now();
  for (let s = from; s < to; s += CHUNK) {
    const e = Math.min(to, s + CHUNK);
    if (done.has(s)) continue;
    const t = Date.now();
    const r = await cap.transcribe(ctx, { input, startSec: s, endSec: e, model: 'base', granularity: 'segment', fast: true, threads: 4 });
    for (const g of (r.words || [])) segs.push({ start: g.start + s, end: g.end + s, text: g.text });
    done.add(s);
    segs.sort((a, b) => a.start - b.start);
    fs.writeFileSync(out, JSON.stringify({ segs, done: [...done] }));
    const pctDone = (e - from) / (to - from);
    console.log(`${Math.round(pctDone * 100)}%  ${Math.round(s)}s-${Math.round(e)}s in ${Math.round((Date.now() - t) / 1000)}s  (elapsed ${Math.round((Date.now() - t0) / 60000)}m, eta ${Math.round(((Date.now() - t0) / pctDone - (Date.now() - t0)) / 60000)}m)`);
  }
  console.log('DONE ' + segs.length + ' segments -> ' + out);
})().catch((e) => { console.error(e); process.exit(1); });
