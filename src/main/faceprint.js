'use strict';
/*
 * ►► THE SAME PERSON, TOLD BY THEIR FACE — ON THE SERVER, NO ALLOWANCE. ◄◄
 * "Never the same person twice." What someone wears (montage.js: sameTop) tells the host from the band within the
 * hour; it let the host through at 7.7 and 13.5 min (a fade, a turned head), and two hours apart it cannot say at
 * all. This tells people apart by their faces:
 *   - the person detector finds each face, BlazeFace where its eyes, nose and mouth are (persondetect.js);
 *   - the face is lined up as face-print models expect (eyes level, at the same places, 112×112);
 *   - SFace (OpenCV's face recognition model, Apache-2.0, on onnxruntime — the cut-out's runtime) turns it into
 *     128 numbers; two faces of one person point the same way (OpenCV's own line for "the same": 0.363).
 * A picture plays for ~2.5 s, so three frames of it are looked at (a turned head in one, the face in the next).
 * Free, no key, nothing sent anywhere — about a second a picture. Not on this machine (the desktop app, a server
 * without the model) → available() is false and the montage goes on as before.
 *
 * On Gospel Jamz (720p, faces of 30–90 pixels): the host 13.5 vs 129 min 0.47, the man in green 188 vs 196 min
 * (both side on) 0.43; different people 0.33 at most once the false faces are left out — a logo, a cushion, the
 * back of a head, which BlazeFace is unsure of (under 0.7).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODEL = process.env.MW_FACE_MODEL || path.join(__dirname, '..', '..', 'bin', 'faceid', 'sface.onnx');
const SAME = 0.363;      // (OpenCV's line for SFace: the same person at or above it)
const SURE = 0.7;        // BlazeFace's own confidence, below which a "face" is a pattern
const MIN_EYES = 12;     // eyes this many pixels apart at least — fewer is a blur, not a face to tell by
// where the eyes, nose and mouth go in the 112×112 face (ArcFace's places; the mouth is the middle of its corners)
const TPL = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [56.1396, 92.2848]];

let ort, session = null, opening = null;
function runtime() {
  if (ort === undefined) { try { ort = require('onnxruntime-node'); } catch (e) { ort = null; } }
  return ort;
}
let pd;
function detector() {
  if (pd === undefined) { try { pd = require('./persondetect'); if (!pd.available()) pd = null; } catch (e) { pd = null; } }
  return pd;
}
/** Faces can be told apart here: the runtime, the model and the person detector. */
function available() { return !!runtime() && fs.existsSync(MODEL) && !!detector(); }

async function open() {
  if (session) return session;
  if (!opening) {
    opening = runtime().InferenceSession.create(MODEL, { intraOpNumThreads: Math.max(1, Math.min(2, os.cpus().length)), logSeverityLevel: 3 })
      .then((s) => { session = s; return s; }).finally(() => { opening = null; });
  }
  return opening;
}

/* the similarity (turn, size, shift — no mirror) that best takes `src` points onto `dst` (Umeyama) */
function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0] / n; my += src[i][1] / n; ux += dst[i][0] / n; uy += dst[i][1] / n; }
  let a = 0, b = 0, v = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - mx, sy = src[i][1] - my, dx = dst[i][0] - ux, dy = dst[i][1] - uy;
    a += sx * dx + sy * dy; b += sx * dy - sy * dx; v += sx * sx + sy * sy;
  }
  const ca = a / v, sb = b / v;
  return { ca, sb, tx: ux - (ca * mx - sb * my), ty: uy - (sb * mx + ca * my) };
}

/** The face lined up: 112×112, planar RGB 0–255 (as SFace takes it). */
function align(rgb, W, H, m) {
  const T = similarity([m.eyeR, m.eyeL, m.nose, m.mouth], TPL);
  const d = T.ca * T.ca + T.sb * T.sb;
  const out = new Float32Array(3 * 112 * 112);
  const px = (x, y, c) => rgb[(Math.max(0, Math.min(H - 1, y)) * W + Math.max(0, Math.min(W - 1, x))) * 3 + c];
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      const X = u - T.tx, Y = v - T.ty;
      const sx = (T.ca * X + T.sb * Y) / d, sy = (-T.sb * X + T.ca * Y) / d;
      const xa = Math.floor(sx), ya = Math.floor(sy), fx = sx - xa, fy = sy - ya;
      for (let c = 0; c < 3; c++) {
        out[c * 12544 + v * 112 + u] = (1 - fy) * ((1 - fx) * px(xa, ya, c) + fx * px(xa + 1, ya, c)) + fy * ((1 - fx) * px(xa, ya + 1, c) + fx * px(xa + 1, ya + 1, c));
      }
    }
  }
  return out;
}

/* the mouth of a lined-up face, in grey, its light evened out (mouths are where the template puts them: 34–78 across,
 * 78–106 down) */
function mouthOf(al) {
  const v = new Float32Array(44 * 28);
  let k = 0;
  for (let y = 78; y < 106; y++) for (let x = 34; x < 78; x++) { const i = y * 112 + x; v[k++] = (al[i] + al[12544 + i] + al[25088 + i]) / 3; }
  let m = 0; for (const x of v) m += x; m /= v.length;
  let sd = 0; for (const x of v) sd += (x - m) * (x - m); sd = Math.sqrt(sd / v.length) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] - m) / sd;
  return v;
}
async function printOf(rgb, W, H, m) {
  const s = await open();
  const r = await s.run({ [s.inputNames[0]]: new (runtime().Tensor)('float32', align(rgb, W, H, m), [1, 3, 112, 112]) });
  const e = r[s.outputNames[0]].data;
  let n = 0;
  for (const x of e) n += x * x;
  n = Math.sqrt(n) || 1;
  const p = Float32Array.from(e, (x) => x / n);
  const al = align(rgb, W, H, m);
  if (exp.debug) exp.debug(al, m);
  p.mouth = mouthOf(al);
  return p;
}

/**
 * The face prints in one frame already read ({ rgb, width, height }), of the faces whose middle is between `x0` and
 * `x1` (shares of the width: the part a 9:16 cut shows). The frame is handed over.
 */
async function printsIn(fr, x0 = 0, x1 = 1, { main = false } = {}) {
  if (!available()) return [];
  const { width: W, height: H } = fr;
  const keep = fr.rgb.slice();
  let faces = (await detector().peopleIn(fr)).filter((p) => p.face && p.score >= 0.4 && p.face.x >= x0 && p.face.x <= x1).map((p) => p.face);
  // (main: only the person the picture is OF — the biggest face in it; a panel behind them is not them)
  if (main && faces.length > 1) faces = [faces.reduce((a, b) => (b.w > a.w ? b : a))];
  if (!faces.length) return [];
  const marks = await detector().marksIn({ rgb: keep.slice(), width: W, height: H }, faces);
  const out = [];
  for (const m of marks) {
    const eyes = m ? Math.hypot(m.eyeL[0] - m.eyeR[0], m.eyeL[1] - m.eyeR[1]) : 0;
    if (!m || m.s < SURE || eyes < MIN_EYES) continue;
    const p = await printOf(keep, W, H, m);
    // how well it can be told: the eyes' distance, and how far the head is turned (the nose off the eyes' middle,
    // in eye-distances: 0 facing the camera, ±0.5 and more side on — a turned face reads unlike its own front)
    p.q = { eyes: +eyes.toFixed(1), turn: +Math.abs((m.nose[0] - (m.eyeL[0] + m.eyeR[0]) / 2) / eyes).toFixed(2), s: +m.s.toFixed(2) };
    out.push(p);
  }
  return out;
}

/**
 * The faces a picture shows: video `file` (w×h) round source time `t`, cut 9:16 (or W:H) round `fx` — three frames
 * 0.8 s apart (or `n`, `step` s apart). [] when none can be told (no one facing, too small, not available here).
 */
async function printsAt(ffmpeg, file, t, fx, w, h, W = 1080, H = 1920, { n = 3, step = 0.8, main = false } = {}) {
  if (!available() || !(w > 0 && h > 0)) return [];
  const share = Math.min(1, (h * W / H) / w);
  const c = fx == null || !Number.isFinite(fx) ? 0.5 : Math.max(0, Math.min(1, fx));
  const x0 = Math.max(0, Math.min(1 - share, c - share / 2));
  let frames = [];
  try { frames = await detector().framesRgb(ffmpeg, file, Math.max(0, t - step * (n - 1) / 2), n, step, w, h, 1280); } catch (e) { return []; }
  const all = [];
  for (const fr of frames) { try { all.push(...await printsIn(fr, x0, x0 + share, { main })); } catch (e) { /* that frame only */ } }
  return all;
}

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/*
 * ►► TELLING TWO PEOPLE APART — ONLY BY CLEAR FACES. ◄◄ "The same person is appearing twice." Measured on 126
 * pictures of Gospel Jamz labelled by hand (16 people, 632 pairs of one person, 7,243 of two): a face turned side on
 * reads unlike its own front — the man in green, front and side, 0.04 — so a low likeness says nothing unless BOTH
 * faces are clear: eyes 20 pixels apart or more, facing the camera (the nose within a third of an eye-distance of
 * the eyes' middle), BlazeFace sure of it (0.75). Between clear faces one person never read under 0.25, and every
 * such pair under 0.3 was caught by its other faces (0.33 or more); two people read under 0.3 nine times in ten.
 *   - clear faces both: their people 0.28 alike or more on average, one person; under, two
 *   - otherwise any faces 0.33 alike or more: one person; else it cannot be told by face (null)
 * Read on the person each picture is OF (printsAt main: the biggest face in it), not everyone behind them: 0 of 604
 * pairs of one person called two, the nearest 0.19 clear of the lines; in 1,000 edits drawn from those pictures no
 * one appeared twice.
 */
const ALIKE = 0.33, CLEAR_SAME = 0.28, GROUP = 0.4, CLEAR = { eyes: 20, turn: 0.35, s: 0.75 };
const clear = (p) => !!(p && p.q && p.q.eyes >= CLEAR.eyes && p.q.turn <= CLEAR.turn && p.q.s >= CLEAR.s);
const clearOf = (faces) => (faces || []).filter(clear);
/* a picture's faces sorted into the people they are (one face 0.4 alike or more to another of the group: the same
 * person in another frame; a camera that cut away mid-line makes two groups) */
function groupsOf(faces) {
  const groups = [];
  for (const f of faces) {
    const hit = groups.filter((g) => g.some((h) => cos(h, f) >= GROUP));
    const g = [f].concat(...hit);
    for (const h of hit) groups.splice(groups.indexOf(h), 1);
    groups.push(g);
  }
  return groups;
}
const meanLike = (A, B) => { let s = 0; for (const a of A) for (const b of B) s += cos(a, b); return s / (A.length * B.length); };
/**
 * How alike two pictures' people are, by their CLEAR faces: each picture's faces sorted into people, and two of them
 * compared on all their faces together — the average, not the best pair. (The best of 45 pairs — a speaker read in
 * nine frames, a moment in five — found two different people 0.3–0.44 alike by chance and kept most of the night out;
 * the average does not grow with the frames read.)
 */
function alikeClear(a, b) {
  let best = -1;
  for (const A of groupsOf(a)) for (const B of groupsOf(b)) best = Math.max(best, meanLike(A, B));
  return best;
}
/*
 * ►► TALKING, OR JUST SITTING THERE? ◄◄ "A man just sitting down not saying anything, just looking — I don't want
 * that." Over about 2.5 seconds a talking mouth opens and closes: the most its lined-up picture changes between any
 * two frames was 0.9 to 1.4 for people talking on Gospel Jamz, and 0.25 to 0.84 for the man on the panel listening
 * (nine frames 0.3 s apart, the person the picture is of). With fewer than five frames of them it cannot be said.
 * `faces`: one person's prints in the order they were read. → { talking, spread } or null.
 */
const TALKING = 0.88;
function talkOf(faces) {
  const ms = (faces || []).map((f) => f.mouth).filter(Boolean);
  if (ms.length < 5) return null;
  let spread = 0;
  for (let i = 1; i < ms.length; i++) for (let j = 0; j < i; j++) {
    let d = 0; const a = ms[i], b = ms[j];
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
    spread = Math.max(spread, d / a.length);
  }
  return { talking: spread >= TALKING, spread: +spread.toFixed(2) };
}
/** One person (true), two (false), or it cannot be told by their faces (null). */
function judge(a, b) {
  // (clear faces both: they alone decide — the blurred and turned ones beside them only add chances of a false match;
  //  one person's clear faces never averaged under 0.35 on Gospel Jamz)
  const ca = clearOf(a), cb = clearOf(b);
  if (ca.length && cb.length) return alikeClear(ca, cb) >= CLEAR_SAME;
  if (likeness(a, b) >= ALIKE) return true;
  return null;
}
/** How alike two pictures' people are: the closest pair of their faces (-1 when either has none). */
function likeness(a, b) {
  let best = -1;
  for (const x of a || []) for (const y of b || []) best = Math.max(best, cos(x, y));
  return best;
}
/** One person in both (a face of one is the face of the other). */
function samePerson(a, b) { return likeness(a, b) >= SAME; }

const exp = module.exports = { debug: null, available, printsIn, printsAt, likeness, samePerson, judge, alikeClear, groupsOf, clear, clearOf, talkOf, TALKING, SAME, ALIKE, CLEAR_SAME, CLEAR, MODEL, _align: align, _similarity: similarity };
