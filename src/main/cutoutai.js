'use strict';
/*
 * ►► A PERSON CUT OUT, PROPERLY — ON THIS SERVER. ◄◄
 *
 * The flyers' speaker photos were cut out on the phone by MediaPipe's selfie
 * model: 256×256, made for a face held up to a camera. On full-length stage
 * photos it took arms and feet off and left bits of the lectern, the chair and
 * the stage smoke ("the crop of the pictures are terrible — it must be perfect").
 *
 * This is BiRefNet (MIT), the portrait-trained weights, as rembg publishes them
 * (ONNX): it looks at the picture at 1024×1024 and finds the person with their
 * hair, fingers, the microphone and what they hold. Measured on Gospel Jamz
 * stage frames against U²-Net (human), IS-Net and BiRefNet-lite: the only one
 * with no logo letters left beside the person and nothing of them missing.
 *
 * It runs here (onnxruntime-node, the narrator's runtime): free, no key, no
 * allowance, nothing sent anywhere. The model (~1 GB) is fetched once into the
 * studio's data folder. Then the mask is tidied: only the person — the one
 * large shape — is kept; specks of smoke or a logo letter apart from them go,
 * and pin-holes in them are filled (a real gap, between an arm and the body,
 * stays open).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_NAME = 'BiRefNet-portrait-epoch_150.onnx';
const MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/' + MODEL_NAME;
const MODEL_BYTES = 972666916;
const SIZE = 1024;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let dir = path.join(os.tmpdir(), 'mw-cutout-model');
let ort, session = null, opening = null, fetching = null, idle = null;
let chain = Promise.resolve();   // one cut-out at a time: each uses every core
const state = { done: 0, failed: 0, lastMs: 0, why: '', fetching: false, fetched: 0 };

/** Where the model is kept (the app's data folder outlives an update). */
function setDataDir(d) { if (d) dir = path.join(d, 'cutout-model'); }
function runtime() {
  if (ort === undefined) { try { ort = require('onnxruntime-node'); } catch (e) { ort = null; } }
  return ort;
}
/** The runtime is here (the server); the model may still need fetching. */
function available() { return !!runtime(); }
const modelPath = () => path.join(dir, MODEL_NAME);
function modelReady() { try { return fs.statSync(modelPath()).size === MODEL_BYTES; } catch (e) { return false; } }
function status() { return Object.assign({ available: available(), model: modelReady(), file: MODEL_NAME }, state); }

/** The model, fetched once (resumed from where a broken download stopped). */
function fetchModel() {
  if (modelReady()) return Promise.resolve(modelPath());
  if (fetching) return fetching;
  fetching = (async () => {
    fs.mkdirSync(dir, { recursive: true });
    const part = modelPath() + '.part';
    state.fetching = true;
    for (let attempt = 0; attempt < 4 && !modelReady(); attempt++) {
      let have = 0;
      try { have = fs.statSync(part).size; } catch (e) { have = 0; }
      try {
        const res = await fetch(MODEL_URL, { headers: have ? { Range: `bytes=${have}-` } : {} });
        if (!res.ok && res.status !== 206) throw new Error('the cut-out model could not be fetched (' + res.status + ')');
        if (have && res.status !== 206) have = 0;   // (the server would not resume: from the start)
        const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
        state.fetched = have;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          state.fetched += value.length;
          if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
        if (fs.statSync(part).size === MODEL_BYTES) fs.renameSync(part, modelPath());
      } catch (e) {
        state.why = (e && e.message) || 'the cut-out model could not be fetched';
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    state.fetching = false;
    if (!modelReady()) throw new Error(state.why || 'the cut-out model could not be fetched');
    return modelPath();
  })().finally(() => { fetching = null; });
  return fetching;
}

async function openSession() {
  if (session) return session;
  if (opening) return opening;
  opening = (async () => {
    const rt = runtime();
    if (!rt) throw new Error('the cut-out runtime is not installed here');
    await fetchModel();
    session = await rt.InferenceSession.create(modelPath(), { intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length)), graphOptimizationLevel: 'all' });
    return session;
  })().finally(() => { opening = null; });
  return opening;
}
// (the model holds a few GB while open: let it go when nobody has cut anything out for ten minutes)
function release() {
  clearTimeout(idle);
  idle = setTimeout(() => { const s = session; session = null; if (s && s.release) s.release().catch(() => {}); }, 10 * 60e3);
  if (idle.unref) idle.unref();
}

function run(ffmpeg, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, args, { windowsHide: true });
    const out = [], err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().slice(-300) || 'ffmpeg failed'))));
    if (input) p.stdin.end(input); else p.stdin.end();
  });
}
async function sizeOf(ffmpeg, file) {
  const info = await new Promise((resolve) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let s = ''; p.stderr.on('data', (d) => { s += d; }); p.on('close', () => resolve(s)); p.on('error', () => resolve(''));
  });
  const m = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(info);
  if (!m) throw new Error('that picture could not be read');
  return { w: +m[1], h: +m[2] };
}

/*
 * Only the person: the mask's largest shape (on a coarse grid, where specks are easy to count), and nothing apart
 * from it; holes in it smaller than a fingertip filled. Returns the kept grid (1 = keep) and its size.
 */
function keepPerson(mask, W, H) {
  const G = 512, sc = Math.min(1, G / Math.max(W, H));
  const gw = Math.max(1, Math.round(W * sc)), gh = Math.max(1, Math.round(H * sc));
  let on = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const sx = Math.min(W - 1, Math.floor((x + 0.5) / sc)), sy = Math.min(H - 1, Math.floor((y + 0.5) / sc));
    on[y * gw + x] = mask[sy * W + sx] >= 128 ? 1 : 0;
  }
  const label = new Int32Array(gw * gh).fill(-1), sizes = [];
  const stack = new Int32Array(gw * gh);
  const flood = (start, val, want, lab) => {
    let n = 0, top = 0; stack[top++] = start; lab[start] = val;
    while (top) {
      const i = stack[--top]; n++;
      const x = i % gw, y = (i - x) / gw;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (lab[j] === -1 && on[j] === want) { lab[j] = val; stack[top++] = j; }
      }
    }
    return n;
  };
  for (let i = 0; i < on.length; i++) if (on[i] && label[i] === -1) sizes.push(flood(i, sizes.length, 1, label));
  if (!sizes.length) return null;
  let big = 0; for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[big]) big = k;
  const keep = new Uint8Array(gw * gh);
  for (let i = 0; i < keep.length; i++) keep[i] = label[i] === big ? 1 : 0;
  // holes: the background reached from the edge stays background; a pocket the size of a fingertip inside is filled
  const out = new Int32Array(gw * gh).fill(-1), offs = [];
  const was = on;
  on = keep;   // (the flood follows `on`: now the kept shape)
  for (let i = 0; i < keep.length; i++) if (keep[i] === 0 && out[i] === -1) offs.push(flood(i, offs.length, 0, out));
  on = was;
  // (which background shapes touch the edge)
  const edge = new Set();
  for (let x = 0; x < gw; x++) { if (out[x] >= 0) edge.add(out[x]); if (out[(gh - 1) * gw + x] >= 0) edge.add(out[(gh - 1) * gw + x]); }
  for (let y = 0; y < gh; y++) { if (out[y * gw] >= 0) edge.add(out[y * gw]); if (out[y * gw + gw - 1] >= 0) edge.add(out[y * gw + gw - 1]); }
  const small = Math.max(4, sizes[big] * 0.002);
  const filled = new Uint8Array(gw * gh);
  for (let i = 0; i < keep.length; i++) if (keep[i] === 0 && out[i] >= 0 && !edge.has(out[i]) && offs[out[i]] <= small) { keep[i] = 1; filled[i] = 1; }
  return { keep, filled, gw, gh, sc, kept: sizes[big], specks: sizes.length - 1 };
}

// (the edge pulled in a hair: the model's edge keeps a pixel or two of what was behind — a thin red line from the
//  stage lights down a man's arm — and its faintest soft edge with it: a pixel of choke for every 700 across)
const choke = (W, H) => Array.from({ length: Math.max(1, Math.round(Math.max(W, H) / 700)) }, () => 'erosion').join(',') + ",lut=y='clip((val-24)*255/231\\,0\\,255)'";

/**
 * The person in a picture (the bytes of a JPEG/PNG/WebP) cut out: a PNG with the background clear, at the picture's
 * own size (at most `maxSide` across). { png, coverage, ms, specks }.
 */
function cutout(ffmpeg, input, { maxSide = 2000 } = {}) {
  const job = chain.then(() => cutoutNow(ffmpeg, input, { maxSide }));
  chain = job.catch(() => {});
  return job;
}
async function cutoutNow(ffmpeg, input, { maxSide }) {
  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-cut-'));
  try {
    const src = path.join(tmp, 'in');
    fs.writeFileSync(src, input);
    const s0 = await sizeOf(ffmpeg, src);
    const k = Math.min(1, maxSide / Math.max(s0.w, s0.h));
    const W = Math.max(2, Math.round(s0.w * k / 2) * 2), H = Math.max(2, Math.round(s0.h * k / 2) * 2);
    // the picture for the model (1024×1024, as it was trained) and at its own size for the result
    const small = await run(ffmpeg, ['-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale=${SIZE}:${SIZE}:flags=lanczos,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const full = await run(ffmpeg, ['-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale=${W}:${H}:flags=lanczos,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    if (small.length < SIZE * SIZE * 3 || full.length < W * H * 3) throw new Error('that picture could not be read');
    let mx = 1; for (let i = 0; i < SIZE * SIZE * 3; i++) if (small[i] > mx) mx = small[i];
    const x = new Float32Array(3 * SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) for (let c = 0; c < 3; c++) x[c * SIZE * SIZE + i] = (small[i * 3 + c] / mx - MEAN[c]) / STD[c];
    const sess = await openSession();
    const rt = runtime();
    const res = await sess.run({ [sess.inputNames[0]]: new rt.Tensor('float32', x, [1, 3, SIZE, SIZE]) });
    release();
    const o = res[sess.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    const p = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < p.length; i++) { const v = 1 / (1 + Math.exp(-o[i])); p[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const m1 = Buffer.alloc(SIZE * SIZE);
    for (let i = 0; i < p.length; i++) m1[i] = Math.round(255 * (p[i] - lo) / Math.max(1e-6, hi - lo));
    // the mask at the picture's size (smoothly)
    const mask = await run(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SIZE}x${SIZE}`, '-i', '-', '-vf', `scale=${W}:${H}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], m1);
    const kp = keepPerson(mask, W, H);
    if (!kp) throw new Error('nobody could be found in that picture');
    // only the person: what is outside the kept shape (a little beyond its edge, for the soft hair) goes
    const alpha = Buffer.alloc(W * H);
    const reach = 2;   // grid cells (about 1% of the picture): the feathered edge is the model's own
    const near = new Uint8Array(kp.gw * kp.gh);
    for (let y = 0; y < kp.gh; y++) for (let x2 = 0; x2 < kp.gw; x2++) {
      if (!kp.keep[y * kp.gw + x2]) continue;
      for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
        const nx = x2 + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < kp.gw && ny < kp.gh) near[ny * kp.gw + nx] = 1;
      }
    }
    let covered = 0;
    for (let y = 0; y < H; y++) {
      const gy = Math.min(kp.gh - 1, Math.floor(y * kp.sc));
      for (let x2 = 0; x2 < W; x2++) {
        const gi = gy * kp.gw + Math.min(kp.gw - 1, Math.floor(x2 * kp.sc)), i = y * W + x2;
        // (a filled pin-hole: solid; the person and the edge round them: the model's own soft alpha; the rest: clear)
        alpha[i] = kp.filled[gi] ? 255 : near[gi] ? mask[i] : 0;
        if (alpha[i] >= 128) covered++;
      }
    }
    fs.writeFileSync(path.join(tmp, 'rgb'), full.subarray(0, W * H * 3));
    fs.writeFileSync(path.join(tmp, 'a'), alpha);
    const png = await run(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', path.join(tmp, 'rgb'),
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', path.join(tmp, 'a'), '-filter_complex', `[1:v]${choke(W, H)}[a];[0:v][a]alphamerge,format=rgba`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
    state.done++; state.lastMs = Date.now() - t0; state.why = '';
    return { png, w: W, h: H, coverage: covered / (W * H), ms: state.lastMs, specks: kp.specks };
  } catch (e) {
    state.failed++; state.why = (e && e.message) || 'the cut-out failed';
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* the temp folder */ }
  }
}

module.exports = { available, status, cutout, fetchModel, setDataDir, modelReady, keepPerson, MODEL_NAME, MODEL_URL };
