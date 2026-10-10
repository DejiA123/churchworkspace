/*
 * ►► THE PERSON DETECTOR, IN A THREAD OF ITS OWN (persondetect.js). ◄◄
 *
 * MediaPipe's pose DETECTOR — the first stage of the body tracker the studio's
 * Reframe runs in the browser — run here on the server's own processor with
 * LiteRT.js (WebAssembly, no GPU, no download). It finds real people: a face,
 * where the shoulders are, and how far the upper body reaches. A face on a
 * poster or a screen is not what it was trained to find.
 *
 * The model is bin/ai/person_detector.tflite: MediaPipe's pose_detector.tflite
 * (from pose_landmarker_lite.task, Apache-2.0) with its packed (sparse) weights
 * written out plain — LiteRT.js does not read packed weights — checked to give
 * the same answers as the original to the last bit.
 *
 * LiteRT.js is written for a browser page: the few things it looks for there
 * (self, importScripts) are given here, in this thread only.
 */
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { createRequire } from 'module';
import { parentPort, workerData } from 'worker_threads';

globalThis.self = globalThis;
globalThis.require = createRequire(import.meta.url);
globalThis.importScripts = (...urls) => {
  for (const u of urls) {
    const f = String(u).replace(/^file:\/\//, '');
    globalThis.__dirname = path.dirname(f);
    vm.runInThisContext(fs.readFileSync(f, 'utf8'), { filename: f });
  }
};
// (LiteRT prints its loading notes; this thread has nothing to say on its own)
console.log = () => {}; console.info = () => {}; console.warn = () => {};

const SIZE = 224;
let model = null, Tensor = null;
const anchors = [];
{
  // SSD anchors as MediaPipe makes them for this model: strides 8,16,32,32,32, two per cell
  const strides = [8, 16, 32, 32, 32];
  let l = 0;
  while (l < strides.length) {
    let n = 0, last = l;
    while (last < strides.length && strides[last] === strides[l]) { n += 2; last++; }
    const fm = Math.ceil(SIZE / strides[l]);
    for (let y = 0; y < fm; y++) for (let x = 0; x < fm; x++) for (let k = 0; k < n; k++) anchors.push([(x + 0.5) / fm, (y + 0.5) / fm]);
    l = last;
  }
}
const sig = (v) => 1 / (1 + Math.exp(-Math.max(-100, Math.min(100, v))));

async function load() {
  if (model) return;
  const lrt = await import('@litertjs/core');
  Tensor = lrt.Tensor;
  const wasmDir = path.join(path.dirname(createRequire(import.meta.url).resolve('@litertjs/core/package.json')), 'wasm') + '/';
  await lrt.loadLiteRt(wasmDir);
  model = await lrt.loadAndCompile(new Uint8Array(fs.readFileSync(workerData.model)), { accelerator: 'wasm' });
}

/** A square region of an RGB picture → the model's 224×224 input in [-1, 1] (bilinear). */
function square(rgb, W, H, x0, y0, S) {
  const f = new Float32Array(SIZE * SIZE * 3);
  const k = S / SIZE;
  for (let y = 0; y < SIZE; y++) {
    const sy = y0 + (y + 0.5) * k - 0.5;
    const yA = Math.floor(sy), fy = sy - yA;
    for (let x = 0; x < SIZE; x++) {
      const sx = x0 + (x + 0.5) * k - 0.5;
      const xA = Math.floor(sx), fx = sx - xA;
      const o = (y * SIZE + x) * 3;
      for (let c = 0; c < 3; c++) {
        const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 0 : rgb[(yy * W + xx) * 3 + c];
        const v = (1 - fy) * ((1 - fx) * px(xA, yA) + fx * px(xA + 1, yA)) + fy * ((1 - fx) * px(xA, yA + 1) + fx * px(xA + 1, yA + 1));
        f[o + c] = v / 127.5 - 1;
      }
    }
  }
  return f;
}

/** The people in one square region, in the picture's own pixels. */
async function detectIn(rgb, W, H, x0, y0, S, minScore) {
  const t = new Tensor(square(rgb, W, H, x0, y0, S), [1, SIZE, SIZE, 3]);
  const r = await model.run(t);
  t.delete();
  const a = await r[0].moveTo('wasm'), b = await r[1].moveTo('wasm');
  const reg = a.toTypedArray(), sc = b.toTypedArray();
  a.delete(); b.delete();
  const out = [];
  for (let i = 0; i < anchors.length; i++) {
    const s = sig(sc[i]);
    if (s < minScore) continue;
    const [ax, ay] = anchors[i], o = i * 12;
    const pt = (q) => [x0 + (reg[o + 4 + 2 * q] / SIZE + ax) * S, y0 + (reg[o + 5 + 2 * q] / SIZE + ay) * S];
    const cx = x0 + (reg[o] / SIZE + ax) * S, cy = y0 + (reg[o + 1] / SIZE + ay) * S;
    const w = (reg[o + 2] / SIZE) * S, h = (reg[o + 3] / SIZE) * S;
    const sh = pt(2), up = pt(3);
    out.push({ s, cx, cy, w, h, shx: sh[0], shy: sh[1], r: Math.hypot(up[0] - sh[0], up[1] - sh[1]) });
  }
  return out;
}

/**
 * Everyone in a picture: the whole picture, then overlapping squares of its
 * height (a speaker across a wide 16:9 shot is too small in one 224-pixel look),
 * the duplicates merged. Coordinates come back as shares of the picture (0..1).
 */
async function detect({ rgb, width: W, height: H, minScore = 0.5 }) {
  await load();
  const S = Math.max(W, H);
  let found = await detectIn(rgb, W, H, (W - S) / 2, (H - S) / 2, S, minScore);
  if (W > H * 1.15) {
    const n = Math.max(2, Math.ceil(W / H) + 1);
    for (let i = 0; i < n; i++) found = found.concat(await detectIn(rgb, W, H, ((W - H) * i) / (n - 1), 0, H, minScore));
  } else if (H > W * 1.15) {
    const n = Math.max(2, Math.ceil(H / W) + 1);
    for (let i = 0; i < n; i++) found = found.concat(await detectIn(rgb, W, H, 0, ((H - W) * i) / (n - 1), W, minScore));
  }
  found.sort((x, y) => y.s - x.s);
  const keep = [];
  for (const d of found) {
    if (!keep.some((k) => Math.abs(k.cx - d.cx) < Math.max(k.w, d.w) * 0.7 && Math.abs(k.cy - d.cy) < Math.max(k.h, d.h) * 0.7)) keep.push(d);
  }
  return keep.map((d) => ({
    score: Math.round(d.s * 100) / 100,
    face: { x: d.cx / W, y: d.cy / H, w: d.w / W, h: d.h / H },
    // the upper body: from the shoulders' middle, this far either way
    body: { x0: Math.max(0, (Math.min(d.shx, d.cx) - d.r) / W), x1: Math.min(1, (Math.max(d.shx, d.cx) + d.r) / W) },
  }));
}

parentPort.on('message', async (m) => {
  try { parentPort.postMessage({ id: m.id, ok: true, people: await detect(m) }); }
  catch (e) { parentPort.postMessage({ id: m.id, ok: false, why: (e && e.message) || String(e) }); }
});
