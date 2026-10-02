'use strict';
/*
 * ✂️ LONG-TO-SHORTS: AS IT WAS vs ☁️ CLOUD AI — on a real sermon.
 *
 * Runs the real scan (highlights.analyzeSermon) twice over the same stretch:
 *   BEFORE  this PC's ear (the installed Small/Base, from the transcript cache
 *           when the app already heard it) + the rules
 *   CLOUD   Whisper Large in the cloud + the large-model judge (llmjudge
 *           makeCloudJudge), exactly as sermon:analyze wires them
 * and prints every clip — time, length, title, first and last sentence — so
 * the two sets can be READ side by side. Uses the app's own models, transcript
 * cache and Groq key from %APPDATA%\Church Work Space.
 *
 *   npx electron test/diag-shorts-cloud.js "<video>" <startSec> <endSec> [clips]
 */
const { app } = require('electron');
// same as main.js: IPv4 first (this machine's IPv6 route to Groq hangs)
try { require('dns').setDefaultResultOrder('ipv4first'); require('net').setDefaultAutoSelectFamilyAttemptTimeout(500); } catch (e) {}
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const video = require(path.join(ROOT, 'src/main/video'));
const highlights = require(path.join(ROOT, 'src/main/highlights'));
const captioner = require(path.join(ROOT, 'src/main/captioner'));
const cloudwrite = require(path.join(ROOT, 'src/main/cloudwrite'));
const cloudspeech = require(path.join(ROOT, 'src/main/cloudspeech'));
const llmjudge = require(path.join(ROOT, 'src/main/llmjudge'));
const { TransCache } = require(path.join(ROOT, 'src/main/transcache'));

const argv = process.argv.slice(2).filter((a) => !/electron|diag-shorts-cloud/i.test(path.basename(a)));
const input = argv[0];
const startSec = +argv[1] || 0, endSec = +argv[2] || 0, maxClips = +argv[3] || 6;
const ctx = { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
const userData = path.join(process.env.APPDATA, 'Church Work Space');
const OUT = path.join(require('os').tmpdir(), 'mw-shorts-cloud');
fs.mkdirSync(OUT, { recursive: true });
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

async function scan(label, { cloud }) {
  const installed = captioner.models().filter((m) => m.installed).map((m) => m.id);
  const asr = captioner.pickScanModel(installed, undefined);
  const cacheDir = path.join(userData, 'transcript-cache');
  const pcCache = new TransCache(cacheDir, input, `${asr}|segment|fast|v2`);
  const ear = { cloud: 0, pc: 0, why: '' };
  const pcRange = async (s, e) => {
    const hit = pcCache.get(s, e);
    if (hit) { ear.pc++; return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })) }; }
    const r = await captioner.transcribe(ctx, { input, startSec: s, endSec: e, model: asr, granularity: 'segment', fast: true, threads: 4 });
    pcCache.add(s, e, (r.words || []).map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
    ear.pc++;
    return { segs: r.words || [] };
  };
  const cCache = new TransCache(cacheDir, input, `cloud:${cloudspeech.state().model || 'whisper'}|segment|v1`);
  const cloudRange = async (s, e) => {
    const hit = cCache.get(s, e);
    if (hit) { ear.cloud++; return { segs: hit.map((g) => ({ start: g.start - s, end: g.end - s, text: g.text })) }; }
    try {
      const r = await cloudspeech.transcribeSegments({ input, startSec: s, endSec: e });
      cCache.add(s, e, r.segs.map((g) => ({ start: g.start + s, end: g.end + s, text: g.text })));
      ear.cloud++;
      return { segs: r.segs };
    } catch (err) { ear.why = err.message; ear.fails = (ear.fails || 0) + 1; return pcRange(s, e); }
  };
  const judge = cloud ? llmjudge.makeCloudJudge() : null;
  const t0 = Date.now();
  const res = await highlights.analyzeSermon(ctx, {
    input, minLen: 30, maxLen: 110, idealLen: 65, maxClips, autoLen: true, contentAware: true,
    transcribeRange: cloud ? cloudRange : pcRange, concurrency: cloud ? 3 : 1,
    poolSize: cloud ? Math.max(maxClips + 10, 16) : undefined,
    judge, startSec, endSec, decodeParallel: Math.max(1, Math.min(4, Math.floor(require('os').cpus().length / 2) || 1)),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const lines = [`\n===== ${label}  (${secs} s; ear: ${cloud ? `cloud ${ear.cloud}, pc ${ear.pc}${ear.why ? ' — ' + ear.why : ''}` : `${asr} ${ear.pc} pieces`}`
    + `${judge ? `; judge: ${judge.modelName} ${JSON.stringify(judge.stats)}` : '; judge: rules'})`];
  res.clips.slice().sort((a, b) => a.start - b.start).forEach((c, i) => {
    const sents = String(c.text || c.quote || '').split(/(?<=[.!?])\s+/);
    lines.push(`\n[${i + 1}] ${fmt(c.start)}–${fmt(c.end)} (${Math.round(c.end - c.start)} s)  "${c.label}"${c.aiScore != null ? `  ai=${c.aiScore}` : ''}`);
    lines.push(`    opens: ${(sents[0] || '').slice(0, 170)}`);
    lines.push(`    ends:  ${(sents[sents.length - 1] || '').slice(0, 170)}`);
    if (process.env.FULL) lines.push(`    TEXT: ${c.text || ''}`);
  });
  const text = lines.join('\n');
  console.log(text);
  fs.writeFileSync(path.join(OUT, `${label.replace(/\W+/g, '_')}_${Math.round(startSec)}.txt`), text);
  return res;
}

app.whenReady().then(async () => {
  try {
    captioner.init(userData);
    const s = (JSON.parse(fs.readFileSync(path.join(userData, 'workstation.json'), 'utf8')).settings) || {};
    const lc = (s.listen && s.listen.cloud) || {};
    cloudspeech.configure(Object.assign({}, lc, { on: true }));
    cloudwrite.shareKey(lc.provider || 'groq', lc.key || '');
    cloudwrite.configure(Object.assign({ on: true, provider: 'groq' }, (s.social && s.social.cloud) || {}));
    cloudspeech.shareKey((s.social && s.social.cloud && s.social.cloud.provider) || 'groq', (s.social && s.social.cloud && s.social.cloud.key) || '');
    if (!input || !fs.existsSync(input)) throw new Error('no video: ' + input);
    console.log(`${path.basename(input)}  ${fmt(startSec)}–${fmt(endSec)}  · cloud ear ready: ${cloudspeech.fileReady()} · cloud judge ready: ${cloudwrite.reachable()}`);
    if (!process.env.CLOUD_ONLY) await scan('BEFORE (this PC + rules)', { cloud: false });
    await scan('CLOUD AI', { cloud: true });
  } catch (e) { console.error(e); }
  app.exit(0);
});
