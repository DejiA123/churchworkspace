'use strict';
/*
 * ►► THE MODEL THAT WRITES THE POST ◄◄
 *
 * WHAT WAS WRONG.
 *
 * "✨ Write the title & caption for me" had two writers and both of them were
 * the wrong size for the job.
 *
 *   • The RULES (social-copy.js) always run and always produce something
 *     postable. That is their whole purpose and they do it. But a rule engine
 *     writes the same three sentences with the nouns swapped, because that is
 *     what a rule engine is. Post twelve of them in a week and the account
 *     reads like a machine, which is exactly what the operator said: terrible.
 *
 *   • The LOCAL MODEL is Qwen2.5 at 1.5B or 3B parameters, quantised to 4 bits,
 *     on the CPU of whatever PC the church has. It is there to JUDGE clips —
 *     one short question, one short answer — and it is good at that. Asked to
 *     write three pieces of persuasive copy in three different voices while
 *     obeying nine house rules, a 1.5B model drops rules, repeats itself and
 *     invents Bible verses. Worse, most machines never install it at all, so
 *     the button was usually the rules alone.
 *
 * WHAT THIS DOES INSTEAD.
 *
 * It asks a 70-to-120-billion-parameter instruction model, on hardware built
 * for it, and gets three finished options back in about two seconds. That is
 * not a bigger version of the local model; it is the difference between copy
 * that has to be rewritten and copy that can be posted.
 *
 * AND IT IS THE SAME FREE ACCOUNT 🎤 Listen already uses. Groq's free tier
 * serves these models with no card: the key pasted into the Listen panel is the
 * key this uses, so for a church that set the cloud ear up, this cost them one
 * tick box. See cloudspeech.js for the transcription half — this module and
 * that one are the two halves of "listen to the clip, then write about it".
 *
 * WHY A MODEL LADDER. Hosted model names are not forever: providers retire
 * them, and a church's copy of this app is not updated the day that happens.
 * A model that has gone away answers 404 / `model_decommissioned`, so this
 * walks down a list until one answers and remembers which one did. The
 * alternative is a button that stops working one Tuesday for no visible reason.
 *
 * NOTHING HERE IS ALLOWED TO BE FATAL. Every failure returns '' and the caller
 * keeps the rules' answer. The worst this can produce is the copy the church
 * has today.
 */

/* ===================== WHO CAN BE ASKED, AND ON WHAT TERMS =================
 *
 * All of these speak OpenAI-shaped `POST /chat/completions`, which is why
 * adding one is a table entry rather than a code path.
 *
 * `models` is a LADDER, not a menu: the first is tried first and the rest are
 * what happens when it is not there any more. The operator can still pick one
 * explicitly, and their pick simply goes to the front of the ladder.
 */
const PROVIDERS = {
  groq: {
    id: 'groq',
    name: 'Groq',
    label: 'Free cloud — fast, no card (best value)',
    blurb: 'Free, and the same key as 🎤 Listen. Writes all three options in about a second.',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    keyUrl: 'https://console.groq.com/keys',
    keyHint: 'gsk_…',
    free: true,
    /*
     * A PREFERENCE, NOT A LIST OF WHAT EXISTS — see pickModels(). Anything here
     * that the account cannot actually reach is dropped before it is ever asked.
     */
    models: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B — the best writer here' },
      { id: 'openai/gpt-oss-20b', name: 'GPT-OSS 20B — nearly as good, quickest' },
      { id: 'qwen/qwen3.8-27b', name: 'Qwen3 27B' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
      { id: 'moonshotai/kimi-k2-instruct', name: 'Kimi K2' },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    label: 'ChatGPT (OpenAI) — the one everybody knows',
    blurb: 'Your own OpenAI key. About a tenth of a penny a caption on the mini models.',
    url: 'https://api.openai.com/v1/chat/completions',
    modelsUrl: 'https://api.openai.com/v1/models',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyHint: 'sk-…',
    free: false,
    models: [
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini — the sweet spot' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini — cheapest' },
      { id: 'gpt-4.1', name: 'GPT-4.1 — the best of them' },
      { id: 'gpt-4o', name: 'GPT-4o' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    label: 'OpenRouter — one key, every model',
    blurb: 'Hundreds of models behind one key, including free ones. Pennies per hundred posts.',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keyUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    free: false,
    models: [
      { id: 'openai/gpt-4.1-mini', name: 'GPT-4.1 mini' },
      { id: 'anthropic/claude-3.5-haiku', name: 'Claude 3.5 Haiku' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
    ],
  },
  custom: {
    id: 'custom',
    name: 'Other',
    label: 'Another service, or your own',
    blurb: 'Anything serving POST /v1/chat/completions — a paid account, or a model on your own server.',
    url: '',
    modelsUrl: '',
    keyUrl: '',
    keyHint: 'your key',
    free: false,
    models: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini' }],
  },
};
const DEFAULT_PROVIDER = 'groq';

/* Errors that mean "that model is gone", as opposed to "your key is wrong" or
 * "the internet is down". Only these walk the ladder. */
const GONE_RX = /model_not_found|model_decommissioned|does not exist|decommissioned|no endpoints found|is not a valid model/i;
/*
 * ►► AND THE ONE THAT COST THE WHOLE FEATURE. ◄◄
 *
 * `json_validate_failed` is a 400 and it is NOT a broken key, a dead model or a
 * bad prompt — it is a REASONING model that spent its token budget thinking and
 * then emitted JSON it had no room to finish. Measured against the operator's
 * own Groq account: gpt-oss-120b asked for a caption with response_format
 * json_object returned 400 json_validate_failed, and the same request with
 * `reasoning_effort: 'low'` returned perfect JSON in 1.2 s.
 *
 * It was being treated as a plain failure, so three captions in a row put the
 * writer into a ten-minute cool-down and every clip after that was written by
 * the rules — which is exactly the template copy the operator was looking at.
 * It now retries the SAME model with the JSON mode turned off, which is the
 * thing that actually fixes it (the prompt already says "JSON only", and
 * parseJson scans for a balanced object rather than trusting the envelope).
 */
const JSON_FAILED_RX = /json_validate_failed|failed to generate json/i;

/*
 * WHAT A PARTICULAR MODEL NEEDS ASKING DIFFERENTLY.
 *
 * Kept as a table because it is provider-independent: the same gpt-oss weights
 * are served by Groq, by OpenRouter and by anyone else, and they need the same
 * handling wherever they are. `reasoning_effort: low` is not a quality setting
 * here — a caption is not a maths problem — it is what stops the model spending
 * the whole budget on deliberation it does not need.
 */
const TUNE = [
  [/gpt-oss/i, { reasoning_effort: 'low' }],
  [/^o[134](-|$)|^gpt-5/i, { reasoning_effort: 'low' }],
];
function tuneFor(model) {
  const out = {};
  for (const [rx, extra] of TUNE) if (rx.test(model)) Object.assign(out, extra);
  return out;
}

/* ================= WHICH MODELS THIS ACCOUNT ACTUALLY HAS =================
 *
 * The first version of this shipped a fixed ladder, on the reasoning that a
 * retired model answers 404 and the next one down gets tried. That is true and
 * it was not enough: by the time the operator ran it, THREE of the four names
 * in the Groq ladder had been retired, so every caption paid three 404s before
 * it got anywhere, and the one survivor was a reasoning model that failed for
 * a different reason entirely.
 *
 * So the list is now ASKED FOR. Every one of these providers serves
 * `GET /v1/models`; the answer is intersected with the preference order above,
 * anything the account cannot reach is dropped before it is ever tried, and
 * anything it has that is not in the preference list is kept as a last resort.
 * A church whose provider renames everything overnight still gets a caption.
 *
 * Cached for an hour — it is one small request and the answer changes about
 * twice a year — and a failure to fetch it is not fatal: the static preference
 * order is used exactly as before.
 */
/* ===================== THE LADDER IS ALSO A CAPACITY LADDER ================
 *
 * ►► MEASURED ON THE OPERATOR'S OWN ACCOUNT, and it changes the design. ◄◄
 *
 * Groq's free tier meters TOKENS PER MINUTE, and the cap is PER MODEL with a
 * SEPARATE BUCKET for each one:
 *
 *      openai/gpt-oss-120b   8,000 TPM      openai/gpt-oss-20b   8,000 TPM
 *      qwen/qwen3.8-27b      8,000 TPM      groq/compound-mini  70,000 TPM
 *
 * One caption costs about 1,400 tokens, so a single model runs dry after five
 * or six of them — which is why writing a batch of eight produced two good
 * captions and six templates. Treating that 429 as "the service is unwell" and
 * standing down for ten minutes made it worse: every clip after it fell back
 * instantly, and the operator got a screen full of filled-in templates with
 * nothing to say why.
 *
 * A model that is out of tokens is not a broken model, it is a FULL one, and
 * the next one down has its own untouched eight thousand. So a 429 demotes that
 * model for exactly as long as the provider says it needs and the batch carries
 * on. Three models is 24,000 tokens a minute, which is about seventeen captions
 * — and only when every one of them is full does the writer stand down at all.
 */
const limited = new Map();       // model -> when its allowance comes back
const limitedNow = (id) => { const t = limited.get(id); return !!t && Date.now() < t; };
/** "57.682s" / "1m2s" / "800ms" -> milliseconds. */
function waitMs(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return 0;
  const m = t.match(/(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (m && (m[1] || m[2] || m[3])) {
    return Math.round((parseFloat(m[1] || 0) * 60 + parseFloat(m[2] || 0)) * 1000 + parseFloat(m[3] || 0));
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

const MODELS_TTL_MS = 3600e3;
const NOT_CHAT_RX = /whisper|tts|embed|moderation|guard|orpheus|dall-e|sora|realtime|audio|transcribe|image/i;
let seen = { at: 0, provider: '', ids: null, why: '' };

async function discoverModels(signal) {
  const p = provider();
  const url = cfg.provider === 'custom' ? '' : p.modelsUrl;
  if (!url || !key()) return null;
  if (seen.ids && seen.provider === cfg.provider && Date.now() - seen.at < MODELS_TTL_MS) return seen.ids;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    let res;
    try { res = await fetch(url, { headers: { authorization: 'Bearer ' + key() }, signal: ac.signal }); }
    finally { clearTimeout(timer); }
    if (!res.ok) { seen = { at: Date.now(), provider: cfg.provider, ids: null, why: 'models list ' + res.status }; return null; }
    const j = await res.json();
    const ids = (j && (j.data || j.models) || []).map((m) => m && (m.id || m.name)).filter(Boolean);
    seen = { at: Date.now(), provider: cfg.provider, ids: ids.length ? ids : null, why: '' };
    return seen.ids;
  } catch (e) {
    seen = { at: Date.now(), provider: cfg.provider, ids: null, why: (e && e.message) || 'could not list models' };
    return null;
  }
}

/**
 * The ladder to try, in order: the operator's pick, then whatever answered last
 * time, then the preference order — with anything this account does not have
 * removed, and its own models kept behind as a last resort.
 */
function ladderFrom(have, first) {
  const prefer = provider().models.map((m) => m.id);
  const has = have && have.length ? (id) => have.includes(id) : () => true;
  const out = [];
  // A model with no tokens left this minute is not worth a round trip; it comes
  // back on its own as soon as the provider says its bucket has refilled.
  const add = (id) => { if (id && !out.includes(id) && !limitedNow(id)) out.push(id); };
  // A job that needs the strongest reader asks for it by name, ahead of the
  // writer's own pick (see captions:grammar) — only when this account's model
  // list is KNOWN to have it: an unknown list (a custom provider, a failed
  // /models fetch) says yes to everything, and a Groq model id sent to some
  // other provider is a wasted request at best.
  if (have && have.length) for (const id of (first || [])) if (have.includes(id)) add(id);
  // An explicit choice is an instruction and is tried first, present or not:
  // the operator may know something the list does not.
  if (cfg.model) add(cfg.model);
  if (health.model && has(health.model)) add(health.model);
  for (const id of prefer) if (has(id)) add(id);
  // Nothing preferred survived — use whatever chat model the account really has
  // rather than giving up, which is the case a fixed list cannot cover at all.
  if (have && have.length) {
    for (const id of have) if (!NOT_CHAT_RX.test(id)) add(id);
  } else {
    for (const id of prefer) add(id);
  }
  return out;
}

let cfg = { on: true, provider: DEFAULT_PROVIDER, key: '', model: '', url: '' };
/* The key from the 🎤 Listen panel, pushed in by main.js. Used only when this
 * feature has no key of its own AND the two are the same provider — a Groq key
 * is a Groq key, and asking a church to paste it twice is not a design. */
let borrowedKey = { provider: '', key: '' };
const health = { fails: 0, coolUntil: 0, why: '', lastMs: 0, ok: 0, failed: 0, model: '' };

function provider() { return PROVIDERS[cfg.provider] || PROVIDERS[DEFAULT_PROVIDER]; }
function endpoint() { return cfg.provider === 'custom' ? (cfg.url || '') : provider().url; }
/** The effective key: this feature's own, or the ear's when they share a provider. */
function key() {
  if (cfg.key) return cfg.key;
  if (borrowedKey.key && borrowedKey.provider === cfg.provider) return borrowedKey.key;
  return '';
}
/** The head of the ladder as it stands right now, for the panel to report. */
const modelId = () => ladderFrom(seen.provider === cfg.provider ? seen.ids : null)[0];

function configure({ on, provider: p, key: k, model, url } = {}) {
  const before = cfg.provider;
  cfg = {
    on: on === undefined ? true : !!on,
    provider: PROVIDERS[p] ? p : DEFAULT_PROVIDER,
    key: String(k || '').trim(),
    model: String(model || '').trim(),
    url: String(url || '').trim(),
  };
  if (cfg.provider !== before) health.model = '';
  /*
   * The discovered model list is dropped on EVERY settings change, not only when
   * the provider changes. This is called on startup and when the operator edits
   * something — never per caption — so it costs one small request at exactly the
   * moment somebody is asking "why is this not working", which is the moment a
   * stale list is worth least.
   */
  seen = { at: 0, provider: '', ids: null, why: '' };
  limited.clear();
  health.fails = 0; health.coolUntil = 0; health.why = '';
  return state();
}
/** Tell this module what key the cloud ear is holding (see `key()` above). */
function shareKey(providerId, k) {
  borrowedKey = { provider: String(providerId || ''), key: String(k || '').trim() };
}

/** Configured and not sulking, whether or not the caption writer itself is switched on. */
function reachable() { return !!(key() && endpoint() && Date.now() >= health.coolUntil); }
/** On, configured, and not currently sulking. */
function ready() {
  return !!(cfg.on && key() && endpoint() && Date.now() >= health.coolUntil);
}
/** The shape `socialCopy.suggest({ llm })` wants. */
const isAvailable = async () => ready();

function state() {
  return {
    on: !!cfg.on,
    provider: cfg.provider,
    providerName: provider().name,
    model: cfg.model || modelId(),
    usingModel: health.model || '',
    url: cfg.url,
    hasKey: !!cfg.key,
    borrowingKey: !cfg.key && !!key(),     // "you set this up in the Listen panel"
    free: !!provider().free,
    ready: ready(),
    cooling: Math.max(0, health.coolUntil - Date.now()),
    why: health.why,
    lastMs: health.lastMs,
    wrote: health.ok, failed: health.failed,
    providers: Object.values(PROVIDERS).map((x) => ({
      id: x.id, name: x.name, label: x.label, blurb: x.blurb, free: x.free,
      keyUrl: x.keyUrl, keyHint: x.keyHint, models: x.models, needsUrl: x.id === 'custom',
    })),
  };
}

/*
 * SULKING. Writing a caption is not on anybody's critical path, but a church
 * hall with no internet must not pay a 30-second timeout on every one of ten
 * clips in a batch. Three failures and it stands down for a while.
 */
const COOL_STEPS = [20e3, 120e3, 600e3];
function trip(why, forMs) {
  health.fails++; health.failed++;
  health.why = why;
  const wait = forMs || COOL_STEPS[Math.min(COOL_STEPS.length - 1, health.fails - 1)];
  if (health.fails >= 3 || forMs) health.coolUntil = Date.now() + wait;
}
function cleared(ms, model) { health.fails = 0; health.why = ''; health.coolUntil = 0; health.lastMs = ms; health.ok++; health.model = model; }

function headers() {
  const h = { authorization: 'Bearer ' + key(), 'content-type': 'application/json' };
  if (cfg.provider === 'openrouter') {
    h['http-referer'] = 'https://church.work.space';
    h['x-title'] = 'Church Work Space';
  }
  return h;
}

/** The text of an OpenAI-shaped answer, whichever field this provider used. */
function textFrom(json) {
  const c = json && json.choices && json.choices[0];
  if (!c) return '';
  const m = c.message || {};
  if (typeof m.content === 'string') return m.content;
  // Some providers return content as a list of parts.
  if (Array.isArray(m.content)) return m.content.map((p) => (p && (p.text || p.content)) || '').join('');
  return c.text || '';
}

/**
 * One prompt in, the words out — or '' meaning "this pass did not happen".
 * Never throws.
 *
 * `json: true` asks the provider for strict JSON where it supports it. It is a
 * request, not a guarantee, so the caller still parses defensively (a model
 * that wraps JSON in a ```json fence is the norm, not the exception).
 */
async function chat({ system, prompt, maxTokens = 1400, temperature = 0.8, json = false, timeoutMs = 30000, signal, evenIfOff = false, prefer = null } = {}) {
  // evenIfOff: other features ride on this account (the clip judge) and must not
  // stop because the operator switched the CAPTION writer off
  if (!(evenIfOff ? reachable() : ready())) return '';
  const t0 = Date.now();
  const have = await discoverModels(signal);
  const list = ladderFrom(have, prefer).slice(0, 4);
  const tried = [];

  /** One request. Returns { text } | { retryNoJson } | { next } | { stop, why, forMs }. */
  const askOnce = async (model, useJson) => {
    const body = Object.assign({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: String(prompt || '') },
      ],
      temperature,
      max_tokens: maxTokens,
    }, tuneFor(model));
    if (useJson) body.response_format = { type: 'json_object' };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true });
    let res;
    try {
      res = await fetch(endpoint(), { method: 'POST', headers: headers(), body: JSON.stringify(body), signal: ac.signal });
    } catch (e) {
      return { stop: true, why: (e && e.name === 'AbortError')
        ? 'the writing service did not answer in time'
        : 'could not reach the writing service' + (e && e.message ? ' (' + e.message + ')' : '') };
    } finally { clearTimeout(timer); }

    if (res.ok) {
      let jsonBody = null;
      try { jsonBody = await res.json(); } catch (e) { jsonBody = null; }
      const text = textFrom(jsonBody);
      /*
       * EMPTY CONTENT IS THE REASONING MODEL'S OTHER FAILURE, not a dead
       * service. gpt-oss puts its deliberation in `reasoning` and, given a
       * small budget, has nothing left for `content`. Dropping the JSON
       * envelope is the same repair that fixes json_validate_failed, so it
       * gets the same second chance before the ladder moves on.
       */
      if (!text) return useJson ? { retryNoJson: true } : { next: true, why: 'answered with nothing' };
      return { text, model };
    }

    let errText = '';
    try { errText = (await res.text()).slice(0, 600); } catch (e) { errText = ''; }
    if (res.status === 429) {
      /*
       * FULL, NOT BROKEN. The allowance is per model and per minute, so this one
       * steps aside for as long as the provider says and the next one down —
       * with its own untouched bucket — writes this caption instead.
       */
      const wait = Math.min(600e3, Math.max(5000,
        waitMs(res.headers.get('x-ratelimit-reset-tokens'))
        || waitMs(res.headers.get('retry-after'))
        || 30000));
      limited.set(model, Date.now() + wait);
      if (health.model === model) health.model = '';
      return { next: true, why: 'has no allowance left for the moment' };
    }
    if (res.status === 401 || res.status === 403) {
      return { stop: true, why: 'that key was refused — check it in Settings', forMs: 600e3 };
    }
    // The model ran out of room for its JSON: same model, no JSON envelope.
    if (res.status === 400 && JSON_FAILED_RX.test(errText) && useJson) return { retryNoJson: true };
    // The model is gone: next one down.
    if ((res.status === 404 || res.status === 400) && GONE_RX.test(errText)) return { next: true, why: 'is not there any more' };
    /*
     * Any other refusal of THIS request (a 400 the rules above do not know —
     * measured on the live server: two of six whole-sermon reads came back
     * "answered 400" and the whole ladder stopped there) is no reason to stop
     * the ladder: the next model may well take it. The provider's own words go
     * into the reason, so the next one of these can be read rather than guessed.
     */
    const said = (() => { try { const j = JSON.parse(errText); return (j && j.error && (j.error.message || j.error.code)) || ''; } catch (e) { return errText; } })();
    const why = 'the writing service answered ' + res.status + (said ? ' (' + String(said).replace(/\s+/g, ' ').slice(0, 160) + ')' : '');
    if (res.status === 400 || res.status === 413 || res.status === 422) return { next: true, why };
    return { stop: true, why };
  };

  let lastWhy = '';
  for (const model of list) {
    tried.push(model);
    let r = await askOnce(model, json);
    if (r.retryNoJson) r = await askOnce(model, false);
    if (r.text) { cleared(Date.now() - t0, r.model); return r.text; }
    if (r.stop) { trip(r.why, r.forMs); return ''; }
    lastWhy = r.why || lastWhy;
  }
  /*
   * Every model on the ladder is out of allowance — the only case that really is
   * "come back in a minute". The wait is the SOONEST any of them refills, not a
   * flat cool-down, because a minute later there is a caption to be had.
   */
  const soonest = list.length
    ? Math.min(...list.map((m) => Math.max(0, (limited.get(m) || 0) - Date.now())).filter((n) => n > 0), 300e3)
    : 300e3;
  const allFull = list.length && list.every((m) => limitedNow(m));
  if (allFull) {
    trip('the free allowance is used up for the moment — it comes back in about '
      + Math.max(1, Math.round(soonest / 1000)) + 's', Math.max(5000, soonest));
    return '';
  }
  trip(`none of the writing models would answer (tried ${tried.join(', ')}${lastWhy ? ' — ' + lastWhy : ''})`, 300e3);
  return '';
}

/**
 * Pull the first JSON value out of an answer.
 *
 * Even told to reply with JSON only, models wrap it in prose or a ```json
 * fence, so the text is scanned for a balanced object rather than parsed whole.
 * Identical in behaviour to llm.parseJson so the two writers are
 * interchangeable from social-copy.js's point of view.
 */
function parseJson(text, { array = false } = {}) {
  if (!text) return null;
  const open = array ? '[' : '{';
  const close = array ? ']' : '}';
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; } }
    }
  }
  return null;
}

/**
 * Prove the key works, from the operator's chair — the whole round trip, not a
 * ping, because "is this key right, does this hall's network let it out, how
 * long will it take from here" are only answered by asking a real question.
 */
async function test() {
  if (!key()) return { ok: false, error: 'No key yet. Paste one and try again.' };
  if (!endpoint()) return { ok: false, error: 'No address for that service yet.' };
  const saved = { on: cfg.on, cool: health.coolUntil, fails: health.fails };
  cfg.on = true; health.coolUntil = 0; health.fails = 0;
  const t0 = Date.now();
  try {
    const out = await chat({
      system: 'You reply with JSON only.',
      prompt: 'Reply with exactly this JSON and nothing else: {"ok":true}',
      maxTokens: 20, temperature: 0, json: true, timeoutMs: 20000,
    });
    const ms = Date.now() - t0;
    const j = parseJson(out);
    if (!out) return { ok: false, error: health.why || 'It did not answer.', ms };
    return { ok: true, ms, provider: provider().name, model: health.model || modelId(),
             free: !!provider().free, understood: !!(j && j.ok) };
  } finally {
    cfg.on = saved.on;
    if (health.fails === 0) { health.coolUntil = saved.cool; health.fails = saved.fails; }
  }
}

/**
 * Where and as whom to ask — for the other cloud features that ride on this
 * account rather than keeping a key of their own (cloudsee.js: the reframe's
 * eye). One key, configured once, in one place.
 */
function access() {
  return {
    provider: cfg.provider, providerName: provider().name, free: !!provider().free,
    key: key(), url: endpoint(), modelsUrl: cfg.provider === 'custom' ? '' : provider().modelsUrl,
    model: cfg.model, headers: headers(),
  };
}

module.exports = {
  configure, shareKey, state, ready, reachable, isAvailable, chat, parseJson, test, textFrom, access,
  PROVIDERS, DEFAULT_PROVIDER,
  _health: () => health,
  _cfg: () => cfg,
  _limited: () => limited,
  waitMs,
};
