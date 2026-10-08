'use strict';
/*
 * ►► ASSEMBLYAI — AN EAR THAT IS NOT WHISPER. ◄◄
 *
 * The second opinion used to be Whisper again (large-v3-turbo): two ears of
 * the same family, which share their mishearings. AssemblyAI's Universal
 * models are trained apart from Whisper and rank ahead of it on the public
 * speech benchmarks (AA-WER ~3.1% against ~4.1%). A free account (no card)
 * comes with a one-time credit worth some 240 hours of sermon at this rate —
 * years, for a church. With ASSEMBLYAI_API_KEY set it becomes the second
 * ear; without it, or when it cannot answer, Whisper is asked as before.
 *
 * One stretch: the audio goes up, a transcript is asked for, and the answer
 * is collected — words with their times, on the stretch's own clock.
 */
const API = 'https://api.assemblyai.com/v2';
const key = () => String(process.env.ASSEMBLYAI_API_KEY || '').trim();
const ready = () => !!key();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', body, headers = {}, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(API + path, { method, body, headers: Object.assign({ authorization: key() }, headers) });
  let j = null;
  try { j = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error('AssemblyAI ' + res.status + ((j && j.error) ? ': ' + String(j.error).slice(0, 160) : ''));
  return j || {};
}

/**
 * Hear `audio` (a Buffer: FLAC or any format it takes). Returns [{text, start,
 * end}] in seconds from the start of the audio. Throws when it cannot.
 */
async function transcribe(audio, { terms = [], cancelled = () => false, fetchImpl = fetch, timeoutMs = 15 * 60e3 } = {}) {
  if (!ready()) throw new Error('no AssemblyAI key');
  const up = await call('/upload', { method: 'POST', body: audio, headers: { 'content-type': 'application/octet-stream' }, fetchImpl });
  if (!up.upload_url) throw new Error('AssemblyAI took no audio');
  const base = { audio_url: up.upload_url, language_code: 'en', punctuate: true, format_text: true };
  // the whole Word Book: the newest models take up to 1,000 names of up to six words each
  const hints = [...new Set((terms || []).map((t) => String(t || '').trim()).filter((t) => t && t.split(/\s+/).length <= 6))].slice(0, 1000);
  // newest model first; a request it does not take is asked again the plain way
  const tries = [
    Object.assign({ speech_models: ['universal-3-5-pro', 'universal-3-pro', 'universal-2'] }, hints.length ? { keyterms_prompt: hints } : {}),
    Object.assign({ speech_models: ['universal-3-pro', 'universal-2'] }, hints.length ? { keyterms_prompt: hints } : {}),
    Object.assign({ speech_models: ['universal-3-pro', 'universal-2'] }, hints.length ? { keyterms_prompt: hints.slice(0, 100) } : {}),
    Object.assign({ speech_model: 'universal' }, hints.length ? { word_boost: hints.slice(0, 100) } : {}),
    {},
  ];
  let job = null, lastErr = null, asked = null;
  for (const t of tries) {
    try { job = await call('/transcript', { method: 'POST', body: JSON.stringify(Object.assign({}, base, t)), headers: { 'content-type': 'application/json' }, fetchImpl }); asked = t; break; }
    catch (e) { lastErr = e; if (!/ 400/.test(e.message)) throw e; }
  }
  if (!job || !job.id) throw lastErr || new Error('AssemblyAI would not start');
  const t0 = Date.now();
  for (;;) {
    if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    if (Date.now() - t0 > timeoutMs) throw new Error('AssemblyAI took too long');
    await sleep(2500);
    const r = await call('/transcript/' + job.id, { fetchImpl });
    if (r.status === 'completed') {
      // (how sure it was of each word comes too: the studio can point at the doubtful ones)
      const words = (r.words || []).filter((w) => w && w.text).map((w) => Object.assign({ text: String(w.text), start: (+w.start || 0) / 1000, end: (+w.end || 0) / 1000 },
        typeof w.confidence === 'number' ? { confidence: Math.round(w.confidence * 1000) / 1000 } : {}));
      // which model heard it: the one AssemblyAI says it used, else the one asked for
      const used = r.speech_model_used || r.speech_model || (asked && (asked.speech_models ? asked.speech_models[0] : asked.speech_model)) || '';
      Object.defineProperty(words, 'model', { value: String(used || 'assemblyai'), enumerable: false });
      return words;
    }
    if (r.status === 'error') throw new Error('AssemblyAI: ' + String(r.error || 'failed').slice(0, 160));
  }
}

module.exports = { ready, transcribe };
