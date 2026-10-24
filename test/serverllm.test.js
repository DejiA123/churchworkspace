'use strict';
/*
 * THE SERVER'S OWN AI (serverllm.js) — the montage's reader of words, on the
 * server's processor, no allowance. With a stand-in for llama-server (a small
 * Node program that answers the same way), so it runs anywhere:
 *   - not ready (no program, or no whole model): ready() is false and nothing is asked
 *   - the program is started the first time it is asked, and kept for the next question
 *   - a question that wants JSON in a shape asks for it; one the program cannot force is asked plainly
 *   - one question at a time
 *   - the montage asks it first: its line check (vetLoose) uses its answer
 *   node test/serverllm.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, name, d) => { console.log((c ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !c ? '  -> ' + JSON.stringify(d) : '')); c ? pass++ : fail++; };

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sllm-'));
const LOG = path.join(WORK, 'calls.log');
// the stand-in: /health, and /v1/chat/completions — refuses a schema (as a model whose grammar fails), answers JSON
const fake = path.join(WORK, 'llama-server');
fs.writeFileSync(fake, `#!${process.execPath}
const http = require('http'), fs = require('fs');
const a = process.argv, port = +a[a.indexOf('--port') + 1];
fs.appendFileSync(${JSON.stringify(LOG)}, 'start ' + a.slice(2).join(' ') + '\\n');
let busy = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
  let b = ''; req.on('data', (d) => b += d); req.on('end', () => {
    const j = JSON.parse(b);
    busy++; fs.appendFileSync(${JSON.stringify(LOG)}, 'ask ' + (j.response_format ? j.response_format.type : 'plain') + ' busy=' + busy + '\\n');
    setTimeout(() => {
      busy--;
      if (j.response_format && j.response_format.type === 'json_schema') { res.writeHead(400); return res.end('{"error":{"message":"Failed to initialize samplers"}}'); }
      const q = j.messages[1].content;
      const ids = (q.match(/^(p\\d+):/gm) || []).map((s) => s.slice(0, -1));
      const content = /keep/.test(q) ? JSON.stringify({ keep: ids.filter((id, i) => i % 2 === 0) }) : 'hello';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<think></think>' + content } }] }));
    }, 150);
  });
}).listen(port, '127.0.0.1');
`);
fs.chmodSync(fake, 0o755);
process.env.MW_LLAMA_SERVER = fake;
const s = require('../src/main/serverllm');
s.setDataDir(WORK);

(async () => {
  try {
    ok(s.available() && !s.ready(), 'the program here, no model yet: not ready, nothing asked', s.status());
    ok((await s.chat({ prompt: 'hi' })) === '', 'not ready: an empty answer (the next reader is asked)');
    // a whole model (its size as recorded) — and one cut short is not one
    const md = path.join(WORK, 'models', 'server-llm'); fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'm.gguf'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(md, 'model.json'), JSON.stringify({ name: 'Test', quant: 'Q4_0', file: 'm.gguf', size: 4096 }));
    ok(!s.ready(), 'a model cut short is not ready');
    fs.writeFileSync(path.join(md, 'model.json'), JSON.stringify({ name: 'Test', quant: 'Q4_0', file: 'm.gguf', size: 2048 }));
    ok(s.ready() && /Test \(Q4_0\)/.test(s.status().model), 'a whole model: ready', s.status());

    const [a, b, c] = await Promise.all([
      s.chat({ system: 'x', prompt: 'say hi' }),
      s.chat({ system: 'x', prompt: 'keep\np1: one\np2: two\np3: three', schema: { type: 'object' } }),
      s.chat({ system: 'x', prompt: 'keep\np1: one', json: true }),
    ]);
    ok(a === 'hello', 'it answers (its <think> part taken off)', a);
    ok(JSON.parse(b).keep.join() === 'p1,p3', 'a shape it could not force: asked again plainly, and answered', b);
    ok(JSON.parse(c).keep.join() === 'p1', 'JSON asked for in words', c);
    const log = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    ok(log.filter((l) => l.startsWith('start')).length === 1, 'started once, kept for the next questions', log);
    ok(/--port \d+/.test(log[0]) && /-c 16384/.test(log[0]) && /-np 1/.test(log[0]), 'on this machine only, with room for a whole event’s lines', log[0]);
    ok(log.filter((l) => l.startsWith('ask')).every((l) => /busy=1$/.test(l)), 'one question at a time', log);
    ok(log.some((l) => /ask json_schema/.test(l)) && log.some((l) => /ask json_object/.test(l)), 'the JSON is asked for (forced when it can be)', log);

    // the montage: its check of the extra lines is the server's AI's answer
    const montage = require('../src/main/montage');
    const kept = await montage.vetLoose([{ id: 'p1', text: 'God is faithful' }, { id: 'p2', text: 'come on' }, { id: 'p3', text: 'Hope never fails' }]);
    ok(kept && kept.map((p) => p.id).join() === 'p1,p3', 'the montage asks it first: the lines it keeps are the ones used', kept && kept.map((p) => p.id));
    ok(montage.directorStatus().director === 'server' && montage.directorStatus().server.ready, 'the montage says the server’s AI directs it', montage.directorStatus());
  } catch (e) { ok(false, 'the test ran to the end', e && e.stack); }
  s.stop();
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  console.log(`\n${pass} PASS / ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
})();
