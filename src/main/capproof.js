'use strict';
/*
 * ✨ THE CAPTION PROOF-READER, READING THE WHOLE SERMON.
 *
 * The rules in capgrammar.js catch the mistakes that have a pattern. What they
 * cannot catch is a word speech recognition misheard as another real word —
 * "the Lamb of GUARD", "the children of IS REAL" — which needs someone who
 * knows what the sermon is about. So:
 *
 *   1. the whole transcript is read once for NOTES — topic, every scripture
 *      quoted, names, recurring words, mishearings it can see (cached until
 *      the words change);
 *   2. each batch of lines is corrected with those notes, the church's Word
 *      Book (its own spellings, and the corrections the editor made before),
 *      and ~25 lines of what was said either side;
 *   3. every answer is held to CapGrammar.vetAiLine — a "correction" that
 *      rewrote the line is thrown away, because a caption is what was SAID —
 *      and marked SURE or not, so the studio can make the sure ones at once.
 *
 * `deps.ask({ system, prompt, schema, maxTokens })` is the model (Claude, the
 * free Groq models, or the PC's own); it is passed in so this is testable.
 */
const crypto = require('crypto');
const capGrammar = require('../renderer/capgrammar.js');

const briefCache = new Map();
async function sermonBrief(engine, ask, words, CancelledError) {
  const all = words.join(' ').replace(/\s+/g, ' ').trim();
  const count = all ? all.split(' ').length : 0;
  if (count < 60) return null;
  // Claude reads all of it; the free Groq models have 8,000 tokens a minute, so
  // ~3,000 words (the opening and the close); the PC's model a page.
  const cap = engine === 'claude' ? 60000 : engine === 'groq' ? 3000 : 900;
  let text = all;
  if (count > cap) { const w = all.split(' '); text = w.slice(0, Math.ceil(cap * 0.6)).join(' ') + ' … ' + w.slice(-Math.floor(cap * 0.4)).join(' '); }
  const key = engine + ':' + crypto.createHash('sha1').update(text).digest('hex');
  if (briefCache.has(key)) return briefCache.get(key);
  const { system, prompt } = capGrammar.buildBriefPrompt(text);
  let brief = null;
  try { brief = capGrammar.parseBrief(await ask({ system, prompt, schema: capGrammar.BRIEF_SCHEMA, maxTokens: engine === 'claude' ? 16000 : 1500 })); }
  catch (e) { if (CancelledError && e instanceof CancelledError) throw e; brief = null; }
  if (brief) { briefCache.set(key, brief); if (briefCache.size > 40) briefCache.delete(briefCache.keys().next().value); }
  return brief;
}

async function proofread({ lines, before, after, passage, caseMode, mode } = {}, deps = {}) {
  const { engine = 'groq', ask, terms = [], known = [], onProgress, cancelled = () => false, CancelledError } = deps;
  const okLine = (l) => l && Number.isFinite(+l.i) && typeof l.text === 'string';
  const L = (lines || []).filter(okLine);
  if (!L.length) return { fixes: [], checked: 0, rejected: 0, failedBatches: 0, topic: '' };
  const stop = () => { if (cancelled()) throw (CancelledError ? new CancelledError() : new Error('cancelled')); };
  // Everything that was said, in order — for the notes and the context either side of each batch.
  const P = (Array.isArray(passage) ? passage : []).filter(okLine).slice().sort((x, y) => x.i - y.i);
  const posOf = new Map(P.map((l, k) => [l.i, k]));
  const prog = typeof onProgress === 'function' ? onProgress : null;
  if (prog) prog(2);
  const brief = await sermonBrief(engine, ask, (P.length ? P : L).map((l) => l.text), CancelledError);
  if (prog) prog(engine === 'local' ? 5 : 15);
  const SIZE = engine === 'claude' ? 120 : engine === 'groq' ? 40 : 12;
  const SIDE = engine === 'local' ? 4 : 25;
  const textAround = (fromLine, toLine) => {
    if (P.length && posOf.has(fromLine) && posOf.has(toLine)) {
      const a = posOf.get(fromLine), z = posOf.get(toLine);
      return {
        before: P.slice(Math.max(0, a - SIDE), a).map((l) => l.text).join(' '),
        after: P.slice(z + 1, z + 1 + SIDE).map((l) => l.text).join(' '),
      };
    }
    return {
      before: (before || []).filter(okLine).map((l) => l.text).join(' '),
      after: (after || []).filter(okLine).map((l) => l.text).join(' '),
    };
  };
  const batches = [];
  for (let b = 0; b < L.length; b += SIZE) batches.push(L.slice(b, b + SIZE));
  const fixes = [];
  let asked = 0, failedBatches = 0, rejected = 0, done = 0;
  const runBatch = async (part) => {
    stop();
    const around = textAround(part[0].i, part[part.length - 1].i);
    const batch = part.map((l) => ({ n: l.i, text: l.text }));
    const { system, prompt } = capGrammar.buildAiPrompt(batch, { mode, brief, terms, known, before: around.before, after: around.after });
    let answer = null;
    try { answer = await ask({ system, prompt, schema: capGrammar.FIX_SCHEMA, maxTokens: engine === 'claude' ? 16000 : 2000 }); }
    catch (er) { if (CancelledError && er instanceof CancelledError) throw er; answer = null; }
    asked += part.length;
    const got = answer ? capGrammar.parseAiFixes(answer, batch) : null;
    if (!got) failedBatches++;
    else {
      for (const f of got) {
        const orig = part.find((l) => l.i === f.n);
        if (!orig) continue;
        const v = capGrammar.vetAiLine(orig.text, f.text, { caseMode, mode });
        if (v.ok) fixes.push({ i: f.n, text: v.text, why: f.why || 'AI correction', sure: !!f.sure });
        else if (v.reason !== 'no change') rejected++;
      }
    }
    done += part.length;
    if (prog) prog(Math.min(99, 15 + Math.round((done / L.length) * 85)));
  };
  // Claude takes a few batches at once; the free models one at a time (tokens per minute).
  const lanes = engine === 'claude' ? 3 : 1;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(lanes, batches.length) }, async () => {
    while (next < batches.length) await runBatch(batches[next++]);
  }));
  fixes.sort((x, y) => x.i - y.i);
  return { fixes, checked: asked, rejected, failedBatches, topic: brief && brief.topic ? brief.topic : '', brief };
}

module.exports = { proofread, sermonBrief, _briefCache: briefCache };
