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
 *     MISTRAL_API_KEY. Its free plan allows only a few requests a minute,
 *     so a "busy" answer is waited out (the studio is not in a hurry; the
 *     sermon's shorts are worth the minute).
 *   Google Gemini — the key the studio already has to check captions
 *     (GEMINI_API_KEY), asked the way the captions ask it (geminiear.ask:
 *     the best Flash this key may use, its daily allowance, its thinking
 *     settings) — measured: guessing a model name ("gemini-2.5-flash") was
 *     refused, "no longer available to new users".
 *
 * Groq stays where it was: the captions, and this reader's fallback
 * (llmjudge.js). Never throws: '' means "this reader did not answer", and
 * state.trail says what each service answered, for the scan's meta.
 */
const MISTRAL = { id: 'mistral', name: 'Mistral', env: 'MISTRAL_API_KEY', url: 'https://api.mistral.ai/v1/chat/completions' };
const GEMINI = { id: 'gemini', name: 'Gemini', env: 'GEMINI_API_KEY' };
const PROVIDERS = [MISTRAL, GEMINI];
/*
 * THE READERS, STRONGEST FIRST. Measured on the church's own key: Mistral's
 * free plan answered "This model is not available in your subscription tier"
 * (403 tier_not_allowed) for Mistral Large — a refusal of the MODEL, not the
 * key. So each Mistral model is tried in turn, one the plan does not include
 * is set aside for a day, and Gemini Flash (which the key does take) sits
 * above Mistral's small model.
 */
// (measured next: Mistral Medium on the free plan answered "Rate limit exceeded" for a whole
// minute of waiting, twice — Gemini Flash read the sermon well; so it comes before Medium)
const LADDER = [
  { prov: MISTRAL, model: 'mistral-large-latest', label: 'Mistral Large' },
  { prov: GEMINI, label: 'Gemini Flash' },
  { prov: MISTRAL, model: 'mistral-medium-latest', label: 'Mistral Medium' },
  { prov: MISTRAL, model: 'mistral-small-latest', label: 'Mistral Small' },
];
// (MW_BIGJUDGE_API: a stand-in Mistral for the tests — test/bigjudge.test.js)
const mistralUrl = () => (process.env.MW_BIGJUDGE_API ? process.env.MW_BIGJUDGE_API.replace(/\/$/, '') + '/mistral' : MISTRAL.url);
const keyOf = (p) => String(process.env[p.env] || '').trim();
let sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a key refused, a model that is not there, a service that is down: left alone for a while
const benched = new Map();   // 'provider' or 'provider/model' -> until
const isBenched = (k) => (benched.get(k) || 0) > Date.now();
const state = { lastWhy: '', lastModel: '', lastProvider: '', ok: 0, failed: 0, trail: [] };
const note = (s) => { state.lastWhy = s; state.trail.push(s); if (state.trail.length > 24) state.trail.shift(); };

// Gemini, asked the way the captions ask it (replaceable for the tests)
let geminiAsk = async ({ system, prompt, maxTokens, effort }) => {
  const g = require('./geminiear');
  if (!g.ready()) return '';
  // effort 'high': choosing a sermon's shorts is a judgement worth thinking over (measured: the same
  // sermon read twice on 'low' gave two different sets, one with three shorts opening on "But…")
  const r = await g.ask([{ text: (system ? system + '\n\n' : '') + String(prompt || '') }],
    { json: true, think: effort || 'low', maxTokens: Math.max(effort === 'high' ? 16000 : 8000, maxTokens || 0), waits: [10000, 30000], timeoutMs: 240000 });
  return (r && r.text) || '';
};

function providers() { return PROVIDERS.filter((p) => keyOf(p) && !isBenched(p.id)); }
const open = () => LADDER.filter((r) => keyOf(r.prov) && !isBenched(r.prov.id) && !(r.model && isBenched(r.prov.id + '/' + r.model)));
function ready() { return open().length > 0; }
/** The reader that will be asked first, for the label: "Mistral Large (free)". */
function name() { const r = open()[0]; return r ? r.label + ' (free)' : ''; }

function textOf(j) {
  const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && (x.text || x.content)) || '').join('');
  return '';
}
// Mistral's free plan: a few requests a minute — its own hint first, else a growing wait
const BUSY_WAITS = [4000, 10000, 20000, 30000];
function waitOf(res, attempt) {
  const ra = +(res.headers.get('retry-after') || 0);
  if (ra > 0) return Math.min(60e3, ra * 1000 + 500);
  const reset = +(res.headers.get('x-ratelimit-reset') || res.headers.get('ratelimit-reset') || 0);
  if (reset > 0 && reset < 120) return reset * 1000 + 500;
  return BUSY_WAITS[Math.min(BUSY_WAITS.length - 1, attempt)];
}
const short = (s) => String(s || '').replace(/\s+/g, ' ').slice(0, 160);

/** One Mistral model: '' when it did not answer, with why in state.trail. */
async function askMistral(model, { system, prompt, maxTokens, json, temperature, timeoutMs, fetchImpl }) {
  let useJson = json;
  for (let attempt = 0; attempt < BUSY_WAITS.length + 1; attempt++) {
    const body = {
      model, temperature, max_tokens: maxTokens,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: String(prompt || '') }],
    };
    if (useJson) body.response_format = { type: 'json_object' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res = null, err = null;
    try {
      res = await fetchImpl(mistralUrl(), { method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + keyOf(MISTRAL) }, body: JSON.stringify(body) });
    } catch (e) { err = e; } finally { clearTimeout(timer); }
    if (err || !res) {
      note('Mistral ' + model + ': ' + ((err && err.name === 'AbortError') ? 'did not answer in time' : 'could not be reached'));
      if (attempt === 0) { await sleep(3000); continue; }
      benched.set('mistral', Date.now() + 3 * 60e3);   // down or unreachable: the next questions do not wait on it
      return '';
    }
    if (res.ok) {
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      const text = textOf(j);
      if (text) { state.ok++; state.lastModel = model; state.lastProvider = 'mistral'; state.lastWhy = ''; return text; }
      // an empty answer under the JSON envelope: once more without it
      if (useJson) { useJson = false; note('Mistral ' + model + ': empty answer — asked again without JSON mode'); continue; }
      note('Mistral ' + model + ': answered with nothing');
      return '';
    }
    let said = '';
    try { said = (await res.text()).slice(0, 400); } catch (e) { said = ''; }
    if (res.status === 429) {
      note('Mistral ' + model + ': 429 ' + short(said));
      if (attempt < BUSY_WAITS.length) { await sleep(waitOf(res, attempt)); continue; }
      // still busy after a minute: the next reader — and this model is not waited on again for a while
      benched.set('mistral/' + model, Date.now() + 10 * 60e3);
      return '';
    }
    // the plan does not include THIS model (measured: Mistral Large on the free plan): set aside for a day
    if ((res.status === 403 || res.status === 401 || res.status === 400) && /tier_not_allowed|subscription tier|not available in your/i.test(said)) {
      benched.set('mistral/' + model, Date.now() + 24 * 3600e3); note('Mistral ' + model + ': not in this plan (' + short(said) + ')'); return '';
    }
    if (res.status === 401 || res.status === 403) { benched.set('mistral', Date.now() + 10 * 60e3); note('Mistral: the key was refused (' + res.status + ' ' + short(said) + ')'); return ''; }
    if (res.status === 404 || (res.status === 400 && /(model|invalid_model)[^.]{0,60}(not found|does not exist|invalid|unknown|not available|no access)|(not found|unknown|invalid|no access)[^.]{0,40}model/i.test(said))) {
      benched.set('mistral/' + model, Date.now() + 24 * 3600e3); note('Mistral ' + model + ': not offered (' + res.status + ' ' + short(said) + ')'); return '';
    }
    // the JSON envelope refused: the same model, without it
    if (res.status === 400 && useJson && /response_format|json/i.test(said)) { useJson = false; note('Mistral ' + model + ': 400 on JSON mode — asked again without it'); continue; }
    if (res.status >= 500 && attempt === 0) { note('Mistral ' + model + ': ' + res.status + ' — once more'); await sleep(4000); continue; }
    if (res.status >= 500) { benched.set('mistral', Date.now() + 3 * 60e3); note('Mistral is having trouble (' + res.status + ' ' + short(said) + ')'); return ''; }
    note('Mistral ' + model + ' answered ' + res.status + ' ' + short(said));
    return '';
  }
  return '';
}

/**
 * One prompt, the answer's text — Mistral first, then Gemini. '' if neither
 * answered; state.trail says what each one said.
 */
async function chat({ system, prompt, maxTokens = 3000, json = true, temperature = 0, timeoutMs = 150000, fetchImpl = fetch, effort = null } = {}) {
  for (const r of open()) {
    if (r.prov === MISTRAL) {
      if (isBenched('mistral') || isBenched('mistral/' + r.model)) continue;
      const out = await askMistral(r.model, { system, prompt, maxTokens, json, temperature, timeoutMs, fetchImpl });
      if (out) { state.lastLabel = r.label; return out; }
    } else if (r.prov === GEMINI) {
      if (isBenched('gemini')) continue;
      try {
        const out = await geminiAsk({ system, prompt, maxTokens, effort });
        if (out) { state.ok++; state.lastProvider = 'gemini'; state.lastLabel = r.label; state.lastWhy = ''; return out; }
        note('Gemini: answered with nothing');
      } catch (e) {
        note('Gemini: ' + short(e && e.message));
        if (e && e.exhausted) benched.set('gemini', Date.now() + 30 * 60e3);
      }
    }
  }
  state.failed++;
  return '';
}

module.exports = {
  ready, name, chat, state, providers, PROVIDERS, LADDER, _benched: benched,
  _setGemini: (fn) => { geminiAsk = fn; }, _setSleep: (fn) => { sleep = fn; },
};
