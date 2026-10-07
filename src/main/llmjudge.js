'use strict';
const llm = require('./llm');

/*
 * THE EDITOR THAT READS.
 *
 * highlights.js already judges clips on what was said — but through regexes and
 * a pause curve, because that is all a rules engine can do. Those got a long
 * way and there is a ceiling on them, and it is always the same ceiling: every
 * complaint about this feature has been "it cut before the point landed", and
 * the reason is that silence cannot tell a dramatic pause from a finished
 * thought. `closerPenalty` scores "But you might have forgotten." as a fine
 * ending — short, declarative, full-stopped — when it is plainly a setup.
 *
 * So this module asks a model that can actually read the sentence. Three passes,
 * in the order they earn their time:
 *
 *   1. endings  — where should this clip STOP? The complaint, answered directly.
 *   2. ranking  — which of these clips work standing alone?
 *   3. titles   — a title from what was said, not a sentence chopped at a comma.
 *
 * THE RULES THIS MODULE PLAYS BY, all of them load-bearing:
 *
 *   - It only ever ADJUSTS a decision the rules engine already made. There is no
 *     path where the model picks a clip out of nothing, so a bad answer costs
 *     accuracy, never a crash and never an empty panel.
 *   - Every pass returns null on anything unexpected and the caller keeps the
 *     rules result. Small models emit prose, fenced JSON, wrong keys, and
 *     out-of-range indices; all of that is a no-op here, not an error.
 *   - Nothing it returns is trusted unverified. An ending must be one of the
 *     options offered; a title must be built from words the speaker actually
 *     said (see `titleIsGrounded`) — a 1.5B model asked for a title will
 *     otherwise happily invent a sermon.
 */

/* How many candidates get the ending treatment. Each is its own llama-cli run,
 * so this is the main cost dial. The ones that need it are the ones whose
 * ending the rules engine was least sure about, so they are sorted by that. */
const MAX_ENDING_CALLS = 12;

/* Model reload dominates a short prompt, so the passes that CAN be batched are
 * (ranking, titles) — one call each, whole set at once. Endings are not: a 1.5B
 * model given four independent numbered lists reliably crosses them over. */
const RANK_TIMEOUT = 180000;
const TITLE_TIMEOUT = 180000;
const ENDING_TIMEOUT = 90000;

const words = (s) => String(s || '').toLowerCase().match(/[a-z']+/g) || [];
/* The passes below are asked through `ask`, so the same three questions can go
 * to this PC's small model or to a large hosted one (see makeCloudJudge). */
const localAsk = (a) => llm.chat(a);
const clip1 = (s, n) => (s.length > n ? s.slice(0, n).trim() + '…' : s);

/* ------------------------------- 1. endings ------------------------------ */

/**
 * Where should this clip stop?
 *
 * `opts` are the possible last sentences, in order, each already checked by the
 * caller for fitting the length budget. The model picks one; anything outside
 * the list is discarded and the caller's own choice stands.
 *
 * The prompt names the failure mode explicitly ("still building to a point"),
 * because that is the distinction the acoustic tests cannot make and the one
 * this whole pass exists for.
 */
async function judgeEnding({ opening, chosen, options, model, ask = localAsk }) {
  if (!options || options.length < 2) return null;
  const list = options.map((o, i) => `${i + 1}. ${o.text}`).join('\n');
  const sys = 'You are a video editor choosing where a clip of a sermon should end. '
    + 'You reply with JSON and nothing else.';
  const prompt =
`A short video clip of a sermon opens with:
"${clip1(opening, 300)}"

The clip must end at the end of one of these lines:
${list}

Choose where it should end.

Rules:
- The clip has to finish a complete thought. Never end while the speaker is still building to a point.
- If the speaker sets something up, the clip must include the payoff.
- A pause does not mean the thought is over. Preachers pause before the important line.
- Do not run on past the end of the thought just to make the clip longer.

Reply with only this, and nothing else: {"end": <line number>}`;

  const out = await ask({ system: sys, prompt, model, maxTokens: 24, timeoutMs: ENDING_TIMEOUT });
  const j = llm.parseJson(out);
  if (!j) return null;
  const n = parseInt(j.end, 10);
  if (!Number.isFinite(n) || n < 1 || n > options.length) return null;
  const pick = options[n - 1];
  // Same answer as the rules engine — say so, so the caller can skip the work.
  if (chosen != null && pick.i === chosen) return { i: pick.i, changed: false };
  return { i: pick.i, changed: true };
}

/* ------------------------------- 2. ranking ------------------------------ */

/**
 * Score the pool 0–10 on whether each clip works standing alone.
 *
 * Only the opening and the ending of each clip go in the prompt. That is not a
 * shortcut for context — it is what the judgement is actually about: whether a
 * stranger can follow the first line, and whether the last line lands. Sending
 * every word of twenty 90-second clips would fill the context window with the
 * middles, which are the part nothing hinges on.
 *
 * Returns a Map of id → 0..10, missing entries meaning "not judged".
 */
async function rankClips({ clips, model, ask = localAsk, full = false }) {
  if (!clips || clips.length < 2) return null;
  // A large model can hold every word of twenty clips, and the middle is where
  // "does it stay on one point / is it worth remembering" is actually decided.
  // A small one cannot, so it gets the edges only (see above).
  const blocks = clips.map((c) => (full && c.text
    ? `[${c.id}]\n"${clip1(c.text, 1100)}"`
    : `[${c.id}]\nopens: "${clip1(c.opening, 220)}"\nends: "${clip1(c.ending, 220)}"`));
  const sys = 'You are a video editor deciding which clips of a sermon will work as short social videos. '
    + 'You reply with JSON and nothing else.';
  const prompt =
`Here are ${clips.length} clips from one sermon. ${full ? 'For each you can read what is said in it.' : 'For each you can see how it opens and how it ends.'}

${blocks.join('\n\n')}

Score every clip from 0 to 10 on how well it works as a standalone short video.

A high score: it makes sense to someone who did not hear the rest of the service, it stays on one point, it says something worth remembering, and it finishes its thought.
A low score: it starts in the middle of a sentence, it leans on something the viewer never heard, it is filler or throat-clearing, it is mostly reading a passage aloud, or it stops before its point lands.

The transcript is automatic and misspells names and unusual words. Judge the point being made, not the spelling.

Reply with only this, and nothing else: {"scores": {"1": <0-10>, "2": <0-10>}} — one entry per clip, using the numbers in brackets, each a whole number you chose for that clip.`;

  const out = await ask({ system: sys, prompt, model, maxTokens: 16 * clips.length + 64, timeoutMs: RANK_TIMEOUT });
  const j = llm.parseJson(out);
  const raw = j && (j.scores || j.score);
  if (!raw || typeof raw !== 'object') return null;
  const valid = new Set(clips.map((c) => String(c.id)));
  const scores = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).replace(/[^\d]/g, '');
    if (!valid.has(key)) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    scores.set(key, Math.max(0, Math.min(10, n)));
  }
  // A model that scored two of twenty has not done the job; a partial map would
  // quietly hand those two an advantage over clips nobody rated.
  if (scores.size < Math.ceil(clips.length * 0.6)) return null;
  return scores;
}

/* -------------------------------- 3. titles ------------------------------ */

/**
 * A title has to be the speaker's own words.
 *
 * This is the one place the model could invent something the church would then
 * publish, so a title is kept only when most of its content words actually
 * appear in the clip. It catches the real failure — a small model handed a
 * garbled transcript writing a plausible sermon title about nothing that was
 * said — while still allowing the light rewording that makes a title read.
 */
function titleIsGrounded(title, clipText) {
  const stop = new Set(['the', 'a', 'an', 'and', 'but', 'or', 'of', 'to', 'in', 'is', 'it',
    'you', 'your', 'we', 'our', 'he', 'she', 'they', 'that', 'this', 'for', 'on', 'with',
    'be', 'are', 'was', 'will', 'can', 'do', 'not', 'no', 'yes', 'as', 'at', 'by', 'from',
    'have', 'has', 'had', 'i', 'my', 'me', 'his', 'her', 'them', 'us', 'so', 'if', 'when']);
  const src = new Set(words(clipText));
  const t = words(title).filter((w) => !stop.has(w) && w.length > 2);
  if (!t.length) return false;
  const hits = t.filter((w) => src.has(w)).length;
  return hits / t.length >= 0.6;
}

/** Tidy a model's title into the form the cards use. */
function cleanTitle(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  t = t.replace(/[.,;:!]+$/, '').trim();          // a question mark is a fine title ending
  if (!t) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Write a title for every chosen clip in one call.
 *
 * Returns a Map of id → title, holding only the titles that survived cleaning
 * and the grounding check. Callers keep `titleFromClip`'s result for the rest,
 * so a half-usable answer still improves half the panel.
 */
/* For a model big enough to write well. Measured: told only "3-8 words, the
 * speaker's own words", the 120B wrote "Destiny Fall Wife Children Prayer" —
 * grounded, and unpostable. */
const HOOK_RULE = "- Write it the way a person would title a video they want people to watch: a natural phrase or a short question, often the speaker's own most memorable line made shorter. Never a list of keywords (\"Destiny Fall Wife Children Prayer\" is wrong).\n";
async function writeTitles({ clips, model, ask = localAsk, hook = false }) {
  if (!clips || !clips.length) return null;
  const blocks = clips.map((c) => `[${c.id}] "${clip1(c.text, 700)}"`);
  const sys = 'You write titles for short clips of church sermons. You reply with JSON and nothing else.';
  const prompt =
`Write a title for each of these sermon clips.

${blocks.join('\n\n')}

Rules for every title:
- Between 3 and ${hook ? 10 : 8} words.
- Use the speaker's own words and meaning. Do not invent anything that is not in the clip.
- It must read as a title, not as half of a sentence.
${hook ? HOOK_RULE : ''}- No quotation marks and no full stop at the end.
- The transcript is automatic and misspells names and unusual words. If a word looks misspelled, leave it out rather than guessing at it.

Reply with only this, and nothing else: {"titles": {"1": "A title here", "2": "Another title"}} — one entry per clip, using the numbers in brackets.`;

  const out = await ask({ system: sys, prompt, model, maxTokens: 24 * clips.length + 96, timeoutMs: TITLE_TIMEOUT });
  const j = llm.parseJson(out);
  const raw = j && (j.titles || j.title);
  if (!raw || typeof raw !== 'object') return null;
  const byId = new Map(clips.map((c) => [String(c.id), c]));
  const titles = new Map();
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).replace(/[^\d]/g, '');
    const c = byId.get(key);
    if (!c || typeof v !== 'string') continue;
    const t = cleanTitle(v);
    const wc = t.split(' ').filter(Boolean).length;
    if (!t || wc < 2 || wc > 12) continue;
    if (!titleIsGrounded(t, c.text)) continue;
    titles.set(key, t);
  }
  return titles.size ? titles : null;
}

/**
 * The object highlights.js is handed. Built only when the operator asked for
 * this AND the runtime and weights are both present — `analyzeSermon` simply
 * checks whether it got one, so there is no second place that has to know the
 * rules for when this is on.
 */
function makeJudge({ model, maxEndingCalls = MAX_ENDING_CALLS } = {}) {
  if (!llm.isAvailable()) return null;
  const m = llm.modelFor(model);
  if (!m) return null;
  const stats = { endings: 0, endingsChanged: 0, ranked: 0, titled: 0, failed: 0 };
  const guard = async (fn) => {
    try { return await fn(); } catch (e) { stats.failed++; return null; }
  };
  return {
    modelId: m.id,
    modelName: m.name,
    maxEndingCalls,
    stats,
    ending: (a) => guard(async () => {
      const r = await judgeEnding({ ...a, model: m.id });
      stats.endings++;
      if (r && r.changed) stats.endingsChanged++;
      return r;
    }),
    rank: (a) => guard(async () => {
      const r = await rankClips({ ...a, model: m.id });
      if (r) stats.ranked = r.size;
      return r;
    }),
    titles: (a) => guard(async () => {
      const r = await writeTitles({ ...a, model: m.id });
      if (r) stats.titled = r.size;
      return r;
    }),
  };
}

/*
 * ☁️ THE SAME EDITOR, WITH A REAL BRAIN.
 *
 * The local reader is a 1.5B or 3B model on the church's own CPU. It could
 * only be trusted with the edges of each clip, only twelve endings, a short
 * list of options, and a small say in the ranking — and its titles were
 * rejected outright more often than not. The operator asked for an option that
 * makes Long-to-shorts "way better, the best".
 *
 * This is that option: the same three questions, asked of a 70–120B model on
 * the account the caption writer and 🎤 Listen already use (cloudwrite.js — one
 * Groq key, no new setup). A model that size can be given what the small one
 * could not: every word of every clip for the ranking, every candidate's
 * ending with the full list of places it could stop, and a ranking weight big
 * enough to change which clips are picked, not just their order. Every answer
 * still goes through the same checks — an ending must be one offered, a title
 * must be the speaker's own words — so a bad answer costs nothing.
 *
 * Its failures are not silent: `stats.why` carries the reason the last call
 * did not happen, for the studio to say out loud.
 */
const CLOUD_RANK_W = 2.0;   // vs LLM_RANK_W 1.2 for the local reader — still not the last word
function makeCloudJudge({ cloudwrite = require('./cloudwrite') } = {}) {
  if (!cloudwrite.reachable()) return null;
  const st0 = cloudwrite.state();
  const stats = { endings: 0, endingsChanged: 0, ranked: 0, titled: 0, failed: 0, calls: 0, why: '' };
  const ask = async (a) => {
    stats.calls++;
    // Reasoning models spend tokens before they answer: the small budgets the
    // local prompts ask for would leave them nothing to answer WITH.
    const once = () => cloudwrite.chat({
      system: a.system, prompt: a.prompt, temperature: 0, json: true, evenIfOff: true,
      maxTokens: Math.max(600, (a.maxTokens || 0) * 3), timeoutMs: 60000,
    });
    let out = await once();
    // a network blip gets one more go — measured on a real run, a single
    // "fetch failed" on the titles call left six clips with the rules' titles
    if (!out && /could not reach|did not answer/i.test(cloudwrite.state().why || '')) {
      await new Promise((r) => setTimeout(r, 1500));
      out = await once();
    }
    if (!out) { stats.failed++; stats.why = (cloudwrite.state().why || 'no answer'); }
    return out;
  };
  const guard = async (fn) => {
    try { return await fn(); } catch (e) { stats.failed++; stats.why = (e && e.message) || 'failed'; return null; }
  };
  return {
    cloud: true,
    modelId: 'cloud',
    modelName: (st0.usingModel || st0.model || 'a large model').split('/').pop() + ' (' + st0.providerName + ')',
    maxEndingCalls: 30,      // every candidate likely to be picked, not twelve
    endingScope: 30,
    maxOffer: 14,            // a big model can weigh a longer list of places to stop
    parallel: 4,             // endings asked four at a time (highlights.js) — the ladder spreads them over models
    rankWeight: CLOUD_RANK_W,
    rejectBelow: 1,          // a 0-1 from this harsh critic means "not a short": left out (see highlights.js)
    fullText: true,
    stats,
    ending: (a) => guard(async () => {
      const r = await judgeEnding({ ...a, ask });
      stats.endings++;
      if (r && r.changed) stats.endingsChanged++;
      return r;
    }),
    rank: (a) => guard(async () => {
      const r = await rankClips({ ...a, ask, full: true });
      // Every clip given the SAME score is not a judgement — measured: the model
      // once echoed the format example back as all zeros, and with rejectBelow
      // that "ranking" would have thrown the whole set out as not worth posting.
      if (r && r.size >= 3 && new Set(r.values()).size === 1) { stats.why = 'the ranking came back flat'; return null; }
      if (r) stats.ranked = r.size;
      return r;
    }),
    titles: (a) => guard(async () => {
      const r = await writeTitles({ ...a, ask, hook: true });
      if (r) stats.titled = r.size;
      return r;
    }),
    /*
     * The whole sermon, read section by section (shortplan.js). Asked with a
     * budget that fits the free tier's tokens-a-minute: a request bigger than
     * the minute's allowance is refused outright, which is how the ranking and
     * titles were measured silently doing nothing on a real sermon.
     */
    plan: (a) => guard(async () => {
      const planAsk = async ({ system, prompt, maxTokens }) => {
        stats.calls++;
        const out = await cloudwrite.chat({
          system, prompt, temperature: 0, json: true, evenIfOff: true,
          maxTokens: maxTokens || 3000, timeoutMs: 150000, effort: 'medium',
          prefer: ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile'],
        });
        if (!out) { stats.why = cloudwrite.state().why || 'no answer'; (stats.errors = stats.errors || []).push(stats.why); }
        return out;
      };
      const r = await require('./shortplan').planShorts({ ...a, ask: planAsk });
      if (r) { stats.planned = r.moments.length; stats.titled = r.moments.filter((m) => m.title).length; stats.ranked = r.found; }
      else stats.failed++;
      return r;
    }),
  };
}

module.exports = {
  makeJudge, makeCloudJudge, judgeEnding, rankClips, writeTitles,
  _internals: { titleIsGrounded, cleanTitle, MAX_ENDING_CALLS },
};
