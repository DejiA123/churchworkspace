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

async function printOf(rgb, W, H, m) {
  const s = await open();
  const r = await s.run({ [s.inputNames[0]]: new (runtime().Tensor)('float32', align(rgb, W, H, m), [1, 3, 112, 112]) });
  const e = r[s.outputNames[0]].data;
  let n = 0;
  for (const x of e) n += x * x;
  n = Math.sqrt(n) || 1;
  const p = Float32Array.from(e, (x) => x / n);
  if (exp.debug) exp.debug(align(rgb, W, H, m), m);
  return p;
}

/**
 * The face prints in one frame already read ({ rgb, width, height }), of the faces whose middle is between `x0` and
 * `x1` (shares of the width: the part a 9:16 cut shows). The frame is handed over.
 */
async function printsIn(fr, x0 = 0, x1 = 1) {
  if (!available()) return [];
  const { width: W, height: H } = fr;
  const keep = fr.rgb.slice();
  const faces = (await detector().peopleIn(fr)).filter((p) => p.face && p.score >= 0.4 && p.face.x >= x0 && p.face.x <= x1).map((p) => p.face);
  if (!faces.length) return [];
  const marks = await detector().marksIn({ rgb: keep.slice(), width: W, height: H }, faces);
  const out = [];
  for (const m of marks) {
    if (!m || m.s < SURE || Math.hypot(m.eyeL[0] - m.eyeR[0], m.eyeL[1] - m.eyeR[1]) < MIN_EYES) continue;
    out.push(await printOf(keep, W, H, m));
  }
  return out;
}

/**
 * The faces a picture shows: video `file` (w×h) round source time `t`, cut 9:16 (or W:H) round `fx` — three frames
 * 0.8 s apart (or `n`, `step` s apart). [] when none can be told (no one facing, too small, not available here).
 */
async function printsAt(ffmpeg, file, t, fx, w, h, W = 1080, H = 1920, { n = 3, step = 0.8 } = {}) {
  if (!available() || !(w > 0 && h > 0)) return [];
  const share = Math.min(1, (h * W / H) / w);
  const c = fx == null || !Number.isFinite(fx) ? 0.5 : Math.max(0, Math.min(1, fx));
  const x0 = Math.max(0, Math.min(1 - share, c - share / 2));
  let frames = [];
  try { frames = await detector().framesRgb(ffmpeg, file, Math.max(0, t - step * (n - 1) / 2), n, step, w, h, 1280); } catch (e) { return []; }
  const all = [];
  for (const fr of frames) { try { all.push(...await printsIn(fr, x0, x0 + share)); } catch (e) { /* that frame only */ } }
  return all;
}

const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/** How alike two pictures' people are: the closest pair of their faces (-1 when either has none). */
function likeness(a, b) {
  let best = -1;
  for (const x of a || []) for (const y of b || []) best = Math.max(best, cos(x, y));
  return best;
}
/** One person in both (a face of one is the face of the other). */
function samePerson(a, b) { return likeness(a, b) >= SAME; }

const exp = module.exports = { debug: null, available, printsIn, printsAt, likeness, samePerson, SAME, MODEL, _align: align, _similarity: similarity };
