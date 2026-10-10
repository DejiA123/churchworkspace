'use strict';
/*
 * THE VIRAL MONTAGE HEARS WITH ASSEMBLYAI — AND "WHAT'S IT ABOUT?" NEVER
 * TOUCHES THE CAPTIONS. Through the real Cloud Studio server (main.js's
 * montage:create), with a stand-in AssemblyAI (MW_AAI_API):
 *   [1] the words of the edit are AssemblyAI's
 *   [2] nothing typed in "What's it about?" is sent to AssemblyAI as a word to
 *       listen for, and none of it turns up in the captions
 *
 *   node test/montage-aai.test.js
 */
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http');
const { spawn, execFileSync } = require('child_process');
let chromium, devices;
try { ({ chromium, devices } = require('playwright')); } catch (e) { console.log('SKIP: Playwright is not installed here.'); process.exit(0); }
const ROOT = path.join(__dirname, '..');
const ffmpeg = require(ROOT + '/node_modules/ffmpeg-static');
const PORT = 7413, AAI_PORT = 7414, CODE = 'mtaai-test-3917';
let pass = 0, fail = 0;
const check = (ok, name, d) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (d !== undefined && !ok ? '  -> ' + JSON.stringify(d) : '')); ok ? pass++ : fail++; };
const WORK = path.join(os.tmpdir(), 'mw-mtaai-' + process.pid);
const DATA = path.join(WORK, 'data'), MEDIA = path.join(WORK, 'media');
fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(MEDIA, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what the stand-in AssemblyAI "hears": unusual words, so they can only have come from it
const SAID = ['Shalom friends the zebra of grace runs free today.', 'Quantum faith moves every mountain in front of you.', 'Never stop praising when the storm is loud.',
  'Your harvest is coming sooner than you think.', 'Lift your voice and give him glory now.', 'This is the season of open doors for you.'];
const WORDS = [];
{ let t = 600; for (const s of SAID) { for (const w of s.split(' ')) { WORDS.push({ text: w, start: t, end: t + 320, confidence: 0.97 }); t += 380; } t += 500; } }
const asked = [];
const fake = http.createServer((req, res) => {
  let body = [];
  req.on('data', (c) => body.push(c));
  req.on('end', () => {
    const send = (j) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.url.endsWith('/upload')) return send({ upload_url: 'https://cdn.example/audio' });
    if (req.method === 'POST' && req.url.endsWith('/transcript')) { try { asked.push(JSON.parse(Buffer.concat(body).toString())); } catch (e) {} return send({ id: 'tr1' }); }
    if (/\/transcript\/tr1$/.test(req.url)) return send({ status: 'completed', words: WORDS });
    res.writeHead(404); res.end('{}');
  });
});

function post(p, b) { return new Promise((resolve, reject) => { const data = Buffer.from(JSON.stringify(b));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'POST', agent: false, headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); });
  req.on('error', reject); req.end(data); }); }
async function waitUp() { for (let k = 0; k < 80; k++) { try { await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/api/hello', agent: false }, (r) => { r.resume(); r.statusCode === 200 ? res() : rej(); }).on('error', rej)); return true; } catch (e) { await sleep(250); } } return false; }

(async () => {
  await new Promise((r) => fake.listen(AAI_PORT, '127.0.0.1', r));
  const VID = path.join(MEDIA, 'service.mp4');
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15:d=24', '-f', 'lavfi', '-i', 'sine=f=220:d=24', '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', VID]);
  const env = Object.assign({}, process.env, { ASSEMBLYAI_API_KEY: 'test-key', MW_AAI_API: `http://127.0.0.1:${AAI_PORT}/v2` });
  for (const k of ['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) delete env[k];
  const srv = spawn(process.execPath, [path.join(ROOT, 'src/cloud/server.js'), '--port', String(PORT), '--host', '127.0.0.1', '--code', CODE, '--data', DATA, '--media', MEDIA], { stdio: 'ignore', env });
  const browser = await chromium.launch();
  try {
    if (!(await waitUp())) throw new Error('no server');
    const login = await post('/api/login', { create: true, code: CODE, name: 'Tester', password: 'tester-pass-1', remember: true });
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    await ctx.addInitScript((t) => { try { localStorage.setItem('mw.cloud.token', t); } catch (e) {} }, login.token);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/#home`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.api && window.api.montage && window.api.montage.create, null, { timeout: 30000 });
    const res = await page.evaluate((v) => window.api.montage.create({
      mediaPaths: [v], mode: 'talk', style: 'hype', lengthSec: 15, aspect: '9:16',
      brief: 'Bishop Zedekiah Okonkwo at Harvest Tabernacle — faith over fear. Join us Sundays at 10am',
      about: { speaker: 'Bishop Zedekiah Okonkwo', occasion: 'Sunday service' },
    }).then((r) => ({ ok: true, words: (r.words || []).map((w) => w.text), postCaption: r.postCaption }), (e) => ({ ok: false, err: e.message })), VID);
    check(res.ok, 'the Viral Montage is made', res.err);
    const heard = new Set(WORDS.map((w) => w.text));
    check(res.ok && res.words.length > 8 && res.words.every((w) => heard.has(w)), '[1] its words are AssemblyAI\'s — every caption word is one AssemblyAI heard', res.words && res.words.filter((w) => !heard.has(w)));
    check(asked.length >= 1, '[1] AssemblyAI was asked', asked.length);
    const terms = asked.flatMap((a) => a.keyterms_prompt || a.word_boost || []);
    const typed = /Zedekiah|Okonkwo|Harvest Tabernacle|faith over fear|Sunday service|Join us/i;
    check(!terms.some((t) => typed.test(t)), '[2] nothing typed in "What\'s it about?" is sent to AssemblyAI as a word to listen for', terms.filter((t) => typed.test(t)));
    check(res.ok && !res.words.some((w) => /Zedekiah|Okonkwo|Tabernacle/i.test(w)), '[2] and none of it turns up in the captions', res.words);
  } catch (e) {
    check(false, 'the test ran to the end', e && e.message);
  } finally { await browser.close(); srv.kill(); fake.close(); }
  console.log(`${pass} PASS / ${fail} FAIL`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
