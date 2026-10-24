'use strict';
/*
 * ►► FIND THE PEOPLE IN A FRAME — ON THE SERVER, FOR CERTAIN. ◄◄
 *
 * The Viral Montage cuts a wide shot down to a narrow 9:16 one, and a person
 * must be in it. The vision AI's look at a grid of frames (cloudsee.js) is a
 * judgement — it once put the cut on a poster with a face drawn on it while
 * the singer stood beside it. This is a detector: MediaPipe's own person
 * detector (the studio's Reframe uses its big brother in the browser), run on
 * this machine's processor in a thread of its own (persondetect-worker.mjs).
 * Free, no key, nothing sent anywhere, about a tenth of a second a look.
 *
 * What it finds is a real person; what it can miss is someone small and far
 * off, or with their back turned — so it never decides on its own that a
 * moment has nobody in it. The montage puts the two together (montage.js).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MODEL = path.join(__dirname, '..', '..', 'bin', 'ai', 'person_detector.tflite');
let worker = null, broken = '', seq = 0;
const waiting = new Map();

function available() {
  if (broken) return false;
  try { require.resolve('@litertjs/core/package.json'); } catch (e) { return false; }
  return fs.existsSync(MODEL);
}
function why() { return broken || (available() ? '' : 'the person detector is not installed here'); }

function start() {
  if (worker) return worker;
  const { Worker } = require('worker_threads');
  worker = new Worker(path.join(__dirname, 'persondetect-worker.mjs'), { workerData: { model: MODEL }, stderr: true, stdout: true });
  worker.unref();
  // (the runtime's own loading notes are not the studio's to show)
  worker.stderr.resume(); worker.stdout.resume();
  worker.on('message', (m) => { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); w(m); } });
  const fail = (e) => {
    broken = 'the person detector stopped: ' + ((e && e.message) || e);
    for (const w of waiting.values()) w({ ok: false, why: broken });
    waiting.clear(); worker = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => { if (code) fail(new Error('exit ' + code)); else worker = null; });
  return worker;
}

/** One frame of a video as RGB, at most `maxW` wide (its own shape kept). */
function frameRgb(ffmpegPath, file, t, maxW = 960) {
  // (no seek at the very start: a still picture has nothing to seek in)
  const seek = t > 0 ? ['-ss', String(t)] : [];
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-v', 'error', ...seek, '-i', file, '-frames:v', '1',
      '-vf', `scale='min(${maxW},iw)':-2`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
    // the size first, so the bytes can be read as a picture
    const probe = spawn(ffmpegPath, ['-hide_banner', '-v', 'info', ...seek, '-i', file, '-frames:v', '1',
      '-vf', `scale='min(${maxW},iw)':-2,showinfo`, '-f', 'null', '-'], { windowsHide: true });
    let info = '';
    probe.stderr.on('data', (d) => { info += d; });
    probe.on('error', reject);
    probe.on('close', () => {
      const m = /s:(\d+)x(\d+)/.exec(info);
      if (!m) return reject(new Error('could not read that frame'));
      const W = +m[1], H = +m[2];
      const p = spawn(ffmpegPath, args, { windowsHide: true });
      const out = [];
      p.stdout.on('data', (d) => out.push(d));
      p.on('error', reject);
      p.on('close', () => {
        const rgb = Buffer.concat(out);
        if (rgb.length < W * H * 3) return reject(new Error('the frame came out short'));
        resolve({ rgb: new Uint8Array(rgb.buffer, rgb.byteOffset, W * H * 3), width: W, height: H });
      });
    });
  });
}

/**
 * `n` frames of a video `w`×`h`, `step` seconds apart from `t0`, in ONE read (a look each was a second apiece on a
 * 2 GB, 3¾-hour video: the seek is the cost): [{ rgb, width, height }], fewer near the end of the video.
 */
function framesRgb(ffmpegPath, file, t0, n, step, w, h, maxW = 960) {
  const W = Math.max(2, Math.floor(Math.min(maxW, w) / 2) * 2), H = Math.max(2, Math.round((h * W) / w / 2) * 2);
  const args = ['-hide_banner', '-v', 'error', '-ss', String(Math.max(0, t0)), '-t', String(step * (n - 1) + 0.4), '-i', file,
    '-vf', `select='isnan(prev_selected_t)+gte(t-prev_selected_t,${(step - 0.02).toFixed(3)})',scale=${W}:${H},setsar=1`,
    '-fps_mode', 'passthrough', '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    const out = [];
    p.stdout.on('data', (d) => out.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const all = Buffer.concat(out), one = W * H * 3, frames = [];
      for (let k = 0; (k + 1) * one <= all.length && k < n; k++) {
        const rgb = new Uint8Array(one);
        rgb.set(all.subarray(k * one, (k + 1) * one));
        frames.push({ rgb, width: W, height: H });
      }
      if (!frames.length) return reject(new Error('could not read those frames'));
      resolve(frames);
    });
  });
}

/**
 * The people in a video at `t` seconds: [{ score, face:{x,y,w,h}, body:{x0,x1} }]
 * as shares of the picture (0 left … 1 right). Rejects when it cannot look.
 */
async function people(ffmpegPath, file, t) {
  if (!available()) throw new Error(why());
  return peopleIn(await frameRgb(ffmpegPath, file, t));
}
/** The people in a frame already read (frameRgb) — it is handed over, so read it first if it is wanted too. */
function peopleIn(fr) {
  if (!available()) return Promise.reject(new Error(why()));
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the person detector took too long')); }, 60000);
    waiting.set(id, (m) => { clearTimeout(timer); if (m.ok) resolve(m.people); else reject(new Error(m.why)); });
    w.postMessage({ id, rgb: fr.rgb, width: fr.width, height: fr.height }, [fr.rgb.buffer]);
  });
}

function stop() { if (worker) { try { worker.terminate(); } catch (e) {} worker = null; } }

module.exports = { available, why, people, peopleIn, frameRgb, framesRgb, stop, MODEL };
