'use strict';
/*
 * CLAUDE, FOR READING TEXT CLOSELY — the caption proof-reader's best reader.
 *
 * When the server has an ANTHROPIC_API_KEY (the same key the AI Montage's
 * director uses), the captions' ✨ AI check asks Claude Opus 5.5 instead of
 * the free Groq models: it reads a whole sermon's worth of context and is far
 * better at telling "the Lamb of guard" from what was said. Without the key
 * nothing changes — Groq (or the PC's own model) does it as before.
 *
 * MW_CAPTIONS_AI=groq keeps the captions on Groq even with the key set;
 * MW_CAPTIONS_MODEL picks another Claude model.
 */

const ready = () => !!process.env.ANTHROPIC_API_KEY && String(process.env.MW_CAPTIONS_AI || '').toLowerCase() !== 'groq';
const model = () => process.env.MW_CAPTIONS_MODEL || 'claude-opus-5-5';

let client = null;
function getClient() {
  if (client) return client;
  const Anthropic = require('@anthropic-ai/sdk');
  const Client = Anthropic.default || Anthropic;
  client = { api: new Client({ maxRetries: 2, timeout: 5 * 60 * 1000 }), Client };
  return client;
}

/**
 * One request whose answer must be JSON matching `schema` (structured
 * outputs). Resolves to the answer's text, or null when it was declined.
 */
async function chatJson({ system, prompt, schema, effort = 'high', maxTokens = 16000 }) {
  const { api, Client } = getClient();
  const body = {
    model: model(),
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  let res;
  try {
    // A declined request is re-run on Anthropic's recommended fallback model
    // instead of coming back empty (the same as the montage director).
    res = await api.beta.messages.create(Object.assign({}, body, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }));
  } catch (e) {
    if (e instanceof Client.BadRequestError) res = await api.messages.create(body);
    else throw e;
  }
  if (!res || res.stop_reason === 'refusal') return null;
  return (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

const state = () => ({ ready: ready(), model: model(), name: 'Claude' });

module.exports = { ready, chatJson, state, model };
