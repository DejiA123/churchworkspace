'use strict';
/*
 * HEARD TWICE, BY TWO MODELS — SO ONLY THE DOUBTFUL LINES NEED A LOOK.
 *
 * Captions are heard by the full Whisper Large v3, then again by Turbo, and the
 * words the two do not agree on are marked `doubt` (cloudspeech.secondOpinion).
 * A fake Groq answers per model, so this runs without a key or a network:
 *   [1] captions ask for the full Large v3; a refused Large v3 falls back to Turbo
 *   [2] two listens that disagree on one word mark exactly that word
 *   [3] punctuation and capitals are not disagreements
 *   [4] a passage the model itself was unsure of is marked `unsure`
 *   [5] a second listen that fails says "not double-checked" — never "all clear"
 *
 *   node test/caption-second-opinion.test.js
 */
const path = require('path');
const cs = require(path.join(__dirname, '..', 'src', 'main', 'cloudspeech'));
const INPUT = path.join(__dirname, 'fixtures', 'sermon-dry.flac');
let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) pass++; else fail++; console.log(`  ${c ? 'PASS' : 'FAIL'} ${m}${d != null && !c ? '  -> ' + JSON.stringify(d) : ''}`); };
const W = (txt, t0, lp) => ({
  words: txt.split(' ').map((x, i) => ({ word: x, start: t0 + i * 0.4, end: t0 + i * 0.4 + 0.35 })),
  segments: [{ start: t0, end: t0 + txt.split(' ').length * 0.4, text: txt, avg_logprob: lp == null ? -0.2 : lp, no_speech_prob: 0, compression_ratio: 1.2 }],
});
let answers = {}, asked = [];
global.fetch = async (url, o) => {
  const m = o.body.get('model'); asked.push(m);
  const a = answers[m];
  if (a === 'refuse') return { ok: false, status: 400, headers: { get: () => null } };
  if (a === 'fail') return { ok: false, status: 500, headers: { get: () => null } };
  return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(a)) };
};

(async () => {
  cs.configure({ on: true, provider: 'groq', key: 'gsk_test' });
  console.log('\n[1] the accurate model hears the captions');
  ok(cs.captionModelId() === 'whisper-large-v3', 'captions ask for the full Large v3', cs.captionModelId());

  console.log('\n[2] two ears, one word apart');
  answers = { 'whisper-large-v3': W('the lord is my shepherd I shall not want', 0.2), 'whisper-large-v3-turbo': W('the lord is my shepard I shall not want', 0.2) };
  asked = [];
  const r = await cs.transcribeWords({ input: INPUT, startSec: 0, endSec: 6 });
  ok(asked[0] === 'whisper-large-v3' && r.words.length === 9, 'the first listen is Large v3, every word back', { asked, n: r.words.length });
  const chk = await cs.secondOpinion({ input: INPUT, from: 0, to: 6, words: r.words });
  ok(chk.checked && chk.model === 'whisper-large-v3-turbo', 'the second listen is the other model', chk);
  ok(r.words.filter((w) => w.doubt).map((w) => w.text).join() === 'shepherd', 'exactly the word they disagree on is in doubt', r.words.filter((w) => w.doubt));
  ok(Array.isArray(chk.alt) && chk.alt.some((w) => w.text === 'shepard'), 'what the other ear heard comes back to offer instead');

  console.log('\n[3] the same words, written differently, agree');
  answers = { 'whisper-large-v3': W('He leads me, beside still waters.', 0.2), 'whisper-large-v3-turbo': W('he leads me beside still waters', 0.2) };
  const r3 = await cs.transcribeWords({ input: INPUT, startSec: 0, endSec: 6 });
  const c3 = await cs.secondOpinion({ input: INPUT, from: 0, to: 6, words: r3.words });
  ok(c3.checked && !r3.words.some((w) => w.doubt), 'commas, full stops and capitals are not doubts', r3.words.filter((w) => w.doubt));

  console.log('\n[4] the model\'s own doubt');
  answers = { 'whisper-large-v3': W('mumbled words in the hall', 0.2, -1.3), 'whisper-large-v3-turbo': W('mumbled words in the hall', 0.2, -1.3) };
  const r4 = await cs.transcribeWords({ input: INPUT, startSec: 0, endSec: 6 });
  ok(r4.words.length && r4.words.every((w) => w.unsure), 'a passage Whisper was unsure of is marked unsure', r4.words);

  console.log('\n[5] when the second listen cannot be had');
  answers = { 'whisper-large-v3': W('grace and peace to you', 0.2), 'whisper-large-v3-turbo': 'fail' };
  const r5 = await cs.transcribeWords({ input: INPUT, startSec: 0, endSec: 6 });
  const c5 = await cs.secondOpinion({ input: INPUT, from: 0, to: 6, words: r5.words });
  ok(c5.checked === false && !!c5.why, 'it says the lines were NOT double-checked, and why', c5);

  console.log('\n[1b] a provider that refuses Large v3');
  answers = { 'whisper-large-v3': 'refuse', 'whisper-large-v3-turbo': W('amen', 0.2) };
  asked = [];
  const r6 = await cs.transcribeWords({ input: INPUT, startSec: 0, endSec: 3 });
  ok(r6.words.length === 1 && asked.join() .startsWith('whisper-large-v3,whisper-large-v3-turbo'), 'Turbo hears it instead of failing', asked);

  console.log('\n[6] end to end: the studio\'s own captions:transcribe, as a phone calls it');
  {
    const os = require('os'), fs = require('fs');
    const ROOT = path.join(__dirname, '..');
    const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-second-'));
    require(path.join(ROOT, 'src/cloud/electron-shim')).install({ dataDir: path.join(WORK, 'userData'), mediaDir: WORK, version: 'test' });
    const sched = require(path.join(ROOT, 'src/main/scheduler'));
    if (sched.Scheduler) sched.Scheduler.prototype.start = function () { return this; };
    require(path.join(ROOT, 'src/main/autopost')).startHeartbeat = () => ({ stop() {} });
    const rpc = require(path.join(ROOT, 'src/main/rpc'));
    require(path.join(ROOT, 'src/main/main.js'));
    await new Promise((r) => setTimeout(r, 600));
    cs.configure({ on: true, provider: 'groq', key: 'gsk_test' });
    cs._resetCaptionModel();   // [1b] refused Large v3 a moment ago
    answers = { 'whisper-large-v3': W('the lord is my shepherd I shall not want', 0.2), 'whisper-large-v3-turbo': W('the lord is my shepard I shall not want', 0.2) };
    const res = await rpc.invoke('captions:transcribe', { input: INPUT, startSec: 0, endSec: 6, model: 'cloud' });
    const out = res && res.ok !== undefined ? res.data : res;
    ok(out && out.check && out.check.checked, 'the answer says the captions were heard twice', out && out.check);
    ok(out && out.words.filter((w) => w.doubt).map((w) => w.text).join() === 'shepherd', 'the one doubtful word arrives marked', out && out.words.filter((w) => w.doubt));
    ok(out && out.check && out.check.alt.some((w) => w.text === 'shepard'), 'with what the other ear heard');
    ok(out && /Large v3$/.test(out.engineName || ''), 'and it names the accurate model that heard them', out && out.engineName);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (e) {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
