'use strict';
/*
 * ►► THE AI PICKS EACH SHORT'S THUMBNAIL. ◄◄
 *
 * Left alone, a platform shows a short's first frame: a blur at a camera cut,
 * the preacher mid-blink, looking down at his notes. Nobody chose it, and most
 * people never open the picker. So unless a thumbnail was chosen by hand, every
 * short gets its own, picked from the FINISHED file (the 9:16 crop, the light,
 * the captions — exactly what people will see), here on the server so it works
 * while the phone is closed (a batch's steps run here, batch.js):
 *
 *   1. frames across the short (not its first and last moments, not the
 *      ending card added after it — `searchEnd`), each one looked at by the
 *      person detector (persondetect.js) and measured: is the speaker there,
 *      big enough, in the middle and the top half, the face sharp (not caught
 *      in movement or a cut), lit (not in shadow, not blown out);
 *   2. the best few, side by side, shown to the vision AI (cloudsee.pickThumb),
 *      which judges what a detector cannot — eyes open, an expression worth
 *      tapping on — and picks one.
 *
 * Nothing here can fail an export: no detector, no AI, it falls back a step at
 * a time, and at worst it is the sharpest frame, never the first one.
 */
const fs = require('fs');
const path = require('path');
const ff = require('./ffmpeg');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** How much fine detail a region holds: variance of the Laplacian of its grey (a blurred frame has little). */
function detail(rgb, W, H, x0, y0, x1, y1) {
  x0 = clamp(Math.floor(x0), 1, W - 2); x1 = clamp(Math.ceil(x1), 2, W - 1);
  y0 = clamp(Math.floor(y0), 1, H - 2); y1 = clamp(Math.ceil(y1), 2, H - 1);
  const g = (x, y) => { const i = (y * W + x) * 3; return rgb[i] * 0.299 + rgb[i + 1] * 0.587 + rgb[i + 2] * 0.114; };
  let n = 0, sum = 0, sum2 = 0, lum = 0;
  // measured at the region's own scale (neighbours `step` apart), so a big close-up and a small far-off face compare fairly
  const step = Math.max(1, Math.floor(Math.min(x1 - x0, y1 - y0) / 64));
  for (let y = y0 + step; y < y1 - step; y += step) {
    for (let x = x0 + step; x < x1 - step; x += step) {
      const c = g(x, y);
      const l = g(x - step, y) + g(x + step, y) + g(x, y - step) + g(x, y + step) - 4 * c;
      sum += l; sum2 += l * l; lum += c; n++;
    }
  }
  if (!n) return { sharp: 0, lum: 0 };
  const m = sum / n;
  return { sharp: sum2 / n - m * m, lum: lum / n };
}

/** The speaker in a frame: the biggest, surest face among the people found. */
function mainFace(people) {
  let best = null, bs = 0;
  for (const p of people || []) {
    const f = p.face; if (!f || !(f.h > 0.02)) continue;
    const s = f.h * (0.5 + (p.score || 0)) * (1 - Math.min(0.6, Math.abs(f.x - 0.5)));
    if (s > bs) { bs = s; best = p; }
  }
  return best;
}

/**
 * The moment (seconds into `input`) that makes the best thumbnail.
 * Returns { atSec, by: 'ai' | 'detector' | 'detail', why }.
 */
async function pickMoment(ctx, { input, searchEnd, outroSec = 0, n = 14, info }) {
  const pd = require('./persondetect');
  // never the ending card: the file's length less the outro (plus a second), whatever the pieces were thought to add up to
  const fileEnd = info && info.durationSec ? info.durationSec - (outroSec > 0 ? outroSec + 1 : 0) : Infinity;
  const dur = Math.max(0.2, Math.min(searchEnd > 0 ? searchEnd : Infinity, fileEnd > 0.5 ? fileEnd : Infinity, (info && info.durationSec) || searchEnd || 0));
  // not the first second (a cut, a word half-said) nor the last (the short is ending)
  const a = Math.min(1.0, dur * 0.1), b = Math.max(a + 0.1, dur - Math.min(1.0, dur * 0.1));
  const times = [];
  for (let i = 0; i < n; i++) times.push(+(a + ((i + 0.5) / n) * (b - a)).toFixed(3));
  const canSee = pd.available();
  const cands = [];
  for (const t of times) {
    let fr;
    try { fr = await pd.frameRgb(ctx.ffmpeg, input, t, 640); } catch (e) { continue; }
    const W = fr.width, H = fr.height;
    const whole = detail(fr.rgb, W, H, W * 0.15, H * 0.1, W * 0.85, H * 0.7);
    const c = { t, whole, face: null, people: 0 };
    if (canSee) {
      // measured first: the picture is handed to the detector's thread with the question
      const rgb = fr.rgb.slice();
      let ppl = [];
      try { ppl = await pd.peopleIn(fr); } catch (e) { ppl = []; }
      const m = mainFace(ppl);
      c.people = ppl.length;
      if (m) {
        const f = m.face;
        const fx0 = (f.x - f.w * 0.7) * W, fx1 = (f.x + f.w * 0.7) * W, fy0 = (f.y - f.h * 0.7) * H, fy1 = (f.y + f.h * 0.7) * H;
        c.face = Object.assign({ score: m.score }, f, detail(rgb, W, H, fx0, fy0, fx1, fy1));
      }
    }
    cands.push(c);
  }
  if (!cands.length) return { atSec: +(dur * 0.3).toFixed(3), by: 'none', why: 'no frames could be read' };
  const maxWhole = Math.max(1e-6, ...cands.map((c) => c.whole.sharp));
  const maxFace = Math.max(1e-6, ...cands.filter((c) => c.face).map((c) => c.face.sharp));
  for (const c of cands) {
    const wl = c.whole.lum;
    const expoW = wl < 40 ? wl / 40 : wl > 215 ? Math.max(0, (255 - wl) / 40) : 1;
    if (!c.face) { c.score = 0.35 * (c.whole.sharp / maxWhole) * expoW; continue; }
    const f = c.face;
    // a face about a sixth to a third of the picture's height reads on a phone; tiny is a crowd shot, huge is cut off
    const size = f.h < 0.16 ? f.h / 0.16 : f.h > 0.42 ? Math.max(0.5, 1 - (f.h - 0.42) * 2) : 1;
    const centre = 1 - Math.min(1, Math.abs(f.x - 0.5) / 0.32);
    const height = f.y < 0.12 ? 0.6 : f.y > 0.6 ? Math.max(0, 1 - (f.y - 0.6) * 3) : 1;
    const sharp = f.sharp / maxFace;
    const expo = f.lum < 55 ? f.lum / 55 : f.lum > 210 ? Math.max(0, (255 - f.lum) / 45) : 1;
    const crowd = c.people > 3 ? 0.9 : 1;
    // every quality multiplies: a sharp frame of a tiny figure at the bottom is not a thumbnail, nor a big blurred one
    c.score = 1 + size * height * (0.6 + 0.4 * centre) * (0.35 + 0.65 * sharp) * (0.3 + 0.7 * expo) * (0.85 + 0.15 * (f.score || 0)) * crowd;
  }
  cands.sort((x, y) => y.score - x.score);
  const lead = cands[0];
  if (!lead.face) return { atSec: lead.t, by: 'detail', why: 'nobody could be found in shot: the clearest frame' };
  // the finalists: the best few, not two from the same second
  const fin = [];
  for (const c of cands) {
    if (!c.face || c.score - 1 < (lead.score - 1) * 0.72) continue;   // (1 is the bonus for a face at all)
    if (fin.some((x) => Math.abs(x.t - c.t) < 1.2)) continue;
    fin.push(c);
    if (fin.length === 4) break;
  }
  if (fin.length < 2) return { atSec: lead.t, by: 'detector', why: 'the speaker, sharpest and best framed' };
  try {
    const cs = require('./cloudsee');
    if (!cs.ready()) return { atSec: lead.t, by: 'detector', why: 'the speaker, sharpest and best framed' };
    const image = await strip(ctx, input, fin.map((c) => c.t));
    const r = image ? await cs.pickThumb({ image, count: fin.length }) : { ok: false };
    if (r.ok) return { atSec: fin[r.best].t, by: 'ai', why: r.why || '' };
  } catch (e) { /* the detector's own pick stands */ }
  return { atSec: lead.t, by: 'detector', why: 'the speaker, sharpest and best framed' };
}

/** The finalists side by side, as one small JPEG data URL (one picture costs the free AI far less than four). */
async function strip(ctx, input, times) {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-thumbs-'));
  try {
    const files = [];
    for (let i = 0; i < times.length; i++) {
      const f = path.join(dir, `c${i}.jpg`);
      await ff.runFfmpeg(ctx.ffmpeg, ['-ss', String(times[i]), '-i', input, '-frames:v', '1', '-vf', 'scale=-2:448,pad=iw+12:ih:6:0:black', '-q:v', '4', '-y', f], {});
      if (fs.existsSync(f)) files.push(f);
    }
    if (files.length < 2) return null;
    const out = path.join(dir, 'strip.jpg');
    await ff.runFfmpeg(ctx.ffmpeg, [...files.flatMap((f) => ['-i', f]), '-filter_complex', `${files.map((f, i) => `[${i}:v]`).join('')}hstack=inputs=${files.length}`, '-frames:v', '1', '-q:v', '4', '-y', out], {});
    if (!fs.existsSync(out)) return null;
    return 'data:image/jpeg;base64,' + fs.readFileSync(out).toString('base64');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
}

module.exports = { pickMoment, detail, mainFace, strip };
