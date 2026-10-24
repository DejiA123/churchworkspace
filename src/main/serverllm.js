'use strict';
/*
 * ►► THE SERVER'S OWN AI. ◄◄ "No allowances … hundreds of people will be using
 * this" — so the montage's reader of words (which lines to use, which one ends
 * it) runs on the server itself: an open model (Qwen, Apache 2.0) under
 * llama.cpp's llama-server, built into the image (Dockerfile). No account, no
 * key, no allowance; what it costs is the server's processor for a minute or
 * two per montage.
 *
 *   - the WEIGHTS come once, ~2.5 GB, into the data folder (they survive an
 *     update). Which file is looked up on Hugging Face's own catalogue, so a
 *     renamed upload is found rather than guessed; Q4_0 on ARM (llama.cpp
 *     repacks it for the Ampere's dot-product instructions — the fast path
 *     there), Q4_K_M elsewhere. The size is checked at the end: a cut-short
 *     model loads and answers gibberish.
 *   - the PROGRAM (llama-server) is started the first time it is asked, keeps
 *     the model in memory between questions, and stops after ten idle minutes.
 *   - one question at a time; the answer forced to JSON (a schema) when asked,
 *     and asked plainly again if that cannot be done.
 *
 * Nothing here is on the critical path: not ready → ready() is false and the
 * montage asks the next reader, as before.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// the models, best first — each looked up on Hugging Face (siblings list), the first that has the quant taken
const CATALOGUE = [
  { repo: 'bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF', name: 'Qwen3 4B Instruct' },
  { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', name: 'Qwen3 4B Instruct' },
  { repo: 'Qwen/Qwen3-4B-Instruct-2507-GGUF', name: 'Qwen3 4B Instruct' },
  { repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', name: 'Qwen2.5 7B Instruct' },
  { repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', name: 'Qwen2.5 3B Instruct' },
];
const HOSTS = ['https://huggingface.co', 'https://hf-mirror.com'];
const QUANTS = process.arch === 'arm64' ? ['Q4_0', 'Q4_K_M'] : ['Q4_K_M', 'Q4_0'];
const CTX = 16384;
const IDLE_MS = 10 * 60 * 1000;

let dir = path.join(os.tmpdir(), 'mw-server-llm');
function setDataDir(d) { if (d) dir = path.join(d, 'models', 'server-llm'); }
const state = { fetching: false, fetched: 0, total: 0, why: '', asked: 0, failed: 0, lastMs: 0, running: false };

/* ---------------------------------------------------------------- the program */
function binPath() {
  const cands = [process.env.MW_LLAMA_SERVER, path.join(__dirname, '..', '..', 'bin', 'llama', 'llama-server')].filter(Boolean);
  for (const p of cands) { try { if (fs.statSync(p).isFile()) return p; } catch (e) { /* not here */ } }
  return null;
}
/** The program is here (this server's image); the model may still need fetching. */
function available() { return !!binPath(); }

/* ------------------------------------------------------------------ the model */
const pick = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8')); } catch (e) { return null; } };
function modelReady() {
  const m = pick();
  if (!m || !m.file) return null;
  try { return fs.statSync(path.join(dir, m.file)).size === m.size ? m : null; } catch (e) { return null; }
}
/** Ready to answer: the program and a whole model. */
function ready() { return available() && !!modelReady(); }
function status() {
  const m = modelReady();
  return Object.assign({ available: available(), ready: available() && !!m, model: m ? m.name + ' (' + m.quant + ')' : '' }, state);
}

function get(url, { json = false, range = 0, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const headers = { 'User-Agent': 'ChurchWorkSpace-Studio' };
    if (range) headers.Range = `bytes=${range}-`;
    https.get(url, { headers, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), { json, range, redirects: redirects + 1 }));
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (!json) return resolve(res);
      let s = ''; res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timed out')); });
  });
}

/* which file: the first model of the catalogue that has the wanted quant, as one file (not split in parts) */
async function choose() {
  for (const host of HOSTS) {
    for (const c of CATALOGUE) {
      let info = null;
      try { info = await get(`${host}/api/models/${c.repo}?blobs=true`, { json: true }); } catch (e) { continue; }
      const files = (info && info.siblings) || [];
      for (const q of QUANTS) {
        const f = files.find((s) => new RegExp(`[-_.]${q}\\.gguf$`, 'i').test(s.rfilename) && !/-of-\d+/.test(s.rfilename) && !/\//.test(s.rfilename));
        if (!f) continue;
        const size = f.size || (f.lfs && f.lfs.size) || 0;
        if (size > 1e9) return { host, repo: c.repo, name: c.name, quant: q, file: f.rfilename, size };
      }
    }
  }
  throw new Error('no model could be found on Hugging Face from this server');
}

let fetching = null;
/** Fetch the model once (resumable), then keep it. */
function fetchModel() {
  if (modelReady()) return Promise.resolve(modelReady());
  if (fetching) return fetching;
  fetching = (async () => {
    state.fetching = true; state.why = '';
    try {
      fs.mkdirSync(dir, { recursive: true });
      const m = await choose();
      state.total = m.size;
      const dest = path.join(dir, m.file), part = dest + '.part';
      for (let tries = 0; tries < 6; tries++) {
        let have = 0; try { have = fs.statSync(part).size; } catch (e) { have = 0; }
        if (have > m.size) { fs.unlinkSync(part); have = 0; }
        state.fetched = have;
        if (have === m.size) break;
        try {
          const res = await get(`${m.host}/${m.repo}/resolve/main/${encodeURIComponent(m.file)}`, { range: have });
          if (have && res.statusCode !== 206) { have = 0; state.fetched = 0; }   // (the host would not resume: from the start)
          await new Promise((resolve, reject) => {
            const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
            res.on('data', (d) => { state.fetched += d.length; });
            res.on('error', reject); out.on('error', reject); out.on('close', resolve);
            res.pipe(out);
          });
        } catch (e) { state.why = e.message; await new Promise((r) => setTimeout(r, 3000 * (tries + 1))); }
      }
      if (fs.statSync(part).size !== m.size) throw new Error('the model download was cut short');
      fs.renameSync(part, dest);
      fs.writeFileSync(path.join(dir, 'model.json'), JSON.stringify(m));
      return m;
    } catch (e) { state.why = e.message || String(e); throw e; }
    finally { state.fetching = false; fetching = null; }
  })();
  return fetching;
}

/* -------------------------------------------------------- the running program */
let proc = null, port = 0, starting = null, idle = null;
function stop() { if (proc) { try { proc.kill('SIGTERM'); } catch (e) {} } proc = null; state.running = false; }
function touch() { clearTimeout(idle); idle = setTimeout(stop, IDLE_MS); if (idle.unref) idle.unref(); }
const httpJson = (method, p, body, timeoutMs) => new Promise((resolve, reject) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}, timeout: timeoutMs || 10000 }, (res) => {
    let s = ''; res.setEncoding('utf8');
    res.on('data', (d) => { s += d; });
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: s }); });
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timed out')));
  if (data) req.write(data);
  req.end();
});
async function start() {
  if (proc && !starting) return;
  if (starting) return starting;
  starting = (async () => {
    const m = modelReady(), bin = binPath();
    if (!m || !bin) throw new Error('the server’s AI is not ready');
    port = 18100 + Math.floor(Math.random() * 800);
    const threads = Math.max(1, os.cpus().length);
    proc = spawn(bin, ['-m', path.join(dir, m.file), '--host', '127.0.0.1', '--port', String(port), '-c', String(CTX), '-t', String(threads),
      '-np', '1', '--no-webui', '--reasoning-budget', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    // (a program that cannot be started says so here — unheard, Node would take the whole studio down with it)
    proc.on('error', (e) => { tail += '\n' + (e && e.message); });
    proc.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-2000); });
    const me = proc;
    proc.on('exit', () => { if (proc === me) { proc = null; state.running = false; } });
    // loaded when /health says so (a model takes some seconds to read in)
    for (let i = 0; i < 240; i++) {
      if (!proc || proc !== me) throw new Error('the server’s AI stopped while starting: ' + tail.split('\n').filter(Boolean).slice(-2).join(' '));
      try { const r = await httpJson('GET', '/health', null, 2000); if (r.status === 200) { state.running = true; return; } } catch (e) { /* not yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    stop(); throw new Error('the server’s AI did not start in time');
  })().finally(() => { starting = null; });
  return starting;
}

let chain = Promise.resolve();
/**
 * One question; the answer's text ('' when it could not be answered). `schema`: the JSON the answer must be
 * (forced while the model writes it); `json` alone asks for JSON in words.
 */
function chat({ system, prompt, json = false, schema = null, maxTokens = 800, temperature = 0.2, timeoutMs = 6 * 60 * 1000 } = {}) {
  if (!ready()) return Promise.resolve('');
  const job = chain.then(async () => {
    const t0 = Date.now();
    try {
      await start(); touch();
      const body = { messages: [{ role: 'system', content: String(system || '') }, { role: 'user', content: String(prompt || '') }], max_tokens: maxTokens, temperature, stream: false };
      const forced = schema ? { type: 'json_schema', json_schema: { name: 'answer', schema } } : json ? { type: 'json_object' } : null;
      let r = await httpJson('POST', '/v1/chat/completions', forced ? Object.assign({}, body, { response_format: forced }) : body, timeoutMs);
      if (forced && r.status !== 200) r = await httpJson('POST', '/v1/chat/completions', body, timeoutMs);   // (asked plainly)
      touch();
      const text = r.status === 200 && r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message ? String(r.json.choices[0].message.content || '') : '';
      state.asked++; state.lastMs = Date.now() - t0;
      if (!text) state.failed++;
      return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (e) { state.failed++; state.why = e.message || String(e); return ''; }
  });
  chain = job.catch(() => {});
  return job;
}

module.exports = { setDataDir, available, ready, status, fetchModel, chat, stop, CATALOGUE, QUANTS, _choose: choose };
