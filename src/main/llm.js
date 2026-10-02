'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const jobs = require('./jobs');

/*
 * A local instruction-following model (llama.cpp), used to JUDGE the words the
 * speech model heard. Fully offline once installed, no account, no API key, no
 * subscription — the same bar as the bundled whisper and MediaPipe.
 *
 * WHY THIS EXISTS. Long-to-shorts already reads the sermon; what it could not do
 * is answer the one question every complaint has really been about — "is this
 * thought finished, or is the payoff in the next twenty seconds?". highlights.js
 * approximates that with regexes (closerPenalty, RESOLVER_RX, SETUP_RX) and a
 * pause curve, and those got a long way, but a word list cannot tell a dramatic
 * pause from the end of a point. A model that reads the sentence can.
 *
 * This module is ONLY the plumbing: where the runtime lives, how the weights get
 * here, and how to run one prompt. The judging itself is llmjudge.js.
 *
 * NOTHING HERE IS ON THE CRITICAL PATH. Every entry point returns a falsy /
 * empty result when the runtime or the weights are missing, so a machine that
 * never installs this keeps exactly the behaviour it has today.
 */

/* ------------------------------- weights -------------------------------- */

/*
 * Two sizes, same trade-off the speech models make. Both are Qwen2.5-Instruct at
 * Q4_K_M, which is the quantisation that still holds instruction-following
 * together at this size, and both speak ChatML — see `tpl` below.
 *
 * 3B is the practical ceiling for a 2-core laptop. Anything larger is not
 * "slower but fine", it is minutes per clip, and this pass runs over a whole
 * pool of candidates.
 */
const MODELS = [
  {
    id: 'qwen2.5-1.5b',
    file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf',
    name: 'Fast — smaller, quicker',
    sizeMB: 940,
    rank: 1,
    ctx: 8192,
    url: 'https://huggingface.co/bartowski/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/Qwen2.5-1.5B-Instruct-Q4_K_M.gguf',
  },
  {
    id: 'qwen2.5-3b',
    file: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    name: 'Accurate — bigger, slower',
    sizeMB: 1840,
    rank: 2,
    ctx: 8192,
    url: 'https://huggingface.co/bartowski/Qwen2.5-3B-Instruct-GGUF/resolve/main/Qwen2.5-3B-Instruct-Q4_K_M.gguf',
  },
];

/*
 * THE CHAT TEMPLATE IS llama-cli's JOB, not ours — learned the hard way.
 *
 * The first version of this module formatted ChatML turns by hand and ran the
 * binary as a plain completion, on the theory that owning the format was safer
 * than depending on a flag. It is the opposite: llama-cli runs in CONVERSATION
 * mode by default and applies the model's own template (out of the GGUF, via
 * jinja) to whatever it is given — so a hand-rolled prompt gets templated a
 * second time and the model is answering a transcript of a chat rather than the
 * question. Passing the system prompt as `-sys` and the question as a plain file
 * is both simpler and correct for any model, not just the two above.
 *
 * These are belt-and-braces only, in case a build ever does echo raw turn markers.
 */
const STOPS = ['<|im_end|>', '<|im_start|>', '<|endoftext|>'];

let MODELS_DIR = null;   // <userData>/models  — shared with the speech models
let TOOLS_DIR = null;    // <userData>/tools   — shared with yt-dlp

function init(userDataDir) {
  MODELS_DIR = path.join(userDataDir, 'models');
  TOOLS_DIR = path.join(userDataDir, 'tools', 'llama');
  for (const d of [MODELS_DIR, TOOLS_DIR]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  }
}

/** Where a model lives, or null. Downloads first, then anything bundled. */
function modelPath(m) {
  const cands = [];
  if (MODELS_DIR) cands.push(path.join(MODELS_DIR, m.file));
  cands.push(path.join(__dirname, '..', '..', 'bin', 'llama', m.file));
  if (process.resourcesPath) cands.push(path.join(process.resourcesPath, 'llama', m.file));
  for (const p of cands) {
    try { if (fs.existsSync(p) && fs.statSync(p).size > 1e6) return p; } catch (e) {}
  }
  return null;
}

/** Every model, with where it is and whether it is the one that would run. */
function models() {
  const best = bestModel();
  return MODELS.map((m) => {
    const p = modelPath(m);
    return {
      id: m.id, name: m.name, sizeMB: m.sizeMB, installed: !!p, path: p,
      downloadable: !!m.url, inUse: !!best && best.id === m.id,
    };
  });
}

/** The highest-ranked model actually present. */
function bestModel() {
  let best = null;
  for (const m of MODELS) if (modelPath(m) && (!best || m.rank > best.rank)) best = m;
  return best;
}

/** Resolve an explicit id, falling back to whatever is installed. */
function modelFor(id) {
  if (id) {
    const m = MODELS.find((x) => x.id === id);
    if (m && modelPath(m)) return m;
  }
  return bestModel();
}

/* ------------------------------- runtime -------------------------------- */

const CLI_NAME = process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';

/*
 * llama.cpp's own release assets. The runtime is ~18 MB — the weights are the
 * download that matters — so it is fetched on demand rather than shipped, and
 * the installer stays the size it is.
 */
const ASSET_RX = {
  win32: /^llama-b\d+-bin-win-cpu-x64\.zip$/i,
  darwin: process.arch === 'arm64'
    ? /^llama-b\d+-bin-macos-arm64\.tar\.gz$/i
    : /^llama-b\d+-bin-macos-x64\.tar\.gz$/i,
  linux: /^llama-b\d+-bin-ubuntu-x64\.tar\.gz$/i,
};

/** Find llama-cli anywhere under `dir` (release layouts move it around). */
function findCli(dir, depth = 0) {
  if (!dir || depth > 3) return null;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
  for (const e of ents) {
    if (e.isFile() && e.name.toLowerCase() === CLI_NAME.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      const hit = findCli(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** The llama-cli this machine would run, or null. */
function cliPath() {
  const roots = [];
  if (TOOLS_DIR) roots.push(TOOLS_DIR);
  roots.push(path.join(__dirname, '..', '..', 'bin', 'llama'));
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, 'llama'));
  for (const r of roots) {
    const hit = findCli(r);
    if (hit) return hit;
  }
  // Already on PATH? Someone who runs llama.cpp themselves shouldn't fetch a second copy.
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    try {
      const p = path.join(d, CLI_NAME);
      if (fs.existsSync(p)) return p;
    } catch (e) {}
  }
  return null;
}

/** Is the whole thing — runtime AND weights — ready to run? */
function isAvailable() {
  return !!cliPath() && !!bestModel();
}

/**
 * What the operator needs to do next, in plain English. The UI shows this
 * instead of a dead end, and it distinguishes the two halves: a runtime with no
 * weights is a different problem from weights with no runtime.
 */
function status() {
  const cli = cliPath();
  const m = bestModel();
  const list = models();
  return {
    available: !!cli && !!m,
    runtimeInstalled: !!cli,
    runtimePath: cli,
    modelId: m ? m.id : null,
    modelName: m ? m.name : null,
    models: list,
    howTo: !cli
      ? 'The AI clip picker needs a small free helper (llama.cpp, ~18 MB). Turning it on downloads it once.'
      : (!m ? 'Choose a thinking model below — it downloads once, then works offline forever.' : null),
  };
}

/* ------------------------------ downloading ------------------------------ */

/** Stream a URL to a file, following redirects, renaming only when complete. */
function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Too many redirects while downloading.'));
    https.get(url, { headers: { 'User-Agent': 'ChurchWorkSpace' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Download failed (HTTP ${res.statusCode}).`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (e) {}
      const part = dest + '.part';
      const out = fs.createWriteStream(part);
      res.on('data', (d) => {
        got += d.length;
        if (onProgress && total) onProgress(Math.min(99, Math.round((got / total) * 100)));
      });
      res.on('error', (e) => { try { out.destroy(); fs.unlinkSync(part); } catch (er) {} reject(e); });
      out.on('error', reject);
      out.on('close', () => {
        // A truncated GGUF loads and produces gibberish rather than failing, so a
        // short transfer must never be renamed into place.
        if (total && got !== total) {
          try { fs.unlinkSync(part); } catch (e) {}
          return reject(new Error('The download was cut short — please try again.'));
        }
        try { fs.renameSync(part, dest); } catch (e) { return reject(e); }
        if (onProgress) onProgress(100);
        resolve({ path: dest, bytes: got });
      });
      res.pipe(out);
    }).on('error', reject);
  });
}

/** GET a URL as text (the GitHub releases API). */
function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects.'));
    https.get(url, { headers: { 'User-Agent': 'ChurchWorkSpace', accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(getJson(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let s = '';
      res.setEncoding('utf-8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

/**
 * Unpack an archive.
 *
 * Windows' own tar (bsdtar, in System32) reads zip perfectly well, but Git for
 * Windows puts GNU tar — which does NOT — earlier on PATH, so the absolute path
 * is used rather than the name. PowerShell's Expand-Archive is the fallback.
 */
function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  let r = spawnSync(tar, ['-xf', archive, '-C', destDir], { windowsHide: true });
  if (!r.error && r.status === 0) return true;
  if (process.platform === 'win32') {
    r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destDir}" -Force`,
    ], { windowsHide: true });
    if (!r.error && r.status === 0) return true;
  }
  throw new Error('Could not unpack the AI helper download.');
}

/**
 * Fetch the llama.cpp runtime for this platform. Asset names carry the build
 * number, so the release list is queried rather than a URL guessed.
 */
async function installRuntime({ onProgress } = {}) {
  const existing = cliPath();
  if (existing) return { path: existing, installed: false };
  if (!TOOLS_DIR) throw new Error('The tools folder is not ready yet.');
  const rx = ASSET_RX[process.platform];
  if (!rx) throw new Error(`The AI clip picker has no build for ${process.platform}.`);

  let rel;
  try {
    rel = await getJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  } catch (e) {
    throw new Error('Could not reach the download server. Check the internet connection and try again.');
  }
  const asset = (rel.assets || []).find((a) => rx.test(a.name));
  if (!asset) throw new Error('No AI helper build is published for this computer yet.');

  const tmp = path.join(TOOLS_DIR, asset.name);
  await download(asset.browser_download_url, tmp, onProgress);
  try {
    extract(tmp, TOOLS_DIR);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
  const cli = findCli(TOOLS_DIR);
  if (!cli) throw new Error('The AI helper unpacked but llama-cli was not in it.');
  // A binary out of an archive arrives without the executable bit on Unix.
  if (process.platform !== 'win32') {
    try {
      for (const f of fs.readdirSync(path.dirname(cli))) {
        const p = path.join(path.dirname(cli), f);
        if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755);
      }
    } catch (e) {}
  }
  return { path: cli, installed: true, version: rel.tag_name };
}

/** Fetch one set of weights. */
async function downloadModel(id, { onProgress } = {}) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) throw new Error('Unknown thinking model: ' + id);
  if (!MODELS_DIR) throw new Error('The model folder is not ready yet.');
  const existing = modelPath(m);
  if (existing) return { id: m.id, path: existing, bytes: 0, installed: false };
  const r = await download(m.url, path.join(MODELS_DIR, m.file), onProgress);
  return { id: m.id, path: r.path, bytes: r.bytes, installed: true };
}

/** Delete downloaded weights. The runtime is small enough to leave alone. */
function removeModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m || !MODELS_DIR) return false;
  try { fs.rmSync(path.join(MODELS_DIR, m.file), { force: true }); return true; } catch (e) { return false; }
}

/* -------------------------------- running -------------------------------- */

/** Cut the completion at the first stop token the model emits. */
function trimAtStop(s) {
  let out = s;
  for (const t of STOPS) {
    const i = out.indexOf(t);
    if (i >= 0) out = out.slice(0, i);
  }
  return out.trim();
}

/**
 * Pull the model's ANSWER out of llama-cli's stdout.
 *
 * Everything llama-cli prints goes to stdout, not stderr, and `--log-disable`
 * does not silence it: a startup banner in ASCII art, the build and model lines,
 * a list of REPL commands, the prompt echoed back after a "> " marker, then the
 * answer, then a throughput line and "Exiting...". Reading the raw stdout as the
 * completion — which is what the first version of this did — hands the caller a
 * kilobyte of banner that happens to contain no JSON, so every judging pass
 * silently no-opped and looked exactly like a model that had nothing to say.
 *
 * The prompt is echoed verbatim, so its own tail is the one landmark in that
 * output that is guaranteed to sit immediately before the answer.
 */
function extractAnswer(stdout, promptText) {
  let s = String(stdout || '');
  const tail = String(promptText || '').trim().slice(-80);
  const i = tail ? s.lastIndexOf(tail) : -1;
  if (i >= 0) {
    s = s.slice(i + tail.length);
  } else {
    // A build that honours --no-display-prompt, or a prompt that came back
    // reflowed: fall back to the last REPL marker, then to the whole thing.
    const m = s.lastIndexOf('\n> ');
    if (m >= 0) s = s.slice(m + 3);
  }
  s = s.replace(/\n\s*\[\s*Prompt:[\s\S]*$/, '')      // "[ Prompt: 56.8 t/s | Generation: 24.5 t/s ]"
    .replace(/\n\s*Exiting\.\.\.[\s\S]*$/, '')
    .replace(/^\s*>\s*/, '');
  return trimAtStop(s);
}

/**
 * Run ONE prompt and return the completion text.
 *
 * The prompt goes in via a file, not the command line: Windows caps a command
 * line around 32k characters and a pool of sermon candidates blows straight
 * through that. Temperature is pinned to 0 — this is a judge, and two runs over
 * the same sermon returning different clips would be indefensible (it is also
 * what makes the tests meaningful).
 *
 * Returns '' rather than throwing for anything that is not a cancellation: a
 * judging pass that cannot run must leave the rules-based result standing.
 */
function chat({ system, prompt, model, maxTokens = 256, timeoutMs = 120000, threads } = {}) {
  const cli = cliPath();
  const m = modelFor(model);
  if (!cli || !m) return Promise.resolve('');
  const mp = modelPath(m);
  if (!mp) return Promise.resolve('');

  const nThreads = threads || Math.max(2, Math.min(8, os.cpus().length));
  const text = String(prompt || '');
  const dir = TOOLS_DIR || os.tmpdir();
  const pf = path.join(dir, `prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);

  return new Promise((resolve) => {
    try { fs.writeFileSync(pf, text, 'utf-8'); } catch (e) { return resolve(''); }
    /*
     * `-st` (single-turn) is the flag that makes this exit, and it is not
     * optional. `-no-cnv` reads like the right one and does NOT work on this
     * build: llama-cli answers the question, then sits in its REPL writing "> "
     * prompts until something kills it — measured, that turned a 2.7-second
     * call into every judging pass burning its full timeout and returning
     * nothing. Do not "simplify" this back to -no-cnv.
     */
    const args = [
      '-m', mp,
      '-sys', String(system || 'You are a helpful assistant.'),
      '-f', pf,
      '-n', String(maxTokens),
      '-c', String(m.ctx),
      '-t', String(nThreads),
      '--temp', '0',
      '-st',                   // single turn, then exit
      '--no-warmup',
      '--log-disable',
      '-ngl', '0',             // CPU: these machines have no usable GPU offload
    ];
    let proc;
    try {
      // stdin is IGNORED, not piped: llama-cli's chat loop reads it, and an open
      // pipe nothing ever writes to is a hang waiting to happen.
      proc = jobs.track(spawn(cli, args, {
        windowsHide: true, cwd: path.dirname(cli), stdio: ['ignore', 'pipe', 'pipe'],
      }));
    } catch (e) {
      try { fs.unlinkSync(pf); } catch (er) {}
      return resolve('');
    }
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { fs.unlinkSync(pf); } catch (e) {}
      resolve(v);
    };
    // A wedged generation must not hold a scan open forever.
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) {}
      finish(extractAnswer(out, text));
    }, timeoutMs);

    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});   // llama.cpp writes its whole load log to stderr
    proc.on('error', () => finish(''));
    proc.on('close', () => {
      if (jobs.isCancelled()) return finish('');
      finish(extractAnswer(out, text));
    });
  });
}

/**
 * Pull the first JSON value out of a completion.
 *
 * Small models wrap JSON in prose or a ```json fence however plainly they are
 * told not to, so the text is scanned for a balanced object/array rather than
 * parsed whole. Returns null when there is nothing valid — callers treat that
 * as "this pass did not happen".
 */
function parseJson(text, { array = false } = {}) {
  if (!text) return null;
  const open = array ? '[' : '{';
  const close = array ? ']' : '}';
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

module.exports = {
  init, models, bestModel, modelFor, modelPath, status, isAvailable, cliPath,
  installRuntime, downloadModel, removeModel, chat, parseJson,
  MODELS, _internals: { findCli, extract, trimAtStop, extractAnswer, ASSET_RX },
};
