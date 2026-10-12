'use strict';
/*
 * ►► A FREE, STRONG READER FOR THE WHOLE SERMON. ◄◄
 *
 * Measured on a church's live server (a 50-minute sermon, Groq's free plan):
 * the moments were chosen ten minutes at a time — a short opened on "The
 * other day I went to meet him…" with nobody to say who "him" was — and the
 * large models ran out of their per-minute allowance halfway, so the pass
 * that looks at each short's edges never ran. A reader that holds the whole
 * sermon at once, with an allowance a sermon cannot use up, fixes both:
 *
 *   Mistral — its free plan (no card, a phone number) takes every model,
 *     Mistral Large included, with about a billion tokens a month:
 *     MISTRAL_API_KEY.
 *   Google Gemini — a free key from AI Studio (the one the studio already
 *     asks for to check captions): GEMINI_API_KEY, through Google's
 *     OpenAI-compatible door; a million tokens of context.
 *
 * Both answer the same shape of request (OpenAI chat completions). Groq stays
 * where it was: the captions, and this reader's fallback (llmjudge.js).
 * Never throws: '' means "this reader did not answer".
 */
const PROVIDERS = [
  { id: 'mistral', name: 'Mistral Large', env: 'MISTRAL_API_KEY',
    url: 'https://api.mistral.ai/v1/chat/completions', models: ['mistral-large-latest', 'mistral-medium-latest'] },
  { id: 'gemini', name: 'Gemini', env: 'GEMINI_API_KEY',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', models: ['gemini-flash-latest', 'gemini-2.5-flash'] },
];
// (MW_BIGJUDGE_API: a stand-in service for the tests — test/bigjudge.test.js)
const urlOf = (p) => (process.env.MW_BIGJUDGE_API ? process.env.MW_BIGJUDGE_API.replace(/\/$/, '') + '/' + p.id : p.url);
const keyOf = (p) => String(process.env[p.env] || '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a key refused, or a model that is not there: left alone for a while, not asked on every call
const benched = new Map();   // 'provider' or 'provider/model' -> until
const isBenched = (k) => (benched.get(k) || 0) > Date.now();
const state = { lastWhy: '', lastModel: '', lastProvider: '', ok: 0, failed: 0 };

function providers() { return PROVIDERS.filter((p) => keyOf(p) && !isBenched(p.id)); }
function ready() { return providers().length > 0; }
/** The reader that will be asked first, for the label: "Mistral Large (free)". */
function name() { const p = providers()[0]; return p ? p.name + ' (free)' : ''; }

function textOf(j) {
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && (x.text || x.content)) || '').join('');
  return '';
}
function waitOf(res, attempt) {
  const ra = +(res.headers.get('retry-after') || 0);
  if (ra > 0) return Math.min(30e3, ra * 1000);
  return [2000, 6000, 15000][Math.min(2, attempt)];
}

/**
 * One prompt, the answer's text. A busy minute (429) is waited out — a few
 * seconds, then again — before the next model; a refused key benches that
 * service; anything else moves on to the next model, then the next service.
 */
async function chat({ system, prompt, maxTokens = 3000, json = true, temperature = 0, timeoutMs = 120000, fetchImpl = fetch } = {}) {
  for (const p of providers()) {
    for (const model of p.models) {
      if (isBenched(p.id + '/' + model)) continue;
      for (let attempt = 0; attempt < 4; attempt++) {
        const body = {
          model, temperature, max_tokens: maxTokens,
          messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: String(prompt || '') }],
        };
        if (json) body.response_format = { type: 'json_object' };
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        let res = null, err = null;
        try {
          res = await fetchImpl(urlOf(p), { method: 'POST', signal: ac.signal,
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keyOf(p) }, body: JSON.stringify(body) });
        } catch (e) { err = e; } finally { clearTimeout(timer); }
        if (err || !res) {
          state.lastWhy = p.name + ': ' + ((err && err.name === 'AbortError') ? 'did not answer in time' : 'could not be reached');
          if (attempt === 0) { await sleep(2000); continue; }
          benched.set(p.id, Date.now() + 3 * 60e3);   // down or unreachable: the next questions do not wait on it
          break;
        }
        if (res.ok) {
          let j = null;
          try { j = await res.json(); } catch (e) { j = null; }
          const text = textOf(j);
          if (text) { state.ok++; state.lastModel = model; state.lastProvider = p.id; state.lastWhy = ''; return text; }
          // an empty answer under the JSON envelope: once more without it
          if (json && attempt === 0) { json = false; continue; }
          state.lastWhy = p.name + ': answered with nothing';
          break;
        }
        let said = '';
        try { said = (await res.text()).slice(0, 300); } catch (e) { said = ''; }
        if (res.status === 429) { state.lastWhy = p.name + ': busy for the moment'; await sleep(waitOf(res, attempt)); continue; }
        if (res.status === 401 || res.status === 403) { benched.set(p.id, Date.now() + 10 * 60e3); state.lastWhy = p.name + ': the key was refused'; break; }
        if (res.status === 404 || /model|not found|does not exist|unknown/i.test(said)) { benched.set(p.id + '/' + model, Date.now() + 60 * 60e3); state.lastWhy = p.name + ': ' + model + ' is not offered'; break; }
        if (res.status >= 500 && attempt === 0) { await sleep(3000); continue; }
        if (res.status >= 500) { benched.set(p.id, Date.now() + 3 * 60e3); state.lastWhy = p.name + ' is having trouble (' + res.status + ')'; break; }
        state.lastWhy = p.name + ' answered ' + res.status + (said ? ' (' + said.replace(/\s+/g, ' ').slice(0, 140) + ')' : '');
        break;
      }
      if (!providers().includes(p)) break;   // its key was refused: the next service
    }
  }
  state.failed++;
  return '';
}

module.exports = { ready, name, chat, state, providers, PROVIDERS, _benched: benched };
