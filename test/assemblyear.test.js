'use strict';
/*
 * THE ASSEMBLYAI EAR (assemblyear.js), against a fake AssemblyAI:
 *   [1] the newest model is asked for first, with the whole Word Book as key terms
 *   [2] a model or a list it does not take is asked again the next way down
 *   [3] each word comes back in seconds, with how sure it was
 *
 *   node test/assemblyear.test.js
 */
const path = require('path');
process.env.ASSEMBLYAI_API_KEY = 'test-key';
const aai = require(path.join(__dirname, '..', 'src/main/assemblyear'));
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };

function fake({ refuse = () => false } = {}) {
  const asked = [];
  const res = (status, j) => ({ ok: status < 300, status, json: async () => j });
  const fetchImpl = async (url, o) => {
    if (/\/upload$/.test(url)) return res(200, { upload_url: 'https://cdn/x' });
    if (/\/transcript$/.test(url)) {
      const body = JSON.parse(o.body);
      asked.push(body);
      return refuse(body) ? res(400, { error: 'not supported' }) : res(200, { id: 't1' });
    }
    return res(200, { status: 'completed', words: [{ text: 'Hallelujah', start: 120, end: 640, confidence: 0.9812 }, { text: 'Olayinka', start: 700, end: 1300, confidence: 0.41 }] });
  };
  return { asked, fetchImpl };
}

(async () => {
  console.log('\n[1] newest model, whole Word Book');
  {
    const f = fake();
    const terms = Array.from({ length: 1200 }, (_, i) => 'Name ' + i).concat(['Olayinka', 'Olayinka', 'a very long phrase of seven words here']);
    await aai.transcribe(Buffer.from('x'), { terms, fetchImpl: f.fetchImpl });
    const b = f.asked[0];
    ok(b.speech_models && b.speech_models[0] === 'universal-3-5-pro', 'Universal-3.5 Pro is asked for first', b.speech_models);
    ok(b.keyterms_prompt.length === 1000, 'up to 1,000 terms go, not the first 100', b.keyterms_prompt.length);
    ok(!b.keyterms_prompt.some((t) => t.split(' ').length > 6), 'a term longer than six words is left out (the API refuses it)');
  }

  console.log('\n[2] refused: the next way down');
  {
    const f = fake({ refuse: (b) => (b.speech_models || []).includes('universal-3-5-pro') });
    const w = await aai.transcribe(Buffer.from('x'), { terms: ['Olayinka'], fetchImpl: f.fetchImpl });
    ok(f.asked.length === 2 && f.asked[1].speech_models[0] === 'universal-3-pro' && f.asked[1].keyterms_prompt[0] === 'Olayinka', 'Universal-3 Pro, with the terms', f.asked);
    ok(w.length === 2, 'and the words come back');
    ok(w.model === 'universal-3-pro', 'and say which model heard them', w.model);
    const g = fake({ refuse: (b) => !!b.speech_models });
    await aai.transcribe(Buffer.from('x'), { terms: Array.from({ length: 300 }, (_, i) => 'Term ' + i), fetchImpl: g.fetchImpl });
    const last = g.asked[g.asked.length - 1];
    ok(last.speech_model === 'universal' && last.word_boost.length === 100, 'the older model gets the 100 it takes', { n: g.asked.length, last: last.speech_model });
  }

  console.log('\n[2b] a model asked for by name goes first');
  {
    const f = fake();
    const w = await aai.transcribe(Buffer.from('x'), { terms: ['Adeboye'], models: ['universal-3-pro'], fetchImpl: f.fetchImpl });
    ok(f.asked[0].speech_models.join() === 'universal-3-pro' && f.asked[0].keyterms_prompt[0] === 'Adeboye' && w.model === 'universal-3-pro', 'Universal-3 Pro, as asked', f.asked[0]);
  }

  console.log('\n[3] words in seconds, with confidence');
  {
    const f = fake();
    const w = await aai.transcribe(Buffer.from('x'), { fetchImpl: f.fetchImpl });
    ok(w[0].text === 'Hallelujah' && w[0].start === 0.12 && w[0].end === 0.64, 'seconds', w[0]);
    ok(w[0].confidence === 0.981 && w[1].confidence === 0.41, 'how sure it was of each word', w);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
