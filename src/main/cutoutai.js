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
/*
 * ►► HOW FAR ALONG. ◄◄ A cut-out takes half a minute; with nothing moving the
 * phone "looks like it's stuck". Each one comes with a ticket from the phone,
 * and the phone asks after it: where it is in the queue, which step it is on
 * (reading the photo, loading the model, the model looking at it, finishing
 * the edges), and how far through that step — timed by how long the same step
 * took the last time. The first one ever is the model's download, counted in
 * bytes.
 */
const jobs = new Map();   // ticket -> { stage, at }
const queue = [];         // tickets, in order: the first is the one being cut
const took = { reading: 1500, loading: 8000, thinking: 20000, finishing: 6000 };   // learned, each time
const SPANS = { reading: [0, 0.08], loading: [0.08, 0.22], thinking: [0.22, 0.86], finishing: [0.86, 1] };
function stage(ticket, name) {
  const j = ticket && jobs.get(ticket); if (!j) return;
  const now = Date.now();
  if (j.stage && took[j.stage] != null) took[j.stage] = Math.round(took[j.stage] * 0.4 + (now - j.at) * 0.6);
  j.stage = name; j.at = now;
}
function progress(ticket) {
  const j = ticket && jobs.get(ticket);
  if (!j) return null;
  if (state.fetching) return { stage: 'downloading', pct: Math.min(0.99, state.fetched / MODEL_BYTES), mb: Math.round(state.fetched / 1048576), of: Math.round(MODEL_BYTES / 1048576) };
  if (!j.stage) return { stage: 'waiting', ahead: Math.max(0, queue.indexOf(ticket)), pct: 0 };
  if (j.stage === 'done') return { stage: 'done', pct: 1 };
  const [a, b] = SPANS[j.stage] || [0, 1], len = Math.max(400, took[j.stage] || 5000);
  // (and how fast it should go on: the server is busy while it cuts, so the phone keeps the bar moving between answers)
  return { stage: j.stage, pct: a + (b - a) * Math.min(0.95, (Date.now() - j.at) / len), to: a + (b - a) * 0.95, rate: (b - a) / len * 1000 };
}

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
function status(ticket) { return Object.assign({ available: available(), model: modelReady(), file: MODEL_NAME, queue: queue.length }, state, ticket ? { job: progress(ticket) } : {}); }

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

// (how close round the body: the limbs' widths as a share of the measured ones, the margin and the soft edge in shoulder widths)
const GATE = { limbs: 0.75, margin: 0.04, feather: 0.08 };
/*
 * ►► ONLY WHAT IS THEM. ◄◄ The model cuts out what stands out — and the acrylic lectern he leans on, the mic stand in
 * front of him, the chair beside him and the table with the plants stand out too (Bishop Richman's photos: four of
 * nine). The phone's pose model knows where his body is: 33 points, shoulders to feet (MediaPipe, on the phone).
 * Round them goes a body: the head and hair, the torso as wide as the shoulders, every limb as a rounded bar, room
 * round each hand for what it holds (the microphone), between the legs for a robe or a dress, and a little more for
 * a loose jacket. What the model kept outside that body goes. `lm`: [{ x, y, v }] 0..1 across the picture.
 * Returns a gate on the grid (0..1), or null when there is no body to go by.
 */
function bodyGate(lm, W, H, gw, gh, k = GATE) {
  if (!Array.isArray(lm) || lm.length < 33) return null;
  const P = lm.map((p) => ({ x: Number(p.x) * W, y: Number(p.y) * H }));
  if (P.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return null;
  const mid = (a, b) => ({ x: (P[a].x + P[b].x) / 2, y: (P[a].y + P[b].y) / 2 });
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const sh = mid(11, 12), hp = mid(23, 24);
  const s = Math.max(d(P[11], P[12]), 0.55 * d(sh, hp), 8);   // (the body's scale: shoulder width, or half the torso side-on)
  if (s < 8) return null;
  const head = { x: (P[0].x + P[7].x + P[8].x) / 3, y: (P[0].y + P[7].y + P[8].y) / 3 };
  const caps = [];   // [ax, ay, bx, by, r]
  const cap = (a, b, r) => caps.push([a.x, a.y, b.x, b.y, r * s * (r >= 0.8 ? 1 : k.limbs)]);
  cap(head, head, 0.85);                                  // the head and the hair
  cap(head, sh, 0.45);                                    // the neck
  cap(P[11], P[12], 0.45); cap(P[23], P[24], 0.5);        // shoulders, hips
  cap(P[11], P[23], 0.5); cap(P[12], P[24], 0.5); cap(sh, hp, 0.8);   // the torso
  cap(P[11], P[13], 0.33); cap(P[12], P[14], 0.33);       // upper arms
  cap(P[13], P[15], 0.3); cap(P[14], P[16], 0.3);         // forearms
  for (const [w, a, b, c] of [[15, 17, 19, 21], [16, 18, 20, 22]]) {   // hands, and what they hold
    for (const k of [a, b, c]) cap(P[w], P[k], 0.3);
    cap(mid(a, b), mid(a, b), 0.45);
  }
  cap(P[23], P[25], 0.38); cap(P[24], P[26], 0.38);       // thighs
  cap(P[25], P[27], 0.32); cap(P[26], P[28], 0.32);       // shins
  for (const [a, h, t] of [[27, 29, 31], [28, 30, 32]]) { cap(P[a], P[h], 0.25); cap(P[a], P[t], 0.25); cap(P[h], P[t], 0.22); }   // feet
  const kn = mid(25, 26), an = mid(27, 28);
  cap(hp, kn, 0.3 + 0.5 * d(P[25], P[26]) / s); cap(kn, an, 0.25 + 0.5 * d(P[27], P[28]) / s);   // a robe, a dress
  const feather = k.feather * s, margin = k.margin * s;
  const gate = new Float32Array(gw * gh);
  const sx = W / gw, sy = H / gh;
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const px = (x + 0.5) * sx, py = (y + 0.5) * sy;
    let best = Infinity;
    for (const [ax, ay, bx, by, r] of caps) {
      const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
      const t = L ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) : 0;
      const dd = Math.hypot(px - (ax + t * vx), py - (ay + t * vy)) - r - margin;
      if (dd < best) best = dd;
      if (best <= 0) break;
    }
    gate[y * gw + x] = best <= 0 ? 1 : best >= feather ? 0 : 1 - best / feather;
  }
  return gate;
}

/*
 * ►► SOMETHING IN FRONT OF THEM: WAIST UP. ◄◄ A lectern he stands behind, a table with plants before him, a chair at
 * his hip: the model keeps them (they stand out as much as he does), and the clear acrylic lecterns show him through
 * them — no cut can take them away. What the flyers use then is what a designer would: him from the waist up, the
 * picture fading out just above what is in front of him. Found as what the model kept that is NOT his body (outside
 * bodyGate), below his shoulders, and the size of a thing (0.08 of a shoulder width squared or more — not a
 * jacket's edge; measured on nine photos of one bishop: no false ones). Returns the line (picture px) to fade out above, or null when nothing stands in front of him.
 */
let OBSTRUCT = 0.08;
function obstruction(mask, gate, W, H, gw, gh, lm) {
  if (!gate || !Array.isArray(lm) || lm.length < 33) return null;
  const sx = W / gw, sy = H / gh;
  const sh = Math.min(lm[11].y, lm[12].y) * H, hipY = (lm[23].y + lm[24].y) / 2 * H;
  const s = Math.max(Math.hypot((lm[11].x - lm[12].x) * W, (lm[11].y - lm[12].y) * H), 0.55 * Math.abs(hipY - sh), 8);
  const out = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const py = (y + 0.5) * sy;
    if (py < sh + 0.25 * s) continue;
    const mx = Math.min(W - 1, Math.floor((x + 0.5) * sx)), my = Math.min(H - 1, Math.floor(py));
    // (a clear acrylic lectern comes out half see-through: counted from 64)
    if (mask[my * W + mx] >= 64 && gate[y * gw + x] < 0.5) out[y * gw + x] = 1;
  }
  // the pieces of it, each the size of a thing or not
  const seen = new Uint8Array(gw * gh), stack = new Int32Array(gw * gh);
  const minCells = (OBSTRUCT * s * s) / (sx * sy);
  let top = Infinity;
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || seen[i]) continue;
    let n = 0, t = 0, minY = Infinity; stack[t++] = i; seen[i] = 1;
    while (t) {
      const j = stack[--t]; n++;
      const x = j % gw, y = (j - x) / gw;
      if (y < minY) minY = y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const k = ny * gw + nx;
        if (out[k] && !seen[k]) { seen[k] = 1; stack[t++] = k; }
      }
    }
    if (n >= minCells) top = Math.min(top, minY * sy);
  }
  if (!Number.isFinite(top)) return null;
  // (never above the chest: a portrait keeps the head and shoulders whatever is in front)
  return Math.max(top, sh + 0.6 * s);
}

/*
 * The model's mask (0..255, the picture's size), tidied in place with the body from the phone's pose (null: as it
 * is): waist up when something stands in front of them (obstruction), and only what is them (bodyGate).
 */
function tidyMask(mask, W, H, pose) {
  // only what is them (bodyGate — from the phone's pose of the same picture), before the shapes are counted: a
  // lectern's edge cut off from them by it is then a speck apart, and goes
  let gated = 0, waistUp = null;
  if (pose) {
    const gw = Math.max(1, Math.round(W / 4)), gh = Math.max(1, Math.round(H / 4));
    const g = bodyGate(pose, W, H, gw, gh);
    // something in front of them (before the gate takes the rest of it away): from there down, fade out
    waistUp = g ? obstruction(mask, g, W, H, gw, gh, pose) : null;
    if (waistUp != null) {
      // (the fade ends a little above where the thing was first found outside the body: a lectern's top runs on
      //  between the hands, inside it; never above the chest)
      const sPx = Math.max(8, Math.hypot((pose[11].x - pose[12].x) * W, (pose[11].y - pose[12].y) * H));
      const shY = Math.min(pose[11].y, pose[12].y) * H;
      // (and above the hands: hands rest on what is in front of him — the lectern's top runs between them, where no
      //  gate can tell it from him; Bishop Richman at the acrylic lectern, twice)
      const hands = Math.min(pose[15].y, pose[16].y) * H;
      // (a short fade: a long one kept the lectern's bright top edge as a thin white line along the bottom)
      const fade = 0.15 * sPx, end = Math.max(Math.min(waistUp - 0.5 * sPx, hands - 0.3 * sPx), shY + 0.6 * sPx);
      for (let y = Math.max(0, Math.floor(end - fade)); y < H; y++) {
        const v = y >= end ? 0 : (end - y) / fade;
        for (let x2 = 0; x2 < W; x2++) mask[y * W + x2] = Math.round(mask[y * W + x2] * v);
      }
    }
    if (g) {
      for (let y = 0; y < H; y++) {
        const fy = Math.min(gh - 1, (y + 0.5) / 4 - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(gh - 1, y0 + 1), ty = Math.max(0, fy - y0);
        for (let x2 = 0; x2 < W; x2++) {
          const fx = Math.min(gw - 1, (x2 + 0.5) / 4 - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(gw - 1, x0 + 1), tx = Math.max(0, fx - x0);
          const v = (g[y0 * gw + x0] * (1 - tx) + g[y0 * gw + x1] * tx) * (1 - ty) + (g[y1 * gw + x0] * (1 - tx) + g[y1 * gw + x1] * tx) * ty;
          const i = y * W + x2;
          // (at the body's edge only what is solid: a see-through bit of acrylic by the hand goes, the hair — inside
          //  the head's round — keeps its soft edge)
          if (v < 0.999) { const before = mask[i]; mask[i] = before >= 200 ? Math.round(before * v) : 0; if (before >= 128 && mask[i] < 128) gated++; }
        }
      }
    }
  }
  return { gated, waistUp };
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
function cutout(ffmpeg, input, { maxSide = 2000, pose = null, ticket = null } = {}) {
  const t = ticket ? String(ticket).slice(0, 40) : 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  jobs.set(t, { stage: null, at: Date.now() }); queue.push(t);
  const job = chain.then(() => cutoutNow(ffmpeg, input, { maxSide, pose, ticket: t }));
  chain = job.catch(() => {});
  // (forgotten a little after it ends: the phone's last question still finds it done)
  const forget = () => { const i = queue.indexOf(t); if (i >= 0) queue.splice(i, 1); const tm = setTimeout(() => jobs.delete(t), 15000); if (tm.unref) tm.unref(); };
  job.then(forget, forget);
  return job;
}
async function cutoutNow(ffmpeg, input, { maxSide, pose, ticket }) {
  const t0 = Date.now();
  stage(ticket, 'reading');
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
    if (!session) stage(ticket, 'loading');
    const sess = await openSession();
    const rt = runtime();
    stage(ticket, 'thinking');
    const res = await sess.run({ [sess.inputNames[0]]: new rt.Tensor('float32', x, [1, 3, SIZE, SIZE]) });
    release();
    stage(ticket, 'finishing');
    const o = res[sess.outputNames[0]].data;
    let lo = Infinity, hi = -Infinity;
    const p = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < p.length; i++) { const v = 1 / (1 + Math.exp(-o[i])); p[i] = v; if (v < lo) lo = v; if (v > hi) hi = v; }
    const m1 = Buffer.alloc(SIZE * SIZE);
    for (let i = 0; i < p.length; i++) m1[i] = Math.round(255 * (p[i] - lo) / Math.max(1e-6, hi - lo));
    // the mask at the picture's size (smoothly)
    const mask = await run(ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${SIZE}x${SIZE}`, '-i', '-', '-vf', `scale=${W}:${H}:flags=bicubic`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], m1);
    const { gated, waistUp } = tidyMask(mask, W, H, pose);
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
    stage(ticket, 'done');
    state.done++; state.lastMs = Date.now() - t0; state.why = '';
    return { png, w: W, h: H, coverage: covered / (W * H), ms: state.lastMs, specks: kp.specks, gated: gated / (W * H), waistUp: waistUp != null };
  } catch (e) {
    state.failed++; state.why = (e && e.message) || 'the cut-out failed';
    throw e;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* the temp folder */ }
  }
}

module.exports = { available, status, cutout, fetchModel, setDataDir, modelReady, keepPerson, bodyGate, obstruction, tidyMask, GATE, MODEL_NAME, MODEL_URL, _obstruct: (v) => { OBSTRUCT = v; } };
