'use strict';
/*
 * THE FREE, STRONG READER (bigjudge.js) AND ASSEMBLYAI'S PARAGRAPHS.
 *
 * Measured on a church's live server: a 50-minute sermon judged by Groq's
 * free plan ten minutes at a time — shorts that opened on "The other day I
 * went to meet him…", and an edge pass that never ran (the minute's
 * allowance was gone). Checked here, with stand-in services:
 *   [1] Mistral (free plan) answers first; a busy minute (429) is waited
 *       out; a refused key goes to Gemini; a model that is not offered goes
 *       to the next model
 *   [2] the shorts judge reads the WHOLE sermon in one request with it, and
 *       the edges pass runs with it too; without it (or when it is silent)
 *       Groq reads ten minutes at a time as before
 *   [3] AssemblyAI's paragraphs come with the words (p on each first word),
 *       become sentences of their own (para), and are shown to the reader
 *
 *   node test/bigjudge.test.js
 */
const http = require('http');
const path = require('path');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const check = (name, ok, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d).slice(0, 400) : '')); ok ? pass++ : fail++; };

const Z = { calls: [], mode: {} };
function server() {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      const prov = req.url.split('/').filter(Boolean).pop();
      let j = {}; try { j = JSON.parse(b); } catch (e) {}
      Z.calls.push({ prov, model: j.model, auth: req.headers.authorization, prompt: (j.messages || []).map((m) => m.content).join('\n'), json: !!j.response_format });
      const m = Z.mode[prov] || 'ok';
      const send = (code, obj, h = {}) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, h)); res.end(JSON.stringify(obj)); };
      if (m === 'refuse') return send(401, { message: 'Unauthorized' });
      if (m === 'busyOnce') { Z.mode[prov] = 'ok'; return send(429, { message: 'rate limited' }, { 'retry-after': '1' }); }
      if (m === 'busyAlways') return send(429, { message: 'Requests rate limit exceeded' });
      if (m === 'tierLarge' && j.model === 'mistral-large-latest') return send(403, { object: 'error', message: 'This model is not available in your subscription tier', type: 'tier_not_allowed', code: '1910' });
      if (m === 'nomodel' && j.model === 'mistral-large-latest') return send(400, { message: 'Invalid model: mistral-large-latest' });
      if (m === 'silent') return send(500, { message: 'down' });
      const reply = typeof Z.reply === 'function' ? Z.reply(j, prov) : (Z.reply || '{"ok":true}');
      send(200, { choices: [{ message: { content: reply } }] });
    });
  }).listen(0, '127.0.0.1');
}

(async () => {
  const srv = server();
  await new Promise((r) => srv.on('listening', r));
  process.env.MW_BIGJUDGE_API = `http://127.0.0.1:${srv.address().port}/v1`;
  process.env.MISTRAL_API_KEY = 'mk-test';
  process.env.GEMINI_API_KEY = 'AIza-test';
  const big = require(ROOT + '/src/main/bigjudge.js');
  // Gemini is asked the way the captions ask it (geminiear.ask) — a stand-in here
  const G = { calls: [], reply: '{"ok":true}', fail: null };
  big._setGemini(async (o) => { G.calls.push(o); if (G.fail) throw G.fail; return typeof Z.reply === 'function' ? Z.reply({ messages: [{ content: o.prompt }] }, 'gemini') : G.reply; });
  // the waits for a busy minute, shortened for the test (each one is recorded)
  const waited = [];
  big._setSleep(async (ms) => { waited.push(ms); });

  // [1]
  check('[1] with a Mistral key the strong reader is ready, Mistral first', big.ready() && /Mistral Large/.test(big.name()), big.name());
  Z.calls = []; Z.reply = '{"moments":[]}';
  let out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] it answers, as JSON, with Mistral Large', out === '{"moments":[]}' && Z.calls[0].prov === 'mistral' && Z.calls[0].model === 'mistral-large-latest' && Z.calls[0].json && Z.calls[0].auth === 'Bearer mk-test', Z.calls);
  Z.calls = []; Z.mode.mistral = 'busyOnce'; waited.length = 0;
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] a busy minute (429) is waited out — as long as Mistral says — and asked again, not given up', !!out && Z.calls.length === 2 && Z.calls.every((c) => c.prov === 'mistral') && waited[0] >= 1000, { n: Z.calls.length, waited });
  Z.calls = []; Z.mode.mistral = 'busyAlways'; waited.length = 0; G.calls = [];
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] busy and busy again: it waits longer each time (a minute in all) — then Gemini Flash, the next reader', !!out && Z.calls.every((c) => c.model === 'mistral-large-latest') && waited.some((w) => w >= 30000) && waited.reduce((a, b) => a + b, 0) >= 60000 && G.calls.length === 1,
    { waited, models: Z.calls.map((c) => c.model).join(), gem: G.calls.length });
  check('[1] …and what each one answered is kept, in order (the scan shows it)', big.state.trail.some((t) => /Mistral mistral-large-latest: 429/.test(t)), big.state.trail.slice(-4));
  Z.calls = []; G.calls = [];
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] …a model busy for a whole minute is not waited on again for a while: straight to Gemini', !!out && Z.calls.length === 0 && G.calls.length === 1, { m: Z.calls.length, g: G.calls.length });
  big._benched.clear(); Z.mode = {};
  // the free plan without Mistral Large (measured on the church's own key: 403 tier_not_allowed)
  Z.calls = []; Z.mode.mistral = 'tierLarge'; G.calls = [];
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] "not available in your subscription tier": that MODEL is passed over (not the key) — Gemini Flash answers', !!out && Z.calls.map((c) => c.model).join() === 'mistral-large-latest' && G.calls.length === 1, { m: Z.calls.map((c) => c.model), g: G.calls.length });
  Z.calls = []; G.fail = Object.assign(new Error('the free Gemini allowance is used up for today'), { exhausted: true });
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] …Large is not asked again (set aside for a day); with Gemini used up, Mistral Medium reads it', !!out && Z.calls.map((c) => c.model).join() === 'mistral-medium-latest', { models: Z.calls.map((c) => c.model) });
  check('[1] …and the reader is named for what is left: Mistral Medium', big.name() === 'Mistral Medium (free)', big.name());
  G.fail = null;
  big._benched.clear();
  Z.mode = {};
  Z.calls = []; Z.mode.mistral = 'nomodel'; G.calls = [];
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] a model that is not offered: the next reader (Gemini Flash)', !!out && Z.calls.map((c) => c.model).join() === 'mistral-large-latest' && G.calls.length === 1, { m: Z.calls.map((c) => c.model), g: G.calls.length });
  big._benched.clear();
  big._benched.clear(); Z.calls = []; Z.mode.mistral = 'refuse'; G.calls = [];
  out = await big.chat({ system: 's', prompt: 'p' });
  check('[1] a refused key: Gemini answers instead — asked the way the captions ask it (the best Flash this key may use)', !!out && Z.calls.map((c) => c.prov).join() === 'mistral' && G.calls.length === 1 && G.calls[0].prompt === 'p', { m: Z.calls.map((c) => c.prov), g: G.calls.length });
  check('[1] …and the refused key is left alone for a while (not asked on every call)', big.providers().map((p) => p.id).join() === 'gemini');
  big._benched.clear(); Z.mode = {};

  // [2] the shorts judge
  const llmjudge = require(ROOT + '/src/main/llmjudge.js');
  const groq = { calls: [], state: () => ({ hasKey: true, cooling: 0, why: '', model: 'openai/gpt-oss-120b', providerName: 'Groq' }), reachable: () => true,
    chat: async (o) => { groq.calls.push(o); return groq.reply ? groq.reply(o) : ''; } };
  // a sermon: 300 sentences of 6 s each (30 minutes), a paragraph every 6
  const S = Array.from({ length: 300 }, (_, k) => ({ start: k * 6, end: k * 6 + 5.6, text: `Sentence number ${k} of the sermon says something true.`, para: k % 6 === 0 }));
  Z.calls = [];
  Z.reply = (j) => {
    const p = (j.messages || []).map((m) => m.content).join('\n');
    if (/"edges"/.test(p)) return '{"edges":[{"id":1,"from":12,"to":26}]}';
    return '{"moments":[{"from":12,"to":27,"title":"A whole thought","point":"x","strength":9},{"from":60,"to":75,"title":"Another thought","point":"y","strength":8},{"from":120,"to":135,"title":"A third thought","point":"z","strength":8}]}';
  };
  let judge = llmjudge.makeCloudJudge({ cloudwrite: groq, big });
  const plan = await judge.plan({ sents: S, minLen: 60, maxLen: 150, idealLen: 90, maxClips: 8 });
  const reads = Z.calls.filter((c) => /Find EVERY moment/.test(c.prompt));
  const firstReads = reads.filter((c) => !/already chosen/.test(c.prompt));
  check('[2] the strong reader reads the WHOLE sermon in one request (not ten minutes at a time)', firstReads.length === 1 && /Below is a whole sermon/.test(firstReads[0].prompt) && /\[0\]/.test(firstReads[0].prompt) && /\[299\]/.test(firstReads[0].prompt), { reads: firstReads.length });
  const moreAsk = reads.find((c) => /already chosen/.test(c.prompt));
  check('[2] fewer moments than shorts asked for: shown what it chose, it is asked once for more, different ones', !!moreAsk && /\[12\]–\[27\] "A whole thought"/.test(moreAsk.prompt) && /Find \d+ MORE moments/.test(moreAsk.prompt), moreAsk && moreAsk.prompt.slice(-400));
  check('[2] …told the length as a count of sentences, and that a story starts where the story starts', /about 10 to 25 sentences/.test(reads[0].prompt) && /The other day I went to meet him/.test(reads[0].prompt), reads[0] && reads[0].prompt.match(/LENGTH:[^\n]*/));
  check('[2] …with AssemblyAI\'s paragraphs shown (a blank line where a new one begins)', /\n\n\[6\]/.test(reads[0].prompt) && /blank line marks where the speaker paused/.test(reads[0].prompt));
  check('[2] the edges pass runs with it too, ¶ marking paragraph starts', Z.calls.some((c) => /"edges"/.test(c.prompt) && /¶\[12\]/.test(c.prompt)), Z.calls.length);
  check('[2] the plan comes back from it, Groq never asked', !!plan && plan.moments.length >= 3 && groq.calls.length === 0 && judge.stats.plannedBy === 'Mistral Large (free)', { plan: plan && plan.moments.length, groq: groq.calls.length, by: judge.stats.plannedBy });
  check('[2] …its edge choice is taken (the end moved to where the point lands)', !!plan && plan.moments[0].from === 12 && plan.moments[0].to === 26, plan && plan.moments[0]);
  check('[2] the judge is named for what read it', judge.modelName === 'Mistral Large (free)', judge.modelName);
  // the strong reader silent: Groq, ten minutes at a time
  Z.mode = { mistral: 'silent' }; Z.calls = []; G.fail = Object.assign(new Error('Gemini is busy right now'), { passing: true });
  groq.reply = (o) => (/"edges"/.test(o.prompt) ? '{"edges":[]}' : '{"moments":[{"from":' + (o.prompt.match(/\[(\d+)\]/) || [0, 0])[1] + ',"to":' + (+(o.prompt.match(/\[(\d+)\]/) || [0, 0])[1] + 15) + ',"title":"t","point":"p","strength":8}]}');
  judge = llmjudge.makeCloudJudge({ cloudwrite: groq, big });
  const plan2 = await judge.plan({ sents: S, minLen: 60, maxLen: 150, idealLen: 90, maxClips: 8 });
  const groqReads = groq.calls.filter((c) => /Find EVERY moment/.test(c.prompt));
  check('[2] the strong reader silent: Groq reads it as before, ten minutes at a time', !!plan2 && groqReads.length >= 2 && groqReads.every((c) => /Below is part of a sermon/.test(c.prompt)) && judge.stats.plannedBy === 'Groq', { plan2: !!plan2, n: groqReads.length, by: judge.stats.plannedBy });
  Z.mode = {}; G.fail = null; big._benched.clear();
  // Long-to-shorts asks the judge with groq: false — Groq is never asked, even when both free readers are silent
  Z.mode = { mistral: 'silent' }; Z.calls = []; G.fail = Object.assign(new Error('Gemini is busy right now'), { passing: true }); groq.calls = [];
  judge = llmjudge.makeCloudJudge({ cloudwrite: groq, big, groq: false });
  const plan3 = await judge.plan({ sents: S, minLen: 60, maxLen: 150, idealLen: 90, maxClips: 8 });
  check('[2] for shorts (groq: false), with Gemini and Mistral silent, Groq is never asked — the studio\'s own rules choose', !plan3 && groq.calls.length === 0, { plan3: !!plan3, groq: groq.calls.length });
  Z.mode = {}; G.fail = null; big._benched.clear();
  // no strong reader at all: the judge is Groq's, as it was
  delete process.env.MISTRAL_API_KEY; delete process.env.GEMINI_API_KEY;
  judge = llmjudge.makeCloudJudge({ cloudwrite: groq, big });
  check('[2] with no Mistral or Gemini key the judge is Groq\'s, as before', !!judge && /Groq/.test(judge.modelName), judge && judge.modelName);
  check('[2] …and for shorts (groq: false) there is no judge at all — never Groq', llmjudge.makeCloudJudge({ cloudwrite: groq, big, groq: false }) === null);

  // [3] AssemblyAI's paragraphs
  process.env.ASSEMBLYAI_API_KEY = 'aai-test';
  const aai = require(ROOT + '/src/main/assemblyear.js');
  const words = [['Grace', 0.1], ['is', 0.5], ['enough.', 0.9], ['So', 2.6], ['pray.', 3.0], ['Now', 5.2], ['listen.', 5.6]].map(([t, s]) => ({ text: t, start: s * 1000, end: (s + 0.35) * 1000, confidence: 0.98 }));
  const fake = async (url) => {
    const u = String(url);
    const ok = (o) => ({ ok: true, status: 200, json: async () => o });
    if (/\/upload$/.test(u)) return ok({ upload_url: 'https://x/up' });
    if (/\/transcript$/.test(u)) return ok({ id: 't1' });
    if (/\/transcript\/t1\/paragraphs$/.test(u)) return ok({ paragraphs: [{ start: 100, end: 1250 }, { start: 2600, end: 3350 }, { start: 5200, end: 5950 }] });
    if (/\/transcript\/t1$/.test(u)) return ok({ status: 'completed', words });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const heard = await aai.transcribe(Buffer.from('x'), { fetchImpl: fake, paragraphs: true });
  check('[3] AssemblyAI\'s paragraphs come with the words — p on each paragraph\'s first word', heard.filter((w) => w.p).map((w) => w.text).join() === 'Grace,So,Now', heard.map((w) => w.text + (w.p ? '¶' : '')));
  const plain = await aai.transcribe(Buffer.from('x'), { fetchImpl: fake });
  check('[3] …only when asked (the captions do not need them)', !plain.some((w) => w.p));
  const w2 = 'Grace is enough. On earth nothing is greater than prayer. Amen.'.split(' ').map((t, k) => ({ text: t, start: k, end: k + 0.5 }));
  w2[4].p = true; w2[10].p = true;   // two words into a sentence ("nothing"); a sentence's last word ("prayer.")
  aai.snapParagraphs(w2);
  check('[3] a paragraph mark is always on the first word of a sentence ("On earth…", not "nothing…")', w2.filter((w) => w.p).map((w) => w.text).join() === 'On,Amen.', w2.filter((w) => w.p).map((w) => w.text));
  const { buildSentences } = require(ROOT + '/src/main/highlights.js');
  const sents = buildSentences([{ start: 0.1, end: 1.25, text: 'Grace is enough.', p: true }, { start: 2.6, end: 3.35, text: 'So pray', p: true }, { start: 3.4, end: 4.0, text: 'and wait.' }, { start: 5.2, end: 5.95, text: 'Now listen.', p: true }]);
  check('[3] a paragraph AssemblyAI heard begin is a sentence of its own, marked para', sents.length === 3 && sents.map((s) => !!s.para).join() === 'true,true,true' && sents[1].text === 'So pray and wait.', sents.map((s) => s.text + (s.para ? '¶' : '')));

  // [4] a short never opens on "But…" (the words' own times: it starts on the word after)
  const { trimLeadIn } = require(ROOT + '/src/main/highlights.js');
  const mk = (t, s0) => t.split(' ').map((x, i) => ({ text: x, start: s0 + i * 0.4, end: s0 + i * 0.4 + 0.3 }));
  let c = { start: 100, end: 200, text: 'But under normal circumstances, whatever is born of God overcomes the world.', words: mk('But under normal circumstances, whatever is born of God overcomes the world.', 100) };
  check('[4] "But under normal circumstances…" starts on "Under…" — on the next word\'s own time', trimLeadIn(c) && c.text.startsWith('Under normal circumstances') && Math.abs(c.start - 100.34) < 0.01 && c.words[0].text === 'under', { start: c.start, text: c.text });
  // the words of a short begin with the last word of the sentence before, overlapping its start (measured)
  c = { start: 100.3, end: 200, text: 'But under normal circumstances, whatever is born of God overcomes the world.', words: [{ text: 'understand?', start: 99.7, end: 100.35 }].concat(mk('But under normal circumstances, whatever is born of God overcomes the world.', 100.4)) };
  check('[4] …also when the words begin with the last one of the sentence before ("understand? But under…")', trimLeadIn(c) && c.text.startsWith('Under normal circumstances') && c.words[0].text === 'under' && c.start > 100.4, { start: c.start, w0: c.words[0] && c.words[0].text, text: c.text.slice(0, 30) });
  c = { start: 100, end: 200, text: 'But you see, the nature of God in us, there is a way we win.', words: mk('But you see, the nature of God in us, there is a way we win.', 100) };
  check('[4] "But you see, …" goes with it: "The nature of God in us…"', trimLeadIn(c) && c.text.startsWith('The nature of God'), c.text);
  for (const t of ['So many big churches are big for nothing at all today.', 'Because God is good, we will win every battle today.', 'Now the Lord said to Moses, go down to the river.']) {
    c = { start: 100, end: 200, text: t, words: mk(t, 100) };
    check('[4] …but not where cutting changes the meaning: "' + t.slice(0, 22) + '…"', !trimLeadIn(c) && c.start === 100 && c.text === t, c.text);
  }

  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
