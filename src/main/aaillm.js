'use strict';
/*
 * ►► ASSEMBLYAI'S LLM GATEWAY — THE MONTAGE'S EDITOR, ON THE SAME KEY AS THE EAR. ◄◄
 *
 * The Viral montage is only as good as the editor that chooses its lines. On a
 * free Groq account a three-hour service was too long to even read ("Please
 * reduce the length of the messages"), and the montage fell back to rules.
 * AssemblyAI — already the church's ear (ASSEMBLYAI_API_KEY) — also serves the
 * big models (Claude, GPT, Gemini) behind one OpenAI-style endpoint, billed to
 * the same AssemblyAI account. So a church with that key has a top editor with
 * room for the whole event, and nothing more to set up.
 *
 * The models are not hard-coded: the gateway is asked which it has, and the
 * best of them by preference is used (a model retired later is skipped by itself).
 * MW_AAI_LLM_MODEL names one outright.
 */
const BASE = () => (process.env.MW_AAI_LLM_URL || 'https://llm-gateway.assemblyai.com').replace(/\/+$/, '');
const key = () => String(process.env.ASSEMBLYAI_API_KEY || '').trim();
const ready = () => !!key() && String(process.env.MW_AAI_LLM || '').toLowerCase() !== 'off';

// best first: a strong reader of long text that follows a brief to the letter
const PREFER = [/claude.*opus/i, /claude.*sonnet/i, /gpt-5(?!.*(mini|nano))/i, /gemini.*pro/i, /claude/i, /gpt-5/i, /gemini/i, /gpt/i];
// the gateway's documented models, for when it will not list its own (no models endpoint is documented)
const KNOWN = ['claude-sonnet-4-6', 'claude-sonnet-4.6', 'claude-sonnet-4-5-20250929', 'gpt-5', 'gemini-2.5-pro'];
let listed = null, listedAt = 0, benched = new Map();

async function req(path, body, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 120000);
  try {
    const res = await fetch(BASE() + path, {
      method: body ? 'POST' : 'GET', signal: ac.signal,
      headers: Object.assign({ Authorization: key() }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!res.ok) {
      // a 400 says which fields it did not like (metadata.errors): keep them, so the status shows what to change
      const why = (json && (json.error && (json.error.message || json.error) || json.message)) || text.slice(0, 200);
      const errs = json && ((json.metadata && json.metadata.errors) || (json.error && json.error.metadata && json.error.metadata.errors));
      const e = new Error(`AssemblyAI LLM Gateway ${res.status}: ${typeof why === 'string' ? why : JSON.stringify(why)}${errs ? ' ' + JSON.stringify(errs).slice(0, 300) : ''}`); e.status = res.status; throw e;
    }
    return json;
  } finally { clearTimeout(t); }
}

/** The models this key can use, best first (asked at most every six hours). */
async function models() {
  if (listed && Date.now() - listedAt < 6 * 3600e3) return listed;
  let ids = [];
  try { const j = await req('/v1/models', null, 30000); ids = ((j && j.data) || []).map((m) => m.id).filter(Boolean); } catch (e) { ids = []; }
  const rank = (id) => { const i = PREFER.findIndex((rx) => rx.test(id)); return i < 0 ? 99 : i; };
  // newest first within a family (a higher version number in the id)
  const ver = (id) => { const m = String(id).match(/(\d+(?:[.-]\d+)?)/g); return m ? parseFloat(String(m[m.length - 1]).replace('-', '.')) : 0; };
  if (!ids.length) return KNOWN.slice();                             // not cached: asked again next time
  listed = ids.sort((a, b) => rank(a) - rank(b) || ver(b) - ver(a));
  listedAt = Date.now();
  return listed;
}

/**
 * One prompt in, the words out ('' when nothing could answer). Never throws.
 * Tries the best models in turn (a model that refuses or has gone is benched an hour).
 */
async function chat({ system, prompt, maxTokens = 4000, temperature = 0.8, json = false, timeoutMs = 150000 } = {}) {
  if (!ready()) return '';
  tries = [];
  const want = process.env.MW_AAI_LLM_MODEL ? [process.env.MW_AAI_LLM_MODEL] : (await models()).filter((m) => !(benched.get(m) > Date.now())).slice(0, 8);
  for (const model of want) {
    try {
      const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], max_tokens: maxTokens, temperature };
      if (json) body.response_format = { type: 'json_object' };
      // a body a model will not take ("invalid request body"): asked again plainer — no JSON mode, no
      // temperature, then a smaller answer — before the next model is tried
      const plainer = [(b) => { delete b.response_format; }, (b) => { delete b.temperature; }, (b) => { b.max_tokens = Math.min(b.max_tokens, 2000); }];
      let j = null;
      for (let k = 0; ; k++) {
        try { j = await req('/v1/chat/completions', body, timeoutMs); break; }
        catch (e) {
          tries.push({ model, why: e.message, at: Date.now() });
          // a model the account cannot use is not asked again plainer: the next one is tried (and this one rests six hours)
          if (/not have access|no access|not allowed for|upgrade/i.test(e.message)) { e.noAccess = true; throw e; }
          if (e.status !== 400 || k >= plainer.length) throw e; plainer[k](body);
        }
      }
      const c = j && j.choices && j.choices[0] && j.choices[0].message;
      const text = c ? (typeof c.content === 'string' ? c.content : (c.content || []).map((x) => x.text || '').join('')) : '';
      if (text.trim()) { last = { ok: true, model, at: Date.now() }; return text; }
    } catch (e) {
      last = { ok: false, model, why: e.message, at: Date.now() };
      if (e.status === 401 || e.status === 403) return '';           // the key cannot use the gateway: nothing else will work
      benched.set(model, Date.now() + (e.noAccess ? 6 : 1) * 3600e3);
    }
  }
  return '';
}
let last = null, tries = [];
const state = () => ({ ready: ready(), last, tries: tries.slice(-6) });

module.exports = { ready, chat, models, state, PREFER, KNOWN, _reset: () => { listed = null; benched = new Map(); } };
