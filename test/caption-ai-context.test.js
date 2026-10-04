'use strict';
/*
 * ✨ THE AI CHECK READS THE WHOLE SERMON — no network, the model stubbed.
 *
 * "I'm still having to make too many edits": the AI used to see forty caption
 * lines and two either side, nothing of what the sermon was about, and threw
 * away its own best fixes ("is real" -> "Israel") as rewrites. Pinned here:
 *
 *   1. the whole transcript is read once for notes (topic, scripture, names,
 *      mishearings), and cached;
 *   2. every batch is shown those notes, the Word Book (the church's own
 *      spellings + the editor's past corrections) and what was said either
 *      side — across batch boundaries, not just at the ends;
 *   3. a respaced mishearing is a correction, a rewrite is still refused,
 *      and "sure" comes through so the studio can make those at once;
 *   4. the Claude path asks Opus 5.5 with adaptive thinking, structured JSON
 *      and the refusal fallback.
 *
 *   node test/caption-ai-context.test.js
 */
const G = require('../src/renderer/capgrammar.js');

let pass = 0, fail = 0;
const check = (n, c, d) => { console.log((c ? '  PASS ' : '  FAIL ') + n + (d !== undefined ? '  -> ' + d : '')); c ? pass++ : fail++; };
const head = (s) => console.log('\n' + s);

// A sermon as speech recognition hears it: four words a line, with the mistakes it makes.
const SPOKEN = [
  'today we are going to', 'look at the story of', 'the children of is real', 'crossing the read sea',
  'Moses lifted up his rod', 'and the waters were divided', 'can somebody say a men',
];
const FILLER = 'and God made a way where there was no way for his people when they were afraid and the enemy was behind them';
function sermon(n) {
  const lines = [];
  const f = FILLER.split(' ');
  for (let k = 0; lines.length < n; k++) {
    if (k % 9 === 0) lines.push(...SPOKEN);
    else lines.push(f.slice((k * 4) % (f.length - 4), (k * 4) % (f.length - 4) + 4).join(' '));
  }
  return lines.slice(0, n).map((text, i) => ({ i, text }));
}

// The stand-in model: notes for the brief; corrections for a batch, from what the prompt shows it.
function fakeModel(log) {
  return async ({ system, prompt, schema }) => {
    if (schema === G.BRIEF_SCHEMA || /^Transcript:/.test(prompt)) {
      log.briefs.push(prompt.length);
      return JSON.stringify({
        topic: 'God makes a way: Israel crossing the Red Sea (Exodus 14)', speaker: 'Pastor Adeyemi',
        scriptures: ['Exodus 14:21 — And Moses stretched out his hand over the sea'], names: ['Moses', 'Israel'],
        terms: ['Red Sea'], mishearings: [{ heard: 'read sea', meant: 'Red Sea' }, { heard: 'is real', meant: 'Israel' }],
      });
    }
    log.batches.push(prompt);
    const fixes = [];
    for (const m of prompt.matchAll(/^(\d+) \| (.*)$/gm)) {
      const n = +m[1], t = m[2];
      // it can only make these if the notes reached it
      if (/SERMON NOTES[\s\S]*Red Sea/.test(prompt)) {
        if (t.includes('is real')) fixes.push({ n, text: t.replace('is real', 'Israel'), why: 'misheard Israel', sure: true });
        if (t.includes('read sea')) fixes.push({ n, text: t.replace('read sea', 'Red Sea'), why: 'misheard Red Sea', sure: true });
      }
      if (t.includes('a men')) fixes.push({ n, text: t.replace('a men', 'Amen'), why: 'misheard Amen', sure: true });
      if (t === 'Moses lifted up his rod' && n < 10) fixes.push({ n, text: 'Moses lifted up his staff', why: 'rod or staff', sure: false });
      if (t === 'look at the story of' && n < 10) fixes.push({ n, text: 'let us all read the passage about', why: 'clearer', sure: true });
    }
    return JSON.stringify({ fixes });
  };
}

(async () => {
  const { proofread, _briefCache } = require('../src/main/capproof.js');

  head('[1] The whole sermon is read for notes, once');
  const all = sermon(120);
  let log = { briefs: [], batches: [] };
  const terms = ['Grace Chapel', 'Pastor Adeyemi'];
  const known = [{ from: 'grays chapel', to: 'Grace Chapel' }];
  const res = await proofread({ lines: all, passage: all, mode: 'exact', caseMode: 'normal' }, { engine: 'groq', ask: fakeModel(log), terms, known });
  const words = all.map((l) => l.text).join(' ').split(' ').length;
  check('one brief, from the whole transcript', log.briefs.length === 1 && log.briefs[0] > words * 3, `${log.briefs.length} brief(s), ${log.briefs[0]} chars for ${words} words`);
  check('the topic comes back', /Red Sea/.test(res.topic), res.topic);

  head('[2] Every batch sees the notes, the Word Book and what was said around it');
  check('120 lines on Groq = 3 batches of 40', log.batches.length === 3, `${log.batches.length}`);
  check('every batch has the sermon notes and its scripture', log.batches.every((p) => /SERMON NOTES/.test(p) && /Exodus 14:21/.test(p)));
  check('every batch has the church\'s own spellings', log.batches.every((p) => /WORDS THIS CHURCH USES[^\n]*Grace Chapel/.test(p)));
  check('every batch has the editor\'s past corrections', log.batches.every((p) => /"grays chapel" -> "Grace Chapel"/.test(p)));
  const mid = log.batches[1];
  const lastOfFirst = all[39].text, firstOfThird = all[80].text;
  check('a middle batch reads what was said before it (across the batch seam)', /WHAT WAS SAID JUST BEFORE[\s\S]*/.test(mid) && mid.split('CAPTION LINES')[0].includes(lastOfFirst));
  check('…and after it', mid.split('CAPTION LINES')[1].includes(firstOfThird));
  check('context lines are not offered for correction', !/^39 \|/m.test(mid) && !/^80 \|/m.test(mid));

  head('[3] Fixes: respaced mishearings kept, rewrites refused, "sure" passed on');
  const byLine = new Map(res.fixes.map((f) => [f.i, f]));
  const israel = res.fixes.filter((f) => /Israel/.test(f.text));
  const amen = res.fixes.filter((f) => /Amen/.test(f.text));
  check('"the children of is real" -> "the children of Israel" (two words heard as one)', israel.length > 0 && israel.every((f) => f.text === 'the children of Israel'), israel[0] && israel[0].text);
  check('"can somebody say a men" -> "can somebody say Amen"', amen.length > 0 && amen[0].text === 'can somebody say Amen');
  check('"the read sea" fixed from the notes', res.fixes.some((f) => f.text === 'crossing the Red Sea'));
  check('a rewrite of a line is refused', !res.fixes.some((f) => /passage about/.test(f.text)) && res.rejected >= 1, `rejected ${res.rejected}`);
  check('sure fixes are marked sure', israel.every((f) => f.sure === true));
  const rod = byLine.get(4);
  check('a judgement call is marked not sure', rod && rod.sure === false, rod && rod.text);

  head('[4] The notes are kept until the words change');
  log = { briefs: [], batches: [] };
  await proofread({ lines: all.slice(0, 10), passage: all }, { engine: 'groq', ask: fakeModel(log), terms, known });
  check('a second check of the same sermon does not read it all again', log.briefs.length === 0 && log.batches.length === 1);
  _briefCache.clear();

  head('[5] Claude reads more at once');
  log = { briefs: [], batches: [] };
  await proofread({ lines: all, passage: all }, { engine: 'claude', ask: fakeModel(log), terms, known });
  check('120 lines on Claude = one batch', log.batches.length === 1, `${log.batches.length}`);

  head('[6] Without the notes (an AI that cannot write them), it still checks');
  _briefCache.clear();
  log = { briefs: [], batches: [] };
  const noBrief = async (a) => (/^Transcript:/.test(a.prompt) ? 'not json' : fakeModel(log)(a));
  const r2 = await proofread({ lines: all.slice(0, 10), passage: all.slice(0, 10) }, { engine: 'groq', ask: noBrief });
  check('still corrects what it can', r2.fixes.some((f) => /Amen/.test(f.text)) && r2.failedBatches === 0);

  head('[7] The Claude request itself (SDK stubbed)');
  const sent = [];
  class FakeClient {
    constructor() {
      const create = async (body) => { sent.push(body); return { stop_reason: 'end_turn', model: body.model, content: [{ type: 'text', text: '{"fixes":[]}' }] }; };
      this.messages = { create }; this.beta = { messages: { create } };
    }
  }
  FakeClient.BadRequestError = class extends Error {};
  require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'sdk', filename: 'sdk', loaded: true, exports: { default: FakeClient } };
  const ct = require('../src/main/claudetext.js');
  process.env.ANTHROPIC_API_KEY = 'test';
  check('ready when the server has the key', ct.ready() === true);
  process.env.MW_CAPTIONS_AI = 'groq';
  check('MW_CAPTIONS_AI=groq keeps captions on Groq', ct.ready() === false);
  delete process.env.MW_CAPTIONS_AI;
  const txt = await ct.chatJson({ system: 's', prompt: 'p', schema: G.FIX_SCHEMA });
  const b = sent[0] || {};
  check('Opus 5.5', b.model === 'claude-opus-5-5', b.model);
  check('adaptive thinking, high effort', b.thinking && b.thinking.type === 'adaptive' && b.output_config && b.output_config.effort === 'high');
  check('structured JSON with the fix schema', b.output_config && b.output_config.format && b.output_config.format.type === 'json_schema' && b.output_config.format.schema === G.FIX_SCHEMA);
  check('refusal fallback on', Array.isArray(b.betas) && b.betas.includes('server-side-fallback-2026-07-01') && b.fallbacks === 'default');
  check('the answer text comes back', txt === '{"fixes":[]}');
  delete process.env.ANTHROPIC_API_KEY;

  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
