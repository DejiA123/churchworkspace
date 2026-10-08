'use strict';
/*
 * ►► A THIRD EAR THAT IS NOT WHISPER (Google Gemini, free tier). ◄◄
 *
 * Both of the captions' ears are Whisper (Large v3 and Turbo, on the free Groq
 * account). They are close relatives, and on a real 45-minute sermon they made
 * the SAME mistakes in the same places — "attract God on the same" for "on the
 * scene", "relaying this story" heard as "learning", "who at a never" for "who
 * art in heaven". Two ears that share a blind spot cannot point at it.
 *
 * Gemini hears audio with a language model's understanding of what is being
 * said, and its mistakes are not Whisper's. Here it listens to the same
 * stretches word for word; captionfuse.js lines its words up against the
 * Whisper ones and decides, place by place, which hearing is right.
 *
 * Free: a key from Google AI Studio (no card) set on the server as
 * GEMINI_API_KEY. Without one, nothing here runs and the captions are exactly
 * what they were. Google's free tier may use what is sent to it to improve
 * their products — said in CLOUD.md where the key is set.
 */
const { spawn } = require('child_process');

const API = 'https://generativelanguage.googleapis.com/v1beta';
const key = () => String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
const ready = () => !!key();

let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { ffmpegPath = null; }
function setFfmpeg(p) { if (p) ffmpegPath = p; }

let jobs = null;
try { jobs = require('./jobs'); } catch (e) { jobs = null; }
const cancelled = () => !!(jobs && jobs.isCancelled && jobs.isCancelled());

/* ---------------------------- which model ------------------------------- */
// The best "flash" model this key has (newest first), never a lite, image,
// speech or live one. Asked once and remembered; a fixed name if the list
// cannot be read.
// Google's own "newest Flash" name, for when the list of models cannot be read
// (measured: gemini-2.5-flash now answers 404, "no longer available to new users")
const FALLBACK_MODEL = 'gemini-flash-latest';
let ranked = null;                 // this key's models, best first
const spent = new Set();           // models whose free allowance is used up (or not open to this key) today
let spentDay = '';
function rankModel(name) {
  const n = String(name || '').replace(/^models\//, '');
  if (!/^gemini-/.test(n) || /lite|image|tts|live|audio|embed|vision|thinking-exp|learnlm/i.test(n)) return -1;
  if (!/flash|pro/.test(n)) return -1;
  const v = parseFloat((/gemini-(\d+(?:\.\d+)?)/.exec(n) || [])[1] || '0');
  // flash before pro (pro's free allowance is tiny), released before preview
  return v * 10 + (/flash/.test(n) ? 3 : 0) + (/preview|exp/.test(n) ? 0 : 1);
}
async function models(fetchImpl = fetch) {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== spentDay) { spent.clear(); spentDay = day; }
  if (!ranked) {
    if (process.env.MW_GEMINI_MODEL) ranked = [process.env.MW_GEMINI_MODEL];
    else {
      try {
        const res = await fetchImpl(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key() } });
        if (res.ok) {
          const j = await res.json();
          ranked = (j.models || [])
            .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
            .map((m) => ({ id: String(m.name || '').replace(/^models\//, ''), r: rankModel(m.name) }))
            .filter((m) => m.r > 0)
            .sort((a, b) => b.r - a.r)
            .map((m) => m.id)
            .slice(0, 4);
        }
      } catch (e) { /* the fixed name below */ }
      // the fixed name only when this key's own list could not be read (the list names the models it may use)
      if (!ranked || !ranked.length) ranked = [FALLBACK_MODEL];
    }
  }
  return ranked.filter((m) => !spent.has(m));
}
async function pickModel(fetchImpl = fetch) { return (await models(fetchImpl))[0] || null; }

/* ---------------------------- one stretch -------------------------------- */
function promptFor(terms) {
  const t = (terms || []).filter(Boolean).slice(0, 40);
  return 'Transcribe this audio of a church sermon EXACTLY as spoken, word for word (verbatim). '
    + 'The sermon is in ENGLISH (the speaker may have an African or other accent): write it in English, in the words '
    + 'actually spoken — never translate it into any other language. '
    + 'Keep repeated words, unfinished sentences, filler words and the speaker\'s own grammar — '
    + 'do not correct, tidy, summarise or paraphrase anything, and do not add anything that was not said. '
    + 'Use normal punctuation and capital letters; write God, Jesus, Lord and Holy Spirit with capitals. '
    + (t.length ? 'Names and words used at this church: ' + t.join(', ') + '. ' : '')
    + 'If a stretch is music, singing or silence, leave it out. Reply with the transcript text only.';
}

/** The stretch as FLAC (16 kHz mono) — the same lossless audio the Whisper ears get. */
function encodeFlac(input, startSec, durSec) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('ffmpeg is missing'));
    const args = ['-v', 'error', ...(startSec > 0 ? ['-ss', String(startSec)] : []), '-t', String(durSec),
      '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-c:a', 'flac', '-f', 'flac', 'pipe:1'];
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    if (jobs && jobs.track) jobs.track(p);
    const out = []; let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} reject(new Error('decode timed out')); }, 120000);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err += d.toString().slice(0, 300); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg ' + code + ' ' + err)); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** What Gemini wrote, as plain words: no "[music]" notes, no "Speaker 1:" labels, no timestamps. */
function clean(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/(^|\n)\s*(speaker\s*\d*|preacher|pastor)\s*:/gi, ' ')
    .replace(/\(?\b\d{1,2}:\d{2}(?::\d{2})?\b\)?(?=\s|$)/g, (m) => (/^\(/.test(m) || /^\d{1,2}:\d{2}:\d{2}$/.test(m) ? ' ' : m))
    .replace(/\s+/g, ' ').trim();
}
/**
 * One stretch of audio → its words as text. Waits out the free tier's
 * per-minute limit (a few times); a model whose allowance for the DAY is used
 * up is set aside and the next one asked, and when none is left the error
 * says so (`exhausted`), so the rest of the span is not tried in vain.
 */
// Scripture read aloud is not a hazard: the free tier's default filters must
// never blank out a stretch of a sermon.
const SAFETY = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map((category) => ({ category, threshold: 'BLOCK_NONE' }));
// A transcription is not a puzzle: as little "thinking" as each model allows
// (it costs time, and counts against the answer's length). Tried in order; a
// setting a model refuses is dropped for the next, and at worst left out.
function thinkingFor(model, level = 'minimal') {
  if (/2\.5-flash/.test(model)) return [{ thinkingBudget: level === 'minimal' ? 0 : 1024 }];
  if (/gemini-([3-9]|\d\d)/.test(model)) return level === 'minimal' ? [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }] : [{ thinkingLevel: level }];
  return [];
}
/**
 * One request to Gemini: `parts` (text and/or audio), the answer's text back.
 * Waits out the free tier's per-minute limit (a few times); a model whose
 * allowance for the DAY is used up is set aside and the next one asked, and
 * when none is left the error says so (`exhausted`), so the rest is not tried
 * in vain; a model too busy ("high demand") hands this request to the next.
 * json: the answer is JSON; think: how much the model may think first.
 */
async function ask(parts, { fetchImpl = fetch, waits = [15000, 30000, 45000], timeoutMs = 240000, json = false, think = 'minimal', maxTokens = 16384, patient = true } = {}) {
  let lastWhy = '';
  const busy = new Set();
  for (;;) {
    const open = await models(fetchImpl);
    const model = open.find((m) => !busy.has(m));
    if (!open.length) throw Object.assign(new Error('the free Gemini allowance is used up for today' + (lastWhy ? ' (' + lastWhy + ')' : '')), { exhausted: true });
    if (!model) throw new Error('Gemini is busy right now (' + lastWhy + ')');
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: Object.assign({ temperature: 0, maxOutputTokens: maxTokens }, json ? { responseMimeType: 'application/json' } : {}),
      safetySettings: SAFETY,
    };
    const thinking = thinkingFor(model, think);
    if (thinking.length) body.generationConfig.thinkingConfig = thinking.shift();
    let next = false;
    for (let attempt = 0; !next; attempt++) {
      if (cancelled()) throw Object.assign(new Error('Cancelled'), { cancelled: true });
      let res, j = null;
      // never waits for ever: a request that hangs is given up and tried again
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        res = await fetchImpl(`${API}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key() }, body: JSON.stringify(body), signal: ac.signal,
        });
        if (res.ok) j = await res.json();
      } catch (e) {
        res = null;
      } finally { clearTimeout(timer); }
      if (!res || (res.ok && !j)) {
        if (attempt >= waits.length) throw new Error('could not reach Gemini (no answer in time)');
        await sleep(waits[attempt]); continue;
      }
      if (res.ok) {
        const c = j && j.candidates && j.candidates[0];
        const text = c && c.content && Array.isArray(c.content.parts) ? c.content.parts.filter((p) => !p.thought).map((p) => p.text || '').join('') : '';
        const why = String((c && c.finishReason) || (j && j.promptFeedback && j.promptFeedback.blockReason) || '');
        return { text, model, finish: why };
      }
      let said = '';
      try { const e = await res.json(); said = JSON.stringify((e && e.error) || e || '').slice(0, 600); } catch (e) {}
      // a thinking setting this model does not take: the next one, or none
      if (res.status === 400 && body.generationConfig.thinkingConfig) {
        if (thinking.length) body.generationConfig.thinkingConfig = thinking.shift(); else delete body.generationConfig.thinkingConfig;
        continue;
      }
      const msg = (/"message":"([^"]*)/.exec(said) || [])[1] || '';
      lastWhy = res.status + (msg ? ' ' + msg.slice(0, 120) : '');
      // not open to this key, gone, or the day's allowance used up: the next model
      const daily = /per ?day|PerDay|limit: ?0\b/i.test(said);
      if (res.status === 404 || res.status === 403 || (res.status === 429 && daily)) { spent.add(model); next = true; continue; }
      // impatient (a bonus step, like the proofreader): a busy minute is not waited out
      if (res.status === 429 && !patient) { busy.add(model); next = true; continue; }
      if (res.status === 429 && attempt < waits.length) {
        const hint = +((/"retryDelay":"(\d+)/.exec(said) || [])[1] || 0) * 1000;
        await sleep(hint > 0 ? Math.min(60000, hint + 1000) : waits[attempt]); continue;
      }
      if (res.status === 429) { spent.add(model); next = true; continue; }
      // overloaded ("high demand") or failing: one short wait, then another model takes this request
      if (res.status >= 500) {
        if (attempt < 1 && waits.length && patient) { await sleep(waits[0]); continue; }
        busy.add(model); next = true; continue;
      }
      throw new Error('Gemini answered ' + lastWhy);
    }
  }
}
const audioPart = (flac) => ({ inline_data: { mime_type: 'audio/flac', data: Buffer.from(flac).toString('base64') } });
/** One stretch of audio → its words as text. */
/*
 * Measured on a real sermon: Gemini once answered a five-minute stretch in
 * ARABIC — a translation, every word of it. The captions are in the language
 * the studio works in (English, Latin letters); an answer mostly in another
 * script is asked again, more firmly, and never used.
 */
function latinShare(text) {
  const letters = String(text || '').match(/\p{L}/gu) || [];
  if (!letters.length) return 1;
  return letters.filter((c) => /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/.test(c)).length / letters.length;
}
async function hear(flac, { terms = [], fetchImpl = fetch, waits, timeoutMs = 240000 } = {}) {
  const opt = Object.assign({ fetchImpl, timeoutMs }, waits ? { waits } : {});
  let r = await ask([audioPart(flac), { text: promptFor(terms) }], opt);
  if (!clean(r.text) && r.finish && r.finish !== 'STOP') throw new Error('Gemini held this stretch back (' + r.finish.toLowerCase() + ')');
  if (latinShare(r.text) < 0.9) {
    r = await ask([audioPart(flac), { text: promptFor(terms) + ' IMPORTANT: answer in English only, in the exact English words spoken. Do not translate.' }], opt);
    if (latinShare(r.text) < 0.9) throw new Error('Gemini answered in another language');
  }
  return { text: clean(r.text), model: r.model, finish: r.finish };
}

/**
 * The span [from, to) of `input`, heard in the same three-minute stretches as
 * the Whisper ears: [{ from, to, text }] on the span's own clock. A stretch
 * Gemini could not hear is left out (and counted), never guessed.
 */
async function transcribeSpan({ input, from = 0, to, terms = [], chunkSec = 300, pad = 6, onProgress = null, fetchImpl = fetch, waits, encode = encodeFlac, together = 3, retryAfterMs = 20000 } = {}) {
  if (!ready() || !input || !(to > from)) return null;
  const n = Math.max(1, Math.ceil((to - from) / chunkSec - 1e-6));
  const got = new Array(n).fill(null);
  const failedAt = [];
  let why = '', model = '', done = 0, nextI = 0, stop = false, cancel = null;
  /*
   * Each stretch is heard a few seconds past its own edges (`pad`) and decides
   * only its own part [own0, own1): Gemini and Whisper cut a word at an edge
   * differently, so without the overlap the words at every edge would never
   * be checked.
   */
  const hearOne = async (i) => {
    const a = from + i * chunkSec, b = Math.min(to, a + chunkSec);
    const ha = Math.max(from, a - pad), hb = Math.min(to, b + pad);
    const flac = await encode(input, ha, hb - ha);
    const r = await hear(flac, Object.assign({ terms, fetchImpl }, waits ? { waits } : {}));
    model = r.model;
    got[i] = { from: ha - from, to: hb - from, own0: a - from, own1: b - from, atStart: ha <= from, atEnd: hb >= to, text: r.text };
  };
  // a few stretches at once (well inside the free tier's per-minute limit), so
  // the third ear takes about as long as the second
  const worker = async () => {
    while (!stop && !cancel && nextI < n) {
      const i = nextI++;
      try { await hearOne(i); } catch (e) {
        if (e && e.cancelled) { cancel = e; break; }
        why = (e && e.message) || 'no answer';
        failedAt.push(i);
        if (e && e.exhausted) stop = true;
      }
      done++;
      if (onProgress) { try { onProgress(done / n); } catch (e) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(together, n)) }, worker));
  if (cancel) throw cancel;
  // a stretch that failed for a passing reason (busy, no answer) is asked once more
  if (!stop && failedAt.length) {
    await sleep(retryAfterMs);
    for (const i of failedAt.splice(0)) {
      try { await hearOne(i); } catch (e) {
        if (e && e.cancelled) throw e;
        why = (e && e.message) || 'no answer'; failedAt.push(i);
        if (e && e.exhausted) break;
      }
    }
  }
  const failed = got.filter((c) => !c).length;
  return { chunks: got.filter(Boolean), failed, why: failed ? why : '', model };
}

module.exports = { ready, transcribeSpan, hear, ask, audioPart, latinShare, encodeFlac, pickModel, rankModel, promptFor, clean, setFfmpeg, _reset: () => { ranked = null; spent.clear(); } };
