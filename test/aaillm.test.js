'use strict';
/*
 * The Viral montage's editor on AssemblyAI's LLM Gateway (aaillm.js), against
 * a stand-in gateway: the best model the key can use is chosen (Claude first),
 * the request is the OpenAI shape with the key as Authorization, a model that
 * fails is passed over for the next, and with no key nothing is asked.
 *   node test/aaillm.test.js
 */
const http = require('http');
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
(async () => {
  const seen = [];
  let broken = new Set(), noList = false, picky = false;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
      const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/v1/models') return noList ? json({ error: 'Not Found' }, 404) : json({ data: [{ id: 'gpt-4.1-mini' }, { id: 'claude-sonnet-4-5' }, { id: 'claude-3-haiku' }, { id: 'claude-sonnet-4-20250514' }, { id: 'gemini-2.5-flash' }] });
      if (req.url === '/v1/chat/completions') {
        const m = JSON.parse(b).model;
        if (broken.has(m)) return json({ error: { message: 'model overloaded' } }, 503);
        const q = JSON.parse(b);
        if (picky && (q.response_format || q.temperature != null)) return json({ error: { message: 'invalid request body' }, metadata: { errors: ['temperature: not allowed'] } }, 400);
        return json({ request_id: 'r', choices: [{ index: 0, message: { role: 'assistant', content: '{"picks":[{"id":"p3"}],"post_caption":"x"}' } }], usage: {} });
      }
      json({ error: 'no' }, 404);
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  process.env.MW_AAI_LLM_URL = `http://127.0.0.1:${port}`;
  delete process.env.ASSEMBLYAI_API_KEY;
  const ai = require('../src/main/aaillm');
  check(!ai.ready() && (await ai.chat({ system: 's', prompt: 'p' })) === '' && seen.length === 0, 'no AssemblyAI key: not ready, nothing asked');
  process.env.ASSEMBLYAI_API_KEY = 'aai-test-key';
  const list = await ai.models();
  check(list[0] === 'claude-sonnet-4-5' && list[1] === 'claude-sonnet-4-20250514', 'the best model the key has comes first (Claude Sonnet, newest first)', list);
  const out = await ai.chat({ system: 'sys', prompt: 'the lines', json: true, maxTokens: 900 });
  const last = seen[seen.length - 1];
  check(/"picks"/.test(out) && last.url === '/v1/chat/completions' && last.auth === 'aai-test-key' && last.body.model === 'claude-sonnet-4-5'
    && last.body.messages[0].role === 'system' && last.body.messages[1].content === 'the lines' && last.body.max_tokens === 900, 'a chat is the OpenAI shape, with the AssemblyAI key', last);
  broken = new Set(['claude-sonnet-4-5']);
  const out2 = await ai.chat({ system: 'sys', prompt: 'again' });
  check(/"picks"/.test(out2) && seen[seen.length - 1].body.model === 'claude-sonnet-4-20250514', 'a model that fails: the next one answers', seen.slice(-2).map((x) => x.body && x.body.model));
  const st = ai.state();
  check(st.ready && st.last && st.last.ok && st.last.model === 'claude-sonnet-4-20250514', 'its state says which model answered', st);
  const m = require('../src/main/montage');
  check(m.directorStatus().director === 'assemblyai', 'the montage says AssemblyAI is its editor (no Claude key here)', m.directorStatus());
  // a gateway that will not list its models: the documented ones are tried, best first, past one it does not have
  ai._reset(); noList = true; broken = new Set(['claude-sonnet-4-6']);
  const out3 = await ai.chat({ system: 'sys', prompt: 'no list' });
  const tried = seen.filter((x) => x.body && x.body.messages && x.body.messages[1].content === 'no list').map((x) => x.body.model);
  check(/"picks"/.test(out3) && tried[0] === 'claude-sonnet-4-6' && tried[1] === ai.KNOWN[1], 'no list of models: the documented ones are tried in turn', tried);
  // a model that will not take JSON mode or a temperature: asked again plainer, and it answers
  ai._reset(); picky = true; broken = new Set();
  const out4 = await ai.chat({ system: 'sys', prompt: 'picky', json: true });
  const asked = seen.filter((x) => x.body && x.body.messages && x.body.messages[1].content === 'picky');
  check(/"picks"/.test(out4) && asked.length === 3 && new Set(asked.map((x) => x.body.model)).size === 1 && /temperature: not allowed/.test(ai.state().tries[0].why),
    'a model that refuses the request body is asked again plainer (and why is kept)', { n: asked.length, tries: ai.state().tries });
  srv.close();
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
