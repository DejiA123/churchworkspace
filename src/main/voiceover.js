'use strict';
/*
 * ►► A REAL VOICE, ON THIS SERVER. ◄◄
 *
 * The Viral Montage can open with a narrator ("This changed everything he
 * thought about prayer…") and close with one ("Share this with someone who
 * needs it."). The voice is Kokoro — an open text-to-speech model (82M
 * parameters, Apache-2.0) that sounds like a person, not a robot — run here on
 * the server's own CPU through kokoro-js, so there is no voice service to pay
 * for and nothing leaves the server.
 *
 * It is optional twice over: the package is installed on the cloud server only
 * (see the Dockerfile — it is large and the desktop app does not need it), and
 * the model (~90 MB) is fetched the first time a voice is asked for, then kept
 * in the data folder. Without either, a montage is made without the narrator
 * and says so.
 */
const fs = require('fs');
const path = require('path');

const MODEL = process.env.MW_KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';
/* the voices offered: [id, label] — Kokoro's own voice names */
const VOICES = [
  ['am_michael', 'Man · American'],
  ['af_heart', 'Woman · American'],
  ['bm_george', 'Man · British'],
  ['bf_emma', 'Woman · British'],
  ['am_onyx', 'Deep man · American'],
];

function installed() {
  try { require.resolve('kokoro-js'); return true; } catch (e) { return false; }
}
function cacheDir() {
  return process.env.MW_KOKORO_CACHE
    || (process.env.MW_CLOUD_DATA ? path.join(process.env.MW_CLOUD_DATA, 'kokoro') : path.join(require('os').homedir(), '.cache', 'mw-kokoro'));
}

let enginePromise = null;
/** The model, loaded once (and downloaded the first time). */
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (!installed()) throw new Error('the voice engine (kokoro-js) is not installed on this server');
      const dir = cacheDir();
      fs.mkdirSync(dir, { recursive: true });
      try { const T = await import('@huggingface/transformers'); if (T && T.env) T.env.cacheDir = dir; } catch (e) { /* kokoro-js brings its own */ }
      const { KokoroTTS } = await import('kokoro-js');
      return KokoroTTS.from_pretrained(MODEL, { dtype: 'q8', device: 'cpu' });
    })().catch((e) => { enginePromise = null; throw e; });
  }
  return enginePromise;
}

/**
 * Say `text` in `voice` → a WAV file at `out`. Returns the path.
 * (A test stands in for the engine with `_setEngine`.)
 */
async function speak(text, { voice = 'am_michael', out, speed = 1 } = {}) {
  const words = String(text || '').replace(/\s+/g, ' ').trim();
  if (!words) throw new Error('Nothing to say.');
  const v = VOICES.some(([id]) => id === voice) ? voice : VOICES[0][0];
  const tts = await engine();
  const audio = await tts.generate(words, { voice: v, speed });
  await audio.save(out);
  if (!fs.existsSync(out)) throw new Error('the voice came back empty');
  return out;
}

function status() {
  return { installed: installed(), voices: VOICES.map(([id, label]) => ({ id, label })) };
}

module.exports = { speak, status, VOICES, installed, _setEngine: (e) => { enginePromise = Promise.resolve(e); } };
