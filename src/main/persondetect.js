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
 * The people in a video at `t` seconds: [{ score, face:{x,y,w,h}, body:{x0,x1} }]
 * as shares of the picture (0 left … 1 right). Rejects when it cannot look.
 */
async function people(ffmpegPath, file, t) {
  if (!available()) throw new Error(why());
  const fr = await frameRgb(ffmpegPath, file, t);
  const w = start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('the person detector took too long')); }, 60000);
    waiting.set(id, (m) => { clearTimeout(timer); if (m.ok) resolve(m.people); else reject(new Error(m.why)); });
    w.postMessage({ id, rgb: fr.rgb, width: fr.width, height: fr.height }, [fr.rgb.buffer]);
  });
}

function stop() { if (worker) { try { worker.terminate(); } catch (e) {} worker = null; } }

module.exports = { available, why, people, frameRgb, stop, MODEL };
